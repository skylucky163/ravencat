/** 彻底删除只清理该 AI 自己的空间；外部动态上的互动没有助手外键，继续保留。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';

export async function purgeAssistantMomentsInTransaction(tx: DatabaseTransactionExecutor, agentId: string): Promise<string[]> {
  const assets = await tx.getAllAsync<{ media_asset_id: string }>(`SELECT media.media_asset_id FROM moment_media media
    JOIN moments m ON m.id = media.moment_id WHERE m.author_type = 'ai' AND m.author_id = ?`, [agentId]);
  await tx.runAsync("DELETE FROM moments WHERE author_type = 'ai' AND author_id = ?", [agentId]);
  await tx.runAsync('DELETE FROM moment_social_inbox_deliveries WHERE recipient_agent_id = ?', [agentId]);
  return assets.map(row => row.media_asset_id);
}
