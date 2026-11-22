/** 用真实 SQLite 验证重复推进、回复代次与续轮碰撞，不运行模型或构建 APK。 */
import { repoRoot as root } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMAS } from '../helpers/sqlite-bootstrap-fixture.mjs';


const filename = path.join(os.tmpdir(), `ravencat-schedule-timing-${process.pid}-${Date.now()}.sqlite`);
let db = new DatabaseSync(filename);
try {
const tx = {
  execAsync: async sql => db.exec(sql),
  runAsync: async (sql, args = []) => db.prepare(sql).run(...args),
  getFirstAsync: async (sql, args = []) => db.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql, args = []) => db.prepare(sql).all(...args),
  async withExclusiveTransactionAsync(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = await action(tx); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const modules = new Map();
function load(file) {
  const full = path.resolve(root, file.endsWith('.ts') ? file : `${file}.ts`);
  if (modules.has(full)) return modules.get(full).exports;
  const module = { exports: {} }; modules.set(full, module);
  const source = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require','module','exports',source)(id => {
    if (id === '@platform/persistence') return { databaseCoordinator: { openTaskExecutor: () => tx } };
    if (id === './CompanionRuntimeDependencies') return { getCompanionRuntimeDependencies: () => ({ repositories: { aiSchedules: repository } }) };
    assert.ok(id.startsWith('.'), `未声明边界：${id}`);
    return load(path.resolve(path.dirname(full), id));
  },module,module.exports);
  return module.exports;
}
const { nextAIScheduleTime, isAIScheduleRecurrence } = load('src/features/companion/domain/AIScheduleTiming');
const { createAISchedule } = load('src/features/companion/domain/AISchedule');
const { SQLiteAIScheduleRepository, acknowledgeScheduleReplyInTransaction } = load('src/features/companion/infrastructure/SQLiteAIScheduleRepository');
const { SQLiteCompanionSettingsRepository } = load('src/features/companion/infrastructure/SQLiteCompanionSettingsRepository');
const schema = load('src/platform/persistence/sqlite/ravenCatCompanionSchema');
const { isSubstantiveUserMessage } = load('src/features/chat/messages/domain/SubstantiveUserMessage');
const userMessage = (text = '', metadata = null) => ({ isMe: true,senderType:'user',text,metadataJson: metadata ? JSON.stringify(metadata) : null });
assert.equal(isSubstantiveUserMessage(userMessage('知道了')),true);
assert.equal(isSubstantiveUserMessage(userMessage('   ')),false);
assert.equal(isSubstantiveUserMessage(userMessage('',{kind:'image',attachments:[{type:'image'}]})),true);
assert.equal(isSubstantiveUserMessage(userMessage('',{kind:'voice',voice:{schemaVersion:1,mediaAssetId:'voice',mimeType:'audio/aac',durationMs:500,transcriptSource:'user_stt'}})),true);
assert.equal(isSubstantiveUserMessage(userMessage('',{kind:'sticker',sticker:{stickerId:'cat',mediaAssetId:'cat-asset',name:'猫猫',description:null,tags:[],emotion:null,mimeType:'image/png',width:100,height:100,isAnimated:false}})),true);
assert.equal(isSubstantiveUserMessage(userMessage('记账成功',{type:'toolStatus'})),false);
assert.equal(isSubstantiveUserMessage(userMessage('邀请一起听歌',{kind:'together_listening'})),false);
assert.equal(isSubstantiveUserMessage({...userMessage('朋友圈发布成功'),isMe:false,senderType:'system'}),false);
const daily = { frequency: 'daily', timeZone: 'Asia/Shanghai', hour: 9, minute: 0 };
const monthly = { ...daily, frequency: 'monthly', monthDay: 31 };
assert.equal(nextAIScheduleTime(monthly, '2026-01-31T01:00:00.000Z'), '2026-02-28T01:00:00.000Z');
assert.equal(nextAIScheduleTime(monthly, '2026-02-28T01:00:00.000Z'), '2026-03-31T01:00:00.000Z');
assert.equal(nextAIScheduleTime({ ...monthly, until: '2026-02-28T01:00:00.000Z' }, '2026-02-28T01:00:00.000Z'), null);
assert.equal(nextAIScheduleTime({ ...daily, frequency: 'weekly', weekdays: [1,3] }, '2026-11-02T01:00:00.000Z'), '2026-11-04T01:00:00.000Z');
assert.equal(nextAIScheduleTime({ ...daily, timeZone: 'America/New_York' }, '2026-03-07T14:00:00.000Z'), '2026-03-08T13:00:00.000Z');
assert.equal(nextAIScheduleTime({ ...daily, timeZone: 'America/New_York', hour: 2, minute: 30 }, '2026-03-07T07:30:00.000Z'), '2026-03-08T07:30:00.000Z');
assert.equal(isAIScheduleRecurrence({ ...daily, timeZone: '' }), false);

