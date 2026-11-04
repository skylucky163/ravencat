/** 管理页与被动召回只读取当前空间；没有主题树或原文证据。 */
import { normalizeMemoryText } from '../domain/Memory';
import { getMemoryRuntimeDependencies } from './MemoryRuntimeDependencies';

export async function getMemoryManagementSnapshot(assistantId?: string) {
  const runtime = getMemoryRuntimeDependencies();
  const [descriptors, preferred, counts, embeddingSettings] = await Promise.all([
    runtime.listMemorySpaces(), runtime.repository.getPreferredAssistantId(), runtime.repository.listEntryCounts(),
    runtime.repository.getEmbeddingSettings(),
  ]);
  const spaces = descriptors.map(space => ({ ...space, memoryCount: counts.get(space.poolId) ?? 0 }));
  const selectedSpace = spaces.find((space) => space.assistantId === assistantId)
    ?? spaces.find((space) => space.assistantId === preferred)
    ?? spaces.find((space) => space.isHost) ?? spaces[0] ?? null;
  if (!selectedSpace) return { spaces, selectedSpace, entries: [], triggers: [], settings: null, embeddingEnabled: embeddingSettings.enabled };
  const [entries, triggers, settings] = await Promise.all([
    runtime.repository.listEntries(selectedSpace.poolId), runtime.repository.listTriggers(selectedSpace.poolId),
    runtime.repository.getRecallSettings(selectedSpace.poolId),
  ]);
  return { spaces, selectedSpace, entries, triggers, settings, embeddingEnabled: embeddingSettings.enabled };
}
export type MemoryManagementSnapshot = Awaited<ReturnType<typeof getMemoryManagementSnapshot>>;
export async function listMemoryTriggerEntries(assistantId: string, triggerId: string) {
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  return runtime.repository.listTriggerMemories(space.poolId, triggerId);
}
export async function recallPassiveMemory(assistantId: string, currentInput: string) {
  const runtime = getMemoryRuntimeDependencies();
  const space = await runtime.resolveMemorySpace(assistantId);
  return runtime.repository.recallPassive(space.poolId, normalizeMemoryText(currentInput));
}
