// 导航栏右上角新增入口：统一品牌色 +，各页不再自绘文字或图标。

import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Plus } from 'lucide-react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';

interface HeaderAddButtonProps {
  onPress(): void;
  accessibilityLabel: string;
  disabled?: boolean;
  /** inline 用于自带头部按钮布局的容器，点击区由 style 决定。 */
  variant?: 'navigation' | 'inline';
  style?: StyleProp<ViewStyle>;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    navigation: {
      padding: theme.spacing.sm,
      marginRight: -theme.spacing.sm,
    },
    disabled: {
      opacity: 0.4,
    },
  });

export default function HeaderAddButton({
  onPress,
  accessibilityLabel,
  disabled = false,
  variant = 'navigation',
  style,
}: HeaderAddButtonProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[variant === 'navigation' && styles.navigation, disabled && styles.disabled, style]}
    >
      <Plus size={24} color={theme.colors.brand.primary} />
    </TouchableOpacity>
  );
}
