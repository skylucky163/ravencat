/** 集中定义聊天详情、消息列表及列表项的主题化样式。 */

import { StyleSheet } from 'react-native';
import { isMoonKimiTheme, isPaperNoteTheme, type PresentationTheme } from '@shared/theme';

export function createChatDetailStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: 'transparent',
    },
    keyboardView: {
      flex: 1,
    },
    centerContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    },
    loadingText: {
      marginTop: 12,
      fontSize: 14,
      color: theme.colors.text.secondary,
    },
    errorText: {
      fontSize: 14,
      color: theme.colors.text.secondary,
      textAlign: 'center',
      marginBottom: 16,
    },
    retryButton: {
      paddingHorizontal: 20,
      paddingVertical: 10,
      backgroundColor: theme.colors.brand.primary,
      borderRadius: 8,
    },
    retryText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 14,
      fontWeight: '500',
    },
  });
}

export function createMessageListStyles(theme: PresentationTheme) {
  const isPaperNote = isPaperNoteTheme(theme);
  const isMoonKimi = isMoonKimiTheme(theme);

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    contentContainer: {
      paddingHorizontal: isPaperNote ? 0 : isMoonKimi ? 8 : 4,
      paddingVertical: isPaperNote ? 0 : 16,
    },
    newMessagePrompt: {
      position: 'absolute',
      right: theme.spacing.lg,
      bottom: theme.spacing.md,
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.radius.round,
      backgroundColor: theme.colors.brand.primary,
      shadowColor: 'rgba(15, 23, 42, 0.2)',
      shadowOpacity: 0.16,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 3,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.text.secondary,
    },
    officialReplicaEmptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.xxl,
      backgroundColor: theme.colors.background.screen,
    },
    officialReplicaEmptyMark: {
      width: 48,
      height: 48,
      borderRadius: theme.radius.round,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface.muted,
      marginBottom: theme.spacing.lg,
    },
    officialReplicaEmptyTitle: {
      fontSize: theme.typography.titleLarge.fontSize,
      fontWeight: theme.typography.titleLarge.fontWeight,
      color: theme.colors.text.primary,
      marginBottom: theme.spacing.sm,
    },
    officialReplicaEmptySubtitle: {
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.text.secondary,
      textAlign: 'center',
    },
  });
}

export function createMessageListPartsStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    moonKimiSpeakerSpacing: {
      paddingTop: theme.spacing.sm,
    },
    paperNoteSpeakerSeparator: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.xl,
    },
    paperNoteSpeakerSeparatorText: {
      color: theme.colors.text.secondary,
      fontSize: 14,
      lineHeight: 24,
      textAlign: 'center',
      includeFontPadding: false,
    },
    timeSeparator: {
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: 12,
    },
    timeSeparatorText: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      backgroundColor: 'transparent',
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 4,
    },
    retryButton: {
      position: 'absolute',
      right: 8,
      top: '50%',
      marginTop: -10,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.colors.feedback.error,
      justifyContent: 'center',
      alignItems: 'center',
    },
    retryText: {
      color: theme.colors.brand.onPrimary,
      fontSize: 12,
      fontWeight: 'bold',
    },
    sendingIndicator: {
      position: 'absolute',
      right: 8,
      top: '50%',
      marginTop: -4,
    },
    sendingDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.text.secondary,
      opacity: 0.5,
    },
  });
}
