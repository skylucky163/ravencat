/**
 * @fileoverview HistoryDetailScreen - 历史记账详情页
 * 
 * 显示指定时间范围的统计详情，包括饼图和分类列表
 */

import React, { useEffect } from 'react';
import { ScrollView, View, Text, ActivityIndicator, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { PieChart } from './components/PieChart';
import { Legend } from './components/Legend';
import { CategoryList } from './components/CategoryList';
import { useHistoryDetail } from './useHistoryDetail';
import { useStyles } from './styles';
import { ThemedSurface, useTheme } from '@shared/theme';
import type { HistoryDetailScreenProps } from '../historyTypes';
import AddRecordModal from '../AddRecordModal';
import { useWalletRecordActions } from '../useWalletRecordActions';

export default function HistoryDetailScreen({
  onBack,
  timeRange,
  initialData,
}: HistoryDetailScreenProps) {
  const styles = useStyles();
  const theme = useTheme();
  const { loading, summary, categories, expenseGroups, incomeGroups, pieData, reload } = useHistoryDetail({
    timeRange,
    initialData,
  });
  const recordActions = useWalletRecordActions(reload);

  // 处理 Android 返回键，返回历史记账列表
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack?.();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <NavigationHeader title="收支详情" onGoBack={onBack} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.brand.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const totalAmount =
    pieData.length > 0 && pieData[0]?.type === 'income'
      ? summary?.totalIncome || 0
      : summary?.totalExpense || 0;

  return (
    <SafeAreaView style={styles.container}>
      <NavigationHeader title="收支详情" onGoBack={onBack} />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <ThemedSurface variant="card" style={styles.header}>
          <Text style={styles.headerTitle}>时间范围</Text>
          <Text style={styles.headerDate}>{timeRange.label}</Text>

          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>支出</Text>
              <Text style={[styles.summaryValue, styles.expenseText]}>
                ¥{(summary?.totalExpense || 0).toFixed(2)}
              </Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>收入</Text>
              <Text style={[styles.summaryValue, styles.incomeText]}>
                ¥{(summary?.totalIncome || 0).toFixed(2)}
              </Text>
            </View>
          </View>
        </ThemedSurface>

        <View style={styles.divider} />

        {/* 饼图区域 */}
        <ThemedSurface variant="card" style={styles.chartSection}>
          <PieChart data={pieData} total={totalAmount} />
          <Legend data={pieData} />
        </ThemedSurface>

        <View style={styles.divider} />

        {/* 分类列表 */}
        <CategoryList
          expenseGroups={expenseGroups}
          incomeGroups={incomeGroups}
          onRecordLongPress={recordActions.showRecordActions}
          mutatingRecordId={recordActions.mutatingRecordId}
        />
      </ScrollView>
      <AddRecordModal
        visible={recordActions.editingRecord !== null}
        availableCategories={categories}
        initialRecord={recordActions.editingRecord}
        onClose={recordActions.closeEditor}
        onSave={recordActions.saveRecord}
      />
    </SafeAreaView>
  );
}
