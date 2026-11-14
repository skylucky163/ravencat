/** AI Schedule 的 read/write 用例；SQLite Repository 是状态与时间竞态的最终 owner。 */

import type {
  CanonicalChatSourceMessage,
  ResolveCanonicalChatSourceMessagesOutcome,
} from '@features/chat';
import {
  AI_SCHEDULE_DETAILS_MAX_LENGTH,
  AI_SCHEDULE_SOURCE_EXCERPT_MAX_LENGTH,
  AI_SCHEDULE_SOURCE_MESSAGE_MAX_COUNT,
  AI_SCHEDULE_SUMMARY_MAX_LENGTH,
  createAISchedule,
  type AISchedule,
  type AIScheduleCompletionDisposition,
  type AIScheduleStatus,
} from '../domain/AISchedule';
import type {
  AIScheduleCommandErrorCode,
  AIScheduleListCursor,
  AIScheduleListPage,
  AIScheduleRepository,
  RemoveAIScheduleCalendarInput,
} from '../domain/AIScheduleRepository';
import { getCompanionRuntimeDependencies } from './CompanionRuntimeDependencies';
import { isAIScheduleRecurrence, isFollowUpInterval, nextAIScheduleTime, type AIScheduleRecurrence } from '../domain/AIScheduleTiming';

export type AIScheduleApplicationErrorCode = AIScheduleCommandErrorCode
  | 'invalid_content'
  | 'invalid_source'
  | 'invalid_range';

export type AIScheduleApplicationOutcome<TStatus extends string, TValue extends object> =
  | ({ status: TStatus } & TValue)
  | { status: 'error'; code: AIScheduleApplicationErrorCode };

export interface AIScheduleApplicationDependencies {
  schedules: AIScheduleRepository;
  resolveSourceMessages(input: {
    conversationId: string;
    messageIds: string[];
  }): Promise<ResolveCanonicalChatSourceMessagesOutcome>;
  generateScheduleId(): string;
  now(): Date;
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

export interface ListAISchedulesQuery {
  ownerAIId: string;
  from: string;
  to: string;
  status?: AIScheduleStatus;
  after?: AIScheduleListCursor | null;
  limit?: number;
}

export interface UpdateAIScheduleCommand {
  scheduleId: string;
  ownerAIId: string;
  remindAt?: string;
  summary?: string;
  details?: string;
  systemCalendar?: boolean;
  recurrence?: AIScheduleRecurrence | null;
}

const MIN_RANGE_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_MS = 92 * MIN_RANGE_MS;
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 50;

export class AIScheduleApplication {
  constructor(private readonly dependencies: AIScheduleApplicationDependencies) {}

  async removeCalendarLinks(input: RemoveAIScheduleCalendarInput): Promise<
    AIScheduleApplicationOutcome<'updated', { scheduleIds: string[]; updatedCount: number }>
  > {
    if (!['schedule', 'series', 'all'].includes(input.scope)
      || (input.scope === 'all' ? input.scheduleId !== undefined : !input.scheduleId?.trim())) {
      return { status: 'error', code: 'invalid_content' };
    }
    const outcome = await this.dependencies.schedules.removeCalendarLinks(input);
    return outcome.status === 'updated' ? outcome : { status: 'error', code: outcome.status };
  }

