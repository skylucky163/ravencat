import assert from 'node:assert/strict';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';

const protectedPolicy = loadTypeScriptModule(
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
);
const observationPolicy = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenObservationPolicy.ts',
  {
    '@features/deviceControl': {},
    '@features/phoneTools': protectedPolicy,
  },
);
const capturePolicy = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenCapturePolicy.ts',
);
const ocrPolicy = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenOcrObservationPolicy.ts',
  { './ScreenCapturePolicy': capturePolicy },
);
const { ScreenOcrObservationError } = ocrPolicy;

const connection = {
  accessibilityEnabled: true,
  accessibilityConnected: true,
  canRetrieveWindowContent: true,
  canTakeScreenshot: true,
  connectedAtEpochMs: 1,
  lastDisconnectedAtEpochMs: 0,
  lastEventAtEpochMs: 1,
};
const windowA = {
  packageName: 'com.example.article',
  windowId: 17,
  title: '文章',
  detectionReliable: true,
  checkedAtEpochMs: 1,
  source: 'accessibility',
};
const windowB = {
  ...windowA,
  packageName: 'com.example.chat',
  windowId: 23,
};
const SCREENSHOT_URI = 'file:///data/user/0/com.ravencat/cache/device-observer/ravencat_1_100.png';
const CAPTURED_AT_EPOCH_MS = 100;

let currentConnection = connection;
let currentWindow = windowA;
let protectedPackages = [];
let captureCalls = 0;
let ocrCalls = 0;
let releaseCalls = 0;
let nativeCapture = async () => ({
  uri: SCREENSHOT_URI,
  width: 1080,
  height: 2400,
  mimeType: 'image/png',
  capturedAtEpochMs: CAPTURED_AT_EPOCH_MS,
  packageName: windowA.packageName,
  windowId: windowA.windowId,
  source: 'accessibility_window',
});
let nativeRecognize = async () => ({
  blocks: [{ lines: [{ text: '测试文字' }] }],
  truncation: {
    blockLimitReached: false,
    lineLimitReached: false,
    characterLimitReached: false,
  },
});
let nativeRelease = async () => {};

const screenCapture = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenCapture.ts',
  {
    '@features/deviceControl': {
      getDeviceObserverConnectionState: async () => currentConnection,
      getCurrentWindowState: async () => currentWindow,
      captureDeviceObserverScreenshot: async () => {
        captureCalls += 1;
        return nativeCapture();
      },
      deleteDeviceObserverScreenshot: async () => {
        releaseCalls += 1;
        await nativeRelease();
      },
    },
    '@features/phoneTools': {
      loadCurrentProtectedPackages: async () => protectedPackages,
    },
    './ScreenCapturePolicy': capturePolicy,
    './ScreenObservationPolicy': observationPolicy,
  },
);

const ocrObservation = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenOcrObservation.ts',
  {
    '@features/deviceControl': {
      recognizeDeviceObserverScreenshotText: async (uri) => {
        ocrCalls += 1;
        assert.equal(uri, SCREENSHOT_URI, 'OCR 只能消费本次已经冻结的 screenshot');
        return nativeRecognize();
      },
    },
    './ScreenCapture': screenCapture,
    './ScreenCapturePolicy': capturePolicy,
    './ScreenOcrObservationPolicy': ocrPolicy,
  },
);
const {
  normalizeScreenOcrSnapshot,
  readOcrForCurrentWindow,
  SCREEN_OCR_LIMITS,
} = ocrObservation;

function reset() {
  currentConnection = connection;
  currentWindow = windowA;
  protectedPackages = [];
  captureCalls = 0;
  ocrCalls = 0;
  releaseCalls = 0;
  nativeCapture = async () => ({
    uri: SCREENSHOT_URI,
    width: 1080,
    height: 2400,
    mimeType: 'image/png',
    capturedAtEpochMs: CAPTURED_AT_EPOCH_MS,
    packageName: windowA.packageName,
    windowId: windowA.windowId,
    source: 'accessibility_window',
  });
  nativeRecognize = async () => ({
    blocks: [{ lines: [{ text: '测试文字' }] }],
    truncation: {
      blockLimitReached: false,
      lineLimitReached: false,
      characterLimitReached: false,
    },
  });
  nativeRelease = async () => {};
}

