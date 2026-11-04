/** 光点与照片分层：固定二十个小图元，只在 UI 线程更新变换和透明度。 */
import React, { memo, useEffect } from 'react';
import { View, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, type SharedValue } from 'react-native-reanimated';
import { useThemedStyles } from '@shared/theme';
import { dateArcY } from './proactiveLifeArcGeometry';
import { createStyles } from './ProactiveLifeCalendarArc.styles';

type Particle =
  | { kind: 'ambient'; x: number; y: number }
  | { kind: 'flow'; phase: number }
  | { kind: 'focus'; x: number; y: number };

const PARTICLES: Particle[] = [
  ...[[0.08, 24], [0.21, 124], [0.35, 20], [0.45, 178], [0.64, 38],
    [0.78, 156], [0.92, 59], [0.17, 205], [0.60, 219], [0.87, 210]]
    .map(([x, y]): Particle => ({ kind: 'ambient', x, y })),
  ...[0, 1 / 3, 2 / 3].map((phase): Particle => ({ kind: 'flow', phase })),
  ...[[-31, -19], [22, -26], [36, 6], [-23, 21], [41, -14], [-40, -1], [16, 22]]
    .map(([x, y]): Particle => ({ kind: 'focus', x, y })),
];

const LightPoint = memo(function LightPoint({ particle, index, width, clock, arrival, styles }: {
  particle: Particle; index: number; width: number; clock: SharedValue<number>; arrival: SharedValue<number>;
  styles: ReturnType<typeof createStyles>;
}) {
  const motion = useAnimatedStyle<ViewStyle>(() => {
    const angle = clock.value * Math.PI * 2 + index * 1.9;
    let x: number, y: number, opacity: number;
    let scale = 1;
    if (particle.kind === 'flow') {
      const progress = (clock.value + particle.phase) % 1;
      x = -24 + (width + 48) * progress;
      y = dateArcY(x, width);
      opacity = Math.sin(progress * Math.PI) * 0.75;
      scale = 0.8 + Math.sin(progress * Math.PI) * 0.3;
    } else if (particle.kind === 'focus') {
      // 选中位置固定在弧顶，拖动跨日时光点不会跟着最近节点突然跳边。
      x = width / 2 + particle.x * (1 + arrival.value * 0.25) + Math.sin(angle) * 1.5;
      y = dateArcY(width / 2, width) + particle.y * (1 + arrival.value * 0.25) + Math.cos(angle) * 1.5;
      opacity = 0.12 + (Math.sin(angle) + 1) * 0.09 + arrival.value * 0.3;
    } else {
      x = width * particle.x + Math.sin(angle) * 2;
      y = particle.y + Math.cos(angle) * 2;
      opacity = 0.18 + (Math.sin(angle) + 1) * 0.15;
      scale = 0.7;
    }
    return { opacity, transform: [{ translateX: x - 9 }, { translateY: y - 9 }, { scale }] as const };
  });
  return <Animated.View style={[styles.spark, motion]}>
    <View style={styles.sparkHalo} /><View style={styles.sparkGlow} /><View style={styles.sparkCore} />
  </Animated.View>;
});

function ProactiveLifeArcLights({ width, selectedDay, active }: { width: number; selectedDay: number; active: boolean }) {
  const styles = useThemedStyles(createStyles);
  const clock = useSharedValue(0);
  const arrival = useSharedValue(0);

  useEffect(() => {
    if (active) clock.value = withRepeat(withTiming(clock.value + 1, { duration: 12_000, easing: Easing.linear }), -1);
    return () => cancelAnimation(clock);
  }, [active, clock]);

  useEffect(() => {
    if (active) arrival.value = withSequence(withTiming(1, { duration: 180 }), withTiming(0, { duration: 900 }));
    else arrival.value = 0;
    return () => cancelAnimation(arrival);
  }, [active, arrival, selectedDay]);

  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.lights, { opacity: active ? 1 : 0 }]}>
    {PARTICLES.map((particle, index) => <LightPoint key={index} particle={particle} index={index} width={width} clock={clock} arrival={arrival} styles={styles} />)}
  </View>;
}

export default memo(ProactiveLifeArcLights);
