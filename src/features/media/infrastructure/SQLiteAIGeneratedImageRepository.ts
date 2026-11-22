import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import { createRandomUUID } from '@platform/device';
import type { AIGeneratedImage, AIGeneratedImagePage, AIGeneratedImageQuery, AIGeneratedImageRepository } from '../domain/AIGeneratedImageRepository';

export class SQLiteAIGeneratedImageRepository implements AIGeneratedImageRepository {
  private readonly database = databaseCoordinator.openTaskExecutor({ name: 'media.generated', feature: 'media', priority: 'interactive' });

  async query(assistantId: string, query: AIGeneratedImageQuery): Promise<AIGeneratedImagePage> {
    const byId = 'mediaAssetId' in query;
    const limit = byId ? 1 : query.limit;
    const offset = byId ? 0 : query.offset;
    // 相同成图可多次生成并复用媒体身份；每页只返回最新匹配的角色记录。
    const rows = await this.database.getAllAsync<AIGeneratedImage>(`WITH matched AS (
      SELECT id, media_asset_id AS mediaAssetId, file_name AS fileName, created_at AS createdAt,
        ROW_NUMBER() OVER (PARTITION BY media_asset_id ORDER BY created_at DESC, id DESC) AS position
      FROM ai_generated_images WHERE assistant_id = ?
        AND ${byId ? 'media_asset_id = ?' : 'instr(lower(file_name), lower(?)) > 0'}
    ) SELECT mediaAssetId, fileName, createdAt FROM matched WHERE position = 1
      ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
    [assistantId, byId ? query.mediaAssetId : query.keyword ?? '', limit + 1, offset]);
    return { images: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }

  async renameInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string, fileName: string): Promise<number> {
    const result = await transaction.runAsync(
      'UPDATE ai_generated_images SET file_name = ? WHERE assistant_id = ? AND media_asset_id = ?',
      [fileName, assistantId, mediaAssetId],
    );
    return result.changes;
  }

  async deleteInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string): Promise<number> {
    const result = await transaction.runAsync(
      'DELETE FROM ai_generated_images WHERE assistant_id = ? AND media_asset_id = ?',
      [assistantId, mediaAssetId],
    );
    return result.changes;
  }

  async addInTransaction(transaction: DatabaseTransactionExecutor, input: { assistantId: string; mediaAssetId: string; fileName: string }): Promise<void> {
    await transaction.runAsync('INSERT INTO ai_generated_images (id, assistant_id, media_asset_id, file_name, created_at) VALUES (?, ?, ?, ?, ?)',
      [createRandomUUID(), input.assistantId, input.mediaAssetId, input.fileName, new Date().toISOString()]);
  }
}
