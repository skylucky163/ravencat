/**
 * @fileoverview BaseAIClient - OpenAI 兼容的基础 AI 客户端
 *
 * 提供普通、流式、工具调用与向量请求的公共协议实现。
 *
 * @module platform/ai/BaseAIClient
 */

import { getErrorDisplayInfo, redactAIErrorMessage } from './errorMapping';
import { normalizeAIBaseURL } from './baseUrl';
import { beginAIHttpCapture } from './HttpExchangeCapture';
import { buildThinkingParameters } from './reasoning';
import { OpenAIMessageDecoder, usesLeadingThinkTags, reasoningReplayContract, type AssistantTextResult, type ReasoningCompletionContext } from './OpenAIMessageDecoder';
import type {
  AIClientConfig,
  ChatMessage,
  ChatResponse,
  ChatOptions,
  ChatStreamDelta,
  ChatStreamOptions,
  ChatStreamWithToolsOptions,
  ChatWithToolsOptions,
  ToolDefinition,
  ToolCall,
  ConnectionTestResult,
  OpenAIChatCompletionResponse,
  OpenAIChatUsage,
  OpenAIAssistantPayload,
  AIProtocolIssue,
  OpenAIEmbeddingResponse,
  EmbeddingResponse,
} from './types';

const maxTokensFieldCache = new Map<string, string>();
interface DecodedCompletionResponse extends OpenAIChatCompletionResponse {
  extraction: AssistantTextResult;
  parsedToolCalls: ToolCall[];
}
/** HTTP 状态保留给调用方分类失败，不要求业务层猜测服务端错误文案。 */
class AIHttpError extends Error {
  constructor(readonly status: number, message: string) { super(`HTTP ${status}: ${message}`); }
}

/** Provider 错误属于外部协议；保留 code/message，纯文本拒绝也不能丢失。 */
function readProviderError(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  if ('error' in data && data.error != null) {
    return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
  }
  return 'message' in data && typeof data.message === 'string' ? JSON.stringify(data) : null;
}

function parseHTTPErrorBody(rawText: string): string {
  try { return readProviderError(JSON.parse(rawText)) ?? rawText; }
  catch { return rawText; }
}

export class BaseAIClient {
  config: AIClientConfig;
  baseURL: string;
  private maxTokensFieldName: string;
  private readonly parseThinkTags: boolean;

  private reasoningContext(hasToolCalls: boolean): ReasoningCompletionContext {
    return { hasToolCalls, replayContract: reasoningReplayContract(this.baseURL), thinkingDisabled: this.config.disableThinking };
  }

  constructor(config: AIClientConfig) {
    this.config = { ...config };

    this.baseURL = this.buildBaseURL(this.config.baseURL);
    this.parseThinkTags = usesLeadingThinkTags(config);
    this.maxTokensFieldName = getCachedMaxTokensFieldName(this.baseURL, this.config.model);
  }

  private buildBaseURL(baseURL: string): string {
    return normalizeAIBaseURL(baseURL);
  }

  private buildRequestMessages(
    messages: ChatMessage[],
    includeSystemPrompt: boolean
  ): ChatMessage[] {
    const requestMessages: ChatMessage[] = [];
    if (includeSystemPrompt && this.config.systemPrompt) {
      requestMessages.push({
        role: 'system',
        content: this.config.systemPrompt,
      });
    }
    requestMessages.push(...sanitizeRequestMessages(messages));
    return requestMessages;
  }

