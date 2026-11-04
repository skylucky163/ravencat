/**
 * @fileoverview 普通回复、重写和日程共用的回合提交策略；媒体输出不提前结束执行。
 *
 * 把 processAIReply 的最终落库替换为单事务 commitTurn：fence + 全量 items +
 * preview + run 终态 + 游标推进。fence 失败 = 安静结束本 run：不落错误气泡、
 * 不重试（用户消息事务已触发新一轮 claim，新输入自然被覆盖）。
 * 工具续轮的中间 assistant 文本（前言）经 persistAssistantPrelude 只收集不单独落库，
 * 并入本轮 items 随同一 T3 事务提交；canonical 路径任何 assistant 文本只经 T3 落库。
 * 图片／表情可由同一 owner 在工具完成后提交并发布，T3 仅绑定其最终顺序。
 * 重写保持整轮原子替换。commit 后再做 UI 通知、逐段回调与领域事件。
 */

import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import { buildSessionPreviewTextFromMessage } from '../../messages/domain';
import type {
  ConversationTurnCommitItem,
  ConversationTurnRun,
} from '../domain/ConversationTurn';
import { assertChatReplyNotAborted, ChatReplyRunCancelledError } from './ChatReplyAbort';
import {
  normalizeAssistantResponseText,
  type PersistCompletedAssistantReplyParams,
} from './AssistantReplyPersistence';
import {
  buildAssistantTurnItems,
  type AssistantTurnCommitOutcome,
  type AssistantTurnCommitPort,
} from './AssistantTurnCommit';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  ProcessAIReplyCallbacks,
} from './ChatReplyTypes';
import { deliverAssistantDisplaySegment, deliverCommittedAssistantSegment } from './CommittedAssistantSegmentDelivery';
import { beginAssistantMessageArrival, finishAssistantMessageArrival } from '../delivery/AssistantMessageArrival';
import { releaseMediaAssetCandidates } from '@features/media';
import { emitChatMessagesReloadRequested, emitChatTurnExecutionChanged } from '../../messages/events/ChatEvents';
import type { ChatTurnPresentation } from './ChatTurnPresentationRuntime';
import { databaseCoordinator } from '@platform/persistence';

