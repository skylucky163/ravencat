/** 定义 Chat AI 回复流程共享的配置、运行时上下文、响应与回调契约。 */
import type { ChatMessage as InfrastructureChatMessage } from '@platform/ai';
import type {
  MemoryParticipationMode,
  PromptPackBlock,
} from '@shared/prompt';
import type {
  AIMessageDeliveryKind,
  AIMessageDeliveryReceipt,
  AIMessageReceivedPayload,
} from '../delivery/AIMessageEvents';
import type { GroupMessageMention } from '../../messages/domain/chatMessageMetadata';

export interface McpServiceSummary {
  name: string;
  description: string;
}

export interface McpExposureBundle {
  allowedToolNames: string[];
  services: McpServiceSummary[];
}

export interface AIReplyConfig {
  id: string;
  agentId: string;
  name: string;
  avatar?: string | null;
  model: string;
  apiKey: string;
  apiBaseUrl: string;
  systemPrompt?: string;
  temperature?: number | null;
  topP?: number | null;
  disableThinking?: boolean;
  reasoningEffort?: import('@platform/ai').ReasoningEffort;
  maxTokens?: number | null;
  /** 单聊上下文作为主场时的可见条数；缺失时由共享默认常量兜底。 */
  privateContextPrimaryLimit?: number;
  /** 单聊上下文作为客体注入时的可见条数；缺失时由共享默认常量兜底。 */
  privateContextSecondaryLimit?: number;
  /** 群聊上下文作为主场时的可见条数；缺失时由共享默认常量兜底。 */
  groupContextPrimaryLimit?: number;
  /** 群聊上下文作为客体注入时的可见条数；缺失时由共享默认常量兜底。 */
  groupContextSecondaryLimit?: number;
  enableTools?: boolean;
  manualReply?: boolean;
  allowMultipleBubbles?: boolean;
  enableStreamingReply?: boolean;
  isHostAI?: boolean;
  isBlocked?: boolean;
}

export interface AIReplyRuntimeContext {
  inputSource?: 'application';
  /** 应用触发的完整模型回复可以选择静默，不投影控制标记。 */
  allowSilentReply?: boolean;
  /** 已在调用方参与者目录中固定的当前用户显示名；群聊 Prompt 不应再次读取当前资料。 */
  userDisplayName?: string;
  correlationId?: string;
  triggerSource?: string;
  triggerReason?: string;
  /**
   * assistant message metadata 与系统交付事件使用不同的触发语义时，单独指定交付侧
   * triggerSource；不改写已落库的 Chat metadata。
   */
  deliveryTriggerSource?: string | null;
  /** 原生交付通知的分域；不参与 Chat 消息 metadata 语义。 */
  notificationScope?: string | null;
  /** 仅用于显式固定交付类型；普通 Chat 仍按 triggerSource 推导。 */
  deliveryKind?: AIMessageDeliveryKind;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  capabilities?: string[];
  batchSeq?: number;
  batchedUserMessageIds?: number[];
  /** 重写历史截到原输入，已有摘要按产品约定保留。 */
  historyUpperBound?: { messageId: number; createdAt: string };
  isRegeneration?: boolean;
  batchedUserMessageCount?: number;
  memoryParticipation?: MemoryParticipationMode;
  supportsMultipleBubbles?: boolean;
  batchModelInput?: ChatContextMessage['content'];
  /** 非聊天输入触发时保留历史末条用户发言，另接本轮输入。 */
  forceAppendUserText?: boolean;
  /**
   * 本轮输入的逐条消息序列（真实 role 与顺序，Phase 5A 游标区间组装）。
   * 存在时替换 prompt pack 末尾的触发用户消息。
   */
  turnInputMessages?: ChatContextMessage[];
  recentWindowLimit?: number;
  suppressAIMessageReceivedEvent?: boolean;
  /**
   * 悬浮层在应用退到后台后不能依赖 JS 定时器；这类入口必须立即落库并回传原生预览。
   * 普通聊天保持 paced，避免无意间改变既有的分段发送体验。
   */
  deliveryTiming?: 'paced' | 'immediate';
  /** 同一 canonical 片段已由运行展示的原生时钟安排到达，T3 后不得重播。 */
  arrivalAlreadyScheduled?: boolean;
  groupChat?: {
    groupId: string;
    groupName: string;
    currentAIId: string;
    currentAgentId: string;
    currentAIName: string;
    members: {
      aiAssistantId: string;
      agentId: string;
      name: string;
      muted?: boolean;
    }[];
    recentWindowLimit: number;
    planId?: string | null;
    taskId?: string | null;
    taskSource?: string | null;
    sequenceOrder?: number | null;
    currentTurnUserMessageIds?: number[];
    inputUpperBoundMessageId?: number;
    /** 本轮模型输出解析出的结构化称呼；由提交接缝复制到每个可见分段。 */
    mentions?: GroupMessageMention[];
  };
  replyRunId?: string;
  abortSignal?: AbortSignal;
  /** 当前 JS 进程单调时钟的截止点，不是可持久化的日历时间。 */
  executionDeadlineAt?: number;
  promptBlocks?: PromptPackBlock[];
  allowedToolNames?: string[];
  /** 与本轮 policy 固定的 MCP 工具名单配套的服务摘要；仅供 Prompt 选择服务。 */
  mcpServices?: McpServiceSummary[];
  companionScheduleRevision?: number;
}

export type ChatContextMessage = InfrastructureChatMessage & { createdAt?: string };

export interface AIResponse {
  success: boolean;
  text: string;
  reasoningText?: string;
  error?: string | null;
  messageId?: string | null;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  isToolCall?: boolean;
  toolCalls?: ToolCall[] | null;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  result: unknown;
}

export interface ProcessAIReplyCallbacks {
  onSilentReply?: () => void;
  notifyUI?: (sessionId: string) => void;
  onReplyCommitted?: () => void;
  onReplySegment?: (
    payload: AIReplySegmentPayload
  ) => void | Promise<void>;
  onFinalReply?: (payload: AIReplyFinalPayload) => void;
  onReplyFailed?: (payload: AIReplyFailedPayload) => void;
  /**
   * Chat 内部交付观察接缝：在 emitAIMessageReceived 返回系统交付回执后调用。
   * 不用于判定 execution host 身份，普通 public command 不暴露该回调。
   */
  onAIMessageDelivered?: (payload: {
    message: AIMessageReceivedPayload;
    receipt: AIMessageDeliveryReceipt;
  }) => void | Promise<void>;
}

export interface AIReplySegmentPayload {
  status: 'segment';
  sessionId: string;
  correlationId?: string;
  text: string;
  previewText: string;
  logicalMessageId: string | null;
  messageId: number;
  clientMessageId?: string;
  segmentIndex: number;
  segmentTotal: number;
}

export interface AIReplyFinalSegment {
  messageId: number;
  segmentIndex: number;
  text: string;
}

export interface AIReplyFinalPayload {
  status: 'completed';
  sessionId: string;
  correlationId?: string;
  text: string;
  previewText: string;
  joinedText: string;
  logicalMessageId: string | null;
  firstSegmentMessageId: number;
  lastSegmentMessageId: number;
  segmentTotal: number;
  segments: AIReplyFinalSegment[];
}

export interface AIReplyFailedPayload {
  status: 'failed';
  sessionId: string;
  correlationId?: string;
  text: string;
  previewText: string;
  messageId: number;
  error: string;
}
