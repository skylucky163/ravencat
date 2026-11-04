/**
 * @fileoverview IMessageRepository 接口定义
 * 
 * 这是消息仓储的接口契约，定义了消息数据访问的所有操作。
 * 领域层只依赖此接口，不依赖具体实现。
 * 
 * 实现类：同一 feature 的 SQLiteMessageRepository。
 * 
 * 归属：Chat messages 领域层。
 */

import type {
  ChatMessage,
  CreateMessageInput,
  UpdateMessageInput,
  MessagePaginationParams,
  PaginatedMessages,
} from './ChatMessage';
import type { DatabaseReadExecutor, DatabaseTransactionExecutor } from '@platform/persistence';
import type { ChatRecordStatistics } from './ChatRecordStatistics';
import type { ChatMessageSearchInput, ChatMessageSearchPage } from './ChatMessageSearch';
import type { ChatMessageContext, ChatMessageContextInput } from './ChatMessageContext';

/** 统一消息提交输入：消息内容 + 最终预览文本。 */
export interface CommitMessageInput {
  message: CreateMessageInput;
  previewText: string;
}

/** 批量消息提交输入。 */
export interface CommitMessagesInput {
  messages: CreateMessageInput[];
  /** null 表示本批次没有 assistant 可见消息，不改写 session preview。 */
  previewText: string | null;
}

/** Stateful timeline entry 的幂等提交输入。 */
export interface UpsertStatefulTimelineEntryInput {
  /** 完整消息快照由 Chat 构造；可将同一身份的过程原子转换为最终 assistant 正文。 */
  message: CreateMessageInput;
  previewText: string | null;
}

/** 模型响应证据与执行终态分开：收到响应不代表工具成功。 */
export interface ChatAgentActivityEvidence {
  runId: string;
  respondedAt: string | null;
  terminalCode: string | null;
}

/** Stateful timeline entry 提交结果；inserted=false 表示复用稳定 clientMessageId 更新原行。 */
export interface UpsertStatefulTimelineEntryResult {
  message: ChatMessage;
  inserted: boolean;
}

/** M3a 迁移扫描所需的最小消息候选，不把完整 ChatMessage 读入维护流程。 */
export interface ChatAttachmentMetadataCandidate {
  messageId: number;
  sessionId: string;
  metadataJson: string;
}

export interface ListChatAttachmentMetadataCandidatesParams {
  limit: number;
  /** 只返回 id 大于该游标的候选，便于迁移中断后继续。 */
  afterMessageId?: number | null;
}

export interface CompareAndSwapMetadataJsonInput {
  messageId: number;
  expectedMetadataJson: string;
  metadataJson: string;
}

/**
 * 事务内批量删除消息的结果。
 *
 * 两个字段都来自同一个 exclusive transaction 快照：deletedMessageIds 是这次真正消失的
 * 消息行，mediaAssetCandidates 是这些行「消失那一刻」的 metadata 里引用到的全部 asset id。
 * 调用方必须在 commit 之后用 mediaAssetCandidates 做 targeted release。
 */
export interface DeleteMessagesWithMediaCandidatesResult {
  deletedMessageIds: readonly number[];
  mediaAssetCandidates: readonly string[];
}

/** Chat timeline 中某次 Agent run 的最早 durable item；不泄漏完整消息实体。 */
export interface ChatTimelineAnchorRecord {
  sessionId: string;
  messageId: number;
  runId: string;
}

/**
 * 消息仓储接口
 * 
 * 这是消息模块数据访问的唯一入口。所有对消息数据的 CRUD 操作
 * 都必须通过此接口定义的方法进行。
 * 
 * 实现原则：
 * 1. 所有方法返回 Promise（异步操作）
 * 2. 查询方法失败返回空数组/null，不抛出异常
 * 3. 修改方法失败抛出异常，由调用方处理
 * 4. 所有返回的 ChatMessage 都是不可变对象（建议深拷贝）
 */
