/** 构造真正交给模型的完整社交视图；读取成功后只消费快照中的未读 cutoff。 */
import type { IMomentRepository, MomentComment } from '../domain/MomentRepository';
import { MomentDomainError } from '../domain/MomentErrors';
import { loadMomentActorDirectory } from './MomentActorResolver';

export async function readMomentDetail(
  repository: IMomentRepository,
  viewerAgentId: string,
  momentId: string,
) {
  const snapshot = await repository.captureMomentDetailForAgent(viewerAgentId, momentId);
  if (!snapshot) throw new MomentDomainError('moment_not_visible', '该时刻不存在或对你不可见', momentId);
  const { moment, media, comments, likes, unreadCutoffSeq } = snapshot;
  const directory = await loadMomentActorDirectory();
  const displayNameOf = (actorType: MomentComment['authorType'], actorId: string, nameSnapshot: string) => (
    directory.resolve({ actorType, actorId, nameSnapshot }).displayName
  );
  const commentById = new Map(comments.map((comment) => [comment.id, comment]));
  const commentsWithIdentity = comments.map((comment) => {
    const parent = comment.parentCommentId ? commentById.get(comment.parentCommentId) : undefined;
    return {
      ...comment,
      displayName: displayNameOf(comment.authorType, comment.authorId, comment.authorNameSnapshot),
      parentDisplayName: parent ? displayNameOf(parent.authorType, parent.authorId, parent.authorNameSnapshot) : null,
      isSelf: comment.authorType === 'ai' && comment.authorId === viewerAgentId,
    };
  });
  const ownCommentIds = commentsWithIdentity.filter((comment) => comment.isSelf).map((comment) => comment.id);
  const isLikedBySelf = likes.some((like) => like.actorType === 'ai' && like.actorId === viewerAgentId);
  const lines = [
    '时刻详情:',
    `momentId: ${moment.id}`,
    `发布者: ${displayNameOf(moment.authorType, moment.authorId, moment.authorNameSnapshot)}`,
    `authorType: ${moment.authorType}，authorId: ${moment.authorId}`,
    `发布时间: ${new Date(moment.createdAt).toLocaleString('zh-CN')}`,
    `编辑状态: ${moment.editedAt ? `已编辑，最后编辑时间: ${new Date(moment.editedAt).toLocaleString('zh-CN')}` : '未编辑'}`,
    `内容: ${moment.content}`,
  ];
  if (moment.locationLabel) lines.push(`地点: ${moment.locationLabel}`);
  if (media.length) {
    lines.push('', '图片：');
    media.forEach((item, index) => {
      if (item.analysisStatus === 'completed' && item.analysisText) {
        lines.push(`${index + 1}. [${item.analysisSource === 'user' ? '用户编辑' : '模型识别'}] ${item.analysisText}`);
      } else {
        lines.push(`${index + 1}. [${item.analysisStatus === 'pending' ? '识别中' : '识别失败'}] 当前没有可靠图片语义，不得根据文件名、旧记忆或猜测补全图片内容。`);
      }
    });
  }
  lines.push('', `你是否已点赞: ${isLikedBySelf ? '是' : '否'}`);
  lines.push(`点赞 (${likes.length}人): ${likes.map((like) => displayNameOf(like.actorType, like.actorId, like.actorNameSnapshot)).join('、') || '暂无'}`);
  lines.push('', `评论 (${comments.length}条，完整评论区):`);
  for (const comment of commentsWithIdentity) {
    const reply = comment.parentDisplayName ? ` 回复 ${comment.parentDisplayName}` : '';
    lines.push(`${comment.displayName}${reply}${comment.isSelf ? ' [你发的，可删除]' : ''}（commentId: ${comment.id}，parentCommentId: ${comment.parentCommentId ?? 'null'}，authorId: ${comment.authorId}）: ${comment.content}`);
  }
  if (!comments.length) lines.push('暂无评论');
  lines.push('', `你自己的评论 ID: ${JSON.stringify(ownCommentIds)}`);
  lines.push('回复或删除评论时使用上述 commentId；用户不需要提供内部 ID。若有多条候选无法判断，询问具体内容或对象，不要索要 ID。');
  lines.push('本次读取会将这条时刻已有的未读社交事件标为已读；已读不等于已回复。以后仍可用此 momentId 重新读取，或用 searchMoments 搜索正文、作者及评论找回。');
  const detail = {
    message: lines.join('\n'),
    data: {
      moment,
      media: media.map((item) => ({
        id: item.id, mediaAssetId: item.mediaAssetId, sortOrder: item.sortOrder, analysisStatus: item.analysisStatus,
        analysisText: item.analysisText, analysisSource: item.analysisSource, analyzedAt: item.analyzedAt,
      })),
      likes,
      comments: commentsWithIdentity,
      ownCommentIds,
      isLikedBySelf,
    },
  };
  if (unreadCutoffSeq !== null) {
    await repository.markMomentSocialDeliveriesReadThrough(viewerAgentId, momentId, unreadCutoffSeq);
  }
  return detail;
}
