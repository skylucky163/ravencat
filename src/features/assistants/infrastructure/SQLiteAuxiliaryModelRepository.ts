import { bindModelService, readModelService } from './SQLiteModelServiceRepository';
import { getModelServiceConnection, supportsModelService, withServiceCredentials, withoutServiceCredentials } from '../domain/ModelService';
/** 辅助模型资产仓储的 SQLite 实现。 */
import type {
  AuxiliaryModelConfig,
  CapabilityKind,
  CreateAuxiliaryModelConfigInput,
  UpdateAuxiliaryModelConfigInput,
} from '../domain/AuxiliaryModel';
import type { IAuxiliaryModelRepository } from '../domain/AuxiliaryModelRepository';
import { databaseCoordinator, type DatabaseTransactionExecutor, type DatabaseReadExecutor } from '@platform/persistence';
import { initializeAuxiliaryModelInTransaction } from './SQLiteAuxiliaryModelDefaults';
import { getAuxiliaryModelInitialization } from '../application/AuxiliaryModelInitialization';

interface AuxiliaryModelConfigRow {
  id: string;
  service_config_id: string | null;
  capability_kind: CapabilityKind;
  name: string;
  base_url: string;
  api_key: string | null;
  model: string;
  temperature: number | null;
  top_p: number | null;
  max_tokens: number | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

function buildRepositoryId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class AuxiliaryModelRepository implements IAuxiliaryModelRepository {
  async listModelConfigs(params: { capabilityKind?: CapabilityKind } = {}): Promise<AuxiliaryModelConfig[]> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.listModelConfigs', feature: 'assistants', priority: 'runtime' });
    // 历史退休资产不作为当前可运行能力进入模型中心。
    const whereParts: string[] = ["capability_kind IN ('summary', 'embedding', 'ocr', 'stt', 'tts', 'translation')"];
    const values: string[] = [];

    if (params.capabilityKind) {
      whereParts.push('capability_kind = ?');
      values.push(params.capabilityKind);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const rows = await db.getAllAsync<AuxiliaryModelConfigRow>(
      `SELECT * FROM auxiliary_model_configs ${whereClause} ORDER BY updated_at DESC`,
      values
    );
    return Promise.all(rows.map((row) => this.mapModelConfigRow(row, db)));
  }

  async getModelConfigById(id: string): Promise<AuxiliaryModelConfig | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.getModelConfigById', feature: 'assistants', priority: 'runtime' });
    const row = await db.getFirstAsync<AuxiliaryModelConfigRow>(
      `SELECT * FROM auxiliary_model_configs WHERE id = ? LIMIT 1`,
      [id]
    );
    return row ? this.mapModelConfigRow(row, db) : null;
  }

  async insertModelConfig(input: CreateAuxiliaryModelConfigInput): Promise<AuxiliaryModelConfig> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.insertModelConfig', feature: 'assistants', priority: 'runtime' });
    const now = input.createdAt ?? new Date().toISOString();
    const id = buildRepositoryId('auxcfg');

