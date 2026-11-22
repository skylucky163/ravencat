import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


function loadTypeScriptModule(relativePath, mocks = {}) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  const requireMock = (specifier) => {
    assert.ok(Object.hasOwn(mocks, specifier), `未声明的运行时依赖：${specifier}`);
    return mocks[specifier];
  };
  new Function('exports', 'require', 'module', output.outputText)(
    module.exports,
    requireMock,
    module,
  );
  return module.exports;
}

const abortSignalRuntime = loadTypeScriptModule(
  'src/shared/runtime/abortSignal.ts',
);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const { HostAuthorityCoordinator } = loadTypeScriptModule(
  'src/features/assistants/application/HostAuthorityCoordinator.ts',
);

let currentHostAiId = 'host-a';
const coordinator = new HostAuthorityCoordinator({
  getCurrentHostAIId: async () => currentHostAiId,
});

assert.deepEqual(
  await coordinator.runAsCurrentHost('host-a', async () => 'done'),
  { status: 'authorized', value: 'done' },
);
currentHostAiId = 'host-b';
let staleActionExecuted = false;
assert.deepEqual(
  await coordinator.runAsCurrentHost('host-a', async () => {
    staleActionExecuted = true;
  }),
  { status: 'not_current_host' },
  '已撤销或替换的旧主理 AI 必须按执行时身份拒绝',
);
assert.equal(staleActionExecuted, false);
assert.equal(
  (await coordinator.runAsCurrentHost('host-b', async () => 'new-host')).status,
  'authorized',
  '新主理 AI 必须拥有执行时 authority',
);

const actionStarted = deferred();
const releaseAction = deferred();
const actionFirstOrder = [];
const actionFirst = coordinator.runAsCurrentHost('host-b', async () => {
  actionFirstOrder.push('action:start');
  actionStarted.resolve();
  await releaseAction.promise;
  actionFirstOrder.push('action:end');
});
await actionStarted.promise;
const mutationAfterAction = coordinator.runHostMutation(async () => {
  actionFirstOrder.push('mutation');
  currentHostAiId = null;
});
await Promise.resolve();
assert.deepEqual(actionFirstOrder, ['action:start']);
releaseAction.resolve();
await Promise.all([actionFirst, mutationAfterAction]);
assert.deepEqual(actionFirstOrder, ['action:start', 'action:end', 'mutation']);

currentHostAiId = 'host-a';
const mutationStarted = deferred();
const releaseMutation = deferred();
const mutationFirst = coordinator.runHostMutation(async () => {
  mutationStarted.resolve();
  await releaseMutation.promise;
  currentHostAiId = 'host-b';
});
await mutationStarted.promise;
const actionAfterMutation = coordinator.runAsCurrentHost('host-a', async () => {
  staleActionExecuted = true;
});
releaseMutation.resolve();
await mutationFirst;
assert.deepEqual(await actionAfterMutation, { status: 'not_current_host' });

