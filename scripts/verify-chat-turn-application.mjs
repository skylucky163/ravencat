import { prepareConsumedTurnFixture } from './helpers/sqlite-bootstrap-fixture.mjs';
import { chatReplyVersionModuleUrl, chatMutationModuleUrl, chatTimelineModuleUrl, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
import { arrivalModuleUrl, arrival } from './chat-message-arrival-fixture.mjs';
/**
 * Phase 5A ConversationTurnCoordinator 第二片：Chat 应用层行为验证。
 *
 * 依赖仓库统一的 Node 22.13+ 运行时与内置 node:sqlite；环境不满足时必须失败。
 *
 * 覆盖：
 * 1. commitCanonicalUserMessage（T1）：单事务落用户消息 + supersede active run，
 *    返回 { message, supersededRunId }，并在 commit 后立即清除旧 transient；
 *    无 active run 时 supersededRunId 为 null；
 * 2. buildAssistantTurnItems：reasoning + visibleSegments → 本轮条目列表（纯转换）；
 * 3. SingleTransactionTurnCommit（T3 提交接缝）：fence 失败安静结束、零事实落库、
 *    策略 settled 后 isCommitEligible 为 false；signal 已 abort 时抛取消错误且零落库；
 * 4. shouldSuppressReplyErrorPersistence：signal abort 或 run 失去提交资格时
 *    跳过错误气泡落库（persistReplyError 门控）。
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

const { CHAT_TOOL_PACKAGE_EXPOSURE_SCHEMA } = await import(transpileToModuleUrl(read('src/platform/persistence/sqlite/chatToolPackageSchema.ts')));

// ============================================================================
// 提取迁移 55 源码并编译为可执行函数（与第一片脚本同一模式）
// ============================================================================


// MediaAsset catalog 的真实建表语句：消息 metadata 的媒体引用写入必须能确认 catalog 行存在
// （引用写入 fail-closed 守卫），因此 fixture 必须与生产 schema 一样包含 media_assets。
const { MEDIA_ASSET_SCHEMA, MEDIA_ASSET_CONTENT_HASH_INDEX } = await import(
  transpileToModuleUrl(read('src/platform/persistence/sqlite/mediaAssetSchema.ts'))
);

// ============================================================================
// 模块编译：桩掉 @platform/persistence 与跨层事件/记忆依赖
// ============================================================================
const separatorModuleUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/MessageTimeSeparator.ts'),
);
const turnDomainModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/domain/ConversationTurn.ts'),
);
const messageDomainModuleUrl = transpileToModuleUrl(`
  export function buildGroupMentionModelText(text) { return text; }
  export function buildSessionPreviewTextFromMessage(message) {
    const metadata = message?.metadataJson ? JSON.parse(message.metadataJson) : null;
    if (metadata?.kind === 'voice') return '[语音消息]';
    return String(message?.text ?? '').trim();
  }
`);

const coordinatorStub = `const databaseCoordinator = {
  transaction(meta, task) {
    const holder = globalThis.__TEST_TURN_APP_HOLDER__;
    if (!holder) throw new Error('事务方法不得在缺少测试协调器时进入');
    return holder.transaction(meta, task);
  },
  read(meta, task) {
    const holder = globalThis.__TEST_TURN_APP_HOLDER__;
    if (!holder) throw new Error('读取方法不得在缺少测试协调器时进入');
    return holder.read(meta, task);
  },
  openTaskExecutor() {
    const holder = globalThis.__TEST_TURN_APP_HOLDER__;
    if (!holder) throw new Error('事务方法不得在缺少测试协调器时打开任务执行器');
    return holder.openTaskExecutor();
  },
};`;

const messageRepoSource = read('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts').replaceAll("from './ChatTimelineSql'", `from '${chatTimelineModuleUrl}'`).replaceAll("from './ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`).replaceAll("from '../../reply/infrastructure/ChatReplyVersionSql'", `from '${chatReplyVersionModuleUrl}'`);
const stubbedMessageRepoSource = messageRepoSource
  .replace("from '../domain/chatMessageMetadata'", `from '${messageDomainModuleUrl}'`)
  .replace(
    /import\s*\{[\s\S]*?\}\s*from\s*['"]@platform\/persistence['"];/,
    coordinatorStub,
  )
  .replace(
    /from\s*['"]\.\.\/domain\/MessageTimeSeparator['"]/,
    `from '${separatorModuleUrl}'`,
  );
const messageRepoModuleUrl = transpileToModuleUrl(stubbedMessageRepoSource);
const { MessageRepository } = await import(messageRepoModuleUrl);

const turnRepoSource = read('src/features/chat/reply/infrastructure/SQLiteConversationTurnRepository.ts').replaceAll("from '../../messages/infrastructure/ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`).replaceAll("from './ChatReplyVersionSql'", `from '${chatReplyVersionModuleUrl}'`);
const stubbedTurnRepoSource = turnRepoSource
  .replace(
    /import\s*\{[\s\S]*?\}\s*from\s*['"]@platform\/persistence['"];/,
    coordinatorStub,
  )
  .replace(
    /from\s*['"]\.\.\/\.\.\/messages\/infrastructure\/SQLiteMessageRepository['"]/,
    `from '${messageRepoModuleUrl}'`,
  )
  .replace(
    /from\s*['"]\.\.\/domain\/ConversationTurn['"]/,
    `from '${turnDomainModuleUrl}'`,
  )
  .replace(
    /from\s*['"]\.\.\/\.\.\/messages\/domain['"]/,
    `from '${messageDomainModuleUrl}'`,
  );
const turnRepoModuleUrl = transpileToModuleUrl(stubbedTurnRepoSource);
const { ConversationTurnRepository } = await import(turnRepoModuleUrl);

// ChatMessageRuntime 的唯一 value import 是通用 runtime slot，显式接入数据 URL fixture。
// 测试中显式注入 turns 供 T1/T3 runtime accessor 使用。
const runtimeSlotModuleUrl = transpileToModuleUrl(
  read('src/shared/runtime/RuntimeSlot.ts'),
);
const chatRuntimeDepsSource = read('src/features/chat/messages/application/ChatMessageRuntime.ts')
  .replace(
    /from\s*['"]@shared\/runtime\/RuntimeSlot['"]/,
    `from '${runtimeSlotModuleUrl}'`,
  );
const chatRuntimeDepsModuleUrl = transpileToModuleUrl(
  chatRuntimeDepsSource,
);
const { configureChatMessageRuntime } = await import(chatRuntimeDepsModuleUrl);

// MessagePersistence 桩：保留 T3 不得走旧的逐条持久化路径。
const messagePersistenceStubUrl = transpileToModuleUrl(`
export function persistChatMessage() {
  throw new Error('T3 路径不得走 Legacy persistChatMessage');
}
`);

// 事件桩：T3 提交接缝只需要空实现；分段直接使用真实的 AssistantReplySegmentation。
const aiMessageEventsStubUrl = transpileToModuleUrl(`
export function emitAIMessageReceived() {}
export function resolveAIMessageDeliveryKind() { return 'unknown'; }
`);
globalThis.__TEST_TURN_APP_TRANSIENT_CLEARS__ = [];
const agentTransientTimelineStubUrl = transpileToModuleUrl(`
export function clearAgentTransientTimelineRun(runId, sessionId) {
  globalThis.__TEST_TURN_APP_TRANSIENT_CLEARS__.push({ sessionId, runId });
}
`);
const committedAssistantSegmentDeliverySource = read(
  'src/features/chat/reply/application/CommittedAssistantSegmentDelivery.ts',
)
  .replace(
    /from\s*['"]\.\.\/delivery\/AIMessageEvents['"]/,
    `from '${aiMessageEventsStubUrl}'`,
  )
  .replace(
    /from\s*['"]\.\.\/\.\.\/messages\/domain['"]/,
    `from '${messageDomainModuleUrl}'`,
  );
const committedAssistantSegmentDeliveryModuleUrl = transpileToModuleUrl(
  committedAssistantSegmentDeliverySource,
);
const segmentationModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/application/AssistantReplySegmentation.ts'),
);
const metadataStubUrl = transpileToModuleUrl(`
export function buildMessageMetadata(aiConfig, runtimeContext, extra = {}) {
  return { actorAgentId: aiConfig?.agentId || null, ...extra };
}
`);
const deliveryStubUrl = transpileToModuleUrl(`
export function deliverAssistantMessage() {
  throw new Error('T3 路径不得走 Legacy deliverAssistantMessage');
}
`);

const chatReplyAbortModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/application/ChatReplyAbort.ts'),
);
const {
  ChatReplyRunCancelledError,
  shouldSuppressReplyErrorPersistence,
  isChatReplyRunCancellationError,
} = await import(chatReplyAbortModuleUrl);

const chatReplyUtilsModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/application/ChatReplyUtils.ts').replace(
    "from '@shared/prompt'", `from '${transpileToModuleUrl(read('src/shared/prompt/messageTimestamp.ts'))}'`,
  ),
);

const assistantReplyPersistenceSource = read('src/features/chat/reply/application/AssistantReplyPersistence.ts');
const stubbedAssistantReplyPersistenceSource = assistantReplyPersistenceSource
  .replace(/from\s*['"]\.\.\/\.\.\/messages\/application\/MessagePersistence['"]/, `from '${messagePersistenceStubUrl}'`)
  .replace(/from\s*['"]\.\/AssistantMessageDelivery['"]/, `from '${deliveryStubUrl}'`)
  .replace(/from\s*['"]\.\.\/delivery\/AIMessageEvents['"]/, `from '${aiMessageEventsStubUrl}'`)
  .replace(/from\s*['"]\.\/ChatReplyAbort['"]/, `from '${chatReplyAbortModuleUrl}'`)
  .replace(/from\s*['"]\.\/ChatReplyMetadata['"]/, `from '${metadataStubUrl}'`)
  .replace(/from\s*['"]\.\/ChatReplyUtils['"]/, `from '${chatReplyUtilsModuleUrl}'`)
  .replace(/from\s*['"]\.\/CommittedAssistantSegmentDelivery['"]/, `from '${committedAssistantSegmentDeliveryModuleUrl}'`)
  .replace(/from\s*['"]\.\/AssistantReplySegmentation['"]/, `from '${segmentationModuleUrl}'`);
assert.ok(
  !/@features\/memory|MessagePersistence|AIMessageEvents|AssistantReplySegmentation/.test(
    stubbedAssistantReplyPersistenceSource.replace(/from 'data:text\/javascript[^'"]*'/g, ''),
  ),
  'AssistantReplyPersistence 测试桩必须移除跨层依赖',
);
const assistantReplyPersistenceModuleUrl = transpileToModuleUrl(stubbedAssistantReplyPersistenceSource);

const assistantTurnCommitSource = read('src/features/chat/reply/application/AssistantTurnCommit.ts');
const stubbedAssistantTurnCommitSource = assistantTurnCommitSource
  .replace(/from\s*['"]\.\/AssistantReplyPersistence['"]/, `from '${assistantReplyPersistenceModuleUrl}'`)
  .replace(/from\s*['"]\.\/ChatReplyMetadata['"]/, `from '${metadataStubUrl}'`)
  .replace(/from\s*['"]\.\/ChatReplyUtils['"]/, `from '${chatReplyUtilsModuleUrl}'`);
const assistantTurnCommitModuleUrl = transpileToModuleUrl(stubbedAssistantTurnCommitSource);
const { buildAssistantTurnItems } = await import(assistantTurnCommitModuleUrl);

const singleTransactionTurnCommitSource = read('src/features/chat/reply/application/SingleTransactionTurnCommit.ts');
const cleanupStubUrl = transpileToModuleUrl(`export async function releaseMediaAssetCandidates() {}
export function emitChatMessagesReloadRequested() {}
export function emitChatTurnExecutionChanged() {}`);
const stubbedSingleTransactionTurnCommitSource = singleTransactionTurnCommitSource
  .replace(/import\s*\{\s*databaseCoordinator\s*\}\s*from '@platform\/persistence';/, coordinatorStub)
  .replace("from '@features/media'", `from '${cleanupStubUrl}'`)
  .replace("from '../../messages/events/ChatEvents'", `from '${cleanupStubUrl}'`)
  .replace("from '../delivery/AssistantMessageArrival'", `from '${arrivalModuleUrl}'`)
  .replace(/from\s*['"]\.\.\/delivery\/AIMessageEvents['"]/, `from '${aiMessageEventsStubUrl}'`)
  .replace(/from\s*['"]\.\.\/\.\.\/messages\/application\/ChatMessageRuntime['"]/, `from '${chatRuntimeDepsModuleUrl}'`)
  .replace(/from\s*['"]\.\.\/\.\.\/messages\/application\/MessagePersistence['"]/, `from '${messagePersistenceStubUrl}'`)
  .replace(/from\s*['"]\.\/ChatReplyAbort['"]/, `from '${chatReplyAbortModuleUrl}'`)
  .replace(/from\s*['"]\.\/AssistantReplyPersistence['"]/, `from '${assistantReplyPersistenceModuleUrl}'`)
  .replace(/from\s*['"]\.\/CommittedAssistantSegmentDelivery['"]/, `from '${committedAssistantSegmentDeliveryModuleUrl}'`)
  .replace(/from\s*['"]\.\/AssistantTurnCommit['"]/, `from '${assistantTurnCommitModuleUrl}'`)
  .replace(/from\s*['"]\.\.\/\.\.\/messages\/domain['"]/, `from '${messageDomainModuleUrl}'`);
const singleTransactionTurnCommitModuleUrl = transpileToModuleUrl(stubbedSingleTransactionTurnCommitSource);
const { createSingleTransactionTurnCommit } = await import(singleTransactionTurnCommitModuleUrl);
let arrivalRevision = 0;
arrival.configureAssistantMessageArrivalRuntime({
  async begin({ observer, messageIds }) {
    return { revision: ++arrivalRevision, pendingMessageIds: messageIds, pendingSessionIds: [observer.sessionId] };
  },
  async finish() {
    return { revision: ++arrivalRevision, pendingMessageIds: [], pendingSessionIds: [] };
  },
});

const commitCanonicalUserMessageSource = read('src/features/chat/messages/application/CommitCanonicalUserMessage.ts');
const stubbedCommitCanonicalUserMessageSource = commitCanonicalUserMessageSource
  .replace(
    /import\s*\{[\s\S]*?\}\s*from\s*['"]@platform\/persistence['"];/,
    coordinatorStub,
  )
  .replace(/from\s*['"]\.\/ChatMessageRuntime['"]/, `from '${chatRuntimeDepsModuleUrl}'`)
  .replace("from '../events/ChatEvents'", `from '${cleanupStubUrl}'`)
  .replace(/from\s*['"]\.\/MessagePersistence['"]/, `from '${messagePersistenceStubUrl}'`)
  .replace(/from\s*['"]\.\/AgentTransientTimeline['"]/, `from '${agentTransientTimelineStubUrl}'`);
assert.ok(
  !stubbedCommitCanonicalUserMessageSource.includes('@platform/persistence'),
  'commitCanonicalUserMessage 测试桩必须移除 @platform/persistence 依赖',
);
const commitCanonicalUserMessageModuleUrl = transpileToModuleUrl(stubbedCommitCanonicalUserMessageSource);
const { commitCanonicalUserMessage } = await import(commitCanonicalUserMessageModuleUrl);

/** 把 node:sqlite 实例适配成仓储/迁移期望的异步执行器。 */
function createExecutor(db) {
  return {
    execAsync: async (sql) => { db.exec(sql); },
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  };
}

/** 事务语义与 databaseCoordinator 一致：任务抛错整事务回滚。 */
function createCoordinator(db) {
  installChatTimelineSchema(db);
  db.exec("CREATE TABLE IF NOT EXISTS ai_assistants (id TEXT PRIMARY KEY); INSERT OR IGNORE INTO ai_assistants(id) VALUES ('ai1');");
  db.exec(CHAT_TOOL_PACKAGE_EXPOSURE_SCHEMA);
  const executor = createExecutor(db);
  const coordinator = {
    async transaction(_meta, task) {
      db.exec('BEGIN');
      try {
        const value = await task(executor);
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async read(_meta, task) {
      return task(executor);
    },
    openTaskExecutor() {
      return {
        ...executor,
        withExclusiveTransactionAsync: (task) => coordinator.transaction({ name: 'test' }, task),
      };
    },
  };
  return coordinator;
}

/** 迁移前旧库：chat_conversations + sessions + messages（无 turn 列）。 */
function createBaseDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MEDIA_ASSET_SCHEMA);
  db.exec(MEDIA_ASSET_CONTENT_HASH_INDEX);
  db.exec(`
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group'))
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      ai_assistant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      last_message TEXT,
      last_time TEXT,
      is_active INTEGER DEFAULT 1,
      is_pinned INTEGER DEFAULT 0,
      visible_after_message_id INTEGER,
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
      turn_item_index INTEGER,
      FOREIGN KEY (session_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function addSession(db, sessionId) {
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES (?, 'direct')`).run(sessionId);
  db.prepare(`
    INSERT INTO sessions (id, ai_assistant_id, name, last_message, last_time, is_active, is_pinned, created_at, updated_at)
    VALUES (?, 'ai1', ?, NULL, NULL, 1, 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(sessionId, sessionId);
}

function addMessage(db, { sessionId, text, isMe, createdAt }) {
  return Number(db.prepare(`
    INSERT INTO messages (session_id, text, is_me, sender_type, time, created_at)
    VALUES (?, ?, ?, ?, '12:00', ?)
  `).run(sessionId, text, isMe ? 1 : 0, isMe ? 'user' : 'assistant', createdAt).lastInsertRowid);
}

function getTurnState(db, sessionId) {
  return db.prepare('SELECT * FROM conversation_turn_state WHERE session_id = ?').get(sessionId) ?? null;
}

function getRun(db, runId) {
  return db.prepare('SELECT * FROM conversation_turn_runs WHERE run_id = ?').get(runId) ?? null;
}

function countMessages(db, sessionId) {
  return db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionId).c;
}

function makeUserMessageInput(sessionId, text, createdAt) {
  return {
    sessionId,
    text,
    isMe: true,
    senderType: 'user',
    agentId: null,
    apiMessageId: null,
    clientMessageId: null,
    time: '12:00',
    createdAt,
    updatedAt: createdAt,
    replyToId: null,
    replyToText: null,
    status: 'sent',
    tokensUsed: 0,
    promptTokens: 0,
    completionTokens: 0,
    metadataJson: null,
  };
}

async function setupTurnFixture() {
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '旧消息', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  addMessage(db, { sessionId: 's1', text: '新消息', isMe: true, createdAt: '2026-08-01T11:00:00.000Z' });
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_APP_HOLDER__ = coordinator;
  const turns = new ConversationTurnRepository();
  const messages = new MessageRepository();
  configureChatMessageRuntime({ turns, turnPresentation: { freeze: async () => async () => {}, interrupt: async () => {} } });
  return { db, turns, messages };
}

// ============================================================================
// 测试 1：commitCanonicalUserMessage 返回 supersededRunId
// ============================================================================
{
  const { db, turns, messages } = await setupTurnFixture();
  const run = await turns.claimIfIdle('s1', 'user_reply');
  assert.ok(run, '有待回复用户消息时 claim 必须成功');

  const committed = await commitCanonicalUserMessage({
    repository: messages,
    turns,
    message: makeUserMessageInput('s1', '打断一下', '2026-08-01T11:05:00.000Z'),
    previewText: '打断一下',
  });
  assert.ok(committed.message.id > 0, 'T1 必须返回落库后的用户消息');
  assert.equal(committed.supersededRunId, run.runId, 'T1 必须返回被 supersede 的 runId');
  assert.deepEqual(
    globalThis.__TEST_TURN_APP_TRANSIENT_CLEARS__,
    [],
    'T1 确认 supersede 后必须立即清除旧 run transient，不等待 Runtime abort terminal',
  );
  assert.equal(getRun(db, run.runId).status, 'superseded', '旧 run 必须置 superseded');
  assert.equal(getTurnState(db, 's1').active_run_id, null, 'T1 必须清 active_run_id');
  assert.equal(
    db.prepare(`SELECT text FROM messages WHERE id = ?`).get(committed.message.id).text,
    '打断一下',
    '用户消息必须在同事务落库',
  );
  assert.equal(
    db.prepare(`SELECT last_message FROM sessions WHERE id = 's1'`).get().last_message,
    '打断一下',
    'session preview 必须在同事务更新',
  );
  // 无 active run：纯插入，supersededRunId 为 null。
  const second = await commitCanonicalUserMessage({
    repository: messages,
    turns,
    message: makeUserMessageInput('s1', '再说一句', '2026-08-01T11:06:00.000Z'),
    previewText: '再说一句',
  });
  assert.equal(second.supersededRunId, null, '无 active run 时 supersededRunId 必须为 null');
  assert.equal(
    globalThis.__TEST_TURN_APP_TRANSIENT_CLEARS__.length,
    0,
    '无 active run 时不得清除其他 transient',
  );
}

// ============================================================================
// 测试 2：buildAssistantTurnItems 纯转换
// ============================================================================
{
  const items = buildAssistantTurnItems({
    sessionId: 's1',
    aiConfig: { id: 'ai1', agentId: 'agent1', name: 'AI' },
    runtimeContext: { triggerSource: 'chat' },
    response: {
      success: true,
      text: '忽略',
      reasoningText: '先想一下',
      messageId: 'api-msg-1',
      totalTokens: 30,
      promptTokens: 10,
      completionTokens: 20,
    },
    normalizedText: '第一段\n\n第二段',
    visibleSegments: ['第一段', '第二段'],
  });

  assert.equal(items.length, 3, 'reasoning + 两个可见分段必须产出 3 个条目');
  assert.equal(items[0].message.senderType, 'reasoning');
  assert.equal(items[1].message.senderType, 'assistant');
  assert.equal(items[1].message.segmentIndex, 0);
  assert.equal(items[1].message.segmentTotal, 2);
  assert.equal(items[2].message.segmentIndex, 1);
  assert.equal(items[2].message.tokensUsed, 30, 'token 只记在最后一个分段');
  assert.equal(items[1].message.tokensUsed, 0);
  assert.ok(
    items[0].message.logicalMessageId
      && items[0].message.logicalMessageId === items[1].message.logicalMessageId
      && items[1].message.logicalMessageId === items[2].message.logicalMessageId,
    '同一条目列表必须共享 logicalMessageId',
  );
  assert.equal(items[1].message.turnRunId, undefined, 'turn_run_id 必须由 commit 事务统一赋值');
}

// ============================================================================
// 测试 3：SingleTransactionTurnCommit fence 失败零落库、安静结束
// ============================================================================
{
  const { db, turns, messages } = await setupTurnFixture();
  const staleRun = await turns.claimIfIdle('s1', 'user_reply');
  assert.ok(staleRun, '有待回复用户消息时 claim 必须成功');
  // 新用户消息事务先 commit：revision 已变，旧 run 的 commit fence 必失败。
  await commitCanonicalUserMessage({
    repository: messages,
    turns,
    message: makeUserMessageInput('s1', '新输入', '2026-08-01T11:05:00.000Z'),
    previewText: '新输入',
  });

  const persistence = createSingleTransactionTurnCommit(staleRun, 'ai1');
  const beforeCount = countMessages(db, 's1');
  const beforeCursor = getTurnState(db, 's1').reply_cursor;
  let failedPayloadSeen = false;

  // fence 失败必须安静结束：不抛错、不落条目、不触发失败/完成回调。
  await persistence.persistCompletedAssistantReply({
    sessionId: 's1',
    response: { success: true, text: '过期回答' },
    repository: messages,
    callbacks: {
      onReplyFailed: () => { failedPayloadSeen = true; },
      onFinalReply: () => { failedPayloadSeen = true; },
      onReplyCommitted: () => { failedPayloadSeen = true; },
    },
    runtimeContext: {},
    policy: { bubbleDeliveryMode: 'multi-bubble' },
  });

  assert.equal(countMessages(db, 's1'), beforeCount, 'fence 失败必须零事实落库');
  assert.equal(getTurnState(db, 's1').reply_cursor, beforeCursor, 'fence 失败不得推进游标');
  assert.equal(getRun(db, staleRun.runId).status, 'superseded', 'fence 失败不得改写 run 终态');
  assert.equal(failedPayloadSeen, false, 'fence 失败不得触发任何完成/失败回调');
  assert.equal(persistence.isCommitEligible(), false, 'settled 后必须失去提交资格');
}

// ============================================================================
// 测试 4：signal abort 后不落错误气泡、不落条目
// ============================================================================
{
  const { db, turns, messages } = await setupTurnFixture();
  const run = await turns.claimIfIdle('s1', 'user_reply');
  assert.ok(run, '有待回复用户消息时 claim 必须成功');

  // 门控单元：signal abort 或策略 settled 都压制错误气泡落库。
  const controller = new AbortController();
  assert.equal(isChatReplyRunCancellationError(new ChatReplyRunCancelledError('superseded')), true);
  assert.equal(isChatReplyRunCancellationError(new DOMException('已取消', 'AbortError')), true);
  assert.equal(isChatReplyRunCancellationError(new Error('Upstream request aborted')), false,
    '错误正文包含 aborted 不代表用户取消，不能吞掉模型或 SQLite 的真实失败');
  assert.equal(
    shouldSuppressReplyErrorPersistence({ abortSignal: controller.signal }, {}),
    false,
    '未 abort 且保有提交资格时不得压制错误落库',
  );
  controller.abort();
  assert.equal(
    shouldSuppressReplyErrorPersistence({ abortSignal: controller.signal }, {}),
    true,
    'signal abort 后必须压制错误落库',
  );
  assert.equal(
    shouldSuppressReplyErrorPersistence({}, { isCommitEligible: () => false }),
    true,
    'run 失去提交资格后必须压制错误落库',
  );

  // 行为面：abort 的 run 走到最终落库时抛协作式取消，零事实落库。
  const persistence = createSingleTransactionTurnCommit(run, 'ai1');
  const beforeCount = countMessages(db, 's1');
  await assert.rejects(
    persistence.persistCompletedAssistantReply({
      sessionId: 's1',
      response: { success: true, text: '不应落库' },
      repository: messages,
      callbacks: {},
      runtimeContext: { abortSignal: controller.signal },
    }),
    (error) => error instanceof ChatReplyRunCancelledError,
    'signal abort 后最终落库必须抛协作式取消（由 processAIReply 安静吞掉）',
  );
  assert.equal(countMessages(db, 's1'), beforeCount, 'abort 后不得落任何条目或错误气泡');
  assert.equal(getRun(db, run.runId).status, 'active', 'abort 本身不得改写 run 终态（revoke 是 Host 职责）');
}

// ============================================================================
// 测试 5：Agent timeline T3 接缝只向 assistant 交付/回调，tool 不污染 preview
// ============================================================================
{
  const { db, turns, messages } = await setupTurnFixture();
  const run = await turns.claimIfIdle('s1', 'user_reply');
  assert.ok(run, 'Agent timeline T3 夹具必须先 claim run');

  const persistedSegments = [];
  const finalReplies = [];
  let replyCommittedCount = 0;
  const persistence = createSingleTransactionTurnCommit(run, 'ai1');
  db.prepare('INSERT INTO chat_tool_package_exposure VALUES (?, ?, ?)').run('s1', 'ai1', 'neteaseMusic');
  const result = await persistence.commitAgentTimeline({
    sessionId: 's1',
    response: { success: true, text: '最终回答' },
    toolPackageChanges: [{ packageId: 'memory', action: 'open' }, { packageId: 'neteaseMusic', action: 'close' }],
    repository: messages,
    runtimeContext: { triggerSource: 'chat' },
    policy: { bubbleDeliveryMode: 'multi-bubble' },
    callbacks: {
      onReplySegment: (payload) => {
        persistedSegments.push(payload);
      },
      onFinalReply: (payload) => {
        finalReplies.push(payload);
      },
      onReplyCommitted: () => {
        replyCommittedCount += 1;
      },
    },
    items: [
      {
        message: {
          sessionId: 's1', text: '工具状态', isMe: false, senderType: 'system',
          time: '12:00', createdAt: '2026-08-01T11:01:00.000Z',
        },
      },
      {
        message: {
          sessionId: 's1', text: '思维链', isMe: false, senderType: 'reasoning',
          time: '12:00', createdAt: '2026-08-01T11:02:00.000Z',
        },
      },
      {
        message: {
          sessionId: 's1', text: '最终回答', isMe: false, senderType: 'assistant',
          time: '12:00', createdAt: '2026-08-01T11:03:00.000Z',
        },
      },
    ],
  });

  assert.equal(result.outcome, 'committed');
  assert.deepEqual(await persistence.readOpenToolPackageIds(), ['memory'], '提交接缝同事务保存打开与关闭，并向下一轮提供最终展开状态');
  assert.deepEqual(persistedSegments.map((payload) => payload.text), ['最终回答'], 'segment delivery 只能处理 assistant');
  assert.deepEqual(finalReplies[0].segments.map((segment) => segment.text), ['最终回答'], 'onFinalReply 只能包含 assistant segment');
  assert.equal(replyCommittedCount, 1, 'assistant 存在时 onReplyCommitted 只触发一次');
  assert.equal(
    db.prepare(`SELECT last_message FROM sessions WHERE id = 's1'`).get().last_message,
    '最终回答',
    '同一 T3 中 tool/reasoning 不得成为 session preview',
  );
  assert.deepEqual(
    db.prepare(`
      SELECT sender_type, is_read
      FROM messages
      WHERE session_id = 's1' AND sender_type <> 'user'
      ORDER BY id
    `).all().map((row) => ({ ...row })),
    [
      { sender_type: 'system', is_read: 1 },
      { sender_type: 'reasoning', is_read: 1 },
      { sender_type: 'assistant', is_read: 0 },
    ],
    'tool/reasoning 展示项不得制造 unread，只有 assistant 沿用未读语义',
  );
}

// ============================================================================
// 仅收到部分思考时仍通过 T3 保存，并消费输入，避免后续宿主重新请求模型。
{
  const { db, turns, messages } = await setupTurnFixture();
  const run = await turns.claimIfIdle('s1', 'user_reply');
  const persistence = createSingleTransactionTurnCommit(run, 'ai1');
  let committed = 0;
  await persistence.persistCompletedAssistantReply({
    sessionId: 's1',
    response: { success: true, text: '', reasoningText: '尚未想完的内容' },
    repository: messages,
    aiConfig: { id: 'ai1', agentId: 'agent1', name: 'AI' },
    runtimeContext: { triggerSource: 'chat' },
    policy: { bubbleDeliveryMode: 'multi-bubble' },
    callbacks: { onReplyCommitted: () => { committed++; } },
  });
  assert.equal(persistence.turnCommitOutcome(), 'committed');
  assert.equal(getRun(db, run.runId).status, 'committed');
  assert.equal(getTurnState(db, 's1').reply_cursor, run.inputHighWatermark);
  assert.equal(await turns.claimIfIdle('s1', 'user_reply'), null, '思考已保存后不能重复领取同一输入');
  assert.equal(committed, 1);
  assert.deepEqual(db.prepare("SELECT sender_type, text FROM messages WHERE turn_run_id = ? ORDER BY turn_item_index")
    .all(run.runId).map(row => ({ ...row })), [{ sender_type: 'reasoning', text: '尚未想完的内容' }]);
}

// 测试 6：语音媒体 materializer 与消息同 T3，且 presentation 回调不泄漏 transcript
// ============================================================================
{
  const { db, turns, messages } = await setupTurnFixture();
  const run = await turns.claimIfIdle('s1', 'user_reply');
  assert.ok(run);
  let finalized = 0;
  let discarded = 0;
  const segments = [];
  const persistence = createSingleTransactionTurnCommit(run, 'ai1');
  const result = await persistence.commitAgentTimeline({
    sessionId: 's1',
    response: { success: true, text: '' },
    repository: messages,
    runtimeContext: { triggerSource: 'chat' },
    policy: { bubbleDeliveryMode: 'multi-bubble' },
    callbacks: { onReplySegment: (payload) => segments.push(payload) },
    items: [{
      message: {
        sessionId: 's1', text: '默认隐藏的语音正文', isMe: false, senderType: 'assistant',
        time: '12:00', createdAt: '2026-08-01T11:03:00.000Z',
      },
      materializeInTransaction: async (transaction, message) => {
        // 媒体行与消息在同一 T3 内创建：catalog 行先于消息引用提交。
        await transaction.runAsync(
          `INSERT INTO media_assets (
             id, storage_backend, storage_key, hash_algorithm, content_hash, mime_type,
             byte_size, width, height, duration_ms, status, created_at, updated_at
           ) VALUES (?, 'persistent-media', ?, 'sha256', ?, 'audio/wav', 4, NULL, NULL, 1200,
                     'ready', '2026-08-01T11:03:00.000Z', '2026-08-01T11:03:00.000Z')`,
          ['voice-asset', 'catalog/media/voice-asset.bin', 'a'.repeat(64)],
        );
        return {
          ...message,
          metadataJson: JSON.stringify({
            kind: 'voice',
            voice: {
              schemaVersion: 1,
              mediaAssetId: 'voice-asset',
              mimeType: 'audio/wav',
              durationMs: 1200,
              transcriptSource: 'assistant_source_text',
            },
          }),
        };
      },
      finalizeAfterCommit: async () => { finalized += 1; },
      discardAfterRollback: async () => { discarded += 1; },
    }],
  });

  assert.equal(result.outcome, 'committed');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM media_assets WHERE id = 'voice-asset'`).get().count,
    1,
    '语音媒体 catalog 行必须与消息同一 T3 提交',
  );
  assert.equal(
    db.prepare(`SELECT metadata_json FROM messages WHERE sender_type = 'assistant'`).get()
      .metadata_json.includes('voice-asset'),
    true,
    '消息 metadata 必须引用同一 T3 内创建的资产',
  );
  assert.equal(finalized, 1);
  assert.equal(discarded, 0);
  assert.deepEqual(segments.map((payload) => payload.text), ['[语音消息]']);
  assert.equal(db.prepare(`SELECT last_message FROM sessions WHERE id = 's1'`).get().last_message, '[语音消息]');
}

