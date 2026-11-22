/** 把 complete/stream 两种事件序列收敛成同一份模型 turn 结果。 */
import type {
  ModelEvent,
  ModelEventSink,
  ModelHistoryItem,
  ModelToolCall,
  ModelTurnResult,
} from './ModelEvent';

interface MutableToolCall {
  index: number;
  id: string;
  hasSyntheticId: boolean;
  name: string | null;
  arguments: string;
  completed: boolean;
}

export class ModelTurnCollector {
  private started = false;
  private completed = false;
  private assistantText = '';
  private reasoningText = '';
  private readonly toolCallsByIndex = new Map<number, MutableToolCall>();
  private readonly toolCallIndexesById = new Map<string, number>();
  private result: ModelTurnResult | null = null;

  constructor(private readonly emit?: ModelEventSink) {}

  async accept(event: ModelEvent): Promise<void> {
    let shouldEmit = true;

    if (event.type === 'turn_started') {
      if (this.started) {
        throw new Error('Model turn started more than once');
      }
      this.started = true;
    } else {
      this.assertAcceptingEvent();
      switch (event.type) {
        case 'reasoning_delta':
          this.reasoningText += event.text;
          break;
        case 'assistant_text_delta':
          this.assistantText += event.text;
          break;
        case 'assistant_text_completed':
          this.reconcileAssistantText(event.text);
          break;
        case 'tool_call_started':
          shouldEmit = this.acceptToolCallStarted(event);
          break;
        case 'tool_call_arguments_delta':
          this.acceptToolCallArgumentsDelta(event);
          break;
        case 'tool_call_completed':
          shouldEmit = this.acceptToolCallCompleted(event);
          break;
        case 'turn_completed':
          this.result = this.buildResult(event.usage, event.finishReason, event.reasoningReplay);
          this.completed = true;
          break;
        default:
          throw new Error('Unknown ModelEvent');
      }
    }

    if (shouldEmit) {
      if (this.emit) {
        await this.emit(event);
      }
    }
  }

  getResult(): ModelTurnResult {
    if (!this.result) {
      throw new Error('Model turn has not completed');
    }
    return this.result;
  }

  getReasoningText(): string {
    return this.reasoningText;
  }

  hasToolCalls(): boolean {
    return this.toolCallsByIndex.size > 0;
  }

  private assertAcceptingEvent(): void {
    if (!this.started) {
      throw new Error('Model event received before turn_started');
    }
    if (this.completed) {
      throw new Error('Model event received after turn_completed');
    }
  }

  private reconcileAssistantText(text: string): void {
    if (this.assistantText === text) {
      return;
    }
    if (this.assistantText === '' || text.startsWith(this.assistantText)) {
      this.assistantText = text;
      return;
    }
    throw new Error('Model assistant text payload conflicts with streamed text');
  }

  private acceptToolCallStarted(event: Extract<ModelEvent, { type: 'tool_call_started' }>): boolean {
    this.assertToolCallIdentity(event.index, event.toolCallId);
    const current = this.toolCallsByIndex.get(event.index);
    if (!current) {
      this.toolCallsByIndex.set(event.index, {
        index: event.index,
        id: event.toolCallId,
        hasSyntheticId: isSyntheticToolCallId(event.index, event.toolCallId),
        name: event.toolName,
        arguments: '',
        completed: false,
      });
      this.toolCallIndexesById.set(event.toolCallId, event.index);
      return true;
    }

    if (event.toolName && current.name && event.toolName !== current.name) {
      throw new Error(`Model tool name changed for call ${event.toolCallId}`);
    }
    if (!current.name && event.toolName) {
      current.name = event.toolName;
      return true;
    }
    return false;
  }

  private acceptToolCallArgumentsDelta(
    event: Extract<ModelEvent, { type: 'tool_call_arguments_delta' }>
  ): void {
    this.assertToolCallIdentity(event.index, event.toolCallId);
    const current = this.toolCallsByIndex.get(event.index);
    if (!current) {
      throw new Error(`Model tool arguments received before call start: ${event.toolCallId}`);
    }
    if (current.completed) {
      throw new Error(`Model tool arguments received after call completion: ${event.toolCallId}`);
    }
    current.arguments += event.delta;
  }

