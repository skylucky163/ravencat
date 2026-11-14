/** 日历只读取唯一日程真值；日期计数和当天第一页来自同一个短事务快照。 */
import { databaseCoordinator, type DatabaseReadExecutor } from '@platform/persistence';
import type {
  ProactiveLifeCalendarCursor, ProactiveLifeCalendarQuery, ProactiveLifeCalendarRecord,
  ProactiveLifeCalendarRecordPage, ProactiveLifeDayCount, ProactiveLifeDayQuery,
  ProactiveLifePage, ProactiveLifeReadRepository,
} from '../domain/ProactiveLifeReadRepository';
import { isAIScheduleRecurrence, nextAIScheduleTime, type AIScheduleRecurrence } from '../domain/AIScheduleTiming';

interface CalendarRow {
  rank: number;
  kind: 'future' | 'running' | 'history';
  source_id: string;
  owner_ai_id: string;
  planned_at: string;
  summary: string | null;
  display_at: string;
  run_id: string | null;
  terminal_at: string | null;
  completion_disposition: string | null;
  recurrence_json: string | null;
  series_id: string | null;
  is_projected: number;
}

const CALENDAR_ROWS = `
  SELECT 'future' AS kind, schedule_id AS source_id, owner_ai_id,
    remind_at AS planned_at, summary, remind_at AS display_at,
    NULL AS run_id, NULL AS terminal_at, NULL AS completion_disposition,
    recurrence_json, series_id, 0 AS is_projected
  FROM raven_cat_ai_schedules
  WHERE owner_ai_id = ? AND status = 'scheduled' AND julianday(remind_at) > julianday(?)
    AND julianday(remind_at) >= julianday(?) AND julianday(remind_at) < julianday(?)
  UNION ALL
  SELECT 'running', schedule_id, owner_ai_id, remind_at, summary, claimed_at,
    claimed_by_run_id, NULL, NULL, recurrence_json, series_id, 0
  FROM raven_cat_ai_schedules
  WHERE owner_ai_id = ? AND status = 'claimed'
    AND julianday(claimed_at) >= julianday(?) AND julianday(claimed_at) < julianday(?)
  UNION ALL
  SELECT 'history', schedule_id, owner_ai_id, remind_at, summary,
    COALESCE(claimed_at, remind_at), claimed_by_run_id, COALESCE(consumed_at, remind_at),
    CASE WHEN status IN ('scheduled','cancelled') THEN 'unexecuted' ELSE completion_disposition END,
    recurrence_json, series_id, 0
  FROM raven_cat_ai_schedules
  WHERE owner_ai_id = ? AND (
    status = 'consumed'
    OR (status = 'cancelled' AND cancelled_reason IN ('expired','merged_schedule','merged_chat'))
    OR (status = 'scheduled' AND julianday(remind_at) <= julianday(?)))
    AND julianday(COALESCE(claimed_at, remind_at)) >= julianday(?)
    AND julianday(COALESCE(claimed_at, remind_at)) < julianday(?)
  UNION ALL
  SELECT 'future', s.schedule_id, s.owner_ai_id,
    json_extract(p.value, '$.plannedAt'), s.summary, json_extract(p.value, '$.plannedAt'),
    NULL, NULL, NULL, s.recurrence_json, s.series_id, 1
  FROM json_each(?) p JOIN raven_cat_ai_schedules s ON s.schedule_id=json_extract(p.value, '$.scheduleId')`;

function calendarParams(input: ProactiveLifeDayQuery, projected: string, from = input.day.from, until = input.day.until): string[] {
  return [input.ownerAIId, input.now, from, until, input.ownerAIId, from, until, input.ownerAIId, input.now, from, until, projected];
}

export class SQLiteProactiveLifeReadRepository implements ProactiveLifeReadRepository {
  async loadCalendar(input: ProactiveLifeCalendarQuery): Promise<ProactiveLifeCalendarRecordPage> {
    return this.openExecutor('calendar').withExclusiveTransactionAsync(async tx => {
      const from = input.days[0].from;
      const until = input.days[input.days.length - 1].until;
      const projected = await projectRecurringSchedules(tx, input,
        new Date(Math.min(Date.parse(from), Date.parse(input.day.from))).toISOString(),
        new Date(Math.max(Date.parse(until), Date.parse(input.day.until))).toISOString());
      const rows = await tx.getAllAsync<{ day_key: string; count: number; running_count: number }>(
        `WITH calendar AS (${CALENDAR_ROWS}),
         days(day_key, start_at, end_at) AS (VALUES ${input.days.map(() => '(?,?,?)').join(',')})
         SELECT days.day_key, COUNT(calendar.source_id) AS count,
           SUM(CASE WHEN calendar.kind = 'running' THEN 1 ELSE 0 END) AS running_count
         FROM days LEFT JOIN calendar
           ON julianday(calendar.display_at) >= julianday(days.start_at)
           AND julianday(calendar.display_at) < julianday(days.end_at)
         GROUP BY days.day_key ORDER BY days.day_key`,
        [...calendarParams(input, projected, from, until), ...input.days.flatMap(day => [day.key, day.from, day.until])],
      );
      const counts: ProactiveLifeDayCount[] = rows.map(row => ({ key: row.day_key, count: row.count, runningCount: row.running_count }));
      return { counts, page: await queryDay(tx, input, projected) };
    });
  }

