/** 分组拥有地址；用途继续引用原连接 ID，每个连接现在明确对应一个 Key。 */
import type { DatabaseWriteExecutor } from '../runtime';

const GROUP_SCHEMA = `CREATE TABLE IF NOT EXISTS model_service_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('apiKey', 'tencentCloud')),
  next_key_ordinal INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);`;
const KEY_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_model_service_key
  ON model_service_configs(group_id, api_key, credentials_json);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_model_service_key_ordinal ON model_service_configs(group_id, ordinal);`;
export const MODEL_SERVICE_SCHEMA = `${GROUP_SCHEMA}
CREATE TABLE IF NOT EXISTS model_service_configs (
  id TEXT PRIMARY KEY, group_id TEXT REFERENCES model_service_groups(id),
  name TEXT NOT NULL, ordinal INTEGER NOT NULL DEFAULT 1, api_key TEXT NOT NULL,
  credentials_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
${KEY_INDEX}
CREATE TABLE IF NOT EXISTS model_service_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), auto_save INTEGER NOT NULL DEFAULT 1 CHECK (auto_save IN (0, 1))
);
INSERT OR IGNORE INTO model_service_settings(id) VALUES (1);
`;

export async function migrateModelServiceGroups(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(GROUP_SCHEMA);
  // 不根据 URL 合并用户配置；旧连接 ID、凭据、时间和所有业务引用原样保留。
  await db.execAsync(`INSERT INTO model_service_groups(id,name,base_url,auth_type,created_at,updated_at)
    SELECT id,name,base_url,auth_type,created_at,updated_at FROM model_service_configs;
    ALTER TABLE model_service_configs ADD COLUMN group_id TEXT REFERENCES model_service_groups(id);
    ALTER TABLE model_service_configs ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 1;
    UPDATE model_service_configs SET group_id = id, name = '';
    DROP INDEX idx_model_service_connection;
    ALTER TABLE model_service_configs DROP COLUMN base_url;
    ALTER TABLE model_service_configs DROP COLUMN auth_type;
    ${KEY_INDEX}`);
}
