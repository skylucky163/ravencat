import { chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';
import { chatReplyVersionSql, chatMessageMutations, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
/** 验证有限 SQLite 查询及 Host 消息同步，不读取用户数据库，也不锁定源码形状。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, visible_after_message_id INTEGER DEFAULT 0);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, text TEXT, sender_type TEXT,
    is_me INTEGER, is_read INTEGER DEFAULT 1, status TEXT DEFAULT 'sent', time TEXT,
    created_at TEXT, updated_at TEXT, metadata_json TEXT, agent_id TEXT,
    api_message_id TEXT, client_message_id TEXT, voice_played_at TEXT,
    show_time_separator_before INTEGER, reply_to_id INTEGER, reply_to_text TEXT,
    logical_message_id TEXT, segment_index INTEGER, segment_total INTEGER,
    delivery_status TEXT DEFAULT 'delivered', tokens_used INTEGER, prompt_tokens INTEGER,
    completion_tokens INTEGER, turn_run_id TEXT, turn_item_index INTEGER
  );
  INSERT INTO sessions (id) VALUES ('a'), ('b');
`);
installChatTimelineSchema(db);
const messagesRoot = 'src/features/chat/messages/';
const metadata = load(`${messagesRoot}domain/chatMessageMetadata.ts`, {
  ...chatSharingDependencies,
  './ChatSticker': load(`${messagesRoot}domain/ChatSticker.ts`),
});
const { MessageRepository } = load(`${messagesRoot}infrastructure/SQLiteMessageRepository.ts`, {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => ({
    getAllAsync: async (sql, params) => db.prepare(sql).all(...params),
    runAsync: async (sql, params) => db.prepare(sql).run(...params),
  }) } },
  './ChatMessageMutationSql': chatMessageMutations,
      '../../reply/infrastructure/ChatReplyVersionSql': chatReplyVersionSql,
      './ChatTimelineSql': load(`${messagesRoot}infrastructure/ChatTimelineSql.ts`),
  '../domain/MessageTimeSeparator': load(`${messagesRoot}domain/MessageTimeSeparator.ts`),
  '../domain/chatMessageMetadata': metadata,
});
const messages = new MessageRepository();
let pendingMessageIds = [];
const { listRecentChatPreviewMessages } = load(`${messagesRoot}application/ChatReadQueries.ts`, {
  './ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => ({ messages }) },
  '../../reply/delivery/AssistantMessageArrival': { getAssistantMessageArrivalSnapshot: () => ({ pendingMessageIds }) },
  '../domain/chatMessageMetadata': metadata,
});
const insert = (text, { session = 'a', sender = 'assistant', metadataJson = null, clientId = null } = {}) => Number(db.prepare(`
  INSERT INTO messages (session_id, text, sender_type, is_me, created_at, time, metadata_json, client_message_id, is_read)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(session, text, sender, Number(sender === 'user'), '2026-10-08T00:00:00.000Z', '00:00', metadataJson, clientId, Number(sender === 'user')).lastInsertRowid);

try {
  const ids = Array.from({ length: 100 }, (_, index) => insert(`消息 ${index}`));
  insert('不展示推理', { sender: 'reasoning' });
  insert('不展示工具', { sender: 'tool' });
  insert('不展示工具状态', { metadataJson: JSON.stringify({ type: 'toolStatus' }) });
  const waiting = insert('尚未到达');
  pendingMessageIds = [waiting];
  let preview = await listRecentChatPreviewMessages({ sessionId: 'a', limit: 6 });
  assert.deepEqual(preview.map((message) => message.messageId), ids.slice(-6));
  pendingMessageIds = [];
  preview = await listRecentChatPreviewMessages({ sessionId: 'a', limit: 6 });
  assert.equal(preview.at(-1).messageId, waiting);
  assert.equal(preview.length, 6);

  const listeners = {};
  const readEvents = [];
  const { markChatMessagesReadByIds } = load(`${messagesRoot}application/MarkChatMessagesReadByIds.ts`, {
    './ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => ({ messages }) },
    '../events/ChatEvents': { emitChatMessagesUpdated: (sessionId) => {
      readEvents.push(sessionId);
      listeners.chat('messagesUpdated', { sessionId });
    } },
  });
  const subscribe = (name) => (listener) => { listeners[name] = listener; return () => {}; };
  let host = { id: 'host-a', name: '主理 AI', isBlocked: false };
  let sessionId = 'a';
  let gate = null;
  const published = [];
  const coordinator = load('src/host/runtime/FloatingConversationProjection.ts', {
    '@features/assistants': {
      ...load('src/features/assistants/AssistantNickname.ts', { './infrastructure/SQLiteAssistantRepository': { aiAssistantRepository: {} } }),
      aiAssistantRepository: { getHostAI: async () => host },
      subscribeAIAssistantUpdated: subscribe('assistant'),
    },
    '@features/chat': {
      markChatMessagesReadByIds,
      getCanonicalChatConversation: async () => ({ id: sessionId, name: '会话' }),
      listRecentChatPreviewMessages: async (params) => {
        const result = await listRecentChatPreviewMessages(params);
        if (gate) { const waitingGate = gate; gate = null; await waitingGate; }
        return result;
      },
      subscribeAIMessageReceived: subscribe('received'),
      subscribeAssistantMessageArrival: subscribe('arrival'),
      subscribeToPublicChatSessionDeleted: subscribe('deleted'),
    },
    '@features/chat/composition': { setChatEventBus: (bus) => { listeners.chat = bus.emit; return () => {}; } },
    '@features/floatingLayer': {
      addConversationDisplayedListener: (listener) => { listeners.displayed = listener; return { remove() {} }; },
      addConversationRefreshListener: (listener) => { listeners.expand = listener; return { remove() {} }; },
      updateConversationPreview: async (projection) => { published.push(projection); },
      updateTargetPreview: async () => {},
    },
  });
  coordinator.configureFloatingConversationProjection();
  await coordinator.syncFloatingConversation();
  assert.equal(published.length, 0, '数据库未就绪不能读取或发布会话');
  coordinator.setFloatingConversationDatabaseReady(true);
  await coordinator.syncFloatingConversation();
  assert.equal(published.at(-1).messages.length, 6);

  // 缓存同步不等于阅读：只有原生回报的可见 ID 落库，重复回执不循环发刷新。
  const readCount = () => db.prepare('SELECT COUNT(*) AS total FROM messages WHERE is_me = 0 AND is_read = 1').get().total;
  assert.equal(readCount(), 0);
  const visibleIds = published.at(-1).messages.slice(-2).map((message) => String(message.messageId));
  listeners.displayed({ sessionId: 'a', messageIds: visibleIds });
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.syncFloatingConversation();
  assert.equal(readCount(), 2);
  assert.deepEqual(readEvents, ['a']);
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id = ?').get(ids[0]).is_read, 0);
  listeners.displayed({ sessionId: 'a', messageIds: visibleIds });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readCount(), 2);
  assert.deepEqual(readEvents, ['a']);

  const userId = insert('App 新消息', { sender: 'user', clientId: 'user-request' });
  listeners.chat('messagesUpdated', { sessionId: 'a' });
  await coordinator.syncFloatingConversation();
  assert.equal(published.at(-1).messages.at(-1).messageId, userId);
  assert.equal(published.at(-1).messages.at(-1).clientMessageId, 'user-request');
  db.prepare('UPDATE messages SET text = ? WHERE id = ?').run('App 改写', userId);
  listeners.chat('messagesPatched', { sessionId: 'a' });
  await coordinator.syncFloatingConversation();
  assert.equal(published.at(-1).messages.at(-1).text, 'App 改写');
  db.prepare('DELETE FROM messages WHERE id = ?').run(userId);
  listeners.chat('messagesDeleted', { sessionId: 'a', deletedMessageIds: [userId] });
  await coordinator.syncFloatingConversation();
  assert.ok(!published.at(-1).messages.some((message) => message.messageId === userId));

  // 读取途中到来的消息不能被旧结果覆盖，也不能建立无界刷新队列。
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  const inFlight = coordinator.syncFloatingConversation();
  await new Promise((resolve) => setImmediate(resolve));
  const newer = insert('读取期间提交的新消息');
  const beforeRace = published.length;
  for (let i = 0; i < 50; i++) listeners.received({ sessionId: 'a' });
  release();
  await inFlight;
  assert.equal(published.length, beforeRace + 1);
  assert.equal(published.at(-1).messages.at(-1).messageId, newer);

  const arriving = insert('后台分段到达');
  pendingMessageIds = [arriving];
  await coordinator.syncFloatingConversation();
  assert.ok(!published.at(-1).messages.some((message) => message.messageId === arriving));
  pendingMessageIds = [];
  listeners.arrival();
  await coordinator.syncFloatingConversation();
  assert.equal(published.at(-1).messages.at(-1).messageId, arriving);

  db.prepare('UPDATE sessions SET visible_after_message_id = ? WHERE id = ?').run(arriving, 'a');
  listeners.chat('messagesReloadRequested', { sessionId: 'a' });
  await coordinator.syncFloatingConversation();
  assert.deepEqual(published.at(-1).messages, []);
  sessionId = 'b';
  insert('另一会话', { session: 'b' });
  listeners.expand();
  await coordinator.syncFloatingConversation();
  assert.equal(published.at(-1).sessionId, 'b');
  assert.equal(published.at(-1).messages.length, 1);
  host = null;
  listeners.assistant();
  await coordinator.syncFloatingConversation();
  assert.deepEqual(published.at(-1), { sessionId: null, messages: [] });
  console.log('悬浮会话同步验证通过：有限查询、消息变更、精确已读、重复回执、分段到达、目标切换与并发刷新。');
} finally {
  db.close();
}
