import {
  EventEmitter,
  NativeModule,
  requireNativeModule,
} from 'expo';

export type RavenCatReplyPreviewStatus = 'pending' | 'reply' | 'error';

export type RavenCatReplyPreview = {
  text: string;
  status?: RavenCatReplyPreviewStatus;
  correlationId?: string;
  sessionId?: string;
  messageId?: number;
};

export type RavenCatTargetPreviewStatus = 'ready' | 'disabled' | 'error';

export type RavenCatTargetPreview = {
  title: string;
  subtitle?: string;
  status?: RavenCatTargetPreviewStatus;
};

/** Floating Layer 只消费的 Together Listening 外部 projection facts。 */
export type RavenCatTogetherListeningPresentation = {
  activityId: string;
  hostAiId: string;
  chatSessionId: string;
  activatedAtEpochMs: number;
  aiName: string;
  aiAvatar: string | null;
  userName: string;
  userAvatar: string | null;
};

export type RavenCatSendMessageEvent = {
  text: string;
  correlationId: string;
  source: 'floating-panel';
};

export type RavenCatCaptureScreenRequestEvent = {
  text: string;
  correlationId: string;
  source: 'floating-panel-shot';
};

/** 原生聊天 viewport 实际展示的持久消息身份。 */
export type RavenCatConversationDisplayedEvent = {
  sessionId: string;
  messageIds: string[];
};

export type RavenCatCompanionWakeReason =
  | 'system_timer'
  | 'system_recovery'
  | 'system_battery'
  | 'scheduled_check_in'
  | 'memory_trigger'
  | 'task_reminder'
  | 'user_idle';

export type RavenCatCompanionWakeEvent = {
  wakeReason: RavenCatCompanionWakeReason;
  source:
    | 'companion-service'
    | 'companion-service-restart'
    | 'companion-service-pending'
    | 'alarm-manager'
    | 'work-manager';
  eventId: string;
  createdAtEpochMs: number;
  scheduleRevision?: number;
  hostAIId?: string | null;
  triggerKind?: 'ai_schedule' | null;
  expectedRemindAtEpochMs?: number | null;
  projectionToken?: string | null;
  deliveryEventId?: string | null;
};

/**
 * Companion 一次 wake 执行宿主的收口结果。
 *
 * `WORKER_STOPPED`：WorkManager 已中断本次 Worker（系统执行上限 / REPLACE / cancel），
 * 且 runner 未在取消宽限内回执终态。
 */
export type RavenCatCompanionExecutionOutcome =
  | 'COMPLETED'
  | 'START_REJECTED'
  | 'TIMED_OUT'
  | 'WORKER_STOPPED';

export type RavenCatAIScheduleDiagnostics = {
  device: {
    manufacturer: string;
    model: string;
    apiLevel: number;
    packageName: string;
    versionName: string;
    versionCode: number;
    deviceIdleMode: boolean;
    powerSaveMode: boolean;
    batteryOptimizationExempt: boolean;
  };
  companionSchedulingEnabled: boolean;
  events: {
    deliveryEventId: string;
    stage: string;
    recordedAtEpochMs: number;
    expectedRemindAtEpochMs: number | null;
    outcome: string | null;
    deviceIdleMode: boolean;
    powerSaveMode: boolean;
    batteryOptimizationExempt: boolean;
  }[];
};

