/**
 * @fileoverview AIProfile 实体定义
 *
 * AI 助手（AI Profile）的领域实体，纯数据结构，无业务逻辑。
 * 对应数据库表：ai_assistants
 *
 * @module features/assistants/domain/AIProfile
 */

import {
  DEFAULT_GROUP_CONTEXT_PRIMARY_LIMIT,
  DEFAULT_GROUP_CONTEXT_SECONDARY_LIMIT,
  DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT,
  DEFAULT_PRIVATE_CONTEXT_SECONDARY_LIMIT,
} from '@shared/prompt';

export interface AIProfile {
  /** Assistant 实体主键，用于本地实体寻址、关系与配置归属。 */
  readonly id: string;
  /** 不可变 actor key，用于跨场景归因；创建 Assistant 后不得修改。 */
  readonly agentId: string;
  name: string;
  /** 用户私有备注；公开身份与其他 AI 的名称目录仍使用 name。 */
  nickname: string | null;
  avatar: string | null;
  /** canonical 头像身份；avatar 是当前展示 URI，未迁移时直接来自 legacy 列。 */
  avatarMediaAssetId: string | null;
  /** AI 个人空间封面，主页与朋友圈共用；空值使用打包的默认星空图。 */
  profileCoverMediaAssetId: string | null;
  model: string;
  serviceConfigId?: string | null;
  apiKey: string | null;
  apiBaseUrl: string | null;
  systemPrompt: string | null;
  /** null 表示请求不发送此参数，由服务商决定。 */
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  /** 单聊上下文作为当前交互主场（单聊/通话/主动消息执行）时的可见条数。 */
  privateContextPrimaryLimit: number;
  /** 单聊上下文作为客体注入其他场景时的可见条数。 */
  privateContextSecondaryLimit: number;
  /** 群聊上下文作为当前交互主场时的可见条数。 */
  groupContextPrimaryLimit: number;
  /** 群聊上下文作为客体注入其他场景时的可见条数。 */
  groupContextSecondaryLimit: number;
  enableTools: boolean;
  /** 默认沿用服务商行为；开启时请求模型关闭思考。 */
  disableThinking: boolean;
  allowMultipleBubbles: boolean;
  /** 单聊回复传输偏好；null 跟随主题默认，从下一轮执行生效。 */
  streamingReply: boolean | null;
  /** 当前 AI 的单聊消息用量提示，跨主题保持相同选择。 */
  showTokenUsage: boolean;
  /** 当前 AI 的单聊行动步骤（思考与工具过程）是否可见。 */
  showActionSteps: boolean;
  /** 历史持久化字段，仅为兼容旧 SQLite 列保留，不参与运行时视觉判断。 */
  supportsVision: boolean;
  isLedgerAI: boolean;
  isHostAI: boolean;
  hostCooldownStart: string | null;
  hostCooldownEnd: string | null;
  hostRevokeCooldownStart: string | null;
  hostRevokeCooldownEnd: string | null;
  /** 该 AI 唯一的 canonical 单聊 conversation 技术 ID。 */
  canonicalConversationId: string | null;
  /**
   * 会话列表置顶状态，事实存放在 canonical conversation（`sessions.is_pinned`）。
   * 没有 canonical 会话时为 false；置顶写入口在 Chat 的 conversation application。
   */
  isPinned: boolean;
  /**
   * 最近一次置顶时刻（`sessions.pinned_at`）。未置顶为 null。
   * 只参与置顶区排序：刚置顶立刻到顶部，但不代表任何消息活动。
   */
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
  isBlocked?: boolean;
  blockedUntil?: string | null;
  blockReason?: string | null;
  lastMessage?: string;
  lastTime?: string;
}

export interface AIConfig {
  /** 对应 AIProfile.id 的 Assistant 实体主键。 */
  readonly id: string;
  /** 对应 AIProfile.agentId 的不可变 actor key。 */
  readonly agentId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  enableTools?: boolean;
  disableThinking?: boolean;
  allowMultipleBubbles?: boolean;
  isHostAI?: boolean;
  isBlocked?: boolean;
}

export function createAIProfile(
  data: Partial<AIProfile> & Pick<AIProfile, 'id' | 'agentId'>
): AIProfile {
  const now = new Date().toISOString();
  const normalizedId = String(data.id || '').trim();
  const normalizedAgentId = String(data.agentId || '').trim();
  if (!normalizedId) {
    throw new Error('Assistant 实体键不能为空');
  }
  if (!normalizedAgentId) {
    throw new Error(`Assistant ${normalizedId} 缺少不可变 agentId`);
  }

  return {
    id: normalizedId,
    agentId: normalizedAgentId,
    name: data.name || '',
    nickname: data.nickname ?? null,
    avatar: data.avatar || null,
    avatarMediaAssetId: data.avatarMediaAssetId || null,
    profileCoverMediaAssetId: data.profileCoverMediaAssetId ?? null,
    model: data.model || '',
    apiKey: data.apiKey || null,
    apiBaseUrl: data.apiBaseUrl || null,
    serviceConfigId: data.serviceConfigId ?? null,
    systemPrompt: data.systemPrompt || null,
    temperature: data.temperature ?? null,
    topP: data.topP ?? null,
    maxTokens: data.maxTokens === undefined ? 2000 : data.maxTokens,
    privateContextPrimaryLimit:
      data.privateContextPrimaryLimit ?? DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT,
    privateContextSecondaryLimit:
      data.privateContextSecondaryLimit ?? DEFAULT_PRIVATE_CONTEXT_SECONDARY_LIMIT,
    groupContextPrimaryLimit:
      data.groupContextPrimaryLimit ?? DEFAULT_GROUP_CONTEXT_PRIMARY_LIMIT,
    groupContextSecondaryLimit:
      data.groupContextSecondaryLimit ?? DEFAULT_GROUP_CONTEXT_SECONDARY_LIMIT,
    enableTools: data.enableTools ?? false,
    disableThinking: data.disableThinking ?? false,
    allowMultipleBubbles: data.allowMultipleBubbles ?? true,
    streamingReply: data.streamingReply ?? null,
    showTokenUsage: data.showTokenUsage ?? true,
    showActionSteps: data.showActionSteps ?? true,
    supportsVision: false,
    isLedgerAI: data.isLedgerAI ?? false,
    isHostAI: data.isHostAI ?? false,
    hostCooldownStart: data.hostCooldownStart || null,
    hostCooldownEnd: data.hostCooldownEnd || null,
    hostRevokeCooldownStart: data.hostRevokeCooldownStart || null,
    hostRevokeCooldownEnd: data.hostRevokeCooldownEnd || null,
    canonicalConversationId: data.canonicalConversationId || null,
    isPinned: data.isPinned ?? false,
    pinnedAt: data.pinnedAt || null,
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
    ...(data.isBlocked !== undefined ? { isBlocked: data.isBlocked } : {}),
    ...(data.blockedUntil !== undefined ? { blockedUntil: data.blockedUntil } : {}),
    ...(data.blockReason !== undefined ? { blockReason: data.blockReason } : {}),
    ...(data.lastMessage !== undefined ? { lastMessage: data.lastMessage } : {}),
    ...(data.lastTime !== undefined ? { lastTime: data.lastTime } : {}),
  };
}
