/**
 * Phase 3D 用户消息换代（supersede/successor）的真实行为验证：
 * - 迁移62 为 plan/task 增加换代事实列，幂等；
 * - 换代与消息提交同一事务：旧 plan superseded、旧 queued/running 任务失去提交资格、
 *   pending successor 与继承队列原子建立，失败时整体回滚；
 * - 公平继承：completed 不继承、queued 保持相对顺序、未提交可见回复的 running
 *   移到队尾、同一 AI 只保留一个待发言机会；用户明确 @ 优先并去交叉重复；
 * - 30 秒输入窗口：后续消息只扩展同一个 successor 并从最新消息重置计时，
 *   29.999 秒不执行、30 秒恰好执行一次；召唤立即关闭窗口激活 successor；
 * - 执行器 abort 只节约资源：晚到旧输出被 fence 拒绝、不覆盖 superseded 终态；
 *   已提交部分气泡的 AI 视为已发言，不重新继承；
 * - 逐泡提交 fence：气泡 INSERT 与 visible_reply_committed 标记同事务落库，
 *   换代后 fence 以取消错误拒绝且不产生新行；动态任务追加失败不改判已提交
 *   回复；mention 所在气泡与调度后果同事务裁决；confirmCommitEligible 探针
 *   反映持久 fence 事实；
 * - planning 失败提示受 plan 所有权 fence 保护；消息删除重算 preview 后，
 *   已删除消息的晚到回调不能复活 preview；
 * - 晚到终态回写的 CAS 守卫：superseded 终态不被晚到的 skipped/completed 覆盖；
 * - 有用户 @ 不请求管理员；无 @ 但有继承队列直接按继承顺序执行；
 * - 强制终止：plan 与 queued/running 任务在同一事务内裁决为 terminated，
 *   提交资格先于 abort 在持久层撤销；终止不创建 successor、不产生继承，
 *   active 槽位释放后下一批消息可重新进入管理员编排。
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
    CREATE UNIQUE INDEX idx_group_speech_plans_single_active
      ON group_speech_plans(group_id)
      WHERE status IN ('pending', 'preparing', 'running');
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata_json TEXT
    );
    CREATE TABLE group_chats (
      id TEXT PRIMARY KEY,
      last_message TEXT,
      last_time TEXT,
      last_message_id INTEGER,
      updated_at TEXT
    );
  `);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(SCHEMAS.groupChatMembers);
  for (const id of [...'123456789ABCDEFGH'.split('').map(letter => `ai-${letter}`)]) {
    db.prepare(`INSERT INTO group_chat_members (id, group_id, ai_assistant_id, agent_id, enabled, created_at, updated_at)
      VALUES (?, 'g1', ?, ?, 1, '2026-08-01', '2026-08-01')`).run(`fixture-${id}`, id, `agent-${id.slice(3)}`);
  }
  return db;
}

function insertGroupChat(db, groupId) {
  db.prepare(
    `INSERT INTO group_chats (id, last_message, last_time, last_message_id, updated_at)
     VALUES (?, NULL, NULL, NULL, ?)`,
  ).run(groupId, NOW);
}

function insertPlan(db, input) {
  db.prepare(`
    INSERT INTO group_speech_plans (
      id, group_id, status, invoked_user_message_ids_json, last_included_message_id,
      supersedes_plan_id, started_at, completed_at, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
  `).run(
    input.id,
    input.groupId,
    input.status,
    JSON.stringify(input.invokedUserMessageIds || []),
    input.lastIncludedMessageId ?? null,
    input.supersedesPlanId ?? null,
    input.startedAt || input.createdAt,
    input.createdAt,
    input.updatedAt || input.createdAt,
  );
}

function insertTask(db, input) {
  db.prepare(`
    INSERT INTO group_speech_tasks (
      id, plan_id, group_id, ai_assistant_id, agent_id, sequence_order, source,
      status, visible_reply_committed, started_at, completed_at, error_message,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
  `).run(
    input.id,
    input.planId,
    input.groupId,
    input.aiAssistantId,
    input.agentId,
    input.sequenceOrder,
    input.source,
    input.status || 'queued',
    input.visibleReplyCommitted ? 1 : 0,
    input.createdAt,
    input.createdAt,
  );
}

function listTasks(db, planId) {
  return db.prepare(
    `SELECT id, ai_assistant_id AS aiAssistantId, sequence_order AS sequenceOrder,
            source, status, visible_reply_committed AS visibleReplyCommitted
     FROM group_speech_tasks
     WHERE plan_id = ?
     ORDER BY sequence_order ASC`,
  ).all(planId);
}

function getPlan(db, planId) {
  return db.prepare(`SELECT * FROM group_speech_plans WHERE id = ?`).get(planId);
}

async function loadGroupChatRepository(coordinatorKey) {
  const mediaUrl = transpileToModuleUrl(`
    export async function resolveMediaAssetReferenceUri(reference) {
      return reference.mediaAssetId
        ? \`asset://\${reference.mediaAssetId}\`
        : reference.legacyUri;
    }
    // 删除事务内的引用候选收集：本 verifier 只覆盖换代语义，不构造媒体引用事实。
    export async function collectChatSessionMediaAssetCandidatesInTransaction() {
      return [];
    }
  `);
  const persistenceUrl = transpileToModuleUrl(
    `export const databaseCoordinator = {
      transaction(...args) {
        return globalThis.${coordinatorKey}.transaction(...args);
      },
      openTaskExecutor(...args) {
        return globalThis.${coordinatorKey}.openTaskExecutor(...args);
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
        export function bindModelServiceInTransaction() { throw new Error('换代验证不应修改模型服务'); }
        export function readModelServiceConnection() { throw new Error('换代验证不应读取模型服务'); }
        export function getModelServiceConnection() { throw new Error('换代验证不应解析模型服务'); }
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

// ---- 模块加载器：真实源码 + 边界依赖桩 -------------------------------------

function loadAbortRegistryUrl() {
  return transpileToModuleUrl(
    read('src/features/chat/group/application/GroupSpeechExecutionAbort.ts'),
  );
}

function buildTurnCommitUrl(groupRuntimeUrl) {
  // 与真实 legacy 逐泡落库一致：经 repository.commitMessage 写 messages 表。
  // 群聊接缝已用 fence 事务装饰该入口，fence 拒绝时错误必须向上抛（表现为
  // ChatReplyRunCancelledError 拒绝），只有落库成功才记录 commits。
  // segmentIndex/segmentTotal 模拟真实分段事实：mention 所在气泡的事务裁决
  // AI @ AI scheduling consequence，非最终气泡也必须参与裁决。
  const persistenceUrl = transpileToModuleUrl(`
    export const databaseCoordinator = {
      transaction(...args) {
        return globalThis.__SUPERSEDE_COORDINATOR__.transaction(...args);
      },
      openTaskExecutor(...args) {
        return globalThis.__SUPERSEDE_COORDINATOR__.openTaskExecutor(...args);
      },
    };
  `);
  // 与 loadGroupMessageCommit 相同的最小 messages 仓储桩：事务内插入 messages 表。
  const messageRuntimeUrl = transpileToModuleUrl(`
    export function getChatMessageRuntimeDependencies() {
      return {
        messages: {
          async commitMessageInTransaction(transaction, { message }) {
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
  const source = read('src/features/chat/group/application/GroupAssistantTurnCommit.ts')
    .replace(/from ['"]\.\.\/\.\.\/messages\/domain\/chatMessageMetadata['"]/g,
      `from '${transpileToModuleUrl('export function buildSessionPreviewTextFromMessage(message) { return message.text; }')}'`)
    .replace(/from ['"]\.\.\/\.\.\/reply\/application\/CommittedAssistantSegmentDelivery['"]/g,
      `from '${transpileToModuleUrl('export async function deliverCommittedAssistantSegment() {}')}'`)
    .replace(/from ['"]@platform\/persistence['"]/g, `from '${persistenceUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/application\/ChatMessageRuntime['"]/g,
      `from '${messageRuntimeUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/reply\/application\/ChatReplyAbort['"]/g,
      `from '${abortUrl}'`,
    )
    .replace(/from ['"]\.\/GroupMessageMentionParser['"]/g, `from '${parserUrl}'`)
    .replace(/from ['"]\.\/GroupSpeechTaskAppend['"]/g, `from '${transpileToModuleUrl(appendSource)}'`)
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`);
  return transpileToModuleUrl(source);
}

function loadGroupTaskExecution(groupRuntimeUrl, turnCommitUrl, abortRegistryUrl) {
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
  // 与真实 processAIReply 一致：取消错误安静收尾；gate 用于模拟"请求已发给厂商、
  // 输出晚到"的时序。
  const processAIReplyUrl = transpileToModuleUrl(`
    export async function processAIReply(
      _sessionId, _userText, aiConfig, _userMessageId, _repo,
      callbacks, runtimeContext, persistence,
    ) {
      const state = globalThis.__SUPERSEDE_STATE__;
      state.executions.push(aiConfig.id);
      state.signals[aiConfig.id] = runtimeContext.abortSignal;
      state.signalResolve?.(aiConfig.id);
      const script = state.replyScripts[aiConfig.id] || { bubbles: ['好的。'] };
      try {
        for (const [index, text] of script.bubbles.entries()) {
          if (index === script.gateBeforeIndex) {
            await script.gate;
          }
          await persistence.commitAgentTimeline({
            items: [{message:{sessionId:runtimeContext.groupChat.groupId,text,senderType:'assistant',metadataJson:JSON.stringify({groupChat:runtimeContext.groupChat})}}],
            response: {
              text,
              segmentIndex: index,
              segmentTotal: script.bubbles.length,
            },
            runtimeContext,
            repository: _repo,
          });
          state.commits.push(text);state.commitResolve?.();
          callbacks?.onFinalReply?.({ text });
        }
      } catch (error) {
        if (error && error.name === 'ChatReplyRunCancelledError') {
          return;
        }
        throw error;
      }
    }
  `);
  const directoryUrl = transpileToModuleUrl(`
    export async function getGroupParticipantDirectory() {
      return globalThis.__SUPERSEDE_DIRECTORY__;
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
    .replace(/from ['"]\.\/GroupSpeechExecutionAbort['"]/g, `from '${abortRegistryUrl}'`)
    .replace(/from ['"]\.\/GroupParticipantDirectory['"]/g, `from '${directoryUrl}'`);
  return import(transpileToModuleUrl(source));
}

/** 真实 commitGroupUserMessage：消息与换代共享协调器事务，messages 仓储用最小桩。 */
function loadGroupMessageCommit(persistenceUrl, groupRuntimeUrl) {
  const mediaUrl = transpileToModuleUrl(`
    export const MEDIA_ASSET_STORAGE_BACKEND = { persistentMedia: 'persistent-media' };
    export async function prepareMediaAssetBatch() { throw new Error('此群计划场景没有媒体准备'); }
  `);
  const mimeUrl = transpileToModuleUrl(read('src/features/chat/messages/application/ChatAttachmentMime.ts'));
  const prepareUrl = transpileToModuleUrl(read('src/features/chat/messages/application/PrepareChatAttachments.ts')
    .replace(/from ['"]@features\/media['"]/g, `from '${mediaUrl}'`)
    .replace(/from ['"]\.\/ChatAttachmentMime['"]/g, `from '${mimeUrl}'`));
  const metadataUrl = transpileToModuleUrl(`
    export function buildAttachmentMessageMetadata() { return null; }
    export function buildStickerMessageMetadata() { return null; }
    export function buildUserMessagePreviewText({ text }) { return text; }
  `);
  const messageRuntimeUrl = transpileToModuleUrl(`
    export function getChatMessageRuntimeDependencies() {
      return {
        messages: {
          async commitMessageInTransaction(transaction, { message }) {
            const result = await transaction.runAsync(
              'INSERT INTO messages (session_id, text, metadata_json) VALUES (?, ?, ?)',
              [message.sessionId, message.text, message.metadataJson],
            );
            return { ...message, id: Number(result.lastInsertRowId) };
          },
        },
      };
    }
  `);
  const eventsUrl = transpileToModuleUrl(`
    export function emitChatMessagesUpdated(sessionId) {
      globalThis.__SUPERSEDE_STATE__.emits.push(sessionId);
    }
  `);
  const source = read('src/features/chat/group/application/GroupMessageCommit.ts')
    .replace(/from ['"]\.\.\/\.\.\/messages\/application\/PrepareChatAttachments['"]/g, `from '${prepareUrl}'`)
    .replace(/from ['"]\.\.\/\.\.\/messages\/application\/UserMessageSubmission['"]/g,
      `from '${transpileToModuleUrl(read('src/features/chat/messages/application/UserMessageSubmission.ts'))}'`)
    .replace(/from ['"]@platform\/persistence['"]/g, `from '${persistenceUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/domain\/chatMessageMetadata['"]/g,
      `from '${metadataUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/domain\/ChatSticker['"]/g,
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
    );
  return transpileToModuleUrl(source);
}

/** 真实 sendGroupUserMessage：commit 用真实接缝，invoke 用桩，scheduler/abort 用真实模块。 */
function loadSendGroupUserMessage(commitUrl, schedulerUrl, abortRegistryUrl) {
  const messagingUrl = transpileToModuleUrl(`
    export async function invokeGroupChat(groupId) {
      const state = globalThis.__SUPERSEDE_STATE__;
      state.invokeCalls.push(groupId);
      return { success: true, error: null, planId: 'invoked', outcome: 'completed' };
    }
  `);
  const eventsUrl = transpileToModuleUrl(`
    export function emitChatGroupSpeechPlanChanged(groupId) {
      globalThis.__SUPERSEDE_STATE__.planChanges?.push(groupId);
    }
  `);
  const stickersUrl = transpileToModuleUrl(`
    export async function recordUserStickerUse() {}
  `);
  const source = read('src/features/chat/group/application/GroupUserMessaging.ts')
    .replace(/from ['"]@features\/stickers['"]/g, `from '${stickersUrl}'`)
    .replace(/from ['"]\.\/GroupMessageCommit['"]/g, `from '${commitUrl}'`)
    .replace(/from ['"]\.\/GroupChatMessaging['"]/g, `from '${messagingUrl}'`)
    .replace(/from ['"]\.\/GroupAutoInvocationScheduler['"]/g, `from '${schedulerUrl}'`)
    .replace(/from ['"]\.\/GroupSpeechExecutionAbort['"]/g, `from '${abortRegistryUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/events\/ChatEvents['"]/g,
      `from '${eventsUrl}'`,
    );
  return import(transpileToModuleUrl(source));
}

/** 真实 invokeGroupChat：capture/planning/execution/scheduler 反馈用桩，提交接缝与仓储用真实实现。 */
function loadInvokeGroupChat(groupRuntimeUrl, commitUrl) {
  const eventUrl = transpileToModuleUrl(`
    export function emitChatTypingStatusChanged(groupId, isTyping) {
      globalThis.__SUPERSEDE_STATE__.typing.push({ groupId, isTyping });
    }
    export function emitChatGroupSpeechPlanChanged(groupId) {
      globalThis.__SUPERSEDE_STATE__.planChanges.push(groupId);
    }
  `);
  const planningUrl = transpileToModuleUrl(`
    export async function captureGroupInvocationContext(_groupId, previousInputUpperBoundMessageId) {
      const state = globalThis.__SUPERSEDE_STATE__;
      state.captureLowerBounds.push(previousInputUpperBoundMessageId);
      return {
        currentUserMessages: state.currentUserMessages,
        inputUpperBoundMessageId: state.inputUpperBoundMessageId,
      };
    }
    export async function prepareGroupSpeechPlan(_details, _currentUserMessages, options) {
      const state = globalThis.__SUPERSEDE_STATE__;
      state.planningOptions.push(options);
      // gate 用于模拟"管理员请求已发出、结果未返回"的规划中时序。
      state.planningStarted?.();
      if (state.planningGate) {
        await state.planningGate;
      }
      return {
        memberProfiles: new Map(),
        sequenceMembers: state.sequenceMembers,
        mentionedAssistantIds: state.mentionedAssistantIds,
        adminRequestFailureNotice: state.adminRequestFailureNotice,
      };
    }
  `);
  const executionUrl = transpileToModuleUrl(`
    export async function executeGroupSpeechTasks(params) {
      globalThis.__SUPERSEDE_STATE__.executed.push({
        planId: params.planId,
        userMessageCount: params.currentUserMessages.length,
        inputUpperBoundMessageId: params.inputUpperBoundMessageId,
      });
    }
  `);
  const schedulerUrl = transpileToModuleUrl(`
    export function acknowledgeGroupInvocationInput(groupId, upperBound) {
      globalThis.__SUPERSEDE_STATE__.acknowledged.push({ groupId, upperBound });
    }
    export function notifyGroupInvocationSettled(groupId) {
      globalThis.__SUPERSEDE_STATE__.settled.push(groupId);
    }
  `);
  const source = read('src/features/chat/group/application/GroupChatMessaging.ts')
    .replace(/from ['"]\.\/GroupSpeechExecutionAbort['"]/g, `from '${loadAbortRegistryUrl()}'`)
    .replace(/from ['"]\.\.\/\.\.\/messages\/events\/ChatEvents['"]/g, `from '${eventUrl}'`)
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`)
    .replace(/from ['"]\.\/GroupMessageCommit['"]/g, `from '${commitUrl}'`)
    .replace(/from ['"]\.\/GroupSpeakerPlanning['"]/g, `from '${planningUrl}'`)
    .replace(/from ['"]\.\/GroupSpeechTaskExecution['"]/g, `from '${executionUrl}'`)
    .replace(/from ['"]\.\/GroupAutoInvocationScheduler['"]/g, `from '${schedulerUrl}'`);
  return transpileToModuleUrl(source);
}

/** 真实 prepareGroupSpeechPlan：管理员请求计数，验证继承队列抑制管理员调度。 */
function loadPrepareGroupSpeechPlan() {
  const aiUrl = transpileToModuleUrl(`
    export function getErrorDisplayInfo(error) {
      return { message: String(error) };
    }
    export function createAIClient() {
      return {
        async chat() {
          const state = globalThis.__SUPERSEDE_PLANNING_STATE__;
          state.adminCalls += 1;
          return { success: true, text: '["member_1"]' };
        },
      };
    }
  `);
  const metadataUrl = transpileToModuleUrl(`
    export function getGroupChatMentions(message) {
      if (!message?.metadataJson) return [];
      const parsed = JSON.parse(message.metadataJson);
      return Array.isArray(parsed?.groupChat?.mentions) ? parsed.groupChat.mentions : [];
    }
  `);
  const messageRuntimeUrl = transpileToModuleUrl(`
    export function getChatMessageRuntimeDependencies() {
      return {
        messages: {
          async getMessages() { return { messages: [] }; },
        },
      };
    }
  `);
  const groupRuntimeUrl = transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__SUPERSEDE_PLANNING_GROUP_DEPS__;
    }
  `);
  const replyRuntimeUrl = transpileToModuleUrl(`
    export function getChatReplyRuntimeDependencies() {
      return { prompt: { async assembleStandalone() { return { systemPrompt: '', modelMessages: [] }; } } };
    }
  `);
  const promptBlocksUrl = transpileToModuleUrl(`
    export function buildGroupAdminPromptBlocks() { return []; }
  `);
  const parserUrl = transpileToModuleUrl(`
    export function createGroupAdminMemberAliases(members) {
      return members.map((member, index) => ({ alias: 'member_' + (index + 1), member }));
    }
    export function buildGroupAdminInput() { return 'admin input'; }
    export function normalizeAdminSpeakerIds(text, candidates) {
      const parsed = JSON.parse(text.trim());
      const byAlias = new Map(candidates.map((entry) => [entry.alias, entry.member]));
      return parsed.map((alias) => byAlias.get(alias)?.aiAssistantId).filter(Boolean);
    }
  `);
  const source = read('src/features/chat/group/application/GroupSpeakerPlanning.ts')
    .replace(/from ['"]@shared\/runtime\/abortSignal['"]/g,
      `from '${transpileToModuleUrl(read('src/shared/runtime/abortSignal.ts'))}'`)
    .replace(/from ['"]@platform\/ai['"]/g, `from '${aiUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/application\/ChatMessageRuntime['"]/g,
      `from '${messageRuntimeUrl}'`,
    )
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/domain\/chatMessageMetadata['"]/g,
      `from '${metadataUrl}'`,
    )
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/reply\/application\/ChatReplyRuntimeDependencies['"]/g,
      `from '${replyRuntimeUrl}'`,
    )
    .replace(/from ['"]\.\/GroupTaskPromptBlocks['"]/g, `from '${promptBlocksUrl}'`)
    .replace(/from ['"]\.\/GroupAdminReplyParser['"]/g, `from '${parserUrl}'`);
  return transpileToModuleUrl(source);
}

// ---- 场景验证 -------------------------------------------------------------

const NOW = '2026-08-14T12:00:00.000Z';

async function verifyRotationInheritance(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();

  insertPlan(db, {
    id: 'p-old', groupId: 'g1', status: 'running',
    lastIncludedMessageId: 100, createdAt: NOW,
  });
  insertTask(db, {
    id: 't-run', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-2', agentId: 'agent-2',
    sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
  });
  insertTask(db, {
    id: 't-q1', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-3', agentId: 'agent-3',
    sequenceOrder: 1, source: 'user_mention', createdAt: NOW,
  });
  insertTask(db, {
    id: 't-q2', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-1', agentId: 'agent-1',
    sequenceOrder: 2, source: 'ai_mention', createdAt: NOW,
  });
  insertTask(db, {
    id: 't-q3', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-3', agentId: 'agent-3',
    sequenceOrder: 3, source: 'ai_mention', createdAt: NOW,
  });
  insertTask(db, {
    id: 't-done', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-4', agentId: 'agent-4',
    sequenceOrder: 4, source: 'admin', status: 'completed', createdAt: NOW,
  });

  const rotation = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
    repository.rotateSpeechPlanForUserMessageInTransaction(tx, {
      groupId: 'g1',
      userMessageId: 120,
    })
  ));
  assert.equal(rotation.kind, 'superseded');
  assert.equal(rotation.previousPlanId, 'p-old');
  assert.equal(rotation.inheritedTaskCount, 3, '同一 AI 的重复 queued 只保留一个待发言机会');

  const oldPlan = getPlan(db, 'p-old');
  assert.equal(oldPlan.status, 'superseded', '旧 plan 必须原子转为 superseded 终态');
  assert.ok(oldPlan.completed_at, 'superseded 必须记录终态时间');
  assert.deepEqual(
    listTasks(db, 'p-old').map((task) => [task.id, task.status]),
    [['t-run', 'superseded'], ['t-q1', 'superseded'], ['t-q2', 'superseded'],
      ['t-q3', 'superseded'], ['t-done', 'completed']],
    '旧 queued/running 任务失去提交资格，completed 保持原样',
  );

  const successor = getPlan(db, rotation.successorPlanId);
  assert.equal(successor.status, 'pending');
  assert.equal(successor.supersedes_plan_id, 'p-old');
  assert.equal(successor.last_included_message_id, 100, 'successor 窗口起点必须是旧 plan 的输入上界');
  assert.equal(successor.invoked_user_message_ids_json, '[120]');

  // 公平继承：queued 保持相对顺序，未提交可见回复的 running 移到队尾，completed 不继承。
  assert.deepEqual(
    listTasks(db, rotation.successorPlanId)
      .map((task) => [task.aiAssistantId, task.sequenceOrder, task.source, task.status]),
    [
      ['ai-3', 0, 'inherited_after_user_interrupt', 'queued'],
      ['ai-1', 1, 'inherited_after_user_interrupt', 'queued'],
      ['ai-2', 2, 'inherited_after_user_interrupt', 'queued'],
    ],
  );

  assert.equal(
    await repository.isSpeechTaskCommitEligible('p-old', 't-run'),
    false,
    '换代后晚到的旧输出必须被 fence 拒绝',
  );
  assert.equal(
    await repository.claimNextQueuedSpeechTask('p-old'),
    null,
    '换代后旧 plan 不得再被 claim',
  );
  // 换代后"晚到的 AI @ 任务不得落库"由提交 fence 裁决（materializeAIMentionSpeechTasksInTransaction
  // 只在 fence 事务内被调用，不再自查 plan 状态），见逐泡 fence 与 @ 同边界用例。
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS count FROM group_speech_plans
       WHERE group_id = 'g1' AND status IN ('pending', 'running')`,
    ).get().count,
    1,
    '换代后必须只剩 successor 一个 active plan',
  );

  // 已提交可见回复的 running 任务视为已发言，不进入继承队列。
  const db2 = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db2);
  const repository2 = new GroupChatRepository();
  insertPlan(db2, {
    id: 'p2', groupId: 'g1', status: 'running', lastIncludedMessageId: 100, createdAt: NOW,
  });
  insertTask(db2, {
    id: 't2-run', planId: 'p2', groupId: 'g1', aiAssistantId: 'ai-2', agentId: 'agent-2',
    sequenceOrder: 0, source: 'admin', status: 'running', visibleReplyCommitted: true, createdAt: NOW,
  });
  insertTask(db2, {
    id: 't2-q', planId: 'p2', groupId: 'g1', aiAssistantId: 'ai-3', agentId: 'agent-3',
    sequenceOrder: 1, source: 'admin', createdAt: NOW,
  });
  const rotation2 = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
    repository2.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 121 })
  ));
  assert.deepEqual(
    listTasks(db2, rotation2.successorPlanId).map((task) => task.aiAssistantId),
    ['ai-3'],
    '多气泡已提交一部分的 AI 视为已发言，不重新继承',
  );
  assert.equal(rotation2.inheritedTaskCount, 1);
  db.close();
  db2.close();
}

async function verifyWindowExtension(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();

  // 无 active plan：不触发换代。
  const none = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
    repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 110 })
  ));
  assert.equal(none.kind, 'no_active_plan');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM group_speech_plans`).get().count,
    0,
  );

  // fresh claim 的瞬时 pending（非 successor）必须被换代而不是扩展；
  // 其窗口起点回退到最近 completed plan 的水位。
  insertPlan(db, {
    id: 'p-done', groupId: 'g1', status: 'completed',
    lastIncludedMessageId: 88, createdAt: '2026-08-14T11:00:00.000Z',
  });
  insertPlan(db, {
    id: 'p-fresh', groupId: 'g1', status: 'pending', createdAt: '2026-08-14T11:59:00.000Z',
  });
  const first = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
    repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
  ));
  assert.equal(first.kind, 'superseded');
  assert.equal(first.previousPlanId, 'p-fresh');
  assert.equal(
    getPlan(db, first.successorPlanId).last_included_message_id,
    88,
    '旧 plan 尚未固定上界时，窗口起点回退到最近 completed plan 的水位',
  );

  // 输入窗口内的后续消息只扩展同一个 successor。
  const second = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
    repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 121 })
  ));
  assert.equal(second.kind, 'successor_window_extended');
  assert.equal(second.planId, first.successorPlanId, '窗口内消息不得重复创建 successor');
  assert.equal(
    getPlan(db, first.successorPlanId).invoked_user_message_ids_json,
    '[120,121]',
    '窗口水位必须扩展到最新消息',
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM group_speech_plans WHERE group_id = 'g1'`).get().count,
    3,
    '窗口扩展不得产生新 plan 行',
  );
  db.close();
}

async function verifyCommitAtomicity(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();
  const persistenceUrl = transpileToModuleUrl(
    `export const databaseCoordinator = {
      transaction(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.transaction(...args); },
      openTaskExecutor(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.openTaskExecutor(...args); },
    };`,
  );
  const groupRuntimeUrl = transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__SUPERSEDE_COMMIT_GROUP_DEPS__;
    }
  `);
  const commitUrl = loadGroupMessageCommit(persistenceUrl, groupRuntimeUrl);
  const { commitGroupUserMessage } = await import(commitUrl);

  globalThis.__SUPERSEDE_STATE__ = { emits: [] };
  let failRotation = false;
  globalThis.__SUPERSEDE_COMMIT_GROUP_DEPS__ = {
    groups: {
      rotateSpeechPlanForUserMessageInTransaction: async (tx, params) => {
        const rotation = await repository.rotateSpeechPlanForUserMessageInTransaction(tx, params);
        if (failRotation) {
          throw new Error('换代失败注入');
        }
        return rotation;
      },
      // 群预览与消息、换代同一事务 commit（真实 repo 写 group_chats）。
      updatePreviewInTransaction: (...args) => (
        repository.updatePreviewInTransaction(...args)
      ),
    },
    currentUserDirectory: {
      getCurrent: async () => ({ id: 'self', name: '小明', avatar: null }),
    },
  };

  insertGroupChat(db, 'g1');
  insertGroupChat(db, 'g2');
  insertPlan(db, {
    id: 'p-run', groupId: 'g1', status: 'running',
    lastIncludedMessageId: 100, createdAt: NOW,
  });

  const { message, rotation } = await commitGroupUserMessage({ groupId: 'g1', text: '大家停一下' });
  assert.ok(message.id > 0);
  assert.equal(rotation.kind, 'superseded');
  assert.equal(rotation.previousPlanId, 'p-run');
  assert.equal(getPlan(db, 'p-run').status, 'superseded');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE session_id = 'g1'`).get().count,
    1,
    '消息事实必须与换代同事务提交',
  );
  const preview = db.prepare(
    `SELECT last_message AS lastMessage, last_message_id AS lastMessageId
     FROM group_chats WHERE id = 'g1'`,
  ).get();
  assert.equal(preview.lastMessage, '大家停一下', '群预览必须与消息、换代同事务提交');
  assert.equal(preview.lastMessageId, message.id, '群预览必须绑定最新消息事实');
  assert.deepEqual(globalThis.__SUPERSEDE_STATE__.emits, ['g1']);

  // 换代失败时消息不得单独落库：禁止先提交消息再取消旧 plan。
  failRotation = true;
  insertPlan(db, {
    id: 'p-run-2', groupId: 'g2', status: 'running',
    lastIncludedMessageId: 50, createdAt: NOW,
  });
  await assert.rejects(
    () => commitGroupUserMessage({ groupId: 'g2', text: '这条必须整体回滚' }),
    /换代失败注入/,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE session_id = 'g2'`).get().count,
    0,
    '换代失败时消息必须随事务回滚',
  );
  assert.equal(getPlan(db, 'p-run-2').status, 'running', '换代失败时旧 plan 保持原状');
  assert.equal(
    db.prepare(
      `SELECT last_message_id AS lastMessageId FROM group_chats WHERE id = 'g2'`,
    ).get().lastMessageId,
    null,
    '换代失败时群预览必须随事务回滚',
  );
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS count FROM group_speech_plans WHERE group_id = 'g2'`,
    ).get().count,
    1,
    '回滚不得留下 successor 残行',
  );
  db.close();
}

async function verifyActivationOrdering(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();

  // successor 继承队列 [ai-3, ai-1, ai-2]，用户新批次明确 @ ai-2。
  // 激活前置：召唤已接管 plan（pending → preparing），输入窗口已关闭。
  insertPlan(db, {
    id: 's1', groupId: 'g1', status: 'preparing', supersedesPlanId: 'p-old',
    lastIncludedMessageId: 100, createdAt: NOW,
  });
  for (const [index, ai] of ['ai-3', 'ai-1', 'ai-2'].entries()) {
    insertTask(db, {
      id: `ih-${ai}`, planId: 's1', groupId: 'g1', aiAssistantId: ai, agentId: `agent-${ai}`,
      sequenceOrder: index, source: 'inherited_after_user_interrupt', createdAt: NOW,
    });
  }

  const activated = await repository.activateSpeechPlanWithTasks('s1', {
    tasks: [{
      id: 't-mention', groupId: 'g1', aiAssistantId: 'ai-2', agentId: 'agent-ai-2',
      source: 'user_mention',
    }],
    mentionAssistantIds: ['ai-2'],
  });
  assert.equal(activated, true);
  assert.deepEqual(
    listTasks(db, 's1').map((task) => [task.aiAssistantId, task.sequenceOrder, task.source]),
    [
      ['ai-2', 0, 'user_mention'],
      ['ai-3', 1, 'inherited_after_user_interrupt'],
      ['ai-1', 2, 'inherited_after_user_interrupt'],
    ],
    '用户明确 @ 必须排在继承队列之前，并按稳定 assistantId 去除交叉重复',
  );
  const plan = getPlan(db, 's1');
  assert.equal(plan.status, 'running');
  assert.ok(plan.started_at, '激活必须记录 started_at');

  assert.equal(
    await repository.activateSpeechPlanWithTasks('s1', { tasks: [], mentionAssistantIds: [] }),
    false,
    '已激活的 plan 不得重复激活',
  );

  // 无 mention 时继承队列原样保留（顺序不变、不插入新任务）。
  insertPlan(db, {
    id: 's2', groupId: 'g2', status: 'preparing', supersedesPlanId: 'p-x',
    lastIncludedMessageId: 10, createdAt: NOW,
  });
  for (const [index, ai] of ['ai-3', 'ai-1'].entries()) {
    insertTask(db, {
      id: `s2-${ai}`, planId: 's2', groupId: 'g2', aiAssistantId: ai, agentId: `agent-${ai}`,
      sequenceOrder: index, source: 'inherited_after_user_interrupt', createdAt: NOW,
    });
  }
  assert.equal(
    await repository.activateSpeechPlanWithTasks('s2', { tasks: [], mentionAssistantIds: [] }),
    true,
  );
  assert.deepEqual(
    listTasks(db, 's2').map((task) => task.aiAssistantId),
    ['ai-3', 'ai-1'],
    '无用户 @ 时继承队列必须按原顺序直接执行',
  );

  // 终态 plan 拒绝激活且不写入任何任务。
  insertPlan(db, { id: 's3', groupId: 'g3', status: 'superseded', createdAt: NOW });
  assert.equal(
    await repository.activateSpeechPlanWithTasks('s3', {
      tasks: [{
        id: 't-x', groupId: 'g3', aiAssistantId: 'ai-1', agentId: 'agent-1', source: 'admin',
      }],
      mentionAssistantIds: [],
    }),
    false,
  );
  assert.equal(listTasks(db, 's3').length, 0, '终态 plan 不得写入任务');
  db.close();
}

async function verifySchedulerWindow(GroupChatRepository) {
  // 与 verify-group-auto-invocation 相同的假计时器，验证 successor 窗口语义：
  // 从最新消息重置 30 秒，29.999 秒不执行，30 秒恰好执行一次。
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalDateNow = Date.now;
  let now = 1_000;
  let nextHandle = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay = 0) => {
    const handle = nextHandle;
    nextHandle += 1;
    timers.set(handle, { callback, dueAt: now + Number(delay) });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };
  Date.now = () => now;

  async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  async function advanceBy(milliseconds) {
    now += milliseconds;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0]);
      if (due.length === 0) {
        break;
      }
      for (const [handle, timer] of due) {
        if (!timers.delete(handle)) {
          continue;
        }
        timer.callback();
        await flushPromises();
      }
    }
  }

  try {
    const db = createSpeechPlanDatabase();
    globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
    const repository = new GroupChatRepository();
    const persistenceUrl = transpileToModuleUrl(
      `export const databaseCoordinator = {
        transaction(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.transaction(...args); },
        openTaskExecutor(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.openTaskExecutor(...args); },
      };`,
    );
    const commitGroupRuntimeUrl = transpileToModuleUrl(`
      export function getChatGroupRuntimeDependencies() {
        return globalThis.__SUPERSEDE_COMMIT_GROUP_DEPS__;
      }
    `);
    const commitUrl = loadGroupMessageCommit(persistenceUrl, commitGroupRuntimeUrl);
    const schedulerUrl = transpileToModuleUrl(
      read('src/features/chat/group/application/GroupAutoInvocationScheduler.ts'),
    );
    const abortRegistryUrl = loadAbortRegistryUrl();
    const abortRegistry = await import(abortRegistryUrl);
    const { sendGroupUserMessage } = await loadSendGroupUserMessage(
      commitUrl,
      schedulerUrl,
      abortRegistryUrl,
    );

    globalThis.__SUPERSEDE_STATE__ = { emits: [], invokeCalls: [] };
    globalThis.__SUPERSEDE_COMMIT_GROUP_DEPS__ = {
      groups: {
        rotateSpeechPlanForUserMessageInTransaction: (...args) => (
          repository.rotateSpeechPlanForUserMessageInTransaction(...args)
        ),
        updatePreviewInTransaction: (...args) => (
          repository.updatePreviewInTransaction(...args)
        ),
      },
      currentUserDirectory: {
        getCurrent: async () => ({ id: 'self', name: '小明', avatar: null }),
      },
    };
    insertGroupChat(db, 'g1');

    // active plan 执行期间的第一条新消息：原子换代 + abort 旧请求 + 启动 30 秒窗口。
    insertPlan(db, {
      id: 'p-run', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    const staleController = new AbortController();
    abortRegistry.registerGroupSpeechAbort('p-run', staleController);

    await sendGroupUserMessage({ groupId: 'g1', text: '先听我说' });
    assert.equal(staleController.signal.aborted, true, '换代必须 abort 旧 plan 的在途请求');
    assert.equal(getPlan(db, 'p-run').status, 'superseded');
    const successorId = db.prepare(
      `SELECT id FROM group_speech_plans WHERE group_id = 'g1' AND status = 'pending'`,
    ).get().id;

    await advanceBy(29_999);
    assert.deepEqual(
      globalThis.__SUPERSEDE_STATE__.invokeCalls,
      [],
      '29.999 秒不得触发召唤',
    );

    // 窗口内继续发消息：只扩展同一个 successor，并从最新消息重置 30 秒。
    await sendGroupUserMessage({ groupId: 'g1', text: '还有一句' });
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count FROM group_speech_plans
         WHERE group_id = 'g1' AND status IN ('pending', 'running')`,
      ).get().count,
      1,
      '窗口内发消息不得创建第二个 successor',
    );
    assert.equal(
      getPlan(db, successorId).invoked_user_message_ids_json,
      '[1,2]',
      '两条窗口消息都必须进入同一个 successor 的水位',
    );

    await advanceBy(29_999);
    assert.deepEqual(
      globalThis.__SUPERSEDE_STATE__.invokeCalls,
      [],
      '计时必须从最新消息重新计算',
    );
    await advanceBy(1);
    await flushPromises();
    assert.deepEqual(
      globalThis.__SUPERSEDE_STATE__.invokeCalls,
      ['g1'],
      '30 秒恰好执行一次召唤',
    );

    await advanceBy(60_000);
    assert.deepEqual(
      globalThis.__SUPERSEDE_STATE__.invokeCalls,
      ['g1'],
      '窗口关闭后不得重复触发',
    );
    db.close();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalDateNow;
  }
}

function buildMember(aiAssistantId) {
  return {
    id: `member-${aiAssistantId}`,
    groupId: 'g1',
    aiAssistantId,
    agentId: `agent-${aiAssistantId}`,
    displayOrder: 0,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function loadInvokeTestBed(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  insertGroupChat(db, 'g1');
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();
  const groupRuntimeUrl = transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__SUPERSEDE_INVOKE_GROUP_DEPS__;
    }
  `);
  // 真实 GroupMessageCommit：用户消息驱动真实换代，管理员失败提示走真实
  // plan ownership fence，而不是在编排测试桩里提前假定结果。
  const commitPersistenceUrl = transpileToModuleUrl(
    `export const databaseCoordinator = {
      transaction(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.transaction(...args); },
      openTaskExecutor(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.openTaskExecutor(...args); },
    };`,
  );
  const commitUrl = loadGroupMessageCommit(commitPersistenceUrl, groupRuntimeUrl);
  const { invokeGroupChat } = await import(loadInvokeGroupChat(groupRuntimeUrl, commitUrl));
  const { commitGroupUserMessage } = await import(commitUrl);
  globalThis.__SUPERSEDE_STATE__ = {
    currentUserMessages: [],
    inputUpperBoundMessageId: 0,
    captureLowerBounds: [],
    planningOptions: [],
    planningGate: null,
    planningStarted: null,
    sequenceMembers: [],
    mentionedAssistantIds: new Set(),
    adminRequestFailureNotice: null,
    executed: [],
    acknowledged: [],
    settled: [],
    typing: [],
    planChanges: [],
    emits: [],
  };
  globalThis.__SUPERSEDE_INVOKE_GROUP_DEPS__ = {
    groups: {
      getById: async () => ({
        group: {
          id: 'g1', name: '测试群', avatar: null, lastMessage: null, lastTime: null,
          isPinned: false, createdAt: NOW, updatedAt: NOW,
        },
        members: [buildMember('ai-1'), buildMember('ai-2'), buildMember('ai-3')],
        adminConfig: {
          groupId: 'g1', name: '管理员', model: 'admin-model', apiKey: null,
          apiBaseUrl: null, systemPrompt: null, temperature: 0.7, topP: 1,
          maxTokens: null, contextMessageCount: 20, createdAt: NOW, updatedAt: NOW,
        },
      }),
      tryClaimGroupSpeechPlan: (...args) => repository.tryClaimGroupSpeechPlan(...args),
      beginSpeechPlanPreparation: (...args) => repository.beginSpeechPlanPreparation(...args),
      updateSpeechPlanInput: (...args) => repository.updateSpeechPlanInput(...args),
      updateSpeechPlanStatus: (...args) => repository.updateSpeechPlanStatus(...args),
      listSpeechPlanTasks: (...args) => repository.listSpeechPlanTasks(...args),
      activateSpeechPlanWithTasks: (...args) => repository.activateSpeechPlanWithTasks(...args),
      rotateSpeechPlanForUserMessageInTransaction: (...args) => (
        repository.rotateSpeechPlanForUserMessageInTransaction(...args)
      ),
      updatePreviewInTransaction: (...args) => (
        repository.updatePreviewInTransaction(...args)
      ),
      updatePreviewForCommittedMessage: (...args) => (
        repository.updatePreviewForCommittedMessage(...args)
      ),
      isSpeechPlanActiveInTransaction: (...args) => (
        repository.isSpeechPlanActiveInTransaction(...args)
      ),
    },
    currentUserDirectory: {
      getCurrent: async () => ({ id: 'self', name: '小明', avatar: null }),
    },
  };
  return {
    db,
    repository,
    invokeGroupChat,
    commitGroupUserMessage,
    state: globalThis.__SUPERSEDE_STATE__,
  };
}

async function verifySuccessorActivation(GroupChatRepository) {
  // 场景 A：无用户 @、有继承队列——召唤（或 30 秒到期）直接激活 successor，
  // 不请求管理员，按继承顺序执行；窗口起点与输入上界来自换代事实。
  {
    const { db, repository, invokeGroupChat, state } = await loadInvokeTestBed(GroupChatRepository);
    insertPlan(db, {
      id: 'p-old', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-q1', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-3', agentId: 'agent-ai-3',
      sequenceOrder: 0, source: 'admin', createdAt: NOW,
    });
    insertTask(db, {
      id: 't-q2', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-1', agentId: 'agent-ai-1',
      sequenceOrder: 1, source: 'ai_mention', createdAt: NOW,
    });
    const rotation = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
      repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
    ));
    // 本轮输入 40 条，超过 30 条的上下文窗口限制也不得截断本轮输入。
    state.currentUserMessages = Array.from({ length: 40 }, (_, index) => ({
      id: 101 + index,
      text: `窗口消息${index + 1}`,
      isMe: true,
      senderType: 'user',
    }));
    state.inputUpperBoundMessageId = 140;

    const result = await invokeGroupChat('g1');
    assert.equal(result.success, true);
    assert.equal(result.planId, rotation.successorPlanId, '召唤必须激活 pending successor 而不是新建 plan');
    assert.deepEqual(state.captureLowerBounds, [100], 'successor 捕获必须以窗口起点为下界');
    assert.deepEqual(
      state.planningOptions.map(({ hasInheritedSpeechTasks }) => ({ hasInheritedSpeechTasks })),
      [{ hasInheritedSpeechTasks: true }],
      '存在继承队列时必须告知规划器跳过管理员',
    );
    assert.deepEqual(
      state.executed,
      [{ planId: rotation.successorPlanId, userMessageCount: 40, inputUpperBoundMessageId: 140 }],
      '同一 plan 的成员共享同一输入水位，本轮输入不被截断',
    );
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId).map((task) => [task.aiAssistantId, task.source]),
      [['ai-3', 'inherited_after_user_interrupt'], ['ai-1', 'inherited_after_user_interrupt']],
      '无用户 @ 时继承队列按原顺序执行',
    );
    assert.equal(getPlan(db, rotation.successorPlanId).status, 'completed');
    assert.deepEqual(
      state.acknowledged,
      [{ groupId: 'g1', upperBound: 140 }],
      '召唤必须关闭输入窗口（取消 30 秒计时）',
    );
    db.close();
  }

  // 场景 B：新批次用户明确 @ 优先，并与继承队列去交叉重复。
  {
    const { db, repository, invokeGroupChat, state } = await loadInvokeTestBed(GroupChatRepository);
    insertPlan(db, {
      id: 'p-old', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-run', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-2', agentId: 'agent-ai-2',
      sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
    });
    insertTask(db, {
      id: 't-q1', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-3', agentId: 'agent-ai-3',
      sequenceOrder: 1, source: 'admin', createdAt: NOW,
    });
    insertTask(db, {
      id: 't-q2', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-1', agentId: 'agent-ai-1',
      sequenceOrder: 2, source: 'admin', createdAt: NOW,
    });
    const rotation = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
      repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
    ));
    state.currentUserMessages = [{ id: 120, text: '@小二 先回答', isMe: true, senderType: 'user' }];
    state.inputUpperBoundMessageId = 120;
    state.sequenceMembers = [buildMember('ai-2')];
    state.mentionedAssistantIds = new Set(['ai-2']);

    const result = await invokeGroupChat('g1');
    assert.equal(result.success, true);
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId)
        .map((task) => [task.aiAssistantId, task.sequenceOrder, task.source]),
      [
        ['ai-2', 0, 'user_mention'],
        ['ai-3', 1, 'inherited_after_user_interrupt'],
        ['ai-1', 2, 'inherited_after_user_interrupt'],
      ],
      '用户明确 @ 必须排在继承队列前，继承队列中同一 AI 的重复机会被去除',
    );
    db.close();
  }

  // 场景 C：无 @ 且无继承队列——恢复管理员编排（由规划器返回管理员选择）。
  {
    const { db, invokeGroupChat, state } = await loadInvokeTestBed(GroupChatRepository);
    state.currentUserMessages = [{ id: 10, text: '随便聊聊', isMe: true, senderType: 'user' }];
    state.inputUpperBoundMessageId = 10;
    state.sequenceMembers = [buildMember('ai-1'), buildMember('ai-3')];

    const result = await invokeGroupChat('g1');
    assert.equal(result.success, true);
    assert.deepEqual(state.planningOptions.map(({ hasInheritedSpeechTasks }) => ({ hasInheritedSpeechTasks })), [{ hasInheritedSpeechTasks: false }]);
    assert.deepEqual(
      listTasks(db, result.planId).map((task) => [task.aiAssistantId, task.source]),
      [['ai-1', 'admin'], ['ai-3', 'admin']],
      '无 @ 且无继承时必须恢复管理员编排',
    );
    db.close();
  }

  // 场景 D：fresh claim 的瞬时 pending 不是 successor 窗口，重复召唤保持拒止。
  {
    const { db, invokeGroupChat, state } = await loadInvokeTestBed(GroupChatRepository);
    insertPlan(db, { id: 'p-fresh', groupId: 'g1', status: 'pending', createdAt: NOW });
    const result = await invokeGroupChat('g1');
    assert.equal(result.outcome, 'already_running');
    assert.equal(result.planId, 'p-fresh');
    assert.deepEqual(state.planningOptions, [], 'fresh pending 不得被当作 successor 激活');
    db.close();
  }
}

async function verifyAdminSuppression() {
  const { prepareGroupSpeechPlan } = await import(loadPrepareGroupSpeechPlan());
  const profiles = new Map(['ai-1', 'ai-2'].map((id) => [id, {
    id, agentId: `agent-${id}`, name: `小${id.slice(3)}`, avatar: null, model: 'model-x',
    isBlocked: false,
  }]));
  globalThis.__SUPERSEDE_PLANNING_GROUP_DEPS__ = {
    assistantDirectory: { getById: async (id) => profiles.get(id) ?? null },
  };
  const details = {
    group: {
      id: 'g1', name: '测试群', avatar: null, lastMessage: null, lastTime: null,
      isPinned: false, createdAt: NOW, updatedAt: NOW,
    },
    members: [buildMember('ai-1'), buildMember('ai-2')],
    adminConfig: {
      groupId: 'g1', name: '管理员', model: 'admin-model', apiKey: null,
      apiBaseUrl: null, systemPrompt: null, temperature: 0.7, topP: 1,
      maxTokens: null, contextMessageCount: 20, createdAt: NOW, updatedAt: NOW,
    },
  };
  const userMessages = [{ id: 120, text: '继续刚才的话题', isMe: true, senderType: 'user' }];

  globalThis.__SUPERSEDE_PLANNING_STATE__ = { adminCalls: 0 };
  const withInheritance = await prepareGroupSpeechPlan(details, userMessages, {
    hasInheritedSpeechTasks: true,
  });
  assert.equal(
    globalThis.__SUPERSEDE_PLANNING_STATE__.adminCalls,
    0,
    '无用户 @ 但存在继承队列时不得请求管理员',
  );
  assert.deepEqual(withInheritance.sequenceMembers, [], '继承场景的新任务列表必须为空');

  globalThis.__SUPERSEDE_PLANNING_STATE__ = { adminCalls: 0 };
  const withoutInheritance = await prepareGroupSpeechPlan(details, userMessages, {
    hasInheritedSpeechTasks: false,
  });
  assert.equal(
    globalThis.__SUPERSEDE_PLANNING_STATE__.adminCalls,
    1,
    '无 @ 且无继承时管理员只请求一次',
  );
  assert.ok(withoutInheritance.sequenceMembers.length > 0, '管理员结果必须形成发言任务');
}

async function verifyExecutorAbortAndFence(GroupChatRepository) {
  const groupRuntimeUrl = transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__SUPERSEDE_EXEC_GROUP_DEPS__;
    }
  `);
  const turnCommitUrl = buildTurnCommitUrl(groupRuntimeUrl);
  const abortRegistryUrl = loadAbortRegistryUrl();
  const abortRegistry = await import(abortRegistryUrl);
  const { executeGroupSpeechTasks } = await loadGroupTaskExecution(
    groupRuntimeUrl,
    turnCommitUrl,
    abortRegistryUrl,
  );
  // 真实 commitGroupUserMessage：用户消息与换代共享协调器事务，
  // 供"多气泡中途插话"场景驱动真实换代路径。
  const commitPersistenceUrl = transpileToModuleUrl(
    `export const databaseCoordinator = {
      transaction(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.transaction(...args); },
      openTaskExecutor(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.openTaskExecutor(...args); },
    };`,
  );
  const { commitGroupUserMessage } = await import(
    loadGroupMessageCommit(commitPersistenceUrl, groupRuntimeUrl)
  );

  const profiles = new Map(['ai-A', 'ai-B'].map((id) => [id, {
    id, agentId: `agent-${id}`, name: `小${id.slice(3)}`, avatar: null, model: 'model-x',
    apiKey: '', apiBaseUrl: '', isBlocked: false,
  }]));

  function buildExecutionBed(replyScripts) {
    const db = createSpeechPlanDatabase();
    insertGroupChat(db, 'g1');
    globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
    const repository = new GroupChatRepository();
    globalThis.__SUPERSEDE_STATE__ = {
      executions: [],
      signals: {},
      commits: [],
      emits: [],
      replyScripts,
      signalResolve: null,
      commitResolve: null,
    };
    globalThis.__SUPERSEDE_EXEC_GROUP_DEPS__ = {
      groups: {
        claimNextQueuedSpeechTask: (...args) => repository.claimNextQueuedSpeechTask(...args),
        isSpeechTaskCommitEligible: (...args) => repository.isSpeechTaskCommitEligible(...args),
        isSpeechTaskCommitEligibleInTransaction: (...args) => (
          repository.isSpeechTaskCommitEligibleInTransaction(...args)
        ),
        markSpeechTaskReplyCommittedInTransaction: (...args) => (
          repository.markSpeechTaskReplyCommittedInTransaction(...args)
        ),
        rotateSpeechPlanForUserMessageInTransaction: (...args) => (
          repository.rotateSpeechPlanForUserMessageInTransaction(...args)
        ),
        // AI @ AI 任务与 mention 所在气泡同一事务物化（提交接缝在 fence 事务内调用）。
        materializeAIMentionSpeechTasksInTransaction: (...args) => (
          repository.materializeAIMentionSpeechTasksInTransaction(...args)
        ),
        getById: async () => ({ group: { id: 'g1', name: 'test' }, members: [buildMember('ai-A'), buildMember('ai-B')] }),
        getMembers: async () => [buildMember('ai-A'), buildMember('ai-B')],
        updateSpeechTaskStatus: (...args) => repository.updateSpeechTaskStatus(...args),
        updatePreview: async () => true,
        updatePreviewForCommittedMessage: async () => true,
        updatePreviewInTransaction: (...args) => (
          repository.updatePreviewInTransaction(...args)
        ),
      },
      assistantDirectory: { getById: async (id) => profiles.get(id) ?? null },
      currentUserDirectory: {
        getCurrent: async () => ({ id: 'self', name: '小明', avatar: null }),
      },
    };
    globalThis.__SUPERSEDE_DIRECTORY__ = {
      groupId: 'g1',
      currentUser: {
        targetType: 'user', userProfileId: 'self', displayName: '小明', avatar: null,
      },
      assistants: ['ai-A', 'ai-B'].map((id) => ({
        targetType: 'assistant', assistantId: id, displayName: `小${id.slice(3)}`, avatar: null,
      })),
    };
    const details = {
      group: {
        id: 'g1', name: '测试群', avatar: null, lastMessage: null, lastTime: null,
        isPinned: false, createdAt: NOW, updatedAt: NOW,
      },
      members: [buildMember('ai-A'), buildMember('ai-B')],
    };
    return { db, repository, details, state: globalThis.__SUPERSEDE_STATE__ };
  }

  // 场景 13：running 任务在途时换代——abort 旧请求，晚到输出被 fence 拒绝，
  // 未提交可见回复的 running 移到继承队列末尾，终态不被晚到回写覆盖。
  {
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const { db, repository, details, state } = buildExecutionBed({
      'ai-A': { bubbles: ['晚到的旧输出'], gateBeforeIndex: 0, gate },
    });
    insertPlan(db, {
      id: 'p-old', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-run', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', createdAt: NOW,
    });
    insertTask(db, {
      id: 't-queued', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-B', agentId: 'agent-ai-B',
      sequenceOrder: 1, source: 'admin', createdAt: NOW,
    });

    const signalReady = new Promise((resolve) => {
      state.signalResolve = resolve;
    });
    const execution = executeGroupSpeechTasks({
      planId: 'p-old',
      details,
      currentUserMessages: [{ id: 100, text: '之前的问题', isMe: true, senderType: 'user' }],
      inputUpperBoundMessageId: 100,
      memberProfiles: profiles,
    });
    await signalReady;
    assert.equal(state.executions.length, 1, '执行器必须先 claim running 任务');

    const rotation = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
      repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
    ));
    assert.equal(rotation.kind, 'superseded');
    abortRegistry.abortGroupSpeechPlanExecution('p-old');
    assert.equal(state.signals['ai-A'].aborted, true, '换代后必须 abort 在途请求以节约资源');

    openGate();
    await execution;

    assert.deepEqual(state.commits, [], '晚到的旧输出必须被 fence 拒绝落库');
    assert.equal(
      listTasks(db, 'p-old').find((task) => task.id === 't-run').status,
      'superseded',
      'superseded 终态不得被晚到的 failed/completed 回写覆盖',
    );
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId).map((task) => task.aiAssistantId),
      ['ai-B', 'ai-A'],
      'queued 保持相对顺序，未提交可见回复的 running 移到继承队列末尾',
    );
    db.close();
  }

  // 场景 13 多气泡：已提交气泡保留且该 AI 视为已发言，剩余气泡被 fence 拒绝。
  {
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const { db, repository, details, state } = buildExecutionBed({
      'ai-A': { bubbles: ['第一段已提交', '第二段晚到'], gateBeforeIndex: 1, gate },
    });
    insertPlan(db, {
      id: 'p-old', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-run', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', createdAt: NOW,
    });
    insertTask(db, {
      id: 't-queued', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-B', agentId: 'agent-ai-B',
      sequenceOrder: 1, source: 'admin', createdAt: NOW,
    });

    const firstCommit = new Promise((resolve) => {
      state.commitResolve = resolve;
    });
    const execution = executeGroupSpeechTasks({
      planId: 'p-old',
      details,
      currentUserMessages: [{ id: 100, text: '之前的问题', isMe: true, senderType: 'user' }],
      inputUpperBoundMessageId: 100,
      memberProfiles: profiles,
    });
    await firstCommit;
    assert.deepEqual(state.commits, ['第一段已提交']);
    // 可见回复标记由提交接缝在分段落库后异步写入；换代前必须等它落库，
    // 否则继承决策读到的仍是标记前快照。
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const flag = db.prepare(
        `SELECT visible_reply_committed AS flag FROM group_speech_tasks WHERE id = 't-run'`,
      ).get().flag;
      if (flag === 1) {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      db.prepare(
        `SELECT visible_reply_committed AS flag FROM group_speech_tasks WHERE id = 't-run'`,
      ).get().flag,
      1,
      '首个可见分段落库后必须标记 visible_reply_committed',
    );

    const rotation = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
      repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
    ));
    abortRegistry.abortGroupSpeechPlanExecution('p-old');
    openGate();
    await execution;

    assert.deepEqual(state.commits, ['第一段已提交'], '已提交气泡保留，剩余气泡不得落库');
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId).map((task) => task.aiAssistantId),
      ['ai-B'],
      '已提交可见回复的 AI 视为已发言，不重新继承',
    );
    assert.equal(
      listTasks(db, 'p-old').find((task) => task.id === 't-run').status,
      'superseded',
    );
    db.close();
  }

  // 场景 14：多气泡回复中途用户插话（真实 commitGroupUserMessage 换代路径）。
  // 第 2 泡前 gate；gate 期间完成换代后：第 1 泡保留、第 2/3 泡被逐泡 fence
  // 拒绝入库；已提交可见回复的任务不进继承队列，同 plan 无输出的 running
  // 任务移到 successor 队尾。
  {
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const { db, details, state } = buildExecutionBed({
      'ai-A': {
        bubbles: ['第一泡已落库', '第二泡不得落库', '第三泡不得落库'],
        gateBeforeIndex: 1,
        gate,
      },
    });
    insertPlan(db, {
      id: 'p-old', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-run', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', createdAt: NOW,
    });
    // 同一 plan 另一个在途但尚无输出的 running 任务（如厂商请求尚未返回）。
    insertTask(db, {
      id: 't-run-quiet', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-B', agentId: 'agent-ai-B',
      sequenceOrder: 1, source: 'admin', status: 'running', createdAt: NOW,
    });
    insertTask(db, {
      id: 't-queued', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-C', agentId: 'agent-ai-C',
      sequenceOrder: 2, source: 'admin', createdAt: NOW,
    });

    const firstCommit = new Promise((resolve) => {
      state.commitResolve = resolve;
    });
    const execution = executeGroupSpeechTasks({
      planId: 'p-old',
      details,
      currentUserMessages: [{ id: 100, text: '之前的问题', isMe: true, senderType: 'user' }],
      inputUpperBoundMessageId: 100,
      memberProfiles: profiles,
    });
    await firstCommit;
    assert.equal(
      db.prepare(
        `SELECT visible_reply_committed AS flag FROM group_speech_tasks WHERE id = 't-run'`,
      ).get().flag,
      1,
      '首泡落库与可见回复标记必须在同一事务完成，换代前已可见',
    );

    // gate 期间用户发新消息：消息事实与换代在同一事务提交。
    const { rotation } = await commitGroupUserMessage({ groupId: 'g1', text: '用户中途插话' });
    assert.equal(rotation.kind, 'superseded');
    assert.equal(rotation.previousPlanId, 'p-old');
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId).map((task) => task.aiAssistantId),
      ['ai-C', 'ai-B'],
      '已提交可见回复的 ai-A 视为已发言不进继承队列；无输出的 running 移到队尾',
    );

    openGate();
    await execution;

    const committedTexts = db.prepare(
      `SELECT text FROM messages WHERE session_id = 'g1'`,
    ).all().map((row) => row.text);
    assert.ok(committedTexts.includes('第一泡已落库'), '已提交的气泡必须保留');
    assert.ok(!committedTexts.includes('第二泡不得落库'), '换代后的第 2 泡不得入库');
    assert.ok(!committedTexts.includes('第三泡不得落库'), '第 2 泡被拒后第 3 泡不得再尝试入库');
    const finalTask = listTasks(db, 'p-old').find((task) => task.id === 't-run');
    assert.equal(finalTask.status, 'superseded', '晚到终态回写不得覆盖 superseded');
    assert.equal(finalTask.visibleReplyCommitted, 1, '已发言事实必须保持');
    db.close();
  }

  // 场景 15：@B 出现在非最终泡、最终泡之前被换代——第一泡已经说出口，
  // 因此 B 的任务随第一泡提交成为持久事实，并在换代时公平继承进 successor。
  {
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });
    const { db, details, state } = buildExecutionBed({
      'ai-A': {
        bubbles: ['@小B 第一泡已落库', '第二泡不得落库'],
        gateBeforeIndex: 1,
        gate,
      },
    });
    insertPlan(db, {
      id: 'p-old', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-run', planId: 'p-old', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', createdAt: NOW,
    });

    const firstCommit = new Promise((resolve) => {
      state.commitResolve = resolve;
    });
    const execution = executeGroupSpeechTasks({
      planId: 'p-old',
      details,
      currentUserMessages: [{ id: 100, text: '之前的问题', isMe: true, senderType: 'user' }],
      inputUpperBoundMessageId: 100,
      memberProfiles: profiles,
    });
    await firstCommit;
    const spokenMentionTask = listTasks(db, 'p-old')
      .find((task) => task.aiAssistantId === 'ai-B');
    assert.ok(spokenMentionTask, '非最终泡已说出的 "@AI" 必须随该泡原子物化任务');
    assert.equal(spokenMentionTask.status, 'queued');

    const { rotation } = await commitGroupUserMessage({ groupId: 'g1', text: '用户中途插话' });
    assert.equal(rotation.kind, 'superseded');
    openGate();
    await execution;

    const committedTexts = db.prepare(
      `SELECT text FROM messages WHERE session_id = 'g1'`,
    ).all().map((row) => row.text);
    assert.ok(committedTexts.includes('@小B 第一泡已落库'), '已提交的非最终泡必须保留');
    assert.ok(!committedTexts.includes('第二泡不得落库'), '换代后的最终泡不得入库');
    assert.equal(
      listTasks(db, 'p-old').find((task) => task.aiAssistantId === 'ai-B').status,
      'superseded',
      '旧 plan 中已说出口的 mention 任务必须随换代进入 superseded 终态',
    );
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId)
        .filter((task) => task.aiAssistantId === 'ai-B')
        .map((task) => [task.status, task.source]),
      [['queued', 'inherited_after_user_interrupt']],
      '已说出口的 "@AI" 任务必须进入 successor（已发言的 A 不继承）',
    );
    db.close();
  }

}

