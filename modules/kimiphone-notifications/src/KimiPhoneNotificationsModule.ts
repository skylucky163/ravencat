/** 统一封装 Android 系统通知的发送、撤销、权限与点击响应。 */
import {
  EventEmitter,
  NativeModule,
  requireNativeModule,
  type EventSubscription,
} from 'expo-modules-core';

export type NativeNotificationPostStatus =
  | 'posted'
  | 'permission_denied'
  | 'notifications_disabled'
  | 'channel_disabled'
  | 'suppressed'
  | 'failed';

export interface NativeNotificationPostResult {
  status: NativeNotificationPostStatus;
  posted: boolean;
  displayId: string;
  error?: string | null;
}

export interface NativeNotificationPermissionStatus {
  postNotificationsGranted: boolean;
  notificationsEnabled: boolean;
  messageChannelImportance: number;
  incomingCallChannelImportance: number;
  /** 实际来电 Channel 的锁屏可见性（VISIBILITY_PUBLIC=1 / PRIVATE=0 / SECRET=-1 / NO_OVERRIDE=-1000 跟随系统默认）；Channel 缺失时为 null */
  incomingCallChannelLockscreenVisibility: number | null;
  /** Android 14+ 用户可关闭 full-screen intent；false 时来电退化为 CallStyle heads-up/锁屏通知 */
  fullScreenIntentAllowed: boolean;
}

export interface NativeNotificationDiagnostics extends NativeNotificationPermissionStatus {
  channelId: string;
  lastNotificationAttemptAtEpochMs: number;
  lastNotificationShown: boolean;
  lastNotificationAIId?: string | null;
  lastNotificationSessionId?: string | null;
  lastNotificationError?: string | null;
  /** 发布时刻的系统能力快照（仅来电等显式记录的 scope 有值） */
  lastNotificationFullScreenIntentAllowed?: boolean | null;
  lastNotificationIncomingCallChannelImportance?: number | null;
  lastNotificationIncomingCallChannelLockscreenVisibility?: number | null;
  lastNotificationNotificationsEnabled?: boolean | null;
}

export interface NativeNotificationRouteData {
  type: 'ai-message' | 'ai-message-summary' | 'ai-incoming-call' | 'together-listening';
  aiId?: string | null;
  aiName?: string | null;
  sessionId?: string | null;
  callId?: string | null;
  deliveryKind?: 'passive' | 'proactive';
  triggerSource?: string | null;
  relatedEntityId?: string | null;
  notificationId?: string | null;
  latestAiId?: string | null;
  lastMessageAt?: number;
  /** 会话聚合 key：direct = `ai:<aiId>`；group = `group:<groupId>` */
  conversationKey?: string | null;
  conversationKind?: 'direct' | 'group' | null;
  groupId?: string | null;
  activityId?: string | null;
  hostAiId?: string | null;
  chatSessionId?: string | null;
}

export interface NativeNotificationResponse extends NativeNotificationRouteData {
  notificationAction?: 'open' | 'accept' | 'reject' | 'leave';
}

export interface PostConversationNotificationRequest {
  committedMessageId?: number;
  turnRunId?: string;
  /** 子通知 ID：`kimiphone-msg-<conversationKey>-<eventId>`，逐段唯一 */
  displayId: string;
  /** 子通知幂等键：同 eventId 重发更新同一条子通知；建议 `logicalMessageId:segmentIndex` */
  eventId: string;
  scopeKey?: string | null;
  aiId: string;
  aiName: string;
  message: string;
  aiAvatar?: string | null;
  sessionId?: string | null;
  deliveryKind: 'passive' | 'proactive';
  triggerSource?: string | null;
  relatedEntityId?: string | null;
  /** 会话聚合 key：direct = `ai:<aiId>`；group = `group:<groupId>`；缺省按 aiId 计算 */
  conversationKey?: string | null;
  /** 通知标题：单聊 = AI 名；群聊 = 群名 */
  conversationTitle?: string | null;
  conversationKind?: 'direct' | 'group' | null;
  groupId?: string | null;
  /** 群通知 InboxStyle 行的发送者名 */
  senderName?: string | null;
  senderAvatar?: string | null;
}

export interface PostIncomingCallNotificationRequest {
  ringtoneUri: string | null;
  ringDurationMs: number;
  displayId: string;
  eventId: string;
  callId: string;
  aiId: string;
  aiName: string;
  aiAvatar?: string | null;
  sessionId: string;
  body: string;
}

