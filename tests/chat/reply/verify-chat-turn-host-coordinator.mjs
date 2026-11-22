/**
 * Phase 5A 第三片：Host ConversationTurnCoordinator 内存协议行为验证。
 *
 * 以 data: URL 动态编译 src/host/runtime/ConversationTurnCoordinator.ts，
 * 桩掉 '@features/chat/composition' / '@features/assistants' / '@platform/device' /
 * '@shared/diagnostics/TurnTimelineLog' 值导入，用内存 fake 验证：
 * 1. T1 supersede 后 abort 旧句柄并移除，允许新 claim（claimIfIdle）；
 *    普通页面显式 delegate（即使带 presentation callback）不得就地 claim，必须委派 execution host；
 * 2. identity-safe finally：旧 run 结束不得删除新 run 的句柄；
 * 3. claimIfIdle 不抢 active run（有活句柄时不再 claim）；
 * 4. recovery 只发现待恢复会话并一次性委派 execution host：跳过有活句柄 /
 *    已消费（hw<=cursor）/ failed-cancelled 终态覆盖的会话，页面 runtime
 *    不 claim、不 takeOverOrphan、不执行 run、不注册 activeHandle；
 * 5. recovery 多页 keyset 扫描完整（遍历到空页、批间让出执行权），
 *    跨页收集的待恢复会话列表只触发一次 executionHost.start。
 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

const chatReplyAbortModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/application/ChatReplyAbort.ts'),
);

// 值导入桩：单例工厂引用的具体实现一律置空（测试只用 createConversationTurnCoordinator），
// isChatReplyRunCancellationError 用真实实现。
const chatStub = `import { isChatReplyRunCancellationError } from '${chatReplyAbortModuleUrl}';
const conversationTurnRepository = null;
const executeUserReplyTurn = null;
const sessionRepository = null;
const emitChatMessagesReloadRequested = () => {};
const emitChatTurnExecutionChanged = () => {};
const interruptChatRunPresentation = async () => {};
const emitChatRegenerationChanged = () => {};
const emitChatTypingStatusChanged = () => {};`;

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
  !stubbedCoordinatorSource.includes("'@features/chat/composition'")
    && !stubbedCoordinatorSource.includes("'@features/assistants'")
    && !stubbedCoordinatorSource.includes("'@platform/device'")
    && !stubbedCoordinatorSource.includes("'@shared/diagnostics/TurnTimelineLog'"),
  '协调器测试桩必须移除跨 Feature / platform / shared 值导入',
);
const coordinatorModuleUrl = transpileToModuleUrl(stubbedCoordinatorSource);
const { createConversationTurnCoordinator } = await import(coordinatorModuleUrl);

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

/** 内存 fake：回合仓储 + 可控 executeTurn + execution host 触发口。 */
function createFakes() {
  let runSeq = 0;
  const calls = {
    claimIfIdle: [],
    takeOverOrphan: [],
    revoke: [],
    executionHostStart: [],
  };
  const executions = new Map(); // runId -> { signal, gate, params }
  const turns = {
    interruptAbandonedAutonomousRuns: async () => [],
    claimIfIdle: async (sessionId, kind) => {
      const run = {
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
      };
      calls.claimIfIdle.push(run);
      return run;
    },
    takeOverOrphan: async (sessionId, kind) => {
      const run = {
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
      };
      calls.takeOverOrphan.push(run);
      return run;
    },
    revoke: async (run, status, reason) => {
      calls.revoke.push({ runId: run.runId, status, reason });
    },
    findTerminalRunCovering: async () => null,
    getSessionTurnSnapshot: async () => null,
    listSessionsWithUnrepliedInput: async () => [],
  };
  const executeTurn = (params) => {
    const gate = deferred();
    executions.set(params.run.runId, { signal: params.signal, gate, params });
    return gate.promise;
  };
  // execution host 触发口 fake：记录页面路径的委派调用（首参为会话 id 数组）。
  const executionHost = {
    start: async (sessionIds, options) => {
      calls.executionHostStart.push({ sessionIds, options });
      return true;
    },
  };
  return { calls, executions, turns, executeTurn, executionHost };
}

