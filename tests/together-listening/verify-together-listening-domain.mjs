/** Together Listening 领域、application lifecycle 与真实 SQLite 仓储行为验证。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-'));

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
  assert.equal(
    errors.length,
    0,
    `TypeScript 转译失败：${relativePath}\n${errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n')}`,
  );
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
  get: () => globalThis.__togetherListeningCoordinator,
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
  'src/features/togetherListening/infrastructure/SQLiteTogetherListeningRepository.ts',
  'src/platform/persistence/sqlite/togetherListeningSchema.ts',
]) {
  compileProductionModule(relativePath);
}

function createExecutor(sqlite) {
  return {
    async execAsync(source) {
      sqlite.exec(source);
    },
    async runAsync(source, params = []) {
      const result = sqlite.prepare(source).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    async getFirstAsync(source, params = []) {
      return sqlite.prepare(source).get(...params) ?? null;
    },
    async getAllAsync(source, params = []) {
      return sqlite.prepare(source).all(...params);
    },
  };
}

function createCoordinator(sqlite) {
  const executor = createExecutor(sqlite);
  let tail = Promise.resolve();
  let transactionCount = 0;
  const schedule = (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
  const coordinator = {
    openTaskExecutor() {
      return {
        getFirstAsync: (sql, params) => schedule(() => executor.getFirstAsync(sql, params)),
        getAllAsync: (sql, params) => schedule(() => executor.getAllAsync(sql, params)),
        runAsync: (sql, params) => schedule(() => executor.runAsync(sql, params)),
        execAsync: (sql) => schedule(() => executor.execAsync(sql)),
        withExclusiveTransactionAsync: (task) => schedule(async () => {
          transactionCount += 1;
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
    get transactionCount() {
      return transactionCount;
    },
  };
  return coordinator;
}

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const schema = loadCompiled('src/platform/persistence/sqlite/togetherListeningSchema.ts');
  sqlite.exec(schema.TOGETHER_LISTENING_ACTIVITIES_SCHEMA);
  sqlite.exec(schema.TOGETHER_LISTENING_SINGLE_CURRENT_INDEX);
  sqlite.exec(schema.TOGETHER_LISTENING_CHAT_CREATED_INDEX);
  sqlite.exec(schema.TOGETHER_LISTENING_HOST_CREATED_INDEX);
  return sqlite;
}

const sqlite = createDatabase();
const coordinator = createCoordinator(sqlite);
globalThis.__togetherListeningCoordinator = coordinator;

const {
  SQLiteTogetherListeningRepository,
} = loadCompiled(
  'src/features/togetherListening/infrastructure/SQLiteTogetherListeningRepository.ts',
);
const lifecycle = loadCompiled(
  'src/features/togetherListening/application/TogetherListeningLifecycle.ts',
);
const runtimeAwareness = loadCompiled(
  'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts',
);
const {
  configureTogetherListeningRuntimeDependencies,
} = loadCompiled('src/features/togetherListening/application/TogetherListeningRuntime.ts');
const domain = loadCompiled(
  'src/features/togetherListening/domain/TogetherListeningActivity.ts',
);

let nowEpochMs = 1_800_000_000_000;
let idSequence = 0;
const repository = new SQLiteTogetherListeningRepository();
const systemUpserts = [];
const systemCancels = [];
let systemProjectionFails = false;
configureTogetherListeningRuntimeDependencies({
  repository,
  chat: { projectActivityToChat: async () => {} },
  systemPresentation: {
    upsertActivePresentation: async (state) => {
      if (systemProjectionFails) throw new Error('native projection failed');
      systemUpserts.push(state);
    },
    cancelPresentation: async (activityId) => {
      if (systemProjectionFails) throw new Error('native projection failed');
      systemCancels.push(activityId ?? null);
    },
  },
  declineFollowUp: {},
  generateId: () => `activity-${++idSequence}`,
  nowEpochMs: () => ++nowEpochMs,
  // 默认观测到网易云正在播放：冷启动 reconcile 只在明确媒体终态/Host 权威丢失时收口。
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

function countCurrent() {
  return Number(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM together_listening_activities
    WHERE phase IN ('pending_user_response', 'pending_ai_response', 'active')
  `).get().count);
}

function identityOf(activity) {
  return {
    id: activity.id,
    hostAiId: activity.hostAiId,
    chatSessionId: activity.chatSessionId,
    initiator: activity.initiator,
    createdAtEpochMs: activity.createdAtEpochMs,
  };
}

try {
  assert.equal(domain.isTogetherListeningNonTerminalPhase('active'), true);
  assert.equal(domain.isTogetherListeningTerminalPhase('declined_by_ai'), true);

  const userInvitation = await lifecycle.createUserTogetherListeningInvitation({
    hostAiId: 'host-a',
    chatSessionId: 'chat-a',
  });
  assert.equal(userInvitation.status, 'created');
  assert.equal(userInvitation.activity.initiator, 'user');
  assert.equal(userInvitation.activity.phase, 'pending_ai_response');
  assert.equal(userInvitation.activity.activatedAtEpochMs, null);
  assert.equal(userInvitation.activity.endedAtEpochMs, null);
  assert.equal(userInvitation.activity.endReason, null);
  assert.equal(systemCancels.at(-1), null, 'pending 必须清理任意 stale system surface');

  const conflictingPending = await lifecycle.createAITogetherListeningInvitation({
    hostAiId: 'host-b',
    chatSessionId: 'chat-b',
  });
  assert.equal(conflictingPending.status, 'non_terminal_activity_exists');
  assert.equal(countCurrent(), 1);

  const invalidUserAccept = await lifecycle.acceptTogetherListeningInvitationByUser(
    userInvitation.activity.id,
  );
  assert.equal(invalidUserAccept.status, 'invalid_phase');
  assert.equal((await repository.getById(userInvitation.activity.id)).phase, 'pending_ai_response');

  const acceptedByAI = await lifecycle.acceptTogetherListeningInvitationByAI(
    userInvitation.activity.id,
  );
  assert.equal(acceptedByAI.status, 'transitioned');
  assert.equal(acceptedByAI.activity.phase, 'active');
  assert.ok(acceptedByAI.activity.activatedAtEpochMs !== null);
  assert.deepEqual(identityOf(acceptedByAI.activity), identityOf(userInvitation.activity));
  assert.equal(systemUpserts.at(-1).activityId, userInvitation.activity.id);
  assert.equal(systemUpserts.at(-1).activatedAtEpochMs, acceptedByAI.activity.activatedAtEpochMs);

  const conflictingActive = await lifecycle.createAITogetherListeningInvitation({
    hostAiId: 'host-b',
    chatSessionId: 'chat-b',
  });
  assert.equal(conflictingActive.status, 'non_terminal_activity_exists');
  assert.equal(countCurrent(), 1);

  const lateAIReject = await lifecycle.declineTogetherListeningInvitationByAI(
    userInvitation.activity.id,
  );
  assert.equal(lateAIReject.status, 'transition_conflict');
  assert.equal(lateAIReject.activity.phase, 'active');

  const userLeft = await lifecycle.leaveTogetherListeningActivityByUser(
    userInvitation.activity.id,
  );
  assert.equal(userLeft.status, 'transitioned');
  assert.equal(userLeft.activity.phase, 'ended');
  assert.equal(userLeft.activity.endReason, 'user_left');
  assert.ok(userLeft.activity.endedAtEpochMs !== null);
  assert.deepEqual(identityOf(userLeft.activity), identityOf(userInvitation.activity));
  assert.equal(systemCancels.at(-1), userInvitation.activity.id, 'ended 必须 cancel system surface');

  const aiInvitation = await lifecycle.createAITogetherListeningInvitation({
    hostAiId: 'host-b',
    chatSessionId: 'chat-b',
  });
  assert.equal(aiInvitation.status, 'created');
  assert.equal(aiInvitation.activity.phase, 'pending_user_response');
  const declinedByUser = await lifecycle.declineTogetherListeningInvitationByUser(
    aiInvitation.activity.id,
  );
  assert.equal(declinedByUser.status, 'transitioned');
  assert.equal(declinedByUser.activity.phase, 'declined_by_user');
  assert.equal(declinedByUser.activity.endReason, null);

  const aiInvitationAccepted = await lifecycle.createAITogetherListeningInvitation({
    hostAiId: 'host-c',
    chatSessionId: 'chat-c',
  });
  const acceptedByUser = await lifecycle.acceptTogetherListeningInvitationByUser(
    aiInvitationAccepted.activity.id,
  );
  assert.equal(acceptedByUser.activity.phase, 'active');
  const aiLeft = await lifecycle.leaveTogetherListeningActivityByAI(
    aiInvitationAccepted.activity.id,
  );
  assert.equal(aiLeft.activity.endReason, 'ai_left');

  const userInvitationDeclined = await lifecycle.createUserTogetherListeningInvitation({
    hostAiId: 'host-d',
    chatSessionId: 'chat-d',
  });
  const declinedByAI = await lifecycle.declineTogetherListeningInvitationByAI(
    userInvitationDeclined.activity.id,
  );
  assert.equal(declinedByAI.activity.phase, 'declined_by_ai');

  const forcedPending = await lifecycle.createAITogetherListeningInvitation({
    hostAiId: 'host-e',
    chatSessionId: 'chat-e',
  });
  const mediaEnded = await lifecycle.endTogetherListeningActivity({
    activityId: forcedPending.activity.id,
    reason: 'media_unavailable',
  });
  assert.equal(mediaEnded.activity.endReason, 'media_unavailable');

  const forcedActive = await lifecycle.createAITogetherListeningInvitation({
    hostAiId: 'host-f',
    chatSessionId: 'chat-f',
  });
  systemProjectionFails = true;
  await lifecycle.acceptTogetherListeningInvitationByUser(forcedActive.activity.id);
  assert.equal(
    (await repository.getById(forcedActive.activity.id)).phase,
    'active',
    'system projection failure 不得回滚 Activity truth',
  );
  systemProjectionFails = false;
  const authorityEnded = await lifecycle.endTogetherListeningActivity({
    activityId: forcedActive.activity.id,
    reason: 'host_authority_lost',
  });
  assert.equal(authorityEnded.activity.endReason, 'host_authority_lost');
  const lateLeave = await lifecycle.leaveTogetherListeningActivityByUser(
    forcedActive.activity.id,
  );
  assert.equal(lateLeave.status, 'already_terminal');
  assert.equal(lateLeave.activity.endReason, 'host_authority_lost');
  const cannotRevive = await lifecycle.acceptTogetherListeningInvitationByUser(
    forcedActive.activity.id,
  );
  assert.equal(cannotRevive.status, 'already_terminal');

  const restartPending = await lifecycle.createAITogetherListeningInvitation({
    hostAiId: 'host-a',
    chatSessionId: 'chat-restart',
  });
  const repositoryAfterRestart = new SQLiteTogetherListeningRepository();
  assert.deepEqual(await repositoryAfterRestart.getCurrent(), restartPending.activity);
  await lifecycle.acceptTogetherListeningInvitationByUser(restartPending.activity.id);
  assert.equal((await repositoryAfterRestart.getCurrent()).phase, 'active');
  await runtimeAwareness.reconcileTogetherListeningSystemPresentation();
  assert.equal(systemUpserts.at(-1).activityId, restartPending.activity.id, '启动恢复 active 必须 ensure');

  const restartEnded = await lifecycle.endTogetherListeningActivity({
    activityId: restartPending.activity.id,
    reason: 'runtime_reconciliation',
  });
  assert.equal(restartEnded.status, 'transitioned');
  assert.equal(countCurrent(), 0);
  await runtimeAwareness.reconcileTogetherListeningSystemPresentation();
  assert.equal(systemCancels.at(-1), null, '启动恢复 idle 必须清理 stale presentation');
  assert.equal(
    (await lifecycle.getTogetherListeningActivityById('missing-activity')),
    null,
  );
  assert.deepEqual(
    await lifecycle.leaveTogetherListeningActivityByUser('missing-activity'),
    { status: 'activity_not_found' },
  );

  const directDatabase = createDatabase();
  const insert = directDatabase.prepare(`
    INSERT INTO together_listening_activities (
      id, host_ai_id, chat_session_id, initiator, phase,
      created_at_epoch_ms, updated_at_epoch_ms, activated_at_epoch_ms,
      ended_at_epoch_ms, end_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `);
  insert.run('direct-1', 'host', 'chat', 'user', 'pending_ai_response', 1, 1);
  assert.throws(
    () => insert.run('direct-2', 'host', 'chat', 'ai', 'pending_user_response', 2, 2),
    /UNIQUE constraint failed/,
  );
  directDatabase.close();

  const migrationDatabase = new DatabaseSync(':memory:');
  const schema = loadCompiled('src/platform/persistence/sqlite/togetherListeningSchema.ts');
  migrationDatabase.exec('CREATE TABLE existing_user_data (id TEXT PRIMARY KEY);');
  migrationDatabase.exec("INSERT INTO existing_user_data (id) VALUES ('preserved');");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await schema.migrateTogetherListeningActivity(createExecutor(migrationDatabase));
  }
  assert.equal(
    migrationDatabase.prepare('SELECT id FROM existing_user_data').get().id,
    'preserved',
    'migration 重复执行不得删除已有用户数据',
  );
  migrationDatabase.close();

  assert.ok(coordinator.transactionCount >= 10, 'create 与 CAS transition 必须进入独占事务');
  console.log('Together Listening 领域与 SQLite 生命周期检查通过。');
} finally {
  sqlite.close();
  delete globalThis.__togetherListeningCoordinator;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