export type RavenCatNativeHealth = {
  floatingServiceRunning: boolean;
  /** Overlay FGS：owner 是 Floating Interaction，不代表 Companion 在运行。 */
  overlayForegroundServiceRunning: boolean;
  /** 应用总开关的持续后台保障，独立于日程是否正在执行。 */
  applicationBackgroundRunning: boolean;
  visibleLivenessIndicatorRunning: boolean;
  companionRuntimeRunning: boolean;
  companionSchedulerActive: boolean;
  companionSchedulerDriver: RavenCatCompanionSchedulerDriver;
  companionWakeTimerActive: boolean;
  bridgeConnected: boolean;
  eventListenerConnected: boolean;
  companionWakeScheduled: boolean;
  nextCompanionWakeAtEpochMs: number;
  lastNativeWakeAtEpochMs: number;
  lastNativeWakeReason?: RavenCatCompanionWakeReason | null;
  lastNativeWakeSource?: RavenCatCompanionWakeEvent['source'] | null;
  lastNativeWakeBridgeConnected: boolean;
  lastHeadlessTaskStartAtEpochMs: number;
  lastHeadlessTaskStartAccepted: boolean;
  lastHeadlessTaskStartError?: string | null;
  lastRunnerCompletionAtEpochMs: number;
  /** 最近一次 runner 终态回执的 delivery identity（AI Schedule 为 `scheduleId@projectionToken`）。 */
  lastRunnerCompletionDeliveryEventId?: string | null;
  lastRunnerCompletionSucceeded: boolean;
  lastRunnerCompletionError?: string | null;
  lastCompanionExecutionAtEpochMs: number;
  lastCompanionExecutionOutcome?: RavenCatCompanionExecutionOutcome | null;
  lastCompanionExecutionDeliveryEventId?: string | null;
  /** 收口时执行期前台是否真实建立（而不是「start 请求已投递」）。 */
  lastCompanionExecutionForegroundRunning: boolean;
  pendingNativeWakeCount: number;
  lastPendingWakeAtEpochMs: number;
};


export type RavenCatCompanionSchedulerDriver =
  | 'alarm_manager+one_time_work'
  | 'one_time_work'
  | 'work_manager'
  | 'none';

export type RavenCatBatteryOptimizationState = {
  ignoringBatteryOptimizations: boolean;
};

export type RavenCatBubbleSkin = {
  id: string;
  name: string;
  source: 'builtin' | 'user';
  mimeType: 'image/svg+xml' | 'image/png' | 'image/jpeg';
  uri?: string | null;
  dockedUri?: string | null;
  dockedMimeType?: RavenCatBubbleSkin['mimeType'] | null;
  hasDockedAsset: boolean;
  selected: boolean;
  sizeDp: number;
};

export type ImportRavenCatBubbleSkinPayload = {
  uri: string;
  fileName: string;
  mimeType?: string | null;
  name: string;
};

export type RavenCatBubbleSkinBackupSource = {
  rootUri: string;
  settingsJson: string;
};

export type UpdateRavenCatBubbleSkinImagePayload = {
  id: string;
  form: 'normal' | 'docked';
  uri: string;
  fileName: string;
  mimeType?: string | null;
};


export type RavenCatAIScheduleTriggerRequest = {
  scheduleId: string;
  ownerAIId: string;
  remindAtEpochMs: number;
  projectionToken: string;
};

export type RavenCatAIScheduleTriggerProjection = {
  scheduleId: string;
  ownerAIId: string;
  expectedRemindAtEpochMs: number;
  projectionToken: string;
};

export type RavenCatEventSubscription = {
  remove(): void;
};

type RavenCatFloatingLayerEvents = {
  onConversationRefresh: () => void;
  onSendMessage: (event: RavenCatSendMessageEvent) => void;
  onCaptureScreenRequest: (event: RavenCatCaptureScreenRequestEvent) => void;
  onCompanionWake: (event: RavenCatCompanionWakeEvent) => void;
  onCompanionExecutionCancel: (event: RavenCatCompanionExecutionCancelEvent) => void;
  onConversationDisplayed: (event: RavenCatConversationDisplayedEvent) => void;
};

