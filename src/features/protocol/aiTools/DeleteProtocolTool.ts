/**
 * @fileoverview 删除协议的 AI 工具
 * @module features/protocol/aiTools/DeleteProtocolTool
 */

import type { ProtocolToolContext } from './ProtocolToolContext';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

/**
 * 工具参数接口
 */
interface DeleteProtocolArgs {
  protocolId: string;
}

/**
 * 工具执行结果接口
 */
interface DeleteProtocolResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * 工具定义（JSON Schema）
 */
export const definition = {
  name: 'deleteProtocol',
  description: '删除当前 AI 协议空间中不再需要的条目。',
  parameters: {
    type: 'object',
    properties: {
      protocolId: { type: 'string', description: '查询或添加协议工具返回条目的 id' },
    },
    required: ['protocolId'],
  },
};

/**
 * 执行工具
 * @param args - 工具参数
 * @param context - 工具执行上下文
 * @returns 执行结果
 */
export async function execute(
  args: DeleteProtocolArgs,
  context: ProtocolToolContext
): Promise<DeleteProtocolResult> {
  const aiAssistantId = context.getAIId();
  const { protocolId } = args;

  if (!aiAssistantId) {
    return { success: false, error: '未指定AI助手' };
  }

  if (!protocolId) {
    return { success: false, error: '缺少协议ID' };
  }

  try {
    throwIfAbortSignalAborted(context.abortSignal);
    const deleted = await context.repositories.protocol!.delete(aiAssistantId, protocolId);
    if (!deleted) {
      return { success: false, error: '协议不存在或不属于当前 AI，未执行删除。请查询协议空间取得真实 ID。' };
    }
    return { success: true, message: `已删除协议，protocolId: ${protocolId}` };
  } catch (error) {
    throwIfAbortSignalAborted(context.abortSignal);
    console.error('[DeleteProtocolTool] Failed:', error);
    return { success: false, error: '删除协议失败' };
  }
}

/**
 * 工具对象（定义 + 执行）
 */
export const DeleteProtocolTool = {
  name: definition.name,
  definition,
  execute,
};
