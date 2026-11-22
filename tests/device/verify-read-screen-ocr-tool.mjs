import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const abortSignalRuntime = loadTypeScriptModule(
  'src/shared/runtime/abortSignal.ts',
);

class ScreenOcrObservationError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
    this.name = 'ScreenOcrObservationError';
  }
}

let currentHostAiId = 'host-ai';
let readResult;
let readError = null;
let ocrReadCalls = 0;
let authorityCalls = 0;

const screenCaptureMock = {
  ScreenOcrObservationError,
  readOcrForCurrentWindow: async () => {
    ocrReadCalls += 1;
    if (readError) throw readError;
    return readResult;
  },
};

const toolModule = loadTypeScriptModule(
  'src/features/screenCapture/aiTools/ReadScreenOcrTool.ts',
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
    '../application/ScreenOcrObservation': screenCaptureMock,
    '../application/ScreenOcrObservationPolicy': screenCaptureMock,
    '@shared/runtime/abortSignal': abortSignalRuntime,
  },
);

const { definition, execute } = toolModule;
assert.equal(definition.name, 'read_screen_ocr');
// 描述措辞属于文案，不做实现锁定；只保留「不得夸大成实时/可点击视觉」的能力边界断言。
assert.doesNotMatch(definition.description, /实时观察|图像理解|点击|可点击/u);
assert.deepEqual(definition.parameters.properties, {});
assert.equal(definition.parameters.additionalProperties, false);

const emptyTruncation = {
  blockLimitReached: false,
  lineLimitReached: false,
  characterLimitReached: false,
};
const articleSnapshot = {
  packageName: 'com.example.article',
  windowId: 17,
  capturedAtEpochMs: 1_700_000_000_000,
  width: 1080,
  height: 2400,
  plainText: '标题\n正文',
  blocks: [
    { text: '标题', lines: [{ text: '标题' }] },
    { text: '正文', lines: [{ text: '正文' }] },
  ],
  truncated: false,
  truncation: emptyTruncation,
};

const contextFor = (actorAiId = 'host-ai', abortSignal = new AbortController().signal) => ({
  getAIId: () => actorAiId,
  abortSignal,
});

// Case 1：正常 OCR。
readResult = articleSnapshot;
readError = null;
ocrReadCalls = 0;
authorityCalls = 0;
const articleResult = await execute({}, contextFor());
assert.equal(articleResult.success, true);
assert.equal(ocrReadCalls, 1);
assert.equal(authorityCalls, 1);
assert.deepEqual(articleResult.data, articleSnapshot);
assert.equal(typeof articleResult.message, 'string');
assert.match(articleResult.message, /com\.example\.article/u);
assert.match(articleResult.message, /标题/u);
assert.match(articleResult.message, /正文/u);
assert.notEqual(articleResult.message, 'OCR 读取成功');
assert.ok(
  articleResult.message.includes(articleSnapshot.plainText),
  'Tool message 必须把真实 OCR 文字作为模型正文返回，而不是只返回成功提示',
);

// Case 2：Host Authority。
currentHostAiId = 'new-host-ai';
ocrReadCalls = 0;
authorityCalls = 0;
const staleHostResult = await execute({}, contextFor('host-ai'));
assert.equal(staleHostResult.success, false);
assert.equal(staleHostResult.errorCode, 'not_current_host');
assert.match(staleHostResult.error, /^not_current_host:/u);
assert.equal(authorityCalls, 1);
assert.equal(
  ocrReadCalls,
  0,
  '已经失去 Host Authority 的旧 AI 不得先触发截图或 OCR',
);

ocrReadCalls = 0;
authorityCalls = 0;
const missingActorResult = await execute({}, {
  getAIId: () => undefined,
  abortSignal: new AbortController().signal,
});
assert.equal(missingActorResult.success, false);
assert.equal(missingActorResult.errorCode, 'missing_actor_ai_id');
assert.match(missingActorResult.error, /^missing_actor_ai_id:/u);
assert.equal(authorityCalls, 0, '缺少 actor 时不得进入 authority action');
assert.equal(ocrReadCalls, 0, '缺少 actor 时不得读取屏幕内容');

// Case 3：Abort。
currentHostAiId = 'host-ai';
const abortController = new AbortController();
abortController.abort(new Error('screen ocr cancelled'));
ocrReadCalls = 0;
await assert.rejects(
  () => execute({}, contextFor('host-ai', abortController.signal)),
  /screen ocr cancelled/u,
  'Tool 必须保持既有 abort semantics，不得把取消吞成业务失败',
);
assert.equal(ocrReadCalls, 0, 'abort 后不得调用 OCR foundation');

