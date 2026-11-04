/**
 * @fileoverview SendUserMessage UseCase - 发送用户消息
 *
 * Phase 5A：canonical 1:1 用户消息经 commitCanonicalUserMessage 单事务落库
 * （含 active run supersede），随后通过注入的回调端口通知 Host
 * “用户消息已提交（sessionId, supersededRunId）”，由显式 executionMode 决定
 * 委派 Android execution host 或由当前受控 host 就地执行。内存队列（ChatRuntimeQueue）已删除。
 */

import { randomUUID } from 'expo-crypto';
import type { ChatMessage } from '../domain/ChatMessage';
import type { ChatReplyQuote } from '../domain/chatMessageMetadata';
import type { ChatAttachment } from '../domain/ChatAttachment';
import type { SharedChatRecord } from '../domain/SharedChatRecord';
import type { SharedMoment } from '../domain/SharedMoment';
import type { StickerMessageSnapshot } from '../domain/ChatSticker';
import { recordUserStickerUse } from '@features/stickers';
import type { CommitMessageInput, IMessageRepository } from '../domain/MessageRepository';
import type { AIReplyConfig, ProcessAIReplyCallbacks } from '../../reply/application/ProcessAIReply';
import {
  buildAttachmentMessageMetadata,
  buildStickerMessageMetadata,
  buildUserMessagePreviewText,
} from '@features/chat/messages/domain';
import {
  getChatMessageRuntimeDependencies,
  type ConversationTurnExecutionMode,
} from './ChatMessageRuntime';
import { commitAndDispatchCanonicalUserMessage } from './CommitAndDispatchCanonicalUserMessage';
import { splitUserMessageSubmission } from './UserMessageSubmission';
import { prepareChatAttachments } from './PrepareChatAttachments';


function formatMessageTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

export interface SendUserMessageParams {
  sessionId: string;
  text: string;
  replyToId?: number | null;
  replyToText?: string | null;
  replyQuote?: ChatReplyQuote | null;
  clientMessageId?: string | null;
  attachments?: ChatAttachment[];
  sharedRecord?: SharedChatRecord;
  sharedMoment?: SharedMoment;
  /** 独立 Sticker 消息语义；不能与普通附件同时出现。 */
  sticker?: StickerMessageSnapshot | null;
}

export type AIAssistantConfig = AIReplyConfig;

export interface SendUserMessageResult {
  /** canonical commit 事实；commit 后副作用失败时仍非空。 */
  userMessage: ChatMessage | null;
  /** 同次发送已提交的全部消息，按时间线顺序返回。 */
  userMessages: ChatMessage[];
  /** 完整发送编排是否成功，不代替 userMessage 表达落库事实。 */
  success: boolean;
  error: string | null;
}

export interface SendUserMessageDeps {
  repository?: IMessageRepository;
  executionMode?: ConversationTurnExecutionMode;
  replyCallbacks?: ProcessAIReplyCallbacks;
  deliveryTiming?: 'paced' | 'immediate';
  correlationId?: string;
  signal?: AbortSignal;
  executionDeadlineAt?: number;
}

/**
 * Chat 内部/Host composition 使用的依赖注入入口。
 *
 * 普通调用方必须使用下方两参数的 sendUserMessage；第三参数包含 repository、
 * executionMode 与回调等运行时能力，不能通过普通公共 facade 传入。
 */
