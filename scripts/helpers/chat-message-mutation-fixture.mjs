import { chatSharingDependencies } from './chat-sharing-fixture.mjs';
/** 消息改写与多选行为测试共用的源码装载与内存 SQLite 装配；每次创建独立数据库与事务队列。 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { chatReplyVersionSql, chatMessageMutations, installChatTimelineSchema } from '../chat-timeline-fixture.mjs';

const require = createRequire(import.meta.url);

/** 按仓库根相对路径装载源码；未声明的依赖直接报错，不静默降级为空对象。 */
export function load(relative, mocks = {}) {
  const output = ts.transpileModule(fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: relative,
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    throw new Error(`${relative} 未提供依赖 ${id}`);
  }, module, module.exports);
  return module.exports;
}

const messageDomain = 'src/features/chat/messages/domain/';

/**
 * 装配真实 MessageRepository / GroupChatRepository 跑在内存库上。
 * 事务队列随 fixture 私有，保证串行提交与回滚语义互不串扰。
 */
export function createChatMessageMutationFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, last_message TEXT, last_time TEXT,
      visible_after_message_id INTEGER, updated_at TEXT);
    CREATE TABLE group_chats (id TEXT PRIMARY KEY, last_message TEXT, last_time TEXT,
      last_message_id INTEGER, updated_at TEXT);
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
  `);
  installChatTimelineSchema(db);
  let chain = Promise.resolve();
  const executor = {
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    withExclusiveTransactionAsync(task) {
      const next = chain.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await task(executor);
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      chain = next.catch(() => {});
      return next;
    },
  };
  const persistence = { databaseCoordinator: { openTaskExecutor: () => executor } };
  const metadata = load(`${messageDomain}chatMessageMetadata.ts`, {
    './ChatSticker': load(`${messageDomain}ChatSticker.ts`),
    ...chatSharingDependencies,
  });
  const { MessageRepository } = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts', {
    '@platform/persistence': persistence,
    './ChatMessageMutationSql': chatMessageMutations,
    '../../reply/infrastructure/ChatReplyVersionSql': chatReplyVersionSql,
    './ChatTimelineSql': load('src/features/chat/messages/infrastructure/ChatTimelineSql.ts'),
    '../domain/MessageTimeSeparator': load(`${messageDomain}MessageTimeSeparator.ts`),
    '../domain/chatMessageMetadata': metadata,
  });
  const { GroupChatRepository } = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts', {
    '@platform/persistence': persistence, '@features/profile': {}, '@features/media': {}, '@features/assistants': {},
  });
  return {
    db,
    metadata,
    persistence,
    messages: new MessageRepository(),
    groups: new GroupChatRepository(),
  };
}
