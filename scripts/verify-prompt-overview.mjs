import { CHAT_PROMPT_READING_FLOW } from './helpers/prompt-reading-flow.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { StackRouter, StackActions, CommonActions } from '@react-navigation/routers';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(relative, mocks = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: relative,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputText)((id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    throw new Error(`${relative} 未提供依赖 ${id}`);
  }, module, module.exports);
  return module.exports;
}

const estimator = { ...load('src/shared/prompt/estimateTextTokens.ts'), ...load('src/shared/prompt/messageTimestamp.ts') };
const budget = load('src/host/prompt/tokenBudget.ts', { '@shared/prompt': estimator });
const metadata = load('src/host/prompt/compiler/promptBlockMetadata.ts');
const { PromptPackCompiler } = load('src/host/prompt/compiler/PromptPackCompiler.ts', {
    '@shared/prompt': { CHAT_PROMPT_READING_FLOW, ...estimator }, '../tokenBudget': budget, './promptBlockMetadata': metadata });
const { getSystemPromptPreset } = load('src/host/prompt/compiler/systemPromptPresets.ts');
const preset = getSystemPromptPreset('chat.private_reply');
const draft = (key, content) => ({ key, title: content, content, required: false, status: 'ready', placement: 'system' });
const history = [{ role: 'user', content: '2020 年的历史' }, { role: 'assistant', content: '过去的回复' }];
const currentInput = { role: 'user', content: '今天呢？' };
const blocks = [draft('time_awareness', '现在是 2026 年'), draft('passive_memory', '记忆资料'), draft('moments_social_inbox', '未读社交'), draft('together_listening_runtime', '正在一起听'),
  draft('conversation_summary', '聊天摘要'), draft('tools_description', '工具能力'), draft('mcp_services', 'MCP 简介'), draft('tool_context_explanation', '运行上下文'),
  draft('agent_registry_summary', '身份池'), draft('protocol_space', '协议资料'), draft('persona', 'AI 人设'), draft('foundation_default_core', '基础规则'),
  { ...draft('persona', '第二条自定义'), definitionId: 'assistant-user:two', slot: 'user_rules', protection: 'editable' },
  { ...draft('persona', '第三条自定义'), definitionId: 'assistant-user:three', slot: 'user_rules', protection: 'editable' },
  { ...draft('current_input', currentInput.content), required: true, placement: 'input' }];
const pack = new PromptPackCompiler().compile({ scenario: 'chat.private_reply', blocks, recentMessages: history, currentInput, preset });
// 身份目录是固定背景；本轮触发状态、活动和时间仍在历史后的 system。
assert.equal(pack.systemPrompt, '基础规则\n\nAI 人设\n\n协议资料\n\n身份池\n\n第二条自定义\n\n第三条自定义\n\n工具能力\n\nMCP 简介\n\n聊天摘要');
assert.deepEqual(pack.modelMessages, [...history, { role: 'system', content: '运行上下文\n\n正在一起听\n\n未读社交\n\n记忆资料\n\n现在是 2026 年' }, currentInput]);
assert.equal(pack.modelMessages.filter((message) => message.content === '现在是 2026 年').length, 0);
assert.ok(!pack.systemPrompt.includes('2026'));
const disabledTime = new PromptPackCompiler().compile({ scenario: 'chat.private_reply', blocks, recentMessages: history, currentInput,
  preset: { ...preset, items: preset.items.map((item) => item.definitionId === 'context.time_awareness' ? { ...item, enabled: false } : item) } });
assert.ok(!disabledTime.dynamicSystemPrompt.includes('2026'));
assert.deepEqual(disabledTime.recentMessages, history);

const { applyRuntimeModelInput } = load('src/features/chat/reply/application/ChatReplyUtils.ts', { '@shared/prompt': estimator });
const batched = [{ role: 'user', content: '第一条' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }];
const request = applyRuntimeModelInput(pack.modelMessages, undefined, batched);
assert.deepEqual(request.slice(0, -2), pack.modelMessages.slice(0, -1));
assert.deepEqual(request.slice(-2), batched);
const timedInput = [{ role: 'user', content: '第一条', createdAt: '2026-10-20T23:59:59.987+08:00' },
  { role: 'assistant', content: '此前执行结果', createdAt: '2026-10-21T00:00:01+08:00' },
  { role: 'user', content: batched[1].content, createdAt: '2026-10-21T00:00:02+08:00' }];
const withoutTimes = applyRuntimeModelInput(pack.modelMessages, undefined, timedInput, false);
assert.deepEqual(withoutTimes.slice(-3), timedInput.map(({ createdAt, ...message }) => message));
const withTimes = applyRuntimeModelInput(pack.modelMessages, undefined, timedInput, true);
assert.deepEqual(withTimes.slice(-6).map((message) => message.role), ['system', 'user', 'system', 'assistant', 'system', 'user']);
assert.match(withTimes.at(-6).content, /2026-10-20T15:59:59Z/);
assert.equal(withTimes.at(-3).content, '此前执行结果');
assert.deepEqual(withTimes.at(-1).content, batched[1].content, '时间不能混进图片内容');
const timesWithoutNow = new PromptPackCompiler().compile({ scenario: 'chat.private_reply', blocks, recentMessages: timedInput.slice(0, 2), currentInput,
  messageTimestampsEnabled: true, preset: { ...preset, items: preset.items.map((item) => item.definitionId === 'context.time_awareness' ? { ...item, enabled: false } : item) } });
assert.ok(!timesWithoutNow.dynamicSystemPrompt.includes('现在是'));
assert.equal(timesWithoutNow.modelMessages[0].role, 'system', '时间戳开关独立于当前时间开关');
const { buildAgentModelMessages } = load('src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts', {
  '@platform/ai': {}, '@shared/diagnostics/TurnTimelineLog': {},
});
const continuation = buildAgentModelMessages(request, [{ role: 'tool', toolCallId: 'call-1', name: 'lookup', content: '结果' }]);
assert.deepEqual(continuation.slice(0, request.length), request);
assert.equal(continuation.at(-1).role, 'tool');

// 用真实编译器、拆包 owner 与请求网关验证：特批说明位于摘要前，续轮不改变缓存前缀。
const { AgentToolRegistry } = load('src/platform/agentRuntime/AgentToolRegistry.ts');
const { registerToolPackagesForHostRun } = load('src/host/composition/agent/ToolPackageExposure.ts');
const toolRegistry = new AgentToolRegistry();
const bindings = ['read_memory', 'remember_memory'].map((name) => {
  const tool = { descriptor: { name, description: `说明 ${name}`, inputSchema: { type: 'object', properties: {} } } };
  toolRegistry.register(tool);
  return { packageId: 'memory', tool };
});
const exposure = registerToolPackagesForHostRun({ registry: toolRegistry, bindings,
  allowedToolNames: ['read_memory', 'remember_memory'], openPackageIds: [], directToolNames: ['read_memory'] });
const modelRequests = [];
const { BaseAIClientAgentModelGateway } = load('src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts', {
  '@platform/ai': { AgentModelGateway: class {
    async complete(request) {
      modelRequests.push(request);
      return { assistantText: '完成', reasoningText: '', toolCalls: [], historyItems: [], finishReason: 'stop' };
    }
  } },
  '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline() {} },
});
const modelGateway = new BaseAIClientAgentModelGateway({ client: {}, initialMessages: pack.modelMessages,
  toolInstructionsSlot: pack.toolInstructionsSlot, diagnosticContext: {} });
const requestWithExposure = () => ({ transport: 'complete', history: [],
  toolBudget: { remainingToolCalls: 30, maxToolCallsPerStep: 3, forceFinalResponse: false },
  tools: toolRegistry.listAllowed([...exposure.visibleToolNames(), ...exposure.metaToolNames]), toolInstructions: exposure.instructions() });
await modelGateway.runTurn(requestWithExposure());
const openResult = await toolRegistry.get('open_tool_package').execute({ package_id: 'memory' });
await modelGateway.runTurn({ ...requestWithExposure(),
  toolBudget: { remainingToolCalls: 29, maxToolCallsPerStep: 3, forceFinalResponse: false },
  history: [
    { role: 'assistant', content: '', toolCalls: [{ id: 'open-1', name: 'open_tool_package', arguments: '{"package_id":"memory"}' }] },
    { role: 'tool', toolCallId: 'open-1', name: 'open_tool_package', content: openResult.modelContent },
  ],
});
const modelPrefix = modelRequests[0].messages[0].content;
assert.ok(modelPrefix.indexOf('【用户特批工具】') < modelPrefix.indexOf('聊天摘要'));
assert.equal(modelPrefix.split('"name":"read_memory"').length - 1, 1);
assert.equal(modelRequests[1].messages[0].content, modelPrefix, '工具续轮保持稳定前置 system');
assert.deepEqual(modelRequests[1].messages.slice(0, modelRequests[0].messages.length), modelRequests[0].messages,
  '拆包并消耗额度后，下一请求仍保留上一请求的完整消息前缀');
assert.equal(modelRequests[0].includeSystemPrompt, false, '请求不能重复注入旧 system');
assert.deepEqual(new Set(modelRequests[0].tools.map((tool) => tool.function.name)), new Set(['read_memory', 'open_tool_package', 'close_tool_package']));
assert.equal(modelRequests[1].tools.length, 4);
assert.deepEqual(modelRequests[1].messages.slice(1, 3), history, '历史继续保持真实消息角色');

// 默认配置与旧 AI 覆盖共同解析，语言不再受旧英文设置影响。
const defaults = { overrides: { 'foundation.default_core': '全局规则' }, userPrompts: [{ id: 'g1', name: '全局', content: '全局常驻', enabled: true, sortOrder: 1 }], toolPermissions: {}, agentRegistryExcludedAssistantIds: [], timeEnabled: false };
const { resolveAssistantPromptConfiguration } = load('src/features/prompting/application/ManageAssistantPrompts.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => ({
    defaults: { read: async () => defaults }, assistantPrompts: {
      listDefinitionStates: async (id) => id === 'ai-1' ? [{ definitionId: 'context.time_awareness', enabled: false }] : [],
      listDefinitionOverrides: async () => [{ definitionId: 'foundation.default_core', locale: 'zh-CN', content: '专属规则' }, { definitionId: 'foundation.default_core', locale: 'en-US', content: 'old English' }],
      listAssistantUserPrompts: async () => [{ id: 'a1', name: '专属', condition: 'always', content: '专属常驻', enabled: true, sortOrder: 2 }],
    },
  }) },
});
const resolved = await resolveAssistantPromptConfiguration({ assistantId: 'ai-1', scenarioId: 'chat.private_reply' });
// 内置 Prompt 固定中文后不再有 resolved.locale；历史 en-US 覆盖行不生效。
assert.equal(resolved.overrides['foundation.default_core'], '专属规则');
assert.equal(resolved.timeEnabled, false);
assert.equal((await resolveAssistantPromptConfiguration({ assistantId: 'ai-2', scenarioId: 'chat.private_reply' })).timeEnabled, true, '一位 AI 关闭时间不影响其他 AI，旧全局开关不再消费');
assert.deepEqual(resolved.userPrompts.map((item) => item.content), ['全局常驻', '专属常驻']);