  private buildRequestBody({
    messages,
    tools,
    toolChoice,
    responseFormat,
    stream = false,
  }: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    responseFormat?: ChatOptions['responseFormat'];
    stream?: boolean;
  }): Record<string, unknown> {
    const providerHostname = new URL(this.baseURL).hostname;
    const requestBody: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream,
    };

    if (stream) {
      requestBody.stream_options = { include_usage: true };
    }

    if (tools) {
      requestBody.tools = tools;
      requestBody.tool_choice = toolChoice;
    }

    if (responseFormat) {
      requestBody.response_format = { type: responseFormat };
    }

    Object.assign(requestBody, buildThinkingParameters({ ...this.config, baseURL: this.baseURL }));

    // DeepSeek 默认启用思考；带工具的首次请求也要求历史 assistant 提供该字段。
    // 这里只补纯对话历史的空记录；真实工具轮的思考必须由调用链原样回传。
    if (providerHostname === 'api.deepseek.com' && tools && tools.length > 0
      && this.config.disableThinking !== true) {
      requestBody.messages = withDeepSeekHistoryReasoning(messages);
    }

    // 原始思考只在本次工具续轮回放；内部载荷不能作为未知请求字段泄漏给服务商。
    requestBody.messages = (requestBody.messages as ChatMessage[]).map(({ reasoningReplay, ...message }) => {
      if (!reasoningReplay) return message;
      const { reasoning_content: _displayReasoning, ...wireMessage } = message;
      return { ...wireMessage, ...reasoningReplay };
    });

    if (this.config.temperature !== null && this.config.temperature !== undefined) {
      requestBody.temperature = this.config.temperature;
    }
    if (this.config.maxTokens !== null && this.config.maxTokens !== undefined) {
      requestBody[this.maxTokensFieldName] = this.config.maxTokens;
    }
    if (this.config.topP !== null && this.config.topP !== undefined) {
      requestBody.top_p = this.config.topP;
    }

    return requestBody;
  }

  private async sendRequest(
    requestBody: Record<string, unknown>,
    options: { signal?: AbortSignal; allowImageContentFallback?: boolean } = {}
  ): Promise<DecodedCompletionResponse> {
    const data = await this.sendRequestOnce(requestBody, options);
    return data;
  }

  private async sendStreamingRequest(
    requestBody: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      allowImageContentFallback?: boolean;
      onDelta?: (delta: ChatStreamDelta) => void | Promise<void>;
    } = {}
  ): Promise<ChatResponse> {
    try {
      return await this.sendStreamingRequestOnce(requestBody, options);
    } catch (error) {
      // HTTP 拒绝发生在模型输出前；这里只对明确的图片参数错误做一次文字降级。
      const fallback = options.allowImageContentFallback === false || !(error instanceof AIHttpError)
        || (error.status !== 400 && error.status !== 422) ? null
        : this.buildImageContentFallbackRequestBody(requestBody, error.message);
      if (!fallback) throw error;
      return this.sendStreamingRequestOnce(fallback, options);
    }
  }

  private async sendStreamingRequestOnce(
    requestBody: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onDelta?: (delta: ChatStreamDelta) => void | Promise<void>;
    } = {}
  ): Promise<ChatResponse> {
    if (typeof XMLHttpRequest !== 'undefined') {
      return sendStreamingRequestWithXMLHttpRequest({
        url: `${this.baseURL}/chat/completions`,
        apiKey: this.config.apiKey,
        requestBody,
        signal: options.signal,
        onDelta: options.onDelta,
        parseThinkTags: this.parseThinkTags,
        reasoningContext: this.reasoningContext(false),
      });
    }

    const url = `${this.baseURL}/chat/completions`;
    const body = JSON.stringify(requestBody);
    let capture = await beginAIHttpCapture({ url, requestBody: body,
      model: String(requestBody.model ?? ''), transport: 'stream' }, this.config.apiKey);
    let failure: unknown;
    let protocolIssues: readonly AIProtocolIssue[] = [];
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        signal: options.signal,
        body,
      });
      capture?.setResponse(response.status, '');

      if (!response.ok) {
        const rawText = await response.text();
        const errorMessage = parseHTTPErrorBody(rawText) || response.statusText;
        const httpError = new AIHttpError(response.status, errorMessage);
        capture?.setResponse(response.status, rawText);
        await capture?.finish(httpError);
        capture = null;
        const fallbackRequestBody = this.buildMaxTokensFallbackRequestBody(requestBody, errorMessage);

        if (fallbackRequestBody) {
          const data = await this.sendStreamingRequestOnce(fallbackRequestBody, options);
          this.rememberMaxTokensFieldName(getRequestBodyMaxTokensFieldName(fallbackRequestBody) || 'max_tokens');
          return data;
        }

        const responseFormatFallbackRequestBody = this.buildResponseFormatFallbackRequestBody(
          requestBody,
          errorMessage
        );

        if (responseFormatFallbackRequestBody) {
          return this.sendStreamingRequestOnce(responseFormatFallbackRequestBody, options);
        }

        throw httpError;
      }

      this.rememberMaxTokensFieldName(getRequestBodyMaxTokensFieldName(requestBody) || 'max_tokens');

      return await readOpenAICompatibleSSE(response, options.onDelta,
        capture ? (chunk) => capture.appendResponse(chunk) : undefined,
        (error) => { failure = error; }, this.parseThinkTags, options.signal, this.reasoningContext(false),
        (issues) => { protocolIssues = issues; });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await capture?.finish(failure, protocolIssues);
    }
  }

  private async sendRequestOnce(
    requestBody: Record<string, unknown>,
    options: { signal?: AbortSignal; allowImageContentFallback?: boolean } = {}
  ): Promise<DecodedCompletionResponse> {
    const url = `${this.baseURL}/chat/completions`;
    const body = JSON.stringify(requestBody);
    let capture = await beginAIHttpCapture({ url, requestBody: body,
      model: String(requestBody.model ?? ''), transport: 'complete' }, this.config.apiKey);
    let failure: unknown;
    let protocolIssues: readonly AIProtocolIssue[] = [];
    try {
      const response = await fetch(url, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}`,
      }, signal: options.signal, body });
      capture?.setResponse(response.status, '');
      const rawText = await response.text();
      capture?.setResponse(response.status, rawText);
      if (!response.ok) {
        const errorMessage = parseHTTPErrorBody(rawText) || response.statusText;
        const httpError = new AIHttpError(response.status, errorMessage);
        await capture?.finish(httpError);
        capture = null;
        const fallbackRequestBody = this.buildMaxTokensFallbackRequestBody(requestBody, errorMessage);

        if (fallbackRequestBody) {
          console.warn('[BaseAIClient] Retrying request with alternate max tokens field', {
            model: this.config.model,
            requestURL: `${this.baseURL}/chat/completions`,
            fromField: getRequestBodyMaxTokensFieldName(requestBody),
            toField: getRequestBodyMaxTokensFieldName(fallbackRequestBody),
          });

          const data = await this.sendRequestOnce(fallbackRequestBody, options);
          this.rememberMaxTokensFieldName(getRequestBodyMaxTokensFieldName(fallbackRequestBody) || 'max_tokens');
          return data;
        }

        const imageFallbackRequestBody = options.allowImageContentFallback === false || (response.status !== 400 && response.status !== 422)
          ? null
          : this.buildImageContentFallbackRequestBody(requestBody, errorMessage);

        if (imageFallbackRequestBody) {
          console.warn('[BaseAIClient] Retrying request without image_url content parts', {
            model: this.config.model,
            requestURL: `${this.baseURL}/chat/completions`,
          });

          return this.sendRequestOnce(imageFallbackRequestBody, options);
        }

        const responseFormatFallbackRequestBody = this.buildResponseFormatFallbackRequestBody(
          requestBody,
          errorMessage
        );

        if (responseFormatFallbackRequestBody) {
          console.warn('[BaseAIClient] Retrying request without response_format', {
            model: this.config.model,
            requestURL: `${this.baseURL}/chat/completions`,
          });

          return this.sendRequestOnce(responseFormatFallbackRequestBody, options);
        }

        throw httpError;
      }

      this.rememberMaxTokensFieldName(getRequestBodyMaxTokensFieldName(requestBody) || 'max_tokens');

      const data = JSON.parse(rawText) as OpenAIChatCompletionResponse;
      const providerError = readProviderError(data);
      if (providerError !== null) throw new Error(`模型接口错误：${providerError}`);
      const choice = data.choices?.[0];
      if (!choice?.message || typeof choice.message !== 'object' || Array.isArray(choice.message)) {
        throw new Error('Invalid API response: no assistant message');
      }
      const decoder = new OpenAIMessageDecoder(this.parseThinkTags);
      decoder.append(choice.message);
      decoder.finish();
      protocolIssues = decoder.protocolIssues;
      const parsedToolCalls = normalizeToolCalls(choice.message.tool_calls);
      const extraction = decoder.complete(this.reasoningContext(parsedToolCalls.length > 0 || choice.finish_reason === 'tool_calls'), true);
      return { ...data, extraction, parsedToolCalls };
    } catch (error) {
      failure = error;
      throw error;
    } finally { await capture?.finish(failure, protocolIssues); }
  }

  private rememberMaxTokensFieldName(fieldName: string): void {
    if (fieldName !== 'max_tokens' && fieldName !== 'max_completion_tokens') {
      return;
    }

    this.maxTokensFieldName = fieldName;
    setCachedMaxTokensFieldName(this.baseURL, this.config.model, fieldName);
  }

  private buildMaxTokensFallbackRequestBody(
    requestBody: Record<string, unknown>,
    errorMessage: string
  ): Record<string, unknown> | null {
    if (!requestBody || typeof requestBody !== 'object') {
      return null;
    }

    const rawMessage = typeof errorMessage === 'string' ? errorMessage : String(errorMessage || '');
    const lowerMsg = rawMessage.toLowerCase();
    const hasMaxTokens = Object.prototype.hasOwnProperty.call(requestBody, 'max_tokens');
    const hasMaxCompletionTokens = Object.prototype.hasOwnProperty.call(requestBody, 'max_completion_tokens');

    if (
      hasMaxTokens
      && !hasMaxCompletionTokens
      && (
        lowerMsg.includes("unsupported parameter: 'max_tokens'")
        || lowerMsg.includes('max_tokens is not supported')
        || (lowerMsg.includes('max_tokens') && lowerMsg.includes('max_completion_tokens'))
      )
    ) {
      const nextRequestBody = omitKey(requestBody, 'max_tokens');
      return {
        ...nextRequestBody,
        max_completion_tokens: requestBody.max_tokens,
      };
    }

    if (
      hasMaxCompletionTokens
      && !hasMaxTokens
      && (
        lowerMsg.includes("unsupported parameter: 'max_completion_tokens'")
        || lowerMsg.includes('max_completion_tokens is not supported')
        || (lowerMsg.includes('max_completion_tokens') && lowerMsg.includes('max_tokens'))
      )
    ) {
      const nextRequestBody = omitKey(requestBody, 'max_completion_tokens');
      return {
        ...nextRequestBody,
        max_tokens: requestBody.max_completion_tokens,
      };
    }

    return null;
  }

  private buildImageContentFallbackRequestBody(
    requestBody: Record<string, unknown>,
    errorMessage: string
  ): Record<string, unknown> | null {
    if (!requestBody || typeof requestBody !== 'object') {
      return null;
    }

    if (!shouldRetryWithoutImageParts(errorMessage)) {
      return null;
    }

    const normalizedMessages = stripImagePartsFromMessages(requestBody.messages as ChatMessage[]);
    if (!normalizedMessages) {
      return null;
    }

    return {
      ...requestBody,
      messages: normalizedMessages,
    };
  }

  private buildResponseFormatFallbackRequestBody(
    requestBody: Record<string, unknown>,
    errorMessage: string
  ): Record<string, unknown> | null {
    if (!requestBody || typeof requestBody !== 'object') {
      return null;
    }

    if (!Object.prototype.hasOwnProperty.call(requestBody, 'response_format')) {
      return null;
    }

    if (!shouldRetryWithoutResponseFormat(errorMessage)) {
      return null;
    }

    return omitKey(requestBody, 'response_format');
  }

  private createSuccessResponse(
    data: DecodedCompletionResponse,
    toolCalls: ToolCall[],
    isToolCall: boolean,
    finishReason?: string | null
  ): ChatResponse {
    const extraction = data.extraction;
    return {
      text: extraction.text,
      reasoningText: extraction.reasoningText || '',
      ...(extraction.reasoningReplay ? { reasoningReplay: extraction.reasoningReplay } : {}),
      finishReason: finishReason ?? null,
      usageReported: data.usage != null,
      messageId: data.id || null,
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0,
      cachedTokens: readCachedTokens(data.usage),
      success: true,
      error: null,
      toolCalls: isToolCall ? toolCalls : null,
      isToolCall,
    };
  }

  private createErrorResponse(errorMessage: string, httpStatus: number | null = null): ChatResponse {
    return {
      httpStatus,
      text: '',
      messageId: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      success: false,
      // Provider 可能回显当前密钥；错误离开传输边界前脱敏，与是否开启诊断无关。
      error: redactAIErrorMessage(errorMessage, this.config.apiKey),
      toolCalls: null,
      isToolCall: false,
    };
  }

  private createEmbeddingErrorResponse(errorMessage: string, errorCode: EmbeddingResponse['errorCode'] = 'unknown'): EmbeddingResponse {
    return {
      embeddings: [],
      errorCode,
      model: null,
      promptTokens: 0,
      totalTokens: 0,
      success: false,
      error: redactAIErrorMessage(errorMessage, this.config.apiKey),
    };
  }

  async embed(input: string | string[], options: { signal?: AbortSignal } = {}): Promise<EmbeddingResponse> {
    const normalizedInput = Array.isArray(input)
      ? input.map((item) => String(item || '').trim()).filter(Boolean)
      : String(input || '').trim();

    const hasInput = Array.isArray(normalizedInput)
      ? normalizedInput.some(Boolean)
      : Boolean(normalizedInput);

    if (!hasInput) {
      return this.createEmbeddingErrorResponse('Embedding input is empty', 'configuration');
    }

    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        signal: options.signal,
        body: JSON.stringify({
          model: this.config.model,
          input: normalizedInput,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
        const code = response.status === 401 || response.status === 403 ? 'authentication'
          : response.status === 404 ? 'model_unavailable' : response.status === 413 ? 'input_too_long'
          : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'service'
          : response.status === 400 || response.status === 422 ? 'configuration' : 'unknown';
        return this.createEmbeddingErrorResponse(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`, code);
      }

      const data = await response.json() as OpenAIEmbeddingResponse;
      const count = Array.isArray(normalizedInput) ? normalizedInput.length : 1;
      if (typeof data !== 'object' || data === null || !Array.isArray(data.data)
        || data.data.some((row) => typeof row !== 'object' || row === null)) {
        return this.createEmbeddingErrorResponse('向量响应不是有效数据对象', 'invalid_response');
      }
      const rows = data.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== count || rows.some((row, index) =>
        row.index !== index || !isValidEmbeddingVector(row.embedding)
        || row.embedding.length !== rows[0].embedding!.length
        || !row.embedding.some((value) => value !== 0))) {
        return this.createEmbeddingErrorResponse('向量响应数量、顺序、维度或数值不符合契约', 'invalid_response');
      }
      const embeddings = rows.map((row) => row.embedding!);

      return {
        embeddings,
        model: data.model || this.config.model || null,
        promptTokens: data.usage?.prompt_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
        success: true,
        error: null,
      };
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createEmbeddingErrorResponse(errorMessage, error instanceof SyntaxError ? 'invalid_response'
        : error instanceof TypeError ? 'network' : 'unknown');
    }
  }

  /**
   * 发送聊天请求（非流式）
   *
   * @param messages - 消息列表
   * @param options - 额外选项
   * @returns AI 响应
   */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const {
      includeSystemPrompt = true,
      allowReasoningLengthRetry = true,
      allowImageContentFallback = true,
      responseFormat,
      signal,
    } = options;

    try {
      const requestMessages = this.buildRequestMessages(
        messages,
        includeSystemPrompt
      );
      const requestBody = this.buildRequestBody({
        messages: requestMessages,
        responseFormat,
      });

      const data = await this.sendRequest(requestBody, { signal, allowImageContentFallback });

      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error('Invalid API response: no choices');
      }

      const toolCalls = data.parsedToolCalls;
      const extraction = data.extraction;

      const maxTokens = this.config.maxTokens;
      if (
        allowReasoningLengthRetry
        && maxTokens != null
        && shouldRetryForReasoningOnlyCompletion(choice, extraction)
      ) {
        const nextMaxTokens = getExpandedMaxTokens(maxTokens);

        return this.runWithTemporaryMaxTokens(nextMaxTokens, () => this.chat(messages, {
          includeSystemPrompt,
          allowReasoningLengthRetry: false,
          allowImageContentFallback,
          responseFormat,
          signal,
        }));
      }

      if (toolCalls.length > 0) {
        return {
          ...this.createSuccessResponse(data, toolCalls, true, choice.finish_reason),
          text: '',
        };
      }

      return this.createSuccessResponse(data, [], false, choice.finish_reason);
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(errorMessage, error instanceof AIHttpError ? error.status : null);
    }
  }

  /**
   * 发送聊天请求（流式）
   */
  async chatStream(messages: ChatMessage[], options: ChatStreamOptions = {}): Promise<ChatResponse> {
    const {
      includeSystemPrompt = true,
      allowImageContentFallback = true,
      signal,
      onDelta,
    } = options;

    try {
      const requestMessages = this.buildRequestMessages(
        messages,
        includeSystemPrompt
      );
      const requestBody = this.buildRequestBody({
        messages: requestMessages,
        stream: true,
      });

      return await this.sendStreamingRequest(requestBody, { signal, onDelta, allowImageContentFallback });
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(errorMessage, error instanceof AIHttpError ? error.status : null);
    }
  }

  /**
   * 发送带工具调用的聊天请求（流式）
   */
  async chatStreamWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatStreamWithToolsOptions = {}
  ): Promise<ChatResponse> {
    const {
      toolChoice = 'auto',
      includeSystemPrompt = true,
      allowImageContentFallback = true,
      signal,
      onDelta,
    } = options;

    try {
      const requestMessages = this.buildRequestMessages(
        messages,
        includeSystemPrompt
      );
      const requestBody = this.buildRequestBody({
        messages: requestMessages,
        tools,
        toolChoice,
        stream: true,
      });

      const response = await this.sendStreamingRequest(requestBody, {
        signal,
        allowImageContentFallback,
        onDelta,
      });
      return response;
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return this.createErrorResponse(errorMessage, error instanceof AIHttpError ? error.status : null);
    }
  }

  /**
   * 发送带工具调用的聊天请求
   *
   * @param messages - 消息列表
   * @param tools - 工具定义列表
   * @param options - 额外选项
   * @returns AI 响应
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatWithToolsOptions = {}
  ): Promise<ChatResponse> {
    const {
      toolChoice = 'auto',
      includeSystemPrompt = true,
      allowReasoningLengthRetry = true,
      allowImageContentFallback = true,
      signal,
    } = options;

    try {
      const requestMessages = this.buildRequestMessages(messages, includeSystemPrompt);
      const requestBody = this.buildRequestBody({
        messages: requestMessages,
        tools,
        toolChoice,
      });

      const data = await this.sendRequest(requestBody, { signal, allowImageContentFallback });

      const choice = data.choices?.[0];
      if (!choice) {
        throw new Error('Invalid API response: no choices');
      }

      const toolCalls = data.parsedToolCalls;
      const extraction = data.extraction;

      const maxTokens = this.config.maxTokens;
      if (
        allowReasoningLengthRetry
        && maxTokens != null
        && toolCalls.length === 0
        && shouldRetryForReasoningOnlyCompletion(choice, extraction)
      ) {
        const nextMaxTokens = getExpandedMaxTokens(maxTokens);

        return this.runWithTemporaryMaxTokens(nextMaxTokens, () => this.chatWithTools(messages, tools, {
          toolChoice,
          includeSystemPrompt,
          allowReasoningLengthRetry: false,
          allowImageContentFallback,
          signal,
        }));
      }

      const isToolCall = choice.finish_reason === 'tool_calls' || toolCalls.length > 0;

      if (isToolCall && toolCalls.length > 0) {
        return this.createSuccessResponse(data, toolCalls, true, choice.finish_reason);
      }

      if (isToolCall && toolCalls.length === 0) {
        throw new Error('Tool call response missing tool_calls payload');
      }

      return this.createSuccessResponse(data, [], false, choice.finish_reason);
    } catch (error) {
      if (isAbortLikeError(error)) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorInfo = getErrorDisplayInfo(errorMessage);
      const isRecoverableRequestError = [
        'param',
        'service_busy',
        'quota',
        'auth',
        'permission',
        'not_found',
        'network',
        'timeout',
        'request',
      ].includes(errorInfo.type || '');

      const logger = isRecoverableRequestError ? console.warn : console.error;
      logger('[BaseAIClient] Chat with tools failed:', {
        type: errorInfo.type,
        title: errorInfo.title,
        message: errorInfo.message,
        requestURL: `${this.baseURL}/chat/completions`,
        model: this.config.model,
      });

      return this.createErrorResponse(errorMessage, error instanceof AIHttpError ? error.status : null);
    }
  }

  /**
   * 测试连接
   * 发送一个简单的请求验证配置是否正确
   *
   * @returns 连接测试结果
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const response = await this.chat(
        [{ role: 'user', content: 'Hi' }],
        { includeSystemPrompt: false, allowReasoningLengthRetry: false }
      );

      return {
        success: response.success,
        error: response.error,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  /**
   * 更新配置
   * @param newConfig - 新配置
   */
  updateConfig(newConfig: Partial<AIClientConfig>): void {
    this.config = { ...this.config, ...newConfig };

    if (newConfig.baseURL) {
      this.baseURL = this.buildBaseURL(newConfig.baseURL);
    }
  }

  private async runWithTemporaryMaxTokens<T>(maxTokens: number, callback: () => Promise<T>): Promise<T> {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0 || maxTokens === this.config.maxTokens) {
      return callback();
    }

    const previousMaxTokens = this.config.maxTokens;
    this.config.maxTokens = maxTokens;

    try {
      return await callback();
    } finally {
      this.config.maxTokens = previousMaxTokens;
    }
  }
}

