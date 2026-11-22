/** 独立记忆正文及可解释的字面检索契约。 */

export const MEMORY_SUMMARY_MAX_CHARACTERS = 50;
export const DEFAULT_PASSIVE_RECALL_LIMIT = 5;
export const DEFAULT_ACTIVE_RECALL_PAGE_SIZE = 10;
export const PASSIVE_RECALL_LIMIT_OPTIONS = [0, 3, 5, 10, 20] as const;
export const ACTIVE_RECALL_PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const;
export const MEMORY_EMBEDDING_MAX_ATTEMPTS = 3;

export type MemoryEmbeddingStatus = 'not_requested' | 'pending' | 'retry_wait' | 'ready' | 'stale' | 'failed';

export interface MemoryEntry {
  id: string;
  poolId: string;
  content: string;
  summary: string | null;
  contentRevision: number;
  rememberedAt: string;
  createdAt: string;
  updatedAt: string;
  embeddingStatus: MemoryEmbeddingStatus;
  embeddingModelName: string | null;
  embeddingError: string | null;
  embeddingFailedAt: string | null;
}

export interface MemorySpaceDescriptor {
  poolId: string;
  assistantId: string;
  assistantName: string;
  assistantAvatar: string | null;
  isHost: boolean;
}

export interface MemoryRecallSettings {
  passiveLimit: number;
  activePageSize: number;
}

export interface MemoryTriggerKeyword {
  keyword: string;
  normalizedKeyword: string;
}

export interface PassiveTriggerGroup {
  id: string;
  poolId: string;
  keywords: MemoryTriggerKeyword[];
  autoAssociate: boolean;
  associatedCount: number;
  enabledCount: number;
}

export interface PassiveTriggerMemory {
  memory: MemoryEntry;
  autoRecall: boolean;
}

export interface MemoryRecallInput {
  query?: string;
  keywords?: string[];
  offset?: number;
}

export interface MemoryRecallPage {
  entries: MemoryEntry[];
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  semanticUnavailable: string | null;
}

export class MemoryInputError extends Error {}
export class MemoryVectorDimensionError extends Error {
  constructor() { super('当前向量模型返回的维度与已建立的记忆索引不一致，请检查模型配置后重新向量化'); }
}
export class MemoryNotFoundError extends Error {
  constructor() { super('当前记忆空间中不存在这条记忆'); }
}
export class MemoryTriggerNotFoundError extends Error {
  constructor() { super('当前记忆空间中不存在这个关联组'); }
}

/** 一次输入属于一个组；只在组内去重，跨组同名词保留各自的规则。 */
export function requireMemoryTriggerKeywords(value: string): MemoryTriggerKeyword[] {
  const keywords = new Map<string, string>();
  for (const item of value.split(/[,，、;；\r\n]+/)) {
    const keyword = item.trim();
    const normalized = normalizeMemoryText(keyword);
    if (normalized && !keywords.has(normalized)) keywords.set(normalized, keyword);
  }
  if (keywords.size === 0) throw new MemoryInputError('触发词不能为空');
  return Array.from(keywords, ([normalizedKeyword, keyword]) => ({ keyword, normalizedKeyword }));
}

/** 正文唯一输入边界；检索 normalization 不能改写用户保存的内容。 */
export function requireMemoryContent(value: string): string {
  const content = value.trim();
  if (!content) throw new MemoryInputError('记忆正文不能为空');
  return content;
}

/** 摘要选填；历史正文无需自动生成摘要。 */
export function requireMemorySummary(value: string | null): string | null {
  const summary = value?.trim() || null;
  if (summary && Array.from(summary).length > MEMORY_SUMMARY_MAX_CHARACTERS) {
    throw new MemoryInputError('记忆摘要最多 50 字');
  }
  return summary;
}

/** 检索同时保留主题提示与正文细节，不能只对摘要生成向量。 */
export function memorySearchText(entry: { content: string; summary: string | null }): string {
  return entry.summary ? `${entry.summary}\n${entry.content}` : entry.content;
}

export function normalizeMemoryText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

export function normalizeMemoryKeywords(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeMemoryText).filter(Boolean))).sort();
}

export function countMemoryKeywordMatches(entry: { content: string; summary: string | null }, keywords: readonly string[]): number {
  const content = normalizeMemoryText(entry.content);
  const summary = normalizeMemoryText(entry.summary ?? '');
  return keywords.filter((keyword) => content.includes(keyword) || summary.includes(keyword)).length;
}

export function compareMemoryRecency(left: MemoryEntry, right: MemoryEntry): number {
  if (left.rememberedAt !== right.rememberedAt) return left.rememberedAt > right.rememberedAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 向量只补充无字面命中的条目，不以向量化进度提升弱关键词结果。 */
export function rankMemoryEntries(
  entries: readonly MemoryEntry[],
  keywords: readonly string[],
  similarities: ReadonlyMap<string, number>,
): MemoryEntry[] {
  const lexical = entries.map((entry) => ({ entry, matches: countMemoryKeywordMatches(entry, keywords) }));
  const first = lexical.filter(({ matches }) => matches > 0)
    .sort((a, b) => b.matches - a.matches || compareMemoryRecency(a.entry, b.entry));
  const second = lexical.filter(({ entry, matches }) => matches === 0 && similarities.has(entry.id))
    .sort((a, b) => similarities.get(b.entry.id)! - similarities.get(a.entry.id)! || compareMemoryRecency(a.entry, b.entry));
  return [...first, ...second].map(({ entry }) => entry);
}
