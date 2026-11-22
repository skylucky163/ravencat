import { databaseCoordinator, type DatabaseReadExecutor, type DatabaseTransactionExecutor } from '@platform/persistence';
import { ChatCodeWorkError, type ChatCodeLibraryItem, type ChatCodePreview, type ChatCodePreviewSnapshot, type ChatCodePreviewRepository, type ChatCodeWorkScope, type ChatCodeWorkPage, type ChatCodeWorkWriteAccess, type ChatCodeWorkChanges } from '../domain/ChatCodePreview';

async function assertWorkAccess(tx: DatabaseTransactionExecutor, id: string, access: ChatCodeWorkWriteAccess): Promise<void> {
  await access.assertCurrent(tx);
  const own = await tx.getFirstAsync(`SELECT 1 FROM chat_code_previews p
    JOIN ai_assistants a ON a.agent_id = p.agent_id WHERE p.id = ? AND a.id = ? AND a.deleted_at IS NULL`, [id, access.assistantId]);
  if (!own) throw new ChatCodeWorkError('未找到属于自己的作品，请用 list_code_works 查询有效作品 ID。');
}

/** 备份必须使用所归档数据库的封面引用，不能用备份期间已变化的活动收纳关系替代。 */
export async function readChatCodeCoverFileReferences(db: DatabaseReadExecutor): Promise<string[]> {
  const rows = await db.getAllAsync<{ cover_file: string }>(
    'SELECT cover_file FROM chat_code_library WHERE cover_file IS NOT NULL');
  return rows.map(row => row.cover_file);
}

export class SQLiteChatCodePreviewRepository implements ChatCodePreviewRepository {
  get(id: string, assistantId?: string): Promise<ChatCodePreview | null> {
    return databaseCoordinator.read({ name: 'chat.code-preview.get', feature: 'chat', priority: 'interactive' }, async db => {
      const row = await db.getFirstAsync<{
        id: string; agent_id: string | null; language: string; source: string; title: string; can_render: number; created_at: string; in_library: number; cover_file: string | null;
      }>(`SELECT p.id, p.agent_id, p.language, p.source, p.title, p.can_render, p.created_at,
        (l.preview_id IS NOT NULL) AS in_library, l.cover_file FROM chat_code_previews p
        LEFT JOIN chat_code_library l ON l.preview_id = p.id WHERE p.id = ?
        ${assistantId === undefined ? '' : 'AND EXISTS (SELECT 1 FROM ai_assistants a WHERE a.agent_id = p.agent_id AND a.id = ? AND a.deleted_at IS NULL)'}
        `, assistantId === undefined ? [id] : [id, assistantId]);
      return row ? { id: row.id, agentId: row.agent_id, language: row.language, source: row.source, title: row.title,
        canRender: row.can_render === 1, createdAt: row.created_at, inLibrary: row.in_library === 1, coverFile: row.cover_file } : null;
    });
  }

  listWorks(assistantId: string, scope: ChatCodeWorkScope, offset: number): Promise<ChatCodeWorkPage> {
    return databaseCoordinator.read({ name: 'chat.code-works.list', feature: 'chat', priority: 'interactive' }, async db => {
      const rows = await db.getAllAsync<{ id: string; title: string; created_at: string; in_library: number }>(
        `SELECT p.id, p.title, p.created_at, (l.preview_id IS NOT NULL) AS in_library
         FROM chat_code_previews p JOIN ai_assistants a ON a.agent_id = p.agent_id
         LEFT JOIN chat_code_library l ON l.preview_id = p.id
         WHERE a.id = ? AND a.deleted_at IS NULL AND p.can_render = 1
         ${scope === 'all' ? '' : scope === 'saved' ? 'AND l.preview_id IS NOT NULL' : 'AND l.preview_id IS NULL'}
         ORDER BY p.created_at DESC, p.id DESC LIMIT 21 OFFSET ?`, [assistantId, offset]);
      return { entries: rows.slice(0, 20).map(row => ({ id: row.id, title: row.title, createdAt: row.created_at, inLibrary: row.in_library === 1 })),
        nextOffset: rows.length > 20 ? offset + 20 : null };
    });
  }

