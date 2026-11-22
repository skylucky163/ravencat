/** 统一处理 assistant 分段提交后的投影回执与 AI 消息交付事件。 */
import {
  buildSessionPreviewTextFromMessage,
} from '../../messages/domain';
import {
  emitAIMessageReceived,
  resolveAIMessageDeliveryKind,
} from '../delivery/AIMessageEvents';
import type {
  AIMessageDeliveryKind,
  AIMessageDeliveryIdentity,
  AIMessageReceivedPayload,
} from '../delivery/AIMessageEvents';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  ProcessAIReplyCallbacks,
} from './ChatReplyTypes';
import type { ChatTurnDisplaySnapshot } from '../domain/ChatTurnPresentation';

interface DeliverCommittedAssistantSegmentParams {
  sessionId: string;
  text: string;
  metadataJson?: string | null;
  messageId: number;
  clientMessageId?: string;
  logicalMessageId: string | null;
  segmentIndex: number;
  segmentTotal: number;
  aiConfig?: AIReplyConfig;
  runtimeContext: AIReplyRuntimeContext;
  callbacks: ProcessAIReplyCallbacks;
}

export async function deliverCommittedAssistantSegment({
  sessionId,
  text,
  metadataJson,
  messageId,
  clientMessageId,
  logicalMessageId,
  segmentIndex,
  segmentTotal,
  aiConfig,
  runtimeContext,
  callbacks,
}: DeliverCommittedAssistantSegmentParams): Promise<void> {
  const deliveryText = buildSessionPreviewTextFromMessage({
    text,
    metadataJson,
  });
  try {
    await callbacks.onReplySegment?.({
      status: 'segment',
      sessionId,
      correlationId: runtimeContext.correlationId || runtimeContext.replyRunId,
      text: deliveryText,
      previewText: deliveryText,
      logicalMessageId,
      messageId,
      clientMessageId,
      segmentIndex,
      segmentTotal,
    });
  } catch (error) {
    // 观察者失败不撤销已提交正文，用户交付继续由 Host 协调器负责。
    console.warn('[CommittedAssistantSegmentDelivery] 回复观察者失败，继续交付：', error);
  }

  await emitAssistantSegment({
    sessionId, deliveryText, aiConfig, runtimeContext, callbacks,
    identity: { committedMessageId: messageId, clientMessageId,
      arrivalAlreadyScheduled: runtimeContext.arrivalAlreadyScheduled },
    logicalMessageId, segmentIndex, segmentTotal,
  });
}

/** 正文闭合且展示版本已提交后交付；不提前生成正式消息或触发 canonical 投影回调。 */
export async function deliverAssistantDisplaySegment(params: {
  sessionId: string;
  snapshot: ChatTurnDisplaySnapshot;
  aiConfig?: AIReplyConfig;
  runtimeContext: AIReplyRuntimeContext;
  callbacks: ProcessAIReplyCallbacks;
}): Promise<void> {
  const { sessionId, snapshot, aiConfig, runtimeContext, callbacks } = params;
  const deliveryText = snapshot.text.trim();
  await emitAssistantSegment({
    sessionId, deliveryText, aiConfig, runtimeContext, callbacks,
    identity: { clientMessageId: snapshot.clientMessageId, arrivalAlreadyScheduled: true, turnRunId: snapshot.runId },
    logicalMessageId: null, segmentIndex: snapshot.segmentIndex ?? 0,
  });
}

async function emitAssistantSegment({
  sessionId, deliveryText, aiConfig, runtimeContext, callbacks, identity,
  logicalMessageId, segmentIndex, segmentTotal,
}: {
  sessionId: string;
  deliveryText: string;
  aiConfig?: AIReplyConfig;
  runtimeContext: AIReplyRuntimeContext;
  callbacks: ProcessAIReplyCallbacks;
  identity: AIMessageDeliveryIdentity;
  logicalMessageId: string | null;
  segmentIndex: number;
  segmentTotal?: number;
}): Promise<void> {
  // 特殊消息正文由 renderer 从 metadata 读取；系统交付始终沿用 Chat 统一预览契约。
  if (
    !aiConfig?.id
    || !aiConfig.name
    || !deliveryText
    || runtimeContext.suppressAIMessageReceivedEvent
  ) {
    return;
  }

  const deliveryPayload: AIMessageReceivedPayload = {
    turnRunId: runtimeContext.arrivalAlreadyScheduled ? runtimeContext.replyRunId : undefined,
    ...identity,
    aiId: aiConfig.id,
    agentId: aiConfig.agentId || null,
    aiName: aiConfig.name,
    aiAvatar: aiConfig.avatar || null,
    sessionId,
    message: deliveryText,
    logicalMessageId,
    segmentIndex,
    segmentTotal,
    deliveryKind: resolveDeliveryKind(runtimeContext),
    triggerSource: runtimeContext.deliveryTriggerSource
      ?? runtimeContext.triggerSource
      ?? 'chat',
    relatedEntityType: runtimeContext.relatedEntityType || null,
    relatedEntityId: runtimeContext.relatedEntityId || null,
    ...(runtimeContext.notificationScope
      ? { notificationScope: runtimeContext.notificationScope }
      : {}),
    conversationKind: runtimeContext.groupChat ? 'group' : 'direct',
    groupId: runtimeContext.groupChat?.groupId || null,
    groupName: runtimeContext.groupChat?.groupName || null,
    requestCorrelationId: runtimeContext.correlationId,
  };
  const deliveryReceipt = await emitAIMessageReceived(deliveryPayload);
  await callbacks.onAIMessageDelivered?.({
    message: deliveryPayload,
    receipt: deliveryReceipt,
  });
}

function resolveDeliveryKind(
  runtimeContext: AIReplyRuntimeContext,
): AIMessageDeliveryKind {
  return runtimeContext.deliveryKind
    || resolveAIMessageDeliveryKind(
      runtimeContext.deliveryTriggerSource ?? runtimeContext.triggerSource,
    );
}
