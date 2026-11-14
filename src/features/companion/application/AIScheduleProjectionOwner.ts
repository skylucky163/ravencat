/** AI Schedule 应用层 projection owner：durable truth 先提交，native keyed projection 后同步。 */

import type {
  AISchedule,
  AIScheduleCompletionDisposition,
} from '../domain/AISchedule';
import type { AIScheduleRepository, RemoveAIScheduleCalendarInput } from '../domain/AIScheduleRepository';
import type { CompanionStateRepository } from '../domain/CompanionRepositories';
import type { CompanionState } from '../domain/CompanionState';
import type {
  AIScheduleApplicationErrorCode,
} from './AIScheduleApplication';
import {
  cancelAIScheduleCommand,
  claimAIScheduleCommand,
  consumeAIScheduleCommand,
  createAIScheduleCommand,
  updateAIScheduleCommand,
  removeAIScheduleCalendarLinksCommand,
} from './AIScheduleApplication';
import type {
  AIScheduleTriggerProjection,
  CompanionNativePort,
} from './CompanionNativePort';
import {
  AIScheduleProjectionRepairCoordinator,
} from './AIScheduleProjectionRepairCoordinator';
import { getCompanionRuntimeDependencies } from './CompanionRuntimeDependencies';
import { systemCalendar, type SystemCalendarPort } from '@platform/device/SystemCalendar';
import type { AIScheduleRecurrence } from '../domain/AIScheduleTiming';

export type AIScheduleCalendarOutcome = 'internal_only' | 'synced' | 'permission_required' | 'no_writable_calendar' | 'failed';
type CalendarPreflightError = 'calendar_permission_required' | 'calendar_unavailable';

export type AIScheduleProjectionOutcome =
  | { status: 'projected' }
  | { status: 'already_current' }
  | { status: 'canceled' }
  | { status: 'projection_failed'; operation: 'schedule' | 'cancel' | 'read'; error: unknown };

export interface AIScheduleProjectionFailure {
  scheduleId: string | null;
  operation: 'schedule' | 'cancel' | 'read' | 'calendar';
  error: unknown;
}

export interface AIScheduleProjectionReconcileOutcome {
  status: 'reconciled' | 'repair_pending';
  scheduledCount: number;
  projectedCount: number;
  alreadyCurrentCount: number;
  canceledCount: number;
  failedCount: number;
  failures: AIScheduleProjectionFailure[];
}

export interface CreateAIScheduleInput {
  ownerAIId: string;
  remindAt: string;
  summary: string;
  details: string;
  systemCalendar?: boolean;
  recurrence?: AIScheduleRecurrence | null;
  sourceConversationId?: string;
  sourceMessageIds?: string[];
}

export interface UpdateAIScheduleInput {
  scheduleId: string;
  ownerAIId: string;
  remindAt?: string;
  summary?: string;
  details?: string;
  systemCalendar?: boolean;
  recurrence?: AIScheduleRecurrence | null;
}

export type CreateAIScheduleWithProjectionOutcome =
  | { status: 'created'; schedule: AISchedule; projection: AIScheduleProjectionOutcome; calendar: AIScheduleCalendarOutcome }
  | { status: 'error'; code: AIScheduleApplicationErrorCode | CalendarPreflightError; projection: null };

export type UpdateAIScheduleWithProjectionOutcome =
  | { status: 'updated'; schedule: AISchedule; projection: AIScheduleProjectionOutcome; calendar: AIScheduleCalendarOutcome }
  | { status: 'error'; code: AIScheduleApplicationErrorCode | CalendarPreflightError; projection: null };

export type CancelAIScheduleWithProjectionOutcome =
  | { status: 'cancelled'; schedule: AISchedule; projection: AIScheduleProjectionOutcome; calendar: AIScheduleCalendarOutcome }
  | { status: 'error'; code: AIScheduleApplicationErrorCode; projection: null };

export type ConsumeAIScheduleWithProjectionOutcome =
  | { status: 'consumed'; schedule: AISchedule; projection: AIScheduleProjectionOutcome }
  | { status: 'error'; code: AIScheduleApplicationErrorCode; projection: null };

