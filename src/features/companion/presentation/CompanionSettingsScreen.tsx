/** 提供“本地伴随”的正式设置入口。悬浮交互与系统访问由独立页面拥有。 */

import { ChevronRight, LockKeyhole, UserRoundPlus } from 'lucide-react-native';
import { getAssistantDisplayName,
  appointHostAIAssistant,
  type AIAssistantSummary,
  createHostAIAppointmentDialog,
  getHostAICooldownStatus,
  listAIAssistantSummaries,
} from '@features/assistants';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { AIAvatar, AIInfoCard, Button, ModalSheet, ToggleField, showAppDialog } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, InteractionManager, RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  activateCompanionProductState,
  CompanionError,
  disableCompanionProductState,
  getCompanionNotificationDiagnostics,
  loadCompanionProductState,
  normalizeCompanionErrorCode,
  requestCompanionNotificationPermission,
  resolveCompanionErrorMessage,
  updateCompanionProductSettings,
} from '../application';
import type {
  CompanionActivationStatus,
} from '../domain/CompanionState';
import type { CompanionSettings } from '../domain/CompanionSettings';
import {
  QuietHoursWheel,
} from './CompanionControls';

import { createStyles } from './CompanionSettingsShared.styles';
import { CompanionFollowUpSettings } from './CompanionFollowUpSettings';

interface CompanionSettingsScreenProps {
  onBack: () => void;
  onOpenScreen: (screen: CompanionSettingsSubScreen) => void;
  refreshRevision?: number;
}

export type CompanionSettingsSubScreen = 'proactive-life' | 'blacklist';
type CompanionActivationStage =
  | 'preconditions'
  | 'activation';

