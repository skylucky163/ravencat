/** 模型 ID、用途资产和服务选择共用列表外观；查询与保存仍归调用方。 */
import React from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import ModalSheet from './ModalSheet';
import NavigationHeaderHelp from './NavigationHeaderHelp';

export interface ModelPickerItem { id: string; name: string; model?: string }
export interface ModelPickerModalProps {
  visible: boolean;
  models: ModelPickerItem[];
  selectedModel?: string | null;
  onSelect(modelId: string): void;
  onClose(): void;
  title?: string;
  description?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onClear?: () => void;
  clearSelectionLabel?: string;
}
export default function ModelPickerModal({ visible, models, selectedModel, onSelect, onClose, title = '选择模型',
  description, emptyText = '暂无可用模型，请到辅助模型中心添加配置', disabled = false, loading = false, error,
  onRetry, onClear, clearSelectionLabel = '取消选择',
}: ModelPickerModalProps) {
  const theme = useTheme(), styles = useThemedStyles(createStyles);
  const showClear = !!onClear && !loading && !error;
  return <ModalSheet visible={visible} onClose={() => { if (!disabled) onClose(); }} title={title}
    titleAccessory={description ? <NavigationHeaderHelp title={title} sections={[{ title: '选择说明', body: description }]} /> : undefined}
    style={{ maxHeight: '70%', paddingBottom: 0 }}>
    <FlatList data={loading || error ? [] : models} keyExtractor={item => item.id} contentContainerStyle={styles.content}
      ListFooterComponent={showClear ? <Pressable accessibilityRole="button" disabled={disabled}
        style={[styles.item, styles.clearItem]} onPress={onClear}>
        <Text style={[styles.name, styles.grow]}>{clearSelectionLabel}</Text>
        {selectedModel == null && <Check size={20} color={theme.colors.brand.primary} />}
      </Pressable> : null}
      ListEmptyComponent={<View style={styles.empty}>{loading ? <ActivityIndicator color={theme.colors.brand.primary} />
        : <><Text style={error ? styles.error : styles.subtitle}>{error || emptyText}</Text>
          {error && onRetry ? <Pressable accessibilityRole="button" onPress={onRetry}><Text style={styles.retry}>重新读取</Text></Pressable> : null}</>}
      </View>}
      renderItem={({ item }) => <Pressable accessibilityRole="button"
        accessibilityState={{ selected: selectedModel === item.id, disabled }} disabled={disabled}
        style={styles.item} onPress={() => onSelect(item.id)}>
        <View style={styles.grow}><Text style={[styles.name, selectedModel === item.id && styles.selected]}>{item.name}</Text>
          {item.model ? <Text style={styles.subtitle}>{item.model}</Text> : null}</View>
        {selectedModel === item.id && <Check size={20} color={theme.colors.brand.primary} />}
      </Pressable>} />
  </ModalSheet>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  content: { padding: theme.spacing.lg, paddingTop: theme.spacing.sm },
  // 选项直接铺在弹窗玻璃上，不再单独成卡：一层淡玻璃片叠一层淡蓝底只会互相吃掉。
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 60,
    paddingVertical: theme.spacing.md,
  },
  // 「取消选择」不是候选项，靠上间距与列表分开。
  clearItem: { marginTop: theme.spacing.sm },
  grow: { flex: 1 },
  name: { color: theme.colors.text.primary, fontSize: 16, fontWeight: '500' },
  selected: { color: theme.colors.brand.primary },
  subtitle: { color: theme.colors.text.secondary, fontSize: 13, lineHeight: 20, marginTop: theme.spacing.xs },
  empty: { padding: theme.spacing.lg, alignItems: 'center' },
  error: { color: theme.colors.feedback.error, fontSize: 14 },
  retry: { color: theme.colors.brand.primary, fontSize: 15, paddingVertical: theme.spacing.md },
});
