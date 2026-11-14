import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import AppTextInput from './AppTextInput';

export interface ModelPickerFieldProps {
  label: string; value: string; displayValue?: string; placeholder?: string;
  onPress?: () => void; onChangeText?: (value: string) => void; onBlur?: () => void;
  error?: string; disabled?: boolean; loading?: boolean;
}

/** 统一模型字段的手输入口和选择箭头；候选查询、选择与提交仍归调用方。 */
export default function ModelPickerField({ label, value, displayValue, placeholder = '选择模型', onPress, onChangeText, onBlur,
  error, disabled = false, loading = false }: ModelPickerFieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const indicator = loading ? <ActivityIndicator size="small" color={theme.colors.brand.primary} />
    : <ChevronRight size={18} color={theme.colors.text.secondary} />;
  const rowStyle = [styles.row, disabled && styles.disabled, error && { borderWidth: 1, borderColor: theme.colors.feedback.error }];
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    {onChangeText ? <View style={rowStyle}>
      <AppTextInput value={value} onChangeText={onChangeText} onBlur={onBlur} editable={!disabled}
        autoCapitalize="none" autoCorrect={false} placeholder={placeholder} style={styles.input} />
      {onPress && <Pressable accessibilityRole="button" accessibilityLabel="选择模型" disabled={disabled || loading}
        onPress={onPress} hitSlop={8} style={styles.arrow}>{indicator}</Pressable>}
    </View> : <Pressable accessibilityRole="button" accessibilityLabel="选择模型" disabled={disabled || loading || !onPress}
      onPress={onPress} style={rowStyle}>
      <Text numberOfLines={2} style={[styles.value, !(displayValue ?? value) && { color: theme.colors.text.tertiary }]}>{displayValue ?? (value || placeholder)}</Text>
      {indicator}
    </Pressable>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>;
}
const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  field: { marginBottom: theme.spacing.lg },
  label: { fontSize: 14, fontWeight: '500', color: theme.colors.text.secondary, marginBottom: theme.spacing.sm },
  row: { minHeight: 48, paddingHorizontal: theme.spacing.md, flexDirection: 'row', alignItems: 'center',
    gap: theme.spacing.sm, backgroundColor: theme.colors.surface.input, borderRadius: theme.radius.md },
  value: { flex: 1, color: theme.colors.text.primary, fontSize: 16, lineHeight: 23, paddingVertical: 12 },
  input: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 23, paddingVertical: 12 },
  arrow: { minWidth: 28, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  disabled: { opacity: 0.5 },
  error: { color: theme.colors.feedback.error, fontSize: 12, marginTop: theme.spacing.xs },
});
