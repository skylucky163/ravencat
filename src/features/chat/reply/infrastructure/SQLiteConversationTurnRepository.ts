/**
 * @fileoverview ConversationTurnCoordinator 的 SQLite 回合仓储实现。
 *
 * 四类状态转换事务（方案 13 / 16 节）：
 * - T1：ensureTurnStateRowInTransaction + supersedeActiveRunInTransaction
 * - T2：claimIfIdle（CAS 含 active_run_id IS NULL）/ takeOverOrphan（事务内 supersede 孤儿）
 * - T3：commitTurn（fence + 全量 items + preview + run 终态 + 游标 + revision 单事务）
 * - commitOutput：同一 fence 提交媒体与可见版本，不推进游标或终结 run
 * - T4：revoke（cancel / fail）
 *
 * 所有关键条件 UPDATE 检查影响行数；0 行即整事务回滚并报 invariant violation，
 * 由 databaseCoordinator 包装时保留原始 cause 与任务元数据，不自动重试。
 */

import {
  databaseCoordinator,
  type DatabaseTransactionExecutor,
  type DatabaseReadExecutor,
} from '@platform/persistence';
import { cancelRegenerationInTransaction } from '../../messages/infrastructure/ChatMessageMutationSql';
import { completeTurnPresentationInTransaction, interruptTurnPresentationsInTransaction, replaceRegeneratedReplyInTransaction } from './ChatTurnPresentationSql';
import { messageRepository } from '../../messages/infrastructure/SQLiteMessageRepository';
import {
  ConversationTurnInvariantError,
  type ConversationTurnKind,
  type ConversationTurnRun,
  type ConversationTurnRunStatus,
  type ConversationTurnTerminalStatus,
  type ConversationTurnCommitItem,
  type ConversationToolPackageCommit,
  type ConversationTurnCommitResult,
  type ConversationTurnUnrepliedSession,
  type ChatRegenerationState,
  type ConversationHostStartAttempt,
} from '../domain/ConversationTurn';
import { buildSessionPreviewTextFromMessage } from '../../messages/domain';
import type { IConversationTurnRepository } from '../domain/ConversationTurnRepository';
import type { ChatReplyVersionHistory } from '../domain/ChatReplyVersion';
import { decodeReplyVersion, findReplyVersionSet, saveReplyVersion } from './ChatReplyVersionSql';
import type { ChatMessage } from '../../messages/domain/ChatMessage';

interface TurnRunRow {
  run_id: string;
  session_id: string;
  kind: string;
  reply_cursor_at_claim: number;
  input_high_watermark: number;
  revision_at_claim: number;
  status: ConversationTurnRunStatus;
  terminal_reason: string | null;
  created_at: string;
  terminal_at: string | null;
  regeneration_source_run_id: string | null;
  input_cursor_at_claim: number | null;
}

interface TurnStateRow {
  reply_requested: number;
  summon_requested: number;
  reply_cursor: number;
  revision: number;
  active_run_id: string | null;
}

