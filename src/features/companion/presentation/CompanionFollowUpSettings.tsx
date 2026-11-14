/** 用户拥有续轮总开关和默认间隔；AI 的单次调整不修改这里的偏好。 */
import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { ThemedSurface, useThemedStyles } from '@shared/theme';
import { Button, InputField, ModalSheet, ToggleField } from '@shared/ui';
import type { CompanionSettings } from '../domain/CompanionSettings';
import { isFollowUpInterval } from '../domain/AIScheduleTiming';
import { updateCompanionProductSettings } from '../application/CompanionSettingsFacade';
import { createStyles } from './CompanionSettingsShared.styles';

export function CompanionFollowUpSettings({ settings, onChange, onError }: {
  settings: CompanionSettings;
  onChange(settings: CompanionSettings): void;
  onError(message: string): void;
}) {
  const styles = useThemedStyles(createStyles);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('10');
  const [busy, setBusy] = useState(false);
  const save = async (updates: { followUpEnabled?: boolean; followUpIntervalMinutes?: number }) => {
    setBusy(true);
    try { onChange(await updateCompanionProductSettings(updates)); setEditing(false); }
    catch (error) { onError(error instanceof Error ? error.message : '续轮设置保存失败'); }
    finally { setBusy(false); }
  };
  const valid = /^\d+$/.test(draft) && isFollowUpInterval(Number(draft));
  return <>
    <ThemedSurface variant="card" style={styles.card}>
      <View style={styles.cardContent}>
        <ToggleField label="未回复时继续跟进" hint="日程发出消息后，若你未回复，AI 可继续行动；发送任意真实聊天消息即可结束本次等待。" value={settings.followUpEnabled} onValueChange={value => void save({ followUpEnabled: value })} disabled={busy} />
        <TouchableOpacity style={styles.settingRow} disabled={busy} onPress={() => { setDraft(String(settings.followUpIntervalMinutes)); setEditing(true); }} accessibilityRole="button">
          <View><Text style={styles.settingLabel}>默认续轮间隔</Text><Text style={styles.settingHint}>从每轮结束后计算，AI 可调整下一次间隔</Text></View>
          <Text style={styles.settingValue}>{settings.followUpIntervalMinutes} 分钟</Text>
        </TouchableOpacity>
      </View>
    </ThemedSurface>
    <ModalSheet visible={editing} onClose={() => setEditing(false)} title="默认续轮间隔">
      <InputField label="间隔（分钟）" value={draft} onChangeText={setDraft} keyboardType="number-pad" hint="最少 2 分钟，最多 43200 分钟；不会在上一轮执行时叠加启动。" />
      <Button title="保存" disabled={busy || !valid} onPress={() => void save({ followUpIntervalMinutes: Number(draft) })} />
    </ModalSheet>
  </>;
}
