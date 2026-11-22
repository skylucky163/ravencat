/** LISTEN-6 / 6.1 App 内 read model、交互与 lifecycle 验证。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'listen6-in-app-'));

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.equal(
    (output.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error).length,
    0,
    `TypeScript 转译失败：${relativePath}`,
  );
  const outputPath = path.join(tempRoot, relativePath.replace(/\.tsx?$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function load(relativePath) {
  return require(path.join(tempRoot, relativePath.replace(/\.tsx?$/, '.js')));
}

const runtimeSlotStub = path.join(tempRoot, 'node_modules/@shared/runtime/RuntimeSlot.js');
fs.mkdirSync(path.dirname(runtimeSlotStub), { recursive: true });
fs.writeFileSync(runtimeSlotStub, `
exports.createRuntimeSlot = () => {
  let value;
  return { configure(next) { value = next; }, get() { return value; } };
};
`, 'utf8');

const asyncStorageStub = path.join(
  tempRoot,
  'node_modules/@react-native-async-storage/async-storage/index.js',
);
fs.mkdirSync(path.dirname(asyncStorageStub), { recursive: true });
fs.writeFileSync(asyncStorageStub, `
const values = new Map();
const storage = {
  async getItem(key) { return values.get(key) ?? null; },
  async setItem(key, value) { values.set(key, value); },
};
exports.__esModule = true;
exports.default = storage;
exports.values = values;
`, 'utf8');

const applicationFiles = [
  'src/features/togetherListening/domain/TogetherListeningActivity.ts',
  'src/features/togetherListening/domain/TogetherListeningRepository.ts',
  'src/features/togetherListening/application/TogetherListeningRuntime.ts',
  'src/features/togetherListening/application/TogetherListeningChangedSignal.ts',
  'src/features/togetherListening/application/TogetherListeningSystemPresentation.ts',
  'src/features/togetherListening/application/TogetherListeningLifecycle.ts',
  'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts',
  'src/features/togetherListening/application/PrepareTogetherListeningInAppPresentation.ts',
  'src/features/togetherListening/application/LeaveTogetherListeningByUser.ts',
  'src/features/togetherListening/presentation/TogetherListeningPresentationRefreshController.ts',
  'src/features/togetherListening/presentation/togetherListeningDuration.ts',
  'src/features/togetherListening/presentation/togetherListeningIndicatorPolicy.ts',
  'src/features/togetherListening/presentation/togetherListeningIndicatorPositionStorage.ts',
  'src/features/togetherListening/presentation/togetherListeningInAppViewModel.ts',
  'src/features/togetherListening/presentation/TogetherListeningInAppIndicator.tsx',
];
for (const file of applicationFiles) compile(file);

const runtime = load('src/features/togetherListening/application/TogetherListeningRuntime.ts');
const signal = load('src/features/togetherListening/application/TogetherListeningChangedSignal.ts');
const presentation = load(
  'src/features/togetherListening/application/PrepareTogetherListeningInAppPresentation.ts',
);
const leave = load('src/features/togetherListening/application/LeaveTogetherListeningByUser.ts');
const { TogetherListeningPresentationRefreshController } = load(
  'src/features/togetherListening/presentation/TogetherListeningPresentationRefreshController.ts',
);
const viewModels = load(
  'src/features/togetherListening/presentation/togetherListeningInAppViewModel.ts',
);
const duration = load(
  'src/features/togetherListening/presentation/togetherListeningDuration.ts',
);
const indicatorPolicy = load(
  'src/features/togetherListening/presentation/togetherListeningIndicatorPolicy.ts',
);
const indicatorPositionStorage = load(
  'src/features/togetherListening/presentation/togetherListeningIndicatorPositionStorage.ts',
);

let currentHostAiId = 'host-a';
let observation;
let activity;
let transitionCount = 0;
let projectionCount = 0;
let changedCount = 0;
const unsubscribeChanged = signal.subscribeTogetherListeningChanged(() => { changedCount += 1; });

const availableObservation = (playbackState = 'playing', title = 'A') => ({
  status: 'snapshot_available',
  playbackState,
  mediaId: `song-${title}`,
  title,
  artist: 'X',
  album: null,
});
const activeActivity = (id = 'activity-1') => ({
  id,
  hostAiId: 'host-a',
  chatSessionId: 'chat-a',
  initiator: 'user',
  phase: 'active',
  createdAtEpochMs: 1,
  updatedAtEpochMs: 2,
  activatedAtEpochMs: 2,
  endedAtEpochMs: null,
  endReason: null,
});

runtime.configureTogetherListeningRuntimeDependencies({
  repository: {
    async createIfNoCurrent(next) {
      if (activity) return { outcome: 'non_terminal_activity_exists', activity };
      activity = { ...next };
      return { outcome: 'created', activity };
    },
    async getById(id) {
      return activity?.id === id ? { ...activity } : null;
    },
    async getCurrent() {
      return activity && !['declined_by_user', 'declined_by_ai', 'ended'].includes(activity.phase)
        ? { ...activity }
        : null;
    },
    async transitionActivityIfPhase(id, expectedPhases, patch) {
      if (!activity || activity.id !== id || !expectedPhases.includes(activity.phase)) return null;
      transitionCount += 1;
      activity = { ...activity, ...patch };
      return { ...activity };
    },
  },
  chat: {
    async projectActivityToChat() { projectionCount += 1; },
  },
  systemPresentation: {
    upsertActivePresentation: async () => {},
    cancelPresentation: async () => {},
  },
  declineFollowUp: {},
  generateId: () => 'generated',
  nowEpochMs: () => 10,
  observeNetEasePlayback: async () => observation,
  getCurrentHostAIId: async () => currentHostAiId,
  resolveSystemPresentationAIIdentity: async () => ({ name: 'Host', avatar: null }),
});

activity = activeActivity();
observation = availableObservation('playing', 'A');
let state = await presentation.prepareTogetherListeningInAppPresentationState();
assert.equal(state?.playback.status, 'available');
assert.equal(state?.playback.title, 'A');
assert.equal(state?.playback.artist, 'X');
assert.equal(state?.activatedAtEpochMs, 2, 'duration 起点必须来自 canonical Activity');

observation = availableObservation('paused', 'A');
state = await presentation.prepareTogetherListeningInAppPresentationState();
assert.equal(state?.playback.state, 'paused');
assert.equal(activity.phase, 'active', 'paused 不得结束 Activity');

observation = { status: 'observation_failed' };
state = await presentation.prepareTogetherListeningInAppPresentationState();
assert.equal(state?.playback.status, 'temporarily_unavailable');
assert.equal(activity.phase, 'active', '临时 observation failure 不得误杀 Activity');

observation = availableObservation('stopped', 'A');
state = await presentation.prepareTogetherListeningInAppPresentationState();
assert.equal(state, null);
assert.equal(activity.endReason, 'media_unavailable');

activity = activeActivity('host-mismatch');
observation = availableObservation();
currentHostAiId = 'host-b';
state = await presentation.prepareTogetherListeningInAppPresentationState();
assert.equal(state, null);
assert.equal(activity.endReason, 'host_authority_lost');

currentHostAiId = 'host-a';
activity = { ...activeActivity('pending'), phase: 'pending_user_response' };
assert.equal(await presentation.prepareTogetherListeningInAppPresentationState(), null);

for (const source of ['chat_card', 'in_app_indicator']) {
  activity = activeActivity(`leave-${source}`);
  observation = availableObservation();
  const result = await leave.leaveTogetherListeningByUser({ activityId: activity.id, source });
  assert.equal(result.status, 'left');
  assert.equal(activity.endReason, 'user_left');
}

activity = activeActivity('leave-media');
observation = availableObservation('stopped');
assert.equal(
  (await leave.leaveTogetherListeningByUser({ activityId: activity.id, source: 'in_app_indicator' })).status,
  'media_unavailable',
);
assert.equal(activity.endReason, 'media_unavailable');

activity = activeActivity('leave-transient');
observation = { status: 'observation_failed' };
assert.equal(
  (await leave.leaveTogetherListeningByUser({ activityId: activity.id, source: 'chat_card' })).status,
  'left',
);
assert.equal(activity.endReason, 'user_left');

activity = activeActivity('leave-stale-host');
currentHostAiId = 'host-b';
observation = availableObservation();
assert.equal(
  (await leave.leaveTogetherListeningByUser({ activityId: activity.id, source: 'chat_card' })).status,
  'host_authority_lost',
);
assert.equal(activity.endReason, 'host_authority_lost');

currentHostAiId = 'host-a';
activity = activeActivity('double-leave');
observation = availableObservation();
const transitionsBeforeDouble = transitionCount;
await leave.leaveTogetherListeningByUser({ activityId: activity.id, source: 'in_app_indicator' });
const secondLeave = await leave.leaveTogetherListeningByUser({
  activityId: 'double-leave',
  source: 'in_app_indicator',
});
assert.equal(secondLeave.status, 'activity_not_current');
assert.equal(transitionCount, transitionsBeforeDouble + 1, 'double leave 只能产生一次 CAS transition');
assert.ok(changedCount >= 7, '每次成功 canonical transition 必须 emit invalidation');
assert.ok(projectionCount >= 7, 'lifecycle transition 必须继续投影 Chat card');
unsubscribeChanged();

const timers = new Map();
let nextTimerId = 1;
let activeResult = false;
let refreshCount = 0;
const controller = new TogetherListeningPresentationRefreshController({
  cadenceMs: 2000,
  refresh: async () => { refreshCount += 1; return activeResult; },
  scheduler: {
    setInterval(callback, cadenceMs) {
      assert.equal(cadenceMs, 2000);
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
controller.start(true);
await flush();
assert.equal(timers.size, 0, 'idle 不得轮询');
activeResult = true;
controller.invalidate();
await flush();
assert.equal(timers.size, 1, 'active + foreground 必须启用轮询');
controller.setForeground(false);
assert.equal(timers.size, 0, 'background 必须停止轮询');
const beforeResume = refreshCount;
controller.setForeground(true);
await flush();
assert.equal(refreshCount, beforeResume + 1, '回到前台必须立即刷新');
assert.equal(timers.size, 1);
controller.invalidate();
await flush();
assert.equal(refreshCount, beforeResume + 2, 'canonical lifecycle event 必须立即刷新');
controller.stop();
assert.equal(timers.size, 0, 'cleanup 后不得残留 timer');

assert.equal(duration.formatTogetherListeningDuration(8_000), '00:08');
assert.equal(duration.formatTogetherListeningDuration(754_000), '12:34');
assert.equal(duration.formatTogetherListeningDuration(3_723_000), '1:02:03');
assert.equal(duration.formatTogetherListeningDuration(-1), '00:00');
assert.equal(duration.formatTogetherListeningDuration(Number.NaN), '00:00');
assert.equal(duration.getTogetherListeningElapsedMs(9_000, 8_000), 0);

const durationTimers = new Map();
let nextDurationTimerId = 1;
let nowEpochMs = 8_000;
let latestElapsed = null;
const durationTicker = new duration.TogetherListeningDurationTicker({
  cadenceMs: 1000,
  nowEpochMs: () => nowEpochMs,
  onElapsedMs: (elapsedMs) => { latestElapsed = elapsedMs; },
  scheduler: {
    setInterval(callback, cadenceMs) {
      assert.equal(cadenceMs, 1000);
      const id = nextDurationTimerId++;
      durationTimers.set(id, callback);
      return id;
    },
    clearInterval(id) { durationTimers.delete(id); },
  },
});
durationTicker.update(0, true);
assert.equal(latestElapsed, 8_000, 'active + foreground 必须立即计算 elapsed');
assert.equal(durationTimers.size, 1, 'active + foreground 必须启用 duration ticker');
nowEpochMs = 10_000;
durationTimers.values().next().value();
assert.equal(latestElapsed, 10_000, 'ticker 只使用 now 与 activatedAt 推进');
durationTicker.update(0, false);
assert.equal(durationTimers.size, 0, 'background 必须停止 duration ticker');
nowEpochMs = 15_000;
durationTicker.update(0, true);
assert.equal(latestElapsed, 15_000, 'foreground 必须立即恢复真实累计时间');
durationTicker.update(null, true);
assert.equal(latestElapsed, null, 'Activity 消失必须清空 duration presentation');
assert.equal(durationTimers.size, 0, 'Activity 消失不得残留 duration timer');
durationTicker.stop();
assert.equal(durationTimers.size, 0, 'cleanup 后不得残留 duration timer');

assert.equal(
  indicatorPolicy.resolveIndicatorReleaseMode({ translationX: -10, velocityX: 0 }),
  'expanded',
);
assert.equal(
  indicatorPolicy.resolveIndicatorReleaseMode({ translationX: 10, velocityX: 0 }),
  'expanded',
);
assert.equal(
  indicatorPolicy.resolveIndicatorReleaseMode({ translationX: -70, velocityX: 0 }),
  'collapsed_left',
);
assert.equal(
  indicatorPolicy.resolveIndicatorReleaseMode({ translationX: 70, velocityX: 0 }),
  'collapsed_right',
);
assert.equal(
  indicatorPolicy.resolveIndicatorReleaseMode({ translationX: 10, velocityX: -800 }),
  'collapsed_left',
);
await indicatorPositionStorage.saveTogetherListeningIndicatorPosition({
  activityId: 'activity-a',
  displayMode: 'collapsed_right',
  collapsedVerticalOffset: -120,
});
assert.deepEqual(
  await indicatorPositionStorage.loadTogetherListeningIndicatorPosition('activity-a'),
  {
    activityId: 'activity-a',
    displayMode: 'collapsed_right',
    collapsedVerticalOffset: -120,
  },
  '同一 Activity 必须恢复最后稳定的 indicator 位置',
);
assert.equal(
  await indicatorPositionStorage.loadTogetherListeningIndicatorPosition('activity-b'),
  null,
  '新 Activity 不得继承上一 Activity 的 indicator 位置',
);
const asyncStorageValues = require(asyncStorageStub).values;
const indicatorPositionStorageKey = asyncStorageValues.keys().next().value;
asyncStorageValues.set(indicatorPositionStorageKey, '{broken');
assert.equal(
  await indicatorPositionStorage.loadTogetherListeningIndicatorPosition('activity-a'),
  null,
  '损坏的外部存储不得进入 presentation 内部状态',
);

// collapsed chip 纵向 clamp 几何：bottomOffset 是下边界 authority（maxOffset = 0），
// 向上最多到 safe area top + topMargin。
const collapsedChipGeometry = { chipHeight: 48, topMargin: 4 };
const tallScreenBounds = indicatorPolicy.resolveCollapsedVerticalOffsetBounds({
  windowHeight: 800,
  safeAreaTop: 24,
  bottomOffset: 96,
  ...collapsedChipGeometry,
});
assert.equal(tallScreenBounds.maxOffset, 0, 'collapsed chip 不得拖到默认 bottomOffset 位置以下');
assert.equal(
  tallScreenBounds.minOffset,
  (24 + 4) - (800 - 96 - 48),
  'minOffset 必须由 safe area top 与默认 chip top 的差值推导',
);
assert.equal(
  indicatorPolicy.clampCollapsedVerticalOffset(0, tallScreenBounds),
  0,
  '默认 offset 0 必须合法',
);
assert.equal(
  indicatorPolicy.clampCollapsedVerticalOffset(-10000, tallScreenBounds),
  tallScreenBounds.minOffset,
  '向上越界必须 clamp 到 minOffset（chip 顶部不进入 safe area）',
);
assert.equal(
  indicatorPolicy.clampCollapsedVerticalOffset(120, tallScreenBounds),
  0,
  '向下越界必须 clamp 到 0（不低于 bottomOffset 保护线）',
);
assert.equal(
  indicatorPolicy.clampCollapsedVerticalOffset(-100, tallScreenBounds),
  -100,
  '范围内的向上拖动必须原样保留',
);
// 几何变化：同一 offset 在小窗口 / 大 bottomOffset 下必须重新 clamp 到新的合法范围。
const compactBounds = indicatorPolicy.resolveCollapsedVerticalOffsetBounds({
  windowHeight: 480,
  safeAreaTop: 24,
  bottomOffset: 160,
  ...collapsedChipGeometry,
});
const previouslyValidOffset = tallScreenBounds.minOffset;
assert.ok(previouslyValidOffset < compactBounds.minOffset, '测试前提：旧合法 offset 在新几何下越界');
assert.equal(
  indicatorPolicy.clampCollapsedVerticalOffset(previouslyValidOffset, compactBounds),
  compactBounds.minOffset,
  '窗口变矮 / bottomOffset 变大后必须 re-clamp 到新的 minOffset',
);
assert.equal(
  indicatorPolicy.clampCollapsedVerticalOffset(50, compactBounds),
  0,
  '几何变化后向下偏移仍不得突破 0',
);
// 退化几何（bottomOffset 过大）不得产生正区间，只允许停在默认位置。
const degenerateBounds = indicatorPolicy.resolveCollapsedVerticalOffsetBounds({
  windowHeight: 200,
  safeAreaTop: 24,
  bottomOffset: 400,
  ...collapsedChipGeometry,
});
assert.deepEqual(degenerateBounds, { minOffset: 0, maxOffset: 0 });
assert.equal(indicatorPolicy.clampCollapsedVerticalOffset(-30, degenerateBounds), 0);

const vm = viewModels.buildTogetherListeningInAppViewModel({
  state: {
    activityId: 'vm',
    hostAiId: 'host-a',
    chatSessionId: 'chat-a',
    activatedAtEpochMs: 2,
    playback: { status: 'available', state: 'playing', title: 'A', artist: 'X' },
  },
  userProfile: { name: '小雨', avatar: 'user.png' },
  aiProfile: { name: 'Kimi', avatar: 'ai.png' },
  durationText: '12:34',
});
assert.deepEqual(vm.user, { name: '小雨', avatar: 'user.png' });
assert.deepEqual(vm.ai, { name: 'Kimi', avatar: 'ai.png' });
assert.equal(vm.title, '正在一起听 · 12:34');
const fallbackVm = viewModels.buildTogetherListeningInAppViewModel({
  state: {
    activityId: 'fallback',
    hostAiId: 'host-a',
    chatSessionId: 'chat-a',
    activatedAtEpochMs: null,
    playback: { status: 'temporarily_unavailable', reason: 'observation_failed' },
  },
  userProfile: null,
  aiProfile: null,
  durationText: null,
});
assert.equal(fallbackVm.user.name, '用户');
assert.equal(fallbackVm.ai.name, 'AI');
assert.equal(fallbackVm.subtitle, '暂时无法读取网易云播放状态');
assert.equal(vm.hostAiId, 'host-a', 'navigation target 必须来自 Activity hostAiId');
assert.equal(vm.chatSessionId, 'chat-a', 'navigation 必须携带 Activity chatSessionId');

const newPresentationSources = [
  'src/features/togetherListening/application/PrepareTogetherListeningInAppPresentation.ts',
  'src/features/togetherListening/presentation/useTogetherListeningInAppPresentation.ts',
  'src/features/togetherListening/presentation/TogetherListeningInAppIndicator.tsx',
  'src/features/togetherListening/presentation/togetherListeningDuration.ts',
  'src/features/togetherListening/presentation/togetherListeningIndicatorPolicy.ts',
].map((file) => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
for (const forbidden of [
  'upsertTogetherListeningTimelineEntry',
  'messageRepository',
  'requestProactiveChatReply',
  'scheduleSelfWake',
  'runHostAgent',
  'ProcessAIReply',
  'appendExternalAssistantMessage',
  'RavenCatOverlayService',
]) {
  assert.equal(newPresentationSources.includes(forbidden), false, `LISTEN-6 presentation 禁止依赖 ${forbidden}`);
}

// 真机回归：isCollapsed boolean SharedValue 在 Hermes/Reanimated worklet 中触发
// ReferenceError。视觉模式必须由 React render 层的挂载决策表达，worklet 不得再引用它。
const indicatorSource = fs.readFileSync(
  path.join(repoRoot, 'src/features/togetherListening/presentation/TogetherListeningInAppIndicator.tsx'),
  'utf8',
);
assert.doesNotMatch(
  indicatorSource,
  /\bisCollapsed\b/,
  'indicator 不得再声明或引用 isCollapsed（真机 ReferenceError 回归）',
);
assert.match(indicatorSource, /collapsedVerticalStyle/, 'collapsed 纵向偏移必须是独立 animated style');
assert.match(
  indicatorSource,
  /displayMode !== 'expanded' && collapsedVerticalStyle/,
  'expanded 必须不挂载 vertical transform style',
);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('LISTEN-6 / 6.1 App 内 read model、交互、duration、lifecycle 与禁止边界检查通过。');
