import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import type { CallHistoryEntry, CallHistoryRecord, CallHistoryImage, CallHistoryPage, CallHistoryPageEntry } from '../domain/CallHistory';
import { formatCallHistoryTitle } from '../domain/CallHistory';

const RECORD_COLUMNS = `h.call_id AS callId, h.assistant_id AS assistantId, h.title,
  COALESCE(c.started_at, c.created_at) AS startedAt, c.ended_at AS endedAt, c.active_mode AS mediaMode`;
const COMPLETED_CALL = 'c.accepted_at IS NOT NULL AND c.ended_at IS NOT NULL';

/** 只将通话历史的已归档发言接入聊天搜索，权限和清除边界由 Calls 裁决。 */
export function buildCallTranscriptSearch(input: { conversationId: string; keywords: string[]; from?: string; to?: string }, assistantId?: string) {
  const conditions = ['c.chat_session_id = ?', COMPLETED_CALL, 'e.created_at > COALESCE(s.visible_after_at, \'\')',
    '(' + input.keywords.map(() => 'instr(lower(e.text), lower(?)) > 0').join(' OR ') + ')'];
  const params = [input.conversationId, ...input.keywords];
  if (assistantId !== undefined) { conditions.push('h.assistant_id = ?'); params.push(assistantId); }
  if (input.from !== undefined) { conditions.push('julianday(e.created_at) >= julianday(?)'); params.push(input.from); }
  if (input.to !== undefined) { conditions.push('julianday(e.created_at) <= julianday(?)'); params.push(input.to); }
  const assistantName = assistantId === undefined ? 'COALESCE(a.nickname, a.name, \'AI\')' : "COALESCE(a.name, 'AI')";
  return {
    sql: `SELECT NULL, h.call_id, e.id, e.created_at, e.text,
      CASE WHEN e.speaker = 'user' THEN 'user' ELSE 'assistant' END,
      CASE WHEN e.speaker = 'user' THEN '用户' ELSE ${assistantName} END,
      CASE WHEN e.speaker = 'user' THEN NULL ELSE h.assistant_id END
      FROM call_sessions c JOIN call_history h ON h.call_id = c.id
      JOIN call_history_entries e ON e.call_id = h.call_id JOIN sessions s ON s.id = c.chat_session_id
      LEFT JOIN ai_assistants a ON a.id = h.assistant_id WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

export class SQLiteCallHistoryRepository {
  protected async createHistoryInTransaction(tx: DatabaseTransactionExecutor, callId: string, assistantId: string, startedAt: string): Promise<void> {
    const base = formatCallHistoryTitle(startedAt);
    let title = base;
    let suffix = 2;
    // 与用户自定义标题共用唯一约束；同一事务内分配默认名，不在 UI 猜测重名。
    while (await tx.getFirstAsync('SELECT 1 FROM call_history WHERE assistant_id = ? AND title = ?', [assistantId, title])) {
      title = `${base} (${suffix++})`;
    }
    await tx.runAsync('INSERT INTO call_history (call_id, assistant_id, title) VALUES (?, ?, ?)', [callId, assistantId, title]);
  }

  listHistory(assistantId: string): Promise<CallHistoryRecord[]> {
    return databaseCoordinator.read({ name: 'calls.history-list', feature: 'calls', priority: 'interactive' }, db =>
      db.getAllAsync<CallHistoryRecord>(`SELECT ${RECORD_COLUMNS} FROM call_history h JOIN call_sessions c ON c.id = h.call_id
        WHERE h.assistant_id = ? AND c.accepted_at IS NOT NULL AND c.ended_at IS NOT NULL
        ORDER BY COALESCE(c.started_at, c.created_at) DESC, c.id DESC`, [assistantId]));
  }

  getHistory(callId: string, assistantId: string): Promise<CallHistoryRecord | null> {
    return databaseCoordinator.read({ name: 'calls.history-record', feature: 'calls', priority: 'interactive' }, db =>
      db.getFirstAsync<CallHistoryRecord>(`SELECT ${RECORD_COLUMNS} FROM call_history h JOIN call_sessions c ON c.id = h.call_id
        WHERE h.call_id = ? AND h.assistant_id = ? AND c.accepted_at IS NOT NULL AND c.ended_at IS NOT NULL`, [callId, assistantId]));
  }

  async readHistoryPage(callId: string, assistantId: string, offset: number): Promise<CallHistoryPage | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'calls.readHistoryPage', feature: 'calls', priority: 'runtime' });
    return db.withExclusiveTransactionAsync(async tx => {
      const call = await tx.getFirstAsync<CallHistoryRecord & { visibleAfter: string }>(
        `SELECT ${RECORD_COLUMNS}, COALESCE(s.visible_after_at, '') AS visibleAfter
          FROM call_history h JOIN call_sessions c ON c.id = h.call_id JOIN sessions s ON s.id = c.chat_session_id
          WHERE h.call_id = ? AND h.assistant_id = ? AND ${COMPLETED_CALL}
            AND c.ended_at > COALESCE(s.visible_after_at, '')`, [callId, assistantId]);
      if (!call) return null;
      const { visibleAfter, ...record } = call;
      const rows = await tx.getAllAsync<CallHistoryPageEntry>(
        `WITH items AS (
          SELECT 'message' AS kind, id, created_at AS createdAt, speaker, text, NULL AS mediaAssetId, sequence
            FROM call_history_entries WHERE call_id = ? AND created_at > ?
          UNION ALL
          SELECT 'image', id, created_at, NULL, NULL, media_asset_id, NULL
            FROM call_history_images WHERE call_id = ? AND created_at > ?
        ) SELECT kind, id, createdAt, speaker, text, mediaAssetId
          FROM items ORDER BY createdAt, kind, sequence, id LIMIT 21 OFFSET ?`,
        [callId, visibleAfter, callId, visibleAfter, offset]);
      const entries = rows.slice(0, 20).map((row): CallHistoryPageEntry => {
        const { kind, id, createdAt } = row;
        return kind === 'message' ? { kind, id, createdAt, speaker: row.speaker, text: row.text }
          : { kind, id, createdAt, mediaAssetId: row.mediaAssetId };
      });
      return { call: record, entries, nextOffset: rows.length > 20 ? offset + 20 : null };
    });
  }

  listHistoryEntries(callId: string): Promise<CallHistoryEntry[]> {
    return databaseCoordinator.read({ name: 'calls.history-entries', feature: 'calls', priority: 'interactive' }, db =>
      db.getAllAsync<CallHistoryEntry>(`SELECT id, call_id AS callId, speaker, input_kind AS inputKind, text,
        media_asset_id AS mediaAssetId, duration_ms AS durationMs, created_at AS createdAt
        FROM call_history_entries WHERE call_id = ? ORDER BY sequence`, [callId]));
  }

  renameHistory(callId: string, assistantId: string, title: string): Promise<'saved' | 'duplicate' | 'missing'> {
    return databaseCoordinator.transaction({ name: 'calls.history-rename', feature: 'calls', priority: 'interactive' }, async tx => {
      const duplicate = await tx.getFirstAsync('SELECT 1 FROM call_history WHERE assistant_id = ? AND title = ? AND call_id <> ?', [assistantId, title, callId]);
      if (duplicate) return 'duplicate';
      const result = await tx.runAsync('UPDATE call_history SET title = ? WHERE call_id = ? AND assistant_id = ?', [title, callId, assistantId]);
      return result.changes === 1 ? 'saved' : 'missing';
    });
  }

  deleteHistory(callId: string, assistantId: string): Promise<string[]> {
    return databaseCoordinator.transaction({ name: 'calls.history-delete', feature: 'calls', priority: 'interactive' }, async tx => {
      const record = await tx.getFirstAsync(`SELECT 1 FROM call_history h JOIN call_sessions c ON c.id = h.call_id
        WHERE h.call_id = ? AND h.assistant_id = ? AND c.ended_at IS NOT NULL`, [callId, assistantId]);
      if (!record) throw new Error('通话记录不存在或通话尚未结束');
      const assets = await tx.getAllAsync<{ id: string }>(`SELECT media_asset_id AS id FROM call_history_entries WHERE call_id = ? AND media_asset_id IS NOT NULL
        UNION SELECT media_asset_id AS id FROM call_history_images WHERE call_id = ?`, [callId, callId]);
      await tx.runAsync('DELETE FROM call_history WHERE call_id = ?', [callId]);
      return assets.map(asset => asset.id);
    });
  }

  async appendHistoryEntry(input: Omit<CallHistoryEntry, 'mediaAssetId' | 'durationMs'>): Promise<void> {
    await databaseCoordinator.write({ name: 'calls.history-append', feature: 'calls', priority: 'interactive' }, tx => this.appendHistoryEntryInTransaction(tx, input));
  }

  protected async appendHistoryEntryInTransaction(tx: Pick<DatabaseTransactionExecutor, 'runAsync'>, input: Omit<CallHistoryEntry, 'mediaAssetId' | 'durationMs'>): Promise<void> {
    await tx.runAsync(`INSERT INTO call_history_entries (id, call_id, speaker, input_kind, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [input.id, input.callId, input.speaker, input.inputKind, input.text, input.createdAt]);
  }

  async attachHistoryAudio(tx: DatabaseTransactionExecutor, entryId: string, assetId: string, durationMs: number): Promise<void> {
    const result = await tx.runAsync('UPDATE call_history_entries SET media_asset_id = ?, duration_ms = ? WHERE id = ? AND media_asset_id IS NULL', [assetId, durationMs, entryId]);
    if (result.changes !== 1) throw new Error('通话记录已删除或音频已经保存');
  }

  getHistorySnapshotSaving(assistantId: string): Promise<boolean> {
    return databaseCoordinator.read({ name: 'calls.history-snapshot-preference', feature: 'calls', priority: 'interactive' }, async db => {
      const row = await db.getFirstAsync<{ enabled: number }>('SELECT save_snapshots AS enabled FROM call_history_preferences WHERE assistant_id = ?', [assistantId]);
      return row !== null && row.enabled === 1;
    });
  }

  async setHistorySnapshotSaving(assistantId: string, enabled: boolean): Promise<void> {
    await databaseCoordinator.write({ name: 'calls.history-snapshot-preference-save', feature: 'calls', priority: 'interactive' }, db =>
      db.runAsync(`INSERT INTO call_history_preferences (assistant_id, save_snapshots) VALUES (?, ?)
        ON CONFLICT(assistant_id) DO UPDATE SET save_snapshots = excluded.save_snapshots`, [assistantId, enabled ? 1 : 0]));
  }

  listHistoryImages(callId: string): Promise<CallHistoryImage[]> {
    return databaseCoordinator.read({ name: 'calls.history-images', feature: 'calls', priority: 'interactive' }, db =>
      db.getAllAsync<CallHistoryImage>(`SELECT id, call_id AS callId, media_asset_id AS mediaAssetId, created_at AS createdAt
        FROM call_history_images WHERE call_id = ? ORDER BY created_at, id`, [callId]));
  }

  async appendHistoryImage(tx: DatabaseTransactionExecutor, image: CallHistoryImage): Promise<void> {
    await tx.runAsync('INSERT INTO call_history_images (id, call_id, media_asset_id, created_at) VALUES (?, ?, ?, ?)',
      [image.id, image.callId, image.mediaAssetId, image.createdAt]);
  }

  deleteHistoryImage(imageId: string, callId: string, assistantId: string): Promise<string> {
    return databaseCoordinator.transaction({ name: 'calls.history-image-delete', feature: 'calls', priority: 'interactive' }, async tx => {
      const image = await tx.getFirstAsync<{ assetId: string }>(`SELECT i.media_asset_id AS assetId FROM call_history_images i
        JOIN call_history h ON h.call_id = i.call_id WHERE i.id = ? AND i.call_id = ? AND h.assistant_id = ?`, [imageId, callId, assistantId]);
      if (!image) throw new Error('截图不存在或已删除');
      await tx.runAsync('DELETE FROM call_history_images WHERE id = ?', [imageId]);
      return image.assetId;
    });
  }
}