/**
 * 标准化工具调用数据（兼容不同 OpenAI 兼容实现）
 * @param toolCalls - 原始工具调用数据
 * @returns 标准化的工具调用列表
 */
function normalizeToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((tc: unknown, index: number): ToolCall | null => {
      const tcObj = tc as {
        id?: string;
        tool_call_id?: string;
        type?: string;
        function?: { arguments?: unknown; name?: string };
        function_call?: { arguments?: unknown; name?: string };
        name?: string;
      };
      const fn = tcObj.function || tcObj.function_call || {};
      let args: string;
      if (fn.arguments && typeof fn.arguments !== 'string') {
        try {
          args = JSON.stringify(fn.arguments);
        } catch {
          args = String(fn.arguments);
        }
      } else if (typeof fn.arguments === 'string') {
        args = fn.arguments;
      } else {
        args = '{}';
      }

      const name = fn.name || tcObj.name;
      if (!name) return null;

      return {
        id: tcObj.id || tcObj.tool_call_id || `tool_call_${index}`,
        type: (tcObj.type as 'function') || 'function',
        function: {
          name,
          arguments: args,
        },
      };
    })
    .filter((tc): tc is ToolCall => tc !== null && tc.function?.name !== undefined);
}

interface StreamingToolCallState {
  index: number;
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  done: boolean;
}

