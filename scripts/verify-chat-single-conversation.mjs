import { sharedChatRecordModuleUrl, sharedMomentModuleUrl } from './helpers/chat-sharing-fixture.mjs';
import { chatReplyVersionModuleUrl, chatMutationModuleUrl, chatTimelineModuleUrl, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
/** Chat Single-Conversation Foundation 的持久化与公开产品契约验证。 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-single-conversation-'));

function createExecutor(db) {
  const executor = {
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    withExclusiveTransactionAsync: async (operation) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation(executor);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return executor;
}

async function importSessionRepository(executor) {
  globalThis.__CHAT_CANONICAL_EXECUTOR__ = executor;
  const source = read('src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts').replaceAll("from '../../messages/infrastructure/ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`)
    .replace(
      /import \{ databaseCoordinator, type DatabaseTransactionExecutor \} from '@platform\/persistence';/,
      'const databaseCoordinator = { openTaskExecutor: () => globalThis.__CHAT_CANONICAL_EXECUTOR__ };',
    );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = path.join(tempDir, 'SQLiteSessionRepository.mjs');
  fs.writeFileSync(target, output, 'utf8');
  return import(pathToFileURL(target).href);
}

async function importMessageRepository(executor) {
  globalThis.__CHAT_MESSAGE_EXECUTOR__ = executor;
  const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText).toString('base64');
  const metadataUrl = moduleUrl(read('src/features/chat/messages/domain/chatMessageMetadata.ts').replaceAll("from './SharedMoment'", `from '${sharedMomentModuleUrl}'`)
    .replaceAll("from './ChatSticker'", `from '${moduleUrl(read('src/features/chat/messages/domain/ChatSticker.ts'))}'`)
    .replaceAll("from './SharedChatRecord'", `from '${sharedChatRecordModuleUrl}'`));
  const source = read('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts').replaceAll("from './ChatTimelineSql'", `from '${chatTimelineModuleUrl}'`).replaceAll("from './ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`).replaceAll("from '../../reply/infrastructure/ChatReplyVersionSql'", `from '${chatReplyVersionModuleUrl}'`)
    .replaceAll("from '../domain/chatMessageMetadata'", `from '${metadataUrl}'`)
    .replace(
      /import \{[\s\S]*?\} from '@platform\/persistence';/,
      'const databaseCoordinator = { openTaskExecutor: () => globalThis.__CHAT_MESSAGE_EXECUTOR__ };',
    )
    .replace(
      /import \{ shouldShowTimeSeparatorBefore \} from '\.\.\/domain\/MessageTimeSeparator';/,
      'const shouldShowTimeSeparatorBefore = () => false;',
    );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = path.join(tempDir, 'SQLiteMessageRepository.mjs');
  fs.writeFileSync(target, output, 'utf8');
  return import(pathToFileURL(target).href);
}

async function importCallRepository(executor) {
  globalThis.__CHAT_CALL_EXECUTOR__ = executor;
  for (const relativePath of ['domain/CallHistory', 'infrastructure/SQLiteCallHistoryRepository', 'infrastructure/SQLiteCallRepository']) {
    const source = read(`src/features/calls/${relativePath}.ts`)
      .replace(
        /import \{[\s\S]*?\} from '@platform\/persistence';/,
        'const databaseCoordinator = { openTaskExecutor: () => globalThis.__CHAT_CALL_EXECUTOR__ };',
      )
      .replaceAll("from '../domain/CallHistory'", "from './CallHistory.mjs'")
      .replace("from './SQLiteCallHistoryRepository'", "from './SQLiteCallHistoryRepository.mjs'");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    fs.writeFileSync(path.join(tempDir, `${path.basename(relativePath)}.mjs`), output, 'utf8');
  }
  const target = path.join(tempDir, 'SQLiteCallRepository.mjs');
  return import(pathToFileURL(target).href);
}

const db = new DatabaseSync(':memory:');
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, ai_assistant_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    last_message TEXT, last_time TEXT, is_active INTEGER DEFAULT 1,
    is_archived INTEGER DEFAULT 0, is_pinned INTEGER DEFAULT 0, tags TEXT,
    visible_after_message_id INTEGER, visible_after_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    agent_id TEXT, text TEXT NOT NULL, is_me INTEGER NOT NULL, sender_type TEXT NOT NULL,
    api_message_id TEXT, client_message_id TEXT, time TEXT NOT NULL, created_at TEXT NOT NULL,
    show_time_separator_before INTEGER, updated_at TEXT, reply_to_id INTEGER,
    reply_to_text TEXT, logical_message_id TEXT, segment_index INTEGER, segment_total INTEGER,
    delivery_status TEXT, status TEXT NOT NULL DEFAULT 'sent', tokens_used INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT, is_read INTEGER, voice_played_at TEXT, turn_run_id TEXT, turn_item_index INTEGER
  );
  -- 只保留 listContextEvents 读取的列；本用例不验证 call_events 的外键级联。
  CREATE TABLE call_events (
    id TEXT PRIMARY KEY, call_id TEXT NOT NULL, chat_session_id TEXT NOT NULL,
    kind TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, text TEXT,
    attachment_id TEXT, visible_in_chat INTEGER DEFAULT 0,
    include_in_ai_context INTEGER DEFAULT 1, payload_json TEXT, created_at TEXT NOT NULL
  );
`);
installChatTimelineSchema(db);
const executor = createExecutor(db);
const { SessionRepository } = await importSessionRepository(executor);
const sessions = new SessionRepository();

const first = await sessions.resolveCanonicalConversation('ai-a', new Date('2026-09-16T08:00:00.000Z'));
const repeated = await sessions.resolveCanonicalConversation('ai-a', new Date('2026-09-17T08:00:00.000Z'));
const secondAI = await sessions.resolveCanonicalConversation('ai-b', new Date('2026-09-16T08:00:01.000Z'));
assert.equal(first.id, repeated.id, '重复进入同一个 AI 必须复用 canonical conversation');
assert.notEqual(first.id, secondAI.id, '不同 AI 必须拥有不同 canonical conversation');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE ai_assistant_id = ?').get('ai-a').count, 1);
assert.throws(
  () => db.prepare(`INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at)
    VALUES ('alternate', 'ai-a', 'alternate', 'x', 'x')`).run(),
  /UNIQUE/,
);

const insertMessage = db.prepare(`INSERT INTO messages (
  session_id, text, is_me, sender_type, time, created_at
) VALUES (?, ?, ?, ?, ?, ?)`);
const insertCallAnchor = db.prepare(`INSERT INTO messages (
  session_id, client_message_id, text, is_me, sender_type, time, created_at, metadata_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insertCallEvent = db.prepare(`INSERT INTO call_events (
  id, call_id, chat_session_id, kind, actor_type, text, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`);

// clearConversationHistory 内部用真实 now 写 visible_after_at，
// 因此通话事件围绕清除时刻构造，前后各留 60s 余量保证方向确定。
const CLEAR_EPOCH_MS = Date.now();
const beforeClear = (offsetMs = 0) => new Date(CLEAR_EPOCH_MS - 60_000 + offsetMs).toISOString();
const afterClear = (offsetMs = 0) => new Date(CLEAR_EPOCH_MS + 60_000 + offsetMs).toISOString();

insertMessage.run(first.id, '旧用户消息', 1, 'user', '08:00', beforeClear(0));
insertMessage.run(first.id, '旧 AI 消息', 0, 'assistant', '08:01', beforeClear(1_000));
// call-same / call-old 都在清除前留下 callStatus 锚点：
// 旧实现按「锚点 message id <= boundary」整体隐藏 callId，会把同一通电话的后半段一起隐藏。
insertCallAnchor.run(
  first.id, 'call-status:call-same', '[通话]', 0, 'assistant', '08:01',
  beforeClear(2_000), JSON.stringify({ type: 'callStatus', callId: 'call-same' }),
);
insertCallAnchor.run(
  first.id, 'call-status:call-old', '[通话]', 0, 'assistant', '08:01',
  beforeClear(3_000), JSON.stringify({ type: 'callStatus', callId: 'call-old' }),
);
// 清除前产生的通话事件事实。
insertCallEvent.run('event-same-A', 'call-same', first.id, 'userSpeechText', 'user', 'same-A', beforeClear(4_000));
insertCallEvent.run('event-old-A', 'call-old', first.id, 'userSpeechText', 'user', 'old-A', beforeClear(5_000));
insertCallEvent.run('event-old-B', 'call-old', first.id, 'aiSpeechText', 'ai', 'old-B', beforeClear(6_000));

const oldMessageId = db.prepare('SELECT MIN(id) AS id FROM messages WHERE session_id = ?').get(first.id).id;
db.prepare('UPDATE sessions SET visible_after_message_id = ? WHERE id = ?').run(oldMessageId, first.id);
db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ attachments: [
  { mediaAssetId: 'history-main', thumbnailMediaAssetId: 'history-thumb' },
] }), oldMessageId);
insertMessage.run(secondAI.id, '另一个 AI 的消息', 1, 'user', '08:00', beforeClear());
db.prepare(`INSERT INTO chat_summary_segments
  (id, conversation_id, sequence, content, time_zone, created_at, updated_at)
  VALUES ('retained-summary', ?, 1, '保存的摘要', 'Asia/Shanghai', ?, ?)`)
  .run(first.id, beforeClear(), beforeClear());
db.prepare('INSERT INTO chat_summary_settings(conversation_id, fixed_message_id, enabled) VALUES (?, ?, 0)')
  .run(first.id, oldMessageId);
db.prepare(`INSERT INTO conversation_turn_runs
  (run_id, session_id, kind, reply_cursor_at_claim, input_high_watermark, revision_at_claim, status, created_at)
  VALUES ('cleared-run', ?, 'user_reply', 0, ?, 3, 'active', ?)`)
  .run(first.id, oldMessageId, beforeClear());
db.prepare(`INSERT INTO conversation_turn_state(session_id, active_run_id, active_run_kind, revision, updated_at)
  VALUES (?, 'cleared-run', 'user_reply', 3, ?)`)
  .run(first.id, beforeClear());
db.prepare(`INSERT INTO chat_turn_presentations(run_id, session_id, state, updated_at)
  VALUES ('cleared-run', ?, 'open', ?)`)
  .run(first.id, beforeClear());
db.prepare(`INSERT INTO chat_turn_display_items(run_id, identity, version, snapshot_json, shown_json)
  VALUES ('cleared-run', 'independent-prefix', 1, ?, ?)`)
  .run('{"text":"尚未 T3 的正文"}', '{"text":"尚未 T3 的正文"}');
db.prepare(`INSERT INTO chat_reply_version_sets(id, session_id, current_run_id, selected_version_id)
  VALUES ('cleared-versions', ?, 'cleared-run', 'cleared-version')`).run(first.id);
db.prepare(`INSERT INTO chat_reply_versions(id, set_id, created_at, snapshot_json)
  VALUES ('cleared-version', 'cleared-versions', ?, ?)`)
  .run(beforeClear(), JSON.stringify([{ text: '未采用的旧回复', metadata: { voice: { mediaAssetId: 'version-voice' } } }]));
const summariesBeforeClear = db.prepare('SELECT * FROM chat_summary_segments').all();

// 删除任一部分失败必须整笔回滚，不能留下已撤销 owner 却尚未清空的半份历史。
db.exec(`CREATE TRIGGER reject_history_clear BEFORE DELETE ON messages
  BEGIN SELECT RAISE(ABORT, 'injected clear failure'); END;`);
await assert.rejects(sessions.clearConversationHistory(first.id), /injected clear failure/);
assert.equal(db.prepare("SELECT status FROM conversation_turn_runs WHERE run_id = 'cleared-run'").get().status, 'active');
assert.equal(db.prepare('SELECT revision FROM conversation_turn_state WHERE session_id = ?').get(first.id).revision, 3);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_turn_display_items').get().count, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_reply_versions').get().count, 1);
db.exec('DROP TRIGGER reject_history_clear');

const assets = await sessions.clearConversationHistory(first.id);
assert.deepEqual(assets.sort(), ['history-main', 'history-thumb', 'version-voice'], '候选来自隐藏消息及重写存档的真实引用');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(first.id).count, 0, '清除物理删除全部消息，包括此前隐藏原文');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(secondAI.id).count, 1, '清除不影响其他 AI');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_turn_display_items').get().count, 0, '独立展示正文不能残留');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_reply_versions').get().count, 0, '重写版本不能残留');
assert.deepEqual(db.prepare('SELECT * FROM chat_summary_segments').all(), summariesBeforeClear, '摘要原样保留');
assert.equal(db.prepare('SELECT fixed_message_id FROM chat_summary_settings WHERE conversation_id = ?').get(first.id).fixed_message_id, null, '固定起点随原文删除取消');
assert.equal(db.prepare("SELECT status FROM conversation_turn_runs WHERE run_id = 'cleared-run'").get().status, 'cancelled');
const clearedState = db.prepare('SELECT * FROM conversation_turn_state WHERE session_id = ?').get(first.id);
assert.equal(clearedState.active_run_id, null);
assert.ok(clearedState.revision > 3, '清除撤销旧回合的提交 fence');
assert.deepEqual(await sessions.clearConversationHistory(first.id), [], '空会话重复清除幂等');
const reloadedSession = await sessions.getCanonicalConversation('ai-a');
assert.equal(reloadedSession.visibleAfterMessageId, null, '真正删除后不再保留消息隐藏边界');
assert.ok(reloadedSession.visibleAfterAt, 'reload 后通话上下文时间边界必须仍然存在');
assert.deepEqual(
  await sessions.clearConversationHistory(secondAI.id),
  [],
  '没有媒体引用时不产生释放候选',
);

const { MessageRepository } = await importMessageRepository(executor);
const messages = new MessageRepository();
assert.deepEqual((await messages.getMessages(first.id, { limit: 20, cursor: null })).messages, []);
const clearedStatistics = await messages.getChatRecordStatistics(first.id);
assert.ok(Object.values(clearedStatistics).every(value => value === 0), '清除后的原文条数、字数与 Token 统计均归零');
insertMessage.run(first.id, '清除后的新消息', 1, 'user', '08:02', afterClear(0));
assert.deepEqual(
  (await messages.getMessages(first.id, { limit: 20, cursor: null })).messages.map((message) => message.text),
  ['清除后的新消息'],
);

// 清除之后产生 / 追加的通话事件：同一通跨 boundary 的电话后半段必须仍然可见。
insertCallEvent.run('event-same-B', 'call-same', first.id, 'aiSpeechText', 'ai', 'same-B', afterClear(0));
insertCallEvent.run('event-new-A', 'call-new', first.id, 'userSpeechText', 'user', 'new-A', afterClear(1_000));
insertCallEvent.run('event-new-B', 'call-new', first.id, 'aiSpeechText', 'ai', 'new-B', afterClear(2_000));
// 清除后才开始的通话，锚点落在 boundary 之后。
insertCallAnchor.run(
  first.id, 'call-status:call-new', '[通话]', 0, 'assistant', '08:04',
  afterClear(3_000), JSON.stringify({ type: 'callStatus', callId: 'call-new' }),
);

const { SQLiteCallRepository } = await importCallRepository(executor);
const calls = new SQLiteCallRepository();
const contextEvents = await calls.listContextEvents({ chatSessionId: first.id, limit: 100 });
assert.deepEqual(
  contextEvents.map((event) => event.text),
  ['same-B', 'new-A', 'new-B'],
  'Call context 边界必须落在事件上：清除前的事件隐藏，同一通电话清除后的事件仍然可见',
);
assert.equal(
  contextEvents.some((event) => event.callId === 'call-old'),
  false,
  '整通发生在清除前的电话必须整体隐藏',
);
assert.equal(
  contextEvents.some((event) => event.text === 'same-A'),
  false,
  '同一通电话在清除前产生的事件不得进入 Prompt',
);

db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('group-1', 'group')`).run();
insertMessage.run('group-1', '群消息', 1, 'user', '08:03', afterClear(4_000));
assert.deepEqual(
  (await messages.getMessages('group-1', { limit: 20, cursor: null })).messages.map((message) => message.text),
  ['群消息'],
  'direct history boundary 不得影响 group chat',
);
// group conversation 没有 sessions 行，因此不存在单聊历史边界：通话上下文全部可见。
insertCallEvent.run('event-group-A', 'call-group', 'group-1', 'userSpeechText', 'user', 'group-A', beforeClear(7_000));
insertCallEvent.run('event-group-B', 'call-group', 'group-1', 'aiSpeechText', 'ai', 'group-B', afterClear(5_000));
assert.deepEqual(
  (await calls.listContextEvents({ chatSessionId: 'group-1', limit: 100 })).map((event) => event.text),
  ['group-A', 'group-B'],
  'group conversation 不得被单聊历史边界过滤通话上下文',
);

const promptHistorySource = read('src/host/prompt/PromptHistoryBuilder.ts');
assert.match(promptHistorySource, /openConversationTimeline\(\{ sessionId, limit \}\)/, 'Prompt History 必须复用 boundary-aware timeline query');
assert.doesNotMatch(
  promptHistorySource,
  /listCallContextCallIdsBeforeHistoryBoundary|hiddenCallIds/,
  '不得再以 callId 作为最小历史清除单位：边界必须落在 CallEvent 自己身上',
);
const callRepositorySource = read('src/features/calls/infrastructure/SQLiteCallRepository.ts');
assert.match(
  callRepositorySource,
  /visible_after_at/,
  'Call context 必须按事件时刻尊重历史清除边界',
);
assert.equal(fs.existsSync(path.join(ROOT, 'src/app/chat/[aiId]/sessions.tsx')), false);
// Git 不跟踪空目录：fresh clone 里 ChatHistory 目录可能根本不存在，
// 所以契约是「目录不存在，或存在但没有 production implementation」，
// 而不是「目录必须存在且为空」。
const chatHistoryDir = path.join(
  ROOT,
  'src/features/chat/presentation/conversation/ChatHistory',
);
const chatHistoryEntries = fs.existsSync(chatHistoryDir) ? fs.readdirSync(chatHistoryDir) : [];
assert.deepEqual(
  chatHistoryEntries,
  [],
  '历史 session 浏览实现必须全部退役（ChatHistory 不得保留 production implementation）',
);
const presentationSource = [
  read('src/features/chat/presentation/conversation/AIOptions.tsx'),
  read('src/features/chat/presentation/messages/components/ChatHeader.tsx'),
  read('src/features/chat/presentation/shell/ChatRouteScreens.tsx'),
].join('\n');
assert.match(presentationSource, /清除聊天记录/);
assert.doesNotMatch(presentationSource, /历史会话|onCreateNewChat|isCreatingNewChat/);

db.close();
delete globalThis.__CHAT_CANONICAL_EXECUTOR__;
delete globalThis.__CHAT_MESSAGE_EXECUTOR__;
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('Chat Single-Conversation Foundation 验证通过');
