/** AI 助手增删改查及会话初始化入口。 */
import type { AIProfile } from './domain/AIProfile';
import type {
  AIAssistantSettingsUpdate,
  AssistantNicknameChange,
  AIModelSettingsUpdate,
  AIAssistantSummary,
} from './domain/AssistantRepository';
import {
  createMediaAssetWithReference,
  commitCroppedImageSelection,
  MEDIA_ASSET_STORAGE_BACKEND,
  releaseMediaAssetCandidates,
} from '@features/media';
import type { PersistentAvatarDraft } from '@platform/device/DeviceMediaService';
import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import { SettingChangeConflictError } from '@shared/errors/SettingChangeConflictError';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { ApplicationSettingsAccessError } from './domain/ApplicationSettingsAccess';
import { HostRelationshipError } from './domain/HostRepository';
import {
  HostAuthorityCoordinator,
  type CurrentHostAuthorityResult,
} from './application/HostAuthorityCoordinator';
import { aiAssistantRepository } from './infrastructure/SQLiteAssistantRepository';
import { aiHostRepository } from './infrastructure/SQLiteHostRepository';

export interface AssistantChatSessionGateway {
  recordNicknameChangeInTransaction(transaction: DatabaseTransactionExecutor, change: AssistantNicknameChange): Promise<() => void>;
  resolveCanonicalConversation(aiId: string): Promise<{
    id: string;
    lastTime?: string | null;
  }>;
  onHostRelationshipChanged(aiId: string, change: 'appointed' | 'revoked', occurredAt: string): Promise<void>;
  onHostRelationshipRemoved(
    aiId: string,
    reason: 'revoked' | 'deleted'
  ): Promise<void>;
}

let chatSessionGateway: AssistantChatSessionGateway | null = null;
const hostAuthorityCoordinator = new HostAuthorityCoordinator(aiHostRepository);

export function configureAssistantRuntime(gateway: AssistantChatSessionGateway): void {
  chatSessionGateway = gateway;
}

export async function listAIAssistants(): Promise<AIProfile[]> {
  return aiAssistantRepository.getAll();
}

export async function getAIAssistantById(aiId: string): Promise<AIProfile | null> {
  return aiAssistantRepository.getById(aiId);
}

export async function listAIAssistantSummaries(): Promise<AIAssistantSummary[]> {
  return aiAssistantRepository.listSummaries();
}
export async function applyAssistantContextLimits(assistantIds: readonly string[], settings: import('./domain/AssistantRepository').AssistantContextLimits): Promise<void> {
  await aiAssistantRepository.applyContextLimits(assistantIds, settings);
  for (const id of assistantIds) {
    const assistant = await aiAssistantRepository.getById(id);
    if (assistant) emitAIAssistantUpdated(assistant);
  }
}

export async function deleteAIAssistant(aiId: string): Promise<boolean> {
  return hostAuthorityCoordinator.runHostMutation(async () => {
    const assistant = await aiAssistantRepository.getById(aiId);
    // 引用候选由删除事务自己给出（AI 头像 + identity 级联带走的消息媒体引用）：收集与删除
    // 共享同一个 exclusive transaction，窗口期内新提交的消息引用不会漏出候选集。
    const { deleted, mediaAssetCandidates } = await aiAssistantRepository.delete(aiId);
    if (deleted) {
      await releaseMediaAssetCandidates(mediaAssetCandidates);
    }
    if (deleted && assistant?.isHostAI) {
      await requireChatSessionGateway().onHostRelationshipRemoved(aiId, 'deleted');
    }
    return deleted;
  });
}

export async function createAIAssistant(aiAssistant: AIProfile): Promise<AIProfile> {
  const insertedAI = await aiAssistantRepository.insert(aiAssistant);

  try {
    const conversation = await requireChatSessionGateway()
      .resolveCanonicalConversation(insertedAI.id);
    return {
      ...insertedAI,
      canonicalConversationId: conversation.id,
      lastTime: conversation.lastTime || insertedAI.lastTime,
    };
  } catch (error) {
    // 创建会话失败后回滚这条 AI 行：它的头像引用随行一起消失，候选由删除事务给出。
    const { mediaAssetCandidates } = await aiAssistantRepository.delete(insertedAI.id);
    await releaseMediaAssetCandidates(mediaAssetCandidates);
    throw error;
  }

}

