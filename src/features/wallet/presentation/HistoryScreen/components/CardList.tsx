/**
 * @fileoverview 卡片列表容器
 *
 * 分页由两个来源驱动：接近底部（用户拖动后）追加一页；首屏内容不足一屏时继续追加。
 */

import React, { useEffect, useRef } from 'react';
import { FlatList, ActivityIndicator, View } from 'react-native';
import { useTheme } from '@shared/theme';
import { HistoryCard } from './HistoryCard';
import { useHistoryStyles } from '../styles';
import { describeHistoryRange, getTimeRangeKey } from '../../utils/timeUtils';
import type { ViewType, TimeRange, SummaryData } from '../../historyTypes';

interface CardListProps {
  viewType: ViewType;
  timeRanges: TimeRange[];
  summaries: Map<string, SummaryData>;
  loading: boolean;
  onSelect: (timeRange: TimeRange) => void;
  onLoadMore: () => void;
  onContentShort: () => void;
}

export function CardList({
  viewType,
  timeRanges,
  summaries,
  loading,
  onSelect,
  onLoadMore,
  onContentShort,
}: CardListProps) {
  const styles = useHistoryStyles();
  const theme = useTheme();
  const metrics = useRef<{ content: number | null; viewport: number }>({ content: null, viewport: 0 });
  // 一次“内容短于视口”的测量只补一页，否则数据到达后会在同一次测量上反复追加。
  const shortSeq = useRef(0);
  const filledSeq = useRef(-1);
  // 触底只在用户主动拖动后生效：内容变高会让 FlatList 在同一手势内再次触底。
  const endReachedArmed = useRef(false);

  const measure = (next: Partial<{ content: number; viewport: number }>) => {
    Object.assign(metrics.current, next);
    const { content, viewport } = metrics.current;
    if (viewport === 0 || content === null || content >= viewport) return;
    shortSeq.current += 1;
    if (loading) return;
    filledSeq.current = shortSeq.current;
    onContentShort();
  };

  // 测量可能早于首屏数据到达，加载结束后补一次判断。
  useEffect(() => {
    const { content, viewport } = metrics.current;
    if (loading || viewport === 0 || content === null || content >= viewport) return;
    if (filledSeq.current === shortSeq.current) return;
    filledSeq.current = shortSeq.current;
    onContentShort();
  }, [loading, summaries, onContentShort]);

  const renderItem = ({ item }: { item: TimeRange }) => {
    const { title, subtitle } = describeHistoryRange(item, viewType);
    return (
      <HistoryCard
        title={title}
        subtitle={subtitle}
        summary={summaries.get(getTimeRangeKey(item))}
        onPress={() => onSelect(item)}
      />
    );
  };

  const renderFooter = () => {
    if (!loading) return null;
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={theme.colors.brand.primary} />
      </View>
    );
  };

  return (
    <FlatList
      data={timeRanges}
      renderItem={renderItem}
      keyExtractor={(item) => getTimeRangeKey(item)}
      contentContainerStyle={styles.listContainer}
      ListFooterComponent={renderFooter}
      onLayout={(event) => measure({ viewport: event.nativeEvent.layout.height })}
      onContentSizeChange={(_width, height) => measure({ content: height })}
      onScrollBeginDrag={() => {
        endReachedArmed.current = true;
      }}
      onEndReached={() => {
        if (loading || !endReachedArmed.current) return;
        endReachedArmed.current = false;
        onLoadMore();
      }}
      onEndReachedThreshold={0.2}
    />
  );
}
