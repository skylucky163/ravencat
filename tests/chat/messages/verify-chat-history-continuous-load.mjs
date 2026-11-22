import { repoRoot as projectRoot } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';


function loadModule(relativePath, requireModule = () => ({})) {
  const sourcePath = path.join(projectRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: requireModule,
    console,
    Map,
    Set,
    Array,
    Object,
    String,
    Boolean,
    Number,
    Math,
    JSON,
    Error,
    setInterval,
    clearInterval,
  });
  return module.exports;
}

const pagination = loadModule(
  'src/features/chat/presentation/messages/components/chatHistoryPagination.ts',
);
const initialWindow = loadModule(
  'src/features/chat/presentation/messages/components/chatBottomAnchorExperiment.ts',
);
const timelineCache = loadModule(
  'src/features/chat/presentation/messages/components/sessionTimelineCache.ts',
  (specifier) => {
    if (specifier === './chatBottomAnchorExperiment') {
      return initialWindow;
    }
    throw new Error(`未预期的运行时依赖：${specifier}`);
  },
);

const VIEWPORT_HEIGHT = 800;

function scrollInput(overrides = {}) {
  return {
    contentOffsetY: 200,
    previousContentOffsetY: 400,
    viewportHeight: VIEWPORT_HEIGHT,
    hasMore: true,
    isPageInFlight: false,
    isUserScrollActive: true,
    ...overrides,
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * 用同一份纯状态机复刻组件里的分页执行器，用来验证真实语义而不是影子实现。
 *
 * 与 ChatMessageList.requestOlderPage 的结构一致：捕获 request token；
 * finish 返回 null（generation 已经前进）时完全 no-op。
 */
function createPaginationHarness(params) {
  let gate = pagination.IDLE_HISTORY_PAGINATION_GATE;
  let requestCount = 0;
  const requestedReasons = [];

  const requestOlderPage = async (reason) => {
    const started = pagination.beginHistoryPageRequest(gate, {
      hasMore: params.hasMore(),
    });

    if (!started) {
      return false;
    }

    gate = started.gate;
    requestCount += 1;
    requestedReasons.push(reason);

    try {
      await params.loadPage(reason);
      return true;
    } finally {
      const finished = pagination.finishHistoryPageRequest(gate, started.request, {
        hasMore: params.hasMore(),
      });

      if (finished) {
        gate = finished.gate;

        if (finished.shouldRequestQueued) {
          await requestOlderPage('queued-scroll');
        }
      }
    }
  };

  const onScroll = (input) => {
    const decision = pagination.resolveScrollDemandDecision(input);

    if (decision === 'request') {
      void requestOlderPage('scroll');
      return decision;
    }

    gate = pagination.applyScrollDemandToGate(gate, decision);
    return decision;
  };

  return {
    requestOlderPage,
    onScroll,
    /** session 切换：推进 generation 并建立新 generation 的 idle gate。 */
    switchSession: () => {
      gate = pagination.beginHistoryPaginationGeneration(gate);
      return gate;
    },
    getRequestCount: () => requestCount,
    getRequestedReasons: () => [...requestedReasons],
    getGate: () => gate,
  };
}

/**
 * 复刻 useMessageHistoryState.loadMore / refresh 的接线。
 *
 * 真正的判定（入口 guard、stale 判定、finish 释放所有权、下一轮 hasMore）
 * 全部来自 chatHistoryPagination 的纯函数，这里只负责把它们串到一个可变 state 上，
 * 以便在没有 React 渲染器的环境下验证跨 session 行为。
 */
function createLoadMoreHarness(params = {}) {
  const state = {
    sessionId: params.sessionId ?? 'session-a',
    ownership: pagination.IDLE_HISTORY_LOAD_OWNERSHIP,
    cursor: params.cursor === undefined ? 100 : params.cursor,
    hasMore: params.hasMore ?? true,
    messageCount: params.messageCount ?? 30,
    error: null,
    isLoadingMore: false,
    prependCalls: [],
    loadedSessions: [],
  };

  const snapshot = () => ({
    sessionId: state.sessionId,
    cursor: state.cursor,
    hasMore: state.hasMore,
    error: state.error,
    isLoadingMore: state.isLoadingMore,
    messageCount: state.messageCount,
    generation: state.ownership.generation,
    activeRequestId: state.ownership.active?.requestId ?? null,
  });

  const switchSession = (sessionId, next = {}) => {
    state.ownership = pagination.beginHistorySession(state.ownership);
    state.isLoadingMore = false;
    state.sessionId = sessionId;
    state.cursor = next.cursor === undefined ? 100 : next.cursor;
    state.hasMore = next.hasMore ?? true;
    state.messageCount = next.messageCount ?? 30;
    state.error = null;
  };

  const loadMore = async () => {
    const started = pagination.beginHistoryLoadRequest(state.ownership, {
      sessionId: state.sessionId,
      hasMore: state.hasMore,
      cursor: state.cursor,
    });

    if (!started) {
      return false;
    }

    state.ownership = started.ownership;
    const owner = started.owner;
    state.loadedSessions.push(owner.sessionId);
    state.isLoadingMore = true;

    try {
      const result = await params.loadOlder({ sessionId: owner.sessionId, cursor: started.cursor });

      if (!pagination.isHistoryLoadRequestCurrent(state.ownership, owner)) {
        return false;
      }

      if (result.success) {
        const received = Array.isArray(result.messages) && result.messages.length > 0;
        const didCursorAdvance =
          result.nextCursor !== null && result.nextCursor !== undefined && result.nextCursor !== started.cursor;

        if (received) {
          state.messageCount += result.messages.length;
          state.prependCalls.push({ sessionId: state.sessionId, received: result.messages.length });
        }

        state.hasMore = pagination.resolveNextHistoryHasMore({
          hasMore: result.hasMore,
          didCursorAdvance,
        });
        state.cursor = didCursorAdvance ? result.nextCursor : null;

        return received;
      }

      state.error = result.error || '加载更多失败';
      return false;
    } finally {
      const released = pagination.finishHistoryLoadRequest(state.ownership, owner);

      if (released !== state.ownership) {
        state.ownership = released;
        state.isLoadingMore = false;
      }
    }
  };

  const refresh = async () => {
    const requestGeneration = state.ownership.generation;
    state.isLoadingMore = true;

    try {
      const result = await params.open({ sessionId: state.sessionId });

      if (requestGeneration !== state.ownership.generation) {
        return false;
      }

      if (result.success) {
        state.messageCount = result.messages.length;
        state.hasMore = result.hasMore;
        state.cursor = result.nextCursor;
      } else {
        state.error = result.error || '刷新失败';
      }

      return true;
    } finally {
      if (requestGeneration === state.ownership.generation) {
        state.isLoadingMore = false;
      }
    }
  };

  return { state, snapshot, switchSession, loadMore, refresh };
}

const flush = () => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

// --- 1. 同一 cursor 不会并发请求两次 ---------------------------------------

{
  const harness = createPaginationHarness({
    hasMore: () => true,
    loadPage: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    },
  });

  await Promise.all([
    harness.requestOlderPage('scroll'),
    harness.requestOlderPage('scroll'),
    harness.requestOlderPage('anchor'),
  ]);

  assert.equal(harness.getRequestCount(), 1, '同一时刻只允许一页在飞');
  await flush();
  assert.equal(harness.getGate().inFlight, false, '请求结束后必须释放 in-flight');
}

// --- 2. 一次 scroll demand 触发一页 ----------------------------------------

{
  const harness = createPaginationHarness({
    hasMore: () => true,
    loadPage: async () => {},
  });

  assert.equal(harness.onScroll(scrollInput()), 'request');
  await flush();
  assert.equal(harness.getRequestCount(), 1, '一次顶部滚动 demand 只触发一页');
  assert.deepEqual(harness.getRequestedReasons(), ['scroll']);
}

// --- 3. 加载过程中多次滚动最多只积累一个 queued demand ---------------------

{
  const harness = createPaginationHarness({
    hasMore: () => true,
    loadPage: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    },
  });

  void harness.requestOlderPage('scroll');
  await flush();

  for (let index = 0; index < 5; index += 1) {
    const decision = harness.onScroll(scrollInput({ isPageInFlight: true }));
    assert.equal(decision, 'queue', '在飞期间的顶部上滑只排队');
  }

  assert.equal(harness.getGate().demand.scrollQueued, true, '排队 token 必须是布尔量');
  assert.equal(harness.getRequestCount(), 1, '排队期间不得再发请求');

  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });

  assert.equal(
    harness.getRequestCount(),
    2,
    '第一页完成后只消费一个排队 token，再补一页就停',
  );
  assert.deepEqual(harness.getRequestedReasons(), ['scroll', 'queued-scroll']);
}

