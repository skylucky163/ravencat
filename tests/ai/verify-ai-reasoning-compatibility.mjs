/** 验证外部协议分类、原文诊断与本次工具续轮，不依赖真实模型或用户密钥。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule as load } from '../helpers/load-typescript-module.mjs';

const records = [];
const capture = load('src/platform/ai/HttpExchangeCapture.ts', { './HttpExchangeDiagnostics': { aiHttpDiagnostics: {
  beginCapture: async () => 1,
  record: async record => { records.push(record); },
} } });
const { BaseAIClient } = load('src/platform/ai/BaseAIClient.ts', {
  './OpenAIMessageDecoder': load('src/platform/ai/OpenAIMessageDecoder.ts'),
  './reasoning': load('src/platform/ai/reasoning.ts'),
  './baseUrl': load('src/platform/ai/baseUrl.ts'),
  './errorMapping': load('src/platform/ai/errorMapping.ts'),
  './HttpExchangeCapture': capture,
});
const collector = load('src/platform/ai/agent/ModelTurnCollector.ts');
const complete = load('src/platform/ai/agent/CompleteModelTurnAdapter.ts', { './ModelTurnCollector': collector });
const stream = load('src/platform/ai/agent/StreamingModelTurnAdapter.ts', {
  './ModelTurnCollector': collector, './CompleteModelTurnAdapter': complete,
});
const { AgentModelGateway } = load('src/platform/ai/agent/AgentModelGateway.ts', {
  './CompleteModelTurnAdapter': complete, './StreamingModelTurnAdapter': stream,
});
const { buildAgentModelMessages } = load('src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts', {
  '@platform/ai': { AgentModelGateway }, '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline() {} },
});
const original = { fetch: globalThis.fetch, xhr: globalThis.XMLHttpRequest };
const messages = [{ role: 'user', content: '协议夹具' }];
const tools = [{ type: 'function', function: { name: 'inspect', description: '夹具', parameters: { type: 'object', properties: {} } } }];
const tool = { id: 'fixture-tool', type: 'function', function: { name: 'inspect', arguments: '{}' } };
const text = content => ({ content });
const native = reasoning_content => ({ reasoning_content });
const thinking = value => ({ type: 'thinking', thinking: [{ type: 'text', text: value }] });
const detail = value => ({ reasoning_details: value });
const plain = value => ({ type: 'text', text: value });
const details = [
  { index: 0, type: 'reasoning.text', text: '思考', signature: 'sign-ab', id: 'r1', format: 'anthropic-claude-v1' },
  { index: 1, type: 'reasoning.encrypted', data: 'secret-ab', id: 'r2', unknown: { retained: true } },
  { index: 2, type: 'future.reasoning', data: 'opaque', signature: 'opaque-signature', extension: [1, 2] },
];
const samples = [
  { name: '原生思考原文', deltas: [native('  思考\r\n\u0000'), text('答复')], message: { reasoning_content: '  思考\r\n\u0000', content: '答复' }, answer: '答复', reasoning: '  思考\r\n\u0000' },
  { name: 'reasoning 别名', deltas: [{ reasoning: '推理' }, text('答复')], message: { reasoning: '推理', content: '答复' }, answer: '答复', reasoning: '推理' },
  { name: '无标记英语保留', deltas: [text('Checking native thought channel. '), text('Pure English internal thoughts...')], message: { content: 'Checking native thought channel. Pure English internal thoughts...' }, answer: 'Checking native thought channel. Pure English internal thoughts...', reasoning: '' },
  { name: '完整标签', deltas: [text('<think>思考</think>答复')], message: { content: '<think>思考</think>答复' }, answer: '答复', reasoning: '思考' },
  { name: '跨 delta 标签', deltas: ['<th', 'ink>思', '考</th', 'ink>答复'].map(text), message: { content: '<think>思考</think>答复' }, answer: '答复', reasoning: '思考' },
  { name: '未闭合标签', deltas: ['<think>', '思考</thi'].map(text), message: { content: '<think>思考</thi' }, answer: '', reasoning: '思考</thi' },
  { name: '只有半个开标签', deltas: ['<', 'thi'].map(text), message: { content: '<thi' }, answer: '<thi', reasoning: '' },
  { name: '空标签', deltas: ['<think>', '</think>答复'].map(text), message: { content: '<think></think>答复' }, answer: '答复', reasoning: '' },
  { name: '普通正文中的标签', deltas: ['先解释 ', '<think>例子</think>'].map(text), message: { content: '先解释 <think>例子</think>' }, answer: '先解释 <think>例子</think>', reasoning: '' },
  { name: '代码围栏', deltas: ['```xml\n<think>', '例子</think>\n```'].map(text), message: { content: '```xml\n<think>例子</think>\n```' }, answer: '```xml\n<think>例子</think>\n```', reasoning: '' },
  { name: '行内代码', deltas: ['`<think>', '例子</think>`'].map(text), message: { content: '`<think>例子</think>`' }, answer: '`<think>例子</think>`', reasoning: '' },
  { name: '缩进代码', deltas: ['    <think>', '例子</think>'].map(text), message: { content: '    <think>例子</think>' }, answer: '    <think>例子</think>', reasoning: '', completeAnswer: '<think>例子</think>' },
  { name: '未知模型不套标签', config: { model: 'gemini-4-c' }, deltas: [text('<think>例子</think>答复')], message: { content: '<think>例子</think>答复' }, answer: '<think>例子</think>答复', reasoning: '' },
  { name: '显式标签协议', config: { model: 'private-model', thinkTagMode: 'leading' }, deltas: [text('<think>思考</think>答复')], message: { content: '<think>思考</think>答复' }, answer: '答复', reasoning: '思考' },
  { name: '显式关闭提取', config: { thinkTagMode: 'off' }, deltas: [text('<think>例子</think>')], message: { content: '<think>例子</think>' }, answer: '<think>例子</think>', reasoning: '' },
  { name: '原生与镜像标签不重复', deltas: [{ reasoning_content: '真实思考', content: '<think>镜像思考</think>答复' }], message: { reasoning_content: '真实思考', content: '<think>镜像思考</think>答复' }, answer: '答复', reasoning: '真实思考' },
  { name: '迟到原生镜像不重复', deltas: [text('<think>思考'), native('思考'), text('</think>答复')], message: { reasoning_content: '思考', content: '<think>思考</think>答复' }, answer: '答复', reasoning: '思考' },
  { name: 'TAG_A 先到而 NATIVE_B 晚到', deltas: [text('<think>TAG_A'), native('NATIVE_B'), text('</think>答复')], message: { reasoning_content: 'NATIVE_B', content: '<think>TAG_A</think>答复' }, answer: '答复', reasoning: 'NATIVE_B', streamReasoning: 'TAG_A' },
  { name: 'DETAIL_A 先到而 NATIVE_B 晚到', deltas: [detail([{ index: 0, type: 'reasoning.text', text: 'DETAIL_A' }]), native('NATIVE_B'), text('答复')], message: { reasoning_content: 'NATIVE_B', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'DETAIL_A' }], content: '答复' }, answer: '答复', reasoning: 'NATIVE_B', streamReasoning: 'DETAIL_A' },
  { name: 'NATIVE_B 先到而 TAG_A 晚到', deltas: [native('NATIVE_B'), text('<think>TAG_A</think>答复')], message: { reasoning_content: 'NATIVE_B', content: '<think>TAG_A</think>答复' }, answer: '答复', reasoning: 'NATIVE_B' },
  { name: '三个冲突载体同帧', deltas: [{ reasoning_content: 'NATIVE_B', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'DETAIL_A' }], content: '<think>TAG_A</think>答复' }], message: { reasoning_content: 'NATIVE_B', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'DETAIL_A' }], content: '<think>TAG_A</think>答复' }, answer: '答复', reasoning: 'NATIVE_B' },
  { name: 'Mistral 思考与同帧正文', deltas: [{ content: [thinking('思'), { ...thinking('考'), signature: 'sig' }, plain('答')] }, text('复')], message: { content: [thinking('思'), { ...thinking('考'), signature: 'sig' }, plain('答复')] }, answer: '答复', reasoning: '思考' },
  { name: '显式 reasoning 内容块', deltas: [{ content: [{ type: 'reasoning', text: '思考', signature: 'sig' }, plain('答复')] }], message: { content: [{ type: 'reasoning', text: '思考', signature: 'sig' }, plain('答复')] }, answer: '答复', reasoning: '思考' },
  { name: 'thinking 字符串块', deltas: [{ content: [{ type: 'thinking', thinking: '思考', signature: 'sig' }, plain('答复')] }], message: { content: [{ type: 'thinking', thinking: '思考', signature: 'sig' }, plain('答复')] }, answer: '答复', reasoning: '思考' },
  { name: '原生与结构化不重复', deltas: [{ reasoning_content: '原生', content: [thinking('镜像'), plain('答复')] }], message: { reasoning_content: '原生', content: [thinking('镜像'), plain('答复')] }, answer: '答复', reasoning: '原生' },
  { name: 'details 可读与加密保留', deltas: [detail([{ ...details[0], text: '思', signature: 'sign-a' }, { ...details[1], data: 'secret-a' }, details[2]]), detail([{ index: 0, text: '考', signature: 'b' }, { index: 1, data: 'b' }]), text('答复')], message: { content: '答复', reasoning_details: details }, answer: '答复', reasoning: '思考', details },
  { name: 'summary 可读字段', deltas: [detail([{ index: 0, type: 'reasoning.summary', summary: '摘要' }]), text('答复')], message: { content: '答复', reasoning_details: [{ index: 0, type: 'reasoning.summary', summary: '摘要' }] }, answer: '答复', reasoning: '摘要' },
  { name: '原生与 details 不重复', deltas: [{ reasoning_content: '原生', reasoning_details: details }, text('答复')], message: { content: '答复', reasoning_content: '原生', reasoning_details: details }, answer: '答复', reasoning: '原生', details },
  { name: '无 index 的不同载荷不合并', deltas: [detail([{ type: 'reasoning.text', id: 'one', text: '思' }]), detail([{ type: 'reasoning.text', id: 'two', text: '考' }]), detail([{ id: 'one', signature: '签名' }]), text('答复')], message: { content: '答复', reasoning_details: [{ type: 'reasoning.text', id: 'one', text: '思', signature: '签名' }, { type: 'reasoning.text', id: 'two', text: '考' }] }, answer: '答复', reasoning: '思考' },
  { name: '空签名分片不擦除已收载荷', deltas: [detail([{ index: 0, type: 'reasoning.text', text: '思考', signature: '签名' }]), detail([{ index: 0, text: null, signature: null }]), text('答复')], message: { content: '答复', reasoning_details: [{ index: 0, type: 'reasoning.text', text: '思考', signature: '签名' }] }, answer: '答复', reasoning: '思考', details: [{ index: 0, type: 'reasoning.text', text: '思考', signature: '签名' }] },
  { name: 'reasoning-only', deltas: [native('思考')], message: { content: '', reasoning_content: '思考' }, answer: '', reasoning: '思考' },
  { name: '交替输出', deltas: [native('思'), text('答'), native('考'), text('复')], message: { content: '答复', reasoning_content: '思考' }, answer: '答复', reasoning: '思考' },
  { name: '普通对象兼容', deltas: [{ content: { parts: [{ text: '答复' }] } }], message: { content: { parts: [{ text: '答复' }] } }, answer: '答复', reasoning: '' },
];

let raw = '', status = 200, requests = [], xhrInstance;
let chunkSize = 11;
class FixtureXHR {
  responseText = '';
  status = status;
  stopped = false;
  constructor() { xhrInstance = this; }
  open() {}
  setRequestHeader() {}
  async send(body) {
    requests.push(JSON.parse(body));
    for (let i = 0; i < raw.length && !this.stopped; i += chunkSize) {
      this.responseText += raw.slice(i, i + chunkSize);
      this.onprogress();
      await Promise.resolve();
    }
    if (!this.stopped) this.onload();
  }
  abort() { this.stopped = true; this.responseText = ''; }
}
function serve(transport, value, code = 200) {
  raw = value; status = code;
  globalThis.XMLHttpRequest = transport === 'xhr' ? FixtureXHR : undefined;
}
function sse(deltas, ending = 'stop', done = true) {
  return deltas.map((delta, index) => `data: ${JSON.stringify({ id: 'fixture', choices: [{
    delta, finish_reason: index === deltas.length - 1 ? ending : null,
  }] })}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '');
}
const create = config => new BaseAIClient({
  baseURL: 'https://relay.invalid/v1', apiKey: 'fixture-only-not-a-key', model: 'qwen3-32b', ...config,
});
let assertions = 0;
try {
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (!JSON.parse(options.body).stream || status !== 200) return new Response(raw, { status });
    const bytes = new TextEncoder().encode(raw);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  for (const transport of ['complete', 'fetch', 'xhr']) {
    const client = create();
    for (const sample of samples) {
      const target = sample.config ? create(sample.config) : client;
      const expectedRaw = transport === 'complete'
        ? JSON.stringify({ choices: [{ message: sample.message, finish_reason: 'stop' }] }) : sse(sample.deltas);
      serve(transport, expectedRaw);
      const events = [];
      const result = transport === 'complete'
        ? await target.chat(messages, { allowReasoningLengthRetry: false })
        : await target.chatStream(messages, { onDelta: event => events.push(event) });
      assert.equal(result.success, true, sample.name);
      assert.equal(result.text, transport === 'complete' ? sample.completeAnswer ?? sample.answer : sample.answer, sample.name);
      assert.equal(result.reasoningText, transport === 'complete' ? sample.reasoning : sample.streamReasoning ?? sample.reasoning, sample.name);
      if (sample.details) assert.deepEqual(result.reasoningReplay.reasoning_details, sample.details);
      if (transport !== 'complete') {
        assert.equal(events.filter(event => event.type === 'answer_delta').map(event => event.text).join(''), result.text);
        assert.equal(events.filter(event => event.type === 'reasoning_delta').map(event => event.text).join(''), result.reasoningText);
        assert.equal(events.filter(event => event.type === 'done').length, 1);
      }
      assert.equal(records.at(-1).responseBody, expectedRaw, '诊断必须保存解析前完整正文');
      assertions++;
    }

    // 经真实 adapter / collector / 历史装配，再让同一个 Client 序列化下一轮。
    for (const opaqueOnly of [false, true]) {
      const replayContent = opaqueOnly ? '' : [thinking('思考'), plain('先查')];
      const replayDetails = opaqueOnly ? details.slice(1) : details;
      const toolMessage = { content: replayContent, reasoning_details: replayDetails, tool_calls: [tool] };
      const toolDeltas = [{ content: replayContent, reasoning_details: replayDetails },
        { tool_calls: [{ ...tool, index: 0, function: { name: 'inspect', arguments: '{' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '}' } }] }];
      serve(transport, transport === 'complete' ? JSON.stringify({ choices: [{ message: toolMessage, finish_reason: 'tool_calls' }] }) : sse(toolDeltas, 'tool_calls'));
      const gateway = new AgentModelGateway(client);
      const turn = await gateway[transport === 'complete' ? 'complete' : 'stream']({ messages, tools });
      assert.equal(turn.assistantText, opaqueOnly ? '' : '先查');
      assert.equal(turn.reasoningText, opaqueOnly ? '' : '思考');
      assert.deepEqual(turn.historyItems[0].reasoningReplay, turn.reasoningReplay);
      assert.deepEqual(turn.reasoningReplay.reasoning_details, replayDetails);
      const nextMessages = buildAgentModelMessages(messages, [...turn.historyItems,
        { role: 'tool', toolCallId: tool.id, name: 'inspect', content: '已完成' }]);
      serve('complete', JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }));
      assert.equal((await client.chatWithTools(nextMessages, tools)).success, true);
      const sent = requests.at(-1).messages[1];
      assert.deepEqual(sent.content, toolMessage.content);
      assert.deepEqual(sent.reasoning_details, replayDetails);
      assert.equal(Object.hasOwn(sent, 'reasoning_content'), false, '不能把展示文本再编码为第二个思考通道');
      assert.equal(Object.hasOwn(sent, 'reasoningReplay'), false, '内部载荷必须在 HTTP 边界展开');
    }
  }

  for (const transport of ['fetch', 'xhr']) {
    // 每一个字节／字符都可以成为分片边界，包含 UTF-8、CRLF 与标签。
    chunkSize = 1;
    serve(transport, sse(['<th', 'ink>中', '文</thi', 'nk>答复'].map(text), 'stop', false));
    const result = await create().chatStream(messages);
    assert.equal(result.text, '答复'); assert.equal(result.reasoningText, '中文');
    chunkSize = 11;
    serve(transport, sse([native('思考'), text('答复')]) + sse([text('迟到正文')], 'stop', false));
    assert.equal((await create().chatStream(messages)).text, '答复', 'DONE 后同批尾帧不得继续交付');
    const snapshot = { choices: [{ message: { reasoning_content: '思考', content: '答复', reasoning_details: details }, finish_reason: 'stop' }] };
    serve(transport, sse([{ reasoning_content: '思考', reasoning_details: details }, text('答')], null, false)
      + `data: ${JSON.stringify(snapshot)}\n\ndata: [DONE]\n\n`);
    const snap = await create().chatStream(messages);
    assert.equal(snap.text, '答复'); assert.equal(snap.reasoningText, '思考');
    assert.deepEqual(snap.reasoningReplay.reasoning_details, details, '完整快照不可再次拼接签名或密文');
    serve(transport, sse([{ reasoning_content: '思考', reasoning_details: details }, text('答')], null, false)
      + 'data: {"choices":[{"message":{"content":"答复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const partialSnapshot = await create().chatStream(messages);
    assert.equal(partialSnapshot.text, '答复'); assert.equal(partialSnapshot.reasoningText, '思考');
    assert.deepEqual(partialSnapshot.reasoningReplay.reasoning_details, details, '正文快照没有提供的思考字段必须保留');

    const controller = new AbortController(), received = [], cancelledClient = create();
    serve(transport, sse([text('<think>思考'), text('未结束'), text('</think>正文')], 'stop', false));
    await assert.rejects(cancelledClient.chatStream(messages, { signal: controller.signal, onDelta(event) {
      received.push(event); if (event.type === 'reasoning_delta') controller.abort();
    } }), /abort/i);
    const count = received.length;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, count, '取消后排队的 progress 不得再发布事件');
    assert.equal(received.some(event => event.type === 'answer_delta' || event.type === 'done'), false);
    assert.match(records.at(-1).responseBody, /data:/, '取消仍保留已收到的诊断原文');
    if (transport === 'xhr') assert.equal(xhrInstance.stopped, true);
    serve(transport, sse([text('全新正文')]));
    const fresh = await cancelledClient.chatStream(messages);
    assert.equal(fresh.text, '全新正文'); assert.equal(fresh.reasoningText, '');

    serve(transport, JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort' } }), 400);
    const before = requests.length, rejectedEvents = [];
    const rejected = await create({ reasoningEffort: 'high', model: 'gemini-4-c' }).chatStream(messages, { onDelta: event => rejectedEvents.push(event) });
    assert.equal(rejected.httpStatus, 400); assert.match(rejected.error, /reasoning_effort/);
    assert.equal(requests.length, before + 1, '兼容解析不能触发参数删除重试');
    assert.deepEqual(rejectedEvents, [], 'HTTP 拒绝不能伪装成流式完成');
  }
  serve('complete', JSON.stringify({ choices: [{ message: { content: '答复', reasoning_details: ['格式错误'] } }] }));
  const malformed = await create().chat(messages);
  assert.equal(malformed.success, true);
  assert.equal(malformed.text, '答复');
  assert.equal(records.at(-1).protocolIssues[0].code, 'invalid_detail');
  serve('complete', JSON.stringify({ choices: [{ message: { reasoning_details: [
    { index: 0, type: 'reasoning.encrypted', id: 'one', data: 'a' },
    { index: 0, type: 'reasoning.encrypted', id: 'two', data: 'b' },
  ] } }] }));
  const reusedIndex = await create().chat(messages);
  assert.equal(reusedIndex.success, false);
  assert.equal(records.at(-1).protocolIssues[0].code, 'detail_identity_conflict', '不能把不同签名身份的载荷静默拼成一条');

  const metadataCases = [
    { name: '错误根字段先于正文', deltas: [detail({}), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_details: {} }, thought: '' },
    { name: '错误根字段与正文同帧', deltas: [{ content: 'VALID_ANSWER', reasoning_details: {} }], message: { content: 'VALID_ANSWER', reasoning_details: {} }, thought: '' },
    { name: '正文后迟到错误元数据', deltas: [text('VALID_ANSWER'), detail({})], message: { content: 'VALID_ANSWER', reasoning_details: {} }, thought: '' },
    { name: '合法与损坏元素混合', deltas: [detail([null, { index: 0, type: 'reasoning.text', text: 'GOOD' }, 42, 'bad']), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_details: [null, { index: 0, type: 'reasoning.text', text: 'GOOD' }, 42, 'bad'] }, thought: 'GOOD' },
    { name: '原生思考不受损坏 details 影响', deltas: [native('NATIVE'), detail({}), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_content: 'NATIVE', reasoning_details: {} }, thought: 'NATIVE' },
    { name: '已知类型可读字段损坏', deltas: [detail([{ index: 0, type: 'reasoning.text', text: 42 }, { index: 1, type: 'reasoning.summary', summary: 'GOOD' }]), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 42 }, { index: 1, type: 'reasoning.summary', summary: 'GOOD' }] }, thought: 'GOOD' },
    { name: '冲突身份不合并', deltas: [detail([{ index: 0, type: 'reasoning.text', id: 'a', text: 'GOOD' }, { index: 0, type: 'reasoning.text', id: 'b', text: 'BAD' }, { index: 1, type: 'reasoning.text', text: 'OTHER' }]), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_details: [{ index: 0, type: 'reasoning.text', id: 'a', text: 'GOOD' }, { index: 0, type: 'reasoning.text', id: 'b', text: 'BAD' }, { index: 1, type: 'reasoning.text', text: 'OTHER' }] }, thought: 'GOODOTHER' },
    { name: '冲突 type 不污染正常正文', deltas: [detail([{ index: 0, type: 'reasoning.text', text: 'GOOD' }, { index: 0, type: 'reasoning.encrypted', data: 'SECRET' }]), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'GOOD' }, { index: 0, type: 'reasoning.encrypted', data: 'SECRET' }] }, thought: 'GOOD' },
    { name: '跨帧身份冲突不拼接', deltas: [detail([{ index: 0, type: 'reasoning.text', id: 'a', text: 'GOOD' }]), detail([{ index: 0, type: 'reasoning.text', id: 'b', text: 'BAD' }]), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_details: [{ index: 0, type: 'reasoning.text', id: 'a', text: 'GOOD' }, { index: 0, type: 'reasoning.text', id: 'b', text: 'BAD' }] }, thought: 'GOOD' },
    { name: '损坏已知签名不展示且不影响原生思考', deltas: [native('NATIVE'), detail([{ index: 0, type: 'reasoning.text', text: 'BAD', signature: { broken: true } }]), text('VALID_ANSWER')], message: { content: 'VALID_ANSWER', reasoning_content: 'NATIVE', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'BAD', signature: { broken: true } }] }, thought: 'NATIVE' },
    { name: '纯原生思考可完成', deltas: [native('NATIVE'), detail({})], message: { content: '', reasoning_content: 'NATIVE', reasoning_details: {} }, thought: 'NATIVE', answer: '' },
    { name: '纯合法 detail 思考可完成', deltas: [detail([{ index: 0, type: 'reasoning.text', text: 'GOOD' }, null])], message: { content: '', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'GOOD' }, null] }, thought: 'GOOD', answer: '' },
    { name: '仅无效元数据仍失败', deltas: [detail({})], message: { content: '', reasoning_details: {} }, thought: '', answer: '', failed: true },
  ];
  let metadataChecks = 0, toolChecks = 0;
  for (const transport of ['complete', 'fetch', 'xhr']) {
    const client = create();
    for (const sample of metadataCases) {
      const value = transport === 'complete' ? JSON.stringify({ choices: [{ message: sample.message, finish_reason: 'stop' }] }) : sse(sample.deltas);
      serve(transport, value);
      const events = [];
      const result = transport === 'complete' ? await client.chat(messages, { allowReasoningLengthRetry: false })
        : await client.chatStream(messages, { onDelta: event => events.push(event) });
      assert.equal(result.success, !sample.failed, `${transport}/${sample.name}`);
      const record = records.at(-1);
      assert.equal(record.responseBody, value);
      assert.ok(record.protocolIssues.length > 0, '容错仍需结构化诊断');
      assert.ok(record.protocolIssues.every(issue => issue.path.startsWith('reasoning_details') && issue.frame > 0));
      if (!sample.failed) {
        assert.equal(result.text, sample.answer ?? 'VALID_ANSWER', sample.name);
        assert.equal(result.reasoningText, sample.thought, sample.name);
        assert.equal(result.reasoningReplay?.reasoning_details, undefined, '不能把缺损集合冒充完整载荷回传');
        assert.equal(record.error, null);
        if (transport !== 'complete') {
          assert.equal(events.filter(event => event.type === 'answer_delta').map(event => event.text).join(''), result.text);
          assert.equal(events.filter(event => event.type === 'done').length, 1, '容错也必须正常结束且只结束一次');
        }
      } else {
        assert.ok(record.error);
        assert.equal(events.some(event => event.type === 'done'), false);
      }
      // 正常收口必须经过真实 adapter / collector，而不止是 Client 返回 success。
      serve(transport, value);
      const modelEvents = [];
      const collect = () => new AgentModelGateway(client)[transport === 'complete' ? 'complete' : 'stream'](
        { messages, tools: [] }, event => modelEvents.push(event));
      if (sample.failed) await assert.rejects(collect(), /元数据无效/);
      else {
        const turn = await collect();
        assert.equal(turn.assistantText, sample.answer ?? 'VALID_ANSWER');
        assert.equal(turn.reasoningText, sample.thought);
        assert.equal(turn.finishReason, 'stop');
        assert.equal(modelEvents.filter(event => event.type === 'turn_completed').length, 1);
      }
      metadataChecks++;
    }

    const opaque = [{ index: 9, type: 'future.reasoning', signature: { opaque: true }, payload: [1, { raw: 'preserved' }] },
      { index: 0, type: 'other.reasoning', data: { nested: [1, 2] } }];
    const toolCases = [
      { name: '未知网关损坏回放', config: {}, safe: false },
      { name: 'OpenRouter 不能用原生文本替代损坏特殊块', config: { baseURL: 'https://openrouter.ai/api/v1' }, native: 'NATIVE', safe: false },
      { name: '第三方 DeepSeek 别名不能推导官方契约', config: { model: 'deepseek-v4-flash' }, native: 'NATIVE', safe: false },
      { name: 'DeepSeek 官方保留原生契约', config: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' }, native: 'NATIVE', safe: true },
      { name: 'DeepSeek 缺少原生载荷不放行', config: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' }, safe: false },
      { name: 'DeepSeek 明确不思考时 details 非必需', config: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', disableThinking: true }, safe: true },
      { name: 'Mistral 使用原始 content 回放', config: { baseURL: 'https://api.mistral.ai/v1' }, structured: true, safe: true },
      { name: '未知对象可无损回放', config: {}, details: opaque, safe: true },
      { name: '冲突标签工具续轮', config: {}, native: 'NATIVE_B', tag: 'TAG_A', details: undefined, safe: true, streamThought: 'TAG_A' },
      { name: '冲突 details 工具续轮', config: {}, native: 'NATIVE_B', details: [{ index: 0, type: 'reasoning.text', text: 'DETAIL_A' }], safe: true, streamThought: 'DETAIL_A' },
      { name: '工具轮身份冲突仍阻止', config: {}, details: [{ index: 0, type: 'reasoning.encrypted', id: 'a', data: 'a' }, { index: 0, type: 'reasoning.encrypted', id: 'b', data: 'b' }], safe: false },
      { name: '工具轮 type 冲突仍阻止', config: {}, details: [{ index: 0, type: 'reasoning.text', text: 'A' }, { index: 0, type: 'reasoning.encrypted', data: 'SECRET' }], safe: false },
      { name: '工具轮跨帧身份冲突仍阻止', config: {}, details: [{ index: 0, type: 'reasoning.encrypted', id: 'a', data: 'a' }, { index: 0, type: 'reasoning.encrypted', id: 'b', data: 'b' }], splitDetails: true, safe: false },
    ];
    for (const sample of toolCases) {
      const target = create(sample.config);
      const valueDetails = Object.hasOwn(sample, 'details') ? sample.details : {};
      const content = sample.tag ? `<think>${sample.tag}</think>VALID_ANSWER` : sample.structured ? [thinking('STRUCTURED'), plain('VALID_ANSWER')] : 'VALID_ANSWER';
      const message = { content, reasoning_content: sample.native, reasoning_details: valueDetails, tool_calls: [tool] };
      const deltas = [];
      if (sample.tag) deltas.push(text(`<think>${sample.tag}`));
      else if (sample.streamThought) deltas.push(detail(valueDetails));
      if (sample.splitDetails) deltas.push(...valueDetails.map(value => detail([value])));
      deltas.push({ content: sample.tag ? '</think>VALID_ANSWER' : content, reasoning_content: sample.native,
        ...((!sample.streamThought || sample.tag) && !sample.splitDetails ? { reasoning_details: valueDetails } : {}), tool_calls: [{ ...tool, index: 0 }] });
      const value = transport === 'complete' ? JSON.stringify({ choices: [{ message, finish_reason: 'tool_calls' }] }) : sse(deltas, 'tool_calls');
      serve(transport, value);
      const gateway = new AgentModelGateway(target);
      let executions = 0;
      const executeAfterModel = async () => {
        const turn = await gateway[transport === 'complete' ? 'complete' : 'stream']({ messages, tools });
        turn.toolCalls.forEach(() => { executions++; });
        return turn;
      };
      if (!sample.safe) {
        await assert.rejects(executeAfterModel(), /无法安全回放/, sample.name);
        assert.equal(executions, 0, 'adapter 不得交出不安全回合给执行器');
        assert.ok(records.at(-1).protocolIssues.length);
      } else {
        const turn = await executeAfterModel();
        assert.equal(executions, 1);
        assert.equal(turn.assistantText, 'VALID_ANSWER');
        if (sample.native) assert.equal(turn.reasoningText, transport === 'complete' ? sample.native : sample.streamThought ?? sample.native);
        const followup = buildAgentModelMessages(messages, [...turn.historyItems, { role: 'tool', toolCallId: tool.id, name: 'inspect', content: '观察' }]);
        serve('complete', JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }));
        assert.equal((await target.chatWithTools(followup, tools)).success, true);
        const sent = requests.at(-1).messages[1];
        if (sample.native) assert.equal(sent.reasoning_content, sample.native, '回放原生原文，不用先到展示文本伪造载荷');
        if (sample.tag || sample.structured) assert.deepEqual(sent.content, content);
        if (Array.isArray(valueDetails)) assert.deepEqual(sent.reasoning_details, valueDetails);
        else assert.equal(sent.reasoning_details, undefined);
        assert.equal(Object.hasOwn(sent, 'protocolIssues'), false);
        assert.equal(Object.hasOwn(sent, 'reasoningReplay'), false);
      }
      const first = records.findLast(record => record.responseBody === value);
      assert.ok(first, '失败和成功均需保留原始响应');
      toolChecks++;
    }
  }

  for (const transport of ['fetch', 'xhr']) {
    const full = { content: '<think>TAG_A</think>VALID_ANSWER', reasoning_content: 'NATIVE_B' };
    serve(transport, sse([text('<think>TAG_A')], null, false) + `data: ${JSON.stringify({ choices: [{ message: full, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    const events = [];
    const result = await create().chatStream(messages, { onDelta: event => events.push(event) });
    assert.equal(result.reasoningText, 'TAG_A', '完整快照也不能改选晚到的原生思考');
    assert.equal(result.reasoningReplay.reasoning_content, 'NATIVE_B');
    assert.equal(events.filter(event => event.type === 'reasoning_delta').map(event => event.text).join(''), 'TAG_A');
    assert.equal(events.filter(event => event.type === 'done').length, 1);

    serve(transport, sse([detail([{ index: 0, type: 'reasoning.text', text: 'GOOD' }])], null, false)
      + 'data: {"choices":[{"message":{"content":"VALID_ANSWER","reasoning_details":{}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const optionalSnapshot = await create().chatStream(messages);
    assert.equal(optionalSnapshot.success, true);
    assert.equal(optionalSnapshot.text, 'VALID_ANSWER');
    assert.equal(optionalSnapshot.reasoningText, 'GOOD');
    assert.ok(records.at(-1).protocolIssues.length);

    serve(transport, sse([native('FIRST')], null, false)
      + 'data: {"choices":[{"message":{"content":"VALID_ANSWER","reasoning_content":"DIFFERENT","reasoning_details":{}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const irreconcilable = await create().chatStream(messages);
    assert.equal(irreconcilable.success, false);
    assert.match(irreconcilable.error, /快照/, '可选容错不能吞掉真正的快照冲突');

    const controller = new AbortController(), cancelledEvents = [];
    serve(transport, sse([detail({}), text('<think>PARTIAL'), text('</think>答复')]));
    await assert.rejects(create().chatStream(messages, { signal: controller.signal, onDelta: event => {
      cancelledEvents.push(event); if (event.type === 'reasoning_delta') controller.abort();
    } }), /abort/i);
    assert.equal(cancelledEvents.some(event => event.type === 'done'), false);
    assert.ok(records.at(-1).protocolIssues.length, '取消仍保留此前的可选字段诊断');

    serve(transport, 'data: {invalid-json}\n\n');
    assert.equal((await create().chatStream(messages)).success, false);
    serve(transport, sse([text('VALID_ANSWER'), detail({})], null, false) + 'data: {"error":{"message":"explicit failure"}}\n\n');
    const explicitFailure = await create().chatStream(messages);
    assert.equal(explicitFailure.success, false);
    assert.match(explicitFailure.error, /explicit failure/);
    serve(transport, sse([{ tool_calls: [{ ...tool, index: 0, function: { name: 'inspect', arguments: '{invalid' } }] }], 'tool_calls'));
    await assert.rejects(new AgentModelGateway(create()).stream({ messages, tools }), /JSON|Unexpected|property/i);
  }
  console.log(`可选元数据：${metadataChecks} 组容错、${toolChecks} 组回放裁决及冲突／快照回归通过。`);
  console.log(`AI 思考兼容：${assertions} 组三传输样本、原文诊断、工具续轮元数据、逐字分片、快照、取消与 400 验证通过。`);
} finally {
  globalThis.fetch = original.fetch;
  globalThis.XMLHttpRequest = original.xhr;
}
