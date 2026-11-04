/** 开放弧线保留九个日期节点；日期身份不变，只在屏幕外增删边缘节点。 */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { getThemeById, useThemedStyles } from '@shared/theme';
import type { ProactiveLifeDayCount } from '../application/ProactiveLifeReadQueries';
import { calendarDate, calendarDayKey, CALENDAR_NODE_COUNT, fragmentMaterialIndex } from './proactiveLifeCalendar';
import { FRAGMENT_TEXTURES } from './fragmentTextures';
import FragmentMaterial from './FragmentMaterial';
import ProactiveLifeArcLights from './ProactiveLifeArcLights';
import { dateArcY } from './proactiveLifeArcGeometry';
import { createStyles } from './ProactiveLifeCalendarArc.styles';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
type Styles = ReturnType<typeof createStyles>;

const DateFragment = memo(function DateFragment({ day, center, position, width, count, onSelect, styles, enabled, motionActive }: {
  day: number; center: number; position: SharedValue<number>; width: number; count: number | undefined;
  onSelect: (day: number) => void; styles: Styles; enabled: boolean; motionActive: boolean;
}) {
  const step = (width - 64) / 4;
  const hitWidth = Math.min(72, step);
  const date = calendarDate(day);
  const material = FRAGMENT_TEXTURES[fragmentMaterialIndex(day, FRAGMENT_TEXTURES.length)];
  const inView = Math.abs(day - center) <= 2;
  const rotation = useSharedValue(((day * 17 % 31) + 31) % 31 - 15);
  useEffect(() => {
    if (motionActive && inView) {
      const direction = day % 2 === 0 ? 1 : -1;
      rotation.value = withRepeat(withTiming(rotation.value + direction * 360, {
        duration: 100_000 + ((day % 5) + 5) % 5 * 10_000, easing: Easing.linear,
      }), -1);
    }
    return () => cancelAnimation(rotation);
  }, [day, inView, motionActive, rotation]);
  const motion = useAnimatedStyle<ViewStyle>(() => {
    const distance = day - position.value, dx = distance * step;
    const depth = 1 - Math.min(1, Math.abs(distance) / 3.2);
    return { opacity: 0.36 + depth * 0.64, zIndex: Math.round(depth * 10), transform: [
      { translateX: width / 2 + dx - hitWidth / 2 }, { translateY: dateArcY(width / 2 + dx, width) - 28 },
    ] as const };
  });
  const materialMotion = useAnimatedStyle<ViewStyle>(() => ({ transform: [
    { scale: 0.62 + (1 - Math.min(1, Math.abs(day - position.value) / 3.2)) * 0.38 },
    { rotate: `${rotation.value}deg` },
  ] as const }));
  return <Animated.View style={[styles.node, { width: hitWidth }, motion]}>
    <Pressable style={{ alignItems: 'center', width: hitWidth }} disabled={!enabled || !inView} importantForAccessibility={inView ? 'auto' : 'no-hide-descendants'}
      accessibilityRole="button" accessibilityState={{ selected: day === center }}
      accessibilityLabel={`${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日${count === undefined ? '' : `，${count}项日程`}`}
      onPress={() => onSelect(day)}>
      <Animated.View style={[styles.rock, materialMotion]} pointerEvents="none"><FragmentMaterial texture={material} /></Animated.View>
      <Text style={[styles.date, day === center && styles.selectedDate]}>{`${String(date.getUTCMonth() + 1).padStart(2, '0')}·${String(date.getUTCDate()).padStart(2, '0')}`}</Text>
      <Text style={styles.count}>{count ? `${count} 项日程` : ' '}</Text>
    </Pressable>
  </Animated.View>;
});

