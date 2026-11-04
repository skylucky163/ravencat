/**
 * @fileoverview 历史账单卡片
 *
 * 日/周/月卡只在标题与副标题上不同，金额、笔数和空状态共用这份排版。
 */

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useHistoryStyles } from '../styles';
import type { SummaryData } from '../../historyTypes';

interface HistoryCardProps {
  title: string;
  subtitle: string;
  summary?: SummaryData;
  onPress: () => void;
}

export function HistoryCard({ title, subtitle, summary, onPress }: HistoryCardProps) {
  const styles = useHistoryStyles();
  const hasData = summary && (summary.totalExpense > 0 || summary.totalIncome > 0);

  return (
    <TouchableOpacity style={styles.card} onPress={onPress}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardSubtitle}>{subtitle}</Text>
      </View>

      <View style={styles.cardBody}>
        {hasData ? (
          <>
            <View>
              {summary.totalExpense > 0 && (
                <Text style={[styles.cardAmount, styles.expenseText]}>
                  -¥{summary.totalExpense.toFixed(2)}
                </Text>
              )}
              {summary.totalIncome > 0 && (
                <Text style={[styles.cardAmount, styles.incomeText]}>
                  +¥{summary.totalIncome.toFixed(2)}
                </Text>
              )}
            </View>
            <Text style={styles.cardSubtitle}>{summary.records.length} 笔</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>无记录</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}
