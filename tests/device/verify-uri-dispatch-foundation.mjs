/**
 * PHONE-8C1：Device Control exact-package browsable URI dispatch foundation 契约验证。
 *
 * 锁住的目标：
 * - 这是一个通用 Device Control action primitive，不含任何具体 App（网易云）语义；
 * - application 固定顺序：validate package → validate URI → Protected Apps → native dispatch；
 * - native 只做 ACTION_VIEW + URI data + exact package，无 arbitrary action/extras/fallback/chooser；
 * - typed 结果只表达本地 dispatch truth，不声称目标页面已打开或业务已完成；
 * - 本阶段没有 Agent Tool、没有 package exposure。
 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';
import { DEVICE_CONTROL_AGENT_TOOLS } from '../helpers/device-control-tools.mjs';


/** 去掉 KDoc / 行注释后再扫描禁止面：注释对边界的描述不应触发命中。 */
const stripKotlinComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/\/\/[^\n]*/gu, '');

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
const nativeCalls = [];
let nativeDispatchResult = {
  status: 'uri_dispatched',
  packageName: 'com.example.app',
};

const uriTargetModule = loadTypeScriptModule(
  'src/features/deviceControl/application/BrowsableUriTarget.ts',
);
const exactPackageTargetModule = loadTypeScriptModule(
  'src/features/deviceControl/application/ExactPackageTarget.ts',
);

const dispatchModule = loadTypeScriptModule(
  'src/features/deviceControl/application/DispatchBrowsableUri.ts',
  {
    '@features/phoneTools': {
      assertProtectedAppCapabilityAllowed,
      ProtectedAppsPolicyError,
      loadCurrentProtectedPackages: async () => currentProtectedPackages,
    },
    './BrowsableUriTarget': {
      isValidBrowsableUri: uriTargetModule.isValidBrowsableUri,
    },
    './ExactPackageTarget': {
      isValidExactTargetPackage: exactPackageTargetModule.isValidExactTargetPackage,
    },
    './DeviceControlRuntimeDependencies': {
      getDeviceControlRuntimeDependencies: () => ({
        native: {
          deviceControl: {
            dispatchBrowsableUri: async (packageName, uri) => {
              nativeCallCount += 1;
              nativeCalls.push({ packageName, uri });
              return nativeDispatchResult;
            },
          },
        },
      }),
    },
  },
);

const {
  dispatchBrowsableUriToPackage,
  DispatchBrowsableUriError,
} = dispatchModule;
const { isValidBrowsableUri, MAX_BROWSABLE_URI_LENGTH } = uriTargetModule;

function resetNative() {
  nativeCallCount = 0;
  nativeCalls.length = 0;
  nativeDispatchResult = { status: 'uri_dispatched', packageName: 'com.example.app' };
}

async function expectDispatchError(packageName, uri, reason) {
  resetNative();
  await assert.rejects(
    () => dispatchBrowsableUriToPackage(packageName, uri),
    (error) => (
      error instanceof DispatchBrowsableUriError
      && error.reason === reason
    ),
    `${JSON.stringify(uri)} 应返回 ${reason}`,
  );
  assert.equal(nativeCallCount, 0, `${reason} 不得触发 native dispatch`);
}

// Case 1：valid exact package + 允许的 generic custom scheme URI。
resetNative();
currentProtectedPackages = [];
nativeDispatchResult = { status: 'uri_dispatched', packageName: 'com.example.app' };
let result = await dispatchBrowsableUriToPackage(
  'com.example.app',
  'exampleapp://resource/123?x=y',
);
assert.deepEqual(result, {
  status: 'uri_dispatched',
  targetPackage: 'com.example.app',
}, 'uri_dispatched 不得回传完整 URI');
assert.equal(nativeCallCount, 1);
assert.deepEqual(nativeCalls, [{
  packageName: 'com.example.app',
  uri: 'exampleapp://resource/123?x=y',
}], 'native 必须收到同一 exact package 与同一 URI');

// Case 2：https URI 允许；exact package identity 保持，不做 toLowerCase 改写。
resetNative();
currentProtectedPackages = [];
nativeDispatchResult = { status: 'uri_dispatched', packageName: 'com.Example.RealApp' };
result = await dispatchBrowsableUriToPackage(
  'com.Example.RealApp',
  'https://example.com/path?id=7',
);
assert.deepEqual(result, {
  status: 'uri_dispatched',
  targetPackage: 'com.Example.RealApp',
});
assert.equal(nativeCallCount, 1);
assert.equal(nativeCalls[0].packageName, 'com.Example.RealApp');

