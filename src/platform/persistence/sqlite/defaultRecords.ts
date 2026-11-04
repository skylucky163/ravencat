/** 只补建默认记录；普通启动与恢复出厂均不得覆盖已经保存的用户配置。 */
import { WEB_SEARCH_DEFAULTS } from './webSearchSchema';

export const DEFAULT_RECORDS_SQL = `
${WEB_SEARCH_DEFAULTS}
INSERT OR IGNORE INTO model_service_settings (id) VALUES (1);
INSERT OR IGNORE INTO memory_model_settings (id) VALUES (1);
INSERT OR IGNORE INTO speech_recognition_settings (id) VALUES (1);
INSERT OR IGNORE INTO translation_settings (id) VALUES (1);
INSERT OR IGNORE INTO memory_v3_state (id, version) VALUES (1, 3);
INSERT OR IGNORE INTO memory_embedding_index_control (id) VALUES (1);
INSERT OR IGNORE INTO sticker_embedding_index_control (id) VALUES (1);
INSERT OR IGNORE INTO host_ai_relationship_state (id, last_revoked_ai_id, appointment_cooldown_start, appointment_cooldown_end, created_at, updated_at) VALUES ('default', NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO user_profile (id, name, updated_at) VALUES ('self', '用户', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;
