/** Calls 运行时所需的 AI 配置契约，避免依赖 Chat 的回复实现类型。 */

export interface CallAIConfig {
  id: string;
  agentId: string;
  name: string;
  avatar?: string | null;
  model: string;
  apiKey: string;
  apiBaseUrl: string;
  systemPrompt?: string;
  temperature?: number | null;
  topP?: number | null;
  disableThinking?: boolean;
  reasoningEffort?: import('@platform/ai').ReasoningEffort;
  maxTokens?: number | null;
  /** 单聊上下文作为主场时的可见条数；缺失时由共享默认常量兜底。 */
  privateContextPrimaryLimit?: number;
  /** 单聊上下文作为客体注入时的可见条数；缺失时由共享默认常量兜底。 */
  privateContextSecondaryLimit?: number;
  /** 群聊上下文作为主场时的可见条数；缺失时由共享默认常量兜底。 */
  groupContextPrimaryLimit?: number;
  /** 群聊上下文作为客体注入时的可见条数；缺失时由共享默认常量兜底。 */
  groupContextSecondaryLimit?: number;
  enableTools?: boolean;
  allowMultipleBubbles?: boolean;
  enableStreamingReply?: boolean;
  isHostAI?: boolean;
  isBlocked?: boolean;
}
