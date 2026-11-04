/**
 * MediaAsset M5 closure：真实 SQLite 引用枚举、共享删除、orphan、targeted release 与外部源边界。
 *
 * 重点覆盖三类此前只有静态保护的不变量：
 * - canonical backing 的 in-flight reservation 必须早于文件对目录枚举可见；
 * - stale 物理快照在真正删除前必须重新裁决（in-flight / catalog 接管）；
 * - dangling reference 存在时 destructive physical cleanup 必须 fail-closed。
 */
import assert from 'node:assert/strict';
import { SCHEMAS } from './helpers/sqlite-bootstrap-fixture.mjs';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const ROOT = process.cwd();

async function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function loadTypeScriptModuleWithMocks(relativePath, mocks) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === './MediaFileLifetime') return loadTypeScriptModuleWithMocks('src/platform/device/MediaFileLifetime.ts', {});
    if (specifier === './ChatAttachmentMime') return loadTypeScriptModuleWithMocks('src/features/chat/messages/application/ChatAttachmentMime.ts', {});
    assert.ok(Object.hasOwn(mocks, specifier), `未声明的运行时依赖：${specifier}`);
    return mocks[specifier];
  };
  new Function('exports', 'require', 'module', output)(module.exports, requireMock, module);
  return module.exports;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const { MEDIA_ASSET_SCHEMA, MEDIA_ASSET_CONTENT_HASH_INDEX } = await loadTypeScriptModule(
  'src/platform/persistence/sqlite/mediaAssetSchema.ts',
);
const { CALL_BACKGROUND_SELECTION_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/callBackgroundSchema.ts');
const { CHAT_BUBBLE_SKINS_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/chatBubbleSkinSchema.ts');
const { CALL_RINGTONE_SELECTION_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/callRingtoneSchema.ts');
const { CALL_HISTORY_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/callHistorySchema.ts');
const { CHAT_FAVORITES_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/chatFavoriteSchema.ts');
const { CHAT_REPLY_VERSIONS_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/chatReplyVersionSchema.ts');
const mediaAssetBackingModule = await loadTypeScriptModule(
  'src/features/media/application/MediaAssetBacking.ts',
);
const { MediaAssetBackingRegistry } = mediaAssetBackingModule;
const { MediaAssetCatalog } = loadTypeScriptModuleWithMocks(
  'src/features/media/application/MediaAssetCatalog.ts',
  { './MediaAssetBacking': mediaAssetBackingModule },
);
const { CreateMediaAsset } = await loadTypeScriptModule(
  'src/features/media/application/CreateMediaAsset.ts',
);
const { MediaAssetLifecycle } = loadTypeScriptModuleWithMocks(
  'src/features/media/application/MediaAssetLifecycle.ts',
  { './MediaAssetBacking': mediaAssetBackingModule },
);
const { SQLiteMediaAssetRepository } = await loadTypeScriptModule(
  'src/features/media/infrastructure/SQLiteMediaAssetRepository.ts',
);
const { hasReportableLegacyMediaMigrationOutcome } = await loadTypeScriptModule(
  'src/host/media/LegacyMediaMigrationReporting.ts',
);

assert.equal(hasReportableLegacyMediaMigrationOutcome(0, 0), false);
assert.equal(hasReportableLegacyMediaMigrationOutcome(1, 0), true);
assert.equal(hasReportableLegacyMediaMigrationOutcome(0, 1), true);

function executorFor(db) {
  const executor = {
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    execAsync: async (sql) => db.exec(sql),
    async withExclusiveTransactionAsync(task) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const value = await task(executor);
        db.exec('COMMIT;');
        return value;
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
  };
  return executor;
}

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MEDIA_ASSET_SCHEMA);
  db.exec(SCHEMAS.assistantProfileCovers);
  db.exec(CHAT_BUBBLE_SKINS_SCHEMA);
  db.exec(CHAT_FAVORITES_SCHEMA);
  db.exec(CHAT_REPLY_VERSIONS_SCHEMA);
  db.exec('PRAGMA user_version = 137;');
  db.exec(MEDIA_ASSET_CONTENT_HASH_INDEX);
  db.exec(`
    CREATE TABLE profile_wallpaper_selections (selection_key TEXT PRIMARY KEY, media_asset_id TEXT, legacy_uri TEXT, revision INTEGER);
    ${CALL_BACKGROUND_SELECTION_SCHEMA}
    ${CALL_RINGTONE_SELECTION_SCHEMA}
    CREATE TABLE user_profile (id TEXT PRIMARY KEY, avatar_media_asset_id TEXT, moments_cover_media_asset_id TEXT);
    CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, avatar_media_asset_id TEXT, moments_cover_media_asset_id TEXT);
    CREATE TABLE group_chats (id TEXT PRIMARY KEY, avatar_media_asset_id TEXT, moments_cover_media_asset_id TEXT);
    CREATE TABLE moments (id TEXT PRIMARY KEY);
    CREATE TABLE moment_media (
      id TEXT PRIMARY KEY,
      moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
      media_asset_id TEXT NOT NULL REFERENCES media_assets(id)
    );
    CREATE TABLE stickers (
      id TEXT PRIMARY KEY,
      media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
      owner_assistant_id TEXT
    );
    CREATE TABLE ai_downloaded_images (id TEXT PRIMARY KEY, assistant_id TEXT, media_asset_id TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, metadata_json TEXT);
    CREATE TABLE call_sessions (id TEXT PRIMARY KEY, chat_session_id TEXT);
    ${CALL_HISTORY_SCHEMA}
  `);
  return db;
}

/**
 * 行为等价于生产 backing 的 fake writer。
 *
 * prepare 的顺序与真实实现一致：先 reserve canonical key，文件才对目录枚举可见。
 * 真实顺序本身由下面的「真实 backing」用例单独验证。
 */
function createWriter() {
  const canonicalKeys = new Set();
  const deletedKeys = [];
  const preparedSources = [];
  const failingKeys = new Set();
  const inFlightKeys = new Set();
  const writer = {
    storageBackend: 'persistent-media',
    canonicalKeys,
    deletedKeys,
    preparedSources,
    failingKeys,
    inFlightKeys,
    async prepare(input) {
      preparedSources.push(input.sourceUri);
      const storageKey = `catalog/media/${input.assetId}.bin`;
      inFlightKeys.add(storageKey);
      canonicalKeys.add(storageKey);
      return { storageBackend: this.storageBackend, storageKey, localUri: `file:///${storageKey}` };
    },
    async resolve(storageKey) {
      return { localUri: `file:///${storageKey}` };
    },
    commitPrepared(storageKey) {
      inFlightKeys.delete(storageKey);
    },
    isStorageKeyInFlight(storageKey) {
      return inFlightKeys.has(storageKey);
    },
    async delete(storageKey) {
      deletedKeys.push(storageKey);
      try {
        if (failingKeys.has(storageKey)) throw new Error(`delete failed: ${storageKey}`);
        canonicalKeys.delete(storageKey);
      } finally {
        inFlightKeys.delete(storageKey);
      }
    },
    ownsStorageKeyLifecycle(storageKey) {
      return storageKey.startsWith('catalog/media/');
    },
    async listCanonicalStorageKeys() {
      return [...canonicalKeys]
        .filter((key) => key.startsWith('catalog/media/') && !inFlightKeys.has(key))
        .sort();
    },
  };
  return writer;
}

function insertAsset(db, id, storageKey = `catalog/media/${id}.bin`, backend = 'persistent-media') {
  db.prepare(`INSERT INTO media_assets (
    id, storage_backend, storage_key, hash_algorithm, content_hash, mime_type,
    byte_size, width, height, duration_ms, status, created_at, updated_at
  ) VALUES (?, ?, ?, 'sha256', ?, 'image/png', 3, 1, 1, NULL, 'ready', ?, ?)`).run(
    id,
    backend,
    storageKey,
    id.padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
    '2026-09-22T00:00:00.000Z',
    '2026-09-22T00:00:00.000Z',
  );
}

function insertMessage(db, id, sessionId, metadata) {
  db.prepare('INSERT INTO messages (id, session_id, metadata_json) VALUES (?, ?, ?)')
    .run(id, sessionId, metadata);
}

function createHarness() {
  const db = createDatabase();
  const database = executorFor(db);
  const writer = createWriter();
  const backings = new MediaAssetBackingRegistry({ writers: [writer] });
  const repository = new SQLiteMediaAssetRepository(database);
  const lifecycle = new MediaAssetLifecycle(repository, backings, database);
  return { db, database, writer, backings, repository, lifecycle };
}

// 皮肤是独立业务引用：没有聊天消息、没有选中主题，也必须被两条清理路径保留。
{
  const { db, database, writer, repository, lifecycle } = createHarness();
  insertAsset(db, 'bubble-only');
  writer.canonicalKeys.add('catalog/media/bubble-only.bin');
  for (const id of ['first', 'second']) {
    db.prepare("INSERT INTO chat_bubble_presets VALUES (?, 'user', ?, 1, ?, 12, 12, ?)")
      .run(id, id, 'bubble-only', JSON.stringify({ slices: { left: 3, top: 3, right: 3, bottom: 3 },
        padding: { left: 14, top: 10, right: 14, bottom: 10 }, scale: 1 }));
  }
  assert.equal((await lifecycle.audit()).references.filter(ref => ref.kind === 'chat_bubble_skin').length, 2);
  assert.deepEqual((await lifecycle.cleanup()).deletedAssets, []);
  assert.deepEqual((await lifecycle.releaseCandidates(['bubble-only'])).releasedAssets, []);
  db.exec('PRAGMA user_version = 154;');
  assert.deepEqual((await repository.listBackupAssets(database)).map(asset => asset.id), ['bubble-only'],
    '仅被皮肤引用的 PNG 必须进入备份媒体清单');
  insertAsset(db, 'decoration-only');
  writer.canonicalKeys.add('catalog/media/decoration-only.bin');
  db.prepare('INSERT INTO chat_bubble_preset_decorations VALUES (?, ?, 3, ?, 24, 12, ?)')
    .run('logo', 'first', 'decoration-only', JSON.stringify({ anchor: 'bottom-left', size: 64, offsetX: 0, offsetY: 0 }));
  assert.equal((await lifecycle.audit()).references.some(ref => ref.kind === 'chat_bubble_decoration'), true);
  assert.deepEqual((await lifecycle.cleanup()).deletedAssets, []);
  assert.deepEqual((await lifecycle.releaseCandidates(['decoration-only'])).releasedAssets, []);
  assert.deepEqual((await repository.listBackupAssets(database)).map(asset => asset.id).sort(), ['bubble-only', 'decoration-only']);
  db.exec("DELETE FROM chat_bubble_presets WHERE id = 'first'");
  assert.equal((await lifecycle.releaseCandidates(['decoration-only'])).releasedAssets[0].id, 'decoration-only', '级联删除后才可清理独立装饰');
  assert.deepEqual((await lifecycle.releaseCandidates(['bubble-only'])).releasedAssets, []);
  db.exec("DELETE FROM chat_bubble_presets WHERE id = 'second'");
  assert.equal((await lifecycle.releaseCandidates(['bubble-only'])).releasedAssets[0].id, 'bubble-only');
  assert.deepEqual(writer.deletedKeys, ['catalog/media/decoration-only.bin', 'catalog/media/bubble-only.bin']);
}

// 数据库 ready 不代表物理文件存在；显式维护将缺失状态写回，保留仍有业务引用的身份。
// 只存在于回复历史里的媒体仍是 live 引用，进入备份和会话级联删除候选。
{
  const { db, database, repository } = createHarness();
  db.exec(`CREATE TABLE chat_conversations(id TEXT PRIMARY KEY);
    CREATE TABLE conversation_turn_runs(run_id TEXT PRIMARY KEY);
    INSERT INTO chat_conversations VALUES ('version-session');
    INSERT INTO conversation_turn_runs VALUES ('version-run');`);
  insertAsset(db, 'archived-audio');
  db.prepare(`INSERT INTO chat_reply_version_sets(id, session_id, current_run_id, selected_version_id)
    VALUES ('versions', 'version-session', 'version-run', 'original')`).run();
  db.prepare(`INSERT INTO chat_reply_versions VALUES ('original', 'versions', '2026-10-20', ?)`).run(
    JSON.stringify([{ metadata: { voice: { mediaAssetId: 'archived-audio' } } }]),
  );
  assert.deepEqual((await repository.listBackupAssets(database)).map(asset => asset.id), ['archived-audio']);
  assert.deepEqual(await repository.listChatSessionMediaAssetIds(['version-session'], database), ['archived-audio']);
  assert.deepEqual(await repository.releaseUnreferencedAssetsInTransaction(database, ['archived-audio']), []);
  db.prepare("DELETE FROM chat_reply_version_sets WHERE id = 'versions'").run();
  assert.deepEqual((await repository.releaseUnreferencedAssetsInTransaction(database, ['archived-audio'])).map(asset => asset.id), ['archived-audio']);
  db.exec('DROP TABLE chat_reply_versions; DROP TABLE chat_reply_version_sets; PRAGMA user_version = 136;');
  assert.deepEqual(await repository.listBackupAssets(database), [], '旧备份的媒体预检不要求尚未迁移的版本表');
  db.close();
}

{
  const { db, writer, lifecycle } = createHarness();
  insertAsset(db, 'lost-backing');
  db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, ?)').run('self', 'lost-backing');
  const key = 'catalog/media/lost-backing.bin';
  writer.resolve = async (storageKey) => {
    if (storageKey === key) throw new mediaAssetBackingModule.MediaAssetBackingNotFoundError('persistent-media', storageKey);
    return { localUri: `file:///${storageKey}` };
  };
  assert.equal((await lifecycle.audit()).unavailableAssets[0].id, 'lost-backing');
  await lifecycle.cleanup();
  assert.equal(db.prepare('SELECT status FROM media_assets WHERE id = ?').get('lost-backing').status, 'missing');
  assert.equal(db.prepare('SELECT avatar_media_asset_id FROM user_profile').get().avatar_media_asset_id, 'lost-backing');
  db.close();
}

/**
 * 真实 store + 真实 backing 的 harness：copyAsync 可以被闸门挂住，
 * 用来精确构造「canonical 文件已经产生、prepare promise 还没返回」的窗口。
 */
async function createRealBackingHarness() {
  const virtualFiles = new Set();
  const virtualDirectories = new Set();
  const deletedUris = [];
  let copyGate = null;
  let copyStartedHook = null;

  const fileSystem = {
    documentDirectory: 'file:///documents/',
    async getInfoAsync(uri) {
      return {
        exists: virtualDirectories.has(uri) || virtualFiles.has(uri),
        isDirectory: virtualDirectories.has(uri),
        uri,
      };
    },
    async makeDirectoryAsync(uri) {
      virtualDirectories.add(uri);
    },
    async readDirectoryAsync(uri) {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      return [...virtualFiles]
        .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
        .map((file) => file.slice(prefix.length));
    },
    async copyAsync({ to }) {
      virtualFiles.add(to);
      if (copyStartedHook) {
        const hook = copyStartedHook;
        copyStartedHook = null;
        hook();
      }
      if (copyGate) {
        await copyGate.promise;
      }
    },
    async deleteAsync(uri) {
      deletedUris.push(uri);
      virtualFiles.delete(uri);
    },
  };

  const { PersistentMediaStore } = loadTypeScriptModuleWithMocks(
    'src/platform/device/PersistentMediaStore.ts',
    { 'expo-file-system/legacy': fileSystem },
  );
  const { PersistentMediaAssetBacking } = loadTypeScriptModuleWithMocks(
    'src/features/media/infrastructure/PersistentMediaAssetBackings.ts',
    { '../application/MediaAssetBacking': mediaAssetBackingModule },
  );

  const db = createDatabase();
  const database = executorFor(db);
  const backing = new PersistentMediaAssetBacking(new PersistentMediaStore());
  const backings = new MediaAssetBackingRegistry({ writers: [backing] });
  const repository = new SQLiteMediaAssetRepository(database);
  const lifecycle = new MediaAssetLifecycle(repository, backings, database);

  return {
    db,
    backing,
    lifecycle,
    virtualFiles,
    deletedUris,
    setCopyGate(gate) {
      copyGate = gate;
    },
    onNextCopyStart() {
      return new Promise((resolve) => {
        copyStartedHook = resolve;
      });
    },
  };
}

const CANONICAL_MEDIA_ROOT = 'file:///documents/persistent-media/catalog/media/';

// ============================================================================
// 全量 live reference graph：三类头像、Moment、Sticker 与四类 Chat metadata。
// ============================================================================
{
  const { db, lifecycle } = createHarness();
  insertAsset(db, 'reference-graph');
  db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, ?)')
    .run('self', 'reference-graph');
  db.prepare('INSERT INTO ai_assistants (id, avatar_media_asset_id) VALUES (?, ?)')
    .run('ai-1', 'reference-graph');
  db.prepare('INSERT INTO group_chats (id, avatar_media_asset_id) VALUES (?, ?)')
    .run('group-1', 'reference-graph');
  db.prepare('INSERT INTO moments (id) VALUES (?)').run('moment-1');
  db.prepare('INSERT INTO moment_media (id, moment_id, media_asset_id) VALUES (?, ?, ?)')
    .run('moment-media-1', 'moment-1', 'reference-graph');
  db.prepare('INSERT INTO stickers (id, media_asset_id) VALUES (?, ?)')
    .run('sticker-1', 'reference-graph');
  insertMessage(db, 1, 'session-1', JSON.stringify({
    attachments: [{
      mediaAssetId: 'reference-graph',
      thumbnailMediaAssetId: 'reference-graph',
    }],
    voice: { mediaAssetId: 'reference-graph' },
    sticker: { mediaAssetId: 'reference-graph' },
  }));

  assert.deepEqual(
    (await lifecycle.audit()).references.map((reference) => reference.kind).sort(),
    [
      'assistant_avatar',
      'chat_attachment',
      'chat_sticker',
      'chat_thumbnail',
      'chat_voice',
      'group_avatar',
      'moment_media',
      'sticker',
      'user_avatar',
    ],
  );
}

// ============================================================================
// 已登记 legacy 文件仍可能被裸 URI consumer 使用；catalog orphan 可删，但物理文件保留。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  const key = 'chat/images/legacy-shared.jpg';
  insertAsset(db, 'legacy-row', key);
  writer.canonicalKeys.add(key);
  const result = await lifecycle.cleanup();
  assert.deepEqual(result.deletedAssets.map((item) => item.id), ['legacy-row']);
  assert.deepEqual(result.retainedUnmanagedFiles, [{
    storageBackend: 'persistent-media',
    storageKey: key,
  }]);
  assert.equal(writer.deletedKeys.includes(key), false);
}

// ============================================================================
// 事务外 prepare 到事务提交之间属于 in-flight；显式 cleanup 不得把它当 file orphan。
// ============================================================================
{
  const { writer, lifecycle } = createHarness();
  const prepared = await writer.prepare({
    assetId: 'in-flight',
    sourceUri: 'content://gallery/in-flight',
  });
  assert.equal(writer.isStorageKeyInFlight(prepared.storageKey), true, 'prepare 返回后必须仍在 in-flight');
  assert.equal((await lifecycle.audit()).physicalOrphans.length, 0);
  assert.equal((await lifecycle.cleanup()).deletedPhysicalOrphans.length, 0);
  assert.ok(writer.canonicalKeys.has(prepared.storageKey));
  await writer.delete(prepared.storageKey);
}

// ============================================================================
// B1：真实 backing/store 的顺序 —— copy 已经产生 canonical 文件、prepare 还没返回时，
// 该文件必须已经在 in-flight reservation 里，audit / cleanup 都不得删除它。
// ============================================================================
{
  const harness = await createRealBackingHarness();
  const gate = createDeferred();
  harness.setCopyGate(gate);
  const copyStarted = harness.onNextCopyStart();

  const preparePromise = harness.backing.prepare({
    assetId: 'race-asset',
    sourceUri: 'content://gallery/race',
    fileName: 'race.png',
  });
  await copyStarted;

  const canonicalUri = `${CANONICAL_MEDIA_ROOT}race-asset.png`;
  assert.equal(
    harness.virtualFiles.has(canonicalUri),
    true,
    'fixture：copy 必须已经产生 canonical 文件',
  );
  assert.equal(
    await harness.backing.isStorageKeyInFlight('catalog/media/race-asset.png'),
    true,
    'canonical 文件可见之前 key 必须已经 reserve',
  );

  const audit = await harness.lifecycle.audit();
  assert.deepEqual(
    audit.physicalOrphans,
    [],
    'prepare 未返回时文件不得进入 physical orphan 快照',
  );
  const cleanup = await harness.lifecycle.cleanup();
  assert.deepEqual(cleanup.deletedPhysicalOrphans, []);
  assert.equal(harness.virtualFiles.has(canonicalUri), true, 'in-flight backing 不得被删除');

  gate.resolve();
  const prepared = await preparePromise;
  assert.equal(prepared.storageKey, 'catalog/media/race-asset.png');
  harness.backing.commitPrepared(prepared.storageKey);
  assert.equal(
    await harness.backing.isStorageKeyInFlight(prepared.storageKey),
    false,
    'catalog 提交后必须解除 in-flight',
  );
}

// ============================================================================
// B1：prepare 失败（store 补偿删除也失败）后必须解除 in-flight，残留文件才能被下一次 audit 看见。
// ============================================================================
{
  const { writer, lifecycle } = createHarness();
  const prepared = await writer.prepare({
    assetId: 'failed-compensation',
    sourceUri: 'content://gallery/failed-compensation',
  });
  writer.failingKeys.add(prepared.storageKey);
  await assert.rejects(() => writer.delete(prepared.storageKey), /delete failed/);
  assert.equal(writer.isStorageKeyInFlight(prepared.storageKey), false);
  assert.deepEqual((await lifecycle.audit()).physicalOrphans.map((item) => item.storageKey), [
    prepared.storageKey,
  ]);
}

// ============================================================================
// B1 第二层：audit 快照之后有 prepare reserve 了同一个 key（catalog 行还没提交）：
// 真正删除前必须重新裁决，保留文件。
// ============================================================================
{
  const { writer, lifecycle } = createHarness();
  const storageKey = 'catalog/media/late-reserve.bin';
  writer.canonicalKeys.add(storageKey);

  const snapshot = writer.listCanonicalStorageKeys.bind(writer);
  let injected = false;
  writer.listCanonicalStorageKeys = async () => {
    const keys = await snapshot();
    if (!injected) {
      injected = true;
      // 快照返回之后、删除之前，另一个 prepare reserve 了这个 key。
      writer.inFlightKeys.add(storageKey);
    }
    return keys;
  };

  const result = await lifecycle.cleanup();
  assert.deepEqual(
    result.blockedPhysicalOrphans.map((orphan) => orphan.storageKey),
    [storageKey],
    '快照之后变成 in-flight 的候选必须被拦下并报告',
  );
  assert.equal(
    writer.canonicalKeys.has(storageKey),
    true,
    'stale 快照不得删除窗口内被 prepare 接管的 backing',
  );
}

// ============================================================================
// B1 第二层：audit 快照之后有 asset 提交并接管了同一个 locator：删除前必须重新裁决。
// ============================================================================
{
  const { db, repository, writer, lifecycle } = createHarness();
  const storageKey = 'catalog/media/late-live.bin';
  writer.canonicalKeys.add(storageKey);

  const originalHasAssetAtLocator = repository.hasAssetAtLocator.bind(repository);
  let injected = false;
  repository.hasAssetAtLocator = async (locator) => {
    if (!injected) {
      injected = true;
      // 模拟：快照之后另一个事务提交了 asset 行与业务引用。
      insertAsset(db, 'late-live', storageKey);
      db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, ?)')
        .run('self', 'late-live');
    }
    return originalHasAssetAtLocator(locator);
  };

  const result = await lifecycle.cleanup();
  assert.deepEqual(
    result.blockedPhysicalOrphans.map((orphan) => orphan.storageKey),
    [storageKey],
  );
  assert.equal(
    writer.canonicalKeys.has(storageKey),
    true,
    '快照之后已经 live 的 locator 不得被删除',
  );
}

