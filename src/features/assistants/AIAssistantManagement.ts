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
import { CoordinatedDatabaseError, databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
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
import { assistantRecycleBinRepository } from './infrastructure/SQLiteAssistantRecycleBinRepository';
import type { AssistantRecycleLifecycleChange } from './domain/AssistantRecycleBin';

export interface AssistantRuntimeGateway {
  recordRecycleLifecycleInTransaction(transaction: DatabaseTransactionExecutor, change: AssistantRecycleLifecycleChange): Promise<() => void>;
  suspendAssistantInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string): Promise<() => Promise<void>>;
  purgeAssistantInTransaction(transaction: DatabaseTransactionExecutor, assistantId: string, agentId: string): Promise<readonly string[]>;
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

let assistantRuntimeGateway: AssistantRuntimeGateway | null = null;
const hostAuthorityCoordinator = new HostAuthorityCoordinator(aiHostRepository);
const hostAppointmentListeners = new Set<() => void>();

export function subscribeHostAppointmentChanged(listener: () => void): () => void {
  hostAppointmentListeners.add(listener);
  return () => { hostAppointmentListeners.delete(listener); };
}

function emitHostAppointmentChanged() {
  for (const listener of hostAppointmentListeners) listener();
}

export function configureAssistantRuntime(gateway: AssistantRuntimeGateway): void {
  assistantRuntimeGateway = gateway;
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
    const result = await assistantRecycleBinRepository.recycle(aiId, async (transaction, change) => {
      const gateway = requireAssistantRuntimeGateway();
      const notify = await gateway.recordRecycleLifecycleInTransaction(transaction, change);
      const suspend = await gateway.suspendAssistantInTransaction(transaction, aiId);
      return async () => { notify(); await suspend(); };
    });
    if (!result) return false;
    if (result.wasHost) emitHostAppointmentChanged();
    emitAssistantLifecycleChanged(aiId, 'recycled');
    await Promise.all([result.afterCommit(), result.wasHost
      ? requireAssistantRuntimeGateway().onHostRelationshipRemoved(aiId, 'deleted') : Promise.resolve()]);
    return true;
  });
}

export const listRecycledAIAssistants = () => assistantRecycleBinRepository.list();
export const getNextAIRecycleBinExpiry = () => assistantRecycleBinRepository.getNextExpiry();

export async function restoreAIAssistant(aiId: string): Promise<boolean> {
  return hostAuthorityCoordinator.runHostMutation(async () => {
    const result = await assistantRecycleBinRepository.restore(aiId, new Date(), (tx, change) =>
      requireAssistantRuntimeGateway().recordRecycleLifecycleInTransaction(tx, change));
    if (!result) return false;
    result.afterCommit();
    emitAssistantLifecycleChanged(aiId, 'restored');
    return true;
  });
}

async function purgeRecycledAssistant(aiId: string, deletedAt: string): Promise<boolean> {
  const result = await aiAssistantRepository.delete(aiId, { deletedAt,
    beforeDelete: (transaction, agentId) => requireAssistantRuntimeGateway().purgeAssistantInTransaction(transaction, aiId, agentId) });
  if (result.deleted) {
    emitAssistantLifecycleChanged(aiId, 'purged');
    await releaseMediaAssetCandidates(result.mediaAssetCandidates);
  }
  return result.deleted;
}

export async function permanentlyDeleteAIAssistant(aiId: string): Promise<boolean> {
  const deletion = await assistantRecycleBinRepository.getDeletion(aiId);
  return deletion ? purgeRecycledAssistant(aiId, deletion.deletedAt) : false;
}

/** 进程不在运行时不额外唤醒设备；启动、前台恢复及到期维护共用这一个清理命令。 */
export async function purgeExpiredAIAssistants(): Promise<void> {
  for (const deletion of await assistantRecycleBinRepository.listExpired(new Date())) {
    await purgeRecycledAssistant(deletion.id, deletion.deletedAt);
  }
}

