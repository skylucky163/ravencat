/** Companion 访问 RavenCat 原生调度与运行状态所需的窄端口。 */

export type CompanionWakeReason =
  | 'system_timer'
  | 'system_recovery'
  | 'system_battery'
  | 'scheduled_check_in'
  | 'memory_trigger'
  | 'task_reminder'
  | 'user_idle';

export type CompanionWakeSource =
  | 'companion-service'
  | 'companion-service-restart'
  | 'companion-service-pending'
  | 'alarm-manager'
  | 'work-manager';

export type CompanionSchedulerDriver =
  | 'alarm_manager+one_time_work'
  | 'one_time_work'
  | 'work_manager'
  | 'none';

export interface CompanionWakeEvent {
  wakeReason: CompanionWakeReason;
  source: CompanionWakeSource;
  eventId: string;
  createdAtEpochMs: number;
  scheduleRevision?: number;
  hostAIId?: string | null;
  triggerKind?: 'ai_schedule' | null;
  expectedRemindAtEpochMs?: number | null;
  projectionToken?: string | null;
  /** completion/delivery identity 为 `scheduleId@projectionToken`，与原始日程 ID 分开。 */
  deliveryEventId?: string | null;
}

/** 单条 AI Schedule 的 keyed native projection 请求。 */
export interface AIScheduleTriggerRequest {
  scheduleId: string;
  ownerAIId: string;
  remindAtEpochMs: number;
  projectionToken: string;
}

/** 单条 AI Schedule 的 keyed native projection 执行镜像（非业务真值）。 */
export interface AIScheduleTriggerProjection {
  scheduleId: string;
  ownerAIId: string;
  expectedRemindAtEpochMs: number;
  projectionToken: string;
}

/**
 * Companion 一次 wake 执行宿主的收口结果；不等于 wake 业务状态。
 *
 * `WORKER_STOPPED` 表示 WorkManager 已中断本次 Worker（系统执行上限 / REPLACE / cancel）
 * 且 runner 未在取消宽限内回执：与 `TIMED_OUT` 的区别是系统已经撤回执行权。
 */
export type CompanionExecutionOutcome =
  | 'COMPLETED'
  | 'START_REJECTED'
  | 'TIMED_OUT'
  | 'WORKER_STOPPED';

export interface CompanionNativeHealth {
  floatingServiceRunning: boolean;
  /** Overlay FGS 的 owner 是 Floating Interaction，不代表 Companion 正在运行。 */
  overlayForegroundServiceRunning: boolean;
  /** 应用总开关的持续后台保障，独立于日程是否正在执行。 */
  applicationBackgroundRunning: boolean;
  visibleLivenessIndicatorRunning: boolean;
  companionRuntimeRunning: boolean;
  companionSchedulerActive: boolean;
  companionSchedulerDriver: CompanionSchedulerDriver;
  companionWakeTimerActive: boolean;
  bridgeConnected: boolean;
  eventListenerConnected: boolean;
  companionWakeScheduled: boolean;
  nextCompanionWakeAtEpochMs: number;
  lastNativeWakeAtEpochMs: number;
  lastNativeWakeReason?: CompanionWakeReason | null;
  lastNativeWakeSource?: CompanionWakeSource | null;
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
  lastCompanionExecutionOutcome?: CompanionExecutionOutcome | null;
  lastCompanionExecutionDeliveryEventId?: string | null;
  /** 收口时执行期前台是否真实建立（而不是「start 请求已投递」）。 */
  lastCompanionExecutionForegroundRunning: boolean;
  pendingNativeWakeCount: number;
  lastPendingWakeAtEpochMs: number;
}

export interface CompanionScheduleDiagnostics {
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
  events: CompanionScheduleDiagnostic[];
}

/** 原生边界提供的有限阶段记录，不包含聊天、Prompt 或请求正文。 */
export interface CompanionScheduleDiagnostic {
  deliveryEventId: string;
  stage: string;
  recordedAtEpochMs: number;
  expectedRemindAtEpochMs: number | null;
  outcome: string | null;
  deviceIdleMode: boolean;
  powerSaveMode: boolean;
  batteryOptimizationExempt: boolean;
}

export interface CompanionNativeSubscription {
  remove(): void;
}

export interface CompanionNativePort {
  addCompanionWakeListener(
    listener: (event: CompanionWakeEvent) => void,
  ): CompanionNativeSubscription;
  /**
   * execution host 超时收口时请求 runner 取消当前 delivery。
   * JS 侧把它接到当前 autonomous run 的 AbortSignal 上。
   */
  addCompanionExecutionCancelListener(
    listener: (event: { deliveryEventId: string }) => void,
  ): CompanionNativeSubscription;
  /**
   * Headless runner 启动后主动消费本次 delivery 的取消标记（一次性）。
   *
   * 返回 true 表示取消早于 runner 注册，runner 必须立刻追平 abort。
   */
  consumeExecutionCancellation(deliveryEventId: string): Promise<boolean>;
  /** 恢复出厂：清空原生模块内的产品级持久化状态，不改变兼容存储标识。 */
  clearCompanionNativeDataForFactoryReset(): Promise<void>;
  getNativeHealth(): Promise<CompanionNativeHealth>;
  getAIScheduleDiagnostics(): Promise<CompanionScheduleDiagnostics>;
  setCompanionSchedulingEnabled(enabled: boolean): Promise<void>;
  /** 为一条 AI 日程建立 / 替换独立 keyed native projection。 */
  scheduleAIScheduleTrigger(
    request: AIScheduleTriggerRequest,
  ): Promise<AIScheduleTriggerProjection>;
  /** 取消指定 scheduleId 的 keyed native projection。 */
  cancelAIScheduleTrigger(scheduleId: string): Promise<void>;
  /** 读取全部 AI Schedule keyed native projections（供 reconcile 使用）。 */
  listAIScheduleTriggerProjections(): Promise<AIScheduleTriggerProjection[]>;
  /**
   * 回写 runner 终态。`deliveryEventId` 是 delivery identity（AI Schedule 为
   * `scheduleId@projectionToken`），必须原样回传派发侧的值，不能回传 resolved `eventId`。
   */
  recordRunnerCompletion(params: {
    deliveryEventId: string;
    succeeded: boolean;
    error?: string | null;
  }): Promise<void>;
}