  private acceptToolCallCompleted(
    event: Extract<ModelEvent, { type: 'tool_call_completed' }>
  ): boolean {
    const toolCall = event.toolCall;
    if (toolCall.index !== event.index) {
      throw new Error(`Model tool call index mismatch for call ${toolCall.id}`);
    }
    this.assertToolCallIdentity(toolCall.index, toolCall.id);
    if (!toolCall.name || !toolCall.arguments) {
      throw new Error(`Malformed Model tool call: ${toolCall.id}`);
    }
    JSON.parse(toolCall.arguments);

    const current = this.toolCallsByIndex.get(toolCall.index);
    if (!current) {
      this.toolCallsByIndex.set(toolCall.index, {
        index: toolCall.index,
        id: toolCall.id,
        hasSyntheticId: false,
        name: toolCall.name,
        arguments: toolCall.arguments,
        completed: true,
      });
      this.toolCallIndexesById.set(toolCall.id, toolCall.index);
      return true;
    }

    if (current.name && current.name !== toolCall.name) {
      throw new Error(`Model tool name changed for call ${toolCall.id}`);
    }
    if (current.arguments && current.arguments !== toolCall.arguments) {
      if (!toolCall.arguments.startsWith(current.arguments)) {
        throw new Error(`Model tool arguments changed for call ${toolCall.id}`);
      }
    }
    if (current.completed) {
      if (current.arguments !== toolCall.arguments || current.name !== toolCall.name) {
        throw new Error(`Duplicate Model tool call conflicts for call ${toolCall.id}`);
      }
      return false;
    }

    current.name = toolCall.name;
    current.arguments = toolCall.arguments;
    current.completed = true;
    return true;
  }

  private assertToolCallIdentity(index: number, id: string): void {
    if (!Number.isInteger(index) || index < 0 || !id) {
      throw new Error('Malformed Model tool call identity');
    }
    const existingIndex = this.toolCallIndexesById.get(id);
    if (existingIndex !== undefined && existingIndex !== index) {
      throw new Error(`Model tool call id reused at another index: ${id}`);
    }
    const existing = this.toolCallsByIndex.get(index);
    if (existing && existing.id !== id) {
      if (!existing.hasSyntheticId || existing.completed) {
        throw new Error(`Model tool call index reused with another id: ${index}`);
      }
      this.toolCallIndexesById.delete(existing.id);
      existing.id = id;
      existing.hasSyntheticId = false;
      this.toolCallIndexesById.set(id, index);
    }
  }

  private buildResult(
    usage: ModelTurnResult['usage'],
    finishReason: ModelTurnResult['finishReason'],
    reasoningReplay?: ModelTurnResult['reasoningReplay'],
  ): ModelTurnResult {
    const mutableCalls = [...this.toolCallsByIndex.values()].sort((a, b) => a.index - b.index);
    if (mutableCalls.some((toolCall) => !toolCall.completed || !toolCall.name)) {
      throw new Error('Model turn completed with incomplete tool arguments');
    }

    const toolCalls: ModelToolCall[] = mutableCalls.map((toolCall) => ({
      index: toolCall.index,
      id: toolCall.id,
      name: toolCall.name as string,
      arguments: toolCall.arguments,
    }));
    const historyItems: ModelHistoryItem[] = [{
      role: 'assistant',
      content: this.assistantText,
      reasoningText: this.reasoningText,
      ...(reasoningReplay ? { reasoningReplay } : {}),
      toolCalls,
    }];

    return {
      historyItems,
      assistantText: this.assistantText,
      reasoningText: this.reasoningText,
      ...(reasoningReplay ? { reasoningReplay } : {}),
      toolCalls,
      usage,
      finishReason,
    };
  }
}

function isSyntheticToolCallId(index: number, id: string): boolean {
  return id === `tool_call_${index}`;
}
