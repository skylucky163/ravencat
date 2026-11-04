import { sharedMomentIntent } from './helpers/chat-sharing-fixture.mjs';
import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
import assert from 'node:assert/strict';
import { loadTypeScriptModule, readRepoFile as read } from './helpers/load-typescript-module.mjs';

const runStateModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRunState.ts');
const guardsModule = loadTypeScriptModule(
  'src/platform/agentRuntime/AgentRuntimeGuards.ts',
  { './AgentRunState': runStateModule },
);
const agentToolSchemaModule = loadTypeScriptModule('src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);
const toolExecutorModule = loadTypeScriptModule('src/platform/agentRuntime/AgentToolExecutor.ts', {
  '@shared/aiTools': agentToolSchemaModule,
  './AgentRunState': runStateModule,
});
const runLoopModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRunLoop.ts', {
  './AgentRuntimeGuards': guardsModule,
  './AgentRunState': runStateModule,
  './AgentToolExecutor': toolExecutorModule,
});
const runtimeControlModule = loadTypeScriptModule(
  'src/platform/agentRuntime/AgentRuntimeControl.ts',
  { './AgentRunState': runStateModule },
);
const runtimeModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRuntime.ts', {
  './AgentRuntimeGuards': guardsModule,
  './AgentRunState': runStateModule,
  './AgentRuntimeControl': runtimeControlModule,
  './AgentRunLoop': runLoopModule,
  './AgentToolExecutor': toolExecutorModule,
});
const eventQueueModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRunEventQueue.ts');
const registryModule = loadTypeScriptModule('src/platform/agentRuntime/AgentToolRegistry.ts');
const collectorModule = loadTypeScriptModule('src/platform/ai/agent/ModelTurnCollector.ts');
const completeAdapterModule = loadTypeScriptModule(
  'src/platform/ai/agent/CompleteModelTurnAdapter.ts',
  { './ModelTurnCollector': collectorModule },
);
const streamingAdapterModule = loadTypeScriptModule(
  'src/platform/ai/agent/StreamingModelTurnAdapter.ts',
  {
    './ModelTurnCollector': collectorModule,
    './CompleteModelTurnAdapter': completeAdapterModule,
  },
);
const modelGatewayModule = loadTypeScriptModule(
  'src/platform/ai/agent/AgentModelGateway.ts',
  {
    './CompleteModelTurnAdapter': completeAdapterModule,
    './StreamingModelTurnAdapter': streamingAdapterModule,
  },
);
const genericTimelineEvents = [];
const baseAIClientGatewayModule = loadTypeScriptModule(
  'src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts',
  {
    '@platform/ai': modelGatewayModule,
    '@shared/diagnostics/TurnTimelineLog': {
      logTurnTimeline: (event, context) => genericTimelineEvents.push({ event, context }),
    },
  },
);
const chatGatewayModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentModelGateway.ts',
  {
    '@platform/agentRuntime': baseAIClientGatewayModule,
  },
);
const genericGatewaySource = read(
  'src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts',
);
assert.doesNotMatch(
  genericGatewaySource,
  /@features\/(?:chat|companion)/u,
  '通用 BaseAIClient Gateway 不得依赖 Chat 或 Companion Feature',
);
assert.doesNotMatch(
  genericGatewaySource,
  /回答用户|向用户输出/u,
  '通用 BaseAIClient Gateway 不得规定 Agent run 的最终输出对象是用户',
);
assert.equal(
  chatGatewayModule.buildChatAgentMessages,
  baseAIClientGatewayModule.buildAgentModelMessages,
  'Chat 兼容 builder 必须直接委托唯一的通用 message-history builder',
);
const chatTaskModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentTask.ts',
);
const assistantReplySegmentationModule = loadTypeScriptModule(
  'src/features/chat/reply/application/AssistantReplySegmentation.ts',
);

let projectionLog;
let chatRunActive;
let failNextPersistence;
function resetProjectionLog() {
  projectionLog = {
    persistedReplies: [],
    statusMessages: [],
    statusUpdates: [],
    previews: [],
  };
  chatRunActive = true;
  failNextPersistence = false;
}

const replyPersistenceMock = {
  persistCompletedAssistantReply: async (params) => {
    if (failNextPersistence) {
      failNextPersistence = false;
      throw new Error('投影持久化失败');
    }
    const visibleSegments = assistantReplySegmentationModule.segmentAssistantReplyText(
      params.response.text,
      params.policy.bubbleDeliveryMode,
    );
    projectionLog.persistedReplies.push({ ...params, visibleSegments });
  },
};
const metadataMock = loadTypeScriptModule('src/features/chat/reply/application/ChatReplyMetadata.ts', {
  './ReplyPolicy': loadTypeScriptModule('src/features/chat/reply/application/ReplyPolicy.ts'),
});
const presentationModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ToolReplyPresentation.ts',
  {
    '../application/ChatReplyMetadata': metadataMock,
    '../../messages/events/ChatEvents': { emitChatMessagesPatched: () => {} },
  },
);
assert.equal(
  presentationModule.resolveToolDisplayName('schedule_self_wake'),
  '安排自主醒来',
);
const timelineAssistantReplyPersistenceMock = {
  normalizeAssistantResponseText: (text, policy) => {
    const normalizedText = String(text || '').trim();
    return {
      text: normalizedText,
      segments: assistantReplySegmentationModule.segmentAssistantReplyText(
        normalizedText,
        policy.bubbleDeliveryMode,
      ),
    };
  },
};
const timelineAssistantTurnCommitModule = loadTypeScriptModule(
  'src/features/chat/reply/application/AssistantTurnCommit.ts',
  {
    './AssistantReplyPersistence': {
      persistCompletedAssistantReply: async () => {},
    },
    './ChatReplyMetadata': metadataMock,
    './ChatReplyUtils': {
      buildLogicalMessageId: () => 'timeline-logical',
      formatMessageTime: () => '12:00',
    },
  },
);
const agentTimelineIdentityModule = loadTypeScriptModule(
  'src/features/chat/messages/domain/AgentTimelineIdentity.ts',
);
const autonomousReplyContract = loadTypeScriptModule('src/features/chat/reply/application/AutonomousReplyContract.ts');
const imageToolModule = loadTypeScriptModule('src/features/chat/reply/agent/SendImageTool.ts', {
  '@features/media': {
    resolveMediaAsset: async (id) => ({ asset: { id, mimeType: 'image/png', byteSize: 100, width: 640, height: 480 } }),
    mediaImageFailure: () => null,
  },
  '@shared/aiTools': loadTypeScriptModule('src/shared/aiTools/ToolCompletionIntent.ts'),
  '@shared/runtime/abortSignal': loadTypeScriptModule('src/shared/runtime/abortSignal.ts'),
});
const timelineModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentTimeline.ts',
  {
    '../application/AutonomousReplyContract': autonomousReplyContract,
    '@features/stickers': {
      isStickerSendIntent: (value) => value?.discriminator === 'ravencat.sticker.send.v1',
    },
    './SendVoiceMessageTool': {
      isVoiceMessageSendIntent: (value) => value?.discriminator === 'ravencat.chat.voice_message.send.v1',
    },
    './SharedMomentSendIntent': sharedMomentIntent,
    './SendImageTool': imageToolModule,
    '../../messages/domain/chatMessageMetadata': {
      buildChatVoiceMessageMetadata: (voice) => ({ kind: 'voice', voice }),
    },
    '../application/ChatReplyMetadata': metadataMock,
    '../application/AssistantReplyPersistence': timelineAssistantReplyPersistenceMock,
    '../application/AssistantReplySegmentation': assistantReplySegmentationModule,
    '../application/AssistantTurnCommit': timelineAssistantTurnCommitModule,
    '../application/ChatReplyUtils': { formatMessageTime: () => '12:00' },
    '../../messages/domain/AgentTimelineIdentity': agentTimelineIdentityModule,
    './ToolReplyPresentation': presentationModule,
  },
);
let nextMessageId = 1;
const messagePersistenceMock = {
  persistChatMessage: async ({ message }) => {
    const saved = { ...message, id: nextMessageId };
    nextMessageId += 1;
    projectionLog.statusMessages.push(saved);
    return saved;
  },
  syncChatSessionPreview: async (params) => {
    projectionLog.previews.push(params.previewText);
  },
};
const replyAbortMock = {
  assertChatReplyNotAborted: (runtimeContext) => {
    if (!chatRunActive || runtimeContext?.abortSignal?.aborted) {
      const error = new Error('Chat reply run cancelled: superseded');
      error.name = 'ChatReplyRunCancelledError';
      throw error;
    }
  },
};
// 旁路（Legacy）提交策略：逐泡独立事务，行为与现状一致。
const legacyPersistenceMock = {
  persistsIntermediates: true,
  persistCompletedAssistantReply: (params) =>
    replyPersistenceMock.persistCompletedAssistantReply(params),
  persistAssistantPrelude: (params) =>
    replyPersistenceMock.persistCompletedAssistantReply(params),
};
const toolTimelineModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentToolTimelineProjector.ts',
  {
    '../application/ChatReplyMetadata': metadataMock,
    '../application/ChatReplyAbort': replyAbortMock,
    '../application/ChatReplyUtils': { formatMessageTime: () => '12:00' },
    '../../messages/application/MessagePersistence': messagePersistenceMock,
    './ToolReplyPresentation': presentationModule,
  },
);
const projectorModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentRunProjector.ts',
  {
    '../application/AssistantReplyPersistence': replyPersistenceMock,
    '../application/ChatReplyAbort': replyAbortMock,
    './ChatAgentToolTimelineProjector': toolTimelineModule,
    './ChatStreamingReplyProjector': {
      ChatStreamingReplyProjector: class {
        startTurn() {}
        handleDelta() {}
        completeModelTurn() {}
        finalizeFinalTurn() {}
        markFailed() {}
      },
    },
    './ChatAgentTimeline': timelineModule,
    './ToolReplyPresentation': presentationModule,
  },
);

