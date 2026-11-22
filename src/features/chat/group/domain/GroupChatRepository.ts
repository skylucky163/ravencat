/** 声明群聊及发言计划、任务持久化所需的领域仓储接口。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import type {
  AppendGroupSpeechTaskInput,
  CreateGroupChatRecordInput,
  GroupChat,
  GroupChatAdminConfig,
  GroupChatDetails,
  GroupChatMember,
  GroupSpeechPlan,
  GroupSpeechPlanRotation,
  GroupSpeechPlanStatus,
  GroupSpeechTask,
  GroupSpeechTaskStatus,
  TryClaimGroupSpeechPlanResult,
  UpdateGroupChatAdminConfigInput,
  UpdateGroupChatProfileInput,
} from './GroupChat';

/** Host M3b 头像迁移只读取群 owner 的 legacy URI。 */
export interface GroupAvatarMediaAssetMigrationCandidate {
  id: string;
  avatar: string;
  avatarMediaAssetId: string | null;
}

/**
 * 删除群聊的结果。
 *
 * mediaAssetCandidates 是「本次删除事务真正带走的 media asset 引用」候选：群头像，以及随
 * identity 级联删除的群消息里引用的媒体。候选必须在删除事实的同一个事务内收集，调用方只在
 * deleted 为 true 时才拿它做 targeted release。
 */
export interface GroupChatDeletionResult {
  deleted: boolean;
  mediaAssetCandidates: readonly string[];
}

export interface CommitGroupAvatarMediaAssetReferenceInput {
  ownerId: string;
  expectedAvatar: string | null;
  expectedAvatarMediaAssetId: string | null;
  mediaAssetId: string;
}

export type GroupAvatarQueryResult =
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'found'; groupId: string; name: string; avatar: string | null; avatarMediaAssetId: string | null };

