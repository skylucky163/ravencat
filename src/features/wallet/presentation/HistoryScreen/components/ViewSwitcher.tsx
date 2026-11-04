/**
 * @fileoverview 视图切换器组件
 */

import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { ThemedSurface } from '@shared/theme';
import { useHistoryStyles } from '../styles';
import type { ViewType } from '../../historyTypes';

interface ViewSwitcherProps {
  currentView: ViewType;
  onChange: (view: ViewType) => void;
}

const VIEW_OPTIONS: { value: ViewType; label: string }[] = [
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
];

export function ViewSwitcher({ currentView, onChange }: ViewSwitcherProps) {
  const styles = useHistoryStyles();

  return (
    <ThemedSurface variant="card" style={styles.switcherContainer}>
      {VIEW_OPTIONS.map((option) => (
        <TouchableOpacity
          key={option.value}
          style={[
            styles.switcherButton,
            currentView === option.value && styles.switcherButtonActive,
          ]}
          onPress={() => onChange(option.value)}
          accessibilityRole="tab"
          accessibilityState={{ selected: currentView === option.value }}
        >
          <Text
            style={[
              styles.switcherText,
              currentView === option.value && styles.switcherTextActive,
            ]}
          >
            {option.label}
          </Text>
        </TouchableOpacity>
      ))}
    </ThemedSurface>
  );
}
