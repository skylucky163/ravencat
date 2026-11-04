/** MediaAsset catalog 的 SQLite adapter；事务边界由调用方负责。 */

import type {
  CoordinatedDatabaseExecutor,
  DatabaseReadExecutor,
  DatabaseWriteExecutor,
  DatabaseTransactionExecutor,
} from '@platform/persistence';

import type {
  MediaAsset,
  MediaAssetStatus,
  MediaHashAlgorithm,
} from '../domain/MediaAsset';
import type {
  MediaAssetHashCandidateQuery,
  MediaAssetRepository,
  MediaAssetStorageLocatorQuery,
  UpdateMediaAssetStatusInput,
} from '../domain/MediaAssetRepository';
import type {
  InvalidMediaAssetReferenceSource,
  MediaAssetDatabaseAudit,
  MediaAssetLifecycleRepository,
  MediaAssetReference,
  MediaAssetReferenceKind,
} from '../domain/MediaAssetLifecycle';

interface MediaAssetRow {
  id: string;
  storage_backend: string;
  storage_key: string;
  hash_algorithm: MediaHashAlgorithm;
  content_hash: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  status: MediaAssetStatus;
  created_at: string;
  updated_at: string;
}

const MEDIA_ASSET_COLUMNS = `
  id,
  storage_backend,
  storage_key,
  hash_algorithm,
  content_hash,
  mime_type,
  byte_size,
  width,
  height,
  duration_ms,
  status,
  created_at,
  updated_at
`;

