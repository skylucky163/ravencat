/** 朋友圈界面使用的查询与写入门面。 */
import { getAssistantDisplayName, listAIAssistants } from '@features/assistants';
import {
  getCurrentUserProfile,
  type UserProfile,
} from '@features/profile';
import type {
  MomentActorType,
  MomentAudience,
  MomentAudienceMode,
  MomentPageRequest,
  MomentMediaAnalysisSource,
  MomentMediaAnalysisStatus,
} from './domain/MomentRepository';
import { momentRepository } from './infrastructure/SQLiteMomentRepository';
import { loadMomentActorDirectory } from './application/MomentActorResolver';
import { createUserMoment as createUserMomentCommand } from './application/CreateMoment';
import {
  createUserMomentWithMedia,
  type MomentMediaDraft,
} from './application/CreateUserMomentWithMedia';
import {
  editMomentMediaAnalysis,
  reanalyzeMomentMedia,
} from './application/MomentMediaAnalysis';
import {
  commentMomentAsUser,
  deleteMomentCommentAsUser,
  deleteOwnMomentAsUser,
  likeMomentAsUser,
  unlikeMomentAsUser,
} from './application/UserMomentCommands';
import type { MomentAudienceCandidate } from './presentation/MomentAudienceDraft';
import { createMomentShareSnapshot } from './application/ShareMoment';

export function createUserMomentShare(momentId: string) {
  return createMomentShareSnapshot(momentRepository, momentId);
}

export function createAgentMomentShare(momentId: string, agentId: string) {
  return createMomentShareSnapshot(momentRepository, momentId, agentId);
}

/** 读模型中的 actor：稳定身份 + 解析出的当前展示身份。 */
export interface MomentRecordActor {
  /** 稳定 actor 身份：user 是本机用户，ai 是不可变 agentId。 */
  actorType: MomentActorType;
  actorId: string;
  /** 当前展示名称；作者已删除时退回历史名称快照。 */
  userName: string;
  avatar: string | null;
}

export interface MomentRecordComment extends MomentRecordActor {
  id: string;
  parentCommentId: string | null;
  content: string;
  createdAt: string;
}

export type MomentRecordLike = MomentRecordActor;

export interface MomentRecordMedia {
  id: string;
  mediaAssetId: string;
  sortOrder: number;
  analysisStatus: MomentMediaAnalysisStatus;
  analysisText: string | null;
  analysisSource: MomentMediaAnalysisSource | null;
  analysisModelConfigId: string | null;
  analyzedAt: string | null;
  analysisErrorCode: string | null;
  analysisErrorMessage: string | null;
}

export interface MomentRecord extends MomentRecordActor {
  id: string;
  assistantId: string | null;
  content: string;
  /** 用户手填的显示地点；没有地点时是 null，UI 不占空间也不制造伪位置。 */
  locationLabel: string | null;
  createdAt: string;
  /** AI audience；用户 UI 只用来显示轻量可见范围提示，不提供编辑入口。 */
  audienceMode: MomentAudienceMode;
  media: MomentRecordMedia[];
  comments: MomentRecordComment[];
  likes: MomentRecordLike[];
}

export async function getCurrentMomentUserProfile(): Promise<UserProfile> {
  return getCurrentUserProfile();
}

/** 用户读模型：用户能看到全部合法 Moment，AI audience 只约束其他 AI。 */
export async function listMomentRecords(
  profile?: UserProfile | null,
  options?: MomentPageRequest
): Promise<MomentRecord[]> {
  const [moments, directory] = await Promise.all([
    momentRepository.listMomentTimelineForUser(options),
    loadMomentActorDirectory(profile, 'user'),
  ]);

  return projectMomentRecords(moments, directory);
}

export async function getMomentRecord(momentId: string): Promise<MomentRecord | null> {
  const [moment, directory] = await Promise.all([momentRepository.getMomentDetailForUser(momentId), loadMomentActorDirectory(undefined, 'user')]);
  return moment ? projectMomentRecords([moment], directory)[0] : null;
}

