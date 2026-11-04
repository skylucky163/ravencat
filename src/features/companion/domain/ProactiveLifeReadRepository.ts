/** 主动生活只读端口；不拥有 AI 日程的业务事实。 */

export type ProactiveLifeSourceType = 'ai_schedule';

/** 主动生活历史的用户可理解终态，不暴露 AI Schedule 的内部 disposition 名称。 */
export type ProactiveLifeCompletionDisposition = 'completed' | 'interrupted' | 'unexecuted' | 'failed';

export interface ProactiveLifeFutureRecord {
  sourceType: ProactiveLifeSourceType;
  sourceId: string;
  ownerAIId: string;
  plannedAt: string;
  summary: string | null;
}

export interface ProactiveLifeRunningRecord extends ProactiveLifeFutureRecord {
  startedAt: string;
  runId: string;
}

export interface ProactiveLifeHistoryRecord extends ProactiveLifeFutureRecord {
  occurredAt: string;
  terminalAt: string;
  runId: string | null;
  completionDisposition: ProactiveLifeCompletionDisposition;
}

export interface ProactiveLifePage<Item, Cursor> {
  items: Item[];
  nextCursor: Cursor | null;
  hasMore: boolean;
}

/** 本地日历日由展示层转成绝对边界；Repository 不猜测时区或一天的长度。 */
export interface ProactiveLifeDayRange { key: string; from: string; until: string }
export interface ProactiveLifeCalendarCursor { rank: number; at: string; sourceId: string }
export type ProactiveLifeCalendarRecord =
  | { kind: 'future'; item: ProactiveLifeFutureRecord }
  | { kind: 'running'; item: ProactiveLifeRunningRecord }
  | { kind: 'history'; item: ProactiveLifeHistoryRecord };
export interface ProactiveLifeDayCount { key: string; count: number; runningCount: number }
export interface ProactiveLifeDayQuery {
  ownerAIId: string;
  now: string;
  day: ProactiveLifeDayRange;
  after?: ProactiveLifeCalendarCursor | null;
  limit: number;
}
/** days 是展示层按日期升序给出的有界窗口。 */
export interface ProactiveLifeCalendarQuery extends ProactiveLifeDayQuery { days: ProactiveLifeDayRange[] }
export interface ProactiveLifeCalendarRecordPage {
  counts: ProactiveLifeDayCount[];
  page: ProactiveLifePage<ProactiveLifeCalendarRecord, ProactiveLifeCalendarCursor>;
}
export interface ProactiveLifeReadRepository {
  loadCalendar(input: ProactiveLifeCalendarQuery): Promise<ProactiveLifeCalendarRecordPage>;
  listDay(input: ProactiveLifeDayQuery): Promise<ProactiveLifePage<ProactiveLifeCalendarRecord, ProactiveLifeCalendarCursor>>;
}
