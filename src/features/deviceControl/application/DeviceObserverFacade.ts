/** 通过应用层端口向界面暴露设备观察状态。 */

import { getDeviceControlRuntimeDependencies } from './DeviceControlRuntimeDependencies';
import type {
  DeviceObserverConnectionState,
  DeviceObserverScreenshot,
  DeviceObserverOcrSnapshot,
  DeviceObserverScreenshotRequest,
  DeviceObserverSemanticReadRequest,
  DeviceObserverSemanticSnapshot,
  DeviceObserverSubscription,
} from './DeviceObserverPort';

function getDeviceObserver() {
  return getDeviceControlRuntimeDependencies().native.deviceObserver;
}

export function addDeviceObserverConnectionListener(
  listener: (state: DeviceObserverConnectionState) => void
): DeviceObserverSubscription {
  return getDeviceObserver().addConnectionStateListener(listener);
}

export function getDeviceObserverConnectionState() {
  return getDeviceObserver().getConnectionState();
}

export function getCurrentWindowState() {
  return getDeviceObserver().getCurrentWindowState();
}

/** 向 Screen Capture 暴露截图设备能力；策略由调用方 Feature 负责。 */
export function captureDeviceObserverScreenshot(
  input: DeviceObserverScreenshotRequest,
): Promise<DeviceObserverScreenshot> {
  return getDeviceObserver().captureScreenshot(input);
}

/** 向 Screen Observation 暴露无业务策略的原生语义提取能力。 */
export function readDeviceObserverSemanticSnapshot(
  input: DeviceObserverSemanticReadRequest,
): Promise<DeviceObserverSemanticSnapshot> {
  return getDeviceObserver().readSemanticSnapshot(input);
}

/** 向 Screen Observation 暴露无业务策略的本地 OCR 能力；输入只能是已冻结的托管截图。 */
export function recognizeDeviceObserverScreenshotText(
  uri: string,
): Promise<DeviceObserverOcrSnapshot> {
  return getDeviceObserver().recognizeScreenshotText(uri);
}

/** 释放 Device Observer 写入的 App 私有临时截图。 */
export function deleteDeviceObserverScreenshot(uri: string): Promise<void> {
  return getDeviceObserver().deleteScreenshot(uri);
}

export function getInstalledLaunchableApps() {
  return getDeviceObserver().getInstalledLaunchableApps();
}

export function clearInstalledAppIconCache() {
  return getDeviceObserver().clearInstalledAppIconCache();
}

export function openDeviceObserverSettings() {
  return getDeviceObserver().openAccessibilitySettings();
}