function createTurnRunId(): string {
  return `turn_run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function mapRowToRun(row: TurnRunRow): ConversationTurnRun {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    kind: row.kind as ConversationTurnKind,
    replyCursorAtClaim: row.reply_cursor_at_claim,
    inputHighWatermark: row.input_high_watermark,
    revisionAtClaim: row.revision_at_claim,
    status: row.status,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    terminalAt: row.terminal_at,
    regenerationSourceRunId: row.regeneration_source_run_id,
    inputCursorAtClaim: row.input_cursor_at_claim,
  };
}

export class ConversationTurnRepository implements IConversationTurnRepository {
  async setReplyRequestedInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string, requested: boolean): Promise<void> {
    await transaction.runAsync('UPDATE conversation_turn_state SET reply_requested = ?, summon_requested = 0 WHERE session_id = ?', [requested ? 1 : 0, sessionId]);
  }

  requestUserReply(sessionId: string): Promise<boolean> {
    return databaseCoordinator.transaction({ name: 'chat.request-user-reply', feature: 'chat', priority: 'interactive' }, async tx => {
      if (!await isAssistantConversationAvailable(tx, sessionId)) return false;
      await this.ensureTurnStateRowInTransaction(tx, sessionId);
      const changed = await tx.runAsync(`UPDATE conversation_turn_state SET reply_requested = 1, summon_requested = 1,
        revision = revision + 1, host_request_status = NULL, updated_at = ? WHERE session_id = ? AND active_run_id IS NULL
        AND (summon_requested = 0 OR host_request_status = 'rejected')`,
      [new Date().toISOString(), sessionId]);
      return changed.changes === 1;
    });
  }
  /** 回收同时取消在途和尚未领取的输入，恢复不授权原生信箱重放旧请求。 */
  async suspendForAssistantRecycleInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string): Promise<void> {
    await this.cancelCurrentTurnInTransaction(transaction, sessionId, 'assistant_recycled');
  }

  cancelCurrentTurn(sessionId: string): Promise<void> {
    return databaseCoordinator.transaction(
      { name: 'chat.cancel-current-turn', feature: 'chat', priority: 'interactive' },
      transaction => this.cancelCurrentTurnInTransaction(transaction, sessionId, 'cancelled_by_user'),
    );
  }

  /** 在同一写事务撤销执行与宿主请求，迟到 claim／提交都只能观察取消终态。 */
  private async cancelCurrentTurnInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string, reason: string): Promise<void> {
    await this.ensureTurnStateRowInTransaction(transaction, sessionId);
    await interruptTurnPresentationsInTransaction(transaction, sessionId, reason);
    const now = new Date().toISOString();
    await transaction.runAsync(`UPDATE conversation_turn_runs SET status = 'cancelled', terminal_reason = ?, terminal_at = ?
      WHERE session_id = ? AND status = 'active'`, [reason, now, sessionId]);
    const state = (await transaction.getFirstAsync<TurnStateRow>(
      'SELECT reply_cursor, revision, active_run_id FROM conversation_turn_state WHERE session_id = ?', [sessionId]))!;
    const input = (await transaction.getFirstAsync<{ watermark: number }>(`SELECT COALESCE(MAX(id), 0) AS watermark FROM messages
      WHERE session_id = ? AND is_me = 1 AND json_extract(metadata_json, '$.type') IS NOT 'callStatus'`, [sessionId]))!;
    // 尚未 claim 的用户意图也取得持久取消终态，沿用现有“同一输入不得隐式重试”的契约。
    if (input.watermark > state.reply_cursor && !await transaction.getFirstAsync(`SELECT 1 FROM conversation_turn_runs
      WHERE session_id = ? AND kind IN ('user_reply', 'summon') AND status IN ('cancelled', 'failed') AND input_high_watermark >= ?`,
    [sessionId, input.watermark])) {
      await transaction.runAsync(`INSERT INTO conversation_turn_runs
        (run_id, session_id, kind, reply_cursor_at_claim, input_high_watermark, revision_at_claim, status, terminal_reason, created_at, terminal_at)
        VALUES (?, ?, 'user_reply', ?, ?, ?, 'cancelled', ?, ?, ?)`,
      [createTurnRunId(), sessionId, state.reply_cursor, input.watermark, state.revision + 1, reason, now, now]);
    }
    await transaction.runAsync(`UPDATE conversation_turn_state SET active_run_id = NULL, active_run_kind = NULL,
      revision = revision + 1, summon_requested = 0, host_request_revision = host_request_revision + 1, host_request_status = 'cancelled', updated_at = ?
      WHERE session_id = ?`, [now, sessionId]);
    await transaction.runAsync('DELETE FROM chat_regeneration_requests WHERE session_id = ?', [sessionId]);
  }

  interruptAbandonedAutonomousRuns(activeRunIds: readonly string[]): Promise<string[]> {
    return databaseCoordinator.transaction({ name: 'chat.interrupt-autonomous-orphans', feature: 'chat', priority: 'runtime' }, async tx => {
      const rows = await tx.getAllAsync<TurnRunRow>("SELECT * FROM conversation_turn_runs WHERE kind = 'autonomous' AND status = 'active'");
      const sessions: string[] = [];
      const now = new Date().toISOString();
      for (const row of rows) {
        if (activeRunIds.includes(row.run_id)) continue;
        const released = await tx.runAsync(`UPDATE conversation_turn_state SET active_run_id = NULL,
          active_run_kind = NULL, revision = revision + 1, updated_at = ?
          WHERE session_id = ? AND active_run_id = ? AND revision = ?`,
        [now, row.session_id, row.run_id, row.revision_at_claim]);
        if (released.changes !== 1) throw new ConversationTurnInvariantError('自主执行孤儿与会话 owner 不一致');
        await tx.runAsync(`UPDATE conversation_turn_runs SET status = 'failed', terminal_reason = 'process_restarted', terminal_at = ?
          WHERE run_id = ? AND status = 'active'`, [now, row.run_id]);
        sessions.push(row.session_id);
      }
      return sessions;
    });
  }

  getActiveRun(sessionId: string): Promise<ConversationTurnRun | null> {
    return databaseCoordinator.read({ name: 'chat.active-turn', feature: 'chat', priority: 'runtime' }, async db => {
      const row = await db.getFirstAsync<TurnRunRow>(`SELECT r.* FROM conversation_turn_runs r
        JOIN conversation_turn_state s ON s.active_run_id = r.run_id WHERE s.session_id = ?`, [sessionId]);
      return row ? mapRowToRun(row) : null;
    });
  }

  listRunStates(runIds: readonly string[]): Promise<{ runId: string; status: ConversationTurnRun['status'] }[]> {
    return databaseCoordinator.read({ name: 'chat.turn-states', feature: 'chat', priority: 'runtime' }, async db => {
      const rows = await db.getAllAsync<{ run_id: string; status: ConversationTurnRun['status'] }>(
        `SELECT run_id,status FROM conversation_turn_runs WHERE run_id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(runIds)]);
      return rows.map(row => ({ runId: row.run_id, status: row.status }));
    });
  }

  claimAutonomousIfIdle(sessionId: string, runId: string): Promise<ConversationTurnRun | null> {
    return databaseCoordinator.transaction(
      { name: 'chat.claim-autonomous-turn', feature: 'chat', priority: 'runtime' },
      async transaction => {
        if (!await isAssistantConversationAvailable(transaction, sessionId)) return null;
        await this.ensureTurnStateRowInTransaction(transaction, sessionId);
        const state = (await transaction.getFirstAsync<TurnStateRow>(
          'SELECT reply_cursor, revision, active_run_id FROM conversation_turn_state WHERE session_id = ?', [sessionId],
        ))!;
        if (state.active_run_id !== null) return null;
        // T3 已释放执行槽但气泡可能仍在交付；新用户输入也可能尚未被宿主 claim。
        const pending = await transaction.getFirstAsync(`SELECT 1 WHERE
          EXISTS (SELECT 1 FROM chat_turn_presentations WHERE session_id = ? AND state = 'open')
          OR EXISTS (SELECT 1 FROM chat_regeneration_requests WHERE session_id = ?)
          OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ? AND m.is_me = 1
            AND json_extract(m.metadata_json, '$.type') IS NOT 'callStatus' AND m.id > ?
            AND NOT EXISTS (SELECT 1 FROM conversation_turn_runs r WHERE r.session_id = m.session_id
              AND r.kind = 'user_reply' AND r.status IN ('failed', 'cancelled') AND r.input_high_watermark >= m.id))`,
        [sessionId, sessionId, sessionId, state.reply_cursor]);
        if (pending) return null;
        const now = new Date().toISOString();
        const revision = state.revision + 1;
        await transaction.runAsync(`INSERT INTO conversation_turn_runs
          (run_id, session_id, kind, reply_cursor_at_claim, input_high_watermark, revision_at_claim, status, created_at)
          VALUES (?, ?, 'autonomous', ?, ?, ?, 'active', ?)`,
        [runId, sessionId, state.reply_cursor, state.reply_cursor, revision, now]);
        const claimed = await transaction.runAsync(`UPDATE conversation_turn_state SET active_run_id = ?,
          active_run_kind = 'autonomous', revision = revision + 1, updated_at = ?
          WHERE session_id = ? AND active_run_id IS NULL AND revision = ?`, [runId, now, sessionId, state.revision]);
        if (claimed.changes !== 1) throw new ConversationTurnInvariantError('自主执行 claim 失去会话所有权');
        return { runId, sessionId, kind: 'autonomous', replyCursorAtClaim: state.reply_cursor,
          inputHighWatermark: state.reply_cursor, revisionAtClaim: revision, status: 'active',
          terminalReason: null, createdAt: now, terminalAt: null };
      },
    );
  }

  finishAutonomous(run: ConversationTurnRun): Promise<void> {
    return databaseCoordinator.transaction(
      { name: 'chat.finish-autonomous-turn', feature: 'chat', priority: 'runtime' },
      async transaction => {
        const now = new Date().toISOString();
        const released = await transaction.runAsync(`UPDATE conversation_turn_state SET active_run_id = NULL,
          active_run_kind = NULL, revision = revision + 1, updated_at = ?
          WHERE session_id = ? AND active_run_id = ? AND revision = ?`,
        [now, run.sessionId, run.runId, run.revisionAtClaim]);
        if (released.changes === 0) return;
        const completed = await transaction.runAsync(`UPDATE conversation_turn_runs SET status = 'committed', terminal_at = ?
          WHERE run_id = ? AND kind = 'autonomous' AND status = 'active'`, [now, run.runId]);
        if (completed.changes !== 1) throw new ConversationTurnInvariantError('自主执行释放时 run 不是 active');
      },
    );
  }

  getReplyVersionHistory(sessionId: string, runId: string): Promise<ChatReplyVersionHistory | null> {
    return databaseCoordinator.read({ name: 'chat.reply-versions', feature: 'chat', priority: 'interactive' }, async db => {
      const set = await findReplyVersionSet(db, runId);
      if (!set || set.session_id !== sessionId) return null;
      const rows = await db.getAllAsync<{ id: string; created_at: string; snapshot_json: string }>(
        'SELECT * FROM chat_reply_versions WHERE set_id = ? ORDER BY rowid', [set.id],
      );
      return {
        currentRunId: set.current_run_id, selectedVersionId: set.selected_version_id,
        canAdopt: (await this.eligibleRegenerationSource(db, sessionId))?.run_id === set.current_run_id,
        versions: rows.map(row => ({ id: row.id, createdAt: row.created_at, messages: decodeReplyVersion(row.snapshot_json) })),
      };
    });
  }

  adoptReplyVersion(sessionId: string, runId: string, versionId: string, expectedVersionId: string): Promise<void> {
    return databaseCoordinator.transaction({ name: 'chat.adopt-reply-version', feature: 'chat', priority: 'interactive' }, async tx => {
      const set = await findReplyVersionSet(tx, runId);
      const source = await this.eligibleRegenerationSource(tx, sessionId);
      if (!set || set.session_id !== sessionId || source?.run_id !== set.current_run_id) {
        throw new Error('只能切换尚未继续对话、且当前没有正在生成回复的最新一轮版本');
      }
      if (set.selected_version_id !== expectedVersionId) throw new Error('当前版本已变化，请重新查看历史版本');
      const candidate = await tx.getFirstAsync<{ snapshot_json: string }>(
        'SELECT snapshot_json FROM chat_reply_versions WHERE id = ? AND set_id = ?', [versionId, set.id],
      );
      if (!candidate) throw new Error('这个回复版本已被删除');
      if (versionId === set.selected_version_id) return;
      const current = await messageRepository.listTurnMessagesInTransaction(tx, runId);
      const anchor = await tx.getFirstAsync<{ id: number; created_at: string }>(
        'SELECT id, created_at FROM chat_timeline_run_anchors WHERE session_id = ? AND turn_run_id = ?', [sessionId, runId]);
      await saveReplyVersion(tx, set.id, set.selected_version_id, current);
      await messageRepository.deleteMessagesWithMediaCandidatesInTransaction(tx, current.map(message => message.id), { preserveReplyVersions: true });
      await tx.runAsync('DELETE FROM chat_turn_display_items WHERE run_id = ?', [runId]);
      // 采用只改变这一轮的正文，沿用当前槽位时间、已读状态和回合 owner，不制造一次新消息到达。
      const messages = decodeReplyVersion(candidate.snapshot_json).map(({ id, ...message }, index) => ({
        ...message, sessionId, turnRunId: runId, turnItemIndex: index + 1,
        clientMessageId: message.clientMessageId ?? `reply-version:${versionId}:${id}`,
        createdAt: current[current.length - 1].createdAt, time: current[current.length - 1].time, isRead: true,
        // 截断版与完整候选可能来自不同提交时刻，采用版本不能改变当前轮的持久位置。
        timelineAnchor: { id: anchor!.id, createdAt: anchor!.created_at },
        metadataJson: JSON.stringify({ ...(message.metadataJson ? JSON.parse(message.metadataJson) : {}),
          timelineAnchor: { id: anchor!.id, createdAt: anchor!.created_at } }),
      }));
      const lastAssistant = [...messages].reverse().find(message => message.senderType === 'assistant')!;
      const adopted = await messageRepository.commitMessagesInTransaction(tx, {
        messages, previewText: buildSessionPreviewTextFromMessage(lastAssistant),
      });
      // 尚未消费原输入的回合需要继续按原位置提供当前正文。
      if (source.status !== 'committed') await bindRunDisplayItemsInTransaction(tx, runId, adopted, 'all');
      await tx.runAsync('UPDATE chat_reply_version_sets SET selected_version_id = ? WHERE id = ?', [versionId, set.id]);
      await tx.runAsync('UPDATE conversation_turn_state SET revision = revision + 1 WHERE session_id = ?', [sessionId]);
    });
  }

  async beginExecutionHostRequests(sessionIds: readonly string[]): Promise<ConversationHostStartAttempt[]> {
    return databaseCoordinator.transaction({ name: 'chat.host-start-requested', feature: 'chat', priority: 'interactive' }, async tx => {
      const attempts: ConversationHostStartAttempt[] = [];
      for (const sessionId of sessionIds) {
        await this.ensureTurnStateRowInTransaction(tx, sessionId);
        await tx.runAsync(`UPDATE conversation_turn_state SET host_request_revision = host_request_revision + 1,
          host_request_input_id = (SELECT MAX(id) FROM messages WHERE session_id = ? AND is_me = 1
            AND json_extract(metadata_json, '$.type') IS NOT 'callStatus'),
          host_request_status = 'requested', host_request_at = ? WHERE session_id = ?`,
        [sessionId, new Date().toISOString(), sessionId]);
        const row = await tx.getFirstAsync<{ host_request_revision: number; host_request_input_id: number | null }>(
          'SELECT host_request_revision, host_request_input_id FROM conversation_turn_state WHERE session_id = ?', [sessionId]);
        attempts.push({ sessionId, requestRevision: row!.host_request_revision, inputHighWatermark: row!.host_request_input_id });
      }
      return attempts;
    });
  }

  async finishExecutionHostRequests(attempts: readonly ConversationHostStartAttempt[], accepted: boolean): Promise<void> {
    await databaseCoordinator.transaction({ name: 'chat.host-start-result', feature: 'chat', priority: 'interactive' }, async tx => {
      for (const attempt of attempts) await tx.runAsync(`UPDATE conversation_turn_state SET host_request_status = ?, host_request_at = ?
        WHERE session_id = ? AND host_request_revision = ? AND host_request_input_id IS ?`,
      [accepted ? 'accepted' : 'rejected', new Date().toISOString(), attempt.sessionId, attempt.requestRevision, attempt.inputHighWatermark]);
    });
  }

  /** 工具自身的业务提交也必须服从新用户消息已经撤销的回合资格。 */
  async isRunCurrentInTransaction(transaction: DatabaseTransactionExecutor, runId: string): Promise<boolean> {
    const row = await transaction.getFirstAsync<{ current: number }>(`SELECT 1 AS current
      FROM conversation_turn_runs r JOIN conversation_turn_state s ON s.session_id = r.session_id
      WHERE r.run_id = ? AND r.status = 'active' AND s.active_run_id = r.run_id
      AND s.revision = r.revision_at_claim`, [runId]);
    return row !== null;
  }
  /** 资格读取和请求事务共用同一判据，不按分页列表猜测最新回复。 */
  private async eligibleRegenerationSource(db: DatabaseReadExecutor, sessionId: string): Promise<TurnRunRow | null> {
    return db.getFirstAsync<TurnRunRow>(
      `SELECT r.* FROM conversation_turn_runs r
       JOIN conversation_turn_state s ON s.session_id = r.session_id
       JOIN sessions c ON c.id = r.session_id
       WHERE r.session_id = ? AND (r.status = 'committed' OR (r.status IN ('failed', 'cancelled')
           AND EXISTS (SELECT 1 FROM chat_turn_presentations p WHERE p.run_id = r.run_id AND p.state = 'interrupted')))
         AND r.kind IN ('user_reply', 'regenerate')
         AND s.active_run_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM chat_turn_presentations p WHERE p.session_id = r.session_id AND p.state = 'open')
         AND NOT EXISTS (SELECT 1 FROM agent_runs a WHERE a.session_id = r.session_id
           AND a.status IN ('queued', 'running', 'waiting_for_confirmation', 'waiting_for_foreground', 'suspended'))
         AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.session_id = r.session_id
           AND json_valid(a.metadata_json) AND json_extract(a.metadata_json, '$.type') = 'agentActivity'
           AND json_extract(a.metadata_json, '$.phase') = 'started'
           AND NOT EXISTS (SELECT 1 FROM messages t WHERE t.turn_run_id = a.turn_run_id
             AND json_valid(t.metadata_json) AND json_extract(t.metadata_json, '$.type') = 'agentActivity'
             AND json_extract(t.metadata_json, '$.phase') = 'terminal'))
         AND NOT EXISTS (SELECT 1 FROM chat_regeneration_requests q WHERE q.session_id = r.session_id)
         AND NOT EXISTS (SELECT 1 FROM chat_reply_version_sets v WHERE v.current_run_id = r.run_id AND v.locked = 1)
         AND (r.input_high_watermark = s.reply_cursor OR (r.status IN ('failed', 'cancelled')
           AND r.reply_cursor_at_claim = s.reply_cursor AND r.input_high_watermark > s.reply_cursor))
         AND r.run_id = (SELECT m.turn_run_id FROM chat_visible_messages m
           LEFT JOIN chat_timeline_run_anchors a ON a.session_id = m.session_id AND a.turn_run_id = m.turn_run_id
           WHERE m.session_id = r.session_id AND m.sender_type = 'assistant' AND m.status = 'sent'
             AND m.id > COALESCE(c.visible_after_message_id, 0)
           ORDER BY COALESCE(a.created_at, m.created_at) DESC, COALESCE(a.id, m.id) DESC, m.id DESC LIMIT 1)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.turn_run_id = r.run_id
           AND m.turn_item_index IS NOT NULL AND m.sender_type = 'assistant')
         AND EXISTS (SELECT 1 FROM messages u WHERE u.session_id = r.session_id AND u.is_me = 1
           AND u.id > COALESCE(r.input_cursor_at_claim, r.reply_cursor_at_claim)
           AND u.id <= r.input_high_watermark AND json_extract(u.metadata_json, '$.type') IS NOT 'callStatus')
         AND NOT EXISTS (SELECT 1 FROM messages u WHERE u.session_id = r.session_id AND u.is_me = 1
           AND u.id > r.input_high_watermark AND json_extract(u.metadata_json, '$.type') IS NOT 'callStatus')`,
      [sessionId],
    );
  }

  async getRegenerationState(sessionId: string): Promise<ChatRegenerationState> {
    return databaseCoordinator.read(
      { name: 'chat.regeneration-state', feature: 'chat', priority: 'interactive' },
      async (db) => {
        const pending = await db.getFirstAsync<{ source_run_id: string; active_run_id: string | null }>(
          `SELECT source_run_id, NULL AS active_run_id FROM chat_regeneration_requests WHERE session_id = ?
           UNION ALL SELECT r.regeneration_source_run_id, r.run_id FROM conversation_turn_state s
           JOIN conversation_turn_runs r ON r.run_id = s.active_run_id
           WHERE s.session_id = ? AND r.kind = 'regenerate' LIMIT 1`, [sessionId, sessionId],
        );
        const sourceRunId = pending?.source_run_id ?? null;
        const rows = sourceRunId ? await db.getAllAsync<{ id: number }>(
          'SELECT id FROM messages WHERE turn_run_id = ? AND turn_item_index IS NOT NULL', [sourceRunId],
        ) : [];
        const eligible = sourceRunId ? null : await this.eligibleRegenerationSource(db, sessionId);
        const versionSets = await db.getAllAsync<{ current_run_id: string }>(
          'SELECT current_run_id FROM chat_reply_version_sets WHERE session_id = ?', [sessionId],
        );
        return { versionedRunIds: versionSets.map(set => set.current_run_id), eligibleRunId: eligible?.run_id ?? null, sourceRunId, hiddenMessageIds: rows.map((row) => row.id),
          ...(pending?.active_run_id ? { activeRunId: pending.active_run_id } : {}) };
      },
    );
  }

  requestRegeneration(sessionId: string, messageId: number): Promise<number> {
    return databaseCoordinator.transaction(
      { name: 'chat.request-regeneration', feature: 'chat', priority: 'interactive' },
      async (transaction) => {
        const source = await this.eligibleRegenerationSource(transaction, sessionId);
        const target = await transaction.getFirstAsync<{ turn_run_id: string; sender_type: string; turn_item_index: number | null }>(
          'SELECT turn_run_id, sender_type, turn_item_index FROM messages WHERE id = ? AND session_id = ?',
          [messageId, sessionId],
        );
        if (!source || target?.turn_run_id !== source.run_id || target.sender_type !== 'assistant' || target.turn_item_index === null) {
          throw new Error('只能重写没有后续用户消息的最新一轮 AI 回复');
        }
        // 每次意图拥有独立 revision，原生启动的迟到失败不能撤销后来一次请求。
        await transaction.runAsync(
          'UPDATE conversation_turn_state SET revision = revision + 1 WHERE session_id = ?', [sessionId],
        );
        await transaction.runAsync(
          `INSERT INTO chat_regeneration_requests (session_id, source_run_id, revision)
           SELECT session_id, ?, revision FROM conversation_turn_state WHERE session_id = ?`, [source.run_id, sessionId],
        );
        const request = await transaction.getFirstAsync<{ revision: number }>(
          'SELECT revision FROM chat_regeneration_requests WHERE session_id = ?', [sessionId],
        );
        return request!.revision;
      },
    );
  }

  cancelRegeneration(sessionId: string, requestRevision: number): Promise<void> {
    return databaseCoordinator.transaction(
      { name: 'chat.cancel-regeneration', feature: 'chat', priority: 'interactive' },
      async (transaction) => {
        const owned = await transaction.getFirstAsync<{ run_id: string | null }>(
          `SELECT NULL AS run_id FROM chat_regeneration_requests WHERE session_id = ? AND revision = ?
           UNION ALL SELECT r.run_id FROM conversation_turn_state s
           JOIN conversation_turn_runs r ON r.run_id = s.active_run_id
           WHERE s.session_id = ? AND r.kind = 'regenerate' AND r.revision_at_claim = ?`,
          [sessionId, requestRevision, sessionId, requestRevision + 1],
        );
        if (owned) {
          if (owned.run_id) await interruptTurnPresentationsInTransaction(transaction, sessionId, 'host_start_failed', owned.run_id);
          await cancelRegenerationInTransaction(transaction, sessionId);
        }
      },
    );
  }

  async ensureTurnStateRowInTransaction(
    transaction: DatabaseTransactionExecutor,
    sessionId: string,
  ): Promise<void> {
    await transaction.runAsync(
      `INSERT OR IGNORE INTO conversation_turn_state
         (session_id, reply_cursor, revision, active_run_id, active_run_kind, updated_at)
       VALUES (?, 0, 0, NULL, NULL, ?)`,
      [sessionId, new Date().toISOString()],
    );
  }

  async recordImportedHistoryInTransaction(
    transaction: DatabaseTransactionExecutor,
    sessionId: string,
    lastInputId: number,
  ): Promise<void> {
    await this.ensureTurnStateRowInTransaction(transaction, sessionId);
    const result = await transaction.runAsync(
      `UPDATE conversation_turn_state
       SET reply_cursor = MAX(reply_cursor, ?), reply_requested = 0, revision = revision + 1, updated_at = ?
       WHERE session_id = ? AND active_run_id IS NULL AND summon_requested = 0`,
      [lastInputId, new Date().toISOString(), sessionId],
    );
    if (result.changes !== 1) throw new Error('这个 AI 正在处理回复，请完成后再导入。');
  }

  async supersedeActiveRunInTransaction(
    transaction: DatabaseTransactionExecutor,
    sessionId: string,
  ): Promise<string | null> {
    await interruptTurnPresentationsInTransaction(transaction, sessionId, 'new_input');
    await transaction.runAsync('DELETE FROM chat_regeneration_requests WHERE session_id = ?', [sessionId]);
    const state = await transaction.getFirstAsync<Pick<TurnStateRow, 'active_run_id'>>(
      `SELECT active_run_id FROM conversation_turn_state WHERE session_id = ?`,
      [sessionId],
    );
    if (!state || state.active_run_id === null) {
      return null;
    }
    const now = new Date().toISOString();
    const superseded = await transaction.runAsync(
      `UPDATE conversation_turn_runs
       SET status = 'superseded', terminal_at = ?
       WHERE run_id = ? AND status = 'active'`,
      [now, state.active_run_id],
    );
    if (superseded.changes !== 1) {
      throw new ConversationTurnInvariantError(
        `supersedeActiveRun：run ${state.active_run_id} 期望为 active，实际影响 ${superseded.changes} 行`,
      );
    }
    const cleared = await transaction.runAsync(
      `UPDATE conversation_turn_state
       SET active_run_id = NULL, active_run_kind = NULL, revision = revision + 1, updated_at = ?
       WHERE session_id = ? AND active_run_id = ?`,
      [now, sessionId, state.active_run_id],
    );
    if (cleared.changes !== 1) {
      throw new ConversationTurnInvariantError(
        `supersedeActiveRun：turn_state 清理 active_run_id 影响 ${cleared.changes} 行`,
      );
    }
    return state.active_run_id;
  }

  claimIfIdle(
    sessionId: string,
    kind: ConversationTurnKind,
  ): Promise<ConversationTurnRun | null> {
    return databaseCoordinator.transaction(
      { name: 'chat.claim-turn-if-idle', feature: 'chat', priority: 'interactive' },
      (transaction) => this.claimInTransaction(transaction, sessionId, kind, 'claim_if_idle'),
    );
  }

  takeOverOrphan(
    sessionId: string,
    kind: ConversationTurnKind,
  ): Promise<ConversationTurnRun | null> {
    return databaseCoordinator.transaction(
      { name: 'chat.take-over-orphan-turn', feature: 'chat', priority: 'runtime' },
      (transaction) => this.claimInTransaction(transaction, sessionId, kind, 'take_over_orphan'),
    );
  }

  /**
   * T2 claim：读 turn_state → 计算高水位 → 插 run 行（先于 turn_state 更新，满足外键引用顺序）
   * → 按需 supersede 旧 active run → CAS 更新 turn_state（revision 断言，0 行即回滚）。
   */
  private async claimInTransaction(
    transaction: DatabaseTransactionExecutor,
    sessionId: string,
    kind: ConversationTurnKind,
    mode: 'claim_if_idle' | 'take_over_orphan',
  ): Promise<ConversationTurnRun | null> {
    if (!await isAssistantConversationAvailable(transaction, sessionId)) return null;
    const now = new Date().toISOString();
    await this.ensureTurnStateRowInTransaction(transaction, sessionId);
    const state = await transaction.getFirstAsync<TurnStateRow>(
      `SELECT reply_cursor, revision, active_run_id, reply_requested, summon_requested
       FROM conversation_turn_state WHERE session_id = ?`,
      [sessionId],
    );
    if (!state) {
      throw new ConversationTurnInvariantError(`claim：会话 ${sessionId} 缺少 turn_state 行`);
    }
    const request = await transaction.getFirstAsync<{ source_run_id: string; revision: number }>(
      'SELECT * FROM chat_regeneration_requests WHERE session_id = ?', [sessionId],
    );
    const source = request ? await transaction.getFirstAsync<TurnRunRow>(
      'SELECT * FROM conversation_turn_runs WHERE run_id = ?', [request.source_run_id],
    ) : null;
    if (request && request.revision !== state.revision) {
      await transaction.runAsync('DELETE FROM chat_regeneration_requests WHERE session_id = ?', [sessionId]);
      return null;
    }
    // 重写孤儿封存已交付正文；不重新执行可能已经发生的工具。
    if (mode === 'take_over_orphan' && state.active_run_id !== null) {
      const orphan = await transaction.getFirstAsync<{ kind: string }>(
        'SELECT kind FROM conversation_turn_runs WHERE run_id = ?', [state.active_run_id],
      );
      if (orphan?.kind === 'summon') {
        await this.cancelCurrentTurnInTransaction(transaction, sessionId, 'process_restarted');
        return null;
      }
      if (orphan?.kind === 'regenerate') {
        await interruptTurnPresentationsInTransaction(transaction, sessionId, 'process_restarted', state.active_run_id);
        await cancelRegenerationInTransaction(transaction, sessionId);
        return null;
      }
      if (orphan?.kind === 'autonomous') {
        // 日程孤儿只收口，不借普通聊天恢复重新执行模型或工具。
        const failed = await transaction.runAsync(`UPDATE conversation_turn_runs SET status = 'failed',
          terminal_reason = 'process_restarted', terminal_at = ? WHERE run_id = ? AND status = 'active'`, [now, state.active_run_id]);
        const released = await transaction.runAsync(`UPDATE conversation_turn_state SET active_run_id = NULL, active_run_kind = NULL,
          revision = revision + 1, updated_at = ? WHERE session_id = ? AND active_run_id = ? AND revision = ?`,
        [now, sessionId, state.active_run_id, state.revision]);
        if (failed.changes !== 1 || released.changes !== 1) throw new ConversationTurnInvariantError('日程孤儿收口失去会话所有权');
        return this.claimInTransaction(transaction, sessionId, kind, 'claim_if_idle');
      }
      const toolStarted = await transaction.getFirstAsync(`SELECT 1 FROM chat_turn_display_items
        WHERE run_id = ? AND json_extract(snapshot_json, '$.toolExecutionStarted') = 1 LIMIT 1`, [state.active_run_id]);
      if (toolStarted) {
        const failed = await transaction.runAsync(`UPDATE conversation_turn_runs SET status = 'failed',
          terminal_reason = 'orphan_after_tool_start', terminal_at = ? WHERE run_id = ? AND status = 'active'`, [now, state.active_run_id]);
        const released = await transaction.runAsync(`UPDATE conversation_turn_state SET active_run_id = NULL, active_run_kind = NULL,
          revision = revision + 1, updated_at = ? WHERE session_id = ? AND active_run_id = ? AND revision = ?`,
        [now, sessionId, state.active_run_id, state.revision]);
        if (failed.changes !== 1 || released.changes !== 1) {
          throw new ConversationTurnInvariantError(`工具孤儿收口失去 owner：${state.active_run_id}`);
        }
        await interruptTurnPresentationsInTransaction(transaction, sessionId, 'orphan_after_tool_start', state.active_run_id);
        return null;
      }
    }
    const runKind: ConversationTurnKind = source ? 'regenerate' : state.summon_requested ? 'summon' : kind;
    if (!source && state.reply_requested === 0) return null;
    // 高水位只统计 canonical 用户消息；通话状态虽标记为用户方向，但不属于 user_reply 输入。
    const highWatermarkRow = await transaction.getFirstAsync<{ hw: number | null }>(
      `SELECT MAX(id) AS hw FROM messages
       WHERE session_id = ?
         AND is_me = 1
         AND json_extract(metadata_json, '$.type') IS NOT 'callStatus'`,
      [sessionId],
    );
    const latestInputId = highWatermarkRow?.hw ?? 0;
    const highWatermark = source ? source.input_high_watermark
      : runKind === 'summon' ? Math.max(state.reply_cursor, latestInputId) : latestInputId;
    if (!source && runKind !== 'summon' && highWatermark <= state.reply_cursor) {
      return null;
    }
    if (mode === 'claim_if_idle' && state.active_run_id !== null) {
      return null;
    }
    // 宿主请求可能排队到上一轮失败之后才执行；终态资格必须与 claim 原子裁决，
    // 不能只依赖恢复扫描时的读取，否则同一输入会再次请求模型。
    if (!source && runKind !== 'summon' && await transaction.getFirstAsync(
      `SELECT 1 FROM conversation_turn_runs
       WHERE session_id = ? AND kind IN ('user_reply', 'summon') AND status IN ('failed', 'cancelled')
         AND input_high_watermark >= ? LIMIT 1`,
      [sessionId, highWatermark],
    )) {
      return null;
    }

    const runId = createTurnRunId();
    const revisionAtClaim = state.revision + 1;

    // idx_turn_runs_single_active 保证每会话最多一个 active run：
    // 必须先 supersede 孤儿再插新 run，否则 INSERT 直接违反部分唯一索引。
    if (mode === 'take_over_orphan' && state.active_run_id !== null) {
      await interruptTurnPresentationsInTransaction(transaction, sessionId, 'process_restarted', state.active_run_id);
      const superseded = await transaction.runAsync(
        `UPDATE conversation_turn_runs
         SET status = 'superseded', terminal_at = ?
         WHERE run_id = ? AND status = 'active'`,
        [now, state.active_run_id],
      );
      if (superseded.changes !== 1) {
        throw new ConversationTurnInvariantError(
          `takeOverOrphan：孤儿 run ${state.active_run_id} 期望为 active，实际影响 ${superseded.changes} 行`,
        );
      }
    }

    // 先插 run 行再更新 turn_state，满足 active_run_id 的外键引用顺序（方案 12 节）。
    await transaction.runAsync(
      `INSERT INTO conversation_turn_runs
         (run_id, session_id, kind, reply_cursor_at_claim, input_high_watermark,
          revision_at_claim, status, terminal_reason, created_at, terminal_at, regeneration_source_run_id, input_cursor_at_claim)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL, ?, ?)`,
      [runId, sessionId, runKind, state.reply_cursor, highWatermark, revisionAtClaim, now,
        source?.run_id ?? null, source ? source.input_cursor_at_claim ?? source.reply_cursor_at_claim : null],
    );
    if (runKind === 'summon') {
      // 续聊没有新的用户消息，以召唤发生时的时间线位置锚定展示，避免排回旧用户输入之后。
      await transaction.runAsync(`INSERT INTO chat_timeline_run_anchors(session_id, turn_run_id, id, created_at)
        VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE session_id = ?), ?)`, [sessionId, runId, sessionId, now]);
    }

    // CAS 断言：claim_if_idle 额外要求 active_run_id IS NULL（16.3），
    // take_over_orphan 要求 active_run_id 仍是事务内读到的值。
    const claimed = mode === 'claim_if_idle'
      ? await transaction.runAsync(
        `UPDATE conversation_turn_state
         SET active_run_id = ?, active_run_kind = ?, summon_requested = 0, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND revision = ? AND active_run_id IS NULL`,
        [runId, runKind, now, sessionId, state.revision],
      )
      : await transaction.runAsync(
        `UPDATE conversation_turn_state
         SET active_run_id = ?, active_run_kind = ?, summon_requested = 0, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND revision = ?
           AND (active_run_id IS NULL OR active_run_id = ?)`,
        [runId, runKind, now, sessionId, state.revision, state.active_run_id],
      );
    if (claimed.changes !== 1) {
      throw new ConversationTurnInvariantError(
        `claim：turn_state CAS 影响 ${claimed.changes} 行（session ${sessionId}，expected revision ${state.revision}）`,
      );
    }

    await transaction.runAsync('DELETE FROM chat_regeneration_requests WHERE session_id = ?', [sessionId]);
    return {
      runId,
      sessionId,
      kind: runKind,
      regenerationSourceRunId: source?.run_id ?? null,
      inputCursorAtClaim: source ? source.input_cursor_at_claim ?? source.reply_cursor_at_claim : null,
      replyCursorAtClaim: state.reply_cursor,
      inputHighWatermark: highWatermark,
      revisionAtClaim,
      status: 'active',
      terminalReason: null,
      createdAt: now,
      terminalAt: null,
    };
  }

  async listOpenToolPackageIds(sessionId: string, assistantId: string): Promise<string[]> {
    return databaseCoordinator.read(
      { name: 'chat.open-tool-packages', feature: 'chat', priority: 'interactive' },
      async (executor) => {
        const rows = await executor.getAllAsync<{ package_id: string }>(
          `SELECT package_id FROM chat_tool_package_exposure
           WHERE session_id = ? AND assistant_id = ? ORDER BY package_id`,
          [sessionId, assistantId],
        );
        return rows.map((row) => row.package_id);
      },
    );
  }

  async commitTurn(
    run: ConversationTurnRun,
    items: ConversationTurnCommitItem[],
    toolPackages: ConversationToolPackageCommit,
    execution?: { deadlineAt: number; signal?: AbortSignal },
  ): Promise<ConversationTurnCommitResult> {
    if (items.length === 0) {
      throw new ConversationTurnInvariantError(`commitTurn：run ${run.runId} 不允许空条目列表`);
    }
    return databaseCoordinator.transaction(
      { name: 'chat.commit-turn', feature: 'chat', priority: 'interactive' },
      async (transaction) => {
        const now = new Date().toISOString();
        // fence 先行：此时事务尚未写入任何事实，失败即原样提交（零变更）。
        const fence = await transaction.runAsync(
          `UPDATE conversation_turn_state
           SET reply_cursor = ?, active_run_id = NULL, active_run_kind = NULL,
               revision = revision + 1, updated_at = ?
           WHERE session_id = ?
             AND reply_cursor = ?
             AND revision = ?
             AND active_run_id = ?
             AND NOT EXISTS (SELECT 1 FROM chat_turn_presentations p WHERE p.run_id = ? AND p.state = 'interrupted')`,
          [
            run.inputHighWatermark,
            now,
            run.sessionId,
            run.replyCursorAtClaim,
            run.revisionAtClaim,
            run.runId,
            run.runId,
          ],
        );
        if (fence.changes === 0) {
          return { outcome: 'fence_failed' };
        }
        // 截止时间是宿主给本次执行的权限边界；抛错回滚上面的 CAS，再由 T4 记失败。
        if (execution && performance.now() >= execution.deadlineAt) throw new Error('execution_host_timeout');
        if (execution?.signal?.aborted) throw new Error('execution_host_stopped');

        const replacement = run.regenerationSourceRunId
          ? await replaceRegeneratedReplyInTransaction(transaction, run.sessionId, run.regenerationSourceRunId, run.runId, false)
          : null;
        const inserted = await commitRunItemsInTransaction(transaction, run, items, true);
        if (replacement) {
          await saveReplyVersion(transaction, replacement.setId, run.runId, inserted);
        }

        if (inserted.some((message) => message.senderType === 'assistant')) {
          // 开关与正式回复共用 T3 fence；按执行顺序应用，同包的最后一次决定生效。
          const scope = [run.sessionId, toolPackages.assistantId];
          for (const { packageId, action } of toolPackages.changes) {
            if (action === 'open') {
              await transaction.runAsync(
                `INSERT INTO chat_tool_package_exposure (session_id, assistant_id, package_id)
                 VALUES (?, ?, ?) ON CONFLICT(session_id, assistant_id, package_id) DO NOTHING`,
                [...scope, packageId],
              );
            } else {
              await transaction.runAsync(
                `DELETE FROM chat_tool_package_exposure WHERE session_id = ? AND assistant_id = ? AND package_id = ?`,
                [...scope, packageId],
              );
            }
          }
        }

        const terminal = await transaction.runAsync(
          `UPDATE conversation_turn_runs
           SET status = 'committed', terminal_at = ?
           WHERE run_id = ? AND status = 'active'`,
          [now, run.runId],
        );
        await transaction.runAsync(`UPDATE chat_turn_presentations SET phase = 'delivering', phase_at = ?, updated_at = ?
          WHERE run_id = ? AND state = 'open'`, [now, now, run.runId]);
        // 首个新气泡与原版退出时间线是同一次可见交接，后续分段继续按原节奏到达。
        await bindRunDisplayItemsInTransaction(transaction, run.runId, inserted, replacement ? 'first_assistant' : 'process');
        await completeTurnPresentationInTransaction(transaction, run.runId);
        if (terminal.changes !== 1) {
          throw new ConversationTurnInvariantError(
            `commitTurn：run ${run.runId} 期望为 active，实际影响 ${terminal.changes} 行`,
          );
        }
        return {
          outcome: 'committed',
          messageIds: inserted.map((message) => message.id),
          messages: inserted,
          mediaAssetCandidates: [...(replacement?.mediaAssetCandidates ?? [])],
        };
      },
    );
  }

  async commitOutput(
    run: ConversationTurnRun,
    item: ConversationTurnCommitItem,
    execution?: { deadlineAt?: number; signal?: AbortSignal },
  ): Promise<ConversationTurnCommitResult> {
    return databaseCoordinator.transaction({ name: 'chat.commit-output', feature: 'chat', priority: 'interactive' }, async transaction => {
      // 同一持久 owner 裁决部分输出，保持游标、revision 和执行槽不变。
      const current = await transaction.getFirstAsync(`SELECT 1 FROM conversation_turn_runs r
        JOIN conversation_turn_state s ON s.session_id = r.session_id
        WHERE r.run_id = ? AND r.status = 'active' AND s.active_run_id = r.run_id
          AND s.revision = r.revision_at_claim AND s.reply_cursor = ?
          AND NOT EXISTS (SELECT 1 FROM chat_turn_presentations p WHERE p.run_id = r.run_id AND p.state <> 'open')`,
      [run.runId, run.replyCursorAtClaim]);
      if (!current) return { outcome: 'fence_failed' };
      if (execution?.deadlineAt !== undefined && performance.now() >= execution.deadlineAt) throw new Error('execution_host_timeout');
      if (execution?.signal?.aborted) throw new Error('execution_host_stopped');
      const messages = await commitRunItemsInTransaction(transaction, run, [item], false);
      // 图片／表情没有流式尾部：消息引用与完整可见版本同事务提交，取消不能撤销已发出的图片。
      await bindRunDisplayItemsInTransaction(transaction, run.runId, messages, 'all');
      return { outcome: 'committed', messages, messageIds: messages.map(message => message.id) };
    });
  }

  async revoke(
    run: ConversationTurnRun,
    status: ConversationTurnTerminalStatus,
    reason: string,
  ): Promise<void> {
    return databaseCoordinator.transaction(
      { name: 'chat.revoke-turn', feature: 'chat', priority: 'interactive' },
      async (transaction) => {
        await interruptTurnPresentationsInTransaction(transaction, run.sessionId, reason, run.runId);
        const now = new Date().toISOString();
        const revoked = await transaction.runAsync(
          `UPDATE conversation_turn_state
           SET active_run_id = NULL, active_run_kind = NULL,
               revision = revision + 1, updated_at = ?
           WHERE session_id = ? AND revision = ? AND active_run_id = ?`,
          [now, run.sessionId, run.revisionAtClaim, run.runId],
        );
        const terminal = await transaction.runAsync(
          `UPDATE conversation_turn_runs
           SET status = ?, terminal_reason = ?, terminal_at = ?
           WHERE run_id = ? AND status = 'active'`,
          [status, reason, now, run.runId],
        );
        // turn_state CAS 0 行：run 已被 supersede/commit 失去所有权，
        // 不重试 turn_state，只尽力写 run 行终态；
        // 但所有权已撤销而 run 行却不是 active 属于状态漂移，必须回滚并报 invariant violation。
        if (revoked.changes === 1 && terminal.changes !== 1) {
          throw new ConversationTurnInvariantError(
            `revoke：run ${run.runId} 所有权已撤销但 run 行非 active（影响 ${terminal.changes} 行）`,
          );
        }
      },
    );
  }

  async findTerminalRunCovering(
    sessionId: string,
    highWatermark: number,
  ): Promise<ConversationTurnRun | null> {
    return databaseCoordinator.read(
      { name: 'chat.find-terminal-run-covering', feature: 'chat', priority: 'runtime' },
      async (db) => {
        const row = await db.getFirstAsync<TurnRunRow>(
          `SELECT * FROM conversation_turn_runs
           WHERE session_id = ?
             AND kind IN ('user_reply', 'summon') AND status IN ('failed', 'cancelled')
             AND input_high_watermark >= ?
           ORDER BY input_high_watermark DESC
           LIMIT 1`,
          [sessionId, highWatermark],
        );
        return row ? mapRowToRun(row) : null;
      },
    );
  }

  async getSessionTurnSnapshot(
    sessionId: string,
  ): Promise<ConversationTurnUnrepliedSession | null> {
    return databaseCoordinator.read(
      { name: 'chat.get-session-turn-snapshot', feature: 'chat', priority: 'runtime' },
      async (db) => {
        const row = await db.getFirstAsync<{ reply_cursor: number; high_watermark: number | null; has_regeneration: number; has_summon: number }>(
          `SELECT s.reply_cursor,
                  (s.active_run_kind IS 'regenerate' OR EXISTS (
                    SELECT 1 FROM chat_regeneration_requests q WHERE q.session_id = s.session_id)) AS has_regeneration,
                  (s.summon_requested = 1 OR s.active_run_kind IS 'summon') AS has_summon,
                  (SELECT MAX(m.id) FROM messages m
                   WHERE m.session_id = s.session_id
                     AND m.is_me = 1
                     AND json_extract(m.metadata_json, '$.type') IS NOT 'callStatus') AS high_watermark
           FROM conversation_turn_state s
           WHERE s.session_id = ? AND (s.reply_requested = 1 OR s.active_run_kind IN ('regenerate','summon')
             OR EXISTS (SELECT 1 FROM chat_regeneration_requests q WHERE q.session_id = s.session_id))`,
          [sessionId],
        );
        if (!row || (row.high_watermark === null && !row.has_summon)) {
          return null;
        }
        return {
          sessionId,
          replyCursor: row.reply_cursor,
          highWatermark: Number(row.high_watermark ?? 0),
          ...(row.has_regeneration ? { hasRegeneration: true } : {}),
          ...(row.has_summon ? { hasSummon: true } : {}),
        };
      },
    );
  }

  async listSessionsWithUnrepliedInput(
    afterSessionId: string,
    limit: number,
  ): Promise<ConversationTurnUnrepliedSession[]> {
    return databaseCoordinator.read(
      { name: 'chat.list-sessions-with-unreplied-input', feature: 'chat', priority: 'runtime' },
      async (db) => {
        const rows = await db.getAllAsync<{ session_id: string; reply_cursor: number; high_watermark: number; has_regeneration: number; has_summon: number }>(
          `SELECT s.session_id, s.reply_cursor,
                  (s.active_run_kind IS 'regenerate' OR EXISTS (
                    SELECT 1 FROM chat_regeneration_requests q WHERE q.session_id = s.session_id)) AS has_regeneration,
                  (s.summon_requested = 1 OR s.active_run_kind IS 'summon') AS has_summon,
                  (SELECT MAX(m2.id) FROM messages m2
                   WHERE m2.session_id = s.session_id
                     AND m2.is_me = 1
                     AND json_extract(m2.metadata_json, '$.type') IS NOT 'callStatus') AS high_watermark
           FROM conversation_turn_state s
           INNER JOIN chat_conversations c
             ON c.id = s.session_id AND c.kind = 'direct'
           WHERE s.session_id > ?
             AND (s.reply_requested = 1 OR s.active_run_kind IN ('regenerate','summon')
               OR EXISTS (SELECT 1 FROM chat_regeneration_requests q WHERE q.session_id = s.session_id))
             AND EXISTS (SELECT 1 FROM sessions direct JOIN ai_assistants a ON a.id = direct.ai_assistant_id
               WHERE direct.id = s.session_id AND a.deleted_at IS NULL)
             AND (EXISTS (SELECT 1 FROM chat_regeneration_requests q WHERE q.session_id = s.session_id)
               OR s.active_run_kind IN ('regenerate','summon') OR s.summon_requested = 1 OR EXISTS (
               SELECT 1 FROM messages m
               WHERE m.session_id = s.session_id
                 AND m.is_me = 1
                 AND json_extract(m.metadata_json, '$.type') IS NOT 'callStatus'
                 AND m.id > s.reply_cursor
             ))
           ORDER BY s.session_id ASC
           LIMIT ?`,
          [afterSessionId, limit],
        );
        return rows.map((row) => ({
          sessionId: row.session_id,
          replyCursor: row.reply_cursor,
          highWatermark: Number(row.high_watermark ?? 0),
          ...(row.has_regeneration ? { hasRegeneration: true } : {}),
          ...(row.has_summon ? { hasSummon: true } : {}),
        }));
      },
    );
  }
}

