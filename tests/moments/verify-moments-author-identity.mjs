/**
 * Moments V2：AI 工具的作者身份来源、可见性前置与中止语义验证。
 *
 * 这里只验证工具层的外部可观察行为（写入身份、拒绝路径、abort 边界），
 * 需要真实 SQLite 的 schema / ACL / 级联行为由 verify-moments-v2-domain.mjs 覆盖。
 */

import { repoRoot as ROOT } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const moduleCache = new Map();
const abortSignalRuntime = loadModule('src/shared/runtime/abortSignal.ts');

function loadModule(relativePath) {
  const sourcePath = path.join(ROOT, relativePath);
  if (moduleCache.has(sourcePath)) {
    return moduleCache.get(sourcePath);
  }

  const compiled = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  // 与 Node 一致地共享模块实例：同一模块必须拿到同一个 class identity。
  moduleCache.set(sourcePath, module.exports);
  const requireMock = (specifier) => {
    if (specifier === '@shared/runtime/abortSignal') {
      return abortSignalRuntime;
    }
    if (specifier === '@features/media') {
      return { releaseMediaAssetCandidates: async () => undefined };
    }
    if (specifier === '@features/profile') {
      return { SELF_USER_PROFILE_ID: 'self', getCurrentUserProfile: async () => ({ name: '用户', avatar: null }) };
    }
    if (specifier === '@features/assistants') {
      return { listAIAssistants: async () => [{ agentId: 'agent-current', name: 'AI 当前名称', avatar: null }] };
    }
    assert.ok(specifier.startsWith('.'), `未声明的运行时依赖：${specifier}`);
    const base = path.resolve(path.dirname(sourcePath), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (fs.existsSync(candidate)) {
        return loadModule(path.relative(ROOT, candidate).replaceAll('\\', '/'));
      }
    }
    throw new Error(`无法解析 ${specifier}`);
  };

  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled.outputText)(
    module.exports,
    requireMock,
    module,
    sourcePath,
    path.dirname(sourcePath),
  );
  moduleCache.set(sourcePath, module.exports);
  return module.exports;
}

const commentTool = loadModule('src/features/moments/aiTools/AICommentMomentTool.ts');
const likeTool = loadModule('src/features/moments/aiTools/AILikeMomentTool.ts');

function createRepositoryMock({ visible = true } = {}) {
  const writes = { comments: [], likes: [] };
  return {
    writes,
    async captureMomentDetailForAgent(viewerAgentId, momentId) {
      const moment = await this.getVisibleMomentForAgent(viewerAgentId, momentId);
      return moment ? { moment, comments: [], likes: [], media: [], unreadCutoffSeq: null } : null;
    },
    async getVisibleMomentForAgent(viewerAgentId, momentId) {
      if (!visible) return null;
      return {
        id: momentId,
        authorType: 'user',
        authorId: 'self',
        authorNameSnapshot: '用户',
        content: '正文',
        createdAt: '2026-09-17T00:00:00.000Z',
        audienceMode: 'all',
      };
    },
    async getComment(commentId) {
      return {
        id: commentId,
        momentId: 'moment-visible',
        authorType: 'user',
        authorId: 'self',
        authorNameSnapshot: '用户',
        parentCommentId: null,
        content: '父评论',
        createdAt: '2026-09-17T00:00:00.000Z',
      };
    },
    async insertComments(inputs) {
      writes.comments.push(...inputs);
      return inputs.map((input) => ({
        ...input,
        createdAt: '2026-09-17T00:00:00.000Z',
      }));
    },
    async insertLike(input) {
      writes.likes.push(input);
      return { ...input, createdAt: '2026-09-17T00:00:00.000Z' };
    },
  };
}

function createContext(repository, overrides = {}) {
  return {
    sharedState: {},
    aiConfig: { avatar: 'legacy://config-avatar' },
    repositories: { moment: repository },
    getAgentId: () => 'agent-current',
    getAIName: () => 'AI 当前名称',
    isBlocked: () => false,
    ...overrides,
  };
}

// ── 作者身份只能来自 ToolContext 的不可变 agentId ────────

const identityRepository = createRepositoryMock();
const missingAgentId = await commentTool.execute(
  { momentId: 'moment-visible', content: 'comment' },
  createContext(identityRepository, { getAgentId: () => null }),
);
assert.equal(missingAgentId.success, false, '缺少 agentId 时不得写入评论');
assert.equal(identityRepository.writes.comments.length, 0);

const acceptedComment = await commentTool.execute(
  { momentId: 'moment-visible', content: '  comment  ' },
  createContext(identityRepository),
);
assert.equal(acceptedComment.success, true);
assert.equal(identityRepository.writes.comments.length, 1);
const commentInput = identityRepository.writes.comments[0];
assert.equal(commentInput.authorType, 'ai', 'AI 评论必须声明 ai 作者类型');
assert.equal(commentInput.authorId, 'agent-current', 'AI 评论身份必须是 agentId');
assert.equal(commentInput.authorNameSnapshot, 'AI 当前名称', '名称只能作为写入当时的快照');
assert.equal(commentInput.content, 'comment', '评论正文必须 trim 后写入');
assert.equal(Object.hasOwn(commentInput, 'avatar'), false, 'V2 不再写入任何 avatar 快照字段');
assert.equal(Object.hasOwn(commentInput, 'isAI'), false, 'V2 不再写入 is_ai 这类 V1 标记');
assert.equal(commentInput.parentCommentId, null, '顶层评论不得挂 parent');

