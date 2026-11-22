import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

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
const semanticPolicy = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenSemanticObservationPolicy.ts',
);

const connection = {
  accessibilityEnabled: true,
  accessibilityConnected: true,
  canRetrieveWindowContent: true,
  canTakeScreenshot: true,
  connectedAtEpochMs: 1,
  lastDisconnectedAtEpochMs: 0,
  lastEventAtEpochMs: 1,
};
const reliableWindow = {
  packageName: 'com.example.article',
  windowId: 17,
  title: '文章',
  detectionReliable: true,
  checkedAtEpochMs: 1,
  source: 'accessibility',
};
let currentConnection = connection;
let currentWindow = reliableWindow;
let protectedPackages = [];
let nativeCalls = 0;
const createNativeSnapshot = (expectedWindow) => ({
  ...expectedWindow,
  capturedAtEpochMs: 2,
  nodes: [{
    depth: 0,
    text: '  页面标题  ',
    contentDescription: null,
    className: 'android.widget.TextView',
    clickable: false,
    editable: false,
    password: false,
  }],
  truncation: {
    nodeLimitReached: false,
    depthLimitReached: false,
    characterLimitReached: false,
  },
});
let nativeRead = async ({ expectedWindow }) => {
  nativeCalls += 1;
  return createNativeSnapshot(expectedWindow);
};

const semanticObservation = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenSemanticObservation.ts',
  {
    '@features/deviceControl': {
      getDeviceObserverConnectionState: async () => currentConnection,
      getCurrentWindowState: async () => currentWindow,
      readDeviceObserverSemanticSnapshot: (input) => nativeRead(input),
    },
    '@features/phoneTools': {
      loadCurrentProtectedPackages: async () => protectedPackages,
    },
    './ScreenObservationPolicy': observationPolicy,
    './ScreenSemanticObservationPolicy': semanticPolicy,
  },
);
const {
  normalizeScreenSemanticSnapshot,
  readAccessibilitySemanticsForCurrentWindow,
  SCREEN_SEMANTIC_LIMITS,
} = semanticObservation;
const { ScreenSemanticObservationError } = semanticPolicy;

const allowed = await readAccessibilitySemanticsForCurrentWindow();
assert.equal(allowed.packageName, reliableWindow.packageName);
assert.equal(allowed.windowId, reliableWindow.windowId);
assert.equal(allowed.plainText, '页面标题');
assert.equal(nativeCalls, 1);

for (const [connectionPatch, expectedReason] of [
  [{ accessibilityEnabled: false }, 'accessibility_disabled'],
  [{ accessibilityConnected: false }, 'accessibility_disconnected'],
  [{ canRetrieveWindowContent: false }, 'semantic_read_failed'],
]) {
  currentConnection = { ...connection, ...connectionPatch };
  nativeCalls = 0;
  await assert.rejects(
    readAccessibilitySemanticsForCurrentWindow(),
    (error) => (
      error instanceof ScreenSemanticObservationError && error.reason === expectedReason
    ),
  );
  assert.equal(nativeCalls, 0, '无障碍能力不可用时不得进入 native 语义读取');
}
currentConnection = connection;

for (const protectedPackage of [
  'com.example.article',
  protectedPolicy.SYSTEM_PROTECTED_PACKAGES[0],
]) {
  currentWindow = { ...reliableWindow, packageName: protectedPackage };
  protectedPackages = [protectedPackage];
  nativeCalls = 0;
  await assert.rejects(
    readAccessibilitySemanticsForCurrentWindow(),
    (error) => error instanceof ScreenSemanticObservationError && error.reason === 'protected_app',
  );
  assert.equal(nativeCalls, 0, '受保护应用不得进入 native 语义读取');
}

protectedPackages = [];
for (const unavailableWindow of [
  { ...reliableWindow, detectionReliable: false },
  { ...reliableWindow, packageName: null },
  { ...reliableWindow, windowId: null },
]) {
  currentWindow = unavailableWindow;
  nativeCalls = 0;
  await assert.rejects(
    readAccessibilitySemanticsForCurrentWindow(),
    (error) => error instanceof ScreenSemanticObservationError && error.reason === 'window_unavailable',
  );
  assert.equal(nativeCalls, 0, '不可靠窗口不得进入 native 语义读取');
}

currentWindow = reliableWindow;
for (const nativeFailureMessage of [
  '快照冻结前当前窗口已经变化',
  'windowId 对应 root 的 package 与 expected target 不一致',
]) {
  nativeCalls = 0;
  nativeRead = async () => {
    nativeCalls += 1;
    throw Object.assign(new Error(nativeFailureMessage), { reason: 'window_changed' });
  };
  await assert.rejects(
    readAccessibilitySemanticsForCurrentWindow(),
    (error) => error instanceof ScreenSemanticObservationError && error.reason === 'window_changed',
  );
  assert.equal(nativeCalls, 1, 'freeze 前目标不匹配不得自动 retry');
}