// 分段未读投影：整批事实已提交，只有到达的消息计数；已读和删除仍以 SQLite 为准。
{
  const { db, messages } = await setupTurnFixture();
  for (let index = 0; index < 2; index += 1) {
    addMessage(db, { sessionId: 's1', text: `原有未读${index}`, isMe: false, createdAt: `2026-08-01T11:01:0${index}.000Z` });
  }
  const batch = await messages.commitMessages({
    messages: ['第一段', '第二段', '第三段'].map((text, index) => ({
      sessionId: 's1', text, isMe: false, senderType: 'assistant', time: '12:00',
      createdAt: `2026-08-01T11:02:0${index}.000Z`,
    })),
    previewText: '第三段',
  });
  const ids = batch.map((message) => message.id);
  assert.equal(await messages.getUnreadCountByAI('ai1'), 5, '原始未读事实保持整批提交');
  assert.equal(await messages.getUnreadCountByAI('ai1', ids), 2);
  assert.equal(await messages.getUnreadCountByAI('ai1', ids.slice(1)), 3);
  assert.equal(await messages.getUnreadCountByAI('ai1', ids.slice(2)), 4);
  assert.equal(await messages.getUnreadCountByAI('ai1', []), 5);
  assert.equal((await messages.getLatestArrivedConversationPreview('s1', ids)).text, '原有未读1');
  assert.equal((await messages.getLatestArrivedConversationPreview('s1', ids.slice(1))).text, '第一段');
  assert.equal((await messages.getLatestArrivedConversationPreview('s1', ids.slice(2))).text, '第二段');
  assert.equal(db.prepare("SELECT last_message FROM sessions WHERE id = 's1'").get().last_message, '第三段', '到达投影不得回写持久预览');

  await messages.commitMessage({ message: {
    sessionId: 's1', text: '工具过程', isMe: false, senderType: 'system', time: '12:00',
    createdAt: '2026-08-01T11:03:00.000Z', metadataJson: JSON.stringify({ type: 'toolStatus' }),
  }, previewText: '第三段' });
  assert.equal((await messages.getLatestArrivedConversationPreview('s1', ids.slice(1))).text, '第一段', '工具过程不抢占到达预览');
  await messages.markMessagesAsRead('s1');
  assert.equal(await messages.getUnreadCountByAI('ai1', ids.slice(1)), 0);
  assert.equal(await messages.getUnreadCountByAI('ai1', []), 0, '已读后剩余分段到达不能重新亮红点');

  db.prepare("INSERT INTO chat_conversations (id, kind) VALUES ('arrival-group', 'group')").run();
  const groupBatch = await messages.commitMessages({ messages: ['群第一段', '群第二段'].map((text) => ({
    sessionId: 'arrival-group', text, isMe: false, senderType: 'assistant', time: '12:00', createdAt: '2026-08-01T11:04:00.000Z',
  })), previewText: '群第二段' });
  assert.equal(await messages.getUnreadCountByGroup('arrival-group', groupBatch.map((message) => message.id)), 0);
  assert.equal(await messages.getUnreadCountByGroup('arrival-group', [groupBatch[1].id]), 1);
  assert.equal(await messages.getUnreadCountByAI('ai1'), 0, '群未读不计到单聊');
  db.prepare('DELETE FROM messages WHERE id = ?').run(groupBatch[1].id);
  assert.equal(await messages.getUnreadCountByGroup('arrival-group', [groupBatch[1].id]), 1, '删除未到达分段不扣除别的未读');

  addMessage(db, { sessionId: 's1', text: '用户的新消息', isMe: true, createdAt: '2026-08-01T11:05:00.000Z' });
  assert.equal((await messages.getLatestArrivedConversationPreview('s1', ids.slice(1))).text, '用户的新消息', '旧分段到达不能覆盖更新的用户消息');
  db.prepare('UPDATE sessions SET visible_after_message_id = (SELECT MAX(id) FROM messages WHERE session_id = ?) WHERE id = ?').run('s1', 's1');
  assert.equal(await messages.getLatestArrivedConversationPreview('s1', ids), null, '清空历史边界不能被到达投影绕过');
}

