/**
 * @fileoverview HistoryDetailScreen 状态逻辑 Hook
 */

import { useState, useCallback, useMemo } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { getLedgerRangeSummary, getWalletCategories } from '../../composition';
import { DEFAULT_WALLET_CATEGORIES, type WalletCategories } from '../../domain/WalletRecord';
import type { TimeRange, SummaryData, CategoryGroupData } from '../historyTypes';

interface UseHistoryDetailOptions {
  timeRange: TimeRange;
  initialData?: SummaryData;
}

export function useHistoryDetail({ timeRange, initialData }: UseHistoryDetailOptions) {
  const [loading, setLoading] = useState(!initialData);
  const [summary, setSummary] = useState<SummaryData | undefined>(initialData);
  const [categories, setCategories] = useState<WalletCategories>(DEFAULT_WALLET_CATEGORIES);

  const loadData = useCallback(async () => {
    try {
      const [data, availableCategories] = await Promise.all([
        getLedgerRangeSummary(timeRange.startDate, timeRange.endDate),
        getWalletCategories(),
      ]);
      setCategories(availableCategories);
      setSummary({
        timeRange,
        ...data,
      });
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useFocusEffect(useCallback(() => {
    void loadData();
  }, [loadData]));

  // 按分类分组数据
  const categoryGroups = useMemo((): CategoryGroupData[] => {
    if (!summary) return [];

    const groups: Map<string, CategoryGroupData> = new Map();

    summary.records.forEach((record) => {
      const key = `${record.type}:${record.category}`;
      if (!groups.has(key)) {
        const stat = summary.categoryStats.find(
          (s) => s.category === record.category && s.type === record.type
        );
        groups.set(key, {
          category: record.category,
          type: record.type,
          total: 0,
          percentage: stat?.percentage || 0,
          count: 0,
          color: stat?.color || '#ccc',
          records: [],
        });
      }

      const group = groups.get(key)!;
      group.total += record.amount;
      group.count += 1;
      group.records.push(record);
    });

    // 按支出在前、收入在后排序，同类型按金额降序
    return Array.from(groups.values()).sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'expense' ? -1 : 1;
      }
      return b.total - a.total;
    });
  }, [summary]);

  // 支出和收入分类分开
  const expenseGroups = useMemo(
    () => categoryGroups.filter((g) => g.type === 'expense'),
    [categoryGroups]
  );

  const incomeGroups = useMemo(
    () => categoryGroups.filter((g) => g.type === 'income'),
    [categoryGroups]
  );

  // 饼图数据（仅支出，或如果没有支出则显示收入）
  const pieData = useMemo(() => {
    if (!summary) return [];
    if (summary.totalExpense > 0) {
      return summary.categoryStats.filter((s) => s.type === 'expense');
    }
    return summary.categoryStats.filter((s) => s.type === 'income');
  }, [summary]);

  return {
    loading,
    categories,
    summary,
    categoryGroups,
    expenseGroups,
    incomeGroups,
    pieData,
    reload: loadData,
  };
}