db.exec('PRAGMA foreign_keys=ON; CREATE TABLE ai_assistants(id TEXT PRIMARY KEY); INSERT INTO ai_assistants VALUES (\'host\');');
for (const sql of [schema.RAVEN_CAT_COMPANION_STATE_SCHEMA,schema.RAVEN_CAT_AI_SCHEDULES_SCHEMA,
  schema.RAVEN_CAT_AI_SCHEDULE_CONTEXT_SCHEMA,schema.RAVEN_CAT_AI_SCHEDULE_WAIT_SCHEMA,SCHEMAS.ravenCatContactSettings]) db.exec(sql);
db.exec(`INSERT INTO raven_cat_companion_state(id,desired_enabled,activation_status,host_ai_id,created_at,updated_at)
  VALUES ('default',1,'enabled','host','2026-11-01','2026-11-01');
  INSERT INTO raven_cat_contact_settings(id,follow_up_enabled,created_at,updated_at) VALUES('default',1,'2026-11-01','2026-11-01');`);
const repository = new SQLiteAIScheduleRepository();
const settingsRepository = new SQLiteCompanionSettingsRepository();
const { AIScheduleApplication, setAIScheduleFollowUpInterval } = load('src/features/companion/application/AIScheduleApplication');
const at = minutes => new Date(Date.parse('2026-11-02T01:00:00.000Z') + minutes * 60000).toISOString();
const make = (id, minute = 0, recurrence = null) => createAISchedule({ scheduleId: id, ownerAIId: 'host', remindAt: at(minute),
  summary: `日程 ${id}`, details: `背景 ${id}`, systemCalendar: false, recurrence, seriesId: recurrence ? id : null,
  sourceConversationId: null,sourceMessageIds: null,sourceExcerpt: null,status: 'scheduled',claimedByRunId: null,
  claimedAt: null,consumedAt: null,completionDisposition: null,cancelledAt: null,cancelledReason: null,
  createdAt: at(-60),updatedAt: at(-60) });
async function add(schedule) { assert.equal((await repository.createScheduled(schedule,at(-120))).status,'created'); return schedule; }
async function claim(schedule,runId,minute = 0) {
  const result = await repository.claimScheduled({ scheduleId: schedule.scheduleId, ownerAIId: 'host', runId,
    claimedAt: at(minute), expectedRemindAt: schedule.remindAt, projectionToken: schedule.updatedAt, conversationId: 'chat' });
  assert.equal(result.status,'claimed'); return result.schedule;
}
async function finish(schedule, minute, firstVisibleAt = null) {
  assert.equal((await repository.consumeClaimed({ scheduleId: schedule.scheduleId,runId: schedule.claimedByRunId,
    consumedAt: at(minute),completionDisposition: 'agent_terminal',firstVisibleAt })).status,'consumed');
}
const pendingFollowUps = () => db.prepare("SELECT * FROM raven_cat_ai_schedules WHERE trigger_kind='unanswered' AND status='scheduled'").all();