export async function sendUserMessageInternal(
  params: SendUserMessageParams,
  aiConfig: AIAssistantConfig,
  deps: SendUserMessageDeps = {}
): Promise<SendUserMessageResult> {
  const {
    sessionId,
    text,
    replyToId = null,
    replyToText = null,
    clientMessageId = null,
    attachments = [],
    sticker = null,
    sharedRecord,
    sharedMoment,
  } = params;

  const now = new Date();
  const timeStr = formatMessageTime(now);
  const createdAt = now.toISOString();
  let committedUserMessage: ChatMessage | null = null;
  let committedUserMessages: ChatMessage[] = [];
  let prepared: Awaited<ReturnType<typeof prepareChatAttachments>> = null;

  try {
    const assistantDirectory = getChatMessageRuntimeDependencies().assistantDirectory;
    const blockedState = await assistantDirectory.getBlockState(aiConfig.id);
    if (aiConfig.isBlocked || blockedState.isBlocked) {
      return {
        userMessage: null,
        userMessages: [],
        success: false,
        error: '该 AI 当前已被主理 AI 拉黑，暂时无法继续对话',
      };
    }

    if (sticker && attachments.length > 0) {
      throw new Error('Sticker 消息不能同时携带普通附件');
    }

    const parts = splitUserMessageSubmission({ text, attachments, clientMessageId, sharedRecord, sharedMoment });
    // 同次发送可有多个气泡，摘要仍按一次用户提交计数。
    const logicalMessageId = parts.length > 1 ? 'user_submission:' + (clientMessageId ?? randomUUID()) : null;
    const inputs: CommitMessageInput[] = parts.map((part, index) => {
      const messageMetadata = part.sharedRecord ? { kind: 'shared_record', sharedRecord: part.sharedRecord } : part.sharedMoment ? { kind: 'shared_moment', sharedMoment: part.sharedMoment } : sticker
        ? buildStickerMessageMetadata(sticker)
        : buildAttachmentMessageMetadata(part);
      const isLast = index === parts.length - 1;
      return {
        message: {
          sessionId,
          text: part.text,
          isMe: true,
          senderType: 'user',
          agentId: null,
          apiMessageId: null,
          clientMessageId: part.clientMessageId,
          logicalMessageId,
          time: timeStr,
          createdAt,
          updatedAt: createdAt,
          replyToId: isLast ? replyToId : null,
          replyToText: isLast ? replyToText : null,
          status: 'sent',
          tokensUsed: 0,
          promptTokens: 0,
          completionTokens: 0,
          metadataJson: JSON.stringify({
            ...(messageMetadata || {}),
            ...(isLast && params.replyQuote ? { replyQuote: params.replyQuote } : {}),
            triggerSource: 'chat',
            triggerReason: 'user_message',
            memoryParticipation: 'read_write',
          }),
        },
        previewText: buildUserMessagePreviewText({ text: part.text, metadata: messageMetadata }),
      };
    });
    const tail = inputs[inputs.length - 1];
    prepared = await prepareChatAttachments([...(sharedRecord ? sharedRecord.entries.flatMap((entry) => entry.attachments) : attachments), ...(params.replyQuote?.attachments ?? [])]);
    const result = await commitAndDispatchCanonicalUserMessage({
      ...tail,
      precedingMessages: inputs.slice(0, -1),
      aiConfig,
      executionMode: deps.executionMode ?? 'delegate_to_android_host',
      replyCallbacks: deps.replyCallbacks,
      deliveryTiming: deps.deliveryTiming,
      correlationId: deps.correlationId,
      signal: deps.signal,
      executionDeadlineAt: deps.executionDeadlineAt,
      repository: deps.repository,
      materializeMessagesInTransaction: prepared?.materialize,
    });
    committedUserMessage = result.userMessage;
    committedUserMessages = result.userMessages;
    await prepared?.finish(Boolean(result.userMessage));
    prepared = null;
    if (result.userMessage && sticker) {
      try {
        // Sticker 使用统计是 commit 后派生事实，不改变已提交消息的发送结果。
        await recordUserStickerUse(sticker.stickerId);
      } catch (error) {
        console.warn('[SendUserMessage] Sticker 使用统计更新失败：', error);
      }
    }
    return result;
  } catch (error) {
    await prepared?.finish(Boolean(committedUserMessage));
    console.error('[SendUserMessage] Failed:', error);
    return {
      // userMessage 是 canonical commit 事实：提交后副作用失败不能把它伪装成“未落库”。
      userMessage: committedUserMessage,
      userMessages: committedUserMessages,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/** 普通 Chat 公共命令：只接收业务参数与 AI 配置。 */
export async function sendUserMessage(
  params: SendUserMessageParams,
  aiConfig: AIAssistantConfig,
): Promise<SendUserMessageResult> {
  return sendUserMessageInternal(params, aiConfig);
}
