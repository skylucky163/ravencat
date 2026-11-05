/**
 * @fileoverview executeUserReplyTurn —— canonical user_reply 的 run 执行入口（Phase 5A）。
 *
 * Host 在 claim 成功并注册内存句柄后调用本入口：
 *   typing 指示（开始/结束）
 *   → 按 run 行固定区间组装逐条输入
 *   → processAIReply + SingleTransactionTurnCommit（T3）
 * fence 失败或取消均由提交策略/AbortSignal 安静收尾；失败 revoke 由 Host 负责。
 */

import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import type { ConversationTurnRun } from '../domain/ConversationTurn';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { buildChatTurnAIInput } from './BuildChatTurnAIInput';
import { processAIReply } from './ProcessAIReply';
import { createSingleTransactionTurnCommit } from './SingleTransactionTurnCommit';
import { ChatTurnPresentation } from './ChatTurnPresentationRuntime';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  ProcessAIReplyCallbacks,
} from './ChatReplyTypes';

export interface ExecuteUserReplyTurnParams {
  run: ConversationTurnRun;
  aiConfig: AIReplyConfig;
  signal?: AbortSignal;
  repository?: IMessageRepository;
  callbacks?: ProcessAIReplyCallbacks;
  correlationId?: string;
  deliveryTiming?: AIReplyRuntimeContext['deliveryTiming'];
  executionDeadlineAt?: number;
}

/**
 * run 执行结果：
 * - committed：T3 已提交；
 * - fence_failed：提交 fence 失败，本 run 已失去所有权（不重试、不 revoke）；
 * - empty_reply：run 仍 active 但无任何提交（含无输入、空条目、错误气泡分支），
 *   由 Host revoke('failed', 'empty_reply') 收尾，不得留 active 悬挂。
 */
export type UserReplyTurnOutcome = 'committed' | 'fence_failed' | 'empty_reply';

export async function executeUserReplyTurn(
  params: ExecuteUserReplyTurnParams
): Promise<UserReplyTurnOutcome> {
  const { run, aiConfig } = params;
  const repository = params.repository ?? getChatMessageRuntimeDependencies().messages;
  const correlationId = params.correlationId || run.runId;
  const presentation = new ChatTurnPresentation(run, aiConfig.agentId, aiConfig.id, {
    signal: params.signal, executionDeadlineAt: params.executionDeadlineAt,
  });
  const persistence = createSingleTransactionTurnCommit(run, aiConfig.id, presentation);
  await presentation.start();
  persistence.timelineSink = presentation.sink;
  persistence.recordToolExecutionStarted = () => presentation.recordToolStart();
  persistence.observeRunEvent = event => presentation.observeRunEvent(event);
  let replyFailure: string | undefined;

  try {
    const input = await buildChatTurnAIInput({
      repository,
      sessionId: run.sessionId,
      replyCursorAtClaim: run.inputCursorAtClaim ?? run.replyCursorAtClaim,
      inputHighWatermark: run.inputHighWatermark,
      assistantId: aiConfig.id,
      agentId: aiConfig.agentId,
      isRegeneration: run.kind === 'regenerate',
      signal: params.signal,
    });

    const lastUserMessage = input.userMessages[input.userMessages.length - 1];
    if (!lastUserMessage) {
      // 区间内没有用户消息（例如已被其它路径消费）：没有可回复输入，安静结束。
      return 'empty_reply';
    }

    await processAIReply(
      run.sessionId,
      input.displayText,
      aiConfig,
      lastUserMessage.id,
      repository,
      {
        ...params.callbacks,
        onReplyFailed: payload => {
          replyFailure = payload.error;
          params.callbacks?.onReplyFailed?.(payload);
        },
      },
      {
        correlationId,
        triggerSource: 'chat',
        triggerReason: 'user_message',
        relatedEntityType: 'message',
        relatedEntityId: String(lastUserMessage.id),
        batchedUserMessageIds: input.userMessages.map((message) => message.id),
        batchedUserMessageCount: input.userMessages.length,
        ...(run.kind === 'regenerate' ? {
          historyUpperBound: { messageId: run.inputHighWatermark, createdAt: lastUserMessage.createdAt },
          isRegeneration: true,
        } : {}),
        turnInputMessages: input.turnInputMessages,
        replyRunId: run.runId,
        abortSignal: params.signal,
        executionDeadlineAt: params.executionDeadlineAt,
        deliveryTiming: params.deliveryTiming,
      },
      persistence,
    );

    const outcome = persistence.turnCommitOutcome?.() ?? null;
    if (outcome === 'committed' || outcome === 'fence_failed') {
      return outcome;
    }
    // 错误气泡是展示结果；T4 仍须保留真实失败原因，不能统一记作空回复。
    if (replyFailure) throw new Error(replyFailure);
    // empty_items 或无提交（错误气泡/拉黑等分支）：run 仍 active，交给 Host revoke。
    return 'empty_reply';
  } finally {
    await presentation.finish();
  }
}