// 晚到终态回写的 CAS 守卫：被换代裁决为终态的 plan/task 不得被旧执行上下文
// 的 skipped/completed 回写覆盖（仓库级行为）。
async function verifyTerminalCasGuards(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();

  insertPlan(db, {
    id: 'p-cas', groupId: 'g1', status: 'running',
    lastIncludedMessageId: 100, createdAt: NOW,
  });
  insertTask(db, {
    id: 't-cas', planId: 'p-cas', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
    sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
  });

  // 换代事务已把 running 任务裁决为 superseded 后，执行器晚到的 skipped
  // 回写必须被 expectedStatus CAS 拒绝。
  db.prepare(
    `UPDATE group_speech_tasks SET status = 'superseded' WHERE id = 't-cas'`,
  ).run();
  assert.equal(
    await repository.updateSpeechTaskStatus('t-cas', 'skipped', { expectedStatus: 'running' }),
    false,
    '任务已进入 superseded 终态后，晚到的 skipped 回写必须被 CAS 拒绝',
  );
  assert.equal(
    db.prepare(`SELECT status FROM group_speech_tasks WHERE id = 't-cas'`).get().status,
    'superseded',
    '被拒绝的 skipped 回写不得覆盖 superseded 终态',
  );

  // plan 被换代后，晚到的 completed 回写同样必须被 CAS 拒绝。
  const rotation = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
    repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
  ));
  assert.equal(rotation.kind, 'superseded');
  assert.equal(
    await repository.updateSpeechPlanStatus('p-cas', 'completed', { expectedStatus: ['running'] }),
    false,
    'plan 已进入 superseded 终态后，晚到的 completed 回写必须被 CAS 拒绝',
  );
  assert.equal(
    getPlan(db, 'p-cas').status,
    'superseded',
    '被拒绝的 completed 回写不得覆盖 superseded 终态',
  );
  db.close();
}