const first = await claim(await add(make('daily',0,daily)),'run-first');
assert.equal((await repository.listAllScheduled()).find(item => item.seriesId === 'daily').remindAt,'2026-11-03T01:00:00.000Z');
assert.equal(pendingFollowUps().length,0, '上一轮未结束时不安排续轮');
await finish(first,3,at(1));
assert.equal(pendingFollowUps()[0].remind_at,at(13),'从执行结束开始计算默认十分钟');
const followUp = await repository.getByScheduleId(pendingFollowUps()[0].schedule_id);
const followClaim = await claim(followUp,'run-follow',13);
assert.equal((await repository.setNextFollowUpInterval({ scheduleId: followClaim.scheduleId, ownerAIId: 'host',runId: 'other',minutes: 2 })).status,'run_mismatch');
assert.equal((await setAIScheduleFollowUpInterval({ scheduleId:followClaim.scheduleId,ownerAIId:'host',runId:'run-follow',minutes:1 })).status,'error');
assert.equal((await setAIScheduleFollowUpInterval({ scheduleId:followClaim.scheduleId,ownerAIId:'host',runId:'run-follow',minutes:2.5 })).status,'error');
assert.equal((await setAIScheduleFollowUpInterval({ scheduleId: followClaim.scheduleId, ownerAIId: 'host',runId: 'run-follow',minutes: 2 })).status,'updated');
await finish(followClaim,15);
assert.equal(pendingFollowUps()[0].remind_at,at(17),'静默续轮也继续等待，单次覆盖仅影响下一次');
assert.equal((await settingsRepository.get()).followUpIntervalMinutes,10);
assert.equal((await repository.listUnanswered('chat'))[0].firstVisibleAt,at(1));

const normal = await add(make('new-normal',17));
const wake = await repository.getByScheduleId(pendingFollowUps()[0].schedule_id);
const selected = await repository.prepareDispatch({ scheduleId: wake.scheduleId, ownerAIId: 'host', expectedRemindAt: wake.remindAt,
  projectionToken: wake.updatedAt,occurredAt: at(17) });
assert.equal(selected.scheduleId,normal.scheduleId,'碰撞时正常日程优先，携带旧未回复背景');
const next = await claim(selected,'run-next',17);
await finish(next,20,at(18));
assert.equal(pendingFollowUps().length,1);
assert.equal(pendingFollowUps()[0].remind_at,at(30),'新日程重新计算间隔');
assert.deepEqual((await repository.listUnanswered('chat')).map(item => item.firstVisibleAt),[at(1),at(18)],'保留最早未回复时间及多条日程');
db.close(); db = new DatabaseSync(filename);
assert.equal(pendingFollowUps().length,1,'关闭并重开连接后仍只有一个未来续轮');
assert.equal((await repository.listUnanswered('chat'))[0].firstVisibleAt,at(1),'未回复起点持久保存');

await tx.withExclusiveTransactionAsync(() => acknowledgeScheduleReplyInTransaction(tx,'chat',at(21)));
assert.equal(pendingFollowUps().length,0);
assert.deepEqual(await repository.listUnanswered('chat'),[]);
assert.equal((await repository.claimScheduled({ scheduleId: wake.scheduleId,ownerAIId:'host',runId:'stale',claimedAt:at(30),expectedRemindAt:wake.remindAt,projectionToken:wake.updatedAt,conversationId:'chat' })).status,'not_scheduled');

const racing = await claim(await add(make('race',40)),'run-race',40);
await tx.withExclusiveTransactionAsync(() => acknowledgeScheduleReplyInTransaction(tx,'chat',at(41)));
await finish(racing,42,at(40));
assert.equal(pendingFollowUps().length,0,'回复先提交，迟到 consume 不能重新开启等待');
const off = await claim(await add(make('switch',50)),'run-switch',50);
await finish(off,51,at(50));
assert.equal(pendingFollowUps().length,1);
await settingsRepository.update({ followUpEnabled: false });
assert.equal(pendingFollowUps().length,0);
await settingsRepository.update({ followUpEnabled: true });
assert.deepEqual(await repository.listUnanswered('chat'),[],'重新开启不复活旧追问');
assert.equal(pendingFollowUps().length,0);
let releaseSettingsRead; let settingsRead;
const readReady = new Promise(resolve=>{ settingsRead=resolve; });
const readGate = new Promise(resolve=>{ releaseSettingsRead=resolve; });
const delayedSettings = new class extends SQLiteCompanionSettingsRepository {
  async ensureDefault() { const value=await super.ensureDefault(); settingsRead(); await readGate; return value; }
}();
const quietUpdate = delayedSettings.update({quietHoursEnabled:false});
await readReady;
await settingsRepository.update({followUpEnabled:false});
releaseSettingsRead(); await quietUpdate;
assert.equal((await settingsRepository.get()).followUpEnabled,false,'并行保存勿扰偏好不能用旧快照重新开启续轮');
await settingsRepository.update({followUpEnabled:true});

