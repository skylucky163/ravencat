/** 使用 SQLite 保存 AI Schedule 真值，并原子提交 update/cancel/claim/consume。 */

import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import {
  createAISchedule,
  createAIScheduleFromRow,
  AI_SCHEDULE_CANCELLED_REASON_OWNER_REVOKED,
  AI_SCHEDULE_START_GRACE_MS,
  type AISchedule,
  type AIScheduleCompletionDisposition,
  type AIScheduleRow,
} from '../domain/AISchedule';
import type {
  AIScheduleCommandErrorCode,
  AIScheduleCommandOutcome,
  AIScheduleListItem,
  AIScheduleListPage,
  AIScheduleRepository,
  ListAISchedulesInput,
  UpdateAIScheduleInput,
  RemoveAIScheduleCalendarInput,
  RemoveAIScheduleCalendarOutcome,
} from '../domain/AIScheduleRepository';
import { COMPANION_STATE_ID, type CompanionStateRow } from '../domain/CompanionState';
import type { AIScheduleContextItem, AIScheduleDispatchInput } from '../domain/AIScheduleContext';
import { insertSchedule, advanceRecurrence, claimScheduleWait, finishScheduleWait, rememberUnansweredMessages,
  acknowledgeScheduleReplyInTransaction } from './AIScheduleTimingPersistence';
export { acknowledgeScheduleReplyInTransaction } from './AIScheduleTimingPersistence';

export class SQLiteAIScheduleRepository implements AIScheduleRepository {
  async removeCalendarLinks(input: RemoveAIScheduleCalendarInput): Promise<RemoveAIScheduleCalendarOutcome> {
    return this.openExecutor('remove-calendar-links').withExclusiveTransactionAsync(async tx => {
      let selection = 'owner_ai_id=?';
      const params = [input.ownerAIId];
      if (input.scope !== 'all') {
        const schedule = await this.getByScheduleIdWithExecutor(tx, input.scheduleId!);
        if (!schedule) return { status: 'not_found' };
        if (schedule.ownerAIId !== input.ownerAIId) return { status: 'not_owner' };
        if (input.scope === 'series') {
          const seriesId = schedule.seriesId ?? schedule.scheduleId;
          selection += ' AND (series_id=? OR schedule_id=?)';
          params.push(seriesId, seriesId);
        } else {
          selection += ' AND schedule_id=?';
          params.push(schedule.scheduleId);
        }
      }
      // 已经关闭关联的记录也返回，供权限恢复后再次移除仍残留的系统事件。
      const rows = await tx.getAllAsync<{ schedule_id: string }>(
        `SELECT schedule_id FROM raven_cat_ai_schedules WHERE ${selection} ORDER BY schedule_id`, params);
      // 日历关联不改变执行内容或时间，保留 updated_at，避免使在途 Alarm/Worker 的版本失效。
      const result = await tx.runAsync(
        `UPDATE raven_cat_ai_schedules SET system_calendar=0 WHERE ${selection} AND system_calendar=1`, params);
      return { status: 'updated', scheduleIds: rows.map(row => row.schedule_id), updatedCount: result.changes };
    });
  }

  async listUnanswered(conversationId: string) {
    const rows = await this.openExecutor('unanswered').getAllAsync<{ schedule_id: string; summary: string; first_visible_at: string }>(
      `SELECT u.schedule_id,s.summary,u.first_visible_at FROM raven_cat_ai_schedule_unanswered u
        JOIN raven_cat_ai_schedules s ON s.schedule_id=u.schedule_id WHERE u.conversation_id=?
        ORDER BY u.first_visible_at,u.schedule_id`, [conversationId]);
    return rows.map(row => ({ scheduleId: row.schedule_id, summary: row.summary, firstVisibleAt: row.first_visible_at }));
  }