// 强制终止的持久层行为：plan 与未到终态任务同一事务裁决为 terminated；提交
// 资格、claim 资格与继承资格同时撤销，但已到终态的任务不被改写；终止不建立
// 继承链，active 槽位释放后可以重新召唤。
async function verifyForceTermination(GroupChatRepository) {
  const db = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();

  insertPlan(db, {
    id: 'p-term', groupId: 'g1', status: 'running',
    lastIncludedMessageId: 100, createdAt: NOW,
  });
  insertTask(db, {
    id: 't-term-run', planId: 'p-term', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
    sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
  });
  insertTask(db, {
    id: 't-term-queue', planId: 'p-term', groupId: 'g1', aiAssistantId: 'ai-B', agentId: 'agent-ai-B',
    sequenceOrder: 1, source: 'user_mention', status: 'queued', createdAt: NOW,
  });
  insertTask(db, {
    id: 't-term-done', planId: 'p-term', groupId: 'g1', aiAssistantId: 'ai-C', agentId: 'agent-ai-C',
    sequenceOrder: 2, source: 'admin', status: 'completed', createdAt: NOW,
  });

  const terminatedPlanId = await repository.terminateActiveSpeechPlan('g1');
  assert.equal(terminatedPlanId, 'p-term', '强制终止必须返回被终止的 active plan');

  const plan = getPlan(db, 'p-term');
  assert.equal(plan.status, 'terminated');
  assert.ok(plan.completed_at, 'terminated plan 必须记录完成时间');

  const tasks = listTasks(db, 'p-term');
  assert.equal(
    tasks.find((task) => task.id === 't-term-run').status,
    'terminated',
    'running 任务必须同事务失去提交资格',
  );
  assert.equal(
    tasks.find((task) => task.id === 't-term-queue').status,
    'terminated',
    'queued 任务必须同事务失去资格',
  );
  assert.equal(
    tasks.find((task) => task.id === 't-term-done').status,
    'completed',
    '已到终态的任务不得被终止改写',
  );

  // 提交资格已被持久撤销：fence 拒绝晚到输出，晚到终态回写被 CAS 拒绝，
  // queued 任务不再可 claim。
  assert.equal(
    await repository.isSpeechTaskCommitEligible('p-term', 't-term-run'),
    false,
    '被终止任务的晚到输出必须被 fence 拒绝',
  );
  assert.equal(
    await repository.updateSpeechTaskStatus('t-term-run', 'completed', { expectedStatus: 'running' }),
    false,
    'terminated 终态不得被晚到的 completed 回写覆盖',
  );
  assert.equal(
    listTasks(db, 'p-term').find((task) => task.id === 't-term-run').status,
    'terminated',
  );
  assert.equal(
    await repository.claimNextQueuedSpeechTask('p-term'),
    null,
    '被终止 plan 的 queued 任务不得再被 claim',
  );

  // 终止不建立继承链：后续用户消息不触发换代，不产生 successor。
  const rotation = await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
    repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
  ));
  assert.equal(
    rotation.kind,
    'no_active_plan',
    '强制终止后的新消息不得产生 successor 或继承队列',
  );

  // active 槽位已释放：下一批无 @ 用户消息可以重新进入管理员编排（fresh claim）。
  const claim = await repository.tryClaimGroupSpeechPlan('g1');
  assert.equal(claim.claimed, true, '强制终止后必须能重新召唤');

  // 处于 pending（30 秒输入窗口）的 plan 同样可被终止。
  assert.equal(await repository.terminateActiveSpeechPlan('g1'), claim.plan.id);
  assert.equal(getPlan(db, claim.plan.id).status, 'terminated');

  assert.equal(
    await repository.terminateActiveSpeechPlan('g1'),
    null,
    '无 active plan 时强制终止必须为 no-op',
  );
  db.close();
}