// Case 1 / 2：一次截图、一次 OCR、一次释放。
reset();
const normal = await readOcrForCurrentWindow();
assert.equal(normal.packageName, windowA.packageName);
assert.equal(normal.windowId, windowA.windowId);
assert.equal(normal.capturedAtEpochMs, CAPTURED_AT_EPOCH_MS);
assert.equal(normal.plainText, '测试文字');
assert.deepEqual(normal.blocks, [{ text: '测试文字', lines: [{ text: '测试文字' }] }]);
assert.equal(normal.truncated, false);
assert.equal(captureCalls, 1, '一次 OCR 观察最多发起一次截图');
assert.equal(ocrCalls, 1, '一次 OCR 观察只执行一次识别');
assert.equal(releaseCalls, 1, '临时 screenshot 必须被释放');
assert.doesNotMatch(
  JSON.stringify(normal),
  /device-observer|file:\/\//,
  'OCR 快照不得把 screenshot URI 暴露给上层',
);

// Case 3：freeze 后切到 B。
reset();
nativeRecognize = async () => {
  currentWindow = windowB;
  return {
    blocks: [{ lines: [{ text: '测试文字' }] }],
    truncation: {
      blockLimitReached: false,
      lineLimitReached: false,
      characterLimitReached: false,
    },
  };
};
const frozenAcrossWindowChange = await readOcrForCurrentWindow();
assert.equal(frozenAcrossWindowChange.packageName, windowA.packageName);
assert.equal(frozenAcrossWindowChange.plainText, '测试文字');
assert.equal(captureCalls, 1, 'snapshot 冻结后切窗不得重新截图');
assert.equal(ocrCalls, 1);

// Case 4：A → B → A。
reset();
nativeRecognize = async () => {
  currentWindow = windowB;
  currentWindow = windowA;
  return {
    blocks: [{ lines: [{ text: '测试文字' }] }],
    truncation: {
      blockLimitReached: false,
      lineLimitReached: false,
      characterLimitReached: false,
    },
  };
};
const frozenAcrossAba = await readOcrForCurrentWindow();
assert.equal(frozenAcrossAba.packageName, windowA.packageName);
assert.equal(captureCalls, 1);
assert.equal(ocrCalls, 1);

// Case 12：identity 不漂移。
reset();
nativeCapture = async () => ({
  uri: SCREENSHOT_URI,
  width: 1080,
  height: 2400,
  mimeType: 'image/png',
  capturedAtEpochMs: CAPTURED_AT_EPOCH_MS,
  packageName: windowA.packageName,
  windowId: windowA.windowId,
  source: 'accessibility_window',
});
nativeRecognize = async () => {
  currentWindow = windowB;
  return {
    blocks: [{ lines: [{ text: '测试文字' }] }],
    truncation: {
      blockLimitReached: false,
      lineLimitReached: false,
      characterLimitReached: false,
    },
  };
};
const frozenIdentity = await readOcrForCurrentWindow();
assert.equal(frozenIdentity.packageName, windowA.packageName);
assert.equal(frozenIdentity.windowId, windowA.windowId);

// Case 5：Protected App 不产生任何截图与 OCR。
reset();
protectedPackages = [windowA.packageName];
await assert.rejects(
  readOcrForCurrentWindow(),
  (error) => error instanceof ScreenOcrObservationError && error.reason === 'protected_app',
);
assert.equal(captureCalls, 0, '受保护应用不得发起 native 截图');
assert.equal(ocrCalls, 0, '受保护应用不得执行 OCR');
assert.equal(releaseCalls, 0, '没有产生截图时不需要释放');

// Case 6：冻结前 window_changed。
reset();
nativeCapture = async () => {
  throw Object.assign(new Error('快照冻结前当前窗口已经变化'), { reason: 'window_changed' });
};
await assert.rejects(
  readOcrForCurrentWindow(),
  (error) => error instanceof ScreenOcrObservationError && error.reason === 'window_changed',
);
assert.equal(ocrCalls, 0, '截图未通过 capture fence 时不得执行 OCR');

// Case 7：no_text 是成功。
reset();
nativeRecognize = async () => ({
  blocks: [],
  truncation: {
    blockLimitReached: false,
    lineLimitReached: false,
    characterLimitReached: false,
  },
});
const noText = await readOcrForCurrentWindow();
assert.equal(noText.plainText, '');
assert.deepEqual(noText.blocks, []);
assert.equal(noText.truncated, false);
assert.equal(captureCalls, 1, 'no_text 不是重试条件');
assert.equal(ocrCalls, 1);
assert.equal(releaseCalls, 1);

