/** 将单个 Agent step 的工具批次投影为一条 Chat 状态消息。 */
import type { ModelToolCall } from '@platform/ai';
import type {
  AgentRunEvent,
  AgentTerminalCode,
  AgentToolOutcome,
} from '@platform/agentRuntime';
import { buildChatToolStatusMessageMetadata } from '../application/ChatReplyMetadata';
import { assertChatReplyNotAborted } from '../application/ChatReplyAbort';
import { formatMessageTime } from '../application/ChatReplyUtils';
import { persistChatMessage, syncChatSessionPreview } from '../../messages/application/MessagePersistence';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  ProcessAIReplyCallbacks,
} from '../application/ChatReplyTypes';
import {
  buildToolStatusText,
  joinToolDisplayNames,
  resolveToolCallDisplayName,
  updateToolStatusMessage,
} from './ToolReplyPresentation';
import type { ChatAgentModelTurn } from './ChatAgentModelGateway';

interface ProjectedToolStep {
  turn: ChatAgentModelTurn;
  statusStarted: boolean;
  statusMessage: ChatMessage | null;
  completedOutcomes: Map<string, AgentToolOutcome>;
}

export class ChatAgentToolTimelineProjector {
  private readonly steps = new Map<number, ProjectedToolStep>();

  constructor(private readonly params: {
    sessionId: string;
    repository: IMessageRepository;
    callbacks: ProcessAIReplyCallbacks;
    aiConfig: AIReplyConfig;
    runtimeContext: AIReplyRuntimeContext;
    onWaitExternal: () => void;
  }) {}

  registerStep(stepIndex: number, turn: ChatAgentModelTurn): void {
    if (this.steps.has(stepIndex)) {
      throw new Error(`Chat Agent step ${stepIndex} was projected more than once`);
    }
    this.steps.set(stepIndex, {
      turn,
      statusStarted: false,
      statusMessage: null,
      completedOutcomes: new Map(),
    });
  }

  async handleEvent(event: AgentRunEvent): Promise<void> {
    if (event.type === 'tool_call_proposed') {
      await this.startToolStatus(event.stepIndex);
      return;
    }
    if (event.type === 'tool_call_completed') {
      await this.completeToolCall(event.stepIndex, event.toolCallId, event.outcome);
    }
  }

  private async startToolStatus(stepIndex: number): Promise<void> {
    this.assertActive();
    const step = this.requireStep(stepIndex);
    if (step.statusStarted) {
      return;
    }
    step.statusStarted = true;
    const timelineToolCalls = step.turn.toolCalls;
    if (timelineToolCalls.length === 0) {
      return;
    }

    const now = new Date();
    const toolNames = timelineToolCalls.map((toolCall) => toolCall.name);
    const toolDisplayNames = this.resolveToolDisplayNames(timelineToolCalls);
    const displayText = buildToolStatusText(joinToolDisplayNames(toolDisplayNames), 'running');
    step.statusMessage = await persistChatMessage({
      repository: this.params.repository,
      message: {
        sessionId: this.params.sessionId,
        text: displayText,
        isMe: false,
        senderType: 'system',
        agentId: this.params.aiConfig.agentId,
        apiMessageId: step.turn.messageId,
        time: formatMessageTime(now),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        replyToId: null,
        replyToText: null,
        status: 'streaming',
        tokensUsed: step.turn.usage.totalTokens,
        promptTokens: step.turn.usage.promptTokens,
        completionTokens: step.turn.usage.completionTokens,
        metadataJson: JSON.stringify({
          ...buildChatToolStatusMessageMetadata({
            aiConfig: this.params.aiConfig,
            runtimeContext: this.params.runtimeContext,
            status: 'running',
            toolNames,
            toolDisplayNames,
            displayText,
          }),
          cachedTokens: step.turn.usage.cachedTokens,
        }),
      },
      previewText: null,
      notifyUI: this.params.callbacks.notifyUI,
    });
  }

