/** 真实 SQLite 与媒体生命周期验证记录、查重、分段、删除和备份引用；文件/原生作为 IO 边界替代。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor, DATABASE_SCHEMA_VERSION } from './helpers/sqlite-bootstrap-fixture.mjs';

const boundaries = {}, cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports;
  const module = { exports: {} }; cache.set(relative, module);
  const compiled = ts.transpileModule(fs.readFileSync(relative, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(id => {
    if (Object.hasOwn(boundaries, id)) return boundaries[id];
    if (id.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${id}.ts`)));
    throw new Error(`未装配的 IO 边界：${id}`);
  }, module, module.exports);
  return module.exports;
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const executor = createSqliteExecutor(db);
await bootstrapSqlite(executor);
let tail = Promise.resolve();
const transaction = operation => {
  const task = tail.then(async () => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = await operation(executor); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  tail = task.catch(() => {});
  return task;
};
boundaries['@platform/persistence'] = { databaseCoordinator: {
  transaction: (_meta, operation) => transaction(operation),
  write: (_meta, operation) => transaction(operation),
  read: (_meta, operation) => tail.then(() => operation(executor)),
  openTaskExecutor: () => executor,
} };
boundaries['@shared/runtime/RuntimeSlot'] = load('src/shared/runtime/RuntimeSlot.ts');
const { SQLiteCallRepository } = load('src/features/calls/infrastructure/SQLiteCallRepository.ts');
const calls = new SQLiteCallRepository();
const { configureCallRuntimeDependencies } = load('src/features/calls/application/runtime/CallRuntimeDependencies.ts');
configureCallRuntimeDependencies({ repositories: { calls } });
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const mediaRepo = new SQLiteMediaAssetRepository(executor);
const backingModule = load('src/features/media/application/MediaAssetBacking.ts');
const { MediaAssetBackingRegistry } = backingModule;
const files = new Set(), deleted = [];
const temporarySnapshots = new Set();
const writer = {
  storageBackend: 'persistent-media',
  async prepare({ assetId }) {
    const storageKey = `catalog/media/${assetId}.wav`; files.add(storageKey);
    return { storageBackend: 'persistent-media', storageKey, localUri: `file:///${storageKey}` };
  },
  commitPrepared() {},
  async resolve(storageKey) { if (!files.has(storageKey)) throw new Error('文件不存在'); return { localUri: `file:///${storageKey}` }; },
  async delete(key) { files.delete(key); deleted.push(key); },
  ownsStorageKeyLifecycle: () => true,
};
const backings = new MediaAssetBackingRegistry({ writers: [writer] });
const { MediaAssetCatalog } = load('src/features/media/application/MediaAssetCatalog.ts');
const catalog = new MediaAssetCatalog(mediaRepo);
const { CreateMediaAsset } = load('src/features/media/application/CreateMediaAsset.ts');
const creator = new CreateMediaAsset({
  catalog, backings, contentInspector: { async inspect() { return { contentHash: createHash('sha256').update(randomUUID()).digest('hex'), byteSize: 4096 }; } },
  database: { withExclusiveTransactionAsync: transaction }, generateId: randomUUID, now: () => new Date().toISOString(),
  reportPostCommitCleanupFailure(error) { throw error; },
});
const { MediaAssetLifecycle } = load('src/features/media/application/MediaAssetLifecycle.ts');
const lifecycle = new MediaAssetLifecycle(mediaRepo, backings, { withExclusiveTransactionAsync: transaction });
boundaries['@features/media'] = {
  ...backingModule,
  createMediaAssetWithReference: (...args) => creator.execute(...args),
  releaseMediaAssetCandidates: async ids => lifecycle.releaseCandidates(ids),
};
boundaries['@platform/device'] = { createRandomUUID: randomUUID, readLocalAudioMetadata: async () => ({ durationMs: 13420 }),
  temporarySpeechAudioStore: { async deleteIfExists(uri) { deleted.push(uri); } },
  PERSISTENT_MEDIA_CATEGORY: { callSnapshot: 'callSnapshot' }, getPersistentMediaCategoryPrefix: () => 'calls/snapshots/',
  persistentMediaStore: {
    async persistMedia({ originalFileName }) { const uri = `file:///calls/snapshots/${originalFileName}`; temporarySnapshots.add(uri); return uri; },
    async getInfo() { return { size: 128 }; },
    async deleteIfExists(uri) { temporarySnapshots.delete(uri); },
    async deleteCategoryFileIfExists(uri) { temporarySnapshots.delete(uri); },
  },
};
const history = load('src/features/calls/application/CallHistory.ts');
const transcript = load('src/features/calls/application/events/AppendCallTranscriptEvent.ts');
for (const assistant of ['a', 'b']) {
  db.prepare("INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES (?, ?, ?, 'model', '2026-10-24', '2026-10-24')").run(assistant, `agent-${assistant}`, assistant);
  db.prepare("INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at) VALUES (?, ?, 'chat', '2026-10-24', '2026-10-24')").run(`chat-${assistant}`, assistant);
}
const start = '2026-10-24T04:05:06.000Z';
const create = (id, assistant = 'a', startedAt = start) => calls.createSession({ id, aiAssistantId: assistant,
  agentId: `agent-${assistant}`, chatSessionId: `chat-${assistant}`, direction: 'outgoing', requestedMode: 'video', source: 'user',
  state: 'ended', startedAt, acceptedAt: startedAt, endedAt: '2026-10-24T04:08:00.000Z' });

await Promise.all([create('first'), create('same-second'), create('other-ai', 'b'), create('newest', 'a', '2026-10-24T05:00:00.000Z')]);
const list = await history.listCallHistory('a');
assert.equal(list[0].callId, 'newest');
assert.equal(new Set(list.map(record => record.title)).size, 3);
assert.match(list.find(record => record.callId === 'first').title, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
assert.equal((await history.listCallHistory('b')).length, 1);
await history.renameCallHistory('first', 'a', '  一起聊天 🌙  ');
await assert.rejects(history.renameCallHistory('same-second', 'a', '一起聊天 🌙'), /同名/);
await history.renameCallHistory('other-ai', 'b', '一起聊天 🌙');
const renamed = await Promise.allSettled(['first', 'same-second'].map(id => history.renameCallHistory(id, 'a', '并发改名')));
assert.equal(renamed.filter(result => result.status === 'fulfilled').length, 1);
for (const title of ['', ' \n ', '标题\u202e', 'a'.repeat(101)]) await assert.rejects(history.renameCallHistory('first', 'a', title));
await assert.rejects(history.getCallHistory('first', 'b'), /不存在/);

const speech = await transcript.appendUserSpeechText({ callId: 'first', text: '你好呀！！！', audio: Promise.resolve({ uri: 'file:///user.wav', durationMs: 2300 }) });
await transcript.appendUserSpeechText({ callId: 'first', text: '今天过得很好哦。' });
boundaries['@features/speech'] = { async synthesizeTextToSpeech({ text }) { return { success: true, audioUri: `file:///${encodeURIComponent(text)}.mp3`, mimeType: 'audio/mpeg' }; } };
const playback = [];
configureCallRuntimeDependencies({ repositories: { calls }, native: { audioPlayback: { async play(uri) {
  playback.push(uri); return { playbackId: randomUUID(), finished: Promise.resolve(), async stop() {} };
}, async stop() {} } } });
db.prepare("UPDATE call_sessions SET state='active', ended_at=NULL WHERE id='first'").run();
const { CallTTSPlaybackQueue } = load('src/features/calls/application/runtime/CallTTSPlaybackQueue.ts');
const queue = new CallTTSPlaybackQueue();
await Promise.all(['你好！很高兴认识你！', '我查询发现今天天气很不错呢！'].map(text => queue.enqueueAISpeech({ callId: 'first', assistantId: 'a', text })));
db.prepare("UPDATE call_sessions SET state='ended', ended_at='2026-10-24T04:08:00.000Z' WHERE id='first'").run();
const detail = await history.getCallHistory('first', 'a');
assert.deepEqual((await calls.listEvents({ callId: 'first', limit: 100 })).filter(event => event.kind === 'error').map(event => event.text), []);
assert.deepEqual(detail.entries.map(entry => [entry.speaker, entry.inputKind, entry.durationMs]), [
  ['user', 'speech', 2300], ['user', 'text', null], ['ai', 'speech', 13420], ['ai', 'speech', 13420],
]);
assert.equal(detail.entries[0].id, speech.id);
assert.equal(playback.length, 2);
const audioIds = detail.entries.flatMap(entry => entry.mediaAssetId ? [entry.mediaAssetId] : []);
assert.equal(audioIds.length, 3);
assert.deepEqual((await mediaRepo.listBackupAssets(executor)).map(asset => asset.id).sort(), [...audioIds].sort());
assert.equal((await lifecycle.releaseCandidates(audioIds)).releasedAssets.length, 0, '仍被记录引用的音频不能作为孤儿释放');
assert.ok((await mediaRepo.listAssistantMediaAssetIds('a', executor)).includes(audioIds[0]));
assert.ok((await mediaRepo.listChatSessionMediaAssetIds(['chat-a'], executor)).includes(audioIds[0]));

// 没有对话或音频的失败电话也必须能取回已保存的异常。
const nativeFailure = await calls.appendEvent({ callId: 'same-second', chatSessionId: 'chat-a',
  kind: 'error', actorType: 'system', text: '原生通话建立失败（等待当前音频端点）：系统通话音频建立超时' });
const failedDetail = await history.getCallHistory('same-second', 'a');
assert.equal(failedDetail.entries.length, 0);
assert.deepEqual(failedDetail.errors, [{ id: nativeFailure.id, createdAt: nativeFailure.createdAt, text: nativeFailure.text }]);
assert.deepEqual(detail.errors, []);

// 真机回归：143 已初始化通话录音，但后补的截图表尚未创建；重新启动必须正式升级。
// 同时还原当时尚未引入的服务连接结构，避免把当前 schema 仅改版本号当成旧库。
function restore143ModelSchema() {
  for (const table of ['auxiliary_model_configs', 'ai_assistants', 'group_chat_admin_configs']) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN service_config_id`);
  }
  db.exec('DROP TABLE model_service_configs; DROP TABLE model_service_settings;');
}
restore143ModelSchema();
db.exec('DROP TABLE call_history_images; DROP TABLE call_history_preferences; PRAGMA user_version=143');
assert.deepEqual((await mediaRepo.listBackupAssets(executor)).map(asset => asset.id).sort(), [...audioIds].sort(), '仅录音的 143 旧备份可预检');
await bootstrapSqlite(executor);
assert.equal(await history.getCallHistorySnapshotSaving('a'), false);
assert.deepEqual(await history.getCallHistory('first', 'a'), detail, '升级保留标题、文字及音频引用');
await history.setCallHistorySnapshotSaving('a', true);
assert.equal(await history.getCallHistorySnapshotSaving('a'), true);
await history.setCallHistorySnapshotSaving('a', false);

// 两条记录共享同一资产；删除其中一条必须保留另一条的录音。
await calls.appendHistoryEntry({ id: 'shared', callId: 'same-second', speaker: 'ai', inputKind: 'speech', text: '共享音频', createdAt: start });
await transaction(tx => calls.attachHistoryAudio(tx, 'shared', audioIds[0], 2300));
await history.deleteCallHistory('first', 'a');
await assert.rejects(history.getCallHistory('first', 'a'), /不存在/);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM call_history_entries WHERE call_id=?').get('first').count, 0);
assert.ok(await mediaRepo.getById(audioIds[0]), '共享音频仍有引用');
assert.equal(await mediaRepo.getById(audioIds[1]), null);
assert.ok(db.prepare('SELECT 1 FROM call_events WHERE id=?').get(speech.id), '删除历史不破坏原有 AI 上下文事实');
await history.deleteCallHistory('same-second', 'a');
assert.equal(await mediaRepo.getById(audioIds[0]), null);

// 打断发生在长期文件准备期间，临时音频不能先被删除；归档结束后不得迟到开播。
let finishCopy, announceCopy;
const copying = new Promise(resolve => { announceCopy = resolve; });
const copied = new Promise(resolve => { finishCopy = resolve; });
const createAsset = boundaries['@features/media'].createMediaAssetWithReference;
boundaries['@features/media'].createMediaAssetWithReference = async (...args) => {
  announceCopy(); await copied; return createAsset(...args);
};
db.prepare("UPDATE call_sessions SET state='active', ended_at=NULL WHERE id='newest'").run();
const interrupted = queue.enqueueAISpeech({ callId: 'newest', assistantId: 'a', text: '归档期间被打断。' });
await copying;
await queue.interruptForUserSpeech('newest');
const tempUri = `file:///${encodeURIComponent('归档期间被打断。')}.mp3`;
assert.equal(deleted.includes(tempUri), false);
finishCopy(); await interrupted;
assert.equal(deleted.includes(tempUri), true);
assert.equal(playback.length, 2, '已经取消的语音不能在保存完成后重新开播');
assert.ok((await calls.listHistoryEntries('newest'))[0].mediaAssetId);

// 截图开关按 AI 独立、默认关闭；开启后归档的图片不依赖视觉临时文件。
const { attachCallSnapshot } = load('src/features/calls/application/snapshots/AttachCallSnapshot.ts');
const { discardCallSnapshots } = load('src/features/calls/application/snapshots/CallSnapshotLifetime.ts');
assert.equal(await history.getCallHistorySnapshotSaving('a'), false);
assert.equal(await history.getCallHistorySnapshotSaving('b'), false);
const capture = () => attachCallSnapshot({ callId: 'newest', sourceUri: 'file:///native-frame.jpg', width: 720, height: 1280, mimeType: 'image/jpeg' });
await capture();
assert.equal((await calls.listHistoryImages('newest')).length, 0);
await history.setCallHistorySnapshotSaving('a', true);
assert.equal(await history.getCallHistorySnapshotSaving('b'), false);
await capture();
const photo = (await calls.listHistoryImages('newest'))[0];
assert.ok(photo);
restore143ModelSchema();
db.exec('PRAGMA user_version=143');
assert.ok((await mediaRepo.listBackupAssets(executor)).some(asset => asset.id === photo.mediaAssetId), '含截图的 143 旧备份仍包含图片引用');
await bootstrapSqlite(executor);
assert.equal((await calls.listHistoryImages('newest'))[0].mediaAssetId, photo.mediaAssetId, '升级含截图的旧库不丢图片');
await history.setCallHistorySnapshotSaving('a', false);
await capture();
assert.equal((await calls.listHistoryImages('newest')).length, 1, '关闭只影响之后的截图，不删除旧图片');
await discardCallSnapshots('newest');
assert.equal(temporarySnapshots.size, 0);
assert.ok(await mediaRepo.getById(photo.mediaAssetId), '视觉输入清理不删除长期副本');
assert.ok((await mediaRepo.listBackupAssets(executor)).some(asset => asset.id === photo.mediaAssetId));
assert.ok((await mediaRepo.listAssistantMediaAssetIds('a', executor)).includes(photo.mediaAssetId));
assert.ok((await mediaRepo.listChatSessionMediaAssetIds(['chat-a'], executor)).includes(photo.mediaAssetId));
assert.equal((await lifecycle.releaseCandidates([photo.mediaAssetId])).releasedAssets.length, 0);
await assert.rejects(history.deleteCallHistoryImage(photo.id, 'newest', 'b'), /不存在/);
await history.deleteCallHistoryImage(photo.id, 'newest', 'a');
assert.equal((await calls.listHistoryImages('newest')).length, 0);
assert.equal(await mediaRepo.getById(photo.mediaAssetId), null);
assert.equal((await calls.listHistoryEntries('newest')).length, 1, '单独删除截图不删除对话和音频');
await history.setCallHistorySnapshotSaving('a', true);
await capture();
const remainingPhoto = (await calls.listHistoryImages('newest'))[0];
db.prepare("UPDATE call_sessions SET state='ended', ended_at='2026-10-24T05:08:00.000Z' WHERE id='newest'").run();
await history.deleteCallHistory('newest', 'a');
assert.equal(await mediaRepo.getById(remainingPhoto.mediaAssetId), null, '删除整条记录也回收截图');

// 采集停止必须等待已经发出的分段导出，防止挂断先删除底层 PCM。
let finishExport, sourceStops = 0, removed = 0;
boundaries['../../../modules/realtime-speech-audio-source'] = {
  addRealtimeSpeechAudioChunkListener: () => ({ remove() { removed++; } }),
  addRealtimeSpeechAudioErrorListener: () => ({ remove() { removed++; } }),
  addRealtimeSpeechDetectedListener: () => ({ remove() { removed++; } }),
  startRealtimeSpeechAudioSource: async () => ({ archiveId: 'recording', echoCancellationEnabled: true }),
  exportRealtimeSpeechSegment: async (id, startMs, endMs) => {
    assert.deepEqual([id, startMs, endMs], ['recording', 0, 2300]);
    return new Promise(resolve => { finishExport = resolve; });
  },
  stopRealtimeSpeechAudioSource: async () => { sourceStops++; },
};
const { realtimeSpeechAudioSource } = load('src/platform/device/RealtimeSpeechAudioSource.ts');
const source = await realtimeSpeechAudioSource.start({ archiveSegments: true, onAudioChunk() {}, onError(error) { throw error; } });
const exporting = source.exportSegment(0, 2300);
const stopping = source.stop();
assert.equal(sourceStops, 0);
finishExport({ uri: 'file:///last.wav', durationMs: 2300 });
await exporting; await stopping; await source.stop();
assert.equal(sourceStops, 1);
assert.equal(removed, 3);

// 已发布库升级只加新记录表，不伪造旧音频，也不覆盖现有文字事实。
restore143ModelSchema();
db.exec('DROP TABLE call_history_images; DROP TABLE call_history_preferences; DROP TABLE call_history_entries; DROP TABLE call_history; PRAGMA user_version=142');
assert.equal((await mediaRepo.listBackupAssets(executor)).length, 0, '旧备份预检不查询尚不存在的录音表');
await bootstrapSqlite(executor);
assert.equal(db.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM call_history').get().count, 0);
assert.ok(db.prepare('SELECT 1 FROM call_events WHERE id=?').get(speech.id));
db.close();
console.log('通话历史行为验证通过：标题查重、语音/文字、逐句 TTS、打断/停止、可选截图及单独删除、备份、引用回收和升级。');
