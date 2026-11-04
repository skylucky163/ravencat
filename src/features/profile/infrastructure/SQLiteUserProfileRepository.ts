/** 用户资料仓储的 SQLite 实现。 */
import {
  databaseCoordinator,
  type DatabaseTransactionExecutor,
} from '@platform/persistence';
import { resolveMediaAssetReferenceUri } from '@features/media';
import { SettingChangeConflictError } from '@shared/errors/SettingChangeConflictError';
import {
  createDefaultUserProfile,
  createUserProfile,
  createUserProfileFromRow,
  SELF_USER_PROFILE_ID,
  type UpdateUserProfileInput,
  type UserProfile,
  type UserProfileRow,
} from '../domain/UserProfile';
import type {
  MomentsCoverSelection,
  CommitUserAvatarMediaAssetReferenceInput,
  UserAvatarMediaAssetReference,
  UserAvatarMediaAssetMigrationCandidate,
} from '../domain/UserProfileRepository';

export class SQLiteUserProfileRepository {
  /** 恢复只重定位尚未迁移的头像；封面已进入稳定资产，不再重写运行时 URI。 */
  async rebaseRestoredMediaInTransaction(transaction: DatabaseTransactionExecutor, rebase: (uri: string | null) => string | null): Promise<void> {
    const rows = await transaction.getAllAsync<{ id: string; avatar: string }>('SELECT id, avatar FROM user_profile WHERE avatar_media_asset_id IS NULL AND avatar IS NOT NULL');
    for (const row of rows) {
      const avatar = rebase(row.avatar);
      if (avatar !== row.avatar) await transaction.runAsync('UPDATE user_profile SET avatar = ? WHERE id = ?', [avatar, row.id]);
    }
  }
  private async resolveMedia(profile: UserProfile): Promise<UserProfile> {
    const resolved = { ...profile };
    try {
      resolved.avatar = await resolveMediaAssetReferenceUri({ mediaAssetId: profile.avatarMediaAssetId, legacyUri: profile.avatar });
    } catch (error) {
      console.warn('[UserProfileRepository] 当前用户头像资产解析失败：', error);
      resolved.avatar = null;
    }
    try {
      resolved.momentsCover = await resolveMediaAssetReferenceUri({ mediaAssetId: profile.momentsCoverMediaAssetId, legacyUri: profile.momentsCover });
    } catch (error) {
      console.warn('[UserProfileRepository] 当前用户封面资产解析失败：', error);
      resolved.momentsCover = null;
    }
    return resolved;
  }

