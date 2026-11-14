/** 主理 AI 管理自身持久日程及其系统日历关联的正常工具。 */

import { runAsCurrentHostAuthority } from '@features/assistants';
import type { AgentToolExecutionContext, AgentToolExecutionResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import {
  cancelAIScheduleWithProjection,
  createAIScheduleWithProjection,
  updateAIScheduleWithProjection,
  removeAIScheduleCalendarEvents,
} from '../application/AIScheduleProjectionOwner';
import type { AIScheduleProjectionOutcome, AIScheduleCalendarOutcome } from '../application/AIScheduleProjectionOwner';
import type { AIScheduleApplicationErrorCode } from '../application/AIScheduleApplication';
import {
  getAIScheduleQuery,
  listAISchedulesQuery,
  setAIScheduleFollowUpInterval,
} from '../application/AIScheduleApplication';
import type { AISchedule, AIScheduleStatus } from '../domain/AISchedule';
import type { AIScheduleListCursor, AIScheduleListPage, RemoveAIScheduleCalendarInput } from '../domain/AIScheduleRepository';
import type { AIScheduleRecurrence } from '../domain/AIScheduleTiming';

const recurrenceParameter = {
  type: ['object', 'null'],
  description: '固定重复规则；null 为一次性。时间按 IANA 时区与 hour/minute 计算，系统维护下一期，无需 AI 再创建。每月遇到不存在的日期落到月底。remind_at 是第一期时间，须与规则一致。',
  properties: {
    frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
    timeZone: { type: 'string', description: 'IANA 时区，例如 Asia/Shanghai' },
    hour: { type: 'integer', minimum: 0, maximum: 23 },
    minute: { type: 'integer', minimum: 0, maximum: 59 },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, minItems: 1, maxItems: 7, uniqueItems: true, description: '每周必填；0 周日，1 周一，依此类推' },
    monthDay: { type: 'integer', minimum: 1, maximum: 31, description: '每月必填，保留原始日期意图' },
    until: { type: 'string', description: '可选，带时区的结束时间（含）；不填则持续重复' },
  },
  required: ['frequency', 'timeZone', 'hour', 'minute'],
  additionalProperties: false,
} as const;

type ProjectionAwareAISchedule = AISchedule & {
  calendarStatus: AIScheduleCalendarOutcome;
  projectionStatus: AIScheduleProjectionOutcome['status'];
  projectionOperation?: Extract<
    AIScheduleProjectionOutcome,
    { status: 'projection_failed' }
  >['operation'];
};

type ToolResult<T> = Promise<AgentToolExecutionResult<T>>;

export const CreateAIScheduleTool = {
  name: 'create_ai_schedule',
  definition: {
    name: 'create_ai_schedule',
    description: '主动伴随开启时安排未来自主唤醒，默认同时写入手机系统日历提醒用户。缺少日历权限会报错且不会创建任何日程；首次遇到应告知用户可在小程序的“权限与后台运行”开启系统日历权限。用户拒绝或已表达仅内部提醒偏好时，显式设 system_calendar=false，不要反复索要权限。已有同一安排应修改，不要重复创建；日程不是预写消息，到点依据最新上下文决定行动',
    parameters: {
      type: 'object',
      properties: {
        remind_at: { type: 'string', description: '带 Z 或 UTC offset 的未来绝对时间' },
        summary: { type: 'string', description: '用于列表浏览的简短事件摘要，最多 160 字符' },
        details: { type: 'string', description: '未来理解事件所需的背景，最多 4000 字符' },
        system_calendar: { type: 'boolean', default: true, description: '默认 true：同时创建内部 AI 日程和系统日历到点提醒。用户拒绝日历授权或偏好仅内部提醒时设 false；不可因缺权限自行静默降级' },
        recurrence: recurrenceParameter,
        source_message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '可选，当前会话中确实与日程有关的 canonical 消息 identity；不要猜测 identity',
          maxItems: 12,
          uniqueItems: true,
        },
      },
      required: ['remind_at', 'summary', 'details'],
      additionalProperties: false,
    },
  },
  execute: executeCreate,
} as const;