export type RemoveAIScheduleCalendarEventsOutcome =
  | { status: 'updated'; matchedCount: number; updatedCount: number; removedCount: number;
      pendingCount: number | null; calendar: 'synced' | 'permission_required' | 'failed' }
  | { status: 'error'; code: AIScheduleApplicationErrorCode };

export interface AIScheduleProjectionOwnerDependencies {
  calendar: SystemCalendarPort;
  schedules: AIScheduleRepository;
  companionState: CompanionStateRepository;
  native: Pick<
    CompanionNativePort,
    'scheduleAIScheduleTrigger' | 'cancelAIScheduleTrigger' | 'listAIScheduleTriggerProjections' | 'setCompanionSchedulingEnabled'
  >;
  /** 主理身份与主动伴随开关共同决定日程能否取得执行机会。 */
  getCurrentHostAIId(): Promise<string | null>;
  now(): Date;
}

export class AIScheduleProjectionOwner {
  private operationTail: Promise<void> = Promise.resolve();
  private readonly repairCoordinator: AIScheduleProjectionRepairCoordinator<AIScheduleProjectionReconcileOutcome>;

  constructor(private readonly dependencies: AIScheduleProjectionOwnerDependencies) {
    this.repairCoordinator = new AIScheduleProjectionRepairCoordinator({
      reconcile: () => this.reconcile(),
      isHealthy: (outcome) => outcome.status === 'reconciled',
    });
  }

  activateCompanion(ownerAIId: string): Promise<CompanionState> {
    return this.enqueueOperation(async () => {
      const state = await this.dependencies.companionState.update({
        desiredEnabled: true, activationStatus: 'enabled', hostAIId: ownerAIId,
        lastFailureCode: null, lastFailureAt: null,
      });
      await this.reconcileCurrentTruth();
      return state;
    });
  }

  /** 暂停只撤销原生投影，保留 SQLite 计划；迟到回调由 Repository 开关边界拒绝。 */
  disableCompanion(input: {
    expectedOwnerAIId?: string; clearHostAI: boolean; failureCode: string | null;
  }): Promise<CompanionState> {
    return this.enqueueOperation(async () => {
      const current = await this.dependencies.companionState.ensureDefault();
      if (input.expectedOwnerAIId && current.hostAIId !== input.expectedOwnerAIId) return current;
      const state = await this.dependencies.companionState.update({
        desiredEnabled: false, activationStatus: 'disabled',
        hostAIId: input.clearHostAI ? null : current.hostAIId,
        lastFailureCode: input.failureCode,
        lastFailureAt: input.failureCode ? this.dependencies.now().toISOString() : null,
      });
      await this.reconcileCurrentTruth();
      return state;
    });
  }

  create(input: CreateAIScheduleInput): Promise<CreateAIScheduleWithProjectionOutcome> {
    return this.enqueueOperation(() => this.commitAndProjectCreate(input));
  }

  update(input: UpdateAIScheduleInput): Promise<UpdateAIScheduleWithProjectionOutcome> {
    return this.enqueueOperation(() => this.commitAndProjectUpdate(input));
  }

  cancel(input: {
    scheduleId: string;
    ownerAIId: string;
  }): Promise<CancelAIScheduleWithProjectionOutcome> {
    return this.enqueueOperation(() => this.commitAndProjectCancel(input));
  }

  removeCalendarEvents(input: RemoveAIScheduleCalendarInput): Promise<RemoveAIScheduleCalendarEventsOutcome> {
    return this.enqueueOperation(async () => {
      // 先保存仅应用内的用户意图；缺权限也不能继续导出后续重复期次。
      const outcome = await removeAIScheduleCalendarLinksCommand(input);
      if (outcome.status === 'error') return outcome;
      const result = { status: 'updated' as const, matchedCount: outcome.scheduleIds.length,
        updatedCount: outcome.updatedCount, removedCount: 0 };
      if (outcome.scheduleIds.length === 0) return { ...result, pendingCount: 0, calendar: 'synced' };
      let keys: string[];
      try {
        if (await this.dependencies.calendar.prepare() === 'permission_required') {
          return { ...result, pendingCount: null, calendar: 'permission_required' };
        }
        const selected = new Set(outcome.scheduleIds);
        keys = [...new Set(await this.dependencies.calendar.listKeys())].filter(key => selected.has(key));
      } catch (error) {
        console.warn('[AISchedule] 读取待移除的系统日历关联失败：', error);
        this.repairCoordinator.requestRepair();
        return { ...result, pendingCount: null, calendar: 'failed' };
      }
      let pendingCount = 0;
      for (const key of keys) {
        try { await this.dependencies.calendar.remove(key); result.removedCount += 1; }
        catch (error) {
          pendingCount += 1;
          console.warn('[AISchedule] 系统日历关联尚未移除：', { scheduleId: key, error });
        }
      }
      if (pendingCount > 0) this.repairCoordinator.requestRepair();
      return { ...result, pendingCount, calendar: pendingCount > 0 ? 'failed' : 'synced' };
    });
  }

