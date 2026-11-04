import type {
  PhoneToolPackage,
  PhoneToolPackageStatus,
} from '@features/phoneTools';
import type { DeviceObserverConnectionState } from '@features/deviceControl';
import type { DeviceLocationAccessState } from '@platform/device';

export interface PhoneToolSystemAccess {
  observer: DeviceObserverConnectionState;
  usageAccessGranted: boolean;
  overlayGranted: boolean;
  notificationListenerGranted: boolean;
  location: DeviceLocationAccessState;
}

/** 只表达调用授权和系统前提；目标应用、窗口及媒体会话在执行时裁决。 */
export function getPhoneToolReadinessLabel(toolName: string, enabled: boolean, access: PhoneToolSystemAccess): string {
  if (!enabled) return '已关闭';
  if (toolName === 'get_current_location') {
    if (access.location.permission === 'not_granted') return '待授权定位';
    if (!access.location.servicesEnabled) return '系统定位已关闭';
  }
  if (toolName === 'get_app_usage' && !access.usageAccessGranted) return '待授权使用情况';
  if ((toolName === 'netease_get_playback_state' || toolName === 'netease_control_playback')
    && !access.notificationListenerGranted) return '待授权通知使用权';
  const editsXiaohongshu = toolName.startsWith('xiaohongshu_');
  if (editsXiaohongshu || ['get_foreground_app', 'read_screen_accessibility', 'read_screen_ocr', 'soft_lock_app'].includes(toolName)) {
    if (!access.observer.accessibilityEnabled) return '待授权无障碍';
    if (!access.observer.accessibilityConnected) return '无障碍未连接';
  }
  if ((editsXiaohongshu || toolName === 'read_screen_accessibility') && !access.observer.canRetrieveWindowContent) return '无法读取页面';
  if (toolName === 'read_screen_ocr' && !access.observer.canTakeScreenshot) return '无法截图';
  if (toolName === 'soft_lock_app' && !access.overlayGranted) return '待授权悬浮显示';
  return '权限就绪';
}

export interface ToolPackageDisplayTool {
  id: string;
  toolName: string;
  title: string;
  description: string;
  implementationStatus: PhoneToolPackageStatus;
  statusLabel: string;
}

export interface ToolPackageDisplayModel {
  id: string;
  title: string;
  description: string;
  implementationStatus: PhoneToolPackageStatus;
  statusLabel: string;
  tools: ToolPackageDisplayTool[];
}

function getToolPackageStatusLabel(status: PhoneToolPackageStatus): string {
  return status === 'available' ? '已接入' : '开发中';
}

export function buildToolPackageDisplayModel(
  toolPackage: PhoneToolPackage,
): ToolPackageDisplayModel {
  return {
    ...toolPackage,
    statusLabel: getToolPackageStatusLabel(toolPackage.implementationStatus),
    tools: toolPackage.tools.map((tool) => ({
      ...tool,
      statusLabel: getToolPackageStatusLabel(tool.implementationStatus),
    })),
  };
}
