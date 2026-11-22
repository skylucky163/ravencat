import { agentToolSchemaDependencies } from '../helpers/agent-tool-schema-dependencies.mjs';
/** PHONE-8B2B1/PHONE-8D3B：网易云八个 concrete child Tool 的 contract 与执行边界。 */

import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const abortRuntime = loadTypeScriptModule('src/shared/runtime/abortSignal.ts');
let currentHostAiId = 'host-ai';
const executionSupport = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseToolExecution.ts',
  {
    '@features/assistants': {
      runAsCurrentHostAuthority: async (actorAiId, capability) => (
        actorAiId === currentHostAiId
          ? { status: 'authorized', value: await capability() }
          : { status: 'not_current_host' }
      ),
    },
    '@shared/runtime/abortSignal': abortRuntime,
  },
);

const bypassAuthority = {
  ...executionSupport,
  runNetEaseToolAsCurrentHost: async (_context, capability) => capability(),
};
const toolMocks = { './NetEaseToolExecution': bypassAuthority };

const songSearchModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseSearchSongsTool.ts',
  toolMocks,
);
const playlistSearchModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseSearchPublicPlaylistsTool.ts',
  toolMocks,
);
const playlistModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseGetPublicPlaylistTool.ts',
  toolMocks,
);
const lyricsModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseGetSongLyricsTool.ts',
  toolMocks,
);
const shareModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseResolveShareLinkTool.ts',
  toolMocks,
);

class NetEasePlayRequestError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
    this.name = 'NetEasePlayRequestError';
  }
}
class NetEaseRouteContractError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
    this.name = 'NetEaseRouteContractError';
  }
}
const playModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEasePlaySongTool.ts',
  {
    ...toolMocks,
    '../application/PlayNetEaseSongById': {
      NetEasePlayRequestError,
      NetEaseRouteContractError,
      playNetEaseSongById: async () => {
        throw new Error('测试必须显式注入 play capability');
      },
    },
  },
);
class NetEasePlaybackError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
    this.name = 'NetEasePlaybackError';
  }
}
const playbackMocks = {
  ...toolMocks,
  '../application/NetEasePlayback': {
    NetEasePlaybackError,
    getNetEasePlaybackSnapshot: async () => undefined,
    controlNetEasePlayback: async () => undefined,
  },
};
const playbackStateModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseGetPlaybackStateTool.ts',
  playbackMocks,
);
const playbackControlModule = loadTypeScriptModule(
  'src/features/phoneTools/aiTools/NetEaseControlPlaybackTool.ts',
  playbackMocks,
);
const { convertLegacyToolResult } = loadTypeScriptModule(
  'src/host/composition/agent/LegacyAgentToolAdapter.ts',
);
const modelContentOf = (result) => convertLegacyToolResult(result).modelContent;
const structuredProjectionOf = (result) => {
  const modelContent = modelContentOf(result);
  const prefix = '\n结构化结果：';
  const prefixIndex = modelContent.indexOf(prefix);
  assert.notEqual(prefixIndex, -1, 'NetEase success observation 必须包含结构化结果');
  return JSON.parse(modelContent.slice(prefixIndex + prefix.length));
};

const definitions = [
  songSearchModule.netEaseSearchSongsDefinition,
  playlistSearchModule.netEaseSearchPublicPlaylistsDefinition,
  playlistModule.netEaseGetPublicPlaylistDefinition,
  lyricsModule.netEaseGetSongLyricsDefinition,
  shareModule.netEaseResolveShareLinkDefinition,
  playModule.netEasePlaySongDefinition,
  playbackStateModule.netEaseGetPlaybackStateDefinition,
  playbackControlModule.netEaseControlPlaybackDefinition,
];
assert.deepEqual(definitions.map(({ name }) => name).sort(), [
  'netease_control_playback',
  'netease_get_playback_state',
  'netease_get_public_playlist',
  'netease_get_song_lyrics',
  'netease_play_song',
  'netease_resolve_share_link',
  'netease_search_public_playlists',
  'netease_search_songs',
], '必须恰好定义八个 NetEase child Tool');