export async function updateAIModelSettings(aiId: string, settings: AIModelSettingsUpdate): Promise<AIProfile> {
  const persisted = await aiAssistantRepository.updateModelSettings(aiId, settings);
  emitAIAssistantUpdated(persisted);
  return persisted;
}

export async function updateAIAssistantSettings(
  aiId: string,
  settings: AIAssistantSettingsUpdate
): Promise<boolean> {
  const replacesAvatar = settings.avatar !== undefined || settings.avatarMediaAssetId !== undefined;
  let previousAvatarMediaAssetId: string | null = null;
  if (replacesAvatar) {
    previousAvatarMediaAssetId =
      (await aiAssistantRepository.getAvatarMediaAssetReference(aiId))?.avatarMediaAssetId ?? null;
  }

  const { updated, notifyNicknameChange } = await databaseCoordinator.transaction({
    name: 'assistants.update-settings-and-history', feature: 'assistants', priority: 'interactive',
  }, async transaction => {
    const result = await aiAssistantRepository.updateSettingsInTransaction(transaction, aiId, settings);
    const notifyNicknameChange = result.nicknameChange === null ? null
      : await requireChatSessionGateway().recordNicknameChangeInTransaction(transaction, result.nicknameChange);
    return { updated: result.updated, notifyNicknameChange };
  });
  // 历史与当前值一同提交后，Chat 才刷新时间线和摘要 consumer。
  if (notifyNicknameChange !== null) notifyNicknameChange();
  if (updated && replacesAvatar) {
    await releaseMediaAssetCandidates([previousAvatarMediaAssetId]);
  }
  if (updated) {
    const assistant = await aiAssistantRepository.getById(aiId);
    if (assistant) {
      emitAIAssistantUpdated(assistant);
    }
  }
  return updated;
}

/** 头像独立提交，不读取或回写名称草稿。 */
export async function updateAIAssistantAvatarFromDraft(
  aiId: string,
  draft: PersistentAvatarDraft,
): Promise<AIProfile> {
  const expected = await aiAssistantRepository.getAvatarMediaAssetReference(aiId);
  if (!expected) {
    throw new Error(`AI 助手不存在：${aiId}`);
  }
  await createMediaAssetWithReference(
    {
      storageBackend: MEDIA_ASSET_STORAGE_BACKEND.persistentImage,
      sourceUri: draft.uri,
      fileName: draft.fileName,
      mimeType: draft.mimeType,
      width: draft.width,
      height: draft.height,
      durationMs: null,
    },
    ({ transaction, asset }) => aiAssistantRepository.commitAvatarMediaAssetReferenceInTransaction(
      transaction,
      {
        ownerId: aiId,
        expectedAvatar: expected.avatar,
        expectedAvatarMediaAssetId: expected.avatarMediaAssetId,
        mediaAssetId: asset.id,
      },
    ),
  );
  await releaseMediaAssetCandidates([expected.avatarMediaAssetId]);
  const updated = await aiAssistantRepository.getById(aiId);
  if (!updated) {
    throw new Error(`保存后的 AI 助手不存在：${aiId}`);
  }
  emitAIAssistantUpdated(updated);
  return updated;
}

export type AIAssistantUpdatedListener = (assistant: AIProfile) => void;

/** 主理身份是可撤销事实，在真正提交设置的事务内裁决，不依赖开跑时的角色快照。 */
export async function assertApplicationSettingsAccessInTransaction(transaction: DatabaseTransactionExecutor, actorId: string, targetId: string | null): Promise<void> {
  if (!await aiAssistantRepository.canManageApplicationSettingsInTransaction(transaction, actorId, targetId)) {
    throw new ApplicationSettingsAccessError();
  }
}

