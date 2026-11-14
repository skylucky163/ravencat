/**
 * @fileoverview ChatMessage 实体定义
 * 归属：Chat messages 领域层。
 */
import type { DatabaseTaskPriority } from '@platform/persistence';

/** 消息发送者类型 */
export type SenderType =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'system';

/** 消息状态 */
export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'sent'
  | 'failed';

/** 分段投递状态 */
export type MessageDeliveryStatus =
  | 'delivered'
  | 'cancelled';

/** 聊天消息实体 */
export interface ChatMessage {
  id: number;
  sessionId: string;
  text: string;
  isMe: boolean;
  isRead: boolean;
  /** assistant 语音首次被原生播放器确认开始播放的时间；与会话已读状态正交。 */
  voicePlayedAt?: string | null;
  senderType: SenderType;
  agentId?: string | null;
  apiMessageId?: string | null;
  clientMessageId?: string | null;
  time: string;
  createdAt: string;
  showTimeSeparatorBefore: boolean;
  updatedAt?: string;
  replyToId?: number | null;
  replyToText?: string | null;
  logicalMessageId?: string | null;
  segmentIndex?: number;
  segmentTotal?: number;
  deliveryStatus?: MessageDeliveryStatus;
  status: MessageStatus;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  metadataJson?: string | null;
  /** 延后封存的回合沿用原输入位置，不因新取得的数据库 ID 排到后续用户消息之后。 */
  timelineAnchor?: { id: number; createdAt: string };
  /**
   * 所属 Agent timeline run。user_reply 在 T3 或已交付正文的中断封存事务中写入；
   * 无用户输入的 Chat-visible run 由 Chat 消息事务写入。transient timeline 沿用同一
   * run 标识，保证提交前后的消息 identity 一致。
   * 工具执行期间写入的 durable 业务卡片（如 Together Listening 邀请卡）也携带本字段，
   * 作为 run-associated external item 参与该 run 的时间线排序（见 ChatTimelineOrdering）。
   */
  turnRunId?: string | null;
  /**
   * 所属 canonical 回合内的稳定顺序（从 1 开始）。
   * Chat canonical timeline 成员携带整数序号；同一 run 内它优先于创建时间和数据库 id。
   * turnRunId 非空而本字段为 NULL 表示 run-associated external item，排序槽位由
   * ChatTimelineOrdering 按其真实 createdAt 推导，写入后不再变化。
   */
  turnItemIndex?: number | null;
}

/**
 * 创建消息时的输入。
 *
 * id 由数据库生成；isRead、status 与时间分隔允许仓储在提交时推导。
 */
export type CreateMessageInput = Omit<
  ChatMessage,
  'id' | 'isRead' | 'status' | 'showTimeSeparatorBefore'
> & Partial<
  Pick<ChatMessage, 'isRead' | 'status' | 'showTimeSeparatorBefore'>
> & {
  /** Phase 5A：本轮待提交条目序号（1..N），与 turnRunId 组成部分唯一索引。 */
  turnItemIndex?: number | null;
};

/** 更新消息时的显式字段白名单。 */
export type UpdateMessageInput = Partial<
  Pick<
    ChatMessage,
    | 'text'
    | 'status'
    | 'isRead'
    | 'voicePlayedAt'
    | 'agentId'
    | 'tokensUsed'
    | 'promptTokens'
    | 'completionTokens'
    | 'apiMessageId'
    | 'clientMessageId'
    | 'metadataJson'
    | 'logicalMessageId'
    | 'segmentIndex'
    | 'segmentTotal'
    | 'deliveryStatus'
  >
>;

/** 消息分页查询参数 */
export interface MessagePaginationParams {
  limit: number;
  cursor?: number | null;
  order?: 'ASC' | 'DESC';
  /**
   * SQLite 调度优先级。默认 `'interactive'`（用户真实交互）。
   * 后台预热等非交互读取必须显式降低优先级，不得伪装成交互工作。
   */
  priority?: DatabaseTaskPriority;
}

/** 分页查询结果 */
export interface PaginatedMessages {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: number | null;
}

/** 发送消息参数 */
export interface SendMessageParams {
  sessionId: string;
  text: string;
  replyToId?: number | null;
  replyToText?: string | null;
}