// --- 4. 当前页完成后可以消费一个 queued demand -----------------------------

{
  const gate = { generation: 3, inFlight: true, demand: { scrollQueued: true } };
  const completed = pagination.finishHistoryPageRequest(gate, { generation: 3 }, { hasMore: true });

  assert.ok(completed, '同一 generation 的 finish 必须生效');
  assert.equal(completed.gate.inFlight, false);
  assert.equal(completed.gate.generation, 3, 'finish 不得改动 generation');
  assert.equal(completed.gate.demand.scrollQueued, false, 'token 必须被清空');
  assert.equal(completed.shouldRequestQueued, true, '应消费一个已存在的排队 token');
}

// --- 5. 没有新的用户滚动 demand 时，数据落地本身不会继续请求下一页 --------

{
  // prepend 落地、renderedData 变化、isLoadingMore 回落都不产生 demand：
  // 只有非用户滚动的输入一律 ignore。
  assert.equal(
    pagination.resolveScrollDemandDecision(scrollInput({ isUserScrollActive: false })),
    'ignore',
    '程序化滚动不产生 demand',
  );
  assert.equal(
    pagination.resolveScrollDemandDecision(
      scrollInput({ contentOffsetY: 900, previousContentOffsetY: 100 }),
    ),
    'ignore',
    'prepend 把 y 推大不是向历史方向移动',
  );

  const idle = pagination.finishHistoryPageRequest(
    { generation: 0, inFlight: true, demand: pagination.IDLE_HISTORY_PAGINATION_DEMAND },
    { generation: 0 },
    { hasMore: true },
  );
  assert.equal(idle.shouldRequestQueued, false, '没有排队 token 时不得自行续页');

  const harness = createPaginationHarness({
    hasMore: () => true,
    loadPage: async () => {},
  });

  await harness.requestOlderPage('scroll');
  await flush();
  await flush();

  assert.equal(harness.getRequestCount(), 1, '数据落地不得自行触发下一页');
}

