/** 定义上层业务与统一 Android 原生通知模块之间的数据契约。 */
import { persistentImageStore } from './PersistentImageStore';

export const AI_INCOMING_CALL_NOTIFICATION_TYPE = 'ai-incoming-call' as const;
export const AI_MESSAGE_NOTIFICATION_SUMMARY_TYPE = 'ai-message-summary' as const;

const MAX_NOTIFICATION_BODY_LENGTH = 120;
const ELLIPSIS = '...';

function formatNotificationMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

export type AIMessageDeliveryKind = 'passive' | 'proactive';

export type NotificationConversationKind = 'direct' | 'group';

export interface AIMessageNotificationData {
  type: 'ai-message' | 'ai-message-summary';
  aiId?: string | null;
  sessionId?: string | null;
  deliveryKind?: AIMessageDeliveryKind;
  triggerSource?: string | null;
  relatedEntityId?: string | null;
  segmentCount?: number;
  notificationId?: string | null;
  latestAiId?: string | null;
  lastMessageAt?: number;
  /** 会话聚合 key：direct = `ai:<aiId>`；group = `group:<groupId>` */
  conversationKey?: string | null;
  conversationKind?: NotificationConversationKind | null;
  groupId?: string | null;
}

export type IncomingCallNotificationAction = 'open' | 'accept' | 'reject';

export interface AIIncomingCallNotificationData {
  type: typeof AI_INCOMING_CALL_NOTIFICATION_TYPE;
  aiId: string;
  aiName?: string | null;
  sessionId: string;
  callId: string;
  notificationId?: string | null;
  notificationAction?: IncomingCallNotificationAction;
  lastMessageAt?: number;
}

export interface TogetherListeningNotificationData {
  type: 'together-listening';
  activityId: string;
  aiId: string;
  sessionId: string;
  notificationId?: string | null;
  notificationAction?: 'open' | 'leave';
}

export type AppNotificationData =
  | AIMessageNotificationData
  | AIIncomingCallNotificationData
  | TogetherListeningNotificationData;

export interface SendAIMessageNotificationParams {
  committedMessageId?: number;
  turnRunId?: string;
  aiId: string;
  aiName: string;
  message: string;
  aiAvatar?: string | null;
  sessionId?: string | null;
  deliveryKind?: AIMessageDeliveryKind;
  triggerSource?: string | null;
  relatedEntityId?: string | null;
  notificationScope?: string | null;
  /** 会话聚合 key，缺省按 `ai:<aiId>` 计算 */
  conversationKey?: string | null;
  /** 通知标题：单聊 = AI 名；群聊 = 群名 */
  conversationTitle?: string | null;
  conversationKind?: NotificationConversationKind | null;
  groupId?: string | null;
  /** 群通知 InboxStyle 行的发送者名；单聊缺省复用 aiName */
  senderName?: string | null;
  senderAvatar?: string | null;
  /**
   * 子通知唯一事件 ID：每条子通知的幂等键，同 eventId 重发更新同一条通知而非新增。
   * 建议 `logicalMessageId:segmentIndex`；缺省回退 relatedEntityId 或时间戳。
   */
  eventId?: string | null;
}

export interface SendAIIncomingCallNotificationParams {
  ringtoneUri: string | null;
  ringDurationMs: number;
  callId: string;
  aiId: string;
  aiName: string;
  aiAvatar?: string | null;
  sessionId: string;
  openingLine: string;
}

function isLikelyNotificationAvatarUri(value?: string | null): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return false;
  }
  return (
    trimmed.startsWith('file://')
    || trimmed.startsWith('content://')
    || trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
    || trimmed.startsWith('/')
    || /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

export function normalizeNotificationAvatarUri(value?: string | null): string | undefined {
  if (!isLikelyNotificationAvatarUri(value)) {
    return undefined;
  }
  return persistentImageStore.resolveFileUri(value) || undefined;
}

export function truncateNotificationBody(message: string): string {
  const trimmed = formatNotificationMessage(
    String(message || '').replace(/^\u21B3\s*/, '').trim()
  );
  if (trimmed.length <= MAX_NOTIFICATION_BODY_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_NOTIFICATION_BODY_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}

function toNotificationString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeIncomingCallNotificationAction(
  action?: string | null
): IncomingCallNotificationAction {
  if (action === 'accept') return 'accept';
  if (action === 'reject') return 'reject';
  return 'open';
}

export function normalizeNotificationData(rawData: unknown): AppNotificationData | null {
  if (!rawData || typeof rawData !== 'object') {
    return null;
  }

  const data = rawData as Record<string, unknown>;
  const rawType = toNotificationString(data.type);
  if (rawType === AI_INCOMING_CALL_NOTIFICATION_TYPE) {
    const aiId = toNotificationString(data.aiId);
    const sessionId = toNotificationString(data.sessionId);
    const callId = toNotificationString(data.callId);
    if (!aiId || !sessionId || !callId) {
      return null;
    }
    return {
      type: AI_INCOMING_CALL_NOTIFICATION_TYPE,
      aiId,
      aiName: toNotificationString(data.aiName),
      sessionId,
      callId,
      notificationId: toNotificationString(data.notificationId),
      notificationAction: normalizeIncomingCallNotificationAction(
        toNotificationString(data.notificationAction)
      ),
      lastMessageAt: parseOptionalNumber(data.lastMessageAt),
    };
  }

  if (rawType === 'together-listening') {
    const activityId = toNotificationString(data.activityId);
    const aiId = toNotificationString(data.hostAiId) || toNotificationString(data.aiId);
    const sessionId = toNotificationString(data.chatSessionId) || toNotificationString(data.sessionId);
    if (!activityId || !aiId || !sessionId) {
      return null;
    }
    return {
      type: 'together-listening',
      activityId,
      aiId,
      sessionId,
      notificationId: toNotificationString(data.notificationId),
      notificationAction: toNotificationString(data.notificationAction) === 'leave' ? 'leave' : 'open',
    };
  }

  if (rawType !== 'ai-message' && rawType !== AI_MESSAGE_NOTIFICATION_SUMMARY_TYPE) {
    return null;
  }

  const triggerSource = toNotificationString(data.triggerSource);
  const rawDeliveryKind = toNotificationString(data.deliveryKind);
  const deliveryKind = rawDeliveryKind === 'proactive' || rawDeliveryKind === 'passive'
    ? rawDeliveryKind
    : (triggerSource && triggerSource !== 'chat' ? 'proactive' : 'passive');
  const aiId = toNotificationString(data.aiId);
  const latestAiId = toNotificationString(data.latestAiId);
  const rawConversationKind = toNotificationString(data.conversationKind);

  return {
    type: rawType === AI_MESSAGE_NOTIFICATION_SUMMARY_TYPE ? 'ai-message-summary' : 'ai-message',
    aiId: aiId || latestAiId,
    sessionId: toNotificationString(data.sessionId),
    deliveryKind,
    triggerSource,
    relatedEntityId: toNotificationString(data.relatedEntityId),
    segmentCount: parseOptionalNumber(data.segmentCount),
    notificationId: toNotificationString(data.notificationId),
    latestAiId,
    lastMessageAt: parseOptionalNumber(data.lastMessageAt),
    conversationKey: toNotificationString(data.conversationKey),
    conversationKind: rawConversationKind === 'group' || rawConversationKind === 'direct'
      ? rawConversationKind
      : null,
    groupId: toNotificationString(data.groupId),
  };
}
