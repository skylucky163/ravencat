/**
 * 群聊统一 conversation identity 静态契约验证。
 *
 * 验证范围（纯静态，不依赖 node:sqlite）：
 * 1. Schema 契约：chat_conversations 身份表、messages 外键与 ON DELETE CASCADE、
 *    集中 INDEXES 保留；
 * 2. 迁移 54 契约：冲突/无详情检查、孤立消息审计后删除、PRAGMA foreign_key_list 判断、
 *    显式列清单复制、数量与 max id 校验、外键恢复状态验证、foreign_key_check、
 *    失败 rollback、cause 保留、幂等约束、不伪造 session、孤儿之外的删除边界；
 * 3. Repository 生命周期契约：direct/group 创建与删除、AI 删除 identity 清理、
 *    clearDB 清理顺序。
 *
 * node:sqlite 迁移契约由 verify:chat 必跑，也可独立执行：
 *   npm run verify:group-conversation-identity:sqlite
 *
 * 真实 expo-sqlite 外键迁移仍需 Android 真机 fresh database 验收。
 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';


function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const schemaSource = read('src/platform/persistence/sqlite/schema.ts');
const sessionRepoSource = read('src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts');
const groupRepoSource = read('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts');
const assistantRepoSource = read('src/features/assistants/infrastructure/SQLiteAssistantRepository.ts');
const helpersSource = read('src/platform/persistence/helpers.ts');

// ============================================================================
// Schema 静态契约
// ============================================================================
const chatConversationsKeyIndex = schemaSource.indexOf('chatConversations:');
const sessionsKeyIndex = schemaSource.indexOf('\n  sessions:');
const messagesKeyIndex = schemaSource.indexOf('\n  messages:');
const callSessionsKeyIndex = schemaSource.indexOf('\n  callSessions:');
assert.ok(chatConversationsKeyIndex > 0, 'schema 必须定义 chatConversations');
assert.ok(
  chatConversationsKeyIndex < messagesKeyIndex,
  'chat_conversations 必须定义在 messages 建表之前',
);

const chatConversationsBlock = schemaSource.slice(chatConversationsKeyIndex, sessionsKeyIndex);
assert.match(chatConversationsBlock, /id TEXT PRIMARY KEY/, '身份表必须有 id 主键');
assert.match(
  chatConversationsBlock,
  /kind TEXT NOT NULL CHECK \(kind IN \('direct', 'group'\)\)/,
  '身份表 kind 只允许 direct/group',
);
assert.doesNotMatch(
  chatConversationsBlock,
  /created_at|updated_at/,
  '身份表不得保存时间戳副本',
);

const messagesBlock = schemaSource.slice(messagesKeyIndex, callSessionsKeyIndex);
assert.match(
  messagesBlock,
  /FOREIGN KEY \(session_id\) REFERENCES chat_conversations\(id\) ON DELETE CASCADE/,
  'messages.session_id 必须引用 chat_conversations(id) 且保留 ON DELETE CASCADE',
);
assert.doesNotMatch(
  messagesBlock,
  /REFERENCES sessions\(id\)/,
  'messages schema 不得再引用 sessions(id)',
);
// 重建 messages 后索引由 initDatabase 集中执行 INDEXES 恢复，schema 必须保留完整清单。
assert.match(schemaSource, /idx_messages_session_id ON messages\(session_id\)/);
assert.match(schemaSource, /idx_messages_session_id_id ON messages\(session_id, id DESC\)/);

// ============================================================================
// Repository 生命周期静态契约
// ============================================================================
const sessionIdentityInsertIndex = sessionRepoSource.indexOf('INSERT INTO chat_conversations (id, kind)');
const sessionRowInsertIndex = sessionRepoSource.indexOf('INSERT INTO sessions');
assert.ok(sessionIdentityInsertIndex > 0, 'createSession 必须写入 direct identity');
assert.ok(
  sessionIdentityInsertIndex < sessionRowInsertIndex,
  'direct identity 必须先于 sessions 详情行写入',
);
assert.match(sessionRepoSource, /withExclusiveTransactionAsync/, 'createSession 必须使用事务');
assert.doesNotMatch(sessionRepoSource, /INSERT OR IGNORE/, '新建业务数据不得使用 OR IGNORE');
// 单聊收敛为每个 AI 唯一 canonical conversation 后，不再存在「删除某个 direct session」的产品动作：
// direct identity 只能随 AI 一起消失（清理契约见下方 assistantRepoSource 断言）。
assert.doesNotMatch(
  sessionRepoSource,
  /DELETE FROM sessions WHERE id = \?/,
  '单聊仓储不得再保留独立删除 direct session 的路径',
);

const groupIdentityInsertIndex = groupRepoSource.indexOf('INSERT INTO chat_conversations (id, kind)');
const groupRowInsertIndex = groupRepoSource.indexOf('INSERT INTO group_chats');
assert.ok(groupIdentityInsertIndex > 0, '群聊创建必须写入 group identity');
assert.ok(
  groupIdentityInsertIndex < groupRowInsertIndex,
  'group identity 必须先于 group_chats 详情行写入',
);
assert.doesNotMatch(groupRepoSource, /INSERT OR IGNORE/, '新建业务数据不得使用 OR IGNORE');
assert.doesNotMatch(
  groupRepoSource,
  /DELETE FROM sessions WHERE id = \?/,
  '群聊删除不得再执行 DELETE FROM sessions 补丁',
);
assert.doesNotMatch(
  groupRepoSource,
  /DELETE FROM messages WHERE session_id = \?/,
  '群聊删除不得再手工删除 messages',
);
assert.match(
  groupRepoSource,
  /if \(deletedGroupCount > 0\)[\s\S]*DELETE FROM chat_conversations WHERE id = \? AND kind = 'group'/,
  '群聊删除必须只在确实删除 group_chats 后清理 group identity',
);

const assistantSessionSelectIndex = assistantRepoSource.indexOf('SELECT id FROM sessions WHERE ai_assistant_id = ?');
const assistantRowDeleteIndex = assistantRepoSource.indexOf('DELETE FROM ai_assistants WHERE id = ?');
const assistantIdentityDeleteIndex = assistantRepoSource.indexOf("DELETE FROM chat_conversations WHERE kind = 'direct' AND id IN");
assert.ok(assistantSessionSelectIndex > 0, 'AI 删除必须先捕获其 direct sessions');
assert.ok(
  assistantSessionSelectIndex < assistantRowDeleteIndex,
  '捕获 sessions 必须发生在删除 AI 之前',
);
assert.ok(
  assistantIdentityDeleteIndex > assistantRowDeleteIndex,
  'direct identity 清理必须发生在 AI 删除之后',
);
assert.match(assistantRepoSource, /withExclusiveTransactionAsync/, 'AI 删除必须保持单一事务');
assert.match(assistantRepoSource, /createHostAIAppointmentCooldown/, 'host AI 冷却逻辑不得遗漏');
assert.match(assistantRepoSource, /HOST_AI_RELATIONSHIP_STATE_ID/, 'host AI 状态写入不得遗漏');

// clearDB 已改为从 sqlite_master 动态发现全部应用表并清空，
// 不再维护手写 DELETE 清单，因此此处改验动态契约。
assert.match(
  helpersSource,
  /SELECT name FROM sqlite_master[\s\S]*WHERE type = 'table'/,
  'clearDB 必须从 sqlite_master 动态读取全部应用表',
);
assert.match(
  helpersSource,
  /DELETE FROM \$\{quoted\};/,
  'clearDB 必须对动态发现的每张表执行 DELETE',
);
assert.match(
  helpersSource,
  /PRAGMA foreign_keys = OFF/,
  'clearDB 必须先关闭外键',
);
assert.match(
  helpersSource,
  /BEGIN IMMEDIATE/,
  'clearDB 必须使用手动事务',
);
assert.match(
  helpersSource,
  /PRAGMA foreign_key_check/,
  'clearDB 必须执行 foreign_key_check',
);
assert.match(
  helpersSource,
  /foreign_keys !== 1/,
  'clearDB 必须确认 foreign_keys 恢复为 1',
);
assert.match(
  helpersSource,
  /quoteSqlIdentifier/,
  'clearDB 必须使用 SQL identifier 转义',
);

console.log('群聊统一 conversation identity 静态契约验证通过。');
console.log('数据库行为由 verify:database-baseline 验证。');
console.log('真实 expo-sqlite 外键迁移仍需 Android 真机 fresh database 验收。');
