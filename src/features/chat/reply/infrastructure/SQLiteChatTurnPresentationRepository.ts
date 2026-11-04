import { databaseCoordinator } from '@platform/persistence';
import type { ConversationTurnRun } from '../domain/ConversationTurn';
import type { ChatTurnDisplayVersion, ChatTurnPresentationHistory, ChatTurnPresentationWindow, ChatTurnExecutionProgress, ChatTurnExecutionStatus, ChatTurnExecutionPhase, ChatInterruptedTurnContext, ChatTurnDisplaySnapshot } from '../domain/ChatTurnPresentation';
import type { IChatTurnPresentationRepository } from '../domain/ChatTurnPresentationRepository';

const completePresentationSql = `UPDATE chat_turn_presentations SET state = 'completed', updated_at = ? WHERE run_id = ? AND state = 'open'
  AND EXISTS (SELECT 1 FROM conversation_turn_runs WHERE run_id = ? AND status = 'committed')
  AND NOT EXISTS (SELECT 1 FROM chat_turn_display_items WHERE run_id = ? AND message_id IS NOT NULL AND (shown_json IS NULL
    OR json_extract(shown_json, '$.text') <> json_extract(snapshot_json, '$.text')))`;

export class ChatTurnPresentationRepository implements IChatTurnPresentationRepository {
  async open(run: ConversationTurnRun): Promise<boolean> {
    return databaseCoordinator.transaction({ name: 'chat.open-presentation', feature: 'chat', priority: 'interactive' }, async tx => {
      const result = await tx.runAsync(`INSERT INTO chat_turn_presentations(run_id, session_id, state, updated_at)
        SELECT r.run_id, r.session_id, 'open', ? FROM conversation_turn_runs r
        JOIN conversation_turn_state s ON s.active_run_id = r.run_id
        WHERE r.run_id = ? AND r.status = 'active' AND s.revision = r.revision_at_claim
        ON CONFLICT(run_id) DO NOTHING`, [new Date().toISOString(), run.runId]);
      return result.changes === 1;
    });
  }

  async checkpoint(runId: string, items: readonly ChatTurnDisplayVersion[], progress?: ChatTurnExecutionProgress): Promise<boolean> {
    return databaseCoordinator.transaction({ name: 'chat.checkpoint-presentation', feature: 'chat', priority: 'runtime' }, async tx => {
      const open = await tx.getFirstAsync(`SELECT 1 FROM chat_turn_presentations WHERE run_id = ? AND state = 'open'`, [runId]);
      if (!open) return false;
      if (progress) await tx.runAsync(`UPDATE chat_turn_presentations SET phase = ?, phase_at = ?, updated_at = ? WHERE run_id = ?`,
        [progress.phase, progress.at, new Date().toISOString(), runId]);
      for (const { version, snapshot } of items) {
        await tx.runAsync(`INSERT INTO chat_turn_display_items(run_id, identity, version, snapshot_json)
          VALUES (?, ?, ?, ?) ON CONFLICT(run_id, identity) DO UPDATE
          SET version = excluded.version, snapshot_json = excluded.snapshot_json
          WHERE excluded.version > chat_turn_display_items.version`,
        [runId, snapshot.clientMessageId, version, JSON.stringify(snapshot)]);
      }
      return true;
    });
  }

