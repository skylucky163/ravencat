/** 持久 claim 与 revision fence 归 Repository；请求在事务外，取消不消耗尝试次数。 */
import { randomUUID } from 'expo-crypto';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { getMemoryRuntimeDependencies, MemoryEmbeddingError } from './MemoryRuntimeDependencies';
import { emitMemoryChanged } from './MemorySignals';
import { MEMORY_EMBEDDING_MAX_ATTEMPTS, memorySearchText } from '../domain/Memory';
import { synchronizeMemoryEmbeddingModel } from './MemoryEmbeddingModels';
export async function processNextMemoryEmbedding(signal: AbortSignal): Promise<{ processed: boolean; nextWakeAt: string | null; failedMemoryId: string | null }> {
  const runtime = getMemoryRuntimeDependencies();
  const { model, revision } = await synchronizeMemoryEmbeddingModel();
  throwIfAbortSignalAborted(signal);
  if (!model || revision === null) return { processed: false, nextWakeAt: null, failedMemoryId: null };
  const now = new Date();
  const claim = await runtime.repository.claimEmbedding(model.fingerprint, randomUUID(), now.toISOString(), new Date(now.getTime() + 120_000).toISOString(), revision);
  if (!claim) return { processed: false, nextWakeAt: await runtime.repository.getNextEmbeddingWakeAt(model.fingerprint), failedMemoryId: null };
  let failedMemoryId: string | null = null;
  try {
    const vector = await runtime.embed(memorySearchText(claim), model, signal);
    throwIfAbortSignalAborted(signal);
    const result = await runtime.repository.completeEmbedding(claim, vector);
    if (result === 'dimension_mismatch') throw new MemoryEmbeddingError('模型返回的向量维度发生变化，请检查记忆向量模型配置', true);
  } catch (error) {
    if (signal.aborted) { await runtime.repository.releaseEmbedding(claim); return { processed: false, nextWakeAt: null, failedMemoryId: null }; }
    if (!(error instanceof MemoryEmbeddingError)) { await runtime.repository.releaseEmbedding(claim); throw error; }
    const finished = new Date();
    const recorded = await runtime.repository.failEmbedding(claim, error.message, error.terminal, finished.toISOString(),
      new Date(finished.getTime() + (claim.attempts === 0 ? 30_000 : 120_000)).toISOString());
    if (recorded && (error.terminal || claim.attempts + 1 >= MEMORY_EMBEDDING_MAX_ATTEMPTS)) failedMemoryId = claim.memoryId;
  }
  emitMemoryChanged();
  return { processed: true, nextWakeAt: null, failedMemoryId };
}
