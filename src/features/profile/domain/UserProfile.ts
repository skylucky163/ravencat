import { DEFAULT_SELF_NAME, SELF_USER_ID } from '@shared';

export const SELF_USER_PROFILE_ID = SELF_USER_ID;
export const DEFAULT_SELF_USER_NAME = DEFAULT_SELF_NAME;

export interface UserProfile {
  id: string;
  name: string;
  gender: string;
  age: number | null;
  identity: string;
  region: string;
  other: string;
  signature: string;
  avatar: string | null;
  /** canonical 头像身份；avatar 是当前展示 URI，未迁移时直接来自 legacy 列。 */
  avatarMediaAssetId: string | null;
  momentsCover: string | null;
  /** 封面稳定身份；momentsCover 只用于当前设备展示。 */
  momentsCoverMediaAssetId: string | null;
  updatedAt: string;
}

export interface UpdateUserProfileInput {
  name?: string;
  gender?: string;
  age?: number | null;
  identity?: string;
  region?: string;
  other?: string;
  signature?: string;
  avatar?: string | null;
}

export interface UserProfileRow {
  id: string;
  name: string;
  gender: string;
  age: number | null;
  identity: string;
  region: string;
  other: string;
  signature: string;
  avatar?: string | null;
  avatar_media_asset_id?: string | null;
  moments_cover?: string | null;
  moments_cover_media_asset_id?: string | null;
  updated_at: string;
}

function normalizeName(name?: string | null): string {
  const trimmed = String(name || '').trim();
  return trimmed || DEFAULT_SELF_USER_NAME;
}

function normalizeNullableString(value?: string | null): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

export function createUserProfile(data: Partial<UserProfile> = {}): UserProfile {
  return {
    id: data.id || SELF_USER_PROFILE_ID,
    name: normalizeName(data.name),
    gender: data.gender ?? '',
    age: data.age ?? null,
    identity: data.identity ?? '',
    region: data.region ?? '',
    other: data.other ?? '',
    signature: data.signature ?? '',
    avatar: normalizeNullableString(data.avatar),
    avatarMediaAssetId: normalizeNullableString(data.avatarMediaAssetId),
    momentsCover: normalizeNullableString(data.momentsCover),
    momentsCoverMediaAssetId: normalizeNullableString(data.momentsCoverMediaAssetId),
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
}

export function createDefaultUserProfile(now = new Date().toISOString()): UserProfile {
  return createUserProfile({
    id: SELF_USER_PROFILE_ID,
    name: DEFAULT_SELF_USER_NAME,
    avatar: null,
    avatarMediaAssetId: null,
    momentsCover: null,
    updatedAt: now,
  });
}

/** 展示占位资料复用业务默认值，固定时间戳使其不表达真实资料更新时间。 */
export const DEFAULT_USER_PROFILE = createDefaultUserProfile(new Date(0).toISOString());

export function createUserProfileFromRow(row: UserProfileRow | null | undefined): UserProfile | null {
  if (!row) return null;

  return createUserProfile({
    id: row.id,
    name: row.name,
    gender: row.gender,
    age: row.age,
    identity: row.identity,
    region: row.region,
    other: row.other,
    signature: row.signature,
    avatar: row.avatar,
    avatarMediaAssetId: row.avatar_media_asset_id,
    momentsCover: row.moments_cover,
    momentsCoverMediaAssetId: row.moments_cover_media_asset_id,
    updatedAt: row.updated_at,
  });
}