function mapMediaAssetRow(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    storageBackend: row.storage_backend,
    storageKey: row.storage_key,
    hashAlgorithm: row.hash_algorithm,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface MediaAssetReferenceRow {
  asset_id: string;
  reference_kind: MediaAssetReferenceKind;
  owner_id: string | number;
  location: string;
}

interface InvalidChatMetadataRow {
  id: number;
  metadata_json: string;
}

const MEDIA_ASSET_LEGACY_REFERENCE_QUERY = `
  SELECT moments_cover_media_asset_id AS asset_id, 'moments_cover' AS reference_kind,
         id AS owner_id, 'user_profile.moments_cover_media_asset_id' AS location
  FROM user_profile WHERE moments_cover_media_asset_id IS NOT NULL
  UNION ALL
  SELECT media_asset_id AS asset_id, 'wallpaper' AS reference_kind,
         selection_key AS owner_id, 'profile_wallpaper_selections.media_asset_id' AS location
  FROM profile_wallpaper_selections WHERE media_asset_id IS NOT NULL
  UNION ALL
  SELECT media_asset_id AS asset_id, 'call_background' AS reference_kind,
         CAST(id AS TEXT) AS owner_id, 'call_background_selection.media_asset_id' AS location
  FROM call_background_selection WHERE media_asset_id IS NOT NULL
  UNION ALL
  SELECT avatar_media_asset_id AS asset_id, 'user_avatar' AS reference_kind,
         id AS owner_id, 'user_profile.avatar_media_asset_id' AS location
  FROM user_profile
  WHERE avatar_media_asset_id IS NOT NULL AND TRIM(avatar_media_asset_id) <> ''
  UNION ALL
  SELECT avatar_media_asset_id, 'assistant_avatar', id, 'ai_assistants.avatar_media_asset_id'
  FROM ai_assistants
  WHERE avatar_media_asset_id IS NOT NULL AND TRIM(avatar_media_asset_id) <> ''
  UNION ALL
  SELECT avatar_media_asset_id, 'group_avatar', id, 'group_chats.avatar_media_asset_id'
  FROM group_chats
  WHERE avatar_media_asset_id IS NOT NULL AND TRIM(avatar_media_asset_id) <> ''
  UNION ALL
  SELECT media_asset_id, 'moment_media', id, 'moment_media.media_asset_id'
  FROM moment_media
  WHERE TRIM(media_asset_id) <> ''
  UNION ALL
  SELECT media_asset_id, 'sticker', id, 'stickers.media_asset_id'
  FROM stickers
  WHERE TRIM(media_asset_id) <> ''
  UNION ALL
  SELECT media_asset_id, 'ai_download', id, 'ai_downloaded_images.media_asset_id'
  FROM ai_downloaded_images
  UNION ALL
  SELECT CAST(tree.value AS TEXT), 'chat_favorite', chat_favorites.id,
         'chat_favorites.snapshot_json:' || tree.fullkey
  FROM chat_favorites, json_tree(chat_favorites.snapshot_json) AS tree
  WHERE tree.type = 'text'
    AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
    AND TRIM(CAST(tree.value AS TEXT)) <> ''
  UNION ALL
  SELECT CAST(tree.value AS TEXT),
         CASE
           WHEN tree.key = 'thumbnailMediaAssetId' THEN 'chat_thumbnail'
           WHEN tree.fullkey LIKE '$.attachments[%].mediaAssetId' THEN 'chat_attachment'
           WHEN tree.fullkey = '$.voice.mediaAssetId' THEN 'chat_voice'
           WHEN tree.fullkey = '$.sticker.mediaAssetId' THEN 'chat_sticker'
           ELSE 'chat_attachment'
         END,
         messages.id,
         'messages.metadata_json:' || tree.fullkey
  FROM messages,
       json_tree(CASE
         WHEN json_valid(messages.metadata_json) = 1 THEN messages.metadata_json
         ELSE NULL
       END) AS tree
  WHERE messages.metadata_json IS NOT NULL
    AND json_valid(messages.metadata_json) = 1
    AND tree.type = 'text'
    AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
    AND TRIM(CAST(tree.value AS TEXT)) <> ''
`;

const MEDIA_ASSET_REPLY_VERSION_REFERENCE_QUERY = `${MEDIA_ASSET_LEGACY_REFERENCE_QUERY}
  UNION ALL
  SELECT CAST(tree.value AS TEXT), 'chat_reply_version', chat_reply_versions.id,
         'chat_reply_versions.snapshot_json:' || tree.fullkey
  FROM chat_reply_versions, json_tree(chat_reply_versions.snapshot_json) AS tree
  WHERE tree.type = 'text'
    AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
    AND TRIM(CAST(tree.value AS TEXT)) <> ''
`;

const MEDIA_ASSET_CALL_AUDIO_REFERENCE_QUERY = `${MEDIA_ASSET_REPLY_VERSION_REFERENCE_QUERY}
  UNION ALL
  SELECT media_asset_id, 'call_audio', id, 'call_history_entries.media_asset_id'
  FROM call_history_entries WHERE media_asset_id IS NOT NULL
`;

const MEDIA_ASSET_CALL_IMAGES_REFERENCE_QUERY = `${MEDIA_ASSET_CALL_AUDIO_REFERENCE_QUERY}
  UNION ALL
  SELECT media_asset_id, 'call_snapshot', id, 'call_history_images.media_asset_id'
  FROM call_history_images
`;

const MEDIA_ASSET_RINGTONE_REFERENCE_QUERY = `${MEDIA_ASSET_CALL_IMAGES_REFERENCE_QUERY}
  UNION ALL
  SELECT media_asset_id, 'call_ringtone', assistant_id || ':' || direction, 'call_ringtone_selection.media_asset_id'
  FROM call_ringtone_selection WHERE media_asset_id IS NOT NULL
`;

const MEDIA_ASSET_BUBBLE_SKIN_REFERENCE_QUERY = `${MEDIA_ASSET_RINGTONE_REFERENCE_QUERY}
  UNION ALL
  SELECT media_asset_id, 'chat_bubble_skin', role, 'chat_bubble_skins.media_asset_id'
  FROM chat_bubble_skins
`;

const MEDIA_ASSET_BUBBLE_DECORATION_REFERENCE_QUERY = `${MEDIA_ASSET_BUBBLE_SKIN_REFERENCE_QUERY}
  UNION ALL
  SELECT media_asset_id, 'chat_bubble_decoration', id, 'chat_bubble_decorations.media_asset_id'
  FROM chat_bubble_decorations
`;

const MEDIA_ASSET_BUBBLE_PRESET_REFERENCE_QUERY = `${MEDIA_ASSET_RINGTONE_REFERENCE_QUERY}
  UNION ALL
  SELECT media_asset_id, 'chat_bubble_skin', id, 'chat_bubble_presets.media_asset_id' FROM chat_bubble_presets
  UNION ALL
  SELECT media_asset_id, 'chat_bubble_decoration', id, 'chat_bubble_preset_decorations.media_asset_id' FROM chat_bubble_preset_decorations
`;

const MEDIA_ASSET_REFERENCE_QUERY = `${MEDIA_ASSET_BUBBLE_PRESET_REFERENCE_QUERY}
  UNION ALL
  SELECT media_asset_id, 'assistant_profile_cover', assistant_id, 'assistant_profile_covers.media_asset_id'
  FROM assistant_profile_covers
`;

/**
 * targeted release 的候选裁决：只对候选 asset id 探测全部引用源。
 *
 * 判据必须与 MEDIA_ASSET_REFERENCE_QUERY 一致（同样的四类 Chat metadata key、同样的
 * TRIM 非空要求），否则 targeted release 会释放一个仍然 live 的共享资产。
 * 损坏 metadata（json_valid = 0）同样按保守处理：只要原文包含该 asset id 就视为可能存在引用。
 */
const MEDIA_ASSET_CANDIDATE_UNREFERENCED_QUERY = `
  WITH candidate(asset_id) AS (VALUES {{VALUES}})
  SELECT candidate.asset_id AS asset_id
  FROM candidate
  WHERE NOT EXISTS (
          SELECT 1 FROM chat_bubble_preset_decorations
          WHERE chat_bubble_preset_decorations.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM chat_bubble_presets
          WHERE chat_bubble_presets.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM call_history_entries
          WHERE call_history_entries.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM call_history_images
          WHERE call_history_images.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM user_profile
          WHERE user_profile.moments_cover_media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM profile_wallpaper_selections
          WHERE profile_wallpaper_selections.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM call_background_selection
          WHERE call_background_selection.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM call_ringtone_selection
          WHERE call_ringtone_selection.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM user_profile
          WHERE user_profile.avatar_media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM ai_assistants
          WHERE ai_assistants.avatar_media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM assistant_profile_covers
          WHERE assistant_profile_covers.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM group_chats
          WHERE group_chats.avatar_media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM moment_media
          WHERE moment_media.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM stickers
          WHERE stickers.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM ai_downloaded_images
          WHERE ai_downloaded_images.media_asset_id = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM chat_favorites, json_tree(chat_favorites.snapshot_json) AS tree
          WHERE tree.type = 'text'
            AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
            AND TRIM(CAST(tree.value AS TEXT)) = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM chat_reply_versions, json_tree(chat_reply_versions.snapshot_json) AS tree
          WHERE tree.type = 'text'
            AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
            AND TRIM(CAST(tree.value AS TEXT)) = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1
          FROM messages,
               json_tree(CASE
                 WHEN json_valid(messages.metadata_json) = 1 THEN messages.metadata_json
                 ELSE NULL
               END) AS tree
          WHERE messages.metadata_json IS NOT NULL
            AND json_valid(messages.metadata_json) = 1
            AND messages.metadata_json LIKE '%' || candidate.asset_id || '%'
            AND tree.type = 'text'
            AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
            AND TRIM(CAST(tree.value AS TEXT)) = candidate.asset_id
        )
    AND NOT EXISTS (
          SELECT 1 FROM messages
          WHERE messages.metadata_json IS NOT NULL
            AND json_valid(messages.metadata_json) = 0
            AND instr(messages.metadata_json, candidate.asset_id) > 0
        )
`;

/** 级联删除前收集候选：只读给定 session 的消息，不解析其它会话的 metadata。 */
const CHAT_SESSION_MEDIA_ASSET_IDS_QUERY = `
  SELECT DISTINCT CAST(tree.value AS TEXT) AS asset_id
  FROM messages,
       json_tree(CASE
         WHEN json_valid(messages.metadata_json) = 1 THEN messages.metadata_json
         ELSE NULL
       END) AS tree
  WHERE messages.session_id IN ({{SESSIONS}})
    AND messages.metadata_json IS NOT NULL
    AND json_valid(messages.metadata_json) = 1
    AND tree.type = 'text'
    AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
    AND TRIM(CAST(tree.value AS TEXT)) <> ''
  UNION
  SELECT DISTINCT CAST(tree.value AS TEXT) AS asset_id
  FROM chat_reply_versions v JOIN chat_reply_version_sets s ON s.id = v.set_id,
       json_tree(v.snapshot_json) AS tree
  WHERE s.session_id IN ({{SESSIONS}})
    AND tree.type = 'text' AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
    AND TRIM(CAST(tree.value AS TEXT)) <> ''
  UNION
  SELECT e.media_asset_id FROM call_history_entries e JOIN call_sessions c ON c.id = e.call_id
  WHERE c.chat_session_id IN ({{SESSIONS}}) AND e.media_asset_id IS NOT NULL
  UNION
  SELECT i.media_asset_id FROM call_history_images i JOIN call_sessions c ON c.id = i.call_id
  WHERE c.chat_session_id IN ({{SESSIONS}})
`;

function buildPlaceholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/** CTE 的 VALUES 子句每行一个括号：`(?), (?)`，不是 `(?, ?)`。 */
function buildValueRows(count: number): string {
  return new Array(count).fill('(?)').join(', ');
}

/** 去重并丢弃空值：IN 查询的参数顺序必须稳定，空值不能变成永远不命中的占位符。 */
function normalizeIdentifierList(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized];
}

