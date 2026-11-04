/**
 * 静态验证应用数据恢复出厂契约。
 *
 * 验证范围：
 * - 数据库 clearDB 动态清空、事务边界、外键恢复、行数校验、失败路径 cause；
 * - 非数据库数据：AsyncStorage.clear()、persistent-media 删除、不删除 Backups/数据库文件；
 * - UI 运行时：Host reset revision、子树重挂、Settings 使用 Context resetApplicationData、
 *   Chat Conversation Entry 不再直接调用整库清理、DEFAULT_SELF_NAME 中性。
 *
 * 静态契约与 shutdown-before-persistence 行为已验证；
 * 真实 expo-sqlite、AsyncStorage、文件系统和长驻 Tab 重挂仍需真机验收。
 */

import assert from 'node:assert/strict';
import { loadTypeScriptModule as loadTypeScriptModuleWithMocks, readRepoFile as readSrc } from './helpers/load-typescript-module.mjs';

const errors = [];

function assertContains(content, fragment, message) {
  if (!content.includes(fragment)) {
    errors.push(message);
  }
}

function assertNotContains(content, fragment, message) {
  if (content.includes(fragment)) {
    errors.push(message);
  }
}

// ── 数据库 ──────────────────────────────────────────────

const helpers = readSrc('src/platform/persistence/helpers.ts');
const schema = readSrc('src/platform/persistence/sqlite/schema.ts');

assertContains(schema, 'momentMedia: MOMENT_MEDIA_SCHEMA', 'fresh schema 必须登记 moment_media');
assertContains(schema, 'momentSettings: MOMENT_SETTINGS_SCHEMA', 'fresh schema 必须登记 moment_settings');

assertContains(
  helpers,
  'withExclusiveWriteScopeAsync',
  'clearDB 必须使用 withExclusiveWriteScopeAsync',
);

assertContains(
  helpers,
  "sqlite_master",
  'clearDB 必须从 sqlite_master 动态获取表名',
);

// 不再含手写业务表 DELETE 清单
assertNotContains(
  helpers,
  'DELETE FROM prompt_bindings;',
  'clearDB 不得继续维护手写业务表 DELETE 清单',
);
assertNotContains(
  helpers,
  'DELETE FROM moments;',
  'clearDB 不得继续维护手写业务表 DELETE 清名',
);
assertNotContains(
  helpers,
  'DELETE FROM sessions;',
  'clearDB 不得继续维护手写业务表 DELETE 清单',
);

assertContains(
  helpers,
  'quoteSqlIdentifier',
  'clearDB 必须有 SQL identifier 转义',
);

assertContains(
  helpers,
  'PRAGMA foreign_keys = OFF',
  'foreign_keys = OFF 必须在 BEGIN 前',
);

assertContains(
  helpers,
  'BEGIN IMMEDIATE',
  'clearDB 必须有 BEGIN IMMEDIATE',
);

assertContains(
  helpers,
  'COMMIT',
  'clearDB 必须有 COMMIT',
);

assertContains(
  helpers,
  'ROLLBACK',
  'clearDB 失败路径必须有 ROLLBACK',
);

assertContains(
  helpers,
  'PRAGMA foreign_keys = ON',
  'clearDB 必须恢复 foreign_keys = ON',
);

assertContains(
  helpers,
  'PRAGMA foreign_keys;',
  'clearDB 恢复后必须读取 PRAGMA foreign_keys 确认值',
);

assertContains(
  helpers,
  'foreign_keys !== 1',
  'clearDB 必须强制确认 foreign_keys 值为 1',
);

assertContains(
  helpers,
  'PRAGMA foreign_key_check',
  'clearDB 必须执行 PRAGMA foreign_key_check',
);

assertContains(
  helpers,
  'SELECT COUNT(*)',
  'clearDB 必须对全部动态表检查行数',
);

assertContains(
  helpers,
  'cause',
  'clearDB 失败路径必须携带 cause',
);

// ── 非数据库数据 ────────────────────────────────────────

const resetFacade = readSrc('src/host/application/resetApplicationData.ts');

