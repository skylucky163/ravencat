import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createCallAvatarHeaderStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.lg,
    },
    avatar: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.38)',
      overflow: 'hidden',
    },
    avatarImage: {
      width: '100%',
      height: '100%',
    },
    avatarText: {
      color: theme.colors.text.inverse,
    },
    aiName: {
      ...theme.typography.title,
      marginTop: theme.spacing.sm,
      maxWidth: '100%',
      textAlign: 'center',
      color: theme.colors.text.inverse,
    },
    stateText: {
      ...theme.typography.bodySmall,
      maxWidth: '100%',
      textAlign: 'center',
      color: 'rgba(255,255,255,0.82)',
    },
  });
