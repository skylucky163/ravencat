/**
 * @fileoverview HistoryScreen - 历史记账主页面
 *
 * 显示周/月/年三种视图的时间卡片列表
 */

import React, { useEffect } from 'react';
import { View, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { ViewSwitcher } from './components/ViewSwitcher';
import { CardList } from './components/CardList';
import { useHistoryScreen } from './useHistoryScreen';
import { useHistoryStyles } from './styles';
import type { HistoryScreenProps } from '../historyTypes';

export default function HistoryScreen({
  onBack,
  onSelectTimeRange,
  onViewChange,
  initialView = 'month',
  initialDate = new Date(),
}: HistoryScreenProps) {
  const styles = useHistoryStyles();
  const {
    currentView,
    timeRanges,
    loading,
    summaries,
    handleViewChange,
    handleLoadMore,
    handleContentShort,
    handleSelectCard,
  } = useHistoryScreen({
    initialView,
    initialDate,
    onSelectTimeRange,
  });

  // 处理 Android 返回键，返回羽库主界面
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack?.();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  return (
    <SafeAreaView style={styles.container}>
      <NavigationHeader title="历史记账" onGoBack={onBack} />

      <View style={styles.content}>
        <ViewSwitcher
          currentView={currentView}
          onChange={(view) => {
            handleViewChange(view);
            onViewChange?.(view);
          }}
        />

        <CardList
          viewType={currentView}
          timeRanges={timeRanges}
          summaries={summaries}
          loading={loading}
          onSelect={handleSelectCard}
          onLoadMore={handleLoadMore}
          onContentShort={handleContentShort}
        />
      </View>
    </SafeAreaView>
  );
}
