/**
 * 聊天进入（entry）与预热（preload）的行为测试。
 *
 * 验证的是真实 Hook 模块，只替换环境依赖（react / react-native / MessageTimeline /
 * ResolveCanonicalConversation），因此断言的是产品语义而不是影子实现：
 *
 *   1. 只要身份已知（preparedSession / 一次 resolve）就立刻进入，不等待任何 timeline；
 *   2. 预热失败、未预热、预热批次尚未跑完，都不影响导航正确性；
 *   3. brand-new AI 的 canonical 身份解析与时间线预热彻底分离；
 *   4. 预热按统一会话列表顺序分层执行，全部走 maintenance 优先级；
 *   5. 已缓存的会话不会被重复读库。
 */

/*
 * 本脚本是 Node 侧的行为夹具：react / react-native 被替换成最小 stub，
 * Hook 在 React 渲染树之外被直接调用是有意为之，rules-of-hooks 不适用。
 */
/* eslint-disable react-hooks/rules-of-hooks */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { CommonActions, StackRouter } from '@react-navigation/routers';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ============================================================================
// 环境 stub
// ============================================================================
const reactStubUrl = transpileToModuleUrl(`
export function useRef(initialValue) { return { current: initialValue }; }
export function useCallback(fn) { return fn; }
export function useMemo(fn) { return fn(); }
export function useState(initialValue) { return [initialValue, () => {}]; }
export function useEffect() {}
`);
const sharedUiStubUrl = transpileToModuleUrl(`
export function showAppDialog(input) { globalThis.__ENTRY_ENV__.alerts.push(input); }
`);
const assistantStubUrl = transpileToModuleUrl(`
export function getAssistantDisplayName(assistant) { return assistant.nickname ?? assistant.name; }
`);
const reactNativeStubUrl = transpileToModuleUrl(`
export const Alert = {
  alert: (...args) => { globalThis.__ENTRY_ENV__.alerts.push(args); },
};
export const InteractionManager = {
  runAfterInteractions(callback) {
    globalThis.__PRELOAD_ENV__.pendingInteractions.push(callback);
    return { cancel() {} };
  },
};
`);
const resolveConversationStubUrl = transpileToModuleUrl(`
export async function resolveCanonicalConversation(params) {
  return globalThis.__PRELOAD_ENV__.resolveCanonicalConversation(params);
}
`);
const chatPresentationStubUrl = transpileToModuleUrl(`
export async function getCanonicalChatConversation(aiId) {
  return globalThis.__PRELOAD_ENV__.getCanonicalChatConversation(aiId);
}
`);
const messageTimelineStubUrl = transpileToModuleUrl(`
export const messageTimeline = {
  open: (params) => globalThis.__PRELOAD_ENV__.openTimeline(params),
  getLastMessageId: (messages) => (
    !Array.isArray(messages) || messages.length === 0
      ? null
      : Math.max(...messages.map((message) => message.id))
  ),
};
`);

const chatBottomAnchorUrl = transpileToModuleUrl(read(
  'src/features/chat/presentation/messages/components/chatBottomAnchorExperiment.ts',
));
const sessionTimelineCacheUrl = transpileToModuleUrl(
  read('src/features/chat/presentation/messages/components/sessionTimelineCache.ts')
    .replaceAll(
      `from './chatBottomAnchorExperiment'`,
      `from '${chatBottomAnchorUrl}'`,
    ),
);

const timelineCacheModule = await import(sessionTimelineCacheUrl);

const chatScreenTypesUrl = transpileToModuleUrl(read(
  'src/features/chat/presentation/shell/chatScreenTypes.ts',
));
const orderingModuleUrl = transpileToModuleUrl(read(
  'src/shared/utils/conversationListOrdering.ts',
));
const preloadCandidatesUrl = transpileToModuleUrl(
  read('src/features/chat/presentation/shell/conversationPreloadCandidates.ts')
    .replaceAll(
      `from '@shared/utils/conversationListOrdering'`,
      `from '${orderingModuleUrl}'`,
    ),
);
const preloadCandidatesModule = await import(preloadCandidatesUrl);

