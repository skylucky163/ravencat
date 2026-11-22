/** Host 只编排跨 Feature 原子转存；两边 SQL 和记忆输入边界仍由各自 owner 提供。 */
import type { Protocol } from '@features/protocol';
import { protocolRepository } from '@features/protocol/composition';
import { getMemoryRuntimeDependencies, memoryEntryRepository, prepareMemoryRecord, emitMemoryChanged } from '@features/memory/composition';
import { databaseCoordinator } from '@platform/persistence';

export async function transferProtocolToMemory(assistantId: string, expected: Protocol, values: { content: string; summary: string | null }): Promise<void> {
  const space = await getMemoryRuntimeDependencies().resolveMemorySpace(assistantId);
  const record = prepareMemoryRecord(space.poolId, values.content, values.summary, null);
  const database = databaseCoordinator.openTaskExecutor({ name: 'protocol.transferToMemory', feature: 'protocol', priority: 'interactive' });
  await database.withExclusiveTransactionAsync(async (tx) => {
    const current = await protocolRepository.getForTransfer(tx, assistantId, expected.id);
    if (!current) throw new Error('这条协议已不存在或不属于当前 AI');
    // 弹窗期间 AI 仍可编辑协议；不能按过期快照删除新的常驻内容。
    if (current.updatedAt !== expected.updatedAt || current.content !== expected.content || (current.summary ?? null) !== (expected.summary ?? null)) {
      throw new Error('协议已被修改，请刷新后重新转换');
    }
    await memoryEntryRepository.createEntryInTransaction(tx, record);
    await protocolRepository.deleteInTransaction(tx, current.id);
  });
  emitMemoryChanged();
}
