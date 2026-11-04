/** 通话背景的真实 SQLite CAS、迁移、共享引用、快照清单及 staging 缺失回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(relative, mocks = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)((name) => {
    if (name === '@shared/errors/SettingChangeConflictError') return load('src/shared/errors/SettingChangeConflictError.ts');
    assert.ok(Object.hasOwn(mocks, name), `缺少运行依赖：${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}
const slot = load('src/shared/runtime/RuntimeSlot.ts');
const { isAppCacheFileUri } = load('src/platform/device/PersistentImageStore.ts', {
  './MediaFileLifetime': {}, 'expo-file-system/legacy': {},
});
const pickerCache = 'file:///data/user/0/com.skylucky.kimiphone/cache/ImagePicker/missing.png';
assert.equal(isAppCacheFileUri(pickerCache), true);
assert.equal(isAppCacheFileUri('/data/data/com.skylucky.kimiphone/cache/ImageManipulator/image.jpg'), true);
for (const uri of ['file:///data/user/0/com.skylucky.kimiphone/files/persistent-media/wallpapers/image.jpg', 'https://example.com/cache/image.jpg', 'content://picker/image', 'file:///storage/emulated/0/cache/image.jpg']) {
  assert.equal(isAppCacheFileUri(uri), false, '只识别 Android 应用私有缓存路径');
}
const { CALL_BACKGROUND_SELECTION_SCHEMA, migrateAssistantCallBackgrounds, migrateCallBackgroundRoleKey } = load('src/platform/persistence/sqlite/callBackgroundSchema.ts');
const { MEDIA_ASSET_SCHEMA } = load('src/platform/persistence/sqlite/mediaAssetSchema.ts');
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const { MediaAssetBackingRegistry, MEDIA_ASSET_STORAGE_BACKEND } = load('src/features/media/application/MediaAssetBacking.ts');
const { MediaAssetCatalog } = load('src/features/media/application/MediaAssetCatalog.ts', { './MediaAssetBacking': { MediaAssetBackingNotFoundError: Error } });
const { CreateMediaAsset } = load('src/features/media/application/CreateMediaAsset.ts');
const db = new DatabaseSync(':memory:');
db.exec(CALL_BACKGROUND_SELECTION_SCHEMA);
db.exec(MEDIA_ASSET_SCHEMA);
db.exec('CREATE TABLE assistant_profile_covers (assistant_id TEXT PRIMARY KEY, media_asset_id TEXT NOT NULL)');
db.exec(load('src/platform/persistence/sqlite/chatBubbleSkinSchema.ts').CHAT_BUBBLE_SKINS_SCHEMA);
db.exec(load('src/platform/persistence/sqlite/chatFavoriteSchema.ts').CHAT_FAVORITES_SCHEMA);
db.exec(load('src/platform/persistence/sqlite/aiImageSchema.ts').AI_DOWNLOADED_IMAGES_SCHEMA);
db.exec(load('src/platform/persistence/sqlite/wallpaperSelectionSchema.ts').WALLPAPER_SELECTION_SCHEMA);
db.exec('CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, kind TEXT)');
db.exec('CREATE TABLE call_sessions (id TEXT PRIMARY KEY)');
db.exec('CREATE TABLE conversation_turn_runs (run_id TEXT PRIMARY KEY)');
db.exec(`
  CREATE TABLE user_profile (id TEXT, avatar_media_asset_id TEXT, moments_cover_media_asset_id TEXT);
  CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, avatar_media_asset_id TEXT, moments_cover_media_asset_id TEXT);
  CREATE TABLE group_chats (id TEXT, avatar_media_asset_id TEXT, moments_cover_media_asset_id TEXT);
  CREATE TABLE moment_media (id TEXT, media_asset_id TEXT);
  CREATE TABLE stickers (id TEXT, media_asset_id TEXT);
  CREATE TABLE messages (id INTEGER, metadata_json TEXT);
`);
db.exec(load('src/platform/persistence/sqlite/callHistorySchema.ts').CALL_HISTORY_SCHEMA);
db.exec(load('src/platform/persistence/sqlite/callRingtoneSchema.ts').CALL_RINGTONE_SELECTION_SCHEMA);
db.exec(load('src/platform/persistence/sqlite/chatReplyVersionSchema.ts').CHAT_REPLY_VERSIONS_SCHEMA);
const executor = {
  execAsync: async (sql) => db.exec(sql),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
};
db.exec("PRAGMA foreign_keys = ON; INSERT INTO ai_assistants (id) VALUES ('a'), ('b');");
await migrateAssistantCallBackgrounds(executor);
db.exec("INSERT INTO ai_assistants (id) VALUES ('new-role');");

// 已进入 SQLite 的旧全局选择在 schema 事务中直接分配，不复制图片或运行时继承。
for (const assetId of ['existing-background', null]) {
  const legacyDb = new DatabaseSync(':memory:');
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 96;
    CREATE TABLE ai_assistants (id TEXT PRIMARY KEY);
    INSERT INTO ai_assistants VALUES ('first'), ('second');
    CREATE TABLE call_background_selection (id INTEGER PRIMARY KEY CHECK (id = 1), media_asset_id TEXT, revision INTEGER NOT NULL);
  `);
  legacyDb.prepare('INSERT INTO call_background_selection VALUES (1, ?, 7)').run(assetId);
  const legacyExecutor = {
    execAsync: async (sql) => legacyDb.exec(sql),
    getFirstAsync: async (sql) => legacyDb.prepare(sql).get() ?? null,
    getAllAsync: async (sql) => legacyDb.prepare(sql).all(),
  };
  await migrateAssistantCallBackgrounds(legacyExecutor);
  assert.deepEqual(legacyDb.prepare('SELECT * FROM call_background_selection ORDER BY id').all().map((row) => ({ ...row })), [
    { id: 'first', media_asset_id: assetId, revision: 7 },
    { id: 'second', media_asset_id: assetId, revision: 7 },
  ]);
  legacyDb.exec("UPDATE call_background_selection SET media_asset_id = 'independent' WHERE id = 'first'; INSERT INTO ai_assistants VALUES ('later');");
  await migrateAssistantCallBackgrounds(legacyExecutor);
  assert.equal(legacyDb.prepare("SELECT media_asset_id FROM call_background_selection WHERE id = 'first'").get().media_asset_id, 'independent', '重复启动不重新覆盖独立选择');
  assert.equal(legacyDb.prepare("SELECT * FROM call_background_selection WHERE id = 'later'").get(), undefined, '新角色不继承旧全局背景');
  legacyDb.exec("DELETE FROM ai_assistants WHERE id = 'first'");
  assert.equal(legacyDb.prepare("SELECT * FROM call_background_selection WHERE id = 'first'").get(), undefined, '删除角色级联清除背景');
  assert.equal(legacyDb.prepare("SELECT name FROM sqlite_master WHERE name IN ('call_background_global_selection', 'call_background_legacy_migration')").get(), undefined);
  legacyDb.close();
}
// schema 迁移失败不能留下半张新表或提前推进版本。
{
  const rollbackDb = new DatabaseSync(':memory:');
  rollbackDb.exec(`
    PRAGMA user_version = 96;
    CREATE TABLE ai_assistants (id TEXT PRIMARY KEY);
    INSERT INTO ai_assistants VALUES ('a');
    CREATE TABLE call_background_selection (id INTEGER PRIMARY KEY CHECK (id = 1), media_asset_id TEXT, revision INTEGER NOT NULL);
    INSERT INTO call_background_selection VALUES (1, 'kept-background', 2);
  `);
  let fail = true;
  const rollbackExecutor = {
    execAsync: async (sql) => {
      if (fail && sql.includes('INSERT INTO call_background_selection')) throw new Error('注入迁移写入失败');
      rollbackDb.exec(sql);
    },
    getFirstAsync: async (sql) => rollbackDb.prepare(sql).get() ?? null,
    getAllAsync: async (sql) => rollbackDb.prepare(sql).all(),
  };
  await assert.rejects(migrateAssistantCallBackgrounds(rollbackExecutor), /注入迁移写入失败/);
  assert.equal(rollbackDb.prepare('PRAGMA user_version').get().user_version, 96);
  assert.equal(rollbackDb.prepare('SELECT media_asset_id FROM call_background_selection WHERE id = 1').get().media_asset_id, 'kept-background');
  fail = false;
  await migrateAssistantCallBackgrounds(rollbackExecutor);
  assert.equal(rollbackDb.prepare("SELECT media_asset_id FROM call_background_selection WHERE id = 'a'").get().media_asset_id, 'kept-background');
  rollbackDb.close();
}

// 对齐生产单写者，独立角色的并发提交也必须在真实 SQLite 中验证。
let writeQueue = Promise.resolve();
const transaction = (work) => {
  const run = writeQueue.then(async () => {
    db.exec('BEGIN');
    try { const result = await work(executor); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
};
const coordinator = { read: (_meta, work) => work(executor), transaction: (_meta, work) => transaction(work) };
const { SQLiteCallBackgroundRepository } = load('src/features/calls/infrastructure/SQLiteCallBackgroundRepository.ts', { '@platform/persistence': { databaseCoordinator: coordinator } });
const repository = new SQLiteCallBackgroundRepository();

// 真机回归：版本100的角色表实际使用 assistant_id，更换背景在保存前读取旧绑定时失败。
for (const roleColumn of ['assistant_id', 'id']) {
  const installedDb = new DatabaseSync(':memory:');
  installedDb.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 100;
    CREATE TABLE ai_assistants (id TEXT PRIMARY KEY);
    INSERT INTO ai_assistants VALUES ('first'), ('second');
    CREATE TABLE call_background_selection (
      ${roleColumn} TEXT PRIMARY KEY NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
      media_asset_id TEXT, revision INTEGER NOT NULL CHECK (revision >= 0)
    );
    INSERT INTO call_background_selection VALUES ('first', 'shared-background', 3), ('second', 'shared-background', 7);
  `);
  const installedExecutor = {
    execAsync: async (sql) => installedDb.exec(sql),
    getFirstAsync: async (sql, params = []) => installedDb.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => installedDb.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => installedDb.prepare(sql).run(...params),
  };
  const InstalledRepository = load('src/features/calls/infrastructure/SQLiteCallBackgroundRepository.ts', {
    '@platform/persistence': { databaseCoordinator: { read: (_meta, work) => work(installedExecutor) } },
  }).SQLiteCallBackgroundRepository;
  const installed = new InstalledRepository();
  if (roleColumn === 'assistant_id') await assert.rejects(installed.get('first'), /no such column: id/);
  await migrateCallBackgroundRoleKey(installedExecutor);
  assert.deepEqual({ ...await installed.get('first') }, { mediaAssetId: 'shared-background', revision: 3 }, '修正列名保留原背景与版本');
  assert.deepEqual({ ...await installed.get('second') }, { mediaAssetId: 'shared-background', revision: 7 });
  await installed.commit(installedExecutor, 'first', 3, 'new-background');
  assert.deepEqual({ ...await installed.get('first') }, { mediaAssetId: 'new-background', revision: 4 }, '更换新背景可读取并提交当前角色');
  assert.deepEqual({ ...await installed.get('second') }, { mediaAssetId: 'shared-background', revision: 7 }, '更换新背景不影响另一角色');
  await installed.commit(installedExecutor, 'first', 4, null);
  await migrateCallBackgroundRoleKey(installedExecutor);
  assert.deepEqual({ ...await installed.get('first') }, { mediaAssetId: null, revision: 5 }, '重复启动不复活已清除的背景');
  assert.equal(installedDb.prepare('PRAGMA user_version').get().user_version, 101);
  installedDb.exec("DELETE FROM ai_assistants WHERE id = 'second'");
  assert.equal(await installed.get('second'), null, '修正列名后外键级联仍有效');
  installedDb.close();
}

// 相同真机结构经过启动修正后，继续运行下面的完整选图、资产提交和清除链路。
db.exec('ALTER TABLE call_background_selection RENAME COLUMN id TO assistant_id');
await assert.rejects(repository.get('a'), /no such column: id/);
await migrateCallBackgroundRoleKey(executor);
const catalogRepository = new SQLiteMediaAssetRepository(executor);
const files = new Set();
const settings = new Map();
let sequence = 0;
const writer = {
  storageBackend: 'persistent-image',
  async prepare({ assetId, sourceUri }) {
    assert.ok(files.has(sourceUri), '源文件必须可读');
    const storageKey = `catalog/images/${assetId}.jpg`;
    const localUri = `file:///current/${storageKey}`;
    files.add(localUri);
    return { storageBackend: 'persistent-image', storageKey, localUri };
  },
  commitPrepared() {},
  async resolve(key) { const localUri = `file:///current/${key}`; assert.ok(files.has(localUri)); return { localUri }; },
  async delete(key) { files.delete(`file:///current/${key}`); },
};
const creator = new CreateMediaAsset({
  catalog: new MediaAssetCatalog(catalogRepository), backings: new MediaAssetBackingRegistry({ writers: [writer] }),
  contentInspector: { inspect: async () => ({ contentHash: String(sequence).padStart(64, '0'), byteSize: 5 }) },
  database: { withExclusiveTransactionAsync: transaction }, generateId: () => `image-${++sequence}`,
  now: () => '2026-10-06T00:00:00Z', reportPostCommitCleanupFailure: (error) => { throw error; },
});
let preparationGate = null;
const sharedMocks = {
  '@react-native-async-storage/async-storage': { default: {
    getItem: async (key) => settings.get(key) ?? null, removeItem: async (key) => { settings.delete(key); },
  } },
  '@shared/runtime/RuntimeSlot': slot,
  './WallpaperChanged': load('src/features/profile/application/WallpaperChanged.ts'),
  '@platform/persistence': { databaseCoordinator: coordinator },
  '@platform/device/DeviceMediaService': {
    isAppCacheFileUri,
    PERSISTENT_IMAGE_CATEGORY: { callBackground: 'callBackground' },
    async copyPickedImageToAppStorage({ sourceUri }) {
      if (!files.has(sourceUri)) throw new Error('旧背景文件丢失');
      const uri = `file:///draft/${++sequence}.jpg`; files.add(uri);
      if (preparationGate) await preparationGate;
      return uri;
    },
    deleteManagedPersistentImageIfExists: async (uri) => { files.delete(uri); },
  },
  '@features/media': {
    MEDIA_ASSET_STORAGE_BACKEND, createMediaAssetWithReference: creator.execute.bind(creator),
    resolveMediaAsset: async (id) => writer.resolve((await catalogRepository.getById(id)).storageKey),
    releaseMediaAssetCandidates: async (ids) => {
      const released = await transaction((tx) => catalogRepository.releaseUnreferencedAssetsInTransaction(tx, ids.filter(Boolean)));
      for (const asset of released) await writer.delete(asset.storageKey);
    },
  },
};
const feature = load('src/features/calls/application/CallBackgroundSettings.ts', sharedMocks);
feature.configureCallBackgroundRuntime(repository);
const legacyKey = 'kimi_phone.call.background_uri';

settings.set(legacyKey, 'file:///old/cache/background.jpg');
await assert.rejects(feature.loadCallBackgroundUri('a'), /旧背景文件丢失/);
assert.equal(await repository.get('a'), null, '失败不固化默认选择');
assert.ok(settings.has(legacyKey), '失败保留旧设置供修复');
await feature.clearCallBackground('a');
assert.equal(await feature.loadCallBackgroundUri('a'), null, '清除单个角色不依赖丢失文件');
assert.ok(settings.has(legacyKey), '其他角色仍需迁移旧背景');

db.exec('DELETE FROM call_background_selection');
files.add('file:///old/cache/background.jpg'); settings.set(legacyKey, 'file:///old/cache/background.jpg');
const migrated = await Promise.all([feature.loadCallBackgroundUri('a'), feature.loadCallBackgroundUri('b')]);
assert.equal(migrated[0], migrated[1], '并发读取不重复准备旧背景');
assert.ok(migrated[0].includes('/catalog/images/'));
assert.equal(settings.has(legacyKey), false);
const first = await repository.get('a');
assert.ok(first.mediaAssetId && !first.mediaAssetId.includes('file:'));
assert.equal((await repository.get('b')).mediaAssetId, first.mediaAssetId, '旧背景共享文件，绑定各自独立');
assert.equal(await feature.loadCallBackgroundUri('new-role'), null, '升级后、首次读背景前新建的角色使用默认背景');
assert.equal(await repository.getLegacyMigration(), null, '成功后删除一次性迁移表');
settings.set(legacyKey, 'file:///stale-global.jpg');
assert.equal(await feature.loadCallBackgroundUri('new-role'), null, '迁移后不再回退读取旧全局值');
settings.delete(legacyKey);
assert.equal([...files].some((uri) => uri.startsWith('file:///draft/')), false);
assert.equal((await catalogRepository.auditDatabase()).orphanAssets.length, 0, '背景是 live 引用');

files.add('file:///picker/new.jpg');
let releasePreparation;
preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
const delayed = feature.setCustomCallBackground({ assistantId: 'a', sourceUri: 'file:///picker/new.jpg' });
await new Promise((resolve) => setImmediate(resolve));
await feature.clearCallBackground('a');
releasePreparation();
await assert.rejects(delayed, /其他操作更改/);
preparationGate = null;
assert.equal((await repository.get('a')).mediaAssetId, null, '晚到的选图不能覆盖同角色清除');
assert.equal((await repository.get('b')).mediaAssetId, first.mediaAssetId, '同角色 CAS 不影响其他角色');
assert.equal([...files].some((uri) => uri.startsWith('file:///draft/')), false);
assert.equal((await catalogRepository.auditDatabase()).assets.length, 1, 'CAS 失败回滚新资产并保留其他角色背景');
await feature.clearCallBackground('b');
assert.equal((await catalogRepository.auditDatabase()).assets.length, 0, '最后一个角色清除后释放旧背景');

const independent = await Promise.all([
  feature.setCustomCallBackground({ assistantId: 'a', sourceUri: 'file:///picker/new.jpg' }),
  feature.setCustomCallBackground({ assistantId: 'b', sourceUri: 'file:///old/cache/background.jpg' }),
]);
assert.notEqual(independent[0], independent[1], '不同角色可并发绑定不同背景');
assert.equal(await feature.loadCallBackgroundUri('a'), independent[0]);
assert.equal(await feature.loadCallBackgroundUri('b'), independent[1]);
await feature.clearCallBackground('a');
assert.equal(await feature.loadCallBackgroundUri('b'), independent[1], '清除一个角色不改变另一个角色的自定义背景');
await feature.clearCallBackground('b');

// 角色删除发生在文件准备期间：外键拒绝复活绑定，资产事务回滚并清理副本。
db.exec("INSERT INTO ai_assistants (id) VALUES ('doomed');");
preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
const afterDeletion = feature.setCustomCallBackground({ assistantId: 'doomed', sourceUri: 'file:///picker/new.jpg' });
await new Promise((resolve) => setImmediate(resolve));
await transaction((tx) => tx.runAsync("DELETE FROM ai_assistants WHERE id = 'doomed'"));
releasePreparation();
await assert.rejects(afterDeletion, /FOREIGN KEY/);
preparationGate = null;
assert.equal(await repository.get('doomed'), null);
assert.equal((await catalogRepository.auditDatabase()).assets.length, 0);
assert.equal([...files].some((uri) => uri.startsWith('file:///draft/')), false);

await feature.setCustomCallBackground({ assistantId: 'a', sourceUri: 'file:///picker/new.jpg' });
const selected = (await repository.get('a')).mediaAssetId;
assert.equal(await feature.loadCallBackgroundUri('b'), null, '更换一个角色不会改变另一个角色');
db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, ?)').run('self', selected);
await feature.clearCallBackground('a');
assert.ok(await catalogRepository.getById(selected), '清除背景不释放另一 owner 仍引用的资产');
const inventory = await catalogRepository.listBackupAssets(executor);
assert.deepEqual(inventory.map((asset) => asset.id), [selected]);

// 旧全局数据库尚未激活/迁移时，恢复 preflight 仍能枚举它的背景文件。
{
  const oldSnapshot = new DatabaseSync(':memory:');
  for (const table of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    oldSnapshot.exec(table.name === 'call_background_selection'
      ? 'CREATE TABLE call_background_selection (id INTEGER PRIMARY KEY CHECK (id = 1), media_asset_id TEXT, revision INTEGER)'
      : table.sql);
  }
  const assetRow = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(selected);
  const columns = Object.keys(assetRow);
  oldSnapshot.prepare(`INSERT INTO media_assets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(assetRow));
  oldSnapshot.prepare('INSERT INTO call_background_selection VALUES (1, ?, 0)').run(selected);
  const snapshotExecutor = { getAllAsync: async (sql) => oldSnapshot.prepare(sql).all(),
    getFirstAsync: async (sql) => oldSnapshot.prepare(sql).get() ?? null };
  assert.deepEqual((await catalogRepository.listBackupAssets(snapshotExecutor)).map((asset) => asset.id), [selected], '旧全局背景备份的媒体清单不依赖新 schema');
  oldSnapshot.close();
}

// 文件迁移准备期间清除单个角色，只应让这个角色保持默认，不能覆盖用户的新选择。
db.exec(`
  DELETE FROM call_background_selection;
  CREATE TABLE call_background_legacy_migration (assistant_id TEXT PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE);
  INSERT INTO call_background_legacy_migration VALUES ('a'), ('b');
`);
settings.set(legacyKey, 'file:///old/cache/background.jpg');
preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
const duringMigration = feature.loadCallBackgroundUri('b');
await new Promise((resolve) => setImmediate(resolve));
await feature.clearCallBackground('a');
releasePreparation();
await duringMigration;
preparationGate = null;
assert.equal(await feature.loadCallBackgroundUri('a'), null, '迁移不覆盖准备期间明确清除的角色');
assert.ok(await feature.loadCallBackgroundUri('b'), '其他旧角色仍迁入背景');
await feature.clearCallBackground('b');

// 所有旧角色都已明确改选后，旧文件已无 consumer，备份前收尾不依赖该文件。
db.exec(`
  CREATE TABLE call_background_legacy_migration (assistant_id TEXT PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE);
  INSERT INTO call_background_legacy_migration VALUES ('a'), ('b');
`);
settings.set(legacyKey, 'file:///missing-old-background.jpg');
await feature.ensureCallBackgroundMigration();
assert.equal(await repository.getLegacyMigration(), null);
assert.equal(settings.has(legacyKey), false);

const gatewayModule = load('src/features/backup/infrastructure/ApplicationBackupSourceGateway.ts', {
  '@platform/persistence': {},
  '@platform/device': { PERSISTENT_IMAGE_CATEGORY: { wallpaper: 'wallpaper' }, getPersistentImageCategoryPrefix: () => 'wallpapers/', persistentMediaStore: {} },
  '@platform/device/DeviceMediaService': { getPersistentImageInfoInRoot: async (mediaRoot, key) => ({ exists: mediaRoot === 'file:///staging', isDirectory: false, size: 5 }) },
  '@features/media': { MEDIA_ASSET_STORAGE_BACKEND },
  '@shared/theme': { parseStoredThemeBackupState: value => value },
  '../../../../modules/ravencat-floating-layer': { validateBubbleSkinBackupSettings: async () => {} },
  './stableSettingsBackupState': load('src/features/backup/infrastructure/stableSettingsBackupState.ts'),
});
const reads = [];
const gateway = new gatewayModule.ApplicationBackupSourceGateway({ readMediaInventory: async (uri) => { reads.push(uri); return inventory; } });
const stable = JSON.stringify({ schemaVersion: load('src/features/backup/infrastructure/stableSettingsBackupState.ts').STABLE_SETTINGS_BACKUP_SCHEMA_VERSION, legacyMediaRootUri: 'file:///source/persistent-media/', theme: {}, bubbleSkins: {} });
await gateway.validateStableSettingsJson(stable, 'file:///skins', 'file:///staging', 'file:///incoming.db');
assert.deepEqual(reads, ['file:///incoming.db'], 'preflight 读取 incoming 数据库，不能读活动库');
await assert.rejects(gateway.validateStableSettingsJson(stable, 'file:///skins', 'file:///missing', 'file:///incoming.db'), /文件缺失或大小不符/);
// 壁纸采用相同资产提交链路，覆盖多选择共享、事务失败与删除后晚到选图。
const { SQLiteWallpaperRepository } = load('src/features/profile/infrastructure/SQLiteWallpaperRepository.ts', { '@platform/persistence': { databaseCoordinator: coordinator } });
const wallpaperRepository = new SQLiteWallpaperRepository();
const legacyState = { appWallpaper: { mode: 'custom', uri: 'file:///old/cache/background.jpg' }, chatWallpaper: { mode: 'custom', uri: 'file:///old/cache/background.jpg' }, chatWallpaperOverrides: { 'single:a': { mode: 'custom', uri: 'file:///old/cache/background.jpg' } } };
db.exec("INSERT INTO chat_conversations VALUES ('a', 'direct'), ('b', 'group')");
const wallpapers = load('src/features/profile/application/WallpaperSettings.ts', {
  ...sharedMocks,
  './legacyWallpaperSettings': { loadStoredWallpaperStateStrict: async () => legacyState },
});
wallpapers.configureWallpaperRuntime(wallpaperRepository);
await Promise.all([wallpapers.ensureWallpaperSelections(), wallpapers.ensureWallpaperSelections()]);
let rows = await wallpaperRepository.list();
assert.equal(new Set(rows.map((row) => row.mediaAssetId)).size, 1, '旧同图只提交一次资产');
assert.ok(rows.every((row) => row.legacyUri === null));
const sharedBackground = rows[0].mediaAssetId;
await wallpapers.setGlobalWallpaper('app', null);
assert.ok(await catalogRepository.getById(sharedBackground), '清除全局背景不会删除聊天仍使用的图片');
await wallpapers.setGlobalWallpaper('chat', null, ['single:a']);
assert.equal(await catalogRepository.getById(sharedBackground), null, '最后一个引用清除后释放');
await wallpapers.setGlobalWallpaper('chat', 'file:///picker/new.jpg', ['single:a', 'group:b']);
const projected = await wallpapers.loadWallpaperState();
assert.equal(projected.chatWallpaper.uri, projected.chatWallpaperOverrides['single:a'].uri);
await wallpapers.setConversationWallpaper('single:a', null);
assert.ok((await wallpapers.loadWallpaperState()).chatWallpaperOverrides['group:b']);
assert.equal((await wallpapers.loadWallpaperState()).chatWallpaperOverrides['single:a'], undefined);
preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
const late = wallpapers.setConversationWallpaper('single:a', 'file:///picker/new.jpg');
await new Promise((resolve) => setImmediate(resolve));
await transaction(async (tx) => {
  await wallpapers.removeConversationWallpaperInTransaction(tx, 'single:a');
  await tx.runAsync("DELETE FROM chat_conversations WHERE id = 'a'");
});
releasePreparation();
await assert.rejects(late, /对话已删除/);
preparationGate = null;
assert.equal((await wallpaperRepository.list()).some((row) => row.key === 'single:a'), false);
assert.equal([...files].some((uri) => uri.startsWith('file:///draft/')), false);
// 迁移缺失文件时保留旧选择，明确清除后可以继续备份。
db.exec("UPDATE profile_wallpaper_selections SET media_asset_id=NULL, legacy_uri='file:///missing.jpg' WHERE selection_key='app'");
await assert.rejects(wallpapers.ensureWallpaperSelections(), /旧背景文件丢失/);
assert.equal((await wallpaperRepository.list()).find((row) => row.key === 'app').legacyUri, 'file:///missing.jpg');
assert.equal((await wallpapers.loadWallpaperState()).appWallpaper.mode, 'custom', '迁移失败仍展示已选状态，保留清除入口');
await wallpapers.setGlobalWallpaper('app', null);
await wallpapers.ensureWallpaperSelections();
assert.ok((await catalogRepository.listBackupAssets(executor)).length >= 1);

// Profile 封面保留旧文件失败状态，资产与资料选择原子提交，清除不依赖旧文件。
db.exec("ALTER TABLE user_profile ADD COLUMN moments_cover TEXT; ALTER TABLE user_profile ADD COLUMN moments_cover_revision INTEGER NOT NULL DEFAULT 0; ALTER TABLE user_profile ADD COLUMN name TEXT; ALTER TABLE user_profile ADD COLUMN updated_at TEXT;");
const profileDomain = load('src/features/profile/domain/UserProfile.ts', { '@shared': { SELF_USER_ID: 'self', DEFAULT_SELF_NAME: 'user' } });
const { SQLiteUserProfileRepository } = load('src/features/profile/infrastructure/SQLiteUserProfileRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { ...coordinator, openTaskExecutor: () => executor } },
  '@features/media': { resolveMediaAssetReferenceUri: async ({ mediaAssetId, legacyUri }) => mediaAssetId ? `asset://${mediaAssetId}` : legacyUri },
  '../domain/UserProfile': profileDomain,
});
const profileRepository = new SQLiteUserProfileRepository();
const covers = load('src/features/profile/application/MomentsCoverSettings.ts', sharedMocks);
db.prepare('UPDATE user_profile SET moments_cover = ? WHERE id = ?').run('file:///missing-cover.jpg', 'self');
await assert.rejects(covers.ensureMomentsCoverSelection(profileRepository), /旧背景文件丢失/);
assert.equal((await profileRepository.getMomentsCoverSelection()).legacyUri, 'file:///missing-cover.jpg');
const publicProfile = load('src/features/profile/composition.ts', {
  ...sharedMocks,
  './domain/UserProfile': profileDomain,
  './infrastructure/SQLiteUserProfileRepository': { userProfileRepository: profileRepository },
  './application/MomentsCoverSettings': covers,
  './application/WallpaperSettings': {},
  './infrastructure/SQLiteWallpaperRepository': {},
});
assert.equal((await publicProfile.getCurrentUserProfile()).momentsCover, 'file:///missing-cover.jpg', '迁移失败仍保留清除入口所需的已选状态');
await covers.setMomentsCover(profileRepository, null);
await covers.ensureMomentsCoverSelection(profileRepository);
db.prepare('UPDATE user_profile SET moments_cover = ? WHERE id = ?').run('file:///old/cache/background.jpg', 'self');
await Promise.all([covers.ensureMomentsCoverSelection(profileRepository), covers.ensureMomentsCoverSelection(profileRepository)]);
const cover = await profileRepository.getMomentsCoverSelection();
assert.equal(cover.legacyUri, null);
assert.ok(cover.mediaAssetId);
assert.equal((await profileRepository.get()).momentsCover, `asset://${cover.mediaAssetId}`);
assert.ok((await catalogRepository.listBackupAssets(executor)).some((asset) => asset.id === cover.mediaAssetId));
// 头像仍引用相同资产时，清除封面只能去掉自己的引用。
db.prepare('UPDATE user_profile SET avatar_media_asset_id = ? WHERE id = ?').run(cover.mediaAssetId, 'self');
await covers.setMomentsCover(profileRepository, null);
assert.ok(await catalogRepository.getById(cover.mediaAssetId));
preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
const lateCover = covers.setMomentsCover(profileRepository, 'file:///picker/new.jpg');
await new Promise((resolve) => setImmediate(resolve));
await covers.setMomentsCover(profileRepository, null);
releasePreparation();
await assert.rejects(lateCover, /其他操作更改/);
preparationGate = null;
assert.equal((await profileRepository.getMomentsCoverSelection()).mediaAssetId, null);
assert.equal([...files].some((uri) => uri.startsWith('file:///draft/')), false);

// 明确清除旧缓存引用不读取失效图片，不改动已保存的资产或长期图片引用。
await feature.setCustomCallBackground({ assistantId: 'a', sourceUri: 'file:///picker/new.jpg' });
const keptCall = await repository.get('a');
db.exec(`
  DELETE FROM call_background_selection WHERE id = 'b';
  CREATE TABLE call_background_legacy_migration (assistant_id TEXT PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE);
  INSERT INTO call_background_legacy_migration VALUES ('a'), ('b');
`);
settings.set(legacyKey, pickerCache);
assert.equal(await feature.clearLegacyCachedCallBackground(), true);
assert.deepEqual(await repository.get('a'), keptCall, '清缓存不能覆盖角色已经改选的资产');
assert.equal((await repository.get('b')).mediaAssetId, null, '尚未改选的旧角色恢复默认');
assert.equal(settings.has(legacyKey), false);
assert.equal(await feature.clearLegacyCachedCallBackground(), false, '重复清除不再修改选择');
assert.ok(await feature.loadCallBackgroundUri('a'));
db.exec("CREATE TABLE call_background_legacy_migration (assistant_id TEXT PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE); INSERT INTO call_background_legacy_migration VALUES ('a');");
settings.set(legacyKey, 'file:///old/cache/background.jpg');
assert.equal(await feature.clearLegacyCachedCallBackground(), false, '非应用私有缓存的来源保持原样');
assert.equal(settings.get(legacyKey), 'file:///old/cache/background.jpg');
await feature.ensureCallBackgroundMigration();

const keptWallpapers = (await wallpaperRepository.list()).filter((row) => row.key !== 'app' && row.key !== 'chat');
const readableCache = 'file:///data/user/0/com.skylucky.kimiphone/cache/ImagePicker/readable.jpg';
files.add(readableCache);
db.prepare("UPDATE profile_wallpaper_selections SET media_asset_id=NULL, legacy_uri=?, revision=revision+1 WHERE selection_key='app'").run(pickerCache);
db.prepare("UPDATE profile_wallpaper_selections SET media_asset_id=NULL, legacy_uri=?, revision=revision+1 WHERE selection_key='chat'").run(readableCache);
assert.equal(await wallpapers.clearLegacyCachedWallpapers(), 2, '明确清除包含缓存中仍可读的旧选择');
assert.ok((await wallpaperRepository.list()).filter((row) => row.key === 'app' || row.key === 'chat').every((row) => row.legacyUri === null && row.mediaAssetId === null));
assert.deepEqual((await wallpaperRepository.list()).filter((row) => row.key !== 'app' && row.key !== 'chat'), keptWallpapers);
assert.equal(await wallpapers.clearLegacyCachedWallpapers(), 0);
assert.ok(files.has(readableCache), '只清除选择，不删除缓存文件');
assert.equal((await wallpapers.loadWallpaperState()).appWallpaper.mode, 'default', '旧设置不能重新复活已清除的选择');
db.prepare("UPDATE profile_wallpaper_selections SET legacy_uri=? WHERE selection_key='app'").run('file:///old/cache/background.jpg');
assert.equal(await wallpapers.clearLegacyCachedWallpapers(), 0, '长期来源不属于清缓存范围');

// 多项清除中有并发改选时，CAS 拒绝覆盖新选择，整个壁纸事务回滚。
db.prepare("UPDATE profile_wallpaper_selections SET legacy_uri=? WHERE selection_key IN ('app','chat')").run(pickerCache);
wallpapers.configureWallpaperRuntime({
  ...wallpaperRepository,
  async list() {
    const before = await wallpaperRepository.list();
    db.exec("UPDATE profile_wallpaper_selections SET legacy_uri=NULL, revision=revision+1 WHERE selection_key='chat'");
    return before;
  },
  commit: wallpaperRepository.commit.bind(wallpaperRepository),
});
await assert.rejects(wallpapers.clearLegacyCachedWallpapers(), /其他操作更改/);
assert.equal((await wallpaperRepository.list()).find((row) => row.key === 'app').legacyUri, pickerCache, '失败不留下半清除的壁纸');
assert.equal((await wallpaperRepository.list()).find((row) => row.key === 'chat').legacyUri, null);
wallpapers.configureWallpaperRuntime(wallpaperRepository);
await wallpapers.clearLegacyCachedWallpapers();

db.prepare('UPDATE user_profile SET moments_cover=?, moments_cover_media_asset_id=NULL, moments_cover_revision=moments_cover_revision+1 WHERE id=?').run(pickerCache, 'self');
assert.equal(await covers.clearLegacyCachedMomentsCover(profileRepository), true);
assert.equal((await profileRepository.getMomentsCoverSelection()).legacyUri, null);
assert.equal(await covers.clearLegacyCachedMomentsCover(profileRepository), false);
await covers.setMomentsCover(profileRepository, 'file:///picker/new.jpg');
const keptCover = await profileRepository.getMomentsCoverSelection();
assert.equal(await covers.clearLegacyCachedMomentsCover(profileRepository), false);
assert.deepEqual(await profileRepository.getMomentsCoverSelection(), keptCover, '资产封面不受影响');
db.prepare('UPDATE user_profile SET moments_cover=?, moments_cover_media_asset_id=NULL WHERE id=?').run('file:///old/cache/background.jpg', 'self');
assert.equal(await covers.clearLegacyCachedMomentsCover(profileRepository), false);

db.close();

// 真实备份页修复入口需要明确确认，完成后刷新显示并报告结果，不自动创建备份。
const dialogs = [];
let clears = 0;
let refreshes = 0;
let clearResult = { callBackground: true, wallpapers: 2, momentsCover: false };
let clearError = null;
const jsx = (type, props) => ({ type, props });
const { BackupScreen } = load('src/features/backup/presentation/BackupScreen.tsx', {
  '@shared/ui': { showAppDialog: (dialog) => dialogs.push(dialog) },
  react: { useCallback: (fn) => fn, useEffect() {}, useMemo: (fn) => fn(), useState: (value) => [value, () => {}] },
  'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
  'react-native': Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'View'].map((name) => [name, name])),
  'lucide-react-native': Object.fromEntries(['FolderOpen', 'HardDriveDownload', 'Archive', 'Trash2'].map((name) => [name, name])),
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': {
    ThemedSurface: 'ThemedSurface',
    useTheme: () => ({ colors: { brand: { primary: 'blue' }, text: { secondary: 'grey' } } }),
    useWallpaper: () => ({ refreshWallpapers: async () => { refreshes++; } }),
  },
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader' },
  '../application/BackupTargetCatalog': { BACKUP_TARGET_CATALOG: [{ title: '本地', description: '下载' }] },
  './BackupRestoreModal': { BackupRestoreModal: 'BackupRestoreModal' },
  './BackupScreen.styles': { createBackupScreenStyles: () => ({}) },
});
const backupPage = BackupScreen({
  onBack() {},
  runtime: {
    async clearLegacyCachedImageSelections() {
      clears++;
      if (clearError) throw clearError;
      return clearResult;
    },
    createLocalBackup() { assert.fail('清除操作不应自动创建备份'); },
  },
});
function findRepairButton(node) {
  if (Array.isArray(node)) return node.map(findRepairButton).find(Boolean);
  if (!node || typeof node !== 'object') return null;
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  if (node.type === 'Pressable' && children.some((child) => child?.type === 'Text' && child.props.children === '清除旧缓存图片选择')) return node;
  return findRepairButton(node.props.children);
}
const repairButton = findRepairButton(backupPage);
assert.ok(repairButton, '备份页有可发现的修复入口');
repairButton.props.onPress();
assert.equal(clears, 0, '打开确认弹窗不能清除选择');
assert.ok(dialogs.at(-1).buttons.some((button) => button.text === '取消'));
await dialogs.at(-1).buttons.find((button) => button.text === '清除选择').onPress();
assert.equal(clears, 1);
assert.equal(refreshes, 1);
assert.match(dialogs.at(-1).message, /壁纸：清除 2 项/);
clearResult = { callBackground: false, wallpapers: 0, momentsCover: false };
repairButton.props.onPress();
await dialogs.at(-1).buttons.find((button) => button.text === '清除选择').onPress();
assert.equal(dialogs.at(-1).title, '没有旧缓存图片选择');
clearError = new Error('背景选择已被其他操作更改');
repairButton.props.onPress();
await dialogs.at(-1).buttons.find((button) => button.text === '清除选择').onPress();
assert.equal(dialogs.at(-1).title, '清除未全部完成');
assert.match(dialogs.at(-1).message, /背景选择已被其他操作更改/);

console.log('PASS 通话、壁纸与封面资产：迁移、CAS、共享引用、staging 与旧缓存修复确认');
