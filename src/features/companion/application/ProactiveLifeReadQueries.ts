/** 日历查询只组合日程事实与 Chat 响应证据；不持有第二份执行状态。 */
import { getCompanionRuntimeDependencies } from './CompanionRuntimeDependencies';
import type {
  ProactiveLifeCalendarQuery, ProactiveLifeCalendarRecord, ProactiveLifeDayQuery,
  ProactiveLifeFutureRecord, ProactiveLifeHistoryRecord, ProactiveLifeRunningRecord,
} from '../domain/ProactiveLifeReadRepository';

export type { ProactiveLifeCalendarCursor, ProactiveLifeDayCount, ProactiveLifeDayRange } from '../domain/ProactiveLifeReadRepository';
export type ProactiveLifeFutureItem = ProactiveLifeFutureRecord;
export interface ProactiveLifeRunningItem extends ProactiveLifeRunningRecord { modelResponded: boolean }
export interface ProactiveLifeHistoryItem extends ProactiveLifeHistoryRecord { modelResponded: boolean }
export type ProactiveLifeCalendarItem =
  | { kind: 'future'; item: ProactiveLifeFutureItem }
  | { kind: 'running'; item: ProactiveLifeRunningItem }
  | { kind: 'history'; item: ProactiveLifeHistoryItem };

export async function loadProactiveLifeCalendar(input: ProactiveLifeCalendarQuery) {
  assertQuery(input);
  if (input.days.length === 0 || input.days.length > 15) throw new Error('日历只读取最多十五个可见日期');
  const result = await getCompanionRuntimeDependencies().repositories.proactiveLife.loadCalendar(input);
  return { counts: result.counts, page: { ...result.page, items: await attachEvidence(result.page.items) } };
}

export async function listProactiveLifeDay(input: ProactiveLifeDayQuery) {
  assertQuery(input);
  const page = await getCompanionRuntimeDependencies().repositories.proactiveLife.listDay(input);
  return { ...page, items: await attachEvidence(page.items) };
}

async function attachEvidence(records: ProactiveLifeCalendarRecord[]): Promise<ProactiveLifeCalendarItem[]> {
  const runIds = [...new Set(records.flatMap(record => record.kind !== 'future' && record.item.runId ? [record.item.runId] : []))];
  const evidence = runIds.length ? await getCompanionRuntimeDependencies().chat.listAgentActivityEvidence(runIds) : [];
  const byRunId = new Map(evidence.map(item => [item.runId, item]));
  return records.map(record => {
    if (record.kind === 'future') return record;
    const proof = record.item.runId ? byRunId.get(record.item.runId) : undefined;
    const modelResponded = Boolean(proof?.respondedAt);
    if (record.kind === 'running') return { kind: 'running', item: { ...record.item, modelResponded } };
    const completionDisposition = record.item.runId === null ? 'unexecuted'
      : proof?.terminalCode === 'COMPLETED' && modelResponded ? 'completed'
      : proof?.terminalCode === 'INTERRUPTED' || record.item.completionDisposition === 'interrupted' ? 'interrupted'
      : proof?.terminalCode ? 'failed' : modelResponded ? 'interrupted' : 'unexecuted';
    return { kind: 'history', item: { ...record.item, modelResponded, completionDisposition } };
  });
}

function assertQuery(input: ProactiveLifeDayQuery) {
  if (!input.ownerAIId || !Number.isFinite(Date.parse(input.now))) throw new Error('日历查询缺少主理 AI 或有效时间');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('日历分页大小必须为 1～100');
}