  async setNextFollowUpInterval(input: { scheduleId: string; ownerAIId: string; runId: string; minutes: number }): Promise<AIScheduleCommandOutcome<'updated'>> {
    return this.openExecutor('follow-up-interval').withExclusiveTransactionAsync(async tx => {
      const authority = await this.validateCompanionAuthority(tx, input.ownerAIId);
      if (authority) return { status: authority };
      const schedule = await this.getByScheduleIdWithExecutor(tx, input.scheduleId);
      if (!schedule) return { status: 'not_found' };
      if (schedule.ownerAIId !== input.ownerAIId) return { status: 'not_owner' };
      if (schedule.status !== 'claimed') return { status: 'not_claimed' };
      if (schedule.claimedByRunId !== input.runId) return { status: 'run_mismatch' };
      await tx.runAsync('UPDATE raven_cat_ai_schedules SET next_follow_up_minutes=? WHERE schedule_id=?', [input.minutes, input.scheduleId]);
      return { status: 'updated', schedule: { ...schedule, nextFollowUpMinutes: input.minutes } };
    });
  }
  async prepareDispatch(input: AIScheduleDispatchInput): Promise<AISchedule | null> {
    return this.openExecutor('prepare-dispatch').withExclusiveTransactionAsync(async tx => {
      if (await this.validateCompanionAuthority(tx, input.ownerAIId)) return null;
      const origin = await this.getByScheduleIdWithExecutor(tx, input.scheduleId);
      if (!origin || origin.ownerAIId !== input.ownerAIId || origin.status !== 'scheduled'
        || origin.remindAt !== input.expectedRemindAt || origin.updatedAt !== input.projectionToken
        || Date.parse(origin.remindAt) > Date.parse(input.occurredAt)) return null;
      await this.expireInTransaction(tx, input.occurredAt, input.ownerAIId);
      if (Date.parse(input.occurredAt) - Date.parse(origin.remindAt) > AI_SCHEDULE_START_GRACE_MS) return null;
      const due = await tx.getAllAsync<AIScheduleRow>(`SELECT * FROM raven_cat_ai_schedules
        WHERE owner_ai_id = ? AND status = 'scheduled' AND julianday(remind_at) <= julianday(?)
        ORDER BY (trigger_kind='scheduled') DESC, julianday(remind_at) DESC, updated_at DESC, schedule_id DESC`, [input.ownerAIId, input.occurredAt]);
      const latest = createAIScheduleFromRow(due[0])!;
      for (const old of due.slice(1)) await this.mergeInTransaction(tx, old.schedule_id, latest.scheduleId, input.occurredAt);
      return latest;
    });
  }

  async expireScheduled(occurredAt: string, ownerAIId?: string): Promise<void> {
    await this.openExecutor('expire').withExclusiveTransactionAsync(tx => this.expireInTransaction(tx, occurredAt, ownerAIId));
  }

  private async expireInTransaction(tx: DatabaseTransactionExecutor, occurredAt: string, ownerAIId?: string): Promise<number> {
    const cutoff = new Date(Date.parse(occurredAt) - AI_SCHEDULE_START_GRACE_MS).toISOString();
    const rows = await tx.getAllAsync<AIScheduleRow>(`SELECT * FROM raven_cat_ai_schedules
      WHERE status = 'scheduled' AND julianday(remind_at) < julianday(?) ${ownerAIId ? 'AND owner_ai_id = ?' : ''}`,
    ownerAIId ? [cutoff, ownerAIId] : [cutoff]);
    for (const row of rows) {
      await tx.runAsync(`UPDATE raven_cat_ai_schedules SET status='cancelled', cancelled_reason='expired',
        cancelled_at=?, updated_at=? WHERE schedule_id=? AND status='scheduled'`, [occurredAt, occurredAt, row.schedule_id]);
      await this.writeContext(tx, row.schedule_id, 'expired', null, occurredAt);
      await this.retargetContext(tx, row.schedule_id, null);
      await advanceRecurrence(tx, createAIScheduleFromRow(row)!, occurredAt);
    }
    return rows.length;
  }

  async mergeDueIntoChat(ownerAIId: string, occurredAt: string): Promise<boolean> {
    return this.openExecutor('merge-chat').withExclusiveTransactionAsync(async tx => {
      const expired = await this.expireInTransaction(tx, occurredAt, ownerAIId);
      const due = await tx.getAllAsync<{ schedule_id: string }>(`SELECT schedule_id FROM raven_cat_ai_schedules
        WHERE owner_ai_id=? AND status='scheduled' AND julianday(remind_at)<=julianday(?)`, [ownerAIId, occurredAt]);
      for (const row of due) await this.mergeInTransaction(tx, row.schedule_id, null, occurredAt);
      return expired > 0 || due.length > 0;
    });
  }