  async saveInTransaction(tx: DatabaseTransactionExecutor, preview: ChatCodePreviewSnapshot, sourceMessageId: number | null): Promise<void> {
    // 同一稳定消息身份只产生一份快照；T3 将此前打开的运行片段绑定到正式消息。
    await tx.runAsync(`INSERT INTO chat_code_previews
      (id, agent_id, language, source, title, can_render, created_at, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_message_id = COALESCE(excluded.source_message_id, chat_code_previews.source_message_id),
        agent_id = COALESCE(chat_code_previews.agent_id, excluded.agent_id)`,
    [preview.id, preview.agentId, preview.language, preview.source, preview.title, preview.canRender ? 1 : 0, preview.createdAt, sourceMessageId]);
  }

  listLibrary(assistantId: string): Promise<ChatCodeLibraryItem[]> {
    return databaseCoordinator.read({ name: 'chat.code-library.list', feature: 'chat', priority: 'interactive' }, async db => {
      // 只用助手身份限定来源；源码快照持有作者身份，不随来源消息删除而丢失归属。
      const rows = await db.getAllAsync<{ id: string; title: string; cover_file: string | null; created_at: string; added_at: string }>(
        `SELECT p.id, p.title, l.cover_file, p.created_at, l.added_at
         FROM chat_code_library l JOIN chat_code_previews p ON p.id = l.preview_id
         JOIN ai_assistants a ON a.agent_id = p.agent_id WHERE a.id = ? AND a.deleted_at IS NULL
         ORDER BY l.added_at DESC, p.id DESC`, [assistantId]);
      return rows.map(row => ({ id: row.id, title: row.title, coverFile: row.cover_file, createdAt: row.created_at, addedAt: row.added_at }));
    });
  }

  /** 返回此前的封面文件名（可能为 null），调用方负责 commit 后清理被替换的文件。 */
  async setInLibrary(id: string, included: boolean, coverFile: string | null = null, access?: ChatCodeWorkWriteAccess): Promise<string | null> {
    return databaseCoordinator.transaction({ name: 'chat.code-library.set', feature: 'chat', priority: 'interactive' }, async tx => {
      if (access) await assertWorkAccess(tx, id, access);
      const existing = await tx.getFirstAsync<{ cover_file: string | null }>(
        'SELECT cover_file FROM chat_code_library WHERE preview_id = ?', [id]);
      if (!included) {
        await tx.runAsync('DELETE FROM chat_code_library WHERE preview_id = ?', [id]);
        return existing?.cover_file ?? null;
      }
      const preview = await tx.getFirstAsync<{ can_render: number; agent_id: string | null }>(
        'SELECT can_render, agent_id FROM chat_code_previews WHERE id = ?', [id]);
      if (!preview) throw new ChatCodeWorkError('这份网页源码已不存在');
      if (preview.can_render !== 1) throw new ChatCodeWorkError('只有完整网页可以加入作品库');
      if (preview.agent_id === null) throw new ChatCodeWorkError('无法确认这份网页的来源 AI');
      // 显式设置收纳状态，唯一键裁决重复加入；不改写源码或其他版本的选择。
      await tx.runAsync(`INSERT INTO chat_code_library (preview_id, added_at, cover_file) VALUES (?, ?, ?)
        ON CONFLICT(preview_id) DO UPDATE SET cover_file = COALESCE(excluded.cover_file, chat_code_library.cover_file)`, [id, new Date().toISOString(), coverFile]);
      return existing?.cover_file ?? null;
    });
  }

  async editWork(id: string, changes: ChatCodeWorkChanges, access?: ChatCodeWorkWriteAccess): Promise<string | null> {
    return databaseCoordinator.transaction({ name: 'chat.code-work.edit', feature: 'chat', priority: 'interactive' }, async tx => {
      if (access) await assertWorkAccess(tx, id, access);
      let previousCover: string | null = null;
      if (changes.coverFile !== undefined) {
        const existing = await tx.getFirstAsync<{ cover_file: string | null }>(
          'SELECT cover_file FROM chat_code_library WHERE preview_id = ?', [id]);
        if (!existing) throw new ChatCodeWorkError('这份作品不在作品库中，请先加入作品库再设置封面。');
        await tx.runAsync('UPDATE chat_code_library SET cover_file = ? WHERE preview_id = ?', [changes.coverFile, id]);
        previousCover = existing.cover_file;
      }
      if (changes.title !== undefined) await tx.runAsync('UPDATE chat_code_previews SET title = ? WHERE id = ?', [changes.title, id]);
      return previousCover;
    });
  }
}

export const chatCodePreviewRepository = new SQLiteChatCodePreviewRepository();
