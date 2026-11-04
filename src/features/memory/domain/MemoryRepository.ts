/** Memory 持久化 port：pool 授权与向量任务的原子比较由 Repository 拥有。 */

import type { MemoryEntry, MemoryRecallSettings, MemoryTriggerKeyword, PassiveTriggerGroup, PassiveTriggerMemory } from './Memory';

export interface MemoryEmbeddingModel {
  id: string;
  name: string;
  fingerprint: string;
  baseURL: string;
  apiKey: string;
  model: string;
  metadataJson: string | null;
}

export interface MemoryVector {
  memoryId: string;
  vector: number[];
}

export interface MemoryEmbeddingClaim {
  memoryId: string;
  content: string;
  summary: string | null;
  contentRevision: number;
  modelFingerprint: string;
  claimId: string;
  attempts: number;
  indexRevision: number;
}

export interface MemoryEmbeddingRebuild {
  id: string;
  revision: number;
  model: MemoryEmbeddingModel;
  entries: { id: string; content: string; summary: string | null; contentRevision: number }[];
}

export interface CreateMemoryRecord {
  id: string;
  poolId: string;
  content: string;
  summary: string | null;
  normalizedContent: string;
  now: string;
  writeKey: string | null;
}

export interface MemoryRepository {
  getEmbeddingSettings(): Promise<{ enabled: boolean; modelConfigId: string | null }>;
  setEmbeddingModelId(modelConfigId: string | null): Promise<void>;
  setEmbeddingEnabled(enabled: boolean): Promise<void>;
  clearEmbeddings(model: MemoryEmbeddingModel | null): Promise<void>;
  listEntries(poolId: string): Promise<MemoryEntry[]>;
  /** 聚合全部空间的正文数量；没有条目的空间不出现在结果中。 */
  listEntryCounts(): Promise<ReadonlyMap<string, number>>;
  getEntry(poolId: string, memoryId: string): Promise<MemoryEntry | null>;
  createEntry(input: CreateMemoryRecord): Promise<MemoryEntry>;
  updateEntry(poolId: string, memoryId: string, content: string, normalizedContent: string, now: string, summary?: string | null): Promise<MemoryEntry>;
  deleteEntry(poolId: string, memoryId: string): Promise<boolean>;
  getPreferredAssistantId(): Promise<string | null>;
  setPreferredAssistantId(assistantId: string): Promise<void>;
  getRecallSettings(poolId: string): Promise<MemoryRecallSettings>;
  setRecallSettings(poolId: string, settings: MemoryRecallSettings): Promise<void>;
  listTriggers(poolId: string): Promise<PassiveTriggerGroup[]>;
  createTriggerGroup(poolId: string, groupId: string, keywords: MemoryTriggerKeyword[], memoryIds: string[], autoAssociate: boolean): Promise<void>;
  updateTriggerGroup(poolId: string, groupId: string, keywords: MemoryTriggerKeyword[], autoAssociate: boolean): Promise<void>;
  deleteTrigger(poolId: string, triggerId: string): Promise<void>;
  listTriggerMemories(poolId: string, triggerId: string): Promise<PassiveTriggerMemory[]>;
  setAutoRecall(poolId: string, triggerId: string, memoryId: string, enabled: boolean): Promise<void>;
  recallPassive(poolId: string, normalizedInput: string): Promise<MemoryEntry[]>;
  getEmbeddingIndexRevision(): Promise<number>;
  syncEmbeddingModel(model: MemoryEmbeddingModel | null, expectedRevision: number): Promise<number | null>;
  beginEmbeddingRebuild(id: string, model: MemoryEmbeddingModel, expectedRevision: number): Promise<MemoryEmbeddingRebuild>;
  publishEmbeddingRebuild(build: MemoryEmbeddingRebuild, vectors: number[][], signal: AbortSignal): Promise<void>;
  finishEmbeddingRebuild(id: string): Promise<void>;
  countEmbeddingIndex(fingerprint: string | null): Promise<{ total: number; valid: number }>;
  readRecallCandidates(poolId: string, fingerprint: string | null, dimension: number | null): Promise<{ entries: MemoryEntry[]; vectors: MemoryVector[] }>;
  claimEmbedding(fingerprint: string, claimId: string, now: string, expiresAt: string, expectedRevision: number): Promise<MemoryEmbeddingClaim | null>;
  completeEmbedding(claim: MemoryEmbeddingClaim, vector: number[]): Promise<'accepted' | 'discarded' | 'dimension_mismatch'>;
  failEmbedding(claim: MemoryEmbeddingClaim, error: string, terminal: boolean, now: string, retryAt: string): Promise<boolean>;
  releaseEmbedding(claim: MemoryEmbeddingClaim): Promise<void>;
  retryEmbedding(poolId: string, memoryId: string, expectedRevision: number): Promise<void>;
  getNextEmbeddingWakeAt(fingerprint: string): Promise<string | null>;
}
