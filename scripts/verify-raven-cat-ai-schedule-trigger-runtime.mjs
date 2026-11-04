import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTypeScriptModule as loadModule } from './helpers/load-typescript-module.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-cat-ai-schedule-trigger-'));

async function importTypeScriptModule(relativePath, transform = (source) => source) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(transform(fs.readFileSync(sourcePath, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  });
  const target = path.join(tmpDir, `${path.basename(relativePath, '.ts')}.mjs`);
  fs.writeFileSync(target, output.outputText, 'utf8');
  return import(`${pathToFileURL(target).href}?v=${Date.now()}-${Math.random()}`);
}

// ---------------------------------------------------------------------------
// Part A：SQLite Repository claim CAS（due-time + stale projection）与 authority invalidation。
// ---------------------------------------------------------------------------
const domain = await importTypeScriptModule('src/features/companion/domain/AISchedule.ts');
const schema = await importTypeScriptModule('src/platform/persistence/sqlite/ravenCatCompanionSchema.ts');

await importTypeScriptModule('src/features/companion/domain/CompanionState.ts');
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE ai_assistants (id TEXT PRIMARY KEY); INSERT INTO ai_assistants VALUES ('host-ai')");
db.exec(schema.RAVEN_CAT_COMPANION_STATE_SCHEMA);
db.exec("INSERT INTO raven_cat_companion_state (id, desired_enabled, activation_status, host_ai_id, created_at, updated_at) VALUES ('default', 1, 'enabled', 'host-ai', '2026-09-01', '2026-09-01')");
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_SCHEMA);
db.exec(schema.RAVEN_CAT_AI_SCHEDULE_CONTEXT_SCHEMA);
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_OWNER_STATUS_TIME_INDEX);
db.exec(schema.RAVEN_CAT_AI_SCHEDULES_OWNER_TIME_INDEX);

