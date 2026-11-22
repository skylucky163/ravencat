/** AI Provider 技术能力公共出口。 */
export { BaseAIClient } from './BaseAIClient';
export { REASONING_EFFORTS, REASONING_EFFORT_LABELS, getReasoningEffortOptions, resolveReasoningEffort } from './reasoning';
export type { ReasoningEffort } from './reasoning';
export { aiHttpDiagnostics } from './HttpExchangeDiagnostics';
export type { AIHttpExchange, AIHttpDiagnosticsSnapshot } from './HttpExchangeDiagnostics';
export { OpenAIClient, createAIClient } from './OpenAIClient';
export { fetchModelList } from './modelDiscovery';
export { testAPIConnection } from './connectionTest';
export {
  detectParamError,
  detectQuotaError,
  detectServiceBusyError,
  getErrorDisplayInfo,
} from './errorMapping';
export { normalizeAIBaseURL } from './baseUrl';
export { resolveOfficialToolsAPIBaseURL } from './officialToolsEndpoint';
export type { OfficialToolProvider } from './officialToolsEndpoint';
export type { OfficialToolResult } from './OfficialToolsHttpClient';
export { DeepSeekToolsClient } from './DeepSeekToolsClient';
export type { DeepSeekSearchInput, DeepSeekSearchResult, DeepSeekFetchResult } from './DeepSeekToolsClient';
export { MoonshotToolsClient } from './MoonshotToolsClient';
export type { MoonshotToolResult, MoonshotSearchInput, MoonshotSearchResult, MoonshotFetchResult, MoonshotFormulaName, MoonshotFormulaInput, MoonshotFormulaResult } from './MoonshotToolsClient';
export { AgentModelGateway } from './agent/AgentModelGateway';
export { CompleteModelTurnAdapter } from './agent/CompleteModelTurnAdapter';
export { StreamingModelTurnAdapter } from './agent/StreamingModelTurnAdapter';
export { ModelTurnCollector } from './agent/ModelTurnCollector';
export type {
  AIClientConfig, ChatMessage, ContentPart, TextContentPart, ImageContentPart,
  ToolCall, ChatResponse, ChatStreamDelta, ChatStreamOptions,
  ChatStreamWithToolsOptions, EmbeddingResponse, ConnectionTestResult,
  ParamErrorInfo, QuotaErrorInfo, ServiceBusyErrorInfo, ErrorDisplayInfo,
  ModelInfo, ToolDefinition, ChatOptions, ChatWithToolsOptions,
  ConnectionTestOptions,
  OpenAIReasoningReplay,
} from './types';
export type {
  AgentModelEventSink,
  AgentModelProvider,
  AgentModelRequest,
} from './agent/AgentModelGateway';
export type {
  ModelEvent,
  ModelEventSink,
  ModelFinishReason,
  ModelHistoryItem,
  ModelToolCall,
  ModelToolResultHistoryItem,
  ModelTurnResult,
  ModelUsage,
} from './agent/ModelEvent';
export { generateImage } from './ImageGenerationClient';
export { IMAGE_GENERATION_PROVIDERS, IMAGE_ASPECT_RATIOS, readImageGenerationProfile, getImageGenerationCapabilities, validateImageGenerationParameters } from './imageGenerationConfig';
export type { ImageGenerationProfile, ImageGenerationProvider, ImageAspectRatio, ImageResolution, ImageGenerationParameters, ImageGenerationCapabilities } from './imageGenerationConfig';
export type { ImageGenerationPreview } from './ImageGenerationStream';
export type { GeneratedImageContent, ImageGenerationResult } from './ImageGenerationClient';