// --- 6. hasMore=false 后不会再请求 -----------------------------------------

{
  assert.equal(
    pagination.resolveScrollDemandDecision(scrollInput({ hasMore: false })),
    'ignore',
    'hasMore 为 false 时滚动不再产生 demand',
  );

  const exhausted = pagination.finishHistoryPageRequest(
    { generation: 1, inFlight: true, demand: { scrollQueued: true } },
    { generation: 1 },
    { hasMore: false },
  );
  assert.equal(exhausted.shouldRequestQueued, false);
  assert.equal(exhausted.gate.demand.scrollQueued, false, 'hasMore 耗尽必须丢弃 token');

  let hasMore = true;
  const harness = createPaginationHarness({
    hasMore: () => hasMore,
    loadPage: async () => {},
  });
  hasMore = false;

  assert.equal(await harness.requestOlderPage('scroll'), false);
  assert.equal(harness.getRequestCount(), 0, '没有更多历史时不得再读库');
}

// --- 7. anchor 与 scroll 共用 inFlight，不会并发 ---------------------------

{
  const harness = createPaginationHarness({
    hasMore: () => true,
    loadPage: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 15);
      });
    },
  });

  void harness.requestOlderPage('anchor');
  await flush();

  assert.equal(
    harness.onScroll(scrollInput({ isPageInFlight: true })),
    'queue',
    'anchor 定位在飞时滚动只能排队',
  );
  assert.equal(await harness.requestOlderPage('scroll'), false, 'anchor 在飞时不得再起第二个请求');
  assert.equal(harness.getRequestCount(), 1, 'anchor 与 scroll 共用同一个 in-flight');

  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });

  assert.deepEqual(
    harness.getRequestedReasons(),
    ['anchor', 'queued-scroll'],
    'anchor 完成后消费排队的滚动 demand',
  );
}

// --- 8. cache window 不小于 initial window --------------------------------