  consume(input: {
    scheduleId: string;
    runId: string;
    consumedAt: string;
    completionDisposition: AIScheduleCompletionDisposition;
    failureCode?: string;
    firstVisibleAt?: string | null;
  }): Promise<ConsumeAIScheduleWithProjectionOutcome> {
    return this.enqueueOperation(() => this.commitAndProjectConsume(input));
  }

  /**
   * 由冷启动 / 前台恢复调用；恢复 coordinator 会合并重复触发并复用 in-flight
   * reconcile。实际 projection mutation 仍通过本 owner 的 operation lane 执行。
   */
  reconcileNow(): Promise<AIScheduleProjectionReconcileOutcome> {
    return this.repairCoordinator.reconcileNow();
  }

  /** 恢复出厂前停止 pending timer，并等待已经开始的 reconcile 结束。 */
  drainAndCancelProjectionRepair(): Promise<void> {
    return this.repairCoordinator.drainAndCancel();
  }

  /**
   * 仅供 owner 内部 queue 使用：durable command commit 后重新读取目标 schedule，
   * 不把 command 返回的旧 snapshot 带入 native boundary。
   */
  private async commitAndProjectCreate(
    input: CreateAIScheduleInput,
  ): Promise<CreateAIScheduleWithProjectionOutcome> {
    if (input.systemCalendar) {
      const code = await this.prepareCalendarWrite();
      if (code) return { status: 'error', code, projection: null };
    }
    const outcome = await createAIScheduleCommand(input);
    if (outcome.status === 'error') return { status: 'error', code: outcome.code, projection: null };
    const projection = await this.projectLatestSchedule(outcome.schedule.scheduleId);
    this.reportProjectionFailure(projection);
    const calendar = outcome.schedule.systemCalendar
      ? await this.syncCalendar(outcome.schedule) : 'internal_only';
    return { status: 'created', schedule: outcome.schedule, projection, calendar };
  }

  private async commitAndProjectUpdate(
    input: UpdateAIScheduleInput,
  ): Promise<UpdateAIScheduleWithProjectionOutcome> {
    const current = await this.dependencies.schedules.getByScheduleId(input.scheduleId);
    if (current && current.ownerAIId === input.ownerAIId && (current.systemCalendar || input.systemCalendar)) {
      const code = await this.prepareCalendarWrite(input.systemCalendar === false);
      if (code) return { status: 'error', code, projection: null };
    }
    const outcome = await updateAIScheduleCommand(input);
    if (outcome.status === 'error') return { status: 'error', code: outcome.code, projection: null };
    const projection = await this.projectLatestSchedule(outcome.schedule.scheduleId);
    this.reportProjectionFailure(projection);
    const calendar = outcome.schedule.systemCalendar || current?.systemCalendar
      ? await this.syncCalendar(outcome.schedule) : 'internal_only';
    return { status: 'updated', schedule: outcome.schedule, projection, calendar };
  }

  private async commitAndProjectCancel(input: {
    scheduleId: string;
    ownerAIId: string;
  }): Promise<CancelAIScheduleWithProjectionOutcome> {
    const outcome = await cancelAIScheduleCommand(input);
    if (outcome.status === 'error') return { status: 'error', code: outcome.code, projection: null };
    const projection = await this.projectLatestSchedule(input.scheduleId);
    this.reportProjectionFailure(projection);
    const calendar = outcome.schedule.systemCalendar
      ? await this.syncCalendar(outcome.schedule) : 'internal_only';
    return { status: 'cancelled', schedule: outcome.schedule, projection, calendar };
  }

