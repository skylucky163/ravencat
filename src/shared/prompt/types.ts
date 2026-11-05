/** 定义 Prompt 组装器与各 Feature 运行时之间共享的数据契约。 */
import type { ToolContext } from '../aiTools';
import type {
  PromptDefinitionProtection,
  PromptScenarioId,
  PromptSlot,
} from './catalogTypes';

export type PromptPackScenario = PromptScenarioId;
export type MemoryParticipationMode = 'off' | 'read_only' | 'read_write';
export type BubbleDeliveryMode = 'multi-bubble' | 'single-bubble';
export type PromptSystemSegment = 'stable-prefix' | 'conversation-summary' | 'history-context' | 'dynamic-suffix' | 'output-requirement';

/** Host 冻结的已授权工具用途目录；实际暴露能力由本轮 schema 表达。 */
export interface PromptToolInstructions {
  catalog: string;
}

/** 编译器保留固定目录的位置；网关只插入目录，不重写已编译的本轮上下文。 */
export interface PromptToolInstructionsSlot {
  before: string;
  after: string;
}

export interface PromptMcpServiceSummary {
  name: string;
  description: string;
}

export type PromptBlockKey =
  | 'time_awareness'
  | 'device_battery'
  | 'foundation_default_core'
  | 'persona'
  | 'paragraph_breaks'
  | 'action_description'
  | 'protocol_space'
  | 'tool_context_explanation'
  | 'agent_registry_summary'
  | 'moments_social_inbox'
  | 'assistant_nickname'
  | 'interaction_environment'
  | 'application_trigger'
  | 'host_cooldown'
  | 'group_chat_context'
  | 'tools_description'
  | 'mcp_services'
  | 'ledger_reply_rules'
  | 'moments_context_summary'
  | 'user_identity_summary'
  | 'passive_memory'
  | 'conversation_summary'
  | 'chat_summary_task'
  | 'chat_secondary_summary_task'
  | 'recent_chat_window'
  | 'together_listening_runtime'
  | 'current_input';

export interface PromptPackBlock {
  key: PromptBlockKey;
  /** 迁移期工厂草稿可以省略，最终 Pack 由编译器保证存在。 */
  instanceId?: string;
  definitionId?: string;
  slot?: PromptSlot;
  protection?: PromptDefinitionProtection;
  title: string;
  content: string;
  required: boolean;
  status: 'ready' | 'placeholder' | 'omitted';
  source?: string;
  truncatable?: boolean;
  scenario?: PromptPackScenario | 'shared';
  placement?: 'system' | 'history' | 'input' | 'reserved';
  placeholderTodo?: string;
  estimatedTokens?: number;
  systemSegment?: PromptSystemSegment;
}

export interface PromptPresetItemDefinition {
  definitionId: string;
  slot: PromptSlot;
  sortOrder: number;
  enabled: boolean;
  required: boolean;
  protection: PromptDefinitionProtection;
}

export interface PromptPresetDefinition {
  id: string;
  version: number;
  name: string;
  scenarioId: PromptScenarioId;
  tokenBudget?: number;
  items: PromptPresetItemDefinition[];
}

export type PromptPackMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type PromptPackMessageContent = string | PromptPackMessageContentPart[];

export interface PromptPackMessage {
  role: 'user' | 'assistant';
  content: PromptPackMessageContent;
  /** 原消息时间仅作为元数据传递；是否注入由本轮冻结的 AI 配置决定。 */
  createdAt?: string;
  /** 可信组装器提供的来源说明或规则，独立成为 system 消息，不混入历史正文。 */
  systemNotice?: string;
  sourceMessageId?: number;
  sourceCallEventId?: string;
  logicalMessageId?: string | null;
}

/** 正文保留原角色；请求可另放 system 时间元数据与本轮上下文。 */
export type PromptPackRequestMessage = PromptPackMessage | { role: 'system'; content: string };

export interface PromptPackTextMessage extends PromptPackMessage {
  content: string;
}