export const ListAISchedulesTool = {
  name: 'list_ai_schedules',
  definition: {
    name: 'list_ai_schedules',
    description: '按 1 天至 3 个月的范围分页浏览自己的 AI 日程，返回 scheduleId、时间、摘要与状态。系统跳过或归并的记录属于 cancelled；用 get_ai_schedule 按 ID 查看具体原因。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '带 Z 或 UTC offset 的范围起点（含）' },
        to: { type: 'string', description: '带 Z 或 UTC offset 的范围终点（不含）' },
        status: {
          type: 'string',
          enum: ['scheduled', 'claimed', 'consumed', 'cancelled', 'all'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: {
          type: 'object',
          properties: {
            remind_at: { type: 'string' },
            schedule_id: { type: 'string' },
          },
          required: ['remind_at', 'schedule_id'],
          additionalProperties: false,
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  execute: executeList,
} as const;

export const GetAIScheduleTool = {
  name: 'get_ai_schedule',
  definition: {
    name: 'get_ai_schedule',
    description: '按 schedule_id 读取一条 AI 日程的完整详情、创建时的来源快照和 cancelledReason。expired 表示超过 15 分钟未开始，merged_schedule / merged_chat 表示已归并，不要重新唤醒或补跑。',
    parameters: idParameters(),
  },
  execute: executeGet,
} as const;

export const UpdateAIScheduleTool = {
  name: 'update_ai_schedule',
  definition: {
    name: 'update_ai_schedule',
    description: '修改尚未到期的日程（包括重复规则），保留原 ID。重复系列只修改下一期即对后续生效，已执行历史不变。只想移除系统日历事件并保留内部提醒时，使用 remove_ai_schedule_calendar_events，可处理历史和整个系列，不要取消日程。当前正在执行本日程时，可单独传 next_follow_up_minutes 调整本轮结束后的下一次未回复续轮间隔，不改变用户默认值或开关。',
    parameters: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string' },
        remind_at: { type: 'string', description: '可选，新的未来绝对时间' },
        summary: { type: 'string', description: '可选，新的简短摘要' },
        details: { type: 'string', description: '可选，新的详情' },
        system_calendar: { type: 'boolean', description: '可选，不传则保留原设置。true 同步系统日历，false 仅保留内部日程并移除关联系统事件；已有系统事件的修改或移除需要日历权限' },
        recurrence: recurrenceParameter,
        next_follow_up_minutes: { type: 'integer', minimum: 2, maximum: 43200, description: '仅对当前 run 正在执行的 schedule_id 可用；单独传此字段，从本轮结束后计时，仅调整下一次续轮。不能开启用户关闭的续轮。' },
      },
      required: ['schedule_id'],
      additionalProperties: false,
    },
  },
  execute: executeUpdate,
} as const;

export const CancelAIScheduleTool = {
  name: 'cancel_ai_schedule',
  definition: {
    name: 'cancel_ai_schedule',
    description: '取消尚未到期的 AI 日程；取消重复系列的下一期会停止整个系列后续重复，已执行历史保留。取消未回复续轮会结束当前未回复等待，不取消其他正常日程。',
    parameters: idParameters(),
  },
  execute: executeCancel,
} as const;

export const RemoveAIScheduleCalendarEventsTool = {
  name: 'remove_ai_schedule_calendar_events',
  definition: {
    name: 'remove_ai_schedule_calendar_events',
    description: '只移除自己创建的 AI 日程关联的手机系统日历事件，保留应用内日程、提醒、重复规则及历史。支持单条、整个重复系列或本人所有日程（含历史）。同时关闭所选日程的系统日历关联，整个系列后续期次保持仅应用内；不取消任何内部日程，不删除用户其他日历事件。用户要求仅应用内时优先使用此工具，不要调用 cancel_ai_schedule。之后新建日程仍须尊重用户偏好，传 system_calendar=false。缺日历权限时也先关闭关联，但旧系统事件需要恢复权限后才能移除，必须如实告知。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['schedule', 'series', 'all'], description: 'schedule 仅指定一期；series 指定日程所属整个重复系列（含历史和下一期）；all 本人所有日程关联。只有用户明确要求全部清理时使用 all。' },
        schedule_id: { type: 'string', description: 'scope 为 schedule/series 时必填，可使用历史一期的 ID；scope=all 时不传。' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  execute: executeRemoveCalendarEvents,
} as const;

async function executeRemoveCalendarEvents(
  args: { scope: RemoveAIScheduleCalendarInput['scope']; schedule_id?: string },
  context: AgentToolExecutionContext,
): ToolResult<{ matchedCount: number; updatedCount: number; removedCount: number; pendingCount: number | null; calendar: string }> {
  const authority = await authorized(context, () => removeAIScheduleCalendarEvents({
    ownerAIId: context.task.assistantId, scope: args.scope, scheduleId: args.schedule_id,
  }));
  if (authority.status === 'not_current_host') return notCurrentHost();
  const outcome = authority.value;
  if (outcome.status === 'error') return error(outcome.code);
  const data = { matchedCount: outcome.matchedCount, updatedCount: outcome.updatedCount,
    removedCount: outcome.removedCount, pendingCount: outcome.pendingCount, calendar: outcome.calendar };
  const saved = `已将 ${outcome.matchedCount} 条匹配日程设为仅应用内（本次新关闭关联 ${outcome.updatedCount} 条）；应用内提醒、重复规则和历史均保留，未取消任何内部日程。`;
  const calendar = outcome.calendar === 'synced'
    ? `已移除 ${outcome.removedCount} 条日程对应的系统日历事件；匹配日程共 ${outcome.matchedCount} 条。`
    : `内部关联已关闭，但旧系统日历事件尚未全部移除（${outcome.calendar}，本次已移除 ${outcome.removedCount} 项，待处理 ${outcome.pendingCount ?? '数量暂不可读取'}）。请如实告知用户：恢复日历权限或服务后回到应用同步，或再次调用本工具；不要取消内部日程来代替清理，也不要声称系统日历已经清空。`;
  return { status: 'success', data, modelContent: `${saved}\n${calendar}\n若用户希望以后新建也只在应用内提醒，创建时显式传 system_calendar=false。` };
}

interface CreateArgs {
  remind_at: string;
  summary: string;
  details: string;
  system_calendar?: boolean;
  recurrence?: AIScheduleRecurrence | null;
  source_message_ids?: string[];
}

async function executeCreate(
  args: CreateArgs,
  context: AgentToolExecutionContext,
): ToolResult<ProjectionAwareAISchedule> {
  const sourceConversationId = args.source_message_ids ? context.task.sessionId : undefined;
  if (args.source_message_ids && !sourceConversationId) return error('invalid_source');
  const authority = await authorized(context, () => createAIScheduleWithProjection({
    ownerAIId: context.task.assistantId,
    remindAt: args.remind_at,
    recurrence: args.recurrence,
    summary: args.summary,
    details: args.details,
    systemCalendar: args.system_calendar ?? true,
    sourceConversationId: sourceConversationId ?? undefined,
    sourceMessageIds: args.source_message_ids,
  }));
  if (authority.status === 'not_current_host') return notCurrentHost();
  const outcome = authority.value;
  if (outcome.status === 'error') return error(outcome.code);
  return mapProjectionAwareSuccess(outcome.schedule, outcome.projection, outcome.calendar, 'saved');
}

interface ListArgs {
  from: string;
  to: string;
  status?: AIScheduleStatus | 'all';
  limit?: number;
  cursor?: { remind_at: string; schedule_id: string };
}

async function executeList(
  args: ListArgs,
  context: AgentToolExecutionContext,
): ToolResult<AIScheduleListPage> {
  const after: AIScheduleListCursor | null = args.cursor
    ? { remindAt: args.cursor.remind_at, scheduleId: args.cursor.schedule_id }
    : null;
  const authority = await authorized(context, () => listAISchedulesQuery({
    ownerAIId: context.task.assistantId,
    from: args.from,
    to: args.to,
    status: args.status === 'all' ? undefined : args.status,
    limit: args.limit,
    after,
  }));
  if (authority.status === 'not_current_host') return notCurrentHost();
  const outcome = authority.value;
  if (outcome.status === 'error') return error(outcome.code);
  return {
    status: 'success',
    data: outcome.page,
    modelContent: JSON.stringify(outcome.page),
  };
}

async function executeGet(
  args: { schedule_id: string },
  context: AgentToolExecutionContext,
): ToolResult<AISchedule> {
  const authority = await authorized(context, () => getAIScheduleQuery({
    scheduleId: args.schedule_id,
    ownerAIId: context.task.assistantId,
  }));
  if (authority.status === 'not_current_host') return notCurrentHost();
  const outcome = authority.value;
  if (outcome.status === 'error') return error(outcome.code);
  return { status: 'success', data: outcome.schedule, modelContent: JSON.stringify(outcome.schedule) };
}

interface UpdateArgs {
  schedule_id: string;
  remind_at?: string;
  summary?: string;
  details?: string;
  system_calendar?: boolean;
  recurrence?: AIScheduleRecurrence | null;
  next_follow_up_minutes?: number;
}

async function executeUpdate(
  args: UpdateArgs,
  context: AgentToolExecutionContext,
): ToolResult<ProjectionAwareAISchedule | { scheduleId: string; nextFollowUpMinutes: number }> {
  if (args.next_follow_up_minutes !== undefined) {
    if (args.remind_at !== undefined || args.summary !== undefined || args.details !== undefined
      || args.system_calendar !== undefined || args.recurrence !== undefined) return error('invalid_content');
    const authority = await authorized(context, () => setAIScheduleFollowUpInterval({
      scheduleId: args.schedule_id, ownerAIId: context.task.assistantId,
      runId: context.runId, minutes: args.next_follow_up_minutes!,
    }));
    if (authority.status === 'not_current_host') return notCurrentHost();
    const outcome = authority.value;
    if (outcome.status === 'error') return error(outcome.code);
    return { status: 'success', data: { scheduleId: outcome.schedule.scheduleId, nextFollowUpMinutes: args.next_follow_up_minutes },
      modelContent: `下一次未回复续轮间隔已设为 ${args.next_follow_up_minutes} 分钟，从本轮结束后计算；只有用户已开启续轮且仍未回复时才生效。用户默认值和系统日历未改变。` };
  }
  const authority = await authorized(context, () => updateAIScheduleWithProjection({
    scheduleId: args.schedule_id,
    ownerAIId: context.task.assistantId,
    remindAt: args.remind_at,
    summary: args.summary,
    details: args.details,
    systemCalendar: args.system_calendar,
    recurrence: args.recurrence,
  }));
  if (authority.status === 'not_current_host') return notCurrentHost();
  const outcome = authority.value;
  if (outcome.status === 'error') return error(outcome.code);
  return mapProjectionAwareSuccess(outcome.schedule, outcome.projection, outcome.calendar, 'updated');
}

async function executeCancel(
  args: { schedule_id: string },
  context: AgentToolExecutionContext,
): ToolResult<ProjectionAwareAISchedule> {
  const authority = await authorized(context, () => cancelAIScheduleWithProjection({
    scheduleId: args.schedule_id,
    ownerAIId: context.task.assistantId,
  }));
  if (authority.status === 'not_current_host') return notCurrentHost();
  const outcome = authority.value;
  if (outcome.status === 'error') return error(outcome.code);
  return mapProjectionAwareSuccess(outcome.schedule, outcome.projection, outcome.calendar, 'cancelled');
}

function mapProjectionAwareSuccess(
  schedule: AISchedule,
  projection: AIScheduleProjectionOutcome,
  calendar: AIScheduleCalendarOutcome,
  operation: 'saved' | 'updated' | 'cancelled',
): AgentToolExecutionResult<ProjectionAwareAISchedule> {
  const projectionOperation = projection.status === 'projection_failed'
    ? projection.operation
    : undefined;
  const data: ProjectionAwareAISchedule = {
    ...schedule,
    calendarStatus: calendar,
    projectionStatus: projection.status,
    ...(projectionOperation ? { projectionOperation } : {}),
  };
  const durableFact = operation === 'cancelled'
    ? `AI 日程已取消，历史记录仍保留。\nscheduleId = ${schedule.scheduleId}`
    : `AI 日程已${operation === 'saved' ? '保存' : '更新'}。\nscheduleId = ${schedule.scheduleId}\nremindAt = ${schedule.remindAt}`;
  const calendarFact = calendar === 'internal_only' ? '本次只安排内部 AI 日程，不请求写入系统日历。'
    : calendar === 'synced' ? (operation === 'cancelled' || !schedule.systemCalendar ? '关联系统日历事件已移除。' : '系统日历事件和到点提醒已同步。')
    : operation === 'cancelled' || !schedule.systemCalendar
      ? `内部操作已提交，但系统日历事件尚未移除（${calendar}），手机日历仍可能提醒用户。请明确告知用户，恢复权限或日历服务后回到应用同步，也可在系统日历手动删除。不要声称系统提醒已取消，不要重新创建日程。`
      : `系统日历未同步（${calendar}）；内部操作已提交。请明确告知用户系统提醒尚未得到保证，不要重复创建日程。可恢复权限后等待同步或修改同一 scheduleId。`;
  if (projection.status === 'projection_failed') {
    return {
      status: 'success',
      data,
      modelContent: `${durableFact}\n${calendarFact}\n业务事实已持久化，但 native projection 暂时失败，后台会自动恢复；不要重复${operation === 'saved' ? '创建' : operation === 'updated' ? '更新' : '取消'}这条日程。`,
    };
  }
  return {
    status: 'success',
    data,
    modelContent: `${durableFact}\n${calendarFact}\nnative projection = ${projection.status}`,
  };
}

function authorized<T>(context: AgentToolExecutionContext, action: () => Promise<T>) {
  return runAsCurrentHostAuthority(context.task.assistantId, async () => {
    throwIfAbortSignalAborted(context.abortSignal);
    return action();
  });
}

function idParameters() {
  return {
    type: 'object',
    properties: { schedule_id: { type: 'string' } },
    required: ['schedule_id'],
    additionalProperties: false,
  } as const;
}

function notCurrentHost<T>(): AgentToolExecutionResult<T> {
  return {
    status: 'error',
    code: 'NOT_CURRENT_HOST',
    retryable: false,
    modelContent: '当前 AI 已不再是主理 AI，不能访问或修改 AI Schedule。',
  };
}

type ScheduleToolErrorCode = AIScheduleApplicationErrorCode | 'calendar_permission_required' | 'calendar_unavailable';

function error<T>(code: ScheduleToolErrorCode): AgentToolExecutionResult<T> {
  const messages: Record<ScheduleToolErrorCode, string> = {
    calendar_permission_required: '缺少系统日历读写权限，本次没有创建或修改任何日程。请告知用户可在小程序 → 权限与后台运行 → 系统日历开启。用户拒绝或偏好仅内部提醒时，创建日程显式传 system_calendar=false；尊重已有偏好，不反复索要权限。已有系统事件改期或移除也需要此权限。',
    calendar_unavailable: '系统日历当前不可用，或没有支持到点提醒的可写日历，本次没有创建或修改任何日程。请告知用户；用户接受仅内部提醒时，创建日程显式传 system_calendar=false。',
    companion_disabled: '主动伴随当前已关闭，不能新建、修改或执行 AI 日程；已有计划暂停保留。',
    not_found: '没有找到这条 AI 日程。',
    not_owner: '这条 AI 日程不属于当前主理 AI。',
    not_scheduled: '这条 AI 日程已进入不可修改的历史状态。',
    not_claimed: '这条 AI 日程当前未被 claim，不能 consume。',
    already_past: '这条日程的原 remindAt 已经到达，过去的时间事实不能再更新或取消。',
    invalid_time: '时间必须是带 Z 或 UTC offset 的有效未来绝对时间；重复规则须使用合法 IANA 时区，第一期时间与规则一致且不晚于 until。调整续轮间隔时必须为 2 至 43200 分钟的整数。',
    invalid_range: '查询范围必须至少 1 天、最多 3 个月，且分页参数必须有效。',
    invalid_source: '来源消息不存在、不属于当前会话，或不是可保存的 canonical user/assistant 消息。',
    invalid_content: '日程内容为空、超出长度上限或未提供修改；移除日历关联时，scope 必须为 schedule/series/all，schedule/series 需要有效 schedule_id，all 不传 schedule_id。',
    already_claimed: '这条 AI 日程已经被另一个 run claim，本次没有取得执行权。',
    already_terminal: '这条 AI 日程已经完成或进入终态，本次不会重复收口。',
    run_mismatch: '当前 run 不是这条 AI 日程的 claim owner。',
    not_due: '这条 AI 日程的 remindAt 尚未到达，本次 callback 过早，不执行。',
    stale_projection: '本次 callback 对应的是已被更新/取消的旧版本日程，不执行。',
  };
  return {
    status: 'error',
    code: code.toUpperCase(),
    retryable: code === 'invalid_time' || code === 'invalid_range' || code === 'invalid_content',
    modelContent: messages[code],
  };
}
