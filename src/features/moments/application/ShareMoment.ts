/** 用户可以主动传递快照；AI 只能分享自己可见的原帖。准备快照不消费社交未读。 */
import type { IMomentRepository } from '../domain/MomentRepository';
import type { MomentShareSnapshot } from '../domain/MomentShareSnapshot';
import { MomentDomainError } from '../domain/MomentErrors';
import { loadMomentActorDirectory } from './MomentActorResolver';

export async function createMomentShareSnapshot(repository: IMomentRepository, momentId: string, viewerAgentId?: string): Promise<MomentShareSnapshot> {
  const snapshot = viewerAgentId === undefined
    ? await repository.getMomentDetailForUser(momentId)
    : await repository.captureMomentDetailForAgent(viewerAgentId, momentId).then(detail => detail ? { ...detail.moment, media: detail.media } : null);
  if (!snapshot) throw new MomentDomainError('moment_not_visible', '该时刻不存在或对你不可见', momentId);
  const directory = await loadMomentActorDirectory(undefined, 'user');
  const actor = directory.resolve({ actorType: snapshot.authorType, actorId: snapshot.authorId, nameSnapshot: snapshot.authorNameSnapshot });
  return {
    schemaVersion: 1, momentId: snapshot.id,
    author: { actorType: actor.actorType, actorId: actor.actorId, name: actor.publicName, displayName: actor.displayName,
      avatar: actor.avatarMediaAssetId ? { mediaAssetId: actor.avatarMediaAssetId } : null },
    content: snapshot.content, locationLabel: snapshot.locationLabel, createdAt: snapshot.createdAt,
    images: snapshot.media.map(image => ({ mediaAssetId: image.mediaAssetId,
      analysisText: image.analysisStatus === 'completed' ? image.analysisText : null })),
  };
}
