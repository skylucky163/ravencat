/** Moments V2 M5：真实 SQLite 原子发布、analysis CAS、设置与产品边界验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = process.cwd();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
let currentExecutor;
const profile = { id: 'self', name: '用户', avatar: null, momentsCover: null };
const assistants = ['author', 'reader', 'hidden'].map((name) => ({ name, agentId: `agent-${name}` }));
class MediaAssetNotFoundError extends Error {}
class MediaAssetMissingError extends Error {}
let resolveHook = null;

const mocks = {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => currentExecutor } },
  '@features/profile': { getCurrentUserProfile: async () => profile, SELF_USER_PROFILE_ID: 'self' },
  '@features/assistants': { listAIAssistants: async () => assistants },
  '@features/media': {
    releaseMediaAssetCandidates: async () => undefined,
    MEDIA_ASSET_STORAGE_BACKEND: { persistentImage: 'persistent-image' },
    MediaAssetNotFoundError,
    MediaAssetMissingError,
    resolveMediaAsset: async (id) => {
      const row = db.prepare('SELECT mime_type, status FROM media_assets WHERE id = ?').get(id);
      if (!row) throw new MediaAssetNotFoundError(id);
      if (row.status === 'missing') throw new MediaAssetMissingError(id);
      if (resolveHook) await resolveHook(id);
      return { asset: { id, mimeType: row.mime_type }, localUri: `file:///${id}` };
    },
  },
};
const cache = new Map();
function load(relativePath) {
  const absolute = path.isAbsolute(relativePath) ? relativePath : path.join(ROOT, relativePath);
  if (cache.has(absolute)) return cache.get(absolute);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolute,
    reportDiagnostics: true,
  });
  assert.deepEqual(
    (compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error),
    [],
    `${relativePath} 无法编译`,
  );
  const module = { exports: {} };
  cache.set(absolute, module.exports);
  const requireMock = (specifier) => {
    if (!specifier.startsWith('.')) {
      assert.ok(Object.hasOwn(mocks, specifier), `${relativePath} 存在未声明依赖：${specifier}`);
      return mocks[specifier];
    }
    const base = path.resolve(path.dirname(absolute), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (fs.existsSync(candidate)) return load(candidate);
    }
    throw new Error(`无法解析 ${specifier}`);
  };
  new Function('exports', 'require', 'module', compiled.outputText)(module.exports, requireMock, module);
  cache.set(absolute, module.exports);
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

const momentsSchema = load('src/platform/persistence/sqlite/momentsSchema.ts');
const mediaSchema = load('src/platform/persistence/sqlite/mediaAssetSchema.ts');
const repositoryModule = load('src/features/moments/infrastructure/SQLiteMomentRepository.ts');
const runtimeModule = load('src/features/moments/application/MomentMediaRuntime.ts');
const settingsModule = load('src/features/moments/application/MomentSettings.ts');
const analysisModule = load('src/features/moments/application/MomentMediaAnalysis.ts');
const publishModule = load('src/features/moments/application/CreateUserMomentWithMedia.ts');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
  ${mediaSchema.MEDIA_ASSET_SCHEMA}
  ${momentsSchema.MOMENTS_SCHEMA}
  ${momentsSchema.MOMENT_AUDIENCE_AI_SCHEMA}
  ${momentsSchema.MOMENT_COMMENTS_SCHEMA}
  ${momentsSchema.MOMENT_LIKES_SCHEMA}
  ${momentsSchema.MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA}
  ${momentsSchema.MOMENT_MEDIA_SCHEMA}
  ${momentsSchema.MOMENT_SETTINGS_SCHEMA}
  ${momentsSchema.MOMENT_MEDIA_INDEXES.join('\n')}
`);
currentExecutor = executorFor(db);
const repository = new repositoryModule.SQLiteMomentRepository();

const configs = new Map([
  ['model-a', { id: 'model-a', capabilityKind: 'ocr', name: '视觉 A', enabled: true, baseUrl: 'https://example.test', apiKey: 'test', model: 'vision-a', temperature: null, topP: null, maxTokens: null }],
  ['model-b', { id: 'model-b', capabilityKind: 'ocr', name: '视觉 B', enabled: true, baseUrl: 'https://example.test', apiKey: 'test', model: 'vision-b', temperature: null, topP: null, maxTokens: null }],
]);
let executorCalls = 0;
let analysisBehavior = async () => '桌上放着一杯咖啡';
let preparedSerial = 0;
let lastBatch = null;
/** 测试钩子：在 backing 准备完成、command 尚未开始事务的瞬间注入外部取消。 */
let prepareHook = null;