async function auditDatabaseWithExecutor(
  executor: DatabaseWriteExecutor,
): Promise<MediaAssetDatabaseAudit> {
  const assetRows = await executor.getAllAsync<MediaAssetRow>(
    `SELECT ${MEDIA_ASSET_COLUMNS} FROM media_assets ORDER BY created_at ASC, id ASC`,
  );
  const referenceRows = await executor.getAllAsync<MediaAssetReferenceRow>(
    MEDIA_ASSET_REFERENCE_QUERY,
  );
  const invalidRows = await executor.getAllAsync<InvalidChatMetadataRow>(
    `SELECT id, metadata_json
     FROM messages
     WHERE metadata_json IS NOT NULL
       AND TRIM(metadata_json) <> ''
       AND json_valid(metadata_json) = 0
     ORDER BY id ASC`,
  );

  const assets = assetRows.map(mapMediaAssetRow);
  const references: MediaAssetReference[] = referenceRows.map((row) => ({
    assetId: row.asset_id,
    kind: row.reference_kind,
    ownerId: String(row.owner_id),
    location: row.location,
  }));
  const referencedIds = new Set(references.map((reference) => reference.assetId));
  const assetIds = new Set(assets.map((asset) => asset.id));

  // 损坏 JSON 是 SQLite 边界输入。不能从中建立可信引用，但若原文精确包含 asset id，
  // 回收时保守保留该资产，避免用“解析失败 = 无引用”做危险 ownership 推断。
  const uncertainAssetIds = new Set<string>();
  for (const row of invalidRows) {
    for (const asset of assets) {
      if (row.metadata_json.includes(asset.id)) {
        uncertainAssetIds.add(asset.id);
      }
    }
  }

  const invalidReferenceSources: InvalidMediaAssetReferenceSource[] = invalidRows.map((row) => ({
    kind: 'chat_metadata',
    ownerId: String(row.id),
  }));

  return {
    assets,
    references,
    orphanAssets: assets.filter((asset) => (
      !referencedIds.has(asset.id) && !uncertainAssetIds.has(asset.id)
    )),
    danglingReferences: references.filter((reference) => !assetIds.has(reference.assetId)),
    invalidReferenceSources,
  };
}

