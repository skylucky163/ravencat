/** 定义应用层访问悬浮层原生能力所需的窄端口。 */

export type ReplyPreviewStatus = 'pending' | 'reply' | 'error';

export interface ReplyPreview {
  text: string;
  status?: ReplyPreviewStatus;
  correlationId?: string;
  requestCorrelationId?: string;
  sessionId?: string;
  messageId?: number;
}

/** Host 组合后的有限聊天投影；Floating Layer 不读取 Chat 仓储。 */
export interface FloatingConversationPreview {
  sessionId: string | null;
  messages: {
    messageId: number;
    clientMessageId: string | null;
    role: 'user' | 'assistant';
    text: string;
  }[];
}

export type TargetPreviewStatus = 'ready' | 'disabled' | 'error';

export interface TargetPreview {
  title: string;
  subtitle?: string;
  status?: TargetPreviewStatus;
}

export interface SendMessageEvent {
  text: string;
  correlationId: string;
  source: 'floating-panel';
}

export interface CaptureScreenRequestEvent {
  text: string;
  correlationId: string;
  source: 'floating-panel-shot';
}

/** Together Listening 已提交真值投到悬浮面板所需的最小事实。 */
export interface FloatingTogetherListeningPresentation {
  activityId: string;
  hostAiId: string;
  chatSessionId: string;
  activatedAtEpochMs: number;
  aiName: string;
  aiAvatar: string | null;
  userName: string;
  userAvatar: string | null;
}

/** 原生聊天页实际可见的持久消息；只回报当前 viewport，不包含缓存或发送状态。 */
export interface ConversationDisplayedEvent {
  sessionId: string;
  messageIds: string[];
  clientMessageIds: string[];
}

export interface BatteryOptimizationState {
  ignoringBatteryOptimizations: boolean;
}

export interface EventSubscription {
  remove(): void;
}

export interface FloatingLayerPort {
  addConversationRefreshListener(listener: () => void): EventSubscription;
  updateConversationPreview(preview: FloatingConversationPreview): Promise<void>;
  addCaptureScreenRequestListener(
    listener: (event: CaptureScreenRequestEvent) => void
  ): EventSubscription;
  addConversationDisplayedListener(
    listener: (event: ConversationDisplayedEvent) => void
  ): EventSubscription;
  addSendMessageListener(
    listener: (event: SendMessageEvent) => void
  ): EventSubscription;
  getBatteryOptimizationState(): Promise<BatteryOptimizationState>;
  isFloatingLayerRunning(): Promise<boolean>;
  /** Host 的 AppState 真值；只改变窗口可见性，不启停 Overlay Service。 */
  setAppForeground(active: boolean): Promise<void>;
  isOverlayPermissionGranted(): Promise<boolean>;
  openOverlayPermissionSettings(): Promise<void>;
  openBatteryOptimizationSettings(): Promise<void>;
  recordFloatingMessageTaskCompletion(payload: {
    correlationId: string;
    succeeded: boolean;
    error?: string | null;
  }): Promise<void>;
  restoreAfterScreenCapture(): Promise<void>;
  completeScreenCaptureVisibility(payload: {
    correlationId: string;
    succeeded: boolean;
    screenshotUri?: string;
  }): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  startFloatingLayer(): Promise<void>;
  stopFloatingLayer(): Promise<void>;
  updateTogetherListeningPresentation(
    presentation: FloatingTogetherListeningPresentation
  ): Promise<void>;
  clearTogetherListeningPresentation(activityId?: string): Promise<void>;
  /** 返回 true 表示控制器已真实展示 reply 预览；否则交付层仍应发送系统通知。 */
  updateReplyPreview(preview: ReplyPreview): Promise<boolean>;
  updateTargetPreview(preview: TargetPreview): Promise<void>;
}
