/**
 * Device Control application 层：Soft Lock 业务真值的唯一写入编排。
 *
 * 固定顺序：
 * 1. validate（domain 校验，非法输入直接拒绝）；
 * 2. persist business fact（先提交 active / released / expired）；
 * 3. commit 之后才启动 / reconcile native 投影；空投影收敛后再停止 runtime。
 *
 * native 端 typed failure 只随结果上报，绝不回流改写 SQLite status，
 * 也不在业务提交失败时伪装成功。
 */

import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { SoftAppLock } from '../domain/SoftAppLock';
import { createSoftAppLock, isValidSoftAppLockTargetPackage } from '../domain/SoftAppLock';
import type { ISoftAppLockRepository } from '../domain/SoftAppLockRepository';
import type {
  DeviceControlReconcileResult,
  DeviceControlRuntimeStartResult,
  DeviceControlRuntimeState,
  DeviceControlRuntimeStopResult,
  NativeSoftLockProjection,
  DeviceControlPort,
} from './DeviceControlPort';
import {
  resolveSoftLockExecutionTruth,
  type SoftLockExecutionTruth,
} from './SoftLockExecutionTruth';

export interface DeviceControlFacadeDependencies {
  repository: ISoftAppLockRepository;
  port: DeviceControlPort;
  generateId: () => string;
  /** 默认 Date.now；测试注入固定时钟。 */
  nowEpochMs?: () => number;
}

const FACTORY_RESET_SHUTDOWN_ATTEMPTS = 20;
const FACTORY_RESET_SHUTDOWN_POLL_MS = 50;

class DeviceControlFactoryResetInProgressError extends Error {
  constructor() {
    super('Device Control 正在为恢复出厂安全关闭');
    this.name = 'DeviceControlFactoryResetInProgressError';
  }
}

export interface DeviceControlSynchronizationResult {
  active: SoftAppLock[];
  start: DeviceControlRuntimeStartResult | null;
  reconcile: DeviceControlReconcileResult | null;
  stop: DeviceControlRuntimeStopResult | null;
}

export type ActivateAiSoftLockResult =
  | {
      status: 'activated';
      lock: SoftAppLock;
      native: DeviceControlSynchronizationResult;
      runtimeState: DeviceControlRuntimeState;
      execution: SoftLockExecutionTruth;
    }
  | {
      status: 'already_active';
      lock: SoftAppLock;
      native: DeviceControlSynchronizationResult;
      runtimeState: DeviceControlRuntimeState;
      execution: SoftLockExecutionTruth;
    }
  | { status: 'rejected'; reason: 'invalid_target_package' | 'invalid_expiry' };

export type ReleaseAiSoftLockApplicationResult =
  | { status: 'released'; lock: SoftAppLock; native: DeviceControlSynchronizationResult }
  | { status: 'not_found'; native: DeviceControlSynchronizationResult };

export type ReconcileDeviceControlResult = {
  expired: SoftAppLock[];
  active: SoftAppLock[];
  native: DeviceControlSynchronizationResult;
};

function toSoftLockProjection(lock: SoftAppLock): NativeSoftLockProjection {
  return {
    id: lock.id,
    targetPackage: lock.targetPackage,
    expiresAtEpochMs: lock.expiresAtEpochMs,
  };
}

export class DeviceControlFacade {
  /**
   * native projection 是 commit 后副作用；同一进程内必须串行，避免较早读取的
   * startup snapshot 在较晚的 release projection 之后重新下发。
   */
  private commandTail: Promise<void> = Promise.resolve();
  private factoryResetQuiescing = false;
  private factoryResetQuiescePromise: Promise<void> | null = null;

  constructor(private readonly dependencies: DeviceControlFacadeDependencies) {}

  /** 正式 AI 写入入口：source/sourceAiId/expiry 均由可信 application command 固定。 */
  async activateAiSoftLock(input: {
    targetPackage: string;
    sourceAiId: string;
    reason?: string;
    expiresAtEpochMs: number;
  }, abortSignal?: AbortSignal): Promise<ActivateAiSoftLockResult> {
    return this.runCommand(
      () => this.activateAiSoftLockCommand(input, abortSignal),
      abortSignal,
    );
  }

