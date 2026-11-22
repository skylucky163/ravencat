import type { DeepSeekConversation, DeepSeekExportConversation, DeepSeekExportFile, DeepSeekExportMessage } from '../domain/DeepSeekImport';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const EXPORT_LINK = new RegExp(
  `^https://deepseek-chat-history-exports-prod\\.obs\\.cn-east-3\\.myhuaweicloud\\.com/${UUID}\\.zip\\?[^#\\s]+$`, 'i',
);
const SESSION_ID = new RegExp(`^${UUID}$`, 'i');

export function readDeepSeekExportLink(link: string): string {
  const url = link.trim();
  if (!EXPORT_LINK.test(url)) throw new Error('请粘贴 DeepSeek 官方 ZIP 导出下载链接。');
  // 对象存储签名依赖原始查询字符串。
  return url;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('DeepSeek ZIP 的对话数据格式无法识别。');
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('DeepSeek ZIP 的对话数据格式无法识别。');
  return value;
}

export function validateDeepSeekExportManifest(input: unknown): void {
  if (readRecord(input).export_format_version !== 3) throw new Error('当前只支持 DeepSeek 第 3 版 ZIP 导出格式。');
}

export function parseDeepSeekExportIndex(input: unknown): DeepSeekExportConversation[] {
  const ids = new Set<string>();
  return readArray(input).map(value => {
    const { id, title, message_count: count } = readRecord(value);
    if (typeof id !== 'string' || !SESSION_ID.test(id) || ids.has(id)
      || (title !== null && typeof title !== 'string') || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('DeepSeek ZIP 的对话索引格式无法识别。');
    }
    ids.add(id);
    return { id, title: (typeof title === 'string' && title.trim()) || '未命名对话', messageCount: count };
  });
}

function readFile(value: unknown, filesPrefix: string): DeepSeekExportFile {
  const file = readRecord(value);
  if (typeof file.file_name !== 'string' || !file.file_name.trim() || typeof file.is_image !== 'boolean') {
    throw new Error('DeepSeek 返回的附件格式无法识别。');
  }
  const path = file.export_path;
  return {
    fileName: file.file_name,
    archivePath: typeof path === 'string' && path.startsWith(filesPrefix) ? path : undefined,
    isImage: file.is_image,
    fileSize: typeof file.file_size === 'number' && Number.isSafeInteger(file.file_size) && file.file_size >= 0 ? file.file_size : null,
    width: typeof file.width === 'number' && Number.isSafeInteger(file.width) && file.width > 0 ? file.width : null,
    height: typeof file.height === 'number' && Number.isSafeInteger(file.height) && file.height > 0 ? file.height : null,
  };
}

function readMessage(id: number, row: Record<string, unknown>, filesPrefix: string): DeepSeekExportMessage | null {
  const { role, inserted_at: insertedAt } = row;
  const timestamp = typeof insertedAt === 'string' ? Date.parse(insertedAt) : NaN;
  if ((role !== 'USER' && role !== 'ASSISTANT') || !Number.isFinite(timestamp)) {
    throw new Error('DeepSeek ZIP 的消息格式无法识别。');
  }
  const text: string[] = [];
  const thinking: string[] = [];
  const files: DeepSeekExportFile[] = [];
  for (const value of readArray(row.fragments)) {
    const fragment = readRecord(value);
    if (fragment.type === (role === 'USER' ? 'REQUEST' : 'RESPONSE') || (role === 'ASSISTANT' && fragment.type === 'THINK')) {
      if (typeof fragment.content !== 'string') throw new Error('DeepSeek 返回的消息正文格式无法识别。');
      (fragment.type === 'THINK' ? thinking : text).push(fragment.content);
    } else if (role === 'USER' && fragment.type === 'FILE') {
      files.push(...readArray(fragment.files).map(file => readFile(file, filesPrefix)));
    }
  }
  const body = text.join('\n\n');
  const reasoning = thinking.join('\n\n');
  return body.trim() || reasoning.trim() || files.length
    ? { id, role, timestamp, text: body, thinking: reasoning, files }
    : null;
}

export function parseDeepSeekExportConversation(id: string, input: unknown): DeepSeekConversation {
  const session = readRecord(input);
  if (session.id !== id) throw new Error('DeepSeek ZIP 的对话与索引不一致。');

  const byId = new Map<number, Record<string, unknown>>();
  let lastId: number | null = null;
  for (const value of readArray(session.messages)) {
    const row = readRecord(value);
    const messageId = row.id;
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || byId.has(messageId)) {
      throw new Error('DeepSeek ZIP 的消息编号无法识别。');
    }
    byId.set(messageId, row);
    lastId = lastId === null ? messageId : Math.max(lastId, messageId);
  }

  const currentId = session.current_message_id;
  const messages: DeepSeekExportMessage[] = [];
  const seen = new Set<number>();
  const filesPrefix = `chat_sessions/${id}_files/`;
  // 编辑和重新生成会留下旁支，按导出时的对话末条向前还原。
  let nextId = typeof currentId === 'number' && byId.has(currentId) ? currentId : lastId;
  while (nextId !== null) {
    const row = byId.get(nextId);
    if (!row) break;
    if (seen.has(nextId)) throw new Error('DeepSeek ZIP 的消息顺序无法识别。');
    seen.add(nextId);
    const message = readMessage(nextId, row, filesPrefix);
    if (message) messages.push(message);
    const parentId = row.parent_id;
    if (parentId !== null && (typeof parentId !== 'number' || !Number.isSafeInteger(parentId))) {
      throw new Error('DeepSeek ZIP 的消息顺序无法识别。');
    }
    nextId = typeof parentId === 'number' ? parentId : null;
  }
  if (messages.length === 0) throw new Error('这条 DeepSeek 对话没有可导入的消息。');
  return { messages: messages.reverse(), hasHistoryGap: nextId !== null };
}