assertContains(
  resetFacade,
  'AsyncStorage.clear()',
  '恢复出厂必须调用 AsyncStorage.clear()',
);

assertContains(
  resetFacade,
  'clearPersistentApplicationMedia',
  '恢复出厂必须删除 persistent-media/',
);

assertContains(
  resetFacade,
  'clearCompanionNativeDataForFactoryReset',
  '恢复出厂必须调用 clearCompanionNativeDataForFactoryReset 清空 RavenCat 原生 store',
);

assertContains(
  resetFacade,
  'clearNativeNotificationDataForFactoryReset',
  '恢复出厂必须调用 clearNativeNotificationDataForFactoryReset 清空原生通知状态',
);

assertContains(
  resetFacade,
  'clearDeviceObserverDataForFactoryReset',
  '恢复出厂必须调用 clearDeviceObserverDataForFactoryReset 清空设备观察诊断',
);

assertContains(
  resetFacade,
  'clearVoiceRecordingDataForFactoryReset',
  '恢复出厂必须停止原生录音并清空 voice-message cache',
);

assertContains(
  resetFacade,
  'stopFloatingLayer',
  '恢复出厂必须调用 RavenCat stopFloatingLayer 停止悬浮层',
);

assertContains(
  resetFacade,
  'quiesceDeviceControlForFactoryReset',
  '恢复出厂必须先 quiesce Device Control',
);

assertContains(
  resetFacade,
  'resumeDeviceControlAfterFactoryReset',
  '恢复出厂结束后必须释放 Device Control application command gate',
);

// RavenCat 清理分两段：安全关闭（Device Control / Floating / wake）→ 清 store，
// 再执行通知与 Device Observer；关闭失败不得进入清 store。
{
  const shutdownBlock = resetFacade.slice(
    resetFacade.indexOf('const shutdownFailures'),
  );
  const ravenCatSteps = [
    'quiesceDeviceControlForFactoryReset',
    'stopFloatingLayer',
    'clearCompanionNativeDataForFactoryReset',
    'clearNativeNotificationDataForFactoryReset',
    'clearDeviceObserverDataForFactoryReset',
  ];
  const positions = ravenCatSteps.map((name) => shutdownBlock.indexOf(name));
  const isOrdered = positions.every((position) => position >= 0)
    && positions.every((position, index) => (
      index === 0 || position > positions[index - 1]
  ));
  if (!isOrdered) {
    errors.push('原生清理必须按 安全关闭（Device Control / Floating / wake）→ 清 RavenCat store → 通知/Device Observer 的顺序执行');
  }
}

// 确认悬浮层 Service 真的停止后才允许清 store
assertContains(
  resetFacade,
  'stopFloatingLayerAndWait',
  '停止悬浮层后必须等待原生 Service 确认退出',
);

assertContains(
  resetFacade,
  'isFloatingLayerRunning',
  '确认悬浮层退出必须轮询 isFloatingLayerRunning',
);

// 通用串行 runNamedCleanupActions 已删除：存在依赖关系的步骤必须分段，失败即中止
assertNotContains(
  resetFacade,
  'runNamedCleanupActions',
  '不得继续使用"单步失败仍继续下一步"的通用串行 runNamedCleanupActions',
);

assertContains(
  resetFacade,
  'settleCleanup',
  '恢复出厂原生清理必须通过 settleCleanup 逐项捕获失败',
);

assertContains(
  resetFacade,
  'CleanupFailure',
  '清理失败必须携带 name/reason 结构（CleanupFailure）',
);

assertContains(
  resetFacade,
  'AggregateError',
  '原生清理任一失败时必须抛出 AggregateError',
);

// ── 历史版本数据库文件清理 ──────────────────────────────

const persistenceHelpers = readSrc('src/platform/persistence/helpers.ts');

for (const legacyFile of [
  'kimiphone.db',
  'kimiphone_v1.db',
  'kimiphone_v2.db',
  'kimiphone_v3.db',
  'kimiphone_v4.db',
]) {
  assertContains(
    persistenceHelpers,
    `'${legacyFile}'`,
    `legacy 清理必须覆盖历史数据库文件 ${legacyFile}`,
  );
}

