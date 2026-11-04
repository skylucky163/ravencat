/** 普通主题的悬浮图标与凹槽共用一个位移，主题只负责配色。 */
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedProps, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@shared/theme';
import { buildScoopedBarPath, SCOOPED_BAR_TOP } from './tabBarPaths';
import { ActiveTabGlyph, TabBarItems, TABS, useTabMotion, type BottomTabBarVariantProps } from './tabBarShared';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const HEIGHT = 78;
const GLYPH_SIZE = 25;
// 悬浮图标中心落在凹槽内并轻微探出栏顶（凹槽深 20–52，中心 36）：
// 纯图标不需要像原球体那样大半探出栏外，挂太高会显得飘。
const FLOAT_CENTER_Y = 32;

export default function FloatingBallTabBar(props: BottomTabBarVariantProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);
  const { position } = useTabMotion(props.activeTab);
  const itemWidth = width / TABS.length;
  const height = HEIGHT + Math.max(8, insets.bottom);
  const tokens = theme.components.tabBar;
  const path = useAnimatedProps(() => ({
    d: buildScoopedBarPath((position.value + 0.5) * itemWidth, width, height, Math.min(44, itemWidth * 0.48)),
  }));
  const floatStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.value * itemWidth }],
  }));

  return (
    // 悬浮在页面内容之上（与 MeltingGlass 变体一致）：栏顶条带与凹槽透明，
    // 悬浮图标直接浮在页面内容前；四个 Tab 场景已用 useFloatingTabBarScrollPadding 预留底部空间。
    <View pointerEvents="box-none"
      style={[styles.dock, { height, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View pointerEvents="box-none" style={styles.container}
        onLayout={event => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 && (
          <>
            <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
              <AnimatedPath animatedProps={path} fill={tokens.backgroundColor}
                stroke={tokens.borderColor} strokeWidth={StyleSheet.hairlineWidth} />
            </Svg>
            <Animated.View pointerEvents="none" accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.floatIcon, { left: itemWidth / 2 - GLYPH_SIZE / 2,
                top: FLOAT_CENTER_Y - GLYPH_SIZE / 2 }, floatStyle]}>
              <ActiveTabGlyph activeTab={props.activeTab} unreadCount={props.unreadCount ?? 0}
                color={theme.colors.brand.primary} />
            </Animated.View>
          </>
        )}
        <TabBarItems {...props} height={HEIGHT} headroom={SCOOPED_BAR_TOP} />
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  container: { flex: 1 },
  floatIcon: { position: 'absolute', width: GLYPH_SIZE, height: GLYPH_SIZE },
});
