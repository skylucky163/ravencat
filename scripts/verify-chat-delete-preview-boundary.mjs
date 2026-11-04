import { sharedChatRecordModuleUrl, sharedMomentModuleUrl } from './helpers/chat-sharing-fixture.mjs';
import { chatReplyVersionModuleUrl, chatMutationModuleUrl, chatTimelineModuleUrl, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
/**
 * deleteChatMessage application-level 的删除编排回归测试。
 *
 * 覆盖两类已修复 bug：
 *
 * 1. clear-history preview resurrection：clear history 只是隐藏（visible_after_message_id），
 *    删除 clear 后的新消息后，preview 重算绝不允许把 clear 前消息重新写回
 *    sessions.last_message / group_chats.last_message。
 * 2. 删除瞬间的媒体引用候选：最终 mediaAssetCandidates 必须来自 delete transaction 里
 *    重新读取的当前 message rows，而不是 application 最开始读到的 target snapshot。
 *    本脚本让真实迁移事务先进入队列、删除随后进入，验证 canonical 引用仍进入候选集。
 * 3. 删除与新消息提交交错：最新消息读取后另一个提交开始排队，最终 preview 不得回退。
 * 4. 关联消息查询失败：删除事务回滚，不留下正文、推理和 preview 的部分更新。
 *
 * 与 verify-chat-visible-latest-message.mjs 的区别：
 *   本脚本走真实 application 入口 deleteChatMessage()，覆盖完整编排链路
 *   删除、关联消息裁决与 preview 修复共用事实事务，媒体释放留在 commit 后，
 *   并直接断言落库后的 preview 最终状态，而不是 repository 返回值或源码正则。
 *
 * 与 verify-media-asset-reference-closure.mjs 的分工：
 *   本脚本用真实 SQLite + 真实 MessageRepository + 真实 application，release 只记录调用；
 *   「候选被真正裁决后 catalog / backing 是否留下 orphan」属于 Media lifecycle 的职责，
 *   在那边用真实 lifecycle 验证。
 *
 * 装配方式：
 *   - node:sqlite 内存库承载真实 sessions / group_chats / messages / media_assets schema；
 *   - 转译真实 DeleteChatMessage / SQLiteMessageRepository / chatMessageMetadata，
 *     仅替换环境依赖（databaseCoordinator、ChatMessageRuntime 依赖槽）；
 *   - executor 提供与生产 DatabaseCoordinator 等价的单写者 exclusive transaction；
 *   - Group Repository 使用传入事务执行 preview SQL；不再注入事务外的旧写端口。
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

function transpileSource(relativePath) {
  return ts.transpileModule(read(relativePath).replaceAll("from './ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`).replaceAll("from '../../reply/infrastructure/ChatReplyVersionSql'", `from '${chatReplyVersionModuleUrl}'`), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

// ============================================================================
// 环境 stub（全部惰性读取 globalThis.__DELETE_PREVIEW_ENV__，规避 data URL 模块缓存）
// ============================================================================
const persistenceStubUrl = transpileToModuleUrl(
  `export const databaseCoordinator = {
     openTaskExecutor: (...args) => globalThis.__DELETE_PREVIEW_ENV__.executor,
     transaction: (_meta, operation) => globalThis.__DELETE_PREVIEW_ENV__.executor.withExclusiveTransactionAsync(operation),
   };
   export const __persistenceStub = true;`,
);
const chatMessageRuntimeStubUrl = transpileToModuleUrl(
  `export function getChatMessageRuntimeDependencies() {
     return globalThis.__DELETE_PREVIEW_ENV__.runtime;
   }`,
);
const groupRuntimeStubUrl = transpileToModuleUrl(
  `export function getChatGroupRuntimeDependencies() {
    return { groups: globalThis.__DELETE_PREVIEW_ENV__.groups };
  }`,
);
const mediaStubUrl = transpileToModuleUrl(
  `export async function releaseMediaAssetCandidates(assetIds) {
     globalThis.__DELETE_PREVIEW_ENV__.mediaReleaseCalls.push([...assetIds]);
   }`,
);

const timeSeparatorUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/MessageTimeSeparator.ts'),
);
const chatStickerUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/ChatSticker.ts'),
);
const sharedChatRecordUrl = sharedChatRecordModuleUrl;

const chatMessageMetadataSource = transpileSource(
  'src/features/chat/messages/domain/chatMessageMetadata.ts',
).replaceAll(
  `from './ChatSticker'`,
  `from '${chatStickerUrl}'`,
).replaceAll(`from './SharedChatRecord'`, `from '${sharedChatRecordUrl}'`).replaceAll(`from './SharedMoment'`, `from '${sharedMomentModuleUrl}'`);
const chatMessageMetadataUrl = `data:text/javascript;base64,${Buffer.from(chatMessageMetadataSource).toString('base64')}`;
const chatEventsUrl = transpileToModuleUrl(read('src/features/chat/messages/events/ChatEvents.ts'));

const messageRepositorySource = transpileSource(
  'src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts',
).replaceAll("from './ChatTimelineSql'", `from '${chatTimelineModuleUrl}'`).replaceAll("from './ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`).replaceAll("from '../../reply/infrastructure/ChatReplyVersionSql'", `from '${chatReplyVersionModuleUrl}'`).replaceAll(
  `from '@platform/persistence'`,
  `from '${persistenceStubUrl}'`,
).replaceAll(
  `from '../domain/MessageTimeSeparator'`,
  `from '${timeSeparatorUrl}'`,
).replaceAll(
  `from '../domain/chatMessageMetadata'`,
  `from '${chatMessageMetadataUrl}'`,
);
const messageRepositoryUrl = `data:text/javascript;base64,${Buffer.from(messageRepositorySource).toString('base64')}`;

const deleteChatMessageSource = transpileSource(
  'src/features/chat/messages/application/DeleteChatMessage.ts',
).replaceAll(`from '@platform/persistence'`, `from '${persistenceStubUrl}'`)
 .replaceAll(`from '../../group/application/ChatGroupRuntime'`, `from '${groupRuntimeStubUrl}'`)
 .replaceAll(
  `from './ChatMessageRuntime'`,
  `from '${chatMessageRuntimeStubUrl}'`,
).replaceAll(
  `from '../domain/chatMessageMetadata'`,
  `from '${chatMessageMetadataUrl}'`,
).replaceAll(
  `from '@features/media'`,
  `from '${mediaStubUrl}'`,
).replaceAll(
  `from '../events/ChatEvents'`,
  `from '${chatEventsUrl}'`,
);
const deleteChatMessageUrl = `data:text/javascript;base64,${Buffer.from(deleteChatMessageSource).toString('base64')}`;

// ============================================================================
// 内存数据库与运行时环境
// ============================================================================
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
    CREATE TABLE group_chats (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      avatar_media_asset_id TEXT,
      last_message TEXT,
      last_time TEXT,
      last_message_id INTEGER,
      is_pinned INTEGER DEFAULT 0,
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
    -- 只为让真实 SQLiteMessageRepository 的引用写入守卫（mediaAssetId 存在性）
    -- 能在这个库里运行；本脚本不做 Media lifecycle 裁决。
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY
    );
  `);
  db.exec(`CREATE TRIGGER fixture_conversation AFTER INSERT ON sessions BEGIN INSERT INTO chat_conversations VALUES (NEW.id, 'private'); END;`);
  installChatTimelineSchema(db);
  return db;
}

function createEnv(db) {
  const groupPreviewCalls = [];
  let writeChain = Promise.resolve();
  const rawExecutor = {
    getFirstAsync: async (sql, params = []) => {
      const rows = db.prepare(sql).all(...params);
      env.onRead?.(rows[0]);
      return rows.length > 0 ? rows[0] : null;
    },
    getAllAsync: async (sql, params = []) => {
      if (env.readFailure) { const error = env.readFailure; env.readFailure = null; throw error; }
      return db.prepare(sql).all(...params);
    },
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    // 与生产 DatabaseCoordinator 等价的单写者调度：任何 transaction 都不会与另一个
    // transaction 交错，因此「删除事务读到的事实」就是它真正删除的事实。
    withExclusiveTransactionAsync(task) {
      const run = writeChain.then(async () => {
        db.exec('BEGIN IMMEDIATE;');
        try {
          const value = await task(rawExecutor);
          db.exec('COMMIT;');
          return value;
        } catch (error) {
          db.exec('ROLLBACK;');
          throw error;
        }
      });
      writeChain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  const schedule = (operation) => {
    const next = writeChain.then(operation);
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  };
  const executor = {
    getFirstAsync: (...args) => schedule(() => rawExecutor.getFirstAsync(...args)),
    getAllAsync: (...args) => schedule(() => rawExecutor.getAllAsync(...args)),
    runAsync: (...args) => schedule(() => rawExecutor.runAsync(...args)),
    withExclusiveTransactionAsync: rawExecutor.withExclusiveTransactionAsync,
  };
  const env = { db, executor, groupPreviewCalls, mediaReleaseCalls: [], runtime: null };
  env.runtime = {
    messages: null, // 每个用例绑定该库对应的真实仓储实例（见 runCase）
  };
  env.groups = {
      async updatePreviewInTransaction(transaction, groupId, lastMessageId, lastMessage, lastTime) {
        groupPreviewCalls.push({ groupId, lastMessage, lastTime, lastMessageId });
        await transaction.runAsync('UPDATE group_chats SET last_message = ?, last_time = ?, last_message_id = ? WHERE id = ?',
          [lastMessage, lastTime, lastMessageId, groupId]);
      },
  };
  return env;
}

// 生产模块本身无内部可变状态，只需装配一次；环境通过 globalThis 按用例切换。
const messageRepositoryModule = await import(messageRepositoryUrl);
const { deleteChatMessage } = await import(deleteChatMessageUrl);
const { setChatEventBus } = await import(chatEventsUrl);

async function runCase(fn) {
  const db = createDatabase();
  const env = createEnv(db);
  globalThis.__DELETE_PREVIEW_ENV__ = env;
  env.runtime.messages = new messageRepositoryModule.MessageRepository();
  env.events = [];
  const unsubscribe = setChatEventBus({ emit: (name, payload) => {
    env.events.push({ name, ...payload });
  } });
  try {
    await fn(env);
  } finally {
    unsubscribe();
  }
}

// ============================================================================
// fixture helpers
// ============================================================================
function insertUserMessage(db, sessionId, text) {
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO messages (
      session_id, agent_id, client_message_id, text, is_me, sender_type, api_message_id,
      time, created_at, show_time_separator_before, updated_at, reply_to_id, reply_to_text,
      logical_message_id, segment_index, segment_total, delivery_status, status,
      tokens_used, prompt_tokens, completion_tokens, metadata_json, is_read,
      voice_played_at, turn_run_id, turn_item_index
    ) VALUES (?, NULL, NULL, ?, 1, 'user', NULL, ?, ?, 0, ?, NULL, NULL, NULL, 0, 1,
              'delivered', 'sent', 0, 0, 0, NULL, 1, NULL, NULL, NULL)
  `).run(sessionId, text, createdAt, createdAt, createdAt);
  return Number(result.lastInsertRowid);
}

/**
 * 插入一条 assistant / reasoning 段。
 *
 * metadataJson 用于验证「primitive 对输入的所有 id 一视同仁地读取当前 metadata」这条契约：
 * reasoning 当前不会生成媒体引用，但删除原语不得假设这一点。
 */
function insertAssistantSegment(db, sessionId, {
  logicalMessageId,
  segmentIndex,
  senderType = 'assistant',
  text = '',
  metadataJson = null,
}) {
  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO messages (
      session_id, agent_id, client_message_id, text, is_me, sender_type, api_message_id,
      time, created_at, show_time_separator_before, updated_at, reply_to_id, reply_to_text,
      logical_message_id, segment_index, segment_total, delivery_status, status,
      tokens_used, prompt_tokens, completion_tokens, metadata_json, is_read,
      voice_played_at, turn_run_id, turn_item_index
    ) VALUES (?, NULL, NULL, ?, 0, ?, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?, 2,
              'delivered', 'sent', 0, 0, 0, ?, 0, NULL, NULL, NULL)
  `).run(
    sessionId,
    text,
    senderType,
    createdAt,
    createdAt,
    createdAt,
    logicalMessageId,
    segmentIndex,
    metadataJson,
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

function insertGroup(db, groupId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO group_chats (
      id, name, avatar, avatar_media_asset_id, last_message, last_time, last_message_id,
      is_pinned, created_at, updated_at
    ) VALUES (?, '群聊', NULL, NULL, '', ?, NULL, 0, ?, ?)
  `).run(groupId, now, now, now);
}

