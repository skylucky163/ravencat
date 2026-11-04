/**
 * @fileoverview 分类组组件
 */

import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useStyles } from '../styles';
import { formatMonthDay } from '../../utils/timeUtils';
import type { WalletRecord } from '../../../domain/WalletRecord';

interface CategoryGroupProps {
  category: string;
  type: 'income' | 'expense';
  total: number;
  percentage: number;
  count: number;
  color: string;
  records: WalletRecord[];
  onRecordLongPress: (record: WalletRecord) => void;
  mutatingRecordId: string | null;
}

export function CategoryGroup({
  category,
  type,
  total,
  percentage,
  count,
  color,
  records,
  onRecordLongPress,
  mutatingRecordId,
}: CategoryGroupProps) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const displayRecords = expanded ? records : records.slice(0, 5);
  const hasMore = records.length > 5;

  return (
    <View style={styles.categoryGroup}>
      <View style={styles.categoryHeader}>
        <View style={styles.categoryTag}>
          <View style={[styles.categoryDot, { backgroundColor: color }]} />
          <Text style={styles.categoryTagText}>{category}</Text>
        </View>
        <Text
          style={[
            styles.categoryTotal,
            type === 'expense' ? styles.expenseText : styles.incomeText,
          ]}
        >
          {type === 'expense' ? '-' : '+'}¥{total.toFixed(2)}
        </Text>
      </View>

      {displayRecords.map((record) => (
        <TouchableOpacity
          key={record.id}
          style={styles.recordItem}
          onLongPress={() => onRecordLongPress(record)}
          disabled={mutatingRecordId !== null}
        >
          <View style={styles.recordLeft}>
            <Text style={styles.recordDate}>{formatMonthDay(record.recordDate)}</Text>
            <Text style={styles.recordDetail}>
              {record.detail || record.category}
            </Text>
          </View>
          <Text
            style={[
              styles.recordAmount,
              type === 'expense' ? styles.expenseText : styles.incomeText,
            ]}
          >
            {type === 'expense' ? '-' : '+'}¥{record.amount.toFixed(2)}
          </Text>
        </TouchableOpacity>
      ))}

      {hasMore && (
        <TouchableOpacity style={styles.recordItem} onPress={() => setExpanded(!expanded)}>
          <Text style={styles.recordDate}>{expanded ? '收起' : `展开其余 ${records.length - 5} 条记录`}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
