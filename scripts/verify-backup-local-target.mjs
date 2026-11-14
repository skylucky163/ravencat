/** 本地 BackupTarget 创建与发布清理行为测试。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTypeScriptModule } from './lib/import-typescript-module.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createLocalBackupUseCase } = await importTypeScriptModule(
  path.join(ROOT, 'src/features/backup/application/CreateLocalBackup.ts'),
);

function createDependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      sourceGateway: {
        createDatabaseSnapshot: async () => {
          calls.push('snapshot');
          return 'file://snapshot.db';
        },
        deleteDatabaseSnapshot: async (uri) => {
          calls.push(`delete-snapshot:${uri}`);
        },
        readNonDatabaseSources: async () => {
          calls.push('strict-sources');
          if (overrides.sourceError) throw overrides.sourceError;
          return {
            mediaRootUri: 'file://media',
            bubbleSkinRootUri: 'file://bubble-skins',
            stableSettingsJson: '{"schemaVersion":1}',
          };
        },
      },
      archiveBuilder: {
        prepare: async () => {
          calls.push('prepare-artifact');
          return {
            artifactId: 'prepared',
            fileName: 'RavenCat-Backup-test.ravenbackup',
            byteLength: 10,
            locator: 'file://prepared',
          };
        },
      },
      localTarget: {
        publish: async () => {
          calls.push('publish-downloads');
          if (overrides.publishError) throw overrides.publishError;
          return {
            artifactId: '42',
            fileName: 'RavenCat-Backup-test.ravenbackup',
            byteLength: 10,
            locator: 'content://downloads/42',
          };
        },
      },
      appVersion: '2.0.0',
      databaseContractVersion: 1,
    },
  };
}

// 成功路径：一致快照只活到发布结束，Target 只接收完整产物。
{
  const fixture = createDependencies();
  await createLocalBackupUseCase(fixture.dependencies)();
  assert.deepEqual(fixture.calls, [
    'snapshot',
    'strict-sources',
    'prepare-artifact',
    'publish-downloads',
    'delete-snapshot:file://snapshot.db',
  ]);
}

// strict owner export 失败时不得生成或发布“默认值备份”，但仍清理快照。
{
  const fixture = createDependencies({ sourceError: new Error('malformed wallpaper') });
  await assert.rejects(
    createLocalBackupUseCase(fixture.dependencies)(),
    /malformed wallpaper/u,
  );
  assert.deepEqual(fixture.calls, [
    'snapshot',
    'strict-sources',
    'delete-snapshot:file://snapshot.db',
  ]);
}

// MediaStore 发布失败同样清理临时 SQLite snapshot。
{
  const fixture = createDependencies({ publishError: new Error('downloads unavailable') });
  await assert.rejects(
    createLocalBackupUseCase(fixture.dependencies)(),
    /downloads unavailable/u,
  );
  assert.equal(fixture.calls.at(-1), 'delete-snapshot:file://snapshot.db');
}

// 原生清理策略必须同时绑定目录、MIME、名称、pending、年龄与单次上限。
const nativeSource = fs.readFileSync(
  path.join(
    ROOT,
    'modules/backup-storage/android/src/main/java/expo/modules/backupstorage/BackupStorageModule.kt',
  ),
  'utf8',
);
for (const contractToken of [
  'STALE_PENDING_AGE_SECONDS',
  'STALE_PENDING_CLEANUP_LIMIT',
  'MediaStore.Downloads.RELATIVE_PATH',
  'MediaStore.Downloads.OWNER_PACKAGE_NAME',
  'MediaStore.Downloads.MIME_TYPE',
  'MediaStore.Downloads.DISPLAY_NAME',
  'MediaStore.Downloads.IS_PENDING} = 1',
  'MediaStore.Downloads.DATE_ADDED',
]) {
  assert.ok(nativeSource.includes(contractToken), `pending cleanup 缺少约束：${contractToken}`);
}

console.log('Backup local target 行为测试通过');
