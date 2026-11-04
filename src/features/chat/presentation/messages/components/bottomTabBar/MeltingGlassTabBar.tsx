/** 单一原生玻璃表面同时绘制栏体与凸起，避免重叠采样与接缝。 */
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedProps, useAnimatedStyle, useDerivedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface, useTheme } from '@shared/theme';
import { FLOATING_TAB_BAR_EDGE_GAP, FLOATING_TAB_BAR_HEIGHT } from '@shared/ui';
import { ActiveTabGlyph, TabBarItems, TABS, useTabMotion, type BottomTabBarVariantProps } from './tabBarShared';

const HEADROOM = 28;
const RADIUS = 24;
const CENTER_Y = 26;

export default function MeltingGlassTabBar(props: BottomTabBarVariantProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const { position, trail } = useTabMotion(props.activeTab);
  const itemWidth = (width - 16) / TABS.length;
  const shape = useDerivedValue(() => {
    // 形变取自实际运动的滞后量，而非距新目标的距离；快速改向不会瞬间拉长。
    const lag = Math.max(-1, Math.min(1, position.value - trail.value));
    const stretch = Math.abs(lag);
    return [HEADROOM, 8 + (position.value + 0.5) * itemWidth - lag * 3,
      CENTER_Y + stretch * 3, RADIUS + stretch * 7, RADIUS - stretch * 3, 16 + stretch * 8];
  });
  const animatedProps = useAnimatedProps(() => ({ fluidShape: shape.value }));
  const iconStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: shape.value[1] - (8 + itemWidth / 2) },
      { translateY: shape.value[2] - CENTER_Y },
    ] as const,
  }));

  return (
    <View pointerEvents="box-none" onLayout={event => setWidth(event.nativeEvent.layout.width)}
      style={[styles.dock, {
        left: 16 + insets.left, right: 16 + insets.right,
        bottom: Math.max(insets.bottom, FLOATING_TAB_BAR_EDGE_GAP) + FLOATING_TAB_BAR_EDGE_GAP,
      }]}>
      {width > 0 && (
        <>
          <GlassSurface pointerEvents="none" bordered={false} animatedProps={animatedProps}
            material={{ cornerRadius: 32 }} style={styles.material} />
          <Animated.View pointerEvents="none" accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.ballContent, { left: 8 + itemWidth / 2 - RADIUS }, iconStyle]}>
            <ActiveTabGlyph activeTab={props.activeTab} unreadCount={props.unreadCount ?? 0}
              color={theme.colors.brand.primary} />
          </Animated.View>
        </>
      )}
      <View pointerEvents="box-none" style={styles.items}>
        <TabBarItems {...props} height={HEADROOM + FLOATING_TAB_BAR_HEIGHT} headroom={HEADROOM} />
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  dock: { position: 'absolute', height: HEADROOM + FLOATING_TAB_BAR_HEIGHT },
  material: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
  ballContent: { position: 'absolute', top: CENTER_Y - RADIUS, width: RADIUS * 2, height: RADIUS * 2 },
  items: { ...StyleSheet.absoluteFillObject, left: 8, right: 8 },
});
