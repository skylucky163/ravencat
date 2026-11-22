import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { RAVEN_CAT_SELF_WAKES_SCHEMA } from '../helpers/legacy-self-wake-schema-fixture.mjs';
import { loadSqliteModule } from '../helpers/sqlite-bootstrap-fixture.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-cat-ai-schedule-'));

async function importTypeScriptModule(relativePath, transform = (source) => source) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(transform(fs.readFileSync(sourcePath, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  });
  const target = path.join(tmpDir, `${path.basename(relativePath, '.ts')}.mjs`);
  fs.writeFileSync(target, output.outputText
    .replaceAll("'./AIScheduleTiming'", "'./AIScheduleTiming.mjs'")
    .replaceAll("'../domain/AIScheduleTiming'", "'./AIScheduleTiming.mjs'")
    .replaceAll("'./AIScheduleTimingPersistence'", "'./AIScheduleTimingPersistence.mjs'"), 'utf8');
  return import(`${pathToFileURL(target).href}?v=${Date.now()}-${Math.random()}`);
}

await importTypeScriptModule('src/features/companion/domain/AIScheduleTiming.ts');
const domain = await importTypeScriptModule('src/features/companion/domain/AISchedule.ts');
const schema = loadSqliteModule('ravenCatCompanionSchema');

assert.throws(() => domain.createAISchedule({
  scheduleId: 'invalid-transition',
  ownerAIId: 'host-ai',
  remindAt: '2026-09-10T09:00:00.000Z',
  summary: '非法状态组合',
  details: 'scheduled 不能预先拥有 claim fact',
  sourceConversationId: null,
  sourceMessageIds: null,
  sourceExcerpt: null,
  status: 'scheduled',
  claimedByRunId: 'run-a',
  claimedAt: '2026-09-10T09:00:00.000Z',
  consumedAt: null,
  completionDisposition: null,
  cancelledAt: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  updatedAt: '2026-09-09T08:00:00.000Z',
}));

await importTypeScriptModule('src/features/companion/domain/CompanionState.ts');
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE ai_assistants (id TEXT PRIMARY KEY); INSERT INTO ai_assistants VALUES ('host-ai')");
db.exec(schema.RAVEN_CAT_COMPANION_STATE_SCHEMA);
db.exec("INSERT INTO raven_cat_companion_state (id, desired_enabled, activation_status, host_ai_id, created_at, updated_at) VALUES ('default', 1, 'enabled', 'host-ai', '2026-09-01', '2026-09-01')");
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_SCHEMA);
db.exec(schema.RAVEN_CAT_AI_SCHEDULE_CONTEXT_SCHEMA);
db.exec(schema.RAVEN_CAT_AI_SCHEDULE_WAIT_SCHEMA);
db.exec("CREATE TABLE raven_cat_contact_settings(id TEXT PRIMARY KEY, follow_up_enabled INTEGER DEFAULT 0, follow_up_interval_minutes INTEGER DEFAULT 10); INSERT INTO raven_cat_contact_settings(id) VALUES ('default');");
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX);
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX);
// fresh schema 与 upgrade migration 复用的语句可重复执行，不能损坏已有 truth。
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_SCHEMA);
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX);
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX);

assert.equal(
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='raven_cat_ai_schedules'`)
    .get().name,
  'raven_cat_ai_schedules',
);
assert.deepEqual(
  db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='raven_cat_ai_schedules'`)
    .all().map(({ name }) => name).sort(),
  [
    'idx_raven_cat_ai_schedules_owner_status_time',
    'idx_raven_cat_ai_schedules_owner_time',
    'sqlite_autoindex_raven_cat_ai_schedules_1',
  ],
);