// 使用真实 SQLite 检查默认配置保存、单项重置和原子排序，不改动用户数据库。
const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE ai_assistants (id TEXT PRIMARY KEY); CREATE TABLE group_chats (id TEXT PRIMARY KEY);');
database.exec(load('src/platform/persistence/sqlite/promptingSchema.ts').PROMPTING_SCHEMA);
const executor = {
  getAllAsync: async (sql, parameters = []) => database.prepare(sql).all(...parameters),
  getFirstAsync: async (sql, parameters = []) => database.prepare(sql).get(...parameters) ?? null,
  runAsync: async (sql, parameters = []) => database.prepare(sql).run(...parameters),
  async withExclusiveTransactionAsync(action) {
    database.exec('BEGIN');
    try { const result = await action(executor); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  },
};
const { sqlitePromptDefaultsRepository: repository } = load('src/features/prompting/infrastructure/SQLitePromptDefaultsRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => executor } },
});
assert.deepEqual(await repository.read(), { overrides: {}, userPrompts: [], toolPermissions: {}, appToolPackages: {}, agentRegistryExcludedAssistantIds: [] });
const first = { id: 'p1', name: '第一条', content: '规则一', enabled: true, sortOrder: 10 };
const second = { id: 'p2', name: '第二条', content: '规则二', enabled: true, sortOrder: 20 };
await repository.saveUserPrompt(first); await repository.saveUserPrompt(second);
await repository.saveOverride('foundation.default_core', '新规则');
await repository.setEnabled('time', false); await repository.setEnabled('tool:open_app', false);
await repository.reorderUserPrompts(first, second);
let stored = await repository.read();
assert.deepEqual(stored.userPrompts.map((item) => item.id), ['p2', 'p1']);
assert.ok(!Object.hasOwn(stored, 'timeEnabled')); assert.equal(stored.toolPermissions.open_app, false);
database.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON prompt_default_user_prompts WHEN OLD.id = 'p1' BEGIN SELECT RAISE(ABORT, '拒绝第二次更新'); END;");
await assert.rejects(repository.reorderUserPrompts(stored.userPrompts[0], stored.userPrompts[1]), /拒绝第二次更新/);
assert.deepEqual((await repository.read()).userPrompts, stored.userPrompts, '交换失败必须整体回滚');
database.exec('DROP TRIGGER reject_second');
await repository.resetOverride('foundation.default_core'); await repository.deleteUserPrompt('p1');
stored = await repository.read();
assert.deepEqual(stored.overrides, {}); assert.equal(stored.userPrompts.length, 1);
// 真实持久化与 application：两个 AI 的正文、时间和自定义片段互不覆盖。
database.exec("PRAGMA foreign_keys = ON; INSERT INTO ai_assistants VALUES ('ai-1'), ('ai-2'), ('ai-3');");
const { sqlitePromptingRepository: assistantRepository } = load('src/features/prompting/infrastructure/SQLitePromptingRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => executor } },
});
// 全局名单经真实持久化、配置解析、Host 与身份目录进入模型提示词。
let registryAssistants = [
  { id: 'ai-1', agentId: 'agent-1', name: '入选 AI', model: 'model-one', isHostAI: false },
  { id: 'ai-2', agentId: 'agent-2', name: '隐藏 AI', model: 'model-hidden', isHostAI: true, isBlocked: true },
];
const registryDependencies = {
  defaults: repository, assistantPrompts: assistantRepository,
  assistants: { list: async () => registryAssistants },
};
const registryManagement = load('src/features/prompting/application/ManagePromptDefaults.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => registryDependencies },
});
assert.deepEqual(await registryManagement.getAppToolPackageSettings(), {});
await registryManagement.setAppToolPackageEnabled('xiaohongshu', true);
await registryManagement.setAppToolPackageEnabled('neteaseMusic', false);
assert.deepEqual(await registryManagement.getAppToolPackageSettings(), { xiaohongshu: true, neteaseMusic: false });
await registryManagement.setAppToolPackageEnabled('xiaohongshu', false);
assert.deepEqual((await repository.read()).appToolPackages, { xiaohongshu: false, neteaseMusic: false });
assert.equal((await repository.read()).toolPermissions.open_app, false, '应用包总开关不改写单项工具权限');
const registryConfiguration = load('src/features/prompting/application/ManageAssistantPrompts.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => registryDependencies },
});
const { AgentRegistryService } = load('src/features/assistants/AgentRegistryService.ts', {
  './infrastructure/SQLiteAssistantRepository': { aiAssistantRepository: { getAll: async () => registryAssistants } },
  './infrastructure/SQLiteHostRepository': { aiHostRepository: {
    cleanupExpiredBlocks: async () => {}, checkHostCooldown: async () => ({ isInCooldown: false }),
  } },
});
const registry = new AgentRegistryService();
const { PromptPackBlockFactory } = load('src/host/prompt/PromptPackBlockFactory.ts', {
  '@shared': {}, '@features/memory': {}, '@features/moments': {},
  '@features/assistants': { agentRegistryService: registry }, './PromptBuiltInContent': {},
});
const registryFactory = new PromptPackBlockFactory();
const { assembleResolvedChatPromptPack: assembleRegistryPack } = load('src/host/prompt/ResolvedPromptPackAssembler.ts', {
  '@features/prompting': {
    listPromptCustomBlocks: async () => [],
    resolveLegacyPromptPreset: async () => ({ preset }),
    resolveAssistantPromptConfiguration: registryConfiguration.resolveAssistantPromptConfiguration,
  },
  './PromptPackAssembler': { promptPackAssembler: { assembleChatPromptPack: async (params) => new PromptPackCompiler().compile({
    scenario: 'chat.private_reply', preset: { ...params.preset, items: params.preset.items.filter((item) => item.definitionId === 'context.agent_registry') },
    blocks: [await registryFactory.createAgentRegistrySummaryBlock(params.aiConfig)], recentMessages: [],
    messageTimestampsEnabled: params.aiConfig.messageTimestampsEnabled,
  }) } },
  './compiler': {}, './DeviceBatteryPromptBlock': { createDeviceBatteryPromptBlocks: async () => [] },
  './PromptPackBlockFactory': {},
  './PromptBuiltInContent': load('src/host/prompt/PromptBuiltInContent.ts'),
});
assert.ok((await registryManagement.getAgentRegistrySettings()).every((item) => item.included), '无配置时默认全部勾选');
await registryManagement.setAgentRegistryAssistantIncluded('ai-2', false);
assert.deepEqual((await repository.read()).agentRegistryExcludedAssistantIds, ['ai-2']);
const registryParams = { aiConfig: { id: 'ai-1', agentId: 'agent-1' }, currentInput: '' };
let registryPack = await assembleRegistryPack(registryParams);
assert.match(registryPack.systemPrompt, /入选 AI.*底层模型：model-one/);
assert.doesNotMatch(registryPack.systemPrompt, /隐藏 AI|agent-2|model-hidden/);
assert.match(registryPack.systemPrompt, /身份池内共有 1 个 AI/);
const isolatedRegistryParams = { aiConfig: { id: 'ai-2', agentId: 'agent-2', isHostAI: true }, currentInput: '' };
assert.equal((await assembleRegistryPack(isolatedRegistryParams)).systemPrompt, '', '未入池的 AI 即使是主理 AI，也不接收身份池信息');
assert.equal((await assembleRegistryPack({ ...isolatedRegistryParams, aiConfig: { id: 'ai-2' } })).systemPrompt, '', '隔离按 Assistant 实体键判断，不依赖 agentId');
const isolatedRegistryBlock = await registryFactory.createAgentRegistrySummaryBlock({ id: 'ai-2', agentRegistryExcludedAssistantIds: ['ai-2'] });
assert.equal(isolatedRegistryBlock.status, 'omitted');
assert.equal(isolatedRegistryBlock.content, '', '隔离时不输出名单、模型名、人数或主理状态');
const selfExcluded = await registry.getSummary({ currentAgentId: 'agent-2', excludedAssistantIds: ['ai-2'] });
assert.equal(selfExcluded.entries.length, 1, '当前 AI 自己也不能绕过排除名单');
assert.equal(selfExcluded.totalCount, 1);
assert.equal(selfExcluded.availableCount, 1);
assert.equal(selfExcluded.hostAgentName, null);
assert.equal(selfExcluded.blockedCount, 0);
registryAssistants[0].model = 'model-updated';
assert.match((await assembleRegistryPack(registryParams)).systemPrompt, /底层模型：model-updated/);
await registryManagement.setAgentRegistryAssistantIncluded('ai-1', false);
assert.equal((await assembleRegistryPack(registryParams)).systemPrompt, '', '全部取消后省略整块');
registryAssistants.push({ id: 'ai-3', agentId: 'agent-3', name: '新增 AI', model: 'new-model' });
assert.equal((await registryManagement.getAgentRegistrySettings()).find((item) => item.id === 'ai-3').included, true, '新添加的 AI 默认入选');
await registryManagement.setAgentRegistryAssistantIncluded('ai-1', true);
await registryManagement.setAgentRegistryAssistantIncluded('ai-2', true);
registryPack = await assembleRegistryPack(registryParams);
assert.match(registryPack.systemPrompt, /隐藏 AI.*底层模型：model-hidden/);
assert.match((await assembleRegistryPack(isolatedRegistryParams)).systemPrompt, /入选 AI.*底层模型：model-updated/, '重新入池后恢复接收其他入池 AI 的信息');
registryAssistants = [];
const scopedManagement = load('src/features/prompting/application/ManageAssistantPrompts.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => ({
    assistantPrompts: assistantRepository, defaults: repository,
    assistants: { listOptions: async () => [
      { id: 'ai-1', isHostAI: true }, { id: 'ai-2', isHostAI: false }, { id: 'ai-3', isHostAI: false },
    ] },
    tools: {
      list: async () => [{ name: 'read_memory', hostOnly: false }, { name: 'send_voice_message', hostOnly: false }, { name: 'schedule_self_wake', hostOnly: true }],
      set: async (id, name, enabled) => executor.runAsync(
        'INSERT OR REPLACE INTO assistant_tool_permissions (assistant_id, tool_name, enabled, updated_at) VALUES (?, ?, ?, ?)', [id, name, Number(enabled), 'now']
      ),
    },
    catalog: { getById: () => ({ protection: 'overridable', defaultContent: '默认规则' }) },
  }) },
});
// 使用真实 SQLite 验证可选提示词的默认状态、覆盖继承与 AI 隔离。
const coreDefaultManagement = load('src/features/prompting/application/ManagePromptDefaults.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => ({ defaults: repository, catalog: { getById: () => ({ defaultContent: '代码默认规则' }) } }) },
});
await coreDefaultManagement.saveDefaultDefinition('foundation.default_core', '');
assert.equal((await repository.read()).overrides['foundation.default_core'], '', '全局默认允许主动保存空基础规则');
await coreDefaultManagement.saveDefaultDefinition('foundation.default_core', '保留的全局基础规则');
await scopedManagement.saveAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId: 'foundation.default_core', locale: 'zh-CN', content: '' });
assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-1', scenarioId: 'chat.private_reply' })).overrides['foundation.default_core'], '', '空覆盖不能回填全局默认');
assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-2', scenarioId: 'chat.private_reply' })).overrides['foundation.default_core'], '保留的全局基础规则');
await scopedManagement.resetAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId: 'foundation.default_core', locale: 'zh-CN' });
assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-1', scenarioId: 'chat.private_reply' })).overrides['foundation.default_core'], '保留的全局基础规则');
await coreDefaultManagement.resetDefaultDefinition('foundation.default_core');
assert.throws(() => coreDefaultManagement.saveDefaultDefinition('output.paragraph_breaks', ''), /不能为空/u);
assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-1', scenarioId: 'chat.private_reply' })).paragraphBreaksEnabled, false);
assert.equal(await scopedManagement.resolveImageGroundingPrompt('ai-1'), '默认规则');
await repository.saveOverride('input.image_grounding', '全局图片提醒');
assert.equal(await scopedManagement.resolveImageGroundingPrompt('ai-1'), '全局图片提醒');
await scopedManagement.saveAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId: 'input.image_grounding', locale: 'zh-CN', content: '专属图片提醒' });
assert.equal(await scopedManagement.resolveImageGroundingPrompt('ai-1'), '专属图片提醒');
assert.equal(await scopedManagement.resolveImageGroundingPrompt('ai-2'), '全局图片提醒');
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'input.image_grounding', enabled: false });
await scopedManagement.resetAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId: 'input.image_grounding', locale: 'zh-CN' });
assert.equal(await scopedManagement.resolveImageGroundingPrompt('ai-1'), null, '恢复正文不改变关闭状态');
assert.equal(await scopedManagement.resolveImageGroundingPrompt('ai-2'), '全局图片提醒');
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'input.image_grounding', enabled: true });
assert.equal(await scopedManagement.resolveImageGroundingPrompt('ai-1'), '全局图片提醒');
await repository.resetOverride('input.image_grounding');
// 两级摘要正文复用相同的覆盖、恢复与全局默认语义，不读提示词状态表决定是否生成。
for (const [level, definitionId] of [['primary', 'internal.chat_summary'], ['secondary', 'internal.chat_secondary_summary']]) {
  assert.equal(await scopedManagement.resolveChatSummaryPromptOverride('ai-1', level), undefined);
  await coreDefaultManagement.saveDefaultDefinition(definitionId, `全局${level}正文`);
  assert.equal(await scopedManagement.resolveChatSummaryPromptOverride('ai-1', level), `全局${level}正文`);
  await scopedManagement.saveAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId, locale: 'zh-CN', content: `专属${level}正文` });
  assert.equal(await scopedManagement.resolveChatSummaryPromptOverride('ai-1', level), `专属${level}正文`);
  assert.equal(await scopedManagement.resolveChatSummaryPromptOverride('ai-2', level), `全局${level}正文`);
  assert.equal(await scopedManagement.resolveChatSummaryPromptOverride(null, level), `全局${level}正文`, '群不使用任何 AI 的专属正文');
  await scopedManagement.resetAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId, locale: 'zh-CN' });
  assert.equal(await scopedManagement.resolveChatSummaryPromptOverride('ai-1', level), `全局${level}正文`);
  await coreDefaultManagement.resetDefaultDefinition(definitionId);
  assert.equal(await scopedManagement.resolveChatSummaryPromptOverride('ai-1', level), undefined);
  assert.throws(() => scopedManagement.saveAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId, locale: 'zh-CN', content: ' ' }), /不能为空/u);
}
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'output.paragraph_breaks', enabled: true });
assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-1', scenarioId: 'chat.private_reply' })).paragraphBreaksEnabled, true);
assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-2', scenarioId: 'chat.private_reply' })).paragraphBreaksEnabled, false);
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'output.paragraph_breaks', enabled: false });
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'context.time_awareness', enabled: false });
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'context.device_battery', enabled: false });
assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-1', scenarioId: 'chat.private_reply' })).messageTimestampsEnabled, false);
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'context.message_timestamps', enabled: true });
await scopedManagement.saveAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId: 'foundation.default_core', locale: 'zh-CN', content: '只属于第一位 AI' });
const exclusive = await scopedManagement.createAssistantUserPrompt({ assistantId: 'ai-1', name: '专属片段', content: '只注入第一位', condition: 'always', enabled: true, sortOrder: 10 });
const one = await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-1', scenarioId: 'chat.private_reply' });
const two = await scopedManagement.resolveAssistantPromptConfiguration({ assistantId: 'ai-2', scenarioId: 'chat.private_reply' });
assert.equal(one.timeEnabled, false); assert.equal(two.timeEnabled, true);
assert.equal(one.batteryEnabled, false); assert.equal(two.batteryEnabled, true);
assert.equal(one.messageTimestampsEnabled, true); assert.equal(two.messageTimestampsEnabled, false);
assert.equal((await assembleRegistryPack(registryParams)).messageTimestampsEnabled, true, '持久配置必须传入实际装配');
await scopedManagement.saveAssistantDefinitionState({ assistantId: 'ai-1', definitionId: 'context.message_timestamps', enabled: false });
assert.equal((await assembleRegistryPack(registryParams)).messageTimestampsEnabled, false);
assert.equal(one.overrides['foundation.default_core'], '只属于第一位 AI');
assert.equal(two.overrides['foundation.default_core'], undefined);
assert.ok(one.userPrompts.some((prompt) => prompt.content === '只注入第一位'));
assert.ok(!two.userPrompts.some((prompt) => prompt.content === '只注入第一位'));
await scopedManagement.resetAssistantDefinitionOverride({ assistantId: 'ai-1', definitionId: 'foundation.default_core', locale: 'zh-CN' });
await scopedManagement.deleteAssistantUserPrompt(exclusive.id, 'ai-1');
assert.deepEqual(await assistantRepository.listDefinitionOverrides('ai-1'), []);
assert.equal((await assistantRepository.listDefinitionStates('ai-1'))[0].enabled, false);
assert.deepEqual(await assistantRepository.listDefinitionStates('ai-2'), []);

