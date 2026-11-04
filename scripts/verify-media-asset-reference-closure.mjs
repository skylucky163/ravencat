import { chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';
import { chatReplyVersionSql, chatMessageMutations, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
/**
 * MediaAsset M5 correctness closure：引用写入与 release 的 TOCTOU、级联删除候选收集。
 *
 * 覆盖两条跨事务窗口（都是真实 SQLite + 真实仓储/生命周期，不是 repository mock）：
 *
 * A. release vs new reference
 *    一旦 release 事务确认某 asset 无引用并删除 catalog 行，就不可能再有新的业务事实
 *    成功提交对该 assetId 的引用：携带引用的 metadata 写入必须在同一事务内确认目标
 *    catalog 行仍存在，否则 fail closed。绝不允许出现
 *    「message 引用成功 AND media_assets(A) 不存在」。
 *
 * B. cascade collect/delete
 *    AI / Group 级联删除的候选收集必须与删除事实同属一个 exclusive transaction：
 *    收集时刻之后、删除之前新提交的消息引用，必须一起进入候选集。
 *
 * C. shared asset 只有最后一个业务引用消失才释放。
 * D. 损坏 metadata 继续保守处理。
 * E. Chat 消息删除：候选必须来自 delete transaction 读取的当前 metadata。
 *    migration 先提交 → 删除看到 canonical assetId 并作为候选带走（release 后不留下
 *    catalog / backing / reference 任一 orphan）；delete 先提交或并发发起 → migration 的
 *    CAS 整体回滚，不产生「已经失去业务引用的新 asset 事实」。
 */
import assert from 'node:assert/strict';
import { SCHEMAS } from './helpers/sqlite-bootstrap-fixture.mjs';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadTypeScriptModule(relativePath) {
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
    if (specifier === '@shared/errors/SettingChangeConflictError') return loadTypeScriptModuleWithMocks('src/shared/errors/SettingChangeConflictError.ts', {});
    if (specifier === './MediaFileLifetime') return loadTypeScriptModuleWithMocks('src/platform/device/MediaFileLifetime.ts', {});
    if (specifier === './ChatAttachmentMime') return loadTypeScriptModuleWithMocks('src/features/chat/messages/application/ChatAttachmentMime.ts', {});
    assert.ok(Object.hasOwn(mocks, specifier), `未声明的运行时依赖：${specifier}`);
    return mocks[specifier];
  };
  new Function('exports', 'require', 'module', output)(module.exports, requireMock, module);
  return module.exports;
}

const { MEDIA_ASSET_SCHEMA, MEDIA_ASSET_CONTENT_HASH_INDEX } = await loadTypeScriptModule(
  'src/platform/persistence/sqlite/mediaAssetSchema.ts',
);
const { CALL_BACKGROUND_SELECTION_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/callBackgroundSchema.ts');
const { CHAT_BUBBLE_SKINS_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/chatBubbleSkinSchema.ts');
const { CALL_RINGTONE_SELECTION_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/callRingtoneSchema.ts');
const { CALL_HISTORY_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/callHistorySchema.ts');
const { CHAT_FAVORITES_SCHEMA } = await loadTypeScriptModule('src/platform/persistence/sqlite/chatFavoriteSchema.ts');
const chatTimelineSqlModule = await loadTypeScriptModule('src/features/chat/messages/infrastructure/ChatTimelineSql.ts');
const messageTimeSeparatorModule = await loadTypeScriptModule(
  'src/features/chat/messages/domain/MessageTimeSeparator.ts',
);
const mediaAssetBackingModule = await loadTypeScriptModule(
  'src/features/media/application/MediaAssetBacking.ts',
);
const { MediaAssetBackingRegistry } = mediaAssetBackingModule;
const { MediaAssetLifecycle } = loadTypeScriptModuleWithMocks(
  'src/features/media/application/MediaAssetLifecycle.ts',
  { './MediaAssetBacking': mediaAssetBackingModule },
);
const { SQLiteMediaAssetRepository } = await loadTypeScriptModule(
  'src/features/media/infrastructure/SQLiteMediaAssetRepository.ts',
);
// 引用 metadata 只用真实领域 builder 构造，不用手写形状：guard 的判据必须覆盖产品真实写入。
const chatStickerModule = await loadTypeScriptModule(
  'src/features/chat/messages/domain/ChatSticker.ts',
);
const chatMessageMetadata = loadTypeScriptModuleWithMocks(
  'src/features/chat/messages/domain/chatMessageMetadata.ts',
  { './ChatSticker': chatStickerModule,
    ...chatSharingDependencies },
);
// 真实 legacy 迁移驱动扫描、定位、catalog 与 owner CAS 的并发路径。
const chatAttachmentMigration = loadTypeScriptModuleWithMocks(
  'src/features/chat/messages/application/MigrateLegacyChatAttachments.ts',
  {},
);

// ============================================================================
// 真实 SQLite 内存库
// ============================================================================
function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MEDIA_ASSET_SCHEMA);
  db.exec(SCHEMAS.assistantProfileCovers);
  db.exec(CHAT_BUBBLE_SKINS_SCHEMA);
  db.exec(CHAT_FAVORITES_SCHEMA);
  db.exec(MEDIA_ASSET_CONTENT_HASH_INDEX);
  db.exec(`
    CREATE TABLE profile_wallpaper_selections (selection_key TEXT PRIMARY KEY, media_asset_id TEXT, legacy_uri TEXT, revision INTEGER);
    ${CALL_BACKGROUND_SELECTION_SCHEMA}
    ${CALL_RINGTONE_SELECTION_SCHEMA}
    CREATE TABLE user_profile (id TEXT PRIMARY KEY, avatar_media_asset_id TEXT, moments_cover_media_asset_id TEXT);
    CREATE TABLE ai_assistants (
      id TEXT PRIMARY KEY,
      avatar_media_asset_id TEXT,
      is_host_ai INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ai_blacklist (id TEXT PRIMARY KEY, blocked_by TEXT);
    CREATE TABLE host_ai_relationship_state (
      id TEXT PRIMARY KEY,
      last_revoked_ai_id TEXT,
      appointment_cooldown_start TEXT,
      appointment_cooldown_end TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE group_chats (
      id TEXT PRIMARY KEY,
      avatar_media_asset_id TEXT
    );
    CREATE TABLE group_chat_members (id TEXT PRIMARY KEY, group_id TEXT);
    CREATE TABLE group_chat_admin_configs (group_id TEXT PRIMARY KEY);
    CREATE TABLE group_speech_plans (id TEXT PRIMARY KEY, group_id TEXT);
    CREATE TABLE group_speech_tasks (id TEXT PRIMARY KEY, group_id TEXT);
    CREATE TABLE session_vision_helpers (session_id TEXT PRIMARY KEY);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      ai_assistant_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      last_message TEXT,
      last_time TEXT,
      is_active INTEGER DEFAULT 1,
      is_pinned INTEGER DEFAULT 0,
      visible_after_message_id INTEGER,
      visible_after_at TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-09-26T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-09-26T00:00:00.000Z',
      FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
    );
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group'))
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      client_message_id TEXT,
      text TEXT NOT NULL DEFAULT '',
      is_me INTEGER NOT NULL DEFAULT 1,
      sender_type TEXT,
      api_message_id TEXT,
      time TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-09-26T00:00:00.000Z',
      show_time_separator_before INTEGER DEFAULT 0,
      updated_at TEXT,
      reply_to_id INTEGER,
      reply_to_text TEXT,
      logical_message_id TEXT,
      segment_index INTEGER DEFAULT 0,
      segment_total INTEGER DEFAULT 1,
      delivery_status TEXT DEFAULT 'delivered',
      status TEXT DEFAULT 'sent',
      tokens_used INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      metadata_json TEXT,
      is_read INTEGER DEFAULT 0,
      voice_played_at TEXT,
      turn_run_id TEXT,
      turn_item_index INTEGER,
      FOREIGN KEY (session_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE stickers (
      id TEXT PRIMARY KEY,
      media_asset_id TEXT NOT NULL,
      owner_assistant_id TEXT
    );
    CREATE TABLE ai_downloaded_images (id TEXT PRIMARY KEY, assistant_id TEXT, media_asset_id TEXT);
    CREATE TABLE call_sessions (id TEXT PRIMARY KEY, chat_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE);
    ${CALL_HISTORY_SCHEMA}
    CREATE TABLE moments (id TEXT PRIMARY KEY);
    CREATE TABLE moment_media (
      id TEXT PRIMARY KEY,
      moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
      media_asset_id TEXT NOT NULL
    );
  `);
  installChatTimelineSchema(db);
  return db;
}

/**
 * 与生产 DatabaseCoordinator 单写者调度等价的最小写队列：任何 read/write/transaction
 * 都不会与另一个 transaction 交错。并发用例依赖这个边界，而不是依赖 JS 单线程。
 */
function executorFor(db) {
  let writeChain = Promise.resolve();
  const executor = {
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    execAsync: async (sql) => db.exec(sql),
    withExclusiveTransactionAsync(task) {
      const run = writeChain.then(async () => {
        db.exec('BEGIN IMMEDIATE;');
        try {
          const value = await task(executor);
          db.exec('COMMIT;');
          return value;
        } catch (error) {
          db.exec('ROLLBACK;');
          throw error;
        }
      });
      writeChain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return executor;
}

function insertAsset(db, id, storageKey = `catalog/media/${id}.bin`) {
  db.prepare(`INSERT INTO media_assets (
    id, storage_backend, storage_key, hash_algorithm, content_hash, mime_type,
    byte_size, width, height, duration_ms, status, created_at, updated_at
  ) VALUES (?, 'persistent-media', ?, 'sha256', ?, 'image/png', 3, 1, 1, NULL, 'ready', ?, ?)`).run(
    id,
    storageKey,
    id.padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
    '2026-09-26T00:00:00.000Z',
    '2026-09-26T00:00:00.000Z',
  );
}

function createWriter() {
  const canonicalKeys = new Set();
  const deletedKeys = [];
  const inFlightKeys = new Set();
  return {
    storageBackend: 'persistent-media',
    canonicalKeys,
    deletedKeys,
    async prepare(input) {
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
      canonicalKeys.delete(storageKey);
      inFlightKeys.delete(storageKey);
    },
    ownsStorageKeyLifecycle(storageKey) {
      return storageKey.startsWith('catalog/media/');
    },
    async listCanonicalStorageKeys() {
      return [...canonicalKeys].sort();
    },
  };
}

function createHarness() {
  const db = createDatabase();
  const database = executorFor(db);
  const writer = createWriter();
  const backings = new MediaAssetBackingRegistry({ writers: [writer] });
  const mediaRepository = new SQLiteMediaAssetRepository(database);
  const lifecycle = new MediaAssetLifecycle(mediaRepository, backings, database);

  const persistenceMock = {
    databaseCoordinator: {
      openTaskExecutor: () => database,
      transaction: (_meta, task) => database.withExclusiveTransactionAsync(task),
    },
  };
  const wallpapers = new (loadTypeScriptModuleWithMocks('src/features/profile/infrastructure/SQLiteWallpaperRepository.ts', { '@platform/persistence': persistenceMock }).SQLiteWallpaperRepository)();
  const profileMock = { removeConversationWallpaperInTransaction: (tx, key) => wallpapers.removeConversation(tx, key) };
  const mediaMock = {
    collectAssistantMediaAssetCandidatesInTransaction: (transaction, assistantId) => lifecycle.collectAssistantMediaAssetCandidates(assistantId, transaction),
    resolveMediaAssetReferenceUri: async ({ mediaAssetId, legacyUri }) => (
      mediaAssetId ? `asset://${mediaAssetId}` : legacyUri
    ),
    collectChatSessionMediaAssetCandidatesInTransaction: (transaction, sessionIds) => (
      lifecycle.collectChatSessionMediaAssetCandidates(sessionIds, transaction)
    ),
  };

  const messages = new (loadTypeScriptModuleWithMocks(
    'src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts',
    {
      '@platform/persistence': persistenceMock,
      './ChatMessageMutationSql': chatMessageMutations,
      '../../reply/infrastructure/ChatReplyVersionSql': chatReplyVersionSql,
      './ChatTimelineSql': chatTimelineSqlModule,
      '../domain/MessageTimeSeparator': messageTimeSeparatorModule,
      '../domain/chatMessageMetadata': chatMessageMetadata,
    },
  ).MessageRepository)();

  const assistants = new (loadTypeScriptModuleWithMocks(
    'src/features/assistants/infrastructure/SQLiteAssistantRepository.ts',
    {
      './SQLiteAuxiliaryModelDefaults': {},
      './SQLiteAuxiliaryModelRepository': {},
      './SQLiteModelServiceRepository': {},
      '../domain/ModelService': {},
      '@platform/persistence': persistenceMock,
      '@features/media': mediaMock,
      '@features/profile': profileMock,
      '../domain/AIProfile': { createAIProfile: (value) => value },
      '../domain/HostRepository': {
        createHostAIAppointmentCooldown: () => ({ startAt: 'a', endAt: 'b' }),
        HOST_AI_RELATIONSHIP_STATE_ID: 'host_ai_relationship_state',
      },
    },
  ).AIAssistantRepository)();

  const groups = new (loadTypeScriptModuleWithMocks(
    'src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts',
    {
      '@platform/persistence': persistenceMock,
      '@features/assistants': {},
      '@features/media': mediaMock,
      '@features/profile': profileMock,
    },
  ).GroupChatRepository)();

  /**
   * M3a legacy attachment migration 的 Media 侧窄端口。
   *
   * 真实 Host 的 adoptLegacyChatFiles 必须在**同一个 exclusive transaction** 内创建 asset
   * 行并执行 Chat metadata CAS；这里按同样的契约实现，让删除/migration 的顺序用例走真实
   * 迁移代码，而不是手写等价 SQL。
   */
  const legacyChatFiles = {
    async locateLegacyChatFile(localUri) {
      const name = localUri.split('/').filter(Boolean).pop();
      return {
        storageBackend: 'persistent-media',
        storageKey: `catalog/media/adopted-${name}.bin`,
        localUri,
      };
    },
    async adoptLegacyChatFiles(inputs, commit) {
      return database.withExclusiveTransactionAsync(async (transaction) => {
        const assets = [];
        for (const input of inputs) {
          const assetId = input.storageKey
            .replace(/^catalog\/media\//u, '')
            .replace(/\.bin$/u, '');
          const asset = {
            id: assetId,
            storageBackend: input.storageBackend,
            storageKey: input.storageKey,
            hashAlgorithm: 'sha256',
            contentHash: assetId.padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/gu, 'a'),
            mimeType: input.mimeType,
            byteSize: 3,
            width: input.width,
            height: input.height,
            durationMs: input.durationMs,
            status: 'ready',
            createdAt: '2026-09-26T00:00:00.000Z',
            updatedAt: '2026-09-26T00:00:00.000Z',
          };
          await mediaRepository.createInTransaction(transaction, asset);
          // 接管后的 backing 归 canonical namespace 管理（等价于真实 adopt 的 reserve + copy）。
          writer.canonicalKeys.add(input.storageKey);
          assets.push(asset);
        }
        return commit(transaction, assets);
      });
    },
  };

  return {
    db,
    database,
    writer,
    lifecycle,
    mediaRepository,
    messages,
    assistants,
    groups,
    legacyChatFiles,
  };
}

/** 与真实 migration 扫描一致的 legacy 附件消息 fixture（metadata 同时含 attachments / localUri）。 */
function insertLegacyAttachmentMessage(db, sessionId, localUri) {
  return Number(db.prepare(
    'INSERT INTO messages (session_id, text, metadata_json) VALUES (?, ?, ?)',
  ).run(
    sessionId,
    '',
    JSON.stringify({
      kind: 'image',
      attachments: [{ id: 'att-legacy', type: 'image', source: 'gallery', localUri }],
    }),
  ).lastInsertRowid);
}

/** 直接写入 metadata 的消息 fixture：用于只验证引用候选、不验证写入守卫的用例。 */
function insertMetadataMessage(db, sessionId, metadata) {
  return Number(db.prepare(
    'INSERT INTO messages (session_id, text, metadata_json) VALUES (?, ?, ?)',
  ).run(sessionId, '', JSON.stringify(metadata)).lastInsertRowid);
}

function messageRow(db, id) {
  return db.prepare('SELECT id, session_id, metadata_json FROM messages WHERE id = ?').get(id);
}

function stickerMessage(sessionId, stickerAssetId, stickerId = 'sticker-1') {
  return {
    sessionId,
    text: '',
    isMe: true,
    senderType: 'user',
    agentId: null,
    apiMessageId: null,
    clientMessageId: null,
    time: '10:00',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    replyToId: null,
    replyToText: null,
    status: 'sent',
    tokensUsed: 0,
    promptTokens: 0,
    completionTokens: 0,
    metadataJson: JSON.stringify(chatStickerModule.buildStickerMessageMetadata({
      stickerId,
      mediaAssetId: stickerAssetId,
      name: 'x',
      description: null,
      tags: [],
      emotion: null,
      mimeType: 'image/png',
      width: 1,
      height: 1,
      isAnimated: false,
    })),
  };
}

/**
 * 四类 Chat 媒体引用的真实 metadata 形状：附件、缩略图、语音、Sticker snapshot。
 * guard 的判据必须与 media 引用枚举一致，覆盖全部四类而不是只覆盖 attachments。
 */
function metadataForKind(kind, assetId) {
  if (kind === 'attachment') {
    return chatMessageMetadata.buildAttachmentMessageMetadata({
      text: '',
      attachments: [{
        id: 'att-1',
        type: 'image',
        source: 'gallery',
        fileName: 'a.png',
        mimeType: 'image/png',
        mediaAssetId: assetId,
      }],
    });
  }
  if (kind === 'thumbnail') {
    // 真实路径里 thumbnail 与主媒体可以是同一个 asset（缩略图即原图）。
    return chatMessageMetadata.buildAttachmentMessageMetadata({
      text: '',
      attachments: [{
        id: 'att-2',
        type: 'image',
        source: 'gallery',
        fileName: 'a.png',
        mimeType: 'image/png',
        mediaAssetId: assetId,
        thumbnailMediaAssetId: assetId,
      }],
    });
  }
  if (kind === 'voice') {
    return chatMessageMetadata.buildChatVoiceMessageMetadata({
      schemaVersion: 1,
      mediaAssetId: assetId,
      mimeType: 'audio/m4a',
      durationMs: 1000,
      transcriptSource: 'assistant_source_text',
    });
  }
  return chatStickerModule.buildStickerMessageMetadata({
    stickerId: 'sticker-kind',
    mediaAssetId: assetId,
    name: 'x',
    description: null,
    tags: [],
    emotion: null,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    isAnimated: false,
  });
}

function metadataMessage(sessionId, metadata) {
  return { ...stickerMessage(sessionId, 'unused'), metadataJson: JSON.stringify(metadata) };
}

// ============================================================================
// A1. 合法顺序：引用先提交 → release 必须保留该 asset（守卫不能误杀 live 引用）
// ============================================================================
{
  const { db, writer, lifecycle, messages } = createHarness();
  insertAsset(db, 'ref-win');
  writer.canonicalKeys.add('catalog/media/ref-win.bin');
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-1', 'direct')`).run();

  const inserted = await messages.commitMessage({
    message: stickerMessage('s-1', 'ref-win'),
    previewText: 'sticker',
  });
  assert.equal(messageRow(db, inserted.id).metadata_json.includes('ref-win'), true);

  const released = await lifecycle.releaseCandidates(['ref-win']);
  assert.deepEqual(released.releasedAssets, [], '引用已提交的 asset 不得被 release');
  assert.deepEqual(released.deletedBackings, []);
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('ref-win').id,
    'ref-win',
    'catalog 行必须保留',
  );
  assert.equal(writer.canonicalKeys.has('catalog/media/ref-win.bin'), true, 'backing 必须保留');
}

// ============================================================================
// A2. release 先提交 → 后续引用写入必须 fail closed，绝不允许产生 dangling reference。
// ============================================================================
{
  const { db, writer, lifecycle, messages } = createHarness();
  insertAsset(db, 'release-win');
  writer.canonicalKeys.add('catalog/media/release-win.bin');
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-2', 'direct')`).run();

  const released = await lifecycle.releaseCandidates(['release-win']);
  assert.deepEqual(released.releasedAssets.map((asset) => asset.id), ['release-win']);
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('release-win'),
    undefined,
  );

  // 旧 assetId 仍被调用方持有（真实路径：Sticker snapshot 先解析、消息后提交）。
  await assert.rejects(
    () => messages.commitMessage({
      message: stickerMessage('s-2', 'release-win'),
      previewText: 'sticker',
    }),
    /引用写入必须 fail closed/,
    'release 之后的新引用必须失败，不得落 dangling reference',
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    0,
    'fail-closed 必须回滚整条消息插入',
  );
}

// ============================================================================
// A3. 并发交错：release 与引用写入同时发起，只允许两种合法结果，禁止 dangling。
// ============================================================================
for (const order of ['release-first', 'reference-first']) {
  const { db, writer, lifecycle, messages } = createHarness();
  insertAsset(db, 'race-a');
  writer.canonicalKeys.add('catalog/media/race-a.bin');
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-3', 'direct')`).run();

  const releaseCall = () => lifecycle.releaseCandidates(['race-a']);
  const referenceCall = () => messages.commitMessage({
    message: stickerMessage('s-3', 'race-a'),
    previewText: 'sticker',
  });

  const settled = order === 'release-first'
    ? await Promise.allSettled([releaseCall(), referenceCall()])
    : await Promise.allSettled([referenceCall(), releaseCall()]);

  const [first] = settled;
  const catalogRow = db.prepare('SELECT id FROM media_assets WHERE id = ?').get('race-a');
  const messageCount = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const referencesAsset = messageCount > 0
    && db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE metadata_json LIKE '%race-a%'`).get().n > 0;

  // 禁止状态：业务引用成功且 catalog 行不存在（live dangling reference + 数据丢失）。
  assert.equal(
    referencesAsset && catalogRow === undefined,
    false,
    `[${order}] 不允许 message 引用成功而 media_assets 行已消失`,
  );

  if (referencesAsset) {
    assert.equal(first.status, 'fulfilled');
    assert.equal(messageCount, 1, `[${order}] 引用成功时必须留下消息事实`);
    assert.deepEqual(catalogRow?.id, 'race-a', `[${order}] 引用成功时 catalog 行必须仍在`);
    assert.equal(writer.canonicalKeys.has('catalog/media/race-a.bin'), true);
  } else {
    assert.equal(catalogRow, undefined, `[${order}] 引用失败时 catalog 行必须已被 release 删除`);
    assert.equal(messageCount, 0, `[${order}] 引用失败时必须回滚消息插入`);
    assert.equal(
      settled.some((entry) => entry.status === 'rejected'),
      true,
      `[${order}] 引用失败必须是显式失败，而不是静默丢弃`,
    );
    assert.equal(first.status, 'fulfilled', `[${order}] release 侧必须成功`);
  }
}

// ============================================================================
// A4. 同一事务内在 metadata 里引用一个刚创建的 asset（voice 路径）必须放行；
//     CAS 重写 metadata 同样受守卫保护。
// ============================================================================
{
  const { db, database, writer, lifecycle, messages } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-4', 'direct')`).run();

  await assert.rejects(
    () => messages.commitMessage({
      message: stickerMessage('s-4', 'fresh-asset'),
      previewText: 'sticker',
    }),
    /引用写入必须 fail closed/,
    '引用不存在的 asset 必须失败',
  );

  insertAsset(db, 'fresh-asset');
  writer.canonicalKeys.add('catalog/media/fresh-asset.bin');
  const okInsert = await messages.commitMessage({
    message: stickerMessage('s-4', 'fresh-asset'),
    previewText: 'sticker',
  });
  assert.equal(messageRow(db, okInsert.id).id, okInsert.id);

  await assert.rejects(
    () => database.withExclusiveTransactionAsync((transaction) => (
      messages.compareAndSwapMetadataJsonInTransaction(transaction, {
        messageId: okInsert.id,
        expectedMetadataJson: okInsert.metadataJson,
        metadataJson: JSON.stringify({ voice: { mediaAssetId: 'ghost-asset' } }),
      })
    )),
    /引用写入必须 fail closed/,
    'CAS 重写 metadata 同样必须 fail closed',
  );
  assert.equal(
    messageRow(db, okInsert.id).metadata_json.includes('fresh-asset'),
    true,
    'CAS 失败必须回滚 metadata 重写',
  );

  const kept = await lifecycle.releaseCandidates(['fresh-asset']);
  assert.deepEqual(kept.releasedAssets, [], '仍有消息引用的 asset 保持 live');
}

// ============================================================================
// A5. 四类 Chat 媒体引用形状都必须被守卫覆盖（attachments / thumbnail / voice / sticker）。
// ============================================================================
for (const kind of ['attachment', 'thumbnail', 'voice', 'sticker']) {
  const { db, lifecycle, messages } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES (?, 'direct')`).run(`s-${kind}`);

  await assert.rejects(
    () => messages.commitMessage({
      message: metadataMessage(`s-${kind}`, metadataForKind(kind, `${kind}-missing`)),
      previewText: kind,
    }),
    /引用写入必须 fail closed/,
    `[${kind}] 引用不存在的 asset 必须 fail closed`,
  );

  insertAsset(db, `${kind}-live`);
  const committed = await messages.commitMessage({
    message: metadataMessage(`s-${kind}`, metadataForKind(kind, `${kind}-live`)),
    previewText: kind,
  });
  assert.equal(
    messageRow(db, committed.id).metadata_json.includes(`${kind}-live`),
    true,
    `[${kind}] 引用存在的 asset 必须正常提交`,
  );
  assert.deepEqual(
    (await lifecycle.releaseCandidates([`${kind}-live`])).releasedAssets,
    [],
    `[${kind}] 已被消息引用的 asset 不得被 release`,
  );
}

// ============================================================================
// D. 损坏 metadata 继续保守处理：不因解析失败释放仍可能被引用的 asset。
// ============================================================================
{
  const { db, writer, lifecycle, messages } = createHarness();
  insertAsset(db, 'broken-ref');
  writer.canonicalKeys.add('catalog/media/broken-ref.bin');
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-d', 'direct')`).run();

  // 损坏 JSON 原文包含该 asset id：release 必须保守保留。
  db.prepare('INSERT INTO messages (session_id, text, metadata_json) VALUES (?, ?, ?)')
    .run('s-d', '', '{"sticker":{"mediaAssetId":"broken-ref"');

  const released = await lifecycle.releaseCandidates(['broken-ref']);
  assert.deepEqual(released.releasedAssets, [], '损坏 metadata 命中 asset id 时不得释放');
  assert.equal(writer.canonicalKeys.has('catalog/media/broken-ref.bin'), true);

  // 守卫不做「解析失败 = 无引用」的危险推断：损坏 metadata 不产生引用集合，
  // 但产品写入路径（JSON.stringify）不会制造损坏 metadata。
  const inserted = await messages.commitMessage({
    message: {
      ...stickerMessage('s-d', 'broken-ref'),
      metadataJson: '{"sticker":{"mediaAssetId":"broken-ref"',
    },
    previewText: 'x',
  });
  assert.equal(typeof inserted.id, 'number');
}

// ============================================================================
// 角色背景级联删除：共享文件只有最后一个角色删除后才能释放。
{
  const { db, writer, lifecycle, assistants } = createHarness();
  db.exec("INSERT INTO ai_assistants (id) VALUES ('background-a'), ('background-b');");
  insertAsset(db, 'shared-background');
  writer.canonicalKeys.add('catalog/media/shared-background.bin');
  db.exec("INSERT INTO call_background_selection VALUES ('background-a', 'shared-background', 0), ('background-b', 'shared-background', 0);");

  const first = await assistants.delete('background-a');
  assert.deepEqual(first.mediaAssetCandidates, ['shared-background']);
  assert.equal(db.prepare("SELECT 1 FROM call_background_selection WHERE id = 'background-a'").get(), undefined);
  assert.deepEqual((await lifecycle.releaseCandidates(first.mediaAssetCandidates)).releasedAssets, []);
  assert.equal(writer.canonicalKeys.has('catalog/media/shared-background.bin'), true);

  const second = await assistants.delete('background-b');
  assert.deepEqual(second.mediaAssetCandidates, ['shared-background']);
  assert.deepEqual((await lifecycle.releaseCandidates(second.mediaAssetCandidates)).releasedAssets.map((asset) => asset.id), ['shared-background']);
  assert.equal(writer.canonicalKeys.has('catalog/media/shared-background.bin'), false);
}

// ============================================================================
// 来电、拨出与其他角色共享铃声：最后一个引用消失后才回收。
// ============================================================================
{
  const { db, writer, lifecycle, assistants } = createHarness();
  db.exec("INSERT INTO ai_assistants (id) VALUES ('ring-a'), ('ring-b');");
  insertAsset(db, 'shared-ringtone');
  writer.canonicalKeys.add('catalog/media/shared-ringtone.bin');
  db.exec(`INSERT INTO call_ringtone_selection VALUES
    ('ring-a', 'incoming', 'shared-ringtone', 'ring.mp3', 0),
    ('ring-a', 'outgoing', 'shared-ringtone', 'ring.mp3', 0),
    ('ring-b', 'incoming', 'shared-ringtone', 'ring.mp3', 0);`);
  const audit = await lifecycle.audit();
  assert.equal(audit.references.filter(ref => ref.kind === 'call_ringtone').length, 3);
  assert.deepEqual((await lifecycle.releaseCandidates(['shared-ringtone'])).releasedAssets, []);
  const first = await assistants.delete('ring-a');
  assert.deepEqual(first.mediaAssetCandidates, ['shared-ringtone']);
  assert.deepEqual((await lifecycle.releaseCandidates(first.mediaAssetCandidates)).releasedAssets, []);
  const second = await assistants.delete('ring-b');
  assert.deepEqual((await lifecycle.releaseCandidates(second.mediaAssetCandidates)).releasedAssets.map(asset => asset.id), ['shared-ringtone']);
  assert.equal(writer.canonicalKeys.has('catalog/media/shared-ringtone.bin'), false);
}

// B1. AI 级联删除：候选收集与删除同属一个事务。
// 注入「收集发起之后、删除之前新提交的引用 C」，它必须进入候选集并被释放。
{
  const { db, writer, lifecycle, assistants } = createHarness();
  const buildAi = (aiId, sessionId) => {
    db.prepare('INSERT INTO ai_assistants (id, avatar_media_asset_id, is_host_ai) VALUES (?, ?, 0)')
      .run(aiId, null);
    db.prepare('INSERT INTO sessions (id, ai_assistant_id) VALUES (?, ?)').run(sessionId, aiId);
    db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES (?, 'direct')`).run(sessionId);
  };
  buildAi('ai-b', 's-b1');
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-b2', 'direct')`).run();

  for (const assetId of ['cand-a', 'cand-b', 'cand-c', 'cand-shared']) {
    insertAsset(db, assetId);
    writer.canonicalKeys.add(`catalog/media/${assetId}.bin`);
  }
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('s-b1', JSON.stringify({ sticker: { mediaAssetId: 'cand-a' } }));
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('s-b1', JSON.stringify({ attachments: [{ mediaAssetId: 'cand-b' }] }));
  // 另一个仍然 live 的业务事实共享 cand-shared。
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('s-b2', JSON.stringify({ attachments: [{ mediaAssetId: 'cand-shared' }] }));
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('s-b1', JSON.stringify({ attachments: [{ mediaAssetId: 'cand-shared' }] }));

  // 在收集器被调用时（= 已在删除事务内部）通过同一事务写入一条引用 cand-c 的新消息。
  const originalCollect = lifecycle.collectChatSessionMediaAssetCandidates.bind(lifecycle);
  let injected = false;
  lifecycle.collectChatSessionMediaAssetCandidates = async (sessionIds, executor) => {
    if (!injected) {
      injected = true;
      await executor.runAsync(
        'INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)',
        [sessionIds[0], JSON.stringify({ voice: { mediaAssetId: 'cand-c' } })],
      );
    }
    return originalCollect(sessionIds, executor);
  };

  const result = await assistants.delete('ai-b');
  assert.equal(result.deleted, true);
  assert.deepEqual(
    [...result.mediaAssetCandidates].sort(),
    ['cand-a', 'cand-b', 'cand-c', 'cand-shared'],
    '窗口期内新提交的引用必须进入候选集',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get('s-b1').n,
    0,
    'identity 删除必须级联清理该会话消息',
  );
  assert.equal(db.prepare('SELECT id FROM sessions WHERE id = ?').get('s-b1'), undefined);

  const released = await lifecycle.releaseCandidates(result.mediaAssetCandidates);
  assert.deepEqual(
    released.releasedAssets.map((asset) => asset.id).sort(),
    ['cand-a', 'cand-b', 'cand-c'],
    '级联释放候选，但仍被其它事实共享的 asset 必须保留',
  );
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('cand-shared').id,
    'cand-shared',
  );
  assert.equal(writer.canonicalKeys.has('catalog/media/cand-shared.bin'), true);
  assert.equal(writer.canonicalKeys.has('catalog/media/cand-a.bin'), false);
}