const preloadHookUrl = transpileToModuleUrl(
  read('src/features/chat/presentation/shell/useChatEntryPreload.ts')
    .replaceAll(`from 'react'`, `from '${reactStubUrl}'`)
    .replaceAll(`from 'react-native'`, `from '${reactNativeStubUrl}'`)
    .replaceAll(
      `from '../../conversation/application/ResolveCanonicalConversation'`,
      `from '${resolveConversationStubUrl}'`,
    )
    .replaceAll(
      `from '../../conversation/application/ChatPresentation'`,
      `from '${chatPresentationStubUrl}'`,
    )
    .replaceAll(
      `from '../../messages/application/MessageTimeline'`,
      `from '${messageTimelineStubUrl}'`,
    )
    .replaceAll(
      `from '../messages/components/sessionTimelineCache'`,
      `from '${sessionTimelineCacheUrl}'`,
    )
    .replaceAll(
      `from '../messages/components/chatBottomAnchorExperiment'`,
      `from '${chatBottomAnchorUrl}'`,
    )
    .replaceAll(`from './conversationPreloadCandidates'`, `from '${preloadCandidatesUrl}'`)
    .replaceAll(`from './chatScreenTypes'`, `from '${chatScreenTypesUrl}'`),
);
const { useChatEntryPreload } = await import(preloadHookUrl);

const entryHookUrl = transpileToModuleUrl(
  read('src/features/chat/presentation/shell/useChatConversationEntry.ts')
    .replaceAll(`from '@features/assistants'`, `from '${assistantStubUrl}'`)
    .replaceAll(`from 'react'`, `from '${reactStubUrl}'`)
    .replaceAll(`from '@shared/ui'`, `from '${sharedUiStubUrl}'`)
    .replaceAll(`from 'react-native'`, `from '${reactNativeStubUrl}'`),
);
const { useChatConversationEntry } = await import(entryHookUrl);

// ============================================================================
// fixture / harness
// ============================================================================
function createPreloadEnv() {
  const calls = [];
  const failingSessions = new Set();
  const env = {
    calls,
    failingSessions,
    pendingInteractions: [],
    resolveCanonicalConversation: async () => null,
    getCanonicalChatConversation: async () => null,
    openTimeline: async ({ sessionId, limit, priority }) => {
      calls.push({ sessionId, limit, priority });
      if (failingSessions.has(sessionId)) {
        return { messages: [], hasMore: false, nextCursor: null, success: false, error: '读取失败' };
      }
      return {
        messages: [{ id: 1 }, { id: 2 }],
        hasMore: false,
        nextCursor: 1,
        success: true,
        error: null,
      };
    },
  };
  globalThis.__PRELOAD_ENV__ = env;
  return env;
}

function createEntryEnv() {
  const env = { alerts: [] };
  globalThis.__ENTRY_ENV__ = env;
  return env;
}

