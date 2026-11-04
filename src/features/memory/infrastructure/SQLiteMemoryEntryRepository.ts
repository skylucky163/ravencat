/** 正文与派生任务在同一事务标记，所有运行时访问经单写者协调器。 */
import { CoordinatedDatabaseError, databaseCoordinator, type DatabaseReadExecutor, type DatabaseTransactionExecutor } from '@platform/persistence';
import { MEMORY_EMBEDDING_MAX_ATTEMPTS, MemoryInputError, MemoryNotFoundError, MemoryTriggerNotFoundError, MemoryVectorDimensionError, normalizeMemoryText, type MemoryEntry, type MemoryRecallSettings, type MemoryTriggerKeyword, type PassiveTriggerGroup } from '../domain/Memory';
import type { CreateMemoryRecord, MemoryEmbeddingClaim, MemoryEmbeddingModel, MemoryEmbeddingRebuild, MemoryRepository } from '../domain/MemoryRepository';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

interface EntryRow {
  id: string; pool_id: string; content: string; summary: string | null; content_revision: number;
  remembered_at: string; created_at: string; updated_at: string;
  status: MemoryEntry['embeddingStatus']; model_name: string | null;
  last_error: string | null; failed_at: string | null;
}

const ENTRY_COLUMNS = 'm.*, e.status, e.model_name, e.last_error, e.failed_at';
const ENTRY_QUERY = `SELECT ${ENTRY_COLUMNS}
  FROM memory_items m JOIN memory_item_embeddings e ON e.memory_id = m.id`;

/** 三个 consumer 共用关系定义，显式关联不依赖记忆文本。 */
const TRIGGER_LEXICAL_ASSOCIATION = `(t.auto_associate = 1 AND EXISTS (
  SELECT 1 FROM memory_trigger_keywords k WHERE k.group_id = t.id
  AND (INSTR(m.normalized_content, k.normalized_keyword) > 0 OR INSTR(m.normalized_summary, k.normalized_keyword) > 0)))`;
const TRIGGER_ASSOCIATION = `(${TRIGGER_LEXICAL_ASSOCIATION}
  OR EXISTS (SELECT 1 FROM memory_passive_associations a WHERE a.trigger_id = t.id AND a.memory_id = m.id))`;

function mapEntry(row: EntryRow): MemoryEntry {
  return {
    id: row.id, poolId: row.pool_id, content: row.content, summary: row.summary, contentRevision: row.content_revision,
    rememberedAt: row.remembered_at, createdAt: row.created_at, updatedAt: row.updated_at,
    embeddingStatus: row.status, embeddingModelName: row.model_name,
    embeddingError: row.last_error, embeddingFailedAt: row.failed_at,
  };
}

function executor(name: string) {
  return databaseCoordinator.openTaskExecutor({ name: `memory.${name}`, feature: 'memory', priority: 'maintenance' });
}
async function memoryTransaction<T>(name: string, operation: (tx: DatabaseTransactionExecutor) => Promise<T>): Promise<T> {
  try {
    return await executor(name).withExclusiveTransactionAsync(operation);
  } catch (error) {
    // 只恢复 Memory 自己的业务拒绝，SQL 故障继续携带协调器诊断。
    if (error instanceof CoordinatedDatabaseError
      && (error.cause instanceof MemoryInputError || error.cause instanceof MemoryNotFoundError || error.cause instanceof MemoryTriggerNotFoundError)) throw error.cause;
    throw error;
  }
}

async function readEntry(db: DatabaseReadExecutor, poolId: string, memoryId: string): Promise<MemoryEntry> {
  const row = await db.getFirstAsync<EntryRow>(`${ENTRY_QUERY} WHERE m.pool_id = ? AND m.id = ?`, [poolId, memoryId]);
  if (!row) throw new MemoryNotFoundError();
  return mapEntry(row);
}

async function requireTriggerGroup(db: DatabaseReadExecutor, poolId: string, groupId: string): Promise<void> {
  const group = await db.getFirstAsync('SELECT id FROM memory_trigger_groups WHERE pool_id = ? AND id = ?', [poolId, groupId]);
  if (!group) throw new MemoryTriggerNotFoundError();
}

async function writeTriggerKeywords(tx: DatabaseTransactionExecutor, groupId: string, keywords: MemoryTriggerKeyword[]): Promise<void> {
  for (const [position, item] of keywords.entries()) {
    await tx.runAsync('INSERT INTO memory_trigger_keywords (group_id, keyword, normalized_keyword, position) VALUES (?, ?, ?, ?)',
      [groupId, item.keyword, item.normalizedKeyword, position]);
  }
}

