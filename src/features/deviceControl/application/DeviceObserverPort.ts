/** 定义读取设备观察技术事实所需的窄端口。 */

export interface DeviceObserverConnectionState {
  accessibilityEnabled: boolean;
  accessibilityConnected: boolean;
  canRetrieveWindowContent: boolean;
  canTakeScreenshot: boolean;
  connectedAtEpochMs: number;
  lastDisconnectedAtEpochMs: number;
  lastEventAtEpochMs: number;
}

export interface DeviceObserverWindowState {
  packageName: string | null;
  windowId: number | null;
  title: string | null;
  detectionReliable: boolean;
  checkedAtEpochMs: number;
  source: 'accessibility' | 'usage_events' | 'unknown';
}

export interface DeviceObserverSubscription {
  remove(): void;
}

export interface DeviceObserverScreenshot {
  uri: string;
  width: number;
  height: number;
  mimeType: 'image/png' | 'image/jpeg';
  capturedAtEpochMs: number;
  packageName: string | null;
  windowId: number | null;
  source: 'accessibility_display' | 'accessibility_window';
}

export interface DeviceObserverScreenshotWindowIdentity {
  packageName: string | null;
  windowId: number;
}

export type DeviceObserverScreenshotRequest = {
  requestId: string;
} & (
  | {
      target: 'current_window';
      expectedWindow: DeviceObserverScreenshotWindowIdentity;
    }
  | {
      target: 'default_display';
    }
);

export interface DeviceObserverSemanticNode {
  depth: number;
  text: string | null;
  contentDescription: string | null;
  className: string | null;
  clickable: boolean;
  editable: boolean;
  password: boolean;
}

export interface DeviceObserverSemanticSnapshot {
  packageName: string;
  windowId: number;
  capturedAtEpochMs: number;
  nodes: DeviceObserverSemanticNode[];
  truncation: {
    nodeLimitReached: boolean;
    depthLimitReached: boolean;
    characterLimitReached: boolean;
  };
}

export interface DeviceObserverSemanticReadRequest {
  expectedWindow: DeviceObserverScreenshotWindowIdentity;
}

/** 原生 OCR 只返回有界 line 文本；截图身份仍归 Screen Observation 的冻结快照。 */
export interface DeviceObserverOcrLine {
  text: string;
}

export interface DeviceObserverOcrBlock {
  lines: DeviceObserverOcrLine[];
}

export interface DeviceObserverOcrSnapshot {
  blocks: DeviceObserverOcrBlock[];
  truncation: {
    blockLimitReached: boolean;
    lineLimitReached: boolean;
    characterLimitReached: boolean;
  };
}


export interface DeviceObserverInstalledLaunchableApp {
  packageName: string;
  label: string;
  iconDataUri: string | null;
  isSystemApp: boolean;
}

/** 应用层可识别的本机 App 目录读取失败。 */
export class DeviceObserverInstalledAppsQueryError extends Error {
  constructor() {
    super('无法读取本机可启动 App 列表');
    this.name = 'DeviceObserverInstalledAppsQueryError';
  }
}

export interface DeviceObserverPort {
  addConnectionStateListener(
    listener: (state: DeviceObserverConnectionState) => void
  ): DeviceObserverSubscription;
  getConnectionState(): Promise<DeviceObserverConnectionState>;
  getCurrentWindowState(): Promise<DeviceObserverWindowState>;
  getInstalledLaunchableApps(): Promise<DeviceObserverInstalledLaunchableApp[]>;
  clearInstalledAppIconCache(): Promise<void>;
  captureScreenshot(input: DeviceObserverScreenshotRequest): Promise<DeviceObserverScreenshot>;
  readSemanticSnapshot(
    input: DeviceObserverSemanticReadRequest,
  ): Promise<DeviceObserverSemanticSnapshot>;
  recognizeScreenshotText(uri: string): Promise<DeviceObserverOcrSnapshot>;
  deleteScreenshot(uri: string): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
}
