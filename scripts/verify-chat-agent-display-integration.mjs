/** 用真实 Runtime、事件队列、Projector、SQLite T1/T3 验证展示，不调用真实模型或用户业务数据。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { SCHEMAS, INDEXES } from './helpers/sqlite-bootstrap-fixture.mjs';
import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
import { installChatTimelineSchema } from './chat-timeline-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const directory = process.argv[2] === '--read' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-agent-display-'));
const filename = directory ? path.join(directory, 'history.sqlite') : process.argv[3];
let db = new DatabaseSync(filename);
let writer = Promise.resolve();
let writes = 0;
const executor = {
  execAsync: async sql => db.exec(sql),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  runAsync: async (sql, params = []) => {
    const result = db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  },
};
const coordinator = {
  read: (_meta, operation) => writer.then(() => operation(executor)),
  transaction(_meta, operation) {
    writes++;
    const next = writer.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await operation(executor); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    writer = next.catch(() => {});
    return next;
  },
  openTaskExecutor: () => ({ ...executor, withExclusiveTransactionAsync: operation => coordinator.transaction({}, operation) }),
};
const cache = new Map();
const overrides = new Map();
const mocks = {
  '@shared/theme/themeStorage': {},
  '@shared/theme/themeRegistry': {},
  '@shared/theme/themeVariants': {},
  '@platform/persistence': { databaseCoordinator: coordinator },
  '@features/media': { releaseMediaAssetCandidates: async () => {} },
  '@features/stickers': { isStickerSendIntent: value => value?.discriminator === 'ravencat.sticker.send.v1' },
  '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline() {} },
  ...agentToolSchemaDependencies,
};
function load(relative) {
  let file = path.resolve(root, relative);
  if (!path.extname(file)) file = fs.existsSync(file + '.ts') ? file + '.ts' : path.join(file, 'index.ts');
  if (overrides.has(file)) return overrides.get(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id === '@shared/aiTools') return load('src/shared/aiTools/AgentToolInputSchema.ts');
    if (id.startsWith('@shared/')) return load('src/shared/' + id.slice(8));
    assert.ok(id.startsWith('.'), `缺少边界依赖 ${id}`);
    return load(path.resolve(path.dirname(file), id));
  }, module, module.exports);
  return module.exports;
}
const override = (file, value) => overrides.set(path.resolve(root, file), value);
override('src/features/chat/reply/agent/ChatStreamingReplyProjector.ts', {});
override('src/features/chat/reply/agent/ChatAgentToolTimelineProjector.ts', {});
override('src/features/chat/reply/agent/SendVoiceMessageTool.ts', { isVoiceMessageSendIntent: () => false });
override('src/features/chat/reply/application/AssistantMessageDelivery.ts', {
  deliverAssistantMessage() { throw new Error('不得执行 Legacy 分段入库'); },
});
mocks['@features/chat/messages/domain'] = load('src/features/chat/messages/domain/chatMessageMetadata.ts');
override('src/features/chat/messages/domain/index.ts', mocks['@features/chat/messages/domain']);

const { messageRepository: messages } = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts');
const { conversationTurnRepository: turns } = load('src/features/chat/reply/infrastructure/SQLiteConversationTurnRepository.ts');
const { chatTurnPresentationRepository: displays } = load('src/features/chat/reply/infrastructure/SQLiteChatTurnPresentationRepository.ts');
const presentation = load('src/features/chat/reply/application/ChatTurnPresentationRuntime.ts');
if (!directory) {
  presentation.configureChatTurnPresentation(displays);
  await presentation.recoverTurnPresentationDisplays();
  const unreadBeforeRead = await messages.getUnreadCountByAI('ai');
  await messages.markMessagesAsRead('stream-bubbles-stopped');
  const unreadAfterRead = await messages.getUnreadCountByAI('ai');
  const orphan = await turns.takeOverOrphan('orphan-tools', 'user_reply');
  const mediaOrphan = await turns.takeOverOrphan('early-media-crash', 'user_reply');
  console.log(JSON.stringify({ unreadBeforeRead, unreadAfterRead, history: await displays.listHistory('s'), visible: (await messages.getMessages('s', { limit: 100 })).messages,
    orphan, orphanStatus: db.prepare("SELECT status, terminal_reason FROM conversation_turn_runs WHERE session_id = 'orphan-tools'").get(),
    earlyHistory: await displays.listHistory('early-text'),
    autonomousFailureHistory: await displays.listHistory('autonomous-model-failure'),
    autonomousFailureEvidence: await messages.listAgentActivityEvidence(['autonomous-model-failure']),
    streamedVisible: (await messages.getMessages('stream-bubbles', { limit: 100 })).messages,
    streamedInterrupted: await displays.listHistory('stream-bubbles-stopped'),
    completeVisible: (await messages.getMessages('complete-loop', { limit: 100 })).messages,
    crashVisible: (await messages.getMessages('crash-display', { limit: 100 })).messages,
    timeoutVisible: (await messages.getMessages('timeout-display', { limit: 100 })).messages,
    mediaOrphan, mediaCrashMessages: (await messages.getMessages('early-media-crash', { limit: 100 })).messages,
    mediaCrashContext: await presentation.getChatInterruptedTurnContext('early-media-crash', 0) }));
  db.close();
  process.exit(0);
}
const store = load('src/features/chat/messages/application/AgentTransientTimeline.ts');
const foreground = load('src/features/chat/reply/delivery/ChatForegroundContext.ts');
const { ChatAgentRunProjector } = load('src/features/chat/reply/agent/ChatAgentRunProjector.ts');
const { AgentRuntime } = load('src/platform/agentRuntime/AgentRuntime.ts');
const { AgentToolRegistry } = load('src/platform/agentRuntime/AgentToolRegistry.ts');
const { AgentRunEventQueue } = load('src/platform/agentRuntime/AgentRunEventQueue.ts');
mocks['@platform/agentRuntime'] = { AgentRunEventQueue };
const runtime = load('src/features/chat/messages/application/ChatMessageRuntime.ts');
const { commitCanonicalUserMessage } = load('src/features/chat/messages/application/CommitCanonicalUserMessage.ts');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stamp = '2026-10-15T10:00:00.000Z';
const ai = { id: 'ai', agentId: 'agent', name: 'AI' };
const reasoningFor = step => `CoT${step}${'x'.repeat(96)}`;
const user = text => ({ sessionId: 's', text, senderType: 'user', isMe: true, createdAt: stamp, time: '18:00' });
const usageOf = message => [message.tokensUsed, message.promptTokens, message.completionTokens,
  JSON.parse(message.metadataJson).cachedTokens];
const usageFor = step => ({ totalTokens: 120 + step, promptTokens: 100, completionTokens: 20 + step,
  cachedTokens: step === 1 ? 80 : step === 2 ? 0 : undefined });

// 增量消费者只在批次边界物化变动条目，既不重算旧分段，也不漏掉同批工具的部分结果。
const { ChatAgentTimeline } = load('src/features/chat/reply/agent/ChatAgentTimeline.ts');
let readChanges;
const deltaTimeline = new ChatAgentTimeline('incremental', { onDirty: read => { readChanges = read; } }, { bubbleDeliveryMode: 'multi-bubble' });
deltaTimeline.startStep(1);
for (let i = 0; i < 200; i++) deltaTimeline.appendDelta(1, 'reasoning', 'x');
assert.equal(readChanges().length, 1);
assert.deepEqual(readChanges(), [], '没有变化时不能重复发布旧版本');
deltaTimeline.appendDelta(1, 'assistant', 'first\n\nsecond');
assert.deepEqual(readChanges().map(item => [item.text, item.status]), [['first', 'sent'], ['second', 'streaming']],
  '首泡在空行处闭合，尾泡立即展示真实流式正文');
deltaTimeline.appendDelta(1, 'assistant', ' tail');
assert.deepEqual(readChanges().map(item => item.text), ['second tail'], '新 token 只发布活动气泡，不重写已闭合气泡');
deltaTimeline.reconcileModelTurn(1, { assistantText: 'first\n\nsecond tail', reasoningText: 'x'.repeat(200),
  toolCalls: [{ id: 'a', name: 'one', arguments: '{}' }, { id: 'b', name: 'two', arguments: '{}' }], usage: {}, messageId: 'm' });
const finalized = readChanges();
assert.deepEqual(finalized.filter(item => item.kind === 'assistant').map(item => item.text), ['first', 'second tail']);
deltaTimeline.startToolStatus(1);
readChanges();
deltaTimeline.markToolStarted(1, 'a');
deltaTimeline.completeToolCall(1, 'a', { status: 'success', modelContent: 'actual-result-a' });
const partial = readChanges();
assert.deepEqual(partial.map(item => item.kind), ['tool'], '工具更新不能重新投递之前的正文与思维链');
assert.equal(partial[0].toolExecutions[0].modelContent, 'actual-result-a');
assert.equal(partial[0].toolExecutions[1].status, 'proposed');
assert.equal(deltaTimeline.snapshots().length, 4, '完整快照消费者保留原契约');

for (const bubbleDeliveryMode of ['single-bubble', 'multi-bubble']) for (const cachedTokens of [80, 0, undefined]) {
  const usageRun = `usage-${bubbleDeliveryMode}-${cachedTokens}`;
  const timeline = new ChatAgentTimeline(usageRun, {}, { bubbleDeliveryMode });
  timeline.startStep(1);
  timeline.appendDelta(1, 'assistant', 'first\n\nsecond');
  assert.equal(timeline.snapshots().at(-1).tokensUsed, undefined, '真实统计到达前不能估算尾段用量');
  timeline.reconcileModelTurn(1, { assistantText: 'first\n\nsecond', reasoningText: '', toolCalls: [],
    usage: { totalTokens: 120, promptTokens: 100, completionTokens: 20, cachedTokens }, messageId: usageRun });
  store.applyAgentTransientTimelineSnapshots({ sessionId: usageRun, snapshots: timeline.snapshots() });
  const projected = store.snapshotAgentTransientTimelineWithReplacements(usageRun);
  assert.deepEqual(projected.map(usageOf), bubbleDeliveryMode === 'single-bubble'
    ? [[120, 100, 20, cachedTokens]] : [[0, 0, 0, undefined], [120, 100, 20, cachedTokens]]);
  store.clearAgentTransientTimelineRun(usageRun, usageRun);
}

try {
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE chat_conversations(id TEXT PRIMARY KEY, kind TEXT);
    CREATE TABLE ai_assistants(id TEXT PRIMARY KEY); INSERT INTO ai_assistants VALUES ('ai');
    CREATE TABLE sessions(id TEXT PRIMARY KEY, last_message TEXT, last_time TEXT, updated_at TEXT,
      visible_after_message_id INTEGER, visible_after_at TEXT, ai_assistant_id TEXT);
    INSERT INTO chat_conversations VALUES ('s', 'direct'); INSERT INTO sessions(id) VALUES ('s');
    CREATE TABLE media_assets(id TEXT PRIMARY KEY);
    CREATE TABLE business_effects(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO business_effects VALUES (1, 0);`);
  for (const key of ['messages', 'conversationTurnRuns', 'conversationTurnState', 'chatToolPackageExposure', 'chatRegenerationRequests', 'chatTimelineRunAnchors', 'chatTurnPresentations', 'chatSummary', 'groupChats']) {
    if (SCHEMAS[key]) db.exec(SCHEMAS[key]);
  }
  // canonical 排序锚点与生产建库保持同源。
  installChatTimelineSchema(db);
  mocks['@shared/prompt'] = { estimateTextTokens: text => text.length };
  const { SQLiteChatSummaryRepository } = load('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts');
  const summaries = new SQLiteChatSummaryRepository(async () => []);
  db.exec(INDEXES.idxTurnRunsSingleActive);
  db.exec(INDEXES.idxMessagesTurnItem);
  presentation.configureChatTurnPresentation(displays);
  const pendingPaces = [];
  const releasedBatches = [];
  const closed = new Map();
  const activeDisplays = new Set();
  let holdArrival = true;
  presentation.configureTurnDisplayPacing(async runId => {
    if (!activeDisplays.has(runId) || closed.has(runId)) return false;
    if (!holdArrival) return true;
    const gate = defer(); pendingPaces.push({ runId, gate });
    return gate.promise;
  }, async (ids, open) => {
    for (const id of ids) {
      const count = (closed.get(id) ?? 0) + (open ? -1 : 1);
      if (count > 0) closed.set(id, count); else closed.delete(id);
      for (const pending of pendingPaces) if (pending.runId === id && !open) pending.gate.resolve(false);
    }
  }, async ids => { releasedBatches.push([...ids]); }, async (runId, active) => {
    if (active) { assert.equal(activeDisplays.has(runId), false); activeDisplays.add(runId); }
    else { activeDisplays.delete(runId); closed.delete(runId); }
  });
  runtime.configureChatMessageRuntime({ messages, turns,
    turnPresentation: { freeze: presentation.freezeTurnDisplays, interrupt: presentation.interruptSessionTurnDisplays } });
  // 启动回执独立于执行 revision；旧请求的迟到拒绝不得覆盖新请求或新输入。
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('host-status', 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('host-status');
  const statusInput = text => commitCanonicalUserMessage({ message: { ...user(text), sessionId: 'host-status' } });
  await statusInput('等待宿主');
  assert.equal((await displays.getExecutionStatus('host-status')).phase, 'waiting_host');
  const revisionBefore = db.prepare('SELECT revision FROM conversation_turn_state WHERE session_id = ?').get('host-status').revision;
  const firstStart = await turns.beginExecutionHostRequests(['host-status']);
  const secondStart = await turns.beginExecutionHostRequests(['host-status']);
  await turns.finishExecutionHostRequests(secondStart, true);
  await turns.finishExecutionHostRequests(firstStart, false);
  assert.equal((await displays.getExecutionStatus('host-status')).phase, 'host_started');
  assert.equal(db.prepare('SELECT revision FROM conversation_turn_state WHERE session_id = ?').get('host-status').revision, revisionBefore);
  await statusInput('新的输入');
  assert.equal((await displays.getExecutionStatus('host-status')).phase, 'waiting_host');
  const rejectedStart = await turns.beginExecutionHostRequests(['host-status']);
  await turns.finishExecutionHostRequests(rejectedStart, false);
  assert.equal((await displays.getExecutionStatus('host-status')).reason, 'execution_host_start_rejected');
  const statusRun = await turns.claimIfIdle('host-status', 'user_reply');
  await displays.open(statusRun);
  await displays.checkpoint(statusRun.runId, [], { phase: 'request_failed', at: stamp });
  await turns.revoke(statusRun, 'failed', 'network_request_failed');
  assert.deepEqual(await displays.getExecutionStatus('host-status'), {
    phase: 'request_failed', at: db.prepare('SELECT terminal_at FROM conversation_turn_runs WHERE run_id = ?').get(statusRun.runId).terminal_at,
    reason: 'network_request_failed',
  });
  foreground.setChatForegroundContext({ appActive: true, chatRouteActive: true, isChatVisible: true, aiId: 'ai', sessionId: 's', groupId: null });

  const runtimeWrites = writes;
  await commitCanonicalUserMessage({ message: user('开始多轮工具任务') });
  const run = await turns.claimIfIdle('s', 'user_reply');
  const display = new presentation.ChatTurnPresentation(run, ai.agentId, ai.id);
  await display.start();
  assert.equal((await displays.getExecutionStatus('s')).phase, 'preparing');
  const phases = [];
  let commits = 0;
  const controller = new AbortController();
  const projector = new ChatAgentRunProjector({ sessionId: 's', repository: messages, aiConfig: ai,
    callbacks: {}, runtimeContext: { replyRunId: run.runId, abortSignal: controller.signal },
    policy: { bubbleDeliveryMode: 'multi-bubble', modelTransport: 'stream', enableTools: true },
    projection: { kind: 'canonical', commit: { async commitAgentTimeline(params) {
      commits++; return turns.commitTurn(run, params.items, { assistantId: 'ai', changes: [] });
    } } }, stopRuntime: () => controller.abort(), replyRunId: run.runId,
    finalAssistantPolicy: 'commit_as_reply', timelineSink: display.sink });
  const registry = new AgentToolRegistry();
  registry.register({ descriptor: { name: 'modify_data', description: '更新测试业务值', inputSchema: { type: 'object' } },
    async execute() { db.exec('UPDATE business_effects SET value = value + 1'); return { status: 'success', modelContent: '业务已修改' }; } });
  const turnsByStep = new Map();
  let step = 0;
  const thirdRequest = defer();
  const never = defer();
  const agent = new AgentRuntime({ registry, modelGateway: { async runTurn(_request, emit) {
    step++;
    if (step === 3) { thirdRequest.resolve(); await never.promise; }
    const reasoningText = reasoningFor(step);
    // 一百个真实增量不应导致一百个数据库事务。
    for (const text of reasoningText) await emit({ type: 'reasoning_delta', text });
    await emit({ type: 'assistant_text_delta', text: `Message${step}` });
    const toolCalls = [{ id: `tool-${step}`, name: 'modify_data', arguments: '{}', index: 0 }];
    const turn = { assistantText: `Message${step}`, reasoningText, toolCalls, finishReason: 'tool_calls',
      historyItems: [{ role: 'assistant', content: `Message${step}`, reasoningText, toolCalls }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, messageId: `model-${step}` };
    turnsByStep.set(step, turn);
    return turn;
  } } });
  const eventTypes = [];
  const queue = new AgentRunEventQueue(async event => {
    display.observeRunEvent(event);
    eventTypes.push(event.type);
    if (event.type === 'model_turn_completed') await projector.projectModelTurn(event.stepIndex, turnsByStep.get(event.stepIndex));
    else await projector.handleEvent(event);
    if (event.type === 'tool_call_started') await display.recordToolStart();
    else if (event.type === 'step_completed') await display.flush();
    if (event.type === 'model_turn_started' || event.type === 'reasoning_delta' || event.type === 'tool_call_started' || event.type === 'tool_call_completed') {
      // 事件正常异步合并；定向采样阶段边界，不能为了观察而给 Runtime 加 UI 等待。
      if (event.type !== 'reasoning_delta' || !phases.includes('receiving_model')) {
        await display.flush();
        phases.push((await displays.getExecutionStatus('s')).phase);
      }
    }
  });
  const running = agent.run({ runId: run.runId, task: { id: 'task', type: 'chat_reply', source: 'chat', goal: '更新两次', assistantId: 'ai', sessionId: 's',
    allowedToolNames: ['modify_data'], modelTransport: 'stream', maxSteps: 10, maxToolCalls: 30, maxToolCallsPerStep: 3, createdAt: stamp },
    initialHistory: [], signal: controller.signal, eventSink: queue.enqueue.bind(queue) });
  await Promise.race([thirdRequest.promise, running.then(result => { throw new Error(`Runtime 提前结束：${JSON.stringify(result)}`); })]);
  await display.flush();
  assert.ok(phases.includes('waiting_model'));
  assert.ok(phases.includes('receiving_model'));
  assert.ok(phases.includes('executing_tool'));
  assert.ok(phases.includes('processing_result'));
  const live = store.snapshotAgentTransientTimelineWithReplacements('s');
  assert.ok(live.some(message => message.text === reasoningFor(2)), '首条正文等待时，第二轮思维链仍须可见');
  assert.ok(live.filter(message => message.senderType === 'system').length >= 2, '两轮工具状态应及时发布');
  assert.equal(live.some(message => message.text.includes('待交付') || message.text === '正在生成回复'), false, '不能用占位气泡冒充模型输出');
  assert.equal(db.prepare('SELECT value FROM business_effects').get().value, 2);
  assert.equal(commits, 0, '等待第三轮模型时不得提前 canonical 提交');
  db.exec("CREATE TRIGGER fail_interruption BEFORE INSERT ON messages WHEN NEW.text = '回滚发送' BEGIN SELECT RAISE(ABORT, 'send rollback'); END;");
  await assert.rejects(commitCanonicalUserMessage({ message: user('回滚发送') }), /send rollback/);
  db.exec('DROP TRIGGER fail_interruption');
  assert.equal(closed.has(run.runId), false, 'T1 回滚必须恢复原批次放行资格');
  await display.flush();
  const shownTool = live.find(message => message.senderType === 'system');
  assert.ok(shownTool);
  await Promise.all([
    commitCanonicalUserMessage({ message: user('打断旧任务') }),
    commitCanonicalUserMessage({ message: user('快速连发第二条') }),
  ]);
  controller.abort('SUPERSEDED');
  const terminal = await running;
  await queue.drain();
  await projector.completeRun(terminal);
  await display.finish();
  assert.equal(terminal.terminalCode, 'SUPERSEDED');
  assert.equal(commits, 0);
  assert.ok(eventTypes.filter(type => type === 'tool_call_started').length === 2);
  const interrupted = await displays.listHistory('s');
  const publishedPrefix = [reasoningFor(1), shownTool.text, reasoningFor(2), shownTool.text];
  assert.deepEqual(interrupted[0].items.map(item => item.snapshot.text), publishedPrefix, '折叠卡片不需要屏幕回执才能保留已交付过程');
  assert.equal(interrupted[0].items[1].snapshot.status, 'completed', '中断不能把已完成工具改写成失败');
  const continuation = await displays.listInterruptedContext('s', run.inputHighWatermark);
  assert.deepEqual(continuation[0].items.flatMap(item => item.toolExecutions ?? []).map(call => [call.toolCallId, call.status, call.modelContent]),
    [['tool-1', 'success', '业务已修改'], ['tool-2', 'success', '业务已修改']]);
  mocks['@features/chat'] = {
    getChatInterruptedTurnContext: presentation.getChatInterruptedTurnContext,
    getChatSummaryContext: async (_sessionId, protectedIds = []) => ({ settings: { generationEnabled: false, fixedMessageId: null }, contextSegments: [],
      timeline: (await messages.listUserMessagesInRange('s', 0, Number.MAX_SAFE_INTEGER)).filter(message => !protectedIds.includes(message.id)).map(message => ({
        source: 'chat', speaker: 'user', kind: 'dialogue', messageId: message.id,
        timestamp: message.createdAt, content: message.text, logicalIdentity: null,
      })) }),
  };
  const { promptHistoryBuilder } = load('src/host/prompt/PromptHistoryBuilder.ts');
  const pendingUsers = await messages.listUserMessagesInRange('s', 0, Number.MAX_SAFE_INTEGER);
  const resumedHistory = await promptHistoryBuilder.loadPrivateSummaryContext({ sessionId: 's', aiConfig: ai,
    runtimeContext: { batchedUserMessageIds: [pendingUsers.at(-1).id] } });
  const toolHistory = resumedHistory.messages.filter(message => message.logicalMessageId === `interrupted:${run.runId}`);
  assert.equal(toolHistory.length, 1, '后续模型必须读到旧执行的真实工具结果');
  assert.equal(toolHistory[0].role, 'user', '应用执行资料不能冒充助手曾经发给用户的回复');
  assert.ok(toolHistory[0].content.includes('tool-2') && toolHistory[0].content.includes('业务已修改'));
  assert.equal(resumedHistory.messages[1], toolHistory[0], '执行记录属于原输入之后，不能错放到后续用户消息之后');
  assert.equal(db.prepare('SELECT value FROM business_effects').get().value, 2, '读取历史不重放工具');
  override('src/features/chat/reply/application/BuildChatBatchAIInput.ts', {
    buildChatUserMessageModelInput: async message => ({ displayText: message.text, modelInput: message.text }),
  });
  const { buildChatTurnAIInput } = load('src/features/chat/reply/application/BuildChatTurnAIInput.ts');
  const continuedInput = await buildChatTurnAIInput({ repository: messages, sessionId: 's', replyCursorAtClaim: 0,
    inputHighWatermark: pendingUsers.at(-1).id, assistantId: 'ai' });
  assert.deepEqual(continuedInput.turnInputMessages.map(message => message.role), ['user', 'user', 'user', 'user'],
    '未消费输入中的执行资料也不能作为助手回复示例');
  assert.equal(continuedInput.turnInputMessages[0].content, '开始多轮工具任务');
  assert.ok(continuedInput.turnInputMessages[1].content.includes('tool-2'));
  assert.equal(continuedInput.turnInputMessages[2].content, '打断旧任务');
  const { applyRuntimeModelInput } = load('src/features/chat/reply/application/ChatReplyUtils.ts');
  const actualModelInput = applyRuntimeModelInput([{ role: 'system', content: '冻结上下文' }, { role: 'user', content: continuedInput.displayText }],
    undefined, continuedInput.turnInputMessages);
  assert.deepEqual(actualModelInput.slice(1), continuedInput.turnInputMessages.map(({ createdAt, ...message }) => message), '真实模型输入适配不能把旧任务重复追加到执行结果之后');
  const protectedHistory = await promptHistoryBuilder.loadPrivateSummaryContext({ sessionId: 's', aiConfig: ai,
    runtimeContext: { batchedUserMessageIds: pendingUsers.map(message => message.id) } });
  assert.equal(protectedHistory.messages.some(message => message.logicalMessageId === `interrupted:${run.runId}`), false, '本轮固定输入内的执行记录不能重复注入普通历史');
  const closedLive = store.snapshotAgentTransientTimelineWithReplacements('s');
  assert.deepEqual(closedLive.filter(message => message.senderType === 'reasoning').map(message => message.text), [reasoningFor(1), reasoningFor(2)]);
  assert.equal(closedLive.some(message => message.text.includes('已中断')), false, '停止执行不能用中断气泡替换真实过程');
  await assert.rejects(display.recordToolStart(), /cancelled/, '关闭后不得开始旧 run 的下一项工具');
  assert.equal((await messages.getMessages('s', { limit: 100 })).messages.filter(message => !message.isMe).length, 0);

  // 新 run 正式 T3 后仍在分段：输入立即放出 B，不更改执行终态或回复游标。
  holdArrival = false;
  const next = await turns.claimIfIdle('s', 'user_reply');
  const nextDisplay = new presentation.ChatTurnPresentation(next, ai.agentId, ai.id);
  await nextDisplay.start();
  const values = ['A', 'B'].map((text, index) => ({ message: { ...user(text), isMe: false, senderType: 'assistant',
    clientMessageId: `agent-timeline:${next.runId}:${index + 1}:0`,
    tokensUsed: index === 0 ? 120 : 0, promptTokens: index === 0 ? 100 : 0, completionTokens: index === 0 ? 20 : 0,
    metadataJson: JSON.stringify({ timelineSequence: index + 1, stepIndex: 1, cachedTokens: index === 0 ? 80 : undefined }) } }));
  const arrival = load('src/features/chat/reply/delivery/AssistantMessageArrival.ts');
  let arrivalRevision = 0;
  arrival.configureAssistantMessageArrivalRuntime({ begin: async batch => ({ revision: ++arrivalRevision,
    pendingMessageIds: batch.messageIds, pendingSessionIds: ['s'] }),
    finish: async () => ({ revision: ++arrivalRevision, pendingMessageIds: [], pendingSessionIds: [] }) });
  const deliveryEvents = [];
  load('src/features/chat/reply/delivery/AIMessageEvents.ts').configureAIMessageDeliveryHandler(async payload => {
    deliveryEvents.push(payload);
    return { status: 'suppressed_foreground' };
  });
  const { createSingleTransactionTurnCommit } = load('src/features/chat/reply/application/SingleTransactionTurnCommit.ts');
  const streamingWritesBefore = writes;
  // 流式多气泡在生成过程中持续展示；阻塞非流式时钟不能阻塞它，T3 不重排或重播。
  const streamingText = '首泡\n\n' + '长'.repeat(99) + '！？”)下一句\n\n末泡';
  const { segmentAssistantReplyText } = load('src/features/chat/reply/application/AssistantReplySegmentation.ts');
  const streamingExpected = segmentAssistantReplyText(streamingText, 'multi-bubble');
  const streamingSession = 'stream-bubbles';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(streamingSession, 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run(streamingSession);
  await commitCanonicalUserMessage({ message: { ...user('边说边分泡'), sessionId: streamingSession } });
  const streamingRun = await turns.claimIfIdle(streamingSession, 'user_reply');
  db.prepare('UPDATE sessions SET ai_assistant_id = ? WHERE id = ?').run(ai.id, streamingSession);
  const streamingDisplay = new presentation.ChatTurnPresentation(streamingRun, ai.agentId, ai.id);
  const streamingCommit = createSingleTransactionTurnCommit(streamingRun, ai.id, streamingDisplay);
  const displayPreviews = [];
  streamingCommit.configureSegmentDelivery({ aiConfig: ai, runtimeContext: { replyRunId: streamingRun.runId }, callbacks: {
    onReplyDisplaySegment: payload => { displayPreviews.push(payload); return { userNotificationHandled: true }; },
  } });
  await streamingDisplay.start();
  const liveStreaming = new ChatAgentTimeline(streamingRun.runId, streamingDisplay.sink, { bubbleDeliveryMode: 'multi-bubble' });
  liveStreaming.startStep(1);
  holdArrival = true;
  const waitsBeforeStreaming = pendingPaces.length;
  let previousBubbles = new Map();
  for (const chunk of ['首', '泡\n', '\n', '长'.repeat(99), '！', '？', '”', ')', '下', '一句\n\n', '末', '泡']) {
    liveStreaming.appendDelta(1, 'assistant', chunk);
    await streamingDisplay.flush();
    const visible = store.snapshotAgentTransientTimelineWithReplacements(streamingSession);
    assert.ok(visible.length > 0, '模型尚未完成时已有正文，不等待整段');
    for (const bubble of visible) {
      const previous = previousBubbles.get(bubble.clientMessageId);
      if (previous !== undefined) assert.ok(bubble.text.startsWith(previous), '同一气泡只增长，不回缩或搬动正文');
    }
    previousBubbles = new Map(visible.map(bubble => [bubble.clientMessageId, bubble.text]));
    const shown = (await displays.listHistory(streamingSession))[0].items.map(item => item.snapshot.text);
    assert.deepEqual(shown, visible.map(bubble => bubble.text), '每次可见增量均先持久保存');
    assert.equal(pendingPaces.length, waitsBeforeStreaming, '空行闭合与活动尾泡均不增加非流式计时等待');
  }
  assert.deepEqual([...previousBubbles.values()], streamingExpected);
  const streamingDeliveries = () => deliveryEvents.filter(item => item.sessionId === streamingSession);
  assert.deepEqual(streamingDeliveries().map(item => item.message), streamingExpected.slice(0, -1),
    '闭合气泡在模型尚未结束时逐条通知，活动尾泡不按 delta 重复通知');
  assert.equal((await messages.getLatestArrivedConversationPreview(streamingSession, [])).text, streamingExpected.at(-2),
    '列表立即同步最后一个已交付完整气泡，不显示尚未闭合的尾泡');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND sender_type = 'assistant'").get(streamingSession).count, 0);
  assert.equal(await messages.getUnreadCountByAI(ai.id), streamingExpected.length - 1, 'T3 前闭合正文逐泡计入未读，活动尾泡不计入');
  await messages.markMessagesAsRead(streamingSession);
  assert.equal(await messages.getUnreadCountByAI(ai.id), 0, '运行中打开会话即可清除已交付正文的未读');
  liveStreaming.reconcileModelTurn(1, { assistantText: streamingText, reasoningText: '', toolCalls: [],
    usage: { totalTokens: 120, promptTokens: 100, completionTokens: 20, cachedTokens: 80 }, messageId: 'stream-model' });
  await streamingDisplay.flush();
  assert.equal((await messages.getLatestArrivedConversationPreview(streamingSession, [])).text, streamingExpected.at(-1));
  assert.equal(await messages.getUnreadCountByAI(ai.id), 0, '已看过的活动气泡完成或补齐统计时不重新制造未读');
  const streamingItems = liveStreaming.buildCommitItems({ sessionId: streamingSession, aiConfig: ai,
    policy: { bubbleDeliveryMode: 'multi-bubble' }, finalAssistantPolicy: 'commit_as_reply', finalStepIndex: 1 });
  assert.deepEqual(streamingDeliveries().map(item => item.message), streamingExpected, '模型本次发言结束即通知尾泡，不等待 T3');
  const streamingResult = await streamingCommit.commitAgentTimeline({ sessionId: streamingSession, aiConfig: ai,
    response: { text: streamingText }, runtimeContext: { replyRunId: streamingRun.runId }, items: streamingItems, callbacks: {} });
  await streamingDisplay.finish();
  assert.equal(streamingResult.outcome, 'committed');
  assert.equal(await messages.getUnreadCountByAI(ai.id), 0, 'T3 继承展示已读事实');
  assert.ok(streamingResult.messages.filter(item => item.senderType === 'assistant').every(item => item.isRead));
  assert.equal((await messages.getLatestArrivedConversationPreview(streamingSession, streamingResult.messages.map(item => item.id))).text,
    streamingExpected.at(-1), 'T3 身份交接不能把已经显示的列表预览退回用户输入');
  assert.equal((await messages.getLatestArrivedConversationPreview(streamingSession, streamingResult.messages.slice(1).map(item => item.id))).text,
    streamingExpected.at(-1), '同一时间生成的正式气泡逐条接管时，预览仍保留已经交付的末泡');
  db.exec('SAVEPOINT preview_newer_input');
  const addBackdatedUser = db.prepare(`INSERT INTO messages(session_id, text, is_me, sender_type, time, created_at, metadata_json)
    VALUES (?, ?, 1, 'user', '12:00', '2000-01-01T00:00:00.000Z', ?)`);
  const streamingExcludedIds = streamingResult.messages.map(item => item.id);
  addBackdatedUser.run(streamingSession, '通话记录', JSON.stringify({ type: 'callStatus' }));
  assert.equal((await messages.getLatestArrivedConversationPreview(streamingSession, streamingExcludedIds)).text,
    streamingExpected.at(-1), '通话记录不作为后续用户输入压住已交付正文预览');
  addBackdatedUser.run(streamingSession, '后续用户输入', null);
  assert.equal((await messages.getLatestArrivedConversationPreview(streamingSession, streamingExcludedIds)).text,
    '边说边分泡', '后续用户输入按持久 ID 关闭旧运行预览，不依赖消息时间戳');
  db.exec('ROLLBACK TO preview_newer_input');
  db.exec('RELEASE preview_newer_input');
  db.exec('SAVEPOINT preview_clear_boundary');
  db.prepare('UPDATE sessions SET visible_after_message_id = (SELECT MAX(id) FROM messages WHERE session_id = ?) WHERE id = ?')
    .run(streamingSession, streamingSession);
  assert.equal(await messages.getLatestArrivedConversationPreview(streamingSession, []), null, '清空历史同时隐藏旧运行正文预览');
  db.exec('ROLLBACK TO preview_clear_boundary');
  db.exec('RELEASE preview_clear_boundary');
  assert.deepEqual(streamingDeliveries().map(item => item.message), streamingExpected, 'T3 不重复通知已交付的气泡');
  assert.deepEqual(streamingDeliveries().map(item => item.clientMessageId), [...previousBubbles.keys()]);
  assert.deepEqual(displayPreviews.map(item => item.text), streamingExpected, '悬浮预览与通知共享逐泡持久发布边界');
  assert.ok(streamingDeliveries().every(item => item.userNotificationHandled), '保留消费者的精确展示回执');
  assert.ok(streamingDeliveries().every(item => item.committedMessageId === undefined && item.arrivalAlreadyScheduled));
  assert.equal(pendingPaces.length, waitsBeforeStreaming, '已流式展示的正文在 T3 后不重播分段间隔');
  const streamingSaved = (await messages.getMessages(streamingSession, { limit: 100 })).messages.filter(message => message.senderType === 'assistant');
  assert.deepEqual(streamingSaved.map(message => message.text), streamingExpected, '最终历史与流式分泡完全一致');
  assert.deepEqual(streamingSaved.map(message => message.clientMessageId), [...previousBubbles.keys()], 'T3 沿用已显示气泡身份');
  assert.deepEqual(streamingSaved.map(usageOf), streamingExpected.map((_, index) => index === streamingExpected.length - 1
    ? [120, 100, 20, 80] : [0, 0, 0, undefined]), '真实用量只由最终尾泡承载');
  // 中途打断时，只保留已交付的气泡和活动尾泡，不补发迟到正文。
  const stoppedSession = 'stream-bubbles-stopped';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(stoppedSession, 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run(stoppedSession);
  await commitCanonicalUserMessage({ message: { ...user('开始'), sessionId: stoppedSession } });
  const stoppedRun = await turns.claimIfIdle(stoppedSession, 'user_reply');
  const stoppedDisplay = new presentation.ChatTurnPresentation(stoppedRun, ai.agentId, ai.id);
  createSingleTransactionTurnCommit(stoppedRun, ai.id, stoppedDisplay).configureSegmentDelivery({ aiConfig: ai });
  await stoppedDisplay.start();
  const stoppedTimeline = new ChatAgentTimeline(stoppedRun.runId, stoppedDisplay.sink, { bubbleDeliveryMode: 'multi-bubble' });
  stoppedTimeline.startStep(1);
  stoppedTimeline.appendDelta(1, 'assistant', '已闭合\n\n活动尾泡');
  await stoppedDisplay.flush();
  await commitCanonicalUserMessage({ message: { ...user('停止'), sessionId: stoppedSession } });
  stoppedTimeline.appendDelta(1, 'assistant', '迟到正文');
  await stoppedDisplay.flush();
  await stoppedDisplay.finish();
  assert.deepEqual((await displays.listHistory(stoppedSession))[0].items.map(item => item.snapshot.text), ['已闭合', '活动尾泡']);
  assert.deepEqual(deliveryEvents.filter(item => item.sessionId === stoppedSession).map(item => item.message), ['已闭合'],
    '中断保留已经提醒的气泡，不补发活动尾泡或迟到正文');
  assert.equal((await messages.getLatestArrivedConversationPreview(stoppedSession, [])).text, '停止', '后续用户输入优先于旧 run 已交付的正文');
  holdArrival = false;
  const commit = createSingleTransactionTurnCommit(next, ai.id, nextDisplay);
  const streamingScenarioWrites = writes - streamingWritesBefore;
  const delivered = [];
  let finalReplies = 0;
  let completions = 0;
  let cursor;
  const committed = await commit.commitAgentTimeline({ sessionId: 's', response: { text: 'A\n\nB' }, aiConfig: ai,
    runtimeContext: { replyRunId: next.runId }, items: values,
    callbacks: { async onReplySegment(payload) {
      assert.equal((await displays.getExecutionStatus('s')).phase, 'delivering');
      const firstPublished = store.snapshotAgentTransientTimelineWithReplacements('s').find(message => message.text === 'A');
      assert.deepEqual(usageOf(firstPublished), [120, 100, 20, 80], 'T3 分段首次交付即携带统计，不等 canonical 历史读回');
      delivered.push(payload.text);
      cursor = db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get('s').reply_cursor;
      await commitCanonicalUserMessage({ message: user('打断分段交付') });
    }, onFinalReply: () => { finalReplies++; }, onReplyCommitted: () => { completions++; } } });
  assert.equal(committed.outcome, 'committed');
  await nextDisplay.finish();
  assert.deepEqual(delivered, ['A']);
  assert.equal(finalReplies, 0, '展示被打断时不得通过完整回复回调泄漏 B');
  assert.equal(completions, 1, '受控宿主等待仍必须正常结束');
  assert.equal(await displays.publishMessage(committed.messages[1].id), null);
  assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get('s').reply_cursor, cursor);
  assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(next.runId).status, 'committed');
  assert.deepEqual((await messages.getMessages('s', { limit: 100 })).messages.filter(message => !message.isMe).map(message => message.text), ['A', 'B']);
  assert.equal(db.prepare('SELECT state FROM chat_turn_presentations WHERE run_id = ?').get(next.runId).state, 'completed');
  assert.ok(releasedBatches.some(ids => ids.includes(committed.messages[0].id) && ids.includes(committed.messages[1].id)), '新输入须批量清除原生 pending 过滤，不能让剩余分段继续被隐藏');
  assert.ok(writes - runtimeWrites - streamingScenarioWrites < 60,
    `两百个增量及发送回滚的合并写入次数过多：${writes - runtimeWrites - streamingScenarioWrites}`);
  // 真实提交的媒体仅在 T3 后取得展示元数据，确认前不能进入历史读取。
  const mediaRun = await turns.claimIfIdle('s', 'user_reply');
  const mediaDisplay = new presentation.ChatTurnPresentation(mediaRun, ai.agentId, ai.id);
  await mediaDisplay.start();
  const media = await turns.commitTurn(mediaRun, [{ message: { ...user(''), senderType: 'assistant', isMe: false,
    clientMessageId: `agent-timeline:${mediaRun.runId}:1:0`,
    metadataJson: JSON.stringify({ kind: 'sticker', sticker: { id: 'cat' }, timelineSequence: 1, stepIndex: 1 }) } }], { assistantId: 'ai', changes: [] });
  assert.equal(await messages.getMessageById(media.messages[0].id), null);
  assert.equal(await mediaDisplay.publishSegment(media.messages[0]), true);
  const projectedMedia = store.snapshotAgentTransientTimelineWithReplacements('s').find(message => message.clientMessageId === media.messages[0].clientMessageId);
  assert.equal(JSON.parse(projectedMedia.metadataJson).sticker.id, 'cat');
  await mediaDisplay.finish();
  assert.ok(await messages.getMessageById(media.messages[0].id));
  assert.equal(await displays.getExecutionStatus('s'), null, '完成展示后不应保留运行状态');
  const autonomousStatusOwner = await turns.claimAutonomousIfIdle('s', 'autonomous-status-isolation');
  assert.ok(autonomousStatusOwner);
  assert.equal(await displays.getExecutionStatus('s'), null, '自主执行 owner 不冒充普通用户回复的准备阶段');
  await turns.finishAutonomous(autonomousStatusOwner);
  // 完整多轮 Loop：页面从未展开过程，也没有任何绘制回执，交付必须自行到达终态。
  const completeSession = 'complete-loop';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(completeSession, 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run(completeSession);
  await commitCanonicalUserMessage({ message: { ...user('按顺序做完两项操作'), sessionId: completeSession } });
  const completeRun = await turns.claimIfIdle(completeSession, 'user_reply');
  db.prepare('UPDATE sessions SET ai_assistant_id = ? WHERE id = ?').run(ai.id, completeSession);
  const completeDisplay = new presentation.ChatTurnPresentation(completeRun, ai.agentId, ai.id);
  await completeDisplay.start();
  foreground.setChatForegroundContext({ appActive: true, chatRouteActive: true, isChatVisible: true, aiId: 'ai', sessionId: completeSession, groupId: null });
  const completeTurns = new Map();
  const firstExposure = new Map();
  const firstPreludePresented = defer();
  const stopWatchingUsage = store.subscribeAgentTransientTimeline(completeSession, () => {
    for (const message of store.snapshotAgentTransientTimelineWithReplacements(completeSession)) {
      if (message.senderType !== 'assistant' || firstExposure.has(message.clientMessageId)) continue;
      firstExposure.set(message.clientMessageId, { text: message.text, usage: usageOf(message) });
      if (message.text === '前言1') firstPreludePresented.resolve();
    }
  });
  const completionCommit = createSingleTransactionTurnCommit(completeRun, ai.id, completeDisplay);
  completionCommit.configureSegmentDelivery({ aiConfig: ai, runtimeContext: { replyRunId: completeRun.runId } });
  const completionProjector = new ChatAgentRunProjector({ sessionId: completeSession, repository: messages, aiConfig: ai,
    callbacks: {}, runtimeContext: { replyRunId: completeRun.runId },
    policy: { bubbleDeliveryMode: 'multi-bubble', modelTransport: 'stream', enableTools: true },
    projection: { kind: 'canonical', commit: completionCommit }, stopRuntime() {}, replyRunId: completeRun.runId,
    finalAssistantPolicy: 'commit_as_reply', timelineSink: completeDisplay.sink });
  let completedEffects = 0;
  const firstToolStarted = defer();
  const finishFirstTool = defer();
  const completeRegistry = new AgentToolRegistry();
  completeRegistry.register({ descriptor: { name: 'finish_test_step', description: '记录测试操作', inputSchema: { type: 'object' } },
    async execute() {
      completedEffects++;
      if (completedEffects === 1) { firstToolStarted.resolve(); await finishFirstTool.promise; }
      return { status: 'success', data: {}, modelContent: `已完成第${completedEffects}项` };
    } });
  let completeStep = 0;
  const completeAgent = new AgentRuntime({ registry: completeRegistry, modelGateway: { async runTurn(_request, emit) {
    const stepIndex = ++completeStep;
    await emit({ type: 'reasoning_delta', text: `完整测试思考${stepIndex}` });
    const assistantText = stepIndex < 3 ? `前言${stepIndex}` : '最终第一段\n\n最终第二段';
    await emit({ type: 'assistant_text_delta', text: assistantText });
    const toolCalls = stepIndex < 3 ? [{ id: `done-${stepIndex}`, name: 'finish_test_step', arguments: '{}', index: 0 }] : [];
    const turn = { assistantText, reasoningText: `完整测试思考${stepIndex}`, toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop', historyItems: [{ role: 'assistant', content: assistantText, toolCalls }],
      usage: usageFor(stepIndex), messageId: `done-model-${stepIndex}` };
    completeTurns.set(stepIndex, turn); return turn;
  } } });
  const completeQueue = new AgentRunEventQueue(async event => {
    completeDisplay.observeRunEvent(event);
    if (event.type === 'model_turn_completed') await completionProjector.projectModelTurn(event.stepIndex, completeTurns.get(event.stepIndex));
    else await completionProjector.handleEvent(event);
    if (event.type === 'tool_call_started') await completeDisplay.recordToolStart();
  });
  const completing = completeAgent.run({ runId: completeRun.runId,
    task: { id: 'complete-task', type: 'chat_reply', source: 'chat', goal: '完成两项操作', assistantId: 'ai', sessionId: completeSession,
      allowedToolNames: ['finish_test_step'], modelTransport: 'stream', maxSteps: 5, maxToolCalls: 5, maxToolCallsPerStep: 1, createdAt: stamp },
    initialHistory: [], eventSink: completeQueue.enqueue.bind(completeQueue) });
  await firstToolStarted.promise;
  await firstPreludePresented.promise;
  await completeDisplay.flush();
  assert.deepEqual(deliveryEvents.filter(item => item.sessionId === completeSession).map(item => item.message), ['前言1'],
    '工具尚未完成时，模型已说出的正文应立即逐泡交付通知');
  assert.deepEqual([...firstExposure.values()], [{ text: '前言1', usage: [121, 100, 21, 80] }],
    '工具仍执行时，已经展示的前言必须自带本次模型统计');
  assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(completeRun.runId).status, 'active');
  assert.equal((await messages.getLatestArrivedConversationPreview(completeSession, [])).text, '前言1',
    '工具仍未完成、正式消息尚未写入时，会话列表已经显示前言');
  assert.equal(await messages.getUnreadCountByAI(ai.id), 1, '前言通知到达时，首页未读数同步增加');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND sender_type = 'assistant'").get(completeSession).count, 0);
  assert.equal(db.prepare('SELECT last_message FROM sessions WHERE id = ?').get(completeSession).last_message, '按顺序做完两项操作',
    '即时列表预览只读取交付事实，不提前回写持久会话预览');
  finishFirstTool.resolve();
  const completeResult = await completing;
  await completeQueue.drain();
  await completionProjector.completeRun(completeResult);
  await completeDisplay.finish();
  stopWatchingUsage();
  assert.deepEqual([...firstExposure.values()], [
    { text: '前言1', usage: [121, 100, 21, 80] }, { text: '前言2', usage: [122, 100, 22, 0] },
    { text: '最终第一段', usage: [0, 0, 0, undefined] }, { text: '最终第二段', usage: [123, 100, 23, undefined] },
  ], '前言与最终分段的首次展示已具有完整统计，零命中与未提供不能混淆');
  assert.equal(completeResult.terminalCode, 'COMPLETED');
  assert.equal(completedEffects, 2);
  assert.deepEqual(deliveryEvents.filter(item => item.sessionId === completeSession).map(item => item.message),
    ['前言1', '前言2', '最终第一段', '最终第二段'], '多轮模型发言逐条通知，T3 不重复、思考与工具过程不通知');
  assert.equal(await displays.getExecutionStatus(completeSession), null, '折叠过程不得让完成回复永久停在交付中');
  assert.equal(db.prepare('SELECT state FROM chat_turn_presentations WHERE run_id = ?').get(completeRun.runId).state, 'completed');
  const completeMessages = (await messages.getMessages(completeSession, { limit: 100 })).messages;
  assert.equal(completeMessages.filter(message => message.senderType === 'reasoning').length, 3);
  assert.equal(completeMessages.filter(message => message.senderType === 'system').length, 2);
  assert.deepEqual(completeMessages.filter(message => message.senderType === 'assistant').map(message => message.text), ['前言1', '前言2', '最终第一段', '最终第二段']);
  assert.equal(await messages.getUnreadCountByAI(ai.id), 4, '正式身份接管后每条气泡仍只计算一次');
  assert.equal(await messages.getUnreadCountByAI(ai.id, completeMessages.map(item => item.id)), 4,
    '已经交付的完整正文在 canonical 到达身份交接时不从未读数中消失');
  await messages.markMessagesAsRead(completeSession);
  assert.equal(await messages.getUnreadCountByAI(ai.id), 0);
  assert.deepEqual(completeMessages.filter(message => message.senderType === 'assistant').map(usageOf),
    [...firstExposure.values()].map(item => item.usage), 'T3 后历史接管不得突然补出或改写用量');
  assert.equal(store.snapshotAgentTransientTimelineWithReplacements(completeSession).some(message => message.text.includes('待交付') || message.text.includes('已中断')), false);
  await commitCanonicalUserMessage({ message: { ...user('接着说下一件事'), sessionId: completeSession } });
  assert.equal(db.prepare('SELECT state FROM chat_turn_presentations WHERE run_id = ?').get(completeRun.runId).state, 'completed', '新消息不能把已完成行动步骤改成中断');
  assert.deepEqual((await messages.getMessages(completeSession, { limit: 100 })).messages.filter(message => !message.isMe).map(message => message.text),
    completeMessages.filter(message => !message.isMe).map(message => message.text));
  assert.equal((await displays.getExecutionStatus(completeSession)).phase, 'waiting_host');
  // T3 前已经进入时间线的正文也必须保留；无需绘制测量或正式成功提交。
  const earlySession = 'early-text';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(earlySession, 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run(earlySession);
  await commitCanonicalUserMessage({ message: { ...user('先回我一句再操作'), sessionId: earlySession } });
  const earlyRun = await turns.claimIfIdle(earlySession, 'user_reply');
  const earlyDisplay = new presentation.ChatTurnPresentation(earlyRun, ai.agentId, ai.id);
  await earlyDisplay.start();
  const exposed = defer();
  const stopExposure = store.subscribeAgentTransientTimeline(earlySession, () => {
    if (store.snapshotAgentTransientTimelineWithReplacements(earlySession).some(message => message.text === '知道了，')) exposed.resolve();
  });
  const streamingTimeline = new ChatAgentTimeline(earlyRun.runId, earlyDisplay.sink, { bubbleDeliveryMode: 'single-bubble' });
  streamingTimeline.startStep(1);
  streamingTimeline.appendDelta(1, 'assistant', '知道了，');
  await earlyDisplay.flush();
  await exposed.promise;
  stopExposure();
  const firstChunk = store.snapshotAgentTransientTimelineWithReplacements(earlySession)[0];
  assert.equal(firstChunk.status, 'streaming', '单气泡流式正文必须在模型完成前进入展示');
  streamingTimeline.appendDelta(1, 'assistant', '接着处理。');
  await earlyDisplay.flush();
  const secondChunk = store.snapshotAgentTransientTimelineWithReplacements(earlySession)[0];
  assert.equal(secondChunk.text, '知道了，接着处理。');
  assert.equal(secondChunk.clientMessageId, firstChunk.clientMessageId, '后续增量更新同一气泡');
  assert.equal(secondChunk.status, 'streaming');
  streamingTimeline.reconcileModelTurn(1, { assistantText: secondChunk.text, reasoningText: '', toolCalls: [],
    usage: { totalTokens: 120, promptTokens: 100, completionTokens: 20, cachedTokens: 80 } });
  await earlyDisplay.flush();
  earlyDisplay.sink.onDirty(() => [{ runId: earlyRun.runId, sequence: 2, stepIndex: 1, kind: 'tool', status: 'running',
    text: '正在调用：换头像', toolExecutionStarted: true, toolNames: ['change_avatar'], toolDisplayNames: ['换头像'],
    toolExecutions: [{ toolCallId: 'avatar-unknown', name: 'change_avatar', arguments: '{}', status: 'running' }],
    clientMessageId: `agent-timeline:${earlyRun.runId}:2:0`, createdAt: stamp, time: '18:00' }]);
  await earlyDisplay.flush();
  await commitCanonicalUserMessage({ message: { ...user('1'), sessionId: earlySession } });
  await earlyDisplay.finish();
  assert.deepEqual((await displays.listHistory(earlySession))[0].items.map(item => item.snapshot.text), ['知道了，接着处理。', '正在调用：换头像']);
  const unknownTool = store.snapshotAgentTransientTimelineWithReplacements(earlySession).find(message => message.senderType === 'system');
  assert.equal(JSON.parse(unknownTool.metadataJson).status, 'running', '中断不能把未知结果改成成功或失败');
  assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(earlyRun.runId).status, 'superseded');
  assert.equal((await messages.getMessages(earlySession, { limit: 100 })).messages.some(message => !message.isMe), false, '独立前言不能伪装成 T3 成功回复');
  // 模拟进程突然死亡：未确认尾部保持隐藏；已开始工具的孤儿不自动重放。
  for (const sessionId of ['orphan-tools', 'crash-display']) {
    db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    await commitCanonicalUserMessage({ message: { ...user('崩溃前输入'), sessionId } });
    const run = await turns.claimIfIdle(sessionId, 'user_reply');
    await displays.open(run);
    if (sessionId === 'orphan-tools') {
      await displays.checkpoint(run.runId, [{ version: 1, snapshot: { runId: run.runId, sequence: 1, stepIndex: 1,
        kind: 'tool', status: 'running', text: '正在调用：修改数据', toolExecutionStarted: true,
        clientMessageId: `agent-timeline:${run.runId}:1:0`, createdAt: stamp, time: '18:00' } }]);
    } else {
      const result = await turns.commitTurn(run, ['已交付', '未交付尾部'].map((text, index) => ({ message: {
        ...user(text), sessionId, isMe: false, senderType: 'assistant', clientMessageId: `agent-timeline:${run.runId}:${index + 1}:0`,
      } })), { assistantId: 'ai', changes: [] });
      await displays.publishMessage(result.messages[0].id);
    }
  }
  for (const sessionId of ['expired-commit', 'timeout-display']) {
    db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    await commitCanonicalUserMessage({ message: { ...user('超时测试输入'), sessionId } });
    const run = await turns.claimIfIdle(sessionId, 'user_reply');
    if (sessionId === 'expired-commit') {
      let discarded = false;
      const expired = createSingleTransactionTurnCommit(run, ai.id);
      await assert.rejects(expired.commitAgentTimeline({ sessionId, response: { text: '迟到回复' }, aiConfig: ai,
        runtimeContext: { executionDeadlineAt: performance.now() - 1 }, items: [{
          message: { ...user('迟到回复'), sessionId, isMe: false, senderType: 'assistant' },
          discardAfterRollback: async () => { discarded = true; },
        }] }), /execution_host_timeout/);
      assert.equal(discarded, true, '截止时间拒绝 T3 时仍必须释放 prepared backing');
      assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get(sessionId).reply_cursor, 0);
      const hostStopped = new AbortController();
      hostStopped.abort('execution_host_destroyed');
      await assert.rejects(turns.commitTurn(run, [{ message: { ...user('宿主停止后的迟到回复'), sessionId, isMe: false, senderType: 'assistant' } }],
        { assistantId: 'ai', changes: [] }, { deadlineAt: performance.now() + 60_000, signal: hostStopped.signal }), /execution_host_stopped/);
      assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get(sessionId).reply_cursor, 0);
      await turns.revoke(run, 'failed', 'execution_host_timeout');
      assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(run.runId).status, 'failed');
    } else {
      const abort = new AbortController();
      const display = new presentation.ChatTurnPresentation(run, ai.agentId, ai.id, { signal: abort.signal });
      // 模拟前台正在查看这个会话。
      foreground.setChatForegroundContext({ appActive: true, chatRouteActive: true, isChatVisible: true, aiId: 'ai', sessionId, groupId: null });
      await display.start();
      const commit = createSingleTransactionTurnCommit(run, ai.id, display);
      await commit.commitAgentTimeline({ sessionId, response: { text: '已显示\n\n未显示' }, aiConfig: ai,
        runtimeContext: { replyRunId: run.runId }, items: ['已显示', '未显示'].map((text, index) => ({ message: {
          ...user(text), sessionId, isMe: false, senderType: 'assistant',
          clientMessageId: `agent-timeline:${run.runId}:${index + 1}:0`,
        } })), callbacks: { onReplySegment() {
          abort.abort('execution_host_timeout');
        } } });
      await display.finish();
      assert.equal((await displays.getExecutionStatus(sessionId)).reason, 'display_interrupted');
      assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(run.runId).status, 'committed');
      assert.equal(db.prepare('SELECT state FROM chat_turn_presentations WHERE run_id = ?').get(run.runId).state, 'interrupted');
    }
  }
  // 真实 Coordinator + SQLite：不合作的旧 Promise 不得阻止 T4，迟到提交仍被 fence 拒绝。
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('host-race', 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('host-race');
  await commitCanonicalUserMessage({ message: { ...user('宿主取消测试'), sessionId: 'host-race' } });
  const events = load('src/features/chat/messages/events/ChatEvents.ts');
  mocks['@features/chat/composition'] = { ...events, conversationTurnRepository: turns,
    interruptChatRunPresentation: presentation.interruptChatRunPresentation,
    isChatReplyRunCancellationError: load('src/features/chat/reply/application/ChatReplyAbort.ts').isChatReplyRunCancellationError };
  mocks['@features/assistants'] = {};
  mocks['@platform/device'] = {};
  const { createConversationTurnCoordinator } = load('src/host/runtime/ConversationTurnCoordinator.ts');
  const prepared = defer();
  const uncooperative = defer();
  let oldRun, oldDisplay;
  const nativeAbort = new AbortController();
  foreground.setChatForegroundContext({ appActive: true, chatRouteActive: true, isChatVisible: true, aiId: 'ai', sessionId: 'host-race', groupId: null });
  const owner = createConversationTurnCoordinator({ turns, resolveAIConfig: async () => ai, async executeTurn(params) {
    oldRun = params.run;
    oldDisplay = new presentation.ChatTurnPresentation(params.run, ai.agentId, ai.id, { signal: params.signal });
    await oldDisplay.start();
    oldDisplay.sink.onDirty(() => [{ runId: oldRun.runId, sequence: 1, stepIndex: 1, kind: 'reasoning',
      status: 'streaming', text: '实际已展示前缀', clientMessageId: `agent-timeline:${oldRun.runId}:1:0`, createdAt: stamp, time: '18:00' }]);
    await oldDisplay.flush();
    prepared.resolve();
    return uncooperative.promise;
  } });
  const stopped = owner.executeTurnFromHost('host-race', { signal: nativeAbort.signal, executionDeadlineAt: performance.now() + 60_000 });
  await prepared.promise;
  nativeAbort.abort('execution_host_timeout');
  await stopped;
  assert.equal(owner.hasActiveHandle('host-race'), false);
  assert.equal(db.prepare('SELECT status FROM conversation_turn_runs WHERE run_id = ?').get(oldRun.runId).status, 'failed');
  assert.deepEqual((await displays.listHistory('host-race'))[0].items.map(item => item.snapshot.text), ['实际已展示前缀']);
  assert.equal((await turns.commitTurn(oldRun, [{ message: { ...user('迟到输出'), sessionId: 'host-race', isMe: false, senderType: 'assistant' } }], { assistantId: 'ai', changes: [] })).outcome, 'fence_failed');
  uncooperative.resolve('fence_failed');
  await oldDisplay.finish();
  assert.equal(activeDisplays.size, 0, '所有完成、中断与失败批次均须释放原生展示资格');
  // SQLite 真正拒绝快照时仍要释放进程内展示资格，不能让失败对象成为永久活 run。
  const cleanupSession = 'cleanup-failure';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(cleanupSession, 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run(cleanupSession);
  await commitCanonicalUserMessage({ message: { ...user('保存失败时释放展示资源'), sessionId: cleanupSession } });
  const cleanupRun = await turns.claimIfIdle(cleanupSession, 'user_reply');
  const cleanupDisplay = new presentation.ChatTurnPresentation(cleanupRun, ai.agentId, ai.id);
  await cleanupDisplay.start();
  cleanupDisplay.sink.onDirty(() => [{ runId: cleanupRun.runId, sequence: 1, stepIndex: 1, kind: 'reasoning',
    status: 'streaming', text: '尚未保存', clientMessageId: 'cleanup-snapshot', createdAt: stamp, time: '18:00' }]);
  db.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON chat_turn_display_items
    BEGIN SELECT RAISE(ABORT, 'checkpoint-rejected'); END;`);
  await assert.rejects(cleanupDisplay.finish(), /checkpoint-rejected/);
  db.exec('DROP TRIGGER reject_checkpoint');
  assert.equal(activeDisplays.size, 0, 'SQLite 失败不能泄漏原生发布资格');
  await turns.revoke(cleanupRun, 'failed', 'checkpoint-rejected');
  // 群工具写入邀请通知后会刷新展示历史；单聊历史读取不能清掉群执行器的实时投影。
  const groupSession = 'group-invite-history-refresh';
  const groupRun = 'group-task-invite';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(groupSession, 'group');
  const groupSink = store.createAgentTransientTimelineSink({ sessionId: groupSession, agentId: ai.agentId });
  const groupTimeline = new ChatAgentTimeline(groupRun, groupSink);
  const releaseGroupHistory = presentation.retainTurnDisplayHistory(groupSession);
  groupTimeline.startStep(0);
  groupTimeline.appendDelta(0, 'reasoning', '准备邀请成员');
  groupTimeline.reconcileModelTurn(0, { assistantText: '', reasoningText: '准备邀请成员',
    toolCalls: [{ id: 'invite-call', name: 'add_group_member', arguments: '{}' }], usage: {}, messageId: 'invite-model' });
  groupTimeline.startToolStatus(0);
  groupTimeline.markToolStarted(0, 'invite-call');
  const readGroupProjection = () => store.snapshotAgentTransientTimelineWithReplacements(groupSession);
  const initialGroupKeys = readGroupProjection().map(store.getAgentTimelineRenderKey);
  const groupRefreshes = [];
  const stopGroupObservation = store.agentTransientTimeline.subscribe(groupSession, () => {
    groupRefreshes.push(readGroupProjection().length);
  });
  const invitationId = Number(db.prepare(`INSERT INTO messages(session_id,text,sender_type,is_me,created_at,metadata_json,turn_run_id)
    VALUES (?, ?, 'system', 0, ?, ?, ?)`).run(groupSession, 'AI 邀请新成员加入了群聊', stamp,
    JSON.stringify({ type: 'groupMembershipChanged' }), groupRun).lastInsertRowid);
  const invitationWindow = [{ id: invitationId, turnRunId: groupRun }];
  await presentation.reloadTurnDisplayHistory(groupSession, invitationWindow);
  assert.deepEqual(readGroupProjection().map(store.getAgentTimelineRenderKey), initialGroupKeys,
    '邀请通知触发历史刷新时，行动步骤不能先被清空');
  groupTimeline.completeToolCall(0, 'invite-call', { status: 'success', modelContent: '已加入群聊' });
  groupTimeline.startStep(1);
  for (let index = 0; index < 4; index++) {
    groupTimeline.appendDelta(1, 'reasoning', '继续确认');
    await presentation.reloadTurnDisplayHistory(groupSession, invitationWindow);
    assert.equal(readGroupProjection().at(-1).text, '继续确认'.repeat(index + 1), '通知重读不能覆盖或清除新到的思考');
  }
  releaseGroupHistory();
  assert.ok(readGroupProjection().length > 0, '卸载历史窗口不拥有群执行投影的清理资格');
  assert.ok(groupRefreshes.every(count => count > 0), '生成期间没有行动卡消失后再由下一批输出补回的空窗');
  stopGroupObservation();
  groupTimeline.clear('cancelled');
  assert.deepEqual(readGroupProjection(), [], '群执行器仍可在自己的终态清理投影');

  // 缩小历史窗口仍应回收旧历史，但不能顺带清掉同会话的其他实时执行片段。
  let retainedHistory = (await displays.listHistory('s')).slice(0, 1);
  const archivedRunId = retainedHistory[0].runId;
  const otherTimeline = new ChatAgentTimeline('independent-execution', store.createAgentTransientTimelineSink({ sessionId: 's' }));
  otherTimeline.startStep(0);
  otherTimeline.appendDelta(0, 'reasoning', '另一条仍在执行的片段');
  const releaseOwnershipWindow = presentation.retainTurnDisplayHistory('s');
  presentation.configureChatTurnPresentation({ listHistory: async () => retainedHistory });
  await presentation.reloadTurnDisplayHistory('s', [{ id: 1 }]);
  assert.ok(store.snapshotAgentTransientTimelineWithReplacements('s').some(message => message.turnRunId === archivedRunId));
  retainedHistory = [];
  await presentation.reloadTurnDisplayHistory('s', [{ id: Number.MAX_SAFE_INTEGER }]);
  const afterWindowChange = store.snapshotAgentTransientTimelineWithReplacements('s');
  assert.equal(afterWindowChange.some(message => message.turnRunId === archivedRunId), false, '离开窗口的历史投影被正常回收');
  assert.ok(afterWindowChange.some(message => message.text === '另一条仍在执行的片段'), '历史窗口不清理其他执行来源');
  releaseOwnershipWindow();
  otherTimeline.clear('cancelled');
  presentation.configureChatTurnPresentation(displays);

  // 页面窗口按挂载引用计数释放，卸载前的异步读取不能污染重进后的列表。
  const historyRequests = [];
  presentation.configureChatTurnPresentation({ listHistory(sessionId, window) {
    const gate = defer(); historyRequests.push({ sessionId, window, gate }); return gate.promise;
  } });
  const firstOwner = presentation.retainTurnDisplayHistory('window-lifetime');
  const secondOwner = presentation.retainTurnDisplayHistory('window-lifetime');
  const oldRead = presentation.reloadTurnDisplayHistory('window-lifetime', [{ id: 301, turnRunId: 'old-window' }]);
  await Promise.resolve();
  firstOwner();
  const sharedRead = presentation.reloadTurnDisplayHistory('window-lifetime');
  assert.equal(historyRequests.length, 1, '共享分页窗口的在途读取不重复查库');
  assert.equal(historyRequests[0].window.fromMessageId, 301, '另一个挂载列表仍拥有分页窗口');
  secondOwner();
  const newOwner = presentation.retainTurnDisplayHistory('window-lifetime');
  const newRead = presentation.reloadTurnDisplayHistory('window-lifetime');
  await Promise.resolve();
  assert.equal(historyRequests[1].window.fromMessageId, Number.MAX_SAFE_INTEGER, '重进会话不能继承已卸载的窗口');
  historyRequests[1].gate.resolve([]);
  await newRead;
  const staleHistory = [{ runId: 'old-window', kind: 'user_reply', state: 'interrupted', items: [{ version: 1, snapshot: {
    runId: 'old-window', sequence: 1, kind: 'reasoning', status: 'sent', text: '迟到的页面结果',
    clientMessageId: 'old-window:1', createdAt: stamp, time: '18:00' } }] }];
  historyRequests[0].gate.resolve(staleHistory);
  await Promise.all([oldRead, sharedRead]);
  assert.deepEqual(store.snapshotAgentTransientTimelineWithReplacements('window-lifetime'), []);
  newOwner();
  // 没有页面的历史恢复也只临时保留读取状态。
  const backgroundRead = presentation.reloadTurnDisplayHistory('window-lifetime', [{ id: 999 }]);
  await Promise.resolve();
  historyRequests[2].gate.resolve([]); await backgroundRead;
  const afterBackgroundRead = presentation.reloadTurnDisplayHistory('window-lifetime');
  await Promise.resolve();
  assert.equal(historyRequests[3].window.fromMessageId, Number.MAX_SAFE_INTEGER);
  historyRequests[3].gate.resolve([]); await afterBackgroundRead;
  presentation.configureChatTurnPresentation(displays);
  // 刷新已加载多页不能裁成最新 20 条；数据库在同一快照内识别真实身份并排除乐观 ID。
  const windowSession = 'reload-window';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(windowSession, 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run(windowSession);
  const insertWindowMessage = db.prepare(`INSERT INTO messages(session_id, text, is_me, sender_type, created_at)
    VALUES (?, ?, 1, 'user', ?)`);
  const windowIds = Array.from({ length: 65 }, (_, index) =>
    Number(insertWindowMessage.run(windowSession, `窗口消息 ${index}`, stamp).lastInsertRowid));
  const loadedIds = windowIds.slice(-50);
  const appendedId = Number(insertWindowMessage.run(windowSession, '新消息', stamp).lastInsertRowid);
  const readWindow = () => messages.getReloadWindowMessages(windowSession, [...loadedIds, Date.now()]);
  assert.deepEqual((await readWindow()).map(message => message.id), [...loadedIds, appendedId]);
  db.prepare('DELETE FROM messages WHERE id = ?').run(loadedIds[0]);
  db.prepare('DELETE FROM messages WHERE id = ?').run(loadedIds[10]);
  assert.deepEqual((await readWindow()).map(message => message.id),
    [...loadedIds.filter(id => id !== loadedIds[0] && id !== loadedIds[10]), appendedId],
    '重读移除真正删除的消息，同时保留其余已加载历史');
  const initialWindow = await messages.getMessages(windowSession, { cursor: null, limit: 20 });
  assert.deepEqual((await messages.getReloadWindowMessages(windowSession, [Date.now()])).map(message => message.id),
    initialWindow.messages.map(message => message.id), '只有乐观消息时读取真实首屏，不清空发送中的列表');
  db.prepare('UPDATE sessions SET visible_after_message_id = ? WHERE id = ?').run(appendedId, windowSession);
  assert.deepEqual(await readWindow(), [], '清空会话仍按持久可见边界清除窗口');

  // 自主唤醒复用真实 Runtime、Projector、SQLite 与交付事件；关闭工具仍能发正文或静默。
  const { configureChatReplyRuntime } = load('src/features/chat/reply/application/ChatReplyRuntimeDependencies.ts');
  const { runChatVisibleAgent } = load('src/features/chat/reply/application/RunChatVisibleAgent.ts');
  const { AUTONOMOUS_SILENT_REPLY } = load('src/features/chat/reply/application/AutonomousReplyContract.ts');
  const autonomousDeliveries = deliveryEvents;
  // Headless 日程不等待页面恢复；保护当前 owner 的展示，同时收口旧进程遗留的交付。
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('schedule-orphan-display', 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('schedule-orphan-display');
  await commitCanonicalUserMessage({ message: { ...user('交付恢复'), sessionId: 'schedule-orphan-display' } });
  const displayOwner = await turns.claimIfIdle('schedule-orphan-display', 'user_reply');
  await displays.open(displayOwner);
  await turns.commitTurn(displayOwner, [{ message: { sessionId: 'schedule-orphan-display', text: '已完成生成',
    clientMessageId: 'orphan-display-reply', isMe: false, senderType: 'assistant', createdAt: stamp, time: '18:00' } }],
  { assistantId: ai.id, changes: [] });
  await presentation.recoverTurnPresentationDisplays([displayOwner.runId]);
  assert.equal(await turns.claimAutonomousIfIdle('schedule-orphan-display', 'blocked-by-delivery'), null);
  await presentation.recoverTurnPresentationDisplays();
  const recoveredSchedule = await turns.claimAutonomousIfIdle('schedule-orphan-display', 'after-orphan-delivery');
  assert.ok(recoveredSchedule, '旧进程遗留的展示记录不能永久阻挡 Headless 日程');
  await turns.finishAutonomous(recoveredSchedule);
  configureChatReplyRuntime({ mutations: { isRunCurrent: (tx, runId) => turns.isRunCurrentInTransaction(tx, runId) },
    agent: { run: request => new AgentRuntime({
    registry: new AgentToolRegistry(), modelGateway: request.modelGateway,
  }).run(request) } });
  for (const transport of ['complete', 'stream']) for (const silent of [false, true]) {
    const sessionId = `autonomous-${transport}-${silent}`;
    db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    const autonomousOwner = await turns.claimAutonomousIfIdle(sessionId, sessionId);
    assert.ok(autonomousOwner, '自主执行必须先取得与普通聊天共享的持久 owner');
    const turn = { assistantText: silent ? AUTONOMOUS_SILENT_REPLY : '今天过得怎么样？\n\n想你了。',
      reasoningText: '根据最近的对话决定是否联系', toolCalls: [], historyItems: [], finishReason: 'stop',
      messageId: sessionId, usage: { totalTokens: 10, promptTokens: 6, completionTokens: 4 } };
    let requests = 0;
    let streamedIdentity;
    const result = await runChatVisibleAgent({
      sessionId, runId: sessionId, aiConfig: ai, runtimeContext: { triggerSource: 'raven_cat_ai_schedule' },
      finalAssistantPolicy: 'autonomous_reply',
      prepare: async () => ({
        request: { task: { id: sessionId, type: 'raven_cat_autonomous', source: 'raven_cat_ai_schedule',
          goal: '自主行动', assistantId: ai.id, sessionId, allowedToolNames: [], modelTransport: transport,
          maxSteps: 10, maxToolCalls: 30, maxToolCallsPerStep: 3, createdAt: stamp }, initialHistory: [] },
        modelGateway: {
          runTurn: async (request, emit) => {
            requests++;
            assert.deepEqual(request.tools, []);
            assert.ok((await summaries.readContext(sessionId, [])).raw.some(item => item.pending),
              '日程仍在执行时，摘要不能越过触发来源提前总结这一轮');
            if (transport === 'stream') {
              await emit({ type: 'reasoning_delta', text: turn.reasoningText });
              await emit({ type: 'assistant_text_delta', text: turn.assistantText.slice(0, 4) });
              if (!silent) await new Promise((resolve, reject) => {
                const stop = store.subscribeAgentTransientTimeline(sessionId, () => check());
                const timer = setTimeout(() => { stop(); reject(new Error('日程正文未在模型结束前进入独立气泡')); }, 2000);
                const check = () => {
                  const bubble = store.snapshotAgentTransientTimelineWithReplacements(sessionId).find(message => message.senderType === 'assistant');
                  if (!bubble) return;
                  assert.equal(bubble.text, turn.assistantText.slice(0, 4));
                  assert.notEqual(JSON.parse(bubble.metadataJson).type, 'agentActivity');
                  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND sender_type = 'assistant'").get(sessionId).count, 0,
                    '实时显示沿共享展示表交付，正式正文仍等待 T3');
                  streamedIdentity = bubble.clientMessageId;
                  clearTimeout(timer); stop(); resolve();
                };
                check();
              });
              await emit({ type: 'assistant_text_delta', text: turn.assistantText.slice(4) });
            }
            assert.equal(autonomousDeliveries.filter(item => item.sessionId === sessionId).length, 0, '模型尚未结束时不能发出正式提交交付事件');
            return turn;
          },
          takeCompletedTurn: () => turn,
        }, createLegacyContext: () => ({}),
      }),
    });
    assert.equal(result.terminalCode, 'COMPLETED');
    await turns.finishAutonomous(autonomousOwner);
    assert.equal(requests, 1, '无需追加工具调用或第二轮生成');
    const saved = (await messages.getMessages(sessionId, { limit: 30 })).messages;
    const bodies = saved.filter(message => message.senderType === 'assistant');
    if (streamedIdentity) assert.equal(bodies[0].clientMessageId, streamedIdentity, 'T3 不能把正文搬成另一条气泡');
    const evidence = (await messages.listAgentActivityEvidence([sessionId]))[0];
    assert.equal(evidence.terminalCode, 'COMPLETED');
    assert.ok(evidence.respondedAt);
    assert.ok(saved.every(message => !['responded', 'terminal'].includes(JSON.parse(message.metadataJson).phase)),
      '不另写已响应和结束消息，证据来自共享回合与展示');
    const deliveries = autonomousDeliveries.filter(item => item.sessionId === sessionId);
    assert.deepEqual(bodies.map(message => message.text), silent ? [] : ['今天过得怎么样？', '想你了。']);
    assert.equal(deliveries.length, silent ? 0 : 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND is_read = 0').get(sessionId).count, silent ? 0 : 2);
    assert.equal(db.prepare('SELECT last_message FROM sessions WHERE id = ?').get(sessionId).last_message, silent ? null : '想你了。');
    assert.ok(saved.every(message => !message.text.includes(AUTONOMOUS_SILENT_REPLY)));
    if (silent) assert.ok(saved.some(message => message.text === '本次选择不发送消息'));
    else {
      assert.deepEqual(deliveries.map(item => item.segmentIndex), [0, 1]);
      assert.deepEqual(deliveries.map(item => item.clientMessageId), bodies.map(message => message.clientMessageId),
        '日程通知沿正文稳定身份逐条交付，T3 不另造通知');
      const excludedIds = bodies.map(message => message.id);
      assert.equal((await messages.getLatestArrivedConversationPreview(sessionId, excludedIds)).text, '想你了。',
        '没有用户输入的自主会话仍从持久交付正文读取预览');
      db.exec('SAVEPOINT autonomous_preview_boundary');
      const originClientId = `agent_activity:${sessionId}:started`;
      db.prepare('UPDATE sessions SET visible_after_message_id = (SELECT MAX(id) FROM messages WHERE session_id = ?) WHERE id = ?')
        .run(sessionId, sessionId);
      db.prepare(`INSERT INTO messages(session_id, client_message_id, text, is_me, sender_type, time, created_at)
        VALUES ('s', ?, '其他会话的来源', 0, 'system', '12:00', ?)`)
        .run(originClientId, stamp);
      assert.equal(await messages.getLatestArrivedConversationPreview(sessionId, excludedIds), null,
        '自主消息清空后，其他会话的同名客户端消息不能重新开放旧预览');
      db.exec('ROLLBACK TO autonomous_preview_boundary');
      db.exec('RELEASE autonomous_preview_boundary');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND sender_type = ?').get(sessionId, 'reasoning').count, 1);
    assert.equal((await summaries.readContext(sessionId, [])).raw.some(item => item.pending), false,
      '共享展示完成后，隐藏触发来源不能让摘要永久等待不存在的结束消息');
  }
  // 准备失败、半段模型失败、取消和用户接管复用相同持久展示，不能补发正文。
  for (const mode of ['prepare-failure', 'model-failure', 'cancelled', 'superseded']) {
    const sessionId = `autonomous-${mode}`;
    db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    const owner = await turns.claimAutonomousIfIdle(sessionId, sessionId);
    const controller = new AbortController();
    const partial = '收到的半段';
    const turn = { assistantText: partial, reasoningText: '', toolCalls: [], historyItems: [], finishReason: 'stop',
      messageId: sessionId, usage: { totalTokens: 4, promptTokens: 2, completionTokens: 2 } };
    const running = runChatVisibleAgent({ sessionId, runId: sessionId, aiConfig: ai,
      runtimeContext: { triggerSource: 'raven_cat_ai_schedule' }, finalAssistantPolicy: 'autonomous_reply', signal: controller.signal,
      prepare: async () => {
        if (mode === 'prepare-failure') throw new Error('准备失败');
        return { request: { task: { id: sessionId, type: 'raven_cat_autonomous', source: 'raven_cat_ai_schedule',
          goal: '中断验证', assistantId: ai.id, sessionId, allowedToolNames: [], modelTransport: 'stream',
          maxSteps: 10, maxToolCalls: 30, maxToolCallsPerStep: 3, createdAt: stamp }, initialHistory: [] },
        modelGateway: { runTurn: async (_request, emit) => {
          await emit({ type: 'assistant_text_delta', text: partial });
          await new Promise((resolve, reject) => {
            const stop = store.subscribeAgentTransientTimeline(sessionId, () => {
              if (!store.snapshotAgentTransientTimelineWithReplacements(sessionId).some(message => message.text === partial)) return;
              clearTimeout(timer); stop(); resolve();
            });
            const timer = setTimeout(() => { stop(); reject(new Error('半段正文未交付')); }, 2000);
          });
          if (mode === 'model-failure') throw new Error('模型请求失败');
          if (mode === 'cancelled') controller.abort('CANCELLED_BY_USER');
          if (mode === 'superseded') await commitCanonicalUserMessage({ message: { ...user('用户继续说话'), sessionId } });
          return turn;
        }, takeCompletedTurn: () => turn }, createLegacyContext: () => ({}) };
      },
    });
    if (mode === 'prepare-failure') await assert.rejects(running, /准备失败/);
    else await running;
    await turns.finishAutonomous(owner);
    assert.equal((await messages.getMessages(sessionId, { limit: 30 })).messages.filter(message => message.senderType === 'assistant').length, 0);
    assert.equal(autonomousDeliveries.filter(item => item.sessionId === sessionId).length, 0);
    const history = await displays.listHistory(sessionId);
    assert.equal(history[0].state, 'interrupted');
    assert.deepEqual(history[0].items.map(item => item.snapshot.text), mode === 'prepare-failure' ? [] : [partial]);
    const evidence = (await messages.listAgentActivityEvidence([sessionId]))[0];
    assert.equal(evidence.respondedAt !== null, mode !== 'prepare-failure');
    assert.equal(evidence.terminalCode, mode === 'prepare-failure' ? 'EXECUTION_FAILED'
      : mode === 'model-failure' ? 'MODEL_REQUEST_FAILED' : 'CANCELLED_BY_USER');
    const context = await displays.listInterruptedContext(sessionId, 0);
    assert.deepEqual(context.flatMap(run => run.items.map(item => item.text)), mode === 'prepare-failure' ? [] : [partial],
      '日程失败后，后续模型也应沿共享上下文读取已交付片段');
    assert.equal((await summaries.readContext(sessionId, [])).raw.some(item => item.pending), false);
    if (mode === 'cancelled') {
      const origin = db.prepare("SELECT id FROM messages WHERE client_message_id = ?").get(`agent_activity:${sessionId}:started`);
      db.prepare('UPDATE sessions SET visible_after_message_id = ? WHERE id = ?').run(origin.id, sessionId);
      assert.deepEqual(await displays.listHistory(sessionId), [], '清空聊天后不能重新注入隐藏日程来源之前的展示');
      assert.deepEqual(await displays.listInterruptedContext(sessionId, 0), [], '清空聊天同样关闭旧日程的模型上下文可见范围');
    }
  }
  mocks['@features/chat'].getChatSummaryContext = (sessionId, protectedIds = []) => summaries.readContext(sessionId, protectedIds);
  const continuedScheduleInput = await commitCanonicalUserMessage({ message: { ...user('刚才怎么了'), sessionId: 'autonomous-model-failure' } });
  const scheduleHistory = await promptHistoryBuilder.loadPrivateSummaryContext({ sessionId: 'autonomous-model-failure', aiConfig: ai,
    runtimeContext: { batchedUserMessageIds: [continuedScheduleInput.id] } });
  assert.equal(scheduleHistory.messages.filter(message => message.logicalMessageId === 'interrupted:autonomous-model-failure'
    && message.content.includes('收到的半段') && message.role === 'user').length, 1,
  '用户接着说话时，日程半段输出应按触发来源位置作为历史资料进入模型一次');
  db.prepare('UPDATE sessions SET ai_assistant_id = ? WHERE id = ?').run(ai.id, stoppedSession);
  assert.equal(await messages.getUnreadCountByAI(ai.id), 1, '中断保留已交付完整气泡的未读，活动尾泡不计入');
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('schedule-replaced', 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('schedule-replaced');
  const replaced = await turns.claimAutonomousIfIdle('schedule-replaced', 'replaced-schedule');
  await turns.revoke(replaced, 'cancelled', 'newer_schedule');
  const latestScheduleRun = await turns.claimAutonomousIfIdle('schedule-replaced', 'latest-schedule');
  const staleScheduleCommit = await turns.commitTurn(replaced, [{ message: { ...user('旧日程迟到回复'),
    sessionId: 'schedule-replaced', isMe: false, senderType: 'assistant' } }], { assistantId: 'ai', changes: [] });
  assert.equal(staleScheduleCommit.outcome, 'fence_failed', '新日程接管后旧模型返回也不能提交');
  await turns.finishAutonomous(replaced);
  assert.equal((await turns.getActiveRun('schedule-replaced')).runId, latestScheduleRun.runId, '旧 finally 不能释放最新 owner');
  assert.deepEqual((await turns.listRunStates([replaced.runId])).map(run => run.status), ['cancelled']);
  await turns.finishAutonomous(latestScheduleRun);

  // 表情 continue 的完整回复链：真实 Flow / Runtime / Projector / T3 / 展示发布，
  // 只替换模型、工具和 Prompt 等外部输入，不用孤立投影成功冒充端到端成功。
  let stickerClient;
  mocks['@platform/ai'] = { ...load('src/platform/ai/agent/AgentModelGateway.ts'),
    createAIClient: () => stickerClient, getErrorDisplayInfo: error => ({ message: error.message }) };
  Object.assign(mocks['@platform/agentRuntime'], load('src/platform/agentRuntime/BaseAIClientAgentModelGateway.ts'));
  mocks['@shared/aiTools'] = { ...load('src/shared/aiTools/AgentToolInputSchema.ts'),
    ...load('src/shared/aiTools/HostModelRunPreparation.ts') };
  override('src/features/chat/reply/application/ChatReplyRuntime.ts', {
    buildRuntimeAIToolsConfig: config => config,
    createRuntimeToolContext: () => ({}),
    assemblePromptPackForRuntimeContext: async () => ({ systemPrompt: '', modelMessages: [{ role: 'user', content: '发个表情' }] }),
  });
  const { processAIReply } = load('src/features/chat/reply/application/ProcessAIReply.ts');
  const sticker = { stickerId: 'cat', mediaAssetId: 'cat-asset', name: '开心猫猫', description: '开心',
    tags: ['开心'], emotion: '开心', mimeType: 'image/png', width: 128, height: 128, isAnimated: false };
  db.prepare('INSERT INTO media_assets VALUES (?)').run(sticker.mediaAssetId);
  holdArrival = false;
  for (const kind of ['sticker', 'image']) for (const transport of ['complete', 'stream']) for (const mode of [
    'success', 'model-failure', 'model-aborted-error', 'commit-failure', 'commit-failure-stale',
    'cancelled', 'superseded', 'fence-failed', 'output-failure', 'output-fence-failed', 'deleted-output', 'read-output', 'observer-failure', 'finish',
  ]) {
    const sessionId = `media-${kind}-${transport}-${mode}`;
    const toolName = kind === 'sticker' ? 'select_sticker' : 'send_image';
    db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    const input = await commitCanonicalUserMessage({ message: { ...user('发个表情'), sessionId } });
    const run = await turns.claimIfIdle(sessionId, 'user_reply');
    const controller = new AbortController();
    const display = new presentation.ChatTurnPresentation(run, ai.agentId, ai.id, { signal: controller.signal });
    await display.start();
    const commit = createSingleTransactionTurnCommit(run, ai.id, display);
    commit.timelineSink = display.sink;
    commit.recordToolExecutionStarted = () => display.recordToolStart();
    commit.observeRunEvent = event => display.observeRunEvent(event);
    let selection;
    let calls = 0;
    let terminalCode;
    let earlyMessage;
    let completed = 0;
    const segments = [];
    const failures = [];
    const newInput = () => commitCanonicalUserMessage({ message: { ...user('新的输入'), sessionId } });
    const request = async () => {
      calls++;
      if (calls === 1) return { success: true, text: '', messageId: 'sticker-model', isToolCall: true,
        toolCalls: [{ id: 'select', type: 'function', function: { name: toolName,
          arguments: JSON.stringify({ sticker_id: sticker.stickerId, media_asset_id: sticker.mediaAssetId,
            on_success: mode === 'finish' ? 'finish' : 'continue' }) } }], finishReason: 'tool_calls' };
      await display.flush();
      selection = (await displays.listHistory(sessionId))[0].items.find(item => item.snapshot.kind === 'tool').snapshot;
      assert.match(selection.text, /消息已提交/u);
      assert.equal(selection.status, 'completed');
      earlyMessage = (await messages.getMessages(sessionId, { limit: 100 })).messages.find(message => JSON.parse(message.metadataJson || '{}').kind === kind);
      assert.ok(earlyMessage, '续轮请求开始前，图片／表情已经作为真实可见消息提交');
      const active = db.prepare('SELECT active_run_id, reply_cursor, revision FROM conversation_turn_state WHERE session_id = ?').get(sessionId);
      assert.equal(active.active_run_id, run.runId, '提前发送不能释放执行槽');
      assert.equal(active.reply_cursor, run.replyCursorAtClaim);
      assert.equal(active.revision, run.revisionAtClaim, '部分输出不改变执行 revision');
      assert.equal(commit.turnCommitOutcome(), null, '提交媒体不是整轮完成');
      assert.equal(completed, 0, '媒体交付不能提前发出整轮完成回调');
      if (mode === 'deleted-output') await messages.deleteMessagesWithMediaCandidates([earlyMessage.id]);
      if (mode === 'read-output') await messages.markMessagesAsRead(sessionId);
      if (mode === 'model-failure') return { success: false, text: '', error: '模拟续轮网络失败' };
      if (mode === 'model-aborted-error') return { success: false, text: '', error: 'Upstream request aborted' };
      if (mode === 'cancelled') controller.abort('CANCELLED_BY_USER');
      if (mode === 'superseded') { await newInput(); controller.abort('SUPERSEDED'); }
      return { success: true, text: '', finishReason: 'stop' };
    };
    stickerClient = {
      chatWithTools: () => { assert.equal(transport, 'complete'); return request(); },
      chatStreamWithTools: () => { assert.equal(transport, 'stream'); return request(); },
    };
    const registry = new AgentToolRegistry();
    registry.register({ descriptor: { name: toolName, description: '准备测试媒体', inputSchema: { type: 'object' } },
      execute: async args => ({ status: 'success', data: kind === 'sticker' ? { discriminator: 'ravencat.sticker.send.v1', sticker }
        : { discriminator: 'ravencat.chat.image.send.v1', attachment: { id: 'test-image', type: 'image', source: 'media_library',
          mediaAssetId: sticker.mediaAssetId, fileName: 'cat.png', mimeType: 'image/png', fileSize: 100, parseStatus: 'skipped' } },
        modelContent: '已选择测试表情', metadata: { fulfillsUserVisibleOutput: true, completionIntent: args.on_success } }) });
    configureChatReplyRuntime({
      assistantDirectory: { getBlockState: async () => ({ isBlocked: false }) },
      tools: { resolveRuntimeContext: async () => ({}), resolveAllowedNames: async () => [toolName],
        resolveMcpExposure: async () => ({ allowedToolNames: [], services: [] }), getRuntimeAllowedNames: () => [toolName] },
      runPreparation: { prepare: async () => ({ additionalPromptBlocks: [], dynamicAllowedToolNames: [] }) },
      agent: { run: async request => {
        const result = await new AgentRuntime({ registry, modelGateway: request.modelGateway }).run(request);
        terminalCode = result.terminalCode;
        return result;
      } },
    });
    if (mode.startsWith('commit-failure') || mode === 'output-failure') db.exec(`CREATE TRIGGER reject_sticker_commit BEFORE INSERT ON messages
      WHEN NEW.session_id = '${sessionId}' AND NEW.sender_type = '${mode === 'output-failure' ? 'assistant' : 'system'}'
        AND (${mode === 'output-failure' ? '1' : "json_extract(NEW.metadata_json, '$.type') = 'toolStatus'"})
      BEGIN SELECT RAISE(ABORT, '模拟表情 T3 事务失败'); END;`);
    if (mode === 'fence-failed') {
      const originalCommit = commit.commitAgentTimeline;
      commit.commitAgentTimeline = async params => { await newInput(); return originalCommit(params); };
    }
    if (mode === 'output-fence-failed') {
      const originalCommit = commit.commitAgentOutput;
      commit.commitAgentOutput = async params => { await newInput(); return originalCommit(params); };
    }
    if (mode === 'commit-failure-stale') {
      const originalCommit = commit.commitAgentTimeline;
      commit.commitAgentTimeline = async params => {
        try { return await originalCommit(params); }
        catch (error) { await newInput(); throw error; }
      };
    }
    await processAIReply(sessionId, '发个表情', { ...ai, enableTools: true, enableStreamingReply: transport === 'stream' },
      input.id, messages, { notifyUI() {}, onReplyFailed: payload => failures.push(payload),
        onReplyCommitted: () => completed++, onReplySegment: payload => { segments.push(payload); },
        onAIMessageDelivered: () => { if (mode === 'observer-failure') throw new Error('模拟交付观察者失败'); } },
      { replyRunId: run.runId, abortSignal: controller.signal }, commit);
    if (mode.startsWith('commit-failure') || mode === 'output-failure') db.exec('DROP TRIGGER reject_sticker_commit');
    await display.finish();
    assert.equal(calls, mode === 'finish' || mode.startsWith('output-') ? 1 : 2, 'continue 正常续轮，finish 与输出提交失败不追加模型请求');
    if (!mode.startsWith('output-')) assert.equal(terminalCode, mode.startsWith('model-') ? 'MODEL_REQUEST_FAILED'
      : mode === 'cancelled' ? 'CANCELLED_BY_USER' : mode === 'superseded' ? 'SUPERSEDED' : 'COMPLETED');
    const persisted = (await messages.getMessages(sessionId, { limit: 100 })).messages;
    const errors = persisted.filter(message => JSON.parse(message.metadataJson || '{}').kind === 'error');
    const media = persisted.filter(message => JSON.parse(message.metadataJson || '{}').kind === kind);
    const sent = !mode.startsWith('output-');
    assert.equal(media.length, sent && mode !== 'deleted-output' ? 1 : 0,
      '后续失败与取消保留已发送媒体，用户删除的媒体不得被 T3 复活');
    assert.equal(segments.length, Number(sent), '整轮完成不能重复触发已发送媒体的分段回调');
    assert.equal(deliveryEvents.filter(event => event.sessionId === sessionId).length, Number(sent), '媒体仅交付一次');
    if (earlyMessage && media.length) assert.equal(media[0].id, earlyMessage.id, 'T3 绑定原消息，保持数据库身份');
    if (mode === 'success' || mode === 'finish' || mode === 'read-output' || mode === 'deleted-output' || mode === 'observer-failure') {
      if (kind === 'sticker' && media.length) assert.deepEqual(JSON.parse(media[0].metadataJson).sticker, sticker);
      assert.equal((await displays.listHistory(sessionId))[0].state, 'completed');
      assert.equal(commit.turnCommitOutcome(), 'committed');
      assert.equal(completed, 1, '整轮完成信号仅发出一次');
      if (mode === 'read-output') assert.equal(media[0].isRead, true, '最终绑定不能把已读媒体改成未读');
      assert.doesNotMatch(persisted.find(message => message.senderType === 'system').text, /将在/u, '正式工具记录不保留等待提交文案');
    }
    const failed = mode === 'model-failure' || mode === 'model-aborted-error' || mode === 'commit-failure' || mode === 'output-failure';
    assert.equal(errors.length, Number(failed), '真正失败有持久错误；取消、替代与 fence 失败没有故障气泡');
    assert.equal(failures.length, Number(failed));
    if (mode === 'model-failure' || mode === 'model-aborted-error') {
      assert.match(errors[0].text, mode === 'model-failure' ? /模拟续轮网络失败/u : /Upstream request aborted/u);
      const tool = (await displays.listHistory(sessionId))[0].items.find(item => item.snapshot.kind === 'tool').snapshot;
      assert.match(tool.text, /消息已提交/u);
      assert.doesNotMatch(tool.text, /未发送/u, '后续请求失败不能把已经发出的媒体记成未发送');
      assert.equal(tool.toolExecutions[0].status, 'success', '回复失败不能改写选择工具的真实成功结果');
    }
    if (failed) {
      assert.equal(commit.isCommitEligible(), true, '未提交时保留错误反馈资格');
      assert.equal(db.prepare('SELECT reply_cursor FROM conversation_turn_state WHERE session_id = ?').get(sessionId).reply_cursor, 0,
        '错误反馈不消费输入，也不伪装成成功回复');
    }
    await turns.revoke(run, mode === 'cancelled' ? 'cancelled' : 'failed', mode);
    if (mode.startsWith('model-')) {
      const context = await presentation.getChatInterruptedTurnContext(sessionId, 0);
      assert.match(context[0].content, /committedMessage/u, '下一轮上下文必须知道媒体已经发送，不能隐式重发');
      assert.match(context[0].content, /cat-asset/u);
    }
  }
  // 重写依旧等待原子替换，失败不能把尝试中的图片追加到原回复后。
  const regenerationSession = 'media-sticker-complete-success';
  const sourceMedia = (await messages.getMessages(regenerationSession, { limit: 100 })).messages.find(message => JSON.parse(message.metadataJson || '{}').kind === 'sticker');
  await turns.requestRegeneration(regenerationSession, sourceMedia.id);
  const regeneration = await turns.claimIfIdle(regenerationSession, 'user_reply');
  const deferred = await createSingleTransactionTurnCommit(regeneration, ai.id).commitAgentOutput({
    sessionId: regenerationSession, response: { success: true, text: '' }, repository: messages,
    item: { message: { ...user(''), sessionId: regenerationSession, isMe: false, senderType: 'assistant',
      clientMessageId: `agent-timeline:${regeneration.runId}:2:0`, metadataJson: sourceMedia.metadataJson } },
  });
  assert.equal(deferred.outcome, 'deferred');
  await turns.revoke(regeneration, 'failed', 'model_failure');
  assert.equal((await messages.getMessages(regenerationSession, { limit: 100 })).messages.some(message => message.id === sourceMedia.id), true,
    '失败的重写保留原媒体，不提前生成新媒体消息');

  const readyStickerTimeline = (runId, sessionId, sink = {}, runtimeContext = {}, assistantText = '') => {
    const timeline = new ChatAgentTimeline(runId, sink);
    timeline.startStep(1);
    timeline.reconcileModelTurn(1, { assistantText, reasoningText: '', usage: {}, messageId: 'ready-media',
      toolCalls: [{ id: 'ready-sticker', name: 'select_sticker', arguments: '{}', index: 0 }] });
    timeline.startToolStatus(1);
    timeline.markToolStarted(1, 'ready-sticker');
    timeline.completeToolCall(1, 'ready-sticker', { status: 'success', modelContent: '已准备',
      data: { discriminator: 'ravencat.sticker.send.v1', sticker } });
    const params = { sessionId, aiConfig: ai, runtimeContext: { ...runtimeContext, replyRunId: runId },
      policy: { bubbleDeliveryMode: 'multi-bubble' }, finalAssistantPolicy: 'commit_as_reply', finalStepIndex: 1 };
    return { timeline, params, item: timeline.buildImmediateOutputItem(1, 'ready-sticker', params) };
  };

  for (const reason of ['closed', 'aborted', 'deadline']) {
    const sessionId = `early-media-${reason}`;
    db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(sessionId, 'direct');
    db.prepare('INSERT INTO sessions(id) VALUES (?)').run(sessionId);
    await commitCanonicalUserMessage({ message: { ...user('停止边界'), sessionId } });
    const run = await turns.claimIfIdle(sessionId, 'user_reply');
    const display = new presentation.ChatTurnPresentation(run, ai.agentId, ai.id);
    await display.start();
    const output = readyStickerTimeline(run.runId, sessionId);
    const cancellation = new AbortController();
    if (reason === 'closed') await display.stopFromHost('execution_host_stopped');
    if (reason === 'aborted') cancellation.abort();
    const committing = turns.commitOutput(run, output.item, {
      signal: cancellation.signal, deadlineAt: reason === 'deadline' ? performance.now() - 1 : undefined,
    });
    if (reason === 'closed') assert.equal((await committing).outcome, 'fence_failed');
    else await assert.rejects(committing, /execution_host_(?:stopped|timeout)/u);
    assert.equal((await messages.getMessages(sessionId, { limit: 100 })).messages.length, 1,
      '停止、取消与过期必须在输出事务内拒绝消息和媒体引用');
    await turns.revoke(run, 'failed', reason);
    await display.finish();
  }

  // 两张媒体与多泡前言共用源顺序；未到达的非流式前言不能扣留已准备好的图片。
  const orderSession = 'early-media-order';
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(orderSession, 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run(orderSession);
  await commitCanonicalUserMessage({ message: { ...user('发两张图'), sessionId: orderSession } });
  const orderRun = await turns.claimIfIdle(orderSession, 'user_reply');
  const orderDisplay = new presentation.ChatTurnPresentation(orderRun, ai.agentId, ai.id);
  await orderDisplay.start();
  const orderCommit = createSingleTransactionTurnCommit(orderRun, ai.id, orderDisplay);
  const orderTimeline = new ChatAgentTimeline(orderRun.runId, orderDisplay.sink, { bubbleDeliveryMode: 'multi-bubble' });
  const orderParams = { sessionId: orderSession, aiConfig: ai, runtimeContext: { replyRunId: orderRun.runId },
    policy: { bubbleDeliveryMode: 'multi-bubble' }, finalAssistantPolicy: 'commit_as_reply', finalStepIndex: 2 };
  orderTimeline.startStep(1);
  orderTimeline.reconcileModelTurn(1, { assistantText: '我找到了。\n\n看这张。', reasoningText: '挑图片', messageId: 'order-model', usage: {},
    toolCalls: [{ id: 'order-sticker', name: 'select_sticker', arguments: '{}', index: 0 },
      { id: 'order-image', name: 'send_image', arguments: '{}', index: 1 }] });
  orderTimeline.startToolStatus(1);
  holdArrival = true;
  const orderedMediaIds = [];
  for (const [callId, data] of [['order-sticker', { discriminator: 'ravencat.sticker.send.v1', sticker }],
    ['order-image', { discriminator: 'ravencat.chat.image.send.v1', attachment: { id: 'ordered-image', type: 'image',
      source: 'media_library', mediaAssetId: sticker.mediaAssetId, fileName: 'cat.png', mimeType: 'image/png', fileSize: 100, parseStatus: 'skipped' } }]]) {
    orderTimeline.markToolStarted(1, callId);
    await orderDisplay.recordToolStart();
    orderTimeline.completeToolCall(1, callId, { status: 'success', data, modelContent: '已准备' });
    const result = await orderCommit.commitAgentOutput({ ...orderParams, response: { success: true, text: '' }, repository: messages,
      item: orderTimeline.buildImmediateOutputItem(1, callId, orderParams) });
    orderTimeline.recordCommittedOutput(1, callId, result.messages);
    orderedMediaIds.push(result.messages[0].id);
  }
  const beforeFinal = (await messages.getMessages(orderSession, { limit: 100 })).messages;
  assert.deepEqual(beforeFinal.filter(message => message.senderType === 'assistant').map(message => message.id), orderedMediaIds,
    '前言仍等待到达时，媒体已经真实可见');
  await messages.markMessagesAsRead(orderSession);
  orderTimeline.startStep(2);
  orderTimeline.reconcileModelTurn(2, { assistantText: '这是两张图。', reasoningText: '', toolCalls: [], messageId: 'order-final', usage: {} });
  holdArrival = false;
  for (const pending of pendingPaces) if (pending.runId === orderRun.runId) pending.gate.resolve(true);
  const orderedResult = await orderCommit.commitAgentTimeline({ ...orderParams, response: { success: true, text: '这是两张图。' },
    repository: messages, items: orderTimeline.buildCommitItems(orderParams) });
  await orderDisplay.finish();
  const orderedMessages = (await messages.getMessages(orderSession, { limit: 100 })).messages.filter(message => !message.isMe);
  assert.deepEqual(orderedMessages.filter(message => message.senderType === 'assistant').map(message => message.text),
    ['我找到了。', '看这张。', '', '', '这是两张图。'], '最终顺序保持前言 → 两张媒体 → 后续正文');
  assert.equal(new Set(orderedResult.messages.map(message => message.id)).size, orderedResult.messages.length);
  assert.ok(orderedMediaIds.every(id => orderedResult.messages.some(message => message.id === id && message.isRead)));
  assert.equal(deliveryEvents.filter(event => event.sessionId === orderSession && orderedMediaIds.includes(event.committedMessageId)).length, 2,
    '多媒体各自交付一次，T3 不重发');

  // 日程仍由原自主 owner 持有执行槽，提前输出不消费用户游标。
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('early-media-auto', 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('early-media-auto');
  const autoRun = await turns.claimAutonomousIfIdle('early-media-auto', 'early-media-auto');
  const autoOutput = readyStickerTimeline(autoRun.runId, autoRun.sessionId);
  const autoCommit = createSingleTransactionTurnCommit(autoRun, ai.id);
  const autoResult = await autoCommit.commitAgentOutput({ ...autoOutput.params, item: autoOutput.item,
    response: { success: true, text: '' }, repository: messages });
  assert.equal(autoResult.outcome, 'committed');
  assert.equal((await turns.getActiveRun(autoRun.sessionId)).runId, autoRun.runId);
  assert.equal(autoCommit.turnCommitOutcome(), null);
  await turns.finishAutonomous(autoRun);

  // 群聊使用真实 Repository 的 plan/task fence，提前输出仍属于正在执行的发言。
  mocks['@features/assistants'] = {};
  mocks['@features/profile'] = {};
  for (const key of ['groupSpeechPlans', 'groupSpeechTasks']) db.exec(SCHEMAS[key]);
  const { groupChatRepository: groups } = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts');
  load('src/features/chat/group/application/ChatGroupRuntime.ts').configureChatGroupRuntime({ groups });
  const { createGroupSegmentedReplyPersistence } = load('src/features/chat/group/application/GroupAssistantTurnCommit.ts');
  for (const mode of ['success', 'failed', 'superseded', 'deleted']) {
    const groupId = `early-media-group-${mode}`;
    const planId = `plan-${mode}`;
    const taskId = `task-${mode}`;
    db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run(groupId, 'group');
    db.prepare('INSERT INTO group_chats(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(groupId, groupId, stamp, stamp);
    db.prepare('INSERT INTO group_speech_plans(id,group_id,status,created_at,updated_at) VALUES (?,?,\'running\',?,?)').run(planId, groupId, stamp, stamp);
    db.prepare(`INSERT INTO group_speech_tasks(id,plan_id,group_id,ai_assistant_id,agent_id,sequence_order,source,status,created_at,updated_at)
      VALUES (?,?,?,?,?,0,'admin','running',?,?)`).run(taskId, planId, groupId, ai.id, ai.agentId, stamp, stamp);
    const output = readyStickerTimeline(taskId, groupId, {}, { groupChat: { groupId } }, '先发这张。');
    let completeSignals = 0;
    const commit = createGroupSegmentedReplyPersistence({ task: { id: taskId, planId, groupId, aiAssistantId: ai.id, sequenceOrder: 0 },
      directory: { groupId, currentUser: { displayName: '用户', targetType: 'user', userProfileId: 'self' }, assistants: [] } });
    const commitParams = { ...output.params, response: { success: true, text: '' }, repository: messages,
      callbacks: { onReplyCommitted: () => completeSignals++ } };
    const sent = await commit.commitAgentOutput({ ...commitParams, item: output.item });
    output.timeline.recordCommittedOutput(1, 'ready-sticker', sent.messages);
    assert.equal(completeSignals, 0);
    assert.equal(commit.getReplyOutput().visibleReplyCommitted, true);
    assert.equal(db.prepare('SELECT status FROM group_speech_tasks WHERE id = ?').get(taskId).status, 'running');
    if (mode === 'deleted') await messages.deleteMessagesWithMediaCandidates([sent.messages[0].id]);
    if (mode === 'superseded') {
      await groups.terminateActiveSpeechPlan(groupId);
      await assert.rejects(commit.commitAgentOutput({ ...commitParams, item: output.item }), error => error.name === 'ChatReplyRunCancelledError');
    } else if (mode !== 'failed') {
      await commit.commitAgentTimeline({ ...commitParams, items: output.timeline.buildCommitItems(output.params) });
      assert.equal(completeSignals, 1);
    }
    const visible = (await messages.getMessages(groupId, { limit: 100 })).messages.filter(message => JSON.parse(message.metadataJson || '{}').kind === 'sticker');
    assert.equal(visible.length, mode === 'deleted' ? 0 : 1, '群聊失败、换代保留已发媒体，末尾不重复插入或复活删除');
    if (visible.length) assert.equal(visible[0].id, sent.messages[0].id);
    if (mode === 'success') assert.equal(db.prepare('SELECT last_message_id FROM group_chats WHERE id = ?').get(groupId).last_message_id,
      sent.messages[0].id, '最终补写的前言不能把群预览从媒体倒退为前言');
  }

  // 模拟消息已提交、工具完成投影还未来得及确认时进程死亡。
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('early-media-crash', 'direct');
  db.prepare('INSERT INTO sessions(id) VALUES (?)').run('early-media-crash');
  await commitCanonicalUserMessage({ message: { ...user('发图后进程退出'), sessionId: 'early-media-crash' } });
  const crashRun = await turns.claimIfIdle('early-media-crash', 'user_reply');
  const crashDisplay = new presentation.ChatTurnPresentation(crashRun, ai.agentId, ai.id);
  await crashDisplay.start();
  const crashOutput = readyStickerTimeline(crashRun.runId, crashRun.sessionId, crashDisplay.sink);
  await crashDisplay.recordToolStart();
  await createSingleTransactionTurnCommit(crashRun, ai.id, crashDisplay).commitAgentOutput({
    ...crashOutput.params, item: crashOutput.item, response: { success: true, text: '' }, repository: messages,
  });
  await writer;
  db.close();
  const child = spawnSync(process.execPath, ['--no-warnings', import.meta.filename, '--read', filename], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.equal(restored.mediaOrphan, null, '已开始工具的孤儿不自动重放发送');
  assert.equal(restored.mediaCrashMessages.filter(message => JSON.parse(message.metadataJson || '{}').kind === 'sticker').length, 1,
    '工具完成投影丢失时，独立进程仍读到已经提交的图片');
  assert.match(restored.mediaCrashContext[0].content, /committedMessage/u);
  assert.match(restored.mediaCrashContext[0].content, /cat-asset/u);
  assert.equal(restored.unreadBeforeRead, 1, '独立进程恢复后未读仍来自持久交付事实');
  assert.equal(restored.unreadAfterRead, 0, '恢复后打开会话可清除尚无正式消息 ID 的未读');
  assert.deepEqual(restored.autonomousFailureHistory[0].items.map(item => item.snapshot.text), ['收到的半段'],
    '没有用户输入的日程失败后，独立进程仍能读回已交付正文');
  assert.equal(restored.autonomousFailureEvidence[0].terminalCode, 'MODEL_REQUEST_FAILED');
  assert.deepEqual(restored.history[0].items.map(item => item.snapshot.text), publishedPrefix);
  assert.deepEqual(restored.streamedVisible.filter(message => message.senderType === 'assistant').map(message => message.text), streamingExpected,
    '独立进程恢复不重新分泡或重复正文');
  assert.deepEqual(restored.streamedInterrupted[0].items.map(item => item.snapshot.text), ['已闭合', '活动尾泡'],
    '流式分泡中断后重开仍只保留已交付前缀');
  assert.deepEqual(restored.visible.filter(message => !message.isMe).map(message => message.text), ['A', 'B', '']);
  assert.deepEqual(restored.crashVisible.filter(message => !message.isMe).map(message => message.text), ['已交付']);
  assert.equal(restored.orphan, null);
  assert.equal(restored.orphanStatus.status, 'failed');
  assert.equal(restored.orphanStatus.terminal_reason, 'orphan_after_tool_start');
  assert.deepEqual(restored.timeoutVisible.filter(message => !message.isMe).map(message => message.text), ['已显示']);
  assert.deepEqual(restored.earlyHistory[0].items.map(item => item.snapshot.text), ['知道了，接着处理。', '正在调用：换头像']);
  assert.equal(restored.earlyHistory[0].items[0].snapshot.tokensUsed, 120, '中断后独立进程仍保留已交付统计');
  assert.equal(restored.earlyHistory[0].items[0].snapshot.cachedTokens, 80);
  assert.deepEqual(restored.completeVisible.filter(message => message.senderType === 'assistant').map(usageOf),
    [...firstExposure.values()].map(item => item.usage), '正常完成后重启保持相同统计');
  assert.equal(restored.completeVisible.filter(message => message.senderType === 'reasoning').length, 3);
  assert.equal(restored.completeVisible.filter(message => message.senderType === 'system').length, 2);
  console.log('真实 Agent 多轮工具、媒体即时交付与去重、删除与已读、群聊 fence、重写隔离、消息顺序及独立进程恢复通过。');
} finally {
  try { db.close(); } catch {}
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true });
}
