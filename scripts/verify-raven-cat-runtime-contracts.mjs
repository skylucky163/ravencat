import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CommonActions, StackActions, StackRouter } from '@react-navigation/routers';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const ravenCatPublicApiSource = read('src/features/companion/index.ts');
assert.doesNotMatch(ravenCatPublicApiSource, /infrastructure/);
assert.doesNotMatch(
  ravenCatPublicApiSource,
  /\b(?:configureCompanionRuntimeDependencies|companion\w+(?:Repository|Adapter))\b/,
);

const ravenCatCompositionSource = read('src/features/companion/composition.ts');
assert.match(ravenCatCompositionSource, /configureCompanionRuntimeDependencies/);
const floatingLayerCompositionSource = read('src/features/floatingLayer/composition.ts');
assert.match(floatingLayerCompositionSource, /configureFloatingLayerRuntimeDependencies/);
assert.match(floatingLayerCompositionSource, /floatingLayerAdapter/);

function listKotlinFiles(relativeDirectory) {
  const directory = path.join(repoRoot, relativeDirectory);
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.kt'))
    .map((name) => ({ name, source: fs.readFileSync(path.join(directory, name), 'utf8') }));
}

// 将独立 TypeScript 源文件转译为临时 ESM 后动态导入，用于真实执行类行为测试。
const require = createRequire(import.meta.url);
const ts = require('typescript');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-runtime-contracts-'));

async function importStandaloneTypeScript(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const outputPath = path.join(tempRoot, `${path.basename(relativePath, '.ts')}.mjs`);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function loadTypeScriptModuleWithMocks(relativePath, mocks = {}) {
  const sourcePath = path.join(repoRoot, relativePath);
  const compiled = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  const requireMock = (specifier) => {
    assert.ok(
      Object.hasOwn(mocks, specifier),
      `${relativePath} 存在未声明的运行时依赖：${specifier}`,
    );
    return mocks[specifier];
  };
  const executeModule = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  executeModule(
    module.exports,
    requireMock,
    module,
    sourcePath,
    path.dirname(sourcePath),
  );
  return module.exports;
}

const screenCapturePolicyModule = loadTypeScriptModuleWithMocks(
  'src/features/screenCapture/application/ScreenCapturePolicy.ts',
);
const protectedAppsPolicyModule = loadTypeScriptModuleWithMocks(
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
);
const screenObservationPolicyModule = loadTypeScriptModuleWithMocks(
  'src/features/screenCapture/application/ScreenObservationPolicy.ts',
  {
    '@features/deviceControl': {},
    '@features/phoneTools': {
      assertProtectedAppCapabilityAllowed:
        protectedAppsPolicyModule.assertProtectedAppCapabilityAllowed,
      ProtectedAppsPolicyError: protectedAppsPolicyModule.ProtectedAppsPolicyError,
    },
  },
);
let observedWindowState = {
  packageName: 'com.example.bank',
  windowId: 17,
  title: null,
  detectionReliable: true,
  checkedAtEpochMs: 1,
  source: 'accessibility',
};
let nativeCaptureParams = null;
const screenCaptureModule = loadTypeScriptModuleWithMocks(
  'src/features/screenCapture/application/ScreenCapture.ts',
  {
    '@features/deviceControl': {
      getDeviceObserverConnectionState: async () => ({
        accessibilityEnabled: true,
        accessibilityConnected: true,
        canTakeScreenshot: true,
      }),
      getCurrentWindowState: async () => observedWindowState,
      captureDeviceObserverScreenshot: async (params) => {
        nativeCaptureParams = params;
        return {
          uri: 'file:///cache/screen.png',
          width: 1080,
          height: 2400,
          mimeType: 'image/png',
          capturedAtEpochMs: 2,
        };
      },
      deleteDeviceObserverScreenshot: async () => {},
    },
    '@features/phoneTools': {
      loadCurrentProtectedPackages: async () => ['com.example.bank'],
    },
    './ScreenCapturePolicy': screenCapturePolicyModule,
    './ScreenObservationPolicy': screenObservationPolicyModule,
  },
);

await assert.rejects(
  () => screenCaptureModule.captureScreenForCurrentWindow(),
  (error) => (
    error instanceof screenCapturePolicyModule.ScreenCaptureError
    && error.reason === 'protected_app'
    && error.message === '该应用被用户设置为受保护应用，AI 无权查看。'
  ),
  '统一策略必须继续以既有截图错误契约阻止受保护应用',
);
assert.equal(nativeCaptureParams, null, '受保护应用不得触发 native 截图');

observedWindowState = {
  ...observedWindowState,
  packageName: 'com.example.article',
};
await screenCaptureModule.captureScreenForCurrentWindow();
assert.deepEqual(
  nativeCaptureParams.expectedWindow,
  { packageName: 'com.example.article', windowId: 17 },
  '允许窗口仍须把同一窗口身份作为 native fence',
);

const companionConversationTargetSource = read(
  'src/features/companion/application/CompanionConversationTarget.ts',
);

const nativeNotificationSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationPublisher.kt'
);
assert.match(nativeNotificationSource, /postConversation/);
assert.match(nativeNotificationSource, /areNotificationsEnabled\(\)/);
assert.match(nativeNotificationSource, /IMPORTANCE_NONE/);
assert.match(nativeNotificationSource, /NotificationStateStore\.recordDiagnostics/);

const chatRouteScreensSource = read('src/features/chat/presentation/shell/ChatRouteScreens.tsx');
assert.match(
  chatRouteScreensSource,
  /const chatBackgroundKey = `single:\$\{sessionId \|\| state\.currentSession\?\.id \|\| aiId\}`/,
  '主动消息进入聊天时必须从目标会话参数生成稳定的聊天背景键'
);
assert.match(
  chatRouteScreensSource,
  /return <RouteLoading chatBackgroundKey=\{chatBackgroundKey\} \/>/,
  '目标会话准备期间必须继续渲染聊天背景，不得回退到全局背景'
);

