/**
 * @fileoverview 用户消息 → 模型输入的组装（Phase 5A 方案 §8 拆分）。
 *
 * 保留时间线组装职责：附件摘要、引用块、图片/文件 fallback 文本、补充说明包装；
 * 每条消息按真实 role 逐条产出（buildChatUserMessageModelInput）。
 * 已删除“连续消息请合并回复”业务提示、编号拼接与 forceAppendUserText /
 * user_message_batch 批处理语义。模型请求保留逐条真实 role 与时间顺序。
 *
 * buildChatBatchAIInput 仅保留为组合能力；群聊成员已从持久时间线逐条组装输入。
 */

import type { ChatAttachment } from '../../messages/domain/ChatAttachment';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import {
  buildStickerMessagePreviewText,
  buildVoiceMessageModelText,
  buildReplyQuoteModelText,
  getMessageAttachments,
  getMessageSticker,
  getMessageSharedRecord,
  getMessageSharedMoment,
  stringifyAttachmentSummary,
} from '@features/chat/messages/domain';
import { buildStickerModelText } from '../../messages/domain/ChatSticker';
import { resolveChatImageModelInput } from './ResolveChatImageModelInput';
import { getChatReplyRuntimeDependencies } from './ChatReplyRuntimeDependencies';
import { buildSharedChatRecordText, sharedRecordAuthorLabel } from '../../messages/domain/SharedChatRecord';
import { buildSharedMomentText } from '../../messages/domain/SharedMoment';
import { mediaImageFailure } from '@features/media';

export type ModelInputContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ModelInputContent = string | ModelInputContentPart[];

export interface BuildChatBatchAIInputResult {
  displayText: string;
  modelInput: ModelInputContent;
}

export interface ChatUserMessageModelInput {
  displayText: string;
  modelInput: ModelInputContent;
}

function buildFileFallbackPrompt(fileName: string): string {
  return [
    `用户发送了一个文件：${fileName}。`,
    '当前系统尚未成功解析出文件正文，请你基于文件名与当前上下文先自然回应，必要时提醒用户补充说明或改发更易解析的文本格式。',
  ].join('\n');
}

function buildImageFallbackPrompt(contextText: string, reason: string): string {
  return [
    `${contextText}。`,
    `图片读取结果：${reason}`,
    '当前系统暂时无法读取这张图片的实际内容，请你基于当前上下文先自然回应，并提醒用户重新发送图片或补充文字描述。',
  ].join('\n');
}

function buildUserStickerPrompt(messageText: string, stickerText: string): string {
  return messageText
    ? `${stickerText}\n用户补充说明：${messageText}`
    : stickerText;
}

async function appendAttachmentParts(
  parts: ModelInputContentPart[],
  attachment: ChatAttachment,
  messageText: string,
  assistantId: string,
  signal?: AbortSignal,
  authorLabel = '用户',
): Promise<void> {
  if (attachment.type === 'image') {
    const imageName = attachment.fileName || '未命名图片';
    // 素材身份不依赖读取成功；失败提示仍允许模型引用同一张图片。
    const contextText = `${authorLabel}发送了一张图片：${imageName}${attachment.mediaAssetId ? `；mediaAssetId=${attachment.mediaAssetId}` : ''}`;
    let directVision = false;

    try {
      const commonInput = {
        assistantId,
        contextText,
        signal,
      };
      const imageInput = await resolveChatImageModelInput(
        typeof attachment.mediaAssetId === 'string'
          ? { ...commonInput, mediaAssetId: attachment.mediaAssetId }
          : { ...commonInput, imageUri: attachment.localUri },
      );
      parts.push(...imageInput.parts);
      directVision = imageInput.route === 'direct_vision';
    } catch (error) {
      const failure = mediaImageFailure(error);
      if (!failure) throw error;
      console.warn(
        '[buildChatUserMessageModelInput] Failed to read image attachment as base64, fallback to text prompt:',
        error
      );
      parts.push({ type: 'text', text: buildImageFallbackPrompt(contextText, failure.modelContent) });
    }

    if (directVision) {
      const reminder = await getChatReplyRuntimeDependencies().prompt.readImageGroundingReminder(assistantId);
      if (reminder !== null) parts.push({ type: 'text', text: reminder });
    }

    if (messageText) {
      parts.push({ type: 'text', text: `用户补充说明：${messageText}` });
    }
    return;
  }

  const parsedText = attachment.parsedText?.trim();
  if (parsedText) {
    parts.push({ type: 'text', text: `${authorLabel}发送了文件：${attachment.fileName}` });
    parts.push({ type: 'text', text: `文件正文：\n${parsedText}` });
    if (messageText) {
      parts.push({ type: 'text', text: `用户补充说明：${messageText}` });
    }
    return;
  }

  parts.push({ type: 'text', text: authorLabel === '用户' ? buildFileFallbackPrompt(attachment.fileName) : `${authorLabel}的文件：\n${buildFileFallbackPrompt(attachment.fileName)}` });
  if (messageText) {
    parts.push({ type: 'text', text: `用户补充说明：${messageText}` });
  }
}

function buildQuotedText(text: string, replyToText?: string | null): string {
  if (!replyToText) return text;
  return `[引用：${replyToText}]\n${text}`;
}

