/**
 * Moments V2 M6：地点、audience selector、keyset Timeline 与 UI 契约验证。
 *
 * 验证范围（对应 M6 完成标准）：
 * - migration93 数据保留型增加 location_label 与 Timeline keyset 排序索引；
 * - 旧 V2 DB（无论是否已经跑过 migration90）都能升级到当前代码；
 * - location 归一化 / 写入 / 读取 / detail 输出语义；
 * - Timeline keyset 分页：同 timestamp 稳定排序、顶部插入不重复不跳过、cursor 行被删仍可翻页；
 * - AI ACL 与 cursor 同时作用在 SQL 上；
 * - AI authored Moment 在用户 Timeline 的展示身份；
 * - audience selector 纯投影（stable agentId 身份、canonical 归一化）；
 * - reply / delete UI 的真实 async 契约；
 * - active UI 产品名与 Prompt recent Moments 文案。
 *
 * 真实执行路径：递归 transpile loader 装载生产模块（schema / repository / application /
 * aiTools / presentationFacade / presentation 纯函数），只 mock 跨 Feature 的 profile 与
 * assistant 目录，SQLite 用 node:sqlite 内存库。不锁定实现细节，只断言外部可观察行为。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const identity = {
  profile: { id: 'self', name: '用户甲', avatar: null, momentsCover: null },
  assistants: [
    { id: 'ai-b', agentId: 'agent-b', name: 'AI乙', avatar: 'asset://b' },
    { id: 'ai-c', agentId: 'agent-c', name: 'AI丙', avatar: 'asset://c' },
  ],
};

let currentExecutor = null;

const mocks = {
  '@platform/persistence': {
    databaseCoordinator: { openTaskExecutor: () => currentExecutor },
  },
  '@features/profile': {
    getCurrentUserProfile: async () => identity.profile,
    SELF_USER_PROFILE_ID: 'self',
  },
  '@features/assistants': {
    listAIAssistants: async () => identity.assistants,
    getAssistantDisplayName: (assistant) => assistant.name,
  },
  '@features/media': {
    releaseMediaAssetCandidates: async () => undefined,
    MEDIA_ASSET_STORAGE_BACKEND: { persistentImage: 'persistent-image' },
    resolveMediaAsset: async (mediaAssetId) => ({
      asset: { id: mediaAssetId },
      localUri: `asset://${mediaAssetId}`,
    }),
  },
};

const moduleCache = new Map();

function load(relativePath) {
  const absolutePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(ROOT, relativePath);
  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath);

  const compiled = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
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
  moduleCache.set(absolutePath, module.exports);
  const requireMock = (specifier) => {
    if (!specifier.startsWith('.')) {
      assert.ok(
        Object.hasOwn(mocks, specifier),
        `${relativePath} 存在未声明的运行时依赖：${specifier}`,
      );
      return mocks[specifier];
    }
    const base = path.resolve(path.dirname(absolutePath), specifier);
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (fs.existsSync(candidate)) return load(candidate);
    }
    throw new Error(`无法解析 ${specifier}（来自 ${relativePath}）`);
  };
  new Function('exports', 'require', 'module', compiled.outputText)(
    module.exports,
    requireMock,
    module,
  );
  moduleCache.set(absolutePath, module.exports);
  return module.exports;
}

mocks['@shared/runtime/abortSignal'] = load('src/shared/runtime/abortSignal.ts');
mocks['@shared/runtime/RuntimeSlot'] = load('src/shared/runtime/RuntimeSlot.ts');

function createExecutor(db) {
  const executor = {
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    execAsync: async (sql) => {
      db.exec(sql);
    },
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

const momentsSchemaModule = load('src/platform/persistence/sqlite/momentsSchema.ts');
const mediaSchemaModule = load('src/platform/persistence/sqlite/mediaAssetSchema.ts');
const repositoryModule = load('src/features/moments/infrastructure/SQLiteMomentRepository.ts');
const createMomentModule = load('src/features/moments/application/CreateMoment.ts');
const locationModule = load('src/features/moments/domain/MomentLocation.ts');
const facadeModule = load('src/features/moments/presentationFacade.ts');
const audienceDraftModule = load('src/features/moments/presentation/MomentAudienceDraft.ts');
const feedbackModule = load('src/features/moments/presentation/momentActionFeedback.ts');
const uiPermissions = load('src/features/moments/presentation/momentItem/permissions.ts');
const createTool = load('src/features/moments/aiTools/AICreateMomentTool.ts');
const detailTool = load('src/features/moments/aiTools/GetMomentDetailTool.ts');
const searchTool = load('src/features/moments/aiTools/SearchMomentsTool.ts');
const errorsModule = load('src/features/moments/domain/MomentErrors.ts');

function installMomentSchema(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);`);
  // moment_media 的外键指向 media_assets：级联删除需要该表存在，因此一并建好。
  db.exec(mediaSchemaModule.MEDIA_ASSET_SCHEMA);
  db.exec(momentsSchemaModule.MOMENTS_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_AUDIENCE_AI_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_COMMENTS_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_LIKES_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_MEDIA_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_SETTINGS_SCHEMA);
  for (const index of [
    momentsSchemaModule.MOMENTS_CREATED_ID_INDEX,
    ...momentsSchemaModule.MOMENT_SOCIAL_INBOX_INDEXES,
    ...momentsSchemaModule.MOMENT_MEDIA_INDEXES,
  ]) {
    db.exec(index);
  }
}

// ── 1. fresh schema 必须自带 location_label 与 keyset 排序索引 ────────────

const freshDb = new DatabaseSync(':memory:');
installMomentSchema(freshDb);

assert.deepEqual(
  freshDb.prepare(`PRAGMA table_info('moments')`).all().map((row) => row.name),
  [
    'id', 'author_type', 'author_id', 'author_name_snapshot',
    'content', 'location_label', 'audience_mode', 'created_at',
  ],
  'fresh moments schema 必须包含 nullable location_label',
);
assert.equal(
  freshDb.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('moments') WHERE name = 'location_label' AND "notnull" = 0`).get().count,
  1,
  'location_label 必须是 nullable',
);
assert.match(
  String(freshDb.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_moments_created_id'`,
  ).get().sql),
  /created_at DESC, id DESC/,
  'fresh schema 必须登记 (created_at DESC, id DESC) 复合索引',
);

// ── 2. migration93：数据保留 + 幂等 ─────────────────────────────────────

/**
 * 造一个「已经跑过 migration90、但还没有 migration93」的真实旧库：
 * moments 表带 all_except 但没有 location_label，且已有完整业务事实。
 */