// ============================================================================
// B2. Group 级联删除：同样的同事务语义；群头像也进入候选集。
// ============================================================================
{
  const { db, writer, lifecycle, groups } = createHarness();
  db.prepare(`INSERT INTO group_chats (id, avatar_media_asset_id) VALUES ('g-1', 'group-avatar')`).run();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('g-1', 'group')`).run();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-other', 'direct')`).run();
  db.prepare('INSERT INTO session_vision_helpers (session_id) VALUES (?)').run('g-1');
  db.prepare('INSERT INTO group_chat_members (id, group_id) VALUES (?, ?)').run('m-1', 'g-1');

  for (const assetId of ['group-avatar', 'g-a', 'g-b', 'g-c', 'g-shared']) {
    insertAsset(db, assetId);
    writer.canonicalKeys.add(`catalog/media/${assetId}.bin`);
  }
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('g-1', JSON.stringify({ sticker: { mediaAssetId: 'g-a' } }));
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('g-1', JSON.stringify({ attachments: [{ mediaAssetId: 'g-b' }] }));
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('g-1', JSON.stringify({ attachments: [{ mediaAssetId: 'g-shared' }] }));
  db.prepare('INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)')
    .run('s-other', JSON.stringify({ attachments: [{ mediaAssetId: 'g-shared' }] }));

  const originalCollect = lifecycle.collectChatSessionMediaAssetCandidates.bind(lifecycle);
  let injected = false;
  lifecycle.collectChatSessionMediaAssetCandidates = async (sessionIds, executor) => {
    if (!injected) {
      injected = true;
      await executor.runAsync(
        'INSERT INTO messages (session_id, metadata_json) VALUES (?, ?)',
        [sessionIds[0], JSON.stringify({ attachments: [{ mediaAssetId: 'g-c' }] })],
      );
    }
    return originalCollect(sessionIds, executor);
  };

  const result = await groups.delete('g-1');
  assert.equal(result.deleted, true);
  assert.deepEqual(
    [...result.mediaAssetCandidates].sort(),
    ['g-a', 'g-b', 'g-c', 'g-shared', 'group-avatar'],
    '群头像与被级联删除的群消息引用都必须进入候选集',
  );
  assert.equal(db.prepare('SELECT id FROM group_chats WHERE id = ?').get('g-1'), undefined);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get('g-1').n,
    0,
  );

  const released = await lifecycle.releaseCandidates(result.mediaAssetCandidates);
  assert.deepEqual(
    released.releasedAssets.map((asset) => asset.id).sort(),
    ['g-a', 'g-b', 'g-c', 'group-avatar'],
    '共享资产必须保留，其余候选释放',
  );
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('g-shared').id,
    'g-shared',
  );
  assert.equal(writer.canonicalKeys.has('catalog/media/g-shared.bin'), true);

  // 重复删除：没有事务事实，不得给出任何候选。
  const again = await groups.delete('g-1');
  assert.deepEqual(again, { deleted: false, mediaAssetCandidates: [] });
}

