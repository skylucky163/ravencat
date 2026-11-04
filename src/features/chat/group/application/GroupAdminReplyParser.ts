/** 定义群聊管理员本轮成员别名，并把模型返回映射回稳定成员身份。 */

import type { GroupChatMember } from '../domain/GroupChat';
import type { ChatMessage } from '../../messages/domain/ChatMessage';
import { getMessageAttachments, getMessageSharedRecord, getMessageSharedMoment } from '../../messages/domain/chatMessageMetadata';
import { buildSharedChatRecordText } from '../../messages/domain/SharedChatRecord';
import { buildSharedMomentText } from '../../messages/domain/SharedMoment';
import { buildGroupMentionModelText } from './GroupMentionModelText';

const MAX_ADMIN_ADDED_SPEAKERS = 4;

export interface GroupAdminMemberAlias {
  alias: string;
  member: GroupChatMember;
}

function formatUserMessageForAdmin(message: ChatMessage): string {
  const moment = getMessageSharedMoment(message);
  if (moment) return buildSharedMomentText(moment);
  const shared = getMessageSharedRecord(message);
  if (shared) return buildSharedChatRecordText(shared, message.text);
  const attachmentTypes = new Set(
    getMessageAttachments(message).map((attachment) => attachment.type),
  );
  const lines: string[] = [];
  if (attachmentTypes.has('image')) {
    lines.push('用户上传了一张图片');
  }
  if (attachmentTypes.has('file')) {
    lines.push('用户上传了一个文件');
  }
  const text = String(message.text || '').trim();
  if (text) {
    lines.push(text);
  }
  return lines.join('\n');
}

export function createGroupAdminMemberAliases(
  members: GroupChatMember[],
): GroupAdminMemberAlias[] {
  return members.map((member, index) => ({
    alias: `member_${index + 1}`,
    member,
  }));
}

export function buildGroupAdminInput(params: {
  groupName: string;
  memberAliases: GroupAdminMemberAlias[];
  candidateAliases: GroupAdminMemberAlias[];
  userMessages: ChatMessage[];
  recentMessages: ChatMessage[];
}): string {
  const {
    groupName,
    memberAliases,
    candidateAliases,
    userMessages,
    recentMessages,
  } = params;
  const formatMembers = (entries: GroupAdminMemberAlias[]) => entries
    .map(({ alias, member }) => `- ${alias}: ${member.name || 'AI'}`)
    .join('\n') || '无';
  const publicMembers = memberAliases.map(({ member }) => ({ aiAssistantId: member.aiAssistantId, name: member.name || 'AI' }));
  const userBatchText = userMessages
    .map((message) => `用户: ${buildGroupMentionModelText(formatUserMessageForAdmin(message), message, publicMembers)}`)
    .join('\n') || '无';
  const currentUserMessageIds = new Set(userMessages.map((message) => message.id));
  const recentText = recentMessages
    .filter((message) => !currentUserMessageIds.has(message.id))
    .map((message) => {
      if (message.isMe) {
        return `用户: ${buildGroupMentionModelText(formatUserMessageForAdmin(message), message, publicMembers)}`;
      }
      const entry = memberAliases.find(({ member }) => member.agentId === message.agentId);
      const moment = getMessageSharedMoment(message);
      return `${entry?.member.name || 'AI'}: ${moment ? buildSharedMomentText(moment) : message.text}`;
    })
    .join('\n');

  return [
    `群聊：${groupName}`,
    '',
    '群成员：',
    formatMembers(memberAliases),
    '',
    '本次发言候选：',
    formatMembers(candidateAliases),
    '',
    '本次召唤的用户消息：',
    userBatchText,
    '',
    '最近可见上下文：',
    recentText || '无',
  ].join('\n');
}

export function normalizeAdminSpeakerIds(
  rawText: string,
  candidateAliases: GroupAdminMemberAlias[],
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new Error('管理员返回内容不是 JSON 数组');
  }

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('管理员返回内容必须是 JSON 字符串数组');
  }
  if (parsed.length === 0) {
    return [];
  }

  const candidateByAlias = new Map(
    candidateAliases.map((entry) => [entry.alias, entry.member]),
  );
  const selectedAIIds: string[] = [];
  const seen = new Set<string>();

  for (const value of parsed) {
    const member = candidateByAlias.get(value.trim());
    if (!member || seen.has(member.aiAssistantId)) {
      continue;
    }
    seen.add(member.aiAssistantId);
    selectedAIIds.push(member.aiAssistantId);
    if (selectedAIIds.length >= MAX_ADMIN_ADDED_SPEAKERS) break;
  }

  if (selectedAIIds.length === 0) {
    throw new Error('管理员未返回任何有效候选成员');
  }

  return selectedAIIds;
}
