/** PHONE-8D1：generic Android MediaSession observation foundation 聚焦验证。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEVICE_CONTROL_AGENT_TOOLS } from '../helpers/device-control-tools.mjs';


const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const walk = (relativeDirectory) => {
  const directory = path.join(repoRoot, relativeDirectory);
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
};

const manifest = read('modules/device-control/android/src/main/AndroidManifest.xml');
assert.match(manifest, /RavenCatMediaNotificationListenerService/u);
assert.match(
  manifest,
  /<service\s+[\s\S]*?android:name="expo\.modules\.devicecontrol\.service\.RavenCatMediaNotificationListenerService"[\s\S]*?android:exported="false"[\s\S]*?android:permission="android\.permission\.BIND_NOTIFICATION_LISTENER_SERVICE"[\s\S]*?<action android:name="android\.service\.notification\.NotificationListenerService"\s*\/>[\s\S]*?<\/service>/u,
  'NotificationListenerService 必须 exported=false，并保留 binding permission 与正确 action',
);
assert.match(manifest, /android\.permission\.BIND_NOTIFICATION_LISTENER_SERVICE/u);
assert.match(manifest, /android\.service\.notification\.NotificationListenerService/u);
assert.doesNotMatch(manifest, /MEDIA_CONTENT_CONTROL|QUERY_ALL_PACKAGES/u);

const service = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/service/RavenCatMediaNotificationListenerService.kt',
);
assert.match(service, /class RavenCatMediaNotificationListenerService\s*:\s*NotificationListenerService\(\)/u);
assert.doesNotMatch(service, /onNotificationPosted|onNotificationRemoved|StatusBarNotification/u);

const bridge = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/bridge/DeviceControlModule.kt',
);
const reader = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/MediaSessionSnapshotReader.kt',
);
const nativeModel = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/model/MediaSessionObservation.kt',
);
const access = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/NotificationListenerAccessReader.kt',
);
assert.match(access, /readSystemAccess\(\)/u, '授权状态必须来自每次系统读取');
assert.match(bridge, /isNotificationListenerAccessGranted/u);
assert.match(bridge, /ACTION_NOTIFICATION_LISTENER_SETTINGS/u);
assert.match(bridge, /settings_open_dispatched/u);
assert.match(reader, /getActiveSessions|loadControllers/u);
// exact-package selection 已抽成 observation 与 command 共用的 resolver（PHONE-8D2）。
const resolver = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/ExactPackageMediaSessionResolver.kt',
);
assert.match(
  resolver,
  /it\.packageName == packageName/u,
  'session selection 必须是 exact equality',
);
assert.doesNotMatch(resolver, /contains\(packageName\)|startsWith\(packageName\)/u);
assert.match(
  reader,
  /ExactPackageMediaSessionResolver\(\)\.resolve\(/u,
  'observation 必须复用共用 resolver，不得自带一套 selection',
);
assert.doesNotMatch(reader, /firstOrNull \{ it\.packageName/u);

for (const state of [
  'none', 'stopped', 'paused', 'playing', 'fast_forwarding', 'rewinding',
  'buffering', 'error', 'connecting', 'skipping_to_previous',
  'skipping_to_next', 'skipping_to_queue_item', 'unknown',
]) {
  assert.match(reader, new RegExp(`"${state}"`, 'u'), `缺少 playback state ${state}`);
}
for (const key of [
  'METADATA_KEY_MEDIA_ID', 'METADATA_KEY_TITLE', 'METADATA_KEY_ARTIST',
  'METADATA_KEY_ALBUM', 'METADATA_KEY_DURATION',
]) {
  assert.match(reader, new RegExp(key, 'u'), `缺少 standard metadata ${key}`);
}
for (const action of [
  'ACTION_PLAY', 'ACTION_PAUSE', 'ACTION_PLAY_PAUSE', 'ACTION_STOP',
  'ACTION_SKIP_TO_NEXT', 'ACTION_SKIP_TO_PREVIOUS', 'ACTION_SEEK_TO',
  'ACTION_PLAY_FROM_MEDIA_ID', 'ACTION_PLAY_FROM_SEARCH', 'ACTION_PLAY_FROM_URI',
  'ACTION_PREPARE', 'ACTION_PREPARE_FROM_MEDIA_ID',
  'ACTION_PREPARE_FROM_SEARCH', 'ACTION_PREPARE_FROM_URI',
]) {
  assert.match(reader, new RegExp(action, 'u'), `缺少 action bit ${action}`);
}
const tsBridge = read('modules/device-control/src/DeviceControlModule.ts');
const observationPort = read(
  'src/features/deviceControl/application/MediaSessionObservationPort.ts',
);
for (const field of [
  'playFromMediaId', 'playFromSearch', 'playFromUri', 'prepare',
  'prepareFromMediaId', 'prepareFromSearch', 'prepareFromUri',
]) {
  assert.match(nativeModel, new RegExp(`val ${field}: Boolean`, 'u'));
  assert.match(nativeModel, new RegExp(`"${field}" to ${field}`, 'u'));
  assert.match(tsBridge, new RegExp(`${field}: boolean`, 'u'));
  assert.match(observationPort, new RegExp(`${field}: boolean`, 'u'));
}

const productionNativeFiles = walk('modules/device-control/android/src/main/java');
const productionNative = productionNativeFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
// PHONE-8D1 的禁令：observation 路径不得执行任何控制动作。
// 8D2 起 transport command 属于独立 controller 文件，这里的检查只覆盖观察路径。
const observationNative = [
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/MediaSessionSnapshotReader.kt',
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/ExactPackageMediaSessionResolver.kt',
].map((file) => read(file)).join('\n');
for (const forbidden of [
  /transportControls\s*\./u,
  /sendMediaButton/u,
  /dispatchMediaKeyEvent/u,
  /KEYCODE_MEDIA_/u,
]) {
  assert.doesNotMatch(observationNative, forbidden, `PHONE-8D1 禁止观察路径执行控制动作：${forbidden}`);
}
// 8D2 起允许 exact-package TransportControls 直调，但 global media key 仍然全局禁止。
for (const forbidden of [/sendMediaButton/u, /dispatchMediaKeyEvent/u, /KEYCODE_MEDIA_/u]) {
  assert.doesNotMatch(productionNative, forbidden, `禁止 global media key fallback：${forbidden}`);
}

const phoneToolsSource = walk('src/features/phoneTools')
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
assert.doesNotMatch(
  phoneToolsSource,
  /MediaSessionManager|MediaController|NotificationListenerService/u,
  'Phone Tools 不得拥有 Android MediaSession 细节',
);

assert.deepEqual(
  fs.readdirSync(path.join(repoRoot, 'src/features/deviceControl/aiTools')).sort(),
  DEVICE_CONTROL_AGENT_TOOLS,
  'PHONE-8D1 不得新增 Agent Tool',
);
const catalog = read('src/features/phoneTools/toolPackages/ToolPackageCatalog.ts');
for (const toolName of [
  'netease_search_songs', 'netease_search_public_playlists',
  'netease_get_public_playlist', 'netease_get_song_lyrics',
  'netease_resolve_share_link', 'netease_play_song',
  'netease_get_playback_state', 'netease_control_playback',
]) {
  assert.match(catalog, new RegExp(toolName, 'u'));
}
assert.doesNotMatch(catalog, /netease_(pause|next|previous|resume)|media_get_state/u);

const port = read('src/features/deviceControl/application/MediaSessionObservationPort.ts');
const adapter = read('src/features/deviceControl/infrastructure/MediaSessionObservationAdapter.ts');
const host = read('src/host/composition/configureDeviceControlRuntime.ts');
assert.match(port, /interface MediaSessionObservationPort/u);
assert.match(adapter, /mediaSessionObservationAdapter/u);
assert.match(host, /mediaSessionObservation:\s*mediaSessionObservationAdapter/u);
assert.doesNotMatch(port, /netease|cloudmusic/iu);
assert.doesNotMatch(adapter, /netease|cloudmusic/iu);

console.log('PHONE-8D1 MediaSession observation foundation 契约检查通过。');
