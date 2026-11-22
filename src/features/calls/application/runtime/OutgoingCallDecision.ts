/** 请求并解析 AI 对用户去电的接听或拒接决策。 */

import { createAIClient, getErrorDisplayInfo, type ChatMessage } from '@platform/ai';
import { ToolContext } from '@shared/aiTools';
import { DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT } from '@shared/prompt';
import type { CallAIConfig } from '../../domain/CallAIConfig';
import type { AIOutgoingCallDecision } from './CallRuntimeTypes';
import { buildOutgoingCallDecisionBlocks } from '../CallPromptBlocks';
import { getCallRuntimeDependencies } from './CallRuntimeDependencies';
import { parseOutgoingCallDecision } from './OutgoingCallDecisionParser';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

export async function requestOutgoingCallDecision(params: {
  aiConfig: CallAIConfig;
  chatSessionId: string;
  callId: string;
  signal?: AbortSignal;
}): Promise<
  | { success: true; decision: AIOutgoingCallDecision }
  | { success: false; errorMessage: string }
> {
  const runtime = getCallRuntimeDependencies();
  const { aiConfig, chatSessionId, callId } = params;
  // 去电决策是单聊场景的延续：与普通消息共用同一套聊天上下文
  // （人设、用户身份、附加提示词、全部摘要与未总结原文），只追加决策场景与控制标记。
  const recentWindowLimit =
    aiConfig.privateContextPrimaryLimit || DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT;
  const toolContext = new ToolContext({
    aiConfig,
    sessionId: chatSessionId,
    triggerSource: 'call_outgoing_decision',
    triggerReason: 'outgoing_call_decision',
    relatedEntityType: 'call',
    relatedEntityId: callId,
    capabilities: [],
    repositories: {
      protocol: runtime.repositories.protocol,
      moment: runtime.repositories.moment,
      profile: runtime.repositories.profile,
      ledger: runtime.repositories.ledger,
    },
  });
  const promptPack = await runtime.assembleChatPromptPack({
    sessionId: chatSessionId,
    currentInput: '用户现在正在向你发起一次视频电话。',
    aiConfig,
    toolContext,
    runtimeContext: {
      triggerSource: 'call_outgoing_decision',
      triggerReason: 'outgoing_call_decision',
      relatedEntityType: 'call',
      relatedEntityId: callId,
      capabilities: [],
      recentWindowLimit,
      // 当前输入是拨号动作而不是时间线里的用户消息，不得裁掉末尾真实用户消息。
      forceAppendUserText: true,
    },
    recentWindowLimit,
    additionalBlocks: buildOutgoingCallDecisionBlocks(),
  });
  const client = createAIClient({
    baseURL: aiConfig.apiBaseUrl,
    apiKey: aiConfig.apiKey,
    model: aiConfig.model,
    temperature: aiConfig.temperature,
    topP: aiConfig.topP,
    disableThinking: aiConfig.disableThinking,
    reasoningEffort: aiConfig.reasoningEffort,
    maxTokens: aiConfig.maxTokens,
    systemPrompt: promptPack.systemPrompt,
  });
  const messages: ChatMessage[] = promptPack.modelMessages;
  throwIfAbortSignalAborted(params.signal);
  const response = await client.chat(messages, {
    signal: params.signal,
    includeSystemPrompt: true,
    allowReasoningLengthRetry: false,
  });
  throwIfAbortSignalAborted(params.signal);

  if (!response.success) {
    return {
      success: false,
      errorMessage: `接听决策失败（${aiConfig.model}）：${getErrorDisplayInfo(response.error || '模型未提供错误原因', { includeDetails: true }).message}`,
    };
  }

  let decision: AIOutgoingCallDecision;
  try {
    decision = parseOutgoingCallDecision(response.text);
  } catch (error) {
    console.warn('[CallDecision] 接听控制标记无效', { model: aiConfig.model, error: (error as Error).message });
    return { success: false, errorMessage: '这次电话没有接通，请稍后再试。' };
  }
  console.info('[CallDecision] outgoing call decision', {
    aiId: aiConfig.id,
    model: aiConfig.model,
    decision: decision.decision,
    rawText: response.text,
  });
  return { success: true, decision };
}
