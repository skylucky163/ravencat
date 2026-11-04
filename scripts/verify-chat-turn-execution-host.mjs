/**
 * 普通聊天 AI 回复与共享应用 execution host 契约验证。
 *
 * 以 data: URL 动态编译 ConversationTurnCoordinator.ts 与 AIMessageDeliveryCoordinator.ts，
 * 桩掉跨 Feature / platform / shared / react-native 值导入，用内存 fake 验证：
 *
 * 行为断言：
 * 1. onCommitted 显式 executionMode=delegate_to_android_host（普通页面，即使有 notifyUI）：
 *    executionHost.start 被以 ([sessionId], { correlationId, deliveryTiming }) 调用，
 *    turns.claimIfIdle 未被调用；
 * 2. onCommitted 显式 executionMode=inline_current_host（调用方本身是 execution host，
 *    如悬浮任务）：turns.claimIfIdle 被调用，executionHost.start 未被调用；
 * 3. executeTurnFromHost 必须等待 run 到达 terminal：executeTurn gate 放行前 Promise 不 settle，
 *    放行后 resolve 'executed'；
 * 4. 无双 claim：已有活句柄时 executeTurnFromHost 返回 'already_active'，claimIfIdle 只被调一次；
 * 5. 重投不重复执行：claimIfIdle 落空且 highWatermark<=replyCursor → 'skipped'，takeOverOrphan 不调；
 * 6. 孤儿接管：claimIfIdle 落空、highWatermark>replyCursor、无终态覆盖 → takeOverOrphan 并 'executed'；
 * 7. 终态覆盖防隐式 retry：findTerminalRunCovering 命中 → 'skipped'，takeOverOrphan 不调；
 * 8. recovery 委派：recoverConversationTurns 只收集待恢复会话并一次性 executionHost.start，
 *    页面 runtime 不 claim / 不 takeOverOrphan / 不执行 run / 不注册 activeHandle；
 * 9. 交付策略（AIMessageDeliveryCoordinator）：
 *    - 前台会话（AppState active + isChatConversationForeground）→ 不发系统通知；
 *    - 后台 → sendAIMessageNotification 被调且 eventId = logicalMessageId:segmentIndex；
 *    - userNotificationHandled=true → 不发系统通知。
 *
 * 后台入口行为：无 restore action 仍等待普通 bootstrap；失败不开放 claim；
 * 批量会话等待上一会话终态后再执行下一会话，后台交付使用 immediate。
 * Android 服务注册、通知系统与执行保障需要原生测试/实机验收，不通过源码字符串推断。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================================
// 协调器模块编译（与 verify-chat-turn-host-coordinator.mjs 相同的桩策略）
// ============================================================================
const chatReplyAbortModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/application/ChatReplyAbort.ts'),
);

const chatEventsModuleUrl = transpileToModuleUrl(read('src/features/chat/messages/events/ChatEvents.ts'));
const chatStub = `import { isChatReplyRunCancellationError } from '${chatReplyAbortModuleUrl}';
import { emitChatTurnExecutionChanged, setChatEventBus } from '${chatEventsModuleUrl}';
const conversationTurnRepository = null;
const executeUserReplyTurn = null;
const sessionRepository = null;
const emitChatMessagesReloadRequested = () => {};
const interruptChatRunPresentation = async () => {};
const recoverTurnPresentationDisplays = async () => {};
const emitChatTypingStatusChanged = () => {};
const emitChatRegenerationChanged = () => {};`;

const coordinatorSource = read('src/host/runtime/ConversationTurnCoordinator.ts');
const chatCompositionImportPattern =
  /import\s*\{[^;]*?\}\s*from\s*['"]@features\/chat\/composition['"];/;
const stubbedCoordinatorSource = coordinatorSource
  .replace(/import\s*\{[^}]*\}\s*from\s*'@shared\/theme\/[^']+';/g, '')
  .replace(chatCompositionImportPattern, chatStub)
  .replace(chatCompositionImportPattern, '')
  .replace(
    /import\s*\{\s*aiAssistantRepository\s*\}\s*from\s*['"]@features\/assistants['"];/,
    'const aiAssistantRepository = null;',
  )
  .replace(
    /import\s*\{\s*startConversationTurnExecutionHost\s*\}\s*from\s*['"]@platform\/device['"];/,
    'const startConversationTurnExecutionHost = async () => false;',
  )
  .replace(
    /import\s*\{\s*logTurnTimeline\s*\}\s*from\s*['"]@shared\/diagnostics\/TurnTimelineLog['"];/,
    'const logTurnTimeline = () => {};',
  );
assert.ok(
  !stubbedCoordinatorSource.includes("'@features/chat'")
    && !stubbedCoordinatorSource.includes("'@features/chat/composition'")
    && !stubbedCoordinatorSource.includes("'@features/assistants'")
    && !stubbedCoordinatorSource.includes("'@platform/device'")
    && !stubbedCoordinatorSource.includes("'@shared/diagnostics/TurnTimelineLog'"),
  '协调器测试桩必须移除跨 Feature / platform / shared 值导入',
);
const coordinatorModuleUrl = transpileToModuleUrl(stubbedCoordinatorSource);
const { createConversationTurnCoordinator } = await import(coordinatorModuleUrl);

const aiConfig = { id: 'ai1', agentId: 'agent1', name: 'AI' };

/**
 * 内存 fake：回合仓储（claim 结果可编排）+ 可控 executeTurn + execution host 触发口。
 * options.claimResult：'run'（默认）或 null，模拟 claimIfIdle 是否落空。
 */
