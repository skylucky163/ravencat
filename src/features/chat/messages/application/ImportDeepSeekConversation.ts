/** 把 DeepSeek 对话作为已发生的聊天历史导入，不经过发送、回复执行或消息交付。 */
import { CoordinatedDatabaseError, databaseCoordinator } from '@platform/persistence';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { getChatConversationRuntimeDependencies } from '../../conversation/application/ChatConversationRuntime';
import { formatMessageTime } from '../../reply/application/ChatReplyUtils';
import type { CreateMessageInput } from '../domain/ChatMessage';
import { DEEPSEEK_HISTORY_IMPORT_SOURCE, type DeepSeekConversation, type DeepSeekExportArchive, type DeepSeekExportMessage } from '../domain/DeepSeekImport';
import { buildAttachmentMessageMetadata, buildUserMessagePreviewText } from '../domain/chatMessageMetadata';
import { emitChatMessagesReloadRequested } from '../events/ChatEvents';
import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { prepareChatAttachments } from './PrepareChatAttachments';

export function loadDeepSeekImport(link: string, signal: AbortSignal) {
  return getChatMessageRuntimeDependencies().openDeepSeekArchive(link, signal);
}

export function describeDeepSeekConversation(conversation: DeepSeekConversation) {
  const summarize = (message: DeepSeekExportMessage) => {
    const text = message.text.trim() || message.files.map(file => file.fileName).join('、') || '只有思考过程';
    return {
      role: message.role === 'USER' ? '用户' : 'DeepSeek',
      text: text.length <= 200 ? text : text.slice(0, 200) + '…',
    };
  };
  return {
    messages: conversation.messages.length,
    thoughts: conversation.messages.filter(message => message.thinking.trim()).length,
    files: conversation.messages.reduce((count, message) => count + message.files.length, 0),
    first: summarize(conversation.messages[0]),
    last: summarize(conversation.messages[conversation.messages.length - 1]),
    hasHistoryGap: conversation.hasHistoryGap,
  };
}

export async function importDeepSeekConversation(
  aiId: string, archive: DeepSeekExportArchive, conversation: DeepSeekConversation, signal: AbortSignal,
) {
  const { messages, turns } = getChatMessageRuntimeDependencies();
  const { sessions } = getChatConversationRuntimeDependencies();
  const extracted = await archive.extractAttachments(conversation, signal);
  try {
    const prepared = await prepareChatAttachments([...extracted.files.values()]);
    let committed = false;
    let sessionId: string;
    try {
      throwIfAbortSignalAborted(signal);
      sessionId = await databaseCoordinator.transaction({ name: 'chat.import-deepseek-conversation', feature: 'chat', priority: 'interactive' }, async transaction => {
        throwIfAbortSignalAborted(signal);
        const session = await sessions.resolveCanonicalConversationInTransaction(transaction, aiId, new Date());
        const stored = new Map((await prepared?.materializeAttachments(transaction) ?? []).map(attachment => [attachment.id, attachment]));
        const items: CreateMessageInput[] = [];
        let timestamp = Number.NEGATIVE_INFINITY;
        let previewText = '';
        // DeepSeek 的同轮回复时间可能比提问早几毫秒。以原对话顺序为准，同一毫秒的消息由本地 ID 排序。
        for (const row of conversation.messages) {
          timestamp = Math.max(timestamp, row.timestamp);
          const time = new Date(timestamp);
          const attachments = row.files.map(source => {
            const attachment = extracted.files.get(source)!;
            return attachment.unavailable ? attachment : stored.get(attachment.id)!;
          });
          const metadata = buildAttachmentMessageMetadata({ text: row.text, attachments });
          const base = {
            sessionId: session.id, isRead: true, time: formatMessageTime(time), createdAt: time.toISOString(),
            logicalMessageId: `deepseek:${session.id}:${row.id}`,
            metadataJson: JSON.stringify({ importSource: DEEPSEEK_HISTORY_IMPORT_SOURCE, ...metadata }),
          };
          if (row.thinking.trim()) {
            items.push({ ...base, senderType: 'reasoning', isMe: false, text: row.thinking });
          }
          if (row.text.trim() || attachments.length) {
            const isMe = row.role === 'USER';
            items.push({
              ...base, senderType: isMe ? 'user' : 'assistant', isMe, text: row.text,
            });
            previewText = isMe ? buildUserMessagePreviewText({ text: row.text, metadata }) : row.text;
          }
        }
        const inserted = await messages.commitMessagesInTransaction(transaction, {
          messages: items, previewText: null, requireEmptyConversation: true,
        });
        const latestVisible = inserted.findLast(message => message.senderType !== 'reasoning');
        if (latestVisible) {
          await messages.updateSessionPreviewForCommittedMessageInTransaction(transaction, {
            sessionId: session.id, messageId: latestVisible.id, previewText,
          });
        }
        const lastInput = inserted.findLast(message => message.senderType === 'user');
        await turns.recordImportedHistoryInTransaction(transaction, session.id, lastInput?.id ?? 0);
        throwIfAbortSignalAborted(signal);
        return session.id;
      });
      committed = true;
    } catch (error) {
      if (error instanceof CoordinatedDatabaseError && error.cause instanceof Error) throw error.cause;
      throw error;
    } finally {
      await prepared?.finish(committed);
    }
    emitChatMessagesReloadRequested(sessionId, true);
    return {
      sessionId,
      messageCount: conversation.messages.length,
      missingFiles: [...extracted.files.values()].filter(attachment => attachment.unavailable).length,
    };
  } finally {
    extracted.dispose();
  }
}