// ============================================================================
// E. Chat 消息删除：候选必须来自 delete transaction 读取的当前 metadata
//
// 真实竞态来自 legacy attachment migration：它在 delete 之外用 CAS 把 legacy URI 改写成
// canonical mediaAssetId。候选若来自调用方早先读到的 snapshot，这次新写入的引用就会随
// 消息删除一起消失，却从未进入 release 候选 —— 消息没了、asset 留在 catalog/backing。
// ============================================================================

// E1. migration 先提交（删除链路读到的是旧 snapshot）→ 删除必须看到 canonical assetId，
//     release 之后 catalog 行 / backing / 引用都不留下 orphan。
{
  const { db, writer, lifecycle, messages, mediaRepository, legacyChatFiles } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-e1', 'direct')`).run();
  const messageId = insertLegacyAttachmentMessage(db, 's-e1', 'file:///legacy/e1.png');

  // T1：删除链路此刻读到的是 legacy 形态，没有任何 canonical 引用。
  const staleTarget = await messages.getMessageById(messageId);
  assert.equal(staleTarget.metadataJson.includes('localUri'), true, 'fixture：T1 读到 legacy URI');
  assert.equal(staleTarget.metadataJson.includes('mediaAssetId'), false);

  // T2：真实 legacy attachment migration 提交（asset 行 + metadata CAS 同一事务）。
  const migration = await chatAttachmentMigration.migrateLegacyChatAttachments({
    messages,
    mediaAssets: legacyChatFiles,
  });
  assert.equal(migration.migratedMessages, 1, 'fixture：migration 必须成功改写该消息');
  assert.equal(migration.unresolvedMessages, 0);

  const canonicalAssetId = JSON.parse(messageRow(db, messageId).metadata_json)
    .attachments[0].mediaAssetId;
  assert.equal(typeof canonicalAssetId, 'string');
  assert.equal((await mediaRepository.getById(canonicalAssetId)) !== null, true);

  // T1 继续：删除事务必须读到 T2 的引用。
  const result = await messages.deleteMessagesWithMediaCandidates([messageId]);
  assert.deepEqual(result.deletedMessageIds, [messageId], 'message 必须被删除');
  assert.deepEqual(
    result.mediaAssetCandidates,
    [canonicalAssetId],
    '候选必须来自 DELETE 事务的当前 metadata，而不是 T1 读到的旧 snapshot',
  );
  assert.equal(messageRow(db, messageId), undefined);

  const released = await lifecycle.releaseCandidates(result.mediaAssetCandidates);
  assert.deepEqual(released.releasedAssets.map((asset) => asset.id), [canonicalAssetId]);
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get(canonicalAssetId),
    undefined,
    'catalog 行必须被释放',
  );
  assert.equal(
    writer.canonicalKeys.has('catalog/media/adopted-e1.png.bin'),
    false,
    'backing 必须随 targeted release 一起删除',
  );

  const audit = await lifecycle.audit();
  assert.deepEqual(audit.orphanAssets, [], '不得留下 catalog orphan');
  assert.deepEqual(audit.danglingReferences, [], '不得留下 dangling reference');
  assert.deepEqual(audit.physicalOrphans, [], '不得留下 physical orphan');
}

