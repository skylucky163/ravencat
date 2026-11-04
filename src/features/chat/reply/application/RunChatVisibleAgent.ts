/** 日程只提供触发上下文；展示、工具检查点、正式提交与交付复用普通聊天。 */
import { AgentRunEventQueue, type AgentRunEvent, type AgentRunModelGateway, type AgentRunResult,
  type AgentRuntimeRequest, type BaseAIClientAgentModelTurn } from '@platform/agentRuntime';
import type { AgentToolExecutionContext, ToolContext } from '@shared/aiTools';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { emitChatMessagesUpdated } from '../../messages/events/ChatEvents';
import { ChatAgentRunFailedError, ChatAgentRunProjector, type FinalAssistantPolicy } from '../agent/ChatAgentRunProjector';
import { ChatReplyRunCancelledError } from './ChatReplyAbort';
import { getChatReplyRuntimeDependencies } from './ChatReplyRuntimeDependencies';
import { buildMessageMetadata } from './ChatReplyMetadata';
import { formatMessageTime } from './ChatReplyUtils';
import { ChatTurnPresentation } from './ChatTurnPresentationRuntime';
import { createSingleTransactionTurnCommit } from './SingleTransactionTurnCommit';
import type { AIReplyConfig, AIReplyRuntimeContext } from './ChatReplyTypes';

export function listChatAgentActivityEvidence(runIds: readonly string[]) {
  return getChatMessageRuntimeDependencies().messages.listAgentActivityEvidence(runIds);
}

/** 仅结算旧版独立行动记录；共享回合与展示的恢复由原 owner 负责。 */
export async function interruptAbandonedChatAgentActivities(): Promise<void> {
  const sessions = await getChatMessageRuntimeDependencies().messages.interruptInactiveAgentActivities(
    [], new Date().toISOString(),
  );
  sessions.forEach(emitChatMessagesUpdated);
}

export interface ChatVisibleAgentModelGateway extends AgentRunModelGateway {
  takeCompletedTurn(stepIndex: number): BaseAIClientAgentModelTurn;
}

export interface PreparedChatVisibleAgent {
  request: Omit<AgentRuntimeRequest, 'runId' | 'eventSink' | 'modelGateway'>;
  modelGateway: ChatVisibleAgentModelGateway;
  createLegacyContext(context: AgentToolExecutionContext): ToolContext;
}

export interface RunChatVisibleAgentParams {
  sessionId: string;
  runId: string;
  aiConfig: AIReplyConfig;
  runtimeContext: AIReplyRuntimeContext;
  finalAssistantPolicy: FinalAssistantPolicy;
  signal?: AbortSignal;
  prepare(signal: AbortSignal): Promise<PreparedChatVisibleAgent>;
}

