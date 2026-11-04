/**
 * @fileoverview HistoryScreen 样式
 */

import { StyleSheet } from 'react-native';
import { useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { EXPENSE_COLOR, INCOME_COLOR } from '../walletVisualizationColors';

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    content: {
      flex: 1,
    },
    // ViewSwitcher 样式
    switcherContainer: {
      flexDirection: 'row',
      marginHorizontal: theme.spacing.lg,
      marginVertical: 12,
      padding: 6,
      borderRadius: theme.radius.lg,
      gap: 8,
    },
    switcherButton: {
      flex: 1,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.surface.muted,
      alignItems: 'center',
    },
    switcherButtonActive: {
      backgroundColor: theme.colors.text.primary,
    },
    switcherText: {
      fontSize: 14,
      color: theme.colors.text.secondary,
      fontWeight: '500',
    },
    switcherTextActive: {
      color: theme.colors.text.inverse,
    },
    // CardList 样式
    listContainer: {
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: 20,
    },
    // 卡片通用样式
    card: {
      backgroundColor: theme.colors.surface.default,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border.default,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      marginBottom: 10,
    },
    cardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text.primary,
    },
    cardSubtitle: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
    },
    cardBody: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    cardAmount: {
      fontSize: 18,
      fontWeight: '600',
    },
    expenseText: {
      color: EXPENSE_COLOR,
    },
    incomeText: {
      color: INCOME_COLOR,
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.text.tertiary,
    },
    // 加载状态
    loadingContainer: {
      paddingVertical: 20,
      alignItems: 'center',
    },
  });

export const useHistoryStyles = () => useThemedStyles(createStyles);
