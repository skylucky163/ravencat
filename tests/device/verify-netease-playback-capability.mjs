/** PHONE-8D3A：Phone Tools 网易云播放产品能力行为与边界验证。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';


const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/\/\/[^\n]*/gu, '');

const runtimeSlotMock = {
  '@shared/runtime/RuntimeSlot': {
    createRuntimeSlot: (name) => {
      let value = null;
      return {
        configure(nextValue) {
          value = nextValue;
        },
        get() {
          if (value === null) {
            throw new Error(`${name} 运行时依赖尚未完成装配`);
          }
          return value;
        },
      };
    },
  },
};

const routeModule = loadTypeScriptModule(
  'src/features/phoneTools/application/NetEaseExactSongRoute.ts',
);
const policyModule = loadTypeScriptModule(
  'src/features/phoneTools/application/ProtectedAppsPolicy.ts',
);
const runtimeModule = loadTypeScriptModule(
  'src/features/phoneTools/application/NetEasePlaybackRuntimeDependencies.ts',
  runtimeSlotMock,
);

let protectedPackages = [];
const admissionCalls = [];
const policyWithTrace = {
  ...policyModule,
  assertProtectedAppCapabilityAllowed(packageName, packages, capabilityKind) {
    admissionCalls.push({ packageName, packages: [...packages], capabilityKind });
    return policyModule.assertProtectedAppCapabilityAllowed(packageName, packages, capabilityKind);
  },
};

const snapshot = {
  packageName: routeModule.NETEASE_MUSIC_PACKAGE,
  audioOutput: { playbackType: 'local', deviceNames: ['有线耳机'] },
  playback: {
    state: 'playing',
    positionMs: 1234,
    speed: 1,
    updatedAtEpochMs: 1700000000000,
  },
  metadata: {
    mediaId: 'track-1',
    title: '彼此',
    artist: '灯诱LampLure',
    album: '彼此',
    durationMs: 234000,
  },
  actions: {
    play: true,
    pause: true,
    playPause: true,
    stop: true,
    next: true,
    previous: true,
    seekTo: true,
    playFromMediaId: false,
    playFromSearch: false,
    playFromUri: false,
    prepare: false,
    prepareFromMediaId: false,
    prepareFromSearch: false,
    prepareFromUri: false,
  },
};

let snapshotOutcome = { status: 'session_snapshot_available', snapshot };
let commandOutcome = null;
const snapshotCalls = [];
const commandCalls = [];

runtimeModule.configureNetEasePlaybackRuntimeDependencies({
  async getMediaSessionSnapshot(packageName) {
    snapshotCalls.push(packageName);
    return snapshotOutcome;
  },
  async dispatchMediaSessionCommand(packageName, command) {
    commandCalls.push({ packageName, command });
    return commandOutcome ?? { status: 'command_dispatched', packageName, command };
  },
});

const capabilityModule = loadTypeScriptModule(
  'src/features/phoneTools/application/NetEasePlayback.ts',
  {
    './CurrentProtectedAppsPolicy': {
      loadCurrentProtectedPackages: async () => protectedPackages,
    },
    './NetEaseExactSongRoute': routeModule,
    './NetEasePlaybackRuntimeDependencies': runtimeModule,
    './ProtectedAppsPolicy': policyWithTrace,
  },
);

const {
  controlNetEasePlayback,
  getNetEasePlaybackSnapshot,
  NetEasePlaybackContractError,
  NetEasePlaybackError,
} = capabilityModule;
const targetPackage = routeModule.NETEASE_MUSIC_PACKAGE;

function reset() {
  protectedPackages = [];
  admissionCalls.length = 0;
  snapshotCalls.length = 0;
  commandCalls.length = 0;
  snapshotOutcome = { status: 'session_snapshot_available', snapshot };
  commandOutcome = null;
}

// observation 成功：先以 observation 准入，再以固定 package 读取并原样保留稳定事实字段。
reset();
assert.deepEqual(await getNetEasePlaybackSnapshot(), {
  status: 'playback_snapshot_available',
  targetPackage,
  snapshot: {
    playback: snapshot.playback,
    metadata: snapshot.metadata,
    actions: snapshot.actions,
    audioOutput: snapshot.audioOutput,
  },
});
assert.deepEqual(admissionCalls, [{
  packageName: targetPackage,
  packages: [],
  capabilityKind: 'observation',
}]);
assert.deepEqual(snapshotCalls, [targetPackage]);

