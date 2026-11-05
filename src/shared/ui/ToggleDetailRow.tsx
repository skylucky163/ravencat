/** 卡片内的一体化开关行：标题行带可选图标与开关，描述行可进入详情。 */

import type { ReactNode } from 'react';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import ToggleField from './ToggleField';

export interface ToggleDetailRowProps {
  title: string;
  /** 单行灰色说明；需要多行结构时改用 detail。 */
  description?: string;
  /** 自定义说明区内容，优先于 description；箭头仍由 onOpenDetail 决定。 */
  detail?: ReactNode;
  /** 可选前置图标；不传时不保留图标列宽度。 */
  icon?: ReactNode;
  value: boolean;
  onValueChange: (value: boolean) => void;
  onOpenDetail?: () => void;
  disabled?: boolean;
  toggleAccessibilityLabel?: string;
  detailAccessibilityLabel?: string;
  /** 作为列表成员时画下分隔线；最后一项不传。 */
  divider?: boolean;
}

const ICON_COLUMN_WIDTH = 28;
const ICON_COLUMN_GAP = 12;

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    divider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
    },
    detail: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: theme.spacing.lg + ICON_COLUMN_WIDTH + ICON_COLUMN_GAP,
      paddingRight: theme.spacing.lg,
      paddingBottom: 14,
      minHeight: 36,
    },
    detailWithoutIcon: {
      paddingLeft: theme.spacing.lg,
    },
    iconColumn: {
      width: ICON_COLUMN_WIDTH,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: ICON_COLUMN_GAP,
    },
    text: {
      flex: 1,
    },
    title: {
      flexShrink: 1,
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    description: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginTop: 2,
      lineHeight: 17,
    },
    chevron: {
      width: 48,
      alignItems: 'center',
    },
  });

export default function ToggleDetailRow({
  title,
  description,
  detail,
  icon,
  value,
  onValueChange,
  onOpenDetail,
  disabled = false,
  toggleAccessibilityLabel,
  detailAccessibilityLabel,
  divider = false,
}: ToggleDetailRowProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const detailStyle = [styles.detail, !icon && styles.detailWithoutIcon];
  const detailBody = detail ? <View style={styles.text}>{detail}</View>
    : <Text style={[styles.text, styles.description]}>{description}</Text>;

  return (
    <View style={divider && styles.divider}>
      <ToggleField
        layout="inline"
        rowStyle={styles.header}
        label={title}
        accessibilityLabel={toggleAccessibilityLabel ?? `启用${title}`}
        disabled={disabled}
        value={value}
        onValueChange={onValueChange}
        leading={icon ? <View style={styles.iconColumn}>{icon}</View> : undefined}
      >
        <Text style={[styles.text, styles.title]}>{title}</Text>
      </ToggleField>
      {onOpenDetail ? (
        <TouchableOpacity
          style={detailStyle}
          activeOpacity={0.7}
          onPress={onOpenDetail}
          accessibilityRole="button"
          accessibilityLabel={detailAccessibilityLabel ?? `查看${title}详情`}
        >
          {detailBody}
          <View style={styles.chevron}>
            <Ionicons name="chevron-forward-outline" size={16} color={theme.colors.text.tertiary} />
          </View>
        </TouchableOpacity>
      ) : (
        <View style={detailStyle}>{detailBody}</View>
      )}
    </View>
  );
}