const { AgentRuntime } = runtimeModule;
const { AgentToolRegistry } = registryModule;
const { createChatAgentTask, CHAT_AGENT_TASK_BUDGET_PRESET } = chatTaskModule;
let activeTools = [];
let capturedRunResult = null;
let activeRuntime = null;
let capturedLegacyContext = null;
let capturedLegacyExecutionContext = null;
const runtimeToolContextCalls = [];

const chatRuntimeDependencies = {
  tools: {},
  agent: {
    run: async ({ modelGateway, createLegacyContext, ...request }) => {
      assert.equal(typeof createLegacyContext, 'function');
      capturedLegacyExecutionContext = {
        runId: request.runId,
        task: request.task,
        toolCallId: 'legacy-context-probe',
        abortSignal: new AbortController().signal,
      };
      capturedLegacyContext = createLegacyContext(capturedLegacyExecutionContext);
      const registry = new AgentToolRegistry();
      for (const tool of activeTools) {
        registry.register(tool);
      }
      activeRuntime = new AgentRuntime({ modelGateway, registry });
      capturedRunResult = await activeRuntime.run(request);
      return capturedRunResult;
    },
    cancel: async (request) => {
      assert.ok(activeRuntime, 'Chat Agent cancel 必须命中原 Runtime');
      capturedRunResult = await activeRuntime.cancel(request);
      return capturedRunResult;
    },
  },
};
const chatRuntimeDependenciesMock = {
  getChatReplyRuntimeDependencies: () => chatRuntimeDependencies,
};
const chatAgentReplyFlowModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentReplyFlow.ts',
  {
    '@platform/agentRuntime': eventQueueModule,
    '../application/ChatReplyRuntimeDependencies': chatRuntimeDependenciesMock,
    '../application/ChatReplyRuntime': {
      createRuntimeToolContext: (...args) => {
        runtimeToolContextCalls.push(args);
        return {
          sharedState: args[4],
          abortSignal: args[5],
        };
      },
    },
    '../application/ChatReplyAbort': replyAbortMock,
    '../application/ChatReplyUtils': { buildLogicalMessageId: () => 'run-generated' },
    '../../messages/application/AgentTransientTimeline': {
      createAgentTransientTimelineSink: () => ({}),
    },
    './ChatAgentRunProjector': projectorModule,
    './ChatAgentTask': chatTaskModule,
    './ChatAgentModelGateway': chatGatewayModule,
    './ToolReplyPresentation': presentationModule,
  },
);
const { runChatAgentReplyFlow, canFallbackToComplete } = chatAgentReplyFlowModule;

assert.deepEqual(CHAT_AGENT_TASK_BUDGET_PRESET, {
  maxSteps: 30,
  maxToolCalls: 30,
  maxToolCallsPerStep: 3,
});
const productionTask = createChatAgentTask({
  runId: 'preset-run',
  goal: '验证 Chat task',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  allowedToolNames: ['lookup'],
  modelTransport: 'complete',
  createdAt: new Date(0).toISOString(),
});
assert.equal(productionTask.modelTransport, 'complete');

function response(overrides = {}) {
  return {
    text: '',
    reasoningText: '',
    finishReason: 'stop',
    messageId: 'message-1',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    success: true,
    error: null,
    toolCalls: null,
    isToolCall: false,
    ...overrides,
  };
}

function toolCall(id, name, input) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(input) },
  };
}

function createProvider(responses) {
  const requests = [];
  const takeResponse = async (messages, tools, options, method) => {
    const requestIndex = requests.length;
    requests.push({ messages, tools, options, method });
    const nextResponse = responses[requestIndex];
    assert.ok(nextResponse, `缺少第 ${requestIndex + 1} 个 Provider 响应`);
    return typeof nextResponse === 'function'
      ? nextResponse({ messages, tools, options, requestIndex })
      : nextResponse;
  };
  return {
    requests,
    chat: (messages, options) => takeResponse(messages, [], options, 'chat'),
    chatWithTools: (messages, tools, options) => takeResponse(messages, tools, options, 'chatWithTools'),
    chatStream: async (messages, options) => {
      const response = await takeResponse(messages, [], options, 'chatStream');
      if (response.text) {
        await options?.onDelta?.({ type: 'answer_delta', text: response.text });
      }
      return response;
    },
    chatStreamWithTools: async (messages, tools, options) => {
      const response = await takeResponse(messages, tools, options, 'chatStreamWithTools');
      if (response.text) {
        await options?.onDelta?.({ type: 'answer_delta', text: response.text });
      }
      return response;
    },
  };
}

function genericToolDescriptor() {
  return {
    name: 'lookup',
    description: '查询测试工具',
    inputSchema: { type: 'object', properties: {} },
  };
}

function genericTurnRequest({
  transport,
  tools,
  history = [],
  forceFinalResponse = false,
  completionContinuationInstruction,
}) {
  return {
    task: {},
    history,
    tools,
    toolBudget: {
      remainingToolCalls: 7,
      maxToolCallsPerStep: 3,
      forceFinalResponse,
    },
    transport,
    completionContinuationInstruction,
    signal: new AbortController().signal,
  };
}

const genericProviderCases = [
  { transport: 'complete', tools: [], method: 'chat' },
  { transport: 'complete', tools: [genericToolDescriptor()], method: 'chatWithTools' },
  { transport: 'stream', tools: [], method: 'chatStream' },
  { transport: 'stream', tools: [genericToolDescriptor()], method: 'chatStreamWithTools' },
];
for (const [index, testCase] of genericProviderCases.entries()) {
  genericTimelineEvents.length = 0;
  const provider = createProvider([response({
    text: `通用 Gateway 路径 ${index + 1}`,
    messageId: `generic-message-${index + 1}`,
  })]);
  const gateway = new baseAIClientGatewayModule.BaseAIClientAgentModelGateway({
    client: provider,
    initialMessages: [{ role: 'user', content: '通用请求' }],
    diagnosticContext: { runId: 'autonomous-run-id' },
  });
  await gateway.runTurn(genericTurnRequest(testCase));
  assert.equal(provider.requests.length, 1);
  assert.equal(
    provider.requests[0].method,
    testCase.method,
    `${testCase.transport} + ${testCase.tools.length} tools 必须调用 ${testCase.method}`,
  );
  assert.equal(
    gateway.takeCompletedTurn(1).messageId,
    `generic-message-${index + 1}`,
    '通用 Gateway 必须捕获 Provider messageId',
  );
  assert.equal(gateway.hasObservedModelOutput(), true);
  assert.ok(genericTimelineEvents.length > 0);
  for (const { context } of genericTimelineEvents) {
    assert.deepEqual(
      context,
      { runId: 'autonomous-run-id' },
      '只有 runId、没有 sessionId 的 diagnostic context 必须原样工作',
    );
  }
}

const historyProvider = createProvider([response({ text: 'history ok' })]);
const historyGateway = new baseAIClientGatewayModule.BaseAIClientAgentModelGateway({
  client: historyProvider,
  initialMessages: [{ role: 'user', content: '初始消息' }],
  diagnosticContext: { runId: 'history-run' },
});
await historyGateway.runTurn(genericTurnRequest({
  transport: 'complete',
  tools: [genericToolDescriptor()],
  history: [
    {
      role: 'assistant',
      content: '先查询',
      reasoningText: '',
      toolCalls: [{ index: 0, id: 'call-history', name: 'lookup', arguments: '{"q":"one"}' }],
    },
    {
      role: 'tool',
      toolCallId: 'call-history',
      name: 'lookup',
      content: '查询结果',
    },
  ],
}));
assert.deepEqual(historyProvider.requests[0].messages, [
  { role: 'user', content: '初始消息' },
  {
    role: 'assistant',
    content: '先查询',
    reasoning_content: '',
    tool_calls: [{
      id: 'call-history',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"one"}' },
    }],
  },
  {
    role: 'tool',
    tool_call_id: 'call-history',
    name: 'lookup',
    content: '查询结果',
  },
], 'Runtime assistant/tool history 保持原映射，正常续轮不追加额度提示');

const continuationProvider = createProvider([response({ text: 'continuation ok' })]);
const continuationGateway = new baseAIClientGatewayModule.BaseAIClientAgentModelGateway({
  client: continuationProvider,
  initialMessages: [{ role: 'user', content: '既有历史' }],
  diagnosticContext: { runId: 'continuation-run' },
});
await continuationGateway.runTurn(genericTurnRequest({
  transport: 'complete',
  tools: [genericToolDescriptor()],
  completionContinuationInstruction: '只执行完成前的受限决策。',
}));
assert.deepEqual(continuationProvider.requests[0].messages.slice(0, 3), [
  { role: 'user', content: '既有历史' },
  { role: 'system', content: '只执行完成前的受限决策。' },
], 'completion continuation 指令必须以机器 system context 进入同一个模型历史');

const finalProvider = createProvider([response({ text: 'final ok' })]);
const finalGateway = new baseAIClientGatewayModule.BaseAIClientAgentModelGateway({
  client: finalProvider,
  initialMessages: [{ role: 'user', content: '最终回答' }],
  diagnosticContext: { runId: 'final-run' },
});
await finalGateway.runTurn(genericTurnRequest({
  transport: 'complete',
  tools: [],
  forceFinalResponse: true,
}));
assert.equal(finalProvider.requests[0].method, 'chat');
assert.equal(
  finalProvider.requests[0].messages[1].content,
  '工具调用阶段已经结束。本轮不得请求任何工具；请仅根据已有上下文和工具结果，给出本次 Agent run 的完整最终输出。',
  'forceFinalResponse 必须关闭工具并使用 Agent run 中性最终输出语义',
);

