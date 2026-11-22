/** 回收期内保留日程历史；彻底删除时清理其唯一事实与从属投影记录。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';

export async function purgeAssistantSchedulesInTransaction(tx: DatabaseTransactionExecutor, assistantId: string): Promise<void> {
  await tx.runAsync('DELETE FROM raven_cat_ai_schedules WHERE owner_ai_id = ?', [assistantId]);
}
