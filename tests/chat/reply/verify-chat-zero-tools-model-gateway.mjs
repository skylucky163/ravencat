import { CHAT_PROMPT_READING_FLOW } from '../../helpers/prompt-reading-flow.mjs';
import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../../helpers/load-typescript-module.mjs';

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
const agentGatewayModule = loadTypeScriptModule(
  'src/platform/ai/agent/AgentModelGateway.ts',
  {
    './CompleteModelTurnAdapter': completeAdapterModule,
    './StreamingModelTurnAdapter': streamingAdapterModule,
  },
);
const timelineEvents = [];
const baseAIClientGatewayModule = loadTypeScriptModule(
  'src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts',
  {
    '@platform/ai': agentGatewayModule,
    '@shared/diagnostics/TurnTimelineLog': {
      logTurnTimeline: (event, context) => timelineEvents.push({ event, context }),
    },
  },
);
const chatGatewayModule = loadTypeScriptModule(
  'src/features/chat/reply/agent/ChatAgentModelGateway.ts',
  {
    '@platform/agentRuntime': baseAIClientGatewayModule,
  },
);

const { ChatAgentModelGateway } = chatGatewayModule;

const tokenEstimator = { ...loadTypeScriptModule('src/shared/prompt/estimateTextTokens.ts'),
  ...loadTypeScriptModule('src/shared/prompt/messageTimestamp.ts') };
const tokenBudget = loadTypeScriptModule('src/host/prompt/tokenBudget.ts', {
  '@shared/prompt': tokenEstimator,
});
const blockMetadata = loadTypeScriptModule('src/host/prompt/compiler/promptBlockMetadata.ts');
const { PromptPackCompiler } = loadTypeScriptModule('src/host/prompt/compiler/PromptPackCompiler.ts', {
    '@shared/prompt': { CHAT_PROMPT_READING_FLOW, ...tokenEstimator },
  '../tokenBudget': tokenBudget,
  './promptBlockMetadata': blockMetadata,
});

function compilePrompt({ autonomous = false, toolsFirst = false, toolsEnabled = true,
  summary = '旧摘要段', time = '本轮时间上下文' } = {}) {
  const scenario = 'chat.private_reply';
  const blocks = [
    { key: 'persona', content: '角色设定' },
    { key: 'tools_description', content: '原工具使用规则' },
    { key: 'persona', definitionId: 'custom.tool_rules', slot: 'capabilities', protection: 'editable', content: '其他固定能力规则' },
    { key: 'conversation_summary', content: summary },
    { key: 'tool_context_explanation', content: '本轮触发原因' },
    { key: 'agent_registry_summary', content: '当前协作状态' },
    { key: 'time_awareness', content: time },
  ].map((block) => ({ ...block, required: false, status: 'ready', placement: 'system' }));
  const preset = {
    id: 'test-tools-position', version: 1, name: '工具位置测试', scenarioId: scenario,
    items: [
      { definitionId: 'persona.assistant', slot: 'persona', sortOrder: 1 },
      { definitionId: 'context.tools_description', slot: 'capabilities', sortOrder: toolsFirst ? 1 : 100, enabled: toolsEnabled },
      { definitionId: 'custom.tool_rules', slot: 'capabilities', sortOrder: 50 },
      { definitionId: 'context.conversation_summary', slot: 'dynamic_context', sortOrder: 160 },
      { definitionId: 'context.tool_explanation', slot: 'capabilities', sortOrder: 70 },
      { definitionId: 'context.agent_registry', slot: 'user_rules', sortOrder: 80 },
      { definitionId: 'context.time_awareness', slot: 'dynamic_context', sortOrder: 1 },
    ].map((item) => ({ enabled: true, required: false, protection: 'locked', ...item })),
  };
  const params = {
    scenario, blocks, preset,
    recentMessages: [{ role: 'assistant', content: '之前的聊天' }],
    currentInput: { role: 'user', content: '测试请求' },
  };
  const compiler = new PromptPackCompiler();
  return compiler.compile(params);
}

function response(messageId, text = '模型回复') {
  return {
    text,
    reasoningText: '',
    finishReason: 'stop',
    messageId,
    promptTokens: 1,
    completionTokens: 1,
    totalTokens: 2,
    success: true,
    error: null,
    toolCalls: null,
    isToolCall: false,
  };
}

