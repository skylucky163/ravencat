/** 思考强度的协议边界；界面与请求共享能力表，自动表示不指定强度。 */
import type { AIClientConfig, ReasoningEffort } from './types';
export type { ReasoningEffort } from './types';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: '自动', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
};

function modelName(model: string): string { return model.toLowerCase().split('/').pop()!; }
function isOpenRouter(baseURL: string): boolean { return /^https?:\/\/openrouter\.ai(?:[/:]|$)/i.test(baseURL); }

/** OpenRouter 拥有跨厂商强度换算；直连只返回有文档契约的实际档位。 */
export function getReasoningEffortOptions(baseURL: string, model: string): readonly ReasoningEffort[] {
  if (isOpenRouter(baseURL)) return REASONING_EFFORTS;
  const name = modelName(model);
  if (name.includes('chat-latest') || (/-pro(?:-|$)/.test(name) && name.startsWith('gpt-'))
    || /^o1-(?:mini|preview)(?:-|$)/.test(name)) return ['auto'];
  let efforts: readonly ReasoningEffort[] = [];
  if (/^gpt-(?:6(?:\.1)?|5\.6)(?:-|$)/.test(name)) efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  else if (/^gpt-5\.[2-5](?:-|$)/.test(name)) efforts = ['low', 'medium', 'high', 'xhigh'];
  else if (/^gpt-5\.1(?:-|$)/.test(name)) efforts = ['low', 'medium', 'high'];
  else if (/^gpt-5(?:-|$)/.test(name) && !name.includes('chat')) efforts = ['minimal', 'low', 'medium', 'high'];
  else if (/^(?:o1|o3|o4)(?:-|$)/.test(name) && !/(?:pro|preview)/.test(name)) efforts = ['low', 'medium', 'high'];
  else if (/^gpt-oss(?:-|$)/.test(name)) efforts = ['low', 'medium', 'high'];
  else if (/^deepseek-(?:v4(?:\.1)?|flash|pro)(?:-|$)/.test(name)) efforts = ['low', 'high', 'max'];
  else if (/^glm-5\.3(?:-|$)/.test(name)) efforts = ['low', 'high', 'max'];
  else if (/^glm-5\.2(?:-|$)/.test(name)) efforts = ['high', 'max'];
  else if (/^gemini-4-hydrogen(?:-|$)/.test(name)) efforts = ['low', 'medium', 'high', 'xhigh'];
  else if (/^gemini-4(?:[.-]|$)/.test(name)) efforts = ['low', 'medium', 'high'];
  else if (/^gemini-3(?:\.1)?-flash(?:-|$)/.test(name)) efforts = ['minimal', 'low', 'medium', 'high'];
  else if (/^gemini-3(?:\.1)?-pro(?:-|$)/.test(name)) efforts = ['low', 'high'];
  else if (/^gemini-2\.5(?:-|$)/.test(name)) efforts = ['low', 'medium', 'high'];
  return ['auto', ...efforts];
}

/** 统一偏好映射到模型的真实枚举，不把同一实际档位伪装成不同计算预算。 */
export function resolveReasoningEffort(baseURL: string, model: string, effort: ReasoningEffort): ReasoningEffort {
  const options = getReasoningEffortOptions(baseURL, model);
  if (options.includes(effort)) return effort;
  if (options.length === 1) return 'auto';
  if (effort === 'minimal' || effort === 'low') return options[1];
  if (effort === 'medium') return 'high';
  // DeepSeek 文档将 xhigh 映射为 high，GLM-5.2 将它映射为 max。
  if (effort === 'xhigh' && /^deepseek-/.test(modelName(model))) return 'high';
  return options[options.length - 1];
}

function supportsThinkingToggle(model: string): boolean {
  const name = modelName(model);
  const qwen = /^(?:qwen3(?:[.-]|$)|qwen-(?:plus|flash|turbo)(?:-|$))/.test(name)
    && !/(?:thinking|instruct|preview)/.test(name);
  return qwen || /^deepseek-(?:v(?:3\.[12]|4(?:\.1)?)|flash|pro)(?:-|$)/.test(name)
    || /^kimi-k2\.[56](?:-|$)/.test(name)
    || /^glm-(?:4\.[67]|5(?:\.[12])?)(?:-|$)/.test(name);
}

/** 不把 auto 作为 API 枚举发送，也不为不支持的强度重试或伪造 token 预算。 */
export function buildThinkingParameters(config: AIClientConfig): Record<string, unknown> {
  const { baseURL, model, disableThinking, reasoningEffort = 'auto' } = config;
  const effectiveEffort = resolveReasoningEffort(baseURL, model, reasoningEffort);
  const name = modelName(model);
  if (isOpenRouter(baseURL)) {
    if (disableThinking) return { reasoning: { enabled: false } };
    if (effectiveEffort !== 'auto') return { reasoning: { effort: effectiveEffort } };
    return disableThinking === false && supportsThinkingToggle(model) ? { reasoning: { enabled: true } } : {};
  }
  if (/^(?:gpt-[56]|gpt-oss|o[134](?:-|$)|gemini-)/.test(name)) {
    if (disableThinking) {
      const canDisable = /^gpt-5\.[1-6](?:-|$)/.test(name) && !/(?:codex|pro|chat)/.test(name)
        || /^gemini-2\.5-flash(?:-|$)/.test(name);
      return canDisable ? { reasoning_effort: 'none' } : {};
    }
    return effectiveEffort !== 'auto' ? { reasoning_effort: effectiveEffort } : {};
  }
  const parameters: Record<string, unknown> = {};
  if (disableThinking !== undefined && (disableThinking || supportsThinkingToggle(model))) {
    // GLM-5.3 固定思考，不能发送会被服务端拒绝的关闭参数。
    if (!/^glm-5\.3(?:-|$)/.test(name)) {
      if (name.includes('qwen') || baseURL.includes('dashscope')) parameters.enable_thinking = !disableThinking;
      else parameters.thinking = { type: disableThinking ? 'disabled' : 'enabled' };
    }
  }
  if (!disableThinking && effectiveEffort !== 'auto') parameters.reasoning_effort = effectiveEffort;
  return parameters;
}
