import { sharedChatRecordModuleUrl, sharedMomentModuleUrl } from './helpers/chat-sharing-fixture.mjs';
import { prepareConsumedTurnFixture } from './helpers/sqlite-bootstrap-fixture.mjs';
import { chatReplyVersionModuleUrl, chatMutationModuleUrl, chatTimelineModuleUrl, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
/**
 * Phase 5A ConversationTurnCoordinator 第一片：当前回合 fixture 与 T1～T4 行为验证。
 *
 * 依赖仓库统一的 Node 22.13+ 运行时与内置 node:sqlite；环境不满足时必须失败。
 *
 * 覆盖：
 * 1. migration 55 建表/建列/索引与回填（reply_cursor = 每会话 MAX(messages.id)，产品取舍：
 *    升级前未回复尾部视为已消费）；
 * 2. migration 幂等：重复执行不覆盖已推进的游标；
 * 3. 数据库级不变量：每会话最多一个 active run、(turn_run_id, turn_item_index) 唯一；
 * 4. T2 claim：无待回复输入返回 null；claimIfIdle 不抢 active run；takeOverOrphan 事务内 supersede；
 * 5. T1 supersede：active run 置 superseded + 清 active + revision+1；
 * 6. T3 commit：fence 通过单事务落全部 items（turn_item_index 1..N）+ preview + run 终态 + 游标；
 *    fence 失败返回 fence_failed 且零事实落库；id > hw 的消息不被本轮消费；
 * 7. T4 revoke：cancel 后 commit fence 必失败；CAS 失败（已 superseded）时不改 turn_state；
 * 8. findTerminalRunCovering / listSessionsWithUnrepliedInput（keyset 分页）。
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
// 提取迁移 55 源码并编译为可执行函数
// ============================================================================


// ============================================================================
// 仓储模块：桩掉 @platform/persistence，事务直接落在真实 node:sqlite 上
// ============================================================================
const separatorModuleUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/MessageTimeSeparator.ts'),
);
const turnDomainModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/domain/ConversationTurn.ts'),
);
const messageDomainModuleUrl = transpileToModuleUrl(`
  export function buildSessionPreviewTextFromMessage(message) {
    return String(message?.text ?? '').trim();
  }
`);

const coordinatorStub = `const databaseCoordinator = {
  transaction(meta, task) {
    const holder = globalThis.__TEST_TURN_COORDINATOR_HOLDER__;
    if (!holder) throw new Error('事务方法不得在缺少测试协调器时进入');
    return holder.transaction(meta, task);
  },
  read(meta, task) {
    const holder = globalThis.__TEST_TURN_COORDINATOR_HOLDER__;
    if (!holder) throw new Error('读取方法不得在缺少测试协调器时进入');
    return holder.read(meta, task);
  },
  openTaskExecutor() {
    const holder = globalThis.__TEST_TURN_COORDINATOR_HOLDER__;
    if (!holder) throw new Error('事务方法不得在缺少测试协调器时打开任务执行器');
    return holder.openTaskExecutor();
  },
};`;

const messageRepoSource = read('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts').replaceAll("from './ChatTimelineSql'", `from '${chatTimelineModuleUrl}'`).replaceAll("from './ChatMessageMutationSql'", `from '${chatMutationModuleUrl}'`).replaceAll("from '../../reply/infrastructure/ChatReplyVersionSql'", `from '${chatReplyVersionModuleUrl}'`);
const stubbedMessageRepoSource = messageRepoSource
  .replaceAll("from '../domain/chatMessageMetadata'", `from '${transpileToModuleUrl(
    read('src/features/chat/messages/domain/chatMessageMetadata.ts').replaceAll("from './SharedMoment'", `from '${sharedMomentModuleUrl}'`)
      .replaceAll("from './ChatSticker'", `from '${transpileToModuleUrl(read('src/features/chat/messages/domain/ChatSticker.ts'))}'`)
      .replaceAll("from './SharedChatRecord'", `from '${sharedChatRecordModuleUrl}'`),
  )}'`)
  .replace(
    /import\s*\{[\s\S]*?\}\s*from\s*['"]@platform\/persistence['"];/,
    coordinatorStub,
  )
  .replace(
    /from\s*['"]\.\.\/domain\/MessageTimeSeparator['"]/,
    `from '${separatorModuleUrl}'`,
  );
const messageRepoModuleUrl = transpileToModuleUrl(stubbedMessageRepoSource);

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
assert.ok(
  !stubbedTurnRepoSource.includes('@platform/persistence'),
  'turn 仓储测试桩必须移除 @platform/persistence 依赖',
);
const turnRepoModuleUrl = transpileToModuleUrl(stubbedTurnRepoSource);
const { ConversationTurnRepository } = await import(turnRepoModuleUrl);
const { messageRepository } = await import(messageRepoModuleUrl);

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
    transactionCount: 0,
    async transaction(_meta, task) {
      coordinator.transactionCount += 1;
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

function addMessage(db, { sessionId, text, isMe, createdAt, metadataJson = null }) {
  return Number(db.prepare(`
    INSERT INTO messages (session_id, text, is_me, sender_type, time, created_at, metadata_json)
    VALUES (?, ?, ?, ?, '12:00', ?, ?)
  `).run(sessionId, text, isMe ? 1 : 0, isMe ? 'user' : 'assistant', createdAt, metadataJson).lastInsertRowid);
}

function getTurnState(db, sessionId) {
  return db.prepare('SELECT * FROM conversation_turn_state WHERE session_id = ?').get(sessionId) ?? null;
}

function getRun(db, runId) {
  return db.prepare('SELECT * FROM conversation_turn_runs WHERE run_id = ?').get(runId) ?? null;
}

function makeAssistantItem(text, createdAt) {
  return {
    message: {
      sessionId: 's1',
      text,
      isMe: false,
      senderType: 'assistant',
      time: '12:00',
      createdAt,
    },
  };
}

function makeTimelineItem(senderType, text, createdAt, metadataJson = null) {
  return {
    message: {
      sessionId: 's1',
      text,
      isMe: false,
      senderType,
      metadataJson,
      time: '12:00',
      createdAt,
    },
  };
}

// ============================================================================
// 测试 1：回合 fixture 与当前索引
// ============================================================================
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addSession(db, 's2');
  // s1 尾部是未回复用户消息：回填视为历史已消费（产品取舍）。
  addMessage(db, { sessionId: 's1', text: '你好', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  addMessage(db, { sessionId: 's1', text: '你好呀', isMe: false, createdAt: '2026-08-01T10:01:00.000Z' });
  const tailUserId = addMessage(db, { sessionId: 's1', text: '还在吗', isMe: true, createdAt: '2026-08-01T10:02:00.000Z' });

  await prepareConsumedTurnFixture(createExecutor(db));

  const s1State = getTurnState(db, 's1');
  assert.equal(s1State.reply_cursor, tailUserId, '回填 reply_cursor 必须等于会话 MAX(messages.id)');
  assert.equal(s1State.revision, 0, '回填 revision 必须为 0');
  assert.equal(s1State.active_run_id, null, '回填不得设置 active run');
  const s2State = getTurnState(db, 's2');
  assert.equal(s2State.reply_cursor, 0, '无消息会话回填 cursor 必须为 0');

  const messageColumns = db.prepare(`PRAGMA table_info('messages')`).all().map((c) => c.name);
  assert.ok(messageColumns.includes('turn_run_id'), 'messages 必须有 turn_run_id 列');
  assert.ok(messageColumns.includes('turn_item_index'), 'messages 必须有 turn_item_index 列');

  const indexNames = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index'`,
  ).all().map((row) => row.name);
  for (const expected of [
    'idx_messages_turn_item',
    'idx_turn_runs_recovery',
    'idx_turn_runs_session_history',
    'idx_turn_runs_single_active',
  ]) {
    assert.ok(indexNames.includes(expected), `缺少索引 ${expected}`);
  }

  const fkList = db.prepare(`PRAGMA foreign_key_list('conversation_turn_state')`).all();
  assert.ok(
    fkList.some((fk) => fk.table === 'chat_conversations' && fk.on_delete === 'CASCADE'),
    'turn_state 外键必须指向 chat_conversations(id) ON DELETE CASCADE',
  );
}

// 测试 6b：同一 Agent run 的 turn_item_index 主导 reload 顺序，tool 不污染 assistant preview
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '输入', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  addMessage(db, { sessionId: 's1', text: '本轮输入', isMe: true, createdAt: '2026-08-01T10:00:01.000Z' });
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();
  const run = await repo.claimIfIdle('s1', 'user_reply');
  assert.ok(run, 'Agent timeline 顺序夹具必须先 claim run');

  const result = await repo.commitTurn(run, [
    makeTimelineItem('reasoning', 'reasoning', '2026-08-01T10:04:00.000Z'),
    makeTimelineItem('system', 'tool running', '2026-08-01T10:01:00.000Z', JSON.stringify({ type: 'toolStatus' })),
    makeTimelineItem('assistant', '最终回答', '2026-08-01T10:03:00.000Z'),
    makeTimelineItem('system', 'tool completed', '2026-08-01T10:02:00.000Z', JSON.stringify({ type: 'toolStatus' })),
  ], { assistantId: 'ai1', changes: [] });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(
    result.messages.map((message) => [message.senderType, message.turnItemIndex]),
    [
      ['reasoning', 1],
      ['system', 2],
      ['assistant', 3],
      ['system', 4],
    ],
    'T3 必须按 Agent timeline 输入顺序写入 turn_item_index，并映射回实体',
  );
  assert.equal(
    db.prepare(`SELECT last_message FROM sessions WHERE id = 's1'`).get().last_message,
    '最终回答',
    '工具 item 位于末尾时 session preview 仍必须使用最后 assistant 可见消息',
  );
  assert.equal((await messageRepository.getLatestMessage('s1'))?.text, 'tool completed', 'latest message 必须按同 run turn_item_index 读取');
  const reloaded = await messageRepository.getMessages('s1', { limit: 20, order: 'ASC' });
  assert.deepEqual(
    reloaded.messages.map((message) => message.text),
    ['输入', '本轮输入', 'reasoning', 'tool running', '最终回答', 'tool completed'],
    'reload 必须保持同一 run 的持久 Agent timeline 顺序，而不是 created_at 顺序',
  );
}

// 测试 2：migration 幂等，不覆盖已推进的游标
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '你好', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  db.prepare(`UPDATE conversation_turn_state SET reply_cursor = 999, revision = 3 WHERE session_id = 's1'`).run();
  await prepareConsumedTurnFixture(createExecutor(db));
  const state = getTurnState(db, 's1');
  assert.equal(state.reply_cursor, 999, '重复执行不得覆盖已推进的 reply_cursor');
  assert.equal(state.revision, 3, '重复执行不得覆盖已推进的 revision');
}

// 测试 3：数据库级不变量（部分唯一索引）
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  await prepareConsumedTurnFixture(createExecutor(db));
  const insertRun = db.prepare(`
    INSERT INTO conversation_turn_runs
      (run_id, session_id, kind, reply_cursor_at_claim, input_high_watermark, revision_at_claim, status, created_at)
    VALUES (?, 's1', 'user_reply', 0, 1, 1, ?, '2026-08-01T10:00:00.000Z')
  `);
  insertRun.run('run-a', 'active');
  assert.throws(
    () => insertRun.run('run-b', 'active'),
    /UNIQUE/,
    '同一会话不得存在第二个 active run',
  );
  insertRun.run('run-b', 'superseded');

  const insertTurnMessage = db.prepare(`
    INSERT INTO messages (session_id, text, is_me, sender_type, time, created_at, turn_run_id, turn_item_index)
    VALUES ('s1', ?, 0, 'assistant', '12:00', '2026-08-01T10:05:00.000Z', ?, ?)
  `);
  insertTurnMessage.run('条目1', 'run-a', 1);
  assert.throws(
    () => insertTurnMessage.run('条目1重放', 'run-a', 1),
    /UNIQUE/,
    '同一 (turn_run_id, turn_item_index) 重放必须触发 constraint 错误',
  );
  insertTurnMessage.run('条目2', 'run-a', 2);
  // turn_run_id 为 NULL 的历史消息不受唯一索引约束。
  db.prepare(`
    INSERT INTO messages (session_id, text, is_me, sender_type, time, created_at)
    VALUES ('s1', '历史1', 0, 'assistant', '12:00', '2026-08-01T10:06:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO messages (session_id, text, is_me, sender_type, time, created_at)
    VALUES ('s1', '历史2', 0, 'assistant', '12:00', '2026-08-01T10:07:00.000Z')
  `).run();
}

// ============================================================================
// 测试 4：T2 claim（claimIfIdle / takeOverOrphan）
// ============================================================================
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '旧消息', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();

  // 回填后无待回复输入：claim 返回 null。
  assert.equal(await repo.claimIfIdle('s1', 'user_reply'), null, '无待回复输入时 claim 必须返回 null');

  const newUserMessageId = addMessage(db, { sessionId: 's1', text: '新消息', isMe: true, createdAt: '2026-08-01T11:00:00.000Z' });
  const run = await repo.claimIfIdle('s1', 'user_reply');
  assert.ok(run, '有待回复用户消息时 claim 必须成功');
  assert.equal(run.replyCursorAtClaim, 1, 'claim 下界必须是回填游标');
  assert.equal(run.inputHighWatermark, newUserMessageId, 'claim 高水位必须是用户消息 MAX(id)');
  assert.equal(run.revisionAtClaim, 1, 'revisionAtClaim 必须是 claim 完成后的 revision');
  assert.equal(run.status, 'active');
  const stateAfterClaim = getTurnState(db, 's1');
  assert.equal(stateAfterClaim.active_run_id, run.runId, 'claim 后 turn_state 必须指向新 run');
  assert.equal(stateAfterClaim.revision, 1, 'claim 后 revision+1');

  // claimIfIdle 不得抢走正常 active run。
  assert.equal(await repo.claimIfIdle('s1', 'user_reply'), null, '已有 active run 时 claimIfIdle 必须返回 null');

  // takeOverOrphan 在事务内 supersede 孤儿。
  const orphanRun = run;
  const recovered = await repo.takeOverOrphan('s1', 'user_reply');
  assert.ok(recovered, '有待回复输入时 takeOverOrphan 必须成功');
  assert.notEqual(recovered.runId, orphanRun.runId);
  assert.equal(getRun(db, orphanRun.runId).status, 'superseded', '孤儿 run 必须被事务内 supersede');
  assert.equal(getTurnState(db, 's1').active_run_id, recovered.runId);
  assert.equal(getTurnState(db, 's1').revision, 2, 'takeOver 后 revision 再 +1');
}

// 测试 4A：outgoing callStatus 不属于 canonical user_reply 输入
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '历史消息', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();

  const callStatusId = addMessage(db, {
    sessionId: 's1',
    text: '【通话中】',
    isMe: true,
    createdAt: '2026-08-01T11:00:00.000Z',
    metadataJson: JSON.stringify({ type: 'callStatus', callId: 'call-1' }),
  });

  assert.equal(
    await repo.claimIfIdle('s1', 'user_reply'),
    null,
    'cursor 后只有 outgoing callStatus 时不得 claim',
  );
  assert.deepEqual(
    await repo.getSessionTurnSnapshot('s1'),
    { sessionId: 's1', replyCursor: 1, highWatermark: 1 },
    'snapshot 高水位不得把 outgoing callStatus 计入待回复输入',
  );
  assert.deepEqual(
    await repo.listSessionsWithUnrepliedInput('', 50),
    [],
    '只有 outgoing callStatus 时 recovery 扫描不得列出会话',
  );
  assert.deepEqual(
    (await messageRepository.listUserMessagesInRange('s1', 1, callStatusId)).map((message) => message.id),
    [],
    '固定区间不得包含 callStatus',
  );

  const realUserMessageId = addMessage(db, {
    sessionId: 's1',
    text: '真实用户消息',
    isMe: true,
    createdAt: '2026-08-01T11:01:00.000Z',
  });
  const run = await repo.claimIfIdle('s1', 'user_reply');
  assert.ok(run, 'callStatus 后的真实用户消息仍必须可 claim');
  assert.equal(run.inputHighWatermark, realUserMessageId, '高水位必须落在真实用户消息');
  assert.deepEqual(
    (await messageRepository.listUserMessagesInRange(
      's1',
      run.replyCursorAtClaim,
      run.inputHighWatermark,
    )).map((message) => message.id),
    [realUserMessageId],
    '固定区间只应包含真实用户消息',
  );
}

// 测试 5：T1 supersede（事务内组合入口的两个半段）
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '你好', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  // 回填游标已覆盖历史消息；补一条新用户消息构造待回复输入。
  addMessage(db, { sessionId: 's1', text: '新消息', isMe: true, createdAt: '2026-08-01T11:00:00.000Z' });
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();

  // 无 turn_state 行的全新会话：ensure 建行，supersede 是纯空操作。
  addSession(db, 's3');
  const noneSuperseded = await coordinator.transaction({}, async (tx) => {
    await repo.ensureTurnStateRowInTransaction(tx, 's3');
    return repo.supersedeActiveRunInTransaction(tx, 's3');
  });
  assert.equal(noneSuperseded, null, '无 active run 时 supersede 必须返回 null');
  assert.equal(getTurnState(db, 's3').reply_cursor, 0, '新会话惰性建行 cursor=0');

  const run = await repo.claimIfIdle('s1', 'user_reply');
  const supersededRunId = await coordinator.transaction({}, async (tx) => {
    await repo.ensureTurnStateRowInTransaction(tx, 's1');
    return repo.supersedeActiveRunInTransaction(tx, 's1');
  });
  assert.equal(supersededRunId, run.runId, 'T1 必须返回被 supersede 的 runId');
  assert.equal(getRun(db, run.runId).status, 'superseded', '旧 run 必须置 superseded');
  assert.ok(getRun(db, run.runId).terminal_at, 'superseded 必须写 terminal_at');
  const state = getTurnState(db, 's1');
  assert.equal(state.active_run_id, null, 'T1 必须清 active_run_id');
  assert.equal(state.active_run_kind, null, 'T1 必须清 active_run_kind');
  assert.equal(state.revision, 2, 'T1 supersede 必须 revision+1');
}

// 测试 6：T3 commit 成功路径与高水位边界
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '问题', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  // 回填游标已覆盖历史消息；补一条新用户消息构造待回复输入。
  addMessage(db, { sessionId: 's1', text: '新问题', isMe: true, createdAt: '2026-08-01T10:30:00.000Z' });
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();

  const run = await repo.claimIfIdle('s1', 'user_reply');
  assert.ok(run, '有待回复用户消息时 claim 必须成功');
  // claim 之后、commit 之前到来的用户消息 id > hw，天然属于下一轮。
  const lateUserMessageId = addMessage(db, { sessionId: 's1', text: '补充', isMe: true, createdAt: '2026-08-01T10:00:30.000Z' });
  assert.ok(lateUserMessageId > run.inputHighWatermark, '夹具：迟到消息 id 必须大于高水位');

  const result = await repo.commitTurn(run, [
    makeAssistantItem('回答第一段', '2026-08-01T11:01:00.000Z'),
    makeAssistantItem('回答第二段', '2026-08-01T11:01:05.000Z'),
  ], { assistantId: 'ai1', changes: [] });
  assert.equal(result.outcome, 'committed', 'fence 通过必须提交');
  assert.equal(result.messageIds.length, 2, '必须返回全部条目 id');

  const rows = db.prepare(
    `SELECT turn_run_id, turn_item_index FROM messages WHERE turn_run_id = ? ORDER BY turn_item_index`,
  ).all(run.runId);
  assert.deepEqual(
    rows.map((row) => row.turn_item_index),
    [1, 2],
    '条目必须按 1..N 写入 turn_item_index',
  );
  assert.equal(
    db.prepare(`SELECT last_message FROM sessions WHERE id = 's1'`).get().last_message,
    '回答第二段',
    'preview 必须按最后可见 item 更新',
  );
  assert.equal(getRun(db, run.runId).status, 'committed', 'run 必须置 committed');
  const state = getTurnState(db, 's1');
  assert.equal(state.reply_cursor, run.inputHighWatermark, '游标只能推进到 input_high_watermark');
  assert.equal(state.active_run_id, null, 'commit 必须清 active_run_id');
  assert.equal(state.revision, 2, 'commit 必须 revision+1');

  // id > hw 的迟到用户消息未被本轮消费：recovery 扫描必须再次看到该会话。
  const unreplied = await repo.listSessionsWithUnrepliedInput('', 50);
  assert.deepEqual(
    unreplied.map((s) => s.sessionId),
    ['s1'],
    'id > hw 的用户消息必须保持待回复',
  );
}

// 测试 7：T3 fence 失败（supersede 后 commit / revoke 后 commit）零事实落库
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '问题', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  // 回填游标已覆盖历史消息；补一条新用户消息构造待回复输入。
  addMessage(db, { sessionId: 's1', text: '新问题', isMe: true, createdAt: '2026-08-01T10:30:00.000Z' });
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();

  // 全序一：旧 run 被 supersede 后，其 commit fence 必失败。
  const staleRun = await repo.claimIfIdle('s1', 'user_reply');
  await repo.takeOverOrphan('s1', 'user_reply');
  const beforeCount = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  const staleResult = await repo.commitTurn(staleRun, [
    makeAssistantItem('过期回答', '2026-08-01T10:01:00.000Z'),
  ], { assistantId: 'ai1', changes: [] });
  assert.equal(staleResult.outcome, 'fence_failed', '被 supersede 的 run commit 必须 fence 失败');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
    beforeCount,
    'fence 失败必须零事实落库',
  );
  assert.equal(
    getTurnState(db, 's1').reply_cursor,
    staleRun.replyCursorAtClaim,
    'fence 失败不得推进游标',
  );

  // 全序二：revoke 之后 commit fence 必失败。
  // takeOverOrphan 的 run B 仍是 active；先经 T1 supersede 清空所有权（模拟新用户消息事务）。
  const supersededB = await coordinator.transaction({}, (tx) => (
    repo.supersedeActiveRunInTransaction(tx, 's1')
  ));
  assert.ok(supersededB, 'T1 必须 supersede 当前 active run');
  const activeRun = await repo.claimIfIdle('s1', 'user_reply');
  assert.ok(activeRun, 'supersede 清空 active 后必须能重新 claim');
  await repo.revoke(activeRun, 'cancelled', '用户取消');
  assert.equal(getRun(db, activeRun.runId).status, 'cancelled', 'revoke 必须写 run 终态');
  assert.equal(getRun(db, activeRun.runId).terminal_reason, '用户取消');
  assert.equal(getTurnState(db, 's1').active_run_id, null, 'revoke 必须清 active_run_id');
  const cancelledResult = await repo.commitTurn(activeRun, [
    makeAssistantItem('取消后回答', '2026-08-01T10:02:00.000Z'),
  ], { assistantId: 'ai1', changes: [] });
  assert.equal(cancelledResult.outcome, 'fence_failed', 'cancel 后 commit fence 必失败');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM messages').get().c,
    beforeCount,
    'cancel 后 commit 不得落任何条目',
  );
}

// 测试 8：T4 revoke 的 CAS 失败（已 superseded）不改 turn_state，只尽力写 run 行
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addMessage(db, { sessionId: 's1', text: '问题', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  // 回填游标已覆盖历史消息；补一条新用户消息构造待回复输入。
  addMessage(db, { sessionId: 's1', text: '新问题', isMe: true, createdAt: '2026-08-01T10:30:00.000Z' });
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();

  const oldRun = await repo.claimIfIdle('s1', 'user_reply');
  const newRun = await repo.takeOverOrphan('s1', 'user_reply');
  const stateBefore = getTurnState(db, 's1');

  // oldRun 已被 supersede：revoke 的 turn_state CAS 0 行，不得改 turn_state；
  // run 行已是终态 superseded，不得被静默改写成 failed。
  await repo.revoke(oldRun, 'failed', '模型超时');
  const stateAfter = getTurnState(db, 's1');
  assert.equal(stateAfter.active_run_id, newRun.runId, 'CAS 失败不得动新 run 的所有权');
  assert.equal(stateAfter.revision, stateBefore.revision, 'CAS 失败不得推进 revision');
  assert.equal(getRun(db, oldRun.runId).status, 'superseded', '已终态 run 不得被改写');
}

// 测试 9：findTerminalRunCovering 与 listSessionsWithUnrepliedInput keyset 分页
{
  const db = createBaseDatabase();
  addSession(db, 's1');
  addSession(db, 's2');
  addSession(db, 's3');
  db.prepare(`INSERT INTO chat_conversations (id, kind) VALUES ('group-1', 'group')`).run();
  addMessage(db, { sessionId: 's1', text: 'u1', isMe: true, createdAt: '2026-08-01T10:00:00.000Z' });
  addMessage(db, { sessionId: 's2', text: 'u2', isMe: true, createdAt: '2026-08-01T10:01:00.000Z' });
  addMessage(db, { sessionId: 's3', text: 'u3', isMe: true, createdAt: '2026-08-01T10:02:00.000Z' });
  addMessage(db, { sessionId: 'group-1', text: 'group-old', isMe: true, createdAt: '2026-08-01T10:03:00.000Z' });
  await prepareConsumedTurnFixture(createExecutor(db));
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();

  // 回填游标已覆盖历史消息；每个会话补一条新用户消息构造待回复输入。
  addMessage(db, { sessionId: 's1', text: 'u1-new', isMe: true, createdAt: '2026-08-01T11:00:00.000Z' });
  addMessage(db, { sessionId: 's2', text: 'u2-new', isMe: true, createdAt: '2026-08-01T11:01:00.000Z' });
  addMessage(db, { sessionId: 's3', text: 'u3-new', isMe: true, createdAt: '2026-08-01T11:02:00.000Z' });
  addMessage(db, { sessionId: 'group-1', text: 'group-new', isMe: true, createdAt: '2026-08-01T11:03:00.000Z' });

  // s1：新用户消息被 claim，随后 failed —— failed 覆盖区间不得被自动重 claim。
  const failedRun = await repo.claimIfIdle('s1', 'user_reply');
  assert.ok(failedRun, '有待回复用户消息时 claim 必须成功');
  await repo.revoke(failedRun, 'failed', '模型失败');

  const covering = await repo.findTerminalRunCovering('s1', failedRun.inputHighWatermark);
  assert.equal(covering?.runId, failedRun.runId, 'failed run 必须覆盖其高水位');
  assert.equal(
    await repo.findTerminalRunCovering('s1', failedRun.inputHighWatermark + 1),
    null,
    '更高水位不得被旧 failed run 覆盖',
  );

  // keyset 分页：s1（failed 覆盖但仍待回复）、s2、s3 都会被扫描列出（防隐式 retry 判据在调用方）。
  const firstPage = await repo.listSessionsWithUnrepliedInput('', 2);
  assert.deepEqual(firstPage.map((s) => s.sessionId), ['s1', 's2'], '第一页必须按 session_id 升序');
  const secondPage = await repo.listSessionsWithUnrepliedInput('s2', 2);
  assert.deepEqual(secondPage.map((s) => s.sessionId), ['s3'], 'keyset 必须接续上一页');
  assert.deepEqual(await repo.listSessionsWithUnrepliedInput('s3', 2), [], '扫描必须有终止边界');

  // s2 的输入被 commit 消费后不再出现在扫描里。
  const s2Run = await repo.claimIfIdle('s2', 'user_reply');
  const commitResult = await repo.commitTurn(s2Run, [
    {
      message: {
        sessionId: 's2',
        text: 'r2',
        isMe: false,
        senderType: 'assistant',
        time: '12:00',
        createdAt: '2026-08-01T11:30:00.000Z',
      },
    },
  ], { assistantId: 'ai1', changes: [] });
  assert.equal(commitResult.outcome, 'committed');
  assert.deepEqual(
    (await repo.listSessionsWithUnrepliedInput('', 50)).map((s) => s.sessionId),
    ['s1', 's3'],
    '游标覆盖用户消息后会话不再待回复',
  );
}

// 迟到或重复的宿主请求不能重新领取失败／取消的同一输入区间。
for (const status of ['failed', 'cancelled']) {
  const db = createBaseDatabase();
  addSession(db, 's1');
  await prepareConsumedTurnFixture(createExecutor(db));
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = createCoordinator(db);
  const repo = new ConversationTurnRepository();
  addMessage(db, { sessionId: 's1', text: '待回复消息', isMe: true, createdAt: '2026-08-01T11:00:00.000Z' });
  const run = await repo.claimIfIdle('s1', 'user_reply');
  await repo.revoke(run, status, '请求已结束');
  const state = getTurnState(db, 's1');
  for (const claim of ['claimIfIdle', 'takeOverOrphan']) {
    assert.equal(await repo[claim]('s1', 'user_reply'), null, `${status} 后重复宿主不得通过 ${claim} 重发同一输入`);
    assert.deepEqual(getTurnState(db, 's1'), state, '拒绝重复领取不能修改持久所有权');
  }
  addMessage(db, { sessionId: 's1', text: '新的用户输入', isMe: true, createdAt: '2026-08-01T11:01:00.000Z' });
  assert.ok(await repo.claimIfIdle('s1', 'user_reply'), '新输入扩大高水位后必须允许回复');
  db.close();
}

// 工具包开关随正式回复原子提交；不再按轮数自动到期。
{
  const db = createBaseDatabase();
  addSession(db, 's1'); addSession(db, 's2');
  await prepareConsumedTurnFixture(createExecutor(db));
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = createCoordinator(db);
  db.exec("INSERT INTO ai_assistants(id) VALUES ('ai2')");
  const repo = new ConversationTurnRepository();
  const open = (packageId) => ({ packageId, action: 'open' });
  const close = (packageId) => ({ packageId, action: 'close' });
  const packages = () => repo.listOpenToolPackageIds('s1', 'ai1');
  let next = 0;
  async function claim() {
    addMessage(db, { sessionId: 's1', text: '用户 ' + (++next), isMe: true, createdAt: new Date().toISOString() });
    return repo.claimIfIdle('s1', 'user_reply');
  }
  async function reply(changes = []) {
    const run = await claim();
    const result = await repo.commitTurn(run, [
      makeTimelineItem('reasoning', '思维链', new Date().toISOString()),
      makeAssistantItem('分段一', new Date().toISOString()),
      makeAssistantItem('分段二', new Date().toISOString()),
    ], { assistantId: 'ai1', changes });
    assert.equal(result.outcome, 'committed');
    return run;
  }
  await reply([open('memory'), open('neteaseMusic'), open('memory')]);
  assert.deepEqual(await packages(), ['memory', 'neteaseMusic']);
  assert.deepEqual(await new ConversationTurnRepository().listOpenToolPackageIds('s1', 'ai1'), ['memory', 'neteaseMusic'], '重载读取持续展开事实');
  assert.deepEqual(await repo.listOpenToolPackageIds('s2', 'ai1'), []);
  assert.deepEqual(await repo.listOpenToolPackageIds('s1', 'ai2'), []);
  db.prepare('INSERT INTO chat_tool_package_exposure VALUES (?, ?, ?)').run('s2', 'ai1', 'memory');
  db.prepare('INSERT INTO chat_tool_package_exposure VALUES (?, ?, ?)').run('s1', 'ai2', 'memory');
  for (const status of ['cancelled', 'failed']) {
    const run = await claim();
    await repo.revoke(run, status, '测试终态');
    assert.deepEqual(await packages(), ['memory', 'neteaseMusic']);
  }
  const stale = await claim();
  await globalThis.__TEST_TURN_COORDINATOR_HOLDER__.transaction({}, (transaction) => repo.supersedeActiveRunInTransaction(transaction, 's1'));
  assert.equal((await repo.commitTurn(stale, [makeAssistantItem('过期回复', new Date().toISOString())], {
    assistantId: 'ai1', changes: [close('memory'), open('screenCapture')],
  })).outcome, 'fence_failed');
  assert.deepEqual(await packages(), ['memory', 'neteaseMusic'], '过期回合不能打开或关闭包');
  const badRun = await claim();
  // terminal CAS 在开关更新后失败，消息与全部包状态必须一起回滚。
  db.prepare("UPDATE conversation_turn_runs SET status = 'failed' WHERE run_id = ?").run(badRun.runId);
  await assert.rejects(repo.commitTurn(badRun, [makeAssistantItem('回滚回复', new Date().toISOString())], {
    assistantId: 'ai1', changes: [close('memory'), open('screenCapture')],
  }), /期望为 active/u);
  assert.deepEqual(await packages(), ['memory', 'neteaseMusic']);
  db.prepare("UPDATE conversation_turn_runs SET status = 'active' WHERE run_id = ?").run(badRun.runId);
  await repo.revoke(badRun, 'failed', '回滚验证结束');
  const toolRun = await claim();
  await repo.commitTurn(toolRun, [makeTimelineItem('tool', '只提交工具展示', new Date().toISOString())], {
    assistantId: 'ai1', changes: [close('memory'), open('screenCapture')],
  });
  assert.deepEqual(await packages(), ['memory', 'neteaseMusic'], '没有正式回复的展示项不提交包开关');
  for (let index = 0; index < 8; index++) await reply();
  assert.deepEqual(await packages(), ['memory', 'neteaseMusic'], '多轮未调用不会自动收起');
  await reply([open('deviceControl'), close('memory'), open('memory'), close('neteaseMusic')]);
  assert.deepEqual(await packages(), ['deviceControl', 'memory'], '同包先关再开时保持最后一次打开');
  await reply([open('neteaseMusic'), close('neteaseMusic'), close('memory')]);
  assert.deepEqual(await packages(), ['deviceControl'], '先开再关时最终关闭，不影响其他包');
  await reply([open('memory')]);
  assert.deepEqual(await packages(), ['deviceControl', 'memory'], '主动关闭后仍可再次拆包');
  assert.deepEqual(await repo.listOpenToolPackageIds('s2', 'ai1'), ['memory']);
  assert.deepEqual(await repo.listOpenToolPackageIds('s1', 'ai2'), ['memory']);
  db.prepare("DELETE FROM chat_conversations WHERE id = 's1'").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_tool_package_exposure WHERE session_id = 's1'").get().n, 0);
  db.prepare("DELETE FROM ai_assistants WHERE id = 'ai1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_tool_package_exposure').get().n, 0);
  console.log('工具包持久开关：持续保留、主动关闭、操作顺序、分段、隔离、重载、回滚、终态及级联清理通过。');
}

// 日程与普通回复使用同一个持久执行槽；交付尾段和未领取的用户输入也必须阻挡日程。
{
  const db = createBaseDatabase();
  addSession(db, 'schedule-chat');
  await prepareConsumedTurnFixture(createExecutor(db));
  const coordinator = createCoordinator(db);
  globalThis.__TEST_TURN_COORDINATOR_HOLDER__ = coordinator;
  const repo = new ConversationTurnRepository();
  const first = await repo.claimAutonomousIfIdle('schedule-chat', 'schedule-first');
  assert.equal(first.kind, 'autonomous');
  assert.equal(await new ConversationTurnRepository().claimAutonomousIfIdle('schedule-chat', 'schedule-duplicate'), null);
  await repo.finishAutonomous(first);
  assert.equal(getTurnState(db, 'schedule-chat').reply_cursor, 0, '日程完成不推进用户回复游标');

  const interrupted = await repo.claimAutonomousIfIdle('schedule-chat', 'schedule-interrupted');
  await coordinator.transaction({}, async tx => {
    addMessage(db, { sessionId: 'schedule-chat', text: '用户优先', isMe: true, createdAt: new Date().toISOString() });
    assert.equal(await repo.supersedeActiveRunInTransaction(tx, 'schedule-chat'), interrupted.runId);
  });
  assert.equal(await repo.claimAutonomousIfIdle('schedule-chat', 'schedule-before-user-host'), null);
  const user = await repo.claimIfIdle('schedule-chat', 'user_reply');
  await repo.finishAutonomous(interrupted);
  assert.equal(getTurnState(db, 'schedule-chat').active_run_id, user.runId, '旧日程收口不得释放新用户 owner');
  assert.equal(await coordinator.read({}, tx => repo.isRunCurrentInTransaction(tx, interrupted.runId)), false);
  const reply = makeAssistantItem('先回复用户', new Date().toISOString());
  reply.message.sessionId = 'schedule-chat';
  assert.equal((await repo.commitTurn(user, [reply],
    { assistantId: 'ai1', changes: [] })).outcome, 'committed');
  db.prepare("INSERT INTO chat_turn_presentations(run_id, session_id, state, updated_at) VALUES (?, ?, 'open', ?)")
    .run(user.runId, 'schedule-chat', new Date().toISOString());
  assert.equal(await repo.claimAutonomousIfIdle('schedule-chat', 'schedule-during-delivery'), null,
    'T3 已提交但分段未交付完时，日程仍须等待');
  db.prepare("UPDATE chat_turn_presentations SET state = 'completed' WHERE run_id = ?").run(user.runId);
  const afterDelivery = await repo.claimAutonomousIfIdle('schedule-chat', 'schedule-after-delivery');
  assert.ok(afterDelivery);
  const cursor = getTurnState(db, 'schedule-chat').reply_cursor;
  assert.deepEqual(await repo.interruptAbandonedAutonomousRuns([afterDelivery.runId]), []);
  assert.deepEqual(await repo.interruptAbandonedAutonomousRuns([]), ['schedule-chat']);
  assert.equal(getRun(db, afterDelivery.runId).status, 'failed');
  assert.equal(getTurnState(db, 'schedule-chat').reply_cursor, cursor);
  const next = await repo.claimAutonomousIfIdle('schedule-chat', 'schedule-next');
  addMessage(db, { sessionId: 'schedule-chat', text: '进程恢复后的用户消息', isMe: true, createdAt: new Date().toISOString() });
  const recoveredUser = await repo.takeOverOrphan('schedule-chat', 'user_reply');
  assert.equal(recoveredUser.kind, 'user_reply');
  assert.equal(getRun(db, next.runId).status, 'failed', '普通恢复不得重跑日程孤儿');
  await repo.revoke(recoveredUser, 'failed', '测试失败输入');
  assert.ok(await repo.claimAutonomousIfIdle('schedule-chat', 'schedule-after-user-failure'),
    '已明确失败的旧输入不能永久阻挡日程');
  db.close();
}

delete globalThis.__TEST_TURN_COORDINATOR_HOLDER__;

console.log('ConversationTurnCoordinator 第一片：当前回合 fixture 与 T1～T4 行为验证通过。');
console.log('真实 expo-sqlite 迁移与协调器调度仍需 Android 真机 fresh database 验收。');
