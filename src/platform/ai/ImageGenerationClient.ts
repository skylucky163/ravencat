/** 图片生成的 HTTP 边界；按显式供应商映射协议，每次生成只提交一次计费请求。 */
import { getErrorDisplayInfo, redactAIErrorMessage } from './errorMapping';
import { beginAIHttpCapture } from './HttpExchangeCapture';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { fetch as fetchNative } from 'expo/fetch';
import { buildImageGenerationRequest, type ImageGenerationConnection, type ImageGenerationReference } from './ImageGenerationRequest';
import { ImageGenerationStreamError, readImageGenerationStream, type ImageGenerationPreview } from './ImageGenerationStream';
import type { ImageGenerationParameters } from './imageGenerationConfig';
import { readImageParameterRejection, readImageRequestError, readImageResponseQuality, verifyImageParameter, type GeneratedImageDetails, type ImageParameterCheck, type ImageParameterCheckResult, type ImageParameterRejection } from './ImageGenerationParameterCheck';

export type GeneratedImageContent = { kind: 'base64'; base64: string } | { kind: 'url'; url: string };
type ImageGenerationError = { success: false; error: string; httpStatus: number | null; code: string; retryable: boolean };
type ImageGenerationSuccess = { success: true; image: GeneratedImageContent };
export type ImageGenerationResult = ImageGenerationSuccess | ImageGenerationError;
type ImageRequestResult = (ImageGenerationSuccess & { reportedQuality?: string }) | (ImageGenerationError & { rejection?: ImageParameterRejection });

function invalidResponse(): ImageGenerationError {
  return { success: false, error: '服务未返回有效的单张图片', httpStatus: null, code: 'IMAGE_GENERATION_INVALID_RESPONSE', retryable: false };
}

function httpFailure(httpStatus: number, raw: string, apiKey: string): ImageGenerationError {
  const error = redactAIErrorMessage(`HTTP ${httpStatus}: ${raw}`, apiKey);
  const info = getErrorDisplayInfo(error, { httpStatus });
  const code = info.type === 'timeout' ? 'IMAGE_GENERATION_SERVER_TIMEOUT' : `IMAGE_GENERATION_${info.type.toUpperCase()}`;
  return { success: false, error, httpStatus, code, retryable: ['timeout', 'network', 'service_busy'].includes(info.type) || httpStatus >= 500 };
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

function readKlingEnvelope(body: unknown): { code: number; message?: unknown; data?: unknown } | null {
  if (typeof body !== 'object' || body === null || !('code' in body) || typeof body.code !== 'number') return null;
  return { code: body.code, message: 'message' in body ? body.message : undefined, data: 'data' in body ? body.data : undefined };
}

function klingTaskFailure(message: unknown, httpStatus: number, apiKey: string): ImageGenerationError {
  const error = typeof message === 'string' && message.trim() ? redactAIErrorMessage(message, apiKey) : '可灵生图任务失败';
  return { success: false, error, httpStatus, code: 'IMAGE_GENERATION_KLING_TASK_FAILED', retryable: false };
}

function waitForKlingTask(signal: AbortSignal): Promise<void> {
  throwIfAbortSignalAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 3_000);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readKlingImage(body: unknown, createURL: string, apiKey: string, signal: AbortSignal): Promise<ImageGenerationResult> {
  const created = readKlingEnvelope(body);
  if (!created) return invalidResponse();
  if (created.code !== 0) return klingTaskFailure(created.message, 200, apiKey);
  const task = created.data;
  if (typeof task !== 'object' || task === null || !('id' in task) || typeof task.id !== 'string' || !task.id.trim()) return invalidResponse();
  const taskId = task.id;
  const queryURL = `${new URL('/tasks', createURL)}?task_ids=${encodeURIComponent(taskId)}`;
  for (;;) {
    throwIfAbortSignalAborted(signal);
    const response = await fetch(queryURL, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Authorization: `Bearer ${apiKey}` }, signal });
    const raw = await response.text();
    throwIfAbortSignalAborted(signal);
    if (!response.ok) return { ...httpFailure(response.status, raw, apiKey), retryable: false };
    let queried: ReturnType<typeof readKlingEnvelope>;
    try { queried = readKlingEnvelope(JSON.parse(raw)); }
    catch { return invalidResponse(); }
    if (!queried) return invalidResponse();
    if (queried.code !== 0) return klingTaskFailure(queried.message, response.status, apiKey);
    if (!Array.isArray(queried.data) || queried.data.length !== 1) return invalidResponse();
    const current: unknown = queried.data[0];
    if (typeof current !== 'object' || current === null || !('id' in current) || current.id !== taskId || !('status' in current)) return invalidResponse();
    switch (current.status) {
      case 'failed': return klingTaskFailure('message' in current ? current.message : undefined, response.status, apiKey);
      case 'succeeded': {
        if (!('outputs' in current) || !Array.isArray(current.outputs) || current.outputs.length !== 1) return invalidResponse();
        const output: unknown = current.outputs[0];
        if (typeof output !== 'object' || output === null || !('type' in output) || output.type !== 'image' || !('url' in output)) return invalidResponse();
        return parseImage({ data: [{ url: output.url }] });
      }
      case 'submitted':
      case 'processing':
        // 查询的是已提交的同一任务，取消或超时会结束等待。
        await waitForKlingTask(signal);
        break;
      default: return invalidResponse();
    }
  }
}