// commit 后 UI 观察者失败也必须结束隐藏投影，不能丢失已提交事实。
{
  const { turns, messages } = await setupTurnFixture();
  const run = await turns.claimIfIdle('s1', 'user_reply');
  const persistence = createSingleTransactionTurnCommit(run, 'ai1');
  await assert.rejects(persistence.persistCompletedAssistantReply({
    sessionId: 's1', response: { success: true, text: '已提交回复' }, repository: messages,
    aiConfig: { id: 'ai1', agentId: 'agent1', name: 'AI' },
    policy: { bubbleDeliveryMode: 'multi-bubble' },
    callbacks: { notifyUI() { throw new Error('injected UI failure'); } },
  }), /injected UI failure/);
  assert.equal(persistence.turnCommitOutcome(), 'committed', '展示观察者失败不能改写提交成功事实');
  assert.equal(persistence.isCommitEligible(), false, '提交成功后的异常不能再取得错误气泡写入资格');
  assert.deepEqual(arrival.getAssistantMessageArrivalSnapshot().pendingMessageIds, []);
  assert.equal(await messages.getUnreadCountByAI('ai1'), 1);
}

delete globalThis.__TEST_TURN_APP_HOLDER__;

console.log('ConversationTurnCoordinator 第二片：commitCanonicalUserMessage / 提交接缝 / 取消门控验证通过。');
console.log('真实 processAIReply 全链路与 Host 装配仍需 Android 真机验收。');