function createStreamingToolCallAccumulator(
  onDelta?: (delta: ChatStreamDelta) => void | Promise<void>
) {
  const statesByIndex = new Map<number, StreamingToolCallState>();

  const getState = (index: number): StreamingToolCallState => {
    const existing = statesByIndex.get(index);
    if (existing) {
      return existing;
    }

    const state: StreamingToolCallState = {
      index,
      id: `tool_call_${index}`,
      name: '',
      arguments: '',
      started: false,
      done: false,
    };
    statesByIndex.set(index, state);
    return state;
  };

  const emitStartIfNeeded = async (state: StreamingToolCallState): Promise<void> => {
    if (state.started) {
      return;
    }

    state.started = true;
    await onDelta?.({
      type: 'tool_call_start',
      toolCallId: state.id,
      index: state.index,
      ...(state.name ? { name: state.name } : {}),
    });
  };

  const processRawToolCalls = async (
    rawToolCalls: unknown,
    options: { finalize?: boolean } = {}
  ): Promise<void> => {
    if (!Array.isArray(rawToolCalls)) {
      return;
    }

    for (const rawToolCall of rawToolCalls) {
      const raw = rawToolCall as {
        index?: number;
        id?: string;
        tool_call_id?: string;
        function?: { name?: string; arguments?: unknown };
        function_call?: { name?: string; arguments?: unknown };
        name?: string;
      };
      const fallbackIndex = rawToolCalls.indexOf(rawToolCall);
      const index = Number.isInteger(raw.index) ? Number(raw.index) : fallbackIndex;
      const state = getState(index);
      const fn = raw.function || raw.function_call || {};
      const nextId = raw.id || raw.tool_call_id;
      const nextName = fn.name || raw.name;
      const argumentsDelta = normalizeToolCallArgumentsDelta(fn.arguments);

      if (nextId) {
        state.id = nextId;
      }
      if (nextName) {
        state.name = nextName;
      }

      if (nextId || nextName) {
        await emitStartIfNeeded(state);
      }

      if (argumentsDelta) {
        await emitStartIfNeeded(state);
        state.arguments += argumentsDelta;
        await onDelta?.({
          type: 'tool_call_args_delta',
          toolCallId: state.id,
          index: state.index,
          argumentsDelta,
        });
      }

      if (options.finalize && state.name && !state.done) {
        await emitStartIfNeeded(state);
        state.done = true;
        await onDelta?.({
          type: 'tool_call_done',
          toolCallId: state.id,
          index: state.index,
          name: state.name,
          arguments: state.arguments || '{}',
        });
      }
    }
  };

  const finalizeOpenCalls = async (): Promise<void> => {
    const states = Array.from(statesByIndex.values()).sort((left, right) => left.index - right.index);
    for (const state of states) {
      if (!state.name || state.done) {
        continue;
      }

      await emitStartIfNeeded(state);
      state.done = true;
      await onDelta?.({
        type: 'tool_call_done',
        toolCallId: state.id,
        index: state.index,
        name: state.name,
        arguments: state.arguments || '{}',
      });
    }
  };

  const getToolCalls = (): ToolCall[] => (
    Array.from(statesByIndex.values())
      .sort((left, right) => left.index - right.index)
      .filter((state) => Boolean(state.name))
      .map((state) => ({
        id: state.id,
        type: 'function' as const,
        function: {
          name: state.name,
          arguments: state.arguments || '{}',
        },
      }))
  );

  return {
    processRawToolCalls,
    finalizeOpenCalls,
    getToolCalls,
  };
}

