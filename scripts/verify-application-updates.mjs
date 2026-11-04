/** 验证发布边界、版本升级、跳过、下载与前台安装提示的真实行为。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__DEV__ = false;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, dependencies = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)((name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`${file} 缺少测试依赖 ${name}`);
  }, module, module.exports);
  return module.exports;
}
const { createApplicationUpdates } = load('src/host/application/ApplicationUpdates.ts');
const makeRelease = (version) => ({ tag: 'v' + version, version, prerelease: true, notes: '更新说明',
  apk: { url: 'https://github.com/skylucky163/ravencat/releases/download/v' + version + '/RavenCat.apk', size: 3, sha256: 'a'.repeat(64) } });
const defaults = {
  installedVersion: '2.0.0', fetchReleases: async () => [],
  loadSkippedVersion: async () => null, saveSkippedVersion: async () => {},
  downloadRelease: async () => 'file:///cache/app-updates/RavenCat-update.apk',
};
let skipped = null;
let releases = ['2.9.0', '2.0.0', '1.9.0', '2.10.0', 'docs-only'].map(makeRelease);
const storage = { loadSkippedVersion: async () => skipped, saveSkippedVersion: async (version) => { skipped = version; } };
let updates = createApplicationUpdates({ ...defaults, ...storage, fetchReleases: async () => releases });
assert.equal((await updates.check()).version, '2.10.0', '按版本号选择，不按字符串或发布时间排序');
await updates.skip(updates.getSnapshot().available);
assert.equal(updates.shouldPrompt(updates.getSnapshot().available), false);
assert.equal(updates.getSnapshot().available.version, '2.10.0', '跳过不清除设置入口的可用更新');
updates = createApplicationUpdates({ ...defaults, ...storage, fetchReleases: async () => releases });
assert.equal((await updates.check()).version, '2.10.0');
assert.equal(updates.shouldPrompt(updates.getSnapshot().available), false, '重启仍记住跳过版本');
releases = [makeRelease('2.11.0')];
assert.equal(updates.shouldPrompt(await updates.check()), true, '后续新版本重新提醒');
for (const version of ['2.0.0', '2.0.0+build.123', '1.99.0', '2.0.0-beta.1']) {
  const current = createApplicationUpdates({ ...defaults, fetchReleases: async () => [makeRelease(version)] });
  assert.equal(await current.check(), null, `${version} 不高于已安装正式版本`);
}
updates = createApplicationUpdates({ ...defaults, installedVersion: '2.1.0-beta.2',
  fetchReleases: async () => ['2.1.0-beta.10', '2.1.0-beta.3'].map(makeRelease) });
assert.equal((await updates.check()).version, '2.1.0-beta.10');
updates = createApplicationUpdates({ ...defaults, installedVersion: '2.1.0-beta.10', fetchReleases: async () => [makeRelease('2.1.0')] });
assert.equal((await updates.check()).version, '2.1.0');
updates = createApplicationUpdates({ ...defaults, installedVersion: '2.1.0-preview.1', fetchReleases: async () => [makeRelease('2.1.1')] });
assert.equal((await updates.check()).version, '2.1.1', '原预览版能识别本次 2.1.1 更新');
let resolveQuery;
let queryCalls = 0;
updates = createApplicationUpdates({ ...defaults, fetchReleases: () => {
  queryCalls++;
  return new Promise((resolve) => { resolveQuery = resolve; });
} });
const first = updates.check();
assert.equal(updates.check(), first, '同时自动与手动检查共享请求');
await Promise.resolve();
resolveQuery([makeRelease('2.1.0')]);
await first;
assert.equal(queryCalls, 1);
assert.equal(updates.getSnapshot().checking, false);
let failQuery = true;
updates = createApplicationUpdates({ ...defaults, fetchReleases: async () => {
  if (failQuery) throw new Error('网络不可用');
  return [makeRelease('2.1.0')];
} });
await assert.rejects(updates.check(), /网络不可用/);
assert.equal(updates.getSnapshot().checking, false);
failQuery = false;
assert.equal((await updates.check()).version, '2.1.0', '网络恢复后可手动重试');
let finishDownload;
let reportProgress;
let downloads = 0;
let requestedSource;
updates = createApplicationUpdates({ ...defaults, downloadRelease: (_release, source, progress) => {
  downloads++;
  requestedSource = source;
  reportProgress = progress;
  return new Promise((resolve) => { finishDownload = resolve; });
} });
const download = updates.download(makeRelease('2.1.0'), 'gitee');
assert.equal(updates.download(makeRelease('2.1.0'), 'github'), download);
assert.equal(requestedSource, 'gitee', '并发入口复用已经选择的下载，不启动另一条下载');
reportProgress(0.5);
assert.equal(updates.getSnapshot().download.progress, 0.5);
assert.equal(updates.getSnapshot().download.uri, null, '下载中尚不可安装');
finishDownload('file:///cache/app-updates/RavenCat-update.apk');
await download;
await updates.download(makeRelease('2.1.0'), 'github');
assert.equal(downloads, 1, '两个来源交付同一 APK，同进程已验证的包不重复下载');
updates = createApplicationUpdates({ ...defaults, downloadRelease: async () => { throw new Error('校验失败'); } });
await assert.rejects(updates.download(makeRelease('2.1.0'), 'gitee'), /校验失败/);
assert.equal(updates.getSnapshot().download, null, '失败不能留下可安装状态');

const { fetchApplicationReleases } = load('src/platform/updates/GitHubReleases.ts');
const originalFetch = globalThis.fetch;
const asset = { name: 'RavenCat.apk', state: 'uploaded', size: 3, digest: 'sha256:' + 'a'.repeat(64),
  browser_download_url: 'https://github.com/skylucky163/ravencat/releases/download/v2.1.0/RavenCat.apk' };
const rawRelease = { tag_name: 'v2.1.0', prerelease: true, draft: false, body: '更新说明', assets: [asset] };
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/repos/skylucky163/ravencat/releases');
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => [rawRelease, { ...rawRelease, draft: true }, { ...rawRelease, assets: [] }] };
  };
  const result = await fetchApplicationReleases();
  assert.equal(result.length, 1);
  assert.equal(result[0].prerelease, true, '包含预览发布');
  assert.equal(result[0].tag, 'v2.1.0', '保留原始标签供国内附件定位');
  assert.equal(result[0].apk.sha256, 'a'.repeat(64));
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(fetchApplicationReleases(), /HTTP 403/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ unexpected: true }) });
  await assert.rejects(fetchApplicationReleases(), /格式/);
  for (const changed of [{ digest: null }, { browser_download_url: 'https://untrusted.example/app.apk' }]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ ...rawRelease, assets: [{ ...asset, ...changed }] }] });
    await assert.rejects(fetchApplicationReleases(), /SHA-256/);
  }
} finally { globalThis.fetch = originalFetch; }

let verifyFailure = false;
let downloadStatus = 200;
const deleted = [];
const requestedDownloads = [];
const prepared = [];
const { downloadApplicationUpdate } = load('src/platform/updates/DownloadApplicationUpdate.ts', {
  'expo-file-system/legacy': {
    cacheDirectory: 'file:///cache/', makeDirectoryAsync: async () => {},
    deleteAsync: async (uri) => { deleted.push(uri); },
    createDownloadResumable: (url, uri, _options, progress) => {
      requestedDownloads.push({ url, uri });
      return { downloadAsync: async () => {
        progress({ totalBytesWritten: 1, totalBytesExpectedToWrite: -1 });
        progress({ totalBytesWritten: 2, totalBytesExpectedToWrite: 4 });
        return { status: downloadStatus, uri };
      } };
    },
  },
  '../../../modules/app-updates': { prepareDownloadedUpdate: async (...args) => {
    prepared.push(args);
    if (verifyFailure) throw new Error('错误的安装包');
    return 'file:///cache/app-updates/RavenCat-update.apk';
  } },
});
const apkUri = 'file:///cache/app-updates/RavenCat-update.apk';
const zipUri = 'file:///cache/app-updates/RavenCat-update.zip';
assert.equal(await downloadApplicationUpdate(makeRelease('2.1.0'), 'github', () => {}), apkUri);
assert.equal(requestedDownloads.at(-1).url, makeRelease('2.1.0').apk.url);
assert.deepEqual(prepared.at(-1), [apkUri, 'a'.repeat(64), 3, '2.1.0', false]);
const progressEvents = [];
assert.equal(await downloadApplicationUpdate(makeRelease('2.1.0'), 'gitee', (value) => progressEvents.push(value)), apkUri,
  '国内 ZIP 解压校验后交付 APK，不把压缩包传给安装器');
assert.equal(requestedDownloads.at(-1).url, 'https://gitee.com/skylucky163/ravencat/releases/download/v2.1.0/RavenCat-2.1.0-download.zip');
assert.deepEqual(prepared.at(-1), [zipUri, 'a'.repeat(64), 3, '2.1.0', true], '国内 APK 使用 GitHub 相同的校验依据');
assert.deepEqual(progressEvents, [0.5], '进度使用网络返回的 ZIP 大小，未知长度不产生无效进度');
assert.equal(deleted.at(-1), zipUri, '成功后删除 ZIP，保留已验证 APK');
verifyFailure = true;
for (const source of ['github', 'gitee']) {
  await assert.rejects(downloadApplicationUpdate(makeRelease('2.1.0'), source, () => {}), /错误的安装包/);
  assert.deepEqual(deleted.slice(-2), [apkUri, zipUri], '解压或校验失败时清除不可安装的缓存文件');
}
verifyFailure = false;
downloadStatus = 404;
const preparationsBefore404 = prepared.length;
const downloadsBefore404 = requestedDownloads.length;
await assert.rejects(downloadApplicationUpdate(makeRelease('2.1.0'), 'gitee', () => {}), /尚未同步/);
assert.equal(prepared.length, preparationsBefore404, '缺失的国内附件不进入安装准备');
assert.equal(requestedDownloads.length, downloadsBefore404 + 1, '国内下载失败不静默切换来源');

const dialogs = [];
let networkCalls = 0;
let nativeInstallerCalls = 0;
let skippedVersionReads = 0;
let selectedDownloadSource;
skipped = null;
releases = [makeRelease('2.1.0')];
const provider = load('src/host/shell/ApplicationUpdateProvider.tsx', {
  '@react-native-async-storage/async-storage': {
    getItem: async () => { skippedVersionReads++; return skipped; }, setItem: async (_key, value) => { skipped = value; },
  },
  '@platform/device/DeviceStatus': { getInstalledApplicationInfo: () => ({ version: '2.0.0' }) },
  '@platform/updates/GitHubReleases': { fetchApplicationReleases: async () => { networkCalls++; return releases; } },
  '@platform/updates/DownloadApplicationUpdate': {
    downloadApplicationUpdate: async (_release, source, progress) => {
      selectedDownloadSource = source;
      progress(0.5);
      return 'file:///cache/app-updates/RavenCat-update.apk';
    },
    openApplicationUpdateInstaller: async () => { nativeInstallerCalls++; return 'permission_required'; },
  },
  '@shared/ui': { showAppDialog: (dialog) => { dialogs.push(dialog); } },
  '../application/ApplicationUpdates': { createApplicationUpdates },
});
let viewModel;
function Consumer() { viewModel = provider.useApplicationUpdates(); return null; }
const tree = (enabled) => React.createElement(provider.ApplicationUpdateProvider, { enabled }, React.createElement(Consumer));
let mounted;
await renderer.act(async () => { mounted = renderer.create(tree(false)); });
assert.equal(networkCalls, 0, '尚未进入前台不检查');
await renderer.act(async () => { mounted.update(tree(true)); });
assert.equal(dialogs.length, 1);
assert.match(dialogs[0].title, /预览/);
await renderer.act(async () => { dialogs[0].buttons.find((button) => button.text === '跳过此版本').onPress(); });
assert.equal(viewModel.available.version, '2.1.0');
await renderer.act(async () => { mounted.unmount(); });
dialogs.length = 0;
await renderer.act(async () => { mounted = renderer.create(tree(true)); });
assert.equal(dialogs.length, 0, '跳过版本重启不弹窗');
await renderer.act(async () => { viewModel.checkManually(); });
assert.equal(dialogs.length, 1, '手动检查能找到被跳过的更新');
assert.ok(dialogs.at(-1).buttons.some((button) => button.text === 'GitHub 下载'));
await renderer.act(async () => { dialogs.at(-1).buttons.find((button) => button.text === 'Gitee 国内下载').onPress(); });
assert.equal(selectedDownloadSource, 'gitee', '用户选择国内下载后沿用统一安装流程');
assert.equal(viewModel.download.uri, 'file:///cache/app-updates/RavenCat-update.apk');
assert.equal(dialogs.at(-1).title, '更新已下载');
await renderer.act(async () => { dialogs.at(-1).buttons.find((button) => button.text === '安装更新').onPress(); });
assert.equal(nativeInstallerCalls, 1);
assert.equal(dialogs.at(-1).title, '允许安装更新');
const priorCalls = networkCalls;
await renderer.act(async () => { viewModel.checkManually(); });
assert.equal(networkCalls, priorCalls, '授权后继续安装不重新下载或查询');
assert.equal(dialogs.at(-1).title, '更新已下载');
await renderer.act(async () => { mounted.unmount(); });

dialogs.length = 0;
await renderer.act(async () => { mounted = renderer.create(tree(true)); });
await renderer.act(async () => { viewModel.checkManually(); });
await renderer.act(async () => { dialogs.at(-1).buttons.find((button) => button.text === 'GitHub 下载').onPress(); });
assert.equal(selectedDownloadSource, 'github', '原 GitHub 下载入口仍可选择');
assert.equal(dialogs.at(-1).title, '更新已下载');
await renderer.act(async () => { mounted.unmount(); });

globalThis.__DEV__ = true;
dialogs.length = 0;
const callsBeforeDevelopment = { network: networkCalls, storage: skippedVersionReads, installer: nativeInstallerCalls };
await renderer.act(async () => { mounted = renderer.create(tree(false)); });
await renderer.act(async () => { mounted.update(tree(true)); });
assert.equal(dialogs.length, 0, '开发版进入前台不弹公开更新提示');
assert.equal(viewModel.available, null, '开发版没有公开更新红点');
assert.equal(viewModel.download, null);
await renderer.act(async () => { viewModel.checkManually(); });
assert.equal(dialogs.length, 1);
assert.equal(dialogs[0].title, '开发版更新');
assert.match(dialogs[0].message, /重新安装开发包/);
assert.deepEqual({ network: networkCalls, storage: skippedVersionReads, installer: nativeInstallerCalls }, callsBeforeDevelopment,
  '开发版自动与手动入口均不查询发布、不读取跳过记录、不启动安装器');
await renderer.act(async () => { mounted.unmount(); });
globalThis.__DEV__ = false;

let checkButtonPresses = 0;
const { ProfileContent } = load('src/features/profile/presentation/ProfileContent.tsx', {
  'react-native': { Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View' },
  'lucide-react-native': { ArchiveRestore: 'Icon', RefreshCw: 'Icon', Star: 'Icon', Trash2: 'Icon', UserRound: 'Icon' },
  '@shared/ui': { UserAvatar: 'Avatar' },
  '@shared/theme': { ThemedSurface: 'Surface', useTheme: () => ({ colors: { feedback: { error: '#f00' }, text: { primary: '#333' } } }) },
  '@platform/device/DeviceStatus': { getInstalledApplicationInfo: () => ({ name: 'RavenCat', version: '2.0.0', buildNumber: '123' }) },
  '../../../../package.json': { version: '2.1.2' },
  './ProfileTab.styles': { createProfileStyles: () => ({}) },
});
const profileProps = { profile: { name: '测试用户' }, hasLoadedProfile: false,
  onOpenProfile() {}, onOpenFavorites() {}, onBackupPress() {}, onClearAllData() {}, onCheckUpdates() { checkButtonPresses++; },
  checkingUpdates: false, availableUpdateVersion: '2.1.0', updateProgress: null, updateDownloaded: false };
await renderer.act(async () => { mounted = renderer.create(React.createElement(ProfileContent, profileProps)); });
const updateMenuItem = () => mounted.root.findAllByType('TouchableOpacity')
  .find((item) => item.props.accessibilityLabel.split('，')[0] === '检查更新');
assert.match(updateMenuItem().props.accessibilityLabel, /有新版本/);
await renderer.act(async () => { updateMenuItem().props.onPress(); });
assert.equal(checkButtonPresses, 1);
await renderer.act(async () => { mounted.update(React.createElement(ProfileContent, { ...profileProps, checkingUpdates: true, updateProgress: 0.5 })); });
assert.equal(updateMenuItem().props.disabled, true);
assert.match(updateMenuItem().props.accessibilityLabel, /下载 50%/);
globalThis.__DEV__ = true;
await renderer.act(async () => { mounted.update(React.createElement(ProfileContent, {
  ...profileProps, availableUpdateVersion: null,
})); });
assert.match(updateMenuItem().props.accessibilityLabel, /开发版/);
assert.doesNotMatch(updateMenuItem().props.accessibilityLabel, /有新版本/);
assert.equal(updateMenuItem().props.disabled, false, '开发版入口仍可查看更新方式');
await renderer.act(async () => { mounted.unmount(); });
globalThis.__DEV__ = false;

let notificationAccess = false;
let installAccess = false;
let openedNotificationSettings = 0;
let openedInstallSettings = 0;
let onForeground;
const nativeComponents = Object.fromEntries(['ActivityIndicator', 'ScrollView', 'Text', 'TouchableOpacity', 'View', 'RefreshControl'].map((name) => [name, name]));
const { default: PermissionScreen } = load('src/features/companion/presentation/CompanionSystemAccessScreen.tsx', {
  './CompanionDiagnosticsSheet': { CompanionDiagnosticsSheet: () => null },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shared/theme': { ThemedSurface: 'Surface', useTheme: () => ({ colors: { brand: { primary: '#333' }, text: { tertiary: '#999' } } }), useThemedStyles: () => ({}) },
  '@shared/ui/NavigationHeader': () => null,
  '@shared/ui': { ToggleField: 'ToggleField' },
  'react-native': { ...nativeComponents, Platform: { Version: 33 }, Linking: { openSettings: async () => {} },
    AppState: { addEventListener: (_event, listener) => { onForeground = listener; return { remove() {} }; } } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '../application': { getCompanionNotificationDiagnostics: async () => ({ postNotificationsGranted: true, notificationsEnabled: true, channelImportance: 3 }), requestCompanionNotificationPermission: async () => {} },
  '@features/calls': { getIncomingCallDiagnostics: async () => ({ fullScreenIntentAllowed: true, incomingCallChannelImportance: 3 }),
    openFullScreenIntentSettings: async () => {}, openIncomingCallNotificationSettings: async () => {} },
  '@features/floatingLayer': { getBatteryOptimizationState: async () => ({ ignoringBatteryOptimizations: false }),
    isOverlayPermissionGranted: async () => false, openBatteryOptimizationSettings: async () => {},
    openOverlayPermissionSettings: async () => {}, requestIgnoreBatteryOptimizations: async () => {} },
  '@features/deviceControl': { getDeviceObserverConnectionState: async () => ({ accessibilityEnabled: false }), openDeviceObserverSettings: async () => {},
    getNotificationListenerAccessState: async () => ({ status: notificationAccess ? 'granted' : 'not_granted' }),
    openNotificationListenerSettings: async () => { openedNotificationSettings++; return { status: 'settings_open_dispatched', reason: null }; } },
  './CompanionSettingsShared.styles': { createStyles: () => ({}) },
  '@platform/device': { isUsageAccessGranted: async () => false, openUsageAccessSettings: async () => {},
    getBackgroundRuntimeState: async () => ({ enabled: false, running: false }),
    isSystemCalendarPermissionGranted: async () => false,
    getDeviceLocationAccessState: async () => ({ permission: 'not_granted', servicesEnabled: true }),
    manageDeviceLocationPermission: async () => {}, openDeviceLocationSettings: async () => {} },
  '@platform/updates/DownloadApplicationUpdate': { isApplicationUpdateInstallAllowed: () => installAccess,
    openApplicationUpdateInstallSettings: async () => { openedInstallSettings++; } },
});
await renderer.act(async () => { mounted = renderer.create(React.createElement(PermissionScreen, { onBack() {} })); });
const row = (label) => mounted.root.findAllByType('TouchableOpacity').find((item) => item.findAllByType('Text').some((text) => text.children.join('') === label));
const status = (label) => row(label).findAllByType('Text').at(-1).children.join('');
assert.equal(status('通知提醒'), '已开启');
assert.equal(status('通知使用权'), '去开启', '读取通知授权与发送通知授权分别展示');
assert.equal(status('安装未知应用'), '去开启');
await renderer.act(async () => { row('通知使用权').props.onPress(); row('安装未知应用').props.onPress(); });
assert.equal(openedNotificationSettings, 1);
assert.equal(openedInstallSettings, 1);
notificationAccess = true;
installAccess = true;
await renderer.act(async () => { onForeground('active'); });
assert.equal(status('通知使用权'), '已开启');
assert.equal(status('安装未知应用'), '已开启', '系统授权后返回应用刷新实际状态');
await renderer.act(async () => { mounted.unmount(); });

console.log('应用更新验证通过：版本排序、预览筛选、跳过与重启、GitHub/Gitee 来源选择、ZIP 交付与失败清理、前台提醒、安装授权和权限页返回刷新。');
