/**
 * @fileoverview HistoryScreen 状态逻辑
 *
 * 范围窗口只向后追加：每页只查询尚未加载的范围；首屏不足一屏时由 CardList 继续要下一页。
 */

import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { getLedgerRangeSummary } from '../../composition';
import {
  buildHistoryRanges,
  getTimeRangeKey,
  previousHistoryCursor,
} from '../utils/timeUtils';
import type { ViewType, TimeRange, SummaryData } from '../historyTypes';

interface UseHistoryScreenOptions {
  initialView: ViewType;
  initialDate: Date;
  onSelectTimeRange: (timeRange: TimeRange, summary: SummaryData) => void;
}

export function useHistoryScreen({
  initialView,
  initialDate,
  onSelectTimeRange,
}: UseHistoryScreenOptions) {
  const [currentView, setCurrentView] = useState<ViewType>(initialView);
  const [timeRanges, setTimeRanges] = useState<TimeRange[]>(() =>
    buildHistoryRanges(initialView, initialDate)
  );
  const [summaries, setSummaries] = useState<Map<string, SummaryData>>(new Map());
  const [loading, setLoading] = useState(false);

  // 窗口游标、已展开范围、单飞标记和换代标记都要同步读取，不能等下一次渲染。
  const rangesRef = useRef(timeRanges);
  const viewRef = useRef(initialView);
  const cursorRef = useRef(initialDate);
  const rangeKeysRef = useRef(new Set(timeRanges.map(getTimeRangeKey)));
  const pendingRef = useRef(false);
  const focusedRef = useRef(false);
  const refreshNeededRef = useRef(true);
  const exhaustedRef = useRef(false);
  const autoFillStoppedRef = useRef(false);
  const epochRef = useRef(0);

  /** 只查询传入范围并按 key 合并；换代后的响应直接丢弃，不能覆盖新视图。 */
  const loadRanges = useCallback(async (ranges: TimeRange[], refresh = false) => {
    const epoch = epochRef.current;
    pendingRef.current = true;
    setLoading(true);
    try {
      const entries = await Promise.all(
        ranges.map(async (range) => {
          const summary = await getLedgerRangeSummary(range.startDate, range.endDate);
          return [getTimeRangeKey(range), { timeRange: range, ...summary }] as const;
        })
      );
      if (epoch !== epochRef.current) return false;
      if (refresh) refreshNeededRef.current = false;
      setSummaries((previous) => new Map([...previous, ...entries]));
      return true;
    } catch (error) {
      if (epoch !== epochRef.current) return false;
      // 当前查询失败后暂停自动补齐；显式触底仍可重试，旧视图的失败不影响新视图。
      autoFillStoppedRef.current = true;
      console.error('[WalletHistory] Failed to load ranges:', error);
      return false;
    } finally {
      if (epoch === epochRef.current) {
        pendingRef.current = false;
        setLoading(false);
      }
    }
  }, []);

  /** 回到指定视图的第一页，并换上新的换代标记。 */
  const resetToView = useCallback(
    (view: ViewType) => {
      epochRef.current += 1;
      pendingRef.current = false;
      exhaustedRef.current = false;
      autoFillStoppedRef.current = false;
      refreshNeededRef.current = true;
      viewRef.current = view;

      const cursor = new Date();
      cursorRef.current = cursor;
      const ranges = buildHistoryRanges(view, cursor);
      rangeKeysRef.current = new Set(ranges.map(getTimeRangeKey));
      rangesRef.current = ranges;

      setTimeRanges(ranges);
      setSummaries(new Map());
      void loadRanges(ranges, true);
    },
    [loadRanges]
  );

  /** 追加历史一页：游标前进一个周期，只请求尚未加载的范围。 */
  const appendPage = useCallback(async () => {
    if (!focusedRef.current || pendingRef.current || exhaustedRef.current) return;
    if (refreshNeededRef.current) {
      await loadRanges(rangesRef.current, true);
      return;
    }

    const epoch = epochRef.current;
    const nextCursor = previousHistoryCursor(viewRef.current, cursorRef.current);
    const fresh = buildHistoryRanges(viewRef.current, nextCursor).filter(
      (range) => !rangeKeysRef.current.has(getTimeRangeKey(range))
    );
    if (fresh.length === 0) {
      // 到达该视图能表达的边界；继续请求只会得到同一批范围。
      exhaustedRef.current = true;
      return;
    }

    if (!(await loadRanges(fresh))) return;
    if (epoch !== epochRef.current) return;

    for (const range of fresh) rangeKeysRef.current.add(getTimeRangeKey(range));
    cursorRef.current = nextCursor;
    rangesRef.current = [...rangesRef.current, ...fresh];
    setTimeRanges(rangesRef.current);
  }, [loadRanges]);

  /** 重新获得焦点时刷新已展示范围；不改变已加载的窗口。 */
  // 从详情编辑或 AI 聊天返回后重新查询，不能继续使用旧统计缓存。
  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    refreshNeededRef.current = true;
    autoFillStoppedRef.current = false;
    void loadRanges(rangesRef.current, true);
    // 焦点拥有查询接纳与响应资格：离开或卸载即撤销，返回时不等待旧请求。
    return () => {
      focusedRef.current = false;
      epochRef.current += 1;
      pendingRef.current = false;
    };
  }, [loadRanges]));

  const handleViewChange = useCallback(
    (view: ViewType) => {
      setCurrentView(view);
      resetToView(view);
    },
    [resetToView]
  );

  const handleLoadMore = useCallback(() => {
    autoFillStoppedRef.current = false;
    void appendPage();
  }, [appendPage]);

  // 首屏内容不足一屏时由列表继续要下一页，直到填满或到达边界。
  const handleContentShort = useCallback(() => {
    if (autoFillStoppedRef.current) return;
    void appendPage();
  }, [appendPage]);

  const handleSelectCard = useCallback(
    (timeRange: TimeRange) => {
      const summary = summaries.get(getTimeRangeKey(timeRange));
      if (summary) {
        onSelectTimeRange(timeRange, summary);
      }
    },
    [summaries, onSelectTimeRange]
  );

  return {
    currentView,
    timeRanges,
    loading,
    summaries,
    handleViewChange,
    handleLoadMore,
    handleContentShort,
    handleSelectCard,
  };
}