  async getExecutionStatus(sessionId: string): Promise<ChatTurnExecutionStatus | null> {
    const row = await databaseCoordinator.openTaskExecutor({ name: 'chat.execution-status', feature: 'chat', priority: 'interactive' })
      .getFirstAsync<{ input_id: number; input_at: string; reply_cursor: number; host_request_input_id: number | null;
        host_request_status: string | null; host_request_at: string | null; status: string | null; terminal_reason: string | null;
        created_at: string | null; terminal_at: string | null; display_state: string | null; updated_at: string | null;
        phase: ChatTurnExecutionPhase | null; phase_at: string | null }>(
        `SELECT i.id AS input_id, i.created_at AS input_at, s.reply_cursor, s.host_request_input_id,
          s.host_request_status, s.host_request_at, r.status, r.terminal_reason, r.created_at, r.terminal_at,
          p.state AS display_state, p.updated_at, p.phase, p.phase_at
         FROM messages i JOIN sessions c ON c.id = i.session_id
         JOIN conversation_turn_state s ON s.session_id = i.session_id
         LEFT JOIN conversation_turn_runs r ON r.run_id = COALESCE(
           CASE WHEN s.active_run_kind IN ('user_reply', 'regenerate') THEN s.active_run_id END,
           (SELECT run_id FROM conversation_turn_runs WHERE session_id = i.session_id AND input_high_watermark = i.id
            AND kind IN ('user_reply', 'regenerate') ORDER BY created_at DESC, rowid DESC LIMIT 1))
         LEFT JOIN chat_turn_presentations p ON p.run_id = r.run_id
         WHERE i.session_id = ? AND i.id > COALESCE(c.visible_after_message_id, 0)
           AND i.id = (SELECT MAX(id) FROM messages WHERE session_id = ? AND is_me = 1
             AND json_extract(metadata_json, '$.type') IS NOT 'callStatus')`, [sessionId, sessionId]);
    if (!row) return null;
    if (row.status === 'failed') return { phase: row.phase === 'request_failed' ? 'request_failed' : 'failed',
      at: row.terminal_at!, reason: row.terminal_reason };
    if (row.status === 'cancelled' || row.status === 'superseded' || row.display_state === 'interrupted') return {
      phase: 'interrupted', at: row.display_state === 'interrupted' ? row.updated_at! : row.terminal_at!,
      reason: row.status === 'committed' ? 'display_interrupted' : row.terminal_reason,
    };
    if (row.status === 'active') return { phase: row.phase ?? 'preparing', at: row.phase_at ?? row.created_at! };
    if (row.status === 'committed' && row.display_state === 'open') return { phase: 'delivering', at: row.phase_at ?? row.terminal_at! };
    if (row.reply_cursor >= row.input_id) return null;
    const currentRequest = row.host_request_input_id === row.input_id;
    if (currentRequest && row.host_request_status === 'rejected') return { phase: 'failed', at: row.host_request_at!, reason: 'execution_host_start_rejected' };
    return { phase: currentRequest && row.host_request_status === 'accepted' ? 'host_started' : 'waiting_host', at: currentRequest ? row.host_request_at! : row.input_at };
  }

  async publishVersions(runId: string, items: readonly ChatTurnDisplayVersion[]): Promise<boolean> {
    return databaseCoordinator.transaction({ name: 'chat.publish-presentation', feature: 'chat', priority: 'interactive' }, async tx => {
      const open = await tx.getFirstAsync(`SELECT 1 FROM chat_turn_presentations WHERE run_id = ? AND state = 'open'`, [runId]);
      if (!open) return false;
      for (const { version, snapshot } of items) {
        await tx.runAsync(`UPDATE chat_turn_display_items SET shown_version = ?, shown_json = ?
          WHERE run_id = ? AND identity = ? AND version >= ? AND shown_version < ?`,
        [version, JSON.stringify(snapshot), runId, snapshot.clientMessageId, version, version]);
      }
      return true;
    });
  }

  async publishMessage(messageId: number): Promise<ChatTurnDisplayVersion | null> {
    return databaseCoordinator.transaction({ name: 'chat.publish-segment', feature: 'chat', priority: 'interactive' }, async tx => {
      const item = await tx.getFirstAsync<{ run_id: string; version: number; snapshot_json: string }>(`SELECT i.run_id, i.version, i.snapshot_json FROM chat_turn_display_items i
        JOIN chat_turn_presentations p ON p.run_id = i.run_id WHERE i.message_id = ? AND p.state = 'open'`, [messageId]);
      if (!item) return null;
      await tx.runAsync(`UPDATE chat_turn_display_items SET shown_version = version, shown_json = snapshot_json WHERE message_id = ?`, [messageId]);
      await tx.runAsync(completePresentationSql, [new Date().toISOString(), item.run_id, item.run_id, item.run_id]);
      return { version: item.version, snapshot: JSON.parse(item.snapshot_json) };
    });
  }

