/** 在隔离 SQLite 中验证 V3 产品行为与事务，不锁定源码写法。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { createCoordinatedSqliteFixture, databaseErrors } from './helpers/coordinated-sqlite-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRequire = createRequire(import.meta.url);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimiphone-memory-v3-'));
const databasePath = path.join(directory, 'memory.db');
const backupPath = path.join(directory, 'backup.db');
let database = new DatabaseSync(databasePath);
database.exec('PRAGMA foreign_keys = ON');
let chain = Promise.resolve();
const raw = {
  async execAsync(sql) { database.exec(sql); },
  async runAsync(sql, params = []) { const result = database.prepare(sql).run(...params); return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) }; },
  async getFirstAsync(sql, params = []) { return database.prepare(sql).get(...params) ?? null; },
  async getAllAsync(sql, params = []) { return database.prepare(sql).all(...params); },
};
function scheduled(operation) {
  const result = chain.then(operation);
  chain = result.catch(() => {});
  return result;
}
const executor = {
  execAsync: (...args) => scheduled(() => raw.execAsync(...args)),
  runAsync: (...args) => scheduled(() => raw.runAsync(...args)),
  getFirstAsync: (...args) => scheduled(() => raw.getFirstAsync(...args)),
  getAllAsync: (...args) => scheduled(() => raw.getAllAsync(...args)),
  withExclusiveWriteScopeAsync: (operation) => scheduled(() => operation(raw)),
  withExclusiveTransactionAsync: (operation) => scheduled(async () => {
    database.exec('BEGIN');
    try { const result = await operation(raw); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }),
};
const coordinator = { openTaskExecutor: () => executor, transaction: (_meta, operation) => executor.withExclusiveTransactionAsync(operation) };
const cache = new Map();
function load(relative, dependencies = {}) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const requireLocal = (specifier) => {
    if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
    if (specifier === './HttpExchangeCapture') return { beginAIHttpCapture: async () => null };
    if (specifier === '@platform/persistence') return { databaseCoordinator: coordinator, ...databaseErrors };
    if (specifier === 'expo-file-system/legacy') return {};
    if (filename === path.join(root, 'src/platform/persistence/helpers.ts') && specifier === './runtime'
      || filename === path.join(root, 'src/platform/persistence/sqlite/initialization.ts') && specifier === '../runtime') {
      return { databaseCoordinator: coordinator };
    }
    if (filename === path.join(root, 'src/platform/persistence/helpers.ts') && specifier === './sqlite/connection'
      || filename === path.join(root, 'src/platform/persistence/sqlite/initialization.ts') && specifier === './connection') {
      return { closeDB: async () => {}, closeDBForRestoreRollback: async () => {}, getActiveDbName: () => 'memory.db' };
    }
    if (specifier === '@shared') return { SELF_USER_ID: 'self' };
    if (specifier === 'expo-crypto') return { randomUUID };
    if (specifier === '@features/protocol') return load('src/features/protocol/infrastructure/SQLiteProtocolRepository.ts');
    if (specifier === '@features/memory/composition') return {
      ...runtime, ...commands, memoryEntryRepository: repository, ...load('src/features/memory/application/MemorySignals.ts'),
    };
    let location;
    if (specifier.startsWith('.')) location = path.resolve(path.dirname(filename), specifier);
    else if (specifier.startsWith('@shared/')) location = path.join(root, 'src/shared', specifier.slice(8));
    else return nativeRequire(specifier);
    for (const suffix of ['.ts', '.tsx', '/index.ts']) if (fs.existsSync(location + suffix)) return load(location + suffix);
    throw new Error('无法加载测试依赖：' + specifier);
  };
  new Function('require', 'module', 'exports', compiled)(requireLocal, module, module.exports);
  return module.exports;
}
const { runMigrations } = load('src/platform/persistence/sqlite/migrations.ts');
const { migrateMemoryV3, migrateMemorySummary, migrateMemoryTriggerGroups, migrateMemoryEmbeddingVectorSnapshot } = load('src/platform/persistence/sqlite/memoryV3Schema.ts');
const domain = load('src/features/memory/domain/Memory.ts');
const { memoryEntryRepository: repository } = load('src/features/memory/infrastructure/SQLiteMemoryEntryRepository.ts');
const runtime = load('src/features/memory/application/MemoryRuntimeDependencies.ts');
const commands = load('src/features/memory/application/MemoryCommands.ts');
const embeddingModels = load('src/features/memory/application/MemoryEmbeddingModels.ts');
const recall = load('src/features/memory/application/RecallMemory.ts');
const worker = load('src/features/memory/application/MemoryEmbeddingWorker.ts');
const { SQLiteChatSummaryRepository } = load('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts');
const summaryRuntime = load('src/features/chat/summary/application/ChatSummaryRuntime.ts');
const summaryApplication = load('src/features/chat/summary/application/ChatSummary.ts');
const { callRepository: calls } = load('src/features/calls/infrastructure/SQLiteCallRepository.ts');
const summary = new SQLiteChatSummaryRepository((tx, conversationId, boundary) => calls.readSummarySources(tx, {
  chatSessionId: conversationId, excludedCallIds: boundary.processedCallIds, after: boundary.historyStartsAfter,
}));
const timelineDomain = load('src/features/chat/summary/domain/ChatSummaryTimeline.ts');
const appendSummary = (claim, id, content, at) => summary.appendClaim(claim, [{ id, content, messages: claim.messages }], at);
const withoutTasks = ({tasks,...content}) => content;
const retryPending = async (conversationId, level) => {
  const task=(await summary.readContext(conversationId,[])).tasks.find(value=>value.level===level && !['completed','cancelled'].includes(value.status));
  await summary.retryTask(conversationId,task.id,new Date().toISOString());
};
const buildSummaryInput = (claim) => summaryApplication.buildChatSummaryModelInput({
  ...claim,
});
const { timelineOrderedMessagesCte, timelineProjectionOrderBy } = load('src/features/chat/messages/infrastructure/ChatTimelineSql.ts');
const now = '2026-10-04T04:00:00.000Z';
const later = '2026-10-04T05:00:00.000Z';
const modelA = { id: 'model-a', name: '向量 A', fingerprint: 'model-a:r1', baseURL: 'https://example.invalid', apiKey: 'test', model: 'a', metadataJson: null };
const modelB = { ...modelA, fingerprint: 'model-a:r2', name: '向量 B' };
let currentModel = null;
let embedding = async () => [1, 0];
runtime.configureMemoryRuntimeDependencies({
  repository, listMemorySpaces: async () => [],
  resolveMemorySpace: async (id) => ({ poolId: id === 'a' ? 'pool-a' : 'pool-b', assistantId: id }),
  resolveEmbeddingModel: async () => currentModel,
  clearEmbeddings: async () => repository.clearEmbeddings(await runtime.getMemoryRuntimeDependencies().resolveEmbeddingModel()),
  setEmbeddingEnabled: enabled => repository.setEmbeddingEnabled(enabled),
  selectEmbeddingModel: id => repository.setEmbeddingModelId(id),
  embed: (...args) => embedding(...args),
  withEmbeddingMaintenance: (operation, signal) => operation(signal ?? new AbortController().signal),
});
async function bootstrap() {
  const log = console.log; const warn = console.warn;
  try {
    console.log = () => {}; console.warn = () => {};
    await runMigrations(raw);
  } finally { console.log = log; console.warn = warn; }
  assert.deepEqual(await raw.getAllAsync('PRAGMA foreign_key_check'), []);
}
async function create(id, content, time = now, poolId = 'pool-a', writeKey = null) {
  return repository.createEntry({ id, poolId, content, summary: null, normalizedContent: domain.normalizeMemoryText(content), now: time, writeKey });
}
const requestEntryEmbedding = async (poolId, memoryId) => repository.retryEmbedding(poolId, memoryId, await repository.getEmbeddingIndexRevision());
const syncMemoryModel = async model => repository.syncEmbeddingModel(model, await repository.getEmbeddingIndexRevision());
async function claim(id = randomUUID(), time = now) {
  return repository.claimEmbedding(currentModel.fingerprint, id, time, later, await repository.getEmbeddingIndexRevision());
}
function addMessage(id, content, role = 'user', timestamp = now, runId = null, index = null) {
  database.prepare(`INSERT INTO messages (id, session_id, text, is_me, sender_type, created_at, time, status, turn_run_id, turn_item_index)
    VALUES (?, 'conversation', ?, ?, ?, ?, ?, 'sent', ?, ?)`).run(id, content, role === 'user' ? 1 : 0, role, timestamp, timestamp, runId, index);
}
try {
  // 宿主只在交互空闲后启动一条任务；切换／清除先取消旧请求，后台停止调度。
  {
    const idleTasks = [];
    const listeners = new Set();
    const dialogs = [];
    const dialogStore = load('src/shared/ui/appDialogStore.ts');
    const signals = [];
    const changes = [];
    let finishRequest;
    const pendingRequest = new Promise(resolve => { finishRequest = resolve; });
    const emptyResult = { processed: false, nextWakeAt: null, failedMemoryId: null };
    let processEmbedding = () => signals.length === 1 ? pendingRequest : Promise.resolve(emptyResult);
    const queue = load('src/host/runtime/MemoryEmbeddingQueueCoordinator.ts', {
      'react-native': { InteractionManager: { runAfterInteractions(callback) {
        const task = { callback, cancelled: false, cancel() { this.cancelled = true; } };
        idleTasks.push(task); return task;
      } } },
      '@shared/ui/appDialogStore': { showAppDialog: value => { dialogs.push(value); dialogStore.showAppDialog(value); } },
      '@features/memory': { subscribeMemoryChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); } },
      '@features/memory/composition': {
        emitMemoryChanged: () => { for (const listener of listeners) listener(); },
        processNextMemoryEmbedding: signal => { signals.push(signal); return processEmbedding(signal); },
      },
    });
    const runIdleTask = () => {
      const index = idleTasks.findIndex(task => !task.cancelled);
      assert.notEqual(index, -1);
      idleTasks.splice(index, 1)[0].callback();
    };
    queue.configureMemoryEmbeddingQueue();
    queue.setMemoryEmbeddingForegroundActive(true);
    assert.equal(signals.length, 0, '进入前台不立即启动请求');
    await queue.updateMemoryEmbeddingModel(async () => { changes.push('选择模型'); });
    assert.equal(signals.length, 0, '选择模型不立即批量同步或重建');
    runIdleTask();
    assert.equal(signals.length, 1);
    queue.requestMemoryEmbeddingRun();
    assert.equal(idleTasks.filter(task => !task.cancelled).length, 0, '请求未结束时不并行启动第二条');
    const clear = queue.updateMemoryEmbeddingModel(async () => { changes.push('清除向量'); });
    assert.equal(signals[0].aborted, true);
    assert.deepEqual(changes, ['选择模型'], '清除等待旧任务结束');
    finishRequest(emptyResult);
    await clear;
    assert.deepEqual(changes, ['选择模型', '清除向量']);
    assert.equal(signals.length, 1, '清除后继续等待交互空闲');
    runIdleTask();
    assert.equal(signals.length, 2);
    await queue.stopMemoryEmbeddingQueueForReset();
    queue.requestMemoryEmbeddingRun();
    assert.equal(idleTasks.filter(task => !task.cancelled).length, 0, '离开前台后不继续派生任务');
    assert.deepEqual(dialogs, []);

    // 错误模型导致多条连续失败时，关闭一次即可退出提示，同轮后续失败不再打断。
    const flushIdleTask = async () => { runIdleTask(); await new Promise(setImmediate); };
    let failuresLeft = 20;
    processEmbedding = async () => failuresLeft-- > 0
      ? { processed: true, nextWakeAt: null, failedMemoryId: 'failed-' + failuresLeft }
      : emptyResult;
    queue.setMemoryEmbeddingForegroundActive(true);
    await flushIdleTask();
    assert.equal(dialogs.length, 1);
    const firstFailure = dialogStore.getAppDialogSnapshot();
    dialogStore.finishAppDialog(firstFailure, firstFailure.buttons[0]);
    for (let index = 0; index < 20; index++) await flushIdleTask();
    assert.equal(dialogs.length, 1, '关闭提示后，同一批剩余失败不能再次弹窗');
    assert.equal(dialogStore.getAppDialogSnapshot(), null, '一次关闭后没有重复提示积压');

    // 新一轮仍能报告失败；提示未关闭时，不因队列空闲、重新唤醒或模型刷新堆叠。
    failuresLeft = 1;
    queue.requestMemoryEmbeddingRun();
    await flushIdleTask();
    await flushIdleTask();
    assert.equal(dialogs.length, 2);
    for (let index = 0; index < 3; index++) {
      failuresLeft = 1;
      await queue.updateMemoryEmbeddingModel(async () => {});
      await flushIdleTask();
      await flushIdleTask();
    }
    assert.equal(dialogs.length, 2, '未关闭的失败提示只保留一份');
    dialogStore.finishAppDialog(dialogStore.getAppDialogSnapshot());
    assert.equal(dialogStore.getAppDialogSnapshot(), null, '返回键或遮罩关闭后也没有重复提示');
    failuresLeft = 1;
    queue.requestMemoryEmbeddingRun();
    await flushIdleTask();
    assert.equal(dialogs.length, 3, '提示关闭后，新一轮失败仍会通知');
    const lastFailure = dialogStore.getAppDialogSnapshot();
    dialogStore.finishAppDialog(lastFailure, lastFailure.buttons[0]);
    await flushIdleTask();
    let entered;
    const maintenanceStarted = new Promise(resolve => { entered = resolve; });
    let maintenanceSignal;
    const maintenance = queue.updateMemoryEmbeddingModel(async signal => {
      maintenanceSignal = signal; entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('维护已取消')), { once: true }));
    });
    await maintenanceStarted;
    const stopped = queue.stopMemoryEmbeddingQueueForReset();
    await assert.rejects(maintenance, /维护已取消/);
    await stopped;
    assert.equal(maintenanceSignal.aborted, true, '重置必须取消并等待整批重建，不只停止自动任务');
  }
  {
    const queue = load('src/host/runtime/StickerEmbeddingQueueCoordinator.ts', {
      'react-native': { InteractionManager: { runAfterInteractions: () => ({ cancel() {} }) } },
      '@features/assistants': { subscribeAuxiliaryModelsChanged: () => () => {} },
      '@features/stickers': { subscribeStickerEmbeddingPending: () => () => {} },
      '@features/stickers/composition': { syncStickerEmbeddingModel: async () => {} },
    });
    queue.configureStickerEmbeddingQueue();
    queue.setStickerEmbeddingForegroundActive(true);
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const maintenance = queue.updateStickerEmbeddingModel(async signal => {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('表情维护已取消')), { once: true }));
    });
    await started;
    const stopped = queue.stopStickerEmbeddingQueueForReset();
    await assert.rejects(maintenance, /表情维护已取消/);
    await stopped;
  }
  // 来源升级只接管可确认的旧就绪向量；不猜测旧失败任务留下的向量属于哪个版本。
  {
    const oldIndex = new DatabaseSync(':memory:');
    oldIndex.exec(`CREATE TABLE memory_item_embeddings(memory_id TEXT PRIMARY KEY, content_revision INTEGER,
      model_fingerprint TEXT, status TEXT, vector_json TEXT);
      INSERT INTO memory_item_embeddings VALUES ('ready', 1, 'old-model', 'ready', '[1,0]'),
        ('failed', 2, 'new-model', 'failed', '[1,0]'), ('stopped', 2, 'new-model', 'not_requested', '[1,0]');
      CREATE TRIGGER reject_sources BEFORE UPDATE ON memory_item_embeddings BEGIN SELECT RAISE(ABORT, '来源迁移失败'); END;`);
    const adapter = { execAsync: async sql => oldIndex.exec(sql), getAllAsync: async sql => oldIndex.prepare(sql).all() };
    oldIndex.exec('BEGIN');
    await assert.rejects(migrateMemoryEmbeddingVectorSnapshot(adapter), /来源迁移失败/);
    oldIndex.exec('ROLLBACK');
    assert.equal(oldIndex.prepare('PRAGMA table_info(memory_item_embeddings)').all().length, 5, '升级失败时新增列一并回滚');
    oldIndex.exec('DROP TRIGGER reject_sources; BEGIN');
    await migrateMemoryEmbeddingVectorSnapshot(adapter);
    oldIndex.exec('COMMIT');
    const sources = oldIndex.prepare('SELECT * FROM memory_item_embeddings ORDER BY memory_id').all();
    assert.equal(sources.find(row => row.memory_id === 'ready').vector_model_fingerprint, 'old-model');
    assert.equal(sources.find(row => row.memory_id === 'ready').vector_content_revision, 1);
    assert.ok(sources.filter(row => row.memory_id !== 'ready').every(row => row.vector_model_fingerprint === null && row.vector_content_revision === null));
    assert.ok(sources.every(row => row.vector_json === '[1,0]'), '来源不明的旧向量仍保留原数据');
    await migrateMemoryEmbeddingVectorSnapshot(adapter);
    assert.deepEqual(oldIndex.prepare('SELECT * FROM memory_item_embeddings ORDER BY memory_id').all(), sources);
    oldIndex.close();
  }

  // 从真实旧列结构升级，失败时列与版本一起回滚；旧向量无需重建。
  const legacyMemory = new DatabaseSync(':memory:');
  try {
    legacyMemory.exec(`CREATE TABLE memory_items (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, content TEXT NOT NULL,
      normalized_content TEXT NOT NULL, content_revision INTEGER NOT NULL, write_key TEXT,
      remembered_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO memory_items VALUES ('old', 'pool-a', '旧正文', '旧正文', 7, 'receipt', '1', '2', '3');
      CREATE TABLE memory_item_embeddings (memory_id TEXT, status TEXT, vector_json TEXT, content_revision INTEGER);
      INSERT INTO memory_item_embeddings VALUES ('old', 'ready', '[1,0]', 7); PRAGMA user_version = 106;`);
    const legacyExecutor = {
      execAsync: async (sql) => legacyMemory.exec(sql),
      getFirstAsync: async (sql) => legacyMemory.prepare(sql).get(),
      getAllAsync: async (sql) => legacyMemory.prepare(sql).all(),
    };
    const original = legacyMemory.prepare('SELECT * FROM memory_items').get();
    const originalVector = legacyMemory.prepare('SELECT * FROM memory_item_embeddings').get();
    await assert.rejects(migrateMemorySummary({ ...legacyExecutor, execAsync: async (sql) => {
      if (sql.includes('PRAGMA user_version = 107')) throw new Error('升级提交失败');
      return legacyExecutor.execAsync(sql);
    } }), /升级提交失败/);
    assert.deepEqual(legacyMemory.prepare('SELECT * FROM memory_items').get(), original);
    assert.equal(legacyMemory.prepare('PRAGMA user_version').get().user_version, 106);
    await migrateMemorySummary(legacyExecutor);
    const migrated = legacyMemory.prepare('SELECT * FROM memory_items').get();
    assert.deepEqual({ ...migrated }, { ...original, summary: null, normalized_summary: '' });
    assert.deepEqual(legacyMemory.prepare('SELECT * FROM memory_item_embeddings').get(), originalVector);
    await migrateMemorySummary(legacyExecutor);
    assert.deepEqual(legacyMemory.prepare('SELECT * FROM memory_items').get(), migrated);
    assert.equal(legacyMemory.prepare('PRAGMA user_version').get().user_version, 107);
  } finally { legacyMemory.close(); }
  // 已发布的词、手动关系和关闭事实原子迁成组；失败保留旧结构，不清理用户数据。
  const legacyTriggers = new DatabaseSync(':memory:');
  try {
    legacyTriggers.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE memory_pools (id TEXT PRIMARY KEY);
      CREATE TABLE memory_items (id TEXT PRIMARY KEY);
      CREATE TABLE memory_passive_triggers (id TEXT PRIMARY KEY, pool_id TEXT REFERENCES memory_pools(id), keyword TEXT, normalized_keyword TEXT, UNIQUE(pool_id, normalized_keyword));
      CREATE TABLE memory_passive_disabled (trigger_id TEXT REFERENCES memory_passive_triggers(id) ON DELETE CASCADE, memory_id TEXT REFERENCES memory_items(id) ON DELETE CASCADE, PRIMARY KEY(trigger_id,memory_id));
      CREATE TABLE memory_passive_associations (trigger_id TEXT REFERENCES memory_passive_triggers(id) ON DELETE CASCADE, memory_id TEXT REFERENCES memory_items(id) ON DELETE CASCADE, PRIMARY KEY(trigger_id,memory_id));
      INSERT INTO memory_pools VALUES ('pool'); INSERT INTO memory_items VALUES ('old');
      INSERT INTO memory_passive_triggers VALUES ('trigger', 'pool', 'ＡＢＣ', 'abc');
      INSERT INTO memory_passive_disabled VALUES ('trigger', 'old');
      INSERT INTO memory_passive_associations VALUES ('trigger', 'old');`);
    const legacyExecutor = { execAsync: async sql => legacyTriggers.exec(sql) };
    legacyTriggers.exec('BEGIN');
    await migrateMemoryTriggerGroups(legacyExecutor);
    legacyTriggers.exec('ROLLBACK');
    assert.equal(legacyTriggers.prepare('SELECT keyword FROM memory_passive_triggers').get().keyword, 'ＡＢＣ');
    assert.equal(legacyTriggers.prepare('SELECT COUNT(*) AS count FROM memory_passive_disabled').get().count, 1);
    legacyTriggers.exec('BEGIN');
    await migrateMemoryTriggerGroups(legacyExecutor);
    legacyTriggers.exec('COMMIT');
    assert.deepEqual({ ...legacyTriggers.prepare('SELECT * FROM memory_trigger_groups').get() }, { id: 'trigger', pool_id: 'pool', auto_associate: 1 });
    assert.equal(legacyTriggers.prepare('SELECT keyword FROM memory_trigger_keywords').get().keyword, 'ＡＢＣ');
    assert.equal(legacyTriggers.prepare('SELECT COUNT(*) AS count FROM memory_passive_associations').get().count, 1);
    assert.equal(legacyTriggers.prepare('SELECT COUNT(*) AS count FROM memory_passive_disabled').get().count, 1);
    assert.deepEqual(legacyTriggers.prepare('PRAGMA foreign_key_check').all(), []);
    legacyTriggers.exec("DELETE FROM memory_trigger_groups WHERE id = 'trigger'");
    for (const table of ['memory_trigger_keywords', 'memory_passive_associations', 'memory_passive_disabled']) {
      assert.equal(legacyTriggers.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
  } finally { legacyTriggers.close(); }
  await bootstrap();
  database.exec(`INSERT OR IGNORE INTO user_profile (id, name, updated_at) VALUES ('self', '枫渡', '${now}');
    INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES ('a', 'actor-a', 'A', 'chat', '${now}', '${now}'), ('b', 'actor-b', 'B', 'chat', '${now}', '${now}');
    INSERT INTO memory_pools (id, user_profile_id, ai_assistant_id, created_at, updated_at) VALUES ('pool-a', 'self', 'a', '${now}', '${now}'), ('pool-b', 'self', 'b', '${now}', '${now}');
    INSERT INTO chat_conversations (id, kind) VALUES ('conversation', 'direct');
    INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at) VALUES ('conversation', 'a', 'A', '${now}', '${now}');
    INSERT INTO conversation_turn_state (session_id, reply_cursor, revision, updated_at) VALUES ('conversation', 100, 0, '${now}');`);
  // 首页聚合保留每个空间的真实数量，超过视觉上限仍完整统计，增删后不缓存旧值。
  {
    const queries = load('src/features/memory/application/MemoryQueries.ts');
    const dependencies = runtime.getMemoryRuntimeDependencies();
    runtime.configureMemoryRuntimeDependencies({ ...dependencies, listMemorySpaces: async () => [
      { poolId: 'pool-a', assistantId: 'a', assistantName: 'A', assistantAvatar: null, isHost: true },
      { poolId: 'pool-b', assistantId: 'b', assistantName: 'B', assistantAvatar: null, isHost: false },
    ] });
    const counts = async () => (await queries.getMemoryManagementSnapshot('a')).spaces.map(space => space.memoryCount);
    assert.deepEqual(await counts(), [0, 0]);
    for (let i = 0; i < 12; i++) await create(`galaxy-${i}`, `星空计数 ${i}`);
    await create('galaxy-foreign', '另一个空间', now, 'pool-b');
    assert.deepEqual(await counts(), [12, 1]);
    await commands.forgetMemory('a', 'galaxy-0');
    assert.deepEqual(await counts(), [11, 1]);
    for (let i = 1; i < 12; i++) await commands.forgetMemory('a', `galaxy-${i}`);
    await commands.forgetMemory('b', 'galaxy-foreign');
    assert.deepEqual(await counts(), [0, 0]);
    let changes = 0;
    const unsubscribe = load('src/features/memory/application/MemorySignals.ts').subscribeMemoryChanged(() => { changes++; });
    await commands.selectMemorySpace('b');
    assert.equal((await queries.getMemoryManagementSnapshot()).selectedSpace.assistantId, 'b', '选择偏好仍然持久化');
    assert.equal(changes, 0, '选择空间不广播正文变化，不应唤醒向量任务');
    await commands.selectMemorySpace('a');
    unsubscribe();
    runtime.configureMemoryRuntimeDependencies(dependencies);
  }
  assert.equal(domain.requireMemoryContent('  ' + '猫'.repeat(500) + '  ').length, 500);
  assert.equal(Array.from(domain.requireMemoryContent('🐈'.repeat(500))).length, 500);
  assert.throws(() => domain.requireMemoryContent('猫'.repeat(501)), domain.MemoryInputError);
  assert.throws(() => domain.requireMemoryContent('   '), domain.MemoryInputError);
  assert.equal(domain.requireMemorySummary('  摘要  '), '摘要');
  assert.equal(domain.requireMemorySummary('  '), null);
  assert.equal(domain.requireMemorySummary('🐈'.repeat(50)), '🐈'.repeat(50));
  assert.throws(() => domain.requireMemorySummary('猫'.repeat(51)), domain.MemoryInputError);
  assert.equal(domain.countMemoryKeywordMatches({ content: 'ＡＢＣ 协议', summary: 'ABC' }, ['abc', '协议']), 2);
  assert.equal(domain.countMemoryKeywordMatches({ content: '正文', summary: '摘要' }, ['摘要\n正文']), 0);
  assert.equal(domain.normalizeMemoryText('ＡＢＣ'), 'abc');
  const saved = await commands.rememberMemory('a', '枫渡喜欢猫', 'run:tool');
  assert.equal(saved.embeddingStatus, 'not_requested', '未配置向量模型仍正常保存记忆');
  assert.equal((await commands.rememberMemory('a', '重复调用不能改正文', 'run:tool')).id, saved.id);
  await assert.rejects(commands.editMemory('b', saved.id, '越界'), domain.MemoryNotFoundError);
  assert.equal(await commands.forgetMemory('b', saved.id), false);
  assert.equal((await repository.getEntry('pool-a', saved.id)).content, '枫渡喜欢猫');
  await create('both', '猫与考试', later);
  await create('cat', '猫', now);
  await create('vector-only', '明天准备复习', later);
  await create('foreign', '猫与考试', later, 'pool-b');
  await commands.addMemoryTrigger('a', '猫', [], true);
  await commands.addMemoryTrigger('a', '考试', [], true);
  const triggers = await repository.listTriggers('pool-a');
  const catTrigger = triggers.find((item) => item.keywords[0].keyword === '猫');
  assert.equal(catTrigger.associatedCount, 3);
  await commands.setMemoryAutoRecall('a', catTrigger.id, 'both', false);
  assert.equal((await repository.recallPassive('pool-a', '猫')).some((item) => item.id === 'both'), false);
  assert.equal((await repository.recallPassive('pool-a', '考试')).some((item) => item.id === 'both'), true);
  assert.equal((await repository.recallPassive('pool-a', '无关键词')).length, 0);
  {
    const manual = await commands.rememberMemory('a', '难过时希望被抱抱');
    const comfortId = await commands.addMemoryTrigger('a', '安慰，低落、ＡＢＣ;abc；\n', [manual.id]);
    const comfort = (await repository.listTriggers('pool-a')).find(item => item.id === comfortId);
    assert.deepEqual(comfort.keywords.map(item => item.normalizedKeyword), ['安慰', '低落', 'abc'], '批量输入保存成一个组，组内按规范化去重');
    assert.equal(comfort.associatedCount, 1);
    assert.equal(comfort.enabledCount, 1);
    for (const input of ['安慰', '低落', 'abc']) {
      assert.deepEqual((await repository.recallPassive('pool-a', input)).map((item) => item.id), [manual.id]);
    }
    assert.equal((await repository.recallPassive('pool-a', '安慰低落abc')).length, 1, '多个词命中同一记忆只带入一次');
    await commands.editMemory('a', manual.id, '换成不包含任何触发词的正文', '独立摘要');
    assert.equal((await repository.listTriggerMemories('pool-a', comfort.id))[0].memory.content, '换成不包含任何触发词的正文');
    await commands.setMemoryAutoRecall('a', comfort.id, manual.id, false);
    assert.equal((await repository.recallPassive('pool-a', '安慰')).length, 0);
    assert.equal((await repository.recallPassive('pool-a', '低落')).length, 0, '关闭事实归组所有');
    await commands.setMemoryAutoRecall('a', comfort.id, manual.id, true);
    await assert.rejects(commands.setMemoryAutoRecall('b', comfort.id, 'foreign', true), domain.MemoryTriggerNotFoundError);
    await assert.rejects(commands.setMemoryAutoRecall('a', comfort.id, 'foreign', true), domain.MemoryNotFoundError);
    assert.equal((await repository.listTriggerMemories('pool-a', comfort.id)).length, 1, '手动关系不能跨空间');
    await assert.rejects(commands.addMemoryTrigger('b', '越界批量', [manual.id]), domain.MemoryNotFoundError);
    assert.equal((await repository.listTriggers('pool-b')).length, 0);
    await assert.rejects(commands.addMemoryTrigger('a', '，；\n', [manual.id]), domain.MemoryInputError);
    await assert.rejects(commands.addMemoryTrigger('a', '空关联', []), domain.MemoryInputError);
    database.exec(`CREATE TRIGGER reject_manual_link BEFORE INSERT ON memory_passive_associations
      WHEN NEW.memory_id = 'vector-only'
      BEGIN SELECT RAISE(ABORT, '绑定失败'); END;`);
    await assert.rejects(commands.addMemoryTrigger('a', '事务词一，事务词二', [manual.id, 'vector-only']), /绑定失败/);
    database.exec('DROP TRIGGER reject_manual_link');
    assert.equal((await repository.listTriggers('pool-a')).some((item) => item.keywords[0].keyword.startsWith('事务词')), false, '失败不留下部分组、词或关系');
    await commands.deleteMemoryTrigger('a', comfort.id);
    assert.equal((await repository.recallPassive('pool-a', '安慰')).length, 0);
    assert.equal((await repository.recallPassive('pool-a', '低落')).length, 0);
    await commands.forgetMemory('a', manual.id);
    assert.equal((await raw.getFirstAsync('SELECT COUNT(*) AS count FROM memory_passive_associations')).count, 0);
    await commands.setMemoryAutoRecall('a', catTrigger.id, 'vector-only', true);
    assert.ok((await repository.recallPassive('pool-a', '猫')).some((item) => item.id === 'vector-only'), '关联选择器可绑定已有触发词与无字面命中的记忆');
    await commands.setMemoryAutoRecall('a', catTrigger.id, 'vector-only', false);
    assert.equal((await repository.listTriggerMemories('pool-a', catTrigger.id)).find((item) => item.memory.id === 'vector-only').autoRecall, false);
  }
  {
    // 1:1、1:n、n:1、n:n 共用一个组契约；词跨组重复，记忆跨组汇总后去重。
    const one = await commands.rememberMemory('a', '恋人关系');
    const two = await commands.rememberMemory('a', '一起写代码');
    const three = await commands.rememberMemory('a', '珍惜彼此');
    const unrelated = await commands.rememberMemory('a', 'chatgpt 只在正文出现，不应被新组自动关联');
    const firstId = await commands.addMemoryTrigger('a', 'chatgpt、openai的ai、codex', [one.id, two.id, three.id, one.id]);
    const secondId = await commands.addMemoryTrigger('a', 'chatgpt、独有甲、独有乙', [two.id]);
    const thirdId = await commands.addMemoryTrigger('a', '单词', [one.id, three.id]);
    const first = (await repository.listTriggers('pool-a')).find(group => group.id === firstId);
    assert.equal(first.associatedCount, 3);
    assert.equal(first.enabledCount, 3);
    assert.equal(first.autoAssociate, false);
    database.exec(`CREATE TRIGGER reject_group_edit BEFORE INSERT ON memory_trigger_keywords
      WHEN NEW.keyword = '拒绝词' BEGIN SELECT RAISE(ABORT, '编辑失败'); END;`);
    await assert.rejects(commands.editMemoryTrigger('a', firstId, '部分成功、拒绝词', true), /编辑失败/);
    database.exec('DROP TRIGGER reject_group_edit');
    assert.deepEqual((await repository.listTriggers('pool-a')).find(group => group.id === firstId), first, '编辑失败保留原词集合、规则和关系');
    const ids = input => repository.recallPassive('pool-a', input).then(entries => entries.map(entry => entry.id).sort());
    assert.deepEqual(await ids('chatgpt'), [one.id, two.id, three.id].sort());
    assert.deepEqual(await ids('codex openai的ai'), [one.id, two.id, three.id].sort());
    assert.deepEqual(await ids('独有甲'), [two.id]);
    assert.deepEqual(await ids('单词'), [one.id, three.id].sort());
    await commands.setMemoryAutoRecall('a', firstId, two.id, false);
    assert.deepEqual(await ids('codex'), [one.id, three.id].sort());
    assert.deepEqual(await ids('chatgpt'), [one.id, two.id, three.id].sort(), '关闭一组的关联不影响同名词命中的其他组');
    await commands.editMemoryTrigger('a', firstId, '新版词、ＣＯＤＥＸ、codex', false);
    assert.deepEqual(await ids('新版词'), [one.id, three.id].sort(), '编辑词集合保留手动关系和开关');
    assert.deepEqual(await ids('openai的ai'), []);
    assert.equal((await repository.listTriggers('pool-a')).find(group => group.id === firstId).keywords.length, 2);
    await assert.rejects(commands.editMemoryTrigger('b', firstId, '越界', true), domain.MemoryTriggerNotFoundError);
    await commands.editMemoryTrigger('a', firstId, 'chatgpt', true);
    assert.ok((await ids('chatgpt')).includes(unrelated.id), '自动文本关联是组自身的可选规则');
    await commands.editMemoryTrigger('a', firstId, 'chatgpt', false);
    assert.ok(!(await ids('chatgpt')).includes(unrelated.id));
    // 并发添加的两个组各自拥有关系，不能因同名词合并。
    const concurrent = await Promise.all([
      commands.addMemoryTrigger('a', '并发同词', [one.id]), commands.addMemoryTrigger('a', '并发同词', [three.id]),
    ]);
    assert.equal(new Set(concurrent).size, 2);
    assert.deepEqual(await ids('并发同词'), [one.id, three.id].sort());
    await commands.forgetMemory('a', three.id);
    assert.equal((await repository.listTriggers('pool-a')).find(group => group.id === firstId).associatedCount, 2);
    for (const id of [firstId, secondId, thirdId, ...concurrent]) await commands.deleteMemoryTrigger('a', id);
    assert.deepEqual(await ids('chatgpt'), []);
    assert.equal((await repository.getEntry('pool-a', one.id)).content, '恋人关系', '删除组不删除记忆');
    for (const entry of [one, two, unrelated]) await commands.forgetMemory('a', entry.id);
    assert.deepEqual(await raw.getAllAsync('PRAGMA foreign_key_check'), []);
  }
  await commands.setMemoryRecallSettings('a', { passiveLimit: 0, activePageSize: 5 });
  assert.equal((await repository.recallPassive('pool-a', '考试')).length, 0);
  await assert.rejects(commands.setMemoryRecallSettings('a', { passiveLimit: -1, activePageSize: 1 }), domain.MemoryInputError);
  for (let index = 0; index < 9; index++) await create('page-' + index, '猫 ' + index, now);
  const signal = new AbortController().signal;
  const nativeTools = load('src/features/memory/aiTools/MemoryAgentTools.ts');
  const nativeContext = { task: { assistantId: 'a' }, runId: 'native-run', toolCallId: 'save-1', abortSignal: signal };
  const nativeSaved = await nativeTools.RememberMemoryTool.execute({ content: '工具主动保存的正文' }, nativeContext);
  assert.equal(nativeSaved.status, 'success');
  assert.equal(nativeSaved.data.embeddingStatus, 'not_requested');
  assert.equal(nativeSaved.data.poolId, 'pool-a');
  assert.equal((await nativeTools.RememberMemoryTool.execute({ content: '不能重复写入' }, nativeContext)).data.id, nativeSaved.data.id);
  assert.equal((await nativeTools.RememberMemoryTool.execute({ content: '猫'.repeat(501) }, { ...nativeContext, toolCallId: 'save-2' })).status, 'error');
  const nativeUpdated = await nativeTools.UpdateMemoryTool.execute({ memoryId: nativeSaved.data.id, content: '工具更新后的完整正文' }, { ...nativeContext, toolCallId: 'update-1' });
  assert.equal(nativeUpdated.status, 'success');
  assert.equal(nativeUpdated.data.embeddingStatus, 'not_requested');
  assert.equal(nativeUpdated.data.id, nativeSaved.data.id);
  assert.equal(nativeUpdated.data.content, '工具更新后的完整正文');
  assert.equal(nativeUpdated.data.rememberedAt, nativeSaved.data.rememberedAt);
  assert.equal(nativeUpdated.data.contentRevision, nativeSaved.data.contentRevision + 1);
  for (const content of [' ', '猫'.repeat(501)]) {
    assert.equal((await nativeTools.UpdateMemoryTool.execute({ memoryId: nativeSaved.data.id, content }, nativeContext)).status, 'error');
  }
  assert.equal((await nativeTools.UpdateMemoryTool.execute({ memoryId: nativeSaved.data.id, content: '不能越界覆盖' }, { ...nativeContext, task: { assistantId: 'b' } })).status, 'error');
  assert.equal((await repository.getEntry('pool-a', nativeSaved.data.id)).content, nativeUpdated.data.content);
  assert.equal((await nativeTools.ForgetMemoryTool.execute({ memoryId: nativeSaved.data.id }, { ...nativeContext, task: { assistantId: 'b' } })).data.deleted, false);
  const first = await recall.recallMemoryForRun('a', 'run', { keywords: ['考试', '猫'] }, signal);
  assert.equal(first.entries[0].id, 'both');
  assert.equal(first.entries.length, 5);
  const frozen = first.entries[0].content;
  await repository.updateEntry('pool-a', 'both', '已改写', '已改写', later);
  await create('new-match', '猫与考试与新事', later);
  const second = await recall.recallMemoryForRun('a', 'run', { keywords: ['猫', '考试'], offset: first.nextOffset }, signal);
  assert.equal(second.total, first.total);
  assert.equal(second.entries.some((item) => item.id === 'new-match'), false);
  assert.equal(first.entries[0].content, frozen);
  assert.equal(new Set([...first.entries, ...second.entries].map((item) => item.id)).size, 10);
  await assert.rejects(recall.recallMemoryForRun('a', 'run', { query: '不同搜索', offset: 5 }, signal), domain.MemoryInputError);
  recall.releaseMemoryRecallRun('run');
  await assert.rejects(recall.recallMemoryForRun('a', 'run', { keywords: ['猫'], offset: 5 }, signal), domain.MemoryInputError);
  const unavailable = await recall.recallMemoryForRun('a', 'empty-vector', { query: '用户原句' }, signal);
  assert.ok(unavailable.semanticUnavailable);
  await assert.rejects(recall.recallMemoryForRun('a', 'empty', {}, signal), domain.MemoryInputError);

  // 开关、模型选择与清除互相独立，正文与两种字面召回不依赖向量模型。
  {
    const dependencies = runtime.getMemoryRuntimeDependencies();
    const previousEmbedding = embedding;
    const previousSettings = await repository.getRecallSettings('pool-a');
    await commands.setMemoryRecallSettings('a', { ...previousSettings, passiveLimit: 5 });
    let embeddingCalls = 0;
    embedding = async () => { embeddingCalls++; return [1, 0]; };
    runtime.configureMemoryRuntimeDependencies({ ...dependencies,
      resolveEmbeddingModel: async () => {
        const settings = await repository.getEmbeddingSettings();
        return settings.enabled && settings.modelConfigId === modelA.id ? modelA : null;
      },
    });
    await embeddingModels.selectMemoryEmbeddingModel(modelA.id);
    assert.deepEqual(await repository.getEmbeddingSettings(), { enabled: false, modelConfigId: modelA.id }, '关闭时可选择模型，选择不自动开启');
    assert.equal(await runtime.getMemoryRuntimeDependencies().resolveEmbeddingModel(), null);
    await embeddingModels.setMemoryEmbeddingEnabled(true);
    await syncMemoryModel(modelA);
    assert.equal(await repository.claimEmbedding(modelA.fingerprint, 'no-implicit-rebuild', now, later, await repository.getEmbeddingIndexRevision()), null, '首次开启不自动重建历史记忆');
    for (const entry of await repository.listEntries('pool-a')) await requestEntryEmbedding('pool-a', entry.id);
    const inFlight = await repository.claimEmbedding(modelA.fingerprint, 'before-disable', now, later, await repository.getEmbeddingIndexRevision());
    assert.ok(inFlight);
    const indexed = await repository.claimEmbedding(modelA.fingerprint, 'indexed', now, later, await repository.getEmbeddingIndexRevision());
    assert.equal(await repository.completeEmbedding(indexed, [1, 0]), 'accepted');
    const beforeDisable = await repository.getEntry('pool-a', inFlight.memoryId);
    await embeddingModels.setMemoryEmbeddingEnabled(false);
    await syncMemoryModel(null);
    assert.equal(await repository.completeEmbedding(inFlight, [1, 0]), 'discarded');
    assert.equal((await repository.getEntry('pool-a', inFlight.memoryId)).content, beforeDisable.content);
    assert.equal(database.prepare('SELECT vector_json FROM memory_item_embeddings WHERE memory_id = ?').get(indexed.memoryId).vector_json, '[1,0]', '普通关闭保留已有向量');
    assert.deepEqual((await repository.readRecallCandidates('pool-a', modelA.fingerprint, 2)).vectors, []);
    assert.deepEqual(await repository.getEmbeddingSettings(), { enabled: false, modelConfigId: modelA.id }, '关闭保留模型选择');
    await embeddingModels.setMemoryEmbeddingEnabled(true);
    await syncMemoryModel(modelA);
    await requestEntryEmbedding('pool-a', inFlight.memoryId);
    const beforeClear = await repository.claimEmbedding(modelA.fingerprint, 'before-clear', now, later, await repository.getEmbeddingIndexRevision());
    const retainedTables = ['memory_items', 'memory_trigger_groups', 'memory_trigger_keywords', 'memory_passive_associations', 'memory_passive_disabled', 'memory_recall_settings'];
    const retained = retainedTables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const vectorsBeforeClear = database.prepare('SELECT * FROM memory_item_embeddings ORDER BY rowid').all();
    database.exec("CREATE TRIGGER reject_vector_clear BEFORE UPDATE OF vector_json ON memory_item_embeddings WHEN NEW.vector_json IS NULL BEGIN SELECT RAISE(ABORT, '模拟向量清除失败'); END;");
    await assert.rejects(embeddingModels.clearMemoryEmbeddings(), /模拟向量清除失败/);
    assert.deepEqual(await repository.getEmbeddingSettings(), { enabled: true, modelConfigId: modelA.id });
    assert.deepEqual(database.prepare('SELECT * FROM memory_item_embeddings ORDER BY rowid').all(), vectorsBeforeClear);
    database.exec('DROP TRIGGER reject_vector_clear');
    await embeddingModels.clearMemoryEmbeddings();
    assert.deepEqual(await repository.getEmbeddingSettings(), { enabled: true, modelConfigId: modelA.id }, '清除保留开关与模型');
    assert.deepEqual(retainedTables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), retained, '清除只删除派生向量，不改变所有空间的正文、摘要、关系与召回设置');
    const cleared = database.prepare('SELECT * FROM memory_item_embeddings').all();
    assert.ok(cleared.every(row => row.vector_json === null && row.dimension === null && row.vector_model_fingerprint === null && row.vector_content_revision === null && row.model_fingerprint === modelA.fingerprint && row.model_name === modelA.name
      && row.status === 'not_requested' && row.claim_id === null && row.claim_expires_at === null && row.attempts === 0 && row.retry_at === null && row.last_error === null && row.failed_at === null));
    assert.equal(await repository.completeEmbedding(beforeClear, [1, 0]), 'discarded', '清除后旧请求不能重新写入向量');
    assert.deepEqual(await worker.processNextMemoryEmbedding(signal), { processed: false, nextWakeAt: null, failedMemoryId: null });
    assert.equal(embeddingCalls, 0, '开启时清除也不会立即重建');
    await syncMemoryModel(modelB);
    const rebuiltCandidates = await repository.listEntries('pool-a');
    assert.ok(rebuiltCandidates.every(entry => entry.embeddingStatus === 'not_requested'), '切换模型不会重新排队历史记忆');
    assert.ok((await repository.listEntries('pool-b')).every(entry => entry.embeddingStatus === 'not_requested'), '其他空间也必须等待明确重建');
    await embeddingModels.setMemoryEmbeddingEnabled(false);
    await syncMemoryModel(null);
    await embeddingModels.clearMemoryEmbeddings();
    assert.deepEqual(await repository.getEmbeddingSettings(), { enabled: false, modelConfigId: modelA.id }, '关闭时也可清除，不改变模型');
    const plain = await commands.rememberMemory('a', '关闭后保存的正文', null, '可选向量测试');
    assert.equal(plain.embeddingStatus, 'not_requested');
    const edited = await commands.editMemory('a', plain.id, '关闭后修改的正文');
    assert.equal(edited.embeddingStatus, 'not_requested');
    const triggerId = await commands.addMemoryTrigger('a', '无模型触发', [plain.id]);
    assert.deepEqual((await repository.recallPassive('pool-a', '无模型触发')).map(entry => entry.id), [plain.id]);
    const page = await recall.recallMemoryForRun('a', 'disabled-vector', { query: '相关内容', keywords: ['可选向量测试'] }, signal);
    assert.deepEqual(page.entries.map(entry => entry.id), [plain.id]);
    assert.ok(page.semanticUnavailable);
    assert.deepEqual(await worker.processNextMemoryEmbedding(signal), { processed: false, nextWakeAt: null, failedMemoryId: null });
    assert.equal(embeddingCalls, 0, '关闭后记录、编辑、检索与队列均不请求向量模型');
    await bootstrap();
    assert.deepEqual(await repository.getEmbeddingSettings(), { enabled: false, modelConfigId: modelA.id }, '再次启动保留关闭状态与模型选择');
    assert.equal((await repository.getEntry('pool-a', plain.id)).content, edited.content);
    await embeddingModels.setMemoryEmbeddingEnabled(true);
    await syncMemoryModel(modelA);
    assert.equal((await repository.getEntry('pool-a', plain.id)).embeddingStatus, 'not_requested', '重新开启不自动补建关闭期间的记忆');
    assert.equal(await repository.completeEmbedding(beforeClear, [1, 0]), 'discarded', '重新开启相同模型也不能接受清除前的旧 claim');
    await commands.deleteMemoryTrigger('a', triggerId);
    await commands.forgetMemory('a', plain.id);
    recall.releaseMemoryRecallRun('disabled-vector');
    await repository.setEmbeddingModelId(null);
    await repository.setEmbeddingEnabled(false);
    await syncMemoryModel(null);
    await repository.setRecallSettings('pool-a', previousSettings);
    runtime.configureMemoryRuntimeDependencies(dependencies);
    embedding = previousEmbedding;
  }

  currentModel = modelA;
  await syncMemoryModel(modelA);
  for (const poolId of ['pool-a', 'pool-b']) for (const entry of await repository.listEntries(poolId)) await requestEntryEmbedding(poolId, entry.id);
  const vectorUpdated = await nativeTools.UpdateMemoryTool.execute({ memoryId: nativeSaved.data.id, content: '启用向量后更新正文' }, { ...nativeContext, toolCallId: 'update-2' });
  assert.equal(vectorUpdated.status, 'success');
  assert.equal(vectorUpdated.data.embeddingStatus, 'pending');
  const claimed = await claim();
  const loser = await claim();
  assert.notEqual(loser?.memoryId, claimed.memoryId);
  if (loser) await repository.releaseEmbedding(loser);
  await repository.updateEntry('pool-a', claimed.memoryId, '新版正文', '新版正文', later);
  assert.equal(await repository.completeEmbedding(claimed, [1, 0]), 'discarded');
  const fresh = await claim();
  assert.equal(await repository.completeEmbedding(fresh, [1, 0]), 'accepted');
  const bytes = database.prepare('SELECT vector_json FROM memory_item_embeddings WHERE memory_id = ?').get(fresh.memoryId).vector_json;
  await repository.updateEntry('pool-a', fresh.memoryId, '第三版', '第三版', later);
  assert.equal(database.prepare('SELECT vector_json FROM memory_item_embeddings WHERE memory_id = ?').get(fresh.memoryId).vector_json, bytes);
  assert.equal((await repository.readRecallCandidates('pool-a', modelA.fingerprint, 2)).vectors.some((item) => item.memoryId === fresh.memoryId), false);
  const deletedClaim = await claim();
  await repository.deleteEntry('pool-a', deletedClaim.memoryId);
  assert.equal(await repository.completeEmbedding(deletedClaim, [1, 0]), 'discarded');
  const modelClaim = await claim();
  currentModel = modelB; await syncMemoryModel(modelB);
  assert.equal(await repository.completeEmbedding(modelClaim, [1, 0]), 'discarded');
  for (const poolId of ['pool-a', 'pool-b']) for (const entry of await repository.listEntries(poolId)) await requestEntryEmbedding(poolId, entry.id);
  const failing = await claim();
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = attempt === 0 ? failing : await claim('retry-' + attempt, later);
    assert.equal(task.memoryId, failing.memoryId);
    assert.equal(await repository.failEmbedding(task, '网络不可用', false, now, now), true);
  }
  assert.equal((await repository.getEntry('pool-a', failing.memoryId)).embeddingStatus, 'failed');
  await syncMemoryModel(modelB);
  assert.equal(database.prepare('SELECT attempts FROM memory_item_embeddings WHERE memory_id = ?').get(failing.memoryId).attempts, 3);
  await requestEntryEmbedding('pool-a', failing.memoryId);
  const cancelled = await claim();
  await repository.releaseEmbedding(cancelled);
  assert.equal(database.prepare('SELECT attempts FROM memory_item_embeddings WHERE memory_id = ?').get(cancelled.memoryId).attempts, 0);
  const retry = await claim();
  await repository.completeEmbedding(retry, [1, 0]);
  const mismatch = await claim();
  assert.equal(await repository.completeEmbedding(mismatch, [1, 0, 0]), 'dimension_mismatch');
  await repository.releaseEmbedding(mismatch);
  await assert.rejects(repository.readRecallCandidates('pool-a', modelB.fingerprint, 3), domain.MemoryVectorDimensionError);
  // Worker 的第三次失败与手动重试、取消按真实持久任务执行。
  await syncMemoryModel(null);
  database.prepare("DELETE FROM memory_items WHERE id <> 'vector-only'").run();
  currentModel = modelA;
  await syncMemoryModel(modelA);
  await commands.retryMemoryEmbedding('a', 'vector-only');
  embedding = async () => { throw new runtime.MemoryEmbeddingError('网络不可用', false); };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await worker.processNextMemoryEmbedding(signal);
    assert.equal(result.processed, true);
    assert.equal(result.failedMemoryId, attempt === 2 ? 'vector-only' : null);
    database.prepare('UPDATE memory_item_embeddings SET retry_at = ?').run(now);
  }
  assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false);
  await commands.retryMemoryEmbedding('a', 'vector-only');
  embedding = async () => [1, 0];
  await worker.processNextMemoryEmbedding(signal);
  await create('lexical', '猫 考试', now);
  const semantic = await recall.recallMemoryForRun('a', 'semantic', { query: '复习', keywords: ['考试', '猫'] }, signal);
  assert.deepEqual(semantic.entries.map((item) => item.id), ['lexical', 'vector-only']);
  assert.equal(semantic.semanticUnavailable, null);

  // 全量重建不逐条覆盖；失败、取消、发布中 SQL 错误和过期快照都保留原向量。
  {
    const vectorRows = () => database.prepare('SELECT memory_id, vector_json, dimension, vector_model_fingerprint, vector_content_revision FROM memory_item_embeddings ORDER BY memory_id').all();
    const oldVectors = vectorRows();
    database.exec('ALTER TABLE memory_item_embeddings DROP COLUMN vector_model_fingerprint; ALTER TABLE memory_item_embeddings DROP COLUMN vector_content_revision; PRAGMA user_version = 163');
    await bootstrap();
    assert.deepEqual(vectorRows(), oldVectors, '164 正式升级入口为旧就绪向量补齐来源，不重建、不改写向量');
    database.exec('DROP TABLE memory_embedding_index_control; PRAGMA user_version = 159');
    await bootstrap();
    assert.deepEqual(vectorRows(), oldVectors, '160 升级保留已有向量及模型信息');
    assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false, '升级不继承旧版本隐式排入的整库重建');
    let calls = 0;
    embedding = async () => { calls++; if (calls === 2) throw new runtime.MemoryEmbeddingError('模拟重建网络失败', true); return [0, 1]; };
    await assert.rejects(embeddingModels.rebuildMemoryEmbeddingIndex(signal, () => {}), /模拟重建网络失败/);
    assert.deepEqual(vectorRows(), oldVectors, '生成一部分后失败也不能提前覆盖旧向量');

    const cancelledBuild = new AbortController();
    embedding = async () => { cancelledBuild.abort(); return [0, 1]; };
    await assert.rejects(embeddingModels.rebuildMemoryEmbeddingIndex(cancelledBuild.signal, () => {}));
    assert.deepEqual(vectorRows(), oldVectors, '模型忽略取消并返回时，发布仍被取消 fence 拦住');

    embedding = async () => [0, 1];
    database.exec("CREATE TRIGGER reject_index_publish BEFORE UPDATE OF vector_json ON memory_item_embeddings WHEN OLD.memory_id = 'vector-only' BEGIN SELECT RAISE(ABORT, '模拟整批发布失败'); END;");
    await assert.rejects(embeddingModels.rebuildMemoryEmbeddingIndex(signal, () => {}), /模拟整批发布失败/);
    assert.deepEqual(vectorRows(), oldVectors, '已写入第一条后第二条失败，整个事务回滚');
    database.exec('DROP TRIGGER reject_index_publish');

    const staleBuild = await repository.beginEmbeddingRebuild('before-content-edit', modelA, await repository.getEmbeddingIndexRevision());
    await commands.editMemory('a', 'lexical', '猫 考试 已编辑');
    await assert.rejects(repository.publishEmbeddingRebuild(staleBuild, staleBuild.entries.map(() => [0, 1]), signal), /记忆发生变化/);
    assert.deepEqual(vectorRows(), oldVectors);
    await repository.finishEmbeddingRebuild(staleBuild.id);

    const beforeConfigurationRead = await repository.getEmbeddingIndexRevision();
    const previousEnabled = (await repository.getEmbeddingSettings()).enabled;
    await repository.setEmbeddingEnabled(!previousEnabled);
    assert.equal(await repository.syncEmbeddingModel(modelA, beforeConfigurationRead), null, '配置读取期间发生变更时，旧配置不能重获新的发布版本');
    await assert.rejects(repository.beginEmbeddingRebuild('stale-config', modelA, beforeConfigurationRead), /配置已变化/);
    assert.equal(await repository.claimEmbedding(modelA.fingerprint, 'stale-config-claim', now, later, beforeConfigurationRead), null);
    await repository.setEmbeddingEnabled(previousEnabled);

    const oldBuild = await repository.beginEmbeddingRebuild('old-build', modelA, await repository.getEmbeddingIndexRevision());
    const winnerBuild = await repository.beginEmbeddingRebuild('new-build', modelA, await repository.getEmbeddingIndexRevision());
    await assert.rejects(repository.publishEmbeddingRebuild(oldBuild, oldBuild.entries.map(() => [0, 1]), signal), /重建任务已变化/);
    await repository.finishEmbeddingRebuild(oldBuild.id);
    assert.equal(await repository.claimEmbedding(modelA.fingerprint, 'during-build', now, later, await repository.getEmbeddingIndexRevision()), null, '旧任务不能解除新一轮重建的发布所有权');
    await repository.publishEmbeddingRebuild(winnerBuild, winnerBuild.entries.map(() => [0, 1]), signal);
    assert.ok(vectorRows().every(row => row.vector_json === '[0,1]'));

    const publishedVectors = vectorRows();
    currentModel = modelB;
    await syncMemoryModel(modelB);
    assert.deepEqual(vectorRows(), publishedVectors, '切换保留向量及其原模型信息');
    calls = 0; embedding = async () => { calls++; return [1, 0]; };
    assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false);
    assert.equal(calls, 0, '切换后 worker 不请求历史记忆的新向量');
    await bootstrap();
    assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false, '重启也不能隐式重建');
    await embeddingModels.rebuildMemoryEmbeddingIndex(signal, () => {});
    assert.ok(vectorRows().every(row => row.vector_json === '[1,0]' && row.vector_model_fingerprint === modelB.fingerprint));
    currentModel = modelA;
    await syncMemoryModel(modelA);
    await embeddingModels.rebuildMemoryEmbeddingIndex(signal, () => {});
  }

  // 模型切回只恢复匹配的向量，逐条请求不覆盖或排队其他历史记忆。
  {
    const originalEmbedding = embedding;
    const sourceRows = () => database.prepare('SELECT memory_id, vector_json, vector_model_fingerprint, vector_content_revision FROM memory_item_embeddings ORDER BY memory_id').all();
    currentModel = modelA;
    await syncMemoryModel(modelA);
    await create('reuse-unchanged', '未修改的旧记忆');
    await create('reuse-edited', '稍后修改的旧记忆');
    embedding = async () => [1, 0];
    await embeddingModels.rebuildMemoryEmbeddingIndex(signal, () => {});
    const originalSources = sourceRows();
    let embeddingCalls = 0;
    embedding = async () => { embeddingCalls++; return [0, 1]; };
    currentModel = modelB;
    await syncMemoryModel(modelB);
    assert.equal((await repository.countEmbeddingIndex(modelB.fingerprint)).valid, 0);
    assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false);
    currentModel = modelA;
    await syncMemoryModel(modelA);
    assert.equal((await repository.countEmbeddingIndex(modelA.fingerprint)).valid, originalSources.length);
    assert.equal((await repository.getEntry('pool-a', 'reuse-unchanged')).embeddingStatus, 'ready');
    assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false);
    assert.equal(embeddingCalls, 0, 'A→B→A 恢复原索引，不请求模型');
    assert.deepEqual(sourceRows(), originalSources);
    assert.equal((await repository.readRecallCandidates('pool-a', modelA.fingerprint, 2)).vectors.length, originalSources.length);

    currentModel = modelB;
    await syncMemoryModel(modelB);
    await commands.editMemory('a', 'reuse-edited', '已经修改，旧向量不能接管');
    currentModel = modelA;
    await syncMemoryModel(modelA);
    assert.equal((await repository.getEntry('pool-a', 'reuse-edited')).embeddingStatus, 'not_requested');
    assert.equal((await repository.countEmbeddingIndex(modelA.fingerprint)).valid, originalSources.length - 1);

    currentModel = modelB;
    await syncMemoryModel(modelB);
    embedding = async () => { embeddingCalls++; throw new runtime.MemoryEmbeddingError('单条请求失败', true); };
    await commands.retryMemoryEmbedding('a', 'reuse-unchanged');
    assert.equal((await worker.processNextMemoryEmbedding(signal)).failedMemoryId, 'reuse-unchanged');
    assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false);
    assert.equal(embeddingCalls, 1, '只为指定记忆发送一次请求');
    assert.deepEqual(sourceRows(), originalSources, '单条任务失败保留旧向量及其来源');
    currentModel = modelA;
    await syncMemoryModel(modelA);
    assert.equal((await repository.getEntry('pool-a', 'reuse-unchanged')).embeddingStatus, 'ready', '失败的新模型任务不能丢失旧向量的接管能力');

    currentModel = modelB;
    await syncMemoryModel(modelB);
    const oldRevision = await repository.getEmbeddingIndexRevision();
    const interruptedBuild = await repository.beginEmbeddingRebuild('interrupted-before-single', modelB, oldRevision);
    embedding = async text => { embeddingCalls++; assert.equal(text, '未修改的旧记忆'); return [0, 1, 0]; };
    await commands.retryMemoryEmbedding('a', 'reuse-unchanged');
    await assert.rejects(repository.publishEmbeddingRebuild(interruptedBuild, interruptedBuild.entries.map(() => [0, 1]), signal), /重建任务已变化/);
    await worker.processNextMemoryEmbedding(signal);
    assert.equal(embeddingCalls, 2);
    assert.equal((await repository.countEmbeddingIndex(modelB.fingerprint)).valid, 1);
    assert.deepEqual(sourceRows().filter(row => row.memory_id !== 'reuse-unchanged'), originalSources.filter(row => row.memory_id !== 'reuse-unchanged'));
    currentModel = modelA;
    await syncMemoryModel(modelA);
    assert.equal((await repository.getEntry('pool-a', 'reuse-unchanged')).embeddingStatus, 'not_requested', '已被新向量覆盖的条目不能伪造恢复');
    assert.equal((await raw.getFirstAsync('SELECT dimension FROM memory_v3_state WHERE id = 1')).dimension, 2, '切回后恢复旧模型的索引维度，不沿用新模型的三维空间');
    await assert.rejects(repository.retryEmbedding('pool-a', 'reuse-edited', oldRevision), /向量模型已变化/);

    currentModel = { ...modelB, fingerprint: 'model-a:r3' };
    await syncMemoryModel(currentModel);
    assert.equal((await repository.countEmbeddingIndex(currentModel.fingerprint)).valid, 0, '同名模型版本改变不能复用旧向量');
    assert.equal((await worker.processNextMemoryEmbedding(signal)).processed, false);
    assert.equal(embeddingCalls, 2);
    currentModel = modelA;
    await syncMemoryModel(modelA);
    await commands.forgetMemory('a', 'reuse-unchanged');
    await commands.forgetMemory('a', 'reuse-edited');
    const dependencies = runtime.getMemoryRuntimeDependencies();
    runtime.configureMemoryRuntimeDependencies({ ...dependencies, resolveEmbeddingModel: async () => null });
    await assert.rejects(commands.retryMemoryEmbedding('a', 'vector-only'), /先开启记忆向量化/);
    runtime.configureMemoryRuntimeDependencies(dependencies);
    await syncMemoryModel(modelA);
    embedding = originalEmbedding;
  }

  // N=20 在生成期间保留所有原文，提交后只保留 21～25；不会周期性漏 1～5。
  for (let id = 1; id <= 25; id++) addMessage(id, '消息 ' + id, id % 2 ? 'user' : 'assistant', new Date(Date.parse(now) + id * 1000).toISOString());
  const summaryClaim = await summary.claim('conversation', 20, 'summary-claim', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  assert.equal(summaryClaim.messages.length, 20);
  assert.equal((await summary.readContext('conversation', [], [])).raw.length, 25);
  assert.equal(await summary.claim('conversation', 20, 'summary-loser', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null);
  await summary.create('conversation', 'user-summary', '用户先写的摘要', now, 'Asia/Shanghai');
  await summary.edit('conversation', 'user-summary', '用户编辑后的摘要', later);
  assert.equal(await appendSummary(summaryClaim, 'summary-1', '新增一段', later), true);
  assert.equal(await appendSummary(summaryClaim, 'duplicate-summary', '不能重复追加', later), false);
  let context = await summary.readContext('conversation', [25], []);
  assert.deepEqual(context.raw.map((item) => item.messageId), [21, 22, 23, 24]);
  assert.deepEqual(context.segments.map((item) => item.content), ['用户编辑后的摘要', '新增一段']);
  await summary.delete('conversation', 'summary-1');
  assert.equal((await summary.readContext('conversation', [], [])).raw.length, 5);
  assert.equal(await summary.claim('conversation', 20, 'no-rebuild', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null);
  // 已处理范围由稳定游标表达，删除游标对应行也不能让旧消息重新进入原文或摘要领取。
  database.prepare('DELETE FROM messages WHERE id = 20').run();
  assert.deepEqual((await summary.readContext('conversation', [], [])).raw.map((item) => item.messageId), [21, 22, 23, 24, 25]);
  assert.equal(await summary.claim('conversation', 20, 'deleted-cursor', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null);
  database.prepare('DELETE FROM messages WHERE id = 1').run();
  database.prepare('UPDATE sessions SET visible_after_message_id = 25 WHERE id = ?').run('conversation');
  assert.equal((await summary.readContext('conversation', [], [])).segments[0].content, '用户编辑后的摘要');
  assert.equal((await summary.readContext('conversation', [], [])).raw.length, 0);
  for (let id = 26; id <= 45; id++) addMessage(id, '新消息 ' + id, id % 2 ? 'user' : 'assistant', later);
  const clearClaim = await summary.claim('conversation', 20, 'clear-claim', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  await summary.clear('conversation');
  assert.equal(await appendSummary(clearClaim, 'zombie', '不能复活', later), false);
  assert.equal((await summary.readContext('conversation', [], [])).raw.length, 0);
  addMessage(46, '当前用户输入', 'user', later);
  database.prepare('UPDATE conversation_turn_state SET reply_cursor = 45').run();
  assert.equal(await summary.claim('conversation', 1, 'protected-input', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null);
  assert.deepEqual((await summary.readContext('conversation', [46], [])).raw, []);
  // run item 顺序优先于物理 ID／创建时间；删锚点不能改变剩余成员的排序键。
  addMessage(48, 'run 第二项', 'assistant', now, 'ordered-run', 2);
  addMessage(47, 'run 首项', 'assistant', later, 'ordered-run', 1);
  const ordered = await raw.getAllAsync(timelineOrderedMessagesCte("m.session_id = 'conversation'") + ' SELECT * FROM ordered_messages ORDER BY ' + timelineProjectionOrderBy('ASC'));
  assert.ok(ordered.findIndex((row) => row.id === 47) < ordered.findIndex((row) => row.id === 48));
  const anchor = ordered.find((row) => row.id === 48).timeline_order_anchor_id;
  database.prepare('DELETE FROM messages WHERE id = 47').run();
  const remaining = await raw.getFirstAsync(timelineOrderedMessagesCte("m.session_id = 'conversation'") + ' SELECT * FROM ordered_messages WHERE id = 48');
  assert.equal(remaining.timeline_order_anchor_id, anchor);
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }),
    generateAddition: async () => '10 月 4 日讨论 10 月 10 日考试' });
  // 提示词的启用状态只消费摘要设置，暂停或固定原文不会产生第二份提示词开关。
  let promptStateConversation = null;
  load('src/features/chat/conversation/application/ChatConversationRuntime.ts').configureChatConversationRuntime({
    sessions: { getCanonicalConversation: async () => promptStateConversation },
  });
  assert.deepEqual(await summaryApplication.getAssistantChatSummaryGenerationState('prompt-settings-ai'), { primaryEnabled: true, secondaryEnabled: true });
  database.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('prompt-settings-ai', 'prompt-settings-agent', '摘要设置', 'chat', now, now);
  database.prepare("INSERT INTO chat_conversations(id,kind) VALUES ('prompt-settings-chat','direct')").run();
  database.prepare('INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('prompt-settings-chat', 'prompt-settings-ai', '摘要设置', now, now);
  promptStateConversation = { id: 'prompt-settings-chat' };
  await summary.updateSettings('prompt-settings-chat', { secondaryEnabled: false });
  assert.deepEqual(await summaryApplication.getAssistantChatSummaryGenerationState('prompt-settings-ai'), { primaryEnabled: true, secondaryEnabled: false });
  await summary.updateSettings('prompt-settings-chat', { generationEnabled: false, secondaryEnabled: true });
  assert.deepEqual(await summaryApplication.getAssistantChatSummaryGenerationState('prompt-settings-ai'), { primaryEnabled: false, secondaryEnabled: false });
  await summary.updateSettings('prompt-settings-chat', { generationEnabled: true, injectEnabled: false });
  assert.deepEqual(await summaryApplication.getAssistantChatSummaryGenerationState('prompt-settings-ai'), { primaryEnabled: true, secondaryEnabled: true }, '已有摘要注入开关不控制提取任务');
  database.prepare("INSERT INTO messages(id,session_id,text,is_me,sender_type,created_at,status) VALUES (4900,'prompt-settings-chat','固定原文',1,'user',?,'sent')").run(now);
  await summary.setFixedStart('prompt-settings-chat', 4900);
  assert.deepEqual(await summaryApplication.getAssistantChatSummaryGenerationState('prompt-settings-ai'), { primaryEnabled: false, secondaryEnabled: false });
  database.prepare("DELETE FROM ai_assistants WHERE id='prompt-settings-ai'").run();
  database.prepare("DELETE FROM chat_conversations WHERE id='prompt-settings-chat'").run();
  const dates = buildSummaryInput({ ...summaryClaim, messages: [{ ...summaryClaim.messages[0], content: '10 月 10 日考试' }] });
  assert.ok(JSON.parse(dates).newMessagesOnly[0].localDateTime.startsWith('2026-10-04'));

  // 失败、取消和插入失败都不能推进摘要范围；成功只追加一段。
  database.prepare('UPDATE conversation_turn_state SET reply_cursor = 100').run();
  const beforeFailure = await summary.readContext('conversation', [], []);
  const { ChatSummaryGenerationError } = load('src/features/chat/summary/domain/ChatSummaryRepository.ts');
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }), generateAddition: async () => {
    throw new ChatSummaryGenerationError({ kind: 'empty_output', message: '模型没有返回摘要正文。', retryable: true });
  } });
  assert.equal(await summaryApplication.processChatSummary('conversation', signal),false);
  assert.deepEqual((await summary.readContext('conversation', [], [])).raw, beforeFailure.raw);
  assert.equal(database.prepare('SELECT claim_id FROM chat_summary_state WHERE conversation_id = ?').get('conversation').claim_id, null);
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }),
    generateAddition: async () => {
      throw new ChatSummaryGenerationError({ kind: 'output_limit', message: '模型因输出 token 上限停止。', retryable: false });
    } });
  await retryPending('conversation','primary');
  assert.equal(await summaryApplication.processChatSummary('conversation', signal),false);
  assert.deepEqual(withoutTasks(await summary.readContext('conversation', [], [])), withoutTasks(beforeFailure), '截断输出不能追加摘要或推进原文范围');
  assert.equal(database.prepare('SELECT claim_id FROM chat_summary_state WHERE conversation_id = ?').get('conversation').claim_id, null);
  const cancelledSummary = new AbortController();
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }), generateAddition: async () => {
    cancelledSummary.abort(); return '取消后不能提交';
  } });
  await retryPending('conversation','primary');
  assert.equal(await summaryApplication.processChatSummary('conversation', cancelledSummary.signal),false);
  assert.deepEqual((await summary.readContext('conversation', [], [])).raw, beforeFailure.raw);
  await summary.create('conversation', 'collision', '用户维护的内容', now, 'Asia/Shanghai');
  const atomicClaim = await summary.claim('conversation', 1, 'atomic-claim', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  await assert.rejects(appendSummary(atomicClaim, 'collision', '不能覆盖', later));
  assert.deepEqual((await summary.readContext('conversation', [], [])).raw, beforeFailure.raw);
  await summary.releaseClaim(atomicClaim);
  const plainSummary = '成功的新摘要，约好"明天"复习。\n我负责整理 {重点}。';
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }), generateAddition: async () => plainSummary });
  assert.equal(await summaryApplication.processChatSummary('conversation', signal), true);
  const afterSuccess = await summary.readContext('conversation', [], []);
  assert.equal(afterSuccess.raw.length, beforeFailure.raw.length - 1);
  assert.deepEqual(afterSuccess.segments.map((item) => item.content), ['用户维护的内容', plainSummary], '纯正文中的引号、换行与大括号完整保存');
  let longSummaryCalls = 0;
  const longSummary = '猫'.repeat(1000);
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }),
    generateAddition: async () => { longSummaryCalls++; return longSummary; } });
  assert.equal(await summaryApplication.processChatSummary('conversation',signal),true);
  const afterLongSummary = await summary.readContext('conversation',[]);
  assert.equal(longSummaryCalls,1,'有效正文超过500字直接保存，不为了字数重复请求');
  assert.equal(afterLongSummary.segments.at(-1).content,longSummary,'超长正文不截断、不丢弃');
  assert.equal(afterLongSummary.raw.length,afterSuccess.raw.length-1,'保存完整正文时正常交接原文范围');

  // 无新增是成功空结果：交接普通消息、通话和任务，但不生成可搜索或注入的正文。
  {
    database.prepare(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at)
      VALUES ('empty-summary-ai','empty-summary-actor','空摘要测试','chat',?,?)`).run(now,now);
    database.exec("INSERT INTO chat_conversations VALUES ('empty-summary','direct')");
    database.prepare(`INSERT INTO sessions (id,ai_assistant_id,name,created_at,updated_at)
      VALUES ('empty-summary','empty-summary-ai','空摘要测试',?,?)`).run(now,now);
    database.prepare(`INSERT INTO messages (id,session_id,text,is_me,sender_type,status,created_at)
      VALUES (600001,'empty-summary','你好',0,'assistant','sent',?)`).run(now);
    await calls.createSession({ id:'empty-summary-call',chatSessionId:'empty-summary',aiAssistantId:'empty-summary-ai',
      agentId:'empty-summary-actor',direction:'outgoing',requestedMode:'voice',source:'user',state:'ended',
      startedAt:now,acceptedAt:now,endedAt:later });
    await calls.appendEvent({ id:'empty-summary-event',callId:'empty-summary-call',chatSessionId:'empty-summary',
      kind:'aiSpeechText',actorType:'ai',text:'晚安',includeInAIContext:true,createdAt:later });
    let primaryCalls = 0, secondaryCalls = 0;
    const diagnostics = { model:'test',requestedMaxTokens:500,timeoutSeconds:300,durationMs:1,
      promptTokens:10,completionTokens:5,totalTokens:15,cachedTokens:null,finishReason:'stop',
      contentCharacters:6,reasoningCharacters:0,serverError:null };
    summaryRuntime.configureChatSummaryRuntime({ repository:summary,getBatchSettings: async () => ({ batchSize: 2, recentWindowLimit: 0 }),
      generateAddition:async(_input,_signal,report)=>{ primaryCalls++;await report(diagnostics);return null; },
      generateSecondary:async()=>{ secondaryCalls++;return null; } });
    assert.equal(await summaryApplication.processChatSummary('empty-summary',signal),true);
    const emptyPrimary = await summary.readContext('empty-summary',[]);
    assert.deepEqual(emptyPrimary.raw,[]);
    assert.deepEqual(emptyPrimary.pendingCalls,[],'无新增通话也完成处理');
    assert.deepEqual(emptyPrimary.segments,[]);
    assert.deepEqual(emptyPrimary.contextSegments,[]);
    assert.equal(emptyPrimary.tasks[0].status,'completed');
    assert.deepEqual(emptyPrimary.tasks[0].segmentIds,[]);
    assert.deepEqual(emptyPrimary.tasks[0].calls,[diagnostics]);
    assert.equal(await summaryApplication.processChatSummary('empty-summary',signal),false);
    assert.equal(primaryCalls,1,'无新增成功后不再请求同一批原文');

    await summary.create('empty-summary','empty-summary-source','只有寒暄的旧纪要',now,'Asia/Shanghai');
    await summary.updateSettings('empty-summary',{secondaryTokenThreshold:1});
    assert.equal(await summaryApplication.processChatSummary('empty-summary',signal),true);
    const emptySecondary = await summary.readContext('empty-summary',[]);
    assert.equal(emptySecondary.segments.length,1,'二级无新增不创建正文');
    assert.ok(emptySecondary.segments[0].compactionId,'来源仍标记已处理，供用户管理');
    assert.deepEqual(emptySecondary.contextSegments,[],'被消费的来源也不再自动注入');
    const completedSecondary = emptySecondary.tasks.find(task=>task.level==='secondary');
    assert.equal(completedSecondary.status,'completed');
    assert.deepEqual(completedSecondary.segmentIds,[]);
    assert.equal(await summaryApplication.processChatSummary('empty-summary',signal),false);
    assert.equal(secondaryCalls,1,'二级空结果不会反复归纳同一来源');
    assert.deepEqual((await summary.search('empty-summary-ai',{keywords:['本批无']})).entries,[]);
  }

  // 短通话共用 N；达到门槛时必须等待挂断，统一范围包含通话前原文。
  database.prepare("INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES ('calls-ai', 'actor-calls-ai', '通话 AI', 'chat', ?, ?)").run(now, now);
  database.prepare("INSERT INTO chat_conversations (id, kind) VALUES ('call-summary', 'direct')").run();
  database.prepare("INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at) VALUES ('call-summary', 'calls-ai', '通话 AI', ?, ?)").run(now, now);
  database.prepare("INSERT INTO conversation_turn_state (session_id, reply_cursor, revision, updated_at) VALUES ('call-summary', 901, 0, ?)").run(now);
  for (const [id, role] of [[900, 'user'], [901, 'assistant']]) database.prepare(`INSERT INTO messages
    (id, session_id, text, is_me, sender_type, created_at, time, status) VALUES (?, 'call-summary', '通话前聊天', ?, ?, ?, ?, 'sent')`)
    .run(id, role === 'user' ? 1 : 0, role, '2026-10-04T03:59:00.000Z', now);
  const createCall = (id, patch = {}) => calls.createSession({ id, chatSessionId: 'call-summary', aiAssistantId: 'calls-ai',
    agentId: 'actor-calls-ai', direction: 'outgoing', requestedMode: 'video', source: 'user', state: 'ended',
    startedAt: '2026-10-04T03:59:30.000Z', acceptedAt: now, endedAt: later, ...patch });
  await createCall('short-call');
  for (const [index, kind] of ['userSpeechText', 'aiSpeechText'].entries()) await calls.appendEvent({
    id: 'short-' + index, callId: 'short-call', chatSessionId: 'call-summary', kind,
    actorType: index ? 'ai' : 'user', text: '通话里的问候', includeInAIContext: true,
    createdAt: new Date(Date.parse(now) + (index + 1) * 1000).toISOString(),
  });
  let modelInputs = [];
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 20, recentWindowLimit: 0 }),
    generateAddition: async (input) => { modelInputs.push(input); return '我们在电话里聊了复习计划。'; } });
  assert.equal(await summaryApplication.processChatSummary('call-summary', signal), false, '四条对话不足 N，挂断不额外调用 AI');
  assert.equal(modelInputs.length, 0);
  let callContext = await summaryApplication.getChatSummaryContext('call-summary');
  assert.equal(timelineDomain.conversationDialogueStartIndexes(callContext.timeline).length, 4);
  assert.equal(callContext.timeline[0].source, 'chat', '统一时间线先提供通话前聊天');
  assert.equal(callContext.pendingCalls[0].transcripts.length, 2);
  await createCall('active-call', { state: 'active', endedAt: null });
  for (let index = 0; index < 121; index++) await calls.appendEvent({ id: 'speech-' + index, callId: 'active-call',
    chatSessionId: 'call-summary', kind: index % 2 ? 'aiSpeechText' : 'userSpeechText', actorType: index % 2 ? 'ai' : 'user',
    text: index === 0 ? '有点焦虑，担心复习进度' : index === 120 ? '商量好复习计划后放松了' : '讨论复习计划 ' + index,
    includeInAIContext: true, createdAt: new Date(Date.parse(now) + 130_000 + index * 1000).toISOString() });
  assert.equal(await summaryApplication.processChatSummary('call-summary', signal), false, '通话中越过 N 不能领取摘要');
  assert.equal(modelInputs.length, 0);
  callContext = await summaryApplication.getChatSummaryContext('call-summary');
  assert.equal(callContext.pendingCalls.find((call) => call.info.callId === 'active-call').transcripts.length, 121, '进行中通话不受 100 条窗口限制');
  await calls.updateSession('active-call', { state: 'ended', endedAt: later });
  const callClaim = await summary.claim('call-summary', 20, 'call-winner', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0);
  assert.equal(await summary.claim('call-summary', 1, 'call-loser', now, later, 'Asia/Shanghai', 0), null, '聊天和通话只有一个持久 claim winner');
  const callInput = JSON.parse(buildSummaryInput(callClaim));
  assert.equal(callInput.sourceKind, 'conversation');
  assert.equal(callInput.newMessagesOnly[0].source, 'chat');
  assert.ok(callInput.newMessagesOnly.some((item) => item.source === 'call' && item.speaker === 'user'));
  assert.equal(callInput.newMessagesOnly.filter((item) => item.source === 'call' && item.speaker !== 'application').length, 123, '跨入通话后完整延伸到挂断，不按 N 留半通电话');
  await summary.create('call-summary', 'call-collision', '手动记录', now, 'Asia/Shanghai');
  await assert.rejects(appendSummary(callClaim, 'call-collision', '不能覆盖', later));
  assert.equal((await summaryApplication.getChatSummaryContext('call-summary')).pendingCalls.length, 2, '事务失败不能消费通话');
  await summary.edit('call-summary', 'call-collision', '用户改好的记录', later);
  assert.equal(await appendSummary(callClaim, 'call-segment', '通话前聊起复习，电话中制定计划，焦虑逐渐缓解。', later), true);
  assert.equal(await appendSummary(callClaim, 'duplicate-call', '不能重复', later), false);
  callContext = await summaryApplication.getChatSummaryContext('call-summary');
  assert.equal(callContext.pendingCalls.length, 0);
  assert.deepEqual(callContext.raw, [], '统一提交同时推进聊天游标与整通电话进度');
  assert.equal(callContext.segments[1].content, '通话前聊起复习，电话中制定计划，焦虑逐渐缓解。');
  assert.equal(callContext.segments[1].messageCount, 125);
  await summary.edit('call-summary', 'call-segment', '用户修改共同经历', later);
  assert.equal((await summaryApplication.getChatSummaryContext('call-summary')).segments[1].content, '用户修改共同经历');
  await summary.delete('call-summary', 'call-segment');
  assert.equal((await summaryApplication.getChatSummaryContext('call-summary')).pendingCalls.length, 0, '用户删段不能重建已消费通话');

  // 超过 5000 字的完整领取只调用一次模型；失败保留原文，成功一次交接。
  await createCall('long-call', { acceptedAt: later, endedAt: '2026-10-04T06:00:00.000Z' });
  for (let index = 0; index < 24; index++) await calls.appendEvent({ callId: 'long-call', chatSessionId: 'call-summary',
    kind: index % 2 ? 'aiSpeechText' : 'userSpeechText', actorType: index % 2 ? 'ai' : 'user', text: '🐈'.repeat(500),
    includeInAIContext: true, createdAt: new Date(Date.parse(later) + index * 1000).toISOString() });
  const longContext = await summaryApplication.getChatSummaryContext('call-summary');
  let requests = 0;
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 20, recentWindowLimit: 0 }), generateAddition: async (input) => {
    assert.deepEqual(input.messages, longContext.timeline);
    requests++;
    throw new Error('完整摘要请求失败');
  } });
  await assert.rejects(summaryApplication.processChatSummary('call-summary', signal), /完整摘要请求失败/);
  assert.equal(requests, 1);
  assert.deepEqual(withoutTasks(await summaryApplication.getChatSummaryContext('call-summary')), withoutTasks(longContext), '失败保留整个尚未交接范围');
  modelInputs = [];
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 20, recentWindowLimit: 0 }), generateAddition: async (input) => {
    modelInputs.push(input);
    assert.ok(input.messages.reduce((count, item) => count + Array.from(item.content).length, 0) > 5000);
    return '长通话完整摘要。';
  } });
  assert.equal(await summaryApplication.processChatSummary('call-summary', signal), true);
  assert.equal(modelInputs.length, 1);
  assert.deepEqual(modelInputs[0].messages, longContext.timeline, '完整输入不重排或丢弃原文');
  const longSegments = (await summaryApplication.getChatSummaryContext('call-summary')).segments.slice(1);
  assert.equal(longSegments.reduce((count, item) => count + item.messageCount, 0), 24);
  assert.equal((await summaryApplication.getChatSummaryContext('call-summary')).pendingCalls.length, 0);

  // 摘要上限前后均按真实时间选取，不抢先消费下一通电话或漏掉电话后的文字。
  const chatItem = (identity, timestamp) => ({ source: 'chat', kind: 'dialogue', speaker: 'user',
    timestamp, content: identity, logicalIdentity: identity });
  const before = [chatItem('之前1', '2026-10-04T03:00:00.000Z'), chatItem('之前2', '2026-10-04T03:01:00.000Z')];
  const callItems = longContext.timeline;
  const after = [chatItem('之后1', '2026-10-04T07:00:00.000Z')];
  assert.deepEqual(timelineDomain.selectSummaryRange([...before, ...callItems, ...after], 2, 0), before, '门槛在通话前满足时不吞入下一通电话');
  assert.deepEqual(timelineDomain.selectSummaryRange([...before, ...callItems, ...after], 27, 0), [...before, ...callItems, ...after], '不足门槛的短尾部可以和通话后消息一起累计');
  assert.deepEqual(timelineDomain.selectSummaryRange([...before, ...callItems, ...after], 3, 2), [], '通话闭合后不足近期窗口时延后总结，不能吞掉保留原文');
  assert.deepEqual(timelineDomain.selectSummaryRange([...before, ...callItems, ...after, chatItem('之后2', later)], 3, 2),
    [...before, ...callItems], '闭合整通电话后仍需留下完整近期窗口');

  // 旧开发版备份可能已有孤立关联；退休两种旧表均不能触碰正文、通话与处理进度。
  for (const primaryKey of ['PRIMARY KEY (segment_id)', 'PRIMARY KEY (segment_id, call_id)']) {
    const migrationDb = new DatabaseSync(':memory:');
    migrationDb.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE chat_summary_segments (id TEXT PRIMARY KEY, content TEXT);
      INSERT INTO chat_summary_segments VALUES ('old-segment', '已有摘要不能改写');
      CREATE TABLE chat_summary_state (conversation_id TEXT PRIMARY KEY, processed_cursor TEXT);
      INSERT INTO chat_summary_state VALUES ('conversation', '已总结到这里');
      CREATE TABLE chat_summary_processed_calls (conversation_id TEXT, call_id TEXT);
      INSERT INTO chat_summary_processed_calls VALUES ('conversation', 'old-call');
      CREATE TABLE call_sessions (id TEXT PRIMARY KEY);
      INSERT INTO call_sessions VALUES ('old-call');
      CREATE TABLE chat_summary_call_segments (
        segment_id TEXT NOT NULL REFERENCES chat_summary_segments(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL, media_mode TEXT NOT NULL, direction TEXT NOT NULL,
        accepted_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_seconds INTEGER NOT NULL,
        ${primaryKey});
      INSERT INTO chat_summary_call_segments VALUES ('old-segment', 'old-call', 'video', 'outgoing', '${now}', '${later}', 3600);
      INSERT INTO chat_summary_call_segments VALUES ('missing-segment', 'old-call', 'video', 'outgoing', '${now}', '${later}', 3600);
      PRAGMA foreign_keys = ON;`);
    const preservedTables = ['chat_summary_segments', 'chat_summary_state', 'chat_summary_processed_calls', 'call_sessions'];
    const before = preservedTables.map((table) => migrationDb.prepare('SELECT * FROM ' + table).all());
    try {
      assert.equal(migrationDb.prepare('PRAGMA foreign_key_check').all().length, 1);
      const { retireChatSummaryCallAssociations } = load('src/platform/persistence/sqlite/chatSummarySchema.ts');
      const migrationExecutor = { execAsync: async (sql) => migrationDb.exec(sql) };
      await retireChatSummaryCallAssociations(migrationExecutor);
      await retireChatSummaryCallAssociations(migrationExecutor);
      assert.deepEqual(preservedTables.map((table) => migrationDb.prepare('SELECT * FROM ' + table).all()), before);
      assert.equal(migrationDb.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_summary_call_segments'").get(), undefined);
      assert.deepEqual(migrationDb.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrationDb.close(); }
  }

  // 清空使在途 claim 失效；进行中通话只保留边界后文字，未接事实不占消息额度。
  await createCall('clear-call');
  await calls.appendEvent({ callId: 'clear-call', chatSessionId: 'call-summary', kind: 'userSpeechText', actorType: 'user', text: '清空前', includeInAIContext: true, createdAt: now });
  const clearCallClaim = await summary.claim('call-summary', 1, 'call-clear', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0);
  await summary.clear('call-summary');
  assert.equal(await appendSummary(clearCallClaim, 'call-zombie', '不能复活', later), false);
  assert.equal((await summaryApplication.getChatSummaryContext('call-summary')).pendingCalls.length, 0);
  const boundaryAt = database.prepare('SELECT cleared_at FROM chat_summary_call_boundary WHERE conversation_id = ?').get('call-summary').cleared_at;
  await createCall('post-clear-call', { state: 'active', endedAt: null });
  const postClearSpeechAt = new Date(Date.parse(boundaryAt) + 1000).toISOString();
  const postClearEndedAt = new Date(Date.parse(boundaryAt) + 2000).toISOString();
  await calls.appendEvent({ callId: 'post-clear-call', chatSessionId: 'call-summary', kind: 'userSpeechText', actorType: 'user', text: '清空前的内容', includeInAIContext: true, createdAt: now });
  await calls.appendEvent({ callId: 'post-clear-call', chatSessionId: 'call-summary', kind: 'userSpeechText', actorType: 'user', text: '清空后的约定', includeInAIContext: true, createdAt: postClearSpeechAt });
  await calls.updateSession('post-clear-call', { state: 'failed', endedAt: postClearEndedAt, endReason: 'runtimeError' });
  const partialCall = (await summaryApplication.getChatSummaryContext('call-summary')).pendingCalls[0];
  assert.deepEqual(partialCall.transcripts.map((item) => item.content), ['清空后的约定']);
  assert.equal(partialCall.historyStartsAfter, boundaryAt);
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }), generateAddition: async () => '清空后约好继续复习。' });
  assert.equal(await summaryApplication.processChatSummary('call-summary', signal), true);
  database.prepare("UPDATE sessions SET visible_after_at = ? WHERE id = 'call-summary'").run(postClearEndedAt);
  assert.equal((await summaryApplication.getChatSummaryContext('call-summary')).segments.length, 1, '清消息保留已有摘要');
  await calls.deleteSession('post-clear-call');
  assert.equal((await summaryApplication.getChatSummaryContext('call-summary')).segments[0].content, '清空后约好继续复习。', '删除通话保留已有摘要正文');
  await createCall('missed-call', { state: 'missed', acceptedAt: null, endedAt: new Date(Date.parse(postClearEndedAt) + 1000).toISOString() });
  const missedContext = await summaryApplication.getChatSummaryContext('call-summary');
  assert.equal(timelineDomain.conversationDialogueStartIndexes(missedContext.timeline).length, 0, '未接通话事实不占消息额度');
  assert.equal(await summaryApplication.processChatSummary('call-summary', signal), false);

  // N 只数对话，应用事件仍按 canonical 顺序进入 raw 和同一摘要事务。
  database.prepare("INSERT INTO chat_conversations (id, kind) VALUES ('events', 'direct')").run();
  database.prepare("INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at) VALUES ('events', 'b', 'B', ?, ?)").run(now, now);
  database.prepare("INSERT INTO conversation_turn_state (session_id, reply_cursor, revision, updated_at) VALUES ('events', 106, 0, ?)").run(now);
  const insertEvent = database.prepare(`INSERT INTO messages (id, session_id, text, is_me, sender_type, created_at, time, status, metadata_json, delivery_status)
    VALUES (?, 'events', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const errorMetadata = { kind: 'error', actorName: 'A' };
  const toolMetadata = { type: 'toolStatus', source: 'chatToolFlow', status: 'failed', toolNames: ['aiCreateMoment'],
    displayNames: ['发布时刻'], displayText: '调用失败：发布时刻', actorName: 'A' };
  const insert = (id, text, sender, metadata = null, status = 'sent', delivery = 'delivered') =>
    insertEvent.run(id, text, sender === 'user' ? 1 : 0, sender, now, now, status, metadata && JSON.stringify(metadata), delivery);
  insert(101, '发个朋友圈', 'user');
  insert(102, 'API Key 无效或已过期', 'system', errorMetadata);
  insert(103, '调用失败：发布时刻', 'system', toolMetadata, 'failed');
  insert(104, '正在调用工具', 'system', { ...toolMetadata, status: 'running' }, 'streaming');
  insert(105, '内部推理', 'reasoning');
  insert(106, '工具调用失败了', 'assistant');
  insert(107, '网络不可用', 'system', errorMetadata);
  insert(108, '现在能听见我吗', 'user');
  insert(109, '未完成回复', 'assistant', null, 'streaming');
  insert(110, '撤销的工具', 'system', toolMetadata, 'failed', 'cancelled');
  insert(111, '其他展示条目', 'system');
  const eventsRaw = (await summary.readContext('events', [108], [])).raw;
  assert.deepEqual(eventsRaw.map((item) => item.messageId), [101, 102, 103, 104, 106, 107]);
  assert.deepEqual(eventsRaw.map((item) => item.kind), ['dialogue', 'app_event', 'app_event', 'app_event', 'dialogue', 'app_event']);
  assert.ok(eventsRaw[1].content.includes('API Key 无效或已过期'));
  assert.ok(eventsRaw[2].content.includes('aiCreateMoment'));
  assert.equal(eventsRaw[3].pending, true, '流式行动进入原文，但尚不能交接给摘要');
  assert.equal(await summary.claim('events', 2, 'pending-activity', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null,
    '摘要不能跨过尚未写完的行动，否则同一行后续增量会被游标吞掉');
  database.prepare("UPDATE messages SET text = ?, status = 'failed', metadata_json = ? WHERE id = 104")
    .run('执行因故障中断，保留已收到的输出', JSON.stringify({ ...toolMetadata, displayText: '执行因故障中断，保留已收到的输出' }));
  assert.equal(await summary.claim('events', 3, 'too-few-dialogues', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null);
  const eventsClaim = await summary.claim('events', 2, 'events-claim', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  assert.deepEqual(eventsClaim.messages.map((item) => item.messageId), [101, 102, 103, 104, 106, 107]);
  assert.ok(eventsClaim.messages[3].content.includes('保留已收到的输出'), '终态后摘要读取同一行的完整已保存内容');
  assert.equal(JSON.parse(buildSummaryInput(eventsClaim)).newMessagesOnly[1].speaker, 'application');
  assert.equal(await appendSummary(eventsClaim, 'events-summary', '曾因认证和网络问题断联，发布时刻工具记录为失败。', later), true);
  const eventsContext = await summary.readContext('events', [], []);
  assert.deepEqual(eventsContext.raw.map((item) => item.messageId), [108]);
  assert.equal(eventsContext.segments[0].messageCount, 2);
  assert.equal(eventsContext.segments[0].batchSize, 2);
  assert.equal(await summary.claim('events', 1, 'pending-current-input', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null);
  await summary.clear('events');
  assert.deepEqual((await summary.readContext('events', [], [])).raw, []);

  // 自主 run 等待首个响应或下一工具时没有流式行，仍不能跨过整个 run。
  database.prepare("INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES ('ongoing-ai', 'ongoing-actor', 'C', 'chat', ?, ?)").run(now, now);
  database.prepare("INSERT INTO chat_conversations (id, kind) VALUES ('ongoing-wake', 'direct')").run();
  database.prepare("INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at) VALUES ('ongoing-wake', 'ongoing-ai', 'C', ?, ?)").run(now, now);
  database.prepare("INSERT INTO conversation_turn_state (session_id, reply_cursor, revision, updated_at) VALUES ('ongoing-wake', 202, 0, ?)").run(now);
  const insertOngoing = database.prepare(`INSERT INTO messages
    (id, session_id, text, is_me, sender_type, created_at, time, status, metadata_json, turn_run_id, turn_item_index)
    VALUES (?, 'ongoing-wake', ?, 0, ?, ?, ?, 'sent', ?, ?, ?)`);
  const wakeMetadata = (phase) => JSON.stringify({ type: 'agentActivity', source: 'chatAgentRun', phase, replyRunId: 'ongoing-run' });
  insertOngoing.run(200, '已开始', 'system', now, now, wakeMetadata('started'), 'ongoing-run', 1);
  insertOngoing.run(201, '完整收到的第一步', 'system', now, now, wakeMetadata('assistant'), 'ongoing-run', 2);
  insertOngoing.run(202, '后来回复的普通聊天', 'assistant', later, later, null, null, null);
  database.prepare(`INSERT INTO messages (id,session_id,text,is_me,sender_type,created_at,time,status,metadata_json,turn_run_id)
    VALUES (205,'events','其他会话的终态',0,'system',?,?,'sent',?,'ongoing-run')`)
    .run(later, later, wakeMetadata('terminal'));
  const ongoingRaw = (await summary.readContext('ongoing-wake', [])).raw;
  assert.deepEqual(ongoingRaw.map(item => [item.messageId, item.pending === true]), [[200, true], [201, true], [202, false]],
    '只保护本会话仍在执行的自主 run，其他会话的终态与普通消息不改变该事实');
  const ongoingGuest = await summary.readBackgroundContexts('ongoing-ai', 'outside', { privateLimit: 10, groupLimit: 0 });
  assert.deepEqual(ongoingGuest.find(item => item.conversationId === 'ongoing-wake').timeline.map(item => item.messageId), [202],
    '召唤读取单聊背景时排除未终结 run，保留普通历史');
  assert.equal(await summary.claim('ongoing-wake', 1, 'waiting-for-next-output', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null,
    '没有 streaming 行时也不能把摘要游标推进到后来的聊天');
  insertOngoing.run(203, '下一步已经收到了', 'system', later, later, wakeMetadata('assistant'), 'ongoing-run', 3);
  insertOngoing.run(204, '执行结束', 'system', later, later,
    JSON.stringify({ ...JSON.parse(wakeMetadata('terminal')), terminalCode: 'COMPLETED' }), 'ongoing-run', 4);
  assert.ok((await summary.readContext('ongoing-wake', [])).raw.every(item => item.pending !== true),
    '本会话终态到达后解除整个自主 run 的保护');
  const finishedWakeClaim = await summary.claim('ongoing-wake', 1, 'finished-wake', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  assert.ok(finishedWakeClaim.messages.some((item) => item.content.includes('下一步已经收到了')),
    '整个 run 到达终态后，追加输出进入同一次摘要交接');
  await summary.releaseClaim(finishedWakeClaim);

  // 图文发送与 AI 分段按逻辑消息计数，应用事件不占额度、不切断同一回复。
  database.prepare("INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES ('logical-ai', 'logical-actor', 'C', 'chat', ?, ?)").run(now, now);
  database.prepare("INSERT INTO chat_conversations (id, kind) VALUES ('logical', 'direct')").run();
  database.prepare("INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at) VALUES ('logical', 'logical-ai', 'C', ?, ?)").run(now, now);
  database.prepare("INSERT INTO conversation_turn_state (session_id, reply_cursor, revision, updated_at) VALUES ('logical', 303, 0, ?)").run(now);
  const insertLogical = database.prepare(`INSERT INTO messages
    (id, session_id, text, is_me, sender_type, created_at, time, status, logical_message_id, metadata_json)
    VALUES (?, 'logical', ?, ?, ?, ?, ?, 'sent', ?, ?)`);
  const logical = (id, sender, identity = null, metadata = null) => insertLogical.run(
    id, '相同正文', sender === 'user' ? 1 : 0, sender, now, now, identity, metadata && JSON.stringify(metadata));
  logical(301, 'user', 'user_submission:images');
  logical(302, 'user', 'user_submission:images');
  logical(303, 'user', 'user_submission:images');
  logical(304, 'assistant', 'reply-segments');
  logical(305, 'system', null, toolMetadata);
  logical(306, 'assistant', 'reply-segments');
  logical(307, 'system', null, errorMetadata);
  logical(308, 'user');
  logical(309, 'user');
  assert.equal(await summary.claim('logical', 3, 'not-enough-logical', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0), null);
  const firstLogical = await summary.claim('logical', 1, 'first-logical', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  assert.deepEqual(firstLogical.messages.map((item) => item.messageId), [301, 302, 303], '批次边界不能切开同次图文发送');
  await summary.releaseClaim(firstLogical);
  database.prepare("UPDATE conversation_turn_state SET reply_cursor = 309 WHERE session_id = 'logical'").run();
  const logicalClaim = await summary.claim('logical', 2, 'logical-claim', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  assert.deepEqual(logicalClaim.messages.map((item) => item.messageId), [301, 302, 303, 304, 305, 306, 307]);
  assert.equal((await summary.readContext('logical', [], [])).raw.length, 9, '生成期间保留每个原始气泡');
  assert.equal(await appendSummary(logicalClaim, 'logical-summary', '整组图文和完整回复的摘要', later), true);
  const logicalContext = await summary.readContext('logical', [], []);
  assert.equal(logicalContext.segments[0].messageCount, 2);
  assert.equal(logicalContext.segments[0].batchSize, 2);
  assert.deepEqual(logicalContext.raw.map((item) => item.messageId), [308, 309]);
  const separateSends = await summary.claim('logical', 2, 'separate-sends', now, "2099-01-01T00:00:00.000Z", 'Asia/Shanghai', 0);
  assert.deepEqual(separateSends.messages.map((item) => item.messageId), [308, 309], '连续发送即使正文相同也各算一条');
  await summary.releaseClaim(separateSends);

  // 单聊保留近期 30 条，只总结更早的整批；交接前后没有原文空窗或摘要与来源重叠。
  {
    database.prepare(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at)
      VALUES ('recent-summary-ai','recent-summary-actor','近期原文测试','chat',?,?)`).run(now, now);
    database.prepare("INSERT INTO chat_conversations (id,kind) VALUES ('recent-summary','direct')").run();
    database.prepare(`INSERT INTO sessions (id,ai_assistant_id,name,created_at,updated_at)
      VALUES ('recent-summary','recent-summary-ai','近期原文测试',?,?)`).run(now, now);
    database.prepare(`INSERT INTO conversation_turn_state (session_id,reply_cursor,revision,updated_at)
      VALUES ('recent-summary',0,0,?)`).run(now);
    const insertRecent = database.prepare(`INSERT INTO messages (session_id,text,is_me,sender_type,created_at,time,status)
      VALUES ('recent-summary',?,?,?,?,?,'sent')`);
    const recentIds = [];
    const addRecentThrough = count => {
      while (recentIds.length < count) {
        const index = recentIds.length;
        const at = new Date(Date.parse(now) + index * 1000).toISOString();
        recentIds.push(Number(insertRecent.run('近期原文 ' + (index + 1), Number(index % 2 === 0),
          index % 2 === 0 ? 'user' : 'assistant', at, at).lastInsertRowid));
      }
      database.prepare("UPDATE conversation_turn_state SET reply_cursor = ? WHERE session_id = 'recent-summary'").run(recentIds.at(-1));
    };
    const generatedRanges = [];
    let batchSize = 30;
    summaryRuntime.configureChatSummaryRuntime({ repository: summary,
      getBatchSettings: async () => ({ batchSize, recentWindowLimit: 30 }),
      generateAddition: async input => {
        generatedRanges.push(input.messages.map(item => item.messageId));
        const during = await summary.readContext('recent-summary', []);
        assert.ok(during.raw.length >= batchSize + 30, '生成期间整批来源与近期原文继续保留');
        return '较早一批的重要记忆 ' + generatedRanges.length;
      },
    });
    addRecentThrough(30);
    assert.equal(await summaryApplication.processChatSummary('recent-summary', signal), false, '聊满近期窗口不立刻摘要清零');
    addRecentThrough(59);
    assert.equal(await summaryApplication.processChatSummary('recent-summary', signal), false, '近期窗口之外不足一批时继续追加');
    addRecentThrough(60);
    assert.equal(await summaryApplication.processChatSummary('recent-summary', signal), true);
    assert.deepEqual(generatedRanges[0], recentIds.slice(0, 30));
    const firstRecent = await summary.readContext('recent-summary', []);
    assert.deepEqual(firstRecent.raw.map(item => item.messageId), recentIds.slice(30));
    assert.equal(firstRecent.contextSegments.length, 1);
    addRecentThrough(89);
    assert.equal(await summaryApplication.processChatSummary('recent-summary', signal), false);
    const growingRecent = await summary.readContext('recent-summary', []);
    assert.deepEqual(growingRecent.raw.slice(0, 30), firstRecent.raw, '批次之间仅向后追加，原文开头保持不变');
    addRecentThrough(90);
    assert.equal(await summaryApplication.processChatSummary('recent-summary', signal), true);
    assert.deepEqual(generatedRanges[1], recentIds.slice(30, 60));
    assert.deepEqual((await summary.readContext('recent-summary', [])).raw.map(item => item.messageId), recentIds.slice(60));
    batchSize = 10;
    addRecentThrough(100);
    assert.equal(await summaryApplication.processChatSummary('recent-summary', signal), true);
    assert.deepEqual(generatedRanges[2], recentIds.slice(60, 70), '摘要批次可独立调整，近期原文仍保留 30 条');
    assert.deepEqual((await summary.readContext('recent-summary', [])).raw.map(item => item.messageId), recentIds.slice(70));
  }

  // 外部 embedding 的响应边界，不使用网络或真实凭据。
  const { BaseAIClient } = load('src/platform/ai/BaseAIClient.ts');
  const client = new BaseAIClient({ baseURL: 'https://example.invalid/v1', apiKey: 'test', model: 'embedding' });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(JSON.parse(options.body).input, 'US 原话');
      return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }) };
    };
    assert.deepEqual((await client.embed('US 原话')).embeddings, [[1, 2]]);
    for (const payload of [null, {}, { data: [] }, { data: [{ index: 1, embedding: [1] }] },
      { data: [{ index: 0, embedding: [NaN] }] }, { data: [{ index: 0, embedding: [0, 0] }] }]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => payload });
      assert.equal((await client.embed('输入')).errorCode, 'invalid_response');
    }
    for (const [status, code] of [[401, 'authentication'], [404, 'model_unavailable'], [429, 'rate_limit'], [503, 'service'], [400, 'configuration']]) {
      globalThis.fetch = async () => ({ ok: false, status, json: async () => ({ error: { message: '外部错误' } }) });
      assert.equal((await client.embed('输入')).errorCode, code);
    }
    globalThis.fetch = async () => { throw new DOMException('取消', 'AbortError'); };
    await assert.rejects(client.embed('输入'), (error) => error.name === 'AbortError');
  } finally { globalThis.fetch = originalFetch; }


  // 两级摘要领取完整阈值批次，独立维护；新来源不使在途旧批次失效。
  database.exec(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at) VALUES ('secondary-ai','secondary-actor','二级测试','chat','${now}','${now}');
    INSERT INTO chat_conversations VALUES ('secondary-test', 'direct');
    INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at) VALUES ('secondary-test', 'secondary-ai', '二级测试', '${now}', '${now}');`);
  const secondarySettings = { generationEnabled: true, injectEnabled: true, fixedMessageId: null, secondaryEnabled: true, secondaryTokenThreshold: 8000, requestTimeoutSeconds: 300, maxOutputTokens: null, modelConfigId: null, groupTriggerCount: 40, primaryLimit: null };
  assert.deepEqual(await summary.readSettings('secondary-test'), secondarySettings);
  for (let index = 1; index <= 5; index++) await summary.create('secondary-test', 'primary-' + index,
    '猫'.repeat(index === 5 ? 1599 : 1600), now, 'Asia/Shanghai');
  assert.equal(await summary.claimSecondary('secondary-test', 'below', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai'), null);
  await summary.create('secondary-test', 'primary-6', '考试'.repeat(500) + '日', now, 'Asia/Shanghai');
  const secondaryClaim = await summary.claimSecondary('secondary-test', 'six', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  assert.deepEqual(secondaryClaim.segments.map(item => item.id), Array.from({length:6}, (_,i) => 'primary-' + (i+1)));
  assert.equal(await summary.claimSecondary('secondary-test', 'loser', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai'), null);
  await summary.create('secondary-test', 'primary-7', '后续'.repeat(300), now, 'Asia/Shanghai');
  assert.equal(await summary.appendSecondary(secondaryClaim, 'secondary-six', '关于猫与考试的重要事件', later), true);
  assert.equal(await summary.appendSecondary(secondaryClaim, 'duplicate', '不能重复提交', later), false);
  let secondarySnapshot = await summary.readContext('secondary-test', []);
  assert.equal(secondarySnapshot.segments.length, 8, '原六批保留在界面');
  assert.deepEqual(secondarySnapshot.contextSegments.map(item => item.id), ['secondary-six', 'primary-7'], '旧归纳放在后来新摘要之前');
  assert.equal(secondarySnapshot.segments.find(item => item.id === 'primary-7').compactionId, null);
  await summary.edit('secondary-test', 'primary-1', '用户改过的猫记录', later);
  await summary.delete('secondary-test', 'primary-6');
  assert.equal((await summary.readContext('secondary-test', [])).contextSegments[0].content, '关于猫与考试的重要事件', '原摘要编辑删除不联动二级正文');
  assert.ok(!(await summary.search('secondary-ai', { keywords: ['考试'] })).entries.some(item => item.id === 'primary-6'));
  assert.ok((await summary.search('secondary-ai', { keywords: ['猫'], from: now, to: later })).entries.some(item => item.id === 'primary-1'), '已归纳原摘要仍可查询');
  assert.equal((await summary.search('b', { keywords: ['猫'] })).entries.length, 0, '工具身份隔离');
  await summary.edit('secondary-test', 'secondary-six', '用户自己修正的二级记录', later);
  await summary.delete('secondary-test', 'secondary-six');
  assert.deepEqual((await summary.readContext('secondary-test', [])).contextSegments.map(item => item.id), ['primary-7'], '删二级不补回或重新注入旧六批');
  await summary.updateSettings('secondary-test', { ...secondarySettings, secondaryEnabled: false });
  assert.equal((await summary.readContext('secondary-test', [])).contextSegments.length, 6, '仅关闭二级恢复现存一级摘要');
  await summary.updateSettings('secondary-test', { ...secondarySettings, secondaryTokenThreshold: 100 });
  let changingClaim = await summary.claimSecondary('secondary-test', 'changing', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  await summary.edit('secondary-test', 'primary-7', '来源变更'.repeat(150), later);
  assert.equal(await summary.appendSecondary(changingClaim, 'stale-edit', '过期结果', later), false);
  await summary.releaseSecondaryClaim(changingClaim);
  changingClaim = await summary.claimSecondary('secondary-test', 'closing', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  await summary.updateSettings('secondary-test', { ...secondarySettings, generationEnabled: false, injectEnabled: false });
  assert.equal(await summary.appendSecondary(changingClaim, 'stale-off', '关闭后不能提交', later), false);
  assert.equal((await summary.readContext('secondary-test', [])).contextSegments.length, 0);
  assert.equal(await summary.claim('secondary-test', 1, 'off-primary', now, later, 'Asia/Shanghai', 0), null);
  assert.equal(await summary.claimSecondary('secondary-test', 'off-secondary', now, later, 'Asia/Shanghai'), null);
  database.exec(`INSERT INTO messages (id,session_id,text,is_me,sender_type,created_at,status) VALUES
    (2001,'secondary-test','已经总结的旧原文',1,'user','${now}','sent'),
    (2002,'secondary-test','最近的助手回复',0,'assistant','${now}','sent'),
    (2003,'secondary-test','最新问题',1,'user','${later}','sent');
    UPDATE chat_summary_state SET processed_cursor='["${now}",2002,0,2002]' WHERE conversation_id='secondary-test';`);
  assert.deepEqual((await summary.readContext('secondary-test', [2003])).raw.map(item => item.messageId), [2001,2002], '关闭绕过旧摘要游标');
  await summary.updateSettings('secondary-test', { ...secondarySettings, secondaryTokenThreshold: 100 });
  assert.deepEqual((await summary.readContext('secondary-test', [2003])).raw, [], '再次开启沿用处理进度');
  changingClaim = await summary.claimSecondary('secondary-test', 'rollback-secondary', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  database.exec(`CREATE TRIGGER reject_secondary_mark BEFORE UPDATE OF compaction_id ON chat_summary_segments
    BEGIN SELECT RAISE(ABORT, '二级交接失败'); END;`);
  await assert.rejects(summary.appendSecondary(changingClaim, 'rollback-content', '不能半交接', later), /二级交接失败/);
  secondarySnapshot = await summary.readContext('secondary-test', []);
  assert.ok(!secondarySnapshot.segments.some(item => item.id === 'rollback-content'));
  assert.equal(secondarySnapshot.segments.find(item => item.id === 'primary-7').compactionId, null);
  database.exec('DROP TRIGGER reject_secondary_mark');
  await summary.releaseSecondaryClaim(changingClaim);
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 99, recentWindowLimit: 0 }),
    generateAddition: async () => { throw new Error('不应该读取原文'); },
    generateSecondary: async () => { throw new (load('src/features/chat/summary/domain/ChatSummaryRepository.ts').ChatSummaryGenerationError)({kind:'request',message:'二级模型失败',retryable:true}); } });
  assert.equal(await summaryApplication.processChatSummary('secondary-test', signal),false);
  assert.deepEqual(withoutTasks(await summary.readContext('secondary-test', [])), withoutTasks(secondarySnapshot), '失败保留原一级摘要上下文');
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 99, recentWindowLimit: 0 }),
    generateAddition: async () => { throw new Error('不应该读取原文'); },
    generateSecondary: async () => { throw new ChatSummaryGenerationError({kind:'empty_output',message:'模型没有返回摘要正文。',retryable:true}); } });
  await retryPending('secondary-test','secondary');
  assert.equal(await summaryApplication.processChatSummary('secondary-test', signal),false);
  assert.deepEqual(withoutTasks(await summary.readContext('secondary-test', [])), withoutTasks(secondarySnapshot), '空正文不交接');
  const secondaryAbort = new AbortController();
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 99, recentWindowLimit: 0 }),
    generateAddition: async () => { throw new Error('不应该读取原文'); },
    generateSecondary: async () => { secondaryAbort.abort(); return '取消不提交'; } });
  await retryPending('secondary-test','secondary');
  assert.equal(await summaryApplication.processChatSummary('secondary-test', secondaryAbort.signal),false);
  assert.deepEqual(withoutTasks(await summary.readContext('secondary-test', [])), withoutTasks(secondarySnapshot));
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 99, recentWindowLimit: 0 }),
    generateAddition: async () => { throw new Error('不应该读取原文'); },
    generateSecondary: async () => '持久归纳' });
  assert.equal(await summaryApplication.processChatSummary('secondary-test', signal), true);
  const retainedSecondary = await summary.readContext('secondary-test', []);
  await summary.create('secondary-test', 'deleted-source', '待删除'.repeat(100), now, 'Asia/Shanghai');
  const deletedSourceClaim = await summary.claimSecondary('secondary-test', 'deleted-source-claim', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  await summary.delete('secondary-test', 'deleted-source');
  assert.equal(await summary.appendSecondary(deletedSourceClaim, 'stale-delete', '不能重新记住已删除来源', later), false);
  await summary.releaseSecondaryClaim(deletedSourceClaim);
  const searchTool = load('src/features/chat/summary/aiTools/SearchChatSummariesTool.ts').SearchChatSummariesTool;
  const searchContext = { task: { assistantId: 'secondary-ai' }, abortSignal: signal };
  const searched = await searchTool.execute({ keywords: ['持久归纳'], from: now }, searchContext);
  assert.equal(searched.status, 'success');
  assert.equal(searched.data.entries.length, 1);
  assert.equal((await searchTool.execute({ from: '无效时间' }, searchContext)).status, 'error');
  await Promise.all([summary.updateSettings('secondary-test', {secondaryTokenThreshold: 200}),
    summary.updateSettings('secondary-test', {secondaryEnabled: false})]);
  assert.deepEqual(await summary.readSettings('secondary-test'), {...secondarySettings,secondaryEnabled:false,secondaryTokenThreshold:200}, '独立字段保存不覆盖其他设置');
  await summary.updateSettings('secondary-test', {secondaryTokenThreshold:100,secondaryEnabled:true});

  // backlog 沿用一条持久摘要任务链：二级在途时新原文只累计，不能并行启动一级。
  database.exec(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at) VALUES ('queue-ai','queue-actor','队列测试','chat','${now}','${now}');
    INSERT INTO chat_conversations VALUES ('queue-summary','direct');
    INSERT INTO sessions (id,ai_assistant_id,name,created_at,updated_at) VALUES ('queue-summary','queue-ai','队列测试','${now}','${now}');
    INSERT INTO conversation_turn_state (session_id,reply_cursor,revision,updated_at) VALUES ('queue-summary',3001,0,'${now}');
    INSERT INTO messages (id,session_id,text,is_me,sender_type,created_at,status) VALUES
      (3001,'queue-summary','第一个问题',1,'user','${now}','sent'),
      (3002,'queue-summary','第一个回复',0,'assistant','${now}','sent');`);
  await summary.create('queue-summary', 'queue-old-primary', '猫'.repeat(7998), now, 'Asia/Shanghai');
  const modelOrder = [];
  let completeSecondary;
  let secondaryStarted;
  const secondaryStartedPromise = new Promise(resolve => { secondaryStarted = resolve; });
  const secondaryResponse = new Promise(resolve => { completeSecondary = resolve; });
  summaryRuntime.configureChatSummaryRuntime({ repository: summary, getBatchSettings: async () => ({ batchSize: 1, recentWindowLimit: 0 }),
    generateAddition: async () => { modelOrder.push('primary'); return '考试'; },
    generateSecondary: async input => { modelOrder.push('secondary');
      assert.equal(input.segments.length,2,'阈值批次包含刚完成的一级摘要');
      secondaryStarted(); return secondaryResponse; } });
  const ongoingSummary = summaryApplication.processChatSummary('queue-summary', signal);
  await secondaryStartedPromise;
  database.exec(`INSERT INTO messages (id,session_id,text,is_me,sender_type,created_at,status) VALUES
      (3003,'queue-summary','二级期间新问题',1,'user','${later}','sent'),
      (3004,'queue-summary','二级期间新回复',0,'assistant','${later}','sent');
    UPDATE conversation_turn_state SET reply_cursor=3003 WHERE session_id='queue-summary';`);
  assert.equal(await summaryApplication.processChatSummary('queue-summary',signal),false,'持久 claim 拒绝并发领取');
  assert.deepEqual(modelOrder,['primary','secondary']);
  assert.ok((await summary.readContext('queue-summary',[])).raw.some(item=>item.messageId===3003),'二级期间新原文保留');
  completeSecondary('重要考试事项');
  assert.equal(await ongoingSummary,true);
  await summaryApplication.processChatSummary('queue-summary',signal);
  await summaryApplication.processChatSummary('queue-summary',signal);
  assert.deepEqual(modelOrder,['primary','secondary','primary','primary'],'继续补一级，累计未再达阈值就不调用二级模型');

  // 固定起点只影响当前 AI，覆盖旧游标但不改它；两级在途结果一起撤销。
  database.exec(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at) VALUES ('fixed-ai','fixed-actor','固定测试','chat','${now}','${now}');
    INSERT INTO chat_conversations VALUES ('fixed-context','direct');
    INSERT INTO sessions (id,ai_assistant_id,name,created_at,updated_at) VALUES ('fixed-context','fixed-ai','固定测试','${now}','${now}');
    INSERT INTO conversation_turn_state (session_id,reply_cursor,revision,updated_at) VALUES ('fixed-context',4008,0,'${now}');`);
  const fixedInsert = database.prepare(`INSERT INTO messages (id,session_id,text,is_me,sender_type,created_at,status,logical_message_id)
    VALUES (?,'fixed-context',?,?,?,'${now}','sent',?)`);
  for (const [id,sender,logicalId] of [[4001,'user',null],[4002,'assistant',null],[4003,'user',null],
    [4004,'assistant','fixed-multi'],[4005,'assistant','fixed-multi'],[4006,'user',null],[4007,'assistant',null],[4008,'user',null]]) {
    fixedInsert.run(id,'固定消息 '+id,Number(sender==='user'),sender,logicalId);
  }
  await summary.create('fixed-context','fixed-old-summary','保留的旧摘要',now,'Asia/Shanghai');
  database.prepare('UPDATE chat_summary_state SET processed_cursor=? WHERE conversation_id=?').run(JSON.stringify([now,4005,0,4005]),'fixed-context');
  const otherSettings = await summary.readSettings('secondary-test');
  const priorCursor = database.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='fixed-context'").get().processed_cursor;
  const staleFixedPrimary = await summary.claim('fixed-context',1,'before-fixing',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
  await summary.setFixedStart('fixed-context',4004);
  assert.equal(await appendSummary(staleFixedPrimary,'stale-fixed-primary','不应提交',later),false);
  const fixedContext = await summary.readContext('fixed-context',[4008]);
  assert.deepEqual(fixedContext.raw.map(item=>item.messageId),[4004,4005,4006,4007],'含选中气泡，恢复已总结原文，保护当前输入');
  assert.deepEqual(fixedContext.fixedStart,{messageId:4004,content:'固定消息 4004',messageCount:4},'分段计一次，界面计数包含最新输入');
  assert.equal(fixedContext.contextSegments[0].content,'保留的旧摘要');
  assert.equal(fixedContext.settings.generationEnabled,false);
  assert.deepEqual(await summary.readSettings('secondary-test'),otherSettings,'另一个 AI 的开关不变');
  assert.equal(await summary.claim('fixed-context',1,'blocked-fixed',now,later,'Asia/Shanghai', 0),null);
  assert.equal(await summary.claimSecondary('fixed-context','blocked-secondary',now,later,'Asia/Shanghai'),null);
  await assert.rejects(summary.updateSettings('fixed-context',{generationEnabled:true}),/取消固定/);
  await assert.rejects(summary.setFixedStart('fixed-context',2001),/当前会话/);
  await summary.updateSettings('fixed-context',{injectEnabled:false});
  assert.deepEqual((await summary.readContext('fixed-context',[])).contextSegments,[]);
  await summary.setFixedStart('fixed-context',null);
  assert.equal((await summary.readSettings('fixed-context')).injectEnabled,false);
  assert.equal((await summary.readSettings('fixed-context')).generationEnabled,false,'取消固定不恢复生成');
  assert.equal(database.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='fixed-context'").get().processed_cursor,priorCursor);
  await summary.updateSettings('fixed-context',{generationEnabled:true});
  const resumed = await summary.claim('fixed-context',1,'resumed-original-cursor',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
  assert.deepEqual(resumed.messages.map(item=>item.messageId),[4006],'从原摘要进度继续，不从曾固定的 4004 重来');
  assert.ok(resumed.previous.some(item=>item.id==='fixed-old-summary'),'不注入摘要也不影响生成的只读背景');
  await appendSummary(resumed,'fixed-resumed-summary','续接原进度',later);
  const nextResumed = await summary.claim('fixed-context',1,'resumed-next-batch',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
  assert.deepEqual(nextResumed.messages.map(item=>item.messageId),[4007],'积压继续分批');
  await appendSummary(nextResumed,'fixed-next-summary','下一批',later);
  await summary.updateSettings('fixed-context',{secondaryTokenThreshold:1});
  const staleFixedSecondary = await summary.claimSecondary('fixed-context','secondary-before-fixed',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
  await summary.setFixedStart('fixed-context',4005);
  assert.equal(await summary.appendSecondary(staleFixedSecondary,'stale-fixed-secondary','不能交接',later),false);
  database.prepare("UPDATE messages SET text='用户修改了起点' WHERE id=4005").run();
  assert.equal((await summary.readContext('fixed-context',[])).fixedStart.content,'用户修改了起点','预览读取当前正文');
  const cursorAfterResume = database.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='fixed-context'").get().processed_cursor;
  database.prepare('DELETE FROM messages WHERE id=4005').run();
  const deletedFixed = await summary.readSettings('fixed-context');
  assert.equal(deletedFixed.fixedMessageId,null,'删除路径由外键统一取消固定');
  assert.equal(deletedFixed.generationEnabled,false);
  assert.equal(deletedFixed.injectEnabled,false);
  assert.equal(database.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='fixed-context'").get().processed_cursor,cursorAfterResume);
  await summary.setFixedStart('fixed-context',4007);
  const fixedSummaries = (await summary.readContext('fixed-context',[])).segments;
  const { sessionRepository } = load('src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts');
  await sessionRepository.clearConversationHistory('fixed-context');
  const clearedFixed = await summary.readContext('fixed-context',[]);
  assert.equal(clearedFixed.fixedStart,null,'清空删除原文并取消固定');
  assert.deepEqual(clearedFixed.raw,[]);
  assert.deepEqual(clearedFixed.segments,fixedSummaries,'清空保留旧摘要');
  assert.equal(clearedFixed.settings.generationEnabled,false);
  await assert.rejects(summary.setFixedStart('fixed-context',4007),/当前会话/);
  await summary.setFixedStart('logical',308);
  const retainedFixed = await summary.readContext('logical',[]);

  // 两级共用首次请求加一次自动重试的预算；失败状态持久化，手动仍只执行一次。
  database.exec(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at) VALUES ('retry-ai','retry-actor','重试测试','chat','${now}','${now}');
    INSERT INTO chat_conversations VALUES ('retry-summary','direct');
    INSERT INTO sessions (id,ai_assistant_id,name,created_at,updated_at) VALUES ('retry-summary','retry-ai','重试测试','${now}','${now}');
    INSERT INTO conversation_turn_state (session_id,reply_cursor,revision,updated_at) VALUES ('retry-summary',5001,0,'${now}');
    INSERT INTO messages (id,session_id,text,is_me,sender_type,created_at,status) VALUES (5001,'retry-summary','尚未总结的原文',1,'user','${now}','sent');`);
  await summary.updateSettings('retry-summary',{secondaryTokenThreshold:1});
  await summary.create('retry-summary','retry-source','待归纳',now,'Asia/Shanghai');
  const retryFailure={kind:'timeout',message:'请求超过 300 秒',retryable:true};
  let retryAt=now, retryTaskId;
  for(let attempt=1;attempt<=2;attempt++) {
    const current=await summary.claimSecondary('retry-summary','auto-'+attempt,retryAt,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
    assert.ok(current);retryTaskId=current.taskId;
    await summary.recordInvocation(current,{model:'chat',requestedMaxTokens:100,timeoutSeconds:300,durationMs:300000,
      promptTokens:null,completionTokens:null,totalTokens:null,cachedTokens:null,finishReason:null,contentCharacters:0,reasoningCharacters:0,serverError:null},retryAt);
    await summary.failTask(current,retryFailure,retryAt);await summary.releaseSecondaryClaim(current);
    const task=(await summary.readContext('retry-summary',[])).tasks.find(value=>value.id===retryTaskId);
    assert.equal(task.automaticFailures,attempt);
    if(attempt<2) {
      assert.equal(task.status,'waiting');
      assert.equal(Date.parse(task.nextAttemptAt)-Date.parse(retryAt),120000);
      assert.equal(await summary.claimSecondary('retry-summary','too-early',retryAt,'2099-01-01T00:00:00.000Z','Asia/Shanghai'),null);
      retryAt=task.nextAttemptAt;
    } else {assert.equal(task.status,'failed');assert.equal(task.nextAttemptAt,null);}
  }
  assert.equal(await summary.claimSecondary('retry-summary','third-auto',later,'2099-01-01T00:00:00.000Z','Asia/Shanghai'),null,'第一次加一次自动重试后不再请求');
  await summary.create('retry-summary','new-does-not-reset','新摘要',later,'Asia/Shanghai');
  assert.equal(await summary.claimSecondary('retry-summary','new-auto',later,'2099-01-01T00:00:00.000Z','Asia/Shanghai'),null,'新消息或新一级不会解除失败暂停');
  const primaryWhileSecondaryFailed=await summary.claim('retry-summary',1,'other-level',later,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
  assert.ok(primaryWhileSecondaryFailed,'二级失败不阻止一级');
  await summary.failTask(primaryWhileSecondaryFailed,retryFailure,later);await summary.releaseClaim(primaryWhileSecondaryFailed);
  const primaryRetryAt=(await summary.readContext('retry-summary',[])).tasks.find(value=>value.id===primaryWhileSecondaryFailed.taskId).nextAttemptAt;
  const primaryRetry=await summary.claim('retry-summary',1,'primary-auto-retry',primaryRetryAt,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
  assert.ok(primaryRetry);await summary.failTask(primaryRetry,retryFailure,primaryRetryAt);await summary.releaseClaim(primaryRetry);
  assert.equal(await summary.claim('retry-summary',1,'primary-third-auto','2098-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','Asia/Shanghai', 0),null,'一级也只允许一次自动重试');

  // 更新前留下的第三次等待与过期在途请求收口，不刷新次数，不影响手动意图。
  database.prepare("UPDATE chat_summary_tasks SET status='waiting',next_attempt_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(retryTaskId);
  database.prepare("UPDATE chat_summary_tasks SET status='running' WHERE id=?").run(primaryWhileSecondaryFailed.taskId);
  database.prepare("UPDATE chat_summary_state SET claim_id='old-process',claim_expires_at='2099-01-01T00:00:00.000Z' WHERE conversation_id='retry-summary'").run();
  assert.deepEqual(await summaryApplication.prepareChatSummaryConversations(['conversation', 'already-deleted']), ['conversation'], '定向维护只返回仍存在的目标会话');
  assert.deepEqual(await summaryApplication.prepareChatSummaryConversations([]), [], '空范围不能退化为全量扫描');
  assert.equal((await summary.readContext('retry-summary',[])).tasks.find(task=>task.id===retryTaskId).status, 'waiting', '定向维护不收口范围外任务');
  await summaryApplication.prepareChatSummaryConversations();
  assert.equal((await summary.readContext('retry-summary',[])).tasks.find(task=>task.id===primaryWhileSecondaryFailed.taskId).status,'running','准备阶段不撤销仍有效的在途 claim');
  database.prepare("UPDATE chat_summary_state SET claim_expires_at=? WHERE conversation_id='retry-summary'").run(now);
  await summaryApplication.prepareChatSummaryConversations();
  let paused=(await summary.readContext('retry-summary',[])).tasks;
  assert.ok(paused.every(task=>task.status==='failed' && task.nextAttemptAt===null && task.automaticFailures===2),'旧版本已经失败两次的任务直接暂停，不补第三次请求');
  await summary.retryTask('retry-summary',retryTaskId,later);
  await summaryApplication.prepareChatSummaryConversations();
  assert.equal((await summary.readContext('retry-summary',[])).tasks.find(task=>task.id===retryTaskId).status,'waiting','队列准备保留用户的手动重试意图');
  await assert.rejects(summary.retryTask('secondary-test',retryTaskId,later),/不能重试/,'跨 AI 不能重试任务');
  await summary.updateSettings('retry-summary',{secondaryTokenThreshold:8000});
  await summary.retryTask('retry-summary',retryTaskId,later);
  const cancelledManual=await summary.claimSecondary('retry-summary','manual-cancelled',later,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
  assert.ok(cancelledManual,'提高触发阈值后仍允许明确手动重试');
  await summary.releaseSecondaryClaim(cancelledManual);
  const interruptedManual=await summary.claimSecondary('retry-summary','manual-interrupted',later,later,'Asia/Shanghai');
  assert.ok(interruptedManual,'取消恢复保留手动重试意图');
  await summaryApplication.prepareChatSummaryConversations();
  assert.equal((await summary.readContext('retry-summary',[])).tasks.find(task=>task.id===retryTaskId).status,'running','手动请求中断后仍可恢复，不被自动预算收口');
  const manual=await summary.claimSecondary('retry-summary','manual-once',later,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
  assert.ok(manual,'运行中断、租期到期后仍恢复手动意图');await summary.failTask(manual,retryFailure,later);await summary.releaseSecondaryClaim(manual);
  assert.equal((await summary.readContext('retry-summary',[])).tasks.find(value=>value.id===retryTaskId).status,'failed','手动失败不自动开启新循环');
  await summary.updateSettings('retry-summary',{maxOutputTokens:4000,secondaryTokenThreshold:1});
  const recovered=await summary.claimSecondary('retry-summary','config-repaired',later,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
  assert.ok(recovered,'修改请求配置后重新检查');
  await summary.recordInvocation(recovered,{model:'chat',requestedMaxTokens:4000,timeoutSeconds:300,durationMs:1000,
    promptTokens:80,completionTokens:20,totalTokens:100,cachedTokens:40,finishReason:'stop',contentCharacters:8,reasoningCharacters:12,serverError:null},later);
  assert.equal(await summary.appendSecondary(recovered,'retry-result','完成的二级摘要',later),true);
  const retainedRetry=(await summary.readContext('retry-summary',[])).tasks.find(value=>value.id===retryTaskId);
  assert.equal(retainedRetry.status,'completed');assert.deepEqual(retainedRetry.segmentIds,['retry-result']);
  assert.equal(retainedRetry.calls.at(-1).totalTokens,100);
  assert.equal(retainedRetry.error.message,retryFailure.message,'成功后保留最近错误供调试');
  assert.equal(retainedRetry.error.occurredAt,later,'成功时间不覆盖失败发生时间');

  // 集中编辑原子合并二级正文和来源关联；不改调用事实，不覆盖编辑期间新生成的摘要。
  database.exec(`INSERT INTO ai_assistants (id,agent_id,name,model,created_at,updated_at) VALUES ('merge-ai','merge-actor','合并测试','chat','${now}','${now}');
    INSERT INTO chat_conversations VALUES ('merge-summary','direct');
    INSERT INTO sessions (id,ai_assistant_id,name,created_at,updated_at) VALUES ('merge-summary','merge-ai','合并测试','${now}','${now}');`);
  await summary.updateSettings('merge-summary',{secondaryTokenThreshold:1});
  const mergeDiagnostics={model:'chat',requestedMaxTokens:4000,timeoutSeconds:300,durationMs:1000,
    promptTokens:80,completionTokens:20,totalTokens:100,cachedTokens:40,finishReason:'stop',contentCharacters:8,reasoningCharacters:0,serverError:null};
  for(let index=1;index<=2;index++) {
    await summary.create('merge-summary','merge-p'+index,'来源'+index,now,'Asia/Shanghai');
    const claim=await summary.claimSecondary('merge-summary','merge-claim'+index,now,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
    await summary.recordInvocation(claim,mergeDiagnostics,now);
    assert.equal(await summary.appendSecondary(claim,'merge-s'+index,'独立归纳'+index,now),true);
  }
  database.exec(`UPDATE chat_summary_segments SET source_start_at='2026-10-01T00:00:00.000Z',source_end_at='2026-10-02T00:00:00.000Z' WHERE id='merge-s1';
    UPDATE chat_summary_segments SET source_start_at='2026-10-03T00:00:00.000Z',source_end_at='2026-10-04T00:00:00.000Z' WHERE id='merge-s2';`);
  await summary.create('merge-summary','merge-p3','之后的新来源',later,'Asia/Shanghai');
  const newCompaction=await summary.claimSecondary('merge-summary','merge-inflight',later,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
  const beforeMerge=await summary.readContext('merge-summary',[]);
  const mergeOriginals=beforeMerge.segments.filter(segment=>segment.level==='secondary');
  database.exec("CREATE TRIGGER reject_summary_merge BEFORE DELETE ON chat_summary_segments WHEN OLD.id='merge-s2' BEGIN SELECT RAISE(ABORT,'合并交接失败'); END;");
  await assert.rejects(summary.replaceSecondary('merge-summary',mergeOriginals,'不能半合并',later),/合并交接失败/);
  assert.deepEqual(await summary.readContext('merge-summary',[]),beforeMerge,'合并失败时正文、来源、进度与任务全部回滚');
  database.exec('DROP TRIGGER reject_summary_merge');
  await assert.rejects(summary.replaceSecondary('retry-summary',mergeOriginals,'不能越界',later),/二级摘要已更新/);
  await summary.replaceSecondary('merge-summary',mergeOriginals,'统一编辑'.repeat(200),later);
  let mergedSnapshot=await summary.readContext('merge-summary',[]);
  let merged=mergedSnapshot.segments.filter(segment=>segment.level==='secondary');
  assert.equal(merged.length,1);assert.equal(merged[0].content,'统一编辑'.repeat(200),'手动编辑二级没有一级自动摘要的字数上限');
  assert.equal(merged[0].sourceStartAt,'2026-10-01T00:00:00.000Z');assert.equal(merged[0].sourceEndAt,'2026-10-04T00:00:00.000Z');
  assert.deepEqual(mergedSnapshot.segments.filter(segment=>segment.level==='primary').map(segment=>[segment.id,segment.compactionId,segment.content]),
    [['merge-p1','merge-s1','来源1'],['merge-p2','merge-s1','来源2'],['merge-p3',null,'之后的新来源']]);
  assert.deepEqual(mergedSnapshot.tasks,beforeMerge.tasks,'合并不重写模型的调用用量与完成事实');
  assert.ok(!(await summary.search('merge-ai',{keywords:['独立归纳2']})).entries.some(segment=>segment.id==='merge-s2'),'被合并替换的正文不从搜索中返回');
  assert.equal(await summary.appendSecondary(newCompaction,'merge-s3','之后生成的新归纳',later),true,'集中编辑不撤销仍在处理其他来源的归纳');
  const afterNewCompaction=await summary.readContext('merge-summary',[]);
  await assert.rejects(summary.replaceSecondary('merge-summary',merged,'过期编辑',later),/二级摘要已更新/);
  assert.deepEqual(await summary.readContext('merge-summary',[]),afterNewCompaction,'拒绝覆盖编辑期间新生成的二级摘要');
  await summary.replaceSecondary('merge-summary',afterNewCompaction.segments.filter(segment=>segment.level==='secondary'),'重新统一编辑',later);
  mergedSnapshot=await summary.readContext('merge-summary',[]);
  assert.ok(mergedSnapshot.segments.filter(segment=>segment.level==='primary').every(segment=>segment.compactionId==='merge-s1'));
  await summary.delete('merge-summary','merge-p1');
  assert.ok(!(await summary.search('merge-ai',{keywords:['来源1']})).entries.some(segment=>segment.id==='merge-p1'),'手动删除合并来源后不可搜索');
  const retainedMerged=await summary.readContext('merge-summary',[]);
  await summary.replaceSecondary('merge-summary',retainedMerged.segments.filter(segment=>segment.level==='secondary'),null,later);
  const deletedMerged=await summary.readContext('merge-summary',[]);
  assert.deepEqual(deletedMerged.contextSegments,[],'删除二级正文不会恢复原摘要注入');
  assert.equal(deletedMerged.segments.length,2,'已归纳来源仍留在二级页面可查看');
  assert.deepEqual(deletedMerged.tasks,retainedMerged.tasks,'删除正文保留调用历史');

  // 定向清旧不触及模型资产、业务选择与正文；事务失败完整回滚。
  database.exec(`CREATE TABLE memory_topics (id TEXT PRIMARY KEY); INSERT INTO memory_topics VALUES ('legacy');
    INSERT INTO auxiliary_model_configs (id, capability_kind, name, base_url, model, created_at, updated_at) VALUES ('retired-asset', 'memory_admin', '保留模型', 'https://example.invalid', 'm', '${now}', '${now}');
    UPDATE memory_model_settings SET embedding_model_config_id = 'retained-choice';
    CREATE TRIGGER reject_prompt_cleanup BEFORE DELETE ON assistant_prompt_definition_states BEGIN SELECT RAISE(ABORT, '注入升级失败'); END;
    INSERT INTO assistant_prompt_definition_states (assistant_id, definition_id, enabled, updated_at) VALUES ('a', 'context.recent_memory_capsules', 1, '${now}');`);
  await assert.rejects(migrateMemoryV3(raw), /注入升级失败/);
  assert.ok(database.prepare("SELECT id FROM memory_topics WHERE id = 'legacy'").get());
  database.exec('DROP TRIGGER reject_prompt_cleanup');
  await migrateMemoryV3(raw);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_topics'").get(), undefined);
  assert.ok(database.prepare("SELECT id FROM auxiliary_model_configs WHERE id = 'retired-asset'").get());
  assert.equal((await repository.getEmbeddingSettings()).modelConfigId, 'retained-choice');
  await summary.create('conversation', 'durable-summary', '长期保留的摘要', now, 'Asia/Shanghai');
  // 群摘要沿用两级交接与generation；背景读取按每群额度，不改变来源处理状态。
  for (const id of ['context-group-a','context-group-b']) {
    database.prepare("INSERT INTO chat_conversations VALUES (?,'group')").run(id);
    database.prepare('INSERT INTO group_chats(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id,id,now,now);
    database.prepare('INSERT INTO group_chat_members(id,group_id,ai_assistant_id,agent_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id+'-member',id,'a','actor-a',now,now);
    database.prepare('INSERT INTO group_speech_plans(id,group_id,status,last_included_message_id,created_at,updated_at) VALUES (?,?,?,99999,?,?)').run(id+'-plan',id,'completed',now,now);
    for (let index=0;index<4;index++) database.prepare('INSERT INTO messages(id,session_id,text,is_me,sender_type,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run((id.endsWith('a')?80000:80010)+index,id,'群讨论'+index,index%2===0?1:0,index%2===0?'user':'assistant',
        JSON.stringify({actorAIId:'a',actorAgentId:'actor-a',actorName:'公开名称'}),now);
  }
  await summary.updateSettings('context-group-a',{groupTriggerCount:2});
  const groupClaim=await summary.claim('context-group-a',99,'group-claim',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
  assert.ok(groupClaim);
  assert.equal(groupClaim.batchSize,2,'群门槛只取群设置，不使用管理员或成员窗口');
  assert.equal(groupClaim.messages[1].actor.assistantId,'a');
  const groupSourceIds=groupClaim.messages.map(item=>item.messageId);
  await summary.updateSettings('context-group-a',{modelConfigId:'continuous-reference',groupTriggerCount:2});
  assert.equal(await appendSummary(groupClaim,'late-group','旧模型结果',later),false,'切换模型撤销旧任务资格');
  const freshGroup=await summary.claim('context-group-a',2,'fresh-group',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
  assert.equal(freshGroup.requestSettings.modelConfigId,'continuous-reference','请求选择来自领取事务');
  assert.deepEqual(freshGroup.messages.map(item=>item.messageId),groupSourceIds,'切换不回退或丢失处理范围');
  assert.equal(await appendSummary(freshGroup,'group-primary','个人分歧与共同分工',later),true);
  await summary.updateSettings('context-group-a',{secondaryTokenThreshold:1});
  const groupSecondary=await summary.claimSecondary('context-group-a','group-secondary-claim',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai');
  assert.ok(groupSecondary);
  assert.equal(await summary.appendSecondary(groupSecondary,'group-secondary','群共识与未完成分工',later),true);
  const beforeGuest=database.prepare("SELECT * FROM chat_summary_state WHERE conversation_id='context-group-a'").get();
  let guest=await summary.readBackgroundContexts('a','not-a-source',{privateLimit:0,groupLimit:2,upperBound:{messageId:80012,createdAt:later}});
  assert.deepEqual(guest.map(item=>item.conversationId),['context-group-a','context-group-b']);
  assert.deepEqual(guest.map(item=>item.timeline.length),[2,2],'每群单独窗口，并排除执行上界后的消息');
  assert.equal(guest[0].contextSegments[0].id,'group-secondary');
  assert.deepEqual(database.prepare("SELECT * FROM chat_summary_state WHERE conversation_id='context-group-a'").get(),beforeGuest,'客视角不推进或改写摘要状态');
  assert.deepEqual(await summary.readBackgroundContexts('a','not-a-source',{privateLimit:0,groupLimit:0}),[],'0不带入原文或摘要');
  guest=await summary.readBackgroundContexts('a','context-group-a',{privateLimit:0,groupLimit:2});
  assert.deepEqual(guest.map(item=>item.conversationId),['context-group-b'],'当前群不能重复注入');
  await summary.updateSettings('context-group-a',{injectEnabled:false});
  guest=await summary.readBackgroundContexts('a','not-a-source',{privateLimit:0,groupLimit:2});
  assert.equal(guest[0].contextSegments.length,0,'客窗口遵循来源注入开关');
  assert.equal(guest[0].timeline.length,2);
  database.prepare("UPDATE group_chat_members SET enabled=0 WHERE group_id='context-group-b'").run();
  guest=await summary.readBackgroundContexts('a','not-a-source',{privateLimit:0,groupLimit:2});
  assert.deepEqual(guest.map(item=>item.conversationId),['context-group-a'],'退出后不再带入');
  assert.equal((await summary.search('b',{conversationId:'context-group-a'})).entries.length,0,'未参加群的AI不能查询共享摘要');
  assert.ok((await summary.search('a',{conversationId:'context-group-a'})).entries.some(item=>item.id==='group-secondary'));
  const groupCursor=database.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='context-group-a'").get().processed_cursor;
  await summary.updateSettings('context-group-a',{modelConfigId:null});
  assert.equal(database.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='context-group-a'").get().processed_cursor,groupCursor);
  assert.equal((await summary.readContext('context-group-a',[])).segments.length,2,'切换保留两级正文');

  // 群读取自己单聊的客窗口，不能读取其他角色的私聊；固定起点不替代客近期范围。
  database.exec(`INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('guest-owner','guest-agent','客来源','chat','${now}','${now}');
    INSERT INTO chat_conversations VALUES ('private-guest','direct');
    INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('private-guest','guest-owner','客来源','${now}','${now}');
    INSERT INTO conversation_turn_state(session_id,reply_cursor,revision,updated_at) VALUES ('private-guest',90003,0,'${now}');`);
  for (let index=1; index<=3; index++) database.prepare('INSERT INTO messages(id,session_id,text,is_me,sender_type,created_at) VALUES (?,?,?,?,?,?)')
    .run(90000+index,'private-guest','私聊背景'+index,index===1?1:0,index===1?'user':'assistant',now);
  await summary.create('private-guest','private-guest-summary','自己的摘要',now,'Asia/Shanghai');
  await summary.setFixedStart('private-guest',90003);
  let privateGuest=await summary.readBackgroundContexts('guest-owner','context-group-a',{privateLimit:2,groupLimit:0,upperBound:{messageId:90002,createdAt:later}});
  assert.deepEqual(privateGuest.map(item=>item.conversationId),['private-guest']);
  assert.deepEqual(privateGuest[0].timeline.map(item=>item.messageId),[90001,90002],'客窗口按近期原文与执行上界读取，不被来源固定起点截掉');
  assert.equal(privateGuest[0].contextSegments[0].id,'private-guest-summary');
  assert.equal((await summary.readBackgroundContexts('b','context-group-a',{privateLimit:2,groupLimit:0})).some(item=>item.conversationId==='private-guest'),false,'其他AI不能自动读取此单聊');
  await summary.updateSettings('private-guest',{injectEnabled:false});
  privateGuest=await summary.readBackgroundContexts('guest-owner','context-group-a',{privateLimit:2,groupLimit:0});
  assert.equal(privateGuest[0].contextSegments.length,0);
  assert.equal(privateGuest[0].timeline.length,2);
  assert.deepEqual(await summary.readBackgroundContexts('guest-owner','context-group-a',{privateLimit:0,groupLimit:0}),[]);

  // 工具操作同一份二级正文：全文与局部替换、身份隔离及失败原子性。
  const { GetSecondarySummaryTool, EditSecondarySummaryTool, EditPrimarySummaryTool, DeletePrimarySummaryTool } = load('src/features/chat/summary/aiTools/ChatSummaryTools.ts');
  const { matchesAgentToolInputSchema } = load('src/shared/aiTools/AgentToolInputSchema.ts');
  const editSchema = EditSecondarySummaryTool.definition.parameters;
  assert.equal(matchesAgentToolInputSchema({ mode: 'replace_text', oldText: '原文', newText: '' }, editSchema), true);
  for (const invalid of [
    { mode: 'unknown', oldText: '原文', newText: '新文' },
    { mode: 'replace_all', oldText: '原文' },
    { mode: 'replace_text', oldText: '', newText: '新文' },
    { mode: 'replace_all', oldText: '原文', newText: '新文', assistantId: 'other-ai' },
  ]) assert.equal(matchesAgentToolInputSchema(invalid, editSchema), false, '参数边界拒绝非法模式、缺字段与伪造身份');
  database.exec(`INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('tool-ai','tool-actor','摘要工具','chat','${now}','${now}');
    INSERT INTO chat_conversations VALUES ('tool-summary','direct');
    INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('tool-summary','tool-ai','摘要工具','${now}','${now}');`);
  const editContext = { task: { assistantId: 'tool-ai', sessionId: 'tool-summary' }, abortSignal: signal };
  assert.deepEqual((await GetSecondarySummaryTool.execute({}, editContext)).data, { conversationId: 'tool-summary', content: '' });
  const emptyEdit = { mode: 'replace_all', oldText: '不存在', newText: '不能新建' };
  assert.equal((await EditSecondarySummaryTool.execute(emptyEdit, editContext)).status, 'error');
  await summary.updateSettings('tool-summary', { secondaryTokenThreshold: 1 });
  for (let index = 1; index <= 2; index++) {
    await summary.create('tool-summary', 'tool-p' + index, '来源' + index, now, 'Asia/Shanghai');
    const claim = await summary.claimSecondary('tool-summary', 'tool-claim' + index, now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
    await summary.appendSecondary(claim, 'tool-s' + index, '共同前缀，事件' + index, now);
  }
  await summary.updateSettings('tool-summary', { generationEnabled: false, injectEnabled: false, secondaryEnabled: false });
  const toolOriginal = await summary.readContext('tool-summary', []);
  const fullText = '共同前缀，事件1\n\n共同前缀，事件2';
  assert.equal((await GetSecondarySummaryTool.execute({}, editContext)).data.content, fullText, '完整读取独立于注入与生成开关');

  // 使用真实协调器覆盖错误包装边界，不能让简化事务 fixture 掩盖业务错误类型丢失。
  const realFixture = createCoordinatedSqliteFixture(raw);
  const { diagnostics } = realFixture;
  const { AgentToolExecutor } = load('src/platform/agentRuntime/AgentToolExecutor.ts', {
    '@shared/aiTools': { matchesAgentToolInputSchema },
  });
  const summaryTools = [GetSecondarySummaryTool, EditSecondarySummaryTool, EditPrimarySummaryTool, DeletePrimarySummaryTool,
    nativeTools.RememberMemoryTool, nativeTools.UpdateMemoryTool];
  const summaryToolExecutor = new AgentToolExecutor({
    get: name => {
      const tool = summaryTools.find(item => item.name === name);
      return { descriptor: { name, inputSchema: tool.definition.parameters }, execute: tool.execute };
    },
  });
  const runtimeContext = {
    ...editContext, runId: 'summary-error-run',
    task: { ...editContext.task, id: 'summary-error-task', allowedToolNames: summaryTools.map(tool => tool.name) },
  };
  const executeSummaryTool = (tool, input, context = runtimeContext) => summaryToolExecutor.execute(
    summaryToolExecutor.prepare({ id: 'summary-error-call', name: tool.name, arguments: JSON.stringify(input) }, context.task),
    context,
  );
  const previousOpenTaskExecutor = coordinator.openTaskExecutor;
  const realCoordinator = realFixture.databaseCoordinator;
  coordinator.openTaskExecutor = meta => realCoordinator.openTaskExecutor(meta);
  const previousConsoleError = console.error;
  const toolErrorLogs = [];
  const failedEditEvents = [];
  const unsubscribeFailedEdits = summaryRuntime.subscribeChatSummaryChanged(id => failedEditEvents.push(id));
  console.error = (...args) => toolErrorLogs.push(args);
  try {
    for (const [tool, input, message] of [
      [EditSecondarySummaryTool, { mode: 'replace_all', oldText: '过期原文', newText: '不能覆盖' }, '摘要原文不匹配或已变化，请重新读取后再编辑'],
      [EditSecondarySummaryTool, { mode: 'replace_text', oldText: '共同前缀', newText: '不能猜测' }, '原文片段有多处匹配，请提供更长且唯一的片段'],
      [EditPrimarySummaryTool, { segmentId: 'tool-p1', mode: 'replace_all', oldText: '过期原文', newText: '不能覆盖' }, '摘要原文不匹配或已变化，请重新读取后再编辑'],
      [DeletePrimarySummaryTool, { segmentId: 'tool-p1', expectedContent: '过期原文' }, '一级摘要已变化，请重新查询后再删除'],
      [GetSecondarySummaryTool, { conversationId: 'missing-conversation' }, '来源会话不存在或当前 AI 无权访问'],
    ]) {
      const outcome = await executeSummaryTool(tool, input);
      assert.deepEqual(outcome, { status: 'error', code: 'CHAT_SUMMARY_EDIT_ERROR', retryable: false, modelContent: message },
        '业务拒绝穿过真实事务与工具执行器后仍向模型提供具体原因');
    }
    assert.equal(toolErrorLogs.length, 0, '可预期的摘要业务拒绝不触发开发版红色错误日志');
    assert.equal(diagnostics.filter(event => event.outcome === 'rolled_back').length, 5, '业务拒绝仍回滚并保留事务诊断');

    const memoryContext = { ...runtimeContext, runId: 'memory-error-run', toolCallId: 'memory-error-call',
      task: { ...runtimeContext.task, assistantId: 'a' } };
    const deletedWriteKey = JSON.stringify([memoryContext.runId, memoryContext.toolCallId]);
    await create('deleted-error-memory', '用户将删除的记忆', now, 'pool-a', deletedWriteKey);
    await repository.deleteEntry('pool-a', 'deleted-error-memory');
    const memoryRowsBefore = database.prepare('SELECT * FROM memory_items ORDER BY id').all();
    for (const [tool, input] of [
      [nativeTools.UpdateMemoryTool, { memoryId: 'missing-error-memory', content: '不能更新不存在的记忆' }],
      [nativeTools.RememberMemoryTool, { content: '不能用回执恢复用户删除的记忆' }],
    ]) {
      assert.deepEqual(await executeSummaryTool(tool, input, memoryContext), {
        status: 'error', code: 'MEMORY_INPUT_ERROR', retryable: false, modelContent: '当前记忆空间中不存在这条记忆',
      });
    }
    await assert.rejects(repository.getEntryByWriteKey('pool-a', deletedWriteKey), domain.MemoryNotFoundError,
      '读回执后的业务拒绝保持原类型，无需再解包');
    assert.deepEqual(database.prepare('SELECT * FROM memory_items ORDER BY id').all(), memoryRowsBefore);
    assert.equal(toolErrorLogs.length, 0, '记忆不存在通过 observation 返回，不触发红色错误日志');
    await create('storage-error-memory', '存储故障前的正文');
    database.exec("CREATE TRIGGER reject_memory_error_test BEFORE UPDATE ON memory_items WHEN OLD.id='storage-error-memory' BEGIN SELECT RAISE(ABORT,'memory storage failure'); END;");
    try {
      const failure = await executeSummaryTool(nativeTools.UpdateMemoryTool,
        { memoryId: 'storage-error-memory', content: '不能保存' }, memoryContext);
      assert.equal(failure.code, 'TOOL_EXECUTION_FAILED');
      assert.equal(toolErrorLogs.length, 1);
      assert.ok(toolErrorLogs[0][1].error instanceof databaseErrors.CoordinatedDatabaseError);
      assert.equal((await repository.getEntry('pool-a', 'storage-error-memory')).content, '存储故障前的正文');
    } finally {
      database.exec('DROP TRIGGER reject_memory_error_test');
      await repository.deleteEntry('pool-a', 'storage-error-memory');
    }
    toolErrorLogs.length = 0;

    database.exec("CREATE TRIGGER reject_summary_error_test BEFORE UPDATE OF revision ON chat_summary_state WHEN OLD.conversation_id='tool-summary' BEGIN SELECT RAISE(ABORT,'摘要存储故障'); END;");
    try {
      const outcome = await executeSummaryTool(EditSecondarySummaryTool, { mode: 'replace_text', oldText: '事件1', newText: '不能部分保存' });
      assert.equal(outcome.code, 'TOOL_EXECUTION_FAILED', '真实 SQLite 故障不能误报成业务拒绝');
      assert.equal(toolErrorLogs.length, 1);
      assert.ok(toolErrorLogs[0][1].error instanceof databaseErrors.CoordinatedDatabaseError);
      assert.match(toolErrorLogs[0][1].error.cause.message, /摘要存储故障/);
    } finally {
      database.exec('DROP TRIGGER reject_summary_error_test');
    }
    assert.deepEqual(await summary.readContext('tool-summary', []), toolOriginal, '所有失败均保留原正文与进度');
    assert.deepEqual(failedEditEvents, [], '失败事务不通知提交后消费者');
  } finally {
    console.error = previousConsoleError;
    coordinator.openTaskExecutor = previousOpenTaskExecutor;
    unsubscribeFailedEdits();
  }

  const expectEditFailure = async (input, context = editContext) => {
    const before = await summary.readContext('tool-summary', []);
    assert.equal((await EditSecondarySummaryTool.execute(input, context)).status, 'error');
    assert.deepEqual(await summary.readContext('tool-summary', []), before, '拒绝写入时保留正文与进度');
  };
  await expectEditFailure({ mode: 'replace_text', oldText: '共同前缀', newText: '不确定目标' });
  await expectEditFailure({ mode: 'replace_text', oldText: '过期原文', newText: '不该保存' });
  await expectEditFailure({ mode: 'replace_text', oldText: '  ', newText: '不能空白匹配' });
  await expectEditFailure({ mode: 'replace_all', oldText: '事件1', newText: '不能用片段覆盖全文' });
  await expectEditFailure({ mode: 'replace_all', oldText: fullText, newText: '  ' });
  const otherAIContext = { ...editContext, task: { assistantId: 'b', sessionId: 'tool-summary' } };
  assert.equal((await GetSecondarySummaryTool.execute({}, otherAIContext)).status, 'error');
  await expectEditFailure({ mode: 'replace_all', oldText: fullText, newText: '越权' }, otherAIContext);
  assert.equal((await GetSecondarySummaryTool.execute({}, { ...editContext, task: { assistantId: 'tool-ai' } })).status, 'error');
  assert.equal((await GetSecondarySummaryTool.execute({ conversationId: 'tool-summary' }, { ...editContext, task: { assistantId: 'tool-ai' } })).status, 'success');
  database.exec("CREATE TRIGGER reject_tool_edit BEFORE DELETE ON chat_summary_segments WHEN OLD.id='tool-s2' BEGIN SELECT RAISE(ABORT,'工具编辑回滚'); END;");
  await assert.rejects(EditSecondarySummaryTool.execute({ mode: 'replace_text', oldText: '事件1', newText: '已修正' }, editContext), /工具编辑回滚/);
  assert.deepEqual(await summary.readContext('tool-summary', []), toolOriginal, '编辑失败不能半更新正文或合并标记');
  database.exec('DROP TRIGGER reject_tool_edit');
  const notifications = [];
  const unsubscribeToolEdit = summaryRuntime.subscribeChatSummaryChanged(id => notifications.push(id));
  const patched = await EditSecondarySummaryTool.execute({ mode: 'replace_text', oldText: '事件1', newText: '字面值$&' }, editContext);
  assert.equal(patched.data.content, '共同前缀，字面值$&\n\n共同前缀，事件2', '替换文本不解释正则特殊字符');
  assert.deepEqual(notifications, ['tool-summary'], '提交成功后通知消费者');
  unsubscribeToolEdit();
  const toolPatchedSnapshot = await summary.readContext('tool-summary', []);
  await assert.rejects(summary.replaceSecondary('tool-summary', toolOriginal.segments.filter(item => item.level === 'secondary'), '过期页面草稿', later), /二级摘要已更新/);
  assert.deepEqual(toolPatchedSnapshot.segments.filter(item => item.level === 'primary').map(item => item.content), ['来源1','来源2']);
  assert.deepEqual(toolPatchedSnapshot.tasks, toolOriginal.tasks);
  assert.deepEqual(toolPatchedSnapshot.settings, toolOriginal.settings);
  await expectEditFailure({ mode: 'replace_all', oldText: fullText, newText: '过期全文' });
  const replaced = await EditSecondarySummaryTool.execute({ mode: 'replace_all', oldText: patched.data.content, newText: '全新正文，删除这一段' }, editContext);
  assert.equal(replaced.data.content, '全新正文，删除这一段');
  assert.equal((await EditSecondarySummaryTool.execute({ mode: 'replace_text', oldText: '，删除这一段', newText: '' }, editContext)).data.content, '全新正文');
  assert.equal((await GetSecondarySummaryTool.execute({}, editContext)).data.content, '全新正文');
  const editWinners = await Promise.all(['胜者甲', '胜者乙'].map(newText =>
    EditSecondarySummaryTool.execute({ mode: 'replace_all', oldText: '全新正文', newText }, editContext)));
  assert.equal(editWinners.filter(result => result.status === 'success').length, 1, '同一旧全文并发编辑只有一个提交者');
  const winningText = (await GetSecondarySummaryTool.execute({}, editContext)).data.content;
  // 新二级加入后拒绝旧全文；新内容不会被旧编辑吞掉。
  await summary.updateSettings('tool-summary', { generationEnabled: true, secondaryEnabled: true });
  await summary.create('tool-summary', 'tool-p3', '新的来源', later, 'Asia/Shanghai');
  const toolNewClaim = await summary.claimSecondary('tool-summary', 'tool-new-claim', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  await summary.appendSecondary(toolNewClaim, 'tool-s3', '新生成的正文', later);
  await expectEditFailure({ mode: 'replace_all', oldText: winningText, newText: '覆盖新正文' });
  const groupEditContext = { ...editContext, task: { assistantId: 'a', sessionId: 'context-group-a' } };
  const groupText = (await GetSecondarySummaryTool.execute({}, groupEditContext)).data.content;
  assert.ok(groupText);
  assert.equal((await EditSecondarySummaryTool.execute({ mode: 'replace_all', oldText: groupText, newText: groupText + '，成员修正' }, groupEditContext)).status, 'success');
  database.prepare("UPDATE group_chat_members SET enabled=0 WHERE group_id='context-group-a'").run();
  assert.equal((await GetSecondarySummaryTool.execute({}, groupEditContext)).status, 'error');
  assert.equal((await EditSecondarySummaryTool.execute({ mode: 'replace_text', oldText: '成员修正', newText: '退出后修改' }, groupEditContext)).status, 'error');
  database.prepare("UPDATE group_chat_members SET enabled=1 WHERE group_id='context-group-a'").run();
  const cancelledToolRead = new AbortController(); cancelledToolRead.abort();
  await assert.rejects(GetSecondarySummaryTool.execute({}, { ...editContext, abortSignal: cancelledToolRead.signal }));
  await assert.rejects(EditSecondarySummaryTool.execute(emptyEdit, { ...editContext, abortSignal: cancelledToolRead.signal }));

  // 一级工具按记录定位；原文比对与归属检查在同一事务内，独立于已有二级正文。
  const primaryEditSchema = EditPrimarySummaryTool.definition.parameters;
  const primaryDeleteSchema = DeletePrimarySummaryTool.definition.parameters;
  assert.equal(matchesAgentToolInputSchema({ segmentId: 'p', mode: 'replace_text', oldText: '旧', newText: '' }, primaryEditSchema), true);
  assert.equal(matchesAgentToolInputSchema({ segmentId: 'p', mode: 'replace_all', newText: '新' }, primaryEditSchema), false);
  assert.equal(matchesAgentToolInputSchema({ segmentId: 'p' }, primaryDeleteSchema), false);
  assert.equal(matchesAgentToolInputSchema({ segmentId: 'p', expectedContent: '旧', assistantId: 'other' }, primaryDeleteSchema), false);
  const primaryOriginal = (await searchTool.execute({ keywords: ['来源1'] }, editContext)).data.entries.find(item => item.id === 'tool-p1');
  assert.equal(primaryOriginal.level, 'primary');
  const secondaryBeforePrimaryTools = (await GetSecondarySummaryTool.execute({}, editContext)).data.content;
  const stateBeforePrimaryTools = await raw.getFirstAsync('SELECT * FROM chat_summary_state WHERE conversation_id = ?', ['tool-summary']);
  const primaryFullInput = { segmentId: primaryOriginal.id, mode: 'replace_all', oldText: primaryOriginal.content, newText: '日期待修正，保留偏好，保留偏好' };
  const expectPrimaryFailure = async (tool, input, context = editContext) => {
    const before = await summary.readContext('tool-summary', []);
    assert.equal((await tool.execute(input, context)).status, 'error');
    assert.deepEqual(await summary.readContext('tool-summary', []), before);
  };
  await expectPrimaryFailure(EditPrimarySummaryTool, primaryFullInput, otherAIContext);
  await expectPrimaryFailure(DeletePrimarySummaryTool, { segmentId: primaryOriginal.id, expectedContent: primaryOriginal.content }, otherAIContext);
  for (const segmentId of ['missing-primary', 'tool-s1', 'merge-p2']) {
    await expectPrimaryFailure(EditPrimarySummaryTool, { ...primaryFullInput, segmentId });
    await expectPrimaryFailure(DeletePrimarySummaryTool, { segmentId, expectedContent: '不能删错目标' });
  }
  const primaryFull = await EditPrimarySummaryTool.execute(primaryFullInput, editContext);
  assert.equal(primaryFull.data.content, primaryFullInput.newText);
  assert.equal(primaryFull.data.compactionId, primaryOriginal.compactionId);
  assert.equal(primaryFull.data.createdAt, primaryOriginal.createdAt);
  assert.equal(primaryFull.data.contextSequence, primaryOriginal.contextSequence);
  await expectPrimaryFailure(EditPrimarySummaryTool, primaryFullInput);
  await expectPrimaryFailure(EditPrimarySummaryTool, { ...primaryFullInput, mode: 'replace_text', oldText: '保留偏好' });
  await expectPrimaryFailure(EditPrimarySummaryTool, { ...primaryFullInput, oldText: '  ' });
  await expectPrimaryFailure(EditPrimarySummaryTool, { ...primaryFullInput, oldText: primaryFull.data.content, newText: ' ' });
  await expectPrimaryFailure(DeletePrimarySummaryTool, { segmentId: primaryOriginal.id, expectedContent: primaryOriginal.content });
  const primaryPatchInput = { segmentId: primaryOriginal.id, mode: 'replace_text', oldText: '日期待修正', newText: '修正日期$&' };
  const beforePrimaryRollback = await summary.readContext('tool-summary', []);
  database.exec("CREATE TRIGGER reject_primary_tool_revision BEFORE UPDATE OF revision ON chat_summary_state WHEN OLD.conversation_id='tool-summary' BEGIN SELECT RAISE(ABORT,'一级编辑回滚'); END;");
  await assert.rejects(EditPrimarySummaryTool.execute(primaryPatchInput, editContext), /一级编辑回滚/);
  await assert.rejects(DeletePrimarySummaryTool.execute({ segmentId: primaryOriginal.id, expectedContent: primaryFull.data.content }, editContext), /一级编辑回滚/);
  assert.deepEqual(await summary.readContext('tool-summary', []), beforePrimaryRollback, '正文编辑与删除都随事务失败回滚');
  database.exec('DROP TRIGGER reject_primary_tool_revision');
  const primaryEvents = [];
  const unsubscribePrimaryTools = summaryRuntime.subscribeChatSummaryChanged(id => primaryEvents.push(id));
  const primaryPatched = await EditPrimarySummaryTool.execute(primaryPatchInput, editContext);
  assert.equal(primaryPatched.data.content, '修正日期$&，保留偏好，保留偏好');
  const primaryDeleted = await DeletePrimarySummaryTool.execute({ segmentId: primaryOriginal.id, expectedContent: primaryPatched.data.content }, editContext);
  assert.deepEqual(primaryDeleted.data, { conversationId: 'tool-summary', segmentId: primaryOriginal.id, deleted: true });
  assert.deepEqual(primaryEvents, ['tool-summary', 'tool-summary']);
  unsubscribePrimaryTools();
  assert.ok(!(await searchTool.execute({}, editContext)).data.entries.some(item => item.id === primaryOriginal.id));
  assert.equal((await GetSecondarySummaryTool.execute({}, editContext)).data.content, secondaryBeforePrimaryTools);
  const stateAfterPrimaryTools = await raw.getFirstAsync('SELECT * FROM chat_summary_state WHERE conversation_id = ?', ['tool-summary']);
  assert.deepEqual({ ...stateAfterPrimaryTools, revision: stateBeforePrimaryTools.revision }, { ...stateBeforePrimaryTools }, '一级维护不改变原文处理进度与执行资格');
  assert.deepEqual((await summary.readContext('tool-summary', [])).tasks, beforePrimaryRollback.tasks);
  const deleteWinners = await Promise.all([1, 2].map(() => DeletePrimarySummaryTool.execute({ segmentId: 'tool-p2', expectedContent: '来源2' }, editContext)));
  assert.equal(deleteWinners.filter(result => result.status === 'success').length, 1);
  await summary.create('tool-summary', 'tool-pending-primary', '待归纳原正文', now, 'Asia/Shanghai');
  const primaryInFlight = await summary.claimSecondary('tool-summary', 'primary-tool-inflight', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  const primaryEditWinners = await Promise.all(['新正文甲', '新正文乙'].map(newText => EditPrimarySummaryTool.execute({ segmentId: 'tool-pending-primary', mode: 'replace_all', oldText: '待归纳原正文', newText }, editContext)));
  assert.equal(primaryEditWinners.filter(result => result.status === 'success').length, 1);
  assert.equal(await summary.appendSecondary(primaryInFlight, 'stale-primary-edit', '旧归纳不能保存', later), false);
  await summary.releaseSecondaryClaim(primaryInFlight);
  const primaryDeleteInFlight = await summary.claimSecondary('tool-summary', 'primary-delete-inflight', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai');
  const pendingPrimaryContent = primaryEditWinners.find(result => result.status === 'success').data.content;
  assert.equal((await DeletePrimarySummaryTool.execute({ segmentId: 'tool-pending-primary', expectedContent: pendingPrimaryContent }, editContext)).status, 'success');
  assert.equal(await summary.appendSecondary(primaryDeleteInFlight, 'stale-primary-delete', '删除后不能提交旧结果', later), false);
  await summary.releaseSecondaryClaim(primaryDeleteInFlight);
  const groupPrimary = (await searchTool.execute({}, groupEditContext)).data.entries.find(item => item.level === 'primary');
  const groupPrimaryEdited = await EditPrimarySummaryTool.execute({ segmentId: groupPrimary.id, mode: 'replace_all', oldText: groupPrimary.content, newText: '群一级修正' }, groupEditContext);
  assert.equal(groupPrimaryEdited.status, 'success');
  database.prepare("UPDATE group_chat_members SET enabled=0 WHERE group_id='context-group-a'").run();
  assert.equal((await EditPrimarySummaryTool.execute({ segmentId: groupPrimary.id, mode: 'replace_text', oldText: '群一级修正', newText: '退出后改写' }, groupEditContext)).status, 'error');
  assert.equal((await DeletePrimarySummaryTool.execute({ segmentId: groupPrimary.id, expectedContent: '群一级修正' }, groupEditContext)).status, 'error');
  database.prepare("UPDATE group_chat_members SET enabled=1 WHERE group_id='context-group-a'").run();
  assert.equal((await DeletePrimarySummaryTool.execute({ segmentId: groupPrimary.id, expectedContent: '群一级修正' }, groupEditContext)).status, 'success');
  await assert.rejects(EditPrimarySummaryTool.execute(primaryFullInput, { ...editContext, abortSignal: cancelledToolRead.signal }));
  await assert.rejects(DeletePrimarySummaryTool.execute({ segmentId: 'tool-p2', expectedContent: '来源2' }, { ...editContext, abortSignal: cancelledToolRead.signal }));

  const backupGroupId = await commands.addMemoryTrigger('a', '备份绑定词、备份同义词', ['vector-only']);
  await summary.updateSettings('context-group-a', { modelConfigId: 'continuous-reference' });
  const retainedGroupSummary = await summary.readContext('context-group-a', []);
  await commands.setMemoryRecallSettings('a', { passiveLimit: 5, activePageSize: 10 });
  await bootstrap();
  assert.ok(await repository.getEntry('pool-a', 'vector-only'));
  assert.ok((await summary.readContext('conversation', [], [])).segments.some((item) => item.id === 'durable-summary'));
  database.prepare("UPDATE sessions SET visible_after_at = '2098-01-01T00:00:00.000Z' WHERE id = 'call-summary'").run();
  const retainedCallSummary = (await summary.readContext('call-summary', [], [])).segments;
  assert.equal(retainedCallSummary.length, 1, '第二次 bootstrap 保留通话摘要');
  await repository.setEmbeddingEnabled(false);
  const backupEmbeddingSettings = await repository.getEmbeddingSettings();
  database.close(); fs.copyFileSync(databasePath, backupPath);
  database = new DatabaseSync(databasePath); database.exec('PRAGMA foreign_keys = ON');
  await commands.forgetMemory('a', 'vector-only');
  database.close(); fs.copyFileSync(backupPath, databasePath);
  database = new DatabaseSync(databasePath); database.exec('PRAGMA foreign_keys = ON');
  await bootstrap();
  assert.deepEqual(await repository.getEmbeddingSettings(), backupEmbeddingSettings, '备份恢复独立保留向量开关与模型');
  assert.equal((await repository.getEntry('pool-a', 'vector-only')).embeddingStatus, 'ready');
  assert.equal((await repository.recallPassive('pool-a', '备份绑定词'))[0].id, 'vector-only', '升级与备份恢复保留手动关系');
  assert.equal((await repository.recallPassive('pool-a', '备份同义词'))[0].id, 'vector-only');
  const restoredGroup = (await repository.listTriggers('pool-a')).find(group => group.id === backupGroupId);
  assert.deepEqual(restoredGroup.keywords.map(word => word.keyword), ['备份绑定词', '备份同义词']);
  assert.equal(restoredGroup.autoAssociate, false, '备份恢复保留组规则');
  assert.equal((await repository.listTriggerMemories('pool-a', catTrigger.id)).find((item) => item.memory.id === 'vector-only').autoRecall, false, '备份恢复保留手动关系的关闭开关');
  assert.ok((await summary.readContext('conversation', [], [])).segments.some((item) => item.id === 'durable-summary'));
  assert.deepEqual((await summary.readContext('call-summary', [], [])).segments, retainedCallSummary, '备份恢复保留通话事实与正文');
  assert.deepEqual(withoutTasks(await summary.readContext('secondary-test', [])), withoutTasks(retainedSecondary), '备份恢复保留两级正文、归纳标记和设置');
  assert.deepEqual(await summary.readContext('logical', []), retainedFixed, '备份恢复保留固定起点与独立开关');
  assert.deepEqual((await summary.readContext('retry-summary',[])).tasks.find(value=>value.id===retryTaskId),retainedRetry,'重启和恢复保留失败次数与调用诊断');
  assert.deepEqual(await summary.readContext('merge-summary',[]),deletedMerged,'合并及删除后的来源、调用事实随备份恢复');
  assert.deepEqual(await summary.readContext('context-group-a', []), retainedGroupSummary, '恢复保留群正文、归纳标记、触发条数与模型选择');
  assert.deepEqual(await raw.getAllAsync('PRAGMA foreign_key_check'), []);
  {
    // 摘要检索、摘要编辑 fence 与工具省略／清空摘要都使用正式链路。
    currentModel = modelA;
    await syncMemoryModel(modelA);
    const withSummary = await repository.createEntry({ id: 'summary-case', poolId: 'pool-a', content: '约定每天互道晚安',
      summary: '纪念协议', normalizedContent: '约定每天互道晚安', now: '2000-01-01T00:00:00.000Z', writeKey: null });
    const oldSummaryClaim = await claim('summary-old');
    assert.equal(oldSummaryClaim.memoryId, withSummary.id);
    const changedSummary = await commands.editMemory('a', withSummary.id, withSummary.content, '晚安协议');
    assert.equal(changedSummary.contentRevision, withSummary.contentRevision + 1);
    assert.equal(changedSummary.rememberedAt, withSummary.rememberedAt);
    assert.equal(await repository.completeEmbedding(oldSummaryClaim, [1, 0]), 'discarded');
    embedding = async (text) => { assert.equal(text, '晚安协议\n约定每天互道晚安'); return [1, 0]; };
    await worker.processNextMemoryEmbedding(signal);
    assert.equal((await repository.getEntry('pool-a', withSummary.id)).embeddingStatus, 'ready');
    const summaryPage = await recall.recallMemoryForRun('a', 'summary-search', { keywords: ['晚安协议'] }, signal);
    assert.deepEqual(summaryPage.entries.map((entry) => entry.id), [withSummary.id]);
    await commands.addMemoryTrigger('a', '晚安协议', [], true);
    const summaryTrigger = (await repository.listTriggers('pool-a')).find((trigger) => trigger.keywords[0].keyword === '晚安协议');
    assert.equal(summaryTrigger.associatedCount, 1);
    assert.equal((await repository.listTriggerMemories('pool-a', summaryTrigger.id))[0].memory.summary, '晚安协议');
    await commands.setMemoryRecallSettings('a', { passiveLimit: 5, activePageSize: 10 });
    assert.equal((await repository.recallPassive('pool-a', '晚安协议'))[0].id, withSummary.id);
    await commands.setMemoryAutoRecall('a', summaryTrigger.id, withSummary.id, false);
    assert.deepEqual(await repository.recallPassive('pool-a', '晚安协议'), []);
    const summaryToolContext = { ...nativeContext, toolCallId: 'summary-create' };
    const summaryToolSaved = await nativeTools.RememberMemoryTool.execute({ content: '工具正文', summary: '工具摘要' }, summaryToolContext);
    assert.equal(summaryToolSaved.data.summary, '工具摘要');
    const preserved = await nativeTools.UpdateMemoryTool.execute({ memoryId: summaryToolSaved.data.id, content: '新版工具正文' }, summaryToolContext);
    assert.equal(preserved.data.summary, '工具摘要');
    const cleared = await nativeTools.UpdateMemoryTool.execute({ memoryId: summaryToolSaved.data.id, content: '新版工具正文', summary: '' }, summaryToolContext);
    assert.equal(cleared.data.summary, null);
    await assert.rejects(commands.editMemory('a', withSummary.id, withSummary.content, '猫'.repeat(51)), domain.MemoryInputError);
    assert.equal((await repository.getEntry('pool-a', withSummary.id)).summary, '晚安协议');

    // 跨 Feature 转存是一个 commit；拒绝删除时正文、摘要与向量待处理状态全部回滚。
    const protocols = load('src/features/protocol/infrastructure/SQLiteProtocolRepository.ts').protocolRepository;
    const findProtocol = async (id) => (await protocols.getByAI('a')).find((protocol) => protocol.id === id) ?? null;
    const { transferProtocolToMemory } = load('src/host/application/TransferProtocolToMemory.ts');
    const signals = load('src/features/memory/application/MemorySignals.ts');
    const values = (protocol) => ({ content: protocol.content, summary: protocol.summary ?? null });
    const countMemories = () => database.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count;
    const conversionSource = await protocols.insert({ aiAssistantId: 'a', content: '猫'.repeat(500), summary: '协议'.repeat(25) });
    const beforeConversion = countMemories();
    let changes = 0;
    const unsubscribe = signals.subscribeMemoryChanged(() => { changes++; });
    const conversions = await Promise.allSettled([
      transferProtocolToMemory('a', conversionSource, values(conversionSource)),
      transferProtocolToMemory('a', conversionSource, values(conversionSource)),
    ]);
    assert.equal(conversions.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(countMemories(), beforeConversion + 1);
    assert.equal(changes, 1);
    assert.equal(await findProtocol(conversionSource.id), null);
    assert.equal((await protocols.getPromptText('a')).includes(conversionSource.content), false);
    const transferred = (await repository.listEntries('pool-a')).find((entry) => entry.content === conversionSource.content);
    assert.equal(transferred.summary, conversionSource.summary);
    assert.equal(transferred.embeddingStatus, 'pending');
    assert.equal((await repository.listEntries('pool-b')).some((entry) => entry.id === transferred.id), false);
    const failingSource = await protocols.insert({ aiAssistantId: 'a', content: '失败时保留协议', summary: '回滚协议' });
    const beforeFailure = countMemories();
    const embeddingsBeforeFailure = database.prepare('SELECT COUNT(*) AS count FROM memory_item_embeddings').get().count;
    database.exec("CREATE TRIGGER reject_protocol_transfer BEFORE DELETE ON protocols BEGIN SELECT RAISE(ABORT, '协议删除失败'); END;");
    await assert.rejects(transferProtocolToMemory('a', failingSource, values(failingSource)), /协议删除失败/);
    assert.equal(countMemories(), beforeFailure);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_item_embeddings').get().count, embeddingsBeforeFailure);
    assert.ok(await findProtocol(failingSource.id));
    assert.equal(changes, 1, '回滚不能发布刷新信号');
    database.exec('DROP TRIGGER reject_protocol_transfer');
    database.exec("CREATE TRIGGER reject_memory_transfer BEFORE INSERT ON memory_items BEGIN SELECT RAISE(ABORT, '记忆创建失败'); END;");
    await assert.rejects(transferProtocolToMemory('a', failingSource, values(failingSource)), /记忆创建失败/);
    assert.ok(await findProtocol(failingSource.id));
    database.exec('DROP TRIGGER reject_memory_transfer');
    await assert.rejects(transferProtocolToMemory('b', failingSource, values(failingSource)), /不属于当前 AI/);
    await protocols.update('a', failingSource.id, { content: 'AI 更新后的协议' });
    database.prepare('UPDATE protocols SET updated_at = ? WHERE id = ?').run(failingSource.updatedAt, failingSource.id);
    await assert.rejects(transferProtocolToMemory('a', failingSource, values(failingSource)), /协议已被修改/);
    const freshSource = await findProtocol(failingSource.id);
    await assert.rejects(transferProtocolToMemory('a', freshSource, { content: '猫'.repeat(501), summary: freshSource.summary }), domain.MemoryInputError);
    assert.equal(countMemories(), beforeFailure);
    assert.equal((await findProtocol(failingSource.id)).content, 'AI 更新后的协议');
    currentModel = null;
    await syncMemoryModel(null);
    const plainSource = await protocols.insert({ aiAssistantId: 'a', content: '没有摘要的协议' });
    await transferProtocolToMemory('a', plainSource, { content: '编辑后直接转存的正文', summary: null });
    assert.equal(await findProtocol(plainSource.id), null);
    const plainMemory = (await repository.listEntries('pool-a')).find((entry) => entry.content === '编辑后直接转存的正文');
    assert.equal(plainMemory.summary, null);
    assert.equal(plainMemory.embeddingStatus, 'not_requested');
    unsubscribe();
    // 新摘要在第二次启动和完整 SQLite 快照恢复后仍保留。
    await bootstrap();
    assert.equal((await repository.getEntry('pool-a', withSummary.id)).summary, '晚安协议');
    database.close(); fs.copyFileSync(databasePath, backupPath);
    database = new DatabaseSync(databasePath); database.exec('PRAGMA foreign_keys = ON');
    await commands.editMemory('a', withSummary.id, '临时改写', null);
    database.close(); fs.copyFileSync(backupPath, databasePath);
    database = new DatabaseSync(databasePath); database.exec('PRAGMA foreign_keys = ON');
    await bootstrap();
    assert.equal((await repository.getEntry('pool-a', withSummary.id)).summary, '晚安协议');
    assert.equal((await repository.getEntry('pool-a', withSummary.id)).content, '约定每天互道晚安');
    assert.equal((await repository.getEntry('pool-a', transferred.id)).summary, conversionSource.summary);
    assert.equal(await findProtocol(conversionSource.id), null);
  }

  // 大积压只读取足够确定本批的原文；分段跨页、通话闭合和无投影行不能改变领取范围。
  {
    const conversationId = 'bounded-summary';
    database.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('bounded-ai', 'bounded-agent', '分页摘要', 'chat', now, now);
    database.prepare('INSERT INTO chat_conversations(id,kind) VALUES (?,?)').run(conversationId, 'direct');
    database.prepare('INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(conversationId, 'bounded-ai', '分页摘要', now, now);
    database.prepare('INSERT INTO conversation_turn_state(session_id,reply_cursor,revision,updated_at) VALUES (?,?,0,?)').run(conversationId, 2147483647, now);
    const insert = database.prepare(`INSERT INTO messages(session_id,text,is_me,sender_type,created_at,time,status,logical_message_id)
      VALUES (?, ?, 0, 'assistant', ?, '', 'sent', ?)`);
    const at = index => new Date(Date.parse(now) + index * 1000).toISOString();
    const messageIds = [];
    database.exec('BEGIN');
    for (let index = 0; index < 8000; index++) {
      messageIds.push(Number(insert.run(conversationId, '原文 ' + index, at(index), index < 300 ? 'large-segmented-message' : 'logical-' + index).lastInsertRowid));
    }
    database.exec('COMMIT');
    let callSources = [];
    let callReads = 0;
    const bounded = new SQLiteChatSummaryRepository(async () => { callReads++; return callSources; });
    const expected = timelineDomain.selectSummaryRange((await bounded.readContext(conversationId, [])).timeline, 20, 0);
    const getAll = raw.getAllAsync;
    let returnedRows = 0;
    raw.getAllAsync = async (...args) => { const rows = await getAll(...args); returnedRows += rows.length; return rows; };
    try {
      const range = await bounded.claim(conversationId, 20, 'bounded-primary', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0);
      assert.deepEqual(range.messages, expected);
      assert.equal(range.messages.length, 319, '同一逻辑消息的三百个分段必须完整领取');
      assert.ok(returnedRows < 1000, '小批摘要的数据库结果不能随八千条积压全量传回');
      await bounded.releaseClaim(range);
      callSources = [{ info: { callId: 'across-pages', mediaMode: 'audio', direction: 'outgoing', state: 'ended',
        startedAt: at(0), acceptedAt: at(0), endedAt: at(350), endReason: 'user_hangup', durationSeconds: 350 },
      historyStartsAfter: null, transcripts: [{ eventId: 'crossing-transcript', timestamp: at(100), speaker: 'user', content: '通话内原文' }] }];
      const completeTimeline = (await bounded.readContext(conversationId, [])).timeline;
      const withCall = await bounded.claim(conversationId, 1, 'bounded-call', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0);
      assert.deepEqual(withCall.messages, timelineDomain.selectSummaryRange(completeTimeline, 1, 0), '分页不能在通话结束前封口或漏掉通话内聊天');
      assert.equal(withCall.messages.at(-1).callBoundary, 'end');
      await bounded.releaseClaim(withCall);
      callSources = [];
      database.prepare("UPDATE messages SET sender_type='reasoning' WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(messageIds.slice(0, 300)));
      const projected = timelineDomain.selectSummaryRange((await bounded.readContext(conversationId, [])).timeline, 20, 0);
      const afterReasoning = await bounded.claim(conversationId, 20, 'bounded-non-dialogue', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0);
      assert.deepEqual(afterReasoning.messages, projected, '没有上下文投影的整页仍需推进数据库游标');
      await bounded.failTask(afterReasoning, { kind: 'request', message: '冷却中', retryable: true }, now);
      await bounded.releaseClaim(afterReasoning);
      returnedRows = 0; callReads = 0;
      assert.equal(await bounded.claim(conversationId, 20, 'bounded-cooling', now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0), null);
      assert.equal(returnedRows, 0, '冷却任务在读取原文和已有摘要前退出');
      assert.equal(callReads, 0, '冷却任务不读取通话来源');
      const retry = await bounded.claim(conversationId, 20, 'bounded-retry', later, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0);
      assert.ok(retry, '冷却结束仍可正常领取');
      await bounded.failTask(retry, { kind: 'request', message: '暂停中', retryable: false }, later);
      await bounded.releaseClaim(retry);
      returnedRows = 0; callReads = 0;
      assert.equal(await bounded.claim(conversationId, 20, 'bounded-paused', later, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0), null);
      assert.equal(returnedRows, 0);
      assert.equal(callReads, 0);
    } finally { raw.getAllAsync = getAll; }
  }

  // 启动只消费持久待处理身份；事实回滚、并发新内容和进程重建不能丢失或复活工作。
  {
    const mainDatabase = database;
    const previousRuntime = summaryRuntime.getChatSummaryRuntime();
    const queuePath = path.join(directory, 'summary-queue.db');
    database = new DatabaseSync(queuePath); database.exec('PRAGMA foreign_keys = ON');
    try {
      await bootstrap();
      const queued = new SQLiteChatSummaryRepository((tx, conversationId, boundary) => calls.readSummarySources(tx, {
        chatSessionId: conversationId, excludedCallIds: boundary.processedCallIds, after: boundary.historyStartsAfter,
      }));
      const pending = async () => (await queued.prepareConversations(new Date().toISOString())).conversationIds;
      assert.deepEqual(await pending(), [], '空队列启动没有待检查会话');
      const addConversation = id => {
        database.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
          .run(id+'-ai',id+'-agent',id,'chat',now,now);
        database.prepare("INSERT INTO chat_conversations(id,kind) VALUES (?,'direct')").run(id);
        database.prepare('INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
          .run(id,id+'-ai',id,now,now);
      };
      const addQueuedMessage = (id, content) => database.prepare(`INSERT INTO messages
        (session_id,text,is_me,sender_type,created_at,status) VALUES (?,?,0,'assistant',?,'sent')`).run(id, content, now);
      addConversation('pending-empty'); addConversation('pending-chat');
      assert.deepEqual(await pending(), [], '既有空会话不因启动进入领取流程');
      addQueuedMessage('pending-chat','后台提交的原文');
      assert.deepEqual(await pending(), ['pending-chat']);
      const revision = await queued.readQueuedRevision('pending-chat');
      database.exec('BEGIN'); addQueuedMessage('pending-chat','需要回滚的原文'); database.exec('ROLLBACK');
      assert.equal(await queued.readQueuedRevision('pending-chat'), revision, '入队与消息事实一同回滚');
      database.close(); database = new DatabaseSync(queuePath); database.exec('PRAGMA foreign_keys = ON');
      await bootstrap();
      assert.deepEqual(await pending(), ['pending-chat'], '没有前台内存唤醒也能在重启后恢复');
      let generated = 0;
      const configureQueued = getBatchSize => summaryRuntime.configureChatSummaryRuntime({ repository: queued, getBatchSettings: async () => ({ batchSize: await getBatchSize(), recentWindowLimit: 0 }),
        generateAddition: async () => { generated++; return '队列摘要'; }, generateSecondary: async () => '二级摘要' });
      configureQueued(async () => 5);
      assert.equal(await summaryApplication.processChatSummary('pending-chat', signal), false);
      assert.deepEqual(await pending(), [], '不足门槛的会话只检查一次');
      await bootstrap();
      assert.deepEqual(await pending(), [], '普通启动不重新发现已检查且无变化的原文');
      assert.equal(generated,0);

      addQueuedMessage('pending-chat','检查前的新消息');
      configureQueued(async () => { addQueuedMessage('pending-chat','检查期间到来的消息'); return 5; });
      assert.equal(await summaryApplication.processChatSummary('pending-chat', signal), false);
      assert.deepEqual(await pending(), ['pending-chat'], '旧检查水位不能确认并发到来的新内容');
      const newerRevision = await queued.readQueuedRevision('pending-chat');
      await queued.acknowledgeQueuedRevision('pending-chat', newerRevision);
      await queued.acknowledgeQueuedRevision('pending-chat', revision);
      assert.equal(await queued.readQueuedRevision('pending-chat'),null,'迟到的旧确认不能回退水位');

      addQueuedMessage('pending-chat','等待取消恢复');
      const cancelled = new AbortController();
      configureQueued(async () => { cancelled.abort(); return 5; });
      await assert.rejects(summaryApplication.processChatSummary('pending-chat',cancelled.signal),{name:'AbortError'});
      assert.deepEqual(await pending(), ['pending-chat'], '取消保留持久待处理记录');
      configureQueued(async () => { throw new Error('队列读取故障'); });
      await assert.rejects(summaryApplication.processChatSummary('pending-chat',signal),/队列读取故障/);
      assert.deepEqual(await pending(), ['pending-chat'], '本地故障不能确认工作');
      configureQueued(async () => 5);
      await summaryApplication.processChatSummary('pending-chat',signal);
      assert.deepEqual(await pending(), []);

      addConversation('pending-backlog');
      for(let index=0;index<5;index++) addQueuedMessage('pending-backlog','积压 '+index);
      configureQueued(async () => 2);
      const beforeGenerated = generated;
      let passes = 0;
      while(await summaryApplication.processChatSummary('pending-backlog',signal)) assert.ok(++passes<=3,'积压不能无限自唤醒');
      assert.equal(generated-beforeGenerated,2,'沿用原流程逐批消费，剩余不足门槛时停止');
      assert.deepEqual(await pending(), []);
      await queued.updateSettings('pending-backlog',{primaryLimit:1});
      assert.deepEqual(await pending(), ['pending-backlog'],'设置变化重新入队，允许整理已有原文');
      configureQueued(async () => 1);
      while(await summaryApplication.processChatSummary('pending-backlog',signal)) assert.ok(++passes<=5);
      assert.deepEqual(await pending(), []);

      addConversation('pending-call');
      await calls.createSession({ id:'queue-call',chatSessionId:'pending-call',aiAssistantId:'pending-call-ai',agentId:'pending-call-agent',
        direction:'outgoing',requestedMode:'audio',source:'user',state:'active',startedAt:now,acceptedAt:now });
      await calls.appendEvent({ id:'queue-speech',callId:'queue-call',chatSessionId:'pending-call',kind:'userSpeechText',
        actorType:'user',text:'纯通话里约定了计划',includeInAIContext:true,createdAt:now });
      assert.equal(database.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='pending-call'").get().n,0);
      assert.deepEqual(await pending(), ['pending-call'],'没有聊天气泡的通话原文也入队');
      assert.equal(await summaryApplication.processChatSummary('pending-call',signal),false,'通话进行中仍不能领取');
      assert.deepEqual(await pending(), []);
      await calls.updateSession('queue-call',{state:'ended',endedAt:later,endReason:'user_hangup'});
      assert.deepEqual(await pending(), ['pending-call'],'通话结束重新入队，不依赖新消息');
      assert.equal(await summaryApplication.processChatSummary('pending-call',signal),true);
      await summaryApplication.processChatSummary('pending-call',signal);
      assert.deepEqual(await pending(), []);

      // 已确认的会话没有新事实时只由到期任务唤醒，失败暂停与有效租约都不进入恢复候选。
      addQueuedMessage('pending-chat','重试范围');
      const failureClaim = await queued.claim('pending-chat',1,'queued-retry',now,'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
      const future = new Date(Date.now()+60_000).toISOString();
      await queued.failTask(failureClaim,{kind:'timeout',message:'稍后重试',retryable:true},new Date().toISOString());
      await queued.releaseClaim(failureClaim);
      await queued.acknowledgeQueuedRevision('pending-chat',await queued.readQueuedRevision('pending-chat'));
      database.prepare('UPDATE chat_summary_tasks SET next_attempt_at=? WHERE id=?').run(future,failureClaim.taskId);
      assert.deepEqual(await pending(), [],'冷却期间不重复领取');
      assert.ok(await queued.getNextWakeAt());
      assert.deepEqual((await queued.prepareConversations(new Date(Date.now()+180_000).toISOString())).conversationIds,['pending-chat']);
      database.prepare("UPDATE chat_summary_tasks SET status='failed',next_attempt_at=NULL WHERE id=?").run(failureClaim.taskId);
      assert.deepEqual(await pending(), [],'失败暂停不被启动复活');
      await queued.retryTask('pending-chat',failureClaim.taskId,new Date().toISOString());
      assert.deepEqual(await pending(), ['pending-chat'],'显式手动重试可消费');
      const resumed = await queued.claim('pending-chat',1,'queued-resumed',new Date().toISOString(),'2099-01-01T00:00:00.000Z','Asia/Shanghai', 0);
      assert.deepEqual(await pending(), [],'有效在途租约不重复恢复');
      database.prepare("UPDATE chat_summary_state SET claim_expires_at=? WHERE conversation_id='pending-chat'").run(now);
      assert.deepEqual(await pending(), ['pending-chat'],'过期的在途任务可以恢复');
      await queued.releaseClaim(resumed);
      database.prepare("DELETE FROM chat_conversations WHERE id='pending-chat'").run();
      assert.equal(await queued.readQueuedRevision('pending-chat'),null,'会话删除级联清理队列身份');
    } finally {
      database.close(); database = mainDatabase;
      fs.unlinkSync(queuePath);
      summaryRuntime.configureChatSummaryRuntime(previousRuntime);
    }
  }

  // 同一 JS runtime：恢复出厂后不能沿用“已初始化”缓存，默认记录必须在队列运行前重建。
  const { initDatabase } = load('src/platform/persistence/sqlite/initialization.ts');
  const { clearDB } = load('src/platform/persistence/helpers.ts');
  await initDatabase();
  assert.equal((await repository.getEmbeddingSettings()).modelConfigId, 'retained-choice', '普通重启初始化不能覆盖用户模型选择');
  database.exec("CREATE TRIGGER reject_reset BEFORE DELETE ON memory_model_settings BEGIN SELECT RAISE(ABORT, '注入清库失败'); END;");
  await assert.rejects(clearDB(), /清空应用表失败/u);
  assert.equal((await repository.getEmbeddingSettings()).modelConfigId, 'retained-choice', '清库回滚不能丢失用户配置');
  database.exec('DROP TRIGGER reject_reset');
  runtime.configureMemoryRuntimeDependencies({
    ...runtime.getMemoryRuntimeDependencies(),
    resolveEmbeddingModel: async () => (await repository.getEmbeddingSettings()).modelConfigId === modelA.id ? modelA : null,
  });
  for (let reset = 0; reset < 2; reset++) {
    await repository.setEmbeddingModelId(modelA.id);
    await clearDB();
    await initDatabase();
    assert.equal((await repository.getEmbeddingSettings()).modelConfigId, null);
    assert.equal(await repository.getPreferredAssistantId(), null);
    assert.equal((await raw.getFirstAsync('SELECT model_config_id FROM speech_recognition_settings WHERE id = 1')).model_config_id, null);
    assert.equal((await raw.getFirstAsync('SELECT COUNT(*) AS count FROM auxiliary_model_configs')).count, 0);
    assert.equal((await raw.getFirstAsync('SELECT COUNT(*) AS count FROM messages')).count, 0);
    for (const table of ['chat_summary_processed_calls', 'chat_summary_call_boundary']) {
      assert.equal((await raw.getFirstAsync('SELECT COUNT(*) AS count FROM ' + table)).count, 0, '全应用重置清除通话摘要状态');
    }
    for (let route = 0; route < 3; route++) {
      assert.deepEqual(await worker.processNextMemoryEmbedding(new AbortController().signal), {
        processed: false, nextWakeAt: null, failedMemoryId: null,
      });
    }
    assert.deepEqual(await raw.getAllAsync('PRAGMA foreign_key_check'), []);
  }
console.log('Memory V3：正文、授权、触发关系、冻结分页、向量 CAS／三次上限、摘要交接／固定起点／AI 隔离、重启与备份恢复通过');
} finally {
  database.close();
  for (const filename of [databasePath, backupPath]) if (fs.existsSync(filename)) fs.unlinkSync(filename);
  fs.rmdirSync(directory);
}
