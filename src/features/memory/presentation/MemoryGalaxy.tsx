/** 星空只拥有视觉坐标与交互；空间事实和导航由上层提供。 */
import React, { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, State } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue,
  withRepeat, withSequence, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { MemoryManagementSnapshot } from '../application/MemoryQueries';
import { createMemoryGalaxyStyles } from './memoryGalaxyStyles';
import { NEAR_STAR_LAYERS, type GalaxyStar } from '@shared/ui/space/starField';
import MemoryPlanet, { type PlanetTexture } from './MemoryPlanet';

const SPACES_PER_PAGE = 6;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.8;
type GalaxySpace = MemoryManagementSnapshot['spaces'][number];
const ORBIT_LANES = [{ x: 0.76, y: 0.62 }, { x: 0.9, y: 0.82 }, { x: 1, y: 1 }];
const PRIMARY_TEXTURE: PlanetTexture = {
  source: require('./assets/neptune.png'), frame: { x: 18, y: 18, width: 92, height: 92 }, rotation: 0,
};
// 取景按 NASA 原图的圆盘位置校准；不缩放生成第二套图片，也不根据像素猜测留白。
const SATELLITE_TEXTURES: PlanetTexture[] = [
  { source: require('./assets/mars.jpg'), frame: { x: 16, y: 16, width: 96, height: 96 }, rotation: 0 },
  { source: require('./assets/jupiter.jpg'), frame: { x: -15, y: 21, width: 154, height: 87 }, rotation: 0 },
  { source: require('./assets/mercury.jpg'), frame: { x: 20, y: 20, width: 88, height: 88 }, rotation: 0 },
  { source: require('./assets/europa.jpg'), frame: { x: 20, y: 19, width: 88, height: 65 }, rotation: 0 },
  { source: require('./assets/ganymede.jpg'), frame: { x: 7, y: 19.5, width: 118, height: 88.5 }, rotation: 180 },
];

function BackgroundStar({ star, width, height, touchX, touchY, pulse, color }: {
  star: GalaxyStar; width: number; height: number; color: string;
  touchX: SharedValue<number>; touchY: SharedValue<number>; pulse: SharedValue<number>;
}) {
  const animated = useAnimatedStyle<ViewStyle>(() => {
    let x = 0, y = 0;
    // 避让只在轻触脉冲期间计算，日常闪烁不计算距离。
    if (pulse.value > 0) {
      const dx = star.x * width - touchX.value;
      const dy = star.y * height - touchY.value;
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < 150) {
        const force = (1 - distance / 150) ** 2 * 35 * pulse.value;
        x = dx / distance * force;
        y = dy / distance * force;
      }
    }
    return {
      transform: [{ translateX: x }, { translateY: y }] as const,
    };
  });
  return <Animated.View style={[
    { position: 'absolute', left: star.x * width, top: star.y * height, width: star.size, height: star.size, borderRadius: star.size / 2, backgroundColor: color, opacity: 0.4 + star.brightness * 0.6 }, animated,
  ]} />;
}

function StarLayer({ stars, layer, width, height, phase, touchX, touchY, pulse, color }: {
  stars: GalaxyStar[]; layer: number; width: number; height: number; color: string;
  phase: SharedValue<number>; touchX: SharedValue<number>; touchY: SharedValue<number>; pulse: SharedValue<number>;
}) {
  // 闪烁只更新三个层的透明度，28 个星点仅在触摸期间更新位置。
  const twinkle = useAnimatedStyle(() => ({ opacity: 0.5 + Math.sin(phase.value * Math.PI * 2 + layer * 2.4) * 0.25 }));
  return <Animated.View style={[StyleSheet.absoluteFill, twinkle]}>
    {stars.map((star, i) => <BackgroundStar key={i} star={star} width={width} height={height} color={color} touchX={touchX} touchY={touchY} pulse={pulse} />)}
  </Animated.View>;
}

