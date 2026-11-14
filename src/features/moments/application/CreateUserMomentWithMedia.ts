/** 用户多图 Moment 发布：backing 在事务外准备，catalog 与全部业务事实同事务提交。 */
import {
  MEDIA_ASSET_STORAGE_BACKEND,
  type CreateMediaAssetInput,
} from '@features/media';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { MomentDomainError } from '../domain/MomentErrors';
import type { Moment, MomentAudience } from '../domain/MomentRepository';
import { MAX_MOMENT_MEDIA_COUNT, prepareUserMoment, type MomentAudienceDirectory } from './CreateMoment';
import { startNewMomentMediaAnalysis } from './MomentMediaAnalysis';
import { getMomentMediaRuntime } from './MomentMediaRuntime';
import { createMomentMediaId } from './MomentIds';

export { MAX_MOMENT_MEDIA_COUNT } from './CreateMoment';

export interface MomentMediaDraft {
  uri: string;
  fileName: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
}

export interface CreateUserMomentWithMediaInput {
  content: string;
  media: readonly MomentMediaDraft[];
  /** 可选显示地点；与 Moment 行在同一次事务提交。 */
  locationLabel?: string | null;
  audience?: MomentAudience;
  abortSignal?: AbortSignal;
}

export function toMediaAssetInput(draft: MomentMediaDraft): CreateMediaAssetInput {
  const sourceUri = draft.uri?.trim();
  const mimeType = draft.mimeType?.trim().toLowerCase();
  if (!sourceUri || !mimeType.startsWith('image/')) {
    throw new MomentDomainError('invalid_media', '时刻图片必须是有效的图片文件');
  }
  return {
    storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentImage,
    sourceUri,
    fileName: draft.fileName?.trim() || null,
    mimeType,
    width: draft.width,
    height: draft.height,
    durationMs: null,
  };
}

export async function createUserMomentWithMedia(
  directory: MomentAudienceDirectory,
  input: CreateUserMomentWithMediaInput
): Promise<Moment> {
  if (input.media.length === 0 || input.media.length > MAX_MOMENT_MEDIA_COUNT) {
    throw new MomentDomainError(
      input.media.length > MAX_MOMENT_MEDIA_COUNT ? 'too_many_media' : 'invalid_media',
      `请选择 1-${MAX_MOMENT_MEDIA_COUNT} 张图片`
    );
  }
  const mediaInputs = input.media.map(toMediaAssetInput);
  const sourceUris = new Set(mediaInputs.map((item) => item.sourceUri));
  if (sourceUris.size !== mediaInputs.length) {
    throw new MomentDomainError('invalid_media', '不能重复选择同一张图片');
  }

  const runtime = getMomentMediaRuntime();
  const momentInput = await prepareUserMoment(directory, input);
  const prepared = await runtime.prepareMedia(mediaInputs);

  // prepareMedia 一旦返回，backing 的所有权就转移给本次 command：事务没有提交的任何
  // 退出路径（abort、事务失败）都必须由这里清理，否则会留下没有任何 catalog 或业务
  // 引用指向的 orphan backing。
  let staged = false;
  let moment: Moment;
  try {
    throwIfAbortSignalAborted(input.abortSignal);

    moment = await runtime.database.withExclusiveTransactionAsync(async (transaction) => {
      const committed = await prepared.commitInTransaction(transaction);
      staged = true;
      return runtime.repository.createMomentInTransaction(transaction, {
        ...momentInput,
        media: committed.assets.map((asset, sortOrder) => ({
          id: createMomentMediaId(),
          mediaAssetId: asset.id,
          sortOrder,
        })),
      });
    });
  } catch (error) {
    // 清理失败不能覆盖原始失败原因：两者的真实原因都保留在 AggregateError 里。
    try {
      if (staged) await prepared.discardAfterRollback();
      else await prepared.discard();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        '时刻媒体发布失败且 prepared backing 清理失败'
      );
    }
    throw error;
  }

  try {
    await prepared.finalizeAfterCommit();
  } catch (error) {
    // 事实已经提交；复用 backing 的清理失败不能伪装成发布失败。
    console.warn('[Moments] MediaAsset 提交后清理失败：', error);
  }

  startNewMomentMediaAnalysis(moment.id);
  return moment;
}
