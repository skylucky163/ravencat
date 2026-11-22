/** 群聊召唤的输入窗口、成员筛选与管理员发言规划；不执行消息写入。 */

import { createAIClient, getErrorDisplayInfo } from '@platform/ai';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import type { AIProfile } from '@features/assistants';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import { getGroupChatMentions } from '../../messages/domain/chatMessageMetadata';
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import { getChatReplyRuntimeDependencies } from '../../reply/application/ChatReplyRuntimeDependencies';
import type {
  GroupChatAdminConfig,
  GroupChatDetails,
  GroupChatMember,
} from '../domain/GroupChat';
import { buildGroupAdminPromptBlocks } from './GroupTaskPromptBlocks';
import {
  buildGroupAdminInput,
  createGroupAdminMemberAliases,
  normalizeAdminSpeakerIds,
  type GroupAdminMemberAlias,
} from './GroupAdminReplyParser';

export interface GroupInvocationContext {
  currentUserMessages: ChatMessage[];
  inputUpperBoundMessageId: number;
}

export interface GroupSpeechPlanningResult {
  memberProfiles: Map<string, AIProfile>;
  sequenceMembers: GroupChatMember[];
  mentionedAssistantIds: Set<string>;
  adminRequestFailureNotice: {
    text: string;
    metadata: {
      actorType: 'admin';
      actorName: string;
    };
  } | null;
}

export async function captureGroupInvocationContext(
  groupId: string,
  previousInputUpperBoundMessageId: number,
): Promise<GroupInvocationContext> {
  const messages = getChatMessageRuntimeDependencies().messages;
  const latestMessage = await messages.getLatestMessage(groupId);
  const inputUpperBoundMessageId = latestMessage?.id ?? previousInputUpperBoundMessageId;

  return {
    currentUserMessages: await messages.listUserMessagesInRange(
      groupId,
      previousInputUpperBoundMessageId,
      inputUpperBoundMessageId,
    ),
    inputUpperBoundMessageId,
  };
}

function findMentionedMembers(
  messages: ChatMessage[],
  members: GroupChatMember[],
): GroupChatMember[] {
  const memberByAssistantId = new Map(
    members.map((member) => [member.aiAssistantId, member]),
  );
  const mentioned: GroupChatMember[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    for (const mention of getGroupChatMentions(message)) {
      if (
        mention.actorType !== 'user'
        || mention.target.targetType !== 'assistant'
      ) {
        continue;
      }
      const member = memberByAssistantId.get(mention.target.assistantId);
      if (!member || seen.has(member.aiAssistantId)) {
        continue;
      }
      seen.add(member.aiAssistantId);
      mentioned.push(member);
    }
  }

  return mentioned;
}

async function callAdminScheduler(params: {
  adminConfig: GroupChatAdminConfig;
  details: GroupChatDetails;
  memberAliases: GroupAdminMemberAlias[];
  candidateAliases: GroupAdminMemberAlias[];
  userMessages: ChatMessage[];
  recentMessages: ChatMessage[];
  abortSignal?: AbortSignal;
}): Promise<{
  selectedAIIds: string[];
  requestFailureMessage: string | null;
}> {
  const { adminConfig, candidateAliases } = params;
  if (candidateAliases.length === 0) {
    return { selectedAIIds: [], requestFailureMessage: null };
  }

  const { prompt } = getChatReplyRuntimeDependencies();
  const promptPack = await prompt.assembleStandalone({
    scenarioId: 'chat.group_admin_schedule',
    groupId: params.details.group.id,
    // 正文只有提示词中心一份，群配置不再保存。
    blocks: buildGroupAdminPromptBlocks(await prompt.resolveGroupAdminPrompt()),
    currentInput: buildGroupAdminInput({
      groupName: params.details.group.name,
      memberAliases: params.memberAliases,
      candidateAliases: params.candidateAliases,
      userMessages: params.userMessages,
      recentMessages: params.recentMessages,
    }),
  });
  throwIfAbortSignalAborted(params.abortSignal);
  try {
    const client = createAIClient({
      baseURL: adminConfig.apiBaseUrl || '',
      apiKey: adminConfig.apiKey || '',
      model: adminConfig.model,
      temperature: adminConfig.temperature,
      topP: adminConfig.topP,
      maxTokens: adminConfig.maxTokens,
      systemPrompt: promptPack.systemPrompt,
    });
    const response = await client.chat(promptPack.modelMessages, { signal: params.abortSignal });
    throwIfAbortSignalAborted(params.abortSignal);
    if (!response.success) {
      return {
        selectedAIIds: [],
        requestFailureMessage: getErrorDisplayInfo(response.error || '管理员模型请求失败', { includeDetails: true }).message,
      };
    }
    if (!response.text.trim()) {
      return { selectedAIIds: [], requestFailureMessage: null };
    }
    try {
      return {
        selectedAIIds: normalizeAdminSpeakerIds(response.text, candidateAliases),
        requestFailureMessage: null,
      };
    } catch {
      return { selectedAIIds: [], requestFailureMessage: null };
    }
  } catch (error) {
    // 用户终止不能转化为“管理员失败后全量召唤”。终态仍由 plan 的 CAS 裁决。
    throwIfAbortSignalAborted(params.abortSignal);
    return {
      selectedAIIds: [],
      requestFailureMessage: getErrorDisplayInfo(
        error instanceof Error ? error : String(error),
        { includeDetails: true },
      ).message,
    };
  }
}

