/** PHONE-8B2B2A：网易云 production child assembly 契约。 */

import assert from 'node:assert/strict';
import {
  loadTypeScriptModule,
  readRepoFile,
} from '../helpers/load-typescript-module.mjs';

const publicDataBackend = { kind: 'production-public-data-backend' };
const shareLinkResolver = { kind: 'production-share-link-resolver' };
const playNetEaseSongById = async () => ({ status: 'play_request_dispatched' });
const getNetEasePlaybackSnapshot = async () => ({ status: 'playback_snapshot_available' });
const controlNetEasePlayback = async () => ({ status: 'playback_command_dispatched' });
const calls = [];
const factory = (name) => (dependency) => {
  calls.push({ name, dependency });
  return { name, definition: { name } };
};

const composition = loadTypeScriptModule('src/features/phoneTools/neteaseComposition.ts', {
  './aiTools/NetEaseSearchSongsTool': {
    createNetEaseSearchSongsTool: factory('netease_search_songs'),
  },
  './aiTools/NetEaseSearchPublicPlaylistsTool': {
    createNetEaseSearchPublicPlaylistsTool: factory('netease_search_public_playlists'),
  },
  './aiTools/NetEaseGetPublicPlaylistTool': {
    createNetEaseGetPublicPlaylistTool: factory('netease_get_public_playlist'),
  },
  './aiTools/NetEaseGetSongLyricsTool': {
    createNetEaseGetSongLyricsTool: factory('netease_get_song_lyrics'),
  },
  './aiTools/NetEaseResolveShareLinkTool': {
    createNetEaseResolveShareLinkTool: factory('netease_resolve_share_link'),
  },
  './aiTools/NetEasePlaySongTool': {
    createNetEasePlaySongTool: factory('netease_play_song'),
  },
  './aiTools/NetEaseGetPlaybackStateTool': {
    createNetEaseGetPlaybackStateTool: factory('netease_get_playback_state'),
  },
  './aiTools/NetEaseControlPlaybackTool': {
    createNetEaseControlPlaybackTool: factory('netease_control_playback'),
  },
  './application/PlayNetEaseSongById': { playNetEaseSongById },
  './application/NetEasePlayback': {
    getNetEasePlaybackSnapshot,
    controlNetEasePlayback,
  },
  './infrastructure/NativeNetEasePublicDataBackend': {
    nativeNetEasePublicDataBackend: publicDataBackend,
  },
  './infrastructure/NativeNetEaseShareLinkResolver': {
    nativeNetEaseShareLinkResolver: shareLinkResolver,
  },
});

const expectedNames = [
  'netease_search_songs',
  'netease_search_public_playlists',
  'netease_get_public_playlist',
  'netease_get_song_lyrics',
  'netease_resolve_share_link',
  'netease_play_song',
  'netease_get_playback_state',
  'netease_control_playback',
];
assert.equal(composition.productionNetEaseChildTools.length, 8);
assert.deepEqual(composition.productionNetEaseChildTools.map(({ name }) => name), expectedNames);
assert.deepEqual(calls.map(({ name }) => name), expectedNames);
assert.ok(calls.slice(0, 4).every(({ dependency }) => dependency === publicDataBackend));
assert.strictEqual(calls[4].dependency, shareLinkResolver);
assert.strictEqual(calls[5].dependency, playNetEaseSongById);
assert.strictEqual(calls[6].dependency, getNetEasePlaybackSnapshot);
assert.strictEqual(calls[7].dependency, controlNetEasePlayback);

const compositionSource = readRepoFile('src/features/phoneTools/neteaseComposition.ts');
assert.doesNotMatch(compositionSource, /modules\/netease-public-data|Eapi|redirect|orpheus:\/\//u);
assert.match(
  compositionSource,
  /createNetEasePlaySongTool\(playNetEaseSongById\)/u,
  'exact-song 必须继续使用现有 application capability',
);

console.log('PHONE-8B2B2A NetEase production child assembly 契约检查通过。');
