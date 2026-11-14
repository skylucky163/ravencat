import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { createRandomUUID } from '@platform/device';
import type { AIGeneratedImageRepository } from '../domain/AIGeneratedImageRepository';

export class SQLiteAIGeneratedImageRepository implements AIGeneratedImageRepository {
  async addInTransaction(transaction: DatabaseTransactionExecutor, input: { assistantId: string; mediaAssetId: string; fileName: string }): Promise<void> {
    await transaction.runAsync('INSERT INTO ai_generated_images (id, assistant_id, media_asset_id, file_name, created_at) VALUES (?, ?, ?, ?, ?)',
      [createRandomUUID(), input.assistantId, input.mediaAssetId, input.fileName, new Date().toISOString()]);
  }
}