export interface IMessageRepository {
  /** 用户搜索当前会话的可见原文，不套用 AI 的成员资格。 */
  searchMessagesForUser(input: ChatMessageSearchInput): Promise<ChatMessageSearchPage>;
  /** 消息必须属于指定会话，附近原文沿用相同可见边界。 */
  readMessageContextForUser(conversationId: string, input: Required<ChatMessageContextInput>): Promise<ChatMessageContext | null>;
  /** 原文搜索不受摘要游标影响；身份授权、可见范围与结果来自同一数据库快照，读取失败抛出。 */
  searchMessagesForAssistant(assistantId: string, input: ChatMessageSearchInput): Promise<ChatMessageSearchPage>;
  /** 锚点授权与邻居读取共享快照；锚点不存在或不可访问时返回 null，不回退到其他消息。 */
  readMessageContextForAssistant(assistantId: string, input: Required<ChatMessageContextInput>): Promise<ChatMessageContext | null>;
  listAgentActivityEvidence(runIds: readonly string[]): Promise<ChatAgentActivityEvidence[]>;
  /** 只结算不属于本进程活动句柄的旧记录，不重新执行模型。 */
  interruptInactiveAgentActivities(activeRunIds: readonly string[], occurredAt: string): Promise<string[]>;
  /** 仍保存的已发送原文及真实调用用量；读取失败抛出，不把失败伪装成零统计。 */
  getChatRecordStatistics(sessionId: string): Promise<ChatRecordStatistics>;
  // ============================================================================
  // 查询操作（Query Operations）
  // ============================================================================
  
  /**
   * 根据ID获取单条消息
   * 
   * @param messageId - 消息ID
   * @returns 消息对象，不存在返回 null
   * @example
   * const message = await messageRepository.getMessageById(123);
   * if (message) {
   *   console.log(message.text);
   * }
   */
  getMessageById(messageId: number): Promise<ChatMessage | null>;
  /** 在业务写事务的同一快照中读取待操作消息。 */
  getMessageByIdInTransaction(transaction: DatabaseTransactionExecutor, messageId: number): Promise<ChatMessage | null>;

  /** 根据会话内的客户端稳定标识获取消息。 */
  getMessageByClientMessageId(
    sessionId: string,
    clientMessageId: string
  ): Promise<ChatMessage | null>;

  /** 重读已加载身份覆盖的持久窗口；没有持久身份时按首屏读取，乐观 ID 不作为数据库边界。 */
  getReloadWindowMessages(sessionId: string, loadedMessageIds: readonly number[]): Promise<ChatMessage[]>;
  
  /**
   * 分页获取历史消息
   * 使用 Cursor-based 分页，适合无限滚动加载
   * 
   * @param sessionId - 会话ID
   * @param params - 分页参数
   * @returns 分页结果，包含消息列表和游标信息
   * @example
   * // 首次加载
   * const result = await messageRepository.getMessages('session_001', { limit: 20 });
   * 
   * // 加载更多
   * const more = await messageRepository.getMessages('session_001', {
   *   limit: 15,
   *   cursor: result.nextCursor
   * });
   */
  getMessages(
    sessionId: string,
    params: MessagePaginationParams
  ): Promise<PaginatedMessages>;

  /** 读取最近的可展示消息，排除推理、工具及尚未到达的分段，按旧到新返回。 */
  getRecentPreviewMessages(sessionId: string, limit: number, excludedMessageIds: readonly number[]): Promise<ChatMessage[]>;
  
  /**
   * 获取比指定消息更新的消息
   * 用于检查新消息（如从后台返回时）
   * 
   * @param sessionId - 会话ID
   * @param afterId - 参考消息ID（加载比此ID大的消息）
   * @returns 消息列表（按时间升序排列）
   */
  getNewerMessages(sessionId: string, afterId: number): Promise<ChatMessage[]>;

