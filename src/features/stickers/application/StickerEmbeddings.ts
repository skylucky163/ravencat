/**
 * 语义向量索引管道：状态查询、批量建索引、重建。
 *
 * 硬边界：识别成功不等于向量化成功。embedding 失败只让向量保持缺失 / stale，
 * 不修改 annotationStatus；没有向量的 ready Sticker 仍可发送并被 lexical 搜索。
 * 网络请求始终在事务外；自动维护按批提交，手动重建整批成功后一次性发布。
 */

import {
  buildStickerSemanticText,
  type StickerEmbeddingIndexStatus,
  type StickerEmbedding,
} from '../domain/StickerEmbedding';
import { getStickersRuntimeDependencies } from './StickerRuntime';
import { resolveStickerEmbeddingModel } from './StickerSystemModels';
import { emitStickerEmbeddingPending } from './StickerEmbeddingPendingSignal';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { Sticker } from '../domain/Sticker';
import type { StickerModelConfigRef } from '../domain/StickerSystemConfig';
import { emitStickerProcessingChanged, setStickerEmbeddingActivity } from './StickerProcessingSignal';

/** 控制维护批次大小，并满足当前向量服务每次最多 10 条文本的请求契约。 */
export const STICKER_EMBEDDING_BATCH_SIZE = 10;

async function generateEmbeddings(stickers: Sticker[], model: StickerModelConfigRef, signal: AbortSignal): Promise<StickerEmbedding[]> {
  const runtime = getStickersRuntimeDependencies();
  const vectors = await runtime.embeddings.embedTexts(stickers.map(buildStickerSemanticText), model, signal);
  const now = runtime.now();
  return stickers.map((sticker, index) => ({ stickerId: sticker.id, semanticRevision: sticker.semanticRevision,
    modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt, dimension: vectors[index].length,
    vector: vectors[index], createdAt: now, updatedAt: now }));
}

export async function getStickerEmbeddingIndexStatus(): Promise<StickerEmbeddingIndexStatus> {
  const runtime = getStickersRuntimeDependencies();
  const readyStickers = await runtime.repository.countReadyStickers();
  const model = await resolveStickerEmbeddingModel();
  if (!model) {
    // 未配置 / 失效模型时全部 ready Sticker 都没有可用向量，但不阻止使用。
    return { readyStickers, validEmbeddings: 0, pendingEmbeddings: readyStickers };
  }
  const validEmbeddings = await runtime.repository.countValidStickerEmbeddings({
    modelConfigId: model.id,
    modelConfigUpdatedAt: model.updatedAt,
    dimension: null,
  });
  return {
    readyStickers,
    validEmbeddings,
    pendingEmbeddings: Math.max(0, readyStickers - validEmbeddings),
  };
}

export interface GenerateStickerEmbeddingBatchResult {
  /** 本次成功写入向量的数量；模型未配置时为 0。 */
  embeddedCount: number;
  failedCount?: number;
}

/**
 * 领取一批 ready 且向量缺失 / stale 的 Sticker，生成并原子写入向量。
 * 模型未配置或失效时静默返回 0，由上层保持待机而不是反复刷错误。
 * 模型请求失败后保存原因并跳过该语义版本，只有显式补齐才重新放行。
 */
export async function generateStickerEmbeddingBatch(
  input: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<GenerateStickerEmbeddingBatchResult> {
  const runtime = getStickersRuntimeDependencies();
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? STICKER_EMBEDDING_BATCH_SIZE));
  const control = await runtime.repository.getEmbeddingIndexControl();
  const model = await resolveStickerEmbeddingModel();
  if (!model) return { embeddedCount: 0 };
  const context = { modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt, dimension: null };
  const revision = await runtime.repository.syncEmbeddingModel(context, control.revision);
  if (revision === null) return { embeddedCount: 0 };
  // 只有用户已为这个版本明确建立过索引，后台才继续维护新增／编辑内容。
  if (control.buildId !== null || control.publishedModelId !== model.id || control.publishedModelUpdatedAt !== model.updatedAt) return { embeddedCount: 0 };

  const stickers = await runtime.repository.listReadyStickersNeedingEmbedding(
    { modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt, dimension: null },
    batchSize,
  );
  if (stickers.length === 0) return { embeddedCount: 0 };

  const signal = input.signal ?? new AbortController().signal;
  setStickerEmbeddingActivity({ kind: 'automatic', stickerIds: stickers.map(sticker => sticker.id),
    startedAt: runtime.now(), completed: 0, total: stickers.length });
  try {
    let embeddings: StickerEmbedding[];
    try {
      embeddings = await generateEmbeddings(stickers, model, signal);
    } catch (error) {
      throwIfAbortSignalAborted(signal);
      await runtime.repository.saveEmbeddingFailures(stickers, context, revision, null,
        error instanceof Error ? error.message : String(error), runtime.now(), signal);
      return { embeddedCount: 0, failedCount: stickers.length };
    }
    const embeddedCount = await runtime.repository.commitEmbeddingBatch(embeddings, revision, signal);
    return { embeddedCount };
  } finally {
    setStickerEmbeddingActivity(null);
  }
}

