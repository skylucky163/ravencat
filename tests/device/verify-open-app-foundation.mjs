import assert from 'node:assert/strict';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';

// 复用真实 Protected Apps policy 作为 action admission 真值，只 mock 用户集合读取。
const protectedAppsPolicy = loadTypeScriptModule(
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
);
const {
  assertProtectedAppCapabilityAllowed,
  ProtectedAppsPolicyError,
  SYSTEM_PROTECTED_PACKAGES,
} = protectedAppsPolicy;

let currentProtectedPackages = [];
let nativeCallCount = 0;
const nativeReceivedPackages = [];
let nativeLaunchResult = { status: 'launch_dispatched', packageName: 'com.example.app' };

// exact package 校验与 browsable URI dispatch 共用同一 contract，避免两个入口漂移。
const exactPackageTarget = loadTypeScriptModule(
  'src/features/deviceControl/application/ExactPackageTarget.ts',
);

const openAppModule = loadTypeScriptModule(
  'src/features/deviceControl/application/OpenApp.ts',
  {
    '@features/phoneTools': {
      assertProtectedAppCapabilityAllowed,
      ProtectedAppsPolicyError,
      loadCurrentProtectedPackages: async () => currentProtectedPackages,
    },
    './ExactPackageTarget': {
      isValidExactTargetPackage: exactPackageTarget.isValidExactTargetPackage,
    },
    './DeviceControlRuntimeDependencies': {
      getDeviceControlRuntimeDependencies: () => ({
        native: {
          deviceControl: {
            openApp: async (packageName) => {
              nativeCallCount += 1;
              nativeReceivedPackages.push(packageName);
              return nativeLaunchResult;
            },
          },
        },
      }),
    },
  },
);

const { openAppByPackage, OpenAppError } = openAppModule;

function resetNative() {
  nativeCallCount = 0;
  nativeReceivedPackages.length = 0;
  nativeLaunchResult = { status: 'launch_dispatched', packageName: 'com.example.app' };
}

async function expectOpenAppError(packageName, reason) {
  resetNative();
  await assert.rejects(
    () => openAppByPackage(packageName),
    (error) => (
      error instanceof OpenAppError
      && error.reason === reason
    ),
    `${packageName} 应返回 ${reason}`,
  );
  assert.equal(nativeCallCount, 0, `${reason} 不得触发 native launch`);
}

// Case 1：正常 launch。
resetNative();
currentProtectedPackages = [];
nativeLaunchResult = { status: 'launch_dispatched', packageName: 'com.example.app' };
let result = await openAppByPackage('com.example.app');
assert.deepEqual(result, { status: 'launch_dispatched', targetPackage: 'com.example.app' });
assert.equal(nativeCallCount, 1);

// Case 2：exact package 保持，不做 toLowerCase 改写。
resetNative();
currentProtectedPackages = [];
nativeLaunchResult = { status: 'launch_dispatched', packageName: 'com.Example.RealApp' };
result = await openAppByPackage('com.Example.RealApp');
assert.deepEqual(result, { status: 'launch_dispatched', targetPackage: 'com.Example.RealApp' });
assert.equal(nativeCallCount, 1);
assert.deepEqual(nativeReceivedPackages, ['com.Example.RealApp'], 'native 必须收到同一 exact package');

// Case 3：invalid package。
for (const invalid of ['', '   ', 'com.example app', '\tcom.example']) {
  await expectOpenAppError(invalid, 'invalid_target_package');
}

// Case 4：固定 System Protected App。
currentProtectedPackages = [...SYSTEM_PROTECTED_PACKAGES];
await expectOpenAppError('com.android.settings', 'protected_app');

// Case 5：用户 Protected App。
currentProtectedPackages = ['com.example.private'];
await expectOpenAppError('com.example.private', 'protected_app');

// Case 6：app_not_launchable，不 retry。
resetNative();
currentProtectedPackages = [];
nativeLaunchResult = { status: 'app_not_launchable', packageName: 'com.example.app', reason: '目标应用没有可执行的前台启动入口' };
await assert.rejects(
  () => openAppByPackage('com.example.app'),
  (error) => error instanceof OpenAppError && error.reason === 'app_not_launchable',
  'app_not_launchable 必须收敛为 OpenAppError',
);
assert.equal(nativeCallCount, 1, 'app_not_launchable 不得 retry');