const failedProvider = createProvider([response({ success: false, error: '通用请求失败' })]);
const failedGateway = new baseAIClientGatewayModule.BaseAIClientAgentModelGateway({
  client: failedProvider,
  initialMessages: [{ role: 'user', content: '失败请求' }],
  diagnosticContext: { runId: 'failed-run' },
});
await assert.rejects(
  () => failedGateway.runTurn(genericTurnRequest({ transport: 'complete', tools: [] })),
  /通用请求失败/u,
);
assert.equal(failedGateway.requireModelRequestError().message, '通用请求失败');
assert.equal(failedGateway.hasObservedModelOutput(), false);

const outputThenFailedProvider = createProvider([
  response({ text: '已经输出', success: false, error: '输出后失败' }),
]);
const outputThenFailedGateway = new baseAIClientGatewayModule.BaseAIClientAgentModelGateway({
  client: outputThenFailedProvider,
  initialMessages: [{ role: 'user', content: '流式失败请求' }],
  diagnosticContext: { runId: 'output-failed-run' },
});
await assert.rejects(
  () => outputThenFailedGateway.runTurn(genericTurnRequest({ transport: 'stream', tools: [] })),
  /输出后失败/u,
);
assert.equal(outputThenFailedGateway.hasObservedModelOutput(), true);
assert.equal(outputThenFailedGateway.requireModelRequestError().message, '输出后失败');

function createTool(name, execute, descriptorOverrides = {}) {
  return {
    descriptor: {
      name,
      description: `${name} 测试工具`,
      inputSchema: { type: 'object' },
      owner: 'chat-test',
      source: 'local',
      risk: 'safe_read',
      idempotency: 'idempotent',
      ...descriptorOverrides,
    },
    execute,
  };
}

function createRepository() {
  return {
    updateMessage: async (messageId, patch) => {
      projectionLog.statusUpdates.push({ messageId, patch });
    },
  };
}

async function runChatCase({
  responses,
  tools = [],
  modelTransport = 'complete',
  enableTools = true,
  controller = new AbortController(),
  failProjection = false,
  callbacks = {},
  persistence = legacyPersistenceMock,
  runtimeContext = { replyRunId: 'run-1' },
}) {
  resetProjectionLog();
  failNextPersistence = failProjection;
  nextMessageId = 1;
  activeTools = tools;
  capturedRunResult = null;
  activeRuntime = null;
  capturedLegacyContext = null;
  capturedLegacyExecutionContext = null;
  runtimeToolContextCalls.length = 0;
  const provider = createProvider(responses);
  await runChatAgentReplyFlow({
    sessionId: 'session-1',
    originalUserText: '请处理',
    requestMessages: [{ role: 'user', content: '请处理' }],
    aiConfig: {
      id: 'assistant-1',
      agentId: 'agent-1',
      name: 'Kimi',
      enableTools: true,
    },
    repository: createRepository(),
    callbacks,
    runtimeContext: {
      ...runtimeContext,
      memoryParticipation: 'off',
      abortSignal: controller.signal,
      allowedToolNames: tools.map((tool) => tool.descriptor.name),
    },
    policy: {
      bubbleDeliveryMode: 'multi-bubble',
      modelTransport,
      enableTools,
    },
    client: provider,
    persistence,
  });
  if (!capturedRunResult) {
    throw new Error('生产 ChatAgentReplyFlow 未返回 AgentRunResult');
  }
  return { result: capturedRunResult, provider, projectionLog };
}

const plain = await runChatCase({
  responses: [response({
    text: '普通回复',
  })],
});
assert.equal(plain.result.terminalCode, 'COMPLETED', '普通文本必须通过 Runtime 完成');
assert.equal(
  capturedLegacyContext.abortSignal,
  capturedLegacyExecutionContext.abortSignal,
  'Chat createLegacyContext 必须消费当前 AgentToolExecutionContext.abortSignal',
);
assert.equal(
  capturedLegacyContext.sharedState,
  runtimeToolContextCalls[0][4],
  '每次派生 Legacy ToolContext 必须保留同一个 run sharedState',
);
assert.equal(plain.projectionLog.persistedReplies.length, 1, '普通文本只能提交一次');
assert.equal(plain.projectionLog.persistedReplies[0].policy.bubbleDeliveryMode, 'multi-bubble');
assert.equal(plain.projectionLog.persistedReplies[0].response.messageId, 'message-1');
assert.equal(
  plain.provider.requests[0].options.allowReasoningLengthRetry,
  false,
  'Chat complete 必须保留 Runtime 禁止隐藏重发的契约',
);

const noToolsComplete = await runChatCase({
  responses: [response({ text: '无工具 complete' })],
  enableTools: false,
});
assert.equal(noToolsComplete.result.terminalCode, 'COMPLETED');
assert.equal(noToolsComplete.provider.requests[0].method, 'chat', '无工具 complete 必须穿过 Agent Runtime 的无工具入口');

const noToolsStream = await runChatCase({
  responses: [response({ text: '无工具 stream' })],
  modelTransport: 'stream',
  enableTools: false,
});
assert.equal(noToolsStream.result.terminalCode, 'COMPLETED');
assert.equal(noToolsStream.provider.requests[0].method, 'chatStream', '无工具 stream 必须穿过 Agent Runtime 的无工具入口');

await assert.rejects(
  () => runChatCase({
    responses: [response({ text: '' })],
    enableTools: false,
  }),
  /Chat Agent run failed/,
  '完全空正文不得作为成功回复',
);
assert.equal(capturedRunResult.terminalCode, 'MODEL_PROTOCOL_ERROR');

for (const modelTransport of ['complete', 'stream']) {
  for (const finishReason of ['stop', 'length']) {
    for (const text of ['', '尚未写完的正文']) {
      const commits = [];
      const terminalEvents = [];
      const partial = await runChatCase({
        modelTransport,
        responses: [response({ text, reasoningText: '已经返回的思考', finishReason })],
        enableTools: false,
        persistence: { persistsIntermediates: false,
          observeRunEvent(event) {
            if (event.type === 'run_completed') terminalEvents.push(event);
          },
          commitAgentTimeline: async (params) => {
          commits.push(params);
          return { outcome: 'committed', messages: params.items.map(({ message }, index) => ({ ...message, id: index + 1 })) };
        } },
      });
      assert.equal(partial.result.terminalCode, 'COMPLETED');
      assert.equal(terminalEvents.length, 1, '提交层必须收到真实 Runtime 的唯一结束事实');
      assert.equal(terminalEvents[0].result.steps.at(-1).modelTurn.finishReason, finishReason,
        '模型结束原因必须经 complete/stream 适配器和 Runtime 传至提交层，供群队列区分完整与部分回复');
      assert.equal(partial.provider.requests.length, 1, '已有思考或部分正文时不能重新请求模型');
      assert.equal(commits.length, 1, '模型已返回的内容必须进入原有提交链');
      assert.deepEqual(commits[0].items.map(({ message }) => [message.senderType, message.text]).sort(),
        [['reasoning', '已经返回的思考'], ...(text ? [['assistant', text]] : [])].sort(),
        '只返回思考或正文被截断时都保留已收到的内容，不补空正文或错误气泡');
    }
  }
}

let disabledToolExecutions = 0;
await assert.rejects(
  () => runChatCase({
    responses: [response({
      toolCalls: [toolCall('call-disabled', 'lookup', { secret: 'private-tool-argument' })],
      isToolCall: true,
      finishReason: 'tool_calls',
    })],
    tools: [createTool('lookup', async () => {
      disabledToolExecutions += 1;
      return { status: 'success', data: 1, modelContent: '不应执行' };
    })],
    enableTools: false,
  }),
  (error) => {
    assert.match(error.message, /Chat Agent run failed/u);
    assert.match(error.diagnosticText, /MODEL_PROTOCOL_ERROR/u);
    assert.match(error.diagnosticText, /run-1/u);
    assert.match(error.diagnosticText, /lookup.*未执行/u);
    assert.doesNotMatch(error.diagnosticText, /private-tool-argument/u, '诊断不得持久化工具参数');
    return true;
  },
  'tools disabled 时意外 tool call 必须在 proposal 前失败',
);
assert.equal(capturedRunResult.terminalCode, 'MODEL_PROTOCOL_ERROR');
assert.equal(disabledToolExecutions, 0, 'tools disabled 时绝不执行意外 tool call');

const streamFallback = await runChatCase({
  responses: [response({ success: false, error: 'stream 网络失败' })],
  modelTransport: 'stream',
  enableTools: false,
});
assert.equal(streamFallback.result.terminalCode, 'MODEL_REQUEST_FAILED');
assert.equal(streamFallback.provider.requests.length, 1);
assert.equal(streamFallback.provider.requests[0].method, 'chatStream');

await assert.rejects(
  () => runChatCase({
    responses: [response({ success: false, error: '输出后失败', text: '已输出' })],
    modelTransport: 'stream',
    enableTools: false,
  }),
  (error) => error.name === 'ChatAgentModelRequestError',
  '已有模型输出后 stream 失败不得 fallback',
);
assert.equal(capturedRunResult.terminalCode, 'MODEL_REQUEST_FAILED');

let executedToolCalls = 0;
await assert.rejects(
  () => runChatCase({
    responses: [
      response({
        toolCalls: [toolCall('call-stream-tool', 'lookup', {})],
        isToolCall: true,
        finishReason: 'tool_calls',
      }),
      response({ success: false, error: '工具后失败' }),
    ],
    modelTransport: 'stream',
    tools: [createTool('lookup', async () => {
      executedToolCalls += 1;
      return { status: 'success', data: 1, modelContent: '已执行' };
    })],
  }),
  (error) => error.name === 'ChatAgentModelRequestError',
  '已有 tool proposal/执行后 stream 失败不得 fallback',
);
assert.equal(capturedRunResult.terminalCode, 'MODEL_REQUEST_FAILED');
assert.equal(executedToolCalls, 1);

