/** 通过 databaseCoordinator 实现聊天消息查询、分页、提交、已读与预览维护的 SQLite 仓储适配器。 */
import {
  databaseCoordinator,
  type DatabaseReadExecutor,
  type DatabaseTransactionExecutor,
} from '@platform/persistence';
import type {
  ChatMessage,
  CreateMessageInput,
  UpdateMessageInput,
  MessagePaginationParams,
  PaginatedMessages,
} from '../domain/ChatMessage';
import type {
  CommitMessageInput,
  CommitMessagesInput,
  ChatAttachmentMetadataCandidate,
  ChatTimelineAnchorRecord,
  CompareAndSwapMetadataJsonInput,
  DeleteMessagesWithMediaCandidatesResult,
  IMessageRepository,
  ListChatAttachmentMetadataCandidatesParams,
  UpsertStatefulTimelineEntryInput,
  UpsertStatefulTimelineEntryResult,
} from '../domain/MessageRepository';
import { CHAT_RECORD_STATISTICS_SQL, timelineOrderedMessagesCte, timelineProjectionOrderBy, timelineCursorCondition, type TimelineOrderRow } from './ChatTimelineSql';
import { shouldShowTimeSeparatorBefore } from '../domain/MessageTimeSeparator';
import { cancelRegenerationInTransaction } from './ChatMessageMutationSql';
import { deleteReplyVersionsForMessages, editSelectedReplyVersion } from '../../reply/infrastructure/ChatReplyVersionSql';
import type { ChatRecordStatistics } from '../domain/ChatRecordStatistics';
import type { ChatMessageRecord, ChatMessageSearchInput, ChatMessageSearchPage } from '../domain/ChatMessageSearch';
import type { ChatMessageContext, ChatMessageContextInput } from '../domain/ChatMessageContext';
import { buildGroupMentionModelText } from '../domain/chatMessageMetadata';

interface MessageRow {
  turn_presentation_state?: string;
  id: number;
  session_id: string;
  agent_id: string | null;
  text: string;
  is_me: number;
  sender_type: string;
  api_message_id: string | null;
  client_message_id: string | null;
  time: string;
  created_at: string;
  show_time_separator_before: number | null;
  updated_at: string | null;
  reply_to_id: number | null;
  reply_to_text: string | null;
  logical_message_id: string | null;
  segment_index: number | null;
  segment_total: number | null;
  delivery_status: ChatMessage['deliveryStatus'] | null;
  status: ChatMessage['status'];
  tokens_used: number;
  prompt_tokens: number;
  completion_tokens: number;
  metadata_json: string | null;
  is_read: number | null;
  voice_played_at: string | null;
  turn_run_id: string | null;
  turn_item_index: number | null;
}

interface MessageLookupRow extends MessageRow {
  owner_assistant_id: string | null;
  owner_name: string | null;
  owner_nickname: string | null;
}

// 搜索与附近上下文共用原文读取边界；摘要和近期窗口不改变仍保存的发言。
const MESSAGE_LOOKUP_VISIBILITY = `m.status = 'sent' AND m.sender_type IN ('user', 'assistant')
  AND m.delivery_status IS NOT 'cancelled' AND m.id > COALESCE(s.visible_after_message_id, 0)`;
const MESSAGE_LOOKUP_ACCESS = `(s.ai_assistant_id = ? OR EXISTS (SELECT 1 FROM group_chat_members member
  JOIN group_chats g ON g.id = member.group_id
  WHERE member.group_id = m.session_id AND member.ai_assistant_id = ? AND member.enabled = 1))`;
const MESSAGE_LOOKUP_JOINS = `LEFT JOIN sessions s ON s.id = m.session_id
  LEFT JOIN ai_assistants a ON a.id = s.ai_assistant_id`;


interface TimelineAnchorRow {
  id: number;
  session_id: string;
  turn_run_id: string;
}

interface RankedTimelineAnchorRow extends TimelineAnchorRow {
  timeline_order_created_at: string;
  timeline_order_anchor_id: number;
  timeline_order_item_index: number;
}



/**
 * metadata 引用写入前的 fail-closed 守卫（与 media lifecycle 的 release 裁决配对）。
 *
 * Chat 的媒体引用存放在 messages.metadata_json，不是数据库外键。因此 release 事务判定
 * 「该 asset 已无任何引用」并删除 media_assets 行之后，一个在更早时刻解析出 assetId 的写入
 * （典型：Sticker snapshot 先解析、消息后提交）仍可能提交出一条指向已消失 catalog 行的
 * dangling reference —— 业务事实还在、媒体字节已经没了。
 *
 * 因此任何携带媒体引用的 metadata 写入都必须在**写它的同一个事务**里确认目标 catalog 行
 * 仍存在：不存在就抛错 abort 整个事务，绝不落 dangling 事实。只做「删除 backing 前再查一次」
 * 无法消除这个窗口，因为复查之后仍然可能有新引用提交。
 *
 * 判据必须与 @features/media 的引用枚举（MEDIA_ASSET_REFERENCE_QUERY /
 * MEDIA_ASSET_CANDIDATE_UNREFERENCED_QUERY）保持一致：同一批 metadata key、同样的 TRIM
 * 非空要求。损坏 JSON 无法枚举可信引用，这里只在 json_valid = 1 时裁决；写入方不得制造
 * 损坏 metadata（所有权写入都经过 JSON.stringify）。
 */
const MISSING_MEDIA_ASSET_REFERENCE_QUERY = `
  SELECT DISTINCT TRIM(CAST(tree.value AS TEXT)) AS asset_id
  FROM json_tree(CASE WHEN json_valid(?) = 1 THEN ? ELSE NULL END) AS tree
  WHERE tree.type = 'text'
    AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
    AND TRIM(CAST(tree.value AS TEXT)) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM media_assets WHERE media_assets.id = TRIM(CAST(tree.value AS TEXT))
    )
`;

/**
 * metadata 引用了一个已经不在 media_assets 里的 asset id。
 *
 * 这是引用写入侧的 fail-closed 结果，不是可重试的并发冲突：候选 asset 已经被 release 事务
 * 确认无引用并删除，本次写入如果继续，只会留下无法解析的 dangling reference。
 */
export class MediaAssetReferenceMissingError extends Error {
  constructor(readonly assetIds: readonly string[]) {
    super(`消息 metadata 引用了不存在的 MediaAsset，引用写入必须 fail closed：${assetIds.join(', ')}`);
    this.name = 'MediaAssetReferenceMissingError';
  }
}

/**
 * 删除瞬间的媒体引用候选：只读取本次真正会被删除的消息行。
 *
 * 判据必须与 Media lifecycle 对 Chat metadata 的引用枚举保持一致，否则 targeted release
 * 会漏掉「随本次删除一起消失的真实引用」，把 catalog / backing 永久留在 orphan 状态。
 * 同一组谓词在本文件已经出现过一次（MISSING_MEDIA_ASSET_REFERENCE_QUERY，引用写入
 * fail-closed 守卫），media 侧的对应实现是 MEDIA_ASSET_REFERENCE_QUERY（引用枚举）与
 * CHAT_SESSION_MEDIA_ASSET_IDS_QUERY（级联删除候选），另有
 * MEDIA_ASSET_CANDIDATE_UNREFERENCED_QUERY 用同一 key 集做 release 裁决：
 *
 *   tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
 *   AND tree.type = 'text'
 *   AND TRIM(CAST(tree.value AS TEXT)) <> ''
 *
 * 附件、缩略图、语音、Sticker snapshot 都只是这组 key 的不同位置，因此不需要按
 * metadata kind 分别解析；改这组判据必须同步上面几处实现。
 *
 * 损坏 JSON（json_valid = 0）不产生候选：无法从中建立可信引用，也不能猜测；release 侧的
 * MEDIA_ASSET_CANDIDATE_UNREFERENCED_QUERY 会保守保留「原文包含该 asset id」的资产，
 * 所以这种输入既不会漏放行，也不会误释放。
 */
const MESSAGE_MEDIA_ASSET_CANDIDATES_QUERY = `
  SELECT DISTINCT TRIM(CAST(tree.value AS TEXT)) AS asset_id
  FROM messages,
       json_tree(CASE
         WHEN json_valid(messages.metadata_json) = 1 THEN messages.metadata_json
         ELSE NULL
       END) AS tree
  WHERE messages.id IN ({{MESSAGE_IDS}})
    AND messages.metadata_json IS NOT NULL
    AND json_valid(messages.metadata_json) = 1
    AND tree.type = 'text'
    AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')
    AND TRIM(CAST(tree.value AS TEXT)) <> ''
  ORDER BY asset_id ASC
`;

/** 去重 message id：IN 查询的参数顺序必须稳定，重复 id 不能变成重复的删除条件。 */
function normalizeMessageIds(messageIds: readonly number[]): number[] {
  return [...new Set(messageIds)];
}

export class MessageRepository implements IMessageRepository {
  searchMessagesForUser(input: ChatMessageSearchInput): Promise<ChatMessageSearchPage> {
    return this.searchMessages(input);
  }

  async searchMessagesForAssistant(assistantId: string, input: ChatMessageSearchInput): Promise<ChatMessageSearchPage> {
    return this.searchMessages(input, assistantId);
  }

