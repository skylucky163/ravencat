import type { AgentToolExecutionContext } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { inspectLocalImage } from '@platform/device';
import { buildStickerSemanticText, isStickerEmbeddingValid, type StickerEmbedding } from '../domain/StickerEmbedding';
import { deriveStickerName, normalizeStickerName, normalizeStickerTags, StickerNotFoundError,
  STICKER_MAX_DIMENSION_PX, STICKER_MAX_FILE_SIZE_BYTES } from '../domain/Sticker';
import type { Sticker, StickerMetadataPatch } from '../domain/Sticker';
import type { AIStickerOperation, AIStickerTask } from '../domain/AIStickerProcessing';
import { getStickersRuntimeDependencies } from './StickerRuntime';
import { resolveStickerEmbeddingModel } from './StickerSystemModels';

export class AIStickerCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AIStickerCommandError'; }
}

async function requireOwnSticker(id: string, context: AgentToolExecutionContext): Promise<Sticker> {
  const sticker = await getStickersRuntimeDependencies().repository.getStickerById(id, context.task.assistantId);
  if (!sticker) throw new StickerNotFoundError(id);
  if (sticker.ownerAssistantId !== context.task.assistantId) throw new AIStickerCommandError('STICKER_NOT_OWNED', '只能维护自己的收藏，用户和其他 AI 的收藏不能修改或删除');
  return sticker;
}

/** 搜索、选择和维护结果共用当前模型 / 语义版本的真实索引状态。 */
export async function getStickerVectorState(sticker: Sticker) {
  const [state] = await getStickerVectorStates([sticker]);
  return state;
}

/** 整批结果共用一次模型解析和批量读取，状态按输入顺序返回。 */
export async function getStickerVectorStates(stickers: readonly Sticker[]) {
  if (stickers.length === 0) return [];
  const runtime = getStickersRuntimeDependencies();
  const model = await resolveStickerEmbeddingModel();
  const ownedIds = stickers.filter(sticker => sticker.ownerAssistantId).map(sticker => sticker.id);
  const [embeddings, tasks] = await Promise.all([
    model ? runtime.repository.listStickerEmbeddingsByStickerIds(stickers.map(sticker => sticker.id), model.id) : Promise.resolve<StickerEmbedding[]>([]),
    ownedIds.length > 0 ? runtime.aiProcessing.repository.getTasks(ownedIds) : new Map<string, AIStickerTask>(),
  ]);
  const embeddingsByStickerId = new Map(embeddings.map(embedding => [embedding.stickerId, embedding]));
  return stickers.map(sticker => {
    const embedding = embeddingsByStickerId.get(sticker.id);
    const valid = model !== null && embedding !== undefined && isStickerEmbeddingValid(embedding, {
      modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt,
      semanticRevision: sticker.semanticRevision, dimension: embedding.dimension,
    });
    const task = tasks.get(sticker.id);
    return { status: valid ? 'ready' : 'missing_or_stale',
      error: task?.operation === 'embed' ? task.error : null,
      reminder: valid ? null : '没有当前有效向量，仍可按名称、描述和标签检索与发送；自己的收藏可显式重新向量化，不要求立即修复。' };
  });
}

export async function addAISticker(input: { media_asset_id: string; name?: string }, context: AgentToolExecutionContext) {
  const runtime = getStickersRuntimeDependencies();
  const media = await runtime.media.resolveMediaAsset(input.media_asset_id);
  const info = await inspectLocalImage(media.localUri);
  if (info.isAnimated) throw new AIStickerCommandError('ANIMATED_STICKER_NOT_ALLOWED', 'AI 只能导入静态表情，动态表情请由用户导入并填写语义');
  if (info.byteSize > STICKER_MAX_FILE_SIZE_BYTES || info.width > STICKER_MAX_DIMENSION_PX || info.height > STICKER_MAX_DIMENSION_PX) {
    throw new AIStickerCommandError('STICKER_TOO_LARGE', '表情最多 5 MiB，最长边最多 2048 像素');
  }
  const name = normalizeStickerName(input.name ?? deriveStickerName(null));
  const created = await runtime.aiProcessing.repository.create(context.task.assistantId,
    { ...media.asset, mimeType: info.mimeType, width: info.width, height: info.height }, name, null,
    runtime.generateId(), runtime.now(), tx => runtime.aiProcessing.assertCurrent(tx, context));
  // 重复收藏只返回现有状态，不把显式重试藏在导入命令里。
  if (created.reused) return { sticker: created.sticker, reused: true, vector: await getStickerVectorState(created.sticker) };
  const recognition = await processAISticker(created.sticker.id, 'recognize', context);
  if (recognition.status !== 'succeeded') return { stickerId: created.sticker.id, reused: false, recognition };
  const embedding = await processAISticker(created.sticker.id, 'embed', context);
  return { stickerId: created.sticker.id, reused: false, recognition, embedding };
}

