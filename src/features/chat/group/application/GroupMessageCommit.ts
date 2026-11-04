/** 群聊消息事实提交、系统提示与已读操作；保留 legacy 群聊落库行为。 */

import { splitUserMessageSubmission } from '../../messages/application/UserMessageSubmission';
import { prepareChatAttachments } from '../../messages/application/PrepareChatAttachments';
import type { CommitMessageInput } from '../../messages/domain/MessageRepository';
import { databaseCoordinator } from '@platform/persistence';
import type { ChatMessage, CreateMessageInput } from '../../messages/domain/ChatMessage';
import type { ChatAttachment } from '../../messages/domain/ChatAttachment';
import type { SharedChatRecord } from '../../messages/domain/SharedChatRecord';
import {
  buildStickerMessageMetadata,
  type StickerMessageSnapshot,
} from '../../messages/domain/ChatSticker';
import type { GroupSpeechPlanRotation } from '../domain/GroupChat';
import {
  buildAttachmentMessageMetadata,
  buildUserMessagePreviewText,
  type GroupMessageMention,
  type ChatReplyQuote,
} from '../../messages/domain/chatMessageMetadata';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import { emitChatMessagesUpdated } from '../../messages/events/ChatEvents';

function formatMessageTime(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  const hours = value.getHours().toString().padStart(2, '0');
  const minutes = value.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function buildGroupMessageMetadata(kind: string, extras: Record<string, unknown> = {}) {
  return JSON.stringify({
    groupChat: {
      kind,
      ...extras,
    },
  });
}

/**
 * 系统提示等旁路消息的 legacy 提交接缝：消息仓储先提交消息事实，再单独更新
 * 群聊预览。群用户消息不走这里——它必须与 plan 换代共享同一事务，
 * 见 commitGroupUserMessage。
 */
async function insertGroupMessage(
  message: Omit<CreateMessageInput, 'time' | 'createdAt' | 'updatedAt' | 'showTimeSeparatorBefore'> & {
    createdAt?: string;
  },
  previewText: string | null,
): Promise<ChatMessage> {
  const now = message.createdAt || new Date().toISOString();
  const inserted = await getChatMessageRuntimeDependencies().messages.commitMessage({
    message: {
      ...message,
      time: formatMessageTime(now),
      createdAt: now,
      updatedAt: now,
    },
    previewText: previewText ?? message.text,
  });

  if (previewText !== null) {
    // CAS：晚到的旁路消息 preview 不得覆盖更新的消息事实。
    await getChatGroupRuntimeDependencies().groups.updatePreviewForCommittedMessage(
      message.sessionId,
      inserted.id,
      previewText,
      now,
    );
  }

  emitChatMessagesUpdated(message.sessionId);
  return inserted;
}

export interface CommitGroupUserMessageResult {
  message: ChatMessage;
  /** 与消息同事务裁决的 plan 换代结果；commit 后由调用方执行 abort 等副作用。 */
  rotation: GroupSpeechPlanRotation;
}

/**
 * 群用户消息提交与 plan 换代是同一个原子操作：消息事实、群预览、旧 plan
 * superseded、旧任务失去提交资格、pending successor 与继承队列在同一
 * transaction 内 commit，禁止先独立提交消息再用第二个事务取消旧 plan。
 * UI 通知沿用 legacy 顺序，在 commit 后执行。
 */
export async function commitGroupUserMessage(params: {
  groupId: string;
  text: string;
  attachments?: ChatAttachment[];
  sharedRecord?: SharedChatRecord;
  sharedMoment?: import('../../messages/domain/SharedMoment').SharedMoment;
  /** 独立 Sticker 消息语义；不能与普通附件同时出现。 */
  sticker?: StickerMessageSnapshot | null;
  mentions?: Extract<GroupMessageMention, { actorType: 'user' }>[];
  replyToId?: number | null;
  replyToText?: string | null;
  replyQuote?: ChatReplyQuote | null;
  clientMessageId?: string | null;
}): Promise<CommitGroupUserMessageResult> {
  const text = String(params.text || '').trim();
  const attachments = params.attachments || [];
  const sticker = params.sticker || null;
  const mentions = params.mentions || [];
  if ((!text && attachments.length === 0 && !sticker && !params.sharedRecord && !params.sharedMoment) || (sticker && attachments.length > 0)) {
    throw new Error('消息不能为空');
  }

  const currentUser = await getChatGroupRuntimeDependencies().currentUserDirectory.getCurrent();
  const now = new Date().toISOString();
  const parts = splitUserMessageSubmission({ text, attachments, clientMessageId: params.clientMessageId, sharedRecord: params.sharedRecord, sharedMoment: params.sharedMoment });
  const inputs: CommitMessageInput[] = parts.map((part, index) => {
    const isLast = index === parts.length - 1;
    const messageMetadata = part.sharedRecord ? { kind: 'shared_record', sharedRecord: part.sharedRecord } : part.sharedMoment ? { kind: 'shared_moment', sharedMoment: part.sharedMoment } : sticker
      ? buildStickerMessageMetadata(sticker)
      : buildAttachmentMessageMetadata(part);
    return {
      message: {
        sessionId: params.groupId,
        text: part.text,
        isMe: true,
        isRead: true,
        senderType: 'user',
        agentId: null,
        apiMessageId: null,
        clientMessageId: part.clientMessageId,
        replyToId: isLast ? params.replyToId || null : null,
        replyToText: isLast ? params.replyToText || null : null,
        status: 'sent',
        tokensUsed: 0,
        promptTokens: 0,
        completionTokens: 0,
        metadataJson: JSON.stringify({
          ...(messageMetadata || {}),
          ...(isLast && params.replyQuote ? { replyQuote: params.replyQuote } : {}),
          groupChat: {
            kind: 'user_message',
            groupId: params.groupId,
            actorType: 'user',
            actorName: currentUser.name,
            triggerSource: 'group_chat',
            mentions: isLast ? mentions : [],
          },
        }),
        time: formatMessageTime(now),
        createdAt: now,
        updatedAt: now,
      },
      previewText: buildUserMessagePreviewText({ text: part.text, metadata: messageMetadata }),
    };
  });
  const previewText = inputs[inputs.length - 1].previewText;
  const prepared = await prepareChatAttachments([...(params.sharedRecord ? params.sharedRecord.entries.flatMap((entry) => entry.attachments) : attachments), ...(params.replyQuote?.attachments ?? [])]);
  let result: CommitGroupUserMessageResult;
  try {
    result = await databaseCoordinator.transaction(
    { name: 'chat.commit-group-user-message', feature: 'chat', priority: 'interactive' },
    async (transaction) => {
      const messages: ChatMessage[] = [];
      const materialized = prepared ? await prepared.materialize(transaction, inputs) : inputs;
      for (const input of materialized) {
        messages.push(await getChatMessageRuntimeDependencies().messages.commitMessageInTransaction(
          transaction, input,
        ));
      }
      // 尾消息标记整次发送的输入上界；计划只在完整批次落库后换代一次。
      const message = messages[messages.length - 1];
      const rotation = await getChatGroupRuntimeDependencies()
        .groups.rotateSpeechPlanForUserMessageInTransaction(transaction, {
          groupId: params.groupId,
          userMessageId: message.id,
        });
      // 群预览是消息事实的投影，与消息、换代同一事务 commit；commit 后不存在
      // "事实已落库但 preview 更新失败导致调用方误判失败"的窗口。
      await getChatGroupRuntimeDependencies()
        .groups.updatePreviewInTransaction(
          transaction,
          params.groupId,
          message.id,
          previewText,
          now,
        );
      return { message, rotation };
    },
  );
  } catch (error) {
    await prepared?.finish(false);
    throw error;
  }
  await prepared?.finish(true);

  try { emitChatMessagesUpdated(params.groupId); }
  catch (error) { console.warn('[GroupMessageCommit] 已提交消息的 UI 通知失败：', error); }
  return result;
}

/** 群聊编排器使用的内部系统提示提交命令。 */
export async function insertSystemTip(
  groupId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await insertGroupMessage(
    buildSystemTipMessage(groupId, text, metadata),
    text,
  );
}

/**
 * 属于某个发言 plan 规划过程的系统提示（如管理员调度失败提示）：落库资格
 * 与 plan 所有权在同一事务裁决——planning 期间 plan 被换代时，旧规划上下文
 * 晚到的提示不得再出现在用户新消息之后。返回 false 表示 fence 拒绝。
 */
export async function insertSystemTipIfSpeechPlanActive(
  groupId: string,
  planId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const now = new Date().toISOString();
  const inserted = await databaseCoordinator.transaction(
    { name: 'chat.commit-group-system-tip', feature: 'chat', priority: 'interactive' },
    async (transaction) => {
      const active = await getChatGroupRuntimeDependencies()
        .groups.isSpeechPlanActiveInTransaction(transaction, planId);
      if (!active) {
        return null;
      }
      return getChatMessageRuntimeDependencies().messages.commitMessageInTransaction(
        transaction,
        {
          message: {
            ...buildSystemTipMessage(groupId, text, metadata),
            time: formatMessageTime(now),
            createdAt: now,
            updatedAt: now,
          },
          previewText: text,
        },
      );
    },
  );
  if (!inserted) {
    return false;
  }
  // CAS：提示的 preview 与消息事实绑定，不得覆盖更新的消息。
  await getChatGroupRuntimeDependencies().groups.updatePreviewForCommittedMessage(
    groupId,
    inserted.id,
    text,
    now,
  );
  emitChatMessagesUpdated(groupId);
  return true;
}

function buildSystemTipMessage(
  groupId: string,
  text: string,
  metadata: Record<string, unknown>,
): Omit<CreateMessageInput, 'time' | 'createdAt' | 'updatedAt' | 'showTimeSeparatorBefore'> {
  return {
    sessionId: groupId,
    text,
    isMe: false,
    isRead: true,
    senderType: 'system',
    agentId: null,
    apiMessageId: null,
    clientMessageId: null,
    replyToId: null,
    replyToText: null,
    status: 'sent',
    tokensUsed: 0,
    promptTokens: 0,
    completionTokens: 0,
    metadataJson: buildGroupMessageMetadata('system_tip', {
      groupId,
      actorType: 'system',
      triggerSource: 'group_chat',
      ...metadata,
    }),
  };
}

/** 群聊标记已读入口；有实际变更时仍发布 messagesUpdated。 */
export async function markGroupConversationAsRead(groupId: string): Promise<number> {
  const marked = await getChatMessageRuntimeDependencies().messages.markMessagesAsRead(groupId);
  if (marked > 0) {
    emitChatMessagesUpdated(groupId);
  }
  return marked;
}
