/** 一次 Agent run 的搜索队列冻结正文与顺序；后续分页不重新检索。 */
import { MemoryInputError, MemoryVectorDimensionError, normalizeMemoryKeywords, rankMemoryEntries, type MemoryEntry, type MemoryRecallInput, type MemoryRecallPage } from '../domain/Memory';
import { getMemoryRuntimeDependencies, MemoryEmbeddingError } from './MemoryRuntimeDependencies';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

interface RecallQueue { key: string; entries: MemoryEntry[]; pageSize: number; semanticUnavailable: string | null }
const queues = new Map<string, RecallQueue>();
export function releaseMemoryRecallRun(runId: string): void { queues.delete(runId); }

function similarity(left: readonly number[], right: readonly number[]): number {
  const leftScale = Math.max(...left.map(Math.abs));
  const rightScale = Math.max(...right.map(Math.abs));
  let dot = 0; let a = 0; let b = 0;
  for (let index = 0; index < left.length; index++) { const x = left[index] / leftScale; const y = right[index] / rightScale; dot += x * y; a += x ** 2; b += y ** 2; }
  return dot / Math.sqrt(a * b);
}
export async function recallMemoryForRun(assistantId: string, runId: string, input: MemoryRecallInput, signal: AbortSignal): Promise<MemoryRecallPage> {
  const query = (input.query ?? '').trim();
  const keywords = normalizeMemoryKeywords(input.keywords ?? []);
  const offset = input.offset ?? 0;
  if (!query && keywords.length === 0) throw new MemoryInputError('请提供 query 或至少一个非空关键词');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new MemoryInputError('offset 必须为非负整数');
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  const key = JSON.stringify([space.poolId, query, keywords]);
  let queue = queues.get(runId);
  if (offset > 0 && (!queue || queue.key !== key)) throw new MemoryInputError('分页必须沿用本轮已开始的相同搜索；新搜索请从 offset 0 开始');
  if (offset === 0) {
    queues.delete(runId);
    const settings = await runtime.repository.getRecallSettings(space.poolId);
    const model = query ? await runtime.resolveEmbeddingModel() : null;
    const similarities = new Map<string, number>();
    let semanticUnavailable: string | null = null;
    let vector: number[] | null = null;
    if (query) {
      if (!model) semanticUnavailable = '当前未启用可用的记忆向量模型；请使用 keywords 进行关键词检索';
      else {
        try { vector = await runtime.embed(query, model, signal); }
        catch (error) {
          if (signal.aborted || !(error instanceof MemoryEmbeddingError)) throw error;
          semanticUnavailable = error.message;
        }
      }
    }
    let candidates;
    try {
      candidates = await runtime.repository.readRecallCandidates(space.poolId, vector && model ? model.fingerprint : null, vector?.length ?? null);
    } catch (error) {
      if (!(error instanceof MemoryVectorDimensionError)) throw error;
      semanticUnavailable = error.message;
      candidates = await runtime.repository.readRecallCandidates(space.poolId, null, null);
    }
    const entries = candidates.entries;
    if (vector) for (const item of candidates.vectors) similarities.set(item.memoryId, similarity(vector, item.vector));
    if (query && vector && entries.length > 0 && candidates.vectors.length === 0 && !semanticUnavailable) {
      semanticUnavailable = '当前空间尚无适用于当前模型的记忆向量，可在记忆设置中手动重建，或使用 keywords 检索';
    }
    throwIfAbortSignalAborted(signal);
    queue = { key, entries: rankMemoryEntries(entries, keywords, similarities), pageSize: settings.activePageSize, semanticUnavailable };
    queues.set(runId, queue);
  }
  const snapshot = queue!;
  const end = offset + snapshot.pageSize;
  return { entries: snapshot.entries.slice(offset, end), total: snapshot.entries.length, hasMore: end < snapshot.entries.length,
    nextOffset: end < snapshot.entries.length ? end : null, semanticUnavailable: snapshot.semanticUnavailable };
}
