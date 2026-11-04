/** 时间碎片只呈现日程事实；Screen 拥有日期、玻璃场景和前台动效生命周期。 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { CalendarDays, ChevronLeft } from 'lucide-react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { GlassBackdrop, GlassSceneProvider, getThemeById, useTheme, useThemedStyles } from '@shared/theme';
import { Button, InputField, ModalSheet } from '@shared/ui';
import { GalaxyBackground, ShootingStars } from '@shared/ui/space';
import type { ProactiveLifeCalendarItem } from '../application/ProactiveLifeReadQueries';
import { calendarDate, calendarDay, calendarDayKey, parseCalendarDay } from './proactiveLifeCalendar';
import { formatProactiveLifeClock, proactiveLifeCompletionDispositionLabel } from './proactiveLifeViewModel';
import ProactiveLifeCalendarArc from './ProactiveLifeCalendarArc';
import AIScheduleDetailContent from './AIScheduleDetailContent';
import useProactiveLifeCalendar from './useProactiveLifeCalendar';
import { createStyles } from './ProactiveLifeScreen.styles';

export default function ProactiveLifeScreen({ onBack }: { onBack: () => void }) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const light = getThemeById('default-dark').colors.text.primary;
  const insets = useSafeAreaInsets();
  const sceneId = `companion:${useId()}`;
  const reducedMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [today, setToday] = useState(() => calendarDay(new Date()));
  const [selectedDay, setSelectedDay] = useState(today);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState('');
  const [jumpError, setJumpError] = useState<string | undefined>();
  const [arcVisible, setArcVisible] = useState(true);
  const arcVisibility = useRef({ top: 0, height: 0, scrollY: 0, viewportHeight: 0, visible: true });
  const active = focused && appActive;
  // 玻璃弹层透出的是深色星空，弹层里的标题、正文与表单都要改用亮色。
  const darkSheet = theme.effects.glass.enabled;
  const calendar = useProactiveLifeCalendar(selectedDay, active);
  const { snapshot } = calendar;
  const chooseDay = useCallback((day: number) => setSelectedDay(day), []);
  const closeDetail = useCallback(() => setDetailId(null), []);
  const updateArcVisibility = useCallback(() => {
    const bounds = arcVisibility.current;
    if (bounds.height === 0 || bounds.viewportHeight === 0) return;
    const visible = bounds.top + bounds.height > bounds.scrollY && bounds.top < bounds.scrollY + bounds.viewportHeight;
    if (visible !== bounds.visible) { bounds.visible = visible; setArcVisible(visible); }
  }, []);

  useFocusEffect(useCallback(() => { setToday(calendarDay(new Date())); setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { setAppActive(state === 'active'); if (state === 'active') setToday(calendarDay(new Date())); });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!active) return;
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setToday(calendarDay(new Date())), midnight.getTime() - now.getTime());
    return () => clearTimeout(timer);
  }, [active, today]);

  const openJump = () => { setJumpValue(calendarDayKey(selectedDay)); setJumpError(undefined); setJumpOpen(true); };
  const jump = () => {
    const day = parseCalendarDay(jumpValue);
    if (day === null) { setJumpError('请输入有效日期，例如 2026-11-01。'); return; }
    setSelectedDay(day); setJumpOpen(false);
  };
  const date = calendarDate(selectedDay);
  const dayCount = calendar.counts.find(entry => entry.key === calendarDayKey(selectedDay))?.count;
  const header = <>
    <View style={styles.intro}><Text style={styles.eyebrow}>COMPANION · FRAGMENTS OF TIME</Text><Text style={styles.title}>时间碎片</Text><Text style={styles.subtitle}>在时间深处，与你交汇</Text></View>
    <View onLayout={event => { arcVisibility.current.top = event.nativeEvent.layout.y; arcVisibility.current.height = event.nativeEvent.layout.height; updateArcVisibility(); }}>
      <ProactiveLifeCalendarArc selectedDay={selectedDay} today={today} counts={calendar.counts} onSelect={chooseDay} enabled={active && detailId === null && !jumpOpen} inViewport={arcVisible} reducedMotion={reducedMotion} />
    </View>
    <View style={styles.section}><Text style={styles.sectionDate}>{date.getUTCMonth() + 1} 月 {date.getUTCDate()} 日</Text><Text style={styles.meta}>{dayCount === undefined ? '' : `${dayCount} 项日程`}</Text></View>
    {snapshot && !snapshot.enabled && snapshot.ownerAIId ? <Text style={styles.notice}>主动伴随已关闭，日程已暂停；错过的安排不会补跑。</Text> : null}
    {calendar.error ? <Text style={styles.error} accessibilityRole="alert">{calendar.error}</Text> : null}
  </>;
  const footer = <View style={styles.footer}>
    <View style={styles.footerActions}>
      <Pressable style={styles.footerButton} accessibilityRole="button" onPress={openJump}><CalendarDays size={15} color={light} /><Text style={styles.footerText}>跳转日期</Text></Pressable>
      {calendar.error ? <Pressable style={styles.footerButton} accessibilityRole="button" onPress={calendar.refresh}><Text style={styles.footerText}>重新读取</Text></Pressable> : null}
      {snapshot?.cursor ? <Pressable style={styles.footerButton} disabled={calendar.loadingMore || calendar.loading} accessibilityRole="button" onPress={() => void calendar.loadMore()}>{calendar.loadingMore ? <ActivityIndicator color={light} size="small" /> : <Text style={styles.footerText}>更多当天日程</Text>}</Pressable> : null}
    </View>
    <Text style={styles.note}>日程时间为计划时间，AI 会根据届时情况决定行动。</Text>
  </View>;
  const ambientActive = active && detailId === null && !jumpOpen && !reducedMotion;
  const sky = viewport.width > 0 ? <>
    <GalaxyBackground width={viewport.width} height={viewport.height} paused={!ambientActive} />
    <ShootingStars width={viewport.width} height={viewport.height} active={ambientActive} />
  </> : null;
  const content = <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={styles.navigation}>
        <Pressable style={styles.iconButton} accessibilityRole="button" accessibilityLabel="返回" onPress={onBack}><ChevronLeft size={23} color={light} /></Pressable>
        <Text style={styles.navTitle}>主动伴随</Text>
        {/* 「今天」已移到日期导航条中间；这里保留等宽占位，避免标题偏移。 */}
        <View style={styles.navSpacer} />
      </View>
      {/* Android 下拉刷新容器会重新布局内部 ScrollView；可见范围由外层 Yoga 容器拥有。 */}
      <View style={styles.list} onLayout={event => { arcVisibility.current.viewportHeight = event.nativeEvent.layout.height; updateArcVisibility(); }}>
      <FlatList style={styles.list} contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 28 }]}
        onScroll={event => { arcVisibility.current.scrollY = event.nativeEvent.contentOffset.y; updateArcVisibility(); }} scrollEventThrottle={64}
        data={snapshot?.items ?? []} keyExtractor={entry => entry.item.sourceId}
        ListHeaderComponent={header} ListFooterComponent={footer}
        ListEmptyComponent={calendar.loading ? <View style={styles.loading}><ActivityIndicator color={light} /><Text style={styles.meta}>正在读取时间碎片…</Text></View>
          : calendar.error ? null : <Text style={styles.empty}>{snapshot?.ownerAIId ? '这块时间碎片，还没有留下安排。' : '选择主理 AI 后，这里会留下你们的日程与足迹。'}</Text>}
        renderItem={({ item, index }) => <CalendarEntry entry={item} featured={index === 0} styles={styles} onPress={() => setDetailId(item.item.sourceId)} />}
        refreshControl={<RefreshControl tintColor={light} colors={[light]} refreshing={calendar.loading && snapshot !== null} onRefresh={calendar.refresh} />}
        onEndReached={() => void calendar.loadMore()} onEndReachedThreshold={0.3}
      />
      </View>
    </SafeAreaView>;

  return <GlassSceneProvider sceneId={sceneId}>
    <View style={styles.screen} onLayout={event => setViewport(event.nativeEvent.layout)}>
      {/* 玻璃只采样不透明的星空；正文在源外正常绘制，不能被再次折射进弹层。 */}
      {theme.effects.glass.enabled ? <GlassBackdrop sceneId={sceneId} style={[styles.screen, StyleSheet.absoluteFill]}>{sky}</GlassBackdrop> : sky}
      {content}
      <ModalSheet visible={detailId !== null && focused} onClose={closeDetail} title="日程" onDark={darkSheet}>
        {detailId && snapshot?.ownerAIId ? <AIScheduleDetailContent key={`${snapshot.ownerAIId}:${detailId}`} scheduleId={detailId} ownerAIId={snapshot.ownerAIId} onClose={closeDetail} onCancelled={calendar.refresh} /> : null}
      </ModalSheet>
      <ModalSheet visible={jumpOpen && focused} onClose={() => setJumpOpen(false)} title="跳转日期" onDark={darkSheet}>
        <View style={styles.modalBody}><InputField label="日期" value={jumpValue} onChangeText={setJumpValue} placeholder="YYYY-MM-DD" maxLength={10} autoCorrect={false} error={jumpError} onDark={darkSheet} /><Button title="前往这一天" onPress={jump} /></View>
      </ModalSheet>
    </View>
  </GlassSceneProvider>;
}