function createLegacyV2Db() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);`);
  db.exec(`INSERT INTO ai_assistants (id, agent_id, name) VALUES ('ai-b', 'agent-b', 'AI乙');`);
  const legacySchema = momentsSchemaModule.MOMENTS_SCHEMA.replace('    location_label TEXT,\n', '');
  assert.notEqual(
    legacySchema,
    momentsSchemaModule.MOMENTS_SCHEMA,
    '本用例必须真的构造出没有 location_label 的旧 V2 表',
  );
  db.exec(legacySchema);
  db.exec(momentsSchemaModule.MOMENT_AUDIENCE_AI_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_COMMENTS_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_LIKES_SCHEMA);
  db.exec(`CREATE INDEX idx_moments_created_at ON moments(created_at DESC);`);
  db.exec(`
    INSERT INTO moments (id, author_type, author_id, author_name_snapshot, content, audience_mode, created_at)
    VALUES
      ('legacy-1', 'user', 'self', '用户甲', '历史正文 1', 'all', '2026-09-01T00:00:00.000Z'),
      ('legacy-2', 'user', 'self', '用户甲', '历史正文 2', 'selected', '2026-09-01T00:00:01.000Z'),
      ('legacy-3', 'user', 'self', '用户甲', '历史正文 3', 'all_except', '2026-09-01T00:00:02.000Z');
    INSERT INTO moment_audience_ai (moment_id, viewer_agent_id) VALUES ('legacy-2', 'agent-b');
    INSERT INTO moment_comments VALUES
      ('legacy-comment', 'legacy-1', 'ai', 'agent-b', 'AI乙', NULL, '历史评论', '2026-09-01T00:00:03.000Z');
    INSERT INTO moment_likes VALUES
      ('legacy-1', 'ai', 'agent-b', 'AI乙', '2026-09-01T00:00:04.000Z');
  `);
  return db;
}

{
  const db = createLegacyV2Db();
  const before = {
    moments: db.prepare('SELECT COUNT(*) AS count FROM moments').get().count,
    audience: db.prepare('SELECT COUNT(*) AS count FROM moment_audience_ai').get().count,
    comments: db.prepare('SELECT COUNT(*) AS count FROM moment_comments').get().count,
    likes: db.prepare('SELECT COUNT(*) AS count FROM moment_likes').get().count,
  };
  const executor = createExecutor(db);
  await momentsSchemaModule.migrateMomentLocationLabel(executor);

  assert.deepEqual(
    db.prepare(`PRAGMA table_info('moments')`).all().map((row) => row.name).sort(),
    freshDb.prepare(`PRAGMA table_info('moments')`).all().map((row) => row.name).sort(),
    'migration93 必须得到与 fresh schema 完全相同的列集合',
  );
  assert.ok(
    db.prepare(`PRAGMA table_info('moments')`).all().some((row) => row.name === 'location_label'),
    'migration93 必须补上 location_label',
  );
  // ALTER TABLE ADD COLUMN 只会在末尾追加列，因此升级库与 fresh 库的物理列顺序不同：
  // 这是数据保留型迁移的必然结果，也正因如此所有读路径都必须显式列出列名。
  assert.equal(
    db.prepare(`PRAGMA table_info('moments')`).all().at(-1).name,
    'location_label',
    'ALTER 只在末尾追加 location_label',
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('moments') WHERE name = 'location_label' AND "notnull" = 0`).get().count,
    1,
    'migration93 追加的 location_label 必须 nullable',
  );
  assert.deepEqual(
    {
      moments: db.prepare('SELECT COUNT(*) AS count FROM moments').get().count,
      audience: db.prepare('SELECT COUNT(*) AS count FROM moment_audience_ai').get().count,
      comments: db.prepare('SELECT COUNT(*) AS count FROM moment_comments').get().count,
      likes: db.prepare('SELECT COUNT(*) AS count FROM moment_likes').get().count,
    },
    before,
    'migration93 不得丢失任何历史 Moment / audience / comment / like',
  );
  assert.deepEqual(
    db.prepare('SELECT id, content, location_label, audience_mode FROM moments ORDER BY id').all()
      .map((row) => ({ ...row })),
    [
      { id: 'legacy-1', content: '历史正文 1', location_label: null, audience_mode: 'all' },
      { id: 'legacy-2', content: '历史正文 2', location_label: null, audience_mode: 'selected' },
      { id: 'legacy-3', content: '历史正文 3', location_label: null, audience_mode: 'all_except' },
    ],
    '历史 Moment 的 location_label 必须保持 NULL，不回填也不猜测',
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'idx_moments_created_id'`).get().count,
    1,
    'migration93 必须创建 Timeline keyset 排序索引',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // 物理列顺序不是契约：仓储的两个读路径都必须显式列出列名，不得依赖 SELECT *。
  const runtimeSource = read('src/features/moments/infrastructure/SQLiteMomentRepository.ts');
  assert.doesNotMatch(
    runtimeSource,
    /SELECT \s+\*\s+FROM\s+moments/i,
    'Moment 读路径不得使用 SELECT *：升级库的物理列顺序与 fresh 不同',
  );

  // 幂等：重复执行不得报错，也不得重复加列或改变结构。
  const described = db.prepare(`PRAGMA table_info('moments')`).all().map((row) => row.name);
  await momentsSchemaModule.migrateMomentLocationLabel(executor);
  await momentsSchemaModule.migrateMomentLocationLabel(executor);
  assert.deepEqual(
    db.prepare(`PRAGMA table_info('moments')`).all().map((row) => row.name),
    described,
    'migration93 必须幂等：重复执行不改变 moments 结构',
  );
}

// ── 3. 尚未执行 migration90 的旧 V2 DB：90 + 93 连跑仍可用 ──────────────

{
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);`);
  db.exec(`INSERT INTO ai_assistants (id, agent_id, name) VALUES ('ai-b', 'agent-b', 'AI乙');`);
  // 旧 V2：CHECK 里没有 all_except，也没有 location_label。
  db.exec(`
    CREATE TABLE moments (
      id TEXT PRIMARY KEY,
      author_type TEXT NOT NULL CHECK (author_type IN ('user', 'ai')),
      author_id TEXT NOT NULL,
      author_name_snapshot TEXT NOT NULL,
      content TEXT NOT NULL,
      audience_mode TEXT NOT NULL DEFAULT 'all' CHECK (audience_mode IN ('all', 'selected')),
      created_at TEXT NOT NULL
    );
  `);
  db.exec(momentsSchemaModule.MOMENT_AUDIENCE_AI_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_COMMENTS_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_LIKES_SCHEMA);
  // 该库代表「已经跑过 migration91/92、但还没跑 90 和 93」的旧 V2 用户。
  db.exec(momentsSchemaModule.MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_MEDIA_SCHEMA);
  db.exec(momentsSchemaModule.MOMENT_SETTINGS_SCHEMA);
  db.exec(`
    INSERT INTO moments VALUES ('old-1', 'user', 'self', '用户甲', '旧 V2 正文', 'all', '2026-09-02T00:00:00.000Z');
    INSERT INTO moment_comments VALUES
      ('old-comment', 'old-1', 'ai', 'agent-b', 'AI乙', NULL, '旧 V2 评论', '2026-09-02T00:00:01.000Z');
  `);

  const executor = createExecutor(db);
  await momentsSchemaModule.migrateMomentsAudienceAllExcept(executor);
  await momentsSchemaModule.migrateMomentLocationLabel(executor);

  const allExceptColumn = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'moments'`,
  ).get().sql;
  assert.match(allExceptColumn, /'all_except'/, 'migration90 必须在 migration93 之前把 all_except 补进 CHECK');
  assert.ok(
    db.prepare(`PRAGMA table_info('moments')`).all().some((row) => row.name === 'location_label'),
    'migration90 之后 migration93 必须补齐 location_label',
  );
  assert.deepEqual(
    db.prepare('SELECT id, content, location_label FROM moments').all().map((row) => ({ ...row })),
    [{ id: 'old-1', content: '旧 V2 正文', location_label: null }],
    '旧 V2 → 当前代码：历史正文保留，地点为 NULL',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM moment_comments').get().count,
    1,
    'migration90 + 93 必须保留历史评论',
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'idx_moments_created_id'`).get().count,
    1,
    'migration93 必须在 migration90 重建后补上 keyset 排序索引',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // 升级后的库必须能被真实仓储读写。
  currentExecutor = createExecutor(db);
  const repository = new repositoryModule.SQLiteMomentRepository();
  const created = await createMomentModule.createUserMoment(
    repository,
    { listAgentIds: async () => ['agent-b'] },
    { content: '升级后新发布', locationLabel: '  升级后地点  ' },
  );
  assert.equal(created.locationLabel, '升级后地点');
  assert.equal((await repository.getMomentForUser(created.id)).locationLabel, '升级后地点');
}

// ── 4. 运行时库（真实仓储 + Application + Facade）──────────────────────

const db = new DatabaseSync(':memory:');
installMomentSchema(db);
db.exec(`INSERT INTO ai_assistants (id, agent_id, name) VALUES ('ai-b', 'agent-b', 'AI乙'), ('ai-c', 'agent-c', 'AI丙');`);
currentExecutor = createExecutor(db);
const repository = new repositoryModule.SQLiteMomentRepository();
const directory = { listAgentIds: async () => identity.assistants.map((item) => item.agentId) };

