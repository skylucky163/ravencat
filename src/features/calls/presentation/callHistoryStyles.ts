import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createCallHistoryStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: 40 },
  card: { padding: theme.spacing.lg, borderRadius: theme.radius.lg, gap: theme.spacing.sm },
  preferenceCard: { borderRadius: theme.radius.lg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  title: { color: theme.colors.text.primary, fontSize: 16, fontWeight: '600', flex: 1 },
  body: { color: theme.colors.text.primary, fontSize: 16, lineHeight: 25 },
  meta: { color: theme.colors.text.secondary, fontSize: 13, lineHeight: 21 },
  error: { color: theme.colors.feedback.error, fontSize: 14, lineHeight: 22 },
  action: { padding: 10 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border.light, marginVertical: 4 },
  form: { padding: theme.spacing.lg },
  images: { gap: theme.spacing.md, marginTop: theme.spacing.md },
  snapshot: { width: '100%', height: 360, borderRadius: theme.radius.md },
});