  private async commitAndProjectConsume(input: {
    scheduleId: string;
    runId: string;
    consumedAt: string;
    completionDisposition: AIScheduleCompletionDisposition;
    failureCode?: string;
    firstVisibleAt?: string | null;
  }): Promise<ConsumeAIScheduleWithProjectionOutcome> {
    const outcome = await consumeAIScheduleCommand(input);
    if (outcome.status === 'error') return { status: 'error', code: outcome.code, projection: null };
    const projection = await this.projectLatestSchedule(input.scheduleId);
    this.reportProjectionFailure(projection);
    await this.reconcileCurrentTruth();
    return { status: 'consumed', schedule: outcome.schedule, projection };
  }

  /**
   * startup reconcile：用 durable scheduled truth 重建 / 收口 native keyed projections。
   * 过期收口、重复推进与身份失效由 Repository 裁决；本 owner 只投影提交后的事实。
   */
  reconcile(): Promise<AIScheduleProjectionReconcileOutcome> {
    return this.enqueueOperation(() => this.reconcileCurrentTruth());
  }

  private async reconcileCurrentTruth(): Promise<AIScheduleProjectionReconcileOutcome> {
    let state: CompanionState;
    let scheduled: AISchedule[];
    try {
      state = await this.dependencies.companionState.ensureDefault();
      await this.dependencies.schedules.expireScheduled(this.dependencies.now().toISOString());
      // 原生开关是执行镜像；同一 lane 内先同步它，再处理每条日程投影。
      await this.dependencies.native.setCompanionSchedulingEnabled(state.desiredEnabled);
      scheduled = await this.dependencies.schedules.listAllScheduled();
    } catch (error) {
      return this.finishReconcile({
        scheduledCount: 0,
        projectedCount: 0,
        alreadyCurrentCount: 0,
        canceledCount: 0,
        failures: [{ scheduleId: null, operation: 'read', error }],
      });
    }
    let currentHost: string | null;
    try {
      currentHost = await this.dependencies.getCurrentHostAIId();
    } catch (error) {
      return this.finishReconcile({
        scheduledCount: scheduled.length,
        projectedCount: 0,
        alreadyCurrentCount: 0,
        canceledCount: 0,
        failures: [{ scheduleId: null, operation: 'read', error }],
      });
    }
    let nativeList: AIScheduleTriggerProjection[];
    try {
      nativeList = await this.dependencies.native.listAIScheduleTriggerProjections();
    } catch (error) {
      return this.finishReconcile({
        scheduledCount: scheduled.length,
        projectedCount: 0,
        alreadyCurrentCount: 0,
        canceledCount: 0,
        failures: [{ scheduleId: null, operation: 'read', error }],
      });
    }
    const nativeById = new Map(nativeList.map((projection) => [projection.scheduleId, projection]));
    const handled = new Set<string>();
    let projectedCount = 0;
    let alreadyCurrentCount = 0;
    let canceledCount = 0;
    const failures: AIScheduleProjectionFailure[] = [];

    for (const listedSchedule of scheduled) {
      // listAllScheduled 只是入口集合；每个 native boundary 前都重读该 schedule，
      // 防止 repair 携带已经过期的 v1 snapshot 覆盖 durable v2。
      let schedule: AISchedule | null;
      try {
        schedule = await this.dependencies.schedules.getByScheduleId(listedSchedule.scheduleId);
      } catch (error) {
        return this.finishReconcile({
          scheduledCount: scheduled.length,
          projectedCount,
          alreadyCurrentCount,
          canceledCount,
          failures: [...failures, {
            scheduleId: listedSchedule.scheduleId,
            operation: 'read',
            error,
          }],
        });
      }
      if (!schedule || schedule.status !== 'scheduled') continue;
      handled.add(schedule.scheduleId);
      // authority invalidation：owner 已不再是当前主理 AI。
      if (currentHost === null || schedule.ownerAIId !== currentHost) {
        const terminalized = await this.dependencies.schedules
          .terminalizeScheduledForOwnerInvalidation({
            scheduleId: schedule.scheduleId,
            occurredAt: this.dependencies.now().toISOString(),
          });
        if (terminalized.status === 'cancelled') {
          try {
            await this.dependencies.native.cancelAIScheduleTrigger(schedule.scheduleId);
            canceledCount += 1;
          } catch (error) {
            failures.push({ scheduleId: schedule.scheduleId, operation: 'cancel', error });
          }
        }
        continue;
      }

      if (!state.desiredEnabled) continue;

      const existing = nativeById.get(schedule.scheduleId);
      if (existing && matchesProjection(existing, schedule)) {
        alreadyCurrentCount += 1;
        continue;
      }

      const remindAtEpochMs = Date.parse(schedule.remindAt);
      // 错过且已无原生投影的机会只显示未执行，不在启动或回前台时补跑。
      if (remindAtEpochMs <= this.dependencies.now().getTime()) {
        if (existing) {
          try {
            await this.dependencies.native.cancelAIScheduleTrigger(schedule.scheduleId);
            canceledCount += 1;
          } catch (error) {
            failures.push({ scheduleId: schedule.scheduleId, operation: 'cancel', error });
          }
        }
        continue;
      }
      try {
        await this.dependencies.native.scheduleAIScheduleTrigger({
          scheduleId: schedule.scheduleId,
          ownerAIId: schedule.ownerAIId,
          remindAtEpochMs,
          projectionToken: schedule.updatedAt,
        });
        projectedCount += 1;
      } catch (error) {
        failures.push({ scheduleId: schedule.scheduleId, operation: 'schedule', error });
      }
    }

    // native 存在但 durable 已不是 scheduled（consumed/cancelled/缺失）→ 收口。
    for (const scheduleId of nativeById.keys()) {
      if (handled.has(scheduleId)) continue;
      try {
        await this.dependencies.native.cancelAIScheduleTrigger(scheduleId);
        canceledCount += 1;
      } catch (error) {
        failures.push({ scheduleId, operation: 'cancel', error });
      }
    }

    await this.reconcileCalendar(scheduled, failures);
    return this.finishReconcile({
      scheduledCount: scheduled.length,
      projectedCount,
      alreadyCurrentCount,
      canceledCount,
      failures,
    });
  }

