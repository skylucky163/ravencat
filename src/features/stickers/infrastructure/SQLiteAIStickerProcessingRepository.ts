import type { CoordinatedDatabaseExecutor } from '@platform/persistence';
import type { MediaAsset } from '@features/media';
import type { AIStickerClaim, AIStickerOperation, AIStickerProcessingRepository, AIStickerTask, AIStickerCommitGuard } from '../domain/AIStickerProcessing';
import { StickerNotFoundError } from '../domain/Sticker';
import type { StickerAnnotationMetadata } from '../domain/Sticker';
import type { StickerEmbedding } from '../domain/StickerEmbedding';
import { SQLiteStickerRepository, semanticFieldsChanged, stickerTransaction } from './SQLiteStickerRepository';

/** AI 处理与用户空闲 worker 共用收藏事实，但不共享自动重试队列。 */
export class SQLiteAIStickerProcessingRepository implements AIStickerProcessingRepository {
  private readonly stickers: SQLiteStickerRepository;
  constructor(private readonly database: CoordinatedDatabaseExecutor) {
    this.stickers = new SQLiteStickerRepository(database);
  }

  async create(ownerId: string, asset: MediaAsset, name: string, fileName: string | null, id: string, now: string, guard: AIStickerCommitGuard) {
    return stickerTransaction(this.database, async tx => {
      await guard(tx);
      const existing = await this.stickers.getStickerByMediaAssetIdInTransaction(tx, asset.id, ownerId);
      if (existing) return { sticker: existing, reused: true };
      const sticker = { id, ownerAssistantId: ownerId, mediaAssetId: asset.id, groupId: null, name,
        description: null, tags: [], emotion: null, sourceFileName: fileName, mimeType: asset.mimeType,
        width: asset.width, height: asset.height, isAnimated: false, isFavorite: false, useCount: 0,
        lastUsedAt: null, annotationStatus: 'pending' as const, annotationError: null, semanticRevision: 1,
        createdAt: now, updatedAt: now };
      await this.stickers.createStickerInTransaction(tx, sticker);
      return { sticker, reused: false };
    });
  }

  async claim(ownerId: string, stickerId: string, operation: AIStickerOperation, claimId: string, executionId: string, now: string, guard: AIStickerCommitGuard): Promise<AIStickerClaim | null> {
    return stickerTransaction(this.database, async tx => {
      await guard(tx);
      const sticker = await this.stickers.getStickerByIdInTransaction(tx, stickerId, ownerId);
      if (!sticker) throw new StickerNotFoundError(stickerId);
      const task = await tx.getFirstAsync<{ status: string; execution_id: string }>('SELECT status, execution_id FROM ai_sticker_tasks WHERE sticker_id = ?', [stickerId]);
      if (task?.status === 'processing' && task.execution_id === executionId) return null;
      // 旧进程遗留任务只在显式调用时被接管，不因此自行发起模型请求。
      await tx.runAsync(`INSERT INTO ai_sticker_tasks
        (sticker_id, operation, claim_id, execution_id, semantic_revision, status, error, updated_at)
        VALUES (?, ?, ?, ?, ?, 'processing', NULL, ?)
        ON CONFLICT(sticker_id) DO UPDATE SET operation = excluded.operation, claim_id = excluded.claim_id,
        execution_id = excluded.execution_id, semantic_revision = excluded.semantic_revision,
        status = 'processing', error = NULL, updated_at = excluded.updated_at`,
      [stickerId, operation, claimId, executionId, sticker.semanticRevision, now]);
      return { sticker, claimId, operation };
    });
  }

  async finish(claim: AIStickerClaim, result: { metadata?: StickerAnnotationMetadata; embedding?: StickerEmbedding; error?: string }, now: string, guard: AIStickerCommitGuard): Promise<boolean> {
    return stickerTransaction(this.database, async tx => {
      await guard(tx);
      const accepted = await tx.runAsync(`UPDATE ai_sticker_tasks SET status = ?, error = ?, updated_at = ?
        WHERE sticker_id = ? AND claim_id = ? AND status = 'processing'
        AND semantic_revision = (SELECT semantic_revision FROM stickers WHERE id = ?)`,
      [result.error ? 'failed' : 'succeeded', result.error ?? null, now, claim.sticker.id, claim.claimId, claim.sticker.id]);
      if (accepted.changes === 0) return false;
      if (result.metadata) {
        const m = result.metadata;
        const bump = semanticFieldsChanged(claim.sticker, { name: m.name!, description: m.description!, tags: [...m.tags!], emotion: m.emotion ?? null });
        await tx.runAsync(`UPDATE stickers SET name = ?, description = ?, tags_json = ?, emotion = ?,
          annotation_status = 'ready', annotation_error = NULL, semantic_revision = semantic_revision + ?,
          updated_at = ? WHERE id = ?`, [m.name!, m.description!, JSON.stringify(m.tags!), m.emotion ?? null, bump ? 1 : 0, now, claim.sticker.id]);
      } else if (result.error && claim.operation === 'recognize') {
        await tx.runAsync("UPDATE stickers SET annotation_status = CASE WHEN annotation_status = 'ready' THEN 'ready' ELSE 'failed' END, annotation_error = CASE WHEN annotation_status = 'ready' THEN NULL ELSE ? END, updated_at = ? WHERE id = ?",
          [result.error, now, claim.sticker.id]);
      }
      if (result.embedding) {
        const e = result.embedding;
        await tx.runAsync(`INSERT INTO sticker_embeddings
          (sticker_id, model_config_id, model_config_updated_at, semantic_revision, dimension, vector_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sticker_id, model_config_id) DO UPDATE SET
          model_config_updated_at = excluded.model_config_updated_at, semantic_revision = excluded.semantic_revision,
          dimension = excluded.dimension, vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
        [e.stickerId, e.modelConfigId, e.modelConfigUpdatedAt, e.semanticRevision, e.dimension, JSON.stringify(e.vector), now, now]);
      }
      return true;
    });
  }

  async cancel(claim: AIStickerClaim, now: string): Promise<void> {
    await this.database.runAsync("UPDATE ai_sticker_tasks SET status = 'cancelled', error = NULL, updated_at = ? WHERE sticker_id = ? AND claim_id = ? AND status = 'processing'", [now, claim.sticker.id, claim.claimId]);
  }

  getTask(stickerId: string): Promise<AIStickerTask | null> {
    return this.database.getFirstAsync<AIStickerTask>('SELECT operation, status, error FROM ai_sticker_tasks WHERE sticker_id = ?', [stickerId]);
  }

  async getTasks(stickerIds: readonly string[]): Promise<Map<string, AIStickerTask>> {
    if (stickerIds.length === 0) return new Map();
    const placeholders = stickerIds.map(() => '?').join(', ');
    const rows = await this.database.getAllAsync<AIStickerTask & { sticker_id: string }>(
      `SELECT sticker_id, operation, status, error FROM ai_sticker_tasks WHERE sticker_id IN (${placeholders})`,
      [...stickerIds],
    );
    return new Map(rows.map(({ sticker_id, ...task }) => [sticker_id, task]));
  }
}
