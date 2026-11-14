/**
 * @fileoverview commitCanonicalUserMessage —— Phase 5A T1 专用用户消息事务入口（方案 16.2）。
 *
 * 同一 coordinator transaction 内组合：
 *   ensureTurnStateRowInTransaction（新会话惰性建行）
 *   → messages.commitMessageInTransaction（既有 latest 读取、时间分隔、preview 逻辑不变）
 *   → supersedeActiveRunInTransaction（仅当 turn_state 存在 active run）
 *
 * 只有 canonical 1:1 用户消息走它；旁路 writer（assistant 消息、Calls 状态消息等）
 * 继续使用通用 commitMessage，行为不变，不会隐式 supersede user_reply run。
 * commit 后更新 UI，再由执行宿主接管后续回合。
 */

import {
  databaseCoordinator,
  type DatabaseTransactionExecutor,
} from '@platform/persistence';
import type { ChatMessage, CreateMessageInput } from '../domain/ChatMessage';
import type { CommitMessageInput, IMessageRepository } from '../domain/MessageRepository';
import type { IConversationTurnRepository } from '../../reply/domain/ConversationTurnRepository';
import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { emitChatTurnExecutionChanged } from '../events/ChatEvents';
import { isSubstantiveUserMessage } from '../domain/SubstantiveUserMessage';

export interface CommitCanonicalUserMessageParams {
  message: CreateMessageInput;
  /** 同次发送的前置消息；与尾消息在同一个 T1 内提交，只换代一次。 */
  precedingMessages?: readonly CommitMessageInput[];
  previewText?: string | null;
  notifyUI?: (sessionId: string) => void;
  repository?: IMessageRepository;
  materializeMessagesInTransaction?: (transaction: DatabaseTransactionExecutor, messages: readonly CommitMessageInput[]) => Promise<CommitMessageInput[]>;
  turns?: IConversationTurnRepository;
  /** T1 所属事务内把外部已准备事实转换为最终 Chat message；只允许 SQL 与纯转换。 */
  materializeMessageInTransaction?: (
    transaction: DatabaseTransactionExecutor,
    message: CreateMessageInput,
  ) => Promise<CreateMessageInput>;
}

export interface CommitCanonicalUserMessageResult {
  message: ChatMessage;
  messages: ChatMessage[];
  /** 被本事务 supersede 的旧 active run；无 active run 为 null。Host 据此精确 abort 并移除内存句柄。 */
  supersededRunId: string | null;
}

export async function commitCanonicalUserMessage(
  params: CommitCanonicalUserMessageParams
): Promise<CommitCanonicalUserMessageResult> {
  const repository = params.repository ?? getChatMessageRuntimeDependencies().messages;
  const turns = params.turns ?? getChatMessageRuntimeDependencies().turns;
  const sessionId = params.message.sessionId;
  const presentation = getChatMessageRuntimeDependencies().turnPresentation;
  const release = await presentation.freeze(sessionId);
  let committed = false;
  try {

    const result = await databaseCoordinator.transaction(
      { name: 'chat.commit-user-message', feature: 'chat', priority: 'interactive' },
      async (transaction) => {
        await turns.ensureTurnStateRowInTransaction(transaction, sessionId);
        const submission = [...(params.precedingMessages ?? []), { message: params.message, previewText: params.previewText ?? params.message.text }];
        const inputs = params.materializeMessagesInTransaction
          ? await params.materializeMessagesInTransaction(transaction, submission) : submission;
        const messages: ChatMessage[] = [];
        for (const input of inputs.slice(0, -1)) {
          messages.push(await repository.commitMessageInTransaction(transaction, input));
        }
        const materializedMessage = params.materializeMessageInTransaction
          ? await params.materializeMessageInTransaction(transaction, inputs[inputs.length - 1].message)
          : inputs[inputs.length - 1].message;
        const message = await repository.commitMessageInTransaction(transaction, {
          message: materializedMessage,
          previewText: params.previewText ?? materializedMessage.text,
        });
        messages.push(message);
        if (messages.some(isSubstantiveUserMessage)) {
          await getChatMessageRuntimeDependencies().canonicalUserMessage?.onSubstantiveInputInTransaction?.(
            transaction, sessionId, message.createdAt,
          );
        }
        const supersededRunId = await turns.supersedeActiveRunInTransaction(
          transaction,
          sessionId,
        );
        return { message, messages, supersededRunId };
      },
    );
    committed = true;
    emitChatTurnExecutionChanged(sessionId);
    await presentation.interrupt(sessionId).catch(error => {
      console.warn('[CommitCanonicalUserMessage] 中断历史刷新失败', error);
    });

    // T1 已冻结旧批次，提交后恢复的是已确认版本，不能再清空整轮展示。
    // 事务到这里已经提交：以下都是不可回滚的提交后副作用，任何失败都不得向上冒泡成
    // “本次消息提交失败”。调用方（例如语音消息）会据此按失败路径删除已经由 committed
    // 业务事实接管的媒体 backing，造成消息引用的文件丢失。副作用失败只报告。

    // commit 后更新 UI。
    try {
      params.notifyUI?.(sessionId);
    } catch (error) {
      console.warn('[CommitCanonicalUserMessage] 提交后 UI 通知失败', error);
    }

    return result;
  } finally {
    await release(committed);
  }
}