function asset(id, index) {
  const now = '2026-09-21T00:00:00.000Z';
  return {
    id,
    storageBackend: 'persistent-image',
    storageKey: `moments/${id}.jpg`,
    hashAlgorithm: 'sha256',
    contentHash: String(index + 1).padStart(64, '0'),
    mimeType: 'image/jpeg', byteSize: 12, width: 100, height: 100, durationMs: null,
    status: 'ready', createdAt: now, updatedAt: now,
  };
}

async function prepareMedia(inputs) {
  const serial = ++preparedSerial;
  const assets = inputs.map((_, index) => asset(`media-${serial}-${index}`, index));
  const calls = { commit: 0, finalize: 0, discard: 0, discardAfterRollback: 0 };
  lastBatch = calls;
  if (prepareHook) await prepareHook();
  return {
    async commitInTransaction(transaction) {
      calls.commit += 1;
      for (const item of assets) {
        await transaction.runAsync(
          `INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.storageBackend, item.storageKey, item.hashAlgorithm, item.contentHash,
            item.mimeType, item.byteSize, item.width, item.height, item.durationMs, item.status,
            item.createdAt, item.updatedAt],
        );
      }
      return { entries: assets.map((item) => ({ asset: item, reused: false })), assets };
    },
    async finalizeAfterCommit() { calls.finalize += 1; },
    async discard() { calls.discard += 1; },
    async discardAfterRollback() { calls.discardAfterRollback += 1; },
  };
}

runtimeModule.configureMomentMediaRuntime({
  repository,
  database: currentExecutor,
  prepareMedia,
  auxiliaryModels: {
    getById: async (id) => configs.get(id) ?? null,
    listOcr: async () => [...configs.values()],
  },
  executeImageAnalysis: async (request) => { executorCalls += 1; return analysisBehavior(request); },
  now: () => new Date().toISOString(),
});
const directory = { listAgentIds: async () => [] };
const drafts = [0, 1].map((index) => ({
  uri: `file:///picked-${index}.jpg`, fileName: `picked-${index}.jpg`, mimeType: 'image/jpeg',
  width: 100, height: 100,
}));

// abort 泄漏回归：backing 已在 prepareMedia 中创建、事务尚未开始时被取消，command 必须
// 自己清理 prepared batch；否则会留下没有任何 catalog / 业务引用指向的 orphan backing。
const abortController = new AbortController();
prepareHook = async () => { abortController.abort(); };
await assert.rejects(
  publishModule.createUserMomentWithMedia(directory, {
    content: '取消发布',
    media: [drafts[0]],
    abortSignal: abortController.signal,
  }),
  (error) => {
    assert.ok(
      error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)),
      `abort 必须以项目标准 abort error 抛出，实际为 ${error?.name}: ${error?.message}`,
    );
    return true;
  },
);
prepareHook = null;
assert.equal(lastBatch.commit, 0, 'abort 必须发生在 catalog 事务开始之前');
assert.equal(lastBatch.discard, 1, 'prepare 返回后未提交的 abort 必须 discard prepared batch');
assert.equal(lastBatch.discardAfterRollback, 0, '事务从未 staged，不得按回滚语义清理');
assert.equal(lastBatch.finalize, 0, 'abort 路径不得执行提交后 finalize');
for (const table of ['moments', 'moment_media', 'moment_social_inbox_deliveries', 'media_assets']) {
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `abort 路径不得留下 ${table} 事实`);
}

// MediaAsset catalog 与 Moment 全部事实必须共享 rollback。
db.exec(`CREATE TRIGGER fail_second_moment_media BEFORE INSERT ON moment_media
  WHEN NEW.sort_order = 1 BEGIN SELECT RAISE(ABORT, 'injected moment_media failure'); END;`);
