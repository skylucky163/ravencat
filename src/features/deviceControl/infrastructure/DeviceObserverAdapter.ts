/** 将通用设备观察能力适配为 Device Control 应用层端口。 */

import { deviceObserver, InstalledAppsQueryError } from '@platform/device';
import {
  DeviceObserverInstalledAppsQueryError,
  type DeviceObserverPort,
} from '../application/DeviceObserverPort';

export const deviceObserverAdapter: DeviceObserverPort = {
  addConnectionStateListener: (listener) =>
    deviceObserver.addConnectionStateListener(listener),
  getConnectionState: () => deviceObserver.getConnectionState(),
  getCurrentWindowState: () => deviceObserver.getCurrentWindowState(),
  getInstalledLaunchableApps: async () => {
    try {
      return await deviceObserver.getInstalledLaunchableApps();
    } catch (error) {
      if (!(error instanceof InstalledAppsQueryError)) {
        throw error;
      }
      throw new DeviceObserverInstalledAppsQueryError();
    }
  },
  clearInstalledAppIconCache: () => deviceObserver.clearInstalledAppIconCache(),
  captureScreenshot: (input) => deviceObserver.captureScreenshot(input),
  readSemanticSnapshot: (input) => deviceObserver.readSemanticSnapshot(input),
  recognizeScreenshotText: (uri) => deviceObserver.recognizeScreenshotText(uri),
  deleteScreenshot: (uri) => deviceObserver.deleteScreenshot(uri),
  openAccessibilitySettings: () => deviceObserver.openAccessibilitySettings(),
};
