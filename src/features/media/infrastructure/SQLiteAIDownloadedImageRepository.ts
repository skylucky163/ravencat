import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import { createRandomUUID } from '@platform/device';
import type { AIDownloadedImage, AIDownloadedImagePage, AIDownloadedImageQuery, AIDownloadedImageRepository } from '../domain/AIDownloadedImageRepository';

export class SQLiteAIDownloadedImageRepository implements AIDownloadedImageRepository {
  private readonly database = databaseCoordinator.openTaskExecutor({ name: 'media.downloads', feature: 'media', priority: 'interactive' });

  async query(assistantId: string, query: AIDownloadedImageQuery): Promise<AIDownloadedImagePage> {
    const byId = 'mediaAssetId' in query;
    const limit = byId ? 1 : query.limit;
    const offset = byId ? 0 : query.offset;
    // 下载记录持有独立引用；检索按媒体身份合并，只返回最新匹配的命名与来源。
    const rows = await this.database.getAllAsync<AIDownloadedImage>(`WITH matched AS (
      SELECT id, media_asset_id AS mediaAssetId, file_name AS fileName, source_url AS sourceUrl, created_at AS createdAt,
        ROW_NUMBER() OVER (PARTITION BY media_asset_id ORDER BY created_at DESC, id DESC) AS position
      FROM ai_downloaded_images WHERE assistant_id = ?
        AND ${byId ? 'media_asset_id = ?' : 'instr(lower(file_name), lower(?)) > 0'}
    ) SELECT mediaAssetId, fileName, sourceUrl, createdAt FROM matched WHERE position = 1
      ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`,
    [assistantId, byId ? query.mediaAssetId : query.keyword ?? '', limit + 1, offset]);
    return { images: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }

  async renameInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string, fileName: string): Promise<number> {
    const result = await transaction.runAsync(
      'UPDATE ai_downloaded_images SET file_name = ? WHERE assistant_id = ? AND media_asset_id = ?',
      [fileName, assistantId, mediaAssetId],
    );
    return result.changes;
  }

  async deleteInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, mediaAssetId: string): Promise<number> {
    const result = await transaction.runAsync(
      'DELETE FROM ai_downloaded_images WHERE assistant_id = ? AND media_asset_id = ?',
      [assistantId, mediaAssetId],
    );
    return result.changes;
  }

  async addInTransaction(transaction: DatabaseTransactionExecutor, input: {
    assistantId: string; mediaAssetId: string; sourceUrl: string; fileName: string;
  }): Promise<void> {
    await transaction.runAsync(`INSERT INTO ai_downloaded_images
      (id, assistant_id, media_asset_id, source_url, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [createRandomUUID(), input.assistantId, input.mediaAssetId, input.sourceUrl, input.fileName, new Date().toISOString()]);
  }
}
