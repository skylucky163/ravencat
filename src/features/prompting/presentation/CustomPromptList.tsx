/** 手势、位移与滚动交给排序列表；页面只接收一次完整顺序并保存。 */
import { useThemedStyles } from '@shared/theme';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, Vibration, View } from 'react-native';
import { runOnJS } from 'react-native-reanimated';
import ReorderableList, { reorderItems, type ReorderableListReorderEvent } from 'react-native-reorderable-list';
import type { DefaultUserPrompt } from '../domain/PromptDefaults';
import { CustomPromptRow } from './CustomPromptRow';
import { createCustomPromptStyles } from './customPromptStyles';

interface Props {
  prompts: DefaultUserPrompt[];
  disabled: boolean;
  emptyState: ReactNode;
  onEdit: (prompt: DefaultUserPrompt) => void;
  onToggle: (prompt: DefaultUserPrompt, enabled: boolean) => void;
  /** 调用方负责保存和错误提示；返回时 props 已刷新，失败时保留原顺序。 */
  onReorder: (promptIds: readonly string[]) => Promise<void>;
}

export function CustomPromptList({ prompts, disabled, emptyState, onEdit, onToggle, onReorder }: Props) {
  const styles = useThemedStyles(createCustomPromptStyles);
  const [preview, setPreview] = useState<DefaultUserPrompt[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const items = preview ?? prompts;
  const move = async ({ from, to }: ReorderableListReorderEvent) => {
    const ordered = reorderItems(items, from, to);
    // 排序组件在落位后要求立即更新受控数据，数据库提交不参与动画帧。
    setPreview(ordered);
    setSaving(true);
    try {
      await onReorder(ordered.map((prompt) => prompt.id));
    } finally {
      if (mounted.current) { setPreview(null); setSaving(false); }
    }
  };
  const startDrag = useCallback(() => {
    setDragging(true);
    Vibration.vibrate(18);
  }, []);

  // 空状态占用列表的可用高度，不受虚拟列表内容容器的高度约束。
  if (items.length === 0) return <>{emptyState}</>;

  return <ReorderableList
    style={styles.viewport} contentContainerStyle={styles.content}
    data={items} keyExtractor={(prompt) => prompt.id}
    dragEnabled={!disabled && !saving} shouldUpdateActiveItem
    cellAnimations={{ opacity: 1 }}
    keyboardShouldPersistTaps="handled"
    onDragStart={() => { 'worklet'; runOnJS(startDrag)(); }}
    onDragEnd={() => { 'worklet'; runOnJS(setDragging)(false); }}
    onReorder={(event) => { void move(event); }}
    renderDropIndicator={() => <View pointerEvents="none" style={styles.dropSlot}>
      <Text style={styles.dropLabel}>松手插入</Text>
    </View>}
    renderItem={({ item, index }) => <CustomPromptRow prompt={item} index={index} styles={styles}
      disabled={disabled || saving} sorting={dragging}
      onEdit={() => onEdit(item)} onToggle={(enabled) => onToggle(item, enabled)}
      onMove={(offset) => {
        const to = index + offset;
        if (to >= 0 && to < items.length) void move({ from: index, to });
      }} />}
  />;
}
