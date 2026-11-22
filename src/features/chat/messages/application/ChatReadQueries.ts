/** Chat 对外提供的窄只读能力；返回稳定 DTO，不泄漏消息仓储。 */

import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { getAssistantMessageArrivalSnapshot } from '../../reply/delivery/AssistantMessageArrival';
import { buildSessionPreviewTextFromMessage } from '../domain/chatMessageMetadata';

/** 跨 surface 同步使用消息身份，不把回复预览当成第二份聊天记录。 */
export interface ChatPreviewMessage {
  messageId: number;
  clientMessageId: string | null;
  role: 'user' | 'assistant';
  text: string;
}

/** 通知发布跨过原生等待后，按持久阅读事实收口期间发生的阅读。 */
export function isChatAssistantMessageRead(identity: { messageId?: number; clientMessageId?: string }): Promise<boolean> {
  return getChatMessageRuntimeDependencies().messages.isAssistantMessageRead(identity);
}

export async function listRecentChatPreviewMessages(params: { sessionId: string; limit: number }): Promise<ChatPreviewMessage[]> {
  const messages = await getChatMessageRuntimeDependencies().messages.getRecentPreviewMessages(
    params.sessionId, params.limit, getAssistantMessageArrivalSnapshot().pendingMessageIds,
  );
  return messages.map((message) => ({
    messageId: message.id,
    clientMessageId: message.clientMessageId ?? null,
    role: message.isMe ? 'user' : 'assistant',
    text: buildSessionPreviewTextFromMessage(message),
  }));
}

/** 某次 Agent run 在 Chat durable timeline 中第一条可定位条目。 */
export interface ChatTimelineAnchor {
  sessionId: string;
  messageId: number;
  runId: string;
}

/** RavenCat 等后台决策只需要的近期对话条目。 */
export interface ChatRecentTranscriptEntry {
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
}

export interface ListRecentChatTranscriptParams {
  sessionId: string;
}

export interface FindCommittedAssistantMessageIdByRelatedSourceParams {
  relatedEntityType: string;
  relatedEntityId: string;
}

export interface FindFirstVisibleTimelineMessageByRunIdParams {
  runId: string;
}

export interface FindFirstVisibleTimelineAnchorsByRunIdsParams {
  runIds: string[];
}

const MAX_RECENT_CHAT_TRANSCRIPT = 10;

export async function listRecentChatTranscript(
  params: ListRecentChatTranscriptParams,
): Promise<ChatRecentTranscriptEntry[]> {
  const page = await getChatMessageRuntimeDependencies().messages.getMessages(
    params.sessionId,
    {
      // 先按仓储既有的 DESC 分页契约取最近 N 条，再在内存中恢复旧到新的 prompt 顺序。
      limit: MAX_RECENT_CHAT_TRANSCRIPT,
      order: 'DESC',
    },
  );

  return page.messages
    .slice()
    .reverse()
    .map((message) => ({
      role: message.senderType === 'system'
        ? 'system'
        : message.isMe
          ? 'user'
          : 'assistant',
      text: message.text,
      createdAt: message.createdAt,
    }));
}

export async function findCommittedAssistantMessageIdByRelatedSource(
  params: FindCommittedAssistantMessageIdByRelatedSourceParams,
): Promise<number | null> {
  return getChatMessageRuntimeDependencies().messages.findSentAssistantMessageIdByRelatedEntity(
    params.relatedEntityType,
    params.relatedEntityId,
  );
}

export async function findFirstVisibleTimelineMessageByRunId(
  params: FindFirstVisibleTimelineMessageByRunIdParams,
): Promise<ChatTimelineAnchor | null> {
  return getChatMessageRuntimeDependencies().messages.findFirstVisibleTimelineMessageByRunId(
    params.runId,
  );
}

export async function findFirstVisibleTimelineAnchorsByRunIds(
  params: FindFirstVisibleTimelineAnchorsByRunIdsParams,
): Promise<ChatTimelineAnchor[]> {
  return getChatMessageRuntimeDependencies().messages.findFirstVisibleTimelineAnchorsByRunIds(
    params.runIds,
  );
}
