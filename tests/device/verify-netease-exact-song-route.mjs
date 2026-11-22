/**
 * PHONE-8C2：网易云 exact-song route composition 契约验证。
 *
 * 锁住的目标：
 * - songId → NetEase exact route → Host 注入的 Device Control application primitive →
 *   exact-package VIEW/BROWSABLE dispatch；
 * - Phone Tools 不得静态 import @features/deviceControl（否则与 Device Control → Phone Tools
 *   Protected Apps 依赖形成 feature cycle）；
 * - package / scheme / query 全部由 NetEase application 层冻结，caller 无法改写；
 * - songId 只接受正 JS safe integer，invalid 时绝不调用 Device Control；
 * - 成功只声称 play_request_dispatched，绝不声称 playing / playback_started / 播放成功；
 * - exact-song 仍通过 Host 注入的 Device Control runtime dependency 执行。
 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTypeScriptModule, readRepoFile as read } from '../helpers/load-typescript-module.mjs';
import { DEVICE_CONTROL_AGENT_TOOLS } from '../helpers/device-control-tools.mjs';


/** 去掉 KDoc / 行注释后再扫描禁止面：注释对边界的描述不应触发命中。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/\/\/[^\n]*/gu, '');

/** 复用真实 RuntimeSlot 语义，只替换 createRuntimeSlot 的实现宿主。 */
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

const routePath = 'src/features/phoneTools/application/NetEaseExactSongRoute.ts';
const runtimePath = 'src/features/phoneTools/application/NetEaseMusicRuntimeDependencies.ts';
const capabilityPath = 'src/features/phoneTools/application/PlayNetEaseSongById.ts';

const routeModule = loadTypeScriptModule(routePath);
const runtimeModule = loadTypeScriptModule(runtimePath, runtimeSlotMock);

const {
  NETEASE_MUSIC_PACKAGE,
  buildNetEaseExactSongUri,
  isValidNetEaseSongId,
} = routeModule;

let dispatchCallCount = 0;
const dispatchCalls = [];
/** type = 'success' 或 Device Control 的 failure reason。 */
let dispatchOutcome = { type: 'success' };

const fakeDispatcher = async (packageName, uri) => {
  dispatchCallCount += 1;
  dispatchCalls.push({ packageName, uri });
  if (dispatchOutcome.type === 'success') {
    return { status: 'uri_dispatched', targetPackage: packageName };
  }
  const error = new Error(`injected ${dispatchOutcome.type}`);
  error.reason = dispatchOutcome.type;
  throw error;
};

runtimeModule.configureNetEaseMusicRuntimeDependencies({
  dispatchBrowsableUriToPackage: fakeDispatcher,
});

const capabilityModule = loadTypeScriptModule(capabilityPath, {
  './NetEaseExactSongRoute': routeModule,
  './NetEaseMusicRuntimeDependencies': runtimeModule,
});

const {
  NetEasePlayRequestError,
  NetEaseRouteContractError,
  playNetEaseSongById,
} = capabilityModule;

function resetDispatch(outcome = { type: 'success' }) {
  dispatchCallCount = 0;
  dispatchCalls.length = 0;
  dispatchOutcome = outcome;
}

// ——— Case 1：冻结的 package / route contract ———
assert.equal(NETEASE_MUSIC_PACKAGE, 'com.netease.cloudmusic', 'package 必须冻结为网易云 production 包名');
assert.equal(
  buildNetEaseExactSongUri(2657785221),
  'orpheus://song/2657785221?thirdfrom=push',
  'exact-song route 必须是 PHONE-8A 冻结的最小 thirdfrom=push 形式',
);

// ——— Case 2：valid songId → 恰好一次 exact package + exact URI 派发 ———
resetDispatch();
const result = await playNetEaseSongById(2657785221);
assert.deepEqual(result, {
  status: 'play_request_dispatched',
  songId: 2657785221,
  targetPackage: 'com.netease.cloudmusic',
}, '成功语义必须是 play_request_dispatched，不得声称已播放');
assert.equal(dispatchCallCount, 1, '一次播放请求只能产生一次派发');
assert.deepEqual(dispatchCalls, [{
  packageName: 'com.netease.cloudmusic',
  uri: 'orpheus://song/2657785221?thirdfrom=push',
}], 'Device Control 必须收到 exact package 与 deterministic exact route');

