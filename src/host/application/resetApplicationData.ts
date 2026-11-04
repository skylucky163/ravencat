/**
 * @fileoverview 应用数据恢复出厂门面。
 *
 * 组合原生清理、数据库、AsyncStorage 与 persistent-media 清理，供 Host 运行时调用。
 * 不再让 Chat Feature 负责全应用数据清理。
 *
 * @module host/application/resetApplicationData
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { aiHttpDiagnostics } from '@platform/ai';
import { clearDB, cleanupLegacyDatabases } from '@platform/persistence';
import {
  clearDeviceObserverDataForFactoryReset,
  clearNativeNotificationDataForFactoryReset,
  clearPersistentApplicationMedia,
  clearTemporarySpeechAudioForFactoryReset,
  clearVoiceRecordingDataForFactoryReset,
  withMediaFileLifetime,
  setBackgroundRuntimeEnabled,
} from '@platform/device';
import { clearSessionTimelineCache } from '@features/chat/composition';
import { runHostAuthorityMutation } from '@features/assistants';
import {
  clearCompanionNativeDataForFactoryReset,
} from '@features/companion';
import {
  isFloatingLayerRunning,
  stopFloatingLayer,
} from '@features/floatingLayer';
import {
  quiesceDeviceControlForFactoryReset,
  resumeDeviceControlAfterFactoryReset,
} from '@features/deviceControl';

type CleanupFailure = {
  name: string;
  reason: unknown;
};

/** 恢复出厂的两个失败阶段：进入 destructive reset 之前 / 之后。 */
type CleanupScope = '原生清理' | '持久化清理';

async function settleCleanup(
  name: string,
  run: () => Promise<unknown>,
): Promise<CleanupFailure | null> {
  try {
    await run();
    return null;
  } catch (reason) {
    return { name, reason };
  }
}

function throwCleanupFailures(failures: CleanupFailure[], scope: CleanupScope): never {
  const detail = failures
    .map(({ name, reason }) => (
      `${name}: ${reason instanceof Error ? reason.message : String(reason)}`
    ))
    .join('; ');

  throw new AggregateError(
    failures.map(({ name, reason }) => (
      new Error(`恢复出厂${scope} ${name} 失败`, { cause: reason })
    )),
    `恢复出厂失败：${scope}未完整完成。${detail}`,
  );
}

/**
 * 停止悬浮层并确认原生 Service 真的退出。
 *
 * stopFloatingLayer() 只是向 Android 请求 stopService，onDestroy 可能尚未执行完；
 * 轮询 isFloatingLayerRunning 确认服务已停止，避免在 Service 还活着时删除它的数据。
 */
async function stopFloatingLayerAndWait(): Promise<void> {
  await stopFloatingLayer();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await isFloatingLayerRunning())) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error('RavenCat 悬浮层未在恢复出厂前停止');
}

/**
 * 清空全部应用持久化数据，使应用回到出厂状态。
 *
 * 固定顺序：
 * 1. 原生清理分两段：
 *    a. 安全关闭：停止 Device Control、停止悬浮层并确认退出、取消伴随唤醒（三项都尝试，
 *       任一失败都不能继续删除 RavenCat store）；
 *    b. 确认关闭后才清 RavenCat 原生 store；
 *    c. 通知与 Device Observer 彼此独立，可以都尝试；
 * 2. 清空全部数据库表（动态发现，不依赖手写名单），并删除历史版本数据库文件
 *    （含 `-wal` / `-shm` / `-journal`，当前 canonical 数据库文件不删除）；
 * 3. 清空 AsyncStorage、删除 persistent-media/ 根目录、删除 speech 临时音频 cache、
 *    重置 HTTP 诊断开关并删除其持久记录：这些清理彼此独立，必须全部尝试并统一报告
 *    失败，不能因为第一项失败就跳过剩余清理；
 * 4. 无论如何都清空会话时间线缓存。
 *
 * 不删除当前 canonical 数据库文件、不删除 Backups/、不删除随应用打包的默认资源。
 * 不重新打开第二个数据库连接。
 */
export async function resetApplicationData(): Promise<void> {
  let deviceControlQuiesceStarted = false;

  try {
    // 三项互不拥有彼此状态，可以并行关闭；任一失败都不能继续删除业务真值。
    deviceControlQuiesceStarted = true;
    const shutdownFailures = (
      await Promise.all([
        settleCleanup(
          'quiesceDeviceControl',
          () => quiesceDeviceControlForFactoryReset(),
        ),
        settleCleanup('stopFloatingLayer', () => stopFloatingLayerAndWait()),
        settleCleanup('stopBackgroundRuntime', () => setBackgroundRuntimeEnabled(false)),
      ])
    ).filter((item): item is CleanupFailure => item !== null);

    if (shutdownFailures.length > 0) {
      throwCleanupFailures(shutdownFailures, '原生清理');
    }

    // 只有悬浮层和全部调度都确认停止后，才清原生状态。
    await withMediaFileLifetime(() => clearCompanionNativeDataForFactoryReset());

    // 这两个彼此独立，可以都尝试。
    const independentFailures = (
      await Promise.all([
        settleCleanup(
          'clearNativeNotificationDataForFactoryReset',
          () => clearNativeNotificationDataForFactoryReset(),
        ),
        settleCleanup(
          'clearDeviceObserverDataForFactoryReset',
          () => clearDeviceObserverDataForFactoryReset(),
        ),
        settleCleanup(
          'clearVoiceRecordingDataForFactoryReset',
          () => clearVoiceRecordingDataForFactoryReset(),
        ),
      ])
    ).filter((item): item is CleanupFailure => item !== null);

    if (independentFailures.length > 0) {
      throwCleanupFailures(independentFailures, '原生清理');
    }

    // 数据库清理与 legacy 文件清理同属持久化清理，共用同一个 Host Authority mutation lane。
    await runHostAuthorityMutation(async () => {
      await clearDB();
      await cleanupLegacyDatabases();
    });

    // clearDB 已经执行，本次 reset 已经不可逆：下面各项彼此独立，必须全部尝试，
    // 失败统一收口，避免「AsyncStorage 失败 → 私有媒体、语音与 HTTP 记录没清」这类
    // 半清理状态被当成成功。
    const persistenceFailures = (
      await Promise.all([
        settleCleanup('clearAsyncStorage', () => AsyncStorage.clear()),
        settleCleanup('clearPersistentApplicationMedia', () => clearPersistentApplicationMedia()),
        settleCleanup(
          'clearTemporarySpeechAudio',
          () => clearTemporarySpeechAudioForFactoryReset(),
        ),
        settleCleanup('resetHttpDiagnostics', () => aiHttpDiagnostics.reset()),
      ])
    ).filter((item): item is CleanupFailure => item !== null);

    if (persistenceFailures.length > 0) {
      throwCleanupFailures(persistenceFailures, '持久化清理');
    }
  } finally {
    if (deviceControlQuiesceStarted) {
      resumeDeviceControlAfterFactoryReset();
    }
    clearSessionTimelineCache();
  }
}
