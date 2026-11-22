import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const eventQueueModule = loadTypeScriptModule('src/platform/agentRuntime/AgentRunEventQueue.ts');

/** 纯文本时代：模型输出即正文，fixture 不再需要任何 XML 信封包装。 */
function plainText(message) {
  return message;
}

const fallbackModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentReplyFlow.ts',
  {
    '@platform/agentRuntime': { AgentRunEventQueue: class {} },
    '../application/ChatReplyRuntimeDependencies': {
      getChatReplyRuntimeDependencies: () => ({ agent: {}, tools: {} }),
    },
    '../application/ChatReplyRuntime': {},
    '../application/ChatReplyAbort': { assertChatReplyNotAborted: () => {} },
    '../application/ChatReplyUtils': {},
    '../../messages/application/AgentTransientTimeline': {
      createAgentTransientTimelineSink: () => ({}),
    },
    './ChatAgentRunProjector': { ChatAgentRunProjector: class {} },
    './ChatAgentTask': { createChatAgentTask: () => {} },
    './ChatAgentModelGateway': { ChatAgentModelGateway: class {} },
  },
);
assert.equal(
  fallbackModule.canFallbackToComplete(
    { terminalCode: 'MODEL_REQUEST_FAILED' },
    false,
    false,
    false,
  ),
  true,
  'ST-05 首包前流失败必须允许 complete fallback',
);
assert.equal(
  fallbackModule.canFallbackToComplete(
    { terminalCode: 'MODEL_REQUEST_FAILED' },
    true,
    false,
    false,
  ),
  false,
  'ST-06 已提交 delta 后不得隐藏重试',
);
assert.equal(
  fallbackModule.canFallbackToComplete(
    { terminalCode: 'MODEL_REQUEST_FAILED' },
    false,
    true,
    false,
  ),
  false,
  '已有工具 proposal 时不得从头重试',
);
assert.equal(
  fallbackModule.canFallbackToComplete(
    { terminalCode: 'MODEL_REQUEST_FAILED' },
    false,
    true,
    true,
  ),
  false,
  '已有工具执行的后续 turn 失败不得从头重试',
);
assert.equal(
  fallbackModule.canFallbackToComplete(
    { terminalCode: 'MODEL_PROTOCOL_ERROR' },
    false,
    false,
    false,
  ),
  true,
  '无输出、无工具的空流式响应必须允许 complete fallback',
);

let flowTerminalCode = 'MODEL_REQUEST_FAILED';
let flowObservedModelOutput = true;
let flowFailedRuns = 0;
let flowCompletedRuns = 0;
const providerFailure = new Error('provider failed after delta');
const chatAgentReplyFlowModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentReplyFlow.ts',
  {
    '@platform/agentRuntime': {
      AgentRunEventQueue: class {
        constructor(sink) {
          this.sink = sink;
        }
        enqueue(event) {
          return this.sink(event);
        }
        async drain() {}
      },
    },
    '../application/ChatReplyRuntimeDependencies': {
      getChatReplyRuntimeDependencies: () => ({
        agent: {
          run: async () => ({
            terminalCode: flowTerminalCode,
            steps: [],
          }),
        },
        tools: {},
      }),
    },
    '../application/ChatReplyRuntime': {
      createRuntimeToolContext: () => ({}),
    },
    '../application/ChatReplyAbort': {
      assertChatReplyNotAborted: () => {},
    },
    '../application/ChatReplyUtils': {
      buildLogicalMessageId: () => 'run-flow-terminal',
    },
    '../../messages/application/AgentTransientTimeline': {
      createAgentTransientTimelineSink: () => ({}),
    },
    './ChatAgentRunProjector': {
      ChatAgentRunProjector: class {
        async failRun() {
          flowFailedRuns += 1;
        }
        async completeRun() {
          flowCompletedRuns += 1;
        }
        async handleEvent() {}
        async projectModelTurn() {}
      },
    },
    './ChatAgentTask': {
      createChatAgentTask: (task) => task,
    },
    './ChatAgentModelGateway': {
      ChatAgentModelGateway: class {
        hasObservedModelOutput() {
          return flowObservedModelOutput;
        }
        requireModelRequestError() {
          return providerFailure;
        }
      },
    },
  },
);
const streamingFlowParams = {
  sessionId: 'session-1',
  originalUserText: '测试失败终态',
  requestMessages: [{ role: 'user', content: '测试失败终态' }],
  aiConfig: { id: 'assistant-1' },
  repository: {},
  callbacks: {},
  runtimeContext: {},
  client: {},
  policy: {
    bubbleDeliveryMode: 'multi-bubble',
    modelTransport: 'stream',
    enableTools: false,
  },
  persistence: {},
};
await assert.rejects(
  chatAgentReplyFlowModule.runChatAgentReplyFlow(streamingFlowParams),
  (error) => error === providerFailure,
  '流式 MODEL_REQUEST_FAILED 必须走现有 Provider 错误投递路径',
);
assert.equal(flowFailedRuns, 1, '流式模型失败必须先收口未完成投影');
assert.equal(flowCompletedRuns, 0, '失败 terminal 不得伪装成完成');

