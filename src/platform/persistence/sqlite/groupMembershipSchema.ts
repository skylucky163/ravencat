/** 退出历史只依赖 AI 身份，不随原群删除；群成员的禁言不改变 enabled 成员资格。 */
import type { DatabaseWriteExecutor } from '../runtime';
import { addColumnIfMissing } from './schemaColumnGuard';

export const GROUP_HISTORY_SCHEMA = `CREATE TABLE IF NOT EXISTS group_chat_history (
  id TEXT PRIMARY KEY,
  ai_assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  exited_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('left', 'removed')),
  inject_enabled INTEGER NOT NULL DEFAULT 1 CHECK (inject_enabled IN (0, 1)),
  context_json TEXT NOT NULL,
  UNIQUE(ai_assistant_id, group_id)
);`;

export async function migrateGroupMembership(db: DatabaseWriteExecutor): Promise<void> {
  await addColumnIfMissing(db, 'group_chat_members', 'muted', 'INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1))');
  await addColumnIfMissing(db, 'group_chat_members', 'joined_during_plan_id', 'TEXT');
}