const aiConfig = { id: 'ai1', agentId: 'agent1', name: 'AI' };

// ============================================================================
// 测试 1+2+3：supersede abort 旧句柄并允许新 claim；identity-safe finally；claimIfIdle 不抢 active
// ============================================================================
{
  const fakes = createFakes();
  const coordinator = createConversationTurnCoordinator({
    turns: fakes.turns,
    executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => aiConfig,
    executionHost: fakes.executionHost,
  });

  const launched = await coordinator.launchTurn('s1', 'send_flow', 'claimIfIdle', { aiConfig });
  assert.equal(launched, true, '首次 launch 必须成功');
  assert.equal(coordinator.hasActiveHandle('s1'), true, 'claim 成功后必须注册句柄');
  const run1 = fakes.calls.claimIfIdle[0];
  const exec1 = fakes.executions.get(run1.runId);
  assert.ok(exec1, 'claim 成功后必须 fire-and-forget 启动 executeRun');

  // 有活句柄时 claimIfIdle 不得抢走 active run：不再发起 claim。
  const reentrant = await coordinator.launchTurn('s1', 'send_flow', 'claimIfIdle', { aiConfig });
  assert.equal(reentrant, false, '有活句柄时重复触发必须返回 false');
  assert.equal(fakes.calls.claimIfIdle.length, 1, '有活句柄时不得再次 claimIfIdle');

  // 普通页面显式 delegate（即使有 notifyUI）：不得就地 claim，必须委派 Android-backed execution host。
  await coordinator.onCanonicalUserMessageCommitted({
    sessionId: 's2',
    message: { id: 41 },
    aiConfig,
    executionMode: 'delegate_to_android_host',
    correlationId: 'corr-page',
    deliveryTiming: 'paced',
    replyCallbacks: { notifyUI: () => {} },
  });
  assert.equal(fakes.calls.claimIfIdle.length, 1, '页面路径不得在页面 runtime 就地 claim');
  assert.equal(fakes.calls.executionHostStart.length, 1, '页面路径必须启动 execution host');
  assert.deepEqual(
    fakes.calls.executionHostStart[0].sessionIds,
    ['s2'],
    '页面路径必须以单元素会话数组启动 execution host',
  );
  assert.equal(
    fakes.calls.executionHostStart[0].options.correlationId,
    'corr-page',
    'correlationId 必须透传给 execution host',
  );
  assert.equal(
    fakes.calls.executionHostStart[0].options.deliveryTiming,
    'paced',
    'deliveryTiming 必须透传给 execution host',
  );

  // T1 supersede：abort 旧句柄并先移除，再允许新一轮 claimIfIdle。
  // 只有显式 inline_current_host 的调用方（如悬浮 Headless 任务）才允许就地 claim。
  await coordinator.onCanonicalUserMessageCommitted({
    sessionId: 's1',
    message: { id: 42 },
    supersededRunId: run1.runId,
    aiConfig,
    executionMode: 'inline_current_host',
    correlationId: 'corr-1',
    replyCallbacks: { notifyUI: () => {} },
  });
  assert.equal(exec1.signal.aborted, true, 'supersede 必须 abort 旧 run 的 signal');
  assert.equal(fakes.calls.claimIfIdle.length, 2, 'supersede 后必须允许新一轮 claim');
  assert.equal(
    fakes.calls.executionHostStart.length,
    1,
    '显式 inline_current_host 调用方不得再次启动 execution host',
  );
  const run2 = fakes.calls.claimIfIdle[1];
  assert.notEqual(run2.runId, run1.runId, '新一轮必须是新 run');
  assert.equal(coordinator.hasActiveHandle('s1'), true, '新 run 句柄必须已注册');
  const exec2 = fakes.executions.get(run2.runId);
  assert.equal(exec2.params.correlationId, 'corr-1', 'correlationId 必须透传给 run 执行');

  // identity-safe finally：旧 run 迟到结束，不得删除新 run 的句柄。
  exec1.gate.resolve('fence_failed');
  await flush();
  await flush();
  assert.equal(coordinator.hasActiveHandle('s1'), true, '旧 run 结束不得删除新 run 的句柄');
  const blocked = await coordinator.launchTurn('s1', 'send_flow', 'claimIfIdle', { aiConfig });
  assert.equal(blocked, false, '新 run 句柄仍在时不得再 claim');
  assert.equal(fakes.calls.claimIfIdle.length, 2, '句柄未被旧 run 误删时不得新增 claim');

  // 新 run 正常结束后清理自己的句柄。
  exec2.gate.resolve('committed');
  await flush();
  await flush();
  assert.equal(coordinator.hasActiveHandle('s1'), false, '新 run 结束后必须清理句柄');
  assert.ok(fakes.calls.revoke.every(call => call.runId === run1.runId), '取消收口只能引用旧 run，不能撤销新回复');
}

