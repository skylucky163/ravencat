/** 通话复用统一 Agent 循环，Calls 只拥有逐句语音投影与通话事实提交。 */

import type { CallEvent } from '../../domain/CallEvent';
import type { CallInputAudio } from '../../domain/CallHistory';
import type { CallAIConfig } from '../../domain/CallAIConfig';
import { createAIClient, getErrorDisplayInfo } from '@platform/ai';
import { BaseAIClientAgentModelGateway } from '@platform/agentRuntime';
import { ToolContext } from '@shared/aiTools';
import { DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT } from '@shared/prompt';
import { appendAISpeechText, appendUserSpeechText } from '../events/AppendCallTranscriptEvent';
import { appendCallErrorEvent } from '../events/AppendCallSystemEvent';
import { getCallRuntimeDependencies } from './CallRuntimeDependencies';
import { CallReplyRunCancelledError, isCallReplyCancellationError } from './CallReplyRunState';
import { createCallSpeechSentenceStream } from './CallSpeechSentenceStream';
import { buildCallLivePromptBlocks } from '../CallPromptBlocks';
import { resolveTextToSpeechModel, readSpeechMetadata, getSpeechTextGuidance } from '@features/speech';
import type { CallSentenceSpeech } from './CallSpeechSentenceStream';

export type ProcessCallAIReplyResult =
  | {
      status: 'completed';
      userEvent: CallEvent;
      aiEvent: CallEvent;
      text: string;
      callEnded: boolean;
    }
  | {
      status: 'failed';
      userEvent: CallEvent | null;
      errorMessage: string;
    }
  | {
      status: 'cancelled';
      userEvent: CallEvent | null;
    };

