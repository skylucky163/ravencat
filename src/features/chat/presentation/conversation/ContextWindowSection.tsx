/** 消息注入条数按 AI 保存；单聊/群聊分组只说明“什么场景读哪些来源”，同一 AI 下所有群共用数值。 */

import React from 'react';
import { View, Text } from 'react-native';
import { AppTextInput } from '@shared/ui';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { createStyles } from './chatSettingsStyles';
import type { ContextLimitsDraft } from './contextSettingsDraft';

interface ContextWindowFieldMeta {
  field: keyof ContextLimitsDraft;
  label: string;
  description: string;
}

// 单聊场景读取：当前单聊 + 已参加群。群聊场景读取：当前群聊 + 这位 AI 的单聊 + 其他群。
const SINGLE_CHAT_FIELDS: ContextWindowFieldMeta[] = [
  { field: 'privatePrimary', label: '当前单聊消息注入', description: '和这位 AI 单聊时使用' },
  { field: 'groupSecondary', label: '其他群聊消息注入', description: '单聊时带入已参加的群 · 0 为不带入' },
];

const GROUP_CHAT_FIELDS: ContextWindowFieldMeta[] = [
  { field: 'groupPrimary', label: '群聊消息注入', description: '在每个群里聊天时使用' },
  { field: 'privateSecondary', label: '单聊消息注入', description: '群聊时带入这位 AI 的单聊 · 0 为不带入' },
];

interface ContextWindowSectionProps {
  values: ContextLimitsDraft;
  onChange: (field: keyof ContextLimitsDraft, value: string) => void;
  onBlur?: () => void;
  errors?: Partial<Record<keyof ContextLimitsDraft, string>>;
  fixed?: boolean;
  children?: React.ReactNode;
}

/**
 * 上下文可见条数区块
 * @param values - 四个字段的当前输入值
 * @param onChange - 单字段变化回调
 */
export default function ContextWindowSection({ values, onChange, onBlur, errors = {}, fixed = false, children }: ContextWindowSectionProps) {
  const styles = useThemedStyles(createStyles);
  const theme = useTheme();

  const renderField = ({ field, label, description }: ContextWindowFieldMeta) => (
    <View key={field} style={styles.contextLimitField}>
      <View style={styles.contextLimitRow}>
        <View style={styles.rowCopy}>
          <Text style={styles.rowTitle}>{label}</Text>
          <Text style={styles.rowDescription}>{field === 'privatePrimary' && fixed ? '已固定消息起点，此项暂不生效' : description}</Text>
        </View>
        <AppTextInput
          style={[styles.contextLimitInput, field === 'privatePrimary' && fixed && styles.disabled, errors[field] && { borderColor: theme.colors.feedback.error }]}
          accessibilityLabel={label}
          editable={field !== 'privatePrimary' || !fixed}
          value={values[field]}
          onChangeText={(text) => onChange(field, text)}
          onBlur={onBlur}
          keyboardType="number-pad"
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
        />
        <Text style={styles.unit}>条</Text>
      </View>
      {errors[field] ? <Text accessibilityRole="alert" style={styles.contextLimitError}>{errors[field]}</Text> : null}
    </View>
  );

  return (
    <ThemedSurface variant="card" style={styles.settingsSection}>
      <Text style={styles.cardTitle}>按条数注入</Text>
      <Text style={styles.sectionLabel}>单聊</Text>
      {SINGLE_CHAT_FIELDS.map(renderField)}
      <Text style={styles.sectionLabel}>群聊</Text>
      {GROUP_CHAT_FIELDS.map(renderField)}
      {/* 与单聊场景是同一个值，这里只回显，避免两处输入框互相拉扯。 */}
      <View style={styles.contextLimitField}>
        <View style={styles.contextLimitRow}>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>其他群聊消息注入</Text>
            <Text style={styles.rowDescription}>群聊时带入其他已参加的群 · 与单聊场景共用</Text>
          </View>
          <Text style={styles.sharedValue}>{values.groupSecondary} 条</Text>
        </View>
      </View>
      {children}
    </ThemedSurface>
  );
}