  listDay(input: ProactiveLifeDayQuery) {
    return this.openExecutor('day').withExclusiveTransactionAsync(async tx =>
      queryDay(tx, input, await projectRecurringSchedules(tx, input, input.day.from, input.day.until)));
  }

  private openExecutor(operation: string) {
    return databaseCoordinator.openTaskExecutor({ name: `companion.proactiveLife.${operation}`, feature: 'companion', priority: 'interactive' });
  }
}

async function queryDay(
  db: Pick<DatabaseReadExecutor, 'getAllAsync'>,
  input: ProactiveLifeDayQuery,
  projected: string,
): Promise<ProactiveLifePage<ProactiveLifeCalendarRecord, ProactiveLifeCalendarCursor>> {
  const cursor = input.after;
  const after = cursor ? `AND (rank > ? OR (rank = ? AND (julianday(display_at) > julianday(?) OR
    (julianday(display_at) = julianday(?) AND source_id > ?))))` : '';
  const rows = await db.getAllAsync<CalendarRow>(
    `WITH calendar AS (${CALENDAR_ROWS}), ranked AS (
       SELECT *, CASE kind WHEN 'running' THEN 0 WHEN 'future' THEN 1 ELSE 2 END AS rank FROM calendar)
     SELECT * FROM ranked WHERE julianday(display_at) >= julianday(?) AND julianday(display_at) < julianday(?)
     ${after} ORDER BY rank ASC, julianday(display_at) ASC, source_id ASC LIMIT ?`,
    [...calendarParams(input, projected), input.day.from, input.day.until,
      ...(cursor ? [cursor.rank, cursor.rank, cursor.at, cursor.at, cursor.sourceId] : []), input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const last = pageRows[pageRows.length - 1];
  return { items: pageRows.map(toCalendarRecord), hasMore,
    nextCursor: hasMore ? { rank: last.rank, at: last.display_at, sourceId: last.source_id } : null };
}

function toCalendarRecord(row: CalendarRow): ProactiveLifeCalendarRecord {
  const item = { sourceType: 'ai_schedule' as const, sourceId: row.source_id, seriesId: row.series_id, ownerAIId: row.owner_ai_id,
    plannedAt: row.planned_at, summary: row.summary, recurrence: readRecurrence(row.recurrence_json) };
  if (row.kind === 'future') return { kind: 'future', item: { ...item, isProjected: row.is_projected === 1 } };
  // 可空投影列在 SQLite adapter 收口，内部 DTO 保持状态机约束。
  if (row.kind === 'running') {
    if (row.run_id === null) throw new Error('运行中日程缺少 runId');
    return { kind: 'running', item: { ...item, startedAt: row.display_at, runId: row.run_id } };
  }
  const disposition = row.completion_disposition;
  if (disposition !== 'unexecuted' && disposition !== 'agent_terminal' && disposition !== 'interrupted') {
    throw new Error(`SQLite AI Schedule completion_disposition 非法：${disposition}`);
  }
  if (row.terminal_at === null) throw new Error('历史日程缺少终态时间');
  return { kind: 'history', item: { ...item, occurredAt: row.display_at, terminalAt: row.terminal_at,
    runId: row.run_id, completionDisposition: disposition === 'agent_terminal' ? 'completed' : disposition } };
}

/** 只展开当前查询窗口；不写入未来执行事实，也不从已取消或结束的历史继续推演。 */
async function projectRecurringSchedules(
  db: Pick<DatabaseReadExecutor, 'getAllAsync'>, input: ProactiveLifeDayQuery, from: string, until: string,
): Promise<string> {
  const rows = await db.getAllAsync<{ schedule_id: string; remind_at: string; recurrence_json: string }>(
    `SELECT schedule_id,remind_at,recurrence_json FROM raven_cat_ai_schedules
      WHERE owner_ai_id=? AND status='scheduled' AND recurrence_json IS NOT NULL
        AND julianday(remind_at)<julianday(?)`, [input.ownerAIId,until]);
  const occurrences: { scheduleId: string; plannedAt: string }[] = [];
  for (const row of rows) {
    const recurrence = readRecurrence(row.recurrence_json)!;
    // 已落库的最近一期由原查询返回；后续预览从查询窗口与当前时间直接定位，不遍历中间年份。
    let after = new Date(Math.max(Date.parse(row.remind_at), Date.parse(input.now), Date.parse(from) - 1)).toISOString();
    for (;;) {
      const plannedAt = nextAIScheduleTime(recurrence, after);
      if (plannedAt === null || Date.parse(plannedAt) >= Date.parse(until)) break;
      occurrences.push({ scheduleId: row.schedule_id, plannedAt });
      after = plannedAt;
    }
  }
  return JSON.stringify(occurrences);
}

function readRecurrence(json: string | null): AIScheduleRecurrence | null {
  if (json === null) return null;
  const recurrence: AIScheduleRecurrence = JSON.parse(json);
  if (!isAIScheduleRecurrence(recurrence)) throw new Error('SQLite AI 日程重复规则非法');
  return recurrence;
}

export const proactiveLifeReadRepository = new SQLiteProactiveLifeReadRepository();
