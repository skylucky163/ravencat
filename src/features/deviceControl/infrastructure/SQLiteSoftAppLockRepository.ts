/** 使用共享 SQLite 连接实现 Device Control Soft App Lock 业务真值仓储。 */

import { databaseCoordinator } from '@platform/persistence';
import type { SoftAppLock, SoftAppLockRow } from '../domain/SoftAppLock';
import { createSoftAppLockFromRow } from '../domain/SoftAppLock';
import type {
  ISoftAppLockRepository,
  InsertAiSoftAppLockResult,
  ReleaseActiveAiSoftAppLockResult,
} from '../domain/SoftAppLockRepository';

const SOFT_APP_LOCK_COLUMNS = `
  id,
  target_package,
  source,
  source_ai_id,
  reason,
  created_at,
  expires_at,
  status
`;

const SOFT_APP_LOCK_TABLE = 'raven_cat_soft_app_locks';

const INSERT_SOFT_APP_LOCK_SQL = `
  INSERT INTO ${SOFT_APP_LOCK_TABLE} (
    id,
    target_package,
    source,
    source_ai_id,
    reason,
    created_at,
    expires_at,
    status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

function toInsertParams(lock: SoftAppLock) {
  return [
    lock.id,
    lock.targetPackage,
    lock.source,
    lock.sourceAiId ?? null,
    lock.reason ?? null,
    lock.createdAtEpochMs,
    lock.expiresAtEpochMs ?? null,
    lock.status,
  ];
}

function openSoftAppLockExecutor(name: string) {
  return databaseCoordinator.openTaskExecutor({
    name,
    feature: 'deviceControl',
    priority: 'runtime',
  });
}

function requireLock(row: SoftAppLockRow | null): SoftAppLock {
  const lock = createSoftAppLockFromRow(row);
  if (!lock) {
    throw new Error('SoftAppLock 行在事务内消失');
  }
  return lock;
}

export class SQLiteSoftAppLockRepository implements ISoftAppLockRepository {
  async listActive(nowEpochMs: number): Promise<SoftAppLock[]> {
    const db = openSoftAppLockExecutor('deviceControl.softAppLock.listActive');
    const rows = await db.getAllAsync<SoftAppLockRow>(
      `SELECT ${SOFT_APP_LOCK_COLUMNS}
       FROM ${SOFT_APP_LOCK_TABLE}
       WHERE status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at ASC, id ASC`,
      [nowEpochMs]
    );
    return rows.map((row) => requireLock(row));
  }

  async insertAiLockIfNoActiveByActorAndTarget(
    lock: SoftAppLock,
    nowEpochMs: number
  ): Promise<InsertAiSoftAppLockResult> {
    const db = openSoftAppLockExecutor(
      'deviceControl.softAppLock.insertAiLockIfNoActiveByActorAndTarget'
    );
    return db.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<SoftAppLockRow>(
        `SELECT ${SOFT_APP_LOCK_COLUMNS}
         FROM ${SOFT_APP_LOCK_TABLE}
         WHERE source = 'ai_tool'
           AND source_ai_id = ?
           AND target_package = ?
           AND status = 'active'
           AND expires_at > ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [lock.sourceAiId, lock.targetPackage, nowEpochMs]
      );
      if (row) {
        return { outcome: 'already_active' as const, lock: requireLock(row) };
      }

      await tx.runAsync(INSERT_SOFT_APP_LOCK_SQL, toInsertParams(lock));
      return { outcome: 'inserted' as const, lock };
    });
  }

  async releaseActiveAiLockByActorAndTarget(
    sourceAiId: string,
    targetPackage: string
  ): Promise<ReleaseActiveAiSoftAppLockResult> {
    const db = openSoftAppLockExecutor(
      'deviceControl.softAppLock.releaseActiveAiLockByActorAndTarget'
    );
    return db.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<SoftAppLockRow>(
        `SELECT ${SOFT_APP_LOCK_COLUMNS}
         FROM ${SOFT_APP_LOCK_TABLE}
         WHERE source = 'ai_tool'
           AND source_ai_id = ?
           AND target_package = ?
           AND status = 'active'
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [sourceAiId, targetPackage]
      );
      if (!row) {
        return { outcome: 'not_found' as const };
      }

      await tx.runAsync(
        `UPDATE ${SOFT_APP_LOCK_TABLE}
         SET status = 'released'
         WHERE id = ? AND status = 'active'`,
        [row.id]
      );
      return {
        outcome: 'released' as const,
        lock: requireLock({ ...row, status: 'released' }),
      };
    });
  }

  async expireDue(nowEpochMs: number): Promise<SoftAppLock[]> {
    const db = openSoftAppLockExecutor('deviceControl.softAppLock.expireDue');
    return db.withExclusiveTransactionAsync(async (tx) => {
      const rows = await tx.getAllAsync<SoftAppLockRow>(
        `SELECT ${SOFT_APP_LOCK_COLUMNS}
         FROM ${SOFT_APP_LOCK_TABLE}
         WHERE status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at <= ?
         ORDER BY expires_at ASC, id ASC`,
        [nowEpochMs]
      );
      if (rows.length === 0) {
        return [];
      }
      await tx.runAsync(
        `UPDATE ${SOFT_APP_LOCK_TABLE}
         SET status = 'expired'
         WHERE status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at <= ?`,
        [nowEpochMs]
      );
      return rows.map((row) => requireLock({ ...row, status: 'expired' }));
    });
  }

}

export const softAppLockRepository = new SQLiteSoftAppLockRepository();