assertContains(persistenceHelpers, "'-wal'", 'legacy 清理必须覆盖 -wal 边车文件');
assertContains(persistenceHelpers, "'-shm'", 'legacy 清理必须覆盖 -shm 边车文件');
assertContains(persistenceHelpers, "'-journal'", 'legacy 清理必须覆盖 -journal 边车文件');
assertContains(persistenceHelpers, 'idempotent', 'legacy 文件清理必须使用幂等删除');
assertNotContains(
  persistenceHelpers,
  "'kimiphone_v5.db'",
  'legacy 清理不得删除当前 canonical 数据库文件',
);
assertNotContains(
  persistenceHelpers,
  'deleteDatabaseAsync',
  'legacy 清理不得复用只删主文件且不幂等的 deleteDatabaseAsync',
);
assertContains(
  resetFacade,
  'cleanupLegacyDatabases',
  '恢复出厂必须清理历史版本数据库文件',
);

// ── shutdown-before-persistence 行为 ────────────────────

function createResetHarness({
  quiesceFailure = null,
  asyncStorageFailure = null,
  mediaFailure = null,
  speechFailure = null,
  httpDiagnosticsFailure = null,
} = {}) {
  const calls = [];
  const record = (name) => {
    calls.push(name);
  };
  const resetModule = loadTypeScriptModuleWithMocks(
    'src/host/application/resetApplicationData.ts',
    {
      '@react-native-async-storage/async-storage': {
        default: {
          clear: async () => {
            record('asyncStorage');
            if (asyncStorageFailure) {
              throw asyncStorageFailure;
            }
          },
        },
      },
      '@platform/persistence': {
        clearDB: async () => record('clearDB'),
        cleanupLegacyDatabases: async () => record('cleanupLegacyDatabases'),
      },
      '@platform/ai': {
        aiHttpDiagnostics: {
          reset: async () => {
            record('httpDiagnostics');
            if (httpDiagnosticsFailure) {
              throw httpDiagnosticsFailure;
            }
          },
        },
      },
      '@platform/device': {
        setBackgroundRuntimeEnabled: async enabled => { assert.equal(enabled, false); record('backgroundRuntime'); },
        withMediaFileLifetime: loadTypeScriptModuleWithMocks('src/platform/device/MediaFileLifetime.ts', {}).withMediaFileLifetime,
        clearDeviceObserverDataForFactoryReset: async () => record('deviceObserver'),
        clearNativeNotificationDataForFactoryReset: async () => record('notification'),
        clearPersistentApplicationMedia: async () => {
          record('media');
          if (mediaFailure) {
            throw mediaFailure;
          }
        },
        clearTemporarySpeechAudioForFactoryReset: async () => {
          record('speechCache');
          if (speechFailure) {
            throw speechFailure;
          }
        },
        clearVoiceRecordingDataForFactoryReset: async () => record('voiceRecordingCache'),
      },
      '@features/chat/composition': {
        clearSessionTimelineCache: () => record('timeline'),
      },
      '@features/assistants': {
        runHostAuthorityMutation: async (mutation) => {
          record('hostAuthority:start');
          try {
            return await mutation();
          } finally {
            record('hostAuthority:end');
          }
        },
      },
      '@features/companion': {
        clearCompanionNativeDataForFactoryReset: async () => record('ravenCatNative'),
      },
      '@features/floatingLayer': {
        isFloatingLayerRunning: async () => false,
        stopFloatingLayer: async () => record('stopFloating'),
      },
      '@features/deviceControl': {
        quiesceDeviceControlForFactoryReset: async () => {
          record('deviceControlQuiesce');
          if (quiesceFailure) {
            throw quiesceFailure;
          }
        },
        resumeDeviceControlAfterFactoryReset: () => record('deviceControlResume'),
      },
    },
  );
  return { calls, resetApplicationData: resetModule.resetApplicationData };
}

