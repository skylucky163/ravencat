/** 编排 Chat AI 回复从运行时准备、模型调用到消息提交与失败处理的完整流程。 */
import { createAIClient, getErrorDisplayInfo } from '@platform/ai';
import type { IMessageRepository } from '../../messages/domain/MessageRepository';
import {
  getChatReplyRuntimeDependencies,
  type ChatReplyRuntimeDependencies,
} from './ChatReplyRuntimeDependencies';
import type { AssistantTurnCommitPort } from './AssistantTurnCommit';
import {
  notifyReplyFailed,
  saveErrorMessage,
} from './ChatReplyErrors';
import {
  assemblePromptPackForRuntimeContext,
  buildRuntimeAIToolsConfig,
  createRuntimeToolContext,
} from './ChatReplyRuntime';
import { applyRuntimeModelInput } from './ChatReplyUtils';
import {
  assertChatReplyNotAborted,
  isChatReplyRunCancellationError,
  shouldSuppressReplyErrorPersistenceAsync,
} from './ChatReplyAbort';
import { resolveAIReplyPolicy } from './ReplyPolicy';
import { resolveMemoryParticipationMode } from './MemoryParticipationPolicy';
import { runChatAgentReplyFlow } from '../agent/ChatAgentReplyFlow';
import { ChatAgentModelRequestError } from '../agent/ChatAgentModelGateway';
import { ChatAgentRunFailedError } from '../agent/ChatAgentRunProjector';
import type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  ProcessAIReplyCallbacks,
} from './ChatReplyTypes';
import { applyHostModelRunToolExposure } from '@shared/aiTools';
import type { PromptPackScenario } from '@shared/prompt';

export type {
  AIReplyConfig,
  AIReplyRuntimeContext,
  AIResponse,
  ToolCall,
  ProcessAIReplyCallbacks,
  AIReplySegmentPayload,
  AIReplyFinalSegment,
  AIReplyFinalPayload,
  AIReplyFailedPayload,
} from './ChatReplyTypes';

