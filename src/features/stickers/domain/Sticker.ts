/** Sticker 收藏库的领域对象与结构化查询值对象。 */

export type StickerAnnotationStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'manual_required'
  | 'failed';

/** 来源文件名只是展示/审计元数据，不承担媒体文件的存储定位职责。 */
export interface Sticker {
  id: string;
  mediaAssetId: string;
  /** null 表示用户收藏；AI 收藏由角色 ID 独立持有。 */
  ownerAssistantId: string | null;
  groupId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  emotion: string | null;
  sourceFileName: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  isAnimated: boolean;
  isFavorite: boolean;
  useCount: number;
  lastUsedAt: string | null;
  annotationStatus: StickerAnnotationStatus;
  annotationError: string | null;
  /**
   * canonical 语义字段的版本号：name / description / tags / emotion 任一变化
   * 时 +1（自动识别与手动编辑同规则）。向量索引据此判定 stale。
   */
  semanticRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StickerGroup {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 发送时复制的业务快照。它不引用 Sticker 外键，因此删除收藏项不会改写历史消息。
 * mediaAssetId 仍保留，供消息展示层按既有 MediaAsset resolver 解析当前 backing。
 */
export interface StickerMessageSnapshot {
  stickerId: string;
  mediaAssetId: string;
  name: string;
  description: string | null;
  tags: string[];
  emotion: string | null;
  sourceFileName: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  isAnimated: boolean;
}

export type StickerListMode = 'all' | 'favorites' | 'recent';

export interface ListStickersInput {
  mode?: StickerListMode;
  groupId?: string | null;
  limit?: number;
}

export interface SearchStickersInput {
  /** 由工具执行上下文注入，只查询用户与当前 AI 的收藏。 */
  assistantId?: string;
  query?: string;
  tags?: readonly string[];
  emotion?: string | null;
  groupId?: string | null;
  limit?: number;
  /** AI 选择必须只消费已经完成结构化标注的 Sticker。 */
  readyOnly?: boolean;
  /** 维护搜索同时返回自己的识别失败项；其他收藏仍服从 readyOnly。 */
  includeOwnUnannotated?: boolean;
}

export interface StickerMetadataPatch {
  name?: string;
  description?: string | null;
  tags?: readonly string[];
  emotion?: string | null;
}

export interface StickerAnnotationMetadata {
  name?: string;
  description?: string | null;
  tags?: readonly string[];
  emotion?: string | null;
}

/** AI worker claim 的持久化租约身份；完成/失败必须携带同一个 claimId。 */
export interface StickerAnnotationClaim {
  manual: boolean;
  sticker: Sticker;
  claimId: string;
  claimedAt: string;
}

/**
 * 收藏库总量硬上限。这是 stickers 表的集合容量不变量，不是列表分页大小：
 * STICKER_LIST_LIMIT 只约束 UI / 普通查询一次返回多少行，两者语义不同、
 * 不能互相替代。达到上限后拒绝新的非重复导入，复用既有 Sticker 不受影响。
 */
export const STICKER_LIBRARY_MAX_COUNT = 500;

export const STICKER_LIST_LIMIT = 200;
export const STICKER_RECENT_LIMIT = 30;
export const STICKER_GROUP_LIMIT = 100;
export const STICKER_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const STICKER_MAX_DIMENSION_PX = 2048;

export class StickerNotFoundError extends Error {
  constructor(stickerId: string) {
    super(`找不到 Sticker：${stickerId}`);
    this.name = 'StickerNotFoundError';
  }
}

export class StickerGroupNotFoundError extends Error {
  constructor(groupId: string) {
    super(`找不到 Sticker 分组：${groupId}`);
    this.name = 'StickerGroupNotFoundError';
  }
}

export class StickerLibraryFullError extends Error {
  constructor(maxCount: number) {
    super(`表情包收藏库最多只能保存 ${maxCount} 张，请先删除部分表情后再导入`);
    this.name = 'StickerLibraryFullError';
  }
}

export class StickerAnnotationClaimLostError extends Error {
  constructor(stickerId: string) {
    super(`Sticker 标注 claim 已失效：${stickerId}`);
    this.name = 'StickerAnnotationClaimLostError';
  }
}

/** 统一整理用户/模型产生的标签，避免同一条业务事实在不同命令中出现多种形状。 */
export function normalizeStickerTags(tags: readonly string[] | null | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of tags ?? []) {
    const tag = value.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

export function normalizeStickerName(name: string | null | undefined): string {
  const normalized = name?.trim() ?? '';
  if (!normalized) {
    throw new Error('Sticker 名称不能为空');
  }
  return normalized;
}

export function normalizeStickerOptionalText(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

/** 文件名没有可读主体时提供稳定的人工编辑起点。 */
export function deriveStickerName(fileName: string | null | undefined): string {
  const normalized = fileName?.trim() ?? '';
  const withoutPath = normalized.split(/[\\/]/).pop() ?? normalized;
  const withoutExtension = withoutPath.replace(/\.[^.]+$/, '').trim();
  return withoutExtension || '未命名表情';
}

export function inferAnimatedSticker(
  mimeType: string,
  explicitValue?: boolean,
): boolean {
  if (explicitValue !== undefined) return explicitValue;
  const normalizedMimeType = mimeType.trim().toLowerCase();
  return normalizedMimeType === 'image/gif' || normalizedMimeType === 'image/apng';
}

export function parseStickerTags(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Sticker tags_json 不是合法 JSON', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== 'string')) {
    throw new Error('Sticker tags_json 必须是字符串数组');
  }
  return normalizeStickerTags(parsed);
}