function SpacePlanet({ space, texture, primary, index, count, width, height, orbitX, orbitY, rotation, phase, starOrbit, onSelect, disabled }: {
  space: GalaxySpace; index: number; count: number; width: number; height: number;
  primary: boolean; orbitX: number; orbitY: number;
  texture: PlanetTexture;
  rotation: SharedValue<number>; phase: SharedValue<number>; starOrbit: SharedValue<number>;
  onSelect(assistantId: string): void; disabled: boolean;
}) {
  const styles = useThemedStyles(createMemoryGalaxyStyles);
  const diameter = primary ? (count === 0 ? 116 : 96) : 32 + Math.min(12, Math.log2(1 + space.memoryCount) * 2.1);
  const canvasSize = diameter * 1.6;
  const buttonWidth = primary ? 184 : 104;
  const lane = ORBIT_LANES[index % ORBIT_LANES.length];
  const position = useAnimatedStyle<ViewStyle>(() => {
    if (primary) return { zIndex: 1 };
    const angle = index / count * Math.PI * 2 - Math.PI / 2 + rotation.value * Math.PI / 180;
    const depth = (Math.sin(angle) + 1) / 2;
    return {
      zIndex: depth > 0.5 ? 2 : 0,
      opacity: 0.64 + depth * 0.36,
      transform: [{ translateX: Math.cos(angle) * orbitX * lane.x }, { translateY: Math.sin(angle) * orbitY * lane.y }, { scale: 0.86 + depth * 0.14 }] as const,
    };
  });
  return <Animated.View style={[styles.spacePlanet, { width: buttonWidth, left: width / 2 - buttonWidth / 2, top: height / 2 - canvasSize / 2 }, position]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`打开${space.assistantName}的记忆空间，${space.memoryCount}条记忆`} disabled={disabled} onPress={() => onSelect(space.assistantId)} style={({ pressed }) => [styles.spaceButton, pressed && styles.pressedPlanet]}>
      <View style={[styles.planetBody, { width: canvasSize, height: canvasSize }]}>
        <MemoryPlanet memoryCount={space.memoryCount} phase={phase} starOrbit={starOrbit} texture={texture} primary={primary} diameter={diameter} />
      </View>
      <Text style={[styles.planetName, primary && styles.primaryPlanetName]} numberOfLines={1}>{space.assistantName}</Text>
      {space.isHost && <Text style={styles.planetMeta}>主理空间</Text>}
    </Pressable>
  </Animated.View>;
}

