import { repoRoot as root } from '../helpers/repo-root.mjs';
import { CHAT_PROMPT_READING_FLOW } from '../helpers/prompt-reading-flow.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


function load(relative, mocks = {}, clock = Date) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'Date', compiled.outputText)((id) => {
    assert.ok(Object.hasOwn(mocks, id), `${relative} 未提供依赖 ${id}`);
    return mocks[id];
  }, module, module.exports, clock);
  return module.exports;
}

let batteryReads = 0;
let batterySnapshot = { status: 'available', levelPercent: 23, chargingState: 'not_charging' };
const { createDeviceBatteryPromptBlocks } = load('src/host/prompt/DeviceBatteryPromptBlock.ts', {
  '@platform/device': { getDeviceBatterySnapshot: async () => { batteryReads++; return batterySnapshot; } },
});
assert.deepEqual(await createDeviceBatteryPromptBlocks(false, 'chat.private_reply'), []);
assert.equal(batteryReads, 0, '关闭注入时不读取设备电池');
const blocks = await createDeviceBatteryPromptBlocks(true, 'chat.private_reply');
assert.equal(batteryReads, 1);
assert.match(blocks[0].content, /23%，未充电/);
const estimator = { ...load('src/shared/prompt/estimateTextTokens.ts'), ...load('src/shared/prompt/messageTimestamp.ts') };
const budget = load('src/host/prompt/tokenBudget.ts', { '@shared/prompt': estimator });
const metadata = load('src/host/prompt/compiler/promptBlockMetadata.ts');
const { PromptPackCompiler } = load('src/host/prompt/compiler/PromptPackCompiler.ts', {
    '@shared/prompt': { CHAT_PROMPT_READING_FLOW, ...estimator },
  '../tokenBudget': budget, './promptBlockMetadata': metadata,
});
const { getSystemPromptPreset } = load('src/host/prompt/compiler/systemPromptPresets.ts');
const preset = getSystemPromptPreset('chat.private_reply');
preset.items.push({ definitionId: 'context.device_battery', enabled: true, required: false, protection: 'overridable', slot: 'dynamic_context', sortOrder: 195 });
const draft = (key, content) => ({ key, content, title: key, status: 'ready', placement: 'system', required: false });
const input = { role: 'user', content: '你好' };
const pack = new PromptPackCompiler().compile({ scenario: 'chat.private_reply', preset,
  blocks: [...blocks, draft('time_awareness', '现在时间'), draft('passive_memory', '历史资料'), draft('foundation_default_core', '基础规则'),
    { ...draft('current_input', input.content), placement: 'input', required: true }], recentMessages: [], currentInput: input });
assert.equal(pack.systemPrompt, '基础规则');
assert.ok(pack.dynamicSystemPrompt.endsWith(`${blocks[0].content}\n\n现在时间`));
assert.equal(batteryReads, 1, '编译与工具续轮不再读取第二份电量');
batterySnapshot = { status: 'available', levelPercent: 100, chargingState: 'full' };
assert.match((await createDeviceBatteryPromptBlocks(true, 'raven_cat.autonomous_wake'))[0].content, /已充满，连接电源/);
batterySnapshot = { status: 'unavailable' };
assert.deepEqual(await createDeviceBatteryPromptBlocks(true, 'chat.private_reply'), [], '不可用不伪造零电量');

// 执行真实配置解析与 Host 装配入口，关闭的一位 AI 不读取，另一位仍可注入。
const states = new Map([['ai-off', [{ definitionId: 'context.device_battery', enabled: false }]]]);
const prompting = load('src/features/prompting/application/ManageAssistantPrompts.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => ({
    assistantPrompts: { listDefinitionStates: async (id) => states.get(id) ?? [], listDefinitionOverrides: async () => [], listAssistantUserPrompts: async () => [] },
    defaults: { read: async () => ({ overrides: {}, userPrompts: [], toolPermissions: {} }) },
  }) },
});
const resolvedAssembler = load('src/host/prompt/ResolvedPromptPackAssembler.ts', {
  '@features/profile': { getCurrentUserProfile: async () => ({ name: '用户' }) },
  './PromptPackBlockFactory': { promptPackBlockFactory: {} },
  '@features/prompting': { ...prompting, listPromptCustomBlocks: async () => [], resolveLegacyPromptPreset: async () => ({ preset }) },
  './PromptPackAssembler': { promptPackAssembler: { assembleChatPromptPack: async (params) => params } },
  './PromptBuiltInContent': { PARAGRAPH_BREAK_SCENARIOS: [] },
  './compiler': {}, './DeviceBatteryPromptBlock': { createDeviceBatteryPromptBlocks },
});
batterySnapshot = { status: 'available', levelPercent: 42, chargingState: 'charging' };
const readsBefore = batteryReads;
const off = await resolvedAssembler.assembleResolvedChatPromptPack({ aiConfig: { id: 'ai-off' } });
assert.equal(batteryReads, readsBefore);
assert.ok(!off.additionalBlocks.some((block) => block.key === 'device_battery'));
const on = await resolvedAssembler.assembleResolvedChatPromptPack({ aiConfig: { id: 'ai-on' } });
assert.equal(batteryReads, readsBefore + 1);
assert.match(on.additionalBlocks[0].content, /42%，正在充电/);
await resolvedAssembler.assembleResolvedChatPromptPack({ aiConfig: { id: 'ai-off' }, runtimeContext: { triggerSource: 'raven_cat_wake' } });
assert.equal(batteryReads, readsBefore + 1, '自主任务也遵守同一电量开关');

