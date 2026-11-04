/** 回复应用运行时依赖：由 Chat composition 注入模型、工具、Prompt 与媒体能力。 */

import type {
  AgentToolExecutionContext,
  AIToolsConfig,
  ToolContext,
  ToolContextParams,
  PrepareHostModelRun,
} from '@shared/aiTools';
import type {
  AgentRunModelGateway,
  AgentRunResult,
  AgentRunTerminalResult,
  AgentRuntimeCancelRequest,
  AgentRuntimeRequest,
} from '@platform/agentRuntime';
import type {
  AssemblePromptPackParams,
  AssembleStandalonePromptPackParams,
  PromptPack,
} from '@shared/prompt';
import type { ChatAssistantDirectory } from '../../ChatAssistantDirectory';
import type {
  McpExposureBundle,
} from './ChatReplyTypes';
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';

export interface ChatOCRModelConfig {
  modelConfigId: string;
  modelConfigName: string;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  metadataJson: string | null;
}

/** 未选择表示直接传图；失效引用保留用户明确选择预处理的意图。 */
export type ChatRecognitionModelSelection =
  | { status: 'unconfigured' }
  | { status: 'unavailable' }
  | { status: 'active'; model: ChatOCRModelConfig };

export interface ChatAgentRunRequest extends AgentRuntimeRequest {
  modelGateway: AgentRunModelGateway;
  openToolPackageIds?: readonly string[];
  createLegacyContext: (context: AgentToolExecutionContext) => ToolContext;
}

/** M3/M4 完成前 legacy URI 与稳定 asset ID 必须显式区分，禁止字符串猜测与 fallback。 */
export type ChatMediaReadInput =
  | { kind: 'legacy_uri'; uri: string }
  | { kind: 'media_asset'; assetId: string };

export interface ChatReplyRuntimeDependencies {
  mutations: {
    isRunCurrent: (transaction: import('@platform/persistence').DatabaseTransactionExecutor, runId: string) => Promise<boolean>;
  };
  assistantDirectory: Pick<ChatAssistantDirectory, 'getBlockState'>;
  media: {
    /** 文件边界负责真实格式、尺寸与静态帧准备，调用方不再猜 MIME。 */
    readVisionImage: (input: ChatMediaReadInput) => Promise<{ base64: string; mimeType: string }>;
  };
  vision: {
    /** 解析当前角色的图片识别选择；未选择表示直接向聊天模型传图。 */
    resolveOCRModel: (assistantId: string) => Promise<ChatRecognitionModelSelection>;
  };
  agent: {
    run: (request: ChatAgentRunRequest) => Promise<AgentRunResult>;
    cancel: (request: AgentRuntimeCancelRequest) => Promise<AgentRunTerminalResult>;
  };
  runPreparation: {
    prepare: PrepareHostModelRun;
  };
  tools: {
    createContext: (params: Omit<ToolContextParams, 'repositories'>) => ToolContext;
    buildDescription: (allowedToolNames: readonly string[]) => string;
    getRuntimeAllowedNames: (config: AIToolsConfig) => string[];
    resolveAllowedNames: (assistantId: string) => Promise<string[]>;
    /** MCP policy 一次返回当前可用工具名单与服务摘要，供同一轮 Prompt/task 共用。 */
    resolveMcpExposure: (assistantId: string) => Promise<McpExposureBundle>;
    resolveRuntimeContext: (assistantId: string) => Promise<{ companionScheduleRevision?: number }>;
  };
  prompt: {
    readImageGroundingReminder: (assistantId: string) => Promise<string | null>;
    /** 视觉识别任务的最终正文：AI 覆盖 → 全局默认 → 代码默认。 */
    resolveVisionOCRPrompt: (assistantId: string) => Promise<string>;
    assembleChat: (params: AssemblePromptPackParams) => Promise<PromptPack>;
    assembleLedger: (params: AssemblePromptPackParams) => Promise<PromptPack>;
    assembleStandalone: (params: AssembleStandalonePromptPackParams) => Promise<PromptPack>;
  };
}

const chatReplyRuntimeSlot = createRuntimeSlot<ChatReplyRuntimeDependencies>('Chat reply');

export function configureChatReplyRuntime(
  dependencies: ChatReplyRuntimeDependencies,
): void {
  chatReplyRuntimeSlot.configure(dependencies);
}

export function getChatReplyRuntimeDependencies(): ChatReplyRuntimeDependencies {
  return chatReplyRuntimeSlot.get();
}
