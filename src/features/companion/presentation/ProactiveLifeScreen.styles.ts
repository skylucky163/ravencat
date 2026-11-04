/** 宇宙页面沿用共享深色主题的文字对比度；弹层继续使用当前主题。 */
import { StyleSheet } from 'react-native';
import { getThemeById, type PresentationTheme } from '@shared/theme';

export const createStyles = (theme: PresentationTheme) => {
  const dark = getThemeById('default-dark');
  const light = dark.colors.text.primary;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: dark.colors.background.app },
    safeArea: { flex: 1 },
    list: { flex: 1 },
    listContent: { paddingBottom: 28 },
    navigation: { paddingHorizontal: 20, paddingVertical: 4, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    iconButton: { width: 48, height: 44, justifyContent: 'center' },
    navSpacer: { width: 48 },
    navTitle: { color: light, fontSize: 17, letterSpacing: 3 },
    intro: { alignItems: 'center', paddingHorizontal: 20, marginTop: 28 },
    eyebrow: { color: light, opacity: 0.65, fontSize: 10, letterSpacing: 2 },
    title: { color: light, fontSize: 28, fontWeight: '300', letterSpacing: 9, marginTop: 13, marginBottom: 7, paddingLeft: 9 },
    subtitle: { color: light, opacity: 0.6, fontSize: 12, letterSpacing: 1 },
    section: { marginHorizontal: 24, paddingTop: 19, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: dark.colors.border.strong, flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
    sectionDate: { color: light, fontSize: 12, letterSpacing: 1 },
    meta: { color: light, opacity: 0.6, fontSize: 12 },
    entry: { marginHorizontal: 24, paddingVertical: 17, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: dark.colors.border.light },
    entryTime: { color: light, opacity: 0.65, fontSize: 12, fontVariant: ['tabular-nums'] },
    entryBody: { flex: 1 },
    entryTitle: { color: light, opacity: 0.85, fontSize: 14, lineHeight: 22 },
    entryStatus: { color: light, opacity: 0.6, fontSize: 11, marginTop: 5 },
    featured: { marginHorizontal: 24, paddingBottom: 22 },
    featuredLabel: { color: light, opacity: 0.7, fontSize: 11, letterSpacing: 2 },
    featuredTime: { color: light, fontSize: 42, fontWeight: '300', fontVariant: ['tabular-nums'], marginTop: 7, marginBottom: 9 },
    featuredRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    featuredTitle: { color: light, fontSize: 17, lineHeight: 27, flex: 1, letterSpacing: 0.5 },
    detailLink: { color: light, opacity: 0.7, fontSize: 12 },
    notice: { marginHorizontal: 24, color: light, opacity: 0.7, fontSize: 12, lineHeight: 21, marginBottom: 18 },
    loading: { alignItems: 'center', padding: 26, gap: 14 },
    empty: { marginHorizontal: 24, color: light, opacity: 0.65, fontSize: 13, lineHeight: 23, paddingTop: 4, paddingBottom: 30 },
    error: { marginHorizontal: 24, marginBottom: 14, color: theme.colors.feedback.error, fontSize: 13, lineHeight: 21 },
    footer: { marginHorizontal: 24, marginTop: 15, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: dark.colors.border.light, paddingTop: 12 },
    footerActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
    footerButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
    footerText: { color: light, opacity: 0.65, fontSize: 12 },
    note: { color: light, opacity: 0.5, fontSize: 11, lineHeight: 20, marginTop: 14 },
    modalBody: { padding: theme.spacing.lg },
  });
};
