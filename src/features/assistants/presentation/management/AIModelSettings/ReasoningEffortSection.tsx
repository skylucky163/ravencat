/** 六档表达用户偏好；实际模型强度与请求共用同一映射，不在 UI 猜测 token 预算。 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { REASONING_EFFORTS, REASONING_EFFORT_LABELS, getReasoningEffortOptions, resolveReasoningEffort, type ReasoningEffort } from '@platform/ai';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';
import { Slider } from '@shared/ui';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  section: { padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.colors.border.light },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing.sm },
  label: { fontSize: 16, fontWeight: '600', color: theme.colors.text.primary },
  value: { fontSize: 16, fontWeight: '600', color: theme.colors.brand.primary },
  description: { fontSize: 13, lineHeight: 19, marginTop: theme.spacing.sm, color: theme.colors.text.secondary },
  ticks: { flexDirection: 'row', marginHorizontal: 12, justifyContent: 'space-between' },
  tick: { fontSize: 11, color: theme.colors.text.secondary, width: 28, marginHorizontal: -14, textAlign: 'center' },
  selected: { color: theme.colors.brand.primary, fontWeight: '600' },
});

export default function ReasoningEffortSection({ baseURL, model, value, disabled, onChange }: {
  baseURL: string; model: string; value: ReasoningEffort; disabled: boolean;
  onChange(value: ReasoningEffort): void;
}) {
  const styles = useThemedStyles(createStyles);
  const [preview, setPreview] = useState<number | null>(null);
  const selected = preview === null ? value : REASONING_EFFORTS[preview];
  const supported = getReasoningEffortOptions(baseURL, model).length > 1;
  const effective = resolveReasoningEffort(baseURL, model, selected);
  const label = REASONING_EFFORT_LABELS[selected];
  let description: string;
  if (disabled) description = '已关闭思维链，强度选择会保留，重新开启后生效。固定思考模型仍遵循服务商限制。';
  else if (!supported) description = '当前模型未确认支持强度调节，使用服务商默认策略；仅支持思考开关的模型不能调节强度。';
  else if (selected === 'auto') description = '自动：不指定思考强度，使用服务商默认策略，不代表所有模型都会自动判断任务难度。';
  else if (/^https?:\/\/openrouter\.ai(?:[/:]|$)/i.test(baseURL)) description = '通过 OpenRouter 按模型能力换算强度；不同档位可能映射到相同预算。';
  else description = `当前模型实际使用「${REASONING_EFFORT_LABELS[effective]}」（${effective}）。六档偏好按模型能力映射，部分档位效果相同。`;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.label}>思考强度</Text>
        <Text style={styles.value}>{label}</Text>
      </View>
      <Text style={styles.description}>{description}</Text>
      <Slider value={REASONING_EFFORTS.indexOf(selected)} min={0} max={6} step={1}
        onValueChange={setPreview}
        onSlidingComplete={(next) => { setPreview(null); onChange(REASONING_EFFORTS[next]); }}
        disabled={disabled || !supported} showStepMarkers
        accessibilityLabel="思考强度"
        accessibilityValueText={`${label}，${description}`}
      />
      <View style={styles.ticks}>
        {REASONING_EFFORTS.map((effort) => (
          <Text key={effort} style={[styles.tick, selected === effort && styles.selected]}>{REASONING_EFFORT_LABELS[effort]}</Text>
        ))}
      </View>
    </View>
  );
}