// 4.1 location 归一化只有一份规则。
assert.equal(locationModule.MAX_MOMENT_LOCATION_LABEL_LENGTH, 120);
for (const empty of [undefined, null, '', '   ', '\n\t ']) {
  assert.equal(
    locationModule.normalizeMomentLocationLabel(empty),
    null,
    `空地点输入 ${JSON.stringify(empty)} 必须归一化为 null`,
  );
}
assert.equal(locationModule.normalizeMomentLocationLabel('  学校图书馆  '), '学校图书馆');
assert.equal(
  locationModule.normalizeMomentLocationLabel('地'.repeat(120)),
  '地'.repeat(120),
  '正好 120 字符必须接受',
);
assert.throws(
  () => locationModule.normalizeMomentLocationLabel('地'.repeat(121)),
  (error) => {
    assert.ok(error instanceof errorsModule.MomentDomainError);
    assert.equal(error.code, 'invalid_location_label');
    return true;
  },
  '121 字符必须被拒绝，不得静默截断',
);

// 4.2 create：地点与正文同一次 create 提交；没有地点就是 NULL。
const withLocation = await createMomentModule.createUserMoment(
  repository,
  directory,
  { content: '今天天气真好', locationLabel: '  学校图书馆 ' },
);
const withoutLocation = await createMomentModule.createUserMoment(
  repository,
  directory,
  { content: '没有地点的时刻' },
);
assert.equal(withLocation.locationLabel, '学校图书馆');
assert.equal(withoutLocation.locationLabel, null);
assert.deepEqual(
  {
    withLocation: db.prepare('SELECT location_label FROM moments WHERE id = ?')
      .get(withLocation.id).location_label,
    withoutLocation: db.prepare('SELECT location_label FROM moments WHERE id = ?')
      .get(withoutLocation.id).location_label,
  },
  { withLocation: '学校图书馆', withoutLocation: null },
  'location 必须直接写进 Moment 行，不能先建后 UPDATE',
);

// 4.3 detail：有地点时输出地点行；没有地点时整行省略，不制造伪位置。
{
  const detailContext = {
    sharedState: {},
    getAgentId: () => 'agent-b',
    repositories: { moment: repository },
  };
  const withLocationDetail = await detailTool.execute({ momentId: withLocation.id }, detailContext);
  assert.equal(withLocationDetail.success, true);
  assert.match(withLocationDetail.message, /地点: 学校图书馆/, 'detail 必须输出地点行');
  assert.match(withLocationDetail.message, /内容: 今天天气真好/);
  assert.equal(withLocationDetail.data.moment.locationLabel, '学校图书馆');

  const withoutLocationDetail = await detailTool.execute({ momentId: withoutLocation.id }, detailContext);
  assert.equal(withoutLocationDetail.success, true);
  assert.doesNotMatch(
    withoutLocationDetail.message,
    /^地点: /m,
    '地点为 null 时不得输出「地点：未知 / 未定位」之类的伪位置',
  );
  assert.equal(withoutLocationDetail.data.moment.locationLabel, null);
}

// 4.4 searchMoments：结构化 data 带出 location，keyword 也可命中地点。
{
  const searchContext = { getAgentId: () => 'agent-b', repositories: { moment: repository } };
  const byLocation = await searchTool.execute({ keyword: '图书馆' }, searchContext);
  assert.equal(byLocation.success, true);
  assert.deepEqual(
    byLocation.data.map((moment) => moment.id),
    [withLocation.id],
    'keyword 必须能命中地点',
  );
  assert.equal(byLocation.data[0].locationLabel, '学校图书馆');
}

// 4.5 AI 发布入口第一版不暴露 location / media。
assert.equal(
  Object.hasOwn(createTool.definition.parameters.properties, 'locationLabel'),
  false,
  'aiCreateMoment 不得暴露 locationLabel',
);
for (const forbidden of ['mediaAssetIds', 'imageUrl', 'imageBase64', 'location']) {
  assert.equal(
    Object.hasOwn(createTool.definition.parameters.properties, forbidden),
    false,
    `aiCreateMoment 不得暴露 ${forbidden}`,
  );
}
assert.equal(
  createTool.definition.parameters.required.includes('locationLabel'),
  false,
  'aiCreateMoment 不得把 locationLabel 标记为必填参数',
);
{
  const agentMoment = await createMomentModule.createAgentMoment(
    repository,
    directory,
    { agentId: 'agent-b', nameSnapshot: 'AI乙（旧名）', content: 'AI 发布的时刻' },
  );
  assert.equal(agentMoment.locationLabel, null, 'AI 发布路径写入的 locationLabel 必须是 null');
}

// ── 5. Timeline keyset 分页 ─────────────────────────────────────────────

const ts_ = (second) => `2026-10-01T00:00:${String(second).padStart(2, '0')}.000Z`;

/**
 * 走真实 create 命令建 Moment，只把 created_at pin 成测试需要的值。
 *
 * 时间戳是 fixture 的形状（同一毫秒发布多条是真实存在的），其余事实（audience 行、
 * Social Inbox fanout、media）都仍然经过生产写入路径。
 */
async function createUserMomentAt(db, repo, content, createdAt, audience) {
  const moment = await createMomentModule.createUserMoment(
    repo, directory, { content, audience },
  );
  db.prepare('UPDATE moments SET created_at = ? WHERE id = ?').run(createdAt, moment.id);
  return { ...moment, createdAt };
}

function createMomentDb() {
  const instance = new DatabaseSync(':memory:');
  installMomentSchema(instance);
  instance.exec(`INSERT INTO ai_assistants (id, agent_id, name) VALUES ('ai-b', 'agent-b', 'AI乙'), ('ai-c', 'agent-c', 'AI丙');`);
  return instance;
}

const previousExecutor = currentExecutor;

// 5.1 同 timestamp 也必须稳定排序（created_at DESC, id DESC）。
const sameStampDb = createMomentDb();
currentExecutor = createExecutor(sameStampDb);
const sameStampRepository = new repositoryModule.SQLiteMomentRepository();
const sameStampIds = [];
for (const label of ['same-a', 'same-b', 'same-c']) {
  sameStampIds.push((await createUserMomentAt(sameStampDb, sameStampRepository, label, ts_(10))).id);
}
{
  const rows = await sameStampRepository.listMomentTimelineForUser({ limit: 10 });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.id),
    [...sameStampIds].sort().reverse(),
    'created_at 完全相同时必须按 id DESC 稳定排序',
  );
  const again = await sameStampRepository.listMomentTimelineForUser({ limit: 10 });
  assert.deepEqual(
    again.map((row) => row.id),
    rows.map((row) => row.id),
    '同一个库重复读取必须给出完全相同的顺序',
  );
  assert.ok(
    rows.every((row) => row.createdAt === ts_(10)),
    '本用例必须真的包含多个 created_at 完全相同的 Moment',
  );
}

// 5.2 keyset page1 / page2：A B C D E（A 最新）。
const keysetDb = createMomentDb();
currentExecutor = createExecutor(keysetDb);
const keysetRepository = new repositoryModule.SQLiteMomentRepository();

const ids = {
  A: (await createUserMomentAt(keysetDb, keysetRepository, 'A', ts_(50))).id,
  B: (await createUserMomentAt(keysetDb, keysetRepository, 'B', ts_(40))).id,
  C: (await createUserMomentAt(keysetDb, keysetRepository, 'C', ts_(30))).id,
  D: (await createUserMomentAt(keysetDb, keysetRepository, 'D', ts_(20))).id,
  E: (await createUserMomentAt(keysetDb, keysetRepository, 'E', ts_(10))).id,
};

const page1 = await keysetRepository.listMomentTimelineForUser({ limit: 2 });
assert.deepEqual(page1.map((row) => row.content), ['A', 'B'], 'page1 必须是最新两条');
const cursorB = { createdAt: page1[1].createdAt, id: page1[1].id };

const page2 = await keysetRepository.listMomentTimelineForUser({ limit: 2, cursor: cursorB });
assert.deepEqual(page2.map((row) => row.content), ['C', 'D'], 'page2 必须严格从 cursor 之后继续');

