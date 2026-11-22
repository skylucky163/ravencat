/** 把一次 complete Provider 响应转换为标准 ModelEvent 并收集成 turn。 */
import type { ChatResponse, ToolCall } from '../types';
import { ModelTurnCollector } from './ModelTurnCollector';
import type {
  AgentModelRequest,
  AgentModelProvider,
} from './AgentModelGateway';
import type {
  ModelEventSink,
  ModelToolCall,
  ModelTurnResult,
} from './ModelEvent';

export class CompleteModelTurnAdapter {
  constructor(private readonly provider: AgentModelProvider) {}

  async complete(request: AgentModelRequest, emit?: ModelEventSink): Promise<ModelTurnResult> {
    const collector = new ModelTurnCollector(emit);
    await collector.accept({ type: 'turn_started' });

    const response = await this.provider.chatWithTools(request.messages, request.tools, {
      toolChoice: request.toolChoice,
      includeSystemPrompt: request.includeSystemPrompt,
      allowReasoningLengthRetry: false,
      signal: request.signal,
    });
    assertSuccessfulResponse(response);

    const reasoningText = response.reasoningText ?? '';
    if (reasoningText) {
      await collector.accept({ type: 'reasoning_delta', text: reasoningText });
    }
    await collector.accept({ type: 'assistant_text_completed', text: response.text });

    const toolCalls = response.toolCalls ?? [];
    const finishReason = normalizeFinishReason(response.finishReason, toolCalls.length > 0);
    if ((response.isToolCall || finishReason === 'tool_calls') && toolCalls.length === 0) {
      throw new Error('Complete model response marked as tool call without tool calls');
    }
    for (const [index, toolCall] of toolCalls.entries()) {
      await collector.accept({
        type: 'tool_call_completed',
        index,
        toolCall: toModelToolCall(toolCall, index),
      });
    }

    await collector.accept({
      type: 'turn_completed',
      usage: {
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        totalTokens: response.totalTokens,
        cachedTokens: response.cachedTokens,
      },
      finishReason,
      ...(response.reasoningReplay ? { reasoningReplay: response.reasoningReplay } : {}),
    });
    return collector.getResult();
  }
}

function assertSuccessfulResponse(response: ChatResponse): void {
  if (response.success) {
    return;
  }
  if (!response.error) {
    throw new Error('Model provider returned an unsuccessful response without an error');
  }
  throw new Error(response.error);
}

function toModelToolCall(toolCall: ToolCall, index: number): ModelToolCall {
  if (!toolCall.id || toolCall.type !== 'function' || !toolCall.function.name) {
    throw new Error('Malformed complete model tool call');
  }
  return {
    index,
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  };
}

export function normalizeFinishReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean
): ModelTurnResult['finishReason'] {
  if (finishReason === 'tool_calls' || finishReason === 'function_call') {
    return 'tool_calls';
  }
  if (finishReason === 'length') {
    return 'length';
  }
  if (finishReason === 'content_filter') {
    return 'content_filter';
  }
  if (finishReason === 'cancelled') {
    return 'cancelled';
  }
  if (finishReason === 'stop' || (!finishReason && !hasToolCalls)) {
    return 'stop';
  }
  if (!finishReason && hasToolCalls) {
    return 'tool_calls';
  }
  return 'unknown';
}
