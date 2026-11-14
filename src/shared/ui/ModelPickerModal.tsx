/** 模型 ID、用途资产和服务选择共用列表外观；查询与保存仍归调用方。 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, RefreshCw } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import ModalSheet from './ModalSheet';
import NavigationHeaderHelp from './NavigationHeaderHelp';
import InputField from './InputField';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  onRefresh?: () => void;
  onClear?: () => void;
  clearSelectionLabel?: string;
  onManageModels?(): void;
}
export default function ModelPickerModal({ visible, models, selectedModel, onSelect, onClose, title = '选择模型',
  description, emptyText = '暂无可用模型，请到辅助模型中心添加配置', disabled = false, loading = false, error,
  onRetry, onRefresh, onClear, clearSelectionLabel = '取消选择', onManageModels,
}: ModelPickerModalProps) {
  const theme = useTheme(), styles = useThemedStyles(createStyles);
  const [query, setQuery] = useState('');
  const pendingManagement = useRef<(() => void) | null>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => { if (!visible) setQuery(''); }, [visible]);
  const filteredModels = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? models.filter(item => `${item.id}\n${item.name}\n${item.model ?? ''}`.toLowerCase().includes(keyword)) : models;
  }, [models, query]);
  const showClear = !!onClear && !loading && !error;
  return <ModalSheet visible={visible} onClose={() => { if (!disabled) onClose(); }} title={title}
    onClosed={() => {
      const navigate = pendingManagement.current;
      pendingManagement.current = null;
      navigate?.();
    }}
    titleAccessory={description ? <NavigationHeaderHelp title={title} sections={[{ title: '选择说明', body: description }]} /> : undefined}
    style={{ maxHeight: '70%', paddingBottom: 0 }}>
    <View style={styles.search}>
      <InputField value={query} onChangeText={setQuery} placeholder="搜索模型" autoCapitalize="none" autoCorrect={false}
        style={{ flex: 1, marginBottom: 0 }} />
      {onRefresh && <Pressable accessibilityRole="button" accessibilityLabel="刷新模型列表" onPress={onRefresh} disabled={disabled || loading} style={styles.refresh}>
        <RefreshCw size={18} color={theme.colors.text.secondary} />
      </Pressable>}
    </View>
    <FlatList style={styles.list} data={loading || error ? [] : filteredModels} keyExtractor={item => item.id} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      ListEmptyComponent={<View style={styles.empty}>{loading ? <ActivityIndicator color={theme.colors.brand.primary} />
        : <><Text style={error ? styles.error : styles.subtitle}>{error || (query.trim() ? '没有匹配的模型' : emptyText)}</Text>
          {error && onRetry ? <Pressable accessibilityRole="button" onPress={onRetry}><Text style={styles.retry}>重新读取</Text></Pressable> : null}</>}
      </View>}
      renderItem={({ item }) => <Pressable accessibilityRole="button"
        accessibilityState={{ selected: selectedModel === item.id, disabled }} disabled={disabled}
        style={styles.item} onPress={() => onSelect(item.id)}>
        <View style={styles.grow}><Text style={[styles.name, selectedModel === item.id && styles.selected]}>{item.name}</Text>
          {item.model ? <Text style={styles.subtitle}>{item.model}</Text> : null}</View>
        {selectedModel === item.id && <Check size={20} color={theme.colors.brand.primary} />}
      </Pressable>} />
    {(showClear || onManageModels) && <View style={[styles.actions, { paddingBottom: Math.max(theme.spacing.lg, insets.bottom) }]}>
      {showClear && <Pressable accessibilityRole="button" accessibilityState={{ selected: selectedModel == null, disabled }}
        disabled={disabled} style={styles.clearAction} onPress={onClear}>
        <Text style={styles.clearLabel}>{clearSelectionLabel}</Text>
        {selectedModel == null && <Check size={18} color={theme.colors.brand.primary} />}
      </Pressable>}
      {onManageModels && <Pressable accessibilityRole="button" accessibilityLabel="管理模型" disabled={disabled}
        style={[styles.manageAction, disabled && styles.disabled]} onPress={() => {
          // 关闭会清空调用方的弹窗类型，保留点击当时的目标，避免关窗后跳错用途。
          pendingManagement.current = onManageModels;
          Keyboard.dismiss();
          onClose();
        }}>
        <Text style={styles.manageLabel}>管理模型</Text>
      </Pressable>}
    </View>}
  </ModalSheet>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
  refresh: { padding: theme.spacing.sm },
  content: { padding: theme.spacing.lg, paddingTop: theme.spacing.sm },
  list: { flexShrink: 1 },
  // 选项直接铺在弹窗玻璃上，不再单独成卡：一层淡玻璃片叠一层淡蓝底只会互相吃掉。
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    minHeight: 60,
    paddingVertical: theme.spacing.md,
  },
  // 底栏不参与列表滚动；取消选择与管理入口各自拥有独立触摸区。
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg, paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
  clearAction: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, minHeight: 48, paddingVertical: theme.spacing.sm },
  clearLabel: { flexShrink: 1, color: theme.colors.text.primary, fontSize: 14 },
  manageAction: { marginLeft: 'auto', minHeight: 48, justifyContent: 'center', paddingHorizontal: theme.spacing.sm },
  manageLabel: { color: theme.colors.brand.primary, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  grow: { flex: 1 },
  name: { color: theme.colors.text.primary, fontSize: 16, fontWeight: '500' },
  selected: { color: theme.colors.brand.primary },
  subtitle: { color: theme.colors.text.secondary, fontSize: 13, lineHeight: 20, marginTop: theme.spacing.xs },
  empty: { padding: theme.spacing.lg, alignItems: 'center' },
  error: { color: theme.colors.feedback.error, fontSize: 14 },
  retry: { color: theme.colors.brand.primary, fontSize: 15, paddingVertical: theme.spacing.md },
});
