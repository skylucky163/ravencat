/** Host 装配 Moments 的权限查询和 Chat 的输出意图，不另建消息写入路径。 */
import { getAIAssistantById } from '@features/assistants';
import { createAgentMomentShare, MomentDomainError } from '@features/moments';
import { createSharedMomentSendIntent } from '@features/chat/composition';
import type { AgentToolExecutionContext, AgentToolExecutionResult, ToolDefinition } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

export const ShareMomentTool = {
  name: 'share_moment',
  definition: {
    name: 'share_moment', description: '将一条你可见的时刻作为真实卡片分享到当前单聊或群聊。只需传入 momentId，正文、图片和原作者身份由系统取得。分享不包含评论和点赞，也不改变原帖权限。不要在正文中伪造分享卡片。',
    parameters: { type: 'object', properties: { momentId: { type: 'string', minLength: 1, description: '从时刻查询、详情或已有分享中取得的时刻 ID' } }, required: ['momentId'], additionalProperties: false },
  } satisfies ToolDefinition,
  async execute(input: { momentId: string }, context: AgentToolExecutionContext): Promise<AgentToolExecutionResult<ReturnType<typeof createSharedMomentSendIntent>>> {
    throwIfAbortSignalAborted(context.abortSignal);
    const assistant = await getAIAssistantById(context.task.assistantId);
    if (!assistant) return { status: 'error', code: 'ASSISTANT_UNAVAILABLE', retryable: false, modelContent: '当前 AI 身份已不可用，时刻尚未分享。' };
    try {
      const snapshot = await createAgentMomentShare(input.momentId, assistant.agentId);
      throwIfAbortSignalAborted(context.abortSignal);
      return { status: 'success', data: createSharedMomentSendIntent(snapshot), metadata: { fulfillsUserVisibleOutput: true },
        modelContent: '时刻卡片已准备，等待随本轮回复提交。无需重复发送或用文字补充“已分享”。' };
    } catch (error) {
      if (error instanceof MomentDomainError && error.code === 'moment_not_visible') return { status: 'error', code: 'MOMENT_NOT_VISIBLE', retryable: false, modelContent: '该时刻不存在或对你不可见，尚未分享。请通过 searchMoments 查找可见原帖，不要重复尝试同一 ID。' };
      throw error;
    }
  },
};
