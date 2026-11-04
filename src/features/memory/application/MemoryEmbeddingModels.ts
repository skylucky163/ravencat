/** Memory 拥有系统级向量选择，模型资产与任务调度通过运行时端口连接。 */
import { getMemoryRuntimeDependencies } from './MemoryRuntimeDependencies';
import { randomUUID } from 'expo-crypto';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { emitMemoryChanged } from './MemorySignals';
import { memorySearchText } from '../domain/Memory';

export function getMemoryEmbeddingModelSettings() {
  return getMemoryRuntimeDependencies().getEmbeddingModelSettings();
}

export function selectMemoryEmbeddingModel(modelConfigId: string | null) {
  return getMemoryRuntimeDependencies().selectEmbeddingModel(modelConfigId);
}

export function clearMemoryEmbeddings() {
  return getMemoryRuntimeDependencies().clearEmbeddings();
}

export function setMemoryEmbeddingEnabled(enabled: boolean) {
  return getMemoryRuntimeDependencies().setEmbeddingEnabled(enabled);
}

/** 版本先于配置读取；资产在等待期间改变时，不能用旧配置重新取得新发布资格。 */
export async function synchronizeMemoryEmbeddingModel() {
  const runtime = getMemoryRuntimeDependencies();
  const before = await runtime.repository.getEmbeddingIndexRevision();
  const model = await runtime.resolveEmbeddingModel();
  const revision = await runtime.repository.syncEmbeddingModel(model, before);
  if (revision !== null && revision !== before) emitMemoryChanged();
  return { model, revision };
}

export async function getMemoryEmbeddingIndexStatus() {
  const runtime = getMemoryRuntimeDependencies();
  const model = await runtime.resolveEmbeddingModel();
  return runtime.repository.countEmbeddingIndex(model?.fingerprint ?? null);
}

/** 新结果仅暂存内存；版本一致且整批成功时，Repository 才原子替换旧索引。 */
export async function rebuildMemoryEmbeddingIndex(signal: AbortSignal, onProgress: (completed: number, total: number) => void): Promise<void> {
  const runtime = getMemoryRuntimeDependencies();
  await runtime.withEmbeddingMaintenance(async maintenanceSignal => {
    const { model, revision } = await synchronizeMemoryEmbeddingModel();
    if (!model) throw new Error('请先开启记忆向量化并选择可用模型');
    if (revision === null) throw new Error('模型配置已变化，请重新发起重建');
    const build = await runtime.repository.beginEmbeddingRebuild(randomUUID(), model, revision);
    try {
      const vectors: number[][] = [];
      onProgress(0, build.entries.length);
      for (const entry of build.entries) {
        throwIfAbortSignalAborted(maintenanceSignal);
        const vector = await runtime.embed(memorySearchText(entry), model, maintenanceSignal);
        if (vectors.length && vector.length !== vectors[0].length) throw new Error('向量模型返回的维度不一致，本次结果未覆盖旧索引');
        vectors.push(vector);
        onProgress(vectors.length, build.entries.length);
      }
      await runtime.repository.publishEmbeddingRebuild(build, vectors, maintenanceSignal);
      emitMemoryChanged();
    } finally { await runtime.repository.finishEmbeddingRebuild(build.id); }
  }, signal);
}