  async mergeScheduled(scheduleId: string, targetScheduleId: string | null, occurredAt: string, failureCode?: string): Promise<void> {
    if (scheduleId === targetScheduleId) return;
    await this.openExecutor('merge-schedule').withExclusiveTransactionAsync(tx =>
      this.mergeInTransaction(tx, scheduleId, targetScheduleId, occurredAt, failureCode));
  }

  private async mergeInTransaction(tx: DatabaseTransactionExecutor, scheduleId: string, target: string | null, at: string, failureCode?: string): Promise<void> {
    const result = await tx.runAsync(`UPDATE raven_cat_ai_schedules SET status='cancelled', cancelled_at=?,
      cancelled_reason=?, updated_at=? WHERE schedule_id=? AND status='scheduled'`,
    [at, target === null ? 'merged_chat' : 'merged_schedule', at, scheduleId]);
    if (!result.changes) return;
    await advanceRecurrence(tx, (await this.getByScheduleIdWithExecutor(tx, scheduleId))!, at);
    await this.writeContext(tx, scheduleId, failureCode ?? (target === null ? 'merged_chat' : 'merged_schedule'), target, at);
    await this.retargetContext(tx, scheduleId, target);
  }

  /** 调用方已撤销对应 Chat owner；这里只收口该 run 的日程，不重放已发生的动作。 */
  async mergeClaimedRun(runId: string, target: string | null, at: string, firstVisibleAt?: string | null): Promise<void> {
    await this.openExecutor('merge-claimed').withExclusiveTransactionAsync(async tx => {
      const rows = await tx.getAllAsync<AIScheduleRow>(`SELECT * FROM raven_cat_ai_schedules
        WHERE claimed_by_run_id=? AND status IN ('claimed','consumed')`, [runId]);
      for (const row of rows) {
        if (firstVisibleAt && row.trigger_kind === 'scheduled' && row.conversation_id) {
          const wait = await tx.getFirstAsync<{ revision: number; follow_up_enabled: number }>(
            `SELECT w.revision,c.follow_up_enabled FROM raven_cat_ai_schedule_wait w
              JOIN raven_cat_contact_settings c ON c.id='default' WHERE w.conversation_id=?`, [row.conversation_id]);
          if (wait?.follow_up_enabled && wait.revision === row.reply_revision) {
            await rememberUnansweredMessages(tx, createAIScheduleFromRow(row)!, firstVisibleAt);
          }
        }
        await tx.runAsync(`UPDATE raven_cat_ai_schedules SET status='consumed', consumed_at=?,
          completion_disposition='interrupted', updated_at=? WHERE schedule_id=? AND status='claimed'`, [at, at, row.schedule_id]);
        await this.writeContext(tx, row.schedule_id, target === null ? 'merged_chat' : 'merged_schedule', target, at);
        await this.retargetContext(tx, row.schedule_id, target);
      }
    });
  }

  private async writeContext(tx: DatabaseTransactionExecutor, id: string, reason: string, target: string | null, at: string): Promise<void> {
    await tx.runAsync(`INSERT INTO raven_cat_ai_schedule_context(schedule_id,reason,target_schedule_id,occurred_at)
      VALUES (?,?,?,?) ON CONFLICT(schedule_id) DO UPDATE SET reason=excluded.reason,
      target_schedule_id=excluded.target_schedule_id, occurred_at=excluded.occurred_at,
      presented_run_id=NULL, acknowledged_at=NULL`, [id, reason, target, at]);
  }

  private async retargetContext(tx: DatabaseTransactionExecutor, old: string, target: string | null): Promise<void> {
    await tx.runAsync(`UPDATE raven_cat_ai_schedule_context SET target_schedule_id=?
      WHERE target_schedule_id=? AND acknowledged_at IS NULL`, [target, old]);
  }

