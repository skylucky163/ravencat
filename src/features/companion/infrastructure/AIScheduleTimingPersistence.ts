/** 与日程状态转换共用事务的重复推进和未回复等待，不拥有独立调度队列。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { createAISchedule, type AISchedule } from '../domain/AISchedule';
import { nextAIScheduleTime } from '../domain/AIScheduleTiming';

export async function insertSchedule(tx: DatabaseTransactionExecutor, schedule: AISchedule): Promise<void> {
  await tx.runAsync(`INSERT INTO raven_cat_ai_schedules (
    schedule_id,owner_ai_id,remind_at,summary,details,system_calendar,source_conversation_id,
    source_message_ids_json,source_excerpt,status,claimed_by_run_id,claimed_at,consumed_at,
    completion_disposition,cancelled_at,cancelled_reason,created_at,updated_at,
    recurrence_json,series_id,trigger_kind,conversation_id,reply_revision,next_follow_up_minutes
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    schedule.scheduleId,schedule.ownerAIId,schedule.remindAt,schedule.summary,schedule.details,
    schedule.systemCalendar ? 1 : 0,schedule.sourceConversationId,
    schedule.sourceMessageIds ? JSON.stringify(schedule.sourceMessageIds) : null,schedule.sourceExcerpt,
    schedule.status,schedule.claimedByRunId,schedule.claimedAt,schedule.consumedAt,
    schedule.completionDisposition,schedule.cancelledAt,schedule.cancelledReason,schedule.createdAt,schedule.updatedAt,
    schedule.recurrence ? JSON.stringify(schedule.recurrence) : null,schedule.seriesId,schedule.triggerKind,
    schedule.conversationId,schedule.replyRevision,schedule.nextFollowUpMinutes,
  ]);
}

export async function advanceRecurrence(tx: DatabaseTransactionExecutor, schedule: AISchedule, at: string): Promise<void> {
  if (!schedule.recurrence) return;
  const next = nextAIScheduleTime(schedule.recurrence, new Date(Math.max(Date.parse(at), Date.parse(schedule.remindAt))).toISOString());
  if (!next) return;
  const seriesId = schedule.seriesId!;
  await insertSchedule(tx, createAISchedule({ ...schedule,
    scheduleId: `${seriesId}@${next}@${at}`, remindAt: next, status: 'scheduled',
    claimedByRunId: null, claimedAt: null, consumedAt: null, completionDisposition: null,
    cancelledAt: null, cancelledReason: null, conversationId: null, replyRevision: null,
    nextFollowUpMinutes: null, createdAt: at, updatedAt: at,
  }));
}

export async function cancelPendingFollowUp(tx: DatabaseTransactionExecutor, conversationId: string, at: string, exceptId = ''): Promise<void> {
  await tx.runAsync(`UPDATE raven_cat_ai_schedules SET status='cancelled', cancelled_at=?,
    cancelled_reason='merged_chat', updated_at=? WHERE conversation_id=? AND trigger_kind='unanswered' AND status='scheduled' AND schedule_id<>?`,
  [at,at,conversationId,exceptId]);
}

/** 真实用户输入的 T1 或显式停止续轮在各自事务中结束等待，不伪造聊天消息。 */
export async function acknowledgeScheduleReplyInTransaction(
  tx: DatabaseTransactionExecutor, conversationId: string, at: string,
): Promise<void> {
  await tx.runAsync(`INSERT INTO raven_cat_ai_schedule_wait(conversation_id,revision) VALUES (?,1)
    ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1, active_run_id=NULL`, [conversationId]);
  await tx.runAsync('DELETE FROM raven_cat_ai_schedule_unanswered WHERE conversation_id=?', [conversationId]);
  await cancelPendingFollowUp(tx, conversationId, at);
}