// ============================================================================
// 文件快照与 catalog 快照之间完成提交时，新资产不能被旧 catalog 视图误判为 file orphan。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  const prepared = await writer.prepare({
    assetId: 'snapshot-race',
    sourceUri: 'content://gallery/snapshot-race',
  });
  const listSnapshot = writer.listCanonicalStorageKeys.bind(writer);
  writer.listCanonicalStorageKeys = async () => {
    const keys = await listSnapshot();
    insertAsset(db, 'snapshot-race', prepared.storageKey);
    db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, ?)')
      .run('self', 'snapshot-race');
    writer.commitPrepared(prepared.storageKey);
    return keys;
  };
  const audit = await lifecycle.audit();
  assert.equal(audit.orphanAssets.length, 0);
  assert.equal(audit.physicalOrphans.length, 0);
}

// ============================================================================
// 同一资产被两个不同消息事实共享：删除一个保留，删除最后一个才释放 row/file。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  insertAsset(db, 'a1');
  writer.canonicalKeys.add('catalog/media/a1.bin');
  insertMessage(db, 1, 'session-1', JSON.stringify({ kind: 'image', attachments: [{ mediaAssetId: 'a1' }] }));
  insertMessage(db, 2, 'session-1', JSON.stringify({ kind: 'voice', voice: { mediaAssetId: 'a1' } }));

  assert.equal((await lifecycle.audit()).references.length, 2);
  db.prepare('DELETE FROM messages WHERE id = 1').run();
  const retained = await lifecycle.cleanup();
  assert.equal(retained.deletedAssets.length, 0, '仍有一个 live reference 时不得删 asset');
  assert.ok(writer.canonicalKeys.has('catalog/media/a1.bin'));

  db.prepare('DELETE FROM messages WHERE id = 2').run();
  const released = await lifecycle.cleanup();
  assert.deepEqual(released.deletedAssets.map((item) => item.id), ['a1']);
  assert.equal(db.prepare('SELECT id FROM media_assets WHERE id = ?').get('a1'), undefined);
  assert.equal(writer.canonicalKeys.has('catalog/media/a1.bin'), false);
}

