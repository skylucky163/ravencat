import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DropdownField } from '@shared/ui';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { CUSTOM_IMAGE_PARAMETER_OPTIONS, getImageSizeRatio, type CustomImageParameterField } from '@platform/ai/imageGenerationConfig';
import type { CustomImageParameterRow } from './useCustomImageParameters';

const FIELDS = [
  { field: 'size', label: '图片比例' },
  { field: 'quality', label: '渲染画质' },
  { field: 'outputFormat', label: '文件格式' },
] as const;

interface Props {
  rows: Partial<Record<CustomImageParameterField, CustomImageParameterRow>>;
  checking: CustomImageParameterField | null;
  checkPending: boolean;
  disabled: boolean;
  onChange(field: CustomImageParameterField, value: string): void;
  onCheck(field: CustomImageParameterField): void;
}

export default function CustomImageParametersForm({ rows, checking, checkPending, disabled, onChange, onCheck }: Props) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  return <View>
    <Text style={styles.hint}>检测会请求生成 1 张图，可能消耗额度</Text>
    {FIELDS.map(({ field, label }) => {
      const row = rows[field];
      const result = row?.result;
      const active = checking === field;
      const fieldRejected = result?.status === 'rejected' && result.scope === 'field';
      const status = active ? '检测中' : result?.status === 'confirmed' ? '实测生效'
        : result?.status === 'rejected' ? '接口拒绝' : result?.status === 'uncertain' ? '无法确认' : '未检测';
      const color = active ? theme.colors.feedback.warning : result?.status === 'confirmed' ? theme.colors.feedback.success
        : result?.status === 'rejected' ? theme.colors.feedback.error : theme.colors.text.secondary;
      const values = [...new Set([...CUSTOM_IMAGE_PARAMETER_OPTIONS[field], ...(row?.supportedValues ?? [])])].filter(value => value !== 'auto');
      const labels = values.map(value => field === 'size' ? getImageSizeRatio(value) : value);
      const options = values.map((value, index) => ({ value, label: labels.indexOf(labels[index]) === labels.lastIndexOf(labels[index])
        ? labels[index] : `${labels[index]} · ${value.replace('x', ' × ')}` }));
      const checkDisabled = disabled || checkPending || !row?.value || fieldRejected;
      return <View key={field} style={styles.field}>
        <View style={styles.row}>
          <View style={styles.input}><DropdownField label={label} value={row?.value ?? ''} disabled={disabled || fieldRejected}
            options={[{ value: '', label: '服务默认' }, ...options]}
            onChange={value => onChange(field, value)} /></View>
          <Pressable accessibilityRole="button" accessibilityLabel={`检测${label}`} accessibilityState={{ disabled: checkDisabled, busy: active }}
            disabled={checkDisabled} onPress={() => onCheck(field)} style={styles.checkButton}>
            <Text style={[styles.checkLabel, { color }]}>检测</Text>
          </Pressable>
        </View>
        <Text accessibilityLiveRegion="polite" style={[styles.status, { color }]}>
          {status}{!active && result && row.testedValue ? `（${field === 'size' ? getImageSizeRatio(row.testedValue) : row.testedValue}） · ${result.reason}` : ''}
        </Text>
        {!!row?.supportedValues?.length && <Text style={styles.hint}>服务列出的支持值 · {row.supportedValues.join('、')}</Text>}
      </View>;
    })}
  </View>;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  field: { marginTop: theme.spacing.sm },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  input: { flex: 1 },
  checkButton: { alignItems: 'center', justifyContent: 'center', marginTop: 20 + theme.spacing.sm, minWidth: 64, minHeight: 44,
    borderRadius: theme.radius.md, backgroundColor: theme.colors.surface.input },
  checkLabel: { fontSize: 14, fontWeight: '600' },
  hint: { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 20 },
  status: { fontSize: 13, lineHeight: 20, marginTop: -theme.spacing.sm },
});
