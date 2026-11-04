/** Host 只组合各 owner 的事务写入；通知与派生任务必须留在 commit 后。 */
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { createRuntimeSlot } from '@shared/runtime/RuntimeSlot';
import type { AuxiliaryModelConfig } from '../domain/AuxiliaryModel';

export interface AuxiliaryModelInitialization {
  /** 资产参数或可用性变化与引用方的在途资格撤销共享提交边界，不改写引用ID。 */
  invalidateModelReferencesInTransaction(transaction: DatabaseTransactionExecutor, modelConfigId: string): Promise<void>;
  invalidateServiceReferencesInTransaction(transaction: DatabaseTransactionExecutor, serviceConfigId: string): Promise<void>;
  initializeModelSelections(transaction: DatabaseTransactionExecutor, model: AuxiliaryModelConfig): Promise<void>;
  initializeAssistantSelections(transaction: DatabaseTransactionExecutor, assistantId: string, models: AuxiliaryModelConfig[]): Promise<void>;
  modelSelectionsInitialized(model: AuxiliaryModelConfig): void;
}

const slot = createRuntimeSlot<AuxiliaryModelInitialization>('Auxiliary model initialization');
export function configureAuxiliaryModelInitialization(dependencies: AuxiliaryModelInitialization): void { slot.configure(dependencies); }
export function getAuxiliaryModelInitialization(): AuxiliaryModelInitialization { return slot.get(); }
