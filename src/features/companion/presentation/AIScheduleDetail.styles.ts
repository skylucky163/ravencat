/** 日程详情浮在深色星空上：玻璃弹层透出深色底，正文只能用亮色系。 */
import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';
export const createStyles = (theme: PresentationTheme) => {
  // 玻璃弹层没有实色底，主题给浅色界面的 text.primary / secondary 在深色星空上读不出来。
  // 非玻璃主题的弹层是实色底，仍用主题文字色。
  const onDark = theme.effects.glass.enabled;
  const strong = onDark ? theme.colors.text.inverse : theme.colors.text.primary;
  const muted = onDark ? theme.colors.text.inverse : theme.colors.text.secondary;
  const faint = onDark ? theme.colors.text.inverse : theme.colors.text.tertiary;
  // 亮色下靠透明度拉层级；实色底保持主题原样。
  const fade = (value: number) => (onDark ? value : 1);
  return StyleSheet.create({
    detailScroll: { flexShrink: 1 },
    detailBody: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md, paddingBottom: theme.spacing.lg },
    detailTime: { fontSize: 13, color: faint, opacity: fade(0.62) },
    detailSummary: { ...theme.typography.titleSmall, marginTop: theme.spacing.xs, color: strong },
    detailDetails: { ...theme.typography.body, marginTop: theme.spacing.md, color: muted, opacity: fade(0.8), lineHeight: 21 },
    detailSourceLabel: { marginTop: theme.spacing.lg, fontSize: 13, fontWeight: '600', color: muted, opacity: fade(0.72) },
    detailSourceExcerpt: { marginTop: theme.spacing.xs, fontSize: 13, lineHeight: 19, color: faint, opacity: fade(0.62) },
    detailError: { marginTop: theme.spacing.md, color: theme.colors.feedback.error, lineHeight: 20 },
    detailActions: { marginTop: theme.spacing.lg },
    detailLoading: { paddingVertical: theme.spacing.xl, alignItems: 'center' },
  });
};
