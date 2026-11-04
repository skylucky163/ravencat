/** 验证日期范围、状态归属、分页及 Chat 证据，不把旧列表的形状当成产品契约。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';

const schema = loadTypeScriptModule('src/platform/persistence/sqlite/ravenCatCompanionSchema.ts');
const db = new DatabaseSync(':memory:');
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_SCHEMA);
let inTransaction = false, mutation = null, injectMutation = false;
const executor = {
  getAllAsync: async (sql, params = []) => {
    const rows = db.prepare(sql).all(...params);
    if (injectMutation) {
      injectMutation = false;
      const update = () => db.prepare("UPDATE raven_cat_ai_schedules SET status='claimed', claimed_at='2026-09-09T13:00:00Z', claimed_by_run_id='new-run' WHERE schedule_id='snapshot'").run();
      if (inTransaction) mutation = update;
      else update();
    }
    return rows;
  },
  withExclusiveTransactionAsync: async task => {
    inTransaction = true;
    try { return await task(executor); }
    finally { inTransaction = false; mutation?.(); mutation = null; }
  },
};
const { SQLiteProactiveLifeReadRepository } = loadTypeScriptModule('src/features/companion/infrastructure/SQLiteProactiveLifeReadRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => executor } },
});
const repository = new SQLiteProactiveLifeReadRepository();
const insert = db.prepare(`INSERT INTO raven_cat_ai_schedules
  (schedule_id,owner_ai_id,remind_at,summary,details,status,claimed_at,claimed_by_run_id,consumed_at,completion_disposition,cancelled_at,cancelled_reason,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
function add(id, at, options = {}) {
  const { owner='a', status='scheduled', claimed=null, run=null, consumed=null, disposition=consumed?'agent_terminal':null, cancelled=null, reason=null } = options;
  insert.run(id,owner,at,id,id,status,claimed,run,consumed,disposition,cancelled,reason,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
}
const now = '2026-09-09T12:00:00Z';
const day = { key:'2026-09-09', from:'2026-09-09T00:00:00Z', until:'2026-09-10T00:00:00Z' };
const next = { key:'2026-09-10', from:day.until, until:'2026-09-11T00:00:00Z' };
const base = { ownerAIId:'a', now, day, limit:3 };
add('future-a','2026-09-09T14:00:00Z');
add('future-b','2026-09-09T22:00:00+08:00');
add('next-midnight',day.until);
add('foreign','2026-09-09T15:00:00Z',{owner:'b'});
add('running','2026-09-08T23:59:00Z',{status:'claimed',claimed:'2026-09-09T00:01:00Z',run:'running-run'});
add('history','2026-09-08T22:00:00Z',{status:'consumed',claimed:'2026-09-09T01:00:00Z',run:'history-run',consumed:'2026-09-10T01:00:00Z'});
add('missed','2026-09-09T02:00:00Z');
add('expired','2026-09-09T03:00:00Z',{status:'cancelled',reason:'expired',cancelled:now});
add('user-cancelled','2026-09-09T18:00:00Z',{status:'cancelled',cancelled:now});
add('merged','2026-09-09T04:00:00Z',{status:'cancelled',reason:'merged_chat',cancelled:now});
const calendar = await repository.loadCalendar({...base,days:[day,next]});
assert.deepEqual(calendar.counts.map(value=>({...value})),[
  {key:day.key,count:7,runningCount:1},{key:next.key,count:1,runningCount:0},
]);
assert.deepEqual(calendar.page.items.map(row=>row.item.sourceId),['running','future-a','future-b']);
assert.equal(calendar.page.hasMore,true);
const tail = await repository.listDay({...base,after:calendar.page.nextCursor});
const final = await repository.listDay({...base,after:tail.nextCursor});
const all = [...calendar.page.items,...tail.items,...final.items];
assert.deepEqual(all.map(row=>row.item.sourceId),['running','future-a','future-b','history','missed','expired','merged']);
assert.equal(final.nextCursor,null);
assert.equal(all.find(row=>row.item.sourceId==='history').item.occurredAt,'2026-09-09T01:00:00Z');
assert.equal(all.find(row=>row.item.sourceId==='missed').item.completionDisposition,'unexecuted');
assert.deepEqual((await repository.listDay({...base,day:next})).items.map(row=>row.item.sourceId),['next-midnight']);

// 计数和首屏不能一个看到 scheduled、另一个已经看到 claimed。
add('snapshot','2026-09-09T20:00:00Z',{owner:'snapshot-owner'});
injectMutation = true;
const consistent = await repository.loadCalendar({...base,ownerAIId:'snapshot-owner',days:[day]});
assert.equal(consistent.counts[0].runningCount,0);
assert.equal(consistent.page.items[0].kind,'future');
assert.equal((await repository.listDay({...base,ownerAIId:'snapshot-owner'})).items[0].kind,'running');

const proof = new Map([
  ['running-run',{runId:'running-run',respondedAt:now,terminalCode:null}],
  ['history-run',{runId:'history-run',respondedAt:now,terminalCode:'COMPLETED'}],
]);
const queries = loadTypeScriptModule('src/features/companion/application/ProactiveLifeReadQueries.ts', {
  './CompanionRuntimeDependencies':{ getCompanionRuntimeDependencies:()=>({ repositories:{proactiveLife:repository},chat:{listAgentActivityEvidence:async ids=>ids.flatMap(id=>proof.has(id)?[proof.get(id)]:[])}}) },
});
let enriched = await queries.loadProactiveLifeCalendar({...base,limit:25,days:[day]});
assert.equal(enriched.page.items.find(row=>row.kind==='running').item.modelResponded,true);
assert.equal(enriched.page.items.find(row=>row.item.sourceId==='history').item.completionDisposition,'completed');
proof.set('history-run',{runId:'history-run',respondedAt:now,terminalCode:'INTERRUPTED'});
enriched = await queries.listProactiveLifeDay({...base,limit:25});
assert.equal(enriched.items.find(row=>row.item.sourceId==='history').item.completionDisposition,'interrupted');
proof.set('history-run',{runId:'history-run',respondedAt:null,terminalCode:'MODEL_FAILED'});
enriched = await queries.listProactiveLifeDay({...base,limit:25});
assert.equal(enriched.items.find(row=>row.item.sourceId==='history').item.completionDisposition,'failed');
for (const input of [{...base,limit:0,days:[day]},{...base,days:[]}]) await assert.rejects(()=>queries.loadProactiveLifeCalendar(input));
db.close();
console.log('主动生活日历查询验证通过：日期边界、状态归属、一致快照、稳定分页与真实响应证据。');