export async function processCallAIReply(params: {
  callId: string;
  runId: string;
  userText: string;
  userAudio?: Promise<CallInputAudio | null>;
  onUserTextCommitted?: () => void;
  aiConfig: CallAIConfig;
  signal: AbortSignal;
  onToolExecutionChanged?: (active: boolean) => void;
  /** 正文供字幕和提交，合成输入与模型快照供同一播放队列消费。 */
  onSpeechSentence?: (sentence: string, speech: CallSentenceSpeech) => void;
}): Promise<ProcessCallAIReplyResult> {
  const text = params.userText.trim();
  if (!text) {
    throw new Error('通话文本不能为空');
  }

  const call = await getCallRuntimeDependencies().repositories.calls.getSessionById(params.callId);
  if (!call) {
    throw new Error(`Call ${params.callId} not found`);
  }
  if (call.state !== 'active') {
    throw new Error('当前通话不在接通状态');
  }

  const userEvent = await appendUserSpeechText({
    callId: call.id,
    text,
    audio: params.userAudio,
  });
  params.onUserTextCommitted?.();

  let failureStage = '通话回复准备';
  try {
    const runtimeDependencies = getCallRuntimeDependencies();
    const speechModel = await resolveTextToSpeechModel({ assistantId: params.aiConfig.id, consumer: 'call' });
    const speechTextGuidance = speechModel
      ? getSpeechTextGuidance(readSpeechMetadata(speechModel.metadataJson).provider, speechModel.model, false)
      : undefined;
    const callAIConfig: CallAIConfig = {
      ...params.aiConfig,
      allowMultipleBubbles: false,
    };
    // 通话沿用单聊的摘要与完整未总结原文；主条数由 Chat 用作摘要触发门槛。
    const recentWindowLimit =
      callAIConfig.privateContextPrimaryLimit || DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT;
    const toolContext = new ToolContext({
      aiConfig: callAIConfig,
      sessionId: call.chatSessionId,
      abortSignal: params.signal,
      triggerSource: 'call',
      triggerReason: 'call_user_text',
      relatedEntityType: 'call',
      relatedEntityId: call.id,
      capabilities: ['call.reply', 'call.lookAtUser'],
      sharedState: { replyRunId: params.runId },
      repositories: {
        protocol: runtimeDependencies.repositories.protocol,
        moment: runtimeDependencies.repositories.moment,
        profile: runtimeDependencies.repositories.profile,
        ledger: runtimeDependencies.repositories.ledger,
      },
    });
    const exposure = await runtimeDependencies.agent.prepareTools(callAIConfig);
    const promptPack = await runtimeDependencies.assembleChatPromptPack({
      sessionId: call.chatSessionId,
      currentInput: text,
      aiConfig: callAIConfig,
      toolContext,
      runtimeContext: {
        triggerSource: 'call',
        triggerReason: 'call_user_text',
        relatedEntityType: 'call',
        relatedEntityId: call.id,
        capabilities: ['call.reply', 'call.lookAtUser'],
        recentWindowLimit,
        currentCallEventId: userEvent.id,
        memoryParticipation: 'read_write',
        forceAppendUserText: true,
      },
      recentWindowLimit,
      ...exposure,
      additionalBlocks: [...buildCallLivePromptBlocks(call, speechTextGuidance), ...exposure.additionalPromptBlocks],
    });

    const client = createAIClient({
      baseURL: callAIConfig.apiBaseUrl,
      apiKey: callAIConfig.apiKey,
      model: callAIConfig.model,
      temperature: callAIConfig.temperature,
      topP: callAIConfig.topP,
      disableThinking: callAIConfig.disableThinking,
      reasoningEffort: callAIConfig.reasoningEffort,
      maxTokens: callAIConfig.maxTokens,
      systemPrompt: promptPack.systemPrompt,
    });
    const modelGateway = new BaseAIClientAgentModelGateway({
      client,
      initialMessages: promptPack.modelMessages,
      toolInstructionsSlot: promptPack.toolInstructionsSlot,
      diagnosticContext: { runId: params.runId, sessionId: call.chatSessionId },
    });
    const speechStream = createCallSpeechSentenceStream((sentence, speech) => {
      params.onSpeechSentence?.(sentence, speech);
    }, speechModel);
    let streamedTextLength = 0;
    failureStage = '模型回复';
    const result = await runtimeDependencies.agent.run({
      runId: params.runId,
      task: {
        id: `call_task_${params.runId}`,
        type: 'call_reply',
        source: 'internal_feature',
        goal: text,
        assistantId: callAIConfig.id,
        sessionId: call.chatSessionId,
        allowedToolNames: exposure.allowedToolNames,
        modelTransport: 'stream',
        maxSteps: 10,
        maxToolCalls: 30,
        maxToolCallsPerStep: 3,
        createdAt: new Date().toISOString(),
      },
      initialHistory: [],
      signal: params.signal,
      modelGateway,
      createLegacyContext: (executionContext) => new ToolContext({
        ...toolContext,
        abortSignal: executionContext.abortSignal,
      }),
      eventSink: (event) => {
        throwIfAborted(call.id, params.signal);
        if (event.type === 'model_turn_started') {
          streamedTextLength = 0;
          // 模型续轮各自拥有结束标记边界，不把不同回合的半句拼在一起。
          speechStream.pushSegment('');
        } else if (event.type === 'assistant_text_delta') {
          streamedTextLength += event.text.length;
          failureStage = '回复语音文本解析';
          speechStream.push(event.text);
          failureStage = '模型回复';
        } else if (event.type === 'model_turn_completed') {
          const turn = modelGateway.takeCompletedTurn(event.stepIndex);
          // Gateway 已保证最终正文延续 delta；只补未流出的尾部，避免重复朗读。
          failureStage = '回复语音文本解析';
          speechStream.push(turn.assistantText.slice(streamedTextLength));
          speechStream.flush();
          failureStage = '模型回复';
          if (!turn.assistantText.trim() && turn.toolCalls.length === 0) {
            throw new Error(turn.finishReason === 'length'
              ? '模型已耗尽输出额度，但没有返回可朗读正文；请检查最大输出 token 设置。'
              : turn.finishReason === 'content_filter'
                ? '服务商因内容审核未返回可朗读正文（finish_reason=content_filter）。'
                : `模型没有返回可朗读正文（finish_reason=${turn.finishReason}，思考字符数=${turn.reasoningText.length}）。`);
          }
        } else if (event.type === 'tool_call_started') {
          params.onToolExecutionChanged?.(true);
        } else if (event.type === 'tool_call_completed') {
          params.onToolExecutionChanged?.(false);
        }
      },
    });
    if (result.status === 'cancelled') {
      return { status: 'cancelled', userEvent };
    }
    if (result.status !== 'completed') {
      throw result.terminalCode === 'MODEL_REQUEST_FAILED'
        ? modelGateway.requireModelRequestError()
        : result.error ?? new Error(`通话 Agent 执行失败：${result.terminalCode}`);
    }

    await assertCallReplyCanCommit(call.id, params.signal);
    speechStream.flush();

    const fullText = speechStream.getSentences().join('\n');
    const aiEvent = await appendAISpeechText({
      callId: call.id,
      text: fullText,
    });

    return {
      status: 'completed',
      userEvent,
      aiEvent,
      text: aiEvent.text || '',
      callEnded: speechStream.shouldEndCall(),
    };
  } catch (error) {
    if (params.signal.aborted || isCallReplyCancellationError(error)) {
      return {
        status: 'cancelled',
        userEvent,
      };
    }
    const detail = getErrorDisplayInfo(error instanceof Error ? error : String(error), { includeDetails: true }).message;
    const errorMessage = `${failureStage}失败（${params.aiConfig.model}）：${detail}`;
    await appendCallErrorEvent({
      callId: call.id,
      text: errorMessage,
      payload: { type: 'replyFailure', stage: failureStage, model: params.aiConfig.model, runId: params.runId },
    });
    return {
      status: 'failed',
      userEvent,
      errorMessage,
    };
  }
}

async function assertCallReplyCanCommit(callId: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(callId, signal);
  const currentCall = await getCallRuntimeDependencies().repositories.calls.getSessionById(callId);
  throwIfAborted(callId, signal);
  if (!currentCall || currentCall.state !== 'active') {
    throw new CallReplyRunCancelledError(callId);
  }
}

function throwIfAborted(callId: string, signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CallReplyRunCancelledError(callId);
  }
}
