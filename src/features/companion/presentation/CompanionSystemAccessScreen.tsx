/** 汇总 RavenCat 当前已经接入的 Android 系统访问与后台运行能力。 */

import { Ionicons } from '@expo/vector-icons';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { ToggleField } from '@shared/ui';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  getCompanionNotificationDiagnostics,
  requestCompanionNotificationPermission,
} from '../application';
import {
  getIncomingCallDiagnostics,
  openFullScreenIntentSettings,
  openIncomingCallNotificationSettings,
} from '@features/calls';
import {
  getBatteryOptimizationState,
  isOverlayPermissionGranted,
  openBatteryOptimizationSettings,
  openOverlayPermissionSettings,
  requestIgnoreBatteryOptimizations,
} from '@features/floatingLayer';

import {
  getDeviceObserverConnectionState,
  getNotificationListenerAccessState,
  openNotificationListenerSettings,
  openDeviceObserverSettings,
  type DeviceObserverConnectionState,
} from '@features/deviceControl';
import { createStyles } from './CompanionSettingsShared.styles';
import { CompanionDiagnosticsSheet } from './CompanionDiagnosticsSheet';
import {
  getDeviceLocationAccessState,
  isSystemCalendarPermissionGranted,
  manageSystemCalendarPermission,
  isUsageAccessGranted,
  manageDeviceLocationPermission,
  openDeviceLocationSettings,
  openUsageAccessSettings,
  type DeviceLocationAccessState,
  getBackgroundRuntimeState,
  setBackgroundRuntimeEnabled,
  type BackgroundRuntimeState,
} from '@platform/device';
import { isApplicationUpdateInstallAllowed, openApplicationUpdateInstallSettings } from '@platform/updates/DownloadApplicationUpdate';

interface CompanionSystemAccessScreenProps {
  onBack: () => void;
}

interface SystemAccessSnapshot {
  overlayGranted: boolean;
  calendarGranted: boolean;
  notificationGranted: boolean;
  fullScreenIntentAllowed: boolean;
  incomingCallChannelEnabled: boolean;
  batteryGranted: boolean;
  background: BackgroundRuntimeState;
  usageAccessGranted: boolean;
  notificationListenerGranted: boolean;
  updateInstallAllowed: boolean;
  observer: DeviceObserverConnectionState;
  location: DeviceLocationAccessState;
}

