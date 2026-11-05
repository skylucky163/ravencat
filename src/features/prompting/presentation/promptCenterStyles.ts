/** 默认概览、详情列表与正文编辑复用主题。 */
import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createPromptCenterStyles = (theme: PresentationTheme) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.colors.background.app },
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: theme.spacing.lg, paddingBottom: 48, gap: 12 },
  hero: { paddingTop: 10, paddingBottom: 12 },
  eyebrow: { color: theme.colors.brand.primary, fontSize: 12, fontWeight: '600', letterSpacing: 1 },
  heading: { marginTop: 8, color: theme.colors.text.primary, fontSize: 27, fontWeight: '700' },
  description: { marginTop: 8, color: theme.colors.text.secondary, fontSize: 13, lineHeight: 21 },
  section: { paddingTop: 12, paddingBottom: 2, color: theme.colors.text.tertiary, fontSize: 12, fontWeight: '600', letterSpacing: 1 },
  row: { minHeight: 76, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface.default, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light },
  // 首页概览的列表项由原生玻璃承载底色与折射，这里只保留圆角，内层不再叠染色和边框。
  glassRow: { borderRadius: theme.radius.lg },
  glassRowInner: { minHeight: 76, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  number: { width: 30, height: 30, borderRadius: 15, textAlign: 'center', textAlignVertical: 'center', overflow: 'hidden', color: theme.colors.brand.primary, backgroundColor: theme.colors.surface.raised, fontSize: 12, fontWeight: '700', lineHeight: 30 },
  // 附属设置保留编号列的宽度，让文字与上方主项对齐。
  numberPlaceholder: { opacity: 0 },
  copy: { flex: 1, gap: 5 },
  title: { color: theme.colors.text.primary, fontSize: 15, fontWeight: '600' },
  subtitle: { color: theme.colors.text.tertiary, fontSize: 12, lineHeight: 18 },
  muted: { opacity: 0.55 },
  card: { padding: 18, gap: 12, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface.default, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light },
  // 行自带内边距，卡片只负责圆角与裁切；材质由 ThemedSurface 决定。
  ruleCard: { borderRadius: theme.radius.lg, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  collapsibleHeader: { minHeight: 44 },
  actionButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  starButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  body: { color: theme.colors.text.secondary, fontSize: 13, lineHeight: 21 },
  action: { color: theme.colors.brand.primary, fontSize: 14, fontWeight: '600' },
  danger: { color: theme.colors.feedback.error, fontSize: 13 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // 固定多行编辑覆盖 InputField 的默认高度，避免原生最小高度与父布局的固定高度冲突。
  editor: { height: 320, textAlignVertical: 'top', lineHeight: 23 },
  button: { padding: 15, alignItems: 'center', borderRadius: theme.radius.lg, backgroundColor: theme.colors.brand.primary },
  buttonText: { color: theme.colors.brand.onPrimary, fontSize: 15, fontWeight: '600' },
  dragging: { borderColor: theme.colors.brand.primary, opacity: 0.8 },
  loading: { marginTop: 80 },
});
