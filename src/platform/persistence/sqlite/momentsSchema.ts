/** Moments V2 表结构、索引与数据保留迁移。 */

import type { DatabaseWriteExecutor } from '../runtime';

/**
 * 朋友圈 V2 只承认稳定作者身份：
 *
 * - `author_type='user'` 时 `author_id` 是本机用户 `SELF_USER_PROFILE_ID`；
 * - `author_type='ai'` 时 `author_id` 是 assistant 的不可变 `agentId`。
 *
 * `author_name_snapshot` 只在作者已删除时兜底历史展示，不参与身份、权限与唯一性；
 * 正常展示由 `author_type + author_id` 解析当前名称与头像。
 *
 * `avatar` / `user_name` / `is_ai` / `agent_id` 等 V1 列不再存在：它们表达的是
 * 名称式身份与快照式头像，V2 不保留这套模型。
 *
 * `location_label` 只是用户手填的显示地点文本（nullable），不是定位事实：不含坐标、
 * 不含 provider place id、不回填历史 Moment。编辑与正文、图片、可见范围一起原子提交。
 */
export const MOMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moments (
    id TEXT PRIMARY KEY,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'ai')),
    author_id TEXT NOT NULL,
    author_name_snapshot TEXT NOT NULL,
    content TEXT NOT NULL,
    location_label TEXT,
    audience_mode TEXT NOT NULL DEFAULT 'all' CHECK (audience_mode IN ('all', 'selected', 'all_except')),
    created_at TEXT NOT NULL,
    edited_at TEXT,
    edit_revision INTEGER NOT NULL DEFAULT 0
  );
`;

/**
 * selected audience 的 allow list / all_except 的 deny list；`all` 时本表必须为空。
 *
 * `viewer_agent_id` 引用 `ai_assistants.agent_id`：被删除的 AI 不可能再成为 viewer，
 * 因此 audience 行随 AI 删除级联清理。用户永远不进这张表——用户可见性不通过 ACL 表达。
 */
export const MOMENT_AUDIENCE_AI_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moment_audience_ai (
    moment_id TEXT NOT NULL,
    viewer_agent_id TEXT NOT NULL,
    PRIMARY KEY (moment_id, viewer_agent_id),
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE,
    FOREIGN KEY (viewer_agent_id) REFERENCES ai_assistants(agent_id) ON DELETE CASCADE
  );
`;

/**
 * 评论与回复统一使用稳定作者身份；评论不拥有独立 ACL，永远继承所属 Moment 可见性。
 *
 * `parent_comment_id` 删除行为固定为 SET NULL：父评论被删除后回复保留为顶层评论，
 * 直接 parent 关系随之丢失（本阶段不引入 tombstone）。
 */
export const MOMENT_COMMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moment_comments (
    id TEXT PRIMARY KEY,
    moment_id TEXT NOT NULL,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'ai')),
    author_id TEXT NOT NULL,
    author_name_snapshot TEXT NOT NULL,
    parent_comment_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_comment_id) REFERENCES moment_comments(id) ON DELETE SET NULL
  );
`;

/**
 * 点赞事实即真值：不再有 `has_liked` 之类的聚合状态表。
 *
 * 唯一性建立在稳定 actor identity 上，改名不会让同一 actor 重复点赞。
 * `(moment_id, actor_type, actor_id)` 既是自然主键，也直接覆盖按 Moment 查点赞的访问路径。
 */
export const MOMENT_LIKES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moment_likes (
    moment_id TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai')),
    actor_id TEXT NOT NULL,
    actor_name_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (moment_id, actor_type, actor_id),
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
  );
`;

/** Social Inbox 与源事实同属 Moments；只引用源 Moment/comment，不硬绑 assistant 生命周期。 */
export const MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moment_social_inbox_deliveries (
    delivery_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL UNIQUE,
    recipient_agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'moment_published',
      'comment_on_your_moment',
      'like_on_your_moment',
      'reply_to_your_comment'
    )),
    source_moment_id TEXT NOT NULL,
    source_comment_id TEXT,
    target_comment_id TEXT,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai')),
    actor_id TEXT NOT NULL,
    actor_name_snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT,
    FOREIGN KEY (source_moment_id) REFERENCES moments(id) ON DELETE CASCADE,
    FOREIGN KEY (source_comment_id) REFERENCES moment_comments(id) ON DELETE CASCADE,
    FOREIGN KEY (target_comment_id) REFERENCES moment_comments(id) ON DELETE CASCADE
  );