declare class RavenCatFloatingLayerModule extends NativeModule {
  updateConversationPreview(payload: RavenCatConversationPreview): Promise<void>;
  ping(): Promise<string>;
  isOverlayPermissionGranted(): Promise<boolean>;
  openOverlayPermissionSettings(): Promise<void>;
  getBatteryOptimizationState(): Promise<RavenCatBatteryOptimizationState>;
  openBatteryOptimizationSettings(): Promise<void>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  getBubbleSkins(): Promise<RavenCatBubbleSkin[]>;
  setBubbleSize(id: string, sizeDp: number): Promise<RavenCatBubbleSkin>;
  importBubbleSkin(payload: ImportRavenCatBubbleSkinPayload): Promise<RavenCatBubbleSkin>;
  updateBubbleSkinImage(payload: UpdateRavenCatBubbleSkinImagePayload): Promise<RavenCatBubbleSkin>;
  renameBubbleSkin(payload: { id: string; name: string }): Promise<RavenCatBubbleSkin>;
  deleteBubbleSkin(id: string): Promise<void>;
  selectBubbleSkin(id: string): Promise<RavenCatBubbleSkin>;
  getBubbleSkinBackupSource(): Promise<RavenCatBubbleSkinBackupSource>;
  restoreBubbleSkinBackupSettings(settingsJson: string): Promise<void>;
  validateBubbleSkinBackupSettings(settingsJson: string, rootUri: string): Promise<void>;
  startFloatingLayer(): Promise<void>;
  stopFloatingLayer(): Promise<void>;
  setAppForeground(active: boolean): Promise<void>;
  isFloatingLayerRunning(): Promise<boolean>;
  getNativeHealth(): Promise<RavenCatNativeHealth>;
  getAIScheduleDiagnostics(): Promise<RavenCatAIScheduleDiagnostics>;
  clearNativeDataForFactoryReset(): Promise<void>;
  setCompanionSchedulingEnabled(enabled: boolean): Promise<void>;
  scheduleAIScheduleTrigger(
    payload: RavenCatAIScheduleTriggerRequest,
  ): Promise<RavenCatAIScheduleTriggerProjection>;
  cancelAIScheduleTrigger(scheduleId: string): Promise<void>;
  listAIScheduleTriggerProjections(): Promise<RavenCatAIScheduleTriggerProjection[]>;
  recordCompanionRunnerCompletion(payload: {
    deliveryEventId: string;
    succeeded: boolean;
    error?: string | null;
  }): Promise<void>;
  consumeCompanionExecutionCancellation(deliveryEventId: string): Promise<boolean>;
  recordFloatingMessageTaskCompletion(payload: {
    correlationId: string;
    succeeded: boolean;
    error?: string | null;
  }): Promise<void>;
  expand(): Promise<void>;
  collapse(): Promise<void>;
  restoreAfterScreenCapture(): Promise<void>;
  completeScreenCaptureVisibility(payload: {
    correlationId: string;
    succeeded: boolean;
    screenshotUri?: string;
  }): Promise<boolean>;
  updateReplyPreview(payload: RavenCatReplyPreview): Promise<boolean>;
  clearReplyPreview(): Promise<void>;
  updateTargetPreview(payload: RavenCatTargetPreview): Promise<void>;
  clearTargetPreview(): Promise<void>;
  updateTogetherListeningPresentation(
    payload: RavenCatTogetherListeningPresentation,
  ): Promise<void>;
  clearTogetherListeningPresentation(activityId?: string | null): Promise<void>;
}

const RavenCatFloatingLayer = requireNativeModule<RavenCatFloatingLayerModule>(
  'RavenCatFloatingLayer',
);

const emitter = new EventEmitter<RavenCatFloatingLayerEvents>(RavenCatFloatingLayer);

export function ping(): Promise<string> {
  return RavenCatFloatingLayer.ping();
}

export function isOverlayPermissionGranted(): Promise<boolean> {
  return RavenCatFloatingLayer.isOverlayPermissionGranted();
}

export function openOverlayPermissionSettings(): Promise<void> {
  return RavenCatFloatingLayer.openOverlayPermissionSettings();
}

export function getBatteryOptimizationState(): Promise<RavenCatBatteryOptimizationState> {
  return RavenCatFloatingLayer.getBatteryOptimizationState();
}

export function openBatteryOptimizationSettings(): Promise<void> {
  return RavenCatFloatingLayer.openBatteryOptimizationSettings();
}

export function requestIgnoreBatteryOptimizations(): Promise<void> {
  return RavenCatFloatingLayer.requestIgnoreBatteryOptimizations();
}

export function getBubbleSkins(): Promise<RavenCatBubbleSkin[]> {
  return RavenCatFloatingLayer.getBubbleSkins();
}

