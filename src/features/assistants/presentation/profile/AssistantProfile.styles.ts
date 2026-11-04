/** 个人主页和独立编辑页共用主题表面。 */
import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createAssistantProfileStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.app },
  content: { padding: theme.spacing.lg, paddingBottom: 48, gap: theme.spacing.xl },
  card: {
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.light,
  },
  profileScroll: { flex: 1, backgroundColor: theme.colors.background.screen },
  profileContent: { paddingTop: 0, paddingHorizontal: 0, gap: 0 },
  cover: { height: 190 },
  profileBody: { alignItems: 'center', paddingHorizontal: theme.spacing.xxl, paddingBottom: theme.spacing.xl },
  profileAvatar: { width: 80, height: 80, marginTop: -40, borderRadius: 40, borderWidth: 3, borderColor: theme.colors.brand.onPrimary, backgroundColor: theme.colors.brand.onPrimary, alignItems: 'center', justifyContent: 'center', ...theme.shadow.md },
  nameRow: { marginTop: theme.spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.spacing.xs, maxWidth: '100%' },
  name: { flexShrink: 1, color: theme.colors.text.primary, fontSize: 26, fontWeight: '600', textAlign: 'center' },
  nickname: { color: theme.colors.text.secondary, fontSize: 18, fontWeight: '400' },
  editProfile: { minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  persona: { marginTop: theme.spacing.sm, color: theme.colors.text.secondary, fontSize: 14, lineHeight: 22, textAlign: 'center' },
  profileSections: { gap: theme.spacing.md, ...(theme.effects.glass.enabled ? { paddingHorizontal: theme.spacing.lg } : {}) },
  momentsCard: {
    backgroundColor: theme.colors.surface.default,
    ...(theme.effects.glass.enabled ? { borderRadius: theme.radius.lg, overflow: 'hidden' } : {}),
  },
  momentsEntry: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.spacing.lg, paddingVertical: 16 },
  entryTitle: { flex: 1, color: theme.colors.text.primary, fontSize: 16 },
  empty: { color: theme.colors.text.tertiary, fontSize: 14, lineHeight: 24, textAlign: 'center' },
  lastField: { marginBottom: 0 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.spacing.sm },
  actionText: { color: theme.colors.brand.primary, fontSize: 15, fontWeight: '600' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.lg },
});
