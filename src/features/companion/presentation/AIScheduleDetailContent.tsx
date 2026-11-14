import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import { Button, showAppDialog } from '@shared/ui';
import { cancelAIScheduleWithProjection, getAISchedule, removeAIScheduleCalendarEvents } from '../application';
import type { AISchedule } from '../domain/AISchedule';
import { canCancelAISchedule, formatProactiveLifeFullDateTime, resolveAIScheduleCommandErrorMessage } from './proactiveLifeViewModel';
import { createStyles } from './AIScheduleDetail.styles';
import { AIScheduleRecurrenceEditor } from './AIScheduleRecurrenceEditor';

/**
 * AI Schedule 轻量详情：读取完整 durable detail；
 * 取消必须走 projection-aware command，业务失败（如已到点）原样展示 Domain 错误。
 */
export default function AIScheduleDetailContent({
  scheduleId,
  occurrenceAt,
  ownerAIId,
  onClose,
  onCancelled,
}: {
  scheduleId: string;
  occurrenceAt?: string;
  ownerAIId: string;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const [schedule, setSchedule] = useState<AISchedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [removingCalendar, setRemovingCalendar] = useState(false);
  const [calendarNotice, setCalendarNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getAISchedule({ scheduleId, ownerAIId }).then((outcome) => {
      if (!active) return;
      if (outcome.status === 'found') {
        setSchedule(outcome.schedule);
      } else {
        setLoadError(resolveAIScheduleCommandErrorMessage(outcome.code));
      }
    }).catch((error: unknown) => {
      if (active) setLoadError(toMessage(error, '无法读取日程详情。'));
    });
    return () => { active = false; };
  }, [scheduleId, ownerAIId]);

  const confirmCancel = useCallback((scheduleToCancel: AISchedule) => {
    showAppDialog({ title: scheduleToCancel.recurrence ? '停止这条日程的后续重复？' : scheduleToCancel.triggerKind === 'unanswered' ? '停止本次未回复跟进？' : '取消这条日程？', message: scheduleToCancel.summary, buttons: [
      { text: '再想想', style: 'cancel' },
      {
        text: '取消日程',
        style: 'destructive',
        onPress: () => void (async () => {
          setCancelling(true);
          setActionError(null);
          try {
            const outcome = await cancelAIScheduleWithProjection({ scheduleId, ownerAIId });
            if (outcome.status === 'cancelled') {
              onCancelled();
              onClose();
            } else {
              setActionError(resolveAIScheduleCommandErrorMessage(outcome.code));
            }
          } catch (error) {
            setActionError(toMessage(error, '操作失败，请稍后重试。'));
          } finally {
            setCancelling(false);
          }
        })(),
      },
    ] });
  }, [scheduleId, ownerAIId, onCancelled, onClose]);

  const removeCalendar = useCallback(async (selected: AISchedule) => {
    setRemovingCalendar(true);
    setActionError(null);
    setCalendarNotice(null);
    try {
      const outcome = await removeAIScheduleCalendarEvents({ ownerAIId,
        scope: selected.recurrence ? 'series' : 'schedule', scheduleId: selected.scheduleId });
      if (outcome.status === 'error') {
        setActionError(resolveAIScheduleCommandErrorMessage(outcome.code));
      } else {
        setSchedule({ ...selected, systemCalendar: false });
        onCancelled();
        setCalendarNotice(outcome.calendar === 'synced'
          ? '系统日历提醒已移除，应用内日程和后续重复仍保留。'
          : '已关闭系统日历同步，应用内日程仍保留；旧系统事件尚未全部移除，请恢复日历权限或服务后回到应用同步。');
      }
    } catch (error) { setActionError(toMessage(error, '系统日历提醒移除失败。')); }
    finally { setRemovingCalendar(false); }
  }, [ownerAIId, onCancelled]);

  if (loadError) {
    return (
      <View style={styles.detailBody}>
        <Text style={styles.detailError}>{loadError}</Text>
      </View>
    );
  }
  if (!schedule) {
    return (
      <View style={styles.detailLoading}>
        <ActivityIndicator color={theme.colors.brand.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailBody}>
      <Text style={styles.detailTime}>计划时间：{formatProactiveLifeFullDateTime(occurrenceAt ?? schedule.remindAt)}</Text>
      {occurrenceAt ? <Text style={styles.detailDetails}>这是固定重复日程在所选日期的安排。修改重复规则或停止重复会作用于后续系列。最近一次安排：{formatProactiveLifeFullDateTime(schedule.remindAt)}</Text> : null}
      <Text style={styles.detailDetails}>创建时间：{formatProactiveLifeFullDateTime(schedule.createdAt)}</Text>
      <Text style={styles.detailDetails}>实际开始时间：{!occurrenceAt && schedule.claimedAt
        ? formatProactiveLifeFullDateTime(schedule.claimedAt) : '尚未开始'}</Text>
      <Text style={styles.detailSummary}>{schedule.summary}</Text>
      {schedule.triggerKind === 'unanswered' ? <Text style={styles.detailDetails}>未回复续轮：承接此前尚未收到回复的日程。</Text> : null}
      {canCancelAISchedule(schedule, new Date()) && schedule.triggerKind === 'scheduled'
        ? <AIScheduleRecurrenceEditor key={schedule.scheduleId} schedule={schedule} onSaved={value => { setSchedule(value); onCancelled(); if (occurrenceAt) onClose(); }} />
        : schedule.recurrence ? <Text style={styles.detailDetails}>本期重复规则：{schedule.recurrence.frequency === 'daily' ? '每天' : schedule.recurrence.frequency === 'weekly' ? '每周' : '每月'}</Text> : null}
      {schedule.details && schedule.details !== schedule.summary ? (
        <Text style={styles.detailDetails}>{schedule.details}</Text>
      ) : null}
      {schedule.sourceExcerpt ? (
        <>
          <Text style={styles.detailSourceLabel}>来源对话</Text>
          <Text style={styles.detailSourceExcerpt}>{schedule.sourceExcerpt}</Text>
        </>
      ) : null}
      {schedule.status !== 'scheduled' ? (
        <Text style={styles.detailDetails}>{occurrenceAt ? '日程状态已变化，请刷新后查看后续安排。'
          : schedule.triggerKind === 'unanswered' && schedule.status === 'cancelled' ? '本次续轮已结束或已由新的日程接替，不再单独执行。'
          : schedule.cancelledReason === 'expired' ? '已跳过：超过原定时间 15 分钟仍未开始，不再补跑。'
          : schedule.cancelledReason === 'merged_chat' ? '自主执行机会已结束，相关信息已交给正常聊天。'
          : schedule.cancelledReason === 'merged_schedule' ? '已归并到更新的日程，不单独执行。'
          : '这条日程已在执行或已结束。'}</Text>
      ) : null}
      {actionError ? <Text style={styles.detailError}>{actionError}</Text> : null}
      {calendarNotice ? <Text style={styles.detailDetails}>{calendarNotice}</Text> : null}
      {schedule.systemCalendar ? <View style={styles.detailActions}>
        {schedule.recurrence ? <Text style={styles.detailDetails}>将移除整个重复系列的系统日历提醒，应用内日程与后续重复仍保留。</Text> : null}
        <Button title={removingCalendar ? '正在移除系统日历提醒…' : '移除系统日历提醒，保留应用内日程'}
          variant="outline" disabled={cancelling || removingCalendar} onPress={() => void removeCalendar(schedule)} />
      </View> : null}
      {canCancelAISchedule(schedule, new Date()) ? (
        <View style={styles.detailActions}>
          <Button
            title={cancelling ? '正在取消…' : schedule.recurrence ? '停止后续重复' : schedule.triggerKind === 'unanswered' ? '停止本次跟进' : '取消日程'}
            variant="danger"
            onPress={() => confirmCancel(schedule)}
            disabled={cancelling || removingCalendar}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
