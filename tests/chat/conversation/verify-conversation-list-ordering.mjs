/**
 * 统一会话列表排序 + 预热候选排序的行为测试。
 *
 * 验证的是真实生效的纯函数模块：
 *   - src/shared/utils/conversationListOrdering.ts（唯一排序权威）
 *   - src/features/assistants/presentation/management/conversationListItems.ts（展示列表模型）
 *   - src/features/chat/presentation/shell/conversationPreloadCandidates.ts（预热候选）
 *
 * 关键不变量：预热候选顺序必须等于统一会话列表顺序在「可预热会话」上的投影，
 * 否则「用户最可能点的会话」和「最优先预热的会话」会分叉成两套顺序。
 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';


function loadModule(relativePath, requireModule = () => ({})) {
  const output = ts.transpileModule(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'), {
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
    Date,
    isNaN,
    parseInt,
  });
  return module.exports;
}

const ordering = loadModule('src/shared/utils/conversationListOrdering.ts');
const timelineCache = loadModule(
  'src/features/chat/presentation/messages/components/sessionTimelineCache.ts',
  (specifier) => {
    if (specifier === './chatBottomAnchorExperiment') {
      return { CHAT_INITIAL_MESSAGE_WINDOW_SIZE: 20 };
    }
    throw new Error(`未预期的运行时依赖：${specifier}`);
  },
);
const listItems = loadModule(
  'src/features/assistants/presentation/management/conversationListItems.ts',
  (specifier) => {
    if (specifier === '@shared/utils/conversationListOrdering') {
      return ordering;
    }
    throw new Error(`未预期的运行时依赖：${specifier}`);
  },
);
const preloadCandidates = loadModule(
  'src/features/chat/presentation/shell/conversationPreloadCandidates.ts',
  (specifier) => {
    if (specifier === '@shared/utils/conversationListOrdering') {
      return ordering;
    }
    throw new Error(`未预期的运行时依赖：${specifier}`);
  },
);

// ============================================================================
// fixture
// ============================================================================
function direct(id, { lastTime = null, createdAt = '2026-01-01T00:00:00.000Z', isPinned = false, pinnedAt = null, isBlocked = false, canonicalConversationId = `session_${id}` } = {}) {
  return {
    id,
    agentId: `agent_${id}`,
    name: id,
    avatar: null,
    lastMessage: lastTime ? 'msg' : '',
    lastTime,
    isPinned,
    pinnedAt,
    isBlocked,
    canonicalConversationId,
    createdAt,
    updatedAt: createdAt,
  };
}

function group(id, { lastTime = null, createdAt = '2026-01-01T00:00:00.000Z', isPinned = false, pinnedAt = null } = {}) {
  return {
    id,
    name: id,
    avatar: null,
    avatarMediaAssetId: null,
    lastMessage: lastTime ? 'msg' : null,
    lastTime,
    isPinned,
    pinnedAt,
    createdAt,
    updatedAt: createdAt,
  };
}

// 用宿主 realm 的 Array.from 收敛 vm realm 的数组，保证 deepStrictEqual 比较的是内容。
function idsOf(items) {
  return Array.from(items, (item) => item.id);
}

// ============================================================================
// 1-2：普通会话按最后可见消息时间排序；AI 与群聊混排不再按「类型」分组
// ============================================================================
{
  const oldDirect = direct('ai_old', { lastTime: '2026-09-01T10:00:00.000Z' });
  const newDirect = direct('ai_new', { lastTime: '2026-09-10T10:00:00.000Z' });

  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({ aiList: [oldDirect, newDirect], groupChats: [] })),
    ['ai_new', 'ai_old'],
    '普通 AI 之间：新的消息时间排前面',
  );

  // 群聊时间落在两个 AI 之间：必须按时间穿插，而不是「群聊整体在 AI 之前」。
  const middleGroup = group('g_mid', { lastTime: '2026-09-05T10:00:00.000Z' });
  const newestGroup = group('g_new', { lastTime: '2026-09-20T10:00:00.000Z' });

  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({
      aiList: [oldDirect, newDirect],
      groupChats: [middleGroup, newestGroup],
    })),
    ['g_new', 'ai_new', 'g_mid', 'ai_old'],
    'AI 与群聊统一混排，不再出现「所有群聊固定在所有 AI 上面」',
  );
}

// ============================================================================
// 3-5：置顶分区 + 分区内仍然按最近消息动态变化
// ============================================================================
{
  const pinnedOld = direct('pinned_old', { lastTime: '2026-08-01T10:00:00.000Z', isPinned: true });
  const pinnedNew = direct('pinned_new', { lastTime: '2026-09-09T10:00:00.000Z', isPinned: true });
  const freshUnpinned = direct('unpinned_fresh', { lastTime: '2026-09-30T10:00:00.000Z' });
  const pinnedGroup = group('pinned_group', { lastTime: '2026-09-15T10:00:00.000Z', isPinned: true });

  const before = listItems.buildConversationListItems({
    aiList: [pinnedOld, pinnedNew, freshUnpinned],
    groupChats: [pinnedGroup],
  });

  assert.deepEqual(
    idsOf(before),
    ['pinned_group', 'pinned_new', 'pinned_old', 'unpinned_fresh'],
    'pinned 永远在普通区之前；pinned 区内按最近消息排序；置顶不冻结位置',
  );

  // pinned 区内部靠新消息上浮（不依赖任何手动顺序字段）。
  pinnedOld.lastTime = '2026-09-29T10:00:00.000Z';
  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({
      aiList: [pinnedOld, pinnedNew, freshUnpinned],
      groupChats: [pinnedGroup],
    })),
    ['pinned_old', 'pinned_group', 'pinned_new', 'unpinned_fresh'],
    'pinned 区内部按 lastTime 动态变化',
  );

  // 全部 pinned：仍然正常按最近消息排序，不报错。
  const allPinned = listItems.buildConversationListItems({
    aiList: [
      direct('a', { lastTime: '2026-09-02T00:00:00.000Z', isPinned: true }),
      direct('b', { lastTime: '2026-09-04T00:00:00.000Z', isPinned: true }),
    ],
    groupChats: [group('c', { lastTime: '2026-09-03T00:00:00.000Z', isPinned: true })],
  });
  assert.deepEqual(idsOf(allPinned), ['b', 'c', 'a'], '全部置顶时仍按最近消息排序');
}

// ============================================================================
// 6：从未聊天 / 可见时间线为空 → 稳定回落到 createdAt，不抖动
// ============================================================================
{
  const never = direct('never', { lastTime: null, createdAt: '2026-09-01T00:00:00.000Z' });
  const cleared = direct('cleared', { lastTime: '', createdAt: '2026-09-05T00:00:00.000Z' });
  const talked = direct('talked', { lastTime: '2026-08-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' });
  const neverGroup = group('never_group', { lastTime: null, createdAt: '2026-09-03T00:00:00.000Z' });

  const first = listItems.buildConversationListItems({
    aiList: [never, talked, cleared],
    groupChats: [neverGroup],
  });
  assert.deepEqual(
    idsOf(first),
    ['cleared', 'never_group', 'never', 'talked'],
    '可见时间线为空时用 createdAt 回落（clear 过的会话不保留被隐藏消息的时间）',
  );

  for (let index = 0; index < 5; index += 1) {
    const again = listItems.buildConversationListItems({
      aiList: [talked, cleared, never],
      groupChats: [neverGroup],
    });
    assert.deepEqual(idsOf(again), idsOf(first), '输入顺序不同也不得改变结果（无抖动）');
  }

  // 完全同时间：用 id 做稳定 tie-break，且重复排序结果一致。
  const tieA = direct('tie_a', { lastTime: null, createdAt: '2026-09-07T00:00:00.000Z' });
  const tieB = direct('tie_b', { lastTime: null, createdAt: '2026-09-07T00:00:00.000Z' });
  const tieSorted = idsOf(listItems.buildConversationListItems({ aiList: [tieB, tieA] }));
  assert.deepEqual(tieSorted, idsOf(listItems.buildConversationListItems({ aiList: [tieA, tieB] })));
  assert.equal(tieSorted.length, 2, '同时间会话都保留');
}

// ============================================================================
// 排序函数本身：不修改入参
// ============================================================================
{
  const input = [
    { id: 'x', isPinned: false, lastActivityAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'y', isPinned: false, lastActivityAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const snapshot = idsOf(input);
  ordering.sortConversationOrdering(input);
  assert.deepEqual(idsOf(input), snapshot, '排序必须返回新数组，不得原地重排入参');
}

// ============================================================================
// 21-23：预热候选同时包含 AI 与群聊、顺序与统一列表一致、pinned 在排序前部
// ============================================================================
{
  const aiList = [
    direct('ai_recent', { lastTime: '2026-09-20T10:00:00.000Z', isPinned: true }),
    direct('ai_mid', { lastTime: '2026-09-10T10:00:00.000Z' }),
    direct('ai_blocked', { lastTime: '2026-09-25T10:00:00.000Z', isBlocked: true }),
    direct('ai_brand_new', { lastTime: null, canonicalConversationId: null }),
  ];
  const groupChats = [
    group('g_recent', { lastTime: '2026-09-18T10:00:00.000Z' }),
    group('g_old', { lastTime: '2026-08-01T10:00:00.000Z' }),
  ];

  const display = listItems.buildConversationListItems({ aiList, groupChats });
  const candidates = preloadCandidates.buildConversationPreloadCandidates({ aiList, groupChats });

  assert.ok(
    candidates.some((candidate) => candidate.kind === 'direct')
      && candidates.some((candidate) => candidate.kind === 'group'),
    '预热候选必须同时包含 direct 与 group',
  );

  const eligibleDisplayIds = Array.from(
    display.filter((item) => (
      item.kind === 'group'
      || (item.ai.isBlocked !== true && Boolean(item.ai.canonicalConversationId))
    )),
    (item) => (item.kind === 'group' ? `group:${item.id}` : `direct:${item.id}`),
  );

  assert.deepEqual(
    Array.from(candidates, (candidate) => `${candidate.kind}:${candidate.id}`),
    eligibleDisplayIds,
    '预热候选顺序必须等于统一会话列表顺序在可预热会话上的投影',
  );
  assert.equal(candidates[0].id, 'ai_recent', 'pinned 会话出现在排序前部');
  assert.ok(
    !candidates.some((candidate) => candidate.id === 'ai_blocked'),
    '被拉黑的 AI 不进入预热候选',
  );
  assert.ok(
    !candidates.some((candidate) => candidate.id === 'ai_brand_new'),
    '还没有 canonical 会话的 AI 不进入预热候选（预热不得创建会话身份）',
  );
  assert.equal(
    candidates.find((candidate) => candidate.kind === 'group' && candidate.id === 'g_recent').sessionId,
    'g_recent',
    '群聊的会话身份就是 groupId',
  );
}

// ============================================================================
// 24：第一批与后台批次的边界
// ============================================================================
{
  const many = Array.from({ length: 25 }, (_, index) => ({
    kind: 'direct',
    id: `c_${String(index).padStart(2, '0')}`,
    sessionId: `session_${index}`,
    isPinned: false,
    lastActivityAt: new Date(Date.UTC(2026, 8, 26) - index * 60_000).toISOString(),
    createdAt: '2026-01-01T00:00:00.000Z',
  }));

  const { firstTier, remaining } = preloadCandidates.sliceConversationPreloadTiers(
    many,
    preloadCandidates.CHAT_ENTRY_PRELOAD_FIRST_TIER,
    preloadCandidates.CHAT_ENTRY_PRELOAD_TARGET,
  );

  assert.equal(firstTier.length, 6, '第一层预热 6 个会话');
  assert.equal(
    firstTier.length + remaining.length,
    preloadCandidates.CHAT_ENTRY_PRELOAD_TARGET,
    '总预热目标不超过 TARGET（不是一次性 20+）',
  );
  assert.equal(firstTier[0].id, 'c_00', '第一层从列表最前面开始');
  assert.equal(remaining[0].id, 'c_06', '后台批次紧接第一层之后');

  const few = many.slice(0, 3);
  const shortTiers = preloadCandidates.sliceConversationPreloadTiers(few, 6, 16);
  assert.equal(shortTiers.firstTier.length, 3);
  assert.equal(shortTiers.remaining.length, 0, '候选不足时后台批次为空');
}

// ============================================================================
// 不变量：预热目标不得超过 timeline cache 的 session 容量
// ============================================================================
{
  assert.ok(
    preloadCandidates.CHAT_ENTRY_PRELOAD_TARGET
      <= timelineCache.SESSION_TIMELINE_CACHE_SESSION_CAPACITY,
    '预热目标必须 <= timeline cache 会话容量，否则预热完立刻互相淘汰',
  );
}


// ============================================================================
// C：刚置顶的会话必须立刻到整个列表最顶部（即使它的真实消息更旧）
// ============================================================================
{
  const YESTERDAY = '2026-09-17T09:00:00.000Z';
  const TODAY_10 = '2026-09-18T10:00:00.000Z';

  // A：最后消息昨天；B：最后消息今天 10:00。两者都已置顶，且置顶时刻都早于今天。
  const a = direct('A', { lastTime: YESTERDAY, isPinned: true, pinnedAt: YESTERDAY });
  const b = direct('B', { lastTime: TODAY_10, isPinned: true, pinnedAt: YESTERDAY });

  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({ aiList: [a, b] })),
    ['B', 'A'],
    'fixture：置顶区内仍按真实消息活动排序',
  );

  // 用户此刻把 A 重新置顶：pinnedAt 变新 → A 立刻到列表最顶部。
  a.pinnedAt = '2026-09-18T11:00:00.000Z';
  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({ aiList: [a, b] })),
    ['A', 'B'],
    '刚置顶的会话必须立刻出现在置顶区最顶部（靠 pinnedAt，而不是伪造 lastTime）',
  );
  assert.equal(a.lastTime, YESTERDAY, '置顶不得改动真实消息时间');
}

// ============================================================================
// D：置顶不冻结位置 —— 之后的新消息仍可在置顶区内反超
// ============================================================================
{
  const a = direct('A', {
    lastTime: '2026-09-17T09:00:00.000Z',
    isPinned: true,
    pinnedAt: '2026-09-18T12:00:00.000Z',
  });
  const b = direct('B', {
    lastTime: '2026-09-10T09:00:00.000Z',
    isPinned: true,
    pinnedAt: '2026-09-11T09:00:00.000Z',
  });

  assert.deepEqual(idsOf(listItems.buildConversationListItems({ aiList: [a, b] })), ['A', 'B']);

  // B 收到比 A.pinnedAt 更晚的新消息 → B 反超。
  b.lastTime = '2026-09-18T13:00:00.000Z';
  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({ aiList: [a, b] })),
    ['B', 'A'],
    '置顶区内真实新消息仍可让别的置顶会话自然上浮',
  );
}

// ============================================================================
// E：取消置顶不得让「刚刚置顶过」污染普通区排序
// ============================================================================
{
  const WEEK_AGO = '2026-09-11T09:00:00.000Z';
  const YESTERDAY = '2026-09-17T09:00:00.000Z';
  const JUST_PINNED_AT = '2026-09-18T12:00:00.000Z';

  const a = direct('A', { lastTime: WEEK_AGO, isPinned: true, pinnedAt: JUST_PINNED_AT });
  const c = direct('C', { lastTime: YESTERDAY });

  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({ aiList: [a, c] })),
    ['A', 'C'],
    'fixture：置顶的 A 在置顶区顶部',
  );

  // 取消置顶：isPinned=false 且 pinnedAt 必须被清空。
  a.isPinned = false;
  a.pinnedAt = null;
  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({ aiList: [a, c] })),
    ['C', 'A'],
    '取消置顶后必须按真实消息时间排序（一周前），不得留在普通区顶部',
  );

  // 防御：即使 pinnedAt 残留，普通区也绝不能参考它。
  a.pinnedAt = JUST_PINNED_AT;
  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({ aiList: [a, c] })),
    ['C', 'A'],
    '普通区排序不得参考 pinnedAt',
  );
}

// ============================================================================
// F：群聊与单聊的置顶语义完全一致
// ============================================================================
{
  const OLD = '2026-09-10T09:00:00.000Z';
  const NEW = '2026-09-18T10:00:00.000Z';
  const PINNED_NOW = '2026-09-18T12:00:00.000Z';

  const oldGroup = group('g_old', { lastTime: OLD, isPinned: true, pinnedAt: PINNED_NOW });
  const freshDirect = direct('ai_fresh', { lastTime: NEW });
  const otherGroup = group('g_other', { lastTime: '2026-09-18T11:00:00.000Z' });

  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({
      aiList: [freshDirect],
      groupChats: [oldGroup, otherGroup],
    })),
    ['g_old', 'g_other', 'ai_fresh'],
    '群聊刚置顶同样立刻到置顶区顶部；置顶区仍整体在普通区之前',
  );

  oldGroup.isPinned = false;
  oldGroup.pinnedAt = null;
  assert.deepEqual(
    idsOf(listItems.buildConversationListItems({
      aiList: [freshDirect],
      groupChats: [oldGroup, otherGroup],
    })),
    ['g_other', 'ai_fresh', 'g_old'],
    '群聊取消置顶后回到真实消息排序',
  );
}

// ============================================================================
// G / H：动态预热热点集合签名
// ============================================================================
{
  const TARGET = preloadCandidates.CHAT_ENTRY_PRELOAD_TARGET;
  const buildList = (overridesById = {}) => Array.from({ length: 30 }, (_, index) => {
    const id = `c_${String(index).padStart(2, '0')}`;
    return direct(id, {
      // index 越小越新，于是初始 top TARGET 正好是 c_00 .. c_15。
      lastTime: new Date(Date.UTC(2026, 8, 18, 12) - index * 60_000).toISOString(),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(overridesById[id] || {}),
    });
  });

  const candidatesOf = (aiList) => Array.from(
    preloadCandidates.buildConversationPreloadCandidates({ aiList }),
  );

  const initial = candidatesOf(buildList());
  const initialDecision = preloadCandidates.resolveConversationPreloadHotSet({
    previousSignature: null,
    candidates: initial,
  });
  assert.equal(initialDecision.shouldPreload, true, '首次必须开一轮预热');
  assert.equal(initialDecision.candidates.length, TARGET, '热点集合长度为预热目标');
  assert.ok(!initialDecision.candidates.some((candidate) => candidate.id === 'c_29'), 'fixture：Z 起初不在 top 集合');

  // H：列表重读但 top 集合身份与顺序未变 → 不得重开整轮预热。
  const reread = candidatesOf(buildList());
  const unchangedDecision = preloadCandidates.resolveConversationPreloadHotSet({
    previousSignature: initialDecision.signature,
    candidates: reread,
  });
  assert.equal(unchangedDecision.shouldPreload, false, 'top 集合未变时不得重开预热');
  assert.equal(unchangedDecision.signature, initialDecision.signature);

  // H：只有 top 集合之外的会话上下浮动（c_20 与 c_21 换位）→ 签名不变。
  const swappedOutsideTop = candidatesOf(buildList({
    c_21: { lastTime: '2026-09-18T11:00:30.000Z' },
  }));
  const outsideDecision = preloadCandidates.resolveConversationPreloadHotSet({
    previousSignature: initialDecision.signature,
    candidates: swappedOutsideTop,
  });
  assert.equal(outsideDecision.shouldPreload, false, 'top 集合之外的排序变化不得触发预热');

  // G：排名第 30 的会话收到新消息 → 进入 top 集合 → 签名变化 → 新一轮预热。
  const zIsNewest = candidatesOf(buildList({
    c_29: { lastTime: '2026-09-18T23:00:00.000Z' },
  }));
  const zDecision = preloadCandidates.resolveConversationPreloadHotSet({
    previousSignature: initialDecision.signature,
    candidates: zIsNewest,
  });
  assert.equal(zDecision.shouldPreload, true, 'top 集合变化必须开新一轮预热');
  assert.notEqual(zDecision.signature, initialDecision.signature, '签名必须反映身份与顺序变化');
  assert.equal(zDecision.candidates[0].id, 'c_29', '新进榜的会话出现在热点集合首位');
  assert.equal(zDecision.candidates.length, TARGET, '热点集合长度不变');

  // 置顶同样会改变 top 集合（用户刚置顶的会话必须被预热）。
  const pinnedOld = candidatesOf(buildList({
    c_28: { isPinned: true, pinnedAt: '2026-09-18T23:30:00.000Z' },
  }));
  const pinnedDecision = preloadCandidates.resolveConversationPreloadHotSet({
    previousSignature: initialDecision.signature,
    candidates: pinnedOld,
  });
  assert.equal(pinnedDecision.shouldPreload, true, '置顶变化必须让热点集合跟随');
  assert.equal(pinnedDecision.candidates[0].id, 'c_28', '刚置顶的会话进入热点集合首位');

  // 打开已有会话（纯导航）不会改变候选集合本身。
  const navigationOnly = candidatesOf(buildList());
  assert.equal(
    preloadCandidates.buildConversationPreloadHotSetSignature(navigationOnly, TARGET),
    initialDecision.signature,
    '纯导航重读列表不得改变热点集合签名',
  );
}


// ============================================================================
// A~F：freshness 与热点签名分离 —— 同一 hot set 内的消息事实变化只做定向刷新
// ============================================================================
{
  const TARGET = preloadCandidates.CHAT_ENTRY_PRELOAD_TARGET;
  const buildList = (overridesById = {}) => Array.from({ length: 30 }, (_, index) => {
    const id = `c_${String(index).padStart(2, '0')}`;
    return direct(id, {
      lastTime: new Date(Date.UTC(2026, 8, 18, 12) - index * 60_000).toISOString(),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(overridesById[id] || {}),
    });
  });
  const candidatesOf = (aiList) => Array.from(
    preloadCandidates.buildConversationPreloadCandidates({ aiList }),
  );
  const freshnessOf = (list) => Array.from(list, (candidate) => candidate.id);
  const selectedId = (list, id) => list.find((candidate) => candidate.id === id);

  const initial = candidatesOf(buildList());
  const initialSnapshot = preloadCandidates.buildConversationPreloadFreshnessSnapshot(initial, TARGET);
  const initialSignature = preloadCandidates.buildConversationPreloadHotSetSignature(initial, TARGET);

  // 首次运行没有上一轮事实：不得无依据地失效任何缓存。
  const coldStart = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: null,
    candidates: initial,
  });
  assert.equal(
    Array.from(coldStart.changedCandidates).length,
    0,
    '首轮不得无依据失效缓存',
  );
  assert.deepEqual(
    coldStart.snapshot,
    initialSnapshot,
    '首轮必须留下 freshness snapshot',
  );

  // A / F：top16 identity 与顺序完全不变，只有 A（c_00）的消息时间前进。
  const aAdvanced = candidatesOf(buildList({
    c_00: { lastTime: '2026-09-18T12:30:00.000Z' },
  }));
  const advancedSignature = preloadCandidates.buildConversationPreloadHotSetSignature(aAdvanced, TARGET);
  const advanced = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: initialSnapshot,
    candidates: aAdvanced,
  });

  assert.equal(advancedSignature, initialSignature, 'top 集合身份与顺序未变 → 签名必须不变');
  assert.deepEqual(
    freshnessOf(advanced.changedCandidates),
    ['c_00'],
    'signature 不变但 A 的 timeline 事实变了 → changedCandidates 只包含 A',
  );
  assert.equal(
    selectedId(advanced.changedCandidates, 'c_00').lastActivityAt,
    '2026-09-18T12:30:00.000Z',
    'changedCandidates 携带的是本轮最新事实',
  );

  // B / C：用「所有候选都在 tracked hot set 内」的小列表，单独验证方向与 null。
  const T10 = '2026-09-18T10:00:00.000Z';
  const T1130 = '2026-09-18T11:30:00.000Z';
  const smallList = (sALastTime) => [
    direct('s_a', { lastTime: sALastTime, createdAt: '2026-01-01T00:00:00.000Z' }),
    direct('s_b', { lastTime: '2026-09-18T09:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }),
    direct('s_c', { lastTime: '2026-09-18T08:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }),
  ];
  const snapshotOf = (sALastTime) => preloadCandidates.buildConversationPreloadFreshnessSnapshot(
    candidatesOf(smallList(sALastTime)),
    TARGET,
  );

  // B：时间后退（删除最新可见消息）同样必须刷新。
  const rewound = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: snapshotOf(T1130),
    candidates: candidatesOf(smallList(T10)),
  });
  assert.deepEqual(
    freshnessOf(rewound.changedCandidates),
    ['s_a'],
    '时间后退（删除最新可见消息）同样必须刷新，不能只判断「变新」',
  );

  // C：时间变 null（clear history / 删除到空）同样必须刷新。
  const clearedA = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: snapshotOf(T10),
    candidates: candidatesOf(smallList(null)),
  });
  assert.deepEqual(
    freshnessOf(clearedA.changedCandidates),
    ['s_a'],
    'lastActivityAt 变成 null（clear history / 删空）必须判定为过期',
  );

  // 前进方向同样成立（同一小列表口径）。
  const forwarded = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: snapshotOf(T10),
    candidates: candidatesOf(smallList(T1130)),
  });
  assert.deepEqual(
    freshnessOf(forwarded.changedCandidates),
    ['s_a'],
    '时间前进（新消息）必须判定为过期',
  );
  assert.equal(
    Array.from(forwarded.changedCandidates).length,
    1,
    '定向刷新只包含事实变化的会话',
  );

  // D：只有 A 变化时，其他 top candidate 不得被牵连。
  const onlyAChanged = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: initialSnapshot,
    candidates: aAdvanced,
  });
  assert.equal(onlyAChanged.changedCandidates.length, 1, '定向刷新不得牵连其他 top candidate');
  assert.ok(
    !freshnessOf(onlyAChanged.changedCandidates).includes('c_01')
      && !freshnessOf(onlyAChanged.changedCandidates).includes('c_15'),
    'B/C/D 等其他 top candidate 不得进入定向刷新集合',
  );

  // E：Z（第 30 名）带着历史缓存重新进榜 → freshness unknown，必须至少完成一次刷新。
  const zEntered = candidatesOf(buildList({
    c_29: { lastTime: '2026-09-18T23:00:00.000Z' },
  }));
  const zDecision = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: initialSnapshot,
    candidates: zEntered,
  });
  assert.ok(
    freshnessOf(zDecision.changedCandidates).includes('c_29'),
    '新进入 tracked hot set 的候选必须视为 freshness unknown（历史缓存不得直接当 fresh）',
  );
  assert.notEqual(
    preloadCandidates.buildConversationPreloadHotSetSignature(zEntered, TARGET),
    initialSignature,
    'fixture：Z 进榜同时改变了热点签名',
  );

  // 离开 tracked hot set 的候选不再被跟踪（不需要为它做定向刷新）。
  const leftTop16 = candidatesOf(buildList({
    c_15: { lastTime: '2026-09-18T00:00:00.000Z' },
  }));
  const leftDecision = preloadCandidates.resolveConversationPreloadFreshnessChanges({
    previous: initialSnapshot,
    candidates: leftTop16,
  });
  assert.ok(
    !freshnessOf(leftDecision.changedCandidates).includes('c_15'),
    '已离开 tracked hot set 的会话不需要定向刷新（它只是掉出榜单）',
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      leftDecision.snapshot,
      preloadCandidates.buildConversationPreloadCandidateKey({ kind: 'direct', id: 'c_15', sessionId: 'session_c_15' }),
    ),
    '离开 tracked hot set 的会话必须从 snapshot 中移除',
  );

  // freshness key 必须包含 session identity（不能只用 id）。
  assert.equal(
    preloadCandidates.buildConversationPreloadCandidateKey({ kind: 'direct', id: 'x', sessionId: 'session_1' })
      !== preloadCandidates.buildConversationPreloadCandidateKey({ kind: 'direct', id: 'x', sessionId: 'session_2' }),
    true,
    'session identity 变化必须视为另一条 freshness 事实',
  );
}

// ============================================================================
// G~I：runnable 过滤只作用于读集合，绝不影响热点集合与签名
// ============================================================================
{
  const TARGET = preloadCandidates.CHAT_ENTRY_PRELOAD_TARGET;
  const aiList = [
    direct('ai_a', { lastTime: '2026-09-18T12:00:00.000Z' }),
    direct('ai_b', { lastTime: '2026-09-18T11:00:00.000Z' }),
  ];
  const groupChats = [
    group('g_active', { lastTime: '2026-09-18T13:00:00.000Z' }),
    group('g_other', { lastTime: '2026-09-18T10:00:00.000Z' }),
  ];
  const candidates = Array.from(
    preloadCandidates.buildConversationPreloadCandidates({ aiList, groupChats }),
  );
  const signature = preloadCandidates.buildConversationPreloadHotSetSignature(candidates, TARGET);

  // 打开 / 关闭群聊（active group 变化）不得改变热点集合与签名。
  const runnableWithActiveGroup = Array.from(
    preloadCandidates.filterRunnableConversationPreloadCandidates(candidates, {
      activeGroupId: 'g_active',
    }),
  );
  const runnableWithoutActiveGroup = Array.from(
    preloadCandidates.filterRunnableConversationPreloadCandidates(candidates, {
      activeGroupId: null,
    }),
  );

  assert.deepEqual(
    idsOf(runnableWithActiveGroup),
    ['ai_a', 'ai_b', 'g_other'],
    'active group 必须从背景预热读集合中排除，非 active group 正常预热',
  );
  assert.deepEqual(
    idsOf(runnableWithoutActiveGroup),
    ['g_active', 'ai_a', 'ai_b', 'g_other'],
    '没有打开群聊时全部群聊候选都可预热',
  );
  assert.equal(
    preloadCandidates.buildConversationPreloadHotSetSignature(candidates, TARGET),
    signature,
    'active group 不得改变热点签名（纯导航不重排热点集合）',
  );
  assert.ok(
    Array.from(candidates, (candidate) => candidate.id).includes('g_active'),
    'active group 仍必须留在热点集合里',
  );

  // active direct 仍然被排除（现有语义不变）。
  const runnableWithActiveDirect = Array.from(
    preloadCandidates.filterRunnableConversationPreloadCandidates(candidates, {
      isDirectConversationActiveOrPreparing: (aiId) => aiId === 'ai_a',
    }),
  );
  assert.deepEqual(
    idsOf(runnableWithActiveDirect),
    ['g_active', 'ai_b', 'g_other'],
    'active direct 必须从背景预热读集合中排除，群聊不受影响',
  );

  assert.equal(
    preloadCandidates.isConversationPreloadCandidateRunnable(
      candidates.find((candidate) => candidate.id === 'g_active'),
      { activeGroupId: 'g_active' },
    ),
    false,
    '谓词与过滤函数必须一致',
  );
}

console.log('verify-conversation-list-ordering: all assertions passed');
