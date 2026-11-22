/** 在真实 Client 与传输边界验证 HTTP 原文采集，不经过业务响应归一化。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule as load } from '../helpers/load-typescript-module.mjs';

const apiKey = 'sk-http-capture-private-key';
const records = [], requests = [], logs = [];
let captureEnabled = true, beginFailure = false, writeFailure = false;
const capture = load('src/platform/ai/HttpExchangeCapture.ts', {
  './HttpExchangeDiagnostics': { aiHttpDiagnostics: {
    async beginCapture() {
      if (beginFailure) throw new Error(`读取失败 ${apiKey}`);
      return captureEnabled ? 17 : null;
    },
    async record(exchange, key, generation) {
      assert.equal(key, apiKey);
      assert.equal(generation, 17);
      assert.equal(Object.hasOwn(exchange, 'headers'), false, '诊断契约不传递 Authorization header');
      if (writeFailure) throw new Error(`存储失败 ${apiKey}`);
      records.push(exchange);
    },
  } },
});
const { BaseAIClient } = load('src/platform/ai/BaseAIClient.ts', {
  './OpenAIMessageDecoder': load('src/platform/ai/OpenAIMessageDecoder.ts'), './reasoning': load('src/platform/ai/reasoning.ts'),
  './HttpExchangeCapture': capture,
  './baseUrl': load('src/platform/ai/baseUrl.ts'),
  './errorMapping': load('src/platform/ai/errorMapping.ts'),
});
let modelId = 0;
const client = () => new BaseAIClient({
  baseURL: 'https://capture.example/v1', apiKey, model: `capture-${++modelId}`, maxTokens: 64,
});
const messages = [{ role: 'user', content: ' 原始请求\r\n下一行\u0000 ' }];
const completion = (content = '  原始回答\r\n下一行\u0000  ', finish = 'stop') => JSON.stringify({
  id: 'raw-reply', choices: [{ message: { content }, finish_reason: finish }],
});
const sse = ': provider comment\r\n\r\n'
  + `data: ${JSON.stringify({ choices: [{ delta: { content: ' 原始回答\r\n下一行\u0000 ' }, finish_reason: 'stop' }] })}\r\n\r\n`
  + 'data: [DONE]\r\n\r\n';
let responses = [];
const original = { fetch: globalThis.fetch, xhr: globalThis.XMLHttpRequest, log: console.log, warn: console.warn, error: console.error };
const rememberRequest = (url, body) => {
  assert.equal(typeof body, 'string');
  requests.push({ url, body });
};
const lastExchange = (raw, status = 200) => {
  const exchange = records.at(-1), request = requests.at(-1);
  assert.equal(exchange.requestBody, request.body, '记录的请求必须与实际送出的字符串逐字相同');
  assert.equal(exchange.url, request.url);
  assert.equal(exchange.responseBody, raw, '记录响应必须保持原始空白、换行和协议文本');
  assert.equal(exchange.status, status);
  assert.equal(exchange.method, 'POST');
  return exchange;
};

try {
  console.log = console.warn = console.error = (...args) => logs.push(args);
  globalThis.XMLHttpRequest = undefined;
  globalThis.fetch = async (url, options) => {
    rememberRequest(url, options.body);
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    const next = responses.shift();
    assert.ok(next, '测试未提供网络响应');
    if (next.error) throw next.error;
    if (next.chunks) {
      let index = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (index < next.chunks.length) controller.enqueue(next.chunks[index++]);
        else if (next.readError) controller.error(next.readError);
        else if (next.holdOpen) return new Promise(() => {});
        else controller.close();
      } }), { status: next.status ?? 200 });
    }
    return new Response(next.raw, { status: next.status ?? 200 });
  };

  for (const method of ['chat', 'chatWithTools']) {
    const raw = ` \n${completion()}\t`;
    responses.push({ raw });
    const result = await client()[method](messages, []);
    assert.equal(result.success, true);
    assert.equal(result.text, '原始回答\n下一行');
    assert.equal(lastExchange(raw).transport, 'complete');
    assert.equal(records.at(-1).error, null);
  }

  for (const [raw, status] of [[' \n{invalid json\t', 200], ['<html>proxy failure</html>\r\n', 502], [
    ' {"error":{"message":"provider refused"}} \n', 401,
  ]]) {
    responses.push({ raw, status });
    assert.equal((await client().chat(messages)).success, false);
    lastExchange(raw, status);
  }

  // 工具续轮返回空 502 时，前一轮工具调用的 HTTP 原文仍是独立记录。
  const searchCall = { id: 'search-1', type: 'function', function: { name: 'web_search', arguments: '{}' } };
  const searchResult = [
    ...messages,
    { role: 'assistant', content: '我查一下。', tool_calls: [searchCall] },
    { role: 'tool', tool_call_id: searchCall.id, content: '{"results":[]}' },
  ];
  for (const stream of [false, true]) {
    const raw = stream
      ? `data: ${JSON.stringify({ choices: [{ delta: { content: '我查一下。', tool_calls: [{ index: 0, ...searchCall }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message: { content: '我查一下。', tool_calls: [searchCall] }, finish_reason: 'tool_calls' }] });
    const model = client();
    const method = stream ? 'chatStreamWithTools' : 'chatWithTools';
    const before = records.length;
    responses.push({ raw }, { raw: '', status: 502 });
    assert.equal((await model[method](messages, [])).toolCalls[0].id, searchCall.id);
    const rejected = await model[method](searchResult, []);
    assert.equal(rejected.success, false);
    assert.equal(rejected.httpStatus, 502);
    const [first, last] = records.slice(before);
    assert.equal(records.length, before + 2);
    assert.notEqual(first.id, last.id);
    assert.equal(first.responseBody, raw);
    assert.equal(first.status, 200);
    assert.equal(first.error, null);
    assert.match(lastExchange('', 502).error, /^HTTP 502/u);
  }

  // 重试是独立 HTTP 交换；记录每次实际送出的参数与各自响应。
  for (const kind of ['max-tokens', 'image', 'response-format', 'reasoning-length']) {
    const before = records.length;
    const first = kind === 'reasoning-length'
      ? JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '尚未完成' }, finish_reason: 'length' }] })
      : JSON.stringify({ error: { message: {
        'max-tokens': "Unsupported parameter: 'max_tokens', use max_completion_tokens instead",
        image: 'unsupported image_url content', 'response-format': 'response_format is not supported',
      }[kind] } });
    const second = completion('完成');
    responses.push({ raw: first, status: kind === 'reasoning-length' ? 200 : 400 }, { raw: second });
    const input = kind === 'image' ? [{ role: 'user', content: [
      { type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,ORIGINAL' } },
    ] }] : messages;
    const result = await client().chat(input, kind === 'response-format' ? { responseFormat: 'json_object' } : {});
    assert.equal(result.success, true, kind);
    const attempts = records.slice(before);
    assert.equal(attempts.length, 2, `${kind} 两次请求分别保留`);
    assert.deepEqual(attempts.map(value => value.responseBody), [first, second]);
    assert.deepEqual(attempts.map(value => value.requestBody), requests.slice(-2).map(value => value.body));
    assert.notEqual(attempts[0].id, attempts[1].id);
    const bodies = attempts.map(value => JSON.parse(value.requestBody));
    if (kind === 'max-tokens') assert.equal(bodies[1].max_completion_tokens, 64);
    if (kind === 'image') assert.equal(typeof bodies[1].messages[0].content, 'string');
    if (kind === 'response-format') assert.equal(Object.hasOwn(bodies[1], 'response_format'), false);
    if (kind === 'reasoning-length') assert.ok(bodies[1].max_tokens > bodies[0].max_tokens);
  }

  for (const method of ['chatStream', 'chatStreamWithTools']) {
    const bytes = new TextEncoder().encode(sse);
    const split = bytes.indexOf(0xe5) + 1;
    responses.push({ chunks: [bytes.slice(0, split), bytes.slice(split)] });
    const result = await client()[method](messages, []);
    assert.equal(result.success, true);
    assert.equal(result.text, ' 原始回答\n下一行 ');
    assert.equal(lastExchange(sse).transport, 'stream');
  }

  // 模型协议结束不代表 HTTP 正文结束；诊断继续收尾，但不再触发模型事件。
  const finalComment = ': final transport comment\n\n';
  const encode = value => new TextEncoder().encode(value);
  for (const readError of [undefined, new Error('tail reader interrupted')]) {
    const events = [];
    responses.push({ chunks: [encode(sse), encode(finalComment)], readError });
    const result = await client().chatStream(messages, { onDelta: delta => events.push(delta) });
    assert.equal(result.success, true, 'DONE 后的旁路读取失败不能改变成功回复');
    assert.equal(result.text, ' 原始回答\n下一行 ');
    assert.equal(events.filter(event => event.type === 'done').length, 1);
    const exchange = lastExchange(sse + finalComment);
    assert.equal(exchange.error, readError?.message ?? null);
  }

  const malformedEvent = 'data: {invalid JSON}\n\n';
  responses.push({ chunks: [encode(malformedEvent), encode(finalComment)] });
  const malformed = await client().chatStream(messages);
  assert.equal(malformed.success, false, '采集剩余正文后仍保留原始协议解析失败');
  assert.match(malformed.error, /JSON|property name/i);
  const malformedExchange = lastExchange(malformedEvent + finalComment);
  assert.equal(malformedExchange.error, malformed.error);

  captureEnabled = false;
  responses.push({ chunks: [encode(sse)], holdOpen: true });
  let deadline;
  try {
    const result = await Promise.race([
      client().chatStream(messages),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('关闭诊断后仍等待 DONE 后的 HTTP 尾部')), 1000); }),
    ]);
    assert.equal(result.success, true, '默认关闭诊断时仍在 DONE 返回，不等待连接关闭');
  } finally {
    clearTimeout(deadline);
    captureEnabled = true;
  }

  const failedStream = ' {"error":{"message":"image_url unsupported"}}\r\n';
  responses.push({ raw: failedStream, status: 400 }, { raw: sse });
  const imageInput = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ORIGINAL' } }] }];
  const beforeStream = records.length;
  assert.equal((await client().chatStream(imageInput)).success, true);
  assert.deepEqual(records.slice(beforeStream).map(value => value.responseBody), [failedStream, sse]);

  const partial = `data: ${JSON.stringify({ choices: [{ delta: { content: '半段' } }] })}\r\n\r\n`;
  for (const outcome of ['success', 'http-error', 'network-error', 'timeout', 'abort']) {
    const controller = new AbortController();
    const raw = outcome === 'success' ? sse : outcome === 'http-error' ? 'proxy rejected\r\n' : partial;
    const status = outcome === 'http-error' ? 503 : 200;
    const nativeFailure = outcome === 'timeout' ? 'Read timed out' : 'Unable to resolve host "capture.example"';
    globalThis.XMLHttpRequest = class {
      status = status;
      responseText = '';
      open(_method, url) { this.url = url; }
      setRequestHeader() {}
      send(body) {
        rememberRequest(this.url, body);
        this.responseText = raw;
        this.onprogress();
        if (outcome === 'network-error') { this.responseText = nativeFailure; this.onerror(); }
        else if (outcome === 'timeout') { this.responseText = nativeFailure; this.ontimeout(); }
        else if (outcome === 'abort') controller.abort();
        else this.onload();
      }
      abort() { this.responseText = ''; this.onabort?.(); }
    };
    const promise = client().chatStreamWithTools(messages, [], { signal: controller.signal });
    if (outcome === 'abort') await assert.rejects(promise, /abort/i);
    else {
      const result = await promise;
      assert.equal(result.success, outcome === 'success', outcome);
      if (outcome === 'network-error' || outcome === 'timeout') {
        assert.ok(result.error.includes(nativeFailure), '传输错误保留原生原因，不丢成笼统的 API 地址错误');
        const { getErrorDisplayInfo } = load('src/platform/ai/errorMapping.ts');
        assert.equal(getErrorDisplayInfo(result.error).type, outcome === 'timeout' ? 'timeout' : 'network');
      }
    }
    const exchange = lastExchange(raw, status);
    assert.equal(exchange.transport, 'stream');
    if (outcome !== 'success') assert.ok(exchange.error, outcome);
  }
  const { getErrorDisplayInfo } = load('src/platform/ai/errorMapping.ts');
  for (const reason of ['Network request timed out', 'Network request failed: timeout', 'Network request failed: Read timed out']) {
    assert.equal(getErrorDisplayInfo(reason).type, 'timeout', '超时不能被 Network 前缀误分为 API 地址问题');
  }

  globalThis.XMLHttpRequest = undefined;
  for (const mode of ['disabled', 'begin-failure', 'write-failure']) {
    const before = records.length;
    captureEnabled = mode !== 'disabled'; beginFailure = mode === 'begin-failure'; writeFailure = mode === 'write-failure';
    responses.push({ raw: completion('聊天继续') });
    assert.equal((await client().chat(messages)).success, true, '诊断开关或存储故障不能改变聊天结果');
    assert.equal(records.length, before);
  }
  captureEnabled = true; beginFailure = false; writeFailure = false;
  globalThis.XMLHttpRequest = undefined;
  const refusal = JSON.stringify({ error: { code: '1302', message: `请求并发超限 ${apiKey}` } });
  for (const method of ['chat', 'chatWithTools', 'chatStream', 'chatStreamWithTools']) {
    const before = requests.length;
    responses.push({ raw: refusal, status: 429 });
    const result = await client()[method](messages, []);
    assert.equal(result.success, false);
    assert.equal(result.httpStatus, 429, method);
    assert.match(result.error, /HTTP 429.*1302.*请求并发超限/);
    assert.ok(!result.error.includes(apiKey), '展示的服务端错误必须脱敏');
    assert.equal(requests.length, before + 1, '限流不自动重试');
    lastExchange(refusal, 429);
  }
  for (const body of [{ error: { code: 'provider_rejected', message: '模型服务拒绝请求' } }, { code: 'gateway_rejected', message: '上游网关拒绝请求' }]) {
    const raw = JSON.stringify(body);
    responses.push({ raw });
    const result = await client().chat(messages);
    assert.equal(result.success, false, 'HTTP 200 的业务错误仍保留具体原因');
    assert.match(result.error, /(?:provider|gateway)_rejected/);
    lastExchange(raw);
  }
  const streamError = 'data: ' + JSON.stringify({ error: { code: 'service_limit', message: '本时段服务额度已用完' } }) + '\n\n';
  for (const method of ['chatStream', 'chatStreamWithTools']) {
    responses.push({ chunks: [encode(partial), encode(streamError)] });
    const result = await client()[method](messages, []);
    assert.equal(result.success, false, '已经返回部分正文的 SSE 错误也不能被当作成功');
    assert.match(result.error, /service_limit.*服务额度已用完/);
    lastExchange(partial + streamError);
  }
  for (const [status, raw] of [[429, refusal], [200, partial + streamError]]) {
    globalThis.XMLHttpRequest = class {
      status = status;
      responseText = '';
      open(_method, url) { this.url = url; }
      setRequestHeader() {}
      send(body) {
        rememberRequest(this.url, body);
        this.responseText = raw;
        this.onprogress(); this.onload();
      }
      abort() { this.responseText = ''; }
    };
    const result = await client().chatStream(messages);
    assert.equal(result.success, false, 'Android XHR 同样保留具体错误');
    assert.match(result.error, status === 429 ? /HTTP 429.*1302/ : /service_limit/);
    assert.ok(!result.error.includes(apiKey));
    if (status === 429) assert.equal(result.httpStatus, 429);
    lastExchange(raw, status);
  }

  const reasoning = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '已经收到的思考' } }] })}\n\n`;
  const events = [];
  let aborted = false;
  globalThis.XMLHttpRequest = class {
    status = 200;
    responseText = '';
    open(_method, url) { this.url = url; }
    setRequestHeader() {}
    send(body) {
      rememberRequest(this.url, body);
      this.responseText = reasoning;
      this.onprogress();
      setImmediate(() => {
        this.responseText += streamError;
        this.onprogress();
      });
    }
    abort() { aborted = true; this.responseText = ''; }
  };
  const beforeOpenError = records.length;
  let openErrorDeadline;
  try {
    const result = await Promise.race([
      client().chatStream(messages, { onDelta: event => events.push(event) }),
      new Promise((_, reject) => { openErrorDeadline = setTimeout(() => reject(new Error('Android 流内错误仍在等待连接结束')), 1000); }),
    ]);
    assert.equal(result.success, false);
    assert.match(result.error, /service_limit.*服务额度已用完/);
    assert.deepEqual(events, [{ type: 'reasoning_delta', text: '已经收到的思考' }]);
    assert.equal(aborted, true, '服务端不关闭连接时，客户端仍应释放传输');
    assert.equal(records.length, beforeOpenError + 1);
    assert.equal(lastExchange(reasoning + streamError).error, result.error);
  } finally {
    clearTimeout(openErrorDeadline);
  }
  assert.equal(responses.length, 0);
  assert.equal(JSON.stringify(logs).includes(apiKey), false, '诊断故障不能把 API Key 输出到日志');
} finally {
  globalThis.fetch = original.fetch; globalThis.XMLHttpRequest = original.xhr;
  console.log = original.log; console.warn = original.warn; console.error = original.error;
}
console.log('AI HTTP 原文采集：完整请求与响应、逐次重试、Fetch/XHR SSE、错误与取消、诊断失败隔离通过。');