  /** Host replace / revoke 后终结旧 owner 的 scheduled schedules，保留 owner identity。 */
  invalidateSchedulesForRevokedOwner(ownerAIId: string): Promise<void> {
    return this.enqueueOperation(() => this.invalidateSchedulesForRevokedOwnerInLane(ownerAIId));
  }

  private async invalidateSchedulesForRevokedOwnerInLane(ownerAIId: string): Promise<void> {
    const scheduled = await this.dependencies.schedules.listAllScheduled();
    for (const listedSchedule of scheduled) {
      const schedule = await this.dependencies.schedules.getByScheduleId(listedSchedule.scheduleId);
      if (!schedule || schedule.status !== 'scheduled' || schedule.ownerAIId !== ownerAIId) continue;
      const terminalized = await this.dependencies.schedules
        .terminalizeScheduledForOwnerInvalidation({
          scheduleId: schedule.scheduleId,
          occurredAt: this.dependencies.now().toISOString(),
        });
      if (terminalized.status === 'cancelled') {
        const projection = await this.cancelProjection(schedule.scheduleId);
        this.reportProjectionFailure(projection);
        if (terminalized.schedule.systemCalendar) await this.syncCalendar(terminalized.schedule);
      }
    }
  }

  private async projectLatestSchedule(scheduleId: string): Promise<AIScheduleProjectionOutcome> {
    let schedule: AISchedule | null;
    try {
      schedule = await this.dependencies.schedules.getByScheduleId(scheduleId);
    } catch (error) {
      return { status: 'projection_failed', operation: 'read', error };
    }
    if (!schedule || schedule.status !== 'scheduled') return this.cancelProjection(scheduleId);
    let state: CompanionState;
    try {
      state = await this.dependencies.companionState.ensureDefault();
      await this.dependencies.native.setCompanionSchedulingEnabled(state.desiredEnabled);
    } catch (error) {
      return { status: 'projection_failed', operation: 'schedule', error };
    }
    if (!state.desiredEnabled) return this.cancelProjection(scheduleId);
    return this.projectSchedule(schedule);
  }

