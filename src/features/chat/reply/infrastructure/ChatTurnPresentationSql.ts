import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { messageRepository } from '../../messages/infrastructure/SQLiteMessageRepository';
import { buildSessionPreviewTextFromMessage } from '../../messages/domain/chatMessageMetadata';
import type { ChatMessage, CreateMessageInput } from '../../messages/domain/ChatMessage';
import type { ChatTurnDisplaySnapshot } from '../domain/ChatTurnPresentation';

/** 只封存已交付正文；消息成立不要求本轮执行成功，也不推进回复游标或补发通知。 */
export async function finalizeInterruptedTurnMessagesInTransaction(
  transaction: DatabaseTransactionExecutor,
  sessionId?: string,
  runId?: string,
): Promise<void> {
  const runs = await transaction.getAllAsync<{ run_id: string; session_id: string; anchor_id: number; anchor_created_at: string }>(
    `SELECT p.run_id, p.session_id,
       CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END AS anchor_id,
       COALESCE(origin.created_at, r.created_at) AS anchor_created_at FROM chat_turn_presentations p
     JOIN conversation_turn_runs r ON r.run_id = p.run_id
     JOIN sessions s ON s.id = p.session_id
     LEFT JOIN messages origin ON origin.session_id = p.session_id AND
       ((r.kind = 'autonomous' AND origin.client_message_id = 'agent_activity:' || r.run_id || ':started')
         OR (r.kind <> 'autonomous' AND origin.id = r.input_high_watermark))
     WHERE p.state = 'interrupted' AND (r.kind <> 'regenerate' OR r.status = 'committed')
       AND CASE WHEN r.kind = 'autonomous' THEN origin.id ELSE r.input_high_watermark END > COALESCE(s.visible_after_message_id, 0)
       ${sessionId ? 'AND p.session_id = ?' : ''} ${runId ? 'AND p.run_id = ?' : ''}
       AND EXISTS (SELECT 1 FROM chat_turn_display_items i WHERE i.run_id = p.run_id
         AND json_extract(i.shown_json, '$.kind') = 'assistant' AND length(json_extract(i.shown_json, '$.text')) > 0)
       AND EXISTS (SELECT 1 FROM chat_turn_display_items i WHERE i.run_id = p.run_id AND i.shown_json IS NOT NULL
         AND (i.message_id IS NULL OR json_extract(i.shown_json, '$.text') <> json_extract(i.snapshot_json, '$.text')))
     ORDER BY r.created_at, r.rowid`, [...(sessionId ? [sessionId] : []), ...(runId ? [runId] : [])]);
  for (const run of runs) {
    // 同毫秒的新输入可能已经落库；以原任务定位锚定旧回复，不能让封存插入顺序重写对话顺序。
    await transaction.runAsync(`INSERT OR IGNORE INTO chat_timeline_run_anchors(session_id, turn_run_id, id, created_at)
      VALUES (?, ?, ?, ?)`, [run.session_id, run.run_id, run.anchor_id, run.anchor_created_at]);
    const anchor = await transaction.getFirstAsync<{ id: number; created_at: string }>(
      'SELECT id, created_at FROM chat_timeline_run_anchors WHERE session_id = ? AND turn_run_id = ?', [run.session_id, run.run_id]);
    const owner = await transaction.getFirstAsync<{ agent_id: string | null }>(`SELECT a.agent_id FROM sessions s
      LEFT JOIN ai_assistants a ON a.id = s.ai_assistant_id WHERE s.id = ?`, [run.session_id]);
    const rows = await transaction.getAllAsync<{ identity: string; message_id: number | null; shown_json: string;
      snapshot_json: string; is_read: number }>(`SELECT identity, message_id, shown_json, snapshot_json, is_read
      FROM chat_turn_display_items WHERE run_id = ? AND shown_json IS NOT NULL
      ORDER BY json_extract(shown_json, '$.sequence'), COALESCE(json_extract(shown_json, '$.segmentIndex'), 0)`, [run.run_id]);
    let lastAssistant: ChatMessage | undefined;
    for (const [index, row] of rows.entries()) {
      const shown: ChatTurnDisplaySnapshot = JSON.parse(row.shown_json);
      const latest: ChatTurnDisplaySnapshot = JSON.parse(row.snapshot_json);
      const metadata = shown.metadataJson ? JSON.parse(shown.metadataJson) : {};
      const message: CreateMessageInput = {
        sessionId: run.session_id, agentId: owner!.agent_id, clientMessageId: row.identity,
        text: shown.text, senderType: shown.kind === 'tool' ? 'system' : shown.kind, isMe: false,
        isRead: row.is_read === 1, createdAt: shown.createdAt, time: shown.time, status: 'sent',
        apiMessageId: shown.apiMessageId, turnRunId: run.run_id, turnItemIndex: index + 1,
        timelineAnchor: { id: anchor!.id, createdAt: anchor!.created_at },
        logicalMessageId: `agent-timeline:${run.run_id}:step:${shown.stepIndex}`,
        segmentIndex: shown.segmentIndex ?? 0, tokensUsed: shown.tokensUsed,
        promptTokens: shown.promptTokens, completionTokens: shown.completionTokens,
        metadataJson: JSON.stringify({ ...metadata, interrupted: true, timelineSequence: shown.sequence,
          timelineAnchor: { id: anchor!.id, createdAt: anchor!.created_at },
          stepIndex: shown.stepIndex, cachedTokens: shown.cachedTokens,
          ...(shown.kind === 'tool' ? { type: 'toolStatus', status: shown.status === 'streaming' ? 'running' : shown.status,
            toolNames: shown.toolNames, displayNames: shown.toolDisplayNames, displayText: shown.text,
            toolExecutions: latest.toolExecutions, source: 'chatToolFlow' } : {}),
        }),
      };
      let saved: ChatMessage;
      if (row.message_id === null) {
        [saved] = await messageRepository.commitMessagesInTransaction(transaction, { messages: [message], previewText: null });
      } else {
        // T3 后仍可能只交付了一部分正文；保留原 ID，只采用用户已经收到的版本。
        await transaction.runAsync(`UPDATE messages SET text = ?, status = 'sent', metadata_json = ?,
          tokens_used = ?, prompt_tokens = ?, completion_tokens = ?, turn_item_index = COALESCE(turn_item_index, ?)
          WHERE id = ?`, [message.text, message.metadataJson!, shown.tokensUsed ?? 0, shown.promptTokens ?? 0,
          shown.completionTokens ?? 0, index + 1, row.message_id]);
        saved = (await messageRepository.getMessageByIdInTransaction(transaction, row.message_id))!;
      }
      // 工具的最新结果证据继续留在原始快照中；封存只裁定可见正文，不改写已发生的业务结果。
      const sealed = { ...shown, status: shown.kind === 'tool' ? shown.status : 'sent', metadataJson: message.metadataJson };
      await transaction.runAsync(`UPDATE chat_turn_display_items SET message_id = ?,
        snapshot_json = ?, shown_json = ? WHERE run_id = ? AND identity = ?`,
      [saved.id, JSON.stringify({ ...latest, ...sealed, status: shown.kind === 'tool' ? latest.status : sealed.status,
        toolExecutions: latest.toolExecutions }), JSON.stringify(sealed), run.run_id, row.identity]);
      if (saved.senderType === 'assistant') lastAssistant = saved;
    }
    if (lastAssistant) await messageRepository.updateSessionPreviewForCommittedMessageInTransaction(transaction, {
      sessionId: run.session_id, messageId: lastAssistant.id, previewText: buildSessionPreviewTextFromMessage(lastAssistant),
    });
  }
}

