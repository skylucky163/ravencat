/**
 * RavenCat Soft Lock 业务真值验证：
 * domain 校验、SQLite schema 约束、repository 状态机与幂等语义、
 * application 层 validate → persist → after-commit native reconcile 顺序，
 * 以及 DC4-B AI lock 的 actor + target dedupe / release ownership。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadTypeScriptModule as loadTypeScriptModuleWithMocks } from './helpers/load-typescript-module.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

const abortSignalRuntime = loadTypeScriptModuleWithMocks(
  'src/shared/runtime/abortSignal.ts',
  {},
);

const exclusiveTransactionTails = new WeakMap();

function createCoordinatorBackedExecutor(database) {
  const executor = {
    getFirstAsync: async (sql, params = []) => database.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => database.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = database.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    execAsync: async (sql) => {
      database.exec(sql);
    },
    withExclusiveTransactionAsync: (task) => {
      const previous = exclusiveTransactionTails.get(database) ?? Promise.resolve();
      const result = previous.then(async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const value = await task(executor);
          database.exec('COMMIT');
          return value;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      });
      exclusiveTransactionTails.set(database, result.then(
        () => undefined,
        () => undefined
      ));
      return result;
    },
    withExclusiveWriteScopeAsync: async (task) => task(executor),
  };
  return executor;
}

const softAppLockModule = await loadTypeScriptModule(
  'src/features/deviceControl/domain/SoftAppLock.ts'
);
const softLockExecutionTruthModule = await loadTypeScriptModule(
  'src/features/deviceControl/application/SoftLockExecutionTruth.ts'
);
const schemaModule = await loadTypeScriptModule(
  'src/platform/persistence/sqlite/ravenCatDeviceControlSchema.ts'
);
const { DeviceControlFacade } = loadTypeScriptModuleWithMocks(
  'src/features/deviceControl/application/DeviceControlFacade.ts',
  {
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '../domain/SoftAppLock': softAppLockModule,
    './SoftLockExecutionTruth': softLockExecutionTruthModule,
  }
);
const { resolveSoftLockExecutionTruth } = softLockExecutionTruthModule;

const {
  createSoftAppLock,
  createSoftAppLockFromRow,
  isValidSoftAppLockTargetPackage,
} = softAppLockModule;

const NOW_MS = 1_000_000;
const LATER_MS = 2_000_000;

function createSoftAppLockDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(schemaModule.RAVEN_CAT_SOFT_APP_LOCKS_SCHEMA);
  database.exec(schemaModule.RAVEN_CAT_SOFT_APP_LOCKS_STATUS_INDEX);
  database.exec(schemaModule.RAVEN_CAT_SOFT_APP_LOCKS_AI_ACTIVE_TARGET_INDEX);
  return database;
}

function createRepository(database) {
  const repositoryModule = loadTypeScriptModuleWithMocks(
    'src/features/deviceControl/infrastructure/SQLiteSoftAppLockRepository.ts',
    {
      '@platform/persistence': {
        databaseCoordinator: { openTaskExecutor: () => createCoordinatorBackedExecutor(database) },
      },
      '../domain/SoftAppLock': softAppLockModule,
    }
  );
  return new repositoryModule.SQLiteSoftAppLockRepository();
}

function insertLock(database, lock) {
  database.prepare(`
    INSERT INTO raven_cat_soft_app_locks (
      id, target_package, source, source_ai_id, reason, created_at, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lock.id,
    lock.targetPackage,
    lock.source,
    lock.sourceAiId ?? null,
    lock.reason ?? null,
    lock.createdAtEpochMs,
    lock.expiresAtEpochMs ?? null,
    lock.status,
  );
}

async function readLock(database, id) {
  const row = database.prepare(
    'SELECT * FROM raven_cat_soft_app_locks WHERE id = ?',
  ).get(id) ?? null;
  return createSoftAppLockFromRow(row);
}

function createTestPort(database) {
  const calls = [];
  const behavior = {
    start: { status: 'started', reason: null },
    reconcile: { status: 'ok', appliedCount: 0 },
    stop: { status: 'stopped', activeProjectionCount: 0, reason: null },
    runtimeState: () => runtimeState(),
  };
  const snapshotRows = () => database
    .prepare('SELECT id, status FROM raven_cat_soft_app_locks ORDER BY id')
    .all()
    .map((row) => ({ id: row.id, status: row.status }));
  const port = {
    startRuntime: async () => {
      calls.push({ method: 'start', rows: snapshotRows() });
      return typeof behavior.start === 'function'
        ? behavior.start()
        : behavior.start;
    },
    reconcileSoftLocks: async (projection) => {
      calls.push({ method: 'reconcile', projection, rows: snapshotRows() });
      return typeof behavior.reconcile === 'function'
        ? behavior.reconcile(projection)
        : behavior.reconcile;
    },
    getRuntimeState: async () => (
      typeof behavior.runtimeState === 'function'
        ? behavior.runtimeState()
        : behavior.runtimeState
    ),
    stopRuntimeIfIdle: async () => {
      calls.push({ method: 'stop', rows: snapshotRows() });
      return behavior.stop;
    },
  };
  return { port, calls, behavior };
}

function runtimeState(overrides = {}) {
  return {
    serviceRunning: false,
    runtimeAttached: false,
    observerConnected: false,
    currentWindow: null,
    projectedLocks: [],
    matchingLockId: null,
    targetMatched: false,
    shouldBlock: false,
    attached: false,
    attachedLockId: null,
    overlayStatus: 'detached',
    diagnostics: {
      attachedAtEpochMs: null,
      lastReconcileAtEpochMs: null,
      lastWindowEventAtEpochMs: null,
      lastConnectionEventAtEpochMs: null,
      lastFailure: null,
    },
    ...overrides,
  };
}

function readyRuntimeState(overrides = {}) {
  return runtimeState({
    serviceRunning: true,
    runtimeAttached: true,
    observerConnected: true,
    currentWindow: {
      packageName: 'com.example.target',
      windowId: 7,
      title: 'Target',
      detectionReliable: true,
      checkedAtEpochMs: NOW_MS,
      source: 'accessibility',
    },
    projectedLocks: [{
      id: 'lock-1',
      targetPackage: 'com.example.target',
      expiresAtEpochMs: LATER_MS,
    }],
    matchingLockId: 'lock-1',
    targetMatched: true,
    shouldBlock: true,
    attached: true,
    attachedLockId: 'lock-1',
    overlayStatus: 'attached',
    ...overrides,
  });
}

function resolveExecution(overrides = {}) {
  return resolveSoftLockExecutionTruth({
    lockId: 'lock-1',
    targetPackage: 'com.example.target',
    start: { status: 'started', reason: null },
    reconcile: { status: 'ok', appliedCount: 1 },
    runtimeState: readyRuntimeState(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 0. DC4-D：原生执行事实只在 application 层翻译为稳定 execution truth
// ---------------------------------------------------------------------------
{
  assert.deepEqual(resolveExecution(), { state: 'blocking_now' });

  assert.deepEqual(resolveExecution({
    runtimeState: readyRuntimeState({
      currentWindow: {
        packageName: 'com.example.other',
        windowId: 8,
        title: 'Other',
        detectionReliable: true,
        checkedAtEpochMs: NOW_MS,
        source: 'accessibility',
      },
      matchingLockId: null,
      targetMatched: false,
      shouldBlock: false,
      attached: false,
      attachedLockId: null,
      overlayStatus: 'detached',
    }),
  }), { state: 'waiting_for_target' });

  assert.deepEqual(resolveExecution({
    runtimeState: readyRuntimeState({
      currentWindow: {
        packageName: 'com.example.other',
        windowId: 8,
        title: 'Other',
        detectionReliable: true,
        checkedAtEpochMs: NOW_MS,
        source: 'accessibility',
      },
      projectedLocks: [
        {
          id: 'lock-1',
          targetPackage: 'com.example.target',
          expiresAtEpochMs: LATER_MS,
        },
        {
          id: 'lock-2',
          targetPackage: 'com.example.other',
          expiresAtEpochMs: LATER_MS,
        },
      ],
      matchingLockId: 'lock-2',
      targetMatched: true,
      shouldBlock: true,
      attached: true,
      attachedLockId: 'lock-2',
      overlayStatus: 'attached',
    }),
  }), { state: 'waiting_for_target' }, '另一条锁正在执行时，当前 target 仍是 waiting');

  const degradedCases = [
    {
      name: 'background start restricted',
      overrides: { start: { status: 'background_start_restricted', reason: 'Android policy' } },
      issue: 'background_start_restricted',
    },
    {
      name: 'service promotion background restricted',
      overrides: {
        reconcile: { status: 'runtime_unavailable', reason: 'runtime detached' },
        runtimeState: runtimeState({
          diagnostics: {
            attachedAtEpochMs: null,
            lastReconcileAtEpochMs: null,
            lastWindowEventAtEpochMs: null,
            lastConnectionEventAtEpochMs: null,
            lastFailure: {
              code: 'background_start_restricted',
              message: 'foreground promotion restricted',
            },
          },
        }),
      },
      issue: 'background_start_restricted',
    },
    {
      name: 'runtime unavailable',
      overrides: { runtimeState: readyRuntimeState({ runtimeAttached: false }) },
      issue: 'runtime_unavailable',
    },
    {
      name: 'overlay permission missing',
      overrides: {
        runtimeState: readyRuntimeState({
          attached: false,
          attachedLockId: null,
          overlayStatus: 'permission_missing',
        }),
      },
      issue: 'overlay_permission_missing',
    },
    {
      name: 'observer unavailable',
      overrides: {
        runtimeState: readyRuntimeState({
          observerConnected: false,
          currentWindow: null,
          matchingLockId: null,
          targetMatched: false,
          shouldBlock: false,
          attached: false,
          attachedLockId: null,
          overlayStatus: 'detached',
        }),
      },
      issue: 'observer_unavailable',
    },
    {
      name: 'window unreliable',
      overrides: {
        runtimeState: readyRuntimeState({
          currentWindow: {
            packageName: 'com.example.target',
            windowId: null,
            title: null,
            detectionReliable: false,
            checkedAtEpochMs: NOW_MS,
            source: 'accessibility',
          },
          matchingLockId: 'lock-1',
          targetMatched: true,
          shouldBlock: false,
          attached: false,
          attachedLockId: null,
          overlayStatus: 'detached',
        }),
      },
      issue: 'window_unreliable',
    },
    {
      name: 'reconcile failed',
      overrides: { reconcile: { status: 'failed', reason: 'native failure' } },
      issue: 'reconcile_failed',
    },
    {
      name: 'overlay add failed',
      overrides: {
        runtimeState: readyRuntimeState({
          attached: false,
          attachedLockId: null,
          overlayStatus: 'add_failed',
        }),
      },
      issue: 'overlay_add_failed',
    },
    {
      name: 'reconcile ok without attached overlay',
      overrides: {
        runtimeState: readyRuntimeState({
          attached: false,
          attachedLockId: null,
          overlayStatus: 'detached',
        }),
      },
      issue: 'execution_failed',
    },
    {
      name: 'native start failed',
      overrides: { start: { status: 'failed', reason: 'service start failed' } },
      issue: 'execution_failed',
    },
    {
      name: 'overlay remove failed',
      overrides: {
        runtimeState: readyRuntimeState({
          currentWindow: {
            packageName: 'com.example.other',
            windowId: 8,
            title: 'Other',
            detectionReliable: true,
            checkedAtEpochMs: NOW_MS,
            source: 'accessibility',
          },
          matchingLockId: null,
          targetMatched: false,
          shouldBlock: false,
          attached: false,
          attachedLockId: null,
          overlayStatus: 'remove_failed',
        }),
      },
      issue: 'execution_failed',
    },
  ];

  for (const { name, overrides, issue } of degradedCases) {
    assert.deepEqual(resolveExecution(overrides), {
      state: 'activated_but_not_executing',
      issue,
    }, name);
  }
}

// ---------------------------------------------------------------------------
// 1. Domain：校验与行映射
// ---------------------------------------------------------------------------
// 测试入口退休迁移：解除包括永不过期锁在内的历史 active 测试锁，保留 AI 锁和终态。
{
  const database = createSoftAppLockDatabase();
  const insert = database.prepare(`
    INSERT INTO raven_cat_soft_app_locks
      (id, target_package, source, source_ai_id, created_at, status)
    VALUES (?, 'com.example.target', ?, ?, ?, ?)
  `);
  insert.run('manual-active', 'manual_test', null, NOW_MS, 'active');
  insert.run('manual-expired', 'manual_test', null, NOW_MS, 'expired');
  insert.run('manual-released', 'manual_test', null, NOW_MS, 'released');
  insert.run('ai-active', 'ai_tool', 'ai-1', NOW_MS, 'active');
  database.exec(schemaModule.RAVEN_CAT_RELEASE_MANUAL_TEST_LOCKS);
  const rows = database.prepare('SELECT id, status FROM raven_cat_soft_app_locks ORDER BY id')
    .all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { id: 'ai-active', status: 'active' },
    { id: 'manual-active', status: 'released' },
    { id: 'manual-expired', status: 'expired' },
    { id: 'manual-released', status: 'released' },
  ]);
  database.exec(schemaModule.RAVEN_CAT_RELEASE_MANUAL_TEST_LOCKS);
  assert.deepEqual(
    database.prepare('SELECT id, status FROM raven_cat_soft_app_locks ORDER BY id')
      .all().map((row) => ({ ...row })),
    rows,
    '重复初始化不改变历史或 AI 锁',
  );
}

{
  assert.equal(isValidSoftAppLockTargetPackage('com.example.target'), true);
  for (const invalid of ['', '   ', 'com.example target', ' com.example.target']) {
    assert.equal(isValidSoftAppLockTargetPackage(invalid), false);
  }

  const lock = createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
  });
  assert.equal(lock.status, 'active', '新锁默认 active');

  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: '',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
  }), /targetPackage 非法/);
  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'unexpected',
    createdAtEpochMs: NOW_MS,
  }), /source 非法/);
  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    status: 'unknown',
  }), /status 非法/);
  assert.throws(() => createSoftAppLock({
    id: '',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
  }), /id 不能为空/);

  // ai_tool 来源必须带 sourceAiId；manual_test 不得带。
  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'ai_tool',
    createdAtEpochMs: NOW_MS,
  }), /sourceAiId/);
  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    sourceAiId: 'ai-1',
    createdAtEpochMs: NOW_MS,
  }), /sourceAiId/);
  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'ai_tool',
    sourceAiId: 'ai-1',
    createdAtEpochMs: NOW_MS,
  }), /expiresAtEpochMs/);

  // 过期时间必须是晚于创建时间的整数毫秒。
  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: NOW_MS,
  }), /expiresAtEpochMs/);
  assert.throws(() => createSoftAppLock({
    id: 'lock-1',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: 1.5,
  }), /expiresAtEpochMs/);

  // 行映射：null 列回可选字段，reason / sourceAiId / expiresAt 不丢失。
  const mapped = createSoftAppLockFromRow({
    id: 'lock-row',
    target_package: 'com.example.target',
    source: 'ai_tool',
    source_ai_id: 'ai-1',
    reason: '测试 Soft Lock',
    created_at: NOW_MS,
    expires_at: LATER_MS,
    status: 'expired',
  });
  assert.equal(mapped.id, 'lock-row');
  assert.equal(mapped.source, 'ai_tool');
  assert.equal(mapped.sourceAiId, 'ai-1');
  assert.equal(mapped.reason, '测试 Soft Lock');
  assert.equal(mapped.expiresAtEpochMs, LATER_MS);
  assert.equal(mapped.status, 'expired');
  assert.equal(createSoftAppLockFromRow(null), null);
  const mappedMinimal = createSoftAppLockFromRow({
    id: 'lock-min',
    target_package: 'com.example.target',
    source: 'manual_test',
    source_ai_id: null,
    reason: null,
    created_at: NOW_MS,
    expires_at: null,
    status: 'active',
  });
  assert.equal(mappedMinimal.sourceAiId, undefined);
  assert.equal(mappedMinimal.reason, undefined);
  assert.equal(mappedMinimal.expiresAtEpochMs, undefined);
}

// ---------------------------------------------------------------------------
// 2. Schema：约束与新库初始化幂等
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  // CREATE IF NOT EXISTS 重复执行不得抛错。
  database.exec(schemaModule.RAVEN_CAT_SOFT_APP_LOCKS_SCHEMA);
  database.exec(schemaModule.RAVEN_CAT_SOFT_APP_LOCKS_STATUS_INDEX);
  database.exec(schemaModule.RAVEN_CAT_SOFT_APP_LOCKS_AI_ACTIVE_TARGET_INDEX);

  const insert = database.prepare(`
    INSERT INTO raven_cat_soft_app_locks (
      id, target_package, source, source_ai_id, reason, created_at, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('lock-1', 'com.example.target', 'manual_test', null, null, NOW_MS, null, 'active');
  assert.throws(() => insert.run('lock-1', 'com.other', 'manual_test', null, null, NOW_MS, null, 'active'));
  assert.throws(() => insert.run('lock-2', '', 'manual_test', null, null, NOW_MS, null, 'active'));
  assert.throws(() => insert.run('lock-3', '  ', 'manual_test', null, null, NOW_MS, null, 'active'));
  assert.throws(() => insert.run('lock-4', 'com.example.target', 'unexpected', null, null, NOW_MS, null, 'active'));
  assert.throws(() => insert.run('lock-5', 'com.example.target', 'manual_test', null, null, NOW_MS, null, 'unknown'));
  assert.throws(() => insert.run('lock-6', 'com.example.target', 'ai_tool', null, null, NOW_MS, null, 'active'));
  assert.throws(() => insert.run('lock-7', 'com.example.target', 'manual_test', null, null, -1, null, 'active'));
}

// ---------------------------------------------------------------------------
// 3. Repository：业务真值状态机与幂等语义（真实 SQL）
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);

  const activeNoExpiry = createSoftAppLock({
    id: 'lock-active',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    reason: '测试 Soft Lock',
    createdAtEpochMs: NOW_MS,
  });
  const activeWithFutureExpiry = createSoftAppLock({
    id: 'lock-future',
    targetPackage: 'com.example.other',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  });
  insertLock(database, activeNoExpiry);
  insertLock(database, activeWithFutureExpiry);

  // active row 可由 listActive 得到；映射不丢 reason/sourceAiId/expiresAt。
  const activeList = await repository.listActive(NOW_MS);
  assert.deepEqual(activeList.map(({ id }) => id), ['lock-active', 'lock-future']);
  const activeRow = activeList.find(({ id }) => id === 'lock-active');
  assert.equal(activeRow.reason, '测试 Soft Lock');
  assert.equal(activeRow.source, 'manual_test');
  const futureRow = activeList.find(({ id }) => id === 'lock-future');
  assert.equal(futureRow.expiresAtEpochMs, LATER_MS);

  // released / expired / failed 行不属于 active。
  await database.prepare(`
    INSERT INTO raven_cat_soft_app_locks (
      id, target_package, source, source_ai_id, reason, created_at, expires_at, status
    ) VALUES (?, ?, 'manual_test', NULL, NULL, ?, NULL, ?)
  `).run('lock-released', 'com.example.released', NOW_MS, 'released');
  await database.prepare(`
    INSERT INTO raven_cat_soft_app_locks (
      id, target_package, source, source_ai_id, reason, created_at, expires_at, status
    ) VALUES (?, ?, 'manual_test', NULL, NULL, ?, ?, ?)
  `).run('lock-expired', 'com.example.expired', NOW_MS, NOW_MS + 1, 'expired');
  await database.prepare(`
    INSERT INTO raven_cat_soft_app_locks (
      id, target_package, source, source_ai_id, reason, created_at, expires_at, status
    ) VALUES (?, ?, 'manual_test', NULL, NULL, ?, NULL, ?)
  `).run('lock-failed', 'com.example.failed', NOW_MS, 'failed');
  assert.deepEqual(
    (await repository.listActive(NOW_MS)).map(({ id }) => id),
    ['lock-active', 'lock-future']
  );

  // 到期 active 行即使尚未落 expired 也不得被当作 active 投影。
  await database.prepare(`
    INSERT INTO raven_cat_soft_app_locks (
      id, target_package, source, source_ai_id, reason, created_at, expires_at, status
    ) VALUES (?, ?, 'manual_test', NULL, NULL, ?, ?, 'active')
  `).run('lock-due', 'com.example.due', NOW_MS, NOW_MS + 1);
  assert.deepEqual(
    (await repository.listActive(NOW_MS + 2)).map(({ id }) => id),
    ['lock-active', 'lock-future']
  );

  // expireDue：到期 active 明确转 expired，返回转换行；重复调用返回空。
  const expired = await repository.expireDue(NOW_MS + 2);
  assert.deepEqual(expired.map(({ id, status }) => ({ id, status })), [
    { id: 'lock-due', status: 'expired' },
  ]);
  assert.deepEqual(await repository.expireDue(NOW_MS + 2), []);
  assert.equal(
    (await readLock(database, 'lock-due')).status,
    'expired'
  );
  // 未到期的 active 不受影响。
  assert.deepEqual(
    (await repository.listActive(NOW_MS + 2)).map(({ id }) => id),
    ['lock-active', 'lock-future']
  );
  // 到期后（时间推进过 LATER_MS）可再次明确转换。
  assert.deepEqual(
    (await repository.expireDue(LATER_MS + 1)).map(({ id }) => id),
    ['lock-future']
  );

}

// ---------------------------------------------------------------------------
// 3.5 Repository：AI active dedupe 窄查询（真实 SQL）
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const first = await repository.insertAiLockIfNoActiveByActorAndTarget(createSoftAppLock({
    id: 'ai-lock-1',
    targetPackage: 'com.example.target',
    source: 'ai_tool',
    sourceAiId: 'ai-1',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  }), NOW_MS);
  assert.equal(first.outcome, 'inserted');
  insertLock(database, createSoftAppLock({
    id: 'manual-lock-1',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
  }));

  const duplicate = await repository.insertAiLockIfNoActiveByActorAndTarget(createSoftAppLock({
    id: 'ai-lock-duplicate',
    targetPackage: 'com.example.target',
    source: 'ai_tool',
    sourceAiId: 'ai-1',
    createdAtEpochMs: NOW_MS + 1,
    expiresAtEpochMs: LATER_MS + 1,
  }), NOW_MS);
  assert.equal(duplicate.outcome, 'already_active');
  assert.equal(duplicate.lock.id, 'ai-lock-1');
  assert.equal(await readLock(database, 'ai-lock-duplicate'), null);

  const anotherActor = await repository.insertAiLockIfNoActiveByActorAndTarget(createSoftAppLock({
    id: 'ai-lock-actor-2',
    targetPackage: 'com.example.target',
    source: 'ai_tool',
    sourceAiId: 'ai-2',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  }), NOW_MS);
  assert.equal(anotherActor.outcome, 'inserted', '不同 actor 不得互相 dedupe');

  const actorRelease = await repository.releaseActiveAiLockByActorAndTarget(
    'ai-1',
    'com.example.target'
  );
  assert.equal(actorRelease.outcome, 'released');
  assert.equal(actorRelease.lock.id, 'ai-lock-1');
  assert.equal((await readLock(database, 'manual-lock-1')).status, 'active');
  assert.equal((await readLock(database, 'ai-lock-actor-2')).status, 'active');
  assert.equal(
    (await repository.releaseActiveAiLockByActorAndTarget('ai-1', 'com.example.target')).outcome,
    'not_found',
    '已释放或其他来源/actor 的锁不得再次命中'
  );

  const afterExpiry = await repository.insertAiLockIfNoActiveByActorAndTarget(createSoftAppLock({
    id: 'ai-lock-after-expiry',
    targetPackage: 'com.example.target',
    source: 'ai_tool',
    sourceAiId: 'ai-1',
    createdAtEpochMs: LATER_MS,
    expiresAtEpochMs: LATER_MS + 1_000,
  }), LATER_MS);
  assert.equal(afterExpiry.outcome, 'inserted', '到期 AI lock 不得阻塞新业务事实');
}

// ---------------------------------------------------------------------------
// 4. Application：validate → persist → after-commit native reconcile
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const portSnapshots = [];
  const lifecycleCalls = [];
  const callOrder = [];
  let startResult = { status: 'started', reason: null };
  let portResult = { status: 'ok', appliedCount: 0 };
  let portError = null;
  const port = {
    startRuntime: async () => {
      callOrder.push('start');
      lifecycleCalls.push({
        method: 'start',
        rowsAtCallTime: database
          .prepare('SELECT id, status FROM raven_cat_soft_app_locks')
          .all()
          .map((row) => ({ id: row.id, status: row.status })),
      });
      return startResult;
    },
    reconcileSoftLocks: async (activeLocks) => {
      callOrder.push(`reconcile:${activeLocks.length}`);
      if (portError) {
        throw portError;
      }
      portSnapshots.push({
        projection: activeLocks,
        rowsAtCallTime: database
          .prepare('SELECT id, status FROM raven_cat_soft_app_locks')
          .all()
          .map((row) => ({ id: row.id, status: row.status })),
      });
      return typeof portResult === 'function' ? portResult(activeLocks) : portResult;
    },
    getRuntimeState: async () => createTestPort(database).port.getRuntimeState(),
    stopRuntimeIfIdle: async () => {
      callOrder.push('stop');
      lifecycleCalls.push({ method: 'stop' });
      return { status: 'stopped', activeProjectionCount: 0, reason: null };
    },
  };
  let idSequence = 0;
  let clockMs = NOW_MS;
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => `soft-lock-${++idSequence}`,
    nowEpochMs: () => clockMs,
  });

  // 空 package 在 application 被拒绝：不落库、不触发 native。
  assert.deepEqual(
    await facade.activateAiSoftLock({ sourceAiId: 'ai-test', expiresAtEpochMs: LATER_MS, targetPackage: '   ' }),
    { status: 'rejected', reason: 'invalid_target_package' }
  );
  // 过期时间不晚于当前时钟同样被拒绝。
  assert.deepEqual(
    await facade.activateAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.target', expiresAtEpochMs: NOW_MS }),
    { status: 'rejected', reason: 'invalid_expiry' }
  );
  assert.equal(portSnapshots.length, 0);
  assert.equal(lifecycleCalls.length, 0);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM raven_cat_soft_app_locks').get().count,
    0
  );

  // activate：业务事实先提交，port 调用时行已在库中为 active。
  const activated = await facade.activateAiSoftLock({
    sourceAiId: 'ai-test',
    targetPackage: 'com.example.target',
    reason: '测试 Soft Lock',
    expiresAtEpochMs: LATER_MS,
  });
  assert.equal(activated.status, 'activated');
  assert.equal(activated.lock.id, 'soft-lock-1');
  assert.equal(activated.lock.source, 'ai_tool');
  assert.equal(activated.native.start.status, 'started');
  assert.equal(activated.native.reconcile.status, 'ok');
  assert.deepEqual(lifecycleCalls[0].rowsAtCallTime, [
    { id: 'soft-lock-1', status: 'active' },
  ], 'runtime start 必须发生在业务 active 事实提交之后');
  assert.equal(portSnapshots.length, 1);
  assert.deepEqual(portSnapshots[0].projection, [{
    id: 'soft-lock-1',
    targetPackage: 'com.example.target',
    expiresAtEpochMs: LATER_MS,
  }]);
  assert.deepEqual(portSnapshots[0].rowsAtCallTime, [
    { id: 'soft-lock-1', status: 'active' },
  ], 'native reconcile 必须发生在业务事实提交之后');

  // native typed failure 不得伪造业务结果：失败后行仍是 active。
  portResult = { status: 'failed', reason: 'native runtime 故障' };
  const nativeFailed = await facade.activateAiSoftLock({
    sourceAiId: 'ai-test',
    targetPackage: 'com.example.other',
    expiresAtEpochMs: NOW_MS + 100,
  });
  assert.equal(nativeFailed.status, 'activated');
  assert.equal(nativeFailed.native.reconcile.status, 'failed');
  assert.equal((await readLock(database, 'soft-lock-2')).status, 'active');

  // release：先提交 released，之后 port 收到剩余 active 投影；结果幂等语义明确。
  const released = await facade.releaseAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.target' });
  assert.equal(released.status, 'released');
  assert.equal(released.lock.status, 'released');
  assert.equal(released.native.stop, null, '仍有 active lock 时不得停止 runtime');
  assert.deepEqual(portSnapshots.at(-1).projection, [{
    id: 'soft-lock-2',
    targetPackage: 'com.example.other',
    expiresAtEpochMs: NOW_MS + 100,
  }]);
  assert.ok(
    portSnapshots.at(-1).rowsAtCallTime.some(({ id, status }) => (
      id === 'soft-lock-1' && status === 'released'
    )),
    'release 业务状态必须先于 native reconcile 提交'
  );
  assert.equal((await facade.releaseAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.target' })).status, 'not_found');
  assert.equal((await facade.releaseAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.missing' })).status, 'not_found');

  // reconcile：到期行先落 expired，再投影剩余 active。
  clockMs = LATER_MS + 1;
  const expireResult = await facade.reconcileDeviceControl();
  assert.deepEqual(expireResult.expired.map(({ id }) => id), ['soft-lock-2']);
  assert.deepEqual(expireResult.active, []);
  assert.deepEqual(portSnapshots.at(-1).projection, []);
  assert.equal(expireResult.native.stop.status, 'stopped');
  assert.deepEqual(
    callOrder.slice(-2),
    ['reconcile:0', 'stop'],
    '最后一条锁到期后必须先 reconcile([]) 再 stopRuntimeIfIdle'
  );
  assert.equal((await readLock(database, 'soft-lock-2')).status, 'expired');

  // Repository 读路径是纯查询——已过时间但仍 active 的行只被过滤，
  // 数据库 status 不被修改，也不触发 native reconcile。
  const beforeSnapshotCount = portSnapshots.length;
  await facade.activateAiSoftLock({
    sourceAiId: 'ai-test',
    targetPackage: 'com.example.third',
    expiresAtEpochMs: clockMs + 10,
  });
  clockMs = clockMs + 11;
  const activeLocks = await repository.listActive(clockMs);
  assert.deepEqual(activeLocks, [], '到期 active 行在查询结果中只被过滤');
  assert.equal(
    (await readLock(database, 'soft-lock-3')).status,
    'active',
    '读路径不得把到期行写成 expired'
  );
  assert.equal(portSnapshots.length, beforeSnapshotCount + 1, '读路径不得触发 native reconcile');

  // release 一个已过期但尚未归一化的 active lock：
  // 先 expireDue 归一化，目标保持 expired 终态并返回 not_found，不得覆盖成 released。
  const expiredRelease = await facade.releaseAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.third' });
  assert.equal(expiredRelease.status, 'not_found');
  assert.equal((await readLock(database, 'soft-lock-3')).status, 'expired');
  assert.ok(
    portSnapshots.at(-1).rowsAtCallTime.some(({ id, status }) => (
      id === 'soft-lock-3' && status === 'expired'
    )),
    'release 已到期目标时 expired 终态必须先于 native reconcile 提交'
  );
  assert.deepEqual(portSnapshots.at(-1).projection, []);

  // native port 抛异常（编程错误）时业务事实已提交且不回滚。
  portError = new Error('port crashed');
  await assert.rejects(
    facade.activateAiSoftLock({ sourceAiId: 'ai-test', expiresAtEpochMs: clockMs + 1_000, targetPackage: 'com.example.fourth' }),
    /port crashed/
  );
  const crashLock = await readLock(database, 'soft-lock-4');
  assert.equal(crashLock.status, 'active', 'port 崩溃不得回滚或伪造业务真值');
}

// ---------------------------------------------------------------------------
// 4.2 DC4-B Application：AI business fact、dedupe 与 native failure
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls, behavior } = createTestPort(database);
  let idSequence = 0;
  let clockMs = NOW_MS;
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => `ai-soft-lock-${++idSequence}`,
    nowEpochMs: () => clockMs,
  });

  behavior.runtimeState = () => readyRuntimeState({
    projectedLocks: [{
      id: 'ai-soft-lock-1',
      targetPackage: 'com.example.target',
      expiresAtEpochMs: LATER_MS,
    }],
    matchingLockId: 'ai-soft-lock-1',
    attachedLockId: 'ai-soft-lock-1',
  });

  assert.deepEqual(
    await facade.activateAiSoftLock({
      targetPackage: ' ',
      sourceAiId: 'ai-1',
      expiresAtEpochMs: LATER_MS,
    }),
    { status: 'rejected', reason: 'invalid_target_package' }
  );
  assert.deepEqual(
    await facade.activateAiSoftLock({
      targetPackage: 'com.example.target',
      sourceAiId: 'ai-1',
    }),
    { status: 'rejected', reason: 'invalid_expiry' },
    'AI lock 缺少 expiry 必须在写入前拒绝'
  );
  assert.deepEqual(
    await facade.activateAiSoftLock({
      targetPackage: 'com.example.target',
      sourceAiId: 'ai-1',
      expiresAtEpochMs: NOW_MS,
    }),
    { status: 'rejected', reason: 'invalid_expiry' }
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM raven_cat_soft_app_locks').get().count,
    0,
    '非法 AI activation 不得写业务事实'
  );
  assert.deepEqual(calls, [], '非法 AI activation 不得触发 native');

  const activated = await facade.activateAiSoftLock({
    targetPackage: 'com.example.target',
    sourceAiId: 'ai-1',
    reason: '  专注工作  ',
    expiresAtEpochMs: LATER_MS,
  });
  assert.equal(activated.status, 'activated');
  assert.equal(activated.lock.source, 'ai_tool');
  assert.equal(activated.lock.sourceAiId, 'ai-1');
  assert.equal(activated.lock.reason, '专注工作');
  assert.equal(activated.lock.expiresAtEpochMs, LATER_MS);
  assert.equal(activated.native.reconcile.status, 'ok');
  assert.deepEqual(activated.execution, { state: 'blocking_now' });
  const persistedActivated = await readLock(database, activated.lock.id);
  assert.equal(persistedActivated.source, 'ai_tool');
  assert.equal(persistedActivated.sourceAiId, 'ai-1');
  assert.equal(persistedActivated.expiresAtEpochMs, LATER_MS);
  assert.deepEqual(calls[0].rows, [{ id: 'ai-soft-lock-1', status: 'active' }]);

  const duplicate = await facade.activateAiSoftLock({
    targetPackage: 'com.example.target',
    sourceAiId: 'ai-1',
    reason: '不得覆盖',
    expiresAtEpochMs: LATER_MS + 100,
  });
  assert.equal(duplicate.status, 'already_active');
  assert.equal(duplicate.lock.id, 'ai-soft-lock-1');
  assert.equal(duplicate.lock.reason, '专注工作');
  assert.equal(duplicate.lock.expiresAtEpochMs, LATER_MS);
  assert.deepEqual(duplicate.execution, { state: 'blocking_now' });
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM raven_cat_soft_app_locks
      WHERE source = 'ai_tool'
        AND source_ai_id = 'ai-1'
        AND target_package = 'com.example.target'
        AND status = 'active'
    `).get().count,
    1,
    'dedupe 不得插入第二条 active business fact'
  );

  // 历史测试锁由存量数据提供，不再通过退役的手动创建入口构造。
  const manual = createSoftAppLock({
    id: 'historical-manual-dedupe',
    targetPackage: 'com.example.target',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  });
  insertLock(database, manual);
  const anotherActor = await facade.activateAiSoftLock({
    targetPackage: 'com.example.target',
    sourceAiId: 'ai-2',
    expiresAtEpochMs: LATER_MS,
  });
  assert.equal(anotherActor.status, 'activated', '不同 actor 必须拥有独立业务事实');

  behavior.reconcile = { status: 'failed', reason: 'native reconcile failed' };
  const duplicateReconcileFailed = await facade.activateAiSoftLock({
    targetPackage: 'com.example.target',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS + 200,
  });
  assert.equal(duplicateReconcileFailed.status, 'already_active');
  assert.deepEqual(duplicateReconcileFailed.execution, {
    state: 'activated_but_not_executing',
    issue: 'reconcile_failed',
  }, 'native failure 不得把 already_active 业务事实改写成失败');

  const reconcileFailed = await facade.activateAiSoftLock({
    targetPackage: 'com.example.reconcile-failed',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  });
  assert.equal(reconcileFailed.status, 'activated');
  assert.equal(reconcileFailed.native.reconcile.status, 'failed');
  assert.deepEqual(reconcileFailed.execution, {
    state: 'activated_but_not_executing',
    issue: 'reconcile_failed',
  });
  assert.equal((await readLock(database, reconcileFailed.lock.id)).status, 'active');

  clockMs = LATER_MS + 1;
  const recreated = await facade.activateAiSoftLock({
    targetPackage: 'com.example.target',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS + 1_000,
  });
  assert.equal(recreated.status, 'activated', '旧 lock 到期归一化后必须允许重新创建');
  assert.equal((await readLock(database, 'ai-soft-lock-1')).status, 'expired');
}

// ---------------------------------------------------------------------------
// 4.3 DC4-F Application：AI release ownership + commit 后 full reconcile
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls } = createTestPort(database);
  let idSequence = 0;
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => `release-scope-${++idSequence}`,
    nowEpochMs: () => NOW_MS,
  });

  const own = await facade.activateAiSoftLock({
    targetPackage: 'com.example.shared',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  });
  const manual = createSoftAppLock({
    id: 'historical-manual-release',
    targetPackage: 'com.example.shared',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  });
  insertLock(database, manual);
  const otherActor = await facade.activateAiSoftLock({
    targetPackage: 'com.example.shared',
    sourceAiId: 'ai-2',
    expiresAtEpochMs: LATER_MS,
  });

  const released = await facade.releaseAiSoftLock({
    targetPackage: 'com.example.shared',
    sourceAiId: 'ai-1',
  });
  assert.equal(released.status, 'released');
  assert.equal(released.lock.id, own.lock.id);
  assert.equal((await readLock(database, own.lock.id)).status, 'released');
  assert.equal((await readLock(database, manual.id)).status, 'active');
  assert.equal((await readLock(database, otherActor.lock.id)).status, 'active');
  assert.deepEqual(
    calls.at(-1).projection.map(({ id }) => id),
    [manual.id, otherActor.lock.id],
    'release commit 后必须把 manual 与其他 AI 的剩余 active truth 全量 reconcile'
  );
  assert.ok(
    calls.at(-1).rows.some(({ id, status }) => id === own.lock.id && status === 'released'),
    'AI release 业务事实必须先于 native reconcile 提交'
  );

  const noOwnedLock = await facade.releaseAiSoftLock({
    targetPackage: 'com.example.shared',
    sourceAiId: 'ai-1',
  });
  assert.equal(noOwnedLock.status, 'not_found');
  assert.equal((await readLock(database, manual.id)).status, 'active');
  assert.equal((await readLock(database, otherActor.lock.id)).status, 'active');
}

{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls, behavior } = createTestPort(database);
  behavior.start = {
    status: 'background_start_restricted',
    reason: 'Android 拒绝后台首次启动 FGS',
  };
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'ai-soft-lock-restricted',
    nowEpochMs: () => NOW_MS,
  });

  const restricted = await facade.activateAiSoftLock({
    targetPackage: 'com.example.restricted',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  });
  assert.equal(restricted.status, 'activated');
  assert.equal(restricted.native.start.status, 'background_start_restricted');
  assert.equal(restricted.native.reconcile, null);
  assert.deepEqual(restricted.execution, {
    state: 'activated_but_not_executing',
    issue: 'background_start_restricted',
  });
  assert.equal((await readLock(database, 'ai-soft-lock-restricted')).status, 'active');
  assert.deepEqual(calls.map(({ method }) => method), ['start']);
}

// 并发重复命令必须共享 commandTail：第二条在第一条投影完成后再 dedupe，只有一个业务 winner。
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, behavior } = createTestPort(database);
  let releaseFirstStart;
  let markFirstStartEntered;
  const firstStartEntered = new Promise((resolve) => {
    markFirstStartEntered = resolve;
  });
  const firstStartGate = new Promise((resolve) => {
    releaseFirstStart = resolve;
  });
  let startCount = 0;
  behavior.start = async () => {
    startCount += 1;
    if (startCount === 1) {
      markFirstStartEntered();
      await firstStartGate;
    }
    return { status: 'started', reason: null };
  };
  let idSequence = 0;
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => `ai-soft-lock-race-${++idSequence}`,
    nowEpochMs: () => NOW_MS,
  });
  const input = {
    targetPackage: 'com.example.race',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  };

  const first = facade.activateAiSoftLock(input);
  await firstStartEntered;
  const second = facade.activateAiSoftLock(input);
  releaseFirstStart();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map(({ status }) => status), ['activated', 'already_active']);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM raven_cat_soft_app_locks
      WHERE source = 'ai_tool'
        AND source_ai_id = 'ai-1'
        AND target_package = 'com.example.race'
        AND status = 'active'
    `).get().count,
    1
  );
}

// Device Control command queue 中等待的 AI 命令必须在业务 commit 前重新消费同一 signal。
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, behavior } = createTestPort(database);
  let releaseFirstStart;
  let markFirstStartEntered;
  const firstStartEntered = new Promise((resolve) => {
    markFirstStartEntered = resolve;
  });
  const firstStartGate = new Promise((resolve) => {
    releaseFirstStart = resolve;
  });
  let startCount = 0;
  behavior.start = async () => {
    startCount += 1;
    if (startCount === 1) {
      markFirstStartEntered();
      await firstStartGate;
    }
    return { status: 'started', reason: null };
  };
  let idSequence = 0;
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => `ai-soft-lock-abort-${++idSequence}`,
    nowEpochMs: () => NOW_MS,
  });
  const first = facade.activateAiSoftLock({
    targetPackage: 'com.example.queue-owner',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  });
  await firstStartEntered;

  const queuedController = new AbortController();
  const queued = facade.activateAiSoftLock({
    targetPackage: 'com.example.aborted-in-queue',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  }, queuedController.signal);
  queuedController.abort(new Error('queued soft lock superseded'));
  releaseFirstStart();

  assert.equal((await first).status, 'activated');
  await assert.rejects(queued, /queued soft lock superseded/u);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM raven_cat_soft_app_locks
      WHERE target_package = 'com.example.aborted-in-queue'
    `).get().count,
    0,
    '在 Device Control queue 中已 abort 的敏感工具不得稍后提交业务事实'
  );

  const releaseTarget = await facade.activateAiSoftLock({
    targetPackage: 'com.example.release-after-abort',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  });
  assert.equal(releaseTarget.status, 'activated');

  let releaseFirstReconcile;
  let markFirstReconcileEntered;
  const firstReconcileEntered = new Promise((resolve) => {
    markFirstReconcileEntered = resolve;
  });
  const firstReconcileGate = new Promise((resolve) => {
    releaseFirstReconcile = resolve;
  });
  let reconcileCount = 0;
  behavior.reconcile = async () => {
    reconcileCount += 1;
    if (reconcileCount === 1) {
      markFirstReconcileEntered();
      await firstReconcileGate;
    }
    return { status: 'ok', appliedCount: 0 };
  };

  const firstRelease = facade.releaseAiSoftLock({
    targetPackage: 'com.example.queue-owner',
    sourceAiId: 'ai-1',
  });
  await firstReconcileEntered;
  const queuedReleaseController = new AbortController();
  const queuedRelease = facade.releaseAiSoftLock({
    targetPackage: 'com.example.release-after-abort',
    sourceAiId: 'ai-1',
  }, queuedReleaseController.signal);
  queuedReleaseController.abort(new Error('queued release cancelled'));
  releaseFirstReconcile();

  assert.equal((await firstRelease).status, 'released');
  await assert.rejects(queuedRelease, /queued release cancelled/u);
  assert.equal(
    (await readLock(database, releaseTarget.lock.id)).status,
    'active',
    '在 command queue 中已 abort 的 release 不得稍后改写 Soft Lock 事实'
  );
}

// repository CAS 还必须覆盖多个 Facade 实例；commandTail 不是跨实例业务锁。
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port } = createTestPort(database);
  const firstFacade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'ai-soft-lock-facade-1',
    nowEpochMs: () => NOW_MS,
  });
  const secondFacade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'ai-soft-lock-facade-2',
    nowEpochMs: () => NOW_MS,
  });
  const input = {
    targetPackage: 'com.example.cross-facade-race',
    sourceAiId: 'ai-1',
    expiresAtEpochMs: LATER_MS,
  };

  const results = await Promise.all([
    firstFacade.activateAiSoftLock(input),
    secondFacade.activateAiSoftLock(input),
  ]);

  assert.deepEqual(
    results.map(({ status }) => status).sort(),
    ['activated', 'already_active'],
    '跨 Facade 并发必须只有一个业务 winner'
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM raven_cat_soft_app_locks
      WHERE source = 'ai_tool'
        AND source_ai_id = 'ai-1'
        AND target_package = 'com.example.cross-facade-race'
        AND status = 'active'
    `).get().count,
    1
  );
}

// ---------------------------------------------------------------------------
// 4.5 release command 单一时钟：expireDue + release + reconcile 共用 captured now
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const repositoryCalls = [];
  const trackingRepository = {
    insertAiLockIfNoActiveByActorAndTarget: (lock, nowEpochMs) =>
      repository.insertAiLockIfNoActiveByActorAndTarget(lock, nowEpochMs),
    listActive: (nowEpochMs) => {
      repositoryCalls.push({ method: 'listActive', nowEpochMs });
      return repository.listActive(nowEpochMs);
    },
    releaseActiveAiLockByActorAndTarget: (sourceAiId, targetPackage) => {
      repositoryCalls.push({ method: 'release', sourceAiId, targetPackage });
      return repository.releaseActiveAiLockByActorAndTarget(sourceAiId, targetPackage);
    },
    expireDue: (nowEpochMs) => {
      repositoryCalls.push({ method: 'expireDue', nowEpochMs });
      return repository.expireDue(nowEpochMs);
    },
  };
  const port = {
    startRuntime: async () => ({ status: 'started', reason: null }),
    reconcileSoftLocks: async () => ({ status: 'ok', appliedCount: 0 }),
    getRuntimeState: async () => createTestPort(database).port.getRuntimeState(),
    stopRuntimeIfIdle: async () => ({
      status: 'stopped',
      activeProjectionCount: 0,
      reason: null,
    }),
  };
  let clockTicks = 0;
  const facade = new DeviceControlFacade({
    repository: trackingRepository,
    port,
    generateId: () => 'soft-lock-clock',
    // 每次读取时钟都前进：若 command 内多处单独取 now，捕获值必然不一致。
    nowEpochMs: () => ++clockTicks,
  });
  await facade.activateAiSoftLock({ sourceAiId: 'ai-test', expiresAtEpochMs: LATER_MS, targetPackage: 'com.example.clock' });
  const releaseCallStart = repositoryCalls.length;
  await facade.releaseAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.clock' });
  const commandCalls = repositoryCalls.slice(releaseCallStart);
  assert.deepEqual(
    commandCalls.map(({ method }) => method),
    ['expireDue', 'release', 'listActive'],
    'release command 必须依次执行 expireDue → release → 提交后 reconcile'
  );
  assert.equal(
    commandCalls[0].nowEpochMs,
    commandCalls[2].nowEpochMs,
    'expireDue 与 reconcile 必须使用同一个 captured now'
  );
  assert.equal((await readLock(database, 'soft-lock-clock')).status, 'released');
}

// ---------------------------------------------------------------------------
// 5. DC2-F runtime lifecycle：start failure、release/expire idle 与 startup reconcile
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls, behavior } = createTestPort(database);
  behavior.start = {
    status: 'background_start_restricted',
    reason: 'Android 拒绝后台首次启动 FGS',
  };
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'soft-lock-restricted',
    nowEpochMs: () => NOW_MS,
  });

  const activation = await facade.activateAiSoftLock({
    sourceAiId: 'ai-test', expiresAtEpochMs: LATER_MS,
    targetPackage: 'com.example.restricted',
  });
  assert.equal(activation.status, 'activated');
  assert.equal(activation.native.start.status, 'background_start_restricted');
  assert.equal(activation.native.reconcile, null, 'start 失败后不得伪造 reconcile 成功');
  assert.equal((await readLock(database, 'soft-lock-restricted')).status, 'active');
  assert.deepEqual(calls.map(({ method }) => method), ['start']);
}

{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls } = createTestPort(database);
  let clockMs = NOW_MS;
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'soft-lock-last',
    nowEpochMs: () => clockMs,
  });

  await facade.activateAiSoftLock({
    sourceAiId: 'ai-test',
    targetPackage: 'com.example.last',
    expiresAtEpochMs: LATER_MS,
  });
  calls.length = 0;
  const released = await facade.releaseAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.last' });
  assert.equal(released.status, 'released');
  assert.deepEqual(calls.map(({ method }) => method), ['reconcile', 'stop']);
  assert.deepEqual(calls[0].projection, []);

  insertLock(database, createSoftAppLock({
    id: 'soft-lock-due-startup',
    targetPackage: 'com.example.due-startup',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  }));
  clockMs = LATER_MS + 1;
  calls.length = 0;
  const expired = await facade.reconcileDeviceControl();
  assert.deepEqual(expired.expired.map(({ id }) => id), ['soft-lock-due-startup']);
  assert.deepEqual(calls.map(({ method }) => method), ['reconcile', 'stop']);
  assert.equal((await readLock(database, 'soft-lock-due-startup')).status, 'expired');
}

{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls, behavior } = createTestPort(database);
  insertLock(database, createSoftAppLock({
    id: 'soft-lock-startup-active',
    targetPackage: 'com.example.startup',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  }));
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  const startup = await facade.reconcileDeviceControl();
  assert.deepEqual(calls.map(({ method }) => method), ['start', 'reconcile']);
  assert.deepEqual(calls[1].projection.map(({ id }) => id), ['soft-lock-startup-active']);
  assert.equal(startup.active.length, 1);

  calls.length = 0;
  behavior.start = {
    status: 'background_start_restricted',
    reason: 'background restricted',
  };
  const restricted = await facade.reconcileDeviceControl();
  assert.deepEqual(calls.map(({ method }) => method), ['start']);
  assert.equal(restricted.native.reconcile, null);
  assert.equal((await readLock(database, 'soft-lock-startup-active')).status, 'active');
}

{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls } = createTestPort(database);
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  const startup = await facade.reconcileDeviceControl();
  assert.deepEqual(startup.active, []);
  assert.deepEqual(calls.map(({ method }) => method), ['reconcile', 'stop']);
  assert.deepEqual(calls[0].projection, []);
}

// 较早 startup snapshot 与较晚 release 必须由同一个 application owner 串行，
// 最终 native projection 只能是 release 后的空集合。
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const { port, calls, behavior } = createTestPort(database);
  insertLock(database, createSoftAppLock({
    id: 'soft-lock-race',
    targetPackage: 'com.example.race',
    source: 'ai_tool',
    sourceAiId: 'ai-test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  }));
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  behavior.start = async () => {
    await startGate;
    return { status: 'started', reason: null };
  };
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  const startupPromise = facade.reconcileDeviceControl();
  await Promise.resolve();
  const releasePromise = facade.releaseAiSoftLock({ sourceAiId: 'ai-test', targetPackage: 'com.example.race' });
  releaseStart();
  await Promise.all([startupPromise, releasePromise]);
  const projections = calls
    .filter(({ method }) => method === 'reconcile')
    .map(({ projection }) => projection.map(({ id }) => id));
  assert.deepEqual(projections, [['soft-lock-race'], []]);
  assert.equal((await readLock(database, 'soft-lock-race')).status, 'released');
}

// ---------------------------------------------------------------------------
// 6. DC2-G factory-reset quiesce、command gate 与 process recovery
// ---------------------------------------------------------------------------
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const calls = [];
  const states = [
    runtimeState({
      serviceRunning: true,
      runtimeAttached: true,
      attached: true,
      attachedLockId: 'soft-lock-reset',
      overlayStatus: 'attached',
    }),
    runtimeState({ serviceRunning: true, runtimeAttached: true }),
    runtimeState({ serviceRunning: true }),
    runtimeState(),
  ];
  const port = {
    startRuntime: async () => ({ status: 'started', reason: null }),
    reconcileSoftLocks: async (projection) => {
      calls.push({ method: 'reconcile', projection });
      return { status: 'ok', appliedCount: projection.length };
    },
    getRuntimeState: async () => {
      calls.push({ method: 'state' });
      return states.shift() ?? runtimeState();
    },
    stopRuntimeIfIdle: async () => {
      calls.push({ method: 'stop' });
      return { status: 'stopped', activeProjectionCount: 0, reason: null };
    },
  };
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  await facade.quiesceForFactoryReset();

  assert.deepEqual(
    calls.map(({ method }) => method),
    ['state', 'reconcile', 'state', 'stop', 'state', 'state'],
    '恢复出厂必须 reconcile([]) → 确认 window detached → stop → 等待 Service 真正退出'
  );
  assert.deepEqual(calls.find(({ method }) => method === 'reconcile').projection, []);
  facade.resumeAfterFactoryReset();
}

{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  let reconcileCount = 0;
  let stopCount = 0;
  const facade = new DeviceControlFacade({
    repository,
    port: {
      startRuntime: async () => ({ status: 'started', reason: null }),
      reconcileSoftLocks: async () => {
        reconcileCount += 1;
        return { status: 'ok', appliedCount: 0 };
      },
      getRuntimeState: async () => runtimeState(),
      stopRuntimeIfIdle: async () => {
        stopCount += 1;
        return { status: 'already_stopped', activeProjectionCount: 0, reason: null };
      },
    },
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  await facade.quiesceForFactoryReset();
  assert.equal(reconcileCount, 0, '已完全停止时 quiesce 必须幂等');
  assert.equal(stopCount, 0, '已完全停止时不重复请求 stop');
  facade.resumeAfterFactoryReset();
}

{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  const calls = [];
  const facade = new DeviceControlFacade({
    repository,
    port: {
      startRuntime: async () => ({ status: 'started', reason: null }),
      reconcileSoftLocks: async () => {
        calls.push('reconcile');
        return { status: 'failed', reason: 'native reconcile failed' };
      },
      getRuntimeState: async () => runtimeState({
        serviceRunning: true,
        runtimeAttached: true,
        attached: true,
        overlayStatus: 'attached',
      }),
      stopRuntimeIfIdle: async () => {
        calls.push('stop');
        return { status: 'stopped', activeProjectionCount: 0, reason: null };
      },
    },
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  await assert.rejects(facade.quiesceForFactoryReset(), /空投影同步失败/);
  assert.deepEqual(calls, ['reconcile'], 'reconcile 失败后不得继续 stop');
  facade.resumeAfterFactoryReset();
}

{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  let stateReadCount = 0;
  const facade = new DeviceControlFacade({
    repository,
    port: {
      startRuntime: async () => ({ status: 'started', reason: null }),
      reconcileSoftLocks: async () => ({ status: 'ok', appliedCount: 0 }),
      getRuntimeState: async () => {
        stateReadCount += 1;
        return stateReadCount === 1
          ? runtimeState({
            serviceRunning: true,
            runtimeAttached: true,
            attached: true,
            overlayStatus: 'attached',
          })
          : runtimeState({ serviceRunning: true });
      },
      stopRuntimeIfIdle: async () => ({
        status: 'stopped',
        activeProjectionCount: 0,
        reason: null,
      }),
    },
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  await assert.rejects(
    facade.quiesceForFactoryReset(),
    /Service 未在恢复出厂前停止/,
  );
  assert.ok(stateReadCount > 2, 'STOPPED 后必须继续有界观察 Service shutdown fact');
  facade.resumeAfterFactoryReset();
}

// quiesce gate 一经建立，随后读取到旧 SQLite active row 的 startup reconcile
// 也只能失败，不能排到空投影之后重新恢复 native projection。
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  insertLock(database, createSoftAppLock({
    id: 'soft-lock-reset-race',
    targetPackage: 'com.example.reset-race',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
  }));
  const calls = [];
  const facade = new DeviceControlFacade({
    repository,
    port: {
      startRuntime: async () => {
        calls.push('start');
        return { status: 'started', reason: null };
      },
      reconcileSoftLocks: async (projection) => {
        calls.push(`reconcile:${projection.length}`);
        return { status: 'ok', appliedCount: projection.length };
      },
      getRuntimeState: async () => runtimeState(),
      stopRuntimeIfIdle: async () => ({
        status: 'already_stopped',
        activeProjectionCount: 0,
        reason: null,
      }),
    },
    generateId: () => 'unused',
    nowEpochMs: () => NOW_MS,
  });

  const quiesce = facade.quiesceForFactoryReset();
  const lateStartup = facade.reconcileDeviceControl();
  await quiesce;
  await assert.rejects(lateStartup, /正在为恢复出厂安全关闭/);
  assert.deepEqual(calls, [], 'quiesce 开始后旧 active row 不得重新启动或下发投影');
  facade.resumeAfterFactoryReset();
}

// 新进程后的正常 startup 只恢复未过期业务真值；到期 row 先提交 expired，
// native 只收到空投影并保持停止。
{
  const database = createSoftAppLockDatabase();
  const repository = createRepository(database);
  insertLock(database, createSoftAppLock({
    id: 'soft-lock-process-expired',
    targetPackage: 'com.example.expired-after-process-loss',
    source: 'manual_test',
    createdAtEpochMs: NOW_MS,
    expiresAtEpochMs: LATER_MS,
  }));
  const { port, calls } = createTestPort(database);
  const facade = new DeviceControlFacade({
    repository,
    port,
    generateId: () => 'unused',
    nowEpochMs: () => LATER_MS + 1,
  });

  const startup = await facade.reconcileDeviceControl();

  assert.deepEqual(startup.active, []);
  assert.deepEqual(calls.map(({ method }) => method), ['reconcile', 'stop']);
  assert.deepEqual(calls[0].projection, []);
  assert.equal((await readLock(database, 'soft-lock-process-expired')).status, 'expired');
}

// Host factory reset 不调用 SoftAppLock 专属 DELETE；既有 clearDB 的动态表清理
// 会把 active lock 业务真值与其他应用表放在同一事务中清空。
{
  const database = createSoftAppLockDatabase();
  database.exec(`
    CREATE TABLE reset_sequence_owner (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
    INSERT INTO reset_sequence_owner DEFAULT VALUES;
    INSERT INTO raven_cat_soft_app_locks (
      id, target_package, source, source_ai_id, reason, created_at, expires_at, status
    ) VALUES (
      'soft-lock-clear-db', 'com.example.clear-db', 'manual_test', NULL, NULL,
      ${NOW_MS}, NULL, 'active'
    );
  `);
  const executor = createCoordinatorBackedExecutor(database);
  const helpersModule = loadTypeScriptModuleWithMocks(
    'src/platform/persistence/helpers.ts',
    {
      './sqlite/connection': {
        closeDB: async () => undefined,
        getActiveDbName: () => 'test.db',
      },
      'expo-sqlite': {},
      // helpers.ts 定位/清理 SQLite 目录时依赖 expo-file-system/legacy。
      'expo-file-system/legacy': {
        documentDirectory: 'file:///test/',
        deleteAsync: async () => undefined,
      },
      './runtime': {
        databaseCoordinator: { openTaskExecutor: () => executor },
      },
      './sqlite/initialization': {
        invalidateDatabaseInitialization: () => undefined,
      },
    },
  );

  await helpersModule.clearDB();

  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM raven_cat_soft_app_locks').get().count,
    0,
    'clearDB 必须动态清空 active Soft Lock rows',
  );
}

console.log('RavenCat Soft Lock 业务真值、application lifecycle 与恢复行为检查通过。');
