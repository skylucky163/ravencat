/** 自主唤醒复用普通单聊，Chat 保存过程并提交最终正文或静默结果。 */

import type { AIProfile } from '@features/assistants';
import { createAIClient } from '@platform/ai';
import {
  BaseAIClientAgentModelGateway,
  type AgentRunResult,
} from '@platform/agentRuntime';
import {
  applyHostModelRunToolExposure,
  type AgentTask,
  type AgentTaskSource,
  type AIToolsConfig,
} from '@shared/aiTools';
import type {
  PromptPackAIConfig,
  PromptPackBlock,
  PromptScenarioId,
} from '@shared/prompt';
import { getCompanionRuntimeDependencies } from './CompanionRuntimeDependencies';

const AUTONOMOUS_TASK_BUDGET = {
  maxSteps: 10,
  maxToolCalls: 30,
  maxToolCallsPerStep: 3,
} as const;

export interface RunHostAutonomousAgentInput {
  runId: string;
  sessionId: string;
  ownerAIId: string;
  triggeredAt: string;
  correlationId: string;
  scenarioId: PromptScenarioId;
  triggerSource: string;
  triggerReason: string;
  relatedEntityType: string;
  relatedEntityId: string;
  taskGoal: string;
  taskSource: AgentTaskSource;
  additionalPromptBlocks: PromptPackBlock[];
  signal?: AbortSignal;
}

/**
 * 公共 Host autonomous bootstrap：assistant lookup、canonical session、latest
 * 单聊摘要与原文、MCP/tool exposure、runPreparation、AI config、model gateway、task
 * budget 与 runChatVisibleAgent。AI 日程只提供触发事实，不复制正常单聊执行链。
 */
