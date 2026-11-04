/** 业务选择只保存模型 ID；保留失效引用以展示原因，不因资产删除而自动改选。 */
import type { DatabaseWriteExecutor } from '../runtime';

export const MODEL_SELECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_model_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), embedding_model_config_id TEXT,
  embedding_enabled INTEGER NOT NULL DEFAULT 0 CHECK (embedding_enabled IN (0, 1))
);
INSERT OR IGNORE INTO memory_model_settings (id) VALUES (1);
CREATE TABLE IF NOT EXISTS chat_assistant_image_settings (
  assistant_id TEXT PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE,
  recognition_model_config_id TEXT
);
CREATE TABLE IF NOT EXISTS speech_recognition_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), model_config_id TEXT
);
INSERT OR IGNORE INTO speech_recognition_settings (id) VALUES (1);
CREATE TABLE IF NOT EXISTS assistant_voice_settings (
  assistant_id TEXT PRIMARY KEY REFERENCES ai_assistants(id) ON DELETE CASCADE,
  model_config_id TEXT
);
`;

/** 一次性固化旧实际选择；marker、数据转换与旧表删除在同一事务提交。 */
export async function migrateModelSelections(db: DatabaseWriteExecutor): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if (version!.user_version >= 95) return;
  await db.execAsync('BEGIN IMMEDIATE;');
  try {
    await db.execAsync(MODEL_SELECTION_SCHEMA);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS chat_image_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), recognition_model_config_id TEXT
      );
      INSERT OR IGNORE INTO chat_image_settings (id) VALUES (1);
      UPDATE memory_model_settings SET embedding_model_config_id = (
        SELECT model_config_id FROM capability_bindings WHERE capability_kind = 'embedding' AND enabled = 1
      ) WHERE id = 1;
      UPDATE chat_image_settings SET recognition_model_config_id = (
        SELECT model_config_id FROM capability_bindings WHERE capability_kind = 'ocr' AND enabled = 1
      ) WHERE id = 1;
      UPDATE speech_recognition_settings SET model_config_id = (
        SELECT model_config_id FROM capability_bindings WHERE capability_kind = 'stt' AND enabled = 1
      ) WHERE id = 1;
      INSERT INTO assistant_voice_settings (assistant_id, model_config_id)
      SELECT assistant.id,
        CASE WHEN binding.assistant_id IS NOT NULL
          THEN CASE WHEN binding.enabled = 1 THEN binding.model_config_id ELSE NULL END
          ELSE (SELECT model_config_id FROM capability_bindings WHERE capability_kind = 'tts' AND enabled = 1)
        END
      FROM ai_assistants assistant
      LEFT JOIN assistant_capability_bindings binding
        ON binding.assistant_id = assistant.id AND binding.capability_kind = 'tts';
      DROP TABLE assistant_capability_bindings;
      DROP TABLE capability_bindings;
      PRAGMA user_version = 95;
    `);
    await db.execAsync('COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }
}

/** 只迁移角色实际启用的预处理选择；未选择就是直接传图，不再保存第二个开关。 */
export async function migrateChatImageModelSelections(db: DatabaseWriteExecutor): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if (version!.user_version >= 96) return;
  await db.execAsync('BEGIN IMMEDIATE;');
  try {
    await db.execAsync(`
      INSERT INTO chat_assistant_image_settings (assistant_id, recognition_model_config_id)
      SELECT assistant.id, settings.recognition_model_config_id
      FROM ai_assistants assistant CROSS JOIN chat_image_settings settings
      WHERE assistant.image_processing_mode = 'vision_preprocess';
      DROP TABLE chat_image_settings;
      PRAGMA user_version = 96;
    `);
    await db.execAsync('COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }
}
