/** Sticker 业务表的建表与索引语句，供数据库初始化和后续 migration 复用。 */
import type { DatabaseWriteExecutor } from '../runtime';

/** Sticker 分组只保存库内的组织关系，不携带媒体文件状态。 */
export const STICKER_GROUPS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sticker_groups (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
  );
`;

/**
 * 收藏身份属于用户或某个 AI；同一媒体可在不同收藏库拥有独立语义。
 * 删除收藏只撤销引用，不级联删除媒体。
 */
export const STICKERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS stickers (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    media_asset_id TEXT NOT NULL CHECK (length(trim(media_asset_id)) > 0),
    owner_assistant_id TEXT,
    group_id TEXT,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    description TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]' CHECK (length(tags_json) > 0),
    emotion TEXT,
    source_file_name TEXT,
    mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    is_animated INTEGER NOT NULL DEFAULT 0 CHECK (is_animated IN (0, 1)),
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    last_used_at TEXT,
    annotation_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (annotation_status IN ('pending', 'processing', 'ready', 'manual_required', 'failed')),
    annotation_error TEXT,
    annotation_claim_id TEXT,
    annotation_claimed_at TEXT,
    annotation_requested INTEGER NOT NULL DEFAULT 0 CHECK (annotation_requested IN (0, 1)),
    semantic_revision INTEGER NOT NULL DEFAULT 1 CHECK (semantic_revision >= 1),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    CHECK (
      (annotation_status = 'processing'
        AND annotation_claim_id IS NOT NULL
        AND annotation_claimed_at IS NOT NULL)
      OR
      (annotation_status <> 'processing'
        AND annotation_claim_id IS NULL
        AND annotation_claimed_at IS NULL)
    ),
    CHECK (
      (annotation_status = 'failed'
        AND annotation_error IS NOT NULL
        AND length(trim(annotation_error)) > 0)
      OR
      (annotation_status <> 'failed' AND annotation_error IS NULL)
    ),
    FOREIGN KEY (media_asset_id) REFERENCES media_assets(id) ON DELETE RESTRICT,
    FOREIGN KEY (group_id) REFERENCES sticker_groups(id) ON DELETE SET NULL,
    FOREIGN KEY (owner_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
  );
`;

export const STICKER_OWNERSHIP_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_user_media ON stickers(media_asset_id) WHERE owner_assistant_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_ai_media ON stickers(owner_assistant_id, media_asset_id) WHERE owner_assistant_id IS NOT NULL;
`;

/** AI 显式处理任务只有一个持久 claim；失败、取消与旧进程任务不进入自动队列。 */
export const AI_STICKER_TASKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_sticker_tasks (
    sticker_id TEXT PRIMARY KEY NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('recognize', 'embed')),
    claim_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    semantic_revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed', 'cancelled')),
    error TEXT,
    updated_at TEXT NOT NULL
  );
`;

/** 失败按模型指纹和语义版本归属；自动队列不能将失败项当作普通缺失项重试。 */
export const STICKER_EMBEDDING_FAILURES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sticker_embedding_failures (
    sticker_id TEXT PRIMARY KEY NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    model_config_id TEXT NOT NULL,
    model_config_updated_at TEXT NOT NULL,
    semantic_revision INTEGER NOT NULL,
    error TEXT NOT NULL CHECK (length(trim(error)) > 0),
    updated_at TEXT NOT NULL
  );
`;

export const STICKER_GROUPS_ORDER_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_sticker_groups_order
    ON sticker_groups(sort_order, name, id);
`;

export const STICKERS_GROUP_ORDER_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_stickers_group_order
    ON stickers(group_id, is_favorite DESC, last_used_at DESC, use_count DESC, id);
`;

export const STICKERS_FAVORITE_RECENT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_stickers_favorite_recent
    ON stickers(is_favorite, last_used_at DESC, use_count DESC, id);
`;

export const STICKERS_ANNOTATION_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_stickers_annotation_claim
    ON stickers(annotation_status, annotation_claimed_at, updated_at, id);
