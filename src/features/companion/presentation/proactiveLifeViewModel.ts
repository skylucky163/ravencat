/** 日历与日程详情的时间、终态及命令错误文案。 */
import type { ProactiveLifeCompletionDisposition } from '../domain/ProactiveLifeReadRepository';
import type { AIScheduleApplicationErrorCode } from '../application/AIScheduleApplication';
import type { AISchedule } from '../domain/AISchedule';


/** 将 read model 的稳定终态映射为用户可理解的历史状态。 */
export function proactiveLifeCompletionDispositionLabel(
  disposition: ProactiveLifeCompletionDisposition,
  modelResponded = false,
): string {
  const label = disposition === 'completed' ? '已执行'
    : disposition === 'unexecuted' ? '未执行'
    : disposition === 'interrupted' ? '执行因故障中断' : '执行失误';
  return modelResponded && disposition !== 'completed' ? `AI 已响应 · ${label}` : label;
}


function pad2(value: number): string {
  return String(value).padStart(2, '0');
}


/** 本地时钟时间，例如 18:32。 */
export function formatProactiveLifeClock(isoTime: string): string {
  const date = new Date(isoTime);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}


/** 详情弹层使用的完整本地时间，例如 2026年9月12日 20:00。 */
export function formatProactiveLifeFullDateTime(isoTime: string): string {
  const date = new Date(isoTime);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}


/**
 * AI Schedule 用户可理解的取消/编辑失败文案。
 * Domain 规则是最终裁决者（例如到点即不可取消），UI 只把失败 code 翻译成业务反馈。
 */
export function resolveAIScheduleCommandErrorMessage(
  code: AIScheduleApplicationErrorCode,
): string {
  switch (code) {
    case 'companion_disabled':
      return '主动伴随已关闭，日程已暂停。';
    case 'not_found':
      return '这条日程已经不存在了。';
    case 'not_owner':
      return '这条日程不属于当前主理 AI。';
    case 'not_scheduled':
    case 'already_claimed':
      return '这条日程已经在执行或已结束，无法更改。';
    case 'already_past':
      return '这条日程已经过了执行时间，无法更改。';
    case 'invalid_time':
      return '日程时间无效。';
    case 'invalid_content':
      return '日程内容无效。';
    case 'invalid_source':
      return '日程来源对话无效。';
    case 'invalid_range':
      return '查询时间范围无效。';
    case 'not_claimed':
    case 'run_mismatch':
    case 'not_due':
    case 'stale_projection':
    default:
      return '操作失败，请稍后重试。';
  }
}


/** UI 侧的取消按钮可见性预判；真正裁决仍以 cancel 命令的 Domain 错误为准。 */
export function canCancelAISchedule(
  schedule: Pick<AISchedule, 'status' | 'remindAt'>,
  now: Date,
): boolean {
  return schedule.status === 'scheduled' && Date.parse(schedule.remindAt) > now.getTime();
}