/** 已发布的当前模型只补齐新增内容；新模型必须显式重建整套索引。 */
export async function backfillMissingStickerEmbeddings(stickerId?: string): Promise<void> {
  const runtime = getStickersRuntimeDependencies();
  await runtime.withEmbeddingMaintenance(async () => {
    const control = await runtime.repository.getEmbeddingIndexControl();
    const model = await resolveStickerEmbeddingModel();
    if (!model) throw new Error('请先选择可用的向量模型');
    const context = { modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt, dimension: null };
    const revision = await runtime.repository.syncEmbeddingModel(context, control.revision);
    if (revision === null) throw new Error('模型已变化，请重新补齐');
    if (control.publishedModelId !== model.id || control.publishedModelUpdatedAt !== model.updatedAt) {
      // 旧索引的匹配由持久层原子确认，新增素材不会让已有索引失去恢复资格。
      await runtime.repository.restoreEmbeddingIndexPublication(context, revision);
    }
    await runtime.repository.clearEmbeddingFailures(context, stickerId);
  });
  emitStickerProcessingChanged();
  emitStickerEmbeddingPending();
}

/**
 * 新向量暂存内存，整批完成且模型／语义版本未变化后才事务替换用户索引。
 * 进程退出只丢弃未发布的新结果，旧向量始终留在数据库中。
 */
export async function rebuildStickerEmbeddingIndex(signal?: AbortSignal, onProgress: (completed: number, total: number) => void = () => {}): Promise<number> {
  const runtime = getStickersRuntimeDependencies();
  return runtime.withEmbeddingMaintenance(async maintenanceSignal => {
    const before = await runtime.repository.getEmbeddingIndexControl();
    const model = await resolveStickerEmbeddingModel();
    if (!model) throw new Error('未配置向量化模型，无法重建语义索引');
    const context = { modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt, dimension: null };
    const revision = await runtime.repository.syncEmbeddingModel(context, before.revision);
    if (revision === null) throw new Error('模型配置已变化，请重新发起重建');
    const build = await runtime.repository.beginEmbeddingRebuild(runtime.generateId(), context, revision);
    try {
      const embeddings: StickerEmbedding[] = [];
      onProgress(0, build.stickers.length);
      for (let offset = 0; offset < build.stickers.length; offset += STICKER_EMBEDDING_BATCH_SIZE) {
        throwIfAbortSignalAborted(maintenanceSignal);
        const batch = build.stickers.slice(offset, offset + STICKER_EMBEDDING_BATCH_SIZE);
        const activity = { kind: 'rebuild' as const, stickerIds: batch.map(sticker => sticker.id),
          startedAt: runtime.now(), completed: embeddings.length, total: build.stickers.length };
        setStickerEmbeddingActivity(activity);
        let generated: StickerEmbedding[];
        try {
          generated = await generateEmbeddings(batch, model, maintenanceSignal);
          if (embeddings.length && generated.some(item => item.dimension !== embeddings[0].dimension)) throw new Error('向量维度不一致，本次结果未覆盖旧索引');
        } catch (error) {
          throwIfAbortSignalAborted(maintenanceSignal);
          await runtime.repository.saveEmbeddingFailures(batch, context, build.revision, build.id,
            error instanceof Error ? error.message : String(error), runtime.now(), maintenanceSignal);
          throw error;
        }
        embeddings.push(...generated);
        setStickerEmbeddingActivity({ ...activity, completed: embeddings.length });
        onProgress(embeddings.length, build.stickers.length);
      }
      await runtime.repository.publishEmbeddingRebuild(build, embeddings, context, maintenanceSignal);
      return embeddings.length;
    } finally {
      try { await runtime.repository.finishEmbeddingRebuild(build.id); }
      finally { setStickerEmbeddingActivity(null); }
    }
  }, signal);
}
