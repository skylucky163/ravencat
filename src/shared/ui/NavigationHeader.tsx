// 页面决定顶部安全区由根容器还是导航栏承接，避免背景与内容一起下移。

import type { ReactNode } from 'react';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import NavigationHeaderHelp from './NavigationHeaderHelp';

interface NavigationHeaderProps {
  title: string;
  onGoBack?: (() => void) | null;
  rightButton?: ReactNode;
  /** 两侧等宽预留，容纳多个操作时保持标题居中且不与按钮重叠。 */
  sideWidth?: number;
  help?: {
    sections: readonly { title: string; body: string }[];
  };
  /** 页面根容器不避让顶部时，由导航栏在表面内部预留安全区。 */
  includeTopInset?: boolean;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    titleRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    helpSpacer: { width: 28 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.components.navigation.borderColor,
      backgroundColor: theme.components.navigation.backgroundColor,
    },
    headerLeft: {
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerRight: {
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    headerTitle: {
      flexShrink: 1,
      fontSize: 17,
      fontWeight: '600',
      color: theme.components.navigation.titleColor,
      textAlign: 'center',
    },
    backBtn: {
      padding: 5,
      marginLeft: -5,
    },
    backBtnContent: {
      flexDirection: 'row',
      alignItems: 'center',
    },
  });

/**
 * 统一的返回导航栏组件
 * @param title - 页面标题
 * @param onGoBack - 返回上一级回调（可选）
 * @param rightButton - 右侧自定义按钮（可选）
 */
export default function NavigationHeader({
  title,
  onGoBack,
  rightButton,
  sideWidth = 70,
  help,
  includeTopInset = false,
}: NavigationHeaderProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();

  return (
    <ThemedSurface
      nativeGlass
      style={[styles.header, includeTopInset && { paddingTop: insets.top + 8 }]}
      variant="navigation"
    >
      {/* 左侧返回区域 */}
      <View style={[styles.headerLeft, { width: sideWidth }]}>
        {onGoBack ? (
          <TouchableOpacity onPress={onGoBack} style={styles.backBtn}>
            <View style={styles.backBtnContent}>
              <Ionicons name="chevron-back" size={28} color={theme.colors.brand.primary} />
            </View>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* 中间标题 */}
      <View style={styles.titleRow}>
        {/* 左右预留相同宽度，让标题保持居中，问号只附在标题后。 */}
        {help && <View style={styles.helpSpacer} />}
        <Text style={styles.headerTitle} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
        {help && <NavigationHeaderHelp title={title} sections={help.sections} />}
      </View>

      {/* 右侧按钮区域 */}
      <View style={[styles.headerRight, { width: sideWidth }]}>
        {rightButton}
      </View>
    </ThemedSurface>
  );
}
