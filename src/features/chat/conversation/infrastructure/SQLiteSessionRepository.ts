/** 使用 SQLite 实现 canonical 单聊 conversation 仓储。 */

import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import type { ChatSession, ISessionRepository } from '../domain/SessionRepository';

interface SessionRow {
  id: string;
  ai_assistant_id: string;
  name: string;
  last_message: string | null;
  last_time: string | null;
  tags: string | null;
  is_pinned: number | null;
  pinned_at: string | null;
  visible_after_message_id: number | null;
  visible_after_at: string | null;
}

function createConversationId(now: Date): string {
  return `session_${now.getTime()}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatConversationName(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class SessionRepository implements ISessionRepository {
  async getCanonicalConversation(aiId: string): Promise<ChatSession | null> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.getCanonicalConversation', feature: 'chat', priority: 'interactive',
    });
    const row = await database.getFirstAsync<SessionRow>(
      'SELECT * FROM sessions WHERE ai_assistant_id = ? LIMIT 1', [aiId],
    );
    return row ? this.mapRow(row) : null;
  }

  async resolveCanonicalConversation(aiId: string, now = new Date()): Promise<ChatSession> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.resolveCanonicalConversation', feature: 'chat', priority: 'interactive',
    });
    return database.withExclusiveTransactionAsync(transaction => this.resolveCanonicalConversationInTransaction(transaction, aiId, now));
  }

  async resolveCanonicalConversationInTransaction(transaction: DatabaseTransactionExecutor, aiId: string, now: Date): Promise<ChatSession> {
    const existing = await transaction.getFirstAsync<SessionRow>(
      'SELECT * FROM sessions WHERE ai_assistant_id = ? LIMIT 1', [aiId],
    );
    return existing ? this.mapRow(existing) : this.createCanonicalConversation(transaction, aiId, now);
  }

  async getSession(sessionId: string): Promise<ChatSession | null> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.getSession', feature: 'chat', priority: 'interactive',
    });
    const row = await database.getFirstAsync<SessionRow>(
      'SELECT * FROM sessions WHERE id = ?', [sessionId],
    );
    return row ? this.mapRow(row) : null;
  }

  async clearConversationHistory(sessionId: string): Promise<string[]> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.clearConversationHistory', feature: 'chat', priority: 'interactive',
    });
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const session = await transaction.getFirstAsync<{ id: string }>(
        'SELECT id FROM sessions WHERE id = ?', [sessionId],
      );
      if (!session) {
        throw new Error(`Canonical conversation 不存在：${sessionId}`);
      }
      // 收集真正删除的引用，包含已隐藏原文和未采用的重写版本；文件释放在 commit 后裁决。
      const assets = await transaction.getAllAsync<{ asset_id: string }>(
        `WITH snapshots AS (
          SELECT metadata_json AS body FROM messages WHERE session_id = ?
          UNION ALL SELECT v.snapshot_json FROM chat_reply_versions v
            JOIN chat_reply_version_sets s ON s.id = v.set_id WHERE s.session_id = ?
        ) SELECT DISTINCT TRIM(CAST(tree.value AS TEXT)) AS asset_id
          FROM snapshots, json_tree(CASE WHEN json_valid(body) THEN body END) tree
          WHERE tree.type = 'text' AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
            AND TRIM(CAST(tree.value AS TEXT)) <> ''`,
        [sessionId, sessionId],
      );
      await transaction.runAsync('DELETE FROM chat_regeneration_requests WHERE session_id = ?', [sessionId]);
      const clearedAt = new Date().toISOString();
      // 撤销旧回合的持久资格，迟到的模型结果和宿主回执不能让已清除的聊天复活。
      await transaction.runAsync(`UPDATE conversation_turn_runs
        SET status = 'cancelled', terminal_reason = 'history_cleared', terminal_at = ?
        WHERE session_id = ? AND status = 'active'`, [clearedAt, sessionId]);
      await transaction.runAsync(`UPDATE conversation_turn_state
        SET active_run_id = NULL, active_run_kind = NULL, revision = revision + 1,
            reply_requested = 0, summon_requested = 0,
            host_request_revision = host_request_revision + 1, host_request_input_id = NULL,
            host_request_status = NULL, host_request_at = NULL, updated_at = ?
        WHERE session_id = ?`, [clearedAt, sessionId]);
      await transaction.runAsync('DELETE FROM chat_turn_presentations WHERE session_id = ?', [sessionId]);
      await transaction.runAsync('DELETE FROM chat_reply_version_sets WHERE session_id = ?', [sessionId]);
      // 不删除 conversation 身份；摘要与记忆空间由各自 owner 保留，固定起点由外键取消。
      await transaction.runAsync('DELETE FROM messages WHERE session_id = ?', [sessionId]);
      // 通话记录属于 Calls，仍按事件时间切断旧聊天上下文；跨清除时刻的新事件照常可见。
      await transaction.runAsync(
        `UPDATE sessions
         SET visible_after_message_id = NULL, visible_after_at = ?, last_message = '',
             last_time = NULL, updated_at = ?
         WHERE id = ?`,
        [clearedAt, clearedAt, sessionId],
      );
      return assets.map(row => row.asset_id);
    });
  }

  async setConversationPinned(sessionId: string, pinned: boolean): Promise<ChatSession | null> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.setConversationPinned', feature: 'chat', priority: 'interactive',
    });
    // 取消置顶必须把 pinned_at 一起清空：否则「刚刚置顶过」会继续影响排序。
    // 置顶是列表排序行为，不是消息活动，因此不触碰 last_message / last_time。
    const pinnedAt = pinned ? new Date().toISOString() : null;
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE sessions SET is_pinned = ?, pinned_at = ? WHERE id = ?`,
        [pinned ? 1 : 0, pinnedAt, sessionId],
      );
      if (result.changes === 0) {
        return null;
      }

      const row = await transaction.getFirstAsync<SessionRow>(
        'SELECT * FROM sessions WHERE id = ?', [sessionId],
      );
      return row ? this.mapRow(row) : null;
    });
  }

  private async createCanonicalConversation(
    transaction: DatabaseTransactionExecutor,
    aiId: string,
    now: Date,
  ): Promise<ChatSession> {
    const id = createConversationId(now);
    const timestamp = now.toISOString();
    const name = formatConversationName(now);
    await transaction.runAsync(`INSERT INTO chat_conversations (id, kind) VALUES (?, 'direct')`, [id]);
    // 新建 canonical conversation 只是身份创建，不代表已经发生聊天：
    // last_time 必须为 NULL（否则「第一次只是打开一个 AI」会让它虚假上浮，
    // 并且会覆盖 createdAt 回落语义）。created_at / updated_at 正常取当前时间。
    await transaction.runAsync(
      `INSERT INTO sessions (
         id, ai_assistant_id, name, last_message, last_time,
         tags, visible_after_message_id, visible_after_at, created_at, updated_at
       ) VALUES (?, ?, ?, '', NULL, '[]', NULL, NULL, ?, ?)`,
      [id, aiId, name, timestamp, timestamp],
    );
    return {
      id, aiAssistantId: aiId, name, tags: [], lastMessage: null, lastTime: null,
      isPinned: false, pinnedAt: null, visibleAfterMessageId: null, visibleAfterAt: null,
    };
  }

  private mapRow(row: SessionRow): ChatSession {
    return {
      id: row.id,
      aiAssistantId: row.ai_assistant_id,
      name: row.name,
      lastMessage: row.last_message,
      lastTime: row.last_time,
      isPinned: row.is_pinned === 1,
      pinnedAt: row.pinned_at ?? null,
      tags: row.tags ? JSON.parse(row.tags) : [],
      visibleAfterMessageId: row.visible_after_message_id,
      visibleAfterAt: row.visible_after_at,
    };
  }
}

export const sessionRepository = new SessionRepository();
