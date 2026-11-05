/** 仅供 Host 组装助手具体仓储与 M3b 维护能力；普通调用方使用 ./index。 */

import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { aiAssistantRepository } from './infrastructure/SQLiteAssistantRepository';
import type {
  AIAvatarMediaAssetMigrationCandidate,
  CommitAIAvatarMediaAssetReferenceInput,
} from './domain/AssistantRepository';

export { aiAssistantRepository } from './infrastructure/SQLiteAssistantRepository';

/** Host-only M3b maintenance：列出 AI owner 的 legacy 头像候选。 */
export function listAIAvatarMediaAssetMigrationCandidates(): Promise<
  AIAvatarMediaAssetMigrationCandidate[]
> {
  return aiAssistantRepository.listAvatarMediaAssetMigrationCandidates();
}

/** Host-only M3b maintenance：与 MediaAsset 行在同一事务内提交 owner 引用。 */
export function commitAIAvatarMediaAssetReferenceInTransaction(
  transaction: DatabaseTransactionExecutor,
  input: CommitAIAvatarMediaAssetReferenceInput,
): Promise<void> {
  return aiAssistantRepository.commitAvatarMediaAssetReferenceInTransaction(transaction, input);
}

export type {
  AIAvatarMediaAssetMigrationCandidate,
  CommitAIAvatarMediaAssetReferenceInput,
} from './domain/AssistantRepository';

export { configureAssistantVoiceModels, getAssistantVoiceModelId, notifyAssistantVoiceModelsChanged } from './application/AssistantVoiceModels';
export { assistantVoiceSettingsRepository } from './infrastructure/SQLiteAssistantVoiceSettingsRepository';
export { configureAuxiliaryModelInitialization } from './application/AuxiliaryModelInitialization';
