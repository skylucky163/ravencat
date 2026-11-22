/** 为应用提供统一 Android 原生通知的发送、撤销、权限、诊断与点击响应。 */
import {
  awaitTurnDisplayArrival,
  setTurnDisplayOpen,
  setTurnDisplayActive,
  addMessageArrivalListener,
  getMessageArrivalSnapshot,
  beginMessageArrival,
  awaitMessageArrival,
  finishMessageArrival,
  addNotificationResponseListener as addNativeNotificationResponseListener,
  cancelConversationNotifications,
  cancelReadMessageNotifications,
  cancelIncomingCallNotification,
  cancelTogetherListeningPresentation as cancelNativeTogetherListeningPresentation,
  clearNativeNotificationDataForFactoryReset as clearNativeNotificationData,
  consumePendingNotificationResponses as consumeNativePendingResponses,
  getNotificationDiagnostics as getNativeNotificationDiagnostics,
  getNotificationPermissionStatus,
  openFullScreenIntentSettings as openNativeFullScreenIntentSettings,
  openIncomingCallNotificationSettings as openNativeIncomingCallNotificationSettings,
  postConversationNotification,
  postIncomingCallNotification,
  upsertTogetherListeningPresentation as upsertNativeTogetherListeningPresentation,
  requestNotificationPermission as requestNativeNotificationPermission,
  type NativeNotificationDiagnostics,
  type NativeTogetherListeningPresentationResult,
  type PostTogetherListeningPresentationRequest,
} from '../../../modules/kimiphone-notifications';

import {
  normalizeNotificationAvatarUri,
  normalizeNotificationData,
  truncateNotificationBody,
  type AIMessageDeliveryKind,
  type AIIncomingCallNotificationData,
  type TogetherListeningNotificationData,
  type AIMessageNotificationData,
  type AppNotificationData,
  type SendAIIncomingCallNotificationParams,
  type SendAIMessageNotificationParams,
} from './notificationPayload';

type NotificationSubscription = {
  remove: () => void;
};

// 到达节奏与通知权限分开：页面与 Headless 共用原生进度，关闭通知仍正常递增未读。
export { addMessageArrivalListener, getMessageArrivalSnapshot, beginMessageArrival, awaitMessageArrival, finishMessageArrival };
export { awaitTurnDisplayArrival, setTurnDisplayOpen, setTurnDisplayActive };

export type {
  AIMessageDeliveryKind,
  AIMessageNotificationData,
  SendAIMessageNotificationParams,
  AIIncomingCallNotificationData,
  TogetherListeningNotificationData,
  AppNotificationData,
  SendAIIncomingCallNotificationParams,
  NativeNotificationDiagnostics,
  NativeTogetherListeningPresentationResult,
  PostTogetherListeningPresentationRequest,
};

export async function checkNotificationPermission(): Promise<boolean> {
  const status = await getNotificationPermissionStatus();
  return status.postNotificationsGranted && status.notificationsEnabled;
}

export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const status = await requestNativeNotificationPermission();
    return status.postNotificationsGranted && status.notificationsEnabled;
  } catch (error) {
    console.warn('[Notification] 请求 Android 通知权限失败。', error);
    return false;
  }
}

export async function initializeNotifications(): Promise<boolean> {
  try {
    return await checkNotificationPermission();
  } catch (error) {
    console.warn('[Notification] 初始化 Android 原生通知失败。', error);
    return false;
  }
}

export async function sendAIMessageNotification(
  params: SendAIMessageNotificationParams
): Promise<boolean> {
  // 聚合 key：群聊按 `group:<groupId>`，单聊按 `ai:<aiId>`，禁止伪造 aiId。
  const conversationKey = params.conversationKey || `ai:${params.aiId}`;
  // 每段消息一条独立子通知：displayId 携带逐段唯一的 eventId，原生按同规则撤销。
  const eventId = params.eventId || params.relatedEntityId || `${conversationKey}:${Date.now()}`;
  const displayId = `kimiphone-msg-${conversationKey}-${eventId}`;
  try {
    const result = await postConversationNotification({
      committedMessageId: params.committedMessageId,
      turnRunId: params.turnRunId,
      displayId,
      eventId,
      scopeKey: params.notificationScope || null,
      aiId: params.aiId,
      aiName: params.aiName,
      message: truncateNotificationBody(params.message),
      aiAvatar: normalizeNotificationAvatarUri(params.aiAvatar) || null,
      sessionId: params.sessionId || null,
      deliveryKind: params.deliveryKind || 'passive',
      triggerSource: params.triggerSource || null,
      relatedEntityId: params.relatedEntityId || null,
      conversationKey,
      conversationTitle: params.conversationTitle || null,
      conversationKind: params.conversationKind || null,
      groupId: params.groupId || null,
      senderName: params.senderName || null,
      senderAvatar: normalizeNotificationAvatarUri(params.senderAvatar) || null,
    });
    if (!result.posted) {
      console.warn('[Notification] Android 原生消息通知未发送。', result);
    }
    return result.posted;
  } catch (error) {
    console.warn('[Notification] Android 原生消息通知发送失败。', error);
    return false;
  }
}