// 强制终止 command 的顺序约束：先持久撤销资格，commit 后才 abort 在途请求并
// 取消 30 秒自动召唤计时。
async function verifyForceTerminationCommand(GroupChatRepository) {
  const groupRuntimeUrl = transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__SUPERSEDE_TERMINATE_GROUP_DEPS__;
    }
  `);
  const abortRegistryUrl = loadAbortRegistryUrl();
  const schedulerUrl = transpileToModuleUrl(`
    export function cancelGroupAutoInvocation(groupId) {
      globalThis.__SUPERSEDE_STATE__.cancelled.push(groupId);
    }
  `);
  const eventsUrl = transpileToModuleUrl(`
    export function emitChatGroupSpeechPlanChanged(groupId) {
      const state = globalThis.__SUPERSEDE_STATE__;
      state.planChanges.push(groupId);
      state.onPlanChange?.(groupId);
    }
  `);
  const source = read('src/features/chat/group/application/GroupSpeechTermination.ts')
    .replace(/from ['"]\.\/ChatGroupRuntime['"]/g, `from '${groupRuntimeUrl}'`)
    .replace(/from ['"]\.\/GroupSpeechExecutionAbort['"]/g, `from '${abortRegistryUrl}'`)
    .replace(/from ['"]\.\/GroupAutoInvocationScheduler['"]/g, `from '${schedulerUrl}'`)
    .replace(
      /from ['"]\.\.\/\.\.\/messages\/events\/ChatEvents['"]/g,
      `from '${eventsUrl}'`,
    );
  const { terminateGroupSpeechPlan } = await import(transpileToModuleUrl(source));
  const { registerGroupSpeechAbort } = await import(abortRegistryUrl);

  const db = createSpeechPlanDatabase();
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();
  globalThis.__SUPERSEDE_TERMINATE_GROUP_DEPS__ = { groups: repository };
  globalThis.__SUPERSEDE_STATE__ = { cancelled: [], planChanges: [], onPlanChange: null };

  insertPlan(db, {
    id: 'p-cmd', groupId: 'g1', status: 'running',
    lastIncludedMessageId: 100, createdAt: NOW,
  });
  insertTask(db, {
    id: 't-cmd', planId: 'p-cmd', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
    sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
  });

  const controller = new AbortController();
  let statusAtAbort = null;
  let statusAtPlanChange = null;
  globalThis.__SUPERSEDE_STATE__.onPlanChange = () => {
    statusAtPlanChange = getPlan(db, 'p-cmd').status;
  };
  controller.signal.addEventListener('abort', () => {
    statusAtAbort = getPlan(db, 'p-cmd').status;
  });
  const unregister = registerGroupSpeechAbort('p-cmd', controller);

  assert.equal(await terminateGroupSpeechPlan('g1'), true);
  assert.equal(controller.signal.aborted, true, 'commit 后必须 abort 在途请求');
  assert.equal(statusAtPlanChange, 'terminated', 'plan 变化事件必须发布在事务 commit 之后');
  assert.deepEqual(globalThis.__SUPERSEDE_STATE__.planChanges, ['g1']);
  assert.equal(statusAtAbort, 'terminated', 'abort 之前持久层必须已完成资格撤销');
  assert.deepEqual(
    globalThis.__SUPERSEDE_STATE__.cancelled,
    ['g1'],
    '强制终止必须取消 30 秒自动召唤计时',
  );

  unregister();
  assert.equal(await terminateGroupSpeechPlan('g1'), false, '重复强制终止必须为 no-op');
  db.close();
}

// 逐泡提交 fence 的接缝级行为：active plan + running task 时气泡落库与可见
// 标记同事务提交；换代后 fence 拒绝且不产生新行；错误气泡与正常气泡走同一
// fence 事务；"@AI" 可见事实与调度后果同一 commit 边界裁决。
async function verifyPerBubbleCommitFence(GroupChatRepository) {
  const groupRuntimeUrl = transpileToModuleUrl(`
    export function getChatGroupRuntimeDependencies() {
      return globalThis.__SUPERSEDE_FENCE_GROUP_DEPS__;
    }
  `);
  const turnCommitUrl = buildTurnCommitUrl(groupRuntimeUrl);
  const { createGroupSegmentedReplyPersistence } = await import(turnCommitUrl);
  // 真实 commitGroupUserMessage：错误气泡与 @ 任务边界场景驱动真实换代路径。
  const commitPersistenceUrl = transpileToModuleUrl(
    `export const databaseCoordinator = {
      transaction(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.transaction(...args); },
      openTaskExecutor(...args) { return globalThis.__SUPERSEDE_COORDINATOR__.openTaskExecutor(...args); },
    };`,
  );
  const { commitGroupUserMessage } = await import(
    loadGroupMessageCommit(commitPersistenceUrl, groupRuntimeUrl)
  );

  const profiles = new Map(['ai-A', 'ai-B'].map((id) => [id, {
    id, agentId: `agent-${id}`, name: `小${id.slice(3)}`, avatar: null, model: 'model-x',
    apiKey: '', apiBaseUrl: '', isBlocked: false,
  }]));

  function buildFenceBed() {
    const db = createSpeechPlanDatabase();
    insertGroupChat(db, 'g1');
    globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
    const repository = new GroupChatRepository();
    globalThis.__SUPERSEDE_STATE__ = { commits: [], emits: [] };
    globalThis.__SUPERSEDE_FENCE_GROUP_DEPS__ = {
      groups: {
        isSpeechTaskCommitEligible: (...args) => repository.isSpeechTaskCommitEligible(...args),
        isSpeechTaskCommitEligibleInTransaction: (...args) => (
          repository.isSpeechTaskCommitEligibleInTransaction(...args)
        ),
        markSpeechTaskReplyCommittedInTransaction: (...args) => (
          repository.markSpeechTaskReplyCommittedInTransaction(...args)
        ),
        rotateSpeechPlanForUserMessageInTransaction: (...args) => (
          repository.rotateSpeechPlanForUserMessageInTransaction(...args)
        ),
        // AI @ AI 任务与 mention 所在气泡同一事务物化。
        materializeAIMentionSpeechTasksInTransaction: (...args) => (
          repository.materializeAIMentionSpeechTasksInTransaction(...args)
        ),
        getById: async () => ({ group: { id: 'g1', name: 'test' }, members: [buildMember('ai-A'), buildMember('ai-B')] }),
        getMembers: async () => [buildMember('ai-A'), buildMember('ai-B')],
        updatePreviewInTransaction: (...args) => (
          repository.updatePreviewInTransaction(...args)
        ),
      },
      assistantDirectory: { getById: async (id) => profiles.get(id) ?? null },
      currentUserDirectory: {
        getCurrent: async () => ({ id: 'self', name: '小明', avatar: null }),
      },
    };
    const directory = {
      groupId: 'g1',
      currentUser: {
        targetType: 'user', userProfileId: 'self', displayName: '小明', avatar: null,
      },
      assistants: ['ai-A', 'ai-B'].map((id) => ({
        targetType: 'assistant', assistantId: id, displayName: `小${id.slice(3)}`, avatar: null,
      })),
    };
    return { db, repository, directory, state: globalThis.__SUPERSEDE_STATE__ };
  }

  function buildPersistence(directory, planId, taskId, sequenceOrder = 0) {
    return createGroupSegmentedReplyPersistence({
      directory,
      task: {
        id: taskId,
        planId,
        groupId: 'g1',
        aiAssistantId: 'ai-A',
        sequenceOrder,
      },
    });
  }

  function persistBubble(persistence, text, extraResponse = {}) {
    return persistence.commitAgentTimeline({
      items: [{message:{sessionId:'g1',text,senderType:'assistant',metadataJson:JSON.stringify({groupChat:{mentions:[]}}),...extraResponse}}],
      response: { text, ...extraResponse },
      repository: {},
      runtimeContext: { groupChat: { groupId: 'g1' } },
    });
  }

  async function persistSegments(persistence, segments, beforeSegment) {
    for(const [segmentIndex,text] of segments.entries()) {
      await beforeSegment?.(segmentIndex);
      await persistBubble(persistence,text,{segmentIndex,segmentTotal:segments.length});
    }
  }

  // 逐泡 fence：气泡 INSERT 与 visible_reply_committed 标记同事务落库；
  // 换代后 fence 拒绝（ChatReplyRunCancelledError）且不产生新行；
  // confirmCommitEligible 探针在换代前后分别返回 true/false。
  {
    const { db, repository, directory } = buildFenceBed();
    insertPlan(db, {
      id: 'p-fence', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-fence', planId: 'p-fence', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
    });
    const persistence = buildPersistence(directory, 'p-fence', 't-fence');

    assert.equal(
      await persistence.confirmCommitEligible(),
      true,
      'active plan 的 running 任务必须保有提交资格',
    );
    await persistBubble(persistence, '第一泡正常落库');
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE session_id = 'g1' AND text = '第一泡正常落库'`,
      ).get().count,
      1,
      'active plan + running 任务的气泡必须落库',
    );
    assert.equal(
      db.prepare(
        `SELECT visible_reply_committed AS flag FROM group_speech_tasks WHERE id = 't-fence'`,
      ).get().flag,
      1,
      '气泡 INSERT 与可见回复标记必须在同一事务落库',
    );

    await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, (tx) => (
      repository.rotateSpeechPlanForUserMessageInTransaction(tx, { groupId: 'g1', userMessageId: 120 })
    ));
    assert.equal(
      await persistence.confirmCommitEligible(),
      false,
      'plan 换代后错误落库门控探针必须失去资格',
    );
    await assert.rejects(
      () => persistBubble(persistence, '换代后晚到的气泡'),
      (error) => error && error.name === 'ChatReplyRunCancelledError',
      '换代后的气泡提交必须被 fence 以取消错误拒绝',
    );
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE session_id = 'g1' AND text = '换代后晚到的气泡'`,
      ).get().count,
      0,
      'fence 拒绝的气泡不得产生新的消息行',
    );
    db.close();
  }

  // 错误气泡与正常气泡走同一 fence 事务：探针通过后被换代的晚到错误气泡
  // 必须被事务内 fence 拒绝，不产生新消息行。
  {
    const { db, directory } = buildFenceBed();
    insertPlan(db, {
      id: 'p-err', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-err', planId: 'p-err', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
    });
    const persistence = buildPersistence(directory, 'p-err', 't-err');
    assert.equal(
      await persistence.confirmCommitEligible(),
      true,
      '换代前错误落库门控探针必须保有资格',
    );

    // 探针之后、错误气泡落库之前发生真实换代。
    await commitGroupUserMessage({ groupId: 'g1', text: '换代插话' });
    assert.equal(getPlan(db, 'p-err').status, 'superseded');

    const decorated = persistence.decorateCommitRepository({});
    await assert.rejects(
      () => decorated.commitMessage({
        message: {
          sessionId: 'g1',
          text: '晚到的错误气泡',
          senderType: 'system',
          metadataJson: null,
        },
        previewText: '晚到的错误气泡',
      }),
      (error) => error && error.name === 'ChatReplyRunCancelledError',
      '错误气泡必须被事务内 fence 以取消错误拒绝',
    );
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE session_id = 'g1' AND text = '晚到的错误气泡'`,
      ).get().count,
      0,
      'fence 拒绝的错误气泡不得产生新的消息行',
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE session_id = 'g1'`).get().count,
      1,
      '错误气泡拒绝不得影响已提交的用户消息',
    );
    db.close();
  }

  // "@AI" 与发言任务同一 commit 边界：mention 所在气泡一旦提交便物化任务；
  // 随后的真实换代把该 queued 任务继承进 successor。
  {
    const { db, directory } = buildFenceBed();
    insertPlan(db, {
      id: 'p-mention', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-mention', planId: 'p-mention', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
    });
    const persistence = buildPersistence(directory, 'p-mention', 't-mention');

    await persistBubble(persistence, '好的 @小B 接着说');
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE session_id = 'g1' AND text = '好的 @小B 接着说'`,
      ).get().count,
      1,
      '含 "@AI" 的回复必须正常落库',
    );
    const mentionTask = listTasks(db, 'p-mention')
      .find((task) => task.aiAssistantId === 'ai-B');
    assert.ok(mentionTask, '"@AI" 可见事实与发言任务必须同一 commit 边界物化');
    assert.equal(mentionTask.status, 'queued');
    assert.equal(mentionTask.source, 'ai_mention');

    // 真实换代：B 的 queued 任务被继承进 successor（A 已发言不继承）。
    const { rotation } = await commitGroupUserMessage({ groupId: 'g1', text: '新的用户输入' });
    assert.equal(rotation.kind, 'superseded');
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId)
        .map((task) => [task.aiAssistantId, task.source]),
      [['ai-B', 'inherited_after_user_interrupt']],
      '已物化的 "@AI" 任务必须随换代继承进 successor',
    );
    db.close();
  }

  // future-turn coverage 不抹掉 mention 事实：A 后已有 queued B 时，A @B 的
  // 每个已提交气泡都保留 metadata，但不再重复创建 B；正文中的 self mention
  // 也保留原文且不产生调度任务。
  {
    const { db, directory } = buildFenceBed();
    insertPlan(db, {
      id: 'p-covered', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-covered-a', planId: 'p-covered', groupId: 'g1', aiAssistantId: 'ai-A',
      agentId: 'agent-ai-A', sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
    });
    insertTask(db, {
      id: 't-covered-b', planId: 'p-covered', groupId: 'g1', aiAssistantId: 'ai-B',
      agentId: 'agent-ai-B', sequenceOrder: 1, source: 'admin', status: 'queued', createdAt: NOW,
    });
    const persistence = buildPersistence(directory, 'p-covered', 't-covered-a');

    await persistBubble(persistence, '第一泡 @小B 接着说', { segmentIndex: 0, segmentTotal: 2 });
    await persistBubble(persistence, '第二泡再次 @小B', { segmentIndex: 1, segmentTotal: 2 });
    await persistBubble(persistence, '我自己 @小A 也想想');

    assert.equal(
      listTasks(db, 'p-covered').filter((task) => task.aiAssistantId === 'ai-B').length,
      1,
      '来源之后已有 queued B 时，跨气泡重复 @B 只能复用 future turn',
    );
    assert.equal(
      listTasks(db, 'p-covered').filter((task) => task.aiAssistantId === 'ai-A').length,
      1,
      'self mention 不得创建 ai_mention 任务',
    );
    const committedMessages = db.prepare(
      `SELECT text, metadata_json AS metadataJson
       FROM messages WHERE session_id = 'g1' ORDER BY id ASC`,
    ).all();
    assert.deepEqual(
      committedMessages.map((message) => message.text),
      ['第一泡 @小B 接着说', '第二泡再次 @小B', '我自己 @小A 也想想'],
      'covered/self scheduling 不得改写可见正文',
    );
    assert.equal(
      JSON.parse(committedMessages[0].metadataJson).groupChat.mentions[0].target.assistantId,
      'ai-B',
      '被 future coverage 吸收的 mention metadata 仍必须保留',
    );
    const { rotation } = await commitGroupUserMessage({
      groupId: 'g1',
      text: '在 B 发言前插话',
    });
    assert.equal(rotation.kind, 'superseded');
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId)
        .filter((task) => task.aiAssistantId === 'ai-B')
        .map((task) => [task.status, task.source]),
      [['queued', 'inherited_after_user_interrupt']],
      '被 future coverage 复用的 B 发言机会必须且只能继承一次',
    );
    db.close();
  }

  // 含 "@AI" 的第一泡已经说出口：即使后续气泡被换代拦截，B 的任务也已是
  // 持久事实，并应公平继承进 successor。
  {
    const { db, directory } = buildFenceBed();
    insertPlan(db, {
      id: 'p-partial', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-partial', planId: 'p-partial', groupId: 'g1', aiAssistantId: 'ai-A', agentId: 'agent-ai-A',
      sequenceOrder: 0, source: 'admin', status: 'running', createdAt: NOW,
    });
    const persistence = buildPersistence(directory, 'p-partial', 't-partial');

    await persistBubble(persistence, '第一泡 @小B 你先说', { segmentIndex: 0, segmentTotal: 2 });
    const spokenMentionTask = listTasks(db, 'p-partial')
      .find((task) => task.aiAssistantId === 'ai-B');
    assert.ok(spokenMentionTask, '非最终气泡中的可见 "@AI" 必须随该气泡原子物化任务');
    assert.equal(spokenMentionTask.status, 'queued');

    const { rotation } = await commitGroupUserMessage({ groupId: 'g1', text: '中途插话' });
    assert.equal(rotation.kind, 'superseded');
    await assert.rejects(
      () => persistBubble(persistence, '第二泡尚未说出口', { segmentIndex: 1, segmentTotal: 2 }),
      (error) => error && error.name === 'ChatReplyRunCancelledError',
      '换代后的后续气泡必须被 fence 拒绝',
    );
    assert.equal(
      listTasks(db, 'p-partial').find((task) => task.aiAssistantId === 'ai-B').status,
      'superseded',
      '旧 plan 中已经说出口的 mention 任务必须随 plan 一起进入 superseded 终态',
    );
    assert.deepEqual(
      listTasks(db, rotation.successorPlanId)
        .filter((task) => task.aiAssistantId === 'ai-B')
        .map((task) => [task.status, task.source]),
      [['queued', 'inherited_after_user_interrupt']],
      '已经说出口的 "@AI" 任务必须公平继承进 successor',
    );
    db.close();
  }

  // mention 所在气泡未提交：前一泡普通文字可以保留，但换代后含 @ 的后续泡
  // 被 fence 拒绝。整轮 metadata 不得被复制到前泡，旧 plan 与 successor 也不得
  // 凭空出现 B 的任务。
  {
    const { db, directory } = buildFenceBed();
    insertPlan(db, {
      id: 'p-unspoken', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-unspoken', planId: 'p-unspoken', groupId: 'g1',
      aiAssistantId: 'ai-A', agentId: 'agent-ai-A', sequenceOrder: 0,
      source: 'admin', status: 'running', createdAt: NOW,
    });
    const persistence = buildPersistence(directory, 'p-unspoken', 't-unspoken');

    let rotation = null;
    await assert.rejects(
      () => persistSegments(
        persistence,
        ['第一泡普通文字', '第二泡 @小B 你怎么看'],
        async (segmentIndex) => {
          if (segmentIndex === 1) {
            ({ rotation } = await commitGroupUserMessage({
              groupId: 'g1',
              text: 'mention 前插话',
            }));
          }
        },
      ),
      (error) => error && error.name === 'ChatReplyRunCancelledError',
      '未说出口的 mention 气泡必须被 fence 拒绝',
    );
    assert.equal(rotation.kind, 'superseded');
    const committedMessage = db.prepare(
      `SELECT text, metadata_json AS metadataJson FROM messages
       WHERE session_id = 'g1' ORDER BY id ASC`,
    ).get();
    assert.equal(committedMessage.text, '第一泡普通文字');
    assert.deepEqual(
      JSON.parse(committedMessage.metadataJson).groupChat.mentions,
      [],
      '后泡未提交的 @ 必须不出现在前泡的 metadata',
    );
    assert.equal(
      listTasks(db, 'p-unspoken').filter((task) => task.aiAssistantId === 'ai-B').length,
      0,
      'mention 气泡未提交时旧 plan 不得产生 B 任务',
    );
    assert.equal(
      listTasks(db, rotation.successorPlanId)
        .filter((task) => task.aiAssistantId === 'ai-B').length,
      0,
      '未物化的 B 发言机会不得被 successor 继承',
    );
    db.close();
  }

  // 不同气泡的 mention 必须分别持久化，不能把整条回复的目标复制给每个气泡。
  {
    const { db, directory } = buildFenceBed();
    insertPlan(db, {
      id: 'p-segment-mentions', groupId: 'g1', status: 'running',
      lastIncludedMessageId: 100, createdAt: NOW,
    });
    insertTask(db, {
      id: 't-segment-mentions', planId: 'p-segment-mentions', groupId: 'g1',
      aiAssistantId: 'ai-A', agentId: 'agent-ai-A', sequenceOrder: 0,
      source: 'admin', status: 'running', createdAt: NOW,
    });
    await persistSegments(
      buildPersistence(directory, 'p-segment-mentions', 't-segment-mentions'),
      ['第一泡 @小明', '第二泡 @小B'],
    );
    const committedMessages = db.prepare(
      `SELECT metadata_json AS metadataJson FROM messages
       WHERE session_id = 'g1' ORDER BY id ASC`,
    ).all();
    assert.deepEqual(
      committedMessages.map((message) => JSON.parse(message.metadataJson).groupChat.mentions[0].target),
      [
        { targetType: 'user', userProfileId: 'self', displayNameAtSend: '小明' },
        { targetType: 'assistant', assistantId: 'ai-B', displayNameAtSend: '小B' },
      ],
      'mention metadata 必须与对应可见气泡一一对应',
    );
    assert.equal(
      listTasks(db, 'p-segment-mentions').filter((task) => task.aiAssistantId === 'ai-B').length,
      1,
      '第二泡的 AI mention 仍在该气泡事务内物化调度后果',
    );
    db.close();
  }
}