// ============================================================================
// DB orphan、physical orphan 与 dangling reference 必须分别可见，cleanup 只删 orphan。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  insertAsset(db, 'db-orphan');
  writer.canonicalKeys.add('catalog/media/db-orphan.bin');
  writer.canonicalKeys.add('catalog/media/file-orphan.bin');
  db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, ?)')
    .run('self', 'missing-asset');

  const audit = await lifecycle.audit();
  assert.deepEqual(audit.orphanAssets.map((item) => item.id), ['db-orphan']);
  assert.deepEqual(audit.physicalOrphans, [{
    storageBackend: 'persistent-media',
    storageKey: 'catalog/media/file-orphan.bin',
  }], 'dangling 存在时 audit 仍然报告候选，裁决留给 cleanup');
  assert.deepEqual(audit.danglingReferences.map((item) => item.assetId), ['missing-asset']);

  const result = await lifecycle.cleanup();
  assert.equal(result.deletedAssets.length, 1, 'catalog orphan 行仍然必须回收');
  assert.equal(result.deletedPhysicalOrphans.length, 0);
  assert.deepEqual(result.blockedPhysicalOrphans.map((item) => item.storageKey), [
    'catalog/media/file-orphan.bin',
  ]);
  assert.equal(result.audit.danglingReferences.length, 1, 'cleanup 不得静默改写 dangling 业务事实');
}

