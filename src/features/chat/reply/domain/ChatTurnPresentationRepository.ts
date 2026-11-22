import type { ConversationTurnRun } from './ConversationTurn';
import type { ChatTurnDisplayVersion, ChatTurnPresentationHistory, ChatTurnPresentationWindow, ChatTurnExecutionProgress, ChatTurnExecutionStatus, ChatInterruptedTurnContext } from './ChatTurnPresentation';

/** 不执行模型、不重放工具；所有写入均不改变 ConversationTurn revision 或回复游标。 */
export interface IChatTurnPresentationRepository {
  open(run: ConversationTurnRun): Promise<boolean>;
  checkpoint(runId: string, items: readonly ChatTurnDisplayVersion[], progress?: ChatTurnExecutionProgress): Promise<boolean>;
  getExecutionStatus(sessionId: string): Promise<ChatTurnExecutionStatus | null>;
  /** 发布版本并原子收口已交付回合；已关闭时拒绝发布，完成变化由提交后的调用方通知。 */
  publishVersions(runId: string, items: readonly ChatTurnDisplayVersion[]): Promise<{ completed: boolean } | null>;
  /** 原子发布当前 canonical 版本并收口已交付批次，返回本次发布的确切版本。 */
  publishMessage(messageId: number): Promise<ChatTurnDisplayVersion | null>;
  listPublishedMessageIds(runIds: readonly string[]): Promise<number[]>;
  listHistory(sessionId: string, window?: ChatTurnPresentationWindow): Promise<ChatTurnPresentationHistory[]>;
  /** 未消费输入包含已发生正文；普通历史已读取封存消息，只补独立执行资料。 */
  listInterruptedContext(sessionId: string, fromInputId: number, toInputId?: number, scope?: 'pending_input' | 'history'): Promise<ChatInterruptedTurnContext[]>;
  listOpenRunIds(sessionId: string): Promise<string[]>;
  interruptOrphans(activeRunIds: readonly string[]): Promise<void>;
  interrupt(runId: string, reason: string): Promise<void>;
}