// Case 8：OCR failure 不重新截图，且必须释放。
for (const reason of ['ocr_failed', 'invalid_ocr_input']) {
  reset();
  nativeRecognize = async () => {
    throw Object.assign(new Error('本地 OCR 识别失败'), { reason });
  };
  await assert.rejects(
    readOcrForCurrentWindow(),
    (error) => error instanceof ScreenOcrObservationError && error.reason === reason,
  );
  assert.equal(captureCalls, 1, 'OCR 失败不得重新截图');
  assert.equal(ocrCalls, 1);
  assert.equal(releaseCalls, 1, 'OCR 失败也必须释放临时 screenshot');
}

// Case 9：normalization failure 也必须释放。
reset();
nativeRecognize = async () => ({ blocks: null });
await assert.rejects(
  readOcrForCurrentWindow(),
  (error) => error instanceof ScreenOcrObservationError && error.reason === 'ocr_failed',
);
assert.equal(releaseCalls, 1, 'normalization 失败也必须释放临时 screenshot');

// Case 9b / 9c：冻结截图缺少窗口身份时，在建立 ScreenOcrSnapshot 前硬失败，但仍释放。
for (const [field, value] of [['packageName', null], ['windowId', null]]) {
  reset();
  nativeCapture = async () => ({
    uri: SCREENSHOT_URI,
    width: 1080,
    height: 2400,
    mimeType: 'image/png',
    capturedAtEpochMs: CAPTURED_AT_EPOCH_MS,
    packageName: windowA.packageName,
    windowId: windowA.windowId,
    source: 'accessibility_window',
    [field]: value,
  });
  await assert.rejects(
    readOcrForCurrentWindow(),
    (error) => error instanceof ScreenOcrObservationError && error.reason === 'capture_failed',
    `冻结截图 ${field} 为空时必须返回 capture_failed`,
  );
  assert.equal(releaseCalls, 1, 'identity 缺失也必须释放临时 screenshot');
  assert.equal(captureCalls, 1);
}

// Case 10a：OCR 成功但释放失败。
reset();
nativeRelease = async () => {
  throw Object.assign(new Error('设备观察截图删除失败'), { reason: 'image_write_failed' });
};
await assert.rejects(
  readOcrForCurrentWindow(),
  (error) => (
    error instanceof ScreenOcrObservationError && error.reason === 'snapshot_release_failed'
  ),
  'OCR 成功但临时 screenshot 未释放时不得假装完整成功',
);
assert.equal(ocrCalls, 1);
assert.equal(releaseCalls, 1, '释放失败不做 retry loop');

// Case 10b：OCR 失败且释放失败时保留主失败语义。
reset();
nativeRecognize = async () => {
  throw Object.assign(new Error('本地 OCR 识别失败'), { reason: 'ocr_failed' });
};
nativeRelease = async () => {
  throw Object.assign(new Error('设备观察截图删除失败'), { reason: 'image_write_failed' });
};
await assert.rejects(
  readOcrForCurrentWindow(),
  (error) => {
    assert.ok(error instanceof ScreenOcrObservationError);
    assert.equal(error.reason, 'ocr_failed', 'OCR 主失败原因不得被释放失败覆盖');
    assert.ok(error.cause, '释放失败不得被静默吞掉');
    assert.doesNotMatch(
      JSON.stringify(error.cause instanceof Error ? error.cause.message : String(error.cause)),
      /device-observer|file:\/\//,
      '诊断不得携带 screenshot URI',
    );
    return true;
  },
);

// Case 11：capturedAtEpochMs 是截图冻结时间，不是 OCR 完成时间。
reset();
nativeCapture = async () => ({
  uri: SCREENSHOT_URI,
  width: 1080,
  height: 2400,
  mimeType: 'image/png',
  capturedAtEpochMs: 100,
  packageName: windowA.packageName,
  windowId: windowA.windowId,
  source: 'accessibility_window',
});
nativeRecognize = async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    blocks: [{ lines: [{ text: '测试文字' }] }],
    truncation: {
      blockLimitReached: false,
      lineLimitReached: false,
      characterLimitReached: false,
    },
  };
};
const delayed = await readOcrForCurrentWindow();
assert.equal(delayed.capturedAtEpochMs, 100);

