/** 把 Provider 流式增量转换为标准 ModelEvent，并在结束时补齐响应载荷。 */
import type { ChatResponse, ChatStreamDelta, ToolCall } from '../types';
import { ModelTurnCollector } from './ModelTurnCollector';
import type {
  AgentModelRequest,
  AgentModelProvider,
} from './AgentModelGateway';
import { normalizeFinishReason } from './CompleteModelTurnAdapter';
import type {
  ModelEventSink,
  ModelToolCall,
  ModelTurnResult,
} from './ModelEvent';

export class StreamingModelTurnAdapter {
  constructor(private readonly provider: AgentModelProvider) {}

  async stream(request: AgentModelRequest, emit?: ModelEventSink): Promise<ModelTurnResult> {
    const collector = new ModelTurnCollector(emit);
    await collector.accept({ type: 'turn_started' });

    const response = await this.provider.chatStreamWithTools(request.messages, request.tools, {
      toolChoice: request.toolChoice,
      includeSystemPrompt: request.includeSystemPrompt,
      signal: request.signal,
      onDelta: async (delta) => {
        await acceptStreamDelta(collector, delta);
      },
    });
    assertSuccessfulResponse(response);

    const reasoningText = response.reasoningText ?? '';
    if (reasoningText && collector.getReasoningText() === '') {
      await collector.accept({ type: 'reasoning_delta', text: reasoningText });
    } else if (reasoningText !== collector.getReasoningText()) {
      throw new Error('Streaming model reasoning payload conflicts with streamed reasoning');
    }

    await collector.accept({ type: 'assistant_text_completed', text: response.text });
    const responseToolCalls = response.toolCalls ?? [];
    for (const [index, toolCall] of responseToolCalls.entries()) {
      await collector.accept({
        type: 'tool_call_completed',
        index,
        toolCall: toModelToolCall(toolCall, index),
      });
    }

    const hasToolCalls = collector.hasToolCalls();
    const finishReason = normalizeFinishReason(response.finishReason, hasToolCalls);
    if ((response.isToolCall || finishReason === 'tool_calls') && !hasToolCalls) {
      throw new Error('Streaming model response marked as tool call without tool calls');
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

async function acceptStreamDelta(
  collector: ModelTurnCollector,
  delta: ChatStreamDelta
): Promise<void> {
  switch (delta.type) {
    case 'reasoning_delta':
      await collector.accept({ type: 'reasoning_delta', text: delta.text });
      return;
    case 'answer_delta':
      await collector.accept({ type: 'assistant_text_delta', text: delta.text });
      return;
    case 'tool_call_start':
      await collector.accept({
        type: 'tool_call_started',
        index: delta.index,
        toolCallId: delta.toolCallId,
        toolName: delta.name ?? null,
      });
      return;
    case 'tool_call_args_delta':
      await collector.accept({
        type: 'tool_call_arguments_delta',
        index: delta.index,
        toolCallId: delta.toolCallId,
        delta: delta.argumentsDelta,
      });
      return;
    case 'tool_call_done':
      await collector.accept({
        type: 'tool_call_completed',
        index: delta.index,
        toolCall: {
          index: delta.index,
          id: delta.toolCallId,
          name: delta.name,
          arguments: delta.arguments,
        },
      });
      return;
    case 'done':
      return;
    default:
      throw new Error('Unknown ChatStreamDelta');
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
    throw new Error('Malformed streaming model tool call');
  }
  return {
    index,
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  };
}