// ============================================================================
// 测试 3b：empty_reply 必须由 Host revoke('failed', 'empty_reply') 收尾
// ============================================================================
{
  const fakes = createFakes();
  const coordinator = createConversationTurnCoordinator({
    turns: fakes.turns,
    executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => aiConfig,
  });
  await coordinator.launchTurn('s1', 'send_flow', 'claimIfIdle', { aiConfig });
  const run = fakes.calls.claimIfIdle[0];
  fakes.executions.get(run.runId).gate.resolve('empty_reply');
  await flush();
  await flush();
  assert.deepEqual(
    fakes.calls.revoke,
    [{ runId: run.runId, status: 'failed', reason: 'empty_reply' }],
    "空回复必须 revoke('failed', 'empty_reply')，不得留 active 悬挂",
  );
}

// ============================================================================
// 测试 4：recovery 跳过判据（活句柄 / hw<=cursor / failed-cancelled 覆盖）+ 一次性委派
// ============================================================================
{
  const fakes = createFakes();
  const sessions = [
    { sessionId: 's-active', replyCursor: 5, highWatermark: 10 },
    { sessionId: 's-consumed', replyCursor: 10, highWatermark: 10 },
    { sessionId: 's-failed', replyCursor: 5, highWatermark: 10 },
    { sessionId: 's-orphan', replyCursor: 5, highWatermark: 10 },
  ];
  fakes.turns.listSessionsWithUnrepliedInput = async (after, limit) =>
    sessions.filter((s) => s.sessionId > after).slice(0, limit);
  fakes.turns.findTerminalRunCovering = async (sessionId) =>
    sessionId === 's-failed' ? { runId: 'old-failed' } : null;

  const coordinator = createConversationTurnCoordinator({
    turns: fakes.turns,
    executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => aiConfig,
    executionHost: fakes.executionHost,
  });

  // s-active 已有本进程活句柄（在线 run 仍在执行）。
  await coordinator.launchTurn('s-active', 'send_flow', 'claimIfIdle', { aiConfig });
  const claimCallsBeforeRecovery = fakes.calls.claimIfIdle.length;

  await coordinator.recoverConversationTurns();

  assert.equal(
    fakes.calls.executionHostStart.length,
    1,
    'recovery 必须一次性委派 execution host，不在页面 runtime 执行 run',
  );
  assert.deepEqual(
    fakes.calls.executionHostStart[0].sessionIds,
    ['s-orphan'],
    '只有通过全部跳过判据的会话才被委派恢复（活句柄 / 已消费 / 终态覆盖均跳过）',
  );
  assert.equal(
    fakes.calls.takeOverOrphan.length,
    0,
    '页面 recovery 不得 takeOverOrphan（孤儿接管由 execution host 任务侧判定）',
  );
  assert.equal(
    fakes.calls.claimIfIdle.length,
    claimCallsBeforeRecovery,
    '页面 recovery 不得使用 claimIfIdle',
  );
  assert.equal(
    fakes.executions.size,
    1,
    '页面 recovery 不得启动 executeRun（唯一 execution 来自 launchTurn 的在线 run）',
  );
  assert.equal(
    coordinator.hasActiveHandle('s-orphan'),
    false,
    'recovery 委派不得在本进程注册 activeHandle',
  );
}