// Case 3：invalid package。
for (const invalid of ['', '   ', 'com.example app', '\tcom.example']) {
  await expectDispatchError(invalid, 'exampleapp://resource/123', 'invalid_target_package');
}

// Case 4：invalid URI。
for (const invalid of [
  '',
  '   ',
  'resource/123',
  '//example.com/path',
  'file:///sdcard/secret.txt',
  'content://media/external/audio/media/1',
  'intent://host/path#Intent;scheme=example;end',
  'javascript:alert(1)',
  'data:text/plain;base64,YWJj',
  'exampleapp://resource/a b',
  `exampleapp://resource/${'a'.repeat(MAX_BROWSABLE_URI_LENGTH)}`,
]) {
  await expectDispatchError('com.example.app', invalid, 'invalid_target_uri');
}

// URI 边界：generic custom scheme、https 与上限边界必须被接受。
assert.ok(
  isValidBrowsableUri('exampleapp://resource/123?x=y'),
  'generic custom scheme 必须允许',
);
assert.ok(isValidBrowsableUri('https://example.com/path'), 'https 必须允许');
assert.ok(
  isValidBrowsableUri(`exampleapp://resource/${'a'.repeat(MAX_BROWSABLE_URI_LENGTH - 25)}`),
  '长度上限内的 URI 必须允许',
);

// Case 5：固定 System Protected App。
currentProtectedPackages = [...SYSTEM_PROTECTED_PACKAGES];
await expectDispatchError('com.android.settings', 'exampleapp://resource/123', 'protected_app');

// Case 6：用户 Protected App。
currentProtectedPackages = ['com.example.private'];
await expectDispatchError('com.example.private', 'exampleapp://resource/123', 'protected_app');

// Case 7：Protected App 判定优先于 native dispatch（URI 合法也必须被拦下）。
currentProtectedPackages = ['com.example.private'];
await expectDispatchError('com.example.private', 'https://example.com/path', 'protected_app');

// Case 8：native route_unavailable → typed failure，不 retry。
resetNative();
currentProtectedPackages = [];
nativeDispatchResult = {
  status: 'route_unavailable',
  packageName: 'com.example.app',
  reason: '目标应用当前没有可接受该 URI 的入口',
};
await assert.rejects(
  () => dispatchBrowsableUriToPackage('com.example.app', 'exampleapp://resource/123'),
  (error) => error instanceof DispatchBrowsableUriError && error.reason === 'route_unavailable',
  'route_unavailable 必须收敛为 DispatchBrowsableUriError',
);
assert.equal(nativeCallCount, 1, 'route_unavailable 不得 retry');

// Case 9：native route_dispatch_failed → typed failure，不 retry。
resetNative();
currentProtectedPackages = [];
nativeDispatchResult = {
  status: 'route_dispatch_failed',
  packageName: 'com.example.app',
  reason: 'URI 派发请求执行失败',
};
await assert.rejects(
  () => dispatchBrowsableUriToPackage('com.example.app', 'exampleapp://resource/123'),
  (error) => error instanceof DispatchBrowsableUriError && error.reason === 'route_dispatch_failed',
  'route_dispatch_failed 必须收敛为 DispatchBrowsableUriError',
);
assert.equal(nativeCallCount, 1, 'route_dispatch_failed 不得 retry');

// Case 10：一次成功派发只触发一次 native 调用。
resetNative();
currentProtectedPackages = [];
nativeDispatchResult = { status: 'uri_dispatched', packageName: 'com.example.app' };
await dispatchBrowsableUriToPackage('com.example.app', 'exampleapp://resource/123');
assert.equal(nativeCallCount, 1, '一次 dispatch 最多产生 1 次 native dispatch request');

// ——— Application 源码 guard ———
const dispatchSource = read('src/features/deviceControl/application/DispatchBrowsableUri.ts');
const uriTargetSource = read('src/features/deviceControl/application/BrowsableUriTarget.ts');

