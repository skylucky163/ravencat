/** 分组拥有地址，连接 ID 拥有具体 Key；所有写入与引用资格变更共享事务。 */
import { databaseCoordinator, type DatabaseReadExecutor, type DatabaseTransactionExecutor } from '@platform/persistence';
import type { CreateModelServiceGroupInput, ModelServiceConfig, ModelServiceConnection, ModelServiceGroup, ModelServiceKeyInput } from '../domain/ModelService';
import { getAuxiliaryModelInitialization } from '../application/AuxiliaryModelInitialization';
import { ModelServiceOperationError } from '../ModelServiceErrors';

interface ServiceRow {
  id: string; group_id: string; group_name: string; key_name: string; ordinal: number;
  base_url: string; api_key: string; auth_type: ModelServiceConnection['authType'];
  credentials_json: string; created_at: string; updated_at: string; next_key_ordinal: number;
}
const projection = `SELECT k.id, g.id AS group_id, g.name AS group_name, k.name AS key_name, k.ordinal,
  g.base_url, k.api_key, g.auth_type, k.credentials_json, k.created_at, k.updated_at, g.next_key_ordinal
  FROM model_service_groups g LEFT JOIN model_service_configs k ON k.group_id = g.id`;
function map(row: ServiceRow): ModelServiceConfig {
  return { id: row.id, groupId: row.group_id, name: row.group_name, keyName: row.key_name || String(row.ordinal), ordinal: row.ordinal,
    baseUrl: row.base_url, apiKey: row.api_key, authType: row.auth_type, credentialsJson: row.credentials_json,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function executor() { return databaseCoordinator.openTaskExecutor({ name: 'assistants.modelServices', feature: 'assistants', priority: 'interactive' }); }
function newId(prefix: string) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }
export async function readModelService(db: DatabaseReadExecutor, id: string): Promise<ModelServiceConfig> {
  const row = await db.getFirstAsync<ServiceRow>(`${projection} WHERE k.id = ?`, [id]);
  if (!row) throw new Error('服务 Key 已删除，请重新选择');
  return map(row);
}
export async function getModelService(id: string): Promise<ModelServiceConfig> { return readModelService(executor(), id); }
function groupRows(rows: ServiceRow[]): ModelServiceGroup[] {
  const groups = new Map<string, ModelServiceGroup>();
  for (const row of rows) {
    if (!groups.has(row.group_id)) groups.set(row.group_id, { id: row.group_id, name: row.group_name,
      baseUrl: row.base_url, authType: row.auth_type, nextKeyOrdinal: row.next_key_ordinal, keys: [] });
    if (row.id) groups.get(row.group_id)!.keys.push(map(row));
  }
  return [...groups.values()];
}
async function readGroup(db: DatabaseReadExecutor, id: string): Promise<ModelServiceGroup> {
  const groups = groupRows(await db.getAllAsync<ServiceRow>(`${projection} WHERE g.id = ? ORDER BY k.ordinal`, [id]));
  if (!groups.length) throw new Error('服务配置已删除，请重新打开页面');
  return groups[0];
}
export async function listModelServiceGroups(): Promise<ModelServiceGroup[]> {
  return groupRows(await executor().getAllAsync<ServiceRow>(`${projection} ORDER BY g.updated_at DESC, g.id, k.ordinal`));
}
export async function getModelServiceGroup(id: string): Promise<ModelServiceGroup> { return readGroup(executor(), id); }
export async function getAutoSaveModelServices(): Promise<boolean> {
  return (await executor().getFirstAsync<{ auto_save: number }>('SELECT auto_save FROM model_service_settings WHERE id = 1'))!.auto_save === 1;
}
export async function setAutoSaveModelServices(value: boolean): Promise<void> {
  await executor().runAsync('UPDATE model_service_settings SET auto_save = ? WHERE id = 1', [value ? 1 : 0]);
}
async function findConnection(db: DatabaseReadExecutor, connection: ModelServiceConnection, exceptId: string | null = null) {
  return db.getFirstAsync<{ id: string }>(`SELECT k.id FROM model_service_configs k JOIN model_service_groups g ON g.id = k.group_id
    WHERE g.base_url = ? AND k.api_key = ? AND g.auth_type = ? AND k.credentials_json = ? AND (? IS NULL OR k.id <> ?)
    ORDER BY k.created_at, k.id LIMIT 1`, [connection.baseUrl, connection.apiKey, connection.authType, connection.credentialsJson, exceptId, exceptId]);
}
async function requireUnique(tx: DatabaseTransactionExecutor, connection: ModelServiceConnection, exceptId: string | null = null) {
  if (await findConnection(tx, connection, exceptId)) throw new ModelServiceOperationError('duplicate');
}
async function insertKey(tx: DatabaseTransactionExecutor, group: ModelServiceGroup, input: ModelServiceKeyInput, now: string): Promise<string> {
  await requireUnique(tx, { baseUrl: group.baseUrl, authType: group.authType, apiKey: input.apiKey, credentialsJson: input.credentialsJson });
  const id = newId('service');
  const ordinal = input.ordinal ?? group.nextKeyOrdinal;
  await tx.runAsync(`INSERT INTO model_service_configs(id,group_id,name,ordinal,api_key,credentials_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`, [id, group.id, input.name, ordinal, input.apiKey, input.credentialsJson, now, now]);
  await tx.runAsync('UPDATE model_service_groups SET next_key_ordinal = MAX(next_key_ordinal, ?), updated_at = ? WHERE id = ?', [ordinal + 1, now, group.id]);
  return id;
}
async function createGroup(tx: DatabaseTransactionExecutor, input: CreateModelServiceGroupInput, now: string): Promise<ModelServiceGroup> {
  const id = newId('service_group');
  await tx.runAsync(`INSERT INTO model_service_groups(id,name,base_url,auth_type,next_key_ordinal,created_at,updated_at)
    VALUES(?,?,?,?,1,?,?)`, [id, input.name, input.baseUrl, input.authType, now, now]);
  for (const key of input.keys) await insertKey(tx, await readGroup(tx, id), key, now);
  return readGroup(tx, id);
}
export async function bindModelService(tx: DatabaseTransactionExecutor, connection: ModelServiceConnection, selectedServiceId?: string | null): Promise<string | null> {
  if (selectedServiceId) { await readModelService(tx, selectedServiceId); return selectedServiceId; }
  if (!connection.baseUrl || !connection.apiKey) return null;
  let address: URL;
  try { address = new URL(connection.baseUrl); } catch { return null; }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(address.protocol)) return null;
  if (connection.authType === 'tencentCloud' && !JSON.parse(connection.credentialsJson).secretId) return null;
  const existing = await findConnection(tx, connection);
  if (existing) return existing.id;
  if ((await tx.getFirstAsync<{ auto_save: number }>('SELECT auto_save FROM model_service_settings WHERE id = 1'))!.auto_save === 0) return null;
  // 自动收录只复用完整连接，不仅凭地址把用户配置合并成一组。
  const group = await createGroup(tx, { name: address.hostname, baseUrl: connection.baseUrl, authType: connection.authType,
    keys: [{ name: '', apiKey: connection.apiKey, credentialsJson: connection.credentialsJson }] }, new Date().toISOString());
  return group.keys[0].id;
}
async function invalidateKey(tx: DatabaseTransactionExecutor, id: string, now: string): Promise<void> {
  const references = getAuxiliaryModelInitialization();
  const models = await tx.getAllAsync<{ id: string }>('SELECT id FROM auxiliary_model_configs WHERE service_config_id = ?', [id]);
  await tx.runAsync('UPDATE auxiliary_model_configs SET updated_at = ? WHERE service_config_id = ?', [now, id]);
  for (const model of models) await references.invalidateModelReferencesInTransaction(tx, model.id);
  await references.invalidateServiceReferencesInTransaction(tx, id);
}
async function updateGroup(tx: DatabaseTransactionExecutor, id: string, input: { name?: string; baseUrl?: string }, now: string) {
  const previous = await readGroup(tx, id);
  const next = { ...previous, ...input };
  if (next.baseUrl !== previous.baseUrl) {
    for (const key of previous.keys) await requireUnique(tx, { ...key, baseUrl: next.baseUrl }, key.id);
    for (const key of previous.keys) await invalidateKey(tx, key.id, now);
  }
  await tx.runAsync('UPDATE model_service_groups SET name = ?, base_url = ?, updated_at = ? WHERE id = ?', [next.name, next.baseUrl, now, id]);
}
async function updateKey(tx: DatabaseTransactionExecutor, id: string, input: Partial<ModelServiceKeyInput>, now: string) {
  const previous = await readModelService(tx, id);
  const next = { ...previous, ...input };
  const changed = previous.apiKey !== next.apiKey || previous.credentialsJson !== next.credentialsJson;
  if (changed) await requireUnique(tx, next, id);
  // 未改的名称留在数据库；keyName 是展示值，不能把默认编号回写成用户命名。
  const fields: string[] = [], values: string[] = [];
  for (const [field, column] of [['name', 'name'], ['apiKey', 'api_key'], ['credentialsJson', 'credentials_json']] as const) {
    if (input[field] !== undefined) { fields.push(`${column} = ?`); values.push(input[field]); }
  }
  if (fields.length) await tx.runAsync(`UPDATE model_service_configs SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`, [...values, now, id]);
  return changed;
}
export async function createModelServiceGroup(input: CreateModelServiceGroupInput): Promise<ModelServiceGroup> {
  return executor().withExclusiveTransactionAsync(tx => createGroup(tx, input, new Date().toISOString()));
}
export async function updateModelServiceGroup(id: string, input: { name?: string; baseUrl?: string }): Promise<ModelServiceGroup> {
  return executor().withExclusiveTransactionAsync(async tx => { await updateGroup(tx, id, input, new Date().toISOString()); return readGroup(tx, id); });
}
export async function saveModelServiceKey(groupId: string, id: string | null, input: Partial<ModelServiceKeyInput>): Promise<ModelServiceConfig> {
  return executor().withExclusiveTransactionAsync(async tx => {
    const now = new Date().toISOString();
    const group = await readGroup(tx, groupId);
    if (id) {
      if (!group.keys.some(key => key.id === id)) throw new Error('Key 不属于当前配置');
      if (await updateKey(tx, id, input, now)) await invalidateKey(tx, id, now);
    } else id = await insertKey(tx, group, input as ModelServiceKeyInput, now);
    return readModelService(tx, id);
  });
}
async function deleteKey(tx: DatabaseTransactionExecutor, id: string, now: string): Promise<string[]> {
  await invalidateKey(tx, id, now);
  const assistantIds = await getAuxiliaryModelInitialization().detachServiceReferencesInTransaction(tx, id, now);
  await tx.runAsync(`UPDATE auxiliary_model_configs SET service_config_id = NULL, base_url = '', api_key = NULL,
    updated_at = ? WHERE service_config_id = ?`, [now, id]);
  await tx.runAsync('DELETE FROM model_service_configs WHERE id = ?', [id]);
  return assistantIds;
}
export async function deleteModelServiceKey(id: string): Promise<string[]> {
  return executor().withExclusiveTransactionAsync(tx => deleteKey(tx, id, new Date().toISOString()));
}
export async function deleteModelServiceGroup(id: string): Promise<string[]> {
  return executor().withExclusiveTransactionAsync(async tx => {
    const group = await readGroup(tx, id), ids: string[] = [];
    const now = new Date().toISOString();
    for (const key of group.keys) ids.push(...await deleteKey(tx, key.id, now));
    await tx.runAsync('DELETE FROM model_service_groups WHERE id = ?', [id]);
    return ids;
  });
}
