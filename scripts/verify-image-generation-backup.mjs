/** 旧快照在升级前枚举媒体；当前快照保留生成记录和选择，升级失败整笔回滚。 */
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapSqlite, createSqliteExecutor, DATABASE_SCHEMA_VERSION, restoreLegacyModelServicesFixture } from './helpers/sqlite-bootstrap-fixture.mjs';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-generation-backup-'));
const now = '2026-11-07T00:00:00.000Z';
try {
  for (const version of [166, 167, DATABASE_SCHEMA_VERSION]) {
    const source = new DatabaseSync(':memory:');
    source.exec('PRAGMA foreign_keys=ON');
    await bootstrapSqlite(createSqliteExecutor(source));
    source.prepare(`INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES('ai','agent','AI','model',?,?)`).run(now, now);
    source.prepare(`INSERT INTO media_assets(id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,width,height,status,created_at,updated_at)
      VALUES('image','persistent-media','catalog/image.png','sha256',?,'image/png',100,1,1,'ready',?,?)`).run('a'.repeat(64), now, now);
    source.exec("UPDATE media_image_generation_settings SET model_config_id='deleted-model' WHERE id=1");
    if (version < 168) {
      restoreLegacyModelServicesFixture(source);
      source.exec('ALTER TABLE moments DROP COLUMN edited_at; ALTER TABLE moments DROP COLUMN edit_revision;');
      for (const column of ['recurrence_json', 'series_id', 'trigger_kind', 'conversation_id', 'reply_revision', 'next_follow_up_minutes']) {
        source.exec(`ALTER TABLE raven_cat_ai_schedules DROP COLUMN ${column}`);
      }
      source.exec('ALTER TABLE raven_cat_contact_settings DROP COLUMN follow_up_enabled; ALTER TABLE raven_cat_contact_settings DROP COLUMN follow_up_interval_minutes;');
      source.prepare("INSERT INTO ai_downloaded_images VALUES('download','ai','image','https://images.example/a','a.png',?)").run(now);
      source.exec('DROP TABLE ai_generated_images; DROP TABLE media_image_generation_settings;');
      if (version === 166) source.exec('ALTER TABLE auxiliary_model_configs ADD COLUMN enabled INTEGER DEFAULT 1');
      source.exec(`PRAGMA user_version=${version}`);
    } else {
      source.prepare("INSERT INTO ai_generated_images VALUES('generated','ai','image','a.png',?)").run(now);
    }
    const snapshotFile = path.join(directory, `snapshot-${version}.db`);
    await backup(source, snapshotFile);
    source.close();
    const snapshot = new DatabaseSync(snapshotFile);
    try {
      snapshot.exec('PRAGMA foreign_keys=ON');
      const executor = createSqliteExecutor(snapshot);
      const repository = new SQLiteMediaAssetRepository(executor);
      assert.deepEqual((await repository.listBackupAssets(executor)).map(asset => asset.id), ['image'], `${version} 预检必须直接枚举未升级快照`);
      if (version === 167) {
        await assert.rejects(bootstrapSqlite({ ...executor, execAsync: async sql => {
          if (sql.startsWith('PRAGMA user_version =')) throw new Error('版本提交失败');
          return executor.execAsync(sql);
        } }), /版本提交失败/);
        assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 167);
        assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('ai_generated_images','media_image_generation_settings')").get().n, 0);
      }
      await bootstrapSqlite(executor);
      await bootstrapSqlite(executor);
      assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
      assert.deepEqual((await repository.listBackupAssets(executor)).map(asset => asset.id), ['image']);
      assert.equal(snapshot.prepare('SELECT model_config_id FROM media_image_generation_settings').get().model_config_id, version < 168 ? null : 'deleted-model');
      assert.equal(snapshot.prepare('SELECT count(*) n FROM ai_generated_images').get().n, version < 168 ? 0 : 1);
      if (version >= 168) {
        assert.ok((await repository.auditDatabase()).references.some(reference => reference.kind === 'ai_generated_image'));
        snapshot.exec("DELETE FROM ai_assistants WHERE id='ai'");
        assert.equal(snapshot.prepare('SELECT count(*) n FROM ai_generated_images').get().n, 0);
        const released = await repository.releaseUnreferencedAssetsInTransaction(executor, ['image']);
        assert.equal(released.length, 1, '最后一个角色引用撤销后允许回收');
      }
      assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { snapshot.close(); }
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('生图备份回归通过：166/167 升级前预检、167 事务回滚、当前完整快照与级联回收。');