// MAX_SAFE_INTEGER 边界仍然是合法 songId。
resetDispatch();
const maxSafeResult = await playNetEaseSongById(Number.MAX_SAFE_INTEGER);
assert.equal(maxSafeResult.songId, Number.MAX_SAFE_INTEGER);
assert.equal(
  dispatchCalls[0].uri,
  `orpheus://song/${Number.MAX_SAFE_INTEGER}?thirdfrom=push`,
);
assert.equal(dispatchCallCount, 1);

// ——— Case 3：invalid songId → invalid_song_id，且绝不调用 Device Control ———
const invalidSongIds = [
  0,
  -1,
  -2657785221,
  1.5,
  0.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MIN_SAFE_INTEGER,
  '2657785221',
  '',
  null,
  undefined,
  true,
  {},
  [],
];

for (const invalidSongId of invalidSongIds) {
  resetDispatch();
  await assert.rejects(
    () => playNetEaseSongById(invalidSongId),
    (error) => (
      error instanceof NetEasePlayRequestError
      && error.reason === 'invalid_song_id'
    ),
    `${String(invalidSongId)} 必须收敛为 invalid_song_id`,
  );
  assert.equal(dispatchCallCount, 0, `${String(invalidSongId)} 不得触发任何派发`);
}

// songId 校验本身也应该被直接覆盖。
for (const invalidSongId of invalidSongIds) {
  assert.equal(isValidNetEaseSongId(invalidSongId), false, `${String(invalidSongId)} 不是合法 songId`);
}
assert.equal(isValidNetEaseSongId(1), true);
assert.equal(isValidNetEaseSongId(Number.MAX_SAFE_INTEGER), true);

// ——— Case 4：Device Control 预期失败向上收敛，不 retry ———
for (const reason of ['protected_app', 'route_unavailable', 'route_dispatch_failed']) {
  resetDispatch({ type: reason });
  await assert.rejects(
    () => playNetEaseSongById(2657785221),
    (error) => (
      error instanceof NetEasePlayRequestError
      && error.reason === reason
      && !(error instanceof NetEaseRouteContractError)
    ),
    `${reason} 必须映射为网易云产品失败 ${reason}`,
  );
  assert.equal(dispatchCallCount, 1, `${reason} 不得 retry`);
}

// ——— Case 5：固定 package + deterministic route 不可能产生的失败保持 invariant ———
for (const reason of ['invalid_target_package', 'invalid_target_uri']) {
  resetDispatch({ type: reason });
  await assert.rejects(
    () => playNetEaseSongById(2657785221),
    (error) => (
      error instanceof NetEaseRouteContractError
      && error.reason === reason
      && !(error instanceof NetEasePlayRequestError)
    ),
    `${reason} 必须作为内部 route contract invariant 暴露，不得伪装成用户输入失败`,
  );
  assert.equal(dispatchCallCount, 1, `${reason} 不得 silent fallback 到第二次派发`);
}

// ——— Case 6：非 Device Control 契约错误原样上抛 ———
resetDispatch();
const unknownError = new Error('unexpected host failure');
runtimeModule.configureNetEaseMusicRuntimeDependencies({
  dispatchBrowsableUriToPackage: async () => {
    throw unknownError;
  },
});
await assert.rejects(
  () => playNetEaseSongById(2657785221),
  (error) => error === unknownError,
  '未知错误必须原样上抛，不得被吞掉或改写',
);
runtimeModule.configureNetEaseMusicRuntimeDependencies({
  dispatchBrowsableUriToPackage: fakeDispatcher,
});

// ——— Application 源码 guard ———
const routeSource = read(routePath);
const capabilitySource = read(capabilityPath);
const runtimeSource = read(runtimePath);
const neteaseSources = {
  routeSource: stripComments(routeSource),
  capabilitySource: stripComments(capabilitySource),
  runtimeSource: stripComments(runtimeSource),
};