{
  const { calls, resetApplicationData: runReset } = createResetHarness();

  await runReset();

  const quiesce = calls.indexOf('deviceControlQuiesce');
  assert.ok(calls.includes('backgroundRuntime'), '恢复出厂必须关闭独立后台总开关');
  const clearDb = calls.indexOf('clearDB');
  const cleanupLegacy = calls.indexOf('cleanupLegacyDatabases');
  const authorityStart = calls.indexOf('hostAuthority:start');
  const authorityEnd = calls.indexOf('hostAuthority:end');
  const resume = calls.indexOf('deviceControlResume');
  assert.ok(quiesce >= 0 && quiesce < clearDb, 'Device Control quiesce 必须先于 clearDB');
  assert.ok(
    authorityStart < clearDb && clearDb < authorityEnd,
    'clearDB 清除主理关系时必须处于 Host Authority mutation lane',
  );
  assert.ok(
    cleanupLegacy > clearDb && cleanupLegacy < authorityEnd,
    '历史版本数据库文件清理必须与 clearDB 同处 Host Authority mutation lane，且在其之后',
  );
  assert.ok(clearDb < resume, 'Device Control command gate 必须覆盖完整 persistence reset');
  assert.ok(calls.indexOf('ravenCatNative') < clearDb, 'RavenCat native store 必须先于 clearDB');
  assert.ok(calls.indexOf('voiceRecordingCache') < clearDb, '原生录音 cache 必须先于 clearDB');
  assert.ok(calls.indexOf('media') > clearDb, 'MediaAsset 私有 backing 必须在数据库清空后删除');
  assert.ok(calls.indexOf('speechCache') > clearDb, '语音 cache 必须在数据库清空后删除');
  assert.ok(calls.indexOf('httpDiagnostics') > clearDb, '恢复出厂必须重置 HTTP 诊断开关并清除记录');
}

{
  const { calls, resetApplicationData: runReset } = createResetHarness({
    quiesceFailure: new Error('device control shutdown failed'),
  });

  await assert.rejects(runReset(), /device control shutdown failed/);
  assert.equal(calls.includes('clearDB'), false, 'Device Control shutdown 失败不得继续 clearDB');
  assert.equal(
    calls.includes('cleanupLegacyDatabases'),
    false,
    'Device Control shutdown 失败不得继续清理历史版本数据库文件',
  );
  assert.equal(
    calls.includes('ravenCatNative'),
    false,
    'Device Control shutdown 失败不得继续清 RavenCat native store',
  );
  assert.equal(calls.includes('deviceControlResume'), true, '失败后也必须释放 command gate');
}

// 原生清理失败必须先抛错，阻止 clearDB
{
  const flow = resetFacade.slice(
    resetFacade.indexOf('export async function resetApplicationData'),
  );
  const abort = flow.indexOf('throwCleanupFailures(');
  const clearDb = flow.indexOf('clearDB()');
  if (abort < 0 || clearDb < 0 || abort >= clearDb) {
    errors.push('原生清理失败时必须先抛错阻止 clearDB');
  }
}

// clearDB 之后的独立清理必须全部尝试：任何一项失败都不能跳过其余清理。
{
  const asyncStorageError = new Error('asyncStorage clear failed');
  const { calls, resetApplicationData: runReset } = createResetHarness({
    asyncStorageFailure: asyncStorageError,
  });

  await assert.rejects(runReset(), /asyncStorage clear failed/);
  assert.equal(calls.includes('clearDB'), true, 'AsyncStorage 失败发生在 clearDB 之后，DB 必须已清空');
  assert.equal(
    calls.includes('media'),
    true,
    'AsyncStorage.clear 失败不得跳过 persistent-media 清理',
  );
  assert.equal(
    calls.includes('speechCache'),
    true,
    'AsyncStorage.clear 失败不得跳过 speech 临时缓存清理',
  );
  assert.equal(
    calls.includes('httpDiagnostics'),
    true,
    'AsyncStorage.clear 失败不得跳过 HTTP 诊断重置及记录清理',
  );
  assert.equal(calls.includes('deviceControlResume'), true, '失败后仍必须释放 command gate');
}

