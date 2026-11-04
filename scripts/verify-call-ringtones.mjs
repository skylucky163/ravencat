/** 验证真实铃声选择、并发 CAS、媒体提交、备份与旧库升级，不固定内部实现形状。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
function load(relative, mocks = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) return load(path.posix.join(path.posix.dirname(relative), `${name}.ts`));
    throw new Error(`缺少测试设备边界：${name}`);
  }, module, module.exports);
  return module.exports;
}
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const executor = createSqliteExecutor(db);
await bootstrapSqlite(executor);
db.exec(`INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES
  ('a', 'agent-a', 'A', 'test', '2026-10-26', '2026-10-26'), ('b', 'agent-b', 'B', 'test', '2026-10-26', '2026-10-26');`);
// 真实已安装的 145 库没有新表，升级不得改动角色或制造铃声选择。
for (const table of ['auxiliary_model_configs', 'ai_assistants', 'group_chat_admin_configs']) {
  db.exec(`ALTER TABLE ${table} DROP COLUMN service_config_id`);
}
db.exec('DROP TABLE model_service_configs; DROP TABLE model_service_settings;');
db.exec('DROP TABLE call_ringtone_selection; PRAGMA user_version=145;');
await bootstrapSqlite(executor);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM call_ringtone_selection').get().n, 0);
assert.equal(db.prepare('SELECT name FROM ai_assistants WHERE id=?').get('a').name, 'A');

let writeChain = Promise.resolve();
function transaction(task) {
  const result = writeChain.then(async () => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = await task(executor); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  writeChain = result.catch(() => {});
  return result;
}
const coordinator = { read: (_task, fn) => fn(executor), transaction: (_task, fn) => transaction(fn) };
const { SQLiteCallRingtoneRepository } = load('src/features/calls/infrastructure/SQLiteCallRingtoneRepository.ts', {
  '@platform/persistence': { databaseCoordinator: coordinator },
  '@shared/errors/SettingChangeConflictError': load('src/shared/errors/SettingChangeConflictError.ts'),
});
const repository = new SQLiteCallRingtoneRepository();
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const media = new SQLiteMediaAssetRepository(executor);
const { MediaAssetBackingRegistry, MEDIA_ASSET_STORAGE_BACKEND } = load('src/features/media/application/MediaAssetBacking.ts');
const { MediaAssetCatalog } = load('src/features/media/application/MediaAssetCatalog.ts');
const { CreateMediaAsset } = load('src/features/media/application/CreateMediaAsset.ts');
const files = new Set();
let sequence = 0, inspectFailure = false;
const writer = {
  storageBackend: 'persistent-media',
  async prepare() {
    const storageKey = `catalog/media/ring-${sequence}.mp3`;
    files.add(storageKey);
    return { storageBackend: this.storageBackend, storageKey, localUri: `file:///private/${storageKey}` };
  },
  commitPrepared() {},
  async resolve(storageKey) { assert.ok(files.has(storageKey)); return { localUri: `file:///private/${storageKey}` }; },
  async delete(storageKey) { files.delete(storageKey); },
};
const creator = new CreateMediaAsset({
  catalog: new MediaAssetCatalog(media), backings: new MediaAssetBackingRegistry({ writers: [writer] }),
  contentInspector: { async inspect() { return { contentHash: String(sequence).padStart(64, '0'), byteSize: 20 }; } },
  database: { withExclusiveTransactionAsync: transaction }, generateId: () => `ring-${++sequence}`,
  now: () => '2026-10-26T00:00:00Z', reportPostCommitCleanupFailure: error => { throw error; },
});
const settings = load('src/features/calls/application/CallRingtoneSettings.ts', {
  '@shared/runtime/RuntimeSlot': load('src/shared/runtime/RuntimeSlot.ts'),
  '@platform/persistence': { databaseCoordinator: coordinator },
  '@platform/device/CallRingtone': { async inspectCallRingtone() {
    if (inspectFailure) throw new Error('invalid audio');
    return { durationMs: 1200 };
  } },
  '@features/media': {
    MEDIA_ASSET_STORAGE_BACKEND, createMediaAssetWithReference: creator.execute.bind(creator),
    resolveMediaAsset: async id => writer.resolve((await media.getById(id)).storageKey),
    releaseMediaAssetCandidates: async ids => {
      const released = await transaction(tx => media.releaseUnreferencedAssetsInTransaction(tx, ids.filter(Boolean)));
      for (const asset of released) await writer.delete(asset.storageKey);
    },
  },
});
settings.configureCallRingtoneRuntime(repository);
const pick = direction => settings.setCustomCallRingtone({ assistantId: 'a', direction,
  sourceUri: 'file:///picker/cache.mp3', fileName: '喜欢的铃声.mp3', mimeType: 'audio/mpeg' });
assert.equal(await settings.loadCallRingtoneUri('a', 'incoming'), null);
await pick('incoming');
assert.equal((await settings.getCallRingtoneSelection('a', 'incoming')).fileName, '喜欢的铃声.mp3');
assert.match(await settings.loadCallRingtoneUri('a', 'incoming'), /^file:\/\/\/private\//);
assert.equal(await settings.loadCallRingtoneUri('a', 'outgoing'), null);
assert.equal(await settings.loadCallRingtoneUri('b', 'incoming'), null);
const original = await repository.get('a', 'incoming');
assert.deepEqual((await media.listBackupAssets(executor)).map(asset => asset.id), [original.mediaAssetId]);

inspectFailure = true;
await assert.rejects(pick('incoming'), /invalid audio/);
assert.deepEqual(await repository.get('a', 'incoming'), original);
inspectFailure = false;
// 同时选入不同音频，只允许一个提交；失败的媒体草稿必须补偿回收。
const attempts = await Promise.allSettled([pick('incoming'), pick('incoming')]);
assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
assert.equal(files.size, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n, 1);
await pick('outgoing');
await settings.clearCallRingtone('a', 'incoming');
assert.equal(await settings.loadCallRingtoneUri('a', 'incoming'), null);
assert.notEqual(await settings.loadCallRingtoneUri('a', 'outgoing'), null);
const cleared = await repository.get('a', 'incoming');
await assert.rejects(transaction(tx => repository.commit(tx, 'a', 'incoming', original.revision, 'old', 'old.mp3')), /已被其他操作更改/);
assert.deepEqual(await repository.get('a', 'incoming'), cleared);

// 恢复预检面对未升级的 145 快照，不查询尚不存在的铃声表。
await settings.clearCallRingtone('a', 'outgoing');
db.exec('DROP TABLE call_ringtone_selection; PRAGMA user_version=145;');
assert.deepEqual(await media.listBackupAssets(executor), []);
db.close();
console.log('通话铃声：145 升级、按角色/方向选择、音频边界失败、CAS、草稿回收、备份与恢复默认验证通过。');
