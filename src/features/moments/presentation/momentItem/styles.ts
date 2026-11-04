import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export function createMomentItemStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      padding: theme.spacing.lg,
      backgroundColor: theme.colors.surface.default,
      ...(theme.effects.glass.enabled ? {
        marginHorizontal: theme.spacing.lg,
        marginVertical: theme.spacing.sm,
        borderRadius: theme.radius.lg,
        overflow: 'hidden',
      } : {
        borderBottomWidth: 0.5,
        borderBottomColor: theme.colors.border.light,
      }),
    },
    avatarContainer: {
      marginRight: theme.spacing.md,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.surface.muted,
      justifyContent: 'center',
      alignItems: 'center',
    },
    avatarText: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.brand.primary,
    },
    contentContainer: {
      flex: 1,
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 2,
    },
    userName: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.brand.primary,
    },
    moreButton: {
      padding: theme.spacing.sm,
      marginRight: -theme.spacing.sm,
    },
    timeText: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      marginBottom: theme.spacing.sm,
    },
    content: {
      fontSize: 15,
      color: theme.colors.text.primary,
      lineHeight: 22,
      marginBottom: theme.spacing.md,
    },
    /** 显示地点：没有地点时整行不渲染，因此不占任何空间。 */
    locationRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: -theme.spacing.sm,
      marginBottom: theme.spacing.md,
    },
    locationText: {
      fontSize: 13,
      color: theme.colors.text.secondary,
      flexShrink: 1,
    },
    mediaGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginBottom: theme.spacing.md,
    },
    mediaTile: {
      aspectRatio: 1,
      borderRadius: theme.radius.sm,
      overflow: 'hidden',
      backgroundColor: theme.colors.surface.muted,
    },
    mediaImage: { width: '100%', height: '100%' },
    interactionContainer: {
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.md,
      ...(theme.effects.glass.enabled
        ? { backgroundColor: theme.effects.glass.backgroundColor }
        : { backgroundColor: theme.colors.surface.muted }),
    },
    likesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 8,
    },
    likesText: {
      fontSize: 14,
      color: theme.colors.brand.primary,
      flex: 1,
      flexWrap: 'wrap',
    },
    commentsContainer: {
      marginTop: theme.spacing.sm,
    },
    divider: {
      height: 0.5,
      backgroundColor: theme.colors.border.default,
      marginVertical: theme.spacing.sm,
    },
    commentRow: {
      marginBottom: 4,
    },
    commentContentWrapper: {
      flex: 1,
    },
    commentText: {
      fontSize: 14,
      lineHeight: 20,
    },
    commentUserName: {
      color: theme.colors.brand.primary,
      fontWeight: '600',
    },
    commentColon: {
      color: theme.colors.text.primary,
    },
    commentContentText: {
      color: theme.colors.text.primary,
    },
    actionBar: {
      flexDirection: 'row',
      paddingTop: theme.spacing.sm,
      borderTopWidth: 0.5,
      borderTopColor: theme.colors.border.light,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      marginRight: theme.spacing.xl,
      paddingVertical: theme.spacing.sm,
    },
    shareButton: {
      marginLeft: 'auto',
      marginRight: 0,
    },
    actionButtonActive: {
      // 激活状态
    },
    actionTextActive: {
      color: theme.colors.feedback.error,
      fontWeight: '500',
    },
  });
}
