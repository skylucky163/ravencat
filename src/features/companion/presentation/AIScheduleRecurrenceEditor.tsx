/** 详情只编辑尚未到期的下一期；已发生的期次与历史记录不随规则改写。 */
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Button, InputField } from '@shared/ui';
import { useTheme, useThemedStyles } from '@shared/theme';
import type { AISchedule } from '../domain/AISchedule';
import { isAIScheduleRecurrence, type AIScheduleRecurrence } from '../domain/AIScheduleTiming';
import { updateAIScheduleWithProjection } from '../application/AIScheduleProjectionOwner';
import { createStyles } from './AIScheduleDetail.styles';
import { resolveAIScheduleCommandErrorMessage } from './proactiveLifeViewModel';

const labels = { once: '一次性', daily: '每天', weekly: '每周', monthly: '每月' } as const;
export function AIScheduleRecurrenceEditor({ schedule, onSaved }: { schedule: AISchedule; onSaved(schedule: AISchedule): void }) {
  const styles = useThemedStyles(createStyles);
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<keyof typeof labels>(schedule.recurrence?.frequency ?? 'once');
  const timeZone = schedule.recurrence?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(schedule.remindAt));
  const [time, setTime] = useState(schedule.recurrence
    ? `${String(schedule.recurrence.hour).padStart(2,'0')}:${String(schedule.recurrence.minute).padStart(2,'0')}` : local);
  const [weekdays, setWeekdays] = useState(schedule.recurrence?.weekdays ?? [1]);
  const [monthDay, setMonthDay] = useState(String(schedule.recurrence?.monthDay ?? 1));
  const [hour, minute] = time.split(':').map(Number);
  const recurrence: AIScheduleRecurrence | null = frequency === 'once' ? null : {
    frequency, timeZone, hour, minute,
    ...(frequency === 'weekly' ? { weekdays } : {}),
    ...(frequency === 'monthly' ? { monthDay: Number(monthDay) } : {}),
    ...(schedule.recurrence?.until ? { until: schedule.recurrence.until } : {}),
  };
  const valid = recurrence === null || (/^\d{2}:\d{2}$/.test(time) && isAIScheduleRecurrence(recurrence));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const result = await updateAIScheduleWithProjection({ scheduleId: schedule.scheduleId, ownerAIId: schedule.ownerAIId, recurrence });
      if (result.status === 'error') {
        setError(result.code === 'calendar_permission_required' ? '请先在权限与后台运行中开启系统日历权限。'
          : result.code === 'calendar_unavailable' ? '系统日历当前不可用，重复规则尚未修改。'
          : resolveAIScheduleCommandErrorMessage(result.code)); return;
      }
      onSaved(result.schedule); setEditing(false);
      if (result.projection.status === 'projection_failed' || !['synced','internal_only'].includes(result.calendar)) {
        setError('重复规则已保存，后台提醒同步尚未完成，可恢复权限后回到应用同步。');
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '重复规则保存失败'); }
    finally { setBusy(false); }
  };
  const saved = schedule.recurrence;
  const weekLabels = ['日','一','二','三','四','五','六'];
  return <View style={styles.recurrenceEditor}>
    <Text style={styles.detailDetails}>重复：{labels[saved?.frequency ?? 'once']}{saved
      ? ` ${String(saved.hour).padStart(2,'0')}:${String(saved.minute).padStart(2,'0')}${saved.frequency === 'weekly' ? ` · ${saved.weekdays!.map(day => `周${weekLabels[day]}`).join('、')}` : saved.frequency === 'monthly' ? ` · ${saved.monthDay} 号` : ''} · ${timeZone}` : ''}</Text>
    {saved?.until ? <Text style={styles.detailDetails}>重复至 {new Date(saved.until).toLocaleDateString()}</Text> : null}
    {!editing ? <Button title="修改重复规则" variant="outline" onPress={() => setEditing(true)} /> : <>
      <View style={styles.recurrenceChoices}>{(Object.keys(labels) as (keyof typeof labels)[]).map(value => <Button key={value} title={`${frequency === value ? '✓ ' : ''}${labels[value]}`} variant="outline" disabled={busy} onPress={() => setFrequency(value)} />)}</View>
      {frequency !== 'once' ? <InputField label="时间（24 小时制）" value={time} onChangeText={setTime} placeholder="09:00" hint={`时区：${timeZone}`} onDark={theme.effects.glass.enabled} /> : null}
      {frequency === 'weekly' ? <View style={styles.recurrenceChoices}>{weekLabels.map((day,index) => <Button key={day} title={`${weekdays.includes(index) ? '✓ ' : ''}周${day}`} variant="outline" disabled={busy} onPress={() => setWeekdays(weekdays.includes(index) ? weekdays.filter(value => value !== index) : [...weekdays,index].sort())} />)}</View> : null}
      {frequency === 'monthly' ? <InputField label="每月几号" value={monthDay} onChangeText={setMonthDay} keyboardType="number-pad" hint="1 至 31；遇到不存在的日期按当月最后一天执行。" onDark={theme.effects.glass.enabled} /> : null}
      <Button title="保存重复规则" disabled={busy || !valid} onPress={() => void save()} />
      <Button title="收起" variant="outline" disabled={busy} onPress={() => setEditing(false)} />
    </>}
    {error ? <Text style={styles.detailError}>{error}</Text> : null}
  </View>;
}
