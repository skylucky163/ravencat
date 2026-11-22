import { repoRoot as root } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';


const manifest = read('modules/device-observer/android/src/main/AndroidManifest.xml');
const appQuery = read(
  'modules/device-observer/android/src/main/java/expo/modules/deviceobserver/InstalledLaunchableAppQuery.kt'
);
const deviceModule = read(
  'modules/device-observer/android/src/main/java/expo/modules/deviceobserver/DeviceObserverModule.kt'
);
const blacklistScreen = read(
  'src/features/companion/presentation/CompanionBlacklistScreen.tsx'
);

assert.match(manifest, /<queries>[\s\S]*android\.intent\.action\.MAIN[\s\S]*android\.intent\.category\.LAUNCHER/);
assert.doesNotMatch(manifest, /QUERY_ALL_PACKAGES/);
assert.match(appQuery, /queryIntentActivities/);
assert.match(appQuery, /packageName == context\.packageName/);
assert.match(appQuery, /putIfAbsent/);
assert.match(appQuery, /context\.cacheDir[\s\S]*ICON_SIZE_DP = 48/);
assert.match(appQuery, /iconDataUri/);
assert.match(deviceModule, /AsyncFunction\("getInstalledLaunchableApps"\)/);
assert.match(deviceModule, /AsyncFunction\("clearInstalledAppIconCache"\)/);

assert.match(blacklistScreen, /搜索应用名称或包名/);
assert.match(blacklistScreen, /<Image/);
assert.match(blacklistScreen, /已卸载应用/);
assert.match(blacklistScreen, /!protectedPackages\.has\(normalizePackageName\(app\.packageName\)\)/);
assert.doesNotMatch(blacklistScreen, /新增应用包名|请输入 Android 应用包名|加入黑名单/);

const protectedAppsPolicy = loadTypeScriptModule(
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
);
const {
  extractUserProtectedPackages,
  getEffectiveProtectedPackages,
  SYSTEM_PROTECTED_PACKAGES,
} = protectedAppsPolicy;
const {
  assertScreenObservationWindowAllowed,
  ScreenObservationPolicyError,
} = loadTypeScriptModule(
  'src/features/screenCapture/application/ScreenObservationPolicy.ts',
  {
    '@features/deviceControl': {},
    '@features/phoneTools': protectedAppsPolicy,
  },
);
const allowedWindow = {
  packageName: 'com.example.article',
  windowId: 17,
  title: null,
  detectionReliable: true,
  checkedAtEpochMs: 1,
  source: 'accessibility',
};
assert.deepEqual(
  assertScreenObservationWindowAllowed(allowedWindow, []),
  { packageName: 'com.example.article', windowId: 17 },
);
assert.deepEqual(
  getEffectiveProtectedPackages([
    ' com.example.bank ',
    'COM.EXAMPLE.BANK',
  ]),
  [...SYSTEM_PROTECTED_PACKAGES, 'com.example.bank'].sort(),
  '有效保护集合必须由固定系统保护与用户设置共同组成',
);
assert.deepEqual(
  extractUserProtectedPackages([
    ...SYSTEM_PROTECTED_PACKAGES,
    'com.example.bank',
  ]),
  ['com.example.bank'],
  '用户字段不得保存固定系统保护集合',
);
assert.throws(
  () => assertScreenObservationWindowAllowed(
    allowedWindow,
    ['com.example.article'],
  ),
  (error) => error instanceof ScreenObservationPolicyError && error.reason === 'protected_app',
  '受保护窗口必须在任何屏幕观察前被阻止',
);
assert.throws(
  () => assertScreenObservationWindowAllowed(
    { ...allowedWindow, windowId: null },
    [],
  ),
  (error) => error instanceof ScreenObservationPolicyError && error.reason === 'window_unavailable',
  '缺少稳定窗口身份时不得开始屏幕观察',
);
assert.throws(
  () => assertScreenObservationWindowAllowed(
    { ...allowedWindow, packageName: null },
    [],
  ),
  (error) => error instanceof ScreenObservationPolicyError && error.reason === 'window_unavailable',
  '无法确认当前应用包名时不得开始截图',
);
assert.throws(
  () => assertScreenObservationWindowAllowed(
    { ...allowedWindow, detectionReliable: false },
    [],
  ),
  (error) => error instanceof ScreenObservationPolicyError && error.reason === 'window_unavailable',
  '检测不可靠时不得开始屏幕观察',
);

const floatingStore = read(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/RavenCatFloatingMessageTaskStore.kt'
);
const proactiveCommand = read(
  'src/features/chat/reply/application/RequestProactiveChatReply.ts'
);
assert.match(floatingStore, /KEY_PENDING_TASKS_JSON/);
assert.match(floatingStore, /filterNot \{ it\.correlationId == request\.correlationId \}/);
assert.match(floatingStore, /readPendingTasks/);
assert.match(proactiveCommand, /deliveryTiming: 'immediate'/);

const allSourceRoots = [
  path.join(root, 'android'),
  path.join(root, 'modules'),
  path.join(root, 'src'),
];
for (const sourceRoot of allSourceRoots) {
  const stack = [sourceRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (/\.(?:xml|kt|ts|tsx)$/.test(entry.name)) {
        assert.doesNotMatch(fs.readFileSync(entryPath, 'utf8'), /QUERY_ALL_PACKAGES/);
      }
    }
  }
}

console.log('RavenCat 截屏策略契约检查通过。');