/** 回收是新的执行资格边界；旧原生信箱请求不能重新领取已隐藏会话。 */
async function isAssistantConversationAvailable(db: DatabaseReadExecutor, sessionId: string): Promise<boolean> {
  return await db.getFirstAsync(`SELECT 1 FROM sessions s JOIN ai_assistants a ON a.id = s.ai_assistant_id
    WHERE s.id = ? AND a.deleted_at IS NULL`, [sessionId]) !== null;
}

/** 部分输出和 T3 共用消息提交；T3 只把已存在的稳定身份绑定到最终顺序，不重建事实。 */
async function commitRunItemsInTransaction(
  transaction: DatabaseTransactionExecutor,
  run: ConversationTurnRun,
  items: ConversationTurnCommitItem[],
  complete: boolean,
): Promise<ChatMessage[]> {
  const readDisplayItems = await transaction.getAllAsync<{ identity: string }>(
    'SELECT identity FROM chat_turn_display_items WHERE run_id = ? AND is_read = 1', [run.runId],
  );
  const readIdentities = new Set(readDisplayItems.map(item => item.identity));
  const reused = new Map<number, ChatMessage>();
  const pending: ConversationTurnCommitItem['message'][] = [];
  for (const [index, item] of items.entries()) {
    if (item.committedMessageId !== undefined) {
      const existing = await messageRepository.bindTurnMessageInTransaction(transaction, item.committedMessageId, index + 1);
      if (existing) reused.set(index, existing);
      continue;
    }
    const message = item.materializeInTransaction
      ? await item.materializeInTransaction(transaction, item.message) : item.message;
    pending.push({ ...message, ...(readIdentities.has(message.clientMessageId!) ? { isRead: true } : {}),
      turnRunId: run.runId, turnItemIndex: complete ? index + 1 : null });
  }
  const inserted = await messageRepository.commitMessagesInTransaction(transaction, { messages: pending, previewText: null });
  let next = 0;
  const messages = items.flatMap((item, index) => item.committedMessageId === undefined ? [inserted[next++]]
    : reused.has(index) ? [reused.get(index)!] : []);
  const lastAssistant = [...messages].reverse().find(message => message.senderType === 'assistant');
  if (lastAssistant) await messageRepository.updateSessionPreviewForCommittedMessageInTransaction(transaction, {
    sessionId: run.sessionId, messageId: lastAssistant.id, previewText: buildSessionPreviewTextFromMessage(lastAssistant),
  });
  return messages;
}