function projectMomentRecords(moments: import('./domain/MomentRepository').MomentTimelineEntry[], directory: import('./application/MomentActorResolver').MomentActorDirectory): MomentRecord[] {
  const records: MomentRecord[] = [];
  for (const moment of moments) {
    const { comments, likes, media } = moment;
    // 时间线只投影持久化事实；文件解析与原生解码由可见图片组件拥有，不能挡住正文。
    const recordMedia: MomentRecordMedia[] = media.map((item) => ({
      id: item.id,
      mediaAssetId: item.mediaAssetId,
      sortOrder: item.sortOrder,
      analysisStatus: item.analysisStatus,
      analysisText: item.analysisText,
      analysisSource: item.analysisSource,
      analysisModelConfigId: item.analysisModelConfigId,
      analyzedAt: item.analyzedAt,
      analysisErrorCode: item.analysisErrorCode,
      analysisErrorMessage: item.analysisErrorMessage,
    }));
    const momentActor = directory.resolve({
      actorType: moment.authorType,
      actorId: moment.authorId,
      nameSnapshot: moment.authorNameSnapshot,
    });

    records.push({
      id: moment.id,
      assistantId: momentActor.assistantId,
      actorType: momentActor.actorType,
      actorId: momentActor.actorId,
      userName: momentActor.displayName,
      avatar: momentActor.avatar,
      content: moment.content,
      locationLabel: moment.locationLabel,
      createdAt: moment.createdAt,
      audienceMode: moment.audienceMode,
      media: recordMedia,
      comments: comments.map((comment) => {
        const actor = directory.resolve({
          actorType: comment.authorType,
          actorId: comment.authorId,
          nameSnapshot: comment.authorNameSnapshot,
        });
        return {
          id: comment.id,
          parentCommentId: comment.parentCommentId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          userName: actor.displayName,
          avatar: actor.avatar,
          content: comment.content,
          createdAt: comment.createdAt,
        };
      }),
      likes: likes.map((like) => {
        const actor = directory.resolve({
          actorType: like.actorType,
          actorId: like.actorId,
          nameSnapshot: like.actorNameSnapshot,
        });
        return {
          actorType: actor.actorType,
          actorId: actor.actorId,
          userName: actor.displayName,
          avatar: actor.avatar,
        };
      }),
    });
  }
  return records;
}

/** 用户发布所需的完整 draft；结构化传参避免参数顺序陷阱。 */
export interface CreateUserMomentRecordInput {
  content: string;
  audience?: MomentAudience;
  media?: readonly MomentMediaDraft[];
  locationLabel?: string | null;
}

/** 用户发布：作者固定为当前用户资料身份，可见范围默认对全部 AI。 */
export async function createUserMomentRecord(input: CreateUserMomentRecordInput) {
  const media = input.media ?? [];
  const directory = { listAgentIds: listKnownAudienceAgentIds };
  if (media.length > 0) {
    return createUserMomentWithMedia(directory, {
      content: input.content,
      audience: input.audience,
      locationLabel: input.locationLabel,
      media,
    });
  }
  return createUserMomentCommand(momentRepository, directory, {
    content: input.content,
    audience: input.audience,
    locationLabel: input.locationLabel,
  });
}

export function retryMomentMediaAnalysis(mediaId: string) {
  return reanalyzeMomentMedia(mediaId);
}

export function saveMomentMediaAnalysis(mediaId: string, text: string) {
  return editMomentMediaAnalysis(mediaId, text);
}

/** 用户以本机身份评论或回复；回复目标必须属于该 Moment（由仓储事务校验）。 */
export async function createUserMomentComment(
  momentId: string,
  content: string,
  parentCommentId: string | null = null
) {
  return commentMomentAsUser(momentRepository, momentId, content, parentCommentId);
}

export async function createUserMomentLike(momentId: string) {
  return likeMomentAsUser(momentRepository, momentId);
}

export async function removeUserMomentLike(momentId: string): Promise<boolean> {
  return unlikeMomentAsUser(momentRepository, momentId);
}

export async function removeMomentRecord(momentId: string): Promise<boolean> {
  return deleteOwnMomentAsUser(momentRepository, momentId);
}

export async function removeMomentCommentById(commentId: string): Promise<boolean> {
  return deleteMomentCommentAsUser(momentRepository, commentId);
}

async function listKnownAudienceAgentIds(): Promise<readonly string[]> {
  const candidates = await listMomentAudienceCandidates();
  return candidates.map((candidate) => candidate.agentId);
}

/**
 * 发布页可见范围候选：当前 Assistant 目录的稳定身份 + 当前展示名 / 头像。
 *
 * 身份只取 `agentId`；`displayName` / `avatar` 只用于展示，改名不会漂移 audience。
 * Presentation 不直接访问 assistant 目录，统一从这里拿 DTO。
 */
export async function listMomentAudienceCandidates(): Promise<MomentAudienceCandidate[]> {
  const assistants = await listAIAssistants();
  const seen = new Set<string>();
  const candidates: MomentAudienceCandidate[] = [];
  for (const assistant of assistants) {
    const agentId = typeof assistant.agentId === 'string' ? assistant.agentId.trim() : '';
    if (!agentId || seen.has(agentId)) continue;
    seen.add(agentId);
    candidates.push({
      agentId,
      displayName: getAssistantDisplayName(assistant),
      avatar: assistant.avatar ?? null,
    });
  }
  return candidates;
}
