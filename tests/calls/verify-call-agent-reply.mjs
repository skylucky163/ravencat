/** 用真实 Agent 循环验证通话多轮工具、语音正文、观察附图与取消；只替代 IO 边界。 */
import { repoRoot as root } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { agentToolSchemaDependencies } from '../helpers/agent-tool-schema-dependencies.mjs';


const cache = new Map();
const boundaries = { ...agentToolSchemaDependencies };
boundaries['../CallHistory'] = { async saveCallHistoryAudio() {}, async saveCallHistorySnapshot() {} };
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const module = { exports: {} };
  cache.set(relative, module.exports);
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relative,
  }).outputText;
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (Object.hasOwn(boundaries, name)) return boundaries[name];
    if (name.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${name}.ts`)));
    assert.fail(`未装配的边界：${relative} -> ${name}`);
  }, module, module.exports);
  return module.exports;
}
boundaries['@shared/aiTools'] = {
  ...load('src/shared/aiTools/ToolContext.ts'),
  ...load('src/shared/aiTools/AgentToolInputSchema.ts'),
};
boundaries['@shared/runtime/abortSignal'] = load('src/shared/runtime/abortSignal.ts');
boundaries['@shared/runtime/RuntimeSlot'] = load('src/shared/runtime/RuntimeSlot.ts');
boundaries['@shared/diagnostics/TurnTimelineLog'] = { logTurnTimeline() {} };
boundaries['@shared/prompt'] = { DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT: 30 };
const speech = load('src/features/speech/application/SpeechText.ts');
boundaries['@features/speech'] = { ...speech, resolveTextToSpeechModel: async () => null };
let client;
boundaries['@platform/ai'] = {
  ...load('src/platform/ai/agent/AgentModelGateway.ts'),
  createAIClient: () => client,
  ...load('src/platform/ai/errorMapping.ts'),
};
boundaries['@platform/agentRuntime'] = load('src/platform/agentRuntime/index.ts');
const { AgentRuntime, AgentToolRegistry } = boundaries['@platform/agentRuntime'];
const { LegacyAgentToolAdapter } = load('src/host/composition/agent/LegacyAgentToolAdapter.ts');
const { configureCallRuntimeDependencies } = load('src/features/calls/application/runtime/CallRuntimeDependencies.ts');
const { processCallAIReply } = load('src/features/calls/application/runtime/ProcessCallAIReply.ts');
const aiConfig = { id: 'ai', agentId: 'agent', name: 'AI', model: 'model', enableTools: true };
let events, requests, executed, spoken, toolStates, registry, controller, prepareParams, call;
function response(text, calls = []) {
  return { success: true, text, reasoningText: '不应朗读的思考', finishReason: calls.length ? 'tool_calls' : 'stop',
    toolCalls: calls, isToolCall: calls.length > 0, promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}
function toolCall(id, name, input = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}
function tool(name, execute) {
  return { descriptor: { name, description: name, owner: 'test', source: 'local', risk: 'safe_read',
    idempotency: 'idempotent', inputSchema: { type: 'object' } }, execute };
}
function reset(turns, names = ['lookup']) {
  events = []; requests = []; executed = []; spoken = []; toolStates = [];
  registry = new AgentToolRegistry(); controller = new AbortController();
  call = { id: 'call', state: 'active', chatSessionId: 'chat', aiAssistantId: 'ai', agentId: 'agent' };
  let index = 0;
  const stream = async (messages, tools, options) => {
    requests.push({ messages, tools });
    const turn = turns[index++];
    assert.ok(turn, '不得意外请求额外模型回合');
    if (turn.before) await turn.before();
    if (turn.error) throw turn.error;
    await options.onDelta({ type: 'reasoning_delta', text: '不应朗读的思考' });
    for (const text of turn.chunks ?? [turn.result.text]) {
      if (text) await options.onDelta({ type: 'answer_delta', text });
    }
    return turn.result;
  };
  client = { chatStreamWithTools: stream, chatStream: (messages, options) => stream(messages, [], options) };
  configureCallRuntimeDependencies({
    repositories: { calls: {
      getSessionById: async () => call,
      async appendEvent(input) { const event = { id: `event-${events.length}`, ...input }; events.push(event); return event; },
    } },
    assembleChatPromptPack: async params => {
      prepareParams = params;
      return { systemPrompt: '口语模式', modelMessages: [{ role: 'user', content: params.currentInput }] };
    },
    agent: {
      prepareTools: async config => ({ allowedToolNames: config.enableTools ? names : [], toolsDescription: '已授权工具',
        mcpServices: [], additionalPromptBlocks: [] }),
      run: request => new AgentRuntime({ registry, modelGateway: request.modelGateway }).run(request),
    },
  });
  registry.register(tool('lookup', async (_input, context) => {
    executed.push(context.toolCallId);
    return { status: 'success', data: {}, modelContent: '真实查询结果' };
  }));
}
const run = (overrides = {}) => processCallAIReply({ callId: 'call', runId: 'run', userText: '帮我查一下', aiConfig,
  signal: controller.signal, onSpeechSentence: text => spoken.push(text),
  onToolExecutionChanged: active => toolStates.push(active), ...overrides });

reset([
  { result: response('我查一下', [toolCall('first', 'lookup')]) },
  { chunks: ['还需要'], result: response('还需要再查一项。', [toolCall('second', 'lookup')]) },
  { chunks: ['查到', '了。'], result: response('查到了。') },
]);
let committedInputs = 0;
const multiRound = await run({ onUserTextCommitted() {
  committedInputs++;
  assert.equal(events.at(-1).kind, 'userSpeechText');
  assert.equal(requests.length, 0, '用户事实先提交，草稿交接不依赖模型请求');
} });
assert.equal(committedInputs, 1);
assert.equal(multiRound.status, 'completed', JSON.stringify(multiRound));
assert.deepEqual(executed, ['first', 'second']);
assert.deepEqual(spoken, ['我查一下', '还需要再查一项。', '查到了。'], '所有模型回合都朗读，完整响应补尾且不重复 delta');
assert.deepEqual(toolStates, [true, false, true, false]);
assert.equal(events.filter(event => event.kind === 'aiSpeechText').length, 1);
assert.equal(events.at(-1).text, spoken.join('\n'));
assert.equal(requests[2].messages.filter(message => message.role === 'tool').length, 2);
assert.deepEqual(prepareParams.allowedToolNames, ['lookup']);

reset([{ result: response('继续', [toolCall('bad', 'lookup')]) }, { result: response('查询失败了。') }]);
registry = new AgentToolRegistry();
registry.register(tool('lookup', async () => ({ status: 'error', code: 'UNAVAILABLE', retryable: false, modelContent: '查询不可用' })));
assert.equal((await run()).status, 'completed');
assert.equal(requests[1].messages.find(message => message.role === 'tool').content, '查询不可用');

reset([{ result: response('普通通话回复。') }]);
assert.equal((await run({ aiConfig: { ...aiConfig, enableTools: false } })).status, 'completed');
assert.deepEqual(requests[0].tools, []);

reset([{ result: response('', [toolCall('unauthorized', 'not_allowed')]) }]);
assert.equal((await run()).status, 'failed');
assert.deepEqual(executed, [], '未授权工具不得执行');
assert.equal(events.some(event => event.kind === 'aiSpeechText'), false);

reset([{ result: response('', [toolCall('cancel', 'lookup')]) }]);
registry = new AgentToolRegistry();
registry.register(tool('lookup', async () => { controller.abort(); return { status: 'success', data: {}, modelContent: '迟到结果' }; }));
assert.equal((await run()).status, 'cancelled');
assert.equal(requests.length, 1, '取消后不得续轮');
assert.equal(events.some(event => event.kind === 'aiSpeechText' || event.kind === 'error'), false);

reset([{ result: response('再见。'), before: async () => { call.state = 'ended'; } }]);
assert.equal((await run()).status, 'cancelled', '挂断后不得提交晚到的整轮正文');
assert.equal(events.some(event => event.kind === 'aiSpeechText'), false);

reset([{ result: response('先查一下', [toolCall('end-check', 'lookup')]) }, { result: response('[[END_CALL]]晚安。') }]);
const ended = await run();
assert.equal(ended.callEnded, true, '模型续轮仍识别结束标记');
assert.deepEqual(spoken, ['先查一下', '晚安。']);

// 挂断是 Calls 控制信号，出现在告别语之后也不能泄漏到 Speech 的标签校验。
for (const text of ['[[END_CALL]]晚安。', '晚安。[[END_CALL]]', '好，[[END_CALL]]晚安。']) {
  for (const chunks of [[text], [...text], []]) {
    reset([{ chunks, result: response(text) }]);
    const reply = await run();
    assert.equal(reply.status, 'completed', JSON.stringify(reply));
    assert.equal(reply.callEnded, true);
    assert.equal(reply.text, text.replace('[[END_CALL]]', ''));
    assert.equal(spoken.join(''), reply.text);
    assert.equal(events.some(event => event.kind === 'error'), false);
  }
}

reset([{ result: response('晚安。[[END_CALL]]') }]);
assert.equal((await run({ aiConfig: { ...aiConfig, enableTools: false } })).callEnded, true);
assert.deepEqual(requests[0].tools, [], '挂断信号不依赖工具开关');
assert.deepEqual(spoken, ['晚安。']);
// 网络/Provider 失败与模型输出不适合通话分别保留原因。
for (const [turn, expected] of [
  [{ result: { ...response(''), success: false, error: 'HTTP 429: code=1302，请求并发数超限' }, chunks: [] }, /HTTP 429.*1302/],
  [{ error: new Error('Network request failed: connection reset') }, /connection reset/],
  [{ result: { ...response(''), finishReason: 'length' } }, /耗尽输出额度/],
  [{ result: { ...response(''), finishReason: 'content_filter' } }, /内容审核.*content_filter/],
  [{ result: response('') }, /没有返回可朗读正文/],
]) {
  reset([turn]);
  const failure = await run();
  assert.equal(failure.status, 'failed');
  assert.match(failure.errorMessage, expected);
  assert.ok(failure.errorMessage.includes(aiConfig.model));
  assert.doesNotMatch(failure.errorMessage, /模型服务暂时无法完成回复|RUNTIME_UNAVAILABLE/);
  assert.equal(events.at(-1).text, failure.errorMessage, '通话事实保留与页面相同的具体错误');
  assert.equal(requests.length, 1, '报错不得暗中重试模型');
}

// 语音诊断允许调整措辞；这里保护解析阶段、具体失败输入及事实交付，不锁定解释文案。
reset([{ result: response('晚安。[invalid_voice_tag]') }]);
const invalidSpeech = await run();
assert.equal(invalidSpeech.status, 'failed');
assert.ok(events.includes(invalidSpeech.userEvent), '解析失败仍保留已提交的用户输入');
assert.ok(invalidSpeech.errorMessage.includes('[invalid_voice_tag]'), '诊断应保留具体无效标记');
const speechErrors = events.filter(event => event.kind === 'error');
assert.equal(speechErrors.length, 1);
assert.equal(speechErrors[0].text, invalidSpeech.errorMessage, '页面与持久错误事实使用相同原因');
assert.deepEqual(JSON.parse(speechErrors[0].payloadJson), {
  type: 'replyFailure', stage: '回复语音文本解析', model: aiConfig.model, runId: 'run',
});
assert.equal(events.some(event => event.kind === 'aiSpeechText'), false, '解析失败不能提交成功的 AI 正文');
assert.equal(requests.length, 1, '解析失败不得暗中重试模型');

// lookAtUser 本身负责把本次快照转成观察，不再从历史中猜测“最新”图片。
let imageRoute = 'direct_vision';
let failImage = false;
let snapshotStatus = 'captured';
const discarded = [];
boundaries['@platform/device'] = { createRandomUUID: () => 'test',
  getPersistentMediaCategoryPrefix: () => 'calls/', PERSISTENT_MEDIA_CATEGORY: { callSnapshot: 'snapshot' },
  persistentMediaStore: { deleteCategoryFileIfExists: async () => {} } };
const snapshots = load('src/features/calls/application/snapshots/CallSnapshotProviderRegistry.ts');
snapshots.registerCallSnapshotProvider('call', async () => snapshotStatus === 'captured'
  ? { status: 'captured', result: { attachment: { id: 'frame', localUri: 'file:///frame', mimeType: 'image/jpeg' }, event: { id: 'snapshot' } } }
  : { status: snapshotStatus, message: '摄像头未开启' });
const { LookAtUserTool } = load('src/features/calls/aiTools/LookAtUserTool.ts');
function setupVision() {
  configureCallRuntimeDependencies({ repositories: { calls: {
    getSessionById: async () => call,
    appendEvent: async input => { events.push(input); return input; },
    listSnapshotFiles: async () => [{ id: 'frame', uri: 'file:///frame' }],
    clearSnapshotFile: async id => { discarded.push(id); },
  } }, resolveImageModelInput: async input => {
    assert.equal(input.imageUri, 'file:///frame');
    assert.ok(input.signal);
    if (failImage) throw new Error('读取图片失败');
    return { route: imageRoute, ocrSucceeded: true, parts: imageRoute === 'direct_vision'
      ? [{ type: 'text', text: '当前画面' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,frame' } }]
      : [{ type: 'text', text: '可靠 OCR 文字' }] };
  } });
}
reset([
  { result: response('', [toolCall('vision', 'lookAtUser', {})]) },
  { result: response('看到了。') },
], ['lookAtUser']);
const previousDependencies = load('src/features/calls/application/runtime/CallRuntimeDependencies.ts').getCallRuntimeDependencies();
setupVision();
const visionDependencies = load('src/features/calls/application/runtime/CallRuntimeDependencies.ts').getCallRuntimeDependencies();
configureCallRuntimeDependencies({ ...previousDependencies, ...visionDependencies, agent: previousDependencies.agent,
  assembleChatPromptPack: previousDependencies.assembleChatPromptPack });
registry.register(new LegacyAgentToolAdapter(LookAtUserTool, { owner: 'calls', risk: 'sensitive_action', idempotency: 'not_idempotent' },
  execution => new boundaries['@shared/aiTools'].ToolContext({ aiConfig, sessionId: 'chat', relatedEntityType: 'call', relatedEntityId: 'call',
    repositories: {}, abortSignal: execution.abortSignal })));
assert.equal((await run()).status, 'completed');
assert.ok(requests[1].messages.some(message => Array.isArray(message.content)
  && message.content.some(part => part.type === 'image_url')), '真实附图进入同一 Agent 模型续轮');
assert.deepEqual(discarded, ['frame']);

setupVision();
const context = new boundaries['@shared/aiTools'].ToolContext({ aiConfig, sessionId: 'chat', relatedEntityType: 'call', relatedEntityId: 'call',
  repositories: {}, abortSignal: controller.signal });
imageRoute = 'ocr';
assert.match((await LookAtUserTool.execute({}, context)).message, /可靠 OCR/);
assert.ok(events.some(event => event.kind === 'ocrText' && event.attachmentId === 'frame'));
failImage = true;
await assert.rejects(LookAtUserTool.execute({}, context), /读取图片失败/);
assert.equal(discarded.length, 3, '读取失败同样清理本次快照');
snapshotStatus = 'camera_disabled';
assert.equal((await LookAtUserTool.execute({}, context)).data.status, 'camera_disabled');
assert.equal(discarded.length, 3, '相机关闭不提供或清理历史帧');
console.log('通话 Agent 行为检查通过：多轮工具、失败观察、禁用与授权、逐句语音、取消、挂断、续轮结束标记及图片/OCR 清理。');