let managedHostAiId = null;
let setHostCalls = 0;
let deleteCalls = 0;
let relationshipRemovedCalls = 0;
let relationshipRemovedHandler = async () => {};
let pendingRevoke = null;
const assistantManagement = loadTypeScriptModule(
  'src/features/assistants/AIAssistantManagement.ts',
  {
    '@platform/persistence': { databaseCoordinator: { transaction: (_meta, commit) => commit({}) } },
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '@shared/errors/SettingChangeConflictError': {},
    './domain/ApplicationSettingsAccess': {},
    '@platform/device': {},
    '@features/media': {
      createMediaAssetWithReference: async () => {},
      collectChatSessionMediaAssetCandidates: async () => [],
      releaseMediaAssetCandidates: async () => {},
      MEDIA_ASSET_STORAGE_BACKEND: { persistentImage: 'persistent-image' },
    },
    './domain/HostRepository': {
      HostRelationshipError: class HostRelationshipError extends Error {},
    },
    './application/HostAuthorityCoordinator': { HostAuthorityCoordinator },
    './infrastructure/SQLiteAssistantRepository': {
      aiAssistantRepository: {
        getById: async (aiId) => ({
          id: aiId,
          isBlocked: false,
          isHostAI: managedHostAiId === aiId,
          model: 'chat-model',
        }),
        readHostAppointmentCandidate: async () => ({ model: 'chat-model', blocked_until: null }),
        listDirectSessionIds: async () => [],
        delete: async (aiId) => {
          deleteCalls += 1;
          if (managedHostAiId === aiId) managedHostAiId = null;
          // 删除事务同时给出本次删除带走的 media asset 引用候选（真实实现由级联范围决定）。
          return { deleted: true, mediaAssetCandidates: [] };
        },
      },
    },
    './infrastructure/SQLiteHostRepository': {
      aiHostRepository: {
        getCurrentHostAIId: async () => managedHostAiId,
        setHostAIInTransaction: async (_tx, aiId) => {
          setHostCalls += 1;
          managedHostAiId = aiId;
          return true;
        },
        revokeHostAI: async () => {
          pendingRevoke.started.resolve();
          await pendingRevoke.release.promise;
          managedHostAiId = null;
          return true;
        },
      },
    },
    './infrastructure/SQLiteAssistantRecycleBinRepository': {
      assistantRecycleBinRepository: {
        recycle: async (aiId, suspend) => {
          deleteCalls++;
          const wasHost = managedHostAiId === aiId;
          if (wasHost) managedHostAiId = null;
          return { wasHost, afterCommit: await suspend({}) };
        },
      },
    },
  },
);
assistantManagement.configureAssistantRuntime({
  recordRecycleLifecycleInTransaction: async () => () => {},
  suspendAssistantInTransaction: async () => async () => {},
  onHostRelationshipChanged: async () => {},
  ensureInitialSession: async () => ({ session: null }),
  onHostRelationshipRemoved: async (aiId, reason) => {
    relationshipRemovedCalls += 1;
    await relationshipRemovedHandler(aiId, reason);
  },
});

const laneOccupied = deferred();
const releaseLane = deferred();
const occupyingMutation = assistantManagement.runHostAuthorityMutation(async () => {
  laneOccupied.resolve();
  await releaseLane.promise;
});
await laneOccupied.promise;
const appointing = assistantManagement.appointHostAIAssistant('host-a');
await Promise.resolve();
assert.equal(setHostCalls, 0, '任命入口必须进入同一 authority lane');
releaseLane.resolve();
await Promise.all([occupyingMutation, appointing]);

pendingRevoke = { started: deferred(), release: deferred() };
const revoking = assistantManagement.revokeHostAIAssistant('host-a');
await pendingRevoke.started.promise;
const staleActionAfterRevoke = assistantManagement.runAsCurrentHostAuthority(
  'host-a',
  async () => 'unexpected',
);
pendingRevoke.release.resolve();
await revoking;
assert.deepEqual(await staleActionAfterRevoke, { status: 'not_current_host' });

managedHostAiId = 'host-delete';
const deleteActionStarted = deferred();
const releaseDeleteAction = deferred();
const actionBeforeDelete = assistantManagement.runAsCurrentHostAuthority(
  'host-delete',
  async () => {
    deleteActionStarted.resolve();
    await releaseDeleteAction.promise;
  },
);
await deleteActionStarted.promise;
const deletingCurrentHost = assistantManagement.deleteAIAssistant('host-delete');
await Promise.resolve();
assert.equal(deleteCalls, 0, '高权限动作结束前不得删除当前主理 AI');
releaseDeleteAction.resolve();
await Promise.all([actionBeforeDelete, deletingCurrentHost]);
assert.equal(deleteCalls, 1);
assert.equal(relationshipRemovedCalls, 2, '撤销和删除都必须完成关系移除副作用');

