/** 图片生成的单次 HTTP 边界；按显式供应商映射协议，不重放计费请求。 */
import { getErrorDisplayInfo, redactAIErrorMessage } from './errorMapping';
import { beginAIHttpCapture } from './HttpExchangeCapture';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { fetch as fetchNative } from 'expo/fetch';
import { buildImageGenerationRequest, type ImageGenerationConnection, type ImageGenerationReference } from './ImageGenerationRequest';
import { ImageGenerationStreamError, readImageGenerationStream, type ImageGenerationPreview } from './ImageGenerationStream';
import type { ImageGenerationParameters } from './imageGenerationConfig';

export type GeneratedImageContent = { kind: 'base64'; base64: string } | { kind: 'url'; url: string };
export type ImageGenerationResult = { success: true; image: GeneratedImageContent }
  | { success: false; error: string; httpStatus: number | null; code: string; retryable: boolean };

function invalidResponse(): ImageGenerationResult {
  return { success: false, error: '服务未返回有效的单张图片', httpStatus: null, code: 'IMAGE_GENERATION_INVALID_RESPONSE', retryable: false };
}
function parseImage(body: unknown): ImageGenerationResult {
  if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data) || body.data.length !== 1) return invalidResponse();
  const item: unknown = body.data[0];
  if (typeof item !== 'object' || item === null) return invalidResponse();
  if ('b64_json' in item && typeof item.b64_json === 'string' && item.b64_json.trim()) {
    return { success: true, image: { kind: 'base64', base64: item.b64_json.trim() } };
  }
  if ('url' in item && typeof item.url === 'string' && item.url.trim()) {
    try {
      const url = new URL(item.url.trim());
      if (url.protocol === 'https:') return { success: true, image: { kind: 'url', url: item.url.trim() } };
    } catch { /* 外部响应字段不是有效 URL。 */ }
  }
  return invalidResponse();
}

function parseQwenImage(body: unknown): ImageGenerationResult {
  if (typeof body !== 'object' || body === null || !('output' in body)) return invalidResponse();
  const output = body.output;
  if (typeof output !== 'object' || output === null || !('choices' in output)
    || !Array.isArray(output.choices) || output.choices.length !== 1) return invalidResponse();
  const choice: unknown = output.choices[0];
  if (typeof choice !== 'object' || choice === null || !('message' in choice)) return invalidResponse();
  const message = choice.message;
  if (typeof message !== 'object' || message === null || !('content' in message) || !Array.isArray(message.content)) return invalidResponse();
  const images = message.content.flatMap((item: unknown) => typeof item === 'object' && item !== null && 'image' in item ? [{ url: item.image }] : []);
  return parseImage({ data: images });
}

