import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import type { ChatFavoriteRepository } from '../domain/ChatFavoriteRepository';
import type { ChatFavorite, ChatFavoriteCategory, ChatFavoriteCursor, ChatFavoritePage, ChatFavoriteRef, ChatFavoriteSearch, ChatFavoriteSnapshot } from '../domain/ChatFavorite';
import { getChatFavoriteCategory } from '../domain/ChatFavorite';
import { isChatVoiceMessageMetadata } from '../../messages/domain/chatMessageMetadata';
import type { StoredChatAttachment } from '../../messages/domain/ChatAttachment';

interface FavoriteRow { id: string; source_message_id: number; category: ChatFavoriteCategory; saved_at: string; snapshot_json: string }
const PAGE_SIZE = 40;
function isAttachment(value: unknown): value is StoredChatAttachment {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.fileName === 'string'
    && (item.unavailable === true || (typeof item.mediaAssetId === 'string' && item.mediaAssetId.length > 0))
    && (item.type === 'image' || item.type === 'file')
    && ['gallery', 'camera', 'document', 'clipboard', 'screen_capture'].includes(item.source as string)
    && ['thumbnailMediaAssetId', 'mimeType', 'parsedText', 'previewText'].every(key => item[key] == null || typeof item[key] === 'string')
    && ['width', 'height', 'fileSize'].every(key => item[key] == null || (typeof item[key] === 'number' && Number.isFinite(item[key])));
}
/** SQLite 是输入边界；有效 JSON 约束不保证快照形状，校验后内部页面只消费类型契约。 */
function parseSnapshot(json: string): ChatFavoriteSnapshot {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object') throw new Error('收藏记录损坏');
  const snapshot = value as Record<string, unknown>;
  if (!['sourceName', 'authorName', 'messageCreatedAt', 'text'].every(key => typeof snapshot[key] === 'string')
    || !['sourceAssistantId', 'sourceGroupId', 'authorAgentId'].every(key => snapshot[key] === null || typeof snapshot[key] === 'string')
    || (snapshot.authorKind !== 'user' && snapshot.authorKind !== 'assistant')
    || (snapshot.replyToText !== null && typeof snapshot.replyToText !== 'string')
    || (snapshot.reasoningText !== undefined && typeof snapshot.reasoningText !== 'string')
    || !Array.isArray(snapshot.attachments) || !snapshot.attachments.every(isAttachment)
    || (snapshot.voice !== null && !isChatVoiceMessageMetadata({ kind: 'voice', voice: snapshot.voice }))) {
    throw new Error('收藏记录损坏');
  }
  return snapshot as unknown as ChatFavoriteSnapshot;
}
function map(row: FavoriteRow): ChatFavorite {
  const snapshot = parseSnapshot(row.snapshot_json);
  if (getChatFavoriteCategory(snapshot) !== row.category) throw new Error('收藏分类与内容不一致');
  return { id: row.id, sourceMessageId: row.source_message_id, category: row.category,
    savedAt: row.saved_at, snapshot };
}
export class SQLiteChatFavoriteRepository implements ChatFavoriteRepository {
  private readonly database = databaseCoordinator.openTaskExecutor({ name: 'chat.favorites', feature: 'chat', priority: 'interactive' });
  async getBySource(messageId: number): Promise<ChatFavorite | null> {
    const row = await this.database.getFirstAsync<FavoriteRow>('SELECT * FROM chat_favorites WHERE source_message_id = ?', [messageId]);
    return row ? map(row) : null;
  }
  async getBySourceInTransaction(transaction: DatabaseTransactionExecutor, messageId: number): Promise<ChatFavorite | null> {
    const row = await transaction.getFirstAsync<FavoriteRow>('SELECT * FROM chat_favorites WHERE source_message_id = ?', [messageId]);
    return row ? map(row) : null;
  }
  async listRefsBySources(messageIds: readonly number[]): Promise<ChatFavoriteRef[]> {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) return [];
    return this.database.getAllAsync<ChatFavoriteRef>(
      'SELECT id, source_message_id AS sourceMessageId FROM chat_favorites WHERE source_message_id IN (SELECT value FROM json_each(?))',
      [JSON.stringify(ids)],
    );
  }
  async createInTransaction(transaction: DatabaseTransactionExecutor, favorite: ChatFavorite): Promise<void> {
    // 收藏的媒体引用与快照同事务成立；已释放的资产不能被重新引用。
    const mediaIds = new Set(favorite.snapshot.attachments.flatMap(attachment => [attachment.mediaAssetId, attachment.thumbnailMediaAssetId].filter((id): id is string => Boolean(id))));
    if (favorite.snapshot.voice) mediaIds.add(favorite.snapshot.voice.mediaAssetId);
    for (const id of mediaIds) {
      const asset = await transaction.getFirstAsync<{ id: string }>('SELECT id FROM media_assets WHERE id = ?', [id]);
      if (!asset) throw new Error('消息附件已不可用，无法收藏');
    }
    await transaction.runAsync('INSERT INTO chat_favorites (id, source_message_id, category, saved_at, snapshot_json) VALUES (?, ?, ?, ?, ?)',
      [favorite.id, favorite.sourceMessageId, favorite.category, favorite.savedAt, JSON.stringify(favorite.snapshot)]);
  }
  async list(category: ChatFavoriteCategory | null, cursor: ChatFavoriteCursor | null, search: ChatFavoriteSearch | null): Promise<ChatFavoritePage> {
    const clauses: string[] = [`NOT EXISTS (SELECT 1 FROM ai_assistants a
      WHERE a.id = json_extract(snapshot_json, '$.sourceAssistantId') AND a.deleted_at IS NOT NULL)`];
    const params: (string | number)[] = [];
    if (category) { clauses.push('category = ?'); params.push(category); }
    if (search) {
      // 仅搜索业务文字，不扫描媒体 ID、文件路径或图片元数据；instr 将 % 和 _ 作为普通字符。
      clauses.push(`(
        instr(lower(json_extract(snapshot_json, '$.sourceName')), ?) > 0
        OR instr(lower(json_extract(snapshot_json, '$.authorName')), ?) > 0
        OR json_extract(snapshot_json, '$.sourceAssistantId') IN (SELECT value FROM json_each(?))
        OR json_extract(snapshot_json, '$.sourceGroupId') IN (SELECT value FROM json_each(?))
        OR json_extract(snapshot_json, '$.authorAgentId') IN (SELECT value FROM json_each(?))
        OR (? = 1 AND json_extract(snapshot_json, '$.authorKind') = 'user')
        OR (category <> 'image' AND (
          instr(lower(json_extract(snapshot_json, '$.text')), ?) > 0
          OR instr(lower(json_extract(snapshot_json, '$.replyToText')), ?) > 0
          OR instr(lower(json_extract(snapshot_json, '$.reasoningText')), ?) > 0
          OR EXISTS (SELECT 1 FROM json_each(snapshot_json, '$.attachments') AS attachment
            WHERE json_extract(attachment.value, '$.type') = 'file' AND (
              instr(lower(json_extract(attachment.value, '$.fileName')), ?) > 0
              OR instr(lower(json_extract(attachment.value, '$.parsedText')), ?) > 0
            ))
        ))
      )`);
      params.push(search.text, search.text, JSON.stringify(search.sourceAssistantIds), JSON.stringify(search.sourceGroupIds),
        JSON.stringify(search.authorAgentIds), Number(search.includeUserAuthor), search.text, search.text, search.text, search.text, search.text);
    }
    if (cursor) { clauses.push('(saved_at, id) < (?, ?)'); params.push(cursor.savedAt, cursor.id); }
    const rows = await this.database.getAllAsync<FavoriteRow>(`SELECT * FROM chat_favorites ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY saved_at DESC, id DESC LIMIT ?`, [...params, PAGE_SIZE + 1]);
    const items = rows.slice(0, PAGE_SIZE).map(map);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > PAGE_SIZE ? { savedAt: last.savedAt, id: last.id } : null };
  }
  async removeInTransaction(transaction: DatabaseTransactionExecutor, id: string): Promise<string[]> {
    const assets = await transaction.getAllAsync<{ asset_id: string }>(`SELECT DISTINCT CAST(tree.value AS TEXT) AS asset_id
      FROM chat_favorites, json_tree(chat_favorites.snapshot_json) AS tree
      WHERE chat_favorites.id = ? AND tree.type = 'text' AND tree.key IN ('mediaAssetId', 'thumbnailMediaAssetId')`, [id]);
    await transaction.runAsync('DELETE FROM chat_favorites WHERE id = ?', [id]);
    return assets.map(asset => asset.asset_id);
  }
}