/** 展示事实在 T1/T4 原事务收口；新输入只放行通过 T3 的剩余分段。 */
export async function interruptTurnPresentationsInTransaction(
  transaction: DatabaseTransactionExecutor,
  sessionId: string,
  reason: string,
  runId?: string,
): Promise<void> {
  if (reason === 'new_input') {
    // 这是完成回复的交付加速，不是把失去所有权的执行提交成成功。
    // 只放行已经通过 T3 的 canonical 条目；T1 与它们的展示终态共用一个事务。
    await transaction.runAsync(`UPDATE chat_turn_display_items SET shown_version = version, shown_json = snapshot_json
      WHERE message_id IS NOT NULL AND run_id IN (SELECT p.run_id FROM chat_turn_presentations p
        JOIN conversation_turn_runs r ON r.run_id = p.run_id
        WHERE p.session_id = ? AND p.state = 'open' AND r.status = 'committed')`, [sessionId]);
    await transaction.runAsync(`UPDATE chat_turn_presentations SET state = 'completed', reason = 'new_input_flush', updated_at = ?
      WHERE session_id = ? AND state = 'open' AND run_id IN (SELECT run_id FROM conversation_turn_runs WHERE status = 'committed')`,
    [new Date().toISOString(), sessionId]);
  }
  await transaction.runAsync(
    `UPDATE chat_turn_presentations SET state = 'interrupted', reason = ?, updated_at = ?
     WHERE session_id = ? AND state = 'open'${runId ? ' AND run_id = ?' : ''}`,
    [reason, new Date().toISOString(), sessionId, ...(runId ? [runId] : [])],
  );
  await finalizeInterruptedTurnMessagesInTransaction(transaction, sessionId, runId);
}
