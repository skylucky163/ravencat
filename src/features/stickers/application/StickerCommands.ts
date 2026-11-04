/** Sticker 收藏库的写命令与持久化标注状态转换。 */

import { MEDIA_ASSET_STORAGE_BACKEND } from '@features/media';
import {
  deriveStickerName,
  inferAnimatedSticker,
  normalizeStickerName,
  normalizeStickerOptionalText,
  normalizeStickerTags,
  STICKER_MAX_DIMENSION_PX,
  STICKER_MAX_FILE_SIZE_BYTES,
  StickerGroupNotFoundError,
  type Sticker,
  type StickerAnnotationClaim,
  type StickerAnnotationMetadata,
  type StickerGroup,
  type StickerMetadataPatch,
  type StickerMessageSnapshot,
} from '../domain/Sticker';
import type { CreateStickerGroupInput } from '../domain/StickerRepository';
import {
  emitStickerAnnotationPending,
} from './StickerAnnotationPendingSignal';
import { emitStickerAnnotationChanged } from './StickerAnnotationChangedSignal';
import { emitStickerEmbeddingPending } from './StickerEmbeddingPendingSignal';
import { getStickersRuntimeDependencies } from './StickerRuntime';

export interface ImportStickerInput {
  sourceUri: string;
  fileName?: string | null;
  mimeType: string;
  fileSize: number;
  width?: number | null;
  height?: number | null;
  isAnimated?: boolean;
  groupId?: string | null;
  name?: string | null;
  description?: string | null;
  tags?: readonly string[];
  emotion?: string | null;
}

export interface ImportStickerResult {
  sticker: Sticker;
  mediaAssetReused: boolean;
  stickerReused: boolean;
}