function normalizeToolCallArgumentsDelta(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function sendStreamingRequestWithXMLHttpRequest(params: {
  url: string;
  apiKey: string;
  requestBody: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: ChatStreamDelta) => void | Promise<void>;
  parseThinkTags: boolean;
  reasoningContext: ReasoningCompletionContext;
}): Promise<ChatResponse> {
  const body = JSON.stringify(params.requestBody);
  const capture = await beginAIHttpCapture({ url: params.url, requestBody: body,
    model: String(params.requestBody.model ?? ''), transport: 'stream' }, params.apiKey);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const parser = createOpenAICompatibleSSEParser(params.onDelta, params.parseThinkTags, params.signal, params.reasoningContext);
    let processedLength = 0;
    let progressChain = Promise.resolve();
    let settled = false;
    let lastResponseText = '';
    let responseContainsFailure = false;

    const saveResponse = () => {
      // Android 取消 XHR 后可能清空 responseText；保留取消前已收到的文本。
      const rawText = responseContainsFailure ? '' : String(xhr.responseText || '');
      if (rawText) lastResponseText = rawText;
      if (xhr.status > 0) capture?.setResponse(xhr.status, lastResponseText);
      else capture?.appendResponse(lastResponseText);
    };

    const cleanup = () => {
      params.signal?.removeEventListener('abort', handleAbort);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      saveResponse();
      void Promise.resolve(capture?.finish(error, parser.protocolIssues())).then(() => reject(error));
    };

    const settleResolve = (response: ChatResponse) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      saveResponse();
      void Promise.resolve(capture?.finish(undefined, parser.protocolIssues())).then(() => resolve(response));
    };

    const consumeNewText = (isFinal = false) => {
      const responseText = String(xhr.responseText || '');
      lastResponseText = responseText;
      const nextChunk = responseText.slice(processedLength);
      processedLength = responseText.length;
      progressChain = progressChain.then(async () => {
        if (settled) return;
        await parser.push(nextChunk, isFinal);
        if (isFinal) settleResolve(parser.getResponse());
      }).catch(error => {
        if (settled) return;
        // 流内错误可能早于连接结束；先取出已收到的原文，再释放传输。
        settleReject(error);
        if (!isFinal) xhr.abort();
      });
    };

    function handleAbort() {
      lastResponseText = String(xhr.responseText || '') || lastResponseText;
      xhr.abort();
      settleReject(new Error('Request aborted'));
    }

    if (params.signal?.aborted) {
      settleReject(new Error('Request aborted'));
      return;
    }

    params.signal?.addEventListener('abort', handleAbort);

    try {
      xhr.open('POST', params.url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', `Bearer ${params.apiKey}`);

      xhr.onprogress = () => {
        if (xhr.status >= 200 && xhr.status < 300) consumeNewText(false);
      };

      xhr.onerror = () => {
        // RN 在错误回调前把 responseText 替换为原生连接原因；它不是服务端响应正文。
        responseContainsFailure = true;
        const reason = xhr.responseText.trim();
        settleReject(new Error(reason ? `Network request failed: ${reason}` : 'Network request failed'));
      };

      xhr.ontimeout = () => {
        responseContainsFailure = true;
        const reason = xhr.responseText.trim();
        settleReject(new Error(reason ? `Network request timed out: ${reason}` : 'Network request timed out'));
      };

      xhr.onload = () => {
        // HTTP 拒绝正文不属于成功的 SSE，不能提前发布 done 或让解析错误遮住状态码。
        if (xhr.status < 200 || xhr.status >= 300) {
          settleReject(new AIHttpError(xhr.status, extractXHRStreamingError(xhr)));
          return;
        }
        consumeNewText(true);
      };

      xhr.send(body);
    } catch (error) { settleReject(error); }
  });
}