{
  assert.ok(
    timelineCache.SESSION_TIMELINE_CACHE_WINDOW >= initialWindow.CHAT_INITIAL_MESSAGE_WINDOW_SIZE,
    `缓存窗口 ${timelineCache.SESSION_TIMELINE_CACHE_WINDOW} 不得小于首屏窗口 ${initialWindow.CHAT_INITIAL_MESSAGE_WINDOW_SIZE}`,
  );
}

// --- 9. 短会话进入时不会产生伪 hasMore -------------------------------------

function createMessages(count) {
  return Array.from({ length: count }, (_item, index) => ({
    id: index + 1,
    sessionId: 's',
    text: `m${index + 1}`,
    isMe: false,
    isRead: true,
    senderType: 'assistant',
    time: '12:00',
    createdAt: '2026-09-18T12:00:00.000Z',
    showTimeSeparatorBefore: false,
    status: 'sent',
    metadataJson: null,
  }));
}

{
  const shortEntry = timelineCache.setSessionTimelineCache({
    sessionId: 'short',
    messages: createMessages(25),
    hasMore: false,
    nextCursor: null,
    lastMessageId: 25,
  });

  assert.equal(shortEntry.messages.length, 25, '未超过窗口时不得裁剪');
  assert.equal(shortEntry.hasMore, false, '未发生裁剪时不得把 hasMore 抬成 true');
  assert.equal(shortEntry.nextCursor, 1);

  const longEntry = timelineCache.setSessionTimelineCache({
    sessionId: 'long',
    messages: createMessages(80),
    hasMore: false,
    nextCursor: null,
    lastMessageId: 80,
  });

  assert.equal(longEntry.messages.length, timelineCache.SESSION_TIMELINE_CACHE_WINDOW);
  assert.equal(longEntry.hasMore, true, '发生裁剪时相对缓存窗口确实还有更早内容');
  assert.equal(
    longEntry.nextCursor,
    80 - timelineCache.SESSION_TIMELINE_CACHE_WINDOW + 1,
    '裁剪后的 cursor 必须指向窗口内最早一条',
  );
  assert.equal(longEntry.lastMessageId, 80);

  const reread = timelineCache.getSessionTimelineCache('short');
  assert.equal(reread.hasMore, false, '重新读取缓存不得把 hasMore 抬成 true');
  assert.equal(reread.messages.length, 25);
}

// --- 10. 清除聊天记录后不会反复空请求 --------------------------------------

{
  // 清除后会话没有可见消息，hasMore 必须落到 false，水位内的滚动也不得再请求。
  assert.equal(
    pagination.resolveScrollDemandDecision(
      scrollInput({ contentOffsetY: 0, previousContentOffsetY: 30, hasMore: false }),
    ),
    'ignore',
    '清除记录后即使停在顶部区也不得再产生 demand',
  );

  const cleared = createPaginationHarness({
    hasMore: () => false,
    loadPage: async () => {},
  });

  for (let index = 0; index < 3; index += 1) {
    assert.equal(
      cleared.onScroll(scrollInput({ contentOffsetY: 0, previousContentOffsetY: 30, hasMore: false })),
      'ignore',
    );
  }

  assert.equal(cleared.getRequestCount(), 0, '清除记录后不得反复空请求');
}

// --- 11. 水位与 bootstrap 边界 ---------------------------------------------

{
  const prefetchDistance = pagination.resolveHistoryPrefetchDistance(VIEWPORT_HEIGHT);

  assert.equal(
    pagination.resolveScrollDemandDecision(
      scrollInput({ contentOffsetY: prefetchDistance, previousContentOffsetY: prefetchDistance + 200 }),
    ),
    'request',
    '恰好落在水位边界上仍应提前分页',
  );
  assert.equal(
    pagination.resolveScrollDemandDecision(
      scrollInput({ contentOffsetY: prefetchDistance + 100, previousContentOffsetY: prefetchDistance + 200 }),
    ),
    'ignore',
    '水位之外即使向上滑也不请求',
  );
  assert.equal(
    pagination.resolveScrollDemandDecision(
      scrollInput({ contentOffsetY: 300, previousContentOffsetY: null }),
    ),
    'ignore',
    '缺少原生手势起点时不猜测滚动方向',
  );

  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 600,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: true,
      isPageInFlight: false,
    }),
    true,
    '内容不足一屏应触发 bootstrap 补页',
  );
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 2000,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: true,
      isPageInFlight: false,
    }),
    false,
    '内容足够滚动后必须交回滚动 demand 模型',
  );
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 600,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: false,
      isPageInFlight: false,
    }),
    false,
  );
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 600,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: true,
      isPageInFlight: true,
    }),
    false,
    'bootstrap 也必须遵守 in-flight 互斥',
  );
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 600,
      viewportHeight: 0,
      hasMore: true,
      isPageInFlight: false,
    }),
    false,
    'viewport 未知时不得 bootstrap',
  );
}