function createFakes(options = {}) {
  let runSeq = 0;
  const calls = {
    claimIfIdle: [],
    takeOverOrphan: [],
    revoke: [],
    executionHostStart: [],
  };
  const executions = new Map(); // runId -> { signal, gate, params }
  const makeRun = (sessionId, kind) => ({
    runId: `run-${++runSeq}`,
    sessionId,
    kind,
    replyCursorAtClaim: 0,
    inputHighWatermark: 10,
    revisionAtClaim: 1,
    status: 'active',
    terminalReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    terminalAt: null,
  });
  const turns = {
    interruptAbandonedAutonomousRuns: async () => [],
    claimIfIdle: async (sessionId, kind) => {
      calls.claimIfIdle.push({ sessionId, kind });
      if (options.claimResult === null) {
        return null;
      }
      return makeRun(sessionId, kind);
    },
    takeOverOrphan: async (sessionId, kind) => {
      calls.takeOverOrphan.push({ sessionId, kind });
      return makeRun(sessionId, kind);
    },
    revoke: async (run, status, reason) => {
      calls.revoke.push({ runId: run.runId, status, reason });
    },
    findTerminalRunCovering: options.findTerminalRunCovering ?? (async () => null),
    getSessionTurnSnapshot: options.getSessionTurnSnapshot ?? (async () => null),
    listSessionsWithUnrepliedInput: async () => [],
  };
  const executeTurn = (params) => {
    const gate = deferred();
    executions.set(params.run.runId, { signal: params.signal, gate, params });
    return gate.promise;
  };
  const executionHost = {
    start: async (sessionIds, startOptions) => {
      calls.executionHostStart.push({ sessionIds, options: startOptions });
      return true;
    },
  };
  return { calls, executions, turns, executeTurn, executionHost };
}

function createCoordinator(fakes) {
  return createConversationTurnCoordinator({
    turns: fakes.turns,
    executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => aiConfig,
    executionHost: fakes.executionHost,
  });
}

// ============================================================================
// 断言 1：普通页面显式委派（即使携带 presentation callback）只启动 execution host，不就地 claim。
// ============================================================================
{
  const fakes = createFakes();
  const coordinator = createCoordinator(fakes);

  await coordinator.onCanonicalUserMessageCommitted({
    sessionId: 's1',
    message: { id: 1 },
    aiConfig,
    executionMode: 'delegate_to_android_host',
    correlationId: 'corr-page-1',
    deliveryTiming: 'paced',
    replyCallbacks: { notifyUI: () => {} },
  });

  assert.equal(fakes.calls.executionHostStart.length, 1, '页面路径必须启动 execution host');
  assert.deepEqual(
    fakes.calls.executionHostStart[0].sessionIds,
    ['s1'],
    '页面路径必须以单元素会话数组启动 execution host',
  );
  assert.deepEqual(
    fakes.calls.executionHostStart[0].options,
    { correlationId: 'corr-page-1', deliveryTiming: 'paced' },
    'executionHost.start 必须携带 correlationId 与 deliveryTiming',
  );
  assert.equal(fakes.calls.claimIfIdle.length, 0, '页面 runtime 不得先 claim');
}

// ============================================================================
// 断言 2：显式 inline_current_host 的受控 execution host 就地 claim（悬浮任务不回归）。
// ============================================================================
{
  const fakes = createFakes();
  const coordinator = createCoordinator(fakes);

  await coordinator.onCanonicalUserMessageCommitted({
    sessionId: 's1',
    message: { id: 2 },
    aiConfig,
    executionMode: 'inline_current_host',
    correlationId: 'corr-floating-1',
    deliveryTiming: 'immediate',
    replyCallbacks: { notifyUI: () => {} },
  });

  assert.equal(fakes.calls.claimIfIdle.length, 1, '显式 inline_current_host 必须就地 claimIfIdle');
  assert.equal(fakes.calls.executionHostStart.length, 0, '显式 inline_current_host 不得再启动 execution host');
  // 清理：放行执行，避免悬挂句柄（各用例 fake 独立，仅为完整性）。
  fakes.executions.get('run-1').gate.resolve('committed');
  await flush();
}

// 断言 2b：callback 不能隐式升级 execution ownership；缺省 mode 仍安全委派。
{
  const fakes = createFakes();
  const coordinator = createCoordinator(fakes);

  await coordinator.onCanonicalUserMessageCommitted({
    sessionId: 's-callback-only',
    message: { id: 3 },
    aiConfig,
    correlationId: 'corr-callback-only',
    deliveryTiming: 'immediate',
    replyCallbacks: { notifyUI: () => {} },
  });

  assert.equal(
    fakes.calls.executionHostStart.length,
    1,
    '仅有 replyCallbacks 时仍必须委派 execution host（不得推断 inline host）',
  );
  assert.equal(
    fakes.calls.claimIfIdle.length,
    0,
    '仅有 replyCallbacks 时页面 runtime 不得 claimIfIdle',
  );
}

