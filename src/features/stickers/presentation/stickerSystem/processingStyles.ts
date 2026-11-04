/** 处理进度与详情共用主题表面，不扩充图库的样式职责。 */
import { StyleSheet } from 'react-native';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: theme.spacing.xl },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: theme.spacing.md,
    borderRadius: theme.radius.lg, overflow: 'hidden' },
  compactSummary: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 0 },
  flex: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600', color: theme.colors.text.primary },
  secondary: { fontSize: 12, lineHeight: 18, color: theme.colors.text.secondary, marginTop: 3 },
  error: { fontSize: 12, lineHeight: 18, color: theme.colors.feedback.error, marginTop: 4 },
  card: { padding: theme.spacing.md, borderRadius: theme.radius.lg, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumbnail: { width: 56, height: 56, borderRadius: theme.radius.sm, backgroundColor: theme.colors.surface.default },
  preview: { width: '100%', height: 180, borderRadius: theme.radius.md, marginBottom: theme.spacing.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  button: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light,
    borderRadius: theme.radius.md, paddingVertical: 10, paddingHorizontal: 14 },
  buttonText: { fontSize: 13, color: theme.colors.text.primary },
  disabled: { opacity: 0.4 },
  detailsScroll: { flexShrink: 1 },
  fields: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg },
  track: { height: 4, borderRadius: 2, backgroundColor: theme.colors.border.light, overflow: 'hidden', marginTop: 8 },
  fill: { height: 4, backgroundColor: theme.colors.brand.primary },
});
export function useStickerProcessingStyles() {
  return useThemedStyles(createStyles);
}
