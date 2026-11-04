import { chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';
import { CHAT_PROMPT_READING_FLOW } from './helpers/prompt-reading-flow.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'group-prompt-privacy-'));

const builtInContent = loadTypeScriptModule('src/host/prompt/PromptBuiltInContent.ts', {});
const { PromptPackBlockFactory } = loadTypeScriptModule(
  'src/host/prompt/PromptPackBlockFactory.ts',
  {
    '@shared': { DEFAULT_SELF_NAME: '用户' },
    '@features/memory': {
      recallPassiveMemory: async () => [],
    },
    '@features/assistants': {
      agentRegistryService: { getSummary: async () => ({ entries: [], text: '' }) },
    },
    '@features/moments': {
      loadMomentActorDirectory: async () => ({
        resolve: (ref) => ({ ...ref, displayName: ref.nameSnapshot, avatar: null, exists: true }),
      }),
    },
    './PromptBuiltInContent': builtInContent,
    '@shared/prompt': {},
  },
);

const factory = new PromptPackBlockFactory();
const aiConfig = {};
const groupChat = {
  groupId: 'group-secret-1',
  groupName: '测试群',
  currentAIId: 'ai-secret-2',
  // 故意让 legacy agent key 指向另一成员，验证最终 ownership 只看 assistant ID。
  currentAgentId: 'agent-secret-1',
  currentAIName: '同名成员',
  recentWindowLimit: 10,
  members: [
    { aiAssistantId: 'ai-secret-1', agentId: 'agent-secret-1', name: '同名成员' },
    { aiAssistantId: 'ai-secret-2', agentId: 'agent-secret-2', name: '同名成员' },
    { aiAssistantId: 'ai-secret-3', agentId: 'agent-secret-3', name: '同名成员' },
  ],
};
const contextBlock = factory.createGroupChatContextBlock({ groupChat, userDisplayName: '橙子' });
assert.match(contextBlock.content, /你自己，显示名“同名成员”/);
assert.equal((contextBlock.content.match(/你自己，显示名/g) || []).length, 1, '群上下文只能按 assistant ID 标记一个当前 AI');
assert.equal((contextBlock.content.match(/其他成员，显示名/g) || []).length, 2);
assert.doesNotMatch(contextBlock.content, /SELF|OTHER_AI|USER（|ai_assistant_id|agent_id/);
assert.ok(contextBlock.content.includes(groupChat.groupId), '群身份背景提供真实 group_id，供群聊工具定位');
for (const secret of [
  ...groupChat.members.flatMap((member) => [member.aiAssistantId, member.agentId]),
]) {
  assert.ok(!contextBlock.content.includes(secret), `群上下文不得暴露真实身份：${secret}`);
}

const confidentialityBlock = factory.createGroupMemberReplyConfidentialityBlock(aiConfig, '橙子');
assert.equal(confidentialityBlock.definitionId, 'output.group_member_reply_confidentiality');
assert.equal(confidentialityBlock.protection, 'locked');
assert.equal(confidentialityBlock.required, true);
assert.doesNotMatch(confidentialityBlock.content, /SELF|OTHER_AI|USER（/);
// 用户显示名占位符必须在生成块时替换为当前会话显示名，不得泄漏占位符本身。
assert.ok(confidentialityBlock.content.includes('橙子'), '保密规则正文必须替换为当前用户显示名');
assert.ok(!confidentialityBlock.content.includes('${userDisplayName}'), '用户显示名占位符必须被替换');
assert.doesNotMatch(confidentialityBlock.content, /function schema|工具调用/, '无工具权限时保密规则不介绍调用格式');
assert.equal(confidentialityBlock.content, builtInContent.resolveBuiltInPromptContent({
  content: builtInContent.GROUP_MEMBER_REPLY_CONFIDENTIALITY_RULES, userDisplayName: '橙子',
}), '静态目录和实际群聊保密正文使用同一内容，不在运行时追加隐藏指引');

const chatMetadata = loadTypeScriptModule('src/features/chat/messages/domain/chatMessageMetadata.ts', {
  ...chatSharingDependencies,
  './ChatSticker': loadTypeScriptModule('src/features/chat/messages/domain/ChatSticker.ts', {}),
});
const { PromptHistoryBuilder } = loadTypeScriptModule(
  'src/host/prompt/PromptHistoryBuilder.ts',
  {
    '@shared/prompt': loadTypeScriptModule('src/shared/prompt/messageTimestamp.ts', {}),
    '@features/chat': {
      getChatSummaryContext: async () => ({
        settings: { generationEnabled: false, fixedMessageId: null }, contextSegments: [],
        raw: globalThis.__GROUP_PROMPT_TIMELINE__.map((message) => {
          const metadata = JSON.parse(message.metadataJson || '{}');
          const member = groupChat.members.find((item) => item.agentId === message.agentId || item.aiAssistantId === metadata.actorAIId);
          return { messageId: message.id, kind: message.senderType === 'system' ? 'app_event' : 'dialogue',
            timestamp: message.createdAt, logicalMessageId: message.logicalMessageId ?? null, message,
            actor: { name: metadata.actorName ?? member?.name ?? 'AI' }, groupPlanId: metadata.groupChat?.planId };
        }),
      }),
      getMessageSharedRecord: chatMetadata.getMessageSharedRecord,
      getMessageSharedMoment: chatMetadata.getMessageSharedMoment,
      buildChatSystemEventModelText: chatMetadata.buildChatSystemEventModelText,
      buildReplyQuoteModelText: chatMetadata.buildReplyQuoteModelText,
      buildChatUserMessageModelInput: async (message) => {
        const attachment = JSON.parse(message.metadataJson || '{}').attachments?.[0];
        if (attachment?.type === 'image') {
          return {
            displayText: `[图片] ${attachment.fileName}`,
            modelInput: [
              { type: 'text', text: `用户发送了一张图片：${attachment.fileName}` },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            ],
          };
        }
        return attachment?.type === 'file'
          ? {
              displayText: `[文件] ${attachment.fileName}`,
              modelInput: attachment.parsedText,
            }
          : { displayText: message.text, modelInput: message.text };
      },
      buildSessionPreviewTextFromMessage: (message) => message.text,
      buildGroupMentionModelText: (text) => text,
      getMessageAttachments: (message) => JSON.parse(message.metadataJson || '{}').attachments || [],
      isCallStatusMessageMetadata: (metadata) => metadata?.type === 'callStatus',
      isTogetherListeningMessageMetadata: (metadata) => metadata?.type === 'togetherListening',
      loadOlderTimelineMessages: async ({ cursor, limit }) => {
        const older = globalThis.__GROUP_PROMPT_TIMELINE__.filter((message) => message.id < cursor);
        const messages = older.slice(-limit);
        return {
          success: true,
          messages,
          hasMore: older.length > messages.length,
          nextCursor: older.length > messages.length ? messages[0].id : null,
        };
      },
      openConversationTimeline: async ({ limit }) => {
        const all = globalThis.__GROUP_PROMPT_TIMELINE__;
        const messages = all.slice(-limit);
        return {
          success: true,
          messages,
          hasMore: all.length > messages.length,
          nextCursor: all.length > messages.length ? messages[0].id : null,
        };
      },
      parseMessageMetadata: (message) => JSON.parse(message.metadataJson || '{}'),
      getMessageSticker: (message) => JSON.parse(message.metadataJson || '{}').sticker || null,
      buildStickerModelText: (sticker) => `[表情]${sticker?.name || ''}`,
      buildVoiceMessageModelText: chatMetadata.buildVoiceMessageModelText,
      getMessageVoice: chatMetadata.getMessageVoice,
    },
  },
);
const historyBuilder = new PromptHistoryBuilder();
globalThis.__GROUP_PROMPT_TIMELINE__ = [];
const runtimeContext = { groupChat, userDisplayName: '橙子' };
const userHistory = await historyBuilder.buildRuntimeMessageContent(
  { id: 1, text: '大家好', metadataJson: null },
  true,
  runtimeContext,
  'ai-secret-1',
);
const togetherInvitationHistory = await historyBuilder.buildRuntimeMessageContent(
  {
    id: 2,
    text: '用户邀请你一起听网易云音乐。',
    metadataJson: JSON.stringify({
      type: 'togetherListening',
      activityId: 'activity-1',
      initiator: 'user',
      phase: 'pending_ai_response',
      endReason: null,
      source: 'togetherListening',
    }),
  },
  true,
  {},
  'ai-secret-1',
);
assert.equal(togetherInvitationHistory, '用户邀请你一起听网易云音乐。');
const togetherLifecycleHistory = await historyBuilder.buildRuntimeMessageContent(
  {
    id: 2,
    text: '用户邀请你一起听网易云音乐。',
    metadataJson: JSON.stringify({
      type: 'togetherListening',
      activityId: 'activity-1',
      initiator: 'user',
      phase: 'active',
      endReason: null,
      source: 'togetherListening',
    }),
  },
  true,
  {},
  'ai-secret-1',
);
assert.equal(togetherLifecycleHistory, '');
const selfHistory = await historyBuilder.buildRuntimeMessageContent(
  {
    text: '这是 B 的发言',
    agentId: 'agent-secret-2',
    metadataJson: JSON.stringify({
      actorAIId: 'ai-secret-2',
      actorAgentId: 'agent-secret-2',
      actorName: '同名成员',
    }),
  },
  false,
  runtimeContext,
  'ai-secret-2',
);
const otherHistory = await historyBuilder.buildRuntimeMessageContent(
  {
    text: '这是 A 的发言',
    agentId: 'agent-secret-1',
    metadataJson: JSON.stringify({
      actorAIId: 'ai-secret-1',
      actorAgentId: 'agent-secret-1',
      actorName: '同名成员',
    }),
  },
  false,
  runtimeContext,
  'ai-secret-2',
);
assert.equal(userHistory, '橙子：大家好');
assert.equal(selfHistory, '这是 B 的发言', '当前 AI 历史不需要 SELF wrapper');
assert.equal(otherHistory, '同名成员：这是 A 的发言', '外部 AI 只保留低显著显示名归因');
const renderedHistory = [userHistory, selfHistory, otherHistory].join('\n');
for (const secret of [
  groupChat.groupId,
  ...groupChat.members.flatMap((member) => [member.aiAssistantId, member.agentId]),
]) {
  assert.ok(!renderedHistory.includes(secret), `群历史不得暴露真实身份：${secret}`);
}
assert.doesNotMatch(renderedHistory, /speaker_type|speaker_relation|ai_assistant_id|agent_id|group_id/);
assert.doesNotMatch(renderedHistory, /SELF|OTHER_AI|USER（/);

globalThis.__GROUP_PROMPT_TIMELINE__ = [
  { id: 21, createdAt: '2026-08-13T08:59:00.000Z', text: '用户输入', isMe: true, senderType: 'user', metadataJson: null },
  // 旧消息可能只有 actorAgentId；它只能通过成员投影回 assistant ID。
  { id: 22, createdAt: '2026-08-13T09:00:00.000Z', text: 'A 发言', isMe: false, senderType: 'assistant', agentId: 'agent-secret-1', metadataJson: JSON.stringify({ actorAgentId: 'agent-secret-1', actorName: '同名成员' }) },
  { id: 23, createdAt: '2026-08-13T09:01:00.000Z', text: 'B 发言', isMe: false, senderType: 'assistant', agentId: 'agent-secret-2', metadataJson: JSON.stringify({ actorAIId: 'ai-secret-2', actorAgentId: 'agent-secret-2', actorName: '同名成员' }) },
  { id: 24, createdAt: '2026-08-13T09:02:00.000Z', text: 'C 发言', isMe: false, senderType: 'assistant', agentId: 'agent-secret-3', metadataJson: JSON.stringify({ actorAIId: 'ai-secret-3', actorAgentId: 'agent-secret-3', actorName: '同名成员' }) },
];
const perspectiveHistory = await historyBuilder.loadRecentMessages('chat.group_member_reply', {
  sessionId: groupChat.groupId,
  currentInput: '当前请求',
  aiConfig: { id: 'ai-secret-2' },
  toolContext: {},
  runtimeContext: { ...runtimeContext, recentWindowLimit: 10 },
});
assert.deepEqual(
  perspectiveHistory.map((message) => message.role),
  ['user', 'user', 'assistant', 'user'],
  '当前 active B 的 perspective 必须是 user → A → assistant(B) → user(C)',
);
assert.equal(perspectiveHistory[1].content, '同名成员：A 发言');
assert.equal(perspectiveHistory[2].content, 'B 发言');
assert.equal(perspectiveHistory[3].content, '同名成员：C 发言');

const currentUserInput = await historyBuilder.buildRuntimeMessageContent(
  { id: 25, text: '当前触发输入', metadataJson: null },
  true,
  { ...runtimeContext, groupChat: { ...groupChat, currentTurnUserMessageIds: [25] } },
  'ai-secret-2',
);
assert.match(currentUserInput, /^【当前需要回应的“橙子”发来的消息】/);
assert.notEqual(currentUserInput, '橙子：当前触发输入', '当前输入必须区别于普通历史外部消息');

const historicalFileMetadata = JSON.stringify({
  attachments: [{
    type: 'file',
    fileName: 'history.md',
    parsedText: '这是历史消息中持久化的 Markdown 正文',
  }],
});
const currentFileMetadata = JSON.stringify({
  attachments: [{
    type: 'file',
    fileName: 'current.md',
    parsedText: '这是本轮文件的 Markdown 正文',
  }],
});
const currentImageMetadata = JSON.stringify({
  attachments: [{ type: 'image', fileName: 'current.png' }],
});
globalThis.__GROUP_PROMPT_TIMELINE__ = [
  { id: 9, createdAt: '2026-08-13T08:59:00.000Z', text: '', isMe: true, senderType: 'user', metadataJson: historicalFileMetadata },
  { id: 10, createdAt: '2026-08-13T09:00:00.000Z', text: '', isMe: true, senderType: 'user', metadataJson: currentFileMetadata },
  { id: 11, createdAt: '2026-08-13T09:01:00.000Z', text: '', isMe: true, senderType: 'user', metadataJson: currentImageMetadata },
  { id: 12, createdAt: '2026-08-13T09:02:00.000Z', text: 'AI1 已经回复', isMe: false, senderType: 'assistant', agentId: 'agent-secret-1', metadataJson: JSON.stringify({ actorAgentId: 'agent-secret-1', actorName: '同名成员' }) },
  { id: 13, createdAt: '2026-08-13T09:03:00.000Z', text: '执行中途的新用户消息', isMe: true, senderType: 'user', metadataJson: null },
];
const ai2Timeline = await historyBuilder.loadRecentMessages('chat.group_member_reply', {
  sessionId: groupChat.groupId,
  currentInput: '本轮发言请求',
  aiConfig: { id: 'ai-secret-2' },
  toolContext: {},
  runtimeContext: {
    userDisplayName: '橙子',
    recentWindowLimit: 30,
    groupChat: {
      ...groupChat,
      currentAIId: 'ai-secret-2',
      currentAgentId: 'agent-secret-2',
      currentTurnUserMessageIds: [10, 11],
      inputUpperBoundMessageId: 11,
    },
  },
});
assert.deepEqual(ai2Timeline.map((message) => message.sourceMessageId), [9, 10, 11, 12]);
assert.match(ai2Timeline[0].content, /这是历史消息中持久化的 Markdown 正文/);
assert.match(ai2Timeline[1].content, /当前需要回应的“橙子”发来的消息/);
assert.match(ai2Timeline[1].content, /这是本轮文件的 Markdown 正文/);
assert.ok(Array.isArray(ai2Timeline[2].content), '本轮图片必须保留在原用户消息的位置');
assert.equal(ai2Timeline[2].createdAt, '2026-08-13T09:01:00.000Z');
assert.ok(ai2Timeline[2].content.some((part) => part.type === 'text' && part.text.includes('当前需要回应的“橙子”发来的消息')));
assert.equal(ai2Timeline[2].content.filter((part) => part.type === 'image_url').length, 1);
assert.equal(ai2Timeline[3].role, 'user');
assert.equal(ai2Timeline[3].content, '同名成员：AI1 已经回复');
assert.ok(!ai2Timeline.some((message) => message.sourceMessageId === 13), '快照之后的新用户消息不得进入本轮');

const manyCurrentMessages = Array.from({ length: 35 }, (_, index) => ({
  id: 101 + index,
  createdAt: new Date(Date.UTC(2026, 7, 13, 10, index)).toISOString(),
  text: `连续用户消息 ${index + 1}`,
  isMe: true,
  senderType: 'user',
  metadataJson: null,
}));
globalThis.__GROUP_PROMPT_TIMELINE__ = [
  { id: 100, createdAt: '2026-08-13T09:59:00.000Z', text: '更早的背景', isMe: false, senderType: 'assistant', agentId: 'agent-secret-1', metadataJson: null },
  ...manyCurrentMessages,
];
const manyCurrentTimeline = await historyBuilder.loadRecentMessages('chat.group_member_reply', {
  sessionId: groupChat.groupId,
  currentInput: '本轮发言请求',
  aiConfig: { id: 'ai-secret-2' },
  toolContext: {},
  runtimeContext: {
    userDisplayName: '橙子',
    recentWindowLimit: 30,
    groupChat: {
      ...groupChat,
      currentTurnUserMessageIds: manyCurrentMessages.map((message) => message.id),
      inputUpperBoundMessageId: 135,
    },
  },
});
assert.deepEqual(
  manyCurrentTimeline
    .filter((message) => manyCurrentMessages.some((current) => current.id === message.sourceMessageId))
    .map((message) => message.sourceMessageId),
  manyCurrentMessages.map((message) => message.id),
  '本轮用户消息不得被 30 条背景上下文窗口截断或重新排序',
);
assert.equal(manyCurrentTimeline.at(-1)?.sourceMessageId, 135, '时间线末尾的本轮用户消息不得被删除');
assert.equal(manyCurrentTimeline[0].role, 'user', '群聊中的外部 AI 历史也属于 user perspective');

// PromptPack 生成的 role 必须原样到达最终 Provider，不得被 Chat Agent Gateway
// 的 history 适配重新统一成 assistant。
const providerMessages = [];
const baseAIClientGatewayModule = loadTypeScriptModule(
  'src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts',
  {
    '@platform/ai': {
      AgentModelGateway: class FakeAgentModelGateway {
        constructor(provider) {
          this.provider = provider;
        }

        async complete(request) {
          const response = await this.provider.chatWithTools(request.messages, request.tools, request);
          return {
            assistantText: response.text,
            reasoningText: response.reasoningText || '',
            toolCalls: [],
            finishReason: 'stop',
            usage: null,
          };
        }

        async stream(request) {
          return this.complete(request);
        }
      },
    },
    '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline: () => {} },
  },
);
const { ChatAgentModelGateway } = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentModelGateway.ts',
  { '@platform/agentRuntime': baseAIClientGatewayModule },
);
const gateway = new ChatAgentModelGateway({
  client: {
    chat: async (messages) => {
      providerMessages.push(messages);
      return {
        success: true,
        text: 'provider response',
        reasoningText: '',
        finishReason: 'stop',
        messageId: 'provider-message',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        error: null,
        toolCalls: null,
        isToolCall: false,
      };
    },
    chatWithTools: async () => {
      throw new Error('zero-tools case must call chat');
    },
    chatStream: async () => {
      throw new Error('complete case must call chat');
    },
    chatStreamWithTools: async () => {
      throw new Error('complete case must call chat');
    },
  },
  initialMessages: perspectiveHistory,
  diagnosticContext: { sessionId: 'group-secret-1', runId: 'run-1', correlationId: 'corr-1' },
});
await gateway.runTurn({
  task: {},
  history: [],
  tools: [],
  transport: 'complete',
  signal: new AbortController().signal,
});
assert.equal(providerMessages.length, 1);
assert.deepEqual(
  providerMessages[0].map((message) => message.role),
  ['user', 'user', 'assistant', 'user'],
  '最终 fake provider 必须收到 PromptPack 的 perspective role',
);

