import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
/** 联网工具的公开参数、结果、权限、拆包与取消行为验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapSqlite, createSqliteExecutor, DATABASE_SCHEMA_VERSION } from './helpers/sqlite-bootstrap-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(relative, mocks = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: relative,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputText)((id) => {
    assert.ok(Object.hasOwn(mocks, id), `${relative} 未提供依赖 ${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}

const calls = [];
let nativeResult = { ok: true, data: { items: [{ title: '资料', url: 'https://example.com', snippet: '摘要' }] } };
let pending;
let searchStarted;
let imageStarted;
const native = {
  createRequest: mode => { connectionModes.push(mode); return 'request-1'; },
  cancelRequest: (id) => calls.push(['cancel', id]),
  search: async (...args) => { calls.push(['search', ...args]); searchStarted?.(); return pending ?? nativeResult; },
  readPage: async (...args) => { calls.push(['read', ...args]); return nativeResult; },
  download: async (...args) => { calls.push(['download', ...args]); return nativeResult; },
  downloadImage: async (...args) => { calls.push(['image', ...args]); imageStarted?.(); return pending ?? nativeResult; },
};
const connectionModes = [];
const web = load('src/platform/web/WebTools.ts', {
  expo: { requireNativeModule: () => native },
  'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } delete() { calls.push(['delete-temp', this.uri]); } } },
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
  '@shared/runtime/RuntimeSlot': load('src/shared/runtime/RuntimeSlot.ts'),
});
const searchDomain = load('src/features/webTools/domain/SearchSettings.ts');
const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON');
await bootstrapSqlite(createSqliteExecutor(database));
function removeModelServiceSchema() {
  for (const table of ['auxiliary_model_configs', 'ai_assistants', 'group_chat_admin_configs']) {
    database.exec(`ALTER TABLE ${table} DROP COLUMN service_config_id;`);
  }
  database.exec('DROP TABLE model_service_configs; DROP TABLE model_service_settings;');
}
// 还原 133 的真实结构，保留既有资料，新配置只由 bootstrap 创建。
removeModelServiceSchema();
database.exec(`UPDATE user_profile SET name='保留资料'; DROP TABLE web_search_sources; DROP TABLE web_search_settings;
  CREATE TABLE assistant_nickname_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,
    assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    previous_nickname TEXT, nickname TEXT, acknowledged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  ALTER TABLE raven_cat_ai_schedules DROP COLUMN system_calendar;
  ALTER TABLE ai_assistants DROP COLUMN show_action_steps; ALTER TABLE ai_assistants DROP COLUMN streaming_reply;
  ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit;
  ALTER TABLE group_chat_members DROP COLUMN muted;
  ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id;
  PRAGMA user_version=133;`);
await bootstrapSqlite(createSqliteExecutor(database));
assert.equal(database.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
assert.equal(database.prepare('SELECT name FROM user_profile').get().name, '保留资料');
const sql = createSqliteExecutor(database);
let transactionTail = Promise.resolve();
const coordinated = { ...sql, withExclusiveTransactionAsync(callback) {
  const operation = transactionTail.then(async () => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = await callback(sql); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  });
  transactionTail = operation.catch(() => {});
  return operation;
} };
const { sqliteSearchSettingsRepository } = load('src/features/webTools/infrastructure/SQLiteSearchSettingsRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => coordinated } },
  '../domain/SearchSettings': searchDomain,
});
const credentials = new Map();
let credentialSequence = 0;
const searchRuntime = { settings: sqliteSearchSettingsRepository,
  credentials: { save: async key => { const ref = `key-${credentialSequence++}`; credentials.set(ref, key); return ref; },
  read: async ref => credentials.get(ref) ?? null, delete: async ref => { credentials.delete(ref); } } };
const runtime = load('src/features/webTools/application/WebToolsRuntime.ts', {
  '@shared/runtime/RuntimeSlot': load('src/shared/runtime/RuntimeSlot.ts'), '@platform/web': web,
});
runtime.configureWebToolsRuntime(searchRuntime);
const searchConfiguration = load('src/features/webTools/application/SearchConfiguration.ts', {
  '@platform/web': web, '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
  '../domain/SearchSettings': searchDomain, './WebToolsRuntime': { getWebToolsRuntime: () => searchRuntime },
});
const schema = load('src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);
const endpoint = load('src/platform/ai/moonshotEndpoint.ts');
let officialResponse = () => new Response(JSON.stringify({ search_results: [] }));
const officialRequests = [];
const { MoonshotToolsClient } = load('src/platform/ai/MoonshotToolsClient.ts', {
  './moonshotEndpoint': endpoint,
  '@shared/aiTools': schema,
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
  'expo/fetch': { fetch: async (url, options) => { officialRequests.push({ url, options }); return officialResponse(url, options); } },
});
const kimiTools = load('src/features/webTools/application/KimiOfficialTools.ts', { '@platform/ai': { MoonshotToolsClient } });
const tools = { ...load('src/features/webTools/application/WebAgentTools.ts', { '@platform/web': web, './SearchConfiguration': searchConfiguration }), ...kimiTools };
const { AgentToolRegistry } = load('src/platform/agentRuntime/AgentToolRegistry.ts');
const { AgentToolExecutor } = load('src/platform/agentRuntime/AgentToolExecutor.ts', {
  '@shared/aiTools': schema, './AgentRunState': load('src/platform/agentRuntime/AgentRunState.ts'),
});
const placeholder = (name) => ({ name, definition: { name, description: name, parameters: { type: 'object' } }, execute: async () => ({ success: true }) });
const proxy = new Proxy({}, { get: (_, name) => placeholder(String(name)) });
let defaults = {};
let overrides = [];
const featureNames = ['protocol', 'moments', 'wallet', 'calls', 'memory', 'deviceControl', 'companion', 'phoneTools', 'screenCapture', 'chat', 'stickers', 'togetherListening'];
const registration = load('src/host/composition/agent/createAgentToolRegistry.ts', {
  '@shared/aiTools': load('src/shared/aiTools/ToolCompletionIntent.ts'),
  '@platform/ai': endpoint,
  '@features/media': proxy,
  '@features/moments/composition': {},
  './ApplicationSettingsTools': { applicationSettingsTools: [] },
  './GroupManagementTools': { groupManagementTools: [] },
  './ShareMomentTool': { ShareMomentTool: placeholder('share_moment') },
  ...Object.fromEntries(featureNames.map((name) => [`@features/${name}`, proxy])),
  '@features/phoneTools': new Proxy(load('src/features/phoneTools/toolPackages/ToolPackageCatalog.ts'), {
    get: (target, key) => target[key] ?? placeholder(String(key).startsWith('Xiaohongshu')
      ? String(key).replace(/Tool$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
      : String(key)),
  }),
  '@features/webTools': tools,
  '@features/prompting': { readPromptDefaults: async () => ({ toolPermissions: defaults, appToolPackages: {} }) },
  '@features/assistants': new Proxy({ assistantToolPermissionRepository: { list: async () => overrides } }, {
    get: (target, name) => target[name] ?? placeholder(String(name)),
  }),
  '@features/phoneTools/neteaseComposition': { productionNetEaseChildTools: [] },
  '@platform/agentRuntime': { AgentToolRegistry },
  './LegacyAgentToolAdapter': load('src/host/composition/agent/LegacyAgentToolAdapter.ts', { '@shared/aiTools': {} }),
});

const names = ['web_search', 'web_fetch', 'download_file'];
const config = { enableTools: true, isHostAI: false, triggerSource: 'chat', allowedToolNames: names };
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI(config), names);
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({ ...config, enableTools: false }), []);
for (const name of names) {
  const descriptor = registration.getToolPermissionDescriptors().find((tool) => tool.name === name);
  assert.equal(descriptor.owner, 'webTools');
  assert.equal(descriptor.defaultEnabled, true);
  assert.equal(descriptor.hostOnly, false);
  assert.ok((await registration.resolveAllowedToolNames('ordinary-ai')).includes(name));
}
defaults = { web_search: false };
assert.ok(!(await registration.resolveAllowedToolNames('ordinary-ai')).includes('web_search'));
overrides = [{ toolName: 'web_search', enabled: true }, { toolName: 'download_file', enabled: false }];
const allowed = await registration.resolveAllowedToolNames('ordinary-ai');
assert.ok(allowed.includes('web_search'));
assert.ok(!allowed.includes('download_file'));

const registry = registration.createAgentToolRegistry({ createLegacyContext: () => ({}) });
const { registerToolPackagesForHostRun } = load('src/host/composition/agent/ToolPackageExposure.ts');
const exposure = registerToolPackagesForHostRun({ registry, allowedToolNames: ['web_search', 'web_fetch'],
  bindings: registration.getToolPackageRuntimeBindings(registry), openPackageIds: [] });
assert.deepEqual(exposure.visibleToolNames(), []);
const executor = new AgentToolExecutor(registry);
const controller = new AbortController();
const task = { allowedToolNames: [...names, 'open_tool_package'] };
const context = { runId: 'run', task, toolCallId: 'call', abortSignal: controller.signal };
const execute = async (name, input) => {
  const preparation = executor.prepare({ name, arguments: JSON.stringify(input) }, task);
  assert.equal(preparation.status, 'ready');
  return executor.execute(preparation, context);
};
assert.equal((await execute('open_tool_package', { package_id: 'webTools' })).status, 'success');
assert.deepEqual(exposure.visibleToolNames(), ['web_search', 'web_fetch']);
assert.ok(!exposure.packageToolNames.includes('download_file'));

const result = await execute('web_search', { query: '资料' });
assert.equal(result.status, 'success');
assert.deepEqual(result.data, { ...nativeResult.data, defaultEngine: 'bing', availableEngines: ['bing', 'duckduckgo'] });
assert.ok(result.modelContent.includes('https://example.com'));
assert.deepEqual(calls.at(-1), ['search', 'request-1', '资料', 5, 'bing', null, 'basic', null, false]);
assert.equal(executor.prepare({ name: 'web_search', arguments: '{"query":" "}' }, task).status, 'rejected');
assert.equal(executor.prepare({ name: 'web_search', arguments: '{"query":"资料","limit":11}' }, task).status, 'rejected');
assert.equal(executor.prepare({ name: 'web_search', arguments: '{"query":"资料","include_images":"true"}' }, task).status, 'rejected');
assert.equal(executor.prepare({ name: 'download_file', arguments: '{"url":"https://example.com","directory":"/other"}' }, task).status, 'rejected');

nativeResult = { ok: true, data: { text: '正文', truncated: true } };
assert.equal((await execute('web_fetch', { url: 'https://example.com' })).data.truncated, true);
assert.deepEqual(calls.at(-1), ['read', 'request-1', 'https://example.com', 12000, 0, null, null]);
nativeResult = { ok: true, data: { fileName: '报告-unique.pdf', directory: 'Download/RavenCat AI/', uri: 'content://downloads/1', sizeBytes: 123 } };
const downloaded = await execute('download_file', { url: 'https://example.com/report.pdf' });
assert.equal(downloaded.data.directory, 'Download/RavenCat AI/');
assert.ok(downloaded.modelContent.includes('报告-unique.pdf'));
assert.deepEqual(calls.at(-1), ['download', 'request-1', 'https://example.com/report.pdf', null]);
nativeResult = { ok: false, error: { code: 'WEB_SEARCH_UNAVAILABLE', message: '来源不可用' } };
assert.deepEqual(await execute('web_search', { query: '资料' }), {
  status: 'error', code: 'WEB_SEARCH_UNAVAILABLE', retryable: false, modelContent: '来源不可用。默认来源：bing；可用来源：bing、duckduckgo。需要时可显式指定 engine 换来源或改写关键词。',
});

const cancelled = new AbortController();
cancelled.abort(new Error('已取消'));
const count = calls.length;
const searchOptions = { engine: 'bing', apiKey: null, depth: 'basic', timeRange: null, includeImages: false };
await assert.rejects(web.searchWeb('资料', 5, cancelled.signal, searchOptions), /已取消/u);
assert.equal(calls.length, count);
const cancellingBeforeStart = new AbortController();
const notStarted = web.searchWeb('资料', 5, cancellingBeforeStart.signal, searchOptions);
cancellingBeforeStart.abort(new Error('读取配置期间取消'));
await assert.rejects(notStarted, /读取配置期间取消/);
assert.equal(calls.length, count, '读取连接配置时取消，不创建原生联网请求');
let resolvePending;
pending = new Promise((resolve) => { resolvePending = resolve; });
const running = new AbortController();
const searchEntered = new Promise(resolve => { searchStarted = resolve; });
const operation = web.searchWeb('资料', 5, running.signal, searchOptions);
await searchEntered;
searchStarted = undefined;
running.abort(new Error('运行取消'));
assert.deepEqual(calls.at(-1), ['cancel', 'request-1']);
resolvePending({ ok: true, data: {} });
await assert.rejects(operation, /运行取消/u);
const completed = new AbortController();
pending = undefined;
await web.searchWeb('资料', 5, completed.signal, searchOptions);
const completedCount = calls.length;
completed.abort();
assert.equal(calls.length, completedCount, '完成后取消监听必须释放');
let resolveImage;
pending = new Promise(resolve => { resolveImage = resolve; });
const imageController = new AbortController();
const imageEntered = new Promise(resolve => { imageStarted = resolve; });
const imageOperation = web.downloadWebImage('https://example.com/cat.png', null, imageController.signal);
await imageEntered;
imageStarted = undefined;
imageController.abort(new Error('取消图片下载'));
resolveImage({ ok: true, data: { uri: 'file:///temp-image' } });
await assert.rejects(imageOperation, /取消图片下载/);
assert.deepEqual(calls.at(-1), ['delete-temp', 'file:///temp-image'], '原生返回与取消竞态不能留下失去 owner 的暂存图');

// 同一工具允许显式换来源；未授权来源、未允许的深度与不支持的选项不会发起网络请求。
pending = undefined;
nativeResult = { ok: true, data: { engine: 'duckduckgo', source: 'DuckDuckGo', query: '资料', items: [] } };
assert.equal((await execute('web_search', { query: '资料', engine: 'duckduckgo', time_range: 'week' })).status, 'success');
assert.deepEqual(calls.at(-1), ['search', 'request-1', '资料', 5, 'duckduckgo', null, 'basic', 'week', false]);
for (const input of [{ engine: 'tavily' }, { engine: 'brave' }, { depth: 'advanced' }, { time_range: 'day' },
  { include_images: true }, { engine: 'duckduckgo', include_images: true }]) {
  const before = calls.length;
  assert.equal((await execute('web_search', { query: '资料', ...input })).status, 'error');
  assert.equal(calls.length, before);
}
assert.equal(executor.prepare({ name: 'web_search', arguments: '{"query":"资料","engine":"unknown"}' }, task).status, 'rejected');
assert.equal(executor.prepare({ name: 'web_search', arguments: '{"query":"资料","api_key":"secret"}' }, task).status, 'rejected');
assert.equal(executor.prepare({ name: 'web_fetch', arguments: '{"url":"https://example.com","start_char":-1}' }, task).status, 'rejected');
await execute('web_fetch', { url: 'https://example.com', start_char: 12000, find: '目标', document_version: 'a'.repeat(64) });
assert.deepEqual(calls.at(-1), ['read', 'request-1', 'https://example.com', 12000, 12000, '目标', 'a'.repeat(64)]);

const testSignal = new AbortController().signal;
let initial = await searchRuntime.settings.read();
assert.equal(initial.defaultEngine, 'bing');
assert.equal(initial.connectionMode, 'direct');
assert.equal(connectionModes.at(-1), 'direct');
await searchConfiguration.updateSearchConfiguration({ kind: 'connection', mode: 'system' });
assert.equal((await searchConfiguration.readSearchConfiguration()).connectionMode, 'system');
await web.searchWeb('代理搜索', 1, testSignal, { engine: 'bing', apiKey: null, depth: 'basic', timeRange: null, includeImages: false });
await web.readWebPage('https://example.com', 1000, testSignal);
await web.downloadWebFile('https://example.com/document.pdf', null, testSignal);
await web.downloadWebImage('https://example.com/image.png', null, testSignal);
assert.deepEqual(connectionModes.slice(-4), ['system', 'system', 'system', 'system'], '搜索、读取和两种下载统一读取已持久化连接方式');
await searchConfiguration.updateSearchConfiguration({ kind: 'connection', mode: 'direct' });
initial = await searchRuntime.settings.read();
await assert.rejects(searchConfiguration.selectSearchSource('tavily'), /密钥/);
assert.deepEqual((await searchConfiguration.readSearchSelection()).models.map(model => model.id), ['bing', 'duckduckgo']);
await assert.rejects(searchConfiguration.testAndSaveSearchKey('tavily', 'bad key', testSignal), /有效/);
assert.deepEqual(await searchRuntime.settings.read(), initial);
nativeResult = { ok: false, error: { code: 'WEB_API_AUTH_FAILED', message: '密钥无效' } };
await assert.rejects(searchConfiguration.testAndSaveSearchKey('tavily', 'test-tavily-key', testSignal), /密钥无效/);
assert.deepEqual(await searchRuntime.settings.read(), initial);
assert.equal(credentials.size, 0);

nativeResult = { ok: true, data: { engine: 'tavily', source: 'Tavily', items: [] } };
await searchConfiguration.testAndSaveSearchKey('tavily', 'test-tavily-key', testSignal);
assert.equal((await searchRuntime.settings.read()).defaultEngine, 'tavily', '首次成功配置自有服务自动设为默认');
assert.equal(calls.at(-1)[8], false, '连接测试不请求图片候选');
const configuredResult = await execute('web_search', { query: '资料' });
assert.equal(calls.at(-1)[4], 'tavily');
assert.equal(calls.at(-1)[5], 'test-tavily-key');
assert.ok(!configuredResult.modelContent.includes('test-tavily-key'));
assert.ok(!JSON.stringify(await searchConfiguration.readSearchConfiguration()).includes('credentialRef'));
assert.equal((await searchConfiguration.readSearchConfiguration()).sources.find(source => source.engine === 'tavily').apiKey, 'test-tavily-key');
const beforeRetest = await searchRuntime.settings.read();
await searchConfiguration.testAndSaveSearchKey('tavily', 'test-tavily-key', testSignal);
assert.deepEqual(await searchRuntime.settings.read(), beforeRetest, '测试未修改的密钥不重复发布配置');
await assert.rejects(searchConfiguration.testAndSaveSearchKey('tavily', '', testSignal), /有效/, '清空输入后不能静默使用已保存密钥');
await searchConfiguration.testAndSaveSearchKey('brave', 'test-brave-key', testSignal);
assert.equal((await searchRuntime.settings.read()).defaultEngine, 'tavily', '后加服务不覆盖已有默认');
await searchConfiguration.updateSearchConfiguration({ kind: 'default', engine: 'brave' });
database.prepare("UPDATE web_search_sources SET enabled=0 WHERE engine='tavily'").run();
await searchConfiguration.selectSearchSource('tavily');
assert.equal((await searchRuntime.settings.read()).sources.find(source => source.engine === 'tavily').enabled, true,
  '选择已有配置时在同一事务中启用，不需要独立来源开关');
assert.equal((await searchConfiguration.readSearchSelection()).selectedModelId, 'tavily');
await searchConfiguration.selectSearchSource('brave');
await searchConfiguration.testAndSaveSearchKey('tavily', 'replacement-key', testSignal);
assert.equal((await searchRuntime.settings.read()).defaultEngine, 'brave');
const imageCandidates = [{ url: 'https://images.example.com/whale.jpg?size=1200&signature=abc',
  description: '搜索服务描述的鲸鱼照片', sourceUrl: 'https://example.com/whale' }];
nativeResult = { ok: true, data: { engine: 'tavily', source: 'Tavily', items: [], images: imageCandidates } };
const beforeImageSearch = calls.length;
const unsupportedImages = await execute('web_search', { query: '鲸鱼', include_images: true });
assert.equal(unsupportedImages.code, 'WEB_SEARCH_OPTION_UNAVAILABLE');
assert.equal(calls.length, beforeImageSearch, '图片选项不隐式切换默认来源');
assert.ok(unsupportedImages.modelContent.includes('tavily'));
const searchedImages = await execute('web_search', { query: '鲸鱼', engine: 'tavily', include_images: true, limit: 3 });
assert.equal(searchedImages.status, 'success');
assert.deepEqual(calls.at(-1), ['search', 'request-1', '鲸鱼', 3, 'tavily', 'replacement-key', 'basic', null, true]);
assert.deepEqual(searchedImages.data.images, imageCandidates);
assert.deepEqual(JSON.parse(searchedImages.modelContent.split('\n').slice(1).join('\n')).images, imageCandidates,
  '候选图片地址完整进入模型 observation，保留尺寸和签名参数');
assert.equal(calls.length, beforeImageSearch + 1, '请求图片候选只执行搜索，不自动下载');
assert.ok(![...credentials.values()].includes('test-tavily-key'), '替换成功后回收旧凭据');
assert.equal((await execute('web_search', { query: '资料', engine: 'tavily', depth: 'advanced' })).status, 'error');
await searchConfiguration.updateSearchConfiguration({ kind: 'advanced', allowed: true });
assert.equal((await execute('web_search', { query: '资料', engine: 'tavily', depth: 'advanced' })).status, 'success');
assert.equal(calls.at(-1)[6], 'advanced');

// 测试期间修改配置：迟到成功不能覆盖新配置，未发布的新凭据必须回收。
let releaseTest;
pending = new Promise(resolve => { releaseTest = resolve; });
let enterTest;
const testEntered = new Promise(resolve => { enterTest = resolve; });
searchStarted = enterTest;
const lateSave = searchConfiguration.testAndSaveSearchKey('tavily', 'late-key', testSignal);
await testEntered;
searchStarted = undefined;
await searchConfiguration.updateSearchConfiguration({ kind: 'connection', mode: 'system' });
const beforeLateResult = await searchRuntime.settings.read();
releaseTest(nativeResult);
await assert.rejects(lateSave, /配置已改变/);
assert.deepEqual(await searchRuntime.settings.read(), beforeLateResult);
assert.ok(![...credentials.values()].includes('late-key'));
pending = undefined;

// 恢复时安全存储可能不在本机；错误必须可见，不自动使用免费来源冒充成功。
credentials.clear();
const missing = await execute('web_search', { query: '资料' });
assert.equal(missing.code, 'WEB_SEARCH_CREDENTIAL_MISSING');
const missingConfiguration = await searchConfiguration.readSearchConfiguration();
assert.equal(missingConfiguration.sources.find(source => source.engine === 'tavily').configured, false);
assert.equal(missingConfiguration.sources.find(source => source.engine === 'tavily').apiKey, '');
const missingSelection = await searchConfiguration.readSearchSelection();
assert.equal(missingSelection.status, 'unavailable');
assert.ok(!missingSelection.models.some(model => model.id === 'brave'));
await searchConfiguration.selectSearchSource(null);
assert.equal((await searchRuntime.settings.read()).defaultEngine, null);
assert.equal((await execute('web_search', { query: '资料' })).code, 'WEB_SEARCH_NOT_CONFIGURED');
assert.equal((await searchConfiguration.readSearchSelection()).status, 'unconfigured');
await searchConfiguration.updateSearchConfiguration({ kind: 'default', engine: 'duckduckgo' });
await searchConfiguration.updateSearchConfiguration({ kind: 'connection', mode: 'direct' });
const saved = await searchRuntime.settings.read();
// 149 保留搜索来源与密钥引用，150 只补入直连默认值。
removeModelServiceSchema();
database.exec('ALTER TABLE web_search_settings DROP COLUMN connection_mode; PRAGMA user_version=149;');
await bootstrapSqlite(createSqliteExecutor(database));
assert.deepEqual(await searchRuntime.settings.read(), saved);
await searchConfiguration.updateSearchConfiguration({ kind: 'connection', mode: 'system' });
const savedProxySettings = await searchRuntime.settings.read();
await bootstrapSqlite(createSqliteExecutor(database));
assert.deepEqual(await searchRuntime.settings.read(), savedProxySettings, '再次启动不覆盖代理或来源配置');
assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
// 官方工具走相同权限、拆包与 Executor；协议响应在 Provider 边界验证。
const kimiNames = ['kimi_web_search', 'kimi_web_fetch', 'kimi_mew'];
for (const address of ['https://api.moonshot.cn', 'https://api.moonshot.ai/v1/', ' https://API.MOONSHOT.CN/v1 ']) {
  assert.ok(endpoint.resolveMoonshotAPIBaseURL(address));
  assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({ ...config, apiBaseUrl: address, allowedToolNames: kimiNames }), kimiNames);
}
for (const address of ['https://api.moonshot.cn.evil.test/v1', 'https://evil.test/kimi', 'http://api.moonshot.cn',
  'https://api.moonshot.cn:8443/v1', 'https://user@api.moonshot.cn/v1', 'https://api.moonshot.cn/proxy/v1',
  'https://api.moonshot.cn/v1?proxy=yes', 'https://api.moonshot.cn/v1#proxy', undefined, 'invalid']) {
  assert.equal(endpoint.resolveMoonshotAPIBaseURL(address), null);
  assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({ ...config, apiBaseUrl: address, allowedToolNames: kimiNames }), []);
}
assert.throws(() => new MoonshotToolsClient({ baseURL: 'https://evil.test/kimi', apiKey: 'secret-test-key' }));
for (const name of kimiNames) {
  assert.equal(registration.getToolPermissionDescriptors().find(tool => tool.name === name).defaultEnabled, false);
  assert.ok(!(await registration.resolveAllowedToolNames('ordinary-ai')).includes(name));
}
defaults = { kimi_web_search: true, kimi_web_fetch: true };
overrides = [{ toolName: 'kimi_web_fetch', enabled: false }];
const kimiPolicy = { ...config, apiBaseUrl: 'https://api.moonshot.cn/v1', allowedToolNames: await registration.resolveAllowedToolNames('ordinary-ai') };
assert.ok(registration.getRuntimeAllowedToolNamesForAI(kimiPolicy).includes('kimi_web_search'));
assert.ok(!registration.getRuntimeAllowedToolNamesForAI(kimiPolicy).includes('kimi_web_fetch'));
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({ ...kimiPolicy, enableTools: false }), []);
const officialRegistry = registration.createAgentToolRegistry({ createLegacyContext: context => ({
  aiConfig: { apiBaseUrl: 'https://api.moonshot.cn', apiKey: 'secret-test-key' }, abortSignal: context.abortSignal,
}) });
const officialExecutor = new AgentToolExecutor(officialRegistry);
const officialTask = { allowedToolNames: [...kimiNames, 'open_tool_package'] };
const officialController = new AbortController();
const officialContext = { ...context, task: officialTask, abortSignal: officialController.signal };
const officialExposure = registerToolPackagesForHostRun({ registry: officialRegistry, allowedToolNames: kimiNames,
  bindings: registration.getToolPackageRuntimeBindings(officialRegistry), openPackageIds: [], directToolNames: ['kimi_web_search'] });
assert.deepEqual(officialExposure.visibleToolNames(), ['kimi_web_search']);
await officialRegistry.get('open_tool_package').execute({ package_id: 'kimiOfficial' }, officialContext);
assert.deepEqual(officialExposure.visibleToolNames(), kimiNames);
const blockedRegistry = registration.createAgentToolRegistry({ createLegacyContext: () => ({}) });
const blockedExposure = registerToolPackagesForHostRun({ registry: blockedRegistry, allowedToolNames: [],
  bindings: registration.getToolPackageRuntimeBindings(blockedRegistry), openPackageIds: ['kimiOfficial'], directToolNames: kimiNames });
assert.deepEqual(blockedExposure.visibleToolNames(), []);
assert.ok(!blockedExposure.instructions().catalog.includes('kimi_web_search'));
assert.equal(officialExecutor.prepare({ name: 'kimi_web_search', arguments: '{"query":"新闻"}' }, { allowedToolNames: [] }).status, 'rejected');
assert.equal(officialExecutor.prepare({ name: 'kimi_web_search', arguments: '{"query":" "}' }, officialTask).status, 'rejected');
assert.equal(officialExecutor.prepare({ name: 'kimi_web_fetch', arguments: '{"url":"file:///secret"}' }, officialTask).status, 'rejected');
const runOfficialTool = async (name, input) => {
  const prepared = officialExecutor.prepare({ name, arguments: JSON.stringify(input) }, officialTask);
  assert.equal(prepared.status, 'ready');
  return officialExecutor.execute(prepared, officialContext);
};
officialResponse = () => new Response(JSON.stringify({ search_results: [{ title: '文档', url: 'https://example.com', snippet: '正文片段', site_name: '示例', date: '' }] }));
const officialSearch = await runOfficialTool('kimi_web_search', { query: '新闻' });
assert.equal(officialSearch.status, 'success');
assert.ok(officialSearch.modelContent.includes('正文片段'));
assert.ok(!officialSearch.modelContent.includes('secret-test-key'));
assert.equal(officialRequests.at(-1).url, 'https://api.moonshot.cn/v1/tools/search');
assert.deepEqual(JSON.parse(officialRequests.at(-1).options.body), { text_query: '新闻', limit: 5, include_content: false, timeout_seconds: 30 });
assert.equal(officialRequests.at(-1).options.headers.Authorization, 'Bearer secret-test-key');
assert.equal(officialRequests.at(-1).options.redirect, 'error');
officialResponse = () => new Response(JSON.stringify({ url: 'https://example.com', title: '文档', markdown: '文'.repeat(20001) }));
const officialFetch = await runOfficialTool('kimi_web_fetch', { url: 'https://example.com' });
assert.equal(officialFetch.status, 'success');
assert.equal(officialFetch.data.markdown.length, 20000);
assert.equal(officialFetch.data.truncated, true);
assert.equal(officialRequests.at(-1).url, 'https://api.moonshot.cn/v1/tools/fetch');
officialResponse = () => new Response('secret-test-key', { status: 401 });
const unauthorized = await runOfficialTool('kimi_web_search', { query: '新闻' });
assert.equal(unauthorized.code, 'KIMI_TOOLS_HTTP_401');
assert.ok(!unauthorized.modelContent.includes('secret-test-key'));
officialResponse = () => new Response('{broken');
assert.equal((await runOfficialTool('kimi_web_search', { query: '新闻' })).code, 'KIMI_TOOLS_INVALID_RESPONSE');
officialResponse = () => new Response(JSON.stringify({ search_results: [{}] }));
assert.equal((await runOfficialTool('kimi_web_search', { query: '新闻' })).code, 'KIMI_TOOLS_INVALID_RESPONSE');
officialResponse = () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
assert.equal((await runOfficialTool('kimi_web_fetch', { url: 'https://example.com' })).code, 'KIMI_TOOLS_RESPONSE_TOO_LARGE');
// 使用与本地名字不同的官方函数，验证发现、参数修正与固定 Formula 路由。
let mewFunctions = [{ type: 'function', function: { name: 'random_cat_blessing', description: '随机猫叫',
  parameters: { type: 'object', properties: { language: { type: 'string', enum: ['zh'] } }, required: ['language'], additionalProperties: false } } }];
let mewFiber = { status: 'succeeded', context: { output: '喵呜～祝你今天开心！' } };
officialResponse = (url, options) => {
  if (url.endsWith('/tools')) {
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify({ tools: mewFunctions }));
  }
  assert.equal(url, 'https://api.moonshot.cn/v1/formulas/moonshot/mew:latest/fibers');
  assert.equal(options.method, 'POST');
  return new Response(JSON.stringify(mewFiber));
};
const beforeMew = officialRequests.length;
const needsMewInput = await runOfficialTool('kimi_mew', {});
assert.equal(needsMewInput.status, 'success');
assert.equal(needsMewInput.data.kind, 'input_required');
assert.equal(officialRequests.length, beforeMew + 1, '缺少官方参数时不能执行 fiber');
assert.ok(needsMewInput.modelContent.includes('language'));
const mewResult = await runOfficialTool('kimi_mew', { arguments: { language: 'zh' } });
assert.equal(mewResult.status, 'success');
assert.equal(mewResult.modelContent, '喵呜～祝你今天开心！');
assert.ok(!mewResult.modelContent.includes('外部资料'), '趣味工具直接返回结果，不套用网页资料包装');
assert.deepEqual(JSON.parse(officialRequests.at(-1).options.body), { name: 'random_cat_blessing', arguments: '{"language":"zh"}' });
const beforeUnknownMewFunction = officialRequests.length;
assert.equal((await runOfficialTool('kimi_mew', { function_name: 'memory', arguments: {} })).data.kind, 'input_required');
assert.equal(officialRequests.length, beforeUnknownMewFunction + 1, '不能调用官方声明以外的函数');
mewFunctions = [{ type: 'function', function: { name: 'cat_blessing', description: '随机猫叫', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
assert.equal((await runOfficialTool('kimi_mew', {})).modelContent, '喵呜～祝你今天开心！', '无参官方函数可以直接调用');
const encryptedMew = '----MOONSHOT ENCRYPTED BEGIN----example----MOONSHOT ENCRYPTED END----';
mewFiber = { status: 'succeeded', context: { encrypted_output: encryptedMew } };
assert.equal((await runOfficialTool('kimi_mew', {})).modelContent, encryptedMew, 'protected 输出原样回灌');
mewFiber = { status: 'failed', context: { output: '不能作为成功结果' } };
assert.equal((await runOfficialTool('kimi_mew', {})).code, 'KIMI_MEW_EXECUTION_FAILED');
mewFunctions = [{ type: 'function', function: { name: 'bad', description: '', parameters: { type: 'object', properties: { invalid: { type: 'nonsense' } } } } }];
const beforeBadMewSchema = officialRequests.length;
assert.equal((await runOfficialTool('kimi_mew', {})).code, 'KIMI_TOOLS_INVALID_SCHEMA');
assert.equal(officialRequests.length, beforeBadMewSchema + 1);
officialResponse = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
const pendingOfficial = runOfficialTool('kimi_web_search', { query: '新闻' });
officialController.abort();
await assert.rejects(pendingOfficial);
const requestsBeforeCancel = officialRequests.length;
await assert.rejects(runOfficialTool('kimi_web_search', { query: '新闻' }));
assert.equal(officialRequests.length, requestsBeforeCancel, '取消后不得继续触网');

// 搜索凭据随真实数据库快照往返，Host 装配负责选择 snapshot / 活动库。
{
  const tavilyRef = 'web.search.11111111-1111-4111-8111-111111111111';
  const braveRef = 'web.search.22222222-2222-4222-8222-222222222222';
  const activeRef = 'web.search.33333333-3333-4333-8333-333333333333';
  const secureValues = new Map([[tavilyRef, 'tavily-fixture'], [braveRef, 'brave-fixture'], [activeRef, 'active-fixture']]);
  let failedReference = null;
  const backupCredentials = load('src/features/webTools/infrastructure/SecureSearchCredentialStore.ts', {
    'expo-crypto': { randomUUID: () => { throw new Error('恢复不得创建新引用'); } },
    'expo-secure-store': {
      getItemAsync: async reference => secureValues.get(reference) ?? null,
      setItemAsync: async (reference, key) => {
        if (reference === failedReference) throw new Error('安全存储写入失败');
        secureValues.set(reference, key);
      },
      deleteItemAsync: async reference => { secureValues.delete(reference); },
    },
  });
  database.exec(`UPDATE web_search_sources SET credential_ref=NULL, enabled=CASE WHEN engine IN ('bing', 'duckduckgo') THEN 1 ELSE 0 END;
    UPDATE web_search_sources SET credential_ref='${tavilyRef}' WHERE engine='tavily';
    UPDATE web_search_sources SET credential_ref='${braveRef}', enabled=0 WHERE engine='brave';`);
  const stableSettings = load('src/features/backup/infrastructure/stableSettingsBackupState.ts');
  const persistence = { databaseCoordinator: {
    openTaskExecutor: () => ({ getAllAsync: async () => [{ credential_ref: activeRef }] }),
    readSnapshotAsync: async (_task, uri, callback) => {
      assert.equal(uri, 'file:///snapshot.db');
      return callback(sql);
    },
  } };
  const credentialRepository = load('src/features/webTools/infrastructure/SQLiteSearchSettingsRepository.ts', {
    '@platform/persistence': persistence, '../domain/SearchSettings': searchDomain,
  });
  const { ApplicationBackupSourceGateway } = load('src/features/backup/infrastructure/ApplicationBackupSourceGateway.ts', {
    '@platform/persistence': {},
    '@platform/device': { getPersistentMediaRootUri: () => 'file:///source/persistent-media/' },
    '@platform/device/DeviceMediaService': {},
    '@features/media': {},
    '@shared/theme': {
      loadStoredThemeBackupState: async () => ({}),
      parseStoredThemeBackupState: value => value,
      restoreStoredThemeBackupState: async () => {},
    },
    '../../../../modules/ravencat-floating-layer': {
      getBubbleSkinBackupSource: async () => ({ settingsJson: '{}', rootUri: 'file:///skins/' }),
      validateBubbleSkinBackupSettings: async () => {},
      restoreBubbleSkinBackupSettings: async () => {},
    },
    './stableSettingsBackupState': stableSettings,
  });
  const { createBackupSourceGateway } = load('src/host/composition/createBackupSourceGateway.ts', {
    '@platform/persistence': persistence,
    '@features/backup/composition': { ApplicationBackupSourceGateway },
    '@features/media/composition': { SQLiteMediaAssetRepository: class { async listBackupAssets() { return []; } } },
    '@features/calls/composition': { CALL_SNAPSHOT_BACKUP_EXCLUSIONS: [], callRepository: { assertBackupSnapshotHasNoFiles: async () => {} } },
    '@features/webTools/composition': { ...credentialRepository, ...backupCredentials },
  });
  const gateway = createBackupSourceGateway();
  const incoming = await gateway.readNonDatabaseSources('file:///snapshot.db');
  const payload = JSON.parse(incoming.stableSettingsJson);
  assert.deepEqual(new Map(payload.searchCredentials.map(entry => [entry.reference, entry.key])), new Map([
    [tavilyRef, 'tavily-fixture'], [braveRef, 'brave-fixture'],
  ]), '包含已停用来源，排除活动库新引用及其他 SecureStore 数据');
  await gateway.validateStableSettingsJson(incoming.stableSettingsJson, 'file:///skins/', 'file:///media/', 'file:///snapshot.db');
  const rollbackJson = await gateway.exportStableSettingsJson();
  assert.deepEqual(JSON.parse(rollbackJson).searchCredentials, [{ reference: activeRef, key: 'active-fixture' }]);

  secureValues.clear();
  await gateway.restoreStableSettingsJson(incoming.stableSettingsJson);
  assert.equal(secureValues.get(tavilyRef), 'tavily-fixture', '换机空安全存储恢复 Tavily Key');
  assert.equal(secureValues.get(braveRef), 'brave-fixture', '换机空安全存储恢复 Brave Key');
  const restoredConfiguration = load('src/features/webTools/application/SearchConfiguration.ts', {
    '@platform/web': web, '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
    '../domain/SearchSettings': searchDomain,
    './WebToolsRuntime': { getWebToolsRuntime: () => ({
      settings: sqliteSearchSettingsRepository, credentials: backupCredentials.secureSearchCredentialStore,
    }) },
  });
  const restoredSettings = await restoredConfiguration.readSearchConfiguration();
  assert.equal(restoredSettings.sources.find(source => source.engine === 'tavily').apiKey, 'tavily-fixture');
  assert.equal(restoredSettings.sources.find(source => source.engine === 'brave').configured, true);
  assert.equal((await sqliteSearchSettingsRepository.read()).sources.find(source => source.engine === 'brave').enabled, false, '恢复凭据不改变启用状态');
  await gateway.restoreStableSettingsJson(incoming.stableSettingsJson);
  assert.equal(secureValues.size, 2, '重复恢复不创建新引用');

  for (const entries of [
    null, [{ reference: 'mcp.token', key: 'other' }],
    [payload.searchCredentials[0], payload.searchCredentials[0]],
    [{ reference: tavilyRef, key: 'invalid key' }, payload.searchCredentials[1]],
    [payload.searchCredentials[0]],
    [...payload.searchCredentials, { reference: activeRef, key: 'extra' }],
  ]) {
    await assert.rejects(gateway.validateStableSettingsJson(JSON.stringify({ ...payload, searchCredentials: entries }),
      'file:///skins/', 'file:///media/', 'file:///snapshot.db'), /备份搜索凭据/);
  }
  const oldPayload = { ...payload }; delete oldPayload.searchCredentials;
  await gateway.validateStableSettingsJson(JSON.stringify(oldPayload), 'file:///skins/', 'file:///media/', 'file:///snapshot.db');
  await gateway.restoreStableSettingsJson(JSON.stringify(oldPayload));
  assert.equal(secureValues.get(tavilyRef), 'tavily-fixture', '旧包不改变本机搜索凭据');

  // 同名引用部分写入后失败，旧快照恢复已有值及原本缺失的状态。
  secureValues.set(tavilyRef, 'original-key');
  secureValues.delete(braveRef);
  const original = await backupCredentials.readSearchCredentialsBackup([tavilyRef, braveRef]);
  assert.equal(original[1].key, null);
  failedReference = braveRef;
  await assert.rejects(gateway.restoreStableSettingsJson(incoming.stableSettingsJson), /安全存储写入失败/);
  failedReference = null;
  await gateway.restoreStableSettingsJson(JSON.stringify({ ...payload, searchCredentials: original }));
  assert.equal(secureValues.get(tavilyRef), 'original-key');
  assert.equal(secureValues.has(braveRef), false);
  await gateway.restoreStableSettingsJson(rollbackJson);
  assert.equal(secureValues.get(activeRef), 'active-fixture');
}

database.close();
console.log('联网工具权限、取消、多来源切换、网页读取、密钥隔离、配置竞态、数据库升级、搜索凭据备份恢复与回滚，以及 Kimi 官方地址识别、拆包特批、REST 与 mew Formula 协议边界验证通过。');