async function markContentPending(tx: DatabaseTransactionExecutor, memoryId: string): Promise<void> {
  await tx.runAsync(`INSERT INTO memory_item_embeddings (memory_id, content_revision, model_fingerprint, model_name, status)
    SELECT m.id, m.content_revision, s.model_fingerprint, s.model_name,
      CASE WHEN s.model_fingerprint IS NULL THEN 'not_requested' ELSE 'pending' END
    FROM memory_items m CROSS JOIN memory_v3_state s WHERE m.id = ? AND s.id = 1
    ON CONFLICT(memory_id) DO UPDATE SET content_revision = excluded.content_revision,
      model_fingerprint = excluded.model_fingerprint, model_name = excluded.model_name,
      status = excluded.status, attempts = 0, retry_at = NULL, claim_id = NULL,
      claim_expires_at = NULL, last_error = NULL, failed_at = NULL`, [memoryId]);
}

async function readValidVectors(db: DatabaseReadExecutor, poolId: string, fingerprint: string, dimension: number) {
    const state = await db.getFirstAsync<{ dimension: number | null }>(
      'SELECT dimension FROM memory_v3_state WHERE id = 1 AND model_fingerprint = ?', [fingerprint]);
    if (state?.dimension !== null && state?.dimension !== undefined && state.dimension !== dimension) throw new MemoryVectorDimensionError();
    const rows = await db.getAllAsync<{ memory_id: string; vector_json: string }>(
      `SELECT e.memory_id, e.vector_json FROM memory_item_embeddings e JOIN memory_items m ON m.id = e.memory_id
       WHERE m.pool_id = ? AND e.vector_model_fingerprint = ?
       AND e.vector_content_revision = m.content_revision AND e.dimension = ?
       AND EXISTS (SELECT 1 FROM memory_v3_state WHERE id = 1 AND model_fingerprint = ?)`,
    [poolId, fingerprint, dimension, fingerprint]);
    return rows.map((row) => {
      const vector: unknown = JSON.parse(row.vector_json);
      if (!Array.isArray(vector) || vector.length !== dimension || !vector.every((value) => typeof value === 'number' && Number.isFinite(value)) || !vector.some((value) => value !== 0)) {
        throw new Error('持久化记忆向量不符合维度／有限数值契约');
      }
      return { memoryId: row.memory_id, vector: vector as number[] };
    });
}

export class SQLiteMemoryEntryRepository implements MemoryRepository {
  async getEmbeddingSettings() {
    const row = await executor('model-settings.read').getFirstAsync<{ embedding_model_config_id: string | null; embedding_enabled: number }>(
      'SELECT embedding_model_config_id, embedding_enabled FROM memory_model_settings WHERE id = 1');
    return { enabled: row!.embedding_enabled === 1, modelConfigId: row!.embedding_model_config_id };
  }
  async setEmbeddingModelId(modelConfigId: string | null): Promise<void> {
    await memoryTransaction('model-settings.write', async tx => {
      const changed = await tx.runAsync('UPDATE memory_model_settings SET embedding_model_config_id = ? WHERE id = 1 AND embedding_model_config_id IS NOT ?', [modelConfigId, modelConfigId]);
      if (changed.changes) await tx.runAsync('UPDATE memory_embedding_index_control SET revision = revision + 1, build_id = NULL WHERE id = 1');
    });
  }

  async setEmbeddingEnabled(enabled: boolean): Promise<void> {
    await memoryTransaction('model-settings.enabled', async tx => {
      const value = enabled ? 1 : 0;
      const changed = await tx.runAsync('UPDATE memory_model_settings SET embedding_enabled = ? WHERE id = 1 AND embedding_enabled <> ?', [value, value]);
      if (changed.changes) await tx.runAsync('UPDATE memory_embedding_index_control SET revision = revision + 1, build_id = NULL WHERE id = 1');
    });
  }

  /** 模型资产提交时就撤销旧发布资格，不依赖某个 JS runtime 收到变更通知。 */
  async invalidateEmbeddingModelInTransaction(tx: DatabaseTransactionExecutor, modelConfigId: string): Promise<void> {
    await tx.runAsync(`UPDATE memory_embedding_index_control SET revision = revision + 1, build_id = NULL
      WHERE id = 1 AND EXISTS (SELECT 1 FROM memory_model_settings WHERE id = 1 AND embedding_model_config_id = ?)`, [modelConfigId]);
  }

