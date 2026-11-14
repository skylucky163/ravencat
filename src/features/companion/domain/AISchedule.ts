/** 定义 AI Schedule 的持久事实、内容边界与不可逆状态机。 */
import { isAIScheduleRecurrence, type AIScheduleRecurrence } from './AIScheduleTiming';

export type AIScheduleStatus = 'scheduled' | 'claimed' | 'consumed' | 'cancelled';

/**
 * AI Schedule 执行机会的最终收口原因。
 *
 * `consumed` 表示这次 claim 已经不可再次执行；它不等价于 Agent 一定
 * 在同一个进程内正常返回。因此中断恢复必须把“未知执行结果”作为持久
 * 终态事实记录下来，避免下一次启动通过重跑来猜测业务结果。
 */
export const AI_SCHEDULE_COMPLETION_DISPOSITION_AGENT_TERMINAL = 'agent_terminal';
export const AI_SCHEDULE_COMPLETION_DISPOSITION_INTERRUPTED = 'interrupted';
export type AIScheduleCompletionDisposition =
  | typeof AI_SCHEDULE_COMPLETION_DISPOSITION_AGENT_TERMINAL
  | typeof AI_SCHEDULE_COMPLETION_DISPOSITION_INTERRUPTED;

/**
 * 系统级 authority invalidation 的终态原因。
 * 与用户 / AI 主动 cancel 不同：cancel 要求 `now < remindAt`，
 * 而 owner 不再是当前主理 AI 时由系统终结，保留原 owner identity 并记录原因。
 */
export const AI_SCHEDULE_CANCELLED_REASON_OWNER_REVOKED = 'owner_revoked';
export type AIScheduleCancelledReason = typeof AI_SCHEDULE_CANCELLED_REASON_OWNER_REVOKED
  | 'expired' | 'merged_schedule' | 'merged_chat';

/** 最迟领取时间；过期后只交接结果资料，不能重新取得自主执行机会。 */
export const AI_SCHEDULE_START_GRACE_MS = 15 * 60 * 1000;

export const AI_SCHEDULE_SUMMARY_MAX_LENGTH = 160;
export const AI_SCHEDULE_DETAILS_MAX_LENGTH = 4_000;
export const AI_SCHEDULE_SOURCE_EXCERPT_MAX_LENGTH = 2_000;
export const AI_SCHEDULE_SOURCE_MESSAGE_MAX_COUNT = 12;

