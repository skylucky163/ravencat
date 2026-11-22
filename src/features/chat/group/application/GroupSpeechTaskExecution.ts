/**
 * 群聊发言任务执行器：从持久队列逐项 CAS claim，串行投递每个成员的 AI 回复。
 *
 * 不在 plan 启动时遍历固定任务数组：AI 回复提交后追加的 ai_mention 动态任务
 * 会进入同一持久队列，执行器循环 claim 直到队空或 plan 进入终态。单个成员
 * 失败（配置、余额、API、模型）记录该任务的输出终态并继续下一项；可见的
 * 灰色错误消息由 processAIReply 的统一失败落库负责，执行器只记录任务事实。
 */

import type { AIProfile } from '@features/assistants';
import { USER_SUMMON_INTENT } from '../../reply/domain/UserSummonIntent';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import { getMessageAttachments } from '../../messages/domain/chatMessageMetadata';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import { emitChatMessagesUpdated } from '../../messages/events/ChatEvents';
import { processAIReply, type AIReplyConfig } from '../../reply/application/ProcessAIReply';
import { createGroupSegmentedReplyPersistence } from './GroupAssistantTurnCommit';
import { registerGroupSpeechAbort } from './GroupSpeechExecutionAbort';
import type {
  GroupChatDetails,
  GroupSpeechTask,
  GroupSpeechTaskStatus,
} from '../domain/GroupChat';
import type { GroupParticipantDirectory } from '../domain/GroupParticipantDirectory';
import {
  getGroupParticipantDirectory,
} from './GroupParticipantDirectory';

const GROUP_MEMBER_TURN_REQUEST = [
  '[本轮发言请求 / CURRENT GROUP TURN]',
  '请依据上方按时间顺序排列的群聊记录，自然回应标记为“本轮用户输入”的消息，并考虑本轮其他成员已经给出的回复。',
  'Respond naturally using the chronological group timeline above, focusing on messages marked as current user input and considering replies already given by other members in this turn.',
].join('\n');

function toAIReplyConfig(ai: AIProfile): AIReplyConfig {
  return {
    id: ai.id,
    agentId: ai.agentId,
    name: ai.name,
    avatar: ai.avatar,
    model: ai.model,
    apiKey: ai.apiKey || '',
    apiBaseUrl: ai.apiBaseUrl || '',
    systemPrompt: ai.systemPrompt || undefined,
    temperature: ai.temperature,
    topP: ai.topP,
    disableThinking: ai.disableThinking,
    reasoningEffort: ai.reasoningEffort,
    maxTokens: ai.maxTokens,
    privateContextPrimaryLimit: ai.privateContextPrimaryLimit,
    privateContextSecondaryLimit: ai.privateContextSecondaryLimit,
    groupContextPrimaryLimit: ai.groupContextPrimaryLimit,
    groupContextSecondaryLimit: ai.groupContextSecondaryLimit,
    enableTools: ai.enableTools,
    manualReply: ai.manualReply,
    allowMultipleBubbles: ai.allowMultipleBubbles,
    isHostAI: ai.isHostAI,
    isBlocked: ai.isBlocked,
  };
}

function toTriggerReason(task: GroupSpeechTask): string {
  if (task.source === 'user_mention') {
    return 'group_mention';
  }
  if (task.source === 'ai_mention') {
    return 'group_ai_mention';
  }
  if (task.source === 'inherited_after_user_interrupt') {
    return 'group_user_interrupt_inherit';
  }
  return 'group_admin_schedule';
}

interface GroupSpeechExecutionContext {
  planId: string;
  details: GroupChatDetails;
  currentUserMessages: ChatMessage[];
  inputUpperBoundMessageId: number;
  memberProfiles: Map<string, AIProfile>;
  participantDirectory: GroupParticipantDirectory;
  groupChatPromptMembers: {
    aiAssistantId: string;
    agentId: string;
    name: string;
    muted: boolean;
  }[];
}