// observation protected：policy 在 primitive 前拒绝，native read 次数保持 0。
reset();
protectedPackages = [targetPackage];
await assert.rejects(
  () => getNetEasePlaybackSnapshot(),
  (error) => error instanceof NetEasePlaybackError && error.reason === 'protected_app',
);
assert.equal(snapshotCalls.length, 0);
assert.equal(admissionCalls[0].capabilityKind, 'observation');

for (const outcome of [
  { status: 'permission_not_granted', expectedReason: 'permission_not_granted' },
  { status: 'no_active_session', packageName: targetPackage, expectedReason: 'no_active_session' },
  { status: 'snapshot_failed', reason: 'reader exploded', expectedReason: 'snapshot_failed' },
]) {
  reset();
  const { expectedReason, ...result } = outcome;
  snapshotOutcome = result;
  await assert.rejects(
    () => getNetEasePlaybackSnapshot(),
    (error) => (
      error instanceof NetEasePlaybackError
      && error.reason === expectedReason
      && (expectedReason !== 'snapshot_failed' || error.message.includes('reader exploded'))
    ),
  );
  assert.equal(snapshotCalls.length, 1);
}

reset();
snapshotOutcome = { status: 'invalid_package_name', reason: 'invalid package' };
await assert.rejects(
  () => getNetEasePlaybackSnapshot(),
  (error) => (
    error instanceof NetEasePlaybackContractError
    && error.reason === 'invalid_package_name'
    && !(error instanceof NetEasePlaybackError)
  ),
);

// control：四个 command 均以 action 准入并不变地派发给固定 package。
for (const command of ['pause', 'resume', 'next', 'previous']) {
  reset();
  assert.deepEqual(await controlNetEasePlayback(command), {
    status: 'playback_command_dispatched',
    targetPackage,
    command,
  });
  assert.deepEqual(admissionCalls, [{
    packageName: targetPackage,
    packages: [],
    capabilityKind: 'action',
  }]);
  assert.deepEqual(commandCalls, [{ packageName: targetPackage, command }]);
  assert.equal(snapshotCalls.length, 0, 'command success 不得自动读取 snapshot 验证');
}

// control protected：policy 在 dispatch 前拒绝。
reset();
protectedPackages = [targetPackage];
await assert.rejects(
  () => controlNetEasePlayback('pause'),
  (error) => error instanceof NetEasePlaybackError && error.reason === 'protected_app',
);
assert.equal(commandCalls.length, 0);
assert.equal(admissionCalls[0].capabilityKind, 'action');

for (const outcome of [
  { status: 'permission_not_granted', expectedReason: 'permission_not_granted' },
  { status: 'no_active_session', packageName: targetPackage, expectedReason: 'no_active_session' },
  {
    status: 'action_not_supported',
    packageName: targetPackage,
    command: 'next',
    expectedReason: 'action_not_supported',
  },
  {
    status: 'dispatch_failed',
    packageName: targetPackage,
    command: 'next',
    reason: 'transport exploded',
    expectedReason: 'dispatch_failed',
  },
]) {
  reset();
  const { expectedReason, ...result } = outcome;
  commandOutcome = result;
  await assert.rejects(
    () => controlNetEasePlayback('next'),
    (error) => (
      error instanceof NetEasePlaybackError
      && error.reason === expectedReason
      && (expectedReason !== 'dispatch_failed' || error.message.includes('transport exploded'))
    ),
  );
  assert.equal(commandCalls.length, 1);
  assert.equal(snapshotCalls.length, 0);
}

for (const invariantReason of ['invalid_package_name', 'invalid_command']) {
  reset();
  commandOutcome = { status: invariantReason, reason: `injected ${invariantReason}` };
  await assert.rejects(
    () => controlNetEasePlayback('pause'),
    (error) => (
      error instanceof NetEasePlaybackContractError
      && error.reason === invariantReason
      && !(error instanceof NetEasePlaybackError)
    ),
  );
}

