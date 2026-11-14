/**
 * 朋友圈创建命令。
 *
 * author identity 由 trusted 调用方决定：用户 UI 只能以当前 user identity 发布，
 * AI 只能以自己的 ToolContext agentId 发布；模型不能自行传入任意 authorId。
 * selected / all_except audience 在这一层做结构化校验（格式、重复、AI 是否存在），
 * 关系行与 Moment 行的原子提交由 Repository 事务保证。
 */

import { getCurrentUserProfile, SELF_USER_PROFILE_ID } from '@features/profile';
import { MediaAssetMissingError, MediaAssetNotFoundError, resolveMediaAsset } from '@features/media';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type {
  CreateMomentInput as RepositoryCreateMomentInput,
  IMomentRepository,
  Moment,
  MomentAudience,
} from '../domain/MomentRepository';
import { MomentDomainError } from '../domain/MomentErrors';
import { normalizeMomentLocationLabel } from '../domain/MomentLocation';
import { createMomentId, createMomentMediaId } from './MomentIds';
import { startNewMomentMediaAnalysis } from './MomentMediaAnalysis';

export const MAX_MOMENT_MEDIA_COUNT = 9;

/** 校验 audience 所需要的 AI 目录；由调用方注入，命令本身不依赖具体仓储实现。 */
export interface MomentAudienceDirectory {
  listAgentIds(): Promise<readonly string[]>;
}

export interface CreateUserMomentInput {
  content: string;
  /** 可选显示地点；空/undefined 归一化为「没有地点」。 */
  locationLabel?: string | null;
  /** 默认对全部 AI 可见。 */
  audience?: MomentAudience;
  abortSignal?: AbortSignal;
}

/**
 * AI 发布入口的输入。
 *
 * 第一版 AI 没有地点入口：生产 `aiCreateMoment` 的 Tool schema 不暴露 `locationLabel`，
 * 因此这里也没有该字段——Domain 不写死「AI 永远不能有地点」，只是当前没有这个入口。
 */
export interface CreateAgentMomentInput {
  /** AI 的不可变 agentId，必须来自 trusted runtime context。 */
  agentId: string;
  nameSnapshot: string;
  content: string;
  /** 按展示顺序引用已有图片资产，不接受路径或 URL。 */
  mediaAssetIds?: readonly string[];
  audience?: MomentAudience;
  abortSignal?: AbortSignal;
}

interface CreateMomentAuthorInput {
  authorType: Moment['authorType'];
  authorId: string;
  authorNameSnapshot: string;
  content: string;
  locationLabel?: string | null;
  audience?: MomentAudience;
  abortSignal?: AbortSignal;
}

/** 用户发布入口：作者固定为当前用户资料身份，不接受调用方指定 authorId。 */
export async function createUserMoment(
  repository: IMomentRepository,
  directory: MomentAudienceDirectory,
  input: CreateUserMomentInput
): Promise<Moment> {
  const prepared = await prepareUserMoment(directory, input);
  return repository.createMoment(prepared);
}

/** 带媒体发布复用的 trusted 用户 Moment 输入准备；不执行任何持久化。 */
export async function prepareUserMoment(
  directory: MomentAudienceDirectory,
  input: CreateUserMomentInput
): Promise<RepositoryCreateMomentInput> {
  const profile = await getCurrentUserProfile();
  return prepareMoment(directory, {
    authorType: 'user',
    authorId: SELF_USER_PROFILE_ID,
    authorNameSnapshot: profile.name,
    content: input.content,
    locationLabel: input.locationLabel,
    audience: input.audience,
    abortSignal: input.abortSignal,
  });
}

/** AI 发布入口：作者固定为调用方声明的 agentId（trusted runtime 注入）。 */
export async function createAgentMoment(
  repository: IMomentRepository,
  directory: MomentAudienceDirectory,
  input: CreateAgentMomentInput
): Promise<Moment> {
  const agentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
  if (!agentId) {
    throw new MomentDomainError('malformed_audience_agent_id', 'AI 作者缺少不可变 agentId');
  }
  const prepared = await prepareMoment(directory, {
    authorType: 'ai',
    authorId: agentId,
    authorNameSnapshot: input.nameSnapshot,
    content: input.content,
    audience: input.audience,
    abortSignal: input.abortSignal,
  });
  const normalizedIds = await validateMomentMediaAssetIds(input.mediaAssetIds ?? []);
  throwIfAbortSignalAborted(input.abortSignal);
  // 仅新增业务引用；现有事务与外键保证图片、正文、audience 和 Inbox 一起成立或回滚。
  const moment = await repository.createMoment({
    ...prepared,
    media: normalizedIds.map((mediaAssetId, sortOrder) => ({
      id: createMomentMediaId(), mediaAssetId, sortOrder,
    })),
  });
  if (normalizedIds.length > 0) startNewMomentMediaAnalysis(moment.id);
  return moment;
}

