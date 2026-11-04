/**
 * @fileoverview 分类列表组件
 */

import React from 'react';
import { View, Text } from 'react-native';
import { CategoryGroup } from './CategoryGroup';
import { useStyles } from '../styles';
import type { CategoryGroupData } from '../../historyTypes';
import type { WalletRecord } from '../../../domain/WalletRecord';

interface CategoryListProps {
  expenseGroups: CategoryGroupData[];
  incomeGroups: CategoryGroupData[];
  onRecordLongPress: (record: WalletRecord) => void;
  mutatingRecordId: string | null;
}

export function CategoryList({ expenseGroups, incomeGroups, onRecordLongPress, mutatingRecordId }: CategoryListProps) {
  const styles = useStyles();
  const hasExpense = expenseGroups.length > 0;
  const hasIncome = incomeGroups.length > 0;

  return (
    <View style={styles.listSection}>
      {/* 支出明细 */}
      {hasExpense && (
        <>
          <Text style={styles.sectionTitle}>
            支出明细 · {expenseGroups.reduce((sum, g) => sum + g.count, 0)}笔
          </Text>
          {expenseGroups.map((group) => (
            <CategoryGroup
              key={`expense-${group.category}`}
              category={group.category}
              type="expense"
              total={group.total}
              percentage={group.percentage}
              count={group.count}
              color={group.color}
              records={group.records}
              onRecordLongPress={onRecordLongPress}
              mutatingRecordId={mutatingRecordId}
            />
          ))}
        </>
      )}

      {/* 分割线 */}
      {hasExpense && hasIncome && <View style={styles.divider} />}

      {/* 收入明细 */}
      {hasIncome && (
        <>
          <Text style={styles.sectionTitle}>
            收入明细 · {incomeGroups.reduce((sum, g) => sum + g.count, 0)}笔
          </Text>
          {incomeGroups.map((group) => (
            <CategoryGroup
              key={`income-${group.category}`}
              category={group.category}
              type="income"
              total={group.total}
              percentage={group.percentage}
              count={group.count}
              color={group.color}
              records={group.records}
              onRecordLongPress={onRecordLongPress}
              mutatingRecordId={mutatingRecordId}
            />
          ))}
        </>
      )}

      {/* 空状态 */}
      {!hasExpense && !hasIncome && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>该时间段内暂无记账记录</Text>
        </View>
      )}
    </View>
  );
}
