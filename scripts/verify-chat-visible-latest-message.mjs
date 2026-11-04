import { sharedChatRecordModuleUrl, sharedMomentModuleUrl } from './helpers/chat-sharing-fixture.mjs';
import { chatReplyVersionModuleUrl, chatMutationModuleUrl, chatTimelineModuleUrl, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
/**
 * clear history 可见边界的 latest-message 回归测试。
 *
 * 产品语义：clear history = 隐藏当前可见历史，不删除底层消息、不让 AI 遗忘。
 * 所有 presentation 语义的“当前会话最后一条消息”查询都必须遵守 direct
 * conversation 的 visible_after_message_id 边界。
 *
 * 覆盖 confirmed bug：
 *   DeleteChatMessage 删除 clear 后的新消息后，preview 重算曾用未过滤边界的
 *   getLatestMessage()，把 clear 前的旧消息重新写回会话 preview。
 *
 * 验证方式：
 *   1. 用 node:sqlite 内存库承载真实 messages / sessions schema；
 *   2. 转译 SQLiteMessageRepository 源码，仅把 @platform/persistence 替换为
 *      内存库适配的 databaseCoordinator stub，其余查询逻辑执行真实代码；
 *   3. 运行 4 个行为场景（核心复现 / clear 后多条 / 未 clear / 群聊兼容）；
 *   删除用例的事务与 preview 行为另由 verify-chat-delete-preview-boundary 覆盖。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

// ============================================================================
// 装配真实 SQLiteMessageRepository（stub 掉 databaseCoordinator）
// ============================================================================
const timeSeparatorUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/MessageTimeSeparator.ts'),
);

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      ai_assistant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      last_message TEXT,
      last_time TEXT,
      is_active INTEGER DEFAULT 1,
      is_pinned INTEGER DEFAULT 0,
      visible_after_message_id INTEGER,
      visible_after_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      client_message_id TEXT,
      text TEXT NOT NULL,
      is_me INTEGER NOT NULL,
      sender_type TEXT,
      api_message_id TEXT,
      time TEXT,
      created_at TEXT NOT NULL,
      show_time_separator_before INTEGER DEFAULT 0,
      updated_at TEXT,
      reply_to_id INTEGER,
      reply_to_text TEXT,
      logical_message_id TEXT,
      segment_index INTEGER DEFAULT 0,
      segment_total INTEGER DEFAULT 1,
      delivery_status TEXT DEFAULT 'delivered',
      status TEXT DEFAULT 'sent',
      tokens_used INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      metadata_json TEXT,
      is_read INTEGER DEFAULT 0,
      voice_played_at TEXT,
      turn_run_id TEXT,
      turn_item_index INTEGER
    );
  `);
  db.exec(`CREATE TRIGGER fixture_conversation AFTER INSERT ON sessions BEGIN INSERT INTO chat_conversations VALUES (NEW.id, 'private'); END;`);
  installChatTimelineSchema(db);
  return db;
}

function createPersistenceStub(db) {
  const executor = {
    getFirstAsync: async (sql, params = []) => {
      const rows = db.prepare(sql).all(...params);
      return rows.length > 0 ? rows[0] : null;
    },
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
  };
  return {
    databaseCoordinator: { openTaskExecutor: () => executor },
  };
}

async function importMessageRepository(db) {
  // stub 模块按 data URL 缓存：databaseCoordinator 必须在调用时惰性读取当前
  // globalThis.__VERIFY_PERSISTENCE__，否则多个用例会复用第一个用例的数据库连接。
  const stubUrl = transpileToModuleUrl(
    `export const databaseCoordinator = {
       openTaskExecutor: (...args) => globalThis.__VERIFY_PERSISTENCE__.databaseCoordinator.openTaskExecutor(...args),
     };`,
  );
  globalThis.__VERIFY_PERSISTENCE__ = createPersistenceStub(db);
  const metadataUrl = transpileToModuleUrl(read('src/features/chat/messages/domain/chatMessageMetadata.ts').replaceAll("from './SharedMoment'", `from '${sharedMomentModuleUrl}'`)
    .replaceAll("from './ChatSticker'", `from '${transpileToModuleUrl(read('src/features/chat/messages/domain/ChatSticker.ts'))}'`)
    .replaceAll("from './SharedChatRecord'", `from '${sharedChatRecordModuleUrl}'`));
  const source = read('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts').replaceAll("from './ChatTimelineSql'", `from '${chatTimelineModuleUrl}'`).replaceAll("from './ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`).replaceAll("from '../../reply/infrastructure/ChatReplyVersionSql'", `from '${chatReplyVersionModuleUrl}'`)
    .replace("from '../domain/chatMessageMetadata'", `from '${metadataUrl}'`);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replaceAll('from "@platform/persistence"', `from "${stubUrl}"`)
    .replaceAll('from \'@platform/persistence\'', `from '${stubUrl}'`)
    .replaceAll('from "../domain/MessageTimeSeparator"', `from "${timeSeparatorUrl}"`)
    .replaceAll('from \'../domain/MessageTimeSeparator\'', `from '${timeSeparatorUrl}'`);
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function insertMessage(db, sessionId, text, options = {}) {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO messages (
      session_id, agent_id, client_message_id, text, is_me, sender_type, api_message_id,
      time, created_at, show_time_separator_before, updated_at, reply_to_id, reply_to_text,
      logical_message_id, segment_index, segment_total, delivery_status, status,
      tokens_used, prompt_tokens, completion_tokens, metadata_json, is_read,
      voice_played_at, turn_run_id, turn_item_index
    ) VALUES (?, NULL, NULL, ?, ?, ?, NULL, ?, ?, 0, ?, NULL, NULL, NULL, 0, 1,
              'delivered', 'sent', 0, 0, 0, NULL, ?, NULL, NULL, NULL)
  `).run(
    sessionId,
    text,
    options.isMe === false ? 0 : 1,
    options.senderType ?? 'user',
    createdAt,
    createdAt,
    options.isMe === false ? 0 : 1,
  );
  return Number(result.lastInsertRowid);
}

function insertSession(db, sessionId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (
      id, ai_assistant_id, name, last_message, last_time, is_active, is_pinned,
      visible_after_message_id, visible_after_at, created_at, updated_at
    ) VALUES (?, 'ai-1', '会话', '', ?, 1, 0, NULL, NULL, ?, ?)
  `).run(sessionId, now, now, now);
}

function setVisibleBoundary(db, sessionId, boundaryMessageId) {
  db.prepare(
    'UPDATE sessions SET visible_after_message_id = ? WHERE id = ?',
  ).run(boundaryMessageId, sessionId);
}

// ============================================================================
// Case 1：核心复现 —— clear 后删除唯一新消息，preview 来源必须为空
// ============================================================================
{
  const db = createDatabase();
  const repo = (await importMessageRepository(db)).messageRepository;
  const sessionId = 'session_case1';
  insertSession(db, sessionId);
  const aId = insertMessage(db, sessionId, 'A');
  const bId = insertMessage(db, sessionId, 'B');
  setVisibleBoundary(db, sessionId, bId);

  const cId = insertMessage(db, sessionId, 'C');
  assert.equal((await repo.getLatestVisibleMessage(sessionId))?.id, cId, 'clear 后 visible latest 应为 C');

  // 模拟 DeleteChatMessage 删除 C 后的 preview 重算来源查询
  await repo.deleteMessage(cId);
  const afterDelete = await repo.getLatestVisibleMessage(sessionId);
  assert.equal(afterDelete, null, '删除 C 后 visible latest 必须为 null，不得回退到 B');

  // 底层历史不受 clear / 修复影响
  const historical = await repo.getLatestMessage(sessionId);
  assert.equal(historical?.id, bId, 'getLatestMessage 仍返回底层真实历史最后一条 B');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(sessionId).count,
    2,
    'clear 与删除都不得真正删除底层消息 A/B',
  );

  // 当前可见聊天 UI 仍为空
  const page = await repo.getMessages(sessionId, { limit: 20 });
  assert.equal(page.messages.length, 0, '删除 C 后 getMessages 不得重新暴露 A/B');
  assert.equal(aId > 0, true);
}

// ============================================================================
// Case 2：clear 后存在多条新消息，删除最后一条 preview 回退到可见的 C
// ============================================================================
{
  const db = createDatabase();
  const repo = (await importMessageRepository(db)).messageRepository;
  const sessionId = 'session_case2';
  insertSession(db, sessionId);
  insertMessage(db, sessionId, 'A');
  const bId = insertMessage(db, sessionId, 'B');
  setVisibleBoundary(db, sessionId, bId);
  const cId = insertMessage(db, sessionId, 'C');
  const dId = insertMessage(db, sessionId, 'D');

  await repo.deleteMessage(dId);
  assert.equal(
    (await repo.getLatestVisibleMessage(sessionId))?.id,
    cId,
    '删除 D 后 visible latest 应回退到 C，而不是 clear 前的 B',
  );
}

// ============================================================================
// Case 3：未 clear 的普通删除行为不变
// ============================================================================
{
  const db = createDatabase();
  const repo = (await importMessageRepository(db)).messageRepository;
  const sessionId = 'session_case3';
  insertSession(db, sessionId);
  const aId = insertMessage(db, sessionId, 'A');
  const bId = insertMessage(db, sessionId, 'B');

  assert.equal((await repo.getLatestVisibleMessage(sessionId))?.id, bId, '未 clear 时 visible latest 即最后一条');
  await repo.deleteMessage(bId);
  assert.equal(
    (await repo.getLatestVisibleMessage(sessionId))?.id,
    aId,
    '未 clear 时删除 B 后 preview 正常回退到 A',
  );
}

// ============================================================================
// Case 4：群聊兼容 —— groupId 在 sessions 表无边界，visible latest 不过滤
// ============================================================================
{
  const db = createDatabase();
  const repo = (await importMessageRepository(db)).messageRepository;
  const groupId = 'group_case4';
  const xId = insertMessage(db, groupId, 'X', { isMe: true });
  const yId = insertMessage(db, groupId, 'Y', { isMe: false, senderType: 'assistant' });

  const visible = await repo.getLatestVisibleMessage(groupId);
  const historical = await repo.getLatestMessage(groupId);
  assert.equal(visible?.id, yId, '群聊 visible latest 应为最新一条 Y');
  assert.equal(historical?.id, yId, '群聊 getLatestMessage 与 visible latest 语义一致');
  await repo.deleteMessage(yId);
  assert.equal(
    (await repo.getLatestVisibleMessage(groupId))?.id,
    xId,
    '群聊删除消息后 visible latest 正常回退，行为不因本修复变化',
  );
  assert.equal(xId > 0, true);
}

// 分页窗口只改变读取成本，canonical 顺序、完整字段和清历史边界保持不变。
{
  const db = createDatabase();
  const repo = (await importMessageRepository(db)).messageRepository;
  insertSession(db, 'pagination');
  insertSession(db, 'other');
  const at = (seconds) => new Date(Date.UTC(2026, 9, 10, 0, 0, seconds)).toISOString();
  const user = insertMessage(db, 'pagination', '长正文'.repeat(2000), { createdAt: at(0) });
  const tail = insertMessage(db, 'pagination', '末段', { createdAt: at(40) });
  const first = insertMessage(db, 'pagination', '首段', { createdAt: at(10) });
  const middle = insertMessage(db, 'pagination', '中段', { createdAt: at(30) });
  const external = insertMessage(db, 'pagination', '业务卡片', { createdAt: at(35) });
  const next = insertMessage(db, 'pagination', '下一个用户输入', { createdAt: at(20) });
  insertMessage(db, 'other', '不属于目标会话', { createdAt: at(50) });
  for (const [id, index] of [[tail, 3], [first, 1], [middle, 2], [external, null]]) {
    db.prepare('UPDATE messages SET turn_run_id = ?, turn_item_index = ? WHERE id = ?').run('run', index, id);
  }
  db.prepare('INSERT INTO chat_timeline_run_anchors VALUES (?, ?, ?, ?)').run('pagination', 'run', first, at(10));
  const metadata = JSON.stringify({ type: 'shared_record', content: '大字段'.repeat(3000) });
  db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(metadata, user);

  async function readAll(order) {
    let cursor = null;
    let messages = [];
    do {
      const page = await repo.getMessages('pagination', { limit: 2, cursor, order });
      assert.ok(page.messages.length > 0 && page.messages.length <= 2);
      messages = order === 'DESC' ? [...page.messages, ...messages] : [...messages, ...page.messages];
      if (!page.hasMore) break;
      assert.notEqual(page.nextCursor, cursor, '每页必须推进 canonical 游标');
      cursor = page.nextCursor;
    } while (true);
    return messages;
  }

  for (const order of ['ASC', 'DESC']) {
    const messages = await readAll(order);
    assert.deepEqual(messages.map((message) => message.id), [user, first, middle, external, tail, next]);
    assert.equal(messages[0].text, '长正文'.repeat(2000));
    assert.equal(messages[0].metadataJson, metadata, '窗口不能裁剪正文或 metadata');
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(first);
  assert.deepEqual((await readAll('DESC')).map((message) => message.id), [user, middle, external, tail, next], '删除首段后仍按持久锚点排序');
  setVisibleBoundary(db, 'pagination', middle);
  assert.deepEqual((await readAll('DESC')).map((message) => message.id), [external, next], '首屏和分页遵守清历史边界');
  db.close();
}

console.log('verify-chat-visible-latest-message: all assertions passed');