/** 模型传入的资产 ID 在媒体边界校验一次，发布与编辑共用。 */
export async function validateMomentMediaAssetIds(mediaAssetIds: readonly string[]): Promise<string[]> {
  if (mediaAssetIds.length > MAX_MOMENT_MEDIA_COUNT) {
    throw new MomentDomainError('too_many_media', `时刻最多附带 ${MAX_MOMENT_MEDIA_COUNT} 张图片`);
  }
  const normalizedIds = mediaAssetIds.map((id) => id.trim());
  if (normalizedIds.some((id) => !id) || new Set(normalizedIds).size !== normalizedIds.length) {
    throw new MomentDomainError('invalid_media', '图片媒体 ID 不能为空或重复');
  }
  for (const id of normalizedIds) {
    try {
      const { asset } = await resolveMediaAsset(id);
      if (!asset.mimeType.startsWith('image/')) {
        throw new MomentDomainError('invalid_media', `媒体 ${id} 不是图片`);
      }
    } catch (error) {
      if (error instanceof MediaAssetNotFoundError || error instanceof MediaAssetMissingError) {
        throw new MomentDomainError('invalid_media', `图片 ${id} 不存在或文件已不可用，请使用有效的图片媒体 ID`);
      }
      throw error;
    }
  }
  return normalizedIds;
}

async function prepareMoment(
  directory: MomentAudienceDirectory,
  input: CreateMomentAuthorInput
): Promise<RepositoryCreateMomentInput> {
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) {
    throw new MomentDomainError('empty_content', '时刻正文不能为空');
  }
  const locationLabel = normalizeMomentLocationLabel(input.locationLabel);

  // 同一份目录快照同时承担 audience 校验与发布投递 fanout，避免两个瞬间的 AI 集合不一致。
  const currentAgentIds = [...await directory.listAgentIds()];
  const audience = normalizeAudience(currentAgentIds, input.audience);
  const deliveryRecipientAgentIds = currentAgentIds.filter((agentId) => {
    if (input.authorType === 'ai' && agentId === input.authorId) return false;
    if (audience.mode === 'all') return true;
    const listed = audience.viewerAgentIds.includes(agentId);
    return audience.mode === 'selected' ? listed : !listed;
  });
  throwIfAbortSignalAborted(input.abortSignal);
  return {
    id: createMomentId(),
    authorType: input.authorType,
    authorId: input.authorId,
    authorNameSnapshot: input.authorNameSnapshot,
    content,
    locationLabel,
    audience,
    deliveryRecipientAgentIds,
  };
}

export function normalizeAudience(
  currentAgentIds: readonly string[],
  audience?: MomentAudience
): MomentAudience {
  if (!audience || audience.mode === 'all') {
    // all 不写关系行：audience_mode='all' 时 moment_audience_ai 必须为空。
    return { mode: 'all' };
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of audience.viewerAgentIds) {
    const agentId = typeof raw === 'string' ? raw.trim() : '';
    if (!agentId) {
      throw new MomentDomainError(
        'malformed_audience_agent_id',
        '可见范围包含空的 AI 身份',
        String(raw)
      );
    }
    if (seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    normalized.push(agentId);
  }

  if (normalized.length === 0 && audience.mode === 'selected') {
    throw new MomentDomainError('empty_audience', '指定可见范围时至少需要一个 AI');
  }

  if (normalized.length === 0) {
    // 空 deny list 与 all 语义相同，统一只保存 canonical 的 all。
    return { mode: 'all' };
  }

  const knownAgentIds = new Set(currentAgentIds);
  for (const agentId of normalized) {
    if (!knownAgentIds.has(agentId)) {
      throw new MomentDomainError(
        'unknown_audience_agent_id',
        '可见范围包含不存在的 AI',
        agentId
      );
    }
  }

  return { mode: audience.mode, viewerAgentIds: normalized };
}
