/** AI 发布文字与可选图片 Moment；作者身份只取自 trusted ToolContext。 */
import { listAIAssistants } from '@features/assistants';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { createAgentMoment, MAX_MOMENT_MEDIA_COUNT } from '../application/CreateMoment';
import { MomentDomainError } from '../domain/MomentErrors';
import type { MomentAudience } from '../domain/MomentRepository';
import type { MomentToolContext } from './MomentToolContext';

interface AICreateMomentArgs {
  content: string;
  mediaAssetIds?: string[];
  audience?: {
    mode: 'all' | 'selected' | 'all_except';
    agentIds?: string[];
  };
}

interface AICreateMomentResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: { momentId: string };
}

export const definition = {
  name: 'aiCreateMoment',
  description: '发布一条时刻（朋友圈），可附带已有图片。',
  parameters: {
    type: 'object' as const,
    properties: {
      content: { type: 'string' as const, description: '时刻正文', maxLength: 2000 },
      mediaAssetIds: {
        type: 'array' as const,
        items: { type: 'string' as const, minLength: 1 },
        maxItems: MAX_MOMENT_MEDIA_COUNT,
        uniqueItems: true,
        description: '可选图片媒体 ID，按展示顺序传入，最多 9 张。使用消息、下载或生图工具返回的 mediaAssetId；不传或空数组发布纯文字。不接受路径或 URL，不确定图片内容时先看图。',
      },
      audience: {
        type: 'object' as const,
        description: '可见范围；省略时对全部 AI 可见',
        properties: {
          mode: {
            type: 'string' as const,
            enum: ['all', 'selected', 'all_except'],
            description: 'all=全部；selected=仅指定；all_except=除指定外',
          },
          agentIds: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description: 'selected 的 allow list 或 all_except 的 deny list，使用本参数列出的时刻可见范围候选的稳定 agentId；名称仅用于识别',
          },
        },
        required: ['mode'],
      },
    },
    required: ['content'],
  },
};

function toAudience(input: AICreateMomentArgs['audience']): MomentAudience {
  if (!input || input.mode === 'all') return { mode: 'all' };
  return { mode: input.mode, viewerAgentIds: input.agentIds ?? [] };
}

export async function execute(
  args: AICreateMomentArgs,
  context: MomentToolContext
): Promise<AICreateMomentResult> {
  const agentId = context.getAgentId()?.trim() || null;
  const aiName = context.getAIName();
  if (!agentId || !aiName) {
    return { success: false, error: 'AI 身份缺少不可变 agentId，无法发布时刻' };
  }
  if (context.isBlocked()) {
    return { success: false, error: '当前 AI 已被拉黑，无法发布时刻' };
  }

  try {
    throwIfAbortSignalAborted(context.abortSignal);
    const moment = await createAgentMoment(
      context.repositories.moment!,
      {
        listAgentIds: async () => (await listAIAssistants()).map((assistant) => assistant.agentId),
      },
      {
        agentId,
        nameSnapshot: aiName,
        content: args.content,
        mediaAssetIds: args.mediaAssetIds,
        audience: toAudience(args.audience),
        abortSignal: context.abortSignal,
      }
    );
    return {
      success: true,
      message: `时刻发布成功。momentId: ${moment.id}\n内容: ${moment.content}\n可直接用此 momentId 读取详情或删除自己发布的时刻。`,
      data: { momentId: moment.id },
    };
  } catch (error) {
    throwIfAbortSignalAborted(context.abortSignal);
    if (error instanceof MomentDomainError) {
      return { success: false, error: error.message };
    }
    console.error('[AICreateMomentTool] Failed:', error);
    return { success: false, error: '时刻发布失败' };
  }
}

export const AICreateMomentTool = { name: definition.name, definition, execute };

/** 名单随发布工具 schema 暴露；每次 run 冻结一次，拆包不改写聊天上下文。 */
export async function createMomentToolForRun(): Promise<typeof AICreateMomentTool> {
  const candidates = (await listAIAssistants()).map((assistant) => ({
    displayName: assistant.name, agentId: assistant.agentId,
  }));
  const audience = definition.parameters.properties.audience;
  const agentIds = audience.properties.agentIds;
  return {
    ...AICreateMomentTool,
    definition: {
      ...definition,
      parameters: {
        ...definition.parameters,
        properties: {
          ...definition.parameters.properties,
          audience: {
            ...audience,
            properties: {
              ...audience.properties,
              agentIds: { ...agentIds, description: `${agentIds.description}\n${JSON.stringify(candidates)}` },
            },
          },
        },
      },
    },
  };
}