currentWindow = reliableWindow;
nativeCalls = 0;
nativeRead = async ({ expectedWindow }) => {
  nativeCalls += 1;
  currentWindow = { ...reliableWindow, packageName: 'com.example.chat', windowId: 23 };
  return createNativeSnapshot(expectedWindow);
};
const frozenAcrossWindowChange = await readAccessibilitySemanticsForCurrentWindow();
assert.equal(frozenAcrossWindowChange.packageName, reliableWindow.packageName);
assert.equal(frozenAcrossWindowChange.windowId, reliableWindow.windowId);
assert.equal(frozenAcrossWindowChange.plainText, '页面标题');
assert.equal(nativeCalls, 1, 'snapshot 冻结后切窗不得刷新或重读');

currentWindow = reliableWindow;
nativeCalls = 0;
nativeRead = async ({ expectedWindow }) => {
  nativeCalls += 1;
  currentWindow = { ...reliableWindow, packageName: 'com.example.chat', windowId: 23 };
  currentWindow = reliableWindow;
  return createNativeSnapshot(expectedWindow);
};
const frozenAcrossAba = await readAccessibilitySemanticsForCurrentWindow();
assert.equal(frozenAcrossAba.packageName, reliableWindow.packageName);
assert.equal(frozenAcrossAba.windowId, reliableWindow.windowId);
assert.equal(nativeCalls, 1, 'snapshot 冻结后的 A-B-A 不得因 freshness 作废或重读');

currentWindow = reliableWindow;
nativeCalls = 0;
nativeRead = async () => {
  nativeCalls += 1;
  throw Object.assign(new Error('已冻结的语义根节点读取失败'), { reason: 'semantic_read_failed' });
};
await assert.rejects(
  readAccessibilitySemanticsForCurrentWindow(),
  (error) => (
    error instanceof ScreenSemanticObservationError && error.reason === 'semantic_read_failed'
  ),
);
assert.equal(nativeCalls, 1, '已冻结 root 失效时不得重新获取最新窗口');

const oversizedNodes = Array.from(
  { length: SCREEN_SEMANTIC_LIMITS.maxNodes + 20 },
  (_, index) => ({
    depth: index === 0 ? SCREEN_SEMANTIC_LIMITS.maxDepth + 1 : 0,
    text: 'x'.repeat(SCREEN_SEMANTIC_LIMITS.maxFieldCharacters + 50),
    contentDescription: null,
    className: 'android.widget.TextView',
    clickable: false,
    editable: false,
    password: false,
  }),
);
const truncated = normalizeScreenSemanticSnapshot({
  packageName: reliableWindow.packageName,
  windowId: reliableWindow.windowId,
  capturedAtEpochMs: 3,
  nodes: oversizedNodes,
  truncation: {
    nodeLimitReached: false,
    depthLimitReached: false,
    characterLimitReached: false,
  },
});
assert.equal(truncated.truncated, true);
assert.equal(truncated.truncation.depthLimitReached, true);
assert.equal(truncated.truncation.characterLimitReached, true);
assert.ok(truncated.nodes.length <= SCREEN_SEMANTIC_LIMITS.maxNodes);
assert.ok(
  truncated.nodes.reduce(
    (total, node) => total + (node.text?.length ?? 0) + (node.contentDescription?.length ?? 0),
    0,
  ) <= SCREEN_SEMANTIC_LIMITS.maxTotalCharacters,
);

const nodeLimited = normalizeScreenSemanticSnapshot({
  packageName: reliableWindow.packageName,
  windowId: reliableWindow.windowId,
  capturedAtEpochMs: 3,
  nodes: Array.from(
    { length: SCREEN_SEMANTIC_LIMITS.maxNodes + 1 },
    (_, index) => ({
      depth: 0,
      text: `node-${index}`,
      contentDescription: null,
      className: null,
      clickable: false,
      editable: false,
      password: false,
    }),
  ),
  truncation: {
    nodeLimitReached: false,
    depthLimitReached: false,
    characterLimitReached: false,
  },
});
assert.equal(nodeLimited.nodes.length, SCREEN_SEMANTIC_LIMITS.maxNodes);
assert.equal(nodeLimited.truncation.nodeLimitReached, true);

const password = normalizeScreenSemanticSnapshot({
  packageName: reliableWindow.packageName,
  windowId: reliableWindow.windowId,
  capturedAtEpochMs: 4,
  nodes: [{
    depth: 2,
    text: 'secret-123',
    contentDescription: 'secret-description',
    className: 'android.widget.EditText',
    clickable: true,
    editable: true,
    password: true,
  }],
  truncation: {
    nodeLimitReached: false,
    depthLimitReached: false,
    characterLimitReached: false,
  },
});
assert.equal(password.nodes[0].password, true);
assert.equal(password.nodes[0].text, undefined);
assert.equal(password.nodes[0].contentDescription, undefined);
assert.equal(password.plainText, '');

console.log('Screen Accessibility semantic observation 契约检查通过。');