/** Assistants 拥有头像引用；文件准备期间的用户编辑由头像 CAS 保护。 */
export async function changeAssistantAvatarFromMediaAsset(assistantId: string, mediaAssetId: string | null, signal: AbortSignal, guard: (transaction: DatabaseTransactionExecutor) => Promise<void>) {
  const expected = await aiAssistantRepository.getAvatarMediaAssetReference(assistantId);
  if (!expected) throw new SettingChangeConflictError('AI 已被删除，本次头像修改未保存。');
  const result = await commitCroppedImageSelection({ mediaAssetId, aspect: [1, 1], signal }, async (tx, assetId) => {
    await guard(tx);
    const changed = await aiAssistantRepository.tryCommitAvatarMediaAssetReferenceInTransaction(tx, { ownerId: assistantId,
      expectedAvatar: expected.avatar, expectedAvatarMediaAssetId: expected.avatarMediaAssetId, mediaAssetId: assetId });
    if (!changed) throw new SettingChangeConflictError('头像在处理期间已被修改或角色已删除，本次操作未覆盖新设置。');
  });
  await releaseMediaAssetCandidates([expected.avatarMediaAssetId]);
  const assistant = await aiAssistantRepository.getById(assistantId);
  if (assistant) emitAIAssistantUpdated(assistant);
  return result;
}

/** 只读取 AI 个人空间封面身份，不加载模型配置或凭据；null 表示角色不存在。 */
export function getAssistantSpaceCoverImageSelection(assistantId: string) {
  return aiAssistantRepository.getProfileCoverReference(assistantId);
}

/** 主页与朋友圈共用 Assistants 的空间封面事实，媒体处理与提交资格沿用图片设置契约。 */
export async function changeAssistantSpaceCoverFromMediaAsset(assistantId: string, mediaAssetId: string, signal: AbortSignal, guard: (transaction: DatabaseTransactionExecutor) => Promise<void>) {
  const expected = await aiAssistantRepository.getProfileCoverReference(assistantId);
  if (!expected) throw new SettingChangeConflictError('AI 已被删除，本次个人空间封面修改未保存。');
  const result = await commitCroppedImageSelection({ mediaAssetId, aspect: [2, 1], signal }, async (tx, assetId) => {
    await guard(tx);
    // 此命令只设置图片；媒体入口在非空输入时保证回调得到已准备好的资产 ID。
    const changed = await aiAssistantRepository.tryCommitProfileCoverInTransaction(tx, assistantId, expected.mediaAssetId, assetId!);
    if (!changed) throw new SettingChangeConflictError('个人空间封面在处理期间已被修改或角色已删除，本次操作未覆盖新设置。');
  });
  await releaseMediaAssetCandidates([expected.mediaAssetId]);
  const assistant = await aiAssistantRepository.getById(assistantId);
  if (assistant) emitAIAssistantUpdated(assistant);
  return result;
}

/** 改公开名称不修改用户私有昵称，也不改写历史正文或身份键。 */
export async function changeAssistantPublicName(assistantId: string, name: string, guard: (transaction: DatabaseTransactionExecutor) => Promise<void>): Promise<void> {
  const expected = await aiAssistantRepository.getById(assistantId);
  if (!expected) throw new SettingChangeConflictError('AI 已被删除，本次名称修改未保存。');
  await databaseCoordinator.transaction({ name: 'assistants.change-public-name', feature: 'assistants', priority: 'interactive' }, async tx => {
    await guard(tx);
    if (!await aiAssistantRepository.changeNameInTransaction(tx, assistantId, expected.name, name)) {
      throw new SettingChangeConflictError('名称已被其他操作修改或角色已删除，本次操作未覆盖新设置。');
    }
  });
  const assistant = await aiAssistantRepository.getById(assistantId);
  if (assistant) emitAIAssistantUpdated(assistant);
}

const aiAssistantUpdatedListeners = new Set<AIAssistantUpdatedListener>();

