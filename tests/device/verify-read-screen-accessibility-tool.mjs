import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const abortSignalRuntime = loadTypeScriptModule(
  'src/shared/runtime/abortSignal.ts',
);

class ScreenSemanticObservationError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
    this.name = 'ScreenSemanticObservationError';
  }
}

let currentHostAiId = 'host-ai';
let readResult;
let readError = null;
let semanticReadCalls = 0;
let authorityCalls = 0;

const screenCaptureMock = {
  ScreenSemanticObservationError,
  readAccessibilitySemanticsForCurrentWindow: async () => {
    semanticReadCalls += 1;
    if (readError) throw readError;
    return readResult;
  },
};

const toolModule = loadTypeScriptModule(
  'src/features/screenCapture/aiTools/ReadScreenAccessibilityTool.ts',
  {
    '@features/assistants': {
      runAsCurrentHostAuthority: async (actorAiId, action) => {
        authorityCalls += 1;
        if (actorAiId !== currentHostAiId) {
          return { status: 'not_current_host' };
        }
        return { status: 'authorized', value: await action() };
      },
    },
    '@features/screenCapture': screenCaptureMock,
    '../application/ScreenSemanticObservation': screenCaptureMock,
    '../application/ScreenSemanticObservationPolicy': screenCaptureMock,
    '@shared/runtime/abortSignal': abortSignalRuntime,
  },
);

const { definition, execute } = toolModule;
assert.equal(definition.name, 'read_screen_accessibility');
assert.deepEqual(definition.parameters.properties, {});
assert.equal(definition.parameters.additionalProperties, false);

const emptyTruncation = {
  nodeLimitReached: false,
  depthLimitReached: false,
  characterLimitReached: false,
};
const articleSnapshot = {
  packageName: 'com.example.article',
  windowId: 17,
  capturedAtEpochMs: 1_700_000_000_000,
  nodes: [
    {
      depth: 0,
      text: '文章标题',
      className: 'android.widget.TextView',
      clickable: false,
      editable: false,
      password: false,
    },
    {
      depth: 2,
      text: '正文第一段：Accessibility 暴露的真实页面内容。',
      className: 'android.widget.TextView',
      clickable: false,
      editable: false,
      password: false,
    },
    {
      depth: 3,
      text: '发送',
      className: 'android.widget.Button',
      clickable: true,
      editable: false,
      password: false,
    },
    {
      depth: 3,
      contentDescription: '评论输入框',
      className: 'android.widget.EditText',
      clickable: false,
      editable: true,
      password: false,
    },
  ],
  plainText: '文章标题\n正文第一段：Accessibility 暴露的真实页面内容。\n发送\n评论输入框',
  truncated: false,
  truncation: emptyTruncation,
};

const contextFor = (actorAiId = 'host-ai', abortSignal = new AbortController().signal) => ({
  getAIId: () => actorAiId,
  abortSignal,
});

readResult = articleSnapshot;
readError = null;
semanticReadCalls = 0;
authorityCalls = 0;
const articleResult = await execute({}, contextFor());
assert.equal(articleResult.success, true);
assert.equal(semanticReadCalls, 1);
assert.equal(authorityCalls, 1);
assert.deepEqual(articleResult.data, articleSnapshot);
assert.equal(typeof articleResult.message, 'string');
assert.match(articleResult.message, /com\.example\.article/u);
assert.match(articleResult.message, /文章标题/u);
assert.match(articleResult.message, /发送/u);
assert.match(articleResult.message, /android\.widget\.Button|clickable|交互/u);
assert.notEqual(articleResult.message, '页面读取成功');
assert.ok(
  articleResult.message.includes(articleSnapshot.plainText),
  'Tool message 必须把真实页面语义作为模型正文返回，而不是只返回成功提示',
);

currentHostAiId = 'new-host-ai';
semanticReadCalls = 0;
authorityCalls = 0;
const staleHostResult = await execute({}, contextFor('host-ai'));
assert.equal(staleHostResult.success, false);
assert.equal(staleHostResult.errorCode, 'not_current_host');
assert.match(staleHostResult.error, /^not_current_host:/u);
assert.equal(authorityCalls, 1);
assert.equal(
  semanticReadCalls,
  0,
  '已经失去 Host Authority 的旧 AI 不得先读取屏幕内容',
);

