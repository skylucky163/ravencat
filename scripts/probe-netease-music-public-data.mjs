#!/usr/bin/env node

/**
 * PHONE-8A 匿名公开数据探针。
 *
 * 这里只复现 api-enhanced 中当前公开读取所需的最小 EAPI request envelope，
 * 不依赖第三方 API server，不使用 MUSIC_U，也不写入任何生产 Tool 或运行时。
 * 协议参考：NeteaseCloudMusicApiEnhanced/api-enhanced（MIT），审计基线见对应文档。
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

const API_ORIGIN = 'https://interfacepc.music.163.com';
const EAPI_KEY = Buffer.from('e82ckenh8dichen8', 'utf8');
const EAPI_SEPARATOR = '-36cd479b6b5-';
const DEVICE_ID = crypto.randomBytes(16).toString('hex').toUpperCase();
const APP_VERSION = '9.5.61.260802021928';
const SONG_QUERY = '晴天 周杰伦';
const PLAYLIST_QUERY = '纯音乐';
const NORMAL_LYRIC_SONG_ID = 186016;
const INSTRUMENTAL_QUERY = '夜的钢琴曲五 石进';
const UNCOLLECTED_SONG_ID = 999999999999;

function createHeader() {
  return {
    osver: '14',
    deviceId: DEVICE_ID,
    os: 'android',
    appver: APP_VERSION,
    versioncode: '140',
    mobilename: '',
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: '1920x1080',
    __csrf: '',
    channel: 'xiaomi',
    requestId: `${Date.now()}_${String(crypto.randomInt(1000)).padStart(4, '0')}`,
  };
}

function encryptEapi(uri, payload) {
  const text = JSON.stringify(payload);
  const digest = crypto
    .createHash('md5')
    .update(`nobody${uri}use${text}md5forencrypt`)
    .digest('hex');
  const plaintext = `${uri}${EAPI_SEPARATOR}${text}${EAPI_SEPARATOR}${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', EAPI_KEY, null);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

function encodeCookie(header) {
  return Object.entries(header)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('; ');
}

async function requestEapi(uri, data) {
  const header = createHeader();
  const payload = { ...data, e_r: false, header };
  const startedAt = performance.now();
  const response = await fetch(`${API_ORIGIN}/eapi/${uri.slice('/api/'.length)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `NeteaseMusic/${APP_VERSION} Android`,
      Cookie: encodeCookie(header),
    },
    body: new URLSearchParams({ params: encryptEapi(uri, payload) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  return {
    httpStatus: response.status,
    latencyMs: Math.round(performance.now() - startedAt),
    body,
  };
}

function summarizeSong(song) {
  return {
    songId: song.id,
    name: song.name,
    artists: (song.ar ?? song.artists ?? []).map((artist) => ({
      artistId: artist.id,
      name: artist.name,
    })),
    album: song.al
      ? { albumId: song.al.id, name: song.al.name }
      : song.album
        ? { albumId: song.album.id, name: song.album.name }
        : null,
    durationMs: song.dt ?? song.duration ?? null,
  };
}

function summarizePlaylist(playlist) {
  return {
    playlistId: playlist.id,
    name: playlist.name,
    creator: playlist.creator
      ? { userId: playlist.creator.userId, nickname: playlist.creator.nickname }
      : null,
    trackCount: playlist.trackCount ?? playlist.trackIds?.length ?? null,
    coverUrlPresent: Boolean(playlist.coverImgUrl),
    descriptionPresent: Boolean(playlist.description),
  };
}

function classifyLyrics(body) {
  if (body.code !== 200) return { status: 'request_failure', apiCode: body.code };
  if (body.uncollected === true) return { status: 'uncollected' };
  if (body.nolyric === true) return { status: 'no_lyrics' };
  const lyric = body.lrc?.lyric;
  if (typeof lyric === 'string' && lyric.trim().length > 0) {
    return {
      status: 'available',
      characterCount: lyric.length,
      lineCount: lyric.split(/\r?\n/u).length,
      translatedLyricsPresent: Boolean(body.tlyric?.lyric),
    };
  }
  return { status: 'no_lyrics' };
}

function summarizeComment(comment) {
  return {
    commentId: comment.commentId,
    time: comment.time,
    likedCount: comment.likedCount,
    textCharacterCount: typeof comment.content === 'string' ? comment.content.length : 0,
    user: comment.user
      ? {
          userId: comment.user.userId,
          nickname: comment.user.nickname,
          avatarUrlPresent: Boolean(comment.user.avatarUrl),
        }
      : null,
  };
}

async function search(type, keywords, limit) {
  return requestEapi('/api/cloudsearch/pc', {
    s: keywords,
    type,
    limit,
    offset: 0,
    total: true,
  });
}

async function main() {
  const songSearch = await search(1, SONG_QUERY, 100);
  const songs = songSearch.body.result?.songs ?? [];
  const exactSong = songs.find((song) => song.id === NORMAL_LYRIC_SONG_ID);
  if (!exactSong) throw new Error('歌曲搜索未返回目标 songId=186016');

  const playlistSearch = await search(1000, PLAYLIST_QUERY, 50);
  const playlists = playlistSearch.body.result?.playlists ?? [];
  const selectedPlaylist = playlists
    .filter((playlist) => Number.isSafeInteger(playlist.id))
    .sort((left, right) => (right.trackCount ?? 0) - (left.trackCount ?? 0))[0];
  if (!selectedPlaylist) throw new Error('公开歌单搜索未返回可用 playlistId');

  const playlistDetail = await requestEapi('/api/v6/playlist/detail', {
    id: selectedPlaylist.id,
    n: 100000,
    s: 8,
  });
  const detail = playlistDetail.body.playlist;
  const trackIds = detail?.trackIds?.map(({ id }) => id) ?? [];
  const embeddedTracks = detail?.tracks ?? [];
  const detailBatches = [];
  for (let offset = 0; offset < trackIds.length; offset += 1000) {
    const ids = trackIds.slice(offset, offset + 1000);
    detailBatches.push(await requestEapi('/api/v3/song/detail', {
      c: JSON.stringify(ids.map((id) => ({ id }))),
    }));
  }

  const instrumentalSearch = await search(1, INSTRUMENTAL_QUERY, 5);
  const instrumentalSong = instrumentalSearch.body.result?.songs?.[0];
  if (!instrumentalSong) throw new Error('纯音乐搜索未返回可用 songId');

  const [normalLyrics, instrumentalLyrics, uncollectedLyrics] = await Promise.all([
    requestEapi('/api/song/lyric', {
      id: exactSong.id,
      tv: -1,
      lv: -1,
      rv: -1,
      kv: -1,
      _nmclfl: 1,
    }),
    requestEapi('/api/song/lyric', {
      id: instrumentalSong.id,
      tv: -1,
      lv: -1,
      rv: -1,
      kv: -1,
      _nmclfl: 1,
    }),
    requestEapi('/api/song/lyric', {
      id: UNCOLLECTED_SONG_ID,
      tv: -1,
      lv: -1,
      rv: -1,
      kv: -1,
      _nmclfl: 1,
    }),
  ]);

  const hotComments = await requestEapi(
    `/api/v1/resource/hotcomments/R_SO_4_${exactSong.id}`,
    { rid: String(exactSong.id), limit: 3, offset: 0, beforeTime: 0 },
  );
  const firstRecentComments = await requestEapi('/api/v2/resource/comments', {
    threadId: `R_SO_4_${exactSong.id}`,
    pageNo: 1,
    showInner: true,
    pageSize: 3,
    cursor: '0',
    sortType: 3,
  });
  const recentCursor = firstRecentComments.body.data?.cursor;
  const secondRecentComments = await requestEapi('/api/v2/resource/comments', {
    threadId: `R_SO_4_${exactSong.id}`,
    pageNo: 2,
    showInner: true,
    pageSize: 3,
    cursor: recentCursor,
    sortType: 3,
  });
  const firstRecent = firstRecentComments.body.data?.comments ?? [];
  const secondRecent = secondRecentComments.body.data?.comments ?? [];
  const firstIds = new Set(firstRecent.map(({ commentId }) => commentId));

  const invalidPlaylist = await requestEapi('/api/v6/playlist/detail', {
    id: UNCOLLECTED_SONG_ID,
    n: 100000,
    s: 8,
  });

  const report = {
    observedAt: new Date().toISOString(),
    credentials: {
      userAccountCookieUsed: false,
      anonymousTokenUsed: false,
      syntheticDeviceIdentityUsed: true,
    },
    protocol: {
      requestType: 'EAPI over HTTPS POST',
      origin: API_ORIGIN,
      upstreamResponseIsOfficiallySupported: false,
    },
    songSearch: {
      httpStatus: songSearch.httpStatus,
      apiCode: songSearch.body.code,
      latencyMs: songSearch.latencyMs,
      resultCount: songs.length,
      selected: summarizeSong(exactSong),
    },
    playlistSearch: {
      httpStatus: playlistSearch.httpStatus,
      apiCode: playlistSearch.body.code,
      latencyMs: playlistSearch.latencyMs,
      resultCount: playlists.length,
      selected: summarizePlaylist(selectedPlaylist),
    },
    playlistDetail: {
      httpStatus: playlistDetail.httpStatus,
      apiCode: playlistDetail.body.code,
      latencyMs: playlistDetail.latencyMs,
      playlist: detail ? summarizePlaylist(detail) : null,
      trackIdsCount: trackIds.length,
      embeddedTracksCount: embeddedTracks.length,
      embeddedTracksTruncated: embeddedTracks.length < trackIds.length,
      songDetailBatchCount: detailBatches.length,
      songDetailRequested: trackIds.length,
      songDetailReturned: detailBatches.reduce(
        (count, batch) => count + (batch.body.songs?.length ?? 0),
        0,
      ),
      songDetailBatchResults: detailBatches.map((batch) => ({
        httpStatus: batch.httpStatus,
        apiCode: batch.body.code,
        returned: batch.body.songs?.length ?? 0,
        latencyMs: batch.latencyMs,
      })),
    },
    lyrics: {
      normal: {
        song: summarizeSong(exactSong),
        httpStatus: normalLyrics.httpStatus,
        latencyMs: normalLyrics.latencyMs,
        ...classifyLyrics(normalLyrics.body),
      },
      instrumentalCandidate: {
        song: summarizeSong(instrumentalSong),
        httpStatus: instrumentalLyrics.httpStatus,
        latencyMs: instrumentalLyrics.latencyMs,
        ...classifyLyrics(instrumentalLyrics.body),
      },
      nonexistentId: {
        songId: UNCOLLECTED_SONG_ID,
        httpStatus: uncollectedLyrics.httpStatus,
        latencyMs: uncollectedLyrics.latencyMs,
        ...classifyLyrics(uncollectedLyrics.body),
      },
    },
    comments: {
      hot: {
        endpoint: '/api/v1/resource/hotcomments/{threadId}',
        httpStatus: hotComments.httpStatus,
        apiCode: hotComments.body.code,
        latencyMs: hotComments.latencyMs,
        total: hotComments.body.total ?? null,
        more: hotComments.body.more ?? null,
        comments: (hotComments.body.hotComments ?? []).map(summarizeComment),
      },
      recent: {
        endpoint: '/api/v2/resource/comments',
        sortType: 3,
        httpStatus: firstRecentComments.httpStatus,
        apiCode: firstRecentComments.body.code,
        latencyMs: firstRecentComments.latencyMs,
        total: firstRecentComments.body.data?.totalCount ?? null,
        hasMore: firstRecentComments.body.data?.hasMore ?? null,
        cursorPresent: typeof recentCursor === 'string' && recentCursor.length > 0,
      },
      recentPage1: firstRecent.map(summarizeComment),
      recentPage2: secondRecent.map(summarizeComment),
      page2LatencyMs: secondRecentComments.latencyMs,
      pageOverlapCount: secondRecent.filter(({ commentId }) => firstIds.has(commentId)).length,
    },
    invalidPlaylist: {
      playlistId: UNCOLLECTED_SONG_ID,
      httpStatus: invalidPlaylist.httpStatus,
      apiCode: invalidPlaylist.body.code,
      message: invalidPlaylist.body.message ?? invalidPlaylist.body.msg ?? null,
      playlistPresent: Boolean(invalidPlaylist.body.playlist),
      latencyMs: invalidPlaylist.latencyMs,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`PHONE-8A 网易云公开数据探针失败：${error.stack ?? error}\n`);
  process.exitCode = 1;
});
