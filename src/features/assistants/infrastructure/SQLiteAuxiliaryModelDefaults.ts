/** 默认资产与初次选择共享事务，初始化失败不能留下已经创建但没有生效的模型。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { getAuxiliaryModelInitialization } from '../application/AuxiliaryModelInitialization';
import { getAuxiliaryModelUnavailableReason } from '../AuxiliaryModelAvailability';
import type { AuxiliaryModelConfig } from '../domain/AuxiliaryModel';

export async function initializeAuxiliaryModelInTransaction(transaction: DatabaseTransactionExecutor, model: AuxiliaryModelConfig): Promise<boolean> {
  // 摘要与角色 TTS 只由用户显式选择，不参与首次资产初始化。
  if (model.capabilityKind === 'summary' || model.capabilityKind === 'tts') return false;
  await transaction.runAsync(`INSERT OR IGNORE INTO auxiliary_model_initial_defaults (capability_kind, model_config_id)
    VALUES (?, ?)`, [model.capabilityKind, model.id]);
  if (getAuxiliaryModelUnavailableReason(model, model.capabilityKind) !== null) return false;
  const claimed = await transaction.runAsync(`UPDATE auxiliary_model_initial_defaults SET initialized = 1
    WHERE capability_kind = ? AND model_config_id = ? AND initialized = 0`, [model.capabilityKind, model.id]);
  if (claimed.changes === 0) return false;
  await getAuxiliaryModelInitialization().initializeModelSelections(transaction, model);
  return true;
}