function toolDescriptor() {
  return {
    name: 'lookup',
    description: '查询测试工具',
    inputSchema: { type: 'object' },
  };
}

function createClient() {
  const calls = [];
  const client = {
    calls,
    chat: async (messages, options) => {
      calls.push({ method: 'chat', messages, options });
      return response('chat-message');
    },
    chatStream: async (messages, options) => {
      calls.push({ method: 'chatStream', messages, options });
      await options?.onDelta?.({ type: 'answer_delta', text: '模型回复' });
      return response('chat-stream-message');
    },
    chatWithTools: async (messages, tools, options) => {
      calls.push({ method: 'chatWithTools', messages, tools, options });
      return response('tools-message');
    },
    chatStreamWithTools: async (messages, tools, options) => {
      calls.push({ method: 'chatStreamWithTools', messages, tools, options });
      await options?.onDelta?.({ type: 'answer_delta', text: '模型回复' });
      return response('tools-stream-message');
    },
  };
  return client;
}

async function runCase(transport, tools, promptPack = compilePrompt(), history = []) {
  timelineEvents.length = 0;
  const client = createClient();
  const gateway = new ChatAgentModelGateway({
    client,
    initialMessages: promptPack.modelMessages,
    toolInstructionsSlot: promptPack.toolInstructionsSlot,
    diagnosticContext: {
      sessionId: 'session-test',
      runId: 'run-test',
      correlationId: 'correlation-test',
    },
  });
  const controller = new AbortController();
  await gateway.runTurn({
    task: {},
    toolInstructions: { catalog: '固定工具包目录' },
    history,
    tools,
    transport,
    signal: controller.signal,
  });
  return {
    client,
    completed: gateway.takeCompletedTurn(1),
    signal: controller.signal,
    timelineEvents: [...timelineEvents],
    gateway,
  };
}

const cases = [
  { transport: 'complete', tools: [], method: 'chat', messageId: 'chat-message' },
  { transport: 'stream', tools: [], method: 'chatStream', messageId: 'chat-stream-message' },
  { transport: 'complete', tools: [toolDescriptor()], method: 'chatWithTools', messageId: 'tools-message' },
  { transport: 'stream', tools: [toolDescriptor()], method: 'chatStreamWithTools', messageId: 'tools-stream-message' },
];

for (const { transport, tools } of cases) {
  const history = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'view', name: 'view_image', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'view', name: 'view_image', content: '图片观察', images: [{ url: 'data:image/png;base64,AAA' }] },
  ];
  const { client } = await runCase(transport, tools, compilePrompt(), history);
  assert.equal(client.calls[0].options.allowImageContentFallback, false, '工具附图必须真实交付，不能降级后声称看图成功');
}

for (const testCase of cases) {
  const { client, completed, signal, timelineEvents: events } = await runCase(testCase.transport, testCase.tools);
  assert.equal(client.calls.length, 1, `${testCase.transport} + ${testCase.tools.length} tools 只能调用一次 Provider`);
  const call = client.calls[0];
  assert.equal(call.options.allowImageContentFallback, true, '聊天图片拒绝允许带未看图说明的文字回复');
  assert.deepEqual(call.messages, [
    { role: 'system', content: '角色设定\n\n当前协作状态\n\n其他固定能力规则\n\n原工具使用规则\n\n固定工具包目录\n\n旧摘要段' },
    { role: 'assistant', content: '之前的聊天' },
    { role: 'system', content: '本轮触发原因\n\n本轮时间上下文' },
    { role: 'user', content: '测试请求' },
  ], '固定说明、摘要、历史、本轮上下文和当前输入必须按持久性组装');
  assert.equal(call.options.includeSystemPrompt, false, '不得再注入 Client 配置中的旧 system');
  assert.equal(call.method, testCase.method, `${testCase.transport} + ${testCase.tools.length} tools 必须选择 ${testCase.method}`);
  assert.equal(completed.messageId, testCase.messageId);

  if (testCase.tools.length === 0) {
    assert.equal('tools' in call, false, '无工具请求不得携带 tools 参数');
    assert.equal('toolChoice' in call.options, false, '无工具请求不得携带 toolChoice');
  } else {
    assert.equal(call.tools.length, 1, '有工具请求必须透传有效工具定义');
    assert.equal(call.options.toolChoice, 'auto');
  }

  assert.equal(call.options.signal, signal, '请求必须透传同一个 abort signal');
  if (testCase.transport === 'complete') {
    assert.equal(call.options.allowReasoningLengthRetry, false, 'complete 请求不得在 Runtime 之外隐藏重发');
  } else {
    assert.equal(typeof call.options.onDelta, 'function', 'stream 请求必须透传增量回调');
  }
  const expectedEvents = testCase.transport === 'complete'
    ? ['model_request_started']
    : ['model_request_started', 'first_delta_received', 'model_stream_completed'];
  assert.deepEqual(
    events.map(({ event }) => event),
    expectedEvents,
    `${testCase.transport} diagnostics 里程碑必须保持统一顺序`,
  );
  for (const { context } of events) {
    assert.deepEqual(context, {
      sessionId: 'session-test',
      runId: 'run-test',
      correlationId: 'correlation-test',
    }, 'TurnTimeline diagnostics 必须保留窄 context IDs');
  }
}