  /** 清除只删除派生数据并撤销 claim，不改变开关、模型选择、正文和触发关系。 */
  async clearEmbeddings(model: MemoryEmbeddingModel | null): Promise<void> {
    await memoryTransaction('clearEmbeddings', async (tx) => {
      await tx.runAsync('UPDATE memory_embedding_index_control SET revision = revision + 1, build_id = NULL WHERE id = 1');
      await tx.runAsync(`UPDATE memory_item_embeddings SET vector_json = NULL, dimension = NULL,
        vector_model_fingerprint = NULL, vector_content_revision = NULL,
        model_fingerprint = ?, model_name = ?, status = 'not_requested', attempts = 0,
        retry_at = NULL, claim_id = NULL, claim_expires_at = NULL, last_error = NULL, failed_at = NULL`, [model?.fingerprint ?? null, model?.name ?? null]);
      await tx.runAsync('UPDATE memory_v3_state SET model_fingerprint = ?, model_name = ?, dimension = NULL WHERE id = 1', [model?.fingerprint ?? null, model?.name ?? null]);
    });
  }

  async listEntries(poolId: string) {
    const rows = await executor('listEntries').getAllAsync<EntryRow>(`${ENTRY_QUERY}
      WHERE m.pool_id = ? ORDER BY m.remembered_at DESC, m.id`, [poolId]);
    return rows.map(mapEntry);
  }

  async listEntryCounts(): Promise<ReadonlyMap<string, number>> {
    const rows = await executor('listEntryCounts').getAllAsync<{ pool_id: string; count: number }>(
      'SELECT pool_id, COUNT(*) AS count FROM memory_items GROUP BY pool_id');
    return new Map(rows.map(row => [row.pool_id, row.count]));
  }

  async getEntry(poolId: string, memoryId: string) {
    const row = await executor('getEntry').getFirstAsync<EntryRow>(`${ENTRY_QUERY} WHERE m.pool_id = ? AND m.id = ?`, [poolId, memoryId]);
    return row ? mapEntry(row) : null;
  }

  async createEntry(input: CreateMemoryRecord) {
    return memoryTransaction('createEntry', (tx) => this.createEntryInTransaction(tx, input));
  }

  /** 已删除的写入回执仍有效，重复转换不能悄悄恢复用户删除的记忆。 */
  async getEntryByWriteKey(poolId: string, writeKey: string): Promise<MemoryEntry | null> {
    const db = executor('getEntryByWriteKey');
    const receipt = await db.getFirstAsync<{ memory_id: string | null }>(
      'SELECT memory_id FROM memory_write_receipts WHERE pool_id = ? AND write_key = ?', [poolId, writeKey]);
    if (!receipt) return null;
    if (receipt.memory_id === null) throw new MemoryNotFoundError();
    return readEntry(db, poolId, receipt.memory_id);
  }

