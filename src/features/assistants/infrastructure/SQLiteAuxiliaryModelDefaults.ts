/** 默认资产与初次选择共享事务，初始化失败不能留下已经创建但没有生效的模型。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { getAuxiliaryModelInitialization } from '../application/AuxiliaryModelInitialization';
import { getAuxiliaryModelUnavailableReason } from '../AuxiliaryModelAvailability';
import type { AuxiliaryModelConfig, CapabilityKind } from '../domain/AuxiliaryModel';

export async function initializeAuxiliaryModelInTransaction(transaction: DatabaseTransactionExecutor, model: AuxiliaryModelConfig): Promise<boolean> {
  // 摘要配置只由业务显式选择，不参与首次资产初始化。
  if (model.capabilityKind === 'summary') return false;
  await transaction.runAsync(`INSERT OR IGNORE INTO auxiliary_model_initial_defaults (capability_kind, model_config_id)
    VALUES (?, ?)`, [model.capabilityKind, model.id]);
  if (getAuxiliaryModelUnavailableReason(model, model.capabilityKind) !== null) return false;
  const claimed = await transaction.runAsync(`UPDATE auxiliary_model_initial_defaults SET initialized = 1
    WHERE capability_kind = ? AND model_config_id = ? AND initialized = 0`, [model.capabilityKind, model.id]);
  if (claimed.changes === 0) return false;
  await getAuxiliaryModelInitialization().initializeModelSelections(transaction, model);
  return true;
}

export async function initializeAssistantAuxiliaryModelsInTransaction(
  transaction: DatabaseTransactionExecutor, assistantId: string,
  readModel: (id: string) => Promise<AuxiliaryModelConfig | null>,
): Promise<void> {
  const defaults = await transaction.getAllAsync<{ capability_kind: CapabilityKind; model_config_id: string }>(`SELECT capability_kind, model_config_id
    FROM auxiliary_model_initial_defaults WHERE capability_kind IN ('ocr', 'tts')`);
  const models: AuxiliaryModelConfig[] = [];
  for (const row of defaults) {
    const model = await readModel(row.model_config_id);
    if (model && getAuxiliaryModelUnavailableReason(model, row.capability_kind) === null) models.push(model);
  }
  // 新角色即使目前没有可用模型也要经过同一个装配契约，不建立运行时继承。
  await getAuxiliaryModelInitialization().initializeAssistantSelections(transaction, assistantId, models);
}
