/** 日期编号只表达本地日历坐标；查询边界仍按本地午夜生成，兼容夏令时的非 24 小时日。 */
import type { ProactiveLifeDayRange } from '../application/ProactiveLifeReadQueries';

const DAY_MS = 86_400_000;
export const CALENDAR_NODE_COUNT = 9;

export function calendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

export function calendarDate(day: number): Date { return new Date(day * DAY_MS); }
export function calendarDayKey(day: number): string { return calendarDate(day).toISOString().slice(0, 10); }

export function calendarDayRange(day: number): ProactiveLifeDayRange {
  const date = calendarDate(day);
  const year = date.getUTCFullYear(), month = date.getUTCMonth(), dateNumber = date.getUTCDate();
  return { key: calendarDayKey(day), from: new Date(year, month, dateNumber).toISOString(), until: new Date(year, month, dateNumber + 1).toISOString() };
}

export function calendarWindow(day: number): ProactiveLifeDayRange[] {
  return Array.from({ length: CALENDAR_NODE_COUNT }, (_, index) => calendarDayRange(day + index - 4));
}

/** 日期输入是用户边界，不接受被 Date 自动纠正的二月三十日等输入。 */
export function parseCalendarDay(value: string): number | null {
  const key = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  const valueAt = Date.UTC(year, month - 1, day) / DAY_MS;
  return Number.isFinite(valueAt) && calendarDayKey(valueAt) === key ? valueAt : null;
}

export function fragmentMaterialIndex(day: number, count: number): number {
  const mod = (value: number) => ((value % count) + count) % count;
  const block = Math.floor(day / count);
  // 周期边界只前移两到三个位置；十四种素材在任意九日窗口内保持互异。
  return mod(mod(day) + block * 2 + Math.floor(block / 2));
}