export interface AISchedule {
  scheduleId: string;
  ownerAIId: string;
  remindAt: string;
  summary: string;
  details: string;
  systemCalendar: boolean;
  recurrence: AIScheduleRecurrence | null;
  seriesId: string | null;
  triggerKind: 'scheduled' | 'unanswered';
  conversationId: string | null;
  replyRevision: number | null;
  nextFollowUpMinutes: number | null;
  sourceConversationId: string | null;
  sourceMessageIds: string[] | null;
  sourceExcerpt: string | null;
  status: AIScheduleStatus;
  claimedByRunId: string | null;
  claimedAt: string | null;
  consumedAt: string | null;
  completionDisposition: AIScheduleCompletionDisposition | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AIScheduleRow {
  schedule_id: string;
  owner_ai_id: string;
  remind_at: string;
  summary: string;
  details: string;
  system_calendar: number;
  recurrence_json: string | null;
  series_id: string | null;
  trigger_kind: 'scheduled' | 'unanswered';
  conversation_id: string | null;
  reply_revision: number | null;
  next_follow_up_minutes: number | null;
  source_conversation_id: string | null;
  source_message_ids_json: string | null;
  source_excerpt: string | null;
  status: string;
  claimed_by_run_id: string | null;
  claimed_at: string | null;
  consumed_at: string | null;
  completion_disposition: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
}

const STATUSES = new Set<AIScheduleStatus>([
  'scheduled',
  'claimed',
  'consumed',
  'cancelled',
]);

type TimingFields = 'recurrence' | 'seriesId' | 'triggerKind' | 'conversationId' | 'replyRevision' | 'nextFollowUpMinutes';
export function createAISchedule(data: Omit<AISchedule, TimingFields> & Partial<Pick<AISchedule, TimingFields>>): AISchedule {
  const schedule = {
    recurrence: null,
    seriesId: null,
    triggerKind: 'scheduled' as const,
    conversationId: null,
    replyRevision: null,
    nextFollowUpMinutes: null,
    ...data,
    sourceMessageIds: data.sourceMessageIds ? [...data.sourceMessageIds] : null,
  };
  assertAISchedule(schedule);
  return schedule;
}

export function createAIScheduleFromRow(row: AIScheduleRow | null): AISchedule | null {
  if (!row) return null;
  return createAISchedule({
    scheduleId: row.schedule_id,
    ownerAIId: row.owner_ai_id,
    remindAt: row.remind_at,
    summary: row.summary,
    details: row.details,
    systemCalendar: row.system_calendar === 1,
    recurrence: row.recurrence_json ? JSON.parse(row.recurrence_json) : null,
    seriesId: row.series_id,
    triggerKind: row.trigger_kind,
    conversationId: row.conversation_id,
    replyRevision: row.reply_revision,
    nextFollowUpMinutes: row.next_follow_up_minutes,
    sourceConversationId: row.source_conversation_id,
    sourceMessageIds: parseSourceMessageIds(row.source_message_ids_json),
    sourceExcerpt: row.source_excerpt,
    status: parseStatus(row.status),
    claimedByRunId: row.claimed_by_run_id,
    claimedAt: row.claimed_at,
    consumedAt: row.consumed_at,
    completionDisposition: parseCompletionDisposition(row.completion_disposition),
    cancelledAt: row.cancelled_at,
    cancelledReason: row.cancelled_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function assertAISchedule(schedule: AISchedule): void {
  assertNonEmpty(schedule.scheduleId, 'scheduleId');
  assertNonEmpty(schedule.ownerAIId, 'ownerAIId');
  assertAbsoluteTime(schedule.remindAt, 'remindAt');
  assertAbsoluteTime(schedule.createdAt, 'createdAt');
  assertAbsoluteTime(schedule.updatedAt, 'updatedAt');
  assertOptionalAbsoluteTime(schedule.claimedAt, 'claimedAt');
  assertOptionalAbsoluteTime(schedule.consumedAt, 'consumedAt');
  assertOptionalAbsoluteTime(schedule.cancelledAt, 'cancelledAt');
  assertCompletionDisposition(schedule.completionDisposition);
  assertBoundedText(schedule.summary, 'summary', AI_SCHEDULE_SUMMARY_MAX_LENGTH);
  assertBoundedText(schedule.details, 'details', AI_SCHEDULE_DETAILS_MAX_LENGTH);
  if (schedule.recurrence && (!isAIScheduleRecurrence(schedule.recurrence) || !schedule.seriesId)) {
    throw new Error('重复日程必须保存合法规则与系列身份');
  }

  if (!STATUSES.has(schedule.status)) {
    throw new Error(`RavenCat AI Schedule 状态非法：${schedule.status}`);
  }

  const sourceFacts = [
    schedule.sourceConversationId,
    schedule.sourceMessageIds,
    schedule.sourceExcerpt,
  ];
  if (sourceFacts.some((value) => value !== null) && sourceFacts.some((value) => value === null)) {
    throw new Error('AI Schedule source snapshot 必须整体存在或整体为空');
  }
  if (schedule.sourceMessageIds) {
    assertNonEmpty(schedule.sourceConversationId!, 'sourceConversationId');
    if (
      schedule.sourceMessageIds.length === 0
      || schedule.sourceMessageIds.length > AI_SCHEDULE_SOURCE_MESSAGE_MAX_COUNT
      || new Set(schedule.sourceMessageIds).size !== schedule.sourceMessageIds.length
    ) {
      throw new Error('AI Schedule sourceMessageIds 数量或 identity 非法');
    }
    schedule.sourceMessageIds.forEach((id) => assertNonEmpty(id, 'sourceMessageId'));
    if (!schedule.sourceExcerpt?.trim() || schedule.sourceExcerpt.length > AI_SCHEDULE_SOURCE_EXCERPT_MAX_LENGTH) {
      throw new Error('AI Schedule sourceExcerpt 为空或超出上限');
    }
  }

  if (schedule.status === 'scheduled') {
    assertNoClaimOrTerminalFact(schedule);
  } else if (schedule.status === 'claimed') {
    assertClaimFact(schedule);
    if (
      schedule.consumedAt
      || schedule.completionDisposition
      || schedule.cancelledAt
      || schedule.cancelledReason
    ) {
      throw new Error('claimed AI Schedule 不得拥有终态时间或终态原因');
    }
  } else if (schedule.status === 'consumed') {
    assertClaimFact(schedule);
    if (
      !schedule.consumedAt
      || !schedule.completionDisposition
      || schedule.cancelledAt
      || schedule.cancelledReason
    ) {
      throw new Error('consumed AI Schedule 必须拥有 consumedAt 与 completionDisposition 终态事实');
    }
  } else if (
    schedule.claimedByRunId
    || schedule.claimedAt
    || schedule.consumedAt
    || schedule.completionDisposition
    || !schedule.cancelledAt
  ) {
    throw new Error('cancelled AI Schedule 不得拥有 claim/consume，且必须拥有 cancelledAt');
  } else if (
    schedule.cancelledReason !== null
    && !['owner_revoked', 'expired', 'merged_schedule', 'merged_chat'].includes(schedule.cancelledReason)
  ) {
    throw new Error('cancelled AI Schedule 的 cancelledReason 非法');
  }
}

function parseSourceMessageIds(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('SQLite AI Schedule source_message_ids_json 非法');
  }
  return parsed;
}

function parseStatus(value: string): AIScheduleStatus {
  if (!STATUSES.has(value as AIScheduleStatus)) {
    throw new Error(`RavenCat AI Schedule 状态非法：${value}`);
  }
  return value as AIScheduleStatus;
}

function parseCompletionDisposition(value: string | null): AIScheduleCompletionDisposition | null {
  if (value === null) return null;
  if (
    value !== AI_SCHEDULE_COMPLETION_DISPOSITION_AGENT_TERMINAL
    && value !== AI_SCHEDULE_COMPLETION_DISPOSITION_INTERRUPTED
  ) {
    throw new Error(`SQLite AI Schedule completion_disposition 非法：${value}`);
  }
  return value;
}

function assertNoClaimOrTerminalFact(schedule: AISchedule): void {
  if (
    schedule.claimedByRunId
    || schedule.claimedAt
    || schedule.consumedAt
    || schedule.completionDisposition
    || schedule.cancelledAt
    || schedule.cancelledReason
  ) {
    throw new Error('scheduled AI Schedule 不得拥有 claim 或终态事实');
  }
}

function assertCompletionDisposition(value: AIScheduleCompletionDisposition | null): void {
  if (
    value !== null
    && value !== AI_SCHEDULE_COMPLETION_DISPOSITION_AGENT_TERMINAL
    && value !== AI_SCHEDULE_COMPLETION_DISPOSITION_INTERRUPTED
  ) {
    throw new Error(`AI Schedule completionDisposition 非法：${value}`);
  }
}

function assertClaimFact(schedule: AISchedule): void {
  if (!schedule.claimedByRunId || !schedule.claimedAt) {
    throw new Error(`${schedule.status} AI Schedule 必须拥有 claimedByRunId 与 claimedAt`);
  }
}

function assertBoundedText(value: string, fieldName: string, maxLength: number): void {
  if (!value.trim() || value.length > maxLength) {
    throw new Error(`RavenCat AI Schedule ${fieldName} 为空或超出上限`);
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (!value.trim()) throw new Error(`RavenCat AI Schedule ${fieldName} 不能为空`);
}

function assertOptionalAbsoluteTime(value: string | null, fieldName: string): void {
  if (value !== null) assertAbsoluteTime(value, fieldName);
}

function assertAbsoluteTime(value: string, fieldName: string): void {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`RavenCat AI Schedule ${fieldName} 必须是有效绝对时间`);
  }
}