export async function processAIReply(
  sessionId: string,
  userText: string,
  aiConfig: AIReplyConfig,
  userMessageId: number,
  repo: IMessageRepository,
  callbacks: ProcessAIReplyCallbacks = {},
  runtimeContext: AIReplyRuntimeContext = {},
  persistence: AssistantTurnCommitPort
): Promise<void> {
  const memoryParticipation = resolveMemoryParticipationMode(runtimeContext, userMessageId);
  runtimeContext = {
    ...runtimeContext,
    memoryParticipation,
  };

  try {
    const chatRuntimeDependencies = getChatReplyRuntimeDependencies();
    if (await persistBlockedStateIfNeeded(
      sessionId,
      aiConfig,
      repo,
      callbacks,
      runtimeContext,
      persistence,
      chatRuntimeDependencies.assistantDirectory,
    )) {
      return;
    }

    assertChatReplyNotAborted(runtimeContext);

    const toolRuntimeContext = aiConfig.enableTools
      ? await chatRuntimeDependencies.tools.resolveRuntimeContext(aiConfig.id)
      : {};
    const candidateBuiltInToolNames = aiConfig.enableTools
      ? await chatRuntimeDependencies.tools.resolveAllowedNames(aiConfig.id)
      : [];
    const mcpExposure = aiConfig.enableTools
      ? await chatRuntimeDependencies.tools.resolveMcpExposure(aiConfig.id)
      : { allowedToolNames: [], services: [] };
    const candidateMcpToolNames = mcpExposure.allowedToolNames;
    runtimeContext = {
      ...runtimeContext,
      ...toolRuntimeContext,
      capabilities: withCurrentTurnVisualCapability(runtimeContext),
      allowedToolNames: [...candidateBuiltInToolNames, ...candidateMcpToolNames],
      mcpServices: mcpExposure.services,
    };

    // 在 Prompt 组装前固定一次“可用且已授权”的工具名集合；Prompt 与后续 Agent
    // Flow 都只消费这份结果，避免下游再次从 AI config 或注册表重算。
    const effectiveToolNames = aiConfig.enableTools
      ? [
          ...chatRuntimeDependencies.tools.getRuntimeAllowedNames(
            buildRuntimeAIToolsConfig(aiConfig, runtimeContext),
          ),
          ...candidateMcpToolNames,
        ]
      : [];
    const runPreparation = await chatRuntimeDependencies.runPreparation.prepare({
      scenario: resolveHostRunScenario(runtimeContext),
      currentAiId: aiConfig.id,
      isHostAI: aiConfig.isHostAI === true,
      persistentAllowedToolNames: candidateBuiltInToolNames,
    });
    const preparedToolNames = applyHostModelRunToolExposure(
      effectiveToolNames,
      runPreparation,
    );
    runtimeContext = {
      ...runtimeContext,
      promptBlocks: [
        ...(runtimeContext.promptBlocks ?? []),
        ...runPreparation.additionalPromptBlocks,
      ],
      allowedToolNames: preparedToolNames,
    };
    const policy = resolveAIReplyPolicy(aiConfig, runtimeContext);
    runtimeContext = {
      ...runtimeContext,
      allowedToolNames: policy.enableTools ? preparedToolNames : [],
    };

    const runtimeToolContext = createRuntimeToolContext(
      sessionId,
      aiConfig,
      persistence.decorateCommitRepository?.(repo) ?? repo,
      callbacks,
      runtimeContext
    );
    const promptPack = await assemblePromptPackForRuntimeContext(
      sessionId,
      userText,
      aiConfig,
      repo,
      runtimeToolContext,
      runtimeContext
    );

    assertChatReplyNotAborted(runtimeContext);

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
    const requestMessages = applyRuntimeModelInput(
      promptPack.modelMessages,
      runtimeContext.batchModelInput,
      runtimeContext.turnInputMessages,
      promptPack.messageTimestampsEnabled,
    );
    persistence.configureSegmentDelivery?.({ aiConfig, runtimeContext, callbacks });
    const agentReplyResult = await runChatAgentReplyFlow({
      sessionId,
      originalUserText: userText,
      requestMessages,
      toolInstructionsSlot: promptPack.toolInstructionsSlot,
      aiConfig,
      repository: repo,
      callbacks,
      runtimeContext,
      client,
      policy,
      persistence,
    });

    if (agentReplyResult.completed) {
      return;
    }

    // 流式请求只有在 Agent Runtime 确认尚未观察到输出、工具提案或工具执行时，
    // 才能安全退回 complete；该状态由唯一 Flow 负责判断。
    await runChatAgentReplyFlow({
      sessionId,
      originalUserText: userText,
      requestMessages,
      toolInstructionsSlot: promptPack.toolInstructionsSlot,
      aiConfig,
      repository: repo,
      callbacks,
      runtimeContext,
      client,
      policy: {
        ...policy,
        modelTransport: 'complete',
      },
      persistence,
    });
  } catch (error) {
    if (isChatReplyRunCancellationError(error)) {
      return;
    }
    if (runtimeContext.allowSilentReply) throw error;

    // 模型请求失败走既有错误气泡与失败收尾，不升级为开发版 error 提示；
    // 内部非预期异常仍保留 error 级别，避免掩盖程序问题。
    if (error instanceof ChatAgentModelRequestError) {
      console.warn('[processAIReply] Model request failed:', error);
    } else {
      console.error('[processAIReply] Process AI reply error:', error);
    }
    await persistReplyError({
      sessionId,
      errorMessage: resolveAIReplyErrorMessage(error),
      aiConfig,
      repo,
      callbacks,
      runtimeContext,
      persistence,
    });
  }
}

function resolveHostRunScenario(runtimeContext: AIReplyRuntimeContext): PromptPackScenario {
  if (runtimeContext.groupChat) return 'chat.group_member_reply';
  if (runtimeContext.triggerSource === 'call_outgoing_decision') return 'call.outgoing_decision';
  if (runtimeContext.triggerSource === 'call') return 'call.live_reply';
  if (runtimeContext.triggerSource === 'ledger') return 'ledger.reply';
  return 'chat.private_reply';
}