  /** Host 跨 Feature 转存复用同一写入逻辑，由外层事务裁决来源状态。 */
  async createEntryInTransaction(tx: DatabaseTransactionExecutor, input: CreateMemoryRecord): Promise<MemoryEntry> {
    if (input.writeKey !== null) {
      const receipt = await tx.getFirstAsync<{ memory_id: string | null }>(
        'SELECT memory_id FROM memory_write_receipts WHERE pool_id = ? AND write_key = ?', [input.poolId, input.writeKey]);
      if (receipt) {
        if (receipt.memory_id === null) throw new MemoryNotFoundError();
        return readEntry(tx, input.poolId, receipt.memory_id);
      }
    }
    await tx.runAsync(`INSERT INTO memory_items
      (id, pool_id, content, summary, normalized_content, normalized_summary, content_revision, write_key, remembered_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [input.id, input.poolId, input.content, input.summary, input.normalizedContent, normalizeMemoryText(input.summary ?? ''), input.writeKey, input.now, input.now, input.now]);
    await markContentPending(tx, input.id);
    if (input.writeKey !== null) {
      await tx.runAsync('INSERT INTO memory_write_receipts (pool_id, write_key, memory_id) VALUES (?, ?, ?)',
        [input.poolId, input.writeKey, input.id]);
    }
    return readEntry(tx, input.poolId, input.id);
  }

  async updateEntry(poolId: string, memoryId: string, content: string, normalizedContent: string, now: string, summary?: string | null) {
    return memoryTransaction('updateEntry', async (tx) => {
      const summarySet = summary === undefined ? '' : 'summary = ?, normalized_summary = ?,';
      const summaryParams = summary === undefined ? [] : [summary, normalizeMemoryText(summary ?? '')];
      const result = await tx.runAsync(`UPDATE memory_items SET content = ?, normalized_content = ?, ${summarySet}
        content_revision = content_revision + 1, updated_at = ? WHERE pool_id = ? AND id = ?`,
      [content, normalizedContent, ...summaryParams, now, poolId, memoryId]);
      if (result.changes === 0) throw new MemoryNotFoundError();
      await markContentPending(tx, memoryId);
      return readEntry(tx, poolId, memoryId);
    });
  }

  async deleteEntry(poolId: string, memoryId: string) {
    const result = await executor('deleteEntry').runAsync('DELETE FROM memory_items WHERE pool_id = ? AND id = ?', [poolId, memoryId]);
    return result.changes > 0;
  }

  async getPreferredAssistantId() {
    const state = await executor('getPreference').getFirstAsync<{ preferred_assistant_id: string | null }>(
      'SELECT preferred_assistant_id FROM memory_v3_state WHERE id = 1');
    return state!.preferred_assistant_id;
  }

  async setPreferredAssistantId(assistantId: string) {
    await executor('setPreference').runAsync('UPDATE memory_v3_state SET preferred_assistant_id = ? WHERE id = 1', [assistantId]);
  }

  async getRecallSettings(poolId: string) {
    return memoryTransaction('getSettings', async (tx) => {
      await tx.runAsync('INSERT OR IGNORE INTO memory_recall_settings (pool_id) VALUES (?)', [poolId]);
      const row = await tx.getFirstAsync<{ passive_limit: number; active_page_size: number }>(
        'SELECT passive_limit, active_page_size FROM memory_recall_settings WHERE pool_id = ?', [poolId]);
      return { passiveLimit: row!.passive_limit, activePageSize: row!.active_page_size };
    });
  }

  async setRecallSettings(poolId: string, settings: MemoryRecallSettings) {
    await executor('setSettings').runAsync(`INSERT INTO memory_recall_settings (pool_id, passive_limit, active_page_size)
      VALUES (?, ?, ?) ON CONFLICT(pool_id) DO UPDATE SET passive_limit = excluded.passive_limit,
      active_page_size = excluded.active_page_size`, [poolId, settings.passiveLimit, settings.activePageSize]);
  }

  async listTriggers(poolId: string): Promise<PassiveTriggerGroup[]> {
    return memoryTransaction('listTriggers', async (tx) => {
      const rows = await tx.getAllAsync<{
        id: string; auto_associate: number; associated_count: number; enabled_count: number;
      }>(`SELECT t.id, t.auto_associate, COUNT(m.id) AS associated_count,
        COUNT(m.id) - COUNT(d.memory_id) AS enabled_count FROM memory_trigger_groups t
        LEFT JOIN memory_items m ON m.pool_id = t.pool_id AND ${TRIGGER_ASSOCIATION}
        LEFT JOIN memory_passive_disabled d ON d.trigger_id = t.id AND d.memory_id = m.id
        WHERE t.pool_id = ? GROUP BY t.id ORDER BY t.rowid`, [poolId]);
      const words = await tx.getAllAsync<{ group_id: string; keyword: string; normalized_keyword: string }>(
        `SELECT k.* FROM memory_trigger_keywords k JOIN memory_trigger_groups t ON t.id = k.group_id
         WHERE t.pool_id = ? ORDER BY k.position`, [poolId]);
      const keywords = new Map<string, MemoryTriggerKeyword[]>(rows.map((row) => [row.id, []]));
      for (const word of words) keywords.get(word.group_id)!.push({ keyword: word.keyword, normalizedKeyword: word.normalized_keyword });
      return rows.map((row) => ({ id: row.id, poolId, keywords: keywords.get(row.id)!, autoAssociate: row.auto_associate === 1,
        associatedCount: row.associated_count, enabledCount: row.enabled_count }));
    });
  }

  async createTriggerGroup(poolId: string, groupId: string, keywords: MemoryTriggerKeyword[], memoryIds: string[], autoAssociate: boolean) {
    await memoryTransaction('createTriggerGroup', async (tx) => {
      await tx.runAsync('INSERT INTO memory_trigger_groups (id, pool_id, auto_associate) VALUES (?, ?, ?)', [groupId, poolId, autoAssociate ? 1 : 0]);
      await writeTriggerKeywords(tx, groupId, keywords);
      for (const memoryId of memoryIds) {
        await readEntry(tx, poolId, memoryId);
        await tx.runAsync('INSERT INTO memory_passive_associations (trigger_id, memory_id) VALUES (?, ?)', [groupId, memoryId]);
      }
    });
  }

  async updateTriggerGroup(poolId: string, groupId: string, keywords: MemoryTriggerKeyword[], autoAssociate: boolean) {
    await memoryTransaction('updateTriggerGroup', async (tx) => {
      await requireTriggerGroup(tx, poolId, groupId);
      await tx.runAsync('UPDATE memory_trigger_groups SET auto_associate = ? WHERE id = ?', [autoAssociate ? 1 : 0, groupId]);
      await tx.runAsync('DELETE FROM memory_trigger_keywords WHERE group_id = ?', [groupId]);
      await writeTriggerKeywords(tx, groupId, keywords);
    });
  }

  async deleteTrigger(poolId: string, triggerId: string) {
    await executor('deleteTrigger').runAsync('DELETE FROM memory_trigger_groups WHERE pool_id = ? AND id = ?', [poolId, triggerId]);
  }

  async listTriggerMemories(poolId: string, triggerId: string) {
    const rows = await executor('listTriggerMemories').getAllAsync<EntryRow & { disabled_id: string | null }>(`SELECT ${ENTRY_COLUMNS}, d.memory_id AS disabled_id
      FROM memory_items m JOIN memory_item_embeddings e ON e.memory_id = m.id
      JOIN memory_trigger_groups t ON t.pool_id = m.pool_id AND t.id = ?
      LEFT JOIN memory_passive_disabled d ON d.trigger_id = t.id AND d.memory_id = m.id
      WHERE m.pool_id = ? AND ${TRIGGER_ASSOCIATION}
      ORDER BY m.remembered_at DESC, m.id`, [triggerId, poolId]);
    return rows.map((row) => ({ memory: mapEntry(row), autoRecall: row.disabled_id === null }));
  }

  async setAutoRecall(poolId: string, triggerId: string, memoryId: string, enabled: boolean) {
    await memoryTransaction('setAutoRecall', async (tx) => {
      await requireTriggerGroup(tx, poolId, triggerId);
      await readEntry(tx, poolId, memoryId);
      if (enabled) {
        // 自动文本关系只恢复开关，显式选择的额外记忆才物化；组规则不依赖命中的具体词。
        await tx.runAsync(`INSERT OR IGNORE INTO memory_passive_associations (trigger_id, memory_id)
          SELECT t.id, m.id FROM memory_trigger_groups t CROSS JOIN memory_items m
          WHERE t.id = ? AND m.id = ?
            AND NOT ${TRIGGER_LEXICAL_ASSOCIATION}`,
        [triggerId, memoryId]);
        await tx.runAsync('DELETE FROM memory_passive_disabled WHERE trigger_id = ? AND memory_id = ?', [triggerId, memoryId]);
      } else {
        await tx.runAsync('INSERT OR IGNORE INTO memory_passive_disabled (trigger_id, memory_id) VALUES (?, ?)', [triggerId, memoryId]);
      }
    });
  }

  async recallPassive(poolId: string, normalizedInput: string) {
    const settings = await this.getRecallSettings(poolId);
    const rows = await executor('recallPassive').getAllAsync<EntryRow>(`${ENTRY_QUERY} WHERE m.pool_id = ?
      AND EXISTS (SELECT 1 FROM memory_trigger_groups t WHERE t.pool_id = m.pool_id
        AND EXISTS (SELECT 1 FROM memory_trigger_keywords k WHERE k.group_id = t.id AND INSTR(?, k.normalized_keyword) > 0)
        AND ${TRIGGER_ASSOCIATION}
        AND NOT EXISTS (SELECT 1 FROM memory_passive_disabled d WHERE d.trigger_id = t.id AND d.memory_id = m.id))
      ORDER BY m.remembered_at DESC, m.id LIMIT ?`, [poolId, normalizedInput, settings.passiveLimit]);
    return rows.map(mapEntry);
  }

  async getEmbeddingIndexRevision(): Promise<number> {
    const row = await executor('index-revision').getFirstAsync<{ revision: number }>('SELECT revision FROM memory_embedding_index_control WHERE id = 1');
    return row!.revision;
  }

  async syncEmbeddingModel(model: MemoryEmbeddingModel | null, expectedRevision: number) {
    return memoryTransaction('syncEmbeddingModel', async (tx) => {
      const control = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM memory_embedding_index_control WHERE id = 1');
      if (control!.revision !== expectedRevision) return null;
      const fingerprint = model?.fingerprint ?? null;
      const state = await tx.getFirstAsync<{ model_fingerprint: string | null }>('SELECT model_fingerprint FROM memory_v3_state WHERE id = 1');
      // 新建与编辑始终使用当前全局指纹，无变化时不为每条空闲任务重复扫描全部记忆。
      if (state!.model_fingerprint === fingerprint) return expectedRevision;
      // 取消的是任务；保存向量的来源版本独立保留，切回匹配模型即可直接接管。
      await tx.runAsync(`UPDATE memory_item_embeddings SET model_fingerprint = ?, model_name = ?,
        content_revision = (SELECT content_revision FROM memory_items WHERE id = memory_id),
        status = CASE WHEN vector_json IS NOT NULL AND vector_model_fingerprint = ?
          AND vector_content_revision = (SELECT content_revision FROM memory_items WHERE id = memory_id)
          THEN 'ready' ELSE 'not_requested' END,
        attempts = 0, retry_at = NULL, claim_id = NULL, claim_expires_at = NULL, last_error = NULL, failed_at = NULL
        `, [fingerprint, model?.name ?? null, fingerprint]);
      await tx.runAsync('UPDATE memory_embedding_index_control SET revision = revision + 1, build_id = NULL WHERE id = 1');
      await tx.runAsync(`UPDATE memory_v3_state SET dimension = (SELECT e.dimension FROM memory_item_embeddings e
        JOIN memory_items m ON m.id = e.memory_id WHERE e.vector_model_fingerprint = ?
        AND e.vector_content_revision = m.content_revision AND e.vector_json IS NOT NULL LIMIT 1),
        model_fingerprint = ?, model_name = ? WHERE id = 1`, [fingerprint, fingerprint, model?.name ?? null]);
      return expectedRevision + 1;
    });
  }

  async countEmbeddingIndex(fingerprint: string | null) {
    const row = await executor('index-status').getFirstAsync<{ total: number; valid: number }>(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN e.vector_json IS NOT NULL AND e.vector_model_fingerprint = ?
        AND e.vector_content_revision = m.content_revision THEN 1 ELSE 0 END), 0) AS valid
      FROM memory_items m JOIN memory_item_embeddings e ON e.memory_id = m.id`, [fingerprint]);
    return row!;
  }