function buildMessageDisplayLines(message: ChatMessage): string[] {
  if (buildVoiceMessageModelText(message)) {
    const lines = message.replyToText ? [`[引用：${message.replyToText}]`] : [];
    lines.push('[语音消息]');
    return lines;
  }
  const sticker = getMessageSticker(message);
  const attachments = getMessageAttachments(message);
  const text = buildQuotedText(String(message.text || '').trim(), message.replyToText);
  if (sticker) {
    const lines: string[] = [];
    if (message.replyToText) {
      lines.push(`[引用：${message.replyToText}]`);
    }
    lines.push(buildStickerMessagePreviewText(sticker));
    if (String(message.text || '').trim()) {
      lines.push(`用户补充说明：${String(message.text || '').trim()}`);
    }
    return lines;
  }
  if (!attachments.length) {
    return [text];
  }

  const lines: string[] = [];
  if (message.replyToText) {
    lines.push(`[引用：${message.replyToText}]`);
  }
  attachments.forEach((attachment) => {
    lines.push(stringifyAttachmentSummary(attachment));
  });
  if (text) {
    lines.push(`用户补充说明：${text}`);
  }
  return lines;
}

function joinTextParts(parts: ModelInputContentPart[]): string {
  return parts
    .filter((part): part is Extract<ModelInputContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** 单条用户消息 → 模型输入内容（附件/引用/fallback/补充说明，逐条真实 role）。 */
export async function buildChatUserMessageModelInput(
  message: ChatMessage,
  assistantId: string,
  currentAgentId?: string,
  signal?: AbortSignal,
): Promise<ChatUserMessageModelInput> {
  const moment = getMessageSharedMoment(message);
  if (moment) {
    const displayText = buildSharedMomentText(moment, currentAgentId);
    return { displayText, modelInput: displayText };
  }
  const record = getMessageSharedRecord(message);
  if (record) {
    const displayText = buildSharedChatRecordText(record, message.text, currentAgentId);
    const parts: ModelInputContentPart[] = [{ type: 'text', text: displayText }];
    for (const [index, entry] of record.entries.entries()) {
      for (const attachment of entry.attachments) {
        // 文件正文已经随作者写入上方记录；图片沿用现有视觉处理，并带上原作者。
        if (attachment.type === 'image') await appendAttachmentParts(parts, attachment, '', assistantId, signal, `分享记录第 ${index + 1} 项中${sharedRecordAuthorLabel(entry, currentAgentId)}`);
      }
    }
    return { displayText, modelInput: parts.some((part) => part.type === 'image_url') ? parts : joinTextParts(parts) };
  }
  const displayText = buildMessageDisplayLines(message)
    .filter(Boolean)
    .join('\n')
    .trim();

  const parts: ModelInputContentPart[] = [];
  const sticker = getMessageSticker(message);
  const attachments = getMessageAttachments(message);
  const text = String(message.text || '').trim();

  const quoteText = buildReplyQuoteModelText(message, currentAgentId);
  if (quoteText) {
    parts.push({ type: 'text', text: quoteText });
  }

  const voiceText = buildVoiceMessageModelText(message);
  if (voiceText) {
    parts.push({ type: 'text', text: voiceText });
  } else if (sticker) {
    // Sticker 是结构化语义消息；绝不能因为它有 mediaAssetId 而进入图片视觉/OCR。
    parts.push({
      type: 'text',
      text: buildUserStickerPrompt(text, `用户${buildStickerModelText(sticker)}`),
    });
  } else if (!attachments.length) {
    if (text) {
      parts.push({ type: 'text', text });
    }
  } else {
    for (const attachment of attachments) {
      await appendAttachmentParts(parts, attachment, text, assistantId, signal);
    }
  }

  if (parts.length === 0) {
    return { displayText, modelInput: displayText };
  }

  const hasImagePart = parts.some((part) => part.type === 'image_url');
  return {
    displayText,
    modelInput: hasImagePart ? parts : joinTextParts(parts),
  };
}

/**
 * 多条用户消息的组合入口：displayText 为逐条展示文本的联接，modelInput
 * 为单份组合输入。需要保留真实时间线的调用方应使用单条组装入口。
 */
export async function buildChatBatchAIInput(params: {
  messages: ChatMessage[];
  assistantId: string;
  signal?: AbortSignal;
}): Promise<BuildChatBatchAIInputResult> {
  const messages = Array.isArray(params.messages) ? params.messages : [];

  const perMessage: ChatUserMessageModelInput[] = [];
  for (const message of messages) {
    perMessage.push(await buildChatUserMessageModelInput(message, params.assistantId, undefined, params.signal));
  }

  const displayText = perMessage
    .map((item) => item.displayText)
    .filter(Boolean)
    .join('\n')
    .trim();

  const parts: ModelInputContentPart[] = [];
  let hasImagePart = false;
  perMessage.forEach((item) => {
    const content = item.modelInput;
    if (typeof content === 'string') {
      if (content) {
        parts.push({ type: 'text', text: content });
      }
      return;
    }
    parts.push(...content);
  });
  hasImagePart = parts.some((part) => part.type === 'image_url');

  if (parts.length === 0) {
    return { displayText, modelInput: displayText };
  }

  return {
    displayText,
    modelInput: hasImagePart ? parts : joinTextParts(parts),
  };
}
