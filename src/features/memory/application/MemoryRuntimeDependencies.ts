/** Memory 的应用端口；Host 负责模型解析与外部 AI 调用。 */
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import type { MemoryEntry, MemorySpaceDescriptor } from '../domain/Memory';
import type { AgentToolExecutionContext } from '@shared/aiTools';
import type { MemoryEmbeddingModel, MemoryRepository } from '../domain/MemoryRepository';

export class MemoryEmbeddingError extends Error {
  constructor(message: string, readonly terminal: boolean) { super(message); }
}
export interface MemoryEmbeddingModelChoice {
  id: string;
  name: string;
  model: string;
}
export interface MemoryEmbeddingModelSettings {
  models: MemoryEmbeddingModelChoice[];
  selectedModelId: string | null;
  selectedModelName: string | null;
  status: 'unconfigured' | 'active' | 'unavailable';
  unavailableReason: string | null;
}
export interface MemoryRuntimeDependencies {
  repository: MemoryRepository;
  /** Host 组合 Chat 的退出快照、模型提炼与 Memory 原子写入。 */
  convertExitedGroupHistory(groupId: string, context: AgentToolExecutionContext): Promise<MemoryEntry>;
  listMemorySpaces(): Promise<MemorySpaceDescriptor[]>;
  resolveMemorySpace(assistantId: string): Promise<MemorySpaceDescriptor>;
  resolveEmbeddingModel(): Promise<MemoryEmbeddingModel | null>;
  getEmbeddingModelSettings(): Promise<MemoryEmbeddingModelSettings>;
  selectEmbeddingModel(modelConfigId: string | null): Promise<void>;
  setEmbeddingEnabled(enabled: boolean): Promise<void>;
  clearEmbeddings(): Promise<void>;
  withEmbeddingMaintenance<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  embed(text: string, model: MemoryEmbeddingModel, signal: AbortSignal): Promise<number[]>;
}
const slot = createRuntimeSlot<MemoryRuntimeDependencies>('Memory');
export function configureMemoryRuntimeDependencies(dependencies: MemoryRuntimeDependencies): void { slot.configure(dependencies); }
export function getMemoryRuntimeDependencies(): MemoryRuntimeDependencies { return slot.get(); }
