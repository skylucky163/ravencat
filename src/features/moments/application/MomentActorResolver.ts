/**
 * 集中解析朋友圈 actor 的当前展示身份。
 *
 * 正常展示路径是 `actorType + authorId → 当前 Profile / Assistant → 当前名称与头像`；
 * `authorNameSnapshot` 只在作者已删除（或无法解析）时兜底。任何 UI 组件、读模型
 * 都不要自己按名字猜身份。
 */

import { listAIAssistants, getAssistantDisplayName } from '@features/assistants';
import {
  getCurrentUserProfile,
  SELF_USER_PROFILE_ID,
  type UserProfile,
} from '@features/profile';
import type { MomentActorType } from '../domain/MomentRepository';

export interface ResolvedMomentActor {
  actorType: MomentActorType;
  actorId: string;
  /** 当前 AI 的资料 ID；用户或已删除的 AI 没有主页入口。 */
  assistantId: string | null;
  /** 当前名称；作者已删除时退回写入时快照。 */
  displayName: string;
  /** 模型可见的公开名称，不含用户给 AI 设置的界面备注。 */
  publicName: string;
  /** 当前头像；作者已删除或未设置时为 null。 */
  avatar: string | null;
  avatarMediaAssetId: string | null;
  /** 当前是否仍能解析到 owner；本机用户恒为 true。 */
  exists: boolean;
}

export interface MomentActorRef {
  actorType: MomentActorType;
  actorId: string;
  nameSnapshot: string;
}

export interface MomentActorDirectory {
  actors: readonly ResolvedMomentActor[];
  resolve(ref: MomentActorRef): ResolvedMomentActor;
}

/**
 * 读取一批解析所需的当前身份。
 *
 * @param currentProfile 调用方已经读到的用户资料；省略时自行读取，避免重复读取。
 */
export async function loadMomentActorDirectory(
  currentProfile?: UserProfile | null,
  nameAudience: 'ai' | 'user' = 'ai',
): Promise<MomentActorDirectory> {
  const [profile, assistants] = await Promise.all([
    currentProfile ?? getCurrentUserProfile(),
    listAIAssistants(),
  ]);

  const assistantByAgentId = new Map<string, { id: string; name: string; publicName: string; avatar: string | null; avatarMediaAssetId: string | null }>();
  for (const assistant of assistants) {
    const agentId = typeof assistant.agentId === 'string' ? assistant.agentId.trim() : '';
    if (agentId) {
      assistantByAgentId.set(agentId, {
        id: assistant.id,
        name: nameAudience === 'user' ? getAssistantDisplayName(assistant) : assistant.name,
        publicName: assistant.name,
        avatarMediaAssetId: assistant.avatarMediaAssetId,
        avatar: assistant.avatar ?? null,
      });
    }
  }

  return {
    actors: [
      { actorType: 'user', actorId: SELF_USER_PROFILE_ID, assistantId: null, displayName: profile.name, publicName: profile.name, avatar: profile.avatar ?? null, avatarMediaAssetId: profile.avatarMediaAssetId, exists: true },
      ...assistants.map((assistant): ResolvedMomentActor => ({
        actorType: 'ai', actorId: assistant.agentId, assistantId: assistant.id, displayName: nameAudience === 'user' ? getAssistantDisplayName(assistant) : assistant.name,
        publicName: assistant.name,
        avatarMediaAssetId: assistant.avatarMediaAssetId,
        avatar: assistant.avatar ?? null, exists: true,
      })),
    ],
    resolve(ref: MomentActorRef): ResolvedMomentActor {
      if (ref.actorType === 'user') {
        const isSelf = ref.actorId === SELF_USER_PROFILE_ID;
        return {
          actorType: 'user',
          actorId: ref.actorId,
          assistantId: null,
          displayName: isSelf ? profile.name : ref.nameSnapshot,
          publicName: isSelf ? profile.name : ref.nameSnapshot,
          avatarMediaAssetId: isSelf ? profile.avatarMediaAssetId : null,
          avatar: isSelf ? profile.avatar ?? null : null,
          exists: isSelf,
        };
      }

      const assistant = assistantByAgentId.get(ref.actorId);
      return {
        actorType: 'ai',
        actorId: ref.actorId,
        assistantId: assistant?.id ?? null,
        displayName: assistant?.name || ref.nameSnapshot,
        publicName: assistant?.publicName || ref.nameSnapshot,
        avatarMediaAssetId: assistant?.avatarMediaAssetId ?? null,
        avatar: assistant?.avatar ?? null,
        exists: Boolean(assistant),
      };
    },
  };
}