  private async activateAiSoftLockCommand(input: {
    targetPackage: string;
    sourceAiId: string;
    reason?: string;
    expiresAtEpochMs: number;
  }, abortSignal?: AbortSignal): Promise<ActivateAiSoftLockResult> {
    const nowEpochMs = this.now();

    if (!isValidSoftAppLockTargetPackage(input.targetPackage)) {
      return { status: 'rejected', reason: 'invalid_target_package' };
    }
    if (!Number.isInteger(input.expiresAtEpochMs) || input.expiresAtEpochMs <= nowEpochMs) {
      return { status: 'rejected', reason: 'invalid_expiry' };
    }

    await this.dependencies.repository.expireDue(nowEpochMs);
    // expireDue 只是前置归一化；核心 ai_tool 业务事实仍须在当前 signal
    // 未取消时才提交。核心 commit 开始后不再中途取消，后续投影必须收口。
    throwIfAbortSignalAborted(abortSignal);

    const reason = input.reason?.trim();
    const lock = createSoftAppLock({
      id: this.dependencies.generateId(),
      targetPackage: input.targetPackage,
      source: 'ai_tool',
      sourceAiId: input.sourceAiId,
      reason: reason ? reason : undefined,
      createdAtEpochMs: nowEpochMs,
      expiresAtEpochMs: input.expiresAtEpochMs,
    });

    const persisted = await this.dependencies.repository.insertAiLockIfNoActiveByActorAndTarget(
      lock,
      nowEpochMs
    );
    // 重复调用不改业务事实，但仍把当前 SQLite truth 显式同步给 native，供既有失败投影恢复。
    const native = await this.synchronizeAfterActivation(nowEpochMs);
    const runtimeState = await this.dependencies.port.getRuntimeState();
    const execution = resolveSoftLockExecutionTruth({
      lockId: persisted.lock.id,
      targetPackage: persisted.lock.targetPackage,
      start: native.start,
      reconcile: native.reconcile,
      runtimeState,
    });
    return persisted.outcome === 'inserted'
      ? { status: 'activated', lock: persisted.lock, native, runtimeState, execution }
      : { status: 'already_active', lock: persisted.lock, native, runtimeState, execution };
  }

  /** 主理 AI release 入口只按可信 actor + exact target 命中自己的 active ai_tool 锁。 */
  async releaseAiSoftLock(input: {
    targetPackage: string;
    sourceAiId: string;
  }, abortSignal?: AbortSignal): Promise<ReleaseAiSoftLockApplicationResult> {
    return this.runCommand(
      () => this.releaseAiSoftLockCommand(input, abortSignal),
      abortSignal,
    );
  }

  private async releaseAiSoftLockCommand(input: {
    targetPackage: string;
    sourceAiId: string;
  }, abortSignal?: AbortSignal): Promise<ReleaseAiSoftLockApplicationResult> {
    const nowEpochMs = this.now();
    await this.dependencies.repository.expireDue(nowEpochMs);
    // 与 activate 相同：归一化完成后，在 release 事务前重新读取 signal；
    // release 事务一旦开始，下面的 list/reconcile 必须继续执行以保持投影一致。
    throwIfAbortSignalAborted(abortSignal);
    const result = await this.dependencies.repository.releaseActiveAiLockByActorAndTarget(
      input.sourceAiId,
      input.targetPackage
    );
    const active = await this.dependencies.repository.listActive(nowEpochMs);
    const native = await this.reconcileAndStopIfIdle(active);
    return result.outcome === 'released'
      ? { status: 'released', lock: result.lock, native }
      : { status: 'not_found', native };
  }

  /**
   * 可见 Host 的恢复用例：先归一化业务真值，再决定是否
   * 合法启动 runtime。纯后台启动受限时保留 SQLite active 行并 fail open。
   */
  async reconcileDeviceControl(): Promise<ReconcileDeviceControlResult> {
    return this.runCommand(() => this.reconcileDeviceControlCommand());
  }

  private async reconcileDeviceControlCommand(): Promise<ReconcileDeviceControlResult> {
    const nowEpochMs = this.now();
    const expired = await this.dependencies.repository.expireDue(nowEpochMs);
    const active = await this.dependencies.repository.listActive(nowEpochMs);

    if (active.length === 0) {
      const native = await this.reconcileAndStopIfIdle(active);
      return { expired, active, native };
    }

    const start = await this.dependencies.port.startRuntime();
    if (!isRuntimeStarted(start)) {
      return {
        expired,
        active,
        native: { active, start, reconcile: null, stop: null },
      };
    }

    const reconcile = await this.reconcileLocks(active);
    return {
      expired,
      active,
      native: { active, start, reconcile, stop: null },
    };
  }

