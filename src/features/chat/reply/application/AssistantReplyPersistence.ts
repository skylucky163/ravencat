/** 负责规范化并持久化已完成的 AI 回复，协调推理文本、分段交付及最终回调。 */
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import { persistChatMessage } from '../../messages/application/MessagePersistence';
import { deliverAssistantMessage } from './AssistantMessageDelivery';
import {
  assertChatReplyNotAborted,
  isChatReplyActive,
} from './ChatReplyAbort';
import { buildMessageMetadata } from './ChatReplyMetadata';
import { buildLogicalMessageId, formatMessageTime } from './ChatReplyUtils';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  AIResponse,
  ProcessAIReplyCallbacks,
} from './ChatReplyTypes';
import type { AIReplyPolicy } from './ReplyPolicy';
import { segmentAssistantReplyText } from './AssistantReplySegmentation';
import { deliverCommittedAssistantSegment } from './CommittedAssistantSegmentDelivery';
import type { ToolPackageExposureChange } from '@shared/aiTools';

export interface NormalizedAssistantResponse {
  text: string;
  segments: string[];
}

export interface PersistCompletedAssistantReplyParams {
  sessionId: string;
  response: AIResponse;
  /** 本次运行的开关操作按执行顺序交给正式回复提交 owner。 */
  toolPackageChanges?: readonly ToolPackageExposureChange[];
  repository: IMessageRepository;
  callbacks?: ProcessAIReplyCallbacks;
  aiConfig?: AIReplyConfig;
  runtimeContext?: AIReplyRuntimeContext;
  policy: Pick<AIReplyPolicy, 'bubbleDeliveryMode'>;
}

export async function persistCompletedAssistantReply({
  sessionId,
  response,
  repository,
  callbacks = {},
  aiConfig,
  runtimeContext = {},
  policy,
}: PersistCompletedAssistantReplyParams): Promise<void> {
  assertChatReplyNotAborted(runtimeContext);

  const now = new Date();
  const timeStr = formatMessageTime(now);
  const createdAt = now.toISOString();
  const normalizedResponse = normalizeAssistantResponseText(
    response.text,
    policy,
  );
  const normalizedText = normalizedResponse.text;
  const hasReasoning = Boolean(response.reasoningText?.trim());
  const willSegment = normalizedResponse.segments.length > 1;
  const logicalMessageId = hasReasoning || willSegment
    ? buildLogicalMessageId()
    : null;

  const reasoningText = response.reasoningText?.trim();
  if (reasoningText) {
    await persistChatMessage({
      repository,
      message: {
        sessionId,
        text: reasoningText,
        isMe: false,
        senderType: 'reasoning',
        agentId: aiConfig?.agentId || null,
        apiMessageId: null,
        time: timeStr,
        createdAt,
        updatedAt: createdAt,
        replyToId: null,
        replyToText: null,
        status: 'sent',
        tokensUsed: 0,
        promptTokens: 0,
        completionTokens: 0,
        metadataJson: JSON.stringify(buildMessageMetadata(aiConfig, runtimeContext, { kind: 'reasoning' })),
        logicalMessageId,
      },
      previewText: null,
      notifyUI: callbacks.notifyUI,
    });

    assertChatReplyNotAborted(runtimeContext);
  }

  if (!normalizedText) {
    callbacks.onReplyCommitted?.();
    return;
  }

  const deliveryResult = await deliverAssistantMessage({
    repository,
    message: {
      sessionId,
      text: normalizedText,
      isMe: false,
      senderType: 'assistant',
      agentId: aiConfig?.agentId || null,
      apiMessageId: response.messageId || null,
      time: timeStr,
      createdAt,
      updatedAt: createdAt,
      replyToId: null,
      replyToText: null,
      status: 'sent',
      tokensUsed: response.totalTokens || 0,
      promptTokens: response.promptTokens || 0,
      completionTokens: response.completionTokens || 0,
      metadataJson: JSON.stringify(buildMessageMetadata(aiConfig, runtimeContext, {
        kind: 'reply',
        cachedTokens: response.cachedTokens,
      })),
    },
    segments: normalizedResponse.segments,
    notifyUI: callbacks.notifyUI,
    shouldContinue: () => isChatReplyActive(runtimeContext),
    logicalMessageId,
    deliveryTiming: runtimeContext.deliveryTiming,
    onSegmentDelivered: async ({ logicalMessageId: deliveredLogicalMessageId, segmentIndex, segmentTotal, text, message }) => {
      await deliverCommittedAssistantSegment({
        sessionId,
        text,
        metadataJson: message.metadataJson,
        messageId: message.id,
        logicalMessageId: deliveredLogicalMessageId,
        segmentIndex,
        segmentTotal,
        aiConfig,
        runtimeContext,
        callbacks,
      });

      if (segmentIndex === segmentTotal - 1 && (runtimeContext.triggerSource || 'chat') === 'chat') {
        callbacks.onReplyCommitted?.();
      }
    },
  });

  const deliveryCompletion = await deliveryResult.completion;
  assertChatReplyNotAborted(runtimeContext);

  if (!deliveryCompletion.completed || !deliveryResult.firstMessage) {
    return;
  }

  const joinedText = deliveryCompletion.joinedText || normalizedText.trim();
  const firstSegmentMessageId = deliveryCompletion.firstSegmentMessageId ?? deliveryResult.firstMessage.id;
  const lastSegmentMessageId = deliveryCompletion.lastSegmentMessageId
    ?? deliveryCompletion.lastDeliveredMessageId
    ?? deliveryResult.firstMessage.id;

  callbacks.onFinalReply?.({
    status: 'completed',
    sessionId,
    correlationId: runtimeContext.correlationId || runtimeContext.replyRunId,
    text: normalizedText,
    previewText: joinedText,
    joinedText,
    logicalMessageId: deliveryResult.logicalMessageId,
    firstSegmentMessageId,
    lastSegmentMessageId,
    segmentTotal: deliveryResult.segmentTotal,
    segments: deliveryCompletion.segments,
  });
}

/**
 * 模型原文只经过客户端的正文／代码围栏分段，不要求额外消息封套。
 * 不修补未闭合代码，也不在终态改变已经交付的内容边界。
 */
export function normalizeAssistantResponseText(
  text: string,
  policy: Pick<AIReplyPolicy, 'bubbleDeliveryMode'>,
): NormalizedAssistantResponse {
  // 外层缩进和未闭合代码的末尾空白都参与流式边界；终态不能重新解释原文。
  const normalizedText = text.trim().length > 0 ? text : '';
  return {
    text: normalizedText,
    segments: segmentAssistantReplyText(normalizedText, policy.bubbleDeliveryMode),
  };
}