// 正文全局应用覆盖现有 AI 的同一项；开关、其他项、旧语言行和默认配置保持原样。
const statesBeforeGlobalPrompt = database.prepare('SELECT * FROM assistant_prompt_definition_states ORDER BY assistant_id, definition_id').all();
const defaultsBeforeGlobalPrompt = await repository.read();
await assistantRepository.saveDefinitionOverride({ assistantId: 'ai-2', definitionId: 'foundation.default_core', locale: 'en-US', content: '保留的旧语言行', updatedAt: 'old' });
for (const definitionId of ['foundation.default_core', 'output.paragraph_breaks', 'input.image_grounding', 'internal.chat_summary', 'internal.chat_secondary_summary']) {
  const otherOverridesBefore = database.prepare("SELECT * FROM assistant_prompt_definition_overrides WHERE definition_id <> ? OR locale <> 'zh-CN' ORDER BY assistant_id, definition_id, locale").all(definitionId);
  const draft = `尚未单独保存的统一正文：${definitionId}`;
  await scopedManagement.applyAssistantDefinitionGlobally({ definitionId, content: draft });
  for (const assistantId of ['ai-1', 'ai-2', 'ai-3']) {
    const resolvedConfig = await scopedManagement.resolveAssistantPromptConfiguration({ assistantId, scenarioId: 'chat.private_reply' });
    assert.equal(resolvedConfig.overrides[definitionId], draft);
  }
  assert.deepEqual(database.prepare("SELECT * FROM assistant_prompt_definition_overrides WHERE definition_id <> ? OR locale <> 'zh-CN' ORDER BY assistant_id, definition_id, locale").all(definitionId), otherOverridesBefore);
  assert.deepEqual(database.prepare('SELECT * FROM assistant_prompt_definition_states ORDER BY assistant_id, definition_id').all(), statesBeforeGlobalPrompt);
  assert.deepEqual(await repository.read(), defaultsBeforeGlobalPrompt);
}
await scopedManagement.applyAssistantDefinitionGlobally({ definitionId: 'foundation.default_core', content: '' });
for (const assistantId of ['ai-1', 'ai-2', 'ai-3']) assert.equal((await scopedManagement.resolveAssistantPromptConfiguration({ assistantId, scenarioId: 'chat.private_reply' })).overrides['foundation.default_core'], '');
const overridesBeforeGlobalFailure = database.prepare('SELECT * FROM assistant_prompt_definition_overrides ORDER BY assistant_id, definition_id, locale').all();
await assert.rejects(scopedManagement.applyAssistantDefinitionGlobally({ definitionId: 'output.paragraph_breaks', content: '  ' }), /不能为空/u);
database.exec("CREATE TRIGGER reject_global_prompt BEFORE UPDATE ON assistant_prompt_definition_overrides WHEN OLD.assistant_id = 'ai-3' AND NEW.definition_id = 'foundation.default_core' BEGIN SELECT RAISE(ABORT, '拒绝全局正文'); END;");
await assert.rejects(scopedManagement.applyAssistantDefinitionGlobally({ definitionId: 'foundation.default_core', content: '失败时不得留下部分更新' }), /拒绝全局正文/u);
assert.deepEqual(database.prepare('SELECT * FROM assistant_prompt_definition_overrides ORDER BY assistant_id, definition_id, locale').all(), overridesBeforeGlobalFailure, '批量中途失败时回滚所有正文');
assert.deepEqual(database.prepare('SELECT * FROM assistant_prompt_definition_states ORDER BY assistant_id, definition_id').all(), statesBeforeGlobalPrompt);
database.exec('DROP TRIGGER reject_global_prompt');

