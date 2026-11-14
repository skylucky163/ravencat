/** 真实发送的聊天内容才是回复；业务卡片、系统事件和空提交不表示用户回答。 */
import type { ChatMessage } from './ChatMessage';
import { parseMessageMetadata } from './chatMessageMetadata';

export function isSubstantiveUserMessage(message: ChatMessage): boolean {
  if (!message.isMe || message.senderType !== 'user') return false;
  const metadata = parseMessageMetadata(message);
  if (metadata?.type) return false;
  if (metadata?.kind) return ['voice', 'image', 'file', 'mixed', 'sticker', 'shared_record', 'shared_moment'].includes(metadata.kind);
  return message.text.trim().length > 0;
}
