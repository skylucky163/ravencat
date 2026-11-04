/** 摘要与进度同事务交接；消息删除没有摘要副作用，清摘要独立递增 generation。 */
import { CoordinatedDatabaseError, databaseCoordinator, type DatabaseReadExecutor, type DatabaseTransactionExecutor, type DatabaseTaskPriority } from '@platform/persistence';
import { estimateTextTokens } from '@shared/prompt';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import { buildGroupMentionModelText } from '../../group/application/GroupMentionModelText';
import { timelineOrderedMessagesCte, timelineProjectionOrderBy, timelineCursorCondition } from '../../messages/infrastructure/ChatTimelineSql';
import { parseChatContextCursor, projectChatContextMessage, type ChatCanonicalCursor, type ChatContextItem } from '../domain/ChatContext';
import { editChatSummaryText, ChatSummaryEditError, type ChatSummaryTextEdit, CHAT_SUMMARY_MAX_AUTOMATIC_ATTEMPTS, DEFAULT_CHAT_SUMMARY_SETTINGS, type ChatSummaryAddition, type ChatSummaryCallBoundary, type ChatSummaryClaim, type ChatSummaryRepository, type ChatSummarySegment, type ChatSummarySettings, type ChatSummarySettingsPatch, type SecondaryChatSummaryClaim, type ChatSummarySearchInput, type ChatSummaryTask, type ChatSummaryTaskClaim, type ChatSummaryFailure, type ChatSummaryCallDiagnostics, type ChatSummaryLevel , ChatBackgroundContextOptions, ChatBackgroundContext } from '../domain/ChatSummaryRepository';
import type { CallSummarySource } from '@features/calls';
import { buildConversationTimeline, selectSummaryRange, type ConversationContextItem } from '../domain/ChatSummaryTimeline';

// 查询和工具编辑共用同一身份边界；群成员资格必须在写入事务内读取。
const assistantSummaryAccess = `(s.ai_assistant_id = ? OR EXISTS (SELECT 1 FROM group_chat_members m
  JOIN group_chats g ON g.id = m.group_id WHERE m.group_id = c.conversation_id AND m.ai_assistant_id = ? AND m.enabled = 1))`;
async function requireAssistantConversation(db: DatabaseReadExecutor, assistantId: string, conversationId: string) {
  const row = await db.getFirstAsync<{ conversation_id: string }>(`SELECT c.conversation_id FROM (SELECT id AS conversation_id FROM chat_conversations) c
    LEFT JOIN sessions s ON s.id = c.conversation_id WHERE c.conversation_id = ? AND ${assistantSummaryAccess}`,
  [conversationId, assistantId, assistantId]);
  if (!row) throw new ChatSummaryEditError('来源会话不存在或当前 AI 无权访问');
}
function combinedSecondaryContent(segments: readonly ChatSummarySegment[]) {
  return [...segments].sort((a, b) => a.contextSequence - b.contextSequence || a.sequence - b.sequence).map((segment) => segment.content).join('\n\n');
}
async function requireAssistantPrimarySegment(db: DatabaseReadExecutor, assistantId: string, conversationId: string, segmentId: string) {
  await requireAssistantConversation(db, assistantId, conversationId);
  const row = await db.getFirstAsync<SegmentRow>(`SELECT * FROM chat_summary_segments
    WHERE conversation_id = ? AND id = ? AND level = 'primary'`, [conversationId, segmentId]);
  if (!row) throw new ChatSummaryEditError('这条一级摘要已不存在或不属于指定会话');
  return mapSegment(row);
}
async function editSegmentInTransaction(tx: DatabaseTransactionExecutor, conversationId: string, segmentId: string, content: string, now: string) {
  const result = await tx.runAsync('UPDATE chat_summary_segments SET content = ?, updated_at = ? WHERE conversation_id = ? AND id = ?', [content, now, conversationId, segmentId]);
  if (!result.changes) throw new Error('这段摘要已不存在');
  await tx.runAsync('UPDATE chat_summary_state SET revision = revision + 1 WHERE conversation_id = ?', [conversationId]);
}
async function deleteSegmentInTransaction(tx: DatabaseTransactionExecutor, conversationId: string, segmentId: string) {
  await tx.runAsync('DELETE FROM chat_summary_segments WHERE conversation_id = ? AND id = ?', [conversationId, segmentId]);
  await tx.runAsync('UPDATE chat_summary_state SET revision = revision + 1 WHERE conversation_id = ?', [conversationId]);
}

/** 页面和工具共用正文交接，统一保留来源关联与讨论范围。 */
async function replaceSecondaryInTransaction(tx: DatabaseTransactionExecutor, conversationId: string, current: ChatSummarySegment[], content: string | null, now: string) {
  if (content === null) {
    await tx.runAsync("DELETE FROM chat_summary_segments WHERE conversation_id = ? AND level = 'secondary'", [conversationId]);
  } else {
    current.sort((a, b) => a.contextSequence - b.contextSequence || a.sequence - b.sequence);
    const anchor = current[0];
    const starts = current.flatMap((segment) => segment.sourceStartAt === null ? [] : [segment.sourceStartAt]).sort();
    const ends = current.flatMap((segment) => segment.sourceEndAt === null ? [] : [segment.sourceEndAt]).sort();
    const cursor = await tx.getFirstAsync<{ to_cursor: string | null }>(`SELECT to_cursor FROM chat_summary_segments
      WHERE conversation_id = ? AND level = 'secondary' AND to_cursor IS NOT NULL ORDER BY json_extract(to_cursor,'$[3]') DESC LIMIT 1`, [conversationId]);
    await tx.runAsync(`UPDATE chat_summary_segments SET content = ?, source_start_at = ?, source_end_at = ?, updated_at = ?, to_cursor = ?
      WHERE conversation_id = ? AND id = ?`, [content, starts[0] ?? null, ends.at(-1) ?? null, now, cursor?.to_cursor ?? null, conversationId, anchor.id]);
    for (const segment of current.slice(1)) {
      await tx.runAsync('UPDATE chat_summary_segments SET compaction_id = ? WHERE conversation_id = ? AND compaction_id = ?', [anchor.id, conversationId, segment.id]);
      await tx.runAsync('DELETE FROM chat_summary_segments WHERE conversation_id = ? AND id = ?', [conversationId, segment.id]);
    }
  }
  // 删除二级也不解除一级归纳状态；正文编辑不推进原文处理游标。
  await tx.runAsync('UPDATE chat_summary_state SET revision = revision + 1 WHERE conversation_id = ?', [conversationId]);
}

function requestSettings(settings: ChatSummarySettings) {
  return { requestTimeoutSeconds: settings.requestTimeoutSeconds, maxOutputTokens: settings.maxOutputTokens, modelConfigId: settings.modelConfigId };
}

interface CallSourceReader {
  (db: DatabaseReadExecutor, conversationId: string, boundary: ChatSummaryCallBoundary): Promise<CallSummarySource[]>;
}