function extractXHRStreamingError(xhr: XMLHttpRequest): string {
  const rawText = String(xhr.responseText || '').trim();
  if (!rawText) {
    return xhr.statusText || 'Request failed';
  }

  return parseHTTPErrorBody(rawText);
}

function createOpenAICompatibleSSEParser(
  onDelta?: (delta: ChatStreamDelta) => void | Promise<void>,
  parseThinkTags = false,
  signal?: AbortSignal,
  context: ReasoningCompletionContext = { hasToolCalls: false, replayContract: 'details' },
) {
  let buffer = '';
  let finished = false;
  let messageId: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens: number | undefined;
  let finishReason: string | null = null;
  let isToolCall = false;
  const decoder = new OpenAIMessageDecoder(parseThinkTags);
  let completedText: AssistantTextResult;
  const emit = async (event: ChatStreamDelta) => {
    if (signal?.aborted) throw new Error('Request aborted');
    await onDelta?.(event);
  };
  const toolCallAccumulator = createStreamingToolCallAccumulator(emit);
  const emitText = async (events: ChatStreamDelta[]) => {
    for (const event of events) {
      await emit(event);
    }
  };
  const finish = async () => {
    if (finished) return;
    await emitText(decoder.finish());
    await toolCallAccumulator.finalizeOpenCalls();
    completedText = decoder.complete({ ...context,
      hasToolCalls: toolCallAccumulator.getToolCalls().length > 0 || finishReason === 'tool_calls' });
    finished = true;
    await emit({ type: 'done' });
  };
  const handlePayload = async (payloadText: string) => {
    if (finished || !payloadText.trim()) return;
    if (signal?.aborted) throw new Error('Request aborted');
    if (payloadText.trim() === '[DONE]') { await finish(); return; }
    const payload = JSON.parse(payloadText) as {
      error?: unknown;
      id?: string;
      choices?: { delta?: OpenAIAssistantPayload; message?: OpenAIAssistantPayload; finish_reason?: string | null }[];
      usage?: OpenAIChatUsage | null;
    };
    if (payload.error != null) throw new Error(`模型流式接口错误：${readProviderError(payload)}`);
    messageId = payload.id || messageId;
    if (payload.usage) {
      promptTokens = payload.usage.prompt_tokens || promptTokens;
      completionTokens = payload.usage.completion_tokens || completionTokens;
      totalTokens = payload.usage.total_tokens || totalTokens;
      cachedTokens = readCachedTokens(payload.usage) ?? cachedTokens;
    }
    const choice = payload.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    const message = choice?.message;
    if (delta) await emitText(decoder.append(delta));
    if (message) await emitText(decoder.snapshot(message));
    if (delta?.tool_calls || message?.tool_calls || choice?.finish_reason === 'tool_calls') {
      isToolCall = true;
      await toolCallAccumulator.processRawToolCalls(delta?.tool_calls, { finalize: choice?.finish_reason === 'tool_calls' });
      await toolCallAccumulator.processRawToolCalls(message?.tool_calls, { finalize: true });
      if (choice?.finish_reason === 'tool_calls') await toolCallAccumulator.finalizeOpenCalls();
    }
  };
  const consumeEvent = async (raw: string) => {
    const lines = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
    if (lines.length) await handlePayload(lines.join('\n'));
  };
  const push = async (chunk: string, isFinal = false): Promise<boolean> => {
    if (finished) return true;
    buffer += chunk;
    let separator: RegExpExecArray | null;
    while (!finished && (separator = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      await consumeEvent(event);
    }
    if (isFinal && !finished) {
      if (buffer.trim()) await consumeEvent(buffer);
      buffer = '';
      await finish();
    }
    return finished;
  };
  const getResponse = (): ChatResponse => {
    const text = completedText;
    const toolCalls = toolCallAccumulator.getToolCalls();
    return {
      text: text.text, reasoningText: text.reasoningText,
      ...(text.reasoningReplay ? { reasoningReplay: text.reasoningReplay } : {}),
      finishReason, messageId, promptTokens, completionTokens, totalTokens, cachedTokens,
      success: true, error: null, toolCalls: isToolCall ? toolCalls : null,
      isToolCall: isToolCall && toolCalls.length > 0,
    };
  };
  return { push, getResponse, protocolIssues: () => decoder.protocolIssues };
}

async function readOpenAICompatibleSSE(
  response: Response,
  onDelta?: (delta: ChatStreamDelta) => void | Promise<void>,
  onRawText?: (chunk: string) => void,
  onRawError?: (error: unknown) => void,
  parseThinkTags = false,
  signal?: AbortSignal,
  context: ReasoningCompletionContext = { hasToolCalls: false, replayContract: 'details' },
  onProtocolIssues?: (issues: readonly AIProtocolIssue[]) => void,
): Promise<ChatResponse> {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Streaming response body unavailable');
  const textDecoder = new TextDecoder('utf-8');
  const parser = createOpenAICompatibleSSEParser(onDelta, parseThinkTags, signal, context);
  let modelDone = false;
  let parseFailure: unknown;
  let parsingFailed = false;
  try {
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try { readResult = await reader.read(); }
      catch (error) {
        if (!modelDone) throw error;
        onRawError?.(error);
        break;
      }
      const rawText = readResult.done ? textDecoder.decode() : textDecoder.decode(readResult.value, { stream: true });
      onRawText?.(rawText);
      if (!modelDone && !parsingFailed) {
        try { modelDone = await parser.push(rawText, readResult.done); }
        catch (error) {
          if (!onRawText) throw error;
          parseFailure = error;
          parsingFailed = true;
        }
      }
      if (readResult.done || (modelDone && !onRawText)) break;
    }
  } finally { onProtocolIssues?.(parser.protocolIssues()); reader.releaseLock(); }
  if (parsingFailed) throw parseFailure;
  return parser.getResponse();
}

