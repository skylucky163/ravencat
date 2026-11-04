/**
 * Moments V2 Domain / Schema / Visibility 契约验证。
 *
 * 验证范围（对应 M1 完成标准）：
 * - fresh schema 与 V1 → V2 升级 schema 的表、FK、索引完全一致；
 * - Moment / Comment / Like 的稳定作者身份与改名语义；
 * - AI audience 的可见性由仓储 SQL 执行，用户读路径不受 ACL 限制；
 * - 不可见 AI 无法读列表、读详情、评论、回复、点赞；
 * - 回复完整性、点赞唯一性、audience 原子提交、级联删除；
 * - moment_ai_interactions 退役、assistant 删除行为、factory reset 覆盖。
 *
 * 真实执行路径：本脚本用递归 transpile loader 装载生产模块（schema / repository /
 * application / aiTools / presentationFacade），只 mock 跨 Feature 的 profile 与 assistant
 * 目录，SQLite 用 node:sqlite 内存库。它不锁定实现细节，只断言外部可观察行为。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { createCoordinatedSqliteFixture, databaseErrors } from './helpers/coordinated-sqlite-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// ── 递归 transpile loader ────────────────────────────────

function transpile(absolutePath) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: absolutePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${absolutePath} 无法编译`);
  return compiled.outputText;
}

/** 可变的运行时依赖：验证过程中会模拟 rename，因此通过 getter 读取。 */
const identity = {
  profile: {
    id: 'self',
    name: '用户甲',
    avatar: 'asset://user',
    avatarMediaAssetId: 'user',
    momentsCover: null,
    updatedAt: '2026-09-17T00:00:00.000Z',
  },
  assistants: [
    {
      id: 'ai-b',
      agentId: 'agent-b',
      name: 'AI乙',
      avatar: 'asset://b',
      avatarMediaAssetId: 'b',
    },
    {
      id: 'ai-c',
      agentId: 'agent-c',
      name: 'AI丙',
      avatar: 'asset://c',
      avatarMediaAssetId: 'c',
    },
  ],
};

let currentExecutor = null;

const mocks = {
  '@platform/persistence': {
    ...databaseErrors,
    databaseCoordinator: { openTaskExecutor: () => currentExecutor },
  },
  '@features/profile': {
    getCurrentUserProfile: async () => identity.profile,
    SELF_USER_PROFILE_ID: 'self',
  },
  '@features/assistants': {
    listAIAssistants: async () => identity.assistants,
    getAssistantDisplayName: (assistant) => assistant.nickname || assistant.name,
  },
  '@features/media': {
    releaseMediaAssetCandidates: async () => undefined,
    MEDIA_ASSET_STORAGE_BACKEND: { persistentImage: 'persistent-image' },
    resolveMediaAsset: async (mediaAssetId) => ({
      asset: { id: mediaAssetId },
      localUri: `asset://${mediaAssetId}`,
    }),
  },
  '@shared/runtime/RuntimeSlot': {
    createRuntimeSlot: () => {
      let value;
      return {
        configure: (next) => { value = next; },
        get: () => value,
      };
    },
  },
};

const moduleCache = new Map();

function load(relativePath) {
  const absolutePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(ROOT, relativePath);
  if (moduleCache.has(absolutePath)) {
    return moduleCache.get(absolutePath);
  }

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
      if (fs.existsSync(candidate)) {
        return load(candidate);
      }
    }
    throw new Error(`无法解析 ${specifier}（来自 ${relativePath}）`);
  };

  new Function('exports', 'require', 'module', transpile(absolutePath))(
    module.exports,
    requireMock,
    module,
  );
  moduleCache.set(absolutePath, module.exports);
  return module.exports;
}

// abortSignal 是纯工具模块，直接装载真实实现。
mocks['@shared/runtime/abortSignal'] = load('src/shared/runtime/abortSignal.ts');

// ── SQLite 执行器 ────────────────────────────────────────

function createExecutor(db) {
  const raw = {
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
    execAsync: async (sql) => {
      db.exec(sql);
    },
  };
  return createCoordinatedSqliteFixture(raw).executor;
}

// ── 生产模块 ─────────────────────────────────────────────

const schemaModule = load('src/platform/persistence/sqlite/schema.ts');
const momentsSchemaModule = load('src/platform/persistence/sqlite/momentsSchema.ts');
const repositoryModule = load('src/features/moments/infrastructure/SQLiteMomentRepository.ts');
const accessModule = load('src/features/moments/application/MomentAccess.ts');
const createMomentModule = load('src/features/moments/application/CreateMoment.ts');
const facadeModule = load('src/features/moments/presentationFacade.ts');
const likeTool = load('src/features/moments/aiTools/AILikeMomentTool.ts');
const commentTool = load('src/features/moments/aiTools/AICommentMomentTool.ts');
const detailTool = load('src/features/moments/aiTools/GetMomentDetailTool.ts');
const searchTool = load('src/features/moments/aiTools/SearchMomentsTool.ts');
const createTool = load('src/features/moments/aiTools/AICreateMomentTool.ts');
const replyTool = load('src/features/moments/aiTools/AIReplyMomentCommentTool.ts');
const unlikeTool = load('src/features/moments/aiTools/AIUnlikeMomentTool.ts');
const deleteMomentTool = load('src/features/moments/aiTools/AIDeleteOwnMomentTool.ts');
const deleteCommentTool = load('src/features/moments/aiTools/AIDeleteOwnMomentCommentTool.ts');
const uiPermissions = load('src/features/moments/presentation/momentItem/permissions.ts');

assert.equal(
  uiPermissions.canManageMomentAIComments(true, 1),
  true,
  '用户自己的 Moment 有 AI 评论时必须显示管理入口',
);
assert.equal(
  uiPermissions.canManageMomentAIComments(false, 1),
  false,
  'AI-authored Moment 即使有 AI 评论也不得显示管理入口',
);
assert.equal(
  uiPermissions.canDeleteMomentCommentFromUserUI({
    isOwnMoment: false,
    isOwnComment: true,
    commentActorType: 'user',
  }),
  true,
  '用户自己的评论仍必须提供删除入口',
);
assert.equal(
  uiPermissions.canDeleteMomentCommentFromUserUI({
    isOwnMoment: true,
    isOwnComment: false,
    commentActorType: 'ai',
  }),
  true,
  '用户自己的 Moment 下 AI 评论仍必须提供管理入口',
);
assert.equal(
  uiPermissions.canDeleteMomentCommentFromUserUI({
    isOwnMoment: false,
    isOwnComment: false,
    commentActorType: 'ai',
  }),
  false,
  'AI-authored Moment 下其他 AI 评论不得提供删除入口',
);