let raceSchedule = null;
let claimGate = null;
let autonomousRunGate = null;
let autonomousRunStarted = null;
let generatedRunNumber = 0;
let claimCalls = 0;
let autonomousRunCalls = 0;
let consumeCalls = 0;
const raceEvents = [];
relationshipRemovedHandler = async (aiId, reason) => {
  raceEvents.push(['relationship-removed', aiId, reason]);
  if (raceSchedule?.status === 'scheduled') {
    raceSchedule = { ...raceSchedule, status: 'cancelled' };
  }
};

const headlessSchedule = loadTypeScriptModule(
  'src/features/companion/application/RunHeadlessAISchedule.ts',
  {
    '@features/assistants': {
      runAsCurrentHostAuthority: assistantManagement.runAsCurrentHostAuthority,
    },
    './AIScheduleRecovery': {
      claimAndTrackAIScheduleRun: (_runId, claim) => claim(),
      completeTrackedAIScheduleRun: (_runId, _disposition, consume) => consume(),
    },
    './AutonomousRunDiagnostic': {
      summarizeAutonomousAgentRun: () => ({}),
    },
    './CompanionRuntimeDependencies': {
      getCompanionRuntimeDependencies: () => ({
        initializeDatabase: async () => raceEvents.push(['database']),
        generateAutonomousRunId: () => `authority-race-run-${++generatedRunNumber}`,
        repositories: { aiSchedules: { prepareDispatch: async () => raceSchedule } },
        chat: {
          resolveCanonicalConversation: async () => ({ id: 'authority-race-session' }),
          listAgentActivityEvidence: async () => [],
          runInConversation: async (_sessionId, _runId, _schedule, execute) => ({
            status: 'ran',
            value: await execute({ signal: new AbortController().signal, displacedRunId: null }),
          }),
        },
      }),
    },
    './RunAIScheduleAutonomousAgent': {
      runAIScheduleAutonomousAgent: async (input) => {
        autonomousRunCalls += 1;
        raceEvents.push(['run-started', input.claimedSchedule.scheduleId]);
        autonomousRunStarted?.resolve();
        if (autonomousRunGate) await autonomousRunGate.promise;
        raceEvents.push(['run-finished', input.claimedSchedule.scheduleId]);
        return {
          taskId: 'authority-race-task',
          status: 'completed',
          terminalCode: 'COMPLETED',
          finalText: '',
          history: [],
          steps: [],
          stepCount: 1,
          toolCallCount: 0,
        };
      },
    },
    './AIScheduleProjectionOwner': {
      reconcileAIScheduleProjections: async () => {},
      claimAIScheduleForHeadless: async (input) => {
        claimCalls += 1;
        raceEvents.push(['claim-started', input.scheduleId]);
        claimGate?.started.resolve();
        if (claimGate) await claimGate.release.promise;
        assert.equal(raceSchedule?.status, 'scheduled', 'claim 只接受 scheduled wake');
        raceSchedule = {
          ...raceSchedule,
          status: 'claimed',
          claimedByRunId: input.runId,
        };
        raceEvents.push(['claimed', input.scheduleId]);
        return { status: 'claimed', schedule: raceSchedule };
      },
      consumeAIScheduleWithProjection: async ({ scheduleId }) => {
        consumeCalls += 1;
        assert.equal(raceSchedule?.scheduleId, scheduleId);
        assert.equal(raceSchedule?.status, 'claimed', 'disable 后 claimed wake 仍须可 consume');
        raceSchedule = { ...raceSchedule, status: 'consumed' };
        raceEvents.push(['consumed', scheduleId]);
        return { status: 'consumed', schedule: raceSchedule };
      },
    },
  },
);

function formalScheduleCallback(hostAIId, scheduleId) {
  return {
    triggerKind: 'ai_schedule',
    source: 'work-manager',
    eventId: scheduleId,
    hostAIId,
    projectionToken: 'revision-1', expectedRemindAtEpochMs: Date.parse('2026-08-30T08:00:00.000Z'),
    createdAtEpochMs: Date.parse('2026-08-30T08:00:05.000Z'),
  };
}

