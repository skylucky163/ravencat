/** 组装用户资料用例与 SQLite 仓储。 */
import type {
  UpdateUserProfileInput,
  UserProfile,
} from './domain/UserProfile';
import { SELF_USER_PROFILE_ID } from './domain/UserProfile';
import {
  createMediaAssetWithReference,
  commitCroppedImageSelection,
  MEDIA_ASSET_STORAGE_BACKEND,
  releaseMediaAssetCandidates,
} from '@features/media';
import type { PersistentAvatarDraft } from '@platform/device/DeviceMediaService';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { userProfileRepository } from './infrastructure/SQLiteUserProfileRepository';
import { clearLegacyCachedMomentsCover, ensureMomentsCoverSelection, setMomentsCover } from './application/MomentsCoverSettings';
import type {
  CommitUserAvatarMediaAssetReferenceInput,
  UserAvatarMediaAssetMigrationCandidate,
} from './domain/UserProfileRepository';

export { userProfileRepository } from './infrastructure/SQLiteUserProfileRepository';

export async function ensureCurrentUserMomentsCover(): Promise<void> {
  await userProfileRepository.ensureDefault();
  await ensureMomentsCoverSelection(userProfileRepository);
}

export async function clearCurrentUserLegacyCachedMomentsCover(): Promise<boolean> {
  await userProfileRepository.ensureDefault();
  const cleared = await clearLegacyCachedMomentsCover(userProfileRepository);
  if (cleared) emitUserProfileUpdated(await userProfileRepository.ensureDefault());
  return cleared;
}

export async function getCurrentUserProfile(): Promise<UserProfile> {
  await userProfileRepository.ensureDefault();
  // 界面保留选择与清除入口；不可读封面仍由严格备份前置拒绝，不改写为默认。
  try { await ensureMomentsCoverSelection(userProfileRepository); }
  catch (error) { console.warn('[Profile] 封面迁移未完成，保留选择供修复：', error); }
  return userProfileRepository.ensureDefault();
}

// 文字资料与 legacy 头像更新
//
// 改名只写 user_profile：Moments V2 的作者身份是 authorId，历史朋友圈/评论/点赞
// 保留写入时的 name snapshot，展示时按 authorId 解析当前名称，因此改名不重写任何历史行。
export async function updateCurrentUserProfile(
  updates: UpdateUserProfileInput
): Promise<UserProfile> {
  // 头像替换会清掉旧的 avatar_media_asset_id：替换前读一次旧引用作为 targeted release 候选。
  const replacesAvatar = updates.avatar !== undefined;
  let previousAvatarMediaAssetId: string | null = null;
  if (replacesAvatar) {
    const previous = await userProfileRepository.getAvatarMediaAssetReference(SELF_USER_PROFILE_ID);
    previousAvatarMediaAssetId = previous?.avatarMediaAssetId ?? null;
  }

  const updatedProfile = await userProfileRepository.update(updates);
  if (replacesAvatar) {
    await releaseMediaAssetCandidates([previousAvatarMediaAssetId]);
  }
  emitUserProfileUpdated(updatedProfile);
  return updatedProfile;
}

/** 新头像直接提交 canonical MediaAsset；legacy URI 只留给启动迁移读取。 */
export async function updateCurrentUserAvatarFromDraft(
  draft: PersistentAvatarDraft,
): Promise<UserProfile> {
  const expected = await userProfileRepository.getAvatarMediaAssetReference(SELF_USER_PROFILE_ID);
  if (!expected) {
    throw new Error('当前用户资料不存在');
  }
  await createMediaAssetWithReference(
    {
      storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentImage,
      sourceUri: draft.uri,
      fileName: draft.fileName,
      mimeType: draft.mimeType,
      width: draft.width,
      height: draft.height,
      durationMs: null,
    },
    ({ transaction, asset }) => userProfileRepository.commitAvatarMediaAssetReferenceInTransaction(
      transaction,
      {
        ownerId: SELF_USER_PROFILE_ID,
        expectedAvatar: expected.avatar,
        expectedAvatarMediaAssetId: expected.avatarMediaAssetId,
        mediaAssetId: asset.id,
      },
    ),
  );
  await releaseMediaAssetCandidates([expected.avatarMediaAssetId]);
  const updatedProfile = await userProfileRepository.ensureDefault();
  emitUserProfileUpdated(updatedProfile);
  return updatedProfile;
}