// 用真实编译器与模型网关检查最终请求，防止群身份说明与已提供的函数参数相互冲突。
const timestampRenderer = loadTypeScriptModule('src/shared/prompt/messageTimestamp.ts', {});
const budget = loadTypeScriptModule('src/host/prompt/tokenBudget.ts', { '@shared/prompt': { ...timestampRenderer, estimateTextTokens: (text) => text.length } });
const metadata = loadTypeScriptModule('src/host/prompt/compiler/promptBlockMetadata.ts', {});
const { PromptPackCompiler } = loadTypeScriptModule('src/host/prompt/compiler/PromptPackCompiler.ts', {
    '@shared/prompt': { CHAT_PROMPT_READING_FLOW, ...timestampRenderer },
  '../tokenBudget': budget, './promptBlockMetadata': metadata,
});
const { getSystemPromptPreset } = loadTypeScriptModule('src/host/prompt/compiler/systemPromptPresets.ts', {});
const summaryBlock = { key: 'conversation_summary', title: '聊天摘要', content: '群聊的稳定摘要', required: false,
  status: 'ready', placement: 'system' };
const groupPreset = getSystemPromptPreset('chat.group_member_reply');
const buildPrompt = () => new PromptPackCompiler().compile({
  scenario: 'chat.group_member_reply', blocks: [factory.createFoundationBlock({ model: 'test' }, '橙子'), contextBlock,
    confidentialityBlock, summaryBlock,
    { key: 'current_input', title: '当前输入', content: '请查一下天气。', required: true, status: 'ready', placement: 'input' }],
  recentMessages: perspectiveHistory, currentInput: { role: 'user', content: '请查一下天气。' },
  preset: { ...groupPreset, items: [...groupPreset.items, {
    definitionId: 'context.conversation_summary', slot: 'dynamic_context', sortOrder: 160,
    enabled: true, required: false, protection: 'locked',
  }] },
});
const modelRequests = [];
const response = { success: true, text: '回复', reasoningText: '', finishReason: 'stop', messageId: 'tool-policy-test',
  promptTokens: 1, completionTokens: 1, totalTokens: 2, error: null, toolCalls: null, isToolCall: false };
