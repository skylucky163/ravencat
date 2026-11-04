/**
 * Sticker 的 Agent-native 工具：只读取可供模型理解的结构化资料，或返回发送意图。
 *
 * 工具本身不拥有 Chat 消息生命周期。选择结果由 Chat canonical timeline 交给
 * 回合提交 owner；普通发送在工具完成后提交，重写随 T3 原子替换。
 */

import { COMPLETION_INTENT_PARAMETER } from '@shared/aiTools';
import type {
  AgentToolExecutionContext,
  AgentToolExecutionResult,
} from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { mediaImageFailure } from '@features/media';
import { getStickersRuntimeDependencies } from '../application/StickerRuntime';
import { getStickerVectorState, getStickerVectorStates } from '../application/AIStickerCommands';
import {
  getStickerById,
  listStickerGroupsForAI,
  listStickersInGroupForAI,
} from '../application/StickerQueries';
import {
  searchStickersForAI,
  STICKER_AI_SEARCH_DEFAULT_LIMIT,
  STICKER_AI_SEARCH_MAX_LIMIT,
} from '../application/StickerSearch';
import {
  decodeStickerGroupPageCursor,
  encodeStickerGroupPageCursor,
} from '../domain/StickerSearch';
import type {
  SearchStickersInput,
  Sticker,
  StickerMessageSnapshot,
} from '../domain/Sticker';
import { StickerNotFoundError } from '../domain/Sticker';

/** Agent outcome 的稳定 discriminator；Chat 只接受这一版本的发送意图。 */
export const STICKER_SEND_INTENT_DISCRIMINATOR = 'ravencat.sticker.send.v1' as const;

/** 搜索结果也带版本 discriminator，避免模型把其他结构误当成 Sticker 条目。 */
export const STICKER_SEARCH_RESULT_DISCRIMINATOR = 'ravencat.sticker.search.v1' as const;

export interface StickerAISearchSnapshot {
  stickerId: string;
  mediaAssetId: string;
  ownedBySelf: boolean;
  annotationStatus: Sticker['annotationStatus'];
  annotationError: string | null;
  vector: Awaited<ReturnType<typeof getStickerVectorState>>;
  name: string;
  description: string | null;
  tags: string[];
  emotion: string | null;
}

export interface StickerSearchResultData {
  discriminator: typeof STICKER_SEARCH_RESULT_DISCRIMINATOR;
  stickers: StickerAISearchSnapshot[];
}

export interface StickerAIGroupSnapshot {
  groupId: string;
  name: string;
  stickerCount: number;
}

export interface StickerAIGroupItemSnapshot {
  stickerId: string;
  mediaAssetId: string;
  vector: Awaited<ReturnType<typeof getStickerVectorState>>;
  name: string;
  tags: string[];
  emotion: string | null;
}

export interface StickerGroupListResultData {
  discriminator: typeof STICKER_SEARCH_RESULT_DISCRIMINATOR;
  groups: StickerAIGroupSnapshot[];
}

export interface StickerGroupPageResultData {
  discriminator: typeof STICKER_SEARCH_RESULT_DISCRIMINATOR;
  stickers: StickerAIGroupItemSnapshot[];
  /** 还有更多内容时提供，供下一次 list_stickers_in_group 传回。 */
  nextCursor: string | null;
}

export interface StickerSendIntent {
  discriminator: typeof STICKER_SEND_INTENT_DISCRIMINATOR;
  sticker: StickerMessageSnapshot;
}

export interface SearchStickersArgs {
  query?: string;
  tags?: string[];
  emotion?: string;
  group_id?: string;
  limit?: number;
}

export interface SelectStickerArgs {
  sticker_id: string;
  on_success: 'finish' | 'continue';
}

export interface ListStickersInGroupArgs {
  group_id: string;
  cursor?: string;
  limit?: number;
}

