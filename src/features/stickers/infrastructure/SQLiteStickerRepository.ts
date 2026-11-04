/** Sticker 收藏库的 SQLite adapter；所有 SQL 都经过 databaseCoordinator 调度。 */

import {
  CoordinatedDatabaseError,
  databaseCoordinator,
  type CoordinatedDatabaseExecutor,
  type DatabaseTransactionExecutor,
} from '@platform/persistence';
import {
  parseStickerTags,
  STICKER_GROUP_LIMIT,
  STICKER_LIBRARY_MAX_COUNT,
  STICKER_LIST_LIMIT,
  STICKER_RECENT_LIMIT,
  StickerAnnotationClaimLostError,
  StickerGroupNotFoundError,
  StickerLibraryFullError,
  StickerNotFoundError,
  type ListStickersInput,
  type SearchStickersInput,
  type Sticker,
  type StickerAnnotationClaim,
  type StickerAnnotationMetadata,
  type StickerAnnotationStatus,
  type StickerGroup,
  type StickerMetadataPatch,
} from '../domain/Sticker';
import type { StickerEmbedding } from '../domain/StickerEmbedding';
import type { StickerProcessingRow } from '../domain/StickerProcessing';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { StickerSystemConfig } from '../domain/StickerSystemConfig';
import type {
  CreateStickerGroupInput,
  ListStickersInGroupInput,
  StickerEmbeddingModelContext,
  StickerEmbeddingIndexControl,
  StickerEmbeddingRebuild,
  StickerGroupReadySummary,
  StickerRepository,
  StickerSemanticSearchInput,
} from '../domain/StickerRepository';

interface StickerRow {
  annotation_requested: number;
  id: string;
  media_asset_id: string;
  owner_assistant_id: string | null;
  group_id: string | null;
  name: string;
  description: string | null;
  tags_json: string;
  emotion: string | null;
  source_file_name: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  is_animated: number;
  is_favorite: number;
  use_count: number;
  last_used_at: string | null;
  annotation_status: StickerAnnotationStatus;
  annotation_error: string | null;
  annotation_claim_id: string | null;
  annotation_claimed_at: string | null;
  semantic_revision: number;
  created_at: string;
  updated_at: string;
}

interface StickerEmbeddingRow {
  sticker_id: string;
  model_config_id: string;
  model_config_updated_at: string;
  semantic_revision: number;
  dimension: number;
  vector_json: string;
  created_at: string;
  updated_at: string;
}

interface StickerGroupRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const STICKER_COLUMNS = `
  id,
  media_asset_id,
  owner_assistant_id,
  group_id,
  name,
  description,
  tags_json,
  emotion,
  source_file_name,
  mime_type,
  width,
  height,
  is_animated,
  is_favorite,
  use_count,
  last_used_at,
  annotation_status,
  annotation_error,
  annotation_claim_id,
  annotation_claimed_at,
  annotation_requested,
  semantic_revision,
  created_at,
  updated_at
`;

const GROUP_COLUMNS = `
  id,
  name,
  sort_order,
  created_at,
  updated_at
`;