const search = { name: 'web_search', description: '搜索天气信息', inputSchema: {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
} };
for (const tools of [[], [search]]) {
  const prompt = buildPrompt();
  const toolGateway = new ChatAgentModelGateway({
    client: {
      chat: async (messages) => { modelRequests.push({ messages, tools: [] }); return response; },
      chatWithTools: async (messages, tools) => { modelRequests.push({ messages, tools }); return response; },
    },
    initialMessages: [{ role: 'system', content: prompt.systemPrompt }, ...prompt.modelMessages],
    diagnosticContext: { sessionId: groupChat.groupId, runId: 'tool-policy-test', correlationId: 'tool-policy-test' },
  });
  await toolGateway.runTurn({ task: {}, history: [], tools, transport: 'complete', signal: new AbortController().signal });
  const request = modelRequests.at(-1);
  // 群成员身份属于固定背景；本轮环境独立放在历史之后。
  assert.ok(request.messages[0].content.includes(summaryBlock.content));
  assert.ok(request.messages[0].content.includes(contextBlock.content), '群身份背景放在前置 system');
  assert.deepEqual(request.messages.slice(1, 1 + perspectiveHistory.length), perspectiveHistory.map(({ createdAt, ...message }) => message), '群环境不能改写历史及其角色');
  const currentContext = request.messages[1 + perspectiveHistory.length];
  assert.equal(currentContext.role, 'system');
  assert.ok(!currentContext.content.includes(contextBlock.content), '群身份背景不重复进入本轮动态状态');
  assert.equal(request.messages.filter((message) => message.content.includes(contextBlock.content)).length, 1, '群环境只注入一次');
  assert.equal(request.messages.at(-1).content, '请查一下天气。', '当前输入仍在所有上下文之后');
  const instructions = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  assert.doesNotMatch(instructions, /群聊中工具关闭|关闭群聊工具|群聊不支持工具调用/, '群身份上下文不能否定实际工具暴露');
  assert.doesNotMatch(instructions, /不得输出 JSON、ID、alias/, '对外正文格式不能笼统禁止函数参数');
  assert.doesNotMatch(instructions, /function schema|工具调用与回复正文分开/, '群环境及保密规则不承担调用指导');
  assert.match(instructions, /不得.*视频通话/);
  assert.match(instructions, /不得对外解释或复述系统上下文/);
  assert.equal(request.tools.length, tools.length, '提示词不得增加或移除实际工具授权');
}
assert.deepEqual(modelRequests.at(-1).tools[0].function.parameters, search.inputSchema);