const hostSource = read('src/host/KimiPhoneHost.tsx');
assert.doesNotMatch(hostSource, /Linking\.addEventListener\('url'|Linking\.getInitialURL\(\)/);
assert.doesNotMatch(hostSource, /parseRavenCatDeepLink/);
assert.match(hostSource, /refreshAllUnreadCounts\(\)/);
assert.match(hostSource, /useRootNavigationReady\(\)/);
assert.match(hostSource, /consumePendingNotificationResponses\(\)/);
// 启动编排改为基于完成状态的 StartupRecoveryCoordinator pipeline：
// 悬浮交互投影对账必须是首个阶段，runtime 对账在 conversation list ready 之后。
const startupCoordinatorSource = read(
  'src/host/runtime/StartupRecoveryCoordinator.ts'
);
assert.match(
  startupCoordinatorSource,
  /'raven-cat-surface'[\s\S]*restoreRavenCatSurface\(\)/,
  '启动编排器必须包含 RavenCat 可见悬浮层恢复阶段',
);
assert.match(
  startupCoordinatorSource,
  /'conversation-list'[\s\S]*waitForConversationListReady\(\)/,
  '启动编排器必须包含会话列表 ready 阶段',
);
assert.match(
  startupCoordinatorSource,
  /'runtime-recovery'[\s\S]*recoverRequiredRuntimeState\(\)/,
  '启动编排器必须包含 runtime 恢复阶段',
);
assert.doesNotMatch(
  startupCoordinatorSource,
  /'memory-recovery'|'memory-maintenance'/,
  'Legacy memory 启动阶段已删除，不得在启动编排器中复活',
);
// Host 必须通过 runStartupRecovery 启动 pipeline，而不是 fire-and-forget。
assert.match(
  hostSource,
  /runStartupRecovery\([\s\S]*restoreRavenCatSurface:[\s\S]*reconcileFloatingInteraction\(\)/,
  'Host 必须将 Floating Layer 悬浮交互投影对账作为启动 pipeline 的首个阶段',
);
assert.match(
  hostSource,
  /recoverRequiredRuntimeState:[\s\S]*reconcileCompanionNotificationState\(\)/,
  'RavenCat runtime 对账必须由启动 pipeline 的 runtime 阶段执行',
);

// 悬浮交互的 SQLite 开关是用户意图真值，native Service 只是投影。
let floatingEnabled = false;
let floatingRunning = false;
let floatingOverlayGranted = false;
let floatingStartError = null;
let floatingPersistCalls = 0;
let floatingStartCalls = 0;
let floatingStopCalls = 0;
const floatingSettings = () => ({
  id: 'default',
  enabled: floatingEnabled,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
});
const floatingInteraction = loadTypeScriptModuleWithMocks(
  'src/features/floatingLayer/application/FloatingInteractionFacade.ts',
  {
    './FloatingLayerRuntimeDependencies': {
      getFloatingLayerRuntimeDependencies: () => ({
        repositories: {
          floatingInteractionSettings: {
            ensureDefault: async () => floatingSettings(),
            setEnabled: async (enabled) => {
              floatingPersistCalls += 1;
              floatingEnabled = enabled;
              return floatingSettings();
            },
          },
        },
        native: {
          floatingLayer: {
            isFloatingLayerRunning: async () => floatingRunning,
            isOverlayPermissionGranted: async () => floatingOverlayGranted,
            startFloatingLayer: async () => {
              floatingStartCalls += 1;
              if (floatingStartError) throw floatingStartError;
              floatingRunning = true;
            },
            stopFloatingLayer: async () => {
              floatingStopCalls += 1;
              floatingRunning = false;
            },
          },
        },
      }),
    },
  },
);

await assert.rejects(
  () => floatingInteraction.setFloatingInteractionEnabled(true),
  (error) => (
    error instanceof floatingInteraction.FloatingInteractionOverlayPermissionError
    && error.code === 'overlay_permission_missing'
  ),
  '缺少 Overlay 权限时不得提交开启意图',
);
assert.equal(floatingPersistCalls, 0);

floatingOverlayGranted = true;
floatingStartError = new Error('模拟 native 投影失败');
await assert.rejects(
  () => floatingInteraction.setFloatingInteractionEnabled(true),
  floatingStartError,
);
assert.equal(floatingEnabled, true, 'native 投影失败后必须保留用户的开启意图');

floatingStartError = null;
await floatingInteraction.reconcileFloatingInteraction();
assert.equal(floatingRunning, true, '对账应依据持久化意图恢复 native 投影');
await floatingInteraction.setFloatingInteractionEnabled(false);
assert.equal(floatingEnabled, false);
assert.equal(floatingRunning, false);
assert.equal(floatingStartCalls, 2);

assert.equal(floatingStopCalls, 1);

// 主理 AI 关系由 assistants 持有；首次开启前 RavenCat 尚未绑定 hostAIId，
// 产品状态仍必须返回已经任命的主理 AI，避免设置入口形成循环依赖。
const appointedHostSummary = {
  id: 'host-ai-1',
  name: '主理 AI',
  model: 'chat-model',
};
let companionState = {
  desiredEnabled: false,
  activationStatus: 'disabled',
  scheduleRevision: 0,
  hostAIId: null,
};
let companionWakeCancellationCount = 0;
let companionSettingsUpdates = [];
const companionSettingsFacade = loadTypeScriptModuleWithMocks(
  'src/features/companion/application/CompanionSettingsFacade.ts',
  {
    '@features/phoneTools': {
      extractUserProtectedPackages: protectedAppsPolicyModule.extractUserProtectedPackages,
    },
    './CompanionRuntimeDependencies': {
      getCompanionRuntimeDependencies: () => ({
        repositories: {
          companionSettings: {
            ensureDefault: async () => ({ quietHoursEnabled: true }),
            update: async (updates) => {
              companionSettingsUpdates.push(updates);
              return updates;
            },
          },
          companionState: {
            ensureDefault: async () => companionState,
            update: async (updates) => {
              companionState = { ...companionState, ...updates };
              return companionState;
            },
          },
          assistants: {
            getHostSummary: async () => appointedHostSummary,
          },
        },
        native: {
          companion: {
            cancelCompanionWake: async () => {
              companionWakeCancellationCount += 1;
            },
          },
        },
      }),
    },
    './AIScheduleProjectionOwner': {
      activateCompanionScheduling: async (hostAIId) => {
        companionState = {
          ...companionState,
          desiredEnabled: true,
          activationStatus: 'enabled',
          hostAIId,
          lastFailureCode: null,
          lastFailureAt: null,
        };
        return companionState;
      },
      disableCompanionScheduling: async (input) => {
        if (input.expectedOwnerAIId && companionState.hostAIId !== input.expectedOwnerAIId) {
          return companionState;
        }
        companionWakeCancellationCount += 1;
        companionState = {
          ...companionState,
          desiredEnabled: false,
          activationStatus: 'disabled',
          hostAIId: input.clearHostAI ? null : companionState.hostAIId,
          lastFailureCode: input.failureCode,
          lastFailureAt: input.failureCode ? '2026-08-29T08:00:00.000Z' : null,
        };
        return companionState;
      },
    },
  },
);
const disabledProductWithAppointedHost =
  await companionSettingsFacade.loadCompanionProductState();
assert.equal(
  disabledProductWithAppointedHost.hostAI,
  appointedHostSummary,
  '伴随尚未绑定 hostAIId 时仍必须识别 assistants 已任命的主理 AI',
);
await companionSettingsFacade.updateCompanionProductSettings({
  userScreenCaptureBlacklist: [
    ...protectedAppsPolicyModule.SYSTEM_PROTECTED_PACKAGES,
    'com.example.bank',
  ],
});
assert.deepEqual(
  companionSettingsUpdates,
  [{ userScreenCaptureBlacklist: ['com.example.bank'] }],
  '任一 CompanionSettings 写入口都不得把固定系统保护集合写回用户字段',
);
await companionSettingsFacade.activateCompanionProductState('host-ai-1');
assert.equal(companionState.desiredEnabled, true);
assert.equal(companionState.activationStatus, 'enabled');
assert.equal(companionState.hostAIId, 'host-ai-1');
await companionSettingsFacade.disableCompanionProductState();
assert.equal(companionState.desiredEnabled, false);
assert.equal(companionState.activationStatus, 'disabled');
assert.equal(companionWakeCancellationCount, 1);

// 任命命令只提交主理 AI 关系，不依赖 RavenCat/原生运行时完成后才向界面返回。
const { HostAuthorityCoordinator } = await importStandaloneTypeScript(
  'src/features/assistants/application/HostAuthorityCoordinator.ts',
);
const assistantManagement = loadTypeScriptModuleWithMocks(
  'src/features/assistants/AIAssistantManagement.ts',
  {
    '@platform/persistence': {},
    '@shared/runtime/abortSignal': { throwIfAbortSignalAborted: () => {} },
    '@shared/errors/SettingChangeConflictError': {},
    './domain/ApplicationSettingsAccess': {},
    '@platform/device': {},
    '@features/media': {
      createMediaAssetWithReference: async () => {
        throw new Error('本 verifier 不应创建 MediaAsset');
      },
      collectChatSessionMediaAssetCandidates: async () => [],
      releaseMediaAssetCandidates: async () => {},
      MEDIA_ASSET_STORAGE_BACKEND: {
        persistentImage: 'persistent_image',
      },
    },
    './domain/HostRepository': {
      HostRelationshipError: class HostRelationshipError extends Error {},
    },
    './infrastructure/SQLiteAssistantRepository': {
      aiAssistantRepository: {
        getById: async () => ({
          id: appointedHostSummary.id,
          isBlocked: false,
          model: appointedHostSummary.model,
        }),
      },
    },
    './infrastructure/SQLiteHostRepository': {
      aiHostRepository: {
        getCurrentHostAIId: async () => null,
        setHostAI: async (aiId) => aiId === appointedHostSummary.id,
      },
    },
    './application/HostAuthorityCoordinator': { HostAuthorityCoordinator },
  },
);
const relationshipChanges = [];
assistantManagement.configureAssistantRuntime({
  onHostRelationshipChanged: async (...args) => relationshipChanges.push(args),
});
assert.equal(
  await assistantManagement.appointHostAIAssistant(appointedHostSummary.id),
  true,
  '任命主理 AI 不应等待伴随队列或原生调度运行时',
);
assert.equal(relationshipChanges[0][1], 'appointed', '任命后必须提交聊天身份事件');
assert.match(
  hostSource,
  /const restoreActiveCallScreen[\s\S]*!rootNavigationReady[\s\S]*getActiveCall\(\)/,
  '后台冷启动时不得在根导航挂载前恢复通话页面'
);
// P0 双 incoming surface 收口：是否恢复 RN CallScreen 由 Calls 层语义函数判定，
// Host 不得自行枚举 requested/ringing 等通话状态。
assert.match(
  hostSource,
  /const restoreActiveCallScreen[\s\S]*shouldRestoreCallScreen\(activeCall\)/,
  '恢复 RN CallScreen 必须经由 Calls 层 shouldRestoreCallScreen 语义判定'
);
const restoreActiveCallScreenBody = hostSource.match(
  /const restoreActiveCallScreen = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[/
)?.[0] ?? '';
assert.ok(restoreActiveCallScreenBody, '必须能提取 restoreActiveCallScreen 函数体');
assert.doesNotMatch(
  restoreActiveCallScreenBody,
  /'(?:requested|ringing|dialing|connecting)'/,
  'Host 不得自行枚举通话状态决定是否恢复 RN CallScreen'
);
// native accept 只进入一次 active CallScreen：acceptCall() 使状态进入 active 后才导航，
// 同一路径打开前必须检查当前不在该通话页。
assert.match(
  hostSource,
  /notificationAction === 'accept'[\s\S]*await acceptCall\(payload\.callId\)[\s\S]*accepted\.call\.state !== 'active'[\s\S]*return/,
  'native accept 必须在 acceptCall() 进入 active 后才打开 RN CallScreen'
);
assert.match(
  hostSource,
  /pathname !== `\/calls\/\$\{payload\.callId\}`[\s\S]*openCallScreen\(payload\.callId\)/,
  'accept 导航必须去重，避免重复进入同一条 CallScreen'
);
// open/异常 action 在 incoming requested/ringing 期间不得打开 RN 页面：
// 是否进入 RN CallScreen 统一由 Calls 层语义函数按 accept 后的最新状态判定。
assert.match(
  hostSource,
  /shouldRestoreCallScreen\(currentCall\)[\s\S]*return[\s\S]*pathname !== `\/calls\/\$\{payload\.callId\}`/,
  'open 在 incoming ringing 期间不得打开 RN CallScreen，accept 后须按最新状态判定'
);
// Host 消费 durable reject response：rejectCall() 对 Headless 已提交的拒接幂等 no-op，
// 之后必须清时间线缓存并发布更新时间线事件，保证聊天状态立即与 native 操作对账。
assert.match(
  hostSource,
  /notificationAction === 'reject'[\s\S]*await rejectCall\(payload\.callId, 'userRejected'\)[\s\S]*clearSessionTimelineCache\(call\.chatSessionId\)[\s\S]*emitChatMessagesUpdated\(call\.chatSessionId\)/,
  'Host 消费 reject response 必须刷新聊天时间线完成跨 runtime 对账'
);
assert.match(
  restoreActiveCallScreenBody,
  /pendingNotificationNavigationRef\.current[\s\S]*processingExternalNavigationRef\.current/,
  '外部导航（含 native accept）处理期间必须抑制 restoreActiveCallScreen，保证只进入一次'
);
assert.match(
  hostSource,
  /!dbReady[\s\S]*\|\| !rootNavigationReady[\s\S]*\|\| !pendingNotificationNavigation/,
  '后台冷启动时不得在根导航挂载前消费外部导航目标'
);

const rootNavigationReadySource = read(
  'src/host/navigation/useRootNavigationReady.ts'
);
assert.match(rootNavigationReadySource, /Boolean\(rootNavigationKey\)/);
assert.match(rootNavigationReadySource, /navigationContainerRef\.isReady\(\)/);
assert.match(rootNavigationReadySource, /addListener\([\s\S]*'ready'/);
assert.match(rootNavigationReadySource, /addListener\([\s\S]*'state'/);

const settingsSource = read(
  'src/features/companion/presentation/CompanionSettingsScreen.tsx'
);
assert.match(settingsSource, /NavigationHeader title="本地伴随"/);
assert.match(settingsSource, /勿扰时段/);
assert.match(settingsSource, /窥屏黑名单/);
assert.doesNotMatch(settingsSource, /CONTACT_ROUTE_POINT_COSTS/);
assert.doesNotMatch(settingsSource, /主动联系点数/);

assert.equal(
  fs.existsSync(path.join(repoRoot, 'src/features/companion/application/CompanionDecisionContract.ts')),
  false,
  'CompanionDecisionContract.ts 已随旧决策模型退役'
);

const hostToolsSource = read('src/host/composition/agent/createAgentToolRegistry.ts');
assert.doesNotMatch(hostToolsSource, /set_next_companion_wake|SetNextCompanionWakeTool/);
assert.equal(
  fs.existsSync(path.join(repoRoot, 'src/features/companion/aiTools/SetNextCompanionWakeTool.ts')),
  false,
  'AI 不得再拥有修改未来联系计划的工具',
);

const callRuntimeDependenciesSource = read(
  'src/features/calls/application/runtime/CallRuntimeDependencies.ts'
);
assert.match(callRuntimeDependenciesSource, /onCallTerminated/);

const headlessEvents = [];
const headlessCompletions = [];
const claimedWake = {
  wakeId: 'formal-wake',
  ownerAIId: 'host-ai',
  wakeAt: '2026-08-30T08:00:00.000Z',
  note: null,
  status: 'claimed',
  createdByRunId: 'creator-run',
  claimedByRunId: 'autonomous-run',
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:05.000Z',
  claimedAt: '2026-08-30T08:00:05.000Z',
  consumedAt: null,
  supersededAt: null,
};
const companionExecutionCancellation = loadTypeScriptModuleWithMocks(
  'src/features/companion/application/CompanionExecutionCancellation.ts',
  {},
);
const companionWakeHeadlessTask = loadTypeScriptModuleWithMocks(
  'src/features/companion/application/ExecuteCompanionWake.ts',
  {
    './CompanionExecutionCancellation': companionExecutionCancellation,
    './CompanionRuntimeDependencies': {
      getCompanionRuntimeDependencies: () => ({
        initializeDatabase: async () => headlessEvents.push(['database']),
        generateAutonomousRunId: () => 'autonomous-run',
        native: {
          companion: {
            recordRunnerCompletion: async (completion) => {
              headlessCompletions.push(completion);
            },
            consumeExecutionCancellation: async () => false,
          },
        },
      }),
    },
    './RunHeadlessAISchedule': {
      runHeadlessAISchedule: async (data) => {
        headlessEvents.push(['claim', {
          wakeId: data.eventId,
          expectedOwnerAIId: data.hostAIId,
          claimedByRunId: 'autonomous-run',
        }]);
        headlessEvents.push(['autonomous-run', {
          runId: 'autonomous-run',
          claimedWake,
        }]);
        headlessEvents.push(['consume', { wakeId: data.eventId }]);
        return {
          status: 'ran',
          result: { terminalCode: 'COMPLETED' },
        };
      },
    },

  },
);
await companionWakeHeadlessTask.runCompanionWake({
  eventId: 'formal-wake',
  triggerKind: 'ai_schedule',
  source: 'work-manager',
  hostAIId: 'host-ai',
  scheduleRevision: 1,
  createdAtEpochMs: Date.parse('2026-08-30T08:00:05.000Z'),
});
assert.equal(headlessEvents[0][0], 'claim');
assert.equal(headlessEvents[0][1].claimedByRunId, 'autonomous-run');
assert.equal(headlessEvents[1][0], 'autonomous-run');
assert.strictEqual(headlessEvents[1][1].claimedWake, claimedWake);
assert.equal(headlessEvents[2][0], 'consume');
assert.equal(headlessEvents[2][1].wakeId, 'formal-wake');
assert.deepEqual(headlessCompletions, [{
  deliveryEventId: 'formal-wake',
  succeeded: true,
  error: null,
}]);
const floatingBridgeSource = read(
  'src/features/companion/presentation/useCompanionFloatingBridge.ts'
);
assert.doesNotMatch(
  floatingBridgeSource,
  /addSendMessageListener|addCaptureScreenRequestListener/,
  '悬浮消息不得重新依赖 React 页面事件监听器'
);

const callRuntimeSource = read(
  'src/features/calls/application/runtime/ProcessCallAIReply.ts'
);
assert.doesNotMatch(callRuntimeSource, /runCallSnapshotOcr|resolveOCRModel/);

const floatingMessageExecutorSource = read(
  'src/features/companion/application/ExecuteFloatingMessage.ts'
);
assert.doesNotMatch(
  floatingMessageExecutorSource,
  /ExecuteProactiveContact/,
  'Floating 消费者不得依赖 legacy proactive executor',
);
const ravenCatHostCompositionSource = read(
  'src/host/composition/configureCompanionRuntime.ts',
);
assert.match(floatingMessageExecutorSource, /await dependencies\.initializeDatabase\(\)/);
assert.match(
  ravenCatHostCompositionSource,
  /sendUserMessageFromExecutionHost[\s\S]*executionMode:\s*'inline_current_host'[\s\S]*deliveryTiming:\s*'immediate'/,
  'RavenCat Host adapter 必须固定 inline_current_host 与 immediate',
);
assert.match(floatingMessageExecutorSource, /await replyCompletion/);
assert.match(floatingMessageExecutorSource, /userNotificationHandled: displayed/);
assert.match(floatingMessageExecutorSource, /recordFloatingMessageTaskCompletion/);
assert.match(floatingMessageExecutorSource, /taskError instanceof ScreenCaptureError/);
assert.doesNotMatch(
  floatingMessageExecutorSource,
  /if \(taskError\) \{\s*throw taskError/,
  '已向悬浮预览回报的预期截屏拒绝不得再制造 Headless Task ERROR'
);

// Phase F3：RavenCat 的 Chat 读取/精确已读必须经由消费者自有窄端口。
const companionRuntimeDependenciesSource = read(
  'src/features/companion/application/CompanionRuntimeDependencies.ts',
);
assert.match(companionRuntimeDependenciesSource, /chat: CompanionChatPort/);
assert.doesNotMatch(
  companionRuntimeDependenciesSource,
  /\bsessions:\s*ISessionRepository/,
  'RavenCat F3 迁移完成后不得继续注入完整会话仓储',
);
assert.doesNotMatch(
  companionRuntimeDependenciesSource,
  /\bmessages:\s*IMessageRepository/,
  'RavenCat proactive F4 不得继续注入完整消息仓储',
);
assert.match(
  companionRuntimeDependenciesSource,
  /sendUserMessageFromExecutionHost/,
  'RavenCat 受控 Headless 消息必须经由自定义窄 port 注入',
);
assert.doesNotMatch(
  companionRuntimeDependenciesSource,
  /typeof\s+resolveChatImageModelInput/,
  'RavenCat runtime 只能声明图片输入窄端口，不得反向依赖 Chat 内部实现类型',
);

for (const relativePath of [
  'src/features/companion/application/ExecuteCompanionWake.ts',
  'src/features/companion/application/ExecuteFloatingMessage.ts',
]) {
  const source = read(relativePath);
  assert.doesNotMatch(
    source,
    /repositories\.(?:messages|sessions)/,
    `${relativePath} 的 F3 Chat 查询不得直接访问 RavenCat repositories`,
  );
}
assert.doesNotMatch(
  companionConversationTargetSource,
  /repositories\.sessions/,
  'Companion 对话目标的活跃会话读取必须走 Chat 窄端口',
);
assert.doesNotMatch(
  floatingMessageExecutorSource,
  /repositories\.messages\.markMessagesAsReadByIds|chatDelivery\.emitMessagesUpdated\(entry\.sessionId\)/,
  '悬浮任务不得整会话标记已读或自行发 UI 刷新',
);

const floatingServiceSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/service/RavenCatOverlayService.kt'
);
const floatingOverlayRuntimeSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/runtime/RavenCatOverlayRuntime.kt'
);
assert.match(
  floatingOverlayRuntimeSource,
  /fun showBubble\(\): Boolean = controller\?\.showBubble\(\) == true/,
  '原生 Service 已运行时必须能幂等补回丢失的悬浮球视图',
);
assert.match(floatingServiceSource, /FOREGROUND_SERVICE_TYPE_SPECIAL_USE/);
assert.doesNotMatch(
  floatingServiceSource,
  /FOREGROUND_SERVICE_TYPE_DATA_SYNC|companionWakeHandler|Headless|dispatchCompanionWake|recoverPending/,
);

const floatingManifestSource = read(
  'modules/ravencat-floating-layer/android/src/main/AndroidManifest.xml'
);
assert.match(floatingManifestSource, /android:foregroundServiceType="specialUse"/);
assert.match(floatingManifestSource, /android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
assert.doesNotMatch(floatingManifestSource, /FOREGROUND_SERVICE_DATA_SYNC|foregroundServiceType="dataSync"/);

const floatingModuleSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/bridge/RavenCatFloatingLayerModule.kt'
);
assert.doesNotMatch(
  floatingModuleSource,
  /scheduleDebugCompanionWake|requestCompanionWake|RavenCatCompanionWakeAlarm/,
  '原生模块不得重新暴露 fixed-route debug wake 入口'
);

const floatingTaskStoreSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/RavenCatFloatingMessageTaskStore.kt'
);
assert.match(floatingTaskStoreSource, /commit\(\)/, '后台请求必须在启动 Headless JS 前同步落盘');

const floatingControllerSource = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/controller/RavenCatOverlayController.kt'
);
assert.match(floatingControllerSource, /fun hideOverlay\(\)[\s\S]*removePanelView\(\)[\s\S]*removeBubbleView\(\)/);
assert.match(
  floatingControllerSource,
  /fun isReplyPreviewVisible\(\): Boolean =[\s\S]*state == RavenCatOverlayWindowState\.PANEL[\s\S]*isPanelAdded[\s\S]*panelView != null/,
  '收起为悬浮球时回复正文不可见，不得标已读或抑制系统通知',
);

const observerServiceSource = read(
  'modules/device-observer/android/src/main/java/expo/modules/deviceobserver/DeviceObserverAccessibilityService.kt'
);
assert.match(
  observerServiceSource,
  /isDefaultHomePackage\(windowState\.packageName\)[\s\S]*"default_display"/,
  'Launcher 当前窗口必须回退到默认显示器，才能包含系统合成的壁纸'
);

// ---------------------------------------------------------------------------
// 以下分区为从历史 Phase 验收脚本迁移的现役断言，去 Phase 化后统一在此维护。
// ---------------------------------------------------------------------------

// ---- 通用悬浮底座分层不变量（原 floating-layer-phase1）----
const overlayRuntimeKotlinRoot =
  'modules/android-overlay-runtime/android/src/main/java/expo/modules/androidoverlayruntime';
for (const file of listKotlinFiles(overlayRuntimeKotlinRoot)) {
  assert.doesNotMatch(file.source, /SDK_INT|VERSION_CODES/, `${file.name} 新增了低版本分支`);
}
// 悬浮窗控制器必须经由通用底座管理窗口，不得直接持有 WindowManager。
assert.doesNotMatch(floatingControllerSource, /getSystemService\(Context\.WINDOW_SERVICE\)/);
assert.doesNotMatch(floatingControllerSource, /windowManager\.(?:addView|updateViewLayout|removeView)/);
// 位置存储只保存位置，不得承载业务状态。
const overlayPositionStoreSource = read(`${overlayRuntimeKotlinRoot}/OverlayPositionStore.kt`);
assert.match(overlayPositionStoreSource, /fun load\(positionKey: String\)/);
assert.match(overlayPositionStoreSource, /fun save\(positionKey: String, position: OverlayPosition\)/);
assert.doesNotMatch(overlayPositionStoreSource, /expanded|draft|enabled|state/i);

// ---- 悬浮层子 View 与 snapshot/intent 边界（原 floating-layer-phase2）----
const floatingKotlinRoot =
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer';
for (const viewPath of [
  'view/RavenCatBubbleView.kt',
  'view/RavenCatPanelView.kt',
  'view/RavenCatPanelHeaderView.kt',
  'view/RavenCatConversationView.kt',
  'view/RavenCatComposerView.kt',
  'view/RavenCatShotActionView.kt',
]) {
  assert.doesNotMatch(
    read(`${floatingKotlinRoot}/${viewPath}`),
    /Repository|SQLite|getDB|Headless|ReactContext|RavenCatFloatingLayerModule|RavenCatOverlayService/,
    '子 View 不得查询业务数据或依赖 bridge、Service、Repository、SQLite',
  );
}
const overlaySnapshotSource = read(`${floatingKotlinRoot}/model/RavenCatOverlaySnapshot.kt`);
assert.doesNotMatch(overlaySnapshotSource, /Context|Service|Repository|React|SQLite|getDB/);
const overlayIntentSource = read(`${floatingKotlinRoot}/model/RavenCatOverlayIntent.kt`);
assert.match(overlayIntentSource, /sealed interface RavenCatOverlayIntent/);
for (const intentName of [
  'Expand', 'Collapse', 'Cancel', 'OpenApp', 'RequestInputFocus', 'ReleaseInputFocus',
  'DraftChanged', 'Send', 'Shot',
]) {
  assert.match(overlayIntentSource, new RegExp(`(?:object|class) ${intentName}\\b`), `缺少有限 intent：${intentName}`);
}
assert.doesNotMatch(overlayIntentSource, /\(\) ->|Repository|Service|React|SQLite|getDB/);

// 截图成功、失败、超时与过期回调由 RavenCatScreenshotVisibilityCoordinatorTest
// 执行真实协调器验证；不再重复约束字段名、默认参数写法和比较表达式。

const configureCompanionRuntimeSource = read('src/host/composition/configureCompanionRuntime.ts');
assert.match(configureCompanionRuntimeSource, /from '@features\/companion\/composition'/);

// ---- Companion 对话目标解析（原 floating-layer-phase0）----
// 对话目标不会自动创建会话：每个主理 AI 只有一个 canonical conversation，只读解析。
assert.match(companionConversationTargetSource, /assistants\.getHostAI\(\)/);
assert.match(companionConversationTargetSource, /chat\.getCanonicalConversation\(ai\.id\)/);
assert.doesNotMatch(companionConversationTargetSource, /create|insert|save/);

// ---- 外部导航与通知点击（原 floating-layer-phase0）----
assert.match(
  nativeNotificationSource,
  /conversationResponseData\([\s\S]*?payload,[\s\S]*?displayId,[\s\S]*?state\.lastMessageAt,[\s\S]*?"ai-message",?[\s\S]*?\)/,
);
assert.match(nativeNotificationSource, /"sessionId" to payload\.optionalString\("sessionId"\)/);

// ---- 通知投递与导航目标（原 floating-layer-phase0）----
// 通知点击只产生一个可寻址聊天页；同一通知的重复响应由稳定 key 去重。
const externalNavigation = loadTypeScriptModuleWithMocks('src/host/navigation/externalNavigation.ts', {
  '@react-navigation/native': { CommonActions },
});

// 通知打开埋在管理页下的会话时，只弹出上层路由，保留会话 key 与前缀顺序。
// Android 原生 Screen 的重新排序会导致视图归属损坏，最终页面可见但无法交互。
const messageStack = StackRouter({ initialRouteName: 'conversations' });
const messageStackOptions = {
  routeNames: ['conversations', 'chat/[aiId]/index', 'chat/groups/[groupId]', 'menu', 'summary'],
  routeParamList: {},
  routeGetIdList: {
    'chat/[aiId]/index': ({ params }) => params.aiId,
    'chat/groups/[groupId]': ({ params }) => params.groupId,
  },
};
let messageStackState = messageStack.getInitialState(messageStackOptions);
function dispatchMessageNavigation(action) {
  messageStackState = messageStack.getStateForAction(messageStackState, action, messageStackOptions);
  assert.ok(messageStackState);
}
const messageRouter = {
  dispatch: dispatchMessageNavigation,
};
const directTarget = { type: 'ai-message', aiId: 'ai / 1', sessionId: 'session ? 1' };
const listKey = messageStackState.routes[0].key;
for (const target of [directTarget, { type: 'group-message', groupId: 'group / 1' }]) {
  externalNavigation.openMessageConversation(messageRouter, target);
  assert.equal(messageStackState.routes.length, 2, '从列表点击通知，应保留列表并打开聊天');
  assert.equal(messageStackState.routes[0].key, listKey, '通知不得替换会话列表');
  dispatchMessageNavigation(CommonActions.goBack());
  assert.equal(messageStackState.routes.length, 1, '系统返回应关闭通知打开的聊天');
  assert.equal(messageStackState.routes[0].key, listKey, '系统返回应回到原列表');
}
externalNavigation.openMessageConversation(messageRouter, directTarget);
const directPrefixKeys = messageStackState.routes.map(({ key }) => key);
for (let visit = 0; visit < 3; visit++) {
  dispatchMessageNavigation(StackActions.push('menu'));
  dispatchMessageNavigation(StackActions.push('summary'));
  externalNavigation.openMessageConversation(messageRouter, directTarget);
  assert.deepEqual(messageStackState.routes.map(({ key }) => key), directPrefixKeys,
    '摘要 → 通知 → 聊天后应关闭管理页，不能搬动已有聊天路由');
  assert.equal(messageStackState.routes.at(-1).params.sessionId, 'session ? 1');
}
externalNavigation.openMessageConversation(messageRouter, { ...directTarget, type: 'ai-message-summary' });
assert.deepEqual(messageStackState.routes.map(({ key }) => key), directPrefixKeys,
  '重复点击或汇总通知不得制造重复会话');
dispatchMessageNavigation(StackActions.push('summary'));
dispatchMessageNavigation(StackActions.pop());
assert.deepEqual(messageStackState.routes.map(({ key }) => key), directPrefixKeys,
  '通知后重新打开摘要再返回，应回到同一个聊天页');
dispatchMessageNavigation(StackActions.push('chat/groups/[groupId]', { groupId: 'group / 1' }));
const groupPrefixKeys = messageStackState.routes.map(({ key }) => key);
dispatchMessageNavigation(StackActions.push('menu'));
externalNavigation.openMessageConversation(messageRouter, { type: 'group-message', groupId: 'group / 1' });
assert.deepEqual(messageStackState.routes.map(({ key }) => key), groupPrefixKeys,
  '群通知同样应退回原群聊，保留更早会话');
externalNavigation.openMessageConversation(messageRouter, { ...directTarget, aiId: 'ai-2', sessionId: 'session-2' });
assert.deepEqual(messageStackState.routes.slice(0, -1).map(({ key }) => key), groupPrefixKeys,
  '目标不在栈中时，应压入新会话并保留当前页与前缀');
assert.equal(messageStackState.routes.at(-1).params.aiId, 'ai-2');
assert.equal(messageStackState.routes.at(-1).params.sessionId, 'session-2');
dispatchMessageNavigation(CommonActions.goBack());
assert.deepEqual(messageStackState.routes.map(({ key }) => key), groupPrefixKeys,
  '新会话返回后应恢复通知点击前的页面');
const messageTarget = externalNavigation.createMessageNavigationTarget({
  type: 'ai-message',
  aiId: 'ai / 1',
  sessionId: 'session ? 1',
  notificationId: 'notification-1',
});
assert.deepEqual(messageTarget, {
  type: 'ai-message',
  aiId: 'ai / 1',
  sessionId: 'session ? 1',
  notificationId: 'notification-1',
});
assert.equal(
  externalNavigation.getExternalNavigationKey(messageTarget),
  externalNavigation.getExternalNavigationKey({ ...messageTarget }),
);

// ---- Phase F3 行为测试：Chat 窄查询与精确已读回执 ----
const readQueryCalls = [];
const readQueryModule = loadTypeScriptModuleWithMocks(
  'src/features/chat/messages/application/ChatReadQueries.ts',
  {
    '../../reply/delivery/AssistantMessageArrival': {},
    '../domain/chatMessageMetadata': {},
    './ChatMessageRuntime': {
      getChatMessageRuntimeDependencies: () => ({
        messages: {
          async getMessages(sessionId, params) {
            readQueryCalls.push({ kind: 'recent', sessionId, params });
            return {
              messages: [
                {
                  id: 12,
                  senderType: 'assistant',
                  isMe: false,
                  text: '后一句',
                  createdAt: '2026-08-11T00:00:02.000Z',
                },
                {
                  id: 11,
                  senderType: 'user',
                  isMe: true,
                  text: '前一句',
                  createdAt: '2026-08-11T00:00:01.000Z',
                },
                {
                  id: 10,
                  senderType: 'system',
                  isMe: false,
                  text: '系统事实',
                  createdAt: '2026-08-11T00:00:00.000Z',
                },
              ],
            };
          },
          async findSentAssistantMessageIdByRelatedEntity(type, id) {
            readQueryCalls.push({ kind: 'source', type, id });
            return type === 'raven_cat_contact_attempt' && id === 'attempt-1'
              ? 12
              : null;
          },
        },
      }),
    },
  },
);
const recentTranscript = await readQueryModule.listRecentChatTranscript({
  sessionId: 'session-read',
});
assert.deepEqual(recentTranscript, [
  { role: 'system', text: '系统事实', createdAt: '2026-08-11T00:00:00.000Z' },
  { role: 'user', text: '前一句', createdAt: '2026-08-11T00:00:01.000Z' },
  { role: 'assistant', text: '后一句', createdAt: '2026-08-11T00:00:02.000Z' },
]);
assert.deepEqual(readQueryCalls[0], {
  kind: 'recent',
  sessionId: 'session-read',
  params: { limit: 10, order: 'DESC' },
});
assert.equal(
  await readQueryModule.findCommittedAssistantMessageIdByRelatedSource({
    relatedEntityType: 'raven_cat_contact_attempt',
    relatedEntityId: 'attempt-1',
  }),
  12,
);
assert.deepEqual(readQueryCalls[1], {
  kind: 'source',
  type: 'raven_cat_contact_attempt',
  id: 'attempt-1',
});

const readState = {
  changed: 2,
  calls: [],
};
const readUIEvents = [];
const markModule = loadTypeScriptModuleWithMocks(
  'src/features/chat/messages/application/MarkChatMessagesReadByIds.ts',
  {
    './ChatMessageRuntime': {
      getChatMessageRuntimeDependencies: () => ({
        messages: {
          async markMessagesAsReadByIds(messageIds) {
            readState.calls.push([...messageIds]);
            if (readState.changed instanceof Error) {
              throw readState.changed;
            }
            return readState.changed;
          },
        },
      }),
    },
    '../events/ChatEvents': {
      emitChatMessagesUpdated(sessionId) {
        readUIEvents.push(sessionId);
      },
    },
  },
);
assert.equal(
  await markModule.markChatMessagesReadByIds({
    sessionId: 'session-receipt',
    messageIds: ['41', '42'],
  }),
  2,
);
assert.deepEqual(readState.calls, [['41', '42']]);
assert.deepEqual(readUIEvents, ['session-receipt']);
readState.changed = 0;
assert.equal(
  await markModule.markChatMessagesReadByIds({
    sessionId: 'session-receipt',
    messageIds: ['41', '42'],
  }),
  0,
);
assert.deepEqual(readUIEvents, ['session-receipt'], 'changes=0 不得发 UI');
readState.changed = new Error('database failure');
await assert.rejects(
  () => markModule.markChatMessagesReadByIds({
    sessionId: 'session-receipt',
    messageIds: ['43'],
  }),
  readState.changed,
);
assert.deepEqual(readUIEvents, ['session-receipt'], 'DB 失败不得发 UI');

let floatingSendOutcome = 'success';
const floatingDeletedAttachments = [];
const floatingSendCalls = [];
const floatingReleasedCaptures = [];
let floatingCaptureAccepted = true;
let floatingCaptureError = null;
let floatingPersistCount = 0;
let floatingTargetFailure = null;
const floatingReplyPreviews = [];
const floatingTaskCompletions = [];
const floatingLayer = {
  async updateTargetPreview() {},
  async updateReplyPreview(preview) { floatingReplyPreviews.push(preview); },
  async completeScreenCaptureVisibility() { return floatingCaptureAccepted; },
  async recordFloatingMessageTaskCompletion(completion) { floatingTaskCompletions.push(completion); },
};
const floatingDeps = {
  chat: {
    async sendUserMessageFromExecutionHost({ message, replyCallbacks }) {
      floatingSendCalls.push(message);
      if (floatingSendOutcome === 'failure_before_commit') {
        return { userMessage: null, success: false, error: '模拟提交前失败' };
      }
      if (floatingSendOutcome === 'failure_after_commit') {
        return {
          userMessage: { id: 502, sessionId: 'session-floating' },
          success: false,
          error: '模拟提交后副作用失败',
        };
      }
      await replyCallbacks.onReplySegment?.({
        segmentIndex: 0,
        sessionId: 'session-floating',
        messageId: 501,
        previewText: '悬浮回复',
        text: '悬浮回复',
      });
      replyCallbacks.onReplyCommitted?.();
      return { userMessage: { id: 501, sessionId: 'session-floating' }, success: true, error: null };
    },
  },
  chatDelivery: {},
  initializeDatabase: async () => {},
  native: { floatingLayer },
};
const floatingMessageExecutorModule = loadTypeScriptModuleWithMocks(
  'src/features/companion/application/ExecuteFloatingMessage.ts',
  {
    '@features/assistants': {
      getAssistantDisplayName: (assistant) => assistant.name,
    },
    '@features/floatingLayer': floatingLayer,
    './CompanionConversationTarget': {
      buildCompanionAIRequestConfig: () => ({}),
      resolveCompanionConversationTarget: async () => floatingTargetFailure ?? ({
        ai: { id: 'assistant-floating', name: 'Host AI' },
        session: { id: 'session-floating', name: 'Floating session' },
      }),
    },
    '@features/screenCapture': {
      releaseCapturedScreen: async (capture) => { floatingReleasedCaptures.push(capture); },
      ScreenCaptureError: class ScreenCaptureError extends Error {},
    },
    './CompanionScreenCapture': {
      captureCompanionScreen: async () => {
        if (floatingCaptureError) throw floatingCaptureError;
        return { screenshot: { uri: 'file:///cache/screen.png' } };
      },
      deletePersistedCompanionScreenAttachment: async (attachment) => {
        floatingDeletedAttachments.push(attachment);
        return true;
      },
      persistCompanionScreenAttachment: async (capture) => {
        floatingPersistCount += 1;
        floatingReleasedCaptures.push(capture);
        return {
          type: 'image',
          localUri: 'file:///persistent-media/chat/images/ravencat-screen.jpg',
          fileName: 'ravencat-screen.jpg',
          mimeType: 'image/jpeg',
        };
      },
    },
    './CompanionRuntimeDependencies': {
      getCompanionRuntimeDependencies: () => floatingDeps,
    },
  },
);

const executeFloating = data => floatingMessageExecutorModule.executeFloatingMessage(data, { signal: new AbortController().signal, executionDeadlineAt: performance.now() + 60_000 });

await executeFloating({
  action: 'message',
  text: '你好',
  correlationId: 'floating-correlation',
});

// 已知目标不可用通过提示与失败回执收口，不触发 React Native 的 Headless ERROR。
const sendCountBeforeTargetFailures = floatingSendCalls.length;
for (const failure of [
  { reason: 'host_ai_unavailable', error: '请先设置主理 AI 后再继续。' },
  { reason: 'host_ai_unavailable', error: '主理 AI 已更换，本次对话目标已失效。' },
  { reason: 'host_ai_blocked', error: '当前主理 AI 已被限制，暂时无法继续。' },
  { reason: 'session_unavailable', error: '未找到主理 AI 的 canonical conversation。' },
]) {
  floatingTargetFailure = failure;
  const correlationId = `floating-target-${failure.reason}`;
  await executeFloating({
    action: 'message', text: '你好', correlationId,
  });
  assert.deepEqual(floatingReplyPreviews.at(-1), {
    correlationId, status: 'error', text: failure.error,
  });
  assert.deepEqual(floatingTaskCompletions.at(-1), {
    correlationId, succeeded: false, error: failure.error,
  });
}
assert.equal(floatingSendCalls.length, sendCountBeforeTargetFailures, '目标不可用不得提交消息或调用 AI');

// 发送前接管的截图在目标不可用时仍须释放，不能进入附件持久化。
await executeFloating({
  action: 'screen', correlationId: 'floating-screen-without-host',
});
const releaseCountBeforeMissingHost = floatingReleasedCaptures.length;
floatingTargetFailure = { reason: 'host_ai_unavailable', error: '请先设置主理 AI 后再继续。' };
await executeFloating({
  action: 'message', text: '', correlationId: 'floating-image-without-host',
  screenshotCorrelationId: 'floating-screen-without-host',
});
assert.equal(floatingReleasedCaptures.length, releaseCountBeforeMissingHost + 1);
assert.equal(floatingPersistCount, 0);
floatingTargetFailure = null;
floatingReleasedCaptures.length = 0;

floatingSendOutcome = 'failure_before_commit';
await assert.rejects(executeFloating({
  action: 'message',
  text: '失败回复',
  correlationId: 'floating-failed-correlation',
}), /模拟提交前失败/, '真实发送故障仍须暴露');

// 截图只暂存；用户显式发送时才持久化附件并调用 Chat。
floatingSendOutcome = 'success';
const sendCountBeforeCapture = floatingSendCalls.length;
await executeFloating({
  action: 'screen', correlationId: 'floating-staged-image',
});
assert.equal(floatingSendCalls.length, sendCountBeforeCapture, '截图不得发送消息或调用 AI');
assert.equal(floatingPersistCount, 0, '截图暂存期间不得持久化到聊天附件目录');
assert.equal(floatingReleasedCaptures.length, 0, '待发送截图必须保留');
await executeFloating({
  action: 'message', text: '', correlationId: 'floating-image-only-send',
  screenshotCorrelationId: 'floating-staged-image',
});
assert.equal(floatingSendCalls.at(-1).text, '', '纯图片发送不得添加强制问屏提示词');
assert.equal(floatingSendCalls.at(-1).attachments.length, 1);
assert.equal(floatingPersistCount, 1);
assert.equal(floatingDeletedAttachments.length, 1, '发送后释放准备文件');

await executeFloating({
  action: 'screen', correlationId: 'floating-staged-text-image',
});
await executeFloating({
  action: 'message', text: '  帮我看看这个按钮  ', correlationId: 'floating-text-image-send',
  screenshotCorrelationId: 'floating-staged-text-image',
});
assert.equal(floatingSendCalls.at(-1).text, '帮我看看这个按钮');
assert.equal(floatingSendCalls.at(-1).attachments.length, 1);

const sendCountBeforeDiscard = floatingSendCalls.length;
await executeFloating({
  action: 'screen', correlationId: 'floating-staged-discard',
});
const releaseCountBeforeDiscard = floatingReleasedCaptures.length;
await executeFloating({
  action: 'discard_screen', correlationId: 'floating-discard',
  screenshotCorrelationId: 'floating-staged-discard',
});
assert.equal(floatingReleasedCaptures.length, releaseCountBeforeDiscard + 1, '移除或替换截图时释放缓存');
assert.equal(floatingSendCalls.length, sendCountBeforeDiscard, '移除截图不得发送消息');

floatingCaptureAccepted = false;
const releaseCountBeforeExpiredCapture = floatingReleasedCaptures.length;
await executeFloating({
  action: 'screen', correlationId: 'floating-expired-capture',
});
assert.equal(floatingReleasedCaptures.length, releaseCountBeforeExpiredCapture + 1, '超时或关闭窗口后的迟到截图必须释放');
assert.equal(floatingSendCalls.length, sendCountBeforeDiscard);
floatingCaptureAccepted = true;

floatingCaptureError = new Error('模拟截图失败');
await assert.rejects(executeFloating({
  action: 'screen', correlationId: 'floating-capture-failed',
}), /模拟截图失败/);
assert.equal(floatingSendCalls.length, sendCountBeforeDiscard, '截图失败不得发送消息');
floatingCaptureError = null;

await executeFloating({
  action: 'screen', correlationId: 'floating-staged-bootstrap-failure',
});
const releaseCountBeforeBootstrapFailure = floatingReleasedCaptures.length;
floatingDeps.initializeDatabase = async () => { throw new Error('模拟数据库初始化失败'); };
await assert.rejects(executeFloating({
  action: 'message', text: '', correlationId: 'floating-bootstrap-failure-send',
  screenshotCorrelationId: 'floating-staged-bootstrap-failure',
}), /模拟数据库初始化失败/);
assert.equal(floatingReleasedCaptures.length, releaseCountBeforeBootstrapFailure + 1, '发送入口初始化失败仍须释放已接管的截图');
floatingDeps.initializeDatabase = async () => {};

const deletedBeforeFailures = floatingDeletedAttachments.length;
floatingSendOutcome = 'failure_before_commit';
await executeFloating({
  action: 'screen', correlationId: 'floating-screen-before-commit',
});
await executeFloating({
  action: 'message', text: '提交前失败', correlationId: 'floating-send-before-commit',
  screenshotCorrelationId: 'floating-screen-before-commit',
}).catch(() => undefined);
assert.equal(floatingDeletedAttachments.length, deletedBeforeFailures + 1, '未提交的截图附件应清理');

floatingSendOutcome = 'failure_after_commit';
await executeFloating({
  action: 'screen', correlationId: 'floating-screen-after-commit',
});
await executeFloating({
  action: 'message', text: '提交后失败', correlationId: 'floating-send-after-commit',
  screenshotCorrelationId: 'floating-screen-after-commit',
}).catch(() => undefined);
assert.equal(
  floatingDeletedAttachments.length,
  deletedBeforeFailures + 2,
  'Chat 接管独立 canonical backing 后，RavenCat 仍须清理只属于发送准备的截图源',
);

// 本地伴随入口使用轻量助手投影，不读取密钥、Prompt 和其他模型配置。
const assistantDb = new DatabaseSync(':memory:');
assistantDb.exec(`
  CREATE TABLE ai_assistants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    nickname TEXT,
    avatar TEXT,
    avatar_media_asset_id TEXT,
    model TEXT NOT NULL,
    api_key TEXT,
    system_prompt TEXT,
    is_host_ai INTEGER NOT NULL,
    last_active_session_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE ai_blacklist (
    id TEXT PRIMARY KEY,
    ai_id TEXT NOT NULL,
    blocked_until TEXT NOT NULL
  );
  -- 每个 AI 唯一 canonical conversation：summary 通过 sessions.ai_assistant_id 解析。
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    ai_assistant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    last_message TEXT,
    last_time TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO ai_assistants VALUES
    ('ai-1', 'agent-1', '主理', NULL, 'avatar-1', NULL, 'model-1', 'secret-key', 'very-long-prompt', 1, 'session-1', '2026-08-01T00:00:00.000Z'),
    ('ai-2', 'agent-2', '候选', NULL, NULL, NULL, 'model-2', 'secret-key-2', 'another-prompt', 0, 'session-2', '2026-08-02T00:00:00.000Z');
  INSERT INTO ai_blacklist VALUES ('block-1', 'ai-2', '2099-01-01T00:00:00.000Z');
  INSERT INTO sessions VALUES
    ('session-1', 'ai-1', '2026-08-01', '最近消息', '2026-08-01T00:01:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z'),
    ('session-2', 'ai-2', '2026-08-02', NULL, NULL, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
`);
const assistantExecutor = {
  getAllAsync: async (source, params = []) => assistantDb.prepare(source).all(...params),
  getFirstAsync: async (source, params = []) => assistantDb.prepare(source).get(...params) ?? null,
};
const assistantRepositoryModule = loadTypeScriptModuleWithMocks(
  'src/features/assistants/infrastructure/SQLiteAssistantRepository.ts',
  {
    '@features/profile': {},
    './SQLiteAuxiliaryModelDefaults': {},
    './SQLiteAuxiliaryModelRepository': {},
    './SQLiteModelServiceRepository': {},
    '../domain/ModelService': {},
    '@features/media': {
      resolveMediaAssetReferenceUri: async ({ mediaAssetId, legacyUri }) =>
        mediaAssetId ? `asset://${mediaAssetId}` : legacyUri,
    },
    '@platform/persistence': {
      databaseCoordinator: { openTaskExecutor: () => assistantExecutor },
    },
    '../domain/AIProfile': {
      createAIProfile: (value) => value,
    },
    '../domain/HostRepository': {
      createHostAIAppointmentCooldown: () => ({}),
      HOST_AI_RELATIONSHIP_STATE_ID: 'host_ai_relationship_state',
    },
  },
);
const assistantRepository = new assistantRepositoryModule.AIAssistantRepository();
assert.deepEqual(
  await assistantRepository.getHostSummary(),
  {
    id: 'ai-1',
    agentId: 'agent-1',
    name: '主理',
    nickname: null,
    avatar: 'avatar-1',
    avatarMediaAssetId: null,
    model: 'model-1',
    isHostAI: true,
    canonicalConversationId: 'session-1',
    isBlocked: false,
  },
);
assert.deepEqual(
  (await assistantRepository.listSummaries()).map((assistant) => ({
    id: assistant.id,
    isBlocked: assistant.isBlocked,
    fields: Object.keys(assistant).sort(),
  })),
  [
    {
      id: 'ai-1',
      isBlocked: false,
      fields: ['agentId', 'avatar', 'avatarMediaAssetId', 'canonicalConversationId', 'id', 'isBlocked', 'isHostAI', 'model', 'name', 'nickname'],
    },
    {
      id: 'ai-2',
      isBlocked: true,
      fields: ['agentId', 'avatar', 'avatarMediaAssetId', 'canonicalConversationId', 'id', 'isBlocked', 'isHostAI', 'model', 'name', 'nickname'],
    },
  ],
  '助手摘要只能返回界面所需字段，并保留候选禁用状态',
);
assistantDb.close();

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log('RavenCat runtime contract checks passed.');