assert.equal(
  canFallbackToComplete({ terminalCode: 'MODEL_REQUEST_FAILED' }, false, false, false),
  true,
  '无输出、无 tool proposal、无执行时允许 fallback',
);
assert.equal(
  canFallbackToComplete({ terminalCode: 'MODEL_PROTOCOL_ERROR' }, true, false, false),
  false,
  '已有模型输出时禁止 fallback',
);
assert.equal(
  canFallbackToComplete({ terminalCode: 'MODEL_PROTOCOL_ERROR' }, false, true, false),
  false,
  '已有 tool proposal 时禁止 fallback',
);
assert.equal(
  canFallbackToComplete({ terminalCode: 'MODEL_REQUEST_FAILED' }, false, false, true),
  false,
  '已有 tool 执行时禁止 fallback',
);

const multiBubble = await runChatCase({
  responses: [response({
    text: '第一条\n\n第二条',
  })],
});
assert.deepEqual(
  multiBubble.projectionLog.persistedReplies[0].visibleSegments,
  ['第一条', '第二条'],
  '最终回复必须经过真实 segmentAssistantReplyText 代码分段并保留多气泡',
);

await assert.rejects(
  () => runChatCase({
    responses: [response({ success: false, error: '认证失败' })],
  }),
  (error) => error.name === 'ChatAgentModelRequestError' && error.message === '认证失败',
  'Provider 错误必须穿过 Runtime 返回给 Chat 错误映射',
);
assert.equal(capturedRunResult.terminalCode, 'MODEL_REQUEST_FAILED');

await assert.rejects(
  () => runChatCase({
    responses: [response({
      text: '先处理中',
      toolCalls: [toolCall('call-projection', 'lookup', {})],
      isToolCall: true,
      finishReason: 'tool_calls',
    })],
    tools: [createTool('lookup', async () => ({
      status: 'success', data: 1, modelContent: '不应执行',
    }))],
    failProjection: true,
  }),
  /RUNTIME_UNAVAILABLE/,
  '模型完成后的 projector 失败必须保留 Runtime terminal 语义',
);
assert.equal(capturedRunResult.terminalCode, 'RUNTIME_UNAVAILABLE');

const oneTool = await runChatCase({
  responses: [
    response({
      text: '我先查一下',
      toolCalls: [toolCall('call-1', 'lookup', { q: 'one' })],
      isToolCall: true,
      finishReason: 'tool_calls',
    }),
    response({ text: '查到了' }),
  ],
  tools: [createTool('lookup', async () => ({
    status: 'success', data: 1, modelContent: '一次工具 observation',
  }))],
});
assert.equal(oneTool.result.terminalCode, 'COMPLETED');
assert.equal(oneTool.result.toolCallCount, 1);
assert.equal(oneTool.projectionLog.persistedReplies.length, 2, '工具前言与最终回复必须各投递一次');
assert.equal(oneTool.projectionLog.statusMessages.length, 1);
assert.equal(oneTool.projectionLog.statusUpdates.length, 1);
assert.equal(JSON.parse(oneTool.projectionLog.statusUpdates[0].patch.metadataJson).replyRunId, 'run-1', '上游已有的运行编号保持不变');

// 主理身份变更等主动回复没有上游 run 编号，工具与正文仍须保存执行层生成的同一身份。
for (const modelTransport of ['complete', 'stream']) {
  for (const failed of [false, true]) {
    const generated = await runChatCase({
      modelTransport,
      runtimeContext: { triggerSource: 'host_relationship' },
      responses: [
        response({ text: '先发送表情', toolCalls: [toolCall('generated-sticker', 'select_sticker', {})],
          isToolCall: true, finishReason: 'tool_calls' }),
        response({ text: '说明执行结果' }),
      ],
      tools: [createTool('select_sticker', async () => failed
        ? { status: 'error', code: 'STICKER_NOT_FOUND', message: '表情不存在', modelContent: '表情不存在' }
        : { status: 'success', data: {}, modelContent: '表情已发送' })],
    });
    const runId = generated.result.runId;
    assert.equal(runId, 'run-generated');
    assert.equal(capturedLegacyContext.sharedState.replyRunId, runId);
    for (const message of generated.projectionLog.statusMessages) {
      assert.equal(JSON.parse(message.metadataJson).replyRunId, runId, '工具开始时已有真实运行归属');
    }
    for (const update of generated.projectionLog.statusUpdates) {
      const metadata = JSON.parse(update.patch.metadataJson);
      assert.equal(metadata.replyRunId, runId, '完成或失败更新不能丢失运行归属');
      assert.equal(metadata.status, failed ? 'failed' : 'completed');
    }
    for (const reply of generated.projectionLog.persistedReplies) {
      assert.equal(reply.runtimeContext.replyRunId, runId, '前言和最终回复与工具属于同一次运行');
    }
  }
}

await assert.rejects(
  () => runChatCase({
    responses: [
      response({ text: 'private-assistant-prelude', toolCalls: [toolCall('before-failure', 'lookup', { q: 'private-query' })],
        isToolCall: true, finishReason: 'tool_calls' }),
      response({ text: '' }),
    ],
    tools: [createTool('lookup', async () => ({
      status: 'success', data: { secret: 'private-tool-data' }, modelContent: 'private-observation',
    }))],
  }),
  (error) => {
    assert.match(error.diagnosticText, /lookup.*成功/u, '后续模型失败不能把已执行成功的工具记为未执行');
    assert.doesNotMatch(error.diagnosticText, /private-(?:assistant-prelude|query|tool-data|observation)/u,
      '持久诊断只能含安全标识与状态，不能复制模型正文或工具数据');
    return true;
  },
);

const visibleMcpTools = await runChatCase({
  responses: [
    response({
      toolCalls: [toolCall('mcp-list', 'mcp_list_tools', { serverName: 'GitHub' })],
      isToolCall: true,
      finishReason: 'tool_calls',
    }),
    response({
      toolCalls: [toolCall('mcp-call', 'mcp_call_tool', {
        serverName: 'GitHub',
        remoteToolName: 'search_issues',
        arguments: { query: 'bug' },
      })],
      isToolCall: true,
      finishReason: 'tool_calls',
    }),
    response({ text: 'MCP 查询完成' }),
  ],
  tools: [
    createTool('mcp_list_tools', async () => ({
      status: 'success', data: [], modelContent: '工具清单',
    }), { source: 'mcp' }),
    createTool('mcp_call_tool', async () => ({
      status: 'success', data: [], modelContent: '查询结果',
    }), { source: 'mcp' }),
  ],
});
assert.match(visibleMcpTools.projectionLog.statusMessages[0].text, /MCP 工具清单（GitHub）/);
assert.match(
  visibleMcpTools.projectionLog.statusMessages[1].text,
  /MCP 工具（GitHub \/ search_issues）/,
  'MCP 时间线必须显示真实服务名和远端工具名',
);

const visiblePhonePackageTools = await runChatCase({
  responses: [
    response({ toolCalls: [toolCall('open-music', 'open_tool_package', { package_id: 'neteaseMusic' })], isToolCall: true, finishReason: 'tool_calls' }),
    response({ toolCalls: [toolCall('phone-search', 'netease_search_songs', { query: '晴天' }), toolCall('phone-play', 'netease_play_song', { song_id: 1 })], isToolCall: true, finishReason: 'tool_calls' }),
    response({ text: '已播放' }),
  ],
  tools: ['open_tool_package', 'netease_search_songs', 'netease_play_song'].map((name) => createTool(name, async () => ({ status: 'success', data: [], modelContent: '完成' }))),
});
assert.match(visiblePhonePackageTools.projectionLog.statusMessages[0].text, /拆开工具包（neteaseMusic）/u);
assert.match(visiblePhonePackageTools.projectionLog.statusMessages[1].text, /cloudmusic\.search_songs、cloudmusic\.play_song/u);
const phoneRunningMetadata = JSON.parse(visiblePhonePackageTools.projectionLog.statusMessages[1].metadataJson);
assert.deepEqual(phoneRunningMetadata.toolNames, ['netease_search_songs', 'netease_play_song']);
assert.deepEqual(phoneRunningMetadata.displayNames, ['cloudmusic.search_songs', 'cloudmusic.play_song']);

const budgetReached = await runChatCase({
  responses: [
    ...Array.from({ length: 10 }, (_, index) => response({
      toolCalls: Array.from({ length: 3 }, (_unused, callIndex) => toolCall(
        `call-${index + 1}-${callIndex + 1}`,
        'lookup',
        { q: index * 3 + callIndex + 1 },
      )),
      isToolCall: true,
      finishReason: 'tool_calls',
    })),
    response({ text: '我已根据十轮工具结果完成回答' }),
  ],
  tools: [createTool('lookup', async (input) => ({
    status: 'success', data: input, modelContent: `预算结果 ${input.q}`,
  }))],
});
assert.equal(budgetReached.result.terminalCode, 'COMPLETED');
assert.equal(budgetReached.provider.requests.length, 11, '十个工具回合后必须保留最终回答轮次');
assert.equal(budgetReached.result.toolCallCount, 30, '十轮、每轮三个工具必须允许完整执行 30 次');
assert.equal(budgetReached.provider.requests.at(-1).method, 'chat', '最终回答轮次不得携带工具');
assert.deepEqual(budgetReached.provider.requests[0].messages, [{ role: 'user', content: '请处理' }],
  '正常工具请求保持原始输入，不播报 Runtime 内部额度');
for (let index = 1; index < budgetReached.provider.requests.length - 1; index += 1) {
  const previous = budgetReached.provider.requests[index - 1].messages;
  assert.deepEqual(budgetReached.provider.requests[index].messages.slice(0, previous.length), previous,
    '每次消耗额度后的正常续轮仍保留上一请求的完整消息前缀');
}
assert.equal(
  budgetReached.provider.requests.at(-1).messages.some((message) => (
    message.role === 'system' && String(message.content).includes('工具调用阶段已经结束')
  )),
  true,
  '最终回答轮次必须明确通知模型工具已经关闭',
);
assert.match(
  budgetReached.projectionLog.persistedReplies.at(-1).response.text,
  /十轮工具结果完成回答/,
  '工具回合耗尽后必须由模型生成最终正文',
);

