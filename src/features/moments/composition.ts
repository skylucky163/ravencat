/** 仅供 Host 装配时刻工具快照、媒体 repository、事务、MediaAsset 与辅助模型端口。 */
import {
  getAuxiliaryModelConfigById,
  listAuxiliaryModelConfigs,
} from '@features/assistants';
import { prepareMediaAssetBatch } from '@features/media';
import { databaseCoordinator } from '@platform/persistence';
import {
  configureMomentMediaRuntime,
  type MomentImageAnalysisExecutor,
} from './application/MomentMediaRuntime';
import { momentRepository } from './infrastructure/SQLiteMomentRepository';

let configured = false;

export function configureMomentsMediaRuntime(
  executeImageAnalysis: MomentImageAnalysisExecutor
): void {
  if (configured) return;
  configured = true;
  configureMomentMediaRuntime({
    repository: momentRepository,
    database: databaseCoordinator.openTaskExecutor({
      name: 'moments.media.publish',
      feature: 'moments',
      priority: 'runtime',
    }),
    prepareMedia: prepareMediaAssetBatch,
    auxiliaryModels: {
      getById: async (id) => (await getAuxiliaryModelConfigById({ id })) ?? null,
      listOcr: () => listAuxiliaryModelConfigs({ capabilityKind: 'ocr' }),
    },
    executeImageAnalysis,
    now: () => new Date().toISOString(),
  });
}

export type { MomentImageAnalysisExecutor } from './application/MomentMediaRuntime';
export { momentRepository } from './infrastructure/SQLiteMomentRepository';
export { purgeAssistantMomentsInTransaction } from './infrastructure/AssistantMomentLifecycle';
export { createMomentToolForRun } from './aiTools/AICreateMomentTool';
