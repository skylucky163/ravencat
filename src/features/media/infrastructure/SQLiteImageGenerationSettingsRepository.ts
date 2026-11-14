import { databaseCoordinator } from '@platform/persistence';
import type { ImageGenerationSettingsRepository } from '../domain/ImageGenerationSettingsRepository';

export class SQLiteImageGenerationSettingsRepository implements ImageGenerationSettingsRepository {
  private readonly database = databaseCoordinator.openTaskExecutor({ name: 'media.imageGenerationSettings', feature: 'media', priority: 'interactive' });
  async getModelId(): Promise<string | null> {
    const row = await this.database.getFirstAsync<{ model_config_id: string | null }>('SELECT model_config_id FROM media_image_generation_settings WHERE id = 1');
    return row!.model_config_id;
  }
  async setModelId(id: string | null): Promise<void> {
    await this.database.runAsync('UPDATE media_image_generation_settings SET model_config_id = ? WHERE id = 1', [id]);
  }
}