// ============================================================================
// B2：业务引用指向丢失的 catalog 行 + canonical 文件仍在 → destructive cleanup 必须 fail-closed。
// 「引用还在 + backing 还在 + row 丢了」是可修复状态，不能被 GC 进一步破坏。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  const storageKey = 'catalog/media/lost-asset.bin';
  writer.canonicalKeys.add(storageKey);
  db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, ?)')
    .run('self', 'lost-asset');
  insertMessage(db, 1, 'session-1', JSON.stringify({ attachments: [{ mediaAssetId: 'lost-asset' }] }));

  const audit = await lifecycle.audit();
  assert.equal(audit.danglingReferences.length, 2, 'dangling reference 必须被完整报告');
  assert.deepEqual(audit.physicalOrphans.map((item) => item.storageKey), [storageKey]);

  const result = await lifecycle.cleanup();
  assert.equal(result.deletedPhysicalOrphans.length, 0, 'dangling 存在时不得销毁可恢复 backing');
  assert.deepEqual(result.blockedPhysicalOrphans.map((item) => item.storageKey), [storageKey]);
  assert.equal(writer.deletedKeys.includes(storageKey), false, 'physical cleanup 必须真正暂停');
  assert.equal(writer.canonicalKeys.has(storageKey), true, '文件必须保留');
  assert.equal(result.audit.danglingReferences.length, 2, '仍然必须报告 dangling reference');

  // 业务事实修好（引用消失）之后，同一个文件必须重新可以被回收。
  db.prepare('UPDATE user_profile SET avatar_media_asset_id = NULL WHERE id = ?').run('self');
  db.prepare('DELETE FROM messages WHERE id = 1').run();
  const repaired = await lifecycle.cleanup();
  assert.deepEqual(
    repaired.deletedPhysicalOrphans.map((item) => item.storageKey),
    [storageKey],
    'dangling 消失后文件必须可再次回收',
  );
}

