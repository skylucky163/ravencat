/**
 * 用户侧 Moments 操作失败的展示文案。
 *
 * 已知 `MomentDomainError` 表达的是"调用方给了不合法业务输入"的结构化原因，本来就是给
 * 用户看的业务说明，可以直接展示；少数几个错误码需要转成用户能操作的提示，而不是暴露
 * 内部标识。
 *
 * 其余错误（SQLite / 文件 IO / 未知异常）统一收敛为一句通用文案：绝不把 SQL、stack、
 * 密钥或文件路径暴露到 UI。
 */

import { MomentDomainError } from '../domain/MomentErrors';

const GENERIC_PUBLISH_FAILURE_MESSAGE = '发布失败，请稍后重试。';
const GENERIC_COMMENT_FAILURE_MESSAGE = '发表失败，请重试。';
const GENERIC_DELETE_FAILURE_MESSAGE = '删除失败，请重试。';
const GENERIC_LIKE_FAILURE_MESSAGE = '点赞失败，请重试。';
const GENERIC_UNLIKE_FAILURE_MESSAGE = '取消点赞失败，请重试。';

/**
 * 少数错误码的用户可操作说法。
 *
 * 这些场景的 domain message 本身是准确的，但带有内部措辞（例如 `agentId`），不适合直接
 * 呈现在 UI 上。
 */
const USER_ACTIONABLE_MESSAGES: Partial<Record<MomentDomainError['code'], string>> = {
  // 候选 AI 在用户勾选之后被删除：必须拒绝发布并让用户重新选择，不能拿改名去猜新身份。
  unknown_audience_agent_id: '可见范围中的 AI 已发生变化，请重新选择。',
  moment_not_found: '这条时刻已不存在。',
  comment_not_found: '这条评论已不存在。',
  comment_moment_mismatch: '该评论已不在这个时刻下，无法回复。',
};

function describe(error: unknown, genericMessage: string): string {
  if (error instanceof MomentDomainError) {
    return USER_ACTIONABLE_MESSAGES[error.code] ?? error.message;
  }
  return genericMessage;
}

export function describeMomentPublishFailure(error: unknown): string {
  return describe(error, GENERIC_PUBLISH_FAILURE_MESSAGE);
}

export function describeMomentEditFailure(error: unknown): string {
  return describe(error, '保存失败，请稍后重试。');
}

export function describeMomentCommentFailure(error: unknown): string {
  return describe(error, GENERIC_COMMENT_FAILURE_MESSAGE);
}

export function describeMomentDeleteFailure(error: unknown): string {
  return describe(error, GENERIC_DELETE_FAILURE_MESSAGE);
}

/**
 * 点赞 / 取消点赞的写入失败。
 *
 * like 事实的真值仍然只看 Repository：UI 不做 optimistic like state，失败后当前 UI 由
 * 下一次 reload（或当前 DB 状态）决定，因此这里只负责"给出安全提示并吞掉 rejection"。
 */
export function describeMomentLikeFailure(error: unknown): string {
  return describe(error, GENERIC_LIKE_FAILURE_MESSAGE);
}

export function describeMomentUnlikeFailure(error: unknown): string {
  return describe(error, GENERIC_UNLIKE_FAILURE_MESSAGE);
}