globalThis.__aiScheduleExecutor = {
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params),
  getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
  withExclusiveTransactionAsync: async (task) => {
    db.exec('BEGIN EXCLUSIVE');
    try {
      const result = await task(globalThis.__aiScheduleExecutor);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
};
fs.writeFileSync(path.join(tmpDir, 'TestPersistence.mjs'), `
  export const databaseCoordinator = {
    openTaskExecutor: () => globalThis.__aiScheduleExecutor,
  };
`, 'utf8');
fs.writeFileSync(path.join(tmpDir, 'TestCompanionRuntime.mjs'), `
  export function getCompanionRuntimeDependencies() {
    throw new Error('专项 verifier 不使用 production singleton');
  }
`, 'utf8');

await importTypeScriptModule('src/features/companion/infrastructure/AIScheduleTimingPersistence.ts', source => source
  .replace("'../domain/AISchedule'", "'./AISchedule.mjs'"));
const repositoryModule = await importTypeScriptModule(
  'src/features/companion/infrastructure/SQLiteAIScheduleRepository.ts',
  (source) => source
    .replace("'@platform/persistence'", "'./TestPersistence.mjs'")
    .replace("'../domain/AISchedule'", "'./AISchedule.mjs'")
    .replace("'../domain/CompanionState'", "'./CompanionState.mjs'"),
);
const applicationModule = await importTypeScriptModule(
  'src/features/companion/application/AIScheduleApplication.ts',
  (source) => source
    .replace("'../domain/AISchedule'", "'./AISchedule.mjs'")
    .replace("'../domain/CompanionState'", "'./CompanionState.mjs'")
    .replace("'./CompanionRuntimeDependencies'", "'./TestCompanionRuntime.mjs'"),
);
const recoveryModule = await importTypeScriptModule(
  'src/features/companion/application/AIScheduleRecovery.ts',
  (source) => source
    .replace("'../domain/AISchedule'", "'./AISchedule.mjs'")
    .replace("'../domain/CompanionState'", "'./CompanionState.mjs'")
    .replace("'./CompanionRuntimeDependencies'", "'./TestCompanionRuntime.mjs'"),
);

const repository = new repositoryModule.SQLiteAIScheduleRepository();
let now = new Date('2026-09-08T08:00:00.000Z');
let nextId = 1;
let sourceMode = 'valid';
const application = new applicationModule.AIScheduleApplication({
  schedules: repository,
  generateScheduleId: () => `schedule-${nextId++}`,
  now: () => now,
  resolveSourceMessages: async ({ conversationId, messageIds }) => {
    if (sourceMode !== 'valid' || conversationId !== 'session-a' || messageIds.includes('999')) {
      return { status: 'invalid_source' };
    }
    return {
      status: 'resolved',
      messages: [
        { messageId: '11', conversationId, role: 'user', text: '  明天要考试  ', createdAt: '2026-09-08T07:00:00.000Z' },
        { messageId: '12', conversationId, role: 'assistant', text: '我记得了', createdAt: '2026-09-08T07:01:00.000Z' },
      ].filter(({ messageId }) => messageIds.includes(messageId)),
    };
  },
});

const create = (overrides = {}) => application.create({
  ownerAIId: 'host-ai',
  remindAt: '2026-09-10T09:00:00.000Z',
  summary: '数据库考试',
  details: '考试前重新结合最新上下文判断是否需要行动。',
  ...overrides,
});

// 关闭后的事务不能创建／修改／claim；保留计划，查询和取消仍可用。
const paused = await create({ summary: '暂停后保留' });
db.exec("UPDATE raven_cat_companion_state SET desired_enabled = 0, activation_status = 'disabled'");
assert.equal((await create()).code, 'companion_disabled');
assert.equal((await application.update({ scheduleId: paused.schedule.scheduleId, ownerAIId: 'host-ai', summary: '关闭期间修改' })).code, 'companion_disabled');
assert.equal((await application.claim({ conversationId: 'test-chat', scheduleId: paused.schedule.scheduleId, ownerAIId: 'host-ai', runId: 'late-callback', claimedAt: '2026-09-10T09:01:00.000Z', expectedRemindAt: paused.schedule.remindAt, projectionToken: paused.schedule.updatedAt })).code, 'companion_disabled');
assert.equal((await repository.getByScheduleId(paused.schedule.scheduleId)).status, 'scheduled');
assert.equal((await application.cancel({ scheduleId: paused.schedule.scheduleId, ownerAIId: 'host-ai' })).status, 'cancelled');
db.exec("UPDATE raven_cat_companion_state SET desired_enabled = 1, activation_status = 'enabled'");
nextId = 1;
db.prepare('DELETE FROM raven_cat_ai_schedules WHERE schedule_id = ?').run(paused.schedule.scheduleId);

// A/B/C：future 创建、稳定 identity、canonical bounded snapshot、过去与非法来源拒绝。
const calendarSchedule = await create({ systemCalendar: true });
assert.equal(calendarSchedule.schedule.systemCalendar, true);
assert.equal((await repository.getByScheduleId(calendarSchedule.schedule.scheduleId)).systemCalendar, true);
assert.equal((await application.update({ scheduleId: calendarSchedule.schedule.scheduleId, ownerAIId: 'host-ai', systemCalendar: false })).schedule.systemCalendar, false);
assert.equal((await repository.getByScheduleId(calendarSchedule.schedule.scheduleId)).systemCalendar, false);
db.prepare('DELETE FROM raven_cat_ai_schedules WHERE schedule_id = ?').run(calendarSchedule.schedule.scheduleId);
nextId = 1;
const first = await create({
  sourceConversationId: 'session-a',
  sourceMessageIds: ['12', '11'],
});
assert.equal(first.status, 'created');
assert.equal(first.schedule.scheduleId, 'schedule-1');
assert.equal(first.schedule.status, 'scheduled');
assert.equal(first.schedule.ownerAIId, 'host-ai');
assert.deepEqual(first.schedule.sourceMessageIds, ['11', '12']);
assert.equal(first.schedule.sourceExcerpt, '用户：明天要考试\nAI：我记得了');
assert.equal((await create({ remindAt: now.toISOString() })).code, 'invalid_time');
assert.equal((await create({ sourceConversationId: 'session-a', sourceMessageIds: ['999'] })).code, 'invalid_source');

// D/E/F/G/L：future update/cancel 成功；到期未 claim 也不可重写；终态保留且不可逆。
const updated = await application.update({
  scheduleId: first.schedule.scheduleId,
  ownerAIId: 'host-ai',
  remindAt: '2026-09-11T09:00:00.000Z',
  summary: '数据库考试（改期）',
});
assert.equal(updated.status, 'updated');
assert.equal(updated.schedule.scheduleId, first.schedule.scheduleId);
assert.equal(updated.schedule.createdAt, first.schedule.createdAt);
assert.equal(updated.schedule.sourceExcerpt, first.schedule.sourceExcerpt);

const due = await create({ remindAt: '2026-09-09T08:00:00.000Z' });
assert.equal(due.status, 'created');
now = new Date('2026-09-09T08:00:00.000Z');
assert.equal((await application.update({
  scheduleId: due.schedule.scheduleId,
  ownerAIId: 'host-ai',
  summary: '篡改过去',
})).code, 'already_past');
assert.equal((await application.cancel({
  scheduleId: due.schedule.scheduleId,
  ownerAIId: 'host-ai',
})).code, 'already_past');

now = new Date('2026-09-09T09:00:00.000Z');
const cancellable = await create({ remindAt: '2026-09-12T09:00:00.000Z' });
const cancelled = await application.cancel({
  scheduleId: cancellable.schedule.scheduleId,
  ownerAIId: 'host-ai',
});
assert.equal(cancelled.status, 'cancelled');
assert.equal((await repository.getByScheduleId(cancellable.schedule.scheduleId)).status, 'cancelled');
assert.equal((await application.update({
  scheduleId: cancellable.schedule.scheduleId,
  ownerAIId: 'host-ai',
  details: '不能修改',
})).code, 'not_scheduled');

// H/I/J/K/L：claim 单 winner；consume 绑定 claim run；consumed 不可修改/取消。
const claimable = await create({ remindAt: '2026-09-13T09:00:00.000Z' });
const claimableToken = claimable.schedule.updatedAt;
const claimed = await application.claim({ conversationId: 'test-chat',
  scheduleId: claimable.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-a',
  claimedAt: '2026-09-13T09:01:00.000Z',
  expectedRemindAt: '2026-09-13T09:00:00.000Z',
  projectionToken: claimableToken,
});
assert.equal(claimed.status, 'claimed');
assert.equal(claimed.schedule.claimedByRunId, 'run-a');
assert.equal((await application.claim({ conversationId: 'test-chat',
  scheduleId: claimable.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-b',
  claimedAt: '2026-09-13T09:02:00.000Z',
  expectedRemindAt: '2026-09-13T09:00:00.000Z',
  projectionToken: claimableToken,
})).code, 'already_claimed');
assert.equal((await application.consume({
  scheduleId: claimable.schedule.scheduleId,
  runId: 'run-b',
  consumedAt: '2026-09-13T09:03:00.000Z',
  completionDisposition: 'agent_terminal',
})).code, 'run_mismatch');
const consumed = await application.consume({
  scheduleId: claimable.schedule.scheduleId,
  runId: 'run-a',
  consumedAt: '2026-09-13T09:04:00.000Z',
  completionDisposition: 'agent_terminal',
});
assert.equal(consumed.status, 'consumed');
assert.equal(consumed.schedule.completionDisposition, 'agent_terminal');
assert.equal((await application.cancel({
  scheduleId: claimable.schedule.scheduleId,
  ownerAIId: 'host-ai',
})).code, 'not_scheduled');

// M/N：范围、状态、稳定排序与分页；list 只给轻量字段，get 才给详情/source。
now = new Date('2026-09-09T10:00:00.000Z');
await create({ remindAt: '2026-09-14T09:00:00.000Z', summary: '后一个' });
await create({ remindAt: '2026-09-14T08:00:00.000Z', summary: '前一个' });
await create({ remindAt: '2026-09-14T09:00:00.000Z' });
const listed = await application.list({
  ownerAIId: 'host-ai',
  from: '2026-09-08T00:00:00.000Z',
  to: '2026-09-20T00:00:00.000Z',
  status: 'scheduled',
  limit: 2,
});
assert.equal(listed.status, 'listed');
assert.equal(listed.page.items.length, 2);
assert.ok(listed.page.items[0].remindAt <= listed.page.items[1].remindAt);
assert.deepEqual(Object.keys(listed.page.items[0]).sort(), ['remindAt', 'scheduleId', 'status', 'summary']);
assert.equal(listed.page.hasMore, true);
assert.ok(listed.page.nextCursor);
assert.equal((await application.list({
  ownerAIId: 'host-ai',
  from: '2026-09-08T00:00:00.000Z',
  to: '2026-09-08T12:00:00.000Z',
})).code, 'invalid_range');
assert.equal((await application.list({
  ownerAIId: 'host-ai',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-06-01T00:00:00.000Z',
})).code, 'invalid_range');
const detail = await application.get({ scheduleId: first.schedule.scheduleId, ownerAIId: 'host-ai' });
assert.equal(detail.status, 'found');
assert.equal(detail.schedule.details, '考试前重新结合最新上下文判断是否需要行动。');
assert.ok(detail.schedule.sourceExcerpt);
assert.equal((await application.get({ scheduleId: first.schedule.scheduleId, ownerAIId: 'other-ai' })).code, 'not_owner');

// O：新 Repository/Application 实例只从同一个 SQLite durable truth 恢复状态。
const restartedRepository = new repositoryModule.SQLiteAIScheduleRepository();
const restarted = await restartedRepository.getByScheduleId(claimable.schedule.scheduleId);
assert.equal(restarted.status, 'consumed');
assert.equal(restarted.claimedByRunId, 'run-a');
assert.equal(restarted.consumedAt, '2026-09-13T09:04:00.000Z');
assert.equal(restarted.completionDisposition, 'agent_terminal');

// P1-1：分别模拟 claim 后 Agent 启动前 crash、以及 Agent 已开始但进程中途 crash。
// 两者都没有 durable Agent terminal evidence；新 recovery 只能按各自原始
// scheduleId + claimedByRunId CAS 收口为 interrupted，不得重跑或回到 scheduled。
const interrupted = await create({
  remindAt: '2026-09-15T09:00:00.000Z',
  summary: '进程中断日程',
});
const interruptedClaim = await application.claim({ conversationId: 'test-chat',
  scheduleId: interrupted.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-interrupted',
  claimedAt: '2026-09-15T09:01:00.000Z',
  expectedRemindAt: '2026-09-15T09:00:00.000Z',
  projectionToken: interrupted.schedule.updatedAt,
});
assert.equal(interruptedClaim.status, 'claimed');
const interruptedMidRun = await create({
  remindAt: '2026-09-15T09:10:00.000Z',
  summary: '运行中断日程',
});
const interruptedMidRunClaim = await application.claim({ conversationId: 'test-chat',
  scheduleId: interruptedMidRun.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-interrupted-mid-run',
  claimedAt: '2026-09-15T09:11:00.000Z',
  expectedRemindAt: '2026-09-15T09:10:00.000Z',
  projectionToken: interruptedMidRun.schedule.updatedAt,
});
assert.equal(interruptedMidRunClaim.status, 'claimed');
const recovery = new recoveryModule.AIScheduleRecovery({
  schedules: repository,
  now: () => new Date('2026-09-15T09:02:00.000Z'),
});
const recovered = await recovery.recover('cold_start');
assert.deepEqual(recovered, {
  mode: 'cold_start', examined: 2, skippedActive: 0, recovered: 2, alreadyTerminal: 0,
});
const interruptedAfterRecovery = await repository.getByScheduleId(interrupted.schedule.scheduleId);
assert.equal(interruptedAfterRecovery.status, 'consumed');
assert.equal(interruptedAfterRecovery.completionDisposition, 'interrupted');
assert.equal(
  (await repository.getByScheduleId(interruptedMidRun.schedule.scheduleId)).completionDisposition,
  'interrupted',
);
assert.equal((await recovery.recover('foreground')).examined, 0);

// 同一 runtime 内 active claim 必须被 recovery 跳过；终态 transaction 完成后
// 才释放 active 标记，随后才允许下一次 recovery 观察到 consumed。
const active = await create({ remindAt: '2026-09-16T09:00:00.000Z', summary: '活动运行日程' });
const activeClaim = await recovery.claimAndTrack('run-active', () => application.claim({ conversationId: 'test-chat',
  scheduleId: active.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-active',
  claimedAt: '2026-09-16T09:01:00.000Z',
  expectedRemindAt: '2026-09-16T09:00:00.000Z',
  projectionToken: active.schedule.updatedAt,
}));
assert.equal(activeClaim.status, 'claimed');
const skippedActive = await recovery.recover('foreground');
assert.deepEqual(skippedActive, {
  mode: 'foreground', examined: 1, skippedActive: 1, recovered: 0, alreadyTerminal: 0,
});
await recovery.completeTrackedRun(
  'run-active',
  'agent_terminal',
  () => application.consume({
    scheduleId: active.schedule.scheduleId,
    runId: 'run-active',
    consumedAt: '2026-09-16T09:02:00.000Z',
    completionDisposition: 'agent_terminal',
  }),
);
assert.equal((await repository.getByScheduleId(active.schedule.scheduleId)).status, 'consumed');

// recovery 与正常 consume 并发：正常 consume 先赢时，recovery 只能得到
// already_terminal；两条路径都不重复执行，也不覆盖先提交的 disposition。
const race = await create({ remindAt: '2026-09-17T09:00:00.000Z', summary: '并发收口日程' });
const raceClaim = await application.claim({ conversationId: 'test-chat',
  scheduleId: race.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-race',
  claimedAt: '2026-09-17T09:01:00.000Z',
  expectedRemindAt: '2026-09-17T09:00:00.000Z',
  projectionToken: race.schedule.updatedAt,
});
assert.equal(raceClaim.status, 'claimed');
let releaseRecoveryList;
let recoveryListStartedResolve;
const recoveryListStarted = new Promise((resolve) => {
  recoveryListStartedResolve = resolve;
});
const recoveryGate = new Promise((resolve) => {
  releaseRecoveryList = resolve;
});
const racingRecovery = new recoveryModule.AIScheduleRecovery({
  schedules: {
    listAllClaimed: async () => {
      const rows = await repository.listAllClaimed();
      recoveryListStartedResolve();
      await recoveryGate;
      return rows.filter((schedule) => schedule.scheduleId === race.schedule.scheduleId);
    },
    consumeClaimed: (input) => repository.consumeClaimed(input),
  },
  now: () => new Date('2026-09-17T09:02:00.000Z'),
});
const recoveryPromise = racingRecovery.recover('foreground');
await recoveryListStarted;
const normalRaceConsume = await application.consume({
  scheduleId: race.schedule.scheduleId,
  runId: 'run-race',
  consumedAt: '2026-09-17T09:02:01.000Z',
  completionDisposition: 'agent_terminal',
});
assert.equal(normalRaceConsume.status, 'consumed');
releaseRecoveryList();
assert.deepEqual(await recoveryPromise, {
  mode: 'foreground', examined: 1, skippedActive: 0, recovered: 0, alreadyTerminal: 1,
});
assert.equal(
  (await repository.getByScheduleId(race.schedule.scheduleId)).completionDisposition,
  'agent_terminal',
);

// 反向顺序：recovery 先赢，迟到的原 run consume 只得到 already_terminal。
const recoveryWins = await create({
  remindAt: '2026-09-18T09:00:00.000Z',
  summary: '恢复先赢日程',
});
const recoveryWinsClaim = await application.claim({ conversationId: 'test-chat',
  scheduleId: recoveryWins.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-recovery-wins',
  claimedAt: '2026-09-18T09:01:00.000Z',
  expectedRemindAt: '2026-09-18T09:00:00.000Z',
  projectionToken: recoveryWins.schedule.updatedAt,
});
assert.equal(recoveryWinsClaim.status, 'claimed');
const recoveryWinsResult = await new recoveryModule.AIScheduleRecovery({
  schedules: repository,
  now: () => new Date('2026-09-18T09:02:00.000Z'),
}).recover('cold_start');
assert.deepEqual(recoveryWinsResult, {
  mode: 'cold_start', examined: 1, skippedActive: 0, recovered: 1, alreadyTerminal: 0,
});
assert.equal((await application.consume({
  scheduleId: recoveryWins.schedule.scheduleId,
  runId: 'run-recovery-wins',
  consumedAt: '2026-09-18T09:03:00.000Z',
  completionDisposition: 'agent_terminal',
})).code, 'already_terminal');

// Agent 已返回正式 terminal，但 consume 所在 runtime/SQLite 暂时失败时，
// 同一进程的 pending evidence 必须让后续 recovery 保留 agent_terminal，不能
// 把已经确认的 Agent 终态降级成 interrupted。
const pendingTerminal = await create({
  remindAt: '2026-09-19T09:00:00.000Z',
  summary: 'terminal pending 日程',
});
const pendingClaim = await recovery.claimAndTrack('run-pending-terminal', () => application.claim({ conversationId: 'test-chat',
  scheduleId: pendingTerminal.schedule.scheduleId,
  ownerAIId: 'host-ai',
  runId: 'run-pending-terminal',
  claimedAt: '2026-09-19T09:01:00.000Z',
  expectedRemindAt: '2026-09-19T09:00:00.000Z',
  projectionToken: pendingTerminal.schedule.updatedAt,
}));
assert.equal(pendingClaim.status, 'claimed');
await assert.rejects(
  recovery.completeTrackedRun(
    'run-pending-terminal',
    'agent_terminal',
    async () => { throw new Error('consume temporarily unavailable'); },
  ),
  /consume temporarily unavailable/,
);
const pendingRecovered = await recovery.recover('foreground');
assert.deepEqual(pendingRecovered, {
  mode: 'foreground', examined: 1, skippedActive: 0, recovered: 1, alreadyTerminal: 0,
});
assert.equal(
  (await repository.getByScheduleId(pendingTerminal.schedule.scheduleId)).completionDisposition,
  'agent_terminal',
);

// 表级状态组合约束独立保护 SQLite 外部边界。
assert.throws(() => db.prepare(`
  INSERT INTO raven_cat_ai_schedules (
    schedule_id, owner_ai_id, remind_at, summary, details, status,
    claimed_by_run_id, claimed_at, created_at, updated_at
  ) VALUES ('broken', 'host-ai', '2026-09-20T00:00:00.000Z', 'x', 'x',
    'scheduled', 'run-x', '2026-09-20T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
`).run());

const migration78Schema = `
  CREATE TABLE raven_cat_ai_schedules (
    schedule_id TEXT PRIMARY KEY CHECK (length(trim(schedule_id)) > 0),
    owner_ai_id TEXT NOT NULL CHECK (length(trim(owner_ai_id)) > 0),
    remind_at TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 160),
    details TEXT NOT NULL CHECK (length(trim(details)) BETWEEN 1 AND 4000),
    source_conversation_id TEXT,
    source_message_ids_json TEXT,
    source_excerpt TEXT CHECK (source_excerpt IS NULL OR length(source_excerpt) BETWEEN 1 AND 2000),
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'claimed', 'consumed', 'cancelled')),
    claimed_by_run_id TEXT,
    claimed_at TEXT,
    consumed_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (source_conversation_id IS NULL AND source_message_ids_json IS NULL AND source_excerpt IS NULL)
      OR
      (source_conversation_id IS NOT NULL AND source_message_ids_json IS NOT NULL AND source_excerpt IS NOT NULL)
    ),
    CHECK (
      (status = 'scheduled'
        AND claimed_by_run_id IS NULL AND claimed_at IS NULL
        AND consumed_at IS NULL AND cancelled_at IS NULL)
      OR
      (status = 'claimed'
        AND claimed_by_run_id IS NOT NULL AND claimed_at IS NOT NULL
        AND consumed_at IS NULL AND cancelled_at IS NULL)
      OR
      (status = 'consumed'
        AND claimed_by_run_id IS NOT NULL AND claimed_at IS NOT NULL
        AND consumed_at IS NOT NULL AND cancelled_at IS NULL)
      OR
      (status = 'cancelled'
        AND claimed_by_run_id IS NULL AND claimed_at IS NULL
        AND consumed_at IS NULL AND cancelled_at IS NOT NULL)
    )
  );
`;

function createMigration78Database() {
  const upgradeDb = new DatabaseSync(':memory:');
  upgradeDb.exec(migration78Schema);
  upgradeDb.exec(`
    ALTER TABLE raven_cat_ai_schedules ADD COLUMN cancelled_reason TEXT;
    CREATE INDEX idx_raven_cat_ai_schedules_owner_status_time
      ON raven_cat_ai_schedules(owner_ai_id, status, remind_at, schedule_id);
    CREATE INDEX idx_raven_cat_ai_schedules_owner_time
      ON raven_cat_ai_schedules(owner_ai_id, remind_at, schedule_id);
    CREATE INDEX idx_raven_cat_ai_schedules_owner_consumed_terminal
      ON raven_cat_ai_schedules(owner_ai_id, consumed_at DESC, schedule_id DESC)
      WHERE status = 'consumed';
  `);
  const insert = upgradeDb.prepare(`
    INSERT INTO raven_cat_ai_schedules (
      schedule_id, owner_ai_id, remind_at, summary, details,
      source_conversation_id, source_message_ids_json, source_excerpt,
      status, claimed_by_run_id, claimed_at, consumed_at,
      cancelled_at, cancelled_reason, created_at, updated_at
    ) VALUES (?, 'host-ai', ?, ?, '迁移后必须保留', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'upgrade-scheduled', '2026-10-01T08:00:00.000Z', '待执行',
    'session-upgrade', '["message-1"]', '用户：保留来源',
    'scheduled', null, null, null, null, null,
    '2026-09-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z',
  );
  insert.run(
    'upgrade-claimed', '2026-10-02T08:00:00.000Z', '执行中',
    null, null, null, 'claimed', 'run-upgrade', '2026-10-02T08:01:00.000Z',
    null, null, null, '2026-09-01T08:00:00.000Z', '2026-10-02T08:01:00.000Z',
  );
  insert.run(
    'upgrade-consumed', '2026-10-03T08:00:00.000Z', '已消费',
    null, null, null, 'consumed', 'run-consumed', '2026-10-03T08:01:00.000Z',
    '2026-10-03T08:02:00.000Z', null, null,
    '2026-09-01T08:00:00.000Z', '2026-10-03T08:02:00.000Z',
  );
  insert.run(
    'upgrade-cancelled', '2026-10-04T08:00:00.000Z', '已撤销',
    null, null, null, 'cancelled', null, null, null,
    '2026-09-20T08:00:00.000Z', 'owner_revoked',
    '2026-09-01T08:00:00.000Z', '2026-09-20T08:00:00.000Z',
  );
  return upgradeDb;
}

function migrationExecutorFor(upgradeDb) {
  return {
    execAsync: async (sql) => upgradeDb.exec(sql),
    getAllAsync: async (sql) => upgradeDb.prepare(sql).all(),
    runAsync: async (sql, params) => upgradeDb.prepare(sql).run(...params),
  };
}

async function assertLatestMigratedSchema(upgradeDb) {
  const rows = upgradeDb.prepare(`
    SELECT schedule_id, status, completion_disposition, source_excerpt, cancelled_reason
    FROM raven_cat_ai_schedules ORDER BY schedule_id
  `).all();
  assert.deepEqual(rows.map((row) => [row.schedule_id, row.completion_disposition]), [
    ['upgrade-cancelled', null],
    ['upgrade-claimed', null],
    ['upgrade-consumed', 'agent_terminal'],
    ['upgrade-scheduled', null],
  ]);
  assert.equal(rows.find((row) => row.schedule_id === 'upgrade-scheduled').source_excerpt, '用户：保留来源');
  assert.equal(rows.find((row) => row.schedule_id === 'upgrade-cancelled').cancelled_reason, 'owner_revoked');
  assert.equal(upgradeDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(
    upgradeDb.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'raven_cat_ai_schedules'
    `).all().map(({ name }) => name).sort(),
    [
      'idx_raven_cat_ai_schedules_owner_consumed_occurred',
      'idx_raven_cat_ai_schedules_owner_consumed_terminal',
      'idx_raven_cat_ai_schedules_owner_status_time',
      'idx_raven_cat_ai_schedules_owner_time',
      'sqlite_autoindex_raven_cat_ai_schedules_1',
    ],
  );
  assert.throws(() => upgradeDb.prepare(`
    UPDATE raven_cat_ai_schedules
    SET completion_disposition = NULL
    WHERE schedule_id = 'upgrade-consumed'
  `).run());
  assert.throws(() => upgradeDb.prepare(`
    UPDATE raven_cat_ai_schedules
    SET completion_disposition = 'agent_terminal'
    WHERE schedule_id = 'upgrade-claimed'
  `).run());
}