  async beginEmbeddingRebuild(id: string, model: MemoryEmbeddingModel, expectedRevision: number): Promise<MemoryEmbeddingRebuild> {
    return memoryTransaction('beginEmbeddingRebuild', async tx => {
      const before = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM memory_embedding_index_control WHERE id = 1');
      if (before!.revision !== expectedRevision) throw new Error('模型配置已变化，请重新发起重建');
      const state = await tx.getFirstAsync<{ model_fingerprint: string | null }>('SELECT model_fingerprint FROM memory_v3_state WHERE id = 1');
      if (state!.model_fingerprint !== model.fingerprint) throw new Error('向量模型已变化，请重新发起重建');
      await tx.runAsync('UPDATE memory_embedding_index_control SET revision = revision + 1, build_id = ? WHERE id = 1', [id]);
      await tx.runAsync('UPDATE memory_item_embeddings SET claim_id = NULL, claim_expires_at = NULL');
      const control = await tx.getFirstAsync<{ revision: number }>('SELECT revision FROM memory_embedding_index_control WHERE id = 1');
      const rows = await tx.getAllAsync<{ id: string; content: string; summary: string | null; content_revision: number }>('SELECT id, content, summary, content_revision FROM memory_items ORDER BY id');
      return { id, revision: control!.revision, model, entries: rows.map(row => ({ id: row.id, content: row.content, summary: row.summary, contentRevision: row.content_revision })) };
    });
  }