// Case 7：launch_failed，不 retry。
resetNative();
currentProtectedPackages = [];
nativeLaunchResult = { status: 'launch_failed', packageName: 'com.example.app', reason: '应用启动请求派发失败' };
await assert.rejects(
  () => openAppByPackage('com.example.app'),
  (error) => error instanceof OpenAppError && error.reason === 'launch_failed',
  'launch_failed 必须收敛为 OpenAppError',
);
assert.equal(nativeCallCount, 1, 'launch_failed 不得 retry');

// Case 8：一次成功 launch 只触发一次 native 调用。
resetNative();
currentProtectedPackages = [];
nativeLaunchResult = { status: 'launch_dispatched', packageName: 'com.example.app' };
await openAppByPackage('com.example.app');
assert.equal(nativeCallCount, 1, '一次 openAppByPackage 最多产生 1 次 native launch request');

// Case 9 / 10：OpenApp.ts 不得内部搜索 installed apps，也不读取前台状态。
const openAppSource = read('src/features/deviceControl/application/OpenApp.ts');
assert.doesNotMatch(openAppSource, /getInstalledLaunchableApps|searchInstalledApps|InstalledLaunchable|DeviceObserverFacade/u,
  'OpenApp.ts 不得依赖 installed apps 查询');
assert.doesNotMatch(openAppSource, /getCurrentWindowState|get_foreground_app|WindowState|DeviceObserver/u,
  'OpenApp.ts 不得读取当前前台状态');
assert.doesNotMatch(openAppSource, /\.toLowerCase\s*\(/u, 'OpenApp.ts 不得调用 toLowerCase 改写 package identity');
assert.doesNotMatch(openAppSource, /setTimeout|sleep|retry|while\s*\(/u, 'OpenApp.ts 不得 retry / 轮询');

// 原生架构 guard：Device Control 使用 front-door API，且 launch primitive 无越界依赖。
const nativeModuleSource = read('modules/device-control/android/src/main/java/expo/modules/devicecontrol/bridge/DeviceControlModule.kt');
const nativeLauncherSource = read('modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/AppLauncher.kt');
const nativeResultSource = read('modules/device-control/android/src/main/java/expo/modules/devicecontrol/model/AppLaunchResult.kt');
assert.match(nativeLauncherSource, /getLaunchIntentSenderForPackage/u, '原生 launch 必须使用 front-door API');

// app_not_launchable 的真实产生路径：getLaunchIntentSenderForPackage 官方标注 non-null，
// 未知 package / 无 front-door 的失败在 sendIntent dispatch 时以 SendIntentException 暴露。
// 禁止把 app_not_launchable 挂在永不为 null 的 elvis 死分支上。
assert.doesNotMatch(
  nativeLauncherSource,
  /\?:\s*(?:return\s+)?AppLaunchResult\.appNotLaunchable/u,
  'app_not_launchable 不得来自 non-null API 上的 null 死分支',
);
assert.match(
  nativeLauncherSource,
  /catch\s*\(_:\s*IntentSender\.SendIntentException\)\s*\{\s*AppLaunchResult\.appNotLaunchable/u,
  'SendIntentException dispatch 失败必须映射为 app_not_launchable',
);
assert.match(
  nativeResultSource,
  /目标应用没有可执行的前台启动入口/u,
  'app_not_launchable 文案不得过度断言“package 一定未安装”',
);

for (const forbidden of [
  'queryIntentActivities',
  'ACTION_VIEW',
  'DeviceObserver',
  'ProtectedApps',
  'startRuntime',
  'reconcileSoftLocks',
  'SYSTEM_PROTECTED',
]) {
  assert.doesNotMatch(nativeLauncherSource, new RegExp(forbidden, 'u'),
    `AppLauncher 不得包含 ${forbidden}`);
}
assert.match(nativeModuleSource, /AsyncFunction\("openApp"\)/u, 'bridge 必须暴露 openApp');

console.log('PHONE-6A open_app foundation 契约检查通过。');
