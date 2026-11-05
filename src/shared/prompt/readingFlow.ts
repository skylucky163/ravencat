/** 提示词中心与普通聊天编译器共用的上下文顺序；不提供第二套用户排序配置。 */
import type { PromptBlockKey } from './types';

export const CHAT_PROMPT_READING_FLOW = [
  { id: 'foundation', section: 'identity', blockKeys: ['foundation_default_core'] },
  { id: 'other_rules', section: 'identity', blockKeys: ['paragraph_breaks', 'action_description'] },
  { id: 'persona', section: 'identity', blockKeys: ['persona', 'assistant_nickname', 'user_identity_summary'] },
  { id: 'protocol', section: 'identity', blockKeys: ['protocol_space'] },
  { id: 'agent_registry', section: 'identity', blockKeys: ['agent_registry_summary'] },
  { id: 'group_identity', section: 'identity', blockKeys: ['group_chat_context'] },
  { id: 'custom', section: 'identity', blockKeys: [] },
  { id: 'tools', section: 'capabilities', blockKeys: ['tools_description'] },
  { id: 'mcp', section: 'capabilities', blockKeys: ['mcp_services'] },
  { id: 'history', section: 'context', blockKeys: ['conversation_summary', 'recent_chat_window'] },
  { id: 'tool_runtime', section: 'context', blockKeys: ['tool_context_explanation'] },
  { id: 'user_state', section: 'context', blockKeys: ['together_listening_runtime'] },
  { id: 'social', section: 'context', blockKeys: ['moments_social_inbox', 'moments_context_summary'] },
  { id: 'environment', section: 'context', blockKeys: ['interaction_environment', 'application_trigger'] },
  { id: 'assistant_state', section: 'context', blockKeys: ['host_cooldown'] },
  { id: 'memory', section: 'context', blockKeys: ['passive_memory'] },
  { id: 'battery', section: 'context', blockKeys: ['device_battery'] },
  { id: 'time', section: 'context', blockKeys: ['time_awareness'] },
  { id: 'output', section: 'context', blockKeys: ['ledger_reply_rules'] },
  { id: 'input', section: 'context', blockKeys: ['current_input'] },
] as const satisfies readonly { id: string; section: string; blockKeys: readonly PromptBlockKey[] }[];

export type ChatPromptReadingStep = typeof CHAT_PROMPT_READING_FLOW[number]['id'];
