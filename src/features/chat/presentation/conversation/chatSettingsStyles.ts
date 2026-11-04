/** 对话设置以分组卡片组织内容，说明与控件保持相邻。 */
import { StyleSheet } from 'react-native';
import type { PresentationTheme } from '@shared/theme';

export const createStyles = (theme: PresentationTheme) => {
  const card = {
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.light,
  };
  return StyleSheet.create({
    content: { padding: theme.spacing.lg, paddingBottom: 48, gap: theme.spacing.md },
    settingsSection: { ...card, padding: theme.spacing.lg, gap: theme.spacing.sm },
    sectionLabel: {
      paddingTop: theme.spacing.md,
      color: theme.colors.text.tertiary,
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 1,
    },
    cardTitle: { color: theme.colors.text.primary, fontSize: 15, fontWeight: '600' },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: { color: theme.colors.text.primary, fontSize: 15, fontWeight: '600' },
    rowDescription: { color: theme.colors.text.tertiary, fontSize: 12, lineHeight: 18, marginTop: 4 },
    contextLimitField: {
      paddingVertical: theme.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.light,
    },
    contextLimitRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    contextLimitInput: {
      backgroundColor: theme.colors.surface.input,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border.default,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      fontSize: 16,
      color: theme.colors.brand.primary,
      fontWeight: '600',
      textAlign: 'center',
      width: 72,
      flexShrink: 0,
      minHeight: 44,
      textAlignVertical: 'center',
    },
    unit: { color: theme.colors.text.tertiary, fontSize: 12 },
    sharedValue: { color: theme.colors.text.secondary, fontSize: 14 },
    disabled: { opacity: 0.45 },
    contextLimitError: { color: theme.colors.feedback.error, fontSize: 13, marginTop: theme.spacing.xs },
    fixedPreview: {
      padding: theme.spacing.md,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surface.raised,
      fontSize: 14,
      color: theme.colors.text.primary,
      lineHeight: 22,
      marginTop: theme.spacing.sm,
    },
    fixedActions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.lg },
    fixedAction: { color: theme.colors.brand.primary, fontSize: 14, fontWeight: '600', minHeight: 44, textAlignVertical: 'center' },
    toggleCard: { ...card, paddingHorizontal: theme.spacing.lg },
    toggleRow: { minHeight: 76, paddingVertical: theme.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.light },
    lastToggleRow: { minHeight: 76, paddingVertical: theme.spacing.md },
    entryCard: { ...card },
    entryRow: { padding: theme.spacing.lg, minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
    backgroundCard: {
      ...card,
      backgroundColor: theme.colors.surface.default,
      padding: theme.spacing.lg,
      marginTop: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
  });
};