/** 缓存统计只在 Provider 边界归一化；0 与未提供数据保持不同语义。 */
function readCachedTokens(usage?: OpenAIChatUsage | null): number | undefined {
  const value = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('服务商返回的缓存 token 数无效');
  }
  return value;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }

  const candidate = typeof error === 'object' ? error : null;
  const name = candidate && 'name' in candidate ? String((candidate as { name?: string }).name || '') : '';
  const message = candidate && 'message' in candidate
    ? String((candidate as { message?: string }).message || '')
    : String(error || '');

  return name === 'AbortError' || /aborted|aborterror/i.test(message);
}

function isValidEmbeddingVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

/** 只为已知可切换系列补开启参数，避免给旧版非思考模型改变请求契约。 */
/**
 * 判断是否因为 reasoning 内容过长而截断，导致最终答案缺失
 * @param choice - API 返回的 choice
 * @param extraction - 文本提取结果
 * @returns 是否需要重试
 */
function shouldRetryForReasoningOnlyCompletion(
  choice: { finish_reason?: string },
  extraction: AssistantTextResult
): boolean {
  return (
    choice?.finish_reason === 'length'
    && extraction?.source === 'reasoning'
    && !extraction?.contentText
    && Boolean(extraction?.reasoningText)
  );
}

/**
 * 为 reasoning-only 截断场景扩容 max_tokens
 * @param currentMaxTokens - 当前最大 token 数
 * @returns 扩容后的 token 数
 */