// E2. delete 先提交 → migration 的 CAS 必须失败，且 asset 行随同一事务回滚，
//     绝不产生「已经失去业务引用的新 asset 事实」。
{
  const { db, writer, lifecycle, messages, legacyChatFiles } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-e2', 'direct')`).run();
  const messageId = insertLegacyAttachmentMessage(db, 's-e2', 'file:///legacy/e2.png');

  // 真实交错：migration 已经扫描到候选（候选来自删除之前的事实），CAS 发生在删除之后。
  const scannedCandidates = await messages.listChatAttachmentMetadataCandidates({ limit: 25 });
  assert.equal(scannedCandidates.length, 1, 'fixture：migration 必须先扫描到这个 legacy 候选');
  messages.listChatAttachmentMetadataCandidates = async () => scannedCandidates;

  const result = await messages.deleteMessagesWithMediaCandidates([messageId]);
  assert.deepEqual(result.deletedMessageIds, [messageId]);
  assert.deepEqual(
    result.mediaAssetCandidates,
    [],
    '删除先提交时该消息还没有 canonical 引用可以带走（legacy URI 不是 MediaAsset 引用）',
  );

  const migration = await chatAttachmentMigration.migrateLegacyChatAttachments({
    messages,
    mediaAssets: legacyChatFiles,
  });
  assert.equal(migration.migratedMessages, 0);
  assert.equal(migration.unresolvedMessages, 1, 'CAS 找不到目标行时必须显式失败');
  assert.equal(migration.issues[0].reason, 'commit_failed');
  assert.equal(messageRow(db, messageId), undefined);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n,
    0,
    'CAS 失败必须回滚 asset 行：不得产生一条已经失去业务引用的新 asset 事实',
  );

  // 失败 adoption 可能留下已 copy 的物理文件（真实 reserve-before-copy 语义），
  // 那属于 cleanup() 的 physical orphan 回收范围；这里断言的是数据库侧不留事实。
  assert.equal(writer.deletedKeys.length, 0);
  const audit = await lifecycle.audit();
  assert.deepEqual(audit.danglingReferences, [], '不得留下任何 dangling reference');
}

