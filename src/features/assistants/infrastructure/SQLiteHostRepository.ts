/** AI 主理与拉黑状态仓储的 SQLite 实现。 */
import { databaseCoordinator, type CoordinatedDatabaseExecutor, type DatabaseReadExecutor, type DatabaseTransactionExecutor } from '@platform/persistence';
import {
  createHostAIAppointmentCooldown,
  HOST_AI_RELATIONSHIP_STATE_ID,
  HostRelationshipError,
  type IAIHostRepository,
  type HostAppointmentAvailability,
  type HostCooldownStatus,
  type BlockAIParams,
  type BlockedAIRecord,
} from '../domain/HostRepository';

/**
 * AIHostRepository
 * 
 * 主理AI任命/撤销、冷静期、拉黑等操作的 SQLite 实现
 */
export class AIHostRepository implements IAIHostRepository {
  // ==================== 主理AI管理 ====================

  async getCurrentHostAIId(): Promise<string | null> {
    const database = databaseCoordinator.openTaskExecutor({
      name: 'assistants.getCurrentHostAIId',
      feature: 'assistants',
      priority: 'runtime',
    });
    return this.readCurrentHostAIId(database);
  }

  private async readCurrentHostAIId(database: DatabaseReadExecutor): Promise<string | null> {
    const row = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM ai_assistants WHERE is_host_ai = 1 LIMIT 1'
    );
    return row?.id ?? null;
  }

  /**
   * 设置主理AI
   */
  async setHostAI(aiId: string): Promise<boolean> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.setHostAI', feature: 'assistants', priority: 'runtime' });
    await database.withExclusiveTransactionAsync((tx) => this.setHostAIInTransaction(tx, aiId));
    return true;
  }

  /** 返回是否发生新任命，供提交后只对真实身份变化派发通知。 */
  async setHostAIInTransaction(tx: DatabaseTransactionExecutor, aiId: string): Promise<boolean> {
    const incumbentId = await this.readCurrentHostAIId(tx);
    if (incumbentId === aiId) return false;
    if (incumbentId) {
      throw new HostRelationshipError('host_already_assigned', '必须先撤销当前主理 AI 才能重新任命');
    }
    if ((await this.readHostCooldown(tx)).isInCooldown) {
      throw new HostRelationshipError('host_appointment_cooldown_active', '主理 AI 的任命冷静期仍未结束');
    }
    const result = await tx.runAsync(
      `UPDATE ai_assistants SET
         is_host_ai = 1,
         host_cooldown_start = NULL,
         host_cooldown_end = NULL,
         host_revoke_cooldown_start = NULL,
         host_revoke_cooldown_end = NULL,
         updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [new Date().toISOString(), aiId],
    );
    if (result.changes !== 1) throw new HostRelationshipError('assistant_not_found', '指定的 AI 不存在');
    return true;
  }

  getAppointmentAvailability(): Promise<HostAppointmentAvailability> {
    return databaseCoordinator.read({ name: 'assistants.host-appointment-availability', feature: 'assistants', priority: 'surface' }, async (db) => {
      if (await this.readCurrentHostAIId(db)) return { status: 'occupied' };
      const cooldown = await this.readHostCooldown(db);
      return cooldown.endAt ? { status: 'cooldown', endAt: cooldown.endAt } : { status: 'vacant' };
    });
  }

  /**
   * 撤销主理AI
   */
  async revokeHostAI(aiId: string): Promise<boolean> {
    const cooldown = createHostAIAppointmentCooldown(new Date());
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.revokeHostAI', feature: 'assistants', priority: 'runtime' });
    await database.withExclusiveTransactionAsync(async (txn) => {
      const host = await txn.getFirstAsync<{ is_host_ai: number }>(
        'SELECT is_host_ai FROM ai_assistants WHERE id = ? LIMIT 1',
        [aiId]
      );
      if (!host) {
        throw new HostRelationshipError('assistant_not_found', '指定的 AI 不存在');
      }
      if (host.is_host_ai !== 1) return;
      await txn.runAsync(
        `UPDATE ai_assistants SET
           is_host_ai = 0,
           host_revoke_cooldown_start = ?,
           host_revoke_cooldown_end = ?,
           updated_at = ?
         WHERE id = ?`,
        [cooldown.startAt, cooldown.endAt, cooldown.startAt, aiId]
      );
      await upsertAppointmentCooldown(txn, {
        revokedAIId: aiId,
        startAt: cooldown.startAt,
        endAt: cooldown.endAt,
      });
    });
    return true;
  }

  /** 检查撤销后禁止重新任命的全局七天冷静期。 */
  async checkHostCooldown(): Promise<HostCooldownStatus> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.checkHostCooldown', feature: 'assistants', priority: 'runtime' });
    return this.readHostCooldown(database);
  }

  async readHostCooldown(database: DatabaseReadExecutor): Promise<HostCooldownStatus> {
    const row = await database.getFirstAsync<{
      appointment_cooldown_end: string | null;
      last_revoked_ai_id: string | null;
    }>(
      `SELECT appointment_cooldown_end, last_revoked_ai_id FROM host_ai_relationship_state
       WHERE id = ? LIMIT 1`,
      [HOST_AI_RELATIONSHIP_STATE_ID]
    );
    if (!row?.appointment_cooldown_end) {
      return { isInCooldown: false, remainingDays: 0, revokedAIId: null, endAt: null };
    }
    const now = new Date();
    const endTime = new Date(row.appointment_cooldown_end);
    if (now < endTime) {
      const remainingMs = endTime.getTime() - now.getTime();
      const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
      return { isInCooldown: true, remainingDays, revokedAIId: row.last_revoked_ai_id, endAt: row.appointment_cooldown_end };
    }
    return { isInCooldown: false, remainingDays: 0, revokedAIId: null, endAt: null };
  }

  /** 身份和有效期在提交事务内裁决；其他 AI 或过期调用不能解除这段关系冷静期。 */
  async releaseAppointmentCooldown(actorAIId: string): Promise<boolean> {
    return databaseCoordinator.transaction({ name: 'assistants.releaseAppointmentCooldown', feature: 'assistants', priority: 'runtime' }, async (tx) => {
      const now = new Date().toISOString();
      const result = await tx.runAsync(
        `UPDATE host_ai_relationship_state
         SET appointment_cooldown_start = NULL, appointment_cooldown_end = NULL, updated_at = ?
         WHERE id = ? AND last_revoked_ai_id = ? AND appointment_cooldown_end > ?
           AND EXISTS (SELECT 1 FROM ai_assistants WHERE id = ? AND is_host_ai = 0 AND deleted_at IS NULL)`,
        [now, HOST_AI_RELATIONSHIP_STATE_ID, actorAIId, now, actorAIId],
      );
      if (result.changes !== 1) return false;
      await tx.runAsync(
        `UPDATE ai_assistants SET host_revoke_cooldown_start = NULL,
         host_revoke_cooldown_end = NULL, updated_at = ? WHERE id = ?`,
        [now, actorAIId],
      );
      return true;
    });
  }

  // ==================== 拉黑管理 ====================

  /**
   * 拉黑AI助手
   *
   * 注意：blocked_by 列当前保存的是"执行拉黑动作的 host AI 的 ai_assistants.id"。
   * 它属于系统内部关系键，不是暴露给 AI 认知世界使用的 agentId。
   */
  async blockAI({ aiId, blockedByAIId, blockedUntil, reason = '' }: BlockAIParams): Promise<BlockedAIRecord> {
    const now = new Date().toISOString();
    const id = `blacklist_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.blockAI', feature: 'assistants', priority: 'runtime' });
    await database.runAsync(
      `INSERT INTO ai_blacklist (id, ai_id, blocked_by, blocked_until, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, aiId, blockedByAIId, blockedUntil, reason, now]
    );

    return { id, aiId, blockedByAIId, blockedUntil, reason, createdAt: now };
  }

  /**
   * 解除拉黑
   */
  async unblockAI(blacklistId: string): Promise<boolean> {
    const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.unblockAI', feature: 'assistants', priority: 'runtime' });
    await database.runAsync(
      'DELETE FROM ai_blacklist WHERE id = ?',
      [blacklistId]
    );

    return true;
  }

  /**
   * 检查AI是否被拉黑
   */
  async isAIBlocked(aiId: string): Promise<{ isBlocked: boolean; blockInfo: BlockedAIRecord | null }> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.isAIBlocked', feature: 'assistants', priority: 'runtime' });
      const now = new Date().toISOString();

      // 查找未过期的拉黑记录
      const row = await database.getFirstAsync<{ id: string; ai_id: string; blocked_by: string; blocked_until: string; reason: string | null; created_at: string }>(
        'SELECT * FROM ai_blacklist WHERE ai_id = ? AND blocked_until > ? ORDER BY created_at DESC LIMIT 1',
        [aiId, now]
      );

      if (!row) {
        return { isBlocked: false, blockInfo: null };
      }

      return {
        isBlocked: true,
        blockInfo: {
          id: row.id,
          aiId: row.ai_id,
          blockedByAIId: row.blocked_by,
          blockedUntil: row.blocked_until,
          reason: row.reason,
          createdAt: row.created_at
        }
      };
    } catch (error) {
      console.error('[AIHostRepository] Failed to check if AI is blocked:', error);
      return { isBlocked: false, blockInfo: null };
    }
  }

  /**
   * 清理已过期的拉黑记录
   */
  async cleanupExpiredBlocks(): Promise<boolean> {
    try {
      const database: CoordinatedDatabaseExecutor = databaseCoordinator.openTaskExecutor({ name: 'assistants.cleanupExpiredBlocks', feature: 'assistants', priority: 'runtime' });
      const now = new Date().toISOString();

      await database.runAsync(
        'DELETE FROM ai_blacklist WHERE blocked_until <= ?',
        [now]
      );

      return true;
    } catch (error) {
      console.error('[AIHostRepository] Failed to cleanup expired blocks:', error);
      return false;
    }
  }
}

export async function upsertAppointmentCooldown(
  txn: Pick<CoordinatedDatabaseExecutor, 'runAsync'>,
  input: { revokedAIId: string; startAt: string; endAt: string }
): Promise<void> {
  await txn.runAsync(
    `INSERT INTO host_ai_relationship_state (
       id, last_revoked_ai_id, appointment_cooldown_start,
       appointment_cooldown_end, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_revoked_ai_id = excluded.last_revoked_ai_id,
       appointment_cooldown_start = excluded.appointment_cooldown_start,
       appointment_cooldown_end = excluded.appointment_cooldown_end,
       updated_at = excluded.updated_at`,
    [
      HOST_AI_RELATIONSHIP_STATE_ID,
      input.revokedAIId,
      input.startAt,
      input.endAt,
      input.startAt,
      input.startAt,
    ]
  );
}

// 单例实例
export const aiHostRepository = new AIHostRepository();
