/**
 * 历史记账列表与详情共用的时间范围、汇总与页面契约。
 * 这些字段由 `utils/timeUtils` 生成，展示层只消费，不自行拼装。
 */
import type { WalletRecord, WalletRecordType } from '../domain/WalletRecord';
import type { LedgerRangeSummary } from '../domain/LedgerRepository';

export type ViewType = 'week' | 'month' | 'year';

export interface TimeRange {
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
  label: string;      // 显示文本
  year: number;
  month: number;
}

export interface DayInfo extends TimeRange {
  weekday: string;    // '今天', '昨天', '周一'...
  isToday: boolean;
}

export interface WeekInfo extends TimeRange {
  weekNum: number;    // 第几周
}

export interface MonthInfo extends TimeRange {
  monthName: string;  // '1月', '2月'...
  isYearSummary?: boolean;
}

/** 一条时间范围的查询结果：仓储汇总 + 它所属的范围。 */
export interface SummaryData extends LedgerRangeSummary {
  timeRange: TimeRange;
}

export interface HistoryScreenProps {
  onBack: () => void;
  onSelectTimeRange: (timeRange: TimeRange, summary: SummaryData) => void;
  onViewChange?: (view: ViewType) => void; // 视图切换回调
  initialView?: ViewType;
  initialDate?: Date;
}

export interface HistoryDetailScreenProps {
  onBack: () => void;
  timeRange: TimeRange;
  initialData?: SummaryData;
}

export interface CategoryGroupData {
  category: string;
  type: WalletRecordType;
  total: number;
  percentage: number;
  count: number;
  color: string;
  records: WalletRecord[];
}