semanticReadCalls = 0;
authorityCalls = 0;
const missingActorResult = await execute({}, {
  getAIId: () => undefined,
  abortSignal: new AbortController().signal,
});
assert.equal(missingActorResult.success, false);
assert.equal(missingActorResult.errorCode, 'missing_actor_ai_id');
assert.match(missingActorResult.error, /^missing_actor_ai_id:/u);
assert.equal(authorityCalls, 0, '缺少 actor 时不得进入 authority action');
assert.equal(semanticReadCalls, 0, '缺少 actor 时不得读取屏幕内容');

currentHostAiId = 'host-ai';
const abortController = new AbortController();
abortController.abort(new Error('screen read cancelled'));
semanticReadCalls = 0;
await assert.rejects(
  () => execute({}, contextFor('host-ai', abortController.signal)),
  /screen read cancelled/u,
  'Tool 必须保持既有 abort semantics，不得把取消吞成业务失败',
);
assert.equal(semanticReadCalls, 0, 'abort 后不得调用 PHONE-4A application API');

const typedReasons = [
  'accessibility_disabled',
  'accessibility_disconnected',
  'window_unavailable',
  'window_changed',
  'protected_app',
  'semantic_read_failed',
];
for (const reason of typedReasons) {
  readError = new ScreenSemanticObservationError(reason, `${reason} diagnostic`);
  const result = await execute({}, contextFor());
  assert.equal(result.success, false, `${reason} 必须返回 Tool failure`);
  assert.equal(result.errorCode, reason, `${reason} 必须保留 typed error reason`);
  assert.match(result.error, new RegExp(`^${reason}:`));
  assert.match(result.error, /diagnostic/u);
}

readError = null;
readResult = {
  ...articleSnapshot,
  nodes: [{
    depth: 1,
    className: 'android.view.SurfaceView',
    clickable: true,
    editable: false,
    password: false,
  }],
  plainText: '',
};
const noTextResult = await execute({}, contextFor());
assert.equal(noTextResult.success, true, '没有 Accessibility 文字仍是正常观察成功');
assert.equal(noTextResult.data.plainText, '');
assert.match(
  noTextResult.message,
  /no_text|未暴露.{0,12}(文字|文本)|没有.{0,12}(文字|文本)/iu,
  'no_text 必须向模型明确表达，而不是伪装成 semantic_read_failed',
);
assert.doesNotMatch(noTextResult.message, /semantic_read_failed/u);

const largeNodes = Array.from({ length: 200 }, (_, index) => ({
  depth: index % 6,
  text: `row-${index} ${'x'.repeat(96)}`,
  className: index % 2 === 0 ? 'android.widget.Button' : 'android.widget.TextView',
  clickable: index % 2 === 0,
  editable: index % 5 === 0,
  password: false,
}));
const largePlainText = largeNodes.map((node) => node.text).join('\n');
readResult = {
  packageName: 'com.example.long-page',
  windowId: 29,
  capturedAtEpochMs: 1_700_000_000_001,
  nodes: largeNodes,
  plainText: largePlainText,
  truncated: true,
  truncation: {
    nodeLimitReached: true,
    depthLimitReached: false,
    characterLimitReached: true,
  },
};
const firstLargeResult = await execute({}, contextFor());
const secondLargeResult = await execute({}, contextFor());
assert.equal(firstLargeResult.success, true);
assert.equal(firstLargeResult.message, secondLargeResult.message, 'modelContent 必须 deterministic');
assert.match(firstLargeResult.message, /truncated|裁剪|部分内容/iu);
assert.doesNotMatch(firstLargeResult.message, /"nodes"\s*:/u, '模型正文不得机械 JSON.stringify 整棵 snapshot');
assert.ok(firstLargeResult.message.includes(largePlainText));
assert.equal(
  firstLargeResult.message.split(largePlainText).length - 1,
  1,
  '完整 plainText 不应因为同时展开 nodes 被机械重复输出',
);
assert.ok(
  firstLargeResult.message.length <= largePlainText.length * 2.5 + 6_000,
  '有限 snapshot 的 modelContent 应保持 compact，不得因重复展开膨胀数倍',
);

readError = new Error('programmer invariant failed');
await assert.rejects(
  () => execute({}, contextFor()),
  /programmer invariant failed/u,
  '未知 programmer error 不得被伪装成某个 ScreenSemanticObservationFailureReason',
);

console.log('PHONE-4B read_screen_accessibility Tool contracts verified.');
