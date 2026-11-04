// 协议空间拥有固定注入信息；全部条目持续生效，直到用户或 AI 修改、删除。
import { randomUUID } from 'expo-crypto';
import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import type {
  IProtocolRepository,
  Protocol,
  ProtocolInsertResult,
  CreateProtocolInput,
  UpdateProtocolInput,
} from '../domain/ProtocolRepository';

export const PROTOCOL_MAX_LENGTH = 500;

interface ProtocolRow {
  id: string;
  ai_assistant_id: string;
  content: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ProtocolRow): Protocol {
  return {
    id: row.id,
    aiAssistantId: row.ai_assistant_id,
    content: row.content,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeContent(content: string): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) throw new Error('协议内容不能为空');
  if (trimmedContent.length > PROTOCOL_MAX_LENGTH) {
    throw new Error(`协议内容不能超过${PROTOCOL_MAX_LENGTH}字`);
  }
  return trimmedContent;
}

export class SQLiteProtocolRepository implements IProtocolRepository {
  /** 转存的读取与删除共用 Host 传入的事务，不能在内部重新排队。 */
  async getForTransfer(tx: DatabaseTransactionExecutor, aiAssistantId: string, id: string): Promise<Protocol | null> {
    const row = await tx.getFirstAsync<ProtocolRow>('SELECT * FROM protocols WHERE ai_assistant_id = ? AND id = ?', [aiAssistantId, id]);
    return row ? mapRow(row) : null;
  }

  async deleteInTransaction(tx: DatabaseTransactionExecutor, id: string): Promise<void> {
    await tx.runAsync('DELETE FROM protocols WHERE id = ?', [id]);
  }

  async getByAI(aiAssistantId: string): Promise<Protocol[]> {
    const database = databaseCoordinator.openTaskExecutor({ name: 'protocol.getByAI', feature: 'protocol', priority: 'runtime' });
    const rows = await database.getAllAsync<ProtocolRow>(
      'SELECT * FROM protocols WHERE ai_assistant_id = ? ORDER BY created_at, id',
      [aiAssistantId],
    );
    return rows.map(mapRow);
  }

  async getPromptText(aiAssistantId: string): Promise<string> {
    const protocols = await this.getByAI(aiAssistantId);
    return protocols.map((protocol) => `- ${protocol.content}`).join('\n');
  }

  async search(aiAssistantId: string, keyword: string): Promise<Protocol[]> {
    const database = databaseCoordinator.openTaskExecutor({ name: 'protocol.search', feature: 'protocol', priority: 'runtime' });
    const pattern = `%${keyword}%`;
    const rows = await database.getAllAsync<ProtocolRow>(
      `SELECT * FROM protocols WHERE ai_assistant_id = ?
       AND (content LIKE ? OR summary LIKE ?) ORDER BY created_at, id`,
      [aiAssistantId, pattern, pattern],
    );
    return rows.map(mapRow);
  }

  async insert({ aiAssistantId, content, summary }: CreateProtocolInput): Promise<ProtocolInsertResult> {
    const trimmedContent = normalizeContent(content);
    const database = databaseCoordinator.openTaskExecutor({ name: 'protocol.insert', feature: 'protocol', priority: 'runtime' });
    // 去重与写入由同一事务拥有，界面与 AI 工具同时保存也不能制造重复条目。
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const existing = await transaction.getFirstAsync<ProtocolRow>(
        'SELECT * FROM protocols WHERE ai_assistant_id = ? AND content = ? ORDER BY created_at, id LIMIT 1',
        [aiAssistantId, trimmedContent],
      );
      if (existing) return { ...mapRow(existing), alreadyExists: true };

      const now = new Date().toISOString();
      const id = `protocol_${randomUUID()}`;
      await transaction.runAsync(
        `INSERT INTO protocols (id, ai_assistant_id, content, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, aiAssistantId, trimmedContent, summary ?? null, now, now],
      );
      return { id, aiAssistantId, content: trimmedContent, summary: summary ?? null,
        createdAt: now, updatedAt: now, alreadyExists: false };
    });
  }

  async update(aiAssistantId: string, id: string, updates: UpdateProtocolInput): Promise<Protocol | null> {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (updates.content !== undefined) {
      sets.push('content = ?');
      params.push(normalizeContent(updates.content));
    }
    if (updates.summary !== undefined) {
      sets.push('summary = ?');
      params.push(updates.summary);
    }
    if (sets.length === 0) throw new Error('没有要更新的内容');

    const now = new Date().toISOString();
    sets.push('updated_at = ?');
    params.push(now, aiAssistantId, id);
    const database = databaseCoordinator.openTaskExecutor({ name: 'protocol.update', feature: 'protocol', priority: 'runtime' });
    // 命中结果与更新后的快照共用事务，调用方无需在 commit 后再次读取确认。
    return database.withExclusiveTransactionAsync(async (transaction) => {
      const result = await transaction.runAsync(
        `UPDATE protocols SET ${sets.join(', ')} WHERE ai_assistant_id = ? AND id = ?`, params,
      );
      if (result.changes === 0) return null;
      const row = await transaction.getFirstAsync<ProtocolRow>(
        'SELECT * FROM protocols WHERE ai_assistant_id = ? AND id = ?', [aiAssistantId, id],
      );
      return mapRow(row!);
    });
  }

  async delete(aiAssistantId: string, id: string): Promise<boolean> {
    const database = databaseCoordinator.openTaskExecutor({ name: 'protocol.delete', feature: 'protocol', priority: 'runtime' });
    const result = await database.runAsync('DELETE FROM protocols WHERE ai_assistant_id = ? AND id = ?', [aiAssistantId, id]);
    return result.changes > 0;
  }
}

export const protocolRepository = new SQLiteProtocolRepository();