assert.doesNotMatch(dispatchSource, /\.toLowerCase\s*\(/u, '不得改写 package identity');
assert.doesNotMatch(
  dispatchSource,
  /setTimeout|sleep|retry|while\s*\(/u,
  'DispatchBrowsableUri 不得 retry / 轮询',
);
assert.doesNotMatch(
  dispatchSource,
  /getInstalledLaunchableApps|searchInstalledApps|InstalledLaunchable|DeviceObserverFacade/u,
  '不得查询 installed apps',
);
assert.doesNotMatch(
  dispatchSource,
  /getCurrentWindowState|get_foreground_app|WindowState|DeviceObserver/u,
  '不得读取当前前台状态',
);
assert.match(
  dispatchSource,
  /assertProtectedAppCapabilityAllowed\(/u,
  '必须经过 Protected Apps action admission',
);
// Protected Apps 必须在 native dispatch 之前。
assert.ok(
  dispatchSource.indexOf('loadCurrentProtectedPackages')
    < dispatchSource.indexOf('dispatchBrowsableUri(targetPackage'),
  'Protected Apps admission 必须在 native dispatch 之前',
);

for (const forbiddenConstant of [
  'netease',
  'cloudmusic',
  'orpheus',
  'thirdfrom',
  'songId',
  'playlistId',
]) {
  assert.doesNotMatch(
    dispatchSource,
    new RegExp(forbiddenConstant, 'iu'),
    `DispatchBrowsableUri 不得出现 ${forbiddenConstant}`,
  );
  assert.doesNotMatch(
    uriTargetSource,
    new RegExp(forbiddenConstant, 'iu'),
    `BrowsableUriTarget 不得出现 ${forbiddenConstant}`,
  );
}

// 只允许单个 URI 字符串输入：不得出现任意 Intent 参数面。
for (const forbiddenSurface of [
  'putExtra',
  'ClipData',
  'component',
  'extras',
  'flags',
  'mimeType',
  'createChooser',
  'sendBroadcast',
  'startService',
  'PendingIntent',
]) {
  assert.doesNotMatch(
    dispatchSource,
    new RegExp(forbiddenSurface, 'iu'),
    `application primitive 不得出现 ${forbiddenSurface}`,
  );
}

// ——— Native contract guard ———
const nativeDispatcherSource = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/BrowsableUriDispatcher.kt',
);
const nativeResultSource = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/model/UriDispatchResult.kt',
);
const nativeBridgeSource = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/bridge/DeviceControlModule.kt',
);

