/** 分享只展开已选择的事实快照，发送仍交给单聊／群聊原有的用户消息 owner。 */
import { getAssistantDisplayName } from '@features/assistants';
import { databaseCoordinator } from '@platform/persistence';
import { getChatDetailAvailableAssistants, getChatDetailCurrentUser } from '../../conversation/application/ChatPresentation';
import { resolveCanonicalConversation } from '../../conversation/application/ResolveCanonicalConversation';
import { getActiveChatCall, isChatSendBlockedByCall } from '../../conversation/application/ChatCallGateway';
import { getGroupChat, listGroupChats } from '../../group/application/GroupChatManagement';
import { sendGroupUserMessage } from '../../group/application/GroupUserMessaging';
import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { sendUserMessage, type AIAssistantConfig } from './SendUserMessage';
import { canSelectChatMessage, getChatSelectionKey, MAX_CHAT_SELECTION_UNITS } from '../domain/ChatMessageSelection';
import { sortChatTimelineMessages } from '../domain/ChatTimelineOrdering';
import { buildGroupMentionModelText, buildReplyQuoteModelText, getMessageAttachments, getMessageSharedRecord, getMessageSharedMoment, getMessageSticker, getMessageVoice, isToolStatusMessageMetadata, parseMessageMetadata } from '../domain/chatMessageMetadata';
import type { SharedChatRecord, SharedChatRecordEntry } from '../domain/SharedChatRecord';
import type { ChatMessage } from '../domain/ChatMessage';
import { sharedContentInput, type SharedContent } from '../domain/SharedContent';


export type ChatShareTarget = { kind: 'direct'; id: string; name: string; aiConfig: AIAssistantConfig }
  | { kind: 'group'; id: string; name: string };

export async function listChatShareTargets(): Promise<ChatShareTarget[]> {
  const [assistants, groups] = await Promise.all([getChatDetailAvailableAssistants(), listGroupChats()]);
  return [
    ...assistants.filter((assistant) => !assistant.isBlocked).map((assistant): ChatShareTarget => ({
      kind: 'direct', id: assistant.id, name: getAssistantDisplayName(assistant), aiConfig: assistant,
    })),
    ...groups.map((group): ChatShareTarget => ({ kind: 'group', id: group.id, name: group.name })),
  ];
}

