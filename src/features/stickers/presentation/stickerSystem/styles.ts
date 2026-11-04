/** 表情包系统小程序的共享样式。 */

import { StyleSheet } from 'react-native';
import { useTheme } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';

export const createStickerSystemStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    sectionTitle: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.xs,
      marginHorizontal: theme.spacing.lg,
    },
    card: {
      backgroundColor: theme.colors.surface.default,
      borderRadius: theme.radius.lg,
      marginHorizontal: theme.spacing.lg,
      overflow: 'hidden',
    },
    statRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 10,
      paddingHorizontal: theme.spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    statRowLast: {
      borderBottomWidth: 0,
    },
    statLabel: {
      fontSize: 14,
      color: theme.colors.text.primary,
    },
    statValue: {
      fontSize: 14,
      color: theme.colors.text.secondary,
      fontWeight: '600',
    },
    editorScroll: {
      flexShrink: 1,
    },
    actionRow: {
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    actionButton: {
      flex: 1,
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.light,
      alignItems: 'center',
      paddingVertical: 10,
      backgroundColor: theme.colors.surface.default,
    },
    actionButtonDisabled: {
      opacity: 0.4,
    },
    actionButtonText: {
      fontSize: 13,
      color: theme.colors.text.primary,
    },
    dangerActionText: {
      color: '#FF3B30',
    },
    hint: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.sm,
      lineHeight: 18,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: theme.spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    rowLast: {
      borderBottomWidth: 0,
    },
    rowTitle: {
      fontSize: 15,
      color: theme.colors.text.primary,
    },
    rowSubtitle: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      marginTop: 2,
    },
    rowRight: {
      marginLeft: 'auto',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    // 每个操作独占 44dp 命中区；相邻按钮不能再靠 hitSlop 扩边，否则命中区互相重叠，
    // 点击会落到后渲染的邻居（删除是不可逆操作，尤其不能误触）。
    // 与表情处理进度页保持同一缩略尺寸，两处扫图时尺寸一致。
    thumbnail: {
      width: 56,
      height: 56,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.surface.muted,
    },
    rowIconButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // 编辑弹窗的原图预览：56px 缩略图不足以确认画面，进详情才能看清。
    preview: {
      width: '100%',
      height: 180,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surface.muted,
      marginBottom: theme.spacing.md,
    },
    rowValue: {
      fontSize: 13,
      color: theme.colors.text.secondary,
    },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.light,
    },
    chipText: {
      fontSize: 11,
      color: theme.colors.text.secondary,
    },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.light,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 14,
      color: theme.colors.text.primary,
      marginHorizontal: theme.spacing.lg,
      marginTop: theme.spacing.sm,
    },
    formLabel: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginHorizontal: theme.spacing.lg,
      marginTop: theme.spacing.md,
    },
    pickerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: theme.spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border.light,
    },
    stateText: {
      fontSize: 13,
      color: theme.colors.text.secondary,
      padding: theme.spacing.xl,
      textAlign: 'center',
    },
  });

export type StickerSystemStyles = ReturnType<typeof createStickerSystemStyles>;

export function useStickerSystemStyles(): StickerSystemStyles {
  const theme = useTheme();
  return createStickerSystemStyles(theme);
}
