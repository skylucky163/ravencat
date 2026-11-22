/** 根据 AI 配置与运行时上下文决定回复分段、模型传输和工具调用策略。 */
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
} from './ChatReplyTypes';
import type { BubbleDeliveryMode } from '@shared/prompt';
import type { ModelTransportMode } from '@shared/aiTools';

export interface AIReplyPolicy {
  bubbleDeliveryMode: BubbleDeliveryMode;
  modelTransport: ModelTransportMode;
  enableTools: boolean;
}

export function resolveAIReplyPolicy(
  aiConfig: AIReplyConfig,
  runtimeContext: AIReplyRuntimeContext,
): AIReplyPolicy {
  const allowMultipleBubbles = aiConfig.allowMultipleBubbles !== false
    && runtimeContext.supportsMultipleBubbles !== false;
  const enableStreaming = shouldUseStreamingReply(aiConfig, runtimeContext);
  const enableTools = canUseToolsInRuntimeContext(aiConfig, runtimeContext);
  return {
    bubbleDeliveryMode: allowMultipleBubbles ? 'multi-bubble' : 'single-bubble',
    modelTransport: enableStreaming ? 'stream' : 'complete',
    enableTools,
  };
}

export function canUseToolsInRuntimeContext(
  aiConfig: AIReplyConfig,
  runtimeContext: AIReplyRuntimeContext,
): boolean {
  return Boolean(
    aiConfig.enableTools &&
    (runtimeContext.allowedToolNames?.length || 0) > 0
  );
}

export function shouldUseStreamingReply(
  aiConfig: AIReplyConfig,
  runtimeContext: AIReplyRuntimeContext
): boolean {
  const triggerSource = runtimeContext.triggerSource || 'chat';
  const requestedStreaming = Boolean(
    aiConfig.enableStreamingReply ||
    runtimeContext.capabilities?.includes('chat.streaming')
  );

  return Boolean(
    requestedStreaming &&
    !runtimeContext.allowSilentReply &&
    triggerSource === 'chat' &&
    !runtimeContext.groupChat
  );
}