// 特批偏好独立于权限保存，重读、取消及角色删除都保持真实 SQLite 契约。
await scopedManagement.setAssistantDirectToolExposure('ai-1', 'read_memory', true);
await scopedManagement.setAssistantDirectToolExposure('ai-1', 'read_memory', true);
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-1'), ['read_memory']);
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-2'), []);
assert.equal(database.prepare('SELECT COUNT(*) AS count FROM assistant_tool_permissions').get().count, 0, '点亮星标不写调用权限');
await assert.rejects(scopedManagement.setAssistantDirectToolExposure('ai-1', 'unknown_tool', true), /工具不存在/u);
await scopedManagement.setAssistantDirectToolExposure('ai-1', 'read_memory', false);
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-1'), []);
await scopedManagement.setAssistantDirectToolExposure('ai-2', 'send_voice_message', true);

// 全局应用只替换普通星标，主理专属配置和单项权限保留；空快照同样生效。
await scopedManagement.setAssistantDirectToolExposure('ai-1', 'schedule_self_wake', true);
await scopedManagement.setAssistantDirectToolExposure('ai-1', 'read_memory', true);
await scopedManagement.setAssistantToolPermission('ai-1', 'schedule_self_wake', false);
await scopedManagement.setAssistantToolPermission('ai-2', 'read_memory', false);
const permissionsBefore = database.prepare('SELECT * FROM assistant_tool_permissions ORDER BY assistant_id, tool_name').all();
await scopedManagement.applyAssistantDirectToolsGlobally(await scopedManagement.listAssistantDirectToolNames('ai-1'));
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-1'), ['read_memory', 'schedule_self_wake']);
for (const id of ['ai-2', 'ai-3']) assert.deepEqual(await scopedManagement.listAssistantDirectToolNames(id), ['read_memory']);
await assert.rejects(scopedManagement.setAssistantDirectToolExposure('ai-2', 'schedule_self_wake', true), /只有主理 AI/u);
await assert.rejects(scopedManagement.setAssistantDirectToolExposure('ai-2', 'schedule_self_wake', false), /只有主理 AI/u);
await assert.rejects(scopedManagement.setAssistantToolPermission('ai-2', 'schedule_self_wake', true), /只有主理 AI/u);
await scopedManagement.setAssistantDirectToolExposure('ai-2', 'read_memory', false);
await scopedManagement.setAssistantDirectToolExposure('ai-2', 'send_voice_message', true);
await scopedManagement.applyAssistantDirectToolsGlobally(await scopedManagement.listAssistantDirectToolNames('ai-2'));
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-1'), ['schedule_self_wake', 'send_voice_message']);
for (const id of ['ai-2', 'ai-3']) assert.deepEqual(await scopedManagement.listAssistantDirectToolNames(id), ['send_voice_message']);
const starsBefore = database.prepare('SELECT * FROM assistant_direct_tools ORDER BY assistant_id, tool_name').all();
database.exec("CREATE TRIGGER reject_global_star BEFORE INSERT ON assistant_direct_tools WHEN NEW.assistant_id = 'ai-3' BEGIN SELECT RAISE(ABORT, '拒绝全局星标'); END;");
await assert.rejects(scopedManagement.applyAssistantDirectToolsGlobally(['read_memory']), /拒绝全局星标/u);
assert.deepEqual(database.prepare('SELECT * FROM assistant_direct_tools ORDER BY assistant_id, tool_name').all(), starsBefore, '中途失败回滚所有 AI 的修改');
database.exec('DROP TRIGGER reject_global_star');
await scopedManagement.applyAssistantDirectToolsGlobally([]);
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-1'), ['schedule_self_wake']);
for (const id of ['ai-2', 'ai-3']) assert.deepEqual(await scopedManagement.listAssistantDirectToolNames(id), []);
assert.deepEqual(database.prepare('SELECT * FROM assistant_tool_permissions ORDER BY assistant_id, tool_name').all(), permissionsBefore);
database.exec("INSERT INTO ai_assistants VALUES ('ai-future');");
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-future'), [], '快照不成为未来新增 AI 的默认配置');
assert.deepEqual(await assistantRepository.listDefinitionOverrides('ai-future'), [], '正文快照不成为未来新增 AI 的默认配置');
await scopedManagement.setAssistantDirectToolExposure('ai-2', 'send_voice_message', true);
database.exec('PRAGMA foreign_keys = ON; DELETE FROM ai_assistants WHERE id = \'ai-2\';');
assert.deepEqual(await scopedManagement.listAssistantDirectToolNames('ai-2'), [], '角色删除同时清除特批配置');

// 真实组件的用户操作：无 AI 概览、详情、编辑、重置、开关与宿主导航。
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const alerts = [];
const native = Object.fromEntries(['ActivityIndicator', 'ScrollView', 'Switch', 'Text', 'TextInput', 'TouchableOpacity', 'View'].map((name) => [name, name]));
native.Alert = { alert: (...args) => alerts.push(args) };
native.PanResponder = { create: (handlers) => ({ panHandlers: {
  onMoveShouldSetResponderCapture: handlers.onMoveShouldSetPanResponderCapture,
  onResponderRelease: handlers.onPanResponderRelease,
  onResponderTerminate: handlers.onPanResponderTerminate,
} }) };
const fixture = { overrides: { 'foundation.default_core': '私密正文不会出现在首页' }, userPrompts: [], toolPermissions: {},
  tools: [{ name: 'read_memory', owner: 'memory', hostOnly: false, defaultEnabled: true, enabled: true, mutating: false, callOnly: false, description: '完整工具说明' },
    { name: 'schedule_self_wake', owner: 'companion', hostOnly: true, defaultEnabled: true, enabled: true, mutating: true, callOnly: false, description: '完整主理工具说明' }] };