  async listPendingContext(ownerAIId: string, targetScheduleId: string | null): Promise<AIScheduleContextItem[]> {
    const rows = await this.openExecutor('context').getAllAsync<{ schedule_id: string; remind_at: string; summary: string;
      details: string; source_excerpt: string | null; reason: string; target_schedule_id: string | null; presented_run_id: string | null }>(
      `SELECT s.schedule_id,s.remind_at,s.summary,s.details,s.source_excerpt,c.reason,c.target_schedule_id,c.presented_run_id
       FROM raven_cat_ai_schedule_context c JOIN raven_cat_ai_schedules s ON s.schedule_id=c.schedule_id
       WHERE s.owner_ai_id=? AND c.target_schedule_id IS ? AND c.acknowledged_at IS NULL
       ORDER BY c.occurred_at,s.schedule_id`, [ownerAIId, targetScheduleId]);
    return rows.map(row => ({ scheduleId: row.schedule_id, remindAt: row.remind_at, summary: row.summary,
      details: row.details, sourceExcerpt: row.source_excerpt, reason: row.reason,
      targetScheduleId: row.target_schedule_id, presentedRunId: row.presented_run_id }));
  }

  async bindContext(input: { runId: string; occurredAt: string; acknowledge: AIScheduleContextItem[];
    present: AIScheduleContextItem[] }): Promise<AIScheduleContextItem[]> {
    return this.openExecutor('bind-context').withExclusiveTransactionAsync(async tx => {
      for (const item of input.acknowledge) await tx.runAsync(`UPDATE raven_cat_ai_schedule_context SET acknowledged_at=?
        WHERE schedule_id=? AND acknowledged_at IS NULL AND presented_run_id IS ? AND target_schedule_id IS ? AND reason=?`,
      [input.occurredAt, item.scheduleId, item.presentedRunId, item.targetScheduleId, item.reason]);
      const bound: AIScheduleContextItem[] = [];
      for (const item of input.present) {
        const result = await tx.runAsync(`UPDATE raven_cat_ai_schedule_context SET presented_run_id=?
          WHERE schedule_id=? AND acknowledged_at IS NULL AND presented_run_id IS ? AND target_schedule_id IS ? AND reason=?`,
        [input.runId, item.scheduleId, item.presentedRunId, item.targetScheduleId, item.reason]);
        if (result.changes) bound.push(item);
      }
      return bound;
    });
  }
  async createScheduled(
    data: AISchedule,
    occurredAt: string,
  ): Promise<AIScheduleCommandOutcome<'created'>> {
    const schedule = createAISchedule(data);
    if (schedule.status !== 'scheduled') {
      throw new Error('createScheduled 只接受 scheduled AI Schedule');
    }
    if (Date.parse(schedule.remindAt) <= Date.parse(occurredAt)) {
      return { status: 'invalid_time' };
    }
    return this.openExecutor('create').withExclusiveTransactionAsync(async (tx) => {
      const authority = await this.validateCompanionAuthority(tx, schedule.ownerAIId);
      if (authority) return { status: authority };
      await insertSchedule(tx, schedule);
      return { status: 'created', schedule };
    });
  }

  async getByScheduleId(scheduleId: string): Promise<AISchedule | null> {
    return this.getByScheduleIdWithExecutor(this.openExecutor('get'), scheduleId);
  }

