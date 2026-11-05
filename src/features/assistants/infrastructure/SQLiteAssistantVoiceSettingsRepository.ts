import { databaseCoordinator } from '@platform/persistence';
import type { AssistantVoiceSettingsRepository } from '../domain/AssistantVoiceSettingsRepository';

export const assistantVoiceSettingsRepository: AssistantVoiceSettingsRepository = {
  async getModelId(assistantId) {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.voice.read', feature: 'assistants', priority: 'runtime' });
    const row = await db.getFirstAsync<{ model_config_id: string | null }>('SELECT model_config_id FROM assistant_voice_settings WHERE assistant_id = ?', [assistantId]);
    return row?.model_config_id ?? null;
  },
  async setModelId(assistantId, modelConfigId) {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.voice.write', feature: 'assistants', priority: 'runtime' });
    await db.runAsync(`INSERT INTO assistant_voice_settings (assistant_id, model_config_id) VALUES (?, ?)
      ON CONFLICT(assistant_id) DO UPDATE SET model_config_id = excluded.model_config_id`, [assistantId, modelConfigId]);
  },
};
