/** 回收与恢复共享助手原行，不复制业务数据；到期和恢复由写事务裁决。 */
import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import { resolveMediaAssetReferenceUri } from '@features/media';
import { ASSISTANT_RECYCLE_RETENTION_MS, type RecycledAssistant, type AssistantRecycleBinRepository, type AssistantRecycleLifecycleChange } from '../domain/AssistantRecycleBin';
import { createHostAIAppointmentCooldown } from '../domain/HostRepository';
import { upsertAppointmentCooldown } from './SQLiteHostRepository';

export class SQLiteAssistantRecycleBinRepository implements AssistantRecycleBinRepository {
  async list(): Promise<RecycledAssistant[]> {
    const rows = await databaseCoordinator.read({ name: 'assistants.recycle-bin.list', feature: 'assistants', priority: 'interactive' },
      db => db.getAllAsync<{ id: string; agent_id: string; name: string; nickname: string | null;
        avatar: string | null; avatar_media_asset_id: string | null; deleted_at: string }>(
        'SELECT id, agent_id, name, nickname, avatar, avatar_media_asset_id, deleted_at FROM ai_assistants WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id'));
    return Promise.all(rows.map(async row => ({ id: row.id, agentId: row.agent_id, name: row.name, nickname: row.nickname,
      avatar: await resolveMediaAssetReferenceUri({ mediaAssetId: row.avatar_media_asset_id, legacyUri: row.avatar }),
      avatarMediaAssetId: row.avatar_media_asset_id, deletedAt: row.deleted_at,
      expiresAt: new Date(Date.parse(row.deleted_at) + ASSISTANT_RECYCLE_RETENTION_MS).toISOString() })));
  }

  recycle<T>(id: string, suspend: (tx: DatabaseTransactionExecutor, change: AssistantRecycleLifecycleChange) => Promise<T>) {
    return databaseCoordinator.transaction({ name: 'assistants.recycle-bin.move', feature: 'assistants', priority: 'interactive' }, async tx => {
      const row = await tx.getFirstAsync<{ name: string; nickname: string | null; is_host_ai: number; is_ledger_ai: number }>(
        'SELECT name, nickname, is_host_ai, is_ledger_ai FROM ai_assistants WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!row) return null;
      const now = new Date().toISOString();
      if (row.is_host_ai === 1) {
        const cooldown = createHostAIAppointmentCooldown(new Date(now));
        await upsertAppointmentCooldown(tx, { revokedAIId: id, startAt: cooldown.startAt, endAt: cooldown.endAt });
        await tx.runAsync('UPDATE ai_assistants SET host_revoke_cooldown_start = ?, host_revoke_cooldown_end = ? WHERE id = ?',
          [cooldown.startAt, cooldown.endAt, id]);
      }
      await tx.runAsync('UPDATE ai_assistants SET deleted_at = ?, is_host_ai = 0, is_ledger_ai = 0, updated_at = ? WHERE id = ?', [now, now, id]);
      const afterCommit = await suspend(tx, { assistantId: id, assistantDisplayName: row.nickname ?? row.name, change: 'recycled', occurredAt: now, deletedAt: now,
        wasHost: row.is_host_ai === 1, wasLedger: row.is_ledger_ai === 1 });
      return { wasHost: row.is_host_ai === 1, afterCommit };
    });
  }

  async restore<T>(id: string, now: Date, record: (tx: DatabaseTransactionExecutor, change: AssistantRecycleLifecycleChange) => Promise<T>): Promise<{ afterCommit: T } | null> {
    return databaseCoordinator.transaction({ name: 'assistants.recycle-bin.restore', feature: 'assistants', priority: 'interactive' }, async tx => {
      const previous = await tx.getFirstAsync<{ name: string; nickname: string | null; deleted_at: string }>('SELECT name, nickname, deleted_at FROM ai_assistants WHERE id = ? AND deleted_at > ?',
        [id, new Date(now.getTime() - ASSISTANT_RECYCLE_RETENTION_MS).toISOString()]);
      if (!previous) return null;
      await tx.runAsync('UPDATE ai_assistants SET deleted_at = NULL, is_host_ai = 0, is_ledger_ai = 0, updated_at = ? WHERE id = ?', [now.toISOString(), id]);
      const afterCommit = await record(tx, { assistantId: id, assistantDisplayName: previous.nickname ?? previous.name, change: 'restored', occurredAt: now.toISOString(), deletedAt: previous.deleted_at });
      return { afterCommit };
    });
  }

  async getDeletion(id: string): Promise<{ deletedAt: string } | null> {
    return databaseCoordinator.read({ name: 'assistants.recycle-bin.get', feature: 'assistants', priority: 'interactive' },
      db => db.getFirstAsync<{ deletedAt: string }>('SELECT deleted_at AS deletedAt FROM ai_assistants WHERE id = ? AND deleted_at IS NOT NULL', [id]));
  }

  async listExpired(now: Date): Promise<{ id: string; deletedAt: string }[]> {
    return databaseCoordinator.read({ name: 'assistants.recycle-bin.expired', feature: 'assistants', priority: 'maintenance' },
      db => db.getAllAsync<{ id: string; deletedAt: string }>('SELECT id, deleted_at AS deletedAt FROM ai_assistants WHERE deleted_at <= ? ORDER BY deleted_at, id',
        [new Date(now.getTime() - ASSISTANT_RECYCLE_RETENTION_MS).toISOString()]));
  }

  async getNextExpiry(): Promise<number | null> {
    const row = await databaseCoordinator.read({ name: 'assistants.recycle-bin.next-expiry', feature: 'assistants', priority: 'maintenance' },
      db => db.getFirstAsync<{ deletedAt: string | null }>('SELECT MIN(deleted_at) AS deletedAt FROM ai_assistants'));
    return row!.deletedAt === null ? null : Date.parse(row!.deletedAt) + ASSISTANT_RECYCLE_RETENTION_MS;
  }
}

export const assistantRecycleBinRepository = new SQLiteAssistantRecycleBinRepository();
