/**
 * @fileoverview 添加新协议到协议空间的 AI 工具
 * @module features/protocol/aiTools/AddProtocolTool
 */

import type { ProtocolToolContext } from './ProtocolToolContext';
import type { ProtocolInsertResult } from '../domain/ProtocolRepository';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

/**
 * 工具参数接口
 */
interface AddProtocolArgs {
  content: string;
  summary: string;
}

/**
 * 工具执行结果接口
 */
interface AddProtocolResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: ProtocolInsertResult;
}

/**
 * 工具定义（JSON Schema）
 */
export const definition = {
  name: 'addProtocol',
  description: '向当前 AI 的协议空间添加固定注入的提示词或信息；已有内容无需重复添加。',
  parameters: {
    type: 'object',
    properties: {
      content: { 
        type: 'string', 
        description: '协议内容，如"请叫我小明"', 
        maxLength: 500 
      },
      summary: { 
        type: 'string', 
        description: '协议摘要，用于检索，如"称呼约定"', 
        maxLength: 50 
      },
    },
    required: ['content', 'summary'],
  },
};

/**
 * 执行工具
 * @param args - 工具参数
 * @param context - 工具执行上下文
 * @returns 执行结果
 */
export async function execute(
  args: AddProtocolArgs,
  context: ProtocolToolContext
): Promise<AddProtocolResult> {
  const aiAssistantId = context.getAIId();
  const { content, summary } = args;

  if (!aiAssistantId) {
    return { success: false, error: '未指定AI助手' };
  }

  if (!content || !summary) {
    return { success: false, error: '缺少协议内容或摘要' };
  }

  try {
    throwIfAbortSignalAborted(context.abortSignal);
    const protocol = await context.repositories.protocol!.insert({
      aiAssistantId,
      content,
      summary,
    });

    return {
      success: true,
      message: (protocol.alreadyExists
        ? '这条协议已经存在，无需重复添加'
        : '已添加常驻提示词，将在后续请求中自动注入') + `（id 用作 protocolId）:\n${JSON.stringify(protocol)}`,
      data: protocol
    };
  } catch (error) {
    throwIfAbortSignalAborted(context.abortSignal);
    console.error('[AddProtocolTool] Failed:', error);
    return { success: false, error: '添加协议失败' };
  }
}

/**
 * 工具对象（定义 + 执行）
 */
export const AddProtocolTool = {
  name: definition.name,
  definition,
  execute,
};