export interface PromptPackAIConfig {
  id: string;
  agentId?: string;
  name: string;
  /** 当前 AI 使用的模型名，用于顶层基础规则里的运行环境说明；缺省时不注入该句。 */
  model?: string;
  systemPrompt?: string;
  enableTools?: boolean;
  allowMultipleBubbles?: boolean;
  messageTimestampsEnabled?: boolean;
  promptDefinitionOverrides?: Record<string, string>;
  disabledPromptDefinitionIds?: string[];
  /** 本次组装冻结的全局身份池排除名单；不影响模型调用权限。 */
  agentRegistryExcludedAssistantIds?: readonly string[];
  isHostAI?: boolean;
  isBlocked?: boolean;
  privateContextPrimaryLimit?: number;
  privateContextSecondaryLimit?: number;
  groupContextPrimaryLimit?: number;
  groupContextSecondaryLimit?: number;
}

export interface PromptPackGroupChatMemberContext {
  aiAssistantId: string;
  agentId: string;
  name: string;
  muted?: boolean;
}

export interface PromptPackGroupChatContext {
  groupId: string;
  groupName: string;
  currentAIId: string;
  currentAgentId: string;
  currentAIName: string;
  members: PromptPackGroupChatMemberContext[];
  recentWindowLimit: number;
  currentTurnUserMessageIds?: number[];
  inputUpperBoundMessageId?: number;
  planId?: string | null;
}

export interface PromptPackRuntimeContext {
  /** 应用触发没有新的用户发言；携带资料进入本轮 system，不伪造 user 输入。 */
  inputSource?: 'application';
  /** Host 在一次 Prompt 组装开始时解析的当前对话者显示名，供多个 block 共享。 */
  userDisplayName?: string;
  triggerSource?: string;
  triggerReason?: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  capabilities?: string[];
  batchSeq?: number;
  batchedUserMessageIds?: number[];
  historyUpperBound?: { messageId: number; createdAt: string };
  /** 通话当前输入已独立提供，历史投影排除同一条已提交转写，避免重复。 */
  currentCallEventId?: string;
  batchedUserMessageCount?: number;
  forceAppendUserText?: boolean;
  recentWindowLimit?: number;
  replyRunId?: string;
  isRegeneration?: boolean;
  memoryParticipation?: MemoryParticipationMode;
  supportsMultipleBubbles?: boolean;
  groupChat?: PromptPackGroupChatContext;
}

export interface AssemblePromptPackParams {
  sessionId: string;
  currentInput: string;
  aiConfig: PromptPackAIConfig;
  toolContext: ToolContext;
  runtimeContext?: PromptPackRuntimeContext;
  recentWindowLimit?: number;
  toolsDescription?: string;
  /** 本轮经过 Registry/policy/run preparation 后真正暴露给模型的工具名。 */
  allowedToolNames?: readonly string[];
  /** 当前轮已授权 MCP 服务的选择摘要；不包含远端工具 schema。 */
  mcpServices?: readonly PromptMcpServiceSummary[];
  preset?: PromptPresetDefinition;
  additionalBlocks?: PromptPackBlock[];
}

export interface AssembleStandalonePromptPackParams {
  scenarioId: PromptScenarioId;
  assistantId?: string | null;
  groupId?: string | null;
  blocks: PromptPackBlock[];
  currentInput: string;
}

export interface PromptPack {
  scenario: PromptPackScenario;
  messageTimestampsEnabled: boolean;
  blocks: PromptPackBlock[];
  /** 前置系统内容：固定规则与用途说明在前，聊天摘要在后；本轮上下文位于 modelMessages 的历史之后。 */
  systemPrompt: string;
  toolInstructionsSlot?: PromptToolInstructionsSlot;
  stableSystemPrompt: string;
  dynamicSystemPrompt: string;
  outputRequirement: string;
  recentMessages: PromptPackMessage[];
  /** 应用触发没有真实用户输入时为 null；触发资料在本轮 system 中。 */
  currentInput: PromptPackTextMessage | null;
  modelMessages: PromptPackRequestMessage[];
  estimatedTokenCount: number;
  truncationLog?: string[];
}
