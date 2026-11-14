/** 官方工具共用的凭据与 HTTP 边界；服务商协议映射留在各自 Client。 */
import { fetch } from 'expo/fetch';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { resolveOfficialToolsAPIBaseURL, type OfficialToolProvider } from './officialToolsEndpoint';

export type OfficialToolResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const failure = (code: string, message: string): OfficialToolResult<never> => ({ ok: false, code, message });
export function isOfficialToolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OfficialToolsHttpClient {
  private readonly baseURL: string;
  private readonly codePrefix: string;

  constructor(private readonly config: { provider: OfficialToolProvider; baseURL: string; apiKey: string }) {
    const baseURL = resolveOfficialToolsAPIBaseURL(config.provider, config.baseURL);
    // 发送凭据的边界独占目标检查；不允许重定向携带当前模型的密钥。
    if (!baseURL) throw new Error('官方工具仅支持对应服务商的官方 API 地址');
    this.baseURL = baseURL;
    this.codePrefix = config.provider === 'moonshot' ? 'KIMI_TOOLS' : 'DEEPSEEK_TOOLS';
  }

  async request(path: string, body: object | undefined, signal?: AbortSignal): Promise<OfficialToolResult<unknown>> {
    throwIfAbortSignalAborted(signal);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
    try {
      const response = await fetch(`${this.baseURL}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // 不把服务端错误正文或网络异常带回日志／模型，避免凭据被上游回显。
      if (!response.ok) return failure(`${this.codePrefix}_HTTP_${response.status}`, `官方工具请求失败（HTTP ${response.status}）。`);
      if (!response.body) return failure(`${this.codePrefix}_INVALID_RESPONSE`, '官方工具返回了空响应。');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2 * 1024 * 1024) {
            await reader.cancel();
            return failure(`${this.codePrefix}_RESPONSE_TOO_LARGE`, '官方工具结果超过 2 MiB，请缩小查询范围。');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      try { return { ok: true, data: JSON.parse(text) as unknown }; }
      catch { return failure(`${this.codePrefix}_INVALID_RESPONSE`, '官方工具返回了无效 JSON。'); }
    } catch {
      throwIfAbortSignalAborted(signal);
      return timedOut ? failure(`${this.codePrefix}_TIMEOUT`, '官方工具请求超时。')
        : failure(`${this.codePrefix}_NETWORK_ERROR`, '官方工具网络请求失败。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