// ============================================================================
// 外部 content URI 只是导入源；删除时 backing API 只接收相对 storageKey。
// ============================================================================
{
  const { db, database, writer, backings, repository, lifecycle } = createHarness();
  const catalog = new MediaAssetCatalog(repository);
  const creator = new CreateMediaAsset({
    catalog,
    backings,
    contentInspector: { inspect: async () => ({ contentHash: 'b'.repeat(64), byteSize: 3 }) },
    database,
    generateId: () => 'external-copy',
    now: () => '2026-09-22T01:00:00.000Z',
    reportPostCommitCleanupFailure: () => {},
  });
  db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, NULL)').run('self');
  await creator.execute({
    storageBackend: 'persistent-media',
    sourceUri: 'content://gallery/original-image',
    fileName: 'picked.png',
    mimeType: 'image/png',
    width: 1,
    height: 1,
    durationMs: null,
  }, async ({ transaction, asset }) => {
    await transaction.runAsync(
      'UPDATE user_profile SET avatar_media_asset_id = ? WHERE id = ?',
      [asset.id, 'self'],
    );
  });
  assert.deepEqual(writer.preparedSources, ['content://gallery/original-image']);
  db.prepare('UPDATE user_profile SET avatar_media_asset_id = NULL WHERE id = ?').run('self');
  await lifecycle.cleanup();
  assert.deepEqual(writer.deletedKeys, ['catalog/media/external-copy.bin']);
  assert.equal(writer.deletedKeys.includes('content://gallery/original-image'), false);
}