// Migration 78 的真实旧表形状升级后，必须获得与 fresh schema 相同的跨列约束。
const migration78Db = createMigration78Database();
const migration78Executor = migrationExecutorFor(migration78Db);
await schema.migrateRavenCatAISchedulesCompletionDisposition(migration78Executor);
await assertLatestMigratedSchema(migration78Db);
await schema.migrateRavenCatAISchedulesCompletionDisposition(migration78Executor);
assert.equal(
  migration78Db.prepare('SELECT COUNT(*) AS count FROM raven_cat_ai_schedules').get().count,
  4,
);

// 已经执行旧版 Migration 83（仅 ADD COLUMN）的用户也必须被修复；旧 schema
// 曾允许写入的 claimed + disposition 非法组合在 rebuild 时按 status 归一化。
const drifted83Db = createMigration78Database();
drifted83Db.exec(`
  ALTER TABLE raven_cat_ai_schedules
  ADD COLUMN completion_disposition TEXT
    CHECK (completion_disposition IS NULL
      OR completion_disposition IN ('agent_terminal', 'interrupted'));
  UPDATE raven_cat_ai_schedules
  SET completion_disposition = 'agent_terminal'
  WHERE status = 'consumed';
  UPDATE raven_cat_ai_schedules
  SET completion_disposition = 'agent_terminal'
  WHERE status = 'claimed';
`);
await schema.migrateRavenCatAISchedulesCompletionDisposition(migrationExecutorFor(drifted83Db));
await assertLatestMigratedSchema(drifted83Db);