/**
 * MediaAsset 只负责 catalog SQL。
 *
 * 写方法接收调用方已开启的 transaction，确保资产行能和业务引用在同一
 * SQLite transaction 中提交；adapter 不自行创建嵌套事务，也不接触 raw
 * SQLite connection。
 */
export class SQLiteMediaAssetRepository implements MediaAssetRepository, MediaAssetLifecycleRepository {
  constructor(private readonly database: CoordinatedDatabaseExecutor) {}

  /** 备份读取 snapshot 自己的引用，不拿活动库的新选择替代已经快照的事实。 */
  async listBackupAssets(executor: DatabaseReadExecutor): Promise<readonly MediaAsset[]> {
    // 恢复预检读取尚未升级的 staging 快照；版本表从 137 起存在，不能对旧备份执行新表查询。
    const version = await executor.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    // 143 的已安装库存在仅录音和含截图两种结构；恢复预检必须保留实际已有的图片引用。
    const hasCallImages = version!.user_version === 143
      && await executor.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'call_history_images'") !== null;
    const references = version!.user_version >= 165 ? MEDIA_ASSET_REFERENCE_QUERY
      : version!.user_version >= 154 ? MEDIA_ASSET_BUBBLE_PRESET_REFERENCE_QUERY
      : version!.user_version >= 153 ? MEDIA_ASSET_BUBBLE_DECORATION_REFERENCE_QUERY
      : version!.user_version >= 151 ? MEDIA_ASSET_BUBBLE_SKIN_REFERENCE_QUERY
      : version!.user_version >= 146 ? MEDIA_ASSET_RINGTONE_REFERENCE_QUERY
      : version!.user_version >= 144 || hasCallImages ? MEDIA_ASSET_CALL_IMAGES_REFERENCE_QUERY
      : version!.user_version === 143 ? MEDIA_ASSET_CALL_AUDIO_REFERENCE_QUERY
      : version!.user_version >= 137 ? MEDIA_ASSET_REPLY_VERSION_REFERENCE_QUERY : MEDIA_ASSET_LEGACY_REFERENCE_QUERY;
    const rows = await executor.getAllAsync<Omit<MediaAssetRow, 'id'> & { id: string | null; asset_id: string }>(`
      SELECT media_assets.*, referenced.asset_id
      FROM (SELECT DISTINCT asset_id FROM (${references})) AS referenced
      LEFT JOIN media_assets ON media_assets.id = referenced.asset_id
    `);
    return rows.map((row) => {
      if (row.id === null || row.status !== 'ready') throw new Error(`备份引用的媒体资产不可用：${row.asset_id}`);
      return mapMediaAssetRow({ ...row, id: row.id });
    });
  }