export function setBubbleSize(id: string, sizeDp: number): Promise<RavenCatBubbleSkin> {
  return RavenCatFloatingLayer.setBubbleSize(id, sizeDp);
}

export function importBubbleSkin(
  payload: ImportRavenCatBubbleSkinPayload
): Promise<RavenCatBubbleSkin> {
  return RavenCatFloatingLayer.importBubbleSkin(payload);
}

export function renameBubbleSkin(
  payload: { id: string; name: string }
): Promise<RavenCatBubbleSkin> {
  return RavenCatFloatingLayer.renameBubbleSkin(payload);
}

export function updateBubbleSkinImage(payload: UpdateRavenCatBubbleSkinImagePayload): Promise<RavenCatBubbleSkin> {
  return RavenCatFloatingLayer.updateBubbleSkinImage(payload);
}

export function deleteBubbleSkin(id: string): Promise<void> {
  return RavenCatFloatingLayer.deleteBubbleSkin(id);
}

export function selectBubbleSkin(id: string): Promise<RavenCatBubbleSkin> {
  return RavenCatFloatingLayer.selectBubbleSkin(id);
}

export function getBubbleSkinBackupSource(): Promise<RavenCatBubbleSkinBackupSource> {
  return RavenCatFloatingLayer.getBubbleSkinBackupSource();
}

export function restoreBubbleSkinBackupSettings(settingsJson: string): Promise<void> {
  return RavenCatFloatingLayer.restoreBubbleSkinBackupSettings(settingsJson);
}

export function validateBubbleSkinBackupSettings(
  settingsJson: string,
  rootUri: string,
): Promise<void> {
  return RavenCatFloatingLayer.validateBubbleSkinBackupSettings(settingsJson, rootUri);
}

export function startFloatingLayer(): Promise<void> {
  return RavenCatFloatingLayer.startFloatingLayer();
}

export function stopFloatingLayer(): Promise<void> {
  return RavenCatFloatingLayer.stopFloatingLayer();
}

/** Host 的 AppState 真值只控制 native overlay 可见性，不控制 Service 生命周期。 */
export function setAppForeground(active: boolean): Promise<void> {
  return RavenCatFloatingLayer.setAppForeground(active);
}

export function isFloatingLayerRunning(): Promise<boolean> {
  return RavenCatFloatingLayer.isFloatingLayerRunning();
}

export function getNativeHealth(): Promise<RavenCatNativeHealth> {
  return RavenCatFloatingLayer.getNativeHealth();
}

export function getAIScheduleDiagnostics(): Promise<RavenCatAIScheduleDiagnostics> {
  return RavenCatFloatingLayer.getAIScheduleDiagnostics();
}

/** 恢复出厂：清空全部 RavenCat 原生持久化状态，不暴露任何原生存储命名。 */
export function clearRavenCatNativeDataForFactoryReset(): Promise<void> {
  return RavenCatFloatingLayer.clearNativeDataForFactoryReset();
}




export function scheduleAIScheduleTrigger(
  payload: RavenCatAIScheduleTriggerRequest,
): Promise<RavenCatAIScheduleTriggerProjection> {
  return RavenCatFloatingLayer.scheduleAIScheduleTrigger(payload);
}

export function cancelAIScheduleTrigger(scheduleId: string): Promise<void> {
  return RavenCatFloatingLayer.cancelAIScheduleTrigger(scheduleId);
}

export function listAIScheduleTriggerProjections(): Promise<RavenCatAIScheduleTriggerProjection[]> {
  return RavenCatFloatingLayer.listAIScheduleTriggerProjections();
}

export function recordCompanionRunnerCompletion(payload: {
  deliveryEventId: string;
  succeeded: boolean;
  error?: string | null;
}): Promise<void> {
  return RavenCatFloatingLayer.recordCompanionRunnerCompletion(payload);
}

/**
 * Headless runner 启动后主动消费本次 delivery 的取消标记（一次性）。
 *
 * 取消事实由 native 拥有：runner 可能晚于取消请求才注册自己的 `AbortController`，
 * 那时取消事件叫不到任何 controller，只能靠这里追平。
 */