export interface IGroupChatRepository {
  isSpeechTaskRunCurrentInTransaction(transaction: DatabaseTransactionExecutor, taskId: string): Promise<boolean>;
  getAll(): Promise<GroupChat[]>;
  getById(groupId: string): Promise<GroupChatDetails | null>;
  /** 主理资格由 Host 提供可信事实；当前成员关系与头像选择在同一次读取中裁决。 */
  getAvatarForAssistant(groupId: string, assistantId: string, isHostAI: boolean): Promise<GroupAvatarQueryResult>;
  getMembers(groupId: string): Promise<GroupChatMember[]>;
  getAdminConfig(groupId: string): Promise<GroupChatAdminConfig | null>;
  create(input: CreateGroupChatRecordInput): Promise<GroupChatDetails>;
  createInTransaction(transaction: DatabaseTransactionExecutor, input: CreateGroupChatRecordInput): Promise<void>;
  updateAdminConfig(
    groupId: string,
    input: UpdateGroupChatAdminConfigInput
  ): Promise<GroupChatAdminConfig | null>;
  updateProfile(
    groupId: string,
    input: UpdateGroupChatProfileInput
  ): Promise<GroupChat | null>;
  /**
   * 切换群聊会话列表置顶：置顶写 `is_pinned = 1` + `pinned_at = 置顶时刻`，
   * 取消置顶把两者一起归零（`pinned_at = NULL` 才能真正回到真实消息排序）。
   * 只改置顶事实，绝不触碰 last_message / last_time。群聊不存在返回 null。
   */
  setPinned(groupId: string, pinned: boolean): Promise<GroupChat | null>;
  listAvatarMediaAssetMigrationCandidates(): Promise<GroupAvatarMediaAssetMigrationCandidate[]>;
  getAvatarMediaAssetMigrationCandidate(
    ownerId: string,
  ): Promise<GroupAvatarMediaAssetMigrationCandidate | null>;
  commitAvatarMediaAssetReferenceInTransaction(
    transaction: DatabaseTransactionExecutor,
    input: CommitGroupAvatarMediaAssetReferenceInput,
  ): Promise<void>;
  /**
   * 与已提交消息事实绑定的 preview 更新：仅当该消息不早于当前 preview 来源
   * 消息且仍然存在于 messages 表时才生效（last_message_id CAS + 存在性守卫）。
   * 用于 commit 后的晚到 preview 副作用——旧 plan 的 AI 回复晚到不得覆盖
   * 更新的用户消息 preview，已删除消息不得被复活成 preview。
   */
  updatePreviewForCommittedMessage(
    groupId: string,
    messageId: number,
    lastMessage: string,
    lastTime: string,
  ): Promise<boolean>;
  /** 仅改写当前预览来源的正文，不改变群聊最近活动时间。 */
  updateEditedMessagePreviewInTransaction(
    transaction: DatabaseTransactionExecutor,
    groupId: string,
    messageId: number,
    previewText: string,
  ): Promise<void>;
  /**
   * 用户消息提交事务内的 preview 更新：与消息事实、plan 换代同一事务 commit，
   * 调用方保证该消息即事务内最新事实，无需 CAS。
   */
  updatePreviewInTransaction(
    transaction: DatabaseTransactionExecutor,
    groupId: string,
    messageId: number | null,
    lastMessage: string,
    lastTime: string | null,
  ): Promise<void>;
  getLatestSpeechPlan(
    groupId: string,
    status?: GroupSpeechPlanStatus
  ): Promise<GroupSpeechPlan | null>;
  getRunningSpeechPlan(groupId: string): Promise<GroupSpeechPlan | null>;
  tryClaimGroupSpeechPlan(groupId: string): Promise<TryClaimGroupSpeechPlanResult>;
  /**
   * 用户消息换代，必须与用户消息提交在同一事务内调用：
   * - 无 active plan：不触发换代；
   * - active plan 是仍处于输入窗口的 pending successor：只把新消息并入该窗口
   *   （扩展 invoked 水位），不重复创建 successor；
   * - 其他 active plan：原子完成旧 plan superseded、旧 queued/running 任务转
   *   superseded 终态、pending successor 创建与公平继承队列计算。
   */
  rotateSpeechPlanForUserMessageInTransaction(
    transaction: DatabaseTransactionExecutor,
    params: { groupId: string; userMessageId: number },
  ): Promise<GroupSpeechPlanRotation>;
  /**
   * 用户强制终止当前 active plan（pending/preparing/running）：单一事务内把
   * plan CAS 为 terminated 终态，并把 queued/running 任务同事务裁决为
   * terminated——提交资格先于任何 abort 在持久层撤销。与换代不同，终止不创建
   * successor、不产生继承队列。返回被终止的 planId；无 active plan 返回 null。
   * commit 后的在途请求 abort 由应用层负责；后续发言等待用户召唤。
   */
  terminateActiveSpeechPlan(groupId: string): Promise<string | null>;
  /** 冷启动收口失去进程 owner 的计划及未完成任务，保留消息与已完成任务，不自动重跑。 */
  interruptSpeechPlansWithoutOwner(activeGroupIds: readonly string[]): Promise<string[]>;
  updateSpeechPlanInput(
    planId: string,
    invokedUserMessageIds: number[],
    inputUpperBoundMessageId: number | null,
  ): Promise<boolean>;
  /** 按发言顺序读取 plan 的全部任务（继承判断与队列投影共用）。 */
  listSpeechPlanTasks(planId: string): Promise<GroupSpeechTask[]>;
  /**
   * 召唤接管 plan：输入窗口关闭，pending → preparing（CAS）。此后到达的用户
   * 消息按换代处理而非扩展窗口。plan 已离开 pending（被换代或并发召唤接管）
   * 时返回 false。
   */
  beginSpeechPlanPreparation(planId: string): Promise<boolean>;
  /**
   * 原子激活 plan：新任务（用户 @ 或管理员调度）插入队首，继承队列中
   * 与 mentionAssistantIds 交叉的重复任务被移除，其余继承任务保持相对顺序后移；
   * 最后 CAS preparing→running。plan 已离开 preparing（被换代）时返回
   * false，不写入任何任务。
   */
  activateSpeechPlanWithTasks(
    planId: string,
    params: {
      tasks: AppendGroupSpeechTaskInput[];
      mentionAssistantIds: string[];
    },
  ): Promise<boolean>;
  /**
   * 原子 claim 队列中的下一条 queued 任务：只有 plan 仍处于 active 状态时才允许
   * claim，任务状态由 queued 条件更新为 running（CAS）。没有可 claim 任务或 plan
   * 已进入终态时返回 null。
   */
  claimNextQueuedSpeechTask(planId: string): Promise<GroupSpeechTask | null>;
  /**
   * 在调用方事务内裁决 AI @ AI 的调度后果。
   *
   * 调用方必须在同一事务内先完成 plan active + source task running 的提交
   * fence（mention 所在气泡的提交事务），因此这里不重复检查 plan 状态。对每个
   * 目标只看同一 plan 内 status = queued 且 sequence_order 大于来源任务的
   * future turn；存在时该 mention 被覆盖，不再追加，否则才把任务接到队尾。
   * 目标与来源 AI 相同时永远不产生 ai_mention 任务。这样 mention 可见事实与
   * 它的 scheduling consequence 仍共享同一个 commit 边界，但不会把已有未来
   * 发言机会重复排队。
   */
  materializeAIMentionSpeechTasksInTransaction(
    transaction: DatabaseTransactionExecutor,
    planId: string,
    sourceTask: Pick<GroupSpeechTask, 'id' | 'aiAssistantId' | 'sequenceOrder'>,
    inputs: AppendGroupSpeechTaskInput[],
  ): Promise<GroupSpeechTask[]>;
  /**
   * assistant 提交 fence：只有 plan 仍 active 且任务仍 running 时，该任务的
   * 模型输出才保有落库资格。
   */
  isSpeechTaskCommitEligible(planId: string, taskId: string): Promise<boolean>;
  /**
   * fence 的事务内版本：必须与气泡消息 INSERT 处于同一事务，fence 裁决与落库
   * 之间不允许插入换代事务。
   */
  isSpeechTaskCommitEligibleInTransaction(
    transaction: DatabaseTransactionExecutor,
    planId: string,
    taskId: string,
  ): Promise<boolean>;
  /**
   * plan 级所有权 fence 的事务内版本：只有 plan 仍 active（pending/preparing/
   * running）时返回 true。用于规划期旁路事实（如管理员调度失败提示）的落库
   * 裁决——planning 期间被换代的 plan 不得再写属于它的系统提示。
   */
  isSpeechPlanActiveInTransaction(
    transaction: DatabaseTransactionExecutor,
    planId: string,
  ): Promise<boolean>;
  /**
   * 提交接缝在首个可见分段落库的事务内标记该任务已产出可见回复；换代事务据此
   * 决定 running 任务是否进入继承队列。仅任务仍 running 时生效（CAS），
   * 重复调用幂等。必须与气泡 INSERT 同一事务，关闭"气泡已落库但标记未落"
   * 的交错窗口。
   */
  markSpeechTaskReplyCommittedInTransaction(
    transaction: DatabaseTransactionExecutor,
    taskId: string,
  ): Promise<boolean>;
  updateSpeechPlanStatus(
    planId: string,
    status: GroupSpeechPlanStatus,
    options?: {
      completedAt?: string | null;
      errorMessage?: string | null;
      /** CAS 守卫：仅当 plan 当前处于其中任一状态时才允许本次状态迁移。 */
      expectedStatus?: GroupSpeechPlanStatus[];
    }
  ): Promise<boolean>;
  updateSpeechTaskStatus(
    taskId: string,
    status: GroupSpeechTaskStatus,
    options?: {
      startedAt?: string | null;
      completedAt?: string | null;
      errorMessage?: string | null;
      /** CAS 守卫：仅当任务当前处于该状态时才允许本次状态迁移。 */
      expectedStatus?: GroupSpeechTaskStatus;
    }
  ): Promise<boolean>;
  /**
   * 删除群聊，并在同一事务内返回本次删除带走的 media asset 引用候选（群头像 + 随 identity
   * 级联删除的群消息媒体引用）。
   */
  delete(groupId: string): Promise<GroupChatDeletionResult>;
}