// ============================================================================
// 文件删除失败时 catalog 已安全删除，失败 backing 留作下一次 physical orphan 检测。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  insertAsset(db, 'delete-failure');
  const key = 'catalog/media/delete-failure.bin';
  writer.canonicalKeys.add(key);
  writer.failingKeys.add(key);
  const result = await lifecycle.cleanup();
  assert.equal(result.failures.length, 1);
  assert.equal(db.prepare('SELECT id FROM media_assets WHERE id = ?').get('delete-failure'), undefined);
  assert.deepEqual(result.audit.physicalOrphans.map((item) => item.storageKey), [key]);
}

// ============================================================================
// 损坏 metadata 若精确含 asset id，不能把“解析失败”误当成无引用。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  insertAsset(db, 'uncertain');
  writer.canonicalKeys.add('catalog/media/uncertain.bin');
  insertMessage(db, 3, 'session-1', '{"mediaAssetId":"uncertain"');
  const audit = await lifecycle.audit();
  assert.equal(audit.invalidReferenceSources.length, 1);
  assert.equal(audit.orphanAssets.length, 0);
  assert.equal((await lifecycle.cleanup()).deletedAssets.length, 0);
}

// ============================================================================
// B3：targeted release 只裁决候选 asset id；共享资产最后一个引用消失才释放；
// 不做目录枚举，也不做全库 DB 审计。
// ============================================================================
{
  const {
    db,
    repository,
    writer,
    lifecycle,
  } = createHarness();

  insertAsset(db, 'shared-a');
  insertAsset(db, 'kept-by-avatar');
  insertAsset(db, 'unrelated-b');
  writer.canonicalKeys.add('catalog/media/shared-a.bin');
  writer.canonicalKeys.add('catalog/media/kept-by-avatar.bin');
  writer.canonicalKeys.add('catalog/media/unrelated-b.bin');

  insertMessage(db, 1, 'session-1', JSON.stringify({ attachments: [{ mediaAssetId: 'shared-a' }] }));
  insertMessage(db, 2, 'session-1', JSON.stringify({ voice: { mediaAssetId: 'shared-a' } }));
  insertMessage(db, 3, 'session-1', JSON.stringify({ sticker: { mediaAssetId: 'kept-by-avatar' } }));
  insertMessage(db, 4, 'session-2', JSON.stringify({ attachments: [{ mediaAssetId: 'unrelated-b' }] }));
  db.prepare('INSERT INTO ai_assistants (id, avatar_media_asset_id) VALUES (?, ?)')
    .run('ai-1', 'kept-by-avatar');
  db.prepare('INSERT INTO user_profile (id, avatar_media_asset_id) VALUES (?, NULL)').run('self');

  let enumerationCalls = 0;
  const originalList = writer.listCanonicalStorageKeys.bind(writer);
  writer.listCanonicalStorageKeys = async () => {
    enumerationCalls += 1;
    return originalList();
  };
  let auditCalls = 0;
  const originalAuditDatabase = repository.auditDatabase.bind(repository);
  repository.auditDatabase = async (...args) => {
    auditCalls += 1;
    return originalAuditDatabase(...args);
  };

  const candidates = ['shared-a', 'kept-by-avatar', 'unrelated-b'];

  // 第一个引用消失：共享资产必须保留。
  db.prepare('DELETE FROM messages WHERE id = 1').run();
  const retained = await lifecycle.releaseCandidates(candidates);
  assert.deepEqual(retained.releasedAssets, [], '仍有 live reference 的候选都不得释放');
  assert.ok(writer.canonicalKeys.has('catalog/media/shared-a.bin'));

  // 最后一个引用消失：只释放这个候选。
  db.prepare('DELETE FROM messages WHERE id = 2').run();
  const released = await lifecycle.releaseCandidates(candidates);
  assert.deepEqual(released.releasedAssets.map((asset) => asset.id), ['shared-a']);
  assert.deepEqual(released.deletedBackings, [{
    storageBackend: 'persistent-media',
    storageKey: 'catalog/media/shared-a.bin',
  }]);
  assert.equal(db.prepare('SELECT id FROM media_assets WHERE id = ?').get('shared-a'), undefined);
  assert.equal(writer.canonicalKeys.has('catalog/media/shared-a.bin'), false);

  // 候选之外、以及仍被其它引用源持有的资产都不受影响。
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('kept-by-avatar').id,
    'kept-by-avatar',
    'AI 头像仍在引用时必须保留',
  );
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('unrelated-b').id,
    'unrelated-b',
    '候选之外的资产不得被裁决',
  );
  assert.ok(writer.canonicalKeys.has('catalog/media/kept-by-avatar.bin'));
  assert.ok(writer.canonicalKeys.has('catalog/media/unrelated-b.bin'));

  // 空候选：调用方（例如纯文本消息删除）不得触发任何裁决或扫描。
  const noop = await lifecycle.releaseCandidates([null, '', '   ']);
  assert.deepEqual(noop.releasedAssets, []);
  assert.deepEqual(noop.deletedBackings, []);

  assert.equal(enumerationCalls, 0, 'targeted release 不得枚举 canonical 目录');
  assert.equal(auditCalls, 0, 'targeted release 不得做全库 DB 审计');
}

