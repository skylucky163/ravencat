/** Sticker 收藏库的查询与 MediaAsset URI 解析。 */

import {
  StickerNotFoundError,
  type ListStickersInput,
  type SearchStickersInput,
  type Sticker,
  type StickerGroup,
} from '../domain/Sticker';
import type { StickerGroupReadySummary } from '../domain/StickerRepository';
import type { StickerGroupPageCursor } from '../domain/StickerSearch';
import { getStickersRuntimeDependencies } from './StickerRuntime';

export interface ResolvedStickerMedia {
  sticker: Sticker;
  localUri: string;
}

export function listStickerGroups(): Promise<StickerGroup[]> {
  return getStickersRuntimeDependencies().repository.listGroups();
}

export function listStickers(input: ListStickersInput = {}): Promise<Sticker[]> {
  return getStickersRuntimeDependencies().repository.listStickers(input);
}

/** 同素材在不同 AI 收藏中有不同 ID，用户是否已添加只按用户库的素材身份判断。 */
export async function isStickerInUserLibrary(mediaAssetId: string): Promise<boolean> {
  return await getStickersRuntimeDependencies().repository.getStickerByMediaAssetId(mediaAssetId) !== null;
}

/** 只按 Sticker 结构化字段查询，AI 不需要在每次选择时重新执行视觉识别。 */
export function searchStickers(input: SearchStickersInput = {}): Promise<Sticker[]> {
  return getStickersRuntimeDependencies().repository.searchStickers(input);
}

export async function getStickerById(stickerId: string, assistantId?: string): Promise<Sticker> {
  const id = requireId(stickerId);
  const sticker = await getStickersRuntimeDependencies().repository.getStickerById(id, assistantId);
  if (!sticker) throw new StickerNotFoundError(id);
  return sticker;
}

/** AI 分组浏览：只返回包含 ready Sticker 的分组及其 ready 数量。 */
export function listStickerGroupsForAI(): Promise<StickerGroupReadySummary[]> {
  return getStickersRuntimeDependencies().repository.listStickerGroupReadySummaries();
}

export interface StickerGroupPage {
  stickers: Sticker[];
  nextCursor: StickerGroupPageCursor | null;
}

/** AI 分组浏览：keyset 分页，只返回 ready Sticker，按 (createdAt, id) 稳定排序。 */
export async function listStickersInGroupForAI(
  groupId: string,
  cursor: StickerGroupPageCursor | null,
  limit: number,
): Promise<StickerGroupPage> {
  const runtime = getStickersRuntimeDependencies();
  const stickers = await runtime.repository.listStickersInGroupForAI({
    groupId: requireId(groupId),
    cursor,
    limit,
  });
  const last = stickers[stickers.length - 1];
  const hasMore = stickers.length === limit;
  return {
    stickers,
    nextCursor: hasMore && last
      ? { createdAt: last.createdAt, stickerId: last.id }
      : null,
  };
}

export async function resolveStickerMedia(stickerId: string): Promise<ResolvedStickerMedia> {
  const runtime = getStickersRuntimeDependencies();
  const sticker = await getStickerById(stickerId);
  const resolved = await runtime.media.resolveMediaAsset(sticker.mediaAssetId);
  return { sticker, localUri: resolved.localUri };
}

function requireId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Sticker ID 不能为空');
  return normalized;
}
