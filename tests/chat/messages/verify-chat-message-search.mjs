/** 使用真实 SQLite 验证原文检索、可见范围、身份权限与工具输入边界。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor } from '../../helpers/sqlite-bootstrap-fixture.mjs';


const nativeRequire = createRequire(import.meta.url);
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const raw = createSqliteExecutor(db);
await bootstrapSqlite(raw);
const executor = { ...raw, withExclusiveTransactionAsync: async operation => {
  db.exec('BEGIN');
  try { const value = await operation(raw); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
} };
const cache = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(id => {
    if (id === '@platform/persistence') return { databaseCoordinator: {
      openTaskExecutor: () => executor,
      transaction: (_metadata, operation) => executor.withExclusiveTransactionAsync(operation),
    } };
    if (id === 'expo-crypto') return { randomUUID };
    let target;
    if (id.startsWith('.')) target = path.resolve(path.dirname(filename), id);
    else if (id.startsWith('@shared/')) target = path.join(root, 'src/shared', id.slice(8));
    else return nativeRequire(id);
    return load(fs.existsSync(`${target}.ts`) ? `${target}.ts` : path.join(target, 'index.ts'));
  }, module, module.exports);
  return module.exports;
}
const { MessageRepository } = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts');
const repository = new MessageRepository();
const { buildCallTranscriptSearch, SQLiteCallHistoryRepository } = load('src/features/calls/infrastructure/SQLiteCallHistoryRepository.ts');
load('src/features/chat/messages/application/ChatMessageRuntime.ts').configureChatMessageRuntime({
  messages: repository, callTranscriptSearch: buildCallTranscriptSearch,
});
const { searchChatMessages, searchConversationMessages } = load('src/features/chat/messages/application/SearchChatMessages.ts');
const { SearchChatMessagesTool: tool } = load('src/features/chat/messages/aiTools/SearchChatMessagesTool.ts');
const { readChatMessageContext, readConversationMessageContext } = load('src/features/chat/messages/application/ReadChatMessageContext.ts');
const { ReadChatMessageContextTool: contextTool } = load('src/features/chat/messages/aiTools/ReadChatMessageContextTool.ts');
const { ReadChatFileTool: fileTool } = load('src/features/chat/messages/aiTools/ReadChatFileTool.ts');
const { ChatMessageSearchInputError } = load('src/features/chat/messages/domain/ChatMessageSearch.ts');
const { matchesAgentToolInputSchema } = load('src/shared/aiTools/AgentToolInputSchema.ts');
const at = '2026-10-01T08:00:00.000Z';
for (const id of ['a', 'b']) {
  db.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, `actor-${id}`, `公开名称${id}`, 'test', at, at);
  db.prepare("INSERT INTO chat_conversations(id,kind) VALUES (?,'direct')").run(`private-${id}`);
  db.prepare('INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(`private-${id}`, id, `私人备注${id}`, at, at);
}
db.exec("INSERT INTO chat_conversations(id,kind) VALUES ('group','group')");
db.prepare('INSERT INTO group_chats(id,name,created_at,updated_at) VALUES (?,?,?,?)').run('group', '测试群', at, at);
for (const id of ['a', 'b']) db.prepare(`INSERT INTO group_chat_members
  (id,group_id,ai_assistant_id,agent_id,created_at,updated_at) VALUES (?,'group',?,?,?,?)`).run(`member-${id}`, id, `actor-${id}`, at, at);
function add(text, { conversationId = 'private-a', role = 'assistant', status = 'sent', delivery = 'delivered', metadata = null,
  createdAt = at, agentId = 'actor-a', turnRunId = null, turnItemIndex = null } = {}) {
  return Number(db.prepare(`INSERT INTO messages
    (session_id,text,is_me,sender_type,status,delivery_status,created_at,time,metadata_json,agent_id,turn_run_id,turn_item_index)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(conversationId, text, Number(role === 'user'), role, status, delivery, createdAt, '16:00', metadata && JSON.stringify(metadata), agentId, turnRunId, turnItemIndex).lastInsertRowid);
}
const query = (keywords, extra = {}, assistantId = 'a') => searchChatMessages(assistantId, { conversationId: 'private-a', keywords, ...extra });
const nearby = (messageId, extra = {}, assistantId = 'a') => readChatMessageContext(assistantId, { messageId, ...extra });
const userQuery = (keywords, extra = {}) => searchConversationMessages({ conversationId: 'private-a', keywords, ...extra });
const userNearby = (messageId, conversationId = 'private-a', extra = {}) => readConversationMessageContext(conversationId, { messageId, ...extra });
try {
  const original = add('我说过蓝鲸计划，配色必须是紫色。');
  const userMessage = add('那就用蓝鲸计划。', { role: 'user' });
  // 摘要已越过整段原文；搜索不能依赖 readContext 的剩余窗口。
  db.prepare('INSERT INTO chat_summary_state(conversation_id,processed_cursor) VALUES (?,?)')
    .run('private-a', JSON.stringify([at, userMessage, 0, userMessage]));
  db.prepare("INSERT INTO chat_summary_segments(id,conversation_id,sequence,content,time_zone,created_at,updated_at) VALUES ('summary','private-a',1,'讨论过一个项目，具体措辞未保留','Asia/Shanghai',?,?)").run(at, at);
  assert.deepEqual((await query(['蓝鲸'])).entries.map(entry => entry.messageId), [userMessage, original]);
  assert.deepEqual((await userQuery([' 蓝鲸 '])).entries.map(entry => entry.messageId), [userMessage, original], '用户搜索同样覆盖已总结原文');
  const originalContext = await nearby(original);
  assert.deepEqual(originalContext.entries.map(entry => entry.messageId), [original, userMessage], '已总结原文仍可按 ID 读取语境');
  assert.equal(originalContext.anchorMessageId, original);
  assert.equal(originalContext.hasMoreBefore, false);
  assert.equal(originalContext.hasMoreAfter, false);
  assert.deepEqual((await query(['蓝鲸'])).entries[1].author, { role: 'assistant', name: '公开名称a', assistantId: 'a' });
  assert.equal((await query(['蓝鲸'])).entries[0].author.role, 'user');
  assert.deepEqual((await query(['不存在', '紫色'])).entries.map(entry => entry.messageId), [original]);
  assert.equal((await query(['  紫色  ', '紫色'])).entries[0].text, '我说过蓝鲸计划，配色必须是紫色。');
  add('Tavily_100%');
  assert.equal((await query(['tAvIlY_100%'])).entries.length, 1);
  assert.equal((await query(['%'])).entries.length, 1, '关键词按字面匹配，不作为 LIKE 通配符');
  assert.equal((await userQuery(['tAvIlY_100%'])).entries.length, 1);
  assert.equal((await userQuery(['%'])).entries.length, 1);
  assert.equal((await userQuery(["' OR 1=1 --"])).entries.length, 0);
  assert.equal((await query(["' OR 1=1 --"])).entries.length, 0);
  add('蓝鲸属于另一个 AI', { conversationId: 'private-b', agentId: 'actor-b' });
  assert.equal((await userQuery(['蓝鲸'], { conversationId: 'private-b' })).entries.length, 1, '用户可以搜索任一自己的单聊，不借用当前 AI 身份');
  assert.equal(await userNearby(original, 'private-b'), null, '用户上下文仍严格限制目标会话');
  assert.deepEqual((await query(['蓝鲸'], { conversationId: 'private-b' })).entries, []);
  assert.deepEqual((await query(['蓝鲸'], {}, 'b')).entries, []);
  assert.equal(await nearby(original, {}, 'b'), null, '不能借消息 ID 越权读取其他 AI 单聊');
  const groupMessage = add('蓝鲸是群里的约定', { conversationId: 'group', agentId: 'actor-b' });
  const groupPage = await query(['蓝鲸'], { conversationId: 'group' });
  assert.equal(groupPage.entries[0].messageId, groupMessage);
  assert.deepEqual(groupPage.entries[0].author, { role: 'assistant', name: '公开名称b', assistantId: 'b' });
  const mention = { actorType: 'user', target: { targetType: 'assistant', assistantId: 'b', displayNameAtSend: '私人昵称' } };
  add('@私人昵称 看蓝鲸', { conversationId: 'group', role: 'user', metadata: { groupChat: { mentions: [mention] } } });
  const publicPage = await query(['蓝鲸'], { conversationId: 'group' });
  assert.ok(publicPage.entries[0].text.includes('@公开名称b'));
  assert.ok(!JSON.stringify(publicPage).includes('私人昵称'));
  db.exec("UPDATE ai_assistants SET nickname = '用户备注b' WHERE id = 'b'");
  const userGroupPage = await userQuery(['蓝鲸'], { conversationId: 'group' });
  assert.ok(userGroupPage.entries[0].text.includes('@私人昵称'), '用户看到发送时的原文，不进行模型用的公开称呼转换');
  assert.equal(userGroupPage.entries[1].author.name, '用户备注b');
  assert.equal((await query(['蓝鲸'], { conversationId: 'group' })).entries[1].author.name, '公开名称b', '用户昵称不能泄漏给模型查询');
  const groupContext = await nearby(groupMessage);
  assert.deepEqual(groupContext.entries.map(entry => entry.messageId), publicPage.entries.map(entry => entry.messageId).reverse());
  assert.ok(!JSON.stringify(groupContext).includes('私人昵称'));
  db.exec("UPDATE group_chat_members SET enabled = 0 WHERE id = 'member-a'");
  assert.deepEqual((await query(['蓝鲸'], { conversationId: 'group' })).entries, [], '退出后每次查询重新裁决权限');
  assert.equal(await nearby(groupMessage), null, '退出后不能按 ID 读取群上下文');
  db.exec("UPDATE group_chat_members SET enabled = 0 WHERE group_id = 'group'");
  assert.equal((await userQuery(['蓝鲸'], { conversationId: 'group' })).entries.length, 2, '没有启用 AI 成员时用户仍可以搜索群历史');
  assert.equal((await userNearby(groupMessage, 'group')).anchorMessageId, groupMessage);
  for (const options of [{ role: 'reasoning' }, { role: 'tool' }, { role: 'system' }, { status: 'pending' },
    { status: 'failed' }, { status: 'streaming' }, { delivery: 'cancelled' }]) add('隐藏原文', options);
  assert.equal((await query(['隐藏原文'])).entries.length, 0);
  assert.equal((await userQuery(['隐藏原文'])).entries.length, 0);
  const unshown = add('未交付原文');
  db.prepare(`INSERT INTO conversation_turn_runs
    (run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
    VALUES ('hidden','private-a','user_reply',0,0,0,'active',?)`).run(at);
  db.prepare("INSERT INTO chat_turn_presentations(run_id,session_id,state,updated_at) VALUES ('hidden','private-a','open',?)").run(at);
  db.prepare(`INSERT INTO chat_turn_display_items(run_id,identity,version,snapshot_json,message_id)
    VALUES ('hidden','body',1,?,?)`).run(JSON.stringify({ text: '未交付原文' }), unshown);
  assert.equal((await query(['未交付原文'])).entries.length, 0, '不越过 canonical 交付资格');
  assert.equal(await nearby(unshown), null);
  assert.equal((await userQuery(['未交付原文'])).entries.length, 0);
  assert.equal(await userNearby(unshown), null);
  const beforeClear = add('清除之前的词');
  db.prepare('UPDATE sessions SET visible_after_message_id = ? WHERE id = ?').run(beforeClear, 'private-a');
  assert.equal((await query(['蓝鲸', '清除之前的词'])).entries.length, 0);
  assert.equal(await nearby(original), null, '不能借锚点越过清除边界');
  assert.equal((await userQuery(['蓝鲸', '清除之前的词'])).entries.length, 0);
  assert.equal(await userNearby(original), null);
  const ids = Array.from({ length: 23 }, (_, index) => add(`分页原文 ${index}`));
  const first = await query(['分页原文']);
  assert.deepEqual(first.entries.map(entry => entry.messageId), ids.slice().reverse().slice(0, 20));
  assert.equal(first.nextOffset, 20);
  const second = await query(['分页原文'], { offset: first.nextOffset });
  assert.deepEqual(second.entries.map(entry => entry.messageId), ids.slice(0, 3).reverse());
  assert.equal(second.nextOffset, null);
  // 用户结果多带界面收藏资格；模型结果不携带，避免把 UI 能力写进模型上下文。
  const userFirst = await userQuery(['分页原文']);
  assert.deepEqual(userFirst.entries.map(entry => entry.messageId), first.entries.map(entry => entry.messageId));
  assert.deepEqual((await userQuery(['分页原文'], { offset: 20 })).entries.map(entry => entry.messageId), second.entries.map(entry => entry.messageId));
  assert.equal(userFirst.entries[0].canFavorite, true);
  assert.equal(first.entries[0].canFavorite, undefined);
  assert.ok(!JSON.stringify((await tool.execute({ keywords: ['分页原文'] }, { task: { assistantId: 'a', sessionId: 'private-a' }, abortSignal: new AbortController().signal })).modelContent).includes('canFavorite'));
  db.prepare('DELETE FROM messages WHERE id = ?').run(ids[22]);
  assert.ok(!(await query(['分页原文'])).entries.some(entry => entry.messageId === ids[22]), '删除立即退出后续检索');
  assert.ok(!(await userQuery(['分页原文'])).entries.some(entry => entry.messageId === ids[22]));
  assert.equal(await userNearby(ids[22]), null);
  const dateId = add('时间关键词', { createdAt: '2026-10-02T00:00:00.000Z' });
  assert.equal((await query(['时间关键词'], { from: '2026-10-02T08:00:00+08:00', to: '2026-10-02T08:00:00+08:00' })).entries[0].messageId, dateId);
  assert.equal((await query(['时间关键词'], { to: '2026-10-01T23:59:59Z' })).entries.length, 0);
  const codeBlockId = add('```ts\nconst 蓝鲸 = 1;\n```');
  assert.equal((await userQuery(['蓝鲸'])).entries.find(entry => entry.messageId === codeBlockId).canFavorite, false, '独立代码块消息不提供收藏入口');

  // 同一回复的气泡可以晚于旁路消息落库；附近上下文必须沿 canonical 时间线排列。
  db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('c','actor-c','公开名称c','test',?,?)").run(at, at);
  db.exec("INSERT INTO chat_conversations(id,kind) VALUES ('context','direct')");
  db.prepare("INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('context','c','上下文',?,?)").run(at, at);
  const around = (messageId, extra = {}) => nearby(messageId, extra, 'c');
  const previous = add('上一轮的问题', { conversationId: 'context', role: 'user' });
  db.prepare(`INSERT INTO conversation_turn_runs
    (run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
    VALUES ('context-run','context','user_reply',0,?,0,'committed',?)`).run(previous, at);
  const runMessage = (text, item, createdAt) => add(text, { conversationId: 'context', agentId: 'actor-c', turnRunId: 'context-run', turnItemIndex: item, createdAt });
  const firstBubble = runMessage('当时的前文', 1, '2026-10-02T08:10:00.000Z');
  const following = add('下一轮的问题', { conversationId: 'context', role: 'user', createdAt: '2026-10-02T08:20:00.000Z' });
  const lastBubble = runMessage('后文：刚才那句话并不是承诺', 3, '2026-10-02T08:11:00.000Z');
  const middleBubble = runMessage('需要理解的那句话', 2, '2026-10-02T08:12:00.000Z');
  add('不占上下文条数的思考', { conversationId: 'context', role: 'reasoning', createdAt: '2026-10-02T08:10:30.000Z' });
  const defaults = await around(middleBubble);
  assert.deepEqual(defaults.entries.map(entry => entry.messageId), [previous, firstBubble, middleBubble, lastBubble, following]);
  const narrow = await around(middleBubble, { before: 1, after: 1 });
  assert.deepEqual(narrow.entries.map(entry => entry.messageId), [firstBubble, middleBubble, lastBubble]);
  assert.deepEqual((await userNearby(middleBubble, 'context', { before: 1, after: 1 })).entries.map(entry => entry.messageId), [firstBubble, middleBubble, lastBubble], '用户上下文与聊天时间线顺序一致');
  assert.equal(narrow.hasMoreBefore, true);
  assert.equal(narrow.hasMoreAfter, true);
  assert.deepEqual((await around(middleBubble, { before: 0, after: 0 })).entries.map(entry => entry.messageId), [middleBubble]);
  assert.equal((await around(firstBubble, { before: 0, after: 10 })).hasMoreAfter, false);
  const moreBefore = await around(narrow.entries[0].messageId, { before: 10, after: 0 });
  assert.deepEqual(moreBefore.entries.map(entry => entry.messageId), [previous, firstBubble]);
  db.prepare('DELETE FROM messages WHERE id = ?').run(firstBubble);
  assert.deepEqual((await around(middleBubble, { before: 1, after: 1 })).entries.map(entry => entry.messageId), [previous, middleBubble, lastBubble]);
  db.prepare("UPDATE sessions SET visible_after_message_id = ? WHERE id = 'context'").run(previous);
  assert.equal((await around(middleBubble)).entries.some(entry => entry.messageId === previous), false);
  db.prepare('DELETE FROM messages WHERE id = ?').run(middleBubble);
  assert.equal(await around(middleBubble), null, '锚点删除后不悄悄改读附近另一条消息');
  const windowIds = Array.from({ length: 15 }, (_, index) => add(`窗口消息 ${index}`, {
    conversationId: 'context', agentId: 'actor-c', createdAt: '2026-10-03T00:00:00.000Z',
  }));
  assert.deepEqual((await around(windowIds[7])).entries.map(entry => entry.messageId), windowIds.slice(4, 11), '省略条数默认前后各3条');
  assert.deepEqual((await userNearby(windowIds[7], 'context')).entries.map(entry => entry.messageId), [lastBubble, following, ...windowIds], '用户默认前后各10条，也包含窗口之前仍可见的消息');

  // 采用候选会替换 canonical 消息；旧快照不能混入附近上下文，旧 ID 也不能复活正文。
  db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('d','actor-d','公开名称d','test',?,?)").run(at, at);
  db.exec("INSERT INTO chat_conversations(id,kind) VALUES ('versions','direct')");
  db.prepare("INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('versions','d','重写版本',?,?)").run(at, at);
  const versionInput = add('请选择一种颜色', { conversationId: 'versions', role: 'user' });
  db.prepare(`INSERT INTO conversation_turn_runs
    (run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
    VALUES ('version-run','versions','user_reply',0,?,0,'committed',?)`).run(versionInput, at);
  db.prepare("INSERT INTO conversation_turn_state(session_id,reply_cursor,revision,updated_at) VALUES ('versions',?,0,?)").run(versionInput, at);
  const selectedId = add('采用版本：红色', { conversationId: 'versions', agentId: 'actor-d', turnRunId: 'version-run', turnItemIndex: 1 });
  const selected = await repository.getMessageById(selectedId);
  const { saveReplyVersion } = load('src/features/chat/reply/infrastructure/ChatReplyVersionSql.ts');
  db.exec("INSERT INTO chat_reply_version_sets(id,session_id,current_run_id,selected_version_id) VALUES ('version-set','versions','version-run','version-run')");
  await executor.withExclusiveTransactionAsync(async tx => {
    await saveReplyVersion(tx, 'version-set', 'version-run', [selected]);
    await saveReplyVersion(tx, 'version-set', 'candidate', [{ ...selected, text: '候选版本：蓝色' }]);
  });
  assert.deepEqual((await nearby(selectedId, {}, 'd')).entries.map(entry => entry.text), ['请选择一种颜色', '采用版本：红色']);
  const { ConversationTurnRepository } = load('src/features/chat/reply/infrastructure/SQLiteConversationTurnRepository.ts');
  await new ConversationTurnRepository().adoptReplyVersion('versions', 'version-run', 'candidate', 'version-run');
  const adopted = (await query(['候选版本'], { conversationId: 'versions' }, 'd')).entries[0];
  assert.equal(adopted.text, '候选版本：蓝色');
  assert.equal((await query(['采用版本'], { conversationId: 'versions' }, 'd')).entries.length, 0);
  assert.equal(await nearby(selectedId, {}, 'd'), null);
  assert.deepEqual((await nearby(adopted.messageId, {}, 'd')).entries.map(entry => entry.text), ['请选择一种颜色', '候选版本：蓝色']);
  assert.equal((await userQuery(['采用版本'], { conversationId: 'versions' })).entries.length, 0);
  assert.deepEqual((await userNearby(adopted.messageId, 'versions')).entries.map(entry => entry.text), ['请选择一种颜色', '候选版本：蓝色']);
  for (const invalid of [{ keywords: ['   '] }, { from: 'invalid' }, { from: '2026-10-03', to: '2026-10-01' }]) {
    assert.throws(() => query(['蓝鲸'], invalid), ChatMessageSearchInputError);
    assert.throws(() => userQuery(['蓝鲸'], invalid), ChatMessageSearchInputError);
  }
  assert.ok(matchesAgentToolInputSchema({ keywords: ['紫色'] }, tool.definition.parameters));
  for (const invalid of [{}, { keywords: [] }, { keywords: [''] }, { keywords: ['蓝鲸'], assistantId: 'b' }, { keywords: ['蓝鲸'], offset: -1 }]) {
    assert.ok(!matchesAgentToolInputSchema(invalid, tool.definition.parameters));
  }
  const context = { task: { assistantId: 'a', sessionId: 'private-a' }, abortSignal: new AbortController().signal };
  const result = await tool.execute({ keywords: ['时间关键词'] }, context);
  assert.equal(result.status, 'success');
  assert.equal(result.data.entries[0].messageId, dateId);
  assert.ok(JSON.parse(result.modelContent).notice);
  assert.deepEqual((await tool.execute({ keywords: ['蓝鲸'], conversationId: 'private-b' }, context)).data.entries, []);
  assert.equal((await tool.execute({ keywords: ['  '] }, context)).code, 'CHAT_MESSAGE_SEARCH_INPUT_ERROR');
  assert.equal((await tool.execute({ keywords: ['蓝鲸'] }, { ...context, task: { assistantId: 'a' } })).status, 'error');
  assert.ok(matchesAgentToolInputSchema({ messageId: dateId }, contextTool.definition.parameters));
  assert.ok(matchesAgentToolInputSchema({ messageId: dateId, before: 0, after: 10 }, contextTool.definition.parameters));
  for (const invalid of [{}, { messageId: 0 }, { messageId: dateId, before: -1 }, { messageId: dateId, after: 11 },
    { messageId: dateId, after: 1.5 }, { messageId: dateId, assistantId: 'b' }]) {
    assert.equal(matchesAgentToolInputSchema(invalid, contextTool.definition.parameters), false);
  }
  const toolContext = await contextTool.execute({ messageId: dateId }, context);
  assert.equal(toolContext.status, 'success');
  assert.equal(toolContext.data.anchorMessageId, dateId);
  assert.ok(JSON.parse(toolContext.modelContent).notice);
  assert.equal((await contextTool.execute({ messageId: original }, context)).code, 'CHAT_MESSAGE_NOT_AVAILABLE');
  assert.equal((await contextTool.execute({ messageId: dateId }, { ...context, task: { assistantId: 'b' } })).code, 'CHAT_MESSAGE_NOT_AVAILABLE');

  const firstFilePage = '字'.repeat(3_999) + '🙂';
  const secondFilePage = '详细内容';
  const file = { id: 'notes', type: 'file', fileName: '回顾.txt', source: 'clipboard', mediaAssetId: 'asset-notes',
    parsedText: firstFilePage + secondFilePage };
  const fileTime = '2026-10-10T03:00:00.000Z';
  const fileMessage = add('', { role: 'user', createdAt: fileTime, metadata: { kind: 'file', attachments: [file] } });
  const fileInput = { messageId: fileMessage, attachmentId: file.id };
  const fileMatch = (await query(['回顾.txt'])).entries[0];
  assert.equal(fileMatch.messageId, fileMessage);
  assert.deepEqual(fileMatch.attachments, [{ attachmentId: 'notes', type: 'file', fileName: '回顾.txt' }]);
  assert.ok(!JSON.stringify(fileMatch).includes(file.parsedText));
  const { projectChatContextMessage } = load('src/features/chat/summary/domain/ChatContext.ts');
  const pastFile = projectChatContextMessage(await repository.getMessageById(fileMessage), [fileTime, fileMessage, 0, fileMessage]);
  assert.ok(pastFile.content.includes(`messageId=${fileMessage}；attachmentId=notes`));
  assert.ok(!pastFile.content.includes(file.parsedText), '历史提示词只携带文件引用');
  assert.equal((await userNearby(fileMessage)).entries.find(entry => entry.messageId === fileMessage).userAttachments[0].mediaAssetId, file.mediaAssetId);
  const firstRead = await fileTool.execute(fileInput, context);
  assert.equal(firstRead.data.text, firstFilePage);
  assert.equal(firstRead.data.nextOffset, 4_000);
  assert.equal(JSON.parse(firstRead.modelContent).text, firstFilePage);
  const nextRead = { ...fileInput, offset: firstRead.data.nextOffset };
  assert.ok(matchesAgentToolInputSchema(nextRead, fileTool.definition.parameters));
  assert.equal(matchesAgentToolInputSchema({ ...fileInput, offset: -1 }, fileTool.definition.parameters), false);
  const lastRead = await fileTool.execute(nextRead, context);
  assert.equal(lastRead.data.text, secondFilePage);
  assert.equal(lastRead.data.nextOffset, null);
  assert.equal((await fileTool.execute(nextRead, { ...context, task: { assistantId: 'b' } })).code, 'CHAT_FILE_NOT_AVAILABLE');

  const callTime = '2026-10-10T04:00:00.000Z', endTime = '2026-10-10T05:00:00.000Z';
  db.prepare(`INSERT INTO call_sessions(id,chat_session_id,ai_assistant_id,agent_id,direction,state,requested_mode,
    active_mode,source,started_at,accepted_at,ended_at,created_at,updated_at)
    VALUES ('c-history','private-a','a','actor-a','outgoing','ended','video','video','user',?,?,?,?,?)`)
    .run(callTime, callTime, endTime, callTime, endTime);
  db.exec("INSERT INTO call_history(call_id,assistant_id,title) VALUES ('c-history','a','回顾')");
  const status = add('【通话时间：01:00:00】', { role: 'user', createdAt: endTime,
    metadata: { type: 'callStatus', callId: 'c-history', callStatus: 'callDuration', direction: 'outgoing' } });
  assert.equal((await nearby(status, { before: 0, after: 0 })).entries[0].callId, 'c-history');
  const writeCallLine = db.prepare(`INSERT INTO call_history_entries(id,call_id,speaker,input_kind,text,created_at)
    VALUES (?,'c-history','user','text',?,?)`);
  for (let i = 0; i < 22; i++) writeCallLine.run(`line-${i}`, `回顾这通电话 ${i}`, new Date(Date.parse(callTime) + i * 1000).toISOString());
  const firstPage = await query(['回顾']);
  assert.equal(firstPage.entries.length, 20);
  assert.equal(firstPage.entries[0].source, 'call');
  assert.equal(firstPage.entries[0].callId, 'c-history');
  const secondPage = await userQuery(['回顾'], { offset: firstPage.nextOffset });
  assert.deepEqual(secondPage.entries.map(entry => entry.source ?? entry.messageId), ['call', 'call', fileMessage]);
  assert.deepEqual((await query(['回顾'], {}, 'b')).entries, []);
  const callHistory = new SQLiteCallHistoryRepository();
  const callPage = await callHistory.readHistoryPage('c-history', 'a', 0);
  assert.equal(callPage.entries[0].text, '回顾这通电话 0');
  assert.equal((await callHistory.readHistoryPage('c-history', 'a', callPage.nextOffset)).entries.length, 2);
  assert.equal(await callHistory.readHistoryPage('c-history', 'b', 0), null);
  db.exec("DELETE FROM call_history WHERE call_id = 'c-history'");
  assert.equal(await callHistory.readHistoryPage('c-history', 'a', 0), null);
  assert.deepEqual((await query(['回顾'])).entries.map(entry => entry.messageId), [fileMessage]);
  db.prepare('DELETE FROM messages WHERE id = ?').run(fileMessage);
  assert.equal((await fileTool.execute(fileInput, context)).code, 'CHAT_FILE_NOT_AVAILABLE');

  const cancelled = new AbortController(); cancelled.abort(new Error('已取消'));
  await assert.rejects(tool.execute({ keywords: ['蓝鲸'] }, { ...context, abortSignal: cancelled.signal }), /已取消/);
  await assert.rejects(contextTool.execute({ messageId: dateId }, { ...context, abortSignal: cancelled.signal }), /已取消/);
  const getAll = raw.getAllAsync;
  raw.getAllAsync = async () => { throw new Error('SQLite read failed'); };
  await assert.rejects(tool.execute({ keywords: ['蓝鲸'] }, context), /SQLite read failed/, '读取失败不能冒充未命中');
  await assert.rejects(contextTool.execute({ messageId: dateId }, context), /SQLite read failed/, '上下文读取失败不能冒充锚点不存在');
  await assert.rejects(userQuery(['蓝鲸']), /SQLite read failed/);
  await assert.rejects(userNearby(dateId), /SQLite read failed/);
  raw.getAllAsync = getAll;
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('聊天原文检索通过：用户与 AI 单聊／群聊检索、分页与上下文、摘要后回查、删除清除、交付资格、权限与昵称隔离。');
} finally { db.close(); }
