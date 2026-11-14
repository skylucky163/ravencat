/** 真实 SQLite 验证日程失效、碰撞归并与一次性提示词交接，不调用模型或 Android。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-schedule-context-'));
const filename = path.join(directory, 'context.sqlite');
let db = new DatabaseSync(filename);
const tx = {
  execAsync: async sql => db.exec(sql),
  runAsync: async (sql, args = []) => db.prepare(sql).run(...args),
  getFirstAsync: async (sql, args = []) => db.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql, args = []) => db.prepare(sql).all(...args),
  async withExclusiveTransactionAsync(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = await action(tx); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const modules = new Map();
let dependencies;
function load(file) {
  const full = path.resolve(root, file.endsWith('.ts') ? file : file + '.ts');
  if (modules.has(full)) return modules.get(full).exports;
  const module = { exports: {} }; modules.set(full, module);
  const compiled = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(id => {
    if (id === '@platform/persistence') return { databaseCoordinator: { openTaskExecutor: () => tx } };
    if (id === './CompanionRuntimeDependencies') return { getCompanionRuntimeDependencies: () => dependencies };
    assert.ok(id.startsWith('.'), `未声明外部边界 ${id}`);
    return load(path.resolve(path.dirname(full), id));
  }, module, module.exports);
  return module.exports;
}
const schema = load('src/platform/persistence/sqlite/ravenCatCompanionSchema');
const { SQLiteAIScheduleRepository } = load('src/features/companion/infrastructure/SQLiteAIScheduleRepository');
const { loadAIScheduleContext } = load('src/features/companion/application/AIScheduleContext');
const repository = new SQLiteAIScheduleRepository();
const now = new Date();
const at = offset => new Date(now.getTime() + offset * 60000).toISOString();
db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE ai_assistants(id TEXT PRIMARY KEY);
  INSERT INTO ai_assistants VALUES ('host'),('other');
  CREATE TABLE conversation_turn_runs(run_id TEXT PRIMARY KEY,status TEXT,terminal_reason TEXT);`);
db.exec(schema.RAVEN_CAT_COMPANION_STATE_SCHEMA);
// 从旧约束升级，证明既有计划不丢失，而新增终结原因可以正常写入。
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_SCHEMA.replace("IN ('owner_revoked', 'expired', 'merged_schedule', 'merged_chat')", "= 'owner_revoked'"));
db.prepare(`INSERT INTO raven_cat_companion_state(id,desired_enabled,activation_status,host_ai_id,created_at,updated_at)
  VALUES('default',1,'enabled','host',?,?)`).run(at(-60), at(-60));
const make = (id, remindAt = at(30)) => ({ scheduleId: id, ownerAIId: 'host', remindAt,
  summary: `安排 ${id}`, details: `背景 ${id}`, systemCalendar: false,
  sourceConversationId: null, sourceMessageIds: null, sourceExcerpt: null,
  status: 'scheduled', claimedByRunId: null, claimedAt: null, consumedAt: null,
  completionDisposition: null, cancelledAt: null, cancelledReason: null, createdAt: at(-60), updatedAt: at(-60) });
async function add(id, remindAt) {
  const item = make(id, remindAt);
  assert.equal((await repository.createScheduled(item, at(-90))).status, 'created');
  return item;
}
function dispatch(item, occurredAt = at(0)) {
  return { scheduleId: item.scheduleId, ownerAIId: item.ownerAIId, expectedRemindAt: item.remindAt,
    projectionToken: item.updatedAt, occurredAt };
}
function setRun(id, status, reason = null) {
  db.prepare(`INSERT INTO conversation_turn_runs VALUES(?,?,?) ON CONFLICT(run_id)
    DO UPDATE SET status=excluded.status,terminal_reason=excluded.terminal_reason`).run(id, status, reason);
}
dependencies = { repositories: { aiSchedules: repository }, chat: { listTurnStates: async ids =>
  db.prepare('SELECT run_id AS runId,status,terminal_reason AS reason FROM conversation_turn_runs WHERE run_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)) } };
const context = (runId, targetScheduleId = null) => loadAIScheduleContext({ ownerAIId: 'host', runId, targetScheduleId });

try {
  await add('upgrade-preserved');
  await tx.withExclusiveTransactionAsync(() => schema.migrateAIScheduleContext(tx));
  db.exec('CREATE TABLE raven_cat_contact_settings(id TEXT PRIMARY KEY)');
  await tx.withExclusiveTransactionAsync(() => schema.migrateAIScheduleTiming(tx));
  db.exec(schema.RAVEN_CAT_AI_SCHEDULE_WAIT_SCHEMA);
  db.exec("INSERT INTO raven_cat_contact_settings(id) VALUES ('default')");
  assert.equal((await repository.getByScheduleId('upgrade-preserved')).summary, '安排 upgrade-preserved');
  const expired = await add('expired', at(-40));
  const expired2 = await add('expired-2', at(-30));
  assert.equal(await repository.prepareDispatch(dispatch(expired)), null);
  for (const item of [expired, expired2]) {
    const saved = await repository.getByScheduleId(item.scheduleId);
    assert.equal(saved.status, 'cancelled'); assert.equal(saved.cancelledReason, 'expired');
    assert.equal(await repository.prepareDispatch(dispatch(item)), null, '回前台恢复的旧系统投递不能重新领取');
  }
  const edge = await add('edge', at(-15));
  assert.equal((await repository.prepareDispatch(dispatch(edge))).scheduleId, 'edge', '恰好十五分钟仍在领取窗口内');
  const claim = await repository.claimScheduled({ conversationId: 'test-chat', ...dispatch(edge, new Date(now.getTime() + 1).toISOString()),
    claimedAt: new Date(now.getTime() + 1).toISOString(), runId: 'expired-before-claim' });
  assert.equal(claim.status, 'already_past', '资格交接期间跨过截止时间也不得启动模型');

  const a = await add('older', at(-4));
  const b = await add('latest', at(-1));
  const selected = await repository.prepareDispatch(dispatch(a));
  assert.equal(selected.scheduleId, b.scheduleId);
  assert.equal((await repository.getByScheduleId(a.scheduleId)).cancelledReason, 'merged_schedule');
  setRun('latest-run', 'active');
  const latestContext = await context('latest-run', b.scheduleId);
  assert.match(latestContext, /背景 older/);
  assert.doesNotMatch(latestContext, /安排 expired/, '失败摘要不额外唤醒 AI，只给下一次正常聊天');
  setRun('latest-run', 'committed');

  await repository.mergeScheduled(b.scheduleId, null, at(0));
  setRun('user-first', 'active');
  const first = await context('user-first');
  assert.match(first, /安排 expired/); assert.match(first, /背景 latest/);
  assert.doesNotMatch(first, /背景 older/, '归并目标改变后，也不能重新投递先前成功回复已经收到的资料');
  assert.match(first, /get_ai_schedule/);
  setRun('user-first', 'failed');
  setRun('user-second', 'active');
  const second = await context('user-second');
  assert.match(second, /安排 expired/, '只组装或请求失败不能丢失待告知结果');
  setRun('user-second', 'committed');
  assert.equal(await context('user-third'), '', '成功提交后单次告知结束');

  const c = await add('chat-collision', at(-1));
  await repository.mergeDueIntoChat('host', at(0));
  setRun('chat-live', 'active');
  assert.match(await context('chat-live'), /背景 chat-collision/);
  assert.equal((await repository.getByScheduleId(c.scheduleId)).cancelledReason, 'merged_chat');
  assert.equal(await repository.prepareDispatch(dispatch(c)), null);
  assert.equal(await context('other-live'), '', '另一个进行中的请求不能抢走已绑定结果');
  setRun('chat-live', 'cancelled');
  assert.match(await context('chat-retry'), /背景 chat-collision/);
  setRun('chat-retry', 'committed'); await context('after-chat');

  const failed = await add('model-failed', at(-1));
  assert.equal((await repository.claimScheduled({ conversationId: 'test-chat', ...dispatch(failed), claimedAt: at(0), runId: 'failed-run' })).status, 'claimed');
  await repository.consumeClaimed({ scheduleId: failed.scheduleId, runId: 'failed-run', consumedAt: at(0),
    completionDisposition: 'agent_terminal', failureCode: 'MODEL_REQUEST_FAILED' });
  setRun('failure-feedback', 'active');
  assert.match(await context('failure-feedback'), /MODEL_REQUEST_FAILED/);
  setRun('failure-feedback', 'committed');
  assert.equal(await context('failure-after'), '');

  const interrupted = await add('interrupted-task', at(-1));
  await repository.claimScheduled({ conversationId: 'test-chat', ...dispatch(interrupted), claimedAt: at(0), runId: 'old-autonomous' });
  setRun('old-autonomous', 'superseded', 'new_input'); setRun('user-wins', 'active');
  await repository.mergeClaimedRun('old-autonomous', null, at(0));
  assert.match(await context('user-wins'), /背景 interrupted-task/, '旧 run 未到 finally 时，新聊天也能得到交接背景');
  assert.equal((await repository.getByScheduleId(interrupted.scheduleId)).status, 'consumed');
  await repository.consumeClaimed({ scheduleId: interrupted.scheduleId, runId: 'old-autonomous', consumedAt: at(0),
    completionDisposition: 'interrupted', failureCode: 'CANCELLED_BY_USER' });
  assert.match(await context('user-wins'), /merged_chat/, '旧 finally 的失败信息不能覆盖已经交接的背景');

  const consumedEarly = await add('consumed-before-handoff', at(-1));
  await repository.claimScheduled({ conversationId: 'test-chat', ...dispatch(consumedEarly), claimedAt: at(0), runId: 'old-consumed' });
  await repository.consumeClaimed({ scheduleId: consumedEarly.scheduleId, runId: 'old-consumed', consumedAt: at(0),
    completionDisposition: 'agent_terminal' });
  await repository.mergeClaimedRun('old-consumed', null, at(0));
  assert.match(await context('user-after-race'), /背景 consumed-before-handoff/,
    'T1 后的宿主交接必须覆盖旧 finally 抢先 consume 的情形');

  // 在读取与绑定之间被新归并抢先提交：CAS 使迟到绑定无法窃取或确认结果。
  const race = await add('race', at(-1));
  await repository.mergeScheduled(race.scheduleId, 'target-a', at(0));
  const stale = await repository.listPendingContext('host', 'target-a');
  await repository.mergeScheduled((await add('target-a', at(-1))).scheduleId, 'target-b', at(0));
  assert.deepEqual(await repository.bindContext({ runId: 'late', occurredAt: at(0), acknowledge: [], present: stale }), []);
  assert.ok((await repository.listPendingContext('host', 'target-b')).some(item => item.scheduleId === race.scheduleId));
  for (let index = 0; index < 22; index++) {
    const item = await add(`bulk-${index}`, at(-1));
    await repository.mergeScheduled(item.scheduleId, 'bulk-target', at(0));
  }
  setRun('bulk-run', 'active');
  const bulk = await context('bulk-run', 'bulk-target');
  assert.match(bulk, /"totalCount":22/);
  assert.match(bulk, /尚未展开/);
  assert.ok(bulk.length < 8_000, '积压结果只能形成有界摘要，不挤爆当前对话');
  setRun('bulk-run', 'committed');
  assert.equal(await context('after-bulk', 'bulk-target'), '', '汇总成功交付后未展开记录也不能变成永远等待已结束日程的残留');
  const inherited = await add('source-failure', at(-4));
  const failedTarget = await add('target-failure', at(-1));
  assert.equal((await repository.prepareDispatch(dispatch(inherited))).scheduleId, failedTarget.scheduleId);
  await repository.claimScheduled({ conversationId: 'test-chat', ...dispatch(failedTarget), claimedAt: at(0), runId: 'inherited-failed-run' });
  setRun('inherited-failed-run', 'active');
  assert.match(await context('inherited-failed-run', failedTarget.scheduleId), /背景 source-failure/);
  setRun('inherited-failed-run', 'failed');
  await repository.consumeClaimed({ scheduleId: failedTarget.scheduleId, runId: 'inherited-failed-run', consumedAt: at(0),
    completionDisposition: 'agent_terminal', failureCode: 'MODEL_REQUEST_FAILED' });
  const inheritedFeedback = await context('after-inherited-failure');
  assert.match(inheritedFeedback, /背景 source-failure/);
  assert.match(inheritedFeedback, /MODEL_REQUEST_FAILED/, '胜出日程失败后，它继承的旧背景必须一并转交聊天');
  const restart = await add('restart-task', at(-1));
  await repository.mergeScheduled(restart.scheduleId, null, at(0), 'dispatch_failed');
  setRun('restart-reply', 'active');
  assert.match(await context('restart-reply'), /restart-task/);
  setRun('restart-reply', 'committed');
  db.close(); db = new DatabaseSync(filename);
  assert.doesNotMatch(await context('after-reopen'), /restart-task/, '数据库重开后仍以真实 committed 凭据消除已告知结果');
  console.log('AI 日程：15 分钟失效、最新归并、聊天优先、失败结果、单次交接与迟到凭据 CAS 验证通过。');
} finally {
  db.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true });
}
