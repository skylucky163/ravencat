// 朋友圈 V2 仓储：稳定作者身份、AI audience、社交事实与 Inbox 投递。

import { CoordinatedDatabaseError, databaseCoordinator } from '@platform/persistence';
import type {
  CoordinatedDatabaseExecutor,
  DatabaseReadExecutor,
  DatabaseTransactionExecutor,
  DatabaseWriteExecutor,
} from '@platform/persistence';
import type {
  IMomentRepository,
  Moment,
  MomentActorType,
  MomentAudienceMode,
  MomentComment,
  MomentLike,
  MomentMedia,
  MomentMediaAnalysisSource,
  MomentMediaAnalysisStatus,
  MomentSettings,
  MomentDetailSnapshot,
  MomentSocialDelivery,
  MomentSocialDeliveryEventType,
  MomentPageRequest,
  MomentPageCursor,
  MomentQueryRequest,
  MomentQueryEntry,
  MomentTimelineEntry,
  CreateMomentInput,
  InsertMomentCommentInput,
  InsertMomentLikeInput,
} from '../domain/MomentRepository';
import { MomentDomainError } from '../domain/MomentErrors';

interface MomentRow {
  id: string;
  author_type: string;
  author_id: string;
  author_name_snapshot: string;
  content: string;
  location_label: string | null;
  audience_mode: string;
  created_at: string;
}

interface MomentCommentRow {
  id: string;
  moment_id: string;
  author_type: string;
  author_id: string;
  author_name_snapshot: string;
  parent_comment_id: string | null;
  content: string;
  created_at: string;
}

interface MomentLikeRow {
  moment_id: string;
  actor_type: string;
  actor_id: string;
  actor_name_snapshot: string;
  created_at: string;
}

interface MomentSocialDeliveryRow {
  delivery_seq: number;
  delivery_id: string;
  recipient_agent_id: string;
  event_type: string;
  source_moment_id: string;
  source_comment_id: string | null;
  target_comment_id: string | null;
  actor_type: string;
  actor_id: string;
  actor_name_snapshot: string;
  created_at: string;
  read_at: string | null;
}

interface MomentMediaRow {
  id: string;
  moment_id: string;
  media_asset_id: string;
  sort_order: number;
  analysis_status: string;
  analysis_text: string | null;
  analysis_source: string | null;
  analysis_model_config_id: string | null;
  analyzed_at: string | null;
  analysis_error_code: string | null;
  analysis_error_message: string | null;
  analysis_revision: number;
  created_at: string;
  updated_at: string;
}

interface MomentSettingsRow {
  image_analysis_model_config_id: string | null;
  created_at: string;
  updated_at: string;
}

const MOMENT_COLUMNS =
  'id, author_type, author_id, author_name_snapshot, content, location_label, audience_mode, created_at';
/** 带 `moments` 别名的同一份列清单，供带 JOIN/EXISTS 条件的可见性查询使用。 */
const MOMENT_COLUMNS_QUALIFIED = MOMENT_COLUMNS
  .split(', ')
  .map((column) => `m.${column}`)
  .join(', ');
const COMMENT_COLUMNS =
  'id, moment_id, author_type, author_id, author_name_snapshot, parent_comment_id, content, created_at';
const LIKE_COLUMNS = 'moment_id, actor_type, actor_id, actor_name_snapshot, created_at';
const SOCIAL_DELIVERY_COLUMNS = [
  'delivery_seq', 'delivery_id', 'recipient_agent_id', 'event_type',
  'source_moment_id', 'source_comment_id', 'target_comment_id',
  'actor_type', 'actor_id', 'actor_name_snapshot', 'created_at', 'read_at',
].join(', ');
const MEDIA_COLUMNS = [
  'id', 'moment_id', 'media_asset_id', 'sort_order', 'analysis_status',
  'analysis_text', 'analysis_source', 'analysis_model_config_id', 'analyzed_at',
  'analysis_error_code', 'analysis_error_message', 'analysis_revision', 'created_at', 'updated_at',
].join(', ');

/**
 * AI viewer 的可见性条件，必须是唯一的 ACL 真值来源。
 *
 * - 作者自己天然可见：AI 发布的 Moment 即使 `selected` 且未把自己写进 audience 也仍可读；
 * - `all` 对所有 AI 可见；
 * - `selected` 仅对 `moment_audience_ai` 中登记的 agentId 可见；
 * - `all_except` 对关系表中未登记的 agentId 可见。
 *
 * 用户读路径不使用这段条件：AI audience 只约束其他 AI。
 */
