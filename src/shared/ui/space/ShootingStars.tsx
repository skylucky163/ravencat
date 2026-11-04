/** 页面传入统一前台生命周期；最多一条流星，暂停时同时释放计时器和飞行动画。 */
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { getThemeById } from '@shared/theme';

export default function ShootingStars({ width, height, active }: { width: number; height: number; active: boolean }) {
  const [visible, setVisible] = useState(false);
  const finish = useCallback(() => setVisible(false), []);
  useEffect(() => {
    setVisible(false);
    if (!active) return;
    const timer = setInterval(() => { if (Math.random() > 0.4) setVisible(true); }, 5000);
    return () => clearInterval(timer);
  }, [active, width, height]);
  return active && visible ? <ShootingStarFlight width={width} height={height} onDone={finish} /> : null;
}

/** 飞行几何只在出生时计算，后续帧沿用记忆页原有的方向与先亮后暗效果。 */
function ShootingStarFlight({ width, height, onDone }: { width: number; height: number; onDone: () => void }) {
  const [config] = useState(() => {
    const startX = Math.random() * width * 0.6;
    const startY = Math.random() * height * 0.4;
    const angle = Math.random() * 25 + 25;
    const length = 80 + Math.random() * 100;
    const distance = 250 + Math.random() * 200;
    const rad = angle * Math.PI / 180;
    return { startX, startY, angle, length, endX: startX + Math.cos(rad) * distance,
      endY: startY + Math.sin(rad) * distance, duration: 900 + Math.random() * 500 };
  });
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(1, { duration: config.duration, easing: Easing.linear }, finished => {
      if (finished) runOnJS(onDone)();
    });
    return () => cancelAnimation(progress);
  }, [config.duration, onDone, progress]);
  const motion = useAnimatedStyle<ViewStyle>(() => {
    const t = progress.value, ease = 1 - (1 - t) ** 3;
    const x = config.startX + (config.endX - config.startX) * ease;
    const y = config.startY + (config.endY - config.startY) * ease;
    const opacity = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    return { opacity: opacity * 0.64, transform: [{ translateX: x }, { translateY: y }, { rotate: `${config.angle}deg` }] as const };
  });
  return <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.star, { width: config.length }, motion]} />;
}

const styles = StyleSheet.create({
  star: { position: 'absolute', left: 0, top: 0, height: 1.5, borderRadius: 1, backgroundColor: getThemeById('default-dark').colors.text.primary },
});