// E2b. 真实并发交错：migration CAS 在删除事务执行期间发起，coordinator 的单写者语义保证它
//      不可能插进「读取候选」与「DELETE」之间，最终只允许收敛到 delete-first 的合法终态。
{
  const { db, database, messages, lifecycle, legacyChatFiles } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-e7', 'direct')`).run();
  const messageId = insertLegacyAttachmentMessage(db, 's-e7', 'file:///legacy/e7.png');

  const scannedCandidates = await messages.listChatAttachmentMetadataCandidates({ limit: 25 });
  assert.equal(scannedCandidates.length, 1, 'fixture：migration 必须先扫描到这个 legacy 候选');
  messages.listChatAttachmentMetadataCandidates = async () => scannedCandidates;

  // 在删除事务真正读取候选的那一刻发起 migration：不 await，让它排到删除事务之后。
  const originalGetAllAsync = database.getAllAsync;
  let concurrentMigration = null;
  database.getAllAsync = async (sql, params = []) => {
    const rows = await originalGetAllAsync(sql, params);
    if (concurrentMigration === null && sql.includes('mediaAssetId')) {
      concurrentMigration = chatAttachmentMigration.migrateLegacyChatAttachments({
        messages,
        mediaAssets: legacyChatFiles,
      });
    }
    return rows;
  };

  const deletion = await messages.deleteMessagesWithMediaCandidates([messageId]);
  assert.equal(concurrentMigration !== null, true, 'fixture：并发 CAS 必须在删除事务执行期间发起');
  assert.deepEqual(deletion.deletedMessageIds, [messageId]);
  assert.deepEqual(
    deletion.mediaAssetCandidates,
    [],
    '并发 CAS 不可能插进「读取候选」与「DELETE」之间，因此删除看不到 canonical 引用',
  );

  const migration = await concurrentMigration;
  assert.equal(migration.migratedMessages, 0);
  assert.equal(migration.unresolvedMessages, 1);
  assert.equal(migration.issues[0].reason, 'commit_failed');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n,
    0,
    '并发 CAS 必须整体回滚：不得留下已经失去业务引用的 asset 行',
  );
  assert.equal(messageRow(db, messageId), undefined);
  assert.deepEqual((await lifecycle.audit()).danglingReferences, []);
}

