/** 改写只修改已发送的普通正文，不改写媒体内容、语音转写或业务状态卡。 */
import type { ChatMessage } from './ChatMessage';
import { readChatCodeBlock } from './ChatCodeBlock';
import { getMessageDisplayKind, parseMessageMetadata } from './chatMessageMetadata';

export function canEditChatMessage(message: ChatMessage): boolean {
  const kind = getMessageDisplayKind(message);
  return message.id > 0
    && message.status === 'sent'
    && (message.senderType === 'user' || message.senderType === 'assistant')
    && message.deliveryStatus !== 'cancelled'
    && !parseMessageMetadata(message)?.type
    && !readChatCodeBlock(message.text)
    && (kind === 'text' || kind === 'mixed')
    && message.text.trim().length > 0;
}
