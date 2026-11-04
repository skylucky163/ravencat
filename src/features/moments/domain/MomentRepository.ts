/** 朋友圈实体、稳定作者身份、图片语义、AI audience 与持久化端口。 */

import type { DatabaseTransactionExecutor } from '@platform/persistence';

/** 朋友圈作者与互动参与者的身份类型。 */
export type MomentActorType = 'user' | 'ai';

/**
 * AI audience 模式。
 *
 * - `all`：所有 AI 可见；
 * - `selected`：仅 `moment_audience_ai` 中登记的 AI 可见；
 * - `all_except`：除 `moment_audience_ai` 中登记的 AI 外都可见。
 *
 * 该模式只约束 AI：用户永远能看到全部合法 Moment。
 */
export type MomentAudienceMode = 'all' | 'selected' | 'all_except';

export interface Moment {
  id: string;
  authorType: MomentActorType;
  /** 稳定作者身份：user 是 SELF_USER_PROFILE_ID，ai 是不可变 agentId。 */
  authorId: string;
  /** 仅用于作者已删除时的历史展示兜底；不参与身份、权限与唯一性。 */
  authorNameSnapshot: string;
  content: string;
  /** 用户手填的显示地点；没有地点时是 `null`，不制造伪位置。 */
  locationLabel: string | null;
  createdAt: string;
  audienceMode: MomentAudienceMode;
}

export interface MomentComment {
  id: string;
  momentId: string;
  authorType: MomentActorType;
  authorId: string;
  authorNameSnapshot: string;
  /** 直接回复目标；顶层评论为 null。 */
  parentCommentId: string | null;
  content: string;
  createdAt: string;
}

export interface MomentLike {
  momentId: string;
  actorType: MomentActorType;
  actorId: string;
  actorNameSnapshot: string;
  createdAt: string;
}

export type MomentMediaAnalysisStatus = 'pending' | 'completed' | 'failed';
export type MomentMediaAnalysisSource = 'model' | 'user';

export interface MomentMedia {
  id: string;
  momentId: string;
  mediaAssetId: string;
  sortOrder: number;
  analysisStatus: MomentMediaAnalysisStatus;
  analysisText: string | null;
  analysisSource: MomentMediaAnalysisSource | null;
  analysisModelConfigId: string | null;
  analyzedAt: string | null;
  analysisErrorCode: string | null;
  analysisErrorMessage: string | null;
  analysisRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMomentMediaReferenceInput {
  id: string;
  mediaAssetId: string;
  sortOrder: number;
}

export interface MomentSettings {
  imageAnalysisModelConfigId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MomentSocialDeliveryEventType =
  | 'moment_published'
  | 'comment_on_your_moment'
  | 'like_on_your_moment'
  | 'reply_to_your_comment';

/** Moments 自有的社交投递事实；deliverySeq 只用于严格单调的读取 cutoff。 */
export interface MomentSocialDelivery {
  deliverySeq: number;
  deliveryId: string;
  recipientAgentId: string;
  eventType: MomentSocialDeliveryEventType;
  sourceMomentId: string;
  sourceCommentId: string | null;
  targetCommentId: string | null;
  actorType: MomentActorType;
  actorId: string;
  actorNameSnapshot: string;
  createdAt: string;
  readAt: string | null;
}

export interface MomentDetailSnapshot {
  moment: Moment;
  media: MomentMedia[];
  comments: MomentComment[];
  likes: MomentLike[];
  unreadCutoffSeq: number | null;
}

/** 用户时间线一页内的正文与社交事实，共享同一次数据库快照。 */
export interface MomentTimelineEntry extends Moment {
  media: MomentMedia[];
  comments: MomentComment[];
  likes: MomentLike[];
}

/**
 * 待写入的 AI audience：`all` 不写关系行；`selected` 是 allow list；
 * `all_except` 是 deny list。Application 会把空 deny list 归一化为 `all`。
 */
export type MomentAudience =
  | { mode: 'all' }
  | { mode: 'selected'; viewerAgentIds: readonly string[] }
  | { mode: 'all_except'; viewerAgentIds: readonly string[] };

export interface CreateMomentInput {
  id: string;
  authorType: MomentActorType;
  authorId: string;
  authorNameSnapshot: string;
  content: string;
  /** 已经 canonical 的显示地点；调用方负责归一化，仓储不再猜默认值。 */
  locationLabel: string | null;
  audience: MomentAudience;
  /** 发布瞬间的可见 AI 快照；Repository 只负责在同一事务中 fanout。 */
  deliveryRecipientAgentIds: readonly string[];
  media?: readonly CreateMomentMediaReferenceInput[];
}

export interface InsertMomentCommentInput {
  id: string;
  momentId: string;
  authorType: MomentActorType;
  authorId: string;
  authorNameSnapshot: string;
  parentCommentId: string | null;
  content: string;
}

export interface InsertMomentLikeInput {
  momentId: string;
  actorType: MomentActorType;
  actorId: string;
  actorNameSnapshot: string;
}

/**
 * Moment Timeline 的 keyset cursor。
 *
 * 排序全序是 `(created_at DESC, id DESC)`：`created_at` 单独不唯一（同一毫秒可以发布
 * 多条，AI 也可以在后台发布），因此 cursor 必须同时携带两个字段。
 *
 * cursor 是**值**而不是行引用：cursor 指向的那条 Moment 被删除后，用它继续分页仍然
 * 成立，调用方不得为了翻页去重新查询 cursor 行。
 */
export interface MomentPageCursor {
  createdAt: string;
  id: string;
}

export interface MomentPageRequest {
  limit: number;
  /** 作者筛选先于分页；用户查看某位 AI 的主页仍使用用户读权限。 */
  author?: { actorType: MomentActorType; actorId: string };
  /** 第一页为 `null` / 省略；下一页传上一页最后一条实际显示的 item。 */
  cursor?: MomentPageCursor | null;
}

/** AI 查询的筛选已由工具边界归一化；仓储在分页之前执行筛选和 ACL。 */
export interface MomentQueryRequest extends MomentPageRequest {
  keyword?: string;
  keywordAuthors?: readonly { actorType: MomentActorType; actorId: string }[];
  currentAuthors?: readonly { actorType: MomentActorType; actorId: string }[];
  createdAtFrom?: string;
  createdAtBefore?: string;
  onlyMyComments?: boolean;
  commentKeyword?: string;
}

export interface MomentQueryEntry extends Moment {
  ownComments: MomentComment[];
}

/**
 * 朋友圈持久化端口。
 *
 * 读路径必须显式区分 viewer 身份：
 * - `...ForUser` 是用户 UI 读模型，不经过 AI ACL（用户能看到全部 Moment）；
 * - `...ForAgent` 的 AI ACL 由 SQL 直接执行，禁止"取全量再在 Prompt 层过滤"。
 *
 * 评论不拥有独立 ACL：它的可见性完全继承所属 Moment，因此 `listComments` /
 * `listLikes` 不含 ACL，由 Application 层在读取前先断言 Moment 可见。
 */
export interface IMomentRepository {
  listMomentTimelineForUser(options?: MomentPageRequest): Promise<MomentTimelineEntry[]>;
  getMomentForUser(momentId: string): Promise<Moment | null>;
  getMomentDetailForUser(momentId: string): Promise<MomentTimelineEntry | null>;