function ProactiveLifeCalendarArc({ selectedDay, today, counts, onSelect, enabled, inViewport, reducedMotion }: {
  selectedDay: number; today: number; counts: ProactiveLifeDayCount[]; onSelect: (day: number) => void; enabled: boolean; inViewport: boolean; reducedMotion: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const light = getThemeById('default-dark').colors.text.primary;
  const motionActive = enabled && inViewport && !reducedMotion;
  const [width, setWidth] = useState(0);
  const [center, setCenter] = useState(selectedDay);
  const position = useSharedValue(selectedDay), origin = useSharedValue(selectedDay), renderedCenter = useSharedValue(selectedDay);
  const countsByKey = useMemo(() => new Map(counts.map(item => [item.key, item.count])), [counts]);
  const recenter = useCallback((day: number) => setCenter(day), []);
  const select = useCallback((day: number) => {
    cancelAnimation(position);
    position.value = withTiming(day, { duration: reducedMotion ? 0 : 280 }, finished => {
      if (finished) { renderedCenter.value = day; runOnJS(recenter)(day); runOnJS(onSelect)(day); }
    });
  }, [onSelect, position, recenter, reducedMotion, renderedCenter]);
  useEffect(() => {
    renderedCenter.value = selectedDay;
    setCenter(selectedDay);
    position.value = withTiming(selectedDay, { duration: reducedMotion || Math.abs(position.value - selectedDay) > 4 ? 0 : 280 });
  }, [selectedDay, position, reducedMotion, renderedCenter]);
  useEffect(() => {
    if (!enabled) { cancelAnimation(position); position.value = selectedDay; renderedCenter.value = selectedDay; setCenter(selectedDay); }
    return () => cancelAnimation(position);
  }, [enabled, position, renderedCenter, selectedDay]);
  const gesture = Gesture.Pan().enabled(enabled && width > 0).activeOffsetX([-8, 8]).failOffsetY([-12, 12])
    .onStart(() => { cancelAnimation(position); origin.value = position.value; })
    .onUpdate(event => {
      position.value = origin.value - event.translationX / ((width - 64) / 4);
      const nearest = Math.round(position.value);
      if (nearest !== renderedCenter.value) { renderedCenter.value = nearest; runOnJS(recenter)(nearest); }
    })
    .onEnd(() => {
      const day = Math.round(position.value);
      position.value = withTiming(day, { duration: reducedMotion ? 0 : 220 }, finished => {
        if (finished) { renderedCenter.value = day; runOnJS(recenter)(day); runOnJS(onSelect)(day); }
      });
    });
  const date = calendarDate(center);
  const path = useMemo(() => Array.from({ length: 49 }, (_, i) => {
    const x = -24 + (width + 48) * i / 48;
    return `${i ? 'L' : 'M'}${x},${dateArcY(x, width)}`;
  }).join(' '), [width]);
  return <>
    <View style={styles.heading}><Text style={styles.month}>{date.getUTCFullYear()} 年 {date.getUTCMonth() + 1} 月</Text><Text style={styles.weekday}>星期{WEEK[date.getUTCDay()]}</Text></View>
    <GestureDetector gesture={gesture}><View style={styles.arc} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      {width > 0 && <>
        <Svg pointerEvents="none" width={width} height={250} style={{ position: 'absolute' }}>
          <Defs><LinearGradient id="date-arc" x1="0%" y1="0%" x2="100%" y2="0%"><Stop offset="0" stopColor={light} stopOpacity={0} /><Stop offset="0.5" stopColor={light} stopOpacity={0.3} /><Stop offset="1" stopColor={light} stopOpacity={0} /></LinearGradient></Defs>
          <Path d={path} stroke="url(#date-arc)" strokeWidth={1} fill="none" />
        </Svg>
        <ProactiveLifeArcLights width={width} selectedDay={selectedDay} active={motionActive} />
        {Array.from({ length: CALENDAR_NODE_COUNT }, (_, i) => {
          const day = center + i - 4;
          // 同一天保留原生图片和蒙版实例；位置 key 会在每次跨日时重载所有可见材质。
          return <DateFragment key={day} day={day} center={center} position={position} width={width} count={countsByKey.get(calendarDayKey(day))} onSelect={select} styles={styles} enabled={enabled} motionActive={motionActive} />;
        })}
      </>}
      <View style={styles.directions} pointerEvents="none"><Text style={styles.directionText}>过去</Text><Text style={styles.directionText}>未来</Text></View>
    </View></GestureDetector>
    <View style={styles.navigation}><Pressable disabled={!enabled} accessibilityRole="button" accessibilityLabel="前一天" onPress={() => onSelect(selectedDay - 1)} style={styles.arrow}><ChevronLeft size={16} color={light} /></Pressable><Pressable disabled={!enabled} accessibilityRole="button" accessibilityLabel="回到今天" onPress={() => onSelect(today)}><Text style={[styles.today, center === today && styles.todayActive]}>今天</Text></Pressable><Pressable disabled={!enabled} accessibilityRole="button" accessibilityLabel="后一天" onPress={() => onSelect(selectedDay + 1)} style={styles.arrow}><ChevronRight size={16} color={light} /></Pressable></View>
  </>;
}

export default memo(ProactiveLifeCalendarArc);
