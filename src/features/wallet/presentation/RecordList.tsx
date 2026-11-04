/** 最近账单通过长按表达编辑或删除意图。 */
// 记录列表组件

import React from 'react';
import { ActivityIndicator, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { EXPENSE_COLOR, INCOME_COLOR } from './walletVisualizationColors';
import { formatMonthDay } from './utils/timeUtils';
import type { WalletRecord } from '../domain/WalletRecord';

interface RecordListProps {
  records: WalletRecord[];
  onLongPress: (record: WalletRecord) => void;
  mutatingRecordId?: string | null;
}

const formatAmount = (amount: number): string => amount.toFixed(2);

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.xl,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    title: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text.primary,
    },
    count: {
      fontSize: 13,
      color: theme.colors.text.secondary,
    },
    item: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.light,
    },
    left: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      marginRight: theme.spacing.md,
    },
    expenseDot: {
      backgroundColor: EXPENSE_COLOR,
    },
    incomeDot: {
      backgroundColor: INCOME_COLOR,
    },
    category: {
      fontSize: 15,
      color: theme.colors.text.primary,
    },
    detail: {
      fontSize: 12,
      color: theme.colors.text.secondary,
      marginTop: theme.spacing.xs,
    },
    right: {
      alignItems: 'flex-end',
    },
    amount: {
      fontSize: 15,
      fontWeight: '500',
    },
    expenseText: {
      color: EXPENSE_COLOR,
    },
    incomeText: {
      color: INCOME_COLOR,
    },
    date: {
      fontSize: 11,
      color: theme.colors.text.secondary,
      marginTop: theme.spacing.xs,
    },
  });

const RecordList: React.FC<RecordListProps> = ({
  records,
  onLongPress,
  mutatingRecordId = null,
}) => {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>最近记录</Text>
        <Text style={styles.count}>{records.length} 笔 · 长按编辑 / 删除</Text>
      </View>

      {records.map((record) => (
        <TouchableOpacity
          key={record.id}
          style={styles.item}
          onLongPress={() => onLongPress(record)}
          disabled={mutatingRecordId !== null}
        >
          <View style={styles.left}>
            <View style={[
              styles.dot,
              record.type === 'expense' ? styles.expenseDot : styles.incomeDot
            ]} />
            <View>
              <Text style={styles.category}>{record.category}</Text>
              {record.detail ? (
                <Text style={styles.detail}>{record.detail}</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.right}>
            {mutatingRecordId === record.id ? (
              <ActivityIndicator size="small" color={theme.colors.brand.primary} />
            ) : (
              <Text style={[
                styles.amount,
                record.type === 'expense' ? styles.expenseText : styles.incomeText
              ]}>
                {record.type === 'expense' ? '-' : '+'}¥{formatAmount(record.amount)}
              </Text>
            )}
            <Text style={styles.date}>{formatMonthDay(record.recordDate)}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
};

export default RecordList;