  async create(
    input: CreateAIScheduleInput,
  ): Promise<AIScheduleApplicationOutcome<'created', { schedule: AISchedule }>> {
    const content = normalizeContent(input.summary, input.details);
    if (!content) return { status: 'error', code: 'invalid_content' };
    if (!input.ownerAIId.trim()) return { status: 'error', code: 'not_owner' };

    const source = await this.resolveSourceSnapshot(input);
    if (source === 'invalid_source') return { status: 'error', code: 'invalid_source' };
    // source resolve 可能经过 SQLite 调度；创建时的“未来”必须以真正提交前的当前时间裁决。
    const occurredAt = this.dependencies.now().toISOString();
    const remindAt = normalizeFutureTime(input.remindAt, occurredAt);
    if (!remindAt) return { status: 'error', code: 'invalid_time' };
    if (input.recurrence && !isAIScheduleRecurrence(input.recurrence)) return { status: 'error', code: 'invalid_time' };
    if (input.recurrence && nextAIScheduleTime(input.recurrence, new Date(Date.parse(remindAt) - 1).toISOString()) !== remindAt) {
      return { status: 'error', code: 'invalid_time' };
    }
    const scheduleId = this.dependencies.generateScheduleId();
    const schedule = createAISchedule({
      scheduleId,
      ownerAIId: input.ownerAIId,
      remindAt,
      summary: content.summary,
      details: content.details,
      systemCalendar: input.systemCalendar ?? false,
      recurrence: input.recurrence ?? null,
      seriesId: input.recurrence ? scheduleId : null,
      sourceConversationId: source?.conversationId ?? null,
      sourceMessageIds: source?.messageIds ?? null,
      sourceExcerpt: source?.excerpt ?? null,
      status: 'scheduled',
      claimedByRunId: null,
      claimedAt: null,
      consumedAt: null,
      completionDisposition: null,
      cancelledAt: null,
      cancelledReason: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    const outcome = await this.dependencies.schedules.createScheduled(schedule, occurredAt);
    return outcome.status === 'created'
      ? { status: 'created', schedule: outcome.schedule }
      : { status: 'error', code: outcome.status };
  }

  async list(
    query: ListAISchedulesQuery,
  ): Promise<AIScheduleApplicationOutcome<'listed', { page: AIScheduleListPage }>> {
    const range = normalizeRange(query.from, query.to);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    if (
      !range
      || (query.status !== undefined && !isAIScheduleStatus(query.status))
      || !Number.isInteger(limit)
      || limit < 1
      || limit > MAX_LIST_LIMIT
      || (query.after && (
        !isAbsoluteTime(query.after.remindAt) || !query.after.scheduleId.trim()
      ))
    ) {
      return { status: 'error', code: 'invalid_range' };
    }
    const page = await this.dependencies.schedules.list({
      ownerAIId: query.ownerAIId,
      from: range.from,
      to: range.to,
      status: query.status,
      after: query.after
        ? {
            remindAt: new Date(query.after.remindAt).toISOString(),
            scheduleId: query.after.scheduleId,
          }
        : null,
      limit,
    });
    return { status: 'listed', page };
  }

  async get(input: {
    scheduleId: string;
    ownerAIId: string;
  }): Promise<AIScheduleApplicationOutcome<'found', { schedule: AISchedule }>> {
    const schedule = await this.dependencies.schedules.getByScheduleId(input.scheduleId);
    if (!schedule) return { status: 'error', code: 'not_found' };
    if (schedule.ownerAIId !== input.ownerAIId) return { status: 'error', code: 'not_owner' };
    return { status: 'found', schedule };
  }

  async update(
    input: UpdateAIScheduleCommand,
  ): Promise<AIScheduleApplicationOutcome<'updated', { schedule: AISchedule }>> {
    const occurredAt = this.dependencies.now().toISOString();
    if (input.remindAt === undefined && input.summary === undefined && input.details === undefined && input.systemCalendar === undefined && input.recurrence === undefined) {
      return { status: 'error', code: 'invalid_content' };
    }
    if (input.recurrence && !isAIScheduleRecurrence(input.recurrence)) return { status: 'error', code: 'invalid_time' };
    const remindAt = input.remindAt === undefined
      ? input.recurrence ? nextAIScheduleTime(input.recurrence, occurredAt) : undefined
      : normalizeFutureTime(input.remindAt, occurredAt);
    if (input.recurrence && (!remindAt || nextAIScheduleTime(input.recurrence,
      new Date(Date.parse(remindAt) - 1).toISOString()) !== remindAt)) return { status: 'error', code: 'invalid_time' };
    if (input.remindAt !== undefined && !remindAt) {
      return { status: 'error', code: 'invalid_time' };
    }
    const summary = input.summary === undefined
      ? undefined
      : normalizeText(input.summary, AI_SCHEDULE_SUMMARY_MAX_LENGTH);
    const details = input.details === undefined
      ? undefined
      : normalizeText(input.details, AI_SCHEDULE_DETAILS_MAX_LENGTH);
    if (
      (input.summary !== undefined && summary === null)
      || (input.details !== undefined && details === null)
    ) {
      return { status: 'error', code: 'invalid_content' };
    }
    const outcome = await this.dependencies.schedules.updateScheduled({
      scheduleId: input.scheduleId,
      ownerAIId: input.ownerAIId,
      occurredAt,
      remindAt,
      summary: summary ?? undefined,
      details: details ?? undefined,
      systemCalendar: input.systemCalendar,
      recurrence: input.recurrence,
    });
    return outcome.status === 'updated'
      ? { status: 'updated', schedule: outcome.schedule }
      : { status: 'error', code: outcome.status };
  }

  async cancel(input: {
    scheduleId: string;
    ownerAIId: string;
  }): Promise<AIScheduleApplicationOutcome<'cancelled', { schedule: AISchedule }>> {
    const outcome = await this.dependencies.schedules.cancelScheduled({
      ...input,
      occurredAt: this.dependencies.now().toISOString(),
    });
    return outcome.status === 'cancelled'
      ? { status: 'cancelled', schedule: outcome.schedule }
      : { status: 'error', code: outcome.status };
  }

  async claim(input: {
    scheduleId: string;
    ownerAIId: string;
    runId: string;
    claimedAt: string;
    expectedRemindAt: string;
    projectionToken: string;
    conversationId: string;
  }): Promise<AIScheduleApplicationOutcome<'claimed', { schedule: AISchedule }>> {
    if (!isAbsoluteTime(input.claimedAt) || !isAbsoluteTime(input.expectedRemindAt)) {
      return { status: 'error', code: 'invalid_time' };
    }
    const outcome = await this.dependencies.schedules.claimScheduled({
      ...input,
      claimedAt: new Date(input.claimedAt).toISOString(),
      expectedRemindAt: new Date(input.expectedRemindAt).toISOString(),
    });
    return outcome.status === 'claimed'
      ? { status: 'claimed', schedule: outcome.schedule }
      : { status: 'error', code: outcome.status };
  }

  async consume(input: {
    scheduleId: string;
    runId: string;
    consumedAt: string;
    completionDisposition: AIScheduleCompletionDisposition;
    failureCode?: string;
    firstVisibleAt?: string | null;
  }): Promise<AIScheduleApplicationOutcome<'consumed', { schedule: AISchedule }>> {
    if (!isAbsoluteTime(input.consumedAt)) return { status: 'error', code: 'invalid_time' };
    const outcome = await this.dependencies.schedules.consumeClaimed({
      ...input,
      consumedAt: new Date(input.consumedAt).toISOString(),
    });
    return outcome.status === 'consumed'
      ? { status: 'consumed', schedule: outcome.schedule }
      : { status: 'error', code: outcome.status };
  }

  private async resolveSourceSnapshot(input: CreateAIScheduleInput): Promise<{
    conversationId: string;
    messageIds: string[];
    excerpt: string;
  } | 'invalid_source' | null> {
    if (!input.sourceMessageIds) return null;
    if (
      !input.sourceConversationId?.trim()
      || input.sourceMessageIds.length === 0
      || input.sourceMessageIds.length > AI_SCHEDULE_SOURCE_MESSAGE_MAX_COUNT
      || new Set(input.sourceMessageIds).size !== input.sourceMessageIds.length
    ) {
      return 'invalid_source';
    }
    const outcome = await this.dependencies.resolveSourceMessages({
      conversationId: input.sourceConversationId,
      messageIds: input.sourceMessageIds,
    });
    if (outcome.status !== 'resolved') return 'invalid_source';
    const excerpt = buildSourceExcerpt(outcome.messages);
    if (!excerpt) return 'invalid_source';
    return {
      conversationId: input.sourceConversationId,
      messageIds: outcome.messages.map((message) => message.messageId),
      excerpt,
    };
  }
}

function normalizeContent(summary: string, details: string) {
  const normalizedSummary = normalizeText(summary, AI_SCHEDULE_SUMMARY_MAX_LENGTH);
  const normalizedDetails = normalizeText(details, AI_SCHEDULE_DETAILS_MAX_LENGTH);
  return normalizedSummary && normalizedDetails
    ? { summary: normalizedSummary, details: normalizedDetails }
    : null;
}

function normalizeText(value: string, maxLength: number): string | null {
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeFutureTime(value: string, occurredAt: string): string | null {
  if (!isAbsoluteTime(value)) return null;
  const normalized = new Date(value).toISOString();
  return Date.parse(normalized) > Date.parse(occurredAt) ? normalized : null;
}

function normalizeRange(from: string, to: string): { from: string; to: string } | null {
  if (!isAbsoluteTime(from) || !isAbsoluteTime(to)) return null;
  const fromTime = new Date(from).toISOString();
  const toTime = new Date(to).toISOString();
  const duration = Date.parse(toTime) - Date.parse(fromTime);
  return duration >= MIN_RANGE_MS && duration <= MAX_RANGE_MS
    ? { from: fromTime, to: toTime }
    : null;
}

function isAbsoluteTime(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}

function isAIScheduleStatus(value: string): value is AIScheduleStatus {
  return value === 'scheduled'
    || value === 'claimed'
    || value === 'consumed'
    || value === 'cancelled';
}

function buildSourceExcerpt(messages: CanonicalChatSourceMessage[]): string {
  const excerpt = messages.map((message) => (
    `${message.role === 'user' ? '用户' : 'AI'}：${message.text.trim()}`
  )).join('\n');
  return excerpt.length <= AI_SCHEDULE_SOURCE_EXCERPT_MAX_LENGTH
    ? excerpt
    : `${excerpt.slice(0, AI_SCHEDULE_SOURCE_EXCERPT_MAX_LENGTH - 1)}…`;
}

const aiScheduleApplication = new AIScheduleApplication({
  get schedules() {
    return getCompanionRuntimeDependencies().repositories.aiSchedules;
  },
  resolveSourceMessages: (input) => (
    getCompanionRuntimeDependencies().chat.resolveCanonicalSourceMessages(input)
  ),
  generateScheduleId: () => getCompanionRuntimeDependencies().generateAIScheduleId(),
  now: () => new Date(),
});

export const createAIScheduleCommand = (input: CreateAIScheduleInput) => aiScheduleApplication.create(input);
export const listAISchedulesQuery = (input: ListAISchedulesQuery) => aiScheduleApplication.list(input);
export const getAIScheduleQuery = (input: { scheduleId: string; ownerAIId: string }) => (
  aiScheduleApplication.get(input)
);
export const updateAIScheduleCommand = (input: UpdateAIScheduleCommand) => aiScheduleApplication.update(input);
export const removeAIScheduleCalendarLinksCommand = (input: RemoveAIScheduleCalendarInput) => aiScheduleApplication.removeCalendarLinks(input);
export const cancelAIScheduleCommand = (input: { scheduleId: string; ownerAIId: string }) => (
  aiScheduleApplication.cancel(input)
);
export const claimAIScheduleCommand = (input: {
  scheduleId: string;
  ownerAIId: string;
  runId: string;
  claimedAt: string;
  expectedRemindAt: string;
  projectionToken: string;
  conversationId: string;
}) => aiScheduleApplication.claim(input);
export const consumeAIScheduleCommand = (input: {
  scheduleId: string;
  runId: string;
  consumedAt: string;
  completionDisposition: AIScheduleCompletionDisposition;
  failureCode?: string;
  firstVisibleAt?: string | null;
}) => aiScheduleApplication.consume(input);

export async function setAIScheduleFollowUpInterval(input: { scheduleId: string; ownerAIId: string; runId: string; minutes: number }) {
  if (!isFollowUpInterval(input.minutes)) return { status: 'error' as const, code: 'invalid_time' as const };
  const result = await getCompanionRuntimeDependencies().repositories.aiSchedules.setNextFollowUpInterval(input);
  return result.status === 'updated' ? result : { status: 'error' as const, code: result.status };
}
