/** 一次发送拆成独立展示消息；图文或分享附言仍共享同一次提交与回复边界。 */
import type { ChatAttachment } from '../domain/ChatAttachment';
import type { SharedChatRecord } from '../domain/SharedChatRecord';
import type { SharedMoment } from '../domain/SharedMoment';

export interface UserMessageContent {
  text: string;
  attachments: ChatAttachment[];
  clientMessageId: string | null;
  sharedRecord?: SharedChatRecord;
  sharedMoment?: SharedMoment;
}

export function splitUserMessageSubmission(params: {
  text: string;
  attachments: ChatAttachment[];
  clientMessageId?: string | null;
  sharedRecord?: SharedChatRecord;
  sharedMoment?: SharedMoment;
}): UserMessageContent[] {
  const { text, attachments, clientMessageId = null } = params;
  if (params.sharedRecord || params.sharedMoment) {
    const comment = text.trim();
    const record: UserMessageContent = {
      text: '', attachments: [], sharedRecord: params.sharedRecord, sharedMoment: params.sharedMoment,
      clientMessageId: comment && clientMessageId ? `${clientMessageId}:record` : clientMessageId,
    };
    // 附言是当前用户的独立发言，尾消息作为整次分享的输入上界。
    return comment ? [record, { text: comment, attachments: [], clientMessageId }] : [record];
  }
  const images = attachments.filter((attachment) => attachment.type === 'image');
  const files = attachments.filter((attachment) => attachment.type === 'file');
  if (images.length === 0) {
    return [{ text, attachments, clientMessageId }];
  }
  const parts: UserMessageContent[] = images.map((attachment) => ({
    text: '',
    attachments: [attachment],
    clientMessageId: clientMessageId ? `${clientMessageId}:image:${attachment.id}` : null,
  }));
  if (text || files.length > 0) {
    parts.push({ text, attachments: files, clientMessageId });
  } else {
    // 尾消息沿用发送身份，单条重试不会再次派生一个新的身份。
    parts[parts.length - 1].clientMessageId = clientMessageId;
  }
  return parts;
}
