/**
 * Sticker 语义搜索：有可用向量时按语义相似度为主做 hybrid rerank，
 * 否则完全退回词面匹配。embedding 是增强能力，不是可用性的单点依赖——
 * 未配置模型、模型失效、query embedding 请求失败或当前没有有效向量时，
 * 都必须退回 lexical 结果而不是让搜索整体失败。
 *
 * 候选集方面：语义召回扫描过滤条件下的全部 ready Sticker（数量由收藏库上限
 * 决定），词面候选只取较小的池用于排名归一，最终 observation 只返回 limit 条。
 *
 * 退回词面的四类边界必须逐条兑现：未配置 embedding 模型、模型失效、query
 * embedding 请求失败，以及候选里一条有效向量都没有（缺失 / 全部 stale /
 * 维度不匹配）。最后一条不能靠“缺省语义分 = 0”来近似，否则 hybrid 排序里
 * 只剩 lexical / favorite / usage，结果既不是语义排序也不是词面 fallback。
 */

import {
  cosineSimilarity,
  isStickerEmbeddingValid,
} from '../domain/StickerEmbedding';
import {
  rankStickerSearchCandidates,
  type StickerSearchCandidateInput,
} from '../domain/StickerSearch';
import type { SearchStickersInput, Sticker } from '../domain/Sticker';
import { getStickersRuntimeDependencies } from './StickerRuntime';
import { resolveStickerEmbeddingModel } from './StickerSystemModels';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

export const STICKER_AI_SEARCH_DEFAULT_LIMIT = 10;
export const STICKER_AI_SEARCH_MAX_LIMIT = 50;

/** 词面候选的排名归一基数：命中越多词面竞争越充分。 */
const LEXICAL_CANDIDATE_POOL = 40;

export interface SearchStickersOptions {
  signal?: AbortSignal;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return STICKER_AI_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(STICKER_AI_SEARCH_MAX_LIMIT, Math.floor(limit)));
}

function lexicalScoreByRank(rank: number, total: number): number {
  if (total <= 0) return 0;
  return (total - rank) / total;
}

/** 词面 fallback：保持既有 name / description / tags / emotion 匹配行为。 */
async function lexicalFallback(
  input: SearchStickersInput,
  limit: number,
): Promise<Sticker[]> {
  const runtime = getStickersRuntimeDependencies();
  return runtime.repository.searchStickers({ ...input, readyOnly: true, includeOwnUnannotated: true, limit });
}

export async function searchStickersForAI(
  input: SearchStickersInput = {},
  options: SearchStickersOptions = {},
): Promise<Sticker[]> {
  const limit = clampLimit(input.limit);
  const runtime = getStickersRuntimeDependencies();

  // 词面候选同时是 fallback 结果与 rerank 的 lexical 信号来源。
  const lexical = await lexicalFallback(
    input,
    Math.max(limit, LEXICAL_CANDIDATE_POOL),
  );

  if (!input.query?.trim()) {
    // 无自然语言 query 时退化为词面 / 行为排序。
    return lexical.slice(0, limit);
  }

  const model = await resolveStickerEmbeddingModel();
  if (!model) return lexical.slice(0, limit);

  const signal = options.signal ?? new AbortController().signal;
  let queryVector: number[] | undefined;
  try {
    [queryVector] = await runtime.embeddings.embedTexts([input.query.trim()], model, signal);
  } catch (error) {
    throwIfAbortSignalAborted(signal);
    console.warn('[Sticker] 查询向量生成失败，退回词面搜索：', error);
    return lexical.slice(0, limit);
  }
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    return lexical.slice(0, limit);
  }

  // 语义候选必须覆盖当前结构化过滤条件下的全部 ready Sticker：STICKER_LIST_LIMIT
  // 是 UI / 普通列表分页上限，用它截断语义召回会让排在后面的有效向量永远参与不到
  // 排序。候选全量只发生在本地检索内部，不会进入模型上下文。
  const pool = await runtime.repository.listReadyStickersForSemanticSearch({
    assistantId: input.assistantId,
    groupId: input.groupId,
    tags: input.tags,
    emotion: input.emotion,
  });
  if (pool.length === 0) return lexical.slice(0, limit);

  const embeddings = await runtime.repository.listStickerEmbeddingsByStickerIds(
    pool.map((sticker) => sticker.id),
    model.id,
  );
  const embeddingsByStickerId = new Map(
    embeddings.map((embedding) => [embedding.stickerId, embedding]),
  );

  const candidates: StickerSearchCandidateInput[] = [];
  /**
   * 当前候选里真正可参与 cosine 的向量数量。一条都没有时不能继续走 hybrid：
   * semanticScore 会全部缺省并被当作 0 分，而 lexical / favorite / usage 仍然
   * 会叠加，排序结果就变成既不是语义排序、也不等价于词面 fallback 的第三种
   * 结果。刚切换 embedding 模型、刚重建索引、worker 还没补齐向量时最容易命中。
   */
  let validEmbeddingCount = 0;
  for (const sticker of pool) {
    const embedding = embeddingsByStickerId.get(sticker.id);
    // 有效性继续由 isStickerEmbeddingValid 的四元组判定：库里存在 embedding row
    // 并不等于有效，全部 stale 同样必须退回词面结果。
    const valid = embedding !== undefined && isStickerEmbeddingValid(embedding, {
      modelConfigId: model.id,
      modelConfigUpdatedAt: model.updatedAt,
      semanticRevision: sticker.semanticRevision,
      dimension: queryVector.length,
    });
    if (valid) validEmbeddingCount += 1;
    const semanticScore = valid
      ? (cosineSimilarity(queryVector, embedding.vector) + 1) / 2
      : undefined;
    const lexicalRank = lexical.findIndex((item) => item.id === sticker.id);
    candidates.push({
      stickerId: sticker.id,
      semanticScore,
      lexicalScore: lexicalRank >= 0 ? lexicalScoreByRank(lexicalRank, lexical.length) : 0,
      isFavorite: sticker.isFavorite,
      useCount: sticker.useCount,
    });
  }

  // 零有效向量：等价于“当前没有有效 Sticker embedding”，必须整体退回词面结果，
  // 而不是把缺省语义分的候选混进 hybrid 排序。只要有 1 条有效向量就继续走
  // hybrid rerank，partial-index 情况的行为保持不变。
  if (validEmbeddingCount === 0) return lexical.slice(0, limit);

  // 自己的识别失败项也参与词面排名，避免已标注池填满结果后将它们永久排除。
  const readyIds = new Set(pool.map(sticker => sticker.id));
  for (const [rank, sticker] of lexical.entries()) {
    if (readyIds.has(sticker.id)) continue;
    candidates.push({ stickerId: sticker.id, lexicalScore: lexicalScoreByRank(rank, lexical.length),
      isFavorite: sticker.isFavorite, useCount: sticker.useCount });
  }

  const ranked = rankStickerSearchCandidates(candidates, limit);
  if (ranked.length === 0) return lexical.slice(0, limit);

  // 自己尚未识别的收藏只通过词面召回，用于修正失败项，不参与语义池。
  const stickersById = new Map([...pool, ...lexical].map((sticker) => [sticker.id, sticker]));
  const results: Sticker[] = [];
  for (const { stickerId } of ranked) {
    const sticker = stickersById.get(stickerId);
    if (sticker) results.push(sticker);
  }
  // 兜底：极端情况下排名候选不足 limit 时用词面结果补齐。
  if (results.length < limit) {
    for (const sticker of lexical) {
      if (results.length >= limit) break;
      if (!results.some((item) => item.id === sticker.id)) results.push(sticker);
    }
  }
  return results;
}