function mapStickerRow(row: StickerRow): Sticker {
  return {
    id: row.id,
    mediaAssetId: row.media_asset_id,
    ownerAssistantId: row.owner_assistant_id,
    groupId: row.group_id,
    name: row.name,
    description: row.description,
    tags: parseStickerTags(row.tags_json),
    emotion: row.emotion,
    sourceFileName: row.source_file_name,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    isAnimated: row.is_animated === 1,
    isFavorite: row.is_favorite === 1,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    annotationStatus: row.annotation_status,
    annotationError: row.annotation_error,
    semanticRevision: row.semantic_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGroupRow(row: StickerGroupRow): StickerGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function limitFor(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(STICKER_LIST_LIMIT, Math.floor(value)));
}

function normalizeSearchTags(tags: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of tags ?? []) {
    const tag = value.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized.slice(0, 32);
}

function normalizeSearchText(value: string | undefined): string {
  return value?.trim() ?? '';
}

function buildStickerValues(sticker: Sticker): (string | number | null)[] {
  return [
    sticker.id,
    sticker.mediaAssetId,
    sticker.ownerAssistantId,
    sticker.groupId,
    sticker.name,
    sticker.description,
    JSON.stringify(sticker.tags),
    sticker.emotion,
    sticker.sourceFileName,
    sticker.mimeType,
    sticker.width,
    sticker.height,
    sticker.isAnimated ? 1 : 0,
    sticker.isFavorite ? 1 : 0,
    sticker.useCount,
    sticker.lastUsedAt,
    sticker.annotationStatus,
    sticker.annotationError,
    null,
    null,
    0,
    sticker.semanticRevision,
    sticker.createdAt,
    sticker.updatedAt,
  ];
}

function mapStickerEmbeddingRow(row: StickerEmbeddingRow): StickerEmbedding {
  let vector: number[];
  try {
    const parsed: unknown = JSON.parse(row.vector_json);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'number')) {
      throw new Error('vector 必须是数字数组');
    }
    vector = parsed;
  } catch (error) {
    throw new Error(`Sticker 向量数据损坏（sticker ${row.sticker_id}）：`, { cause: error });
  }
  return {
    stickerId: row.sticker_id,
    modelConfigId: row.model_config_id,
    modelConfigUpdatedAt: row.model_config_updated_at,
    semanticRevision: row.semantic_revision,
    dimension: row.dimension,
    vector,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * canonical 语义字段（name / description / tags / emotion）是否发生了实际变化。
 * 自动识别 complete 与手动编辑共用这一判定，保证同一条 revision 规则。
 */
export function semanticFieldsChanged(
  current: Sticker,
  next: { name: string; description: string | null; tags: string[]; emotion: string | null },
): boolean {
  return (
    current.name !== next.name
    || current.description !== next.description
    || current.emotion !== next.emotion
    || current.tags.length !== next.tags.length
    || current.tags.some((tag, index) => tag !== next.tags[index])
  );
}

/** 收藏仓储内部共用的业务错误恢复边界，不对 Feature 外公开。 */
export async function stickerTransaction<T>(database: CoordinatedDatabaseExecutor, operation: (tx: DatabaseTransactionExecutor) => Promise<T>): Promise<T> {
  try {
    return await database.withExclusiveTransactionAsync(operation);
  } catch (error) {
    // 两个收藏仓储共用事务出口，用户维护与 AI 收藏均保留同一业务错误契约。
    if (error instanceof CoordinatedDatabaseError && (
      error.cause instanceof StickerLibraryFullError || error.cause instanceof StickerNotFoundError
      || error.cause instanceof StickerGroupNotFoundError || error.cause instanceof StickerAnnotationClaimLostError
    )) throw error.cause;
    throw error;
  }
}

/** Sticker adapter 只持有已绑定 task metadata 的协调器 executor，不持有原始连接。 */
async function writeEmbedding(tx: DatabaseTransactionExecutor, embedding: StickerEmbedding): Promise<void> {
  await tx.runAsync(`INSERT INTO sticker_embeddings (
    sticker_id, model_config_id, model_config_updated_at, semantic_revision, dimension, vector_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sticker_id, model_config_id) DO UPDATE SET
    model_config_updated_at = excluded.model_config_updated_at, semantic_revision = excluded.semantic_revision,
    dimension = excluded.dimension, vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
  [embedding.stickerId, embedding.modelConfigId, embedding.modelConfigUpdatedAt, embedding.semanticRevision,
    embedding.dimension, JSON.stringify(embedding.vector), embedding.createdAt, embedding.updatedAt]);
}

export class SQLiteStickerRepository implements StickerRepository {
  constructor(
    private readonly database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({
      name: 'stickers.repository',
      feature: 'stickers',
      priority: 'runtime',
    }),
  ) {}

  async getStickerById(id: string, assistantId?: string): Promise<Sticker | null> {
    const row = await this.database.getFirstAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS} FROM stickers WHERE id = ? AND (owner_assistant_id IS NULL OR owner_assistant_id = ?) LIMIT 1`,
      [id, assistantId ?? null],
    );
    return row ? mapStickerRow(row) : null;
  }

  async getStickerByMediaAssetId(mediaAssetId: string): Promise<Sticker | null> {
    const row = await this.database.getFirstAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS} FROM stickers WHERE media_asset_id = ? AND owner_assistant_id IS NULL LIMIT 1`,
      [mediaAssetId],
    );
    return row ? mapStickerRow(row) : null;
  }

  async createStickerIfAbsent(sticker: Sticker): Promise<{ sticker: Sticker; reused: boolean }> {
    return stickerTransaction(this.database, async transaction => {
      const existing = await this.getStickerByMediaAssetIdInTransaction(
        transaction, sticker.mediaAssetId, sticker.ownerAssistantId,
      );
      if (existing) return { sticker: existing, reused: true };
      await this.createStickerInTransaction(transaction, sticker);
      return { sticker, reused: false };
    });
  }

  async listGroups(): Promise<StickerGroup[]> {
    const rows = await this.database.getAllAsync<StickerGroupRow>(
      `SELECT ${GROUP_COLUMNS}
       FROM sticker_groups
       ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC
       LIMIT ${STICKER_GROUP_LIMIT}`,
    );
    return rows.map(mapGroupRow);
  }

  async listUserStickerProcessing(context: StickerEmbeddingModelContext | null): Promise<StickerProcessingRow[]> {
    const rows = await this.database.getAllAsync<StickerRow & { has_embedding: number; embedding_error: string | null }>(
      `SELECT s.*, e.sticker_id IS NOT NULL AS has_embedding, f.error AS embedding_error
       FROM stickers s
       LEFT JOIN sticker_embeddings e ON e.sticker_id = s.id AND e.model_config_id = ?
         AND e.model_config_updated_at = ? AND e.semantic_revision = s.semantic_revision
       LEFT JOIN sticker_embedding_failures f ON f.sticker_id = s.id AND f.model_config_id = ?
         AND f.model_config_updated_at = ? AND f.semantic_revision = s.semantic_revision
       WHERE s.owner_assistant_id IS NULL ORDER BY s.created_at, s.id`,
      [context?.modelConfigId ?? null, context?.modelConfigUpdatedAt ?? null,
        context?.modelConfigId ?? null, context?.modelConfigUpdatedAt ?? null],
    );
    return rows.map(row => ({ sticker: mapStickerRow(row), annotationStartedAt: row.annotation_claimed_at, manuallyRequested: row.annotation_requested === 1,
      hasEmbedding: row.has_embedding === 1, embeddingError: row.embedding_error }));
  }

  async retryAnnotation(stickerId: string, updatedAt: string): Promise<void> {
    const result = await this.database.runAsync(
      `UPDATE stickers SET annotation_status = 'pending', annotation_error = NULL, annotation_requested = 1, updated_at = ?
       WHERE id = ? AND owner_assistant_id IS NULL AND annotation_status IN ('failed', 'pending', 'manual_required')
         AND annotation_requested = 0 AND is_animated = 0`,
      [updatedAt, stickerId],
    );
    if (result.changes !== 1) throw new Error('只能重试尚未完成且没有在处理的静态表情包');
  }

  async saveEmbeddingFailures(stickers: Sticker[], context: StickerEmbeddingModelContext, revision: number,
    buildId: string | null, error: string, updatedAt: string, signal: AbortSignal): Promise<void> {
    await stickerTransaction(this.database, async tx => {
      throwIfAbortSignalAborted(signal);
      const control = await tx.getFirstAsync<{ revision: number; build_id: string | null }>(
        'SELECT revision, build_id FROM sticker_embedding_index_control WHERE id = 1');
      // 错误也属于请求结果，旧模型、旧任务或已编辑素材的错误不能污染当前状态。
      if (control!.revision !== revision || control!.build_id !== buildId) return;
      for (const sticker of stickers) {
        await tx.runAsync(`INSERT INTO sticker_embedding_failures
          (sticker_id, model_config_id, model_config_updated_at, semantic_revision, error, updated_at)
          SELECT id, ?, ?, semantic_revision, ?, ? FROM stickers
          WHERE id = ? AND owner_assistant_id IS NULL AND annotation_status = 'ready' AND semantic_revision = ?
          ON CONFLICT(sticker_id) DO UPDATE SET model_config_id = excluded.model_config_id,
            model_config_updated_at = excluded.model_config_updated_at, semantic_revision = excluded.semantic_revision,
            error = excluded.error, updated_at = excluded.updated_at`,
        [context.modelConfigId, context.modelConfigUpdatedAt, error, updatedAt, sticker.id, sticker.semanticRevision]);
      }
      throwIfAbortSignalAborted(signal);
    });
  }

  async clearEmbeddingFailures(context: StickerEmbeddingModelContext, stickerId?: string): Promise<void> {
    await this.database.runAsync(`DELETE FROM sticker_embedding_failures WHERE model_config_id = ?
      AND model_config_updated_at = ? AND sticker_id IN (SELECT id FROM stickers WHERE owner_assistant_id IS NULL)
      ${stickerId === undefined ? '' : 'AND sticker_id = ?'}`,
    [context.modelConfigId, context.modelConfigUpdatedAt, ...(stickerId === undefined ? [] : [stickerId])]);
  }

  async listStickers(input: ListStickersInput = {}): Promise<Sticker[]> {
    const mode = input.mode ?? 'all';
    const limit = limitFor(input.limit, mode === 'recent' ? STICKER_RECENT_LIMIT : STICKER_LIST_LIMIT);
    const where: string[] = ['owner_assistant_id IS NULL'];
    const params: (string | number)[] = [];

    if (mode === 'favorites') {
      where.push('is_favorite = 1');
    } else if (mode === 'recent') {
      where.push('last_used_at IS NOT NULL');
    }
    appendGroupFilter(where, params, input.groupId);

    const orderBy = mode === 'recent'
      ? 'last_used_at DESC, use_count DESC, id ASC'
      : 'created_at DESC, id ASC';
    const rows = await this.database.getAllAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS}
       FROM stickers
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${orderBy}
       LIMIT ${limit}`,
      params,
    );
    return rows.map(mapStickerRow);
  }

  async searchStickers(input: SearchStickersInput): Promise<Sticker[]> {
    const limit = limitFor(input.limit, 100);
    const { where, params, tags } = buildStickerSearchFilters(input);

    const rows = await this.database.getAllAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS}
       FROM stickers
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY is_favorite DESC, use_count DESC, last_used_at DESC, id ASC
       LIMIT ${limit}`,
      params,
    );
    return rows
      .map(mapStickerRow)
      .filter((sticker) => tags.every((tag) => sticker.tags.includes(tag)));
  }

  /**
   * 语义检索候选集：只按结构化条件过滤，不设 LIMIT——候选数量由收藏库总量
   * 上限（STICKER_LIBRARY_MAX_COUNT）决定，不能被 UI 列表分页上限截断。
   * 过滤语义与 searchStickers 完全共用，避免两条路径取到不同的集合。
   */
  async listReadyStickersForSemanticSearch(
    input: StickerSemanticSearchInput,
  ): Promise<Sticker[]> {
    const { where, params, tags } = buildStickerSearchFilters({
      readyOnly: true,
      assistantId: input.assistantId,
      groupId: input.groupId,
      tags: input.tags,
      emotion: input.emotion,
    });
    const rows = await this.database.getAllAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS}
       FROM stickers
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id ASC`,
      params,
    );
    return rows
      .map(mapStickerRow)
      .filter((sticker) => tags.every((tag) => sticker.tags.includes(tag)));
  }

  async getStickerByIdInTransaction(
    transaction: DatabaseTransactionExecutor,
    id: string,
    ownerAssistantId: string | null = null,
  ): Promise<Sticker | null> {
    const row = await transaction.getFirstAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS} FROM stickers WHERE id = ? AND owner_assistant_id IS ? LIMIT 1`,
      [id, ownerAssistantId],
    );
    return row ? mapStickerRow(row) : null;
  }

  async getStickerByMediaAssetIdInTransaction(
    transaction: DatabaseTransactionExecutor,
    mediaAssetId: string,
    ownerAssistantId: string | null = null,
  ): Promise<Sticker | null> {
    const row = await transaction.getFirstAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS} FROM stickers WHERE media_asset_id = ? AND owner_assistant_id IS ? LIMIT 1`,
      [mediaAssetId, ownerAssistantId],
    );
    return row ? mapStickerRow(row) : null;
  }

  async getGroupByIdInTransaction(
    transaction: DatabaseTransactionExecutor,
    id: string,
  ): Promise<StickerGroup | null> {
    const row = await transaction.getFirstAsync<StickerGroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM sticker_groups WHERE id = ? LIMIT 1`,
      [id],
    );
    return row ? mapGroupRow(row) : null;
  }

  async createStickerInTransaction(
    transaction: DatabaseTransactionExecutor,
    sticker: Sticker,
  ): Promise<void> {
    // 收藏库容量是集合级数据不变量，必须在与 insert 相同的事务里判定：
    // 否则并发导入会各自读到 499 然后一起写入。重复内容的复用由调用方在本事务
    // 内先按 media_asset_id 命中既有 Sticker，不会走到这里，因此不会误报。
    const currentCount = await this.countStickersInTransaction(transaction, sticker.ownerAssistantId);
    if (currentCount >= STICKER_LIBRARY_MAX_COUNT) {
      throw new StickerLibraryFullError(STICKER_LIBRARY_MAX_COUNT);
    }
    const values = buildStickerValues(sticker);
    await transaction.runAsync(
      `INSERT INTO stickers (${STICKER_COLUMNS}) VALUES (${values.map(() => '?').join(', ')})`, values,
    );
  }

  async countStickersInTransaction(
    transaction: DatabaseTransactionExecutor,
    ownerAssistantId: string | null = null,
  ): Promise<number> {
    const row = await transaction.getFirstAsync<{ total: number }>(
      'SELECT COUNT(*) AS total FROM stickers WHERE owner_assistant_id IS ?', [ownerAssistantId],
    );
    return row?.total ?? 0;
  }

  async createGroup(input: CreateStickerGroupInput): Promise<StickerGroup> {
    await stickerTransaction(this.database, async (transaction) => {
      await transaction.runAsync(
        `INSERT INTO sticker_groups (id, name, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.id, input.name, input.sortOrder, input.createdAt, input.updatedAt],
      );
    });
    return {
      id: input.id,
      name: input.name,
      sortOrder: input.sortOrder,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
  }

  async renameGroup(id: string, name: string, updatedAt: string): Promise<StickerGroup> {
    return stickerTransaction(this.database, async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE sticker_groups SET name = ?, updated_at = ? WHERE id = ?`,
        [name, updatedAt, id],
      );
      if (result.changes !== 1) {
        throw new StickerGroupNotFoundError(id);
      }
      const group = await this.getGroupByIdInTransaction(transaction, id);
      if (!group) throw new StickerGroupNotFoundError(id);
      return group;
    });
  }

  async deleteGroup(id: string, updatedAt: string): Promise<boolean> {
    return stickerTransaction(this.database, async (transaction) => {
      // 显式清空引用，避免旧库 foreign_keys 配置差异改变业务语义。
      await transaction.runAsync(
        `UPDATE stickers SET group_id = NULL, updated_at = ? WHERE group_id = ?`,
        [updatedAt, id],
      );
      const result = await transaction.runAsync(
        `DELETE FROM sticker_groups WHERE id = ?`,
        [id],
      );
      return result.changes > 0;
    });
  }

  async updateStickerMetadata(
    id: string,
    patch: StickerMetadataPatch,
    updatedAt: string,
    ownerAssistantId: string | null = null,
    guard?: (transaction: DatabaseTransactionExecutor) => Promise<void>,
  ): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      if (guard) await guard(transaction);
      const current = await this.getStickerByIdInTransaction(transaction, id, ownerAssistantId);
      if (!current) throw new StickerNotFoundError(id);
      const nextName = patch.name ?? current.name;
      const nextDescription = patch.description === undefined
        ? current.description
        : patch.description;
      const nextTags = patch.tags === undefined
        ? current.tags
        : [...patch.tags];
      const nextEmotion = patch.emotion === undefined ? current.emotion : patch.emotion;
      const bumpRevision = semanticFieldsChanged(current, {
        name: nextName,
        description: nextDescription,
        tags: nextTags,
        emotion: nextEmotion,
      });
      await transaction.runAsync(
        `UPDATE stickers
         SET name = ?, description = ?, tags_json = ?, emotion = ?,
             semantic_revision = CASE WHEN ? THEN semantic_revision + 1 ELSE semantic_revision END,
             updated_at = ?, annotation_status = ?, annotation_error = NULL,
             annotation_claim_id = NULL, annotation_claimed_at = NULL, annotation_requested = 0
         WHERE id = ?`,
        [
          nextName,
          nextDescription,
          JSON.stringify(nextTags),
          nextEmotion,
          bumpRevision ? 1 : 0,
          updatedAt,
          ownerAssistantId !== null || current.annotationStatus === 'ready' || nextDescription ? 'ready' : 'manual_required',
          id,
        ],
      );
      const updated = await this.getStickerByIdInTransaction(transaction, id, ownerAssistantId);
      if (ownerAssistantId !== null) await transaction.runAsync(
        "UPDATE ai_sticker_tasks SET status = 'cancelled', error = NULL, updated_at = ? WHERE sticker_id = ? AND status = 'processing'", [updatedAt, id]);
      if (!updated) throw new StickerNotFoundError(id);
      return updated;
    });
  }

  async setStickerFavorite(
    id: string,
    isFavorite: boolean | null,
    updatedAt: string,
  ): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      const current = await this.getStickerByIdInTransaction(transaction, id);
      if (!current) throw new StickerNotFoundError(id);
      const next = isFavorite ?? !current.isFavorite;
      await transaction.runAsync(
        `UPDATE stickers SET is_favorite = ?, updated_at = ? WHERE id = ?`,
        [next ? 1 : 0, updatedAt, id],
      );
      const updated = await this.getStickerByIdInTransaction(transaction, id);
      if (!updated) throw new StickerNotFoundError(id);
      return updated;
    });
  }

  async moveSticker(id: string, groupId: string | null, updatedAt: string): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      const current = await this.getStickerByIdInTransaction(transaction, id);
      if (!current) throw new StickerNotFoundError(id);
      if (groupId && !(await this.getGroupByIdInTransaction(transaction, groupId))) {
        throw new StickerGroupNotFoundError(groupId);
      }
      await transaction.runAsync(
        `UPDATE stickers SET group_id = ?, updated_at = ? WHERE id = ?`,
        [groupId, updatedAt, id],
      );
      const updated = await this.getStickerByIdInTransaction(transaction, id);
      if (!updated) throw new StickerNotFoundError(id);
      return updated;
    });
  }

  async deleteSticker(id: string, ownerAssistantId: string | null = null, guard?: (transaction: DatabaseTransactionExecutor) => Promise<void>): Promise<boolean> {
    return stickerTransaction(this.database, async transaction => {
      if (guard) await guard(transaction);
      const result = await transaction.runAsync(
        'DELETE FROM stickers WHERE id = ? AND owner_assistant_id IS ?', [id, ownerAssistantId]);
      return result.changes === 1;
    });
  }

  async recordStickerUse(id: string, usedAt: string): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE stickers
         SET use_count = use_count + 1, last_used_at = ?, updated_at = ?
         WHERE id = ? AND owner_assistant_id IS NULL`,
        [usedAt, usedAt, id],
      );
      if (result.changes !== 1) throw new StickerNotFoundError(id);
      const updated = await this.getStickerByIdInTransaction(transaction, id);
      if (!updated) throw new StickerNotFoundError(id);
      return updated;
    });
  }

  async claimNextAnnotation(
    claimId: string,
    claimedAt: string,
  ): Promise<StickerAnnotationClaim | null> {
    return stickerTransaction(this.database, async (transaction) => {
      const candidate = await transaction.getFirstAsync<StickerRow>(
        `SELECT ${STICKER_COLUMNS}
         FROM stickers
         WHERE annotation_status = 'pending' AND owner_assistant_id IS NULL
           AND (annotation_requested = 1 OR (SELECT automatic_recognition_enabled FROM sticker_system_config WHERE id = 'global') = 1)
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      );
      if (!candidate) return null;

      const claimed = await transaction.runAsync(
        `UPDATE stickers
         SET annotation_status = 'processing', annotation_claim_id = ?,
             annotation_claimed_at = ?, updated_at = ?
         WHERE id = ? AND annotation_status = 'pending'`,
        [claimId, claimedAt, claimedAt, candidate.id],
      );
      if (claimed.changes !== 1) return null;
      const sticker = await this.getStickerByIdInTransaction(transaction, candidate.id);
      if (!sticker) throw new StickerNotFoundError(candidate.id);
      return { sticker, claimId, claimedAt, manual: candidate.annotation_requested === 1 };
    });
  }

  async completeAnnotation(
    stickerId: string,
    claimId: string,
    metadata: StickerAnnotationMetadata,
    updatedAt: string,
  ): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      const current = await this.getStickerByIdInTransaction(transaction, stickerId);
      if (!current) throw new StickerNotFoundError(stickerId);
      const nextName = metadata.name ?? current.name;
      const nextDescription = metadata.description === undefined
        ? current.description
        : metadata.description;
      const nextTags = metadata.tags === undefined ? current.tags : [...metadata.tags];
      const nextEmotion = metadata.emotion === undefined ? current.emotion : metadata.emotion;
      // 自动识别完成与手动编辑共用同一条 revision 规则：canonical 语义字段实际
      // 变化才 +1。识别结果与原值相同时不递增，避免无意义地把向量判为 stale。
      const bumpRevision = semanticFieldsChanged(current, {
        name: nextName,
        description: nextDescription,
        tags: nextTags,
        emotion: nextEmotion,
      });
      const result = await transaction.runAsync(
        `UPDATE stickers
         SET name = ?, description = ?, tags_json = ?, emotion = ?,
             semantic_revision = CASE WHEN ? THEN semantic_revision + 1 ELSE semantic_revision END,
             annotation_status = 'ready', annotation_error = NULL, annotation_requested = 0,
             annotation_claim_id = NULL, annotation_claimed_at = NULL,
             updated_at = ?
         WHERE id = ? AND annotation_status = 'processing' AND annotation_claim_id = ?`,
        [
          nextName,
          nextDescription,
          JSON.stringify(nextTags),
          nextEmotion,
          bumpRevision ? 1 : 0,
          updatedAt,
          stickerId,
          claimId,
        ],
      );
      if (result.changes !== 1) throw new StickerAnnotationClaimLostError(stickerId);
      const updated = await this.getStickerByIdInTransaction(transaction, stickerId);
      if (!updated) throw new StickerNotFoundError(stickerId);
      return updated;
    });
  }

  async completeAnnotationManually(
    stickerId: string,
    metadata: StickerAnnotationMetadata,
    updatedAt: string,
  ): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      const current = await this.getStickerByIdInTransaction(transaction, stickerId);
      if (!current) throw new StickerNotFoundError(stickerId);
      // 手动完成标注同样遵守 canonical 语义字段实际变化才递增 revision 的规则。
      const nextName = metadata.name ?? current.name;
      const nextDescription = metadata.description === undefined
        ? current.description
        : metadata.description;
      const nextTags = metadata.tags === undefined ? current.tags : [...metadata.tags];
      const nextEmotion = metadata.emotion === undefined ? current.emotion : metadata.emotion;
      const bumpRevision = semanticFieldsChanged(current, {
        name: nextName,
        description: nextDescription,
        tags: nextTags,
        emotion: nextEmotion,
      });
      const result = await transaction.runAsync(
        `UPDATE stickers
         SET name = ?, description = ?, tags_json = ?, emotion = ?,
             semantic_revision = CASE WHEN ? THEN semantic_revision + 1 ELSE semantic_revision END,
             annotation_status = 'ready', annotation_error = NULL, annotation_requested = 0,
             annotation_claim_id = NULL, annotation_claimed_at = NULL,
             updated_at = ?
         WHERE id = ?`,
        [
          nextName,
          nextDescription,
          JSON.stringify(nextTags),
          nextEmotion,
          bumpRevision ? 1 : 0,
          updatedAt,
          stickerId,
        ],
      );
      if (result.changes !== 1) throw new StickerNotFoundError(stickerId);
      const updated = await this.getStickerByIdInTransaction(transaction, stickerId);
      if (!updated) throw new StickerNotFoundError(stickerId);
      return updated;
    });
  }

  async failAnnotation(
    stickerId: string,
    claimId: string,
    error: string,
    updatedAt: string,
  ): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE stickers
         SET annotation_status = 'failed', annotation_error = ?, annotation_requested = 0,
             annotation_claim_id = NULL, annotation_claimed_at = NULL,
             updated_at = ?
         WHERE id = ? AND annotation_status = 'processing' AND annotation_claim_id = ?`,
        [error, updatedAt, stickerId, claimId],
      );
      if (result.changes !== 1) {
        const current = await this.getStickerByIdInTransaction(transaction, stickerId);
        if (!current) throw new StickerNotFoundError(stickerId);
        throw new StickerAnnotationClaimLostError(stickerId);
      }
      const updated = await this.getStickerByIdInTransaction(transaction, stickerId);
      if (!updated) throw new StickerNotFoundError(stickerId);
      return updated;
    });
  }

  async releaseAnnotation(
    stickerId: string,
    claimId: string,
    updatedAt: string,
  ): Promise<Sticker> {
    return stickerTransaction(this.database, async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE stickers
         SET annotation_status = 'pending', annotation_error = NULL,
             annotation_claim_id = NULL, annotation_claimed_at = NULL,
             updated_at = ?
         WHERE id = ? AND annotation_status = 'processing' AND annotation_claim_id = ?`,
        [updatedAt, stickerId, claimId],
      );
      if (result.changes !== 1) {
        const current = await this.getStickerByIdInTransaction(transaction, stickerId);
        if (!current) throw new StickerNotFoundError(stickerId);
        throw new StickerAnnotationClaimLostError(stickerId);
      }
      const updated = await this.getStickerByIdInTransaction(transaction, stickerId);
      if (!updated) throw new StickerNotFoundError(stickerId);
      return updated;
    });
  }

  async recoverInterruptedAnnotationClaims(updatedAt: string): Promise<number> {
    return stickerTransaction(this.database, async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE stickers
         SET annotation_status = 'pending', annotation_error = NULL,
             annotation_claim_id = NULL, annotation_claimed_at = NULL,
             updated_at = ?
         WHERE owner_assistant_id IS NULL AND annotation_status = 'processing'`,
        [updatedAt],
      );
      return result.changes;
    });
  }

  // -- Sticker System 业务级模型配置 --

  async getStickerSystemConfig(): Promise<StickerSystemConfig | null> {
    const row = await this.database.getFirstAsync<{
      recognition_model_config_id: string | null;
      embedding_model_config_id: string | null;
      automatic_recognition_enabled: number;
      updated_at: string;
    }>(
      `SELECT recognition_model_config_id, embedding_model_config_id, automatic_recognition_enabled, updated_at
       FROM sticker_system_config WHERE id = 'global' LIMIT 1`,
    );
    if (!row) return null;
    return {
      automaticRecognitionEnabled: row.automatic_recognition_enabled === 1,
      recognitionModelConfigId: row.recognition_model_config_id,
      embeddingModelConfigId: row.embedding_model_config_id,
      updatedAt: row.updated_at,
    };
  }

  /** 两种能力独立首次初始化，不能写回另一种能力的旧快照。 */
  async initializeSystemModelInTransaction(transaction: DatabaseTransactionExecutor, requirement: 'ocr' | 'embedding', modelConfigId: string, now: string): Promise<void> {
    const column = requirement === 'ocr' ? 'recognition_model_config_id' : 'embedding_model_config_id';
    await transaction.runAsync(`INSERT INTO sticker_system_config (id, ${column}, created_at, updated_at)
      VALUES ('global', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      ${column} = excluded.${column}, updated_at = excluded.updated_at
      WHERE sticker_system_config.${column} IS NULL`, [modelConfigId, now, now]);
  }

  async saveStickerSystemConfig(config: StickerSystemConfig, updatedAt: string): Promise<void> {
    await stickerTransaction(this.database, async (transaction) => {
      await transaction.runAsync(`UPDATE sticker_embedding_index_control SET revision = revision + 1, build_id = NULL
        WHERE id = 1 AND (SELECT embedding_model_config_id FROM sticker_system_config WHERE id = 'global') IS NOT ?`, [config.embeddingModelConfigId]);
      await transaction.runAsync(
        `INSERT INTO sticker_system_config (
           id, recognition_model_config_id, embedding_model_config_id, created_at, updated_at
         ) VALUES ('global', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           recognition_model_config_id = excluded.recognition_model_config_id,
           embedding_model_config_id = excluded.embedding_model_config_id,
           updated_at = excluded.updated_at`,
        [
          config.recognitionModelConfigId,
          config.embeddingModelConfigId,
          updatedAt,
          updatedAt,
        ],
      );
    });
  }

  // -- 语义向量索引 --

  async setAutomaticRecognitionEnabled(enabled: boolean, updatedAt: string): Promise<void> {
    await stickerTransaction(this.database, async tx => {
      await tx.runAsync(`INSERT INTO sticker_system_config (id, automatic_recognition_enabled, created_at, updated_at)
        VALUES ('global', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET automatic_recognition_enabled = excluded.automatic_recognition_enabled,
        updated_at = excluded.updated_at`, [enabled ? 1 : 0, updatedAt, updatedAt]);
      if (!enabled) await tx.runAsync(`UPDATE stickers SET annotation_status = 'pending', annotation_claim_id = NULL,
        annotation_claimed_at = NULL, updated_at = ? WHERE owner_assistant_id IS NULL AND annotation_status = 'processing' AND annotation_requested = 0`, [updatedAt]);
    });
  }

  async restoreEmbeddingIndexPublication(context: StickerEmbeddingModelContext, expectedRevision: number): Promise<void> {
    await stickerTransaction(this.database, async tx => {
      const result = await tx.runAsync(`UPDATE sticker_embedding_index_control SET published_model_id = ?, published_model_updated_at = ?
        WHERE id = 1 AND revision = ? AND build_id IS NULL AND selected_model_id = ? AND selected_model_updated_at = ?
          AND EXISTS (SELECT 1 FROM sticker_embeddings e JOIN stickers s ON s.id = e.sticker_id
            WHERE s.owner_assistant_id IS NULL AND s.annotation_status = 'ready' AND e.model_config_id = ?
              AND e.model_config_updated_at = ? AND e.semantic_revision = s.semantic_revision)`,
        [context.modelConfigId, context.modelConfigUpdatedAt, expectedRevision, context.modelConfigId, context.modelConfigUpdatedAt,
          context.modelConfigId, context.modelConfigUpdatedAt]);
      if (result.changes !== 1) throw new Error('当前模型没有可恢复的匹配索引，请手动重建全部索引');
    });
  }

  async invalidateEmbeddingModelInTransaction(tx: DatabaseTransactionExecutor, modelConfigId: string): Promise<void> {
    await tx.runAsync(`UPDATE sticker_embedding_index_control SET revision = revision + 1, build_id = NULL
      WHERE id = 1 AND EXISTS (SELECT 1 FROM sticker_system_config WHERE embedding_model_config_id = ?)`, [modelConfigId]);
  }

  async syncEmbeddingModel(context: StickerEmbeddingModelContext | null, expectedRevision: number): Promise<number | null> {
    return stickerTransaction(this.database, async tx => {
      const state = await tx.getFirstAsync<{ revision: number; selected_model_id: string | null; selected_model_updated_at: string | null }>('SELECT revision, selected_model_id, selected_model_updated_at FROM sticker_embedding_index_control WHERE id = 1');
      if (state!.revision !== expectedRevision) return null;
      if (state!.selected_model_id === (context?.modelConfigId ?? null) && state!.selected_model_updated_at === (context?.modelConfigUpdatedAt ?? null)) return expectedRevision;
      await tx.runAsync('UPDATE sticker_embedding_index_control SET revision = revision + 1, build_id = NULL, selected_model_id = ?, selected_model_updated_at = ? WHERE id = 1', [context?.modelConfigId ?? null, context?.modelConfigUpdatedAt ?? null]);
      return expectedRevision + 1;
    });
  }

  async getEmbeddingIndexControl() {
    return (await this.database.getFirstAsync<StickerEmbeddingIndexControl>(
      'SELECT revision, build_id AS buildId, published_model_id AS publishedModelId, published_model_updated_at AS publishedModelUpdatedAt FROM sticker_embedding_index_control WHERE id = 1'))!;
  }

  async beginEmbeddingRebuild(id: string, context: StickerEmbeddingModelContext, expectedRevision: number) {
    return stickerTransaction(this.database, async tx => {
      const state = await tx.getFirstAsync<{ revision: number; selected_model_id: string | null; selected_model_updated_at: string | null }>('SELECT revision, selected_model_id, selected_model_updated_at FROM sticker_embedding_index_control WHERE id = 1');
      if (state!.revision !== expectedRevision || state!.selected_model_id !== context.modelConfigId || state!.selected_model_updated_at !== context.modelConfigUpdatedAt) throw new Error('向量模型已变化，请重新发起重建');
      await tx.runAsync('UPDATE sticker_embedding_index_control SET revision = revision + 1, build_id = ? WHERE id = 1', [id]);
      const control = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM sticker_embedding_index_control WHERE id = 1');
      const rows = await tx.getAllAsync<StickerRow>("SELECT * FROM stickers WHERE owner_assistant_id IS NULL AND annotation_status = 'ready' ORDER BY id");
      return { id, revision: control!.revision, stickers: rows.map(mapStickerRow) };
    });
  }

  async publishEmbeddingRebuild(build: StickerEmbeddingRebuild, embeddings: StickerEmbedding[], context: StickerEmbeddingModelContext, signal: AbortSignal): Promise<void> {
    await stickerTransaction(this.database, async tx => {
      throwIfAbortSignalAborted(signal);
      const control = await tx.getFirstAsync<{ revision: number; build_id: string | null; selected_model_id: string | null; selected_model_updated_at: string | null }>('SELECT * FROM sticker_embedding_index_control WHERE id = 1');
      if (control!.revision !== build.revision || control!.build_id !== build.id || control!.selected_model_id !== context.modelConfigId || control!.selected_model_updated_at !== context.modelConfigUpdatedAt) throw new Error('向量模型或重建任务已变化，本次结果未覆盖旧索引');
      const rows = await tx.getAllAsync<{ id: string; semantic_revision: number }>("SELECT id, semantic_revision FROM stickers WHERE owner_assistant_id IS NULL AND annotation_status = 'ready' ORDER BY id");
      if (rows.length !== build.stickers.length || rows.some((row, index) => row.id !== build.stickers[index].id || row.semantic_revision !== build.stickers[index].semanticRevision)) throw new Error('重建期间表情包发生变化，本次结果未覆盖旧索引，请重新重建');
      // 删除与写入属于同一事务，任何一步失败都会恢复完整旧索引。
      await tx.runAsync('DELETE FROM sticker_embeddings WHERE sticker_id IN (SELECT id FROM stickers WHERE owner_assistant_id IS NULL)');
      for (const embedding of embeddings) await writeEmbedding(tx, embedding);
      await tx.runAsync('DELETE FROM sticker_embedding_failures WHERE sticker_id IN (SELECT id FROM stickers WHERE owner_assistant_id IS NULL)');
      await tx.runAsync('UPDATE sticker_embedding_index_control SET build_id = NULL, published_model_id = ?, published_model_updated_at = ? WHERE id = 1', [context.modelConfigId, context.modelConfigUpdatedAt]);
      throwIfAbortSignalAborted(signal);
    });
  }

  async finishEmbeddingRebuild(id: string): Promise<void> {
    await this.database.runAsync('UPDATE sticker_embedding_index_control SET build_id = NULL WHERE id = 1 AND build_id = ?', [id]);
  }

  async commitEmbeddingBatch(embeddings: StickerEmbedding[], revision: number, signal: AbortSignal): Promise<number> {
    return stickerTransaction(this.database, async tx => {
      throwIfAbortSignalAborted(signal);
      const control = await tx.getFirstAsync<{ revision: number; build_id: string | null }>('SELECT revision, build_id FROM sticker_embedding_index_control WHERE id = 1');
      if (control!.revision !== revision || control!.build_id !== null) return 0;
      let accepted = 0;
      for (const embedding of embeddings) {
        const current = await tx.getFirstAsync<{ semantic_revision: number }>("SELECT semantic_revision FROM stickers WHERE id = ? AND owner_assistant_id IS NULL AND annotation_status = 'ready'", [embedding.stickerId]);
        if (!current || current.semantic_revision !== embedding.semanticRevision) continue;
        await writeEmbedding(tx, embedding);
        await tx.runAsync('DELETE FROM sticker_embedding_failures WHERE sticker_id = ? AND model_config_id = ? AND model_config_updated_at = ? AND semantic_revision = ?',
          [embedding.stickerId, embedding.modelConfigId, embedding.modelConfigUpdatedAt, embedding.semanticRevision]);
        accepted++;
      }
      throwIfAbortSignalAborted(signal);
      return accepted;
    });
  }

  async listStickerEmbeddingsByStickerIds(
    stickerIds: readonly string[],
    modelConfigId: string,
  ): Promise<StickerEmbedding[]> {
    const uniqueIds = [...new Set(stickerIds)].filter((id) => id.trim());
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = await this.database.getAllAsync<StickerEmbeddingRow>(
      `SELECT sticker_id, model_config_id, model_config_updated_at, semantic_revision,
              dimension, vector_json, created_at, updated_at
       FROM sticker_embeddings
       WHERE model_config_id = ? AND sticker_id IN (${placeholders})`,
      [modelConfigId, ...uniqueIds],
    );
    return rows.map(mapStickerEmbeddingRow);
  }

  async countReadyStickers(): Promise<number> {
    const row = await this.database.getFirstAsync<{ total: number }>(
      `SELECT COUNT(*) AS total FROM stickers WHERE annotation_status = 'ready' AND owner_assistant_id IS NULL`,
    );
    return row?.total ?? 0;
  }

  async countValidStickerEmbeddings(context: StickerEmbeddingModelContext): Promise<number> {
    const row = await this.database.getFirstAsync<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM sticker_embeddings e
       JOIN stickers s ON s.id = e.sticker_id AND s.annotation_status = 'ready' AND s.owner_assistant_id IS NULL
       WHERE e.model_config_id = ?
         AND e.model_config_updated_at = ?
         AND e.semantic_revision = s.semantic_revision
         ${context.dimension === null ? '' : 'AND e.dimension = ?'}`,
      context.dimension === null
        ? [context.modelConfigId, context.modelConfigUpdatedAt]
        : [context.modelConfigId, context.modelConfigUpdatedAt, context.dimension],
    );
    return row?.total ?? 0;
  }

  async listReadyStickersNeedingEmbedding(
    context: StickerEmbeddingModelContext,
    limit: number,
  ): Promise<Sticker[]> {
    const dimensionMismatch = context.dimension === null
      ? ''
      : `
           OR e.dimension <> ?
         )`;
    const conditionEnd = context.dimension === null
      ? `
         )`
      : dimensionMismatch;
    const rows = await this.database.getAllAsync<StickerRow>(
      `SELECT s.*
       FROM stickers s
       LEFT JOIN sticker_embeddings e
         ON e.sticker_id = s.id AND e.model_config_id = ?
       WHERE s.annotation_status = 'ready' AND s.owner_assistant_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM sticker_embedding_failures f WHERE f.sticker_id = s.id
           AND f.model_config_id = ? AND f.model_config_updated_at = ? AND f.semantic_revision = s.semantic_revision)
         AND (
           e.sticker_id IS NULL
           OR e.model_config_updated_at <> ?
           OR e.semantic_revision <> s.semantic_revision${conditionEnd}
       ORDER BY s.updated_at ASC, s.id ASC
       LIMIT ?`,
      context.dimension === null
        ? [context.modelConfigId, context.modelConfigId, context.modelConfigUpdatedAt, context.modelConfigUpdatedAt, Math.max(1, Math.floor(limit))]
        : [
            context.modelConfigId,
            context.modelConfigId,
            context.modelConfigUpdatedAt,
            context.modelConfigUpdatedAt,
            context.dimension,
            Math.max(1, Math.floor(limit)),
          ],
    );
    return rows.map(mapStickerRow);
  }

  // -- AI 分组浏览 --

  async listStickerGroupReadySummaries(): Promise<StickerGroupReadySummary[]> {
    const rows = await this.database.getAllAsync<{
      id: string;
      name: string;
      sticker_count: number;
    }>(
      `SELECT g.id, g.name, COUNT(s.id) AS sticker_count
       FROM sticker_groups g
       JOIN stickers s ON s.group_id = g.id AND s.annotation_status = 'ready' AND s.owner_assistant_id IS NULL
       GROUP BY g.id, g.name
       ORDER BY g.sort_order ASC, g.name COLLATE NOCASE ASC, g.id ASC`,
    );
    return rows.map((row) => ({
      groupId: row.id,
      name: row.name,
      stickerCount: row.sticker_count,
    }));
  }

  async listStickersInGroupForAI(input: ListStickersInGroupInput): Promise<Sticker[]> {
    const limit = Math.max(1, Math.floor(input.limit));
    const cursor = input.cursor;
    const rows = await this.database.getAllAsync<StickerRow>(
      `SELECT ${STICKER_COLUMNS}
       FROM stickers
       WHERE annotation_status = 'ready' AND owner_assistant_id IS NULL AND group_id = ?
         ${cursor ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      cursor
        ? [input.groupId, cursor.createdAt, cursor.createdAt, cursor.stickerId, limit]
        : [input.groupId, limit],
    );
    return rows.map(mapStickerRow);
  }

}