// 5.3 page1 之后在顶部插入新 Moment：page2 不得重复 B，也不得跳过 C。
await createUserMomentAt(keysetDb, keysetRepository, 'NEW', ts_(60));
const page2AfterInsert = await keysetRepository.listMomentTimelineForUser({ limit: 2, cursor: cursorB });
assert.deepEqual(
  page2AfterInsert.map((row) => row.content),
  ['C', 'D'],
  '顶部插入新 Moment 后，cursor 翻页既不能重复也不能跳过',
);
// 对照：OFFSET 语义会在这里出错（page2 变成 B C）——这正是 M6 必须改用 keyset 的原因。
assert.deepEqual(
  keysetDb.prepare(`SELECT content FROM moments ORDER BY created_at DESC LIMIT 2 OFFSET 2`)
    .all().map((row) => row.content),
  ['B', 'C'],
  'OFFSET 语义在顶部插入后会重复 B',
);

// 5.4 cursor 行被删除后，用同一个 cursor 值仍能继续翻页。
keysetDb.prepare('DELETE FROM moments WHERE id = ?').run(ids.B);
assert.equal(
  keysetDb.prepare('SELECT COUNT(*) AS count FROM moments WHERE id = ?').get(ids.B).count,
  0,
  'cursor 行必须真的被删除，本用例才有意义',
);
const page2AfterDelete = await keysetRepository.listMomentTimelineForUser({ limit: 2, cursor: cursorB });
assert.deepEqual(
  page2AfterDelete.map((row) => row.content),
  ['C', 'D'],
  'cursor 携带排序值而不是行引用：cursor 行被删除后翻页仍必须成立',
);

// 5.5 完整翻页不重复、不丢失。
{
  const collected = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await keysetRepository.listMomentTimelineForUser({ limit: 2, cursor });
    if (page.length === 0) break;
    collected.push(...page.map((row) => row.id));
    cursor = { createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id };
    if (page.length < 2) break;
  }
  assert.equal(new Set(collected).size, collected.length, '翻页结果不得重复');
  assert.deepEqual(
    collected,
    keysetDb.prepare('SELECT id FROM moments ORDER BY created_at DESC, id DESC').all()
      .map((row) => row.id),
    '翻页必须恰好覆盖全部 Moment 一次',
  );
}

// ── 6. AI ACL 与 cursor 同时作用在 SQL 上 ──────────────────────────────

const aclDb = createMomentDb();
currentExecutor = createExecutor(aclDb);
const aclRepository = new repositoryModule.SQLiteMomentRepository();

await createUserMomentAt(aclDb, aclRepository, '公开 1', ts_(90), { mode: 'all' });
await createUserMomentAt(aclDb, aclRepository, '仅乙 1', ts_(80), { mode: 'selected', viewerAgentIds: ['agent-b'] });
await createUserMomentAt(aclDb, aclRepository, '仅丙 1', ts_(70), { mode: 'selected', viewerAgentIds: ['agent-c'] });
await createUserMomentAt(aclDb, aclRepository, '排除乙 1', ts_(60), { mode: 'all_except', viewerAgentIds: ['agent-b'] });
await createUserMomentAt(aclDb, aclRepository, '公开 2', ts_(50), { mode: 'all' });
await createUserMomentAt(aclDb, aclRepository, '仅乙 2', ts_(40), { mode: 'selected', viewerAgentIds: ['agent-b'] });

{
  const firstPage = await aclRepository.queryVisibleMomentsForAgent('agent-b', { limit: 2 });
  assert.deepEqual(
    firstPage.map((moment) => moment.content),
    ['公开 1', '仅乙 1'],
    'AI 搜索结果必须由 SQL ACL 决定并尊重 limit',
  );
  const cursor = {
    createdAt: firstPage[firstPage.length - 1].createdAt,
    id: firstPage[firstPage.length - 1].id,
  };
  const secondPage = await aclRepository.queryVisibleMomentsForAgent('agent-b', { limit: 3, cursor });
  assert.deepEqual(
    secondPage.map((moment) => moment.content),
    ['公开 2', '仅乙 2'],
    'ACL 与 cursor 必须同时作用：不可见项不得占据分页位置',
  );
  const all = await aclRepository.queryVisibleMomentsForAgent('agent-b', { limit: 10 });
  assert.deepEqual(
    all.map((moment) => moment.content).sort(),
    ['公开 1', '公开 2', '仅乙 1', '仅乙 2'].sort(),
    'agent-b 的可见集合必须排除 selected(agent-c) 与 all_except(agent-b)',
  );
}

// ── 7. AI authored Moment 在用户 Timeline 的展示身份 ────────────────────

{
  const aiMoment = await createMomentModule.createAgentMoment(aclRepository, directory, {
    agentId: 'agent-b',
    nameSnapshot: 'AI乙（发布时名称）',
    content: 'AI 只给甲丙看的时刻',
    audience: { mode: 'selected', viewerAgentIds: ['agent-c'] },
  });

  // audience 只约束 AI：用户 Timeline 必须仍然看得到。
  const userTimeline = await facadeModule.listMomentRecords(identity.profile, { limit: 50 });
  const record = userTimeline.find((item) => item.id === aiMoment.id);
  assert.ok(record, 'AI authored Moment 必须出现在用户 Timeline');
  assert.equal(record.actorType, 'ai');
  assert.equal(record.actorId, 'agent-b', '展示身份必须用不可变 agentId');
  assert.equal(record.assistantId, 'ai-b', '主页入口必须使用对应资料 ID，而非 agentId');
  assert.equal(userTimeline.find((item) => item.actorType === 'user').assistantId, null, '用户头像没有 AI 主页');
  assert.equal(record.userName, 'AI乙', 'Timeline 用当前名称解析，而不是发布时快照');

  // 改名后 identity 不漂移，名称跟随当前 Assistant。
  identity.assistants = identity.assistants.map((assistant) =>
    assistant.agentId === 'agent-b' ? { ...assistant, name: 'AI乙（新名）' } : assistant);
  const renamed = (await facadeModule.listMomentRecords(identity.profile, { limit: 50 }))
    .find((item) => item.id === aiMoment.id);
  assert.equal(renamed.userName, 'AI乙（新名）', 'AI 改名后 Timeline 必须使用新名称');
  assert.equal(renamed.actorId, 'agent-b', '改名不得改变稳定身份');
  assert.equal(renamed.assistantId, 'ai-b', '改名不得改变主页目标');
  identity.assistants = identity.assistants.map((assistant) =>
    assistant.agentId === 'agent-b' ? { ...assistant, name: 'AI乙' } : assistant);

  // 用户不能删除 AI 的 Moment（Application ownership 与 UI 权限同向）。
  await assert.rejects(
    facadeModule.removeMomentRecord(aiMoment.id),
    /只能删除自己发布的时刻/,
    '用户不得删除 AI authored Moment',
  );

  const assistants = identity.assistants;
  identity.assistants = assistants.filter((assistant) => assistant.id !== 'ai-b');
  const historical = await facadeModule.getMomentRecord(aiMoment.id);
  assert.equal(historical.assistantId, null, 'AI 删除后历史时刻不再提供主页入口');
  assert.equal(historical.userName, 'AI乙（发布时名称）', '历史时刻仍保留作者名称快照');
  identity.assistants = assistants;
}

// ── 8. audience selector 纯投影 ────────────────────────────────────────

