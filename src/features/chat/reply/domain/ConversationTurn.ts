/**
 * @fileoverview Phase 5A ConversationTurnCoordinator 的回合领域类型。
 *
 * 普通 run 使用固定区间 (replyCursorAtClaim, inputHighWatermark]，重写继承原输入下界，
 * 提交资格由 turn_state 的 fence（revision + active_run_id + 游标）在事务内判定。
 *
 * 归属：Chat reply 领域层。
 */

import type { ChatMessage, CreateMessageInput } from '../../messages/domain/ChatMessage';
import type { ToolPackageExposureChange } from '@shared/aiTools';

/** 自主行动共用会话执行槽；用户回复游标只由普通回复与重写推进。 */
export type ConversationTurnRunStatus =
  | 'active'
  | 'committed'
  | 'superseded'
  | 'cancelled'
  | 'failed';

export type ConversationTurnKind = 'user_reply' | 'regenerate' | 'autonomous';

export type ConversationTurnTerminalStatus = 'cancelled' | 'failed';

/** 一轮持久化的回合 run。 */
export interface ConversationTurnRun {
  runId: string;
  sessionId: string;
  kind: ConversationTurnKind;
  /** 提交 fence 的游标；普通回复也将其用作输入区间下界。 */
  replyCursorAtClaim: number;
  /** 输入区间上界（闭区间）：claim 时会话内用户消息的 MAX(messages.id)。 */
  inputHighWatermark: number;
  /** claim 完成后的 revision 值。 */
  revisionAtClaim: number;
  status: ConversationTurnRunStatus;
  terminalReason: string | null;
  createdAt: string;
  terminalAt: string | null;
  /** 重写使用原输入区间，提交仍比较当前 replyCursorAtClaim，不回退游标。 */
  regenerationSourceRunId?: string | null;
  inputCursorAtClaim?: number | null;
}

/** 菜单资格与重写中的隐藏范围均来自持久化 owner。 */
export interface ChatRegenerationState {
  versionedRunIds: string[];
  eligibleRunId: string | null;
  sourceRunId: string | null;
  hiddenMessageIds: number[];
  /** 只在宿主已 claim 时存在，供提交后取消通知核对句柄所有权。 */
  activeRunId?: string;
}

/**
 * 本轮待提交条目：由 Agent timeline 转换边界提供已排序消息内容；
 * turn_run_id 由提交事务赋值；提前提交的媒体在 T3 绑定最终 turn_item_index。
 */
export interface ConversationTurnCommitItem {
  message: CreateMessageInput;
  /** 工具阶段已经提交的消息；T3 只绑定该事实，用户已删除时不得重新插入。 */
  committedMessageId?: number;
  /** fence 成功后、消息插入前，在同一 T3 transaction 中物化跨 Feature 事实。 */
  materializeInTransaction?: (
    transaction: import('@platform/persistence').DatabaseTransactionExecutor,
    message: CreateMessageInput,
  ) => Promise<CreateMessageInput>;
  /** T3 commit 后清理未被采用的 prepared backing；不得改变已提交业务结果。 */
  finalizeAfterCommit?: () => Promise<void>;
  /** fence 失败或事务回滚后清理本轮尚未被事实接管的 backing。 */
  discardAfterRollback?: () => Promise<void>;
}

/**
 * commitTurn 的明确结果。fence 失败不是异常：整事务零事实落库，
 * 调用方不得把它当错误重试（用户消息事务已触发新一轮 claim）。
 */
export type ConversationTurnCommitResult =
  | { outcome: 'committed'; messageIds: number[]; messages: ChatMessage[]; mediaAssetCandidates?: string[] }
  | { outcome: 'fence_failed' };

/** 随正式回复原子提交的工具包开关；执行顺序决定同包最后一次操作。 */
export interface ConversationToolPackageCommit {
  assistantId: string;
  changes: readonly ToolPackageExposureChange[];
}

/** 仅是宿主启动观测回执的版本；不授予 run 执行或提交资格。 */
export interface ConversationHostStartAttempt {
  sessionId: string;
  requestRevision: number;
  inputHighWatermark: number | null;
}

/** recovery 扫描到的待回复会话（keyset 分页元素）。 */
export interface ConversationTurnUnrepliedSession {
  sessionId: string;
  replyCursor: number;
  /** 扫描时该会话用户消息的 MAX(messages.id)，供防隐式 retry 判据复用，不再二次查询。 */
  highWatermark: number;
  hasRegeneration?: boolean;
}

/**
 * 回合不变量违例：事务内关键条件 UPDATE 影响行数为 0，
 * 整事务回滚，由 databaseCoordinator 包装时保留原始 cause 与任务元数据。
 */
export class ConversationTurnInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationTurnInvariantError';
  }
}