const fixedTime = new Date(2026, 9, 7, 12).getTime();
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedTime])); } }
let currentHost = 'host';
let usageReads = 0;
let usageResult = { status: 'permission_not_granted' };
let queried;
const usage = load('src/features/phoneTools/aiTools/GetAppUsageTool.ts', {
  '@features/assistants': { runAsCurrentHostAuthority: async (id, action) => id === currentHost ? { status: 'authorized', value: await action() } : { status: 'not_current_host' } },
  '@platform/device': { queryAppUsage: async (start, end) => { usageReads++; queried = [start, end]; return usageResult; } },
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
}, FixedDate);
const context = { getAIId: () => 'host', abortSignal: new AbortController().signal };
const { LegacyAgentToolAdapter } = load('src/host/composition/agent/LegacyAgentToolAdapter.ts');
const usageAdapter = new LegacyAgentToolAdapter(usage.GetAppUsageTool,
  { owner: 'phoneTools', risk: 'private_read', idempotency: 'idempotent' }, () => context);
assert.match((await usage.execute({ period: 'today' }, context)).error, /usage_access_not_granted/);
assert.deepEqual(queried, [new Date(2026, 9, 7).getTime(), fixedTime]);
usageResult = { status: 'device_locked' };
assert.match((await usage.execute({ period: 'today' }, context)).error, /device_locked/);
usageResult = { status: 'available', apps: [
  { packageName: 'music', foregroundTimeMs: 120_000, firstTimestampEpochMs: fixedTime - 86_400_000, lastTimestampEpochMs: fixedTime, lastTimeUsedEpochMs: fixedTime },
  { packageName: 'chat', foregroundTimeMs: 3_600_000, firstTimestampEpochMs: fixedTime - 86_400_000, lastTimestampEpochMs: fixedTime, lastTimeUsedEpochMs: fixedTime },
] };
let result = await usage.execute({ period: 'yesterday', limit: 1 }, context);
assert.deepEqual(queried, [new Date(2026, 9, 6).getTime(), new Date(2026, 9, 7).getTime()]);
assert.equal(result.data.apps[0].packageName, 'chat');
assert.equal(result.data.apps[0].foregroundTimeMs, 3_600_000);
assert.equal(result.data.apps[0].statisticsStart, new Date(fixedTime - 86_400_000).toISOString());
assert.equal(result.data.truncated, true);
// 校验模型实际收到的 observation，而不只校验运行时保存的结构化 data。
const observation = await usageAdapter.execute({ period: 'yesterday', limit: 1 }, {});
assert.equal(observation.status, 'success');
assert.ok(observation.modelContent.includes('chat'), '模型能看到应用身份');
assert.ok(observation.modelContent.includes('3600000'), '模型能看到实际前台使用毫秒数');
assert.ok(observation.modelContent.includes(observation.data.requestedStart), '模型能看到查询起点');
assert.ok(observation.modelContent.includes(observation.data.requestedEnd), '模型能看到查询终点');
assert.ok(observation.modelContent.includes(observation.data.apps[0].statisticsStart), '模型能区分系统统计边界');
assert.ok(!observation.modelContent.includes('music'), '截断掉的应用不进入模型 observation');
result = await usage.execute({ period: 'last_7_days', packageName: 'music' }, context);
assert.deepEqual(queried, [new Date(2026, 9, 1).getTime(), fixedTime]);
assert.equal(result.data.apps.length, 1);
assert.equal(result.data.apps[0].packageName, 'music');
usageResult = { status: 'available', apps: [] };
const emptyObservation = await usageAdapter.execute({ period: 'today' }, {});
assert.equal(emptyObservation.status, 'success', '无记录与读取失败分别表达');
assert.deepEqual(emptyObservation.data.apps, []);
assert.match(emptyObservation.modelContent, /"apps":\s*\[\s*\]/, '模型收到空应用列表');
const beforeUnauthorized = usageReads;
currentHost = 'other';
assert.match((await usage.execute({ period: 'today' }, context)).error, /not_current_host/);
assert.equal(usageReads, beforeUnauthorized);
currentHost = 'host';
const controller = new AbortController(); controller.abort();
await assert.rejects(usage.execute({ period: 'today' }, { ...context, abortSignal: controller.signal }));
assert.equal(usageReads, beforeUnauthorized);
console.log('电量配置、单轮注入顺序及应用使用时长工具行为验证通过。');
