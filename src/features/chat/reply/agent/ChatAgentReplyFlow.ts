/** 通过唯一 Agent Runtime 执行 Chat 回复，transport 只决定模型传输与事件投影策略。 */
import type { BaseAIClient } from '@platform/ai';
import type { PromptToolInstructionsSlot } from '@shared/prompt';
import {
  AgentRunEventQueue,
  type AgentRunEvent,
  type AgentRunTerminalResult,
} from '@platform/agentRuntime';
import { getChatReplyRuntimeDependencies } from '../application/ChatReplyRuntimeDependencies';
import { assertChatReplyNotAborted } from '../application/ChatReplyAbort';
import type { AssistantTurnCommitPort } from '../application/AssistantTurnCommit';
import { createRuntimeToolContext } from '../application/ChatReplyRuntime';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  ChatContextMessage,
  ProcessAIReplyCallbacks,
} from '../application/ChatReplyTypes';
import { buildLogicalMessageId } from '../application/ChatReplyUtils';
import type { AIReplyPolicy } from '../application/ReplyPolicy';
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import {
  createAgentTransientTimelineSink,
} from '../../messages/application/AgentTransientTimeline';
import { ChatAgentModelGateway } from './ChatAgentModelGateway';
import { ChatAgentRunProjector } from './ChatAgentRunProjector';
import { createChatAgentTask } from './ChatAgentTask';
import type { AgentTimelineTransientSink } from './ChatAgentTimeline';

export interface RunChatAgentReplyFlowParams {
  sessionId: string;
  originalUserText: string;
  requestMessages: ChatContextMessage[];
  toolInstructionsSlot?: PromptToolInstructionsSlot;
  aiConfig: AIReplyConfig;
  repository: IMessageRepository;
  callbacks?: ProcessAIReplyCallbacks;
  runtimeContext?: AIReplyRuntimeContext;
  policy: AIReplyPolicy;
  client: BaseAIClient;
  /** 最终落库策略（Legacy 逐泡 / canonical T3 单事务），由 processAIReply 显式传入。 */
  persistence: AssistantTurnCommitPort;
  /** canonical transient timeline 的 UI/cache 接缝；Legacy 不消费。 */
  timelineSink?: AgentTimelineTransientSink;
}

export interface ChatAgentReplyFlowResult {
  completed: boolean;
}

