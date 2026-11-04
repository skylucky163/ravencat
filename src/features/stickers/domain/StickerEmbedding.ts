/** Sticker 语义向量的领域规则：语义文本、向量有效性与维度比较。 */

import type { Sticker } from './Sticker';

/** 向量按 (stickerId, modelConfigId) 归属；有效性判定见 isStickerEmbeddingValid。 */
export interface StickerEmbedding {
  stickerId: string;
  modelConfigId: string;
  modelConfigUpdatedAt: string;
  semanticRevision: number;
  dimension: number;
  vector: number[];
  createdAt: string;
  updatedAt: string;
}

/** 向量索引有效数量的即时快照；逐张请求错误由处理进度查询单独提供。 */
export interface StickerEmbeddingIndexStatus {
  /** annotationStatus = ready 且可被 AI 消费的 Sticker 总数。 */
  readyStickers: number;
  /** 对当前模型 / revision / 指纹全部有效的向量数。 */
  validEmbeddings: number;
  /** ready 但尚无有效向量的数量，包含未配置模型时的全部 ready。 */
  pendingEmbeddings: number;
}

/**
 * 语义文本是 embedding 输入的唯一 canonical 形状：只包含 name / description /
 * tags / emotion。分组、收藏、使用计数等浏览与 rerank 维度不属于图片本身语义，
 * 不进入向量，否则会污染相似度排序。
 */
export function buildStickerSemanticText(sticker: Sticker): string {
  const lines: string[] = [];
  const name = sticker.name.trim();
  if (name) lines.push(`名称：${name}`);
  const description = sticker.description?.trim();
  if (description) lines.push(`描述：${description}`);
  const tags = sticker.tags.map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > 0) lines.push(`标签：${tags.join('、')}`);
  const emotion = sticker.emotion?.trim();
  if (emotion) lines.push(`情绪：${emotion}`);
  return lines.join('\n');
}

/**
 * 向量有效的四条硬性条件。任何一条不满足都判 stale：换模型、模型配置被编辑
 * （updatedAt 指纹变化，即使只是 API Key）、semantic metadata 重写或维度不同。
 */
export function isStickerEmbeddingValid(
  embedding: Pick<
    StickerEmbedding,
    'modelConfigId' | 'modelConfigUpdatedAt' | 'semanticRevision' | 'dimension'
  >,
  context: {
    modelConfigId: string;
    modelConfigUpdatedAt: string;
    semanticRevision: number;
    dimension: number;
  },
): boolean {
  return (
    embedding.modelConfigId === context.modelConfigId
    && embedding.modelConfigUpdatedAt === context.modelConfigUpdatedAt
    && embedding.semanticRevision === context.semanticRevision
    && embedding.dimension === context.dimension
  );
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
