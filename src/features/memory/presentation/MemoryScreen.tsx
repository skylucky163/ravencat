/** 记忆空间以星球呈现，正文和触发词由按需打开的面板管理。 */
import { showAppDialog } from '@shared/ui';
import React, { useCallback, useEffect, useId, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { ChevronLeft, Settings2 } from 'lucide-react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { GlassBackdrop, GlassSceneProvider, useTheme, useThemedStyles } from '@shared/theme';
import { selectMemorySpace } from '../application/MemoryCommands';
import { createMemoryGalaxyStyles } from './memoryGalaxyStyles';
import { GalaxyBackground, ShootingStars } from '@shared/ui/space';
import MemoryGalaxy from './MemoryGalaxy';
import MemorySpacePanel from './MemorySpacePanel';
import SplashOverlay from './SplashOverlay';
import useMemoryManagementSnapshot from './useMemoryManagementSnapshot';

interface Props {
  onBack(): void;
  onOpenSettings(assistantId?: string): void;
  onCreateMemory(assistantId: string): void;
  onEditMemory(assistantId: string, memoryId: string): void;
  onOpenTrigger(assistantId: string, triggerId: string): void;
}

export default function MemoryScreen({ onBack, onOpenSettings, onCreateMemory, onEditMemory, onOpenTrigger }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createMemoryGalaxyStyles);
  const glassSceneId = `memory:${useId()}`;
  const starlight = theme.mode === 'dark' ? theme.colors.text.primary : theme.colors.text.inverse;
  const reducedMotion = useReducedMotion();
  const [assistantId, setAssistantId] = useState<string>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [busy, setBusy] = useState(false);
  const [splashDone, setSplashDone] = useState(reducedMotion);
  const [scenePrepared, setScenePrepared] = useState(reducedMotion);
  const [sceneLaidOut, setSceneLaidOut] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const ambientActive = focused && appActive && !panelOpen && !reducedMotion;
  const { snapshot, spaces, error, refreshing, refresh } = useMemoryManagementSnapshot(assistantId);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); }
    catch (failure) { showAppDialog({ title: '操作失败', message: failure instanceof Error ? failure.message : '请稍后重试', tone: 'error' }); }
    finally { setBusy(false); }
  }, []);
  const openSpace = useCallback((id: string) => {
    if (snapshot?.selectedSpace?.assistantId !== id) setAssistantId(id);
    setPanelOpen(true);
    void run(() => selectMemorySpace(id));
  }, [run, snapshot?.selectedSpace?.assistantId]);
  const navigateFromPanel = (navigate: () => void) => { setFocused(false); navigate(); };

  const finishSplash = useCallback(() => setSplashDone(true), []);
  const prepareScene = useCallback(() => setScenePrepared(true), []);
  const markSceneLaidOut = useCallback(() => setSceneLaidOut(true), []);

  const scene = <>
    {/* 星云动效与前景共用 Screen 的前台生命周期。 */}
    {viewport.width > 0 && <GalaxyBackground width={viewport.width} height={viewport.height} paused={!ambientActive || !splashDone} />}
    <SafeAreaView style={{ flex: 1 }}>
      <View style={styles.navigation}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回" style={styles.iconButton} disabled={busy} onPress={onBack}><ChevronLeft size={23} color={starlight} /></Pressable>
        <Text style={styles.title}>记忆</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="记忆设置" style={styles.iconButton} disabled={busy} onPress={() => onOpenSettings(snapshot?.selectedSpace?.assistantId)}><Settings2 size={20} color={starlight} /></Pressable>
      </View>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>MEMORY GALAXY</Text>
        <Text style={styles.subtitle}>{spaces ? `${spaces.length} 个世界` : ''}</Text>
      </View>
      {error && !panelOpen && <><Text style={styles.error}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="重新读取记忆空间" onPress={refresh}><Text style={[styles.subtitle, { textAlign: 'center' }]}>重新读取</Text></Pressable></>}
      {!spaces && !error && !panelOpen && <ActivityIndicator color={starlight} style={{ marginTop: 24 }} />}
      {spaces?.length === 0 && <Text style={styles.empty}>创建 AI 助手后，这里会亮起属于你们的星球。</Text>}
      {spaces && spaces.length > 0 && <MemoryGalaxy spaces={spaces} paused={!focused || !appActive || panelOpen || !splashDone} disabled={busy} onSelect={openSpace} />}
    </SafeAreaView>
    {/* 流星 */}
    <ShootingStars width={viewport.width} height={viewport.height} active={ambientActive && splashDone} />
  </>;

  return <GlassSceneProvider sceneId={glassSceneId}>
    <View style={styles.screen} onLayout={({ nativeEvent: { layout } }) => setViewport({ width: layout.width, height: layout.height })}>
      {/* 只采样当前星空页面；弹窗是背景源的兄弟节点，避免玻璃采样自身。 */}
      {/* 固定开场播放完才挂载星空；数据与布局就绪后再淡出，准备阶段保持静止。 */}
      {scenePrepared && (spaces || error || reducedMotion) && <View style={styles.screen} onLayout={markSceneLaidOut}>
        {theme.effects.glass.enabled ? <GlassBackdrop sceneId={glassSceneId} style={styles.screen} pointerEvents="auto" accessibilityElementsHidden={false} importantForAccessibility="auto">{scene}</GlassBackdrop> : scene}
      </View>}
      {/* 记忆面板 */}
      {panelOpen && <MemorySpacePanel key={assistantId} visible={focused} snapshot={snapshot} error={error} busy={busy} refreshing={refreshing} refresh={refresh} run={run} onClose={() => setPanelOpen(false)}
        onCreateMemory={id => navigateFromPanel(() => onCreateMemory(id))}
        onEditMemory={(id, memoryId) => navigateFromPanel(() => onEditMemory(id, memoryId))}
        onOpenTrigger={(id, triggerId) => navigateFromPanel(() => onOpenTrigger(id, triggerId))} />}
      {/* 开屏动效 */}
      {!splashDone && <SplashOverlay active={focused && appActive} ready={sceneLaidOut && Boolean(snapshot || error)} onPrepare={prepareScene} onFinish={finishSplash} />}
    </View>
  </GlassSceneProvider>;
}