  async list(input: ListAISchedulesInput): Promise<AIScheduleListPage> {
    const conditions = [
      'owner_ai_id = ?',
      'remind_at >= ?',
      'remind_at < ?',
    ];
    const params: (string | number)[] = [input.ownerAIId, input.from, input.to];
    if (input.status) {
      conditions.push('status = ?');
      params.push(input.status);
    }
    if (input.after) {
      conditions.push('(remind_at > ? OR (remind_at = ? AND schedule_id > ?))');
      params.push(input.after.remindAt, input.after.remindAt, input.after.scheduleId);
    }
    params.push(input.limit + 1);
    const rows = await this.openExecutor('list').getAllAsync<AIScheduleRow>(
      `SELECT * FROM raven_cat_ai_schedules
       WHERE ${conditions.join(' AND ')}
       ORDER BY remind_at ASC, schedule_id ASC
       LIMIT ?`,
      params,
    );
    const hasMore = rows.length > input.limit;
    const schedules = (hasMore ? rows.slice(0, input.limit) : rows)
      .map((row) => createAIScheduleFromRow(row)!);
    const items: AIScheduleListItem[] = schedules.map((schedule) => ({
      scheduleId: schedule.scheduleId,
      remindAt: schedule.remindAt,
      summary: schedule.summary,
      status: schedule.status,
    }));
    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && last
        ? { remindAt: last.remindAt, scheduleId: last.scheduleId }
        : null,
    };
  }

  async updateScheduled(
    input: UpdateAIScheduleInput,
  ): Promise<AIScheduleCommandOutcome<'updated'>> {
    return this.openExecutor('update').withExclusiveTransactionAsync(async (tx) => {
      const authority = await this.validateCompanionAuthority(tx, input.ownerAIId);
      if (authority) return { status: authority };
      const current = await this.getByScheduleIdWithExecutor(tx, input.scheduleId);
      const invalid = classifyMutableSchedule(current, input.ownerAIId, input.occurredAt);
      if (invalid) return { status: invalid };
      if (input.remindAt && Date.parse(input.remindAt) <= Date.parse(input.occurredAt)) {
        return { status: 'invalid_time' };
      }

      const next = createAISchedule({
        ...current!,
        remindAt: input.remindAt ?? current!.remindAt,
        summary: input.summary ?? current!.summary,
        details: input.details ?? current!.details,
        systemCalendar: input.systemCalendar ?? current!.systemCalendar,
        recurrence: input.recurrence === undefined ? current!.recurrence : input.recurrence,
        seriesId: input.recurrence === null ? null : (current!.seriesId ?? (input.recurrence ? current!.scheduleId : null)),
        updatedAt: input.occurredAt,
      });
      const result = await tx.runAsync(
        `UPDATE raven_cat_ai_schedules
         SET remind_at = ?, summary = ?, details = ?, updated_at = ?, system_calendar = ?, recurrence_json = ?, series_id = ?
         WHERE schedule_id = ? AND owner_ai_id = ?
           AND status = 'scheduled' AND remind_at > ?`,
        [
          next.remindAt,
          next.summary,
          next.details,
          next.updatedAt,
          next.systemCalendar ? 1 : 0,
          next.recurrence ? JSON.stringify(next.recurrence) : null,
          next.seriesId,
          input.scheduleId,
          input.ownerAIId,
          input.occurredAt,
        ],
      );
      if (result.changes !== 1) {
        throw new Error('AI Schedule update 原子条件在 exclusive transaction 内失效');
      }
      return { status: 'updated', schedule: next };
    });
  }

  async cancelScheduled(input: {
    scheduleId: string;
    ownerAIId: string;
    occurredAt: string;
  }): Promise<AIScheduleCommandOutcome<'cancelled'>> {
    return this.openExecutor('cancel').withExclusiveTransactionAsync(async (tx) => {
      const current = await this.getByScheduleIdWithExecutor(tx, input.scheduleId);
      const invalid = classifyMutableSchedule(current, input.ownerAIId, input.occurredAt);
      if (invalid) return { status: invalid };
      const result = await tx.runAsync(
        `UPDATE raven_cat_ai_schedules
         SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE schedule_id = ? AND owner_ai_id = ?
           AND status = 'scheduled' AND remind_at > ?`,
        [input.occurredAt, input.occurredAt, input.scheduleId, input.ownerAIId, input.occurredAt],
      );
      if (result.changes !== 1) {
        throw new Error('AI Schedule cancel 原子条件在 exclusive transaction 内失效');
      }
      if (current!.triggerKind === 'unanswered') {
        await acknowledgeScheduleReplyInTransaction(tx, current!.conversationId!, input.occurredAt);
      }
      return {
        status: 'cancelled',
        schedule: createAISchedule({
          ...current!,
          status: 'cancelled',
          cancelledAt: input.occurredAt,
          updatedAt: input.occurredAt,
        }),
      };
    });
  }

  async claimScheduled(input: {
    scheduleId: string;
    ownerAIId: string;
    runId: string;
    claimedAt: string;
    expectedRemindAt: string;
    projectionToken: string;
    conversationId: string;
  }): Promise<AIScheduleCommandOutcome<'claimed'>> {
    return this.openExecutor('claim').withExclusiveTransactionAsync(async (tx) => {
      const authority = await this.validateCompanionAuthority(tx, input.ownerAIId);
      if (authority) return { status: authority };
      const current = await this.getByScheduleIdWithExecutor(tx, input.scheduleId);
      if (!current) return { status: 'not_found' };
      if (current.ownerAIId !== input.ownerAIId) return { status: 'not_owner' };
      if (current.status === 'claimed') return { status: 'already_claimed' };
      if (current.status !== 'scheduled') return { status: 'not_scheduled' };
      if (current.remindAt !== input.expectedRemindAt) return { status: 'stale_projection' };
      if (current.updatedAt !== input.projectionToken) return { status: 'stale_projection' };
      if (Date.parse(current.remindAt) > Date.parse(input.claimedAt)) return { status: 'not_due' };
      await this.expireInTransaction(tx, input.claimedAt, input.ownerAIId);
      if (Date.parse(input.claimedAt) - Date.parse(current.remindAt) > AI_SCHEDULE_START_GRACE_MS) return { status: 'already_past' };
      const revision = await claimScheduleWait(tx, current, input.runId, input.conversationId, input.claimedAt);
      if (revision === null) return { status: 'stale_projection' };

      // due-time CAS 作为最终并发边界：只允许 scheduled → claimed 且版本完全匹配。
      const result = await tx.runAsync(
        `UPDATE raven_cat_ai_schedules
         SET status = 'claimed', claimed_by_run_id = ?, claimed_at = ?, updated_at = ?, conversation_id = ?, reply_revision = ?
         WHERE schedule_id = ? AND owner_ai_id = ? AND status = 'scheduled'
           AND remind_at = ? AND updated_at = ? AND remind_at <= ?`,
        [
          input.runId,
          input.claimedAt,
          input.claimedAt,
          input.conversationId,
          revision,
          input.scheduleId,
          input.ownerAIId,
          input.expectedRemindAt,
          input.projectionToken,
          input.claimedAt,
        ],
      );
      if (result.changes !== 1) return { status: 'already_claimed' };
      await advanceRecurrence(tx, current, input.claimedAt);
      return {
        status: 'claimed',
        schedule: (await this.getByScheduleIdWithExecutor(tx, input.scheduleId))!,
      };
    });
  }

  async consumeClaimed(input: {
    scheduleId: string;
    runId: string;
    consumedAt: string;
    completionDisposition: AIScheduleCompletionDisposition;
    failureCode?: string;
    firstVisibleAt?: string | null;
  }): Promise<AIScheduleCommandOutcome<'consumed'>> {
    return this.openExecutor('consume').withExclusiveTransactionAsync(async (tx) => {
      const current = await this.getByScheduleIdWithExecutor(tx, input.scheduleId);
      if (!current) return { status: 'not_found' };
      if (current.status === 'consumed') {
        return {
          status: current.claimedByRunId === input.runId
            ? 'already_terminal'
            : 'run_mismatch',
        };
      }
      if (current.status !== 'claimed') return { status: 'not_claimed' };
      if (current.claimedByRunId !== input.runId) return { status: 'run_mismatch' };
      const result = await tx.runAsync(
        `UPDATE raven_cat_ai_schedules
         SET status = 'consumed', consumed_at = ?, completion_disposition = ?, updated_at = ?
         WHERE schedule_id = ? AND status = 'claimed' AND claimed_by_run_id = ?`,
        [
          input.consumedAt,
          input.completionDisposition,
          input.consumedAt,
          input.scheduleId,
          input.runId,
        ],
      );
      if (result.changes !== 1) {
        throw new Error('AI Schedule consume 原子条件在 exclusive transaction 内失效');
      }
      if (input.completionDisposition === 'agent_terminal') {
        await finishScheduleWait(tx, current, input.consumedAt, input.firstVisibleAt ?? null);
      } else if (current.conversationId) {
        await tx.runAsync(`UPDATE raven_cat_ai_schedule_wait SET active_run_id=NULL
          WHERE conversation_id=? AND active_run_id=?`, [current.conversationId,input.runId]);
      }
      const failure = input.failureCode ?? (input.completionDisposition === 'interrupted' ? 'interrupted' : null);
      if (failure) {
        await tx.runAsync(`INSERT INTO raven_cat_ai_schedule_context(schedule_id,reason,occurred_at)
          VALUES (?,?,?) ON CONFLICT(schedule_id) DO NOTHING`, [input.scheduleId, failure, input.consumedAt]);
        // 最新安排未完成时，继承的旧背景也交给正常聊天，不能挂在已失败的目标上。
        await this.retargetContext(tx, input.scheduleId, null);
      }
      return {
        status: 'consumed',
        schedule: (await this.getByScheduleIdWithExecutor(tx, input.scheduleId))!,
      };
    });
  }

  async listAllScheduled(): Promise<AISchedule[]> {
    const rows = await this.openExecutor('listAllScheduled').getAllAsync<AIScheduleRow>(
      `SELECT * FROM raven_cat_ai_schedules WHERE status = 'scheduled' ORDER BY remind_at ASC, schedule_id ASC`,
    );
    return rows.map((row) => createAIScheduleFromRow(row)!);
  }

  async listAllClaimed(): Promise<AISchedule[]> {
    const rows = await this.openExecutor('listAllClaimed').getAllAsync<AIScheduleRow>(
      `SELECT * FROM raven_cat_ai_schedules
       WHERE status = 'claimed'
       ORDER BY schedule_id ASC`,
    );
    return rows.map((row) => createAIScheduleFromRow(row)!);
  }

  async terminalizeScheduledForOwnerInvalidation(input: {
    scheduleId: string;
    occurredAt: string;
  }): Promise<AIScheduleCommandOutcome<'cancelled'>> {
    return this.openExecutor('terminalize').withExclusiveTransactionAsync(async (tx) => {
      const current = await this.getByScheduleIdWithExecutor(tx, input.scheduleId);
      if (!current) return { status: 'not_found' };
      if (current.status !== 'scheduled') return { status: 'not_scheduled' };
      const result = await tx.runAsync(
        `UPDATE raven_cat_ai_schedules
         SET status = 'cancelled', cancelled_at = ?, cancelled_reason = ?, updated_at = ?
         WHERE schedule_id = ? AND status = 'scheduled'`,
        [
          input.occurredAt,
          AI_SCHEDULE_CANCELLED_REASON_OWNER_REVOKED,
          input.occurredAt,
          input.scheduleId,
        ],
      );
      if (result.changes !== 1) {
        throw new Error('AI Schedule owner invalidation 原子条件在 exclusive transaction 内失效');
      }
      return {
        status: 'cancelled',
        schedule: (await this.getByScheduleIdWithExecutor(tx, input.scheduleId))!,
      };
    });
  }

  /** 开关与 claim/create/update 共用数据库快照，关闭后的迟到回调不能取得执行权。 */
  private async validateCompanionAuthority(
    tx: DatabaseTransactionExecutor, ownerAIId: string,
  ): Promise<'companion_disabled' | 'not_owner' | null> {
    const state = await tx.getFirstAsync<CompanionStateRow>(
      'SELECT * FROM raven_cat_companion_state WHERE id = ?', [COMPANION_STATE_ID],
    );
    if (!state || state.desired_enabled === 0) return 'companion_disabled';
    return state.host_ai_id === ownerAIId ? null : 'not_owner';
  }

  private openExecutor(operation: string) {
    return databaseCoordinator.openTaskExecutor({
      name: `companion.aiSchedule.${operation}`,
      feature: 'companion',
      priority: 'runtime',
    });
  }

  private async getByScheduleIdWithExecutor(
    db: Pick<DatabaseTransactionExecutor, 'getFirstAsync'>,
    scheduleId: string,
  ): Promise<AISchedule | null> {
    const row = await db.getFirstAsync<AIScheduleRow>(
      'SELECT * FROM raven_cat_ai_schedules WHERE schedule_id = ? LIMIT 1',
      [scheduleId],
    );
    return createAIScheduleFromRow(row);
  }
}

function classifyMutableSchedule(
  schedule: AISchedule | null,
  ownerAIId: string,
  occurredAt: string,
): AIScheduleCommandErrorCode | null {
  if (!schedule) return 'not_found';
  if (schedule.ownerAIId !== ownerAIId) return 'not_owner';
  if (schedule.status !== 'scheduled') return 'not_scheduled';
  if (Date.parse(schedule.remindAt) <= Date.parse(occurredAt)) return 'already_past';
  return null;
}

export const aiScheduleRepository = new SQLiteAIScheduleRepository();