// Case 13：bounded snapshot。
const frozenCapture = {
  screenshot: {
    uri: SCREENSHOT_URI,
    width: 1080,
    height: 2400,
    mimeType: 'image/png',
    capturedAtEpochMs: CAPTURED_AT_EPOCH_MS,
    packageName: windowA.packageName,
    windowId: windowA.windowId,
    source: 'accessibility_window',
  },
  windowState: windowA,
};
const noTruncation = {
  blockLimitReached: false,
  lineLimitReached: false,
  characterLimitReached: false,
};
const normalizeWith = (blocks, truncation = noTruncation) => normalizeScreenOcrSnapshot(
  { blocks, truncation },
  frozenCapture,
);

const blockBounded = normalizeWith(
  Array.from(
    { length: SCREEN_OCR_LIMITS.maxBlocks + 20 },
    (_, index) => ({
      lines: [{ text: `block-${index}-a` }, { text: `block-${index}-b` }],
    }),
  ),
);
assert.equal(blockBounded.blocks.length, SCREEN_OCR_LIMITS.maxBlocks);
assert.equal(blockBounded.truncated, true);
assert.equal(blockBounded.truncation.blockLimitReached, true);
assert.equal(blockBounded.truncation.lineLimitReached, false);
assert.equal(
  blockBounded.blocks.reduce((total, block) => total + block.lines.length, 0),
  SCREEN_OCR_LIMITS.maxLines,
);

const lineBounded = normalizeWith(
  [{
    lines: Array.from(
      { length: SCREEN_OCR_LIMITS.maxLines + 88 },
      (_, index) => ({ text: `line-${index}` }),
    ),
  }],
);
assert.equal(lineBounded.blocks.length, 1);
assert.equal(lineBounded.blocks[0].lines.length, SCREEN_OCR_LIMITS.maxLines);
assert.equal(lineBounded.truncated, true);
assert.equal(lineBounded.truncation.lineLimitReached, true);

const characterBounded = normalizeWith(
  [{
    lines: Array.from({ length: 40 }, () => ({ text: 'y'.repeat(2_000) })),
  }],
);
assert.equal(characterBounded.truncation.characterLimitReached, true);
assert.ok(
  characterBounded.blocks[0].lines.reduce((total, line) => total + line.text.length, 0)
    <= SCREEN_OCR_LIMITS.maxTotalCharacters,
);

const lineCharacterBounded = normalizeWith(
  [{ lines: [{ text: 'y'.repeat(SCREEN_OCR_LIMITS.maxLineCharacters + 3_000) }] }],
);
assert.equal(lineCharacterBounded.blocks[0].lines[0].text.length, SCREEN_OCR_LIMITS.maxLineCharacters);
assert.equal(lineCharacterBounded.truncation.characterLimitReached, true);

for (const snapshot of [blockBounded, lineBounded, characterBounded, lineCharacterBounded]) {
  assert.equal(
    snapshot.plainText,
    snapshot.blocks.map((block) => block.text).join('\n'),
    'plainText 必须与 blocks 属于同一 bounded snapshot',
  );
}

// Case 14：native truncation 必须继续传播。
const nativeTruncated = normalizeWith(
  [{ lines: [{ text: '少量文字' }] }],
  { blockLimitReached: false, lineLimitReached: false, characterLimitReached: true },
);
assert.equal(nativeTruncated.truncated, true, 'native 裁剪不得被 application 丢弃');
assert.equal(nativeTruncated.truncation.characterLimitReached, true);

// 空行、CRLF 与行内空白 normalization。
const normalized = normalizeWith([{
  lines: [{ text: '  第一行\r\n' }, { text: '   ' }, { text: 'hello    world  ' }],
}]);
assert.deepEqual(normalized.blocks, [{
  text: '第一行\nhello    world',
  lines: [{ text: '第一行' }, { text: 'hello    world' }],
}]);
assert.equal(normalized.plainText, '第一行\nhello    world');