const AGENT_VISIBILITY_PREDICATE = `(
  (m.author_type = 'ai' AND m.author_id = ?)
  OR m.audience_mode = 'all'
  OR (m.audience_mode = 'selected' AND EXISTS (
    SELECT 1 FROM moment_audience_ai a
    WHERE a.moment_id = m.id AND a.viewer_agent_id = ?
  ))
  OR (m.audience_mode = 'all_except' AND NOT EXISTS (
    SELECT 1 FROM moment_audience_ai a
    WHERE a.moment_id = m.id AND a.viewer_agent_id = ?
  ))
)`;

function toMoment(row: MomentRow): Moment {
  return {
    id: row.id,
    authorType: row.author_type as MomentActorType,
    authorId: row.author_id,
    authorNameSnapshot: row.author_name_snapshot,
    content: row.content,
    locationLabel: row.location_label,
    createdAt: row.created_at,
    audienceMode: row.audience_mode as MomentAudienceMode,
  };
}

function toComment(row: MomentCommentRow): MomentComment {
  return {
    id: row.id,
    momentId: row.moment_id,
    authorType: row.author_type as MomentActorType,
    authorId: row.author_id,
    authorNameSnapshot: row.author_name_snapshot,
    parentCommentId: row.parent_comment_id || null,
    content: row.content,
    createdAt: row.created_at,
  };
}

function toLike(row: MomentLikeRow): MomentLike {
  return {
    momentId: row.moment_id,
    actorType: row.actor_type as MomentActorType,
    actorId: row.actor_id,
    actorNameSnapshot: row.actor_name_snapshot,
    createdAt: row.created_at,
  };
}