  async complete(runId: string): Promise<boolean> {
    const result = await databaseCoordinator.openTaskExecutor({ name: 'chat.complete-presentation', feature: 'chat', priority: 'interactive' }).runAsync(
      completePresentationSql,
      [new Date().toISOString(), runId, runId, runId],
    );
    return result.changes === 1;
  }

  async listPublishedMessageIds(runIds: readonly string[]): Promise<number[]> {
    const rows = await databaseCoordinator.openTaskExecutor({ name: 'chat.published-message-ids', feature: 'chat', priority: 'interactive' })
      .getAllAsync<{ message_id: number }>(`SELECT message_id FROM chat_turn_display_items
        WHERE run_id IN (SELECT value FROM json_each(?)) AND message_id IS NOT NULL AND shown_json IS NOT NULL`, [JSON.stringify(runIds)]);
    return rows.map(row => row.message_id);
  }

  async listHistory(sessionId: string, window?: ChatTurnPresentationWindow): Promise<ChatTurnPresentationHistory[]> {
    return databaseCoordinator.read({ name: 'chat.presentation-history', feature: 'chat', priority: 'interactive' }, async db => {
      const runs = await db.getAllAsync<{ run_id: string; kind: ChatTurnPresentationHistory['kind']; state: ChatTurnPresentationHistory['state']; reason: string | null; execution_status: string; created_at: string }>(
        `SELECT p.run_id, r.kind, p.state, p.reason, r.status AS execution_status, r.created_at FROM chat_turn_presentations p
           JOIN conversation_turn_runs r ON r.run_id = p.run_id JOIN sessions s ON s.id = p.session_id
           LEFT JOIN messages origin ON r.kind = 'autonomous' AND origin.session_id = r.session_id
             AND origin.client_message_id = 'agent_activity:' || r.run_id || ':started'
           WHERE p.session_id = ? AND CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END > COALESCE(s.visible_after_message_id, 0)
           AND (CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END >= ? OR r.run_id IN (SELECT value FROM json_each(?)))
         ORDER BY r.created_at, r.run_id`, [sessionId, window?.fromMessageId ?? 0, JSON.stringify(window?.runIds ?? [])]);
      const rows = await db.getAllAsync<{ run_id: string; shown_version: number; shown_json: string }>(
        `SELECT run_id, shown_version, shown_json FROM chat_turn_display_items
         WHERE run_id IN (SELECT value FROM json_each(?)) AND shown_json IS NOT NULL AND (message_id IS NULL
           OR json_extract(shown_json, '$.text') <> json_extract(snapshot_json, '$.text')) ORDER BY identity`,
        [JSON.stringify(runs.map(run => run.run_id))]);
      const itemsByRun = new Map<string, ChatTurnDisplayVersion[]>();
      for (const row of rows) {
        const items = itemsByRun.get(row.run_id) ?? [];
        items.push({ version: row.shown_version, snapshot: JSON.parse(row.shown_json) });
        itemsByRun.set(row.run_id, items);
      }
      return runs.map(run => ({ runId: run.run_id, kind: run.kind, state: run.state, reason: run.reason,
          committed: run.execution_status === 'committed', createdAt: run.created_at,
          items: itemsByRun.get(run.run_id) ?? [] }));
    });
  }