  private async completeToolCall(
    stepIndex: number,
    toolCallId: string,
    outcome: AgentToolOutcome
  ): Promise<void> {
    this.assertActive();
    const step = this.requireStep(stepIndex);
    if (step.completedOutcomes.has(toolCallId)) {
      throw new Error(`Chat Agent tool call ${toolCallId} completed more than once`);
    }
    step.completedOutcomes.set(toolCallId, outcome);
    if (step.completedOutcomes.size !== step.turn.toolCalls.length) {
      return;
    }

    const timelineToolCalls = step.turn.toolCalls;
    const outcomes = Array.from(step.completedOutcomes.values());
    if (step.statusMessage) {
      const toolNames = timelineToolCalls.map((toolCall) => toolCall.name);
      await updateToolStatusMessage({
        repository: this.params.repository,
        sessionId: this.params.sessionId,
        message: step.statusMessage,
        aiConfig: this.params.aiConfig,
        runtimeContext: this.params.runtimeContext,
        status: outcomes.some(isToolStatusFailure)
          ? 'failed'
          : 'completed',
        toolNames,
        toolDisplayNames: this.resolveToolDisplayNames(timelineToolCalls),
        outcomes,
        extra: { stepIndex, cachedTokens: step.turn.usage.cachedTokens },
      });
    }

    if (step.statusMessage && outcomes.some(isAssistantReplyVisibleOutcome)) {
      await syncChatSessionPreview({
        repository: this.params.repository,
        sessionId: this.params.sessionId,
        time: new Date().toISOString(),
        previewText: '使用了工具',
        notifyUI: this.params.callbacks.notifyUI,
      });
    }

    if (
      step.turn.toolCalls.every((toolCall) => toolCall.name === 'requestVideoCall')
      && outcomes.every(isSuppressedSuccessfulOutcome)
    ) {
      this.params.onWaitExternal();
    }
  }

  private assertActive(): void {
    assertChatReplyNotAborted(this.params.runtimeContext);
  }

  private resolveToolDisplayNames(toolCalls: readonly ModelToolCall[]): string[] {
    return toolCalls.map((toolCall) => resolveToolCallDisplayName(toolCall));
  }

  async closeRun(terminalCode: AgentTerminalCode): Promise<void> {
    if (terminalCode === 'COMPLETED') {
      return;
    }
    for (const [stepIndex, step] of this.steps) {
      if (!step.statusMessage || step.completedOutcomes.size === step.turn.toolCalls.length) {
        continue;
      }
      const toolNames = step.turn.toolCalls.map((toolCall) => toolCall.name);
      const displayNames = this.resolveToolDisplayNames(
        step.turn.toolCalls,
      );
      const cancelled = terminalCode === 'CANCELLED_BY_USER' || terminalCode === 'SUPERSEDED';
      await updateToolStatusMessage({
        repository: this.params.repository,
        sessionId: this.params.sessionId,
        message: step.statusMessage,
        aiConfig: this.params.aiConfig,
        runtimeContext: this.params.runtimeContext,
        status: 'failed',
        toolNames,
        toolDisplayNames: displayNames,
        outcomes: step.completedOutcomes.values(),
        displayText: cancelled
          ? `调用已取消：${joinToolDisplayNames(displayNames)}`
          : undefined,
        extra: { stepIndex, terminalCode, cachedTokens: step.turn.usage.cachedTokens },
      });
    }
  }

  private requireStep(stepIndex: number): ProjectedToolStep {
    const step = this.steps.get(stepIndex);
    if (!step) {
      throw new Error(`Chat Agent event references unknown step ${stepIndex}`);
    }
    return step;
  }
}

function isSuppressedSuccessfulOutcome(outcome: AgentToolOutcome): boolean {
  return outcome.status === 'success' && outcome.metadata?.suppressAssistantReply === true;
}

function isAssistantReplyVisibleOutcome(outcome: AgentToolOutcome): boolean {
  return !isSuppressedSuccessfulOutcome(outcome);
}

function isToolStatusFailure(outcome: AgentToolOutcome): boolean {
  return outcome.status === 'error';
}
