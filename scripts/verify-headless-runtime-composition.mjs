/** 冷 runtime 只装配后台入口：真实摘要/搜索读取可用，摘要生成仍由前台激活。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cache = new Map();
const mocks = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    if (mocks.has(name)) return mocks.get(name);
    const resolved = name.startsWith('@shared/') ? path.join(root, 'src/shared', name.slice(8))
      : path.resolve(path.dirname(filename), name);
    for (const suffix of ['.ts', '/index.ts']) if (fs.existsSync(resolved + suffix)) return load(resolved + suffix);
    throw new Error(`未提供的外部边界 ${name}`);
  }, module, module.exports);
  return module.exports;
}

const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
const sql = createSqliteExecutor(database);
await bootstrapSqlite(sql);
database.exec("INSERT INTO chat_conversations(id,kind) VALUES('headless-session','direct')");
database.exec(`INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at)
    VALUES('headless-ai','headless-agent','后台角色','test-model','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z');
  INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at)
    VALUES('headless-session','headless-ai','后台会话','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z');
  INSERT INTO messages(session_id,text,is_me,sender_type,created_at)
    VALUES('headless-session','后台读取的真实历史',1,'user','2026-10-24T00:00:00Z');`);
let tail = Promise.resolve();
const executor = { ...sql, withExclusiveTransactionAsync(callback) {
  const task = tail.then(async () => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = await callback(sql); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  });
  tail = task.catch(() => {});
  return task;
} };
mocks.set('@platform/persistence', { databaseCoordinator: { openTaskExecutor: () => executor } });
mocks.set('@shared/prompt', load('src/shared/prompt/estimateTextTokens.ts'));
mocks.set('expo-crypto', { randomUUID });
const credentials = new Map();
mocks.set('expo-secure-store', {
  setItemAsync: async (reference, key) => { credentials.set(reference, key); },
  getItemAsync: async reference => credentials.get(reference) ?? null,
  deleteItemAsync: async reference => { credentials.delete(reference); },
});
const searches = [];
mocks.set('@platform/web', { searchWeb: async (query, limit, _signal, options) => {
  searches.push({ query, limit, options });
  return { ok: true, data: { items: [{ title: '后台搜索结果', url: 'https://example.invalid/result' }] } };
} });
let scheduled = 0;
let cancelled = 0;
mocks.set('react-native', { InteractionManager: { runAfterInteractions() {
  scheduled++;
  return { cancel() { cancelled++; } };
} } });
mocks.set('@shared/ui/appDialogStore', { showAppDialog() { assert.fail('后台不应显示摘要错误弹窗'); } });
mocks.set('@features/assistants', {
  subscribeAuxiliaryModelsChanged: () => () => {}, subscribeAIAssistantUpdated: () => () => {},
});
mocks.set('@features/profile', {});
mocks.set('@features/protocol', {});
mocks.set('@host/prompt', {});
mocks.set('@shared/aiTools', {});
mocks.set('@platform/ai', { createAIClient() { assert.fail('后台装配/读取不应启动摘要模型'); } });
for (const name of ['createAgentToolRegistry', 'ToolPackageExposure', 'registerMcpToolsForHostRun']) {
  mocks.set(`./agent/${name}`, {});
}
const runtime = load('src/features/chat/summary/application/ChatSummaryRuntime.ts');
const summary = load('src/features/chat/summary/application/ChatSummary.ts');
const { SQLiteChatSummaryRepository } = load('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts');
mocks.set('@features/chat', { ...summary, subscribeChatSummaryChanged: runtime.subscribeChatSummaryChanged });
mocks.set('@features/chat/composition', {
  ...summary, configureChatSummaryRuntime: runtime.configureChatSummaryRuntime, SQLiteChatSummaryRepository,
  setChatEventBus() {},
});
let callReads = 0;
mocks.set('@features/calls/composition', { callRepository: { readSummarySources: async () => { callReads++; return []; } } });
mocks.set('@features/webTools/composition', load('src/features/webTools/composition.ts'));

// 仅替换本次范围外的装配；摘要装配、槽、Repository、队列及搜索装配均走真实实现。
for (const name of ['AIRuntime', 'ChatRuntime', 'MemoryRuntime', 'CompanionRuntime', 'PromptingRuntime',
  'McpToolsRuntime', 'MediaRuntime', 'AIImageTools', 'DeviceControlRuntime', 'FloatingLayerRuntime',
  'PhoneToolsRuntime', 'TogetherListeningRuntime']) {
  mocks.set(`./configure${name}`, { [`configure${name}`]() {} });
}
mocks.set('../runtime/AIMessageDeliveryCoordinator', { configureAIMessageDeliveryCoordinator() {} });
mocks.set('@features/stickers/composition', { configureStickerRuntime() {} });
mocks.set('./StickerAnnotationModelGateway', {});
mocks.set('./agent/assertImageToolRunCurrent', {});

await assert.rejects(summary.getChatSummaryContext('headless-session'), /ChatSummary/);
const search = load('src/features/webTools/application/SearchConfiguration.ts');
await assert.rejects(search.readSearchConfiguration(), /尚未完成装配/);
const { configureBackgroundExecutionRuntime } = load('src/host/composition/configureBackgroundExecutionRuntime.ts');
configureBackgroundExecutionRuntime();
configureBackgroundExecutionRuntime();
const context = await summary.getChatSummaryContext('headless-session');
assert.deepEqual(context.raw.map(item => item.content), ['后台读取的真实历史']);
assert.deepEqual(context.segments, []);
assert.equal(callReads, 1, '后台摘要查询必须保留通话来源端口');

await search.testAndSaveSearchKey('tavily', 'test-headless-key', new AbortController().signal);
await search.updateSearchConfiguration({ kind: 'default', engine: 'tavily' });
const result = await search.executeConfiguredSearch({ query: '后台查询' }, new AbortController().signal);
assert.equal(result.ok, true);
assert.equal(searches.at(-1).options.engine, 'tavily');
assert.equal(searches.at(-1).options.apiKey, 'test-headless-key');
assert.equal(credentials.size, 1, '搜索使用真实凭据适配，仅替换安全存储边界');

runtime.emitChatSummaryChanged('headless-session', 'summary');
assert.equal(scheduled, 0, '后台装配和摘要事实变更都不能激活生成队列');
const queue = load('src/host/runtime/ChatSummaryQueueCoordinator.ts');
queue.setChatSummaryForegroundActive(true);
assert.equal(scheduled, 1, '前台接管后仍能正常调度摘要');
await queue.stopChatSummaryQueueForReset();
assert.equal(cancelled, 1);
database.close();
console.log('后台装配：独立摘要 SQLite 读取、通话来源、搜索配置/凭据和前台摘要激活边界通过。');
