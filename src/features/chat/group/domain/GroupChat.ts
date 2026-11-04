/** 定义群聊、成员、管理员配置及群发言计划与任务的领域模型契约。 */
export type GroupSpeechPlanStatus =
  | 'pending'
  /**
   * 召唤已接管该 plan：输入窗口已关闭，正在捕获输入与规划（可能包含一次
   * 管理员模型请求）。此时到达的用户消息必须按换代处理，而不是继续并入
   * 输入窗口——只有真正的 pending successor 才允许扩展窗口。
   */
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  /** 被用户新消息换代：旧 plan 失去提交资格，由 successor 接管。 */
  | 'superseded'
  /** 被用户强制终止：不创建 successor、不产生继承，清空后续发言机会。 */
  | 'terminated';

export type GroupSpeechTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  /** 已提交部分内容：仅有思考，或正文被截断、后续交付未完成。 */
  | 'partial'
  | 'failed'
  | 'skipped'
  /** 所属 plan 被换代时仍未到终态的任务；不再允许 claim 或提交。 */
  | 'superseded'
  /** 所属 plan 被强制终止时仍未到终态的任务；不进入任何继承队列。 */
  | 'terminated';

/**
 * 发言任务来源事实：用户结构化 @、AI 回复递归 @、管理员调度，以及用户打断后
 * 从旧 plan 公平继承。恢复、诊断与队列投影只消费该字段，不再从消息正文反推。
 */
export type GroupSpeechTaskSource =
  | 'user_mention'
  | 'ai_mention'
  | 'admin'
  | 'inherited_after_user_interrupt';

export interface GroupChat {
  id: string;
  name: string;
  avatar: string | null;
  /** canonical 群头像身份；avatar 是当前展示 URI，未迁移时直接来自 legacy 列。 */
  avatarMediaAssetId: string | null;
  lastMessage: string | null;
  lastTime: string | null;
  isPinned: boolean;
  /**
   * 最近一次置顶时刻。未置顶为 null。
   * 置顶区有效排序时间 = max(lastTime, pinnedAt)：置顶本身不产生消息活动。
   */
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupChatMember {
  id: string;
  groupId: string;
  aiAssistantId: string;
  agentId: string;
  displayOrder: number;
  enabled: boolean;
  muted: boolean;
  name?: string;
  nickname?: string | null;
  avatar?: string | null;
  avatarMediaAssetId?: string | null;
  model?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupChatAdminConfig {
  groupId: string;
  name: string;
  model: string;
  serviceConfigId?: string | null;
  apiKey: string | null;
  apiBaseUrl: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextMessageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateGroupChatAdminConfigInput {
  serviceConfigId?: string | null;
  model?: string;
  apiKey?: string | null;
  apiBaseUrl?: string | null;
  systemPrompt?: string | null;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  contextMessageCount?: number;
}

export interface GroupSpeechPlan {
  id: string;
  groupId: string;
  status: GroupSpeechPlanStatus;
  invokedUserMessageIds: number[];
  inputUpperBoundMessageId: number | null;
  /**
   * 非空表示该 plan 是用户消息换代产生的 pending successor：pending 期间处于
   * 30 秒输入窗口，激活前 last_included_message_id 保存的是窗口起点（旧 plan
   * 的输入上界）。fresh claim 的瞬时 pending 该字段为 null。
   */
  supersedesPlanId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupSpeechTask {
  id: string;
  planId: string;
  groupId: string;
  aiAssistantId: string;
  agentId: string;
  sequenceOrder: number;
  source: GroupSpeechTaskSource;
  status: GroupSpeechTaskStatus;
  /**
   * 该任务是否已提交过至少一条可见回复（由提交接缝在首个分段落库后标记）。
   * 换代事务据此决定 running 任务是否进入继承队列：已提交即视为已发言，不继承。
   */
  visibleReplyCommitted: boolean;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateGroupChatProfileInput {
  name?: string;
  avatar?: string | null;
  /** 提交 canonical 群头像时由 owner 同时清空 legacy avatar。 */
  avatarMediaAssetId?: string | null;
}

export interface GroupChatDetails {
  group: GroupChat;
  members: GroupChatMember[];
  adminConfig: GroupChatAdminConfig;
}

export interface CreateGroupChatRecordInput {
  group: {
    id: string;
    name: string;
    avatar?: string | null;
    avatarMediaAssetId?: string | null;
  };
  adminConfig: {
    serviceConfigId?: string | null;
    name: string;
    model: string;
    apiKey?: string | null;
    apiBaseUrl?: string | null;
    systemPrompt?: string | null;
    temperature?: number | null;
    topP?: number | null;
    maxTokens?: number | null;
    contextMessageCount?: number;
  };
  members: {
    aiAssistantId: string;
    agentId: string;
    displayOrder: number;
    enabled?: boolean;
  }[];
}

/** 群聊召唤 claim 结果；未占有时返回现存 active plan（若有）。 */
export type TryClaimGroupSpeechPlanResult =
  | {
      claimed: true;
      plan: GroupSpeechPlan;
      previousInputUpperBoundMessageId: number;
    }
  | { claimed: false; plan: GroupSpeechPlan };

export interface CreateGroupSpeechTaskInput {
  id: string;
  planId: string;
  groupId: string;
  aiAssistantId: string;
  agentId: string;
  sequenceOrder: number;
  source: GroupSpeechTaskSource;
  status: GroupSpeechTaskStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
}

/**
 * 运行中 plan 内动态追加的发言任务：顺序与初始 queued 状态由持久层在
 * 同一事务内依据当前队尾计算，调用方只提供任务事实。
 */
export type AppendGroupSpeechTaskInput = Omit<
  CreateGroupSpeechTaskInput,
  'planId' | 'sequenceOrder' | 'status'
>;

/**
 * 用户消息触发的 plan 换代结果，与用户消息提交在同一事务内裁决：
 * - no_active_plan：当前没有 active plan，消息不触发换代；
 * - successor_window_extended：active plan 是仍处于输入窗口的 pending successor，
 *   新消息只并入该窗口，不重复创建 successor；
 * - superseded：旧 active plan 已被原子换代，successor 与继承队列已建立。
 */
export type GroupSpeechPlanRotation =
  | { kind: 'no_active_plan' }
  | { kind: 'successor_window_extended'; planId: string }
  | {
      kind: 'superseded';
      previousPlanId: string;
      successorPlanId: string;
      inheritedTaskCount: number;
    };
