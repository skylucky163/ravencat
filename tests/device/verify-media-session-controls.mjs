/**
 * PHONE-8D2：generic exact-package MediaSession transport controls 聚焦验证。
 *
 * 这里只锁契约与边界；真实 command selection / admission / dispatch behavior
 * 由 modules/device-control 的 native unit tests 负责，不用字符串断言假装验证行为。
 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEVICE_CONTROL_AGENT_TOOLS } from '../helpers/device-control-tools.mjs';


/**
 * 读取用于结构断言的源码：默认剥离注释。
 * 注释里出现被禁标识符（例如说明“不执行 TransportControls”）不算违约。
 */
const read = (relativePath) => fs
  .readFileSync(path.join(repoRoot, relativePath), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/\/\/[^\n]*/gu, '');
const walk = (relativeDirectory) => {
  const directory = path.join(repoRoot, relativeDirectory);
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(repoRoot, path.join(entry.parentPath, entry.name)));
};

const CONTROL_FILES = [
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/MediaSessionTransportController.kt',
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/model/MediaSessionControl.kt',
  'src/features/deviceControl/application/MediaSessionControlPort.ts',
  'src/features/deviceControl/application/MediaSessionControl.ts',
  'src/features/deviceControl/infrastructure/MediaSessionControlAdapter.ts',
];
const controlSources = Object.fromEntries(
  CONTROL_FILES.map((file) => [file, read(file)]),
);
const controlNative = controlSources[CONTROL_FILES[0]] + controlSources[CONTROL_FILES[1]];

