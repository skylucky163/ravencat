import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createBubbleSkinSettingsStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  group: { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface.default, overflow: 'hidden' },
  heading: { minHeight: 58, paddingHorizontal: theme.spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.colors.text.primary, fontSize: 16, fontWeight: '600' },
  items: { paddingLeft: theme.spacing.lg, paddingRight: 8, paddingBottom: 8 },
  item: { flexDirection: 'row', alignItems: 'center' },
  selection: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  name: { flex: 1, fontSize: 15, color: theme.colors.text.primary },
  selected: { color: theme.colors.brand.primary, fontSize: 15, fontWeight: '600' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  add: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  error: { color: theme.colors.feedback.error, fontSize: 12, lineHeight: 18, padding: 8 },
});