export default function CompanionSystemAccessScreen({ onBack }: CompanionSystemAccessScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [snapshot, setSnapshot] = useState<SystemAccessSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [changingBackground, setChangingBackground] = useState(false);

  const refresh = useCallback(async (pullToRefresh = false) => {
    if (pullToRefresh) setRefreshing(true);
    try {
      const [overlayGranted, notification, battery, observer, incomingCallDiagnostics, usageAccessGranted, notificationListener, location, calendarGranted, background] =
        await Promise.all([
          isOverlayPermissionGranted(),
          getCompanionNotificationDiagnostics(),
          getBatteryOptimizationState(),
          getDeviceObserverConnectionState(),
          getIncomingCallDiagnostics(),
          isUsageAccessGranted(),
          getNotificationListenerAccessState(),
          getDeviceLocationAccessState(),
          isSystemCalendarPermissionGranted(),
          getBackgroundRuntimeState(),
        ]);
      setSnapshot({
        overlayGranted,
        calendarGranted,
        notificationGranted: notification.postNotificationsGranted
          && notification.notificationsEnabled
          && notification.channelImportance > 0,
        fullScreenIntentAllowed: incomingCallDiagnostics.fullScreenIntentAllowed,
        incomingCallChannelEnabled: incomingCallDiagnostics.incomingCallChannelImportance > 0,
        batteryGranted: battery.ignoringBatteryOptimizations,
        background,
        usageAccessGranted,
        notificationListenerGranted: notificationListener.status === 'granted',
        updateInstallAllowed: isApplicationUpdateInstallAllowed(),
        observer,
        location,
      });
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toMessage(error, '无法读取系统访问状态。'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const changeBackground = async (enabled: boolean) => {
    setChangingBackground(true);
    let failure: string | null = null;
    try { await setBackgroundRuntimeEnabled(enabled); }
    catch (error) { failure = toMessage(error, '无法更改持续后台运行状态。'); }
    finally {
      // 启动被拒绝时保留已保存的开关，实际运行状态单独展示。
      await refresh();
      if (failure) setErrorMessage(failure);
      setChangingBackground(false);
    }
  };

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const openNotificationSettings = useCallback(async () => {
    if (!snapshot?.notificationGranted) {
      await requestCompanionNotificationPermission();
      await refresh();
      return;
    }
    await Linking.openSettings();
  }, [refresh, snapshot?.notificationGranted]);

  const openBackgroundPopupSettings = useCallback(async () => {
    try {
      // 厂商首页并不是本应用的权限页；复用系统应用详情入口，由用户确认不可检测的开关。
      await Linking.openSettings();
    } catch (error) {
      setErrorMessage(toMessage(error, '无法打开本应用的系统设置。'));
    }
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right']}>
        <NavigationHeader title="权限与后台运行" onGoBack={onBack} />
        <View style={styles.loading}>
          <ActivityIndicator color={theme.colors.brand.primary} />
          <Text style={styles.muted}>正在检查系统访问…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right']}>
      <NavigationHeader title="权限与后台运行" onGoBack={onBack} />
      <ScrollView
        style={styles.scrollView}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh(true)} />}
      >
        {errorMessage ? (
          <View style={styles.errorCard}><Text style={styles.errorText}>{errorMessage}</Text></View>
        ) : null}

        {snapshot ? (
          <>
            <Text style={styles.sectionTitle}>必要系统访问</Text>
            <ThemedSurface variant="card" style={styles.card}>
              <View style={styles.cardContent}>
                <PermissionRow label="通知提醒" value={snapshot.notificationGranted} onPress={() => void openNotificationSettings()} styles={styles} description="用于普通消息、主动联系和后台状态通知。" />
                <PermissionRow label="系统日历" value={snapshot.calendarGranted} onPress={() => {
                  void manageSystemCalendarPermission().then(() => refresh()).catch((error: unknown) => setErrorMessage(toMessage(error, '无法管理系统日历权限。')));
                }} styles={styles} description="允许 AI 日程同时写入手机日历；写入后由系统日历独立提醒，RavenCat 被后台清理也不影响这条系统提醒。" />
                <PermissionRow label="通知使用权" value={snapshot.notificationListenerGranted} onPress={() => {
                  void openNotificationListenerSettings().then((result) => {
                    if (result.status === 'settings_open_failed') setErrorMessage(result.reason);
                  }).catch((error: unknown) => setErrorMessage(toMessage(error, '无法打开通知使用权设置。')));
                }} styles={styles} description="用于读取和控制网易云播放状态。部分手机位于“更多安全设置 → 设备和应用通知”。" />
                <PermissionRow label="悬浮显示" value={snapshot.overlayGranted} onPress={() => void openOverlayPermissionSettings()} styles={styles} description="用于悬浮球与快捷聊天。" />
                <PermissionRow label="屏幕内容读取" value={snapshot.observer.accessibilityConnected && snapshot.observer.canRetrieveWindowContent} onPress={() => void openDeviceObserverSettings()} styles={styles} description={observerHint(snapshot.observer)} />
                <PermissionRow label="使用情况访问" value={snapshot.usageAccessGranted} onPress={() => {
                  void openUsageAccessSettings().catch((error: unknown) => setErrorMessage(toMessage(error, '无法打开使用情况访问设置。')));
                }} styles={styles} description="允许主理 AI 按需查询应用前台使用时长。" />
                <PermissionRow label="定位权限" value={snapshot.location.permission !== 'not_granted'}
                  grantedLabel={snapshot.location.permission === 'precise' ? '精确位置' : '大致位置'} onPress={() => {
                    void manageDeviceLocationPermission().then(() => refresh()).catch((error: unknown) => setErrorMessage(toMessage(error, '无法管理定位权限。')));
                  }} styles={styles} description="允许主理 AI 按需获取一次手机位置；仅申请使用期间权限，支持大致位置，不持续追踪。" />
                <PermissionRow label="系统定位" value={snapshot.location.servicesEnabled} onPress={() => {
                  void openDeviceLocationSettings().catch((error: unknown) => setErrorMessage(toMessage(error, '无法打开系统定位设置。')));
                }} styles={styles} description="手机系统的定位总开关；开启后仍需授予本应用定位权限。" last />
              </View>
            </ThemedSurface>

            <Text style={styles.sectionTitle}>应用更新</Text>
            <ThemedSurface variant="card" style={styles.card}>
              <View style={styles.cardContent}>
                <PermissionRow label="安装未知应用" value={snapshot.updateInstallAllowed} onPress={() => {
                  void openApplicationUpdateInstallSettings().catch((error: unknown) => setErrorMessage(toMessage(error, '无法打开安装未知应用设置。')));
                }} styles={styles} description="允许 RavenCat 打开系统安装页更新自身。每次安装仍需手动确认。" last />
              </View>
            </ThemedSurface>

            <Text style={styles.sectionTitle}>后台可靠性</Text>
            <ThemedSurface variant="card" style={styles.card}>
              <View style={styles.cardContent}>
                <ToggleField label="持续后台运行" layout="inline"
                  hint="让 RavenCat 跨聊天持续在后台运行，直到手动关闭。关闭只撤销持续运行保障，不改变各功能开关。"
                  value={snapshot.background.enabled} disabled={changingBackground}
                  onValueChange={(enabled) => void changeBackground(enabled)}
                  rowStyle={styles.permissionRow} contentStyle={styles.permissionText}
                  labelStyle={styles.permissionLabel} hintStyle={styles.permissionHint} />
                <DiagnosticRow label="后台服务" value={snapshot.background.running ? '运行中' : snapshot.background.enabled ? '尚未运行，可关闭后重新开启' : '已关闭'} styles={styles} />
                <PermissionRow label="电池优化" value={snapshot.batteryGranted} onPress={() => void (snapshot.batteryGranted ? openBatteryOptimizationSettings() : requestIgnoreBatteryOptimizations())} styles={styles} description="允许后台运行可减少系统延迟，但不能阻止强制停止或厂商清理。" last />
              </View>
            </ThemedSurface>

            <TouchableOpacity style={styles.entryCard} onPress={() => setShowDiagnostics(true)} accessibilityRole="button">
              <View style={styles.permissionText}>
                <Text style={styles.entryTitle}>日程运行诊断</Text>
                <Text style={styles.entryHint}>查看闹钟、后台执行与结束记录，可复制用于排查延迟。</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.colors.text.tertiary} />
            </TouchableOpacity>

            <Text style={styles.sectionTitle}>通话系统访问</Text>
            <ThemedSurface variant="card" style={styles.card}>
              <View style={styles.cardContent}>
                {Number(Platform.Version) >= 34 ? (
                  <PermissionRow label="全屏来电授权" value={snapshot.fullScreenIntentAllowed} onPress={() => void openFullScreenIntentSettings()} styles={styles} description="允许来电在锁屏或熄屏时弹出；部分手机还需开启下方的后台弹出界面与锁屏显示。" />
                ) : (
                  <DiagnosticRow label="全屏来电授权" value="Android 13 无需单独授权" styles={styles} />
                )}
                <PermissionRow label="来电通知" value={snapshot.incomingCallChannelEnabled} onPress={() => void openIncomingCallNotificationSettings()} styles={styles} description="检查来电通知 Channel、锁屏显示与悬浮通知。" last />
              </View>
            </ThemedSurface>

            <TouchableOpacity style={styles.entryCard} onPress={() => void openBackgroundPopupSettings()} accessibilityRole="button">
              <View style={styles.permissionText}>
                <Text style={styles.entryTitle}>后台弹出界面与锁屏显示</Text>
                <Text style={styles.entryHint}>打开本应用的系统设置，在权限管理中人工确认。vivo 需同时允许“后台弹出界面”和“锁屏显示”；这些厂商开关无法可靠检测。</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.colors.text.tertiary} />
            </TouchableOpacity>
          </>
        ) : null}
        <View style={styles.bottomGap} />
      </ScrollView>
      {showDiagnostics ? <CompanionDiagnosticsSheet onClose={() => setShowDiagnostics(false)} /> : null}
    </SafeAreaView>
  );
}

function PermissionRow({
  label,
  value,
  onPress,
  description,
  grantedLabel = '已开启',
  last,
  styles,
}: {
  label: string;
  value: boolean;
  onPress: () => void;
  description: string;
  grantedLabel?: string;
  last?: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity style={[styles.permissionRow, last ? styles.lastRow : null]} onPress={onPress} accessibilityRole="button">
      <View style={styles.permissionText}>
        <Text style={styles.permissionLabel}>{label}</Text>
        <Text style={styles.permissionHint}>{description}</Text>
      </View>
      <Text style={[styles.permissionStatus, value ? styles.statusGranted : null]}>
        {value ? grantedLabel : '去开启'}
      </Text>
    </TouchableOpacity>
  );
}

function DiagnosticRow({
  label,
  value,
  last,
  styles,
}: {
  label: string;
  value: string;
  last?: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={[styles.settingRow, last ? styles.lastRow : null]}>
      <Text style={styles.settingHint}>{label}</Text>
      <Text style={styles.settingValue}>{value}</Text>
    </View>
  );
}

function observerHint(observer: DeviceObserverConnectionState): string {
  if (!observer.accessibilityEnabled) return '用于 Extract 和看屏幕后联系；当前尚未启用。';
  if (!observer.accessibilityConnected) return '系统已启用，但设备观察服务尚未连接。';
  if (!observer.canRetrieveWindowContent) return '服务已连接，但当前不能读取窗口内容。';
  return '设备观察服务已连接，可读取窗口内容。';
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