export async function runChatAgentReplyFlow({
  sessionId,
  originalUserText,
  requestMessages,
  toolInstructionsSlot,
  aiConfig,
  repository,
  callbacks = {},
  runtimeContext: providedRuntimeContext = {},
  policy,
  client,
  persistence,
  timelineSink: providedTimelineSink,
}: RunChatAgentReplyFlowParams): Promise<ChatAgentReplyFlowResult> {
  // 主动回复也可能由此生成运行编号；执行、工具状态和正文必须消费同一份身份。
  const runtimeContext = {
    ...providedRuntimeContext,
    replyRunId: providedRuntimeContext.replyRunId || buildLogicalMessageId(),
  };
  assertChatReplyNotAborted(runtimeContext);
  const modelTransport = policy.modelTransport;
  const runId = runtimeContext.replyRunId;
  const timelineSink = persistence.persistsIntermediates === false
    ? providedTimelineSink ?? persistence.timelineSink ?? createAgentTransientTimelineSink({
        sessionId,
        agentId: aiConfig.agentId,
      })
    : providedTimelineSink;
  const linkedCancellation = createLinkedCancellation(runtimeContext.abortSignal);
  const dependencies = getChatReplyRuntimeDependencies();
  const modelGateway = new ChatAgentModelGateway({
    client,
    initialMessages: requestMessages,
    toolInstructionsSlot,
    diagnosticContext: {
      sessionId,
      runId,
      correlationId: runtimeContext.correlationId,
    },
  });
  const task = createChatAgentTask({
    type: runtimeContext.groupChat ? 'group_chat_reply' : 'chat_reply',
    runId,
    goal: modelTransport === 'stream'
      ? resolveChatGoal(requestMessages)
      : originalUserText,
    assistantId: aiConfig.id,
    sessionId,
    allowedToolNames: policy.enableTools ? runtimeContext.allowedToolNames || [] : [],
    modelTransport,
    createdAt: new Date().toISOString(),
  });
  const projector = new ChatAgentRunProjector({
    sessionId,
    repository,
    callbacks,
    aiConfig,
    runtimeContext,
    policy,
    projection: persistence.persistsIntermediates === false
      ? { kind: 'canonical', commit: requireAgentTimelineCommitPort(persistence) }
      : { kind: 'legacy', persistence },
    stopRuntime: linkedCancellation.stop,
    replyRunId: runId,
    finalAssistantPolicy: 'commit_as_reply',
    timelineSink,
  });

  let hasToolCall = false;
  let hasExecutedTool = false;
  const projectEvent = async (event: AgentRunEvent): Promise<void> => {
    persistence.observeRunEvent?.(event);
    observeEvent(event);
    if (event.type === 'model_turn_completed') {
      await projector.projectModelTurn(
        event.stepIndex,
        modelGateway.takeCompletedTurn(event.stepIndex)
      );
      return;
    }
    await projector.handleEvent(event);
    if (event.type === 'tool_call_started') await persistence.recordToolExecutionStarted?.();
  };
  const eventQueue = modelTransport === 'stream'
    ? new AgentRunEventQueue(projectEvent)
    : null;

  try {
    const result = await dependencies.agent.run({
      runId,
      task,
      openToolPackageIds: persistence.readOpenToolPackageIds
        ? await persistence.readOpenToolPackageIds()
        : [],
      initialHistory: [],
      signal: linkedCancellation.signal,
      eventSink: eventQueue ? eventQueue.enqueue.bind(eventQueue) : projectEvent,
      modelGateway,
      createLegacyContext: (executionContext) => createRuntimeToolContext(
        sessionId,
        aiConfig,
        persistence.decorateCommitRepository?.(repository) ?? repository,
        callbacks,
        runtimeContext,
        executionContext.abortSignal,
      ),
    });
    await eventQueue?.drain();

    if (modelTransport === 'stream' && canFallbackToComplete(
      result,
      modelGateway.hasObservedModelOutput(),
      hasToolCall,
      hasExecutedTool
    )) {
      return { completed: false };
    }
    if (result.terminalCode === 'MODEL_REQUEST_FAILED') {
      await projector.failRun(result);
      throw modelGateway.requireModelRequestError();
    }
    await projector.completeRun(result);
    return { completed: true };
  } finally {
    linkedCancellation.dispose();
  }

  function observeEvent(event: AgentRunEvent): void {
    if (event.type === 'tool_call_proposed') {
      hasToolCall = true;
      return;
    }
    if (event.type === 'tool_call_started') {
      hasToolCall = true;
      hasExecutedTool = true;
      return;
    }
    if (event.type === 'tool_call_completed') {
      hasToolCall = true;
    }
  }
}

function requireAgentTimelineCommitPort(
  persistence: AssistantTurnCommitPort,
): import('./ChatAgentRunProjector').AgentTimelineCommitPort {
  if (typeof persistence.commitAgentTimeline !== 'function') {
    throw new Error('canonical Chat Agent persistence must implement commitAgentTimeline');
  }
  return {
    commitAgentTimeline: (params) => persistence.commitAgentTimeline!(params),
    commitAgentOutput: persistence.commitAgentOutput,
  };
}

export function canFallbackToComplete(
  result: AgentRunTerminalResult,
  hasObservedModelOutput: boolean,
  hasToolCall: boolean,
  hasExecutedTool: boolean
): boolean {
  if (result.terminalCode !== 'MODEL_REQUEST_FAILED' && result.terminalCode !== 'MODEL_PROTOCOL_ERROR') {
    return false;
  }
  return !hasObservedModelOutput
    && !hasToolCall
    && !hasExecutedTool;
}

export function createLinkedCancellation(source: AbortSignal | undefined): {
  signal: AbortSignal;
  stop: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const forwardCancellation = () => {
    controller.abort(source?.reason);
  };
  if (source?.aborted) {
    forwardCancellation();
  } else {
    source?.addEventListener('abort', forwardCancellation, { once: true });
  }

  return {
    signal: controller.signal,
    stop: () => controller.abort('CANCELLED_BY_USER'),
    dispose: () => source?.removeEventListener('abort', forwardCancellation),
  };
}

function resolveChatGoal(messages: readonly ChatContextMessage[]): string {
  const userMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!userMessage) {
    throw new Error('Chat Agent streaming task requires a user message');
  }
  return typeof userMessage.content === 'string'
    ? userMessage.content
    : JSON.stringify(userMessage.content);
}
