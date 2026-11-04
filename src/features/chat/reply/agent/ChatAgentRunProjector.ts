/** 将 Agent Runtime 生命周期投影为 Chat 前言、工具状态和最终回复。 */
import type {
  AgentRunEvent,
  AgentRunTerminalResult,
} from '@platform/agentRuntime';
import { assertChatReplyNotAborted, ChatReplyRunCancelledError } from '../application/ChatReplyAbort';
import type { AssistantTurnCommitPort } from '../application/AssistantTurnCommit';
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  AIResponse,
  ProcessAIReplyCallbacks,
} from '../application/ChatReplyTypes';
import type { AIReplyPolicy } from '../application/ReplyPolicy';
import { ChatAgentToolTimelineProjector } from './ChatAgentToolTimelineProjector';
import type { ChatAgentModelTurn } from './ChatAgentModelGateway';
import { ChatStreamingReplyProjector } from './ChatStreamingReplyProjector';
import {
  ChatAgentTimeline,
  type AgentTimelineTransientSink,
  type FinalAssistantPolicy,
} from './ChatAgentTimeline';

export type { FinalAssistantPolicy } from './ChatAgentTimeline';

/**
 * canonical Agent timeline 的提交接缝。
 *
 * 普通回复、自主回合与群聊各自由原持久 owner 实现输出提交和整轮完成。
 * 投影层只提交有稳定身份的 Chat items，不拥有游标、执行槽或触发方业务状态。
 */
export interface AgentTimelineCommitPort {
  commitAgentOutput?: AssistantTurnCommitPort['commitAgentOutput'];
  commitAgentTimeline(params: Parameters<AssistantTurnCommitPort['persistCompletedAssistantReply']>[0] & {
    items: import('../domain/ConversationTurn').ConversationTurnCommitItem[];
  }): Promise<{
    outcome: 'committed' | 'fence_failed' | 'empty_items';
    messages: import('../../messages/domain/ChatMessage').ChatMessage[];
  }>;
}

export class ChatAgentRunFailedError extends Error {
  readonly terminalCode: AgentRunTerminalResult['terminalCode'];
  readonly diagnosticText: string;

  constructor(result: AgentRunTerminalResult) {
    super(`Chat Agent run failed: ${result.terminalCode}`);
    this.name = 'ChatAgentRunFailedError';
    this.terminalCode = result.terminalCode;
    // 错误气泡需要跨重启保留线索；只投影编号、工具名和结果码，不携带参数、正文或 observation。
    const toolLines = result.steps.flatMap((step) => step.modelTurn.toolCalls.map((call) => {
      const record = step.toolCalls.find((item) => item.toolCall.id === call.id);
      let status: string;
      if (!record) {
        status = result.terminalCode === 'MODEL_PROTOCOL_ERROR' ? '未执行：调用未通过协议检查' : '未记录完成结果';
      } else if (record.outcome.status === 'success') {
        status = '成功';
      } else if (record.outcome.code === 'TOOL_EXECUTION_TIMEOUT') {
        status = '超时：结果未知';
      } else {
        status = `${record.startedAt === null ? '未执行' : '执行失败'}：${record.outcome.code}`;
      }
      return `第 ${step.stepIndex} 轮 ${call.name}：${status}`;
    }));
    this.diagnosticText = [
      `错误码：${result.terminalCode}`,
      `回复编号：${result.runId}`,
      ...(toolLines.length ? ['工具记录：', ...toolLines] : ['本次没有已返回的工具调用记录。']),
    ].join('\n');
  }
}

export class ChatAgentRunProjector {
  private readonly sessionId: string;
  private readonly repository: IMessageRepository;
  private readonly callbacks: ProcessAIReplyCallbacks;
  private readonly aiConfig: AIReplyConfig;
  private readonly runtimeContext: AIReplyRuntimeContext;
  private readonly policy: AIReplyPolicy;
  private readonly legacyPersistence: AssistantTurnCommitPort | null;
  private readonly timelineCommit: AgentTimelineCommitPort | null;
  private readonly finalAssistantPolicy: FinalAssistantPolicy;
  private readonly stopRuntime: () => void;
  private readonly toolTimeline: ChatAgentToolTimelineProjector | null;
  private readonly canonicalTimeline: ChatAgentTimeline | null;
  private readonly streamingReply: ChatStreamingReplyProjector | null;
  private readonly modelTurns = new Map<number, ChatAgentModelTurn>();
  private waitingForExternalAction = false;