  async publishEmbeddingRebuild(build: MemoryEmbeddingRebuild, vectors: number[][], signal: AbortSignal): Promise<void> {
    await memoryTransaction('publishEmbeddingRebuild', async tx => {
      throwIfAbortSignalAborted(signal);
      const control = await tx.getFirstAsync<{ revision: number; build_id: string | null }>('SELECT revision, build_id FROM memory_embedding_index_control WHERE id = 1');
      const state = await tx.getFirstAsync<{ model_fingerprint: string | null }>('SELECT model_fingerprint FROM memory_v3_state WHERE id = 1');
      if (control!.build_id !== build.id || control!.revision !== build.revision || state!.model_fingerprint !== build.model.fingerprint) throw new Error('向量模型或重建任务已变化，本次结果未覆盖旧索引');
      const rows = await tx.getAllAsync<{ id: string; content_revision: number }>('SELECT id, content_revision FROM memory_items ORDER BY id');
      if (rows.length !== build.entries.length || rows.some((row, index) => row.id !== build.entries[index].id || row.content_revision !== build.entries[index].contentRevision)) throw new Error('重建期间记忆发生变化，本次结果未覆盖旧索引，请重新重建');
      for (let index = 0; index < build.entries.length; index++) {
        const vector = vectors[index];
        await tx.runAsync(`UPDATE memory_item_embeddings SET vector_json = ?, dimension = ?, model_fingerprint = ?, model_name = ?,
          vector_model_fingerprint = ?, vector_content_revision = ?,
          content_revision = ?, status = 'ready', attempts = 1, retry_at = NULL, claim_id = NULL,
          claim_expires_at = NULL, last_error = NULL, failed_at = NULL WHERE memory_id = ?`,
        [JSON.stringify(vector), vector.length, build.model.fingerprint, build.model.name, build.model.fingerprint,
          build.entries[index].contentRevision, build.entries[index].contentRevision, build.entries[index].id]);
      }
      await tx.runAsync('UPDATE memory_v3_state SET dimension = ? WHERE id = 1', [vectors.length ? vectors[0].length : null]);
      await tx.runAsync('UPDATE memory_embedding_index_control SET build_id = NULL WHERE id = 1');
      throwIfAbortSignalAborted(signal);
    });
  }