  private async searchMessages(input: ChatMessageSearchInput, assistantId?: string): Promise<ChatMessageSearchPage> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.searchMessages', feature: 'chat', priority: assistantId === undefined ? 'interactive' : 'runtime' });
    return db.withExclusiveTransactionAsync(async tx => {
      const conditions = [
        'm.session_id = ?', MESSAGE_LOOKUP_VISIBILITY,
        '(' + input.keywords.map(() => 'instr(lower(m.text), lower(?)) > 0').join(' OR ') + ')',
      ];
      const params: (string | number)[] = [input.conversationId, ...input.keywords];
      if (assistantId !== undefined) { conditions.push(MESSAGE_LOOKUP_ACCESS); params.push(assistantId, assistantId); }
      if (input.from !== undefined) { conditions.push('julianday(m.created_at) >= julianday(?)'); params.push(input.from); }
      if (input.to !== undefined) { conditions.push('julianday(m.created_at) <= julianday(?)'); params.push(input.to); }
      const offset = input.offset ?? 0;
      const rows = await tx.getAllAsync<MessageLookupRow>(
        `SELECT m.*, s.ai_assistant_id AS owner_assistant_id, a.name AS owner_name, a.nickname AS owner_nickname
         FROM chat_visible_messages m ${MESSAGE_LOOKUP_JOINS}
         WHERE ${conditions.join(' AND ')} ORDER BY julianday(m.created_at) DESC, m.id DESC LIMIT 21 OFFSET ?`,
        [...params, offset],
      );
      return {
        entries: await this.projectMessageLookupRows(tx, input.conversationId, rows.slice(0, 20), assistantId !== undefined),
        nextOffset: rows.length > 20 ? offset + 20 : null,
      };
    });
  }

  async readMessageContextForAssistant(assistantId: string, input: Required<ChatMessageContextInput>): Promise<ChatMessageContext | null> {
    return this.readMessageContext(input, { assistantId });
  }

  readMessageContextForUser(conversationId: string, input: Required<ChatMessageContextInput>): Promise<ChatMessageContext | null> {
    return this.readMessageContext(input, { conversationId });
  }

  private async readMessageContext(input: Required<ChatMessageContextInput>, scope: { assistantId: string } | { conversationId: string }): Promise<ChatMessageContext | null> {
    const forAssistant = 'assistantId' in scope;
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.messageContext', feature: 'chat', priority: forAssistant ? 'runtime' : 'interactive' });
    return db.withExclusiveTransactionAsync(async tx => {
      const anchor = await tx.getFirstAsync<MessageLookupRow & TimelineOrderRow>(
        `${timelineOrderedMessagesCte('m.id = ?')}
         SELECT m.*, s.ai_assistant_id AS owner_assistant_id, a.name AS owner_name, a.nickname AS owner_nickname
         FROM ordered_messages m ${MESSAGE_LOOKUP_JOINS}
         WHERE ${MESSAGE_LOOKUP_VISIBILITY} AND ${forAssistant ? MESSAGE_LOOKUP_ACCESS : 'm.session_id = ?'}`,
        forAssistant ? [input.messageId, scope.assistantId, scope.assistantId] : [input.messageId, scope.conversationId],
      );
      if (!anchor) return null;
      // 锚点已在同一事务裁决权限；邻居只读取这个会话，不重复校验或猜测相邻 ID。
      const readNeighbors = (order: 'ASC' | 'DESC', count: number) => {
        const cursor = timelineCursorCondition(order, anchor);
        return tx.getAllAsync<MessageLookupRow>(
          `${timelineOrderedMessagesCte('m.session_id = ?')}
           SELECT m.*, s.ai_assistant_id AS owner_assistant_id, a.name AS owner_name, a.nickname AS owner_nickname
           FROM (SELECT * FROM ordered_messages WHERE ${cursor.sql}) m ${MESSAGE_LOOKUP_JOINS}
           WHERE ${MESSAGE_LOOKUP_VISIBILITY}
           ORDER BY ${timelineProjectionOrderBy(order, 'm')} LIMIT ?`,
          [anchor.session_id, ...cursor.params, count + 1],
        );
      };
      const before = await readNeighbors('DESC', input.before);
      const after = await readNeighbors('ASC', input.after);
      return {
        anchorMessageId: anchor.id,
        conversationId: anchor.session_id,
        entries: await this.projectMessageLookupRows(tx, anchor.session_id,
          [...before.slice(0, input.before).reverse(), anchor, ...after.slice(0, input.after)], forAssistant),
        hasMoreBefore: before.length > input.before,
        hasMoreAfter: after.length > input.after,
      };
    });
  }

  private async projectMessageLookupRows(tx: DatabaseReadExecutor, conversationId: string, rows: MessageLookupRow[], forAssistant: boolean): Promise<ChatMessageRecord[]> {
    if (rows.length === 0) return [];
    const members = await tx.getAllAsync<{ aiAssistantId: string; agentId: string; name: string; nickname: string | null }>(
      `SELECT member.ai_assistant_id AS aiAssistantId, member.agent_id AS agentId, a.name, a.nickname
       FROM group_chat_members member JOIN ai_assistants a ON a.id = member.ai_assistant_id WHERE member.group_id = ?`,
      [conversationId],
    );
    return rows.map(row => {
      const member = members.find(candidate => candidate.agentId === row.agent_id);
      const publicName = member?.name ?? row.owner_name ?? 'AI';
      const displayName = (member ? member.nickname : row.owner_nickname) ?? publicName;
      return {
        messageId: row.id, conversationId: row.session_id,
        author: {
          role: row.sender_type as 'user' | 'assistant',
          name: row.is_me === 1 ? '用户' : forAssistant ? publicName : displayName,
          assistantId: row.is_me === 1 ? null : member?.aiAssistantId ?? row.owner_assistant_id,
        },
        text: forAssistant ? buildGroupMentionModelText(row.text, { metadataJson: row.metadata_json }, members) : row.text,
        createdAt: row.created_at,
      };
    });
  }

  async listAgentActivityEvidence(runIds: readonly string[]) {
    const rows = await databaseCoordinator.openTaskExecutor({
      name: 'chat.agent-activity-evidence', feature: 'chat', priority: 'interactive',
    }).getAllAsync<{ run_id: string; responded_at: string | null; terminal_code: string | null }>(
      `WITH legacy AS (SELECT turn_run_id AS run_id,
              MIN(CASE WHEN json_extract(metadata_json, '$.phase') = 'responded'
                         OR (json_extract(metadata_json, '$.phase') IN ('reasoning', 'assistant') AND length(text) > 0)
                         OR json_extract(metadata_json, '$.type') = 'toolStatus'
                       THEN created_at END) AS responded_at,
              MAX(CASE WHEN json_extract(metadata_json, '$.phase') = 'terminal'
                       THEN json_extract(metadata_json, '$.terminalCode') END) AS terminal_code
       FROM messages WHERE turn_run_id IN (SELECT value FROM json_each(?))
         AND json_valid(metadata_json) AND json_extract(metadata_json, '$.type') IN ('agentActivity', 'toolStatus')
       GROUP BY turn_run_id), current_runs AS (
         SELECT r.run_id,
           (SELECT MIN(json_extract(i.shown_json, '$.createdAt')) FROM chat_turn_display_items i
             WHERE i.run_id = r.run_id AND i.shown_json IS NOT NULL
               AND length(json_extract(i.shown_json, '$.text')) > 0) AS responded_at,
           CASE WHEN r.status IN ('superseded', 'cancelled') THEN 'CANCELLED_BY_USER'
             WHEN p.state = 'interrupted' THEN CASE WHEN p.reason IN ('process_restarted', 'execution_interrupted', 'new_input')
               THEN 'INTERRUPTED' ELSE p.reason END
             WHEN r.status = 'failed' THEN 'INTERRUPTED'
             WHEN r.status = 'committed' AND p.state = 'completed' THEN 'COMPLETED'
             ELSE NULL END AS terminal_code
         FROM conversation_turn_runs r JOIN chat_turn_presentations p ON p.run_id = r.run_id
         WHERE r.kind = 'autonomous' AND r.run_id IN (SELECT value FROM json_each(?))
       ) SELECT * FROM current_runs UNION ALL SELECT * FROM legacy
         WHERE NOT EXISTS (SELECT 1 FROM current_runs c WHERE c.run_id = legacy.run_id)`,
      [JSON.stringify(runIds), JSON.stringify(runIds)],
    );
    return rows.map((row) => ({ runId: row.run_id, respondedAt: row.responded_at, terminalCode: row.terminal_code }));
  }

  async interruptInactiveAgentActivities(activeRunIds: readonly string[], occurredAt: string): Promise<string[]> {
    return databaseCoordinator.openTaskExecutor({
      name: 'chat.interrupt-agent-activities', feature: 'chat', priority: 'interactive',
    }).withExclusiveTransactionAsync(async (tx) => {
      const starts = await tx.getAllAsync<MessageRow>(
        `SELECT m.* FROM messages m
         WHERE json_valid(m.metadata_json) AND json_extract(m.metadata_json, '$.type') = 'agentActivity'
           AND json_extract(m.metadata_json, '$.phase') = 'started'
           AND NOT EXISTS (SELECT 1 FROM chat_turn_presentations p WHERE p.run_id = m.turn_run_id)
           AND m.turn_run_id NOT IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM messages t WHERE t.turn_run_id = m.turn_run_id
             AND json_valid(t.metadata_json) AND json_extract(t.metadata_json, '$.type') = 'agentActivity'
             AND json_extract(t.metadata_json, '$.phase') = 'terminal')`,
        [JSON.stringify(activeRunIds)],
      );
      for (const row of starts) {
        const start = this.mapRowToEntity(row);
        const order = await tx.getFirstAsync<{ next_index: number }>(
          'SELECT COALESCE(MAX(turn_item_index), 0) + 1 AS next_index FROM messages WHERE turn_run_id = ?', [start.turnRunId!],
        );
        // 中断只改变状态，已经收到的正文原样保存；不宣称未完成工具已经成功。
        await tx.runAsync(
          `UPDATE messages SET status = 'failed', metadata_json = CASE
             WHEN json_extract(metadata_json, '$.type') = 'toolStatus'
             THEN json_set(metadata_json, '$.status', 'failed', '$.displayText', text || '（执行因故障中断）')
             ELSE metadata_json END
           WHERE turn_run_id = ? AND status = 'streaming'`, [start.turnRunId!],
        );
        await this.commitMessagesInTransaction(tx, { previewText: null, messages: [{
          ...start, text: '自主行动 · 执行因故障中断', createdAt: occurredAt,
          time: new Date(occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
          status: 'sent', isRead: true,
          clientMessageId: `agent_activity:${start.turnRunId}:terminal`, turnItemIndex: order!.next_index,
          metadataJson: JSON.stringify({ ...JSON.parse(start.metadataJson!), phase: 'terminal', terminalCode: 'INTERRUPTED' }),
        }] });
      }
      return [...new Set(starts.map((row) => row.session_id))];
    });
  }

  async getChatRecordStatistics(sessionId: string): Promise<ChatRecordStatistics> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getChatRecordStatistics', feature: 'chat', priority: 'interactive' });
    const row = await db.getFirstAsync<ChatRecordStatistics>(CHAT_RECORD_STATISTICS_SQL, [sessionId]);
    if (!row) throw new Error('聊天统计聚合未返回结果');
    return row;
  }

  async rebaseRestoredMediaInTransaction(transaction: DatabaseTransactionExecutor, rebase: (uri: string | null) => string | null): Promise<void> {
    let cursor = 0;
    for (;;) {
      const rows = await transaction.getAllAsync<{ id: number; metadata_json: string }>(
        'SELECT id, metadata_json FROM messages WHERE id > ? AND json_valid(metadata_json) = 1 ORDER BY id LIMIT 250', [cursor],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const metadata = JSON.parse(row.metadata_json);
        if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.attachments)) continue;
        let changed = false;
        for (const attachment of metadata.attachments) {
          if (!attachment || typeof attachment !== 'object' || typeof attachment.mediaAssetId === 'string') continue;
          for (const field of ['localUri', 'thumbnailUri']) {
            if (typeof attachment[field] !== 'string') continue;
            const uri = rebase(attachment[field]);
            if (uri !== attachment[field]) { attachment[field] = uri; changed = true; }
          }
        }
        if (changed) await transaction.runAsync('UPDATE messages SET metadata_json = ? WHERE id = ?', [JSON.stringify(metadata), row.id]);
      }
      cursor = rows[rows.length - 1].id;
    }
  }
  async getMessageById(messageId: number): Promise<ChatMessage | null> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getMessageById', feature: 'chat', priority: 'interactive' });
      const row = await db.getFirstAsync<MessageRow>('SELECT * FROM chat_visible_messages WHERE id = ?', [messageId]);

      if (!row) return null;
      return this.mapRowToEntity(row);
    } catch (error) {
      console.error('[MessageRepository] Failed to get message by id:', error);
      return null;
    }
  }

  async getMessageByClientMessageId(
    sessionId: string,
    clientMessageId: string
  ): Promise<ChatMessage | null> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getMessageByClientMessageId', feature: 'chat', priority: 'interactive' });
      const row = await db.getFirstAsync<MessageRow>(
        `SELECT * FROM chat_visible_messages
         WHERE session_id = ? AND client_message_id = ?
         LIMIT 1`,
        [sessionId, clientMessageId]
      );

      return row ? this.mapRowToEntity(row) : null;
    } catch (error) {
      console.error('[MessageRepository] Failed to get message by client message id:', error);
      return null;
    }
  }

  async getMessages(sessionId: string, params: MessagePaginationParams): Promise<PaginatedMessages> {
    const { limit, cursor, order = 'DESC', priority = 'interactive' } = params;

    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getMessages', feature: 'chat', priority });
    const normalizedOrder = order === 'ASC' ? 'ASC' : 'DESC';
    const orderedMessagesCte = timelineOrderedMessagesCte(
      `m.session_id = ?
       AND m.id > COALESCE((
         SELECT visible_after_message_id FROM sessions WHERE id = m.session_id
       ), 0)`,
      'keys',
    );

    let whereClause = 'WHERE 1 = 1';
    const queryParams: (string | number | null)[] = [];

    if (cursor !== null && cursor !== undefined) {
      const cursorRow = await db.getFirstAsync<TimelineOrderRow>(
        `${orderedMessagesCte}
         SELECT timeline_order_created_at, timeline_order_anchor_id,
                timeline_order_item_index, id
         FROM ordered_messages
         WHERE id = ?
         LIMIT 1`,
        [sessionId, cursor]
      );

      if (!cursorRow) {
        throw new Error(`Message pagination cursor ${cursor} was not found in session ${sessionId}`);
      }

      const cursorCondition = timelineCursorCondition(normalizedOrder, cursorRow);
      whereClause += ` AND ${cursorCondition.sql}`;
      queryParams.push(...cursorCondition.params);
    }

    // 先用轻量排序键选出窗口，再取正文与 metadata，避免全历史大字段进入临时排序树。
    const rows = await db.getAllAsync<MessageRow>(
      `${orderedMessagesCte}
       , page AS MATERIALIZED (
         SELECT * FROM ordered_messages
         ${whereClause}
         ORDER BY ${timelineProjectionOrderBy(normalizedOrder)}
         LIMIT ?
       )
       SELECT m.* FROM page p
       JOIN chat_visible_messages m ON m.id = p.id
       ORDER BY ${timelineProjectionOrderBy(normalizedOrder, 'p')}`,
      [sessionId, ...queryParams, limit + 1]
    );

    const hasMore = rows.length > limit;
    const messageRows = hasMore ? rows.slice(0, limit) : rows;
    const orderedMessageRows = normalizedOrder === 'ASC' ? messageRows : [...messageRows].reverse();
    const messages = orderedMessageRows.map((row) => this.mapRowToEntity(row));
    const boundaryMessage = normalizedOrder === 'ASC'
      ? messages[messages.length - 1]
      : messages[0];

    if (hasMore && !boundaryMessage) {
      throw new Error('Message pagination produced hasMore without a boundary message');
    }

    return {
      messages,
      hasMore,
      nextCursor: hasMore ? boundaryMessage.id : null,
    };
  }

  async getRecentPreviewMessages(sessionId: string, limit: number, excludedMessageIds: readonly number[]): Promise<ChatMessage[]> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getRecentPreviewMessages', feature: 'chat', priority: 'interactive' });
    const rows = await db.getAllAsync<MessageRow>(
      `${timelineOrderedMessagesCte(
        `m.session_id = ?
         AND m.id > COALESCE((SELECT visible_after_message_id FROM sessions WHERE id = m.session_id), 0)`,
      )}
       SELECT * FROM ordered_messages
       WHERE id NOT IN (SELECT value FROM json_each(?))
         AND sender_type NOT IN ('reasoning', 'tool')
         AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.type') END, '') NOT IN ('toolStatus', 'agentActivity')
       ORDER BY ${timelineProjectionOrderBy('DESC')}
       LIMIT ?`,
      [sessionId, JSON.stringify(excludedMessageIds), limit],
    );
    return rows.reverse().map((row) => this.mapRowToEntity(row));
  }

  async getReloadWindowMessages(sessionId: string, loadedMessageIds: readonly number[]): Promise<ChatMessage[]> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.reload-window', feature: 'chat', priority: 'interactive' });
    // 刷新保持页面已有的持久窗口。身份解析与读取共用一个 SQLite 快照，
    // 临时发送 ID 或已删除行不能把窗口边界推到库中不存在的位置。
    const orderedMessagesCte = timelineOrderedMessagesCte(
      `m.session_id = ? AND m.id > COALESCE((
        SELECT visible_after_message_id FROM sessions WHERE id = m.session_id
      ), 0)`,
    );
    const rows = await db.getAllAsync<MessageRow>(
      `${orderedMessagesCte}, loaded_window AS (
        SELECT MIN(id) AS start_id FROM ordered_messages
        WHERE id IN (SELECT value FROM json_each(?))
      )
      SELECT * FROM ordered_messages
      WHERE (SELECT start_id FROM loaded_window) IS NULL OR id >= (SELECT start_id FROM loaded_window)
      ORDER BY ${timelineProjectionOrderBy('DESC')}
      LIMIT CASE WHEN (SELECT start_id FROM loaded_window) IS NULL THEN 20 ELSE -1 END`,
      [sessionId, JSON.stringify(loadedMessageIds)],
    );
    return rows.reverse().map(row => this.mapRowToEntity(row));
  }

  async getNewerMessages(sessionId: string, afterId: number): Promise<ChatMessage[]> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getNewerMessages', feature: 'chat', priority: 'interactive' });
      // afterId 是实时同步的持久化 ID 高水位，不是时间线排序游标；
      // 新写入消息即使携带较早 createdAt，也必须先被抓取，再由内存集合排序归位。
      const orderedMessagesCte = timelineOrderedMessagesCte(
        `m.session_id = ? AND m.id > ?
         AND m.id > COALESCE((
           SELECT visible_after_message_id FROM sessions WHERE id = m.session_id
         ), 0)`,
      );
      const rows = await db.getAllAsync<MessageRow>(
        `${orderedMessagesCte}
         SELECT * FROM ordered_messages
         WHERE 1 = 1
         ORDER BY ${timelineProjectionOrderBy('ASC')}`,
        [sessionId, afterId]
      );

      return rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      console.error('[MessageRepository] Failed to get newer messages:', error);
      return [];
    }
  }

  /**
   * 按 run 行固定区间 (lowerExclusive, upperInclusive] 读取用户消息，id 升序。
   * 回合输入组装的唯一读取入口；不得临时改读 turn_state 的当前游标。
   */
  async listUserMessagesInRange(
    sessionId: string,
    lowerExclusive: number,
    upperInclusive: number
  ): Promise<ChatMessage[]> {
    const db = databaseCoordinator.openTaskExecutor({
      name: 'chat.list-user-messages-in-range',
      feature: 'chat',
      priority: 'interactive',
    });
    const rows = await db.getAllAsync<MessageRow>(
      `SELECT * FROM chat_visible_messages
       WHERE session_id = ?
         AND is_me = 1
         AND json_extract(metadata_json, '$.type') IS NOT 'callStatus'
         AND id > ? AND id <= ?
       ORDER BY id ASC`,
      [sessionId, lowerExclusive, upperInclusive]
    );

    return rows.map((row) => this.mapRowToEntity(row));
  }

  async getLatestMessage(sessionId: string): Promise<ChatMessage | null> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getLatestMessage', feature: 'chat', priority: 'interactive' });
      const row = await db.getFirstAsync<MessageRow>(
        `${timelineOrderedMessagesCte('m.session_id = ?')}
         SELECT * FROM ordered_messages
         WHERE 1 = 1
         ORDER BY ${timelineProjectionOrderBy('DESC')}
         LIMIT 1`,
        [sessionId]
      );

      if (!row) return null;
      return this.mapRowToEntity(row);
    } catch (error) {
      console.error('[MessageRepository] Failed to get latest message:', error);
      return null;
    }
  }

  async getLatestVisibleMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.readLatestVisibleMessage(sessionId, [], false);
  }

  async getLatestPreviewMessageInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string): Promise<ChatMessage | null> {
    return this.queryLatestVisibleMessage(transaction, sessionId, [], true);
  }

  async getMessagesInSelectionUnitInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string, selectionKey: string): Promise<ChatMessage[]> {
    const separator = selectionKey.indexOf(':');
    const kind = selectionKey.slice(0, separator);
    const identity = selectionKey.slice(separator + 1);
    let condition: string;
    if (kind === 'run') {
      condition = `sender_type <> 'user' AND COALESCE(NULLIF(turn_run_id, ''),
        CASE WHEN json_valid(metadata_json) THEN NULLIF(json_extract(metadata_json, '$.replyRunId'), '') END) = ?`;
    } else if (kind === 'logical') {
      condition = `sender_type <> 'user' AND logical_message_id = ?`;
    } else {
      condition = 'id = ?';
    }
    const rows = await transaction.getAllAsync<MessageRow>(
      `SELECT * FROM chat_visible_messages WHERE session_id = ? AND ${condition}
       AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.type') END, '')
         IN ('', 'toolStatus', 'agentActivity') ORDER BY id`,
      [sessionId, identity],
    );
    return rows.map((row) => this.mapRowToEntity(row));
  }

  async updateSessionPreviewInTransaction(transaction: DatabaseTransactionExecutor, sessionId: string, text: string, time: string | null): Promise<void> {
    await transaction.runAsync('UPDATE sessions SET last_message = ?, last_time = ? WHERE id = ?', [text, time, sessionId]);
  }

  async getLatestArrivedConversationPreview(sessionId: string, excludedMessageIds: readonly number[]): Promise<Pick<ChatMessage, 'text' | 'metadataJson' | 'createdAt'> | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.arrived-conversation-preview', feature: 'chat', priority: 'interactive' });
    // 只读 shown_json：通知已经交付的正文不能继续等待整轮 T3，也不能把未交付快照带进列表。
    // 两种来源在同一 SQLite 快照内选取，展示投影不回写持久预览或回复游标。
    // 来源消息按所属会话定位，使用已有的 (session_id, client_message_id) 索引；
    // 后续用户输入只取一次最高 ID，避免每条历史展示记录重复扫描消息。
    const row = await db.getFirstAsync<{ text: string; metadata_json: string | null; created_at: string }>(
      `${timelineOrderedMessagesCte(`m.session_id = ? AND m.id > COALESCE(
        (SELECT visible_after_message_id FROM sessions WHERE id = m.session_id), 0)`)}
       , canonical_preview AS (
         SELECT text, metadata_json, created_at, id AS anchor_id, 0 AS source_rank,
           COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.timelineSequence') END, 0) AS source_sequence,
           COALESCE(segment_index, 0) AS segment_index FROM ordered_messages
         WHERE id NOT IN (SELECT value FROM json_each(?)) AND sender_type NOT IN ('reasoning', 'tool')
           AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.type') END, '') NOT IN ('toolStatus', 'agentActivity')
         ORDER BY ${timelineProjectionOrderBy('DESC')} LIMIT 1
       ), display_preview AS (
         SELECT json_extract(i.shown_json, '$.text') AS text,
           json_extract(i.shown_json, '$.metadataJson') AS metadata_json,
           json_extract(i.shown_json, '$.createdAt') AS created_at,
           CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END AS anchor_id,
           1 AS source_rank, json_extract(i.shown_json, '$.sequence') AS source_sequence,
           COALESCE(json_extract(i.shown_json, '$.segmentIndex'), 0) AS segment_index
         FROM chat_turn_presentations p JOIN conversation_turn_runs r ON r.run_id = p.run_id
         JOIN chat_turn_display_items i ON i.run_id = p.run_id JOIN sessions s ON s.id = p.session_id
         LEFT JOIN messages origin ON origin.session_id = r.session_id AND r.kind = 'autonomous'
           AND origin.client_message_id = 'agent_activity:' || r.run_id || ':started'
         WHERE p.session_id = ? AND i.shown_json IS NOT NULL
           AND json_extract(i.shown_json, '$.kind') = 'assistant' AND json_extract(i.shown_json, '$.status') = 'sent'
           AND (r.kind <> 'regenerate' OR r.status = 'committed')
           AND CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END > COALESCE(s.visible_after_message_id, 0)
           AND CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END >= COALESCE((
             SELECT MAX(newer.id) FROM chat_visible_messages newer
             WHERE newer.session_id = ? AND newer.sender_type = 'user'
               AND COALESCE(CASE WHEN json_valid(newer.metadata_json) THEN json_extract(newer.metadata_json, '$.type') END, '') <> 'callStatus'
           ), 0)
         ORDER BY created_at DESC, anchor_id DESC, json_extract(i.shown_json, '$.sequence') DESC,
           json_extract(i.shown_json, '$.segmentIndex') DESC LIMIT 1
       ) SELECT text, metadata_json, created_at FROM (
         SELECT * FROM canonical_preview UNION ALL SELECT * FROM display_preview
       ) ORDER BY created_at DESC, source_sequence DESC, segment_index DESC, anchor_id DESC, source_rank DESC LIMIT 1`,
      [sessionId, JSON.stringify(excludedMessageIds), sessionId, sessionId],
    );
    return row ? { text: row.text, metadataJson: row.metadata_json, createdAt: row.created_at } : null;
  }

  private async readLatestVisibleMessage(sessionId: string, excludedMessageIds: readonly number[], previewOnly: boolean): Promise<ChatMessage | null> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getLatestVisibleMessage', feature: 'chat', priority: 'interactive' });
      return await this.queryLatestVisibleMessage(db, sessionId, excludedMessageIds, previewOnly);
    } catch (error) {
      console.error('[MessageRepository] Failed to get latest visible message:', error);
      return null;
    }
  }

  private async queryLatestVisibleMessage(db: Pick<DatabaseTransactionExecutor, 'getFirstAsync'>, sessionId: string, excludedMessageIds: readonly number[], previewOnly: boolean): Promise<ChatMessage | null> {
    // 与 getMessages 相同的可见边界口径：direct 会话按 sessions.visible_after_message_id
    // 过滤 clear 前历史；群聊 session_id 在 sessions 表无对应行，COALESCE 为 0 不过滤。
    const row = await db.getFirstAsync<MessageRow>(
      `${timelineOrderedMessagesCte(
        `m.session_id = ?
         AND m.id > COALESCE((
           SELECT visible_after_message_id FROM sessions WHERE id = m.session_id
         ), 0)`,
      )}
       SELECT * FROM ordered_messages
       WHERE id NOT IN (SELECT value FROM json_each(?))
         ${previewOnly ? `AND sender_type NOT IN ('reasoning', 'tool')
           AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.type') END, '') NOT IN ('toolStatus', 'agentActivity')` : ''}
       ORDER BY ${timelineProjectionOrderBy('DESC')}
       LIMIT 1`,
      [sessionId, JSON.stringify(excludedMessageIds)]
    );

    if (!row) return null;
    return this.mapRowToEntity(row);
  }

  /**
   * 查询消息段。
   *
   * @param executor - 可选的显式数据库执行器；Memory recovery 等后台工作流
   *                   必须传入自己的 maintenance executor，避免被标记为 interactive。
   */
  async getMessagesByLogicalMessageId(
    sessionId: string,
    logicalMessageId: string,
    executor?: DatabaseReadExecutor,
  ): Promise<ChatMessage[]> {
    const db = executor ?? databaseCoordinator.openTaskExecutor({ name: 'chat.getMessagesByLogicalMessageId', feature: 'chat', priority: 'interactive' });
    // 联删判断属于删除事务；SQL 失败必须使整笔删除回滚，不能伪装成没有关联消息。
    const rows = await db.getAllAsync<MessageRow>(
      `SELECT * FROM chat_visible_messages WHERE session_id = ? AND logical_message_id = ? ORDER BY segment_index ASC, id ASC`,
      [sessionId, logicalMessageId],
    );
    return rows.map((row) => this.mapRowToEntity(row));
  }

  /**
   * 按 relatedEntity 元数据定位最新一条已发送 assistant 消息 id。
   *
   * RavenCat 联系尝试的证据扫描：只读、单行查询。
   */
  async findSentAssistantMessageIdByRelatedEntity(
    relatedEntityType: string,
    relatedEntityId: string,
  ): Promise<number | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.findSentAssistantMessageIdByRelatedEntity', feature: 'chat', priority: 'runtime' });
    const row = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM chat_visible_messages
       WHERE sender_type = 'assistant'
         AND status = 'sent'
         AND metadata_json LIKE ?
         AND metadata_json LIKE ?
       ORDER BY id DESC LIMIT 1`,
      [
        `%"relatedEntityType":"${relatedEntityType}"%`,
        `%"relatedEntityId":"${relatedEntityId}"%`,
      ]
    );
    return row?.id ?? null;
  }

  async findFirstVisibleTimelineMessageByRunId(
    runId: string,
  ): Promise<ChatTimelineAnchorRecord | null> {
    const db = databaseCoordinator.openTaskExecutor({
      name: 'chat.findFirstVisibleTimelineMessageByRunId',
      feature: 'chat',
      priority: 'interactive',
    });
    const orderedMessagesCte = timelineOrderedMessagesCte(
      'm.turn_run_id = ?',
    );
    const row = await db.getFirstAsync<TimelineAnchorRow>(
      `${orderedMessagesCte}
       SELECT id, session_id, turn_run_id
       FROM ordered_messages
       ORDER BY ${timelineProjectionOrderBy('ASC')}
       LIMIT 1`,
      [runId],
    );

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      messageId: row.id,
      runId: row.turn_run_id,
    };
  }

  async findFirstVisibleTimelineAnchorsByRunIds(
    runIds: readonly string[],
  ): Promise<ChatTimelineAnchorRecord[]> {
    if (runIds.length === 0) {
      return [];
    }

    const uniqueRunIds = Array.from(new Set(runIds));
    const placeholders = uniqueRunIds.map(() => '?').join(', ');
    const db = databaseCoordinator.openTaskExecutor({
      name: 'chat.findFirstVisibleTimelineAnchorsByRunIds',
      feature: 'chat',
      priority: 'interactive',
    });
    const orderedMessagesCte = timelineOrderedMessagesCte(
      `m.turn_run_id IN (${placeholders})`,
    );
    const rows = await db.getAllAsync<RankedTimelineAnchorRow>(
      `${orderedMessagesCte}, ranked_messages AS (
         SELECT id, session_id, turn_run_id,
                timeline_order_created_at, timeline_order_anchor_id,
                timeline_order_item_index,
                ROW_NUMBER() OVER (
                  PARTITION BY turn_run_id
                  ORDER BY ${timelineProjectionOrderBy('ASC')}
                ) AS timeline_rank
         FROM ordered_messages
       )
       SELECT id, session_id, turn_run_id,
              timeline_order_created_at, timeline_order_anchor_id,
              timeline_order_item_index
       FROM ranked_messages
       WHERE timeline_rank = 1
       ORDER BY ${timelineProjectionOrderBy('ASC')}`,
      uniqueRunIds,
    );

    return rows.map((row) => ({
      sessionId: row.session_id,
      messageId: row.id,
      runId: row.turn_run_id,
    }));
  }

  async listChatAttachmentMetadataCandidates(
    params: ListChatAttachmentMetadataCandidatesParams,
  ): Promise<ChatAttachmentMetadataCandidate[]> {
    if (params.limit <= 0) {
      return [];
    }

    try {
      const db = databaseCoordinator.openTaskExecutor({
        name: 'chat.list-attachment-metadata-candidates',
        feature: 'chat',
        priority: 'maintenance',
      });
      const where: string[] = [
        'metadata_json IS NOT NULL',
        // 这里只筛扫描候选；JSON 解析和附件结构校验由 migration application 负责。
        `metadata_json LIKE '%"attachments"%'`,
        `metadata_json LIKE '%"localUri"%'`,
      ];
      const queryParams: (string | number | null)[] = [];
      if (params.afterMessageId !== null && params.afterMessageId !== undefined) {
        where.push('id > ?');
        queryParams.push(params.afterMessageId);
      }
      queryParams.push(params.limit);

      const rows = await db.getAllAsync<{
        id: number;
        session_id: string;
        metadata_json: string;
      }>(
        `SELECT id, session_id, metadata_json
         FROM chat_visible_messages
         WHERE ${where.join(' AND ')}
         ORDER BY id ASC
         LIMIT ?`,
        queryParams,
      );

      return rows.map((row) => ({
        messageId: row.id,
        sessionId: row.session_id,
        metadataJson: row.metadata_json,
      }));
    } catch (error) {
      console.error('[MessageRepository] Failed to list attachment metadata candidates:', error);
      // 迁移把空页解释为“扫描完成”；数据库读取失败必须向上暴露，不能静默
      // 把未扫描的数据伪装成已完成。
      throw error;
    }
  }

  async getMessageCount(sessionId: string): Promise<number> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getMessageCount', feature: 'chat', priority: 'interactive' });
      const result = await db.getFirstAsync<{ count?: number }>(
        'SELECT COUNT(*) as count FROM chat_visible_messages WHERE session_id = ?',
        [sessionId]
      );
      return result?.count || 0;
    } catch (error) {
      console.error('[MessageRepository] Failed to get message count:', error);
      return 0;
    }
  }

  async getUnreadCountByAI(aiId: string, excludedMessageIds: readonly number[] = []): Promise<number> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getUnreadCountByAI', feature: 'chat', priority: 'interactive' });
      const result = await db.getFirstAsync<{ count?: number }>(
        `SELECT COUNT(*) as count FROM (
         SELECT m.id
         FROM chat_visible_messages m
         INNER JOIN sessions s ON s.id = m.session_id
         LEFT JOIN chat_turn_display_items i ON i.message_id = m.id
         WHERE s.ai_assistant_id = ?
           AND m.is_me = 0
           AND m.sender_type = 'assistant'
           AND COALESCE(m.is_read, 0) = 0
           AND m.id > COALESCE(s.visible_after_message_id, 0)
           AND (m.id NOT IN (SELECT value FROM json_each(?))
             OR (json_extract(i.shown_json, '$.kind') = 'assistant' AND json_extract(i.shown_json, '$.status') = 'sent'))
         UNION ALL
         SELECT NULL FROM chat_turn_display_items i
         JOIN chat_turn_presentations p ON p.run_id = i.run_id
         JOIN conversation_turn_runs r ON r.run_id = p.run_id
         JOIN sessions s ON s.id = p.session_id
         LEFT JOIN messages origin ON origin.session_id = r.session_id AND r.kind = 'autonomous'
           AND origin.client_message_id = 'agent_activity:' || r.run_id || ':started'
         WHERE s.ai_assistant_id = ? AND i.message_id IS NULL AND i.is_read = 0
           AND json_extract(i.shown_json, '$.kind') = 'assistant' AND json_extract(i.shown_json, '$.status') = 'sent'
           AND (r.kind <> 'regenerate' OR r.status = 'committed')
           AND CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END > COALESCE(s.visible_after_message_id, 0)
         )`,
        [aiId, JSON.stringify(excludedMessageIds), aiId]
      );

      return result?.count || 0;
    } catch (error) {
      console.error('[MessageRepository] Failed to get unread count by AI:', error);
      return 0;
    }
  }

  async getUnreadCountByGroup(groupId: string, excludedMessageIds: readonly number[] = []): Promise<number> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.getUnreadCountByGroup', feature: 'chat', priority: 'interactive' });
      // 群消息的 session_id 即 groupId，不经 sessions 表 join。
      const result = await db.getFirstAsync<{ count?: number }>(
        `SELECT COUNT(*) as count
         FROM chat_visible_messages
         WHERE session_id = ?
           AND is_me = 0
           AND sender_type = 'assistant'
           AND COALESCE(is_read, 0) = 0
           AND id NOT IN (SELECT value FROM json_each(?))`,
        [groupId, JSON.stringify(excludedMessageIds)]
      );

      return result?.count || 0;
    } catch (error) {
      console.error('[MessageRepository] Failed to get unread count by group:', error);
      return 0;
    }
  }

  /**
   * 统一消息提交：在同一 exclusive transaction 中插入消息并使用最终 previewText 更新 session。
   *
   * 事务内：
   *   读取 latest message
   *   计算时间分隔状态
   *   插入消息
   *   查询刚插入的完整 row
   *   使用最终 previewText 更新 sessions
   * commit
   */
  async commitMessage(input: CommitMessageInput): Promise<ChatMessage> {
    const db = databaseCoordinator.openTaskExecutor({
      name: 'chat.commit-message',
      feature: 'chat',
      priority: 'interactive',
    });
    return db.withExclusiveTransactionAsync((transaction) => (
      this.commitMessageInTransaction(transaction, input)
    ));
  }

  /**
   * 引用写入守卫：在调用方自己的事务里确认 metadata 引用的 MediaAsset 仍存在。
   *
   * 与 release 事务共享同一个 coordinator 单写者调度，因此「release 已确认无引用并删除
   * catalog 行」与「新引用写入」不可能交错：后提交的一方必然看到前者的结果。这里把这条
   * 顺序关系变成可失败的检查，而不是让写入静默产出 dangling reference。
   */
  private async assertMetadataMediaAssetReferencesExistInTransaction(
    transaction: DatabaseTransactionExecutor,
    metadataJson: string | null | undefined,
  ): Promise<void> {
    if (!metadataJson) {
      return;
    }
    // 廉价前置过滤：谓词只认 mediaAssetId / thumbnailMediaAssetId 两个 key，原文都不含时
    // json_tree 不可能产出引用节点。这是对 SQL 判据的严格超集，不会漏判。
    if (!metadataJson.includes('mediaAssetId') && !metadataJson.includes('MediaAssetId')) {
      return;
    }
    const missing = await transaction.getAllAsync<{ asset_id: string }>(
      MISSING_MEDIA_ASSET_REFERENCE_QUERY,
      [metadataJson, metadataJson],
    );
    if (missing.length > 0) {
      throw new MediaAssetReferenceMissingError(missing.map((row) => row.asset_id));
    }
  }

  /**
   * 在事务执行器中插入单条消息并返回插入后的完整实体。
   * showTimeSeparatorBefore 未显式提供时，基于事务内读取的前一条消息计算。
   */
  private async insertMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    message: CreateMessageInput,
    previousMessage: { createdAt: string } | null,
  ): Promise<ChatMessage> {
    // 后续用户输入或另一轮 AI 消息一旦落地，旧候选永久转为只读，删除后续消息也不解锁。
    if (message.senderType === 'assistant' || message.senderType === 'user') {
      await transaction.runAsync(`UPDATE chat_reply_version_sets SET locked = 1
        WHERE session_id = ? AND current_run_id IS NOT ?
          AND json_extract(CASE WHEN json_valid(?) THEN ? END, '$.type') IS NOT 'callStatus'`,
      [message.sessionId, message.turnRunId ?? null, message.metadataJson ?? null, message.metadataJson ?? null]);
    }
    if (message.senderType === 'assistant') {
      // 旁路回复已成为新后续时，旧重写不能再把替换结果提交到它后面。
      const replaced = await transaction.getFirstAsync(`SELECT 1 FROM chat_regeneration_requests
        WHERE session_id = ? AND source_run_id IS NOT ?
        UNION ALL SELECT 1 FROM conversation_turn_state WHERE session_id = ?
          AND active_run_kind = 'regenerate' AND active_run_id IS NOT ? LIMIT 1`,
      [message.sessionId, message.turnRunId ?? null, message.sessionId, message.turnRunId ?? null]);
      if (replaced) await cancelRegenerationInTransaction(transaction, message.sessionId);
    }
    await this.assertMetadataMediaAssetReferencesExistInTransaction(
      transaction,
      message.metadataJson,
    );
    const resolvedMessage: CreateMessageInput = {
      ...message,
      showTimeSeparatorBefore:
        message.showTimeSeparatorBefore ??
        shouldShowTimeSeparatorBefore(previousMessage, message.createdAt),
    };
    const result = await transaction.runAsync(
      `INSERT INTO messages 
       (session_id, agent_id, client_message_id, text, is_me, sender_type, api_message_id, time, created_at, show_time_separator_before, updated_at,
         reply_to_id, reply_to_text, logical_message_id, segment_index, segment_total, delivery_status,
         status, tokens_used, prompt_tokens, completion_tokens, metadata_json, is_read, voice_played_at, turn_run_id, turn_item_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resolvedMessage.sessionId,
        resolvedMessage.agentId || null,
        resolvedMessage.clientMessageId || null,
        resolvedMessage.text,
        resolvedMessage.isMe ? 1 : 0,
        resolvedMessage.senderType,
        resolvedMessage.apiMessageId || null,
        resolvedMessage.time,
        resolvedMessage.createdAt,
        resolvedMessage.showTimeSeparatorBefore ? 1 : 0,
        resolvedMessage.updatedAt || resolvedMessage.createdAt,
        resolvedMessage.replyToId || null,
        resolvedMessage.replyToText || null,
        resolvedMessage.logicalMessageId || null,
        resolvedMessage.segmentIndex || 0,
        resolvedMessage.segmentTotal || 1,
        resolvedMessage.deliveryStatus || 'delivered',
        resolvedMessage.status || 'sent',
        resolvedMessage.tokensUsed || 0,
        resolvedMessage.promptTokens || 0,
        resolvedMessage.completionTokens || 0,
        resolvedMessage.metadataJson || null,
        this.resolveIsReadValue(resolvedMessage),
        resolvedMessage.voicePlayedAt ?? null,
        resolvedMessage.turnRunId ?? null,
        resolvedMessage.turnItemIndex ?? null,
      ]
    );
    const row = await transaction.getFirstAsync<MessageRow>(
      'SELECT * FROM messages WHERE id = ?',
      [result.lastInsertRowId],
    );
    if (!row) {
      throw new Error(`Failed to retrieve inserted message with id ${result.lastInsertRowId}`);
    }
    return this.mapRowToEntity(row);
  }

  /**
   * 事务感知的消息提交方法，供需要组合多个 Repository 的原子写入使用。
   * 调用方必须通过 withExclusiveTransactionAsync 进入事务后将 transaction 传入。
   */
  async commitMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitMessageInput,
  ): Promise<ChatMessage> {
    const latestMessage = await this.readLatestMessageInTransaction(
      transaction,
      input.message.sessionId,
    );
    const insertedMessage = await this.insertMessageInTransaction(
      transaction,
      input.message,
      latestMessage,
    );
    // 仅当刚插入的消息仍是稳定时间线末尾时，使用最终 previewText 更新 session preview，
    // 防止补写旧消息或乱序消息倒退覆盖会话列表。
    await this.updateSessionPreviewForCommittedMessageInTransaction(transaction, {
      sessionId: insertedMessage.sessionId,
      messageId: insertedMessage.id,
      previewText: input.previewText,
    });
    return insertedMessage;
  }

  /**
   * 统一批量消息提交：在同一 exclusive transaction 中插入所有消息，
   * 并只使用最终 previewText 更新 session 一次。
   */
  async commitMessages(input: CommitMessagesInput): Promise<ChatMessage[]> {
    if (input.messages.length === 0) return [];
    const db = databaseCoordinator.openTaskExecutor({
      name: 'chat.commit-messages',
      feature: 'chat',
      priority: 'interactive',
    });
    return db.withExclusiveTransactionAsync((transaction) => (
      this.commitMessagesInTransaction(transaction, input)
    ));
  }

  /**
   * 事务感知的批量消息提交方法，供需要组合多个 Repository 的原子写入使用。
   * 调用方必须通过 withExclusiveTransactionAsync 进入事务后将 transaction 传入。
   */
  async commitMessagesInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitMessagesInput,
  ): Promise<ChatMessage[]> {
    if (input.messages.length === 0) return [];
    const sessionId = input.messages[0].sessionId;
    const hasMultipleSessions = input.messages.some((message) => message.sessionId !== sessionId);
    if (hasMultipleSessions) {
      throw new Error(
        `Cannot commit messages across multiple sessions: expected ${sessionId}`,
      );
    }
    let previousMessage: { createdAt: string } | null =
      await this.readLatestMessageInTransaction(transaction, sessionId);
    const insertedMessages: ChatMessage[] = [];

    for (const message of input.messages) {
      const insertedMessage = await this.insertMessageInTransaction(
        transaction,
        message,
        previousMessage,
      );
      insertedMessages.push(insertedMessage);
      previousMessage = { createdAt: insertedMessage.createdAt };
    }

    // 只在全部消息插入后更新一次 session preview，使用最后一条 committed message 的 ID
    // 确认其仍是稳定时间线末尾，防止批量补写倒退覆盖会话列表。
    // canonical Agent timeline 可能只有 reasoning/tool 展示项；此时不能把工具文本
    // 或 reasoning 当成 assistant preview，保留既有 session preview。
    if (input.previewText !== null) {
      const lastMessage = insertedMessages[insertedMessages.length - 1];
      await this.updateSessionPreviewForCommittedMessageInTransaction(transaction, {
        sessionId,
        messageId: lastMessage.id,
        previewText: input.previewText,
      });
    }

    return insertedMessages;
  }

  async compareAndSwapMetadataJsonInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CompareAndSwapMetadataJsonInput,
  ): Promise<void> {
    await this.assertMetadataMediaAssetReferencesExistInTransaction(transaction, input.metadataJson);
    const result = await transaction.runAsync(
      `UPDATE messages
       SET metadata_json = ?, updated_at = ?
       WHERE id = ? AND metadata_json = ?`,
      [
        input.metadataJson,
        new Date().toISOString(),
        input.messageId,
        input.expectedMetadataJson,
      ],
    );

    if (result.changes !== 1) {
      throw new Error(
        `Chat metadata CAS 必须恰好影响一行，实际影响 ${result.changes} 行：${input.messageId}`,
      );
    }
  }

  /**
   * Stateful timeline entry 的 Chat-owned 幂等提交。
   *
   * sessionId + clientMessageId 是 entry 的稳定事实键；查找、插入/更新、preview 更新和
   * 完整 row 读取必须共享同一个 exclusive transaction，避免旧的「先查再写」
   * 调用链在并发重入时产生重复行或半提交状态。
   */
  async upsertStatefulTimelineEntry(
    input: UpsertStatefulTimelineEntryInput,
  ): Promise<UpsertStatefulTimelineEntryResult> {
    const clientMessageId = input.message.clientMessageId;
    if (!clientMessageId) {
      throw new Error('Stateful timeline entry 必须提供稳定 clientMessageId');
    }

    const db = databaseCoordinator.openTaskExecutor({
      name: 'chat.upsert-stateful-timeline-entry',
      feature: 'chat',
      priority: 'interactive',
    });

    return db.withExclusiveTransactionAsync((transaction) => this.upsertStatefulTimelineEntryInTransaction(transaction, input));
  }

  async upsertStatefulTimelineEntryInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: UpsertStatefulTimelineEntryInput,
  ): Promise<UpsertStatefulTimelineEntryResult> {
      const clientMessageId = input.message.clientMessageId!;
      const existingRow = await transaction.getFirstAsync<MessageRow>(
        `SELECT * FROM messages
         WHERE session_id = ? AND client_message_id = ?
         LIMIT 1`,
        [input.message.sessionId, clientMessageId],
      );

      if (existingRow) {
        await this.assertMetadataMediaAssetReferencesExistInTransaction(
          transaction,
          input.message.metadataJson,
        );
        const updatedAt = new Date().toISOString();
        // 同一条目可从来电状态变成系统故障，发送者与 AI 身份必须和内容一起更新。
        await transaction.runAsync(
          `UPDATE messages
           SET text = ?, metadata_json = ?, is_read = ?, updated_at = ?, status = ?,
               api_message_id = ?, tokens_used = ?, prompt_tokens = ?, completion_tokens = ?,
               sender_type = ?, logical_message_id = ?, segment_index = ?, segment_total = ?, delivery_status = ?,
               is_me = ?, agent_id = ?
           WHERE id = ?`,
          [
            input.message.text,
            input.message.metadataJson ?? null,
            this.resolveIsReadValue(input.message),
            updatedAt,
            input.message.status ?? 'sent',
            input.message.apiMessageId ?? null,
            input.message.tokensUsed ?? 0,
            input.message.promptTokens ?? 0,
            input.message.completionTokens ?? 0,
            input.message.senderType,
            input.message.logicalMessageId ?? null,
            input.message.segmentIndex ?? 0,
            input.message.segmentTotal ?? 1,
            input.message.deliveryStatus ?? null,
            input.message.isMe ? 1 : 0,
            input.message.agentId ?? null,
            existingRow.id,
          ],
        );
        if (input.previewText !== null) await this.updateSessionPreviewForCommittedMessageInTransaction(transaction, {
          sessionId: input.message.sessionId,
          messageId: existingRow.id,
          previewText: input.previewText,
        });

        const updatedRow = await transaction.getFirstAsync<MessageRow>(
          'SELECT * FROM messages WHERE id = ?',
          [existingRow.id],
        );
        if (!updatedRow) {
          throw new Error(`Failed to retrieve updated stateful timeline entry ${existingRow.id}`);
        }
        return {
          message: this.mapRowToEntity(updatedRow),
          inserted: false,
        };
      }

      const latestMessage = await this.readLatestMessageInTransaction(
        transaction,
        input.message.sessionId,
      );
      const insertedMessage = await this.insertMessageInTransaction(
        transaction,
        input.message,
        latestMessage,
      );
      if (input.previewText !== null) await this.updateSessionPreviewForCommittedMessageInTransaction(transaction, {
        sessionId: insertedMessage.sessionId,
        messageId: insertedMessage.id,
        previewText: input.previewText,
      });
      return {
        message: insertedMessage,
        inserted: true,
      };
  }

  /** 在事务执行器中读取会话的最新一条消息，作为时间分隔计算的前一条消息。 */
  private async readLatestMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    sessionId: string,
  ): Promise<ChatMessage | null> {
    const row = await transaction.getFirstAsync<MessageRow>(
      `${timelineOrderedMessagesCte('m.session_id = ?')}
       SELECT * FROM ordered_messages
       WHERE 1 = 1
       ORDER BY ${timelineProjectionOrderBy('DESC')}
       LIMIT 1`,
      [sessionId],
    );
    return row ? this.mapRowToEntity(row) : null;
  }

  /**
   * 事务感知的 session preview 更新：仅当指定消息仍是该会话稳定时间线末尾时
   * 才使用最终 previewText 更新，防止补写旧消息或乱序消息倒退覆盖会话列表。
   *
   * 必须使用调用方传入的同一个 transaction 执行器，不得重新进入 coordinator transaction。
   *
   * @returns 是否实际更新了 preview
   */
  async updateSessionPreviewForCommittedMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: {
      sessionId: string;
      messageId: number;
      previewText: string;
    },
  ): Promise<boolean> {
    const latest = await transaction.getFirstAsync<Pick<MessageRow, 'id' | 'created_at'>>(
      `${timelineOrderedMessagesCte('m.session_id = ?')}
       SELECT id, created_at FROM ordered_messages
       WHERE sender_type NOT IN ('reasoning', 'tool')
         AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.type') END, '') NOT IN ('toolStatus', 'agentActivity')
       ORDER BY ${timelineProjectionOrderBy('DESC')}
       LIMIT 1`,
      [input.sessionId],
    );
    if (latest?.id !== input.messageId) {
      return false;
    }
    await transaction.runAsync(
      `UPDATE sessions
       SET last_message = ?, last_time = ?, updated_at = ?
       WHERE id = ?`,
      [input.previewText, latest.created_at, new Date().toISOString(), input.sessionId],
    );
    return true;
  }

  async getMessageByIdInTransaction(transaction: DatabaseTransactionExecutor, messageId: number): Promise<ChatMessage | null> {
    const row = await transaction.getFirstAsync<MessageRow>('SELECT * FROM messages WHERE id = ?', [messageId]);
    return row ? this.mapRowToEntity(row) : null;
  }

  async listTurnMessagesInTransaction(transaction: DatabaseReadExecutor, runId: string): Promise<ChatMessage[]> {
    const rows = await transaction.getAllAsync<MessageRow>(
      'SELECT * FROM messages WHERE turn_run_id = ? AND turn_item_index IS NOT NULL ORDER BY turn_item_index', [runId],
    );
    return rows.map(row => this.mapRowToEntity(row));
  }

  async bindTurnMessageInTransaction(transaction: DatabaseTransactionExecutor, messageId: number, itemIndex: number): Promise<ChatMessage | null> {
    await transaction.runAsync('UPDATE messages SET turn_item_index = ? WHERE id = ?', [itemIndex, messageId]);
    const message = await this.getMessageByIdInTransaction(transaction, messageId);
    if (!message) return null;
    // 提前提交的第一项通过 UPDATE 绑定，不经过原有 INSERT 锚点 trigger。
    if (itemIndex === 1) await transaction.runAsync(`INSERT OR IGNORE INTO chat_timeline_run_anchors(session_id, turn_run_id, id, created_at)
      VALUES (?, ?, ?, ?)`, [message.sessionId, message.turnRunId!, message.id, message.createdAt]);
    return message;
  }

  async editMessageTextInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: { messageId: number; text: string; previewText: string },
  ): Promise<ChatMessage> {
    const updatedAt = new Date().toISOString();
    await transaction.runAsync(
      'UPDATE messages SET text = ?, updated_at = ? WHERE id = ?',
      [input.text, updatedAt, input.messageId],
    );
    const edited = (await this.getMessageByIdInTransaction(transaction, input.messageId))!;
    await cancelRegenerationInTransaction(transaction, edited.sessionId);
    await editSelectedReplyVersion(transaction, edited);
    // 完成回复的手动改字仍是已展示事实，避免旧展示快照把新正文扣留在可见视图之外。
    await transaction.runAsync(`UPDATE chat_turn_display_items
      SET snapshot_json = json_set(snapshot_json, '$.text', ?),
          shown_json = json_set(shown_json, '$.text', ?) WHERE message_id = ?`,
    [edited.text, edited.text, edited.id]);
    // 沿用可见时间线与预览成员口径，改写旧消息不会把它提升成最新活动。
    const latest = await transaction.getFirstAsync<{ id: number }>(
      `${timelineOrderedMessagesCte(`m.session_id = ? AND m.id > COALESCE((
        SELECT visible_after_message_id FROM sessions WHERE id = m.session_id
      ), 0)`)}
       SELECT id FROM ordered_messages
       WHERE sender_type NOT IN ('reasoning', 'tool')
         AND COALESCE(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.type') END, '') NOT IN ('toolStatus', 'agentActivity')
       ORDER BY ${timelineProjectionOrderBy('DESC')} LIMIT 1`,
      [edited.sessionId],
    );
    if (latest?.id === edited.id) {
      await transaction.runAsync(
        'UPDATE sessions SET last_message = ?, updated_at = ? WHERE id = ?',
        [input.previewText, updatedAt, edited.sessionId],
      );
    }
    return edited;
  }

  async updateMessage(messageId: number, updates: UpdateMessageInput): Promise<boolean> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.updateMessage', feature: 'chat', priority: 'interactive' });
      const fields: string[] = [];
      const values: (string | number | null)[] = [];

      if (updates.text !== undefined) {
        fields.push('text = ?');
        values.push(updates.text);
      }
      if (updates.status !== undefined) {
        fields.push('status = ?');
        values.push(updates.status);
      }
      if (updates.isRead !== undefined) {
        fields.push('is_read = ?');
        values.push(updates.isRead ? 1 : 0);
      }
      if (updates.voicePlayedAt !== undefined) {
        fields.push('voice_played_at = ?');
        values.push(updates.voicePlayedAt);
      }
      if (updates.agentId !== undefined) {
        fields.push('agent_id = ?');
        values.push(updates.agentId);
      }
      if (updates.tokensUsed !== undefined) {
        fields.push('tokens_used = ?');
        values.push(updates.tokensUsed);
      }
      if (updates.promptTokens !== undefined) {
        fields.push('prompt_tokens = ?');
        values.push(updates.promptTokens);
      }
      if (updates.completionTokens !== undefined) {
        fields.push('completion_tokens = ?');
        values.push(updates.completionTokens);
      }
      if (updates.apiMessageId !== undefined) {
        fields.push('api_message_id = ?');
        values.push(updates.apiMessageId);
      }
      if (updates.clientMessageId !== undefined) {
        fields.push('client_message_id = ?');
        values.push(updates.clientMessageId);
      }
      if (updates.metadataJson !== undefined) {
        fields.push('metadata_json = ?');
        values.push(updates.metadataJson);
      }
      if (updates.logicalMessageId !== undefined) {
        fields.push('logical_message_id = ?');
        values.push(updates.logicalMessageId);
      }
      if (updates.segmentIndex !== undefined) {
        fields.push('segment_index = ?');
        values.push(updates.segmentIndex);
      }
      if (updates.segmentTotal !== undefined) {
        fields.push('segment_total = ?');
        values.push(updates.segmentTotal);
      }
      if (updates.deliveryStatus !== undefined) {
        fields.push('delivery_status = ?');
        values.push(updates.deliveryStatus);
      }

      if (fields.length === 0) return true;

      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(messageId);

      const sql = `UPDATE messages SET ${fields.join(', ')} WHERE id = ?`;
      // metadata 重写可能携带媒体引用，必须与 release 共享事务边界并 fail closed；
      // 其它字段的单条 UPDATE 不涉及引用，保持原有的非事务写入路径。
      if (updates.metadataJson !== undefined) {
        await db.withExclusiveTransactionAsync(async (transaction) => {
          await this.assertMetadataMediaAssetReferencesExistInTransaction(
            transaction,
            updates.metadataJson,
          );
          await transaction.runAsync(sql, values);
        });
        return true;
      }

      await db.runAsync(sql, values);

      return true;
    } catch (error) {
      console.error('[MessageRepository] Failed to update message:', error);
      throw error;
    }
  }

  async markMessagesAsRead(sessionId: string): Promise<number> {
    try {
      return await databaseCoordinator.transaction({ name: 'chat.markMessagesAsRead', feature: 'chat', priority: 'interactive' }, async db => {
        const result = await db.runAsync(
          `UPDATE messages
           SET is_read = 1
           WHERE session_id = ?
             AND is_me = 0
             AND sender_type = 'assistant'
             AND COALESCE(is_read, 0) = 0`,
          [sessionId]
        );

        const display = await db.runAsync(`UPDATE chat_turn_display_items SET is_read = 1
          WHERE run_id IN (SELECT run_id FROM chat_turn_presentations WHERE session_id = ?)
            AND message_id IS NULL AND is_read = 0 AND json_extract(shown_json, '$.kind') = 'assistant'`, [sessionId]);
        return result.changes + display.changes;
      });
    } catch (error) {
      console.error('[MessageRepository] Failed to mark messages as read:', error);
      throw error;
    }
  }

  async markMessagesAsReadByIds(messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) {
      return 0;
    }

    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.markMessagesAsReadByIds', feature: 'chat', priority: 'interactive' });
      const placeholders = messageIds.map(() => '?').join(',');
      // 幂等写：只触碰仍未读的行，重复调用 changes 收敛为 0。
      const result = await db.runAsync(
        `UPDATE messages
         SET is_read = 1
         WHERE id IN (${placeholders})
           AND COALESCE(is_read, 0) = 0`,
        [...messageIds]
      );

      return result?.changes || 0;
    } catch (error) {
      console.error('[MessageRepository] Failed to mark messages as read by ids:', error);
      throw error;
    }
  }

  async markVoiceMessagePlayed(messageId: number, playedAt: string): Promise<boolean> {
    const db = databaseCoordinator.openTaskExecutor({
      name: 'chat.mark-voice-message-played',
      feature: 'chat',
      priority: 'interactive',
    });
    const result = await db.runAsync(
      `UPDATE messages
       SET voice_played_at = ?, updated_at = ?
       WHERE id = ? AND voice_played_at IS NULL`,
      [playedAt, playedAt, messageId],
    );
    return result.changes === 1;
  }

  async deleteMessage(messageId: number): Promise<boolean> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.deleteMessage', feature: 'chat', priority: 'interactive' });
      await db.runAsync('DELETE FROM messages WHERE id = ?', [messageId]);
      return true;
    } catch (error) {
      console.error('[MessageRepository] Failed to delete message:', error);
      throw error;
    }
  }

  /**
   * 事务内删除消息并返回同一快照中的媒体引用候选。
   *
   * 事务内严格按顺序做三件事：
   *   读取这些 id 当前真实存在的 message rows（rows 就是本次会被删除的集合）
   *   从这些 rows 的当前 metadata_json 提取引用候选
   *   DELETE 同一批 id
   *
   * 候选必须来自 DELETE 之前、同一事务内的 metadata 行；调用方（或它之前读到的）消息
   * snapshot 不允许参与候选推导，否则 legacy attachment migration 的 CAS 会在
   * 「读快照」与「真正删除」之间把 legacy URI 换成 canonical assetId，让这次消失的真实
   * 引用漏出候选集。详见 IMessageRepository.deleteMessagesWithMediaCandidates。
   */
  async deleteMessagesWithMediaCandidates(
    messageIds: readonly number[],
  ): Promise<DeleteMessagesWithMediaCandidatesResult> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'chat.delete-messages-with-media-candidates', feature: 'chat', priority: 'interactive',
    });
    return database.withExclusiveTransactionAsync((transaction) =>
      this.deleteMessagesWithMediaCandidatesInTransaction(transaction, messageIds));
  }

  async deleteMessagesWithMediaCandidatesInTransaction(
    transaction: DatabaseTransactionExecutor,
    messageIds: readonly number[],
    options?: { preserveReplyVersions: boolean },
  ): Promise<DeleteMessagesWithMediaCandidatesResult> {
    const targetIds = normalizeMessageIds(messageIds);
    if (targetIds.length === 0) return { deletedMessageIds: [], mediaAssetCandidates: [] };
    const placeholders = targetIds.map(() => '?').join(', ');
    const rows = await transaction.getAllAsync<{ id: number; session_id: string }>(
      `SELECT id, session_id FROM messages WHERE id IN (${placeholders}) ORDER BY id ASC`, targetIds,
    );
    if (rows.length === 0) return { deletedMessageIds: [], mediaAssetCandidates: [] };
    for (const sessionId of new Set(rows.map((row) => row.session_id))) {
      await cancelRegenerationInTransaction(transaction, sessionId);
    }
    const candidates = await transaction.getAllAsync<{ asset_id: string }>(
      MESSAGE_MEDIA_ASSET_CANDIDATES_QUERY.replace('{{MESSAGE_IDS}}', placeholders), targetIds,
    );
    const versionAssets = options?.preserveReplyVersions ? [] : await deleteReplyVersionsForMessages(transaction, targetIds);
    const deleted = await transaction.runAsync(`DELETE FROM messages WHERE id IN (${placeholders})`, targetIds);
    if (deleted.changes !== rows.length) throw new Error('事务内删除消息数与读取行数不一致');
    return { deletedMessageIds: rows.map((row) => row.id), mediaAssetCandidates: [...new Set([...versionAssets, ...candidates.map((row) => row.asset_id)])] };
  }

  async updateSessionPreview(sessionId: string, lastMessage: string, lastTime: string | null): Promise<boolean> {
    try {
      const db = databaseCoordinator.openTaskExecutor({ name: 'chat.updateSessionPreview', feature: 'chat', priority: 'interactive' });
      const now = new Date().toISOString();

      await db.runAsync(
        `UPDATE sessions 
         SET last_message = ?, last_time = ?, updated_at = ?
         WHERE id = ?`,
        [lastMessage, lastTime, now, sessionId]
      );

      return true;
    } catch (error) {
      console.error('[MessageRepository] Failed to update session preview:', error);
      throw error;
    }
  }

  async updateSessionPreviewForCommittedMessage(input: {
    sessionId: string;
    messageId: number;
    previewText: string;
  }): Promise<boolean> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'chat.updateSessionPreviewForCommittedMessage', feature: 'chat', priority: 'interactive' });
    return db.withExclusiveTransactionAsync((transaction) => (
      this.updateSessionPreviewForCommittedMessageInTransaction(transaction, input)
    ));
  }

  private resolveIsReadValue(input: CreateMessageInput): number {
    if (typeof input.isRead === 'boolean') {
      return input.isRead ? 1 : 0;
    }

    if (input.isMe) {
      return 1;
    }

    return input.senderType === 'assistant' ? 0 : 1;
  }

  private mapRowIsRead(row: MessageRow): boolean {
    if (row.is_read === 0 || row.is_read === 1) {
      return row.is_read === 1;
    }

    if (row.is_me === 1) {
      return true;
    }

    return row.sender_type !== 'assistant';
  }

  private mapRowToEntity(row: MessageRow): ChatMessage {
    if (row.turn_presentation_state === 'interrupted') {
      row = { ...row, metadata_json: JSON.stringify({ ...(row.metadata_json ? JSON.parse(row.metadata_json) : {}), interrupted: true }) };
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      text: row.text,
      isMe: row.is_me === 1,
      isRead: this.mapRowIsRead(row),
      voicePlayedAt: row.voice_played_at,
      senderType: row.sender_type as ChatMessage['senderType'],
      apiMessageId: row.api_message_id,
      clientMessageId: row.client_message_id,
      time: row.time,
      createdAt: row.created_at,
      showTimeSeparatorBefore: row.show_time_separator_before === 1,
      updatedAt: row.updated_at || row.created_at,
      replyToId: row.reply_to_id,
      replyToText: row.reply_to_text,
      logicalMessageId: row.logical_message_id,
      segmentIndex: row.segment_index ?? 0,
      segmentTotal: row.segment_total ?? 1,
      deliveryStatus: row.delivery_status || 'delivered',
      status: row.status,
      tokensUsed: row.tokens_used || 0,
      promptTokens: row.prompt_tokens || 0,
      completionTokens: row.completion_tokens || 0,
      metadataJson: row.metadata_json,
      turnRunId: row.turn_run_id,
      turnItemIndex: row.turn_item_index,
    };
  }
}

export const messageRepository = new MessageRepository();
