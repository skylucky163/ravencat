/** 用真实 SQLite 聚合验证统计口径，不冻结源码形状。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';


const db = new DatabaseSync(':memory:');
const executor = { getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null };
const stubs = {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => executor } },
};
const cache = new Map();
function load(relativePath) {
  const file = path.resolve(root, relativePath);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = (specifier) => {
    if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
    return load(path.resolve(path.dirname(file), `${specifier}.ts`));
  };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}

db.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, session_id TEXT, text TEXT, sender_type TEXT,
    created_at TEXT, status TEXT, delivery_status TEXT, metadata_json TEXT,
    turn_run_id TEXT, logical_message_id TEXT, api_message_id TEXT,
    tokens_used INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER
  );
  CREATE TABLE sessions (id TEXT PRIMARY KEY, visible_after_message_id INTEGER);
  INSERT INTO sessions VALUES ('chat', 0);
  CREATE TABLE chat_summary_segments (conversation_id TEXT, content TEXT);
  INSERT INTO chat_summary_segments VALUES ('chat', '摘要不参与条数、字数或 token 统计');
`);
const { MessageRepository } = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts');
const { buildChatStatistics, getEncounterDays } = load('src/features/chat/messages/domain/ChatRecordStatistics.ts');
const messages = new MessageRepository();
const insert = db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
let id = 0;
function add({ session = 'chat', text = '', role = 'assistant', at = '2026-10-02T08:30:00Z', status = 'sent', delivery = 'delivered', metadata = {}, run = null, logical = null, api = null, tokens = 0, prompt = 0, completion = 0 } = {}) {
  insert.run(++id, session, text, role, at, status, delivery, JSON.stringify(metadata), run, logical, api, tokens, prompt, completion);
  return id;
}
try {
  assert.deepEqual({ ...await messages.getChatRecordStatistics('empty') }, {
    userMessageCount: 0, assistantMessageCount: 0,
    userCharacterCount: 0, assistantCharacterCount: 0, totalTokens: 0,
    promptTokens: 0, completionTokens: 0, assistantRepliesWithoutUsage: 0,
  });
  // 用户逐条计数，即使共享逻辑 ID；Unicode 非 BMP 字符按一个字计。
  add({ role: 'user', text: '你好🙂', logical: 'user-batch', at: '2026-10-01 00:00:00' });
  add({ role: 'user', text: '再聊', logical: 'user-batch' });
  // 历史 AI 分段合并，末段才记录用量。
  add({ text: '第一', logical: 'segments' });
  const segmentTail = add({ text: '第二', logical: 'segments', tokens: 30, prompt: 20, completion: 10 });
  // 完整 Agent run 多个模型回合计一条，前言和工具状态重复的用量只累计一次。
  add({ text: '让我查查', run: 'run', api: 'call-1', metadata: { stepIndex: 0 }, tokens: 100, prompt: 80, completion: 20 });
  add({ text: '工具状态', role: 'system', run: 'run', api: 'call-1', metadata: { type: 'toolStatus', stepIndex: 0 }, tokens: 100, prompt: 80, completion: 20 });
  add({ text: '思考不算字数', role: 'reasoning', run: 'run' });
  add({ text: '答案', run: 'run', api: 'call-2', metadata: { stepIndex: 1 }, tokens: 50, prompt: 35, completion: 15 });
  add({ text: '转写', run: 'run', metadata: { kind: 'voice' } });
  // 旧 Agent 记录只保留 metadata 的 run ID，仍按整次回复归并；没有 token 时明确计缺失。
  add({ text: '旧前言', metadata: { replyRunId: 'old-run' } });
  add({ text: '旧回答', metadata: { replyRunId: 'old-run' } });
  add({ text: '', metadata: { kind: 'sticker' } });
  // 同 run 工具独占的调用用量应累计，即使没有 assistant 前言。
  add({ role: 'system', run: 'run', api: 'call-3', metadata: { type: 'toolStatus', stepIndex: 2 }, tokens: 12, prompt: 10, completion: 2 });
  add({ text: '状态卡', metadata: { type: 'callStatus' } });
  add({ text: '错误', metadata: { kind: 'error' } });
  add({ text: '还在流式生成', status: 'streaming' });
  add({ text: '发送失败', status: 'failed' });
  add({ text: '取消的分段', delivery: 'cancelled' });
  add({ session: 'other', text: '另一位AI', tokens: 999 });
  const statistics = await messages.getChatRecordStatistics('chat');
  assert.equal(statistics.userMessageCount, 2);
  assert.equal(statistics.assistantMessageCount, 4);
  assert.equal(statistics.userCharacterCount, 5);
  assert.equal(statistics.assistantCharacterCount, 18);
  assert.equal(statistics.totalTokens, 192);
  assert.equal(statistics.promptTokens, 145);
  assert.equal(statistics.completionTokens, 47);
  assert.equal(statistics.assistantRepliesWithoutUsage, 2);
  // 清除历史只是展示边界，隐藏但仍保存的原文继续计入。
  db.exec(`UPDATE sessions SET visible_after_message_id = 1000 WHERE id = 'chat'`);
  assert.deepEqual(await messages.getChatRecordStatistics('chat'), statistics);
  // 删除原文会影响统计，不从永久摘要中补数。
  db.prepare('DELETE FROM messages WHERE id = ?').run(segmentTail);
  const afterDelete = await messages.getChatRecordStatistics('chat');
  assert.equal(afterDelete.assistantMessageCount, 4);
  assert.equal(afterDelete.assistantCharacterCount, 16);
  assert.equal(afterDelete.totalTokens, 162);
  assert.equal(afterDelete.assistantRepliesWithoutUsage, 3);
  // 总用量未存但输入／输出已存时使用两者之和，不编造分项。
  add({ session: 'split-usage', prompt: 8, completion: 3 });
  assert.equal((await messages.getChatRecordStatistics('split-usage')).totalTokens, 11);
  // 模型未提供 API 消息 ID 时，持久 run + step 仍能区分循环中的独立调用。
  add({ session: 'no-api', run: 'no-api-run', metadata: { stepIndex: 0 }, tokens: 20 });
  add({ session: 'no-api', role: 'system', run: 'no-api-run', metadata: { type: 'toolStatus', stepIndex: 0 }, tokens: 20 });
  add({ session: 'no-api', run: 'no-api-run', metadata: { stepIndex: 1 }, tokens: 10 });
  // 表情条目承接的内部终轮用量保留独立归属，不与该 step 的工具用量合并。
  add({ session: 'no-api', run: 'no-api-run', metadata: { kind: 'sticker', stepIndex: 0 }, tokens: 5 });
  const noApi = await messages.getChatRecordStatistics('no-api');
  assert.equal(noApi.assistantMessageCount, 1);
  assert.equal(noApi.totalTokens, 35);
  // 更早记录没有 run 时，同会话中的稳定 API 调用 ID 仍可识别重复 usage。
  add({ session: 'legacy-api', api: 'legacy-call', tokens: 20 });
  add({ session: 'legacy-api', role: 'system', api: 'legacy-call', metadata: { type: 'toolStatus' }, tokens: 20 });
  assert.equal((await messages.getChatRecordStatistics('legacy-api')).totalTokens, 20);
  // 工具失败／仍在运行时，模型已完成的调用用量不会因此消失；正文条数仍只计已发送。
  add({ session: 'tool-outcome', run: 'tool-run', role: 'system', status: 'failed', api: 'failed-tool-call', metadata: { type: 'toolStatus' }, tokens: 20 });
  add({ session: 'tool-outcome', run: 'tool-run', role: 'system', status: 'streaming', api: 'running-tool-call', metadata: { type: 'toolStatus' }, tokens: 10 });
  add({ session: 'tool-outcome', run: 'tool-run', text: '最终答案', api: 'final-call', tokens: 5 });
  const toolOutcome = await messages.getChatRecordStatistics('tool-outcome');
  assert.equal(toolOutcome.totalTokens, 35);
  assert.equal(toolOutcome.assistantMessageCount, 1);
  assert.equal(toolOutcome.assistantCharacterCount, 4);
  // 自主执行不算 AI 发言，但模型用量仍计入；前言与同轮工具状态只计算一次。
  add({ session: 'wake', role: 'system', run: 'wake-run', api: 'wake-model', tokens: 20,
    metadata: { type: 'agentActivity', phase: 'assistant', stepIndex: 1 } });
  add({ session: 'wake', role: 'system', run: 'wake-run', api: 'wake-model', tokens: 20,
    metadata: { type: 'toolStatus', stepIndex: 1 } });
  add({ session: 'wake', role: 'system', run: 'wake-run', api: 'wake-final', tokens: 10,
    metadata: { type: 'agentActivity', phase: 'assistant', stepIndex: 2 } });
  const wakeStatistics = await messages.getChatRecordStatistics('wake');
  assert.equal(wakeStatistics.assistantMessageCount, 0);
  assert.equal(wakeStatistics.assistantCharacterCount, 0);
  assert.equal(wakeStatistics.totalTokens, 30);
  // 相遇时间来自 AI 创建事实；没有消息、清除历史或删除原文都不改变它。
  const createdAt = '2026-09-30T12:00:00.000Z';
  for (const records of [statistics, afterDelete, await messages.getChatRecordStatistics('empty')]) {
    assert.equal(buildChatStatistics(records, createdAt).encounterStartedAt, createdAt);
  }
  assert.equal(getEncounterDays('2026-10-01T00:00:00Z', Date.parse('2026-10-02T00:00:00Z')), 1);
  assert.equal(getEncounterDays('2026-10-01T00:00:00Z', Date.parse('2026-10-01T23:59:59Z')), 0);
  assert.equal(getEncounterDays('2026-10-02T00:00:00Z', Date.parse('2026-10-01T00:00:00Z')), 0);
  const originalRead = executor.getFirstAsync;
  executor.getFirstAsync = async () => { throw new Error('读取失败'); };
  await assert.rejects(messages.getChatRecordStatistics('chat'), /读取失败/);
  executor.getFirstAsync = originalRead;
  console.log('聊天统计验证通过：真实原文、分段／run 归并、Unicode 字数、调用用量去重、固定 AI 创建时间及读取失败。');
} finally {
  db.close();
}