  /** null 只表示资料行不存在；读取故障交给调用方处理。 */
  async get(): Promise<UserProfile | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'profile.get', feature: 'profile', priority: 'runtime' });
    const row = await db.getFirstAsync<UserProfileRow>(
      'SELECT * FROM user_profile WHERE id = ? LIMIT 1',
      [SELF_USER_PROFILE_ID]
    );
    const profile = createUserProfileFromRow(row);
    return profile ? await this.resolveMedia(profile) : null;
  }

  async ensureDefault(): Promise<UserProfile> {
    const existing = await this.get();
    if (existing) return existing;

    const profile = createDefaultUserProfile();
    const db = databaseCoordinator.openTaskExecutor({ name: 'profile.ensureDefault', feature: 'profile', priority: 'runtime' });
    await db.runAsync(
      `INSERT OR IGNORE INTO user_profile
       (id, name, avatar, avatar_media_asset_id, moments_cover, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        profile.id,
        profile.name,
        profile.avatar,
        profile.avatarMediaAssetId,
        profile.momentsCover,
        profile.updatedAt,
      ]
    );

    const persisted = await this.get();
    if (!persisted) throw new Error('当前用户资料不存在');
    return persisted;
  }

  async update(updates: UpdateUserProfileInput): Promise<UserProfile> {
    const existing = await this.ensureDefault();
    const nextProfile = createUserProfile({
      ...existing,
      name: updates.name !== undefined ? updates.name : existing.name,
      avatar: updates.avatar !== undefined ? updates.avatar : existing.avatar,
      updatedAt: new Date().toISOString(),
    });

    const db = databaseCoordinator.openTaskExecutor({ name: 'profile.update', feature: 'profile', priority: 'runtime' });
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(nextProfile.name);
    }
    // 只写本次变更的字段，自动保存和头像提交互不覆盖其他资料。
    for (const field of ['gender', 'age', 'identity', 'region', 'other', 'signature'] as const) {
      if (updates[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }
    if (updates.avatar !== undefined) {
      fields.push('avatar = ?', 'avatar_media_asset_id = NULL');
      values.push(nextProfile.avatar);
    }
    fields.push('updated_at = ?');
    values.push(nextProfile.updatedAt, SELF_USER_PROFILE_ID);

    const row = await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `UPDATE user_profile
         SET ${fields.join(', ')}
         WHERE id = ?`,
        values,
      );
      const persisted = await transaction.getFirstAsync<UserProfileRow>(
        'SELECT * FROM user_profile WHERE id = ? LIMIT 1',
        [SELF_USER_PROFILE_ID],
      );
      if (!persisted) {
        throw new Error('当前用户资料不存在');
      }
      return persisted;
    });

    const persistedProfile = createUserProfileFromRow(row);
    if (!persistedProfile) {
      throw new Error('当前用户资料解析失败');
    }
    return this.resolveMedia(persistedProfile);
  }

  getMomentsCoverSelection(): Promise<MomentsCoverSelection> {
    return databaseCoordinator.read({ name: 'profile.cover.selection', feature: 'profile', priority: 'interactive' }, async (db) => {
      const row = await db.getFirstAsync<MomentsCoverSelection>(
        'SELECT moments_cover AS legacyUri, moments_cover_media_asset_id AS mediaAssetId, moments_cover_revision AS revision FROM user_profile WHERE id = ?', [SELF_USER_PROFILE_ID]);
      if (!row) throw new Error('当前用户资料不存在');
      return row;
    });
  }

  async commitMomentsCoverInTransaction(transaction: DatabaseTransactionExecutor, expectedRevision: number, assetId: string | null): Promise<void> {
    const result = await transaction.runAsync(
      'UPDATE user_profile SET moments_cover = NULL, moments_cover_media_asset_id = ?, moments_cover_revision = moments_cover_revision + 1, updated_at = ? WHERE id = ? AND moments_cover_revision = ?',
      [assetId, new Date().toISOString(), SELF_USER_PROFILE_ID, expectedRevision]);
    if (result.changes !== 1) throw new SettingChangeConflictError('时刻封面已被其他操作更改，本次选择未保存。');
  }

  async getAvatarMediaAssetReference(
    ownerId: string,
  ): Promise<UserAvatarMediaAssetReference | null> {
    const db = databaseCoordinator.openTaskExecutor({
      name: 'profile.get-avatar-media-asset-reference',
      feature: 'profile',
      priority: 'runtime',
    });
    const row = await db.getFirstAsync<{
      avatar: string | null;
      avatar_media_asset_id: string | null;
    }>(
      'SELECT avatar, avatar_media_asset_id FROM user_profile WHERE id = ? LIMIT 1',
      [ownerId],
    );
    return row
      ? { avatar: row.avatar, avatarMediaAssetId: row.avatar_media_asset_id }
      : null;
  }

  async listAvatarMediaAssetMigrationCandidates(): Promise<UserAvatarMediaAssetMigrationCandidate[]> {
    const db = databaseCoordinator.openTaskExecutor({
      name: 'profile.list-avatar-media-asset-candidates',
      feature: 'profile',
      priority: 'maintenance',
    });
    return db.getAllAsync<UserAvatarMediaAssetMigrationCandidate>(
      `SELECT id, avatar
       FROM user_profile
       WHERE avatar IS NOT NULL
         AND TRIM(avatar) <> ''
         AND avatar_media_asset_id IS NULL
       ORDER BY id ASC`,
    );
  }

  async commitAvatarMediaAssetReferenceInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitUserAvatarMediaAssetReferenceInput,
  ): Promise<void> {
    const result = await transaction.runAsync(
      `UPDATE user_profile
       SET avatar = NULL,
           avatar_media_asset_id = ?,
           updated_at = ?
       WHERE id = ?
         AND ((avatar IS NULL AND ? IS NULL) OR avatar = ?)
         AND (
           (avatar_media_asset_id IS NULL AND ? IS NULL)
           OR avatar_media_asset_id = ?
         )`,
      [
        input.mediaAssetId,
        new Date().toISOString(),
        input.ownerId,
        input.expectedAvatar,
        input.expectedAvatar,
        input.expectedAvatarMediaAssetId,
        input.expectedAvatarMediaAssetId,
      ],
    );
    if (result.changes !== 1) {
      throw new SettingChangeConflictError('用户头像已被其他操作修改，本次选择未保存。');
    }
  }
}

export const userProfileRepository = new SQLiteUserProfileRepository();
