/**
 * @fileoverview IConversationTurnRepository 接口定义。
 *
 * Phase 5A ConversationTurnCoordinator 的回合仓储契约：四类状态转换事务
 * （T1 supersede / T2 claim / T3 commit fence / T4 revoke）与 recovery 扫描查询。
 *
 * 实现类：同一 feature 的 SQLiteConversationTurnRepository。
 *
 * 归属：Chat reply 领域层。
 */

import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { ChatReplyVersionHistory } from './ChatReplyVersion';
import type {
  ConversationTurnCommitItem,
  ConversationToolPackageCommit,
  ConversationTurnCommitResult,
  ConversationTurnKind,
  ConversationTurnRun,
  ConversationTurnTerminalStatus,
  ConversationTurnUnrepliedSession,
  ChatRegenerationState,
  ConversationHostStartAttempt,
} from './ConversationTurn';

export interface IConversationTurnRepository {
  listRunStates(runIds: readonly string[]): Promise<{ runId: string; status: ConversationTurnRun['status'] }[]>;
  getActiveRun(sessionId: string): Promise<ConversationTurnRun | null>;
  /** 启动恢复只终结不属于本进程的自主 owner，不重放其模型或工具。 */
  interruptAbandonedAutonomousRuns(activeRunIds: readonly string[]): Promise<string[]>;
  /** 与用户回复共用唯一 active 槽；有待回复输入或未完成交付时让用户优先。 */
  claimAutonomousIfIdle(sessionId: string, runId: string): Promise<ConversationTurnRun | null>;
  /** 自主执行只释放所有权，不消费或推进用户回复游标。 */
  finishAutonomous(run: ConversationTurnRun): Promise<void>;
  beginExecutionHostRequests(sessionIds: readonly string[]): Promise<ConversationHostStartAttempt[]>;
  finishExecutionHostRequests(attempts: readonly ConversationHostStartAttempt[], accepted: boolean): Promise<void>;
  isRunCurrentInTransaction(transaction: DatabaseTransactionExecutor, runId: string): Promise<boolean>;
  getRegenerationState(sessionId: string): Promise<ChatRegenerationState>;
  getReplyVersionHistory(sessionId: string, runId: string): Promise<ChatReplyVersionHistory | null>;
  /** 在同一事务裁决最新回合资格并替换当前候选，不执行模型或工具。 */
  adoptReplyVersion(sessionId: string, runId: string, versionId: string, expectedVersionId: string): Promise<void>;
  /** 只持久化用户意图；实际 claim 和执行仍由 Android 宿主完成。 */
  requestRegeneration(sessionId: string, messageId: number): Promise<number>;
  /** 启动失败只能撤销自己的请求，不能撤销后来一次重写。 */
  cancelRegeneration(sessionId: string, requestRevision: number): Promise<void>;
  /**
   * T1 前半段：新会话惰性创建 turn_state 行（cursor=0, revision=0）。
   * 调用方必须在事务内先调用本方法，再插入用户消息。
   */
  ensureTurnStateRowInTransaction(
    transaction: DatabaseTransactionExecutor,
    sessionId: string,
  ): Promise<void>;

  /**
   * T1 后半段：turn_state 存在 active run 时，在同一事务内把旧 run 置 superseded、
   * 清 active_run_id/kind、revision+1；无 active run 时是纯空操作。
   *
   * @returns 被 supersede 的 runId；无 active run 返回 null
   */
  supersedeActiveRunInTransaction(
    transaction: DatabaseTransactionExecutor,
    sessionId: string,
  ): Promise<string | null>;

  /**
   * T2 模式一：CAS 含 active_run_id IS NULL；已有 active run 时返回 null，
   * 不得抢走正常 active run。普通发送流程与重复触发一律使用此模式。
   *
   * @returns 新 active run；无待回复输入／重写意图、已有 active run，或输入已被失败／取消终态覆盖时返回 null
   */
  claimIfIdle(
    sessionId: string,
    kind: ConversationTurnKind,
  ): Promise<ConversationTurnRun | null>;

  /**
   * T2 模式二：完整 claim，事务内 supersede 既有 active run（崩溃孤儿）。
   * 只有 recovery 在确认当前进程无对应内存句柄时才允许使用。
   * 与 claimIfIdle 一样，不重新领取失败／取消终态覆盖的输入。
   */
  takeOverOrphan(
    sessionId: string,
    kind: ConversationTurnKind,
  ): Promise<ConversationTurnRun | null>;

  /**
   * T3：单事务写入剩余 items 并绑定已提交媒体的 turn_item_index、
   * session preview、run 终态 committed、游标推进与 revision+1。
   * fence（reply_cursor + revision + active_run_id）失败返回 fence_failed，
   * 零事实落库，不抛给调用方当异常重试。
   */
  commitTurn(
    run: ConversationTurnRun,
    items: ConversationTurnCommitItem[],
    toolPackages: ConversationToolPackageCommit,
    execution?: { deadlineAt: number; signal?: AbortSignal },
  ): Promise<ConversationTurnCommitResult>;

  /** 在同一 run fence 内提交并发布工具输出，不推进输入游标或结束执行；T3 复用其消息身份。 */
  commitOutput(
    run: ConversationTurnRun,
    item: ConversationTurnCommitItem,
    execution?: { deadlineAt?: number; signal?: AbortSignal },
  ): Promise<ConversationTurnCommitResult>;

  /** 当前会话与 AI 尚未过期的包；权限仍由 Host policy 冻结。 */
  listOpenToolPackageIds(sessionId: string, assistantId: string): Promise<string[]>;

  /**
   * T4：cancel / fail。turn_state CAS 成功时同事务写 run 行终态；
   * CAS 影响 0 行说明 run 已被 supersede/commit 失去所有权，
   * 不再改 turn_state，只按 status='active' 尽力写 run 行终态。
   */
  revoke(
    run: ConversationTurnRun,
    status: ConversationTurnTerminalStatus,
    reason: string,
  ): Promise<void>;

  /**
   * 防隐式 retry 判据：是否存在覆盖当前高水位、状态为 failed/cancelled 的 run。
   */
  findTerminalRunCovering(
    sessionId: string,
    highWatermark: number,
  ): Promise<ConversationTurnRun | null>;

  /**
   * 单会话回合快照：execution host 在 claimIfIdle 落空后区分
   * 「无待回复输入」与「存在持久化 active 孤儿」，并供防隐式 retry 判据取高水位。
   * 无用户消息时返回 null。
   */
  getSessionTurnSnapshot(
    sessionId: string,
  ): Promise<ConversationTurnUnrepliedSession | null>;

  /**
   * recovery 扫描：未回复的 canonical 用户输入、待执行重写意图或重写孤儿，keyset 分页。
   * 通话状态消息不属于 canonical user_reply 输入。
   */
  listSessionsWithUnrepliedInput(
    afterSessionId: string,
    limit: number,
  ): Promise<ConversationTurnUnrepliedSession[]>;
}