// 朋友圈封面更新
export async function updateCurrentUserMomentsCover(
  sourceUri: string | null,
  sourceWidth?: number,
): Promise<UserProfile> {
  await userProfileRepository.ensureDefault();
  await setMomentsCover(userProfileRepository, sourceUri, sourceWidth);
  const updatedProfile = await userProfileRepository.ensureDefault();

  emitUserProfileUpdated(updatedProfile);
  return updatedProfile;
}

export async function getCurrentUserMomentsCoverImageSelection() {
  await ensureCurrentUserMomentsCover();
  return userProfileRepository.getMomentsCoverSelection();
}

/** Profile 持有用户头像引用，AI 与手动编辑共享同一 CAS 与更新事实。 */
export async function changeCurrentUserAvatarFromMediaAsset(mediaAssetId: string | null, signal: AbortSignal,
  guard: (transaction: DatabaseTransactionExecutor) => Promise<void>) {
  await userProfileRepository.ensureDefault();
  const expected = (await userProfileRepository.getAvatarMediaAssetReference(SELF_USER_PROFILE_ID))!;
  const result = await commitCroppedImageSelection({ mediaAssetId, aspect: [1, 1], signal }, async (tx, assetId) => {
    await guard(tx);
    await userProfileRepository.commitAvatarMediaAssetReferenceInTransaction(tx, { ownerId: SELF_USER_PROFILE_ID,
      expectedAvatar: expected.avatar, expectedAvatarMediaAssetId: expected.avatarMediaAssetId, mediaAssetId: assetId });
  });
  await releaseMediaAssetCandidates([expected.avatarMediaAssetId]);
  emitUserProfileUpdated(await userProfileRepository.ensureDefault());
  return result;
}

export async function changeCurrentUserMomentsCoverFromMediaAsset(mediaAssetId: string | null, signal: AbortSignal,
  guard: (transaction: DatabaseTransactionExecutor) => Promise<void>) {
  await userProfileRepository.ensureDefault();
  const expected = await userProfileRepository.getMomentsCoverSelection();
  const result = await commitCroppedImageSelection({ mediaAssetId, aspect: [16, 9], signal }, async (tx, assetId) => {
    await guard(tx);
    await userProfileRepository.commitMomentsCoverInTransaction(tx, expected.revision, assetId);
  });
  await releaseMediaAssetCandidates([expected.mediaAssetId]);
  emitUserProfileUpdated(await userProfileRepository.ensureDefault());
  return result;
}

/** Host-only M3b maintenance：列出当前 user_profile 的 legacy 头像候选。 */
export function listUserAvatarMediaAssetMigrationCandidates(): Promise<
  UserAvatarMediaAssetMigrationCandidate[]
> {
  return userProfileRepository.listAvatarMediaAssetMigrationCandidates();
}

/** Host-only M3b maintenance：与 MediaAsset 行在同一事务内提交 owner 引用。 */
export function commitUserAvatarMediaAssetReferenceInTransaction(
  transaction: DatabaseTransactionExecutor,
  input: CommitUserAvatarMediaAssetReferenceInput,
): Promise<void> {
  return userProfileRepository.commitAvatarMediaAssetReferenceInTransaction(transaction, input);
}

export type {
  CommitUserAvatarMediaAssetReferenceInput,
  UserAvatarMediaAssetMigrationCandidate,
} from './domain/UserProfileRepository';

export type UserProfileUpdatedListener = (
  profile: UserProfile
) => void;

const userProfileUpdatedListeners =
  new Set<UserProfileUpdatedListener>();

function emitUserProfileUpdated(profile: UserProfile): void {
  for (const listener of userProfileUpdatedListeners) {
    listener(profile);
  }
}

export function subscribeUserProfileUpdated(
  listener: UserProfileUpdatedListener
): () => void {
  userProfileUpdatedListeners.add(listener);

  return () => {
    userProfileUpdatedListeners.delete(listener);
  };
}

export { configureWallpaperRuntime, ensureWallpaperSelections } from './application/WallpaperSettings';
export { wallpaperRepository } from './infrastructure/SQLiteWallpaperRepository';
