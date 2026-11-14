/** 验证日期范围、状态归属、分页及 Chat 证据，不把旧列表的形状当成产品契约。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';

const schema = loadTypeScriptModule('src/platform/persistence/sqlite/ravenCatCompanionSchema.ts');
const timing = loadTypeScriptModule('src/features/companion/domain/AIScheduleTiming.ts');
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
  '../domain/AIScheduleTiming': timing,
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

// 只保存 11 号最近一期，12 号以后也必须显示重复规则对应的安排，不创建未来任务行。
const daily = {frequency:'daily',timeZone:'Asia/Shanghai',hour:21,minute:0};
function localDay(key) {
  const start=Date.parse(`${key}T00:00:00+08:00`);
  return {key,from:new Date(start).toISOString(),until:new Date(start+86400000).toISOString()};
}
function repeating(id,at,recurrence,owner='repeated') {
  add(id,at,{owner});
  db.prepare('UPDATE raven_cat_ai_schedules SET recurrence_json=?,series_id=? WHERE schedule_id=?')
    .run(JSON.stringify(recurrence),id,id);
}
const days=['2026-11-11','2026-11-12','2026-11-13'].map(localDay);
const repeatQuery={ownerAIId:'repeated',now:'2026-11-11T02:00:00.000Z',day:days[1],days,limit:25};
repeating('every-night','2026-11-11T13:00:00.000Z',daily);
add('one-off','2026-11-11T14:00:00.000Z',{owner:'repeated'});
repeating('other-owner','2026-11-11T13:00:00.000Z',daily,'other-owner');
const beforeRows=db.prepare('SELECT COUNT(*) AS count FROM raven_cat_ai_schedules').get().count;
let repeated=await repository.loadCalendar(repeatQuery);
assert.deepEqual(repeated.counts.map(value=>value.count),[2,1,1]);
assert.equal(repeated.page.items[0].item.plannedAt,'2026-11-12T13:00:00.000Z');
assert.equal(repeated.page.items[0].item.sourceId,'every-night','后续日期仍指向可编辑和取消的真实日程');
assert.equal(repeated.page.items[0].item.isProjected,true);
assert.deepEqual(repeated.page.items[0].item.recurrence,daily);
assert.equal((await repository.listDay({...repeatQuery,day:days[0]})).items.find(row=>row.item.sourceId==='every-night').item.isProjected,false);
const far=localDay('2030-11-11');
assert.equal((await repository.listDay({...repeatQuery,day:far})).items[0].item.plannedAt,'2030-11-11T13:00:00.000Z','直接跳到遥远日期也显示重复安排');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM raven_cat_ai_schedules').get().count,beforeRows,'查看日历不能写入或调度未来任务');

// 切换规则、结束时间和取消立即反映在未来日期；过去日期不伪造历史。
db.prepare('UPDATE raven_cat_ai_schedules SET recurrence_json=? WHERE schedule_id=?')
  .run(JSON.stringify({...daily,frequency:'weekly',weekdays:[3,5]}),'every-night');
repeated=await repository.loadCalendar(repeatQuery);
assert.deepEqual(repeated.counts.map(value=>value.count),[2,0,1]);
db.prepare('UPDATE raven_cat_ai_schedules SET recurrence_json=? WHERE schedule_id=?')
  .run(JSON.stringify({...daily,until:'2026-11-13T13:00:00.000Z'}),'every-night');
assert.equal((await repository.listDay({...repeatQuery,day:localDay('2026-11-13')})).items.length,1,'重复结束时间包含最后一期');
assert.equal((await repository.listDay({...repeatQuery,day:localDay('2026-11-14')})).items.length,0);
assert.equal((await repository.listDay({...repeatQuery,day:localDay('2026-11-10')})).items.length,0,'不向首次安排之前或过去的空白日期补造记录');
db.prepare("UPDATE raven_cat_ai_schedules SET status='cancelled',cancelled_at=? WHERE schedule_id=?")
  .run(repeatQuery.now,'every-night');
assert.equal((await repository.listDay(repeatQuery)).items.length,0,'停止重复后不再显示后续安排');

// 下一期真正生成后，应展示那条实际记录，而不是与旧规则预览重复计数。
db.prepare("UPDATE raven_cat_ai_schedules SET status='claimed',cancelled_at=NULL,claimed_at=?,claimed_by_run_id='daily-run' WHERE schedule_id=?")
  .run('2026-11-11T13:00:00.000Z','every-night');
repeating('next-night','2026-11-12T13:00:00.000Z',daily);
db.prepare("UPDATE raven_cat_ai_schedules SET series_id='every-night' WHERE schedule_id='next-night'").run();
repeated=await repository.loadCalendar({...repeatQuery,now:'2026-11-11T13:01:00.000Z'});
assert.deepEqual(repeated.counts.map(value=>value.count),[2,1,1]);
assert.equal(repeated.page.items[0].item.sourceId,'next-night');
assert.equal(repeated.page.items[0].item.isProjected,false);

repeating('month-end','2026-11-30T13:00:00.000Z',{...daily,frequency:'monthly',monthDay:31},'monthly');
const monthly={...repeatQuery,ownerAIId:'monthly',day:localDay('2027-02-28')};
assert.equal((await repository.listDay(monthly)).items[0].item.plannedAt,'2027-02-28T13:00:00.000Z');
assert.equal((await repository.listDay({...monthly,day:localDay('2028-02-29')})).items[0].item.plannedAt,'2028-02-29T13:00:00.000Z');
assert.equal((await repository.listDay({...monthly,day:localDay('2027-03-31')})).items.length,1,'月底缩短不改变之后月份的原始日期');

// 夏令时回拨形成 25 小时本地日，同一重复规则可能有两期，分页和列表身份必须都保留。
repeating('long-day','2026-10-31T04:30:00.000Z',{frequency:'daily',timeZone:'UTC',hour:4,minute:30},'long-day');
const longDay={...repeatQuery,ownerAIId:'long-day',now:'2026-10-30T00:00:00.000Z',limit:1,
  day:{key:'2026-11-01',from:'2026-11-01T04:00:00.000Z',until:'2026-11-02T05:00:00.000Z'}};
const firstLong=await repository.loadCalendar({...longDay,days:[longDay.day]});
assert.equal(firstLong.counts[0].count,2);
assert.equal(firstLong.page.hasMore,true);
const secondLong=await repository.listDay({...longDay,after:firstLong.page.nextCursor});
assert.deepEqual([...firstLong.page.items,...secondLong.items].map(row=>row.item.plannedAt),
  ['2026-11-01T04:30:00.000Z','2026-11-02T04:30:00.000Z']);
assert.equal(secondLong.nextCursor,null);
db.close();
console.log('主动生活日历查询验证通过：重复日程预览、月底、结束与取消、无重复和无写入、日期边界、一致快照及稳定分页。');