function emitAIAssistantUpdated(assistant: AIProfile): void {
  for (const listener of aiAssistantUpdatedListeners) {
    listener(assistant);
  }
}

/** 服务更新已提交后刷新角色投影，事件不携带额外连接真值。 */
export async function notifyAssistantServiceConnectionsChanged(serviceConfigId: string): Promise<void> {
  for (const id of await aiAssistantRepository.listServiceAssistantIds(serviceConfigId)) {
    const assistant = await aiAssistantRepository.getById(id);
    if (assistant) emitAIAssistantUpdated(assistant);
  }
}

export function subscribeAIAssistantUpdated(
  listener: AIAssistantUpdatedListener,
): () => void {
  aiAssistantUpdatedListeners.add(listener);
  return () => aiAssistantUpdatedListeners.delete(listener);
}

export async function setLedgerAIAssistant(aiId: string | null): Promise<boolean> {
  return aiAssistantRepository.setLedgerAI(aiId);
}

export async function getHostAIAssistant(): Promise<AIProfile | null> {
  return aiAssistantRepository.getHostAI();
}

export async function appointHostAIAssistant(aiId: string): Promise<boolean> {
  return hostAuthorityCoordinator.runHostMutation(async () => {
    const assistant = await aiAssistantRepository.getById(aiId);
    if (!assistant) {
      throw new HostRelationshipError('assistant_not_found', '指定的 AI 不存在');
    }
    if (assistant.isBlocked) {
      throw new HostRelationshipError('assistant_blocked', '被限制的 AI 不能成为主理 AI');
    }
    if (!assistant.model.trim()) {
      throw new HostRelationshipError(
        'assistant_model_unconfigured',
        '没有可用聊天模型的 AI 不能成为主理 AI'
      );
    }
    const appointed = await aiHostRepository.setHostAI(aiId);
    if (appointed && !assistant.isHostAI) {
      await requireChatSessionGateway().onHostRelationshipChanged(aiId, 'appointed', new Date().toISOString());
    }
    return appointed;
  });
}

export async function revokeHostAIAssistant(aiId: string): Promise<boolean> {
  return hostAuthorityCoordinator.runHostMutation(async () => {
    const assistant = await aiAssistantRepository.getById(aiId);
    const revoked = await aiHostRepository.revokeHostAI(aiId);
    if (revoked && assistant?.isHostAI) {
      const gateway = requireChatSessionGateway();
      await Promise.all([
        gateway.onHostRelationshipChanged(aiId, 'revoked', new Date().toISOString()),
        gateway.onHostRelationshipRemoved(aiId, 'revoked'),
      ]);
    }
    return revoked;
  });
}

/** 在当前主理身份仍成立的同一串行边界内完成高权限副作用。 */
export function runAsCurrentHostAuthority<T>(
  actorAiId: string,
  action: () => Promise<T>,
): Promise<CurrentHostAuthorityResult<T>> {
  return hostAuthorityCoordinator.runAsCurrentHost(actorAiId, action);
}

/** 供 Host 恢复出厂等跨 Feature 关系清理复用同一裁决边界。 */
export function runHostAuthorityMutation<T>(
  mutation: () => Promise<T>,
): Promise<T> {
  return hostAuthorityCoordinator.runHostMutation(mutation);
}

export async function getHostAICooldownStatus() {
  const appointment = await aiHostRepository.checkHostCooldown();
  return { appointment };
}

/** 只能由冷静期中的原主理 AI 决定解除，不恢复主理身份。 */
export async function releaseHostAICooldown(actorAIId: string, signal?: AbortSignal): Promise<boolean> {
  return hostAuthorityCoordinator.runHostMutation(() => {
    throwIfAbortSignalAborted(signal);
    return aiHostRepository.releaseAppointmentCooldown(actorAIId);
  });
}

function requireChatSessionGateway(): AssistantChatSessionGateway {
  if (!chatSessionGateway) {
    throw new Error('助手聊天会话网关尚未配置');
  }
  return chatSessionGateway;
}
