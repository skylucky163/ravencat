/** Companion 运行时依赖契约；具体仓储、聊天投递与原生能力由 Host 组合入口注入。 */

import type { IAIAssistantRepository } from '@features/assistants';
import type {
  AIAssistantConfig,
  ChatAttachment,
  resolveCanonicalConversation,
  findCommittedAssistantMessageIdByRelatedSource,
  getCanonicalChatConversation,
  resolveCanonicalChatSourceMessages,
  runChatVisibleAgent,
  listChatAgentActivityEvidence,
  SendUserMessageParams,
  SendUserMessageResult,
} from '@features/chat';
import type {
  CompanionSettingsRepository,
  CompanionStateRepository,
} from '../domain/CompanionRepositories';
import type { AIScheduleRepository } from '../domain/AIScheduleRepository';
import type { ProactiveLifeReadRepository } from '../domain/ProactiveLifeReadRepository';
import type { CompanionNativePort } from './CompanionNativePort';
import type { CompanionNotificationPort } from './CompanionNotificationPort';
import type {
  AIToolsConfig,
  ToolContext,
  ToolContextParams,
  PrepareHostModelRun,
} from '@shared/aiTools';
import type {
  AssemblePromptPackParams,
  AssembleStandalonePromptPackParams,
  PromptPack,
} from '@shared/prompt';
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';

export interface CompanionRuntimeDependencies {
  /** Companion 只持有真实跨 Feature 用例所需的 Chat 窄端口。 */
  chat: CompanionChatPort;
  runPreparation: {
    prepare: PrepareHostModelRun;
  };
  tools: {
    createContext(params: Omit<ToolContextParams, 'repositories'>): ToolContext;
    buildDescription(allowedToolNames: readonly string[]): string;
    getRuntimeAllowedNames(config: AIToolsConfig): string[];
    resolveAllowedNames(assistantId: string): Promise<string[]>;
    resolveMcpExposure(assistantId: string): Promise<{
      allowedToolNames: string[];
      services: { name: string; description: string }[];
    }>;
  };
  repositories: {
    assistants: IAIAssistantRepository;
    companionSettings: CompanionSettingsRepository;
    companionState: CompanionStateRepository;
    aiSchedules: AIScheduleRepository;
    proactiveLife: ProactiveLifeReadRepository;
  };
  chatDelivery: {
    persistImageAttachment(params: {
      sourceUri: string;
      source: 'screen_capture';
      fileName: string;
      mimeType: string;
      width?: number | null;
      height?: number | null;
    }): Promise<ChatAttachment>;
    deletePersistedAttachment(uri: string): Promise<boolean>;
  };
  notifications: CompanionNotificationPort;
  prompt: {
    assembleChatPromptPack(params: AssemblePromptPackParams): Promise<PromptPack>;
    assembleStandalonePromptPack(
      params: AssembleStandalonePromptPackParams
    ): Promise<PromptPack>;
  };
  native: {
    companion: CompanionNativePort;
  };
  generateAIScheduleId(): string;
  generateAutonomousRunId(): string;
  initializeDatabase(): Promise<void>;
}

export interface CompanionChatPort {
  listTurnStates: typeof import('@features/chat').listChatTurnStates;
  /** 只仲裁本次机会；聊天优先，新日程替代旧日程，不排队补跑。 */
  runInConversation<T>(
    sessionId: string, runId: string,
    priority: { plannedAt: string; updatedAt: string; scheduleId: string },
    execute: (context: { signal: AbortSignal; displacedRunId?: string }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ status: 'ran'; value: T } | { status: 'chat_busy' } | { status: 'superseded'; scheduleId: string }>;
  listAgentActivityEvidence: typeof listChatAgentActivityEvidence;
  getCanonicalConversation: typeof getCanonicalChatConversation;
  resolveCanonicalConversation: typeof resolveCanonicalConversation;
  resolveCanonicalSourceMessages: typeof resolveCanonicalChatSourceMessages;
  runVisibleAgent: typeof runChatVisibleAgent;
  findCommittedAssistantMessageIdByRelatedSource:
    typeof findCommittedAssistantMessageIdByRelatedSource;
  /**
   * 由 Host 注入的受控 Headless 消息入口。
   *
   * RavenCat 只表达悬浮层需要的投影回调；`inline_current_host` 与
   * `deliveryTiming: immediate` 由 Host 适配器固定，Feature 不取得 Chat
   * 的 execution-host/internal 权限。
   */
  sendUserMessageFromExecutionHost(
    params: CompanionExecutionHostMessageParams,
  ): Promise<SendUserMessageResult>;
}

export interface CompanionExecutionHostMessageParams {
  message: SendUserMessageParams;
  aiConfig: AIAssistantConfig;
  correlationId: string;
  execution: { signal: AbortSignal; executionDeadlineAt: number };
  replyCallbacks: CompanionExecutionHostReplyCallbacks;
}

export interface CompanionExecutionHostReplyCallbacks {
  onReplyDisplaySegment?: (
    payload: { sessionId: string; clientMessageId: string; text: string; previewText: string },
  ) => void | CompanionReplyProjectionReceipt | Promise<void | CompanionReplyProjectionReceipt>;
  onReplySegment?: (
    payload: CompanionReplySegmentPayload,
  ) => void | CompanionReplyProjectionReceipt | Promise<void | CompanionReplyProjectionReceipt>;
  onFinalReply?: (payload: CompanionReplyFinalPayload) => void;
  onReplyCommitted?: () => void;
  onReplyFailed?: (payload: CompanionReplyFailedPayload) => void;
}

export interface CompanionReplyProjectionReceipt {
  userNotificationHandled: boolean;
}

export interface CompanionReplySegmentPayload {
  sessionId: string;
  messageId: number;
  clientMessageId?: string;
  text: string;
  previewText: string;
  segmentIndex: number;
}

export interface CompanionReplyFinalPayload {
  sessionId: string;
  text: string;
  previewText: string;
  joinedText: string;
  segments: {
    messageId: number;
    segmentIndex: number;
    text: string;
  }[];
}

export interface CompanionReplyFailedPayload {
  sessionId: string;
  messageId: number;
  previewText: string;
  error: string;
}

const companionRuntimeSlot = createRuntimeSlot<CompanionRuntimeDependencies>('Companion');

export function configureCompanionRuntimeDependencies(
  dependencies: CompanionRuntimeDependencies
): void {
  companionRuntimeSlot.configure(dependencies);
}

export function getCompanionRuntimeDependencies(): CompanionRuntimeDependencies {
  return companionRuntimeSlot.get();
}
