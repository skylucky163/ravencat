/** Backup coverage：用例前置条件、strict export 与统一恢复入口行为测试。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTypeScriptModule } from './lib/import-typescript-module.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  createRestoreBackupUseCase,
  createRestoreLocalBackupUseCase,
} = await importTypeScriptModule(
  path.join(ROOT, 'src/features/backup/application/RestoreBackup.ts'),
);
const {
  STABLE_SETTINGS_BACKUP_SCHEMA_VERSION,
  parseStableSettingsBackupJson,
} = await importTypeScriptModule(
  path.join(ROOT, 'src/features/backup/infrastructure/stableSettingsBackupState.ts'),
);

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// ── restore 用例编排：preflight → rollback settings → activate ──

function restoreFixture(overrides = {}) {
  const calls = [];
  const validationRoots = [];
  const artifact = {
    artifactId: 'external',
    fileName: 'fixture.ravenbackup',
    byteLength: 1,
    locator: 'content://fixture',
  };
  const dependencies = {
    restoreGateway: {
      prepare: async () => {
        calls.push('prepare');
        if (overrides.prepareError) throw overrides.prepareError;
        return {
          restoreId: 'restore-1',
          createdAt: '2026-01-01T00:00:00Z',
          appVersion: '2.0.0',
          stableSettingsJson: 'incoming-settings',
          bubbleSkinRootUri: 'file://staging/bubble-skins',
          mediaRootUri: 'file://staging/media/persistent-media',
        };
      },
      discard: async (restoreId) => {
        calls.push(`discard:${restoreId}`);
      },
      activateAndExit: async (restoreId, rollbackSettings) => {
        calls.push(`activate:${restoreId}:${rollbackSettings}`);
      },
    },
    sourceGateway: {
      validateStableSettingsJson: async (json, bubbleSkinRootUri, mediaRootUri) => {
        calls.push('validate-settings');
        validationRoots.push({ json, bubbleSkinRootUri, mediaRootUri });
        if (overrides.validationError) throw overrides.validationError;
      },
      exportStableSettingsJson: async () => {
        calls.push('snapshot-old-settings');
        if (overrides.exportError) throw overrides.exportError;
        return 'rollback-settings';
      },
    },
    localTarget: {
      open: async (artifactId) => {
        calls.push(`open-local:${artifactId}`);
        return { ...artifact, artifactId, locator: `content://downloads/${artifactId}` };
      },
    },
    databaseContractVersion: 1,
  };
  return { artifact, calls, dependencies, validationRoots };
}

// prepare 前失败：没有 staging handle 时不得运行 discard 或 activate。
{
  const fixture = restoreFixture({ prepareError: new Error('bad GCM tag') });
  await assert.rejects(
    createRestoreBackupUseCase(fixture.dependencies)(fixture.artifact),
    /bad GCM tag/u,
  );
  assert.deepEqual(fixture.calls, ['prepare']);
}

// settings / incoming media preflight 失败只丢弃 staging，现有 generation 不变。
{
  const fixture = restoreFixture({ validationError: new Error('malformed settings') });
  await assert.rejects(
    createRestoreBackupUseCase(fixture.dependencies)(fixture.artifact),
    /malformed settings/u,
  );
  assert.deepEqual(fixture.calls, ['prepare', 'validate-settings', 'discard:restore-1']);
}

// incoming media 缺失属于 owner preflight 失败：activate 不得执行，restore journal 不得登记。
{
  const fixture = restoreFixture({
    validationError: new Error('备份壁纸媒体文件缺失，无法恢复'),
  });
  await assert.rejects(
    createRestoreBackupUseCase(fixture.dependencies)(fixture.artifact),
    /备份壁纸媒体文件缺失/u,
  );
  assert.deepEqual(fixture.calls, ['prepare', 'validate-settings', 'discard:restore-1']);
  assert.equal(fixture.calls.some((call) => call.startsWith('activate:')), false);
  assert.equal(fixture.calls.includes('safety-backup'), false);
}

// preflight 必须拿到 staging bubble skin root 与 staging persistent-media root，而不是当前运行时根。
{
  const fixture = restoreFixture();
  await createRestoreBackupUseCase(fixture.dependencies)(fixture.artifact);
  assert.deepEqual(fixture.validationRoots, [{
    json: 'incoming-settings',
    bubbleSkinRootUri: 'file://staging/bubble-skins',
    mediaRootUri: 'file://staging/media/persistent-media',
  }]);
}

// rollback settings 导出失败时，不能进入激活或留下 staging。
{
  const fixture = restoreFixture({ exportError: new Error('rollback settings export failed') });
  await assert.rejects(
    createRestoreBackupUseCase(fixture.dependencies)(fixture.artifact),
    /rollback settings export failed/u,
  );
  assert.deepEqual(fixture.calls, [
    'prepare', 'validate-settings', 'snapshot-old-settings', 'discard:restore-1',
  ]);
}

// 当前 stable settings 快照同样是 activate 前置，并作为 rollback generation 输入。
{
  const fixture = restoreFixture();
  await createRestoreBackupUseCase(fixture.dependencies)(fixture.artifact);
  assert.deepEqual(fixture.calls, [
    'prepare',
    'validate-settings',
    'snapshot-old-settings',
    'activate:restore-1:rollback-settings',
  ]);
}

// local 只负责把 artifact handle 交给同一 restoreArtifact 主链。
{
  const fixture = restoreFixture();
  const received = [];
  const restoreLocal = createRestoreLocalBackupUseCase(
    fixture.dependencies,
    async (artifact) => received.push(artifact),
  );
  await restoreLocal('42');
  assert.equal(received.length, 1);
  assert.equal(received[0].locator, 'content://downloads/42');
}

// 背景已随数据库保存，不重复序列化运行时 URI；旧开发期 schema 明确拒绝。
const stable = { schemaVersion: STABLE_SETTINGS_BACKUP_SCHEMA_VERSION, legacyMediaRootUri: 'file:///source/persistent-media/', theme: {}, bubbleSkins: {} };
assert.deepEqual(parseStableSettingsBackupJson(JSON.stringify(stable)), { legacyMediaRootUri: stable.legacyMediaRootUri, theme: {}, bubbleSkins: {} });
assert.throws(() => parseStableSettingsBackupJson('{'), SyntaxError);
assert.throws(() => parseStableSettingsBackupJson(JSON.stringify({ schemaVersion: STABLE_SETTINGS_BACKUP_SCHEMA_VERSION })));
for (const schemaVersion of [1, 2, 3, 4]) assert.throws(() => parseStableSettingsBackupJson(JSON.stringify({ ...stable, schemaVersion })), /不支持的稳定设置版本/u);

assert.throws(() => parseStableSettingsBackupJson(JSON.stringify({ ...stable, legacyMediaRootUri: undefined })), /来源长期媒体根无效/u);

// ── 静态契约：canonical 数据库、legacy 清理与 strict owner export ──

const themeSource = readSource('src/shared/theme/themeStorage.ts');
const restoreSource = readSource('src/features/backup/application/RestoreBackup.ts');
const connectionSource = readSource('src/platform/persistence/sqlite/connection.ts');
const helpersSource = readSource('src/platform/persistence/helpers.ts');
const resetFacadeSource = readSource('src/host/application/resetApplicationData.ts');
const bubbleSkinStoreSource = readSource(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/BubbleSkinStore.kt',
);
const bubbleSkinBridgeSource = readSource(
  'modules/ravencat-floating-layer/android/src/main/java/expo/modules/ravencatfloatinglayer/bridge/RavenCatFloatingLayerModule.kt',
);
const restoreEngineSource = readSource(
  'modules/backup-storage/android/src/main/java/expo/modules/backupstorage/BackupRestoreEngine.kt',
);

assert.match(themeSource, /AsyncStorage\.multiGet\(keys\)/u);
assert.match(themeSource, /parseStoredThemeBackupState\(/u);

// 背景迁移、CAS、共享引用与 staging 文件检查由 verify-call-background-assets 行为测试覆盖。

// restore 用例必须把 staging media root 交给 owner preflight。
assert.match(restoreSource, /prepared\.bubbleSkinRootUri/u);
assert.match(restoreSource, /prepared\.mediaRootUri/u);

// canonical active business database 的选择入口只有一条，且 v4 fallback 已删除。
//
// 不变量是"业务库选择只有一条入口"，不是"全仓只能调用一次 openDatabaseAsync"：
// DatabaseCoordinator.backupToAsync() 会为快照正常打开一个 destination DB，那不是业务库选择。
assert.match(connectionSource, /export const DB_NAME_DEFAULT = 'kimiphone_v5\.db'/u);
assert.match(connectionSource, /await SQLite\.openDatabaseAsync\(DB_NAME_DEFAULT\)/u);
assert.doesNotMatch(connectionSource, /DB_NAME_V4/u);
assert.doesNotMatch(connectionSource, /kimiphone_v4\.db/u);
assert.doesNotMatch(connectionSource, /Fallback to v4/u);
assert.equal(
  (connectionSource.match(/await SQLite\.openDatabaseAsync\(/gu) ?? []).length,
  1,
  'connection.ts 内部只能有一处 canonical business database 打开点',
);
assert.match(
  readSource('src/platform/persistence/runtime/DatabaseCoordinator.ts'),
  /SQLite\.openDatabaseAsync\(/u,
  '备份快照的 destination DB 打开点是合法的第二次 open，不属于业务库选择',
);

// legacy 清理覆盖 v4 及其 WAL/SHM 边车文件，且不使用非幂等的 deleteDatabaseAsync。
for (const legacyFile of ['kimiphone.db', 'kimiphone_v1.db', 'kimiphone_v2.db', 'kimiphone_v3.db', 'kimiphone_v4.db']) {
  assert.match(helpersSource, new RegExp(`'${legacyFile.replace('.', '\\.')}'`, 'u'));
}
assert.match(helpersSource, /'-wal'/u);
assert.match(helpersSource, /'-shm'/u);
assert.doesNotMatch(helpersSource, /deleteDatabaseAsync/u);
assert.match(resetFacadeSource, /cleanupLegacyDatabases/u);

// Bubble Skin：strict export 为唯一备份导出路径，且必须校验 persisted 文件的 owner root 归属。
assert.match(bubbleSkinStoreSource, /fun exportBackupStrict\(/u);
assert.doesNotMatch(bubbleSkinStoreSource, /fun exportBackup\(\)/u);
assert.match(bubbleSkinStoreSource, /readPersistedCustomSkinsStrict\(\)/u);
assert.match(
  bubbleSkinStoreSource,
  /require\(file\.parentFile == skinDirectory\(\)\.canonicalFile\) \{ "悬浮球装扮文件不属于装扮目录" \}/u,
  'strict export 必须校验 persisted filePath 的 canonical 归属位于 owner root（打包只遍历该 root）',
);
assert.match(
  bubbleSkinStoreSource,
  /require\(Files\.isRegularFile\(file\.toPath\(\), LinkOption\.NOFOLLOW_LINKS\)\) \{ "悬浮球装扮文件缺失" \}/u,
);
assert.match(bubbleSkinStoreSource, /require\(!Files\.isSymbolicLink\(persistedFile\.toPath\(\)\)\)/u);
assert.match(
  bubbleSkinStoreSource,
  /private const val SKIN_DIRECTORY = "ravencat\/bubble-skins"/u,
  'owner root 只有一个定义，避免打包 root 与 key 解析边界漂移',
);
assert.match(bubbleSkinStoreSource, /require\(seenIds\.add\(id\)\)/u);
assert.match(bubbleSkinStoreSource, /if \(File\(path\)\.isFile\) \{/u);
assert.match(bubbleSkinBridgeSource, /store\.exportBackupStrict\(\)/u);
assert.match(bubbleSkinBridgeSource, /validateBubbleSkinBackupSettings/u);

// native staging 必须暴露 persistent-media 只读根。
assert.match(restoreEngineSource, /mediaRootUri = Uri\.fromFile\(File\(staging, "media\/persistent-media"\)\)/u);

console.log('Backup coverage 行为测试通过');