function toSocialDelivery(row: MomentSocialDeliveryRow): MomentSocialDelivery {
  return {
    deliverySeq: row.delivery_seq,
    deliveryId: row.delivery_id,
    recipientAgentId: row.recipient_agent_id,
    eventType: row.event_type as MomentSocialDeliveryEventType,
    sourceMomentId: row.source_moment_id,
    sourceCommentId: row.source_comment_id,
    targetCommentId: row.target_comment_id,
    actorType: row.actor_type as MomentActorType,
    actorId: row.actor_id,
    actorNameSnapshot: row.actor_name_snapshot,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function toMedia(row: MomentMediaRow): MomentMedia {
  return {
    id: row.id,
    momentId: row.moment_id,
    mediaAssetId: row.media_asset_id,
    sortOrder: row.sort_order,
    analysisStatus: row.analysis_status as MomentMediaAnalysisStatus,
    analysisText: row.analysis_text,
    analysisSource: row.analysis_source as MomentMediaAnalysisSource | null,
    analysisModelConfigId: row.analysis_model_config_id,
    analyzedAt: row.analyzed_at,
    analysisErrorCode: row.analysis_error_code,
    analysisErrorMessage: row.analysis_error_message,
    analysisRevision: row.analysis_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createDeliveryId(): string {
  return `moment_delivery_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Timeline keyset 分页条件。
 *
 * 排序全序固定为 `(created_at DESC, id DESC)`，因此「下一页」严格是排在上一页最后一条
 * 之后的位置。cursor 携带的是值而不是行引用：cursor 指向的 Moment 被删除后，用它继续
 * 翻页依然成立，调用方不需要（也不允许）为了翻页去重新查询 cursor 行。
 *
 * 不使用 OFFSET：顶部插入新 Moment 会让 OFFSET 窗口整体位移，直接产生重复或跳过。
 */
function createMomentCursorWhere(
  cursor: MomentPageCursor | null | undefined,
  alias: '' | 'm',
): { sql: string; params: string[] } {
  if (!cursor) return { sql: '', params: [] };
  const prefix = alias ? `${alias}.` : '';
  return {
    sql: `(${prefix}created_at < ? OR (${prefix}created_at = ? AND ${prefix}id < ?))`,
    params: [cursor.createdAt, cursor.createdAt, cursor.id],
  };
}

async function insertSocialDelivery(
  transaction: DatabaseWriteExecutor,
  input: {
    recipientAgentId: string;
    eventType: MomentSocialDeliveryEventType;
    sourceMomentId: string;
    sourceCommentId: string | null;
    targetCommentId: string | null;
    actorType: MomentActorType;
    actorId: string;
    actorNameSnapshot: string;
    createdAt: string;
  }
): Promise<void> {
  await transaction.runAsync(
    `INSERT INTO moment_social_inbox_deliveries (
       delivery_id, recipient_agent_id, event_type, source_moment_id,
       source_comment_id, target_comment_id, actor_type, actor_id,
       actor_name_snapshot, created_at, read_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      createDeliveryId(), input.recipientAgentId, input.eventType, input.sourceMomentId,
      input.sourceCommentId, input.targetCommentId, input.actorType, input.actorId,
      input.actorNameSnapshot, input.createdAt,
    ]
  );
}

/** 朋友圈仓储。所有 SQL 都留在自己的 Feature 内，只经 databaseCoordinator 执行。 */
export class SQLiteMomentRepository implements IMomentRepository {
  // ==================== 用户读路径 ====================

  private async readMomentsForUser(database: DatabaseReadExecutor, options?: MomentPageRequest): Promise<Moment[]> {
    if (!options) {
      const rows = await database.getAllAsync<MomentRow>(
        `SELECT ${MOMENT_COLUMNS} FROM moments ORDER BY created_at DESC, id DESC`
      );
      return rows.map(toMoment);
    }

    const cursor = createMomentCursorWhere(options.cursor, '');
    const conditions = cursor.sql ? [cursor.sql] : [];
    const params: (string | number)[] = [...cursor.params];
    if (options.author) {
      conditions.push('author_type = ? AND author_id = ?');
      params.push(options.author.actorType, options.author.actorId);
    }
    const rows = await database.getAllAsync<MomentRow>(
      `SELECT ${MOMENT_COLUMNS} FROM moments
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, options.limit]
    );
    return rows.map(toMoment);
  }

  async listMomentTimelineForUser(options?: MomentPageRequest): Promise<MomentTimelineEntry[]> {
    const database = this.#executor('moments.listMomentTimelineForUser', 'surface');
    // 一页只读取四组事实，避免每条动态反复排队；事务内不解析图片文件或当前头像。
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const moments = await this.readMomentsForUser(transaction, options);
      if (moments.length === 0) return [];
      const ids = moments.map((moment) => moment.id);
      const placeholders = ids.map(() => '?').join(', ');
      const comments = await transaction.getAllAsync<MomentCommentRow>(
        `SELECT ${COMMENT_COLUMNS} FROM moment_comments
         WHERE moment_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`, ids,
      );
      const likes = await transaction.getAllAsync<MomentLikeRow>(
        `SELECT ${LIKE_COLUMNS} FROM moment_likes
         WHERE moment_id IN (${placeholders}) ORDER BY created_at ASC, actor_id ASC`, ids,
      );
      const media = await transaction.getAllAsync<MomentMediaRow>(
        `SELECT ${MEDIA_COLUMNS} FROM moment_media
         WHERE moment_id IN (${placeholders}) ORDER BY sort_order ASC`, ids,
      );
      const entries = moments.map((moment): MomentTimelineEntry => ({
        ...moment, comments: [], likes: [], media: [],
      }));
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      for (const row of comments) byId.get(row.moment_id)!.comments.push(toComment(row));
      for (const row of likes) byId.get(row.moment_id)!.likes.push(toLike(row));
      for (const row of media) byId.get(row.moment_id)!.media.push(toMedia(row));
      return entries;
    });
  }

  async getMomentForUser(momentId: string): Promise<Moment | null> {
    const database = this.#executor('moments.getMomentForUser', 'runtime');
    const row = await database.getFirstAsync<MomentRow>(
      `SELECT ${MOMENT_COLUMNS} FROM moments WHERE id = ? LIMIT 1`,
      [momentId]
    );
    return row ? toMoment(row) : null;
  }

  async getMomentDetailForUser(momentId: string): Promise<MomentTimelineEntry | null> {
    const database = this.#executor('moments.getMomentDetailForUser', 'surface');
    return database.withExclusiveTransactionAsync(async transaction => {
      const row = await transaction.getFirstAsync<MomentRow>(`SELECT ${MOMENT_COLUMNS} FROM moments WHERE id = ?`, [momentId]);
      if (!row) return null;
      const media = await transaction.getAllAsync<MomentMediaRow>(`SELECT ${MEDIA_COLUMNS} FROM moment_media WHERE moment_id = ? ORDER BY sort_order`, [momentId]);
      const comments = await transaction.getAllAsync<MomentCommentRow>(`SELECT ${COMMENT_COLUMNS} FROM moment_comments WHERE moment_id = ? ORDER BY created_at, id`, [momentId]);
      const likes = await transaction.getAllAsync<MomentLikeRow>(`SELECT ${LIKE_COLUMNS} FROM moment_likes WHERE moment_id = ? ORDER BY created_at, actor_id`, [momentId]);
      return { ...toMoment(row), media: media.map(toMedia), comments: comments.map(toComment), likes: likes.map(toLike) };
    });
  }

  // ==================== AI viewer 读路径 ====================

  async queryVisibleMomentsForAgent(
    viewerAgentId: string,
    options: MomentQueryRequest,
  ): Promise<MomentQueryEntry[]> {
    const database = this.#executor('moments.queryVisibleMomentsForAgent', 'runtime');
    const conditions = [AGENT_VISIBILITY_PREDICATE];
    const params: (string | number)[] = [viewerAgentId, viewerAgentId, viewerAgentId];
    if (options.author) {
      conditions.push('m.author_type = ? AND m.author_id = ?');
      params.push(options.author.actorType, options.author.actorId);
    }
    if (options.keyword) {
      const matches = [
        'instr(lower(m.content), lower(?)) > 0',
        "instr(lower(COALESCE(m.location_label, '')), lower(?)) > 0",
      ];
      params.push(options.keyword, options.keyword);
      for (const author of options.keywordAuthors ?? []) {
        matches.push('(m.author_type = ? AND m.author_id = ?)');
        params.push(author.actorType, author.actorId);
      }
      // 活跃作者按当前名称匹配；作者已删除时，保留原有的历史名称查询语义。
      const currentAuthors = options.currentAuthors ?? [];
      const knownAuthorPredicate = currentAuthors.map(() => '(m.author_type = ? AND m.author_id = ?)').join(' OR ');
      matches.push(`(instr(lower(m.author_name_snapshot), lower(?)) > 0${knownAuthorPredicate ? ` AND NOT (${knownAuthorPredicate})` : ''})`);
      params.push(options.keyword);
      for (const author of currentAuthors) params.push(author.actorType, author.actorId);
      conditions.push(`(${matches.join(' OR ')})`);
    }
    if (options.createdAtFrom) {
      conditions.push('m.created_at >= ?');
      params.push(options.createdAtFrom);
    }
    if (options.createdAtBefore) {
      conditions.push('m.created_at < ?');
      params.push(options.createdAtBefore);
    }
    if (options.onlyMyComments || options.commentKeyword) {
      const commentConditions = ['c.moment_id = m.id'];
      if (options.onlyMyComments) {
        commentConditions.push("c.author_type = 'ai' AND c.author_id = ?");
        params.push(viewerAgentId);
      }
      if (options.commentKeyword) {
        commentConditions.push('instr(lower(c.content), lower(?)) > 0');
        params.push(options.commentKeyword);
      }
      conditions.push(`EXISTS (SELECT 1 FROM moment_comments c WHERE ${commentConditions.join(' AND ')})`);
    }
    const cursor = createMomentCursorWhere(options.cursor, 'm');
    if (cursor.sql) {
      conditions.push(cursor.sql);
      params.push(...cursor.params);
    }
    params.push(options.limit);
    // 页面与自己的评论使用同一个快照，避免把两次读取拼成不存在的社交状态。
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const rows = await transaction.getAllAsync<MomentRow>(
        `SELECT ${MOMENT_COLUMNS_QUALIFIED} FROM moments m
         WHERE ${conditions.join(' AND ')}
         ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
        params,
      );
      if (rows.length === 0) return [];
      const comments = await transaction.getAllAsync<MomentCommentRow>(
        `SELECT ${COMMENT_COLUMNS} FROM moment_comments
         WHERE author_type = 'ai' AND author_id = ?
           AND moment_id IN (${rows.map(() => '?').join(', ')})
         ORDER BY created_at ASC, id ASC`,
        [viewerAgentId, ...rows.map((row) => row.id)],
      );
      const ownComments = new Map<string, MomentComment[]>();
      for (const row of comments) {
        const group = ownComments.get(row.moment_id) ?? [];
        group.push(toComment(row));
        ownComments.set(row.moment_id, group);
      }
      return rows.map((row) => ({ ...toMoment(row), ownComments: ownComments.get(row.id) ?? [] }));
    });
  }

  async getVisibleMomentForAgent(
    viewerAgentId: string,
    momentId: string
  ): Promise<Moment | null> {
    const database = this.#executor('moments.getVisibleMomentForAgent', 'runtime');
    const row = await database.getFirstAsync<MomentRow>(
      `SELECT m.${MOMENT_COLUMNS.replaceAll(', ', ', m.')}
       FROM moments m
       WHERE m.id = ? AND ${AGENT_VISIBILITY_PREDICATE}
       LIMIT 1`,
      [momentId, viewerAgentId, viewerAgentId, viewerAgentId]
    );
    return row ? toMoment(row) : null;
  }

  async captureMomentDetailForAgent(
    viewerAgentId: string,
    momentId: string
  ): Promise<MomentDetailSnapshot | null> {
    const database = this.#executor('moments.captureMomentDetailForAgent', 'runtime');
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const momentRow = await transaction.getFirstAsync<MomentRow>(
        `SELECT m.${MOMENT_COLUMNS.replaceAll(', ', ', m.')}
         FROM moments m
         WHERE m.id = ? AND ${AGENT_VISIBILITY_PREDICATE}
         LIMIT 1`,
        [momentId, viewerAgentId, viewerAgentId, viewerAgentId]
      );
      if (!momentRow) return null;

      const cutoff = await transaction.getFirstAsync<{ cutoff_seq: number | null }>(
        `SELECT MAX(delivery_seq) AS cutoff_seq
         FROM moment_social_inbox_deliveries
         WHERE recipient_agent_id = ? AND source_moment_id = ? AND read_at IS NULL`,
        [viewerAgentId, momentId]
      );
      const comments = await transaction.getAllAsync<MomentCommentRow>(
        `SELECT ${COMMENT_COLUMNS} FROM moment_comments
         WHERE moment_id = ? ORDER BY created_at ASC, id ASC`,
        [momentId]
      );
      const media = await transaction.getAllAsync<MomentMediaRow>(
        `SELECT ${MEDIA_COLUMNS} FROM moment_media
         WHERE moment_id = ? ORDER BY sort_order ASC`,
        [momentId]
      );
      const likes = await transaction.getAllAsync<MomentLikeRow>(
        `SELECT ${LIKE_COLUMNS} FROM moment_likes
         WHERE moment_id = ? ORDER BY created_at ASC, actor_id ASC`,
        [momentId]
      );
      return {
        moment: toMoment(momentRow),
        media: media.map(toMedia),
        comments: comments.map(toComment),
        likes: likes.map(toLike),
        unreadCutoffSeq: cutoff?.cutoff_seq ?? null,
      };
    });
  }

  // ==================== Moment 写入 ====================

  async createMoment(input: CreateMomentInput): Promise<Moment> {
    const database = this.#executor('moments.createMoment', 'runtime');
    // Moment、allow/deny list 与发布投递共享唯一 commit boundary。
    return database.withExclusiveTransactionAsync((transaction) =>
      this.createMomentInTransaction(transaction, input)
    );
  }

  async createMomentInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CreateMomentInput
  ): Promise<Moment> {
    const createdAt = new Date().toISOString();
    const audienceMode: MomentAudienceMode = input.audience.mode;
    const viewerAgentIds = input.audience.mode === 'all' ? [] : input.audience.viewerAgentIds;
    // 地点与正文同属发布瞬间的不可变事实，必须与 Moment 行一起提交，不能先建后 UPDATE。
    await transaction.runAsync(
      `INSERT INTO moments (${MOMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.authorType, input.authorId, input.authorNameSnapshot,
        input.content, input.locationLabel, audienceMode, createdAt]
    );
    for (const viewerAgentId of viewerAgentIds) {
      await transaction.runAsync(
        `INSERT INTO moment_audience_ai (moment_id, viewer_agent_id) VALUES (?, ?)`,
        [input.id, viewerAgentId]
      );
    }
    for (const media of input.media ?? []) {
      await transaction.runAsync(
        `INSERT INTO moment_media (${MEDIA_COLUMNS})
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
        [media.id, input.id, media.mediaAssetId, media.sortOrder, createdAt, createdAt]
      );
    }
    for (const recipientAgentId of input.deliveryRecipientAgentIds) {
      await insertSocialDelivery(transaction, {
        recipientAgentId,
        eventType: 'moment_published',
        sourceMomentId: input.id,
        sourceCommentId: null,
        targetCommentId: null,
        actorType: input.authorType,
        actorId: input.authorId,
        actorNameSnapshot: input.authorNameSnapshot,
        createdAt,
      });
    }

    return {
      id: input.id,
      authorType: input.authorType,
      authorId: input.authorId,
      authorNameSnapshot: input.authorNameSnapshot,
      content: input.content,
      locationLabel: input.locationLabel,
      createdAt,
      audienceMode,
    };
  }

  async deleteMoment(momentId: string): Promise<boolean> {
    const database = this.#executor('moments.deleteMoment', 'runtime');
    const result = await database.runAsync('DELETE FROM moments WHERE id = ?', [momentId]);
    return result.changes > 0;
  }

  // ==================== 正文图片与语义快照 ====================

  async listMedia(momentId: string): Promise<MomentMedia[]> {
    const database = this.#executor('moments.listMedia', 'runtime');
    const rows = await database.getAllAsync<MomentMediaRow>(
      `SELECT ${MEDIA_COLUMNS} FROM moment_media WHERE moment_id = ? ORDER BY sort_order ASC`,
      [momentId]
    );
    return rows.map(toMedia);
  }

  async getMedia(mediaId: string): Promise<MomentMedia | null> {
    const database = this.#executor('moments.getMedia', 'runtime');
    const row = await database.getFirstAsync<MomentMediaRow>(
      `SELECT ${MEDIA_COLUMNS} FROM moment_media WHERE id = ? LIMIT 1`,
      [mediaId]
    );
    return row ? toMedia(row) : null;
  }

  async saveModelAnalysis(input: {
    mediaId: string;
    expectedRevision: number;
    expectedPending?: boolean;
    text: string;
    modelConfigId: string;
    analyzedAt: string;
  }): Promise<boolean> {
    const database = this.#executor('moments.saveModelAnalysis', 'runtime');
    const result = await database.runAsync(
      `UPDATE moment_media
       SET analysis_status = 'completed', analysis_text = ?, analysis_source = 'model',
           analysis_model_config_id = ?, analyzed_at = ?, analysis_error_code = NULL,
           analysis_error_message = NULL,
           analysis_revision = analysis_revision + 1, updated_at = ?
       WHERE id = ? AND analysis_revision = ?${input.expectedPending ? " AND analysis_status = 'pending'" : ''}`,
      [input.text, input.modelConfigId, input.analyzedAt, input.analyzedAt,
        input.mediaId, input.expectedRevision]
    );
    return result.changes > 0;
  }

  async saveAnalysisFailure(input: {
    mediaId: string;
    expectedRevision: number;
    expectedPending?: boolean;
    errorCode: string;
    errorMessage: string;
    analyzedAt: string;
  }): Promise<boolean> {
    const database = this.#executor('moments.saveAnalysisFailure', 'runtime');
    const result = await database.runAsync(
      `UPDATE moment_media
       SET analysis_status = 'failed', analysis_text = NULL, analysis_source = NULL,
           analysis_model_config_id = NULL, analyzed_at = ?, analysis_error_code = ?,
           analysis_error_message = ?,
           analysis_revision = analysis_revision + 1, updated_at = ?
       WHERE id = ? AND analysis_revision = ?
         AND NOT (analysis_status = 'completed' AND analysis_text IS NOT NULL)
         ${input.expectedPending ? "AND analysis_status = 'pending'" : ''}`,
      [input.analyzedAt, input.errorCode, input.errorMessage, input.analyzedAt, input.mediaId, input.expectedRevision]
    );
    return result.changes > 0;
  }

  async editMediaAnalysis(input: {
    mediaId: string;
    text: string;
    analyzedAt: string;
  }): Promise<MomentMedia | null> {
    const database = this.#executor('moments.editMediaAnalysis', 'runtime');
    await database.runAsync(
      `UPDATE moment_media
       SET analysis_status = 'completed', analysis_text = ?, analysis_source = 'user',
           analysis_model_config_id = NULL, analyzed_at = ?, analysis_error_code = NULL,
           analysis_error_message = NULL,
           analysis_revision = analysis_revision + 1, updated_at = ?
       WHERE id = ?`,
      [input.text, input.analyzedAt, input.analyzedAt, input.mediaId]
    );
    return this.getMedia(input.mediaId);
  }

  async getSettings(): Promise<MomentSettings | null> {
    const database = this.#executor('moments.getSettings', 'runtime');
    const row = await database.getFirstAsync<MomentSettingsRow>(
      `SELECT image_analysis_model_config_id, created_at, updated_at
       FROM moment_settings WHERE id = 'global' LIMIT 1`
    );
    return row ? {
      imageAnalysisModelConfigId: row.image_analysis_model_config_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  /** 显式取消同样保存行；首次配置不覆盖它，也不扫描历史图片。 */
  async initializeImageAnalysisModelInTransaction(transaction: DatabaseTransactionExecutor, modelConfigId: string, now: string): Promise<void> {
    await transaction.runAsync(`INSERT OR IGNORE INTO moment_settings (id, image_analysis_model_config_id, created_at, updated_at)
      VALUES ('global', ?, ?, ?)`, [modelConfigId, now, now]);
  }

  async saveSettings(modelConfigId: string | null, updatedAt: string): Promise<MomentSettings> {
    const database = this.#executor('moments.saveSettings', 'runtime');
    await database.runAsync(
      `INSERT INTO moment_settings (id, image_analysis_model_config_id, created_at, updated_at)
       VALUES ('global', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         image_analysis_model_config_id = excluded.image_analysis_model_config_id,
         updated_at = excluded.updated_at`,
      [modelConfigId, updatedAt, updatedAt]
    );
    return (await this.getSettings())!;
  }

  // ==================== 评论 ====================

  async listComments(momentId: string): Promise<MomentComment[]> {
    const database = this.#executor('moments.listComments', 'runtime');
    const rows = await database.getAllAsync<MomentCommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM moment_comments
       WHERE moment_id = ? ORDER BY created_at ASC, id ASC`,
      [momentId]
    );
    return rows.map(toComment);
  }

  async getComment(commentId: string): Promise<MomentComment | null> {
    const database = this.#executor('moments.getComment', 'runtime');
    const row = await database.getFirstAsync<MomentCommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM moment_comments WHERE id = ? LIMIT 1`,
      [commentId]
    );
    return row ? toComment(row) : null;
  }

  async insertComments(
    inputs: readonly InsertMomentCommentInput[]
  ): Promise<MomentComment[]> {
    if (inputs.length === 0) {
      return [];
    }

    const database = this.#executor('moments.insertComments', 'runtime');
    const createdAt = new Date().toISOString();
    const verifiedParents = new Map<string, {
      momentId: string;
      authorType: MomentActorType;
      authorId: string;
    }>();

    await database.withExclusiveTransactionAsync(async (transaction) => {
      for (const input of inputs) {
        if (input.parentCommentId) {
          // 回复完整性：parent comment 必须存在且属于同一条 Moment，禁止跨 Moment 挂载。
          let parent = verifiedParents.get(input.parentCommentId);
          if (parent === undefined) {
            const parentRow = await transaction.getFirstAsync<{
              moment_id: string;
              author_type: string;
              author_id: string;
            }>(
              'SELECT moment_id, author_type, author_id FROM moment_comments WHERE id = ? LIMIT 1',
              [input.parentCommentId]
            );
            if (!parentRow) {
              throw new MomentDomainError(
                'comment_not_found',
                '回复目标评论不存在',
                input.parentCommentId
              );
            }
            parent = {
              momentId: parentRow.moment_id,
              authorType: parentRow.author_type as MomentActorType,
              authorId: parentRow.author_id,
            };
            verifiedParents.set(input.parentCommentId, parent);
          }
          if (parent.momentId !== input.momentId) {
            throw new MomentDomainError(
              'comment_moment_mismatch',
              '回复目标评论不属于该条时刻动态',
              input.parentCommentId
            );
          }
        }
      }

      for (const input of inputs) {
        await transaction.runAsync(
          `INSERT INTO moment_comments (${COMMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.id,
            input.momentId,
            input.authorType,
            input.authorId,
            input.authorNameSnapshot,
            input.parentCommentId,
            input.content,
            createdAt,
          ]
        );

        if (input.parentCommentId) {
          const parent = verifiedParents.get(input.parentCommentId)!;
          if (parent.authorType === 'ai'
            && !(input.authorType === 'ai' && input.authorId === parent.authorId)) {
            await insertSocialDelivery(transaction, {
              recipientAgentId: parent.authorId,
              eventType: 'reply_to_your_comment',
              sourceMomentId: input.momentId,
              sourceCommentId: input.id,
              targetCommentId: input.parentCommentId,
              actorType: input.authorType,
              actorId: input.authorId,
              actorNameSnapshot: input.authorNameSnapshot,
              createdAt,
            });
          }
          continue;
        }

        const momentOwner = await transaction.getFirstAsync<{
          author_type: string;
          author_id: string;
        }>('SELECT author_type, author_id FROM moments WHERE id = ? LIMIT 1', [input.momentId]);
        if (momentOwner?.author_type === 'ai'
          && !(input.authorType === 'ai' && input.authorId === momentOwner.author_id)) {
          await insertSocialDelivery(transaction, {
            recipientAgentId: momentOwner.author_id,
            eventType: 'comment_on_your_moment',
            sourceMomentId: input.momentId,
            sourceCommentId: input.id,
            targetCommentId: null,
            actorType: input.authorType,
            actorId: input.authorId,
            actorNameSnapshot: input.authorNameSnapshot,
            createdAt,
          });
        }
      }
    }).catch((error: unknown) => {
      // 回复完整性由本事务裁决，出口恢复领域拒绝，存储故障保留原诊断。
      if (error instanceof CoordinatedDatabaseError && error.cause instanceof MomentDomainError) throw error.cause;
      throw error;
    });

    return inputs.map((input) => ({
      id: input.id,
      momentId: input.momentId,
      authorType: input.authorType,
      authorId: input.authorId,
      authorNameSnapshot: input.authorNameSnapshot,
      parentCommentId: input.parentCommentId,
      content: input.content,
      createdAt,
    }));
  }

  async deleteComment(commentId: string): Promise<boolean> {
    const database = this.#executor('moments.deleteComment', 'runtime');
    const result = await database.runAsync(
      'DELETE FROM moment_comments WHERE id = ?',
      [commentId]
    );
    return result.changes > 0;
  }

  // ==================== 点赞 ====================

  async listLikes(momentId: string): Promise<MomentLike[]> {
    const database = this.#executor('moments.listLikes', 'runtime');
    const rows = await database.getAllAsync<MomentLikeRow>(
      `SELECT ${LIKE_COLUMNS} FROM moment_likes
       WHERE moment_id = ? ORDER BY created_at ASC, actor_id ASC`,
      [momentId]
    );
    return rows.map(toLike);
  }

  async insertLike(input: InsertMomentLikeInput): Promise<MomentLike | null> {
    const database = this.#executor('moments.insertLike', 'runtime');
    const createdAt = new Date().toISOString();

    const inserted = await database.withExclusiveTransactionAsync(async (transaction) => {
      // fact insert 的 changes 是 delivery 是否生成的唯一判据，重复 like 不产生新投递。
      const result = await transaction.runAsync(
        `INSERT INTO moment_likes (${LIKE_COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(moment_id, actor_type, actor_id) DO NOTHING`,
        [input.momentId, input.actorType, input.actorId, input.actorNameSnapshot, createdAt]
      );
      if (result.changes === 0) return false;

      const owner = await transaction.getFirstAsync<{ author_type: string; author_id: string }>(
        'SELECT author_type, author_id FROM moments WHERE id = ? LIMIT 1',
        [input.momentId]
      );
      if (owner?.author_type === 'ai'
        && !(input.actorType === 'ai' && input.actorId === owner.author_id)) {
        await insertSocialDelivery(transaction, {
          recipientAgentId: owner.author_id,
          eventType: 'like_on_your_moment',
          sourceMomentId: input.momentId,
          sourceCommentId: null,
          targetCommentId: null,
          actorType: input.actorType,
          actorId: input.actorId,
          actorNameSnapshot: input.actorNameSnapshot,
          createdAt,
        });
      }
      return true;
    });

    if (!inserted) {
      return null;
    }
    return {
      momentId: input.momentId,
      actorType: input.actorType,
      actorId: input.actorId,
      actorNameSnapshot: input.actorNameSnapshot,
      createdAt,
    };
  }

  async removeLike(
    momentId: string,
    actorType: MomentActorType,
    actorId: string
  ): Promise<boolean> {
    const database = this.#executor('moments.removeLike', 'runtime');
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const result = await transaction.runAsync(
        'DELETE FROM moment_likes WHERE moment_id = ? AND actor_type = ? AND actor_id = ?',
        [momentId, actorType, actorId]
      );
      if (result.changes === 0) return false;
      await transaction.runAsync(
        `DELETE FROM moment_social_inbox_deliveries
         WHERE source_moment_id = ? AND event_type = 'like_on_your_moment'
           AND actor_type = ? AND actor_id = ? AND read_at IS NULL`,
        [momentId, actorType, actorId]
      );
      return true;
    });
  }

  // ==================== Social Inbox ====================

  async listUnreadSocialDeliveries(
    recipientAgentId: string,
    options?: { limit?: number }
  ): Promise<MomentSocialDelivery[]> {
    const database = this.#executor('moments.listUnreadSocialDeliveries', 'runtime');
    const rows = options?.limit === undefined
      ? await database.getAllAsync<MomentSocialDeliveryRow>(
          `SELECT ${SOCIAL_DELIVERY_COLUMNS} FROM moment_social_inbox_deliveries
           WHERE recipient_agent_id = ? AND read_at IS NULL ORDER BY delivery_seq ASC`,
          [recipientAgentId]
        )
      : await database.getAllAsync<MomentSocialDeliveryRow>(
          `SELECT ${SOCIAL_DELIVERY_COLUMNS} FROM moment_social_inbox_deliveries
           WHERE recipient_agent_id = ? AND read_at IS NULL
           ORDER BY delivery_seq ASC LIMIT ?`,
          [recipientAgentId, options.limit]
        );
    return rows.map(toSocialDelivery);
  }

  async markMomentSocialDeliveriesReadThrough(
    recipientAgentId: string,
    momentId: string,
    cutoffSeq: number
  ): Promise<void> {
    const database = this.#executor('moments.markMomentSocialDeliveriesReadThrough', 'runtime');
    await database.runAsync(
      `UPDATE moment_social_inbox_deliveries SET read_at = ?
       WHERE recipient_agent_id = ? AND source_moment_id = ?
         AND read_at IS NULL AND delivery_seq <= ?`,
      [new Date().toISOString(), recipientAgentId, momentId, cutoffSeq]
    );
  }

  #executor(name: string, priority: 'surface' | 'runtime' | 'maintenance'): CoordinatedDatabaseExecutor {
    return databaseCoordinator.openTaskExecutor({ name, feature: 'moments', priority });
  }
}

// 单例实例
export const momentRepository = new SQLiteMomentRepository();