    const { inserted, initialized } = await db.withExclusiveTransactionAsync(async (transaction) => {
      const serviceConfigId = supportsModelService(input.capabilityKind, input.metadataJson)
        ? await bindModelService(transaction, getModelServiceConnection(input.baseUrl, input.apiKey ?? null), input.serviceConfigId)
        : null;
      await transaction.runAsync(
        `INSERT INTO auxiliary_model_configs (
           id, capability_kind, name, base_url, api_key, model, temperature, top_p, max_tokens,
           metadata_json, created_at, updated_at, service_config_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.capabilityKind,
          input.name,
          serviceConfigId ? '' : input.baseUrl,
          serviceConfigId ? null : input.apiKey ?? null,
          input.model,
          input.temperature ?? null,
          input.topP ?? null,
          input.maxTokens ?? null,
          serviceConfigId ? withoutServiceCredentials(input.metadataJson ?? null) : input.metadataJson ?? null,
          now,
          now,
          serviceConfigId,
        ]
      );

      const inserted = await this.getModelConfigByIdInTransaction(transaction, id);
      if (!inserted) {
        throw new Error('创建后的辅助模型配置不存在');
      }

      const initialized = await initializeAuxiliaryModelInTransaction(transaction, inserted);
      return { inserted, initialized };
    });
    if (initialized) getAuxiliaryModelInitialization().modelSelectionsInitialized(inserted);
    return inserted;
  }

  async getModelConfigByIdInTransaction(transaction: DatabaseTransactionExecutor, id: string): Promise<AuxiliaryModelConfig | null> {
    const row = await transaction.getFirstAsync<AuxiliaryModelConfigRow>('SELECT * FROM auxiliary_model_configs WHERE id = ?', [id]);
    return row ? this.mapModelConfigRow(row, transaction) : null;
  }

  async updateModelConfig(id: string, input: UpdateAuxiliaryModelConfigInput): Promise<AuxiliaryModelConfig> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.updateModelConfig', feature: 'assistants', priority: 'runtime' });
    const { updated, initialized } = await db.withExclusiveTransactionAsync(async transaction => {
      const columns = { name: 'name', capabilityKind: 'capability_kind', model: 'model', temperature: 'temperature', topP: 'top_p', maxTokens: 'max_tokens' } as const;
      const fields: string[] = [], values: (string | number | null)[] = [];
      for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
        if (input[key] !== undefined) { fields.push(`${columns[key]} = ?`); values.push(input[key]); }
      }
      if (input.baseUrl !== undefined || input.apiKey !== undefined || input.metadataJson !== undefined || input.capabilityKind !== undefined || input.serviceConfigId !== undefined) {
        const current = await this.getModelConfigByIdInTransaction(transaction, id);
        if (!current) throw new Error(`辅助模型配置不存在：${id}`);
        const next = { ...current, ...input };
        const serviceConfigId = supportsModelService(next.capabilityKind, next.metadataJson)
          ? await bindModelService(transaction, getModelServiceConnection(next.baseUrl, next.apiKey), input.serviceConfigId)
          : null;
        // 连接组完整写入；用途只保存服务引用，手动连接才保留本地值。
        fields.push('service_config_id = ?', 'base_url = ?', 'api_key = ?', 'metadata_json = ?');
        values.push(serviceConfigId, serviceConfigId ? '' : next.baseUrl, serviceConfigId ? null : next.apiKey,
          serviceConfigId ? withoutServiceCredentials(next.metadataJson) : next.metadataJson);
      }
      fields.push('updated_at = ?'); values.push(new Date().toISOString(), id);
      await transaction.runAsync(`UPDATE auxiliary_model_configs SET ${fields.join(', ')} WHERE id = ?`, values);
      const updated = await this.getModelConfigByIdInTransaction(transaction, id);
      if (!updated) throw new Error(`辅助模型配置不存在：${id}`);
      const initialized = await initializeAuxiliaryModelInTransaction(transaction, updated);
      if (Object.keys(input).some(key => key !== 'name')) await getAuxiliaryModelInitialization().invalidateModelReferencesInTransaction(transaction, id);
      return { updated, initialized };
    });
    if (initialized) getAuxiliaryModelInitialization().modelSelectionsInitialized(updated);
    return updated;
  }

  async deleteModelConfig(id: string): Promise<boolean> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'assistants.deleteModelConfig', feature: 'assistants', priority: 'runtime' });
    return db.withExclusiveTransactionAsync(async (transaction) => {
      const result = await transaction.runAsync(`DELETE FROM auxiliary_model_configs WHERE id = ?`, [id]);
      if (result.changes > 0) await getAuxiliaryModelInitialization().invalidateModelReferencesInTransaction(transaction, id);
      return result.changes > 0;
    });
  }

  private async mapModelConfigRow(row: AuxiliaryModelConfigRow, db: DatabaseReadExecutor): Promise<AuxiliaryModelConfig> {
    const service = row.service_config_id ? await readModelService(db, row.service_config_id) : null;
    return {
      serviceConfigId: row.service_config_id,
      id: row.id,
      capabilityKind: row.capability_kind,
      name: row.name,
      baseUrl: service ? service.baseUrl : row.base_url,
      apiKey: service ? service.apiKey : row.api_key,
      model: row.model,
      temperature: row.temperature,
      topP: row.top_p,
      maxTokens: row.max_tokens,
      metadataJson: service ? withServiceCredentials(row.metadata_json, service) : row.metadata_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

}

export const auxiliaryModelRepository = new AuxiliaryModelRepository();