function createAssistant(id, overrides = {}) {
  return {
    id,
    agentId: `agent_${id}`,
    name: id,
    isBlocked: false,
    canonicalConversationId: `session_${id}`,
    isPinned: false,
    lastTime: '2026-09-01T00:00:00.000Z',
    lastMessage: 'hi',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createSession(id, aiId) {
  return {
    id,
    aiAssistantId: aiId,
    name: '会话',
    lastMessage: null,
    lastTime: null,
    isPinned: false,
    visibleAfterMessageId: null,
    visibleAfterAt: null,
  };
}

function createEntryHarness({ resolveResult, resolver } = {}) {
  const captured = { currentAI: undefined, currentSession: undefined, subScreen: undefined, viewed: [] };
  let resolveCount = 0;
  const resolveCalls = [];
  let loadCount = 0;

  const api = useChatConversationEntry({
    currentAI: null,
    setCurrentAI: (ai) => { captured.currentAI = ai; },
    setCurrentSession: (session) => { captured.currentSession = session; },
    setCurrentSubScreen: (screen) => { captured.subScreen = screen; },
    loadAIAssistants: async () => { loadCount += 1; return []; },
    removeAIAssistant: async () => {},
    resolveConversation: resolver ?? (async (ai) => {
      resolveCount += 1;
      resolveCalls.push(ai.id);
      if (typeof resolveResult === 'function') {
        return resolveResult(ai);
      }
      return createSession(`session_${ai.id}`, ai.id);
    }),
    onConversationViewed: (aiId) => { captured.viewed.push(aiId); },
  });

  return {
    api,
    captured,
    resolveCalls,
    getResolveCount: () => resolveCount,
    getLoadCount: () => loadCount,
  };
}

function createPreloadHarness() {
  return useChatEntryPreload({
    currentAI: null,
    setCurrentSession: () => {},
  });
}

// ============================================================================
// entry：只要身份已知就立即进入（10 / 11 / 13 / 15 / 16）
// ============================================================================
{
  createPreloadEnv();
  createEntryEnv();

  // 13 / 10：preparedSession → 不调用 resolveConversation，直接进入。
  {
    const harness = createEntryHarness();
    const ai = createAssistant('ai_prepared');
    const prepared = createSession('session_prepared', ai.id);

    const result = await harness.api.handleSelectAI(ai, { preparedSession: prepared });

    assert.equal(result, 'completed', 'preparedSession 必须直接进入');
    assert.equal(harness.getResolveCount(), 0, '已有 preparedSession 时不得再解析身份');
    assert.equal(harness.captured.currentSession, prepared);
    assert.equal(harness.captured.currentAI.canonicalConversationId, 'session_prepared');
  }

  // 11 / 15：没有 preparedSession 也立即进入（un-preloaded AI 同样如此）。
  {
    const harness = createEntryHarness();
    const ai = createAssistant('ai_not_preloaded');

    const result = await harness.api.handleSelectAI(ai);

    assert.equal(result, 'completed', '未预热的会话仍然可以直接进入');
    assert.equal(harness.getResolveCount(), 1, '只做一次 canonical 身份解析');
    assert.equal(harness.captured.currentSession.id, 'session_ai_not_preloaded');
  }

  // 16：brand-new AI 只解析/创建身份，不读任何 timeline。
  {
    const env = createPreloadEnv();
    const harness = createEntryHarness();
    const brandNew = createAssistant('ai_brand_new', { canonicalConversationId: null });

    const result = await harness.api.handleSelectAI(brandNew);

    assert.equal(result, 'completed', 'brand-new AI 解析身份后即可进入');
    assert.deepEqual(harness.resolveCalls, ['ai_brand_new']);
    assert.equal(
      env.calls.length,
      0,
      '身份解析路径不得包含任何 timeline 读取（创建身份与预热必须分离）',
    );
  }

  // 14：进入 → 立即退出 → 再次进入，仍然直接进入（预热与否都不影响）。
  {
    const env = createPreloadEnv();
    const harness = createEntryHarness();
    const ai = createAssistant('ai_reentry');

    assert.equal(await harness.api.handleSelectAI(ai), 'completed');
    await harness.api.handleBackToList();
    assert.equal(harness.captured.currentAI, null, '退出后清空当前会话');
    assert.ok(harness.getLoadCount() >= 1, '返回列表必须重读会话列表');

    assert.equal(await harness.api.handleSelectAI(ai), 'completed', '再次进入仍然立即成功');
    assert.equal(env.calls.length, 0, '整条往返路径都不依赖 timeline 预热');
  }

  // 身份解析路径：已存在的 canonical 会话只做索引读，只有 brand-new 才创建；
  // 无论哪条路径都不允许在进入前读取 timeline。
  {
    const env = createPreloadEnv();
    const preload = createPreloadHarness();
    const stats = { read: 0, create: 0 };
    env.getCanonicalChatConversation = async (aiId) => {
      stats.read += 1;
      return aiId === 'ai_existing' ? createSession('session_ai_existing', aiId) : null;
    };
    env.resolveCanonicalConversation = async ({ aiId }) => {
      stats.create += 1;
      return createSession(`session_${aiId}`, aiId);
    };

    const harness = createEntryHarness({ resolver: preload.resolveConversation });

    assert.equal(await harness.api.handleSelectAI(createAssistant('ai_existing')), 'completed');
    assert.deepEqual({ ...stats }, { read: 1, create: 0 }, '已有 canonical 会话时进入路径只读不写');
    assert.equal(env.calls.length, 0, '进入路径不得读取 timeline');

    assert.equal(
      await harness.api.handleSelectAI(createAssistant('brand_new_ai', { canonicalConversationId: null })),
      'completed',
    );
    assert.deepEqual({ ...stats }, { read: 2, create: 1 }, '只有 brand-new AI 才创建 canonical 身份');
    assert.equal(env.calls.length, 0, '创建身份同样不得附带 timeline 读取');
  }

  // 被拉黑：明确提示，不进入。
  {
    const entryEnv = createEntryEnv();
    const harness = createEntryHarness();
    const blocked = createAssistant('ai_blocked', { isBlocked: true });

    assert.equal(await harness.api.handleSelectAI(blocked), 'completed');
    assert.equal(entryEnv.alerts.length, 1, '被拉黑必须给出明确提示');
    assert.equal(harness.captured.currentSession, undefined, '被拉黑不得进入会话');
  }

  // 请求换代：过期 requestId 不得覆盖新的进入请求。
  {
    createEntryEnv();
    const harness = createEntryHarness();
    const staleRequestId = harness.api.beginChatEntryRequest();
    harness.api.beginChatEntryRequest();

    const result = await harness.api.handleSelectAI(
      createAssistant('ai_stale'),
      { requestId: staleRequestId },
    );

    assert.equal(result, 'superseded', '过期的进入请求必须被丢弃');
    assert.equal(harness.captured.currentSession, undefined);
  }

  // entry 的公开契约里不得再有「正在进入对话」这类全屏过渡状态。
  {
    createEntryEnv();
    const harness = createEntryHarness();
    const keys = Object.keys(harness.api);
    assert.ok(!keys.includes('isEnteringChat'), '不得暴露 isEnteringChat 全屏过渡状态');
    assert.ok(!keys.includes('enteringAI'), '不得暴露 enteringAI 全屏过渡状态');
  }
}

// ============================================================================
// entry：预热失败 / 未完成都不影响导航（12 / 25）
// ============================================================================
{
  const env = createPreloadEnv();
  createEntryEnv();
  const preload = createPreloadHarness();

  env.failingSessions.add('session_ai_failing'); // 让该会话的 timeline 读取失败
  const failingRun = preload.preloadConversationTimelines([
    {
      kind: 'direct',
      id: 'ai_failing',
      sessionId: 'session_ai_failing',
      isPinned: false,
      lastActivityAt: '2026-09-01T00:00:00.000Z',
      pinnedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  await flushAsyncWork();
  env.pendingInteractions.splice(0).forEach((callback) => callback());
  await failingRun;

  const harness = createEntryHarness();
  const result = await harness.api.handleSelectAI(createAssistant('ai_failing'));

  assert.equal(result, 'completed', '预热失败后仍然可以正常进入');
  assert.equal(harness.captured.currentSession.id, 'session_ai_failing');
  assert.equal(
    timelineCacheModule.getSessionTimelineCache('session_ai_failing'),
    null,
    'fixture：预热读失败时不得写入 timeline cache',
  );
}

// ============================================================================
// preload：分层执行 / 统一顺序 / 低优先级 / 失败隔离 / 缓存命中
// ============================================================================
{
  const env = createPreloadEnv();
  const preload = createPreloadHarness();

  const aiList = Array.from({ length: 20 }, (_, index) => createAssistant(
    `ai_${String(index).padStart(2, '0')}`,
    { lastTime: new Date(Date.UTC(2026, 8, 26) - index * 60_000).toISOString() },
  ));
  // 群聊：会话身份就是 groupId，时间落在中间，必须参与同一套排序。
  const groupChats = [{
    id: 'group_01',
    name: '群聊',
    avatar: null,
    avatarMediaAssetId: null,
    lastMessage: null,
    lastTime: new Date(Date.UTC(2026, 8, 26, 12)).toISOString(),
    isPinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }];

  const candidates = Array.from(preloadCandidatesModule.buildConversationPreloadCandidates({
    aiList,
    groupChats,
  }));

  assert.ok(
    candidates.some((candidate) => candidate.kind === 'group'),
    '群聊必须进入预热候选',
  );

  const runPromise = preload.preloadConversationTimelines(candidates);
  await flushAsyncWork();

  assert.deepEqual(
    Array.from(env.calls, (call) => call.sessionId),
    Array.from(candidates.slice(0, 6), (candidate) => candidate.sessionId),
    '第一层只预热统一列表最前面的 6 个会话，且顺序与列表一致',
  );
  assert.equal(env.pendingInteractions.length, 1, '第一层跑完后才等待关键交互稳定');

  const interactionCallback = env.pendingInteractions.shift();
  interactionCallback();
  await runPromise;

  assert.deepEqual(
    Array.from(env.calls, (call) => call.sessionId),
    Array.from(candidates.slice(0, 16), (candidate) => candidate.sessionId),
    '第二层继续预热到 TARGET，且不改变顺序',
  );
  assert.ok(
    env.calls.every((call) => call.priority === 'maintenance'),
    '后台预热必须使用 maintenance 优先级，不得伪装成交互工作',
  );
  assert.ok(
    env.calls.every((call) => call.limit > 0),
    '预热必须复用首屏窗口大小',
  );
}

// 失败隔离：单个会话读取失败不中断整批，也不抛出。
{
  const env = createPreloadEnv();
  const preload = createPreloadHarness();
  env.failingSessions.add('session_fail_mid');

  const batch = ['session_ok_1', 'session_fail_mid', 'session_ok_2'].map((sessionId, index) => ({
    kind: 'direct',
    id: `ai_batch_${index}`,
    sessionId,
    isPinned: false,
    lastActivityAt: '2026-09-01T00:00:00.000Z',
    pinnedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));

  await preload.preloadConversationTimelines(batch);
  env.pendingInteractions.splice(0).forEach((callback) => callback());
  await flushAsyncWork();

  assert.deepEqual(
    Array.from(env.calls, (call) => call.sessionId),
    ['session_ok_1', 'session_fail_mid', 'session_ok_2'],
    '单条预热失败不得中断后续会话',
  );
}

// 缓存命中：已缓存的会话不得重复读库；并发预热同一会话只读一次。
{
  const env = createPreloadEnv();
  const preload = createPreloadHarness();

  timelineCacheModule.setSessionTimelineCache({
    sessionId: 'session_cached',
    messages: [{ id: 9 }],
    hasMore: false,
    nextCursor: 9,
    lastMessageId: 9,
  });

  const cachedCandidate = {
    kind: 'direct',
    id: 'ai_cached',
    sessionId: 'session_cached',
    isPinned: false,
    lastActivityAt: '2026-09-01T00:00:00.000Z',
    pinnedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const first = preload.warmConversationEntry(cachedCandidate);
  const second = preload.warmConversationEntry(cachedCandidate);
  await Promise.all([first, second]);

  assert.deepEqual(env.calls, [], '缓存命中时必须跳过读库');

  const freshCandidate = {
    ...cachedCandidate,
    id: 'ai_fresh',
    sessionId: 'session_fresh',
  };
  const firstFresh = preload.warmConversationEntry(freshCandidate);
  const secondFresh = preload.warmConversationEntry(freshCandidate);
  await Promise.all([firstFresh, secondFresh]);

  assert.deepEqual(
    Array.from(env.calls, (call) => call.sessionId),
    ['session_fresh'],
    '同一会话的并发预热只能读一次',
  );
}


// ============================================================================
// I：热点集合变化后开新一轮预热，但已缓存的候选不得重复读 SQLite
// ============================================================================
{
  const env = createPreloadEnv();
  const preload = createPreloadHarness();

  // 「新一轮」由动态热点集合签名触发；这里直接验证新一轮里的读行为。
  timelineCacheModule.setSessionTimelineCache({
    sessionId: 'session_hot_cached',
    messages: [{ id: 42 }],
    hasMore: false,
    nextCursor: 42,
    lastMessageId: 42,
  });

  const hotCandidates = [
    {
      kind: 'direct',
      id: 'ai_hot_cached',
      sessionId: 'session_hot_cached',
      isPinned: false,
      lastActivityAt: '2026-09-18T12:00:00.000Z',
      pinnedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      kind: 'direct',
      id: 'ai_hot_new',
      sessionId: 'session_hot_new',
      isPinned: false,
      lastActivityAt: '2026-09-18T11:00:00.000Z',
      pinnedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      kind: 'group',
      id: 'group_hot_new',
      sessionId: 'group_hot_new',
      isPinned: false,
      lastActivityAt: '2026-09-18T10:00:00.000Z',
      pinnedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const run = preload.preloadConversationTimelines(hotCandidates);
  await flushAsyncWork();
  env.pendingInteractions.splice(0).forEach((callback) => callback());
  await run;

  assert.deepEqual(
    Array.from(env.calls, (call) => call.sessionId),
    ['session_hot_new', 'group_hot_new'],
    '新一轮预热必须跳过已缓存的候选（cache hit 不重复读 SQLite），并覆盖群聊候选',
  );
  assert.ok(
    env.calls.every((call) => call.priority === 'maintenance'),
    '新一轮预热同样必须使用 maintenance 优先级',
  );
}


// ============================================================================
// A / D：stale timeline cache 不再短路定向刷新（freshness → invalidate → 回 DB）
// ============================================================================
{
  const TARGET = preloadCandidatesModule.CHAT_ENTRY_PRELOAD_TARGET;
  const T10 = '2026-09-18T10:00:00.000Z';
  const T11 = '2026-09-18T11:00:00.000Z';
  const candidateOf = (id, lastActivityAt) => ({
    kind: 'direct',
    id,
    sessionId: `session_${id}`,
    isPinned: false,
    lastActivityAt,
    pinnedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const cacheAll = (candidates) => {
    for (const candidate of candidates) {
      timelineCacheModule.setSessionTimelineCache({
        sessionId: candidate.sessionId,
        messages: [{ id: 1 }],
        hasMore: false,
        nextCursor: 1,
        lastMessageId: 1,
      });
    }
  };
  const sessionIdsOf = (candidates) => Array.from(candidates, (candidate) => candidate.id);

  const env = createPreloadEnv();
  const preload = createPreloadHarness();

  const staleCandidate = candidateOf('ai_stale', T10);
  const freshCandidates = [candidateOf('ai_fresh_a', T10), candidateOf('ai_fresh_b', T10)];
  cacheAll([staleCandidate, ...freshCandidates]);

  // 上一轮 snapshot 与当前事实：只有 ai_stale 的消息时间前进（top 集合不变）。
  const previousSnapshot = preloadCandidatesModule.buildConversationPreloadFreshnessSnapshot(
    [staleCandidate, ...freshCandidates],
    TARGET,
  );
  const advancedStale = { ...staleCandidate, lastActivityAt: T11 };
  const changes = preloadCandidatesModule.resolveConversationPreloadFreshnessChanges({
    previous: previousSnapshot,
    candidates: [advancedStale, ...freshCandidates],
  });

  assert.deepEqual(
    sessionIdsOf(changes.changedCandidates),
    ['ai_stale'],
    '只有 timeline 事实变化的会话被判定为过期',
  );

  // 根因：不判 invalid 的话，旧 cache 会把这一轮预热短路成「什么都没刷新」。
  await preload.warmConversationEntry(advancedStale);
  assert.equal(
    Array.from(env.calls).length,
    0,
    '未判 invalid 时 stale cache 会短路读库 —— 这正是要修的根因',
  );

  // 修复：调度层对 changedCandidates 显式失效，再走定向预热。
  for (const candidate of Array.from(changes.changedCandidates)) {
    timelineCacheModule.clearSessionTimelineCache(candidate.sessionId);
  }
  const targetedRound = preload.preloadConversationTimelines([
    advancedStale,
    ...freshCandidates,
  ]);
  await flushAsyncWork();
  env.pendingInteractions.splice(0).forEach((callback) => callback());
  await targetedRound;

  assert.deepEqual(
    Array.from(env.calls, (call) => call.sessionId),
    ['session_ai_stale'],
    '只有被判定过期的会话重新读 DB（B/C/D 仍 fresh，不得重读）',
  );
  assert.ok(
    env.calls.every((call) => call.priority === 'maintenance'),
    '定向刷新同样是维护优先级',
  );
  assert.ok(
    timelineCacheModule.getSessionTimelineCache('session_ai_stale'),
    '定向刷新后必须写回最新的 timeline cache',
  );
}

// ============================================================================
// E：新进榜（原第 30 名）带着历史旧缓存 → 不得被 cache hit 跳过刷新
// ============================================================================
{
  const TARGET = preloadCandidatesModule.CHAT_ENTRY_PRELOAD_TARGET;
  const T10 = '2026-09-18T10:00:00.000Z';
  const candidateOf = (id, lastActivityAt) => ({
    kind: 'direct',
    id,
    sessionId: `session_${id}`,
    isPinned: false,
    lastActivityAt,
    pinnedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const env = createPreloadEnv();
  const preload = createPreloadHarness();

  const tracked = [candidateOf('ai_tracked_a', T10), candidateOf('ai_tracked_b', T10)];
  const zCandidate = candidateOf('ai_z', '2026-09-18T23:00:00.000Z');
  // 三个会话都已有缓存：tracked 仍 fresh，Z 是「曾打开过、后来掉出榜单又回来」的历史缓存。
  for (const candidate of [zCandidate, ...tracked]) {
    timelineCacheModule.setSessionTimelineCache({
      sessionId: candidate.sessionId,
      messages: [{ id: 7 }],
      hasMore: false,
      nextCursor: 7,
      lastMessageId: 7,
    });
  }

  const changes = preloadCandidatesModule.resolveConversationPreloadFreshnessChanges({
    previous: preloadCandidatesModule.buildConversationPreloadFreshnessSnapshot(tracked, TARGET),
    candidates: [zCandidate, ...tracked],
  });

  assert.deepEqual(
    Array.from(changes.changedCandidates, (candidate) => candidate.id),
    ['ai_z'],
    '新进榜会话的 freshness 无法证明 fresh，必须进入定向刷新集合',
  );

  for (const candidate of Array.from(changes.changedCandidates)) {
    timelineCacheModule.clearSessionTimelineCache(candidate.sessionId);
  }
  const round = preload.preloadConversationTimelines([zCandidate, ...tracked]);
  await flushAsyncWork();
  env.pendingInteractions.splice(0).forEach((callback) => callback());
  await round;

  assert.deepEqual(
    Array.from(env.calls, (call) => call.sessionId),
    ['session_ai_z'],
    'Z 必须至少完成一次有效刷新，历史缓存不得被当成 fresh；仍 fresh 的 tracked 不重读',
  );
}

// 真正挂载 Shell：列表点击不等待 DB，由目标路由准备；连点只保留一个会话页面。
{
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const require = createRequire(import.meta.url);
  function load(relativePath, dependencies = {}) {
    const module = { exports: {} };
    const output = ts.transpileModule(read(relativePath), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', output)((id) => {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id === 'react' || id === 'react/jsx-runtime') return require(id);
      throw new Error(`${relativePath} 未提供环境依赖 ${id}`);
    }, module, module.exports);
    return module.exports;
  }
  const ai = createAssistant('ai_navigation');
  let finishRead;
  const pendingRead = new Promise((resolve) => { finishRead = resolve; });
  let readCount = 0;
  let viewedCount = 0;
  const entry = load('src/features/chat/presentation/shell/useChatConversationEntry.ts', {
    '@shared/ui': { showAppDialog() {} },
    '@features/assistants': { getAssistantDisplayName: (assistant) => assistant.nickname ?? assistant.name },
  });
  const navigation = load('src/features/chat/presentation/shell/useChatNavigation.ts', { 'react-native': { Keyboard: { dismiss() {} } } });
  const screen = load('src/features/chat/presentation/shell/useChatScreen.ts', {
    '@features/assistants': { subscribeAIAssistantUpdated: () => () => {} },
    './useAIAssistants': { __esModule: true, default: () => ({ aiList: [ai], aiListReady: false, loadAIAssistants: async () => [ai], removeAIAssistant: async () => {} }) },
    './useChatConversationEntry': entry,
    './useChatNavigation': navigation,
    './useChatEntryPreload': { useChatEntryPreload: () => ({ resolveConversation: async () => { throw new Error('不应重复解析已准备的会话'); }, preloadConversationTimelines: async () => {}, refreshCurrentSession: async () => {} }) },
    '@shared/runtime/ConversationListReadySignal': {},
  });
  const preparation = load('src/features/chat/presentation/shell/ConversationPreparationController.ts');
  const router = load('src/features/chat/presentation/shell/ChatRouterContext.tsx', {
    './ChatTextDraftProvider': { ChatTextDraftProvider: ({ children }) => children },
    './useChatScreen': screen,
    './ConversationPreparationController': preparation,
    './conversationPreloadCandidates': preloadCandidatesModule,
    '../messages/components/sessionTimelineCache': timelineCacheModule,
    './arrivedConversationPreview': {},
    '../../group/application': {},
    '../../conversation/application/ConversationPin': {},
    '../../conversation/application/ChatPresentation': { getCanonicalChatConversation: () => { readCount++; return pendingRead; } },
    '../../reply/delivery/AssistantMessageArrival': {},
    '../../messages/events/ChatEvents': {},
    '@shared/runtime/ConversationListReadySignal': {},
    '@features/profile': { DEFAULT_USER_PROFILE: {}, subscribeUserProfileUpdated: () => () => {} },
  });
  const Stack = ({ children }) => React.createElement('Stack', {}, children);
  Stack.Screen = 'Screen';
  const layout = load('src/app/_layout.tsx', {
    'expo-router': { Stack },
    'react-native-gesture-handler': { GestureHandlerRootView: 'Root' },
    '@host/KimiPhoneHost': { __esModule: true, default: ({ children }) => children },
    '@host/navigation/StickerProgressNavigationBoundary': { __esModule: true, default: ({ children }) => children },
  });
  let layoutRenderer;
  let providerRenderer;
  let chat;
  function Consumer() { chat = router.useChatRouter(); return null; }
  try {
    await act(async () => { layoutRenderer = create(React.createElement(layout.default)); });
    const routes = ['(tabs)', 'chat/[aiId]/index', 'chat/groups/[groupId]'];
    const routeGetIdList = {};
    for (const name of routes.slice(1)) {
      const route = layoutRenderer.root.findAllByType('Screen').find((item) => item.props.name === name);
      assert.ok(route, '聊天应由根原生 Stack 承载');
      assert.equal(route.props.dangerouslySingular, true, '按动态会话身份保持页面唯一');
      const parameter = name.includes('groups') ? 'groupId' : 'aiId';
      routeGetIdList[name] = ({ params }) => params[parameter];
    }
    const stack = StackRouter({ initialRouteName: '(tabs)' });
    const options = { routeNames: routes, routeParamList: {}, routeGetIdList };
    let stackState = stack.getInitialState(options);
    const navigate = (name, params) => { stackState = stack.getStateForAction(stackState, CommonActions.navigate(name, params), options); };
    await act(async () => {
      providerRenderer = create(React.createElement(router.ChatRouterProvider, {
        onOpenConversation: (aiId) => navigate(routes[1], { aiId }),
        onOpenGroup: (groupId) => navigate(routes[2], { groupId }),
        onConversationViewed: () => { viewedCount++; },
      }, React.createElement(Consumer)));
    });
    await act(async () => { for (let count = 0; count < 5; count++) chat.openConversation(ai); });
    assert.equal(readCount, 0, '点击列表无需先等待会话读取');
    assert.equal(stackState.routes.length, 2, '连续点击只打开一个聊天页面');
    let firstPreparation;
    await act(async () => {
      firstPreparation = chat.ensureConversation(ai.id);
      assert.equal(chat.ensureConversation(ai.id), firstPreparation, '目标路由合并同一会话的在途准备');
    });
    assert.equal(readCount, 1);
    await act(async () => {
      finishRead(createSession(ai.canonicalConversationId, ai.id));
      assert.equal(await firstPreparation, 'ready');
    });
    assert.equal(chat.state.currentSession.id, ai.canonicalConversationId);
    assert.equal(viewedCount, 1, '路由完成一次会话进入');
    await act(async () => {
      chat.openConversation(createAssistant('another'));
      for (let count = 0; count < 5; count++) chat.openGroup({ id: 'group_navigation' });
    });
    assert.equal(stackState.routes.length, 4, '不同会话各有身份，群聊连点同样不重复');
    await act(async () => { chat.openConversation(ai); });
    assert.equal(stackState.routes.length, 4, '再次打开已有会话复用页面');
    assert.equal(stackState.routes.at(-1).params.aiId, ai.id);
  } finally {
    await act(async () => { providerRenderer?.unmount(); layoutRenderer?.unmount(); });
  }
}

console.log('verify-chat-conversation-entry-and-preload: all assertions passed');