export const searchStickersDefinition = {
  name: 'search_stickers',
  description: [
    '用自然语言搜索当前 Sticker 库，支持描述使用场景或情绪（例如“被发现做坏事以后装无辜”），不要求关键词精确命中名称或标签。',
    '先用本工具搜索；结果不合适或要按分组浏览时，再用 list_sticker_groups / list_stickers_in_group。',
    '返回用户可发送的表情与自己的收藏，自己的识别失败项也可按名称查到并修正。缺向量仍可按词面检索及发送；只有自己的收藏可以维护。mediaAssetId 可供 view_image 查看，stickerId 供 select_sticker 或 maintain_own_sticker 使用。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '描述想表达的内容、场景或情绪的自然语言，也可以是名称 / 标签关键词',
        maxLength: 120,
      },
      tags: {
        type: 'array',
        description: '可选，要求同时包含的标签',
        items: { type: 'string', maxLength: 40 },
        maxItems: 8,
      },
      emotion: {
        type: 'string',
        description: '可选，精确匹配情绪/语义，例如开心、无语、安慰',
        maxLength: 40,
      },
      group_id: {
        type: 'string',
        description: '可选，只搜索指定 Sticker 分组',
        maxLength: 120,
      },
      limit: {
        type: 'integer',
        description: `返回数量，默认 ${STICKER_AI_SEARCH_DEFAULT_LIMIT}，最多 ${STICKER_AI_SEARCH_MAX_LIMIT}`,
        minimum: 1,
        maximum: STICKER_AI_SEARCH_MAX_LIMIT,
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

export const listStickerGroupsDefinition = {
  name: 'list_sticker_groups',
  description: [
    '浏览当前 Sticker 库的分组列表及每个分组的可用表情包数量。',
    '找到目标后用 select_sticker 发送。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
} as const;

export const listStickersInGroupDefinition = {
  name: 'list_stickers_in_group',
  description: [
    '按分组浏览表情包列表；结果较多时使用返回的 cursor 继续翻页。',
    '找到目标后用 select_sticker 发送。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      group_id: {
        type: 'string',
        description: '来自 list_sticker_groups 的 groupId',
        minLength: 1,
        maxLength: 120,
      },
      cursor: {
        type: 'string',
        description: '可选，上一次返回的 nextCursor',
        maxLength: 512,
      },
      limit: {
        type: 'integer',
        description: '单页数量，默认 30，最多 50',
        minimum: 1,
        maximum: 50,
      },
    },
    required: ['group_id'],
    additionalProperties: false,
  },
} as const;

export const selectStickerDefinition = {
  name: 'select_sticker',
  description: [
    '选择一张 Sticker 作为本轮 assistant 回复的一部分；stickerId 可以来自 search_stickers 或 list_stickers_in_group 的结果。',
    '表情包本身可以构成完整回复。失败会返回错误供你处理。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      sticker_id: {
        type: 'string',
        description: '来自 search_stickers 或 list_stickers_in_group 结果的 stickerId',
        minLength: 1,
        maxLength: 120,
      },
      on_success: COMPLETION_INTENT_PARAMETER,
    },
    required: ['sticker_id', 'on_success'],
    additionalProperties: false,
  },
} as const;

