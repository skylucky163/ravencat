import React from 'react';
import { Pressable, Text } from 'react-native';
import { ThemedSurface, useThemedStyles } from '@shared/theme';
import { createAssistantSettingsEntriesStyles } from './AssistantSettingsEntries.styles';

export interface AssistantSettingsEntriesProps {
  onOpenModelSettings(): void;
  onOpenContextSettings(): void;
  onOpenSummary(): void;
}

export default function AssistantSettingsEntries({
  onOpenModelSettings, onOpenContextSettings, onOpenSummary,
}: AssistantSettingsEntriesProps) {
  const styles = useThemedStyles(createAssistantSettingsEntriesStyles);
  const entries = [
    { title: '模型设置', onPress: onOpenModelSettings },
    { title: '上下文设置', onPress: onOpenContextSettings },
    { title: '聊天摘要', onPress: onOpenSummary },
  ];
  return <ThemedSurface variant="card" style={styles.card}>
    {entries.map(({ title, onPress }, index) => <Pressable key={title}
      accessibilityRole="button" accessibilityLabel={title} onPress={onPress}
      style={[styles.entry, index < entries.length - 1 && styles.firstEntry]}>
      <Text style={styles.entryTitle}>{title}</Text>
    </Pressable>)}
  </ThemedSurface>;
}