export async function createChatShareSnapshot(source: { sessionId: string; name: string; assistantId?: string }, anchorMessageIds: readonly number[]): Promise<SharedChatRecord> {
  if (!anchorMessageIds.length || anchorMessageIds.length > MAX_CHAT_SELECTION_UNITS) throw new Error(`请选择 1 至 ${MAX_CHAT_SELECTION_UNITS} 条消息`);
  const [assistants, user] = await Promise.all([getChatDetailAvailableAssistants(), getChatDetailCurrentUser()]);
  const directory = new Map(assistants.map((assistant) => [assistant.agentId, assistant]));
  const publicMembers = assistants.map((assistant) => ({ aiAssistantId: assistant.id, name: assistant.name }));
  const sourceAssistant = assistants.find((assistant) => assistant.id === source.assistantId);
  const repository = getChatMessageRuntimeDependencies().messages;
  const { messages, count } = await databaseCoordinator.transaction(
    { name: 'chat.share-snapshot', feature: 'chat', priority: 'interactive' }, async (transaction) => {
      const keys = new Set<string>();
      const rows = new Map<number, ChatMessage>();
      for (const id of anchorMessageIds) {
        const anchor = await repository.getMessageByIdInTransaction(transaction, id);
        if (!anchor || anchor.sessionId !== source.sessionId || !canSelectChatMessage(anchor)) throw new Error('所选消息已变化，请重新选择');
        const key = getChatSelectionKey(anchor);
        if (keys.has(key)) continue;
        keys.add(key);
        for (const message of await repository.getMessagesInSelectionUnitInTransaction(transaction, source.sessionId, key)) rows.set(message.id, message);
      }
      return { messages: sortChatTimelineMessages([...rows.values()]), count: keys.size };
    },
  );
  const entries: SharedChatRecordEntry[] = [];
  for (const message of messages) {
    if (message.status !== 'sent' || message.deliveryStatus === 'cancelled' || message.senderType === 'reasoning') continue;
    const metadata = parseMessageMetadata(message);
    const shared = getMessageSharedRecord(message);
    if (shared) {
      // 再次分享保留原作者，避免把整份历史误标为转发者本人说的话。
      if (message.text.trim()) entries.push({ author: { kind: 'user', name: metadata?.groupChat?.actorName ?? user.name, agentId: null }, createdAt: message.createdAt, kind: 'speech', text: message.text,
        modelText: buildGroupMentionModelText(message.text, message, publicMembers), attachments: [], sticker: null });
      entries.push(...shared.entries);
      continue;
    }
    const raw = metadata as (typeof metadata & { actorAgentId?: string; actorName?: string }) | null;
    const agentId = message.senderType === 'user' ? null : message.agentId ?? raw?.actorAgentId ?? sourceAssistant?.agentId ?? null;
    const author = message.senderType === 'user'
      ? { kind: 'user' as const, name: metadata?.groupChat?.actorName ?? user.name, agentId: null }
      : { kind: 'assistant' as const, name: raw?.actorName ?? (agentId ? directory.get(agentId)?.name : undefined) ?? 'AI', agentId };
    const isTool = metadata?.type === 'toolStatus' || message.senderType === 'tool';
    const toolStatus = isToolStatusMessageMetadata(metadata) ? metadata : null;
    // 只转发可见工具状态，不泄露原始工具参数、返回值与私有思考。
    if (isTool && !toolStatus) continue;
    const text = isTool ? toolStatus!.displayText : `${message.replyToText ? `[引用：${message.replyToText}]\n` : ''}${getMessageVoice(message) ? '[语音转写]\n' : ''}${message.text}`;
    const modelText = isTool ? toolStatus!.displayText : [
      buildReplyQuoteModelText(message),
      `${getMessageVoice(message) ? '[语音转写]\n' : ''}${buildGroupMentionModelText(message.text, message, publicMembers)}`,
    ].filter(Boolean).join('\n');
    const attachments = getMessageAttachments(message).map((attachment) => ({ ...attachment, id: `share:${message.id}:${attachment.id}` }));
    const sticker = getMessageSticker(message);
    const moment = getMessageSharedMoment(message);
    if (text.trim() || attachments.length || sticker || moment) entries.push({ author, createdAt: message.createdAt, kind: isTool ? 'tool_status' : 'speech', text, modelText, attachments, sticker, ...(moment ? { moment } : {}) });
  }
  if (!entries.length) throw new Error('所选消息没有可分享的正文');
  // 与来源对象脱离；预览与发送消费同一份快照。
  return JSON.parse(JSON.stringify({ schemaVersion: 1, sourceSessionId: source.sessionId, sourceName: source.name, selectionCount: count,
    entries: entries.map((entry, index) => ({ ...entry, attachments: entry.attachments.map((attachment) => ({ ...attachment, id: `share:${index}:${attachment.id}` })) })),
  })) as SharedChatRecord;
}

export async function shareChatContent(params: { target: ChatShareTarget; content: SharedContent; comment: string; clientMessageId: string }): Promise<{ warning: string | null }> {
  const { target, content, clientMessageId } = params;
  const text = params.comment.trim();
  const input = sharedContentInput(content);
  if (target.kind === 'group') {
    if (!await getGroupChat(target.id)) throw new Error('目标群聊已删除');
    await sendGroupUserMessage({ groupId: target.id, text, ...input, clientMessageId });
    return { warning: null };
  }
  const session = await resolveCanonicalConversation({ aiId: target.id });
  if (isChatSendBlockedByCall(getActiveChatCall(), session.id, target.id)) throw new Error('目标 AI 正在通话，请结束通话后再分享');
  const result = await sendUserMessage({ sessionId: session.id, text, ...input, clientMessageId }, target.aiConfig);
  if (!result.userMessage) throw new Error(result.error ?? '分享失败');
  return { warning: result.success ? null : `内容已分享，AI 回复启动失败：${result.error}` };
}