  async markMissingAssetsInTransaction(transaction: DatabaseTransactionExecutor, assets: readonly MediaAsset[]): Promise<void> {
    for (const asset of assets) {
      await transaction.runAsync(
        `UPDATE media_assets SET status = 'missing', updated_at = ?
         WHERE id = ? AND storage_backend = ? AND storage_key = ? AND status = 'ready'`,
        [new Date().toISOString(), asset.id, asset.storageBackend, asset.storageKey],
      );
    }
  }

  async getById(id: string): Promise<MediaAsset | null> {
    const row = await this.database.getFirstAsync<MediaAssetRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
       FROM media_assets
       WHERE id = ?
       LIMIT 1`,
      [id],
    );

    return row ? mapMediaAssetRow(row) : null;
  }

  async getByStorageLocatorInTransaction(
    transaction: DatabaseTransactionExecutor,
    query: MediaAssetStorageLocatorQuery,
  ): Promise<MediaAsset | null> {
    // fresh schema 已经用 UNIQUE(storage_backend, storage_key) 保证 locator 唯一；这里读两行
    // 是为了把历史库可能存在的重复身份暴露成不变量错误，而不是静默选中其中一行继续迁移。
    const rows = await transaction.getAllAsync<MediaAssetRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
       FROM media_assets
       WHERE storage_backend = ? AND storage_key = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 2`,
      [query.storageBackend, query.storageKey],
    );

