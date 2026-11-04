import { chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';
/** 验证 API 缓存用量在各传输、模型事件、消息持久载荷及提示文案中的真实行为。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, mocks = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    assert.ok(Object.hasOwn(mocks, name), `未声明的测试依赖：${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}

const { BaseAIClient } = load('src/platform/ai/BaseAIClient.ts', {
  './HttpExchangeCapture': { beginAIHttpCapture: async () => null },
  './errorMapping': load('src/platform/ai/errorMapping.ts'),
  './baseUrl': load('src/platform/ai/baseUrl.ts'),
});
const collector = load('src/platform/ai/agent/ModelTurnCollector.ts');
const complete = load('src/platform/ai/agent/CompleteModelTurnAdapter.ts', { './ModelTurnCollector': collector });
const streaming = load('src/platform/ai/agent/StreamingModelTurnAdapter.ts', {
  './ModelTurnCollector': collector, './CompleteModelTurnAdapter': complete,
});
const client = new BaseAIClient({ baseURL: 'https://example.invalid/v1', apiKey: 'test', model: 'test' });
const messages = [{ role: 'user', content: '你好' }];
const request = { messages, tools: [] };
const originalFetch = globalThis.fetch;
const originalXHR = globalThis.XMLHttpRequest;
const usageBase = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const sse = (usage) => [
  { id: 'message', choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }], usage: null },
  { choices: [], usage: { ...usage, prompt_tokens_details: { cached_tokens: 0 } } },
  { choices: [], usage },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
try {
  for (const [cacheUsage, expected] of [
    [{ prompt_tokens_details: { cached_tokens: 80 } }, 80],
    [{ prompt_cache_hit_tokens: 60 }, 60],
    [{ prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 60 }, 0],
    [{}, undefined],
  ]) {
    const usage = { ...usageBase, ...cacheUsage };
    globalThis.XMLHttpRequest = undefined;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.stream) return Response.json({ id: 'message', choices: [{ message: { content: '你好' }, finish_reason: 'stop' }], usage });
      assert.equal(body.stream_options.include_usage, true, '流式应请求真实用量');
      // 分片切在事件中间，统计帧没有 choices。
      const text = sse(usage);
      return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < text.length; offset += 13) {
          controller.enqueue(new TextEncoder().encode(text.slice(offset, offset + 13)));
        }
        controller.close();
      } }));
    };
    for (const call of [() => client.chat(messages), () => client.chatWithTools(messages, [])]) {
      const result = await call();
      assert.equal(result.success, true);
      assert.equal(result.cachedTokens, expected);
      assert.equal(result.totalTokens, 120, '缓存不能重复加到总量');
    }
    // 未返回字段的后续帧不清空已经收到的统计；该案例前一帧显式报告 0。
    const expectedStream = expected ?? 0;
    for (const call of [() => client.chatStream(messages), () => client.chatStreamWithTools(messages, [])]) {
      const result = await call();
      assert.equal(result.success, true);
      assert.equal(result.cachedTokens, expectedStream);
      assert.equal(result.totalTokens, 120, 'SSE 用量帧是累计值，不能累加');
    }
    for (const adapter of [new complete.CompleteModelTurnAdapter(client), new streaming.StreamingModelTurnAdapter(client)]) {
      const result = adapter.complete ? await adapter.complete(request) : await adapter.stream(request);
      assert.equal(result.usage.cachedTokens, adapter.complete ? expected : expectedStream);
    }

    globalThis.XMLHttpRequest = class {
      status = 200;
      responseText = '';
      open() {}
      setRequestHeader() {}
      send(body) {
        assert.equal(JSON.parse(body).stream_options.include_usage, true);
        const text = sse(usage);
        for (let offset = 0; offset < text.length; offset += 11) {
          this.responseText += text.slice(offset, offset + 11);
          this.onprogress();
        }
        this.onload();
      }
    };
    const xhrResult = await client.chatStreamWithTools(messages, []);
    assert.equal(xhrResult.success, true);
    assert.equal(xhrResult.cachedTokens, expectedStream, 'Android XHR 同样保留缓存统计');
  }
  globalThis.XMLHttpRequest = undefined;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n');
  assert.equal((await client.chatStream(messages)).cachedTokens, undefined, '整条流未报告缓存时保持未知');
} finally {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXHR;
}

const { buildAssistantTurnItems } = load('src/features/chat/reply/application/AssistantTurnCommit.ts', {
  './AssistantReplyPersistence': {},
  './ChatReplyMetadata': { buildMessageMetadata: (_config, _context, extra) => extra },
  './ChatReplyUtils': { buildLogicalMessageId: () => 'logical-message', formatMessageTime: () => '12:00' },
});
const metadata = load('src/features/chat/messages/domain/chatMessageMetadata.ts', {
  ...chatSharingDependencies,
  './ChatSticker': { isStickerMessageMetadata: () => true },
});
const react = { memo: (component) => component, createElement: (type, props, ...children) => ({ type, props, children }) };
const variants = load('src/shared/theme/themeVariants.ts');
let theme = { id: 'daylight' };
const { TokenInfo } = load('src/features/chat/presentation/messages/MessageBubble/TokenInfo.tsx', {
  react: { ...react, default: react }, 'react-native': { Text: 'Text' },
  '@shared/theme': {
    ...variants, useTheme: () => theme, useThemedStyles: () => ({}),
  },
  './styles': { createMessageBubbleStyles: () => ({}) },
});
for (const cachedTokens of [80, 0, undefined]) {
  const items = buildAssistantTurnItems({
    sessionId: 'chat', response: { success: true, totalTokens: 120, promptTokens: 100, completionTokens: 20, cachedTokens },
    normalizedText: '第一段\n第二段', visibleSegments: ['第一段', '第二段'],
  });
  const first = items[0].message;
  const tail = items[1].message;
  assert.equal(metadata.parseMessageMetadata(first).cachedTokens, undefined, '非尾段不承载缓存统计');
  assert.equal(metadata.parseMessageMetadata(tail).cachedTokens, cachedTokens, '模拟重新读取消息 metadata 后保留用量');
  const props = { tokensUsed: tail.tokensUsed, promptTokens: tail.promptTokens, completionTokens: tail.completionTokens,
    cachedTokens: metadata.parseMessageMetadata(tail).cachedTokens, isMe: false };
  const text = TokenInfo(props).children.join('');
  assert.match(text, /120 tokens · 输入 100 \/ 输出 20/u);
  assert.ok(text.includes(cachedTokens === undefined ? '缓存命中 未提供' : `缓存命中 ${cachedTokens} tokens（${cachedTokens.toFixed(1)}%）`));
  assert.equal(TokenInfo({ ...props, tokensUsed: first.tokensUsed }), null, '分段提示只显示一次');
  for (const id of ['paper-note', 'moon-kimi']) {
    theme = { id };
    assert.equal(TokenInfo(props).children.join(''), text, '所有主题显示相同的真实用量');
  }
  theme = { id: 'daylight' };
}
console.log('缓存 token 验证通过：普通/工具、Fetch/XHR、末尾统计、0/未知、多气泡保存与提示。');