// E3. 原消息、分享记录与引用快照都由最终 live 引用裁决释放。
for (const referenceKind of ['voice', 'sharedRecord', 'replyQuote']) {
  const { db, writer, lifecycle, messages } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-e3-deleted', 'direct')`).run();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-e3-live', 'direct')`).run();
  insertAsset(db, 'shared-del');
  writer.canonicalKeys.add('catalog/media/shared-del.bin');

  const deletedMessage = insertMetadataMessage(db, 's-e3-deleted', {
    attachments: [{ mediaAssetId: 'shared-del' }],
  });
  const liveMessage = insertMetadataMessage(db, 's-e3-live', referenceKind === 'sharedRecord' ? {
    kind: 'shared_record', sharedRecord: { entries: [{ attachments: [{ mediaAssetId: 'shared-del' }] }] },
  } : referenceKind === 'replyQuote' ? {
    replyQuote: { text: '', attachments: [{ mediaAssetId: 'shared-del' }], sticker: null, voice: null },
  } : { voice: { mediaAssetId: 'shared-del' } });

  const firstDeletion = await messages.deleteMessagesWithMediaCandidates([deletedMessage]);
  assert.deepEqual(
    firstDeletion.mediaAssetCandidates,
    ['shared-del'],
    '被删消息的引用必须进入候选（候选不裁决 asset 是否可删除）',
  );
  const keptRelease = await lifecycle.releaseCandidates(firstDeletion.mediaAssetCandidates);
  assert.deepEqual(keptRelease.releasedAssets, [], '另一个 live 消息仍引用它，必须保留');
  assert.equal(
    db.prepare('SELECT id FROM media_assets WHERE id = ?').get('shared-del').id,
    'shared-del',
  );
  assert.equal(writer.canonicalKeys.has('catalog/media/shared-del.bin'), true);

  const lastDeletion = await messages.deleteMessagesWithMediaCandidates([liveMessage]);
  assert.deepEqual(lastDeletion.mediaAssetCandidates, ['shared-del']);
  const finalRelease = await lifecycle.releaseCandidates(lastDeletion.mediaAssetCandidates);
  assert.deepEqual(finalRelease.releasedAssets.map((asset) => asset.id), ['shared-del']);
  assert.equal(writer.canonicalKeys.has('catalog/media/shared-del.bin'), false);
}

// E4. 四类 Chat 媒体引用形状都进入候选，且与 media 引用枚举给出同一集合。
for (const kind of ['attachment', 'thumbnail', 'voice', 'sticker']) {
  const { db, messages, mediaRepository } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES (?, 'direct')`).run(`s-e4-${kind}`);
  insertAsset(db, `del-${kind}`);

  const committed = await messages.commitMessage({
    message: metadataMessage(`s-e4-${kind}`, metadataForKind(kind, `del-${kind}`)),
    previewText: kind,
  });

  // media 侧的引用枚举看到什么，删除候选就必须是什么：两处判据必须是同一个语义。
  const audit = await mediaRepository.auditDatabase();
  const enumerated = [...new Set(
    audit.references
      .filter((reference) => reference.ownerId === String(committed.id))
      .map((reference) => reference.assetId),
  )].sort();
  assert.deepEqual(
    enumerated,
    [`del-${kind}`],
    `[${kind}] fixture 必须真实引用该 asset`,
  );

  const deletion = await messages.deleteMessagesWithMediaCandidates([committed.id]);
  assert.deepEqual(
    [...deletion.mediaAssetCandidates].sort(),
    enumerated,
    `[${kind}] 删除候选必须与 media 引用枚举一致`,
  );
}