// ============================================================================
// 断言 3：executeTurnFromHost 必须等待 run 到达 terminal 才返回
// ============================================================================
{
  const fakes = createFakes();
  const coordinator = createCoordinator(fakes);

  let settled = false;
  let result = null;
  const pending = coordinator
    .executeTurnFromHost('s1', { correlationId: 'corr-host-1' })
    .then((r) => {
      settled = true;
      result = r;
    });

  await flush();
  await flush();
  assert.equal(settled, false, 'run 未到达 terminal 前 executeTurnFromHost 不得 settle');

  const exec = fakes.executions.get('run-1');
  assert.ok(exec, 'claim 成功后必须启动 executeRun');
  exec.gate.resolve('committed');
  await pending;
  assert.equal(settled, true, 'run terminal 后 executeTurnFromHost 必须 settle');
  assert.equal(result, 'executed', '正常执行完成必须返回 executed');
}

// ============================================================================
// 断言 4：无双 claim —— 已有活句柄时 executeTurnFromHost 返回 already_active
// ============================================================================
{
  const fakes = createFakes();
  const coordinator = createCoordinator(fakes);

  const launched = await coordinator.launchTurn('s1', 'send_flow', 'claimIfIdle', { aiConfig });
  assert.equal(launched, true, '首次 launch 必须成功');
  assert.equal(coordinator.hasActiveHandle('s1'), true);

  const result = await coordinator.executeTurnFromHost('s1', { correlationId: 'corr-host-2' });
  assert.equal(result, 'already_active', '本进程已有活句柄时必须返回 already_active');
  assert.equal(fakes.calls.claimIfIdle.length, 1, '重复投递不得再次 claimIfIdle');

  fakes.executions.get('run-1').gate.resolve('committed');
  await flush();
  await flush();
}

// ============================================================================
// 断言 5：重投不重复执行 —— 无待回复输入（highWatermark<=replyCursor）→ skipped
// ============================================================================
{
  const fakes = createFakes({
    claimResult: null,
    getSessionTurnSnapshot: async () => ({ replyCursor: 10, highWatermark: 10 }),
  });
  const coordinator = createCoordinator(fakes);

  const result = await coordinator.executeTurnFromHost('s1', {});
  assert.equal(result, 'skipped', '无待回复输入必须返回 skipped');
  assert.equal(fakes.calls.takeOverOrphan.length, 0, '无待回复输入不得 takeOverOrphan');
}

// ============================================================================
// 断言 6：孤儿接管 —— claimIfIdle 落空且无终态覆盖 → takeOverOrphan 并执行
// ============================================================================
{
  const fakes = createFakes({
    claimResult: null,
    getSessionTurnSnapshot: async () => ({ replyCursor: 5, highWatermark: 10 }),
    findTerminalRunCovering: async () => null,
  });
  const coordinator = createCoordinator(fakes);

  const pending = coordinator.executeTurnFromHost('s1', { correlationId: 'corr-host-3' });
  await flush();
  await flush();
  assert.equal(fakes.calls.takeOverOrphan.length, 1, '崩溃孤儿必须 takeOverOrphan 接管');

  const exec = fakes.executions.get('run-1');
  assert.ok(exec, '孤儿接管后必须启动 executeRun');
  exec.gate.resolve('committed');
  const result = await pending;
  assert.equal(result, 'executed', '孤儿接管执行完成必须返回 executed');
}

// ============================================================================
// 断言 7：终态覆盖防隐式 retry —— findTerminalRunCovering 命中 → skipped
// ============================================================================
{
  const fakes = createFakes({
    claimResult: null,
    getSessionTurnSnapshot: async () => ({ replyCursor: 5, highWatermark: 10 }),
    findTerminalRunCovering: async () => ({ runId: 'old-failed' }),
  });
  const coordinator = createCoordinator(fakes);

  const result = await coordinator.executeTurnFromHost('s1', {});
  assert.equal(result, 'skipped', 'failed/cancelled 终态覆盖的区间必须 skipped，防任务重投隐式 retry');
  assert.equal(fakes.calls.takeOverOrphan.length, 0, '终态覆盖区间不得 takeOverOrphan');
}

// ============================================================================
// 断言 8：recovery 委派 —— 只启动一次 execution host，页面不 claim / 不执行 / 不注册句柄
// ============================================================================
{
  const fakes = createFakes();
  fakes.turns.listSessionsWithUnrepliedInput = async (after, limit) =>
    [
      { sessionId: 's-r1', replyCursor: 5, highWatermark: 10 },
      { sessionId: 's-r2', replyCursor: 5, highWatermark: 10 },
    ]
      .filter((s) => s.sessionId > after)
      .slice(0, limit);
  const coordinator = createCoordinator(fakes);

  await coordinator.recoverConversationTurns();

  assert.equal(fakes.calls.executionHostStart.length, 1, 'recovery 必须一次性委派 execution host');
  assert.deepEqual(
    fakes.calls.executionHostStart[0].sessionIds,
    ['s-r1', 's-r2'],
    'recovery 必须以完整待恢复会话数组启动 execution host',
  );
  assert.equal(fakes.calls.claimIfIdle.length, 0, '页面 recovery 不得 claimIfIdle');
  assert.equal(fakes.calls.takeOverOrphan.length, 0, '页面 recovery 不得 takeOverOrphan');
  assert.equal(fakes.executions.size, 0, '页面 recovery 不得执行 run');
  assert.equal(coordinator.hasActiveHandle('s-r1'), false, 'recovery 委派不得注册 activeHandle');
  assert.equal(coordinator.hasActiveHandle('s-r2'), false, 'recovery 委派不得注册 activeHandle');
}