  /**
   * 获取会话中最后一条消息
   *
   * 用于在消息落库前判断是否需要在新消息前显示时间分隔。
   * 语义是「底层真实历史的最后一条」，不受 clear history 可见边界影响；
   * 只有 presentation 用途才允许使用 getLatestVisibleMessage。
   */
  getLatestMessage(sessionId: string): Promise<ChatMessage | null>;

  /**
   * 获取当前用户可见历史中的最后一条消息
   *
   * 只返回 direct conversation `visible_after_message_id` 边界之后的消息；
   * 群聊没有该边界（sessions 表无对应行），等价于不过滤。
   *
   * 用于会话列表 preview 重算等 presentation 场景：clear history 只是隐藏
   * 历史，被隐藏的消息不得通过本查询重新进入用户可见的会话 preview。
   */
  getLatestVisibleMessage(sessionId: string): Promise<ChatMessage | null>;

  /** 删除事务内读取最新可见正文，预览与删除事实一起提交。 */
  getLatestPreviewMessageInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string): Promise<ChatMessage | null>;
  /** 按选择单位读取完整记录，不受展示分页影响；不包含工具产生的独立业务卡片。 */
  getMessagesInSelectionUnitInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string, selectionKey: string): Promise<ChatMessage[]>;
  /** 删除后重设单聊预览；空会话的活动时间为 null。 */
  updateSessionPreviewInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string, text: string, time: string | null): Promise<void>;

  /** 列表预览共用已到达正式消息与已持久交付的完整运行正文，不赋予运行片段正式消息身份。 */
  getLatestArrivedConversationPreview(sessionId: string, excludedMessageIds: readonly number[]): Promise<Pick<ChatMessage, 'text' | 'metadataJson' | 'createdAt'> | null>;

  /**
   * 获取同一 logical_message_id 下的所有消息段
   *
   * 用于在事件层把 assistant 分段消息重新聚合为一条 logical message。
   */
  getMessagesByLogicalMessageId(sessionId: string, logicalMessageId: string, executor?: DatabaseReadExecutor): Promise<ChatMessage[]>;

  /**
   * 按回合 run 行固定的输入区间读取用户消息：(lowerExclusive, upperInclusive]。
   *
   * Phase 5A：两个界都在 claim 事务内写死在 run 行里，读取不得临时改用
   * turn_state 的当前游标。游标比较只用 < / <=，不依赖 id 连续无空洞。
   */
  listUserMessagesInRange(
    sessionId: string,
    lowerExclusive: number,
    upperInclusive: number
  ): Promise<ChatMessage[]>;

  /**
   * 按 relatedEntity 元数据定位最新一条已发送 assistant 消息 id。
   *
   * 用于 RavenCat 联系尝试的证据扫描：消息表是不可逆证据，
   * 已提交的联系消息必须能被找回，避免错误重放。
   */
  findSentAssistantMessageIdByRelatedEntity(
    relatedEntityType: string,
    relatedEntityId: string,
  ): Promise<number | null>;

  /** 按 Chat 自有时间线排序找到某个 run 的第一条 durable item。 */
  findFirstVisibleTimelineMessageByRunId(
    runId: string,
  ): Promise<ChatTimelineAnchorRecord | null>;

  /**
   * 用一次查询按 Chat 自有时间线排序找到多个 run 的第一条 durable item。
   * 没有任何 durable item 的 run 不返回；返回结果按仓储的 canonical timeline 顺序排列。
   */
  findFirstVisibleTimelineAnchorsByRunIds(
    runIds: readonly string[],
  ): Promise<ChatTimelineAnchorRecord[]>;

  /** 分页列出仍可能含 Chat legacy attachment URI 的 metadata 原文。 */
  listChatAttachmentMetadataCandidates(
    params: ListChatAttachmentMetadataCandidatesParams,
  ): Promise<ChatAttachmentMetadataCandidate[]>;
  
  /**
   * 获取会话消息总数
   * 
   * @param sessionId - 会话ID
   * @returns 消息数量
   */
  getMessageCount(sessionId: string): Promise<number>;

  /**
   * 获取某个 AI 的未读 assistant 消息数
   *
   * 统计口径：is_me = 0、sender_type = 'assistant'、is_read = 0
   */
  getUnreadCountByAI(aiId: string, excludedMessageIds?: readonly number[]): Promise<number>;

  /**
   * 获取某个群聊的未读成员 AI 消息数
   *
   * 统计口径：群消息 session_id 即 groupId，is_me = 0、sender_type = 'assistant'、is_read = 0
   */
  getUnreadCountByGroup(groupId: string, excludedMessageIds?: readonly number[]): Promise<number>;
  
  // ============================================================================
  // 写入操作（Command Operations）
  // ============================================================================
  
  /**
   * 统一消息提交：在同一 exclusive transaction 中插入消息并使用最终 previewText 更新 session。
   *
   * 事务内：
   *   读取 latest message
   *   计算时间分隔状态（调用方未显式提供 showTimeSeparatorBefore 时）
   *   插入消息
   *   查询刚插入的完整 row
   *   使用最终 previewText 更新 sessions
   * commit
   */
  commitMessage(input: CommitMessageInput): Promise<ChatMessage>;

  /**
   * 事务感知的消息提交方法，供需要组合多个 Repository 的原子写入使用。
   * 调用方必须通过 withExclusiveTransactionAsync 进入事务后将 transaction 传入。
   */
  commitMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitMessageInput,
  ): Promise<ChatMessage>;

  /**
   * 统一批量消息提交：在同一 exclusive transaction 中插入所有消息，
   * 并只使用最终 previewText 更新 session 一次；previewText=null 时保持现有 preview。
   *
   * 事务内：
   *   读取 latest message
   *   逐条计算时间分隔状态并插入（以事务内前一条消息为准）
   *   使用最后一条 committed message 的时间与最终 previewText 更新 sessions
   * commit
   */
  commitMessages(input: CommitMessagesInput): Promise<ChatMessage[]>;

  /**
   * 事务感知的批量消息提交方法，供需要组合多个 Repository 的原子写入使用。
   */
  commitMessagesInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitMessagesInput,
  ): Promise<ChatMessage[]>;

  /** 回合 owner 在原 fence 内绑定提前提交消息的最终顺序；已删除返回 null，不重建消息或引用。 */
  bindTurnMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    messageId: number,
    itemIndex: number,
  ): Promise<ChatMessage | null>;

  /**
   * 在调用方拥有的事务中 CAS 更新 metadata_json。
   * 迁移必须同时提交 MediaAsset 行与本次引用；expected raw 不匹配时直接失败，
   * 让外层事务回滚而不是覆盖并发写入。
   */
  compareAndSwapMetadataJsonInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CompareAndSwapMetadataJsonInput,
  ): Promise<void>;

  /**
   * 在同一 exclusive transaction 内按 sessionId + clientMessageId 幂等 upsert stateful timeline entry，
   * 并原子更新 session preview、读回完整消息。commit 后由 Chat command 发布 UI 信号。
   */
  upsertStatefulTimelineEntry(
    input: UpsertStatefulTimelineEntryInput,
  ): Promise<UpsertStatefulTimelineEntryResult>;
  upsertStatefulTimelineEntryInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: UpsertStatefulTimelineEntryInput,
  ): Promise<UpsertStatefulTimelineEntryResult>;

  /**
   * 更新消息
   * 
   * @param messageId - 消息ID
   * @param updates - 更新内容
   * @returns 是否成功
   * @throws 数据库操作失败时抛出异常
   * @example
   * await messageRepository.updateMessage(123, {
   *   status: 'sent',
   *   apiMessageId: 'msg_abc123'
   * });
   */
  updateMessage(messageId: number, updates: UpdateMessageInput): Promise<boolean>;

  /** 调用方已在同一事务验证可编辑性和正文版本，仓储只写正文与当前预览。 */
  editMessageTextInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: { messageId: number; text: string; previewText: string },
  ): Promise<ChatMessage>;
  
  /**
   * 将某个会话中的 assistant 未读消息批量标记为已读
   *
   * @returns 实际更新的消息条数
   */
  markMessagesAsRead(sessionId: string): Promise<number>;

  /**
   * 按消息 id 精确标记已读（幂等；空数组直接返回 0）
   *
   * @returns 实际更新的消息条数
   */
  markMessagesAsReadByIds(messageIds: string[]): Promise<number>;

  /** 首次播放开始时写入；已写入的消息保持原时间并返回 false。 */
  markVoiceMessagePlayed(messageId: number, playedAt: string): Promise<boolean>;
  
  // ============================================================================
  // 删除操作（Delete Operations）
  // ============================================================================
  
  /**
   * 删除单条消息
   * 
   * @param messageId - 消息ID
   * @returns 是否成功
   * @throws 数据库操作失败时抛出异常
   */
  deleteMessage(messageId: number): Promise<boolean>;

  /**
   * 事务感知的批量消息删除：在同一个 exclusive transaction 内读取「真正即将被删除的
   * 这些消息」的当前 metadata_json、从该快照提取媒体引用候选、删除这些消息，并返回本次
   * 实际删除的 message id 与候选。
   *
   * 为什么候选必须在这里取：message metadata 不是不可变事实。legacy attachment migration
   * 会通过 compareAndSwapMetadataJsonInTransaction 把 legacy URI 原地改写成 canonical
   * mediaAssetId。如果调用方先用一次普通查询读到消息、按那次快照算候选、最后才删除，
   * 那么「读取快照」与「真正删除」之间提交的 CAS 引用就永远不会进入候选集：消息消失了，
   * asset 却留在 catalog / backing 里，成为任何引用枚举都再也发现不了的 orphan。
   *
   * 因此候选提取与 message 删除必须基于同一个事务快照，二者之间不允许插入任何 message
   * metadata writer。反过来，排在删除之后提交的 metadata CAS 会因为目标行已消失而失败，
   * 不会制造一条已经失去业务引用的新 asset 事实。
   *
   * 本方法只负责「读当前引用 + 删除消息 + 返回候选」。reasoning 业务规则、session / group
   * preview 与媒体 backing 删除都不属于这个事务。
   *
   * @param messageIds - 本次要删除的消息 id；内部去重，不存在的 id 被忽略
   * @returns 实际删除的 message id 与这些消息原本引用的 asset id 候选（去重、trim 后非空）
   */
  deleteMessagesWithMediaCandidates(
    messageIds: readonly number[],
  ): Promise<DeleteMessagesWithMediaCandidatesResult>;

  deleteMessagesWithMediaCandidatesInTransaction(
    transaction: DatabaseTransactionExecutor,
    messageIds: readonly number[],
    options?: { preserveReplyVersions: boolean },
  ): Promise<DeleteMessagesWithMediaCandidatesResult>;

  // ============================================================================
  // 会话相关操作（Session Operations）
  // ============================================================================
  
  /**
   * 更新会话预览信息
   * 保存最后一条消息和最后活跃时间
   * 
   * @param sessionId - 会话ID
   * @param lastMessage - 最后消息文本预览
   * @param lastTime - 最后一条可见消息时间（ISO格式）；当前可见时间线为空时传 null
   * @returns 是否成功
   */
  updateSessionPreview(
    sessionId: string,
    lastMessage: string,
    lastTime: string | null
  ): Promise<boolean>;

  /** 仅当指定消息仍是稳定时间线末尾时，原子更新会话预览。 */
  updateSessionPreviewForCommittedMessage(input: {
    sessionId: string;
    messageId: number;
    previewText: string;
  }): Promise<boolean>;
}