function resolveAIReplyErrorMessage(error: unknown): string {
  if (error instanceof ChatAgentModelRequestError) {
    // 客户端已保留并脱敏 Provider 错误；聊天需展示具体原因，便于用户调整模型或配置。
    return getErrorDisplayInfo(error, { includeDetails: true }).message;
  }
  if (error instanceof ChatAgentRunFailedError) {
    return `处理 AI 回复时发生错误\n\n${error.diagnosticText}`;
  }
  return '处理 AI 回复时发生错误';
}

function withCurrentTurnVisualCapability(runtimeContext: AIReplyRuntimeContext): string[] | undefined {
  const capabilities = runtimeContext.capabilities ? [...runtimeContext.capabilities] : [];
  const input = runtimeContext.batchModelInput;
  const hasVisualInput = Array.isArray(input) && input.some((part) => (
    part.type === 'image_url'
    || (part.type === 'text' && part.text.includes('[视觉输入状态：'))
  ));
  if (hasVisualInput && !capabilities.includes('vision.current_turn')) {
    capabilities.push('vision.current_turn');
  }
  return capabilities.length ? capabilities : undefined;
}

async function persistBlockedStateIfNeeded(
  sessionId: string,
  aiConfig: AIReplyConfig,
  repo: IMessageRepository,
  callbacks: ProcessAIReplyCallbacks,
  runtimeContext: AIReplyRuntimeContext,
  persistence: AssistantTurnCommitPort,
  assistantDirectory: ChatReplyRuntimeDependencies['assistantDirectory'],
): Promise<boolean> {
  const blockedState = await assistantDirectory.getBlockState(aiConfig.id);
  if (!aiConfig.isBlocked && !blockedState.isBlocked) {
    return false;
  }

  await persistReplyError({
    sessionId,
    errorMessage: '该 AI 当前已被主理 AI 拉黑，无法继续回复',
    aiConfig,
    repo,
    callbacks,
    runtimeContext,
    persistence,
  });
  return true;
}

async function persistReplyError(params: {
  sessionId: string;
  errorMessage: string;
  aiConfig: AIReplyConfig;
  repo: IMessageRepository;
  callbacks: ProcessAIReplyCallbacks;
  runtimeContext: AIReplyRuntimeContext;
  persistence: AssistantTurnCommitPort;
}): Promise<void> {
  const {
    sessionId,
    errorMessage,
    aiConfig,
    repo,
    callbacks,
    runtimeContext,
    persistence,
  } = params;

  // signal 已 abort 或 run 已失去提交资格（本地 settled 或持久 fence 裁决）：
  // 跳过错误气泡落库与失败回调，安静结束。
  if (await shouldSuppressReplyErrorPersistenceAsync(runtimeContext, persistence)) {
    return;
  }

  // 重写错误交给宿主收口；错误说明不属于需要封存的正文。
  if (runtimeContext.isRegeneration) throw new Error(errorMessage);

  // 错误气泡与正常气泡走同一提交 fence：探针之后、INSERT 之前被换代时，
  // 事务内 fence 抛取消错误——安静结束，不写属于旧 plan 的错误气泡。
  const errorRepository = persistence.decorateCommitRepository?.(repo) ?? repo;
  try {
    const savedErrorMessage = await saveErrorMessage(sessionId, errorMessage, errorRepository, callbacks.notifyUI, {
      agentId: aiConfig.agentId,
      displayName: aiConfig.name,
      runtimeContext,
    });
    notifyReplyFailed(
      callbacks,
      sessionId,
      errorMessage,
      savedErrorMessage,
      runtimeContext.correlationId || runtimeContext.replyRunId,
    );
  } catch (error) {
    if (isChatReplyRunCancellationError(error)) {
      return;
    }
    throw error;
  }
}