`;

/** Moment 正文图片引用与当前持久语义快照；删除 Moment 只级联删除引用，不删除 MediaAsset。 */
export const MOMENT_MEDIA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moment_media (
    id TEXT PRIMARY KEY,
    moment_id TEXT NOT NULL,
    media_asset_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    analysis_status TEXT NOT NULL CHECK (analysis_status IN ('pending', 'completed', 'failed')),
    analysis_text TEXT,
    analysis_source TEXT CHECK (analysis_source IS NULL OR analysis_source IN ('model', 'user')),
    analysis_model_config_id TEXT,
    analyzed_at TEXT,
    analysis_error_code TEXT,
    analysis_error_message TEXT,
    analysis_revision INTEGER NOT NULL DEFAULT 0 CHECK (analysis_revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE,
    FOREIGN KEY (media_asset_id) REFERENCES media_assets(id)
  );
`;

/** Moments 自有设置只保存辅助模型引用，不复制模型连接配置。 */
export const MOMENT_SETTINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS moment_settings (
    id TEXT PRIMARY KEY,
    image_analysis_model_config_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const MOMENT_MEDIA_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_media_moment_sort
     ON moment_media(moment_id, sort_order);`,
  `CREATE INDEX IF NOT EXISTS idx_moment_media_asset
     ON moment_media(media_asset_id);`,
] as const;

export const MOMENTS_CREATED_AT_INDEX =
  `CREATE INDEX IF NOT EXISTS idx_moments_created_at ON moments(created_at DESC);`;

/**
 * Timeline keyset 分页的排序索引。
 *
 * `created_at` 单独并不唯一（同一毫秒可以发布多条），因此分页排序必须收敛为
 * `(created_at DESC, id DESC)` 这一组全序，索引也必须与排序完全一致。
 */
export const MOMENTS_CREATED_ID_INDEX =
  `CREATE INDEX IF NOT EXISTS idx_moments_created_id ON moments(created_at DESC, id DESC);`;

export const MOMENT_AUDIENCE_AI_VIEWER_INDEX =
  `CREATE INDEX IF NOT EXISTS idx_moment_audience_ai_viewer ON moment_audience_ai(viewer_agent_id, moment_id);`;

export const MOMENT_COMMENTS_MOMENT_CREATED_INDEX =
  `CREATE INDEX IF NOT EXISTS idx_moment_comments_moment_created ON moment_comments(moment_id, created_at);`;

export const MOMENT_COMMENTS_PARENT_INDEX =
  `CREATE INDEX IF NOT EXISTS idx_moment_comments_parent ON moment_comments(parent_comment_id);`;

export const MOMENT_SOCIAL_INBOX_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_moment_social_inbox_recipient_unread_seq
     ON moment_social_inbox_deliveries(recipient_agent_id, delivery_seq)
     WHERE read_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_moment_social_inbox_recipient_moment_unread_seq
     ON moment_social_inbox_deliveries(recipient_agent_id, source_moment_id, delivery_seq)
     WHERE read_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_moment_social_inbox_source_comment
     ON moment_social_inbox_deliveries(source_comment_id);`,
  `CREATE INDEX IF NOT EXISTS idx_moment_social_inbox_target_comment
     ON moment_social_inbox_deliveries(target_comment_id);`,
  `CREATE INDEX IF NOT EXISTS idx_moment_social_inbox_unread_like_revoke
     ON moment_social_inbox_deliveries(source_moment_id, actor_type, actor_id)
     WHERE event_type = 'like_on_your_moment' AND read_at IS NULL;`,
] as const;

/** 迁移91：只增加空的 Social Inbox 表与索引；历史 Moment/互动不回填投递。 */
export async function migrateMomentSocialInbox(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA);
  for (const index of MOMENT_SOCIAL_INBOX_INDEXES) {
    await db.execAsync(index);
  }
}

/** 迁移92：只增加空的 Moment Media 与 Settings schema，不扫描或回填历史事实。 */
export async function migrateMomentMediaAndSettings(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(MOMENT_MEDIA_SCHEMA);
  for (const index of MOMENT_MEDIA_INDEXES) {
    await db.execAsync(index);
  }
  await db.execAsync(MOMENT_SETTINGS_SCHEMA);
}

/** 识别失败原因与状态一同保留；旧记录没有可恢复的接口原因，保持 NULL。 */
export async function migrateMomentAnalysisErrorMessage(db: DatabaseWriteExecutor): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info('moment_media')");
  if (!columns.some(column => column.name === 'analysis_error_message')) {
    await db.execAsync('ALTER TABLE moment_media ADD COLUMN analysis_error_message TEXT;');
  }
}

/**
 * 迁移93：增加 `moments.location_label` 与 Timeline keyset 排序索引。
 *
 * 数据保留型：`ALTER TABLE ... ADD COLUMN` 只追加一个 nullable 列，不重建整表，因此
 * Moment / audience / comment / like / media / Social Inbox 事实全部原地保留。历史 Moment
 * 的 `location_label` 保持 NULL——地点是用户手填的显示事实，不回填也不猜测。
 *
 * 幂等：迁移90 会用新的 `MOMENTS_SCHEMA` 重建 moments 表（旧字段复制、地点自然为 NULL），
 * 因此同一份代码在不同升级路径下到达本迁移时列可能已经存在，此时必须 no-op。
 */