{
  const draft = audienceDraftModule;
  assert.deepEqual(
    draft.toMomentAudience({ mode: 'all', viewerAgentIds: [] }),
    { mode: 'all' },
    'all 不得携带任何名单',
  );
  assert.deepEqual(
    draft.toMomentAudience({ mode: 'selected', viewerAgentIds: ['agent-b', 'agent-c'] }),
    { mode: 'selected', viewerAgentIds: ['agent-b', 'agent-c'] },
    'selected 必须原样提交 stable agentId',
  );
  assert.deepEqual(
    draft.toMomentAudience({ mode: 'all_except', viewerAgentIds: ['agent-c'] }),
    { mode: 'all_except', viewerAgentIds: ['agent-c'] },
    'all_except 必须是 deny list',
  );
  assert.deepEqual(
    draft.toMomentAudience({ mode: 'all_except', viewerAgentIds: [] }),
    { mode: 'all' },
    '空 deny list 语义上等价于「不排除任何 AI」，收敛为 all',
  );

  // fail-closed 不变量：任何非法 restricted audience 都不得自动扩大为 all。
  // 唯一允许「空名单 → all」的是 all_except —— 空 deny list 的语义本来就等于不排除任何 AI。
  for (const mode of ['selected', 'all_except']) {
    const mapped = draft.toMomentAudience({ mode, viewerAgentIds: [] });
    if (mode === 'selected') {
      assert.equal(mapped.mode, 'selected', 'selected 空名单绝不能被扩大成 all');
      assert.deepEqual(mapped.viewerAgentIds, []);
    } else {
      assert.equal(mapped.mode, 'all');
    }
  }

  // 纯函数保留非法输入后，真正拒绝它的是 Application：真实命令必须报 empty_audience。
  {
    const momentCountBefore = aclDb.prepare('SELECT COUNT(*) AS count FROM moments').get().count;
    await assert.rejects(
      createMomentModule.createUserMoment(aclRepository, directory, {
        content: '非法空 allow list',
        audience: draft.toMomentAudience({ mode: 'selected', viewerAgentIds: [] }),
      }),
      (error) => {
        assert.ok(error instanceof errorsModule.MomentDomainError);
        assert.equal(
          error.code,
          'empty_audience',
          'selected 空名单必须由 Application 以 empty_audience 拒绝',
        );
        return true;
      },
    );
    assert.equal(
      aclDb.prepare('SELECT COUNT(*) AS count FROM moments').get().count,
      momentCountBefore,
      '被拒绝的发布不得留下任何 Moment 事实',
    );
  }
  assert.equal(
    draft.isMomentAudienceDraftSubmittable({ mode: 'selected', viewerAgentIds: [] }),
    false,
    'selected 空名单不可提交',
  );
  assert.equal(
    draft.isMomentAudienceDraftSubmittable({ mode: 'selected', viewerAgentIds: ['agent-b'] }),
    true,
  );
  assert.equal(draft.isMomentAudienceDraftSubmittable({ mode: 'all', viewerAgentIds: [] }), true);

  // canonical draft：发布页显示的必须与最终发布事实一致。
  assert.deepEqual(
    draft.canonicalizeMomentAudienceDraft({ mode: 'all_except', viewerAgentIds: [] }),
    { mode: 'all', viewerAgentIds: [] },
    'all_except 空名单必须 canonicalize 为 all',
  );
  assert.equal(
    draft.describeMomentAudienceDraft({ mode: 'all_except', viewerAgentIds: [] }),
    '不给部分 AI 看（未选择）',
    'canonicalize 之前，发布页确实会显示「未选择」',
  );
  assert.equal(
    draft.describeMomentAudienceDraft(
      draft.canonicalizeMomentAudienceDraft({ mode: 'all_except', viewerAgentIds: [] }),
    ),
    '所有 AI',
    'canonicalize 之后必须立刻显示「所有 AI」，不能停在「不给部分 AI 看（未选择）」',
  );
  assert.deepEqual(
    draft.canonicalizeMomentAudienceDraft({ mode: 'selected', viewerAgentIds: [] }),
    { mode: 'selected', viewerAgentIds: [] },
    'canonicalize 同样不得把 selected 空名单扩大成 all',
  );
  assert.deepEqual(
    draft.canonicalizeMomentAudienceDraft({ mode: 'all', viewerAgentIds: ['agent-b'] }),
    { mode: 'all', viewerAgentIds: [] },
    'all 永远不携带名单',
  );

  // canonical draft 与 toMomentAudience 必须是同一件事：前者就是发布事实。
  for (const sample of [
    { mode: 'all', viewerAgentIds: [] },
    { mode: 'all_except', viewerAgentIds: [] },
    { mode: 'all_except', viewerAgentIds: ['agent-c'] },
    { mode: 'selected', viewerAgentIds: ['agent-b'] },
    { mode: 'selected', viewerAgentIds: [] },
  ]) {
    const canonical = draft.canonicalizeMomentAudienceDraft(sample);
    const audience = draft.toMomentAudience(sample);
    assert.equal(
      audience.mode,
      canonical.mode,
      `canonical draft 与发布 audience 必须一致：${JSON.stringify(sample)}`,
    );
    assert.deepEqual(
      audience.mode === 'all' ? [] : [...audience.viewerAgentIds],
      [...canonical.viewerAgentIds],
    );
  }

  // 端到端：canonical draft → 真实持久事实。
  {
    const restricted = await createMomentModule.createUserMoment(aclRepository, directory, {
      content: 'canonical all_except',
      audience: draft.toMomentAudience(
        draft.canonicalizeMomentAudienceDraft({ mode: 'all_except', viewerAgentIds: ['agent-c'] }),
      ),
    });
    assert.equal(restricted.audienceMode, 'all_except');
    assert.deepEqual(
      aclDb.prepare('SELECT viewer_agent_id FROM moment_audience_ai WHERE moment_id = ?')
        .all(restricted.id).map((row) => row.viewer_agent_id),
      ['agent-c'],
      'all_except 非空名单必须真的写成 deny list',
    );

    const widened = await createMomentModule.createUserMoment(aclRepository, directory, {
      content: 'canonical all',
      audience: draft.toMomentAudience(
        draft.canonicalizeMomentAudienceDraft({ mode: 'all_except', viewerAgentIds: [] }),
      ),
    });
    assert.equal(widened.audienceMode, 'all');
    assert.equal(
      aclDb.prepare('SELECT COUNT(*) AS count FROM moment_audience_ai WHERE moment_id = ?')
        .get(widened.id).count,
      0,
      'canonical all 不得写任何 audience 行',
    );
  }

  // 勾选身份只能是 agentId。
  const toggled = draft.toggleMomentAudienceCandidate(
    { mode: 'selected', viewerAgentIds: [] },
    'agent-b',
  );
  assert.deepEqual(toggled.viewerAgentIds, ['agent-b']);
  assert.deepEqual(
    draft.toggleMomentAudienceCandidate(toggled, 'agent-b').viewerAgentIds,
    [],
    '再次点击必须取消勾选',
  );

  // 反义模式切换不得沿用旧勾选：这是隐私类 UI，语义反转时必须清空。
  assert.deepEqual(
    draft.selectMomentAudienceMode('all', { mode: 'selected', viewerAgentIds: ['agent-b'] }),
    { mode: 'all', viewerAgentIds: [] },
    '切到 all 必须清空名单',
  );
  assert.deepEqual(
    draft.selectMomentAudienceMode('all_except', { mode: 'selected', viewerAgentIds: ['agent-b'] }),
    { mode: 'all_except', viewerAgentIds: [] },
    'selected → all_except 必须清空名单（「只有 A 能看」不等于「唯独 A 不能看」）',
  );
  assert.deepEqual(
    draft.selectMomentAudienceMode('selected', { mode: 'all_except', viewerAgentIds: ['agent-c'] }),
    { mode: 'selected', viewerAgentIds: [] },
    'all_except → selected 必须清空名单',
  );
  assert.deepEqual(
    draft.selectMomentAudienceMode('selected', { mode: 'selected', viewerAgentIds: ['agent-b'] }),
    { mode: 'selected', viewerAgentIds: ['agent-b'] },
    '同模式重复选择必须保留当前名单',
  );
  assert.equal(
    draft.isMomentAudienceDraftSubmittable(
      draft.selectMomentAudienceMode('selected', { mode: 'all_except', viewerAgentIds: ['agent-c'] }),
    ),
    false,
    '跨模式清空后 selected 不可提交，用户必须重新明确选择',
  );

  // 候选 DTO 只暴露稳定身份。
  const candidates = await facadeModule.listMomentAudienceCandidates();
  assert.deepEqual(candidates.map((item) => item.agentId), ['agent-b', 'agent-c']);
  assert.ok(candidates.every((item) => !Object.hasOwn(item, 'id')), '候选 DTO 不得暴露 assistant.id');

  // Timeline 可见范围提示：all 省略，其余给出轻量提示。
  assert.equal(draft.describeMomentVisibility('all'), null);
  assert.equal(draft.describeMomentVisibility('selected'), '部分 AI 可见');
  assert.equal(draft.describeMomentVisibility('all_except'), '部分 AI 不可见');

  // 可见范围发布后不可编辑：facade 只提供候选读取，不提供任何 audience 编辑命令。
  assert.deepEqual(
    Object.keys(facadeModule).filter((name) => /audience/i.test(name)),
    ['listMomentAudienceCandidates'],
    'M6 不得提供 audience 编辑入口',
  );
}