// ============================================================================
// B3：targeted release 的候选裁决也必须覆盖全部引用源，并对无法解析的 metadata fail-closed。
// ============================================================================
{
  const { db, writer, lifecycle } = createHarness();
  insertAsset(db, 'moment-held');
  insertAsset(db, 'uncertain-candidate');
  insertAsset(db, 'release-failure');
  writer.canonicalKeys.add('catalog/media/moment-held.bin');
  writer.canonicalKeys.add('catalog/media/uncertain-candidate.bin');
  writer.canonicalKeys.add('catalog/media/release-failure.bin');

  db.prepare('INSERT INTO moments (id) VALUES (?)').run('moment-1');
  db.prepare('INSERT INTO moment_media (id, moment_id, media_asset_id) VALUES (?, ?, ?)')
    .run('moment-media-1', 'moment-1', 'moment-held');
  insertMessage(db, 1, 'session-1', '{"mediaAssetId":"uncertain-candidate"');
  writer.failingKeys.add('catalog/media/release-failure.bin');

  const result = await lifecycle.releaseCandidates([
    'moment-held',
    'uncertain-candidate',
    'release-failure',
  ]);
  assert.deepEqual(
    result.releasedAssets.map((asset) => asset.id),
    ['release-failure'],
    'Moment 引用与损坏 metadata 都必须拦住释放；只有真正无引用的候选才被释放',
  );
  assert.deepEqual(result.deletedBackings, []);
  assert.deepEqual(result.failures.map((failure) => failure.phase), ['released_asset_file']);
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('moment-held').id,
    'moment-held',
  );
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('uncertain-candidate').id,
    'uncertain-candidate',
  );
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('release-failure'),
    undefined,
    '文件删除失败不得回滚已经提交的 catalog 事实',
  );
  assert.equal(writer.canonicalKeys.has('catalog/media/release-failure.bin'), true);
}

