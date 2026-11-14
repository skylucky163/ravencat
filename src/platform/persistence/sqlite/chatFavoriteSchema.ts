/** 收藏是独立快照，不对原消息、会话或角色建立级联外键。 */
import type { DatabaseWriteExecutor } from '../runtime';

export const CHAT_FAVORITES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_favorites (
    id TEXT PRIMARY KEY NOT NULL,
    source_message_id INTEGER NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN ('text', 'audio', 'image', 'file')),
    saved_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
  );
`;
export const CHAT_FAVORITES_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_chat_favorites_saved ON chat_favorites(saved_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_favorites_category_saved ON chat_favorites(category, saved_at DESC, id DESC);
`;

/** 旧收藏只存名称；仅由仍存在的原消息恢复身份，不能根据重名角色猜测归属。 */
export async function migrateChatFavoriteIdentities(db: DatabaseWriteExecutor): Promise<void> {
  await db.execAsync(`UPDATE chat_favorites SET snapshot_json = json_set(snapshot_json,
    '$.sourceAssistantId', (SELECT s.ai_assistant_id FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.id = chat_favorites.source_message_id),
    '$.sourceGroupId', (SELECT m.session_id FROM messages m JOIN chat_conversations c ON c.id = m.session_id
      WHERE m.id = chat_favorites.source_message_id AND c.kind = 'group'),
    '$.authorAgentId', CASE WHEN json_extract(snapshot_json, '$.authorKind') = 'assistant' THEN
      (SELECT coalesce(m.agent_id, json_extract(m.metadata_json, '$.actorAgentId'), a.agent_id)
        FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
        LEFT JOIN ai_assistants a ON a.id = s.ai_assistant_id WHERE m.id = chat_favorites.source_message_id)
      ELSE NULL END
  );`);
}