export async function claimScheduleWait(tx: DatabaseTransactionExecutor, schedule: AISchedule, runId: string, conversationId: string, at: string): Promise<number | null> {
  await tx.runAsync('INSERT OR IGNORE INTO raven_cat_ai_schedule_wait(conversation_id) VALUES (?)', [conversationId]);
  const state = (await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM raven_cat_ai_schedule_wait WHERE conversation_id=?', [conversationId]))!;
  if (schedule.triggerKind === 'unanswered') {
    const settings = await tx.getFirstAsync<{ follow_up_enabled: number }>('SELECT follow_up_enabled FROM raven_cat_contact_settings WHERE id=\'default\'');
    const waiting = await tx.getFirstAsync('SELECT schedule_id FROM raven_cat_ai_schedule_unanswered WHERE conversation_id=? LIMIT 1', [conversationId]);
    if (!settings!.follow_up_enabled || !waiting || schedule.replyRevision !== state.revision) return null;
  }
  await cancelPendingFollowUp(tx, conversationId, at, schedule.scheduleId);
  await tx.runAsync('UPDATE raven_cat_ai_schedule_wait SET active_run_id=? WHERE conversation_id=?', [runId, conversationId]);
  return state.revision;
}

export async function finishScheduleWait(tx: DatabaseTransactionExecutor, schedule: AISchedule, at: string, firstVisibleAt: string | null): Promise<void> {
  if (!schedule.conversationId) return;
  const state = await tx.getFirstAsync<{ revision: number; active_run_id: string | null }>(
    'SELECT revision,active_run_id FROM raven_cat_ai_schedule_wait WHERE conversation_id=?', [schedule.conversationId]);
  if (!state || state.revision !== schedule.replyRevision || state.active_run_id !== schedule.claimedByRunId) return;
  await tx.runAsync('UPDATE raven_cat_ai_schedule_wait SET active_run_id=NULL WHERE conversation_id=?', [schedule.conversationId]);
  const settings = (await tx.getFirstAsync<{ follow_up_enabled: number; follow_up_interval_minutes: number }>(
    'SELECT follow_up_enabled,follow_up_interval_minutes FROM raven_cat_contact_settings WHERE id=\'default\''))!;
  if (!settings.follow_up_enabled) return;
  if (firstVisibleAt && schedule.triggerKind === 'scheduled') {
    await rememberUnansweredMessages(tx, schedule, firstVisibleAt);
  }
  const waiting = await tx.getFirstAsync('SELECT schedule_id FROM raven_cat_ai_schedule_unanswered WHERE conversation_id=? LIMIT 1', [schedule.conversationId]);
  if (!waiting) return;
  const interval = schedule.nextFollowUpMinutes ?? settings.follow_up_interval_minutes;
  await insertSchedule(tx, createAISchedule({ ...schedule, scheduleId: `unanswered:${schedule.claimedByRunId}`,
    remindAt: new Date(Date.parse(at) + interval * 60_000).toISOString(),
    triggerKind: 'unanswered', systemCalendar: false,
    recurrence: null, seriesId: null, status: 'scheduled', claimedByRunId: null, claimedAt: null,
    consumedAt: null, completionDisposition: null, cancelledAt: null, cancelledReason: null,
    nextFollowUpMinutes: null, createdAt: at, updatedAt: at,
  }));
}

/** 新日程接替旧执行时只交接已发消息，不延续旧执行权或重跑动作。 */
export async function rememberUnansweredMessages(tx: DatabaseTransactionExecutor, schedule: AISchedule, firstVisibleAt: string): Promise<void> {
  await tx.runAsync(`INSERT OR IGNORE INTO raven_cat_ai_schedule_unanswered(schedule_id,conversation_id,first_visible_at)
    VALUES (?,?,?)`, [schedule.scheduleId,schedule.conversationId,firstVisibleAt]);
  await tx.runAsync(`INSERT OR IGNORE INTO raven_cat_ai_schedule_unanswered(schedule_id,conversation_id,first_visible_at)
    SELECT c.schedule_id,?,? FROM raven_cat_ai_schedule_context c JOIN raven_cat_ai_schedules s ON s.schedule_id=c.schedule_id
    WHERE c.target_schedule_id=? AND c.reason='merged_schedule' AND s.trigger_kind='scheduled'`,
  [schedule.conversationId,firstVisibleAt,schedule.scheduleId]);
}
