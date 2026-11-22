/** Moments M3 Social Inbox 行为与 cutoff 契约验证。 */
import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';


let currentExecutor = null;
let failActorDirectory = false;
const identity = {
  profile: { id: 'self', name: '用户', avatar: null },
  assistants: [
    { id: 'a', agentId: 'agent-a', name: 'A', avatar: null },
    { id: 'b', agentId: 'agent-b', name: 'B', avatar: null },
    { id: 'c', agentId: 'agent-c', name: 'C', avatar: null },
  ],
};

const mocks = {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => currentExecutor } },
  '@features/profile': {
    getCurrentUserProfile: async () => identity.profile,
    SELF_USER_PROFILE_ID: 'self',
  },
  '@features/assistants': {
    listAIAssistants: async () => {
      if (failActorDirectory) throw new Error('actor directory failed');
      return identity.assistants;
    },
  },
  '@features/media': {
    releaseMediaAssetCandidates: async () => undefined,
  },
};
const cache = new Map();
function load(relativePath) {
  const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.join(ROOT, relativePath);
  if (cache.has(absolutePath)) return cache.get(absolutePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolutePath,
    reportDiagnostics: true,
  });
  assert.deepEqual(
    (compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error),
    [],
    `${relativePath} 无法编译`,
  );
  const module = { exports: {} };
  cache.set(absolutePath, module.exports);
  const requireMock = (specifier) => {
    if (!specifier.startsWith('.')) {
      assert.ok(Object.hasOwn(mocks, specifier), `${relativePath} 存在未声明依赖：${specifier}`);
      return mocks[specifier];
    }
    const base = path.resolve(path.dirname(absolutePath), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (fs.existsSync(candidate)) return load(candidate);
    }
    throw new Error(`无法解析 ${specifier}`);
  };
  new Function('exports', 'require', 'module', compiled.outputText)(module.exports, requireMock, module);
  cache.set(absolutePath, module.exports);
  return module.exports;
}
mocks['@shared/runtime/abortSignal'] = load('src/shared/runtime/abortSignal.ts');
mocks['@shared/runtime/RuntimeSlot'] = load('src/shared/runtime/RuntimeSlot.ts');

