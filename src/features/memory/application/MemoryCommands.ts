/** 用户与工具共用的正文输入边界；pool 由已授权的 AI 身份解析。 */
import { randomUUID } from 'expo-crypto';
import { ACTIVE_RECALL_PAGE_SIZE_OPTIONS, PASSIVE_RECALL_LIMIT_OPTIONS, MemoryInputError, normalizeMemoryText, requireMemoryContent, requireMemorySummary, requireMemoryTriggerKeywords, type MemoryRecallSettings } from '../domain/Memory';
import type { CreateMemoryRecord } from '../domain/MemoryRepository';
import { getMemoryRuntimeDependencies } from './MemoryRuntimeDependencies';
import { emitMemoryChanged } from './MemorySignals';
import { synchronizeMemoryEmbeddingModel } from './MemoryEmbeddingModels';

/** 用户、工具与 Host 的跨 Feature 转存复用同一输入边界。 */
export function prepareMemoryRecord(poolId: string, value: string, summaryValue: string | null, writeKey: string | null): CreateMemoryRecord {
  const content = requireMemoryContent(value);
  const summary = requireMemorySummary(summaryValue);
  return { id: randomUUID(), poolId, content, summary, normalizedContent: normalizeMemoryText(content),
    now: new Date().toISOString(), writeKey };
}

export async function rememberMemory(assistantId: string, value: string, writeKey: string | null = null, summaryValue: string | null = null) {
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  const entry = await runtime.repository.createEntry(prepareMemoryRecord(space.poolId, value, summaryValue, writeKey));
  emitMemoryChanged();
  return entry;
}
export async function editMemory(assistantId: string, memoryId: string, value: string, summaryValue?: string | null) {
  const content = requireMemoryContent(value);
  const summary = summaryValue === undefined ? undefined : requireMemorySummary(summaryValue);
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  const entry = await runtime.repository.updateEntry(space.poolId, memoryId, content, normalizeMemoryText(content), new Date().toISOString(), summary);
  emitMemoryChanged();
  return entry;
}
export async function forgetMemory(assistantId: string, memoryId: string) {
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  const deleted = await runtime.repository.deleteEntry(space.poolId, memoryId);
  emitMemoryChanged();
  return deleted;
}
export async function retryMemoryEmbedding(assistantId: string, memoryId: string) {
  const runtime = getMemoryRuntimeDependencies();
  await runtime.withEmbeddingMaintenance(async () => {
    const space = await runtime.resolveMemorySpace(assistantId);
    const { model, revision } = await synchronizeMemoryEmbeddingModel();
    if (!model) throw new MemoryInputError('请先开启记忆向量化，并选择可用的向量模型');
    if (revision === null) throw new MemoryInputError('向量模型已变化，请重新请求');
    await runtime.repository.retryEmbedding(space.poolId, memoryId, revision);
  });
  emitMemoryChanged();
}
export async function selectMemorySpace(assistantId: string) {
  const runtime = getMemoryRuntimeDependencies();
  await runtime.resolveMemorySpace(assistantId);
  await runtime.repository.setPreferredAssistantId(assistantId);
  // 选择偏好不是记忆内容变化；页面已拥有选中状态，不能因此重查正文并唤醒向量队列。
}
export async function setMemoryRecallSettings(assistantId: string, settings: MemoryRecallSettings) {
  if (!(PASSIVE_RECALL_LIMIT_OPTIONS as readonly number[]).includes(settings.passiveLimit)
    || !(ACTIVE_RECALL_PAGE_SIZE_OPTIONS as readonly number[]).includes(settings.activePageSize)) {
    throw new MemoryInputError('请选择提供的召回数量');
  }
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  await runtime.repository.setRecallSettings(space.poolId, settings);
  emitMemoryChanged();
}
/** 新组只绑定用户选中的记忆；文本自动关联是各组可选的规则。 */
export async function addMemoryTrigger(assistantId: string, value: string, memoryIds: string[], autoAssociate = false) {
  const keywords = requireMemoryTriggerKeywords(value);
  const ids = Array.from(new Set(memoryIds));
  if (!autoAssociate && ids.length === 0) throw new MemoryInputError('请至少选择一条关联记忆');
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  const groupId = randomUUID();
  await runtime.repository.createTriggerGroup(space.poolId, groupId, keywords, ids, autoAssociate);
  emitMemoryChanged();
  return groupId;
}
export async function editMemoryTrigger(assistantId: string, groupId: string, value: string, autoAssociate: boolean) {
  const keywords = requireMemoryTriggerKeywords(value);
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  await runtime.repository.updateTriggerGroup(space.poolId, groupId, keywords, autoAssociate);
  emitMemoryChanged();
}
export async function deleteMemoryTrigger(assistantId: string, triggerId: string) {
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  await runtime.repository.deleteTrigger(space.poolId, triggerId);
  emitMemoryChanged();
}
export async function setMemoryAutoRecall(assistantId: string, triggerId: string, memoryId: string, enabled: boolean) {
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  await runtime.repository.setAutoRecall(space.poolId, triggerId, memoryId, enabled);
  emitMemoryChanged();
}
