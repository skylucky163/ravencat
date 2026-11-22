/** 管理聊天会话时间线的分页加载、乐观消息合并及实时订阅同步。 */
import { splitUserMessageSubmission } from './UserMessageSubmission';
import type { ChatMessage } from '../domain/ChatMessage';
import {
  sortChatTimelineMessages,
} from '../domain/ChatTimelineOrdering';
import type { ChatReplyQuote } from '../domain/chatMessageMetadata';
import type { ChatAttachment } from '../domain/ChatAttachment';
import {
  buildStickerMessageMetadata,
  type StickerMessageSnapshot,
} from '../domain/ChatSticker';
import {
  buildAttachmentMessageMetadata,
} from '../domain/chatMessageMetadata';
import type { IMessageRepository } from '../domain/MessageRepository';
import type { DatabaseTaskPriority } from '@platform/persistence';
import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { setChatEventBus } from '../events/ChatEvents';

export interface OpenConversationTimelineParams {
  sessionId: string;
  limit?: number;
  /**
   * 调度优先级。进入会话的首屏读取用默认 `'interactive'`；
   * 后台预热必须传 `'maintenance'`，避免与用户真实交互争抢 SQLite 调度。
   */
  priority?: DatabaseTaskPriority;
}

export interface LoadOlderTimelineParams {
  sessionId: string;
  cursor: number | null;
  limit?: number;
}

export interface LoadNewerTimelineParams {
  sessionId: string;
  afterId: number;
}

export interface TimelinePageResult {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: number | null;
  success: boolean;
  error: string | null;
}

export interface TimelineDeltaResult {
  messages: ChatMessage[];
  success: boolean;
  error: string | null;
}

export type TimelineMergeMode = 'append' | 'prepend';

export interface CreateOptimisticUserTimelineMessageParams {
  sessionId: string;
  text: string;
  replyToId?: number | null;
  replyToText?: string | null;
  replyQuote?: ChatReplyQuote | null;
  clientMessageId?: string | null;
  attachments?: ChatAttachment[];
  sticker?: StickerMessageSnapshot | null;
  showTimeSeparatorBefore?: boolean;
  createdAt?: string | Date;
  tempId?: number;
}

export interface MergeTimelineMessagesResult {
  messages: ChatMessage[];
  appendedMessages: ChatMessage[];
  reconciledMessages: ChatMessage[];
  changed: boolean;
  lastMessageId: number | null;
}

export interface SubscribeConversationTimelineParams {
  sessionId: string;
  getAfterId: () => number | null;
  getLoadedMessageIds: () => readonly number[];
  onReplace?: (messages: ChatMessage[]) => void | Promise<void>;
  onAppend?: (messages: ChatMessage[]) => void | Promise<void>;
  onRemove?: (messageIds: readonly number[]) => void | Promise<void>;
  onReset?: () => void;
  onError?: (error: string) => void;
  pollIntervalMs?: number | null;
  shouldPoll?: () => boolean;
}

interface TimelineDeps {
  repository?: IMessageRepository;
}

type TimelineSyncMode = 'replace' | 'append' | 'noop';

interface TimelineSyncResult {
  mode: TimelineSyncMode;
  messages: ChatMessage[];
}

interface TimelinePatchSyncState {
  updatedMessageIds?: number[];
  forceReload?: boolean;
}

export function hasSameTimelineMessageIdentity(
  left: Pick<ChatMessage, 'id' | 'clientMessageId'>,
  right: Pick<ChatMessage, 'id' | 'clientMessageId'>
): boolean {
  if (left.id === right.id) {
    return true;
  }

  return Boolean(
    left.clientMessageId &&
      right.clientMessageId &&
      left.clientMessageId === right.clientMessageId
  );
}

export function getLastTimelineMessageId(messages: ChatMessage[]): number | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  return Math.max(...messages.map((message) => message.id));
}