// 静态边界只锁长期架构契约；核心映射与调用顺序已由上面的行为测试覆盖。
const runtimeSource = stripComments(read(
  'src/features/phoneTools/application/NetEasePlaybackRuntimeDependencies.ts',
));
const capabilitySource = stripComments(read(
  'src/features/phoneTools/application/NetEasePlayback.ts',
));
const phoneToolsSource = fs.readdirSync(
  path.join(repoRoot, 'src/features/phoneTools'),
  { recursive: true, withFileTypes: true },
).filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
  .map((entry) => stripComments(fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')))
  .join('\n');

assert.match(
  runtimeSource,
  /NetEasePlaybackCommand = 'pause' \| 'resume' \| 'next' \| 'previous'/u,
  '产品 command union 必须恰好是四个 command',
);
assert.doesNotMatch(
  phoneToolsSource,
  /@features\/deviceControl|modules\/device-control|MediaSessionManager|MediaController|NotificationListenerService/u,
  'Phone Tools production source 不得静态依赖 Device Control 或 Android MediaSession 实现',
);
assert.doesNotMatch(
  capabilitySource,
  /setTimeout|setInterval|sleep|delay\(|while \(|AudioManager|KEYCODE_MEDIA_|dispatchBrowsableUri|playFrom|prepareFrom|seekTo/u,
  '产品 capability 不得 polling、fallback、后台点歌或 seek',
);

const hostSource = stripComments(read('src/host/composition/configurePhoneToolsRuntime.ts'));
assert.match(hostSource, /configureNetEasePlaybackRuntimeDependencies/u);
assert.match(hostSource, /getMediaSessionSnapshot/u);
assert.match(hostSource, /dispatchMediaSessionCommand/u);
assert.doesNotMatch(hostSource, /NETEASE_MUSIC_PACKAGE|protected_app|action_not_supported/u);

const catalogSource = stripComments(read(
  'src/features/phoneTools/toolPackages/ToolPackageCatalog.ts',
));
assert.deepEqual(
  [...catalogSource.matchAll(/toolName: '(netease_[a-z_]+)'/gu)].map((match) => match[1]),
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
  'NetEase package 必须暴露八个 child Tool',
);
const registrySource = stripComments(read(
  'src/host/composition/agent/createAgentToolRegistry.ts',
));
assert.doesNotMatch(
  `${catalogSource}\n${registrySource}`,
  /netease_(pause|resume|next|previous)|media_control/u,
  '播放控制不得拆成 transport Tool 或 generic media Tool',
);

assert.equal(
  routeModule.buildNetEaseExactSongUri(2657785221),
  'orpheus://song/2657785221?thirdfrom=push',
  'exact-song route 不得改变',
);
assert.equal(
  (phoneToolsSource.match(/com\.netease\.cloudmusic/gu) ?? []).length,
  1,
  '网易云 package 字面量必须只有 NetEaseExactSongRoute 一份真值',
);

// 当前歌词查询复用已完成边界归一化的歌词 backend，只返回本轮位置对应的一句。
const { getNetEaseCurrentLyric } = loadTypeScriptModule('src/features/phoneTools/application/NetEaseCurrentLyric.ts', {
  './NetEasePlaybackRuntimeDependencies': runtimeModule,
});
let lyricRequests = 0;
let lyricResult = { ok: true, data: { status: 'available', truncated: false,
  text: '[00:01.00][00:21.00]第一句\n[00:10.000]第二句\n[00:20.00]\n[00:30.0]第三句' } };
runtimeModule.configureNetEasePlaybackRuntimeDependencies({
  async getSongLyrics() { lyricRequests += 1; return lyricResult; },
});
const lyricPlayback = {
  mediaId: '100', playbackState: 'playing', positionMs: 3500, speed: 2,
  updatedAtEpochMs: 1000, durationMs: 60_000,
};
assert.deepEqual(await getNetEaseCurrentLyric(lyricPlayback, 5000), {
  text: '第二句', startTimeMs: 10_000, positionMs: 11_500,
}, '播放中按更新时间与速度定位，而不是直接使用旧 position');
assert.deepEqual(await getNetEaseCurrentLyric({ ...lyricPlayback, playbackState: 'paused' }, 100_000), {
  text: '第一句', startTimeMs: 1000, positionMs: 3500,
}, '暂停时不随墙上时间推进');
assert.equal(await getNetEaseCurrentLyric({ ...lyricPlayback, playbackState: 'paused', positionMs: 500 }, 5000), null,
  '首句之前不能提前传歌词');
assert.equal(await getNetEaseCurrentLyric({ ...lyricPlayback, playbackState: 'paused', positionMs: 20_500 }, 5000), null,
  '空白时间戳表示间奏，不能继续沿用上一句');
assert.equal((await getNetEaseCurrentLyric({ ...lyricPlayback, playbackState: 'paused', positionMs: 21_100 }, 5000)).text, '第一句',
  '重复时间戳必须定位到副歌重唱');
assert.equal(lyricRequests, 1, '同曲换位置只重算当前句，不重复请求整首');
for (const patch of [{ mediaId: null }, { mediaId: 'track-100' }, { positionMs: -1 }, { updatedAtEpochMs: null }, { speed: null }, { positionMs: 60_000 }]) {
  assert.equal(await getNetEaseCurrentLyric({ ...lyricPlayback, ...patch }, 5000), null);
}
assert.equal(lyricRequests, 1, '不可定位的外部身份或进度不触发歌词请求');
lyricResult = { ok: true, data: { status: 'available', truncated: false, text: '[00:00.00]下一首的句子' } };
assert.equal((await getNetEaseCurrentLyric({ ...lyricPlayback, mediaId: '101' }, 5000)).text, '下一首的句子');
assert.equal(lyricRequests, 2, '切歌必须换歌词数据，不能复用上一首');
lyricResult = { ok: false, error: { code: 'network_failure', message: '网络失败', apiCode: null } };
assert.equal(await getNetEaseCurrentLyric({ ...lyricPlayback, mediaId: '102' }, 5000), null);
assert.equal(lyricRequests, 3, '网络失败不在当前调用内自动 retry');
lyricResult = { ok: true, data: { status: 'available', truncated: false, text: '[00:00.00]网络恢复后的句子' } };
assert.equal((await getNetEaseCurrentLyric({ ...lyricPlayback, mediaId: '102' }, 5000)).text, '网络恢复后的句子');
for (const [id, data] of [
  ['103', { status: 'available', text: '只有全文，没有时间戳', truncated: false }],
  ['104', { status: 'no_lyrics' }],
  ['105', { status: 'available', text: '[00:00.00]完整句\n[00:10.00]截断的句', truncated: true }],
]) {
  lyricResult = { ok: true, data };
  assert.equal(await getNetEaseCurrentLyric({ ...lyricPlayback, mediaId: id, positionMs: 11_000, playbackState: 'paused' }, 5000), null);
}
lyricResult = { ok: true, data: { status: 'available', text: '[offset:500]\n[00:01.2]有偏移的句子', truncated: false } };
assert.deepEqual(await getNetEaseCurrentLyric({ ...lyricPlayback, mediaId: '106', positionMs: 750, playbackState: 'paused' }, 5000), {
  text: '有偏移的句子', startTimeMs: 700, positionMs: 750,
});
const requestsBeforeConcurrent = lyricRequests;
lyricResult = { ok: true, data: { status: 'available', text: '[00:00.00]同曲并发的当前句', truncated: false } };
const concurrentLines = await Promise.all([1000, 2000, 3000].map(positionMs =>
  getNetEaseCurrentLyric({ ...lyricPlayback, mediaId: '107', playbackState: 'paused', positionMs }, 5000)));
assert.equal(lyricRequests, requestsBeforeConcurrent + 1, '同曲并发只发出一个歌词请求');
assert.deepEqual(concurrentLines.map(line => line.positionMs), [1000, 2000, 3000], '共享歌词数据不能共享另一轮的当前位置');
console.log('PHONE-8D3A 网易云播放产品能力与当前一句歌词定位验证通过。');
