/** 高频 UI 样式片段，供各界面复用。 */

import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '../theme';

/**
 * 根据当前运行时主题创建共享样式。
 *
 * 示例：
 *   const commonStyles = useMemo(() => createCommonStyles(theme), [theme]);
 */
export function createCommonStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    // 屏幕容器
    screenContainer: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },

    // 由 ThemedSurface 拥有表单材质，样式只规定留白与圆角。
    formSurface: {
      margin: theme.spacing.lg,
      borderRadius: theme.radius.lg,
    },

    // 导航栏保存按钮
    navSaveBtn: {
      padding: theme.spacing.sm,
      marginRight: -theme.spacing.sm,
    },
    navSaveText: {
      ...theme.typography.body,
      color: theme.colors.brand.primary,
      fontWeight: '600',
    },

    // 统一输入框
    input: {
      backgroundColor: theme.colors.surface.input,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 12,
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    textArea: {
      height: 80,
      paddingTop: 12,
      textAlignVertical: 'top',
    },

    // 主操作按钮
    actionButton: {
      backgroundColor: theme.colors.brand.primary,
      borderRadius: theme.radius.md,
      paddingVertical: 12,
      paddingHorizontal: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionButtonText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },

    // 危险按钮
    dangerButton: {
      backgroundColor: theme.colors.feedback.error,
      borderRadius: theme.radius.md,
      paddingVertical: 12,
      paddingHorizontal: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dangerButtonText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },

    // 底部弹窗遮罩
    modalOverlay: {
      flex: 1,
      backgroundColor: theme.colors.surface.overlay,
      justifyContent: 'flex-end',
    },

    // 底部弹窗内容区
    modalSheet: {
      backgroundColor: theme.components.modalSheet.backgroundColor,
      borderTopLeftRadius: theme.components.modalSheet.radius,
      borderTopRightRadius: theme.components.modalSheet.radius,
      paddingBottom: 32,
      maxHeight: theme.components.modalSheet.maxHeight,
    },

    // 弹窗头部
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.light,
    },
    modalTitle: {
      ...theme.typography.title,
    },
    modalCloseBtn: {
      padding: theme.spacing.sm,
      marginRight: -theme.spacing.sm,
    },
    modalCloseText: {
      ...theme.typography.body,
      color: theme.colors.text.secondary,
    },

    // 表单分组区块
    section: {
      backgroundColor: theme.colors.background.app,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
    },
    sectionTitle: {
      fontSize: 13,
      color: theme.colors.text.secondary,
      fontWeight: '600',
      marginBottom: theme.spacing.md,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    label: {
      fontSize: 14,
      color: theme.colors.text.secondary,
      marginBottom: theme.spacing.sm,
      fontWeight: '500',
    },
    hintText: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      marginTop: theme.spacing.xs,
    },

    // Toast
    toastOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.surface.overlay,
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 999,
    },
    toastContainer: {
      backgroundColor: theme.effects.overlay.toast,
      borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing.xl,
      paddingVertical: theme.spacing.lg,
      minWidth: 120,
      alignItems: 'center',
    },
    toastText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 14,
      fontWeight: '500',
      marginTop: theme.spacing.sm,
    },

    // 空状态
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingTop: 100,
      paddingHorizontal: theme.spacing.xl,
    },
    emptyTitle: {
      fontSize: 16,
      color: theme.colors.text.secondary,
      marginBottom: theme.spacing.lg,
      fontWeight: '500',
    },
    emptyText: {
      fontSize: 13,
      color: theme.colors.text.tertiary,
      textAlign: 'center',
      lineHeight: 20,
    },
  });
}