for (const transport of ['complete', 'stream']) {
  for (const autonomous of [false, true]) {
    const promptPack = compilePrompt({ autonomous, toolsFirst: true });
    const { client, gateway } = await runCase(transport, [toolDescriptor()], promptPack);
    const fixedPrefix = '角色设定\n\n当前协作状态\n\n原工具使用规则\n\n固定工具包目录\n\n其他固定能力规则\n\n旧摘要段';
    assert.equal(client.calls[0].messages[0].content,
      fixedPrefix,
      '目录必须跟随预设中的工具说明排序，自主任务保留完整 system 上下文');
    await gateway.runTurn({
      task: {}, history: [], tools: [toolDescriptor()], transport,
      toolInstructions: { catalog: '固定工具包目录' },
    });
    assert.equal(client.calls[1].messages[0].content,
      fixedPrefix,
      '拆包不重写固定目录和摘要');
    {
      assert.deepEqual(client.calls[1].messages, client.calls[0].messages,
        '工具能力变化不得改写已编译的本轮上下文和当前输入');
    }
    assert.equal(client.calls[1].options.includeSystemPrompt, false);
  }
}

const disabledPrompt = compilePrompt({ toolsEnabled: false });
const { client: disabledClient } = await runCase('complete', [], disabledPrompt);
assert.deepEqual(disabledClient.calls[0].messages, disabledPrompt.modelMessages,
  '未启用工具说明时不能绕过预设追加目录');
assert.equal(disabledClient.calls[0].options.includeSystemPrompt, true);

// 本轮事实变化不能改动长摘要前缀；摘要追加只延长原有正文。
const oldSummaryPrompt = compilePrompt();
const changedContextPrompt = compilePrompt({ time: '更新后的本轮时间' });
assert.equal(changedContextPrompt.systemPrompt, oldSummaryPrompt.systemPrompt,
  '每轮上下文变化不得改变常驻内容与聊天摘要');
const appendedSummaryPrompt = compilePrompt({ summary: '旧摘要段\n新摘要段' });
assert.ok(appendedSummaryPrompt.systemPrompt.startsWith(oldSummaryPrompt.systemPrompt),
  '追加摘要必须保留旧段的完整文本前缀');
assert.deepEqual(appendedSummaryPrompt.recentMessages, oldSummaryPrompt.recentMessages);

