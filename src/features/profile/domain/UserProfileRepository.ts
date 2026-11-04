/** 用户资料持久化端口，供应用流程与具体存储实现解耦。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type { UpdateUserProfileInput, UserProfile } from './UserProfile';

/** Host M3b 头像迁移只读取当前 owner 的 legacy URI，不读取 Moments snapshot。 */
export interface UserAvatarMediaAssetMigrationCandidate {
  id: string;
  avatar: string;
}

export interface CommitUserAvatarMediaAssetReferenceInput {
  ownerId: string;
  expectedAvatar: string | null;
  expectedAvatarMediaAssetId: string | null;
  mediaAssetId: string | null;
}

export interface UserAvatarMediaAssetReference {
  avatar: string | null;
  avatarMediaAssetId: string | null;
}

export interface MomentsCoverSelection { legacyUri: string | null; mediaAssetId: string | null; revision: number }

export interface IUserProfileRepository {
  get(): Promise<UserProfile | null>;
  ensureDefault(): Promise<UserProfile>;
  update(updates: UpdateUserProfileInput): Promise<UserProfile>;
  getMomentsCoverSelection(): Promise<MomentsCoverSelection>;
  commitMomentsCoverInTransaction(transaction: DatabaseTransactionExecutor, expectedRevision: number, assetId: string | null): Promise<void>;
  getAvatarMediaAssetReference(ownerId: string): Promise<UserAvatarMediaAssetReference | null>;
  listAvatarMediaAssetMigrationCandidates(): Promise<UserAvatarMediaAssetMigrationCandidate[]>;
  commitAvatarMediaAssetReferenceInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitUserAvatarMediaAssetReferenceInput,
  ): Promise<void>;
}