await assert.rejects(
  publishModule.createUserMomentWithMedia(directory, { content: '事务失败', media: drafts }),
  /injected moment_media failure/,
);
assert.equal(lastBatch.discardAfterRollback, 1, 'staged batch 失败必须执行 discardAfterRollback');
for (const table of ['moments', 'moment_audience_ai', 'moment_media', 'moment_social_inbox_deliveries', 'media_assets']) {
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} 必须随事务回滚`);
}
db.exec('DROP TRIGGER fail_second_moment_media;');

// 初次成功：Moment 先提交，随后顺序 one-shot 写入 completed/model。
await settingsModule.setMomentImageAnalysisModel('model-a');
const published = await publishModule.createUserMomentWithMedia(directory, { content: '两张图', media: drafts });
assert.equal(lastBatch.finalize, 1, '成功事务必须执行 finalizeAfterCommit');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moments').get().count, 1);
for (let attempt = 0; attempt < 20; attempt += 1) {
  const pending = db.prepare("SELECT COUNT(*) AS count FROM moment_media WHERE analysis_status = 'pending'").get().count;
  if (pending === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(executorCalls, 2, '自动分析必须逐图各调用一次');
assert.deepEqual(
  db.prepare('SELECT analysis_status, analysis_source, analysis_model_config_id FROM moment_media ORDER BY sort_order').all().map((row) => ({ ...row })),
  [
    { analysis_status: 'completed', analysis_source: 'model', analysis_model_config_id: 'model-a' },
    { analysis_status: 'completed', analysis_source: 'model', analysis_model_config_id: 'model-a' },
  ],
);

// post-commit best-effort 分析连启动都失败（listMedia 读取失败）时：Moment 已提交的事实
// 保持成立，不得被重新解释成发布失败，也不得变成 unhandled rejection。
const floatingRejections = [];
const onUnhandledRejection = (reason) => floatingRejections.push(reason);
process.on('unhandledRejection', onUnhandledRejection);
const originalListMedia = repository.listMedia;
repository.listMedia = async () => { throw new Error('listMedia unavailable'); };
const analysisStartFailure = await publishModule.createUserMomentWithMedia(directory, {
  content: '分析未能启动也要发布成功',
  media: [drafts[0]],
});
repository.listMedia = originalListMedia;
for (let attempt = 0; attempt < 5; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
process.off('unhandledRejection', onUnhandledRejection);
assert.ok(
  db.prepare('SELECT id FROM moments WHERE id = ?').get(analysisStartFailure.id),
  '分析未能启动不得撤销已提交 Moment',
);
assert.deepEqual(
  db.prepare('SELECT analysis_status FROM moment_media WHERE moment_id = ?').all(analysisStartFailure.id).map((row) => row.analysis_status),
  ['pending'],
  '分析未能启动时不得伪造失败状态',
);
assert.deepEqual(floatingRejections, [], 'post-commit 分析启动失败不得成为 unhandled rejection');

const first = await repository.listMedia(published.id).then((items) => items[0]);
// 模型切换只写 binding，不执行历史重跑。
const callsBeforeSwitch = executorCalls;
await settingsModule.setMomentImageAnalysisModel('model-b');
assert.equal(executorCalls, callsBeforeSwitch, '切换模型不得触发历史图片分析');

// 已成功图片也允许用户显式重新识别，并用当前模型替换旧 snapshot。
analysisBehavior = async () => '重新识别：窗边的一杯咖啡';
const successfulReanalysis = await analysisModule.reanalyzeMomentMedia(first.id);
assert.equal(successfulReanalysis.success, true);
const afterSuccessfulReanalysis = await repository.getMedia(first.id);
assert.equal(afterSuccessfulReanalysis.analysisText, '重新识别：窗边的一杯咖啡');
assert.equal(afterSuccessfulReanalysis.analysisModelConfigId, 'model-b');

const originalGetSettings = repository.getSettings;
let settingReads = 0;
repository.getSettings = async (...args) => {
  settingReads += 1;
  return originalGetSettings.call(repository, ...args);
};
try {
  await analysisModule.reanalyzeMomentMedia(first.id);
  assert.equal(settingReads, 1, '一次图片分析只读取一次设置快照');
} finally {
  repository.getSettings = originalGetSettings;
}

// 保存成功结果的数据库异常不能改写成模型失败，也不能覆盖已有可靠描述。
const beforeDbFailure = await repository.getMedia(first.id);
const originalSaveModelAnalysis = repository.saveModelAnalysis;
const dbFailure = new Error('模拟 SQLite 写入失败');
repository.saveModelAnalysis = async () => { throw dbFailure; };
try {
  await assert.rejects(analysisModule.reanalyzeMomentMedia(first.id), error => error === dbFailure);
  assert.deepEqual(await repository.getMedia(first.id), beforeDbFailure, '数据库异常不得污染已有分析快照');
} finally {
  repository.saveModelAnalysis = originalSaveModelAnalysis;
}

// retry 失败时保留旧成功 snapshot。
const beforeFailure = await repository.getMedia(first.id);
analysisBehavior = async () => { throw new Error('provider failure body must not persist'); };
const retryFailure = await analysisModule.reanalyzeMomentMedia(first.id);
assert.equal(retryFailure.success, false);
assert.deepEqual(await repository.getMedia(first.id), beforeFailure, '已有成功描述不得被一次 retry 失败降级');

// 用户编辑与在途模型请求竞态：旧 response 必须因 revision CAS 成为 stale no-op。
let resolveDeferred;
analysisBehavior = () => new Promise((resolve) => { resolveDeferred = resolve; });
const inFlight = analysisModule.reanalyzeMomentMedia(first.id);
while (!resolveDeferred) await new Promise((resolve) => setTimeout(resolve, 0));
await analysisModule.editMomentMediaAnalysis(first.id, '用户确认：窗边的一杯咖啡');
resolveDeferred('旧模型返回的描述');
const stale = await inFlight;
assert.equal(stale.errorCode, 'stale_analysis_attempt');
const afterEdit = await repository.getMedia(first.id);
assert.equal(afterEdit.analysisText, '用户确认：窗边的一杯咖啡');
assert.equal(afterEdit.analysisSource, 'user');
assert.equal(afterEdit.analysisModelConfigId, null);

// no-model / unavailable 失败在保护条件下没有写入任何事实时：不得伪造 state update，
// 也不得把这次 retry 的真实失败码改写成 stale。
await settingsModule.setMomentImageAnalysisModel(null);
let updateEvents = 0;
const unsubscribeAnalysis = analysisModule.subscribeMomentMediaAnalysisUpdated(() => { updateEvents += 1; });
const noModelRetryFailure = await analysisModule.reanalyzeMomentMedia(first.id);
unsubscribeAnalysis();
assert.equal(noModelRetryFailure.success, false);
assert.equal(noModelRetryFailure.errorCode, 'model_not_configured', 'retry 必须返回真实失败码而不是 stale');
assert.equal(updateEvents, 0, '未写入任何事实时不得广播 state update');
assert.deepEqual(await repository.getMedia(first.id), afterEdit, '已有成功描述继续保持有效');

// 没有模型时失败只影响 analysis，Moment 与图片引用继续存在。
await settingsModule.setMomentImageAnalysisModel(null);
const noModelMoment = await publishModule.createUserMomentWithMedia(directory, { content: '无模型也发布', media: [drafts[0]] });
for (let attempt = 0; attempt < 20; attempt += 1) {
  const row = db.prepare('SELECT analysis_status FROM moment_media WHERE moment_id = ?').get(noModelMoment.id);
  if (row?.analysis_status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(db.prepare('SELECT analysis_error_code FROM moment_media WHERE moment_id = ?').get(noModelMoment.id).analysis_error_code, 'model_not_configured');
assert.ok(db.prepare('SELECT id FROM moments WHERE id = ?').get(noModelMoment.id));

// failed 图片可由用户手动重试成功；使用的是当前 Moments binding。
await settingsModule.setMomentImageAnalysisModel('model-b');
analysisBehavior = async () => '雨夜街道上有一盏路灯';
const failedMedia = await repository.listMedia(noModelMoment.id).then((items) => items[0]);
assert.equal((await analysisModule.reanalyzeMomentMedia(failedMedia.id)).success, true);
const retried = await repository.getMedia(failedMedia.id);
assert.equal(retried.analysisStatus, 'completed');
assert.equal(retried.analysisModelConfigId, 'model-b');

// 未分类内部异常不作为接口原文持久化，也不能撤销 Moment。
analysisBehavior = async () => { throw new Error('secret provider response'); };
const failedMoment = await publishModule.createUserMomentWithMedia(directory, { content: '首次失败', media: [drafts[0]] });
for (let attempt = 0; attempt < 20; attempt += 1) {
  const row = db.prepare('SELECT analysis_status FROM moment_media WHERE moment_id = ?').get(failedMoment.id);
  if (row?.analysis_status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const initialFailure = db.prepare('SELECT analysis_error_code, analysis_text FROM moment_media WHERE moment_id = ?').get(failedMoment.id);
assert.deepEqual({ ...initialFailure }, { analysis_error_code: 'model_request_failed', analysis_text: null });
assert.ok(db.prepare('SELECT id FROM moments WHERE id = ?').get(failedMoment.id));

// 客户端已脱敏的模型失败随状态保存，重新打开图片仍能查看，成功或手动编辑清除旧原因。
const { MomentImageAnalysisError } = load('src/features/moments/domain/MomentImageAnalysis.ts');
const providerReason = 'HTTP 400: unsupported multipart type for this model, only support text and audio';
analysisBehavior = async () => { throw new MomentImageAnalysisError('model_request_failed', providerReason); };
const failedItem = (await repository.listMedia(failedMoment.id))[0];
const failedRetry = await analysisModule.reanalyzeMomentMedia(failedItem.id);
assert.equal(failedRetry.errorMessage, providerReason);
assert.equal((await repository.getMedia(failedItem.id)).analysisErrorMessage, providerReason);
const snapshotBeforeRetry = await repository.getMedia(first.id);
const protectedFailure = await analysisModule.reanalyzeMomentMedia(first.id);
assert.equal(protectedFailure.errorMessage, providerReason, '已有描述时也返回本次失败的具体原因');
assert.deepEqual(await repository.getMedia(first.id), snapshotBeforeRetry, '失败不覆盖可靠描述或 revision');
analysisBehavior = async () => '成功识别';
assert.equal((await analysisModule.reanalyzeMomentMedia(failedItem.id)).success, true);
assert.equal((await repository.getMedia(failedItem.id)).analysisErrorMessage, null);
await analysisModule.editMomentMediaAnalysis(failedItem.id, '用户编辑');
assert.equal((await repository.getMedia(failedItem.id)).analysisErrorMessage, null);

// Detail snapshot 必须按 sort_order 带出已保存 media 语义。
const detail = await repository.captureMomentDetailForAgent('agent-reader', published.id);
assert.deepEqual(detail.media.map((item) => item.sortOrder), [0, 1]);
assert.equal(detail.media[0].analysisText, '用户确认：窗边的一杯咖啡');

// AI 从已有媒体 ID 发布图片，复用同一真实 SQLite、ACL 和提交后识别链路。
const createTool = load('src/features/moments/aiTools/AICreateMomentTool.ts');
const createModule = load('src/features/moments/application/CreateMoment.ts');
const context = {
  getAgentId: () => 'agent-author', getAIName: () => 'author', isBlocked: () => false,
  repositories: { moment: repository }, sharedState: {}, aiConfig: {},
};
const schema = createTool.definition.parameters;
assert.equal(schema.required.includes('mediaAssetIds'), false, '图片参数可选');
assert.equal(schema.properties.mediaAssetIds.maxItems, 9);
assert.equal(schema.properties.mediaAssetIds.uniqueItems, true);
const validateCreateInput = new Ajv2020({ strict: false }).compile(schema);
for (const ids of [null, 'not-an-array', [''], [3], [['nested']], Array(10).fill('id'), ['id', 'id']]) {
  assert.equal(validateCreateInput({ content: '参数校验', mediaAssetIds: ids }), false, '工具 schema 在模型边界拒绝无效形状、数量和重复 ID');
}
for (const assistant of assistants) {
  db.prepare('INSERT INTO ai_assistants VALUES (?, ?, ?)').run(assistant.agentId, assistant.agentId, assistant.name);
}
const assetIds = (await repository.listMedia(published.id)).map((media) => media.mediaAssetId);
const catalogCount = () => db.prepare('SELECT COUNT(*) AS count FROM media_assets').get().count;
const catalogBefore = catalogCount();
const preparationsBefore = preparedSerial;
const callsBeforeAgentPublish = executorCalls;
const result = await createTool.execute({
  content: '复用图片发布', mediaAssetIds: [` ${assetIds[1]} `, assetIds[0]],
  audience: { mode: 'selected', agentIds: ['agent-reader'] },
  agentId: 'agent-hidden',
}, context);
assert.equal(result.success, true);
const agentMomentId = result.data.momentId;
const agentMoment = await repository.getMomentForUser(agentMomentId);
assert.equal(agentMoment.authorType, 'ai');
assert.equal(agentMoment.authorId, 'agent-author', '作者只取可信上下文');
assert.equal(agentMoment.content, '复用图片发布');
assert.equal(await repository.captureMomentDetailForAgent('agent-hidden', agentMomentId), null);
assert.deepEqual(
  db.prepare('SELECT recipient_agent_id FROM moment_social_inbox_deliveries WHERE source_moment_id = ?').all(agentMomentId).map((row) => row.recipient_agent_id),
  ['agent-reader'],
);
assert.deepEqual((await repository.listMedia(agentMomentId)).map((item) => item.mediaAssetId), [assetIds[1], assetIds[0]]);
assert.deepEqual(
  (await repository.listMomentTimelineForUser()).find((item) => item.id === agentMomentId).media.map((item) => item.mediaAssetId),
  [assetIds[1], assetIds[0]], '时间线直接消费已有图片引用',
);
for (let attempt = 0; attempt < 20; attempt += 1) {
  if ((await repository.listMedia(agentMomentId)).every((item) => item.analysisStatus === 'completed')) break;
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(executorCalls - callsBeforeAgentPublish, 2, 'AI 发布后每张图片识别一次');
assert.ok((await repository.captureMomentDetailForAgent('agent-reader', agentMomentId)).media.every((item) => item.analysisText === '成功识别'));
assert.equal(catalogCount(), catalogBefore, '复用已有资产不创建新 catalog');
assert.equal(preparedSerial, preparationsBefore, '复用已有资产不复制文件');

// 用户可校正 AI 发布的图片，复用同一重识别、手动编辑和旧结果隔离语义。
const agentMedia = (await repository.listMedia(agentMomentId))[0];
analysisBehavior = async () => '重新识别 AI 发布的图片';
assert.equal((await analysisModule.reanalyzeMomentMedia(agentMedia.id)).success, true);
assert.equal((await repository.getMedia(agentMedia.id)).analysisText, '重新识别 AI 发布的图片');
let finishAgentAnalysis;
analysisBehavior = () => new Promise((resolve) => { finishAgentAnalysis = resolve; });
const agentAnalysisInFlight = analysisModule.reanalyzeMomentMedia(agentMedia.id);
while (!finishAgentAnalysis) await new Promise((resolve) => setTimeout(resolve, 0));
await analysisModule.editMomentMediaAnalysis(agentMedia.id, '用户校正 AI 图片的描述');
finishAgentAnalysis('过期的模型描述');
assert.equal((await agentAnalysisInFlight).errorCode, 'stale_analysis_attempt');
const agentEdited = await repository.getMedia(agentMedia.id);
assert.equal(agentEdited.analysisSource, 'user');
assert.equal(agentEdited.analysisText, '用户校正 AI 图片的描述');
assert.equal(agentEdited.analysisModelConfigId, null);
assert.equal((await repository.captureMomentDetailForAgent('agent-reader', agentMomentId)).media[0].analysisText, '用户校正 AI 图片的描述');
await assert.rejects(analysisModule.reanalyzeMomentMedia('absent-media'), (error) => error.code === 'media_not_found');
await assert.rejects(analysisModule.editMomentMediaAnalysis('absent-media', '描述'), (error) => error.code === 'media_not_found');

for (const extra of [{}, { mediaAssetIds: [] }]) {
  const textOnly = await createTool.execute({ content: '纯文字', ...extra }, context);
  assert.equal(textOnly.success, true);
  assert.deepEqual(await repository.listMedia(textOnly.data.momentId), []);
}

function factCounts() {
  return ['moments', 'moment_audience_ai', 'moment_media', 'moment_social_inbox_deliveries', 'media_assets']
    .map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}
for (const ids of [[' '], [assetIds[0], ` ${assetIds[0]} `], Array(10).fill(assetIds[0]), ['absent-id'], ['https://example.test/image.jpg']]) {
  const before = factCounts();
  const invalid = await createTool.execute({ content: '无效图片', mediaAssetIds: ids }, context);
  assert.equal(invalid.success, false, `拒绝无效图片参数 ${JSON.stringify(ids)}`);
  assert.deepEqual(factCounts(), before, '无效图片不得留下部分发布事实');
}
for (const [id, mimeType, status] of [['audio-id', 'audio/mpeg', 'ready'], ['missing-id', 'image/png', 'missing']]) {
  const item = asset(id, 99);
  db.prepare('INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    item.id, item.storageBackend, item.storageKey, item.hashAlgorithm, item.contentHash,
    mimeType, item.byteSize, item.width, item.height, item.durationMs, status, item.createdAt, item.updatedAt,
  );
  const before = factCounts();
  const invalid = await createTool.execute({ content: '不可用的图片', mediaAssetIds: [assetIds[0], id] }, context);
  assert.equal(invalid.success, false);
  assert.deepEqual(factCounts(), before, '后续图片无效也不得先提交前面的图片或正文');
}

// 事务中图片写入失败，正文、可见范围和 Inbox 一并回滚。
db.exec(`CREATE TRIGGER fail_agent_media BEFORE INSERT ON moment_media
  WHEN NEW.sort_order = 1 BEGIN SELECT RAISE(ABORT, 'agent media failure'); END;`);
const beforeRollback = factCounts();
await assert.rejects(createModule.createAgentMoment(repository, {
  listAgentIds: async () => assistants.map((item) => item.agentId),
}, {
  agentId: 'agent-author', nameSnapshot: 'author', content: '回滚图文', mediaAssetIds: assetIds,
  audience: { mode: 'selected', viewerAgentIds: ['agent-reader'] },
}), /agent media failure/);
assert.deepEqual(factCounts(), beforeRollback);
db.exec('DROP TRIGGER fail_agent_media;');

// 解析图片期间取消不能留下事实，也不能被工具转成普通发布失败。
const imageAbort = new AbortController();
resolveHook = async () => imageAbort.abort();
const beforeAbort = factCounts();
await assert.rejects(createTool.execute({ content: '取消图文', mediaAssetIds: assetIds }, {
  ...context, abortSignal: imageAbort.signal,
}), (error) => error.name === 'AbortError');
resolveHook = null;
assert.deepEqual(factCounts(), beforeAbort);

// 数量上限可以真实发布；识别失败只影响语义，不影响图片和发布结果。
const nineIds = [...assetIds];
for (let index = 0; index < 7; index += 1) {
  const item = asset(`nine-${index}`, index + 20);
  db.prepare('INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    item.id, item.storageBackend, item.storageKey, item.hashAlgorithm, item.contentHash,
    item.mimeType, item.byteSize, item.width, item.height, item.durationMs, item.status, item.createdAt, item.updatedAt,
  );
  nineIds.push(item.id);
}
await settingsModule.setMomentImageAnalysisModel(null);
const nineResult = await createTool.execute({ content: '九张图片', mediaAssetIds: nineIds }, context);
assert.equal(nineResult.success, true);
assert.deepEqual((await repository.listMedia(nineResult.data.momentId)).map((item) => item.mediaAssetId), nineIds);
for (let attempt = 0; attempt < 20; attempt += 1) {
  if ((await repository.listMedia(nineResult.data.momentId)).every((item) => item.analysisStatus === 'failed')) break;
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.ok((await repository.listMedia(nineResult.data.momentId)).every((item) => item.analysisErrorCode === 'model_not_configured'));
assert.ok(await repository.getMomentForUser(nineResult.data.momentId), '识别失败后图文动态仍然存在');

// 原用户动态撤销后，AI 的图片引用和原资产继续存在。
const beforeSharedDeletion = catalogCount();
await repository.deleteMoment(published.id);
assert.deepEqual((await repository.listMedia(agentMomentId)).map((item) => item.mediaAssetId), [assetIds[1], assetIds[0]]);
assert.equal(catalogCount(), beforeSharedDeletion);

// 封面不进入 moment_settings，删除不直接操作 MediaAsset catalog。
assert.doesNotMatch(momentsSchema.MOMENT_SETTINGS_SCHEMA, /cover/i);
assert.doesNotMatch(read('src/features/moments/infrastructure/SQLiteMomentRepository.ts'), /DELETE\s+FROM\s+media_assets/i);
const publishView = read('src/features/moments/presentation/PublishView.tsx');
assert.match(publishView, /allowsMultipleSelection:\s*true/);
assert.match(publishView, /selectionLimit/);
assert.match(read('src/features/moments/presentation/MomentItem.tsx'), /MomentMediaViewerModal/);
assert.match(read('src/features/moments/presentation/MomentsSettingsView.tsx'), /图片理解模型/);
assert.match(read('src/features/moments/presentation/useMomentsCover.ts'), /updateCurrentUserMomentsCover/);
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

console.log('Moments V2 M5 media / settings / analysis / CAS 验证通过。');