// Case 4：no_text 是成功，不 fallback。
readError = null;
readResult = {
  ...articleSnapshot,
  plainText: '',
  blocks: [],
};
const noTextResult = await execute({}, contextFor());
assert.equal(noTextResult.success, true, '没有 OCR 文字仍是正常观察成功');
assert.equal(noTextResult.data.plainText, '');
assert.deepEqual(noTextResult.data.blocks, []);
assert.match(
  noTextResult.message,
  /no_text|未识别.{0,12}(文字|文本)|没有.{0,12}(文字|文本)/iu,
  'no_text 必须向模型明确表达，而不是伪装成 ocr_failed',
);
assert.doesNotMatch(noTextResult.message, /ocr_failed|semantic_read_failed/u);

// Case 5：protected_app 必须明确给 AI。
readError = new ScreenOcrObservationError('protected_app', '该应用被用户设置为受保护应用');
const protectedResult = await execute({}, contextFor());
assert.equal(protectedResult.success, false);
assert.equal(protectedResult.errorCode, 'protected_app');
assert.match(protectedResult.error, /^protected_app:/u);
assert.match(protectedResult.error, /受保护/u);

// Case 6：screen capture typed failures 原样透传。
for (const reason of [
  'accessibility_disabled',
  'accessibility_disconnected',
  'screenshot_capability_missing',
  'window_unavailable',
  'window_changed',
  'secure_window',
  'capture_failed',
]) {
  readError = new ScreenOcrObservationError(reason, `${reason} diagnostic`);
  const result = await execute({}, contextFor());
  assert.equal(result.success, false, `${reason} 必须返回 Tool failure`);
  assert.equal(result.errorCode, reason, `${reason} 必须保留 typed error reason`);
  assert.match(result.error, new RegExp(`^${reason}:`));
  assert.match(result.error, /diagnostic/u);
}

// Case 7：OCR-specific failures 原样透传。
for (const reason of ['invalid_ocr_input', 'ocr_failed', 'snapshot_release_failed']) {
  readError = new ScreenOcrObservationError(reason, `${reason} diagnostic`);
  const result = await execute({}, contextFor());
  assert.equal(result.success, false, `${reason} 必须返回 Tool failure`);
  assert.equal(result.errorCode, reason, `${reason} 必须保留 typed error reason`);
  assert.match(result.error, new RegExp(`^${reason}:`));
}

// snapshot_release_failed 不得被改名为普通 OCR failure，也不得 success=true。
readError = new ScreenOcrObservationError('snapshot_release_failed', 'OCR 临时截图未能按预期释放。');
const releaseFailedResult = await execute({}, contextFor());
assert.equal(releaseFailedResult.success, false);
assert.equal(releaseFailedResult.errorCode, 'snapshot_release_failed');
assert.notEqual(releaseFailedResult.errorCode, 'ocr_failed');

// Case 8：未知异常不得被伪装成业务失败。
readError = new Error('programmer invariant failed');
await assert.rejects(
  () => execute({}, contextFor()),
  /programmer invariant failed/u,
  '未知 programmer error 不得被伪装成某个 ScreenOcrObservationFailureReason',
);

// Case 9：truncated snapshot 必须让模型知道结果不完整。
readError = null;
readResult = {
  ...articleSnapshot,
  plainText: '裁剪后的文字',
  truncated: true,
  truncation: {
    blockLimitReached: false,
    lineLimitReached: false,
    characterLimitReached: true,
  },
};
const truncatedResult = await execute({}, contextFor());
assert.equal(truncatedResult.success, true);
assert.match(truncatedResult.message, /裁剪|不完整|truncated/iu);
assert.match(truncatedResult.message, /characterLimitReached=true/u);

// Case 10：不重复 plainText / blocks / lines。
const repeatedText = 'AAA'.repeat(80);
readResult = {
  packageName: 'com.example.long-page',
  windowId: 29,
  capturedAtEpochMs: 1_700_000_000_001,
  width: 1080,
  height: 2400,
  plainText: repeatedText,
  blocks: [{ text: repeatedText, lines: [{ text: repeatedText }] }],
  truncated: false,
  truncation: emptyTruncation,
};
const repeatedResult = await execute({}, contextFor());
assert.equal(repeatedResult.success, true);
assert.ok(repeatedResult.message.includes(repeatedText));
assert.equal(
  repeatedResult.message.split(repeatedText).length - 1,
  1,
  '完整 plainText 不应因为 blocks/lines 含相同文字而被机械重复输出',
);
assert.doesNotMatch(repeatedResult.message, /"blocks"\s*:/u, '模型正文不得机械 JSON.stringify 整棵 snapshot');
assert.ok(
  repeatedResult.message.length <= repeatedText.length * 1.5 + 400,
  'OCR modelContent 应保持 compact，不得因重复展开膨胀',
);

// Case 11：snapshot data / message 无 screenshot URI。
readResult = articleSnapshot;
const noUriResult = await execute({}, contextFor());
assert.equal(noUriResult.success, true);
assert.doesNotMatch(noUriResult.message, /file:\/\/|device-observer/u);
assert.doesNotMatch(
  JSON.stringify(noUriResult.data),
  /file:\/\/|device-observer/u,
  'Tool 不得把 screenshot URI 放入 data 或 message',
);

console.log('PHONE-5B read_screen_ocr Tool contracts verified.');