interface StateRow {
  generation: number; revision: number; processed_cursor: string | null;
  claim_id: string | null; claim_expires_at: string | null;
}
interface TaskRow {
  id: string; conversation_id: string; level: ChatSummaryLevel; status: ChatSummaryTask['status'];
  attempt_count: number; automatic_failures: number; manual_retry: number; last_manual: number;
  next_attempt_at: string | null; error_json: string | null; calls_json: string; segment_ids_json: string;
  created_at: string; updated_at: string;
}
function mapTask(row: TaskRow): ChatSummaryTask {
  return { id: row.id, conversationId: row.conversation_id, level: row.level, status: row.status,
    attemptCount: row.attempt_count, automaticFailures: row.automatic_failures, nextAttemptAt: row.next_attempt_at,
    error: row.error_json === null ? null : JSON.parse(row.error_json), calls: JSON.parse(row.calls_json),
    segmentIds: JSON.parse(row.segment_ids_json), createdAt: row.created_at, updatedAt: row.updated_at };
}
async function readPendingTask(db: DatabaseReadExecutor, conversationId: string, level: ChatSummaryLevel) {
  return db.getFirstAsync<TaskRow>(`SELECT * FROM chat_summary_tasks WHERE conversation_id = ? AND level = ?
    AND status <> 'completed'`, [conversationId, level]);
}
function canStartTask(row: TaskRow | null, now: string): boolean {
  return row === null || row.manual_retry !== 0 || (row.status !== 'failed' && (row.next_attempt_at === null || row.next_attempt_at <= now));
}
/** 资格读取与开始写入共用领取事务；原文不足时不创建任务或增加尝试次数。 */
async function beginTask(tx: DatabaseTransactionExecutor, conversationId: string, level: ChatSummaryLevel, claimId: string, now: string, row: TaskRow | null) {
  const id = row?.id ?? claimId;
  if (!row) await tx.runAsync(`INSERT INTO chat_summary_tasks (id,conversation_id,level,status,created_at,updated_at)
    VALUES (?,?,?,'waiting',?,?)`, [id, conversationId, level, now, now]);
  await tx.runAsync(`UPDATE chat_summary_tasks SET status = 'running', attempt_count = attempt_count + 1,
    last_manual = CASE WHEN status = 'running' THEN last_manual ELSE manual_retry END,
    manual_retry = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
  return id;
}
async function completeTask(tx: DatabaseTransactionExecutor, taskId: string, segmentIds: string[], now: string) {
  await tx.runAsync(`UPDATE chat_summary_tasks SET status = 'completed',
    next_attempt_at = NULL, segment_ids_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(segmentIds), now, taskId]);
}
interface SegmentRow {
  id: string; conversation_id: string; sequence: number; content: string;
  message_count: number; batch_size: number | null; source_start_at: string | null; source_end_at: string | null;
  time_zone: string; created_at: string; updated_at: string;
  level: ChatSummarySegment['level']; compaction_id: string | null; context_sequence: number | null;
}
interface ContextRow {
  id: number; session_id: string; text: string; is_me: number; sender_type: ChatMessage['senderType'];
  status: ChatMessage['status']; delivery_status: ChatMessage['deliveryStatus']; created_at: string; time: string;
  metadata_json: string | null; reply_to_text: string | null; logical_message_id: string | null;
  timeline_order_created_at: string; timeline_order_anchor_id: number; timeline_order_item_index: number;
  agent_activity_pending: number;
  agent_id: string | null;
}
function executor(name: string, priority: DatabaseTaskPriority = 'maintenance') {
  return databaseCoordinator.openTaskExecutor({ name: 'chat.summary.' + name, feature: 'chat', priority });
}
async function assistantSummaryTransaction<T>(name: string, operation: (tx: DatabaseTransactionExecutor) => Promise<T>): Promise<T> {
  try {
    return await executor(name).withExclusiveTransactionAsync(operation);
  } catch (error) {
    // Repository 恢复自己的业务拒绝类型，工具才能回传具体原因；存储故障保留协调器诊断。
    if (error instanceof CoordinatedDatabaseError && error.cause instanceof ChatSummaryEditError) throw error.cause;
    throw error;
  }
}
async function readState(db: DatabaseTransactionExecutor, conversationId: string): Promise<StateRow> {
  await db.runAsync('INSERT OR IGNORE INTO chat_summary_state (conversation_id) VALUES (?)', [conversationId]);
  return (await db.getFirstAsync<StateRow>('SELECT * FROM chat_summary_state WHERE conversation_id = ?', [conversationId]))!;
}
async function readSegments(db: DatabaseReadExecutor, conversationId: string, upperBound?: ChatBackgroundContextOptions['upperBound']): Promise<ChatSummarySegment[]> {
  const rows = await db.getAllAsync<SegmentRow>(`SELECT * FROM chat_summary_segments WHERE conversation_id = ?
    ${upperBound ? "AND (to_cursor IS NULL OR json_extract(to_cursor, '$[3]') <= ?) AND COALESCE(source_end_at,created_at) <= ?" : ''}
    ORDER BY sequence`, [conversationId, ...(upperBound ? [upperBound.messageId, upperBound.createdAt] : [])]);
  return rows.map(mapSegment);
}
function mapSegment(row: SegmentRow): ChatSummarySegment {
  return { id: row.id, conversationId: row.conversation_id, sequence: row.sequence, content: row.content,
    level: row.level, compactionId: row.compaction_id, contextSequence: row.context_sequence ?? row.sequence,
    messageCount: row.message_count, batchSize: row.batch_size, sourceStartAt: row.source_start_at,
    sourceEndAt: row.source_end_at, timeZone: row.time_zone, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function readSettings(db: DatabaseReadExecutor, conversationId: string): Promise<ChatSummarySettings> {
  const row = await db.getFirstAsync<{ enabled: number; inject_enabled: number; fixed_message_id: number | null; secondary_enabled: number; secondary_token_threshold: number }>(
    'SELECT * FROM chat_summary_settings WHERE conversation_id = ?', [conversationId]);
  const request = await db.getFirstAsync<{ timeout_seconds: number; max_output_tokens: number | null; model_config_id: string | null; group_trigger_count: number; primary_limit: number | null }>(
    'SELECT * FROM chat_summary_request_settings WHERE conversation_id = ?', [conversationId]);
  return { ...DEFAULT_CHAT_SUMMARY_SETTINGS, ...(row ? { generationEnabled: row.enabled === 1, injectEnabled: row.inject_enabled === 1,
    fixedMessageId: row.fixed_message_id, secondaryEnabled: row.secondary_enabled === 1, secondaryTokenThreshold: row.secondary_token_threshold } : {}),
    ...(request ? { requestTimeoutSeconds: request.timeout_seconds, maxOutputTokens: request.max_output_tokens,
      modelConfigId: request.model_config_id, groupTriggerCount: request.group_trigger_count, primaryLimit: request.primary_limit } : {}) };
}
function selectContextSegments(segments: ChatSummarySegment[], settings: ChatSummarySettings): ChatSummarySegment[] {
  if (!settings.injectEnabled) return [];
  return segments.filter((segment) => settings.secondaryEnabled
    ? segment.level === 'secondary' || segment.compactionId === null : segment.level === 'primary')
    .sort((left, right) => left.contextSequence - right.contextSequence);
}
async function readCallBoundary(db: DatabaseReadExecutor, conversationId: string): Promise<ChatSummaryCallBoundary> {
  const processed = await db.getAllAsync<{ call_id: string }>('SELECT call_id FROM chat_summary_processed_calls WHERE conversation_id = ?', [conversationId]);
  const boundary = await db.getFirstAsync<{ history_starts_after: string | null }>(`SELECT
    NULLIF(MAX(COALESCE(s.visible_after_at, ''), COALESCE(b.cleared_at, '')), '') AS history_starts_after
    FROM sessions s LEFT JOIN chat_summary_call_boundary b ON b.conversation_id = s.id WHERE s.id = ?`, [conversationId]);
  return { processedCallIds: processed.map((row) => row.call_id), historyStartsAfter: boundary?.history_starts_after ?? null };
}
function claimKey(claim: ChatSummaryClaim): string {
  return JSON.stringify({ toCursor: claim.toCursor, callIds: claim.calls.map((call) => call.info.callId) });
}
interface ReadItemsOptions {
  visibleOnly?: boolean; after?: ChatCanonicalCursor | null; includeMessageId?: number; messageId?: number;
}
async function readItems(db: DatabaseReadExecutor, conversationId: string, options: ReadItemsOptions = {}): Promise<ChatContextItem[]> {
  return (await readItemPage(db, conversationId, options)).items;
}
async function readItemPage(
  db: DatabaseReadExecutor,
  conversationId: string,
  { visibleOnly = true, after = null, includeMessageId, messageId, limit }: ReadItemsOptions & { limit?: number },
): Promise<{ items: ChatContextItem[]; nextCursor: ChatCanonicalCursor | null; hasMore: boolean }> {
  const group = await db.getFirstAsync<{ id: string }>('SELECT id FROM group_chats WHERE id = ?', [conversationId]);
  const members = group ? await db.getAllAsync<{ aiAssistantId: string; agentId: string; name: string }>(`SELECT m.ai_assistant_id AS aiAssistantId,
    m.agent_id AS agentId, a.name FROM group_chat_members m JOIN ai_assistants a ON a.id = m.ai_assistant_id WHERE m.group_id = ?`, [conversationId]) : [];
  const condition = after ? timelineCursorCondition('ASC', {
    timeline_order_created_at: after[0], timeline_order_anchor_id: after[1],
    timeline_order_item_index: after[2], id: after[3],
  }) : null;
  // 已处理历史在 SQL 边界排除，避免每次 claim 都在独占事务中解析、排序并传回整段历史。
  // 自主 run 状态按会话聚合一次；共享回合由展示状态裁决，旧记录仍读取自身终态。
  const rows = await db.getAllAsync<ContextRow>(`${timelineOrderedMessagesCte(`m.session_id = ?
    ${messageId !== undefined ? 'AND m.id = ?' : ''}
    ${visibleOnly ? 'AND m.id > COALESCE((SELECT visible_after_message_id FROM sessions WHERE id = m.session_id), 0)' : ''}`)}
    , pending_activity_runs AS (
      SELECT turn_run_id FROM messages
      WHERE session_id = ? AND turn_run_id IS NOT NULL
        AND json_valid(metadata_json) AND json_extract(metadata_json, '$.type') = 'agentActivity'
      GROUP BY turn_run_id
      HAVING MAX(json_extract(metadata_json, '$.phase') = 'started') = 1
        AND (EXISTS (SELECT 1 FROM chat_turn_presentations p WHERE p.run_id = messages.turn_run_id AND p.state = 'open')
          OR (NOT EXISTS (SELECT 1 FROM chat_turn_presentations p WHERE p.run_id = messages.turn_run_id)
            AND MAX(json_extract(metadata_json, '$.phase') = 'terminal') = 0))
    )
    SELECT o.*, p.turn_run_id IS NOT NULL AS agent_activity_pending
    FROM ordered_messages o
    LEFT JOIN pending_activity_runs p ON p.turn_run_id = o.turn_run_id
    ${condition ? `WHERE ${condition.sql}${includeMessageId !== undefined ? ' OR id = ?' : ''}` : ''}
    ORDER BY ${timelineProjectionOrderBy('ASC')}${limit === undefined ? '' : ' LIMIT ?'}`, [conversationId, ...(messageId !== undefined ? [messageId] : []),
      conversationId, ...(condition?.params ?? []), ...(condition && includeMessageId !== undefined ? [includeMessageId] : []), ...(limit === undefined ? [] : [limit])]);
  const items = rows.flatMap((row) => {
    const cursor: ChatCanonicalCursor = [row.timeline_order_created_at, row.timeline_order_anchor_id, row.timeline_order_item_index, row.id];
    const message: ChatMessage = { id: row.id, sessionId: row.session_id, text: row.text,
      agentId: row.agent_id,
      isMe: row.is_me === 1, isRead: true, senderType: row.sender_type, time: row.time, createdAt: row.created_at,
      showTimeSeparatorBefore: false, status: row.status, deliveryStatus: row.delivery_status,
      metadataJson: row.metadata_json, replyToText: row.reply_to_text, logicalMessageId: row.logical_message_id };
    const item = projectChatContextMessage(message, cursor);
    if (item && group) {
      const metadata = row.metadata_json === null ? {} : JSON.parse(row.metadata_json);
      const member = members.find((candidate) => candidate.aiAssistantId === metadata.actorAIId || candidate.agentId === (metadata.actorAgentId ?? row.agent_id));
      item.actor = { assistantId: message.isMe ? null : member?.aiAssistantId ?? metadata.actorAIId ?? null,
        agentId: message.isMe ? null : member?.agentId ?? metadata.actorAgentId ?? row.agent_id,
        name: message.isMe ? '用户' : member?.name ?? metadata.actorName ?? 'AI' };
      item.content = buildGroupMentionModelText(item.content, message, members);
      item.message = message;
      item.groupPlanId = metadata.groupChat?.planId ?? null;
    }
    // 整个自主 run 在终态前仍可追加条目，不能只保护当前正在流式写入的那一行。
    return item ? [{ ...item, ...(row.agent_activity_pending ? { pending: true as const } : {}) }] : [];
  });
  const last = rows.at(-1);
  return { items, hasMore: limit !== undefined && rows.length === limit,
    nextCursor: last ? [last.timeline_order_created_at, last.timeline_order_anchor_id, last.timeline_order_item_index, last.id] : null };
}

async function readPrimaryRange(db: DatabaseReadExecutor, conversationId: string, fromCursor: ChatCanonicalCursor | null,
  calls: CallSummarySource[], batchSize: number, replyCursor: number, recentWindowLimit: number) {
  const items: ChatContextItem[] = [];
  let after = fromCursor;
  let limit = Math.max(128, batchSize + recentWindowLimit + 1);
  while (true) {
    const page = await readItemPage(db, conversationId, { after, limit });
    items.push(...page.items);
    const protectedIndex = items.findIndex(item => item.pending === true
      || (item.kind === 'dialogue' && item.role === 'user' && item.messageId > replyCursor));
    const available = protectedIndex < 0 ? items : items.slice(0, protectedIndex);
    const protectedAt = protectedIndex < 0 ? null : items[protectedIndex].cursor[0];
    const timeline = buildConversationTimeline(available, calls);
    const eligible = protectedAt === null ? timeline : timeline.filter(item => item.source === 'chat' || item.timestamp < protectedAt);
    const messages = selectSummaryRange(eligible, batchSize, recentWindowLimit);
    const messageIds = new Set(messages.map(message => message.messageId));
    const selectedChat = available.filter(item => messageIds.has(item.messageId));
    // 已读到批次之后的原文才有完整边界；否则继续分页，避免拆开逻辑分段或漏掉通话内的消息。
    if (!page.hasMore || protectedIndex >= 0 || (messages.length > 0 && selectedChat.length < available.length)) {
      return { messages, selectedChat };
    }
    after = page.nextCursor!;
    limit *= 2;
  }
}
async function saveSettings(tx: DatabaseTransactionExecutor, conversationId: string, settings: ChatSummarySettings) {
  await readState(tx, conversationId);
  await tx.runAsync(`INSERT INTO chat_summary_settings
    (conversation_id, enabled, inject_enabled, fixed_message_id, secondary_enabled, secondary_token_threshold)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET enabled = excluded.enabled,
    inject_enabled = excluded.inject_enabled, fixed_message_id = excluded.fixed_message_id,
    secondary_enabled = excluded.secondary_enabled, secondary_token_threshold = excluded.secondary_token_threshold`,
  [conversationId, Number(settings.generationEnabled), Number(settings.injectEnabled), settings.fixedMessageId,
    Number(settings.secondaryEnabled), settings.secondaryTokenThreshold]);
  await tx.runAsync(`INSERT INTO chat_summary_request_settings (conversation_id,timeout_seconds,max_output_tokens,model_config_id,group_trigger_count,primary_limit)
    VALUES (?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET timeout_seconds = excluded.timeout_seconds,
    max_output_tokens = excluded.max_output_tokens, model_config_id = excluded.model_config_id,
    group_trigger_count = excluded.group_trigger_count, primary_limit = excluded.primary_limit`,
    [conversationId, settings.requestTimeoutSeconds, settings.maxOutputTokens, settings.modelConfigId,
    settings.groupTriggerCount, settings.primaryLimit]);
  await tx.runAsync(`UPDATE chat_summary_tasks SET status = 'waiting', manual_retry = last_manual, next_attempt_at = NULL, updated_at = ?
    WHERE conversation_id = ? AND status = 'running'`, [new Date().toISOString(), conversationId]);
  // 固定范围与摘要进度独立；设置提交后迟到的模型结果不能推进原游标。
  await tx.runAsync(`UPDATE chat_summary_state SET generation = generation + 1, revision = revision + 1,
    claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL WHERE conversation_id = ?`, [conversationId]);
}
async function insertSegment(tx: DatabaseTransactionExecutor, conversationId: string, id: string, content: string,
  now: string, timeZone: string, claim: ChatSummaryClaim | null, messages: readonly ConversationContextItem[],
  seen: Set<string>): Promise<void> {
  const times = messages.map((message) => message.timestamp).sort();
  let count = 0;
  for (const message of messages) {
    if (message.logicalIdentity !== null && !seen.has(message.logicalIdentity)) {
      seen.add(message.logicalIdentity); count++;
    }
  }
  const sequence = await tx.getFirstAsync<{ next_sequence: number }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM chat_summary_segments WHERE conversation_id = ?', [conversationId]);
  await tx.runAsync(`INSERT INTO chat_summary_segments
    (id, conversation_id, sequence, content, from_cursor, to_cursor, message_count, batch_size, source_start_at, source_end_at, time_zone, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, conversationId, sequence!.next_sequence, content, claim?.fromCursor ? JSON.stringify(claim.fromCursor) : null,
    claim?.toCursor ? JSON.stringify(claim.toCursor) : null, count, claim?.batchSize ?? null,
    times[0] ?? null, times[times.length - 1] ?? null, timeZone, now, now]);
}
export class SQLiteChatSummaryRepository implements ChatSummaryRepository {
  constructor(private readonly readCalls: CallSourceReader) {}
  async captureGroupHistoryInTransaction(tx: DatabaseTransactionExecutor, groupId: string, groupName: string): Promise<ChatBackgroundContext> {
    const settings = await readSettings(tx, groupId);
    const raw = (await readItems(tx, groupId)).filter(item => item.pending !== true);
    // 保存可读历史，不复制可操作的媒体快照；原群删除后不保留悬空的媒体所有权。
    const timeline = buildConversationTimeline(raw, []).map(({ sharedRecord: _record, sharedComment: _comment, sharedMoment: _moment, ...item }) => item);
    return { conversationId: groupId, kind: 'group', name: groupName, timeline,
      summaryInjectionEnabled: settings.injectEnabled,
      contextSegments: selectContextSegments(await readSegments(tx, groupId), { ...settings, injectEnabled: true }) };
  }
  async invalidateModelReferencesInTransaction(transaction: DatabaseTransactionExecutor, modelConfigId: string): Promise<void> {
    await this.invalidateConversationsInTransaction(transaction,
      'SELECT conversation_id FROM chat_summary_request_settings WHERE model_config_id = ?', [modelConfigId]);
  }

  async invalidateServiceReferencesInTransaction(transaction: DatabaseTransactionExecutor, serviceConfigId: string): Promise<void> {
    // 显式摘要资产由资产 owner 撤销；此处只处理跟随角色或管理员的会话。
    await this.invalidateConversationsInTransaction(transaction, `SELECT s.id AS conversation_id FROM sessions s
      JOIN ai_assistants a ON a.id = s.ai_assistant_id
      LEFT JOIN chat_summary_request_settings r ON r.conversation_id = s.id
      WHERE a.service_config_id = ? AND r.model_config_id IS NULL
      UNION SELECT a.group_id AS conversation_id FROM group_chat_admin_configs a
      LEFT JOIN chat_summary_request_settings r ON r.conversation_id = a.group_id
      WHERE a.service_config_id = ? AND r.model_config_id IS NULL`, [serviceConfigId, serviceConfigId]);
  }

  private async invalidateConversationsInTransaction(transaction: DatabaseTransactionExecutor, sources: string, values: string[]): Promise<void> {
    // 尚未领取过的会话也可能因缺少模型而待机，不能只依靠已有 state 的资格撤销来入队。
    await transaction.runAsync(`INSERT INTO chat_summary_work_queue (conversation_id)
      SELECT conversation_id FROM (${sources}) WHERE true
      ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1`, values);
    await transaction.runAsync(`UPDATE chat_summary_state SET generation = generation + 1, revision = revision + 1,
      claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL WHERE conversation_id IN (${sources})`, values);
    await transaction.runAsync(`UPDATE chat_summary_tasks SET status = 'waiting', automatic_failures = 0, manual_retry = 0,
      next_attempt_at = NULL WHERE conversation_id IN (${sources}) AND status <> 'completed'`, values);
  }

  async readBackgroundContexts(assistantId: string, currentConversationId: string, options: ChatBackgroundContextOptions) {
    return executor('backgroundContext', 'interactive').withExclusiveTransactionAsync(async (tx) => {
      // 身份、当前成员关系、摘要与近期原文共享快照；客读取不触碰来源状态和游标。
      const sources = await tx.getAllAsync<{ id: string; kind: 'direct' | 'group'; name: string }>(`SELECT s.id AS id, 'direct' AS kind, a.name AS name
        FROM sessions s JOIN ai_assistants a ON a.id = s.ai_assistant_id
        WHERE s.ai_assistant_id = ? AND s.id <> ? AND ? > 0
        UNION ALL SELECT g.id AS id, 'group' AS kind, g.name AS name FROM group_chats g
        JOIN group_chat_members m ON m.group_id = g.id
        WHERE m.ai_assistant_id = ? AND m.enabled = 1 AND g.id <> ? AND ? > 0
        ORDER BY kind, id`, [assistantId, currentConversationId, options.privateLimit, assistantId, currentConversationId, options.groupLimit]);
      const contexts: ChatBackgroundContext[] = [];
      for (const source of sources) {
        const settings = await readSettings(tx, source.id);
        const raw = (await readItems(tx, source.id)).filter((item) => item.pending !== true
          && (options.upperBound === undefined || item.messageId <= options.upperBound.messageId));
        const boundary = await readCallBoundary(tx, source.id);
        const calls = source.kind === 'direct' ? await this.readCalls(tx, source.id, { ...boundary, processedCallIds: [] }) : [];
        const timeline = buildConversationTimeline(raw, calls).filter((item) => options.upperBound === undefined
          || item.source === 'chat' || item.timestamp <= options.upperBound.createdAt);
        const limit = source.kind === 'direct' ? options.privateLimit : options.groupLimit;
        const seen = new Set<string>();
        let start = 0;
        for (let index = timeline.length - 1; index >= 0; index--) {
          const identity = timeline[index].logicalIdentity;
          if (identity === null) continue;
          if (!seen.has(identity) && seen.size === limit) { start = index + 1; break; }
          seen.add(identity);
        }
        contexts.push({ conversationId: source.id, kind: source.kind, name: source.name, timeline: timeline.slice(start),
          contextSegments: selectContextSegments(await readSegments(tx, source.id, options.upperBound), settings) });
      }
      if (options.groupLimit > 0) {
        const histories = await tx.getAllAsync<{ context_json: string; exited_at: string }>(`SELECT h.context_json, h.exited_at
          FROM group_chat_history h WHERE h.ai_assistant_id = ? AND h.inject_enabled = 1 AND h.group_id <> ?
          AND NOT EXISTS (SELECT 1 FROM group_chat_members m WHERE m.group_id = h.group_id AND m.ai_assistant_id = h.ai_assistant_id AND m.enabled = 1)
          ORDER BY h.group_id`, [assistantId, currentConversationId]);
        for (const row of histories) {
          if (options.upperBound && row.exited_at > options.upperBound.createdAt) continue;
          const frozen: ChatBackgroundContext = JSON.parse(row.context_json);
          const timeline = frozen.timeline.filter(item => !options.upperBound || item.messageId! <= options.upperBound.messageId);
          const seen = new Set<string>();
          let start = 0;
          for (let index = timeline.length - 1; index >= 0; index--) {
            const identity = timeline[index].logicalIdentity;
            if (identity === null) continue;
            if (!seen.has(identity) && seen.size === options.groupLimit) { start = index + 1; break; }
            seen.add(identity);
          }
          contexts.push({ ...frozen, timeline: timeline.slice(start),
            contextSegments: frozen.summaryInjectionEnabled ? frozen.contextSegments : [],
            membership: { status: 'left', exitedAt: row.exited_at } });
        }
      }
      return contexts.sort((a, b) => a.kind.localeCompare(b.kind) || a.conversationId.localeCompare(b.conversationId));
    });
  }

  async readContext(conversationId: string, protectedMessageIds: readonly number[]) {
    return executor('context', 'interactive').withExclusiveTransactionAsync(async (tx) => {
      const state = await readState(tx, conversationId);
      const settings = await readSettings(tx, conversationId);
      const segments = await readSegments(tx, conversationId);
      const fixed = settings.fixedMessageId === null ? null : (await readItems(tx, conversationId, { messageId: settings.fixedMessageId }))[0];
      if (settings.fixedMessageId !== null && !fixed) throw new Error('固定起点不在当前可见的对话范围内');
      const raw = await readItems(tx, conversationId, { after: fixed ? fixed.cursor
        : settings.generationEnabled ? parseChatContextCursor(state.processed_cursor) : null,
        ...(fixed ? { includeMessageId: fixed.messageId } : {}) });
      const protectedIds = new Set(protectedMessageIds);
      const visible = raw.filter((item) => !protectedIds.has(item.messageId));
      const boundary = await readCallBoundary(tx, conversationId);
      const calls = await this.readCalls(tx, conversationId, settings.generationEnabled ? boundary : { ...boundary, processedCallIds: [] });
      const buildTimeline = (items: ChatContextItem[]) => buildConversationTimeline(items, calls)
        .filter((item) => !fixed || item.source === 'chat' || item.timestamp >= fixed.cursor[0]);
      const tasks = (await tx.getAllAsync<TaskRow>('SELECT * FROM chat_summary_tasks WHERE conversation_id = ? ORDER BY created_at,id', [conversationId])).map(mapTask);
      return { tasks, segments, settings, contextSegments: selectContextSegments(segments, settings), raw: visible,
        pendingCalls: calls, timeline: buildTimeline(visible), fixedStart: fixed ? { messageId: fixed.messageId,
          content: fixed.content, messageCount: new Set(buildTimeline(raw).flatMap((item) => item.logicalIdentity === null ? [] : [item.logicalIdentity])).size } : null };
    });
  }
  async prepareConversations(now: string, conversationIds?: readonly string[]) {
    return executor('prepareConversations').withExclusiveTransactionAsync(async (tx) => {
      // 旧版本可能还在等待第三次请求；扫描先按当前预算收口，保留手动意图与有效在途请求。
      const exhausted = await tx.getAllAsync<{ id: string; conversation_id: string }>(`SELECT t.id,t.conversation_id FROM chat_summary_tasks t
        WHERE t.status <> 'completed' AND t.automatic_failures >= ? AND t.manual_retry = 0 ${conversationIds ? 'AND t.conversation_id IN (SELECT value FROM json_each(?))' : ''}
        AND (t.status = 'waiting' OR (t.status = 'running' AND t.last_manual = 0
          AND NOT EXISTS (SELECT 1 FROM chat_summary_state s WHERE s.conversation_id = t.conversation_id AND s.claim_id IS NOT NULL AND s.claim_expires_at > ?)))`,
      [CHAT_SUMMARY_MAX_AUTOMATIC_ATTEMPTS, ...(conversationIds ? [JSON.stringify(conversationIds)] : []), now]);
      for (const task of exhausted) await tx.runAsync("UPDATE chat_summary_tasks SET status = 'failed', next_attempt_at = NULL, updated_at = ? WHERE id = ?", [now, task.id]);
      // 启动只消费持久待检查身份、到期重试和中断任务；显式未完成条件命中部分索引，跳过完成历史。
      const rows = await tx.getAllAsync<{ id: string }>(`WITH pending AS (
        SELECT conversation_id FROM chat_summary_work_queue WHERE revision > checked_revision
        UNION SELECT t.conversation_id FROM chat_summary_tasks t
          LEFT JOIN chat_summary_state s ON s.conversation_id = t.conversation_id
          LEFT JOIN chat_summary_settings settings ON settings.conversation_id = t.conversation_id
          WHERE t.status <> 'completed' AND (t.level = 'primary' OR COALESCE(settings.secondary_enabled,1) = 1) AND (
            (t.status = 'waiting' AND (t.manual_retry = 1 OR t.next_attempt_at IS NULL OR t.next_attempt_at <= ?))
            OR (t.status = 'running' AND (s.claim_id IS NULL OR s.claim_expires_at <= ?)))
      ) SELECT p.conversation_id AS id FROM pending p
        LEFT JOIN chat_summary_settings settings ON settings.conversation_id = p.conversation_id
        WHERE COALESCE(settings.enabled,1) = 1
        ${conversationIds ? 'AND p.conversation_id IN (SELECT value FROM json_each(?))' : ''}
        ORDER BY p.conversation_id`, [now, now, ...(conversationIds ? [JSON.stringify(conversationIds)] : [])]);
      return { conversationIds: rows.map((row) => row.id), pausedConversationIds: [...new Set(exhausted.map((task) => task.conversation_id))] };
    });
  }
  async readQueuedRevision(conversationId: string): Promise<number | null> {
    const row = await executor('queuedRevision').getFirstAsync<{ revision: number }>(
      'SELECT revision FROM chat_summary_work_queue WHERE conversation_id = ? AND revision > checked_revision', [conversationId]);
    return row === null ? null : row.revision;
  }
  async acknowledgeQueuedRevision(conversationId: string, revision: number): Promise<void> {
    // 只推进本轮看见的水位；检查期间的新消息继续保持待处理，旧消费者也不能回退水位。
    await executor('checked').runAsync(`UPDATE chat_summary_work_queue SET checked_revision = ?
      WHERE conversation_id = ? AND checked_revision < ?`, [revision, conversationId, revision]);
  }
  async claim(conversationId: string, batchSize: number, claimId: string, now: string, expiresAt: string, timeZone: string, recentWindowLimit: number): Promise<ChatSummaryClaim | null> {
    return executor('claim').withExclusiveTransactionAsync(async (tx) => {
      const state = await readState(tx, conversationId);
      const settings = await readSettings(tx, conversationId);
      if (!settings.generationEnabled) return null;
      const task = await readPendingTask(tx, conversationId, 'primary');
      if (!canStartTask(task, now)) return null;
      const group = await tx.getFirstAsync<{ id: string }>('SELECT id FROM group_chats WHERE id = ?', [conversationId]);
      if (group && await tx.getFirstAsync(`SELECT id FROM group_speech_plans WHERE group_id = ?
        AND status IN ('pending','preparing','running') LIMIT 1`, [conversationId])) return null;
      if (state.claim_id !== null && state.claim_expires_at! > now) return null;
      if (state.claim_id !== null) await tx.runAsync('UPDATE chat_summary_state SET claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL WHERE conversation_id = ?', [conversationId]);
      const calls = await this.readCalls(tx, conversationId, await readCallBoundary(tx, conversationId));
      // 通话状态和原文在同一数据库快照读取，不能把 UI 的通话布尔值当业务锁。
      if (calls.some((call) => call.info.endedAt === null)) return null;
      const fromCursor = parseChatContextCursor(state.processed_cursor);
      const turn = group ? await tx.getFirstAsync<{ reply_cursor: number }>(`SELECT COALESCE(MAX(last_included_message_id),0) AS reply_cursor
        FROM group_speech_plans WHERE group_id = ? AND status IN ('completed','failed','terminated','superseded')`, [conversationId])
        : await tx.getFirstAsync<{ reply_cursor: number }>('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?', [conversationId]);
      const effectiveBatchSize = group ? settings.groupTriggerCount : batchSize;
      const { messages, selectedChat } = await readPrimaryRange(tx, conversationId, fromCursor, calls, effectiveBatchSize, turn?.reply_cursor ?? 0, recentWindowLimit);
      if (!messages.length) return null;
      const toCursor = selectedChat.length ? selectedChat[selectedChat.length - 1].cursor : fromCursor;
      const callIds = new Set(messages.map((message) => message.callId));
      const taskId = await beginTask(tx, conversationId, 'primary', claimId, now, task);
      const claim: ChatSummaryClaim = { conversationId, claimId, generation: state.generation, revision: state.revision,
        requestSettings: requestSettings(settings),
        taskId,
        fromCursor, toCursor, batchSize: effectiveBatchSize, messages, calls: calls.filter((call) => callIds.has(call.info.callId)),
        previous: selectContextSegments(await readSegments(tx, conversationId), { ...settings, injectEnabled: true }), timeZone };
      await tx.runAsync('UPDATE chat_summary_state SET claim_id = ?, claim_to_cursor = ?, claim_expires_at = ? WHERE conversation_id = ?',
        [claimId, claimKey(claim), expiresAt, conversationId]);
      return claim;
    });
  }
  async appendClaim(claim: ChatSummaryClaim, additions: readonly ChatSummaryAddition[], now: string) {
    return executor('append').withExclusiveTransactionAsync(async (tx) => {
      const result = await tx.runAsync(`UPDATE chat_summary_state SET processed_cursor = ?, revision = revision + 1,
        claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL
        WHERE conversation_id = ? AND generation = ? AND claim_id = ? AND claim_to_cursor = ? AND claim_expires_at > ?`,
      [claim.toCursor === null ? null : JSON.stringify(claim.toCursor), claim.conversationId,
        claim.generation, claim.claimId, claimKey(claim), now]);
      if (!result.changes) return false;
      // 一次调用完成后同事务交接正文、游标与已处理通话标记；失败整体回滚，不暴露半通电话或原文空洞。
      const seen = new Set<string>();
      for (const addition of additions) await insertSegment(tx, claim.conversationId, addition.id, addition.content,
        now, claim.timeZone, claim, addition.messages, seen);
      for (const call of claim.calls) await tx.runAsync('INSERT INTO chat_summary_processed_calls (conversation_id, call_id) VALUES (?, ?)',
        [claim.conversationId, call.info.callId]);
      await completeTask(tx, claim.taskId, additions.map((addition) => addition.id), now);
      return true;
    });
  }
  async releaseClaim(claim: ChatSummaryClaim) {
    await this.releaseTaskClaim(claim);
  }
  readSettings(conversationId: string) { return readSettings(executor('settings'), conversationId); }
  async updateSettings(conversationId: string, patch: ChatSummarySettingsPatch) {
    await executor('settings').withExclusiveTransactionAsync(async (tx) => {
      const settings = { ...await readSettings(tx, conversationId), ...patch };
      if (settings.fixedMessageId !== null && settings.generationEnabled) throw new Error('请先取消固定消息起点，再开启一级摘要');
      await saveSettings(tx, conversationId, settings);
      if (patch.requestTimeoutSeconds !== undefined || patch.maxOutputTokens !== undefined || patch.modelConfigId !== undefined
        || patch.primaryLimit !== undefined) {
        await tx.runAsync(`UPDATE chat_summary_tasks SET status = 'waiting', manual_retry = 0, automatic_failures = 0, next_attempt_at = NULL
          WHERE conversation_id = ? AND status IN ('failed','waiting')`, [conversationId]);
      }
    });
  }
  async setFixedStart(conversationId: string, messageId: number | null) {
    await executor('fixedStart').withExclusiveTransactionAsync(async (tx) => {
      if (messageId !== null) {
        const item = (await readItems(tx, conversationId, { messageId }))[0];
        if (!item || item.kind !== 'dialogue' || item.pending === true) throw new Error('只能固定当前会话已发送的对话消息');
      }
      const settings = await readSettings(tx, conversationId);
      await saveSettings(tx, conversationId, { ...settings, fixedMessageId: messageId,
        ...(messageId !== null ? { generationEnabled: false } : {}) });
    });
  }
  async claimSecondary(conversationId: string, claimId: string, now: string, expiresAt: string, timeZone: string): Promise<SecondaryChatSummaryClaim | null> {
    return executor('secondaryClaim').withExclusiveTransactionAsync(async (tx) => {
      const settings = await readSettings(tx, conversationId);
      if (!settings.generationEnabled || !settings.secondaryEnabled) return null;
      const state = await readState(tx, conversationId);
      if (state.claim_id !== null && state.claim_expires_at! > now) return null;
      const task = await readPendingTask(tx, conversationId, 'secondary');
      if (!canStartTask(task, now)) return null;
      const segments = (await readSegments(tx, conversationId)).filter((segment) => segment.level === 'primary' && segment.compactionId === null);
      if (!segments.length) return null;
      const manual = task && (task.manual_retry === 1 || (task.status === 'running' && task.last_manual === 1));
      if (!manual && segments.reduce((sum, segment) => sum + estimateTextTokens(segment.content), 0) < settings.secondaryTokenThreshold) return null;
      const claim = { conversationId, claimId, generation: state.generation, segments, timeZone, requestSettings: requestSettings(settings) };
      const taskId = await beginTask(tx, conversationId, 'secondary', claimId, now, task);
      await tx.runAsync('UPDATE chat_summary_state SET claim_id = ?, claim_to_cursor = ?, claim_expires_at = ? WHERE conversation_id = ?',
        [claimId, 'secondary', expiresAt, conversationId]);
      return { ...claim, taskId };
    });
  }
  async appendSecondary(claim: SecondaryChatSummaryClaim, segmentId: string, content: string | null, now: string) {
    return executor('secondaryAppend').withExclusiveTransactionAsync(async (tx) => {
      const current = new Map((await readSegments(tx, claim.conversationId)).map((segment) => [segment.id, segment]));
      // 只比较领取的来源，生成期间新增的第七批不会使前六批失效；编辑、删除来源则拒绝旧结果。
      if (!claim.segments.every((source) => {
        const segment = current.get(source.id);
        return segment !== undefined && segment.level === 'primary' && segment.compactionId === null
          && segment.content === source.content && segment.updatedAt === source.updatedAt;
      })) return false;
      const result = await tx.runAsync(`UPDATE chat_summary_state SET revision = revision + 1,
        claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL
        WHERE conversation_id = ? AND generation = ? AND claim_id = ? AND claim_to_cursor = 'secondary' AND claim_expires_at > ?`,
      [claim.conversationId, claim.generation, claim.claimId, now]);
      if (!result.changes) return false;
      if (content !== null) {
        await insertSegment(tx, claim.conversationId, segmentId, content, now, claim.timeZone, null, [], new Set());
        const starts = claim.segments.flatMap((segment) => segment.sourceStartAt === null ? [] : [segment.sourceStartAt]);
        const ends = claim.segments.flatMap((segment) => segment.sourceEndAt === null ? [] : [segment.sourceEndAt]);
        // 客视角的执行输入上界也约束摘要；二级保留领取来源的最大消息边界。
        const cursor = await tx.getFirstAsync<{ to_cursor: string | null }>(`SELECT to_cursor FROM chat_summary_segments
          WHERE id IN (${claim.segments.map(() => '?').join(',')}) AND to_cursor IS NOT NULL
          ORDER BY json_extract(to_cursor,'$[3]') DESC LIMIT 1`, claim.segments.map((source) => source.id));
        await tx.runAsync(`UPDATE chat_summary_segments SET level = 'secondary', context_sequence = ?, source_start_at = ?, source_end_at = ?, to_cursor = ? WHERE id = ?`,
          [claim.segments[0].sequence, starts.length ? starts.sort()[0] : null, ends.length ? ends.sort().at(-1)! : null, cursor?.to_cursor ?? null, segmentId]);
      }
      for (const source of claim.segments) await tx.runAsync('UPDATE chat_summary_segments SET compaction_id = ? WHERE id = ?', [segmentId, source.id]);
      await completeTask(tx, claim.taskId, content === null ? [] : [segmentId], now);
      return true;
    });
  }
  async releaseSecondaryClaim(claim: SecondaryChatSummaryClaim) {
    await this.releaseTaskClaim(claim);
  }
  private async releaseTaskClaim(claim: ChatSummaryTaskClaim) {
    await executor('release').withExclusiveTransactionAsync(async (tx) => {
      const released = await tx.runAsync(`UPDATE chat_summary_state SET claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL
        WHERE conversation_id = ? AND generation = ? AND claim_id = ?`, [claim.conversationId, claim.generation, claim.claimId]);
      if (released.changes) await tx.runAsync(`UPDATE chat_summary_tasks SET status = 'waiting', manual_retry = last_manual
        WHERE id = ? AND status = 'running'`, [claim.taskId]);
    });
  }
  async recordInvocation(claim: ChatSummaryTaskClaim, diagnostics: ChatSummaryCallDiagnostics, now: string) {
    await executor('diagnostics').withExclusiveTransactionAsync(async (tx) => {
      const state = await readState(tx, claim.conversationId);
      if (state.generation !== claim.generation || state.claim_id !== claim.claimId) return;
      const task = (await tx.getFirstAsync<TaskRow>('SELECT * FROM chat_summary_tasks WHERE id = ?', [claim.taskId]))!;
      const calls = JSON.parse(task.calls_json) as ChatSummaryCallDiagnostics[];
      calls.push(diagnostics);
      await tx.runAsync('UPDATE chat_summary_tasks SET calls_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(calls), now, claim.taskId]);
    });
  }
  async failTask(claim: ChatSummaryTaskClaim, failure: ChatSummaryFailure, now: string) {
    return executor('failure').withExclusiveTransactionAsync(async (tx) => {
      const state = await readState(tx, claim.conversationId);
      if (state.generation !== claim.generation || state.claim_id !== claim.claimId) return null;
      const task = (await tx.getFirstAsync<TaskRow>('SELECT * FROM chat_summary_tasks WHERE id = ?', [claim.taskId]))!;
      const failures = task.automatic_failures + (task.last_manual === 0 ? 1 : 0);
      const retry = task.last_manual === 0 && failure.retryable && failures < CHAT_SUMMARY_MAX_AUTOMATIC_ATTEMPTS;
      const nextAt = retry ? new Date(Date.parse(now) + 120_000).toISOString() : null;
      await tx.runAsync(`UPDATE chat_summary_tasks SET status = ?, automatic_failures = ?, next_attempt_at = ?, error_json = ?, updated_at = ? WHERE id = ?`,
        [retry ? 'waiting' : 'failed', failures, nextAt, JSON.stringify({ ...failure, occurredAt: now }), now, claim.taskId]);
      return retry ? 'waiting' as const : 'failed' as const;
    });
  }
  async retryTask(conversationId: string, taskId: string, now: string) {
    await executor('manualRetry').withExclusiveTransactionAsync(async (tx) => {
      const settings = await readSettings(tx, conversationId);
      const task = await tx.getFirstAsync<TaskRow>('SELECT * FROM chat_summary_tasks WHERE id = ? AND conversation_id = ?', [taskId, conversationId]);
      if (!task || !['failed','waiting'].includes(task.status)) throw new Error('这个任务当前不能重试');
      if (!settings.generationEnabled || (task.level === 'secondary' && !settings.secondaryEnabled)) throw new Error('请先开启对应摘要的自动生成');
      if (task.level === 'secondary') {
        const source = await tx.getFirstAsync<{ id: string }>(`SELECT id FROM chat_summary_segments
          WHERE conversation_id = ? AND level = 'primary' AND compaction_id IS NULL LIMIT 1`, [conversationId]);
        if (!source) throw new Error('待归纳的一级摘要已不存在，无法重试');
      }
      await tx.runAsync(`UPDATE chat_summary_tasks SET manual_retry = 1, status = 'waiting', next_attempt_at = NULL, updated_at = ? WHERE id = ?`, [now, taskId]);
    });
  }
  async search(assistantId: string, input: ChatSummarySearchInput) {
    const conditions = [assistantSummaryAccess];
    const params: (string | number)[] = [assistantId, assistantId];
    if (input.conversationId !== undefined) { conditions.push('c.conversation_id = ?'); params.push(input.conversationId); }
    if (input.from !== undefined) { conditions.push('COALESCE(c.source_end_at, c.created_at) >= ?'); params.push(input.from); }
    if (input.to !== undefined) { conditions.push('COALESCE(c.source_start_at, c.created_at) <= ?'); params.push(input.to); }
    if (input.keywords?.length) {
      conditions.push('(' + input.keywords.map(() => 'instr(lower(c.content), lower(?)) > 0').join(' OR ') + ')');
      params.push(...input.keywords);
    }
    const offset = input.offset ?? 0;
    const rows = await executor('search').getAllAsync<SegmentRow>(`SELECT c.* FROM chat_summary_segments c
      LEFT JOIN sessions s ON s.id = c.conversation_id WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(c.source_start_at, c.created_at) DESC, c.id LIMIT 21 OFFSET ?`, [...params, offset]);
    // 每次分页读当前事实，不缓存正文，用户删除的摘要不会从旧的运行快照再次返回。
    return { entries: rows.slice(0, 20).map(mapSegment), nextOffset: rows.length > 20 ? offset + 20 : null };
  }
  async readSecondaryForAssistant(assistantId: string, conversationId: string) {
    return assistantSummaryTransaction('readSecondaryForAssistant', async (tx) => {
      await requireAssistantConversation(tx, assistantId, conversationId);
      const segments = (await readSegments(tx, conversationId)).filter((segment) => segment.level === 'secondary');
      return { conversationId, content: combinedSecondaryContent(segments) };
    });
  }
  async editSecondaryForAssistant(assistantId: string, conversationId: string, input: ChatSummaryTextEdit, now: string) {
    return assistantSummaryTransaction('editSecondaryForAssistant', async (tx) => {
      await requireAssistantConversation(tx, assistantId, conversationId);
      const current = (await readSegments(tx, conversationId)).filter((segment) => segment.level === 'secondary');
      const content = editChatSummaryText(combinedSecondaryContent(current), input);
      await replaceSecondaryInTransaction(tx, conversationId, current, content, now);
      return { conversationId, content };
    });
  }
  async editPrimaryForAssistant(assistantId: string, conversationId: string, segmentId: string, input: ChatSummaryTextEdit, now: string) {
    return assistantSummaryTransaction('editPrimaryForAssistant', async (tx) => {
      const segment = await requireAssistantPrimarySegment(tx, assistantId, conversationId, segmentId);
      const content = editChatSummaryText(segment.content, input);
      await editSegmentInTransaction(tx, conversationId, segmentId, content, now);
      return { ...segment, content, updatedAt: now };
    });
  }
  async deletePrimaryForAssistant(assistantId: string, conversationId: string, segmentId: string, expectedContent: string) {
    await assistantSummaryTransaction('deletePrimaryForAssistant', async (tx) => {
      const segment = await requireAssistantPrimarySegment(tx, assistantId, conversationId, segmentId);
      if (segment.content !== expectedContent) throw new ChatSummaryEditError('一级摘要已变化，请重新查询后再删除');
      await deleteSegmentInTransaction(tx, conversationId, segmentId);
    });
  }
  async create(conversationId: string, segmentId: string, content: string, now: string, timeZone: string) {
    await executor('create').withExclusiveTransactionAsync(async (tx) => {
      await readState(tx, conversationId);
      await insertSegment(tx, conversationId, segmentId, content, now, timeZone, null, [], new Set());
      await tx.runAsync('UPDATE chat_summary_state SET revision = revision + 1 WHERE conversation_id = ?', [conversationId]);
    });
  }
  async edit(conversationId: string, segmentId: string, content: string, now: string) {
    await executor('edit').withExclusiveTransactionAsync(async (tx) => {
      await editSegmentInTransaction(tx, conversationId, segmentId, content, now);
    });
  }
  async delete(conversationId: string, segmentId: string) {
    await executor('delete').withExclusiveTransactionAsync(async (tx) => {
      await deleteSegmentInTransaction(tx, conversationId, segmentId);
    });
  }
  async replaceSecondary(conversationId: string, expected: readonly ChatSummarySegment[], content: string | null, now: string) {
    await executor('replaceSecondary').withExclusiveTransactionAsync(async (tx) => {
      const current = (await readSegments(tx, conversationId)).filter((segment) => segment.level === 'secondary');
      const originals = new Map(expected.map((segment) => [segment.id, segment]));
      // 编辑期间新归纳或其他编辑已提交时，保留用户草稿并拒绝覆盖未读到的内容。
      if (!current.length || current.length !== expected.length || !current.every((segment) => {
        const original = originals.get(segment.id);
        return original && segment.content === original.content && segment.updatedAt === original.updatedAt;
      })) throw new Error('二级摘要已更新，请重新打开后再编辑；当前修改未保存。');
      await replaceSecondaryInTransaction(tx, conversationId, current, content, now);
    });
  }
  async clear(conversationId: string) {
    await executor('clear').withExclusiveTransactionAsync(async (tx) => {
      await readState(tx, conversationId);
      const items = await readItems(tx, conversationId, { visibleOnly: false });
      const cursor = items.length ? JSON.stringify(items[items.length - 1].cursor) : null;
      await tx.runAsync('DELETE FROM chat_summary_segments WHERE conversation_id = ?', [conversationId]);
      await tx.runAsync('DELETE FROM chat_summary_tasks WHERE conversation_id = ?', [conversationId]);
      await tx.runAsync(`INSERT INTO chat_summary_call_boundary (conversation_id, cleared_at) VALUES (?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET cleared_at = excluded.cleared_at`, [conversationId, new Date().toISOString()]);
      await tx.runAsync(`UPDATE chat_summary_state SET generation = generation + 1, revision = revision + 1,
        processed_cursor = ?, claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL WHERE conversation_id = ?`, [cursor, conversationId]);
    });
  }
  async getNextWakeAt() {
    // 已到期但暂不可领取的任务等待业务事件唤醒，避免缺配置／通话未结束时形成零延时轮询。
    const row = await executor('nextWake').getFirstAsync<{ wake_at: string | null }>(
      `SELECT MIN(wake_at) AS wake_at FROM (
        SELECT claim_expires_at AS wake_at FROM chat_summary_state WHERE claim_id IS NOT NULL
        UNION ALL SELECT t.next_attempt_at FROM chat_summary_tasks t LEFT JOIN chat_summary_settings s ON s.conversation_id = t.conversation_id
        WHERE t.status = 'waiting' AND COALESCE(s.enabled,1) = 1 AND (t.level = 'primary' OR COALESCE(s.secondary_enabled,1) = 1))
        WHERE wake_at > ?`, [new Date().toISOString()]);
    return row!.wake_at;
  }
}