function resetScheduleRace(hostAIId, scheduleId) {
  managedHostAiId = hostAIId;
  raceSchedule = {
    scheduleId,
    ownerAIId: hostAIId,
    remindAt: '2026-08-30T08:00:00.000Z',
    status: 'scheduled',
    claimedByRunId: null,
  };
  claimGate = null;
  autonomousRunGate = null;
  autonomousRunStarted = null;
  claimCalls = 0;
  autonomousRunCalls = 0;
  consumeCalls = 0;
  raceEvents.length = 0;
}

// callback 先取得 authority：claim 完成后让出 lane，后续 revoke 不得撤销行动机会。
resetScheduleRace('host-claim-first', 'wake-claim-first');
claimGate = { started: deferred(), release: deferred() };
autonomousRunGate = deferred();
autonomousRunStarted = deferred();
pendingRevoke = { started: deferred(), release: deferred() };
const claimFirstCallback = headlessSchedule.runHeadlessAISchedule(
  formalScheduleCallback('host-claim-first', 'wake-claim-first'),
);
await claimGate.started.promise;
let claimFirstRevokeEntered = false;
pendingRevoke.started.promise.then(() => { claimFirstRevokeEntered = true; });
const claimFirstRevoke = assistantManagement.revokeHostAIAssistant('host-claim-first');
await Promise.resolve();
assert.equal(claimFirstRevokeEntered, false, 'claim 持有 authority lane 时 revoke 必须等待');
claimGate.release.resolve();
await autonomousRunStarted.promise;
await pendingRevoke.started.promise;
assert.equal(raceSchedule.status, 'claimed');
pendingRevoke.release.resolve();
await claimFirstRevoke;
assert.equal(raceSchedule.status, 'claimed', 'relationship removal 不得 supersede claimed wake');
autonomousRunGate.resolve();
assert.equal((await claimFirstCallback).status, 'ran');
assert.equal(raceSchedule.status, 'consumed');
assert.equal(claimCalls, 1);
assert.equal(autonomousRunCalls, 1);
assert.equal(consumeCalls, 1);

// revoke 先取得 authority：关系移除与 disable 完成后，旧 callback 必须 handled no-op。
resetScheduleRace('host-revoke-first', 'wake-revoke-first');
pendingRevoke = { started: deferred(), release: deferred() };
const revokeFirstMutation = assistantManagement.revokeHostAIAssistant('host-revoke-first');
await pendingRevoke.started.promise;
const revokeFirstCallback = headlessSchedule.runHeadlessAISchedule(
  formalScheduleCallback('host-revoke-first', 'wake-revoke-first'),
);
await Promise.resolve();
assert.equal(claimCalls, 0, 'revoke 持有 authority lane 时旧 callback 不得提前 claim');
pendingRevoke.release.resolve();
await revokeFirstMutation;
assert.deepEqual(await revokeFirstCallback, {
  status: 'ignored',
  reason: 'not_current_host',
});
assert.equal(raceSchedule.status, 'cancelled');
assert.equal(claimCalls, 0);
assert.equal(autonomousRunCalls, 0);
assert.equal(consumeCalls, 0);

// 删除当前 Host 后到达的旧 callback 同样不得 claim 或启动 autonomous run。
resetScheduleRace('host-delete-first', 'wake-delete-first');
await assistantManagement.deleteAIAssistant('host-delete-first');
assert.equal(raceSchedule.status, 'cancelled');
assert.deepEqual(
  await headlessSchedule.runHeadlessAISchedule(
    formalScheduleCallback('host-delete-first', 'wake-delete-first'),
  ),
  { status: 'ignored', reason: 'not_current_host' },
);
assert.equal(claimCalls, 0);
assert.equal(autonomousRunCalls, 0);
assert.equal(consumeCalls, 0);