{
  const httpDiagnosticsError = new Error('HTTP diagnostics record deletion failed');
  const { calls, resetApplicationData: runReset } = createResetHarness({
    httpDiagnosticsFailure: httpDiagnosticsError,
  });

  await assert.rejects(runReset(), (error) => {
    assert.ok(error instanceof AggregateError, 'HTTP 诊断清理失败必须向上汇报');
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].cause, httpDiagnosticsError, '保留 HTTP 诊断清理失败的原始原因');
    return true;
  });
  assert.equal(calls.includes('asyncStorage'), true);
  assert.equal(calls.includes('media'), true);
  assert.equal(calls.includes('speechCache'), true);
  assert.equal(calls.includes('deviceControlResume'), true, 'HTTP 清理失败后仍必须释放 command gate');
  assert.equal(calls.includes('timeline'), true, 'HTTP 清理失败后仍必须清空时间线缓存');
}

{
  const mediaError = new Error('persistent media cleanup failed');
  const { calls, resetApplicationData: runReset } = createResetHarness({
    mediaFailure: mediaError,
  });

  await assert.rejects(runReset(), /persistent media cleanup failed/);
  assert.equal(calls.includes('asyncStorage'), true);
  assert.equal(
    calls.includes('speechCache'),
    true,
    'persistent-media 清理失败不得跳过 speech 临时缓存清理',
  );
  assert.equal(calls.includes('deviceControlResume'), true, '失败后仍必须释放 command gate');
}

{
  const firstError = new Error('asyncStorage clear failed');
  const secondError = new Error('persistent media cleanup failed');
  const { calls, resetApplicationData: runReset } = createResetHarness({
    asyncStorageFailure: firstError,
    mediaFailure: secondError,
  });

  // 统一失败报告必须同时保留两个原因，而不是只报第一项。
  await assert.rejects(runReset(), (error) => {
    assert.ok(error instanceof AggregateError, '持久化清理失败必须用 AggregateError 统一报告');
    assert.equal(error.errors.length, 2);
    const messages = error.errors.map((item) => item.cause?.message ?? item.message);
    assert.ok(messages.includes(firstError.message));
    assert.ok(messages.includes(secondError.message));
    return true;
  });
  assert.equal(calls.includes('speechCache'), true, '两项失败后仍必须尝试最后一项清理');
}

const mediaStore = readSrc('src/platform/device/PersistentMediaStore.ts');
const speechStore = readSrc('src/platform/device/TemporarySpeechAudioStore.ts');
const voiceAudioModule = readSrc(
  'modules/voice-message-audio/android/src/main/java/expo/modules/voicemessageaudio/VoiceMessageAudioModule.kt',
);
const deviceObserverModule = readSrc(
  'modules/device-observer/android/src/main/java/expo/modules/deviceobserver/DeviceObserverModule.kt',
);

assertContains(
  mediaStore,
  'clearPersistentApplicationMedia',
  'Device 层必须有 clearPersistentApplicationMedia API',
);

assertContains(
  speechStore,
  'clearTemporarySpeechAudioForFactoryReset',
  '恢复出厂必须提供语音临时缓存清理 API',
);

assertContains(
  voiceAudioModule,
  'File(context.cacheDir, "voice-message").deleteRecursively()',
  '恢复出厂必须删除原生 voice-message 录音 cache',
);

assertContains(
  voiceAudioModule,
  'recordingSessionId?.let { stopRecording(it, true) }',
  '删除原生录音 cache 前必须先结束活动录音',
);

assertContains(
  deviceObserverModule,
  'ManagedScreenshotFile.directory(context).deleteRecursively()',
  '恢复出厂必须删除 RavenCat 自己的设备截图 cache',
);

assertContains(
  deviceObserverModule,
  'InstalledLaunchableAppQuery(context).clearIconCache()',
  '恢复出厂必须删除可再生成的应用图标 cache',
);

