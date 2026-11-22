import { repoRoot as root } from '../helpers/repo-root.mjs';
import { agentToolSchemaDependencies } from '../helpers/agent-tool-schema-dependencies.mjs';
/** 验证工具包实际暴露与执行边界，覆盖两种模型传输形式。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const cache = new Map();
function load(relativePath) {
  if (cache.has(relativePath)) return cache.get(relativePath);
  const module = { exports: {} };
  cache.set(relativePath, module.exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', 'module', code)((specifier) => {
    if (Object.hasOwn(agentToolSchemaDependencies, specifier)) return agentToolSchemaDependencies[specifier];
    if (specifier === '@shared/aiTools') return load('src/shared/aiTools/AgentToolInputSchema.ts');
    assert.ok(specifier.startsWith('.'), `未声明依赖：${specifier}`);
    return load(path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier + '.ts')));
  }, module.exports, module);
  return module.exports;
}
const { AgentRuntime } = load('src/platform/agentRuntime/AgentRuntime.ts');
const { AgentToolRegistry } = load('src/platform/agentRuntime/AgentToolRegistry.ts');
const { registerToolPackagesForHostRun } = load('src/host/composition/agent/ToolPackageExposure.ts');
const { AgentToolExecutor } = load('src/platform/agentRuntime/AgentToolExecutor.ts');
function createFixture(allowedToolNames = ['read_memory', 'open_app', 'netease_search_songs'], openPackageIds = [], directToolNames = []) {
  const registry = new AgentToolRegistry();
  const calls = [];
  const bindings = [['memory', 'read_memory'], ['memory', 'remember_memory'], ['deviceControl', 'open_app'], ['neteaseMusic', 'netease_search_songs']].map(([packageId, name]) => {
    const tool = {
      descriptor: { name, description: `简介 ${name}`, inputSchema: {
        type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
      }, owner: packageId, source: 'local', risk: 'safe_read', idempotency: 'idempotent' },
      execute: async (input) => { calls.push({ name, input }); return { status: 'success', data: input, modelContent: '查询成功' }; },
    };
    registry.register(tool);
    return { packageId, tool };
  });
  const exposure = registerToolPackagesForHostRun({ registry, allowedToolNames, bindings, openPackageIds, directToolNames });
  return { registry, exposure, calls, allowedToolNames: [...allowedToolNames, ...exposure.metaToolNames] };
}
let callId = 0;
function call(name, args) { return { id: `call-${++callId}`, name, arguments: JSON.stringify(args) }; }
function turn(calls = [], text = '') {
  return { historyItems: [{ role: 'assistant', content: text, reasoningText: '', toolCalls: calls }],
    assistantText: text, reasoningText: '', toolCalls: calls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: calls.length ? 'tool_calls' : 'stop' };
}
async function run(fixture, turns, transport = 'complete', overrides = {}) {
  const requests = [];
  const runtime = new AgentRuntime({ registry: fixture.registry, modelGateway: { runTurn: async (request) => {
    requests.push({ names: request.tools.map(({ name }) => name), tools: request.tools });
    const result = turns[requests.length - 1];
    assert.ok(result, '缺少脚本模型输出');
    return result;
  } } });
  const result = await runtime.run({ runId: 'package-run', task: {
    id: 'package-task', type: 'chat_reply', source: 'chat', assistantId: 'ai1', sessionId: 's1', goal: '验证拆包',
    allowedToolNames: fixture.allowedToolNames, modelTransport: transport, maxSteps: 8, maxToolCalls: 12,
    maxToolCallsPerStep: 3, createdAt: new Date().toISOString(),
  }, initialHistory: [], resolveVisibleToolNames: () => [...fixture.exposure.metaToolNames, ...fixture.exposure.visibleToolNames()], ...overrides });
  return { result, requests };
}
for (const transport of ['complete', 'stream']) {
  // 特批可在首次请求直接调用；同包剩余工具仍需拆包，展开不重复暴露特批项。
  const directFixture = createFixture(['read_memory', 'remember_memory', 'open_app'], [], ['read_memory']);
  const directCatalog = directFixture.exposure.instructions().catalog;
  assert.ok(directCatalog.indexOf('【用户特批工具】') < directCatalog.indexOf('【本次运行的工具包用途目录】'));
  assert.equal(directCatalog.split('"name":"read_memory"').length - 1, 1);
  assert.doesNotMatch(directCatalog, /简介 |"description"/u, '目录和特批段不重复注入逐工具说明');
  const memoryPackage = directCatalog.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find(({ id }) => id === 'memory');
  assert.deepEqual(memoryPackage.tools, ['remember_memory'], '目录只列需要拆包的已授权工具名');
  const directRun = await run(directFixture, [
    turn([call('read_memory', { query: '直接回忆' }), call('open_tool_package', { package_id: 'memory' })]),
    turn([call('remember_memory', { query: '新记忆' })]), turn([], '完成'),
  ], transport);
  assert.equal(directRun.result.terminalCode, 'COMPLETED');
  assert.deepEqual(new Set(directRun.requests[0].names), new Set(['open_tool_package', 'close_tool_package', 'read_memory']));
  assert.equal(directRun.requests[0].tools.find(({ name }) => name === 'read_memory').description, '简介 read_memory', '特批工具完整说明由 schema 提供');
  assert.deepEqual(new Set(directRun.requests[1].names), new Set(['open_tool_package', 'close_tool_package', 'read_memory', 'remember_memory']));
  assert.equal(directRun.requests[1].names.length, 4, '拆包不得重复暴露特批工具');
  assert.equal(directFixture.exposure.instructions().catalog, directCatalog);
  assert.deepEqual(directFixture.calls.map(({ name }) => name), ['read_memory', 'remember_memory']);
  const fixture = createFixture();
  assert.deepEqual(fixture.exposure.visibleToolNames(), []);
  const initialInstructions = fixture.exposure.instructions();
  assert.match(initialInstructions.catalog, /网易云音乐/u);
  assert.match(initialInstructions.catalog, /whenToUse/u);
  assert.match(initialInstructions.catalog, /read_memory/u, '未拆包时保留工具名作为选包线索');
  assert.doesNotMatch(initialInstructions.catalog, /简介 |"description"/u);
  assert.doesNotMatch(initialInstructions.catalog, /"properties"|"required"|"state"/u);
  const { result, requests } = await run(fixture, [
    turn([call('open_tool_package', { package_id: 'memory' }), call('open_tool_package', { package_id: 'neteaseMusic' })]),
    turn([call('read_memory', { query: '记忆' }), call('netease_search_songs', { query: '音乐' })]),
    turn([], '正式回复'),
  ], transport);
  assert.equal(result.terminalCode, 'COMPLETED');
  assert.deepEqual(requests[0].names, ['open_tool_package', 'close_tool_package']);
  assert.deepEqual(new Set(requests[1].names), new Set(['open_tool_package', 'close_tool_package', 'read_memory', 'netease_search_songs']));
  assert.deepEqual(requests[1].tools.find(({ name }) => name === 'read_memory').inputSchema.required, ['query']);
  assert.equal(requests[1].tools.find(({ name }) => name === 'read_memory').description, '简介 read_memory', '拆包后完整说明仍随 schema 提供');
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(result.steps[0].toolCalls.map(({ outcome }) => outcome.metadata.toolPackageChange), [
    { packageId: 'memory', action: 'open' }, { packageId: 'neteaseMusic', action: 'open' },
  ]);
  const openedInstructions = fixture.exposure.instructions();
  assert.equal(openedInstructions.catalog, initialInstructions.catalog, '拆包不得改变包级用途目录及工具名');
  assert.deepEqual(openedInstructions, initialInstructions, '拆包状态由 schema 与 observation 表达，固定提示词保持不变');
  assert.equal(createFixture(undefined, ['memory', 'neteaseMusic']).exposure.instructions().catalog,
    initialInstructions.catalog, '后续回合读取展开事实不得改变固定目录');

  // 主动收起与重新拆包只影响下一请求；固定目录及控制工具 schema 不随状态变化。
  const managed = createFixture(undefined, ['memory']);
  const managedCatalog = managed.exposure.instructions().catalog;
  const switched = await run(managed, [
    turn([call('close_tool_package', { package_id: 'memory' }), call('open_tool_package', { package_id: 'neteaseMusic' })]),
    turn([call('netease_search_songs', { query: '继续听歌' })]),
    turn([call('close_tool_package', { package_id: 'neteaseMusic' }), call('open_tool_package', { package_id: 'memory' })]),
    turn([call('read_memory', { query: '重新回忆' })]), turn([], '完成'),
  ], transport);
  assert.equal(switched.result.terminalCode, 'COMPLETED');
  assert.ok(switched.requests[0].names.includes('read_memory'));
  assert.ok(!switched.requests[1].names.includes('read_memory'));
  assert.ok(switched.requests[1].names.includes('netease_search_songs'));
  assert.ok(switched.requests[3].names.includes('read_memory'));
  assert.ok(!switched.requests[3].names.includes('netease_search_songs'));
  assert.equal(managed.exposure.instructions().catalog, managedCatalog);
  assert.deepEqual(switched.requests[0].tools.find(({ name }) => name === 'close_tool_package'),
    switched.requests[3].tools.find(({ name }) => name === 'close_tool_package'));
  assert.deepEqual(switched.result.steps.flatMap((step) => step.toolCalls.flatMap(({ outcome }) => (
    outcome.metadata?.toolPackageChange ? [outcome.metadata.toolPackageChange] : []
  ))), [
    { packageId: 'memory', action: 'close' }, { packageId: 'neteaseMusic', action: 'open' },
    { packageId: 'neteaseMusic', action: 'close' }, { packageId: 'memory', action: 'open' },
  ]);

  const starred = createFixture(['read_memory', 'remember_memory'], ['memory'], ['read_memory']);
  const starredRun = await run(starred, [turn([call('close_tool_package', { package_id: 'memory' })]),
    turn([call('read_memory', { query: '常驻工具' })]), turn([], '完成')], transport);
  assert.deepEqual(new Set(starredRun.requests[1].names), new Set(['open_tool_package', 'close_tool_package', 'read_memory']));
  assert.equal(starredRun.result.terminalCode, 'COMPLETED', '收起包不能撤下用户特批工具');
  assert.equal((await starred.registry.get('close_tool_package').execute({ package_id: 'memory' })).metadata, undefined,
    '重复关闭不产生额外状态变化');
}
// 全包特批时没有空拆包入口；关闭调用权限、未知工具与工具总关闭都不能被星标赋权。
{
  const fixture = createFixture(['read_memory'], [], ['read_memory', 'open_app', 'retired_tool']);
  assert.deepEqual(fixture.exposure.metaToolNames, []);
  assert.deepEqual(fixture.exposure.visibleToolNames(), ['read_memory']);
  assert.doesNotMatch(fixture.exposure.instructions().catalog, /open_app|retired_tool|本次运行的工具包用途目录/u);
  const { result } = await run(fixture, [turn([call('read_memory', { query: '常驻' })]), turn([], '完成')]);
  assert.equal(result.terminalCode, 'COMPLETED');
  assert.deepEqual(createFixture([], [], ['read_memory']).exposure.instructions(), { catalog: '' });
  assert.deepEqual(createFixture([], [], ['read_memory']).exposure.visibleToolNames(), []);
  assert.deepEqual(createFixture(['read_memory'], [], []).exposure.visibleToolNames(), [], '取消星标后恢复拆包流程');
}
// 模型不能靠猜名字跳过拆包，也不能在同一批次一边拆包一边猜用 child。
for (const calls of [[call('open_app', { query: '应用' })], [call('open_tool_package', { package_id: 'deviceControl' }), call('open_app', { query: '应用' })]]) {
  const fixture = createFixture();
  const { result } = await run(fixture, [turn(calls)]);
  assert.equal(result.terminalCode, 'MODEL_PROTOCOL_ERROR');
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fixture.exposure.visibleToolNames(), []);
}
// 保存的包 ID 不能赋权，未授权工具连简介都不可见。
{
  const fixture = createFixture(['open_app'], ['memory', 'deviceControl', 'retired_package']);
  assert.deepEqual(fixture.exposure.visibleToolNames(), ['open_app']);
  assert.doesNotMatch(fixture.exposure.instructions().catalog, /read_memory|netease_search_songs/u);
  const executor = new AgentToolExecutor(fixture.registry);
  const rejected = executor.prepare(call('open_tool_package', { package_id: 'memory' }), { allowedToolNames: fixture.allowedToolNames });
  assert.equal(rejected.outcome.code, 'TOOL_INPUT_INVALID');
  assert.equal(executor.prepare(call('close_tool_package', { package_id: 'memory' }), { allowedToolNames: fixture.allowedToolNames })
    .outcome.code, 'TOOL_INPUT_INVALID', '关闭操作同样不能访问未授权包');
  const opened = await fixture.registry.get('open_tool_package').execute({ package_id: 'deviceControl' });
  assert.equal(opened.metadata, undefined, '重复拆已展开的包不产生额外状态变化');
}
// 参数继续由唯一 Runtime 输入边界校验。
{
  const fixture = createFixture(['read_memory'], ['memory']);
  const { result } = await run(fixture, [turn([call('read_memory', {})]), turn([], '参数不足')]);
  assert.equal(result.steps[0].toolCalls[0].outcome.code, 'TOOL_INPUT_INVALID');
  assert.equal(fixture.calls.length, 0);
}
// 工具预算用尽仍强制收口；拆包调用同样消耗工具预算。
{
  const fixture = createFixture(['read_memory']);
  const { result, requests } = await run(fixture, [turn([call('open_tool_package', { package_id: 'memory' })]), turn([], '完成')], 'complete', {
    task: { id: 'budget', type: 'chat_reply', source: 'chat', assistantId: 'ai1', sessionId: 's1', goal: '预算',
      allowedToolNames: fixture.allowedToolNames, modelTransport: 'complete', maxSteps: 3, maxToolCalls: 1, maxToolCallsPerStep: 1, createdAt: new Date().toISOString() },
  });
  assert.equal(result.terminalCode, 'COMPLETED');
  assert.deepEqual(requests[1].names, []);
}
{
  const fixture = createFixture([]);
  assert.deepEqual(fixture.exposure.metaToolNames, []);
  assert.deepEqual(fixture.exposure.instructions(), { catalog: '' });
}
console.log('工具包拆封、即时 schema 暴露、多包、权限隔离、两种传输与预算收口验证通过。');