// E5. 损坏 metadata：不猜测引用（候选为空），release 侧继续保守保留；
//     消息真正删除后引用事实已不可枚举，targeted release 才会释放它。
{
  const { db, writer, lifecycle, messages } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-e5', 'direct')`).run();
  insertAsset(db, 'broken-del');
  writer.canonicalKeys.add('catalog/media/broken-del.bin');
  const brokenMessageId = Number(db.prepare(
    'INSERT INTO messages (session_id, text, metadata_json) VALUES (?, ?, ?)',
  ).run('s-e5', '', '{"sticker":{"mediaAssetId":"broken-del"').lastInsertRowid);

  const keptBeforeDelete = await lifecycle.releaseCandidates(['broken-del']);
  assert.deepEqual(
    keptBeforeDelete.releasedAssets,
    [],
    '损坏 metadata 原文命中 asset id 时 release 必须保守保留',
  );

  const deletion = await messages.deleteMessagesWithMediaCandidates([brokenMessageId]);
  assert.deepEqual(deletion.deletedMessageIds, [brokenMessageId]);
  assert.deepEqual(
    deletion.mediaAssetCandidates,
    [],
    '损坏 JSON 无法建立可信引用，删除候选不得猜测任何 asset id',
  );

  const releasedAfterDelete = await lifecycle.releaseCandidates(['broken-del']);
  assert.deepEqual(
    releasedAfterDelete.releasedAssets.map((asset) => asset.id),
    ['broken-del'],
    '引用事实随消息消失后，targeted release 才会释放它',
  );
}