flowTerminalCode = 'MODEL_PROTOCOL_ERROR';
flowObservedModelOutput = false;
flowFailedRuns = 0;
const emptyStreamResult = await chatAgentReplyFlowModule.runChatAgentReplyFlow(streamingFlowParams);
assert.deepEqual(emptyStreamResult, { completed: false }, '空流式响应必须进入 complete fallback');
assert.equal(flowFailedRuns, 0, 'fallback 前没有投影需要标记失败');

flowTerminalCode = 'CANCELLED_BY_USER';
flowCompletedRuns = 0;
const cancelledStreamResult = await chatAgentReplyFlowModule.runChatAgentReplyFlow(streamingFlowParams);
assert.deepEqual(cancelledStreamResult, { completed: true }, 'cancellation 必须由流式投影正常收口');
assert.equal(flowCompletedRuns, 1, 'cancellation terminal 必须交给 Chat projector');

const projectorLogs = {
  persisted: [],
  updates: [],
};
let nextMessageId = 1;
const projectorModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatStreamingReplyProjector.ts',
  {
    '@features/chat/messages/domain': {
      buildAssistantMessagePreviewText: (text) => text,
    },
    '../application/ChatReplyMetadata': {
      buildMessageMetadata: (_aiConfig, _runtimeContext, metadata) => metadata,
    },
    '../application/ChatReplyAbort': {
      assertChatReplyNotAborted: () => {},
    },
    '../application/CommittedAssistantSegmentDelivery': {
      deliverCommittedAssistantSegment: async (params) => params.callbacks.onReplySegment?.({
        status: 'segment',
        sessionId: params.sessionId,
        correlationId: params.runtimeContext.correlationId || params.runtimeContext.replyRunId,
        text: params.text,
        previewText: params.text.trim(),
        logicalMessageId: params.logicalMessageId,
        messageId: params.messageId,
        segmentIndex: params.segmentIndex,
        segmentTotal: params.segmentTotal,
      }),
    },
    '../application/ChatReplyUtils': {
      buildLogicalMessageId: () => `logical-${nextMessageId}`,
      formatMessageTime: () => '12:00',
    },
    '../delivery/AIMessageEvents': {
      emitAIMessageReceived: () => {},
      resolveAIMessageDeliveryKind: () => 'immediate',
    },
    '../../messages/events/ChatEvents': {
      emitChatMessagesPatched: () => {},
    },
    '../../messages/application/MessagePersistence': {
      persistChatMessage: async ({ message }) => {
        const saved = { ...message, id: nextMessageId };
        nextMessageId += 1;
        projectorLogs.persisted.push(saved);
        return saved;
      },
      syncChatSessionPreview: async () => {},
    },
  },
);
const { ChatStreamingReplyProjector } = projectorModule;
const assistantText = plainText('流式最终答案');
const projector = new ChatStreamingReplyProjector({
  sessionId: 'session-1',
  repository: {
    updateMessage: async (messageId, patch) => {
      projectorLogs.updates.push({ messageId, patch });
    },
  },
  callbacks: {},
  aiConfig: {
    id: 'assistant-1',
    agentId: 'agent-1',
    name: 'Kimi',
  },
  runtimeContext: { memoryParticipation: 'off' },
  policy: { bubbleDeliveryMode: 'multi-bubble' },
  // 本脚本验证 Legacy 流式行为：中间草稿直接落库并逐次 patch。
  persistence: {
    persistsIntermediates: true,
    persistCompletedAssistantReply: async () => {},
    persistAssistantPrelude: async () => {},
  },
  replyRunId: 'run-streaming',
});
projector.startTurn(1);
await projector.handleDelta(1, { type: 'assistant_text_delta', text: assistantText.slice(0, 3) });
assert.ok(projectorLogs.persisted.some((message) => message.senderType === 'assistant'), 'ST-01 增量必须先创建草稿');
await projector.handleDelta(1, { type: 'assistant_text_delta', text: assistantText.slice(3) });
await projector.completeModelTurn(1, {
  messageId: 'message-1',
  historyItems: [],
  assistantText,
  reasoningText: '',
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 },
  finishReason: 'stop',
});
await projector.finalizeFinalTurn(1, {
  messageId: 'message-1',
  historyItems: [],
  assistantText,
  reasoningText: '',
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 },
  finishReason: 'stop',
});
assert.equal(
  projectorLogs.persisted.filter((message) => message.senderType === 'assistant').length,
  1,
  'ST-01 最终只能创建一条助手消息',
);
assert.ok(
  projectorLogs.updates.some(({ patch }) => patch.status === 'sent'),
  'ST-01 草稿最终必须收口为 sent',
);
assert.equal(
  JSON.parse(projectorLogs.updates.find(({ patch }) => patch.status === 'sent').patch.metadataJson).cachedTokens,
  0,
  '流式收口应持久保存服务商返回的 0 命中，不能丢成未知',
);
const finalizedMessageId = projectorLogs.persisted.find(
  (message) => message.senderType === 'assistant',
).id;
projector.startTurn(2);
await projector.handleDelta(2, {
  type: 'assistant_text_delta',
  text: plainText('待失败草稿'),
});
const pendingMessageId = projectorLogs.persisted.at(-1).id;
await projector.markFailed();
assert.equal(
  projectorLogs.updates.some(({ messageId, patch }) => (
    messageId === finalizedMessageId && patch.status === 'failed'
  )),
  false,
  '后续 turn 失败不得污染此前已完成消息',
);
assert.equal(
  projectorLogs.updates.some(({ messageId, patch }) => (
    messageId === pendingMessageId && patch.status === 'failed'
  )),
  true,
  '失败时必须收口当前未完成草稿',
);

