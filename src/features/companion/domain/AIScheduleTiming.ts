/** 重复日程按保存的时区计算墙上时间；错过的期次不补跑，月底保留原始日期意图。 */
export interface AIScheduleRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  timeZone: string;
  hour: number;
  minute: number;
  weekdays?: number[];
  monthDay?: number;
  until?: string;
}

export const MIN_FOLLOW_UP_MINUTES = 2;
export const DEFAULT_FOLLOW_UP_MINUTES = 10;

export function isFollowUpInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_FOLLOW_UP_MINUTES && value <= 43_200;
}

export function isAIScheduleRecurrence(value: AIScheduleRecurrence): boolean {
  if (!value || !['daily', 'weekly', 'monthly'].includes(value.frequency)
    || typeof value.timeZone !== 'string' || !value.timeZone.trim()
    || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23
    || !Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); }
  catch { return false; }
  if (value.until !== undefined && (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.until)
    || !Number.isFinite(Date.parse(value.until)))) return false;
  return value.frequency === 'weekly'
    ? Array.isArray(value.weekdays) && value.weekdays.length > 0 && value.weekdays.length <= 7
      && new Set(value.weekdays).size === value.weekdays.length
      && value.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
    : value.frequency !== 'monthly' || (Number.isInteger(value.monthDay) && value.monthDay! >= 1 && value.monthDay! <= 31);
}

function partsAt(time: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(time);
  const number = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return { year: number('year'), month: number('month'), day: number('day'), hour: number('hour'), minute: number('minute') };
}

function wallTime(year: number, month: number, day: number, rule: AIScheduleRecurrence): number {
  const desired = Date.UTC(year, month - 1, day, rule.hour, rule.minute);
  let result = desired;
  // 时区转换只在日期计算边界执行；夏令时缺失时刻向后落在有效时间，重复时刻只取一次。
  const candidates: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const local = partsAt(result, rule.timeZone);
    const difference = desired - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    candidates.push(result);
    if (difference === 0) return result;
    result += difference;
  }
  return Math.max(...candidates);
}

/** 返回严格晚于 after 的第一期；最多查看下一年，覆盖月末与夏令时变化。 */
export function nextAIScheduleTime(rule: AIScheduleRecurrence, after: string): string | null {
  const lower = Date.parse(after);
  const local = partsAt(lower, rule.timeZone);
  for (let offset = 0; offset <= 366; offset += 1) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (rule.frequency === 'weekly' && !rule.weekdays!.includes(date.getUTCDay())) continue;
    if (rule.frequency === 'monthly' && day !== Math.min(rule.monthDay!, new Date(Date.UTC(year, month, 0)).getUTCDate())) continue;
    const candidate = wallTime(year, month, day, rule);
    if (candidate <= lower) continue;
    if (rule.until && candidate > Date.parse(rule.until)) return null;
    return new Date(candidate).toISOString();
  }
  return null;
}

export interface AIScheduleUnansweredItem {
  scheduleId: string;
  summary: string;
  firstVisibleAt: string;
}