// ============================================================================
// 测试 5：recovery 多页扫描完整，跨页收集后只启动一次 execution host
// ============================================================================
{
  const fakes = createFakes();
  const sessions = [
    { sessionId: 's-1', replyCursor: 5, highWatermark: 10 },
    { sessionId: 's-2', replyCursor: 10, highWatermark: 10 }, // 已消费，跳过
    { sessionId: 's-3', replyCursor: 5, highWatermark: 10 },
    { sessionId: 's-4', replyCursor: 5, highWatermark: 10 }, // 终态覆盖，跳过
    { sessionId: 's-5', replyCursor: 5, highWatermark: 10 },
  ];
  const listCalls = [];
  fakes.turns.listSessionsWithUnrepliedInput = async (after, limit) => {
    listCalls.push({ after, limit });
    return sessions.filter((s) => s.sessionId > after).slice(0, limit);
  };
  fakes.turns.findTerminalRunCovering = async (sessionId) =>
    sessionId === 's-4' ? { runId: 'old-failed' } : null;

  let yieldCount = 0;
  const coordinator = createConversationTurnCoordinator({
    turns: fakes.turns,
    executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => aiConfig,
    executionHost: fakes.executionHost,
    recoveryBatchSize: 2,
    yieldControl: async () => {
      yieldCount += 1;
    },
  });

  await coordinator.recoverConversationTurns();

  assert.equal(
    fakes.calls.executionHostStart.length,
    1,
    '多页扫描后必须只启动一次 execution host',
  );
  assert.deepEqual(
    fakes.calls.executionHostStart[0].sessionIds,
    ['s-1', 's-3', 's-5'],
    '委派列表必须恰好包含全部待恢复会话（跨页收集，跳过项不入列）',
  );
  assert.equal(listCalls.length, 4, '分页必须遍历到空页才停止');
  assert.deepEqual(
    listCalls.map((call) => call.after),
    ['', 's-2', 's-4', 's-5'],
    'keyset 分页必须以本页末位 sessionId 续扫',
  );
  assert.equal(yieldCount, 3, '每个非空批次后必须让出执行权');
  assert.equal(fakes.calls.claimIfIdle.length, 0, 'recovery 不得 claimIfIdle');
  assert.equal(fakes.calls.takeOverOrphan.length, 0, 'recovery 不得 takeOverOrphan');
  assert.equal(fakes.executions.size, 0, 'recovery 不得在页面 runtime 执行 run');
}