assert.deepEqual(
  [searchTool, detailTool, likeTool, commentTool].map((tool) => tool.definition.name),
  ['searchMoments', 'getMomentDetail', 'aiLikeMoment', 'aiCommentMoment'],
  '既有四个 Moments 生产 Tool name 必须保持稳定',
);
assert.deepEqual(
  [createTool, replyTool, unlikeTool, deleteMomentTool, deleteCommentTool]
    .map((tool) => tool.definition.name),
  [
    'aiCreateMoment',
    'aiReplyMomentComment',
    'aiUnlikeMoment',
    'aiDeleteOwnMoment',
    'aiDeleteOwnMomentComment',
  ],
  'M2 新 Tool name 必须保持生产 Registry 使用的 camelCase 风格',
);
assert.equal(
  Object.hasOwn(createTool.definition.parameters.properties, 'locationLabel'),
  false,
  'AI create 第一版不得暴露 locationLabel',
);
assert.equal(
  Object.hasOwn(createTool.definition.parameters.properties, 'mediaAssetIds'),
  false,
  'AI create 第一版不得暴露 mediaAssetIds',
);
assert.doesNotMatch(
  read('src/features/moments/presentation/MomentsTab.tsx'),
  /triggerAIAutoInteraction|triggerAIReplyToMomentComment/,
  'M3 后生产 Moments Presentation 不得再调用 V1 即时 AI 互动',
);
assert.match(
  momentsSchemaModule.MOMENT_SOCIAL_INBOX_DELIVERIES_SCHEMA,
  /moment_social_inbox_deliveries/,
  'M3 必须提供 Moments 自有的 Social Inbox schema',
);

assert.ok(schemaModule.SCHEMAS.moments, 'SCHEMAS 必须包含 moments');
assert.ok(schemaModule.SCHEMAS.momentAudienceAi, 'SCHEMAS 必须包含 moment_audience_ai');

const MOMENT_INDEX_KEYS = [
  'idxMomentsCreatedAt',
  'idxMomentAudienceAiViewer',
  'idxCommentsMomentCreated',
  'idxCommentsParentId',
  'idxMomentSocialInboxRecipientUnreadSeq',
  'idxMomentSocialInboxRecipientMomentUnreadSeq',
  'idxMomentSocialInboxSourceComment',
  'idxMomentSocialInboxTargetComment',
  'idxMomentSocialInboxUnreadLikeRevoke',
  'idxMomentMediaMomentSort',
  'idxMomentMediaAsset',
];
const MOMENT_TABLES = [
  'moments',
  'moment_audience_ai',
  'moment_comments',
  'moment_likes',
  'moment_social_inbox_deliveries',
  'moment_media',
  'moment_settings',
];

function applyMomentIndexes(db) {
  for (const key of MOMENT_INDEX_KEYS) {
    const sql = schemaModule.INDEXES[key];
    assert.ok(sql, `INDEXES 必须包含 ${key}`);
    db.exec(sql);
  }
}