// --- A. bootstrap：内容高度尚未测量时绝不补页 ------------------------------

{
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: null,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: true,
      isPageInFlight: false,
    }),
    false,
    'contentHeight=null（尚未测量）不得被当成高度 0 而 bootstrap',
  );
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: null,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: false,
      isPageInFlight: false,
    }),
    false,
  );
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: null,
      viewportHeight: 0,
      hasMore: true,
      isPageInFlight: false,
    }),
    false,
  );
}

// --- B. bootstrap：已经测量且确实不足 1.2 屏才补页 -------------------------

{
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 600,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: true,
      isPageInFlight: false,
    }),
    true,
    'contentHeight=600 / viewport=800 才允许 bootstrap',
  );
  // 恰好落在 1.2 屏边界上（800 * 1.2 = 960）仍视为不足。
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 960,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: true,
      isPageInFlight: false,
    }),
    true,
  );
  assert.equal(
    pagination.shouldRequestBootstrapPage({
      contentHeight: 961,
      viewportHeight: VIEWPORT_HEIGHT,
      hasMore: true,
      isPageInFlight: false,
    }),
    false,
  );
}

// --- C. stale presentation generation 不污染新 gate ------------------------

{
  const firstPage = createDeferred();
  const secondPage = createDeferred();
  const queue = [firstPage, secondPage];
  const harness = createPaginationHarness({
    hasMore: () => true,
    loadPage: () => queue.shift().promise,
  });

  void harness.requestOlderPage('scroll');
  await flush();
  assert.equal(harness.getGate().inFlight, true, 'generation 1 的请求在飞');
  const generationOne = harness.getGate().generation;

  const switchedGate = harness.switchSession();
  assert.equal(switchedGate.generation, generationOne + 1, '切 session 必须推进 generation');
  assert.equal(switchedGate.inFlight, false, '新 generation 必须是 idle gate');
  const generationTwo = switchedGate.generation;

  void harness.requestOlderPage('scroll');
  await flush();
  assert.equal(harness.getGate().generation, generationTwo);
  assert.equal(harness.getGate().inFlight, true, 'generation 2 的请求在飞');

  // A（generation 1）此刻完成：它的 finish 拿的是已经过期的 token。
  firstPage.resolve();
  await flush();
  await flush();

  const gateAfterStaleFinish = harness.getGate();
  assert.equal(
    gateAfterStaleFinish.generation,
    generationTwo,
    'stale finish 不得改动 generation',
  );
  assert.equal(
    gateAfterStaleFinish.inFlight,
    true,
    'A 的旧 finally 不得把 B 的 inFlight 清成 false',
  );
  assert.equal(
    gateAfterStaleFinish.demand.scrollQueued,
    false,
    'stale finish 不得制造 token',
  );
  assert.deepEqual(
    harness.getRequestedReasons(),
    ['scroll', 'scroll'],
    'stale finish 不得触发 queued-scroll',
  );

  secondPage.resolve();
  await flush();
  await flush();
  assert.equal(harness.getGate().inFlight, false, 'B 自己的 finish 必须正常释放');
  assert.deepEqual(harness.getRequestedReasons(), ['scroll', 'scroll']);
}

// --- D. stale finish 不得消费新 generation 的排队 token --------------------