const actions = [];
const ai = { id: 'ai-1', name: '测试 AI', persona: '原始人设', isHostAI: true };
const otherAI = { id: 'ai-2', name: '另一位 AI', persona: '另一份人设', isHostAI: false };
let assistantOptions = [];
let optionListError = false;
const aiReads = [];
const aiDetails = { overrides: [], userPrompts: [], tools: [], directToolNames: [], timeEnabled: true, batteryEnabled: true, messageTimestampsEnabled: false, userStateEnabled: true, socialEnabled: true };
const otherDetails = { overrides: [], userPrompts: [], tools: [], directToolNames: [], timeEnabled: true, batteryEnabled: true, messageTimestampsEnabled: false, userStateEnabled: true, socialEnabled: true };
let summaryGenerationState = { primaryEnabled: true, secondaryEnabled: true };
const detailsFor = (id) => id === ai.id ? aiDetails : otherDetails;
const globalSnapshots = [];
const globalPromptSnapshots = [];
let failGlobalPromptApply = false;
let glassEnabled = false;
native.StyleSheet = { create: (styles) => styles, hairlineWidth: 1 };
const editorTheme = {
  effects: { glass: { get enabled() { return glassEnabled; } } },
  radius: { md: 12, lg: 20 }, spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  colors: {
    text: { primary: '#111', secondary: '#444', tertiary: '#666' },
    brand: { primary: '#09f', onPrimary: '#fff' }, feedback: { error: '#f00' },
    surface: { default: '#fff', input: '#eee', raised: '#ddd' }, border: { light: '#ccc' },
    background: { app: '#fff', screen: '#f5f5f5' },
  },
};
const editorThemePorts = { GlassSurface: 'GlassSurface', ThemedSurface: 'View', useTheme: () => editorTheme, useThemedStyles: (factory) => factory(editorTheme) };
const ToggleField = load('src/shared/ui/ToggleField.tsx', {
  'react-native': native, '@shared/theme': editorThemePorts, './Toggle': { default: 'Switch', __esModule: true },
}).default;
const customRows = load('src/features/prompting/presentation/CustomPromptRow.tsx', {
  'react-native': native, '@shared/ui': { ToggleField }, '@shared/theme': { ThemedSurface: 'View' },
});
const nativeEditor = load('src/shared/ui/AppTextInput.tsx', { 'react-native': native, '@shared/theme': editorThemePorts });
const editorField = load('src/shared/ui/InputField.tsx', { 'react-native': native, '@shared/theme': editorThemePorts, './AppTextInput': nativeEditor }).default;
const editorStyles = load('src/features/prompting/presentation/promptCenterStyles.ts', { 'react-native': native });
let definitionSaveGate;
const Screen = load('src/features/prompting/presentation/PromptCenterScreen.tsx', {
  '@shared/prompt': { CHAT_PROMPT_READING_FLOW },
  '@features/assistants': { getAssistantDisplayName: (assistant) => assistant.nickname ?? assistant.name },
  '@shared/ui': { InputField: editorField, KeyboardAvoidingContainer: 'View', ToggleField, showAppDialog: ({ title, message, buttons }) => alerts.push([title, message, buttons]) },
  'react-native': native, 'lucide-react-native': { ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight', Square: 'Square', SquareCheck: 'SquareCheck', Star: 'Star' },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': editorThemePorts,
  '@shared/ui/NavigationHeader': { default: ({ title, onGoBack, rightButton, help }) => React.createElement('Header', { title, onGoBack, help }, rightButton), __esModule: true },
  '@shared/ui/ModalSheet': { default: ({ children, onClose }) => React.createElement('ModalSheet', { onClose }, children), __esModule: true },
  '../application/GetPromptCenterSnapshot': { getPromptCenterSnapshot: () => ({ definitions: [
    { id: 'foundation.default_core', defaultContent: '代码默认规则' },
    { id: 'input.image_grounding', defaultContent: '图片默认提醒' },
    { id: 'output.paragraph_breaks', defaultContent: '默认分段规则' },
    { id: 'internal.chat_summary', defaultContent: '默认一级摘要规则' },
    { id: 'internal.chat_secondary_summary', defaultContent: '默认二级摘要规则' },
    { id: 'internal.vision_ocr', defaultContent: '默认图片识别规则' },
  ] }) },
  '../application/ManagePromptDefaults': {
    getAgentRegistrySettings: registryManagement.getAgentRegistrySettings,
    setAgentRegistryAssistantIncluded: registryManagement.setAgentRegistryAssistantIncluded,
    getDefaultPromptEditor: async () => ({ ...fixture }), getPromptAssistant: async (id) => { aiReads.push(['assistant', id]); return { ...(id === ai.id ? ai : otherAI) }; },
    setDefaultPromptSwitch: async (key, enabled) => { actions.push([key, enabled]); fixture.toolPermissions[key.slice(5)] = enabled; },
    saveDefaultDefinition: async (id, content) => { await definitionSaveGate; fixture.overrides[id] = content; }, resetDefaultDefinition: async (id) => { delete fixture.overrides[id]; },
    saveDefaultUserPrompt: async (prompt) => {
      fixture.userPrompts = [...fixture.userPrompts.filter((item) => item.id !== prompt.id), prompt].sort((left, right) => left.sortOrder - right.sortOrder);
    },
    deleteDefaultUserPrompt: async (id) => { fixture.userPrompts = fixture.userPrompts.filter((item) => item.id !== id); },
    moveDefaultUserPrompt: async (first, second) => {
      fixture.userPrompts = fixture.userPrompts.map((item) => item.id === first.id ? { ...item, sortOrder: second.sortOrder } : item.id === second.id ? { ...item, sortOrder: first.sortOrder } : item)
        .sort((left, right) => left.sortOrder - right.sortOrder);
    },
  },
  '../application/ManageAssistantPrompts': {
    getSummaryPromptGenerationState: async () => ({ ...summaryGenerationState }),
    applyAssistantDefinitionGlobally: async (draft) => {
      if (failGlobalPromptApply) throw new Error('无法应用正文');
      globalPromptSnapshots.push({ ...draft });
      for (const details of [aiDetails, otherDetails]) {
        details.overrides = [...details.overrides.filter((item) => item.definitionId !== draft.definitionId || item.locale !== 'zh-CN'), { ...draft, locale: 'zh-CN' }];
      }
    },
    applyAssistantDirectToolsGlobally: async (names) => {
      globalSnapshots.push([...names]);
      const ordinary = names.filter((name) => !fixture.tools.find((tool) => tool.name === name).hostOnly);
      for (const details of [aiDetails, otherDetails]) {
        details.directToolNames = [...details.directToolNames.filter((name) => fixture.tools.find((tool) => tool.name === name).hostOnly), ...ordinary];
      }
    },
    getAssistantPromptEditorDetails: async (id) => { aiReads.push(['details', id]); return { ...detailsFor(id) }; },
    saveAssistantDefinitionState: async ({ assistantId, definitionId, enabled }) => {
      detailsFor(assistantId)[{ 'context.device_battery': 'batteryEnabled', 'context.time_awareness': 'timeEnabled', 'context.message_timestamps': 'messageTimestampsEnabled', 'context.user_state': 'userStateEnabled', 'context.social': 'socialEnabled', 'output.paragraph_breaks': 'paragraphBreaksEnabled', 'input.image_grounding': 'imageGroundingEnabled' }[definitionId]] = enabled;
    },
    saveAssistantDefinitionOverride: async (override) => { detailsFor(override.assistantId).overrides = [override]; },
    resetAssistantDefinitionOverride: async ({ assistantId }) => { detailsFor(assistantId).overrides = []; },
    createAssistantUserPrompt: async (prompt) => { detailsFor(prompt.assistantId).userPrompts.push({ ...prompt, id: `exclusive-${prompt.assistantId}` }); },
    setAssistantToolPermission: async (id, name, enabled) => { detailsFor(id).tools = [{ name, enabled }]; },
    setAssistantDirectToolExposure: async (id, name, exposed) => {
      const details = detailsFor(id);
      details.directToolNames = exposed ? [...details.directToolNames, name] : details.directToolNames.filter((item) => item !== name);
    },
  }, './CustomPromptRow': customRows, './promptCenterStyles': editorStyles,
}).default;
// 执行真实 App 入口和 Host 适配，使用原生 Stack 相同的 Router 处理 GO_BACK。
const routeContext = React.createContext(null);
const stackRouter = StackRouter({ initialRouteName: 'settings' });
let dispatch;
const expo = {
  useRouter: () => ({
    push: (href) => {
      const pathname = typeof href === 'string' ? href : href.pathname;
      const name = pathname.slice(1);
      const routeName = routeComponents.has(name) ? name : `${name}/index`;
      assert.ok(routeComponents.has(routeName), `未注册的目的页面：${pathname}`);
      dispatch(StackActions.push(routeName, typeof href === 'string' ? undefined : href.params));
    },
    back: () => dispatch(CommonActions.goBack()),
    setParams: (params) => dispatch(CommonActions.setParams(params)),
  }),
  useLocalSearchParams: () => React.useContext(routeContext).params,
  useFocusEffect: (callback) => {
    const { focused } = React.useContext(routeContext);
    React.useEffect(() => focused ? callback() : undefined, [callback, focused]);
  },
  Redirect: ({ href }) => React.createElement('Redirect', { href }),
};
const refreshContract = load('src/host/navigation/retainedRouteRefreshContract.ts');
const refreshHook = load('src/host/navigation/useRetainedRouteRefreshRevision.ts', { 'expo-router': expo, './retainedRouteRefreshContract': refreshContract });
const RouteContent = load('src/host/navigation/PromptCenterRouteContent.tsx', {
  'react-native': native, 'expo-router': expo, '@features/prompting': { PromptCenterScreen: Screen, listPromptAssistantOptions: async () => {
    if (optionListError) throw new Error('列表读取失败');
    return assistantOptions;
  } }, './useRetainedRouteRefreshRevision': refreshHook,
});
const routeComponents = new Map();
for (const file of fs.readdirSync(path.join(root, 'src/app/prompt-center'), { recursive: true })) {
  if (!file.endsWith('.tsx') || path.basename(file) === '_layout.tsx') continue;
  const relative = `src/app/prompt-center/${file.replaceAll('\\', '/')}`;
  const routeName = relative.slice('src/app/'.length, -4);
  routeComponents.set(routeName, load(relative, { 'expo-router': expo, '@host/navigation/PromptCenterRouteContent': RouteContent }).default);
}
for (const name of ['settings', 'mcp-tools/index', 'chat/[aiId]/protocol', 'profile']) {
  routeComponents.set(name, () => React.createElement('ExternalPage', { name }));
}
const stackConfig = { routeNames: [...routeComponents.keys()], routeParamList: {}, routeGetIdList: {} };
let stackState;
function App() {
  const [state, setState] = React.useState(() => stackRouter.getInitialState(stackConfig));
  stackState = state;
  dispatch = (action) => setState((previous) => stackRouter.getStateForAction(previous, action, stackConfig) ?? previous);
  return state.routes.map((route, index) => React.createElement('RouteSlot', { key: route.key, active: index === state.index },
    React.createElement(routeContext.Provider, { value: { params: route.params ?? {}, focused: index === state.index } },
      React.createElement(routeComponents.get(route.name)))));
}
let screen;
await renderer.act(async () => { screen = renderer.create(React.createElement(App)); });
await renderer.act(async () => expo.useRouter().push('/prompt-center'));
function activeScreen() { return screen.root.findAllByType('RouteSlot').find((node) => node.props.active); }
function text(node) { return typeof node === 'string' ? node : node.children.map(text).join(''); }
function button(label) { return activeScreen().findAllByType('TouchableOpacity').find((node) => node.findAllByType('Text').some((child) => text(child) === label)); }
function currentTitle() { return activeScreen().findByType('Header').props.title; }
async function systemBack() { await renderer.act(async () => dispatch(CommonActions.goBack())); }
assert.ok(!JSON.stringify(screen.toJSON()).includes('私密正文'));
assert.equal(activeScreen().findAllByType('TextInput').length, 0);
// 只断言入口是否可用，失败时不让 assert 展开整棵 React fiber 对象。
assert.ok(button('AI 人设') === undefined);
assert.ok(button('用户人设'), '用户人设不依赖 AI 身份，始终可进入个人资料');
assert.ok(button('协议空间常驻提示词') === undefined);
assert.ok(button('AI 身份池'));
assert.ok(text(activeScreen()).includes('AI 身份池'));
await renderer.act(async () => button('AI 身份池').props.onPress());
assert.equal(stackState.routes.at(-1).name, 'prompt-center/registry');
assert.ok(text(activeScreen()).includes('暂无 AI'));
await systemBack();
await renderer.act(async () => button('用户人设').props.onPress());
assert.equal(stackState.routes.at(-1).name, 'profile');
await systemBack();
assert.equal(currentTitle(), '提示词中心');
const overviewLabels = ['系统基础规则', '换行规则', '人设', '协议空间常驻提示词', 'AI 身份池', '群聊身份背景', '自定义提示词', '工具调用', 'MCP',
  '历史聊天', '工具运行上下文', '用户状态与一起听', '时刻社交信息', '环境信息', 'AI 当前身份状态', '被动记忆', '手机电量', '当前时间', '消息时间戳', '本轮回应要求', '当前聊天'];
const overviewText = text(activeScreen());
assert.ok(overviewText.includes('增加输入 Token') && overviewText.includes('模仿时间格式'), '开关旁明确说明开销和模仿风险');
const overviewPositions = overviewLabels.map((label) => overviewText.indexOf(label));
assert.ok(overviewPositions.every((position, index) => position >= 0 && (index === 0 || position > overviewPositions[index - 1])),
  '页面真实阅读顺序必须与聊天请求的身份、能力、历史和本轮状态契约对应');
await renderer.act(async () => expo.useRouter().push('/prompt-center/persona'));
assert.equal(activeScreen().findByType('Redirect').props.href, '/prompt-center');
assert.equal(activeScreen().findAllByType('TextInput').length, 0);
assert.deepEqual(aiReads, [], '无 AI 的详情路由不能读取任何 AI 数据');
await systemBack();
assert.ok(activeScreen().findAllByType('Switch').every((item) => item.props.disabled));
assert.equal(button('编辑对象').props.disabled, true);
assert.ok(text(activeScreen()).includes('暂无 AI'));
assert.ok(text(activeScreen()).includes('环境信息'));
assert.ok(text(activeScreen()).indexOf('时刻社交信息') < text(activeScreen()).indexOf('环境信息'));
assert.ok(text(activeScreen()).indexOf('环境信息') < text(activeScreen()).indexOf('被动记忆'));
assert.equal(button('环境信息'), undefined, '环境信息只展示说明，不提供详情跳转');
await renderer.act(async () => button('系统基础规则').props.onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, '私密正文不会出现在首页');
assert.equal(button('全局应用'), undefined, '无 AI 默认页不显示一次性应用入口');
const editorInput = activeScreen().findByType('TextInput');
const nativeEditorStyle = Object.assign({}, ...editorInput.props.style.flat(Infinity));
assert.equal(editorInput.props.multiline, true);
assert.ok(nativeEditorStyle.height === undefined || nativeEditorStyle.height >= (nativeEditorStyle.minHeight ?? 0),
  '原生正文编辑区的固定高度不能小于最小高度，否则父布局和文本绘制范围可能不一致');
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('修改后的全局规则'));
await renderer.act(async () => button('保存').props.onPress());
assert.equal(fixture.overrides['foundation.default_core'], '修改后的全局规则');
await renderer.act(async () => button('系统基础规则').props.onPress());
await renderer.act(async () => button('恢复默认').props.onPress());
await renderer.act(async () => alerts.at(-1)[2].find((item) => item.text === '恢复').onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, '代码默认规则');
await renderer.act(async () => activeScreen().findByType('Header').props.onGoBack());
await renderer.act(async () => button('MCP').props.onPress());
assert.equal(stackState.routes.at(-1).name, 'mcp-tools/index');
await systemBack();
await renderer.act(async () => button('工具调用').props.onPress());
assert.equal(currentTitle(), '工具调用');
assert.equal(activeScreen().findAllByProps({ accessibilityLabel: '全局应用特批工具' }).length, 0, '无 AI 时不提供星标全局应用');
assert.equal(activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.accessibilityState.expanded, false, '列表默认折叠');
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.onPress());
assert.ok(text(activeScreen()).includes('选择 AI 后可在工具包中配置特批工具。'));
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.onPress());
await renderer.act(async () => button('主理 AI 专属').props.onPress());
assert.ok(text(activeScreen()).includes('完整主理工具说明'));
assert.equal(activeScreen().findByType('Switch').props.accessibilityLabel, '启用 schedule_self_wake');
assert.equal(activeScreen().findByType('Switch').props.disabled, true);
assert.equal(button('手机工具'), undefined, '包内直接管理主理工具，不显示重复跳转');
assert.ok(!text(activeScreen()).includes('parameters'));
await systemBack();
assert.equal(currentTitle(), '工具调用');
await systemBack();
assert.equal(currentTitle(), '提示词中心');
await renderer.act(async () => button('自定义提示词').props.onPress());
for (const [name, content] of [['第一条', '第一条正文'], ['第二条', '第二条正文']]) {
  await renderer.act(async () => button('添加').props.onPress());
  await renderer.act(async () => {
    activeScreen().findAllByType('TextInput')[0].props.onChangeText(name);
    activeScreen().findAllByType('TextInput')[1].props.onChangeText(content);
  });
  await renderer.act(async () => button('保存').props.onPress());
}
assert.deepEqual(fixture.userPrompts.map((prompt) => prompt.name), ['第一条', '第二条']);
const dragCard = () => activeScreen().findAllByType('View').find((node) => node.props.onResponderRelease && text(node).includes('第一条正文'));
await renderer.act(async () => button('第一条正文').props.onLongPress());
await renderer.act(async () => dragCard().props.onTouchEnd());
assert.equal(dragCard().props.onMoveShouldSetResponderCapture(null, { dy: 40 }), false);
await renderer.act(async () => button('第一条正文').props.onLongPress());
assert.equal(dragCard().props.onMoveShouldSetResponderCapture(null, { dy: 40 }), true);
await renderer.act(async () => dragCard().props.onResponderRelease(null, { dy: 90 }));
assert.deepEqual(fixture.userPrompts.map((prompt) => prompt.name), ['第二条', '第一条']);
await renderer.act(async () => activeScreen().findAllByType('Switch')[0].props.onValueChange(false));
assert.equal(fixture.userPrompts[0].enabled, false);
await renderer.act(async () => button('删除').props.onPress());
await renderer.act(async () => alerts.at(-1)[2].find((item) => item.text === '删除').onPress());
assert.deepEqual(fixture.userPrompts.map((prompt) => prompt.name), ['第一条']);
// 编辑页返回列表后重新读取；系统返回与顶部返回保持同一层级。
await renderer.act(async () => button('第一条正文').props.onPress());
assert.equal(currentTitle(), '编辑提示词');
await renderer.act(async () => activeScreen().findAllByType('TextInput')[1].props.onChangeText('编辑保存后的正文'));
await renderer.act(async () => button('保存').props.onPress());
assert.equal(currentTitle(), '全局常驻提示词');
assert.ok(text(activeScreen()).includes('编辑保存后的正文'));
await systemBack();
assert.equal(currentTitle(), '提示词中心');
await renderer.act(async () => button('系统基础规则').props.onPress());
const ruleEntryDepth = stackState.routes.length;
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('基础规则未保存草稿'));
assert.equal(button('视觉规则'), undefined, '基础页只保留通用规则');
assert.equal(activeScreen().findByType('TextInput').props.value, '基础规则未保存草稿');
assert.equal(stackState.routes.length, ruleEntryDepth);
let finishSave;
definitionSaveGate = new Promise((resolve) => { finishSave = resolve; });
await renderer.act(async () => button('保存').props.onPress());
await systemBack();
assert.equal(currentTitle(), '提示词中心');
await renderer.act(async () => finishSave());
definitionSaveGate = undefined;
assert.equal(fixture.overrides['foundation.default_core'], '基础规则未保存草稿');
assert.equal(currentTitle(), '提示词中心', '系统返回已退出的编辑页不能在保存完成后再次弹出父页');
await systemBack();
assert.equal(stackState.routes.at(-1).name, 'settings');
assert.deepEqual(aiReads, [], '全局概览与工具、自定义提示词只读取全局配置');
// AI 身份贯穿详情路由，人设只读取数据库最新值，协议空间保持对应角色。
assistantOptions = [otherAI, ai];
await renderer.act(async () => expo.useRouter().push('/prompt-center'));
assert.equal(stackState.routes.at(-1).params.assistantId, ai.id, '已有 AI 时应选主理，而不是列表首位');
await renderer.act(async () => button('条件提示词').props.onPress());
assert.equal(stackState.routes.at(-1).name, 'prompt-center/conditional');
assert.equal(stackState.routes.at(-1).params.assistantId, ai.id);
assert.ok(text(activeScreen()).includes('图片'));
assert.ok(activeScreen().findByType('Header').props.help.sections.some((section) => section.body.includes('OCR')));
assert.equal(activeScreen().findAllByType('Switch').length, 0, '条件列表只提供正文页入口');
await renderer.act(async () => button('图片防幻觉提醒').props.onPress());
assert.equal(currentTitle(), '图片防幻觉提醒');
assert.equal(activeScreen().findByType('Switch').props.value, true);
await renderer.act(async () => activeScreen().findByType('Switch').props.onValueChange(false));
assert.equal(activeScreen().findByType('Switch').props.value, false);
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('可编辑图片提醒'));
await renderer.act(async () => button('保存').props.onPress());
assert.equal(currentTitle(), '条件提示词');
await renderer.act(async () => button('图片防幻觉提醒').props.onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, '可编辑图片提醒');
await renderer.act(async () => button('恢复默认').props.onPress());
await renderer.act(async () => alerts.at(-1)[2].find((item) => item.text === '恢复').onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, '图片默认提醒');
assert.equal(activeScreen().findByType('Switch').props.value, false);
await systemBack();
await systemBack();
await renderer.act(async () => button('换行规则').props.onPress());
assert.equal(currentTitle(), '换行规则');
assert.equal(activeScreen().findByType('Switch').props.value, false);
await renderer.act(async () => activeScreen().findByType('Switch').props.onValueChange(true));
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('自定义分段规则'));
await renderer.act(async () => button('保存').props.onPress());
assert.equal(currentTitle(), '提示词中心');
assert.equal(activeScreen().findAllByProps({ accessibilityLabel: '注入换行规则' }).length, 0, '概览不重复提供编辑页开关');
await renderer.act(async () => button('换行规则').props.onPress());
assert.equal(activeScreen().findByType('Switch').props.value, true);
assert.equal(activeScreen().findByType('TextInput').props.value, '自定义分段规则');
await systemBack();
registryAssistants = [{ ...ai, model: 'model-one' }, { ...otherAI, model: 'model-two' }];
await renderer.act(async () => button('AI 身份池').props.onPress());
assert.equal(stackState.routes.at(-1).params?.assistantId, undefined, '全局名单不绑定编辑对象');
const registryCheckboxes = () => activeScreen().findAllByType('TouchableOpacity').filter((node) => node.props.accessibilityRole === 'checkbox');
assert.deepEqual(registryCheckboxes().map((node) => node.props.accessibilityState.checked), [true, true]);
assert.ok(text(activeScreen()).includes('底层模型：model-one'));
const registryHelp = activeScreen().findByType('Header').props.help;
assert.ok(registryHelp?.sections.some((section) => section.body.includes('也不会收到其他 AI 的身份池信息')), '身份池规则说明由标题后的问号承载');
await renderer.act(async () => registryCheckboxes()[0].props.onPress());
assert.deepEqual(registryCheckboxes().map((node) => node.props.accessibilityState.checked), [false, true]);
await systemBack();
await renderer.act(async () => button('AI 身份池').props.onPress());
assert.deepEqual(registryCheckboxes().map((node) => node.props.accessibilityState.checked), [false, true], '返回再进入仍读取已保存的全局名单');
await renderer.act(async () => registryCheckboxes()[0].props.onPress());
await systemBack();
await renderer.act(async () => button('AI 人设').props.onPress());
assert.equal(stackState.routes.at(-1).params.assistantId, ai.id);
assert.ok(text(activeScreen()).includes('原始人设'));
assert.equal(activeScreen().findAllByType('TextInput').length, 0, '人设编辑入口归 AI 个人主页');
assert.equal(button('保存'), undefined);
await renderer.act(async () => {
  ai.persona = '个人主页保存后的人设';
  expo.useRouter().push('/mcp-tools');
});
await systemBack();
assert.ok(text(activeScreen()).includes('个人主页保存后的人设'), '保留的人设页重新获得焦点后读取数据库最新正文');
await systemBack();
assert.equal(currentTitle(), '提示词中心');
await renderer.act(async () => button('协议空间常驻提示词').props.onPress());
assert.equal(stackState.routes.at(-1).name, 'chat/[aiId]/protocol');
assert.equal(stackState.routes.at(-1).params.aiId, ai.id);
await systemBack();
// 时间只保存当前对象；切换后没有继承上一位 AI 的开关。
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入消息时间戳' }).props.value, false);
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '注入消息时间戳' }).props.onValueChange(true));
assert.equal(aiDetails.messageTimestampsEnabled, true);
assert.equal(otherDetails.messageTimestampsEnabled, false);
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '注入当前时间' }).props.onValueChange(false));
assert.equal(aiDetails.timeEnabled, false);
assert.equal(otherDetails.timeEnabled, true);
assert.deepEqual(actions, [], '绑定 AI 的时间开关不能写入全局默认');
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '注入手机电量' }).props.onValueChange(false));
assert.equal(aiDetails.batteryEnabled, false);
assert.equal(otherDetails.batteryEnabled, true);
// 第 11、12 项注入开关同样只保存当前对象，默认开启。
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入用户状态与一起听' }).props.value, true);
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '注入用户状态与一起听' }).props.onValueChange(false));
assert.equal(aiDetails.userStateEnabled, false);
assert.equal(otherDetails.userStateEnabled, true);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入时刻社交信息' }).props.value, true);
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '注入时刻社交信息' }).props.onValueChange(false));
assert.equal(aiDetails.socialEnabled, false);
assert.equal(otherDetails.socialEnabled, true);
await renderer.act(async () => button('工具调用').props.onPress());
await renderer.act(async () => button('主理 AI 专属').props.onPress());
assert.equal(button('手机工具'), undefined, '主理 AI 同样直接在包内管理工具');
await systemBack(); await systemBack();
await renderer.act(async () => button('编辑对象').props.onPress());
await renderer.act(async () => button('另一位 AI').props.onPress());
assert.equal(stackState.routes.at(-1).params.assistantId, otherAI.id);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入当前时间' }).props.value, true);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入消息时间戳' }).props.value, false);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入手机电量' }).props.value, true);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入用户状态与一起听' }).props.value, true);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入时刻社交信息' }).props.value, true);
assert.ok(text(activeScreen()).includes('另一位 AI'));
const globalBefore = JSON.stringify(fixture);
const firstAIOverridesBefore = structuredClone(aiDetails.overrides);
await renderer.act(async () => button('系统基础规则').props.onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, fixture.overrides['foundation.default_core']);
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('只为另一位 AI 修改基础规则'));
await renderer.act(async () => button('保存').props.onPress());
assert.equal(otherDetails.overrides[0].content, '只为另一位 AI 修改基础规则');
assert.deepEqual(aiDetails.overrides, firstAIOverridesBefore);
assert.equal(JSON.stringify(fixture), globalBefore);
await renderer.act(async () => button('自定义提示词').props.onPress());
assert.equal(stackState.routes.at(-1).params.assistantId, otherAI.id);
await renderer.act(async () => button('添加').props.onPress());
await renderer.act(async () => {
  activeScreen().findAllByType('TextInput')[0].props.onChangeText('另一位的规则');
  activeScreen().findAllByType('TextInput')[1].props.onChangeText('只注入另一位');
});
await renderer.act(async () => button('保存').props.onPress());
assert.equal(otherDetails.userPrompts.length, 1);
assert.equal(aiDetails.userPrompts.length, 0);
assert.equal(JSON.stringify(fixture), globalBefore);
await systemBack();
await renderer.act(async () => button('工具调用').props.onPress());
await renderer.act(async () => button('记忆').props.onPress());
assert.equal(activeScreen().findByProps({ accessibilityLabel: '直接暴露 read_memory' }).props.accessibilityState.checked, false);
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '直接暴露 read_memory' }).props.onPress());
assert.equal(activeScreen().findByProps({ accessibilityLabel: '直接暴露 read_memory' }).props.accessibilityState.checked, true);
assert.deepEqual(otherDetails.directToolNames, ['read_memory']);
assert.deepEqual(aiDetails.directToolNames, []);
await renderer.act(async () => activeScreen().findByType('Switch').props.onValueChange(false));
assert.equal(otherDetails.tools[0].name, 'read_memory');
assert.equal(otherDetails.tools[0].enabled, false);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '直接暴露 read_memory' }).props.accessibilityState.checked, true, '关闭调用权限保留星标');
await systemBack();
assert.equal(currentTitle(), '工具调用');
assert.equal(activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.accessibilityState.expanded, false);
assert.ok(text(activeScreen().findByProps({ accessibilityLabel: '特批工具' })).includes('1 个'), '返回列表刷新特批数量');
assert.equal(button('read_memory'), undefined, '折叠时隐藏工具条目');
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.onPress());
assert.ok(button('read_memory'));
assert.ok(text(button('read_memory')).includes('记忆 · 单项权限已关闭'));
await renderer.act(async () => button('read_memory').props.onPress());
assert.equal(currentTitle(), '记忆', '特批条目导航至原工具包');
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '直接暴露 read_memory' }).props.onPress());
assert.deepEqual(otherDetails.directToolNames, []);
assert.deepEqual(aiDetails.tools, []);
await systemBack();
assert.ok(text(activeScreen().findByProps({ accessibilityLabel: '特批工具' })).includes('0 个'));
assert.equal(button('read_memory'), undefined);
assert.ok(text(activeScreen()).includes('暂无特批工具'));
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.onPress());
assert.equal(activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.accessibilityState.expanded, false);
assert.ok(!text(activeScreen()).includes('暂无特批工具'));
await systemBack();
await renderer.act(async () => button('编辑对象').props.onPress());
await renderer.act(async () => button('测试 AI').props.onPress());
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入当前时间' }).props.value, false);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入手机电量' }).props.value, false);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入用户状态与一起听' }).props.value, false);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '注入时刻社交信息' }).props.value, false);
assert.equal(stackState.routes.at(-1).params.assistantId, ai.id);
assert.equal(JSON.stringify(fixture), globalBefore);
// 曾在无 AI 页面添加的内容，在默认绑定主理后仍有明确的管理入口。
await renderer.act(async () => button('自定义提示词').props.onPress());
assert.equal(stackState.routes.at(-1).params.assistantId, ai.id);
await renderer.act(async () => button('全局常驻提示词').props.onPress());
assert.equal(currentTitle(), '全局常驻提示词');
assert.equal(stackState.routes.at(-1).params?.assistantId, undefined);
assert.ok(text(activeScreen()).includes('编辑保存后的正文'));
assert.ok(text(activeScreen()).includes('影响所有 AI'));
await renderer.act(async () => button('编辑保存后的正文').props.onPress());
assert.equal(activeScreen().findAllByType('TextInput')[1].props.value, '编辑保存后的正文');
assert.ok(text(activeScreen()).includes('对所有 AI 生效'));
await systemBack();
await renderer.act(async () => button('删除').props.onPress());
await renderer.act(async () => alerts.at(-1)[2].find((item) => item.text === '删除').onPress());
assert.equal(fixture.userPrompts.length, 0);
assert.equal(otherDetails.userPrompts.length, 1, '删除全局片段不能删除 AI 专属片段');
await systemBack();
assert.equal(currentTitle(), '自定义提示词');
assert.equal(stackState.routes.at(-1).params.assistantId, ai.id);
assert.ok(text(activeScreen()).includes('0 条'));
await systemBack(); await systemBack();
assert.equal(stackState.routes.at(-1).name, 'settings');
await renderer.act(async () => expo.useRouter().push({ pathname: '/prompt-center', params: { assistantId: otherAI.id } }));
assert.equal(stackState.routes.at(-1).params.assistantId, otherAI.id, '从 AI 设置进入应保留指定对象，不自动改为主理');
// 全局应用是独立按钮，不触发折叠；普通 AI 与主理 AI 均可同步普通星标。
await renderer.act(async () => button('工具调用').props.onPress());
assert.ok(text(activeScreen()).indexOf('特批工具') < text(activeScreen()).indexOf('主理 AI 专属'));
assert.ok(text(activeScreen()).indexOf('主理 AI 专属') < text(activeScreen()).indexOf('记忆'), '主理专属工具包排在普通包前面');
await renderer.act(async () => button('主理 AI 专属').props.onPress());
assert.equal(activeScreen().findByProps({ accessibilityLabel: '直接暴露 schedule_self_wake' }).props.disabled, true);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '启用 schedule_self_wake' }).props.disabled, true);
await systemBack();
await renderer.act(async () => button('记忆').props.onPress());
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '直接暴露 read_memory' }).props.onPress());
await systemBack();
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '全局应用特批工具' }).props.onPress());
assert.deepEqual(globalSnapshots.at(-1), ['read_memory']);
assert.deepEqual(aiDetails.directToolNames, ['read_memory']);
assert.equal(activeScreen().findByProps({ accessibilityLabel: '特批工具' }).props.accessibilityState.expanded, false);
assert.equal(alerts.at(-1)[0], '已全局应用');
await systemBack();
await renderer.act(async () => button('编辑对象').props.onPress());
await renderer.act(async () => button('测试 AI').props.onPress());
await renderer.act(async () => button('工具调用').props.onPress());
await renderer.act(async () => button('主理 AI 专属').props.onPress());
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '直接暴露 schedule_self_wake' }).props.onPress());
await systemBack();
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '全局应用特批工具' }).props.onPress());
assert.deepEqual(globalSnapshots.at(-1), ['read_memory', 'schedule_self_wake']);
assert.deepEqual(otherDetails.directToolNames, ['read_memory'], '主理专属星标不得扩散到普通 AI');
await systemBack();
await renderer.act(async () => button('编辑对象').props.onPress());
await renderer.act(async () => button('另一位 AI').props.onPress());
await renderer.act(async () => button('工具调用').props.onPress());
await renderer.act(async () => button('记忆').props.onPress());
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '直接暴露 read_memory' }).props.onPress());
await systemBack();
await renderer.act(async () => activeScreen().findByProps({ accessibilityLabel: '全局应用特批工具' }).props.onPress());
assert.deepEqual(globalSnapshots.at(-1), []);
assert.deepEqual(aiDetails.directToolNames, ['schedule_self_wake'], '普通 AI 的空快照不取消主理专属星标');
assert.equal(otherDetails.tools[0].enabled, false, '同步星标不修改调用权限');
await systemBack();
await systemBack();
// 当前草稿可直接全局应用，操作后保留编辑页；内置正文与两级摘要共用同一行为。
await renderer.act(async () => expo.useRouter().push({ pathname: '/prompt-center', params: { assistantId: ai.id } }));
const switchStates = (details) => [details.paragraphBreaksEnabled, details.imageGroundingEnabled, details.timeEnabled, details.batteryEnabled];
const uiSwitchStatesBefore = [switchStates(aiDetails), switchStates(otherDetails)];
const globalDefaultBeforeApply = structuredClone(fixture);
for (const [definitionId, label] of [['foundation.default_core', '系统基础规则'], ['output.paragraph_breaks', '换行规则'], ['input.image_grounding', '图片防幻觉提醒'], ['internal.chat_summary', '一级摘要提示词'], ['internal.chat_secondary_summary', '二级摘要提示词']]) {
  if (definitionId === 'input.image_grounding') await renderer.act(async () => button('条件提示词').props.onPress());
  const summaryRule = definitionId.startsWith('internal.chat_');
  if (summaryRule) {
    await renderer.act(async () => button('其他提示词').props.onPress());
    assert.equal(currentTitle(), '其他提示词');
    assert.equal(activeScreen().findAllByType('TextInput').length, 0);
  }
  await renderer.act(async () => button(label).props.onPress());
  if (summaryRule) {
    assert.equal(activeScreen().findAllByType('Switch').length, 0, '摘要提示词不拥有独立开关');
    assert.ok(text(activeScreen()).includes('已开启'));
  }
  const draft = `当前未保存草稿：${label}`;
  await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText(draft));
  assert.ok(activeScreen().findByType('Header').props.help.sections.some((section) => section.title === '全局应用'));
  await renderer.act(async () => button('全局应用').props.onPress());
  assert.deepEqual(globalPromptSnapshots.at(-1), { definitionId, content: draft });
  assert.equal(currentTitle(), label);
  assert.equal(activeScreen().findByType('TextInput').props.value, draft);
  assert.equal(alerts.at(-1)[0], '已全局应用');
  for (const details of [aiDetails, otherDetails]) assert.equal(details.overrides.find((item) => item.definitionId === definitionId && item.locale === 'zh-CN').content, draft);
  assert.deepEqual([switchStates(aiDetails), switchStates(otherDetails)], uiSwitchStatesBefore);
  await systemBack();
  if (definitionId === 'input.image_grounding' || summaryRule) await systemBack();
}
assert.deepEqual(fixture, globalDefaultBeforeApply);
// 「其他提示词」同时承载视觉识别正文；编辑器按内置默认回落，并共用覆盖与全局应用。
await renderer.act(async () => button('其他提示词').props.onPress());
await renderer.act(async () => button('图片识别提示词').props.onPress());
assert.equal(currentTitle(), '图片识别提示词');
assert.equal(activeScreen().findByType('TextInput').props.value, '默认图片识别规则');
assert.equal(activeScreen().findAllByType('Switch').length, 0, '图片识别提示词没有独立开关');
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('自定义图片识别正文'));
await renderer.act(async () => button('全局应用').props.onPress());
assert.deepEqual(globalPromptSnapshots.at(-1), { definitionId: 'internal.vision_ocr', content: '自定义图片识别正文' });
await renderer.act(async () => button('恢复默认').props.onPress());
await renderer.act(async () => alerts.at(-1)[2].find((item) => item.text === '恢复').onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, '默认图片识别规则');
await systemBack();
await systemBack();
// 关闭期间仍可编辑；从摘要设置回来时刷新状态，但不覆盖编辑草稿。
summaryGenerationState = { primaryEnabled: true, secondaryEnabled: false };
await renderer.act(async () => button('其他提示词').props.onPress());
await renderer.act(async () => button('二级摘要提示词').props.onPress());
assert.ok(text(activeScreen()).includes('已关闭'));
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('关闭期间保存的摘要规则'));
await renderer.act(async () => button('保存').props.onPress());
assert.equal(currentTitle(), '其他提示词');
summaryGenerationState = { primaryEnabled: true, secondaryEnabled: true };
await renderer.act(async () => button('二级摘要提示词').props.onPress());
assert.ok(text(activeScreen()).includes('已开启'));
assert.equal(activeScreen().findByType('TextInput').props.value, '关闭期间保存的摘要规则');
await renderer.act(async () => button('恢复默认').props.onPress());
await renderer.act(async () => alerts.at(-1)[2].find((item) => item.text === '恢复').onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, '默认二级摘要规则');
assert.deepEqual(summaryGenerationState, { primaryEnabled: true, secondaryEnabled: true });
await systemBack();
await systemBack();
await renderer.act(async () => button('系统基础规则').props.onPress());
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText(''));
await renderer.act(async () => button('保存').props.onPress());
await renderer.act(async () => button('系统基础规则').props.onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, '', '重新打开编辑页保留主动清空的正文');
await renderer.act(async () => button('全局应用').props.onPress());
assert.deepEqual(globalPromptSnapshots.at(-1), { definitionId: 'foundation.default_core', content: '' });
await renderer.act(async () => button('恢复默认').props.onPress());
await renderer.act(async () => alerts.at(-1)[2].find((item) => item.text === '恢复').onPress());
assert.equal(activeScreen().findByType('TextInput').props.value, fixture.overrides['foundation.default_core'] ?? '代码默认规则');
assert.equal(otherDetails.overrides.find((item) => item.definitionId === 'foundation.default_core').content, '', '单独恢复默认不改写其他 AI 的空覆盖');
await renderer.act(async () => activeScreen().findByType('TextInput').props.onChangeText('失败时保留编辑草稿'));
const uiOverridesBeforeFailure = structuredClone([aiDetails.overrides, otherDetails.overrides]);
failGlobalPromptApply = true;
await renderer.act(async () => button('全局应用').props.onPress());
assert.equal(alerts.at(-1)[0], '保存失败');
assert.equal(activeScreen().findByType('TextInput').props.value, '失败时保留编辑草稿');
assert.deepEqual([aiDetails.overrides, otherDetails.overrides], uiOverridesBeforeFailure);
assert.equal(button('全局应用').props.disabled, false);
failGlobalPromptApply = false;
await systemBack();
await systemBack();
optionListError = true;
await renderer.act(async () => expo.useRouter().push('/prompt-center'));
assert.ok(text(activeScreen()).includes('未能读取 AI 列表'));
assert.equal(button('系统基础规则'), undefined, '列表读取失败时不能退回可编辑全局配置');
await systemBack();
await renderer.act(async () => screen.unmount());

