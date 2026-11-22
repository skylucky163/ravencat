/** 验证重写的持久 owner、原输入、原子替换与页面隐藏；不访问用户数据库。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { installChatTimelineSchema } from '../../helpers/chat-timeline-fixture.mjs';


const require = createRequire(import.meta.url);
const db = new DatabaseSync(':memory:');
let writer = Promise.resolve();
const executor = {
  execAsync: async (sql) => db.exec(sql),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  runAsync: async (sql, params = []) => {
    const result = db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  },
};
const databaseCoordinator = {
  read: async (_metadata, work) => work(executor),
  transaction(_metadata, work) {
    const next = writer.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await work(executor); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    writer = next.catch(() => {});
    return next;
  },
  openTaskExecutor: () => ({ ...executor, withExclusiveTransactionAsync: (work) => databaseCoordinator.transaction({}, work) }),
};
const notices = [];
const releases = [];
const mocks = {
  '@shared/theme/themeStorage': {},
  '@shared/theme/themeRegistry': {},
  '@shared/theme/themeVariants': {},
  '@platform/persistence': { databaseCoordinator },
  '@features/media': { releaseMediaAssetCandidates: async (ids) => releases.push(ids) },
  '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline() {} },
  '@features/assistants': { aiAssistantRepository: {} },
  '@platform/device': {},
  'react': require('react'),
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-native': { ToastAndroid: { SHORT: 0, LONG: 1, show: (text) => notices.push(text) } },
};
const overrides = new Map();
const cache = new Map();
function load(relative) {
  let file = path.resolve(root, relative);
  if (!path.extname(file)) file = fs.existsSync(`${file}.ts`) ? `${file}.ts` : fs.existsSync(`${file}.tsx`) ? `${file}.tsx` : path.join(file, 'index.ts');
  if (overrides.has(file)) return overrides.get(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: file,
  }).outputText;
  new Function('require', 'module', 'exports', code)((id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id === '@shared/runtime/RuntimeSlot') return load('src/shared/runtime/RuntimeSlot.ts');
    assert.ok(id.startsWith('.'), `缺少环境依赖 ${id}`);
    return load(path.resolve(path.dirname(file), id));
  }, module, module.exports);
  return module.exports;
}
const override = (relative, value) => overrides.set(path.resolve(root, relative), value);
const { SCHEMAS, INDEXES } = load('src/platform/persistence/sqlite/schema.ts');
db.exec(`PRAGMA foreign_keys = ON;
  CREATE TABLE chat_conversations(id TEXT PRIMARY KEY, kind TEXT NOT NULL);
  CREATE TABLE ai_assistants(id TEXT PRIMARY KEY, agent_id TEXT, deleted_at TEXT);
  INSERT INTO ai_assistants(id, agent_id) VALUES ('ai', 'agent-ai');
  CREATE TABLE sessions(id TEXT PRIMARY KEY, last_message TEXT, last_time TEXT, updated_at TEXT, visible_after_message_id INTEGER, visible_after_at TEXT, ai_assistant_id TEXT DEFAULT 'ai');
  CREATE TABLE media_assets(id TEXT PRIMARY KEY);
`);
db.exec(SCHEMAS.messages);
installChatTimelineSchema(db);
db.exec(SCHEMAS.chatToolPackageExposure);
db.exec(INDEXES.idxTurnRunsSingleActive);
db.exec(INDEXES.idxMessagesTurnItem);
const { migrateChatRegeneration } = load('src/platform/persistence/sqlite/chatRegenerationSchema.ts');
await migrateChatRegeneration(executor);
await migrateChatRegeneration(executor);
const { messageRepository: messages } = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts');
const { conversationTurnRepository: turns } = load('src/features/chat/reply/infrastructure/SQLiteConversationTurnRepository.ts');
const events = load('src/features/chat/messages/events/ChatEvents.ts');
const runtime = load('src/features/chat/messages/application/ChatMessageRuntime.ts');
const display = load('src/features/chat/reply/application/ChatTurnPresentationRuntime.ts');
display.configureChatTurnPresentation(load('src/features/chat/reply/infrastructure/SQLiteChatTurnPresentationRepository.ts').chatTurnPresentationRepository);
display.configureTurnDisplayPacing(async () => true, async () => {}, async () => {}, async () => {});
const turnPresentation = { freeze: display.freezeTurnDisplays, interrupt: display.interruptSessionTurnDisplays };
const time = '2026-10-09T10:00:00.000Z';
const ai = { id: 'ai', agentId: 'agent-ai', name: 'AI', model: 'current-model', apiKey: '', apiBaseUrl: '', enableTools: true };
const makeMessage = (sessionId, text, extra = {}) => ({
  sessionId, text, senderType: 'assistant', isMe: false, createdAt: time, time: '18:00', status: 'sent', ...extra,
});
const commit = (run, values) => turns.commitTurn(run, values.map((message) => ({ message })), { assistantId: 'ai', changes: [] });
async function initial(sessionId) {
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
  db.prepare('INSERT INTO sessions(id, last_message, last_time, updated_at) VALUES (?, ?, ?, ?)').run(sessionId, '', time, time);
  db.prepare('INSERT INTO media_assets VALUES (?)').run(`audio-${sessionId}`);
  await databaseCoordinator.transaction({}, (tx) => turns.ensureTurnStateRowInTransaction(tx, sessionId));
  const users = await messages.commitMessages({ messages: [
    makeMessage(sessionId, '第一条用户输入', { isMe: true, senderType: 'user' }),
    makeMessage(sessionId, '第二条用户输入', { isMe: true, senderType: 'user' }),
  ], previewText: '第二条用户输入' });
  const source = await turns.claimIfIdle(sessionId, 'user_reply');
  const result = await commit(source, [
    makeMessage(sessionId, '旧思考', { senderType: 'reasoning' }),
    makeMessage(sessionId, '旧前言'),
    makeMessage(sessionId, '旧工具记录', { senderType: 'tool', metadataJson: '{"type":"toolStatus"}' }),
    makeMessage(sessionId, '旧语音', { metadataJson: JSON.stringify({ kind: 'voice', voice: { mediaAssetId: `audio-${sessionId}` } }) }),
    makeMessage(sessionId, '', { metadataJson: '{"kind":"sticker"}' }),
  ]);
  return { source, users, old: result.messages, target: result.messages.at(-1) };
}

// 用户消息、群聊、旧回合均不能重写；多气泡、语音、表情和工具不限制资格。
const first = await initial('first');
assert.equal((await turns.getRegenerationState('first')).eligibleRunId, first.source.runId);
await assert.rejects(turns.requestRegeneration('first', first.users[0].id), /只能重写/u);
await assert.rejects(turns.requestRegeneration('group', first.target.id), /只能重写/u);
const requests = await Promise.allSettled([
  turns.requestRegeneration('first', first.old[1].id), turns.requestRegeneration('first', first.target.id),
]);
assert.equal(requests.filter((value) => value.status === 'fulfilled').length, 1);
assert.equal((await turns.getRegenerationState('first')).hiddenMessageIds.length, first.old.length);
const pendingCursor = db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get('first').reply_cursor;
const rerun = await turns.claimIfIdle('first', 'user_reply');
assert.equal(rerun.kind, 'regenerate');
assert.equal(rerun.replyCursorAtClaim, pendingCursor);
assert.equal(rerun.inputCursorAtClaim, first.source.replyCursorAtClaim);
assert.equal(rerun.inputHighWatermark, first.source.inputHighWatermark);
assert.equal(await turns.claimIfIdle('first', 'user_reply'), null);

// 已发生的业务卡片和已有摘要仍保存。
const external = await messages.commitMessage({ message: makeMessage('first', '已发生的工具业务事实', {
  senderType: 'system', turnRunId: first.source.runId, turnItemIndex: null,
}), previewText: null });
db.prepare(`INSERT INTO chat_summary_segments
  (id, conversation_id, sequence, content, time_zone, created_at, updated_at)
  VALUES ('summary', 'first', 1, '已保存的旧摘要', 'Asia/Shanghai', ?, ?)`).run(time, time);
const replacement = await commit(rerun, [makeMessage('first', '新回复一'), makeMessage('first', '新回复二')]);
assert.equal(replacement.outcome, 'committed');
assert.deepEqual(replacement.mediaAssetCandidates, ['audio-first']);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE turn_run_id = ? AND turn_item_index IS NOT NULL').get(first.source.runId).n, 0);
assert.equal((await messages.getMessageById(external.id)).text, external.text);
assert.equal(db.prepare('SELECT content FROM chat_summary_segments').get().content, '已保存的旧摘要');
assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get('first').reply_cursor, pendingCursor);
assert.equal((await turns.getRegenerationState('first')).eligibleRunId, rerun.runId);
const { sortChatTimelineMessages } = load('src/features/chat/messages/domain/ChatTimelineOrdering.ts');
const replacementPage = await messages.getMessages('first', { limit: 50 });
assert.deepEqual(
  replacementPage.messages.map((message) => message.id),
  sortChatTimelineMessages(replacementPage.messages).map((message) => message.id),
  '旧 run 的业务卡片必须恢复自身时间顺序，SQL 与页面排序一致',
);
await turns.requestRegeneration('first', replacement.messages[0].id);
const again = await turns.claimIfIdle('first', 'user_reply');
assert.equal(again.inputCursorAtClaim, first.source.replyCursorAtClaim);
await turns.revoke(again, 'failed', 'network_error');
assert.ok(await messages.getMessageById(replacement.messages[0].id));
assert.equal((await turns.getRegenerationState('first')).sourceRunId, null);

// T3 写入失败整体回滚，不能先删除旧回复。
await turns.requestRegeneration('first', replacement.messages[0].id);
const rollback = await turns.claimIfIdle('first', 'user_reply');
db.exec("CREATE TRIGGER fail_new_reply BEFORE INSERT ON messages WHEN NEW.text = '失败插入' BEGIN SELECT RAISE(ABORT, 'insert failure'); END;");
await assert.rejects(commit(rollback, [makeMessage('first', '失败插入')]), /insert failure/u);
assert.ok(await messages.getMessageById(replacement.messages[0].id));
assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(rollback.runId).status, 'active');
db.exec('DROP TRIGGER fail_new_reply');
await turns.revoke(rollback, 'failed', 'insert_failure');

// 新用户输入、手动编辑、删除、清历史都撤销提交资格；孤儿不隐式重跑工具。
for (const change of ['send', 'edit', 'delete', 'clear', 'orphan']) {
  const fixture = await initial(change);
  await turns.requestRegeneration(change, fixture.target.id);
  const run = await turns.claimIfIdle(change, 'user_reply');
  if (change === 'send') {
    await databaseCoordinator.transaction({}, async (tx) => {
      await messages.commitMessageInTransaction(tx, { message: makeMessage(change, '新用户消息', { senderType: 'user', isMe: true }), previewText: '新用户消息' });
      await turns.supersedeActiveRunInTransaction(tx, change);
    });
  } else if (change === 'edit') {
    await databaseCoordinator.transaction({}, (tx) => messages.editMessageTextInTransaction(tx, {
      messageId: fixture.users[0].id, text: '编辑原输入', previewText: '编辑原输入',
    }));
  } else if (change === 'delete') {
    await messages.deleteMessagesWithMediaCandidates([fixture.users[0].id]);
  } else if (change === 'clear') {
    await load('src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts').sessionRepository.clearConversationHistory(change);
  } else {
    assert.equal(await turns.takeOverOrphan(change, 'user_reply'), null);
  }
  assert.equal((await commit(run, [makeMessage(change, '迟到结果')])).outcome, 'fence_failed');
  assert.equal(Boolean(await messages.getMessageById(fixture.target.id)), change !== 'clear', '清除删除原回复，其他失效路径保留原回复');
  assert.equal((await turns.getRegenerationState(change)).sourceRunId, null);
  if (change === 'send' || change === 'clear') assert.equal((await turns.getRegenerationState(change)).eligibleRunId, null);
}

// 模型输入仍通过既有执行入口，原输入区间与当前配置复用；页面只发起原生宿主。
const calls = [];
let modelBehavior = 'success';
override('src/features/chat/reply/application/BuildChatTurnAIInput.ts', {
  buildChatTurnAIInput: async (params) => {
    const users = await messages.listUserMessagesInRange(params.sessionId, params.replyCursorAtClaim, params.inputHighWatermark);
    return { userMessages: users, displayText: users.map((value) => value.text).join('\n'), turnInputMessages: users.map((value) => ({ role: 'user', content: value.text })) };
  },
});
override('src/features/chat/reply/application/AssistantReplyPersistence.ts', { normalizeAssistantResponseText: (text) => ({ text, segments: [text] }) });
override('src/features/chat/reply/application/AssistantTurnCommit.ts', { buildAssistantTurnItems: () => { throw new Error('本用例使用 Agent timeline 提交'); } });
override('src/features/chat/reply/application/CommittedAssistantSegmentDelivery.ts', { deliverCommittedAssistantSegment: async () => {} });
let arrivalRegistered = false;
const replacementReloads = [];
const stopReloadObservation = events.setChatEventBus({ emit: (name, { sessionId }) => {
  if (name !== 'messagesReloadRequested' || sessionId !== 'host-success') return;
  replacementReloads.push({
    arrivalRegistered,
    replies: db.prepare("SELECT text FROM chat_visible_messages WHERE session_id = ? AND sender_type = 'assistant' ORDER BY id").all(sessionId).map(row => row.text),
  });
} });
override('src/features/chat/reply/delivery/AssistantMessageArrival.ts', {
  beginAssistantMessageArrival: async () => { arrivalRegistered = true; },
  finishAssistantMessageArrival: async () => { arrivalRegistered = false; },
  // 页面 hook 的跨 runtime 兜底订阅；本环境不模拟原生到达端口，给无操作实现。
  subscribeAssistantMessageArrival: () => () => {},
});
override('src/features/chat/reply/application/ProcessAIReply.ts', {
  processAIReply: async (sessionId, text, config, userId, repository, callbacks, context, persistence) => {
    calls.push({ sessionId, text, config, userId, context });
    if (modelBehavior === 'failure') throw new Error('模拟网络失败');
    if (modelBehavior === 'reported_failure') {
      callbacks.onReplyFailed({ status: 'failed', sessionId, text: '网络连接已中断', previewText: '请求失败', messageId: 0, error: 'network_disconnected' });
      return;
    }
    const items = modelBehavior === 'empty' ? [] : ['宿主重写完成', '按节奏到达的后续气泡'].map((text, segment) => ({
      message: makeMessage(sessionId, text, {
        clientMessageId: `agent-timeline:${context.replyRunId}:1:${segment}`,
        metadataJson: JSON.stringify({ timelineSequence: 1, stepIndex: 1 }),
        segmentIndex: segment,
      }),
    }));
    await persistence.commitAgentTimeline({ sessionId, response: { text: '宿主重写完成' }, aiConfig: config, callbacks, runtimeContext: context, items });
  },
});
const { executeUserReplyTurn } = load('src/features/chat/reply/application/ExecuteUserReplyTurn.ts');
mocks['@features/chat/composition'] = {
  executeUserReplyTurn, conversationTurnRepository: turns,
  isChatReplyRunCancellationError: load('src/features/chat/reply/application/ChatReplyAbort.ts').isChatReplyRunCancellationError,
  emitChatRegenerationChanged: events.emitChatRegenerationChanged, emitChatTypingStatusChanged: events.emitChatTypingStatusChanged,
  emitChatMessagesReloadRequested: events.emitChatMessagesReloadRequested,
  emitChatTurnExecutionChanged: events.emitChatTurnExecutionChanged,
  interruptChatRunPresentation: display.interruptChatRunPresentation,
};
const { createConversationTurnCoordinator } = load('src/host/runtime/ConversationTurnCoordinator.ts');
let launches = 0;
const coordinator = createConversationTurnCoordinator({
  turns, executeTurn: executeUserReplyTurn, resolveAIConfig: async () => ai,
  executionHost: { start: async () => { launches += 1; return true; } },
});
runtime.configureChatMessageRuntime({
  messages, turns, turnPresentation,
  regeneration: { onRequested: (sessionId) => coordinator.requestReplyFromHost(sessionId), onInvalidated: (sessionId) => coordinator.abortInvalidatedTurn(sessionId) },
});
const { regenerateChatReply } = load('src/features/chat/reply/application/RegenerateChatReply.ts');
for (const behavior of ['success', 'failure', 'empty']) {
  const fixture = await initial(`host-${behavior}`);
  modelBehavior = behavior;
  const before = calls.length;
  await regenerateChatReply(`host-${behavior}`, fixture.target.id);
  assert.equal(calls.length, before, '页面请求不能执行模型');
  await coordinator.executeTurnFromHost(`host-${behavior}`);
  const input = calls.at(-1);
  assert.equal(input.text, '第一条用户输入\n第二条用户输入');
  assert.equal(input.config.model, 'current-model');
  assert.equal(input.context.isRegeneration, true);
  assert.equal(input.context.historyUpperBound.messageId, fixture.users.at(-1).id);
  assert.equal(Boolean(await messages.getMessageById(fixture.target.id)), behavior !== 'success');
  assert.equal((await turns.getRegenerationState(`host-${behavior}`)).sourceRunId, null);
}
assert.equal(launches, 3);
// 只有思考、没有已交付正文时，原版本留在原位，已展示的过程仍可查看。
const visibleFailure = await initial('visible-failure');
await turns.requestRegeneration('visible-failure', visibleFailure.target.id);
const failedPreviewRun = await turns.claimIfIdle('visible-failure', 'user_reply');
const failedPreview = new display.ChatTurnPresentation(failedPreviewRun, ai.agentId, ai.id);
await failedPreview.start();
failedPreview.sink.onDirty(() => [{ runId: failedPreviewRun.runId, sequence: 1, stepIndex: 1, kind: 'reasoning',
  status: 'streaming', text: '失败重写的尝试预览', clientMessageId: `agent-timeline:${failedPreviewRun.runId}:1:0`, createdAt: time, time: '18:00' }]);
await failedPreview.flush();
await turns.revoke(failedPreviewRun, 'failed', 'model_request_failed');
await failedPreview.finish();
assert.ok(await messages.getMessageById(visibleFailure.target.id));
assert.deepEqual(load('src/features/chat/messages/application/AgentTransientTimeline.ts')
  .snapshotAgentTransientTimelineWithReplacements('visible-failure').map(message => message.text), ['失败重写的尝试预览']);
for (const mode of ['failure', 'stop', 'orphan', 'new-input']) {
  const sessionId = `regeneration-prefix-${mode}`;
  const { source, target } = await initial(sessionId);
  await turns.requestRegeneration(sessionId, target.id);
  const run = await turns.claimIfIdle(sessionId, 'user_reply');
  const presentations = load('src/features/chat/reply/infrastructure/SQLiteChatTurnPresentationRepository.ts').chatTurnPresentationRepository;
  await presentations.open(run);
  const prefix = { version: 1, snapshot: {
    runId: run.runId, sequence: 1, stepIndex: 1, kind: 'assistant', status: 'streaming',
    text: '重写已经显示的半句话', clientMessageId: `agent-timeline:${run.runId}:1:0`, createdAt: time, time: '18:00',
  } };
  await presentations.checkpoint(run.runId, [prefix]);
  await presentations.publishVersions(run.runId, [prefix]);
  await presentations.checkpoint(run.runId, [{ version: 2, snapshot: { ...prefix.snapshot, text: '尚未交付的后半句' } }]);
  if (mode === 'failure') await turns.revoke(run, 'failed', 'network_error');
  if (mode === 'stop') await turns.cancelCurrentTurn(sessionId);
  if (mode === 'orphan') {
    await presentations.interruptOrphans([]);
    assert.equal(await turns.takeOverOrphan(sessionId, 'user_reply'), null);
  }
  if (mode === 'new-input') await databaseCoordinator.transaction({}, async tx => {
    await messages.commitMessageInTransaction(tx, { message: makeMessage(sessionId, '后续输入', { isMe: true, senderType: 'user' }), previewText: '后续输入' });
    await turns.supersedeActiveRunInTransaction(tx, sessionId);
  });
  const history = await turns.getReplyVersionHistory(sessionId, run.runId);
  assert.equal(history.selectedVersionId, run.runId, mode);
  assert.equal(history.versions[0].id, source.runId, mode);
  assert.equal(history.canAdopt, mode !== 'new-input', mode);
  assert.equal(await messages.getMessageById(target.id), null);
  assert.equal((await commit(run, [makeMessage(sessionId, '迟到的完整正文')])).outcome, 'fence_failed');
  await presentations.interruptOrphans([]);
  const replies = (await messages.getMessages(sessionId, { limit: 20 })).messages.filter(item => item.senderType === 'assistant');
  assert.deepEqual(replies.map(item => item.text), [prefix.snapshot.text], mode);
  assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get(sessionId).reply_cursor, run.replyCursorAtClaim);
  if (mode === 'failure') {
    await turns.adoptReplyVersion(sessionId, run.runId, source.runId, run.runId);
    assert.equal((await turns.getReplyVersionHistory(sessionId, run.runId)).selectedVersionId, source.runId);
    await turns.adoptReplyVersion(sessionId, run.runId, run.runId, source.runId);
    assert.deepEqual((await messages.getMessages(sessionId, { limit: 20 })).messages
      .filter(item => item.senderType === 'assistant').map(item => item.text), [prefix.snapshot.text]);
  }
}
// 普通回复的既有错误气泡路径只回调失败；执行 owner 仍要保存真实 T4 原因。
await initial('reported-failure');
await messages.commitMessage({ message: makeMessage('reported-failure', '普通聊天的新输入', { isMe: true, senderType: 'user' }), previewText: '普通聊天的新输入' });
modelBehavior = 'reported_failure';
await coordinator.executeTurnFromHost('reported-failure');
assert.equal(db.prepare("SELECT terminal_reason FROM conversation_turn_runs WHERE session_id='reported-failure' AND status='failed'").get().terminal_reason, 'network_disconnected');
assert.deepEqual(releases, [['audio-host-success']], '旧语音候选仅在成功替换后释放');
assert.deepEqual(replacementReloads[0], { arrivalRegistered: true, replies: ['宿主重写完成'] },
  '替换后的首次刷新已有新首泡，后续气泡仍按原有节奏到达');
stopReloadObservation();

// 迟到的原生启动失败只能撤销自己的请求；新请求和它的活句柄继续工作。
const delayed = await initial('delayed');
const oldRequestRevision = await turns.requestRegeneration('delayed', delayed.target.id);
await turns.cancelRegeneration('delayed', oldRequestRevision);
const newRequestRevision = await turns.requestRegeneration('delayed', delayed.target.id);
assert.ok(newRequestRevision > oldRequestRevision);
await turns.cancelRegeneration('delayed', oldRequestRevision);
assert.equal((await turns.getRegenerationState('delayed')).sourceRunId, delayed.source.runId);
const newRequestRun = await turns.claimIfIdle('delayed', 'user_reply');
await turns.cancelRegeneration('delayed', oldRequestRevision);
assert.equal((await turns.getRegenerationState('delayed')).activeRunId, newRequestRun.runId);
await turns.cancelRegeneration('delayed', newRequestRevision);
assert.equal((await turns.getRegenerationState('delayed')).sourceRunId, null);

const lateLaunch = await initial('late-launch');
let finishFirstLaunch;
let firstLaunchStarted;
const launchStarted = new Promise((resolve) => { firstLaunchStarted = resolve; });
const launchResult = new Promise((resolve) => { finishFirstLaunch = resolve; });
let finishNewModel;
let newModelStarted;
const modelStarted = new Promise((resolve) => { newModelStarted = resolve; });
const modelResult = new Promise((resolve) => { finishNewModel = resolve; });
let launchCount = 0;
let liveParams;
const cancelledErrors = [];
const stopCancellationObservation = events.setChatEventBus({ emit: (name, payload) => {
  if (name === 'regenerationChanged' && payload.sessionId === 'late-launch' && payload.regenerationError) cancelledErrors.push(payload.regenerationError);
} });
const lateCoordinator = createConversationTurnCoordinator({
  turns, resolveAIConfig: async () => ai,
  executionHost: { start: async () => {
    if (++launchCount === 1) { firstLaunchStarted(); return launchResult; }
    return true;
  } },
  executeTurn: async (params) => { liveParams = params; newModelStarted(); return modelResult; },
});
const configureWithCoordinator = (owner) => runtime.configureChatMessageRuntime({
  messages, turns, turnPresentation,
  regeneration: { onRequested: (sessionId) => owner.requestReplyFromHost(sessionId), onInvalidated: (sessionId) => owner.abortInvalidatedTurn(sessionId) },
});
configureWithCoordinator(lateCoordinator);
const firstLaunchRequest = regenerateChatReply('late-launch', lateLaunch.target.id);
const firstLaunchRejected = assert.rejects(firstLaunchRequest, /无法启动重写/u);
await launchStarted;
const pendingRevision = db.prepare('SELECT revision FROM chat_regeneration_requests WHERE session_id = ?').get('late-launch').revision;
await turns.cancelRegeneration('late-launch', pendingRevision);
await regenerateChatReply('late-launch', lateLaunch.target.id);
const runningModel = lateCoordinator.executeTurnFromHost('late-launch');
await modelStarted;
finishFirstLaunch(false);
await firstLaunchRejected;
assert.equal(lateCoordinator.hasActiveHandle('late-launch'), true);
assert.equal(liveParams.signal.aborted, false, '迟到启动失败不能 abort 后来一次重写的句柄');
assert.equal((await turns.getRegenerationState('late-launch')).activeRunId, liveParams.run.runId);
await turns.cancelRegeneration('late-launch', liveParams.run.revisionAtClaim - 1);
await lateCoordinator.abortInvalidatedTurn('late-launch');
assert.equal(liveParams.signal.aborted, true, '真正失去持久 owner 后清理原句柄');
finishNewModel('empty_reply');
await runningModel;
assert.deepEqual(cancelledErrors, [], '已经撤销的回合安静收尾，不能向新 owner 弹失败提示');
stopCancellationObservation();
configureWithCoordinator(coordinator);

// 清除用例同时关闭普通回复，不能只取消重写而让旧模型继续提交。
await initial('clear-running-reply');
await messages.commitMessage({ message: makeMessage('clear-running-reply', '等待回复的新输入', { isMe: true, senderType: 'user' }), previewText: '等待回复的新输入' });
let clearedRunParams;
let markClearRunStarted;
let finishClearedModel;
const clearRunStarted = new Promise(resolve => { markClearRunStarted = resolve; });
const clearedModel = new Promise(resolve => { finishClearedModel = resolve; });
const clearCoordinator = createConversationTurnCoordinator({
  turns, resolveAIConfig: async () => ai,
  executeTurn: async params => { clearedRunParams = params; markClearRunStarted(); return clearedModel; },
});
configureWithCoordinator(clearCoordinator);
const clearingExecution = clearCoordinator.executeTurnFromHost('clear-running-reply');
await clearRunStarted;
const clearingPreview = new display.ChatTurnPresentation(clearedRunParams.run, ai.agentId, ai.id);
await clearingPreview.start();
clearingPreview.sink.onDirty(() => [{ runId: clearedRunParams.run.runId, sequence: 1, stepIndex: 1, kind: 'reasoning',
  status: 'streaming', text: '即将清除的过程', clientMessageId: `agent-timeline:${clearedRunParams.run.runId}:1:0`, createdAt: time, time: '18:00' }]);
await clearingPreview.flush();
const transient = load('src/features/chat/messages/application/AgentTransientTimeline.ts');
assert.ok(transient.snapshotAgentTransientTimelineWithReplacements('clear-running-reply').length);
mocks['@features/profile'] = {};
load('src/features/chat/conversation/application/ChatConversationRuntime.ts').configureChatConversationRuntime({
  sessions: load('src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts').sessionRepository,
});
let resetPublished = false;
const stopClearObservation = events.setChatEventBus({ emit: (name, payload) => {
  if (name !== 'messagesReloadRequested' || !payload.resetHistory) return;
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(payload.sessionId).count, 0, '清除事实必须在 commit 后发布');
  resetPublished = true;
} });
await load('src/features/chat/conversation/application/ChatPresentation.ts').clearChatConversationHistory('clear-running-reply');
assert.equal(resetPublished, true);
assert.equal(clearedRunParams.signal.aborted, true, '清除普通回复也取消其模型句柄');
assert.equal(transient.snapshotAgentTransientTimelineWithReplacements('clear-running-reply').length, 0, '删除持久快照时也释放当前运行投影');
assert.equal((await commit(clearedRunParams.run, [makeMessage('clear-running-reply', '清除后迟到的回复')])).outcome, 'fence_failed');
finishClearedModel('empty_reply');
await clearingExecution;
await clearingPreview.finish();
stopClearObservation();
configureWithCoordinator(coordinator);

// 原输入可能已被摘要移出原文，但不能直接注入原回复、工具记录或后续通话。
let historySnapshot;
mocks['@shared/prompt'] = load('src/shared/prompt/messageTimestamp.ts');
mocks['@features/chat'] = { getChatInterruptedTurnContext: async () => [], getChatSummaryContext: async () => historySnapshot };
const { PromptHistoryBuilder } = load('src/host/prompt/PromptHistoryBuilder.ts');
const history = new PromptHistoryBuilder();
historySnapshot = {
  settings: { ...load('src/features/chat/summary/domain/ChatSummaryRepository.ts').DEFAULT_CHAT_SUMMARY_SETTINGS },
  fixedStart: null,
  segments: [{ content: '旧摘要原样保留', sourceStartAt: time, sourceEndAt: time, timeZone: 'Asia/Shanghai' }],
  contextSegments: [{ content: '旧摘要原样保留', sourceStartAt: time, sourceEndAt: time, timeZone: 'Asia/Shanghai' }],
  timeline: [
    { source: 'chat', kind: 'dialogue', speaker: 'assistant', messageId: 1, content: '之前的回复', logicalIdentity: null, timestamp: time },
    { source: 'call', kind: 'dialogue', speaker: 'user', eventId: 'earlier', callId: 'call-before', content: '此前通话', logicalIdentity: null, timestamp: '2026-10-09T09:00:00.000Z' },
    { source: 'chat', kind: 'dialogue', speaker: 'assistant', messageId: 11, content: '待替换旧回复', logicalIdentity: null, timestamp: time },
    { source: 'chat', kind: 'application_event', speaker: 'user', messageId: 12, content: '旧工具记录', logicalIdentity: null, timestamp: time },
    { source: 'call', kind: 'dialogue', speaker: 'assistant', eventId: 'later', callId: 'call-after', content: '后续通话', logicalIdentity: null, timestamp: '2026-10-09T11:00:00.000Z' },
  ],
};
const limited = await history.loadPrivateSummaryContext({
  sessionId: 'first', runtimeContext: { batchedUserMessageIds: [9, 10], historyUpperBound: { messageId: 10, createdAt: time } },
});
assert.equal(limited.messages.length, 2);
assert.equal(limited.messages[0].content, '之前的回复');
assert.equal(limited.messages[0].createdAt, time);
assert.match(limited.messages[1].content, /此前通话/u);
assert.match(limited.summaryContent, /旧摘要原样保留/u);
const ordinary = await history.loadPrivateSummaryContext({ sessionId: 'first', runtimeContext: { batchedUserMessageIds: [9, 10] } });
assert.equal(ordinary.messages.length, 5, '普通回复保留原有历史策略');
historySnapshot.settings = { ...historySnapshot.settings, generationEnabled: false, fixedMessageId: 1 };
const fixedLimited = await history.loadPrivateSummaryContext({ sessionId: 'first', recentWindowLimit: 1,
  runtimeContext: { batchedUserMessageIds: [9,10],historyUpperBound: { messageId:10,createdAt:time } } });
assert.equal(fixedLimited.messages.length,2,'固定范围也遵守重写历史上界，且不额外按近期 N 裁剪');

// 真实页面 hook 在点击时隐藏整轮，失败恢复；不新增重写标记或另一个进度条。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act, create } = require('react-test-renderer');
const { useChatRegeneration } = load('src/features/chat/presentation/messages/ChatDetail/useChatRegeneration.ts');
const fixture = await initial('ui');
let ui;
function Harness() { ui = useChatRegeneration('ui', refresh); return null; }
let refreshed = 0;
const refresh = async () => { refreshed += 1; };
let renderer;
await act(async () => { renderer = create(React.createElement(Harness)); });
assert.equal(ui.eligibleRunId, fixture.source.runId);
await act(async () => { await ui.regenerate(fixture.target, fixture.old); });
assert.equal(ui.sourceRunId, fixture.source.runId);
assert.deepEqual(ui.hiddenMessageIds, fixture.old.map((message) => message.id));
modelBehavior = 'failure';
await act(async () => { await coordinator.executeTurnFromHost('ui'); });
assert.equal(ui.sourceRunId, null);
assert.ok(refreshed > 0);
assert.ok(notices.includes('模拟网络失败'));
assert.ok(await messages.getMessageById(fixture.target.id));
await act(async () => renderer.unmount());

// 慢读取期间的事件风暴只补读最新事实，不让已作废的读取淹没交互队列。
const burstFixture = await initial('ui-burst');
let burstState;
const readRegeneration = turns.getRegenerationState.bind(turns);
let regenerationReads = 0;
let activeRegenerationReads = 0;
let releaseRegenerationRead;
const regenerationReadGate = new Promise(resolve => { releaseRegenerationRead = resolve; });
turns.getRegenerationState = async sessionId => {
  regenerationReads++;
  activeRegenerationReads++;
  assert.equal(activeRegenerationReads, 1, '同一页面只有一个状态读取在途');
  try {
    const snapshot = await readRegeneration(sessionId);
    if (regenerationReads === 1) await regenerationReadGate;
    return snapshot;
  } finally { activeRegenerationReads--; }
};
function BurstHarness() { burstState = useChatRegeneration('ui-burst', refresh); return null; }
await act(async () => { renderer = create(React.createElement(BurstHarness)); });
assert.equal(regenerationReads, 1);
await turns.requestRegeneration('ui-burst', burstFixture.target.id);
await act(async () => {
  for (let index = 0; index < 20; index++) {
    events.emitChatMessagesReloadRequested('ui-burst');
    events.emitChatTurnExecutionChanged('ui-burst');
    events.emitChatRegenerationChanged('ui-burst');
  }
});
assert.equal(regenerationReads, 1, '在途读取未完成时，事实事件不新增数据库任务');
await act(async () => { releaseRegenerationRead(); });
assert.equal(regenerationReads, 2, '补读一次最新事实');
assert.equal(burstState.sourceRunId, burstFixture.source.runId, '旧快照不能覆盖重写中的隐藏状态');
await act(async () => { events.emitChatRegenerationChanged('ui-burst'); });
assert.equal(regenerationReads, 3, '读取完成后新事实仍会重新查库');
await act(async () => renderer.unmount());
turns.getRegenerationState = readRegeneration;

// 展示历史共用在途读取，后续分页窗口及显式中断回合不能在合并中丢失。
const historyRepository = load('src/features/chat/reply/infrastructure/SQLiteChatTurnPresentationRepository.ts').chatTurnPresentationRepository;
const readDisplayHistory = historyRepository.listHistory.bind(historyRepository);
const historyReads = [];
let releaseHistoryRead;
const historyReadGate = new Promise(resolve => { releaseHistoryRead = resolve; });
historyRepository.listHistory = async (sessionId, window) => {
  historyReads.push(window);
  if (historyReads.length === 1) await historyReadGate;
  return readDisplayHistory(sessionId, window);
};
const releaseHistoryOwner = display.retainTurnDisplayHistory('ui-burst');
const historyPending = [display.reloadTurnDisplayHistory('ui-burst', [{ id: 100, turnRunId: 'window-old' }], ['closed-a'])];
await Promise.resolve();
for (let index = 0; index < 20; index++) {
  historyPending.push(display.reloadTurnDisplayHistory('ui-burst', [{ id: 10, turnRunId: 'window-latest' }], ['closed-b']));
}
assert.equal(historyReads.length, 1);
releaseHistoryRead();
await Promise.all(historyPending);
assert.equal(historyReads.length, 2);
assert.equal(historyReads[1].fromMessageId, 10);
assert.deepEqual(new Set(historyReads[1].runIds), new Set(['window-latest', 'closed-a', 'closed-b']));
await display.reloadTurnDisplayHistory('ui-burst');
assert.deepEqual(historyReads[2].runIds, ['window-latest'], '额外回合只属于本批读取，不成为永久缓存');
historyRepository.listHistory = async () => { throw new Error('模拟历史读取失败'); };
await assert.rejects(display.reloadTurnDisplayHistory('ui-burst'), /模拟历史读取失败/u);
historyRepository.listHistory = readDisplayHistory;
await display.reloadTurnDisplayHistory('ui-burst');
releaseHistoryOwner();

// 三个候选共享唯一后续；浏览不改变 canonical，采用只替换本轮，不执行工具。
const versionsFixture = await initial('versions');
async function rerollVersion(sessionId, text) {
  const current = (await messages.getMessages(sessionId, { limit: 100 })).messages.findLast(message => message.senderType === 'assistant');
  await turns.requestRegeneration(sessionId, current.id);
  const run = await turns.claimIfIdle(sessionId, 'user_reply');
  await commit(run, [makeMessage(sessionId, text)]);
  return run;
}
const secondVersion = await rerollVersion('versions', '第二版');
const thirdVersion = await rerollVersion('versions', '第三版');
let versionHistory = await turns.getReplyVersionHistory('versions', thirdVersion.runId);
assert.deepEqual(versionHistory.versions.map(version => version.id), [versionsFixture.source.runId, secondVersion.runId, thirdVersion.runId]);
assert.equal(versionHistory.canAdopt, true);
assert.equal(versionHistory.selectedVersionId, thirdVersion.runId);
assert.equal((await messages.getMessages('versions', { limit: 100 })).messages.at(-1).text, '第三版');
const versionsCursor = db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get('versions').reply_cursor;
await turns.adoptReplyVersion('versions', thirdVersion.runId, versionsFixture.source.runId, thirdVersion.runId);
let adopted = await messages.listTurnMessagesInTransaction(executor, thirdVersion.runId);
assert.deepEqual(adopted.map(message => message.text), versionsFixture.old.map(message => message.text));
assert.ok(adopted.every(message => message.isRead));
assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get('versions').reply_cursor, versionsCursor);
assert.equal((await turns.getRegenerationState('versions')).eligibleRunId, thirdVersion.runId);
await databaseCoordinator.transaction({}, tx => messages.editMessageTextInTransaction(tx, {
  messageId: adopted[1].id, text: '第一版手动改字', previewText: '第一版手动改字',
}));
versionHistory = await turns.getReplyVersionHistory('versions', thirdVersion.runId);
assert.equal(versionHistory.versions.length, 3, '手动改字不创建新版本');
assert.equal(versionHistory.versions[0].messages[1].text, '第一版手动改字');
assert.equal(versionHistory.versions[2].messages[0].text, '第三版');
await turns.adoptReplyVersion('versions', thirdVersion.runId, thirdVersion.runId, versionsFixture.source.runId);
await turns.adoptReplyVersion('versions', thirdVersion.runId, versionsFixture.source.runId, thirdVersion.runId);
assert.equal((await messages.listTurnMessagesInTransaction(executor, thirdVersion.runId))[1].text, '第一版手动改字');
const context = await messages.getMessages('versions', { limit: 100 });
assert.ok(!context.messages.some(message => ['第二版', '第三版'].includes(message.text)), '普通消息和上下文查询只读取采用版本');
await assert.rejects(turns.adoptReplyVersion('versions', thirdVersion.runId, secondVersion.runId, thirdVersion.runId), /当前版本已变化/u);

// 独立自主任务在准备 Prompt 前已保存 started，尚未进入 Runtime 时也禁止改变它正在读取的历史。
await messages.commitMessage({ message: makeMessage('versions', '自主准备中', {
  senderType: 'system', turnRunId: 'preparing-agent', turnItemIndex: 1,
  metadataJson: '{"type":"agentActivity","phase":"started"}',
}), previewText: null });
assert.equal((await turns.getReplyVersionHistory('versions', thirdVersion.runId)).canAdopt, false);
await assert.rejects(turns.adoptReplyVersion('versions', thirdVersion.runId, secondVersion.runId, versionsFixture.source.runId), /只能切换/u);
await messages.commitMessage({ message: makeMessage('versions', '自主准备结束', {
  senderType: 'system', turnRunId: 'preparing-agent', turnItemIndex: 2,
  metadataJson: '{"type":"agentActivity","phase":"terminal"}',
}), previewText: null });
assert.equal((await turns.getReplyVersionHistory('versions', thirdVersion.runId)).canAdopt, true);

// 插入失败整事务回滚，采用资格和当前正文都保持不变。
db.exec("CREATE TRIGGER fail_adoption BEFORE INSERT ON messages WHEN NEW.text = '第二版' BEGIN SELECT RAISE(ABORT, 'adoption failure'); END;");
await assert.rejects(turns.adoptReplyVersion('versions', thirdVersion.runId, secondVersion.runId, versionsFixture.source.runId), /adoption failure/u);
assert.equal((await turns.getReplyVersionHistory('versions', thirdVersion.runId)).selectedVersionId, versionsFixture.source.runId);
assert.equal((await messages.listTurnMessagesInTransaction(executor, thirdVersion.runId))[1].text, '第一版手动改字');
db.exec('DROP TRIGGER fail_adoption');

// 新输入永久锁定旧回合，删除后续消息也不能把它重新变成可切换剧情。
const continuation = await messages.commitMessage({ message: makeMessage('versions', '继续聊', { isMe: true, senderType: 'user' }), previewText: '继续聊' });
versionHistory = await turns.getReplyVersionHistory('versions', thirdVersion.runId);
assert.equal(versionHistory.canAdopt, false);
assert.equal(versionHistory.versions.length, 3);
await assert.rejects(turns.adoptReplyVersion('versions', thirdVersion.runId, secondVersion.runId, versionsFixture.source.runId), /只能切换/u);
await messages.deleteMessagesWithMediaCandidates([continuation.id]);
assert.equal((await turns.getReplyVersionHistory('versions', thirdVersion.runId)).canAdopt, false);
assert.equal((await turns.getRegenerationState('versions')).eligibleRunId, null);

// 主动回复与采用并发，由同一个 SQLite 写事务裁决，后续 AI 消息优先提交后即禁止采用。
const proactiveFixture = await initial('proactive-versions');
const proactiveRerun = await rerollVersion('proactive-versions', '主动前的新版');
const raceResults = await Promise.allSettled([
  messages.commitMessage({ message: makeMessage('proactive-versions', '主动来找你', { turnRunId: 'proactive-run' }), previewText: '主动来找你' }),
  turns.adoptReplyVersion('proactive-versions', proactiveRerun.runId, proactiveFixture.source.runId, proactiveRerun.runId),
]);
assert.equal(raceResults[0].status, 'fulfilled');
assert.equal(raceResults[1].status, 'rejected');
assert.equal((await turns.getReplyVersionHistory('proactive-versions', proactiveRerun.runId)).versions.length, 2);

// 重写执行中到达旁路回复，撤销旧替换资格，不能在后续消息之后重新开放版本选择。
const lateProactive = await initial('late-proactive');
await turns.requestRegeneration('late-proactive', lateProactive.target.id);
const lateProactiveRun = await turns.claimIfIdle('late-proactive', 'user_reply');
await messages.commitMessage({ message: makeMessage('late-proactive', '新的主动消息'), previewText: '新的主动消息' });
assert.equal((await commit(lateProactiveRun, [makeMessage('late-proactive', '迟到重写')])).outcome, 'fence_failed');
assert.equal((await turns.getRegenerationState('late-proactive')).sourceRunId, null);

// 删除当前回复同时删除本轮历史，旧语音引用进入同一删除事务的释放候选。
adopted = await messages.listTurnMessagesInTransaction(executor, thirdVersion.runId);
const removedVersions = await messages.deleteMessagesWithMediaCandidates(adopted.map(message => message.id));
assert.equal(await turns.getReplyVersionHistory('versions', thirdVersion.runId), null);
assert.ok(removedVersions.mediaAssetCandidates.includes('audio-versions'));

const cascadeFixture = await initial('cascade-versions');
const cascadeRun = await rerollVersion('cascade-versions', '删除会话前的新版');
assert.equal((await turns.getReplyVersionHistory('cascade-versions', cascadeRun.runId)).versions[0].id, cascadeFixture.source.runId);
db.prepare("DELETE FROM chat_conversations WHERE id = 'cascade-versions'").run();
assert.equal(await turns.getReplyVersionHistory('cascade-versions', cascadeRun.runId), null);
assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_reply_versions WHERE set_id = ?').get(cascadeFixture.source.runId).n, 0);

// 确认前不启动重写；仅确认时保存「不再提示」，重复触摸只提交一次。
const preferences = new Map();
mocks['@react-native-async-storage/async-storage'] = {
  getItem: async key => preferences.get(key) ?? null,
  setItem: async (key, value) => { preferences.set(key, value); },
};
mocks['react-native'] = { ...mocks['react-native'], Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: value => value } };
mocks['lucide-react-native'] = { Check: 'Check', Square: 'Square' };
mocks['@shared/ui'] = { Button: 'Button', ModalSheet: 'ModalSheet' };
mocks['@shared/theme'] = { useTheme: () => ({ colors: { border: { light: 'gray' }, text: { primary: 'black', secondary: 'gray' }, brand: { primary: 'blue' }, feedback: { error: 'red' } } }) };
const { default: Confirm, shouldConfirmChatRegeneration } = load('src/features/chat/presentation/messages/components/ChatRegenerationConfirm.tsx');
assert.equal(await shouldConfirmChatRegeneration(), true);
let confirmations = 0, cancellations = 0;
let confirmRenderer;
await act(async () => { confirmRenderer = create(React.createElement(Confirm, { onClose: () => cancellations++, onConfirm: () => confirmations++ })); });
await act(async () => { confirmRenderer.root.findByProps({ title: '取消' }).props.onPress(); });
assert.equal(cancellations, 1); assert.equal(confirmations, 0); assert.equal(preferences.size, 0);
await act(async () => { confirmRenderer.root.findByProps({ accessibilityRole: 'checkbox' }).props.onPress(); });
assert.equal(preferences.size, 0, '勾选本身不提前保存偏好');
await act(async () => {
  const confirm = confirmRenderer.root.findByProps({ title: '确认重写' }).props.onPress;
  confirm(); confirm();
});
assert.equal(confirmations, 1);
assert.equal(await shouldConfirmChatRegeneration(), false);
await act(async () => confirmRenderer.unmount());

// 退出弹窗后迟到的偏好写入不能启动旧会话的重写。
let finishPreference;
mocks['@react-native-async-storage/async-storage'].setItem = () => new Promise(resolve => { finishPreference = resolve; });
await act(async () => { confirmRenderer = create(React.createElement(Confirm, { onClose() {}, onConfirm: () => confirmations++ })); });
await act(async () => { confirmRenderer.root.findByProps({ accessibilityRole: 'checkbox' }).props.onPress(); });
await act(async () => { confirmRenderer.root.findByProps({ title: '确认重写' }).props.onPress(); });
await act(async () => confirmRenderer.unmount());
await act(async () => { finishPreference(); });
assert.equal(confirmations, 1);

// 历史窗口的版本按钮只预览；显式采用才改变当前时间线，继续对话后保留预览而移除采用入口。
const sheetFixture = await initial('version-sheet');
await rerollVersion('version-sheet', '窗口第二版');
const sheetRun = await rerollVersion('version-sheet', '窗口第三版');
for (const name of ['AttachmentCard', 'StickerMessageCard', 'VoiceMessageCard']) {
  override(`src/features/chat/presentation/messages/MessageBubble/${name}.tsx`, { __esModule: true, default: name });
}
override('src/features/chat/messages/application/VoiceMessagePlaybackCoordinator.ts', { voiceMessagePlaybackCoordinator: { stop: async () => {} } });
mocks['@platform/device'].copyTextToClipboard = () => {};
mocks['react-native'].ActivityIndicator = 'ActivityIndicator';
const { default: VersionSheet } = load('src/features/chat/presentation/messages/components/ChatReplyVersionSheet.tsx');
let sheet;
await act(async () => { sheet = create(React.createElement(VersionSheet, { sessionId: 'version-sheet', runId: sheetRun.runId, blocked: false, onClose() {}, onPreviewFile() {} })); });
await act(async () => { sheet.root.findByProps({ title: '版本 1' }).props.onPress(); });
assert.equal((await messages.listTurnMessagesInTransaction(executor, sheetRun.runId))[0].text, '窗口第三版');
await act(async () => { sheet.root.findByProps({ title: '采用此版本' }).props.onPress(); });
assert.deepEqual((await messages.listTurnMessagesInTransaction(executor, sheetRun.runId)).map(message => message.text), sheetFixture.old.map(message => message.text));
await act(async () => {
  await messages.commitMessage({ message: makeMessage('version-sheet', '新的后续', { isMe: true, senderType: 'user' }), previewText: '新的后续' });
  events.emitChatMessagesUpdated('version-sheet');
});
await act(async () => { sheet.root.findByProps({ title: '版本 3' }).props.onPress(); });
assert.equal(sheet.root.findAllByProps({ title: '采用此版本' }).length, 0);
assert.ok(sheet.root.findAllByProps({ title: '复制回复正文' }).length > 0);
await act(async () => sheet.unmount());

// 中断只结束生成：已交付正文封存为普通消息，重写复用原输入并保留截断版本。
db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('interrupted', 'direct');
db.prepare('INSERT INTO sessions(id) VALUES (?)').run('interrupted');
await databaseCoordinator.transaction({}, tx => turns.ensureTurnStateRowInTransaction(tx, 'interrupted'));
const interruptedUser = await messages.commitMessage({ message: makeMessage('interrupted', '原始问题', { senderType: 'user', isMe: true }), previewText: '原始问题' });
const interruptedRun = await turns.claimIfIdle('interrupted', 'user_reply');
const displays = load('src/features/chat/reply/infrastructure/SQLiteChatTurnPresentationRepository.ts').chatTurnPresentationRepository;
await displays.open(interruptedRun);
const interruptedItem = (version, text) => ({ version, snapshot: {
  runId: interruptedRun.runId, sequence: 1, stepIndex: 1, kind: 'assistant', status: 'streaming', text,
  clientMessageId: `agent-timeline:${interruptedRun.runId}:1:0`, createdAt: time, time: '18:00',
  tokensUsed: 24, promptTokens: 20, completionTokens: 4, cachedTokens: 0,
} });
await displays.checkpoint(interruptedRun.runId, [interruptedItem(1, '收到的半句话')]);
await displays.publishVersions(interruptedRun.runId, [interruptedItem(1, '收到的半句话')]);
await displays.checkpoint(interruptedRun.runId, [interruptedItem(2, '收到的半句话，尚未交付的尾部')]);
const beforeFailure = db.prepare('SELECT * FROM conversation_turn_state WHERE session_id = ?').get('interrupted');
db.exec("CREATE TRIGGER reject_seal BEFORE INSERT ON messages WHEN NEW.text = '收到的半句话' BEGIN SELECT RAISE(ABORT, 'seal rollback'); END;");
await assert.rejects(turns.revoke(interruptedRun, 'failed', 'network_error'), /seal rollback/);
assert.equal(db.prepare('SELECT state FROM chat_turn_presentations WHERE run_id = ?').get(interruptedRun.runId).state, 'open');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE turn_run_id = ?').get(interruptedRun.runId).n, 0);
assert.deepEqual(db.prepare('SELECT * FROM conversation_turn_state WHERE session_id = ?').get('interrupted'), beforeFailure);
db.exec('DROP TRIGGER reject_seal');
await turns.revoke(interruptedRun, 'failed', 'network_error');
const sealedMessages = (await messages.getMessages('interrupted', { limit: 20 })).messages;
let sealed = sealedMessages.find(message => message.senderType === 'assistant');
assert.ok(sealed.id > 0);
assert.equal(sealed.text, '收到的半句话');
assert.equal(sealed.status, 'sent');
assert.equal(sealed.agentId, 'agent-ai');
assert.equal(JSON.parse(sealed.metadataJson).interrupted, true);
assert.equal(JSON.parse(sealed.metadataJson).cachedTokens, 0);
assert.equal(sealed.tokensUsed, 24);
assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get('interrupted').reply_cursor, beforeFailure.reply_cursor);
assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(interruptedRun.runId).status, 'failed');
assert.equal(await turns.claimIfIdle('interrupted', 'user_reply'), null, '封存消息不隐式重试失败输入');
assert.deepEqual((await displays.listHistory('interrupted'))[0].items, [], '历史恢复通过同一个消息身份读回');
assert.deepEqual(await displays.listInterruptedContext('interrupted', 0, undefined, 'history'), [], '正式历史不重复附加同一段正文');
assert.equal((await displays.listInterruptedContext('interrupted', 0))[0].items[0].text, sealed.text, '尚未消费的原任务仍可按原顺序读取已有结果');
await displays.interruptOrphans([]);
assert.deepEqual((await messages.getMessages('interrupted', { limit: 20 })).messages.map(message => message.id), sealedMessages.map(message => message.id), '重复恢复不创建新消息');
const actions = load('src/features/chat/messages/domain/ChatMessageActions.ts').getChatMessageActions(sealed);
assert.deepEqual(actions, { quote: true, translate: true, favorite: true });
assert.equal(load('src/features/chat/messages/domain/ChatMessageEditing.ts').canEditChatMessage(sealed), true);
assert.equal(load('src/features/chat/messages/domain/ChatMessageSelection.ts').canSelectChatMessage(sealed), true);
sealed = await databaseCoordinator.transaction({}, tx => messages.editMessageTextInTransaction(tx, {
  messageId: sealed.id, text: '修改过的半句话', previewText: '修改过的半句话',
}));
assert.equal((await displays.listInterruptedContext('interrupted', 0))[0].items[0].text, sealed.text,
  '改写与后续模型读取使用同一份封存正文');
assert.equal((await turns.getRegenerationState('interrupted')).eligibleRunId, interruptedRun.runId);
await turns.requestRegeneration('interrupted', sealed.id);
const retry = await turns.claimIfIdle('interrupted', 'user_reply');
assert.equal(retry.kind, 'regenerate');
assert.equal(retry.inputHighWatermark, interruptedUser.id);
assert.equal(retry.inputCursorAtClaim, interruptedRun.replyCursorAtClaim);
await turns.revoke(retry, 'failed', 'retry_network_error');
assert.equal((await messages.getMessageById(sealed.id)).text, sealed.text, '重写失败保留原截断正文');
await turns.requestRegeneration('interrupted', sealed.id);
const successfulRetry = await turns.claimIfIdle('interrupted', 'user_reply');
const completedRetry = await commit(successfulRetry, [makeMessage('interrupted', '重新生成的完整回答')]);
const versions = await turns.getReplyVersionHistory('interrupted', successfulRetry.runId);
assert.deepEqual(versions.versions.map(version => version.messages[0].text), ['修改过的半句话', '重新生成的完整回答']);
await turns.adoptReplyVersion('interrupted', successfulRetry.runId, versions.versions[0].id, versions.selectedVersionId);
assert.equal((await messages.listTurnMessagesInTransaction(executor, successfulRetry.runId))[0].text, sealed.text);
assert.equal(completedRetry.outcome, 'committed');
const adoptedPartial = (await messages.listTurnMessagesInTransaction(executor, successfulRetry.runId))[0];
await messages.deleteMessagesWithMediaCandidates([adoptedPartial.id]);
await displays.interruptOrphans([]);
assert.equal(await messages.getMessageById(adoptedPartial.id), null, '删除后的截断正文不能从展示历史复活');
assert.equal(await turns.getReplyVersionHistory('interrupted', successfulRetry.runId), null);

// 旧版本遗留的独立正文沿恢复入口封存，清空可见边界以内的旧记录不能借新 ID 重新出现。
db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('legacy-interrupted', 'direct');
db.prepare('INSERT INTO sessions(id) VALUES (?)').run('legacy-interrupted');
const legacyUser = await messages.commitMessage({ message: makeMessage('legacy-interrupted', '旧问题', { senderType: 'user', isMe: true }), previewText: '旧问题' });
const legacyRun = await turns.claimIfIdle('legacy-interrupted', 'user_reply');
await displays.open(legacyRun);
const legacyItem = { version: 1, snapshot: { ...interruptedItem(1, '旧版本收到的正文').snapshot,
  runId: legacyRun.runId, clientMessageId: `agent-timeline:${legacyRun.runId}:1:0` } };
await displays.checkpoint(legacyRun.runId, [legacyItem]);
await displays.publishVersions(legacyRun.runId, [legacyItem]);
db.prepare("UPDATE chat_turn_presentations SET state = 'interrupted' WHERE run_id = ?").run(legacyRun.runId);
assert.equal((await commit(legacyRun, [makeMessage('legacy-interrupted', '封口之后迟到的完整输出')])).outcome, 'fence_failed',
  '展示已经结束、T4 尚未撤销 owner 的交接期也拒绝迟到 T3');
db.prepare("UPDATE conversation_turn_runs SET status = 'failed' WHERE run_id = ?").run(legacyRun.runId);
db.prepare("UPDATE conversation_turn_state SET active_run_id = NULL, active_run_kind = NULL WHERE session_id = ?").run('legacy-interrupted');
db.prepare('UPDATE sessions SET visible_after_message_id = ? WHERE id = ?').run(legacyUser.id, 'legacy-interrupted');
await displays.interruptOrphans([]);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE turn_run_id = ?').get(legacyRun.runId).n, 0);
db.prepare('UPDATE sessions SET visible_after_message_id = 0 WHERE id = ?').run('legacy-interrupted');
await messages.commitMessage({ message: makeMessage('legacy-interrupted', '后续新问题', { senderType: 'user', isMe: true }), previewText: '后续新问题' });
const newerRun = await turns.claimIfIdle('legacy-interrupted', 'user_reply');
await commit(newerRun, [makeMessage('legacy-interrupted', '后续回答')]);
const newerVersion = await rerollVersion('legacy-interrupted', '后续回答的第二版');
const newerTarget = (await messages.listTurnMessagesInTransaction(executor, newerVersion.runId))[0];
await turns.requestRegeneration('legacy-interrupted', newerTarget.id);
const activeNewerRewrite = await turns.claimIfIdle('legacy-interrupted', 'user_reply');
await displays.interruptOrphans([activeNewerRewrite.runId]);
assert.equal((await turns.getRegenerationState('legacy-interrupted')).activeRunId, activeNewerRewrite.runId,
  '封存旧正文不撤销后续正在重写的 owner');
assert.equal(db.prepare('SELECT locked FROM chat_reply_version_sets WHERE current_run_id = ?').get(newerVersion.runId).locked, 0,
  '封存旧正文不锁定后续候选');
await turns.revoke(activeNewerRewrite, 'failed', 'test_finished');
assert.equal((await turns.getRegenerationState('legacy-interrupted')).eligibleRunId, newerVersion.runId,
  '较晚取得数据库 ID 的旧正文不能抢占最新回复资格');
const legacyReply = (await messages.getMessages('legacy-interrupted', { limit: 20 })).messages.find(message => message.senderType === 'assistant');
assert.equal(legacyReply.text, '旧版本收到的正文');
assert.equal(legacyReply.status, 'sent');
assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(legacyRun.runId).status, 'failed');
const orderedLegacy = (await messages.getMessages('legacy-interrupted', { limit: 20 })).messages;
assert.deepEqual(sortChatTimelineMessages(orderedLegacy).map(message => message.id), orderedLegacy.map(message => message.id),
  '封存后 JS 与 SQLite 使用相同的历史位置');

// 空会话召唤也复用原展示、停止与封存路径，不需要用户消息作占位锚点。
{
  const sessionId = 'empty-companionship';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
  db.prepare('INSERT INTO sessions(id, last_message, last_time, updated_at) VALUES (?, ?, ?, ?)').run(sessionId, '', time, time);
  assert.equal(await turns.requestUserReply(sessionId), true);
  const presentations = load('src/features/chat/reply/infrastructure/SQLiteChatTurnPresentationRepository.ts').chatTurnPresentationRepository;
  assert.equal((await presentations.getExecutionStatus(sessionId)).phase, 'waiting_host');
  const run = await turns.claimIfIdle(sessionId, 'user_reply');
  assert.equal(run.kind, 'summon');
  assert.equal((await presentations.getExecutionStatus(sessionId)).phase, 'preparing');
  await presentations.open(run);
  const arrived = { version: 1, snapshot: { runId: run.runId, sequence: 1, stepIndex: 1, kind: 'assistant', status: 'sent',
    text: '我来陪你啦', clientMessageId: `agent-timeline:${run.runId}:1:0`, createdAt: run.createdAt, time: '18:00' } };
  await presentations.checkpoint(run.runId, [arrived]);
  await presentations.publishVersions(run.runId, [arrived]);
  await turns.cancelCurrentTurn(sessionId);
  const saved = (await messages.getMessages(sessionId, { limit: 20 })).messages;
  assert.equal(saved.length, 1, '停止空输入召唤也保留已经交付的正文');
  assert.equal(saved[0].text, arrived.snapshot.text);
  assert.equal(saved[0].isMe, false);
  assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id=?').get(sessionId).reply_cursor, 0);
  assert.equal(await turns.requestUserReply(sessionId), true);
  const next = await turns.claimIfIdle(sessionId, 'user_reply');
  assert.equal((await commit(next, [makeMessage(sessionId, '继续陪你', { createdAt: next.createdAt })])).outcome, 'committed');
  assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id=?').get(sessionId).reply_cursor, 0);
  assert.equal(await turns.requestUserReply(sessionId), true);
  await load('src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts').sessionRepository.clearConversationHistory(sessionId);
  assert.equal(await turns.getSessionTurnSnapshot(sessionId), null, '清空历史同时撤销尚未领取的陪伴召唤');
  assert.equal(await turns.claimIfIdle(sessionId, 'user_reply'), null, '迟到宿主不得在清空后重新发起旧召唤');
}

console.log('Chat 重写与候选版本：原子替换、原输入、截断正文封存与完整操作资格、失败回滚、候选采用、上下文隔离及恢复幂等验证通过');
db.close();