/** 已提交消息的快照已通过消息边界校验，不要求原收藏项仍然存在。 */
export async function addStickerFromMessage(
  snapshot: Omit<StickerMessageSnapshot, 'sourceFileName'> & { sourceFileName?: string | null },
): Promise<{ sticker: Sticker; reused: boolean }> {
  const runtime = getStickersRuntimeDependencies();
  const now = runtime.now();
  const result = await runtime.repository.createStickerIfAbsent({
    id: runtime.generateId(),
    ownerAssistantId: null,
    mediaAssetId: snapshot.mediaAssetId,
    groupId: null,
    name: snapshot.name,
    description: snapshot.description,
    tags: [...snapshot.tags],
    emotion: snapshot.emotion,
    sourceFileName: snapshot.sourceFileName ?? null,
    mimeType: snapshot.mimeType,
    width: snapshot.width,
    height: snapshot.height,
    isAnimated: snapshot.isAnimated,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    // 发送快照已经具备语义，新增用户收藏无需再次识图；向量属于新收藏独立生成。
    annotationStatus: 'ready',
    annotationError: null,
    semanticRevision: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (!result.reused) {
    emitStickerAnnotationChanged();
    emitStickerEmbeddingPending();
  }
  return result;
}

export interface CreateStickerGroupCommandInput {
  name: string;
  sortOrder?: number;
}

export interface CompleteStickerAnnotationInput {
  stickerId: string;
  claimId: string;
  metadata: StickerAnnotationMetadata;
}

export interface FailStickerAnnotationInput {
  stickerId: string;
  claimId: string;
  error: string;
}

export interface ReleaseStickerAnnotationInput {
  stickerId: string;
  claimId: string;
  now?: string;
}

/**
 * 导入先让 MediaAsset 在事务外准备 backing，再在同一事务中写入 Sticker 引用。
 * MediaAsset 已按 hash 复用时，唯一 media_asset_id 约束让重复内容回到既有 Sticker。
 */
export async function importSticker(input: ImportStickerInput): Promise<ImportStickerResult> {
  const runtime = getStickersRuntimeDependencies();
  const sourceUri = input.sourceUri.trim();
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!sourceUri) throw new Error('导入 Sticker 必须提供本地文件 URI');
  if (!mimeType) throw new Error('导入 Sticker 必须提供 MIME 类型');
  requireStickerFileSize(input.fileSize);

  const fileName = input.fileName?.trim() || null;
  const name = normalizeBoundedName(
    input.name ?? deriveStickerName(fileName),
    'Sticker 名称',
    120,
  );
  const isAnimated = inferAnimatedSticker(mimeType, input.isAnimated);
  const groupId = normalizeGroupId(input.groupId);
  const description = normalizeStickerOptionalText(input.description);
  const tags = normalizeStickerTags(input.tags);
  const emotion = normalizeStickerOptionalText(input.emotion);
  const width = normalizeDimension(input.width, 'Sticker 宽度');
  const height = normalizeDimension(input.height, 'Sticker 高度');

  const created = await runtime.media.createMediaAssetWithReference(
    {
      storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentImage,
      sourceUri,
      fileName,
      mimeType,
      width,
      height,
      durationMs: null,
    },
    async ({ transaction, asset }) => {
      const existing = await runtime.repository.getStickerByMediaAssetIdInTransaction(
        transaction,
        asset.id,
      );
      if (existing) return { sticker: existing, reused: true };
      if (groupId && !(await runtime.repository.getGroupByIdInTransaction(transaction, groupId))) {
        throw new StickerGroupNotFoundError(groupId);
      }

      const now = runtime.now();
      const sticker: Sticker = {
        ownerAssistantId: null,
        id: runtime.generateId(),
        mediaAssetId: asset.id,
        groupId,
        name,
        description,
        tags,
        emotion,
        sourceFileName: fileName,
        mimeType,
        width,
        height,
        isAnimated,
        isFavorite: false,
        useCount: 0,
        lastUsedAt: null,
        annotationStatus: description ? 'ready' : isAnimated || input.name !== undefined || tags.length > 0 || emotion ? 'manual_required' : 'pending',
        annotationError: null,
        semanticRevision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await runtime.repository.createStickerInTransaction(transaction, sticker);
      return { sticker, reused: false };
    },
  );

  if (created.value.sticker.annotationStatus === 'pending') {
    // commit 已完成后才唤醒 Host，信号失败不能改变已提交的业务事实。
    emitStickerAnnotationPending();
  }
  if (!created.value.reused) emitStickerAnnotationChanged();
  if (!created.value.reused && created.value.sticker.annotationStatus === 'ready') emitStickerEmbeddingPending();
  return {
    sticker: created.value.sticker,
    mediaAssetReused: created.reused,
    stickerReused: created.value.reused,
  };
}

export async function createStickerGroup(
  input: CreateStickerGroupCommandInput,
): Promise<StickerGroup> {
  const runtime = getStickersRuntimeDependencies();
  const name = normalizeBoundedName(input.name, 'Sticker 分组名称', 80);
  const sortOrder = Number.isFinite(input.sortOrder) ? Math.floor(input.sortOrder ?? 0) : 0;
  const now = runtime.now();
  const command: CreateStickerGroupInput = {
    id: runtime.generateId(),
    name,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  return runtime.repository.createGroup(command);
}

export async function renameStickerGroup(groupId: string, name: string): Promise<StickerGroup> {
  const runtime = getStickersRuntimeDependencies();
  return runtime.repository.renameGroup(
    requireId(groupId, 'Sticker 分组'),
    normalizeBoundedName(name, 'Sticker 分组名称', 80),
    runtime.now(),
  );
}

export async function deleteStickerGroup(groupId: string): Promise<boolean> {
  const runtime = getStickersRuntimeDependencies();
  return runtime.repository.deleteGroup(requireId(groupId, 'Sticker 分组'), runtime.now());
}

export async function editStickerMetadata(
  stickerId: string,
  patch: StickerMetadataPatch,
): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  const normalized: StickerMetadataPatch = {};
  if (patch.name !== undefined) {
    normalized.name = normalizeBoundedName(patch.name, 'Sticker 名称', 120);
  }
  if (patch.description !== undefined) {
    normalized.description = normalizeStickerOptionalText(patch.description);
  }
  if (patch.tags !== undefined) {
    normalized.tags = normalizeStickerTags(patch.tags);
  }
  if (patch.emotion !== undefined) {
    normalized.emotion = normalizeStickerOptionalText(patch.emotion);
  }
  // canonical 语义字段变化会递增 semanticRevision 并使当前向量 stale。
  const updated = await runtime.repository.updateStickerMetadata(
    requireId(stickerId, 'Sticker'),
    normalized,
    runtime.now(),
  );
  emitStickerAnnotationChanged();
  emitStickerEmbeddingPending();
  return updated;
}

export async function toggleStickerFavorite(
  stickerId: string,
  isFavorite?: boolean,
): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  return runtime.repository.setStickerFavorite(
    requireId(stickerId, 'Sticker'),
    isFavorite ?? null,
    runtime.now(),
  );
}

export async function moveStickerToGroup(
  stickerId: string,
  groupId: string | null,
): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  return runtime.repository.moveSticker(
    requireId(stickerId, 'Sticker'),
    normalizeGroupId(groupId),
    runtime.now(),
  );
}

/** 删除库记录，并在引用裁决通过后回收它的 MediaAsset backing。 */
export async function deleteStickerFromLibrary(stickerId: string): Promise<boolean> {
  const runtime = getStickersRuntimeDependencies();
  const normalizedId = requireId(stickerId, 'Sticker');
  // Sticker 行删除后它自己的引用就消失了，候选必须在删除前取；若该 asset 仍被 Chat
  // 的 sticker snapshot 等其它事实共享，引用裁决会保留它。
  const sticker = await runtime.repository.getStickerById(normalizedId);
  const deleted = await runtime.repository.deleteSticker(normalizedId);
  if (deleted) {
    emitStickerAnnotationChanged();
    await runtime.media.releaseMediaAssetCandidates([sticker?.mediaAssetId ?? null]);
  }
  return deleted;
}

/** 输入面板的最近使用记录只属于用户发送行为，AI 选择 Sticker 不写入。 */
export async function recordUserStickerUse(stickerId: string): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  return runtime.repository.recordStickerUse(requireId(stickerId, 'Sticker'), runtime.now());
}

export interface ClaimStickerAnnotationInput {
  claimId?: string;
  now?: string;
}

