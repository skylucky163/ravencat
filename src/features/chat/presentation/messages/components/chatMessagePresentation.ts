/** 定义不支持多气泡的主题如何合并普通文字分段。 */

import type { ChatMessage } from '@features/chat/messages/domain/ChatMessage';
import { parseMessageMetadata } from '@features/chat/messages/domain';
import { readChatCodeBlock } from '../../../messages/domain/ChatCodeBlock';
import type { ChatInteractionProfile } from '@shared/theme';

/** logicalMessageId 归属模型轮次；语音、表情等独立输出不属于文字分段。 */
function isAssistantTextMessage(message: ChatMessage): boolean {
  const metadata = parseMessageMetadata(message);
  return !message.isMe && message.senderType === 'assistant'
    && !metadata?.type && (!metadata?.kind || metadata.kind === 'reply')
    && !readChatCodeBlock(message.text);
}

export function shouldCollapseAssistantSegment(
  message: ChatMessage,
  interactionProfile: ChatInteractionProfile
): boolean {
  return Boolean(
    !interactionProfile.enableAssistantMessageSegmentation &&
    isAssistantTextMessage(message) &&
    message.logicalMessageId
  );
}

export function collapseAssistantSegmentsForPresentation(
  messages: ChatMessage[],
  interactionProfile: ChatInteractionProfile
): ChatMessage[] {
  if (interactionProfile.enableAssistantMessageSegmentation) {
    return messages;
  }

  // 代码前后的解释文字属于不同展示区间，不能跨卡片合并到较早的位置。
  let boundary = 0;
  const groupKeys = messages.map(message => {
    if (message.senderType === 'assistant' && readChatCodeBlock(message.text)) boundary++;
    return shouldCollapseAssistantSegment(message, interactionProfile)
      ? `${boundary}:${getAssistantPresentationGroupKey(message)}` : null;
  });
  const segmentGroups = new Map<string, ChatMessage[]>();
  for (const [index, message] of messages.entries()) {
    const groupKey = groupKeys[index];
    if (!groupKey) continue;
    const group = segmentGroups.get(groupKey);
    if (group) {
      group.push(message);
    } else {
      segmentGroups.set(groupKey, [message]);
    }
  }

  if (segmentGroups.size === 0) {
    return messages;
  }

  const renderedGroupKeys = new Set<string>();
  const collapsedMessages: ChatMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const groupKey = groupKeys[index];
    if (!groupKey) {
      collapsedMessages.push(message);
      continue;
    }

    if (renderedGroupKeys.has(groupKey)) {
      continue;
    }

    renderedGroupKeys.add(groupKey);
    const group = segmentGroups.get(groupKey)!;
    collapsedMessages.push(mergeAssistantSegmentsForPresentation(group));
  }

  return collapsedMessages;
}

export function getAssistantPresentationGroupKey(message: ChatMessage): string {
  const metadata = parseMessageMetadata(message);
  const logicalMessageId = message.logicalMessageId as string;
  const replyStepId = String(metadata?.replyStepId || '').trim();

  return replyStepId
    ? `${replyStepId}:${logicalMessageId}`
    : logicalMessageId;
}

function compareMessageSegments(left: ChatMessage, right: ChatMessage): number {
  const leftSegmentIndex = left.segmentIndex ?? 0;
  const rightSegmentIndex = right.segmentIndex ?? 0;
  if (leftSegmentIndex !== rightSegmentIndex) {
    return leftSegmentIndex - rightSegmentIndex;
  }

  return left.id - right.id;
}

function resolveAggregateStatus(segments: ChatMessage[]): ChatMessage['status'] {
  if (segments.some((segment) => segment.status === 'streaming')) {
    return 'streaming';
  }

  if (segments.some((segment) => segment.status === 'pending')) {
    return 'pending';
  }

  if (segments.some((segment) => segment.status === 'failed')) {
    return 'failed';
  }

  return 'sent';
}

function mergeAssistantSegmentsForPresentation(segments: ChatMessage[]): ChatMessage {
  const orderedSegments = segments.slice().sort(compareMessageSegments);
  const firstSegment = orderedSegments[0];
  const lastSegment = orderedSegments[orderedSegments.length - 1];
  const joinedText = orderedSegments
    .map((segment) => String(segment.text || '').trim())
    .filter(Boolean)
    .join('\n\n');

  return {
    ...firstSegment,
    text: joinedText || firstSegment.text,
    updatedAt: lastSegment.updatedAt || firstSegment.updatedAt,
    status: resolveAggregateStatus(orderedSegments),
    segmentIndex: 0,
    segmentTotal: 1,
    tokensUsed: orderedSegments.reduce((sum, segment) => sum + (segment.tokensUsed || 0), 0),
    promptTokens: orderedSegments.reduce((sum, segment) => sum + (segment.promptTokens || 0), 0),
    completionTokens: orderedSegments.reduce((sum, segment) => sum + (segment.completionTokens || 0), 0),
  };
}
