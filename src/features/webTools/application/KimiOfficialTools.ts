/** 官方来源有独立权限与名称；沿用统一 Runtime，不替换用户选择的普通联网工具。 */
import { MoonshotToolsClient, type MoonshotFormulaName, type MoonshotFormulaInput, type OfficialToolResult } from '@platform/ai';
import type { Tool, ToolContext } from '@shared/aiTools';
import { officialToolObservation, truncateOfficialPage } from './OfficialToolObservation';

function createClient(context: ToolContext) {
  return new MoonshotToolsClient({
    baseURL: context.aiConfig.baseURL || context.aiConfig.apiBaseUrl,
    apiKey: context.aiConfig.apiKey,
  });
}

const observation = <T>(result: OfficialToolResult<T>) => officialToolObservation('Kimi', result);

export const KimiWebSearchTool: Tool<{ query: string; limit?: number }, ToolContext> = {
  name: 'kimi_web_search',
  definition: {
    name: 'kimi_web_search',
    description: '使用 Kimi 官方搜索获取公开信息，返回标题、链接、站点、日期与摘要。消耗当前 AI 的 Moonshot 账号搜索额度；重要结论可用 kimi_web_fetch 读取原文并附来源。',
    parameters: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S', description: '搜索关键词' },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回条数，默认 5' },
    }, required: ['query'], additionalProperties: false },
  },
  async execute(input, context) { return observation(await createClient(context).search(input, context.abortSignal)); },
};

export const KimiWebFetchTool: Tool<{ url: string }, ToolContext> = {
  name: 'kimi_web_fetch',
  definition: {
    name: 'kimi_web_fetch',
    description: '由 Kimi 官方服务读取公开网页，返回标题、来源链接及 Markdown 正文，最多提供 20000 字符，超过时明确标记截断。消耗当前 AI 的 Moonshot 账号网页抓取额度；不使用手机登录态、不下载文件。',
    parameters: { type: 'object', properties: {
      url: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://', description: '公开 HTTP 或 HTTPS 网页地址；由 Moonshot 服务执行抓取与安全检查' },
    }, required: ['url'], additionalProperties: false },
  },
  async execute({ url }, context) {
    return observation(truncateOfficialPage(await createClient(context).fetchPage(url, context.abortSignal)));
  },
};

/** 每个 Formula 是独立权限项；调用者不能指定任意 URI 或切入云端 memory。 */
function formulaTool(formula: MoonshotFormulaName, name: string, description: string): Tool<MoonshotFormulaInput, ToolContext> {
  return {
    name,
    definition: {
      name,
      description: `${description} 可先不传参数获取官方函数声明，再按声明填写 function_name 和 arguments 调用。参数与能力以官方声明为准。`,
      parameters: { type: 'object', properties: {
        function_name: { type: 'string', minLength: 1, maxLength: 128, description: '官方声明中的函数名；只有一个函数时可以省略' },
        arguments: { type: 'object', additionalProperties: true, description: '官方函数的参数对象；需要补充时以返回的官方声明为准' },
      }, additionalProperties: false },
    },
    async execute(input, context) {
      const result = await createClient(context).executeFormula(formula, input, context.abortSignal);
      if (result.ok === false) return observation(result);
      // protected 密文和普通输出都原样交回同一模型续轮，不附加资料包装。
      return { success: true, data: result.data, message: result.data.kind === 'output'
        ? result.data.output : `${result.data.message}\n${JSON.stringify(result.data.functions)}` };
    },
  };
}

export const KimiMewTool = formulaTool('mew', 'kimi_mew', '调用 Kimi 官方 mew 趣味工具，随机获取猫叫与祝福，用于玩耍、撒娇或安慰。输出形式以实际结果为准，不代表已播放音频。');
export const KimiConvertTool = formulaTool('convert', 'kimi_convert', '调用 Kimi 官方单位转换工具，支持长度、质量、体积、温度、面积、时间、能量、压力、速度和货币换算。');
export const KimiRethinkTool = formulaTool('rethink', 'kimi_rethink', '调用 Kimi 官方 rethink 工具整理想法。');
export const KimiRandomChoiceTool = formulaTool('random-choice', 'kimi_random_choice', '调用 Kimi 官方随机选择工具。随机结果每次可能不同。');
export const KimiExcelTool = formulaTool('excel', 'kimi_excel', '调用 Kimi 官方 Excel / CSV 分析工具。只提交官方参数支持的数据，不会自动上传或读取手机本地文件。');
export const KimiDateTool = formulaTool('date', 'kimi_date', '调用 Kimi 官方日期时间处理工具；需要时在参数中明确时区。');
export const KimiBase64Tool = formulaTool('base64', 'kimi_base64', '调用 Kimi 官方 Base64 编码与解码工具。');