function CalendarEntry({ entry, featured, styles, onPress }: {
  entry: ProactiveLifeCalendarItem; featured: boolean; styles: ReturnType<typeof createStyles>; onPress: () => void;
}) {
  const at = entry.kind === 'future' ? entry.item.plannedAt : entry.kind === 'running' ? entry.item.startedAt : entry.item.occurredAt;
  const status = entry.kind === 'future' ? '计划时间'
    : entry.kind === 'running' ? entry.item.modelResponded ? 'AI 已响应 · 正在行动' : '等待 AI 响应'
    : proactiveLifeCompletionDispositionLabel(entry.item.completionDisposition, entry.item.modelResponded);
  if (featured) return <Pressable style={styles.featured} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${formatProactiveLifeClock(at)}，${entry.item.summary}，${status}，查看日程详情`}>
    <Text style={styles.featuredLabel}>{entry.kind === 'future' ? '下一次计划' : entry.kind === 'running' ? '正在发生' : '已留下的足迹'}</Text>
    <Text style={styles.featuredTime}>{formatProactiveLifeClock(at)}</Text>
    <View style={styles.featuredRow}><Text style={styles.featuredTitle}>{entry.item.summary}</Text><Text style={styles.detailLink}>详情 ↗</Text></View>
    {entry.kind !== 'future' ? <Text style={styles.entryStatus}>{status}</Text> : null}
  </Pressable>;
  return <Pressable style={styles.entry} onPress={onPress} accessibilityRole="button">
    <Text style={styles.entryTime}>{formatProactiveLifeClock(at)}</Text><View style={styles.entryBody}><Text style={styles.entryTitle}>{entry.item.summary}</Text><Text style={styles.entryStatus}>{status}</Text></View><Text style={styles.detailLink}>↗</Text>
  </Pressable>;
}
