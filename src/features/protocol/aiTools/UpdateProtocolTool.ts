/**
 * @fileoverview 更新已有协议的 AI 工具
 * @module features/protocol/aiTools/UpdateProtocolTool
 */

import type { ProtocolToolContext } from './ProtocolToolContext';
import type { Protocol, UpdateProtocolInput } from '../domain/ProtocolRepository';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

/**
 * 工具参数接口
 */
interface UpdateProtocolArgs {
  protocolId: string;
  content?: string;
  summary?: string;
}

/**
 * 工具执行结果接口
 */
interface UpdateProtocolResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: Protocol;
}

/**
 * 工具定义（JSON Schema）
 */
export const definition = {
  name: 'updateProtocol',
  description: '修改当前 AI 协议空间的一条协议。',
  parameters: {
    type: 'object',
    properties: {
      protocolId: { type: 'string', description: '查询或添加协议工具返回条目的 id' },
      content: { type: 'string', description: '新协议内容' },
      summary: { type: 'string', description: '新协议摘要' },
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
  args: UpdateProtocolArgs,
  context: ProtocolToolContext
): Promise<UpdateProtocolResult> {
  const aiAssistantId = context.getAIId();
  const { protocolId, content, summary } = args;

  if (!aiAssistantId) {
    return { success: false, error: '未指定AI助手' };
  }

  if (!protocolId) {
    return { success: false, error: '缺少协议ID' };
  }

  const updates: UpdateProtocolInput = {};
  if (content !== undefined) updates.content = content;
  if (summary !== undefined) updates.summary = summary;

  if (Object.keys(updates).length === 0) {
    return { success: false, error: '没有要更新的内容' };
  }

  try {
    throwIfAbortSignalAborted(context.abortSignal);
    const protocol = await context.repositories.protocol!.update(aiAssistantId, protocolId, updates);
    if (!protocol) {
      return { success: false, error: '协议不存在或不属于当前 AI，未执行更新。请查询协议空间取得真实 ID。' };
    }

    return {
      success: true,
      message: `已更新协议（id 用作 protocolId）:\n${JSON.stringify(protocol)}`,
      data: protocol
    };
  } catch (error) {
    throwIfAbortSignalAborted(context.abortSignal);
    console.error('[UpdateProtocolTool] Failed:', error);
    return { success: false, error: '更新协议失败' };
  }
}

/**
 * 工具对象（定义 + 执行）
 */
export const UpdateProtocolTool = {
  name: definition.name,
  definition,
  execute,
};