globalThis.__aiScheduleTriggerExecutor = {
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params),
  getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
  withExclusiveTransactionAsync: async (task) => {
    db.exec('BEGIN EXCLUSIVE');
    try {
      const result = await task(globalThis.__aiScheduleTriggerExecutor);
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
    openTaskExecutor: () => globalThis.__aiScheduleTriggerExecutor,
  };
`, 'utf8');

const repositoryModule = await importTypeScriptModule(
  'src/features/companion/infrastructure/SQLiteAIScheduleRepository.ts',
  (source) => source
    .replace("'@platform/persistence'", "'./TestPersistence.mjs'")
    .replace("'../domain/AISchedule'", "'./AISchedule.mjs'")
    .replace("'../domain/CompanionState'", "'./CompanionState.mjs'"),
);
const repository = new repositoryModule.SQLiteAIScheduleRepository();

const baseSchedule = {
  scheduleId: 'schedule-a',
  ownerAIId: 'host-ai',
  remindAt: '2026-09-13T09:00:00.000Z',
  summary: '考试',
  details: '数据库考试',
  sourceConversationId: null,
  sourceMessageIds: null,
  sourceExcerpt: null,
  status: 'scheduled',
  claimedByRunId: null,
  claimedAt: null,
  consumedAt: null,
  completionDisposition: null,
  cancelledAt: null,
  cancelledReason: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  updatedAt: '2026-09-09T08:00:00.000Z',
};

const created = await repository.createScheduled(domain.createAISchedule(baseSchedule), '2026-09-09T08:00:00.000Z');
assert.equal(created.status, 'created');

// 5. 提前到达 → not_due。
assert.equal((await repository.claimScheduled({
  scheduleId: 'schedule-a', ownerAIId: 'host-ai', runId: 'run-a',
  claimedAt: '2026-09-13T08:59:00.000Z',
  expectedRemindAt: '2026-09-13T09:00:00.000Z',
  projectionToken: baseSchedule.updatedAt,
})).status, 'not_due');

// 4. stale projection：expectedRemindAt 与当前 remind_at 不一致 → stale_projection。
assert.equal((await repository.claimScheduled({
  scheduleId: 'schedule-a', ownerAIId: 'host-ai', runId: 'run-a',
  claimedAt: '2026-09-13T09:01:00.000Z',
  expectedRemindAt: '2026-09-13T10:00:00.000Z',
  projectionToken: baseSchedule.updatedAt,
})).status, 'stale_projection');

// 4. stale projection：projectionToken 与当前 updated_at 不一致 → stale_projection。
assert.equal((await repository.claimScheduled({
  scheduleId: 'schedule-a', ownerAIId: 'host-ai', runId: 'run-a',
  claimedAt: '2026-09-13T09:01:00.000Z',
  expectedRemindAt: '2026-09-13T09:00:00.000Z',
  projectionToken: 'outdated-token',
})).status, 'stale_projection');

// 6. duplicate：第一条 claim winner，第二条 already_claimed。
const first = await repository.claimScheduled({
  scheduleId: 'schedule-a', ownerAIId: 'host-ai', runId: 'run-a',
  claimedAt: '2026-09-13T09:01:00.000Z',
  expectedRemindAt: '2026-09-13T09:00:00.000Z',
  projectionToken: baseSchedule.updatedAt,
});
assert.equal(first.status, 'claimed');
assert.equal(first.schedule.claimedByRunId, 'run-a');
assert.equal((await repository.claimScheduled({
  scheduleId: 'schedule-a', ownerAIId: 'host-ai', runId: 'run-b',
  claimedAt: '2026-09-13T09:02:00.000Z',
  expectedRemindAt: '2026-09-13T09:00:00.000Z',
  projectionToken: baseSchedule.updatedAt,
})).status, 'already_claimed');

// authority invalidation：scheduled → cancelled(reason=owner_revoked)。
const secondSchedule = {
  ...baseSchedule,
  scheduleId: 'schedule-b',
  updatedAt: '2026-09-09T08:05:00.000Z',
};
await repository.createScheduled(domain.createAISchedule(secondSchedule), '2026-09-09T08:00:00.000Z');
const terminalized = await repository.terminalizeScheduledForOwnerInvalidation({
  scheduleId: 'schedule-b',
  occurredAt: '2026-09-10T00:00:00.000Z',
});
assert.equal(terminalized.status, 'cancelled');
assert.equal(terminalized.schedule.status, 'cancelled');
assert.equal(terminalized.schedule.cancelledReason, 'owner_revoked');
assert.equal(terminalized.schedule.ownerAIId, 'host-ai');
// claimed 的 schedule-a 不能再被 authority invalidation 终结。
assert.equal((await repository.terminalizeScheduledForOwnerInvalidation({
  scheduleId: 'schedule-a',
  occurredAt: '2026-09-10T00:00:00.000Z',
})).status, 'not_scheduled');

// 14. listAllScheduled 只返回 scheduled。
const scheduledNow = await repository.listAllScheduled();
assert.deepEqual(scheduledNow.map((s) => s.scheduleId).sort(), []);

// ---------------------------------------------------------------------------
// Part B：AIScheduleProjectionOwner reconcile / create / update / cancel projection。
// ---------------------------------------------------------------------------
fs.writeFileSync(path.join(tmpDir, 'TestAIScheduleApplication.mjs'), `
  function saveTruth(schedule) {
    globalThis.__aiScheduleProjectionTruth?.set(schedule.scheduleId, schedule);
    return schedule;
  }
  export const createAIScheduleCommand = async (input) => ({
    status: 'created',
      schedule: saveTruth({
      scheduleId: input.scheduleId || 's-1',
      ownerAIId: input.ownerAIId,
      remindAt: input.remindAt,
      summary: input.summary,
      details: input.details, systemCalendar: input.systemCalendar ?? false,
      sourceConversationId: null, sourceMessageIds: null, sourceExcerpt: null,
      status: 'scheduled', claimedByRunId: null, claimedAt: null,
      consumedAt: null, completionDisposition: null,
      cancelledAt: null, cancelledReason: null,
      createdAt: '2026-09-09T08:00:00.000Z', updatedAt: 'tok-1',
    }),
  });
  export const updateAIScheduleCommand = async (input) => ({
    status: 'updated',
    schedule: saveTruth({
      scheduleId: input.scheduleId, ownerAIId: input.ownerAIId,
      remindAt: input.remindAt ?? '2026-09-13T09:00:00.000Z',
      summary: 's', details: 'd', systemCalendar: input.systemCalendar ?? globalThis.__aiScheduleProjectionTruth.get(input.scheduleId)?.systemCalendar ?? false,
      sourceConversationId: null, sourceMessageIds: null, sourceExcerpt: null,
      status: 'scheduled', claimedByRunId: null, claimedAt: null,
      consumedAt: null, completionDisposition: null,
      cancelledAt: null, cancelledReason: null,
      createdAt: '2026-09-09T08:00:00.000Z', updatedAt: 'tok-2',
    }),
  });
  export const cancelAIScheduleCommand = async (input) => ({
    status: 'cancelled',
    schedule: saveTruth({
      scheduleId: input.scheduleId, ownerAIId: input.ownerAIId,
      remindAt: '2026-09-13T09:00:00.000Z', summary: 's', details: 'd',
      sourceConversationId: null, sourceMessageIds: null, sourceExcerpt: null,
      systemCalendar: globalThis.__aiScheduleProjectionTruth.get(input.scheduleId)?.systemCalendar ?? false,
      status: 'cancelled', claimedByRunId: null, claimedAt: null,
      consumedAt: null, completionDisposition: null,
      cancelledAt: '2026-09-10T00:00:00.000Z', cancelledReason: null,
      createdAt: '2026-09-09T08:00:00.000Z', updatedAt: 'tok-2',
    }),
  });
  export const consumeAIScheduleCommand = async (input) => ({
    status: 'consumed',
    schedule: saveTruth({
      scheduleId: input.scheduleId, ownerAIId: 'host-ai',
      remindAt: '2026-09-13T09:00:00.000Z', summary: 's', details: 'd',
      sourceConversationId: null, sourceMessageIds: null, sourceExcerpt: null,
      status: 'consumed', claimedByRunId: input.runId, claimedAt: '2026-09-13T09:01:00.000Z',
      consumedAt: input.consumedAt, completionDisposition: input.completionDisposition,
      cancelledAt: null, cancelledReason: null,
      createdAt: '2026-09-09T08:00:00.000Z', updatedAt: 'tok-1',
    }),
  });
  export const claimAIScheduleCommand = async () => { throw new Error('unused'); };
`, 'utf8');

fs.writeFileSync(path.join(tmpDir, 'TestRuntimeDeps.mjs'), `
  export function getCompanionRuntimeDependencies() {
    throw new Error('专项 verifier 不使用 production singleton');
  }
`, 'utf8');

fs.writeFileSync(path.join(tmpDir, 'TestAIScheduleProjectionRepairCoordinator.mjs'), `
  export class AIScheduleProjectionRepairCoordinator {
    constructor(dependencies) { this.dependencies = dependencies; }
    requestRepair() {}
    reconcileNow() { return this.dependencies.reconcile(); }
    drainAndCancel() { return Promise.resolve(); }
  }
`, 'utf8');

fs.writeFileSync(path.join(tmpDir, 'TestSystemCalendar.mjs'), 'export const systemCalendar = {};', 'utf8');
const noCalendar = { prepare: async () => 'ready', upsert: async () => {}, remove: async () => {}, listKeys: async () => [] };
const ownerModule = await importTypeScriptModule(
  'src/features/companion/application/AIScheduleProjectionOwner.ts',
  (source) => source
    .replaceAll("'@platform/device/SystemCalendar'", "'./TestSystemCalendar.mjs'")
    .replaceAll("'./AIScheduleApplication'", "'./TestAIScheduleApplication.mjs'")
    .replaceAll("'./AIScheduleProjectionRepairCoordinator'", "'./TestAIScheduleProjectionRepairCoordinator.mjs'")
    .replaceAll("'./CompanionRuntimeDependencies'", "'./TestRuntimeDeps.mjs'"),
);

const fakeNativeCalls = [];

// 暂停保留计划；开启只恢复未来投影，错过的机会不补跑。
let switchState = { desiredEnabled: true, activationStatus: 'enabled', hostAIId: 'host-ai' };
const switchTruth = new Map([
  ['future', { ...baseSchedule, scheduleId: 'future' }],
  ['missed', { ...baseSchedule, scheduleId: 'missed', remindAt: '2026-09-08T08:00:00.000Z' }],
]);
const switchNative = new Map();
const switchOwner = new ownerModule.AIScheduleProjectionOwner({
  calendar: noCalendar,
  companionState: {
    ensureDefault: async () => switchState,
    update: async (changes) => (switchState = { ...switchState, ...changes }),
  },
  schedules: {
    expireScheduled: async () => {},
    listAllScheduled: async () => [...switchTruth.values()],
    getByScheduleId: async (id) => switchTruth.get(id),
  },
  native: {
    setCompanionSchedulingEnabled: async (enabled) => { if (!enabled) switchNative.clear(); },
    listAIScheduleTriggerProjections: async () => [...switchNative.values()],
    cancelAIScheduleTrigger: async (id) => { switchNative.delete(id); },
    scheduleAIScheduleTrigger: async (request) => {
      switchNative.set(request.scheduleId, { ...request, expectedRemindAtEpochMs: request.remindAtEpochMs });
    },
  },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-09T08:00:00.000Z'),
});
await switchOwner.reconcile();
assert.deepEqual([...switchNative.keys()], ['future']);
await switchOwner.disableCompanion({ clearHostAI: false, failureCode: null });
assert.equal(switchTruth.size, 2);
assert.equal(switchNative.size, 0);
await switchOwner.reconcile();
assert.equal(switchNative.size, 0);
await switchOwner.activateCompanion('host-ai');
assert.deepEqual([...switchNative.keys()], ['future']);

const fakeNative = {
  scheduleAIScheduleTrigger: async (request) => {
    fakeNativeCalls.push(['schedule', request]);
    return {
      scheduleId: request.scheduleId, ownerAIId: request.ownerAIId,
      expectedRemindAtEpochMs: request.remindAtEpochMs, projectionToken: request.projectionToken,
    };
  },
  cancelAIScheduleTrigger: async (scheduleId) => fakeNativeCalls.push(['cancel', scheduleId]),
  listAIScheduleTriggerProjections: async () => [],
};

// Part B 的 command mock 自己维护一份仅供 verifier 使用的 durable truth；
// owner 必须通过 getByScheduleId 重读这份 truth，而不能使用 command 返回的旧 snapshot。
const projectionTruth = new Map();
globalThis.__aiScheduleProjectionTruth = projectionTruth;
const projectionRepository = {
  ...repository,
  expireScheduled: async () => {},
  getByScheduleId: async (scheduleId) => projectionTruth.get(scheduleId) ?? null,
};

// create → project。
const owner = new ownerModule.AIScheduleProjectionOwner({
  calendar: noCalendar,
  schedules: projectionRepository,
  companionState: { ensureDefault: async () => ({ desiredEnabled: true }) },
  native: { ...fakeNative, setCompanionSchedulingEnabled: async () => {} },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-09T08:00:00.000Z'),
});
const createOutcome = await owner.create({
  ownerAIId: 'host-ai',
  remindAt: '2026-09-13T09:00:00.000Z',
  summary: '考试',
  details: '数据库考试',
});
assert.equal(createOutcome.status, 'created');
assert.equal(createOutcome.projection.status, 'projected');
assert.equal(fakeNativeCalls[0][0], 'schedule');
assert.equal(fakeNativeCalls[0][1].projectionToken, 'tok-1');

// update → replace（同 scheduleId 再次 schedule，token 变为 tok-2）。
await owner.update({ scheduleId: 's-1', ownerAIId: 'host-ai', summary: '改期' });
assert.equal(fakeNativeCalls.at(-1)[0], 'schedule');
assert.equal(fakeNativeCalls.at(-1)[1].projectionToken, 'tok-2');

// cancel → cancel projection。
await owner.cancel({ scheduleId: 's-1', ownerAIId: 'host-ai' });
assert.deepEqual(fakeNativeCalls.at(-1), ['cancel', 's-1']);

// reconcile：owner 不再是当前 host → terminalize + cancel native。
const staleOwnerNative = {
  scheduleAIScheduleTrigger: async () => { throw new Error('unused'); },
  cancelAIScheduleTrigger: async (id) => fakeNativeCalls.push(['cancel', id]),
  listAIScheduleTriggerProjections: async () => [{
    scheduleId: 'orphan', ownerAIId: 'old-owner',
    expectedRemindAtEpochMs: Date.parse('2026-09-13T09:00:00.000Z'), projectionToken: 'tok',
  }],
};
const reconcileOwner = new ownerModule.AIScheduleProjectionOwner({
  calendar: noCalendar,
  schedules: repository,
  companionState: { ensureDefault: async () => ({ desiredEnabled: true }) },
  native: { ...staleOwnerNative, setCompanionSchedulingEnabled: async () => {} },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-09T08:00:00.000Z'),
});
// 在 repository 里种入一条 old-owner 的 scheduled（但 current host 是 host-ai）。
db.exec("INSERT INTO ai_assistants VALUES ('old-owner'); UPDATE raven_cat_companion_state SET host_ai_id = 'old-owner'");
await repository.createScheduled(domain.createAISchedule({
  ...baseSchedule, scheduleId: 'orphan', ownerAIId: 'old-owner',
}), '2026-09-09T08:00:00.000Z');
db.exec("UPDATE raven_cat_companion_state SET host_ai_id = 'host-ai'");
await reconcileOwner.reconcile();
assert.equal((await repository.getByScheduleId('orphan')).status, 'cancelled');
assert.equal((await repository.getByScheduleId('orphan')).cancelledReason, 'owner_revoked');
assert.ok(fakeNativeCalls.some(([kind, id]) => kind === 'cancel' && id === 'orphan'));

// 2. 修复 overdue scheduled recovery：durable scheduled + native missing + remindAt 已过去
// → reconcile 必须重建 native projection（native 用 delay=0 立即执行），不得永久悬挂。
db.prepare(`
  INSERT INTO raven_cat_ai_schedules (
    schedule_id, owner_ai_id, remind_at, summary, details,
    source_conversation_id, source_message_ids_json, source_excerpt,
    status, claimed_by_run_id, claimed_at, consumed_at, cancelled_at, cancelled_reason,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'scheduled', NULL, NULL, NULL, NULL, NULL, ?, ?)
`).run('overdue', 'host-ai', '2026-09-01T09:00:00.000Z', '已过期', '已过期日程', '2026-08-30T08:00:00.000Z', '2026-08-30T08:00:00.000Z');

const overdueCalls = [];
const overdueNative = {
  scheduleAIScheduleTrigger: async (request) => {
    overdueCalls.push(['schedule', request]);
    return { scheduleId: request.scheduleId, ownerAIId: request.ownerAIId, expectedRemindAtEpochMs: request.remindAtEpochMs, projectionToken: request.projectionToken };
  },
  cancelAIScheduleTrigger: async (id) => overdueCalls.push(['cancel', id]),
  listAIScheduleTriggerProjections: async () => [],
};
const overdueOwner = new ownerModule.AIScheduleProjectionOwner({
  calendar: noCalendar,
  schedules: repository,
  companionState: { ensureDefault: async () => ({ desiredEnabled: true }) },
  native: { ...overdueNative, setCompanionSchedulingEnabled: async () => {} },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-10T00:00:00.000Z'),
});
await overdueOwner.reconcile();
const overdueScheduleCall = overdueCalls.find(([kind, req]) => kind === 'schedule' && req.scheduleId === 'overdue');
assert.equal(overdueScheduleCall, undefined, '错过且没有原生投影的日程不得在 reconcile 时补跑');
// durable remindAt 不被修改。
assert.equal((await repository.getByScheduleId('overdue')).remindAt, '2026-09-01T09:00:00.000Z');

// P1-2：create / update / cancel projection failure 都保持 durable success，
// 后续 repair 必须从最新 truth 重读并幂等收口，不得携带旧 token。
const repairCalls = [];
const nativeProjectionById = new Map();
let failNextSchedule = false;
let failNextCancel = false;
const repairNative = {
  scheduleAIScheduleTrigger: async (request) => {
    repairCalls.push(['schedule', request]);
    if (failNextSchedule) {
      failNextSchedule = false;
      throw new Error('schedule projection unavailable');
    }
    nativeProjectionById.set(request.scheduleId, {
      scheduleId: request.scheduleId,
      ownerAIId: request.ownerAIId,
      expectedRemindAtEpochMs: request.remindAtEpochMs,
      projectionToken: request.projectionToken,
    });
    return nativeProjectionById.get(request.scheduleId);
  },
  cancelAIScheduleTrigger: async (scheduleId) => {
    repairCalls.push(['cancel', scheduleId]);
    if (failNextCancel) {
      failNextCancel = false;
      throw new Error('cancel projection unavailable');
    }
    nativeProjectionById.delete(scheduleId);
  },
  listAIScheduleTriggerProjections: async () => [...nativeProjectionById.values()],
};
const repairRepository = {
  ...projectionRepository,
  listAllScheduled: async () => [...projectionTruth.values()].filter((item) => item.status === 'scheduled'),
};
const repairOwner = new ownerModule.AIScheduleProjectionOwner({
  calendar: noCalendar,
  schedules: repairRepository,
  companionState: { ensureDefault: async () => ({ desiredEnabled: true }) },
  native: { ...repairNative, setCompanionSchedulingEnabled: async () => {} },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-09T08:00:00.000Z'),
});

failNextSchedule = true;
const failedCreate = await repairOwner.create({
  scheduleId: 'repair-schedule',
  ownerAIId: 'host-ai',
  remindAt: '2026-09-13T09:00:00.000Z',
  summary: 'repair',
  details: 'repair',
});
assert.equal(failedCreate.status, 'created');
assert.equal(failedCreate.projection.status, 'projection_failed');
assert.equal(projectionTruth.get('repair-schedule').status, 'scheduled');
await repairOwner.reconcileNow();
assert.equal(nativeProjectionById.get('repair-schedule').projectionToken, 'tok-1');

failNextSchedule = true;
const failedUpdate = await repairOwner.update({
  scheduleId: 'repair-schedule', ownerAIId: 'host-ai', summary: 'repair-v2',
});
assert.equal(failedUpdate.status, 'updated');
assert.equal(failedUpdate.projection.status, 'projection_failed');
await repairOwner.reconcileNow();
assert.equal(nativeProjectionById.get('repair-schedule').projectionToken, 'tok-2');

failNextCancel = true;
const failedCancel = await repairOwner.cancel({
  scheduleId: 'repair-schedule', ownerAIId: 'host-ai',
});
assert.equal(failedCancel.status, 'cancelled');
assert.equal(failedCancel.projection.status, 'projection_failed');
await repairOwner.reconcileNow();
assert.equal(nativeProjectionById.has('repair-schedule'), false);
const repairCallCount = repairCalls.length;
const idempotentRepair = await repairOwner.reconcileNow();
assert.equal(idempotentRepair.status, 'reconciled');
assert.equal(repairCalls.length, repairCallCount, '已收口 projection 的 repair 不得重复 mutation');

// v1 native 调用挂起期间，v2 command 只能排在 owner lane 后；释放后最终 native 必须是 v2。
const serialCalls = [];
let releaseV1;
const v1Ready = new Promise((resolve) => { releaseV1 = resolve; });
const serialNative = {
  scheduleAIScheduleTrigger: async (request) => {
    serialCalls.push(request.projectionToken);
    if (request.projectionToken === 'tok-1') await v1Ready;
    return request;
  },
  cancelAIScheduleTrigger: async () => {},
  listAIScheduleTriggerProjections: async () => [],
};
const serialOwner = new ownerModule.AIScheduleProjectionOwner({
  calendar: noCalendar,
  schedules: repairRepository,
  companionState: { ensureDefault: async () => ({ desiredEnabled: true }) },
  native: { ...serialNative, setCompanionSchedulingEnabled: async () => {} },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-09T08:00:00.000Z'),
});
const v1Create = serialOwner.create({
  scheduleId: 'serial-schedule', ownerAIId: 'host-ai',
  remindAt: '2026-09-13T09:00:00.000Z', summary: 'v1', details: 'v1',
});
const v2Update = serialOwner.update({
  scheduleId: 'serial-schedule', ownerAIId: 'host-ai', summary: 'v2',
});
for (let index = 0; index < 5 && serialCalls.length === 0; index += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}
assert.deepEqual(serialCalls, ['tok-1']);
releaseV1();
await Promise.all([v1Create, v2Update]);
assert.deepEqual(serialCalls, ['tok-1', 'tok-2']);

// 内外日程共享 stable identity；权限拒绝必须发生在内部事实提交之前。
projectionTruth.clear();
let calendarAccess = 'permission_required';
let calendarWriteFails = false;
let calendarPrepareCalls = 0;
const calendarEvents = new Map();
const calendar = {
  prepare: async () => { calendarPrepareCalls += 1; return calendarAccess; },
  upsert: async event => {
    if (calendarWriteFails) throw new Error('日历服务暂不可用');
    calendarEvents.set(event.key, event);
  },
  remove: async key => { calendarEvents.delete(key); },
  listKeys: async () => [...calendarEvents.keys()],
};
const calendarOwner = new ownerModule.AIScheduleProjectionOwner({
  calendar, schedules: repairRepository,
  companionState: { ensureDefault: async () => ({ desiredEnabled: true }) },
  native: { ...fakeNative, setCompanionSchedulingEnabled: async () => {} },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-09T08:00:00.000Z'),
});
const calendarInput = { scheduleId: 'calendar', ownerAIId: 'host-ai',
  remindAt: '2026-09-13T09:00:00.000Z', summary: '考试', details: '带证件', systemCalendar: true };
assert.equal((await calendarOwner.create(calendarInput)).code, 'calendar_permission_required');
assert.equal(projectionTruth.size, 0);
assert.equal(calendarEvents.size, 0);
const permissionChecks = calendarPrepareCalls;
assert.equal((await calendarOwner.create({ ...calendarInput, systemCalendar: false })).calendar, 'internal_only');
assert.equal(calendarPrepareCalls, permissionChecks, '仅内部创建不触碰日历权限');
calendarAccess = 'no_writable_calendar';
assert.equal((await calendarOwner.create({ ...calendarInput, scheduleId: 'unavailable' })).code, 'calendar_unavailable');
assert.equal(projectionTruth.has('unavailable'), false);
calendarAccess = 'ready';
assert.equal((await calendarOwner.update({ scheduleId: 'calendar', ownerAIId: 'host-ai', systemCalendar: true })).calendar, 'synced');
assert.equal(calendarEvents.size, 1);
const changedTime = '2026-09-14T09:00:00.000Z';
await calendarOwner.update({ scheduleId: 'calendar', ownerAIId: 'host-ai', remindAt: changedTime });
assert.equal(calendarEvents.size, 1);
assert.equal(calendarEvents.get('calendar').startAtEpochMs, Date.parse(changedTime));
await calendarOwner.update({ scheduleId: 'calendar', ownerAIId: 'host-ai', systemCalendar: false });
assert.equal(calendarEvents.size, 0);
await calendarOwner.update({ scheduleId: 'calendar', ownerAIId: 'host-ai', systemCalendar: true });
calendarAccess = 'permission_required';
const cancelledCalendar = await calendarOwner.cancel({ scheduleId: 'calendar', ownerAIId: 'host-ai' });
assert.equal(cancelledCalendar.status, 'cancelled');
assert.equal(cancelledCalendar.calendar, 'permission_required');
assert.equal(calendarEvents.size, 1, '撤权时不能声称系统事件已经删除');
calendarAccess = 'ready';
await calendarOwner.reconcile();
assert.equal(calendarEvents.size, 0, '恢复授权后移除已经取消的关联事件');
calendarWriteFails = true;
const failedCalendar = await calendarOwner.create({ ...calendarInput, scheduleId: 'repair-calendar' });
assert.equal(failedCalendar.status, 'created');
assert.equal(failedCalendar.calendar, 'failed');
assert.equal(projectionTruth.has('repair-calendar'), true);
calendarWriteFails = false;
await calendarOwner.reconcile();
await calendarOwner.reconcile();
assert.equal(calendarEvents.size, 1, '恢复同步不能重复创建事件');
projectionTruth.set('repair-calendar', { ...projectionTruth.get('repair-calendar'), status: 'consumed' });
await calendarOwner.reconcile();
assert.equal(calendarEvents.size, 1, 'AI 已执行不撤销系统事件');
const pausedCalendarOwner = new ownerModule.AIScheduleProjectionOwner({
  calendar, schedules: repairRepository,
  companionState: { ensureDefault: async () => ({ desiredEnabled: false }) },
  native: { ...fakeNative, setCompanionSchedulingEnabled: async () => {} },
  getCurrentHostAIId: async () => 'host-ai',
  now: () => new Date('2026-09-09T08:00:00.000Z'),
});
await pausedCalendarOwner.reconcile();
assert.equal(calendarEvents.size, 1, '暂停主动伴随不撤销系统提醒');

// coordinator 的 retry 是单飞、合并、一次性且严格最多四次；第五个 timer 不得产生。
const repairCoordinatorModule = await importTypeScriptModule(
  'src/features/companion/application/AIScheduleProjectionRepairCoordinator.ts',
);
const timerQueue = [];
const timerDelays = [];
let coordinatorRuns = 0;
const coordinator = new repairCoordinatorModule.AIScheduleProjectionRepairCoordinator(
  {
    reconcile: async () => {
      coordinatorRuns += 1;
      return { status: 'repair_pending' };
    },
    isHealthy: (outcome) => outcome.status === 'reconciled',
  },
  {
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timerQueue.push(timer);
      timerDelays.push(delay);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = timerQueue.indexOf(timer);
      if (index >= 0) timerQueue.splice(index, 1);
    },
  },
);
const drainTimer = async () => {
  const timer = timerQueue.shift();
  assert.ok(timer, 'expected a scheduled repair timer');
  timer.callback();
  await Promise.resolve();
  await Promise.resolve();
};
coordinator.requestRepair();
coordinator.requestRepair();
assert.deepEqual(timerDelays, [1_000]);
await drainTimer();
await drainTimer();
await drainTimer();
await drainTimer();
assert.deepEqual(timerDelays, [1_000, 5_000, 30_000, 60_000]);
assert.equal(timerQueue.length, 0, '四次 bounded retry 后不得继续安排第五个 timer');
assert.equal(coordinatorRuns, 4);
await coordinator.reconcileNow();
assert.deepEqual(timerDelays, [1_000, 5_000, 30_000, 60_000, 1_000], 'lifecycle 必须开启新一轮 backoff');
coordinator.cancel();
assert.equal(timerQueue.length, 0, 'cancel 必须清空 pending repair timer');

// ---------------------------------------------------------------------------
// Part C：RunHeadlessAISchedule claim → run → consume 完整链。
// ---------------------------------------------------------------------------
let claimOutcomes = [];
let runResult = terminal('COMPLETED');
let runError = null;
let dispatchAvailable = true;
let consumeOutcome = { status: 'consumed' };
let currentHostAIId = 'host-ai';
const runnerCalls = [];
let admissionGate = null;

const runnerMocks = {
  '@features/assistants': {
    runAsCurrentHostAuthority: async (actorAIId, action) => {
      runnerCalls.push(['authority', actorAIId]);
      return actorAIId === currentHostAIId
        ? { status: 'authorized', value: await action() }
        : { status: 'not_current_host' };
    },
  },
  './AutonomousRunDiagnostic': {
    summarizeAutonomousAgentRun: (result) => ({ terminalCode: result.terminalCode }),
  },
  './CompanionRuntimeDependencies': {
    getCompanionRuntimeDependencies: () => ({
      initializeDatabase: async () => runnerCalls.push(['database']),
      generateAutonomousRunId: () => 'generated-run',
      repositories: { aiSchedules: {
        prepareDispatch: async input => dispatchAvailable ? ({ ...baseSchedule, scheduleId: input.scheduleId, ownerAIId: input.ownerAIId,
          remindAt: input.expectedRemindAt, updatedAt: input.projectionToken }) : null,
        mergeClaimedRun: async () => {}, mergeScheduled: async () => {},
      } },
      chat: {
        resolveCanonicalConversation: async () => ({ id: 'canonical-session' }),
        runInConversation: async (_sessionId, _runId, _priority, execute, signal) => {
          if (admissionGate) await admissionGate;
          return { status: 'ran', value: await execute({ signal: signal ?? new AbortController().signal }) };
        },
      },
    }),
  },
  './AIScheduleProjectionOwner': {
    claimAIScheduleForHeadless: async (input) => {
      runnerCalls.push(['claim', input]);
      const outcome = claimOutcomes.shift();
      return typeof outcome === 'function' ? outcome(input) : outcome;
    },
    consumeAIScheduleWithProjection: async (input) => {
      runnerCalls.push(['consume', input]);
      return consumeOutcome;
    },
  },
  './AIScheduleRecovery': {
    claimAndTrackAIScheduleRun: async (runId, claim) => {
      const outcome = await claim();
      if (outcome.status === 'claimed') runnerCalls.push(['active', runId]);
      return outcome;
    },
    completeTrackedAIScheduleRun: async (runId, disposition, consume) => {
      runnerCalls.push(['complete', runId, disposition]);
      return consume();
    },
  },
  './RunAIScheduleAutonomousAgent': {
    runAIScheduleAutonomousAgent: async (input) => {
      runnerCalls.push(['run', input]);
      if (runError) throw runError;
      return { ...runResult, runId: input.runId };
    },
  },
};
const runnerModule = loadModule(
  'src/features/companion/application/RunHeadlessAISchedule.ts',
  runnerMocks,
);
const { runHeadlessAISchedule } = runnerModule;

const callback = {
  triggerKind: 'ai_schedule',
  source: 'work-manager',
  eventId: 'schedule-x',
  hostAIId: 'host-ai',
  expectedRemindAtEpochMs: Date.parse('2026-09-13T09:00:00.000Z'),
  projectionToken: 'tok',
  createdAtEpochMs: Date.parse('2026-09-13T09:00:05.000Z'),
  deliveryEventId: 'schedule-x@tok',
};

function claimedOutcome(input) {
  return {
    status: 'claimed',
    schedule: {
      scheduleId: input.scheduleId, ownerAIId: input.ownerAIId,
      remindAt: '2026-09-13T09:00:00.000Z', summary: 's', details: 'd',
      sourceConversationId: null, sourceMessageIds: null, sourceExcerpt: null,
      status: 'claimed', claimedByRunId: input.runId, claimedAt: input.claimedAt,
      consumedAt: null, completionDisposition: null,
      cancelledAt: null, cancelledReason: null,
      createdAt: '2026-09-09T08:00:00.000Z', updatedAt: 'tok',
    },
  };
}

// 成功链：claim 用 runId、expectedRemindAt、projectionToken、claimedAt。
claimOutcomes.push(claimedOutcome);
const ran = await runHeadlessAISchedule(callback);
assert.equal(ran.status, 'ran');
const claimCall = runnerCalls.find(([kind]) => kind === 'claim')[1];
const runCall = runnerCalls.find(([kind]) => kind === 'run')[1];
const consumeCall = runnerCalls.find(([kind]) => kind === 'consume')[1];
assert.equal(claimCall.runId, 'generated-run');
assert.equal(claimCall.expectedRemindAt, '2026-09-13T09:00:00.000Z');
assert.equal(claimCall.projectionToken, 'tok');
assert.equal(runCall.runId, 'generated-run');
assert.equal(runCall.claimedSchedule.claimedByRunId, 'generated-run');
assert.equal(consumeCall.scheduleId, 'schedule-x');
assert.equal(consumeCall.runId, 'generated-run');
assert.equal(consumeCall.completionDisposition, 'agent_terminal');
assert.deepEqual(runnerCalls.find(([kind]) => kind === 'complete'), [
  'complete', 'generated-run', 'agent_terminal',
]);

runnerCalls.length = 0;
dispatchAvailable = false;
assert.deepEqual(await runHeadlessAISchedule(callback), { status: 'ignored', reason: 'expired_or_merged' });
assert.equal(runnerCalls.some(([kind]) => kind === 'claim' || kind === 'run'), false,
  '已经失效或被归并的系统投递必须在会话领取和模型准备之前结束');
dispatchAvailable = true;

// 短小的 owner 交接尚未完成时不抢先领取；claimedAt 只记录真实开始时间。
runnerCalls.length = 0;
let releaseAdmission;
admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
claimOutcomes.push(claimedOutcome);
const delayed = runHeadlessAISchedule(callback);
await new Promise(resolve => setImmediate(resolve));
assert.equal(runnerCalls.some(([kind]) => kind === 'claim'), false);
assert.equal(runnerCalls.some(([kind]) => kind === 'run'), false);
const admittedAt = Date.now();
releaseAdmission();
assert.equal((await delayed).status, 'ran');
assert.ok(Date.parse(runnerCalls.find(([kind]) => kind === 'claim')[1].claimedAt) >= admittedAt);
assert.equal(runnerCalls.find(([kind]) => kind === 'run')[1].sessionId, 'canonical-session');
admissionGate = null;

// 等待期间被撤销主理身份，不能沿用等待前的授权去领取执行机会。
runnerCalls.length = 0;
admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
const revokedWhileWaiting = runHeadlessAISchedule(callback);
await new Promise(resolve => setImmediate(resolve));
currentHostAIId = 'replacement-host';
releaseAdmission();
assert.deepEqual(await revokedWhileWaiting, { status: 'ignored', reason: 'not_current_host' });
assert.equal(runnerCalls.some(([kind]) => kind === 'claim'), false);
admissionGate = null;
currentHostAIId = 'host-ai';

// 5/4/6：claim 拒绝（not_due / stale_projection）→ ignored，不启动 run。
runnerCalls.length = 0;
claimOutcomes.push({ status: 'error', code: 'not_due' });
const early = await runHeadlessAISchedule(callback);
assert.deepEqual(early, { status: 'ignored', reason: 'claim_rejected', claimStatus: 'not_due' });
assert.equal(runnerCalls.some(([kind]) => kind === 'run'), false);
assert.equal(runnerCalls.some(([kind]) => kind === 'consume'), false);

runnerCalls.length = 0;
claimOutcomes.push({ status: 'error', code: 'stale_projection' });
const stale = await runHeadlessAISchedule(callback);
assert.deepEqual(stale, { status: 'ignored', reason: 'claim_rejected', claimStatus: 'stale_projection' });
assert.equal(runnerCalls.some(([kind]) => kind === 'run'), false);

// 1. stale v1 不毒死 v2：v1 callback（token v1）被拒后，v2 callback（token v2）仍能 claim/run。
const callbackV1 = { ...callback, projectionToken: 'tok-v1', deliveryEventId: 'schedule-x@tok-v1' };
const callbackV2 = { ...callback, projectionToken: 'tok-v2', deliveryEventId: 'schedule-x@tok-v2' };
runnerCalls.length = 0;
claimOutcomes.push({ status: 'error', code: 'stale_projection' });
await runHeadlessAISchedule(callbackV1);
assert.equal(runnerCalls.some(([kind]) => kind === 'run'), false, 'stale v1 不得启动 run');

runnerCalls.length = 0;
claimOutcomes.push(claimedOutcome);
const v2Ran = await runHeadlessAISchedule(callbackV2);
assert.equal(v2Ran.status, 'ran', 'v2 callback 必须能成功进入 claim/run');
assert.equal(runnerCalls.find(([kind]) => kind === 'claim')[1].projectionToken, 'tok-v2');
assert.equal(runnerCalls.filter(([kind]) => kind === 'run').length, 1);

// 8：not_current_host → ignored，不 run / 不 claim。
runnerCalls.length = 0;
currentHostAIId = 'other-ai';
const wrongHost = await runHeadlessAISchedule(callback);
assert.deepEqual(wrongHost, { status: 'ignored', reason: 'not_current_host' });
assert.equal(runnerCalls.some(([kind]) => kind === 'claim'), false);
assert.equal(runnerCalls.some(([kind]) => kind === 'run'), false);
currentHostAIId = 'host-ai';

// 12：run 抛错，仍必须 consume。
runnerCalls.length = 0;
claimOutcomes.push(claimedOutcome);
runError = new Error('model failed');
await assert.rejects(runHeadlessAISchedule(callback), /model failed/);
assert.equal(runnerCalls.filter(([kind]) => kind === 'consume').length, 1);
assert.deepEqual(runnerCalls.find(([kind]) => kind === 'complete'), [
  'complete', 'generated-run', 'interrupted',
]);
runError = null;

// 13：consume 非 consumed → 抛错。
runnerCalls.length = 0;
claimOutcomes.push(claimedOutcome);
consumeOutcome = { status: 'error', code: 'run_mismatch' };
await assert.rejects(runHeadlessAISchedule(callback), /consume 失败/);
// recovery 与当前 run 竞争时，另一路已先提交 consumed；当前 run 不得重新执行，
// 但已终态的 already_terminal 结果应被视为幂等收口。
runnerCalls.length = 0;
claimOutcomes.push(claimedOutcome);
consumeOutcome = { status: 'error', code: 'already_terminal' };
const alreadyTerminalRun = await runHeadlessAISchedule(callback);
assert.equal(alreadyTerminalRun.status, 'ran');
assert.equal(runnerCalls.filter(([kind]) => kind === 'consume').length, 1);
consumeOutcome = { status: 'consumed' };

// ---------------------------------------------------------------------------
// Part D：Headless router 按 triggerKind 区分 Self Wake / AI Schedule，且
// completion/delivery dedupe identity 使用 deliveryEventId（scheduleId@token）。
// ---------------------------------------------------------------------------
const cancellationRegistryModule = loadModule(
  'src/features/companion/application/CompanionExecutionCancellation.ts',
  {},
);
const routerMocks = {
  './CompanionExecutionCancellation': cancellationRegistryModule,
  './CompanionRuntimeDependencies': {
    getCompanionRuntimeDependencies: () => ({
      native: {
        companion: {
          recordRunnerCompletion: async (c) => runnerCalls.push(['completion', c]),
          consumeExecutionCancellation: async () => false,
        },
      },
    }),
  },
  './RunHeadlessAISchedule': {
    runHeadlessAISchedule: async () => ({ status: 'ignored', reason: 'not_current_host' }),
  },
};
const routerModule = loadModule(
  'src/features/companion/application/ExecuteCompanionWake.ts',
  routerMocks,
);
runnerCalls.length = 0;
await routerModule.runCompanionWake(callback);
assert.deepEqual(runnerCalls.at(-1), ['completion', {
  deliveryEventId: 'schedule-x@tok', succeeded: true, error: 'ai_schedule_ignored:not_current_host',
}], 'AI Schedule completion 必须用 deliveryEventId，避免 stale v1 毒死 v2');

const throwRouter = loadModule(
  'src/features/companion/application/ExecuteCompanionWake.ts',
  {
    './CompanionExecutionCancellation': cancellationRegistryModule,
    './CompanionRuntimeDependencies': {
      getCompanionRuntimeDependencies: () => ({
        native: {
          companion: {
            recordRunnerCompletion: async (c) => runnerCalls.push(['completion', c]),
            consumeExecutionCancellation: async () => false,
          },
        },
      }),
    },
    './RunHeadlessAISchedule': {
      runHeadlessAISchedule: async () => { throw new Error('boom'); },
    },
  },
);
runnerCalls.length = 0;
await assert.rejects(
  throwRouter.runCompanionWake(callback),
  /boom/,
);
assert.equal(runnerCalls.filter(([kind]) => kind === 'completion').length, 1);
assert.deepEqual(runnerCalls[0], ['completion', {
  deliveryEventId: 'schedule-x@tok', succeeded: false, error: 'boom',
}], 'headless execution terminal 只能 recordRunnerCompletion 一次');

console.log("AI schedule trigger runtime verified.");

function terminal(terminalCode) {
  return {
    taskId: 'autonomous-task',
    status: terminalCode === 'COMPLETED' ? 'completed' : 'failed',
    terminalCode,
    finalText: '',
    history: [],
    steps: [],
    stepCount: 1,
    toolCallCount: 0,
  };
}
