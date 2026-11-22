/** Chat 拥有的主动回复命令：统一执行、落库、UI 刷新与逐段系统交付。 */

import type {
  AIMessageDeliveryReceipt,
  AIMessageReceivedPayload,
} from '../delivery/AIMessageEvents';
import { emitChatMessagesUpdated, emitChatTypingStatusChanged } from '../../messages/events/ChatEvents';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { createLegacySegmentedReplyPersistence } from './AssistantTurnCommit';
import { processAIReply } from './ProcessAIReply';
import type {
  AIReplyConfig,
  AIReplyFinalPayload,
  AIReplyRuntimeContext,
  ChatContextMessage,
  ProcessAIReplyCallbacks,
} from './ChatReplyTypes';
import type { PromptPackBlock } from '@shared/prompt';

export interface RequestProactiveChatReplyParams {
  sessionId: string;
  currentInput: string;
  aiConfig: AIReplyConfig;
  triggerSource: string;
  triggerReason: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  capabilities?: string[];
  promptBlocks?: PromptPackBlock[];
  batchModelInput?: ChatContextMessage['content'];
  correlationId?: string;
  /** 交付事件使用的触发原因；缺省复用 triggerSource。 */
  deliveryTriggerSource?: string | null;
  /** 原生通知分域；不写入 Chat 消息 metadata。 */
  notificationScope?: string | null;
  abortSignal?: AbortSignal;
  executionDeadlineAt?: number;
}

export interface ProactiveChatReplySegment {
  messageId: number;
  text: string;
  logicalMessageId: string | null;
  segmentIndex: number;
  segmentTotal: number;
}

interface ProactiveChatReplyDelivery {
  message: AIMessageReceivedPayload;
  receipt: AIMessageDeliveryReceipt;
}

export interface RequestProactiveChatReplyResult {
  /** 已提交 assistant 分段按 segmentIndex 联接后的正文。 */
  message: string;
  /** 首个 assistant 分段的数据库 ID。 */
  messageId: number;
  /** 按 assistant 分段顺序排列的全部数据库 ID。 */
  messageIds: number[];
  /** 已提交 assistant 分段，按 segmentIndex 排序。 */
  segments: ProactiveChatReplySegment[];
  /** 与 segments 同序的一次性交付回执。 */
  deliveryReceipts: AIMessageDeliveryReceipt[];
}

export async function requestProactiveChatReply(
  params: RequestProactiveChatReplyParams,
): Promise<RequestProactiveChatReplyResult> {
  return (await executeProactiveChatReply(params, false))!;
}

/** 应用通知给 AI 一次发言机会，静默时不产生用户可见回复。 */
export function requestOptionalProactiveChatReply(params: RequestProactiveChatReplyParams) {
  return executeProactiveChatReply(params, true);
}

async function executeProactiveChatReply(
  params: RequestProactiveChatReplyParams,
  allowSilentReply: boolean,
): Promise<RequestProactiveChatReplyResult | null> {
  const repository = getChatMessageRuntimeDependencies().messages;
  const correlationId = params.correlationId || undefined;
  const runtimeContext: AIReplyRuntimeContext = {
    inputSource: 'application',
    allowSilentReply,
    abortSignal: params.abortSignal,
    executionDeadlineAt: params.executionDeadlineAt,
    correlationId,
    triggerSource: params.triggerSource,
    triggerReason: params.triggerReason,
    relatedEntityType: params.relatedEntityType ?? null,
    relatedEntityId: params.relatedEntityId ?? null,
    capabilities: params.capabilities,
    batchModelInput: params.batchModelInput,
    forceAppendUserText: true,
    promptBlocks: params.promptBlocks,
    deliveryTiming: 'immediate',
    deliveryTriggerSource: params.deliveryTriggerSource ?? params.triggerSource,
    notificationScope: params.notificationScope ?? null,
    deliveryKind: 'proactive',
  };

  const committedSegments = new Map<number, ProactiveChatReplySegment>();
  const deliveries: ProactiveChatReplyDelivery[] = [];
  let finalReply: AIReplyFinalPayload | null = null;
  let silent = false;

  const callbacks: ProcessAIReplyCallbacks = {
    onSilentReply: () => { silent = true; },
    notifyUI: emitChatMessagesUpdated,
    onReplySegment: ({
      text,
      messageId,
      logicalMessageId,
      segmentIndex,
      segmentTotal,
    }) => {
      committedSegments.set(messageId, {
        messageId,
        text,
        logicalMessageId,
        segmentIndex,
        segmentTotal,
      });
    },
    onFinalReply: (payload) => {
      finalReply = payload;
    },
    onAIMessageDelivered: ({ message, receipt }) => {
      deliveries.push({ message, receipt });
    },
  };

  emitChatTypingStatusChanged(params.sessionId, true, correlationId);
  try {
    await processAIReply(
      params.sessionId,
      params.currentInput,
      params.aiConfig,
      0,
      repository,
      callbacks,
      runtimeContext,
      createLegacySegmentedReplyPersistence(),
    );
  } finally {
    emitChatTypingStatusChanged(params.sessionId, false, correlationId);
  }

  if (silent) return null;
  const segments = [...committedSegments.values()].sort(
    (left, right) => left.segmentIndex - right.segmentIndex,
  );
  if (segments.length === 0) {
    // processAIReply 自己负责持久化模型错误气泡；命令只把“没有 assistant 事实”交给调用方。
    throw new Error('主动消息已经生成但没有可审计的落库消息 ID');
  }

  const joinedMessage = (finalReply?.joinedText || segments.map((segment) => segment.text).join('\n\n'))
    .trim();
  const firstSegmentMessageId = finalReply?.firstSegmentMessageId || segments[0]!.messageId;
  const committedMessageIds = segments.map((segment) => segment.messageId);
  const deliveryReceipts = deliveries
    .slice()
    .sort((left, right) => (
      (left.message.segmentIndex ?? 0) - (right.message.segmentIndex ?? 0)
    ))
    .map(({ receipt }) => receipt);

  return {
    message: joinedMessage,
    messageId: firstSegmentMessageId,
    messageIds: committedMessageIds,
    segments,
    deliveryReceipts,
  };
}