export async function runChatVisibleAgent(params: RunChatVisibleAgentParams): Promise<AgentRunResult> {
  const replyDependencies = getChatReplyRuntimeDependencies();
  const { messages: repository, turns } = getChatMessageRuntimeDependencies();
  // 只将展示绑定到调用方的持久 owner；读取期间的接管仍由 open/T3 的事务 fence 裁决。
  const run = await turns.getActiveRun(params.sessionId);
  if (!run || run.runId !== params.runId) throw new ChatReplyRunCancelledError('superseded');
  const cancellation = createProjectionCancellation(params.signal);
  const presentation = new ChatTurnPresentation(run, params.aiConfig.agentId, params.aiConfig.id, {
    signal: cancellation.signal, executionDeadlineAt: params.runtimeContext.executionDeadlineAt,
  });
  const persistence = createSingleTransactionTurnCommit(run, params.aiConfig.id, presentation);
  try { await presentation.start(); }
  catch (error) { cancellation.dispose(); throw error; }
  const recordActivity = params.finalAssistantPolicy === 'autonomous_reply';
  const recordTrigger = async () => {
    const now = new Date();
    await repository.upsertStatefulTimelineEntry({ previewText: null, message: {
      sessionId: params.sessionId, text: 'AI 日程触发', isMe: false, senderType: 'system',
      agentId: params.aiConfig.agentId, status: 'sent', isRead: true,
      clientMessageId: `agent_activity:${params.runId}:started`,
      // 触发来源提供历史定位锚点；终态和响应证据由共享回合与展示事实负责。
      turnRunId: params.runId, turnItemIndex: null,
      createdAt: now.toISOString(), time: formatMessageTime(now),
      metadataJson: JSON.stringify(buildMessageMetadata(params.aiConfig,
        { ...params.runtimeContext, replyRunId: params.runId },
        { type: 'agentActivity', source: 'chatAgentRun', phase: 'started' })),
    } });
    emitChatMessagesUpdated(params.sessionId);
  };
  try {
    if (recordActivity) await recordTrigger();
    const prepared = await params.prepare(cancellation.signal);
    persistence.configureSegmentDelivery!({ aiConfig: params.aiConfig, runtimeContext: params.runtimeContext,
      callbacks: { notifyUI: emitChatMessagesUpdated } });
    const projector = new ChatAgentRunProjector({
      sessionId: params.sessionId, repository, callbacks: { notifyUI: emitChatMessagesUpdated }, aiConfig: params.aiConfig,
      runtimeContext: { ...params.runtimeContext, abortSignal: cancellation.signal, replyRunId: params.runId },
      policy: {
        bubbleDeliveryMode: params.aiConfig.allowMultipleBubbles === false ? 'single-bubble' : 'multi-bubble',
        modelTransport: prepared.request.task.modelTransport, enableTools: prepared.request.task.allowedToolNames.length > 0,
      },
      projection: { kind: 'canonical', commit: {
        commitAgentTimeline: input => persistence.commitAgentTimeline!(input),
        commitAgentOutput: persistence.commitAgentOutput,
      } },
      stopRuntime: cancellation.stop, replyRunId: params.runId,
      finalAssistantPolicy: params.finalAssistantPolicy, timelineSink: presentation.sink,
    });
    const projectEvent = async (event: AgentRunEvent): Promise<void> => {
      presentation.observeRunEvent(event);
      if (event.type === 'model_turn_completed') {
        const turn = prepared.modelGateway.takeCompletedTurn(event.stepIndex);
        await projector.projectModelTurn(event.stepIndex, turn);
      } else await projector.handleEvent(event);
      if (event.type === 'tool_call_started') await presentation.recordToolStart();
    };
    const events = prepared.request.task.modelTransport === 'stream' ? new AgentRunEventQueue(projectEvent) : null;
    const result = await replyDependencies.agent.run({
      ...prepared.request, runId: params.runId, signal: cancellation.signal,
      eventSink: events ? events.enqueue.bind(events) : projectEvent,
      modelGateway: prepared.modelGateway, createLegacyContext: prepared.createLegacyContext,
    });
    await events?.drain();
    if (result.terminalCode === 'MODEL_REQUEST_FAILED') await projector.failRun(result);
    else {
      try { await projector.completeRun(result); }
      catch (error) {
        if (!(error instanceof ChatAgentRunFailedError && error.terminalCode === result.terminalCode)) throw error;
      }
    }
    // 非成功执行没有 T3；共享展示 owner 封闭已交付片段，不补发未完成正文。
    if (persistence.turnCommitOutcome!() !== 'committed') await presentation.stopFromHost(result.terminalCode);
    return result;
  } catch (error) {
    await presentation.stopFromHost(cancellation.signal.aborted ? 'CANCELLED_BY_USER' : 'EXECUTION_FAILED');
    throw error;
  } finally {
    try { await presentation.finish(); }
    finally { cancellation.dispose(); }
  }
}

function createProjectionCancellation(source: AbortSignal | undefined) {
  const controller = new AbortController();
  const forward = () => controller.abort(source?.reason);
  if (source?.aborted) forward();
  else source?.addEventListener('abort', forward, { once: true });
  return { signal: controller.signal, stop: () => controller.abort('CANCELLED_BY_USER'),
    dispose: () => source?.removeEventListener('abort', forward) };
}