/**
 * 普通词面查询与语义候选集共用的结构化过滤。两条路径必须使用同一套语义，
 * 否则“语义召回候选”会与“词面结果”落在不同集合上。
 * tags 单独返回，因为 SQL 只做粗筛，最终仍按解析后的标签精确判定。
 */
function buildStickerSearchFilters(input: SearchStickersInput): {
  where: string[];
  params: (string | number)[];
  tags: string[];
} {
  const query = normalizeSearchText(input.query);
  const tags = normalizeSearchTags(input.tags);
  const emotion = input.emotion?.trim() ?? '';
  const where: string[] = ['(owner_assistant_id IS NULL OR owner_assistant_id = ?)'];
  const params: (string | number)[] = [input.assistantId ?? ''];

  if (input.readyOnly) {
    if (input.includeOwnUnannotated && input.assistantId) {
      where.push("(annotation_status = 'ready' OR owner_assistant_id = ?)");
      params.push(input.assistantId);
    } else where.push("annotation_status = 'ready'");
  }
  if (query) {
    const pattern = `%${query}%`;
    where.push(`(
        LOWER(name) LIKE LOWER(?)
        OR LOWER(COALESCE(description, '')) LIKE LOWER(?)
        OR LOWER(COALESCE(emotion, '')) LIKE LOWER(?)
        OR LOWER(tags_json) LIKE LOWER(?)
      )`);
    params.push(pattern, pattern, pattern, pattern);
  }
  if (emotion) {
    where.push('emotion = ?');
    params.push(emotion);
  }
  for (const tag of tags) {
    where.push('tags_json LIKE ?');
    params.push(`%"${tag}"%`);
  }
  appendGroupFilter(where, params, input.groupId);
  return { where, params, tags };
}

function appendGroupFilter(
  where: string[],
  params: (string | number)[],
  groupId: string | null | undefined,
): void {
  if (groupId === undefined) return;
  if (groupId === null) {
    where.push('group_id IS NULL');
    return;
  }
  where.push('group_id = ?');
  params.push(groupId);
}
