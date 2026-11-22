/** RavenCat Device Control 原生模块桥：通用 Android 执行与观察入口。 */

import {
  NativeModule,
  requireNativeModule,
} from 'expo';

/**
 * 下发给 native 的 active lock 执行投影；只含执行所需字段，不含业务历史
 * （source / sourceAiId / reason / createdAtEpochMs / status 一律不下发）。
 */
export type DeviceControlSoftLockProjection = {
  id: string;
  targetPackage: string;
  expiresAtEpochMs?: number;
};

/**
 * native → JS 回读的 runtime 投影快照，与下行投影刻意分成两个类型。
 *
 * Kotlin SoftLockProjection.toMap() 无条件写入 "expiresAtEpochMs" 键，
 * 无到期时间时下发的是显式 null，bridge 不会把它变成 undefined；
 * 因此回读侧的 expiresAtEpochMs 是 number | null，而不是可选字段。
 * 同一 runtime 状态里的 diagnostics.*EpochMs 已经是 number | null，
 * 这里沿用同一套 nullable 表述。
 */
export type DeviceControlSoftLockState = {
  id: string;
  targetPackage: string;
  expiresAtEpochMs: number | null;
};

/**
 * reconcile 的 typed 结果状态。
 * ok 只代表投影被 native runtime 接受，不代表目标 App 此刻已经被阻断；
 * 实际窗口事实必须读取 getRuntimeState。
 */
export type DeviceControlNativeReconcileStatus =
  | 'ok'
  | 'runtime_unavailable'
  | 'invalid_projection'
  | 'failed';

export type DeviceControlNativeReconcileResult = {
  status: DeviceControlNativeReconcileStatus;
  appliedCount: number;
  reason: string | null;
};

/** runtime 当前观察到的窗口事实；null 代表尚未收到事实或 observer 已断开。 */
export type DeviceControlObservedWindow = {
  packageName: string | null;
  windowId: number | null;
  title: string | null;
  detectionReliable: boolean;
  checkedAtEpochMs: number;
  source: string;
};

export type DeviceControlFailureCode =
  | 'runtime_unavailable'
  | 'background_start_restricted'
  | 'service_start_failed'
  | 'service_stop_failed'
  | 'overlay_permission_missing'
  | 'window_add_failed'
  | 'window_remove_failed'
  | 'launch_failed';

export type DeviceControlRuntimeFailure = {
  code: DeviceControlFailureCode;
  message: string;
};

export type DeviceControlRuntimeDiagnostics = {
  attachedAtEpochMs: number | null;
  lastReconcileAtEpochMs: number | null;
  lastWindowEventAtEpochMs: number | null;
  lastConnectionEventAtEpochMs: number | null;
  lastFailure: DeviceControlRuntimeFailure | null;
};

/** blocking overlay 的实际 native window 状态。 */
export type DeviceControlOverlayStatus =
  | 'detached'
  | 'attached'
  | 'permission_missing'
  | 'add_failed'
  | 'remove_failed';

/** Soft Lock native runtime 的状态快照；window fact 与业务 projection 明确分离。 */
export type DeviceControlRuntimeState = {
  serviceRunning: boolean;
  runtimeAttached: boolean;
  observerConnected: boolean;
  currentWindow: DeviceControlObservedWindow | null;
  projectedLocks: DeviceControlSoftLockState[];
  matchingLockId: string | null;
  targetMatched: boolean;
  shouldBlock: boolean;
  attached: boolean;
  attachedLockId: string | null;
  overlayStatus: DeviceControlOverlayStatus;
  diagnostics: DeviceControlRuntimeDiagnostics;
};

export type DeviceControlRuntimeStartStatus =
  | 'started'
  | 'already_running'
  | 'background_start_restricted'
  | 'failed';

export type DeviceControlRuntimeStartResult = {
  status: DeviceControlRuntimeStartStatus;
  reason: string | null;
};

export type DeviceControlRuntimeStopStatus =
  | 'stopped'
  | 'already_stopped'
  | 'still_active'
  | 'failed';

export type DeviceControlRuntimeStopResult = {
  status: DeviceControlRuntimeStopStatus;
  activeProjectionCount: number;
  reason: string | null;
};

/**
 * openApp 的 typed 原生结果。
 * launch_dispatched 只代表启动请求已交给 Android，不代表目标 App 已进入前台。
 */
export type DeviceControlAppLaunchResult =
  | { status: 'launch_dispatched'; packageName: string }
  | { status: 'app_not_launchable'; packageName: string; reason: string }
  | { status: 'launch_failed'; packageName: string; reason: string };

/**
 * dispatchBrowsableUri 的 typed 原生结果；不回传完整 URI。
 * uri_dispatched 只代表启动请求已交给 Android，不代表目标页面已打开或业务已完成。
 */
export type DeviceControlUriDispatchResult =
  | { status: 'uri_dispatched'; packageName: string }
  | { status: 'route_unavailable'; packageName: string; reason: string }
  | { status: 'route_dispatch_failed'; packageName: string; reason: string };

export type NotificationListenerAccessState =
  | { status: 'granted' }
  | { status: 'not_granted' };