export async function migrateMomentLocationLabel(db: DatabaseWriteExecutor): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info('moments')`);
  if (columns.length === 0) {
    return;
  }
  if (!columns.some((column) => column.name === 'location_label')) {
    await db.execAsync('ALTER TABLE moments ADD COLUMN location_label TEXT;');
  }
  await db.execAsync(MOMENTS_CREATED_ID_INDEX);
}

/** V1 朋友圈相关的全部物理表；重建迁移必须把它们一起清掉。 */
const LEGACY_MOMENT_TABLES = [
  'moment_ai_interactions',
  'moment_comments',
  'moment_likes',
  'moment_audience_ai',
  'moments',
] as const;

/**
 * 迁移87：Moments V1 → V2。
 *
 * V1 的 `moments.user_name` / `moment_comments.is_ai+agent_id` / `moment_likes.user_name`
 * 是名称式身份，且 `moment_comments` 没有 `created_at`；`moment_ai_interactions` 表达的是
 * “系统挑选 AI 后限制首次互动”的 V1 状态机。这些事实无法可靠映射到稳定身份，
 * 因此本迁移直接重建四张 V2 表并清理 V1 朋友圈数据，而不是用用户名猜 author_id。
 *
 * 只触碰 Moments 自己的表；Chat / MediaAsset / assistant / profile 不受影响。
 * 建表语句与 fresh schema 共用同一份常量，保证 fresh 与 upgraded 的列、FK、索引完全一致。
 */
export async function migrateMomentsV2(db: DatabaseWriteExecutor): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info('moments')`);
  if (columns.length === 0) {
    return;
  }
  if (columns.some((column) => column.name === 'author_type')) {
    return;
  }

  console.warn(
    '[persistence:sqlite.bootstrap] 迁移87：重建 Moments V2 表结构并清理 V1 朋友圈数据',
  );

  await db.execAsync('BEGIN;');
  try {
    for (const table of LEGACY_MOMENT_TABLES) {
      await db.execAsync(`DROP TABLE IF EXISTS ${table};`);
    }
    await db.execAsync(MOMENTS_SCHEMA);
    await db.execAsync(MOMENT_AUDIENCE_AI_SCHEMA);
    await db.execAsync(MOMENT_COMMENTS_SCHEMA);
    await db.execAsync(MOMENT_LIKES_SCHEMA);
    await db.execAsync('COMMIT;');
  } catch (error) {
    try {
      await db.execAsync('ROLLBACK;');
    } catch {
      // 事务可能尚未成功开始，保留原始迁移错误。
    }
    throw error;
  }
}

/**
 * 迁移90：为既有 V2 Moments 增加 `all_except`。
 *
 * SQLite 不能原地修改 CHECK constraint，因此只重建 `moments` 单表。外键暂时关闭时，
 * comment / like / audience 原表不会被级联删除；新表沿用相同主键，迁移结束后重新开启
 * 外键并执行完整性检查。migration87 的历史清理行为不重放。
 */
export async function migrateMomentsAudienceAllExcept(
  db: DatabaseWriteExecutor
): Promise<void> {
  const row = await db.getFirstAsync<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'moments' LIMIT 1`
  );
  if (!row?.sql || row.sql.includes("'all_except'")) {
    return;
  }

  const foreignKeys = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys;');
  await db.execAsync('PRAGMA foreign_keys = OFF;');
  try {
    await db.execAsync('BEGIN IMMEDIATE;');
    try {
      await db.execAsync(`
        ${MOMENTS_SCHEMA.replace(
          'CREATE TABLE IF NOT EXISTS moments',
          'CREATE TABLE moments_all_except_migration'
        )}
        INSERT INTO moments_all_except_migration
          (id, author_type, author_id, author_name_snapshot, content, audience_mode, created_at)
        SELECT id, author_type, author_id, author_name_snapshot, content, audience_mode, created_at
        FROM moments;
        DROP TABLE moments;
        ALTER TABLE moments_all_except_migration RENAME TO moments;
      `);
      await db.execAsync('COMMIT;');
    } catch (error) {
      await db.execAsync('ROLLBACK;').catch(() => undefined);
      throw error;
    }
  } finally {
    if (foreignKeys?.foreign_keys === 1) {
      await db.execAsync('PRAGMA foreign_keys = ON;');
    }
  }

  const violations = await db.getAllAsync<Record<string, unknown>>('PRAGMA foreign_key_check;');
  if (violations.length > 0) {
    throw new Error('迁移90：Moments all_except 迁移后外键完整性检查失败');
  }
}