  /** 缺权限在业务 commit 前返回；不自动请求权限，不偷偷创建内部日程。 */
  private async prepareCalendarWrite(removeOnly = false): Promise<CalendarPreflightError | null> {
    try {
      const availability = await this.dependencies.calendar.prepare();
      if (availability === 'permission_required') return 'calendar_permission_required';
      return availability === 'no_writable_calendar' && !removeOnly ? 'calendar_unavailable' : null;
    } catch {
      return 'calendar_unavailable';
    }
  }

  private async syncCalendar(committed: AISchedule): Promise<AIScheduleCalendarOutcome> {
    try {
      const availability = await this.dependencies.calendar.prepare();
      if (availability === 'permission_required') return availability;
      const schedule = await this.dependencies.schedules.getByScheduleId(committed.scheduleId);
      if (!schedule || !schedule.systemCalendar || schedule.status === 'cancelled') {
        await this.dependencies.calendar.remove(committed.scheduleId);
      } else {
        if (availability !== 'ready') return availability;
        await this.dependencies.calendar.upsert({
          key: schedule.scheduleId, title: schedule.summary, description: schedule.details,
          startAtEpochMs: Date.parse(schedule.remindAt),
        });
      }
      return 'synced';
    } catch (error) {
      // 内外数据库不能共享事务；业务已提交时明确返回部分成功，沿用现有投影恢复。
      console.warn('[AISchedule] 系统日历同步失败：', error);
      this.repairCoordinator.requestRepair();
      return 'failed';
    }
  }

  private async reconcileCalendar(scheduled: AISchedule[], failures: AIScheduleProjectionFailure[]): Promise<void> {
    try {
      // 暂停主动伴随不撤销系统提醒；权限恢复后由同一生命周期恢复入口继续同步。
      const availability = await this.dependencies.calendar.prepare();
      if (availability === 'permission_required') return;
      const keys = new Set(await this.dependencies.calendar.listKeys());
      for (const schedule of scheduled) if (schedule.systemCalendar) keys.add(schedule.scheduleId);
      for (const key of keys) {
        const schedule = await this.dependencies.schedules.getByScheduleId(key);
        if (!schedule || !schedule.systemCalendar || schedule.status === 'cancelled') {
          await this.dependencies.calendar.remove(key);
        } else if (availability === 'ready' && schedule.status === 'scheduled' && Date.parse(schedule.remindAt) > this.dependencies.now().getTime()) {
          await this.dependencies.calendar.upsert({ key, title: schedule.summary,
            description: schedule.details, startAtEpochMs: Date.parse(schedule.remindAt) });
        }
        // 到期后的系统事件保留给日历展示，不因 AI claim/consume 提前撤销系统提醒。
      }
    } catch (error) {
      failures.push({ scheduleId: null, operation: 'calendar', error });
    }
  }

  private async projectSchedule(schedule: AISchedule): Promise<AIScheduleProjectionOutcome> {
    const remindAtEpochMs = Date.parse(schedule.remindAt);
    try {
      await this.dependencies.native.scheduleAIScheduleTrigger({
        scheduleId: schedule.scheduleId,
        ownerAIId: schedule.ownerAIId,
        remindAtEpochMs,
        projectionToken: schedule.updatedAt,
      });
      return { status: 'projected' };
    } catch (error) {
      return { status: 'projection_failed', operation: 'schedule', error };
    }
  }

  private async cancelProjection(scheduleId: string): Promise<AIScheduleProjectionOutcome> {
    try {
      await this.dependencies.native.cancelAIScheduleTrigger(scheduleId);
      return { status: 'canceled' };
    } catch (error) {
      return { status: 'projection_failed', operation: 'cancel', error };
    }
  }

  private reportProjectionFailure(projection: AIScheduleProjectionOutcome): void {
    if (projection.status === 'projection_failed') {
      this.repairCoordinator.requestRepair();
      console.warn('[RavenCatAI Schedule] 业务已提交，native projection 失败（后台 bounded repair 与生命周期恢复会重试）：', {
        operation: projection.operation,
        error: projection.error,
      });
    }
  }

