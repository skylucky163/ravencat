/** DeepSeek 官方联网来源独立授权，执行与续轮沿用统一 Runtime。 */
import { DeepSeekToolsClient, type DeepSeekSearchInput } from '@platform/ai';
import type { Tool, ToolContext } from '@shared/aiTools';
import { officialToolObservation, truncateOfficialPage } from './OfficialToolObservation';

function createClient(context: ToolContext) {
  return new DeepSeekToolsClient({ baseURL: context.aiConfig.baseURL || context.aiConfig.apiBaseUrl,
    apiKey: context.aiConfig.apiKey });
}

export const DeepSeekWebSearchTool: Tool<DeepSeekSearchInput, ToolContext> = {
  name: 'deepseek_web_search',
  definition: {
    name: 'deepseek_web_search',
    description: '使用 DeepSeek 官方搜索获取公开信息，返回标题、链接、日期、片段和详细摘要。消耗当前 AI 的 DeepSeek 账号搜索额度；可用 deepseek_web_fetch 读取原文并附来源。支持 site:、lang:、after:、before: 等搜索语法。',
    parameters: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S', description: '搜索关键词，最多 128 个字符' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回条数，默认 5' },
    }, required: ['query'], additionalProperties: false },
  },
  async execute(input, context) {
    return officialToolObservation('DeepSeek', await createClient(context).search(input, context.abortSignal));
  },
};

export const DeepSeekWebFetchTool: Tool<{ url: string }, ToolContext> = {
  name: 'deepseek_web_fetch',
  definition: {
    name: 'deepseek_web_fetch',
    description: '由 DeepSeek 官方服务读取公开网页，返回标题、来源链接及 Markdown 正文，最多提供 20000 字符并标记截断。消耗当前 AI 的 DeepSeek 账号抓取额度；不使用手机登录态、不下载文件。',
    parameters: { type: 'object', properties: {
      url: { type: 'string', minLength: 1, maxLength: 8192, pattern: '^https?://', description: '公开 HTTP 或 HTTPS 网页地址；由 DeepSeek 服务执行抓取与安全检查' },
    }, required: ['url'], additionalProperties: false },
  },
  async execute({ url }, context) {
    return officialToolObservation('DeepSeek', truncateOfficialPage(await createClient(context).fetchPage(url, context.abortSignal)));
  },
};
