/**
 * Device Control 功能公共 API。
 *
 * Device Control 只提供受控设备执行与设备观察技术事实，不做 Companion 业务决策。
 */

export {
  addDeviceObserverConnectionListener,
  captureDeviceObserverScreenshot,
  clearInstalledAppIconCache,
  deleteDeviceObserverScreenshot,
  getCurrentWindowState,
  getDeviceObserverConnectionState,
  getInstalledLaunchableApps,
  openDeviceObserverSettings,
  readDeviceObserverSemanticSnapshot,
  recognizeDeviceObserverScreenshotText,
} from './application/DeviceObserverFacade';
export type {
  DeviceObserverConnectionState,
  DeviceObserverInstalledLaunchableApp,
  DeviceObserverOcrBlock,
  DeviceObserverOcrLine,
  DeviceObserverOcrSnapshot,
  DeviceObserverScreenshot,
  DeviceObserverScreenshotWindowIdentity,
  DeviceObserverSemanticNode,
  DeviceObserverSemanticReadRequest,
  DeviceObserverSemanticSnapshot,
  DeviceObserverWindowState,
} from './application/DeviceObserverPort';

export {
  quiesceDeviceControlForFactoryReset,
  reconcileDeviceControl,
  resumeDeviceControlAfterFactoryReset,
} from './application/DeviceControl';
export { openAppByPackage, OpenAppError } from './application/OpenApp';
export type {
  OpenAppFailureReason,
  OpenAppResult,
} from './application/OpenApp';
/**
 * exact-package browsable URI dispatch 的受控 application 出口（PHONE-8C2 起有真实 Host consumer）。
 *
 * 这是 Host / Product 层唯一可以使用的业务入口：raw native bridge 仍只是 infrastructure，
 * 不得被 Host 或其他 Feature 当作业务入口直接调用。
 */
export {
  dispatchBrowsableUriToPackage,
  DispatchBrowsableUriError,
} from './application/DispatchBrowsableUri';
export type {
  DispatchBrowsableUriFailureReason,
  DispatchBrowsableUriResult,
} from './application/DispatchBrowsableUri';
export {
  getMediaSessionSnapshot,
  getNotificationListenerAccessState,
  openNotificationListenerSettings,
} from './application/MediaSessionObservation';
export type {
  MediaSessionPlaybackState,
  MediaSessionSnapshot,
  MediaSessionSnapshotResult,
  NotificationListenerAccessState,
  NotificationListenerSettingsResult,
} from './application/MediaSessionObservationPort';
/**
 * exact-package MediaSession transport control 出口。
 * command_dispatched 不代表 playback state 已改变，结果必须由 fresh snapshot 独立观察。
 */
export { dispatchMediaSessionCommand } from './application/MediaSessionControl';
export type {
  MediaSessionTransportCommand,
  MediaSessionTransportResult,
} from './application/MediaSessionControlPort';

export { SoftLockAppTool } from './aiTools/SoftLockAppTool';
export { SetAlarmTool, ShowAlarmsTool, DismissAlarmTool, SnoozeAlarmTool, GetNextAlarmTool } from './aiTools/SetAlarmTool';
export { ReleaseSoftLockTool } from './aiTools/ReleaseSoftLockTool';
export { SearchInstalledAppsTool } from './aiTools/SearchInstalledAppsTool';
export { OpenAppTool } from './aiTools/OpenAppTool';