function executorFor(db) {
  const executor = {
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    execAsync: async (sql) => db.exec(sql),
    async withExclusiveTransactionAsync(task) {
      db.exec('BEGIN;');
      try {
        const result = await task(executor);
        db.exec('COMMIT;');
        return result;
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
  };
  return executor;
}

const schema = load('src/platform/persistence/sqlite/schema.ts');
const repositoryModule = load('src/features/moments/infrastructure/SQLiteMomentRepository.ts');
const createModule = load('src/features/moments/application/CreateMoment.ts');
const access = load('src/features/moments/application/MomentAccess.ts');
const userCommands = load('src/features/moments/application/UserMomentCommands.ts');
const summaryModule = load('src/features/moments/application/SocialInboxSummary.ts');
const detailTool = load('src/features/moments/aiTools/GetMomentDetailTool.ts');
const inboxTool = load('src/features/moments/aiTools/ReadSocialInboxTool.ts');
const searchTool = load('src/features/moments/aiTools/SearchMomentsTool.ts');
const replyTool = load('src/features/moments/aiTools/AIReplyMomentCommentTool.ts');
assert.equal(inboxTool.definition.name, 'readSocialInbox');
assert.equal(Object.hasOwn(inboxTool.definition.parameters.properties, 'agentId'), false);

function delivery({
  seq,
  momentId,
  eventType = 'moment_published',
  actorId = 'agent-a',
  actorName = 'A',
  createdAt = '2026-09-21T00:00:00.000Z',
}) {
  return {
    deliverySeq: seq,
    deliveryId: `delivery-${seq}`,
    recipientAgentId: 'agent-a',
    eventType,
    sourceMomentId: momentId,
    sourceCommentId: eventType === 'comment_on_your_moment' ? `comment-${seq}` : null,
    targetCommentId: null,
    actorType: 'ai',
    actorId,
    actorNameSnapshot: actorName,
    createdAt,
    readAt: null,
  };
}

// bounded summary 必须 newest-first，长期未消费的旧 group 不能饿死新事件。
const freshnessDeliveries = Array.from({ length: 13 }, (_, index) => delivery({
  seq: index + 1,
  momentId: `old-moment-${index + 1}`,
}));
freshnessDeliveries.push(delivery({ seq: 100, momentId: 'newest-moment' }));
const freshnessSummary = await summaryModule.loadSocialInboxSummary(
  { listUnreadSocialDeliveries: async () => freshnessDeliveries },
  'agent-a',
  { groupLimit: 12 },
);
assert.equal(freshnessSummary.entries[0].momentId, 'newest-moment');
assert.equal(
  freshnessSummary.entries.some((entry) => entry.momentId === 'old-moment-1'),
  false,
  '最旧 group 必须被 newest-first bounded summary 挤到 remaining',
);
assert.equal(freshnessSummary.remainingUnreadCount, 2, 'remaining 必须统计未展开 delivery 数而非 group 数');

// 摘要保留历史事件时间，展示设备本地日期、时分秒与时区，不能变成注入时刻。
const eventTimes = [
  ['moment_published', '2026-09-21T23:45:12.000Z', '发布时间'],
  ['comment_on_your_moment', '2026-09-22T00:15:23.000Z', '评论时间'],
  ['reply_to_your_comment', '2026-09-22T01:25:34.000Z', '回复时间'],
];
const timedSummary = await summaryModule.loadSocialInboxSummary({
  listUnreadSocialDeliveries: async () => eventTimes.map(([eventType, createdAt], index) => delivery({
    seq: index + 1, momentId: `timed-${index}`, eventType, createdAt,
  })),
}, 'agent-a', { groupLimit: 10 });
for (const [eventType, createdAt, label] of eventTimes) {
  const entry = timedSummary.entries.find((item) => item.eventType === eventType);
  assert.equal(entry.createdAt, createdAt, '摘要必须保留原始事件时间');
  const formatted = summaryModule.formatSocialInboxSummary({ ...timedSummary, entries: [entry] });
  const local = new Date(createdAt);
  assert.ok(formatted.includes(`${local.getFullYear()}/${local.getMonth() + 1}/${local.getDate()}`), '日期使用设备本地时区，包含年份');
  assert.ok(formatted.includes(`${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}:${String(local.getSeconds()).padStart(2, '0')}`), '事件时间精确到秒');
  assert.ok(formatted.includes(`${label}: `));
  assert.match(formatted, /GMT(?:[+-]\d{2}:\d{2})?/u, '事件时间带 UTC 偏移');
}

// Like group 用 MAX(deliverySeq) 表示最近再次活跃，并保持全部 unread like 计数。
const likeFreshnessSummary = await summaryModule.loadSocialInboxSummary(
  {
    listUnreadSocialDeliveries: async () => [
      delivery({ seq: 5, momentId: 'moment-a', eventType: 'like_on_your_moment', actorId: 'agent-a', actorName: 'A', createdAt: '2026-09-21T01:00:00.000Z' }),
      delivery({ seq: 100, momentId: 'moment-b', actorId: 'agent-b', actorName: 'B' }),
      delivery({ seq: 200, momentId: 'moment-a', eventType: 'like_on_your_moment', actorId: 'agent-c', actorName: 'C', createdAt: '2026-09-21T12:34:56.000Z' }),
      delivery({ seq: 3, momentId: 'moment-a', eventType: 'like_on_your_moment', actorId: 'agent-b', actorName: 'B', createdAt: '2026-09-20T00:00:00.000Z' }),
    ],
  },
  'agent-a',
  { groupLimit: 10 },
);
assert.equal(likeFreshnessSummary.entries[0].momentId, 'moment-a', '新 like 必须让旧 Moment 的 like group 重新浮到最前');
assert.equal(likeFreshnessSummary.entries[0].eventType, 'like_on_your_moment');
assert.equal(likeFreshnessSummary.entries[0].eventCount, 3, 'like group 必须聚合全部当前 unread delivery');
assert.equal(likeFreshnessSummary.entries[0].createdAt, '2026-09-21T12:34:56.000Z', '合并点赞必须保留最新事件的时间，不依赖输入顺序');
assert.match(summaryModule.formatSocialInboxSummary(likeFreshnessSummary), /最近点赞时间:/u);
assert.equal(likeFreshnessSummary.entries[1].momentId, 'moment-b');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
for (const sql of Object.values(schema.SCHEMAS)) db.exec(sql);
for (const sql of Object.values(schema.INDEXES)) {
  try { db.exec(sql); } catch { /* 无关索引可能依赖测试未建立的数据。 */ }
}
db.exec(`
  INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES
    ('a', 'agent-a', 'A', 'model', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'),
    ('b', 'agent-b', 'B', 'model', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z'),
    ('c', 'agent-c', 'C', 'model', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
`);
currentExecutor = executorFor(db);
const repository = new repositoryModule.SQLiteMomentRepository();
const directory = { listAgentIds: async () => identity.assistants.map((item) => item.agentId) };
const actorA = { agentId: 'agent-a', nameSnapshot: 'A' };
const actorB = { agentId: 'agent-b', nameSnapshot: 'B' };
const actorC = { agentId: 'agent-c', nameSnapshot: 'C' };
const unread = (agentId) => repository.listUnreadSocialDeliveries(agentId);

db.exec(`CREATE TRIGGER fail_social_delivery_for_atomic_test
  BEFORE INSERT ON moment_social_inbox_deliveries
  WHEN NEW.source_moment_id = 'moment-atomic'
  BEGIN SELECT RAISE(ABORT, 'forced delivery failure'); END;`);
await assert.rejects(() => repository.createMoment({
  id: 'moment-atomic',
  authorType: 'user',
  authorId: 'self',
  authorNameSnapshot: '用户',
  content: 'atomic',
  audience: { mode: 'all' },
  deliveryRecipientAgentIds: ['agent-a'],
}));
assert.equal(
  db.prepare("SELECT COUNT(*) AS c FROM moments WHERE id = 'moment-atomic'").get().c,
  0,
  'delivery 写入失败时 Moment fact 必须随同一事务回滚',
);
db.exec('DROP TRIGGER fail_social_delivery_for_atomic_test;');

// 发布 recipient 必须来自同一份目录快照，且 AI 作者无 self-delivery。
await createModule.createUserMoment(repository, directory, { content: 'all' });
assert.deepEqual((await Promise.all(['agent-a', 'agent-b', 'agent-c'].map(unread))).map((x) => x.length), [1, 1, 1]);
const selectedMoment = await createModule.createUserMoment(repository, directory, {
  content: 'selected', audience: { mode: 'selected', viewerAgentIds: ['agent-b'] },
});
assert.equal((await unread('agent-b')).filter((x) => x.sourceMomentId === selectedMoment.id).length, 1);
assert.equal((await unread('agent-a')).filter((x) => x.sourceMomentId === selectedMoment.id).length, 0);
const exceptMoment = await createModule.createUserMoment(repository, directory, {
  content: 'except', audience: { mode: 'all_except', viewerAgentIds: ['agent-c'] },
});
assert.equal((await unread('agent-c')).some((x) => x.sourceMomentId === exceptMoment.id), false);
const aiMoment = await createModule.createAgentMoment(repository, directory, {
  agentId: 'agent-a', nameSnapshot: 'A', content: 'AI moment',
});
assert.equal((await unread('agent-a')).some((x) => x.sourceMomentId === aiMoment.id), false);
assert.equal((await unread('agent-b')).some((x) => x.sourceMomentId === aiMoment.id), true);
identity.assistants.push({ id: 'd', agentId: 'agent-d', name: 'D', avatar: null });
assert.equal((await unread('agent-d')).length, 0, '发布后新增 AI 不得补发历史 delivery');

// 顶层评论只通知 AI Moment owner；reply 只通知直接 parent author。
const top = await userCommands.commentMomentAsUser(repository, aiMoment.id, '用户评论');
let ownerEvents = await unread('agent-a');
assert.equal(ownerEvents.filter((x) => x.eventType === 'comment_on_your_moment' && x.sourceCommentId === top.id).length, 1);
const [bComment] = await access.commentMomentAsAgent(repository, actorB, aiMoment.id, ['B comment']);
const [cReply] = await access.replyMomentCommentAsAgent(repository, actorC, bComment.id, ['C reply']);
const replyEvent = (await unread('agent-b')).find((x) => x.sourceCommentId === cReply.id);
assert.equal(replyEvent?.eventType, 'reply_to_your_comment');
assert.equal(replyEvent?.targetCommentId, bComment.id);
assert.equal((await unread('agent-a')).some((x) => x.sourceCommentId === cReply.id), false);
const [selfReply] = await access.replyMomentCommentAsAgent(repository, actorB, bComment.id, ['self']);
assert.equal((await unread('agent-b')).some((x) => x.sourceCommentId === selfReply.id), false);
const userMoment = await createModule.createUserMoment(repository, directory, { content: 'user moment' });
await access.commentMomentAsAgent(repository, actorA, userMoment.id, ['no owner inbox']);
assert.equal((await unread('agent-a')).some((x) => x.eventType === 'comment_on_your_moment' && x.sourceMomentId === userMoment.id), false);

// Like 底层逐条投递；duplicate 不重复，unlike 撤销未读，re-like 产生新事件。
await userCommands.likeMomentAsUser(repository, aiMoment.id);
await access.likeMomentAsAgent(repository, actorB, aiMoment.id);
assert.equal((await unread('agent-a')).filter((x) => x.eventType === 'like_on_your_moment' && x.sourceMomentId === aiMoment.id).length, 2);
assert.equal(await access.likeMomentAsAgent(repository, actorB, aiMoment.id), null);
assert.equal((await unread('agent-a')).filter((x) => x.eventType === 'like_on_your_moment' && x.sourceMomentId === aiMoment.id).length, 2);
await access.unlikeMomentAsAgent(repository, actorB, aiMoment.id);
assert.equal((await unread('agent-a')).filter((x) => x.eventType === 'like_on_your_moment' && x.sourceMomentId === aiMoment.id).length, 1);
await access.likeMomentAsAgent(repository, actorB, aiMoment.id);
assert.equal((await unread('agent-a')).filter((x) => x.eventType === 'like_on_your_moment' && x.sourceMomentId === aiMoment.id).length, 2);

const beforeSummary = (await unread('agent-a')).length;
const summary = await summaryModule.loadSocialInboxSummary(repository, 'agent-a', { groupLimit: 50 });
assert.equal((await unread('agent-a')).length, beforeSummary, 'summary 不得 mark read');
const likeSummary = summary.entries.find((x) => x.eventType === 'like_on_your_moment' && x.momentId === aiMoment.id);
assert.equal(likeSummary?.eventCount, 2, '摘要聚合不得改变底层逐条 delivery count');
assert.match(summaryModule.formatSocialInboxSummary(summary), new RegExp(`momentId: ${aiMoment.id}`));
const inboxToolResult = await inboxTool.execute({ limit: 50 }, {
  repositories: { moment: repository }, aiConfig: {}, getAgentId: () => 'agent-a',
  getAIName: () => 'A', isBlocked: () => false,
});
assert.equal(inboxToolResult.success, true);
assert.deepEqual(inboxToolResult.data, summary, '查询工具返回与自动注入相同的含时间摘要');
assert.ok(inboxToolResult.message.includes(summaryModule.formatSocialInboxSummary(summary)), '模型可见的工具消息包含事件时间');
assert.equal((await unread('agent-a')).length, beforeSummary, 'readSocialInbox 不得 mark read');

const summaryPages = [];
let summaryCursor;
do {
  const page = await summaryModule.loadSocialInboxSummary(repository, 'agent-a', { groupLimit: 2, beforeDeliverySeq: summaryCursor });
  summaryPages.push(...page.entries);
  summaryCursor = page.nextCursor;
} while (summaryCursor !== null);
assert.deepEqual(summaryPages, summary.entries, '未读摘要翻页必须完整覆盖聚合事件，不能反复只返回首页');
assert.equal((await unread('agent-a')).length, beforeSummary, '摘要分页不得消费事件');

// capture cutoff 后插入新 delivery，mark-through 只能消费 cutoff 内事件。
const captured = await repository.captureMomentDetailForAgent('agent-a', aiMoment.id);
assert.ok(captured?.unreadCutoffSeq);
db.prepare(`INSERT INTO moment_social_inbox_deliveries
  (delivery_id, recipient_agent_id, event_type, source_moment_id, source_comment_id,
   target_comment_id, actor_type, actor_id, actor_name_snapshot, created_at, read_at)
  VALUES ('after-cutoff', 'agent-a', 'like_on_your_moment', ?, NULL, NULL, 'user', 'self', '用户', ?, NULL)`)
  .run(aiMoment.id, new Date().toISOString());
await repository.markMomentSocialDeliveriesReadThrough('agent-a', aiMoment.id, captured.unreadCutoffSeq);
assert.deepEqual(
  db.prepare(`SELECT delivery_id, read_at IS NULL AS unread FROM moment_social_inbox_deliveries
    WHERE recipient_agent_id = 'agent-a' AND source_moment_id = ? ORDER BY delivery_seq`).all(aiMoment.id)
    .slice(-2).map((row) => Number(row.unread)),
  [0, 1],
  'cutoff 之后的新 delivery 必须继续 unread',
);

// Tool 完整构建失败不消费；成功后消费自己的当前 Moment cutoff，不影响其他 recipient/Moment。
await userCommands.commentMomentAsUser(repository, aiMoment.id, 'detail failure event');
const unreadBeforeFailure = (await unread('agent-a')).filter((x) => x.sourceMomentId === aiMoment.id).length;
failActorDirectory = true;
const contextA = {
  sharedState: {},
  repositories: { moment: repository }, aiConfig: {}, getAgentId: () => 'agent-a',
  getAIName: () => 'A', isBlocked: () => false,
};
const originalConsoleError = console.error;
console.error = () => undefined;
try {
  assert.equal((await detailTool.execute({ momentId: aiMoment.id }, contextA)).success, false);
} finally {
  console.error = originalConsoleError;
}
failActorDirectory = false;
assert.equal((await unread('agent-a')).filter((x) => x.sourceMomentId === aiMoment.id).length, unreadBeforeFailure);
assert.equal((await detailTool.execute({ momentId: aiMoment.id }, contextA)).success, true);
assert.equal((await unread('agent-a')).filter((x) => x.sourceMomentId === aiMoment.id).length, 0);
const readLikeCount = db.prepare(`SELECT COUNT(*) AS c FROM moment_social_inbox_deliveries
  WHERE recipient_agent_id = 'agent-a' AND source_moment_id = ?
    AND event_type = 'like_on_your_moment' AND read_at IS NOT NULL`).get(aiMoment.id).c;
await access.unlikeMomentAsAgent(repository, actorB, aiMoment.id);
await access.likeMomentAsAgent(repository, actorB, aiMoment.id);
assert.equal(
  db.prepare(`SELECT COUNT(*) AS c FROM moment_social_inbox_deliveries
    WHERE recipient_agent_id = 'agent-a' AND source_moment_id = ?
      AND event_type = 'like_on_your_moment' AND read_at IS NOT NULL`).get(aiMoment.id).c,
  readLikeCount,
  '已 read 的旧 like delivery 必须保留',
);
assert.equal(
  (await unread('agent-a')).filter((x) => x.eventType === 'like_on_your_moment' && x.sourceMomentId === aiMoment.id).length,
  1,
  'read → unlike → re-like 必须创建新的 unread delivery',
);
assert.ok((await unread('agent-b')).length > 0, 'detail 只能消费当前 recipient');
assert.equal((await detailTool.execute({ momentId: selectedMoment.id }, {
  ...contextA, getAgentId: () => 'agent-c',
})).success, false, '隐藏 detail 必须维持 anti-probing 失败语义');

// source/target/Moment 删除通过 FK 清理 stale delivery。
const deleteSourceMoment = await createModule.createAgentMoment(repository, directory, {
  agentId: 'agent-a', nameSnapshot: 'A', content: 'delete source',
});
const deleteSource = await userCommands.commentMomentAsUser(repository, deleteSourceMoment.id, 'delete me');
assert.equal((await unread('agent-a')).some((x) => x.sourceCommentId === deleteSource.id), true);
await repository.deleteComment(deleteSource.id);
assert.equal((await unread('agent-a')).some((x) => x.sourceCommentId === deleteSource.id), false);
const [target] = await access.commentMomentAsAgent(repository, actorB, deleteSourceMoment.id, ['target']);
const [sourceReply] = await access.replyMomentCommentAsAgent(repository, actorC, target.id, ['reply']);
assert.equal((await unread('agent-b')).some((x) => x.sourceCommentId === sourceReply.id), true);
await repository.deleteComment(target.id);
assert.equal((await unread('agent-b')).some((x) => x.sourceCommentId === sourceReply.id), false);
await repository.deleteMoment(deleteSourceMoment.id);
assert.equal(db.prepare('SELECT COUNT(*) AS c FROM moment_social_inbox_deliveries WHERE source_moment_id = ?').get(deleteSourceMoment.id).c, 0);

// 看过但未回复：跨 run 丢失临时上下文后，仍能从评论内容重新定位并回复。
for (const momentId of new Set((await unread('agent-a')).map((item) => item.sourceMomentId))) {
  assert.equal((await detailTool.execute({ momentId }, contextA)).success, true);
}
const laterMoment = await createModule.createAgentMoment(repository, directory, {
  agentId: 'agent-a', nameSnapshot: 'A', content: '周末的一条时刻',
});
const laterTarget = await userCommands.commentMomentAsUser(repository, laterMoment.id, '下次一起去看银杏吧');
const beforeReading = await inboxTool.execute({}, contextA);
assert.ok(beforeReading.message.includes(`momentId: ${laterMoment.id}`));
const firstReading = await detailTool.execute({ momentId: laterMoment.id }, contextA);
assert.equal(firstReading.success, true);
assert.match(firstReading.message, /已读不等于已回复/u, '模型可见详情必须区分已读和已回复');
assert.equal((await repository.listComments(laterMoment.id)).length, 1, '读取不自动回复');

const laterContext = { ...contextA, sharedState: {} };
const emptyInbox = await inboxTool.execute({}, laterContext);
assert.equal(emptyInbox.data.totalUnreadCount, 0);
assert.match(emptyInbox.message, /searchMoments/u, '空 Inbox 必须把历史查找入口交给模型');
assert.match(emptyInbox.message, /已读不等于已回复/u);
const byComment = await searchTool.execute({ commentKeyword: '银杏' }, laterContext);
assert.equal(byComment.success, true);
assert.equal(byComment.data.length, 1);
assert.ok(byComment.message.includes(`momentId: ${laterMoment.id}`));
const reread = await detailTool.execute({ momentId: laterMoment.id }, laterContext);
assert.equal(reread.success, true, '同一 ID 读取已读时刻不依赖上一轮状态');
assert.ok(reread.message.includes(`commentId: ${laterTarget.id}`), '跨 run 重读仍返回真实回复目标');
const invalidReply = await replyTool.execute({ commentId: 'missing-comment', content: '一起去' }, laterContext);
assert.equal(invalidReply.success, false);
assert.match(invalidReply.error, /getMomentDetail/u, '失效评论 ID 必须给出重新读取的纠正入口');
assert.match(invalidReply.error, /commentKeyword/u);
assert.equal((await repository.listComments(laterMoment.id)).length, 1, '无效目标不产生回复');
const laterReply = await replyTool.execute({ commentId: laterTarget.id, content: '好，我们一起去' }, laterContext);
assert.equal(laterReply.success, true);
const committedReply = await repository.getComment(laterReply.data.commentIds[0]);
assert.equal(committedReply.momentId, laterMoment.id);
assert.equal(committedReply.parentCommentId, laterTarget.id);
assert.equal(committedReply.content, '好，我们一起去');
assert.equal((await unread('agent-a')).length, 0, '回复不重新制造已消费事件');

console.log('Moments M3 Social Inbox / cutoff 验证通过。');