for (const [name, source] of Object.entries(neteaseSources)) {
  assert.doesNotMatch(
    source,
    /@features\/deviceControl/u,
    `${name} 不得静态 import Device Control`,
  );
  assert.doesNotMatch(
    source,
    /modules\/device-control/u,
    `${name} 不得直接使用 Device Control native module`,
  );
  // 派发执行真值边界：不得声称播放成功。
  for (const forbiddenClaim of [
    'playing',
    'playback_started',
    'song_playing',
    'now_playing',
    '已播放',
    '播放成功',
    '正在播放',
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(forbiddenClaim, 'u'),
      `${name} 不得声称 ${forbiddenClaim}`,
    );
  }
  // 禁止范围：未冻结参数、EAPI、playback URL、MediaSession、Accessibility / OCR fallback。
  for (const forbiddenSurface of [
    'autoplay',
    'switch=',
    'replacePlayList',
    'waitColdStartPlayConnected',
    'MUSIC_U',
    'MediaSession',
    'NotificationListener',
    'Accessibility',
    'OCR',
    'outer/url',
    'music.163.com',
    'p2.music.126.net',
    'http://',
    'https://',
    'spm',
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(forbiddenSurface, 'iu'),
      `${name} 不得出现 ${forbiddenSurface}`,
    );
  }
}

// 成功 contract 必须存在且唯一。
assert.match(capabilitySource, /status: 'play_request_dispatched'/u, '必须表达 play_request_dispatched');
assert.match(capabilitySource, /'invalid_song_id'/u, '必须表达 invalid_song_id');
for (const reason of ['protected_app', 'route_unavailable', 'route_dispatch_failed']) {
  assert.match(capabilitySource, new RegExp(`'${reason}'`, 'u'), `必须向上表达 ${reason}`);
}
// 不 retry、不轮询、不 sleep。
assert.doesNotMatch(
  capabilitySource,
  /setTimeout|sleep|retry|while\s*\(/u,
  'NetEase capability 不得 retry / 轮询',
);
// caller 无法改写 package / scheme / query。
assert.match(
  capabilitySource,
  /buildNetEaseExactSongUri\(songId\)/u,
  'URI 必须由 NetEase route builder deterministic 构造',
);
assert.match(
  capabilitySource,
  /dispatchBrowsableUriToPackage\(NETEASE_MUSIC_PACKAGE, uri\)/u,
  'package 必须由 NetEase capability 固定传入',
);
// songId 校验必须在派发之前。
assert.ok(
  capabilitySource.indexOf('isValidNetEaseSongId(songId)')
    < capabilitySource.indexOf('dispatchBrowsableUriToPackage(NETEASE_MUSIC_PACKAGE'),
  'songId 校验必须在 Device Control 派发之前',
);
// route 构造只接受 songId，不接受 caller-supplied URI。
assert.match(
  routeSource,
  /orpheus:\/\/song\/\$\{songId\}\?\$\{NETEASE_EXACT_SONG_QUERY\}/u,
  'route 必须只由 songId 与冻结 query 组成',
);

// ——— Feature 边界 guard：Phone Tools 全量不得 import Device Control ———
const phoneToolsRoot = path.join(repoRoot, 'src/features/phoneTools');
const phoneToolsFiles = [];
(function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      phoneToolsFiles.push(fullPath);
    }
  }
}(phoneToolsRoot));

for (const file of phoneToolsFiles) {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  assert.doesNotMatch(
    source,
    /@features\/deviceControl/u,
    `${path.relative(repoRoot, file)} 不得 import Device Control（会形成 feature cycle）`,
  );
}

// ——— 阶段边界：还没有真实 capability consumer，不得提前暴露公共出口 ———
const phoneToolsIndexSource = read('src/features/phoneTools/index.ts');
assert.doesNotMatch(
  phoneToolsIndexSource,
  /playNetEaseSongById|NetEasePlayRequest|NetEaseExactSongRoute|NETEASE_MUSIC_PACKAGE/u,
  'PHONE-8C2 尚无真实 consumer，不得提前在 Phone Tools 公共出口暴露播放能力',
);
const phoneToolsCompositionSource = read('src/features/phoneTools/composition.ts');
assert.match(
  phoneToolsCompositionSource,
  /configureNetEaseMusicRuntimeDependencies/u,
  'Host 必须能通过 composition 出口注入网易云 runtime dependency',
);
assert.doesNotMatch(
  phoneToolsCompositionSource,
  /playNetEaseSongById|orpheus/u,
  'composition 出口只暴露注入契约，不得暴露网易云业务能力',
);