export interface PostTogetherListeningPresentationRequest {
  activityId: string;
  hostAiId: string;
  chatSessionId: string;
  activatedAtEpochMs: number;
  aiName: string;
  aiAvatar?: string | null;
}

export interface NativeTogetherListeningPresentationResult extends NativeNotificationPostResult {
  postNotificationsGranted: boolean;
  notificationsEnabled: boolean;
  dismissedForCurrentActivity: boolean;
  channelImportance: number;
  lastProjectionError?: string | null;
}

export interface NativeMessageArrivalSnapshot {
  revision: number;
  pendingMessageIds: number[];
  pendingSessionIds: string[];
}

export interface NativeMessageArrivalObserver {
  sessionId: string;
  aiId?: string | null;
  aiName?: string | null;
  conversationKind?: 'direct' | 'group';
  groupId?: string | null;
}

export interface NativeMessageArrivalChanged {
  snapshot: NativeMessageArrivalSnapshot;
  observer: NativeMessageArrivalObserver;
}

type KimiPhoneNotificationEvents = {
  onNotificationResponse: (response: NativeNotificationResponse) => void;
  onMessageArrivalChanged: (event: NativeMessageArrivalChanged) => void;
};

declare class KimiPhoneNotificationsNativeModule extends NativeModule<KimiPhoneNotificationEvents> {
  awaitTurnDisplayArrival(runId: string, conversationKey: string): Promise<boolean>;
  setTurnDisplayOpen(runIds: string[], open: boolean): Promise<void>;
  setTurnDisplayActive(runId: string, active: boolean): Promise<void>;
  getMessageArrivalSnapshot(): Promise<NativeMessageArrivalSnapshot>;
  beginMessageArrival(observer: NativeMessageArrivalObserver, messageIds: number[]): Promise<NativeMessageArrivalSnapshot>;
  awaitMessageArrival(conversationKey: string, messageId: number): Promise<NativeMessageArrivalSnapshot>;
  finishMessageArrival(messageIds: number[]): Promise<NativeMessageArrivalSnapshot>;
  requestNotificationPermission(): Promise<unknown>;
  getNotificationPermissionStatus(): Promise<NativeNotificationPermissionStatus>;
  postConversationNotification(
    request: PostConversationNotificationRequest
  ): Promise<NativeNotificationPostResult>;
  postIncomingCallNotification(
    request: PostIncomingCallNotificationRequest
  ): Promise<NativeNotificationPostResult>;
  upsertTogetherListeningPresentation(
    request: PostTogetherListeningPresentationRequest
  ): Promise<NativeTogetherListeningPresentationResult>;
  cancelTogetherListeningPresentation(activityId?: string | null): Promise<void>;
  getTogetherListeningPresentationDiagnostics(): Promise<NativeTogetherListeningPresentationResult>;
  /** 按会话聚合 key 撤销：direct = `ai:<aiId>`，group = `group:<groupId>`；null 撤销全部 */
  cancelConversationNotifications(conversationKey?: string | null): Promise<void>;
  cancelReadMessageNotifications(sessionId: string, messageIds: string[], clientMessageIds: string[]): Promise<void>;
  cancelIncomingCallNotification(callId: string): Promise<void>;
  leaveCallScreen(callId: string): Promise<void>;
  consumePendingNotificationResponses(): Promise<NativeNotificationResponse[]>;
  getNotificationDiagnostics(scopeKey?: string | null): Promise<NativeNotificationDiagnostics>;
  /** 显式用户操作：Android 14+ 打开本应用 FSI 系统授权页；API < 34 返回 false */
  openFullScreenIntentSettings(): Promise<boolean>;
  /** 显式用户操作：打开来电 Channel 的系统通知设置页（检查 OEM 锁屏/悬浮通知开关）；不得自动调用 */
  openIncomingCallNotificationSettings(): Promise<boolean>;
  clearNativeNotificationDataForFactoryReset(): Promise<void>;
}

const nativeModule = requireNativeModule<KimiPhoneNotificationsNativeModule>(
  'KimiPhoneNotifications'
);
const emitter = new EventEmitter<KimiPhoneNotificationEvents>(nativeModule);

