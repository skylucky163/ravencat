import { databaseCoordinator } from '@platform/persistence';
import type { ChatImageSettingsRepository } from '../domain/ChatImageSettingsRepository';

export const chatImageSettingsRepository: ChatImageSettingsRepository = {
  async getRecognitionModelId(assistantId) {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.image-settings.read', feature: 'chat', priority: 'runtime' });
    const row = await db.getFirstAsync<{ recognition_model_config_id: string | null }>('SELECT recognition_model_config_id FROM chat_assistant_image_settings WHERE assistant_id = ?', [assistantId]);
    return row?.recognition_model_config_id ?? null;
  },
  async setRecognitionModelId(assistantId, modelConfigId) {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.image-settings.write', feature: 'chat', priority: 'runtime' });
    await db.runAsync(`INSERT INTO chat_assistant_image_settings (assistant_id, recognition_model_config_id) VALUES (?, ?)
      ON CONFLICT(assistant_id) DO UPDATE SET recognition_model_config_id = excluded.recognition_model_config_id`, [assistantId, modelConfigId]);
  },
};