interface ImageRequestOptions { parameters?: ImageGenerationParameters; reference?: ImageGenerationReference; onPreview?: (preview: ImageGenerationPreview) => void }

export function generateImage(config: ImageGenerationConnection, prompt: string, signal: AbortSignal, options: ImageRequestOptions = {}): Promise<ImageGenerationResult> {
  return requestGeneratedImage(config, prompt, signal, options);
}

export async function checkImageGenerationParameter(config: ImageGenerationConnection, check: ImageParameterCheck, signal: AbortSignal,
  inspect: (image: GeneratedImageContent, signal: AbortSignal) => Promise<GeneratedImageDetails>): Promise<ImageParameterCheckResult> {
  const result = await requestGeneratedImage(config, 'A red circle on a plain white background.', signal,
    { parameters: { custom: { [check.field]: check.value } } }, check);
  if (result.success === false) return result.rejection ?? { status: 'uncertain', reason: result.error };
  try {
    const details = await inspect(result.image, signal);
    throwIfAbortSignalAborted(signal);
    return verifyImageParameter(check, details, result.reportedQuality);
  } catch {
    throwIfAbortSignalAborted(signal);
    return { status: 'uncertain', reason: '服务已响应，但无法读取成图以确认参数。' };
  }
}

async function requestGeneratedImage(config: ImageGenerationConnection, prompt: string, signal: AbortSignal,
  options: ImageRequestOptions, check?: ImageParameterCheck): Promise<ImageRequestResult> {
  throwIfAbortSignalAborted(signal);
  const request = buildImageGenerationRequest(config, prompt, options.parameters ?? {}, options.reference, options.onPreview !== undefined);
  const { url, body } = request;
  const isKling = config.profile.provider === 'kling';
  const isCustom = config.profile.provider === 'customOpenAIImages';
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
    const init = { method: 'POST', redirect: 'error' as const, credentials: 'omit' as const,
      headers: { ...(request.json ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${config.apiKey}` },
      body, signal: controller.signal, ...(isCustom ? { oneShot: true } : {}) };
    const response = await (isCustom || request.stream || !request.json ? fetchNative : fetch)(url, init);
    httpStatus = response.status;
    const raw = !response.ok || !request.stream ? await response.text() : null;
    throwIfAbortSignalAborted(controller.signal);
    if (!response.ok) {
      const failure = httpFailure(httpStatus, raw!, config.apiKey);
      capture?.setResponse(httpStatus, failure.code);
      diagnosticError = failure.code;
      if (isCustom) {
        if (httpStatus === 400 || httpStatus === 422) {
          const details = readImageRequestError(raw!);
          const rejection = check && details ? readImageParameterRejection(details, check) : undefined;
          // 拒绝响应只展示服务给出的说明，诊断保留分类即可。
          const message = typeof details?.message === 'string'
            ? redactAIErrorMessage(details.message, config.apiKey).replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已省略]').trim().slice(0, 300) : '';
          return { ...failure, error: `生图接口拒绝了请求（HTTP ${httpStatus}）。${message || '服务未返回具体原因，请检查模型 ID 和所选参数。'}`,
            retryable: false, rejection };
        }
        const info = getErrorDisplayInfo(failure.error, { httpStatus });
        return { ...failure, error: `${info.message}（HTTP ${httpStatus}）`, retryable: false };
      }
      return isKling ? { ...failure, retryable: false } : failure;
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
      return { success: false, error: isCustom ? invalidResponse().error : message, httpStatus, code: 'IMAGE_GENERATION_INVALID_RESPONSE', retryable: false };
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
    const result = isKling ? await readKlingImage(parsed, url, config.apiKey, controller.signal)
      : config.profile.provider === 'qwen' ? parseQwenImage(parsed) : parseImage(parsed);
    if (result.success === true) capture?.setResponse(httpStatus, `[图片内容已省略：${result.image.kind}]`);
    else capture?.setResponse(result.httpStatus ?? httpStatus, isKling ? result.code : 'invalid_response');
    if (check && result.success) return { ...result, reportedQuality: readImageResponseQuality(parsed) };
    return result;
  } catch (error) {
    if (signal.aborted) diagnosticError = '请求已取消';
    throwIfAbortSignalAborted(signal);
    if (error instanceof Error && error.name === 'AbortError' && !timedOut) throw error;
    diagnosticError = timedOut ? isKling ? '等待可灵生图超时，任务可能仍在服务端运行，请先在可灵开放平台查看任务状态。'
      : isCustom ? '本地等待生图超时，服务端可能已完成生成。' : '本地等待生图超时，请手动重试；服务端可能已完成生成。'
      : isCustom ? '无法连接生图服务或读取响应，请检查网络和接口地址。'
        : redactAIErrorMessage(error instanceof Error ? error.message : String(error), config.apiKey);
    return { success: false, error: diagnosticError, httpStatus, code: timedOut ? 'IMAGE_GENERATION_LOCAL_TIMEOUT' : 'IMAGE_GENERATION_NETWORK', retryable: !isKling && !isCustom };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await capture?.finish(diagnosticError);
  }
}
