/** 卡片只负责名称、开关和长按入口，位移动画由排序组件统一拥有。 */
import { ThemedSurface } from '@shared/theme';
import { ToggleField } from '@shared/ui';
import { GripVertical } from 'lucide-react-native';
import React from 'react';
import { Pressable, Text, TouchableOpacity } from 'react-native';
import { useIsActive, useReorderableDrag } from 'react-native-reorderable-list';
import type { DefaultUserPrompt } from '../domain/PromptDefaults';
import type { createCustomPromptStyles } from './customPromptStyles';

export function CustomPromptRow({ prompt, index, disabled, sorting, styles, onEdit, onToggle, onMove }: {
  prompt: DefaultUserPrompt;
  index: number;
  disabled: boolean;
  sorting: boolean;
  styles: ReturnType<typeof createCustomPromptStyles>;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onMove: (offset: number) => void;
}) {
  const drag = useReorderableDrag();
  const active = useIsActive();
  return <Pressable accessible={false} disabled={disabled} delayLongPress={300} onLongPress={drag} style={styles.cell}>
    <ThemedSurface variant="card" nativeGlass={false} style={[styles.card, active && styles.selected]}>
      <ToggleField layout="inline" rowStyle={styles.row} label={prompt.name}
        accessibilityLabel={`启用提示词：${prompt.name}`} disabled={disabled || sorting}
        value={prompt.enabled} onValueChange={onToggle}>
        <TouchableOpacity activeOpacity={0.65} disabled={disabled} style={styles.edit}
          accessibilityRole="button" accessibilityLabel={`编辑提示词：${prompt.name}`}
          accessibilityHint="点击编辑全文，长按卡片拖动排序，也可使用上移或下移操作"
          accessibilityState={{ disabled: disabled || sorting, selected: active }}
          accessibilityActions={[{ name: 'increment', label: '下移' }, { name: 'decrement', label: '上移' }]}
          onAccessibilityAction={(event) => { if (!disabled && !sorting) onMove(event.nativeEvent.actionName === 'increment' ? 1 : -1); }}
          delayLongPress={300} onLongPress={drag} onPress={() => { if (!sorting) onEdit(); }}>
          <GripVertical size={16} color={styles.grip.color} />
          <Text style={[styles.number, active && styles.selectedNumber]}>{index + 1}</Text>
          <Text style={styles.name} numberOfLines={2}>{prompt.name}</Text>
        </TouchableOpacity>
      </ToggleField>
    </ThemedSurface>
  </Pressable>;
}