export function createSingleTransactionTurnCommit(
  run: ConversationTurnRun,
  assistantId: string,
  presentation?: ChatTurnPresentation,
): AssistantTurnCommitPort {
  let settled = false;
  let outcome: AssistantTurnCommitOutcome | null = null;
  // 工具续轮的中间 assistant 文本（前言）只收集不单独落库，随本轮 items 一起进 T3。
  const preludeItems: ConversationTurnCommitItem[] = [];

  /** 归一化 + 纯转换为本轮待提交条目；不做任何 IO。 */
  function buildTurnItems({
    sessionId,
    response,
    aiConfig,
    runtimeContext = {},
    policy,
  }: PersistCompletedAssistantReplyParams): ConversationTurnCommitItem[] {
    assertChatReplyNotAborted(runtimeContext);

    const normalizedResponse = normalizeAssistantResponseText(
      response.text,
      policy,
    );

    return buildAssistantTurnItems({
      sessionId,
      aiConfig,
      runtimeContext,
      response,
      normalizedText: normalizedResponse.text,
      visibleSegments: normalizedResponse.segments,
    });
  }

  /**
   * canonical commit 的共享收口：items 已由调用方确定顺序，这里只做 T3
   * 提交、结果状态与 assistant-only delivery。tool/reasoning 只能作为展示项
   * 随事务写入，不能进入 preview 或 assistant 回调。
   */
  async function commitItems(
    params: PersistCompletedAssistantReplyParams,
    items: ConversationTurnCommitItem[],
  ): Promise<{
    outcome: AssistantTurnCommitOutcome;
    messages: ChatMessage[];
  }> {
    const {
      sessionId,
      response,
      callbacks = {},
      aiConfig,
      runtimeContext = {},
    } = params;

    if (items.length === 0 || (run.kind === 'regenerate' && !items.some((item) => item.message.senderType === 'assistant'))) {
      settled = true;
      await discardPreparedItems(items);
      outcome = 'empty_items';
      // 保持既有完成信号语义；这里没有任何消息，因此不会触发 assistant
      // segment delivery 或 onFinalReply。
      callbacks.onReplyCommitted?.();
      return { outcome, messages: [] };
    }

    let result;
    try {
      await presentation?.flush();
      result = await getChatMessageRuntimeDependencies().turns.commitTurn(run, items, {
        assistantId, changes: params.toolPackageChanges ?? [],
      }, runtimeContext.executionDeadlineAt === undefined ? undefined : {
        deadlineAt: runtimeContext.executionDeadlineAt, signal: runtimeContext.abortSignal,
      });
    } catch (error) {
      await discardPreparedItems(items);
      throw error;
    }

    // 事务抛错不代表 run 失去错误反馈资格；只有持久裁决返回后才收口。
    // commit 后的展示异常则不能再写错误气泡，避免把成功事实误报成提交失败。
    settled = true;
    if (result.outcome === 'fence_failed') {
      await discardPreparedItems(items);
      outcome = 'fence_failed';
      // fence 失败：零事实落库，安静结束本 run，不重试。
      console.info('[SingleTransactionTurnCommit] commit fence 失败，本 run 放弃提交', {
        sessionId,
        runId: run.runId,
      });
      return { outcome, messages: [] };
    }

    outcome = 'committed';
    emitChatTurnExecutionChanged(sessionId);
    await finalizePreparedItems(items);
    if (run.kind === 'regenerate') {
      try {
        await releaseMediaAssetCandidates(result.mediaAssetCandidates ?? []);
      } catch (error) {
        console.warn('[SingleTransactionTurnCommit] 重写提交后媒体候选清理失败', error);
      }
    }

    const assistantSegments = result.messages.filter(
      (message) => message.senderType === 'assistant'
    );
    const committedOutputIds = new Set(items.flatMap(item => item.committedMessageId === undefined ? [] : [item.committedMessageId]));
    if (presentation?.isClosed()) {
      callbacks.onReplyCommitted?.();
      return { outcome, messages: result.messages };
    }
    if (assistantSegments.length === 0) {
      callbacks.notifyUI?.(sessionId);
      // tool/reasoning-only canonical turn 仍然完成一次 commit；完成信号不等于
      // assistant delivery，不能因没有 assistant segment 而丢失原有回调语义。
      callbacks.onReplyCommitted?.();
      return { outcome, messages: result.messages };
    }

    const tracksArrival = Boolean(aiConfig?.id && aiConfig.name && !runtimeContext.suppressAIMessageReceivedEvent);
    const messageIds = assistantSegments.filter(message => !committedOutputIds.has(message.id)).map((message) => message.id);
    const segmentTotal = assistantSegments.length;
    let deliveryInterrupted = false;
    try {
      if (tracksArrival && messageIds.length > 0) {
        await beginAssistantMessageArrival({
          observer: { sessionId, aiId: aiConfig!.id, aiName: aiConfig!.name },
          messageIds,
        });
      }
      // 先登记原有分段到达投影，再刷新替换后的消息，避免整轮先闪现后重新分段。
      if (run.kind === 'regenerate') emitChatMessagesReloadRequested(sessionId);
      // 完整事实仍一次读回；展示消费者共享已登记的分段到达投影。
      callbacks.notifyUI?.(sessionId);
      for (const [segmentIndex, message] of assistantSegments.entries()) {
        if (!committedOutputIds.has(message.id)) {
          if (presentation && !await presentation.publishSegment(message)) {
            deliveryInterrupted = true;
            break;
          }
          await notifyCommittedSegment({
            message,
            segmentIndex,
            segmentTotal,
            sessionId,
            aiConfig,
            runtimeContext: presentation ? { ...runtimeContext, arrivalAlreadyScheduled: true,
              suppressAIMessageReceivedEvent: runtimeContext.suppressAIMessageReceivedEvent
                || presentation.hasNotifiedSegment(message.clientMessageId!),
            } : runtimeContext,
            callbacks,
          });
        }
        if (segmentIndex === segmentTotal - 1 && (runtimeContext.triggerSource || 'chat') === 'chat') callbacks.onReplyCommitted?.();
      }
    } finally {
      if (tracksArrival && messageIds.length > 0) await finishAssistantMessageArrival(messageIds);
    }

    if (deliveryInterrupted) {
      // T3 已成功，受控宿主仍须结束等待；但未交付尾部不能通过完整回复回调泄漏。
      callbacks.onReplyCommitted?.();
      return { outcome, messages: result.messages };
    }

    const joinedText = assistantSegments
      .map(buildSessionPreviewTextFromMessage)
      .filter(Boolean)
      .join('\n\n');
    const previewText = joinedText
      || [...assistantSegments]
        .reverse()
        .map(buildSessionPreviewTextFromMessage)
        .find(Boolean)
      || response.text.trim();
    callbacks.onFinalReply?.({
      status: 'completed',
      sessionId,
      correlationId: runtimeContext.correlationId || runtimeContext.replyRunId,
      text: joinedText || response.text,
      previewText,
      joinedText,
      logicalMessageId: assistantSegments[0].logicalMessageId || null,
      firstSegmentMessageId: assistantSegments[0].id,
      lastSegmentMessageId: assistantSegments[assistantSegments.length - 1].id,
      segmentTotal,
      segments: assistantSegments.map((message, segmentIndex) => ({
        messageId: message.id,
        segmentIndex,
        text: buildSessionPreviewTextFromMessage(message),
      })),
    });

    return { outcome, messages: result.messages };
  }

  return {
    persistsIntermediates: false,
    configureSegmentDelivery: ({ aiConfig, runtimeContext = {}, callbacks = {} }) => {
      if (!presentation) return;
      presentation.configureSegmentDelivery(snapshot => deliverAssistantDisplaySegment({
        sessionId: run.sessionId, snapshot, aiConfig, runtimeContext, callbacks,
      }));
    },
    decorateCommitRepository: repository => new Proxy(repository, {
      get(target, key) {
        if (key === 'commitMessage') return (input: Parameters<IMessageRepository['commitMessage']>[0]) => databaseCoordinator.transaction(
          { name: 'chat.commit-run-message', feature: 'chat', priority: 'interactive' }, async transaction => {
            if (!await getChatMessageRuntimeDependencies().turns.isRunCurrentInTransaction(transaction, run.runId)) {
              throw new ChatReplyRunCancelledError('superseded');
            }
            presentation?.assertExecutionActive();
            return target.commitMessageInTransaction(transaction, input);
          });
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    readOpenToolPackageIds: () => getChatMessageRuntimeDependencies().turns.listOpenToolPackageIds(run.sessionId, assistantId),

    isCommitEligible: () => !settled,

    turnCommitOutcome: () => outcome,

    async persistAssistantPrelude(params) {
      preludeItems.push(...buildTurnItems(params));
    },

    async commitAgentTimeline(params) {
      return commitItems(params, params.items);
    },

    async commitAgentOutput(params) {
      if (run.kind === 'regenerate') return { outcome: 'deferred', messages: [] };
      const runtimeContext = params.runtimeContext ?? {};
      assertChatReplyNotAborted(runtimeContext);
      await presentation?.flush();
      const result = await getChatMessageRuntimeDependencies().turns.commitOutput(run, params.item, {
        deadlineAt: runtimeContext.executionDeadlineAt, signal: runtimeContext.abortSignal,
      });
      if (result.outcome === 'fence_failed') return { outcome: 'fence_failed', messages: [] };
      const message = result.messages[0];
      // 消息和可见版本已提交；交付观察／原生通知失败不撤销它，也不重放发送。
      try { params.callbacks?.notifyUI?.(run.sessionId); }
      catch (error) { console.warn('[SingleTransactionTurnCommit] 已提交媒体的界面通知失败', { runId: run.runId, messageId: message.id, error }); }
      try {
        await deliverCommittedAssistantSegment({
          sessionId: run.sessionId, text: message.text, metadataJson: message.metadataJson,
          messageId: message.id, clientMessageId: message.clientMessageId!, logicalMessageId: message.logicalMessageId ?? null,
          segmentIndex: 0, segmentTotal: 1, aiConfig: params.aiConfig,
          runtimeContext: { ...runtimeContext, arrivalAlreadyScheduled: Boolean(presentation) }, callbacks: params.callbacks ?? {},
        });
      } catch (error) {
        console.warn('[SingleTransactionTurnCommit] 已提交媒体的交付观察失败', { runId: run.runId, messageId: message.id, error });
      }
      return { outcome: 'committed', messages: result.messages };
    },

    async persistCompletedAssistantReply(params) {
      const items = [...preludeItems, ...buildTurnItems(params)];
      await commitItems(params, items);
    },
  };
}

async function discardPreparedItems(items: ConversationTurnCommitItem[]): Promise<void> {
  await Promise.all(items.map(async (item) => {
    if (!item.discardAfterRollback) return;
    try {
      await item.discardAfterRollback();
    } catch (error) {
      console.warn('[SingleTransactionTurnCommit] 回滚后清理语音 backing 失败', error);
    }
  }));
}

async function finalizePreparedItems(items: ConversationTurnCommitItem[]): Promise<void> {
  await Promise.all(items.map(async (item) => {
    if (!item.finalizeAfterCommit) return;
    try {
      await item.finalizeAfterCommit();
    } catch (error) {
      console.warn('[SingleTransactionTurnCommit] commit 后清理复用 backing 失败', error);
    }
  }));
}

async function notifyCommittedSegment(params: {
  message: ChatMessage;
  segmentIndex: number;
  segmentTotal: number;
  sessionId: string;
  aiConfig?: AIReplyConfig;
  runtimeContext: AIReplyRuntimeContext;
  callbacks: ProcessAIReplyCallbacks;
}): Promise<void> {
  const {
    message,
    segmentIndex,
    segmentTotal,
    sessionId,
    aiConfig,
    runtimeContext,
    callbacks,
  } = params;
  const text = message.text;

  await deliverCommittedAssistantSegment({
    sessionId,
    text,
    metadataJson: message.metadataJson,
    messageId: message.id,
    clientMessageId: message.clientMessageId ?? undefined,
    logicalMessageId: message.logicalMessageId || null,
    segmentIndex,
    segmentTotal,
    aiConfig,
    runtimeContext,
    callbacks,
  });
}