// 恢复出厂覆盖 claim、准备及整轮执行；关闭期间不能新 claim，等待终态后才释放。
{
  const fakes = createFakes();
  const coordinator = createConversationTurnCoordinator({ turns: fakes.turns, executeTurn: fakes.executeTurn, resolveAIConfig: async () => aiConfig });
  await coordinator.launchTurn('reset', 'send_flow', 'claimIfIdle', { aiConfig });
  const execution = fakes.executions.values().next().value;
  let finished = false;
  const closing = coordinator.cancelActiveTurnsForReset().then(() => { finished = true; });
  await flush();
  assert.equal(execution.signal.aborted, true);
  assert.equal(finished, false, '整轮准备/执行尚未结束时不能完成 drain');
  assert.equal(await coordinator.launchTurn('late', 'send_flow', 'claimIfIdle', { aiConfig }), false);
  assert.equal(await coordinator.executeTurnFromHost('late'), 'skipped');
  execution.gate.resolve('empty_reply');
  await closing;
  assert.equal(fakes.calls.revoke.at(-1).status, 'cancelled');
  assert.equal(coordinator.hasActiveHandle('reset'), false);
  coordinator.resumeTurnsAfterReset();
  assert.equal(await coordinator.launchTurn('fresh', 'send_flow', 'claimIfIdle', { aiConfig }), true);
  fakes.executions.get(fakes.calls.claimIfIdle.at(-1).runId).gate.resolve('empty_reply');
  await flush();
}
for (const phase of ['claim', 'configuration']) {
  const fakes = createFakes();
  const started = deferred(), release = deferred();
  if (phase === 'claim') {
    const claim = fakes.turns.claimIfIdle;
    fakes.turns.claimIfIdle = async (...args) => { started.resolve(); await release.promise; return claim(...args); };
  }
  const coordinator = createConversationTurnCoordinator({
    turns: fakes.turns, executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => {
      if (phase === 'configuration') { started.resolve(); await release.promise; }
      return aiConfig;
    },
  });
  const execution = coordinator.executeTurnFromHost('preparing');
  await started.promise;
  let drained = false;
  const closing = coordinator.cancelActiveTurnsForReset().then(() => { drained = true; });
  await flush();
  assert.equal(drained, false);
  release.resolve();
  await Promise.all([execution, closing]);
  assert.equal(fakes.executions.size, 0, 'claim/配置读取期间取消不能再进入模型执行');
  assert.equal(fakes.calls.revoke.at(-1).status, 'cancelled');
}

{
  const fakes = createFakes();
  const controller = new AbortController();
  const coordinator = createConversationTurnCoordinator({ turns: fakes.turns, executeTurn: fakes.executeTurn, resolveAIConfig: async () => aiConfig });
  const running = coordinator.executeTurnFromHost('host-timeout', { signal: controller.signal, executionDeadlineAt: Date.now() + 60_000 });
  await flush();
  const execution = fakes.executions.get(fakes.calls.claimIfIdle[0].runId);
  controller.abort('execution_host_timeout');
  assert.equal(execution.signal.aborted, true);
  // 模型／工具即使暂时不响应 abort，宿主也须先完成 T4，不能一直挂 active owner。
  await running;
  assert.equal(fakes.calls.revoke.at(-1).status, 'failed');
  assert.equal(fakes.calls.revoke.at(-1).reason, 'execution_host_timeout');
  assert.equal(coordinator.hasActiveHandle('host-timeout'), false);
  execution.gate.reject(new (await import(chatReplyAbortModuleUrl)).ChatReplyRunCancelledError());
  await flush();
}

{
  const fakes = createFakes();
  const coordinator = createConversationTurnCoordinator({ turns: fakes.turns, executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => aiConfig, executionHost: fakes.executionHost });
  await coordinator.onCanonicalUserMessageCommitted({ sessionId: 'manual', supersededRunId: null,
    aiConfig, executionMode: 'delegate_to_android_host', requestReply: false });
  assert.equal(fakes.calls.executionHostStart.length, 0, '手动发送不能唤醒执行宿主');
  assert.equal(fakes.calls.claimIfIdle.length, 0, '页面不能趁机直接执行');
  await coordinator.onCanonicalUserMessageCommitted({ sessionId: 'automatic', supersededRunId: null,
    aiConfig, executionMode: 'delegate_to_android_host', requestReply: true });
  assert.equal(fakes.calls.executionHostStart.length, 1, '关闭手动模式仍走原有自动执行宿主');
}

console.log('ConversationTurnCoordinator 第三片：Host 内存协议 / supersede / recovery / reset drain 行为验证通过。');
console.log('真实 SQLite 回合事务由前两片脚本覆盖；Host 装配与真机链路仍需 Android 验收。');
