/** 请求系统发起 AI 视频来电的工具。 */

import { requestIncomingCall } from '../application/lifecycle';
import type { ToolContext } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { CallAIConfig } from '../domain/CallAIConfig';

interface RequestVideoCallArgs {
  openingLine: string;
  expectedMode: 'voice' | 'video';
}

export const definition = {
  name: 'requestVideoCall',
  description: '主动向用户发起来电邀请，由用户接听或拒绝。',
  parameters: {
    type: 'object' as const,
    properties: {
      openingLine: { type: 'string' as const, description: '接听后说的第一句口语，也会显示在来电预览中。只写要说的话。' },
      expectedMode: {
        type: 'string' as const,
        enum: ['voice', 'video'],
        description: '期望通话模式',
      },
    },
    required: ['openingLine', 'expectedMode'],
    additionalProperties: false,
  },
};

export async function execute(
  args: RequestVideoCallArgs,
  context: ToolContext
) {
  const openingLine = String(args.openingLine || '').trim();
  const expectedMode = args.expectedMode === 'voice' ? 'voice' : 'video';

  if (!openingLine) {
    return { success: false, error: '缺少接听后的开场白' };
  }

  if (context.isBlocked()) {
    return { success: false, error: '当前 AI 已被拉黑，不能发起视频电话' };
  }

  if (!context.sessionId) {
    return { success: false, error: '当前 Agent run 没有关联真实聊天会话，不能发起视频电话' };
  }

  throwIfAbortSignalAborted(context.abortSignal);

  if (context.sharedState.requestVideoCallSubmitted) {
    return {
      success: true,
      message: '本轮已经提交过一次视频电话请求。',
      data: { skippedDuplicate: true },
    };
  }

  context.sharedState.requestVideoCallSubmitted = true;

  const result = await requestIncomingCall({
    chatSessionId: context.sessionId,
    aiConfig: context.aiConfig as CallAIConfig,
    abortSignal: context.abortSignal,
    payload: {
      openingLine,
      expectedMode,
    },
  });

  if (result.status === 'failed') {
    return {
      success: false,
      error: result.errorMessage,
      data: {
        callId: result.call?.id || null,
      },
    };
  }

  context.notifyUI(context.sessionId);

  return {
    success: true,
    message: '来电邀请已发出，等待用户接听。',
    suppressAssistantReply: true,
    data: {
      callId: result.call.id,
      status: result.status,
    },
  };
}

export const RequestVideoCallTool = {
  name: definition.name,
  definition,
  execute,
};
