/** 验证身份、历史、当前环境与机器触发资料的真实装配契约。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { CHAT_PROMPT_READING_FLOW } from './helpers/prompt-reading-flow.mjs';
const root = path.resolve(import.meta.dirname, '..');
function load(file, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(root, path.dirname(file), id + '.ts')), mocks);
    throw new Error(`${file} 未提供依赖 ${id}`);
  }, module, module.exports);
  return module.exports;
}
const shared = { CHAT_PROMPT_READING_FLOW, ...load('src/shared/prompt/estimateTextTokens.ts'),
  ...load('src/shared/prompt/messageTimestamp.ts') };
const compiler = load('src/host/prompt/compiler/PromptPackCompiler.ts', { '@shared/prompt': shared });
const presets = load('src/host/prompt/compiler/systemPromptPresets.ts');
const { promptPackBlockFactory: factory } = load('src/host/prompt/PromptPackBlockFactory.ts', {
  '@shared': { DEFAULT_SELF_NAME: '枫渡' }, '@features/memory': { recallPassiveMemory: async () => [] },
  '@features/moments': {}, '@features/assistants': {
    getAssistantNicknamePromptContext: async () => ({ content: '当前昵称：daddy' }),
    getHostAICooldownStatus: async () => ({ appointment: { isInCooldown: true, revokedAIId: 'self', remainingDays: 2, endAt: '2026-10-18' } }),
  },
});
const omitted = key => ({ key, title: key, content: '', required: false, status: 'omitted', placement: 'system' });
factory.resolveUserIdentity = async () => ({ displayName: '枫渡', source: 'profile', profile: null });
const history = [{ role: 'user', content: '先前的真实用户输入' }, { role: 'assistant', content: '先前回复' },
  { role: 'user', content: '最后一条真实用户发言，应用触发时也不能被删除' }];
const { promptPackAssembler: assembler } = load('src/host/prompt/PromptPackAssembler.ts', {
  '@features/companion': { loadAIScheduleContext: async () => '- 测试日程结果：错过任务已跳过，不补跑。' },
  './PromptPackBlockFactory': { promptPackBlockFactory: factory },
  './compiler/PromptPackCompiler': compiler, './compiler/systemPromptPresets': presets,
  './PromptHistoryBuilder': { promptHistoryBuilder: {
    loadPrivateSummaryContext: async () => ({ messages: history, summaryContent: '本会话摘要' }),
    loadGroupSummaryContext: async () => ({ messages: history, summaryContent: '群摘要' }),
    loadBackgroundContext: async () => '跨会话背景', loadRecentMessages: async () => history,
  } },
  './providers': { renderHostPromptProviderBlock: async (id, { params }) => {
    if (id === 'context.assistant_nickname') return factory.createAssistantNicknameBlock(params.aiConfig.id);
    if (id === 'context.host_cooldown') return factory.createHostCooldownBlock(params.aiConfig);
    if (id === 'context.group_chat') return factory.createGroupChatContextBlock(params.runtimeContext);
    return omitted({ 'context.protocol_space': 'protocol_space', 'context.agent_registry': 'agent_registry_summary',
      'context.moments_social_inbox': 'moments_social_inbox', 'context.passive_memory': 'passive_memory' }[id]);
  } },
});
const params = { sessionId: 'session', currentInput: '你好', aiConfig: { id: 'self', name: 'AI', systemPrompt: '角色人设' },
  toolContext: {}, runtimeContext: {} };
const chat = await assembler.assembleChatPromptPack(params);
assert.match(chat.stableSystemPrompt, /角色人设[\s\S]*当前昵称：daddy/);
assert.doesNotMatch(chat.stableSystemPrompt, /本轮交互环境|冷静期状态/);
assert.match(chat.dynamicSystemPrompt, /一对一单聊/);
assert.match(chat.dynamicSystemPrompt, /冷静期剩余 2 天/);
assert.equal(chat.modelMessages.at(-1).content, '你好');
assert.deepEqual(chat.modelMessages.slice(0, history.length), history);
const groupContext = { groupId: 'group', groupName: '我们的群', currentAIId: 'self', currentAIName: 'AI',
  currentAgentId: 'actor-self', recentWindowLimit: 10, members: [{ aiAssistantId: 'self', agentId: 'actor-self', name: 'AI' }] };
const group = await assembler.assembleChatPromptPack({ ...params, runtimeContext: { groupChat: groupContext } });
assert.match(group.stableSystemPrompt, /群聊身份背景[\s\S]*你自己/);
assert.ok(group.stableSystemPrompt.includes(`group_id：${groupContext.groupId}`), '实际群回复提示词必须提供当前群工具标识');
assert.match(group.dynamicSystemPrompt, /交互位置：多 AI 群聊“我们的群”/);
assert.doesNotMatch(group.dynamicSystemPrompt, /【群成员】/);
const ledger = await assembler.assembleLedgerPromptPack({ ...params, currentInput: '新增支出：午饭 20 元',
  runtimeContext: { inputSource: 'application', forceAppendUserText: true, triggerSource: 'ledger' } });
assert.equal(ledger.currentInput, null);
assert.equal(ledger.modelMessages.at(-1).role, 'system');
assert.deepEqual(ledger.modelMessages.slice(0, history.length), history);
assert.match(ledger.dynamicSystemPrompt, /一对一单聊[\s\S]*记账应用[\s\S]*新增支出：午饭 20 元/);
assert.doesNotMatch(ledger.stableSystemPrompt, /账本回复要求|新增支出/);
assert.match(ledger.outputRequirement, /1~3 句/);
const { buildAIScheduleTriggerBlocks } = load('src/features/companion/application/CompanionPromptBlocks.ts', {
  '@features/chat': load('src/features/chat/reply/application/AutonomousReplyContract.ts'),
});
const scheduleBlocks = buildAIScheduleTriggerBlocks({ scheduleId: 'due-schedule', remindAt: '2026-10-16T01:00:00Z',
  triggeredAt: '2026-10-16T01:00:03Z', summary: '约好的问候', details: '看看用户现在怎样', sourceExcerpt: null });
const autonomous = await assembler.assembleChatPromptPack({ ...params, currentInput: '', additionalBlocks: scheduleBlocks,
  runtimeContext: { inputSource: 'application', forceAppendUserText: true, triggerSource: 'raven_cat_ai_schedule' } });
assert.equal(autonomous.currentInput, null);
assert.deepEqual(autonomous.modelMessages.slice(0, history.length), history);
assert.equal(autonomous.modelMessages.at(-1).role, 'system');
assert.equal(autonomous.stableSystemPrompt, chat.stableSystemPrompt, '日程复用单聊固定背景，不把触发规则塞进前缀');
assert.match(autonomous.dynamicSystemPrompt, /自主活动时间[\s\S]*due-schedule[\s\S]*约好的问候/);
assert.match(autonomous.outputRequirement, /独立气泡/);
assert.doesNotMatch(autonomous.dynamicSystemPrompt, /普通 assistant\/final 文本作为行动记录/);
assert.equal(autonomous.modelMessages.length, history.length + 1, '机器触发不额外伪造 user 消息');
const feedback = await assembler.assembleChatPromptPack({ ...params,
  runtimeContext: { triggerSource: 'chat', replyRunId: 'feedback-run' } });
assert.equal(feedback.stableSystemPrompt, chat.stableSystemPrompt, '日程结果只进入动态环境，不污染稳定前缀');
assert.match(feedback.blocks.find(block => block.key === 'interaction_environment').content, /错过任务已跳过/);
assert.match(feedback.modelMessages.at(-2).content, /错过任务已跳过/, '结果真实进入请求，而不是只存在于展示块');
const regenerated = await assembler.assembleChatPromptPack({ ...params,
  runtimeContext: { triggerSource: 'chat', replyRunId: 'regenerate-run', isRegeneration: true } });
assert.doesNotMatch(regenerated.dynamicSystemPrompt, /错过任务已跳过/, '显式重写不消费新的日程交接');
// 单聊、群聊与应用触发的本轮状态必须遵循中心顺序，不能被旧预设的排序数值覆盖。
for (const pack of [chat, group, ledger, autonomous]) {
  const stateKeys = ['interaction_environment', 'host_cooldown', 'time_awareness'];
  assert.deepEqual(pack.blocks.filter(block => stateKeys.includes(block.key)).map(block => block.key), stateKeys,
    `${pack.scenario} 应先读环境和当前身份，再读当前时间`);
}
// 真实 Wallet 入口只交付账目资料，Host 网关保留应用触发来源。
let walletRequest;
const { createWalletChatReplyGateway } = load('src/host/composition/createWalletChatReplyGateway.ts', {
  '@features/chat': { resolveCanonicalConversation: async () => ({ id: 'wallet-chat' }),
    requestProactiveChatReply: async request => { walletRequest = request; return { message: '午饭记好了' }; } },
});
const { triggerLedgerAIReply } = load('src/features/wallet/application/TriggerLedgerAIReply.ts');
const ledgerResult = await triggerLedgerAIReply({
  aiProfile: { id: 'self', agentId: 'actor-self', name: 'AI', model: 'test', apiKey: 'test' },
  newRecords: [{ id: 'record-1', recordDate: '2026-10-16', type: 'expense', category: '午饭', amount: 20, detail: null }],
}, { hostRepository: { cleanupExpiredBlocks: async () => {}, isAIBlocked: async () => ({ isBlocked: false }) },
  ledgerRepository: { getRecords: async () => [] }, chatReplyGateway: createWalletChatReplyGateway() });
assert.equal(ledgerResult.success, true);
assert.equal(walletRequest.triggerSource, 'ledger');
assert.equal(walletRequest.sessionId, 'wallet-chat');
assert.match(walletRequest.currentInput, /午饭[\s\S]*20/);
assert.doesNotMatch(walletRequest.currentInput, /你正在接收|回复控制|保持你自己|不是用户/);
// 换行与动作描写只影响普通聊天正文，开关、覆盖正文与窄任务隔离由真实组装器验证。
let paragraphBreaksEnabled = false;
let actionDescriptionEnabled = false;
let coreOverride;
const paragraphOverride = '本轮自定义分段规则';
const actionOverride = '本轮自定义动作描写规则';
const resolvedAssembler = load('src/host/prompt/ResolvedPromptPackAssembler.ts', {
  '@features/prompting': {
    listPromptCustomBlocks: async () => [],
    resolveLegacyPromptPreset: async ({ scenarioId }) => ({ preset: presets.getSystemPromptPreset(scenarioId) }),
    resolveAssistantPromptConfiguration: async () => ({
      paragraphBreaksEnabled, actionDescriptionEnabled, timeEnabled: true, batteryEnabled: false, userStateEnabled: true, socialEnabled: true,
      disabledDefinitionIds: [], overrides: {
        'output.paragraph_breaks': paragraphOverride, 'output.action_description': actionOverride,
        ...(coreOverride === undefined ? {} : { 'foundation.default_core': coreOverride }),
      }, userPrompts: [],
      agentRegistryExcludedAssistantIds: [], messageTimestampsEnabled: false,
    }),
  },
  './PromptPackAssembler': { promptPackAssembler: assembler }, './compiler': compiler,
  './PromptPackBlockFactory': { promptPackBlockFactory: factory },
  './DeviceBatteryPromptBlock': { createDeviceBatteryPromptBlocks: async () => [] },
});
const closedPack = await resolvedAssembler.assembleResolvedChatPromptPack(params);
assert.equal(closedPack.blocks.some((block) => block.content.includes(paragraphOverride)), false);
assert.equal(closedPack.blocks.some((block) => block.content.includes(actionOverride)), false);
actionDescriptionEnabled = true;
const actionOnlyPack = await resolvedAssembler.assembleResolvedChatPromptPack(params);
assert.ok(actionOnlyPack.stableSystemPrompt.includes(actionOverride), '动作描写规则独立注入稳定前缀');
assert.equal(actionOnlyPack.stableSystemPrompt.includes(paragraphOverride), false, '两条规则的开关互不影响');
paragraphBreaksEnabled = true;
for (const input of [params, { ...params, runtimeContext: { groupChat: groupContext } },
  { ...params, runtimeContext: { triggerSource: 'ledger', inputSource: 'application' } },
  { ...params, currentInput: '', additionalBlocks: scheduleBlocks, runtimeContext: { triggerSource: 'raven_cat_ai_schedule', inputSource: 'application' } }]) {
  const result = await resolvedAssembler.assembleResolvedChatPromptPack(input);
  assert.ok(result.stableSystemPrompt.includes(paragraphOverride), `${result.scenario} 应在稳定前缀使用编辑后的换行规则`);
  assert.ok(result.stableSystemPrompt.includes(actionOverride), `${result.scenario} 应在稳定前缀使用编辑后的动作描写规则`);
  assert.equal(result.outputRequirement.includes(paragraphOverride), false);
  const foundationEnd = result.stableSystemPrompt.indexOf(result.blocks.find((block) => block.definitionId === 'foundation.default_core').content);
  assert.ok(foundationEnd < result.stableSystemPrompt.indexOf(paragraphOverride));
  assert.ok(result.stableSystemPrompt.indexOf(paragraphOverride) < result.stableSystemPrompt.indexOf(actionOverride), '动作描写规则排在换行规则之后');
  assert.ok(result.stableSystemPrompt.indexOf(actionOverride) < result.stableSystemPrompt.indexOf('角色人设'), '两条规则都位于系统基础规则与人设之间');
  assert.equal(result.recentMessages.some((message) => message.content.includes(actionOverride)), false);
}
const callBlocks = load('src/features/calls/application/CallPromptBlocks.ts');
const callPack = await resolvedAssembler.assembleResolvedChatPromptPack({ ...params,
  runtimeContext: { triggerSource: 'call' }, additionalBlocks: callBlocks.buildCallLivePromptBlocks() });
assert.equal(callPack.blocks.some((block) => block.content.includes(paragraphOverride)), false, '通话口语不注入换行规则');
assert.equal(callPack.blocks.some((block) => block.content.includes(actionOverride)), false, '通话口语不注入动作描写规则');
const summaryTask = { key: 'chat_summary_task', definitionId: 'internal.chat_summary', slot: 'output_contract',
  protection: 'locked', title: '摘要任务', content: '只输出摘要 JSON', required: true, status: 'ready', placement: 'system' };
const summaryPack = await resolvedAssembler.assembleResolvedSummaryPromptPack(params, summaryTask);
assert.equal(summaryPack.blocks.some((block) => block.content.includes(paragraphOverride)), false, '摘要不继承聊天排版要求');
assert.equal(summaryPack.blocks.some((block) => block.content.includes(actionOverride)), false, '摘要不继承动作描写要求');
coreOverride = '';
for (const result of [await resolvedAssembler.assembleResolvedChatPromptPack(params), await resolvedAssembler.assembleResolvedSummaryPromptPack(params, summaryTask)]) {
  const core = result.blocks.find((block) => block.definitionId === 'foundation.default_core');
  assert.equal(core.content, '');
  assert.equal(core.status, 'omitted');
  assert.equal(result.systemPrompt.includes(factory.createFoundationBlock(params.aiConfig).content), false, '空基础规则不得回填代码默认正文');
  assert.ok(result.stableSystemPrompt.includes('角色人设'), '省略基础规则仍保留人设');
}
console.log('上下文装配：单聊、群聊身份、冷静期、账本和日程的角色、顺序及共同前缀，以及换行与动作描写的开关、顺序、正文覆盖和任务隔离验证通过。');