  private finishReconcile(input: Omit<AIScheduleProjectionReconcileOutcome, 'status' | 'failedCount'>): AIScheduleProjectionReconcileOutcome {
    const outcome: AIScheduleProjectionReconcileOutcome = {
      ...input,
      status: input.failures.length === 0 ? 'reconciled' : 'repair_pending',
      failedCount: input.failures.length,
    };
    if (outcome.status === 'repair_pending') {
      for (const failure of outcome.failures) {
        console.warn('[RavenCatAI Schedule] native projection reconcile 失败：', failure);
      }
      this.repairCoordinator.requestRepair();
    }
    return outcome;
  }

  private enqueueOperation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(task, task);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function matchesProjection(
  projection: AIScheduleTriggerProjection,
  schedule: AISchedule,
): boolean {
  return projection.scheduleId === schedule.scheduleId
    && projection.ownerAIId === schedule.ownerAIId
    && projection.expectedRemindAtEpochMs === Date.parse(schedule.remindAt)
    && projection.projectionToken === schedule.updatedAt;
}

const aiScheduleProjectionOwner = new AIScheduleProjectionOwner({
  calendar: systemCalendar,
  get companionState() {
    return getCompanionRuntimeDependencies().repositories.companionState;
  },
  get schedules() {
    return getCompanionRuntimeDependencies().repositories.aiSchedules;
  },
  get native() {
    return getCompanionRuntimeDependencies().native.companion;
  },
  getCurrentHostAIId: async () => (
    (await getCompanionRuntimeDependencies().repositories.assistants.getHostSummary())?.id ?? null
  ),
  now: () => new Date(),
});

export const activateCompanionScheduling = (ownerAIId: string) => aiScheduleProjectionOwner.activateCompanion(ownerAIId);
export const disableCompanionScheduling = (input: Parameters<AIScheduleProjectionOwner['disableCompanion']>[0]) =>
  aiScheduleProjectionOwner.disableCompanion(input);

export function createAIScheduleWithProjection(
  input: CreateAIScheduleInput,
): Promise<CreateAIScheduleWithProjectionOutcome> {
  return aiScheduleProjectionOwner.create(input);
}

export function updateAIScheduleWithProjection(
  input: UpdateAIScheduleInput,
): Promise<UpdateAIScheduleWithProjectionOutcome> {
  return aiScheduleProjectionOwner.update(input);
}

export function cancelAIScheduleWithProjection(input: {
  scheduleId: string;
  ownerAIId: string;
}): Promise<CancelAIScheduleWithProjectionOutcome> {
  return aiScheduleProjectionOwner.cancel(input);
}

export function removeAIScheduleCalendarEvents(input: RemoveAIScheduleCalendarInput): Promise<RemoveAIScheduleCalendarEventsOutcome> {
  return aiScheduleProjectionOwner.removeCalendarEvents(input);
}

export function consumeAIScheduleWithProjection(input: {
  scheduleId: string;
  runId: string;
  consumedAt: string;
  completionDisposition: AIScheduleCompletionDisposition;
  failureCode?: string;
  firstVisibleAt?: string | null;
}): Promise<ConsumeAIScheduleWithProjectionOutcome> {
  return aiScheduleProjectionOwner.consume(input);
}

export async function claimAIScheduleForHeadless(input: {
  scheduleId: string;
  ownerAIId: string;
  runId: string;
  claimedAt: string;
  expectedRemindAt: string;
  projectionToken: string;
  conversationId: string;
}) {
  const outcome = await claimAIScheduleCommand(input);
  if (outcome.status === 'claimed') await reconcileAIScheduleProjections();
  return outcome;
}

/** 冷启动 / 前台生命周期恢复入口；会立即尝试一次并接管后续 bounded repair。 */
export function reconcileAIScheduleProjections(): Promise<AIScheduleProjectionReconcileOutcome> {
  return aiScheduleProjectionOwner.reconcileNow();
}

/** 恢复出厂前调用；取消 pending timer，并等待当前 repair reconcile 完成。 */
export function drainAndCancelAIScheduleProjectionRepair(): Promise<void> {
  return aiScheduleProjectionOwner.drainAndCancelProjectionRepair();
}

export function invalidateAISchedulesForRevokedOwner(ownerAIId: string): Promise<void> {
  return aiScheduleProjectionOwner.invalidateSchedulesForRevokedOwner(ownerAIId);
}
