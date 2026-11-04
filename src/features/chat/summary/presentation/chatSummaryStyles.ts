/** 摘要列表与正文编辑沿用同一套主题布局。 */
import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';
export const createChatSummaryStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: 16, paddingBottom: 40, gap: 16 },
  group: { gap: 12 },
  headerActions: { flexDirection: 'row' },
  headerAction: { width: 35, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  card: { padding: 16, borderRadius: theme.radius.lg, gap: 12 },
  sectionLabel: { color: theme.colors.text.secondary, fontSize: 12, fontWeight: '500', letterSpacing: 0.3 },
  cardTitle: { color: theme.colors.text.primary, fontSize: 14, fontWeight: '600' },
  body: { color: theme.colors.text.primary, fontSize: 14, lineHeight: 22 },
  subtitle: { color: theme.colors.text.secondary, fontSize: 13, lineHeight: 21 },
  meta: { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 18 },
  action: { color: theme.colors.brand.primary, fontSize: 14, fontWeight: '600' },
  danger: { color: theme.colors.feedback.error, fontSize: 14 },
  editor: { color: theme.colors.text.primary, padding: 0, fontSize: 15, lineHeight: 24, minHeight: 300, textAlignVertical: 'top' },
  details: { gap: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
  sourceRow: { gap: 6, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
  textButton: { minHeight: 40, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // 开关行不参与 space-between：说明块自己撑满剩余宽度，开关固定贴右（与手机工具页一致）。
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  thresholdInput: { color: theme.colors.text.primary, backgroundColor: theme.colors.surface.input,
    borderWidth: 1, borderColor: theme.colors.border.default,
    borderRadius: theme.radius.lg, paddingHorizontal: 12, paddingVertical: 8, minWidth: 90, textAlign: 'right' },
});