// ── 9. 发布 / 评论 / 删除失败文案 ───────────────────────────────────────

{
  const { MomentDomainError } = errorsModule;
  assert.equal(
    feedbackModule.describeMomentPublishFailure(new MomentDomainError('empty_content', '时刻正文不能为空')),
    '时刻正文不能为空',
    '已知 domain 原因必须原样呈现，不能伪装成图片错误',
  );
  assert.equal(
    feedbackModule.describeMomentPublishFailure(new MomentDomainError('unknown_audience_agent_id', '可见范围包含不存在的 AI', 'agent-x')),
    '可见范围中的 AI 已发生变化，请重新选择。',
    '候选失效必须给出可操作提示，且不得回显内部 agentId',
  );
  assert.equal(
    feedbackModule.describeMomentPublishFailure(new Error('SQLITE_CONSTRAINT: near "SELECT": syntax error at /data/app/db')),
    '发布失败，请稍后重试。',
    '未知错误必须收敛为通用文案，不得暴露 SQL / 路径 / stack',
  );
  assert.equal(
    feedbackModule.describeMomentCommentFailure(new MomentDomainError('comment_not_found', '评论不存在')),
    '这条评论已不存在。',
  );
  const deleteMessage = feedbackModule.describeMomentDeleteFailure(
    new MomentDomainError('not_moment_owner', '只能删除自己发布的时刻'),
  );
  assert.equal(deleteMessage, '只能删除自己发布的时刻');
  assert.doesNotMatch(deleteMessage, /agentId|SELECT|sqlite/i);

  // AI Moment 上没有 Moment-level 管理动作 ⇒ 不显示 More 入口（避免空菜单）。
  assert.equal(uiPermissions.hasMomentLevelUserActions({ isOwnMoment: false }), false);
  assert.equal(uiPermissions.hasMomentLevelUserActions({ isOwnMoment: true }), true);

  // like / unlike 写入失败：已知 domain 原因按现有策略映射，未知错误一律收敛且不泄漏内部信息。
  assert.equal(
    feedbackModule.describeMomentLikeFailure(new MomentDomainError('moment_not_found', '时刻不存在')),
    '这条时刻已不存在。',
    '已知 domain 原因可以按现有策略映射成用户可操作说法',
  );
  const likeFailureMessage = feedbackModule.describeMomentLikeFailure(
    new Error('SQLITE_BUSY: database is locked at /data/data/com.app/databases/app.db (agentId=agent-b)'),
  );
  assert.equal(likeFailureMessage, '点赞失败，请重试。');
  assert.doesNotMatch(
    likeFailureMessage,
    /sqlite|database|\/data|agentId|stack/i,
    'like 失败文案不得暴露 SQL / 路径 / agentId',
  );
  const unlikeFailureMessage = feedbackModule.describeMomentUnlikeFailure(new Error('boom'));
  assert.equal(unlikeFailureMessage, '取消点赞失败，请重试。');
  assert.doesNotMatch(unlikeFailureMessage, /boom|stack/i, '不得回显原始错误内容');
}

// ── 10. UI 契约守卫（用户明确要求的 presentation guard）─────────────────

