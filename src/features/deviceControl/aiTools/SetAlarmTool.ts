/** 主理身份由 authority 裁决；闹钟的保存、响铃和后续管理归系统时钟。 */
import { runAsCurrentHostAuthority } from '@features/assistants';
import { setSystemAlarm, showSystemAlarms, dismissSystemAlarm, snoozeSystemAlarm, getNextSystemAlarm } from '@platform/device';
import type { SystemAlarmTarget } from '@platform/device';
import type { ToolContext, ToolExecuteResult, JsonSchema, ToolDefinition } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

export interface SetAlarmArgs {
  hour: number;
  minute: number;
  label?: string;
  days_of_week?: number[];
}

export const definition = {
  name: 'set_alarm',
  description: '向系统时钟提交设置闹钟请求，使用手机本地时间。不能指定日期：目标日期不是下一次该时分时不要用它冒充。系统没有保存回执，提交后不要自动重试，确认界面由用户处理。',
  parameters: {
    type: 'object',
    properties: {
      hour: { type: 'integer', minimum: 0, maximum: 23, description: '小时（0–23）。' },
      minute: { type: 'integer', minimum: 0, maximum: 59, description: '分钟（0–59）。' },
      label: { type: 'string', minLength: 1, maxLength: 120, description: '提供给系统时钟的闹钟名称，例如“起床”或“吃药”。' },
      days_of_week: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: 7 },
        uniqueItems: true,
        maxItems: 7,
        description: '每周重复日：1=周一，2=周二，…，7=周日，例如工作日为 [1,2,3,4,5]。省略或空数组表示一次性闹钟。',
      },
    },
    required: ['hour', 'minute'],
    additionalProperties: false,
  },
} as const;

const FAILURE_MESSAGES = {
  app_not_focused: '本次闹钟请求未派发。请回到 RavenCat 页面后再试。',
  clock_app_unavailable: '手机没有能接收这项请求的时钟应用，本次未执行。',
  alarm_request_rejected: 'Android 拒绝了这次闹钟请求，请检查系统时钟与应用权限。',
} as const;

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 系统只给触发时刻，按设备本地时间呈现，避免模型换算错时区。 */
function formatLocalDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export async function execute(args: SetAlarmArgs, context: ToolContext): Promise<ToolExecuteResult> {
  const actorAiId = context.getAIId();
  if (!actorAiId) return { success: false, error: 'missing_actor_ai_id: 未识别到当前 AI 身份' };
  const authority = await runAsCurrentHostAuthority(actorAiId, async () => {
    throwIfAbortSignalAborted(context.abortSignal);
    const result = await setSystemAlarm({
      hour: args.hour,
      minute: args.minute,
      label: args.label,
      daysOfWeek: args.days_of_week,
    });
    if (result.status !== 'alarm_request_dispatched') return {
      success: false, error: `${result.status}: ${FAILURE_MESSAGES[result.status]}`,
    };
    const clock = formatClock(args.hour, args.minute);
    const repeat = args.days_of_week && args.days_of_week.length > 0
      ? `，重复日 ${args.days_of_week.join(',')}` : '，一次性';
    return {
      success: true,
      message: `已向系统时钟提交 ${clock} 的闹钟${repeat}。`,
      data: { ...result, ...args },
    };
  });
  if (authority.status === 'not_current_host') return {
    success: false, error: 'not_current_host: 当前 AI 已不再是主理 AI',
  };
  return authority.value;
}

export const SetAlarmTool = { name: definition.name, definition, execute };

const emptyParameters = { type: 'object', properties: {}, additionalProperties: false } as const;