const silent = await claim(await add(make('silent',60)),'run-silent',60);
await finish(silent,61);
assert.equal(pendingFollowUps().length,0,'首次没有可见消息不启动等待');
const batchA = await add(make('batch-a',70));
const batchB = await add(make('batch-b',70));
const batchSelected = await repository.prepareDispatch({ scheduleId: batchA.scheduleId,ownerAIId:'host',
  expectedRemindAt:batchA.remindAt,projectionToken:batchA.updatedAt,occurredAt:at(70) });
assert.equal(batchSelected.scheduleId,batchB.scheduleId);
await finish(await claim(batchSelected,'run-batch',70),71,at(70));
assert.deepEqual((await repository.listUnanswered('chat')).map(item=>item.scheduleId),['batch-a','batch-b']);
await repository.cancelScheduled({ scheduleId:pendingFollowUps()[0].schedule_id,ownerAIId:'host',occurredAt:at(72) });
assert.deepEqual(await repository.listUnanswered('chat'),[],'显式停止续轮结束本次等待');
const displaced = await claim(await add(make('displaced',80)),'run-displaced',80);
const replacement = await add(make('replacement',85));
await repository.mergeClaimedRun('run-displaced',replacement.scheduleId,at(85),at(81));
await finish(await claim(replacement,'run-replacement',85),86,at(85));
assert.deepEqual((await repository.listUnanswered('chat')).map(item=>item.firstVisibleAt),[at(81),at(85)],'新日程接替执行时保留旧轮已发消息');
assert.equal((await repository.consumeClaimed({ scheduleId:displaced.scheduleId,runId:'run-displaced',consumedAt:at(87),completionDisposition:'agent_terminal',firstVisibleAt:at(81) })).status,'already_terminal');
assert.equal(pendingFollowUps().length,1,'被接替的旧 consume 不创建第二个续轮');
await tx.withExclusiveTransactionAsync(() => acknowledgeScheduleReplyInTransaction(tx,'chat',at(88)));
const interrupted = await claim(await add(make('interrupted',90)),'run-interrupted',90);
await repository.consumeClaimed({scheduleId:interrupted.scheduleId,runId:'run-interrupted',consumedAt:at(91),completionDisposition:'interrupted'});
assert.equal(pendingFollowUps().length,0,'中断收口不冒充用户未回复的新行动，也不重跑旧工具');
assert.equal(db.prepare("SELECT active_run_id FROM raven_cat_ai_schedule_wait WHERE conversation_id='chat'").get().active_run_id,null);
const missed = await add(make('missed',0,daily));
await repository.expireScheduled('2026-12-15T01:01:00.000Z');
const future = (await repository.listAllScheduled()).filter(item => item.seriesId === missed.seriesId);
assert.equal(future.length,1);
assert.equal(future[0].remindAt,'2026-12-16T01:00:00.000Z','跳过错过期次，只推进到未来一期');
const cancelled = await repository.cancelScheduled({ scheduleId: future[0].scheduleId,ownerAIId:'host',occurredAt:'2026-12-15T01:02:00.000Z' });
assert.equal(cancelled.status,'cancelled');
await repository.expireScheduled('2027-01-01T00:00:00.000Z');
assert.equal((await repository.listAllScheduled()).filter(item => item.seriesId === missed.seriesId).length,0,'取消下一期即停止重复');
assert.throws(() => db.prepare('UPDATE raven_cat_contact_settings SET follow_up_interval_minutes=1').run());
const application = new AIScheduleApplication({ schedules:repository,now:()=>new Date(at(-120)),generateScheduleId:()=> 'application-series',
  resolveSourceMessages:async()=>{ throw new Error('无来源的日程无需读取聊天'); } });
assert.equal((await application.create({ ownerAIId:'host',remindAt:at(0),summary:'重复输入',details:'规则匹配',recurrence:{...daily,timeZone:'invalid/timezone'} })).code,'invalid_time');
assert.equal((await application.create({ ownerAIId:'host',remindAt:at(1),summary:'重复输入',details:'规则匹配',recurrence:daily })).code,'invalid_time');
assert.equal((await application.create({ ownerAIId:'host',remindAt:at(0),summary:'重复输入',details:'规则匹配',recurrence:daily })).status,'created');
const ruleChange = await application.update({scheduleId:'application-series',ownerAIId:'host',recurrence:{...daily,frequency:'weekly',weekdays:[3]}});
assert.equal(ruleChange.status,'updated');
assert.equal(ruleChange.schedule.remindAt,'2026-11-04T01:00:00.000Z');
assert.equal(ruleChange.schedule.seriesId,'application-series');
assert.equal((await repository.getByScheduleId(first.scheduleId)).status,'consumed','修改未来规则不改写已有执行历史');

