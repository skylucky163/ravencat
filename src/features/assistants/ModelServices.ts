import { notifyAssistantServiceConnectionsChanged } from './AIAssistantManagement';
/** 服务管理的公开命令和查询，不向调用方暴露仓储。 */
import type { DatabaseReadExecutor, DatabaseTransactionExecutor } from '@platform/persistence';
import { emitAuxiliaryModelsChanged } from './AuxiliaryModelsChanged';
import type { ModelServiceConnection, SaveModelServiceInput } from './domain/ModelService';
import * as repository from './infrastructure/SQLiteModelServiceRepository';
export type { ModelServiceConfig, ModelServiceConnection, SaveModelServiceInput } from './domain/ModelService';
export { getModelServiceConnection } from './domain/ModelService';
export const listModelServiceConfigs = repository.listModelServices;
export const getModelServiceConfig = repository.getModelService;
export const getAutoSaveServiceConfigs = repository.getAutoSaveModelServices;
export async function setAutoSaveServiceConfigs(value: boolean): Promise<void> {
  await repository.setAutoSaveModelServices(value);
  emitAuxiliaryModelsChanged();
}
export function saveModelServiceConfig(id: null, input: SaveModelServiceInput): Promise<import('./domain/ModelService').ModelServiceConfig>;
export function saveModelServiceConfig(id: string, input: Partial<SaveModelServiceInput>): Promise<import('./domain/ModelService').ModelServiceConfig>;
export async function saveModelServiceConfig(id: string | null, input: Partial<SaveModelServiceInput>) {
  const result = await repository.saveModelService(id, input);
  emitAuxiliaryModelsChanged();
  if (id) await notifyAssistantServiceConnectionsChanged(id);
  return result;
}
export async function deleteModelServiceConfig(id: string): Promise<void> {
  await repository.deleteModelService(id);
  emitAuxiliaryModelsChanged();
}
/** owner 在自己的事务中收录连接；SQL 仍由服务 owner 执行。 */
export function bindModelServiceInTransaction(tx: DatabaseTransactionExecutor, connection: ModelServiceConnection, selectedServiceId?: string | null) {
  return repository.bindModelService(tx, connection, selectedServiceId);
}
export function readModelServiceConnection(db: DatabaseReadExecutor, id: string) { return repository.readModelService(db, id); }