  async finishEmbeddingRebuild(id: string): Promise<void> {
    await executor('finishEmbeddingRebuild').runAsync('UPDATE memory_embedding_index_control SET build_id = NULL WHERE id = 1 AND build_id = ?', [id]);
  }

  async readRecallCandidates(poolId: string, fingerprint: string | null, dimension: number | null) {
    return memoryTransaction('recallCandidates', async (tx) => {
      const rows = await tx.getAllAsync<EntryRow>(`${ENTRY_QUERY} WHERE m.pool_id = ?`, [poolId]);
      const vectors = fingerprint !== null && dimension !== null ? await readValidVectors(tx, poolId, fingerprint, dimension) : [];
      return { entries: rows.map(mapEntry), vectors };
    });
  }

  async claimEmbedding(fingerprint: string, claimId: string, now: string, expiresAt: string, expectedRevision: number) {
    return memoryTransaction('claimEmbedding', async (tx) => {
      const control = await tx.getFirstAsync<{ revision: number; build_id: string | null }>('SELECT revision, build_id FROM memory_embedding_index_control WHERE id = 1');
      if (control!.build_id !== null || control!.revision !== expectedRevision) return null;
      const row = await tx.getFirstAsync<{ memory_id: string; content: string; summary: string | null; content_revision: number; attempts: number }>(
        `SELECT e.memory_id, m.content, m.summary, m.content_revision, e.attempts FROM memory_item_embeddings e
         JOIN memory_items m ON m.id = e.memory_id WHERE e.model_fingerprint = ?
         AND e.status IN ('pending', 'stale', 'retry_wait') AND e.attempts < ?
         AND (e.retry_at IS NULL OR e.retry_at <= ?) AND (e.claim_id IS NULL OR e.claim_expires_at <= ?)
         AND EXISTS (SELECT 1 FROM memory_v3_state WHERE id = 1 AND model_fingerprint = ?)
         ORDER BY m.created_at, m.id LIMIT 1`, [fingerprint, MEMORY_EMBEDDING_MAX_ATTEMPTS, now, now, fingerprint]);
      if (!row) return null;
      await tx.runAsync('UPDATE memory_item_embeddings SET claim_id = ?, claim_expires_at = ? WHERE memory_id = ?',
        [claimId, expiresAt, row.memory_id]);
      return { memoryId: row.memory_id, content: row.content, summary: row.summary, contentRevision: row.content_revision,
        modelFingerprint: fingerprint, claimId, attempts: row.attempts, indexRevision: control!.revision };
    });
  }