// ============================================================================
// 断言 9：交付策略 —— AIMessageDeliveryCoordinator 行为验证
// ============================================================================
{
  // 可控桩：AppState / 前台事实 / 通知发送 / 订阅 listener。
  const fakeAppState = { currentState: 'active' };
  const fakeForeground = { direct: () => false, group: () => false };
  const notificationCalls = [];
  const arrivalCalls = [];
  let aiMessageDeliveryHandler = null;

  const deliverySource = read('src/host/runtime/AIMessageDeliveryCoordinator.ts');
  const stubbedDeliverySource = deliverySource
    .replace(
      /import\s*\{\s*AppState\s*\}\s*from\s*['"]react-native['"];/,
      'const AppState = globalThis.__fakeAppState;',
    )
    .replace(
      /import\s*\{[^}]*\}\s*from\s*['"]@features\/assistants['"];/,
      'const getAIAssistantById = async () => null; const getAssistantDisplayName = (assistant) => assistant.nickname ?? assistant.name;',
    )
    .replace(
      /import\s*\{[\s\S]*?\}\s*from\s*['"]@features\/chat['"];/,
      `const conversationKeyOfDirect = (aiId) => 'ai:' + aiId;
const conversationKeyOfGroup = (groupId) => 'group:' + groupId;
const notifyAIMessageObservers = () => {};
`,
    )
    .replace(
      /import\s*\{[\s\S]*?\}\s*from\s*['"]@features\/chat\/composition['"];/,
      `const isChatConversationForeground = (...args) => globalThis.__fakeChatForeground.direct(...args);
const isGroupConversationForeground = (...args) => globalThis.__fakeChatForeground.group(...args);
const configureAssistantMessageArrivalRuntime = () => {};
const applyAssistantMessageArrivalSnapshot = () => {};
const configureAIMessageDeliveryHandler = (handler) => { globalThis.__aiMessageDeliveryHandler = handler; };`,
    )
    .replace(
      /import\s*\{[^}]*\}\s*from\s*['"]@platform\/device['"];/,
      `const sendAIMessageNotification = async (params) => {
  globalThis.__notificationCalls.push(params);
  return globalThis.__notificationsEnabled;
};
const addMessageArrivalListener = () => ({ remove() {} });
const getMessageArrivalSnapshot = async () => ({ revision: 0, pendingMessageIds: [], pendingSessionIds: [] });
const beginMessageArrival = async () => ({});
const finishMessageArrival = async () => ({});
const awaitMessageArrival = async (...args) => { globalThis.__arrivalCalls.push(args); return {}; };`,
    )
    .replace(
      /import\s*\{\s*logTurnTimeline\s*\}\s*from\s*['"]@shared\/diagnostics\/TurnTimelineLog['"];/,
      'const logTurnTimeline = () => {};',
    );
  assert.ok(
    !stubbedDeliverySource.includes("'react-native'")
      && !stubbedDeliverySource.includes("'@features/chat'")
      && !stubbedDeliverySource.includes("'@features/chat/composition'")
      && !stubbedDeliverySource.includes("'@platform/device'")
      && !stubbedDeliverySource.includes("'@shared/diagnostics/TurnTimelineLog'"),
    '交付协调器测试桩必须移除 react-native / 跨 Feature / platform / shared 值导入',
  );

  globalThis.__fakeAppState = fakeAppState;
  globalThis.__fakeChatForeground = fakeForeground;
  globalThis.__notificationCalls = notificationCalls;
  globalThis.__arrivalCalls = arrivalCalls;
  globalThis.__notificationsEnabled = true;
  Object.defineProperty(globalThis, '__aiMessageDeliveryHandler', {
    get: () => aiMessageDeliveryHandler,
    set: (handler) => {
      aiMessageDeliveryHandler = handler;
    },
    configurable: true,
  });

  const deliveryModuleUrl = transpileToModuleUrl(stubbedDeliverySource);
  const { configureAIMessageDeliveryCoordinator } = await import(deliveryModuleUrl);
  configureAIMessageDeliveryCoordinator();
  assert.ok(aiMessageDeliveryHandler, 'configure 后必须注册唯一交付处理器');

  const basePayload = {
    aiId: 'ai1',
    aiName: 'AI',
    message: '你好',
    sessionId: 's1',
    conversationKind: 'direct',
    logicalMessageId: 'lm-1',
    segmentIndex: 2,
    committedMessageId: 100,
  };

  // 前台会话：抑制系统通知。
  fakeAppState.currentState = 'active';
  fakeForeground.direct = () => true;
  assert.deepEqual(
    await aiMessageDeliveryHandler({ ...basePayload }),
    { status: 'suppressed_foreground', errorCategory: null },
  );
  assert.equal(notificationCalls.length, 0, '前台会话不得发送系统通知');

  const groupPayload = {
    ...basePayload,
    aiId: 'ai-group-member',
    aiName: '群成员',
    sessionId: 'group-current',
    conversationKind: 'group',
    groupId: 'group-current',
    groupName: '当前群聊',
    logicalMessageId: 'lm-group',
  };

  // 用户正在当前群聊：群回复抑制；同时到达的私聊回复仍应通知。
  fakeForeground.direct = () => false;
  fakeForeground.group = (groupId) => groupId === 'group-current';
  assert.deepEqual(
    await aiMessageDeliveryHandler(groupPayload),
    { status: 'suppressed_foreground', errorCategory: null },
  );
  assert.equal(notificationCalls.length, 0, '当前群聊回复不得触发系统通知');
  assert.deepEqual(
    await aiMessageDeliveryHandler({ ...basePayload, committedMessageId: 102 }),
    { status: 'shown', errorCategory: null },
  );
  assert.equal(notificationCalls.length, 1, '群聊前台时同时到达的私聊回复必须通知');
  assert.equal(notificationCalls[0].conversationKey, 'ai:ai1');

  // 用户正在私聊：私聊回复抑制；群回复按 groupId 聚合通知，不能串进成员单聊。
  fakeForeground.direct = (aiId, sessionId) => aiId === 'ai1' && sessionId === 's1';
  fakeForeground.group = () => false;
  assert.deepEqual(
    await aiMessageDeliveryHandler({
      ...groupPayload,
      groupId: 'group-other',
      sessionId: 'group-other',
      groupName: '另一个群聊',
      committedMessageId: 103,
    }),
    { status: 'shown', errorCategory: null },
  );
  assert.equal(notificationCalls.length, 2, '私聊前台时群聊回复必须通知');
  assert.equal(notificationCalls[1].conversationKey, 'group:group-other');
  assert.equal(notificationCalls[1].conversationTitle, '另一个群聊');
  assert.equal(notificationCalls[1].conversationKind, 'group');
  assert.equal(notificationCalls[1].groupId, 'group-other');

  // 后台：发送聚合通知，eventId = logicalMessageId:segmentIndex。
  fakeAppState.currentState = 'background';
  fakeForeground.direct = () => false;
  fakeForeground.group = () => false;
  assert.deepEqual(
    await aiMessageDeliveryHandler({ ...basePayload, committedMessageId: 101 }),
    { status: 'shown', errorCategory: null },
  );
  assert.equal(notificationCalls.length, 3, '后台必须发送系统通知');
  assert.equal(
    notificationCalls[2].eventId,
    'lm-1:2',
    '通知 eventId 必须是 logicalMessageId:segmentIndex（逐段幂等）',
  );

  // 缺少逻辑分段 ID 时仍以已提交数据库消息 ID 保证重投幂等。
  assert.deepEqual(
    await aiMessageDeliveryHandler({ ...basePayload, logicalMessageId: null }),
    { status: 'shown', errorCategory: null },
  );
  assert.equal(notificationCalls.length, 4);
  assert.equal(notificationCalls[3].eventId, 'message:100');

  // userNotificationHandled（如 RavenCat overlay preview 已承载展示）：不再发系统通知。
  assert.deepEqual(
    await aiMessageDeliveryHandler({ ...basePayload, userNotificationHandled: true }),
    { status: 'handled_by_consumer', errorCategory: null },
  );
  assert.equal(notificationCalls.length, 4, 'userNotificationHandled 时不得再发系统通知');

  const beforeDenied = arrivalCalls.length;
  globalThis.__notificationsEnabled = false;
  assert.deepEqual(await aiMessageDeliveryHandler(basePayload), {
    status: 'failed', errorCategory: 'native_notification_not_shown',
  });
  assert.equal(arrivalCalls.length, beforeDenied + 1, '关闭通知权限仍必须推进消息到达');
  assert.deepEqual(arrivalCalls[0], ['ai:ai1', 100], '前台抑制也消费同一原生到达节奏');
  assert.ok(arrivalCalls.some(([key]) => key === 'group:group-current'), '群聊到达按群隔离');

  // 持久运行正文已经到达，通知直接使用气泡身份，不能拿空数据库 ID 再等一次到达。
  globalThis.__notificationsEnabled = true;
  const beforeDisplayArrival = arrivalCalls.length;
  const displayIdentity = 'agent-timeline:run:1:0';
  const displayPayload = { ...basePayload, committedMessageId: undefined, clientMessageId: displayIdentity,
    turnRunId: 'run', arrivalAlreadyScheduled: true };
  assert.equal((await aiMessageDeliveryHandler(displayPayload)).status, 'shown');
  assert.equal(notificationCalls.at(-1).eventId, displayIdentity);
  assert.equal(notificationCalls.at(-1).turnRunId, 'run');
  assert.equal(arrivalCalls.length, beforeDisplayArrival);
  await aiMessageDeliveryHandler({ ...displayPayload, committedMessageId: 200 });
  assert.equal(notificationCalls.at(-1).eventId, displayIdentity, 'T3 身份交接仍指向同一通知');
  fakeAppState.currentState = 'active';
  fakeForeground.direct = () => true;
  assert.equal((await aiMessageDeliveryHandler(displayPayload)).status, 'suppressed_foreground');

  delete globalThis.__fakeAppState;
  delete globalThis.__fakeChatForeground;
  delete globalThis.__notificationCalls;
  delete globalThis.__arrivalCalls;
  delete globalThis.__notificationsEnabled;
  delete globalThis.__aiMessageDeliveryHandler;
}

// ============================================================================
// 后台入口组合行为
// ============================================================================

// 悬浮预览在正文持久交付时显示；T3 的正式消息回调只交接身份，不重复弹出。
for (const previewAccepted of [true, false]) {
  const previews = [];
  const receipts = [];
  const completions = [];
  let cancelWithoutReply = false;
  let receivedExecution;
  const floating = loadTypeScriptModule('src/features/companion/application/ExecuteFloatingMessage.ts', {
    '@features/assistants': { getAssistantDisplayName: ai => ai.name },
    '@features/screenCapture': { ScreenCaptureError: class extends Error {} },
    '@features/floatingLayer': {
      updateTargetPreview: async () => {},
      updateReplyPreview: async payload => { previews.push(payload); return previewAccepted; },
      recordFloatingMessageTaskCompletion: async payload => completions.push(payload),
    },
    './CompanionConversationTarget': {
      buildCompanionAIRequestConfig: () => ({}),
      resolveCompanionConversationTarget: async () => ({ ai: { id: 'ai', name: 'AI' }, session: { id: 's' } }),
    },
    './CompanionScreenCapture': {},
    './CompanionRuntimeDependencies': { getCompanionRuntimeDependencies: () => ({
      initializeDatabase: async () => {},
      chat: { sendUserMessageFromExecutionHost: async ({ replyCallbacks, execution }) => {
        receivedExecution = execution;
        if (cancelWithoutReply) return { userMessage: { id: 2 }, success: true };
        for (const [index, text] of ['提前图片1', '提前图片2'].entries()) {
          receipts.push(await replyCallbacks.onReplySegment({ sessionId: 's', clientMessageId: `agent-timeline:preview:media-${index}:0`,
            messageId: index + 10, segmentIndex: 0, segmentTotal: 1, text, previewText: text }));
        }
        for (const [index, text] of ['第一泡', '第二泡'].entries()) {
          const clientMessageId = `agent-timeline:preview:${index + 1}:0`;
          receipts.push(await replyCallbacks.onReplyDisplaySegment({ sessionId: 's', clientMessageId, text, previewText: text }));
          const displayCorrelation = previews.at(-1).correlationId;
          receipts.push(await replyCallbacks.onReplySegment({ sessionId: 's', clientMessageId, messageId: index + 1,
            segmentIndex: index, text, previewText: text }));
          assert.equal(previews.at(-1).correlationId, displayCorrelation, '正式消息交接须沿用已有预览身份');
          assert.equal(previews.at(-1).messageId, index + 1, '预览绑定正式 ID 后才可发出已读回执');
        }
        replyCallbacks.onReplyCommitted();
        return { userMessage: { id: 1 }, success: true };
      } },
    }) },
  });
  await floating.executeFloatingMessage({ action: 'message', text: '测试', correlationId: 'preview' }, { signal: new AbortController().signal, executionDeadlineAt: performance.now() + 60_000 });
  const replyPreviews = new Map(previews.filter(item => item.status === 'reply').map(item => [item.correlationId, item]));
  assert.deepEqual([...replyPreviews.values()].map(item => item.text), ['提前图片1', '提前图片2', '第一泡', '第二泡']);
  assert.equal(replyPreviews.size, 4, '独立提交的媒体即使段序号相同，也不能互相覆盖或覆盖前言');
  assert.ok(receipts.every(receipt => receipt.userNotificationHandled === previewAccepted),
    '原生拒绝预览时保持未处理回执，由统一协调器发送系统通知');
  assert.equal(completions[0].succeeded, true);
  cancelWithoutReply = true;
  const cancelled = new AbortController();
  const cancellationResult = assert.rejects(floating.executeFloatingMessage(
    { action: 'message', text: '取消测试', correlationId: 'cancelled-preview' },
    { signal: cancelled.signal, executionDeadlineAt: performance.now() + 60_000 },
  ), /后台执行已取消或超时/);
  await flush();
  assert.equal(receivedExecution.signal, cancelled.signal, '悬浮发送必须将同一取消信号传入 Chat');
  cancelled.abort();
  await cancellationResult;
  assert.equal(completions.at(-1).succeeded, false, '撤销 owner 后没有回复回调，悬浮等待也必须结束');
}

// 真实后台入口与启动门组合；不以 helper 名称或源码循环写法代替业务行为。
const runnerUrl = transpileToModuleUrl(read('src/host/composition/runPendingBackupRestoreCompletion.ts'));
const { runPendingBackupRestoreCompletion } = await import(runnerUrl);
const bootstrapState = { events: [], ready: false, bootstrapGate: null, firstSessionGate: null, fail: false, execution: [] };
globalThis.__HEADLESS_BOOTSTRAP_TEST__ = bootstrapState;
globalThis.__HEADLESS_RESTORE_RUNNER__ = runPendingBackupRestoreCompletion;
const restoreStubUrl = transpileToModuleUrl(`
  export async function completePendingBackupRestore() {
    globalThis.__HEADLESS_BOOTSTRAP_TEST__.events.push('restore');
    await globalThis.__HEADLESS_RESTORE_RUNNER__({ consumeRestoreFailure: async () => null, readPendingRestoreAction: async () => null });
  }
`);
const databaseStubUrl = transpileToModuleUrl(`
  export async function initDatabase() {
    const state = globalThis.__HEADLESS_BOOTSTRAP_TEST__;
    state.events.push('bootstrap');
    if (state.bootstrapGate) await state.bootstrapGate.promise;
    if (state.fail) throw new Error('bootstrap failed');
    state.ready = true;
  }
`);
const readyUrl = transpileToModuleUrl(read('src/host/composition/ensureHostDatabaseReady.ts')
  .replace("from '@platform/persistence'", `from '${databaseStubUrl}'`)
  .replace("from './completePendingBackupRestore'", `from '${restoreStubUrl}'`));
const taskNativeUrl = transpileToModuleUrl(`export const AppState = { currentState: 'background' };`);
const taskChatUrl = transpileToModuleUrl(`export function emitChatMessagesUpdated() {}`);
const taskLogUrl = transpileToModuleUrl(`export function logTurnTimeline() {}`);
const taskCoordinatorUrl = transpileToModuleUrl(`
  export function getConversationTurnCoordinator() {
    return { async executeTurnFromHost(id, options) {
      const state = globalThis.__HEADLESS_BOOTSTRAP_TEST__;
      if (!state.ready) throw new Error('query before bootstrap');
      state.execution.push([id, options.deliveryTiming]);
      if (id === 'first' && state.firstSessionGate) await state.firstSessionGate.promise;
      return 'executed';
    } };
  }
`);
const taskUrl = transpileToModuleUrl(read('src/host/runtime/ExecuteConversationTurns.ts')
  .replace("from 'react-native'", `from '${taskNativeUrl}'`)
  .replace("from '@features/chat/composition'", `from '${taskChatUrl}'`)
  .replace("from '@shared/diagnostics/TurnTimelineLog'", `from '${taskLogUrl}'`)
  .replace("from '../composition/ensureHostDatabaseReady'", `from '${readyUrl}'`)
  .replace("from './ConversationTurnCoordinator'", `from '${taskCoordinatorUrl}'`));
const { executeConversationTurns } = await import(taskUrl);
bootstrapState.bootstrapGate = deferred();
bootstrapState.firstSessionGate = deferred();
const execution = { requestId: 'application-request', signal: new AbortController().signal, executionDeadlineAt: performance.now() + 60_000 };
const headless = executeConversationTurns({ sessionIds: ['first', 'second'], deliveryTiming: 'paced' }, execution);
await flush();
assert.deepEqual(bootstrapState.events, ['restore', 'bootstrap']);
assert.deepEqual(bootstrapState.execution, [], 'bootstrap 完成前禁止 claim');
bootstrapState.bootstrapGate.resolve();
await flush();
assert.deepEqual(bootstrapState.execution, [['first', 'immediate']], '首个会话未终态时不能执行下一会话');
bootstrapState.firstSessionGate.resolve();
await headless;
assert.deepEqual(bootstrapState.execution, [['first', 'immediate'], ['second', 'immediate']]);
bootstrapState.execution = []; bootstrapState.fail = true; bootstrapState.ready = false;
await assert.rejects(executeConversationTurns({ sessionIds: ['fail'] }, execution), /bootstrap failed/);
assert.deepEqual(bootstrapState.execution, [], '初始化失败不开放业务读取');
delete globalThis.__HEADLESS_BOOTSTRAP_TEST__; delete globalThis.__HEADLESS_RESTORE_RUNNER__;

// 日程等待只由真实终态/所有权事件推进；不猜测用户是否在聊天，不轮询。
function autonomousScenario() {
  let active = null;
  let pendingUser = false;
  let sequence = 0;
  const executions = [];
  const claims = [];
  const finished = [];
  const gates = new Map();
  const userHostStarts = [];
  const make = (sessionId, runId, kind) => ({ sessionId, runId, kind, revisionAtClaim: ++sequence,
    replyCursorAtClaim: 0, inputHighWatermark: 1, status: 'active' });
  const turns = {
    getActiveRun: async () => active,
    interruptAbandonedAutonomousRuns: async () => [],
    claimAutonomousIfIdle: async (sessionId, runId) => {
      claims.push(runId);
      if (active || pendingUser) return null;
      return active = make(sessionId, runId, 'autonomous');
    },
    finishAutonomous: async run => {
      finished.push(run.runId);
      if (active?.runId === run.runId) active = null;
    },
    revoke: async run => { if (active?.runId === run.runId) active = null; },
    claimIfIdle: async sessionId => {
      if (active || !pendingUser) return null;
      return active = make(sessionId, `user-${sequence}`, 'user_reply');
    },
    getSessionTurnSnapshot: async sessionId => pendingUser ? { sessionId, highWatermark: 1, replyCursor: 0 } : null,
    findTerminalRunCovering: async () => null,
    takeOverOrphan: async sessionId => active = make(sessionId, `recovered-${sequence}`, 'user_reply'),
  };
  const coordinator = createConversationTurnCoordinator({ turns, resolveAIConfig: async () => aiConfig,
    executionHost: { start: async ids => { userHostStarts.push(ids); return true; } },
    executeTurn: async ({ run }) => {
      const gate = deferred(); gates.set(run.runId, gate);
      executions.push(run.runId);
      await gate.promise;
      if (active?.runId === run.runId) { active = null; pendingUser = false; }
      return 'committed';
    },
  });
  return { coordinator, turns, claims, executions, finished, gates, userHostStarts, active: () => active,
    userInput() { const old = active?.runId ?? null; active = null; pendingUser = true; return old; } };
}

const priority = (minute, scheduleId) => ({ plannedAt: `2026-10-28T09:${minute}:00.000Z`, updatedAt: '2026-10-28T08:00:00.000Z', scheduleId });
{
  const state = autonomousScenario();
  state.userInput();
  const user = state.coordinator.executeTurnFromHost('schedule-chat');
  await flush();
  const result = await state.coordinator.runAutonomousFromHost('schedule-chat', 'busy', priority('00', 'busy'), async () => {
    assert.fail('用户聊天期间不能额外启动日程模型');
  });
  assert.deepEqual(result, { status: 'chat_busy' }, '日程交给聊天上下文，不等待用户聊天结束后补跑');
  state.gates.get(state.executions[0]).resolve(); await user;
  assert.deepEqual(state.claims, []);
}
{
  const state = autonomousScenario();
  const gate = deferred(); let oldContext; let newContext;
  const old = state.coordinator.runAutonomousFromHost('schedule-chat', 'old', priority('00', 'old'), async context => {
    oldContext = context; await gate.promise; return 'old';
  });
  await flush();
  const latest = await state.coordinator.runAutonomousFromHost('schedule-chat', 'latest', priority('01', 'latest'), async context => {
    newContext = context; return 'latest';
  });
  assert.equal(oldContext.signal.aborted, true, '最新日程先撤销旧 owner 并停止后续执行');
  assert.equal(newContext.displacedRunId, 'old', '旧安排背景交给最新一轮');
  assert.deepEqual(latest, { status: 'ran', value: 'latest' });
  gate.resolve(); await old;
  assert.equal(state.active(), null, '旧回合迟到 finally 不得污染新 owner');
}
{
  const state = autonomousScenario();
  const gate = deferred();
  const latest = state.coordinator.runAutonomousFromHost('schedule-chat', 'latest', priority('02', 'latest'), async () => {
    await gate.promise; return 'latest';
  });
  await flush();
  const older = await state.coordinator.runAutonomousFromHost('schedule-chat', 'older', priority('01', 'older'), async () => assert.fail('旧日程不能抢走最新日程'));
  assert.deepEqual(older, { status: 'superseded', scheduleId: 'latest' });
  gate.resolve(); await latest;
}
{
  const state = autonomousScenario();
  const gate = deferred(); let scheduleContext;
  const scheduled = state.coordinator.runAutonomousFromHost('schedule-chat', 'schedule', priority('00', 'schedule'), async context => {
    scheduleContext = context; await gate.promise; return 'late';
  });
  await flush();
  const supersededRunId = state.userInput();
  await state.coordinator.onCanonicalUserMessageCommitted({ sessionId: 'schedule-chat', supersededRunId,
    executionMode: 'delegate_to_android_host', aiConfig });
  assert.equal(scheduleContext.signal.aborted, true, '用户输入优先撤销日程');
  gate.resolve(); await scheduled;
}
{
  const state = autonomousScenario(); state.userInput();
  const result = await state.coordinator.runAutonomousFromHost('schedule-chat', 'pending', priority('00', 'pending'), async () => assert.fail('未回复用户输入优先'));
  assert.deepEqual(result, { status: 'chat_busy' });
  assert.deepEqual(state.userHostStarts, [], '不能为了日程重新启动普通聊天宿主');
}
{
  const state = autonomousScenario(); const gate = deferred();
  const claim = state.turns.claimAutonomousIfIdle;
  state.turns.claimAutonomousIfIdle = async (...args) => { await gate.promise; return claim(...args); };
  const first = state.coordinator.runAutonomousFromHost('schedule-chat', 'first', priority('00', 'first'), async context => context);
  const second = state.coordinator.runAutonomousFromHost('schedule-chat', 'second', priority('01', 'second'), async context => context);
  gate.resolve();
  const result = await second; await first;
  assert.equal(result.status, 'ran', '同时抵达时，短小 admission 交接不能把日程误判成用户聊天');
}

console.log('ConversationTurn execution host 契约验证通过：页面委派 / 就地执行 / host 等待 terminal / 孤儿接管 / recovery 委派 / 交付策略 / 冷启动 bootstrap / 日程共享所有权与用户优先。');
console.log('真机后台链路（常驻应用身份与 XHR/SSE 消费）仍需 Android 验收。');