{
  const firstPage = createDeferred();
  const secondPage = createDeferred();
  const thirdPage = createDeferred();
  const queue = [firstPage, secondPage, thirdPage];
  const harness = createPaginationHarness({
    hasMore: () => true,
    loadPage: () => queue.shift().promise,
  });

  void harness.requestOlderPage('scroll');
  await flush();

  harness.switchSession();
  const generationTwo = harness.getGate().generation;

  void harness.requestOlderPage('scroll');
  await flush();
  assert.equal(harness.getGate().inFlight, true, 'generation 2 的请求在飞');

  // B 在加载期间继续向上滑：留下一个排队 token。
  assert.equal(
    harness.onScroll(scrollInput({ isPageInFlight: true })),
    'queue',
    'generation 2 在飞期间的滚动应排队',
  );
  assert.equal(harness.getGate().demand.scrollQueued, true);
  assert.equal(harness.getGate().generation, generationTwo, '排队不得改动 generation');

  // A（generation 1）完成：不得消费 B 的 token。
  firstPage.resolve();
  await flush();
  await flush();

  assert.equal(
    harness.getGate().demand.scrollQueued,
    true,
    'stale finish 之后 B 的排队 token 必须保持原值',
  );
  assert.equal(harness.getRequestCount(), 2, 'stale finish 不得触发第三次请求');

  // B 自己完成时才消费 token。
  secondPage.resolve();
  await flush();
  await flush();

  assert.equal(harness.getGate().demand.scrollQueued, false, 'B 自己的 finish 才消费 token');
  assert.equal(harness.getRequestCount(), 3, 'B 完成后消费一个 token');
  assert.deepEqual(harness.getRequestedReasons(), ['scroll', 'scroll', 'queued-scroll']);

  thirdPage.resolve();
  await flush();
}

// --- E. 最后一页：同步 hasMore 立刻为 false，排队空转不再读库 --------------

{
  assert.equal(
    pagination.resolveNextHistoryHasMore({ hasMore: false, didCursorAdvance: true }),
    false,
    '仓储说没有更早消息时 hasMore 必须同步为 false',
  );
  assert.equal(
    pagination.resolveNextHistoryHasMore({ hasMore: true, didCursorAdvance: false }),
    false,
    '游标没有前进时不得继续分页',
  );
  assert.equal(
    pagination.resolveNextHistoryHasMore({ hasMore: true, didCursorAdvance: true }),
    true,
  );

  // application 已经知道没有更多历史之后，即使 presentation 侧还排队一个空转，
  // 入口 guard 也必须同步挡住，而不是依赖 cursor 恰好为 null。
  const lastPage = createDeferred();
  let loadCount = 0;
  const harness = createLoadMoreHarness({
    cursor: 120,
    loadOlder: async () => {
      loadCount += 1;
      await lastPage.promise;
      // 与 SQLiteMessageRepository 一致：没有更早消息时 nextCursor 为 null。
      return { success: true, messages: [{ id: 1 }], hasMore: false, nextCursor: null };
    },
  });

  const pending = harness.loadMore();
  lastPage.resolve();
  await pending;
  await flush();

  assert.equal(harness.state.hasMore, false, '最后一页返回后 hasMore ref 必须立刻为 false');
  assert.equal(harness.state.cursor, null, '游标没有前进时必须落 null');
  assert.deepEqual(harness.state.prependCalls, [{ sessionId: 'session-a', received: 1 }]);

  // 后续（排队的）空转：即使 cursor 被伪造回非空，也必须被 hasMore guard 挡住。
  harness.state.cursor = 99;
  assert.equal(await harness.loadMore(), false, '已知没有更多历史后不得再读库');
  assert.equal(loadCount, 1, '空转不得再触发一次读库');
}

// --- F/G. 跨 session loadMore：stale 结果不得污染 B -------------------------

{
  const firstPage = createDeferred();
  const harness = createLoadMoreHarness({
    loadOlder: async ({ sessionId }) => {
      if (sessionId === 'session-a') {
        await firstPage.promise;
        return { success: true, messages: [{ id: 1 }, { id: 2 }], hasMore: true, nextCursor: 90 };
      }
      return { success: true, messages: [{ id: 500 }], hasMore: true, nextCursor: 400 };
    },
  });

  const pendingA = harness.loadMore();
  await flush();

  harness.switchSession('session-b', { cursor: 500, messageCount: 30 });
  const bSnapshot = harness.snapshot();

  firstPage.resolve();
  assert.equal(await pendingA, false, 'stale 请求必须返回 false');
  await flush();

  assert.deepEqual(harness.state.prependCalls, [], 'A 的旧消息不得 prepend 到 B');
  assert.deepEqual(harness.snapshot(), bSnapshot, 'stale A 不得修改 B 的任何 state');

  // G：逐项确认 cursor / hasMore / error / loading 都没有被 stale A 污染。
  assert.equal(harness.state.cursor, 500, 'cursor 不得被 stale A 改写');
  assert.equal(harness.state.hasMore, true, 'hasMore 不得被 stale A 改写');
  assert.equal(harness.state.error, null, 'error 不得被 stale A 写入');
  assert.equal(harness.state.messageCount, 30, 'messages 不得被 stale A 改写');
}

