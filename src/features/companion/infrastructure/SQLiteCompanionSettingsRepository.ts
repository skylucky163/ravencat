/** 使用 SQLite 持久化本地伴随正式设置。 */

import { databaseCoordinator } from '@platform/persistence';
import {
  createCompanionSettings,
  createCompanionSettingsFromRow,
  COMPANION_SETTINGS_ID,
  type CompanionSettings,
  type CompanionSettingsRow,
  type UpdateCompanionSettingsInput,
} from '../domain/CompanionSettings';
import type { CompanionSettingsRepository } from '../domain/CompanionRepositories';

export class SQLiteCompanionSettingsRepository
  implements CompanionSettingsRepository {
  async get(): Promise<CompanionSettings | null> {
    const db = databaseCoordinator.openTaskExecutor({ name: 'companion.settings.get', feature: 'companion', priority: 'surface' });
    const row = await db.getFirstAsync<CompanionSettingsRow>(
      `SELECT id, quiet_hours_enabled,
              quiet_hours_start_minutes, quiet_hours_end_minutes,
              user_screen_capture_blacklist_json,
              follow_up_enabled, follow_up_interval_minutes,
              created_at, updated_at
       FROM raven_cat_contact_settings WHERE id = ? LIMIT 1`,
      [COMPANION_SETTINGS_ID]
    );
    return createCompanionSettingsFromRow(row);
  }

  async ensureDefault(): Promise<CompanionSettings> {
    const existing = await this.get();
    if (existing) return existing;

    const db = databaseCoordinator.openTaskExecutor({ name: 'companion.settings.ensureDefault', feature: 'companion', priority: 'surface' });
    const settings = createCompanionSettings();
    await db.runAsync(
      `INSERT OR IGNORE INTO raven_cat_contact_settings (
         id, quiet_hours_enabled,
         quiet_hours_start_minutes, quiet_hours_end_minutes,
         user_screen_capture_blacklist_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        settings.id,
        settings.quietHoursEnabled ? 1 : 0,
        settings.quietHoursStartMinutes,
        settings.quietHoursEndMinutes,
        JSON.stringify(settings.userScreenCaptureBlacklist),
        settings.createdAt,
        settings.updatedAt,
      ]
    );
    const persisted = await this.get();
    if (!persisted) {
      throw new Error('RavenCat 本地伴随设置初始化失败');
    }
    return persisted;
  }

  async update(
    updates: UpdateCompanionSettingsInput
  ): Promise<CompanionSettings> {
    await this.ensureDefault();
    const db = databaseCoordinator.openTaskExecutor({ name: 'companion.settings.update', feature: 'companion', priority: 'surface' });
    return db.withExclusiveTransactionAsync(async tx => {
      // 在写事务内合并当前偏好，避免另一项设置的旧快照把用户刚关闭的续轮重新开启。
      const row = await tx.getFirstAsync<CompanionSettingsRow>(
        'SELECT * FROM raven_cat_contact_settings WHERE id=?', [COMPANION_SETTINGS_ID]);
      const next = createCompanionSettings({
        ...createCompanionSettingsFromRow(row)!, ...updates, updatedAt: new Date().toISOString(),
      });
      await tx.runAsync(
        `UPDATE raven_cat_contact_settings
         SET quiet_hours_enabled = ?,
             quiet_hours_start_minutes = ?, quiet_hours_end_minutes = ?,
             user_screen_capture_blacklist_json = ?,
             follow_up_enabled = ?, follow_up_interval_minutes = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          next.quietHoursEnabled ? 1 : 0,
          next.quietHoursStartMinutes,
          next.quietHoursEndMinutes,
          JSON.stringify(next.userScreenCaptureBlacklist),
          next.followUpEnabled ? 1 : 0,
          next.followUpIntervalMinutes,
          next.updatedAt,
          next.id,
        ]
      );
      if (updates.followUpEnabled === false) {
        await tx.runAsync('DELETE FROM raven_cat_ai_schedule_unanswered');
        await tx.runAsync('UPDATE raven_cat_ai_schedule_wait SET revision=revision+1, active_run_id=NULL');
        await tx.runAsync(`UPDATE raven_cat_ai_schedules SET status='cancelled', cancelled_at=?,
          updated_at=?, cancelled_reason='merged_chat' WHERE trigger_kind='unanswered' AND status='scheduled'`,
        [next.updatedAt,next.updatedAt]);
      }
      return next;
    });
  }
}

export const companionSettingsRepository =
  new SQLiteCompanionSettingsRepository();
