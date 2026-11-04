/** 服务与用途分离；升级保留模型 ID、摘要引用与全部业务参数。 */
import type { DatabaseWriteExecutor } from '../runtime';

export const MODEL_SERVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_service_configs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('apiKey', 'tencentCloud')),
  credentials_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_service_connection
  ON model_service_configs(base_url, api_key, auth_type, credentials_json);
CREATE TABLE IF NOT EXISTS model_service_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), auto_save INTEGER NOT NULL DEFAULT 1 CHECK (auto_save IN (0, 1))
);
INSERT OR IGNORE INTO model_service_settings(id) VALUES (1);
`;

export async function migrateModelServices(db: DatabaseWriteExecutor): Promise<void> {
  for (const table of ['auxiliary_model_configs', 'ai_assistants', 'group_chat_admin_configs']) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN service_config_id TEXT REFERENCES model_service_configs(id);`);
  }
  // general 的模型部分成为摘要资产，原 ID 不变；已停用、空连接和失效引用也原样保留。
  await db.execAsync("UPDATE auxiliary_model_configs SET capability_kind = 'summary' WHERE capability_kind = 'general';");
  const owners = [
    { table: 'auxiliary_model_configs', id: 'id', url: 'base_url', metadata: 'metadata_json', kind: 'capability_kind' },
    { table: 'ai_assistants', id: 'id', url: 'api_base_url', metadata: 'NULL', kind: "'chat'" },
    { table: 'group_chat_admin_configs', id: 'group_id', url: 'api_base_url', metadata: 'NULL', kind: "'chat'" },
  ];
  for (const owner of owners) {
    const rows = await db.getAllAsync<{ id: string; name: string; base_url: string; api_key: string; metadata_json: string | null; kind: string; created_at: string; updated_at: string }>(
      `SELECT ${owner.id} AS id, name, ${owner.url} AS base_url, api_key, ${owner.metadata} AS metadata_json,
        ${owner.kind} AS kind, created_at, updated_at FROM ${owner.table}
        WHERE trim(${owner.url}) <> '' AND trim(api_key) <> '' ORDER BY created_at, ${owner.id}`);
    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      if (row.metadata_json) {
        try { metadata = JSON.parse(row.metadata_json); }
        catch { continue; } // 无法解析的旧资产保持不可用，不改写原文或猜测认证。
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
      }
      // 专用提供方不进入通用服务；其余兼容连接统一使用 apiKey 身份。
      if (row.kind === 'stt'
        || (row.kind === 'tts' && metadata.provider !== undefined && metadata.provider !== 'openaiCompatible')
        || (row.kind === 'translation' && metadata.provider !== 'aiModel')) continue;
      const identity = [row.base_url.trim(), row.api_key.trim(), 'apiKey', '{}'];
      await db.runAsync(`INSERT OR IGNORE INTO model_service_configs
        (id, name, base_url, api_key, auth_type, credentials_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`service_${owner.table}_${row.id}`, row.name, ...identity, row.created_at, row.updated_at]);
      const service = await db.getFirstAsync<{ id: string }>(`SELECT id FROM model_service_configs
        WHERE base_url = ? AND api_key = ? AND auth_type = ? AND credentials_json = ?`, identity);
      if (owner.table === 'auxiliary_model_configs') {
        await db.runAsync(`UPDATE auxiliary_model_configs SET service_config_id = ?, base_url = '', api_key = NULL,
          metadata_json = ? WHERE id = ?`, [service!.id, row.metadata_json, row.id]);
      } else {
        await db.runAsync(`UPDATE ${owner.table} SET service_config_id = ?, ${owner.url} = NULL, api_key = NULL WHERE ${owner.id} = ?`, [service!.id, row.id]);
      }
    }
  }
}

/** 已试用157的配置按当前有效值解除共享引用，不改模型身份、参数或业务选择。 */
export async function detachDedicatedModelServices(db: DatabaseWriteExecutor): Promise<void> {
  const provider = `CASE WHEN metadata_json IS NULL THEN 'openaiCompatible'
    WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json, '$.provider'), 'openaiCompatible')
    ELSE '' END`;
  await db.execAsync(`UPDATE auxiliary_model_configs SET
    base_url = (SELECT base_url FROM model_service_configs WHERE id = service_config_id),
    api_key = (SELECT api_key FROM model_service_configs WHERE id = service_config_id),
    metadata_json = CASE
      WHEN (SELECT credentials_json FROM model_service_configs WHERE id = service_config_id) = '{}' THEN metadata_json
      ELSE json_patch(COALESCE(metadata_json, '{}'), (SELECT credentials_json FROM model_service_configs WHERE id = service_config_id)) END,
    service_config_id = NULL
    WHERE service_config_id IS NOT NULL AND (
      capability_kind = 'stt'
      OR (capability_kind = 'tts' AND (${provider}) <> 'openaiCompatible')
      OR (capability_kind = 'translation' AND (${provider}) <> 'aiModel')
    );`);
}

/** 157 自动迁出的专用服务已失去用途；只清理来源、连接和无引用均能确认的副本。 */
export async function removeRetiredDedicatedServiceCopies(db: DatabaseWriteExecutor): Promise<void> {
  const candidates = await db.getAllAsync<{
    id: string; base_url: string; api_key: string; auth_type: string; credentials_json: string;
    model_base_url: string; model_api_key: string | null; capability_kind: string; metadata_json: string | null;
  }>(`SELECT s.id, s.base_url, s.api_key, s.auth_type, s.credentials_json,
      a.base_url AS model_base_url, a.api_key AS model_api_key, a.capability_kind, a.metadata_json
    FROM model_service_configs s JOIN auxiliary_model_configs a
      ON s.id = 'service_auxiliary_model_configs_' || a.id
    WHERE a.service_config_id IS NULL AND a.capability_kind IN ('stt', 'tts', 'translation')`);
  for (const row of candidates) {
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(row.metadata_json ?? '{}'); }
    catch { continue; }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    if (row.capability_kind === 'tts' && (metadata.provider === undefined || metadata.provider === 'openaiCompatible')) continue;
    if (row.capability_kind === 'translation' && metadata.provider === 'aiModel') continue;
    const tencent = (row.capability_kind === 'stt' && metadata.provider === 'tencentRealtimeAsr')
      || (row.capability_kind === 'translation' && metadata.provider === 'tencentCloudTmt');
    const credentials: Record<string, string> = {};
    if (tencent) {
      if (metadata.secretId) credentials.secretId = String(metadata.secretId);
      if (metadata.appId) credentials.appId = String(metadata.appId);
    }
    // ID 的来源约定来自157；用户改过连接、另存的服务或仍被使用的服务均保留。
    if (row.base_url !== row.model_base_url.trim() || row.api_key !== (row.model_api_key?.trim() ?? '')
      || row.auth_type !== (tencent ? 'tencentCloud' : 'apiKey') || row.credentials_json !== JSON.stringify(credentials)) continue;
    await db.runAsync(`DELETE FROM model_service_configs WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM auxiliary_model_configs WHERE service_config_id = ?)
      AND NOT EXISTS (SELECT 1 FROM ai_assistants WHERE service_config_id = ?)
      AND NOT EXISTS (SELECT 1 FROM group_chat_admin_configs WHERE service_config_id = ?)`, [row.id, row.id, row.id, row.id]);
  }
}
