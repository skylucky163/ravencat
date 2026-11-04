/** 真实 SQLite 关闭/重开连接验证原始快照、持久交付和中断边界，不重放模型或工具。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { INDEXES } from './helpers/sqlite-bootstrap-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
let database;
const executor = {
  async runAsync(sql, params = []) { return database.prepare(sql).run(...params); },
  async getFirstAsync(sql, params = []) { return database.prepare(sql).get(...params) ?? null; },
  async getAllAsync(sql, params = []) { return database.prepare(sql).all(...params); },
};
const coordinator = {
  async transaction(_meta, operation) {
    database.exec('BEGIN IMMEDIATE');
    try { const value = await operation(executor); database.exec('COMMIT'); return value; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  },
  read: (_meta, operation) => operation(executor),
  openTaskExecutor: () => executor,
};
function load(file) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === '@platform/persistence') return { databaseCoordinator: coordinator };
    throw new Error(`未预期依赖 ${name}`);
  }, module, module.exports);
  return module.exports;
}
const schema = load('src/platform/persistence/sqlite/chatTurnPresentationSchema.ts');
const { ChatTurnPresentationRepository } = load('src/features/chat/reply/infrastructure/SQLiteChatTurnPresentationRepository.ts');
const { interruptTurnPresentationsInTransaction } = load('src/features/chat/reply/infrastructure/ChatTurnPresentationSql.ts');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-presentation-'));
const filename = path.join(directory, 'history.sqlite');
try {
  database = new DatabaseSync(filename);
  database.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE chat_conversations(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, visible_after_message_id INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, client_message_id TEXT);
    CREATE TABLE conversation_turn_runs(run_id TEXT PRIMARY KEY, session_id TEXT, status TEXT,
      revision_at_claim INTEGER, input_high_watermark INTEGER, created_at TEXT, kind TEXT DEFAULT 'user_reply');
    CREATE TABLE conversation_turn_state(session_id TEXT PRIMARY KEY, active_run_id TEXT, revision INTEGER, reply_cursor INTEGER);
    INSERT INTO chat_conversations VALUES ('s'); INSERT INTO sessions VALUES ('s', 0);
    INSERT INTO conversation_turn_runs(run_id,session_id,status,revision_at_claim,input_high_watermark,created_at) VALUES ('r', 's', 'active', 2, 10, '2026-10-15');
    INSERT INTO conversation_turn_state VALUES ('s', 'r', 2, 0);`);
  database.exec(schema.CHAT_TURN_PRESENTATIONS_SCHEMA);
  database.exec(INDEXES.idxMessagesSessionClientMessage);
  const repository = new ChatTurnPresentationRepository();
  assert.equal(await repository.open({ runId: 'r' }), true);
  const item = (version, text, sequence = 1, kind = 'reasoning') => ({ version, snapshot: {
    runId: 'r', sequence, stepIndex: 1, kind, status: 'streaming', text,
    clientMessageId: `agent-timeline:r:${sequence}:0`, createdAt: '2026-10-15', time: '12:00',
  } });
  const shown = item(1, '已经展示的前缀');
  const hidden = item(2, '已经展示的前缀，尚未展示的后缀');
  await repository.checkpoint('r', [shown]);
  assert.equal((await repository.listHistory('s'))[0].items.length, 0);
  await repository.publishVersions('r', [shown]);
  await repository.checkpoint('r', [hidden, item(3, '未交付正文', 2, 'assistant')]);
  await coordinator.transaction({}, tx => interruptTurnPresentationsInTransaction(tx, 's', 'new_input'));
  assert.equal(await repository.checkpoint('r', [item(4, '迟到输出')]), false);
  assert.equal(await repository.publishVersions('r', [hidden]), false);
  database.close();
  database = new DatabaseSync(filename);
  const restored = await new ChatTurnPresentationRepository().listHistory('s');
  assert.equal(restored[0].state, 'interrupted');
  assert.deepEqual(restored[0].items, [shown]);
  const owner = database.prepare('SELECT * FROM conversation_turn_state').get();
  assert.equal(owner.revision, 2);
  assert.equal(owner.reply_cursor, 0);
  // canonical 发布版本与完成状态必须同一事务；终态写失败不能泄漏可见内容。
  database.exec(`UPDATE chat_turn_presentations SET state = 'open' WHERE run_id = 'r';
    UPDATE conversation_turn_runs SET status = 'committed' WHERE run_id = 'r';
    INSERT INTO messages(id) VALUES (11);
    UPDATE chat_turn_display_items SET message_id = 11 WHERE identity = 'agent-timeline:r:2:0';
    CREATE TRIGGER reject_completion BEFORE UPDATE OF state ON chat_turn_presentations
      WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'completion-rejected'); END;`);
  await assert.rejects(repository.publishMessage(11), /completion-rejected/);
  assert.equal(database.prepare('SELECT shown_json FROM chat_turn_display_items WHERE message_id = 11').get().shown_json, null);
  database.exec('DROP TRIGGER reject_completion');
  assert.deepEqual(await repository.publishMessage(11), item(3, '未交付正文', 2, 'assistant'));
  assert.equal(database.prepare("SELECT state FROM chat_turn_presentations WHERE run_id = 'r'").get().state, 'completed');
  assert.equal(await repository.publishMessage(11), null, '终态后的迟到发布不能取得新资格');
  // client identity 的消息归属包含会话，其他会话的同名来源不能改变历史窗口或清空边界。
  database.exec(`INSERT INTO chat_conversations VALUES ('other'); INSERT INTO sessions VALUES ('other', 0);
    INSERT INTO conversation_turn_runs(run_id,session_id,status,revision_at_claim,input_high_watermark,created_at,kind)
      VALUES ('autonomous', 's', 'failed', 2, 0, '2026-10-16', 'autonomous');
    INSERT INTO chat_turn_presentations(run_id,session_id,state,updated_at)
      VALUES ('autonomous', 's', 'interrupted', '2026-10-16');
    INSERT INTO messages(id,session_id,client_message_id) VALUES
      (30, 's', 'agent_activity:autonomous:started'),
      (40, 'other', 'agent_activity:autonomous:started');`);
  const autonomousItem = { ...item(1, '已经交付的自主正文', 1, 'assistant'), snapshot: {
    ...item(1, '已经交付的自主正文', 1, 'assistant').snapshot,
    runId: 'autonomous', clientMessageId: 'agent-timeline:autonomous:1:0',
  } };
  database.prepare(`INSERT INTO chat_turn_display_items(run_id,identity,version,snapshot_json,shown_version,shown_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run('autonomous', autonomousItem.snapshot.clientMessageId, 1,
    JSON.stringify(autonomousItem.snapshot), 1, JSON.stringify(autonomousItem.snapshot));
  assert.equal((await repository.listHistory('s')).filter(run => run.runId === 'autonomous').length, 1,
    '同名来源不能重复注入自主历史');
  assert.deepEqual(await repository.listHistory('s', { fromMessageId: 35, runIds: [] }), [],
    '其他会话更晚的来源不能把旧运行带入当前历史窗口');
  assert.equal((await repository.listHistory('s', { fromMessageId: 35, runIds: ['autonomous'] }))[0].runId, 'autonomous',
    '窗口显式包含的运行仍可恢复');
  const autonomousContext = await repository.listInterruptedContext('s', 0);
  assert.equal(autonomousContext.length, 1);
  assert.equal(autonomousContext[0].inputHighWatermark, 30, '中断上下文以本会话来源定位');
  database.exec("UPDATE sessions SET visible_after_message_id = 30 WHERE id = 's'");
  assert.deepEqual(await repository.listHistory('s', { fromMessageId: 0, runIds: ['autonomous'] }), [],
    '清空后的可见边界不被其他会话来源或显式运行身份绕过');
  assert.deepEqual(await repository.listInterruptedContext('s', 0), []);
  console.log('Chat 展示持久化：原始快照与交付分离、中断封口、迟到版本、重开数据库及游标隔离通过。');
} finally {
  database?.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true });
}
