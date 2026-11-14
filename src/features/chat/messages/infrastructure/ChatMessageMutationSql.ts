/** 消息变更在原事务内撤销重写资格；普通回复的 owner 不受手动编辑影响。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';

export async function cancelRegenerationInTransaction(
  transaction: DatabaseTransactionExecutor,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await transaction.runAsync(`UPDATE chat_turn_presentations SET state = 'interrupted',
    reason = 'history_changed', updated_at = ? WHERE state = 'open' AND run_id =
    (SELECT active_run_id FROM conversation_turn_state WHERE session_id = ? AND active_run_kind = 'regenerate')`,
  [now, sessionId]);
  await transaction.runAsync(
    `UPDATE conversation_turn_runs SET status = 'cancelled', terminal_reason = 'history_changed', terminal_at = ?
     WHERE run_id = (SELECT active_run_id FROM conversation_turn_state
       WHERE session_id = ? AND active_run_kind = 'regenerate') AND status = 'active'`,
    [now, sessionId],
  );
  await transaction.runAsync(
    `UPDATE conversation_turn_state SET active_run_id = NULL, active_run_kind = NULL,
       revision = revision + 1, updated_at = ? WHERE session_id = ? AND active_run_kind = 'regenerate'`,
    [now, sessionId],
  );
  await transaction.runAsync('DELETE FROM chat_regeneration_requests WHERE session_id = ?', [sessionId]);
}