function MemoryGalaxy({ spaces, paused, disabled, onSelect }: {
  spaces: GalaxySpace[]; paused: boolean; disabled: boolean; onSelect(assistantId: string): void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createMemoryGalaxyStyles);
  const starlight = theme.mode === 'dark' ? theme.colors.text.primary : theme.colors.text.inverse;
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [page, setPage] = useState(0);
  // 主理空间固定在中心；没有主理身份时，首个空间作为本页的视觉中心。
  const primarySpace = spaces.find(space => space.isHost) ?? spaces[0];
  const satellites = useMemo(() => spaces.filter(space => space.assistantId !== primarySpace.assistantId), [spaces, primarySpace.assistantId]);
  const pageCount = Math.max(1, Math.ceil(satellites.length / (SPACES_PER_PAGE - 1)));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleSpaces = useMemo(() => satellites.slice(currentPage * (SPACES_PER_PAGE - 1), (currentPage + 1) * (SPACES_PER_PAGE - 1)), [satellites, currentPage]);
  const textures = useMemo(() => {
    const assigned = new Map<string, PlanetTexture>();
    const used = new Set<number>();
    // 每页最多五个外围空间，五种素材保证页内无重复；固定身份顺序让事实刷新不洗牌。
    for (const space of [...visibleSpaces].sort((a, b) => a.assistantId.localeCompare(b.assistantId))) {
      let hash = 0;
      for (const character of space.assistantId) hash = Math.imul(hash, 31) + character.charCodeAt(0);
      let index = (hash >>> 0) % SATELLITE_TEXTURES.length;
      while (used.has(index)) index = (index + 1) % SATELLITE_TEXTURES.length;
      used.add(index);
      assigned.set(space.assistantId, SATELLITE_TEXTURES[index]);
    }
    return assigned;
  }, [visibleSpaces]);
  const orbitX = Math.max(0, viewport.width / 2 - 60);
  const orbitY = Math.max(0, viewport.height / 2 - 72);
  const reducedMotion = useReducedMotion();
  const phase = useSharedValue(0);
  const rotation = useSharedValue(0);
  const starOrbit = useSharedValue(0);
  const pulse = useSharedValue(0);
  const touchX = useSharedValue(-1000);
  const touchY = useSharedValue(-1000);
  const scale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const pinchStartScale = useSharedValue(1);
  const pinchStartX = useSharedValue(0);
  const pinchStartY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const active = !paused && !reducedMotion;

  const reset = () => { scale.value = 1; offsetX.value = 0; offsetY.value = 0; };
  useEffect(() => {
    scale.value = 1;
    offsetX.value = 0;
    offsetY.value = 0;
  }, [viewport.width, viewport.height, currentPage, scale, offsetX, offsetY]);

  useEffect(() => {
    if (active) {
      phase.value = withRepeat(withTiming(phase.value + 1, { duration: 12000, easing: Easing.linear }), -1);
      rotation.value = withRepeat(withTiming(rotation.value + 360, { duration: 180000, easing: Easing.linear }), -1);
      starOrbit.value = withRepeat(withTiming(starOrbit.value + 360, { duration: 45000, easing: Easing.linear }), -1);
    }
    return () => {
      cancelAnimation(phase);
      cancelAnimation(rotation);
      cancelAnimation(starOrbit);
      cancelAnimation(pulse);
      pulse.value = 0;
    };
  }, [active, phase, rotation, starOrbit, pulse]);

  const pan = Gesture.Pan().enabled(!paused && !disabled).maxPointers(1).minDistance(8)
    .onStart(() => { panStartX.value = offsetX.value; panStartY.value = offsetY.value; })
    .onUpdate(e => {
      offsetX.value = Math.max(-viewport.width * 0.6, Math.min(viewport.width * 0.6, panStartX.value + e.translationX));
      offsetY.value = Math.max(-viewport.height * 0.6, Math.min(viewport.height * 0.6, panStartY.value + e.translationY));
    });
  const pinch = Gesture.Pinch().enabled(!paused && !disabled)
    .onTouchesUp((event, manager) => {
      // Android 会在第一根手指抬起后继续更新单指焦点；先结束双指缩放，保留最后的双指位置。
      if (event.state === State.ACTIVE && event.numberOfTouches < 2) manager.end();
    })
    .onStart(e => {
      pinchStartScale.value = scale.value;
      pinchStartX.value = offsetX.value;
      pinchStartY.value = offsetY.value;
      focalX.value = e.focalX - viewport.width / 2;
      focalY.value = e.focalY - viewport.height / 2;
    })
    .onUpdate(e => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale.value * e.scale));
      const ratio = next / pinchStartScale.value;
      offsetX.value = Math.max(-viewport.width * 0.6, Math.min(viewport.width * 0.6, e.focalX - viewport.width / 2 - (focalX.value - pinchStartX.value) * ratio));
      offsetY.value = Math.max(-viewport.height * 0.6, Math.min(viewport.height * 0.6, e.focalY - viewport.height / 2 - (focalY.value - pinchStartY.value) * ratio));
      scale.value = next;
    });
  const worldTransform = useAnimatedStyle<ViewStyle>(() => ({ transform: [{ translateX: offsetX.value }, { translateY: offsetY.value }, { scale: scale.value }] as const }));

  return <View style={styles.sky}>
    <GestureDetector gesture={Gesture.Simultaneous(pan, pinch)}>
      <View collapsable={false} style={styles.sky} onLayout={({ nativeEvent: { layout } }) => setViewport({ width: layout.width, height: layout.height })}>
        <Pressable accessible={false} style={StyleSheet.absoluteFill} disabled={!active || disabled} onPress={e => {
          touchX.value = e.nativeEvent.locationX;
          touchY.value = e.nativeEvent.locationY;
          pulse.value = withSequence(withTiming(1, { duration: 180 }), withSpring(0, { damping: 12, stiffness: 65 }));
        }} />
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {NEAR_STAR_LAYERS.map((stars, i) => <StarLayer key={i} stars={stars} layer={i} width={viewport.width} height={viewport.height} color={starlight} phase={phase} touchX={touchX} touchY={touchY} pulse={pulse} />)}
        </View>
        <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, worldTransform]}>
          <SpacePlanet space={primarySpace} texture={PRIMARY_TEXTURE} primary index={0} count={visibleSpaces.length} width={viewport.width} height={viewport.height} orbitX={orbitX} orbitY={orbitY} rotation={rotation} phase={phase} starOrbit={starOrbit} onSelect={onSelect} disabled={disabled || paused} />
          {visibleSpaces.map((space, i) => <SpacePlanet key={space.poolId} space={space} texture={textures.get(space.assistantId)!} primary={false} index={i} count={visibleSpaces.length} width={viewport.width} height={viewport.height} orbitX={orbitX} orbitY={orbitY} rotation={rotation} phase={phase} starOrbit={starOrbit} onSelect={onSelect} disabled={disabled || paused} />)}
        </Animated.View>
      </View>
    </GestureDetector>
    <View style={styles.galaxyControls}>
      {pageCount > 1 && <Pressable accessibilityRole="button" accessibilityLabel="上一组记忆空间" disabled={disabled || paused || currentPage === 0} onPress={() => setPage(currentPage - 1)}><Text style={styles.subtitle}>上一组</Text></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="复位记忆星空" disabled={disabled || paused} onPress={reset}><Text style={styles.galaxyHint}>{pageCount > 1 ? `${currentPage + 1} / ${pageCount} · ` : ''}拖动 · 双指缩放 · 点此复位</Text></Pressable>
      {pageCount > 1 && <Pressable accessibilityRole="button" accessibilityLabel="下一组记忆空间" disabled={disabled || paused || currentPage === pageCount - 1} onPress={() => setPage(currentPage + 1)}><Text style={styles.subtitle}>下一组</Text></Pressable>}
    </View>
  </View>;
}

export default memo(MemoryGalaxy);