export type NotificationListenerSettingsResult =
  | { status: 'settings_open_dispatched'; reason: null }
  | { status: 'settings_open_failed'; reason: string };

export type MediaSessionPlaybackState =
  | 'none'
  | 'stopped'
  | 'paused'
  | 'playing'
  | 'fast_forwarding'
  | 'rewinding'
  | 'buffering'
  | 'error'
  | 'connecting'
  | 'skipping_to_previous'
  | 'skipping_to_next'
  | 'skipping_to_queue_item'
  | 'unknown';

export interface MediaSessionSnapshot {
  packageName: string;
  /** 本地 session 读取系统选中媒体路由的名称；远程 session 不推断输出设备。 */
  audioOutput: { playbackType: 'local' | 'remote'; deviceNames: string[] } | null;
  playback: {
    state: MediaSessionPlaybackState;
    positionMs: number | null;
    speed: number | null;
    updatedAtEpochMs: number | null;
  };
  metadata: {
    mediaId: string | null;
    title: string | null;
    artist: string | null;
    album: string | null;
    durationMs: number | null;
  };
  /** Session 宣称支持的 command；不保证任意 mediaId/search/URI 参数可执行。 */
  actions: {
    play: boolean;
    pause: boolean;
    playPause: boolean;
    stop: boolean;
    next: boolean;
    previous: boolean;
    seekTo: boolean;
    playFromMediaId: boolean;
    playFromSearch: boolean;
    playFromUri: boolean;
    prepare: boolean;
    prepareFromMediaId: boolean;
    prepareFromSearch: boolean;
    prepareFromUri: boolean;
  };
}

export type MediaSessionSnapshotResult =
  | { status: 'session_snapshot_available'; snapshot: MediaSessionSnapshot }
  | { status: 'permission_not_granted' }
  | { status: 'no_active_session'; packageName: string }
  | { status: 'invalid_package_name'; reason: string }
  | { status: 'snapshot_failed'; reason: string };

/**
 * exact-package MediaSession transport command。
 *
 * 刻意不提供 'play'：resume 语义是“恢复当前 session”，不是“播放指定歌曲”，
 * 后台精确选歌不属于这个 generic primitive。
 */
export type MediaSessionTransportCommand = 'pause' | 'resume' | 'next' | 'previous';

/**
 * command_dispatched 只代表请求已交给目标 session，不代表 playback state 已经改变；
 * 最终事实必须由一次新的 getMediaSessionSnapshot 独立观察。
 */
export type MediaSessionTransportResult =
  | {
      status: 'command_dispatched';
      packageName: string;
      command: MediaSessionTransportCommand;
    }
  | { status: 'permission_not_granted' }
  | { status: 'no_active_session'; packageName: string }
  | {
      status: 'action_not_supported';
      packageName: string;
      command: MediaSessionTransportCommand;
    }
  | { status: 'invalid_package_name'; reason: string }
  | { status: 'invalid_command'; reason: string }
  | {
      status: 'dispatch_failed';
      packageName: string;
      command: MediaSessionTransportCommand;
      reason: string;
    };

export type XiaohongshuNoteCommand =
  | { operation: 'get_page' | 'enter_publishing' | 'open_text_entry' | 'start_text_note' | 'next' | 'back' | 'prepare_publish' }
  | { operation: 'set_card_text' | 'set_title' | 'set_body'; text: string }
  | { operation: 'add_topic'; tag: string }
  | { operation: 'select_style'; slot: number }
  | { operation: 'set_visibility'; visibility: 'public' | 'private' }
  | { operation: 'publish'; draft_id: string };

export interface XiaohongshuNoteResult {
  status: 'observed' | 'completed' | 'published' | 'not_completed' | 'publish_outcome_unknown';
  step: string;
  page: {
    kind: string; label: string; packageName: string | null; windowId: number | null;
    reliable: boolean; keyboardVisible: boolean; issue: string | null;
    availableActions: string[]; fields: { role: string; text: string; truncated: boolean }[]; visibleLabels: string[];
  };
  draft_id?: string | null;
  actionAttempted: boolean;
  publishAttempted: boolean;
  clipboardOverwritten?: boolean;
  expectedPages?: string[];
  reason?: string;
}

export type SystemAlarmResult = {
  status: 'alarm_request_dispatched' | 'app_not_focused' | 'clock_app_unavailable' | 'alarm_request_rejected';
};