    if (rows.length > 1) {
      throw new Error(
        `MediaAsset locator 必须唯一，发现重复身份：${query.storageBackend}/${query.storageKey}`,
      );
    }

    return rows[0] ? mapMediaAssetRow(rows[0]) : null;
  }

  async listHashCandidatesInTransaction(
    transaction: DatabaseTransactionExecutor,
    query: MediaAssetHashCandidateQuery,
  ): Promise<readonly MediaAsset[]> {
    return this.listHashCandidates(query, transaction);
  }

  async listHashCandidates(
    query: MediaAssetHashCandidateQuery,
    executor: DatabaseWriteExecutor = this.database,
  ): Promise<readonly MediaAsset[]> {
    const rows = await executor.getAllAsync<MediaAssetRow>(
      `SELECT ${MEDIA_ASSET_COLUMNS}
       FROM media_assets
       WHERE hash_algorithm = ? AND content_hash = ?
       ORDER BY created_at ASC, id ASC`,
      [query.hashAlgorithm, query.contentHash],
    );

    return rows.map(mapMediaAssetRow);
  }

  async createInTransaction(
    transaction: DatabaseTransactionExecutor,
    asset: MediaAsset,
  ): Promise<void> {
    await transaction.runAsync(
      `INSERT INTO media_assets (
         id,
         storage_backend,
         storage_key,
         hash_algorithm,
         content_hash,
         mime_type,
         byte_size,
         width,
         height,
         duration_ms,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        asset.id,
        asset.storageBackend,
        asset.storageKey,
        asset.hashAlgorithm,
        asset.contentHash,
        asset.mimeType,
        asset.byteSize,
        asset.width,
        asset.height,
        asset.durationMs,
        asset.status,
        asset.createdAt,
        asset.updatedAt,
      ],
    );
  }

  async updateStatusInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: UpdateMediaAssetStatusInput,
  ): Promise<void> {
    const result = await transaction.runAsync(
      `UPDATE media_assets
       SET status = ?, updated_at = ?
       WHERE id = ?`,
      [input.status, input.updatedAt, input.id],
    );

    if (result.changes !== 1) {
      throw new Error(
        `更新 MediaAsset 状态时必须恰好影响一行，实际影响 ${result.changes} 行：${input.id}`,
      );
    }
  }

  auditDatabase(executor: DatabaseWriteExecutor = this.database): Promise<MediaAssetDatabaseAudit> {
    return auditDatabaseWithExecutor(executor);
  }

  async hasAssetAtLocator(query: MediaAssetStorageLocatorQuery): Promise<boolean> {
    const row = await this.database.getFirstAsync<{ present: number }>(
      `SELECT 1 AS present
       FROM media_assets
       WHERE storage_backend = ? AND storage_key = ?
       LIMIT 1`,
      [query.storageBackend, query.storageKey],
    );

    return row !== null;
  }

  async releaseUnreferencedAssetsInTransaction(
    transaction: DatabaseTransactionExecutor,
    assetIds: readonly string[],
  ): Promise<readonly MediaAsset[]> {
    const candidates = normalizeIdentifierList(assetIds);
    if (candidates.length === 0) {
      return [];
    }

    const unreferencedRows = await transaction.getAllAsync<{ asset_id: string }>(
      MEDIA_ASSET_CANDIDATE_UNREFERENCED_QUERY.replace(
        '{{VALUES}}',
        buildValueRows(candidates.length),
      ),
      candidates,
    );
    if (unreferencedRows.length === 0) {
      return [];
    }

    const unreferencedIds = new Set(unreferencedRows.map((row) => row.asset_id));
    const released: MediaAsset[] = [];
    for (const assetId of candidates) {
      if (!unreferencedIds.has(assetId)) {
        continue;
      }

      const row = await transaction.getFirstAsync<MediaAssetRow>(
        `SELECT ${MEDIA_ASSET_COLUMNS}
         FROM media_assets
         WHERE id = ?
         LIMIT 1`,
        [assetId],
      );
      if (!row) {
        // 候选行在裁决与删除之间已经不存在（例如重复调用），没有可释放的 catalog 事实。
        continue;
      }

      const result = await transaction.runAsync(
        'DELETE FROM media_assets WHERE id = ?',
        [assetId],
      );
      if (result.changes !== 1) {
        throw new Error(
          `释放无引用 MediaAsset 时必须恰好影响一行，实际影响 ${result.changes} 行：${assetId}`,
        );
      }
      released.push(mapMediaAssetRow(row));
    }

    return released;
  }

  async listAssistantMediaAssetIds(assistantId: string, transaction: DatabaseTransactionExecutor): Promise<readonly string[]> {
    const rows = await transaction.getAllAsync<{ asset_id: string }>(`
      SELECT avatar_media_asset_id AS asset_id FROM ai_assistants
      WHERE id = ? AND avatar_media_asset_id IS NOT NULL
      UNION
      SELECT media_asset_id AS asset_id FROM assistant_profile_covers WHERE assistant_id = ?
      UNION
      SELECT media_asset_id AS asset_id FROM call_background_selection
      WHERE id = ? AND media_asset_id IS NOT NULL
      UNION
      SELECT media_asset_id AS asset_id FROM call_ringtone_selection
      WHERE assistant_id = ? AND media_asset_id IS NOT NULL
      UNION
      SELECT media_asset_id AS asset_id FROM stickers WHERE owner_assistant_id = ?
      UNION
      SELECT media_asset_id AS asset_id FROM ai_downloaded_images WHERE assistant_id = ?
      UNION
      SELECT e.media_asset_id AS asset_id FROM call_history_entries e JOIN call_history h ON h.call_id = e.call_id
      WHERE h.assistant_id = ? AND e.media_asset_id IS NOT NULL
      UNION
      SELECT i.media_asset_id AS asset_id FROM call_history_images i JOIN call_history h ON h.call_id = i.call_id
      WHERE h.assistant_id = ?
    `, [assistantId, assistantId, assistantId, assistantId, assistantId, assistantId, assistantId, assistantId]);
    return rows.map((row) => row.asset_id);
  }

  async listChatSessionMediaAssetIds(
    sessionIds: readonly string[],
    executor: DatabaseWriteExecutor = this.database,
  ): Promise<readonly string[]> {
    const sessions = normalizeIdentifierList(sessionIds);
    if (sessions.length === 0) {
      return [];
    }

    const rows = await executor.getAllAsync<{ asset_id: string }>(
      CHAT_SESSION_MEDIA_ASSET_IDS_QUERY.replaceAll('{{SESSIONS}}', buildPlaceholders(sessions.length)),
      [...sessions, ...sessions, ...sessions, ...sessions],
    );

    return rows.map((row) => row.asset_id);
  }

  async deleteOrphanAssetsInTransaction(
    transaction: DatabaseTransactionExecutor,
  ): Promise<readonly MediaAsset[]> {
    const audit = await this.auditDatabase(transaction);
    for (const asset of audit.orphanAssets) {
      const result = await transaction.runAsync(
        'DELETE FROM media_assets WHERE id = ?',
        [asset.id],
      );
      if (result.changes !== 1) {
        throw new Error(
          `删除 orphan MediaAsset 时必须恰好影响一行，实际影响 ${result.changes} 行：${asset.id}`,
        );
      }
    }
    return audit.orphanAssets;
  }
}
