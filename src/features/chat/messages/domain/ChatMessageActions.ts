/** 消息操作资格属于 Chat 语义，单聊与群聊菜单共用同一契约。 */
import type { ChatMessage } from './ChatMessage';
import { readChatCodeBlock } from './ChatCodeBlock';
import { isChatTextDocumentFileName } from './ChatAttachment';
import { getMessageAttachments, getMessageDisplayKind, isCallOriginatedMessage, parseMessageMetadata } from './chatMessageMetadata';

export function getChatMessageActions(message: ChatMessage) {
  const ordinary = message.id > 0 && message.status === 'sent'
    && message.deliveryStatus !== 'cancelled'
    && (message.senderType === 'user' || message.senderType === 'assistant')
    && !parseMessageMetadata(message)?.type && !isCallOriginatedMessage(message);
  const kind = getMessageDisplayKind(message);
  const isCode = readChatCodeBlock(message.text) !== null;
  const attachments = getMessageAttachments(message);
  const supportedFiles = attachments.every(attachment => attachment.type === 'image' || isChatTextDocumentFileName(attachment.fileName));
  return {
    quote: ordinary,
    translate: ordinary && !isCode && kind !== 'sticker' && kind !== 'shared_record' && kind !== 'shared_moment' && message.text.trim().length > 0,
    favorite: ordinary && !isCode && kind !== 'shared_record' && kind !== 'shared_moment' && supportedFiles
      && (message.text.trim().length > 0 || attachments.length > 0 || kind === 'sticker' || kind === 'voice'),
  };
}