export async function generateImage(config: ImageGenerationConnection, prompt: string, signal: AbortSignal,
  options: { parameters?: ImageGenerationParameters; reference?: ImageGenerationReference; onPreview?: (preview: ImageGenerationPreview) => void } = {}): Promise<ImageGenerationResult> {
  throwIfAbortSignalAborted(signal);
  const request = buildImageGenerationRequest(config, prompt, options.parameters ?? {}, options.reference, options.onPreview !== undefined);
  const { url, body } = request;
  // 诊断保留请求形状与分类，不落盘签名 URL、大块图片或提示词。
  const capture = await beginAIHttpCapture({ url, requestBody: request.diagnosticBody, model: config.model, transport: 'complete' }, config.apiKey);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
  let httpStatus: number | null = null;
  let diagnosticError: string | undefined;
  try {
    throwIfAbortSignalAborted(signal);
    const response = await (request.stream || !request.json ? fetchNative : fetch)(url, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { ...(request.json ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${config.apiKey}` }, body, signal: controller.signal });
    httpStatus = response.status;
    const raw = !response.ok || !request.stream ? await response.text() : null;
    throwIfAbortSignalAborted(signal);
    if (!response.ok) {
      const error = redactAIErrorMessage(`HTTP ${response.status}: ${raw}`, config.apiKey);
      const info = getErrorDisplayInfo(error, { httpStatus });
      const code = info.type === 'timeout' ? 'IMAGE_GENERATION_SERVER_TIMEOUT' : `IMAGE_GENERATION_${info.type.toUpperCase()}`;
      capture?.setResponse(httpStatus, code);
      diagnosticError = code;
      return { success: false, error, httpStatus, code, retryable: ['timeout', 'network', 'service_busy'].includes(info.type) || httpStatus >= 500 };
    }
    let parsed: unknown;
    try { parsed = request.stream ? await readImageGenerationStream(response, signal, options.reference ? 'image_edit' : 'image_generation', options.onPreview) : JSON.parse(raw!); }
    catch (error) {
      throwIfAbortSignalAborted(signal);
      if (timedOut) throw error;
      if (request.stream && !(error instanceof ImageGenerationStreamError)) throw error;
      const message = redactAIErrorMessage(error instanceof Error ? error.message : String(error), config.apiKey);
      if (error instanceof ImageGenerationStreamError && error.kind === 'provider') {
        const info = getErrorDisplayInfo(message);
        const code = info.type === 'timeout' ? 'IMAGE_GENERATION_SERVER_TIMEOUT' : `IMAGE_GENERATION_${info.type.toUpperCase()}`;
        capture?.setResponse(httpStatus, code);
        return { success: false, error: message, httpStatus, code, retryable: ['timeout', 'service_busy', 'network'].includes(info.type) };
      }
      capture?.setResponse(httpStatus, 'invalid_response');
      return { success: false, error: message, httpStatus, code: 'IMAGE_GENERATION_INVALID_RESPONSE', retryable: false };
    }
    if (config.profile.provider === 'siliconflow') {
      if (typeof parsed !== 'object' || parsed === null || !('images' in parsed)) return invalidResponse();
      parsed = { data: parsed.images };
    }
    if (config.profile.provider === 'minimax') {
      const record = parsed as { base_resp?: { status_code?: number; status_msg?: string }; data?: { image_urls?: unknown; image_base64?: unknown } };
      if (!record || typeof record !== 'object' || !record.base_resp || record.base_resp.status_code !== 0) {
        const error = redactAIErrorMessage(record?.base_resp?.status_msg ?? 'MiniMax 返回了无效响应', config.apiKey);
        capture?.setResponse(httpStatus, 'provider_error');
        const info = getErrorDisplayInfo(error);
        return { success: false, error, httpStatus, code: info.type === 'timeout' ? 'IMAGE_GENERATION_SERVER_TIMEOUT' : `IMAGE_GENERATION_${info.type.toUpperCase()}`, retryable: ['timeout', 'service_busy', 'network'].includes(info.type) };
      }
      const data = record.data;
      if (Array.isArray(data?.image_base64) && data.image_base64.length > 0) parsed = { data: data.image_base64.map(base64 => ({ b64_json: base64 })) };
      else if (Array.isArray(data?.image_urls)) parsed = { data: data.image_urls.map(url => ({ url })) };
      else return invalidResponse();
    }
    const result = config.profile.provider === 'qwen' ? parseQwenImage(parsed) : parseImage(parsed);
    capture?.setResponse(httpStatus, result.success ? `[图片内容已省略：${result.image.kind}]` : 'invalid_response');
    return result;
  } catch (error) {
    if (signal.aborted) diagnosticError = '请求已取消';
    throwIfAbortSignalAborted(signal);
    if (error instanceof Error && error.name === 'AbortError' && !timedOut) throw error;
    diagnosticError = timedOut ? '本地等待生图超时，请手动重试；服务端可能已完成生成。' : redactAIErrorMessage(error instanceof Error ? error.message : String(error), config.apiKey);
    return { success: false, error: diagnosticError, httpStatus, code: timedOut ? 'IMAGE_GENERATION_LOCAL_TIMEOUT' : 'IMAGE_GENERATION_NETWORK', retryable: true };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await capture?.finish(diagnosticError);
  }
}