export async function executeGroupSpeechTasks(params: {
  planId: string;
  details: GroupChatDetails;
  currentUserMessages: ChatMessage[];
  inputUpperBoundMessageId: number;
  memberProfiles: Map<string, AIProfile>;
}): Promise<void> {
  const {
    planId,
    details,
    currentUserMessages,
    inputUpperBoundMessageId,
    memberProfiles,
  } = params;
  const groupId = details.group.id;
  for (;;) {
    const task = await getChatGroupRuntimeDependencies().groups.claimNextQueuedSpeechTask(planId);
    if (!task) return;
    // 每位成员发言前读取当前群资料，单次模型请求与输出解析共用该次目录快照。
    const currentDetails = await getChatGroupRuntimeDependencies().groups.getById(groupId);
    if (!currentDetails) {
      throw new Error('群聊参与者目录不可用');
    }
    const participantDirectory = await getGroupParticipantDirectory(currentDetails);
    const memberByAssistantId = new Map(
      currentDetails.members.map((member) => [member.aiAssistantId, member]),
    );
    const groupChatPromptMembers = participantDirectory.assistants
      .map((participant) => {
        const member = memberByAssistantId.get(participant.assistantId);
        if (!member) {
          return null;
        }
        return {
          aiAssistantId: participant.assistantId,
          agentId: member.agentId,
          name: participant.displayName,
          muted: member.muted,
        };
      })
      .filter((member): member is {
        aiAssistantId: string;
        agentId: string;
        name: string;
        muted: boolean;
      } => member !== null);

    const context: GroupSpeechExecutionContext = {
      planId,
      details: currentDetails,
      currentUserMessages,
      inputUpperBoundMessageId,
      memberProfiles,
      participantDirectory,
      groupChatPromptMembers,
    };
    await executeGroupSpeechTask(context, task);
  }
}