export default function CompanionSettingsScreen({
  onBack,
  onOpenScreen,
  refreshRevision = 0,
}: CompanionSettingsScreenProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const hasLoadedRef = useRef(false);
  const previousRefreshRevisionRef = useRef(refreshRevision);
  const activationFlowActiveRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hostAI, setHostAI] = useState<AIAssistantSummary | null>(null);
  const [assistantCandidates, setAssistantCandidates] = useState<AIAssistantSummary[]>([]);
  const [hostPickerLoading, setHostPickerLoading] = useState(false);
  const [hostPickerError, setHostPickerError] = useState<string | null>(null);
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [toggleState, setToggleState] = useState<CompanionActivationStatus>('disabled');
  const [showHostPicker, setShowHostPicker] = useState(false);
  const [showQuietHours, setShowQuietHours] = useState(false);
  const [quietDraft, setQuietDraft] = useState<{ start: number; end: number } | null>(null);
  const [cooldown, setCooldown] = useState<Awaited<ReturnType<typeof getHostAICooldownStatus>> | null>(null);

  const expanded = toggleState === 'enabled';
  const transitioning = toggleState === 'enabling' || toggleState === 'disabling';
  const toggleEnabled = toggleState === 'enabled' || toggleState === 'enabling';
  const appointment = cooldown?.appointment;
  const hostPickerDisabled = hostAI !== null || !appointment || appointment.isInCooldown || busy || refreshing;

  const refresh = useCallback(async () => {
    setRefreshing(hasLoadedRef.current);
    try {
      const product = await loadCompanionProductState();
      const nextCooldown = !product.hostAI
        ? await getHostAICooldownStatus()
        : null;
      setHostAI(product.hostAI);
      setCooldown(nextCooldown);
      setSettings(product.settings);
      if (product.state.activationStatus === 'paused_error') {
        await disableCompanionProductState({
          failureCode: normalizeFailureCode(product.state.lastFailureCode),
        });
        setToggleState('disabled');
      } else {
        setToggleState(product.state.activationStatus);
      }
      // 持久化失败码用于运行诊断；页面由当前主理 AI 与开关表达状态，不重放旧错误。
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toMessage(error, '无法读取本地伴随状态。'));
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const openHostPicker = useCallback(async () => {
    setHostPickerError(null);
    setHostPickerLoading(true);
    setShowHostPicker(true);
    try {
      setAssistantCandidates(await listAIAssistantSummaries());
    } catch (error) {
      setHostPickerError(toMessage(error, '无法读取 AI 列表。'));
    } finally {
      setHostPickerLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => { void refresh(); });
    return () => task.cancel();
  }, [refresh]);
  useEffect(() => {
    if (previousRefreshRevisionRef.current === refreshRevision) return;
    previousRefreshRevisionRef.current = refreshRevision;
    if (hasLoadedRef.current) void refresh();
  }, [refresh, refreshRevision]);

  const disableCompanion = useCallback(async () => {
    setToggleState('disabling');
    setBusy(true);
    try {
      await disableCompanionProductState();
      setToggleState('disabled');
      setErrorMessage(null);
    } catch (error) {
      setToggleState('disabled');
      setErrorMessage(toMessage(error, '关闭伴随模式失败。'));
    } finally {
      setBusy(false);
    }
  }, []);

  const enableCompanion = useCallback(async () => {
    if (!hostAI) {
      return;
    }
    if (activationFlowActiveRef.current) return;
    activationFlowActiveRef.current = true;
    setToggleState('enabling');
    setBusy(true);
    setErrorMessage(null);
    let activationStage: CompanionActivationStage = 'preconditions';
    try {
      const notification = await getCompanionNotificationDiagnostics();
      if (!notification.postNotificationsGranted || !notification.notificationsEnabled) {
        if (!await requestCompanionNotificationPermission()) {
          throw new CompanionError('notification_permission_missing');
        }
      }
      const availableNotification = await getCompanionNotificationDiagnostics();
      if (
        !availableNotification.postNotificationsGranted
        || !availableNotification.notificationsEnabled
        || availableNotification.channelImportance <= 0
      ) {
        throw new CompanionError('notification_permission_missing');
      }
      if (!hostAI.canonicalConversationId) {
        throw new CompanionError('host_ai_session_missing');
      }
      activationStage = 'activation';
      await activateCompanionProductState(hostAI.id);
      setToggleState('enabled');
    } catch (error) {
      const failure = classifyCompanionActivationError(error);
      console.error('[RavenCatCompanionActivation] 开启失败', {
        stage: activationStage,
        code: failure.code,
        message: redactActivationErrorMessage(failure.message),
      });
      if (activationStage !== 'activation') {
        await disableCompanionProductState({
          failureCode: failure.code,
        }).catch(() => undefined);
      }
      setToggleState('disabled');
      setErrorMessage(resolveCompanionErrorMessage(failure.code));
    } finally {
      activationFlowActiveRef.current = false;
      setBusy(false);
    }
  }, [hostAI]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refresh();
      }
    });
    return () => subscription.remove();
  }, [refresh]);

  const chooseHost = useCallback((assistant: AIAssistantSummary) => {
    showAppDialog(createHostAIAppointmentDialog(
      getAssistantDisplayName(assistant),
      () => void (async () => {
        setBusy(true);
        setHostPickerError(null);
        try {
          await appointHostAIAssistant(assistant.id);
          setShowHostPicker(false);
          await refresh();
        } catch (error) {
          setHostPickerError(toMessage(error, '主理 AI 任命失败。'));
          await refresh();
        } finally {
          setBusy(false);
        }
      })(),
    ));
  }, [refresh]);

  const updateQuietHoursEnabled = useCallback(async (value: boolean) => {
    if (!settings || busy) return;
    setBusy(true);
    try {
      setSettings(await updateCompanionProductSettings({ quietHoursEnabled: value }));
    } catch (error) {
      setErrorMessage(toMessage(error, '勿扰开关保存失败。'));
    } finally {
      setBusy(false);
    }
  }, [busy, settings]);

  const saveQuietHours = useCallback(async () => {
    if (!quietDraft || quietDraft.start === quietDraft.end) {
      setErrorMessage('勿扰开始时间和结束时间不能相同。');
      return;
    }
    setBusy(true);
    try {
      setSettings(await updateCompanionProductSettings({
        quietHoursStartMinutes: quietDraft.start,
        quietHoursEndMinutes: quietDraft.end,
      }));
      setShowQuietHours(false);
    } catch (error) {
      setErrorMessage(toMessage(error, '勿扰时段保存失败。'));
    } finally {
      setBusy(false);
    }
  }, [quietDraft]);

  if (loading) {
    return (
      <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right']}>
        <NavigationHeader title="本地伴随" onGoBack={onBack} />
        <View style={styles.loading}><ActivityIndicator color={theme.colors.brand.primary} /><Text style={styles.muted}>正在读取伴随状态…</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right']}>
      <NavigationHeader title="本地伴随" onGoBack={onBack} />
      <ScrollView
        style={styles.scrollView}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <SectionTitle text="主理 AI" styles={styles} />
        <ThemedSurface variant="card" style={styles.card}>
          <TouchableOpacity
            style={styles.hostCard}
            onPress={() => void openHostPicker()}
            disabled={hostPickerDisabled}
            accessibilityRole="button"
            accessibilityLabel={hostAI ? getAssistantDisplayName(hostAI) : appointment?.isInCooldown ? '主理 AI 冷静期，暂时无法任命' : '选择主理 AI'}
            accessibilityState={{ disabled: hostPickerDisabled }}
          >
            {hostAI ? (
              <AIInfoCard
                name={getAssistantDisplayName(hostAI)}
                model={hostAI.model}
                avatarUrl={hostAI.avatar}
                size="large"
                style={styles.hostInfoCard}
              />
            ) : (
              <>
                <View style={styles.placeholderAvatar}>
                  {appointment?.isInCooldown
                    ? <LockKeyhole size={26} color={theme.colors.text.secondary} />
                    : <UserRoundPlus size={28} color={theme.colors.brand.primary} />}
                </View>
                <View style={styles.hostMeta}>
                  <Text style={styles.hostName}>{appointment?.isInCooldown ? '主理 AI 冷静期' : '待选择主理 AI'}</Text>
                  <Text style={styles.hostHint}>{appointment?.isInCooldown ? `剩余 ${appointment.remainingDays} 天，暂时无法任命` : '选择唯一的深层关系对象'}</Text>
                </View>
              </>
            )}
            {!hostAI && !appointment?.isInCooldown ? <ChevronRight size={20} color={theme.colors.text.tertiary} /> : null}
          </TouchableOpacity>
          {!hostAI && appointment?.isInCooldown ? (
            <View style={styles.hostNotice}>
              <Text style={styles.hostNoticeText}>冷静期内不能任命任何 AI。可以与原主理 AI 商量，由它决定是否提前解除。</Text>
            </View>
          ) : null}
        </ThemedSurface>

        <SectionTitle text="伴随模式" styles={styles} />
        <ThemedSurface variant="card" style={styles.card}>
          <View style={styles.cardContent}>
            <ToggleField label="伴随模式" hint={toggleHint(toggleState, hostAI !== null)} value={toggleEnabled} onValueChange={(value) => void (value ? enableCompanion() : disableCompanion())} disabled={busy || !hostAI} />
            {transitioning ? <View style={styles.progressRow}><ActivityIndicator size="small" color={theme.colors.brand.primary} /><Text style={styles.progressText}>{toggleState === 'enabling' ? '正在开启…' : '正在关闭…'}</Text></View> : null}
            {toggleState === 'enabling' ? <Button title="取消开启" variant="outline" onPress={() => void disableCompanion()} /> : null}
          </View>
          <View style={styles.hostNotice}>
            <Text style={styles.hostNoticeText}>实验性功能：AI 日程与主动联系仍在持续优化。受系统后台限制、网络或模型服务影响，可能出现延迟、跳过或执行失败，暂不保证准时触达。</Text>
          </View>
        </ThemedSurface>

        {errorMessage ? <View style={styles.errorCard}><Text style={styles.errorText}>{errorMessage}</Text></View> : null}

        {expanded && settings ? <>
          <SectionTitle text="伴随设置" styles={styles} />
          <CompanionFollowUpSettings settings={settings} onChange={setSettings} onError={setErrorMessage} />
          <ThemedSurface variant="card" style={styles.card}>
            <View style={styles.cardContent}>
              <TouchableOpacity style={styles.settingRow} onPress={() => { setQuietDraft({ start: settings.quietHoursStartMinutes, end: settings.quietHoursEndMinutes }); setShowQuietHours(true); }} accessibilityRole="button">
                <View><Text style={styles.settingLabel}>勿扰时段</Text><Text style={styles.settingHint}>{settings.quietHoursEnabled ? '告诉主理 AI 你通常希望安静的时段' : '当前未提供勿扰偏好'}</Text></View><Text style={styles.settingValue}>{formatTime(settings.quietHoursStartMinutes)}–{formatTime(settings.quietHoursEndMinutes)}</Text>
              </TouchableOpacity>
              <ToggleField label="启用勿扰" hint="用于表达你通常希望安静的时段" value={settings.quietHoursEnabled} onValueChange={(value) => void updateQuietHoursEnabled(value)} disabled={busy} />
            </View>
          </ThemedSurface>

          <TouchableOpacity style={styles.entryCard} onPress={() => onOpenScreen('proactive-life')} accessibilityRole="button"><View><Text style={styles.entryTitle}>主动生活</Text><Text style={styles.entryHint}>查看自主醒来、AI 日程与历史活动</Text></View><ChevronRight size={20} color={theme.colors.text.tertiary} /></TouchableOpacity>
          <TouchableOpacity style={styles.entryCard} onPress={() => onOpenScreen('blacklist')}><View><Text style={styles.entryTitle}>窥屏黑名单</Text><Text style={styles.entryHint}>{`已选择 ${settings.userScreenCaptureBlacklist.length} 个应用 · 系统保护固定开启`}</Text></View><ChevronRight size={20} color={theme.colors.text.tertiary} /></TouchableOpacity>
        </> : null}
        <View style={styles.bottomGap} />
      </ScrollView>

      <ModalSheet visible={showHostPicker} onClose={() => setShowHostPicker(false)} title="选择主理 AI">
        {hostPickerLoading ? <ActivityIndicator color={theme.colors.brand.primary} /> : null}
        {busy ? <View style={styles.pickerFeedback}><ActivityIndicator color={theme.colors.brand.primary} /><Text style={styles.hostHint}>正在任命主理 AI…</Text></View> : null}
        {hostPickerError ? <View style={styles.pickerFeedback}><Text style={styles.errorText} accessibilityRole="alert">{hostPickerError}</Text></View> : null}
        {appointment?.isInCooldown ? <View style={styles.pickerFeedback}><Text style={styles.hostNoticeText}>冷静期剩余 {appointment.remainingDays} 天，暂时无法任命主理 AI。</Text></View> : null}
        <ScrollView style={styles.pickerList}>{assistantCandidates.map((assistant) => {
          const reason = assistant.isBlocked ? '当前已被限制' : !assistant.model.trim() ? '没有可用聊天模型' : assistant.model;
          const disabled = hostPickerDisabled || assistant.isBlocked || !assistant.model.trim();
          return <TouchableOpacity key={assistant.id} style={[styles.pickerItem, disabled ? styles.disabledItem : null]} disabled={disabled} onPress={() => chooseHost(assistant)}><AIAvatar name={getAssistantDisplayName(assistant)} avatarUrl={assistant.avatar} size="medium" /><View style={styles.hostMeta}><Text style={styles.hostName}>{getAssistantDisplayName(assistant)}</Text><Text style={styles.hostHint}>{reason}</Text></View></TouchableOpacity>;
        })}</ScrollView>
      </ModalSheet>

      <ModalSheet visible={showQuietHours} onClose={() => setShowQuietHours(false)} title="勿扰时段">
        {quietDraft ? <View style={styles.timeSheet}><View style={styles.quietWheels}><QuietHoursWheel label="开始" value={quietDraft.start} onChange={(start) => setQuietDraft({ ...quietDraft, start })} /><QuietHoursWheel label="结束" value={quietDraft.end} onChange={(end) => setQuietDraft({ ...quietDraft, end })} /></View><Text style={styles.timeHint}>上下滑动选择时间，支持跨午夜。</Text><Button title="保存" onPress={() => void saveQuietHours()} disabled={busy || quietDraft.start === quietDraft.end} /></View> : null}
      </ModalSheet>
    </SafeAreaView>
  );
}

function SectionTitle({ text, styles }: { text: string; styles: ReturnType<typeof createStyles> }) { return <Text style={styles.sectionTitle}>{text}</Text>; }

function toggleHint(state: CompanionActivationStatus, hasHost: boolean): string {
  if (!hasHost) return '选择主理 AI 后才能开启。';
  if (state === 'enabling') return '正在开启本地伴随。';
  return '由主理 AI 自主决定何时以及如何联系你。';
}

function formatTime(minutes: number): string { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
function toMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function normalizeFailureCode(code: string | null) {
  return normalizeCompanionErrorCode(code);
}

function classifyCompanionActivationError(
  error: unknown,
): CompanionError {
  if (error instanceof CompanionError) return error;
  const message = error instanceof Error ? error.message : String(error || '');
  return new CompanionError('database_unavailable', message || undefined, error);
}

function redactActivationErrorMessage(message: string): string {
  return message
    .replace(/(api[_ -]?key\s*[:=]\s*)\S+/gi, '$1[已隐藏]')
    .slice(0, 500);
}
