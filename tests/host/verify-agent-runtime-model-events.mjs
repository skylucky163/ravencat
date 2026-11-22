import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const collectorModule = loadTypeScriptModule('src/platform/ai/agent/ModelTurnCollector.ts');
const completeModule = loadTypeScriptModule(
  'src/platform/ai/agent/CompleteModelTurnAdapter.ts',
  { './ModelTurnCollector': collectorModule },
);
const streamingModule = loadTypeScriptModule(
  'src/platform/ai/agent/StreamingModelTurnAdapter.ts',
  {
    './ModelTurnCollector': collectorModule,
    './CompleteModelTurnAdapter': completeModule,
  },
);
const request = {
  messages: [{ role: 'user', content: '请查找资料' }],
  tools: [],
};

function response(overrides = {}) {
  return {
    text: '',
    reasoningText: '',
    finishReason: 'stop',
    messageId: 'message-1',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedTokens: 6,
    success: true,
    error: null,
    toolCalls: null,
    isToolCall: false,
    ...overrides,
  };
}

function toolCall(id, name, argumentsText) {
  return {
    id,
    type: 'function',
    function: { name, arguments: argumentsText },
  };
}

function completeProvider(result) {
  return {
    chatWithTools: async () => result,
    chatStreamWithTools: async () => result,
  };
}

async function collectComplete(result) {
  const events = [];
  const adapter = new completeModule.CompleteModelTurnAdapter(completeProvider(result));
  const turn = await adapter.complete(request, (event) => events.push(event));
  return { events, turn };
}

const plain = await collectComplete(response({
  text: '完成了',
  reasoningText: '先判断',
}));
assert.equal(plain.turn.assistantText, '完成了');
assert.equal(plain.turn.reasoningText, '先判断');
assert.deepEqual(plain.turn.toolCalls, []);
assert.equal(plain.turn.finishReason, 'stop');
assert.equal(plain.events.at(-1).type, 'turn_completed');

const calls = [
  toolCall('call-1', 'search', '{"q":"a"}'),
  toolCall('call-2', 'read', '{"id":2}'),
];
const completeWithTools = await collectComplete(response({
  reasoningText: '需要两步',
  toolCalls: calls,
  isToolCall: true,
  finishReason: 'tool_calls',
}));
assert.deepEqual(
  completeWithTools.turn.toolCalls.map(({ id, index, name, arguments: args }) => ({ id, index, name, args })),
  [
    { id: 'call-1', index: 0, name: 'search', args: '{"q":"a"}' },
    { id: 'call-2', index: 1, name: 'read', args: '{"id":2}' },
  ],
);

const streamEvents = [];
const streamingAdapter = new streamingModule.StreamingModelTurnAdapter({
  chatWithTools: async () => response(),
  chatStreamWithTools: async (_messages, _tools, options) => {
    await options.onDelta({ type: 'reasoning_delta', text: '需要' });
    await options.onDelta({ type: 'answer_delta', text: '答' });
    await options.onDelta({
      type: 'tool_call_start',
      toolCallId: 'call-1',
      index: 0,
    });
    await options.onDelta({
      type: 'tool_call_args_delta',
      toolCallId: 'call-1',
      index: 0,
      argumentsDelta: '{"q":',
    });
    await options.onDelta({
      type: 'tool_call_start',
      toolCallId: 'call-1',
      index: 0,
      name: 'search',
    });
    await options.onDelta({
      type: 'tool_call_args_delta',
      toolCallId: 'call-1',
      index: 0,
      argumentsDelta: '"a"}',
    });
    await options.onDelta({
      type: 'tool_call_done',
      toolCallId: 'call-1',
      index: 0,
      name: 'search',
      arguments: '{"q":"a"}',
    });
    await options.onDelta({ type: 'done' });
    return response({
      text: '答',
      reasoningText: '需要',
      toolCalls: [calls[0]],
      isToolCall: true,
      finishReason: 'tool_calls',
    });
  },
});
const streamTurn = await streamingAdapter.stream(request, (event) => streamEvents.push(event));
assert.deepEqual(streamTurn, {
  historyItems: [{
    role: 'assistant',
    content: '答',
    reasoningText: '需要',
    toolCalls: [{ index: 0, id: 'call-1', name: 'search', arguments: '{"q":"a"}' }],
  }],
  assistantText: '答',
  reasoningText: '需要',
  toolCalls: [{ index: 0, id: 'call-1', name: 'search', arguments: '{"q":"a"}' }],
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 6 },
  finishReason: 'tool_calls',
});
assert.equal(streamEvents.filter((event) => event.type === 'tool_call_completed').length, 1);