// planning 中途用户插话：召唤已接管 plan（preparing，输入窗口已关闭）后到达的
// 用户消息必须触发换代而不是窗口扩展；规划结果晚到时激活失败、安静退出。
/** 公共Agent timeline的媒体条目进入同一群提交接缝，物化与消息共享fence和事务。 */
async function verifyGroupMediaTimeline(GroupChatRepository) {
  const groupRuntimeUrl=transpileToModuleUrl(`export function getChatGroupRuntimeDependencies(){return globalThis.__GROUP_MEDIA_DEPS__;}`);
  const {createGroupSegmentedReplyPersistence}=await import(buildTurnCommitUrl(groupRuntimeUrl));
  const db=createSpeechPlanDatabase();insertGroupChat(db,'g1');
  globalThis.__SUPERSEDE_COORDINATOR__=createCoordinator(db);
  const repository=new GroupChatRepository();
  globalThis.__GROUP_MEDIA_DEPS__={groups:repository};
  const directory={groupId:'g1',currentUser:{targetType:'user',userProfileId:'self',displayName:'用户'},assistants:[]};
  db.exec('CREATE TABLE prepared_voice_assets(id TEXT PRIMARY KEY);');
  const seed=(planId,taskId)=>{
    insertPlan(db,{id:planId,groupId:'g1',status:'running',lastIncludedMessageId:100,createdAt:NOW});
    insertTask(db,{id:taskId,planId,groupId:'g1',aiAssistantId:'ai-A',agentId:'agent-ai-A',sequenceOrder:0,source:'admin',status:'running',createdAt:NOW});
    return createGroupSegmentedReplyPersistence({directory,task:{id:taskId,planId,groupId:'g1',aiAssistantId:'ai-A',sequenceOrder:0}});
  };
  let finalized=0,discarded=0,materialized=0;
  const voice=(id)=>({message:{sessionId:'g1',text:'语音正文',senderType:'assistant',metadataJson:JSON.stringify({groupChat:{mentions:[]},type:'voice',transcript:'语音正文'})},
    materializeInTransaction:async(tx,message)=>{materialized++;await tx.runAsync('INSERT INTO prepared_voice_assets VALUES (?)',[id]);return {...message,metadataJson:JSON.stringify({...JSON.parse(message.metadataJson),mediaAssetId:id})};},
    finalizeAfterCommit:async()=>{finalized++;},discardAfterRollback:async()=>{discarded++;}});
  const params=(items,callbacks={})=>({sessionId:'g1',items,repository:{},response:{text:''},runtimeContext:{groupChat:{groupId:'g1'}},callbacks});
  const commit=seed('p-media','t-media');
  let final;
  const result=await commit.commitAgentTimeline(params([voice('voice-one'),{message:{sessionId:'g1',text:'',senderType:'assistant',metadataJson:JSON.stringify({groupChat:{mentions:[]},type:'sticker',sticker:{stickerId:'s'}})}}],{onFinalReply:value=>{final=value;}}));
  assert.equal(result.outcome,'committed');assert.ok(result.messages.every(message=>message.sessionId==='g1'));
  assert.equal(final.sessionId,'g1');assert.equal(final.segmentTotal,2);assert.equal(finalized,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prepared_voice_assets').get().count,1);
  assert.equal(db.prepare("SELECT visible_reply_committed AS flag FROM group_speech_tasks WHERE id='t-media'").get().flag,1);
  await repository.updateSpeechPlanStatus('p-media','completed',{expectedStatus:['running']});
  const stopped=seed('p-stopped','t-stopped');await repository.terminateActiveSpeechPlan('g1');
  await assert.rejects(stopped.commitAgentTimeline(params([voice('late-voice')])),error=>error.name==='ChatReplyRunCancelledError');
  assert.equal(materialized,1,'取消后的媒体不能物化');assert.equal(discarded,1);
  const rollback=seed('p-rollback','t-rollback');
  db.exec("CREATE TRIGGER reject_group_voice BEFORE INSERT ON messages WHEN NEW.text='语音正文' BEGIN SELECT RAISE(ABORT,'消息提交失败'); END;");
  await assert.rejects(rollback.commitAgentTimeline(params([voice('rollback-voice')])),/消息提交失败/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM prepared_voice_assets WHERE id='rollback-voice'").get().count,0,'消息失败时媒体在同一事务回滚');
  assert.equal(finalized,1);assert.equal(discarded,2);
  db.exec('DROP TRIGGER reject_group_voice;');await repository.updateSpeechPlanStatus('p-rollback','completed',{expectedStatus:['running']});
  const midStop=seed('p-middle','t-middle');let notifications=0;
  await assert.rejects(midStop.commitAgentTimeline(params([voice('before-stop'),voice('after-stop')],{notifyUI:async()=>{notifications++;await repository.terminateActiveSpeechPlan('g1');}})),error=>error.name==='ChatReplyRunCancelledError');
  assert.equal(notifications,1);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM prepared_voice_assets WHERE id='after-stop'").get().count,0,'终止后不提交后续结果');
  db.close();
}

async function verifyPlanningInterruption(GroupChatRepository) {
  const { db, invokeGroupChat, commitGroupUserMessage, state } = await loadInvokeTestBed(
    GroupChatRepository,
  );

  let openPlanningGate;
  state.planningGate = new Promise((resolve) => {
    openPlanningGate = resolve;
  });
  const planningStarted = new Promise((resolve) => {
    state.planningStarted = resolve;
  });
  state.currentUserMessages = [{ id: 120, text: '先聊一句', isMe: true, senderType: 'user' }];
  state.inputUpperBoundMessageId = 120;
  state.sequenceMembers = [buildMember('ai-1')];
  state.adminRequestFailureNotice = {
    text: '管理员调度失败，本次已切换为全量召唤：晚到失败',
    metadata: { actorType: 'admin', actorName: '管理员' },
  };

  const invocation = invokeGroupChat('g1');
  await planningStarted;
  const preparingPlan = db.prepare(
    `SELECT * FROM group_speech_plans WHERE group_id = 'g1'`,
  ).get();
  assert.equal(
    preparingPlan.status,
    'preparing',
    '召唤接管后 plan 必须处于 preparing（输入窗口已关闭）',
  );

  // planning 中途用户发新消息：真实 commit 路径按换代处理。
  const { message, rotation } = await commitGroupUserMessage({ groupId: 'g1', text: 'planning 中途插话' });
  assert.equal(
    rotation.kind,
    'superseded',
    'planning 期间到达的消息必须触发换代，而不是扩展输入窗口',
  );
  assert.equal(rotation.previousPlanId, preparingPlan.id);
  assert.equal(getPlan(db, preparingPlan.id).status, 'superseded');
  const successor = getPlan(db, rotation.successorPlanId);
  assert.equal(successor.status, 'pending');
  assert.equal(successor.supersedes_plan_id, preparingPlan.id);
  assert.deepEqual(
    JSON.parse(successor.invoked_user_message_ids_json),
    [message.id],
    '新 successor 必须包含插话消息',
  );

  // 带失败提示的规划结果晚到：提示先经过事务内 plan fence 被拒绝，随后激活
  // 同样失去资格；旧 planning 不得在用户新消息之后诈尸。
  openPlanningGate();
  const result = await invocation;
  assert.equal(result.success, false);
  assert.equal(result.error, null);
  assert.equal(result.outcome, 'already_running');
  assert.deepEqual(state.executed, [], '激活失败的规划结果不得进入执行器');
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE session_id = 'g1' AND text = ?`,
    ).get(state.adminRequestFailureNotice.text).count,
    0,
    '被换代的晚到管理员失败提示不得写入消息事实',
  );
  assert.equal(
    getPlan(db, preparingPlan.id).status,
    'superseded',
    '晚到的失败/完成回写不得覆盖 superseded 终态',
  );
  db.close();
}

// 迁移63 与 preview 消息绑定的仓库级行为：旧库升级后单活动索引覆盖
// preparing（tryClaim 不得再 claim 出新 plan）；晚到的旧 messageId preview
// 不得覆盖较新事实。
async function verifyCurrentPreviewBinding(GroupChatRepository) {
  // 升级库：旧索引不含 preparing，group_chats 无 last_message_id。
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
    CREATE UNIQUE INDEX idx_group_speech_plans_single_active
      ON group_speech_plans(group_id)
      WHERE status IN ('pending', 'preparing', 'running');
    CREATE TABLE group_chats (
      id TEXT PRIMARY KEY,
      last_message TEXT,
      last_time TEXT,
      last_message_id INTEGER,
      updated_at TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata_json TEXT
    );
  `);


  assert.ok(
    db.prepare(`PRAGMA table_info('group_chats')`).all()
      .some((column) => column.name === 'last_message_id'),
    '当前群聊 preview 保存 last_message_id',
  );

  // 迁移后的库上验证单活动语义：preparing plan 存在时 tryClaim 不得再 claim。
  globalThis.__SUPERSEDE_COORDINATOR__ = createCoordinator(db);
  const repository = new GroupChatRepository();
  insertPlan(db, { id: 'p-prep', groupId: 'g1', status: 'preparing', createdAt: NOW });
  const claim = await repository.tryClaimGroupSpeechPlan('g1');
  assert.equal(claim.claimed, false, 'preparing plan 存在时不得再 claim 出新 plan');
  assert.equal(claim.plan.id, 'p-prep');
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS count FROM group_speech_plans WHERE group_id = 'g1'`,
    ).get().count,
    1,
    'tryClaim 不得在 preparing plan 之外再建 active plan',
  );

  // preview 与消息事实绑定：更小的 messageId 晚到不得覆盖较新 preview。
  db.prepare(
    `INSERT INTO group_chats (id, last_message, last_time, last_message_id, updated_at)
     VALUES ('g1', NULL, NULL, NULL, ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO messages (id, session_id, text, metadata_json)
     VALUES (3, 'g1', '较旧消息', NULL), (5, 'g1', '较新消息', NULL)`,
  ).run();
  assert.equal(
    await repository.updatePreviewForCommittedMessage('g1', 5, '较新消息', NOW),
    true,
  );
  assert.equal(
    await repository.updatePreviewForCommittedMessage('g1', 3, '晚到旧消息', NOW),
    false,
    '更小的 messageId 晚到必须被 CAS 拒绝',
  );
  const boundPreview = db.prepare(
    `SELECT last_message AS lastMessage, last_message_id AS lastMessageId
     FROM group_chats WHERE id = 'g1'`,
  ).get();
  assert.equal(boundPreview.lastMessage, '较新消息', '被拒绝的晚到 preview 不得覆盖较新消息事实');
  assert.equal(boundPreview.lastMessageId, 5, '被拒绝的晚到 preview 不得覆盖较新消息事实');

  // 删除最新 AI 消息后的重算必须同时改写 last_message_id；已删除消息的
  // onFinalReply 即使更晚到达，也必须被消息存在性守卫拒绝。
  db.prepare(
    `INSERT INTO messages (id, session_id, text, metadata_json)
     VALUES (100, 'g1', '删除后保留', NULL), (101, 'g1', '即将删除', NULL)`,
  ).run();
  assert.equal(
    await repository.updatePreviewForCommittedMessage('g1', 101, '即将删除', NOW),
    true,
  );
  await globalThis.__SUPERSEDE_COORDINATOR__.transaction({}, async (transaction) => {
    await transaction.runAsync('DELETE FROM messages WHERE id = 101');
    await repository.updatePreviewInTransaction(transaction, 'g1', 100, '删除后保留', NOW);
  });
  assert.equal(
    await repository.updatePreviewForCommittedMessage('g1', 101, '晚到复活文本', NOW),
    false,
    '已删除消息的晚到 preview 回调必须被存在性守卫拒绝',
  );
  const previewAfterDelete = db.prepare(
    `SELECT last_message AS lastMessage, last_message_id AS lastMessageId
     FROM group_chats WHERE id = 'g1'`,
  ).get();
  assert.equal(previewAfterDelete.lastMessage, '删除后保留');
  assert.equal(previewAfterDelete.lastMessageId, 100);
  db.close();
}

const { GroupChatRepository } = await loadGroupChatRepository('__SUPERSEDE_COORDINATOR__');
await verifyRotationInheritance(GroupChatRepository);
await verifyWindowExtension(GroupChatRepository);
await verifyCommitAtomicity(GroupChatRepository);
await verifyActivationOrdering(GroupChatRepository);
await verifySchedulerWindow(GroupChatRepository);
await verifySuccessorActivation(GroupChatRepository);
await verifyAdminSuppression();
await verifyExecutorAbortAndFence(GroupChatRepository);
await verifyTerminalCasGuards(GroupChatRepository);
await verifyForceTermination(GroupChatRepository);
await verifyForceTerminationCommand(GroupChatRepository);
await verifyPerBubbleCommitFence(GroupChatRepository);
await verifyGroupMediaTimeline(GroupChatRepository);
await verifyPlanningInterruption(GroupChatRepository);
await verifyCurrentPreviewBinding(GroupChatRepository);

console.log('群聊用户消息换代（supersede/successor）行为验证通过。');
