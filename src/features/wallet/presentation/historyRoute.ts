/** 在羽库历史路由与时间范围之间转换稳定、可序列化的标识。 */
import type { TimeRange } from './historyTypes';

const RANGE_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

export function encodeWalletHistoryRangeId(timeRange: TimeRange): string {
  return `${timeRange.startDate}_${timeRange.endDate}`;
}

export function decodeWalletHistoryRangeId(rangeId: string): TimeRange | null {
  const match = RANGE_ID_PATTERN.exec(rangeId);
  if (!match) {
    return null;
  }

  const [, startDate, endDate] = match;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    return null;
  }

  return {
    startDate,
    endDate,
    label: startDate === endDate ? startDate : `${startDate} 至 ${endDate}`,
    year: start.getFullYear(),
    month: start.getMonth() + 1,
  };
}