const { matchesAgentToolInputSchema } = loadTypeScriptModule(
  'src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);
for (const definition of definitions) {
  assert.equal(definition.parameters.additionalProperties, false, `${definition.name} 必须拒绝额外参数`);
}

const songSearchSchema = songSearchModule.netEaseSearchSongsDefinition.parameters;
assert.deepEqual(songSearchSchema.required, ['query']);
assert.equal(songSearchSchema.properties.limit.default, 10);
assert.equal(matchesAgentToolInputSchema({ query: '晴天 周杰伦' }, songSearchSchema), true);
assert.equal(matchesAgentToolInputSchema({ query: '  ' }, songSearchSchema), false);
assert.equal(matchesAgentToolInputSchema({ query: '晴天', limit: 1 }, songSearchSchema), true);
assert.equal(matchesAgentToolInputSchema({ query: '晴天', limit: 100 }, songSearchSchema), true);
assert.equal(matchesAgentToolInputSchema({ query: '晴天', limit: 0 }, songSearchSchema), false);
assert.equal(matchesAgentToolInputSchema({ query: '晴天', limit: 101 }, songSearchSchema), false);
assert.equal(matchesAgentToolInputSchema({ query: '晴天', limit: 1.5 }, songSearchSchema), false);

const playlistSearchSchema = playlistSearchModule.netEaseSearchPublicPlaylistsDefinition.parameters;
assert.deepEqual(playlistSearchSchema.required, ['query']);
assert.equal(playlistSearchSchema.properties.limit.default, 10);
assert.equal(matchesAgentToolInputSchema({ query: '华语经典', unexpected: true }, playlistSearchSchema), false);

const playlistSchema = playlistModule.netEaseGetPublicPlaylistDefinition.parameters;
assert.deepEqual(playlistSchema.required, ['playlist_id']);
assert.equal(playlistSchema.properties.offset.default, 0);
assert.equal(playlistSchema.properties.limit.default, 50);
assert.equal(playlistSchema.properties.limit.maximum, 100);
assert.equal(matchesAgentToolInputSchema({ playlist_id: 1 }, playlistSchema), true);
assert.equal(matchesAgentToolInputSchema({ playlist_id: 0 }, playlistSchema), false);
assert.equal(matchesAgentToolInputSchema({ playlist_id: Number.MAX_SAFE_INTEGER + 1 }, playlistSchema), false);
assert.equal(matchesAgentToolInputSchema({ playlist_id: 1, offset: -1 }, playlistSchema), false);
assert.equal(matchesAgentToolInputSchema({ playlist_id: 1, offset: 2_147_483_648 }, playlistSchema), false);
assert.equal(matchesAgentToolInputSchema({ playlist_id: 1, limit: 101 }, playlistSchema), false);

for (const definition of [
  lyricsModule.netEaseGetSongLyricsDefinition,
  playModule.netEasePlaySongDefinition,
]) {
  const schema = definition.parameters;
  assert.deepEqual(schema.required, ['song_id']);
  assert.equal(matchesAgentToolInputSchema({ song_id: 1 }, schema), true);
  assert.equal(matchesAgentToolInputSchema({ song_id: 0 }, schema), false);
  assert.equal(matchesAgentToolInputSchema({ song_id: 1.5 }, schema), false);
  assert.equal(matchesAgentToolInputSchema({ song_id: Number.MAX_SAFE_INTEGER + 1 }, schema), false);
}
assert.equal(
  matchesAgentToolInputSchema({ song_id: 1, query: '晴天' }, playModule.netEasePlaySongDefinition.parameters),
  false,
  'play Tool 不得接受 search/name/artist 等额外输入',
);
assert.deepEqual(shareModule.netEaseResolveShareLinkDefinition.parameters.required, ['url']);
assert.deepEqual(playbackStateModule.netEaseGetPlaybackStateDefinition.parameters, {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
});
assert.deepEqual(
  playbackControlModule.netEaseControlPlaybackDefinition.parameters.properties.command.enum,
  ['pause', 'resume', 'next', 'previous'],
);

const songCandidates = [{
  songId: 186016,
  name: '晴天',
  artists: ['周杰伦'],
  album: '叶惠美',
  durationMs: 269000,
}];
const songSearchCalls = [];
const songSearchTool = songSearchModule.createNetEaseSearchSongsTool({
  searchSongs: async (...args) => {
    songSearchCalls.push(args);
    return { ok: true, data: songCandidates };
  },
});
const songSearchResult = await songSearchTool.execute({ query: '晴天' }, {});
assert.deepEqual(songSearchResult.data, songCandidates);
assert.match(modelContentOf(songSearchResult), /186016/u);
assert.match(modelContentOf(songSearchResult), /周杰伦/u);
assert.deepEqual(songSearchCalls, [['晴天', 10]], '歌曲搜索必须使用默认 limit，且不得触发播放');
await songSearchTool.execute({ query: '晴天', limit: 7 }, {});
assert.deepEqual(songSearchCalls[1], ['晴天', 7]);

const playlistCandidates = [{ playlistId: 10, name: '歌单', creatorName: '创建者', trackCount: 80 }];
const playlistSearchCalls = [];
const playlistSearchTool = playlistSearchModule.createNetEaseSearchPublicPlaylistsTool({
  searchPublicPlaylists: async (...args) => {
    playlistSearchCalls.push(args);
    return { ok: true, data: playlistCandidates };
  },
});
const playlistSearchResult = await playlistSearchTool.execute({ query: '歌单' }, {});
assert.deepEqual(playlistSearchResult.data, playlistCandidates);
assert.match(modelContentOf(playlistSearchResult), /"playlistId":10/u);
assert.deepEqual(playlistSearchCalls[0], ['歌单', 10]);
await playlistSearchTool.execute({ query: '歌单', limit: 4 }, {});
assert.deepEqual(playlistSearchCalls[1], ['歌单', 4]);

const playlistData = {
  ...playlistCandidates[0],
  totalTrackCount: 80,
  offset: 0,
  limit: 50,
  hasMore: true,
  tracks: songCandidates,
};
const playlistCalls = [];
const playlistTool = playlistModule.createNetEaseGetPublicPlaylistTool({
  getPublicPlaylist: async (...args) => {
    playlistCalls.push(args);
    return { ok: true, data: { ...playlistData, offset: args[1], limit: args[2] } };
  },
});
const firstPage = await playlistTool.execute({ playlist_id: 10 }, {});
assert.deepEqual(playlistCalls[0], [10, 0, 50]);
assert.deepEqual(firstPage.data, playlistData, '歌单分页与 hasMore/total 信息必须完整保留');
assert.match(modelContentOf(firstPage), /"totalTrackCount":80/u);
assert.match(modelContentOf(firstPage), /"songId":186016/u);
await playlistTool.execute({ playlist_id: 10, offset: 50, limit: 25 }, {});
assert.deepEqual(playlistCalls[1], [10, 50, 25]);

const maxText = (character, length) => character.repeat(length);
const maxSongCandidates = Array.from({ length: 100 }, (_, index) => ({
  songId: 1_000_000 + index,
  name: maxText('歌', 200),
  artists: Array.from({ length: 20 }, () => maxText('人', 100)),
  album: maxText('辑', 200),
  durationMs: 999_999,
}));
const maxSongSearchTool = songSearchModule.createNetEaseSearchSongsTool({
  searchSongs: async () => ({ ok: true, data: maxSongCandidates }),
});
const maxSongSearchResult = await maxSongSearchTool.execute({ query: '最大歌曲结果', limit: 100 }, {});
const maxSongSearchModelContent = modelContentOf(maxSongSearchResult);
const maxSongSearchProjection = structuredProjectionOf(maxSongSearchResult);
assert.ok(
  maxSongSearchModelContent.length <= executionSupport.NETEASE_MODEL_OBSERVATION_MAX_CHARS,
  '歌曲搜索 modelContent 必须受 NetEase 局部上限约束',
);
assert.equal(maxSongSearchProjection.observationTruncated, true);
assert.ok(maxSongSearchProjection.retainedResultCount > 0);
assert.equal(maxSongSearchProjection.candidates[0].songId, maxSongCandidates[0].songId);
assert.equal(
  maxSongSearchProjection.candidates.at(-1).songId,
  maxSongCandidates[maxSongSearchProjection.retainedResultCount - 1].songId,
);
assert.strictEqual(maxSongSearchResult.data, maxSongCandidates, 'model projection 不得修改 structured data');

const maxPlaylistData = {
  playlistId: 9_999,
  name: maxText('单', 200),
  creatorName: maxText('创', 100),
  trackCount: 100,
  totalTrackCount: 300,
  offset: 100,
  limit: 100,
  hasMore: true,
  tracks: maxSongCandidates,
};
const maxPlaylistTool = playlistModule.createNetEaseGetPublicPlaylistTool({
  getPublicPlaylist: async () => ({ ok: true, data: maxPlaylistData }),
});
const maxPlaylistResult = await maxPlaylistTool.execute({ playlist_id: 9_999, offset: 100, limit: 100 }, {});
const maxPlaylistModelContent = modelContentOf(maxPlaylistResult);
const maxPlaylistProjection = structuredProjectionOf(maxPlaylistResult);
assert.ok(maxPlaylistModelContent.length <= executionSupport.NETEASE_MODEL_OBSERVATION_MAX_CHARS);
assert.equal(maxPlaylistProjection.observationTruncated, true);
assert.equal(maxPlaylistProjection.playlistId, 9_999);
assert.equal(maxPlaylistProjection.offset, 100);
assert.equal(maxPlaylistProjection.limit, 100);
assert.equal(maxPlaylistProjection.hasMore, true);
assert.equal(maxPlaylistProjection.tracks[0].songId, maxSongCandidates[0].songId);
assert.strictEqual(maxPlaylistResult.data, maxPlaylistData);

let lyricsOutcome = { status: 'available', text: '[00:00]代表性歌词', truncated: true };
const lyricsTool = lyricsModule.createNetEaseGetSongLyricsTool({
  getSongLyrics: async () => ({ ok: true, data: lyricsOutcome }),
});
for (const outcome of [
  { status: 'available', text: '[00:00]代表性歌词', truncated: true },
  { status: 'no_lyrics' },
  { status: 'uncollected' },
]) {
  lyricsOutcome = outcome;
  const lyricsResult = await lyricsTool.execute({ song_id: 1 }, {});
  assert.deepEqual(lyricsResult.data, outcome);
  assert.match(modelContentOf(lyricsResult), new RegExp(outcome.status, 'u'));
  if (outcome.status === 'available') {
    assert.match(modelContentOf(lyricsResult), /代表性歌词/u);
    assert.match(modelContentOf(lyricsResult), /"truncated":true/u);
  }
}

lyricsOutcome = { status: 'available', text: maxText('词\\\n', 4_000), truncated: false };
const maxLyricsResult = await lyricsTool.execute({ song_id: 1 }, {});
const maxLyricsModelContent = modelContentOf(maxLyricsResult);
const maxLyricsProjection = structuredProjectionOf(maxLyricsResult);
assert.ok(maxLyricsModelContent.length <= executionSupport.NETEASE_MODEL_OBSERVATION_MAX_CHARS);
assert.equal(maxLyricsProjection.observationTruncated, true);
assert.equal(maxLyricsProjection.truncated, false, '必须保留 backend 自己的 truncated 真值');
assert.ok(maxLyricsProjection.text.length > 0);
assert.strictEqual(maxLyricsResult.data, lyricsOutcome);

let shareOutcome = { ok: true, data: { type: 'song', songId: 1 } };
const shareCalls = [];
const shareTool = shareModule.createNetEaseResolveShareLinkTool({
  resolveNetEaseShareLink: async (url) => {
    shareCalls.push(url);
    return shareOutcome;
  },
});
for (const resource of [
  { type: 'song', songId: 1 },
  { type: 'playlist', playlistId: 2 },
]) {
  shareOutcome = { ok: true, data: resource };
  const shareResult = await shareTool.execute({ url: 'https://music.163.com/example' }, {});
  assert.deepEqual(shareResult.data, resource);
  const resourceId = resource.type === 'song' ? resource.songId : resource.playlistId;
  assert.match(modelContentOf(shareResult), new RegExp(String(resourceId), 'u'));
}
assert.equal(shareCalls.length, 2, 'Tool 每次只能委托 resolver 一次，不自己发 HTTP');
for (const code of [
  'invalid_url',
  'unsupported_host',
  'redirect_rejected',
  'too_many_redirects',
  'network_failure',
  'unsupported_resource_type',
  'invalid_resource_id',
  'unresolvable_share_link',
]) {
  shareOutcome = { ok: false, error: { code, message: code } };
  const failure = await shareTool.execute({ url: 'https://music.163.com/example' }, {});
  assert.equal(failure.success, false);
  assert.equal(failure.errorCode, code);
}

for (const code of ['network_failure', 'api_rejected', 'invalid_response', 'not_found']) {
  const failingSearchTool = songSearchModule.createNetEaseSearchSongsTool({
    searchSongs: async () => ({
      ok: false,
      error: { code, message: code, apiCode: null },
    }),
  });
  const failure = await failingSearchTool.execute({ query: '晴天' }, {});
  assert.equal(failure.success, false);
  assert.equal(failure.errorCode, code);
}
const publicDataUnknownError = new Error('unexpected public backend failure');
const exceptionalSearchTool = songSearchModule.createNetEaseSearchSongsTool({
  searchSongs: async () => { throw publicDataUnknownError; },
});
await assert.rejects(
  () => exceptionalSearchTool.execute({ query: '晴天' }, {}),
  (error) => error === publicDataUnknownError,
);
const shareUnknownError = new Error('unexpected resolver failure');
const exceptionalShareTool = shareModule.createNetEaseResolveShareLinkTool({
  resolveNetEaseShareLink: async () => { throw shareUnknownError; },
});
await assert.rejects(
  () => exceptionalShareTool.execute({ url: 'https://music.163.com/example' }, {}),
  (error) => error === shareUnknownError,
);

const playCalls = [];
let playOutcome = { type: 'success' };
const playTool = playModule.createNetEasePlaySongTool(async (songId) => {
  playCalls.push(songId);
  if (playOutcome.type === 'success') {
    return {
      status: 'play_request_dispatched',
      songId,
      targetPackage: 'com.netease.cloudmusic',
    };
  }
  throw playOutcome.error;
});
const playSuccess = await playTool.execute({ song_id: 186016 }, {});
assert.equal(playSuccess.success, true);
assert.equal(playSuccess.data.status, 'play_request_dispatched');
assert.match(modelContentOf(playSuccess), /最终播放状态尚未确认/u);
assert.match(modelContentOf(playSuccess), /"songId":186016/u);
assert.doesNotMatch(
  modelContentOf(playSuccess),
  /播放成功|已经开始播放|playback_started|\bplaying\b/iu,
);
assert.deepEqual(playCalls, [186016]);
for (const reason of [
  'invalid_song_id',
  'protected_app',
  'route_unavailable',
  'route_dispatch_failed',
]) {
  playOutcome = { type: 'error', error: new NetEasePlayRequestError(reason) };
  const failure = await playTool.execute({ song_id: 186016 }, {});
  assert.equal(failure.errorCode, reason);
}
for (const unknownError of [
  new NetEaseRouteContractError('invalid_target_package'),
  new NetEaseRouteContractError('invalid_target_uri'),
  new Error('unknown capability failure'),
]) {
  playOutcome = { type: 'error', error: unknownError };
  await assert.rejects(() => playTool.execute({ song_id: 186016 }, {}), (error) => error === unknownError);
}

const contextFor = (actorAiId, abortSignal = new AbortController().signal) => ({
  getAIId: () => actorAiId,
  abortSignal,
});
let authorityCapabilityCalls = 0;
const authorityCapability = async () => {
  authorityCapabilityCalls += 1;
  return { success: true, message: 'ok' };
};
currentHostAiId = 'host-ai';
assert.equal(
  (await executionSupport.runNetEaseToolAsCurrentHost(contextFor(undefined), authorityCapability)).errorCode,
  'missing_actor_ai_id',
);
assert.equal(authorityCapabilityCalls, 0);
assert.equal(
  (await executionSupport.runNetEaseToolAsCurrentHost(contextFor('old-host'), authorityCapability)).errorCode,
  'not_current_host',
);
assert.equal(authorityCapabilityCalls, 0);
assert.equal(
  (await executionSupport.runNetEaseToolAsCurrentHost(contextFor('host-ai'), authorityCapability)).success,
  true,
);
assert.equal(authorityCapabilityCalls, 1);
const controller = new AbortController();
controller.abort();
await assert.rejects(
  () => executionSupport.runNetEaseToolAsCurrentHost(
    contextFor('host-ai', controller.signal),
    authorityCapability,
  ),
);
assert.equal(authorityCapabilityCalls, 1, '已取消时不得调用 application capability');

console.log('PHONE-8B2B1/PHONE-8D3B NetEase 八个 child Tool contract 检查通过。');
