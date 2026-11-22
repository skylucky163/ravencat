/** 助手回收只撤销执行所有权；单聊和群聊正文都留在原处，恢复不重放旧请求。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { conversationTurnRepository } from '../../reply/infrastructure/SQLiteConversationTurnRepository';

export async function suspendAssistantChatInTransaction(tx: DatabaseTransactionExecutor, assistantId: string) {
  const sessions = await tx.getAllAsync<{ id: string }>('SELECT id FROM sessions WHERE ai_assistant_id = ?', [assistantId]);
  const now = new Date().toISOString();
  for (const { id } of sessions) {
    await conversationTurnRepository.suspendForAssistantRecycleInTransaction(tx, id);
    await tx.runAsync(`UPDATE chat_summary_state SET generation = generation + 1, revision = revision + 1,
      claim_id = NULL, claim_to_cursor = NULL, claim_expires_at = NULL WHERE conversation_id = ?`, [id]);
  }
  // 成员关系保留；列表与 claim 按助手当前资格排除回收成员，恢复后原成员设置仍成立。
  const tasks = await tx.getAllAsync<{ id: string }>("SELECT id FROM group_speech_tasks WHERE ai_assistant_id = ? AND status IN ('queued', 'running')", [assistantId]);
  await tx.runAsync(`UPDATE group_speech_tasks SET status = 'skipped', completed_at = ?, updated_at = ?, error_message = 'AI 已移入回收站'
    WHERE ai_assistant_id = ? AND status IN ('queued', 'running')`, [now, now, assistantId]);
  return { sessionIds: sessions.map(row => row.id), taskIds: tasks.map(row => row.id) };
}

/** 单聊收藏属于被隐藏的私聊副本；群聊收藏与分享快照不随这个 AI 清除。 */
export async function purgeAssistantChatInTransaction(tx: DatabaseTransactionExecutor, assistantId: string): Promise<string[]> {
  const rows = await tx.getAllAsync<{ asset_id: string }>(`SELECT DISTINCT CAST(tree.value AS TEXT) AS asset_id
    FROM chat_favorites f, json_tree(f.snapshot_json) tree WHERE json_extract(f.snapshot_json, '$.sourceAssistantId') = ?
    AND tree.type = 'text' AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')`, [assistantId]);
  await tx.runAsync("DELETE FROM chat_favorites WHERE json_extract(snapshot_json, '$.sourceAssistantId') = ?", [assistantId]);
  return rows.map(row => row.asset_id);
}