  async listOpenRunIds(sessionId: string): Promise<string[]> {
    const rows = await databaseCoordinator.openTaskExecutor({ name: 'chat.open-display-ids', feature: 'chat', priority: 'interactive' })
      .getAllAsync<{ run_id: string }>(`SELECT run_id FROM chat_turn_presentations WHERE session_id = ? AND state = 'open'`, [sessionId]);
    return rows.map(row => row.run_id);
  }

  async listInterruptedContext(sessionId: string, fromInputId: number, toInputId?: number): Promise<ChatInterruptedTurnContext[]> {
    const rows = await databaseCoordinator.openTaskExecutor({ name: 'chat.interrupted-context', feature: 'chat', priority: 'runtime' })
      .getAllAsync<{ run_id: string; input_high_watermark: number; created_at: string; shown_json: string }>(
        `WITH context_runs AS (
           SELECT r.rowid AS run_order, r.*, CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END AS context_anchor_id
           FROM conversation_turn_runs r
           LEFT JOIN messages origin ON r.kind = 'autonomous' AND origin.session_id = r.session_id
             AND origin.client_message_id = 'agent_activity:' || r.run_id || ':started'
         ) SELECT r.run_id, r.context_anchor_id AS input_high_watermark, r.created_at,
           CASE WHEN json_extract(i.snapshot_json, '$.kind') = 'tool' THEN i.snapshot_json ELSE i.shown_json END AS shown_json
         FROM context_runs r
         JOIN chat_turn_presentations p ON p.run_id = r.run_id JOIN chat_turn_display_items i ON i.run_id = r.run_id
         JOIN sessions s ON s.id = r.session_id
         WHERE r.session_id = ? AND ((r.kind = 'user_reply' AND r.status IN ('superseded', 'cancelled', 'failed'))
             OR (r.kind = 'autonomous' AND p.state = 'interrupted'))
           AND r.context_anchor_id >= ? AND r.context_anchor_id > COALESCE(s.visible_after_message_id, 0)
           AND (? IS NULL OR r.context_anchor_id < ?) AND i.shown_json IS NOT NULL
           AND json_extract(i.shown_json, '$.kind') <> 'reasoning'
         ORDER BY r.created_at, r.run_order, json_extract(i.shown_json, '$.sequence'), json_extract(i.shown_json, '$.segmentIndex')`,
        [sessionId, fromInputId, toInputId ?? null, toInputId ?? null]);
    const contexts = new Map<string, ChatInterruptedTurnContext & { items: ChatTurnDisplaySnapshot[] }>();
    for (const row of rows) {
      const snapshot: ChatTurnDisplaySnapshot = JSON.parse(row.shown_json);
      let context = contexts.get(row.run_id);
      if (!context) {
        context = { runId: row.run_id, inputHighWatermark: row.input_high_watermark, createdAt: row.created_at, items: [] };
        contexts.set(row.run_id, context);
      }
      context.items.push(snapshot);
    }
    return [...contexts.values()];
  }

  async interruptOrphans(activeRunIds: readonly string[]): Promise<void> {
    await databaseCoordinator.openTaskExecutor({ name: 'chat.interrupt-orphan-displays', feature: 'chat', priority: 'runtime' }).runAsync(
      `UPDATE chat_turn_presentations SET state = 'interrupted', reason = 'process_restarted', updated_at = ?
       WHERE state = 'open' AND run_id NOT IN (SELECT value FROM json_each(?))`,
      [new Date().toISOString(), JSON.stringify(activeRunIds)]);
  }

  async interrupt(runId: string, reason: string): Promise<void> {
    await databaseCoordinator.openTaskExecutor({ name: 'chat.interrupt-display', feature: 'chat', priority: 'interactive' }).runAsync(
      `UPDATE chat_turn_presentations SET state = 'interrupted', reason = ?, updated_at = ? WHERE run_id = ? AND state = 'open'`,
      [reason, new Date().toISOString(), runId]);
  }
}

export const chatTurnPresentationRepository = new ChatTurnPresentationRepository();