// --- H. stale finally 不得释放新请求的锁 -----------------------------------

{
  const pageA = createDeferred();
  const pageB = createDeferred();
  const harness = createLoadMoreHarness({
    loadOlder: async ({ sessionId }) => {
      if (sessionId === 'session-a') {
        return pageA.promise;
      }
      return pageB.promise;
    },
  });

  const pendingA = harness.loadMore();
  await flush();
  assert.equal(harness.state.isLoadingMore, true);
  const activeA = harness.snapshot().activeRequestId;

  harness.switchSession('session-b');
  assert.equal(harness.state.isLoadingMore, false, '切 session 必须清掉旧 loading 状态');
  assert.equal(harness.state.ownership.active, null, '切 session 必须丢弃旧 owner');

  // I：B 可以立刻发起属于自己的请求，不被 A 的旧锁阻塞。
  const pendingB = harness.loadMore();
  await flush();
  const activeB = harness.snapshot().activeRequestId;
  assert.equal(harness.state.isLoadingMore, true, 'B 应当能立刻进入在飞状态');
  assert.notEqual(activeB, activeA, 'B 必须持有自己的 requestId');

  // A 的 finally 到达：不得释放 B 的锁。
  pageA.resolve({ success: true, messages: [{ id: 1 }], hasMore: true, nextCursor: 90 });
  assert.equal(await pendingA, false);
  await flush();

  assert.equal(harness.state.isLoadingMore, true, 'A 的 finally 不得清掉 B 的 loading');
  assert.equal(
    harness.snapshot().activeRequestId,
    activeB,
    'A 的 finally 不得释放 B 的锁',
  );

  // B 仍然在飞：新的分页请求必须被挡住（证明 B 真的还没被解锁）。
  assert.equal(await harness.loadMore(), false, 'B 仍在飞时不得并发启动第二个分页');
  assert.deepEqual(harness.state.loadedSessions, ['session-a', 'session-b']);

  pageB.resolve({ success: true, messages: [{ id: 500 }], hasMore: true, nextCursor: 400 });
  await pendingB;
  await flush();

  assert.equal(harness.state.isLoadingMore, false, 'B 自己的 finally 必须正常释放');
  assert.equal(harness.state.ownership.active, null);
  assert.deepEqual(harness.state.prependCalls, [{ sessionId: 'session-b', received: 1 }]);
}

// --- J. refresh race：旧 session 的刷新结果不得覆盖新 session --------------

{
  const refreshA = createDeferred();
  const harness = createLoadMoreHarness({
    loadOlder: async () => ({ success: true, messages: [], hasMore: true, nextCursor: null }),
    open: async ({ sessionId }) => {
      if (sessionId === 'session-a') {
        return refreshA.promise;
      }
      return { success: true, messages: [{ id: 1 }, { id: 2 }, { id: 3 }], hasMore: true, nextCursor: 1 };
    },
  });

  const pendingRefresh = harness.refresh();
  await flush();

  harness.switchSession('session-b', { cursor: 300, hasMore: false, messageCount: 12 });
  const bSnapshot = harness.snapshot();

  refreshA.resolve({ success: true, messages: Array.from({ length: 60 }, (_item, index) => ({ id: index })), hasMore: true, nextCursor: 1 });
  assert.equal(await pendingRefresh, false, 'stale refresh 必须被丢弃');
  await flush();

  assert.deepEqual(harness.snapshot(), bSnapshot, '旧 session 的 refresh 结果不得覆盖新 session');
  assert.equal(harness.state.messageCount, 12, 'B 的消息数不得被 A 的 refresh 改写');
  assert.equal(harness.state.hasMore, false, 'B 的 hasMore 不得被 A 的 refresh 改写');
}

