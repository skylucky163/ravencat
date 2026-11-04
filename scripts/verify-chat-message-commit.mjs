import { chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';
import { chatReplyVersionModuleUrl, chatMutationModuleUrl, chatTimelineModuleUrl } from './chat-timeline-fixture.mjs';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';
/**
 * Chat 消息原子提交行为测试。
 *
 * 验证统一消息提交协议：
 * 1. 单条提交：latest message 的读取发生在事务执行器内，时间分隔基于事务内 latest message；
 * 2. 显式 showTimeSeparatorBefore 优先于事务内计算；
 * 3. 批量提交：只更新一次 session preview，使用最后一条 committed message；
 * 4. 批量提交：时间分隔逐条基于事务内前一条消息；
 * 5. 补写时间早于现有 latest 的消息时，不得倒退覆盖 session preview；
 * 6. 批量最后一条 inserted 不是稳定时间线末尾时，不得更新 preview；
 * 7. 批量输入包含不同 session 时整体失败，不得部分写入；
 * 8. 插入失败 / preview 更新失败时整个事务回滚，无残留写入；
 * 9. application 层：UI 通知只在 commit 成功之后发生；
 * 10. 时间线增量同步：收到 messagesUpdated 时只读取 lastMessageId 之后的新消息，
 *     不得用最新窗口替换用户已经加载的历史；
 * 11. canonical user commit：提交后副作用失败不撤回已提交事实，真正的提交失败仍抛出。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';

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

// ============================================================================
// 领域时间分隔规则
// ============================================================================
const separatorModuleUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/MessageTimeSeparator.ts'),
);
const { shouldShowTimeSeparatorBefore, TIME_SEPARATOR_GAP_MS } = await import(separatorModuleUrl);
const timelineOrderingModuleUrl = transpileToModuleUrl(
  read('src/features/chat/messages/domain/ChatTimelineOrdering.ts'),
);
const { sortChatTimelineMessages } = await import(timelineOrderingModuleUrl);
const timelineRuntimeStubUrl = transpileToModuleUrl(`
export function getChatMessageRuntimeDependencies() { return {}; }
`);
const timelineMetadataStubUrl = transpileToModuleUrl(`
export function buildAttachmentMessageMetadata() { return null; }
export function buildStickerMessageMetadata() { return null; }
`);
globalThis.__TEST_TIMELINE_EVENT_BUS__ = null;
const timelineEventsStubUrl = transpileToModuleUrl(`
export function setChatEventBus(eventBus) {
  globalThis.__TEST_TIMELINE_EVENT_BUS__ = eventBus;
  return () => {
    if (globalThis.__TEST_TIMELINE_EVENT_BUS__ === eventBus) {
      globalThis.__TEST_TIMELINE_EVENT_BUS__ = null;
    }
  };
}
`);
const messageTimelineModuleUrl = transpileToModuleUrl(
  read('src/features/chat/messages/application/MessageTimeline.ts')
    .replace(/from ['"]\.\/UserMessageSubmission['"]/g,
      `from '${transpileToModuleUrl(read('src/features/chat/messages/application/UserMessageSubmission.ts'))}'`)
    .replace(/from\s*['"]\.\.\/domain\/ChatTimelineOrdering['"]/, `from '${timelineOrderingModuleUrl}'`)
    .replace(/from\s*['"]\.\.\/domain\/chatMessageMetadata['"]/g, `from '${timelineMetadataStubUrl}'`)
    .replace(/from\s*['"]\.\.\/domain\/ChatSticker['"]/, `from '${timelineMetadataStubUrl}'`)
    .replace(/from\s*['"]\.\/ChatMessageRuntime['"]/, `from '${timelineRuntimeStubUrl}'`)
    .replace(/from\s*['"]\.\.\/events\/ChatEvents['"]/, `from '${timelineEventsStubUrl}'`),
);
const { mergeTimelineMessages, subscribeConversationTimeline, messageTimeline, openConversationTimeline, loadOlderTimelineMessages } = await import(messageTimelineModuleUrl);
const require = createRequire(import.meta.url);
function loadHookModule(relativePath, dependencies) {
  const module = { exports: {} };
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', output)((id) => {
    if (id === 'react') return require(id);
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    throw new Error(`未提供依赖 ${id}`);
  }, module, module.exports);
  return module.exports;
}
assert.equal(TIME_SEPARATOR_GAP_MS, 10 * 60 * 1000, '时间分隔阈值为 10 分钟');
assert.equal(
  shouldShowTimeSeparatorBefore(null, '2026-08-03T10:00:00.000Z'),
  true,
  '首条消息必须显示时间分隔',
);
assert.equal(
  shouldShowTimeSeparatorBefore(
    { createdAt: '2026-08-03T10:00:00.000Z' },
    '2026-08-03T10:05:00.000Z',
  ),
  false,
  '5 分钟间隔不显示时间分隔',
);
assert.equal(
  shouldShowTimeSeparatorBefore(
    { createdAt: '2026-08-03T10:00:00.000Z' },
    '2026-08-03T10:10:00.000Z',
  ),
  true,
  '间隔等于阈值时显示时间分隔',
);

// 同一 canonical run 以 turnItemIndex=1 为组锚点，组内由 turnItemIndex 保持 Agent 顺序。
assert.deepEqual(
  sortChatTimelineMessages([
    { id: 12, createdAt: '2026-08-03T10:03:00.000Z', turnRunId: 'run-1', turnItemIndex: 2 },
    { id: 13, createdAt: '2026-08-03T10:02:00.000Z', turnRunId: null, turnItemIndex: null },
    { id: 11, createdAt: '2026-08-03T10:01:00.000Z', turnRunId: 'run-1', turnItemIndex: 1 },
  ]).map((message) => message.id),
  [11, 12, 13],
  'timeline merge 必须以 turnItemIndex 排列同 run，并以 run 首项历史位置组合到普通消息之间',
);

// LISTEN-4.1：AI 工具执行期间写入的 Together 邀请卡是 run-associated external item
//（turnRunId 非空、turnItemIndex 为空、写入 id 小于 commit 成员），必须保持
// tool 调用 → 业务卡片 → 后续 assistant 文本 的真实顺序。
const togetherInviteCard = {
  id: 30,
  createdAt: '2026-08-03T11:00:03.000Z',
  turnRunId: 'run-together',
  turnItemIndex: null,
};
const togetherRunMembers = [
  { id: 31, createdAt: '2026-08-03T11:00:00.000Z', turnRunId: 'run-together', turnItemIndex: 1 },
  { id: 32, createdAt: '2026-08-03T11:00:02.000Z', turnRunId: 'run-together', turnItemIndex: 2 },
  { id: 33, createdAt: '2026-08-03T11:00:05.000Z', turnRunId: 'run-together', turnItemIndex: 3 },
];
const inviteRunTimeline = [togetherInviteCard, ...togetherRunMembers];

// A：初次加载即正确。
assert.deepEqual(
  sortChatTimelineMessages(inviteRunTimeline).map((message) => message.id),
  [31, 32, 30, 33],
  'AI 邀请卡必须排在 tool 状态之后、最终 assistant 文本之前',
);
// B：打乱后重新排序结果不变（重载 SQLite 后的任意读取顺序等价于此）。
assert.deepEqual(
  sortChatTimelineMessages([...inviteRunTimeline].reverse()).map((message) => message.id),
  [31, 32, 30, 33],
  '邀请卡排序不得依赖输入数组顺序',
);
// D：lifecycle patch 只改 text/metadata/updatedAt，排序身份不变，卡片位置不移动。
{
  const patchedCard = {
    ...togetherInviteCard,
    text: '正在一起听',
    updatedAt: '2026-08-03T11:02:00.000Z',
    metadataJson: '{"phase":"active"}',
  };
  assert.deepEqual(
    sortChatTimelineMessages([
      togetherRunMembers[2], patchedCard, togetherRunMembers[0], togetherRunMembers[1],
    ]).map((message) => message.id),
    [31, 32, 30, 33],
    'pending → active 的 lifecycle patch 不得让邀请卡跳动位置',
  );
}
// E：canonical 成员在 createdAt 同毫秒时仍按 turnItemIndex 排列，external 语义不改变成员规则。
assert.deepEqual(
  sortChatTimelineMessages([
    { id: 53, createdAt: '2026-08-03T12:00:00.000Z', turnRunId: 'run-tie', turnItemIndex: 3 },
    { id: 51, createdAt: '2026-08-03T12:00:00.000Z', turnRunId: 'run-tie', turnItemIndex: 1 },
    { id: 52, createdAt: '2026-08-03T12:00:00.000Z', turnRunId: 'run-tie', turnItemIndex: 2 },
  ]).map((message) => message.id),
  [51, 52, 53],
  'canonical 成员的 turnItemIndex ordering 必须保持',
);
// 卡片与 tool 状态同毫秒时排在 tool 之后（卡片由该次工具调用产生）。
assert.deepEqual(
  sortChatTimelineMessages([
    { id: 62, createdAt: '2026-08-03T12:10:00.000Z', turnRunId: 'run-ms', turnItemIndex: null },
    { id: 63, createdAt: '2026-08-03T12:10:01.000Z', turnRunId: 'run-ms', turnItemIndex: 3 },
    { id: 61, createdAt: '2026-08-03T12:10:00.000Z', turnRunId: 'run-ms', turnItemIndex: 2 },
    { id: 60, createdAt: '2026-08-03T12:09:59.000Z', turnRunId: 'run-ms', turnItemIndex: 1 },
  ]).map((message) => message.id),
  [60, 61, 62, 63],
  '同毫秒边界下邀请卡必须排在产生它的 tool 状态之后',
);
// F：external item 不改变 run 组锚点语义，也不影响普通消息与另一个 run 的相对顺序。
assert.deepEqual(
  sortChatTimelineMessages([
    { id: 41, createdAt: '2026-08-03T11:05:00.000Z', turnRunId: 'run-other', turnItemIndex: 2 },
    { id: 34, createdAt: '2026-08-03T11:00:04.000Z', turnRunId: null, turnItemIndex: null },
    ...inviteRunTimeline,
    { id: 40, createdAt: '2026-08-03T11:04:00.000Z', turnRunId: 'run-other', turnItemIndex: 1 },
  ]).map((message) => message.id),
  [31, 32, 30, 33, 34, 40, 41],
  '普通消息仍与各 run 组按锚点位置组合，另一个 run 的组内顺序不变',
);
// run 未提交任何成员（失败/取消/非 canonical）时，卡片回退为自身历史键排序。
assert.deepEqual(
  sortChatTimelineMessages([
    { id: 71, createdAt: '2026-08-03T12:20:10.000Z', turnRunId: null, turnItemIndex: null },
    { id: 72, createdAt: '2026-08-03T12:20:05.000Z', turnRunId: 'run-orphan', turnItemIndex: null },
  ]).map((message) => message.id),
  [72, 71],
  '没有已提交成员的 run 卡片必须按自身 createdAt 回退排序',
);

const baseTimelineMessage = {
  id: 21,
  sessionId: 's1',
  text: 'reply',
  isMe: false,
  isRead: false,
  senderType: 'assistant',
  createdAt: '2026-08-03T10:05:00.000Z',
  turnRunId: null,
  turnItemIndex: null,
};
const orderingFactPatch = mergeTimelineMessages(
  [baseTimelineMessage],
  [{ ...baseTimelineMessage, turnRunId: 'run-patched', turnItemIndex: 1 }],
);
assert.equal(orderingFactPatch.changed, true, 'turn ordering facts 变化必须被 timeline entity equality 识别');
assert.equal(orderingFactPatch.messages[0].turnRunId, 'run-patched');
assert.equal(orderingFactPatch.messages[0].turnItemIndex, 1);

// 回前台补同步必须保留页面现有窗口；messagesUpdated 只查询 lastMessageId 之后的事实。
{
  const appended = [];
  const repository = {
    getNewerMessages: async (sessionId, afterId) => {
      assert.equal(sessionId, 's1');
      assert.equal(afterId, 60, '增量同步必须从页面当前最后一条消息之后读取');
      return [{ ...baseTimelineMessage, id: 61, sessionId, text: 'foreground reply' }];
    },
    getMessages: async () => {
      throw new Error('messagesUpdated 不得退化为最新窗口 replace');
    },
  };
  const unsubscribe = subscribeConversationTimeline({
    sessionId: 's1',
    getAfterId: () => 60,
    getLoadedMessageIds: () => [41, 60],
    onReplace: () => {
      throw new Error('messagesUpdated 不得替换已加载历史');
    },
    onAppend: (messages) => {
      appended.push(...messages);
    },
  }, { repository });

  await globalThis.__TEST_TIMELINE_EVENT_BUS__.emit('messagesUpdated', { sessionId: 's1' });
  assert.deepEqual(appended.map((message) => message.id), [61]);
  unsubscribe();
}

// 发送／回复收尾要求替换事实时，读取范围仍由当前已加载窗口提供。
{
  const ids = Array.from({ length: 50 }, (_, index) => index + 11);
  let replacement;
  const repository = {
    getReloadWindowMessages: async (sessionId, loadedIds) => {
      assert.equal(sessionId, 'reload-window');
      assert.deepEqual(loadedIds, ids);
      return [...ids, 61].map(id => ({ ...baseTimelineMessage, id, sessionId }));
    },
    getMessages: async () => { throw new Error('重载不得把已加载窗口裁成首屏'); },
  };
  const unsubscribe = subscribeConversationTimeline({
    sessionId: 'reload-window', getAfterId: () => 60, getLoadedMessageIds: () => ids,
    onReplace: messages => { replacement = messages; },
  }, { repository });
  await globalThis.__TEST_TIMELINE_EVENT_BUS__.emit('messagesReloadRequested', { sessionId: 'reload-window' });
  assert.deepEqual(replacement.map(message => message.id), [...ids, 61]);
  unsubscribe();
}

// 已加载多页时，单条及联删只移除提交身份；继续上翻不得跳过中间消息。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
for (const sessionId of ['direct-delete', 'group-delete']) {
  const rows = Array.from({ length: 100 }, (_, index) => ({ ...baseTimelineMessage, sessionId, id: index + 1 }));
  const pageCursors = [];
  let openCount = 0;
  let resolveNewer;
  const repository = {
    getMessages: async (_sessionId, { cursor, limit }) => {
      const eligible = rows.filter((row) => cursor === null || row.id < cursor);
      const messages = eligible.slice(-limit);
      return { messages, hasMore: eligible.length > limit, nextCursor: messages[0]?.id ?? null };
    },
    getNewerMessages: () => new Promise((resolve) => { resolveNewer = resolve; }),
  };
  const timeline = {
    ...messageTimeline,
    open: async (params) => {
      openCount++;
      return openConversationTimeline(params, { repository });
    },
    loadOlder: async (params) => {
      pageCursors.push(params.cursor);
      return loadOlderTimelineMessages(params, { repository });
    },
    subscribe: (params) => subscribeConversationTimeline(params, { repository }),
  };
  const base = 'src/features/chat/presentation/messages/components/';
  const pagination = loadHookModule(`${base}chatHistoryPagination.ts`, {});
  const window = loadHookModule(`${base}chatBottomAnchorExperiment.ts`, {});
  const cache = loadHookModule(`${base}sessionTimelineCache.ts`, { './chatBottomAnchorExperiment': window });
  const { useMessageHistoryState } = loadHookModule(`${base}useMessageHistoryState.ts`, {
    '../../../messages/application/MessageTimeline': { messageTimeline: timeline },
    './sessionTimelineCache': cache,
    './chatBottomAnchorExperiment': window,
    './chatHistoryPagination': pagination,
  });
  const { useChatTimelineSync } = loadHookModule(`${base}useChatTimelineSync.ts`, {
    '../../../messages/application/MessageTimeline': { messageTimeline: timeline },
    '../../../messages/events/ChatEvents': { setChatEventBus: () => () => {} },
  });
  let history;
  function Screen() {
    history = useMessageHistoryState(sessionId);
    const [isTyping, setIsTyping] = React.useState(false);
    useChatTimelineSync({ sessionId, ...history, isTyping, setIsTyping });
    return null;
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Screen)); });
  await act(async () => { await history.loadMore(); });
  const before = history.messages.map((message) => message.id);
  const cursor = Math.min(...before);
  const removed = [cursor, cursor + 1, 100];
  const eventBus = globalThis.__TEST_TIMELINE_EVENT_BUS__;
  // 让新消息查询持有删除前的快照，再提交删除。
  let syncing;
  await act(async () => { syncing = eventBus.emit('messagesUpdated', { sessionId }); });
  for (const id of removed) rows.splice(rows.findIndex((row) => row.id === id), 1);
  await act(async () => { await eventBus.emit('messagesDeleted', { sessionId, deletedMessageIds: removed }); });
  assert.deepEqual(history.messages.map((message) => message.id), before.filter((id) => !removed.includes(id)), '删除必须保留已加载历史');
  assert.equal(history.lastMessageIdRef.current, 99, '删除尾消息后同步水位必须更新');
  await act(async () => {
    resolveNewer([{ ...baseTimelineMessage, sessionId, id: 100 }]);
    await syncing;
  });
  assert.equal(history.messages.some((message) => removed.includes(message.id)), false, '旧查询结果不得复活已删除消息');
  await act(async () => { await history.loadMore(); });
  assert.equal(pageCursors.at(-1), cursor, '删除最早可见消息也必须保留原分页边界');
  while (history.hasMore) await act(async () => { await history.loadMore(); });
  assert.deepEqual(history.messages.map((message) => message.id), rows.map((message) => message.id), '继续上滑应完整加载所有未删除消息');
  repository.getReloadWindowMessages = async (_sessionId, ids) => {
    assert.deepEqual(ids, history.messages.map(message => message.id), '刷新范围读取当前窗口，不捕获订阅建立时的旧数组');
    return rows.map(message => ({ ...message }));
  };
  await act(async () => { await eventBus.emit('messagesReloadRequested', { sessionId }); });
  assert.deepEqual(history.messages.map(message => message.id), rows.map(message => message.id),
    '单聊和群聊收尾重载都保留用户已加载的多页窗口');
  assert.equal(openCount, 1, '删除不能触发首屏重载');
  await act(async () => { renderer.unmount(); });
}

// ============================================================================
// 仓储模块：桩掉 @platform/persistence 依赖，直接驱动事务执行器
// ============================================================================
const messageMetadata = loadTypeScriptModule('src/features/chat/messages/domain/chatMessageMetadata.ts', {
  './ChatSticker': loadTypeScriptModule('src/features/chat/messages/domain/ChatSticker.ts'),
  ...chatSharingDependencies,
});
const { MessageRepository } = loadTypeScriptModule('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts', {
  '@platform/persistence': { databaseCoordinator: {
    openTaskExecutor() {
      assert.ok(globalThis.__TEST_COORDINATOR_HOLDER__, '事务方法不得在缺少测试协调器时打开任务执行器');
      return globalThis.__TEST_COORDINATOR_HOLDER__.openTaskExecutor();
    },
  } },
  './ChatTimelineSql': await import(chatTimelineModuleUrl),
  './ChatMessageMutationSql': await import(chatMutationModuleUrl),
  '../../reply/infrastructure/ChatReplyVersionSql': await import(chatReplyVersionModuleUrl),
  '../domain/MessageTimeSeparator': { shouldShowTimeSeparatorBefore },
  '../domain/chatMessageMetadata': messageMetadata,
});

const INSERT_COLUMNS = [
  'session_id', 'agent_id', 'client_message_id', 'text', 'is_me', 'sender_type', 'api_message_id',
  'time', 'created_at', 'show_time_separator_before', 'updated_at', 'reply_to_id', 'reply_to_text',
  'logical_message_id', 'segment_index', 'segment_total', 'delivery_status', 'status',
  'tokens_used', 'prompt_tokens', 'completion_tokens', 'metadata_json', 'is_read',
];

function createFakeDatabase() {
  const fake = {
    nextId: 1,
    messages: new Map(),
    sessions: new Map(),
    statements: [],
  };
  fake.executor = {
    runAsync: async (source, params = []) => {
      fake.statements.push({ kind: 'run', source, params });
      if (source.startsWith('UPDATE chat_reply_version_sets')) return { lastInsertRowId: 0, changes: 0 };
      if (source.startsWith('INSERT INTO messages')) {
        const row = { id: fake.nextId };
        INSERT_COLUMNS.forEach((column, index) => {
          row[column] = params[index];
        });
        fake.nextId += 1;
        fake.messages.set(row.id, row);
        return { lastInsertRowId: row.id, changes: 1 };
      }
      if (source.startsWith('UPDATE sessions')) {
        const [last_message, last_time, updated_at, sessionId] = params;
        fake.sessions.set(sessionId, { last_message, last_time, updated_at });
        return { lastInsertRowId: 0, changes: 1 };
      }
      throw new Error(`fake executor 收到未知写入：${source}`);
    },
    getFirstAsync: async (source, params = []) => {
      fake.statements.push({ kind: 'read', source, params });
      if (source.includes('FROM chat_regeneration_requests')) return null;
      if (source.includes('SELECT * FROM messages WHERE id = ?')) {
        return fake.messages.get(params[0]) ?? null;
      }
      if (source.includes('ORDER BY') && source.includes('LIMIT 1') && source.includes('messages')) {
        const sessionId = params[0];
        const rows = [...fake.messages.values()]
          .filter((row) => row.session_id === sessionId)
          .sort((a, b) => (
            a.created_at === b.created_at
              ? b.id - a.id
              : (a.created_at < b.created_at ? 1 : -1)
          ));
        return rows[0] ?? null;
      }
      throw new Error(`fake executor 收到未知查询：${source}`);
    },
    getAllAsync: async () => {
      throw new Error('fake executor 不应执行 getAllAsync');
    },
  };
  return fake;
}

function seedMessage(fake, { sessionId = 's1', text = 'seed', createdAt }) {
  return fake.executor.runAsync('INSERT INTO messages', [
    sessionId, null, null, text, 0, 'user', null, '10:00', createdAt, 0, createdAt,
    null, null, null, 0, 1, 'delivered', 'sent', 0, 0, 0, null, 1,
  ]);
}

function makeMessage({ sessionId = 's1', text = 'hello', createdAt, showTimeSeparatorBefore }) {
  const message = {
    sessionId,
    text,
    isMe: true,
    senderType: 'user',
    time: '12:00',
    createdAt,
  };
  if (showTimeSeparatorBefore !== undefined) {
    message.showTimeSeparatorBefore = showTimeSeparatorBefore;
  }
  return message;
}

function previewUpdates(fake) {
  return fake.statements.filter(
    (item) => item.kind === 'run' && item.source.startsWith('UPDATE sessions'),
  );
}

// 模拟 withExclusiveTransactionAsync 的事务语义：任务抛错时回滚到执行前状态。
function createCoordinator(fake) {
  const coordinator = {
    transactionCount: 0,
    openTaskExecutor() {
      return {
        // 公开提交只能使用事务回调中的执行器，事务外的 SQL 访问会直接失败。
        withExclusiveTransactionAsync: async (task) => {
          coordinator.transactionCount += 1;
          const before = {
            nextId: fake.nextId,
            messages: new Map(fake.messages),
            sessions: new Map(fake.sessions),
          };
          try {
            return await task(fake.executor);
          } catch (error) {
            fake.nextId = before.nextId;
            fake.messages = before.messages;
            fake.sessions = before.sessions;
            throw error;
          }
        },
      };
    },
  };
  return coordinator;
}

// 测试 1：单条提交在事务执行器内读取 latest，并基于它计算时间分隔
{
  const fake = createFakeDatabase();
  await seedMessage(fake, { sessionId: 's1', createdAt: '2026-08-03T10:00:00.000Z' });
  const repo = new MessageRepository();

  const near = await repo.commitMessageInTransaction(fake.executor, {
    message: makeMessage({ sessionId: 's1', createdAt: '2026-08-03T10:05:00.000Z' }),
    previewText: 'near',
  });
  assert.equal(near.showTimeSeparatorBefore, false, '5 分钟间隔基于事务内 latest 判定为不显示分隔');

  const farFake = createFakeDatabase();
  await seedMessage(farFake, { sessionId: 's1', createdAt: '2026-08-03T10:00:00.000Z' });
  const far = await repo.commitMessageInTransaction(farFake.executor, {
    message: makeMessage({ sessionId: 's1', createdAt: '2026-08-03T10:11:00.000Z' }),
    previewText: 'far',
  });
  assert.equal(far.showTimeSeparatorBefore, true, '11 分钟间隔基于事务内 latest 判定为显示分隔');

  const explicitFake = createFakeDatabase();
  await seedMessage(explicitFake, { sessionId: 's1', createdAt: '2026-08-03T10:00:00.000Z' });
  const explicit = await repo.commitMessageInTransaction(explicitFake.executor, {
    message: makeMessage({
      sessionId: 's1',
      createdAt: '2026-08-03T10:12:00.000Z',
      showTimeSeparatorBefore: false,
    }),
    previewText: 'explicit',
  });
  assert.equal(explicit.showTimeSeparatorBefore, false, '显式 showTimeSeparatorBefore 优先于事务内计算');

  const lastPreview = previewUpdates(fake).at(-1);
  assert.equal(lastPreview.params[0], 'near', 'session preview 必须使用最终 previewText');
  assert.equal(
    lastPreview.params[1],
    '2026-08-03T10:05:00.000Z',
    'last_time 必须使用稳定时间线末尾消息的创建时间',
  );
  assert.equal(lastPreview.params[3], 's1', 'preview 更新必须落在同一会话');
}

// 测试 2：批量提交只更新一次 session preview，使用最后一条 committed message
{
  const fake = createFakeDatabase();
  const repo = new MessageRepository();

  const insertedMessages = await repo.commitMessagesInTransaction(fake.executor, {
    messages: [
      makeMessage({ sessionId: 's1', text: 'first', createdAt: '2026-08-03T11:00:00.000Z' }),
      makeMessage({ sessionId: 's1', text: 'second', createdAt: '2026-08-03T11:01:00.000Z' }),
      makeMessage({ sessionId: 's1', text: 'third', createdAt: '2026-08-03T11:02:00.000Z' }),
    ],
    previewText: 'final preview',
  });

  assert.equal(insertedMessages.length, 3, '批量提交必须返回全部插入消息');
  assert.deepEqual(
    insertedMessages.map((message) => message.showTimeSeparatorBefore),
    [true, false, false],
    '批量时间分隔必须逐条基于事务内前一条消息',
  );

  const previews = previewUpdates(fake);
  assert.equal(previews.length, 1, '批量提交只能更新一次 session preview');
  assert.equal(previews[0].params[0], 'final preview', '批量 preview 必须使用最终 previewText');
  assert.equal(
    previews[0].params[1],
    '2026-08-03T11:02:00.000Z',
    '批量 preview 必须使用最后一条 committed message 的创建时间',
  );
  assert.equal(previews[0].params[3], 's1', '批量 preview 更新必须落在同一会话');

  assert.equal(fake.messages.size, 3, '批量提交必须插入全部消息');
}

// 测试 3：批量提交第一条基于事务内 latest（非空会话）
{
  const fake = createFakeDatabase();
  await seedMessage(fake, { sessionId: 's1', createdAt: '2026-08-03T10:00:00.000Z' });
  const repo = new MessageRepository();

  const insertedMessages = await repo.commitMessagesInTransaction(fake.executor, {
    messages: [
      makeMessage({ sessionId: 's1', text: 'first', createdAt: '2026-08-03T10:15:00.000Z' }),
      makeMessage({ sessionId: 's1', text: 'second', createdAt: '2026-08-03T10:16:00.000Z' }),
    ],
    previewText: 'preview',
  });

  assert.deepEqual(
    insertedMessages.map((message) => message.showTimeSeparatorBefore),
    [true, false],
    '批量第一条必须与事务内 latest 比较，后续与前一条插入消息比较',
  );
}

// 测试 4：单条补写时间早于现有 latest 的消息时，不得倒退覆盖 session preview
{
  const fake = createFakeDatabase();
  await seedMessage(fake, { sessionId: 's1', createdAt: '2026-08-03T10:00:00.000Z' });
  fake.sessions.set('s1', {
    last_message: 'existing preview',
    last_time: '2026-08-03T10:00:00.000Z',
    updated_at: '2026-08-03T10:00:00.000Z',
  });
  const repo = new MessageRepository();

  const inserted = await repo.commitMessageInTransaction(fake.executor, {
    message: makeMessage({ sessionId: 's1', text: 'backfill', createdAt: '2026-08-03T09:00:00.000Z' }),
    previewText: 'stale preview',
  });
  assert.equal(inserted.id, 2, '补写消息必须正常插入');
  assert.equal(
    fake.sessions.get('s1').last_message,
    'existing preview',
    '补写旧消息不得倒退覆盖 session preview',
  );
  assert.equal(
    fake.sessions.get('s1').last_time,
    '2026-08-03T10:00:00.000Z',
    '补写旧消息不得倒退覆盖 last_time',
  );
  assert.equal(previewUpdates(fake).length, 0, 'committedMessageId 不是稳定时间线末尾时不得更新 preview');
}

// 测试 5：批量最后一条 inserted 消息不是稳定时间线末尾时，不得更新 preview
{
  const fake = createFakeDatabase();
  const repo = new MessageRepository();

  const insertedMessages = await repo.commitMessagesInTransaction(fake.executor, {
    messages: [
      makeMessage({ sessionId: 's1', text: 'later', createdAt: '2026-08-03T11:00:00.000Z' }),
      makeMessage({ sessionId: 's1', text: 'earlier', createdAt: '2026-08-03T10:00:00.000Z' }),
    ],
    previewText: 'stale preview',
  });
  assert.equal(insertedMessages.length, 2, '批量消息必须全部插入');
  assert.equal(previewUpdates(fake).length, 0, '最后一条 inserted 非稳定时间线末尾时不得更新 preview');
  assert.equal(
    fake.sessions.size,
    0,
    '批量乱序时 session preview 不得被写入',
  );
}

// 测试 6：批量输入包含不同 session 时整体失败，不得部分写入
{
  const fake = createFakeDatabase();
  const coordinator = createCoordinator(fake);
  globalThis.__TEST_COORDINATOR_HOLDER__ = coordinator;
  const repo = new MessageRepository();

  await assert.rejects(
    repo.commitMessages({
      messages: [
        makeMessage({ sessionId: 's1', text: 'a', createdAt: '2026-08-03T10:00:00.000Z' }),
        makeMessage({ sessionId: 's2', text: 'b', createdAt: '2026-08-03T10:01:00.000Z' }),
      ],
      previewText: 'preview',
    }),
    /multiple sessions/,
  );
  assert.equal(fake.messages.size, 0, '跨 session 输入必须整体失败，不得部分写入');
  assert.equal(fake.sessions.size, 0, '跨 session 输入不得更新任何 session preview');
  assert.equal(coordinator.transactionCount, 1, '不变量校验必须发生在同一事务内并整体回滚');
}

// 测试 7：公开 commitMessage / commitMessages 各进入一个事务；失败时整体回滚
{
  const fake = createFakeDatabase();
  const coordinator = createCoordinator(fake);
  globalThis.__TEST_COORDINATOR_HOLDER__ = coordinator;
  const repo = new MessageRepository();

  const inserted = await repo.commitMessage({
    message: makeMessage({ createdAt: '2026-08-03T09:00:00.000Z' }),
    previewText: 'final',
  });
  assert.equal(inserted.showTimeSeparatorBefore, true, '空会话首条消息显示时间分隔');
  assert.equal(fake.sessions.get('s1').last_message, 'final', 'preview 使用最终 previewText');
  assert.equal(previewUpdates(fake).length, 1, '单条提交只更新一次 preview');
  assert.equal(coordinator.transactionCount, 1, '单条提交只进入一个事务');
}

{
  const fake = createFakeDatabase();
  const originalRun = fake.executor.runAsync;
  let insertAttempts = 0;
  fake.executor.runAsync = async (source, params = []) => {
    if (source.startsWith('INSERT INTO messages')) {
      insertAttempts += 1;
      if (insertAttempts === 2) {
        throw new Error('injected insert failure');
      }
    }
    return originalRun(source, params);
  };
  const coordinator = createCoordinator(fake);
  globalThis.__TEST_COORDINATOR_HOLDER__ = coordinator;
  const repo = new MessageRepository();

  await assert.rejects(
    repo.commitMessages({
      messages: [
        makeMessage({ createdAt: '2026-08-03T10:00:00.000Z' }),
        makeMessage({ createdAt: '2026-08-03T10:01:00.000Z' }),
      ],
      previewText: 'preview',
    }),
    /injected insert failure/,
  );
  assert.equal(fake.messages.size, 0, '批量插入失败后整个事务必须回滚，无残留消息');
  assert.equal(fake.sessions.size, 0, '批量插入失败后 session preview 不得被更新');
  assert.equal(coordinator.transactionCount, 1, '批量提交必须整体处于单一事务');
}

{
  const fake = createFakeDatabase();
  const originalRun = fake.executor.runAsync;
  fake.executor.runAsync = async (source, params = []) => {
    if (source.startsWith('UPDATE sessions')) {
      throw new Error('injected preview failure');
    }
    return originalRun(source, params);
  };
  const coordinator = createCoordinator(fake);
  globalThis.__TEST_COORDINATOR_HOLDER__ = coordinator;
  const repo = new MessageRepository();

  await assert.rejects(
    repo.commitMessages({
      messages: [
        makeMessage({ createdAt: '2026-08-03T10:00:00.000Z' }),
        makeMessage({ createdAt: '2026-08-03T10:01:00.000Z' }),
      ],
      previewText: 'preview',
    }),
    /injected preview failure/,
  );
  assert.equal(fake.messages.size, 0, 'preview 更新失败后消息插入必须整体回滚');
  assert.equal(fake.sessions.size, 0, 'preview 更新失败后 session preview 不得残留');

  await assert.rejects(
    repo.commitMessage({
      message: makeMessage({ createdAt: '2026-08-03T10:05:00.000Z' }),
      previewText: 'preview',
    }),
    /injected preview failure/,
  );
  assert.equal(fake.messages.size, 0, '单条 preview 更新失败后消息插入必须整体回滚');
  assert.equal(coordinator.transactionCount, 2, '单条提交也只应进入一个事务');
}

// ============================================================================
// application 层：commit 成功后才通知 UI
// ============================================================================
const persistenceSource = read('src/features/chat/messages/application/MessagePersistence.ts');
const persistenceModuleUrl = transpileToModuleUrl(persistenceSource);
const { persistChatMessage, persistChatMessages } = await import(persistenceModuleUrl);

function makeEntity(message, id) {
  return {
    id,
    sessionId: message.sessionId,
    text: message.text,
    isMe: message.isMe,
    isRead: true,
    senderType: message.senderType,
    time: message.time,
    createdAt: message.createdAt,
    showTimeSeparatorBefore: message.showTimeSeparatorBefore ?? false,
    status: message.status || 'sent',
  };
}

// 测试 8：单条 commit 成功后才 notifyUI
{
  const trace = [];
  let commitInput = null;
  const repository = {
    commitMessage: async (input) => {
      commitInput = input;
      trace.push('commit');
      return makeEntity(input.message, 1);
    },
  };

  const insertedMessage = await persistChatMessage({
    repository,
    message: makeMessage({ sessionId: 's1', text: 'hello', createdAt: '2026-08-03T10:00:00.000Z' }),
    notifyUI: () => { trace.push('ui'); },
  });
  assert.equal(insertedMessage.id, 1, '必须返回 commit 后的完整消息');
  assert.equal(commitInput.previewText, 'hello', '未显式传 previewText 时使用消息文本');
  assert.deepEqual(trace, ['commit', 'ui'], 'commit 成功后才更新 UI');
}

// 测试 9：commit 失败时不得 notifyUI
{
  const failingRepository = {
    commitMessage: async () => { throw new Error('injected insert failure'); },
  };
  let uiCalled = false;
  await assert.rejects(
    persistChatMessage({
      repository: failingRepository,
      message: makeMessage({ sessionId: 's1', text: 'hello', createdAt: '2026-08-03T10:00:00.000Z' }),
      notifyUI: () => { uiCalled = true; },
    }),
    /injected insert failure/,
  );
  assert.equal(uiCalled, false, 'commit 失败不得通知 UI');
}

// 测试 10：批量 commit 成功后只通知一次 UI
{
  let uiCalls = 0;
  let commitInput = null;
  const repository = {
    commitMessages: async (input) => {
      commitInput = input;
      return input.messages.map((message, index) => makeEntity(message, index + 1));
    },
  };

  const messages = [
    makeMessage({ sessionId: 's1', text: 'first', createdAt: '2026-08-03T11:00:00.000Z' }),
    makeMessage({ sessionId: 's1', text: 'second', createdAt: '2026-08-03T11:01:00.000Z' }),
  ];
  const insertedMessages = await persistChatMessages({
    repository,
    messages,
    notifyUI: () => { uiCalls += 1; },
  });
  assert.equal(insertedMessages.length, 2, '批量提交必须返回全部消息');
  assert.equal(commitInput.previewText, 'second', '批量未显式传 previewText 时使用最后一条消息文本');
  assert.equal(uiCalls, 1, '批量 commit 成功后只通知一次 UI');
}

// 测试 11：批量 commit 失败时不得 notifyUI
{
  const failingRepository = {
    commitMessages: async () => { throw new Error('injected batch failure'); },
  };
  let uiCalled = false;
  await assert.rejects(
    persistChatMessages({
      repository: failingRepository,
      messages: [
        makeMessage({ sessionId: 's1', text: 'first', createdAt: '2026-08-03T11:00:00.000Z' }),
        makeMessage({ sessionId: 's1', text: 'second', createdAt: '2026-08-03T11:01:00.000Z' }),
      ],
      notifyUI: () => { uiCalled = true; },
    }),
    /injected batch failure/,
  );
  assert.equal(uiCalled, false, '批量 commit 失败不得通知 UI');
}

// 测试 12：canonical user commit 的提交后副作用失败不得伪装成提交失败。
// 事务一旦提交，业务事实不可撤回；若把 UI 通知或 supersede 投影清理失败上报为
// 提交失败，调用方（语音消息）会按失败路径删除已经被 committed 事实接管的媒体
// backing，导致消息引用的音频文件永久丢失。
{
  const canonicalCommitPersistenceStubUrl = transpileToModuleUrl(`
export const databaseCoordinator = {
  transaction: async (_meta, task) => task({ transaction: 'same-executor' }),
};
`);
  const canonicalCommitTimelineStubUrl = transpileToModuleUrl(`
export function clearAgentTransientTimelineRun() {
  throw new Error('transient timeline cleanup failed');
}
`);
  const canonicalCommitRuntimeStubUrl = transpileToModuleUrl(`
export function getChatMessageRuntimeDependencies() {
  return { turnPresentation: { freeze: async () => async () => {}, interrupt: async () => { throw new Error('展示刷新失败'); } } };
}
`);
  const commitCanonicalModuleUrl = transpileToModuleUrl(
    read('src/features/chat/messages/application/CommitCanonicalUserMessage.ts')
      .replace("from '../events/ChatEvents'", `from '${transpileToModuleUrl(read('src/features/chat/messages/events/ChatEvents.ts'))}'`)
      .replace(
        /from\s*['"]@platform\/persistence['"]/,
        `from '${canonicalCommitPersistenceStubUrl}'`,
      )
      .replace(
        /from\s*['"]\.\/AgentTransientTimeline['"]/,
        `from '${canonicalCommitTimelineStubUrl}'`,
      )
      .replace(
        /from\s*['"]\.\/ChatMessageRuntime['"]/,
        `from '${canonicalCommitRuntimeStubUrl}'`,
      ),
  );
  const { commitCanonicalUserMessage } = await import(commitCanonicalModuleUrl);

  const repository = {
    commitMessageInTransaction: async (_transaction, params) => makeEntity(params.message, 7),
  };
  const turns = {
    ensureTurnStateRowInTransaction: async () => undefined,
    supersedeActiveRunInTransaction: async () => 'run-old',
  };
  const message = makeMessage({
    sessionId: 's1',
    text: 'voice transcript',
    createdAt: '2026-08-03T12:00:00.000Z',
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  let result;
  let notifyAttempts = 0;
  try {
    result = await commitCanonicalUserMessage({
      repository,
      turns,
      message,
      notifyUI: () => {
        notifyAttempts += 1;
        throw new Error('ui refresh failed');
      },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.message.id, 7, '提交后副作用失败不得伪装成提交失败');
  assert.equal(result.supersededRunId, 'run-old');
  assert.equal(notifyAttempts, 1, 'UI 通知已经执行，只是失败被降级为报告');

  const failingTransactionRepository = {
    commitMessageInTransaction: async () => { throw new Error('injected message failure'); },
  };
  await assert.rejects(
    commitCanonicalUserMessage({ repository: failingTransactionRepository, turns, message }),
    /injected message failure/,
    '真正的提交失败仍必须抛出',
  );
}

console.log('Chat 消息原子提交行为测试通过');
