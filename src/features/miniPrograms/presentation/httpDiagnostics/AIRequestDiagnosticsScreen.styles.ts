import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export function createHttpDiagnosticsStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.background.screen },
    scroll: { flex: 1 },
    content: { padding: theme.spacing.lg, gap: theme.spacing.md },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    // 与其它设置页共用「分组卡片 + 行内细分割线」，不另画外框。
    card: { borderRadius: theme.radius.lg, overflow: 'hidden' },
    row: { paddingHorizontal: theme.spacing.lg },
    lastItem: { borderBottomWidth: 0 },
    listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    listTitle: { flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm },
    refresh: { padding: theme.spacing.sm, marginRight: -theme.spacing.sm },
    clear: { alignSelf: 'center', marginTop: theme.spacing.lg },
    clearText: { color: theme.colors.feedback.error },
    recordMain: { gap: 2 },
    recordTitle: { ...theme.typography.body, color: theme.colors.text.primary },
    recordMeta: { ...theme.typography.caption, color: theme.colors.text.secondary, lineHeight: 18 },
    heading: { ...theme.typography.title, color: theme.colors.text.primary },
    text: { ...theme.typography.body, color: theme.colors.text.primary },
    hint: { ...theme.typography.caption, color: theme.colors.text.secondary, lineHeight: 20 },
    error: { ...theme.typography.body, color: theme.colors.feedback.error },
    detailScroll: { flexShrink: 1 },
    detailContent: { padding: theme.spacing.lg, gap: theme.spacing.md },
    detailActions: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm },
    bodyHeader: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.md },
    bodyTitle: { flex: 1 },
    bodyPagination: { gap: theme.spacing.xs },
    bodyScroll: { maxHeight: 320 },
    raw: {
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 19,
      color: theme.colors.text.primary,
      backgroundColor: theme.colors.surface.muted,
      padding: theme.spacing.md,
      borderRadius: theme.radius.sm,
    },
  });
}