export async function sendAIIncomingCallNotification(
  params: SendAIIncomingCallNotificationParams
): Promise<boolean> {
  const displayId = `kimiphone-call-${params.callId}`;
  try {
    const result = await postIncomingCallNotification({
      displayId,
      eventId: params.callId,
      callId: params.callId,
      aiId: params.aiId,
      aiName: params.aiName,
      aiAvatar: normalizeNotificationAvatarUri(params.aiAvatar) || null,
      sessionId: params.sessionId,
      body: truncateNotificationBody(params.openingLine),
      ringtoneUri: params.ringtoneUri,
      ringDurationMs: params.ringDurationMs,
    });
    if (!result.posted) {
      console.warn('[Notification] Android 原生来电通知未发送。', result);
    }
    return result.posted;
  } catch (error) {
    console.warn('[Notification] Android 原生来电通知发送失败。', error);
    return false;
  }
}

/** 按会话聚合 key 撤销通知：direct = `ai:<aiId>`，group = `group:<groupId>`；缺省撤销全部。 */
export async function dismissConversationNotifications(conversationKey?: string | null): Promise<void> {
  await cancelConversationNotifications(conversationKey || null);
}

export async function dismissReadMessageNotifications(params: {
  sessionId: string;
  messageIds: readonly string[];
  clientMessageIds: readonly string[];
}): Promise<void> {
  await cancelReadMessageNotifications(params.sessionId, [...params.messageIds], [...params.clientMessageIds]);
}

export async function dismissAIIncomingCallNotification(callId: string): Promise<void> {
  await cancelIncomingCallNotification(callId);
}

/** Together Listening active 真值的 Android system presentation transport。 */
export async function upsertTogetherListeningSystemPresentation(
  state: PostTogetherListeningPresentationRequest,
): Promise<NativeTogetherListeningPresentationResult> {
  return upsertNativeTogetherListeningPresentation({
    ...state,
    aiAvatar: normalizeNotificationAvatarUri(state.aiAvatar) || null,
  });
}

export function cancelTogetherListeningSystemPresentation(activityId?: string): Promise<void> {
  return cancelNativeTogetherListeningPresentation(activityId || null);
}

export function addNotificationResponseListener(
  listener: (data: AppNotificationData | null) => void
): NotificationSubscription {
  const subscription = addNativeNotificationResponseListener((response) => {
    listener(normalizeNotificationData(response));
  });
  return { remove: () => subscription.remove() };
}

export async function consumePendingNotificationResponses(): Promise<AppNotificationData[]> {
  const responses = await consumeNativePendingResponses();
  return responses
    .map(normalizeNotificationData)
    .filter((response): response is AppNotificationData => response !== null);
}

export function getNotificationDiagnostics(
  scopeKey?: string | null
): Promise<NativeNotificationDiagnostics> {
  return getNativeNotificationDiagnostics(scopeKey || null);
}

/** 显式用户操作入口：Android 14+ 打开 FSI 系统授权页；不得在启动时自动调用。 */
export function openFullScreenIntentSettings(): Promise<boolean> {
  return openNativeFullScreenIntentSettings();
}

/** 显式用户操作入口：打开来电 Channel 系统通知设置页（检查 OEM 锁屏/悬浮通知开关）；不得自动调用。 */
export function openIncomingCallNotificationSettings(): Promise<boolean> {
  return openNativeIncomingCallNotificationSettings();
}

/** 恢复出厂：取消全部已展示通知并清空原生通知状态（不删 Channel、不改权限）。 */
export function clearNativeNotificationDataForFactoryReset(): Promise<void> {
  return clearNativeNotificationData();
}
