/**
 * session 级 timeline cache 容量与 LRU 行为测试。
 *
 * 缓存只是性能优化，但必须有界：否则后台预热会把 session 数撑到无界，
 * 或者预热完一批就被下一批互相淘汰，预热等于白做。
 *
 * 覆盖：超容淘汰最久未使用、get/set 刷新使用顺序、单会话 clear、整体 clear，
 * 以及既有的「会话内窗口裁剪」契约没有被破坏。
 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';


const initialWindow = { CHAT_INITIAL_MESSAGE_WINDOW_SIZE: 20 };

const output = ts.transpileModule(
  fs.readFileSync(
    path.join(ROOT, 'src/features/chat/presentation/messages/components/sessionTimelineCache.ts'),
    'utf8',
  ),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const module = { exports: {} };
vm.runInNewContext(output, {
  module,
  exports: module.exports,
  require: (specifier) => {
    if (specifier === './chatBottomAnchorExperiment') {
      return initialWindow;
    }
    throw new Error(`未预期的运行时依赖：${specifier}`);
  },
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
});

const {
  SESSION_TIMELINE_CACHE_SESSION_CAPACITY: CAPACITY,
  SESSION_TIMELINE_CACHE_WINDOW: WINDOW,
  clearSessionTimelineCache,
  getSessionTimelineCache,
  getSessionTimelineCacheSize,
  setSessionTimelineCache,
} = module.exports;

function sessionId(index) {
  return `session_${String(index).padStart(2, '0')}`;
}

function write(index, extra = {}) {
  return setSessionTimelineCache({
    sessionId: sessionId(index),
    messages: [{ id: index }],
    hasMore: false,
    nextCursor: index,
    lastMessageId: index,
    ...extra,
  });
}

// ============================================================================
// 17：超过容量后淘汰最久未使用的 session
// ============================================================================
{
  clearSessionTimelineCache();
  const overflow = 3;
  for (let index = 0; index < CAPACITY + overflow; index += 1) {
    write(index);
  }

  assert.equal(
    getSessionTimelineCacheSize(),
    CAPACITY,
    '缓存 session 数必须被限制在容量内',
  );
  for (let index = 0; index < overflow; index += 1) {
    assert.equal(getSessionTimelineCache(sessionId(index)), null, `最久未使用的 ${sessionId(index)} 必须被淘汰`);
  }
  assert.ok(
    getSessionTimelineCache(sessionId(CAPACITY + overflow - 1)),
    '最新写入的 session 必须保留',
  );
}

// ============================================================================
// 18：get / set 命中刷新 LRU 使用顺序
// ============================================================================
{
  clearSessionTimelineCache();
  for (let index = 0; index < CAPACITY; index += 1) {
    write(index);
  }

  // 命中一次最旧的会话 → 它变成最近使用，淘汰对象变成下一个最旧的。
  assert.ok(getSessionTimelineCache(sessionId(0)), 'fixture：最早写入的会话仍在缓存');
  write(CAPACITY);

  assert.ok(
    getSessionTimelineCache(sessionId(0)),
    'get 命中必须刷新使用顺序，最旧的会话不得被淘汰',
  );
  assert.equal(
    getSessionTimelineCache(sessionId(1)),
    null,
    '淘汰对象必须变成真正最久未使用的会话',
  );
  assert.equal(getSessionTimelineCacheSize(), CAPACITY, '容量始终保持');

  // 重新写入也刷新使用顺序。
  clearSessionTimelineCache();
  for (let index = 0; index < CAPACITY; index += 1) {
    write(index);
  }
  write(0);
  write(CAPACITY);
  assert.ok(getSessionTimelineCache(sessionId(0)), 'set 命中必须刷新使用顺序');
  assert.equal(getSessionTimelineCache(sessionId(1)), null, '淘汰最久未使用');
}

// ============================================================================
// 19：clear 单个 session
// ============================================================================
{
  clearSessionTimelineCache();
  write(0);
  write(1);

  clearSessionTimelineCache(sessionId(0));

  assert.equal(getSessionTimelineCache(sessionId(0)), null, 'clear(sessionId) 必须移除该会话');
  assert.ok(getSessionTimelineCache(sessionId(1)), 'clear(sessionId) 不得影响其他会话');
}

// ============================================================================
// 20：clear 全部
// ============================================================================
{
  clearSessionTimelineCache();
  write(0);
  write(1);
  write(2);

  clearSessionTimelineCache();

  assert.equal(getSessionTimelineCacheSize(), 0, 'clear() 必须清空缓存');
  assert.equal(getSessionTimelineCache(sessionId(0)), null);
}

// ============================================================================
// 回归：会话内窗口裁剪契约保持不变
// ============================================================================
{
  clearSessionTimelineCache();
  const longMessages = Array.from({ length: WINDOW + 5 }, (_, index) => ({ id: index + 1 }));
  setSessionTimelineCache({
    sessionId: 'session_long',
    messages: longMessages,
    hasMore: false,
    nextCursor: 1,
    lastMessageId: WINDOW + 5,
  });

  const cached = getSessionTimelineCache('session_long');
  assert.equal(cached.messages.length, WINDOW, '会话内缓存窗口不得超过首屏窗口');
  assert.equal(cached.messages[0].id, 6, '裁剪保留最新的一段');
  assert.equal(cached.lastMessageId, WINDOW + 5, 'lastMessageId 必须是裁剪后的最新消息');
  assert.equal(cached.nextCursor, 6, 'nextCursor 必须指向裁剪后的最旧消息');
  assert.equal(cached.hasMore, true, '被裁掉更早的消息后必须标记 hasMore');
}

console.log('verify-session-timeline-cache-lru: all assertions passed');