async function bindRunDisplayItemsInTransaction(
  transaction: DatabaseTransactionExecutor,
  runId: string,
  messages: ChatMessage[],
  publish: 'all' | 'first_assistant' | 'process',
): Promise<void> {
  if (!await transaction.getFirstAsync('SELECT 1 FROM chat_turn_presentations WHERE run_id = ?', [runId])) return;
  const firstAssistant = publish === 'first_assistant' ? messages.find(message => message.senderType === 'assistant') : undefined;
  for (const message of messages) {
    const metadata = message.metadataJson ? JSON.parse(message.metadataJson) : {};
    const snapshot = {
      runId, sequence: metadata.timelineSequence ?? message.turnItemIndex, stepIndex: metadata.stepIndex ?? 1,
      kind: message.senderType === 'reasoning' ? 'reasoning' : message.senderType === 'assistant' ? 'assistant' : 'tool',
      status: message.status === 'streaming' ? 'streaming' : 'sent', text: message.text,
      metadataJson: message.metadataJson, segmentIndex: message.segmentIndex,
      tokensUsed: message.tokensUsed, promptTokens: message.promptTokens, completionTokens: message.completionTokens,
      cachedTokens: metadata.cachedTokens, clientMessageId: message.clientMessageId, createdAt: message.createdAt, time: message.time,
      toolNames: metadata.toolNames, toolDisplayNames: metadata.displayNames, toolExecutions: metadata.toolExecutions,
    };
    await transaction.runAsync(`INSERT INTO chat_turn_display_items(run_id, identity, version, snapshot_json, message_id)
      VALUES (?, ?, 1, ?, ?) ON CONFLICT(run_id, identity) DO UPDATE
      SET message_id = excluded.message_id, snapshot_json = excluded.snapshot_json, version = chat_turn_display_items.version + 1`,
    [runId, message.clientMessageId!, JSON.stringify(snapshot), message.id]);
    if (publish === 'all' || message === firstAssistant || snapshot.kind !== 'assistant') await transaction.runAsync(`UPDATE chat_turn_display_items
      SET shown_version = version, shown_json = snapshot_json WHERE message_id = ?`, [message.id]);
  }
}

export const conversationTurnRepository = new ConversationTurnRepository();