export function consumeCompanionExecutionCancellation(deliveryEventId: string): Promise<boolean> {
  return RavenCatFloatingLayer.consumeCompanionExecutionCancellation(deliveryEventId);
}

export function recordFloatingMessageTaskCompletion(payload: {
  correlationId: string;
  succeeded: boolean;
  error?: string | null;
}): Promise<void> {
  return RavenCatFloatingLayer.recordFloatingMessageTaskCompletion(payload);
}

export function expand(): Promise<void> {
  return RavenCatFloatingLayer.expand();
}

export function collapse(): Promise<void> {
  return RavenCatFloatingLayer.collapse();
}

export function restoreAfterScreenCapture(): Promise<void> {
  return RavenCatFloatingLayer.restoreAfterScreenCapture();
}

export function completeScreenCaptureVisibility(payload: {
  correlationId: string;
  succeeded: boolean;
  screenshotUri?: string;
}): Promise<boolean> {
  return RavenCatFloatingLayer.completeScreenCaptureVisibility(payload);
}

export function updateReplyPreview(payload: RavenCatReplyPreview): Promise<boolean> {
  return RavenCatFloatingLayer.updateReplyPreview(payload);
}

export type RavenCatConversationPreview = {
  sessionId: string | null;
  messages: { messageId: number; clientMessageId: string | null; role: 'user' | 'assistant'; text: string }[];
};

export function updateConversationPreview(payload: RavenCatConversationPreview): Promise<void> {
  return RavenCatFloatingLayer.updateConversationPreview(payload);
}

export function addConversationRefreshListener(listener: () => void): RavenCatEventSubscription {
  return emitter.addListener('onConversationRefresh', listener);
}

export function clearReplyPreview(): Promise<void> {
  return RavenCatFloatingLayer.clearReplyPreview();
}

export function updateTargetPreview(payload: RavenCatTargetPreview): Promise<void> {
  return RavenCatFloatingLayer.updateTargetPreview(payload);
}

export function clearTargetPreview(): Promise<void> {
  return RavenCatFloatingLayer.clearTargetPreview();
}

export function updateTogetherListeningPresentation(
  payload: RavenCatTogetherListeningPresentation,
): Promise<void> {
  return RavenCatFloatingLayer.updateTogetherListeningPresentation(payload);
}

export function clearTogetherListeningPresentation(activityId?: string | null): Promise<void> {
  return RavenCatFloatingLayer.clearTogetherListeningPresentation(activityId ?? null);
}

export function addSendMessageListener(
  listener: (event: RavenCatSendMessageEvent) => void,
): RavenCatEventSubscription {
  return emitter.addListener('onSendMessage', listener);
}

export function addCaptureScreenRequestListener(
  listener: (event: RavenCatCaptureScreenRequestEvent) => void,
): RavenCatEventSubscription {
  return emitter.addListener('onCaptureScreenRequest', listener);
}

export function addCompanionWakeListener(
  listener: (event: RavenCatCompanionWakeEvent) => void,
): RavenCatEventSubscription {
  return emitter.addListener('onCompanionWake', listener);
}

/** execution host 超时收口时向 runner 请求取消当前 delivery 的事件。 */
export type RavenCatCompanionExecutionCancelEvent = {
  deliveryEventId: string;
};

export function addCompanionExecutionCancelListener(
  listener: (event: RavenCatCompanionExecutionCancelEvent) => void,
): RavenCatEventSubscription {
  return emitter.addListener('onCompanionExecutionCancel', listener);
}

export function addConversationDisplayedListener(
  listener: (event: RavenCatConversationDisplayedEvent) => void,
): RavenCatEventSubscription {
  return emitter.addListener('onConversationDisplayed', listener);
}

export default RavenCatFloatingLayer;

export function setCompanionSchedulingEnabled(enabled: boolean): Promise<void> {
  return RavenCatFloatingLayer.setCompanionSchedulingEnabled(enabled);
}