const queueModule = eventQueueModule;
const receivedEvents = [];
const queue = new queueModule.AgentRunEventQueue(async (event) => {
  await new Promise((resolve) => setTimeout(resolve, 2));
  receivedEvents.push(event);
});
await Promise.all([
  queue.enqueue({ type: 'run_started', runId: 'run-queue', taskId: 'task-queue' }),
  queue.enqueue({ type: 'reasoning_delta', runId: 'run-queue', stepIndex: 1, text: '慢' }),
  queue.enqueue({ type: 'reasoning_delta', runId: 'run-queue', stepIndex: 1, text: '投影' }),
  queue.enqueue({ type: 'tool_call_started', runId: 'run-queue', stepIndex: 1, toolCallId: 'call-1', toolName: 'search' }),
  queue.enqueue({
    type: 'tool_call_completed',
    runId: 'run-queue',
    stepIndex: 1,
    toolCallId: 'call-1',
    toolName: 'search',
    outcome: { status: 'success', data: null, modelContent: '完成' },
  }),
  queue.enqueue({ type: 'run_completed', runId: 'run-queue', result: { terminalCode: 'COMPLETED' } }),
]);
await queue.drain();
assert.equal(receivedEvents.at(-1).type, 'run_completed', 'ST-08 terminal 事件不得丢失');
assert.equal(
  receivedEvents.find((event) => event.type === 'reasoning_delta').text,
  '慢投影',
  'ST-08 纯文本增量应在队列中合并而不丢失',
);
assert.equal(
  receivedEvents.filter((event) => event.type === 'tool_call_completed').length,
  1,
  'ST-08 tool completed 事件不得丢失',
);

const unhandledRejections = [];
const recordUnhandledRejection = (error) => {
  unhandledRejections.push(error);
};
process.on('unhandledRejection', recordUnhandledRejection);
try {
  const failingQueue = new queueModule.AgentRunEventQueue(async () => {
    throw new Error('projector failed');
  });
  await failingQueue.enqueue({
    type: 'assistant_text_delta',
    runId: 'run-failing-queue',
    stepIndex: 1,
    text: '失败增量',
  });
  await assert.rejects(failingQueue.drain(), /projector failed/);
  await new Promise((resolve) => setImmediate(resolve));
} finally {
  process.removeListener('unhandledRejection', recordUnhandledRejection);
}
assert.deepEqual(unhandledRejections, [], 'delta 投影失败不得产生悬空 Promise rejection');

console.log('Agent Runtime Streaming 验证通过：Chat 流式投影、fallback 与事件队列收口符合契约。');