// 隐私与职责边界：OCR primitive 不得重新拥有截图策略。
const nativeModule = read(
  'modules/device-observer/android/src/main/java/expo/modules/deviceobserver/DeviceObserverModule.kt',
);
const recognizer = read(
  'modules/device-observer/android/src/main/java/expo/modules/deviceobserver/ManagedScreenshotTextRecognizer.kt',
);
assert.match(nativeModule, /AsyncFunction\("recognizeScreenshotText"\) Coroutine \{ uri: String/);
const recognizeFunctionBody = nativeModule.slice(
  nativeModule.indexOf('AsyncFunction("recognizeScreenshotText")'),
  nativeModule.indexOf('AsyncFunction("deleteScreenshot")'),
);
assert.doesNotMatch(
  recognizeFunctionBody,
  /expectedWindow|protectedPackages|rootInActiveWindow|getCurrentWindowState/,
  'OCR 原生入口不得重新拥有截图、窗口与受保护应用策略',
);
assert.match(recognizer, /ManagedScreenshotFile\.resolve/);
assert.match(recognizer, /ChineseTextRecognizerOptions/);
assert.match(recognizer, /Tasks\.await/);
assert.match(recognizer, /recognizer\.close\(\)/);
assert.doesNotMatch(recognizer, /getCurrentWindowState|ProtectedApps|rootInActiveWindow/);
const buildGradle = read('modules/device-observer/android/build.gradle');
assert.match(buildGradle, /com\.google\.mlkit:text-recognition-chinese:16\.0\.1/);
assert.doesNotMatch(buildGradle, /play-services-mlkit/);

// raw OCR bridge shape 不含 block.text：block 文本由消费方从保留的 lines 派生。
const ocrSnapshotKt = read(
  'modules/device-observer/android/src/main/java/expo/modules/deviceobserver/DeviceOcrSnapshot.kt',
);
const nativeBlockBody = ocrSnapshotKt.slice(
  ocrSnapshotKt.indexOf('internal data class DeviceOcrBlock('),
  ocrSnapshotKt.indexOf('internal data class DeviceOcrTruncation('),
);
assert.doesNotMatch(
  nativeBlockBody,
  /\btext\b/,
  'native DeviceOcrBlock 不得携带 block.text',
);
const nativeModuleTs = read('modules/device-observer/src/DeviceObserverModule.ts');
const bridgeBlockBody = nativeModuleTs.slice(
  nativeModuleTs.indexOf('export type DeviceOcrBlock'),
  nativeModuleTs.indexOf('export type DeviceOcrSnapshot'),
);
assert.doesNotMatch(
  bridgeBlockBody,
  /\btext\b/,
  'bridge DeviceOcrBlock 不得声明 block.text',
);
const portBlockBody = read(
  'src/features/deviceControl/application/DeviceObserverPort.ts',
).slice(
  read('src/features/deviceControl/application/DeviceObserverPort.ts')
    .indexOf('export interface DeviceObserverOcrBlock'),
  read('src/features/deviceControl/application/DeviceObserverPort.ts')
    .indexOf('export interface DeviceObserverOcrSnapshot'),
);
assert.doesNotMatch(
  portBlockBody,
  /\btext\b/,
  'port DeviceObserverOcrBlock 不得声明 block.text',
);

// ScreenOcrObservationFailureReason 必须由 const tuple 直接派生。
const ocrPolicySource = read(
  'src/features/screenCapture/application/ScreenOcrObservationPolicy.ts',
);
assert.match(
  ocrPolicySource,
  /export type ScreenOcrObservationFailureReason =\s*\n\s*\(typeof SCREEN_OCR_OBSERVATION_FAILURE_REASONS\)\[number\];/,
  'failure reason union 必须从 const tuple 派生',
);

// PHONE-5B：OCR 已注册为生产 AI Tool，Catalog 已 available。
const toolRegistry = read('src/host/composition/agent/createAgentToolRegistry.ts');
assert.match(toolRegistry, /ReadScreenOcrTool/);
const ocrTool = read('src/features/screenCapture/aiTools/ReadScreenOcrTool.ts');
assert.match(ocrTool, /read_screen_ocr/);
const catalog = loadTypeScriptModule('src/features/phoneTools/domain/PhoneToolCatalog.ts');
assert.equal(
  catalog.PHONE_TOOL_CATALOG.find((item) => item.toolName === 'read_screen_ocr')
    .implementationStatus,
  'available',
  'PHONE-5B 完成后 read_screen_ocr 必须是 available',
);

console.log('Screen OCR observation 契约检查通过。');