// 1. command union 只有四个 command，且不含 play
const commandEnum = controlSources[CONTROL_FILES[1]];
assert.match(commandEnum, /PAUSE\("pause"/u);
assert.match(commandEnum, /RESUME\("resume"/u);
assert.match(commandEnum, /NEXT\("next"/u);
assert.match(commandEnum, /PREVIOUS\("previous"/u);
assert.doesNotMatch(commandEnum, /\("play"/u, '不得暴露 play command');
assert.doesNotMatch(
  commandEnum,
  /\("playFromMediaId"|\("playFromSearch"|\("playFromUri"|\("prepare"|\("seek"|\("stop"/u,
  '第一版只支持 pause / resume / next / previous',
);

const tsBridge = read('modules/device-control/src/DeviceControlModule.ts');
const controlPort = controlSources[CONTROL_FILES[2]];
for (const source of [tsBridge, controlPort]) {
  assert.match(
    source,
    /MediaSessionTransportCommand = 'pause' \| 'resume' \| 'next' \| 'previous'/u,
    'TS command union 必须恰好是四个 command',
  );
}

// 2. action admission 按具体 command 的具体 action bit
assert.match(commandEnum, /PAUSE\("pause",\s*PlaybackState\.ACTION_PAUSE\)/u);
assert.match(commandEnum, /RESUME\("resume",\s*PlaybackState\.ACTION_PLAY\)/u);
assert.match(commandEnum, /NEXT\("next",\s*PlaybackState\.ACTION_SKIP_TO_NEXT\)/u);
assert.match(
  commandEnum,
  /PREVIOUS\("previous",\s*PlaybackState\.ACTION_SKIP_TO_PREVIOUS\)/u,
);
assert.match(
  controlNative,
  /source\.actions\(\) and command\.actionBit == 0L/u,
  'admission 必须检查 advertised action bit',
);
assert.doesNotMatch(commandEnum, /ACTION_PLAY_PAUSE/u, 'playPause 不得参与 admission 映射');

// 3. 不读取 playback state 参与 admission、不做业务拒绝
assert.doesNotMatch(
  controlNative,
  /state == |isPlaying|STATE_PLAYING/u,
  '当前 playback state 不参与 command admission',
);

// 4. 没有 global media key fallback
for (const [file, source] of Object.entries(controlSources)) {
  assert.doesNotMatch(
    source,
    /dispatchMediaKeyEvent|KEYCODE_MEDIA_|AudioManager|sendMediaButton/u,
    `${file} 不得退回 global media key`,
  );
}

// 5. 不做后台精确点歌 / prepare / seekTo
for (const [file, source] of Object.entries(controlSources)) {
  assert.doesNotMatch(
    source,
    /playFromMediaId|playFromSearch|playFromUri|prepareFrom|skipToQueueItem|seekTo/u,
    `${file} 不得实现后台精确点歌或 seekTo`,
  );
}

// 6. 没有 hidden verification：不 sleep / 不 poll / 不等待
for (const [file, source] of Object.entries(controlSources)) {
  assert.doesNotMatch(
    source,
    /Thread\.sleep|SystemClock\.sleep|\.wait\(|while \(|do \{|awaitUntil|delay\(/u,
    `${file} 不得做轮询或等待验证`,
  );
}
assert.doesNotMatch(controlNative, /snapshot\(\)/u, 'command 不得顺带读取 snapshot');

// 7. Native TransportControls 映射：resume → play()，其余直调
const androidSource = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/AndroidMediaSessionControllerSource.kt',
);
assert.match(androidSource, /PAUSE -> transportControls\.pause\(\)/u);
assert.match(androidSource, /RESUME -> transportControls\.play\(\)/u);
assert.match(androidSource, /NEXT -> transportControls\.skipToNext\(\)/u);
assert.match(androidSource, /PREVIOUS -> transportControls\.skipToPrevious\(\)/u);
assert.doesNotMatch(androidSource, /playFromMediaId|playFromSearch|playFromUri|prepare/u);

// 8. generic Device Control ownership：控制基础里不得出现 NetEase 标识
for (const [file, source] of Object.entries(controlSources)) {
  assert.doesNotMatch(source, /netease|cloudmusic|songId/iu, `${file} 不得出现 NetEase 标识`);
}
assert.doesNotMatch(androidSource, /netease|cloudmusic|songId/iu);

// 9. observation 与 command 共用 exact-package resolution
const resolver = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/ExactPackageMediaSessionResolver.kt',
);
const observation = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/MediaSessionSnapshotReader.kt',
);
const transportController = controlSources[CONTROL_FILES[0]];
assert.match(resolver, /it\.packageName == packageName/u, 'session selection 必须是 exact equality');
assert.match(resolver, /isValidExactPackageName/u);
for (const source of [observation, transportController]) {
  assert.match(
    source,
    /ExactPackageMediaSessionResolver\(\)\.resolve\(/u,
    'observation 与 command 必须共用同一个 resolver',
  );
  assert.doesNotMatch(source, /\.first\(\)|\.firstOrNull\(\)/u, '不得自行挑选 controller');
}
// 8D1 observation 仍然只观察，不控制
assert.doesNotMatch(observation, /transportControls|dispatch\(/u, 'observation 不得执行 command');

// 10. 共用同一份 controller discovery，不形成第二套 MediaSessionManager
const bridge = read(
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/bridge/DeviceControlModule.kt',
);
assert.match(bridge, /dispatchMediaSessionCommand/u);
assert.match(bridge, /mediaSessionControllerLoader\(context\)/u);
assert.equal(
  (bridge.match(/MediaSessionManager::class\.java/gu) ?? []).length,
  1,
  '不得建立第二套 MediaSessionManager',
);
assert.equal(
  (bridge.match(/isNotificationListenerAccessGranted/gu) ?? []).length,
  1,
  '不得建立第二套 permission reader',
);

// 11. port / adapter / Host composition 分层
const adapter = controlSources[CONTROL_FILES[4]];
const host = read('src/host/composition/configureDeviceControlRuntime.ts');
const runtimeDependencies = read(
  'src/features/deviceControl/application/DeviceControlRuntimeDependencies.ts',
);
assert.match(controlPort, /interface MediaSessionControlPort/u);
assert.match(
  controlPort,
  /dispatchMediaSessionCommand\([\s\S]{0,120}packageName: string,[\s\S]{0,120}command: MediaSessionTransportCommand,/u,
);
assert.match(adapter, /mediaSessionControlAdapter/u);
assert.match(runtimeDependencies, /mediaSessionControl: MediaSessionControlPort/u);
assert.match(host, /mediaSessionControl:\s*mediaSessionControlAdapter/u);
// observation 与 control 是两个 port，不合并
assert.doesNotMatch(controlPort, /getMediaSessionSnapshot/u, 'read 与 write 不得混在一个 port');
// Phone Tools 不得直接 import native bridge 或 Device Control infrastructure
const phoneToolsSource = walk('src/features/phoneTools')
  .map((file) => read(file))
  .join('\n');
assert.doesNotMatch(
  phoneToolsSource,
  /MediaSessionManager|MediaController|NotificationListenerService|MediaSessionControlAdapter/u,
  'Phone Tools 不得拥有 Android MediaSession 细节或直接使用 Device Control infrastructure',
);
const neteaseComposition = read('src/features/phoneTools/neteaseComposition.ts');
assert.doesNotMatch(neteaseComposition, /MediaSession/i, 'NetEase composition 不得引入 MediaSession');

// 12. 没有 Agent Tool exposure
assert.deepEqual(
  fs.readdirSync(path.join(repoRoot, 'src/features/deviceControl/aiTools')).sort(),
  DEVICE_CONTROL_AGENT_TOOLS,
  'PHONE-8D2 不得新增 Agent Tool',
);
const catalog = read('src/features/phoneTools/toolPackages/ToolPackageCatalog.ts');
assert.deepEqual(
  [...catalog.matchAll(/toolName: '(netease_[a-z_]+)'/gu)].map((match) => match[1]),
  [
    'netease_search_songs',
    'netease_search_public_playlists',
    'netease_get_public_playlist',
    'netease_get_song_lyrics',
    'netease_resolve_share_link',
    'netease_play_song',
    'netease_get_playback_state',
    'netease_control_playback',
  ],
  'NetEase 八个 child Tool 必须保持完整',
);
assert.doesNotMatch(
  catalog,
  /netease_(pause|next|previous|resume)|media_(pause|resume|next|previous)/u,
  '不得新增 media / netease transport Tool',
);
const toolRegistry = read('src/host/composition/agent/createAgentToolRegistry.ts');
for (const toolName of [
  'media_pause', 'media_resume', 'media_next', 'media_previous',
  'netease_pause', 'netease_resume', 'netease_next', 'netease_previous',
]) {
  assert.doesNotMatch(toolRegistry, new RegExp(toolName, 'u'));
}

// 13. 8D1 observation foundation 仍然保留
assert.match(observation, /class MediaSessionSnapshotReader/u);
assert.match(observation, /loadControllers/u);
assert.match(observation, /isValidExactPackageName/u);
const observationPort = read(
  'src/features/deviceControl/application/MediaSessionObservationPort.ts',
);
assert.match(observationPort, /interface MediaSessionObservationPort/u);
assert.match(observationPort, /getMediaSessionSnapshot/u);

// 14. command 没有塞进 Soft Lock / runtime / Service 生命周期
for (const file of [
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/controller/SoftLockController.kt',
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/runtime/DeviceControlRuntimeHost.kt',
  'modules/device-control/android/src/main/java/expo/modules/devicecontrol/service/DeviceControlService.kt',
]) {
  assert.doesNotMatch(read(file), /MediaSession|transportControls/u, `${file} 不得接管 media command`);
}

console.log('PHONE-8D2 MediaSession transport controls 契约检查通过。');