type AssistantLifecycleChange = { assistantId: string; change: 'recycled' | 'restored' | 'purged' };
const assistantLifecycleListeners = new Set<(event: AssistantLifecycleChange) => void>();
function emitAssistantLifecycleChanged(assistantId: string, change: AssistantLifecycleChange['change']) {
  for (const listener of assistantLifecycleListeners) listener({ assistantId, change });
}
export function subscribeAssistantLifecycleChanged(listener: (event: AssistantLifecycleChange) => void): () => void {
  assistantLifecycleListeners.add(listener);
  return () => assistantLifecycleListeners.delete(listener);
}

export async function createAIAssistant(aiAssistant: AIProfile): Promise<AIProfile> {
  const insertedAI = await aiAssistantRepository.insert(aiAssistant);

  try {
    const conversation = await requireAssistantRuntimeGateway()
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
      : await requireAssistantRuntimeGateway().recordNicknameChangeInTransaction(transaction, result.nicknameChange);
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
export async function notifyAssistantServiceConnectionsChanged(serviceConfigId: string, detachedAssistantIds?: string[]): Promise<boolean> {
  let refreshed = true;
  for (const id of detachedAssistantIds ?? await aiAssistantRepository.listServiceAssistantIds(serviceConfigId)) {
    try {
      const assistant = await aiAssistantRepository.getById(id);
      if (assistant) {
        for (const listener of aiAssistantUpdatedListeners) {
          try { listener(assistant); } catch { refreshed = false; }
        }
      }
    } catch { refreshed = false; }
  }
  return refreshed;
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
    let afterCommit: (() => Promise<void>) | null;
    try {
      afterCommit = await databaseCoordinator.transaction(
        { name: 'assistants.appoint-host', feature: 'assistants', priority: 'interactive' },
        (tx) => appointHostAIAssistantInTransaction(tx, aiId),
      );
    } catch (error) {
      if (error instanceof CoordinatedDatabaseError && error.cause instanceof HostRelationshipError) throw error.cause;
      throw error;
    }
    await afterCommit?.();
    return true;
  });
}

/** 设置页与申请卡共用任命裁决，通知由持有事务的调用方于提交后执行。 */
export async function appointHostAIAssistantInTransaction(
  tx: DatabaseTransactionExecutor, aiId: string,
): Promise<(() => Promise<void>) | null> {
  const assistant = await aiAssistantRepository.readHostAppointmentCandidate(tx, aiId);
  if (!assistant) throw new HostRelationshipError('assistant_not_found', '指定的 AI 不存在');
  if (assistant.blocked_until) throw new HostRelationshipError('assistant_blocked', '被限制的 AI 不能成为主理 AI');
  if (!assistant.model.trim()) {
    throw new HostRelationshipError('assistant_model_unconfigured', '没有可用聊天模型的 AI 不能成为主理 AI');
  }
  if (!await aiHostRepository.setHostAIInTransaction(tx, aiId)) return null;
  const occurredAt = new Date().toISOString();
  return async () => {
    emitHostAppointmentChanged();
    await requireAssistantRuntimeGateway().onHostRelationshipChanged(aiId, 'appointed', occurredAt);
  };
}

export async function revokeHostAIAssistant(aiId: string): Promise<boolean> {
  return hostAuthorityCoordinator.runHostMutation(async () => {
    const assistant = await aiAssistantRepository.getById(aiId);
    const revoked = await aiHostRepository.revokeHostAI(aiId);
    if (revoked && assistant?.isHostAI) {
      emitHostAppointmentChanged();
      const gateway = requireAssistantRuntimeGateway();
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

export function getHostAppointmentAvailability() {
  return aiHostRepository.getAppointmentAvailability();
}

/** 只能由冷静期中的原主理 AI 决定解除，不恢复主理身份。 */
export async function releaseHostAICooldown(actorAIId: string, signal?: AbortSignal): Promise<boolean> {
  return hostAuthorityCoordinator.runHostMutation(async () => {
    throwIfAbortSignalAborted(signal);
    const released = await aiHostRepository.releaseAppointmentCooldown(actorAIId);
    if (released) emitHostAppointmentChanged();
    return released;
  });
}

function requireAssistantRuntimeGateway(): AssistantRuntimeGateway {
  if (!assistantRuntimeGateway) {
    throw new Error('AI 助手运行时网关尚未配置');
  }
  return assistantRuntimeGateway;
}