const equivalentComplete = await collectComplete(response({
  text: '答',
  reasoningText: '需要',
  toolCalls: [calls[0]],
  isToolCall: true,
  finishReason: 'tool_calls',
}));
assert.deepEqual(streamTurn, equivalentComplete.turn, 'complete/stream 必须产生等价 ModelTurnResult');

await assert.rejects(
  () => new streamingModule.StreamingModelTurnAdapter({
    chatWithTools: async () => response(),
    chatStreamWithTools: async () => response({
      toolCalls: [],
      isToolCall: true,
      finishReason: 'tool_calls',
    }),
  }).stream(request),
  /marked as tool call without tool calls/,
  '流式响应不得用空工具数组掩盖 malformed tool payload',
);
await assert.rejects(
  () => collectComplete(response({
    toolCalls: [],
    isToolCall: false,
    finishReason: 'tool_calls',
  })),
  /marked as tool call without tool calls/,
  '完整响应不得用错误的 isToolCall 标志掩盖 malformed tool payload',
);

const abortController = new AbortController();
let completeOptions;
let streamingOptions;
await new completeModule.CompleteModelTurnAdapter({
  chatWithTools: async (_messages, _tools, options) => {
    completeOptions = options;
    return response({ text: '完成' });
  },
  chatStreamWithTools: async () => response(),
}).complete({ ...request, signal: abortController.signal });
await new streamingModule.StreamingModelTurnAdapter({
  chatWithTools: async () => response(),
  chatStreamWithTools: async (_messages, _tools, options) => {
    streamingOptions = options;
    return response({ text: '完成' });
  },
}).stream({ ...request, signal: abortController.signal });
assert.equal(completeOptions.signal, abortController.signal, 'complete 必须透传 cancellation signal');
assert.equal(streamingOptions.signal, abortController.signal, 'stream 必须透传 cancellation signal');
assert.equal(
  completeOptions.allowReasoningLengthRetry,
  false,
  'Agent complete turn 不得启用隐藏 reasoning-length retry',
);

const lateIdTurn = await new streamingModule.StreamingModelTurnAdapter({
  chatWithTools: async () => response(),
  chatStreamWithTools: async (_messages, _tools, options) => {
    await options.onDelta({
      type: 'tool_call_start',
      toolCallId: 'tool_call_0',
      index: 0,
      name: 'search',
    });
    await options.onDelta({
      type: 'tool_call_args_delta',
      toolCallId: 'tool_call_0',
      index: 0,
      argumentsDelta: '{"q":',
    });
    await options.onDelta({
      type: 'tool_call_args_delta',
      toolCallId: 'call-late',
      index: 0,
      argumentsDelta: '"a"}',
    });
    await options.onDelta({
      type: 'tool_call_done',
      toolCallId: 'call-late',
      index: 0,
      name: 'search',
      arguments: '{"q":"a"}',
    });
    return response({
      toolCalls: [toolCall('call-late', 'search', '{"q":"a"}')],
      isToolCall: true,
      finishReason: 'tool_calls',
    });
  },
}).stream(request);
assert.equal(lateIdTurn.toolCalls[0].id, 'call-late', '真实 tool call id 晚到后必须替换占位 id');

const incompleteProvider = {
  chatWithTools: async () => response(),
  chatStreamWithTools: async (_messages, _tools, options) => {
    await options.onDelta({ type: 'tool_call_start', toolCallId: 'call-bad', index: 0, name: 'search' });
    await options.onDelta({
      type: 'tool_call_args_delta',
      toolCallId: 'call-bad',
      index: 0,
      argumentsDelta: '{"q":',
    });
    return response({ toolCalls: [], isToolCall: true, finishReason: 'tool_calls' });
  },
};
await assert.rejects(
  () => new streamingModule.StreamingModelTurnAdapter(incompleteProvider).stream(request),
  /incomplete tool arguments/,
);

await assert.rejects(
  () => collectComplete(response({
    toolCalls: [toolCall('call-malformed', 'search', '{bad')],
    isToolCall: true,
    finishReason: 'tool_calls',
  })),
  /Unexpected token|JSON/,
);

const abortedEvents = [];
const abortError = new Error('aborted');
abortError.name = 'AbortError';
await assert.rejects(
  () => new streamingModule.StreamingModelTurnAdapter({
    chatWithTools: async () => response(),
    chatStreamWithTools: async (_messages, _tools, options) => {
      await options.onDelta({ type: 'answer_delta', text: '未完成' });
      throw abortError;
    },
  }).stream(request, (event) => abortedEvents.push(event)),
  (error) => error === abortError,
);
assert.equal(
  abortedEvents.some((event) => event.type === 'turn_completed'),
  false,
  '中止的流不得产生 completed turn',
);

console.log('Agent Runtime Phase F2 ModelEvent/ModelTurnCollector 验证通过：文本、并列工具、分片参数、晚到名称/id、去重、malformed、无隐藏 retry 与 cancellation。');