assert.equal(
  presentationModule.resolveToolCallDisplayName({
    index: 0,
    id: 'mcp-list',
    name: 'mcp_list_tools',
    arguments: JSON.stringify({ serverName: 'GitHub' }),
  }),
  'MCP 工具清单（GitHub）',
  'MCP 工具清单不得继续隐藏成无名操作',
);
assert.equal(
  presentationModule.resolveToolCallDisplayName({
    index: 0,
    id: 'mcp-call',
    name: 'mcp_call_tool',
    arguments: JSON.stringify({ serverName: 'GitHub', remoteToolName: 'search_issues' }),
  }),
  'MCP 工具（GitHub / search_issues）',
  'MCP 远端调用必须显示服务名和具体工具名',
);

const phonePresentationCases = [
  ['phone_package_list_tools', {}, 'phone_package_list_tools'],
  ['phone_package_list_tools', { package_id: 'neteaseMusic' }, 'cloudmusic'],
  [
    'phone_package_list_tools',
    { package_id: 'neteaseMusic', tool_name: 'netease_search_songs' },
    'cloudmusic.search_songs',
  ],
  [
    'phone_package_call_tool',
    { package_id: 'neteaseMusic', tool_name: 'netease_search_songs' },
    'cloudmusic.search_songs',
  ],
  [
    'phone_package_call_tool',
    { package_id: 'neteaseMusic', tool_name: 'netease_play_song' },
    'cloudmusic.play_song',
  ],
  [
    'phone_package_call_tool',
    { package_id: 'maps', tool_name: 'search_places' },
    'maps.search_places',
  ],
];
for (const [name, input, expected] of phonePresentationCases) {
  assert.equal(
    presentationModule.resolveToolCallDisplayName({
      index: 0,
      id: `presentation-${name}`,
      name,
      arguments: JSON.stringify(input),
    }),
    expected,
    'Phone Package 展示名必须使用冻结的可见语义别名，未知 package/tool 原样透传',
  );
}
assert.equal(
  presentationModule.resolveToolCallDisplayName({
    index: 0,
    id: 'phone-list-malformed',
    name: 'phone_package_list_tools',
    arguments: '{',
  }),
  'phone_package_list_tools',
  'Phone Package list malformed arguments 不得进入 timeline 异常路径',
);
assert.equal(
  presentationModule.resolveToolCallDisplayName({
    index: 0,
    id: 'phone-call-malformed',
    name: 'phone_package_call_tool',
    arguments: '{',
  }),
  'phone_package_call_tool',
  'Phone Package call malformed arguments 不得进入 timeline 异常路径',
);

const supersededController = new AbortController();
const superseded = await runChatCase({
  responses: [response({
    toolCalls: [toolCall('call-slow', 'slowLookup', {})],
    isToolCall: true,
    finishReason: 'tool_calls',
  })],
  controller: supersededController,
  tools: [createTool('slowLookup', async () => {
    chatRunActive = false;
    supersededController.abort('SUPERSEDED');
    return new Promise(() => {});
  })],
});
assert.equal(superseded.result.terminalCode, 'SUPERSEDED');
assert.equal(superseded.projectionLog.persistedReplies.length, 0, 'superseded run 不得提交旧回复');
assert.equal(superseded.projectionLog.statusMessages.length, 1);
assert.equal(superseded.projectionLog.statusUpdates.length, 1, '取消中的工具状态必须收口');
assert.match(superseded.projectionLog.statusUpdates[0].patch.text, /已取消/);
assert.match(superseded.projectionLog.statusUpdates[0].patch.metadataJson, /SUPERSEDED/);

const freshChatRun = await runChatCase({
  responses: [response({ text: '新 run 不回灌旧工具上下文' })],
});
assert.equal(
  freshChatRun.provider.requests[0].messages.some((message) => message.role === 'tool'),
  false,
  'Chat 新 run 不得跨 run 回灌旧 tool history',
);
assert.equal(
  freshChatRun.provider.requests[0].messages.some((message) => message.content === '写入结果'),
  false,
  'Chat 新 run 不得携带上一个 run 的 tool modelContent',
);

const sameBatch = await runChatCase({
  responses: [
    response({
      toolCalls: [
        toolCall('call-first', 'first', {}),
        toolCall('call-second', 'second', {}),
      ],
      isToolCall: true,
      finishReason: 'tool_calls',
    }),
    response({ text: '批次完成' }),
  ],
  tools: [
    createTool('first', async () => ({ status: 'success', data: 1, modelContent: 'first' })),
    createTool('second', async () => ({ status: 'success', data: 2, modelContent: 'second' })),
  ],
});
assert.equal(sameBatch.projectionLog.statusMessages.length, 1, '同一 step 的多个工具只能创建一条状态消息');
assert.equal(sameBatch.projectionLog.statusUpdates.length, 1, '同一工具批次只能完成一次状态消息');

const waitExternal = await runChatCase({
  responses: [response({
    toolCalls: [toolCall('call-video', 'requestVideoCall', { reason: '想见你' })],
    isToolCall: true,
    finishReason: 'tool_calls',
  })],
  tools: [createTool('requestVideoCall', async () => ({
    status: 'success',
    data: { callId: 'call-1' },
    modelContent: '视频电话请求已提交。',
    metadata: { suppressAssistantReply: true },
  }))],
});
assert.equal(waitExternal.result.terminalCode, 'CANCELLED_BY_USER');
assert.equal(waitExternal.provider.requests.length, 1, '视频来电提交后不得继续请求模型');
assert.equal(waitExternal.projectionLog.persistedReplies.length, 0, '等待外部通话时不得补发助手文本');
assert.equal(waitExternal.projectionLog.statusMessages.length, 1, '单独视频来电也保存工具调用记录');
assert.equal(waitExternal.projectionLog.statusUpdates.length, 1);
assert.deepEqual(JSON.parse(waitExternal.projectionLog.statusUpdates[0].patch.metadataJson).toolNames, ['requestVideoCall']);
assert.equal(JSON.parse(waitExternal.projectionLog.statusUpdates[0].patch.metadataJson).status, 'completed');

// 通话停止模型续轮时，真实 complete/stream 回复链仍将调用记录交给 canonical T3。
for (const modelTransport of ['complete', 'stream']) {
  for (const commitOutcome of ['committed', 'fence_failed']) {
    const commits = [];
    const call = await runChatCase({
      modelTransport,
      responses: [response({
        toolCalls: [toolCall('canonical-video', 'requestVideoCall', { reason: '想见你' })],
        isToolCall: true, finishReason: 'tool_calls',
      })],
      tools: [createTool('requestVideoCall', async () => ({
        status: 'success', data: { callId: 'call-canonical' }, modelContent: '视频电话请求已提交。',
        metadata: { suppressAssistantReply: true },
      }))],
      persistence: { persistsIntermediates: false, commitAgentTimeline: async (params) => {
        commits.push(params);
        return { outcome: commitOutcome, messages: commitOutcome === 'committed'
          ? params.items.map(({ message }, index) => ({ ...message, id: index + 1 })) : [] };
      } },
    });
    assert.equal(call.result.terminalCode, 'CANCELLED_BY_USER');
    assert.equal(call.provider.requests.length, 1, '通话成功后 complete/stream 均不追加模型请求');
    assert.equal(commits.length, 1, '内部停止仍进入已有 T3 fence，失效 run 不旁路写入');
    assert.equal(commits[0].items.length, 1, '通话仅提交调用记录，不补发空助手消息');
    const message = commits[0].items[0].message;
    assert.equal(message.senderType, 'system');
    assert.equal(message.text, '调用完成：视频电话');
    assert.deepEqual(JSON.parse(message.metadataJson).toolNames, ['requestVideoCall']);
    assert.equal(JSON.parse(message.metadataJson).status, 'completed');
  }
}

// 执行前参数拒绝也有失败历史，不能因没有 tool_call_started 而丢掉这次调用。
for (const modelTransport of ['complete', 'stream']) {
  let executed = 0;
  const commits = [];
  await runChatCase({
    modelTransport,
    responses: [response({ toolCalls: [toolCall('invalid-voice', 'send_voice_message', {})],
      isToolCall: true, finishReason: 'tool_calls' }), response({ text: '语音没有发送成功' })],
    tools: [createTool('send_voice_message', async () => { executed++; }, {
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    })],
    persistence: { persistsIntermediates: false, commitAgentTimeline: async (params) => {
      commits.push(params);
      return { outcome: 'committed', messages: params.items.map(({ message }, index) => ({ ...message, id: index + 1 })) };
    } },
  });
  assert.equal(executed, 0);
  const message = commits[0].items.find(({ message }) => message.senderType === 'system').message;
  assert.equal(message.text, '调用失败：发送语音');
  assert.equal(JSON.parse(message.metadataJson).status, 'failed');
  assert.deepEqual(JSON.parse(message.metadataJson).toolNames, ['send_voice_message']);
}

// canonical Agent timeline：四个稳定行为案例（顺序、delta 更新、同批工具、工具失败）。
function createTimelineTurn(overrides = {}) {
  return {
    messageId: 'timeline-message',
    historyItems: [],
    assistantText: '',
    reasoningText: '',
    toolCalls: [],
    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    finishReason: 'stop',
    ...overrides,
  };
}

function modelToolCall(id, name, input = {}) {
  return { index: 0, id, name, arguments: JSON.stringify(input) };
}

