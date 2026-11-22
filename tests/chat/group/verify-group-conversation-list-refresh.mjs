/** 验证首页群聊预览响应消息事实，并在到达进度与异步读取交错后收敛。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    assert.ok(Object.hasOwn(mocks, id), `${file}: 缺少依赖 ${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const buses = new Set();
let listReads = 0;
let arrival = { revision: 0 };
let message = '旧消息';
let time = '2026-10-23T01:00:00Z';
let previewGate = null;
let nextListGate = null;
let previewReads = 0;
let readyCount = 0;
let chat;
const screen = { aiList: [], aiListReady: true, preloadConversationTimelines: async () => {} };
const group = { id: 'group-a', name: '测试群', lastMessage: '持久预览', createdAt: time };
const preparation = load('src/features/chat/presentation/shell/ConversationPreparationController.ts');
const { ChatRouterProvider, useChatRouter } = load('src/features/chat/presentation/shell/ChatRouterContext.tsx', {
  './useChatScreen': { __esModule: true, default: () => screen },
  './ChatTextDraftProvider': { ChatTextDraftProvider: ({ children }) => children },
  './ConversationPreparationController': preparation,
  './conversationPreloadCandidates': {
    buildConversationPreloadCandidates: () => [],
    resolveConversationPreloadHotSet: () => ({ signature: '', shouldPreload: false, candidates: [] }),
    resolveConversationPreloadFreshnessChanges: () => ({ snapshot: {}, changedCandidates: [] }),
  },
  '../messages/components/sessionTimelineCache': {},
  './arrivedConversationPreview': { withArrivedConversationPreview: async item => {
    previewReads++;
    const result = { ...item, lastMessage: message, lastTime: time };
    if (previewGate) await previewGate.promise;
    return result;
  } },
  '../../group/application': { listGroupChats: async () => {
    listReads++;
    const gate = nextListGate;
    nextListGate = null;
    return gate ? gate.promise : [group];
  } },
  '../../conversation/application/ConversationPin': {},
  '../../conversation/application/ChatPresentation': {},
  '../../reply/delivery/AssistantMessageArrival': { getAssistantMessageArrivalSnapshot: () => arrival },
  '../../messages/events/ChatEvents': { setChatEventBus: bus => {
    buses.add(bus);
    return () => { buses.delete(bus); };
  } },
  '@shared/runtime/ConversationListReadySignal': { markConversationListReady: () => { readyCount++; } },
  '@features/profile': { DEFAULT_USER_PROFILE: {}, getCurrentUserProfile: async () => ({}), subscribeUserProfileUpdated: () => () => {} },
});
function Probe() { chat = useChatRouter(); return null; }
const emit = (event, sessionId = group.id) => Promise.all([...buses].map(bus => bus.emit(event, { sessionId })));
let renderer;
try {
  await act(async () => { renderer = create(React.createElement(ChatRouterProvider, {
    dbReady: true, conversationListLoadEnabled: true,
  }, React.createElement(Probe))); });
  assert.equal(chat.groupChats[0].lastMessage, '旧消息');
  assert.equal(readyCount, 1);

  for (const event of ['messagesUpdated', 'messagesPatched', 'messagesDeleted', 'messagesReloadRequested']) {
    message = `更新：${event}`;
    time = '2026-10-23T02:00:00Z';
    await act(async () => { await emit(event); });
    assert.equal(chat.groupChats[0].lastMessage, message, `${event} 无需退出聊天或手动刷新即可更新首页预览`);
    assert.equal(chat.groupChats[0].lastTime, time, '排序时间与预览同时更新');
  }
  const beforeUnrelated = listReads;
  await act(async () => { await emit('typingStatusChanged'); await emit('groupSpeechPlanChanged'); await emit('messagesUpdated', 'direct-session'); });
  assert.equal(listReads, beforeUnrelated, '输入状态、计划状态与其他会话不重读群列表');

  previewGate = deferred();
  let refresh;
  const beforeArrival = listReads;
  const beforePreview = previewReads;
  await act(async () => { refresh = chat.refreshGroupChats(); });
  await act(async () => {
    message = '读取期间刚到达的消息';
    arrival = { revision: 1 };
    previewGate.resolve();
    await refresh;
  });
  previewGate = null;
  assert.equal(chat.groupChats[0].lastMessage, message, '到达进度交错时不能丢弃唯一一次列表刷新');
  assert.equal(listReads, beforeArrival + 1, '到达变化只重算预览，不重复读取群资料');
  assert.equal(previewReads, beforePreview + 2);

  const oldListGate = deferred();
  nextListGate = oldListGate;
  let oldRefresh;
  await act(async () => { oldRefresh = chat.refreshGroupChats(); });
  message = '较新读取的消息';
  await act(async () => { await chat.refreshGroupChats(); });
  await act(async () => { oldListGate.resolve([{ ...group, name: '迟到的旧群资料' }]); await oldRefresh; });
  assert.equal(chat.groupChats[0].name, group.name, '旧读取不得覆盖新读取');
  assert.equal(chat.groupChats[0].lastMessage, message);
} finally {
  await act(async () => { renderer?.unmount(); });
}
assert.equal(buses.size, 0, '卸载后释放消息订阅');
console.log('群聊首页预览验证通过：消息变更即时刷新、到达交错收敛、旧读取隔离与订阅清理。');