  constructor(params: {
    sessionId: string;
    repository: IMessageRepository;
    callbacks: ProcessAIReplyCallbacks;
    aiConfig: AIReplyConfig;
    runtimeContext: AIReplyRuntimeContext;
    policy: AIReplyPolicy;
    projection:
      | { kind: 'legacy'; persistence: AssistantTurnCommitPort }
      | { kind: 'canonical'; commit: AgentTimelineCommitPort };
    stopRuntime: () => void;
    replyRunId: string;
    finalAssistantPolicy: FinalAssistantPolicy;
    timelineSink?: AgentTimelineTransientSink;
  }) {
    this.sessionId = params.sessionId;
    this.repository = params.repository;
    this.callbacks = params.callbacks;
    this.aiConfig = params.aiConfig;
    this.runtimeContext = params.runtimeContext;
    this.policy = params.policy;
    this.legacyPersistence = params.projection.kind === 'legacy'
      ? params.projection.persistence
      : null;
    this.timelineCommit = params.projection.kind === 'canonical'
      ? params.projection.commit
      : null;
    this.finalAssistantPolicy = params.finalAssistantPolicy;
    this.stopRuntime = params.stopRuntime;
    const isCanonical = params.projection.kind === 'canonical';
    this.streamingReply = !isCanonical && params.policy.modelTransport === 'stream'
      ? new ChatStreamingReplyProjector({
          sessionId: params.sessionId,
          repository: params.repository,
          callbacks: params.callbacks,
          aiConfig: params.aiConfig,
          runtimeContext: params.runtimeContext,
          policy: params.policy,
          persistence: this.requireLegacyPersistence(),
          replyRunId: params.replyRunId,
        })
      : null;
    this.canonicalTimeline = isCanonical
      ? new ChatAgentTimeline(
          params.replyRunId,
          params.timelineSink,
          params.policy,
          params.finalAssistantPolicy,
        )
      : null;
    this.toolTimeline = isCanonical
      ? null
      : new ChatAgentToolTimelineProjector({
          sessionId: params.sessionId,
          repository: params.repository,
          callbacks: params.callbacks,
          aiConfig: params.aiConfig,
          runtimeContext: params.runtimeContext,
          onWaitExternal: () => {
            this.waitingForExternalAction = true;
            params.stopRuntime();
          },
        });
  }

  async projectModelTurn(stepIndex: number, turn: ChatAgentModelTurn): Promise<void> {
    this.assertActive();
    this.modelTurns.set(stepIndex, turn);
    if (this.canonicalTimeline) {
      this.canonicalTimeline.reconcileModelTurn(
        stepIndex,
        turn,
      );
      return;
    }
    if (this.streamingReply) {
      await this.streamingReply.completeModelTurn(stepIndex, turn);
    }
    this.toolTimeline?.registerStep(stepIndex, turn);
    if (!this.streamingReply && turn.toolCalls.length > 0) {
      await this.persistAssistantPrelude(turn);
    }
  }

  async handleEvent(event: AgentRunEvent): Promise<void> {
    if (this.canonicalTimeline) {
      return this.handleCanonicalEvent(event);
    }
    if (this.streamingReply && event.type === 'model_turn_started') {
      this.streamingReply.startTurn(event.stepIndex);
      return;
    }
    if (this.streamingReply && (
      event.type === 'reasoning_delta' || event.type === 'assistant_text_delta'
    )) {
      await this.streamingReply.handleDelta(event.stepIndex, event);
      return;
    }
    return this.toolTimeline?.handleEvent(event);
  }

