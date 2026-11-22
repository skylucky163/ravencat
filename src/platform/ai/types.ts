/**
 * @fileoverview AI 基础设施类型定义
 *
 * 共享类型定义，供所有 AI 客户端模块使用
 *
 * @module platform/ai/types
 */

// ============================================================================
// AI 配置类型
// ============================================================================

export type ReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AIClientConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  systemPrompt?: string;
  disableThinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** 仅声明 content 使用开头 think 标签的接口启用；未声明时只识别已知标签模型。 */
  thinkTagMode?: 'off' | 'leading';
}

// ============================================================================
// 消息类型
// ============================================================================

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
  reasoning_content?: string;
  /** 本次工具续轮的原始思考载荷，由 Provider 在序列化时展开，不写入历史聊天。 */
  reasoningReplay?: OpenAIReasoningReplay;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// ============================================================================
// 工具调用类型
// ============================================================================

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ============================================================================
// 请求/响应类型
// ============================================================================

export interface ChatResponse {
  httpStatus?: number | null;
  usageReported?: boolean;
  text: string;
  reasoningText?: string;
  reasoningReplay?: OpenAIReasoningReplay;
  /** Provider 已返回的原始 finish_reason，供 Agent adapter 做语义归一化。 */
  finishReason?: string | null;
  messageId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 输入中命中服务端缓存的 token；缺失表示服务商未提供。 */
  cachedTokens?: number;
  success: boolean;
  error: string | null;
  toolCalls: ToolCall[] | null;
  isToolCall: boolean;
}

export type ChatStreamDelta =
  | {
      type: 'reasoning_delta';
      text: string;
    }
  | {
      type: 'answer_delta';
      text: string;
    }
  | {
      type: 'tool_call_start';
      toolCallId: string;
      index: number;
      name?: string;
    }
  | {
      type: 'tool_call_args_delta';
      toolCallId: string;
      index: number;
      argumentsDelta: string;
    }
  | {
      type: 'tool_call_done';
      toolCallId: string;
      index: number;
      name: string;
      arguments: string;
    }
  | {
      type: 'done';
    };

export interface EmbeddingResponse {
  errorCode?: 'authentication' | 'configuration' | 'model_unavailable' | 'input_too_long'
    | 'rate_limit' | 'network' | 'timeout' | 'service' | 'invalid_response' | 'dimension_mismatch' | 'unknown';
  embeddings: number[][];
  model: string | null;
  promptTokens: number;
  totalTokens: number;
  success: boolean;
  error: string | null;
}

export interface ConnectionTestResult {
  success: boolean;
  error: string | null;
}

// ============================================================================
// 错误类型
// ============================================================================

export interface ParamErrorInfo {
  isParamError: boolean;
  paramName: string | null;
  allowedValue: string | null;
  message: string;
}

export interface QuotaErrorInfo {
  isQuotaError: boolean;
  message: string;
}

export interface ServiceBusyErrorInfo {
  isServiceBusyError: boolean;
  message: string;
}

export interface ErrorDisplayInfo {
  title: string;
  message: string;
  type?: string;
  isParamError?: boolean;
  paramName?: string | null;
  allowedValue?: string | null;
}

// ============================================================================
// 模型发现类型
// ============================================================================

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

// ============================================================================
// 工具定义类型
// ============================================================================

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ============================================================================
// Chat 选项类型
// ============================================================================

export interface ChatOptions {
  includeSystemPrompt?: boolean;
  allowReasoningLengthRetry?: boolean;
  allowImageContentFallback?: boolean;
  responseFormat?: 'json_object';
  signal?: AbortSignal;
}

export interface ChatStreamOptions extends ChatOptions {
  onDelta?: (delta: ChatStreamDelta) => void | Promise<void>;
}

export interface ChatWithToolsOptions {
  allowImageContentFallback?: boolean;
  includeSystemPrompt?: boolean;
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  allowReasoningLengthRetry?: boolean;
  signal?: AbortSignal;
}

export interface ChatStreamWithToolsOptions extends ChatWithToolsOptions {
  onDelta?: (delta: ChatStreamDelta) => void | Promise<void>;
}

// ============================================================================
// 连接测试选项
// ============================================================================

export interface ConnectionTestOptions {
  disableThinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  skipParams?: boolean;
}

// ============================================================================
// OpenAI API 响应类型
// ============================================================================

export interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

export interface OpenAIChatCompletionResponse {
  id?: string;
  choices?: {
    message?: OpenAIAssistantPayload;
    finish_reason?: string;
  }[];
  usage?: OpenAIChatUsage;
}

/** 外部字段只在 Provider 边界解释；未知 detail 字段与签名仍完整保留。 */
export interface OpenAIAssistantPayload {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  reasoning_details?: unknown;
  tool_calls?: unknown[];
}

/** 仅随现有 ModelHistoryItem 在本次执行内回放，不新增持久化事实。 */
export interface OpenAIReasoningReplay {
  content?: string | unknown[];
  reasoning_content?: string;
  reasoning_details?: Record<string, unknown>[];
}

/** 只记录协议位置和问题类别，不包含模型内容或凭据，不进入用户消息及请求体。 */
export interface AIProtocolIssue {
  code: 'details_not_array' | 'invalid_detail' | 'detail_identity_conflict' | 'invalid_detail_field';
  path: string;
  frame: number;
}

export interface OpenAIEmbeddingResponse {
  model?: string;
  data?: {
    embedding?: number[];
    index?: number;
  }[];
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