function timelineCommitKinds(timeline, runId) {
  return timeline.buildCommitItems({
    sessionId: 'session-1',
    aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
    runtimeContext: { replyRunId: runId },
    policy: { bubbleDeliveryMode: 'multi-bubble' },
    finalAssistantPolicy: 'commit_as_reply',
    finalStepIndex: Math.max(...timeline.snapshots().map((item) => item.stepIndex)),
  }).map(({ message }) => message.senderType === 'system' ? 'tool' : message.senderType);
}

// Case 1：reasoning step1 → tool step1 → reasoning step2 → assistant step2。
const reasoningToolTimeline = new timelineModule.ChatAgentTimeline('case-1-run');
reasoningToolTimeline.startStep(1);
reasoningToolTimeline.appendDelta(1, 'reasoning', '第一步思考');
reasoningToolTimeline.reconcileModelTurn(1, createTimelineTurn({
  reasoningText: '第一步思考',
  toolCalls: [modelToolCall('case-1-tool', 'lookup')],
  finishReason: 'tool_calls',
}));
reasoningToolTimeline.startToolStatus(1);
reasoningToolTimeline.completeToolCall(1, 'case-1-tool', {
  status: 'success', data: 1, modelContent: '完成',
});
reasoningToolTimeline.startStep(2);
reasoningToolTimeline.appendDelta(2, 'reasoning', '第二步思考');
reasoningToolTimeline.appendDelta(2, 'assistant', '最终答案');
reasoningToolTimeline.reconcileModelTurn(2, createTimelineTurn({
  reasoningText: '第二步思考', assistantText: '最终答案',
}));
assert.deepEqual(
  reasoningToolTimeline.snapshots().map((item) => item.kind),
  ['reasoning', 'tool', 'reasoning', 'assistant'],
  'Case 1：实时 timeline 必须遵循 reasoning → tool → reasoning → assistant',
);
assert.deepEqual(
  timelineCommitKinds(reasoningToolTimeline, 'case-1-run'),
  ['reasoning', 'tool', 'reasoning', 'assistant'],
  'Case 1：T3 items 必须收敛到同一顺序',
);

// Case 2：无 reasoning，tool step1 → assistant step2。
const toolAssistantTimeline = new timelineModule.ChatAgentTimeline('case-2-run');
toolAssistantTimeline.startStep(1);
toolAssistantTimeline.reconcileModelTurn(1, createTimelineTurn({
  toolCalls: [modelToolCall('case-2-tool', 'lookup')],
  finishReason: 'tool_calls',
}));
toolAssistantTimeline.startToolStatus(1);
toolAssistantTimeline.completeToolCall(1, 'case-2-tool', {
  status: 'success', data: 1, modelContent: '完成',
});
toolAssistantTimeline.startStep(2);
toolAssistantTimeline.reconcileModelTurn(2, createTimelineTurn({ assistantText: '直接回答' }));
assert.deepEqual(
  toolAssistantTimeline.snapshots().map((item) => item.kind),
  ['tool', 'assistant'],
  'Case 2：无 reasoning 时不得插入占位项',
);
assert.deepEqual(timelineCommitKinds(toolAssistantTimeline, 'case-2-run'), ['tool', 'assistant']);

// Sticker intent 不建立旁路写入；它必须作为空正文、结构化 metadata 的 assistant item 进入 T3。
const stickerTimeline = new timelineModule.ChatAgentTimeline('sticker-run');
stickerTimeline.startStep(1);
stickerTimeline.reconcileModelTurn(1, createTimelineTurn({
  toolCalls: [modelToolCall('sticker-select', 'select_sticker')],
  finishReason: 'tool_calls',
}));
stickerTimeline.startToolStatus(1);
stickerTimeline.completeToolCall(1, 'sticker-select', {
  status: 'success',
  data: {
    discriminator: 'ravencat.sticker.send.v1',
    sticker: {
      stickerId: 'sticker-1',
      mediaAssetId: 'asset-1',
      name: '开心猫猫',
      description: '猫猫开心地挥手',
      tags: ['开心', '挥手'],
      emotion: '开心',
      sourceFileName: 'happy.webp',
      mimeType: 'image/webp',
      width: 256,
      height: 256,
      isAnimated: false,
    },
  },
  modelContent: '已选择表情包',
  metadata: { fulfillsUserVisibleOutput: true },
});
stickerTimeline.startStep(2);
stickerTimeline.reconcileModelTurn(2, createTimelineTurn());
const stickerItems = stickerTimeline.buildCommitItems({
  sessionId: 'session-1',
  aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
  runtimeContext: { replyRunId: 'sticker-run' },
  policy: { bubbleDeliveryMode: 'multi-bubble' },
  finalAssistantPolicy: 'commit_as_reply',
  finalStepIndex: 2,
});
assert.equal(stickerItems.length, 2, '表情包发送同时保存工具状态和媒体消息，空 final 不生成正文');
assert.equal(stickerItems[0].message.senderType, 'system');
assert.deepEqual(JSON.parse(stickerItems[0].message.metadataJson).toolNames, ['select_sticker']);
assert.equal(stickerItems[1].message.senderType, 'assistant');
assert.equal(stickerItems[1].message.text, '');
assert.equal(JSON.parse(stickerItems[1].message.metadataJson).sticker.name, '开心猫猫');

// 真实图片工具只创建 intent；多图与文字按原时间线提交，取消丢弃 intent。
const imageTimeline = new timelineModule.ChatAgentTimeline('image-run');
imageTimeline.startStep(1);
imageTimeline.reconcileModelTurn(1, createTimelineTurn({
  toolCalls: [modelToolCall('image-first', 'send_image'), modelToolCall('image-second', 'send_image')],
  finishReason: 'tool_calls',
}));
imageTimeline.startToolStatus(1);
for (const [index, id] of ['image-first', 'image-second'].entries()) {
  const outcome = await imageToolModule.SendImageTool.execute({ media_asset_id: `asset-${index}`, on_success: 'continue' }, {
    toolCallId: id, abortSignal: new AbortController().signal,
  });
  imageTimeline.completeToolCall(1, id, outcome);
}
imageTimeline.startStep(2);
imageTimeline.reconcileModelTurn(2, createTimelineTurn({ assistantText: '这两张给你' }));
const imageCommitParams = {
  sessionId: 'session-1', aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
  runtimeContext: { replyRunId: 'image-run' }, policy: { bubbleDeliveryMode: 'multi-bubble' },
  finalAssistantPolicy: 'commit_as_reply', finalStepIndex: 2,
};
const imageItems = imageTimeline.buildCommitItems(imageCommitParams);
assert.equal(imageItems.length, 4);
assert.deepEqual(JSON.parse(imageItems[0].message.metadataJson).toolNames, ['send_image', 'send_image']);
assert.deepEqual(imageItems.slice(1).map(({ message }) => message.text), ['', '', '这两张给你']);
assert.deepEqual(imageItems.slice(1, 3).map(({ message }) => {
  assert.equal(message.senderType, 'assistant');
  assert.equal(message.agentId, 'agent-1');
  const metadata = JSON.parse(message.metadataJson);
  assert.equal(metadata.kind, 'image');
  assert.equal(metadata.attachments.length, 1);
  assert.equal(metadata.attachments[0].localUri, undefined, '图片消息只保存稳定素材引用');
  return metadata.attachments[0].mediaAssetId;
}), ['asset-0', 'asset-1']);
imageTimeline.clear('superseded');
assert.deepEqual(imageTimeline.buildCommitItems(imageCommitParams), [], '失去回合资格后不能提交旧图片 intent');

// 分享工具只取得可见快照；卡片与其他工具输出按原时间线顺序交给同一个提交 owner。
const sharedMomentSnapshot = { schemaVersion: 1, momentId: 'moment-1',
  author: { actorType: 'ai', actorId: 'agent-1', name: 'Kimi', displayName: '宝宝', avatar: null },
  content: '一张傍晚的照片', locationLabel: null, createdAt: '2026-11-01T10:00:00.000Z',
  images: [{ mediaAssetId: 'asset-0', analysisText: '傍晚的天空' }] };
const { MomentDomainError } = loadTypeScriptModule('src/features/moments/domain/MomentErrors.ts');
let unavailableMoment = false;
const { ShareMomentTool } = loadTypeScriptModule('src/host/composition/agent/ShareMomentTool.ts', {
  '@features/assistants': { getAIAssistantById: async id => ({ id, agentId: 'agent-1' }) },
  '@features/moments': { MomentDomainError, createAgentMomentShare: async (id, agentId) => {
    assert.equal(id, 'moment-1'); assert.equal(agentId, 'agent-1');
    if (unavailableMoment) throw new MomentDomainError('moment_not_visible', '不可见', id);
    return sharedMomentSnapshot;
  } },
  '@features/chat/composition': sharedMomentIntent,
  '@shared/runtime/abortSignal': loadTypeScriptModule('src/shared/runtime/abortSignal.ts'),
});
const shareContext = { runId: 'moment-run', task: { assistantId: 'assistant-1' }, toolCallId: 'moment-call', abortSignal: new AbortController().signal };
const shareOutcome = await ShareMomentTool.execute({ momentId: 'moment-1' }, shareContext);
assert.equal(shareOutcome.status, 'success'); assert.equal(shareOutcome.metadata.fulfillsUserVisibleOutput, true);
assert.deepEqual(ShareMomentTool.definition.parameters.required, ['momentId']);
const momentTimeline = new timelineModule.ChatAgentTimeline('moment-run');
momentTimeline.startStep(1);
momentTimeline.reconcileModelTurn(1, createTimelineTurn({ toolCalls: [modelToolCall('image-call', 'send_image'), modelToolCall('moment-call', 'share_moment')], finishReason: 'tool_calls' }));
momentTimeline.startToolStatus(1);
momentTimeline.completeToolCall(1, 'image-call', await imageToolModule.SendImageTool.execute({ media_asset_id: 'asset-0', on_success: 'continue' }, { ...shareContext, toolCallId: 'image-call' }));
momentTimeline.completeToolCall(1, 'moment-call', shareOutcome);
const momentCommitParams = { ...imageCommitParams, runtimeContext: { replyRunId: 'moment-run' }, finalStepIndex: 1 };
const momentItems = momentTimeline.buildCommitItems(momentCommitParams);
assert.deepEqual(momentItems.slice(1).map(item => JSON.parse(item.message.metadataJson).kind), ['image', 'shared_moment']);
assert.deepEqual(JSON.parse(momentItems[2].message.metadataJson).sharedMoment, sharedMomentSnapshot);
assert.equal(momentItems[2].message.senderType, 'assistant');
assert.equal(momentItems[2].message.agentId, 'agent-1', '分享消息发送者与原帖作者是独立事实');
momentTimeline.clear('superseded');
assert.deepEqual(momentTimeline.buildCommitItems(momentCommitParams), []);
unavailableMoment = true;
assert.equal((await ShareMomentTool.execute({ momentId: 'moment-1' }, shareContext)).code, 'MOMENT_NOT_VISIBLE');
const shareAbort = new AbortController(); shareAbort.abort(new Error('分享已取消'));
await assert.rejects(ShareMomentTool.execute({ momentId: 'moment-1' }, { ...shareContext, abortSignal: shareAbort.signal }), /分享已取消/);