  /** AI viewer 读路径；viewer 是不可变 agentId。 */
  queryVisibleMomentsForAgent(
    viewerAgentId: string,
    options: MomentQueryRequest
  ): Promise<MomentQueryEntry[]>;
  getVisibleMomentForAgent(viewerAgentId: string, momentId: string): Promise<Moment | null>;
  captureMomentDetailForAgent(
    viewerAgentId: string,
    momentId: string
  ): Promise<MomentDetailSnapshot | null>;

  /** Moment 与 selected/all_except audience 行在同一事务内提交。 */
  createMoment(input: CreateMomentInput): Promise<Moment>;
  createMomentInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CreateMomentInput
  ): Promise<Moment>;
  deleteMoment(momentId: string): Promise<boolean>;

  listMedia(momentId: string): Promise<MomentMedia[]>;
  getMedia(mediaId: string): Promise<MomentMedia | null>;
  saveModelAnalysis(input: {
    mediaId: string;
    expectedRevision: number;
    expectedPending?: boolean;
    text: string;
    modelConfigId: string;
    analyzedAt: string;
  }): Promise<boolean>;
  saveAnalysisFailure(input: {
    mediaId: string;
    expectedRevision: number;
    expectedPending?: boolean;
    errorCode: string;
    errorMessage: string;
    analyzedAt: string;
  }): Promise<boolean>;
  editMediaAnalysis(input: {
    mediaId: string;
    text: string;
    analyzedAt: string;
  }): Promise<MomentMedia | null>;
  getSettings(): Promise<MomentSettings | null>;
  saveSettings(modelConfigId: string | null, updatedAt: string): Promise<MomentSettings>;

  listComments(momentId: string): Promise<MomentComment[]>;
  getComment(commentId: string): Promise<MomentComment | null>;
  /**
   * 一次业务评论操作的全部评论行在同一事务内提交：一次 AI 回复产生的多条评论
   * 不允许出现"提交一半"的中间态。回复必须与 parent comment 属于同一 Moment，否则拒绝写入。
   */
  insertComments(
    inputs: readonly InsertMomentCommentInput[]
  ): Promise<MomentComment[]>;
  deleteComment(commentId: string): Promise<boolean>;

  listLikes(momentId: string): Promise<MomentLike[]>;
  /** 同一稳定 identity 重复点赞时返回 null，不报错。 */
  insertLike(input: InsertMomentLikeInput): Promise<MomentLike | null>;
  removeLike(
    momentId: string,
    actorType: MomentActorType,
    actorId: string
  ): Promise<boolean>;

  listUnreadSocialDeliveries(
    recipientAgentId: string,
    options?: { limit?: number }
  ): Promise<MomentSocialDelivery[]>;
  markMomentSocialDeliveriesReadThrough(
    recipientAgentId: string,
    momentId: string,
    cutoffSeq: number
  ): Promise<void>;

}