export function createOptimisticUserTimelineMessage(
  params: CreateOptimisticUserTimelineMessageParams
): ChatMessage {
  const {
    sessionId,
    text,
    replyToId = null,
    replyToText = null,
    clientMessageId = createClientMessageId(),
    attachments = [],
    sticker = null,
    showTimeSeparatorBefore = false,
    createdAt = new Date(),
    tempId = Date.now(),
  } = params;

  const createdDate = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const createdAtIso = createdDate.toISOString();

  if (sticker && attachments.length > 0) {
    throw new Error('Sticker 消息不能同时携带普通附件');
  }

  const metadata = sticker
    ? buildStickerMessageMetadata(sticker)
    : buildAttachmentMessageMetadata({
        text,
        attachments,
      });

  return {
    id: tempId,
    sessionId,
    text,
    isMe: true,
    isRead: true,
    senderType: 'user',
    apiMessageId: null,
    clientMessageId,
    time: formatTimelineMessageTime(createdDate),
    createdAt: createdAtIso,
    showTimeSeparatorBefore,
    updatedAt: createdAtIso,
    replyToId,
    replyToText,
    status: 'pending',
    tokensUsed: 0,
    promptTokens: 0,
    completionTokens: 0,
    metadataJson: metadata || params.replyQuote
      ? JSON.stringify({ ...metadata, ...(params.replyQuote ? { replyQuote: params.replyQuote } : {}) })
      : null,
  };
}

/** 乐观时间线与 canonical 发送使用同一拆分规则和消息身份。 */
export function createOptimisticUserTimelineMessages(
  params: CreateOptimisticUserTimelineMessageParams,
): ChatMessage[] {
  const seed = createOptimisticUserTimelineMessage({ ...params, sticker: null });
  const parts = splitUserMessageSubmission({
    text: params.text,
    attachments: params.attachments ?? [],
    clientMessageId: seed.clientMessageId,
    sticker: params.sticker,
  });
  return parts.map((part, index) => createOptimisticUserTimelineMessage({
    ...params,
    ...part,
    sticker: part.sticker,
    tempId: seed.id + index,
    createdAt: seed.createdAt,
    showTimeSeparatorBefore: index === 0 && seed.showTimeSeparatorBefore,
    replyToId: index === parts.length - 1 ? params.replyToId : null,
    replyToText: index === parts.length - 1 ? params.replyToText : null,
    replyQuote: index === parts.length - 1 ? params.replyQuote : null,
  }));
}

export function mergeTimelineMessages(
  existingMessages: ChatMessage[] = [],
  incomingMessages: ChatMessage[] = [],
  mode: TimelineMergeMode = 'append'
): MergeTimelineMessagesResult {
  const currentMessages = [...existingMessages];
  const appendedMessages: ChatMessage[] = [];
  const reconciledMessages: ChatMessage[] = [];

  for (const incomingMessage of incomingMessages) {
    const existingIndex = currentMessages.findIndex((message) =>
      hasSameTimelineMessageIdentity(message, incomingMessage)
    );

    if (existingIndex >= 0) {
      const mergedMessage = {
        ...currentMessages[existingIndex],
        ...incomingMessage,
      };

      if (!areTimelineMessagesEqual(currentMessages[existingIndex], mergedMessage)) {
        currentMessages[existingIndex] = mergedMessage;
        reconciledMessages.push(mergedMessage);
      }

      continue;
    }

    appendedMessages.push(incomingMessage);
  }

  const unsortedMessages =
    appendedMessages.length === 0
      ? currentMessages
      : mode === 'prepend'
        ? [...appendedMessages, ...currentMessages]
        : [...currentMessages, ...appendedMessages];
  const messages = sortChatTimelineMessages(unsortedMessages);

  return {
    messages,
    appendedMessages,
    reconciledMessages,
    changed: appendedMessages.length > 0 || reconciledMessages.length > 0,
    lastMessageId: getLastTimelineMessageId(messages),
  };
}