const likeContext = createContext(identityRepository);
const previewLike = await likeTool.execute({ momentId: 'moment-visible' }, likeContext);
assert.equal(previewLike.success, true);
assert.equal(previewLike.data.action, 'preview');
assert.equal(identityRepository.writes.likes.length, 0, '未读取的点赞调用只能预览，不得产生点赞');
const acceptedLike = await likeTool.execute(
  { momentId: 'moment-visible', readReceipt: previewLike.data.readReceipt },
  likeContext,
);
assert.equal(acceptedLike.success, true);
assert.equal(identityRepository.writes.likes[0].actorType, 'ai');
assert.equal(identityRepository.writes.likes[0].actorId, 'agent-current');
assert.equal(Object.hasOwn(identityRepository.writes.likes[0], 'avatar'), false);
assert.equal(Object.hasOwn(identityRepository.writes.likes[0], 'isAI'), false);

const missingAgentIdLike = await likeTool.execute(
  { momentId: 'moment-visible' },
  createContext(identityRepository, { getAgentId: () => null }),
);
assert.equal(missingAgentIdLike.success, false, '缺少 agentId 时不得点赞');
assert.equal(identityRepository.writes.likes.length, 1);

// blocked AI 不得通过工具写入。
const blockedRepository = createRepositoryMock();
assert.equal(
  (await commentTool.execute(
    { momentId: 'moment-visible', content: 'comment' },
    createContext(blockedRepository, { isBlocked: () => true }),
  )).success,
  false,
);
assert.equal(
  (await likeTool.execute(
    { momentId: 'moment-visible' },
    createContext(blockedRepository, { isBlocked: () => true }),
  )).success,
  false,
);
assert.equal(blockedRepository.writes.comments.length + blockedRepository.writes.likes.length, 0);

// ── 不可见的 Moment 必须在写路径前被拒绝 ─────────────────

const hiddenRepository = createRepositoryMock({ visible: false });
const hiddenComment = await commentTool.execute(
  { momentId: 'moment-hidden', content: 'comment' },
  createContext(hiddenRepository),
);
assert.equal(hiddenComment.success, false);
assert.equal(hiddenComment.error, '未找到该时刻');
assert.equal(hiddenRepository.writes.comments.length, 0, '不可见 Moment 不得被评论');

const hiddenLike = await likeTool.execute(
  { momentId: 'moment-hidden' },
  createContext(hiddenRepository),
);
assert.equal(hiddenLike.success, false);
assert.equal(hiddenRepository.writes.likes.length, 0, '不可见 Moment 不得被点赞');

// ── 中止语义：commit 前不写，commit 开始后不拆断 ──────────

const abortBeforeCommit = new AbortController();
abortBeforeCommit.abort(new Error('comment cancelled before commit'));
const interruptedRepository = createRepositoryMock();
await assert.rejects(
  () => commentTool.execute(
    { momentId: 'moment-visible', content: 'comment' },
    createContext(interruptedRepository, { abortSignal: abortBeforeCommit.signal }),
  ),
  /comment cancelled before commit/u,
);
assert.equal(
  interruptedRepository.writes.comments.length,
  0,
  '事务型 commit 前取消时不得写入任何业务事实',
);

const abortDuringCommit = new AbortController();
const committingRepository = createRepositoryMock();
committingRepository.insertComments = async (inputs) => {
  committingRepository.writes.comments.push(...inputs);
  abortDuringCommit.abort(new Error('comment cancelled during commit'));
  return inputs.map((input) => ({ ...input, createdAt: '2026-09-17T00:00:00.000Z' }));
};
const committedComment = await commentTool.execute(
  { momentId: 'moment-visible', content: 'comment' },
  createContext(committingRepository, { abortSignal: abortDuringCommit.signal }),
);
assert.equal(committedComment.success, true, '评论 commit 开始后不得被 execution abort 拆断');

const abortBeforeLike = new AbortController();
abortBeforeLike.abort(new Error('like cancelled before commit'));
await assert.rejects(
  () => likeTool.execute(
    { momentId: 'moment-visible' },
    createContext(interruptedRepository, { abortSignal: abortBeforeLike.signal }),
  ),
  /like cancelled before commit/u,
);
assert.equal(interruptedRepository.writes.likes.length, 0, '点赞在 commit 前取消时不得写入');

// 重复点赞保持既有事实，并给出可理解的幂等结果。

const duplicateRepository = createRepositoryMock();
duplicateRepository.insertLike = async () => null;
const duplicateContext = createContext(duplicateRepository);
const duplicatePreview = await likeTool.execute({ momentId: 'moment-visible' }, duplicateContext);
const duplicateLike = await likeTool.execute(
  { momentId: 'moment-visible', readReceipt: duplicatePreview.data.readReceipt },
  duplicateContext,
);
assert.equal(duplicateLike.success, true);
assert.equal(duplicateLike.data.action, 'already_liked');

console.log('Moments V2 作者身份与 AI 工具中止语义验证通过。');
