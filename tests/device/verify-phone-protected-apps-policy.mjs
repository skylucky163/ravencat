import assert from 'node:assert/strict';
import { loadTypeScriptModule, readRepoFile } from '../helpers/load-typescript-module.mjs';

const protectedAppsPolicy = loadTypeScriptModule(
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
);
const {
  assertProtectedAppCapabilityAllowed,
  extractUserProtectedPackages,
  getEffectiveProtectedPackages,
  isProtectedPackage,
  ProtectedAppsPolicyError,
  SYSTEM_PROTECTED_PACKAGES,
} = protectedAppsPolicy;

const effectivePackages = getEffectiveProtectedPackages([
  ' com.example.bank ',
  'COM.EXAMPLE.BANK',
  'com.example.notes',
]);
assert.deepEqual(
  effectivePackages,
  [...SYSTEM_PROTECTED_PACKAGES, 'com.example.bank', 'com.example.notes'].sort(),
  '固定系统保护与用户保护必须按统一 normalization 合并并去重',
);
for (const packageName of SYSTEM_PROTECTED_PACKAGES) {
  assert.equal(isProtectedPackage(packageName, effectivePackages), true);
}
assert.deepEqual(
  extractUserProtectedPackages([
    ...SYSTEM_PROTECTED_PACKAGES,
    'COM.ANDROID.SETTINGS',
    ' com.example.bank ',
  ]),
  ['com.example.bank'],
  '固定系统保护不得写回用户字段',
);
assert.throws(
  () => assertProtectedAppCapabilityAllowed(
    'COM.EXAMPLE.BANK',
    effectivePackages,
    'action',
  ),
  (error) => (
    error instanceof ProtectedAppsPolicyError
    && error.reason === 'protected_app'
    && /AI 无权对其执行此操作/u.test(error.message)
  ),
  '新增设备影响必须返回 typed protected_app failure',
);

const abortSignalRuntime = {
  throwIfAbortSignalAborted: () => {},
};
const authorityRuntime = {
  runAsCurrentHostAuthority: async (_actorAiId, action) => ({
    status: 'authorized',
    value: await action(),
  }),
};
let currentProtectedPackages = ['com.example.bank'];
let activationCount = 0;
const softLockTool = loadTypeScriptModule(
  'src/features/deviceControl/aiTools/SoftLockAppTool.ts',
  {
    '@features/assistants': authorityRuntime,
    '@features/phoneTools': {
      ...protectedAppsPolicy,
      loadCurrentProtectedPackages: async () => currentProtectedPackages,
    },
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '../application/DeviceControl': {
      activateAiSoftLock: async (input) => {
        activationCount += 1;
        return {
          status: 'activated',
          lock: {
            id: 'lock-1',
            targetPackage: input.targetPackage,
            expiresAtEpochMs: input.expiresAtEpochMs,
          },
          native: { status: 'synchronized' },
          runtimeState: { attached: false },
          execution: { state: 'waiting_for_target' },
        };
      },
    },
  },
);
const toolContext = { getAIId: () => 'host-ai' };
const denied = await softLockTool.execute({
  target_package: 'COM.EXAMPLE.BANK',
  duration_seconds: 60,
}, toolContext);
assert.equal(denied.success, false);
assert.equal(denied.errorCode, 'protected_app');
assert.match(denied.error, /^protected_app:/u);
assert.equal(
  activationCount,
  0,
  '受保护目标不得进入业务命令，因此不会创建锁或触发其 native 副作用',
);

currentProtectedPackages = [];
const allowed = await softLockTool.execute({
  target_package: 'com.example.bank',
  duration_seconds: 60,
}, toolContext);
assert.equal(allowed.success, true, '非受保护目标必须保持原 Soft Lock 链路');
assert.equal(activationCount, 1);

let releaseCount = 0;
const releaseTool = loadTypeScriptModule(
  'src/features/deviceControl/aiTools/ReleaseSoftLockTool.ts',
  {
    '@features/assistants': authorityRuntime,
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '../application/DeviceControl': {
      releaseAiSoftLock: async (input) => {
        releaseCount += 1;
        return {
          status: 'released',
          lock: { id: 'lock-1', targetPackage: input.targetPackage },
          native: { status: 'synchronized' },
        };
      },
    },
  },
);
assert.equal(
  isProtectedPackage('com.example.bank', ['com.example.bank']),
  true,
  '回归前提：锁定后目标已经被用户加入 Protected Apps',
);
const released = await releaseTool.execute(
  { target_package: 'com.example.bank' },
  toolContext,
);
assert.equal(released.success, true, 'Protected Apps 不得阻止撤销已有影响');
assert.equal(releaseCount, 1);

const installedAppsTool = loadTypeScriptModule(
  'src/features/deviceControl/aiTools/SearchInstalledAppsTool.ts',
  {
    '@features/assistants': authorityRuntime,
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '../application/DeviceObserverFacade': { getInstalledLaunchableApps: async () => [] },
    '../application/DeviceObserverPort': {
      DeviceObserverInstalledAppsQueryError: class extends Error {},
    },
  },
);
const searchResults = installedAppsTool.searchInstalledApps([
  {
    label: 'Example Bank',
    packageName: 'com.example.bank',
    iconDataUri: null,
    isSystemApp: false,
  },
], 'bank');
assert.deepEqual(
  searchResults.map((item) => item.packageName),
  ['com.example.bank'],
  'Protected App 的身份仍必须能被安装应用搜索发现',
);

const deviceControlSources = [
  'src/features/deviceControl/aiTools/SoftLockAppTool.ts',
  'src/features/deviceControl/aiTools/ReleaseSoftLockTool.ts',
  'src/features/deviceControl/aiTools/SearchInstalledAppsTool.ts',
  'src/features/deviceControl/application/DeviceControl.ts',
].map(readRepoFile).join('\n');
for (const packageName of SYSTEM_PROTECTED_PACKAGES) {
  assert.doesNotMatch(
    deviceControlSources,
    new RegExp(packageName.replaceAll('.', '\\.'), 'u'),
    'Device Control 不得复制固定系统保护包真值',
  );
}

const phoneToolsSources = [
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
  'src/features/phoneTools/application/CurrentProtectedAppsPolicy.ts',
  'src/features/phoneTools/application/ProtectedAppsRuntimeDependencies.ts',
].map(readRepoFile).join('\n');
assert.doesNotMatch(
  phoneToolsSources,
  /@features\/companion|SelfWake|Autonomous/u,
  'Protected Apps owner 不得依赖 Companion 或 WAKE runtime',
);

const screenCaptureSources = [
  'src/features/screenCapture/application/ScreenCapture.ts',
  'src/features/screenCapture/application/ScreenObservationPolicy.ts',
].map(readRepoFile).join('\n');
assert.doesNotMatch(
  screenCaptureSources,
  /@features\/companion|features\/companion\/(?:application|presentation)/u,
  'Screen Observation 不得反向依赖 Companion application/presentation',
);

const companionComposition = readRepoFile('src/host/composition/configureCompanionRuntime.ts');
const phoneToolsComposition = readRepoFile('src/host/composition/configurePhoneToolsRuntime.ts');
assert.doesNotMatch(companionComposition, /configureProtectedAppsRuntimeDependencies/u);
assert.match(phoneToolsComposition, /configureProtectedAppsRuntimeDependencies/u);
assert.match(phoneToolsComposition, /userScreenCaptureBlacklist/u);

console.log('PHONE-2 Protected Apps Policy 契约检查通过。');
