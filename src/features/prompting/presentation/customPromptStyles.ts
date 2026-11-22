/** 自定义提示词列表的卡片、悬浮态与插入槽共用主题材质。 */
import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createCustomPromptStyles = (theme: PresentationTheme) => StyleSheet.create({
  viewport: { flex: 1 },
  content: { paddingTop: theme.spacing.lg, paddingBottom: 48 },
  cell: { paddingBottom: 12 },
  card: {
    height: 84, marginHorizontal: theme.spacing.lg, paddingHorizontal: 12, borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface.default, borderWidth: 1, borderColor: theme.colors.border.light,
  },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  edit: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8 },
  grip: { color: theme.colors.text.tertiary },
  number: {
    width: 28, height: 28, borderRadius: 14, overflow: 'hidden', textAlign: 'center', textAlignVertical: 'center',
    lineHeight: 28, color: theme.colors.brand.primary, backgroundColor: theme.colors.surface.raised, fontSize: 12, fontWeight: '700',
  },
  name: { flex: 1, color: theme.colors.text.primary, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  selected: { borderWidth: 2, borderColor: theme.colors.brand.primary, backgroundColor: theme.colors.surface.raised, elevation: 12 },
  selectedNumber: { color: theme.colors.brand.onPrimary, backgroundColor: theme.colors.brand.primary },
  dropSlot: {
    height: 84, marginHorizontal: theme.spacing.lg, marginBottom: 12, justifyContent: 'center', alignItems: 'center', borderRadius: theme.radius.lg, borderWidth: 2,
    borderStyle: 'dashed', borderColor: theme.colors.brand.primary, backgroundColor: theme.colors.surface.raised,
  },
  dropLabel: { color: theme.colors.brand.primary, fontSize: 13, fontWeight: '600' },
});
