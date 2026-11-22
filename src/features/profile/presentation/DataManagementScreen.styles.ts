import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export function createDataManagementStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background.app },
    scroll: { flex: 1, backgroundColor: theme.colors.background.screen },
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxl },
    section: {
      backgroundColor: theme.colors.surface.default,
      borderRadius: theme.radius.lg,
      overflow: 'hidden',
      marginBottom: theme.spacing.lg,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
      minHeight: 56,
    },
    textBlock: { flex: 1 },
    backupHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.spacing.lg, minHeight: 64 },
    backupTitle: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.lg },
    title: { fontSize: 16, color: theme.colors.text.primary },
    description: { fontSize: 13, lineHeight: 20, marginTop: theme.spacing.xs, color: theme.colors.text.secondary },
    dangerHeading: { fontSize: 13, color: theme.colors.text.secondary, marginLeft: theme.spacing.lg, marginBottom: theme.spacing.sm },
    dangerTitle: { fontSize: 16, color: theme.colors.feedback.error },
  });
}
