/** AI Schedule 持久端口；所有状态迁移与时间事实裁决均由实现原子提交。 */

import type {
  AISchedule,
  AIScheduleCompletionDisposition,
  AIScheduleStatus,
} from './AISchedule';
import type { AIScheduleContextItem, AIScheduleDispatchInput } from './AIScheduleContext';
import type { AIScheduleRecurrence, AIScheduleUnansweredItem } from './AIScheduleTiming';

export type AIScheduleCommandErrorCode =
  | 'companion_disabled'
  | 'not_found'
  | 'not_owner'
  | 'not_scheduled'
  | 'not_claimed'
  | 'already_past'
  | 'invalid_time'
  | 'already_claimed'
  | 'already_terminal'
  | 'run_mismatch'
  | 'not_due'
  | 'stale_projection';

export interface AIScheduleListCursor {
  remindAt: string;
  scheduleId: string;
}

export interface AIScheduleListItem {
  scheduleId: string;
  remindAt: string;
  summary: string;
  status: AIScheduleStatus;
}

export interface ListAISchedulesInput {
  ownerAIId: string;
  from: string;
  to: string;
  status?: AIScheduleStatus;
  after?: AIScheduleListCursor | null;
  limit: number;
}

export interface AIScheduleListPage {
  items: AIScheduleListItem[];
  nextCursor: AIScheduleListCursor | null;
  hasMore: boolean;
}

export type AIScheduleCommandOutcome<TStatus extends string> =
  | { status: TStatus; schedule: AISchedule }
  | { status: AIScheduleCommandErrorCode };

export interface UpdateAIScheduleInput {
  scheduleId: string;
  ownerAIId: string;
  occurredAt: string;
  remindAt?: string;
  summary?: string;
  details?: string;
  systemCalendar?: boolean;
  recurrence?: AIScheduleRecurrence | null;
}

export interface RemoveAIScheduleCalendarInput {
  ownerAIId: string;
  scope: 'schedule' | 'series' | 'all';
  /** 单条与重复系列通过任意一期的真实身份定位；all 不接受此字段。 */
  scheduleId?: string;
}

export type RemoveAIScheduleCalendarOutcome =
  | { status: 'updated'; scheduleIds: string[]; updatedCount: number }
  | { status: 'not_found' | 'not_owner' };

export interface AIScheduleRepository {
  removeCalendarLinks(input: RemoveAIScheduleCalendarInput): Promise<RemoveAIScheduleCalendarOutcome>;
  listUnanswered(conversationId: string): Promise<AIScheduleUnansweredItem[]>;
  setNextFollowUpInterval(input: { scheduleId: string; ownerAIId: string; runId: string; minutes: number }): Promise<AIScheduleCommandOutcome<'updated'>>;
  /** 对当前投递作版本裁决，收口过期安排，并将已到期的旧安排归并到最新安排。 */
  prepareDispatch(input: AIScheduleDispatchInput): Promise<AISchedule | null>;
  expireScheduled(occurredAt: string, ownerAIId?: string): Promise<void>;
  mergeDueIntoChat(ownerAIId: string, occurredAt: string): Promise<boolean>;
  mergeScheduled(scheduleId: string, targetScheduleId: string | null, occurredAt: string, failureCode?: string): Promise<void>;
  mergeClaimedRun(runId: string, targetScheduleId: string | null, occurredAt: string, firstVisibleAt?: string | null): Promise<void>;
  listPendingContext(ownerAIId: string, targetScheduleId: string | null): Promise<AIScheduleContextItem[]>;
  bindContext(input: { runId: string; occurredAt: string; acknowledge: AIScheduleContextItem[];
    present: AIScheduleContextItem[] }): Promise<AIScheduleContextItem[]>;
  createScheduled(schedule: AISchedule, occurredAt: string): Promise<
    AIScheduleCommandOutcome<'created'>
  >;
  getByScheduleId(scheduleId: string): Promise<AISchedule | null>;
  list(input: ListAISchedulesInput): Promise<AIScheduleListPage>;
  updateScheduled(input: UpdateAIScheduleInput): Promise<
    AIScheduleCommandOutcome<'updated'>
  >;
  cancelScheduled(input: {
    scheduleId: string;
    ownerAIId: string;
    occurredAt: string;
  }): Promise<AIScheduleCommandOutcome<'cancelled'>>;
  claimScheduled(input: {
    scheduleId: string;
    ownerAIId: string;
    runId: string;
    claimedAt: string;
    /** callback 携带的 durable 版本期望：与当前 remind_at 不一致即拒绝（stale_projection）。 */
    expectedRemindAt: string;
    /** 与 callback 一起携带的 durable 版本 token（updated_at）；不一致即拒绝。 */
    projectionToken: string;
    conversationId: string;
  }): Promise<AIScheduleCommandOutcome<'claimed'>>;
  consumeClaimed(input: {
    scheduleId: string;
    runId: string;
    consumedAt: string;
    /** consume 与 completionDisposition 必须由同一个 SQLite transaction 提交。 */
    completionDisposition: AIScheduleCompletionDisposition;
    failureCode?: string;
    firstVisibleAt?: string | null;
  }): Promise<AIScheduleCommandOutcome<'consumed'>>;
  /** 供 projection reconcile 读取全部 scheduled 真值（不依赖 owner 或时间范围）。 */
  listAllScheduled(): Promise<AISchedule[]>;
  /**
   * 读取所有尚未收口的 claim，供进程重启 / 前台恢复使用。
   * 返回值是 durable snapshot；真正收口仍必须重新用 scheduleId + runId CAS。
   */
  listAllClaimed(): Promise<AISchedule[]>;
  /**
   * 系统级 authority invalidation：owner 已不再是当前主理 AI 时终结该 schedule。
   * 与用户 / AI cancel 不同，这里不要求 `now < remindAt`，也不改写 owner identity。
   */
  terminalizeScheduledForOwnerInvalidation(input: {
    scheduleId: string;
    occurredAt: string;
  }): Promise<AIScheduleCommandOutcome<'cancelled'>>;
}