export async function openConversationTimeline(
  params: OpenConversationTimelineParams,
  deps: TimelineDeps = {}
): Promise<TimelinePageResult> {
  const { sessionId, limit = 20, priority } = params;
  const repo = deps.repository ?? getChatMessageRuntimeDependencies().messages;

  try {
    return {
      ...(await repo.getMessages(sessionId, {
        limit,
        cursor: null,
        order: 'DESC',
        ...(priority ? { priority } : {}),
      })),
      success: true,
      error: null,
    };
  } catch (error) {
    console.error('[MessageTimeline] Failed to open timeline:', error);
    return {
      messages: [],
      hasMore: false,
      nextCursor: null,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function loadOlderTimelineMessages(
  params: LoadOlderTimelineParams,
  deps: TimelineDeps = {}
): Promise<TimelinePageResult> {
  const { sessionId, cursor, limit = 15 } = params;
  const repo = deps.repository ?? getChatMessageRuntimeDependencies().messages;

  try {
    return {
      ...(await repo.getMessages(sessionId, {
        limit,
        cursor,
        order: 'DESC',
      })),
      success: true,
      error: null,
    };
  } catch (error) {
    console.error('[MessageTimeline] Failed to load older messages:', error);
    return {
      messages: [],
      hasMore: false,
      nextCursor: null,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function loadNewerTimelineMessages(
  params: LoadNewerTimelineParams,
  deps: TimelineDeps = {}
): Promise<TimelineDeltaResult> {
  const { sessionId, afterId } = params;
  const repo = deps.repository ?? getChatMessageRuntimeDependencies().messages;

  try {
    return {
      messages: await repo.getNewerMessages(sessionId, afterId),
      success: true,
      error: null,
    };
  } catch (error) {
    console.error('[MessageTimeline] Failed to load newer messages:', error);
    return {
      messages: [],
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export function subscribeConversationTimeline(
  params: SubscribeConversationTimelineParams,
  deps: TimelineDeps = {}
): () => void {
  const {
    sessionId,
    getAfterId,
    getLoadedMessageIds,
    onReplace,
    onAppend,
    onRemove,
    onReset,
    onError,
    pollIntervalMs = null,
    shouldPoll,
  } = params;

  let isDisposed = false;
  let isSyncing = false;
  let hasPendingSync = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const pendingPatchedMessageIds = new Set<number>();
  let hasPendingReload = false;
  let historyGeneration = 0;
  // 删除可能发生在增量查询等待期间；旧查询结果不能重新插入已提交删除的身份。
  const deletedMessageIds = new Set<number>();

  const consumePendingPatchState = (): TimelinePatchSyncState => {
    if (pendingPatchedMessageIds.size === 0) {
      return {};
    }

    const updatedMessageIds = Array.from(pendingPatchedMessageIds.values());
    pendingPatchedMessageIds.clear();

    return {
      updatedMessageIds,
    };
  };

  const runSync = async () => {
    if (isDisposed) {
      return;
    }

    if (isSyncing) {
      hasPendingSync = true;
      return;
    }

    isSyncing = true;

    try {
      do {
        hasPendingSync = false;

        const generation = historyGeneration;
        const forceReload = hasPendingReload;
        hasPendingReload = false;
        const result = await syncConversationTimelineOnce({
          sessionId,
          getAfterId,
          getLoadedMessageIds,
          onError,
          forceReload,
          ...consumePendingPatchState(),
        }, deps);

        if (isDisposed) {
          return;
        }
        if (generation !== historyGeneration) continue;

        const messages = result.messages.filter((message) => !deletedMessageIds.has(message.id));
        if (result.mode === 'replace') {
          await onReplace?.(messages);
        } else if (result.mode === 'append' && result.messages.length > 0) {
          await onAppend?.(messages);
        }
      } while (!isDisposed && hasPendingSync);
    } catch (error) {
      console.error('[MessageTimeline] Failed to subscribe timeline updates:', error);
      onError?.(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      isSyncing = false;
    }
  };

  const unregisterEventBus = setChatEventBus({
    emit: async (eventName, payload) => {
      if (payload?.sessionId !== sessionId) {
        return;
      }

      if (eventName === 'messagesDeleted') {
        const ids = payload.deletedMessageIds!;
        for (const id of ids) deletedMessageIds.add(id);
        await onRemove?.(ids);
        return;
      }

      if (eventName === 'messagesPatched') {
        for (const messageId of payload.updatedMessageIds || []) {
          if (Number.isInteger(messageId) && messageId > 0) {
            pendingPatchedMessageIds.add(messageId);
          }
        }
      } else if (eventName === 'messagesReloadRequested') {
        if (payload.resetHistory) {
          historyGeneration++;
          pendingPatchedMessageIds.clear();
          onReset?.();
        }
        hasPendingReload = true;
      } else if (eventName !== 'messagesUpdated') {
        return;
      }

      await runSync();
    },
  });

  if (pollIntervalMs && pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      if (shouldPoll && !shouldPoll()) {
        return;
      }

      void runSync();
    }, pollIntervalMs);
  }

  return () => {
    isDisposed = true;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    unregisterEventBus();
  };
}

async function syncConversationTimelineOnce(
  params: Pick<
    SubscribeConversationTimelineParams,
    'sessionId' | 'getAfterId' | 'getLoadedMessageIds' | 'onError'
  > & TimelinePatchSyncState,
  deps: TimelineDeps = {}
): Promise<TimelineSyncResult> {
  const { sessionId, getAfterId, onError, updatedMessageIds = [], forceReload = false } = params;
  const repo = deps.repository ?? getChatMessageRuntimeDependencies().messages;
  const afterId = getAfterId();

  if (forceReload) {
    return {
      mode: 'replace',
      messages: await repo.getReloadWindowMessages(sessionId, params.getLoadedMessageIds()),
    };
  }

  if (!afterId) {
    const initialResult = await openConversationTimeline({ sessionId }, deps);

    if (!initialResult.success) {
      onError?.(initialResult.error || 'Failed to sync conversation timeline');
      return {
        mode: 'noop',
        messages: [],
      };
    }

    return {
      mode: 'replace',
      messages: initialResult.messages,
    };
  }

  const patchedMessages = await loadPatchedTimelineMessages(
    repo,
    sessionId,
    updatedMessageIds
  );

  const newerResult = await loadNewerTimelineMessages({ sessionId, afterId }, deps);

  if (!newerResult.success) {
    if (patchedMessages.length > 0) {
      onError?.(newerResult.error || 'Failed to fully sync conversation timeline');
      return {
        mode: 'append',
        messages: patchedMessages,
      };
    }

    onError?.(newerResult.error || 'Failed to sync conversation timeline');
    return {
      mode: 'noop',
      messages: [],
    };
  }

  const mergedSyncedMessages = mergeSyncedTimelineMessages(
    patchedMessages,
    newerResult.messages
  );

  if (mergedSyncedMessages.length === 0) {
    try {
      const messageCount = await repo.getMessageCount(sessionId);
      if (messageCount === 0) {
        return {
          mode: 'replace',
          messages: [],
        };
      }
    } catch (error) {
      console.error('[MessageTimeline] Failed to inspect message count after sync:', error);
    }
  }

  return {
    mode: mergedSyncedMessages.length > 0 ? 'append' : 'noop',
    messages: mergedSyncedMessages,
  };
}

async function loadPatchedTimelineMessages(
  repository: IMessageRepository,
  sessionId: string,
  messageIds: number[]
): Promise<ChatMessage[]> {
  const normalizedIds = Array.from(
    new Set(messageIds.filter((messageId) => Number.isInteger(messageId) && messageId > 0))
  );

  if (normalizedIds.length === 0) {
    return [];
  }

  const messages: (ChatMessage | null)[] = [];
  for (const messageId of normalizedIds) {
    messages.push(await repository.getMessageById(messageId));
  }

  return sortChatTimelineMessages(
    messages.filter((message): message is ChatMessage => (
      Boolean(message && message.sessionId === sessionId)
    )),
  );
}

function mergeSyncedTimelineMessages(
  patchedMessages: ChatMessage[],
  newerMessages: ChatMessage[]
): ChatMessage[] {
  const mergedById = new Map<number, ChatMessage>();

  for (const message of [...patchedMessages, ...newerMessages]) {
    mergedById.set(message.id, message);
  }

  return sortChatTimelineMessages(Array.from(mergedById.values()));
}

function formatTimelineMessageTime(date: Date | string): string {
  const value = typeof date === 'string' ? new Date(date) : date;
  const hours = value.getHours().toString().padStart(2, '0');
  const minutes = value.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function createClientMessageId(): string {
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function areTimelineMessagesEqual(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.text === right.text &&
    left.isMe === right.isMe &&
    left.isRead === right.isRead &&
    left.voicePlayedAt === right.voicePlayedAt &&
    left.senderType === right.senderType &&
    left.agentId === right.agentId &&
    left.apiMessageId === right.apiMessageId &&
    left.clientMessageId === right.clientMessageId &&
    left.time === right.time &&
    left.createdAt === right.createdAt &&
    left.showTimeSeparatorBefore === right.showTimeSeparatorBefore &&
    left.updatedAt === right.updatedAt &&
    left.replyToId === right.replyToId &&
    left.replyToText === right.replyToText &&
    left.logicalMessageId === right.logicalMessageId &&
    left.segmentIndex === right.segmentIndex &&
    left.segmentTotal === right.segmentTotal &&
    left.deliveryStatus === right.deliveryStatus &&
    left.status === right.status &&
    left.tokensUsed === right.tokensUsed &&
    left.promptTokens === right.promptTokens &&
    left.completionTokens === right.completionTokens &&
    left.metadataJson === right.metadataJson &&
    left.turnRunId === right.turnRunId &&
    left.turnItemIndex === right.turnItemIndex
  );
}

export const messageTimeline = {
  open: openConversationTimeline,
  loadOlder: loadOlderTimelineMessages,
  loadNewer: loadNewerTimelineMessages,
  subscribe: subscribeConversationTimeline,
  mergeMessages: mergeTimelineMessages,
  getLastMessageId: getLastTimelineMessageId,
  createOptimisticUserMessage: createOptimisticUserTimelineMessage,
  createOptimisticUserMessages: createOptimisticUserTimelineMessages,
};