  async completeRun(result: AgentRunTerminalResult): Promise<void> {
    if (this.canonicalTimeline) {
      this.canonicalTimeline.closeRun(result.terminalCode);
      // 通话提交后由投影层停止模型续轮；这次内部停止不能丢弃已完成的工具记录。
      if (!this.waitingForExternalAction && (
        result.terminalCode === 'CANCELLED_BY_USER' || result.terminalCode === 'SUPERSEDED'
      )) {
        this.canonicalTimeline.clear(
          result.terminalCode === 'SUPERSEDED' ? 'superseded' : 'cancelled',
        );
        return;
      }
      this.assertActive();
      if (result.terminalCode === 'COMPLETED' || this.waitingForExternalAction) {
        const finalStep = requireLastStep(result);
        const commitPort = this.requireTimelineCommitPort();
        const finalTurn = this.requireModelTurn(finalStep.stepIndex);
        const response = toAIResponse(finalTurn);
        const items = this.canonicalTimeline.buildCommitItems({
          sessionId: this.sessionId,
          aiConfig: this.aiConfig,
          runtimeContext: this.runtimeContext,
          policy: this.policy,
          finalAssistantPolicy: this.finalAssistantPolicy,
          finalStepIndex: finalStep.stepIndex,
        });
        try {
          const commitResult = await commitPort.commitAgentTimeline({
            sessionId: this.sessionId,
            response,
            items,
            toolPackageChanges: result.steps.flatMap((step) => step.toolCalls.flatMap(({ outcome }) => (
              outcome.status === 'success' && outcome.metadata?.toolPackageChange
                ? [outcome.metadata.toolPackageChange]
                : []
            ))),
            repository: this.repository,
            callbacks: this.callbacks,
            aiConfig: this.aiConfig,
            runtimeContext: this.runtimeContext,
            policy: this.policy,
          });
          if (commitResult.outcome === 'committed') {
            // 提交层按 clientMessageId 完成 replacement；随后清理 execution-side state。
            this.canonicalTimeline.commit(commitResult.messages, commitResult.outcome);
          } else {
            this.canonicalTimeline.clear(
              commitResult.outcome === 'fence_failed' ? 'fence_failed' : 'completed',
            );
          }
        } catch (error) {
          this.canonicalTimeline.clear('model_failure');
          throw error;
        }
        return;
      }
      this.canonicalTimeline.clear('model_failure');
      throw new ChatAgentRunFailedError(result);
    }

    await this.toolTimeline?.closeRun(result.terminalCode);
    if (this.waitingForExternalAction) {
      return;
    }
    if (result.terminalCode === 'CANCELLED_BY_USER' || result.terminalCode === 'SUPERSEDED') {
      await this.streamingReply?.markFailed();
      return;
    }
    this.assertActive();
    if (result.terminalCode === 'COMPLETED') {
      const finalStep = requireLastStep(result);
      if (this.streamingReply) {
        await this.streamingReply.finalizeFinalTurn(
          finalStep.stepIndex,
          this.requireModelTurn(finalStep.stepIndex)
        );
        return;
      }
      await this.requireLegacyPersistence().persistCompletedAssistantReply({
        sessionId: this.sessionId,
        response: toAIResponse(this.requireModelTurn(finalStep.stepIndex)),
        repository: this.repository,
        callbacks: this.callbacks,
        aiConfig: this.aiConfig,
        runtimeContext: this.runtimeContext,
        policy: this.policy,
      });
      return;
    }
    await this.streamingReply?.markFailed();
    throw new ChatAgentRunFailedError(result);
  }

  async failRun(result: AgentRunTerminalResult): Promise<void> {
    if (this.canonicalTimeline) {
      this.canonicalTimeline.closeRun(result.terminalCode);
      this.canonicalTimeline.clear('model_failure');
      return;
    }
    await this.toolTimeline?.closeRun(result.terminalCode);
    if (this.streamingReply) {
      await this.streamingReply.markFailed();
    }
  }

  private assertActive(): void {
    assertChatReplyNotAborted(this.runtimeContext);
  }

  private requireModelTurn(stepIndex: number): ChatAgentModelTurn {
    const turn = this.modelTurns.get(stepIndex);
    if (!turn) {
      throw new Error(`Chat Agent model turn ${stepIndex} was not projected`);
    }
    return turn;
  }