function describeDatabase(db) {
  const description = {};
  for (const table of MOMENT_TABLES) {
    description[table] = {
      columns: db.prepare(`PRAGMA table_info('${table}')`).all()
        .map((row) => ({
          name: row.name,
          type: row.type,
          notnull: row.notnull,
          pk: row.pk,
          dflt: row.dflt_value,
        })),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list('${table}')`).all()
        .map((row) => ({
          table: row.table,
          from: row.from,
          to: row.to,
          onUpdate: row.on_update,
          onDelete: row.on_delete,
        }))
        .sort((left, right) => left.from.localeCompare(right.from)),
      indexes: db.prepare(`PRAGMA index_list('${table}')`).all()
        .map((row) => ({
          name: row.name,
          unique: row.unique,
          columns: db.prepare(`PRAGMA index_info('${row.name}')`).all()
            .map((info) => info.name),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
  return description;
}

// ── 1. fresh schema ─────────────────────────────────────

const freshDb = new DatabaseSync(':memory:');
freshDb.exec('PRAGMA foreign_keys = ON;');
for (const sql of Object.values(schemaModule.SCHEMAS)) {
  freshDb.exec(sql);
}
for (const sql of Object.values(schemaModule.INDEXES)) {
  try {
    freshDb.exec(sql);
  } catch {
    // 与 initialization.ts 一致：单个索引失败不阻断建库。
  }
}

assert.equal(
  freshDb.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'moment_ai_interactions'",
  ).get().count,
  0,
  'fresh schema 不得再创建 moment_ai_interactions',
);
assert.deepEqual(
  freshDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'moment%' ORDER BY name",
  ).all().map((row) => row.name),
  [...MOMENT_TABLES].sort(),
  'fresh schema 必须存在七张 Moments V2/M5 表',
);

// ── 2. upgraded schema（V1 → 迁移87）────────────────────

const upgradedDb = new DatabaseSync(':memory:');
upgradedDb.exec('PRAGMA foreign_keys = ON;');
upgradedDb.exec(`
  CREATE TABLE ai_assistants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );
  CREATE TABLE moments (
    id TEXT PRIMARY KEY,
    user_name TEXT NOT NULL,
    avatar TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE moment_comments (
    id TEXT PRIMARY KEY,
    moment_id TEXT NOT NULL,
    agent_id TEXT,
    user_name TEXT NOT NULL,
    avatar TEXT,
    content TEXT NOT NULL,
    is_ai INTEGER DEFAULT 0,
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
  );
  CREATE TABLE moment_likes (
    id TEXT PRIMARY KEY,
    moment_id TEXT NOT NULL,
    agent_id TEXT,
    user_name TEXT NOT NULL,
    is_ai INTEGER DEFAULT 0,
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
  );
  CREATE TABLE moment_ai_interactions (
    id TEXT PRIMARY KEY,
    moment_id TEXT NOT NULL,
    agent_id TEXT,
    ai_name TEXT NOT NULL,
    has_liked INTEGER DEFAULT 0,
    has_commented INTEGER DEFAULT 0,
    comment_content TEXT,
    interacted_at TEXT NOT NULL,
    UNIQUE(moment_id, ai_name),
    FOREIGN KEY (moment_id) REFERENCES moments(id) ON DELETE CASCADE
  );
`);
// V1 升级路径：parent_comment_id 是 ALTER 加进来的，没有 FK（fresh 与 upgraded 的已知差异）。
upgradedDb.exec(`ALTER TABLE moment_comments ADD COLUMN parent_comment_id TEXT;`);
upgradedDb.exec(`CREATE INDEX idx_comments_parent_id ON moment_comments(parent_comment_id);`);
upgradedDb.exec(`CREATE UNIQUE INDEX idx_moment_likes_unique ON moment_likes(moment_id, user_name);`);

// V1 开发期数据：必须在迁移中被清理，不能用用户名猜稳定身份。
upgradedDb.exec(`
  INSERT INTO ai_assistants (id, agent_id, name) VALUES ('ai-b', 'agent-b', 'AI乙');
  INSERT INTO moments (id, user_name, avatar, content, created_at)
    VALUES ('moment-v1', '旧名字', 'file:///legacy.png', 'V1 朋友圈', '2026-01-01T00:00:00.000Z');
  INSERT INTO moment_comments (id, moment_id, agent_id, user_name, avatar, content, is_ai, parent_comment_id)
    VALUES ('comment-v1', 'moment-v1', NULL, '旧名字', 'file:///legacy-avatar.png', 'V1 评论', 1, NULL);
  INSERT INTO moment_likes (id, moment_id, agent_id, user_name, is_ai)
    VALUES ('like-v1', 'moment-v1', 'agent-b', 'AI乙', 1);
  INSERT INTO moment_ai_interactions (id, moment_id, agent_id, ai_name, has_liked, has_commented, interacted_at)
    VALUES ('interaction-v1', 'moment-v1', 'agent-b', 'AI乙', 1, 1, '2026-01-01T00:00:10.000Z');
  CREATE TABLE unrelated_owner_data (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  INSERT INTO unrelated_owner_data (id, payload) VALUES ('chat-1', '不属于 Moments 的数据');
`);

const upgradedExecutor = createExecutor(upgradedDb);
await momentsSchemaModule.migrateMomentsV2(upgradedExecutor);
await momentsSchemaModule.migrateMomentSocialInbox(upgradedExecutor);
await momentsSchemaModule.migrateMomentMediaAndSettings(upgradedExecutor);
await momentsSchemaModule.migrateMomentLocationLabel(upgradedExecutor);
applyMomentIndexes(upgradedDb);

for (const table of MOMENT_TABLES) {
  assert.equal(
    upgradedDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    0,
    `${table} 的 V1 开发期数据必须被清理，不得按用户名猜稳定身份`,
  );
}
assert.equal(
  upgradedDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'moment_ai_interactions'").get().count,
  0,
  '升级路径必须退役 moment_ai_interactions 物理表',
);
assert.deepEqual(
  { ...upgradedDb.prepare("SELECT * FROM unrelated_owner_data WHERE id = 'chat-1'").get() },
  { id: 'chat-1', payload: '不属于 Moments 的数据' },
  'Moments 迁移不得触碰其他 owner 的数据',
);
assert.equal(
  upgradedDb.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_moment_likes_unique'",
  ).get().count,
  0,
  '按 user_name 的点赞唯一索引必须随重建一起消失',
);

// fresh 与 upgraded 的结构必须逐字段一致：这是 M1 的硬性不变量。
assert.deepEqual(
  describeDatabase(upgradedDb),
  describeDatabase(freshDb),
  'fresh schema 与 V1 升级 schema 的列、FK、索引必须完全一致',
);

// 既有 V2 → all_except 必须走独立的数据保留迁移，不能重放 migration87。
const existingV2Db = new DatabaseSync(':memory:');
existingV2Db.exec('PRAGMA foreign_keys = ON;');
existingV2Db.exec(`
  CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
  INSERT INTO ai_assistants (id, agent_id, name) VALUES ('ai-b', 'agent-b', 'AI乙');
  CREATE TABLE moments (
    id TEXT PRIMARY KEY,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'ai')),
    author_id TEXT NOT NULL,
    author_name_snapshot TEXT NOT NULL,
    content TEXT NOT NULL,
    audience_mode TEXT NOT NULL DEFAULT 'all' CHECK (audience_mode IN ('all', 'selected')),
    created_at TEXT NOT NULL
  );
  ${momentsSchemaModule.MOMENT_AUDIENCE_AI_SCHEMA}
  ${momentsSchemaModule.MOMENT_COMMENTS_SCHEMA}
  ${momentsSchemaModule.MOMENT_LIKES_SCHEMA}
  INSERT INTO moments VALUES
    ('moment-existing-all', 'user', 'self', '用户', '保留 all', 'all', '2026-09-18T00:00:00.000Z'),
    ('moment-existing-selected', 'user', 'self', '用户', '保留 selected', 'selected', '2026-09-18T00:00:01.000Z');
  INSERT INTO moment_audience_ai VALUES ('moment-existing-selected', 'agent-b');
  INSERT INTO moment_comments VALUES
    ('comment-existing', 'moment-existing-selected', 'ai', 'agent-b', 'AI乙', NULL, '保留评论', '2026-09-18T00:00:02.000Z');
  INSERT INTO moment_likes VALUES
    ('moment-existing-selected', 'ai', 'agent-b', 'AI乙', '2026-09-18T00:00:03.000Z');
`);
await momentsSchemaModule.migrateMomentsAudienceAllExcept(createExecutor(existingV2Db));
await momentsSchemaModule.migrateMomentSocialInbox(createExecutor(existingV2Db));
await momentsSchemaModule.migrateMomentMediaAndSettings(createExecutor(existingV2Db));
await momentsSchemaModule.migrateMomentLocationLabel(createExecutor(existingV2Db));
applyMomentIndexes(existingV2Db);
assert.equal(
  existingV2Db.prepare('SELECT COUNT(*) AS count FROM moment_social_inbox_deliveries').get().count,
  0,
  'migration91 不得根据历史 Moment/comment/like 回填 Social Inbox delivery',
);
assert.deepEqual(
  existingV2Db.prepare('PRAGMA foreign_key_check').all(),
  [],
  'migration90 + migration91 + migration92 后必须继续通过 foreign_key_check',
);
assert.deepEqual(
  {
    moments: existingV2Db.prepare('SELECT COUNT(*) AS count FROM moments').get().count,
    audience: existingV2Db.prepare('SELECT COUNT(*) AS count FROM moment_audience_ai').get().count,
    comments: existingV2Db.prepare('SELECT COUNT(*) AS count FROM moment_comments').get().count,
    likes: existingV2Db.prepare('SELECT COUNT(*) AS count FROM moment_likes').get().count,
  },
  { moments: 2, audience: 1, comments: 1, likes: 1 },
  'all_except 迁移必须保留全部既有 V2 Moment / audience / comment / like 数据',
);
assert.deepEqual(
  describeDatabase(existingV2Db),
  describeDatabase(freshDb),
  '既有 V2 升级到 all_except 后必须与 fresh schema 完全一致',
);
const parentForeignKey = describeDatabase(freshDb).moment_comments.foreignKeys
  .find((fk) => fk.from === 'parent_comment_id');
assert.deepEqual(
  parentForeignKey,
  {
    table: 'moment_comments',
    from: 'parent_comment_id',
    to: 'id',
    onUpdate: 'NO ACTION',
    onDelete: 'SET NULL',
  },
  'parent_comment_id 必须存在且 fresh / upgraded 行为一致（V1 已知差异必须修平）',
);

// 迁移必须挂在真实 bootstrap 链路上，否则上面的执行验证不代表生产行为。
assert.match(
  read('src/platform/persistence/sqlite/schema.ts'),
  /moments: MOMENTS_SCHEMA/,
  'schema.ts 必须直接复用 momentsSchema 的建表常量',
);
for (const legacyColumn of ['user_name', 'has_liked', 'has_commented', 'interacted_at']) {
  assert.ok(
    !momentsSchemaModule.MOMENTS_SCHEMA.includes(legacyColumn),
    `V2 moments 建表语句不得包含 legacy 列 ${legacyColumn}`,
  );
}

// ── 3. 运行时库（仓储 + application + tools）─────────────

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
for (const sql of Object.values(schemaModule.SCHEMAS)) {
  db.exec(sql);
}
for (const sql of Object.values(schemaModule.INDEXES)) {
  try {
    db.exec(sql);
  } catch {
    // 忽略与本次验证无关的索引失败。
  }
}
db.exec(`
  INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at)
    VALUES ('ai-b', 'agent-b', 'AI乙', 'model-b', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z');
  INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at)
    VALUES ('ai-c', 'agent-c', 'AI丙', 'model-c', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z');
`);

const executor = createExecutor(db);
currentExecutor = executor;
const repository = new repositoryModule.SQLiteMomentRepository();

const agentB = { agentId: 'agent-b', nameSnapshot: 'AI乙' };
const agentC = { agentId: 'agent-c', nameSnapshot: 'AI丙' };
const audienceDirectory = {
  listAgentIds: async () => ['agent-b', 'agent-c'],
};

function createToolContext(agentId, name) {
  return {
    sharedState: {},
    aiConfig: { avatar: null },
    repositories: { moment: repository },
    getAgentId: () => agentId,
    getAIName: () => name,
    isBlocked: () => false,
  };
}

// ── 4. 稳定作者身份 + 改名语义 ───────────────────────────

const userMoment = await createMomentModule.createUserMoment(repository, audienceDirectory, {
  content: '  用户发的朋友圈  ',
});
assert.equal(userMoment.authorType, 'user');
assert.equal(userMoment.authorId, 'self');
assert.equal(userMoment.authorNameSnapshot, '用户甲');
assert.equal(userMoment.audienceMode, 'all');
assert.equal(userMoment.content, '用户发的朋友圈', '正文必须 trim 后写入');
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moment_audience_ai WHERE moment_id = ?').get(userMoment.id).count,
  0,
  'audience_mode=all 不得写入 audience 关系行',
);

const aiMoment = await createMomentModule.createAgentMoment(repository, audienceDirectory, {
  agentId: 'agent-b',
  nameSnapshot: 'AI乙',
  content: 'AI 发的朋友圈',
});
assert.equal(aiMoment.authorType, 'ai');
assert.equal(aiMoment.authorId, 'agent-b', 'AI 作者身份必须是不可变 agentId');
assert.equal(aiMoment.audienceMode, 'all');

// 用户改名：历史行不重写，展示按 authorId 解析当前名称。
identity.profile = { ...identity.profile, name: '用户乙', avatar: 'asset://user-new' };
let records = await facadeModule.listMomentRecords(identity.profile, { limit: 50, offset: 0 });
const renamedUserMoment = records.find((record) => record.id === userMoment.id);
assert.equal(renamedUserMoment.userName, '用户乙', '用户改名后展示必须解析当前名称');
assert.equal(renamedUserMoment.avatar, 'asset://user-new');
assert.equal(renamedUserMoment.actorId, 'self');
assert.equal(
  db.prepare('SELECT author_name_snapshot FROM moments WHERE id = ?').get(userMoment.id).author_name_snapshot,
  '用户甲',
  '改名不得重写历史 Moment 行',
);

// AI 改名：agentId 不变，展示解析新名称，历史行不动。
identity.assistants = identity.assistants.map((assistant) => (
  assistant.agentId === 'agent-b' ? { ...assistant, name: 'AI乙改名' } : assistant
));
records = await facadeModule.listMomentRecords(identity.profile, { limit: 50, offset: 0 });
const renamedAIMoment = records.find((record) => record.id === aiMoment.id);
assert.equal(renamedAIMoment.userName, 'AI乙改名', 'AI 改名后展示必须解析当前名称');
assert.equal(renamedAIMoment.actorId, 'agent-b');
assert.equal(
  db.prepare('SELECT author_name_snapshot FROM moments WHERE id = ?').get(aiMoment.id).author_name_snapshot,
  'AI乙',
  'AI 改名不得重写历史 Moment 行',
);

// assistant 被删除后，历史 Moment 用快照兜底展示。
identity.assistants = identity.assistants.filter((assistant) => assistant.agentId !== 'agent-c');
const orphanMoment = await createMomentModule.createAgentMoment(repository, audienceDirectory, {
  agentId: 'agent-c',
  nameSnapshot: 'AI丙',
  content: '已删除 AI 的历史朋友圈',
});
records = await facadeModule.listMomentRecords(identity.profile, { limit: 50, offset: 0 });
assert.equal(
  records.find((record) => record.id === orphanMoment.id).userName,
  'AI丙',
  '作者已删除时展示必须退回写入时的名称快照',
);

// ── 5. AI audience 可见性 ────────────────────────────────

const selectedMoment = await createMomentModule.createUserMoment(
  repository,
  audienceDirectory,
  { content: '只给 AI乙看', audience: { mode: 'selected', viewerAgentIds: ['agent-b', 'agent-b'] } },
);
assert.equal(selectedMoment.audienceMode, 'selected');
const { createMomentShareSnapshot } = load('src/features/moments/application/ShareMoment.ts');
const unreadBeforeShare = (await repository.listUnreadSocialDeliveries('agent-b', { limit: 100 })).length;
const userShare = await createMomentShareSnapshot(repository, selectedMoment.id);
const aiShare = await createMomentShareSnapshot(repository, selectedMoment.id, 'agent-b');
assert.equal(userShare.momentId, selectedMoment.id);
assert.deepEqual(aiShare, userShare, '用户与可见 AI 获取同一正文图片快照');
assert.equal('comments' in userShare, false); assert.equal('likes' in userShare, false);
assert.equal((await repository.listUnreadSocialDeliveries('agent-b', { limit: 100 })).length, unreadBeforeShare, '准备分享不消费社交未读');
await assert.rejects(createMomentShareSnapshot(repository, selectedMoment.id, 'agent-c'), error => error.code === 'moment_not_visible');
assert.equal((await repository.getMomentDetailForUser(selectedMoment.id)).id, selectedMoment.id);
assert.equal(await repository.getMomentDetailForUser('missing-moment'), null);
assert.deepEqual(
  db.prepare('SELECT viewer_agent_id FROM moment_audience_ai WHERE moment_id = ?').all(selectedMoment.id)
    .map((row) => row.viewer_agent_id),
  ['agent-b'],
  '重复 audience ID 必须幂等归一，关系表只保留一行',
);

assert.ok(
  await repository.getVisibleMomentForAgent('agent-b', selectedMoment.id),
  'selected audience 中的 AI 必须可见',
);
assert.equal(
  await repository.getVisibleMomentForAgent('agent-c', selectedMoment.id),
  null,
  '不在 selected audience 中的 AI 必须不可见',
);
assert.ok(
  (await repository.queryVisibleMomentsForAgent('agent-b', { limit: 1, keyword: selectedMoment.content }))
    .some((m) => m.id === selectedMoment.id),
  'AI 搜索必须返回可见的 selected Moment',
);
assert.ok(
  !(await repository.queryVisibleMomentsForAgent('agent-c', { limit: 1, keyword: selectedMoment.content }))
    .some((m) => m.id === selectedMoment.id),
  'AI 搜索不得返回不可见的 selected Moment',
);
assert.ok(
  await repository.getVisibleMomentForAgent('agent-b', userMoment.id),
  'audience=all 对任意 AI 可见',
);
assert.ok(
  await repository.getVisibleMomentForAgent('agent-c', userMoment.id),
  'audience=all 对任意 AI 可见',
);

const allExceptMoment = await createMomentModule.createUserMoment(
  repository,
  audienceDirectory,
  {
    content: '不给 AI丙看',
    audience: { mode: 'all_except', viewerAgentIds: ['agent-c', 'agent-c'] },
  },
);
assert.equal(allExceptMoment.audienceMode, 'all_except');
assert.deepEqual(
  db.prepare('SELECT viewer_agent_id FROM moment_audience_ai WHERE moment_id = ?').all(allExceptMoment.id)
    .map((row) => row.viewer_agent_id),
  ['agent-c'],
  'all_except deny list 必须对重复 agentId 幂等归一',
);
assert.ok(
  await repository.getVisibleMomentForAgent('agent-b', allExceptMoment.id),
  'all_except 对 deny list 外的 AI 可见',
);
assert.equal(
  await repository.getVisibleMomentForAgent('agent-c', allExceptMoment.id),
  null,
  'all_except 对 deny list 内的 AI 不可见',
);

const emptyAllExceptMoment = await createMomentModule.createUserMoment(
  repository,
  audienceDirectory,
  { content: '空 deny list', audience: { mode: 'all_except', viewerAgentIds: [] } },
);
assert.equal(emptyAllExceptMoment.audienceMode, 'all', '空 all_except 必须归一化为 all');
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moment_audience_ai WHERE moment_id = ?')
    .get(emptyAllExceptMoment.id).count,
  0,
  '归一化为 all 后不得保存 audience 行',
);

// AI 发布的 Moment：用户始终可见；audience 只约束其他 AI。
const aiSelectedMoment = await createMomentModule.createAgentMoment(
  repository,
  audienceDirectory,
  {
    agentId: 'agent-b',
    nameSnapshot: 'AI乙',
    content: 'AI 只给 AI丙看',
    audience: { mode: 'selected', viewerAgentIds: ['agent-c'] },
  },
);
assert.ok(
  (await repository.listMomentTimelineForUser()).some((moment) => moment.id === aiSelectedMoment.id),
  '用户始终能看到 AI 发布的 Moment，包括 selected audience',
);
assert.ok(
  await repository.getVisibleMomentForAgent('agent-c', aiSelectedMoment.id),
  'selected audience 中的 AI 必须可见',
);
assert.ok(
  await repository.getVisibleMomentForAgent('agent-b', aiSelectedMoment.id),
  'AI 作者对自己的 Moment 天然可见（即使未写进 audience）',
);
assert.ok(
  await repository.getVisibleMomentForAgent('agent-b', selectedMoment.id),
  'audience=all 的用户 Moment 对 AI 可见（含作者自己）',
);

// ── 6. 隐藏 AI 的读写必须被拒绝 ──────────────────────────

const hiddenMomentId = selectedMoment.id;
const hiddenDetail = await detailTool.execute({ momentId: hiddenMomentId }, createToolContext('agent-c', 'AI丙'));
assert.equal(hiddenDetail.success, false, '不可见 AI 不得读取 Moment 详情');
const missingDetail = await detailTool.execute({ momentId: 'missing-moment' }, createToolContext('agent-c', 'AI丙'));
assert.equal(hiddenDetail.error, missingDetail.error, '不可见和不存在必须保持相同失败语义，禁止探测隐藏内容');
assert.match(hiddenDetail.error, /searchMoments/u, '目标失效后必须提供可见内容的查询入口');
assert.equal(hiddenDetail.data, undefined, '不可见 AI 不得拿到任何 Moment 数据（含评论）');

const hiddenSearch = await searchTool.execute({}, createToolContext('agent-c', 'AI丙'));
assert.equal(hiddenSearch.success, true);
assert.ok(
  !(hiddenSearch.data || []).some((moment) => moment.id === hiddenMomentId),
  '不可见 AI 的列表读不得包含隐藏 Moment',
);

const hiddenComment = await commentTool.execute(
  { momentId: hiddenMomentId, content: '偷偷评论' },
  createToolContext('agent-c', 'AI丙'),
);
assert.equal(hiddenComment.success, false, '不可见 AI 不得评论');
const hiddenLike = await likeTool.execute({ momentId: hiddenMomentId }, createToolContext('agent-c', 'AI丙'));
assert.equal(hiddenLike.success, false, '不可见 AI 不得点赞');

const [hiddenReplyTarget] = await accessModule.commentMomentAsAgent(
  repository,
  agentB,
  hiddenMomentId,
  ['只给可见 AI 的评论'],
);
assert.equal(
  (await replyTool.execute(
    { commentId: hiddenReplyTarget.id, content: '越权回复' },
    createToolContext('agent-c', 'AI丙'),
  )).success,
  false,
  '不可见 AI 不得通过 reply Tool 越过 ACL',
);
assert.equal(
  (await unlikeTool.execute(
    { momentId: hiddenMomentId },
    createToolContext('agent-c', 'AI丙'),
  )).success,
  false,
  '不可见 AI 不得通过 unlike Tool 越过 ACL',
);
const [legacyHiddenOwnComment] = await repository.insertComments([{
  id: 'comment-hidden-agent-c',
  momentId: hiddenMomentId,
  authorType: 'ai',
  authorId: 'agent-c',
  authorNameSnapshot: 'AI丙',
  parentCommentId: null,
  content: 'ACL 建立前的历史评论',
}]);
assert.equal(
  (await deleteCommentTool.execute(
    { commentId: legacyHiddenOwnComment.id },
    createToolContext('agent-c', 'AI丙'),
  )).success,
  false,
  '即使历史评论属于自己，隐藏 AI 也不得通过删除 Tool 越过所属 Moment ACL',
);
assert.ok(await repository.getComment(legacyHiddenOwnComment.id));

await assert.rejects(
  () => accessModule.assertMomentVisibleToAgent(repository, 'agent-c', hiddenMomentId),
  (error) => error.code === 'moment_not_visible',
  '可见性断言必须对不可见 AI 抛结构化失败',
);

// 可见 AI 能正常读详情。
const visibleDetail = await detailTool.execute({ momentId: hiddenMomentId }, createToolContext('agent-b', 'AI乙'));
assert.equal(visibleDetail.success, true, '可见 AI 必须能读取详情');

// ── 6.5 M2 Tools：trusted author、reply、unlike 与 ownership ───────────────

identity.assistants = [
  { id: 'ai-b', agentId: 'agent-b', name: 'AI乙', avatar: null },
  { id: 'ai-c', agentId: 'agent-c', name: 'AI丙', avatar: null },
];
const createdByTool = await createTool.execute(
  {
    content: 'AI Tool 发布',
    audience: { mode: 'selected', agentIds: ['agent-c'] },
    authorType: 'user',
    authorId: 'spoofed',
  },
  createToolContext('agent-b', 'AI乙'),
);
assert.equal(createdByTool.success, true);
const storedToolMoment = await repository.getMomentForUser(createdByTool.data.momentId);
assert.equal(storedToolMoment.authorType, 'ai');
assert.equal(storedToolMoment.authorId, 'agent-b', 'AI create 作者只能来自 trusted ToolContext');
assert.equal(storedToolMoment.audienceMode, 'selected');

const momentCountBeforeUnknownAudience = db.prepare(
  'SELECT COUNT(*) AS count FROM moments',
).get().count;
const unknownAudienceResult = await createTool.execute(
  {
    content: '不存在 audience 的 Tool 调用',
    audience: { mode: 'selected', agentIds: ['agent-does-not-exist'] },
  },
  createToolContext('agent-b', 'AI乙'),
);
assert.equal(unknownAudienceResult.success, false);
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moments').get().count,
  momentCountBeforeUnknownAudience,
  'Tool candidate 不是权限真值：不存在的 agentId 仍必须由 Application 目录拒绝且零写入',
);

const userReplyTarget = await facadeModule.createUserMomentComment(
  createdByTool.data.momentId,
  '请回复这条评论',
);
const toolReply = await replyTool.execute(
  { commentId: userReplyTarget.id, content: '通过 commentId 回复' },
  createToolContext('agent-b', 'AI乙'),
);
assert.equal(toolReply.success, true, 'reply Tool 必须只通过 commentId 反查 Moment');
const storedReply = (await repository.listComments(createdByTool.data.momentId))
  .find((comment) => comment.parentCommentId === userReplyTarget.id);
assert.equal(storedReply?.momentId, createdByTool.data.momentId);
assert.equal(storedReply?.authorId, 'agent-b');

await accessModule.likeMomentAsAgent(repository, agentB, createdByTool.data.momentId);
assert.equal(
  (await unlikeTool.execute(
    { momentId: createdByTool.data.momentId },
    createToolContext('agent-b', 'AI乙'),
  )).success,
  true,
  'AI unlike 必须删除自己的点赞事实',
);
assert.equal(
  (await repository.listLikes(createdByTool.data.momentId))
    .some((like) => like.actorId === 'agent-b'),
  false,
);

assert.equal(
  (await deleteMomentTool.execute(
    { momentId: createdByTool.data.momentId },
    createToolContext('agent-c', 'AI丙'),
  )).success,
  false,
  'AI 不得删除其他 actor 的 Moment',
);
assert.equal(
  (await deleteCommentTool.execute(
    { commentId: storedReply.id },
    createToolContext('agent-c', 'AI丙'),
  )).success,
  false,
  'AI 不得删除其他 actor 的 comment',
);
assert.ok(await repository.getMomentForUser(createdByTool.data.momentId));
assert.ok(await repository.getComment(storedReply.id));
assert.equal(
  (await deleteCommentTool.execute(
    { commentId: storedReply.id },
    createToolContext('agent-b', 'AI乙'),
  )).success,
  true,
  'AI 可以删除自己的 comment',
);
assert.equal(
  (await deleteMomentTool.execute(
    { momentId: createdByTool.data.momentId },
    createToolContext('agent-b', 'AI乙'),
  )).success,
  true,
  'AI 可以删除自己的 Moment',
);

// 用户 UI/Application ownership：自己的评论可删，自己 Moment 下的 AI 评论可管理；
// AI-authored Moment 下其他 AI 的评论不可删。
const userOwnedForModeration = await createMomentModule.createUserMoment(
  repository,
  audienceDirectory,
  { content: '用户自己的 Moment' },
);
const [aiCommentOnUserMoment] = await accessModule.commentMomentAsAgent(
  repository,
  agentB,
  userOwnedForModeration.id,
  ['用户可管理的 AI 评论'],
);
assert.equal(
  await facadeModule.removeMomentCommentById(aiCommentOnUserMoment.id),
  true,
  '用户仍可管理自己 Moment 下的 AI 评论',
);

const aiOwnedForUserComment = await createMomentModule.createAgentMoment(
  repository,
  audienceDirectory,
  { agentId: 'agent-b', nameSnapshot: 'AI乙', content: 'AI 发布的 Moment' },
);
const ownUserComment = await facadeModule.createUserMomentComment(
  aiOwnedForUserComment.id,
  '用户自己的评论',
);
assert.equal(
  await facadeModule.removeMomentCommentById(ownUserComment.id),
  true,
  '用户仍可删除自己在 AI Moment 下发表的评论',
);
const [otherAICommentOnAIMoment] = await accessModule.commentMomentAsAgent(
  repository,
  agentC,
  aiOwnedForUserComment.id,
  ['用户无权管理的其他 AI 评论'],
);
await assert.rejects(
  () => facadeModule.removeMomentCommentById(otherAICommentOnAIMoment.id),
  (error) => error.code === 'not_comment_owner',
  '用户不能删除 AI Moment 下其他 AI 的评论',
);
assert.ok(await repository.getComment(otherAICommentOnAIMoment.id));

// ── 7. 评论、回复与回复完整性 ────────────────────────────

const [aiComment] = await accessModule.commentMomentAsAgent(
  repository,
  agentB,
  selectedMoment.id,
  ['AI 的评论'],
);
assert.equal(aiComment.authorType, 'ai');
assert.equal(aiComment.authorId, 'agent-b', '评论作者身份必须是 agentId');
assert.equal(aiComment.parentCommentId, null);
assert.equal(
  aiComment.authorNameSnapshot,
  'AI乙',
  '评论名称快照与 Moment 作者身份同源',
);

await assert.rejects(
  () => accessModule.replyMomentCommentAsAgent(repository, agentC, aiComment.id, ['不可见的回复']),
  (error) => error.code === 'moment_not_visible',
  '不可见 AI 不得回复该 Moment 的评论',
);

const [userReply] = await repository.insertComments([{
  id: 'comment-user-reply',
  momentId: selectedMoment.id,
  authorType: 'user',
  authorId: 'self',
  authorNameSnapshot: identity.profile.name,
  parentCommentId: aiComment.id,
  content: '用户回复 AI',
}]);
assert.equal(userReply.parentCommentId, aiComment.id, '回复必须保留直接 parentCommentId');

const [aiReply] = await accessModule.replyMomentCommentAsAgent(
  repository,
  agentB,
  userReply.id,
  ['AI 回复用户'],
);
assert.equal(aiReply.parentCommentId, userReply.id);
assert.equal(aiReply.momentId, selectedMoment.id, '回复必须落在 parent comment 所属 Moment');

// 读到父评论后、写入回复前被删除：真实事务拒绝仍进入工具的精确业务反馈。
const [raceParent] = await repository.insertComments([{
  id: 'reply-race-parent', momentId: userMoment.id, authorType: 'user', authorId: 'self',
  authorNameSnapshot: identity.profile.name, parentCommentId: null, content: '即将删除的父评论',
}]);
const raceContext = createToolContext('agent-b', 'AI乙');
raceContext.repositories.moment = {
  getComment: async id => {
    const comment = await repository.getComment(id);
    await repository.deleteComment(id);
    return comment;
  },
  getVisibleMomentForAgent: repository.getVisibleMomentForAgent.bind(repository),
  insertComments: repository.insertComments.bind(repository),
};
const momentErrors = [], oldMomentConsoleError = console.error;
console.error = (...args) => momentErrors.push(args);
try {
  const rejected = await replyTool.execute({ commentId: raceParent.id, content: '不能回复已删除的评论' }, raceContext);
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /不要重复使用失效或猜测的 commentId/);
  assert.equal(momentErrors.length, 0, '父评论竞态不误报为内部异常');
  const commentsBefore = db.prepare('SELECT COUNT(*) AS count FROM moment_comments').get().count;
  db.exec("CREATE TRIGGER reject_moment_comment BEFORE INSERT ON moment_comments BEGIN SELECT RAISE(ABORT,'moment storage failure'); END;");
  try {
    const failed = await commentTool.execute({ momentId: userMoment.id, content: '不能部分保存' }, createToolContext('agent-b', 'AI乙'));
    assert.equal(failed.success, false);
    assert.equal(momentErrors.length, 1);
    assert.ok(momentErrors[0][1] instanceof databaseErrors.CoordinatedDatabaseError);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moment_comments').get().count, commentsBefore);
  } finally { db.exec('DROP TRIGGER reject_moment_comment'); }
} finally { console.error = oldMomentConsoleError; }

await assert.rejects(
  () => repository.insertComments([{
    id: 'comment-cross-moment',
    momentId: userMoment.id,
    authorType: 'user',
    authorId: 'self',
    authorNameSnapshot: identity.profile.name,
    parentCommentId: aiComment.id,
    content: '跨 Moment 的非法回复',
  }]),
  (error) => error.code === 'comment_moment_mismatch',
  '禁止跨 Moment 挂载回复',
);
assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM moment_comments WHERE id = 'comment-cross-moment'").get().count,
  0,
  '被拒绝的回复不得留下任何写入',
);

// ── 8. 点赞的稳定身份与唯一性 ────────────────────────────

const firstLike = await repository.insertLike({
  momentId: aiMoment.id,
  actorType: 'ai',
  actorId: 'agent-b',
  actorNameSnapshot: 'AI乙',
});
assert.ok(firstLike, '首次点赞必须成功');
assert.equal(
  await repository.insertLike({
    momentId: aiMoment.id,
    actorType: 'ai',
    actorId: 'agent-b',
    actorNameSnapshot: 'AI乙改名',
  }),
  null,
  '同一稳定 identity 重复点赞必须被拒绝',
);
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moment_likes WHERE moment_id = ?').get(aiMoment.id).count,
  1,
  '重复点赞不得产生第二行事实',
);
assert.equal(
  db.prepare('SELECT actor_name_snapshot FROM moment_likes WHERE moment_id = ? AND actor_id = ?')
    .get(aiMoment.id, 'agent-b').actor_name_snapshot,
  'AI乙',
  '重复点赞不得改写既有快照',
);

// 改名不漂移：改名后同一 actor 的点赞身份仍然是同一个。
assert.equal(await repository.removeLike(aiMoment.id, 'ai', 'agent-b'), true, '改名后 unlike 必须命中同一行');
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moment_likes WHERE moment_id = ?').get(aiMoment.id).count,
  0,
);

const userLike = await repository.insertLike({
  momentId: aiMoment.id,
  actorType: 'user',
  actorId: 'self',
  actorNameSnapshot: identity.profile.name,
});
assert.ok(userLike, '不同 actor 可以点赞同一条 Moment');
assert.equal(userLike.actorType, 'user');
assert.equal(userLike.actorId, 'self', '用户点赞身份必须是 SELF_USER_PROFILE_ID 而不是名称');

// ── 9. audience 写入校验与原子性 ─────────────────────────

await assert.rejects(
  () => createMomentModule.createUserMoment(repository, audienceDirectory, {
    content: 'audience 指向不存在的 AI',
    audience: { mode: 'selected', viewerAgentIds: ['agent-missing'] },
  }),
  (error) => error.code === 'unknown_audience_agent_id',
  'selected audience 必须结构化拒绝不存在的 AI',
);
await assert.rejects(
  () => createMomentModule.createUserMoment(repository, audienceDirectory, {
    content: 'audience 为空',
    audience: { mode: 'selected', viewerAgentIds: [] },
  }),
  (error) => error.code === 'empty_audience',
  'selected audience 必须有至少一个 AI',
);
await assert.rejects(
  () => createMomentModule.createUserMoment(repository, audienceDirectory, {
    content: 'audience 含空 ID',
    audience: { mode: 'selected', viewerAgentIds: ['  '] },
  }),
  (error) => error.code === 'malformed_audience_agent_id',
  'selected audience 必须拒绝畸形 ID',
);
await assert.rejects(
  () => createMomentModule.createUserMoment(repository, audienceDirectory, {
    content: 'bad all_except audience',
    audience: { mode: 'all_except', viewerAgentIds: ['agent-missing'] },
  }),
  (error) => error.code === 'unknown_audience_agent_id',
  'all_except audience 必须结构化拒绝不存在的 AI',
);
await assert.rejects(
  () => createMomentModule.createUserMoment(repository, audienceDirectory, {
    content: 'malformed all_except audience',
    audience: { mode: 'all_except', viewerAgentIds: ['  '] },
  }),
  (error) => error.code === 'malformed_audience_agent_id',
  'all_except audience 必须拒绝畸形 ID',
);
await assert.rejects(
  () => createMomentModule.createUserMoment(repository, audienceDirectory, { content: '   ' }),
  (error) => error.code === 'empty_content',
  '空正文必须被结构化拒绝',
);

const momentCountBeforeAtomicCheck = db.prepare('SELECT COUNT(*) AS count FROM moments').get().count;
await assert.rejects(
  () => repository.createMoment({
    id: 'moment-atomic-check',
    authorType: 'user',
    authorId: 'self',
    authorNameSnapshot: identity.profile.name,
    content: '关系行写入失败时整条 Moment 必须回滚',
    audience: { mode: 'selected', viewerAgentIds: ['agent-does-not-exist'] },
    deliveryRecipientAgentIds: [],
  }),
  'audience 关系行违反外键时必须失败',
);
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moments').get().count,
  momentCountBeforeAtomicCheck,
  'Moment 行与 audience 行必须原子提交：关系行失败不得留下半完成 Moment',
);

// ── 10. 级联删除与 assistant 删除行为 ────────────────────

const cascadeMoment = await createMomentModule.createUserMoment(repository, audienceDirectory, {
  content: '用于级联删除验证',
  audience: { mode: 'selected', viewerAgentIds: ['agent-b'] },
});
const [cascadeComment] = await repository.insertComments([{
  id: 'comment-cascade',
  momentId: cascadeMoment.id,
  authorType: 'ai',
  authorId: 'agent-b',
  authorNameSnapshot: 'AI乙',
  parentCommentId: null,
  content: '级联评论',
}]);
await repository.insertComments([{
  id: 'comment-cascade-child',
  momentId: cascadeMoment.id,
  authorType: 'user',
  authorId: 'self',
  authorNameSnapshot: identity.profile.name,
  parentCommentId: cascadeComment.id,
  content: '级联回复',
}]);
await repository.insertLike({
  momentId: cascadeMoment.id,
  actorType: 'ai',
  actorId: 'agent-b',
  actorNameSnapshot: 'AI乙',
});

assert.equal(await repository.deleteMoment(cascadeMoment.id), true);
for (const table of ['moment_comments', 'moment_likes', 'moment_audience_ai']) {
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE moment_id = ?`).get(cascadeMoment.id).count,
    0,
    `删除 Moment 必须级联清理 ${table}`,
  );
}