/** 各公开动作共用主理裁决；schema 是参数唯一校验边界。 */
function createAlarmTool<T>(name: string, description: string, parameters: ToolDefinition['parameters'] & { oneOf?: JsonSchema[] },
  action: (args: T) => Promise<ToolExecuteResult>) {
  return { name, definition: { name, description, parameters },
    async execute(args: T, context: ToolContext): Promise<ToolExecuteResult> {
      const actor = context.getAIId();
      if (!actor) return { success: false, error: 'missing_actor_ai_id: 未识别到当前 AI 身份' };
      const authority = await runAsCurrentHostAuthority(actor, async () => {
        throwIfAbortSignalAborted(context.abortSignal);
        return action(args);
      });
      return authority.status === 'not_current_host'
        ? { success: false, error: 'not_current_host: 当前 AI 已不再是主理 AI' } : authority.value;
    },
  };
}

function dispatchResult(result: Awaited<ReturnType<typeof showSystemAlarms>>, message: string): ToolExecuteResult {
  return result.status === 'alarm_request_dispatched'
    ? { success: true, data: result, message: `${message}系统没有完成回执，若出现选择或确认界面由用户处理；不要重试。` }
    : { success: false, error: `${result.status}: ${FAILURE_MESSAGES[result.status]}` };
}

export const ShowAlarmsTool = createAlarmTool<Record<string, never>>('show_alarms',
  '打开系统时钟的闹钟页面，供用户自己查看或管理。只打开页面，不读取也不返回列表。',
  emptyParameters, async () => dispatchResult(await showSystemAlarms(), '已请求打开系统闹钟页面，没有读取列表。'));

export const DismissAlarmTool = createAlarmTool<SystemAlarmTarget>('dismiss_alarm',
  '请求取消闹钟的下一次响铃：一次性闹钟会停用，重复闹钟只跳过下一次，不会删除或永久关闭。用 mode 定位目标，多条命中时系统可能让用户选择。工具只返回派发状态。',
  { type: 'object', properties: {
    mode: { type: 'string', enum: ['next', 'all', 'time', 'label'], description: '定位方式：next=当前响铃或下一条，all=全部，time=最接近的指定时分，label=名称包含。' },
    hour: { type: 'integer', minimum: 0, maximum: 23, description: 'time 模式必填，手机本地 24 小时制。' },
    minute: { type: 'integer', minimum: 0, maximum: 59, description: 'time 模式必填，分钟（0–59）。' },
    label: { type: 'string', minLength: 1, maxLength: 120, description: 'label 模式必填，闹钟名称中包含的文字。' },
  }, required: ['mode'], additionalProperties: false, oneOf: [
    { properties: { mode: { enum: ['next', 'all'] } }, required: ['mode'], additionalProperties: false },
    { properties: { mode: { const: 'time' }, hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 } }, required: ['mode', 'hour', 'minute'], additionalProperties: false },
    { properties: { mode: { const: 'label' }, label: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['mode', 'label'], additionalProperties: false },
  ] }, async args => dispatchResult(await dismissSystemAlarm(args), '已请求取消下一次响铃：一次性停用，重复仅跳过下一次，不会删除闹钟。'));

export const SnoozeAlarmTool = createAlarmTool<{ minutes?: number }>('snooze_alarm',
  '请求稍后再响当前正在响铃的闹钟。仅影响本次响铃，工具只返回派发状态。',
  { type: 'object', properties: { minutes: { type: 'integer', minimum: 1, maximum: 2147483647, description: '本次延后分钟数；省略使用系统时钟默认值。' } }, additionalProperties: false },
  async args => dispatchResult(await snoozeSystemAlarm(args.minutes), '已请求稍后再响当前闹钟；没有正在响铃的闹钟时不会产生操作。'));

export const GetNextAlarmTool = createAlarmTool<Record<string, never>>('get_next_alarm',
  '查询下一个已登记的闹钟触发时间，可能由任意应用登记。只返回一个时间点，没有名称、重复规则、ID 或完整列表；查不到不代表时钟里没有停用或未登记的闹钟。可直接查询，不需要打开时钟。',
  emptyParameters, async () => {
    const snapshot = await getNextSystemAlarm();
    return { success: true, data: snapshot, message: snapshot.status === 'available'
      ? `下一个闹钟：${formatLocalDateTime(snapshot.triggerAtEpochMs)}（手机本地时间）。`
      : '系统当前没有下一条已登记的闹钟。' };
  });
