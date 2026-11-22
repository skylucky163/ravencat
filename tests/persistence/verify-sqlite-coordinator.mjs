import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


const schedulerPath = path.join(ROOT, 'src/platform/persistence/runtime/DatabaseTaskScheduler.ts');
const schedulerSource = fs.readFileSync(schedulerPath, 'utf8');
const transpiled = ts.transpileModule(schedulerSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { DatabaseTaskScheduler } = await import(moduleUrl);

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

const readScheduler = new DatabaseTaskScheduler({ maxConcurrentReads: 2 });
let activeReads = 0;
let maximumReads = 0;
const readGates = [deferred(), deferred(), deferred()];
const reads = readGates.map((gate, index) => readScheduler.scheduleRead(
  { name: `read-${index}`, feature: 'test', priority: 'interactive' },
  async () => {
    activeReads += 1;
    maximumReads = Math.max(maximumReads, activeReads);
    await gate.promise;
    activeReads -= 1;
  },
));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(activeReads, 2, '读取并发必须达到但不超过配置上限');
assert.equal(maximumReads, 2, '读取并发上限失效');
readGates[0].resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(activeReads, 2, '读取槽位释放后必须继续调度等待读取');
readGates[1].resolve();
readGates[2].resolve();
await Promise.all(reads);

let now = 0;
const fairScheduler = new DatabaseTaskScheduler({ agingIntervalMs: 5_000, now: () => now });
const blocker = deferred();
const order = [];
const active = fairScheduler.scheduleWrite(
  { name: 'blocker', feature: 'test', priority: 'interactive' },
  () => blocker.promise,
);
const maintenance = fairScheduler.scheduleWrite(
  { name: 'maintenance', feature: 'test', priority: 'maintenance' },
  async () => { order.push('maintenance'); },
);
now = 30_000;
const interactive = fairScheduler.scheduleWrite(
  { name: 'interactive', feature: 'test', priority: 'interactive' },
  async () => { order.push('interactive'); },
);
blocker.resolve();
await Promise.all([active, maintenance, interactive]);
assert.deepEqual(order, ['maintenance', 'interactive'], '等待时长提升必须防止维护任务饿死');

const barrierScheduler = new DatabaseTaskScheduler();
const barrierBlocker = deferred();
const barrierOrder = [];
const barrierActive = barrierScheduler.scheduleWrite(
  { name: 'active', feature: 'test', priority: 'interactive' },
  () => barrierBlocker.promise,
);
const beforeBarrier = barrierScheduler.scheduleWrite(
  { name: 'before', feature: 'test', priority: 'maintenance' },
  async () => { barrierOrder.push('before'); },
);
const barrier = barrierScheduler.scheduleBarrier(
  { name: 'barrier', feature: 'test', priority: 'maintenance' },
  async () => { barrierOrder.push('barrier'); },
);
const afterBarrier = barrierScheduler.scheduleWrite(
  { name: 'after', feature: 'test', priority: 'bootstrap' },
  async () => { barrierOrder.push('after'); },
);
barrierBlocker.resolve();
await Promise.all([barrierActive, beforeBarrier, barrier, afterBarrier]);
assert.deepEqual(barrierOrder, ['before', 'barrier', 'after'], 'barrier 必须隔开此前与此后的任务');

const failureScheduler = new DatabaseTaskScheduler();
await assert.rejects(failureScheduler.scheduleWrite(
  { name: 'failed', feature: 'test', priority: 'interactive' },
  async () => { throw new Error('injected'); },
));
await failureScheduler.scheduleWrite(
  { name: 'after-failure', feature: 'test', priority: 'interactive' },
  async () => undefined,
);

const coordinatorSource = fs.readFileSync(
  path.join(ROOT, 'src/platform/persistence/runtime/DatabaseCoordinator.ts'),
  'utf8',
);

// ============================================================================
// 独占写作用域：行为测试（桩掉连接与诊断依赖，直接驱动真实协调器与调度器）
// ============================================================================
const stubbedCoordinatorSource = coordinatorSource
  .replace(
    /import \* as SQLite from 'expo-sqlite';/,
    'const SQLite = globalThis.__TEST_SQLITE__;',
  )
  .replace(
    /import \{ getDB \} from '\.\.\/sqlite\/connection';/,
    `const getDB = async () => (
      globalThis.__TEST_GET_DB__
        ? globalThis.__TEST_GET_DB__()
        : globalThis.__TEST_FAKE_DB__
    );`,
  )
  .replace(
    /import \{ CoordinatedDatabaseError, classifyDatabaseError \} from '\.\/DatabaseErrors';/,
    `class CoordinatedDatabaseError extends Error {
  constructor(_kind, meta, cause) {
    super(meta.name + ': ' + (cause instanceof Error ? cause.message : String(cause)));
    this.cause = cause;
  }
}
const classifyDatabaseError = () => 'unknown';`,
  )
  .replace(
    /import \{ emitDatabaseDiagnostic \} from '\.\/DatabaseDiagnostics';/,
    'const emitDatabaseDiagnostic = (event) => globalThis.__TEST_DB_DIAGNOSTICS__?.push(event);',
  )
  .replace(
    /import \{ DatabaseTaskScheduler \} from '\.\/DatabaseTaskScheduler';/,
    `import { DatabaseTaskScheduler } from '${moduleUrl}';`,
  );
const coordinatorModuleUrl = `data:text/javascript;base64,${Buffer.from(
  ts.transpileModule(stubbedCoordinatorSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText,
).toString('base64')}`;
globalThis.__DEV__ = true;
const { DatabaseCoordinator } = await import(coordinatorModuleUrl);

function createFakeDatabase() {
  const calls = [];
  const db = {
    getFirstAsync: async (source) => {
      calls.push(`read:${source}`);
      return null;
    },
    getAllAsync: async (source) => {
      calls.push(`read-all:${source}`);
      return [];
    },
    runAsync: async (source) => {
      calls.push(`write:${source}`);
      return { changes: 1, lastInsertRowId: 1 };
    },
    execAsync: async (source) => {
      calls.push(`exec:${source}`);
    },
  };
  return { db, calls };
}

// 测试：独占写作用域开始并被 gate 暂停时，排队中的 interactive write 与 read 均不得开始
{
  const fake = createFakeDatabase();
  globalThis.__TEST_FAKE_DB__ = fake.db;
  const coordinator = new DatabaseCoordinator();
  const executor = coordinator.openTaskExecutor({
    name: 'test-exclusive-scope',
    feature: 'test',
    priority: 'interactive',
  });

  const gate = deferred();
  const order = [];
  const scope = executor.withExclusiveWriteScopeAsync(async (database) => {
    order.push('scope-start');
    assert.equal(database, fake.db, '独占写作用域必须把同一个底层数据库执行器交给 callback');
    await database.execAsync('scope-sql');
    await gate.promise;
    order.push('scope-finish');
    return 'scope-result';
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['scope-start'], '独占写作用域必须先开始并被 gate 暂停');

  const pendingWrite = executor.runAsync('queued-write').then(() => {
    order.push('write');
    return 'write-result';
  });
  const pendingRead = executor.getFirstAsync('queued-read').then(() => {
    order.push('read');
    return null;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.calls, ['exec:scope-sql'], '独占作用域期间排队的 read/write 均不得开始');

  gate.resolve();
  assert.equal(await scope, 'scope-result', '独占写作用域返回值必须透传');
  assert.equal(await pendingWrite, 'write-result');
  assert.equal(await pendingRead, null);
  assert.deepEqual(
    order,
    ['scope-start', 'scope-finish', 'write', 'read'],
    '释放独占作用域后其他任务必须之后按序执行',
  );
  assert.deepEqual(
    fake.calls,
    ['exec:scope-sql', 'write:queued-write', 'read:queued-read'],
    '独占作用域内的 SQL 必须先于排队任务落地',
  );
}

// 测试：独占写作用域不自动 BEGIN，底层执行器直接可用
{
  const fake = createFakeDatabase();
  globalThis.__TEST_FAKE_DB__ = fake.db;
  const coordinator = new DatabaseCoordinator();
  const executor = coordinator.openTaskExecutor({
    name: 'test-exclusive-scope-no-begin',
    feature: 'test',
    priority: 'interactive',
  });

  const result = await executor.withExclusiveWriteScopeAsync(async (database) => {
    await database.execAsync('PRAGMA foreign_keys = OFF;');
    await database.execAsync('CREATE TABLE t (id INTEGER PRIMARY KEY);');
    return 'done';
  });
  assert.equal(result, 'done', '独占写作用域必须透传 callback 返回值');
  assert.deepEqual(
    fake.calls,
    ['exec:PRAGMA foreign_keys = OFF;', 'exec:CREATE TABLE t (id INTEGER PRIMARY KEY);'],
    '独占写作用域不得自动调用 BEGIN，必须逐条直通底层执行器',
  );
}

// 测试：事务返回值必须透传
{
  const fake = createFakeDatabase();
  globalThis.__TEST_FAKE_DB__ = fake.db;
  const coordinator = new DatabaseCoordinator();
  const executor = coordinator.openTaskExecutor({
    name: 'test-transaction',
    feature: 'test',
    priority: 'interactive',
  });

  const result = await executor.withExclusiveTransactionAsync(async (tx) => {
    assert.equal(tx, fake.db, '事务必须使用同一个底层执行器');
    await tx.runAsync('tx-sql');
    return 42;
  });
  assert.equal(result, 42, '事务返回值必须透传');
}

// 真实 SQLite 验证事务外键契约：非法引用回滚、父记录删除级联、失败后可继续提交。
{
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE parents (id TEXT PRIMARY KEY);
    CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE CASCADE);
    INSERT INTO parents VALUES ('live');
    INSERT INTO children VALUES ('child', 'live');`);
  const executor = {
    execAsync: async (sql) => sqlite.exec(sql),
    runAsync: async (sql, params = []) => sqlite.prepare(sql).run(...params),
    getFirstAsync: async (sql, params = []) => sqlite.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => sqlite.prepare(sql).all(...params),
  };
  globalThis.__TEST_FAKE_DB__ = executor;
  const coordinator = new DatabaseCoordinator();
  const meta = { name: 'test-transaction-integrity', feature: 'test', priority: 'interactive' };
  try {
    await assert.rejects(() => coordinator.transaction(meta, async (tx) => {
      await tx.runAsync("INSERT INTO parents VALUES ('rolled-back')");
      await tx.runAsync("INSERT INTO children VALUES ('invalid', 'missing')");
    }), /FOREIGN KEY/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM parents WHERE id = 'rolled-back'").get().n, 0);
    const gate = deferred();
    const deletion = coordinator.transaction(meta, async (tx) => {
      await tx.runAsync("DELETE FROM parents WHERE id = 'live'");
      await gate.promise;
      return 'deleted';
    });
    await new Promise((resolve) => setImmediate(resolve));
    let readCompleted = false;
    const pendingRead = coordinator.read(meta, async (db) => {
      readCompleted = true;
      return db.getAllAsync('SELECT * FROM children');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readCompleted, false, '读取不能穿入未提交事务');
    gate.resolve();
    assert.equal(await deletion, 'deleted');
    assert.deepEqual(await pendingRead, [], '删除父记录必须级联清理子记录');
    await assert.rejects(() => coordinator.transaction(meta, async (tx) => {
      await tx.runAsync("INSERT INTO parents VALUES ('aborted')");
      throw new Error('业务提交失败');
    }), /业务提交失败/);
    assert.deepEqual(sqlite.prepare('SELECT * FROM parents').all(), []);
    await coordinator.transaction(meta, (tx) => tx.runAsync("INSERT INTO parents VALUES ('next')"));
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parents').get().n, 1);
  } finally {
    sqlite.close();
  }
}

// 测试：诊断事件必须能区分排队等待与真正执行耗时
{
  const fake = createFakeDatabase();
  globalThis.__TEST_FAKE_DB__ = fake.db;
  globalThis.__TEST_DB_DIAGNOSTICS__ = [];

  const originalDateNow = Date.now;
  let diagnosticNow = 1_000;
  Date.now = () => diagnosticNow;
  try {
    const coordinator = new DatabaseCoordinator();
    const blockerExecutor = coordinator.openTaskExecutor({
      name: 'diagnostic-blocker',
      feature: 'test',
      priority: 'maintenance',
    });
    const waitingExecutor = coordinator.openTaskExecutor({
      name: 'diagnostic-waiter',
      feature: 'test',
      priority: 'interactive',
    });
    const gate = deferred();

    const blockerTask = blockerExecutor.withExclusiveWriteScopeAsync(async () => {
      await gate.promise;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const waitingTask = waitingExecutor.getFirstAsync('queued-read');
    await new Promise((resolve) => setImmediate(resolve));

    diagnosticNow = 1_150;
    gate.resolve();
    await Promise.all([blockerTask, waitingTask]);

    const waiterEvents = globalThis.__TEST_DB_DIAGNOSTICS__.filter(
      (event) => event.operation === 'diagnostic-waiter',
    );
    assert.equal(waiterEvents.length, 3, '排队、开始和终态诊断必须可以用同一任务身份关联');
    assert.ok(waiterEvents[0].taskId, '诊断事件必须携带任务身份');
    assert.ok(waiterEvents.every((event) => event.taskId === waiterEvents[0].taskId));

    const terminal = waiterEvents.find((event) => event.outcome === 'completed');
    assert.equal(terminal?.queueWaitMs, 150, '必须单独记录被独占写任务阻塞的排队耗时');
    assert.equal(terminal?.durationMs, 0, '任务自身执行耗时不得混入排队等待');
    assert.equal(terminal?.connectionAcquireMs, 0, '连接获取耗时不得混入排队等待');
    assert.equal(terminal?.operationDurationMs, 0, '真实操作耗时不得混入排队等待');
    assert.equal(terminal?.continuationDelayMs, 0, '排队等待不得混入 continuation 延迟');
  } finally {
    Date.now = originalDateNow;
    delete globalThis.__TEST_DB_DIAGNOSTICS__;
  }
}

// 测试：必须能把总耗时拆成“取连接”与“真实 SQLite 操作”，用于定位到底慢在哪一段
{
  const fake = createFakeDatabase();
  const originalDateNow = Date.now;
  let diagnosticNow = 5_000;
  Date.now = () => diagnosticNow;
  try {
    const connectionGate = deferred();
    const operationGate = deferred();
    globalThis.__TEST_DB_DIAGNOSTICS__ = [];
    globalThis.__TEST_GET_DB__ = () => connectionGate.promise;
    globalThis.__TEST_FAKE_DB__ = {
      ...fake.db,
      getFirstAsync: async (source) => {
        await operationGate.promise;
        fake.calls.push(`read:${source}`);
        return null;
      },
    };

    const coordinator = new DatabaseCoordinator();
    const executor = coordinator.openTaskExecutor({
      name: 'timing-probe',
      feature: 'test',
      priority: 'interactive',
    });

    const probe = executor.getFirstAsync('probe-sql');
    await new Promise((resolve) => setImmediate(resolve));
    diagnosticNow = 5_120;
    connectionGate.resolve(globalThis.__TEST_FAKE_DB__);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.calls, [], '连接尚未返回前不得执行任何 SQL');
    diagnosticNow = 5_170;
    operationGate.resolve();
    assert.equal(await probe, null);

    const terminal = globalThis.__TEST_DB_DIAGNOSTICS__.find(
      (event) => event.operation === 'timing-probe' && event.outcome === 'completed',
    );
    assert.equal(terminal?.queueWaitMs, 0, '未被排队时排队耗时必须为 0');
    assert.equal(terminal?.connectionAcquireMs, 120, '必须单独记录 getDB 耗时');
    assert.equal(terminal?.operationDurationMs, 50, '必须单独记录真实操作耗时');
    assert.equal(terminal?.durationMs, 170, '总耗时必须等于连接获取 + 操作 + 调度间隙');
    assert.equal(terminal?.continuationDelayMs, 0, '各阶段完全覆盖时 continuation 延迟必须为 0');
    assert.deepEqual(
      fake.calls,
      ['read:probe-sql'],
      '计时不得改变实际 SQL 执行次数',
    );
  } finally {
    Date.now = originalDateNow;
    delete globalThis.__TEST_DB_DIAGNOSTICS__;
    delete globalThis.__TEST_GET_DB__;
  }
}

// 测试：barrier 不访问连接，不得伪造连接/操作耗时
{
  const fake = createFakeDatabase();
  globalThis.__TEST_FAKE_DB__ = fake.db;
  globalThis.__TEST_DB_DIAGNOSTICS__ = [];
  const coordinator = new DatabaseCoordinator();
  await coordinator.barrier({ name: 'barrier-probe', feature: 'test', priority: 'maintenance' });

  const terminal = globalThis.__TEST_DB_DIAGNOSTICS__.find(
    (event) => event.operation === 'barrier-probe' && event.outcome === 'completed',
  );
  assert.ok(terminal, 'barrier 必须产生终态诊断');
  assert.equal(terminal.connectionAcquireMs, undefined, 'barrier 不得伪造连接获取耗时');
  assert.equal(terminal.operationDurationMs, undefined, 'barrier 不得伪造操作耗时');
  assert.equal(terminal.continuationDelayMs, undefined, 'barrier 不得伪造 continuation 延迟');
  delete globalThis.__TEST_DB_DIAGNOSTICS__;
}

delete globalThis.__TEST_FAKE_DB__;

// production 不采集拆分计时，避免给正常数据库路径增加额外墙钟采样。
{
  globalThis.__DEV__ = false;
  const fake = createFakeDatabase();
  globalThis.__TEST_FAKE_DB__ = fake.db;
  globalThis.__TEST_DB_DIAGNOSTICS__ = [];
  const coordinator = new DatabaseCoordinator();
  const executor = coordinator.openTaskExecutor({
    name: 'production-timing-probe',
    feature: 'test',
    priority: 'interactive',
  });
  await executor.getFirstAsync('probe-sql');
  const terminal = globalThis.__TEST_DB_DIAGNOSTICS__.find(
    (event) => event.operation === 'production-timing-probe' && event.outcome === 'completed',
  );
  assert.equal(terminal.connectionAcquireMs, undefined);
  assert.equal(terminal.operationDurationMs, undefined);
  assert.equal(terminal.continuationDelayMs, undefined);
  globalThis.__DEV__ = true;
  delete globalThis.__TEST_DB_DIAGNOSTICS__;
  delete globalThis.__TEST_FAKE_DB__;
}

// 开发日志把同一拥堵波次的慢任务合并为一条摘要。
{
  const diagnosticsSource = fs.readFileSync(
    path.join(ROOT, 'src/platform/persistence/runtime/DatabaseDiagnostics.ts'),
    'utf8',
  );
  const diagnosticsModuleUrl = `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(diagnosticsSource, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString('base64')}`;

  const originalWarn = console.warn;
  const originalSetTimeout = globalThis.setTimeout;
  const warnings = [];
  let flushBatch = null;
  globalThis.__DEV__ = true;
  console.warn = (...args) => warnings.push(args);
  globalThis.setTimeout = (callback) => {
    flushBatch = callback;
    return 1;
  };
  try {
    const { emitDatabaseDiagnostic } = await import(diagnosticsModuleUrl);
    const base = {
      priority: 'interactive',
      queuedAt: '2026-08-13T00:00:00.000Z',
      startedAt: '2026-08-13T00:00:00.150Z',
      completedAt: '2026-08-13T00:00:00.160Z',
      outcome: 'completed',
    };
    emitDatabaseDiagnostic({
      ...base,
      taskId: 'source',
      operation: 'assistants.getAll',
      feature: 'assistants',
      kind: 'read',
      queueWaitMs: 0,
      durationMs: 168,
      connectionAcquireMs: 8,
      operationDurationMs: 160,
      continuationDelayMs: 0,
    });
    emitDatabaseDiagnostic({
      ...base,
      taskId: 'waiter-1',
      operation: 'companion.ensureDefault',
      feature: 'companion',
      kind: 'write',
      queueWaitMs: 169,
      durationMs: 2,
      connectionAcquireMs: 2,
      operationDurationMs: 1,
      continuationDelayMs: 166,
    });
    emitDatabaseDiagnostic({
      ...base,
      taskId: 'waiter-2',
      operation: 'companion.ensureDefault',
      feature: 'companion',
      kind: 'write',
      queueWaitMs: 179,
      durationMs: 3,
      connectionAcquireMs: 3,
      operationDurationMs: 2,
      continuationDelayMs: 174,
    });

    assert.equal(warnings.length, 0, '聚合窗口内不得逐条刷屏');
    assert.equal(typeof flushBatch, 'function', '首个慢任务必须启动一次聚合刷新');
    flushBatch();

    assert.equal(warnings.length, 1, '同一波次必须只输出一条摘要');
    assert.equal(warnings[0][0], '[SQLiteCoordinator][SlowBatch]');
    assert.equal(warnings[0][1].taskCount, 3);
    assert.equal(warnings[0][1].operationCount, 2);
    assert.equal(warnings[0][1].maxDurationMs, 168);
    assert.equal(warnings[0][1].maxQueueWaitMs, 179);
    assert.equal(warnings[0][1].maxConnectionAcquireMs, 8);
    assert.equal(warnings[0][1].maxOperationDurationMs, 160);
    assert.equal(warnings[0][1].maxContinuationDelayMs, 174);
    const slowest = warnings[0][1].operations.find((item) => item.operation === 'assistants.getAll');
    assert.equal(slowest.maxConnectionAcquireMs, 8, '摘要必须保留连接获取耗时');
    assert.equal(slowest.maxOperationDurationMs, 160, '摘要必须保留真实操作耗时');
    assert.equal(slowest.maxContinuationDelayMs, 0, '摘要必须保留 continuation 延迟');
    assert.equal(
      warnings[0][1].operations.find((item) => item.operation === 'companion.ensureDefault').count,
      2,
      '相同操作必须合并计数',
    );
    assert.equal(
      warnings[0][1].operations.find((item) => item.operation === 'companion.ensureDefault')
        .maxConnectionAcquireMs,
      3,
      '同组任务必须按最大值聚合连接获取耗时',
    );
    assert.equal(
      warnings[0][1].operations.find((item) => item.operation === 'companion.ensureDefault')
        .maxOperationDurationMs,
      2,
      '同组任务必须按最大值聚合真实操作耗时',
    );
    assert.equal(
      warnings[0][1].operations.find((item) => item.operation === 'companion.ensureDefault')
        .maxContinuationDelayMs,
      174,
      '同组任务必须按最大值聚合 continuation 延迟',
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    console.warn = originalWarn;
    delete globalThis.__DEV__;
  }
}

// 数据库初始化在同一 JS runtime 内只能成功执行一次。
{
  const initializationSource = fs.readFileSync(
    path.join(ROOT, 'src/platform/persistence/sqlite/initialization.ts'),
    'utf8',
  )
    .replace(
      /import \{ databaseCoordinator \} from '\.\.\/runtime';/,
      'const databaseCoordinator = globalThis.__TEST_INITIALIZATION_COORDINATOR__;',
    )
    .replace(
      /import \{ closeDBForRestoreRollback \} from '\.\/connection';/,
      'const closeDBForRestoreRollback = async () => undefined;',
    )
    .replace(
      /import \{ SCHEMAS, INDEXES \} from '\.\/schema';/,
      `const SCHEMAS = { core: 'CREATE CORE' };
const INDEXES = { core: 'CREATE INDEX' };`,
    )
    .replace(
      /import \{ runMigrations \} from '\.\/migrations';/,
      'const runMigrations = async () => { globalThis.__TEST_MIGRATION_RUNS__ += 1; };',
    );
  let bootstrapScopes = 0;
  globalThis.__TEST_MIGRATION_RUNS__ = 0;
  globalThis.__TEST_INITIALIZATION_COORDINATOR__ = {
    openTaskExecutor: () => ({
      withExclusiveWriteScopeAsync: async (task) => {
        bootstrapScopes += 1;
        return task({ execAsync: async () => undefined });
      },
    }),
  };

  const initializationModuleUrl = `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(initializationSource, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString('base64')}`;
  const { initDatabase } = await import(initializationModuleUrl);

  await Promise.all([initDatabase(), initDatabase()]);
  await initDatabase();
  assert.equal(bootstrapScopes, 1, '并发和后续调用必须共用同一次 bootstrap');
  assert.equal(globalThis.__TEST_MIGRATION_RUNS__, 1, '成功后不得重复执行迁移');

  delete globalThis.__TEST_INITIALIZATION_COORDINATOR__;
  delete globalThis.__TEST_MIGRATION_RUNS__;
}

console.log('SQLite coordinator 验证通过：调度、公平性、barrier、独占写作用域、事务与耗时诊断符合契约。');
