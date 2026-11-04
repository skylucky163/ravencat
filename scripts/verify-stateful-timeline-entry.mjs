import { installChatTimelineSchema } from './chat-timeline-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stateful-timeline-entry-'));

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
  get: () => globalThis.__statefulTimelineFakes.databaseCoordinator,
});
`);
writeRuntimeModule('src/features/chat/group/application/ChatGroupRuntime.js', `
exports.getChatGroupRuntimeDependencies = () => ({ groups: { getById: async () => null } });
`);
writeRuntimeModule('src/features/chat/reply/application/ChatReplyAbort.js', `
exports.ChatReplyRunCancelledError = class extends Error {};
`);

for (const relativePath of [
  'src/features/chat/messages/domain/MessageTimeSeparator.ts',
  'src/features/chat/messages/domain/ChatMessage.ts',
  'src/features/chat/messages/domain/MessageRepository.ts',
  'src/features/chat/messages/domain/ChatSticker.ts',
  'src/features/chat/messages/domain/SharedMoment.ts',
  'src/features/chat/messages/domain/SharedChatRecord.ts',
  'src/features/chat/messages/domain/chatMessageMetadata.ts',
  'src/features/chat/messages/events/ChatEvents.ts',
  'src/features/chat/messages/application/ChatMessageRuntime.ts',
  'src/features/chat/messages/application/UpsertStatefulTimelineEntry.ts',
  'src/features/chat/messages/application/UpsertTogetherListeningTimelineEntry.ts',
  'src/features/chat/messages/infrastructure/ChatTimelineSql.ts',
  'src/features/chat/reply/infrastructure/ChatReplyVersionSql.ts',
  'src/features/chat/messages/infrastructure/ChatMessageMutationSql.ts',
  'src/features/chat/reply/infrastructure/ChatTurnPresentationSql.ts',
  'src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts',
]) {
  compileProductionModule(relativePath);
}

// Together 投影命令只走 stateful upsert；canonical 提交路径不在本节验证范围内。
writeRuntimeModule(
  'src/features/chat/messages/application/CommitAndDispatchCanonicalUserMessage.js',
  'exports.commitAndDispatchCanonicalUserMessage = () => { throw new Error("本节不覆盖 canonical 提交路径"); };',
);

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      last_message TEXT,
      last_time TEXT,
      visible_after_message_id INTEGER,
      updated_at TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      client_message_id TEXT,
      text TEXT NOT NULL,
      is_me INTEGER NOT NULL,
      sender_type TEXT NOT NULL,
      api_message_id TEXT,
      time TEXT NOT NULL,
      created_at TEXT NOT NULL,
      show_time_separator_before INTEGER,
      updated_at TEXT,
      reply_to_id INTEGER,
      reply_to_text TEXT,
      logical_message_id TEXT,
      segment_index INTEGER,
      segment_total INTEGER,
      delivery_status TEXT,
      status TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      metadata_json TEXT,
      is_read INTEGER,
      voice_played_at TEXT,
      turn_run_id TEXT,
      turn_item_index INTEGER
    );
    CREATE INDEX idx_messages_session_client_message
      ON messages(session_id, client_message_id);
    INSERT INTO sessions (id) VALUES ('session-a'), ('session-b'), ('session-tl'), ('session-tl2');
  `);

  sqlite.exec(`INSERT INTO chat_conversations SELECT id, 'direct' FROM sessions;`);
  installChatTimelineSchema(sqlite);
  let transactionCount = 0;
  const databaseCoordinator = {
    failPreviewUpdate: null,
    openTaskExecutor() {
      const executor = {
        async runAsync(source, params = []) {
          if (source.includes('UPDATE sessions') && databaseCoordinator.failPreviewUpdate) {
            throw databaseCoordinator.failPreviewUpdate;
          }
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
      return {
        ...executor,
        async withExclusiveTransactionAsync(task) {
          transactionCount += 1;
          sqlite.exec('BEGIN EXCLUSIVE');
          try {
            const result = await task(executor);
            sqlite.exec('COMMIT');
            return result;
          } catch (error) {
            sqlite.exec('ROLLBACK');
            throw error;
          }
        },
      };
    },
  };

  return {
    databaseCoordinator,
    sqlite,
    get transactionCount() {
      return transactionCount;
    },
  };
}

function createMessage({
  sessionId,
  clientMessageId,
  text,
  metadata,
  createdAt,
  senderType = 'system',
  isRead = true,
  turnRunId = null,
  turnItemIndex = null,
}) {
  return {
    sessionId,
    text,
    isMe: false,
    senderType,
    agentId: null,
    apiMessageId: null,
    clientMessageId,
    time: '08:00',
    createdAt,
    updatedAt: createdAt,
    replyToId: null,
    replyToText: null,
    status: 'sent',
    deliveryStatus: 'delivered',
    tokensUsed: 0,
    promptTokens: 0,
    completionTokens: 0,
    metadataJson: JSON.stringify(metadata),
    isRead,
    turnRunId,
    turnItemIndex,
  };
}

const database = createDatabase();
globalThis.__statefulTimelineFakes = {
  databaseCoordinator: database.databaseCoordinator,
};

const { MessageRepository } = loadCompiled(
  'src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts',
);
const { configureChatMessageRuntime } = loadCompiled(
  'src/features/chat/messages/application/ChatMessageRuntime.ts',
);
const { upsertStatefulTimelineEntry } = loadCompiled(
  'src/features/chat/messages/application/UpsertStatefulTimelineEntry.ts',
);
const { setChatEventBus } = loadCompiled(
  'src/features/chat/messages/events/ChatEvents.ts',
);
const { upsertTogetherListeningTimelineEntry } = loadCompiled(
  'src/features/chat/messages/application/UpsertTogetherListeningTimelineEntry.ts',
);

const repository = new MessageRepository();
configureChatMessageRuntime({ messages: repository });
const uiEvents = [];
const removeBus = setChatEventBus({
  emit(eventName, payload) {
    uiEvents.push({ eventName, payload });
  },
});

function countMessages() {
  return Number(database.sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get().count);
}

function readSessionPreview(sessionId) {
  return database.sqlite
    .prepare('SELECT last_message FROM sessions WHERE id = ?')
    .get(sessionId).last_message;
}

try {
  const first = await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-a',
      clientMessageId: 'stateful:test:1',
      text: '等待中',
      metadata: { phase: 'pending' },
      createdAt: '2026-09-06T08:00:00.000Z',
      isRead: false,
    }),
    previewText: '预览：等待中',
  });
  assert.equal(first.inserted, true);
  assert.equal(countMessages(), 1);
  assert.equal(readSessionPreview('session-a'), '预览：等待中');

  const updated = await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-a',
      clientMessageId: 'stateful:test:1',
      text: '进行中',
      metadata: { phase: 'active' },
      createdAt: '2026-09-06T08:01:00.000Z',
    }),
    previewText: '预览：进行中',
  });
  assert.equal(updated.inserted, false);
  assert.equal(updated.message.id, first.message.id);
  assert.equal(updated.message.text, '进行中');
  assert.deepEqual(JSON.parse(updated.message.metadataJson), { phase: 'active' });
  assert.equal(countMessages(), 1, '同 session 的同一稳定 key 不得生成第二行');
  assert.equal(readSessionPreview('session-a'), '预览：进行中');

  const independent = await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-a',
      clientMessageId: 'stateful:test:2',
      text: '另一条状态',
      metadata: { phase: 'pending' },
      createdAt: '2026-09-06T08:10:00.000Z',
    }),
    previewText: '预览：另一条状态',
  });
  assert.equal(independent.inserted, true);
  assert.notEqual(independent.message.id, first.message.id);
  assert.equal(countMessages(), 2);

  const previewFailure = new Error('injected preview failure');
  const eventsBeforeFailure = uiEvents.length;
  database.databaseCoordinator.failPreviewUpdate = previewFailure;
  await assert.rejects(
    () => upsertStatefulTimelineEntry({
      message: createMessage({
        sessionId: 'session-a',
        clientMessageId: 'stateful:test:2',
        text: '不应提交的更新',
        metadata: { phase: 'failed-update' },
        createdAt: '2026-09-06T08:11:00.000Z',
      }),
      previewText: '不应提交的预览',
    }),
    (error) => error === previewFailure,
  );
  database.databaseCoordinator.failPreviewUpdate = null;
  const rolledBack = await repository.getMessageById(independent.message.id);
  assert.equal(rolledBack.text, '另一条状态');
  assert.deepEqual(JSON.parse(rolledBack.metadataJson), { phase: 'pending' });
  assert.equal(readSessionPreview('session-a'), '预览：另一条状态');
  assert.equal(uiEvents.length, eventsBeforeFailure, '事务失败后不得发布 UI 信号');

  await repository.commitMessage({
    message: createMessage({
      sessionId: 'session-a',
      clientMessageId: null,
      text: '较新的普通聊天消息',
      metadata: { type: 'ordinary' },
      createdAt: '2026-09-06T08:15:00.000Z',
      senderType: 'assistant',
    }),
    previewText: '预览：较新的普通聊天消息',
  });
  await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-a',
      clientMessageId: 'stateful:test:1',
      text: '已结束',
      metadata: { phase: 'ended' },
      createdAt: '2026-09-06T08:20:00.000Z',
    }),
    previewText: '不应覆盖的新预览',
  });
  assert.equal(
    readSessionPreview('session-a'),
    '预览：较新的普通聊天消息',
    '更新旧 entry 时不得覆盖由较新普通聊天消息控制的 session preview',
  );

  const isolated = await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-b',
      clientMessageId: 'stateful:test:1',
      text: '另一个会话',
      metadata: { phase: 'pending' },
      createdAt: '2026-09-06T08:30:00.000Z',
    }),
    previewText: '预览：另一个会话',
  });
  assert.equal(isolated.inserted, true);
  assert.notEqual(isolated.message.id, first.message.id);
  assert.equal(countMessages(), 4, '稳定 key 的幂等范围必须按 session 隔离');

  const transactionCountBeforeMissingKey = database.transactionCount;
  await assert.rejects(
    () => upsertStatefulTimelineEntry({
      message: createMessage({
        sessionId: 'session-a',
        clientMessageId: null,
        text: '无稳定 key',
        metadata: { phase: 'invalid' },
        createdAt: '2026-09-06T08:40:00.000Z',
      }),
      previewText: '不应提交',
    }),
    /必须提供稳定 clientMessageId/,
  );
  assert.equal(database.transactionCount, transactionCountBeforeMissingKey);
  assert.equal(countMessages(), 4, '缺失稳定 key 不得产生半提交');

  assert.deepEqual(uiEvents.slice(0, 2), [
    { eventName: 'messagesUpdated', payload: { sessionId: 'session-a' } },
    {
      eventName: 'messagesPatched',
      payload: { sessionId: 'session-a', updatedMessageIds: [first.message.id] },
    },
  ]);

  // ========================================================================
  // LISTEN-4.1：run-associated external item（AI 邀请卡）的持久排序
  // ========================================================================
  // 工具执行期间卡片先落库（run 成员此时尚未提交），T3 commit 后成员落库；
  // 卡片携带 turnRunId、turnItemIndex 为空，必须排在 tool 状态之后、最终
  // assistant 文本之前，且 lifecycle patch 不改变位置。
  const inviteCard = await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-tl',
      clientMessageId: 'together-listening:activity-1',
      text: 'AI 邀请用户一起听网易云音乐。',
      metadata: { type: 'togetherListening', phase: 'pending_user_response' },
      createdAt: '2026-09-06T09:00:03.000Z',
      senderType: 'assistant',
      turnRunId: 'run-tl',
    }),
    previewText: '预览：一起听邀请',
  });
  assert.equal(inviteCard.inserted, true);
  assert.equal(readSessionPreview('session-tl'), '预览：一起听邀请', 'run 成员提交前卡片仍是时间线末尾');

  const committedRun = await repository.commitMessages({
    messages: [
      createMessage({
        sessionId: 'session-tl',
        clientMessageId: 'agent-timeline:run-tl:1:0',
        text: '推理内容',
        metadata: { kind: 'reasoning' },
        createdAt: '2026-09-06T09:00:00.000Z',
        senderType: 'reasoning',
        turnRunId: 'run-tl',
        turnItemIndex: 1,
      }),
      createMessage({
        sessionId: 'session-tl',
        clientMessageId: 'agent-timeline:run-tl:2:0',
        text: '正在调用工具：invite_listening_together',
        metadata: { type: 'toolStatus' },
        createdAt: '2026-09-06T09:00:02.000Z',
        turnRunId: 'run-tl',
        turnItemIndex: 2,
      }),
      createMessage({
        sessionId: 'session-tl',
        clientMessageId: 'agent-timeline:run-tl:3:0',
        text: '我已经向你发出一起听邀请啦。',
        metadata: { kind: 'assistant' },
        createdAt: '2026-09-06T09:00:05.000Z',
        senderType: 'assistant',
        turnRunId: 'run-tl',
        turnItemIndex: 3,
      }),
    ],
    previewText: '我已经向你发出一起听邀请啦。',
  });
  assert.equal(committedRun.length, 3);

  const timelineAfterCommit = await repository.getMessages('session-tl', {
    limit: 10,
    cursor: null,
    order: 'ASC',
  });
  assert.deepEqual(
    timelineAfterCommit.messages.map((message) => message.clientMessageId),
    [
      'agent-timeline:run-tl:1:0',
      'agent-timeline:run-tl:2:0',
      'together-listening:activity-1',
      'agent-timeline:run-tl:3:0',
    ],
    'SQLite 时间线必须把邀请卡排在 tool 状态之后、最终 assistant 文本之前',
  );
  const persistedCard = timelineAfterCommit.messages[2];
  assert.equal(persistedCard.turnRunId, 'run-tl');
  assert.equal(persistedCard.turnItemIndex, null, 'external item 不占用 1..N 整数序号');
  assert.equal(
    readSessionPreview('session-tl'),
    '我已经向你发出一起听邀请啦。',
    'run commit 后 preview 必须来自最终 assistant 文本而不是邀请卡',
  );

  // 分页游标必须按同一时间线键连续切分 run 组，不漏不重。
  const firstPage = await repository.getMessages('session-tl', {
    limit: 2,
    cursor: null,
    order: 'ASC',
  });
  assert.deepEqual(
    firstPage.messages.map((message) => message.clientMessageId),
    ['agent-timeline:run-tl:1:0', 'agent-timeline:run-tl:2:0'],
  );
  assert.equal(firstPage.hasMore, true);
  const secondPage = await repository.getMessages('session-tl', {
    limit: 2,
    cursor: firstPage.nextCursor,
    order: 'ASC',
  });
  assert.deepEqual(
    secondPage.messages.map((message) => message.clientMessageId),
    ['together-listening:activity-1', 'agent-timeline:run-tl:3:0'],
    '邀请卡必须完整落在第二页开头，分页不得跳过或重复',
  );
  assert.equal(secondPage.hasMore, false);

  // lifecycle patch：pending → active 只改 text/metadata/updatedAt。
  const patchedCard = await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-tl',
      clientMessageId: 'together-listening:activity-1',
      text: '正在一起听',
      metadata: { type: 'togetherListening', phase: 'active' },
      createdAt: '2026-09-06T09:00:03.000Z',
      senderType: 'assistant',
      turnRunId: 'run-tl',
    }),
    previewText: '预览：正在一起听',
  });
  assert.equal(patchedCard.inserted, false);
  assert.equal(patchedCard.message.id, inviteCard.message.id);
  assert.equal(patchedCard.message.turnRunId, 'run-tl', 'patch 不得改写卡片的 run 排序身份');
  assert.equal(patchedCard.message.turnItemIndex, null);
  assert.equal(
    readSessionPreview('session-tl'),
    '我已经向你发出一起听邀请啦。',
    '邀请卡不是时间线末尾时，patch 不得覆盖 session preview',
  );

  // 模拟 App 重启后的全新读取：新的 Repository 实例、同一 SQLite 文件内容，
  // 排序完全由持久列驱动，卡片位置与 patch 前一致。
  const reloadedRepository = new MessageRepository();
  const timelineAfterPatch = await reloadedRepository.getMessages('session-tl', {
    limit: 10,
    cursor: null,
    order: 'ASC',
  });
  assert.deepEqual(
    timelineAfterPatch.messages.map((message) => message.clientMessageId),
    [
      'agent-timeline:run-tl:1:0',
      'agent-timeline:run-tl:2:0',
      'together-listening:activity-1',
      'agent-timeline:run-tl:3:0',
    ],
    'lifecycle patch 与重新加载后邀请卡位置不得移动',
  );

  // 另一个会话的孤儿 run 卡片（run 从未提交成员）回退为自身历史键排序。
  await upsertStatefulTimelineEntry({
    message: createMessage({
      sessionId: 'session-b',
      clientMessageId: 'together-listening:activity-orphan',
      text: '孤儿 run 卡片',
      metadata: { type: 'togetherListening', phase: 'pending_user_response' },
      createdAt: '2026-09-06T09:30:00.000Z',
      senderType: 'assistant',
      turnRunId: 'run-orphan',
    }),
    previewText: '预览：孤儿 run 卡片',
  });
  const orphanTimeline = await repository.getMessages('session-b', {
    limit: 10,
    cursor: null,
    order: 'ASC',
  });
  assert.deepEqual(
    orphanTimeline.messages.map((message) => message.clientMessageId),
    ['stateful:test:1', 'together-listening:activity-orphan'],
    '没有已提交成员的 run 卡片必须按自身 createdAt 回退排序',
  );

  // ========================================================================
  // V1 Closeout：Together Listening 生命周期卡的真实 stateful projection
  // ========================================================================
  // 生命周期卡始终是同一行；结束事实在结束位置追加，独立于旧卡的上下文游标。
  const createdAt = Date.parse('2026-09-06T10:00:00.000Z');
  const activatedAt = createdAt + 60_000;
  const endedAt = activatedAt + 756_000;
  const timelineActivity = (phase, updatedAtEpochMs, activated, ended, endReason = null) => ({
    id: 'activity-2',
    chatSessionId: 'session-tl2',
    hostAiId: 'host-tl',
    initiator: 'ai',
    phase,
    createdAtEpochMs: createdAt,
    updatedAtEpochMs,
    endReason,
    activatedAtEpochMs: activated,
    endedAtEpochMs: ended,
  });

  const tlPending = await upsertTogetherListeningTimelineEntry(
    timelineActivity('pending_user_response', createdAt, null, null),
  );
  assert.equal(tlPending.inserted, true);
  assert.equal(tlPending.message.clientMessageId, 'together-listening:activity-2');

  const tlActive = await upsertTogetherListeningTimelineEntry(
    timelineActivity('active', activatedAt, activatedAt, null),
  );
  assert.equal(tlActive.inserted, false);
  assert.equal(tlActive.message.id, tlPending.message.id);
  assert.deepEqual(JSON.parse(tlActive.message.metadataJson), {
    type: 'togetherListening',
    activityId: 'activity-2',
    initiator: 'ai',
    phase: 'active',
    endReason: null,
    activatedAtEpochMs: activatedAt,
    endedAtEpochMs: null,
    source: 'togetherListening',
  });

  const eventFailureUiCount = uiEvents.length;
  database.sqlite.exec(`CREATE TRIGGER fail_together_end_event BEFORE INSERT ON messages
    WHEN NEW.client_message_id = 'together-listening-ended:activity-2'
    BEGIN SELECT RAISE(ABORT, 'injected end event failure'); END;`);
  await assert.rejects(() => upsertTogetherListeningTimelineEntry(
    timelineActivity('ended', endedAt, activatedAt, endedAt, 'user_left'),
  ), /injected end event failure/);
  database.sqlite.exec('DROP TRIGGER fail_together_end_event');
  assert.equal(JSON.parse((await repository.getMessageById(tlActive.message.id)).metadataJson).phase, 'active',
    '结束事件提交失败必须同时回滚旧卡 patch');
  assert.equal(uiEvents.length, eventFailureUiCount, '失败事务不得刷新 UI');

  const tlEnded = await upsertTogetherListeningTimelineEntry(
    timelineActivity('ended', endedAt, activatedAt, endedAt, 'user_left'),
  );
  assert.equal(tlEnded.inserted, false);
  assert.equal(tlEnded.message.id, tlPending.message.id, 'ended 必须 patch 原卡，不能复制第二张卡');
  assert.equal(tlEnded.message.createdAt, tlPending.message.createdAt);
  assert.equal(tlEnded.message.turnRunId, null);
  assert.equal(
    Number(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'session-tl2'")
        .get().count,
    ),
    2,
    '同 Activity 只有一张卡和一条独立结束事件',
  );
  const endEvent = await repository.getMessageByClientMessageId('session-tl2', 'together-listening-ended:activity-2');
  assert.equal(endEvent.senderType, 'system');
  assert.equal(endEvent.createdAt, new Date(endedAt).toISOString());
  assert.equal(endEvent.turnRunId, null);
  assert.deepEqual(uiEvents.slice(eventFailureUiCount), [
    { eventName: 'messagesPatched', payload: { sessionId: 'session-tl2', updatedMessageIds: [tlPending.message.id] } },
    { eventName: 'messagesUpdated', payload: { sessionId: 'session-tl2' } },
  ], '提交后必须同时刷新原卡并通知新结束事件，不能仅加载新消息而保留旧卡状态');
  assert.match(endEvent.text, /你已退出/);
  assert.equal(JSON.parse(endEvent.metadataJson).endReason, 'user_left');
  const afterOldCard = await repository.getMessages('session-tl2', { limit: 10, cursor: tlPending.message.id, order: 'ASC' });
  assert.deepEqual(afterOldCard.messages.map(message => message.id), [endEvent.id],
    '旧卡已被历史游标越过时，退出事件必须仍在后续历史内');
  await upsertTogetherListeningTimelineEntry(timelineActivity('ended', endedAt, activatedAt, endedAt, 'user_left'));
  assert.equal(Number(database.sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = 'session-tl2'").get().count), 2,
    '重复结束投影必须幂等');
  assert.equal(
    readSessionPreview('session-tl2'),
    '[一起听已结束]',
    'preview 继续表达生命周期，不携带历史时长',
  );

  // App 重启后的全新读取：新 Repository 实例 + 同一 SQLite 行。
  const reloadedTimelineCard = await new MessageRepository().getMessageById(
    tlPending.message.id,
  );
  const reloadedMetadata = JSON.parse(reloadedTimelineCard.metadataJson);
  assert.equal(reloadedMetadata.activityId, 'activity-2');
  assert.equal(reloadedMetadata.phase, 'ended');
  assert.equal(reloadedMetadata.activatedAtEpochMs, activatedAt, 'activated 时间戳必须保留');
  assert.equal(reloadedMetadata.endedAtEpochMs, endedAt, 'ended 时间戳必须落库');
  assert.equal(reloadedMetadata.endReason, 'user_left');
  assert.equal(reloadedTimelineCard.id, tlPending.message.id);

  // 自主正文在正常终态沿稳定身份从已读过程转成未读消息，SQLite 重读不能留下旧角色。
  const draft = createMessage({ sessionId: 'session-b', clientMessageId: 'autonomous:final',
    text: '正在生成', senderType: 'system', isRead: true,
    createdAt: '2026-10-21T08:00:00.000Z', metadata: { type: 'agentActivity' } });
  const draftResult = await repository.upsertStatefulTimelineEntry({ message: draft, previewText: null });
  const finalMessage = { ...draft, senderType: 'assistant', isRead: false, text: '今天过得怎么样？',
    logicalMessageId: 'autonomous:logical', segmentIndex: 0, segmentTotal: 2,
    metadataJson: JSON.stringify({ kind: 'reply' }), deliveryStatus: 'delivered' };
  const finalResult = await repository.upsertStatefulTimelineEntry({ message: finalMessage, previewText: finalMessage.text });
  assert.equal(finalResult.inserted, false);
  assert.equal(finalResult.message.id, draftResult.message.id);
  const reloadedFinal = await new MessageRepository().getMessageById(draftResult.message.id);
  assert.equal(reloadedFinal.senderType, 'assistant');
  assert.equal(reloadedFinal.isRead, false);
  assert.equal(reloadedFinal.logicalMessageId, 'autonomous:logical');
  assert.equal(reloadedFinal.segmentTotal, 2);
  assert.equal(reloadedFinal.deliveryStatus, 'delivered');
  assert.equal(readSessionPreview('session-b'), finalMessage.text);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE client_message_id = 'autonomous:final'").get().count, 1);

  console.log('Stateful timeline entry 契约检查通过（稳定 key、更新、隔离、preview、回滚与自主正文提交）。');
} finally {
  removeBus();
  database.sqlite.close();
  delete globalThis.__statefulTimelineFakes;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