export async function claimStickerAnnotation(
  input: ClaimStickerAnnotationInput = {},
): Promise<StickerAnnotationClaim | null> {
  const runtime = getStickersRuntimeDependencies();
  const claimId = input.claimId?.trim() || runtime.generateId();
  const claimedAt = input.now ?? runtime.now();
  const claim = await runtime.repository.claimNextAnnotation(claimId, claimedAt);
  if (claim) emitStickerAnnotationChanged();
  return claim;
}

/** 失败项只有显式重试才重新入队，复用原来的持久 claim 与执行宿主。 */
export async function retryStickerAnnotation(stickerId: string): Promise<void> {
  const runtime = getStickersRuntimeDependencies();
  await runtime.repository.retryAnnotation(requireId(stickerId, 'Sticker'), runtime.now());
  emitStickerAnnotationChanged();
  emitStickerAnnotationPending();
}

export async function completeStickerAnnotation(
  input: CompleteStickerAnnotationInput,
): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  const completed = await runtime.repository.completeAnnotation(
    requireId(input.stickerId, 'Sticker'),
    requireId(input.claimId, '标注 claim'),
    normalizeAnnotationMetadata(input.metadata),
    runtime.now(),
  );
  emitStickerAnnotationChanged();
  // 识别完成后进入 embedding pending；向量化失败不影响 ready 状态。
  emitStickerEmbeddingPending();
  return completed;
}

/** 动态媒体不能自动识别时，由用户补充语义并直接完成到 ready。 */
export async function completeStickerAnnotationManually(
  stickerId: string,
  metadata: StickerAnnotationMetadata,
): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  const normalized = normalizeAnnotationMetadata(metadata);
  if (!normalized.description) {
    throw new Error('手动完成 Sticker 标注必须提供非空描述');
  }
  const completed = await runtime.repository.completeAnnotationManually(
    requireId(stickerId, 'Sticker'),
    normalized,
    runtime.now(),
  );
  emitStickerAnnotationChanged();
  emitStickerEmbeddingPending();
  return completed;
}

export async function failStickerAnnotation(
  input: FailStickerAnnotationInput,
): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  const error = input.error.trim();
  if (!error) throw new Error('标注失败必须提供错误原因');
  const failed = await runtime.repository.failAnnotation(
    requireId(input.stickerId, 'Sticker'),
    requireId(input.claimId, '标注 claim'),
    error,
    runtime.now(),
  );
  emitStickerAnnotationChanged();
  return failed;
}

/** 前台被中断时释放 claim；该路径回到 pending，不计为失败。 */
export async function releaseStickerAnnotation(
  input: ReleaseStickerAnnotationInput,
): Promise<Sticker> {
  const runtime = getStickersRuntimeDependencies();
  const released = await runtime.repository.releaseAnnotation(
    requireId(input.stickerId, 'Sticker'),
    requireId(input.claimId, '标注 claim'),
    input.now ?? runtime.now(),
  );
  emitStickerAnnotationChanged();
  emitStickerAnnotationPending();
  return released;
}

/** Host 确认同一 JS 进程没有旧 worker 后调用，立即回收全部 processing。 */
export async function recoverInterruptedStickerAnnotations(): Promise<number> {
  const runtime = getStickersRuntimeDependencies();
  const recovered = await runtime.repository.recoverInterruptedAnnotationClaims(runtime.now());
  if (recovered > 0) {
    emitStickerAnnotationChanged();
    emitStickerAnnotationPending();
  }
  return recovered;
}

function normalizeAnnotationMetadata(metadata: StickerAnnotationMetadata): StickerAnnotationMetadata {
  const normalized: StickerAnnotationMetadata = {};
  if (metadata.name !== undefined) {
    normalized.name = normalizeBoundedName(metadata.name, 'Sticker 名称', 120);
  }
  if (metadata.description !== undefined) {
    normalized.description = normalizeStickerOptionalText(metadata.description);
  }
  if (metadata.tags !== undefined) {
    normalized.tags = normalizeStickerTags(metadata.tags);
  }
  if (metadata.emotion !== undefined) {
    normalized.emotion = normalizeStickerOptionalText(metadata.emotion);
  }
  return normalized;
}

function normalizeGroupId(groupId: string | null | undefined): string | null {
  const normalized = groupId?.trim() ?? '';
  return normalized || null;
}

function normalizeDimension(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须为正数`);
  }
  const integer = Math.floor(value);
  if (integer <= 0) throw new Error(`${label}必须至少为 1`);
  if (integer > STICKER_MAX_DIMENSION_PX) {
    throw new Error(`表情包最长边不能超过 ${STICKER_MAX_DIMENSION_PX}px`);
  }
  return integer;
}

function requireStickerFileSize(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('无法读取表情包文件大小');
  }
  if (value > STICKER_MAX_FILE_SIZE_BYTES) {
    throw new Error('单个表情包不能超过 5MB');
  }
}

function requireId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} ID 不能为空`);
  return normalized;
}

function normalizeBoundedName(value: string, label: string, maxLength: number): string {
  const normalized = normalizeStickerName(value);
  if (normalized.length > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}