assertNotContains(
  resetFacade,
  'content://',
  '恢复出厂门面不得尝试按 external content URI 删除用户原文件',
);

assertContains(
  speechStore,
  `${'${FileSystem.cacheDirectory}'}speech/`,
  '语音临时缓存清理只能定位 RavenCat 自己的 speech/ cache',
);

assertContains(
  mediaStore,
  'idempotent',
  'clearPersistentApplicationMedia 必须使用 idempotent 删除',
);

assertContains(
  mediaStore,
  'persistent-media/',
  'clearPersistentApplicationMedia 只清理 persistent-media/ 根目录，不删除 Backups/或数据库文件',
);

// ── UI 运行时 ───────────────────────────────────────────

const host = readSrc('src/host/KimiPhoneHost.tsx');

assertContains(
  host,
  'applicationResetRevision',
  'Host 必须持有 reset revision',
);

assertContains(
  host,
  'application-runtime-',
  'reset revision 必须用于重挂 Theme/Wallpaper/Host/Chat 路由子树',
);

assertContains(
  host,
  'onResetApplicationData',
  'Host 必须将 reset 传递给 ChatRouterProvider',
);

assertContains(
  host,
  'resetApplicationData',
  'Host 必须调用 resetApplicationData 门面',
);

assertContains(
  host,
  'cancelActiveHostAgentRunsForReset',
  'Host 必须在清库前调用 cancelActiveHostAgentRunsForReset',
);

assertContains(
  host,
  'resetConversationListReady()',
  '恢复出厂必须调用 resetConversationListReady() 进入新一轮冷启动',
);

assertContains(
  host,
  'finally',
  'Host reset 必须使用 finally 保证成功/失败都触发重挂',
);

assertContains(
  host,
  'onResetApplicationData();',
  'Host reset 必须在 finally 中调用 onResetApplicationData 重挂子树',
);

assertContains(
  host,
  'throw resetError',
  'Host reset 失败时必须在重挂后向调用方重新抛出原始错误',
);

const helpersAgain = readSrc('src/platform/persistence/helpers.ts');

assertContains(
  helpersAgain,
  'AggregateError',
  'clearDB 双重失败（事务错误 + 外键恢复错误）必须用 AggregateError 同时保留',
);

const settings = readSrc('src/app/(tabs)/settings.tsx');

assertContains(
  settings,
  'resetApplicationData',
  'Settings 必须使用 Context 的 resetApplicationData',
);

assertNotContains(
  settings,
  'state.handleClearData',
  'Settings 不得继续使用 state.handleClearData',
);

const chatEntry = readSrc('src/features/chat/presentation/shell/useChatConversationEntry.ts');

assertNotContains(
  chatEntry,
  'clearChatApplicationData',
  'Chat Conversation Entry 不得再直接调用整库清理',
);

assertNotContains(
  chatEntry,
  'handleClearData',
  'Chat Conversation Entry 不得再返回 handleClearData',
);

const chatPresentation = readSrc('src/features/chat/conversation/application/ChatPresentation.ts');

assertNotContains(
  chatPresentation,
  'clearChatApplicationData',
  'ChatPresentation 不得再导出 clearChatApplicationData 清库入口',
);

const selfIdentity = readSrc('src/shared/kernel/selfIdentity.ts');

assertNotContains(
  selfIdentity,
  '枫渡',
  'DEFAULT_SELF_NAME 不得继续是具体个人姓名',
);

assertContains(
  selfIdentity,
  '用户',
  'DEFAULT_SELF_NAME 必须是中性默认值',
);

assertContains(
  selfIdentity,
  "SELF_USER_ID = 'self'",
  '不得修改稳定 ID SELF_USER_ID',
);

// ── 结果 ────────────────────────────────────────────────

if (errors.length > 0) {
  console.error('应用数据恢复出厂静态契约验证失败：');
  for (const error of errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exit(1);
}

console.log('恢复出厂静态契约与 shutdown-before-persistence 行为已验证；');
console.log('真实 expo-sqlite、AsyncStorage、文件系统和长驻 Tab 重挂仍需真机验收。');