// 系统日历关联可独立清理，包括已执行历史；内部事实和已投影的执行版本保持原样。
const linked=await claim(await add({...make('calendar-series',0,daily),systemCalendar:true}),'run-calendar',0);
await finish(linked,1);
const linkedNext=(await repository.listAllScheduled()).find(item=>item.seriesId==='calendar-series');
const beforeLinked=await repository.getByScheduleId(linked.scheduleId);
const beforeLinkedNext=await repository.getByScheduleId(linkedNext.scheduleId);
assert.equal((await application.removeCalendarLinks({ownerAIId:'host',scope:'series'})).code,'invalid_content');
assert.equal((await application.removeCalendarLinks({ownerAIId:'host',scope:'all',scheduleId:linked.scheduleId})).code,'invalid_content');
assert.equal((await application.removeCalendarLinks({ownerAIId:'host',scope:'schedule',scheduleId:'missing'})).code,'not_found');
let detached=await application.removeCalendarLinks({ownerAIId:'host',scope:'schedule',scheduleId:linked.scheduleId});
assert.equal(detached.status,'updated');assert.equal(detached.updatedCount,1);
assert.equal((await repository.getByScheduleId(linkedNext.scheduleId)).systemCalendar,true,'单期清理不擅自清理其他期次');
db.exec("UPDATE raven_cat_companion_state SET desired_enabled=0 WHERE id='default'");
detached=await application.removeCalendarLinks({ownerAIId:'host',scope:'series',scheduleId:linked.scheduleId});
assert.equal(detached.status,'updated');assert.equal(detached.updatedCount,1,'暂停主动伴随也能关闭日历关联');
assert.deepEqual(detached.scheduleIds.sort(),[linked.scheduleId,linkedNext.scheduleId].sort(),'历史一期可以定位整个系列，已关闭的关联也可再次清理残留事件');
assert.deepEqual(await repository.getByScheduleId(linked.scheduleId),{...beforeLinked,systemCalendar:false});
assert.deepEqual(await repository.getByScheduleId(linkedNext.scheduleId),{...beforeLinkedNext,systemCalendar:false},'不改变日程内容、规则、状态或在途投影版本');
db.exec("UPDATE raven_cat_companion_state SET desired_enabled=1 WHERE id='default'");
await repository.claimScheduled({scheduleId:linkedNext.scheduleId,ownerAIId:'host',runId:'calendar-next-run',
  claimedAt:linkedNext.remindAt,expectedRemindAt:linkedNext.remindAt,projectionToken:beforeLinkedNext.updatedAt,conversationId:'chat'});
const later=(await repository.listAllScheduled()).find(item=>item.seriesId==='calendar-series');
assert.equal(later.systemCalendar,false,'下一次实际推进继续保持仅应用内');
assert.equal((await application.removeCalendarLinks({ownerAIId:'host',scope:'series',scheduleId:linked.scheduleId})).updatedCount,0);
await add({...make('calendar-foreign',120),systemCalendar:true});
db.exec("UPDATE raven_cat_ai_schedules SET owner_ai_id='other-host' WHERE schedule_id='calendar-foreign'");
assert.equal((await application.removeCalendarLinks({ownerAIId:'host',scope:'schedule',scheduleId:'calendar-foreign'})).code,'not_owner');
await add({...make('calendar-cancelled',120),systemCalendar:true});
await repository.cancelScheduled({scheduleId:'calendar-cancelled',ownerAIId:'host',occurredAt:at(0)});
await application.removeCalendarLinks({ownerAIId:'host',scope:'all'});
assert.equal((await repository.getByScheduleId('calendar-cancelled')).status,'cancelled');
assert.equal((await repository.getByScheduleId('calendar-cancelled')).systemCalendar,false);
assert.equal((await repository.getByScheduleId('calendar-foreign')).systemCalendar,true,'批量仅清理当前 AI 的关联');
console.log('AI 日程固定重复、未回复续轮与回复竞态验证通过');
} finally { db.close(); fs.unlinkSync(filename); }