const hostToolController = new AbortController();
const toolContext = {
  isHostAI: () => true,
  getAIId: () => 'host-a',
  getAgentId: () => 'host-agent-a',
  abortSignal: hostToolController.signal,
};
const targetAssistant = {
  id: 'target-ai',
  agentId: 'target-agent',
  name: '目标 AI',
  isHostAI: false,
};
let activeBlock = null;
let blockWrites = 0;
let unblockWrites = 0;
let lastBlockInput = null;
let abortAfterBlockStateRead = null;
const toolMocks = {
  '@shared/runtime/abortSignal': abortSignalRuntime,
  '../infrastructure/SQLiteAssistantRepository': {
    aiAssistantRepository: { getAll: async () => [targetAssistant] },
  },
  '../infrastructure/SQLiteHostRepository': {
    aiHostRepository: {
      cleanupExpiredBlocks: async () => true,
      isAIBlocked: async () => {
        const result = { isBlocked: activeBlock !== null, blockInfo: activeBlock };
        abortAfterBlockStateRead?.();
        return result;
      },
      blockAI: async (input) => {
        blockWrites += 1;
        lastBlockInput = input;
        activeBlock = { ...input, id: 'block-1' };
        return activeBlock;
      },
      unblockAI: async () => {
        unblockWrites += 1;
        activeBlock = null;
        return true;
      },
    },
  },
  '../AIAssistantManagement': {
    runAsCurrentHostAuthority: async (actorAiId, action) => (
      actorAiId === currentHostAiId
        ? { status: 'authorized', value: await action() }
        : { status: 'not_current_host' }
    ),
  },
};
const blockTool = loadTypeScriptModule(
  'src/features/assistants/aiTools/BlockAIAssistantTool.ts',
  toolMocks,
);
const unblockTool = loadTypeScriptModule(
  'src/features/assistants/aiTools/UnblockAIAssistantTool.ts',
  toolMocks,
);

currentHostAiId = 'host-b';
assert.equal((await blockTool.execute({
  targetAgentId: targetAssistant.agentId,
  durationMinutes: 10,
}, toolContext)).success, false);
assert.equal((await unblockTool.execute({
  targetAgentId: targetAssistant.agentId,
}, toolContext)).success, false);
assert.equal(blockWrites, 0);
assert.equal(unblockWrites, 0);

currentHostAiId = 'host-a';
const abortedBlockController = new AbortController();
abortAfterBlockStateRead = () => abortedBlockController.abort(new Error('block cancelled'));
await assert.rejects(
  () => blockTool.execute({
    targetAgentId: targetAssistant.agentId,
    durationMinutes: 10,
  }, { ...toolContext, abortSignal: abortedBlockController.signal }),
  /block cancelled/u,
  '读取状态后已 abort 的主理工具不得提交 block',
);
assert.equal(blockWrites, 0);
abortAfterBlockStateRead = null;

assert.equal((await blockTool.execute({
  targetAgentId: targetAssistant.agentId,
  durationMinutes: 10,
}, toolContext)).success, true);

const abortedUnblockController = new AbortController();
abortAfterBlockStateRead = () => abortedUnblockController.abort(new Error('unblock superseded'));
await assert.rejects(
  () => unblockTool.execute({
    targetAgentId: targetAssistant.agentId,
  }, { ...toolContext, abortSignal: abortedUnblockController.signal }),
  /unblock superseded/u,
  '读取状态后已 abort 的主理工具不得提交 unblock',
);
assert.equal(unblockWrites, 0);
assert.notEqual(activeBlock, null);
abortAfterBlockStateRead = null;

assert.equal((await unblockTool.execute({
  targetAgentId: targetAssistant.agentId,
}, toolContext)).success, true);
assert.equal(blockWrites, 1);
assert.equal(lastBlockInput.blockedByAIId, 'host-a', 'actor 必须来自可信 ToolContext');
assert.equal(unblockWrites, 1);

console.log('Host authority coordinator verification passed.');
