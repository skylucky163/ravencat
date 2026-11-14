/** 原帖编辑的共同业务入口：模型只提供 patch，作者身份由可信调用方注入。 */
import { releaseMediaAssetCandidates } from '@features/media';
import { SELF_USER_PROFILE_ID } from '@features/profile';
import { CoordinatedDatabaseError } from '@platform/persistence';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { MomentDomainError } from '../domain/MomentErrors';
import { normalizeMomentLocationLabel } from '../domain/MomentLocation';
import type { EditMomentInput, EditMomentResult, IMomentRepository, MomentAudience } from '../domain/MomentRepository';
import { MAX_MOMENT_MEDIA_COUNT, normalizeAudience, validateMomentMediaAssetIds, type MomentAudienceDirectory } from './CreateMoment';
import { toMediaAssetInput, type MomentMediaDraft } from './CreateUserMomentWithMedia';
import { createMomentMediaId } from './MomentIds';
import { startNewMomentMediaAnalysis } from './MomentMediaAnalysis';
import { getMomentMediaRuntime } from './MomentMediaRuntime';

export type MomentEditorMedia = MomentMediaDraft | { mediaAssetId: string };

export interface MomentEditDraft {
  content: string;
  locationLabel: string | null;
  audience: MomentAudience;
  media: readonly MomentEditorMedia[];
}

interface MomentPatch {
  content?: string;
  audience?: MomentAudience;
}

const listeners = new Set<(momentId: string) => void>();
export function subscribeMomentEdited(listener: (momentId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function preparePatch(directory: MomentAudienceDirectory, patch: MomentPatch): Promise<MomentPatch> {
  const result: MomentPatch = {};
  if (patch.content !== undefined) {
    const content = patch.content.trim();
    if (!content || content.length > 2000) throw new MomentDomainError('empty_content', '时刻正文长度必须为 1-2000 字');
    result.content = content;
  }
  if (patch.audience !== undefined) result.audience = normalizeAudience(await directory.listAgentIds(), patch.audience);
  return result;
}

async function afterEdit(result: EditMomentResult): Promise<void> {
  if (!result.changed) return;
  listeners.forEach(listener => listener(result.moment.id));
  if (result.addedMediaIds.length) startNewMomentMediaAnalysis(result.moment.id, result.addedMediaIds);
  if (result.removedMediaAssetIds.length) {
    // 编辑已经提交，媒体回收失败不能把已成功的编辑伪装成失败。
    try { await releaseMediaAssetCandidates(result.removedMediaAssetIds); }
    catch (error) { console.warn('[Moments] 编辑后媒体回收失败：', error); }
  }
}

export async function editOwnMomentAsAgent(
  repository: IMomentRepository,
  directory: MomentAudienceDirectory,
  input: MomentPatch & { momentId: string; agentId: string; mediaAssetIds?: readonly string[]; abortSignal?: AbortSignal },
) {
  if (input.content === undefined && input.audience === undefined && input.mediaAssetIds === undefined) {
    throw new MomentDomainError('empty_edit', '请至少提供一个需要修改的字段');
  }
  const patch = await preparePatch(directory, input);
  const media = input.mediaAssetIds === undefined ? undefined
    : (await validateMomentMediaAssetIds(input.mediaAssetIds)).map((mediaAssetId, sortOrder) => ({ id: createMomentMediaId(), mediaAssetId, sortOrder }));
  throwIfAbortSignalAborted(input.abortSignal);
  const result = await repository.editMoment({ ...patch, momentId: input.momentId, actorType: 'ai', actorId: input.agentId, media });
  await afterEdit(result);
  return result.moment;
}

export async function loadUserMomentEditDraft(repository: IMomentRepository, momentId: string) {
  const snapshot = await repository.getMomentEditSnapshotForUser(momentId);
  if (!snapshot) throw new MomentDomainError('moment_not_found', '这条时刻已不存在');
  const { moment, media, audience } = snapshot;
  if (moment.authorType !== 'user' || moment.authorId !== SELF_USER_PROFILE_ID) {
    throw new MomentDomainError('not_moment_owner', '只能编辑自己发布的时刻');
  }
  return {
    expectedRevision: moment.editRevision,
    draft: { content: moment.content, locationLabel: moment.locationLabel, audience,
      media: media.map(item => ({ mediaAssetId: item.mediaAssetId })) } satisfies MomentEditDraft,
  };
}

export async function editOwnMomentAsUser(
  repository: IMomentRepository,
  directory: MomentAudienceDirectory,
  input: MomentEditDraft & { momentId: string; expectedRevision: number },
) {
  const patch = await preparePatch(directory, input);
  if (input.media.length > MAX_MOMENT_MEDIA_COUNT) throw new MomentDomainError('too_many_media', `时刻最多附带 ${MAX_MOMENT_MEDIA_COUNT} 张图片`);
  const locationLabel = normalizeMomentLocationLabel(input.locationLabel);
  const files = input.media.filter((item): item is MomentMediaDraft => !('mediaAssetId' in item));
  if (new Set(files.map(item => item.uri)).size !== files.length) throw new MomentDomainError('invalid_media', '不能重复选择同一张图片');
  const editInput: EditMomentInput = { ...patch, locationLabel, momentId: input.momentId, expectedRevision: input.expectedRevision,
    actorType: 'user', actorId: SELF_USER_PROFILE_ID };
  const references = (newIds: readonly string[]) => {
    let index = 0;
    const ids = input.media.map(item => 'mediaAssetId' in item ? item.mediaAssetId : newIds[index++]);
    if (new Set(ids).size !== ids.length) throw new MomentDomainError('invalid_media', '不能重复选择同一张图片');
    return ids.map((mediaAssetId, sortOrder) => ({ id: createMomentMediaId(), mediaAssetId, sortOrder }));
  };
  let result: EditMomentResult;
  if (files.length === 0) {
    result = await repository.editMoment({ ...editInput, media: references([]) });
  } else {
    const runtime = getMomentMediaRuntime();
    const prepared = await runtime.prepareMedia(files.map(toMediaAssetInput));
    let staged = false;
    try {
      result = await runtime.database.withExclusiveTransactionAsync(async transaction => {
        const committed = await prepared.commitInTransaction(transaction);
        staged = true;
        return repository.editMomentInTransaction(transaction, { ...editInput, media: references(committed.assets.map(asset => asset.id)) });
      });
    } catch (error) {
      try {
        if (staged) await prepared.discardAfterRollback();
        else await prepared.discard();
      } catch (cleanupError) { throw new AggregateError([error, cleanupError], '时刻编辑失败且媒体清理失败'); }
      if (error instanceof CoordinatedDatabaseError && error.cause instanceof MomentDomainError) throw error.cause;
      throw error;
    }
    try { await prepared.finalizeAfterCommit(); }
    catch (error) { console.warn('[Moments] 编辑媒体提交后清理失败：', error); }
  }
  await afterEdit(result);
  return result.moment;
}