async function executeGroupSpeechTask(
  context: GroupSpeechExecutionContext,
  task: GroupSpeechTask,
): Promise<void> {
  const runtime = getChatGroupRuntimeDependencies();
  const groupId = context.details.group.id;
  // 动态追加的 ai_mention 任务目标在 plan 启动时已进入成员集合；若启动后资料
  // 才被删除，则回退读取一次当前资料，仍不存在说明成员已不可用。
  const ai = context.memberProfiles.get(task.aiAssistantId)
    ?? await runtime.assistantDirectory.getById(task.aiAssistantId);
  if (!ai) {
    // CAS 守卫：claim 之后任务可能已被换代裁决为终态，晚到的 skipped 不得覆盖。
    await runtime.groups.updateSpeechTaskStatus(task.id, 'skipped', {
      expectedStatus: 'running',
    });
    return;
  }

  const currentParticipant = context.participantDirectory.assistants.find(
    (participant) => participant.assistantId === ai.id,
  );
  if (!currentParticipant) {
    // CAS 守卫：claim 之后任务可能已被换代裁决为终态，晚到的 skipped 不得覆盖。
    await runtime.groups.updateSpeechTaskStatus(task.id, 'skipped', {
      expectedStatus: 'running',
    });
    return;
  }

  let didProduceReply = false;
  let replyFailureMessage: string | null = null;
  const persistence = createGroupSegmentedReplyPersistence({
    directory: context.participantDirectory,
    task,
  });
  // 协作式中止句柄：换代事务 commit 后由发送路径 abort，只节约旧请求资源；
  // 落库资格始终由提交接缝内的持久化 fence 裁决。
  const abortController = new AbortController();
  const unregisterAbort = registerGroupSpeechAbort(context.planId, abortController, task.id);
  try {
    if (!await runtime.groups.isSpeechTaskCommitEligible(context.planId, task.id)) return;
    await processAIReply(
      groupId,
      context.currentUserMessages.length === 0 ? USER_SUMMON_INTENT : GROUP_MEMBER_TURN_REQUEST,
      toAIReplyConfig(ai),
      context.currentUserMessages.at(-1)?.id ?? 0,
      getChatMessageRuntimeDependencies().messages,
      {
        notifyUI: emitChatMessagesUpdated,
        onFinalReply: () => {
          didProduceReply = true;
        },
        onReplyFailed: (payload) => {
          replyFailureMessage = payload.error;
        },
      },
      {
        abortSignal: abortController.signal,
        replyRunId: task.id,
        triggerSource: 'group_chat',
        triggerReason: toTriggerReason(task),
        relatedEntityType: 'group_speech_plan',
        relatedEntityId: context.planId,
        batchedUserMessageIds: context.currentUserMessages.map((message) => message.id),
        ...(context.currentUserMessages.length > 0 ? {
          historyUpperBound: { messageId: context.inputUpperBoundMessageId,
            createdAt: context.currentUserMessages.at(-1)!.createdAt },
        } : { forceAppendUserText: true, memoryParticipation: 'read_write' as const }),
        batchedUserMessageCount: context.currentUserMessages.length,
        capabilities: context.currentUserMessages.some((message) => (
          getMessageAttachments(message).some((attachment) => attachment.type === 'image')
        )) ? ['vision.current_turn'] : undefined,
        recentWindowLimit: ai.groupContextPrimaryLimit,
        groupChat: {
          groupId,
          groupName: context.details.group.name,
          currentAIId: ai.id,
          currentAgentId: ai.agentId,
          currentAIName: currentParticipant.displayName,
          members: context.groupChatPromptMembers,
          recentWindowLimit: ai.groupContextPrimaryLimit,
          planId: context.planId,
          taskId: task.id,
          taskSource: task.source,
          sequenceOrder: task.sequenceOrder,
          currentTurnUserMessageIds: context.currentUserMessages.map((message) => message.id),
          inputUpperBoundMessageId: context.inputUpperBoundMessageId,
        },
        userDisplayName: context.participantDirectory.currentUser.displayName,
      },
      // 共享 timeline 的逐条提交、媒体物化、mention 与动态任务都由群 owner 裁决。
      persistence,
    );
  } catch {
    // processAIReply 内部已吞掉模型/请求错误并统一落库；走到这里的是执行器
    // 自身或提交接缝的非取消异常。单成员失败不升级，记录输出终态后继续队列。
    replyFailureMessage = replyFailureMessage ?? '处理 AI 回复时发生错误';
  } finally {
    unregisterAbort();
  }

  const output = persistence.getReplyOutput();
  const finishNotice = output.finishReason === 'length'
    ? '模型已达到输出长度上限，生成被截断'
    : output.finishReason === 'content_filter'
      ? '模型输出被服务商内容过滤中止'
      : null;
  let status: GroupSpeechTaskStatus;
  let errorMessage: string | null;
  if (output.visibleReplyCommitted) {
    const incomplete = finishNotice !== null || !didProduceReply || replyFailureMessage !== null;
    status = incomplete ? 'partial' : 'completed';
    errorMessage = incomplete
      ? ['已保留发出的部分回复', finishNotice, replyFailureMessage].filter(Boolean).join('；')
      : null;
  } else if (output.reasoningCommitted) {
    status = 'partial';
    errorMessage = ['仅有思考内容，未发出正文回复', finishNotice, replyFailureMessage]
      .filter(Boolean).join('；');
  } else {
    status = 'failed';
    errorMessage = [finishNotice, replyFailureMessage].filter(Boolean).join('；') || 'AI 未生成可见回复';
  }

  // CAS 守卫：任务可能已被 supersede/强制终止提前转为终态，晚到的状态回写
  // 不得覆盖持久层已经裁决的事实。
  await runtime.groups.updateSpeechTaskStatus(
    task.id,
    status,
    {
      errorMessage,
      expectedStatus: 'running',
    },
  );
}