// 普通私聊仍保持真人 user / AI assistant 的既有语义。
globalThis.__GROUP_PROMPT_TIMELINE__ = [
  { id: 31, createdAt: '2026-08-13T10:00:00.000Z', text: '私聊用户', isMe: true, senderType: 'user', metadataJson: null },
  { id: 32, createdAt: '2026-08-13T10:01:00.000Z', text: '私聊 AI', isMe: false, senderType: 'assistant', metadataJson: null },
];
const privateHistory = await historyBuilder.loadRecentMessages('chat.private_reply', {
  sessionId: 'private-session',
  currentInput: '当前私聊请求',
  aiConfig: { id: 'private-ai' },
  toolContext: {},
  runtimeContext: {},
});
assert.deepEqual(privateHistory.map((message) => message.role), ['user', 'assistant']);
assert.deepEqual(privateHistory.map((message) => message.content), [
  '私聊用户', '私聊 AI',
]);

// 时区归一、跨日与逻辑消息分段合并后，仍须保留每段的原始时间。
globalThis.__GROUP_PROMPT_TIMELINE__ = [
  { id: 41, createdAt: '2026-08-14T07:59:59.987+08:00', text: '之前的用户消息', isMe: true, senderType: 'user', metadataJson: null },
  { id: 42, createdAt: '2026-08-14T08:00:01.123+08:00', text: '第一段', isMe: false, senderType: 'assistant', logicalMessageId: 'reply', metadataJson: null },
  { id: 43, createdAt: '2026-08-14T08:00:02.456+08:00', text: '第二段', isMe: false, senderType: 'assistant', logicalMessageId: 'reply', metadataJson: null },
];
const segmentedHistory = await historyBuilder.loadRecentMessages('chat.private_reply', {
  sessionId: 'private-session', aiConfig: { id: 'private-ai' }, toolContext: {}, runtimeContext: {},
});
assert.deepEqual(segmentedHistory.map(({ role, content, createdAt }) => ({ role, content, createdAt })), [
  { role: 'user', content: '之前的用户消息', createdAt: '2026-08-14T07:59:59.987+08:00' },
  { role: 'assistant', content: '第一段', createdAt: '2026-08-14T08:00:01.123+08:00' },
  { role: 'assistant', content: '第二段', createdAt: '2026-08-14T08:00:02.456+08:00' },
]);
const timedSegments = segmentedHistory.flatMap((message) => timestampRenderer.renderPromptMessageWithTimestamp(message, true));
assert.match(timedSegments[0].content, /2026-08-13T23:59:59Z/);
assert.match(timedSegments[2].content, /2026-08-14T00:00:01Z/);
assert.match(timedSegments[4].content, /2026-08-14T00:00:02Z/);
assert.ok(timedSegments.filter((message) => message.role === 'assistant').every((message) => !message.content.includes('Z]')));
assert.deepEqual(globalThis.__GROUP_PROMPT_TIMELINE__.map(({ text }) => text), ['之前的用户消息', '第一段', '第二段']);

