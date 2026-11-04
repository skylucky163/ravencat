/** 完整用户库的进度查询，不使用图库分页数量推算整批进度。 */
import type { StickerProcessingProgress, StickerVectorStatus } from '../domain/StickerProcessing';
import { getStickersRuntimeDependencies } from './StickerRuntime';
import { getStickerSystemConfig, getStickerSystemModelSelection, resolveStickerEmbeddingModel } from './StickerSystemModels';
import { getStickerEmbeddingActivity } from './StickerProcessingSignal';

export async function getStickerProcessingProgress(): Promise<StickerProcessingProgress> {
  const runtime = getStickersRuntimeDependencies();
  // 同一次投影的模型与开关必须来自同一份配置快照。
  const config = await getStickerSystemConfig();
  const [selection, model] = await Promise.all([
    getStickerSystemModelSelection(config),
    resolveStickerEmbeddingModel(config),
  ]);
  const [rows, control] = await Promise.all([
    runtime.repository.listUserStickerProcessing(model
      ? { modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt, dimension: null } : null),
    runtime.repository.getEmbeddingIndexControl(),
  ]);
  const embeddingPublished = model !== null && control.publishedModelId === model.id
    && control.publishedModelUpdatedAt === model.updatedAt;
  const embeddingActivity = getStickerEmbeddingActivity();
  const embeddingCanBackfill = embeddingPublished || rows.some(row => row.hasEmbedding);
  const activeIds = new Set(embeddingActivity?.stickerIds);
  const items = rows.map(row => {
    let vectorStatus: StickerVectorStatus;
    if (row.sticker.annotationStatus !== 'ready') vectorStatus = 'waiting_annotation';
    else if (selection.embedding.status === 'unconfigured') vectorStatus = 'unconfigured';
    else if (!model) vectorStatus = 'unavailable';
    else if (activeIds.has(row.sticker.id)) vectorStatus = 'processing';
    else if (row.embeddingError) vectorStatus = 'failed';
    else if (row.hasEmbedding) vectorStatus = 'ready';
    else if (!embeddingCanBackfill) vectorStatus = 'pending_rebuild';
    else vectorStatus = 'pending';
    return { ...row, vectorStatus };
  });
  return { items, recognitionModel: selection.recognition, embeddingModel: selection.embedding,
    embeddingPublished, embeddingCanBackfill, automaticRecognitionEnabled: config.automaticRecognitionEnabled, embeddingActivity };
}