{
  const commentModalSource = read('src/features/moments/presentation/momentItem/modals.tsx');
  assert.match(
    commentModalSource,
    /onSubmit:\s*\(\)\s*=>\s*Promise<void>/,
    'CommentInputModal.onSubmit 必须是 Promise 契约',
  );
  assert.match(
    commentModalSource,
    /await onSubmit\(\)/,
    'handlePressSubmit 必须 await 真实提交结果',
  );
  assert.doesNotMatch(
    commentModalSource,
    /requestAnimationFrame/,
    '提交不得再用 requestAnimationFrame 做 fire-and-forget',
  );
  assert.match(
    commentModalSource,
    /await onDeleteComment\?\.\(aiComment\.id\)/,
    'AI 评论管理弹窗的删除同样必须 await 真实结果',
  );

  const momentItemSource = read('src/features/moments/presentation/MomentItem.tsx');
  assert.match(
    momentItemSource,
    /await onComment\?\.\(/,
    '只有在真实写入成功后才允许清空草稿 / 回复目标 / 关闭弹窗',
  );
  // 顺序必须成立：先 await 真实写入，再清空草稿与回复目标。
  {
    const submitHandler = momentItemSource.slice(
      momentItemSource.indexOf('const handleSubmitComment'),
      momentItemSource.indexOf('const handleCancelComment'),
    );
    const awaitIndex = submitHandler.indexOf('await onComment?.(');
    const clearDraftIndex = submitHandler.indexOf("commentTextRef.current = ''");
    const clearReplyIndex = submitHandler.indexOf('setReplyTarget(null)');
    assert.ok(awaitIndex >= 0, '评论提交必须 await 真实写入');
    assert.ok(clearDraftIndex > awaitIndex, '草稿只能在真实写入成功之后才清空');
    assert.ok(clearReplyIndex > awaitIndex, '回复目标只能在真实写入成功之后才清空');
  }
  assert.match(
    momentItemSource,
    /await onDelete\?\.\(item\.id\)/,
    '删除必须 await 真实结果',
  );
  assert.match(
    momentItemSource,
    /await onDeleteComment\?\.\(commentId\)/,
    '评论删除必须 await 真实结果',
  );
  // 身份判断必须同时使用 actorType + actorId。
  assert.match(momentItemSource, /item\.actorType === 'user' && item\.actorId === currentUserId/);
  assert.match(momentItemSource, /like\.actorType === 'user' && like\.actorId === currentUserId/);
  assert.match(momentItemSource, /comment\.actorType === 'user'\s*\n?\s*&& comment\.actorId === currentUserId/);
  // AI Moment 不显示空 More 菜单。
  assert.match(momentItemSource, /hasMomentLevelUserActions\(ownership\)/);

  const tabSource = read('src/features/moments/presentation/MomentsTab.tsx');
  assert.doesNotMatch(tabSource, /nextOffset/, 'nextOffsetRef 必须退役');
  assert.doesNotMatch(tabSource, /void removeMoment\(/, '删除不得再是 fire-and-forget');

  // like / unlike 不得再是裸 fire-and-forget：失败必须被 catch 收口并给出安全提示。
  assert.doesNotMatch(tabSource, /void addLike\(/, 'addLike 不得再裸 void（会产生 unhandled rejection）');
  assert.doesNotMatch(tabSource, /void removeLike\(/, 'removeLike 不得再裸 void');
  assert.match(tabSource, /addLike\(momentId\)\.catch\(/, 'addLike 失败必须被 catch 收口');
  assert.match(tabSource, /removeLike\(momentId\)\.catch\(/, 'removeLike 失败必须被 catch 收口');
  assert.match(tabSource, /describeMomentLikeFailure/, 'like 失败必须走安全文案');
  assert.match(tabSource, /describeMomentUnlikeFailure/, 'unlike 失败必须走安全文案');
  {
    // 收口后 like / unlike 仍然不做 optimistic state：UI 事实只由 reload / DB 决定。
    const interactionHandlers = tabSource.slice(
      tabSource.indexOf('const handleLike'),
      tabSource.indexOf('const handleComment'),
    );
    assert.ok(interactionHandlers.length > 0, '必须能定位到 like / unlike handler');
    assert.doesNotMatch(
      interactionHandlers,
      /setMoments\(|setHasMoreMoments\(|setLoadingMore\(/,
      'like / unlike 不得做 optimistic state',
    );
  }

  // Modal 确认必须提交 canonical draft，否则发布页显示与最终事实会不一致。
  const audienceModalSource = read('src/features/moments/presentation/MomentAudienceSelectorModal.tsx');
  assert.match(
    audienceModalSource,
    /onConfirm\(canonicalizeMomentAudienceDraft\(draft\)\)/,
    'Modal 确认必须提交 canonical draft',
  );

  const publishSource = read('src/features/moments/presentation/PublishView.tsx');
  assert.match(publishSource, /listMomentAudienceCandidates/, '发布页必须通过 selector 选择可见范围');
  assert.match(publishSource, /MomentAudienceSelectorModal/);
  assert.match(publishSource, /MAX_MOMENT_LOCATION_LABEL_LENGTH/);
  assert.match(publishSource, /describeMomentPublishFailure/);
  assert.match(
    publishSource,
    /audience: toMomentAudience\(audienceDraft\)/,
    '发布只允许把 draft 交给唯一 canonical 转换',
  );
  assert.doesNotMatch(publishSource, /expo-location|getCurrentPosition|latitude|longitude/, '地点第一版只有文本，不得申请定位');

  const hireSource = read('src/features/moments/presentation/useMoments.ts');
  assert.doesNotMatch(hireSource, /nextOffset|offset\s*:/, 'Timeline 不得再使用 OFFSET');
  assert.match(hireSource, /nextCursorRef/);
  assert.match(hireSource, /loadMoreInFlightRef/);
  assert.match(hireSource, /generationRef/);

  const repositorySource = read('src/features/moments/infrastructure/SQLiteMomentRepository.ts');
  assert.doesNotMatch(
    repositorySource,
    /(?:LIMIT|offset)\s*\?\s*(?:OFFSET|,)\s*\?/i,
    'Moment 仓储不得再使用 OFFSET 分页（只允许 LIMIT ? / cursor 条件）',
  );
  assert.doesNotMatch(repositorySource, /OFFSET\s*[?$]/i, '分页不得再绑定 OFFSET 参数');
  assert.match(repositorySource, /ORDER BY created_at DESC, id DESC/);
  assert.match(repositorySource, /ORDER BY m\.created_at DESC, m\.id DESC/);
}

// ── 11. active UI 产品名与 Prompt recent Moments 文案 ───────────────────

{
  for (const relativePath of [
    'src/features/moments/presentation/MomentsHeader.tsx',
    'src/features/moments/presentation/MomentsTab.tsx',
    'src/features/moments/presentation/PublishView.tsx',
    'src/features/moments/presentation/MomentItem.tsx',
    'src/features/moments/presentation/useMomentsCover.ts',
    'src/features/moments/presentation/momentItem/modals.tsx',
  ]) {
    assert.doesNotMatch(
      read(relativePath),
      /人机时刻/,
      `${relativePath} 的 active UI 文案必须统一为「时刻」`,
    );
  }
  assert.match(read('src/features/moments/presentation/MomentsHeader.tsx'), /title="时刻"/);
  assert.match(read('src/features/moments/presentation/PublishView.tsx'), /发布时刻/);
  assert.match(read('src/features/moments/presentation/PublishView.tsx'), /添加地点（可选）/);
  assert.match(read('src/features/moments/presentation/PublishView.tsx'), /谁可以看/);
  assert.match(read('src/features/moments/presentation/MomentsTab.tsx'), /还没有时刻/);
  assert.match(
    read('src/features/moments/presentation/momentItem/modals.tsx'),
    /长按评论可删除/,
  );
  assert.doesNotMatch(
    read('src/features/moments/presentation/momentItem/modals.tsx'),
    /建议保留最真诚的一条/,
    '旧自动互动时代的评论管理文案必须清掉',
  );

  // Tool progress presentation 的 active Moment labels。
  const toolPresentation = read('src/features/chat/reply/agent/ToolReplyPresentation.ts');
  assert.doesNotMatch(toolPresentation, /'人机时刻/, 'Tool progress 的 active labels 必须统一为「时刻」');
  assert.match(toolPresentation, /aiCreateMoment: '发布时刻'/);
  assert.match(toolPresentation, /getMomentDetail: '时刻详情'/);
}

currentExecutor = previousExecutor;

// AI 工具必须能从历史查询到纠错闭环；模型只能看到 message，不能依赖隐藏的 data。
{
  const toolDb = new DatabaseSync(':memory:');
  installMomentSchema(toolDb);
  currentExecutor = createExecutor(toolDb);
  const toolRepository = new repositoryModule.SQLiteMomentRepository();
  const toolContext = {
    sharedState: {}, aiConfig: {}, repositories: { moment: toolRepository },
    getAgentId: () => 'agent-b', getAIName: () => 'AI乙', isBlocked: () => false,
  };
  for (let index = 0; index < 14; index += 1) {
    await toolRepository.createMoment({
      id: `tool-moment-${String(index).padStart(2, '0')}`,
      authorType: index < 12 ? 'user' : 'ai', authorId: index < 12 ? 'self' : 'agent-b',
      authorNameSnapshot: index < 12 ? '用户甲' : 'AI乙', content: `历史工具闭环 ${index}`,
      locationLabel: null, audience: { mode: 'all' }, deliveryRecipientAgentIds: ['agent-b'],
    });
  }
  toolDb.prepare('UPDATE moments SET created_at = ?').run('2026-10-02T04:00:00.000Z');
  const first = await searchTool.execute({ author: 'user', limit: 5 }, toolContext);
  assert.equal(first.data.length, 5);
  assert.equal(first.hasMore, true);
  assert.ok(first.message.includes(JSON.stringify(first.nextCursor)), '下一页凭据必须进入模型可见结果');
  const second = await searchTool.execute({ author: 'user', limit: 5, cursor: first.nextCursor }, toolContext);
  const third = await searchTool.execute({ author: 'user', limit: 5, cursor: second.nextCursor }, toolContext);
  assert.equal(new Set([...first.data, ...second.data, ...third.data].map((row) => row.id)).size, 12);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
  assert.equal((await searchTool.execute({ author: 'self' }, toolContext)).data.length, 2);
  assert.equal((await searchTool.execute({ author: 'AI乙' }, toolContext)).data.length, 2);
  assert.equal((await searchTool.execute({ keyword: 'AI乙' }, toolContext)).data.length, 2);
  assert.equal((await searchTool.execute({ author: 'user', limit: 50 }, toolContext)).data.length, 12, 'limit 不得再被暗中截为10');
  assert.equal((await searchTool.execute({ startDate: '2026-10-02', endDate: '2026-10-02', limit: 50 }, toolContext)).data.length, 14);
  assert.equal((await searchTool.execute({ startDate: '2026-02-30' }, toolContext)).success, false);
  assert.equal((await searchTool.execute({ startDate: '2026-10-03', endDate: '2026-10-02' }, toolContext)).success, false);
  const like = load('src/features/moments/aiTools/AILikeMomentTool.ts');
  const comment = load('src/features/moments/aiTools/AICommentMomentTool.ts');
  const reply = load('src/features/moments/aiTools/AIReplyMomentCommentTool.ts');
  const removeComment = load('src/features/moments/aiTools/AIDeleteOwnMomentCommentTool.ts');
  const preview = await like.execute({ momentId: 'tool-moment-00' }, toolContext);
  assert.equal(preview.data.action, 'preview');
  assert.ok(preview.message.includes('尚未点赞'));
  assert.ok(preview.message.includes('历史工具闭环 0'));
  assert.equal((await toolRepository.listLikes('tool-moment-00')).length, 0);
  const otherRun = { ...toolContext, sharedState: {} };
  const crossRun = await like.execute({ momentId: 'tool-moment-00', readReceipt: preview.data.readReceipt }, otherRun);
  assert.equal(crossRun.data.action, 'preview', '另一个运行的读取凭据不能直接点赞');
  const wrongTarget = await like.execute({ momentId: 'tool-moment-01', readReceipt: preview.data.readReceipt }, toolContext);
  assert.equal(wrongTarget.data.action, 'preview', '不能用另一条朋友圈的凭据点赞');
  const liked = await like.execute({ momentId: 'tool-moment-00', readReceipt: preview.data.readReceipt }, toolContext);
  assert.equal(liked.data.action, 'liked');
  assert.equal((await toolRepository.listLikes('tool-moment-00')).length, 1);
  assert.equal((await like.execute({ momentId: 'tool-moment-00', readReceipt: preview.data.readReceipt }, toolContext)).data.action, 'already_liked');
  const history = await searchTool.execute({ keyword: '历史工具闭环 0' }, toolContext);
  assert.equal(history.data[0].id, 'tool-moment-00', '已读记录仍必须能搜索');
  const wrongComment = await comment.execute({ momentId: 'tool-moment-00', content: '这条发错了' }, toolContext);
  const wrongCommentId = wrongComment.data.commentIds[0];
  assert.ok(wrongComment.message.includes(wrongCommentId), '写入结果必须把新评论 ID 交给模型');
  const mine = await searchTool.execute({ onlyMyComments: true, commentKeyword: '发错了' }, toolContext);
  assert.equal(mine.data.length, 1);
  assert.ok(mine.message.includes(wrongCommentId), '无需用户提供 ID 就能查到自己的评论');
  const fullDetail = await detailTool.execute({ momentId: mine.data[0].id }, toolContext);
  assert.ok(fullDetail.message.includes(`commentId: ${wrongCommentId}`));
  assert.ok(fullDetail.data.ownCommentIds.includes(wrongCommentId));
  assert.equal(fullDetail.data.isLikedBySelf, true);
  assert.equal((await removeComment.execute({ commentId: wrongCommentId }, toolContext)).success, true);
  assert.equal(await toolRepository.getComment(wrongCommentId), null);
  const [target] = await toolRepository.insertComments([{
    id: 'tool-user-comment', momentId: 'tool-moment-01', authorType: 'user', authorId: 'self',
    authorNameSnapshot: '用户甲', parentCommentId: null, content: '应该回复这里',
  }]);
  const targetDetail = await detailTool.execute({ momentId: target.momentId }, toolContext);
  assert.ok(targetDetail.message.includes(`commentId: ${target.id}`));
  const corrected = await reply.execute({ commentId: target.id, content: '回复正确对象' }, toolContext);
  assert.ok(corrected.message.includes(corrected.data.commentIds[0]));
  const correctedComment = await toolRepository.getComment(corrected.data.commentIds[0]);
  assert.equal(correctedComment.parentCommentId, target.id);
  assert.equal(correctedComment.momentId, target.momentId);
  await toolRepository.createMoment({
    id: 'tool-hidden', authorType: 'user', authorId: 'self', authorNameSnapshot: '用户甲',
    content: '不该泄露的关键词', locationLabel: null, audience: { mode: 'selected', viewerAgentIds: [] },
    deliveryRecipientAgentIds: [],
  });
  assert.equal((await searchTool.execute({ keyword: '不该泄露' }, toolContext)).data.length, 0, '搜索筛选不能绕过 ACL');
  currentExecutor = previousExecutor;
  toolDb.close();
}

// 时间线批量读取：关联事实不能串到别的动态，分页也不能被评论/多图放大。
{
  const db = createMomentDb();
  currentExecutor = createExecutor(db);
  const repo = new repositoryModule.SQLiteMomentRepository();
  const momentIds = [];
  for (let index = 0; index < 6; index += 1) {
    const moment = await createUserMomentAt(db, repo, `批量动态 ${index}`, ts_(index + 1));
    momentIds.push(moment.id);
    await repo.insertComments([
      { id: `batch-comment-${index}-b`, momentId: moment.id, authorType: 'user', authorId: 'self', authorNameSnapshot: '用户甲', parentCommentId: null, content: '第二条评论' },
      { id: `batch-comment-${index}-a`, momentId: moment.id, authorType: 'user', authorId: 'self', authorNameSnapshot: '用户甲', parentCommentId: null, content: '第一条评论' },
    ]);
    db.prepare('UPDATE moment_comments SET created_at = ? WHERE moment_id = ?').run(ts_(1), moment.id);
    await repo.insertLike({ momentId: moment.id, actorType: 'ai', actorId: 'agent-b', actorNameSnapshot: 'AI乙' });
    for (const order of [1, 0]) {
      const assetId = `batch-asset-${index}-${order}`;
      db.prepare(`INSERT INTO media_assets (id, storage_backend, storage_key, hash_algorithm, content_hash, mime_type, byte_size, status, created_at, updated_at)
        VALUES (?, 'persistent-image', ?, 'sha256', ?, 'image/jpeg', 100, 'ready', ?, ?)`)
        .run(assetId, `catalog/images/${assetId}.jpg`, 'a'.repeat(64), ts_(1), ts_(1));
      db.prepare(`INSERT INTO moment_media (id, moment_id, media_asset_id, sort_order, analysis_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
        .run(`batch-media-${index}-${order}`, moment.id, assetId, order, ts_(1), ts_(1));
    }
  }
  const executor = currentExecutor;
  let queryCount = 0;
  const getAll = executor.getAllAsync;
  executor.getAllAsync = async (...args) => { queryCount += 1; return getAll(...args); };
  const originalResolve = mocks['@features/media'].resolveMediaAsset;
  let imageReads = 0;
  mocks['@features/media'].resolveMediaAsset = async () => { imageReads += 1; throw new Error('正文不能等待图片文件'); };
  const page = await facadeModule.listMomentRecords(identity.profile, { limit: 5 });
  assert.equal(imageReads, 0, '时间线正文与社交事实不等待图片文件解析');
  assert.ok(queryCount <= 4, '一页社交事实的数据库调用预算不随动态条数线性增长');
  assert.deepEqual(page.map((record) => record.id), momentIds.slice(1).reverse());
  for (const [index, record] of page.entries()) {
    const sourceIndex = 5 - index;
    assert.deepEqual(record.comments.map((comment) => comment.id), [`batch-comment-${sourceIndex}-a`, `batch-comment-${sourceIndex}-b`]);
    assert.deepEqual(record.likes.map((like) => like.actorId), ['agent-b']);
    assert.deepEqual(record.media.map((media) => media.mediaAssetId), [`batch-asset-${sourceIndex}-0`, `batch-asset-${sourceIndex}-1`]);
  }
  const last = page.at(-1);
  const next = await repo.listMomentTimelineForUser({ limit: 5, cursor: { createdAt: last.createdAt, id: last.id } });
  assert.deepEqual(next.map((record) => record.id), [momentIds[0]]);
  const empty = await repo.listMomentTimelineForUser({ limit: 5, cursor: { createdAt: ts_(0), id: '' } });
  assert.deepEqual(empty, []);
  mocks['@features/media'].resolveMediaAsset = originalResolve;
  currentExecutor = previousExecutor;
  db.close();
}

// AI 个人朋友圈在 SQL 分页前按稳定作者筛选；AI audience 不限制用户查看。
{
  const db = createMomentDb();
  currentExecutor = createExecutor(db);
  const repo = new repositoryModule.SQLiteMomentRepository();
  for (let index = 0; index < 12; index += 1) {
    const authorId = index % 3 === 0 ? 'agent-b' : 'agent-c';
    const moment = await repo.createMoment({
      id: `profile-${index.toString().padStart(2, '0')}`, authorType: 'ai', authorId,
      authorNameSnapshot: '旧名称', content: `动态 ${index}`, locationLabel: null,
      audience: { mode: 'selected', viewerAgentIds: [] }, deliveryRecipientAgentIds: [],
    });
    db.prepare('UPDATE moments SET created_at = ? WHERE id = ?').run(ts_(index + 1), moment.id);
  }
  const author = { actorType: 'ai', actorId: 'agent-b' };
  const first = await facadeModule.listMomentRecords(identity.profile, { limit: 2, author });
  assert.deepEqual(first.map(record => record.id), ['profile-09', 'profile-06']);
  assert.ok(first.every(record => record.actorType === 'ai' && record.actorId === 'agent-b'));
  const last = first.at(-1);
  const cursor = { createdAt: last.createdAt, id: last.id };
  db.prepare('DELETE FROM moments WHERE id = ?').run(last.id);
  const second = await facadeModule.listMomentRecords(identity.profile, { limit: 2, author, cursor });
  assert.deepEqual(second.map(record => record.id), ['profile-03', 'profile-00'], '作者筛选不漏页，删除游标行仍可翻页');
  assert.deepEqual(await repo.listMomentTimelineForUser({
    limit: 2, author: { actorType: 'ai', actorId: 'unknown-agent' },
  }), []);
  currentExecutor = previousExecutor;
  db.close();
}
console.log('Moments V2 M6 地点 / audience / keyset Timeline / AI 个人朋友圈 / UI 契约验证通过。');
