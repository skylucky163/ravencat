/**
 * Together Listening → Floating Layer 的窄投影契约验证。
 *
 * 应用层用可执行 mock 验证投影缓存独立于开关、运行状态与权限，投影命令不会
 * 擅自启动 Service；原生分页、胶囊几何和触摸交接由 Android 单元测试执行真实实现。
 * 此处保留尚未被行为测试覆盖的原生投影、窗口所有权与宿主接线检查。
 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-together-listening-'));

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

function compileProductionModule(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(errors.length, 0, `TypeScript 转译失败：${relativePath}`);
  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function writeRuntimeModule(relativePath, source) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, 'utf8');
}

function loadCompiled(relativePath) {
  return require(path.join(tempRoot, relativePath.replace(/\.ts$/, '.js')));
}

writeRuntimeModule('node_modules/@shared/runtime/RuntimeSlot.js', `
exports.createRuntimeSlot = (name) => {
  let value = null;
  return {
    configure(nextValue) { value = nextValue; },
    get() {
      if (value === null) throw new Error(name + ' 运行时依赖尚未完成装配');
      return value;
    },
  };
};
`);

for (const relativePath of [
  'src/features/floatingLayer/application/FloatingLayerPort.ts',
  'src/features/floatingLayer/application/FloatingLayerRuntimeDependencies.ts',
  'src/features/floatingLayer/application/FloatingLayerFacade.ts',
  'src/features/floatingLayer/application/FloatingInteractionFacade.ts',
]) {
  compileProductionModule(relativePath);
}

const { configureFloatingLayerRuntimeDependencies } = loadCompiled(
  'src/features/floatingLayer/application/FloatingLayerRuntimeDependencies.ts',
);
const {
  updateTogetherListeningPresentation,
  clearTogetherListeningPresentation,
} = loadCompiled('src/features/floatingLayer/application/FloatingLayerFacade.ts');
const { setFloatingInteractionEnabled } = loadCompiled(
  'src/features/floatingLayer/application/FloatingInteractionFacade.ts',
);

function createHarness({ enabled, running, overlayGranted }) {
  const calls = [];
  let cachedPresentation = null;
  const presentation = {
    activityId: 'activity-a',
    hostAiId: 'host-a',
    chatSessionId: 'chat-a',
    activatedAtEpochMs: 1_800_000_000_000,
    aiName: 'RavenCat',
    aiAvatar: null,
    userName: '用户',
    userAvatar: null,
  };
  const native = {
    isFloatingLayerRunning: async () => running,
    isOverlayPermissionGranted: async () => overlayGranted,
    updateTogetherListeningPresentation: async (value) => {
      cachedPresentation = value;
      calls.push(['update', value]);
    },
    clearTogetherListeningPresentation: async (activityId) => {
      if (activityId === undefined || cachedPresentation?.activityId === activityId) {
        cachedPresentation = null;
      }
      calls.push(['clear', activityId]);
    },
    startFloatingLayer: async () => {
      running = true;
      calls.push(['start', cachedPresentation]);
    },
    stopFloatingLayer: async () => {
      running = false;
      calls.push(['stop']);
    },
  };
  configureFloatingLayerRuntimeDependencies({
    repositories: {
      bubbleSkins: {},
      floatingInteractionSettings: {
        ensureDefault: async () => ({ enabled }),
        setEnabled: async (value) => {
          enabled = value;
          return { enabled };
        },
      },
    },
    native: { floatingLayer: native },
    executeFloatingMessage: async () => {},
  });
  return { calls, native, presentation, getCachedPresentation: () => cachedPresentation };
}

// 未开启、Service 尚未运行或缺少权限时仍接收展示事实，但不能自行启动 Service。
for (const scenario of [
  { name: 'disabled', enabled: false, running: true, overlayGranted: true },
  { name: 'service-not-running', enabled: true, running: false, overlayGranted: true },
  { name: 'overlay-permission-missing', enabled: true, running: true, overlayGranted: false },
]) {
  const fixture = createHarness(scenario);
  await updateTogetherListeningPresentation(fixture.presentation);
  assert.deepEqual(fixture.calls, [['update', fixture.presentation]],
    `${scenario.name} 必须同步展示缓存，且不能启动 Service`);
}

{
  const fixture = createHarness({ enabled: true, running: true, overlayGranted: true });
  await updateTogetherListeningPresentation(fixture.presentation);
  assert.deepEqual(fixture.calls, [['update', fixture.presentation]]);

  await clearTogetherListeningPresentation('activity-a');
  assert.deepEqual(fixture.calls, [
    ['update', fixture.presentation],
    ['clear', 'activity-a'],
  ]);
}

// 回归：先进入一起听再开启悬浮窗，启动时已有当前投影；关闭再开启也保留它。
{
  const fixture = createHarness({ enabled: false, running: false, overlayGranted: true });
  await updateTogetherListeningPresentation(fixture.presentation);
  await setFloatingInteractionEnabled(true);
  await setFloatingInteractionEnabled(false);
  await setFloatingInteractionEnabled(true);
  assert.deepEqual(fixture.calls, [
    ['update', fixture.presentation],
    ['start', fixture.presentation],
    ['stop'],
    ['start', fixture.presentation],
  ]);
}

// 一起听在悬浮窗关闭期间结束，之后开启不能恢复已经结束的投影。
{
  const fixture = createHarness({ enabled: false, running: false, overlayGranted: true });
  await updateTogetherListeningPresentation(fixture.presentation);
  await clearTogetherListeningPresentation(fixture.presentation.activityId);
  assert.equal(fixture.getCachedPresentation(), null);
  await setFloatingInteractionEnabled(true);
  assert.deepEqual(fixture.calls.at(-1), ['start', null]);
}

// ── immutable native snapshot / window ownership ────────────────────────────
const floatingSourceFiles = [];
function collectFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(absolutePath);
    else if (/\.(kt|ts)$/.test(entry.name)) floatingSourceFiles.push(absolutePath);
  }
}
collectFiles(path.join(repoRoot, 'modules/ravencat-floating-layer'));
const nativeSource = floatingSourceFiles
  .filter((filePath) => filePath.endsWith('.kt'))
  .map((filePath) => fs.readFileSync(filePath, 'utf8'))
  .join('\n');
const floatingFeatureSource = [
  read('src/features/floatingLayer/application/FloatingLayerPort.ts'),
  read('src/features/floatingLayer/application/FloatingLayerFacade.ts'),
  read('src/features/floatingLayer/application/FloatingLayerRuntimeDependencies.ts'),
  read('src/features/floatingLayer/infrastructure/FloatingLayerAdapter.ts'),
  read('src/features/floatingLayer/index.ts'),
].join('\n');
const runtimeCompositionSource = read('src/host/composition/configureTogetherListeningRuntime.ts');
const snapshotSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/model/RavenCatOverlaySnapshot.kt',
);
const windowStateSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/controller/RavenCatOverlayWindowState.kt',
);

assert.match(floatingFeatureSource, /interface FloatingTogetherListeningPresentation/);
for (const field of [
  'activityId',
  'hostAiId',
  'chatSessionId',
  'activatedAtEpochMs',
  'aiName',
  'aiAvatar',
  'userName',
  'userAvatar',
]) {
  assert.match(floatingFeatureSource, new RegExp(`\\b${field}\\b`), `DTO 缺少 ${field}`);
}
assert.match(floatingFeatureSource, /updateTogetherListeningPresentation/);
assert.match(floatingFeatureSource, /clearTogetherListeningPresentation/);
assert.doesNotMatch(floatingFeatureSource, /@features\/togetherListening/);
assert.doesNotMatch(floatingFeatureSource, /@features\/chat/);
assert.doesNotMatch(floatingFeatureSource, /SQLite|databaseCoordinator|SELECT |INSERT |UPDATE |DELETE /i);

assert.match(snapshotSource, /togetherListening\s*:/);
for (const field of [
  'activityId',
  'hostAiId',
  'chatSessionId',
  'activatedAtEpochMs',
  'aiName',
  'aiAvatar',
  'userName',
  'userAvatar',
]) {
  assert.match(nativeSource, new RegExp(`\\b${field}\\b`), `native Together DTO 缺少 ${field}`);
}
for (const forbiddenFact of [
  'songTitle',
  'artist',
  'album',
  'mediaSession',
  'playbackPosition',
]) {
  assert.doesNotMatch(nativeSource, new RegExp(`\\b${forbiddenFact}\\b`, 'i'));
}

assert.match(windowStateSource, /BUBBLE/);
assert.match(windowStateSource, /PANEL/);
assert.match(windowStateSource, /HIDDEN/);
assert.doesNotMatch(windowStateSource, /TOGETHER|LISTENING_PANEL|MUSIC/);
assert.match(nativeSource, /RavenCatOverlayIntent\.Collapse/);

// ── PANEL page model：Chat / Together 是同一 PANEL window 内的 page ──────────
const panelViewSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/view/RavenCatPanelView.kt',
);
const togetherContentSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/view/RavenCatTogetherListeningPanelContentView.kt',
);
const headerViewSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/view/RavenCatPanelHeaderView.kt',
);
const runtimeSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/runtime/RavenCatOverlayRuntime.kt',
);
const controllerSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/controller/RavenCatOverlayController.kt',
);

// 初始页、滑动阈值、结束收起与屏幕尺寸适配由 RavenCatPanelPagerPolicyTest 验证结果。
// 此处仅保留尚未由该纯策略测试覆盖的窗口接线。
assert.match(controllerSource, /RavenCatPanelPagerPolicy\.togetherCapsuleBoundsPx/);
assert.match(controllerSource, /RavenCatPanelPagerPolicy\.chatContentHeightPx/);
assert.match(controllerSource, /windowHost\.update\(view, panelLayoutParams\)/);
assert.match(controllerSource, /handlePanelPageChanged/);
// 切到 TOGETHER 必须释放键盘与 composer 焦点。
assert.match(controllerSource, /releasePanelInputFocus\(\)/);
// 单一 WindowManager owner：全模块只允许一个 OverlayWindowHost 实例。
assert.equal(
  (nativeSource.match(/OverlayWindowHost\(/g) || []).length,
  1,
  '只允许一个 OverlayWindowHost owner',
);
assert.doesNotMatch(nativeSource, /WindowManager\(\)/, '不得再创建第二个 WindowManager owner');

// Chat / Together 在 PANEL 内共存：pager 同时持有两个 page，按 page state 展示。
assert.match(panelViewSource, /RavenCatPanelPagerView/);
assert.match(panelViewSource, /chatPage = chatContentLayout/);
assert.match(panelViewSource, /togetherPage = togetherContentView/);
assert.match(panelViewSource, /setTogetherPageAvailable\(snapshot\.togetherListening != null\)/);
assert.match(panelViewSource, /conversationView\.render\(snapshot\)/);

// 共享 header 永远存在：两个 page 收起入口位置与语义一致。
assert.doesNotMatch(panelViewSource, /headerView\.visibility/, '共享 header 不得再随 Together mode 隐藏');
assert.match(headerViewSource, /RavenCatOverlayIntent\.Collapse/);
assert.match(headerViewSource, /fun setPage\(page: RavenCatPanelPage\)/);
// Together content 内不得再重复 collapse control。
assert.doesNotMatch(togetherContentSource, /RavenCatOverlayIntent\.Collapse/);

// ── native foreground fail-safe ─────────────────────────────────────────────
assert.match(nativeSource, /APP_FOREGROUND_HOST/);
assert.match(nativeSource, /APP_FOREGROUND_NATIVE_ACTIVITY/);
assert.match(nativeSource, /registerActivityLifecycleCallbacks/);
assert.match(nativeSource, /RavenCatAppForegroundActivityTracker/);
// fail-safe 只控制可见性，不得驱动 Service 生命周期。
assert.doesNotMatch(runtimeSource, /startFloatingLayer|stopFloatingLayer|stopService|startForegroundService/);

// Together 只是 PANEL content page：保持普通 chat view，并在有 Together snapshot 时开放第二页。
for (const ordinaryPanelView of [
  'RavenCatConversationView',
  'RavenCatComposerView',
  'RavenCatShotActionView',
]) {
  assert.match(nativeSource, new RegExp(ordinaryPanelView));
}
assert.match(nativeSource, /togetherListening/);
assert.match(nativeSource, /一起听/);
assert.match(nativeSource, /收起/);
// 悬浮层不再提供“打开 App 聊天”入口；精确聊天导航由 standard notification 承担。
assert.doesNotMatch(nativeSource, /OpenTogetherConversation/);
assert.doesNotMatch(nativeSource, /退出一起听/);
// 不可点击子页、滚动仲裁与触摸取消由 RavenCatPanelPagerViewTest 分发真实 MotionEvent 验证，
// 不在 Node 中规定 View 必须覆写哪些方法。

// 展示只更新 snapshot；不在 JS 侧以定时器每秒重投影，也不让 Together 取得 service owner。
assert.match(runtimeCompositionSource, /updateTogetherListeningPresentation/);
assert.match(runtimeCompositionSource, /clearTogetherListeningPresentation/);
assert.doesNotMatch(runtimeCompositionSource, /startFloatingLayer|request.*Overlay.*Permission|openOverlayPermissionSettings/);
assert.doesNotMatch(
  [floatingFeatureSource, runtimeCompositionSource].join('\n'),
  /setInterval|setTimeout|updateTogetherListeningPresentation[\s\S]{0,500}(?:1000|1_000|1000ms)/,
  'Together projection 不得由 JS 每秒轮询或重投影',
);
assert.match(nativeSource, /activatedAtEpochMs/);
assert.match(nativeSource, /Chronometer|elapsedRealtime|postDelayed/);
assert.match(nativeSource, /updateTogetherListeningPresentation/);
assert.match(nativeSource, /clearTogetherListeningPresentation/);
assert.doesNotMatch(nativeSource, /MediaSessionManager|getActiveSessions|SQLiteDatabase|RoomDatabase/);

// 精确导航与 stale clear 由 identity payload 驱动，不根据当前 Host 猜 session。
assert.match(read('src/host/navigation/externalNavigation.ts'), /createTogetherListeningNavigationTarget/);
assert.match(read('src/host/KimiPhoneHost.tsx'), /target\.aiId/);
assert.match(read('src/host/KimiPhoneHost.tsx'), /target\.sessionId/);
assert.match(nativeSource, /hostAiId/);
assert.match(nativeSource, /chatSessionId/);
assert.match(nativeSource, /activityId/);
assert.match(nativeSource, /SharedPreferences|Projection.*Cache|projection.*cache/i);

console.log('Together Listening 投影缓存、不自动启动服务及原生投影与宿主接线检查通过；分页与触摸行为由 Android 单元测试验证。');
