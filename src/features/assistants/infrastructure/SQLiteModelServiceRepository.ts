/** 服务连接只保存一份；自动收录与用途引用共享调用方的事务。 */
import { databaseCoordinator, type DatabaseReadExecutor, type DatabaseTransactionExecutor } from '@platform/persistence';
import type { ModelServiceConfig, ModelServiceConnection, SaveModelServiceInput } from '../domain/ModelService';
import { getAuxiliaryModelInitialization } from '../application/AuxiliaryModelInitialization';

interface ServiceRow {
  id: string; name: string; base_url: string; api_key: string; auth_type: ModelServiceConnection['authType'];
  credentials_json: string; created_at: string; updated_at: string;
}
function map(row: ServiceRow): ModelServiceConfig {
  return { id: row.id, name: row.name, baseUrl: row.base_url, apiKey: row.api_key, authType: row.auth_type,
    credentialsJson: row.credentials_json, createdAt: row.created_at, updatedAt: row.updated_at };
}
function executor() { return databaseCoordinator.openTaskExecutor({ name: 'assistants.modelServices', feature: 'assistants', priority: 'interactive' }); }
export async function readModelService(db: DatabaseReadExecutor, id: string): Promise<ModelServiceConfig> {
  const row = await db.getFirstAsync<ServiceRow>('SELECT * FROM model_service_configs WHERE id = ?', [id]);
  if (!row) throw new Error('服务配置已删除，请重新选择');
  return map(row);
}
export async function listModelServices(): Promise<ModelServiceConfig[]> {
  return (await executor().getAllAsync<ServiceRow>('SELECT * FROM model_service_configs ORDER BY updated_at DESC, id')).map(map);
}
export async function getModelService(id: string): Promise<ModelServiceConfig> { return readModelService(executor(), id); }
export async function getAutoSaveModelServices(): Promise<boolean> {
  return (await executor().getFirstAsync<{ auto_save: number }>('SELECT auto_save FROM model_service_settings WHERE id = 1'))!.auto_save === 1;
}
export async function setAutoSaveModelServices(value: boolean): Promise<void> {
  await executor().runAsync('UPDATE model_service_settings SET auto_save = ? WHERE id = 1', [value ? 1 : 0]);
}
function identity(connection: ModelServiceConnection) { return [connection.baseUrl, connection.apiKey, connection.authType, connection.credentialsJson]; }
export async function bindModelService(transaction: DatabaseTransactionExecutor, connection: ModelServiceConnection, selectedServiceId?: string | null): Promise<string | null> {
  if (selectedServiceId) { await readModelService(transaction, selectedServiceId); return selectedServiceId; }
  // 未填完整的连接仍由原配置保存，不因失焦产生无效服务。
  if (!connection.baseUrl || !connection.apiKey) return null;
  let address: URL;
  try { address = new URL(connection.baseUrl); } catch { return null; }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(address.protocol)) return null;
  if (connection.authType === 'tencentCloud' && !JSON.parse(connection.credentialsJson).secretId) return null;
  const existing = await transaction.getFirstAsync<{ id: string }>(`SELECT id FROM model_service_configs
    WHERE base_url = ? AND api_key = ? AND auth_type = ? AND credentials_json = ?`, identity(connection));
  if (existing) return existing.id;
  const settings = await transaction.getFirstAsync<{ auto_save: number }>('SELECT auto_save FROM model_service_settings WHERE id = 1');
  if (settings!.auto_save === 0) return null;
  const id = `service_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const name = address.hostname;
  await transaction.runAsync(`INSERT INTO model_service_configs
    (id, name, base_url, api_key, auth_type, credentials_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, name, ...identity(connection), now, now]);
  return id;
}
export async function saveModelService(id: string | null, input: Partial<SaveModelServiceInput>): Promise<ModelServiceConfig> {
  const key = id ?? `service_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  return executor().withExclusiveTransactionAsync(async tx => {
    const previous = id ? await readModelService(tx, id) : null;
    if (previous && input.authType !== undefined && input.authType !== previous.authType) {
      throw new Error('更换认证方式请新增服务配置');
    }
    const next = (previous ? { ...previous, ...input } : input) as SaveModelServiceInput;
    if (id) {
      const changed = identity(previous!).some((value, index) => value !== identity(next)[index]);
      await tx.runAsync(`UPDATE model_service_configs SET name = ?, base_url = ?, api_key = ?, auth_type = ?, credentials_json = ?, updated_at = ? WHERE id = ?`,
        [next.name, ...identity(next), now, id]);
      if (changed) {
        const models = await tx.getAllAsync<{ id: string }>('SELECT id FROM auxiliary_model_configs WHERE service_config_id = ?', [id]);
        await tx.runAsync('UPDATE auxiliary_model_configs SET updated_at = ? WHERE service_config_id = ?', [now, id]);
        for (const model of models) await getAuxiliaryModelInitialization().invalidateModelReferencesInTransaction(tx, model.id);
        await getAuxiliaryModelInitialization().invalidateServiceReferencesInTransaction(tx, id);
      }
    } else {
      await tx.runAsync(`INSERT INTO model_service_configs
        (id, name, base_url, api_key, auth_type, credentials_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [key, next.name, ...identity(next), now, now]);
    }
    return readModelService(tx, key);
  });
}
export async function deleteModelService(id: string): Promise<void> {
  // 外键保护所有 owner 的引用；在用服务不能被删除成失效连接。
  await executor().runAsync('DELETE FROM model_service_configs WHERE id = ?', [id]);
}
