/** 源码快照与手动收纳关系分开保存；移出作品库不删除源码或消息。 */
import type { DatabaseWriteExecutor } from '../runtime';
import { addColumnIfMissing } from './schemaColumnGuard';

export const CHAT_CODE_PREVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_code_previews (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT,
    language TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    can_render INTEGER NOT NULL CHECK (can_render IN (0, 1)),
    created_at TEXT NOT NULL,
    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_code_previews_source ON chat_code_previews(source_message_id);
  CREATE TABLE IF NOT EXISTS chat_code_library (
    preview_id TEXT PRIMARY KEY NOT NULL REFERENCES chat_code_previews(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    cover_file TEXT
  );
`;
/** 旧快照只从仍存在的消息回填真实作者，不按相邻聊天或标题猜测作品归属。 */
export async function migrateChatCodeLibrary(db: DatabaseWriteExecutor, previousVersion: number): Promise<void> {
  if (previousVersion === 171) await addColumnIfMissing(db, 'chat_code_previews', 'agent_id', 'TEXT');
  if (previousVersion < 172) await db.execAsync(`UPDATE chat_code_previews SET agent_id =
    (SELECT m.agent_id FROM messages m WHERE m.id = chat_code_previews.source_message_id)
    WHERE agent_id IS NULL;`);
  // 173：封面文件名属于收纳关系，移出作品库即失效。
  if (previousVersion === 172) await addColumnIfMissing(db, 'chat_code_library', 'cover_file', 'TEXT');
  // 174：旧封面在应用私有目录，未随备份归档；引用置空，由下次收纳或上传重建。
  if (previousVersion === 173) await db.execAsync('UPDATE chat_code_library SET cover_file = NULL;');
}
