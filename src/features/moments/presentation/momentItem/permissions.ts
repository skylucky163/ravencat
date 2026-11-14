/** Moment 条目上的用户操作权限投影；必须与 Application ownership 规则同向。 */

/**
 * 是否存在原帖管理动作（编辑或删除自己的时刻）。
 *
 * 没有动作时不得显示 More 入口：AI-authored Moment 的 More 菜单里只会有「取消」，
 * 那是纯粹的空菜单。评论自己的删除继续通过评论本人提供，不需要 Moment-level 入口。
 */
export function hasMomentLevelUserActions(input: { isOwnMoment: boolean }): boolean {
  return input.isOwnMoment;
}

export function canManageMomentAIComments(
  isOwnMoment: boolean,
  aiCommentsCount: number,
): boolean {
  return isOwnMoment && aiCommentsCount > 0;
}

export function canDeleteMomentCommentFromUserUI(input: {
  isOwnMoment: boolean;
  isOwnComment: boolean;
  commentActorType: 'user' | 'ai';
}): boolean {
  return input.isOwnComment || (input.isOwnMoment && input.commentActorType === 'ai');
}
