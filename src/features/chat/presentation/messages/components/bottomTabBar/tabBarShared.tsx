/**
 * 底栏共用导航数据、触摸与角标；球体变体额外共用运动状态，视觉层不持有路由。
 * 小数序号驱动曲线的思路参考 react-native-fluid-bottom-bar：
 * Copyright (c) 2026 Vipin Sharma，MIT 许可见 docs/third-party/upstream/。
 */
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@shared/theme';

export const TAB_BAR_SPRING = { damping: 23, stiffness: 260, mass: 0.85 };
export interface BottomTabBarVariantProps {
  activeTab: string;
  onTabChange: (tabId: string) => void;
  unreadCount?: number;
}
export const TABS = [
  { id: 'ai', iconName: 'chatbubble', label: '消息' },
  { id: 'moments', iconName: 'albums', label: '时刻' },
  { id: 'apps', iconName: 'grid', label: '发现' },
  { id: 'settings', iconName: 'person', label: '设置' },
] as const;
type Tab = (typeof TABS)[number];

export function useTabMotion(activeTab: string) {
  const activeIndex = TABS.findIndex(tab => tab.id === activeTab);
  const position = useSharedValue(activeIndex);
  useEffect(() => {
    // 不归零、不排队；Reanimated 保留当前位移与速度，直接转向最新目标。
    position.value = withSpring(activeIndex, TAB_BAR_SPRING);
  }, [activeIndex, position]);
  const trail = useDerivedValue(() => withSpring(position.value, {
    damping: 25, stiffness: 150, mass: 0.65,
  }));
  return { position, trail };
}

export function TabGlyph({ tab, color, badgeCount, solid = true }: {
  tab: Tab; color: string; badgeCount: number; solid?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.glyph}>
      <Ionicons name={solid ? tab.iconName : `${tab.iconName}-outline`} size={25} color={color} />
      {badgeCount > 0 && (
        <View style={[styles.badge, { backgroundColor: theme.colors.feedback.error }]}>
          <Text maxFontSizeMultiplier={1.3} style={[styles.badgeText, { color: theme.colors.brand.onPrimary }]}>
            {badgeCount > 99 ? '99+' : badgeCount}
          </Text>
        </View>
      )}
    </View>
  );
}

function useGlyphOpacity(visible: boolean) {
  const opacity = useSharedValue(visible ? 1 : 0);
  useEffect(() => {
    opacity.value = withTiming(visible ? 1 : 0, { duration: 120 });
  }, [visible, opacity]);
  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

/** 图标跟随同一个球体，交叉淡入只替换内容，不再让四个图标各自跳向空中。 */
export function ActiveTabGlyph({ activeTab, unreadCount, color }: {
  activeTab: string; unreadCount: number; color: string;
}) {
  return TABS.map(tab => (
    <BallGlyph key={tab.id} tab={tab} active={tab.id === activeTab} color={color}
      badgeCount={tab.id === 'ai' ? unreadCount : 0} />
  ));
}
function BallGlyph({ tab, active, color, badgeCount }: {
  tab: Tab; active: boolean; color: string; badgeCount: number;
}) {
  const style = useGlyphOpacity(active);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.center, style]}>
      <TabGlyph tab={tab} color={color} badgeCount={badgeCount} />
    </Animated.View>
  );
}

export function TabBarItems({ activeTab, onTabChange, unreadCount = 0, height, headroom }: BottomTabBarVariantProps & {
  height: number; headroom: number;
}) {
  return (
    <View pointerEvents="box-none" style={[styles.items, { height }]} role="tablist">
      {TABS.map(tab => (
        // 凸起空间只属于选中项；未选中项上方的透明留白让触摸回到页面。
        <View key={tab.id} pointerEvents="box-none"
          style={{ flex: 1, paddingTop: activeTab === tab.id ? 0 : headroom }}>
          <TabBarButton tab={tab} active={activeTab === tab.id}
            onPress={() => onTabChange(tab.id)} badgeCount={tab.id === 'ai' ? unreadCount : 0}>
            <InactiveTabGlyph tab={tab} active={activeTab === tab.id}
              badgeCount={tab.id === 'ai' ? unreadCount : 0} />
          </TabBarButton>
        </View>
      ))}
    </View>
  );
}
export function TabBarButton({ tab, active, onPress, badgeCount, children }: {
  tab: Tab; active: boolean; onPress: () => void; badgeCount: number; children: React.ReactNode;
}) {
  return (
    <Pressable onPress={onPress} style={styles.item} accessibilityRole="tab"
      accessibilityLabel={badgeCount > 0 ? `${tab.label}，${badgeCount} 条未读` : tab.label}
      accessibilityState={{ selected: active }}>
      {children}
    </Pressable>
  );
}
function InactiveTabGlyph({ tab, active, badgeCount }: {
  tab: Tab; active: boolean; badgeCount: number;
}) {
  const theme = useTheme();
  const style = useGlyphOpacity(!active);
  return (
    <Animated.View pointerEvents="none" accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={style}>
      <TabGlyph tab={tab} solid={false} color={theme.colors.text.secondary} badgeCount={badgeCount} />
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  items: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row' },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  glyph: { width: 25, height: 25 },
  badge: {
    position: 'absolute', top: -6, right: -12, minWidth: 18, minHeight: 18,
    borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeText: { fontSize: 9, fontWeight: '700' },
});
