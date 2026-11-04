/** 提供群聊创建、删除、查询、资料与管理员配置更新用例，并校验外部输入。 */
import { getChatGroupRuntimeDependencies } from './ChatGroupRuntime';
import { cancelGroupAutoInvocation } from './GroupAutoInvocationScheduler';
import {
  releaseMediaAssetCandidates,
  createMediaAssetWithReference,
  MEDIA_ASSET_STORAGE_BACKEND,
} from '@features/media';
import type { PersistentAvatarDraft } from '@platform/device/DeviceMediaService';
import type {
  GroupChat,
  GroupChatAdminConfig,
  GroupChatDetails,
  CreateGroupChatRecordInput,
  UpdateGroupChatAdminConfigInput,
  UpdateGroupChatProfileInput,
} from '@features/chat/group/domain/GroupChat';

export interface CreateGroupChatParams {
  name: string;
  avatar?: string | null;
  avatarDraft?: PersistentAvatarDraft | null;
  memberAIIds: string[];
  admin: {
    model: string;
    apiKey: string;
    apiBaseUrl: string;
    serviceConfigId?: string | null;
    systemPrompt?: string | null;
    temperature?: number | null;
    topP?: number | null;
    maxTokens?: number | null;
  };
}

function buildGroupChatId(): string {
  return `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUniqueIds(ids: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  ids.forEach((id) => {
    const normalized = String(id || '').trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    result.push(normalized);
  });

  return result;
}

function validateCreateGroupChatParams(params: CreateGroupChatParams): {
  name: string;
  memberAIIds: string[];
  adminModel: string;
  adminApiKey: string;
  adminApiBaseUrl: string;
  adminSystemPrompt: string | null;
} {
  const name = String(params.name || '').trim();
  if (!name) {
    throw new Error('请输入群聊名称');
  }

  const memberAIIds = normalizeUniqueIds(params.memberAIIds || []);
  if (memberAIIds.length < 2) {
    throw new Error('请至少邀请两个 AI 助手');
  }

  const adminModel = String(params.admin.model || '').trim();
  if (!adminModel) {
    throw new Error('请选择管理员模型');
  }

  const adminApiBaseUrl = String(params.admin.apiBaseUrl || '').trim();
  if (!adminApiBaseUrl) {
    throw new Error('请输入管理员 API 地址');
  }

  const adminApiKey = String(params.admin.apiKey || '').trim();
  if (!adminApiKey) {
    throw new Error('请输入管理员 API Key');
  }

  const adminSystemPrompt = String(params.admin.systemPrompt || '').trim() || null;

  return {
    name,
    memberAIIds,
    adminModel,
    adminApiKey,
    adminApiBaseUrl,
    adminSystemPrompt,
  };
}

export async function listGroupChats(): Promise<GroupChat[]> {
  return getChatGroupRuntimeDependencies().groups.getAll();
}

export async function getGroupChat(groupId: string): Promise<GroupChatDetails | null> {
  return getChatGroupRuntimeDependencies().groups.getById(groupId);
}

/** 群头像查询不加载管理员凭据和成员资料；调用者身份与主理资格来自可信宿主。 */
export function getGroupAvatarForAssistant(groupId: string, assistantId: string, isHostAI: boolean) {
  return getChatGroupRuntimeDependencies().groups.getAvatarForAssistant(groupId, assistantId, isHostAI);
}

export async function deleteGroupChat(groupId: string): Promise<boolean> {
  const normalizedGroupId = String(groupId || '').trim();
  if (!normalizedGroupId) {
    throw new Error('群聊不存在');
  }

  const runningPlan = await getChatGroupRuntimeDependencies().groups.getRunningSpeechPlan(normalizedGroupId);
  if (runningPlan) {
    throw new Error('当前群聊正在召唤中，请稍后再删除');
  }

  // 引用候选由删除事务自己给出（群头像 + identity 级联带走的群消息媒体引用）：收集与删除
  // 共享同一个 exclusive transaction，窗口期内新提交的群消息引用不会漏出候选集。
  const deleted = await getChatGroupRuntimeDependencies().groups.delete(normalizedGroupId);
  if (deleted.deleted) {
    cancelGroupAutoInvocation(normalizedGroupId);
    await releaseMediaAssetCandidates(deleted.mediaAssetCandidates);
  }
  return deleted.deleted;
}

export async function updateGroupChatProfile(
  groupId: string,
  input: UpdateGroupChatProfileInput
): Promise<GroupChat> {
  const normalizedGroupId = String(groupId || '').trim();
  if (!normalizedGroupId) {
    throw new Error('群聊不存在');
  }

  const name = input.name === undefined ? undefined : String(input.name).trim();
  if (name !== undefined && !name) {
    throw new Error('请输入群聊名称');
  }
  if (name !== undefined && name.length > 30) {
    throw new Error('群聊名称不能超过 30 个字符');
  }

  const avatar = input.avatar === undefined
    ? undefined
    : input.avatar === null
      ? null
      : String(input.avatar).trim() || null;
  const avatarMediaAssetId = input.avatarMediaAssetId === undefined
    ? undefined
    : input.avatarMediaAssetId === null
      ? null
      : String(input.avatarMediaAssetId).trim() || null;
  if (name === undefined && avatar === undefined && avatarMediaAssetId === undefined) {
    throw new Error('没有需要更新的群聊资料');
  }

  // 旧群头像在替换前读一次，作为 targeted release 候选；新头像自己的引用由本次事务接管。
  const replacesAvatar = avatar !== undefined || avatarMediaAssetId !== undefined;
  let previousAvatarMediaAssetId: string | null = null;
  if (replacesAvatar) {
    const current = await getChatGroupRuntimeDependencies().groups.getById(normalizedGroupId);
    previousAvatarMediaAssetId = current?.group.avatarMediaAssetId ?? null;
  }

  const updated = await getChatGroupRuntimeDependencies().groups.updateProfile(normalizedGroupId, {
    name,
    avatar,
    ...(avatarMediaAssetId !== undefined ? { avatarMediaAssetId } : {}),
  });
  if (!updated) {
    throw new Error('群聊不存在');
  }
  if (replacesAvatar) {
    await releaseMediaAssetCandidates([previousAvatarMediaAssetId]);
  }
  return updated;
}

/** 头像创建和 owner CAS 在同一事务内提交，旧资产由 Media 统一裁决释放。 */
export async function updateGroupChatAvatarFromDraft(groupId: string, draft: PersistentAvatarDraft): Promise<GroupChat> {
  const groups = getChatGroupRuntimeDependencies().groups;
  const current = await groups.getById(groupId);
  if (!current) throw new Error('群聊不存在');
  await createMediaAssetWithReference({
    storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentImage,
    sourceUri: draft.uri, fileName: draft.fileName, mimeType: draft.mimeType,
    width: draft.width, height: draft.height, durationMs: null,
  }, ({ transaction, asset }) => groups.commitAvatarMediaAssetReferenceInTransaction(transaction, {
    ownerId: groupId, expectedAvatar: current.group.avatarMediaAssetId ? null : current.group.avatar,
    expectedAvatarMediaAssetId: current.group.avatarMediaAssetId, mediaAssetId: asset.id,
  }));
  await releaseMediaAssetCandidates([current.group.avatarMediaAssetId]);
  const updated = await groups.getById(groupId);
  if (!updated) throw new Error('保存后的群聊不存在');
  return updated.group;
}

/**
 * 切换群聊会话列表置顶。置顶只决定列表分区，不参与群聊事实或发言调度。
 */
export async function updateGroupChatPinned(
  groupId: string,
  pinned: boolean
): Promise<GroupChat> {
  const normalizedGroupId = String(groupId || '').trim();
  if (!normalizedGroupId) {
    throw new Error('群聊不存在');
  }

  const updated = await getChatGroupRuntimeDependencies().groups.setPinned(normalizedGroupId, pinned);
  if (!updated) {
    throw new Error('群聊不存在');
  }
  return updated;
}

export async function updateGroupChatAdminConfig(
  groupId: string,
  input: UpdateGroupChatAdminConfigInput
): Promise<GroupChatAdminConfig | null> {
  // 唯一产品入口已将用户草稿转换成合法增量；这里不再校验或回填未修改字段。
  return getChatGroupRuntimeDependencies().groups.updateAdminConfig(groupId, input);
}

export async function createGroupChat(
  params: CreateGroupChatParams
): Promise<GroupChatDetails> {
  const normalized = validateCreateGroupChatParams(params);
  const selectedAssistants = [];

  for (const aiId of normalized.memberAIIds) {
    const assistant = await getChatGroupRuntimeDependencies().assistantDirectory.getById(aiId);
    if (assistant && !assistant.isBlocked) {
      selectedAssistants.push(assistant);
    }
  }

  if (selectedAssistants.length < 2) {
    throw new Error('请至少选择两个可用的 AI 助手');
  }

  const record: CreateGroupChatRecordInput = {
    group: {
      id: buildGroupChatId(),
      name: normalized.name,
      avatar: params.avatarDraft ? null : params.avatar || null,
    },
    adminConfig: {
      name: '管理员',
      model: normalized.adminModel,
      apiKey: normalized.adminApiKey,
      apiBaseUrl: normalized.adminApiBaseUrl,
      serviceConfigId: params.admin.serviceConfigId,
      systemPrompt: normalized.adminSystemPrompt,
      temperature: params.admin.temperature ?? null,
      topP: params.admin.topP ?? null,
      maxTokens: params.admin.maxTokens === undefined ? 2000 : params.admin.maxTokens,
      contextMessageCount: 20,
    },
    members: selectedAssistants.map((assistant, index) => ({
      aiAssistantId: assistant.id,
      agentId: assistant.agentId,
      displayOrder: index,
      enabled: true,
    })),
  };
  const groups = getChatGroupRuntimeDependencies().groups;
  if (!params.avatarDraft) return groups.create(record);
  const draft = params.avatarDraft;
  await createMediaAssetWithReference({
    storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentImage,
    sourceUri: draft.uri, fileName: draft.fileName, mimeType: draft.mimeType,
    width: draft.width, height: draft.height, durationMs: null,
  }, ({ transaction, asset }) => groups.createInTransaction(transaction, {
    ...record, group: { ...record.group, avatarMediaAssetId: asset.id },
  }));
  const details = await groups.getById(record.group.id);
  if (!details) throw new Error('创建后的群聊不存在');
  return details;
}