// parent comment 被删除后，回复保留为顶层评论（ON DELETE SET NULL）。
const [replyParent] = await repository.insertComments([{
  id: 'comment-parent-for-set-null',
  momentId: aiMoment.id,
  authorType: 'user',
  authorId: 'self',
  authorNameSnapshot: identity.profile.name,
  parentCommentId: null,
  content: '父评论',
}]);
await repository.insertComments([{
  id: 'comment-child-of-deleted-parent',
  momentId: aiMoment.id,
  authorType: 'user',
  authorId: 'self',
  authorNameSnapshot: identity.profile.name,
  parentCommentId: replyParent.id,
  content: '子回复',
}]);
await repository.deleteComment(replyParent.id);
assert.equal(
  db.prepare("SELECT parent_comment_id FROM moment_comments WHERE id = 'comment-child-of-deleted-parent'").get().parent_comment_id,
  null,
  '父评论删除后回复保留为顶层评论',
);

// assistant 删除：历史社交事实保留，audience 行随 AI 删除清理。
const aiAuthoredCommentId = aiComment.id;
db.exec("DELETE FROM ai_assistants WHERE agent_id = 'agent-b'");
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moments WHERE author_type = ? AND author_id = ?').get('ai', 'agent-b').count > 0,
  true,
  'AI 被删除后其历史 Moment 必须保留（author_id 不对 ai_assistants 级联）',
);
assert.ok(
  db.prepare('SELECT 1 AS present FROM moment_comments WHERE id = ?').get(aiAuthoredCommentId),
  'AI 被删除后其历史评论必须保留',
);
assert.ok(
  db.prepare('SELECT 1 AS present FROM moment_likes WHERE moment_id = ? AND actor_id = ?').get(aiMoment.id, 'self'),
  '其他 actor 的点赞事实不受删除影响',
);
assert.equal(
  db.prepare('SELECT COUNT(*) AS count FROM moment_audience_ai WHERE viewer_agent_id = ?').get('agent-b').count,
  0,
  '被删除 AI 的 audience 行必须被清理（viewer 已不存在）',
);