export const getMessageArrivalSnapshot = () => nativeModule.getMessageArrivalSnapshot();
export const awaitTurnDisplayArrival = (runId: string, conversationKey: string) => nativeModule.awaitTurnDisplayArrival(runId, conversationKey);
export const setTurnDisplayOpen = (runIds: string[], open: boolean) => nativeModule.setTurnDisplayOpen(runIds, open);
export const setTurnDisplayActive = (runId: string, active: boolean) => nativeModule.setTurnDisplayActive(runId, active);
export const beginMessageArrival = (observer: NativeMessageArrivalObserver, messageIds: number[]) =>
  nativeModule.beginMessageArrival(observer, messageIds);
export const awaitMessageArrival = (conversationKey: string, messageId: number) =>
  nativeModule.awaitMessageArrival(conversationKey, messageId);
export const finishMessageArrival = (messageIds: number[]) => nativeModule.finishMessageArrival(messageIds);
export const addMessageArrivalListener = (listener: (event: NativeMessageArrivalChanged) => void): EventSubscription =>
  emitter.addListener('onMessageArrivalChanged', listener);

export async function requestNotificationPermission(): Promise<NativeNotificationPermissionStatus> {
  await nativeModule.requestNotificationPermission();
  return nativeModule.getNotificationPermissionStatus();
}

export function getNotificationPermissionStatus(): Promise<NativeNotificationPermissionStatus> {
  return nativeModule.getNotificationPermissionStatus();
}

export function postConversationNotification(
  request: PostConversationNotificationRequest
): Promise<NativeNotificationPostResult> {
  return nativeModule.postConversationNotification(request);
}

export function postIncomingCallNotification(
  request: PostIncomingCallNotificationRequest
): Promise<NativeNotificationPostResult> {
  return nativeModule.postIncomingCallNotification(request);
}

export function upsertTogetherListeningPresentation(
  request: PostTogetherListeningPresentationRequest
): Promise<NativeTogetherListeningPresentationResult> {
  return nativeModule.upsertTogetherListeningPresentation(request);
}

export function cancelTogetherListeningPresentation(activityId?: string | null): Promise<void> {
  return nativeModule.cancelTogetherListeningPresentation(activityId ?? null);
}

export function getTogetherListeningPresentationDiagnostics(
): Promise<NativeTogetherListeningPresentationResult> {
  return nativeModule.getTogetherListeningPresentationDiagnostics();
}

/** 按会话聚合 key 撤销：direct = `ai:<aiId>`，group = `group:<groupId>`；缺省撤销全部 */
export function cancelConversationNotifications(conversationKey?: string | null): Promise<void> {
  return nativeModule.cancelConversationNotifications(conversationKey ?? null);
}

export function cancelReadMessageNotifications(sessionId: string, messageIds: string[], clientMessageIds: string[]): Promise<void> {
  return nativeModule.cancelReadMessageNotifications(sessionId, messageIds, clientMessageIds);
}

export function cancelIncomingCallNotification(callId: string): Promise<void> {
  return nativeModule.cancelIncomingCallNotification(callId);
}

/** 按本次展示的来源退出；App 外进入时先退回原任务，媒体清理继续执行。 */
export function leaveCallScreen(callId: string): Promise<void> {
  return nativeModule.leaveCallScreen(callId);
}

export function consumePendingNotificationResponses(): Promise<NativeNotificationResponse[]> {
  return nativeModule.consumePendingNotificationResponses();
}

export function getNotificationDiagnostics(
  scopeKey?: string | null
): Promise<NativeNotificationDiagnostics> {
  return nativeModule.getNotificationDiagnostics(scopeKey ?? null);
}

/** 显式用户操作：Android 14+ 打开本应用 FSI 系统授权页；不得自动调用。 */
export function openFullScreenIntentSettings(): Promise<boolean> {
  return nativeModule.openFullScreenIntentSettings();
}

/** 显式用户操作：打开来电 Channel 的系统通知设置页；不得自动调用，不更换 Channel ID。 */
export function openIncomingCallNotificationSettings(): Promise<boolean> {
  return nativeModule.openIncomingCallNotificationSettings();
}

/** 恢复出厂：取消全部已展示通知并清空原生通知状态（不删 Channel、不改权限）。 */
export function clearNativeNotificationDataForFactoryReset(): Promise<void> {
  return nativeModule.clearNativeNotificationDataForFactoryReset();
}

export function addNotificationResponseListener(
  listener: (response: NativeNotificationResponse) => void
): EventSubscription {
  return emitter.addListener('onNotificationResponse', listener);
}