declare class DeviceControlNativeModule extends NativeModule {
  showSystemAlarms(): Promise<SystemAlarmResult>;
  dismissSystemAlarm(mode: string, hour: number | null, minute: number | null, label: string | null): Promise<SystemAlarmResult>;
  snoozeSystemAlarm(minutes: number | null): Promise<SystemAlarmResult>;
  getNextSystemAlarm(): Promise<{ status: 'available'; triggerAtEpochMs: number } | { status: 'not_scheduled' }>;
  setSystemAlarm(hour: number, minute: number, label: string | null, daysOfWeek: number[]): Promise<SystemAlarmResult>;
  beginXiaohongshuNote(): string;
  cancelXiaohongshuNote(id: string): void;
  executeXiaohongshuNote(id: string, actor: string, command: XiaohongshuNoteCommand): Promise<XiaohongshuNoteResult>;
  prepareSystemCalendar(): Promise<'ready' | 'permission_required' | 'no_writable_calendar'>;
  upsertSystemCalendarEvent(key: string, title: string, description: string, startAtEpochMs: number): Promise<void>;
  removeSystemCalendarEvent(key: string): Promise<void>;
  listSystemCalendarEventKeys(): Promise<string[]>;
  startRuntime(): Promise<DeviceControlRuntimeStartResult>;
  reconcileSoftLocks(
    activeLocks: DeviceControlSoftLockProjection[],
  ): Promise<DeviceControlNativeReconcileResult>;
  getRuntimeState(): Promise<DeviceControlRuntimeState>;
  stopRuntimeIfIdle(): Promise<DeviceControlRuntimeStopResult>;
  openApp(packageName: string): Promise<DeviceControlAppLaunchResult>;
  dispatchBrowsableUri(
    packageName: string,
    uri: string,
  ): Promise<DeviceControlUriDispatchResult>;
  getNotificationListenerAccessState(): Promise<NotificationListenerAccessState>;
  openNotificationListenerSettings(): Promise<NotificationListenerSettingsResult>;
  getMediaSessionSnapshot(packageName: string): Promise<MediaSessionSnapshotResult>;
  dispatchMediaSessionCommand(
    packageName: string,
    command: MediaSessionTransportCommand,
  ): Promise<MediaSessionTransportResult>;
}

const DeviceControl = requireNativeModule<DeviceControlNativeModule>(
  'RavenCatDeviceControl',
);

export async function executeXiaohongshuNote(
  actor: string, command: XiaohongshuNoteCommand, signal?: AbortSignal,
): Promise<XiaohongshuNoteResult> {
  if (signal?.aborted) throw new Error('小红书操作已取消');
  const id = DeviceControl.beginXiaohongshuNote();
  const cancel = () => DeviceControl.cancelXiaohongshuNote(id);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    return await DeviceControl.executeXiaohongshuNote(id, actor, command);
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}

/**
 * 从可见 RavenCat 同步 attach process runtime 后请求独立 FGS。
 * 返回 started 后可立即 reconcile，不需要等待 Service.onCreate。
 */
export function startDeviceControlRuntime(): Promise<DeviceControlRuntimeStartResult> {
  return DeviceControl.startRuntime();
}

/**
 * 权威投影同步：application 以业务真值整体下发 active locks，
 * native runtime 用这一份作为当前执行投影；空数组代表当前没有
 * active lock，native 必须清空全部投影。这不是增量 add command。
 */
export function reconcileNativeSoftLocks(
  activeLocks: DeviceControlSoftLockProjection[],
): Promise<DeviceControlNativeReconcileResult> {
  return DeviceControl.reconcileSoftLocks(activeLocks);
}

export function getDeviceControlRuntimeState(): Promise<DeviceControlRuntimeState> {
  return DeviceControl.getRuntimeState();
}

/** 仅当 authoritative native projection 为空时停止 runtime/Service。 */
export function stopDeviceControlRuntimeIfIdle(): Promise<DeviceControlRuntimeStopResult> {
  return DeviceControl.stopRuntimeIfIdle();
}

/**
 * 派发一次 exact package 的 front-door launch 请求。
 * 与 Soft Lock runtime 生命周期独立；不做 Protected Apps / 搜索 / 前台读取。
 */
export function openApp(packageName: string): Promise<DeviceControlAppLaunchResult> {
  return DeviceControl.openApp(packageName);
}

/**
 * 派发一次 exact package 的 browsable URI 请求。
 * bridge 只透传 package 与 URI：不做 Protected Apps、不做具体 App 逻辑、不做 Tool 授权、
 * 不做 retry、不做前台验证。
 */
export function dispatchBrowsableUri(
  packageName: string,
  uri: string,
): Promise<DeviceControlUriDispatchResult> {
  return DeviceControl.dispatchBrowsableUri(packageName, uri);
}

export function getNotificationListenerAccessState(): Promise<NotificationListenerAccessState> {
  return DeviceControl.getNotificationListenerAccessState();
}

export function openNotificationListenerSettings(): Promise<NotificationListenerSettingsResult> {
  return DeviceControl.openNotificationListenerSettings();
}

export function getMediaSessionSnapshot(
  packageName: string,
): Promise<MediaSessionSnapshotResult> {
  return DeviceControl.getMediaSessionSnapshot(packageName);
}

/**
 * 向 exact package 的 active MediaSession 派发一次 transport command。
 *
 * 成功只代表请求已交给目标 session：不验证、不等待、不轮询 playback state。
 * 要确认结果必须显式再读一次 getMediaSessionSnapshot。
 */
export function dispatchMediaSessionCommand(
  packageName: string,
  command: MediaSessionTransportCommand,
): Promise<MediaSessionTransportResult> {
  return DeviceControl.dispatchMediaSessionCommand(packageName, command);
}

export default DeviceControl;
