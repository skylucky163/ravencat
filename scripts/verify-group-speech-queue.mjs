/**
 * Phase 3C 群发言持久动态队列的真实行为验证：
 * - 迁移61 将历史 'mention' 任务来源升级为 'user_mention'；
 * - 持久队列逐项 CAS claim：顺序、并发唯一 winner、plan 终态后不再 claim；
 * - 事务内裁决 AI @ AI 的调度后果：future-turn coverage、自身目标屏蔽、顺序
 *   接续与来源事实保留（plan 资格由提交接缝 fence 裁决，见
 *   verify-group-speech-supersede.mjs）；
 * - assistant 提交 fence：plan active 且任务 running 才有落库资格；
 * - 执行器串行执行动态队列：AI 递归 @ 追加的任务被继续 claim，blocked/用户
 *   目标不追加，单成员失败标 failed 后继续下一项，fence 拒绝不覆盖终态。
 */

import { SCHEMAS } from './helpers/sqlite-bootstrap-fixture.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

function createExecutor(db) {
  return {
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    getFirstAsync: async (sql, params = []) => (
      db.prepare(sql).get(...params) ?? null
    ),
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  };
}

function createCoordinator(db) {
  const executor = createExecutor(db);
  let tail = Promise.resolve();

  const schedule = (task) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };

  const coordinator = {
    transaction(_meta, task) {
      return schedule(async () => {
        db.exec('BEGIN');
        try {
          const value = await task(executor);
          db.exec('COMMIT');
          return value;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // 保留原始事务错误。
          }
          throw error;
        }
      });
    },
    openTaskExecutor() {
      return {
        getFirstAsync: (sql, params = []) => schedule(() => executor.getFirstAsync(sql, params)),
        getAllAsync: (sql, params = []) => schedule(() => executor.getAllAsync(sql, params)),
        runAsync: (sql, params = []) => schedule(() => executor.runAsync(sql, params)),
        execAsync: (sql) => schedule(() => executor.execAsync(sql)),
        withExclusiveTransactionAsync: (task) => coordinator.transaction({ name: 'test' }, task),
        withExclusiveWriteScopeAsync: (task) => schedule(() => task(executor)),
      };
    },
  };

  return coordinator;
}

function createSpeechPlanDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE group_speech_plans (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      status TEXT NOT NULL,
      invoked_user_message_ids_json TEXT,
      last_included_message_id INTEGER,
      supersedes_plan_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE group_speech_tasks (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      sequence_order INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      visible_reply_committed INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata_json TEXT
    );
    CREATE TABLE group_chats (id TEXT PRIMARY KEY, last_message TEXT, last_time TEXT, last_message_id INTEGER, updated_at TEXT);
  `);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(SCHEMAS.groupChatMembers);
  for (const id of [...'123456789ABCDEFGH'.split('').map(letter => `ai-${letter}`)]) {
    db.prepare(`INSERT INTO group_chat_members (id, group_id, ai_assistant_id, agent_id, enabled, created_at, updated_at)
      VALUES (?, 'g1', ?, ?, 1, '2026-08-01', '2026-08-01')`).run(`fixture-${id}`, id, `agent-${id.slice(3)}`);
  }
  return db;
}

function insertPlan(db, input) {
  db.prepare(`
    INSERT INTO group_speech_plans (
      id, group_id, status, invoked_user_message_ids_json, last_included_message_id,
      started_at, completed_at, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, '[]', NULL, ?, NULL, NULL, ?, ?)
  `).run(
    input.id,
    input.groupId,
    input.status,
    input.startedAt || input.createdAt,
    input.createdAt,
    input.updatedAt || input.createdAt,
  );
}

function insertTask(db, input) {
  db.prepare(`
    INSERT INTO group_speech_tasks (
      id, plan_id, group_id, ai_assistant_id, agent_id, sequence_order, source,
      status, started_at, completed_at, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
  `).run(
    input.id,
    input.planId,
    input.groupId,
    input.aiAssistantId,
    input.agentId,
    input.sequenceOrder,
    input.source,
    input.status || 'queued',
    input.createdAt,
    input.createdAt,
  );
}

function listTasks(db, planId) {
  return db.prepare(
    `SELECT id, ai_assistant_id AS aiAssistantId, sequence_order AS sequenceOrder,
            source, status, error_message AS errorMessage
     FROM group_speech_tasks
     WHERE plan_id = ?
     ORDER BY sequence_order ASC`,
  ).all(planId);
}

async function loadGroupChatRepository() {
  const mediaUrl = transpileToModuleUrl(`
    export async function resolveMediaAssetReferenceUri(reference) {
      return reference.mediaAssetId
        ? \`asset://\${reference.mediaAssetId}\`
        : reference.legacyUri;
    }
    // 删除事务内的引用候选收集：本 verifier 只覆盖发言队列，不构造媒体引用事实。
    export async function collectChatSessionMediaAssetCandidatesInTransaction() {
      return [];
    }
  `);
  const persistenceUrl = transpileToModuleUrl(
    `export const databaseCoordinator = {
      transaction(...args) {
        return globalThis.__GROUP_QUEUE_COORDINATOR__.transaction(...args);
      },
      openTaskExecutor(...args) {
        return globalThis.__GROUP_QUEUE_COORDINATOR__.openTaskExecutor(...args);
      },
    };`,
  );
  const domainUrl = transpileToModuleUrl(
    read('src/features/chat/group/domain/GroupChat.ts'),
  );
  const repositorySource = read(
    'src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts',
  )
    .replace(/from ['"]@features\/assistants['"]/g,
      `from '${transpileToModuleUrl(`
        export function bindModelServiceInTransaction() { throw new Error('队列验证不应修改模型服务'); }
        export function readModelServiceConnection() { throw new Error('队列验证不应读取模型服务'); }
        export function getModelServiceConnection() { throw new Error('队列验证不应解析模型服务'); }
      `)}'`)
    .replace(/from ['"]@features\/profile['"]/g,
      `from '${transpileToModuleUrl('export async function removeConversationWallpaperInTransaction() {}')}'`)
    .replace(/from ['"]@features\/media['"]/g, `from '${mediaUrl}'`)
    .replace(/from ['"]@platform\/persistence['"]/g, `from '${persistenceUrl}'`)
    .replace(/from ['"]\.\.\/domain\/GroupChat['"]/g, `from '${domainUrl}'`)
    .replace(
      /from ['"]\.\.\/domain\/GroupChatRepository['"]/g,
      `from '${transpileToModuleUrl(read('src/features/chat/group/domain/GroupChatRepository.ts'))}'`,
    );
  return import(transpileToModuleUrl(repositorySource));
}

function loadGroupRuntimeStub() {
  return transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__GROUP_QUEUE_GROUP_DEPS__;
    }
  `);
}

async function buildGroupTurnCommitUrl(groupRuntimeUrl) {
  // 队列测试消费真实群 timeline 提交端口；消息插入与 mention 后果共享 fence。
  const persistenceUrl = transpileToModuleUrl(`
    export const databaseCoordinator = {
      transaction(...args) {
        return globalThis.__GROUP_QUEUE_COORDINATOR__.transaction(...args);
      },
      openTaskExecutor(...args) {
        return globalThis.__GROUP_QUEUE_COORDINATOR__.openTaskExecutor(...args);
      },
    };
  `);
  // 最小 messages 仓储桩：事务内插入 messages 表。
  const commitMessageRuntimeUrl = transpileToModuleUrl(`
    export function getChatMessageRuntimeDependencies() {
      return {
        messages: {
          async commitMessageInTransaction(transaction, { message }) {
            if (message.text === globalThis.__GROUP_QUEUE_STATE__?.failCommitText) {
              throw new Error('后续气泡提交失败');
            }
            const result = await transaction.runAsync(
              'INSERT INTO messages (session_id, text, metadata_json) VALUES (?, ?, ?)',
              [message.sessionId, message.text, message.metadataJson ?? null],
            );
            return { ...message, id: Number(result.lastInsertRowId), createdAt: '2026-08-14T11:00:00.000Z' };
          },
        },
      };
    }
  `);
  const abortUrl = transpileToModuleUrl(
    read('src/features/chat/reply/application/ChatReplyAbort.ts'),
  );
  const parserUrl = transpileToModuleUrl(
    read('src/features/chat/group/application/GroupMessageMentionParser.ts'),
  );
  const appendSource = read('src/features/chat/group/application/GroupSpeechTaskAppend.ts')
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`);
  const appendUrl = transpileToModuleUrl(appendSource);
  const source = read('src/features/chat/group/application/GroupAssistantTurnCommit.ts')
    .replace(/from ['"]\.\.\/\.\.\/messages\/domain\/chatMessageMetadata['"]/g,
      `from '${transpileToModuleUrl(`export function buildSessionPreviewTextFromMessage(message) { return message.text; }`)}'`)
    .replace(/from ['"]\.\.\/\.\.\/reply\/application\/CommittedAssistantSegmentDelivery['"]/g,
      `from '${transpileToModuleUrl(`export async function deliverCommittedAssistantSegment() {}`)}'`)
    .replace(/from ['"]@platform\/persistence['"]/g, `from '${persistenceUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/application\/ChatMessageRuntime['"]/g,
      `from '${commitMessageRuntimeUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/reply\/application\/ChatReplyAbort['"]/g,
      `from '${abortUrl}'`,
    )
    .replace(/from ['"]\.\/GroupMessageMentionParser['"]/g, `from '${parserUrl}'`)
    .replace(/from ['"]\.\/GroupSpeechTaskAppend['"]/g, `from '${appendUrl}'`)
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`);
  return transpileToModuleUrl(source);
}

async function loadGroupTaskExecution(groupRuntimeUrl, turnCommitUrl) {
  const metadataUrl = transpileToModuleUrl(`
    export function getMessageAttachments() { return []; }
  `);
  const messageRuntimeUrl = transpileToModuleUrl(`
    export function getChatMessageRuntimeDependencies() {
      return { messages: {} };
    }
  `);
  const eventsUrl = transpileToModuleUrl(`
    export function emitChatMessagesUpdated() {}
  `);
  const processAIReplyUrl = transpileToModuleUrl(`
    export async function processAIReply(
      _sessionId, _userText, aiConfig, _userMessageId, _repo,
      callbacks, runtimeContext, persistence,
    ) {
      const state = globalThis.__GROUP_QUEUE_STATE__;
      state.executions.push(aiConfig.id);
      state.thinkingSettings ??= [];
      state.thinkingSettings.push([aiConfig.id, aiConfig.disableThinking]);
      const scripts = state.replyScripts[aiConfig.id] || [{ text: '好的。' }];
      const script = scripts.length > 1 ? scripts.shift() : scripts[0];
      persistence.observeRunEvent?.({ type: 'run_completed', result: {
        steps: [{ modelTurn: { finishReason: script.finishReason ?? 'stop' } }],
      } });
      try {
        if (script.beforeCommit) {
          script.beforeCommit();
        }
        if (script.fail) {
          // 与真实 processAIReply 一致：失败原因经统一映射后通过失败回调暴露，
          // 可见错误消息由回复层自行落库。
          callbacks?.onReplyFailed?.({ status: 'failed', error: script.failMessage });
          return;
        }
        const result = await persistence.commitAgentTimeline({
          items: [
            ...(script.reasoningText ? [{ message: { sessionId: _sessionId, text: script.reasoningText,
              senderType: 'reasoning', metadataJson: JSON.stringify({ groupChat: {} }) } }] : []),
            ...(script.segments ?? (script.text ? [script.text] : [])).map((text) => ({
              message: { sessionId: _sessionId, text, senderType: 'assistant',
                metadataJson: JSON.stringify({ groupChat: {} }) },
            })),
          ], repository: _repo,
          runtimeContext, callbacks, aiConfig,
        });
        for (const message of result.messages.filter((message) => message.senderType === 'assistant')) {
          state.commits.push({ text: message.text, mentions: JSON.parse(message.metadataJson).groupChat.mentions });
          state.observePreview?.(message.text);
        }
      } catch (error) {
        // 与真实 processAIReply 一致：取消错误安静收尾，不写错误消息。
        if (error && error.name === 'ChatReplyRunCancelledError') {
          return;
        }
        throw error;
      }
    }
  `);
  const directoryUrl = transpileToModuleUrl(`
    export async function getGroupParticipantDirectory() {
      return globalThis.__GROUP_QUEUE_DIRECTORY__;
    }
  `);
  const source = read('src/features/chat/group/application/GroupSpeechTaskExecution.ts')
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/domain\/chatMessageMetadata['"]/g,
      `from '${metadataUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/application\/ChatMessageRuntime['"]/g,
      `from '${messageRuntimeUrl}'`,
    )
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/events\/ChatEvents['"]/g,
      `from '${eventsUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/reply\/application\/ProcessAIReply['"]/g,
      `from '${processAIReplyUrl}'`,
    )
    .replace(/from ['"]\.\/GroupAssistantTurnCommit['"]/g, `from '${turnCommitUrl}'`)
    .replace(
      /from ['"]\.\/GroupSpeechExecutionAbort['"]/g,
      `from '${transpileToModuleUrl(read('src/features/chat/group/application/GroupSpeechExecutionAbort.ts'))}'`,
    )
    .replace(/from ['"]\.\/GroupParticipantDirectory['"]/g, `from '${directoryUrl}'`);
  return import(transpileToModuleUrl(source));
}

async function verifyPersistentQueueRepository(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  globalThis.__GROUP_QUEUE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();
  const now = '2026-08-14T10:00:00.000Z';
  insertPlan(db, { id: 'p1', groupId: 'g1', status: 'running', createdAt: now });
  insertTask(db, {
    id: 't1', planId: 'p1', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-A',
    sequenceOrder: 0, source: 'user_mention', createdAt: now,
  });
  insertTask(db, {
    id: 't2', planId: 'p1', groupId: 'g1', aiAssistantId: 'ai-B', agentId: 'agent-B',
    sequenceOrder: 1, source: 'admin', createdAt: now,
  });
  insertTask(db, {
    id: 't3', planId: 'p1', groupId: 'g1', aiAssistantId: 'ai-C', agentId: 'agent-C',
    sequenceOrder: 2, source: 'admin', status: 'completed', createdAt: now,
  });

  const first = await repository.claimNextQueuedSpeechTask('p1');
  assert.equal(first.id, 't1', 'claim 必须按队列顺序取出第一条 queued 任务');
  assert.equal(first.status, 'running');
  assert.ok(first.startedAt, 'claim 必须记录开始时间');

  const [claimA, claimB] = await Promise.all([
    repository.claimNextQueuedSpeechTask('p1'),
    repository.claimNextQueuedSpeechTask('p1'),
  ]);
  const winners = [claimA, claimB].filter(Boolean);
  assert.equal(winners.length, 1, '并发 claim 同一条任务只能有一个 winner');
  assert.equal(winners[0].id, 't2');

  assert.equal(
    await repository.claimNextQueuedSpeechTask('p1'),
    null,
    '非 queued 任务不得被重复 claim',
  );
  assert.equal(
    (await repository.claimNextQueuedSpeechTask('missing-plan')),
    null,
    '不存在的 plan 不得产出任务',
  );

  // CAS 终态回写：只有仍处于 running 的任务允许被回写终态。
  assert.equal(
    await repository.updateSpeechTaskStatus('t1', 'completed', { expectedStatus: 'running' }),
    true,
  );
  assert.equal(
    await repository.updateSpeechTaskStatus('t1', 'failed', {
      errorMessage: '晚到的旧输出',
      expectedStatus: 'running',
    }),
    false,
    '任务已进入终态后，晚到的状态回写必须被 CAS 拒绝',
  );
  assert.equal(
    db.prepare(`SELECT status FROM group_speech_tasks WHERE id = 't1'`).get().status,
    'completed',
  );

  // 提交 fence：running 任务 + active plan 才有落库资格。
  insertTask(db, {
    id: 't4', planId: 'p1', groupId: 'g1', aiAssistantId: 'ai-D', agentId: 'agent-D',
    sequenceOrder: 3, source: 'ai_mention', createdAt: now,
  });
  assert.equal(await repository.isSpeechTaskCommitEligible('p1', 't4'), false,
    'queued 任务没有提交资格');
  await repository.claimNextQueuedSpeechTask('p1');
  assert.equal(await repository.isSpeechTaskCommitEligible('p1', 't4'), true,
    'running 任务在 active plan 内保有提交资格');

  // future-turn coverage：source=t4（ai-D，sequence 3）之后没有 E/F 的 queued
  // turn，因此两者都接到队尾；方法本身不重复检查 plan fence。
  const appended = await globalThis.__GROUP_QUEUE_COORDINATOR__.transaction({}, (tx) => (
    repository.materializeAIMentionSpeechTasksInTransaction(tx, 'p1', {
      id: 't4', aiAssistantId: 'ai-D', sequenceOrder: 3,
    }, [
      {
        id: 't5', groupId: 'g1', aiAssistantId: 'ai-E', agentId: 'agent-E',
        source: 'ai_mention',
      },
      {
        id: 't6', groupId: 'g1', aiAssistantId: 'ai-F', agentId: 'agent-F',
        source: 'ai_mention',
      },
    ])
  ));
  assert.deepEqual(
    appended.map((task) => [task.id, task.sequenceOrder, task.status, task.source]),
    [['t5', 4, 'queued', 'ai_mention'], ['t6', 5, 'queued', 'ai_mention']],
    '追加任务必须接续队尾顺序并保持 queued',
  );

  // coverage 只认同 plan、同目标、queued 且在来源之后的任务；running、终态与
  // 来源之前的任务均不覆盖。Self mention 也必须在仓储 scheduling owner 处被拦截。
  insertPlan(db, { id: 'p-coverage', groupId: 'g1', status: 'running', createdAt: now });
  insertTask(db, {
    id: 'coverage-source-a', planId: 'p-coverage', groupId: 'g1', aiAssistantId: 'ai-A',
    agentId: 'agent-A', sequenceOrder: 0, source: 'admin', status: 'running', createdAt: now,
  });
  insertTask(db, {
    id: 'coverage-b', planId: 'p-coverage', groupId: 'g1', aiAssistantId: 'ai-B',
    agentId: 'agent-B', sequenceOrder: 1, source: 'admin', status: 'queued', createdAt: now,
  });
  insertTask(db, {
    id: 'coverage-c-running', planId: 'p-coverage', groupId: 'g1', aiAssistantId: 'ai-C',
    agentId: 'agent-C', sequenceOrder: 2, source: 'admin', status: 'running', createdAt: now,
  });
  insertTask(db, {
    id: 'coverage-d-completed', planId: 'p-coverage', groupId: 'g1', aiAssistantId: 'ai-D',
    agentId: 'agent-D', sequenceOrder: 3, source: 'admin', status: 'completed', createdAt: now,
  });
  const coverageCases = await globalThis.__GROUP_QUEUE_COORDINATOR__.transaction({}, async (tx) => {
    const covered = await repository.materializeAIMentionSpeechTasksInTransaction(tx, 'p-coverage', {
      id: 't1', aiAssistantId: 'ai-A', sequenceOrder: 0,
    }, [{
      id: 'covered-b', groupId: 'g1', aiAssistantId: 'ai-B', agentId: 'agent-B', source: 'ai_mention',
    }]);
    const sourceBefore = await repository.materializeAIMentionSpeechTasksInTransaction(tx, 'p-coverage', {
      id: 'coverage-b', aiAssistantId: 'ai-B', sequenceOrder: 1,
    }, [{
      id: 'old-a', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-A', source: 'ai_mention',
    }]);
    const notCovered = await repository.materializeAIMentionSpeechTasksInTransaction(tx, 'p-coverage', {
      id: 'coverage-source-a', aiAssistantId: 'ai-A', sequenceOrder: 0,
    }, [
      {
        id: 'running-c', groupId: 'g1', aiAssistantId: 'ai-C', agentId: 'agent-C', source: 'ai_mention',
      },
      {
        id: 'terminal-d', groupId: 'g1', aiAssistantId: 'ai-D', agentId: 'agent-D', source: 'ai_mention',
      },
    ]);
    const self = await repository.materializeAIMentionSpeechTasksInTransaction(tx, 'p-coverage', {
      id: 'coverage-b', aiAssistantId: 'ai-B', sequenceOrder: 1,
    }, [{
      id: 'self-b-task', groupId: 'g1', aiAssistantId: 'ai-B', agentId: 'agent-B', source: 'ai_mention',
    }]);
    return { covered, sourceBefore, notCovered, self };
  });
  assert.deepEqual(coverageCases.covered, [], '来源之后已有 queued B 时 mention 必须被 future turn 覆盖');
  assert.deepEqual(
    coverageCases.sourceBefore.map((task) => task.aiAssistantId),
    ['ai-A'],
    '来源之前的旧 A 任务不提供 future-turn coverage，重复 @ A 必须按调用顺序形成新任务',
  );
  assert.deepEqual(
    coverageCases.notCovered.map((task) => task.aiAssistantId),
    ['ai-C', 'ai-D'],
    'running 与终态目标都不提供 future-turn coverage，必须追加任务',
  );
  assert.deepEqual(coverageCases.self, [], 'self mention 永远不得产生 ai_mention task');

  // plan 终态后：claim 与提交 fence 都被持久层拒绝。
  db.prepare(`UPDATE group_speech_plans SET status = 'completed' WHERE id = 'p1'`).run();
  assert.equal(await repository.claimNextQueuedSpeechTask('p1'), null,
    'plan 终态后不得再 claim 任务');
  assert.equal(await repository.isSpeechTaskCommitEligible('p1', 't4'), false,
    'plan 终态后任务失去提交资格');
  db.close();
}

function buildGroupTestBed(db, GroupChatRepository) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_chat_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      display_order INTEGER,
      enabled INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_assistants (
      id TEXT PRIMARY KEY,
      name TEXT,
      nickname TEXT,
      avatar TEXT,
      avatar_media_asset_id TEXT,
      model TEXT
    );
  `);
  const now = '2026-08-14T11:00:00.000Z';
  const memberRows = [
    ['ai-A', 'agent-A', 0], ['ai-B', 'agent-B', 1], ['ai-C', 'agent-C', 2],
    ['ai-D', 'agent-D', 3], ['ai-E', 'agent-E', 4], ['ai-F', 'agent-F', 5],
    ['ai-G', 'agent-G', 6], ['ai-H', 'agent-H', 7],
  ];
  for (const [assistantId, agentId, order] of memberRows) {
    db.prepare(`
      INSERT OR REPLACE INTO group_chat_members (
        id, group_id, ai_assistant_id, agent_id, display_order, enabled, created_at, updated_at
      ) VALUES (?, 'g1', ?, ?, ?, 1, ?, ?)
    `).run(`g1_${assistantId}`, assistantId, agentId, order, now, now);
    db.prepare(
      `INSERT INTO ai_assistants (id, name, avatar, model) VALUES (?, ?, NULL, 'model-x')`,
    ).run(assistantId, `小${assistantId.slice(3)}`);
  }

  const profiles = new Map(
    ['ai-A', 'ai-B', 'ai-C', 'ai-D', 'ai-E', 'ai-G', 'ai-H'].map((id) => [id, {
      id,
      agentId: `agent-${id.slice(3)}`,
      name: `小${id.slice(3)}`,
      avatar: null,
      model: 'model-x',
      disableThinking: id === 'ai-A',
      isBlocked: id === 'ai-D',
    }]),
  );

  globalThis.__GROUP_QUEUE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();
  db.prepare('INSERT INTO group_chats (id) VALUES (?)').run('g1');
  globalThis.__GROUP_QUEUE_GROUP_DEPS__ = {
    groups: {
      getById: async () => ({ group: { id: 'g1', name: 'test' }, members: await repository.getMembers('g1') }),
      getMembers: (...args) => repository.getMembers(...args),
      claimNextQueuedSpeechTask: (...args) => repository.claimNextQueuedSpeechTask(...args),
      // AI @ AI 调度后果与 mention 所在 fence 事务裁决。
      materializeAIMentionSpeechTasksInTransaction: (...args) => (
        repository.materializeAIMentionSpeechTasksInTransaction(...args)
      ),
      isSpeechTaskCommitEligible: (...args) => repository.isSpeechTaskCommitEligible(...args),
      isSpeechTaskCommitEligibleInTransaction: (...args) => (
        repository.isSpeechTaskCommitEligibleInTransaction(...args)
      ),
      markSpeechTaskReplyCommittedInTransaction: (...args) => (
        repository.markSpeechTaskReplyCommittedInTransaction(...args)
      ),
      updateSpeechTaskStatus: (...args) => repository.updateSpeechTaskStatus(...args),
      updatePreviewInTransaction: (...args) => repository.updatePreviewInTransaction(...args),
    },
    assistantDirectory: {
      getById: async (assistantId) => profiles.get(assistantId) ?? null,
    },
    currentUserDirectory: {
      getCurrent: async () => ({ id: 'self', name: '小明', avatar: null }),
    },
  };
  // ai-F（已删除资料）与 ai-G（已退出目录）不出现在参与者目录。
  globalThis.__GROUP_QUEUE_DIRECTORY__ = {
    groupId: 'g1',
    currentUser: {
      targetType: 'user', userProfileId: 'self', displayName: '小明', avatar: null,
    },
    assistants: ['ai-A', 'ai-B', 'ai-C', 'ai-D', 'ai-E', 'ai-H'].map((id) => ({
      targetType: 'assistant',
      assistantId: id,
      displayName: `小${id.slice(3)}`,
      avatar: null,
    })),
  };

  const members = db.prepare(
    `SELECT ai_assistant_id AS aiAssistantId, agent_id AS agentId
     FROM group_chat_members WHERE group_id = 'g1' ORDER BY display_order ASC`,
  ).all().map((row, index) => ({
    id: `g1_${row.aiAssistantId}`,
    groupId: 'g1',
    aiAssistantId: row.aiAssistantId,
    agentId: row.agentId,
    displayOrder: index,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));

  return {
    repository,
    details: {
      group: {
        id: 'g1', name: '测试群', avatar: null, lastMessage: null, lastTime: null,
        isPinned: false, createdAt: now, updatedAt: now,
      },
      members,
      adminConfig: {
        groupId: 'g1', name: '管理员', model: 'admin-model', apiKey: null,
        apiBaseUrl: null, systemPrompt: null, temperature: 0.7, topP: 1,
        maxTokens: null, contextMessageCount: 20, createdAt: now, updatedAt: now,
      },
    },
    memberProfiles: new Map(
      ['ai-A', 'ai-B', 'ai-C'].map((id) => [id, profiles.get(id)]),
    ),
  };
}

async function verifyDynamicQueueExecution(GroupChatRepository, executeGroupSpeechTasks) {
  const db = createSpeechPlanDatabase();
  const testBed = buildGroupTestBed(db, GroupChatRepository);
  const now = '2026-08-14T11:00:00.000Z';
  insertPlan(db, { id: 'p1', groupId: 'g1', status: 'running', createdAt: now });
  insertTask(db, {
    id: 'task-A', planId: 'p1', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-A',
    sequenceOrder: 0, source: 'user_mention', createdAt: now,
  });
  insertTask(db, {
    id: 'task-C', planId: 'p1', groupId: 'g1', aiAssistantId: 'ai-C', agentId: 'agent-C',
    sequenceOrder: 1, source: 'admin', createdAt: now,
  });

  globalThis.__GROUP_QUEUE_STATE__ = {
    executions: [],
    commits: [],
    observePreview: (text) => assert.equal(
      db.prepare("SELECT last_message FROM group_chats WHERE id='g1'").get().last_message,
      text, '每个气泡提交后即可读取最新群预览，无需等待整轮结束',
    ),
    replyScripts: {
      'ai-A': [
        { text: '我先说。@小B 你怎么看？@小明 你也听听。@小D 要来吗？@不存在的人 你好' },
        { text: '收尾，不再召唤任何人。' },
      ],
      'ai-C': [{ fail: true, failMessage: '统一错误：余额不足' }],
      'ai-B': [{ text: '同意。@小A 再补充两句？' }],
    },
  };

  await executeGroupSpeechTasks({
    planId: 'p1',
    details: testBed.details,
    currentUserMessages: [{ id: 42, text: '大家好', isMe: true, senderType: 'user' }],
    inputUpperBoundMessageId: 42,
    memberProfiles: testBed.memberProfiles,
  });

  assert.deepEqual(
    globalThis.__GROUP_QUEUE_STATE__.executions,
    ['ai-A', 'ai-C', 'ai-B', 'ai-A'],
    '执行器必须继续 claim AI 回复追加的动态任务，允许 A→B→A 递归',
  );

  const tasks = listTasks(db, 'p1');
  assert.deepEqual(globalThis.__GROUP_QUEUE_STATE__.thinkingSettings,
    [['ai-A', true], ['ai-C', false], ['ai-B', false], ['ai-A', true]],
    '群成员请求沿用各自角色的思维链开关');
  assert.equal(db.prepare("SELECT last_message FROM group_chats WHERE id='g1'").get().last_message,
    '收尾，不再召唤任何人。', '最后成员消息已同步进入群列表预览');
  assert.deepEqual(
    tasks.map((task) => [task.aiAssistantId, task.source, task.status]),
    [
      ['ai-A', 'user_mention', 'completed'],
      ['ai-C', 'admin', 'failed'],
      ['ai-B', 'ai_mention', 'completed'],
      ['ai-A', 'ai_mention', 'completed'],
    ],
    '动态任务必须接续队尾、来源为 ai_mention，失败成员标 failed 后队列继续',
  );
  assert.equal(tasks[1].errorMessage, '统一错误：余额不足',
    '失败任务必须记录统一映射后的可展示原因');

  const appendedTargets = tasks.slice(2).map((task) => task.aiAssistantId);
  assert.ok(!appendedTargets.includes('ai-D'), 'blocked 成员可形成 mention 但不得追加任务');
  assert.equal(
    tasks.filter((task) => task.aiAssistantId === 'ai-B').length,
    1,
    '同一回复里的重复目标只追加一次',
  );

  const firstCommit = globalThis.__GROUP_QUEUE_STATE__.commits[0];
  assert.equal(globalThis.__GROUP_QUEUE_STATE__.commits.length, 3,
    '失败成员不产生 assistant 提交');
  assert.deepEqual(
    firstCommit.mentions.map((mention) => [
      mention.target.targetType,
      mention.target.targetType === 'user'
        ? mention.target.userProfileId
        : mention.target.assistantId,
    ]),
    [['assistant', 'ai-B'], ['user', 'self'], ['assistant', 'ai-D']],
    '结构化 mention 保持正文首次出现顺序，blocked 成员仍写入 mention 事实',
  );
  db.close();
}

async function verifyReplyOutputStates(GroupChatRepository, executeGroupSpeechTasks) {
  const cases = [
    { script: { text: '完整回复' }, status: 'completed', detail: null },
    { script: { text: '已收到的正文', finishReason: 'length' }, status: 'partial', detail: '输出长度上限' },
    { script: { text: '过滤前的正文', finishReason: 'content_filter' }, status: 'partial', detail: '内容过滤' },
    { script: { reasoningText: '只有思考' }, status: 'partial', detail: '未发出正文' },
    { script: { reasoningText: '思考耗尽额度', finishReason: 'length' }, status: 'partial', detail: '输出长度上限' },
    { script: { finishReason: 'length' }, status: 'failed', detail: '输出长度上限' },
    { script: {}, status: 'failed', detail: '未生成可见回复' },
    { script: { segments: ['首泡已发出', '第二泡提交失败'] }, failCommitText: '第二泡提交失败',
      status: 'partial', detail: '已保留发出的部分回复' },
  ];
  for (const testCase of cases) {
    const db = createSpeechPlanDatabase();
    const testBed = buildGroupTestBed(db, GroupChatRepository);
    const now = '2026-08-14T11:00:00.000Z';
    insertPlan(db, { id: 'output-plan', groupId: 'g1', status: 'running', createdAt: now });
    for (const [index, aiAssistantId] of ['ai-A', 'ai-B'].entries()) {
      insertTask(db, { id: `output-${index}`, planId: 'output-plan', groupId: 'g1', aiAssistantId,
        agentId: `agent-${index}`, sequenceOrder: index, source: 'admin', createdAt: now });
    }
    globalThis.__GROUP_QUEUE_STATE__ = {
      executions: [], commits: [], failCommitText: testCase.failCommitText,
      replyScripts: { 'ai-A': [testCase.script], 'ai-B': [{ text: '下一位继续' }] },
    };
    await executeGroupSpeechTasks({
      planId: 'output-plan', details: testBed.details,
      currentUserMessages: [{ id: 42, text: '大家好', isMe: true, senderType: 'user' }],
      inputUpperBoundMessageId: 42, memberProfiles: testBed.memberProfiles,
    });
    const [first, next] = await testBed.repository.listSpeechPlanTasks('output-plan');
    assert.equal(first.status, testCase.status, JSON.stringify(testCase.script));
    assert.ok(first.completedAt, '所有输出终态都记录完成时间');
    assert.equal(first.visibleReplyCommitted,
      Boolean(testCase.script.text || testCase.script.segments), '只有正文实际提交才算已发言');
    if (testCase.detail) assert.ok(first.errorMessage.includes(testCase.detail), first.errorMessage);
    else assert.equal(first.errorMessage, null);
    assert.equal(next.status, 'completed', '部分回复（含仅思考）与无输出均不阻塞后续成员');
    if (testCase.failCommitText) {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE text = ?').get('首泡已发出').n,
        1, '后续气泡失败保留已提交正文');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE text = ?').get(testCase.failCommitText).n,
        0, '失败气泡事务回滚');
    }
    db.close();
  }
}

async function verifyFutureCoverageConversation(GroupChatRepository, executeGroupSpeechTasks) {
  const db = createSpeechPlanDatabase();
  const testBed = buildGroupTestBed(db, GroupChatRepository);
  const now = '2026-08-14T11:30:00.000Z';
  insertPlan(db, { id: 'p-future-conversation', groupId: 'g1', status: 'running', createdAt: now });
  for (const [index, assistantId] of ['ai-A', 'ai-B', 'ai-C'].entries()) {
    insertTask(db, {
      id: `future-task-${assistantId}`,
      planId: 'p-future-conversation',
      groupId: 'g1',
      aiAssistantId: assistantId,
      agentId: `agent-${assistantId.slice(3)}`,
      sequenceOrder: index,
      source: 'admin',
      createdAt: now,
    });
  }

  globalThis.__GROUP_QUEUE_STATE__ = {
    executions: [],
    commits: [],
    replyScripts: {
      'ai-A': [
        { text: 'A 首次发言：@\u5c0fB @\u5c0fC 请接着说。' },
        { text: 'A 队尾发言：@\u5c0fB 再收个尾。' },
      ],
      'ai-B': [
        { text: 'B 首次发言：@\u5c0fC 先说，@\u5c0fA 之后再补充。' },
        { text: 'B 队尾发言：说完了。' },
      ],
      'ai-C': [{ text: 'C 发言：@\u5c0fA 之后还有机会。' }],
    },
  };

  await executeGroupSpeechTasks({
    planId: 'p-future-conversation',
    details: testBed.details,
    currentUserMessages: [{ id: 52, text: '按顺序讨论', isMe: true, senderType: 'user' }],
    inputUpperBoundMessageId: 52,
    memberProfiles: testBed.memberProfiles,
  });

  assert.deepEqual(
    globalThis.__GROUP_QUEUE_STATE__.executions,
    ['ai-A', 'ai-B', 'ai-C', 'ai-A', 'ai-B'],
    '已有 future turn 应覆盖 mention，只有队尾后缺失的新机会才追加',
  );
  assert.deepEqual(
    listTasks(db, 'p-future-conversation').map((task) => [
      task.aiAssistantId,
      task.source,
      task.sequenceOrder,
    ]),
    [
      ['ai-A', 'admin', 0],
      ['ai-B', 'admin', 1],
      ['ai-C', 'admin', 2],
      ['ai-A', 'ai_mention', 3],
      ['ai-B', 'ai_mention', 4],
    ],
    'A→B→C 中的未来机会不重复入队，但 B→A 与队尾 A→B 仍保留',
  );
  db.close();
}

async function verifyCommitFenceAndSkips(GroupChatRepository, executeGroupSpeechTasks) {
  const db = createSpeechPlanDatabase();
  const testBed = buildGroupTestBed(db, GroupChatRepository);
  const now = '2026-08-14T12:00:00.000Z';
  insertPlan(db, { id: 'p2', groupId: 'g1', status: 'running', createdAt: now });
  insertTask(db, {
    id: 'task-E', planId: 'p2', groupId: 'g1', aiAssistantId: 'ai-E', agentId: 'agent-E',
    sequenceOrder: 0, source: 'user_mention', createdAt: now,
  });
  insertTask(db, {
    id: 'task-F', planId: 'p2', groupId: 'g1', aiAssistantId: 'ai-F', agentId: 'agent-F',
    sequenceOrder: 1, source: 'admin', createdAt: now,
  });
  insertTask(db, {
    id: 'task-G', planId: 'p2', groupId: 'g1', aiAssistantId: 'ai-G', agentId: 'agent-G',
    sequenceOrder: 2, source: 'admin', createdAt: now,
  });
  insertTask(db, {
    id: 'task-H', planId: 'p2', groupId: 'g1', aiAssistantId: 'ai-H', agentId: 'agent-H',
    sequenceOrder: 3, source: 'ai_mention', createdAt: now,
  });

  globalThis.__GROUP_QUEUE_STATE__ = {
    executions: [],
    commits: [],
    replyScripts: {
      // 模拟 supersede 已把任务转为终态：提交 fence 必须拒绝落库，
      // processAIReply 对取消错误安静收尾。
      'ai-E': [{
        text: '这条回复永远不应该落库。',
        beforeCommit: () => {
          db.prepare(
            `UPDATE group_speech_tasks
             SET status = 'failed', error_message = '已被新输入取代'
             WHERE id = 'task-E'`,
          ).run();
        },
      }],
      'ai-H': [{ text: '队列继续。' }],
    },
  };

  await executeGroupSpeechTasks({
    planId: 'p2',
    details: testBed.details,
    currentUserMessages: [{ id: 77, text: '继续', isMe: true, senderType: 'user' }],
    inputUpperBoundMessageId: 77,
    memberProfiles: testBed.memberProfiles,
  });

  assert.deepEqual(
    globalThis.__GROUP_QUEUE_STATE__.executions,
    ['ai-E', 'ai-H'],
    '资料缺失与目录缺席的成员不应发起模型请求',
  );
  assert.equal(globalThis.__GROUP_QUEUE_STATE__.commits.length, 1,
    'fence 拒绝的输出不得产生任何 assistant 提交');
  assert.equal(globalThis.__GROUP_QUEUE_STATE__.commits[0].text, '队列继续。');

  const tasks = listTasks(db, 'p2');
  assert.deepEqual(
    tasks.map((task) => [task.id, task.status]),
    [
      ['task-E', 'failed'],
      ['task-F', 'skipped'],
      ['task-G', 'skipped'],
      ['task-H', 'completed'],
    ],
    'fence 拒绝不覆盖已裁决终态，不可用成员标 skipped，队列继续执行',
  );
  assert.equal(tasks[0].errorMessage, '已被新输入取代',
    '执行器的晚到回写不得覆盖 supersede 写入的终态事实');
  db.close();
}

const { GroupChatRepository } = await loadGroupChatRepository();
const groupRuntimeUrl = loadGroupRuntimeStub();
// 执行器与提交接缝必须共享同一个模块实例：执行器内部 import 的
// GroupAssistantTurnCommit 与测试直接验证的接缝是同一个 URL。
const turnCommitUrl = await buildGroupTurnCommitUrl(groupRuntimeUrl);
const { executeGroupSpeechTasks } = await loadGroupTaskExecution(
  groupRuntimeUrl,
  turnCommitUrl,
);
await verifyPersistentQueueRepository(GroupChatRepository);
await verifyDynamicQueueExecution(GroupChatRepository, executeGroupSpeechTasks);
await verifyReplyOutputStates(GroupChatRepository, executeGroupSpeechTasks);
await verifyFutureCoverageConversation(GroupChatRepository, executeGroupSpeechTasks);
await verifyCommitFenceAndSkips(GroupChatRepository, executeGroupSpeechTasks);

console.log('群发言持久动态队列行为验证通过。');
