/** LISTEN-7 收尾：Together 通知 open/leave 的导航语义与 canonical leave 可靠性行为验证。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-actions-'));

function compileProductionModule(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(errors.length, 0, `TypeScript 转译失败：${relativePath}`);
  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function writeRuntimeModule(relativePath, source) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, 'utf8');
}

function loadCompiled(relativePath) {
  return require(path.join(tempRoot, relativePath.replace(/\.ts$/, '.js')));
}

// 本项验证通知目标与退出事实，不执行导航容器动作。
writeRuntimeModule('node_modules/@react-navigation/native/index.js', 'exports.CommonActions = {};');

writeRuntimeModule('node_modules/@shared/runtime/RuntimeSlot.js', `
exports.createRuntimeSlot = (name) => {
  let value = null;
  return {
    configure(nextValue) { value = nextValue; },
    get() {
      if (value === null) throw new Error(name + ' 运行时依赖尚未完成装配');
      return value;
    },
  };
};
`);

writeRuntimeModule('node_modules/@platform/persistence/index.js', `
Object.defineProperty(exports, 'databaseCoordinator', {
  enumerable: true,
  get: () => globalThis.__togetherListeningActionsCoordinator,
});
`);

for (const relativePath of [
  'src/features/togetherListening/domain/TogetherListeningActivity.ts',
  'src/features/togetherListening/domain/TogetherListeningRepository.ts',
  'src/features/togetherListening/application/TogetherListeningRuntime.ts',
  'src/features/togetherListening/application/TogetherListeningChangedSignal.ts',
  'src/features/togetherListening/application/TogetherListeningSystemPresentation.ts',
  'src/features/togetherListening/application/TogetherListeningLifecycle.ts',
  'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts',
  'src/features/togetherListening/application/LeaveTogetherListeningByUser.ts',
  'src/features/togetherListening/infrastructure/SQLiteTogetherListeningRepository.ts',
  'src/platform/persistence/sqlite/togetherListeningSchema.ts',
  'src/host/navigation/externalNavigation.ts',
]) {
  compileProductionModule(relativePath);
}

// --- repeated notification open：Together ongoing surface 不得被一次性去重 ---
const navigation = loadCompiled('src/host/navigation/externalNavigation.ts');

// 与 Host queueExternalNavigation 相同的去重门：只拦截一次性事件。
function createQueueGate() {
  const handledKeys = new Set();
  return (target) => {
    if (!target) return false;
    const key = navigation.getExternalNavigationKey(target);
    if (navigation.isOneShotExternalNavigationTarget(target)) {
      if (handledKeys.has(key)) return false;
      handledKeys.add(key);
    }
    return true;
  };
}

const togetherOpenA = () => navigation.createTogetherListeningNavigationTarget({
  activityId: 'activity-a',
  aiId: 'host-a',
  sessionId: 'chat-a',
  notificationAction: 'open',
  notificationId: 'together-listening-live',
});

const openGate = createQueueGate();
assert.equal(openGate(togetherOpenA()), true, 'Activity A 首次 open 必须允许');
assert.equal(openGate(togetherOpenA()), true, '同一 ongoing surface 重复点击必须仍然允许');
assert.equal(openGate(togetherOpenA()), true, '离开聊天后再次点击同一条通知必须仍然允许');
assert.equal(
  openGate(navigation.createTogetherListeningNavigationTarget({
    activityId: 'activity-b',
    aiId: 'host-a',
    sessionId: 'chat-a',
    notificationAction: 'open',
    notificationId: 'together-listening-live',
  })),
  true,
  '同 AI/会话的后续新 Activity B 必须允许 open',
);
assert.notEqual(
  navigation.getExternalNavigationKey(togetherOpenA()),
  navigation.getExternalNavigationKey(navigation.createTogetherListeningNavigationTarget({
    activityId: 'activity-b', aiId: 'host-a', sessionId: 'chat-a', notificationAction: 'open',
  })),
  'A 与 B 的导航 key 必须可区分',
);

// message / call 原有 dedupe 语义不得改变。
const messageGate = createQueueGate();
const messageEvent = () => navigation.createMessageNavigationTarget({
  aiId: 'host-a', sessionId: 'chat-a', notificationId: 'kimiphone-msg-ai:host-a-event-1',
});
assert.equal(messageGate(messageEvent()), true);
assert.equal(messageGate(messageEvent()), false, '带 notificationId 的 message 事件仍按一次性去重');
const callGate = createQueueGate();
const callEvent = () => navigation.createCallNavigationTarget({
  aiId: 'host-a', sessionId: 'chat-a', callId: 'call-1', notificationAction: 'reject',
});
assert.equal(callGate(callEvent()), true);
assert.equal(callGate(callEvent()), false, 'call action 仍按一次性去重');

assert.equal(
  navigation.createTogetherListeningNavigationTarget({ activityId: '', aiId: 'host-a', sessionId: 'chat-a' }),
  null,
  '缺 activityId 的 Together payload 必须被拒绝',
);

// --- canonical leave：foreground / recovered / stale 语义 ---
function createExecutor(sqlite) {
  return {
    async execAsync(source) { sqlite.exec(source); },
    async runAsync(source, params = []) {
      const result = sqlite.prepare(source).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getFirstAsync(source, params = []) { return sqlite.prepare(source).get(...params) ?? null; },
    async getAllAsync(source, params = []) { return sqlite.prepare(source).all(...params); },
  };
}

const sqlite = new DatabaseSync(':memory:');
const schema = loadCompiled('src/platform/persistence/sqlite/togetherListeningSchema.ts');
sqlite.exec(schema.TOGETHER_LISTENING_ACTIVITIES_SCHEMA);
sqlite.exec(schema.TOGETHER_LISTENING_SINGLE_CURRENT_INDEX);
sqlite.exec(schema.TOGETHER_LISTENING_CHAT_CREATED_INDEX);
sqlite.exec(schema.TOGETHER_LISTENING_HOST_CREATED_INDEX);
{
  const executor = createExecutor(sqlite);
  let tail = Promise.resolve();
  globalThis.__togetherListeningActionsCoordinator = {
    openTaskExecutor() {
      return {
        getFirstAsync: (sql, params) => schedule(() => executor.getFirstAsync(sql, params)),
        getAllAsync: (sql, params) => schedule(() => executor.getAllAsync(sql, params)),
        runAsync: (sql, params) => schedule(() => executor.runAsync(sql, params)),
        execAsync: (sql) => schedule(() => executor.execAsync(sql)),
        withExclusiveTransactionAsync: (task) => schedule(async () => {
          sqlite.exec('BEGIN EXCLUSIVE');
          try {
            const value = await task(executor);
            sqlite.exec('COMMIT');
            return value;
          } catch (error) {
            sqlite.exec('ROLLBACK');
            throw error;
          }
        }),
      };
    },
  };
  function schedule(task) {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  }
}

const lifecycle = loadCompiled('src/features/togetherListening/application/TogetherListeningLifecycle.ts');
const leaveByUser = loadCompiled('src/features/togetherListening/application/LeaveTogetherListeningByUser.ts');
const {
  configureTogetherListeningRuntimeDependencies,
} = loadCompiled('src/features/togetherListening/application/TogetherListeningRuntime.ts');
const {
  SQLiteTogetherListeningRepository,
} = loadCompiled('src/features/togetherListening/infrastructure/SQLiteTogetherListeningRepository.ts');

let nowEpochMs = 1_800_000_000_000;
let idSequence = 0;
const repository = new SQLiteTogetherListeningRepository();
configureTogetherListeningRuntimeDependencies({
  repository,
  chat: { projectActivityToChat: async () => {} },
  systemPresentation: {
    upsertActivePresentation: async () => {},
    cancelPresentation: async () => {},
  },
  declineFollowUp: {},
  generateId: () => `activity-${++idSequence}`,
  nowEpochMs: () => ++nowEpochMs,
  observeNetEasePlayback: async () => ({
    status: 'snapshot_available',
    playbackState: 'playing',
    mediaId: 'media-1',
    title: 'Song',
    artist: null,
    album: null,
  }),
  getCurrentHostAIId: async () => 'host-a',
  resolveSystemPresentationAIIdentity: async () => ({ name: 'Host', avatar: null }),
});

try {
  async function createActiveActivity() {
    const created = await lifecycle.createUserTogetherListeningInvitation({
      hostAiId: 'host-a',
      chatSessionId: 'chat-a',
    });
    assert.equal(created.status, 'created');
    const accepted = await lifecycle.acceptTogetherListeningInvitationByAI(created.activity.id);
    assert.equal(accepted.status, 'transitioned');
    return accepted.activity;
  }

  // foreground leave：前台 observer 在线时 Host 执行 canonical leave。
  const activityA = await createActiveActivity();
  const foregroundLeave = await leaveByUser.leaveTogetherListeningByUser({
    activityId: activityA.id,
    source: 'system_capsule',
  });
  assert.equal(foregroundLeave.status, 'left');
  assert.equal((await repository.getById(activityA.id)).endReason, 'user_left');

  // recovered leave：Headless 已成功后的 pending 重放只是幂等 no-op。
  const replayedLeave = await leaveByUser.leaveTogetherListeningByUser({
    activityId: activityA.id,
    source: 'system_capsule',
  });
  assert.equal(replayedLeave.status, 'activity_not_current', '已终态 Activity 的重放必须幂等 no-op');

  // stale leave：旧 Activity A 的 pending leave 不得误伤当前 Activity B。
  const activityB = await createActiveActivity();
  assert.equal(activityB.hostAiId, activityA.hostAiId);
  assert.equal(activityB.chatSessionId, activityA.chatSessionId);
  const staleLeave = await leaveByUser.leaveTogetherListeningByUser({
    activityId: activityA.id,
    source: 'system_capsule',
  });
  assert.equal(staleLeave.status, 'activity_not_current');
  assert.equal((await repository.getById(activityB.id)).phase, 'active', '旧 leave 响应不得结束新 Activity');

  console.log('Together 通知 repeated open 与 canonical leave 行为检查通过。');
} finally {
  sqlite.close();
  delete globalThis.__togetherListeningActionsCoordinator;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