// ——— Host composition 是唯一 integration wiring ———
const hostCompositionPath = 'src/host/composition/configurePhoneToolsRuntime.ts';
const hostCompositionSource = read(hostCompositionPath);

assert.match(
  hostCompositionSource,
  /import \{[^}]*\bdispatchBrowsableUriToPackage\b[^}]*\} from '@features\/deviceControl';/u,
  'Host 必须从 Device Control 公共 feature API 引入 application primitive',
);
assert.match(
  hostCompositionSource,
  /configureNetEaseMusicRuntimeDependencies\(\{ dispatchBrowsableUriToPackage \}\)/u,
  'Host 必须把 dispatchBrowsableUriToPackage 注入网易云 runtime dependency',
);
assert.doesNotMatch(
  hostCompositionSource,
  /@features\/deviceControl\/composition|infrastructure|deviceControlAdapter|dispatchBrowsableUri\(/u,
  'Host 不得绕过 application primitive 直接使用 Device Control infrastructure',
);
// Host 只做 wiring（允许出现注入函数名），不得写网易云 route / 业务逻辑。
for (const forbiddenBusiness of [
  'orpheus',
  'songId',
  'thirdfrom',
  'cloudmusic',
  'playNetEaseSongById',
  'NETEASE_MUSIC_PACKAGE',
  'buildNetEaseExactSongUri',
]) {
  assert.doesNotMatch(
    hostCompositionSource,
    new RegExp(forbiddenBusiness, 'iu'),
    `Host composition 不得包含网易云业务逻辑：${forbiddenBusiness}`,
  );
}

const hostRoot = path.join(repoRoot, 'src/host');
const hostFiles = [];
(function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      hostFiles.push(fullPath);
    }
  }
}(hostRoot));

for (const file of hostFiles) {
  const relativePath = path.relative(repoRoot, file).replace(/\\/gu, '/');
  if (relativePath === hostCompositionPath) {
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(
    source,
    /configureNetEaseMusicRuntimeDependencies|playNetEaseSongById|NETEASE_MUSIC_PACKAGE|orpheus:\/\/song/u,
    `${relativePath} 不得接线网易云 playback route`,
  );
}

// ——— Device Control 仍不知道网易云 ———
const deviceControlRoot = path.join(repoRoot, 'src/features/deviceControl');
const deviceControlFiles = [];
(function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      deviceControlFiles.push(fullPath);
    }
  }
}(deviceControlRoot));

for (const file of deviceControlFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const forbiddenConstant of ['netease', 'cloudmusic', 'orpheus', 'thirdfrom']) {
    assert.doesNotMatch(
      source,
      new RegExp(forbiddenConstant, 'iu'),
      `${path.relative(repoRoot, file)} 不得出现 ${forbiddenConstant}`,
    );
  }
}

// Device Control 公共出口必须提供受 Protected Apps 保护的 application primitive。
const deviceControlIndexSource = read('src/features/deviceControl/index.ts');
assert.match(
  deviceControlIndexSource,
  /dispatchBrowsableUriToPackage,/u,
  'Device Control 公共出口必须暴露 dispatchBrowsableUriToPackage',
);
assert.match(
  deviceControlIndexSource,
  /\} from '\.\/application\/DispatchBrowsableUri';/u,
  '暴露的必须是 application primitive，不是 raw native bridge',
);

// ——— 责任边界：Device Control 不为 NetEase route 新增专属 Tool ———
assert.deepEqual(
  fs.readdirSync(path.join(repoRoot, 'src/features/deviceControl/aiTools')).sort(),
  DEVICE_CONTROL_AGENT_TOOLS,
  'PHONE-8C2 不得新增任何 Device Control Agent Tool',
);

console.log('PHONE-8C2 NetEase exact song route composition 契约检查通过。');
