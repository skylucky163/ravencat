/** 仅供 Host 组装 Sticker repository、MediaAsset、辅助模型与 embedding 端口。 */

import {
  getAuxiliaryModelConfigById,
  listAuxiliaryModelConfigs,
} from '@features/assistants';
import {
  createMediaAssetWithReference,
  releaseMediaAssetCandidates,
  resolveMediaAsset,
} from '@features/media';
import { createAIClient } from '@platform/ai';
import { createRandomUUID } from '@platform/device';
import { databaseCoordinator } from '@platform/persistence';
import { configureStickersRuntime } from './application/StickerRuntime';
import { SQLiteStickerRepository } from './infrastructure/SQLiteStickerRepository';
import { SQLiteAIStickerProcessingRepository } from './infrastructure/SQLiteAIStickerProcessingRepository';
import type { Sticker, StickerAnnotationMetadata } from './domain/Sticker';
import type { AgentToolExecutionContext } from '@shared/aiTools';
import type { DatabaseTransactionExecutor } from '@platform/persistence';

const stickerDatabase = databaseCoordinator.openTaskExecutor({
  name: 'stickers.repository',
  feature: 'stickers',
  priority: 'runtime',
});

/** Host 可复用的具体 repository；业务代码应从 @features/stickers 根出口取能力。 */
export const stickerRepository = new SQLiteStickerRepository(stickerDatabase);

let configured = false;

/**
 * 使用应用唯一 MediaAsset runtime 与辅助模型资产查询的 Sticker 组合；
 * Sticker 只引用模型配置 ID，Base URL / API Key / model name 始终即时读取，
 * 不在 Sticker 侧保存第二份。重复调用保持幂等。
 */
export function configureStickerRuntime(
  recognize: (sticker: Sticker, signal: AbortSignal) => Promise<StickerAnnotationMetadata>,
  assertCurrent: (transaction: DatabaseTransactionExecutor, context: AgentToolExecutionContext) => Promise<void>,
  withEmbeddingMaintenance: import('./application/StickerRuntime').StickerRuntimeDependencies['withEmbeddingMaintenance'],
): void {
  if (configured) return;
  configured = true;
  configureStickersRuntime({
    repository: stickerRepository,
    withEmbeddingMaintenance,
    aiProcessing: { repository: new SQLiteAIStickerProcessingRepository(stickerDatabase), executionId: createRandomUUID(), recognize, assertCurrent },
    media: {
      createMediaAssetWithReference,
      resolveMediaAsset,
      releaseMediaAssetCandidates,
    },
    auxiliaryModels: {
      getModelConfigById: async (id) => {
        const config = await getAuxiliaryModelConfigById({ id });
        return config ?? null;
      },
      listModelConfigsByRequirement: async (requirement) =>
        listAuxiliaryModelConfigs({ capabilityKind: requirement }),
    },
    embeddings: {
      // 按传入的模型引用即时创建 client；请求失败向上抛出，由调用方决定 fallback。
      embedTexts: async (texts, model, signal) => {
        const client = createAIClient({
          baseURL: model.baseUrl,
          apiKey: model.apiKey ?? '',
          model: model.model,
        });
        const response = await client.embed([...texts], { signal });
        if (!response.success) {
          throw new Error(response.error || '向量化模型请求失败');
        }
        return response.embeddings;
      },
    },
    generateId: () => `sticker-${createRandomUUID()}`,
    now: () => new Date().toISOString(),
  });
}

export {
  configureStickersRuntime,
  getStickersRuntimeDependencies,
} from './application/StickerRuntime';
export type {
  StickerAuxiliaryModelsGateway,
  StickerEmbeddingGateway,
  StickerMediaGateway,
  StickerRuntimeDependencies,
} from './application/StickerRuntime';
export { emitStickerAnnotationPending } from './application/StickerAnnotationPendingSignal';
export { emitStickerEmbeddingPending } from './application/StickerEmbeddingPendingSignal';
export { syncStickerEmbeddingModel } from './application/StickerSystemModels';