`;

/**
 * Sticker System 的业务级模型绑定。两个字段都只保存辅助模型中心已有
 * AuxiliaryModelConfig.id；不保存第二份 Base URL / API Key / model name，
 * recognition 与 embedding 均属于 Sticker 自己的业务选择，不借用其他系统设置。
 */
export const STICKER_SYSTEM_CONFIG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sticker_system_config (
    id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
    recognition_model_config_id TEXT,
    embedding_model_config_id TEXT,
    automatic_recognition_enabled INTEGER NOT NULL DEFAULT 0 CHECK (automatic_recognition_enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * Sticker 语义向量索引。向量有效性由四元组共同决定：模型 ID、模型配置
 * updatedAt 指纹、semantic revision 与查询维度；任一不匹配即视为 stale。
 * 收藏规模为数百到低几千张，第一版直接用 vector_json 全量扫描做余弦。
 */
export const STICKER_EMBEDDINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sticker_embedding_index_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    build_id TEXT,
    selected_model_id TEXT,
    selected_model_updated_at TEXT,
    published_model_id TEXT,
    published_model_updated_at TEXT
  );
  INSERT OR IGNORE INTO sticker_embedding_index_control (id) VALUES (1);
  CREATE TABLE IF NOT EXISTS sticker_embeddings (
    sticker_id TEXT NOT NULL,
    model_config_id TEXT NOT NULL,
    model_config_updated_at TEXT NOT NULL CHECK (length(trim(model_config_updated_at)) > 0),
    semantic_revision INTEGER NOT NULL CHECK (semantic_revision >= 1),
    dimension INTEGER NOT NULL CHECK (dimension > 0),
    vector_json TEXT NOT NULL CHECK (length(vector_json) > 2),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    PRIMARY KEY (sticker_id, model_config_id),
    FOREIGN KEY (sticker_id) REFERENCES stickers(id) ON DELETE CASCADE
  );
`;

export const STICKER_EMBEDDINGS_MODEL_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_sticker_embeddings_model
    ON sticker_embeddings(model_config_id, updated_at);
`;

/**
 * 160 曾只更新 CREATE TABLE，已存在的控制表不会因此获得模型列。
 * 结构修复仅在版本迁移内执行，Repository 继续信任初始化后的 schema。
 */
export async function migrateStickerEmbeddingIndexControl(db: DatabaseWriteExecutor): Promise<void> {
  const columns = new Set((await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(sticker_embedding_index_control)',
  )).map(column => column.name));
  const missingSelection = !columns.has('selected_model_id') || !columns.has('selected_model_updated_at');
  for (const column of ['selected_model_id', 'selected_model_updated_at', 'published_model_id', 'published_model_updated_at']) {
    if (!columns.has(column)) await db.execAsync(`ALTER TABLE sticker_embedding_index_control ADD COLUMN ${column} TEXT;`);
  }
  if (missingSelection) {
    // 补回当前选择并撤销旧执行资格，不推断发布资格、不触碰已有向量。
    await db.execAsync(`UPDATE sticker_embedding_index_control SET
      revision = revision + 1, build_id = NULL,
      selected_model_id = (SELECT embedding_model_config_id FROM sticker_system_config WHERE id = 'global'),
      selected_model_updated_at = (SELECT m.updated_at FROM auxiliary_model_configs m
        JOIN sticker_system_config c ON c.embedding_model_config_id = m.id WHERE c.id = 'global')
      WHERE id = 1;`);
  }
}

/** 默认关闭自动请求；旧库中已有人工语义的待识别项不再允许模型覆盖。 */
export async function migrateStickerRecognitionPolicy(db: DatabaseWriteExecutor): Promise<void> {
  for (const [table, column] of [['stickers', 'annotation_requested'], ['sticker_system_config', 'automatic_recognition_enabled']]) {
    const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some(item => item.name === column)) {
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1));`);
    }
  }
  await db.execAsync(`UPDATE stickers SET annotation_status = CASE WHEN length(trim(COALESCE(description, ''))) > 0 THEN 'ready' ELSE 'manual_required' END,
    annotation_error = NULL, annotation_claim_id = NULL, annotation_claimed_at = NULL
    WHERE owner_assistant_id IS NULL AND annotation_status IN ('pending', 'processing')
      AND (length(trim(COALESCE(description, ''))) > 0 OR tags_json <> '[]' OR emotion IS NOT NULL OR semantic_revision > 1);`);
}

/**
 * 便于调用方一次执行本 Feature 的全部 SQL。各单项常量仍单独导出，方便 migration
 * 在已有库上按阶段复用而不必复制字符串。
 */
export const STICKER_SCHEMA = [
  STICKER_GROUPS_SCHEMA,
  STICKERS_SCHEMA,
  STICKER_OWNERSHIP_INDEXES,
  STICKER_GROUPS_ORDER_INDEX,
  STICKERS_GROUP_ORDER_INDEX,
  STICKERS_FAVORITE_RECENT_INDEX,
  STICKERS_ANNOTATION_INDEX,
].join('\n');

/** Sticker System 的模型与向量表；持久 AI 任务由数据库总装配统一创建。 */
export const STICKER_V2_SCHEMA = [
  STICKER_SYSTEM_CONFIG_SCHEMA,
  STICKER_EMBEDDINGS_SCHEMA,
  STICKER_EMBEDDING_FAILURES_SCHEMA,
  STICKER_EMBEDDINGS_MODEL_INDEX,
].join('\n');