/** 模拟 clear history：推进可见边界并清空 preview（与 clearConversationHistory 相同的效果）。 */
function clearHistory(db, sessionId) {
  const latest = db.prepare(
    'SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1',
  ).get(sessionId);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE sessions
     SET visible_after_message_id = ?, visible_after_at = ?, last_message = '', updated_at = ?
     WHERE id = ?`,
  ).run(latest?.id ?? null, now, now, sessionId);
}

/** 模拟消息提交时写入的 preview 状态（last_message 与排序时间一起写）。 */
function setSessionPreview(db, sessionId, previewText, lastTime) {
  db.prepare('UPDATE sessions SET last_message = ?, last_time = ? WHERE id = ?')
    .run(previewText, lastTime ?? null, sessionId);
}

function setGroupPreview(db, groupId, previewText, messageId, lastTime) {
  db.prepare(`UPDATE group_chats
              SET last_message = ?, last_message_id = ?, last_time = ?
              WHERE id = ?`)
    .run(previewText, messageId, lastTime ?? null, groupId);
}

function getSessionPreview(db, sessionId) {
  return db.prepare('SELECT last_message FROM sessions WHERE id = ?').get(sessionId)?.last_message;
}

/** 会话列表排序时间：null 表示当前可见时间线没有消息。 */
function getSessionPreviewTime(db, sessionId) {
  return db.prepare('SELECT last_time FROM sessions WHERE id = ?').get(sessionId)?.last_time;
}

function getMessageCreatedAt(db, messageId) {
  return db.prepare('SELECT created_at FROM messages WHERE id = ?').get(messageId).created_at;
}

function getGroupPreview(db, groupId) {
  return db.prepare('SELECT last_message, last_message_id, last_time FROM group_chats WHERE id = ?').get(groupId);
}

function countMessages(db, sessionId) {
  return db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(sessionId).count;
}

// ============================================================================
// Case 1：核心 resurrection 回归
// A, B → clear(boundary=B) → 发 C（preview=C）→ deleteChatMessage(C)
// 期望 sessions.last_message 被清空，而不是复活成 B；A/B 底层保留。
// ============================================================================
await runCase(async ({ db, runtime }) => {
  const sessionId = 'session_case1';
  insertSession(db, sessionId);
  insertUserMessage(db, sessionId, 'A');
  const bId = insertUserMessage(db, sessionId, 'B');
  clearHistory(db, sessionId);
  assert.equal(
    db.prepare('SELECT visible_after_message_id AS b FROM sessions WHERE id = ?').get(sessionId).b,
    bId,
    'fixture：clear 后 boundary 应为 B.id',
  );
  const cId = insertUserMessage(db, sessionId, 'C');
  setSessionPreview(db, sessionId, 'C', new Date().toISOString());

  const deletedIds = await deleteChatMessage(cId);
  assert.deepEqual(deletedIds, [cId], 'deleteChatMessage 应返回被删除的消息 id');

  const preview = getSessionPreview(db, sessionId);
  assert.notEqual(preview, 'B', 'preview 绝不允许复活 clear 前的 B');
  assert.equal(preview, '', '删除 clear 后唯一新消息后，sessions.last_message 必须为空');
  assert.equal(
    getSessionPreviewTime(db, sessionId),
    null,
    '可见时间线为空时排序时间必须为 NULL：不得制造一次并不存在的「刚刚活动」',
  );

  assert.equal(countMessages(db, sessionId), 2, 'clear + 删除不得真正删除底层消息 A/B');
  assert.equal(
    (await runtime.messages.getLatestVisibleMessage(sessionId)),
    null,
    '当前 visible history 应为空',
  );
  const visiblePage = await runtime.messages.getMessages(sessionId, { limit: 20 });
  assert.equal(visiblePage.messages.length, 0, '当前可见聊天 UI 不得重新暴露 A/B');
});

// ============================================================================
// Case 2：clear 后多条新消息
// A, B → clear → C, D（preview=D）→ deleteChatMessage(D)
// 期望 preview 回退到 C，而不是 clear 前的 B。
// ============================================================================
await runCase(async ({ db }) => {
  const sessionId = 'session_case2';
  insertSession(db, sessionId);
  insertUserMessage(db, sessionId, 'A');
  insertUserMessage(db, sessionId, 'B');
  clearHistory(db, sessionId);
  const cId = insertUserMessage(db, sessionId, 'C');
  const dId = insertUserMessage(db, sessionId, 'D');
  setSessionPreview(db, sessionId, 'D', new Date().toISOString());

  await deleteChatMessage(dId);

  assert.equal(
    getSessionPreview(db, sessionId),
    'C',
    '删除 D 后 preview 应回退到可见的 C，而不是 clear 前的 B',
  );
  assert.equal(
    getSessionPreviewTime(db, sessionId),
    getMessageCreatedAt(db, cId),
    '删除最新消息后排序时间必须退到新的 visible latest',
  );
});

// ============================================================================
// Case 3：未 clear 的普通删除行为
// A, B（preview=B）→ deleteChatMessage(B)
// 期望 preview 正常回退到 A，证明本修复没有破坏普通 delete fallback。
// ============================================================================
await runCase(async ({ db }) => {
  const sessionId = 'session_case3';
  insertSession(db, sessionId);
  const aId = insertUserMessage(db, sessionId, 'A');
  const bId = insertUserMessage(db, sessionId, 'B');
  setSessionPreview(db, sessionId, 'B', new Date().toISOString());

  await deleteChatMessage(bId);

  assert.equal(getSessionPreview(db, sessionId), 'A', '未 clear 时删除 B 后 preview 应回退到 A');
  assert.equal(
    getSessionPreviewTime(db, sessionId),
    getMessageCreatedAt(db, aId),
    '删除最新消息后排序时间必须退到 A，不得保留 B 的时间',
  );
});

// ============================================================================
// Case 4：group compatibility
// 群聊 X, Y（group preview=Y）→ deleteChatMessage(Y)
// 期望 group preview 回退到 X，direct 的 visible boundary 逻辑不得破坏群聊。
// ============================================================================
await runCase(async ({ db, groupPreviewCalls }) => {
  const groupId = 'group_case4';
  insertGroup(db, groupId);
  const xId = insertUserMessage(db, groupId, 'X');
  const yId = insertUserMessage(db, groupId, 'Y');
  setGroupPreview(db, groupId, 'Y', yId, new Date().toISOString());

  await deleteChatMessage(yId);

  const preview = getGroupPreview(db, groupId);
  assert.equal(preview.last_message, 'X', '群聊删除 Y 后 preview 应回退到 X');
  assert.equal(preview.last_message_id, xId, '群聊 preview 身份应绑定到 X');
  assert.equal(
    preview.last_time,
    getMessageCreatedAt(db, xId),
    '群聊删除最新消息后排序时间必须退到 X',
  );
  assert.equal(countMessages(db, groupId), 1, '群聊底层只应删除 Y');
  assert.ok(
    groupPreviewCalls.some((call) => call.groupId === groupId && call.lastMessage === 'X'),
    'groupPreview.updatePreview 必须被真实调用并写入 X',
  );
});

// ============================================================================
// Case 5：删除消息的媒体释放候选
// 纯文本消息没有任何媒体引用：不得产生候选（调用方因此不会触发任何媒体裁决）；
// 媒体消息必须把旧 metadata 里的 asset id 全部交给 targeted release。
// ============================================================================
await runCase(async ({ db, mediaReleaseCalls }) => {
  const sessionId = 'session_case5';
  insertSession(db, sessionId);

  const textId = insertUserMessage(db, sessionId, '纯文本');
  await deleteChatMessage(textId);
  assert.deepEqual(
    mediaReleaseCalls.at(-1),
    [],
    '纯文本消息删除不得产生任何媒体候选（也就不会触发媒体裁决）',
  );

  const mediaId = insertUserMessage(db, sessionId, '[图片]');
  db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(
    JSON.stringify({
      kind: 'image',
      attachments: [{ mediaAssetId: 'asset-main', thumbnailMediaAssetId: 'asset-thumb' }],
      voice: { mediaAssetId: 'asset-voice' },
      sticker: { mediaAssetId: 'asset-sticker' },
    }),
    mediaId,
  );
  await deleteChatMessage(mediaId);
  assert.deepEqual(
    [...mediaReleaseCalls.at(-1)].sort(),
    ['asset-main', 'asset-sticker', 'asset-thumb', 'asset-voice'],
    '删除媒体消息必须把四类媒体引用都作为候选交给 targeted release',
  );
});

// ============================================================================
// Case 6：迁移事务先排队、删除随后发起。候选必须来自最终删除的 canonical 引用，
// 不依赖 application 是否曾在事务外读取 target。反向顺序与共享引用由 Media 验证覆盖。
// ============================================================================
await runCase(async ({ db, executor, runtime, mediaReleaseCalls }) => {
  const sessionId = 'session_case6';
  insertSession(db, sessionId);
  const messageId = insertUserMessage(db, sessionId, '[图片]');
  db.prepare('UPDATE messages SET metadata_json = ? WHERE id = ?').run(
    JSON.stringify({
      kind: 'image',
      attachments: [{ id: 'att-1', type: 'image', source: 'gallery', localUri: 'file:///legacy/a.png' }],
    }),
    messageId,
  );

  const realRepository = runtime.messages;
  const target = await realRepository.getMessageById(messageId);
  const migration = executor.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('INSERT INTO media_assets (id) VALUES (?)', ['legacy-adopted']);
    await realRepository.compareAndSwapMetadataJsonInTransaction(transaction, {
      messageId,
      expectedMetadataJson: target.metadataJson,
      metadataJson: JSON.stringify({ kind: 'image', attachments: [{ id: 'att-1', type: 'image', source: 'gallery', mediaAssetId: 'legacy-adopted' }] }),
    });
  });

  const deletedIds = await deleteChatMessage(messageId);

  await migration;
  assert.deepEqual(deletedIds, [messageId], 'deleteChatMessage 应返回真实删除的消息 id');
  assert.equal(
    db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId),
    undefined,
    'message 必须被删除',
  );
  assert.deepEqual(
    mediaReleaseCalls.at(-1),
    ['legacy-adopted'],
    '候选必须来自 DELETE 事务里的当前 metadata，而不是 application 读到的旧 target snapshot',
  );
});

// ============================================================================
// Case 7：reasoning 联删的候选与删除幂等
// - 删除最后一段正文时连带删除 reasoning，两条消息当前 metadata 的引用都必须进入候选
//   （删除原语对所有输入 id 一视同仁，不假设 reasoning 永远没有媒体引用）；
// - 非最后一段正文不得误删 reasoning；
// - 已不存在的 id 返回空，且不得触发任何媒体裁决（幂等）。
// ============================================================================
await runCase(async ({ db, mediaReleaseCalls, events }) => {
  const sessionId = 'session_case7';
  insertSession(db, sessionId);
  const reasoningId = insertAssistantSegment(db, sessionId, {
    logicalMessageId: 'logical-case7',
    segmentIndex: 0,
    senderType: 'reasoning',
    metadataJson: JSON.stringify({ attachments: [{ mediaAssetId: 'asset-reasoning' }] }),
  });
  const segment0 = insertAssistantSegment(db, sessionId, {
    logicalMessageId: 'logical-case7',
    segmentIndex: 1,
    text: '第一段',
    metadataJson: JSON.stringify({ attachments: [{ mediaAssetId: 'asset-seg0' }] }),
  });
  const segment1 = insertAssistantSegment(db, sessionId, {
    logicalMessageId: 'logical-case7',
    segmentIndex: 2,
    text: '第二段',
    metadataJson: JSON.stringify({ attachments: [{ mediaAssetId: 'asset-seg1' }] }),
  });

  const firstDeleted = await deleteChatMessage(segment0);
  assert.deepEqual(firstDeleted, [segment0], '非最后一段正文只删除自身');
  assert.deepEqual(
    mediaReleaseCalls.at(-1),
    ['asset-seg0'],
    '只删除自身时候选只应包含该段的媒体引用',
  );
  assert.equal(
    db.prepare('SELECT id FROM messages WHERE id = ?').get(reasoningId).id,
    reasoningId,
    '非最后一段正文不得误删 reasoning',
  );
  assert.equal(
    db.prepare('SELECT id FROM messages WHERE id = ?').get(segment1).id,
    segment1,
    '其它正文段不得被误删',
  );

  const secondDeleted = await deleteChatMessage(segment1);
  assert.deepEqual(
    [...secondDeleted].sort(),
    [reasoningId, segment1].sort(),
    '删除最后一段正文必须连带删除 reasoning',
  );
  assert.deepEqual(events, [
    { name: 'turnExecutionChanged', sessionId },
    { name: 'messagesDeleted', sessionId, deletedMessageIds: firstDeleted },
    { name: 'turnExecutionChanged', sessionId },
    { name: 'messagesDeleted', sessionId, deletedMessageIds: secondDeleted },
  ], '单条及推理联删发布精确删除事实，不请求重载');
  assert.deepEqual(
    [...mediaReleaseCalls.at(-1)].sort(),
    ['asset-reasoning', 'asset-seg1'],
    'reasoning 与被删段落的当前 metadata 引用都必须进入候选',
  );
  assert.equal(
    countMessages(db, sessionId),
    0,
    '最后一段正文与 reasoning 必须都被删除',
  );

  const releaseCallsBefore = mediaReleaseCalls.length;
  assert.deepEqual(
    await deleteChatMessage(segment1),
    [],
    '已经不存在的 message id 必须幂等返回空',
  );
  assert.equal(
    mediaReleaseCalls.length,
    releaseCallsBefore,
    '没有真正删除任何消息时不得触发媒体裁决',
  );
});

await runCase(async (env) => {
  const { db } = env;
  const sessionId = 'logical-read-rollback';
  insertSession(db, sessionId);
  const reasoning = insertAssistantSegment(db, sessionId, { logicalMessageId: 'logical-rollback', segmentIndex: 0, senderType: 'reasoning', text: 'reasoning' });
  const assistant = insertAssistantSegment(db, sessionId, { logicalMessageId: 'logical-rollback', segmentIndex: 1, text: 'answer' });
  setSessionPreview(db, sessionId, 'answer', getMessageCreatedAt(db, assistant));
  env.readFailure = new Error('injected read failure');
  await assert.rejects(deleteChatMessage(assistant), /injected read failure/);
  assert.equal(countMessages(db, sessionId), 2);
  assert.ok(db.prepare('SELECT id FROM messages WHERE id = ?').get(reasoning));
  assert.equal(getSessionPreview(db, sessionId), 'answer');
});

for (const kind of ['direct', 'group']) {
  await runCase(async (env) => {
    const { db, runtime, executor } = env;
    const sessionId = `preview-race-${kind}`;
    if (kind === 'direct') insertSession(db, sessionId);
    else insertGroup(db, sessionId);
    insertUserMessage(db, sessionId, 'old latest');
    const victim = insertUserMessage(db, sessionId, 'delete me');
    let concurrentCommit;
    env.onRead = (row) => {
      if (row?.text !== 'old latest' || concurrentCommit) return;
      concurrentCommit = executor.withExclusiveTransactionAsync(async (transaction) => {
        const message = await runtime.messages.commitMessageInTransaction(transaction, {
          message: { sessionId, text: 'new latest', isMe: true, senderType: 'user', time: '12:00', createdAt: '2099-01-01T00:00:00Z' },
          previewText: 'new latest',
        });
        if (kind === 'group') await env.groups.updatePreviewInTransaction(transaction, sessionId, message.id, 'new latest', message.createdAt);
      });
    };
    await deleteChatMessage(victim);
    assert.ok(concurrentCommit, '最新消息快照读取后确实有并发提交');
    await concurrentCommit;
    assert.equal(kind === 'direct' ? getSessionPreview(db, sessionId) : getGroupPreview(db, sessionId).last_message, 'new latest');
  });
}

console.log('verify-chat-delete-preview-boundary: all assertions passed');