export async function runHostAutonomousAgent(
  input: RunHostAutonomousAgentInput,
): Promise<AgentRunResult> {
  const dependencies = getCompanionRuntimeDependencies();
  const assistant = await dependencies.repositories.assistants.getById(input.ownerAIId);
  if (!assistant) {
    throw new Error(`autonomous owner ${input.ownerAIId} 不存在`);
  }

  const aiConfig = toAutonomousAIConfig(assistant);
  return dependencies.chat.runVisibleAgent({
    sessionId: input.sessionId,
    runId: input.runId,
    aiConfig,
    runtimeContext: {
      correlationId: input.correlationId,
      triggerSource: input.triggerSource,
      triggerReason: input.triggerReason,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      capabilities: ['raven_cat.autonomous'],
      memoryParticipation: 'read_only',
      replyRunId: input.runId,
    },
    finalAssistantPolicy: 'autonomous_reply',
    signal: input.signal,
    prepare: async (signal) => {
      const mcpExposure = assistant.enableTools
        ? await dependencies.tools.resolveMcpExposure(assistant.id)
        : { allowedToolNames: [], services: [] };
      const candidateBuiltInNames = assistant.enableTools
        ? await dependencies.tools.resolveAllowedNames(assistant.id)
        : [];
      const toolConfig: AIToolsConfig = {
        apiBaseUrl: assistant.apiBaseUrl,
        isHostAI: assistant.isHostAI,
        enableTools: assistant.enableTools,
        triggerSource: input.triggerSource,
        capabilities: ['raven_cat.autonomous'],
        memoryParticipation: 'read_only',
        allowedToolNames: candidateBuiltInNames,
      };
      const builtInNames = dependencies.tools.getRuntimeAllowedNames(toolConfig);
      const staticallyAllowedToolNames = [...new Set([
        ...builtInNames,
        ...mcpExposure.allowedToolNames,
      ])];
      const runPreparation = await dependencies.runPreparation.prepare({
        scenario: input.scenarioId,
        currentAiId: assistant.id,
        isHostAI: assistant.isHostAI,
        persistentAllowedToolNames: candidateBuiltInNames,
      });
      const allowedToolNames = applyHostModelRunToolExposure(
        staticallyAllowedToolNames,
        runPreparation,
      );
      const sharedState = { replyRunId: input.runId };
      const createToolContext = (abortSignal?: AbortSignal) => dependencies.tools.createContext({
        aiConfig,
        sessionId: input.sessionId,
        triggerSource: input.triggerSource,
        triggerReason: input.triggerReason,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
        capabilities: ['raven_cat.autonomous'],
        sharedState,
        abortSignal,
      });
      const promptPack = await dependencies.prompt.assembleChatPromptPack({
        aiConfig,
        toolContext: createToolContext(),
        sessionId: input.sessionId,
        currentInput: '',
        runtimeContext: {
          inputSource: 'application',
          forceAppendUserText: true,
          triggerSource: input.triggerSource,
          triggerReason: input.triggerReason,
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
          capabilities: ['raven_cat.autonomous'],
          memoryParticipation: 'read_only',
          replyRunId: input.runId,
        },
        toolsDescription: dependencies.tools.buildDescription(allowedToolNames),
        allowedToolNames,
        mcpServices: mcpExposure.services,
        additionalBlocks: [
          ...input.additionalPromptBlocks,
          ...runPreparation.additionalPromptBlocks,
        ],
      });
      const client = createAIClient({
        apiBaseUrl: assistant.apiBaseUrl || undefined,
        apiKey: assistant.apiKey || '',
        model: assistant.model,
        temperature: assistant.temperature,
        topP: assistant.topP,
        disableThinking: assistant.disableThinking,
        reasoningEffort: assistant.reasoningEffort,
        maxTokens: assistant.maxTokens ?? undefined,
        systemPrompt: promptPack.systemPrompt,
      });
      const modelGateway = new BaseAIClientAgentModelGateway({
        client,
        initialMessages: promptPack.modelMessages,
        toolInstructionsSlot: promptPack.toolInstructionsSlot,
        diagnosticContext: {
          sessionId: input.sessionId,
          runId: input.runId,
          correlationId: input.correlationId,
        },
      });
      const task = createAutonomousTask({
        runId: input.runId,
        assistantId: assistant.id,
        sessionId: input.sessionId,
        allowedToolNames,
        createdAt: input.triggeredAt,
        goal: input.taskGoal,
        source: input.taskSource,
      });
      return {
        request: { task, initialHistory: [], signal },
        modelGateway,
        createLegacyContext: (executionContext) => createToolContext(executionContext.abortSignal),
      };
    },
  });
}

function createAutonomousTask(input: {
  runId: string;
  assistantId: string;
  sessionId: string | null;
  allowedToolNames: string[];
  createdAt: string;
  goal: string;
  source: AgentTaskSource;
}): AgentTask {
  return {
    id: `raven_cat_autonomous_${input.runId}`,
    type: 'raven_cat_autonomous',
    source: input.source,
    goal: input.goal,
    assistantId: input.assistantId,
    sessionId: input.sessionId,
    allowedToolNames: [...input.allowedToolNames],
    modelTransport: 'stream',
    ...AUTONOMOUS_TASK_BUDGET,
    createdAt: input.createdAt,
  };
}

function toAutonomousAIConfig(assistant: AIProfile): PromptPackAIConfig & {
  agentId: string;
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
} {
  return {
    id: assistant.id,
    agentId: assistant.agentId,
    name: assistant.name,
    model: assistant.model,
    apiKey: assistant.apiKey || '',
    apiBaseUrl: assistant.apiBaseUrl || '',
    systemPrompt: assistant.systemPrompt || undefined,
    temperature: assistant.temperature,
    topP: assistant.topP,
    maxTokens: assistant.maxTokens,
    enableTools: assistant.enableTools,
    allowMultipleBubbles: assistant.allowMultipleBubbles,
    isHostAI: assistant.isHostAI,
    isBlocked: assistant.isBlocked,
  };
}