// 输入适配只替换末尾输入，编译器固定的本轮状态位置不依赖输入条数或多模态形式。
const { applyRuntimeModelInput } = loadTypeScriptModule('src/features/chat/reply/application/ChatReplyUtils.ts', { '@shared/prompt': tokenEstimator });
for (const inputOptions of [
  { batch: [{ type: 'text', text: '图片问题' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] },
  { inputs: [{ role: 'user', content: '第一条输入' }, { role: 'user', content: '第二条输入' }] },
]) {
  const requestMessages = applyRuntimeModelInput(oldSummaryPrompt.modelMessages, inputOptions.batch, inputOptions.inputs);
  const { client } = await runCase('complete', [], { ...oldSummaryPrompt, modelMessages: requestMessages });
  const expectedInputs = inputOptions.inputs ?? [{ role: 'user', content: inputOptions.batch }];
  assert.deepEqual(client.calls[0].messages.slice(3), expectedInputs, '当前输入必须完整保留在本轮上下文之后');
  assert.equal(client.calls[0].messages[2].content, oldSummaryPrompt.modelMessages[1].content,
    '输入适配后仍使用编译器提供的同一份本轮上下文');
  for (const transport of ['complete', 'stream']) {
    const withTools = await runCase(transport, [toolDescriptor()], { ...oldSummaryPrompt, modelMessages: requestMessages });
    assert.deepEqual(withTools.client.calls[0].messages.slice(3), expectedInputs, '开启工具时也完整保留图片与逐条输入');
    assert.deepEqual(withTools.client.calls[0].tools.map((tool) => tool.function.name), ['lookup'], '多模态请求继续发送已授权 schema');
  }
}

for (const transport of ['complete', 'stream']) {
  const { client, gateway } = await runCase(transport, [toolDescriptor()]);
  const instructions = { catalog: '固定工具包目录' };
  const history = [
    { role: 'assistant', content: '', reasoningText: '本轮原始推理',
      toolCalls: [{ id: 'tool-call-1', name: 'lookup', arguments: '{"query":"第一步"}' }] },
    { role: 'tool', toolCallId: 'tool-call-1', name: 'lookup', content: '第一步真实结果' },
  ];
  await gateway.runTurn({
    task: {}, history, tools: [toolDescriptor()], transport, toolInstructions: instructions,
    toolBudget: { remainingToolCalls: 2, maxToolCallsPerStep: 1, forceFinalResponse: false },
  });
  assert.deepEqual(client.calls[1].messages.slice(0, 4), client.calls[0].messages,
    '追加本轮调用记录时不得改写已有输入');
  assert.equal(client.calls[1].messages[4].reasoning_content, '本轮原始推理');
  assert.equal(client.calls[1].messages[5].tool_call_id, 'tool-call-1');
  assert.equal(client.calls[1].messages.length, 6,
    '正常续轮只追加模型输出和工具结果，不追加递减额度提示');
  await gateway.runTurn({
    task: {}, history: [...history, { role: 'assistant', content: '继续查询', reasoningText: '', toolCalls: [] }],
    tools: [toolDescriptor()], transport, toolInstructions: instructions,
    toolBudget: { remainingToolCalls: 1, maxToolCallsPerStep: 1, forceFinalResponse: false },
    completionContinuationInstruction: '完成前的补充指令',
  });
  assert.deepEqual(client.calls[2].messages.slice(0, client.calls[1].messages.length), client.calls[1].messages,
    '额度变化后仍保留上一请求的完整消息前缀');
  assert.equal(client.calls[2].messages[6].content, '继续查询');
  assert.equal(client.calls[2].messages[7].content, '完成前的补充指令');
  assert.equal(client.calls[2].messages.length, 8,
    '完成前补充阶段只追加明确的补充指令');
}

// 验证真实 Client 发出的请求，避免只验证网关向 Client 传参而漏掉重复 system。
const { BaseAIClient } = loadTypeScriptModule('src/platform/ai/BaseAIClient.ts', {
  './OpenAIMessageDecoder': loadTypeScriptModule('src/platform/ai/OpenAIMessageDecoder.ts'), './reasoning': loadTypeScriptModule('src/platform/ai/reasoning.ts'),
  './HttpExchangeCapture': { beginAIHttpCapture: async () => null },
  './errorMapping': loadTypeScriptModule('src/platform/ai/errorMapping.ts'),
  './baseUrl': loadTypeScriptModule('src/platform/ai/baseUrl.ts'),
});
const originalFetch = globalThis.fetch;
const originalXHR = globalThis.XMLHttpRequest;
// Android 使用 XHR；这里仍只模拟网络，把增量交给真实客户端解析。
class ModelXHR {
  responseText = '';
  open(_method, url) { this.url = url; }
  setRequestHeader() {}
  async send(body) {
    const response = await globalThis.fetch(this.url, { body });
    this.status = response.status;
    const text = await response.text();
    for (let index = 0; index < text.length; index += 7) {
      this.responseText += text.slice(index, index + 7);
      this.onprogress();
    }
    this.onload();
  }
}
const requestBodies = [];
const queuedResponses = [];
globalThis.fetch = async (_url, options) => {
  requestBodies.push(JSON.parse(options.body));
  const next = queuedResponses.shift() ?? {
    ok: true,
    data: { id: 'provider-message', choices: [{ finish_reason: 'stop', message: { content: '真实回复' } }] },
  };
  return Response.json(next.data, { status: next.ok ? 200 : 400 });
};
try {
  const promptPack = compilePrompt();
  const client = new BaseAIClient({
    baseURL: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model', maxTokens: 256,
    systemPrompt: promptPack.systemPrompt,
  });
  const gateway = new ChatAgentModelGateway({
    client, initialMessages: promptPack.modelMessages, toolInstructionsSlot: promptPack.toolInstructionsSlot,
    diagnosticContext: { sessionId: 'session-test', runId: 'run-test' },
  });
  await gateway.runTurn({
    task: {}, history: [], tools: [toolDescriptor()], transport: 'complete',
    toolInstructions: { catalog: '真实目录' },
  });
  assert.deepEqual(requestBodies[0].messages, [
    { role: 'system', content: '角色设定\n\n当前协作状态\n\n其他固定能力规则\n\n原工具使用规则\n\n真实目录\n\n旧摘要段' },
    { role: 'assistant', content: '之前的聊天' },
    { role: 'system', content: '本轮触发原因\n\n本轮时间上下文' },
    { role: 'user', content: '测试请求' },
  ], '真实非流式带工具请求必须只含一份前置 system');

  const tools = requestBodies[0].tools;
  const explicitMessages = [{ role: 'system', content: '显式 system' }, { role: 'user', content: '测试' }];
  // Runtime 的一次模型回合不能在客户端内丢弃已计费的思考并重新生成。
  for (const exposedTools of [[], [toolDescriptor()]]) {
    const start = requestBodies.length;
    queuedResponses.push({ ok: true, data: { choices: [{ finish_reason: 'length',
      message: { content: '', reasoning_content: '输出额度内只有思考' } }] } });
    const limitedGateway = new ChatAgentModelGateway({ client, initialMessages: explicitMessages,
      diagnosticContext: { sessionId: 'limited', runId: `limited-${exposedTools.length}` } });
    const turn = await limitedGateway.runTurn({ task: {}, history: [], tools: exposedTools, transport: 'complete' });
    assert.equal(requestBodies.length, start + 1, '思考耗尽输出额度时一次模型回合只能发送一次 HTTP 请求');
    assert.equal(turn.finishReason, 'length', '截断事实应交回 Runtime，不能被第二次生成覆盖');
    assert.equal(turn.reasoningText, '输出额度内只有思考');
    assert.equal(turn.assistantText, '');
  }
  for (const retryResponse of [
    { ok: true, data: { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '尚未完成' } }] } },
  ]) {
    const start = requestBodies.length;
    queuedResponses.push(retryResponse);
    const result = await client.chatWithTools(explicitMessages, tools, { includeSystemPrompt: false });
    assert.equal(result.success, true);
    assert.equal(requestBodies.length, start + 2, '失败请求应通过既有重试完成');
    for (const body of requestBodies.slice(start)) {
      assert.deepEqual(body.messages, explicitMessages, '重试不得重新注入旧 system');
    }
  }
  await client.chatWithTools(explicitMessages.slice(1), tools);
  assert.deepEqual(requestBodies.at(-1).messages, [
    { role: 'system', content: promptPack.systemPrompt }, ...explicitMessages.slice(1),
  ], '省略选项时保持原有默认 system 注入契约');
  for (const field of ['reasoning_content', 'reasoning']) {
    const originalReasoning = '  群成员的思考\r\n\u0000';
    queuedResponses.push({ ok: true, data: { choices: [{ finish_reason: 'stop', message: { content: '群成员回复', [field]: originalReasoning } }] } });
    const response = await client.chat([{ role: 'user', content: '群聊输入' }]);
    assert.equal(response.reasoningText, originalReasoning, '协议思考不得按正文清洗空白、换行或字符');
    assert.equal(response.text, '群成员回复');
  }

  // 账本／日程没有新 user 输入；首次带工具请求也会携带旧 assistant 正文。
  // 按 DeepSeek 的实际错误校验 wire body，不能靠“遇到 missing 才重试”通过。
  const deepseekBodies = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    deepseekBodies.push(body);
    const requiresReasoning = new URL(_url).hostname === 'api.deepseek.com'
      && body.tools?.length > 0 && body.thinking?.type !== 'disabled';
    if (requiresReasoning && body.messages.some(message => message.role === 'assistant'
      && typeof message.reasoning_content !== 'string')) {
      return new Response(JSON.stringify({ error: {
        message: 'The `reasoning_content` in the thinking mode must be passed back to the API.',
      } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = { id: 'deepseek-reply', choices: [{ finish_reason: 'stop', message: {
      content: '账目记好了', reasoning_content: '本次真实思考',
    } }] };
    return body.stream
      ? new Response(`data: ${JSON.stringify({ id: answer.id, choices: [{ delta: answer.choices[0].message, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } })
      : new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json' } });
  };
  const applicationMessages = [
    { role: 'user', content: '以前的聊天' },
    { role: 'assistant', content: '以前的回复' },
    { role: 'assistant', content: '已有思考的回复', reasoning_content: '  原有完整思考\n' },
    { role: 'system', content: '本轮由账本触发：午饭支出 20 元，没有用户新发言。' },
  ];
  const originalMessages = structuredClone(applicationMessages);
  for (const transport of ['complete', 'stream']) {
    const deepseekClient = new BaseAIClient({ baseURL: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-flash' });
    const deepseekGateway = new ChatAgentModelGateway({ client: deepseekClient, initialMessages: applicationMessages,
      diagnosticContext: { sessionId: 'ledger', runId: `ledger-${transport}` } });
    const before = deepseekBodies.length;
    await deepseekGateway.runTurn({ task: {}, history: [], tools: [toolDescriptor()], transport });
    assert.equal(deepseekBodies.length, before + 1, '首次请求满足协议，不先发错误请求再重试');
    const first = deepseekBodies.at(-1);
    assert.equal(first.messages[1].reasoning_content, '', '纯历史正文没有协议思考记录，明确传空串');
    assert.equal(first.messages[2].reasoning_content, '  原有完整思考\n', '已有真实思考原样保留');
    assert.equal(first.messages.at(-1).role, 'system', '不靠伪造 user 输入绕过服务商检查');
    const reasoning = '  本轮工具调用的真实思考\n';
    await deepseekGateway.runTurn({ task: {}, history: [
      { role: 'assistant', content: '', reasoningText: reasoning,
        toolCalls: [{ id: 'ledger-tool', name: 'lookup', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'ledger-tool', name: 'lookup', content: '账目详情' },
    ], tools: [toolDescriptor()], transport });
    assert.equal(deepseekBodies.at(-1).messages[4].reasoning_content, reasoning, '真实工具续轮回传模型原始思考');
    assert.deepEqual(applicationMessages, originalMessages, '协议适配不回写或污染业务历史');
  }
  const disabledThinkingClient = new BaseAIClient({ baseURL: 'https://api.deepseek.com/v1', apiKey: 'test-key',
    model: 'deepseek-flash', disableThinking: true });
  await disabledThinkingClient.chatWithTools(applicationMessages, tools);
  assert.equal(Object.hasOwn(deepseekBodies.at(-1).messages[1], 'reasoning_content'), false, '关闭思考时不添加该协议字段');
  const deepseekNoToolsClient = new BaseAIClient({ baseURL: 'https://api.deepseek.com/v1', apiKey: 'test-key', model: 'deepseek-flash' });
  await deepseekNoToolsClient.chat(applicationMessages);
  assert.equal(Object.hasOwn(deepseekBodies.at(-1).messages[1], 'reasoning_content'), false, '无工具请求不要求历史思考字段');

  const otherProviderClient = new BaseAIClient({ baseURL: 'https://relay.example/v1', apiKey: 'test-key', model: 'another-model' });
  await otherProviderClient.chatWithTools(applicationMessages, tools);
  assert.equal(Object.hasOwn(deepseekBodies.at(-1).messages[1], 'reasoning_content'), false, '不改变其他接口的历史协议');
  const missingToolReasoning = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'incomplete', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', content: '结果', tool_call_id: 'incomplete' },
  ];
  const beforeInvalid = deepseekBodies.length;
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const rejected = await deepseekNoToolsClient.chatWithTools(missingToolReasoning, tools);
    assert.equal(rejected.success, false, '真实工具轮缺少思考时直接暴露错误，不用空记录掩盖');
    assert.equal(deepseekBodies.length, beforeInvalid + 1);
    assert.equal(Object.hasOwn(deepseekBodies.at(-1).messages[0], 'reasoning_content'), false);
  } finally { console.warn = previousWarn; }

  // 协议错误保持一次请求失败；四种传输入口都不得根据文案补字段重试。
  const savedWarn = console.warn;
  console.warn = () => {};
  try {
    for (const baseURL of ['https://api.deepseek.com/v1', 'https://relay.example/v1']) {
      const rejectedBodies = [];
      globalThis.fetch = async (_url, options) => {
        rejectedBodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ error: { message: 'reasoning_content missing' } }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      };
      const rejectedClient = new BaseAIClient({ baseURL, apiKey: 'test-key', model: 'test-model' });
      for (const method of ['chat', 'chatStream', 'chatWithTools', 'chatStreamWithTools']) {
        const before = rejectedBodies.length;
        const rejected = method.includes('WithTools')
          ? await rejectedClient[method](missingToolReasoning, tools)
          : await rejectedClient[method](missingToolReasoning);
        assert.equal(rejected.success, false);
        assert.match(rejected.error, /reasoning_content missing/, '保留服务端原因，不锁定 HTTP 错误的展示包装');
        assert.equal(rejectedBodies.length, before + 1, `${method} 协议错误不隐藏重试`);
        assert.equal(Object.hasOwn(rejectedBodies.at(-1).messages[0], 'reasoning_content'), false,
          '缺失的真实工具思考不补空或空格');
      }
    }
  } finally { console.warn = savedWarn; }

  // 真实响应经过 Client → Collector → Runtime history → Client 后，思考仍逐字一致。
  for (const baseURL of ['https://api.deepseek.com/v1', 'https://api.moonshot.ai/v1', 'https://open.bigmodel.cn/api/paas/v4']) {
    for (const wireTransport of ['complete', 'stream', 'xhr-stream']) {
      const transport = wireTransport === 'complete' ? 'complete' : 'stream';
      globalThis.XMLHttpRequest = wireTransport === 'xhr-stream' ? ModelXHR : undefined;
      for (const reasoning of ['  原始工具思考\r\n\u0000', '']) {
        const bodies = [];
        globalThis.fetch = async (_url, options) => {
          const body = JSON.parse(options.body);
          bodies.push(body);
          const continuing = body.messages.some(message => message.role === 'tool');
          const message = continuing ? { content: '最终回复' } : {
            content: '', reasoning_content: reasoning,
            tool_calls: [{ id: 'original-tool', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
          };
          const finish_reason = continuing ? 'stop' : 'tool_calls';
          return body.stream
            ? new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason }] })}\n\ndata: [DONE]\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } })
            : new Response(JSON.stringify({ choices: [{ message, finish_reason }] }),
              { headers: { 'Content-Type': 'application/json' } });
        };
        const originalClient = new BaseAIClient({ baseURL, apiKey: 'test-key', model: 'test-model' });
        const originalGateway = new ChatAgentModelGateway({ client: originalClient, initialMessages: explicitMessages,
          diagnosticContext: { sessionId: 'reasoning', runId: `${transport}-roundtrip` } });
        const turn = await originalGateway.runTurn({ task: {}, history: [], tools: [toolDescriptor()], transport });
        assert.equal(turn.reasoningText, reasoning, `${transport} 保留原始思考响应`);
        await originalGateway.runTurn({ task: {}, history: [
          { role: 'assistant', content: turn.assistantText, reasoningText: turn.reasoningText, toolCalls: turn.toolCalls },
          { role: 'tool', toolCallId: 'original-tool', name: 'lookup', content: '查询结果' },
        ], tools: [toolDescriptor()], transport });
        assert.equal(bodies.length, 2, '工具调用和续轮各发送一次');
        assert.equal(bodies[1].messages.find(message => message.tool_calls?.length).reasoning_content, reasoning,
          `${transport} 续轮发送服务商返回的原始思考`);
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXHR;
}

console.log('Chat model gateway 验证通过：固定目录与上下文、完整消息前缀保留、真实调用记录追加及 Client 单份 system。');