  private async persistAssistantPrelude(turn: ChatAgentModelTurn): Promise<void> {
    if (!turn.assistantText.trim() && !turn.reasoningText.trim()) {
      return;
    }

    await this.requireLegacyPersistence().persistAssistantPrelude({
      sessionId: this.sessionId,
      response: toAIResponse(turn),
      repository: this.repository,
      callbacks: {
        ...this.callbacks,
        onFinalReply: undefined,
        onReplyCommitted: undefined,
      },
      aiConfig: this.aiConfig,
      runtimeContext: this.runtimeContext,
      policy: this.policy,
    });
  }

  private async handleCanonicalEvent(event: AgentRunEvent): Promise<void> {
    const timeline = this.canonicalTimeline;
    if (!timeline) {
      throw new Error('canonical Agent timeline is not initialized');
    }
    if (event.type === 'model_turn_started') {
      timeline.startStep(event.stepIndex);
      return;
    }
    if (event.type === 'reasoning_delta') {
      timeline.appendDelta(event.stepIndex, 'reasoning', event.text);
      return;
    }
    if (event.type === 'assistant_text_delta') {
      timeline.appendDelta(event.stepIndex, 'assistant', event.text);
      return;
    }
    if (event.type === 'tool_call_proposed') {
      timeline.startToolStatus(event.stepIndex);
      return;
    }
    if (event.type === 'tool_call_started') {
      timeline.markToolStarted(event.stepIndex, event.toolCallId);
      return;
    }
    if (event.type === 'tool_call_completed') {
      timeline.completeToolCall(event.stepIndex, event.toolCallId, event.outcome);
      const item = timeline.buildImmediateOutputItem(event.stepIndex, event.toolCallId, {
        sessionId: this.sessionId, aiConfig: this.aiConfig, runtimeContext: this.runtimeContext,
        policy: this.policy, finalAssistantPolicy: this.finalAssistantPolicy, finalStepIndex: event.stepIndex,
      });
      if (item && this.timelineCommit!.commitAgentOutput) {
        const committed = await this.timelineCommit!.commitAgentOutput({
          sessionId: this.sessionId, response: toAIResponse(this.requireModelTurn(event.stepIndex)),
          item, repository: this.repository, callbacks: this.callbacks, aiConfig: this.aiConfig,
          runtimeContext: this.runtimeContext, policy: this.policy,
        });
        if (committed.outcome === 'fence_failed') throw new ChatReplyRunCancelledError('superseded');
        if (committed.outcome === 'committed') timeline.recordCommittedOutput(event.stepIndex, event.toolCallId, committed.messages);
      }
      if (timeline.shouldWaitForExternalAction()) {
        this.waitingForExternalAction = true;
        this.stopRuntime();
      }
    }
  }

  private requireTimelineCommitPort(): AgentTimelineCommitPort {
    if (!this.timelineCommit) {
      throw new Error('canonical Agent persistence must implement commitAgentTimeline');
    }
    return this.timelineCommit;
  }

  private requireLegacyPersistence(): AssistantTurnCommitPort {
    if (!this.legacyPersistence) {
      throw new Error('legacy Agent projection requires AssistantTurnCommitPort');
    }
    return this.legacyPersistence;
  }

}

function requireLastStep(
  result: AgentRunTerminalResult
): AgentRunTerminalResult['steps'][number] {
  const step = result.steps[result.steps.length - 1];
  if (!step) {
    throw new Error('Chat Agent run completed without a model step');
  }
  return step;
}

function toAIResponse(turn: ChatAgentModelTurn): AIResponse {
  return {
    success: true,
    text: turn.assistantText,
    reasoningText: turn.reasoningText,
    messageId: turn.messageId,
    totalTokens: turn.usage.totalTokens,
    promptTokens: turn.usage.promptTokens,
    completionTokens: turn.usage.completionTokens,
    cachedTokens: turn.usage.cachedTokens,
    isToolCall: turn.toolCalls.length > 0,
    toolCalls: turn.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    })),
  };
}