// 同一逻辑回复中的语音与文字不能混合，否则语音提示会错误覆盖文字分段。
const historicalVoice = (actorAIId) => JSON.stringify({ kind: 'voice', actorAIId, voice: {
  schemaVersion: 1, mediaAssetId: 'group-voice', mimeType: 'audio/wav', durationMs: 900, transcriptSource: 'assistant_source_text',
} });
globalThis.__GROUP_PROMPT_TIMELINE__ = [
  { id: 51, createdAt: '2026-08-14T08:00:01.000Z', text: '我用语音说过的话', isMe: false, senderType: 'assistant',
    logicalMessageId: 'mixed-reply', metadataJson: historicalVoice('ai-secret-2') },
  { id: 52, createdAt: '2026-08-14T08:00:01.000Z', text: '接下来是普通文字', isMe: false, senderType: 'assistant',
    logicalMessageId: 'mixed-reply', metadataJson: JSON.stringify({ actorAIId: 'ai-secret-2' }) },
  { id: 53, createdAt: '2026-08-14T08:00:02.000Z', text: '其他成员的语音', isMe: false, senderType: 'assistant',
    metadataJson: historicalVoice('ai-secret-1') },
];
const groupVoiceHistory = await historyBuilder.loadGroupSummaryContext({ sessionId: 'group-session', aiConfig: { id: 'ai-secret-2' },
  runtimeContext });
assert.deepEqual(groupVoiceHistory.messages.map((message) => message.role), ['assistant', 'assistant', 'user']);
assert.deepEqual(groupVoiceHistory.messages.map((message) => message.content), ['我用语音说过的话', '接下来是普通文字', '同名成员：其他成员的语音']);
assert.equal(groupVoiceHistory.messages[1].systemNotice, undefined);
const voiceRequests = groupVoiceHistory.messages.flatMap((message) => timestampRenderer.renderPromptMessageWithTimestamp(message, false));
assert.equal(voiceRequests.filter((message) => message.role === 'system' && message.content.includes('send_voice_message')).length, 2);
assert.equal(voiceRequests.filter((message) => message.role === 'assistant').some((message) => message.content.includes('send_voice_message')), false);

// 单聊与通话的摘要／完整原文契约由 verify-memory-v3-prompt 验证，退休旧 over-fetch 窗口断言。

console.log('群聊 Prompt 隐私与 perspective role 契约通过（同名身份区分、成员身份隔离、群工具 ID 提供、低显著归因、Provider role 透传）。');
fs.rmSync(tempRoot, { recursive: true, force: true });