  async completeEmbedding(claim: MemoryEmbeddingClaim, vector: number[]) {
    return memoryTransaction('completeEmbedding', async (tx) => {
    const state = await tx.getFirstAsync<{ dimension: number | null }>(
      `SELECT s.dimension FROM memory_v3_state s JOIN memory_embedding_index_control c ON c.id = s.id
       WHERE s.id = 1 AND s.model_fingerprint = ? AND c.revision = ? AND c.build_id IS NULL`, [claim.modelFingerprint, claim.indexRevision]);
    if (!state) return 'discarded';
    if (state.dimension !== null && state.dimension !== vector.length) return 'dimension_mismatch';
    const result = await tx.runAsync(`UPDATE memory_item_embeddings SET vector_json = ?,
      vector_model_fingerprint = model_fingerprint, vector_content_revision = content_revision,
      dimension = ?, status = 'ready', attempts = attempts + 1, claim_id = NULL, claim_expires_at = NULL,
      retry_at = NULL, last_error = NULL, failed_at = NULL WHERE memory_id = ? AND claim_id = ?
      AND content_revision = ? AND model_fingerprint = ?
      AND EXISTS (SELECT 1 FROM memory_items WHERE id = ? AND content_revision = ?)
      AND EXISTS (SELECT 1 FROM memory_v3_state WHERE id = 1 AND model_fingerprint = ?)`,
    [JSON.stringify(vector), vector.length, claim.memoryId, claim.claimId, claim.contentRevision, claim.modelFingerprint,
      claim.memoryId, claim.contentRevision, claim.modelFingerprint]);
    if (!result.changes) return 'discarded';
    await tx.runAsync('UPDATE memory_v3_state SET dimension = ? WHERE id = 1', [vector.length]);
    return 'accepted';
    });
  }

  async failEmbedding(claim: MemoryEmbeddingClaim, error: string, terminal: boolean, now: string, retryAt: string) {
    const failed = terminal || claim.attempts + 1 >= MEMORY_EMBEDDING_MAX_ATTEMPTS;
    const result = await executor('failEmbedding').runAsync(`UPDATE memory_item_embeddings SET status = ?, attempts = attempts + 1,
      retry_at = ?, last_error = ?, failed_at = ?, claim_id = NULL, claim_expires_at = NULL
      WHERE memory_id = ? AND claim_id = ? AND content_revision = ? AND model_fingerprint = ?
      AND EXISTS (SELECT 1 FROM memory_v3_state WHERE id = 1 AND model_fingerprint = ?)`,
    [failed ? 'failed' : 'retry_wait', failed ? null : retryAt, error, failed ? now : null,
      claim.memoryId, claim.claimId, claim.contentRevision, claim.modelFingerprint, claim.modelFingerprint]);
    return result.changes > 0;
  }

  async releaseEmbedding(claim: MemoryEmbeddingClaim) {
    await executor('releaseEmbedding').runAsync('UPDATE memory_item_embeddings SET claim_id = NULL, claim_expires_at = NULL WHERE memory_id = ? AND claim_id = ?',
      [claim.memoryId, claim.claimId]);
  }

  async retryEmbedding(poolId: string, memoryId: string, expectedRevision: number) {
    await memoryTransaction('retryEmbedding', async (tx) => {
      await readEntry(tx, poolId, memoryId);
      const control = await tx.getFirstAsync<{ revision: number; build_id: string | null }>('SELECT revision, build_id FROM memory_embedding_index_control WHERE id = 1');
      if (control!.revision !== expectedRevision) throw new MemoryInputError('向量模型已变化，请重新请求这条记忆的向量化');
      // Host 已取消并等待活动重建；这里同时撤销进程中断遗留的整批发布资格。
      if (control!.build_id !== null) await tx.runAsync('UPDATE memory_embedding_index_control SET revision = revision + 1, build_id = NULL WHERE id = 1');
      await markContentPending(tx, memoryId);
    });
  }

  async getNextEmbeddingWakeAt(fingerprint: string) {
    const row = await executor('nextWake').getFirstAsync<{ wake_at: string | null }>(`SELECT MIN(
      CASE WHEN claim_id IS NOT NULL THEN claim_expires_at ELSE retry_at END) AS wake_at
      FROM memory_item_embeddings WHERE model_fingerprint = ? AND status IN ('pending','stale','retry_wait') AND attempts < ?
      AND EXISTS (SELECT 1 FROM memory_embedding_index_control WHERE id = 1 AND build_id IS NULL)`, [fingerprint, MEMORY_EMBEDDING_MAX_ATTEMPTS]);
    return row!.wake_at;
  }
}

export const memoryEntryRepository = new SQLiteMemoryEntryRepository();
