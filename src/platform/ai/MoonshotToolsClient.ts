/** Moonshot 官方 REST／Formula 工具协议边界；不拥有工具授权、拆包或模型续轮。 */
import { assertAgentToolInputSchema, matchesAgentToolInputSchema, type JsonSchema } from '@shared/aiTools';
import { OfficialToolsHttpClient, isOfficialToolRecord as isRecord, type OfficialToolResult } from './OfficialToolsHttpClient';

export interface MoonshotSearchInput { query: string; limit?: number }
export interface MoonshotSearchResult {
  search_results: { title: string; url: string; snippet: string; site_name: string; date: string }[];
}
export interface MoonshotFetchResult { url: string; title: string; markdown: string }
export type MoonshotFormulaName = 'mew' | 'convert' | 'rethink' | 'random-choice' | 'excel' | 'date' | 'base64';
export interface MoonshotFormulaInput { function_name?: string; arguments?: Record<string, unknown> }
interface FormulaFunction { name: string; description: string; parameters: JsonSchema }
export type MoonshotFormulaResult = { kind: 'output'; output: string }
  | { kind: 'input_required'; message: string; functions: FormulaFunction[] };
export type MoonshotToolResult<T> = OfficialToolResult<T>;

const failure = (code: string, message: string): MoonshotToolResult<never> => ({ ok: false, code, message });

export class MoonshotToolsClient {
  private readonly http: OfficialToolsHttpClient;

  constructor(config: { baseURL: string; apiKey: string }) {
    this.http = new OfficialToolsHttpClient({ ...config, provider: 'moonshot' });
  }

  async search(input: MoonshotSearchInput, signal?: AbortSignal): Promise<MoonshotToolResult<MoonshotSearchResult>> {
    const result = await this.http.request('tools/search', { text_query: input.query, limit: input.limit ?? 5,
      include_content: false, timeout_seconds: 30 }, signal);
    if (result.ok === false) return result;
    const data = result.data;
    if (!isRecord(data) || !Array.isArray(data.search_results) || !data.search_results.every((item) =>
      isRecord(item) && ['title', 'url', 'snippet', 'site_name', 'date'].every((key) => typeof item[key] === 'string'))) {
      return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方搜索返回了无效结果。');
    }
    return { ok: true, data: { search_results: data.search_results.map((item) => ({
      title: item.title as string, url: item.url as string, snippet: item.snippet as string,
      site_name: item.site_name as string, date: item.date as string,
    })) } };
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<MoonshotToolResult<MoonshotFetchResult>> {
    const result = await this.http.request('tools/fetch', { url }, signal);
    if (result.ok === false) return result;
    const data = result.data;
    if (!isRecord(data) || typeof data.url !== 'string' || typeof data.title !== 'string' || typeof data.markdown !== 'string') {
      return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方网页读取返回了无效结果。');
    }
    return { ok: true, data: { url: data.url, title: data.title, markdown: data.markdown } };
  }

  async executeFormula(formula: MoonshotFormulaName, input: MoonshotFormulaInput, signal?: AbortSignal): Promise<MoonshotToolResult<MoonshotFormulaResult>> {
    const formulaPath = `formulas/moonshot/${formula}:latest`;
    const declaration = await this.http.request(`${formulaPath}/tools`, undefined, signal);
    if (declaration.ok === false) return declaration;
    const data = declaration.data;
    if (!isRecord(data) || !Array.isArray(data.tools) || data.tools.length === 0) {
      return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方工具没有返回有效的官方声明。');
    }
    const functions: FormulaFunction[] = [];
    const names = new Set<string>();
    for (const tool of data.tools) {
      if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
        return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方工具返回了无效的函数声明。');
      }
      const fn = tool.function;
      if (typeof fn.name !== 'string' || !fn.name || names.has(fn.name)
        || typeof fn.description !== 'string' || !isRecord(fn.parameters) || fn.parameters.type !== 'object') {
        return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方工具返回了无效的函数声明。');
      }
      try { assertAgentToolInputSchema(fn.parameters); }
      catch { return failure('KIMI_TOOLS_INVALID_SCHEMA', 'Kimi 官方工具的官方参数声明无法解析。'); }
      names.add(fn.name);
      functions.push({ name: fn.name, description: fn.description, parameters: fn.parameters });
    }
    const fn = input.function_name === undefined
      ? (functions.length === 1 ? functions[0] : undefined)
      : functions.find((item) => item.name === input.function_name);
    const args = input.arguments ?? {};
    // Runtime 已校验本地封装参数；这里校验刚从官方边界取得的另一个 schema。
    if (!fn || !matchesAgentToolInputSchema(args, fn.parameters)) {
      return { ok: true, data: { kind: 'input_required',
        message: '尚未执行官方工具。请按以下官方声明选择 function_name 并填写 arguments 后再次调用。', functions } };
    }
    const fiber = await this.http.request(`${formulaPath}/fibers`, { name: fn.name, arguments: JSON.stringify(args) }, signal);
    if (fiber.ok === false) return fiber;
    if (!isRecord(fiber.data) || typeof fiber.data.status !== 'string') {
      return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方工具返回了无效的执行结果。');
    }
    if (fiber.data.status !== 'succeeded') return failure('KIMI_FORMULA_EXECUTION_FAILED', 'Kimi 官方工具执行未成功。');
    const context = fiber.data.context;
    if (!isRecord(context)) return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方工具缺少执行输出。');
    // protected 输出必须原样回灌模型，不解析或改写密文。
    const output = typeof context.output === 'string' && context.output.length > 0 ? context.output : context.encrypted_output;
    if (typeof output !== 'string' || !output) return failure('KIMI_TOOLS_INVALID_RESPONSE', 'Kimi 官方工具缺少执行输出。');
    return { ok: true, data: { kind: 'output', output } };
  }
}
