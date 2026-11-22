/** AI 删除自己的 Moment 评论。 */
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { deleteOwnMomentCommentAsAgent } from '../application/MomentAccess';
import { MomentDomainError } from '../domain/MomentErrors';
import type { MomentToolContext } from './MomentToolContext';

interface AIDeleteOwnMomentCommentArgs { commentId: string }
interface AIDeleteOwnMomentCommentResult { success: boolean; message?: string; error?: string }

export const definition = {
  name: 'aiDeleteOwnMomentComment',
  description: '删除自己发表的时刻评论或回复。',
  parameters: {
    type: 'object' as const,
    properties: {
      commentId: { type: 'string' as const, description: '自己发表的评论或回复的 ID，取自评论或回复工具的结果，也可从 getMomentDetail 或 searchMoments 的结果中获取。' },
    },
    required: ['commentId'],
  },
};

export async function execute(
  args: AIDeleteOwnMomentCommentArgs,
  context: MomentToolContext
): Promise<AIDeleteOwnMomentCommentResult> {
  const agentId = context.getAgentId()?.trim() || null;
  const aiName = context.getAIName();
  if (!agentId || !aiName) return { success: false, error: 'AI 身份缺少不可变 agentId，无法删除' };
  if (context.isBlocked()) return { success: false, error: '当前 AI 已被拉黑，无法删除' };
  try {
    throwIfAbortSignalAborted(context.abortSignal);
    const deleted = await deleteOwnMomentCommentAsAgent(
      context.repositories.moment!,
      { agentId, nameSnapshot: aiName },
      args.commentId,
      context.abortSignal
    );
    return deleted
      ? { success: true, message: `评论已删除。commentId: ${args.commentId}` }
      : { success: false, error: '评论不存在' };
  } catch (error) {
    throwIfAbortSignalAborted(context.abortSignal);
    if (error instanceof MomentDomainError) return { success: false, error: '只能删除自己发表且所属时刻可见的评论' };
    console.error('[AIDeleteOwnMomentCommentTool] Failed:', error);
    return { success: false, error: '删除评论失败' };
  }
}

export const AIDeleteOwnMomentCommentTool = { name: definition.name, definition, execute };