// 切换到不支持的接口时呈现不可用，不把保留的权限和星标显示成正在生效。
fixture.tools.push({ name: 'kimi_web_search', owner: 'webTools', packageId: 'kimiOfficial', hostOnly: false,
  defaultEnabled: false, enabled: false, mutating: false, callOnly: false, description: 'Kimi 官方搜索' });
aiDetails.tools = [{ name: 'kimi_web_search', enabled: true, unavailableReason: '当前接口不支持，仅限 Moonshot 官方 API；已保存偏好会保留。' }];
aiDetails.directToolNames = ['kimi_web_search'];
const kimiProps = { assistantId: ai.id, assistants: [ai], assistantListError: false, page: { kind: 'package', id: 'kimiOfficial' },
  refreshRevision: 0, onBack() {}, onOpenPage() {} };
let kimiScreen;
await renderer.act(async () => { kimiScreen = renderer.create(React.createElement(Screen, kimiProps)); });
assert.equal(kimiScreen.root.findByType('Header').props.title, 'Kimi 官方工具');
const kimiToggle = () => kimiScreen.root.findByProps({ accessibilityLabel: '启用 kimi_web_search' });
const kimiStar = () => kimiScreen.root.findByProps({ accessibilityLabel: '直接暴露 kimi_web_search' });
assert.equal(kimiToggle().props.disabled, true);
assert.equal(kimiToggle().props.value, false);
assert.equal(kimiStar().props.disabled, true);
assert.equal(kimiStar().props.accessibilityState.checked, false);
assert.ok(text(kimiScreen.root).includes('当前接口不支持'));
assert.ok(text(kimiScreen.root).includes('已保存偏好：允许调用，已设特批'));
aiDetails.tools = [{ name: 'kimi_web_search', enabled: true }];
await renderer.act(async () => kimiScreen.update(React.createElement(Screen, { ...kimiProps, refreshRevision: 1 })));
assert.equal(kimiToggle().props.disabled, false);
assert.equal(kimiToggle().props.value, true, '恢复官方接口后沿用已保存的调用权限');
assert.equal(kimiStar().props.accessibilityState.checked, true, '恢复官方接口后沿用已保存的星标');
await renderer.act(async () => kimiToggle().props.onValueChange(false));
assert.equal(kimiToggle().props.value, false);
assert.equal(kimiStar().props.accessibilityState.checked, true, '关闭权限不会删除星标偏好');
await renderer.act(async () => kimiScreen.unmount());

glassEnabled = true;
let glassScreen;
await renderer.act(async () => { glassScreen = renderer.create(React.createElement(Screen, { ...kimiProps, page: { kind: 'conditional' } })); });
assert.equal(glassScreen.root.findAllByType('GlassSurface').length, 1, '玻璃主题的图片设置沿用原生玻璃条目');
assert.equal(glassScreen.root.findAllByType('TextInput').length, 0, '条件列表不展开正文编辑器');
assert.ok(glassScreen.root.findByType('Header').props.help.sections.length > 0);
await renderer.act(async () => glassScreen.unmount());
database.close();
console.log('提示词顺序与默认概览行为通过：历史后系统上下文、批量输入、工具续轮、中文与配置继承、编辑重置、真实路由接线、逐层返回、主理默认选择、AI 切换隔离、按 AI 保存时间、手机开关所有权、全局提示词管理，以及身份池名单保存、默认入选、模型名注入和排除记录隐私。');