// ============================================================================
// B3：级联删除前的候选收集只覆盖给定 chat session，不解析其它会话的 metadata。
// ============================================================================
{
  const { db, repository } = createHarness();
  insertMessage(db, 1, 'session-a', JSON.stringify({
    attachments: [{ mediaAssetId: 'a1', thumbnailMediaAssetId: 'a2' }],
  }));
  insertMessage(db, 2, 'session-b', JSON.stringify({ voice: { mediaAssetId: 'b1' } }));
  insertMessage(db, 3, 'session-a', '{"mediaAssetId":"broken"');

  assert.deepEqual(
    [...(await repository.listChatSessionMediaAssetIds(['session-a']))].sort(),
    ['a1', 'a2'],
    '只收集指定会话的媒体引用；损坏 JSON 不产生候选',
  );
  assert.deepEqual(await repository.listChatSessionMediaAssetIds(['session-b']), ['b1']);
  assert.deepEqual(await repository.listChatSessionMediaAssetIds([]), []);
  assert.deepEqual(await repository.listChatSessionMediaAssetIds(['', '  ']), []);
  assert.deepEqual(
    [...(await repository.listChatSessionMediaAssetIds(['session-a', 'session-b']))].sort(),
    ['a1', 'a2', 'b1'],
  );
}

console.log('MediaAsset lifecycle closure：in-flight race、stale 快照重裁决、dangling fail-closed、targeted release 与外部源边界验证通过。');