// ── 11. 退役状态与 factory reset 覆盖 ───────────────────

// 生产代码里不允许再有 SQL 级别的 legacy 状态表读写（表名只允许出现在迁移的退役清单中）。
const LEGACY_INTERACTION_SQL = /(?:FROM|INTO|TABLE|JOIN|UPDATE)\s+(?:IF\s+NOT\s+EXISTS\s+)?moment_ai_interactions/i;
for (const relativePath of collectSourceFiles('src')) {
  if (LEGACY_INTERACTION_SQL.test(read(relativePath))) {
    assert.fail(`${relativePath} 仍在生产代码中读写已退役的 moment_ai_interactions`);
  }
}
assert.doesNotMatch(
  read('src/features/moments/domain/MomentRepository.ts'),
  /AIInteraction|interactedAt|InteractionPermission|canAIInteract/,
  'domain 端口不得再表达 V1 的互动状态机',
);
assert.match(
  read('src/platform/persistence/sqlite/momentsSchema.ts'),
  /moment_ai_interactions/,
  '退役的表必须由迁移显式清理，而不是遗留在设备上',
);
assert.match(
  read('src/platform/persistence/helpers.ts'),
  /sqlite_master/,
  'factory reset 必须继续从 sqlite_master 动态枚举表',
);
assert.doesNotMatch(
  read('src/platform/persistence/helpers.ts'),
  /DELETE FROM moments;/,
  'factory reset 不得回落成手写表清单',
);
const clearableTables = db.prepare(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${MOMENT_TABLES.map(() => '?').join(', ')})`,
).all(...MOMENT_TABLES).map((row) => row.name).sort();
assert.deepEqual(
  clearableTables,
  [...MOMENT_TABLES].sort(),
  'factory reset 的动态枚举必须能覆盖 Moments 的五张表',
);
assert.match(
  read('src/platform/persistence/helpers.ts'),
  /moment_audience_ai/,
  '数据库诊断必须报告新的 audience 表',
);
assert.doesNotMatch(
  read('src/platform/persistence/helpers.ts'),
  /momentAIInteractions/,
  '数据库诊断不得再报告已退役的互动状态表',
);

console.log('Moments V2 Domain / Schema / Visibility 验证通过。');

function collectSourceFiles(relativeDirectory) {
  const root = path.join(ROOT, relativeDirectory);
  const result = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        result.push(path.relative(ROOT, entryPath).replaceAll('\\', '/'));
      }
    }
  };
  walk(root);
  return result;
}
