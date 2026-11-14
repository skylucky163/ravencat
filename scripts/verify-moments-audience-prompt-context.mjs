import { CHAT_PROMPT_READING_FLOW } from './helpers/prompt-reading-flow.mjs';
/** 验证群聊工具目录与发布工具的可见范围资料随实际 schema 暴露。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';

let assistants = [
  { name: '普通 AI', agentId: 'agent-ordinary', isHostAI: false },
  { name: '候选 AI', agentId: 'agent-candidate', isBlocked: false },
  { name: '已拉黑 AI', agentId: 'agent-blocked', isBlocked: true, blockReason: '内部资料' },
];
let candidateReads = 0;
const momentTools = load('src/features/moments/aiTools/AICreateMomentTool.ts', {
  '@features/assistants': { listAIAssistants: async () => { candidateReads++; return assistants; }, getAssistantDisplayName: (assistant) => assistant.name },
  '@shared/runtime/abortSignal': {}, '../application/CreateMoment': { MAX_MOMENT_MEDIA_COUNT: 9 }, '../domain/MomentErrors': {},
});
const configuredMoment = await momentTools.createMomentToolForRun();
const candidateDescription = (tool) => tool.definition.parameters.properties.audience.properties.agentIds.description;
for (const { name, agentId } of assistants) {
  assert.ok(candidateDescription(configuredMoment).includes(name));
  assert.ok(candidateDescription(configuredMoment).includes(agentId));
}
assert.doesNotMatch(candidateDescription(configuredMoment), /blockReason|isHostAI|isBlocked|内部资料/u);
assert.equal(candidateReads, 1);
assert.equal(configuredMoment.execute, momentTools.AICreateMomentTool.execute, '冻结参数资料不复制发布业务');
const frozenDescription = candidateDescription(configuredMoment);
assistants = [{ ...assistants[1], name: '改名后的 AI' }];
assert.equal(candidateDescription(configuredMoment), frozenDescription);
assert.notEqual(candidateDescription(await momentTools.createMomentToolForRun()), frozenDescription, '新 run 使用新身份快照');
// 单聊与群聊复用当前 AI 的只读未读摘要，不聚合其他成员的收件箱。
const unreadInbox = { entries: [{ momentId: 'moment-for-ordinary' }], totalUnreadCount: 1 };
const emptyInbox = { entries: [], totalUnreadCount: 0 };
const inboxes = new Map([
  ['agent-ordinary', unreadInbox],
  ['agent-other', { entries: [{ momentId: 'moment-for-other' }], totalUnreadCount: 1 }],
]);
const inboxReads = [];
const { promptPackBlockFactory: realFactory } = load('src/host/prompt/PromptPackBlockFactory.ts', {
  '@shared': { DEFAULT_SELF_NAME: '用户' }, '@features/memory': {}, '@features/assistants': {}, '@shared/prompt': {},
  '@features/moments': {
    loadSocialInboxSummary: async (_repository, agentId) => {
      inboxReads.push(agentId);
      assert.ok(inboxes.has(agentId));
      return inboxes.get(agentId);
    },
    formatSocialInboxSummary: (summary) => summary.entries.map((entry) => entry.momentId).join('\n'),
  },
  './PromptBuiltInContent': {},
});
const inboxParams = [{ id: 'ordinary-ai', agentId: 'agent-ordinary', name: '普通 AI' }, { repositories: { moment: {} } }];
const inboxBlock = await realFactory.createMomentSocialInboxBlock(...inboxParams);
assert.equal(inboxBlock.required, false);
assert.equal(inboxBlock.truncatable, false);
assert.ok(inboxBlock.content.trim());
assert.ok(inboxBlock.content.includes('moment-for-ordinary'));
assert.match(inboxBlock.content, /用户未为你开启工具调用权限/, '工具开关未开启时明确说明权限状态');
assert.doesNotMatch(inboxBlock.content, /getMomentDetail|需要主动处理/, '未授权时保留社交事实，不催促执行或介绍工具');
const enabledInboxBlock = await realFactory.createMomentSocialInboxBlock({ ...inboxParams[0], enableTools: true }, inboxParams[1]);
assert.doesNotMatch(enabledInboxBlock.content, /用户未为你开启工具调用权限/, '已开启工具时不误报权限关闭');
const detailTool = load('src/features/moments/aiTools/GetMomentDetailTool.ts', {
  '../domain/MomentErrors': {}, './MomentReading': {},
});
assert.match(detailTool.definition.description, /Social Inbox/, '主动读取指引随详情工具 schema 暴露');
inboxes.set('agent-ordinary', emptyInbox);
assert.equal((await realFactory.createMomentSocialInboxBlock(...inboxParams)).status, 'omitted');
inboxes.set('agent-ordinary', unreadInbox);
const estimator = { ...load('src/shared/prompt/estimateTextTokens.ts'), ...load('src/shared/prompt/messageTimestamp.ts') };
const budget = load('src/host/prompt/tokenBudget.ts', { '@shared/prompt': estimator });
const metadata = load('src/host/prompt/compiler/promptBlockMetadata.ts');
const { promptPackCompiler } = load('src/host/prompt/compiler/PromptPackCompiler.ts', {
    '@shared/prompt': { CHAT_PROMPT_READING_FLOW, ...estimator }, '../tokenBudget': budget, './promptBlockMetadata': metadata });
const presets = load('src/host/prompt/compiler/systemPromptPresets.ts');
const block = (key, content = key) => ({ key, title: key, content, required: false, status: 'ready', placement: 'system' });
const providerKeys = {
  'context.protocol_space': 'protocol_space', 'context.tool_explanation': 'tool_context_explanation',
  'context.agent_registry': 'agent_registry_summary', 'context.moments_social_inbox': 'moments_social_inbox',
  'context.tools_description': 'tools_description', 'context.passive_memory': 'passive_memory',
  'context.mcp_services': 'mcp_services',
  'context.group_chat': 'group_chat_context', 'context.assistant_nickname': 'assistant_nickname',
  'context.host_cooldown': 'host_cooldown',
};
const { promptPackAssembler: assembler } = load('src/host/prompt/PromptPackAssembler.ts', {
  '@features/companion': { loadAIScheduleContext: async () => '' },
  './PromptPackBlockFactory': { promptPackBlockFactory: {
    resolveUserIdentity: async () => ({ displayName: '用户', source: 'test' }),
    createFoundationBlock: () => block('foundation_default_core'), createPersonaBlock: () => block('persona'),
    createUserIdentityBlock: () => block('user_identity_summary'), createTimeAwarenessBlock: () => block('time_awareness'),
    createScenarioContextBlock: () => null,
    createInteractionEnvironmentBlock: () => block('interaction_environment'),
    createRecentChatWindowBlock: () => ({ ...block('recent_chat_window'), placement: 'history' }),
    createGroupMemberReplyConfidentialityBlock: () => ({ ...block('group_chat_context', '群输出要求'),
      definitionId: 'output.group_member_reply_confidentiality', slot: 'output_contract', protection: 'locked' }),
  } },
  './PromptHistoryBuilder': { promptHistoryBuilder: {
    loadPrivateSummaryContext: async () => ({ messages: [], summaryContent: '本会话摘要' }),
    loadGroupSummaryContext: async () => ({ messages: [], summaryContent: '群摘要' }),
    loadBackgroundContext: async () => '跨会话背景', loadRecentMessages: async () => [],
  } },
  './compiler/PromptPackCompiler': { promptPackCompiler }, './compiler/systemPromptPresets': presets,
  './compiler/promptBlockMetadata': metadata,
  './providers': { renderHostPromptProviderBlock: async (id, { params }) => (
    id === 'context.moments_social_inbox' ? realFactory.createMomentSocialInboxBlock(params.aiConfig, params.toolContext)
      : block(providerKeys[id], id === 'context.tools_description' ? params.toolsDescription
        : id === 'context.mcp_services' ? JSON.stringify(params.mcpServices) : providerKeys[id])
  ) },
});
const params = {
  sessionId: 'session-1', currentInput: '用户输入', toolsDescription: '工具规则', allowedToolNames: ['aiCreateMoment'],
  aiConfig: { id: 'ordinary-ai', agentId: 'agent-ordinary', name: '普通 AI', enableTools: true },
  toolContext: { repositories: { moment: {} } },
};
const groupContext = { groupChat: { groupId: 'group-1', groupName: '群聊', currentAIId: 'ordinary-ai',
  currentAgentId: 'agent-ordinary', currentAIName: '普通 AI', members: [], recentWindowLimit: 10 } };
const packs = [
  await assembler.assembleChatPromptPack(params),
  await assembler.assembleChatPromptPack({ ...params, aiConfig: { ...params.aiConfig, isHostAI: true } }),
  await assembler.assembleChatPromptPack({ ...params, runtimeContext: groupContext }),
  await assembler.assembleChatPromptPack({ ...params, runtimeContext: groupContext,
    preset: { ...presets.getSystemPromptPreset('chat.group_member_reply'), items: presets.getSystemPromptPreset('chat.group_member_reply').items
      .filter((item) => !['context.tools_description', 'context.tool_explanation', 'context.moments_social_inbox'].includes(item.definitionId)) } }),
];
for (const pack of packs) {
  assert.ok(pack.toolInstructionsSlot, '默认及旧群聊预设都必须保留工具目录插槽');
  assert.ok(pack.systemPrompt.includes('工具规则'));
  assert.ok(pack.dynamicSystemPrompt.includes('tool_context_explanation'));
  assert.ok(!pack.systemPrompt.includes('agent-candidate'), '候选身份不重复注入聊天 system');
  assert.ok(!pack.dynamicSystemPrompt.includes('agent-candidate'));
  assert.ok(pack.dynamicSystemPrompt.includes('moment-for-ordinary'), '默认及旧群聊预设均注入当前 AI 的社交盒子');
  assert.ok(!pack.dynamicSystemPrompt.includes('moment-for-other'), '不聚合其他群成员的社交盒子');
  assert.ok(!pack.systemPrompt.includes('moment-for-ordinary'), '未读事件不进入稳定前缀');
}
assert.ok(packs[0].blocks.some((item) => item.key === 'moments_social_inbox'));
assert.ok(packs[0].blocks.some((item) => item.key === 'agent_registry_summary'), '共享身份池仍提供身份背景');
assert.equal(packs[2].blocks.filter((item) => item.key === 'moments_social_inbox').length, 1, '群聊社交盒子只注入一次');
assert.ok(packs[2].dynamicSystemPrompt.indexOf('moment-for-ordinary') < packs[2].dynamicSystemPrompt.indexOf('interaction_environment'),
  '社交盒子沿用提示词中心的顺序，位于本轮环境之前');
const otherGroupPack = await assembler.assembleChatPromptPack({ ...params,
  aiConfig: { ...params.aiConfig, id: 'other-ai', agentId: 'agent-other' },
  runtimeContext: { groupChat: { ...groupContext.groupChat, currentAIId: 'other-ai' } },
});
assert.equal(inboxReads.at(-1), 'agent-other', '按执行 AI 的身份读取，不使用群成员列表或旧 runtime agent 标识');
assert.ok(otherGroupPack.dynamicSystemPrompt.includes('moment-for-other'));
assert.ok(!otherGroupPack.dynamicSystemPrompt.includes('moment-for-ordinary'));
inboxes.set('agent-ordinary', emptyInbox);
const emptyGroupPack = await assembler.assembleChatPromptPack({ ...params, runtimeContext: groupContext });
assert.equal(emptyGroupPack.blocks.find((item) => item.key === 'moments_social_inbox').status, 'omitted');
assert.ok(!emptyGroupPack.dynamicSystemPrompt.includes('Social Inbox'), '无未读时不注入待办提示');
inboxes.set('agent-ordinary', unreadInbox);
const zeroToolsGroupPack = await assembler.assembleChatPromptPack({ ...params, runtimeContext: groupContext,
  toolsDescription: '', allowedToolNames: [], aiConfig: { ...params.aiConfig, enableTools: false },
});
assert.ok(zeroToolsGroupPack.dynamicSystemPrompt.includes('moment-for-ordinary'), '社交事实不依赖工具开关');
for (const runtimeContext of [undefined, groupContext]) {
  const allowedToolNames = ['getMomentDetail'];
  const enabledPack = await assembler.assembleChatPromptPack({ ...params, runtimeContext, allowedToolNames });
  const disabledPack = await assembler.assembleChatPromptPack({ ...params, runtimeContext,
    toolsDescription: '', allowedToolNames: [], aiConfig: { ...params.aiConfig, enableTools: false } });
  assert.ok(enabledPack.dynamicSystemPrompt.includes('moment-for-ordinary'), '开启工具时仍保留社交事实');
  assert.ok(disabledPack.dynamicSystemPrompt.includes('moment-for-ordinary'), '关闭工具时仍保留社交事实');
  assert.match(disabledPack.dynamicSystemPrompt, /用户未为你开启工具调用权限/);
  assert.match(disabledPack.dynamicSystemPrompt, /暂无法处理这些事务/);
  assert.doesNotMatch(enabledPack.dynamicSystemPrompt, /用户未为你开启工具调用权限/);
  assert.doesNotMatch(disabledPack.dynamicSystemPrompt, /getMomentDetail|需要主动处理/);
  assert.equal(disabledPack.toolInstructionsSlot, undefined, '关闭后没有工具目录插槽');
  const enabledContextBlocks = enabledPack.blocks.filter((item) => !['tools_description', 'tool_context_explanation'].includes(item.key));
  assert.deepEqual(disabledPack.blocks.map((item) => [item.definitionId, item.placement, item.systemSegment]),
    enabledContextBlocks.map((item) => [item.definitionId, item.placement, item.systemSegment]),
    '工具开关只控制工具内容，不改变其他区块的顺序和消息边界');
  assert.deepEqual(disabledPack.recentMessages, enabledPack.recentMessages, '历史上下文保持原样');
}
assert.equal((await assembler.assembleChatPromptPack({ ...params, toolsDescription: '', allowedToolNames: [] })).toolInstructionsSlot, undefined);
const services = [{ name: '日历', description: '管理日程' }];
for (const runtimeContext of [undefined, groupContext]) {
  const mcpOnly = await assembler.assembleChatPromptPack({ ...params, runtimeContext, toolsDescription: '',
    allowedToolNames: ['mcp_only'], mcpServices: services });
  assert.ok(mcpOnly.systemPrompt.includes('日历'), '仅有 MCP 的单聊和群聊也提供服务简介');
  assert.equal(mcpOnly.toolInstructionsSlot, undefined, '没有内置工具时不虚构包目录');
  const mixed = await assembler.assembleChatPromptPack({ ...params, runtimeContext, mcpServices: services });
  assert.ok(mixed.toolInstructionsSlot.before.includes('工具规则'));
  assert.ok(!mixed.toolInstructionsSlot.before.includes('日历'));
  assert.ok(mixed.toolInstructionsSlot.after.includes('日历'), 'MCP 简介位于目录插槽之后');
}
const { AgentToolRegistry } = load('src/platform/agentRuntime/AgentToolRegistry.ts');
const { LegacyAgentToolAdapter } = load('src/host/composition/agent/LegacyAgentToolAdapter.ts');
const { registerToolPackagesForHostRun } = load('src/host/composition/agent/ToolPackageExposure.ts');
const requests = [];
const { BaseAIClientAgentModelGateway } = load('src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts', {
  '@platform/ai': { AgentModelGateway: class { async complete(request) {
    requests.push(request); return { assistantText: '完成', reasoningText: '', toolCalls: [], historyItems: [], finishReason: 'stop' };
  } } }, '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline() {} },
});
for (const pack of packs) {
  for (const exposureMode of ['closed', 'open', 'direct']) {
    const registry = new AgentToolRegistry();
    const tool = new LegacyAgentToolAdapter(configuredMoment, { owner: 'moments', risk: 'reversible_write', idempotency: 'none' }, () => ({}));
    registry.register(tool);
    const exposure = registerToolPackagesForHostRun({ registry, bindings: [{ packageId: 'moments', tool }],
      allowedToolNames: ['aiCreateMoment'], openPackageIds: exposureMode === 'open' ? ['moments'] : [],
      directToolNames: exposureMode === 'direct' ? ['aiCreateMoment'] : [] });
    const gateway = new BaseAIClientAgentModelGateway({ client: {}, initialMessages: pack.modelMessages,
      toolInstructionsSlot: pack.toolInstructionsSlot, diagnosticContext: {} });
    const request = (history = []) => ({ transport: 'complete', history,
      tools: registry.listAllowed([...exposure.visibleToolNames(), ...exposure.metaToolNames]), toolInstructions: exposure.instructions() });
    await gateway.runTurn(request());
    const first = requests.at(-1);
    const visible = first.tools.find((item) => item.function.name === 'aiCreateMoment');
    assert.equal(Boolean(visible), exposureMode !== 'closed');
    assert.ok(!first.messages.some((message) => String(message.content).includes('agent-candidate')));
    assert.equal(first.messages.filter((message) => String(message.content).includes('moment-for-ordinary')).length, 1,
      '群聊与单聊的真实请求均只保留一份当前 AI 社交盒子');
    if (visible) assert.equal(visible.function.parameters.properties.audience.properties.agentIds.description, frozenDescription);
    if (exposureMode === 'direct') assert.ok(first.messages[0].content.includes('【用户特批工具】'));
    else assert.ok(first.messages[0].content.includes('【本次运行的工具包用途目录】'));
    if (exposureMode === 'closed') {
      const opened = await registry.get('open_tool_package').execute({ package_id: 'moments' });
      await gateway.runTurn(request([
        { role: 'assistant', content: '我想发一条时刻', toolCalls: [{ id: 'open', name: 'open_tool_package', arguments: '{"package_id":"moments"}' }] },
        { role: 'tool', toolCallId: 'open', name: 'open_tool_package', content: opened.modelContent },
      ]));
      const next = requests.at(-1);
      assert.deepEqual(next.messages.slice(0, first.messages.length), first.messages, '拆包只追加真实历史，群聊同样保留完整消息前缀');
      assert.equal(next.messages.at(-2).content, '我想发一条时刻', '工具前的自然表达正常保留');
      assert.equal(next.tools.find((item) => item.function.name === 'aiCreateMoment').function.parameters
        .properties.audience.properties.agentIds.description, frozenDescription);
    }
  }
}
console.log('工具提示词链路通过：单聊与群聊社交盒子隔离、空未读省略、默认与旧群聊预设、候选 schema 及续轮完整消息前缀。');