export async function processAISticker(id: string, operation: AIStickerOperation, context: AgentToolExecutionContext) {
  const runtime = getStickersRuntimeDependencies();
  const own = await requireOwnSticker(id, context);
  if (operation === 'embed') {
    if (own.annotationStatus !== 'ready') throw new AIStickerCommandError('STICKER_NOT_ANNOTATED', '请先完成识别或修正语义，再进行向量化');
    if ((await getStickerVectorState(own)).status === 'ready') return { status: 'succeeded', unchanged: true };
  }
  const ai = runtime.aiProcessing;
  const guard = (tx: import('@platform/persistence').DatabaseTransactionExecutor) => ai.assertCurrent(tx, context);
  const claim = await ai.repository.claim(context.task.assistantId, id, operation, runtime.generateId(), ai.executionId, runtime.now(), guard);
  if (!claim) return { status: 'processing', message: '这张表情正在处理，请不要重复发起任务' };
  let cancellation: Promise<void> | null = null;
  let cancellationError: unknown;
  const cancel = () => { cancellation = ai.repository.cancel(claim, runtime.now()).catch(error => { cancellationError = error; }); };
  context.abortSignal.addEventListener('abort', cancel, { once: true });
  try {
    throwIfAbortSignalAborted(context.abortSignal);
    let result: Parameters<typeof ai.repository.finish>[1];
    // 只把模型边界失败记录为业务失败，SQL / commit 异常不伪装成模型错误。
    try {
      if (operation === 'recognize') {
        result = { metadata: await ai.recognize(claim.sticker, context.abortSignal) };
      } else {
        const model = await resolveStickerEmbeddingModel();
        if (!model) throw new Error('向量模型未配置或不可用，请先修正表情系统的模型选择');
        const vectors = await runtime.embeddings.embedTexts([buildStickerSemanticText(claim.sticker)], model, context.abortSignal);
        const vector = vectors[0];
        if (vectors.length !== 1 || !Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(value))) throw new Error('向量模型返回的向量无效');
        const now = runtime.now();
        result = { embedding: { stickerId: id, modelConfigId: model.id, modelConfigUpdatedAt: model.updatedAt,
          semanticRevision: claim.sticker.semanticRevision, dimension: vector.length, vector, createdAt: now, updatedAt: now } };
      }
    } catch (error) {
      throwIfAbortSignalAborted(context.abortSignal);
      result = { error: error instanceof Error ? error.message : '模型请求失败' };
    }
    throwIfAbortSignalAborted(context.abortSignal);
    const accepted = await ai.repository.finish(claim, result, runtime.now(), guard);
    if (!accepted) return { status: 'cancelled', message: '收藏语义或任务已变化，旧结果未提交' };
    return { status: result.error ? 'failed' : 'succeeded', error: result.error ?? null,
      automaticRetry: false, stickerId: id };
  } catch (error) {
    await ai.repository.cancel(claim, runtime.now());
    throw error;
  } finally {
    context.abortSignal.removeEventListener('abort', cancel);
    if (cancellation) await cancellation;
    if (cancellationError) throw cancellationError;
  }
}

export async function maintainAISticker(input: { sticker_id: string; action: 'inspect' | 'recognize' | 'embed' | 'edit' | 'delete'; name?: string; description?: string; tags?: string[]; emotion?: string }, context: AgentToolExecutionContext) {
  const runtime = getStickersRuntimeDependencies();
  const sticker = await requireOwnSticker(input.sticker_id, context);
  const guard = (tx: import('@platform/persistence').DatabaseTransactionExecutor) => runtime.aiProcessing.assertCurrent(tx, context);
  if (input.action === 'recognize' || input.action === 'embed') return processAISticker(sticker.id, input.action, context);
  if (input.action === 'delete') {
    const deleted = await runtime.repository.deleteSticker(sticker.id, context.task.assistantId, guard);
    if (deleted) await runtime.media.releaseMediaAssetCandidates([sticker.mediaAssetId]);
    return { stickerId: sticker.id, deleted };
  }
  if (input.action === 'edit') {
    if (!input.description?.trim()) throw new AIStickerCommandError('STICKER_DESCRIPTION_REQUIRED', '修正语义必须提供非空描述');
    const patch: StickerMetadataPatch = { description: input.description.trim() };
    if (input.name !== undefined) patch.name = normalizeStickerName(input.name);
    if (input.tags !== undefined) patch.tags = normalizeStickerTags(input.tags);
    if (input.emotion !== undefined) patch.emotion = input.emotion.trim() || null;
    const updated = await runtime.repository.updateStickerMetadata(sticker.id, patch, runtime.now(), context.task.assistantId, guard);
    return { sticker: updated, vector: await getStickerVectorState(updated), message: '语义已保存；需要有效向量时显式调用 embed，不自动重新识别或向量化' };
  }
  return { sticker, task: await runtime.aiProcessing.repository.getTask(sticker.id), vector: await getStickerVectorState(sticker) };
}
