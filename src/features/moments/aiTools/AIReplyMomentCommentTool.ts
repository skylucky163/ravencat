/** AI 回复某条 Moment 评论；Moment 由 commentId 在 Application 内反查。 */
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { replyMomentCommentAsAgent } from '../application/MomentAccess';
import { MomentDomainError } from '../domain/MomentErrors';
import type { MomentToolContext } from './MomentToolContext';

interface AIReplyMomentCommentArgs { commentId: string; content: string }
interface AIReplyMomentCommentResult { success: boolean; message?: string; error?: string; data?: { momentId: string; commentIds: string[] } }

export const definition = {
  name: 'aiReplyMomentComment',
  description: '回复时刻中的指定评论。先用 getMomentDetail 阅读并获取 commentId。',
  parameters: {
    type: 'object' as const,
    properties: {
      commentId: { type: 'string' as const, description: '被回复的评论ID' },
      content: { type: 'string' as const, description: '回复内容', maxLength: 500 },
    },
    required: ['commentId', 'content'],
  },
};

export async function execute(
  args: AIReplyMomentCommentArgs,
  context: MomentToolContext
): Promise<AIReplyMomentCommentResult> {
  const agentId = context.getAgentId()?.trim() || null;
  const aiName = context.getAIName();
  if (!args.commentId) return { success: false, error: '缺少评论ID' };
  if (!agentId || !aiName) return { success: false, error: 'AI 身份缺少不可变 agentId，无法回复' };
  if (context.isBlocked()) return { success: false, error: '当前 AI 已被拉黑，无法回复' };

  try {
    throwIfAbortSignalAborted(context.abortSignal);
    const comments = await replyMomentCommentAsAgent(
      context.repositories.moment!,
      { agentId, nameSnapshot: aiName },
      args.commentId,
      [args.content],
      context.abortSignal
    );
    return {
      success: true,
      message: `回复成功。momentId: ${comments[0].momentId}\n${comments.map((comment) => `commentId: ${comment.id}，parentCommentId: ${comment.parentCommentId}\n内容: ${comment.content}`).join('\n')}\n需要撤回时直接用新回复的 commentId 调用 aiDeleteOwnMomentComment。`,
      data: { momentId: comments[0].momentId, commentIds: comments.map((comment) => comment.id) },
    };
  } catch (error) {
    throwIfAbortSignalAborted(context.abortSignal);
    if (error instanceof MomentDomainError) {
      if (error.code === 'empty_content') return { success: false, error: '回复内容不能为空' };
      if (error.code === 'comment_not_found' || error.code === 'moment_not_visible') {
        return { success: false, error: '未找到该评论或所属时刻不可见，尚未回复。不要重复使用失效或猜测的 commentId；已知 momentId 时用 getMomentDetail 重新读取评论区，否则用 searchMoments 的 commentKeyword 按评论原文查找，再使用详情返回的 commentId 回复。' };
      }
    }
    console.error('[AIReplyMomentCommentTool] Failed:', error);
    return { success: false, error: '回复失败' };
  }
}

export const AIReplyMomentCommentTool = { name: definition.name, definition, execute };
