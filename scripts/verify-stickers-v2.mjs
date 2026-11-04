/**
 * Sticker System V2 的确定性契约验证。
 *
 * 覆盖设计文档（docs/sticker-system-v2-implementation-plan.md 第 14 节）：
 * - sticker_annotation capability 已从代码与数据库清理；
 * - Sticker System 只保存模型引用，不复制 API Key / Base URL；
 * - recognition 只接受 连接完整的 ocr 配置、embedding 只接受 连接完整的 embedding 配置；
 * - 迁移 84 建立 semantic_revision / sticker_system_config / sticker_embeddings
 *   并删除旧 sticker_annotation binding / model config；
 * - 语义文本、向量有效性、hybrid rerank 与分组浏览分页的纯函数契约；
 * - 第 8 节起在真实 node:sqlite 上跑真实 repository / application 路径：
 *   semantic 候选集不被 UI 列表分页截断、收藏库 500 上限、semanticRevision
 *   三条写路径、无 Buffer 环境的 cursor、当前模型展示投影、模型切换唤醒信号。
 *
 * 真实 expo-sqlite 外键 / Android 真机行为仍需人工验收，见文档第 14 节 UI / queue 部分。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

async function importSource(relativePath) {
  return import(transpileToModuleUrl(read(relativePath)));
}

// ---------------------------------------------------------------------------
// 1. Model selection / cleanup：capability 与 UI 分类中不存在 sticker_annotation
// ---------------------------------------------------------------------------
const auxiliaryModelModule = await importSource(
  'src/features/assistants/domain/AuxiliaryModel.ts',
);
const capabilityKinds = [...auxiliaryModelModule.CAPABILITY_KINDS];
assert.ok(
  !capabilityKinds.includes('sticker_annotation'),
  'CAPABILITY_KINDS 不得再包含 sticker_annotation',
);

const capabilityMetaModule = await importSource(
  'src/features/assistants/presentation/auxiliaryModels/constants.ts',
);
assert.ok(
  !Object.keys(capabilityMetaModule.CAPABILITY_META).includes('sticker_annotation'),
  '辅助模型中心分类卡不得再出现表情包识别模型',
);

// 全源码层面不允许出现旧 capability（包括 resolver / gateway / binding 特判）。
// 迁移 84 的 DELETE 清理 SQL 与说明性注释是文档明确要求的唯一合法出现位置。
function collectSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    return ['.ts', '.tsx', '.mjs'].includes(path.extname(entry.name)) ? [entryPath] : [];
  });
}
function stripCommentLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}
const legacyHits = [];
for (const filePath of collectSourceFiles(path.join(ROOT, 'src'))) {
  const source = stripCommentLines(fs.readFileSync(filePath, 'utf8'));
  if (!source.includes('sticker_annotation')) continue;
  const relativePath = path.relative(ROOT, filePath);
  if (relativePath.replaceAll('\\', '/') === 'src/platform/persistence/sqlite/migrations.ts') {
    // 清理 SQL 必须只出现在迁移 84 的 DELETE 语句里。
    const activeLines = source.split('\n').filter((line) => line.includes('sticker_annotation'));
    const nonDelete = activeLines.filter((line) => !line.includes('DELETE FROM'));
    assert.deepEqual(
      nonDelete,
      [],
      `migrations.ts 中 sticker_annotation 只能出现在 DELETE 清理语句里: ${nonDelete.join(' | ')}`,
    );
    continue;
  }
  legacyHits.push(relativePath);
}
assert.deepEqual(legacyHits, [], `sticker_annotation 残留于: ${legacyHits.join(', ')}`);

// ---------------------------------------------------------------------------
// 2. Sticker-owned 模型解析规则
// ---------------------------------------------------------------------------
const { evaluateStickerModelConfig } = await importSource(
  'src/features/stickers/domain/StickerSystemConfig.ts',
);

const validOcr = {
  id: 'ocr-1',
  capabilityKind: 'ocr',
  name: '视觉模型',
  enabled: true,
  baseUrl: 'https://example.com/v1',
  apiKey: 'key',
  model: 'vision-model',
  temperature: null,
  topP: null,
  maxTokens: null,
  updatedAt: '2026-09-14T00:00:00.000Z',
};

assert.ok(evaluateStickerModelConfig(null, 'ocr') === null, '未配置模型必须返回 null');
assert.ok(
  evaluateStickerModelConfig({ ...validOcr, apiKey: null }, 'ocr') === null,
  '凭据缺失的模型必须被判不可用',
);
assert.ok(
  evaluateStickerModelConfig(validOcr, 'embedding') === null,
  'recognition 不得选择非 ocr 配置',
);
assert.ok(
  evaluateStickerModelConfig({ ...validOcr, capabilityKind: 'embedding' }, 'embedding') !== null,
  'embedding 可以选择连接完整的 embedding 配置',
);
assert.ok(
  evaluateStickerModelConfig(
    { ...validOcr, capabilityKind: 'embedding', apiKey: null },
    'embedding',
  ) === null,
  'embedding 不得选择凭据缺失的配置',
);

// Sticker System 配置实体只保存模型引用；字段面不含任何连接信息。
const stickerSystemConfigSource = read('src/features/stickers/domain/StickerSystemConfig.ts');
assert.ok(
  !stickerSystemConfigSource.includes('apiKey') || stickerSystemConfigSource.indexOf('apiKey') > stickerSystemConfigSource.indexOf('StickerModelConfigRef'),
  'StickerSystemConfig 实体不得持有 API Key',
);

// ---------------------------------------------------------------------------
// 3. 当前建库：模型引用、语义版本与级联删除
// ---------------------------------------------------------------------------
// 运行真实升级链，不再截取单个迁移函数体冻结当前实现。
const migrationModules = new Map();
function loadMigrationModule(relativePath) {
  const absolutePath = path.resolve(ROOT, relativePath);
  if (migrationModules.has(absolutePath)) return migrationModules.get(absolutePath);
  const output = ts.transpileModule(fs.readFileSync(absolutePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  migrationModules.set(absolutePath, module.exports);
  new Function('exports', 'require', 'module', output)(module.exports,
    (specifier) => loadMigrationModule(path.resolve(path.dirname(absolutePath), `${specifier}.ts`)), module);
  return module.exports;
}
const { SCHEMAS } = loadMigrationModule('src/platform/persistence/sqlite/schema.ts');
const { runMigrations, DATABASE_SCHEMA_VERSION } = loadMigrationModule('src/platform/persistence/sqlite/migrations.ts');
const stickerSchemaModule = await importSource('src/platform/persistence/sqlite/stickerSchema.ts');

function createAdapter(db) {
  return {
    execAsync: async (sql) => db.exec(sql),
    getFirstAsync: async (sql, params = []) => {
      const rows = db.prepare(sql).all(...params);
      return rows.length > 0 ? rows[0] : null;
    },
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
  };
}

function createCurrentDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const sql of Object.values(SCHEMAS)) db.exec(sql);
  db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
  db.exec(`INSERT INTO media_assets (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,status,created_at,updated_at)
    VALUES ('asset-1','app-private-file','test.png','sha256','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','image/png',1,'ready','2026-09-01','2026-09-01');
    INSERT INTO stickers (id,media_asset_id,name,mime_type,annotation_status,created_at,updated_at)
    VALUES ('sticker-1','asset-1','装无辜','image/png','ready','2026-09-01','2026-09-01');
    INSERT INTO auxiliary_model_configs (id,capability_kind,name,base_url,model,created_at,updated_at)
    VALUES ('cfg-ocr','ocr','视觉模型','https://example.invalid','test','2026-09-01','2026-09-01');`);
  return db;
}

// 160 升级保留完整旧索引，且不把未完成的历史索引授权为自动全量重建。
for (const complete of [true, false]) {
  const db = createCurrentDatabase();
  db.exec(`INSERT INTO auxiliary_model_configs (id, capability_kind, name, base_url, model, created_at, updated_at)
    VALUES ('cfg-vector', 'embedding', '向量', 'https://example.invalid', 'embed', '2026-09-01', '2026-09-01');
    INSERT INTO sticker_system_config (id, embedding_model_config_id, created_at, updated_at) VALUES ('global', 'cfg-vector', '2026-09-01', '2026-09-01');
    INSERT INTO sticker_embeddings VALUES ('sticker-1', 'cfg-vector', '${complete ? '2026-09-01' : 'old-version'}', 1, 3, '[1,0,0]', '2026-09-01', '2026-09-01');
    DROP TABLE memory_embedding_index_control; DROP TABLE sticker_embedding_index_control; PRAGMA user_version = 159;`);
  const retained = db.prepare('SELECT * FROM sticker_embeddings').all();
  await runMigrations(createAdapter(db));
  assert.deepEqual(db.prepare('SELECT * FROM sticker_embeddings').all(), retained);
  assert.equal(db.prepare('SELECT published_model_id FROM sticker_embedding_index_control').get().published_model_id, complete ? 'cfg-vector' : null);
  db.close();
}

// 从实际缺少失败表的 160 库升级，保留原表情与完整向量。
{
  const db = createCurrentDatabase();
  db.exec(`INSERT INTO sticker_embeddings VALUES ('sticker-1', 'vector-160', '2026-09-01', 1, 2, '[1,0]', '2026-09-01', '2026-09-01');
    DROP TABLE sticker_embedding_failures; PRAGMA user_version = 160;`);
  const retained = db.prepare('SELECT * FROM sticker_embeddings').all();
  await runMigrations(createAdapter(db));
  assert.deepEqual(db.prepare('SELECT * FROM sticker_embeddings').all(), retained);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sticker_embedding_failures').get().n, 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
  db.close();
}

{
  const db = createCurrentDatabase();
  await runMigrations(createAdapter(db));

  const stickerColumns = db.prepare(`PRAGMA table_info('stickers')`).all().map((c) => c.name);
  assert.ok(stickerColumns.includes('semantic_revision'), 'stickers 必须补齐 semantic_revision');
  const revisionRow = db.prepare(
    `SELECT semantic_revision FROM stickers WHERE id = 'sticker-1'`,
  ).get();
  assert.equal(revisionRow.semantic_revision, 1, '现有 Sticker 的 semantic_revision 必须初始化为 1');

  const configColumns = db.prepare(`PRAGMA table_info('sticker_system_config')`).all().map((c) => c.name);
  assert.ok(!configColumns.some(column => ['base_url', 'api_key', 'model'].includes(column)),
    '表情系统只保存业务开关与模型引用，不复制模型连接配置');

  const embeddingColumns = db.prepare(`PRAGMA table_info('sticker_embeddings')`).all().map((c) => c.name);
  for (const required of [
    'sticker_id', 'model_config_id', 'model_config_updated_at', 'semantic_revision',
    'dimension', 'vector_json', 'created_at', 'updated_at',
  ]) {
    assert.ok(embeddingColumns.includes(required), `sticker_embeddings 缺少 ${required}`);
  }

  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM auxiliary_model_configs WHERE capability_kind = 'sticker_annotation'`).get().n,
    0,
    '旧 sticker_annotation model config 必须被清理',
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('capability_bindings', 'assistant_capability_bindings')").all(),
    [],
    '旧绑定整体退休，不能留下 sticker_annotation 的默认选择路径',
  );
  assert.ok(
    db.prepare(`SELECT COUNT(*) AS n FROM auxiliary_model_configs WHERE id = 'cfg-ocr'`).get().n === 1,
    'ocr 配置不得被误删',
  );

  // 单例约束 + FK cascade。
  db.prepare(
    `INSERT INTO sticker_system_config (id, recognition_model_config_id, embedding_model_config_id, created_at, updated_at)
     VALUES ('global', 'cfg-ocr', NULL, '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')`,
  ).run();
  assert.throws(
    () => db.prepare(
      `INSERT INTO sticker_system_config (id, recognition_model_config_id, embedding_model_config_id, created_at, updated_at)
       VALUES ('other', NULL, NULL, '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')`,
    ).run(),
    'sticker_system_config 只允许 global 单例',
  );

  db.prepare(
    `INSERT INTO sticker_embeddings (sticker_id, model_config_id, model_config_updated_at, semantic_revision, dimension, vector_json, created_at, updated_at)
     VALUES ('sticker-1', 'cfg-ocr', '2026-09-14T00:00:00.000Z', 1, 3, '[1,2,3]', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')`,
  ).run();
  db.prepare(`DELETE FROM stickers WHERE id = 'sticker-1'`).run();
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM sticker_embeddings`).get().n,
    0,
    '删除 Sticker 必须级联删除向量',
  );
  db.close();
}

// ---------------------------------------------------------------------------
// 4. 语义文本 / 向量有效性 / 余弦
// ---------------------------------------------------------------------------
const { buildStickerSemanticText, isStickerEmbeddingValid, cosineSimilarity } =
  await importSource('src/features/stickers/domain/StickerEmbedding.ts');

const baseSticker = {
  id: 'sticker-1',
  mediaAssetId: 'asset-1',
  groupId: 'group-1',
  name: '装无辜',
  description: '被抓包以后装无辜的表情',
  tags: ['无辜', '心虚'],
  emotion: '心虚',
  sourceFileName: 'a.png',
  mimeType: 'image/png',
  width: 100,
  height: 100,
  isAnimated: false,
  isFavorite: true,
  useCount: 9,
  lastUsedAt: null,
  annotationStatus: 'ready',
  annotationError: null,
  semanticRevision: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
};

const semanticText = buildStickerSemanticText(baseSticker);
assert.ok(semanticText.includes('名称：装无辜'), '语义文本必须包含名称');
assert.ok(semanticText.includes('描述：'), '语义文本必须包含描述');
assert.ok(semanticText.includes('标签：无辜、心虚'), '语义文本必须包含标签');
assert.ok(semanticText.includes('情绪：心虚'), '语义文本必须包含情绪');
assert.ok(!semanticText.includes('group-1'), '分组不进入语义文本');
assert.ok(!semanticText.includes('a.png'), '文件名不进入语义文本');
assert.ok(!semanticText.includes('sticker-1'), 'stickerId 不进入语义文本');
assert.ok(
  !buildStickerSemanticText({ ...baseSticker, description: null, emotion: null, tags: [] }).includes('undefined'),
  '空字段必须整行省略',
);

const validContext = {
  modelConfigId: 'cfg-ocr',
  modelConfigUpdatedAt: '2026-09-14T00:00:00.000Z',
  semanticRevision: 3,
  dimension: 4,
};
assert.ok(
  isStickerEmbeddingValid(
    { modelConfigId: 'cfg-ocr', modelConfigUpdatedAt: '2026-09-14T00:00:00.000Z', semanticRevision: 3, dimension: 4 },
    validContext,
  ),
  '四元组全部匹配时向量有效',
);
assert.ok(
  !isStickerEmbeddingValid(
    { modelConfigId: 'other', modelConfigUpdatedAt: '2026-09-14T00:00:00.000Z', semanticRevision: 3, dimension: 4 },
    validContext,
  ),
  '模型 ID 不同 -> stale',
);
assert.ok(
  !isStickerEmbeddingValid(
    { modelConfigId: 'cfg-ocr', modelConfigUpdatedAt: '2026-09-15T00:00:00.000Z', semanticRevision: 3, dimension: 4 },
    validContext,
  ),
  '模型配置 updatedAt 不同 -> stale',
);
assert.ok(
  !isStickerEmbeddingValid(
    { modelConfigId: 'cfg-ocr', modelConfigUpdatedAt: '2026-09-14T00:00:00.000Z', semanticRevision: 4, dimension: 4 },
    validContext,
  ),
  'semantic revision 不同 -> stale',
);
assert.ok(
  !isStickerEmbeddingValid(
    { modelConfigId: 'cfg-ocr', modelConfigUpdatedAt: '2026-09-14T00:00:00.000Z', semanticRevision: 3, dimension: 8 },
    validContext,
  ),
  '维度不同 -> 不参与 cosine',
);
assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9, '同向向量余弦为 1');
assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9, '正交向量余弦为 0');

// ---------------------------------------------------------------------------
// 5. Hybrid rerank 与分组浏览分页
// ---------------------------------------------------------------------------
const searchModule = await importSource('src/features/stickers/domain/StickerSearch.ts');
const { rankStickerSearchCandidates, encodeStickerGroupPageCursor, decodeStickerGroupPageCursor } = searchModule;

const ranked = rankStickerSearchCandidates([
  { stickerId: 'weak', lexicalScore: 1, isFavorite: true, useCount: 100 },
  { stickerId: 'semantic-top', semanticScore: 0.95, lexicalScore: 0, isFavorite: false, useCount: 0 },
  { stickerId: 'semantic-mid', semanticScore: 0.8, lexicalScore: 0.5, isFavorite: false, useCount: 3 },
], 10);
assert.equal(ranked[0].stickerId, 'semantic-top', '语义相似度必须主导排序');
assert.ok(
  ranked.findIndex((item) => item.stickerId === 'semantic-mid') < ranked.findIndex((item) => item.stickerId === 'weak'),
  'favorite / 使用历史只能轻微 rerank，不得绕过 semantic / lexical 相关性',
);

const cursorA = encodeStickerGroupPageCursor({ createdAt: '2026-09-01T00:00:00.000Z', stickerId: 'sticker-9' });
assert.deepEqual(
  decodeStickerGroupPageCursor(cursorA),
  { createdAt: '2026-09-01T00:00:00.000Z', stickerId: 'sticker-9' },
  'cursor 编解码必须稳定',
);
assert.ok(decodeStickerGroupPageCursor('not-a-cursor') === null, '非法 cursor 必须按第一页处理');

// ---------------------------------------------------------------------------
// 6. Agent 工具契约（limit、调用顺序提示、snapshot 不含媒体细节）
// ---------------------------------------------------------------------------
const agentToolsSource = read('src/features/stickers/aiTools/StickerAgentTools.ts');
assert.ok(
  agentToolsSource.includes("name: 'list_sticker_groups'"),
  '必须注册 list_sticker_groups 工具',
);
assert.ok(
  agentToolsSource.includes("name: 'list_stickers_in_group'"),
  '必须注册 list_stickers_in_group 工具',
);
assert.ok(
  agentToolsSource.includes('STICKER_AI_SEARCH_DEFAULT_LIMIT'),
  'search_stickers 必须使用降低后的默认 limit',
);
assert.ok(
  /STICKER_AI_SEARCH_DEFAULT_LIMIT = 10/.test(read('src/features/stickers/application/StickerSearch.ts')),
  'search_stickers 默认 limit 应为 10（8~12 区间）',
);
// 工具正文措辞归作者，不设字面断言；这里只校验行为契约：
// search_stickers 的描述必须把分组工具写成「搜索之后的补充路径」。
const searchStickersDefinition = agentToolsSource.slice(
  agentToolsSource.indexOf('export const searchStickersDefinition'),
  agentToolsSource.indexOf('export const listStickerGroupsDefinition'),
);
assert.ok(
  searchStickersDefinition.includes('list_sticker_groups'),
  'search_stickers 描述必须说明分组工具只是搜索之后的补充路径',
);
// 分组结果的媒体 ID、向量提醒和文件内容隔离由 verify-ai-image-tools 行为测试覆盖。
assert.ok(
  !/必须来自 search_stickers/.test(agentToolsSource),
  'select_sticker 不得再限制 ID 必须来自搜索',
);

// ---------------------------------------------------------------------------
// 8. 真实 repository / application 行为
//
// 纯函数断言和源码字符串都证明不了“第 500 张 Sticker 仍能参与语义排序”这类
// 行为，因此这里把 Sticker 源码直接跑起来：相对导入递归内联，只把
// @platform/persistence 与 @features/media 两个真正的平台边界换成内存实现。
// 每个用例都在真实 node:sqlite 上执行真实 SQL。
// ---------------------------------------------------------------------------
const MODULE_STUBS = {
  '@platform/persistence': [
    ts.transpileModule(read('src/platform/persistence/runtime/DatabaseErrors.ts'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText,
    'export const databaseCoordinator = {',
    '  openTaskExecutor() {',
    '    if (!globalThis.__stickerVerifyExecutor) {',
    '      throw new Error("Sticker 验证 executor 尚未装配");',
    '    }',
    '    return globalThis.__stickerVerifyExecutor;',
    '  },',
    '};',
  ].join('\n'),
  '@features/media':
    'export const MEDIA_ASSET_STORAGE_BACKEND = { persistentImage: "persistent_image" };\n',
};

function createModuleLoader(stubs) {
  const urlByPath = new Map();
  const urlBySpecifier = new Map();
  const aliasPrefixes = [
    ['@shared/', 'src/shared/'],
    ['@platform/', 'src/platform/'],
    ['@features/', 'src/features/'],
    ['@host/', 'src/host/'],
  ];

  function toDataUrl(code) {
    return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  }

  function resolvePath(specifier, fromDirectory) {
    let base = null;
    if (specifier.startsWith('.')) {
      base = path.posix.normalize(path.posix.join(fromDirectory, specifier));
    } else {
      const matched = aliasPrefixes.find(([alias]) => specifier.startsWith(alias));
      if (matched) base = `${matched[1]}${specifier.slice(matched[0].length)}`;
    }
    if (!base) throw new Error(`无法解析模块说明符：${specifier}`);
    for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
      if (fs.existsSync(path.join(ROOT, candidate))) return candidate;
    }
    throw new Error(`找不到模块文件：${specifier}（来自 ${fromDirectory}）`);
  }

  function specifierUrl(specifier, fromDirectory) {
    if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
      if (!urlBySpecifier.has(specifier)) {
        urlBySpecifier.set(specifier, toDataUrl(stubs[specifier]));
      }
      return urlBySpecifier.get(specifier);
    }
    return moduleUrl(resolvePath(specifier, fromDirectory));
  }

  function moduleUrl(relativePath) {
    const key = path.posix.normalize(relativePath.replaceAll('\\', '/'));
    const cached = urlByPath.get(key);
    if (cached === 'RESOLVING') throw new Error(`检测到模块循环依赖：${key}`);
    if (cached) return cached;
    urlByPath.set(key, 'RESOLVING');
    const transpiled = ts.transpileModule(read(key), {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const fromDirectory = path.posix.dirname(key);
    const rewritten = transpiled.replace(
      /(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g,
      (match, prefix, quote, specifier) =>
        `${prefix}${quote}${specifierUrl(specifier, fromDirectory)}${quote}`,
    );
    const url = toDataUrl(rewritten);
    urlByPath.set(key, url);
    return url;
  }

  return {
    load(relativePath) {
      return import(moduleUrl(relativePath));
    },
  };
}

function createStickerDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE ai_assistants (id TEXT PRIMARY KEY);');
  db.exec('PRAGMA foreign_keys = ON;');
  // 只保留 stickers 外键需要的最小 media_assets 形态；MediaAsset 由内存网关提供。
  db.exec(`
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY NOT NULL,
      storage_backend TEXT NOT NULL DEFAULT 'persistent_image',
      storage_key TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'image/png',
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec(stickerSchemaModule.STICKER_SCHEMA);
  db.exec(stickerSchemaModule.STICKER_V2_SCHEMA);
  return db;
}

function createSqliteExecutor(db) {
  const executor = {
    getFirstAsync: async (sql, params = []) => {
      const rows = db.prepare(sql).all(...params);
      return rows.length > 0 ? rows[0] : null;
    },
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    execAsync: async (sql) => {
      db.exec(sql);
    },
    withExclusiveTransactionAsync: async (task) => {
      db.exec('BEGIN EXCLUSIVE');
      try {
        const value = await task(executor);
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    withExclusiveWriteScopeAsync: async (task) => task(executor),
  };
  return executor;
}

function seedMediaAsset(db, id) {
  db.prepare('INSERT INTO media_assets (id) VALUES (?)').run(id);
}

function seedSticker(db, row) {
  db.prepare(
    `INSERT INTO stickers (
       id, media_asset_id, group_id, name, description, tags_json, emotion,
       mime_type, is_animated, is_favorite, use_count, last_used_at,
       annotation_status, semantic_revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.mediaAssetId,
    row.groupId ?? null,
    row.name,
    row.description ?? null,
    JSON.stringify(row.tags ?? []),
    row.emotion ?? null,
    row.mimeType ?? 'image/png',
    row.isAnimated ? 1 : 0,
    row.isFavorite ? 1 : 0,
    row.useCount ?? 0,
    row.lastUsedAt ?? null,
    row.annotationStatus ?? 'ready',
    row.semanticRevision ?? 1,
    row.createdAt ?? '2026-09-01T00:00:00.000Z',
    row.updatedAt ?? '2026-09-01T00:00:00.000Z',
  );
}

function seedEmbedding(db, row) {
  db.prepare(
    `INSERT INTO sticker_embeddings (
       sticker_id, model_config_id, model_config_updated_at, semantic_revision,
       dimension, vector_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.stickerId,
    row.modelConfigId,
    row.modelConfigUpdatedAt,
    row.semanticRevision ?? 1,
    row.vector.length,
    JSON.stringify(row.vector),
    '2026-09-15T00:00:00.000Z',
    '2026-09-15T00:00:00.000Z',
  );
}

function readStickerRow(db, id) {
  return db.prepare(
    `SELECT name, description, tags_json, emotion, annotation_status, semantic_revision
     FROM stickers WHERE id = ?`,
  ).get(id);
}

function countStickerRows(db) {
  return db.prepare('SELECT COUNT(*) AS total FROM stickers').get().total;
}

const EMBEDDING_MODEL_ID = 'cfg-embed';
const EMBEDDING_MODEL_ALT_ID = 'cfg-embed-alt';
const RECOGNITION_MODEL_ID = 'cfg-ocr';
const INCOMPLETE_RECOGNITION_MODEL_ID = 'cfg-ocr-incomplete';
const MODEL_UPDATED_AT = '2026-09-15T00:00:00.000Z';

function buildModelConfig(id, capabilityKind, name, complete = true) {
  return {
    id,
    capabilityKind,
    name,
    baseUrl: 'https://example.com/v1',
    apiKey: complete ? 'verify-key' : null,
    model: `${capabilityKind}-demo`,
    temperature: null,
    topP: null,
    maxTokens: null,
    updatedAt: MODEL_UPDATED_AT,
  };
}

const modelConfigs = new Map([
  [EMBEDDING_MODEL_ID, buildModelConfig(EMBEDDING_MODEL_ID, 'embedding', '语义向量模型')],
  [EMBEDDING_MODEL_ALT_ID, buildModelConfig(EMBEDDING_MODEL_ALT_ID, 'embedding', '语义向量模型 B')],
  [RECOGNITION_MODEL_ID, buildModelConfig(RECOGNITION_MODEL_ID, 'ocr', '视觉识别模型 A')],
  [
    INCOMPLETE_RECOGNITION_MODEL_ID,
    buildModelConfig(INCOMPLETE_RECOGNITION_MODEL_ID, 'ocr', '连接未填完整的视觉模型', false),
  ],
]);

// 先装配一个 executor，repository 模块顶层会实例化默认 repository。
const bootstrapDb = createStickerDatabase();
globalThis.__stickerVerifyExecutor = createSqliteExecutor(bootstrapDb);

const loader = createModuleLoader(MODULE_STUBS);
const stickerDomainModule = await loader.load('src/features/stickers/domain/Sticker.ts');
const repositoryModule = await loader.load(
  'src/features/stickers/infrastructure/SQLiteStickerRepository.ts',
);
const runtimeModule = await loader.load('src/features/stickers/application/StickerRuntime.ts');
const commandsModule = await loader.load('src/features/stickers/application/StickerCommands.ts');
const aiSearchModule = await loader.load('src/features/stickers/application/StickerSearch.ts');
const systemModelsModule = await loader.load(
  'src/features/stickers/application/StickerSystemModels.ts',
);
const annotationPendingModule = await loader.load(
  'src/features/stickers/application/StickerAnnotationPendingSignal.ts',
);
const embeddingPendingModule = await loader.load(
  'src/features/stickers/application/StickerEmbeddingPendingSignal.ts',
);
const { SQLiteStickerRepository } = repositoryModule;
const { StickerLibraryFullError } = stickerDomainModule;

function createStickerHarness({ maxEmbeddingBatchSize = Infinity } = {}) {
  const db = createStickerDatabase();
  const executor = createSqliteExecutor(db);
  const repository = new SQLiteStickerRepository(executor);
  const mediaAssetsByUri = new Map();
  const embeddingRequests = { calls: 0, batchSizes: [] };
  let idSequence = 0;
  let assetSequence = 0;
  let timeSequence = 0;

  function activate() {
    runtimeModule.configureStickersRuntime({
      repository,
      withEmbeddingMaintenance: (operation, signal) => operation(signal ?? new AbortController().signal),
      media: {
        async createMediaAssetWithReference(input, commitReference) {
          const known = mediaAssetsByUri.get(input.sourceUri) ?? null;
          const committed = await executor.withExclusiveTransactionAsync(async (transaction) => {
            let asset = known;
            if (!asset) {
              assetSequence += 1;
              asset = { id: `asset-${String(assetSequence).padStart(4, '0')}` };
              await transaction.runAsync('INSERT INTO media_assets (id) VALUES (?)', [asset.id]);
            }
            const value = await commitReference({ transaction, asset });
            return { asset, reused: known !== null, value };
          });
          if (!committed.reused) mediaAssetsByUri.set(input.sourceUri, committed.asset);
          return committed;
        },
        async resolveMediaAsset() {
          return { localUri: 'file:///verify/media' };
        },
        async releaseMediaAssetCandidates() {},
      },
      auxiliaryModels: {
        getModelConfigById: async (id) => modelConfigs.get(id) ?? null,
        listModelConfigsByRequirement: async (requirement) =>
          [...modelConfigs.values()].filter((config) => config.capabilityKind === requirement),
      },
      embeddings: {
        async embedTexts(texts) {
          assert.ok(texts.length <= maxEmbeddingBatchSize, '向量请求必须满足服务的单次输入上限');
          embeddingRequests.calls += 1;
          embeddingRequests.batchSizes.push(texts.length);
          if (embeddingRequests.beforeReply) await embeddingRequests.beforeReply(texts);
          // 固定返回同向向量，让语义排序的胜负完全由库里存的向量决定。
          return texts.map(() => [1, 0, 0]);
        },
      },
      generateId: () => {
        idSequence += 1;
        return `sticker-${String(idSequence).padStart(4, '0')}`;
      },
      now: () => {
        timeSequence += 1;
        return new Date(Date.UTC(2026, 8, 15, 0, 0, timeSequence)).toISOString();
      },
    });
  }

  return { db, executor, repository, embeddingRequests, activate };
}

const main = createStickerHarness();
main.activate();

// ---------------------------------------------------------------------------
// 9. semantic search 必须扫描当前过滤条件下的全部 ready Sticker
// ---------------------------------------------------------------------------
const SEED_TOTAL = 500;
const SEED_WINNER_ID = `sticker-${String(SEED_TOTAL).padStart(4, '0')}`;

main.db.exec('BEGIN EXCLUSIVE');
for (let index = 1; index <= SEED_TOTAL; index += 1) {
  const stickerId = `sticker-${String(index).padStart(4, '0')}`;
  const mediaAssetId = `asset-seed-${String(index).padStart(4, '0')}`;
  seedMediaAsset(main.db, mediaAssetId);
  seedSticker(main.db, {
    id: stickerId,
    mediaAssetId,
    name: `通用表情 ${index}`,
    tags: ['通用'],
    emotion: '平静',
  });
  seedEmbedding(main.db, {
    stickerId,
    modelConfigId: EMBEDDING_MODEL_ID,
    modelConfigUpdatedAt: MODEL_UPDATED_AT,
    vector: index === SEED_TOTAL ? [1, 0, 0] : [-1, 0, 0],
  });
}
main.db.exec('COMMIT');

await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ID);

const uiPage = await main.repository.searchStickers({ readyOnly: true, limit: 200 });
assert.equal(uiPage.length, 200, '普通列表查询仍然按 STICKER_LIST_LIMIT 分页');
assert.ok(
  !uiPage.some((sticker) => sticker.id === SEED_WINNER_ID),
  '第 500 张必须落在 UI 分页之外，否则这个用例证明不了截断问题',
);

const semanticPool = await main.repository.listReadyStickersForSemanticSearch({});
assert.equal(
  semanticPool.length,
  SEED_TOTAL,
  '语义候选集必须覆盖当前过滤条件下的全部 ready Sticker，不得被 UI 列表分页截断',
);

const semanticResults = await aiSearchModule.searchStickersForAI({ query: '被抓包以后装无辜' });
assert.equal(semanticResults.length, 10, 'Agent observation 仍然只返回约 10 条');
assert.equal(
  semanticResults[0].id,
  SEED_WINNER_ID,
  '库里第 500 张 ready Sticker 必须仍能参与 semantic ranking',
);
assert.ok(
  !semanticResults[0].name.includes('被抓包'),
  '该命中必须来自语义相似度而不是词面关键词重合',
);

// ---------------------------------------------------------------------------
// 10. 收藏库 500 上限：499 -> 500 成功、500 -> 501 拒绝、复用不误报
// ---------------------------------------------------------------------------
const capacity = createStickerHarness();
capacity.activate();

function importPicture(index) {
  const fileName = `pic-${String(index).padStart(3, '0')}.png`;
  return commandsModule.importSticker({
    sourceUri: `file:///verify/${fileName}`,
    fileName,
    mimeType: 'image/png',
    fileSize: 4096,
    width: 64,
    height: 64,
    isAnimated: false,
  });
}

for (let index = 1; index <= 499; index += 1) {
  const imported = await importPicture(index);
  assert.equal(imported.stickerReused, false, '新内容不得被误判为复用');
}
assert.equal(countStickerRows(capacity.db), 499, '499 张时收藏库数量正确');

const importedFiveHundredth = await importPicture(500);
assert.equal(importedFiveHundredth.stickerReused, false);
assert.equal(countStickerRows(capacity.db), 500, '第 500 张必须导入成功');

await assert.rejects(
  () => importPicture(501),
  (error) => error instanceof StickerLibraryFullError,
  '达到 500 后必须拒绝新的非重复导入',
);
assert.equal(countStickerRows(capacity.db), 500, '被拒绝的导入不得留下半条记录');

const reusedAtCapacity = await importPicture(1);
assert.equal(reusedAtCapacity.stickerReused, true, '达到上限后复用既有 Sticker 不应误报容量已满');
assert.equal(reusedAtCapacity.mediaAssetReused, true, '同一份内容必须复用既有 MediaAsset');
assert.equal(countStickerRows(capacity.db), 500);

// ---------------------------------------------------------------------------
// 11. semanticRevision 三条写路径
// ---------------------------------------------------------------------------
const revision = createStickerHarness();
revision.activate();
await systemModelsModule.setStickerAutomaticRecognitionEnabled(true);

seedMediaAsset(revision.db, 'asset-edit');
seedSticker(revision.db, {
  id: 'sticker-edit',
  mediaAssetId: 'asset-edit',
  name: '原名',
  description: '原描述',
  tags: ['旧标签'],
  emotion: '平静',
});
assert.equal(readStickerRow(revision.db, 'sticker-edit').semantic_revision, 1);

await commandsModule.editStickerMetadata('sticker-edit', { name: '新名' });
assert.equal(
  readStickerRow(revision.db, 'sticker-edit').semantic_revision,
  2,
  'metadata 编辑实际变化 -> revision +1',
);

await commandsModule.editStickerMetadata('sticker-edit', { name: '新名' });
assert.equal(
  readStickerRow(revision.db, 'sticker-edit').semantic_revision,
  2,
  'metadata 编辑无实际变化 -> revision 不变',
);

await commandsModule.editStickerMetadata('sticker-edit', { tags: ['旧标签'] });
await commandsModule.editStickerMetadata('sticker-edit', { description: '原描述' });
await commandsModule.editStickerMetadata('sticker-edit', { emotion: '平静' });
assert.equal(
  readStickerRow(revision.db, 'sticker-edit').semantic_revision,
  2,
  'tags / description / emotion 无实际变化都不得递增',
);

await commandsModule.editStickerMetadata('sticker-edit', { tags: ['新标签'] });
assert.equal(
  readStickerRow(revision.db, 'sticker-edit').semantic_revision,
  3,
  'tags 实际变化 -> revision +1',
);

await commandsModule.toggleStickerFavorite('sticker-edit');
await commandsModule.recordUserStickerUse('sticker-edit');
assert.equal(
  readStickerRow(revision.db, 'sticker-edit').semantic_revision,
  3,
  'favorite / useCount 变化不得递增 revision',
);

const group = await commandsModule.createStickerGroup({ name: '验证分组' });
await commandsModule.moveStickerToGroup('sticker-edit', group.id);
assert.equal(
  readStickerRow(revision.db, 'sticker-edit').semantic_revision,
  3,
  '移动分组只改变 groupId，不得递增 revision',
);

seedMediaAsset(revision.db, 'asset-auto');
seedSticker(revision.db, {
  id: 'sticker-auto',
  mediaAssetId: 'asset-auto',
  name: '待识别',
  annotationStatus: 'pending',
});
const autoClaim = await commandsModule.claimStickerAnnotation({ claimId: 'claim-auto' });
assert.equal(autoClaim?.sticker.id, 'sticker-auto');
assert.equal(readStickerRow(revision.db, 'sticker-auto').annotation_status, 'processing');
await commandsModule.completeStickerAnnotation({
  stickerId: 'sticker-auto',
  claimId: 'claim-auto',
  metadata: {
    name: '装无辜',
    description: '被抓包以后装无辜',
    tags: ['无辜', '心虚'],
    emotion: '心虚',
  },
});
const autoCompleted = readStickerRow(revision.db, 'sticker-auto');
assert.equal(autoCompleted.annotation_status, 'ready');
assert.equal(autoCompleted.semantic_revision, 2, '自动识别写入实际变化 -> revision +1');

seedMediaAsset(revision.db, 'asset-auto-same');
seedSticker(revision.db, {
  id: 'sticker-auto-same',
  mediaAssetId: 'asset-auto-same',
  name: '同名',
  description: '同描述',
  tags: ['同标签'],
  emotion: '平静',
  annotationStatus: 'pending',
});
const sameClaim = await commandsModule.claimStickerAnnotation({ claimId: 'claim-same' });
assert.equal(sameClaim?.sticker.id, 'sticker-auto-same');
await commandsModule.completeStickerAnnotation({
  stickerId: 'sticker-auto-same',
  claimId: 'claim-same',
  metadata: { name: '同名', description: '同描述', tags: ['同标签'], emotion: '平静' },
});
assert.equal(
  readStickerRow(revision.db, 'sticker-auto-same').semantic_revision,
  1,
  '自动识别结果与原值相同 -> revision 不变',
);

seedMediaAsset(revision.db, 'asset-manual');
seedSticker(revision.db, {
  id: 'sticker-manual',
  mediaAssetId: 'asset-manual',
  name: '动态表情',
  annotationStatus: 'manual_required',
  isAnimated: true,
});
await commandsModule.completeStickerAnnotationManually('sticker-manual', {
  description: '手动补充的含义',
});
const manualCompleted = readStickerRow(revision.db, 'sticker-manual');
assert.equal(manualCompleted.annotation_status, 'ready');
assert.equal(manualCompleted.semantic_revision, 2, '手动完成标注实际变化 -> revision +1');

seedMediaAsset(revision.db, 'asset-manual-same');
seedSticker(revision.db, {
  id: 'sticker-manual-same',
  mediaAssetId: 'asset-manual-same',
  name: '动态表情 2',
  description: '已有含义',
  annotationStatus: 'manual_required',
  isAnimated: true,
});
await commandsModule.completeStickerAnnotationManually('sticker-manual-same', {
  description: '已有含义',
});
assert.equal(
  readStickerRow(revision.db, 'sticker-manual-same').semantic_revision,
  1,
  '手动完成标注无实际变化 -> revision 不变',
);

// ---------------------------------------------------------------------------
// 12. 当前绑定模型的展示投影（与 picker candidate list 分离）
// ---------------------------------------------------------------------------
main.activate();
await systemModelsModule.setStickerRecognitionModel(RECOGNITION_MODEL_ID);

let selection = await systemModelsModule.getStickerSystemModelSelection();
assert.equal(selection.recognition.status, 'active', '正常启用的绑定模型必须显示为可用');
assert.equal(selection.recognition.name, '视觉识别模型 A', '必须给出真实模型名称而不是占位文案');
assert.equal(selection.embedding.status, 'active');
assert.equal(selection.embedding.name, '语义向量模型', 'embedding 也必须显示真实模型名称');

function bindRecognitionRaw(modelConfigId) {
  main.db
    .prepare(`UPDATE sticker_system_config SET recognition_model_config_id = ? WHERE id = 'global'`)
    .run(modelConfigId);
}

bindRecognitionRaw(INCOMPLETE_RECOGNITION_MODEL_ID);
selection = await systemModelsModule.getStickerSystemModelSelection();
assert.equal(selection.recognition.status, 'incomplete', '凭据缺失的模型必须被判不可用');
assert.equal(selection.recognition.name, null);
assert.equal(selection.embedding.status, 'active', 'recognition 失效不得污染 embedding 的展示');

bindRecognitionRaw('cfg-does-not-exist');
selection = await systemModelsModule.getStickerSystemModelSelection();
assert.equal(selection.recognition.status, 'deleted', '被删除的模型必须与连接未填完整区分开');

bindRecognitionRaw(EMBEDDING_MODEL_ID);
selection = await systemModelsModule.getStickerSystemModelSelection();
assert.equal(
  selection.recognition.status,
  'capability_mismatch',
  'capability 不匹配的模型必须单独成一种状态',
);
assert.equal(selection.embedding.status, 'active');

bindRecognitionRaw(null);
selection = await systemModelsModule.getStickerSystemModelSelection();
assert.equal(selection.recognition.status, 'unconfigured', '未配置必须与不可用区分开');
assert.equal(selection.recognition.modelConfigId, null);

// ---------------------------------------------------------------------------
// 13. 向量模型切换不授权重建；识别队列仍由自己的配置提交唤醒。
// ---------------------------------------------------------------------------
let embeddingWakes = 0;
let annotationWakes = 0;
let embeddingPersistedAtWake = null;
let recognitionPersistedAtWake = null;

const unsubscribeEmbedding = embeddingPendingModule.subscribeStickerEmbeddingPending(() => {
  embeddingWakes += 1;
  embeddingPersistedAtWake = main.db
    .prepare(`SELECT embedding_model_config_id AS id FROM sticker_system_config WHERE id = 'global'`)
    .get().id;
});
const unsubscribeAnnotation = annotationPendingModule.subscribeStickerAnnotationPending(() => {
  annotationWakes += 1;
  recognitionPersistedAtWake = main.db
    .prepare(`SELECT recognition_model_config_id AS id FROM sticker_system_config WHERE id = 'global'`)
    .get().id;
});

await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ALT_ID);
assert.equal(embeddingWakes, 0, '设置 embedding 模型不得自动授权重建');
assert.equal(
  embeddingPersistedAtWake,
  null,
  '切换模型不发起向量队列信号',
);

await systemModelsModule.setStickerRecognitionModel(RECOGNITION_MODEL_ID);
assert.equal(annotationWakes, 1, '设置识别模型必须立刻发出标注队列唤醒信号');
assert.equal(
  recognitionPersistedAtWake,
  RECOGNITION_MODEL_ID,
  '唤醒信号必须发生在识别模型配置持久化成功之后',
);

await systemModelsModule.setStickerEmbeddingModel(null);
await systemModelsModule.setStickerRecognitionModel(null);
assert.equal(embeddingWakes, 0, '清空 embedding 模型不得制造额外唤醒');
assert.equal(annotationWakes, 1, '清空识别模型不得制造额外唤醒');
assert.equal(await systemModelsModule.resolveStickerEmbeddingModel(), null, '清空后 resolver 必须返回 null');
assert.equal(await systemModelsModule.resolveStickerRecognitionModel(), null, '清空后 resolver 必须返回 null');
unsubscribeEmbedding();
unsubscribeAnnotation();

// ---------------------------------------------------------------------------
// 14. cursor 不得依赖运行时 Node global Buffer
//
// 先把模块的 data URL 构造好（构造本身需要 Node 的 Buffer），再把这些全局置空，
// 然后才导入并调用。这样验证的是“在只有 Hermes 那种环境里也能跑”，
// 而不是“Node 恰好自带 Buffer 所以碰巧通过”。
// ---------------------------------------------------------------------------
{
  const cursorModuleUrl = transpileToModuleUrl(read('src/features/stickers/domain/StickerSearch.ts'));
  const savedGlobals = {
    Buffer: globalThis.Buffer,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  };
  globalThis.Buffer = undefined;
  globalThis.btoa = undefined;
  globalThis.atob = undefined;
  globalThis.TextEncoder = undefined;
  globalThis.TextDecoder = undefined;
  try {
    const { encodeStickerGroupPageCursor, decodeStickerGroupPageCursor } =
      await import(cursorModuleUrl);
    const cursor = {
      createdAt: '2026-09-01T00:00:00.000Z',
      stickerId: 'sticker-9f4c-中文-🎉',
    };
    const encoded = encodeStickerGroupPageCursor(cursor);
    assert.equal(typeof encoded, 'string');
    assert.ok(!/[+/=]/.test(encoded), 'cursor 必须是 base64url，不含标准 base64 的填充与符号');
    assert.deepEqual(
      decodeStickerGroupPageCursor(encoded),
      cursor,
      '没有 Buffer / btoa / atob / TextEncoder 时 cursor 编解码仍必须稳定',
    );
    assert.equal(decodeStickerGroupPageCursor('not-a-cursor'), null, '非法 cursor 必须安全返回 null');
    assert.equal(decodeStickerGroupPageCursor(''), null, '空 cursor 必须安全返回 null');
    assert.equal(decodeStickerGroupPageCursor('!!!!'), null, '非法字符必须安全返回 null');
    assert.equal(
      decodeStickerGroupPageCursor(encodeStickerGroupPageCursor({ createdAt: '', stickerId: '' })),
      null,
      '缺少有效字段的 cursor 必须返回 null',
    );
  } finally {
    Object.assign(globalThis, savedGlobals);
  }
}

// ---------------------------------------------------------------------------
// 15. semantic search 的 zero-valid-embedding fallback 边界
//
// 模型已配置、query embedding 成功、候选 Sticker 也非空，但候选里没有任何一条
// valid 向量（全缺失 / 全 stale / 维度不匹配）时，semanticScore 会全部缺省。
// 若仍进入 hybrid rerank，排序里只剩 lexical / favorite / usage，结果既不是
// 语义排序、也不等价于词面 fallback。契约要求 validEmbeddingCount === 0 时
// 整体退回 lexical，且这四元组判定必须继续用 isStickerEmbeddingValid。
// ---------------------------------------------------------------------------
const FALLBACK_QUERY = '装无辜';
const fallback = createStickerHarness();
fallback.activate();

// 命中词面的 4 张：favorite / useCount / lastUsedAt 各不相同，
// 使词面排序不是简单的 id 顺序，避免“顺序恰好一致”造成的假通过。
seedMediaAsset(fallback.db, 'asset-f1');
seedSticker(fallback.db, {
  id: 'sticker-0001',
  mediaAssetId: 'asset-f1',
  name: '装无辜',
  isFavorite: true,
});
seedMediaAsset(fallback.db, 'asset-f2');
seedSticker(fallback.db, {
  id: 'sticker-0002',
  mediaAssetId: 'asset-f2',
  name: '委屈',
  description: '被抓包以后装无辜',
  useCount: 5,
});
seedMediaAsset(fallback.db, 'asset-f3');
seedSticker(fallback.db, {
  id: 'sticker-0003',
  mediaAssetId: 'asset-f3',
  name: '委屈巴巴',
  tags: ['装无辜'],
  lastUsedAt: '2026-09-10T00:00:00.000Z',
});
seedMediaAsset(fallback.db, 'asset-f4');
seedSticker(fallback.db, { id: 'sticker-0004', mediaAssetId: 'asset-f4', name: '装无辜 2' });
// 词面完全不命中、但行为分最高：修复前它会被 hybrid 拉到前面，是主要破绽
seedMediaAsset(fallback.db, 'asset-f5');
seedSticker(fallback.db, {
  id: 'sticker-0005',
  mediaAssetId: 'asset-f5',
  name: '开心',
  isFavorite: true,
  useCount: 20,
});
seedMediaAsset(fallback.db, 'asset-f6');
seedSticker(fallback.db, { id: 'sticker-0006', mediaAssetId: 'asset-f6', name: '无语' });

await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ID);

function stickerIds(stickers) {
  return stickers.map((sticker) => sticker.id);
}

const lexicalExpectation = stickerIds(
  await fallback.repository.searchStickers({ readyOnly: true, query: FALLBACK_QUERY, limit: 10 }),
);
assert.deepEqual(
  lexicalExpectation,
  ['sticker-0001', 'sticker-0002', 'sticker-0003', 'sticker-0004'],
  '词面 oracle 必须只含命中 query 的 Sticker，且顺序由 favorite / useCount / lastUsedAt / id 决定',
);

// Case A：模型已配置、query embedding 成功、候选非空，但库里一条 embedding 都没有
assert.equal(
  (
    await fallback.repository.listStickerEmbeddingsByStickerIds(
      ['sticker-0001', 'sticker-0005'],
      EMBEDDING_MODEL_ID,
    )
  ).length,
  0,
  'Case A 前置条件：候选里没有任何 embedding row',
);
const zeroEmbeddingResult = await aiSearchModule.searchStickersForAI({ query: FALLBACK_QUERY });
assert.deepEqual(
  stickerIds(zeroEmbeddingResult),
  lexicalExpectation,
  'Case A 零 embedding：结果必须与 lexical fallback 完全一致（含完整 ID 顺序）',
);

// Case B：库里确实存在 embedding row，但三条分别因 revision / 指纹 / 维度失效
seedEmbedding(fallback.db, {
  stickerId: 'sticker-0001',
  modelConfigId: EMBEDDING_MODEL_ID,
  modelConfigUpdatedAt: MODEL_UPDATED_AT,
  semanticRevision: 99,
  vector: [1, 0, 0],
});
seedEmbedding(fallback.db, {
  stickerId: 'sticker-0002',
  modelConfigId: EMBEDDING_MODEL_ID,
  modelConfigUpdatedAt: '2026-01-01T00:00:00.000Z',
  semanticRevision: 1,
  vector: [1, 0, 0],
});
seedEmbedding(fallback.db, {
  stickerId: 'sticker-0003',
  modelConfigId: EMBEDDING_MODEL_ID,
  modelConfigUpdatedAt: MODEL_UPDATED_AT,
  semanticRevision: 1,
  vector: [1, 0, 0, 0, 0],
});
assert.equal(
  (
    await fallback.repository.listStickerEmbeddingsByStickerIds(
      ['sticker-0001', 'sticker-0002', 'sticker-0003'],
      EMBEDDING_MODEL_ID,
    )
  ).length,
  3,
  'Case B 前置条件：库里确实存在 embedding row，只是全部 stale（不是“没有行”）',
);
const allStaleResult = await aiSearchModule.searchStickersForAI({ query: FALLBACK_QUERY });
assert.deepEqual(
  stickerIds(allStaleResult),
  lexicalExpectation,
  'Case B 全部 stale：存在 row 不等于有效，结果必须与 lexical fallback 完全一致（含完整 ID 顺序）',
);

// Case C：只要存在 1 条 valid embedding，就必须继续 hybrid rerank（partial-index 不降级）
fallback.db.prepare('DELETE FROM sticker_embeddings').run();
seedEmbedding(fallback.db, {
  stickerId: 'sticker-0006',
  modelConfigId: EMBEDDING_MODEL_ID,
  modelConfigUpdatedAt: MODEL_UPDATED_AT,
  semanticRevision: 1,
  vector: [1, 0, 0],
});
const partialValidResult = await aiSearchModule.searchStickersForAI({ query: FALLBACK_QUERY });
assert.equal(
  partialValidResult[0].id,
  'sticker-0006',
  'Case C 存在 valid 向量时必须进入 hybrid rerank：语义相似度可以压过词面与行为分',
);
// 不断言完整分数顺序（hybrid 权重不是持久 contract），只断言候选集没被整体降级。
assert.deepEqual(
  [...stickerIds(partialValidResult)].sort(),
  ['sticker-0001', 'sticker-0002', 'sticker-0003', 'sticker-0004', 'sticker-0005', 'sticker-0006'],
  'Case C 候选集仍是结构过滤后的全部 ready Sticker，partial-index 不得被整体降级',
);
assert.notDeepEqual(
  stickerIds(partialValidResult),
  lexicalExpectation,
  'Case C 存在 valid 向量时结果不得等于纯词面排序',
);

try {
  fallback.embeddingRequests.beforeReply = async () => { throw new Error('模拟查询向量服务失败'); };
  assert.deepEqual(
    stickerIds(await aiSearchModule.searchStickersForAI({ query: FALLBACK_QUERY })),
    lexicalExpectation,
    '查询向量请求失败仍必须退回词面搜索',
  );
} finally {
  fallback.embeddingRequests.beforeReply = null;
}

const validVectorJson = fallback.db.prepare("SELECT vector_json FROM sticker_embeddings WHERE sticker_id = 'sticker-0006'").get().vector_json;
try {
  fallback.db.prepare("UPDATE sticker_embeddings SET vector_json = '{broken' WHERE sticker_id = 'sticker-0006'").run();
  await assert.rejects(
    aiSearchModule.searchStickersForAI({ query: FALLBACK_QUERY }),
    /Sticker 向量数据损坏/,
    '本地向量损坏不能被吞成普通词面结果',
  );
} finally {
  fallback.db.prepare("UPDATE sticker_embeddings SET vector_json = ? WHERE sticker_id = 'sticker-0006'").run(validVectorJson);
}

const searchAbortController = new AbortController();
try {
  fallback.embeddingRequests.beforeReply = async () => {
    const reason = new Error('模拟查询请求取消');
    searchAbortController.abort(reason);
    throw reason;
  };
  await assert.rejects(
    aiSearchModule.searchStickersForAI({ query: FALLBACK_QUERY }, { signal: searchAbortController.signal }),
    /模拟查询请求取消/,
    '取消信号不能转换成词面搜索成功结果',
  );
} finally {
  fallback.embeddingRequests.beforeReply = null;
}

// ---------------------------------------------------------------------------
// 16. 向量批次查询与空索引重建：真实联表必须返回 Sticker 自身的字段
// ---------------------------------------------------------------------------
const embeddingsModule = await loader.load('src/features/stickers/application/StickerEmbeddings.ts');
const indexing = createStickerHarness({ maxEmbeddingBatchSize: 10 });
indexing.activate();
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ID);

const indexContext = {
  modelConfigId: EMBEDDING_MODEL_ID,
  modelConfigUpdatedAt: MODEL_UPDATED_AT,
  dimension: null,
};
const indexIds = ['missing', 'other-model', 'stale-model', 'stale-revision', 'valid', 'wrong-dimension'];
for (const id of [...indexIds, 'not-ready']) {
  seedMediaAsset(indexing.db, `asset-${id}`);
  seedSticker(indexing.db, {
    id,
    mediaAssetId: `asset-${id}`,
    name: id,
    tags: ['测试标签'],
    semanticRevision: 2,
    annotationStatus: id === 'not-ready' ? 'pending' : 'ready',
  });
}

assert.deepEqual(
  stickerIds(await indexing.repository.listReadyStickersNeedingEmbedding(indexContext, 16)),
  indexIds,
  '从未建过索引时，批次查询必须返回全部 ready Sticker',
);
for (const [id, modelId, updatedAt, revision, vector] of [
  ['other-model', EMBEDDING_MODEL_ALT_ID, MODEL_UPDATED_AT, 2, [1, 0, 0]],
  ['stale-model', EMBEDDING_MODEL_ID, '2026-01-01T00:00:00.000Z', 2, [1, 0, 0]],
  ['stale-revision', EMBEDDING_MODEL_ID, MODEL_UPDATED_AT, 1, [1, 0, 0]],
  ['valid', EMBEDDING_MODEL_ID, MODEL_UPDATED_AT, 2, [1, 0, 0]],
  ['wrong-dimension', EMBEDDING_MODEL_ID, MODEL_UPDATED_AT, 2, [1, 0]],
]) {
  seedEmbedding(indexing.db, {
    stickerId: id,
    modelConfigId: modelId,
    modelConfigUpdatedAt: updatedAt,
    semanticRevision: revision,
    vector,
  });
}

const pendingIndexStickers = await indexing.repository.listReadyStickersNeedingEmbedding(indexContext, 16);
assert.deepEqual(
  stickerIds(pendingIndexStickers),
  ['missing', 'other-model', 'stale-model', 'stale-revision'],
  '批次只选择当前模型缺失或语义版本、模型指纹过期的 ready Sticker',
);
for (const sticker of pendingIndexStickers) {
  assert.deepEqual(
    sticker,
    await indexing.repository.getStickerById(sticker.id),
    '联表返回的语义版本与时间等字段必须全部属于 Sticker，而非 embedding',
  );
}
assert.deepEqual(
  stickerIds(await indexing.repository.listReadyStickersNeedingEmbedding({ ...indexContext, dimension: 3 }, 16)),
  ['missing', 'other-model', 'stale-model', 'stale-revision', 'wrong-dimension'],
  '指定维度时，维度不匹配的向量也必须补建',
);
assert.deepEqual(
  stickerIds(await indexing.repository.listReadyStickersNeedingEmbedding(indexContext, 2)),
  ['missing', 'other-model'],
  '批次查询必须遵守数量上限',
);

const indexRequestsBefore = indexing.embeddingRequests.calls;
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 0 }, '新选择的模型不得自动批量重建');
assert.equal(indexing.embeddingRequests.calls, indexRequestsBefore);
await embeddingsModule.rebuildStickerEmbeddingIndex();
assert.deepEqual(
  await embeddingsModule.getStickerEmbeddingIndexStatus(),
  { readyStickers: 6, validEmbeddings: 6, pendingEmbeddings: 0 },
  '重建整批成功后才发布全部索引',
);
assert.deepEqual(
  await embeddingsModule.generateStickerEmbeddingBatch(),
  { embeddedCount: 0 },
  '完整发布后不重复请求模型',
);
assert.deepEqual(
  await embeddingsModule.getStickerEmbeddingIndexStatus(),
  { readyStickers: 6, validEmbeddings: 6, pendingEmbeddings: 0 },
  '新向量必须匹配当前模型指纹和 Sticker 语义版本',
);
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 0 });
assert.equal(indexing.embeddingRequests.calls, 1, '索引齐全后不应再调用向量模型');
// 待建数量超过服务上限时，默认 worker 批次仍应持续补齐，而不是反复发送被拒绝的大请求。
for (let index = 0; index < 15; index++) {
  seedMediaAsset(indexing.db, `asset-batch-limit-${index}`);
  seedSticker(indexing.db, {
    id: `batch-limit-${index}`,
    mediaAssetId: `asset-batch-limit-${index}`,
    name: `批次上限 ${index}`,
    tags: ['测试标签'],
    annotationStatus: 'ready',
  });
}
let embeddedTotal = 0;
while (embeddedTotal < 15) {
  const result = await embeddingsModule.generateStickerEmbeddingBatch();
  assert.ok(result.embeddedCount > 0, '待建向量应持续推进');
  embeddedTotal += result.embeddedCount;
}
assert.equal(embeddedTotal, 15);
assert.equal((await embeddingsModule.getStickerEmbeddingIndexStatus()).pendingEmbeddings, 0);

// 整批发布的失败不会暴露半套新索引，也不会先删除旧向量。
const storedVectors = () => indexing.db.prepare('SELECT * FROM sticker_embeddings ORDER BY sticker_id, model_config_id').all();
const retainedVectors = storedVectors();
let rebuildCalls = 0;
indexing.embeddingRequests.beforeReply = async () => {
  rebuildCalls++;
  assert.deepEqual(storedVectors(), retainedVectors, '生成各批次期间旧索引保持完整');
  if (rebuildCalls === 2) throw new Error('模拟表情向量服务失败');
};
await assert.rejects(embeddingsModule.rebuildStickerEmbeddingIndex(), /模拟表情向量服务失败/);
assert.deepEqual(storedVectors(), retainedVectors);
const cancelledRebuild = new AbortController();
indexing.embeddingRequests.beforeReply = async () => { cancelledRebuild.abort(); };
await assert.rejects(embeddingsModule.rebuildStickerEmbeddingIndex(cancelledRebuild.signal));
assert.deepEqual(storedVectors(), retainedVectors);
indexing.embeddingRequests.beforeReply = null;
indexing.db.exec("CREATE TRIGGER reject_sticker_publish BEFORE INSERT ON sticker_embeddings WHEN NEW.sticker_id = 'stale-model' BEGIN SELECT RAISE(ABORT, '模拟表情整批发布失败'); END;");
await assert.rejects(embeddingsModule.rebuildStickerEmbeddingIndex(), /模拟表情整批发布失败/);
assert.deepEqual(storedVectors(), retainedVectors, '删除旧行并写入部分新行之后发生异常，也必须恢复整套旧索引');
indexing.db.exec('DROP TRIGGER reject_sticker_publish');

const buildEmbeddings = build => build.stickers.map(sticker => ({
  stickerId: sticker.id, modelConfigId: EMBEDDING_MODEL_ID, modelConfigUpdatedAt: MODEL_UPDATED_AT,
  semanticRevision: sticker.semanticRevision, dimension: 3, vector: [0, 1, 0], createdAt: MODEL_UPDATED_AT, updatedAt: MODEL_UPDATED_AT,
}));
const staleIndexBuild = await indexing.repository.beginEmbeddingRebuild('before-edit', indexContext, (await indexing.repository.getEmbeddingIndexControl()).revision);
await indexing.repository.updateStickerMetadata(staleIndexBuild.stickers[0].id, { name: '重建期间编辑' }, MODEL_UPDATED_AT);
await assert.rejects(indexing.repository.publishEmbeddingRebuild(staleIndexBuild, buildEmbeddings(staleIndexBuild), indexContext, new AbortController().signal), /表情包发生变化/);
assert.deepEqual(storedVectors(), retainedVectors);
await indexing.repository.finishEmbeddingRebuild(staleIndexBuild.id);

const beforeConfigurationRead = await indexing.repository.getEmbeddingIndexControl();
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ALT_ID);
assert.equal(await indexing.repository.syncEmbeddingModel(indexContext, beforeConfigurationRead.revision), null, '配置读取期间切换模型，不能用旧配置重新取得发布资格');
await assert.rejects(indexing.repository.beginEmbeddingRebuild('stale-config', indexContext, beforeConfigurationRead.revision), /模型已变化/);
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ID);

const oldIndexBuild = await indexing.repository.beginEmbeddingRebuild('old-build', indexContext, (await indexing.repository.getEmbeddingIndexControl()).revision);
const newIndexBuild = await indexing.repository.beginEmbeddingRebuild('new-build', indexContext, (await indexing.repository.getEmbeddingIndexControl()).revision);
await assert.rejects(indexing.repository.publishEmbeddingRebuild(oldIndexBuild, buildEmbeddings(oldIndexBuild), indexContext, new AbortController().signal), /重建任务已变化/);
await indexing.repository.finishEmbeddingRebuild(oldIndexBuild.id);
assert.equal((await indexing.repository.getEmbeddingIndexControl()).buildId, newIndexBuild.id, '旧任务不能清掉新任务的发布所有权');
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ALT_ID);
await assert.rejects(indexing.repository.publishEmbeddingRebuild(newIndexBuild, buildEmbeddings(newIndexBuild), indexContext, new AbortController().signal), /重建任务已变化/);
assert.deepEqual(storedVectors(), retainedVectors, '切换模型保留原向量及其模型信息');
const noImplicitRequests = indexing.embeddingRequests.calls;
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 0 });
indexing.activate();
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 0 }, '重新进入运行时也不得偷偷为新模型重建');
assert.equal(indexing.embeddingRequests.calls, noImplicitRequests);
await embeddingsModule.rebuildStickerEmbeddingIndex();
assert.ok(storedVectors().every(row => row.model_config_id === EMBEDDING_MODEL_ALT_ID), '新模型整批成功后才替换旧模型向量');
indexing.db.close();

// 处理进度覆盖完整用户库；识别和向量失败由用户显式恢复。
const processingModule = await loader.load('src/features/stickers/application/StickerProcessing.ts');
const processingSignals = await loader.load('src/features/stickers/application/StickerProcessingSignal.ts');
const progressHarness = createStickerHarness();
progressHarness.activate();
await systemModelsModule.setStickerAutomaticRecognitionEnabled(true);
await systemModelsModule.setStickerRecognitionModel(RECOGNITION_MODEL_ID);
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ID);
for (let index = 0; index < 203; index++) {
  seedMediaAsset(progressHarness.db, `progress-asset-${index}`);
  seedSticker(progressHarness.db, { id: `progress-${String(index).padStart(3, '0')}`,
    mediaAssetId: `progress-asset-${index}`, name: `进度表情 ${index}`,
    annotationStatus: index < 201 ? 'pending' : 'ready' });
}
let processing = await processingModule.getStickerProcessingProgress();
assert.equal(processing.items.length, 203, '整库进度不能被图库的 200 条分页截断');
assert.equal(processing.items.at(-1).vectorStatus, 'pending_rebuild', '选好模型不代表已经开始向量化');
const recognitionClaim = await commandsModule.claimStickerAnnotation();
processing = await processingModule.getStickerProcessingProgress();
assert.equal(processing.items.find(item => item.sticker.id === recognitionClaim.sticker.id).annotationStartedAt, recognitionClaim.claimedAt);
await commandsModule.failStickerAnnotation({ stickerId: recognitionClaim.sticker.id, claimId: recognitionClaim.claimId, error: '模拟识别失败' });
const nextRecognition = await commandsModule.claimStickerAnnotation();
assert.notEqual(nextRecognition.sticker.id, recognitionClaim.sticker.id, '自动领取跳过识别失败项');
await commandsModule.releaseStickerAnnotation({ stickerId: nextRecognition.sticker.id, claimId: nextRecognition.claimId });
await commandsModule.retryStickerAnnotation(recognitionClaim.sticker.id);
await assert.rejects(commandsModule.retryStickerAnnotation(recognitionClaim.sticker.id), /只能重试/);
const retriedClaim = await commandsModule.claimStickerAnnotation();
assert.equal(retriedClaim.sticker.id, recognitionClaim.sticker.id, '重试复用现有队列');
assert.notEqual(retriedClaim.claimId, recognitionClaim.claimId);
await assert.rejects(commandsModule.completeStickerAnnotation({ stickerId: recognitionClaim.sticker.id,
  claimId: recognitionClaim.claimId, metadata: { description: '旧请求' } }), /claim/);
await commandsModule.failStickerAnnotation({ stickerId: retriedClaim.sticker.id, claimId: retriedClaim.claimId, error: '手动重试仍失败' });
const afterRetryFailure = await commandsModule.claimStickerAnnotation();
assert.notEqual(afterRetryFailure.sticker.id, retriedClaim.sticker.id, '手动重试再次失败后也停止，不循环重试');
await commandsModule.releaseStickerAnnotation({ stickerId: afterRetryFailure.sticker.id, claimId: afterRetryFailure.claimId });
await commandsModule.retryStickerAnnotation(retriedClaim.sticker.id);
const successfulClaim = await commandsModule.claimStickerAnnotation();
await commandsModule.completeStickerAnnotation({ stickerId: successfulClaim.sticker.id,
  claimId: successfulClaim.claimId, metadata: { description: '有效识别结果' } });
await embeddingsModule.rebuildStickerEmbeddingIndex();

for (const id of ['vector-fail-a', 'vector-fail-b']) {
  seedMediaAsset(progressHarness.db, `asset-${id}`);
  seedSticker(progressHarness.db, { id, mediaAssetId: `asset-${id}`, name: id });
}
progressHarness.embeddingRequests.beforeReply = async () => {
  const during = await processingModule.getStickerProcessingProgress();
  assert.equal(during.items.find(item => item.sticker.id === 'vector-fail-a').vectorStatus, 'processing');
  throw new Error('模拟向量请求失败');
};
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 0, failedCount: 2 });
assert.equal(processingSignals.getStickerEmbeddingActivity(), null, '失败后不再显示正在请求');
processing = await processingModule.getStickerProcessingProgress();
for (const id of ['vector-fail-a', 'vector-fail-b']) {
  const item = processing.items.find(value => value.sticker.id === id);
  assert.equal(item.vectorStatus, 'failed');
  assert.equal(item.embeddingError, '模拟向量请求失败');
  assert.equal(item.sticker.annotationStatus, 'ready', '向量失败不改写表情可用性');
}
const failureCalls = progressHarness.embeddingRequests.calls;
progressHarness.activate();
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 0 });
assert.equal(progressHarness.embeddingRequests.calls, failureCalls, '再次装配运行时不能自动重试持久失败项');
progressHarness.embeddingRequests.beforeReply = null;
await embeddingsModule.backfillMissingStickerEmbeddings('vector-fail-a');
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 1 });
processing = await processingModule.getStickerProcessingProgress();
assert.equal(processing.items.find(item => item.sticker.id === 'vector-fail-a').vectorStatus, 'ready');
assert.equal(processing.items.find(item => item.sticker.id === 'vector-fail-b').vectorStatus, 'failed', '单张补齐不清除其他失败项');
await embeddingsModule.backfillMissingStickerEmbeddings();
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 1 });

const beforeEdit = await progressHarness.repository.getStickerById('vector-fail-a');
await progressHarness.repository.updateStickerMetadata(beforeEdit.id, { description: '编辑后的语义' }, MODEL_UPDATED_AT);
await progressHarness.repository.saveEmbeddingFailures([beforeEdit], indexContext,
  (await progressHarness.repository.getEmbeddingIndexControl()).revision, null, '旧语义请求失败', MODEL_UPDATED_AT, new AbortController().signal);
processing = await processingModule.getStickerProcessingProgress();
assert.equal(processing.items.find(item => item.sticker.id === beforeEdit.id).embeddingError, null, '迟到错误不能污染新语义');
const abortedBatch = new AbortController();
progressHarness.embeddingRequests.beforeReply = async () => abortedBatch.abort();
await assert.rejects(embeddingsModule.generateStickerEmbeddingBatch({ signal: abortedBatch.signal }));
assert.equal(progressHarness.db.prepare('SELECT COUNT(*) AS n FROM sticker_embedding_failures').get().n, 0, '取消不记为请求失败');
assert.equal(processingSignals.getStickerEmbeddingActivity(), null);
progressHarness.embeddingRequests.beforeReply = null;
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ALT_ID);
await progressHarness.repository.saveEmbeddingFailures([await progressHarness.repository.getStickerById(beforeEdit.id)],
  indexContext, 0, null, '旧模型请求失败', MODEL_UPDATED_AT, new AbortController().signal);
assert.equal(progressHarness.db.prepare('SELECT COUNT(*) AS n FROM sticker_embedding_failures').get().n, 0, '旧模型请求的错误同样受发布 fence 约束');
assert.equal((await processingModule.getStickerProcessingProgress()).items.find(item => item.sticker.id === beforeEdit.id).vectorStatus, 'pending_rebuild');
progressHarness.db.close();

// 设备回归：160／161 已有控制表可能缺少后加的模型列，必须先升级再开放 Repository。
for (const version of [160, 161]) {
  for (const missing of [
    ['selected_model_id', 'selected_model_updated_at'],
    ['selected_model_id', 'selected_model_updated_at', 'published_model_id', 'published_model_updated_at'],
    [],
  ]) {
    const db = createCurrentDatabase();
    db.exec(`INSERT INTO auxiliary_model_configs (id, capability_kind, name, base_url, model, created_at, updated_at)
      VALUES ('${EMBEDDING_MODEL_ID}', 'embedding', '旧向量模型', 'https://example.invalid', 'embed', '${MODEL_UPDATED_AT}', '${MODEL_UPDATED_AT}');
      INSERT INTO sticker_system_config (id, embedding_model_config_id, created_at, updated_at)
        VALUES ('global', '${EMBEDDING_MODEL_ID}', '${MODEL_UPDATED_AT}', '${MODEL_UPDATED_AT}');
      INSERT INTO sticker_embeddings VALUES ('sticker-1', '${EMBEDDING_MODEL_ID}', '${MODEL_UPDATED_AT}', 1, 2, '[1,0]', '${MODEL_UPDATED_AT}', '${MODEL_UPDATED_AT}');
      UPDATE sticker_embedding_index_control SET revision = 7, build_id = 'interrupted-build',
        selected_model_id = '${EMBEDDING_MODEL_ID}', selected_model_updated_at = '${MODEL_UPDATED_AT}',
        published_model_id = '${EMBEDDING_MODEL_ID}', published_model_updated_at = '${MODEL_UPDATED_AT}';`);
    for (const column of missing) db.exec(`ALTER TABLE sticker_embedding_index_control DROP COLUMN ${column};`);
    db.exec(`PRAGMA user_version = ${version};`);
    const retained = db.prepare('SELECT * FROM sticker_embeddings').all();
    if (missing.length > 0) assert.throws(() => db.prepare('SELECT selected_model_id FROM sticker_embedding_index_control'), /no such column/);
    if (version === 161 && missing.length === 2) {
      const before = db.prepare('SELECT * FROM sticker_embedding_index_control').get();
      const adapter = createAdapter(db);
      await assert.rejects(runMigrations({ ...adapter, execAsync: async sql => {
        if (sql.includes('ADD COLUMN selected_model_updated_at')) throw new Error('模拟控制表升级失败');
        await adapter.execAsync(sql);
      } }), /模拟控制表升级失败/);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
      assert.deepEqual(db.prepare('SELECT * FROM sticker_embedding_index_control').get(), before, '升级失败必须回滚已补的列和控制状态');
      assert.deepEqual(db.prepare('SELECT * FROM sticker_embeddings').all(), retained);
    }
    await runMigrations(createAdapter(db));
    const upgraded = db.prepare('SELECT * FROM sticker_embedding_index_control').get();
    const publishedId = missing.includes('published_model_id') ? null : EMBEDDING_MODEL_ID;
    assert.equal(upgraded.selected_model_id, EMBEDDING_MODEL_ID);
    assert.equal(upgraded.selected_model_updated_at, MODEL_UPDATED_AT);
    assert.equal(upgraded.revision, missing.length > 0 ? 8 : 7, '只有补回选择状态才撤销旧执行资格');
    assert.equal(upgraded.build_id, missing.length > 0 ? null : 'interrupted-build');
    assert.equal(upgraded.published_model_id, publishedId, '补列不能凭已有向量推断发布资格');
    await runMigrations(createAdapter(db));
    assert.deepEqual(db.prepare('SELECT * FROM sticker_embedding_index_control').get(), upgraded, '重新启动不重放结构修复');
    const repository = new SQLiteStickerRepository(createSqliteExecutor(db));
    runtimeModule.configureStickersRuntime({ repository, now: () => MODEL_UPDATED_AT,
      auxiliaryModels: { getModelConfigById: async id => modelConfigs.get(id) ?? null },
      withEmbeddingMaintenance: (operation, signal) => operation(signal ?? new AbortController().signal),
    });
    await systemModelsModule.setStickerEmbeddingModel(null);
    assert.equal((await repository.getStickerSystemConfig()).embeddingModelConfigId, null, '升级后允许取消向量模型选择');
    await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ALT_ID);
    assert.equal((await repository.getStickerSystemConfig()).embeddingModelConfigId, EMBEDDING_MODEL_ALT_ID, '升级后允许切换向量模型');
    assert.deepEqual(db.prepare('SELECT * FROM sticker_embeddings').all(), retained, '升级和切换均保留旧向量');
    assert.equal((await repository.getEmbeddingIndexControl()).publishedModelId, publishedId, '切换不能把新选择的模型视为已发布');
    db.close();
  }
}

// 自动开关不影响显式单张操作，手动语义拥有优先于在途识别结果的提交资格。
const policy = createStickerHarness();
policy.activate();
await systemModelsModule.setStickerRecognitionModel(RECOGNITION_MODEL_ID);
assert.equal((await systemModelsModule.getStickerSystemConfig()).automaticRecognitionEnabled, false);
for (const id of ['a-manual', 'b-before', 'c-edit', 'd-name', 'e-retry']) {
  seedMediaAsset(policy.db, `asset-${id}`);
  seedSticker(policy.db, { id, mediaAssetId: `asset-${id}`, name: id, annotationStatus: 'pending' });
}
assert.equal(await commandsModule.claimStickerAnnotation(), null, '配置模型不等于开启自动识别');
await commandsModule.retryStickerAnnotation('a-manual');
const manualClaim = await commandsModule.claimStickerAnnotation();
assert.equal(manualClaim.manual, true, '关闭自动识别时仍允许显式单张请求');
await commandsModule.completeStickerAnnotation({ stickerId: manualClaim.sticker.id, claimId: manualClaim.claimId, metadata: { description: '手动请求结果' } });
assert.equal(await commandsModule.claimStickerAnnotation(), null, '单张请求不能连带处理其他 pending');
await systemModelsModule.setStickerRecognitionModel(null);
await commandsModule.editStickerMetadata('b-before', { description: '未配置模型时用户手填的描述' });
await systemModelsModule.setStickerRecognitionModel(RECOGNITION_MODEL_ID);
await systemModelsModule.setStickerAutomaticRecognitionEnabled(true);
const disabledClaim = await commandsModule.claimStickerAnnotation();
assert.equal(disabledClaim.sticker.id, 'c-edit', '重新配置模型和开启自动识别不能覆盖已手填的旧图');
assert.equal(disabledClaim.manual, false);
await systemModelsModule.setStickerAutomaticRecognitionEnabled(false);
await assert.rejects(commandsModule.completeStickerAnnotation({ stickerId: disabledClaim.sticker.id, claimId: disabledClaim.claimId,
  metadata: { description: '关闭开关后的旧结果' } }), /claim/);
assert.equal(await commandsModule.claimStickerAnnotation(), null);
await systemModelsModule.setStickerAutomaticRecognitionEnabled(true);
const editedClaim = await commandsModule.claimStickerAnnotation();
await commandsModule.editStickerMetadata(editedClaim.sticker.id, { description: '用户亲自填写的描述' });
await assert.rejects(commandsModule.completeStickerAnnotation({ stickerId: editedClaim.sticker.id, claimId: editedClaim.claimId,
  metadata: { description: '迟到的模型描述' } }), /claim/);
assert.equal((await policy.repository.getStickerById(editedClaim.sticker.id)).description, '用户亲自填写的描述');
assert.equal((await policy.repository.getStickerById(editedClaim.sticker.id)).annotationStatus, 'ready');
await commandsModule.editStickerMetadata('d-name', { name: '只改名称也应停止自动覆盖' });
assert.equal((await policy.repository.getStickerById('d-name')).annotationStatus, 'manual_required');
const remaining = await commandsModule.claimStickerAnnotation();
assert.equal(remaining.sticker.id, 'e-retry', '人工修改项不再被自动领取');
await commandsModule.failStickerAnnotation({ stickerId: remaining.sticker.id, claimId: remaining.claimId, error: '请求失败' });
await systemModelsModule.setStickerAutomaticRecognitionEnabled(false);
await commandsModule.retryStickerAnnotation('e-retry');
const oneRetry = await commandsModule.claimStickerAnnotation();
await commandsModule.failStickerAnnotation({ stickerId: oneRetry.sticker.id, claimId: oneRetry.claimId, error: '单张仍失败' });
assert.equal(await commandsModule.claimStickerAnnotation(), null, '手动失败仍需用户再次操作，不自动循环');
policy.db.close();

// 切回同一模型版本时保留39条有效旧索引，显式补齐只请求新增的第40张。
const retainedIndex = createStickerHarness();
retainedIndex.activate();
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ID);
for (let index = 0; index < 40; index++) {
  const id = `retained-${index}`;
  seedMediaAsset(retainedIndex.db, `asset-${id}`);
  seedSticker(retainedIndex.db, { id, mediaAssetId: `asset-${id}`, name: id });
  if (index < 39) seedEmbedding(retainedIndex.db, { stickerId: id, modelConfigId: EMBEDDING_MODEL_ID,
    modelConfigUpdatedAt: MODEL_UPDATED_AT, vector: [1, 0, 0] });
}
const old39 = retainedIndex.db.prepare("SELECT * FROM sticker_embeddings ORDER BY sticker_id").all();
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ALT_ID);
assert.equal((await processingModule.getStickerProcessingProgress()).embeddingCanBackfill, false, '其他模型的旧索引不能用于补齐');
await assert.rejects(embeddingsModule.backfillMissingStickerEmbeddings(), /没有可恢复/);
await systemModelsModule.setStickerEmbeddingModel(null);
await systemModelsModule.setStickerEmbeddingModel(EMBEDDING_MODEL_ID);
const backToOriginal = await processingModule.getStickerProcessingProgress();
assert.equal(backToOriginal.items.filter(item => item.hasEmbedding).length, 39);
assert.equal(backToOriginal.embeddingCanBackfill, true);
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 0 }, '恢复旧维护资格之前不隐式请求');
await embeddingsModule.backfillMissingStickerEmbeddings('retained-39');
assert.deepEqual(await embeddingsModule.generateStickerEmbeddingBatch(), { embeddedCount: 1 });
assert.deepEqual(retainedIndex.db.prepare("SELECT * FROM sticker_embeddings WHERE sticker_id <> 'retained-39' ORDER BY sticker_id").all(), old39);
assert.equal(retainedIndex.embeddingRequests.calls, 1);
const originalModel = modelConfigs.get(EMBEDDING_MODEL_ID);
modelConfigs.set(EMBEDDING_MODEL_ID, { ...originalModel, updatedAt: '2026-11-01T00:00:00.000Z' });
assert.equal((await processingModule.getStickerProcessingProgress()).embeddingCanBackfill, false, '同一ID的不同模型版本不能复用旧索引');
await assert.rejects(embeddingsModule.backfillMissingStickerEmbeddings(), /没有可恢复/);
modelConfigs.set(EMBEDDING_MODEL_ID, originalModel);
retainedIndex.db.close();

// 163 升级保护已手填却仍处于 pending 的旧数据，不变更语义版本与已有向量。
{
  const db = createCurrentDatabase();
  db.exec(`UPDATE stickers SET annotation_status = 'pending', description = '升级前已手填', semantic_revision = 2 WHERE id = 'sticker-1';
    ALTER TABLE stickers DROP COLUMN annotation_requested;
    ALTER TABLE sticker_system_config DROP COLUMN automatic_recognition_enabled;
    PRAGMA user_version = 162;`);
  await runMigrations(createAdapter(db));
  const protectedRow = db.prepare("SELECT * FROM stickers WHERE id = 'sticker-1'").get();
  assert.equal(protectedRow.annotation_status, 'ready');
  assert.equal(protectedRow.description, '升级前已手填');
  assert.equal(protectedRow.semantic_revision, 2);
  db.close();
}

console.log('verify:stickers-v2 全部通过');