  /**
   * 恢复出厂执行屏障：先清空 native 权威投影并确认 blocking window 已移除，
   * 再停止 runtime，最后等待 Android Service 的 onDestroy 事实可见。
   */
  quiesceForFactoryReset(): Promise<void> {
    if (this.factoryResetQuiescePromise) {
      return this.factoryResetQuiescePromise;
    }

    this.factoryResetQuiescing = true;
    const quiesce = this.enqueueCommand(() => this.quiesceForFactoryResetCommand());
    this.factoryResetQuiescePromise = quiesce;
    return quiesce;
  }

  /** reset 的 DB / 文件阶段结束后释放 application command gate。 */
  resumeAfterFactoryReset(): void {
    this.factoryResetQuiescing = false;
    this.factoryResetQuiescePromise = null;
  }

  private now(): number {
    return this.dependencies.nowEpochMs ? this.dependencies.nowEpochMs() : Date.now();
  }

  private async quiesceForFactoryResetCommand(): Promise<void> {
    const initialState = await this.dependencies.port.getRuntimeState();
    if (isRuntimeFullyStopped(initialState)) {
      return;
    }

    const reconcile = await this.dependencies.port.reconcileSoftLocks([]);
    if (reconcile.status !== 'ok') {
      throw new Error(
        `Device Control 恢复出厂空投影同步失败：${reconcile.reason ?? reconcile.status}`
      );
    }

    await this.waitForRuntimeState(
      (state) => !state.attached,
      'Device Control blocking window 未在恢复出厂前移除'
    );

    const stop = await this.dependencies.port.stopRuntimeIfIdle();
    if (stop.status !== 'stopped' && stop.status !== 'already_stopped') {
      throw new Error(
        `Device Control 恢复出厂停止失败：${stop.reason ?? stop.status}`
      );
    }

    await this.waitForRuntimeState(
      isRuntimeFullyStopped,
      'Device Control Service 未在恢复出厂前停止'
    );
  }

  private async waitForRuntimeState(
    accepted: (state: DeviceControlRuntimeState) => boolean,
    failureMessage: string
  ): Promise<DeviceControlRuntimeState> {
    for (let attempt = 0; attempt < FACTORY_RESET_SHUTDOWN_ATTEMPTS; attempt += 1) {
      const state = await this.dependencies.port.getRuntimeState();
      if (state.overlayStatus === 'remove_failed') {
        throw new Error('Device Control blocking window 移除失败，无法安全恢复出厂');
      }
      if (accepted(state)) {
        return state;
      }

      if (attempt < FACTORY_RESET_SHUTDOWN_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, FACTORY_RESET_SHUTDOWN_POLL_MS);
        });
      }
    }

    throw new Error(failureMessage);
  }

  /** commit 之后的权威投影同步；native 失败只上报，不改写业务真值。 */
  private reconcileLocks(active: SoftAppLock[]): Promise<DeviceControlReconcileResult> {
    return this.dependencies.port.reconcileSoftLocks(active.map(toSoftLockProjection));
  }

  private async synchronizeAfterActivation(
    nowEpochMs: number
  ): Promise<DeviceControlSynchronizationResult> {
    const start = await this.dependencies.port.startRuntime();
    const active = await this.dependencies.repository.listActive(nowEpochMs);
    if (!isRuntimeStarted(start)) {
      return { active, start, reconcile: null, stop: null };
    }

    const reconcile = await this.reconcileLocks(active);
    return { active, start, reconcile, stop: null };
  }

  private async reconcileAndStopIfIdle(
    active: SoftAppLock[]
  ): Promise<DeviceControlSynchronizationResult> {
    const reconcile = await this.reconcileLocks(active);
    const stop = active.length === 0
      ? await this.dependencies.port.stopRuntimeIfIdle()
      : null;
    return { active, start: null, reconcile, stop };
  }

  private runCommand<T>(command: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
    return this.enqueueCommand(() => {
      if (this.factoryResetQuiescing) {
        throw new DeviceControlFactoryResetInProgressError();
      }
      throwIfAbortSignalAborted(abortSignal);
      return command();
    });
  }

  private enqueueCommand<T>(command: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(command);
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isRuntimeStarted(result: DeviceControlRuntimeStartResult): boolean {
  return result.status === 'started' || result.status === 'already_running';
}

function isRuntimeFullyStopped(state: DeviceControlRuntimeState): boolean {
  return state.overlayStatus !== 'remove_failed'
    && !state.attached
    && !state.runtimeAttached
    && !state.serviceRunning;
}
