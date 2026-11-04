/** 新正文与派生任务使用独立表名，避免历史主题 migration 重放污染 V3。 */
import type { DatabaseWriteExecutor } from '../runtime';

/** 词只在组内唯一；关系和关闭事实归组所有，删除任一端时由外键清理。 */
export const MEMORY_TRIGGER_GROUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_trigger_groups (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES memory_pools(id) ON DELETE CASCADE,
  auto_associate INTEGER NOT NULL DEFAULT 0 CHECK (auto_associate IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_memory_trigger_groups_pool ON memory_trigger_groups(pool_id);
CREATE TABLE IF NOT EXISTS memory_trigger_keywords (
  group_id TEXT NOT NULL REFERENCES memory_trigger_groups(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(group_id, normalized_keyword)
);
CREATE TABLE IF NOT EXISTS memory_passive_associations (
  trigger_id TEXT NOT NULL REFERENCES memory_trigger_groups(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  PRIMARY KEY(trigger_id, memory_id)
);
CREATE TABLE IF NOT EXISTS memory_passive_disabled (
  trigger_id TEXT NOT NULL REFERENCES memory_trigger_groups(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  PRIMARY KEY(trigger_id, memory_id)
);
`;

export const MEMORY_V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_embedding_index_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  build_id TEXT
);
INSERT OR IGNORE INTO memory_embedding_index_control (id) VALUES (1);
CREATE TABLE IF NOT EXISTS memory_v3_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  model_fingerprint TEXT,
  model_name TEXT,
  dimension INTEGER,
  preferred_assistant_id TEXT,
  FOREIGN KEY (preferred_assistant_id) REFERENCES ai_assistants(id) ON DELETE SET NULL
);
INSERT OR IGNORE INTO memory_v3_state (id, version) VALUES (1, 3);
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES memory_pools(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  summary TEXT,
  normalized_content TEXT NOT NULL,
  normalized_summary TEXT NOT NULL DEFAULT '',
  content_revision INTEGER NOT NULL DEFAULT 1,
  write_key TEXT,
  remembered_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(pool_id, write_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_items_pool_time ON memory_items(pool_id, remembered_at DESC, id);
CREATE TABLE IF NOT EXISTS memory_write_receipts (
  pool_id TEXT NOT NULL REFERENCES memory_pools(id) ON DELETE CASCADE,
  write_key TEXT NOT NULL,
  memory_id TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  PRIMARY KEY(pool_id, write_key)
);
CREATE TABLE IF NOT EXISTS memory_item_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  content_revision INTEGER NOT NULL,
  model_fingerprint TEXT,
  model_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('not_requested','pending','retry_wait','ready','stale','failed')),
  vector_json TEXT,
  vector_model_fingerprint TEXT,
  vector_content_revision INTEGER,
  dimension INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  claim_id TEXT,
  claim_expires_at TEXT,
  last_error TEXT,
  failed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_embedding_queue ON memory_item_embeddings(status, retry_at, claim_expires_at);
${MEMORY_TRIGGER_GROUP_SCHEMA}
CREATE TABLE IF NOT EXISTS memory_recall_settings (
  pool_id TEXT PRIMARY KEY REFERENCES memory_pools(id) ON DELETE CASCADE,
  passive_limit INTEGER NOT NULL DEFAULT 5 CHECK (passive_limit BETWEEN 0 AND 20),
  active_page_size INTEGER NOT NULL DEFAULT 10 CHECK (active_page_size BETWEEN 1 AND 50)
);
`;

/** 外层升级事务拥有提交；旧词各自保留 ID、动态文本关联和关闭事实，不猜测用户的分组意图。 */
export async function migrateMemoryTriggerGroups(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(`
    ALTER TABLE memory_passive_associations RENAME TO memory_legacy_associations;
    ALTER TABLE memory_passive_disabled RENAME TO memory_legacy_disabled;
    ${MEMORY_TRIGGER_GROUP_SCHEMA}
    INSERT INTO memory_trigger_groups (id, pool_id, auto_associate)
      SELECT id, pool_id, 1 FROM memory_passive_triggers;
    INSERT INTO memory_trigger_keywords (group_id, keyword, normalized_keyword, position)
      SELECT id, keyword, normalized_keyword, 0 FROM memory_passive_triggers;
    INSERT INTO memory_passive_associations SELECT * FROM memory_legacy_associations;
    INSERT INTO memory_passive_disabled SELECT * FROM memory_legacy_disabled;
    DROP TABLE memory_legacy_associations;
    DROP TABLE memory_legacy_disabled;
    DROP TABLE memory_passive_triggers;
  `);
}

/** 用户授权定向清旧；只清旧结构，第二次启动及 V3 备份恢复不触碰新正文。 */
export async function migrateMemoryV3(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync('BEGIN;');
  try {
    await db.execAsync(MEMORY_V3_SCHEMA);
    await db.execAsync(`
      DROP TABLE IF EXISTS memory_change_operations;
      DROP TABLE IF EXISTS memory_change_sets;
      DROP TABLE IF EXISTS memory_ingestion_receipts;
      DROP TABLE IF EXISTS memory_drafts;
      DROP TABLE IF EXISTS memory_entry_tags;
      DROP TABLE IF EXISTS memory_tag_aliases;
      DROP TABLE IF EXISTS memory_tags;
      DROP TABLE IF EXISTS memory_entry_sources;
      DROP TABLE IF EXISTS memory_entries;
      DROP TABLE IF EXISTS memory_topics;
      DROP TABLE IF EXISTS memory_preferences;
      DELETE FROM assistant_prompt_definition_states WHERE definition_id IN (
        'context.recent_memory_capsules', 'context.memory_session', 'context.shared_memory',
        'internal.memory_administrator', 'output.memory_administrator_json',
        'internal.memory_extractor_legacy', 'output.memory_extractor_json'
      );
      DELETE FROM assistant_prompt_definition_overrides WHERE definition_id IN (
        'context.recent_memory_capsules', 'context.memory_session', 'context.shared_memory',
        'internal.memory_administrator', 'output.memory_administrator_json',
        'internal.memory_extractor_legacy', 'output.memory_extractor_json'
      );
      DELETE FROM prompt_preset_items WHERE definition_id IN (
        'context.recent_memory_capsules', 'context.memory_session', 'context.shared_memory',
        'internal.memory_administrator', 'output.memory_administrator_json',
        'internal.memory_extractor_legacy', 'output.memory_extractor_json'
      );
      DELETE FROM prompt_bindings WHERE scenario_id IN ('memory.administrator', 'memory.extractor_legacy');
      DELETE FROM prompt_presets WHERE scenario_id IN ('memory.administrator', 'memory.extractor_legacy');
    `);
    await db.execAsync('COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }
}

/** 数据保留型升级；空摘要不改变旧检索文本、revision 或有效向量。 */
export async function migrateMemorySummary(db: DatabaseWriteExecutor): Promise<void> {
  const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if (version!.user_version >= 107) return;
  await db.execAsync('BEGIN IMMEDIATE;');
  try {
    const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info('memory_items')");
    if (!columns.some((column) => column.name === 'summary')) {
      await db.execAsync('ALTER TABLE memory_items ADD COLUMN summary TEXT;');
    }
    if (!columns.some((column) => column.name === 'normalized_summary')) {
      await db.execAsync("ALTER TABLE memory_items ADD COLUMN normalized_summary TEXT NOT NULL DEFAULT '';");
    }
    await db.execAsync('PRAGMA user_version = 107; COMMIT;');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    throw error;
  }
}

/** 旧任务状态不能证明保留向量的来源，只迁入原本已就绪向量的可确认版本。 */
export async function migrateMemoryEmbeddingVectorSnapshot(db: DatabaseWriteExecutor): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info('memory_item_embeddings')");
  if (columns.some(column => column.name === 'vector_model_fingerprint')) return;
  await db.execAsync(`ALTER TABLE memory_item_embeddings ADD COLUMN vector_model_fingerprint TEXT;
    ALTER TABLE memory_item_embeddings ADD COLUMN vector_content_revision INTEGER;
    UPDATE memory_item_embeddings SET vector_model_fingerprint = model_fingerprint,
      vector_content_revision = content_revision WHERE status = 'ready';`);
}