const orderedTimeline = new timelineModule.ChatAgentTimeline(
  'canonical-run',
);
orderedTimeline.startStep(1);
orderedTimeline.appendDelta(1, 'reasoning', '先思考');
orderedTimeline.appendDelta(1, 'assistant', '我先查一下');
orderedTimeline.reconcileModelTurn(1, createTimelineTurn({
  assistantText: '我先查一下',
  reasoningText: '先思考',
  toolCalls: [modelToolCall('call-ordered', 'lookup')],
  finishReason: 'tool_calls',
}));
orderedTimeline.startToolStatus(1);
orderedTimeline.completeToolCall(1, 'call-ordered', {
  status: 'success',
  data: 1,
  modelContent: '查到了',
});
orderedTimeline.startStep(2);
orderedTimeline.reconcileModelTurn(2, createTimelineTurn({ assistantText: '最终答案' }));
const orderedItems = orderedTimeline.buildCommitItems({
  sessionId: 'session-1',
  aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
  runtimeContext: { replyRunId: 'canonical-run' },
  policy: { bubbleDeliveryMode: 'multi-bubble' },
  finalAssistantPolicy: 'commit_as_reply',
  finalStepIndex: 2,
});
assert.deepEqual(
  orderedItems.map(({ message }) => message.senderType),
  ['reasoning', 'assistant', 'system', 'assistant'],
  'Case 3：reasoning → assistant 前言 → tool → 最终 assistant 必须保持 timeline 顺序',
);
assert.equal(
  new Set(orderedItems.map(({ message }) => message.clientMessageId)).size,
  orderedItems.length,
  'Case 3：每个 committed item 必须有不重复稳定 clientMessageId',
);
assert.equal(
  orderedItems[0].message.logicalMessageId,
  orderedItems[1].message.logicalMessageId,
  'Case 3：同 step reasoning/assistant 必须共享 logicalMessageId',
);
const orderedSnapshotsByClientId = new Map(
  orderedTimeline.snapshots().map((item) => [item.clientMessageId, item]),
);
for (const { message } of orderedItems) {
  assert.equal(
    message.createdAt,
    orderedSnapshotsByClientId.get(message.clientMessageId)?.createdAt,
    'Case 3：T3 replacement 必须保留 transient item 的真实创建时间',
  );
}

const multiToolTimeline = new timelineModule.ChatAgentTimeline('case-4-run');
multiToolTimeline.startStep(1);
multiToolTimeline.appendDelta(1, 'reasoning', '先检查 A 和 B');
multiToolTimeline.reconcileModelTurn(1, createTimelineTurn({
  reasoningText: '先检查 A 和 B',
  toolCalls: [modelToolCall('case-4-a', 'first'), modelToolCall('case-4-b', 'second')],
  finishReason: 'tool_calls',
}));
multiToolTimeline.startToolStatus(1);
multiToolTimeline.completeToolCall(1, 'case-4-a', { status: 'success', data: 1, modelContent: 'a' });
multiToolTimeline.completeToolCall(1, 'case-4-b', { status: 'success', data: 2, modelContent: 'b' });
multiToolTimeline.startStep(2);
multiToolTimeline.appendDelta(2, 'reasoning', '再检查 C');
multiToolTimeline.reconcileModelTurn(2, createTimelineTurn({
  reasoningText: '再检查 C',
  toolCalls: [modelToolCall('case-4-c', 'third')],
  finishReason: 'tool_calls',
}));
multiToolTimeline.startToolStatus(2);
multiToolTimeline.completeToolCall(2, 'case-4-c', { status: 'success', data: 3, modelContent: 'c' });
multiToolTimeline.startStep(3);
multiToolTimeline.reconcileModelTurn(3, createTimelineTurn({ assistantText: '全部完成' }));
assert.deepEqual(
  multiToolTimeline.snapshots().map((item) => item.kind),
  ['reasoning', 'tool', 'reasoning', 'tool', 'assistant'],
  'Case 4：多工具 step 必须保持 reasoning → tool batch → reasoning → tool → assistant',
);
assert.deepEqual(
  timelineCommitKinds(multiToolTimeline, 'case-4-run'),
  ['reasoning', 'tool', 'reasoning', 'tool', 'assistant'],
);

const deltaTimeline = new timelineModule.ChatAgentTimeline('delta-run');
deltaTimeline.startStep(1);
deltaTimeline.appendDelta(1, 'assistant', '相同');
const firstDeltaIdentity = deltaTimeline.snapshots()[0].clientMessageId;
deltaTimeline.appendDelta(1, 'assistant', '文本');
assert.equal(deltaTimeline.snapshots().length, 1, 'delta：assistant delta 只能更新原 timeline item');
assert.equal(deltaTimeline.snapshots()[0].clientMessageId, firstDeltaIdentity);
assert.equal(deltaTimeline.snapshots()[0].text, '相同文本');

const batchTimeline = new timelineModule.ChatAgentTimeline('batch-run');
batchTimeline.startStep(1);
batchTimeline.reconcileModelTurn(1, createTimelineTurn({
  toolCalls: [modelToolCall('call-a', 'first'), modelToolCall('call-b', 'second')],
  finishReason: 'tool_calls',
}));
batchTimeline.startToolStatus(1);
batchTimeline.completeToolCall(1, 'call-a', { status: 'success', data: 1, modelContent: 'a' });
batchTimeline.completeToolCall(1, 'call-b', { status: 'success', data: 2, modelContent: 'b' });
assert.equal(
  batchTimeline.snapshots().filter((item) => item.kind === 'tool').length,
  1,
  '工具批次：同 step 只能有一条 tool timeline item',
);

const phonePackageTimeline = new timelineModule.ChatAgentTimeline(
  'phone-package-run',
  {},
);
phonePackageTimeline.startStep(1);
phonePackageTimeline.reconcileModelTurn(1, createTimelineTurn({
  toolCalls: [modelToolCall('phone-package-call', 'phone_package_call_tool', {
    package_id: 'neteaseMusic',
    tool_name: 'netease_search_songs',
    arguments: { query: '晴天' },
  })],
  finishReason: 'tool_calls',
}));
phonePackageTimeline.startToolStatus(1);
let phonePackageTool = phonePackageTimeline.snapshots().find((item) => item.kind === 'tool');
assert.equal(phonePackageTool.text, '准备调用：cloudmusic.search_songs');
phonePackageTimeline.markToolStarted(1, 'phone-package-call');
assert.equal(phonePackageTimeline.snapshots().find(item => item.kind === 'tool').text, '正在调用：cloudmusic.search_songs');
assert.deepEqual(phonePackageTool.toolNames, ['phone_package_call_tool']);
assert.deepEqual(phonePackageTool.toolDisplayNames, ['cloudmusic.search_songs']);
phonePackageTimeline.completeToolCall(1, 'phone-package-call', {
  status: 'success', data: 1, modelContent: '完成',
});
phonePackageTool = phonePackageTimeline.snapshots().find((item) => item.kind === 'tool');
assert.equal(phonePackageTool.text, '调用完成：cloudmusic.search_songs');
assert.deepEqual(phonePackageTool.toolNames, ['phone_package_call_tool']);
assert.deepEqual(phonePackageTool.toolDisplayNames, ['cloudmusic.search_songs']);

const failedTimeline = new timelineModule.ChatAgentTimeline('failure-run');
failedTimeline.startStep(1);
failedTimeline.reconcileModelTurn(1, createTimelineTurn({
  toolCalls: [modelToolCall('call-failed', 'lookup')],
  finishReason: 'tool_calls',
}));
failedTimeline.startToolStatus(1);
failedTimeline.completeToolCall(1, 'call-failed', {
  status: 'error',
  code: 'TOOL_EXECUTION_FAILED',
  retryable: false,
  modelContent: '工具失败',
});
const failedTool = failedTimeline.snapshots().find((item) => item.kind === 'tool');
assert.equal(failedTool.status, 'failed', '工具失败必须更新原 tool item 为 failed');
assert.match(failedTool.text, /调用失败/);