assert.match(nativeDispatcherSource, /Intent\.ACTION_VIEW/u, '必须使用 ACTION_VIEW');
assert.match(nativeDispatcherSource, /Uri\.parse\(uri\)/u, '必须把 URI 作为 Intent data');
assert.match(nativeDispatcherSource, /setPackage\(packageName\)/u, '必须锁定 exact package');
assert.match(
  nativeDispatcherSource,
  /addCategory\(Intent\.CATEGORY_BROWSABLE\)/u,
  '必须保持 browsable 语义',
);
assert.match(
  nativeDispatcherSource,
  /addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK\)/u,
  'application context 启动前台 Activity 必须带 FLAG_ACTIVITY_NEW_TASK',
);
assert.match(
  nativeDispatcherSource,
  /catch\s*\(_:\s*ActivityNotFoundException\)\s*\{\s*UriDispatchResult\.routeUnavailable/u,
  'ActivityNotFoundException 必须映射为 route_unavailable',
);
assert.match(
  nativeDispatcherSource,
  /catch\s*\(_:\s*SecurityException\)\s*\{\s*UriDispatchResult\.routeDispatchFailed/u,
  'SecurityException 必须映射为 route_dispatch_failed',
);

const nativeDispatcherCode = stripKotlinComments(nativeDispatcherSource);

// 只允许一次 startActivity：不存在 untargeted 二次尝试或 hidden fallback。
assert.equal(
  nativeDispatcherSource.match(/startActivity\(/gu)?.length,
  1,
  'native 只能派发一次，不得 fallback 到 untargeted implicit intent',
);

for (const forbidden of [
  'putExtra',
  'setClassName',
  'ComponentName',
  'createChooser',
  'sendBroadcast',
  'startService',
  'ClipData',
  'setType',
  'FLAG_GRANT',
  'queryIntentActivities',
  'QUERY_ALL_PACKAGES',
  'MATCH_DEFAULT_ONLY',
  'resolveActivity',
  'ProtectedApps',
  'SYSTEM_PROTECTED',
]) {
  assert.doesNotMatch(
    nativeDispatcherCode,
    new RegExp(forbidden, 'u'),
    `BrowsableUriDispatcher 不得包含 ${forbidden}`,
  );
}

for (const forbiddenConstant of [
  'netease',
  'cloudmusic',
  'orpheus',
  'thirdfrom',
]) {
  assert.doesNotMatch(
    nativeDispatcherSource,
    new RegExp(forbiddenConstant, 'iu'),
    `BrowsableUriDispatcher 不得出现 ${forbiddenConstant}`,
  );
  assert.doesNotMatch(
    nativeResultSource,
    new RegExp(forbiddenConstant, 'iu'),
    `UriDispatchResult 不得出现 ${forbiddenConstant}`,
  );
  assert.doesNotMatch(
    nativeBridgeSource,
    new RegExp(forbiddenConstant, 'iu'),
    `DeviceControlModule 不得出现 ${forbiddenConstant}`,
  );
}

const nativeResultCode = stripKotlinComments(nativeResultSource);

// 结果契约：三个 typed 状态齐备，且结果不回传完整 URI。
for (const status of ['uri_dispatched', 'route_unavailable', 'route_dispatch_failed']) {
  assert.match(nativeResultSource, new RegExp(`"${status}"`, 'u'), `缺少 ${status}`);
}
assert.doesNotMatch(nativeResultSource, /"uri"|val uri/u, 'typed 结果不得回传完整 URI');
// dispatch success 不得声称 UI / 业务结果完成。
assert.doesNotMatch(
  nativeResultCode,
  /已打开|已播放|已开始播放|已进入前台|页面正确|成功/u,
  'uri_dispatched 不得声称 UI 或业务结果完成',
);
assert.match(
  nativeBridgeSource,
  /AsyncFunction\("dispatchBrowsableUri"\)/u,
  'bridge 必须暴露 dispatchBrowsableUri',
);

// ——— TS bridge / port / adapter guard ———
const tsBridgeSource = read('modules/device-control/src/DeviceControlModule.ts');
const portSource = read('src/features/deviceControl/application/DeviceControlPort.ts');
const adapterSource = read('src/features/deviceControl/infrastructure/DeviceControlAdapter.ts');

assert.match(
  tsBridgeSource,
  /dispatchBrowsableUri\(\s*packageName: string,\s*uri: string,?\s*\):\s*Promise<DeviceControlUriDispatchResult>/u,
  'bridge declaration 必须只接受 package + uri',
);
assert.match(
  portSource,
  /dispatchBrowsableUri\(\s*packageName: string,\s*uri: string,?\s*\):\s*Promise<DeviceControlUriDispatchResult>/u,
  'DeviceControlPort 必须声明 dispatchBrowsableUri',
);
assert.match(
  adapterSource,
  /async dispatchBrowsableUri\(packageName, uri\)/u,
  'adapter 必须实现 dispatchBrowsableUri',
);
for (const forbiddenConstant of ['netease', 'orpheus', 'thirdfrom']) {
  assert.doesNotMatch(
    tsBridgeSource,
    new RegExp(forbiddenConstant, 'iu'),
    `TS bridge 不得出现 ${forbiddenConstant}`,
  );
}

// ——— 阶段边界 guard：本阶段没有 Agent Tool、没有 package exposure ———
const featureIndexSource = read('src/features/deviceControl/index.ts');
// PHONE-8C2 起出现真实 Host consumer：只暴露受 Protected Apps 保护的 application primitive。
assert.match(
  featureIndexSource,
  /dispatchBrowsableUriToPackage,/,
  'Device Control 公共出口必须暴露 application-level dispatchBrowsableUriToPackage',
);
assert.match(
  featureIndexSource,
  /\} from '\.\/application\/DispatchBrowsableUri';/u,
  'dispatch 出口必须来自 application 层，不得是 raw native bridge',
);
assert.doesNotMatch(
  featureIndexSource,
  /dispatchBrowsableUri\b(?!ToPackage)/u,
  '公共出口不得暴露 raw native dispatchBrowsableUri',
);
assert.doesNotMatch(
  featureIndexSource,
  /infrastructure\/DeviceControlAdapter|deviceControlAdapter/u,
  '公共出口不得暴露 Device Control infrastructure adapter',
);
assert.doesNotMatch(
  featureIndexSource,
  /netease|orpheus/iu,
  'Device Control 公共出口不得出现网易云语义',
);
assert.deepEqual(
  fs.readdirSync(path.join(repoRoot, 'src/features/deviceControl/aiTools')).sort(),
  DEVICE_CONTROL_AGENT_TOOLS,
  'PHONE-8C1 不得新增任何 Agent Tool',
);

console.log('PHONE-8C1 exact-package browsable URI dispatch foundation 契约检查通过。');
