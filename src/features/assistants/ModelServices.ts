import { notifyAssistantServiceConnectionsChanged } from './AIAssistantManagement';
/** 服务管理的公开命令和查询，不向调用方暴露仓储。 */
import type { DatabaseReadExecutor, DatabaseTransactionExecutor } from '@platform/persistence';
import { emitAuxiliaryModelsChanged } from './AuxiliaryModelsChanged';
import type { CreateModelServiceGroupInput, ModelServiceConfig, ModelServiceConnection, ModelServiceGroup, ModelServiceKeyInput } from './domain/ModelService';
import * as repository from './infrastructure/SQLiteModelServiceRepository';
import { reportModelServiceFailure } from './ModelServiceErrors';
export type { CreateModelServiceGroupInput, ModelServiceConfig, ModelServiceConnection, ModelServiceGroup, ModelServiceKeyInput } from './domain/ModelService';
export { getModelServiceConnection } from './domain/ModelService';
export const getModelServiceConfig = repository.getModelService;
export const listModelServiceGroupConfigs = repository.listModelServiceGroups;
export const getModelServiceGroupConfig = repository.getModelServiceGroup;
export const getAutoSaveServiceConfigs = repository.getAutoSaveModelServices;
export async function setAutoSaveServiceConfigs(value: boolean): Promise<void> {
  await repository.setAutoSaveModelServices(value);
  emitAuxiliaryModelsChanged();
}
interface ServiceMutationResult { refreshWarning: string | null }
interface ServiceSaveResult extends ServiceMutationResult { config: ModelServiceConfig }
async function refreshServiceConsumers(ids: string[], detachedAssistantIds?: string[]): Promise<ServiceMutationResult> {
  let refreshed = emitAuxiliaryModelsChanged();
  for (const id of detachedAssistantIds ? [ids[0] ?? ''] : ids) {
    try { if (!await notifyAssistantServiceConnectionsChanged(id, detachedAssistantIds)) refreshed = false; }
    catch (error) { reportModelServiceFailure(detachedAssistantIds ? 'delete' : 'update', 'refresh', id, error); refreshed = false; }
  }
  return { refreshWarning: refreshed ? null : '配置已保存，部分页面未能刷新，请重新打开相关页面。' };
}
export async function deleteModelServiceKeyConfig(id: string): Promise<ServiceMutationResult> {
  let assistantIds: string[];
  try { assistantIds = await repository.deleteModelServiceKey(id); }
  catch (error) { throw reportModelServiceFailure('delete', 'write', id, error); }
  const result = await refreshServiceConsumers([id], assistantIds);
  return { refreshWarning: result.refreshWarning ? 'Key 已删除，部分页面未能刷新，请重新打开相关页面。' : null };
}
export async function createModelServiceGroupConfig(input: CreateModelServiceGroupInput): Promise<ServiceMutationResult & { group: ModelServiceGroup }> {
  let group: ModelServiceGroup;
  try { group = await repository.createModelServiceGroup(input); }
  catch (error) { throw reportModelServiceFailure('create', 'write', null, error); }
  return { group, ...await refreshServiceConsumers([]) };
}
export async function updateModelServiceGroupConfig(id: string, input: { name?: string; baseUrl?: string }): Promise<ServiceMutationResult & { group: ModelServiceGroup }> {
  let group: ModelServiceGroup;
  try { group = await repository.updateModelServiceGroup(id, input); }
  catch (error) { throw reportModelServiceFailure('update', 'write', id, error); }
  return { group, ...await refreshServiceConsumers(group.keys.map(key => key.id)) };
}
export async function saveModelServiceKeyConfig(groupId: string, id: string | null, input: Partial<ModelServiceKeyInput>): Promise<ServiceSaveResult> {
  let config: ModelServiceConfig;
  try { config = await repository.saveModelServiceKey(groupId, id, input); }
  catch (error) { throw reportModelServiceFailure(id ? 'update' : 'create', 'write', id, error); }
  return { config, ...await refreshServiceConsumers(id ? [id] : []) };
}
export async function deleteModelServiceGroupConfig(id: string): Promise<ServiceMutationResult> {
  let assistantIds: string[];
  try { assistantIds = await repository.deleteModelServiceGroup(id); }
  catch (error) { throw reportModelServiceFailure('delete', 'write', id, error); }
  const result = await refreshServiceConsumers([id], assistantIds);
  return { refreshWarning: result.refreshWarning ? '服务已删除，部分页面未能刷新，请重新打开相关页面。' : null };
}
/** owner 在自己的事务中收录连接；SQL 仍由服务 owner 执行。 */
export function bindModelServiceInTransaction(tx: DatabaseTransactionExecutor, connection: ModelServiceConnection, selectedServiceId?: string | null) {
  return repository.bindModelService(tx, connection, selectedServiceId);
}
export function readModelServiceConnection(db: DatabaseReadExecutor, id: string) { return repository.readModelService(db, id); }