// E6. 删除 primitive 自身的返回语义：纯文本无候选、不存在的 id 被忽略、重复 id 去重且幂等。
{
  const { db, messages } = createHarness();
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('s-e6', 'direct')`).run();
  const textMessageId = Number(db.prepare(
    'INSERT INTO messages (session_id, text) VALUES (?, ?)',
  ).run('s-e6', '纯文本').lastInsertRowid);
  const mediaMessageId = insertMetadataMessage(db, 's-e6', {
    attachments: [{ mediaAssetId: 'plain-del' }],
  });

  assert.deepEqual(
    await messages.deleteMessagesWithMediaCandidates([textMessageId]),
    { deletedMessageIds: [textMessageId], mediaAssetCandidates: [] },
    '纯文本消息不得产生任何媒体候选',
  );

  assert.deepEqual(
    await messages.deleteMessagesWithMediaCandidates([mediaMessageId, mediaMessageId, mediaMessageId + 999]),
    { deletedMessageIds: [mediaMessageId], mediaAssetCandidates: ['plain-del'] },
    '重复 id 必须去重，不存在的 id 必须被忽略，候选只来自真正删除的行',
  );

  assert.deepEqual(
    await messages.deleteMessagesWithMediaCandidates([mediaMessageId]),
    { deletedMessageIds: [], mediaAssetCandidates: [] },
    '重复调用必须幂等返回空',
  );
  assert.deepEqual(
    await messages.deleteMessagesWithMediaCandidates([]),
    { deletedMessageIds: [], mediaAssetCandidates: [] },
    '空输入不得打开事务或产生候选',
  );
}

console.log(
  'MediaAsset reference closure：引用写入 fail-closed、release/引用 TOCTOU、级联候选同事务、'
  + '消息删除候选同事务（migration/delete 两种顺序、共享资产、四类引用形状、损坏 metadata）验证通过。',
);
