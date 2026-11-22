// 可留空的 Max Tokens 输入区块

import React from 'react';
import { View, Text } from 'react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import { AppTextInput } from '@shared/ui';
import { createModelSettingsStyles } from './styles';

interface MaxTokensSectionProps {
  value: string;
  onChangeText: (text: string) => void;
  onBlur?: () => void;
  error?: string;
}

/**
 * Max Tokens 区块
 * @param value - 当前值
 * @param onChangeText - 变化回调
 */
export default function MaxTokensSection({ value, onChangeText, onBlur, error }: MaxTokensSectionProps) {
  const styles = useThemedStyles(createModelSettingsStyles);
  const theme = useTheme();

  return (
    <View style={[styles.section, styles.sectionLightBorder]}>
      <View style={styles.modelSectionHeader}>
        <Text style={styles.sectionLabel}>Max Tokens</Text>
        <AppTextInput
          accessibilityLabel="Max Tokens"
          style={[styles.paramInput, error && { borderColor: theme.colors.feedback.error }]}
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          keyboardType="number-pad"
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          maxLength={5}
        />
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.feedback.error, fontSize: 13, marginBottom: theme.spacing.sm }}>{error}</Text> : null}
      <Text style={styles.paramDescription}>留空使用服务商默认值。</Text>
    </View>
  );
}
