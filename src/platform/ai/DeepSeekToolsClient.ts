/** DeepSeek Search / Fetch 的协议边界；复用官方工具 HTTP 生命周期。 */
import { OfficialToolsHttpClient, isOfficialToolRecord as isRecord, type OfficialToolResult } from './OfficialToolsHttpClient';

export interface DeepSeekSearchInput { query: string; limit?: number }
export interface DeepSeekSearchResult {
  results: { title: string; url: string; snippet: string; summary: string; site_name: string | null; date: string | null }[];
}
export interface DeepSeekFetchResult { url: string; title: string; markdown: string }

const invalidResponse = (): OfficialToolResult<never> => ({ ok: false,
  code: 'DEEPSEEK_TOOLS_INVALID_RESPONSE', message: 'DeepSeek 官方工具返回了无效结果。' });

export class DeepSeekToolsClient {
  private readonly http: OfficialToolsHttpClient;

  constructor(config: { baseURL: string; apiKey: string }) {
    this.http = new OfficialToolsHttpClient({ ...config, provider: 'deepseek' });
  }

  async search(input: DeepSeekSearchInput, signal?: AbortSignal): Promise<OfficialToolResult<DeepSeekSearchResult>> {
    const result = await this.http.request('tools/search', { query: input.query, count: input.limit ?? 5, need_content: false }, signal);
    if (result.ok === false) return result;
    const data = result.data;
    if (!isRecord(data) || !Array.isArray(data.results) || !data.results.every((item) =>
      isRecord(item) && ['title', 'url', 'snippet', 'summary'].every((key) => typeof item[key] === 'string')
      && (item.site_name === null || typeof item.site_name === 'string')
      && (item.date === null || typeof item.date === 'string'))) return invalidResponse();
    return { ok: true, data: { results: data.results.map((item) => ({ title: item.title as string,
      url: item.url as string, snippet: item.snippet as string, summary: item.summary as string,
      site_name: item.site_name as string | null, date: item.date as string | null })) } };
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<OfficialToolResult<DeepSeekFetchResult>> {
    const result = await this.http.request('tools/fetch', { url }, signal);
    if (result.ok === false) return result;
    const data = result.data;
    if (!isRecord(data) || typeof data.title !== 'string' || typeof data.content !== 'string') return invalidResponse();
    return { ok: true, data: { url, title: data.title, markdown: data.content } };
  }
}
