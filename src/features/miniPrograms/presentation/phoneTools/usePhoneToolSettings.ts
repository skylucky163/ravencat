/** 单项权限与应用包总开关均由 Prompting 保存，手机目录不另存一份配置。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  getAssistantToolPermissions,
  getAppToolPackageSettings,
  listPromptAssistantOptions,
  setAssistantToolPermission,
  setAppToolPackageEnabled,
  type AssistantPromptEditorDetails,
  type PromptAssistantOption,
} from '@features/prompting';
import { getDeviceObserverConnectionState, getNotificationListenerAccessState } from '@features/deviceControl';
import { isOverlayPermissionGranted } from '@features/floatingLayer';
import { getDeviceLocationAccessState, isUsageAccessGranted } from '@platform/device';
import { showAppDialog } from '@shared/ui';
import { PHONE_TOOL_PACKAGE_CATALOG } from '@features/phoneTools';
import { getPhoneToolReadinessLabel, type PhoneToolSystemAccess } from './ToolPackageDisplayModel';

interface PhoneToolSettingsSnapshot {
  host: PromptAssistantOption | null;
  tools: AssistantPromptEditorDetails['tools'];
  appToolPackages: Record<string, boolean>;
  access: PhoneToolSystemAccess;
}

export function usePhoneToolSettings() {
  const [snapshot, setSnapshot] = useState<PhoneToolSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const savingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const currentRevision = ++revision.current;
    try {
      const [assistants, observer, usageAccessGranted, overlayGranted, notificationListener, location, appToolPackages] = await Promise.all([
        listPromptAssistantOptions(), getDeviceObserverConnectionState(), isUsageAccessGranted(),
        isOverlayPermissionGranted(), getNotificationListenerAccessState(),
        getDeviceLocationAccessState(),
        getAppToolPackageSettings(),
      ]);
      const host = assistants.find((assistant) => assistant.isHostAI) ?? null;
      const tools = host ? await getAssistantToolPermissions(host.id) : [];
      if (mounted.current && currentRevision === revision.current) {
        setSnapshot({ host, tools, appToolPackages, access: {
          observer, usageAccessGranted, overlayGranted, notificationListenerGranted: notificationListener.status === 'granted', location,
        } });
        setError(null);
      }
    } catch (failure) {
      if (mounted.current && currentRevision === revision.current) {
        setSnapshot(null);
        setError(failure instanceof Error ? failure.message : '无法读取手机工具配置');
      }
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => { subscription.remove(); revision.current++; };
  }, [refresh]));

  async function saveSetting(save: () => Promise<void>) {
    if (!snapshot || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await save();
      await refresh();
    } catch (failure) {
      if (mounted.current) showAppDialog({ title: '保存失败', message: failure instanceof Error ? failure.message : '无法保存调用权限' });
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  async function toggleTool(toolName: string, enabled: boolean) {
    if (!snapshot?.host) return;
    const assistantId = snapshot.host.id;
    await saveSetting(() => setAssistantToolPermission(assistantId, toolName, enabled));
  }

  async function togglePackage(packageId: string, enabled: boolean) {
    await saveSetting(() => setAppToolPackageEnabled(packageId, enabled));
  }

  function isPackageEnabled(packageId: string): boolean {
    return snapshot !== null && snapshot.appToolPackages[packageId] === true;
  }

  function isEnabled(toolName: string): boolean {
    return snapshot?.host ? snapshot.tools.find((tool) => tool.name === toolName)!.enabled : false;
  }

  function statusLabel(toolName: string): string {
    if (error) return '状态读取失败';
    if (!snapshot) return '读取中';
    if (!snapshot.host) return '未设置主理 AI';
    const toolPackage = PHONE_TOOL_PACKAGE_CATALOG.find((entry) => entry.tools.some((tool) => tool.toolName === toolName));
    if (toolPackage && !isPackageEnabled(toolPackage.id)) return '工具包已关闭';
    return getPhoneToolReadinessLabel(toolName, isEnabled(toolName), snapshot.access);
  }

  return {
    isEnabled, statusLabel, toggleTool, disabled: !snapshot?.host || saving,
    isPackageEnabled, togglePackage, packageDisabled: !snapshot || saving,
    hostName: snapshot?.host?.name ?? null,
    // 说明文字归标题问号；这里只留读取、失败和缺主理 AI 的临时状态。
    notice: error ? `读取失败：${error}`
      : !snapshot ? '正在读取调用权限与系统状态…'
        : snapshot.host ? null : '请先设置主理 AI，再配置手机工具调用权限。',
  };
}