// 拆包工具的稳定事实由真实 canonical projector 传给 T3，不由模型文本解析。
{
  const canonicalProjectorModule = loadTypeScriptModule('src/features/chat/reply/agent/ChatAgentRunProjector.ts', {
    '../application/ChatReplyAbort': replyAbortMock,
    './ChatAgentToolTimelineProjector': toolTimelineModule,
    './ChatStreamingReplyProjector': {},
    './ChatAgentTimeline': timelineModule,
  });
  let committedParams;
  const projector = new canonicalProjectorModule.ChatAgentRunProjector({
    sessionId: 'session-1', repository: {}, callbacks: {},
    aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
    runtimeContext: {}, policy: { bubbleDeliveryMode: 'multi-bubble' },
    projection: { kind: 'canonical', commit: { commitAgentTimeline: async (params) => {
      committedParams = params;
      return { outcome: 'committed', messages: params.items.map(({ message }, index) => ({ ...message, id: index + 1 })) };
    } } },
    stopRuntime: () => {}, replyRunId: 'package-projector', finalAssistantPolicy: 'commit_as_reply',
  });
  await projector.handleEvent({ type: 'model_turn_started', stepIndex: 1 });
  await projector.projectModelTurn(1, createTimelineTurn({
    toolCalls: [modelToolCall('open-package', 'open_tool_package', { package_id: 'memory' })], finishReason: 'tool_calls',
  }));
  await projector.handleEvent({ type: 'model_turn_started', stepIndex: 2 });
  await projector.projectModelTurn(2, createTimelineTurn({ assistantText: '正式回复' }));
  await projector.completeRun({ terminalCode: 'COMPLETED', steps: [
    { stepIndex: 1, toolCalls: [
      { outcome: { status: 'success', data: {}, modelContent: '已拆封', metadata: { toolPackageChange: { packageId: 'memory', action: 'open' } } } },
      { outcome: { status: 'success', data: {}, modelContent: '已收起', metadata: { toolPackageChange: { packageId: 'memory', action: 'close' } } } },
      { outcome: { status: 'error', code: 'TEST_FAILED', modelContent: '失败', metadata: { toolPackageChange: { packageId: 'failed-package', action: 'open' } } } },
    ] },
    { stepIndex: 2, toolCalls: [] },
  ] });
  assert.deepEqual(committedParams.toolPackageChanges, [
    { packageId: 'memory', action: 'open' }, { packageId: 'memory', action: 'close' },
  ], '开关按执行顺序交给提交 owner，失败的操作不进入状态提交');
}

// 工具直接结束的真实 Runtime → canonical projector 链路，不制造空 final step。
for (const scope of ['direct','group']) {
const outputSessionId=scope==='group'?'group-session':'session-1';
for (const [toolName, data, expectedText] of [
  ['select_sticker', {
    discriminator: 'ravencat.sticker.send.v1',
    sticker: JSON.parse(stickerItems[1].message.metadataJson).sticker,
  }, ''],
  ['send_voice_message', {
    discriminator: 'ravencat.chat.voice_message.send.v1', transcript: '晚安，我陪着你',
    mimeType: 'audio/wav', durationMs: 1200, preparedMedia: {},
  }, '晚安，我陪着你'],
]) {
  const canonicalProjectorModule = loadTypeScriptModule('src/features/chat/reply/agent/ChatAgentRunProjector.ts', {
    '../application/ChatReplyAbort': replyAbortMock,
    './ChatAgentToolTimelineProjector': toolTimelineModule,
    './ChatStreamingReplyProjector': {}, './ChatAgentTimeline': timelineModule,
  });
  const commits = [];
  const runId = `finish-${toolName}`;
  const projector = new canonicalProjectorModule.ChatAgentRunProjector({
    sessionId: outputSessionId, repository: {}, callbacks: {},
    aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
    runtimeContext: { replyRunId: runId, ...(scope==='group'?{groupChat:{groupId:outputSessionId,planId:'group-plan',taskId:runId}}:{}) }, policy: { bubbleDeliveryMode: 'multi-bubble' },
    projection: { kind: 'canonical', commit: { commitAgentTimeline: async (params) => {
      commits.push(params);
      return { outcome: 'committed', messages: params.items.map(({ message }, index) => ({ ...message, id: index + 1 })) };
    } } },
    stopRuntime: () => {}, replyRunId: runId,
    finalAssistantPolicy: 'commit_as_reply',
  });
  const registry = new AgentToolRegistry();
  registry.register(createTool(toolName, async () => ({
    status: 'success', data, modelContent: '输出已准备',
    metadata: { fulfillsUserVisibleOutput: true, completionIntent: 'finish' },
  })));
  let requests = 0;
  const runtime = new AgentRuntime({
    registry,
    modelGateway: { runTurn: async () => {
      requests += 1;
      assert.equal(requests, 1, '发送工具 finish 后不得请求第二个模型回合');
      const turn = createTimelineTurn({
        toolCalls: [modelToolCall('output', toolName)], finishReason: 'tool_calls',
      });
      await projector.projectModelTurn(1, turn);
      return turn;
    } },
  });
  const result = await runtime.run({
    runId,
    task: chatTaskModule.createChatAgentTask({
      runId, type:scope==='group'?'group_chat_reply':'chat_reply',goal: '发送一条回复', assistantId: 'assistant-1', sessionId: outputSessionId,
      allowedToolNames: [toolName], modelTransport: 'complete', createdAt: new Date(0).toISOString(),
    }),
    initialHistory: [], eventSink: (event) => projector.handleEvent(event),
  });
  assert.equal(result.terminalCode, 'COMPLETED');
  await projector.completeRun(result);
  assert.equal(commits.length, 1, '工具结束仍进入唯一 canonical 提交出口');
  assert.equal(commits[0].items.length, 2, '单独发送同时提交工具记录和媒体消息');
  const toolMessage = commits[0].items[0].message;
  assert.equal(toolMessage.senderType, 'system');
  assert.equal(JSON.parse(toolMessage.metadataJson).status, 'completed');
  assert.deepEqual(JSON.parse(toolMessage.metadataJson).toolNames, [toolName]);
  const mediaItem = commits[0].items[1];
  assert.equal(mediaItem.message.senderType, 'assistant');
  assert.equal(mediaItem.message.text, expectedText);
  assert.equal(mediaItem.message.sessionId,outputSessionId,'输出属于执行会话');
  if (toolName === 'send_voice_message') {
    assert.equal(typeof mediaItem.materializeInTransaction, 'function', '语音仍由 T3 物化媒体');
  } else {
    assert.equal(JSON.parse(mediaItem.message.metadataJson).sticker.stickerId, 'sticker-1');
  }
}
}

// 日程的持久展示、失败保留与中断由真实 SQLite 集成验证覆盖。
// 静默仅由最终正文的完整控制信号决定，含标记的普通句子照常发送。
for (const [text, shouldSend] of [
  [autonomousReplyContract.AUTONOMOUS_SILENT_REPLY, false],
  [` \n${autonomousReplyContract.AUTONOMOUS_SILENT_REPLY}\n `, false],
  ['本次无需打扰用户', true],
  [`这是标记 ${autonomousReplyContract.AUTONOMOUS_SILENT_REPLY} 的说明`, true],
]) {
  const timeline = new timelineModule.ChatAgentTimeline('autonomous-contract', {}, { bubbleDeliveryMode: 'multi-bubble' }, 'autonomous_reply');
  timeline.startStep(1);
  timeline.reconcileModelTurn(1, createTimelineTurn({ assistantText: text }));
  const params = { sessionId: 'session-1', aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
    policy: { bubbleDeliveryMode: 'multi-bubble' }, finalAssistantPolicy: 'autonomous_reply', finalStepIndex: 1 };
  const items = timeline.buildCommitItems(params);
  assert.equal(items.some(({ message }) => message.senderType === 'assistant'), shouldSend);
  if (!shouldSend) {
    assert.deepEqual(items.map(({ message }) => message.text), ['本次选择不发送消息']);
    assert.ok(timeline.snapshots().every((item) => !item.text.includes('[[NO_MESSAGE]]')), '控制信号不出现在展示中');
  }
}

// 工具前言沿普通聊天成为发言；静默不能撤回此前正文或表情。
const autonomousTimeline = new timelineModule.ChatAgentTimeline('autonomous-prelude', {}, {}, 'autonomous_reply');
autonomousTimeline.startStep(1);
autonomousTimeline.reconcileModelTurn(1, createTimelineTurn({ assistantText: '先检查一下', toolCalls: [modelToolCall('prelude', 'select_sticker')] }));
autonomousTimeline.startToolStatus(1);
autonomousTimeline.completeToolCall(1, 'prelude', { status: 'success', data: {
  discriminator: 'ravencat.sticker.send.v1', sticker: JSON.parse(stickerItems[1].message.metadataJson).sticker,
}, modelContent: '已发送' });
const autonomousCommitParams = {
  sessionId: 'session-1', aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
  policy: { bubbleDeliveryMode: 'multi-bubble' }, finalAssistantPolicy: 'autonomous_reply',
};
assert.ok(autonomousTimeline.buildCommitItems({ ...autonomousCommitParams, finalStepIndex: 1 })
  .some(({ message }) => message.senderType === 'assistant' && message.text === '先检查一下'), '日程前言与普通聊天使用相同的正文规则');
autonomousTimeline.startStep(2);
autonomousTimeline.reconcileModelTurn(2, createTimelineTurn({ assistantText: autonomousReplyContract.AUTONOMOUS_SILENT_REPLY }));
const silentAfterToolItems = autonomousTimeline.buildCommitItems({
  sessionId: 'session-1', aiConfig: { id: 'assistant-1', agentId: 'agent-1', name: 'Kimi' },
  policy: { bubbleDeliveryMode: 'multi-bubble' }, finalAssistantPolicy: 'autonomous_reply', finalStepIndex: 2,
});
assert.deepEqual(silentAfterToolItems.filter(({ message }) => message.senderType === 'assistant' && message.text).map(({ message }) => message.text), ['先检查一下'], '静默只抑制本轮控制标记，不撤回已显示正文');
assert.equal(silentAfterToolItems.filter(({ message }) => message.senderType === 'assistant').length, 2, '静默保留已经准备的表情与之前的正文');

console.log('Agent Runtime Chat 验证通过：回复投影、自主行动记录、失败与取消保留、预算和工具行为符合契约。');