async function getEnabledMemberProfiles(
  members: GroupChatMember[],
): Promise<Map<string, AIProfile>> {
  const result = new Map<string, AIProfile>();
  for (const member of members) {
    if (!member.enabled) {
      continue;
    }

    const ai = await getChatGroupRuntimeDependencies().assistantDirectory.getById(member.aiAssistantId);
    if (ai) {
      result.set(member.aiAssistantId, ai);
    }
  }
  return result;
}

export async function prepareGroupSpeechPlan(
  details: GroupChatDetails,
  currentUserMessages: ChatMessage[],
  options: { hasInheritedSpeechTasks?: boolean; abortSignal?: AbortSignal } = {},
): Promise<GroupSpeechPlanningResult> {
  const enabledMemberProfiles = await getEnabledMemberProfiles(details.members);
  const memberProfiles = new Map(
    [...enabledMemberProfiles].filter(([, profile]) => !profile.isBlocked),
  );
  const recognizedMembers = details.members.filter(
    (member) => member.enabled && enabledMemberProfiles.has(member.aiAssistantId),
  );
  const availableMembers = details.members.filter(
    (member) => member.enabled && !member.muted && memberProfiles.has(member.aiAssistantId),
  );
  const recognizedMentionedMembers = findMentionedMembers(currentUserMessages, recognizedMembers);
  const mentionedMembers = recognizedMentionedMembers.filter(
    (member) => !member.muted && memberProfiles.has(member.aiAssistantId),
  );
  const mentionedIds = new Set(mentionedMembers.map((member) => member.aiAssistantId));
  const memberAliases = createGroupAdminMemberAliases(availableMembers);

  let adminSelectedIds: string[] = [];
  let adminRequestFailureNotice: GroupSpeechPlanningResult['adminRequestFailureNotice'] = null;
  // 有用户明确 @ 时不请求管理员；无用户 @ 但存在继承队列时直接按继承顺序执行；
  // 两者都不存在时才恢复管理员编排。
  if (
    recognizedMentionedMembers.length === 0
    && availableMembers.length > 0
    && !options.hasInheritedSpeechTasks
  ) {
    const recentMessages = details.adminConfig.contextMessageCount === 0
      ? []
      : (await getChatMessageRuntimeDependencies().messages.getMessages(details.group.id, {
          limit: details.adminConfig.contextMessageCount,
          cursor: null,
          order: 'DESC',
        })).messages;
    const schedulerResult = await callAdminScheduler({
      adminConfig: details.adminConfig,
      details,
      memberAliases,
      candidateAliases: memberAliases,
      userMessages: currentUserMessages,
      recentMessages,
      abortSignal: options.abortSignal,
    });
    adminSelectedIds = schedulerResult.selectedAIIds;
    if (schedulerResult.requestFailureMessage) {
      const actorName = details.adminConfig.name || '管理员';
      adminRequestFailureNotice = {
        text: `管理员调度失败，本次已切换为全量召唤：${schedulerResult.requestFailureMessage}`,
        metadata: {
          actorType: 'admin',
          actorName,
        },
      };
    }
    if (adminSelectedIds.length === 0) {
      adminSelectedIds = availableMembers.map((member) => member.aiAssistantId);
    }
  }

  const sequenceMembers = recognizedMentionedMembers.length > 0
    ? mentionedMembers
    : adminSelectedIds
        .map((aiId) => availableMembers.find((member) => member.aiAssistantId === aiId))
        .filter((member): member is GroupChatMember => Boolean(member));

  return {
    memberProfiles,
    sequenceMembers,
    mentionedAssistantIds: mentionedIds,
    adminRequestFailureNotice,
  };
}
