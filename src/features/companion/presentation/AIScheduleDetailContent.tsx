import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '@shared/theme';
import { Button, showAppDialog } from '@shared/ui';
import { cancelAIScheduleWithProjection, getAISchedule } from '../application';
import type { AISchedule } from '../domain/AISchedule';
import { canCancelAISchedule, formatProactiveLifeFullDateTime, resolveAIScheduleCommandErrorMessage } from './proactiveLifeViewModel';
import { createStyles } from './AIScheduleDetail.styles';

/**
 * AI Schedule 轻量详情：读取完整 durable detail；
 * 取消必须走 projection-aware command，业务失败（如已到点）原样展示 Domain 错误。
 */
export default function AIScheduleDetailContent({
  scheduleId,
  ownerAIId,
  onClose,
  onCancelled,
}: {
  scheduleId: string;
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
    showAppDialog({ title: '取消这条日程？', message: scheduleToCancel.summary, buttons: [
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
      <Text style={styles.detailTime}>计划时间：{formatProactiveLifeFullDateTime(schedule.remindAt)}</Text>
      <Text style={styles.detailDetails}>创建时间：{formatProactiveLifeFullDateTime(schedule.createdAt)}</Text>
      <Text style={styles.detailDetails}>实际开始时间：{schedule.claimedAt
        ? formatProactiveLifeFullDateTime(schedule.claimedAt) : '尚未开始'}</Text>
      <Text style={styles.detailSummary}>{schedule.summary}</Text>
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
        <Text style={styles.detailDetails}>{schedule.cancelledReason === 'expired' ? '已跳过：超过原定时间 15 分钟仍未开始，不再补跑。'
          : schedule.cancelledReason === 'merged_chat' ? '自主执行机会已结束，相关信息已交给正常聊天。'
          : schedule.cancelledReason === 'merged_schedule' ? '已归并到更新的日程，不单独执行。'
          : '这条日程已在执行或已结束。'}</Text>
      ) : null}
      {actionError ? <Text style={styles.detailError}>{actionError}</Text> : null}
      {canCancelAISchedule(schedule, new Date()) ? (
        <View style={styles.detailActions}>
          <Button
            title={cancelling ? '正在取消…' : '取消日程'}
            variant="danger"
            onPress={() => confirmCancel(schedule)}
            disabled={cancelling}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
