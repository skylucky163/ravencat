/** 同一投影决定摘要与尚未总结原文；对话计数，应用事件随所属范围交接。 */
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import { buildChatSystemEventModelText, buildSessionPreviewTextFromMessage, buildVoiceMessageModelText, buildReplyQuoteModelText, getMessageAttachments, getMessageSticker, getMessageSharedRecord, getMessageSharedMoment, isCallStatusMessageMetadata, isTogetherListeningMessageMetadata, parseMessageMetadata } from '../../messages/domain/chatMessageMetadata';
import { buildStickerModelText } from '../../messages/domain/ChatSticker';
import { buildSharedChatRecordText, type SharedChatRecord } from '../../messages/domain/SharedChatRecord';
import { buildSharedMomentText, type SharedMoment } from '../../messages/domain/SharedMoment';

export type ChatCanonicalCursor = readonly [string, number, number, number];
export interface ChatContextItem {
  cursor: ChatCanonicalCursor;
  messageId: number;
  kind: 'dialogue' | 'app_event';
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  logicalMessageId: string | null;
  /** 语音事实随原文传递，不能靠转写正文中的标签猜测。 */
  isVoiceMessage?: true;
  /** 流式原文可进入当轮上下文，但摘要游标不能越过仍会更新的条目。 */
  pending?: true;
  sharedRecord?: SharedChatRecord;
  sharedMoment?: SharedMoment;
  sharedComment?: string;
  /** 群共享投影只携带公开身份；原消息供当前输入的附件投影使用。 */
  actor?: { assistantId: string | null; agentId: string | null; name: string };
  message?: ChatMessage;
  groupPlanId?: string | null;
}
export function projectChatContextMessage(message: ChatMessage, cursor: ChatCanonicalCursor): ChatContextItem | null {
  const eventText = buildChatSystemEventModelText(message);
  if (eventText) return { cursor, messageId: message.id, kind: 'app_event', role: 'user',
    content: eventText, timestamp: message.createdAt, logicalMessageId: null,
    ...(message.status === 'streaming' ? { pending: true } : {}) };
  if (message.status !== 'sent' || message.deliveryStatus === 'cancelled'
    || (message.senderType !== 'user' && message.senderType !== 'assistant')) return null;
  const metadata = parseMessageMetadata(message);
  if (isCallStatusMessageMetadata(metadata)) return null;
  if (isTogetherListeningMessageMetadata(metadata)
    && !(message.isMe && metadata.phase === 'pending_ai_response')) return null;
  const sticker = getMessageSticker(message);
  const voice = buildVoiceMessageModelText(message);
  const sharedRecord = getMessageSharedRecord(message);
  const sharedMoment = getMessageSharedMoment(message);
  const text = sharedMoment ? buildSharedMomentText(sharedMoment) : sharedRecord ? buildSharedChatRecordText(sharedRecord, message.text) : voice || (sticker ? buildStickerModelText(sticker)
    : message.isMe ? buildSessionPreviewTextFromMessage(message) : message.text);
  // 历史原文只投影素材引用，不读文件；图片 ID 留在模型上下文，列表预览保持展示语义。
  const imageReferences = getMessageAttachments(message).flatMap(attachment =>
    attachment.type === 'image' && attachment.mediaAssetId
      ? [`图片：${attachment.fileName || '未命名图片'}；mediaAssetId=${attachment.mediaAssetId}`] : []);
  const content = [text, ...imageReferences].filter(Boolean).join('\n').trim();
  if (!content) return null;
  return { cursor, messageId: message.id, kind: 'dialogue', role: message.isMe ? 'user' : 'assistant',
    content: [buildReplyQuoteModelText(message), content].filter(Boolean).join('\n'),
    timestamp: message.createdAt, logicalMessageId: message.logicalMessageId ?? null,
    ...(voice !== null ? { isVoiceMessage: true as const } : {}),
    ...(sharedRecord ? { sharedRecord, sharedComment: message.text } : {}),
    ...(sharedMoment ? { sharedMoment } : {}) };
}
export function compareChatContextCursor(left: ChatCanonicalCursor, right: ChatCanonicalCursor): number {
  for (let index = 0; index < 4; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}
export function parseChatContextCursor(value: string | null): ChatCanonicalCursor | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length !== 4 || typeof parsed[0] !== 'string'
    || !parsed.slice(1).every((item) => typeof item === 'number' && Number.isFinite(item))) throw new Error('摘要处理游标损坏');
  return parsed as unknown as ChatCanonicalCursor;
}