export async function searchStickers(
  args: SearchStickersArgs,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult<StickerSearchResultData>> {
  throwIfAbortSignalAborted(context.abortSignal);
  const input: SearchStickersInput = {
    assistantId: context.task.assistantId,
    query: args.query?.trim() || undefined,
    tags: args.tags,
    emotion: args.emotion?.trim() || undefined,
    groupId: args.group_id?.trim() || undefined,
    limit: args.limit ?? STICKER_AI_SEARCH_DEFAULT_LIMIT,
  };
  const stickers = await searchStickersForAI(input, { signal: context.abortSignal });
  throwIfAbortSignalAborted(context.abortSignal);
  const vectors = await getStickerVectorStates(stickers);

  const data: StickerSearchResultData = {
    discriminator: STICKER_SEARCH_RESULT_DISCRIMINATOR,
    stickers: stickers.map((sticker, index) => toAISearchSnapshot(sticker, context.task.assistantId, vectors[index])),
  };
  return {
    status: 'success',
    data,
    modelContent: data.stickers.length > 0
      ? JSON.stringify(data)
      : '没有找到匹配的用户可用表情或自己的收藏。',
  };
}

export async function selectSticker(
  args: SelectStickerArgs,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult<StickerSendIntent>> {
  throwIfAbortSignalAborted(context.abortSignal);
  let sticker: Sticker;
  try {
    sticker = await getStickerById(args.sticker_id, context.task.assistantId);
  } catch (error) {
    if (!(error instanceof StickerNotFoundError)) {
      throw error;
    }
    return {
      status: 'error',
      code: 'STICKER_NOT_FOUND',
      retryable: true,
      modelContent: '指定的 Sticker 不存在，请先搜索当前可用 Sticker 后再选择。',
    };
  }
  throwIfAbortSignalAborted(context.abortSignal);

  if (sticker.annotationStatus !== 'ready') {
    return {
      status: 'error',
      code: 'STICKER_NOT_READY',
      retryable: true,
      modelContent: '指定的 Sticker 尚未完成结构化标注，当前不能发送；自己的收藏可调用 maintain_own_sticker 修正语义或显式重新识别，也可改选其他表情。',
    };
  }

  try {
    await getStickersRuntimeDependencies().media.resolveMediaAsset(sticker.mediaAssetId);
  } catch (error) {
    const failure = mediaImageFailure(error);
    if (failure) return failure;
    throw error;
  }
  const vector = await getStickerVectorState(sticker);

  const intent: StickerSendIntent = {
    discriminator: STICKER_SEND_INTENT_DISCRIMINATOR,
    sticker: toMessageSnapshot(sticker),
  };
  return {
    status: 'success',
    data: intent,
    metadata: { fulfillsUserVisibleOutput: true, completionIntent: args.on_success },
    modelContent: JSON.stringify({
      discriminator: intent.discriminator,
      sticker: {
        stickerId: intent.sticker.stickerId,
        name: intent.sticker.name,
        emotion: intent.sticker.emotion,
        mediaAssetId: intent.sticker.mediaAssetId,
        vector,
      },
    }),
  };
}

export const SearchStickersTool = {
  name: searchStickersDefinition.name,
  definition: searchStickersDefinition,
  execute: searchStickers,
};

/** 分组浏览只统计 ready Sticker；分组是显式过滤维度，不是搜索的替代品。 */
export async function listStickerGroups(
  _args: Record<string, never>,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult<StickerGroupListResultData>> {
  throwIfAbortSignalAborted(context.abortSignal);
  const groups = await listStickerGroupsForAI();
  const data: StickerGroupListResultData = {
    discriminator: STICKER_SEARCH_RESULT_DISCRIMINATOR,
    groups: groups.map((group) => ({
      groupId: group.groupId,
      name: group.name,
      stickerCount: group.stickerCount,
    })),
  };
  return {
    status: 'success',
    data,
    modelContent: data.groups.length > 0
      ? JSON.stringify(data)
      : '当前收藏库还没有包含可用表情包的分组。',
  };
}

/** 分页默认 30、最大 50；cursor 无效时按第一页处理，保证翻页稳定可恢复。 */
export async function listStickersInGroup(
  args: ListStickersInGroupArgs,
  context: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult<StickerGroupPageResultData>> {
  throwIfAbortSignalAborted(context.abortSignal);
  const limit = args.limit === undefined
    ? 30
    : Math.max(1, Math.min(50, Math.floor(args.limit)));
  const cursor = args.cursor ? decodeStickerGroupPageCursor(args.cursor) : null;
  const page = await listStickersInGroupForAI(args.group_id, cursor, limit);
  throwIfAbortSignalAborted(context.abortSignal);
  const vectors = await getStickerVectorStates(page.stickers);

  const data: StickerGroupPageResultData = {
    discriminator: STICKER_SEARCH_RESULT_DISCRIMINATOR,
    stickers: page.stickers.map((sticker, index) => ({
      stickerId: sticker.id,
      mediaAssetId: sticker.mediaAssetId,
      vector: vectors[index],
      name: sticker.name,
      tags: [...sticker.tags],
      emotion: sticker.emotion,
    })),
    nextCursor: page.nextCursor
      ? encodeStickerGroupPageCursor(page.nextCursor)
      : null,
  };
  return {
    status: 'success',
    data,
    modelContent: data.stickers.length > 0
      ? JSON.stringify(data)
      : '该分组下暂无可发送的 Sticker。',
  };
}

export const ListStickerGroupsTool = {
  name: listStickerGroupsDefinition.name,
  definition: listStickerGroupsDefinition,
  execute: listStickerGroups,
};

export const ListStickersInGroupTool = {
  name: listStickersInGroupDefinition.name,
  definition: listStickersInGroupDefinition,
  execute: listStickersInGroup,
};

export const SelectStickerTool = {
  name: selectStickerDefinition.name,
  definition: selectStickerDefinition,
  execute: selectSticker,
};

export function isStickerSendIntent(value: unknown): value is StickerSendIntent {
  if (!isRecord(value) || value.discriminator !== STICKER_SEND_INTENT_DISCRIMINATOR) {
    return false;
  }
  return isRecord(value.sticker)
    && typeof value.sticker.stickerId === 'string'
    && typeof value.sticker.mediaAssetId === 'string'
    && typeof value.sticker.name === 'string';
}

function toAISearchSnapshot(sticker: Sticker, assistantId: string, vector: StickerAISearchSnapshot['vector']): StickerAISearchSnapshot {
  return {
    stickerId: sticker.id,
    mediaAssetId: sticker.mediaAssetId,
    ownedBySelf: sticker.ownerAssistantId === assistantId,
    annotationStatus: sticker.annotationStatus,
    annotationError: sticker.annotationError,
    vector,
    name: sticker.name,
    description: sticker.description,
    tags: [...sticker.tags],
    emotion: sticker.emotion,
  };
}

function toMessageSnapshot(sticker: Sticker): StickerMessageSnapshot {
  return {
    stickerId: sticker.id,
    mediaAssetId: sticker.mediaAssetId,
    name: sticker.name,
    description: sticker.description,
    tags: [...sticker.tags],
    emotion: sticker.emotion,
    sourceFileName: sticker.sourceFileName,
    mimeType: sticker.mimeType,
    width: sticker.width,
    height: sticker.height,
    isAnimated: sticker.isAnimated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
