/** 带文本输入的数值滑杆；草稿解析与自动保存仍由业务表单持有。 */
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import AppTextInput from './AppTextInput';
import Slider from './Slider';

export interface SliderFieldProps {
  label: string;
  description?: string;
  value: number | null;
  inputValue: string;
  onInputChange(value: string): void;
  min: number;
  max: number;
  step: number;
  onSetValue(value: number): void;
  onBlur?: () => void;
  error?: string;
  disabled?: boolean;
  integerInput?: boolean;
  style?: StyleProp<ViewStyle>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  section: { padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.colors.border.light },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spacing.md, gap: theme.spacing.sm },
  label: { flex: 1, fontSize: 16, fontWeight: '600', color: theme.colors.text.primary },
  input: { minWidth: 60, minHeight: 44, paddingHorizontal: theme.spacing.md, paddingVertical: 6, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.border.default, backgroundColor: theme.colors.background.app, fontSize: 16, fontWeight: '600', color: theme.colors.brand.primary, textAlign: 'center' },
  description: { fontSize: 13, color: theme.colors.text.secondary, lineHeight: 18, marginBottom: theme.spacing.md },
  error: { fontSize: 13, color: theme.colors.feedback.error, marginBottom: theme.spacing.sm },
  limits: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 12 },
  limit: { fontSize: 12, color: theme.colors.text.secondary },
});

export default function SliderField({ label, description, value, inputValue, onInputChange,
  min, max, step, onSetValue, onBlur, error, disabled = false, integerInput = false, style,
}: SliderFieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [preview, setPreview] = useState<number | null>(null);
  const complete = useCallback((next: number) => {
    setPreview(null);
    onSetValue(next);
  }, [onSetValue]);

  return (
    <View style={[styles.section, style]}>
      <View style={styles.header}>
        <Text style={styles.label}>{label}</Text>
        <AppTextInput
          style={[styles.input, error && { borderColor: theme.colors.feedback.error }]}
          value={preview === null ? inputValue : String(preview)}
          onChangeText={onInputChange}
          onBlur={onBlur}
          editable={!disabled}
          accessibilityLabel={`${label}数值`}
          keyboardType={integerInput ? 'number-pad' : 'decimal-pad'}
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          maxLength={integerInput ? undefined : 5}
        />
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {description ? <Text style={styles.description}>{description}</Text> : null}
      <Slider
        value={preview ?? value}
        min={min} max={max} step={step}
        onValueChange={setPreview}
        onSlidingComplete={complete}
        disabled={disabled}
        accessibilityLabel={label}
      />
      <View style={styles.limits}><Text style={styles.limit}>{min}</Text><Text style={styles.limit}>{max}</Text></View>
    </View>
  );
}
