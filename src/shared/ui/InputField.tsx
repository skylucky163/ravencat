/** 通用输入框组件。 */

import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import AppTextInput from './AppTextInput';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';

export interface InputFieldProps {
  label?: string;
  hint?: string;
  value: string;
  onChangeText: (text: string) => void;
  onBlur?: () => void;
  error?: string;
  multiline?: boolean;
  /** 内容换行时输入框高度自动增长，单行时保持普通单行高度。 */
  autoGrow?: boolean;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  maxLength?: number;
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad' | 'numeric' | 'email-address' | 'phone-pad' | 'url';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  editable?: boolean;
  numberOfLines?: number;
  textAlignVertical?: 'auto' | 'top' | 'bottom' | 'center';
  /** 落在深色场景上（如玻璃弹层透出深色背景）时，标签、输入文字与输入底改用亮色。 */
  onDark?: boolean;
}

/** 深色场景的占位文字与输入底需要半透明白，主题只提供不透明色。 */
const ON_DARK_PLACEHOLDER = 'rgba(255, 255, 255, 0.45)';

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      marginBottom: theme.spacing.lg,
    },
    label: {
      fontSize: 14,
      color: theme.colors.text.secondary,
      marginBottom: theme.spacing.sm,
      fontWeight: '500',
    },
    labelOnDark: {
      color: theme.colors.text.inverse,
      opacity: 0.7,
    },
    input: {
      backgroundColor: theme.colors.surface.input,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 12,
      fontSize: 16,
      color: theme.colors.text.primary,
    },
    inputOnDark: {
      backgroundColor: 'rgba(255, 255, 255, 0.14)',
      color: theme.colors.text.inverse,
    },
    textArea: {
      height: 80,
      paddingTop: 12,
      textAlignVertical: 'top',
    },
    hint: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
      marginTop: theme.spacing.xs,
    },
  });

export default function InputField({
  label,
  hint,
  value,
  onChangeText,
  onBlur,
  error,
  multiline = false,
  autoGrow = false,
  placeholder,
  style,
  inputStyle,
  maxLength,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  editable,
  numberOfLines,
  textAlignVertical,
  onDark = false,
}: InputFieldProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={[styles.container, style]}>
      {label ? <Text style={[styles.label, onDark && styles.labelOnDark]}>{label}</Text> : null}
      <AppTextInput
        style={[styles.input, multiline && !autoGrow && styles.textArea, onDark && styles.inputOnDark, inputStyle, error && { borderWidth: 1, borderColor: theme.colors.feedback.error }]}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={onDark ? ON_DARK_PLACEHOLDER : theme.colors.text.tertiary}
        multiline={multiline}
        autoGrow={autoGrow}
        maxLength={maxLength}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        editable={editable}
        numberOfLines={numberOfLines}
        textAlignVertical={textAlignVertical}
      />
      {error ? <Text accessibilityRole="alert" style={[styles.hint, { color: theme.colors.feedback.error }]}>{error}</Text> : null}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}