function getExpandedMaxTokens(currentMaxTokens: number): number {
  return Math.min(Math.max(currentMaxTokens * 2, 1024), 4096);
}

/**
 * DeepSeek 纯历史正文的兼容：空串只表示没有保存协议思考，不等于恢复思考。
 * 真实工具轮及已有思考保持原样；缺失工具轮思考由服务端明确拒绝。
 */
function withDeepSeekHistoryReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message): ChatMessage => {
    if (message.role !== 'assistant' || (message.tool_calls?.length ?? 0) > 0) {
      return message;
    }
    const reasoningContent = message.reasoning_content;
    if (reasoningContent !== undefined) {
      return message;
    }
    return {
      ...message,
      reasoning_content: '',
    };
  });
}

function sanitizeRequestMessages(messages: ChatMessage[]): ChatMessage[] {
  return (messages || [])
    .map(normalizeRequestMessage)
    .filter((msg): msg is ChatMessage => msg !== null);
}

function stripImagePartsFromMessages(messages: ChatMessage[]): ChatMessage[] | null {
  if (!Array.isArray(messages)) {
    return null;
  }

  let changed = false;
  const normalizedMessages = messages.map((message): ChatMessage => {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
      return message;
    }

    const nextTextParts: string[] = [];
    let removedImageCount = 0;

    message.content.forEach((part) => {
      if (part?.type === 'image_url') {
        changed = true;
        removedImageCount += 1;
        return;
      }

      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        // 旧的直接视觉标记不能在文字降级后继续声称原图已交付。
        nextTextParts.push(part.text.split('\n[视觉输入状态：原图已直接提供]')[0].trim());
      }
    });

    if (removedImageCount > 0) {
      nextTextParts.push(buildImageFallbackPrompt(removedImageCount));
    }

    return {
      ...message,
      content: nextTextParts.join('\n').trim(),
    };
  });

  if (!changed) {
    return null;
  }

  return sanitizeRequestMessages(normalizedMessages);
}

function buildImageFallbackPrompt(imageCount = 1): string {
  const imageText = imageCount > 1 ? `${imageCount}张图片` : '一张图片';
  return [
    `[视觉输入状态：图片输入被接口拒绝，未收到原图] 本次${imageText}没有成功提供给模型，这不代表模型永久不支持视觉。`,
    '请基于已有文字上下文先自然回应，并明确告诉用户你暂时无法直接看图；如果用户希望你继续分析，请提醒用户补充图片中的关键信息或文字描述。',
  ].join('\n');
}

function normalizeRequestMessage(message: ChatMessage): ChatMessage | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const normalized = { ...message };
  if (Array.isArray(normalized.content)) {
    normalized.content = normalized.content.filter((part) => !isContentPartEmpty(part));
  }

  if (!isMessageContentEmpty(normalized.content)) {
    return normalized;
  }

  if (normalized.role === 'assistant') {
    const hasToolCalls = Array.isArray(normalized.tool_calls) && normalized.tool_calls.length > 0;
    const hasReasoning = normalized.reasoningReplay !== undefined || typeof normalized.reasoning_content === 'string'
      && normalized.reasoning_content.trim().length > 0;
    if (hasToolCalls || hasReasoning) {
      return normalized;
    }
  }

  console.warn('[BaseAIClient] Dropping empty request message before sending', {
    role: normalized.role,
  });
  return null;
}

function isMessageContentEmpty(content: string | unknown[] | null | undefined): boolean {
  if (Array.isArray(content)) {
    return content.length === 0 || content.every(isContentPartEmpty);
  }

  if (typeof content === 'string') {
    return content.trim().length === 0;
  }

  return content === null || content === undefined;
}

interface ContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
}

function isContentPartEmpty(part: ContentPart): boolean {
  if (!part || typeof part !== 'object') {
    return true;
  }

  if (part.type === 'text') {
    return typeof part.text !== 'string' || part.text.trim().length === 0;
  }

  if (part.type === 'image_url') {
    return !part.image_url || typeof part.image_url.url !== 'string' || part.image_url.url.trim().length === 0;
  }

  return false;
}

function shouldRetryWithoutImageParts(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('image_url')
    || normalized.includes('unknown variant `image_url`')
    || normalized.includes('unknown variant "image_url"')
    || normalized.includes('expected `text`')
    || normalized.includes('expected "text"')
    || normalized.includes('does not support image')
    || normalized.includes('unsupported image')
    || normalized.includes('invalid image')
    || normalized.includes('image dimensions')
    || normalized.includes('image size')
  );
}

function shouldRetryWithoutResponseFormat(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('response_format')
    || normalized.includes('json_object')
    || normalized.includes('json mode')
  ) && (
    normalized.includes('unsupported')
    || normalized.includes('not supported')
    || normalized.includes('unknown')
    || normalized.includes('invalid')
    || normalized.includes('unrecognized')
  );
}

function getMaxTokensFieldCacheKey(baseURL: string, model: string): string {
  return `${String(baseURL || '').trim()}::${String(model || '').trim()}`;
}

function getCachedMaxTokensFieldName(baseURL: string, model: string): string {
  return maxTokensFieldCache.get(getMaxTokensFieldCacheKey(baseURL, model)) || 'max_tokens';
}

function setCachedMaxTokensFieldName(baseURL: string, model: string, fieldName: string): void {
  maxTokensFieldCache.set(getMaxTokensFieldCacheKey(baseURL, model), fieldName);
}

function getRequestBodyMaxTokensFieldName(requestBody: Record<string, unknown>): string | null {
  if (!requestBody || typeof requestBody !== 'object') {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(requestBody, 'max_completion_tokens')) {
    return 'max_completion_tokens';
  }

  if (Object.prototype.hasOwnProperty.call(requestBody, 'max_tokens')) {
    return 'max_tokens';
  }

  return null;
}

function omitKey<T extends Record<string, unknown>>(source: T, keyToOmit: string): Omit<T, string> {
  const result = { ...source };
  delete (result as Record<string, unknown>)[keyToOmit];
  return result;
}
