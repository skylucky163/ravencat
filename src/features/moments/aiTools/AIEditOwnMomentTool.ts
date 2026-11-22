/** 编辑原帖只接收 patch，作者身份固定为当前工具上下文中的 AI。 */
import { listAIAssistants } from '@features/assistants';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { editOwnMomentAsAgent } from '../application/EditMoment';
import { MomentDomainError } from '../domain/MomentErrors';
import { MAX_MOMENT_MEDIA_COUNT } from '../application/CreateMoment';
import type { MomentToolContext } from './MomentToolContext';

interface Args {
  momentId: string;
  content?: string;
  mediaAssetIds?: string[];
  audience?: { mode: 'all' | 'selected' | 'all_except'; agentIds?: string[] };
}

const definition = {
  name: 'aiEditOwnMoment',
  description: '编辑当前 AI 自己发布的时刻。只覆盖传入字段；省略的字段保持不变。保留原发布时间、评论和点赞，显示已编辑，不重新投递发布未读。',
  parameters: {
    type: 'object' as const,
    properties: {
      momentId: { type: 'string' as const, minLength: 1, description: '要编辑的原帖 ID，可通过 searchMoments 查找自己发布的时刻' },
      content: { type: 'string' as const, minLength: 1, maxLength: 2000, description: '替换后的完整正文，不能为空；省略则不修改' },
      mediaAssetIds: { type: 'array' as const, items: { type: 'string' as const, minLength: 1 }, maxItems: MAX_MOMENT_MEDIA_COUNT, uniqueItems: true,
        description: '传入时整体替换图片列表并按顺序展示；[] 移除全部图片，省略则不修改。仅接受已有图片媒体 ID。getMomentDetail 可读取当前图片的 mediaAssetId。' },
      audience: { type: 'object' as const, description: '传入时整体替换可见范围，省略则不修改。',
        properties: {
          mode: { type: 'string' as const, enum: ['all', 'selected', 'all_except'], description: 'all=全部；selected=仅指定；all_except=除指定外' },
          agentIds: { type: 'array' as const, items: { type: 'string' as const, minLength: 1 }, uniqueItems: true,
            description: '名单使用 aiCreateMoment 可见范围候选列出的稳定 agentId；名称仅用于识别' },
        }, required: ['mode'], additionalProperties: false },
    },
    required: ['momentId'],
    additionalProperties: false,
    anyOf: [{ required: ['content'] }, { required: ['mediaAssetIds'] }, { required: ['audience'] }],
  },
};

async function execute(args: Args, context: MomentToolContext) {
  const agentId = context.getAgentId()?.trim();
  if (!agentId) return { success: false, error: 'AI 身份缺少不可变 agentId，无法编辑时刻' };
  if (context.isBlocked()) return { success: false, error: '当前 AI 已被拉黑，无法编辑时刻' };
  try {
    const audience = args.audience === undefined ? undefined : args.audience.mode === 'all'
      ? { mode: 'all' as const } : { mode: args.audience.mode, viewerAgentIds: args.audience.agentIds ?? [] };
    const moment = await editOwnMomentAsAgent(context.repositories.moment!, {
      listAgentIds: async () => (await listAIAssistants()).map(assistant => assistant.agentId),
    }, { ...args, audience, agentId, abortSignal: context.abortSignal });
    return { success: true, message: `时刻已保存${moment.editedAt ? '，原帖标记为已编辑' : '，内容没有变化'}。momentId: ${moment.id}`, data: moment };
  } catch (error) {
    throwIfAbortSignalAborted(context.abortSignal);
    if (error instanceof MomentDomainError) return { success: false, error: error.message };
    console.error('[AIEditOwnMomentTool] Failed:', error);
    return { success: false, error: '编辑时刻失败' };
  }
}

export const AIEditOwnMomentTool = { name: definition.name, definition, execute };