// 旧 Self Wake 升级：稳定 identity／执行 anchor／工具授权搬运，失败原子回滚。
const unifiedMigration = await importTypeScriptModule('src/platform/persistence/sqlite/companionScheduleMigration.ts');
function legacyDatabase() {
  const legacyDb = new DatabaseSync(':memory:');
  legacyDb.exec(schema.RAVEN_CAT_AI_SCHEDULES_SCHEMA);
  legacyDb.exec(RAVEN_CAT_SELF_WAKES_SCHEMA);
  legacyDb.exec(`CREATE TABLE assistant_tool_permissions (assistant_id TEXT, tool_name TEXT, enabled INTEGER, updated_at TEXT, PRIMARY KEY (assistant_id, tool_name));
    INSERT INTO assistant_tool_permissions VALUES ('host-ai', 'schedule_self_wake', 0, 'old'), ('host-b', 'schedule_self_wake', 1, 'old'), ('host-b', 'create_ai_schedule', 0, 'new');`);
  for (const status of ['scheduled', 'claimed', 'consumed', 'superseded']) {
    const claimed = status === 'claimed' || status === 'consumed';
    legacyDb.prepare(`INSERT INTO raven_cat_self_wakes (wake_id, owner_ai_id, wake_at, note, status, claimed_by_run_id, claimed_at, consumed_at, superseded_at, created_at, updated_at) VALUES (?, 'host-ai', '2026-10-12T08:00:00.000Z', ?, ?, ?, ?, ?, ?, '2026-10-01T08:00:00.000Z', '2026-10-12T08:00:02.000Z')`)
      .run(status, status === 'scheduled' ? 'x'.repeat(5000) : status === 'claimed' ? '💙'.repeat(3000) : null, status, claimed ? `run-${status}` : null, claimed ? '2026-10-12T08:00:01.000Z' : null, status === 'consumed' ? '2026-10-12T08:00:02.000Z' : null, status === 'superseded' ? '2026-10-11T08:00:00.000Z' : null);
  }
  return legacyDb;
}
const legacyDb = legacyDatabase();
await unifiedMigration.migrateCompanionSchedules(migrationExecutorFor(legacyDb));
assert.equal(legacyDb.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'raven_cat_self_wakes'").get().n, 0);
assert.equal(legacyDb.prepare('SELECT COUNT(*) AS n FROM raven_cat_ai_schedules').get().n, 4);
const migratedRun = legacyDb.prepare("SELECT * FROM raven_cat_ai_schedules WHERE schedule_id = 'consumed'").get();
assert.equal(migratedRun.claimed_by_run_id, 'run-consumed');
assert.equal(migratedRun.claimed_at, '2026-10-12T08:00:01.000Z');
assert.equal(migratedRun.consumed_at, '2026-10-12T08:00:02.000Z');
assert.equal(migratedRun.completion_disposition, 'agent_terminal');
assert.equal(legacyDb.prepare("SELECT status FROM raven_cat_ai_schedules WHERE schedule_id = 'superseded'").get().status, 'cancelled');
assert.equal(legacyDb.prepare("SELECT length(details) AS n FROM raven_cat_ai_schedules WHERE schedule_id = 'scheduled'").get().n, 4000);
for (const row of legacyDb.prepare('SELECT * FROM raven_cat_ai_schedules').all()) {
  assert.ok(domain.createAIScheduleFromRow(row), '迁移后每条记录必须能被真实 domain mapping 读取，包括 Unicode 长正文');
}
assert.deepEqual(legacyDb.prepare('SELECT assistant_id, tool_name, enabled FROM assistant_tool_permissions ORDER BY assistant_id').all().map((row) => ({ ...row })), [
  { assistant_id: 'host-ai', tool_name: 'create_ai_schedule', enabled: 0 },
  { assistant_id: 'host-b', tool_name: 'create_ai_schedule', enabled: 0 },
]);
await unifiedMigration.migrateCompanionSchedules(migrationExecutorFor(legacyDb));
assert.equal(legacyDb.prepare('SELECT COUNT(*) AS n FROM raven_cat_ai_schedules').get().n, 4);
const failedLegacyDb = legacyDatabase();
const failingExecutor = migrationExecutorFor(failedLegacyDb);
await assert.rejects(unifiedMigration.migrateCompanionSchedules({
  ...failingExecutor,
  execAsync: async (sql) => {
    if (sql.includes('INSERT INTO assistant_tool_permissions')) throw new Error('migration interrupted');
    await failingExecutor.execAsync(sql);
  },
}), /migration interrupted/);
assert.equal(failedLegacyDb.prepare('SELECT COUNT(*) AS n FROM raven_cat_self_wakes').get().n, 4);
assert.equal(failedLegacyDb.prepare('SELECT COUNT(*) AS n FROM raven_cat_ai_schedules').get().n, 0);

console.log('AI 日程：事务开关、状态机、旧计划迁移与回滚行为检查通过。');