// 清除必须经过真实 hook 和时间线订阅，不能只在测试中预先把 hasMore 设为 false。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const events = loadModule('src/features/chat/messages/events/ChatEvents.ts');
const ordering = loadModule('src/features/chat/messages/domain/ChatTimelineOrdering.ts');
let repository;
const timeline = loadModule('src/features/chat/messages/application/MessageTimeline.ts', specifier => {
  if (specifier === '../events/ChatEvents') return events;
  if (specifier === '../domain/ChatTimelineOrdering') return ordering;
  if (specifier === './ChatMessageRuntime') return { getChatMessageRuntimeDependencies: () => ({ messages: repository }) };
  return {};
});
const historyHook = loadModule('src/features/chat/presentation/messages/components/useMessageHistoryState.ts', specifier => {
  if (specifier === 'react') return React;
  if (specifier === '../../../messages/application/MessageTimeline') return timeline;
  if (specifier === './sessionTimelineCache') return timelineCache;
  if (specifier === './chatBottomAnchorExperiment') return initialWindow;
  if (specifier === './chatHistoryPagination') return pagination;
  throw new Error(`未预期的历史依赖：${specifier}`);
});
const syncHook = loadModule('src/features/chat/presentation/messages/components/useChatTimelineSync.ts', specifier => {
  if (specifier === 'react') return React;
  if (specifier === '../../../messages/application/MessageTimeline') return timeline;
  if (specifier === '../../../messages/events/ChatEvents') return events;
  throw new Error(`未预期的订阅依赖：${specifier}`);
});
for (const pendingKind of ['older', 'refresh', 'initial']) {
  const sessionId = `clear-history-${pendingKind}`;
  const delayed = createDeferred();
  const delayedDelta = createDeferred();
  const oldMessages = [9144, 9150].map(id => ({ id, sessionId, text: '旧消息', createdAt: '2026-10-28T00:00:00Z' }));
  const oldPage = { success: true, messages: oldMessages, hasMore: true, nextCursor: 9144 };
  let initialReads = 0;
  let olderReads = 0;
  let current;
  repository = {
    getMessages: async (_sessionId, { cursor }) => {
      if (cursor !== null) { olderReads++; return delayed.promise; }
      initialReads++;
      return pendingKind === 'initial' || initialReads > 1 ? delayed.promise : oldPage;
    },
    getReloadWindowMessages: async (_sessionId, ids) => {
      assert.equal(ids.length, 0, '清除后的重读不能携带旧窗口身份');
      return [];
    },
    getNewerMessages: async () => delayedDelta.promise,
  };
  function Harness() {
    current = historyHook.useMessageHistoryState(sessionId);
    const [isTyping, setIsTyping] = React.useState(false);
    syncHook.useChatTimelineSync({ sessionId, ...current, isTyping, setIsTyping });
    return null;
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Harness)); });
  let pendingRead;
  await act(async () => {
    if (pendingKind === 'older') {
      pendingRead = current.loadMore();
      events.emitChatMessagesUpdated(sessionId);
    } else if (pendingKind === 'refresh') pendingRead = current.refresh();
  });
  await act(async () => { events.emitChatMessagesReloadRequested(sessionId, true); });
  assert.equal(current.messages.length, 0, '清除立即移除旧消息');
  assert.equal(current.hasMore, false, '清除立即撤销分页资格');
  assert.equal(current.isLoadingMore, false);
  assert.equal(current.lastMessageIdRef.current, null);
  assert.equal(await current.loadMore(), false, '清除后上滑不能再使用游标 9144');
  assert.equal(olderReads, pendingKind === 'older' ? 1 : 0, '清除后不发出额外分页请求');
  await act(async () => {
    delayed.resolve(oldPage);
    delayedDelta.resolve(oldMessages);
    await pendingRead;
  });
  assert.equal(current.messages.length, 0, '迟到的首屏、刷新、分页与增量结果都不能恢复旧消息');
  assert.equal(current.hasMore, false);
  assert.equal(current.error, null);
  assert.equal(timelineCache.getSessionTimelineCache(sessionId).messages.length, 0, '旧查询不能污染重进页面的缓存');
  await act(async () => { renderer.unmount(); });
}

console.log('Chat history continuous load verification passed.');
