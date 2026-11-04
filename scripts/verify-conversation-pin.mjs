import { chatMutationModuleUrl, installChatTimelineSchema } from './chat-timeline-fixture.mjs';
import { SCHEMAS } from './helpers/sqlite-bootstrap-fixture.mjs';
/**
 * 会话列表置顶的持久化行为测试（真实仓储 / 真实迁移 / 真实 SQL）。
 *
 * 覆盖：
 *   A. canonical conversation 初建：last_message=''、last_time=NULL、未置顶 ——
 *      「第一次只是打开一个 AI」不得制造聊天活跃时间；
 *   B. 从未有 canonical 会话的 AI 直接置顶：创建会话 + is_pinned=1 + pinned_at 非空，
 *      但 last_time 仍为 NULL（能到顶部，却没有虚假消息活动）；
 *   C. 置顶 / 取消置顶只改置顶事实：不触碰 last_message / last_time；
 *      取消置顶必须把 pinned_at 清空（否则会继续赖在普通区前面）；
 *   D. 群聊置顶语义与单聊一致；
 *   E. 目标不存在时返回 null（不得静默成功）；
 *   F. clear history 删除消息，不得改动置顶事实；
 *   G. 迁移89：legacy 库（无 pinned_at）补齐列、幂等、迁移后可正常置顶；
 *   H. AIProfile canonical conversation projection 在所有完整 AIProfile 查询入口一致
 *      （getAll / getById / getHostAI / getLedgerAI）。
 *
 * 装配方式：node:sqlite 内存库承载真实 schema；转译真实仓储与真实迁移模块，
 * 只替换环境依赖（databaseCoordinator / media 头像解析）。
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-10T00:00:00.000Z';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

const persistenceStubUrl = transpileToModuleUrl(
  `export const databaseCoordinator = {
     openTaskExecutor: () => globalThis.__PIN_ENV__.executor,
   };`,
);
const mediaStubUrl = transpileToModuleUrl(
  `export async function resolveMediaAssetReferenceUri({ legacyUri }) {
     return legacyUri ?? null;
   }
   // 删除事务内的引用候选收集：本 verifier 只覆盖置顶时间戳，不构造媒体引用事实。
   export async function collectChatSessionMediaAssetCandidatesInTransaction() {
     return [];
   }
   export const collectAssistantMediaAssetCandidatesInTransaction = undefined;`,
);
// 此 verifier 只读取角色投影，不执行壁纸删除或创建时的模型初始化。
const assistantLifecycleStubUrl = transpileToModuleUrl(`
  export const removeConversationWallpaperInTransaction = undefined;
  export const initializeAssistantAuxiliaryModelsInTransaction = undefined;
  export const auxiliaryModelRepository = undefined;
  export const bindModelService = undefined, readModelService = undefined;
  export const bindModelServiceInTransaction = undefined, readModelServiceConnection = undefined, getModelServiceConnection = undefined;
`);

function loadRepository(relativePath, extraReplacements = []) {
  let source = ts.transpileModule(read(relativePath), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replaceAll(`from '@platform/persistence'`, `from '${persistenceStubUrl}'`)
    .replaceAll(`from '@features/profile'`, `from '${assistantLifecycleStubUrl}'`)
    .replaceAll(`from '@features/assistants'`, `from '${assistantLifecycleStubUrl}'`)
    .replaceAll(`from './SQLiteModelServiceRepository'`, `from '${assistantLifecycleStubUrl}'`)
    .replaceAll(`from '../domain/ModelService'`, `from '${assistantLifecycleStubUrl}'`)
    .replaceAll(`from '@features/media'`, `from '${mediaStubUrl}'`);
  source = source.replaceAll(`from '../../messages/infrastructure/ChatMessageMutationSql'`, `from '${chatMutationModuleUrl}'`);
  for (const [from, to] of extraReplacements) {
    source = source.replaceAll(from, to);
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

// AIAssistantRepository 需要真实的 AIProfile / HostRepository 领域模块；
// AIProfile 只依赖 shared/prompt 的上下文条数常量，用真实常量文件替换即可。
const contextWindowLimitsUrl = transpileToModuleUrl(
  read('src/shared/prompt/contextWindowLimits.ts'),
);
const aiProfileUrl = transpileToModuleUrl(
  read('src/features/assistants/domain/AIProfile.ts')
    .replaceAll(`from '@shared/prompt'`, `from '${contextWindowLimitsUrl}'`),
);
const hostRepositoryUrl = transpileToModuleUrl(
  read('src/features/assistants/domain/HostRepository.ts'),
);

const sessionRepositoryModule = await loadRepository(
  'src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts',
);
const groupRepositoryModule = await loadRepository(
  'src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts',
);
const assistantRepositoryModule = await loadRepository(
  'src/features/assistants/infrastructure/SQLiteAssistantRepository.ts',
  [
    [`from '../domain/AIProfile'`, `from '${aiProfileUrl}'`],
    [`from '../domain/HostRepository'`, `from '${hostRepositoryUrl}'`],
    [`from './SQLiteAuxiliaryModelDefaults'`, `from '${assistantLifecycleStubUrl}'`],
    [`from './SQLiteAuxiliaryModelRepository'`, `from '${assistantLifecycleStubUrl}'`],
  ],
);
const { migrateConversationPinTimestamps } = await import(
  transpileToModuleUrl(read('src/platform/persistence/sqlite/conversationPinMigration.ts'))
);

// ============================================================================
// schema fixture（列与 src/platform/persistence/sqlite/schema.ts 对齐）
// ============================================================================
const SESSIONS_DDL = (withPinnedAt) => `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    ai_assistant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    last_message TEXT,
    last_time TEXT,
    is_active INTEGER DEFAULT 1,
    is_pinned INTEGER DEFAULT 0,
    ${withPinnedAt ? 'pinned_at TEXT,' : ''}
    visible_after_message_id INTEGER,
    visible_after_at TEXT,
    tags TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;
const GROUP_CHATS_DDL = (withPinnedAt) => `
  CREATE TABLE group_chats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT,
    avatar_media_asset_id TEXT,
    last_message TEXT,
    last_time TEXT,
    last_message_id INTEGER,
    is_pinned INTEGER DEFAULT 0,
    ${withPinnedAt ? 'pinned_at TEXT,' : ''}
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const AI_ASSISTANTS_DDL = `
  CREATE TABLE ai_assistants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    avatar_media_asset_id TEXT,
    model TEXT,
    api_key TEXT,
    api_base_url TEXT,
    system_prompt TEXT,
    temperature REAL DEFAULT 0.7,
    top_p REAL DEFAULT 1.0,
    max_tokens INTEGER,
    private_context_primary_limit INTEGER,
    private_context_secondary_limit INTEGER,
    group_context_primary_limit INTEGER,
    group_context_secondary_limit INTEGER,
    enable_tools INTEGER DEFAULT 0,
    enable_short_text_protocol INTEGER DEFAULT 1,
    allow_multiple_bubbles INTEGER DEFAULT 1,
    supports_vision INTEGER DEFAULT 0,
    image_processing_mode TEXT DEFAULT 'direct',
    is_ledger_ai INTEGER DEFAULT 0,
    is_host_ai INTEGER DEFAULT 0,
    host_cooldown_start TEXT,
    host_cooldown_end TEXT,
    host_revoke_cooldown_start TEXT,
    host_revoke_cooldown_end TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function createDatabase({ withPinnedAt = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    ${SESSIONS_DDL(withPinnedAt)}
    ${GROUP_CHATS_DDL(withPinnedAt)}
    ${AI_ASSISTANTS_DDL}
    CREATE TABLE ai_blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ai_id TEXT NOT NULL,
      blocked_until TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group'))
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT,
      turn_run_id TEXT,
      turn_item_index INTEGER
    );
  `);
  installChatTimelineSchema(db);
  db.exec(SCHEMAS.assistantProfileCovers);
  return db;
}

function createEnv(db) {
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
    execAsync: async (sql) => db.exec(sql),
    withExclusiveTransactionAsync: async (fn) => fn(executor),
  };
  const env = { db, executor };
  globalThis.__PIN_ENV__ = env;
  return env;
}

// ============================================================================
// fixture helpers
// ============================================================================
function insertAssistant(db, { id, isHost = false, isLedger = false }) {
  db.prepare(
    `INSERT INTO ai_assistants
       (id, agent_id, name, model, is_ledger_ai, is_host_ai, created_at, updated_at)
     VALUES (?, ?, ?, 'test-model', ?, ?, ?, ?)`,
  ).run(id, `agent_${id}`, id, isLedger ? 1 : 0, isHost ? 1 : 0, T1, T1);
}

function insertSession(db, {
  id, aiId, isPinned = 0, pinnedAt = null, lastMessage = '', lastTime = null,
}) {
  const now = new Date().toISOString();
  if (!columnNames(db, 'sessions').includes('pinned_at')) {
    // legacy shape（迁移89 之前）：没有置顶时刻列。
    db.prepare(
      `INSERT INTO sessions
         (id, ai_assistant_id, name, last_message, last_time, is_active, is_pinned,
          visible_after_message_id, visible_after_at, tags, created_at, updated_at)
       VALUES (?, ?, '会话', ?, ?, 1, ?, NULL, NULL, '[]', ?, ?)`,
    ).run(id, aiId, lastMessage, lastTime, isPinned, T1, now);
    return;
  }

  db.prepare(
    `INSERT INTO sessions
       (id, ai_assistant_id, name, last_message, last_time, is_active, is_pinned, pinned_at,
        visible_after_message_id, visible_after_at, tags, created_at, updated_at)
     VALUES (?, ?, '会话', ?, ?, 1, ?, ?, NULL, NULL, '[]', ?, ?)`,
  ).run(id, aiId, lastMessage, lastTime, isPinned, pinnedAt, T1, now);
}

function insertGroup(db, { id, isPinned = 0, pinnedAt = null, lastMessage = '', lastTime = null }) {
  const now = new Date().toISOString();
  if (!columnNames(db, 'group_chats').includes('pinned_at')) {
    // legacy shape（迁移89 之前）：没有置顶时刻列。
    db.prepare(
      `INSERT INTO group_chats
         (id, name, avatar, avatar_media_asset_id, last_message, last_time, last_message_id,
          is_pinned, created_at, updated_at)
       VALUES (?, '群聊', NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
    ).run(id, lastMessage, lastTime, isPinned, T1, now);
    return;
  }

  db.prepare(
    `INSERT INTO group_chats
       (id, name, avatar, avatar_media_asset_id, last_message, last_time, last_message_id,
        is_pinned, pinned_at, created_at, updated_at)
     VALUES (?, '群聊', NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(id, lastMessage, lastTime, isPinned, pinnedAt, T1, now);
}

function insertMessage(db, sessionId, text) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO messages (session_id, text, created_at) VALUES (?, ?, ?)')
    .run(sessionId, text, now);
  return db.prepare('SELECT MAX(id) AS id FROM messages WHERE session_id = ?').get(sessionId).id;
}

const readSession = (db, sessionId) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
const readGroup = (db, groupId) => db.prepare('SELECT * FROM group_chats WHERE id = ?').get(groupId);
const columnNames = (db, table) => db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);

// ============================================================================
// A：canonical conversation 初建语义
// ============================================================================
{
  const db = createDatabase();
  createEnv(db);
  const repository = new sessionRepositoryModule.SessionRepository();

  const session = await repository.resolveCanonicalConversation('ai_brand_new');
  const row = readSession(db, session.id);

  assert.equal(row.last_message, '', '初建 canonical conversation 的 last_message 必须为空');
  assert.equal(
    row.last_time,
    null,
    '初建 canonical conversation 只是身份创建：last_time 必须为 NULL，不得制造聊天活跃时间',
  );
  assert.equal(row.is_pinned, 0, '初建会话不得置顶');
  assert.equal(row.pinned_at, null, '初建会话 pinned_at 必须为 NULL');
  assert.equal(session.lastMessage, null, '返回的 domain entity lastMessage 必须为 null');
  assert.equal(session.lastTime, null, '返回的 domain entity lastTime 必须为 null');
  assert.equal(session.isPinned, false, '初建会话不得置顶（entity）');
  assert.equal(session.pinnedAt, null, '初建会话 pinnedAt 必须为 null（entity）');
  assert.ok(row.created_at && row.updated_at, 'created_at / updated_at 仍取当前时间');

  const again = await repository.resolveCanonicalConversation('ai_brand_new');
  assert.equal(again.id, session.id, 'canonical 身份必须唯一复用');
}

// ============================================================================
// B / C / E：新会话直接置顶、置顶只改置顶事实、目标不存在
// ============================================================================
{
  const db = createDatabase();
  createEnv(db);
  const repository = new sessionRepositoryModule.SessionRepository();

  const created = await repository.resolveCanonicalConversation('ai_pin_first');
  const before = readSession(db, created.id);
  const pinned = await repository.setConversationPinned(created.id, true);
  const afterPin = readSession(db, created.id);

  assert.equal(pinned.isPinned, true, '置顶必须返回落库后的会话事实');
  assert.ok(pinned.pinnedAt, '置顶必须写入 pinned_at');
  assert.equal(afterPin.is_pinned, 1, '置顶必须落库到 sessions.is_pinned');
  assert.equal(afterPin.pinned_at, pinned.pinnedAt, 'pinned_at 必须落库');
  assert.equal(
    afterPin.last_time,
    before.last_time,
    '置顶不得改写 last_time（置顶不是消息活动）',
  );
  assert.equal(afterPin.last_message, before.last_message, '置顶不得改写 last_message');
  assert.equal(afterPin.last_time, null, '从未聊过的会话置顶后 last_time 仍为 NULL');

  const unpinned = await repository.setConversationPinned(created.id, false);
  assert.equal(unpinned.isPinned, false);
  assert.equal(unpinned.pinnedAt, null, '取消置顶后返回事实里的 pinnedAt 必须为 null');
  assert.equal(readSession(db, created.id).pinned_at, null, '取消置顶必须清空 pinned_at 列');

  // 已有旧会话置顶：pinned_at 必须晚于真实消息时间，且保留 last_time 原值。
  insertSession(db, { id: 'session_old', aiId: 'ai_old', lastMessage: 'B', lastTime: T2 });
  const pinnedOld = await repository.setConversationPinned('session_old', true);
  assert.equal(pinnedOld.lastTime, T2, '置顶后 lastTime 必须保持真实消息时间');
  assert.ok(
    Date.parse(pinnedOld.pinnedAt) > Date.parse(pinnedOld.lastTime),
    'pinnedAt 必须晚于真实消息时间（置顶区有效时间取较晚者）',
  );

  assert.equal(
    await repository.setConversationPinned('session_missing', true),
    null,
    '会话不存在必须返回 null，不得静默成功',
  );
}

// ============================================================================
// D：群聊置顶语义与单聊一致
// ============================================================================
{
  const db = createDatabase();
  createEnv(db);
  const repository = new groupRepositoryModule.GroupChatRepository();

  insertGroup(db, { id: 'group_a', lastMessage: 'hello', lastTime: T1 });

  const pinned = await repository.setPinned('group_a', true);
  assert.equal(pinned.isPinned, true, '群聊置顶返回更新后的事实');
  assert.ok(pinned.pinnedAt, '群聊置顶必须写入 pinned_at');
  assert.equal(pinned.lastTime, T1, '群聊置顶不得改写 last_time');
  assert.equal(readGroup(db, 'group_a').pinned_at, pinned.pinnedAt, 'pinned_at 必须落库');
  assert.equal(
    (await repository.getAll()).find((group) => group.id === 'group_a').isPinned,
    true,
    '群聊 reload 后仍然 pinned',
  );

  const unpinned = await repository.setPinned('group_a', false);
  assert.equal(unpinned.isPinned, false);
  assert.equal(unpinned.pinnedAt, null, '群聊取消置顶必须清空 pinnedAt');
  assert.equal(readGroup(db, 'group_a').pinned_at, null, '群聊取消置顶必须清空 pinned_at 列');
  assert.equal(unpinned.lastTime, T1, '群聊取消置顶不得改写 last_time');

  assert.equal(await repository.setPinned('group_missing', true), null, '群聊不存在返回 null');
}

// ============================================================================
// F：clear history 不得改动置顶事实
// ============================================================================
{
  const db = createDatabase();
  createEnv(db);
  const repository = new sessionRepositoryModule.SessionRepository();

  insertSession(db, {
    id: 'session_clear', aiId: 'ai_clear', isPinned: 1, pinnedAt: T1,
    lastMessage: 'B', lastTime: T2,
  });
  insertMessage(db, 'session_clear', 'A');
  insertMessage(db, 'session_clear', 'B');

  await repository.clearConversationHistory('session_clear');
  const row = readSession(db, 'session_clear');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('session_clear').count, 0, 'clear 删除全部消息');
  assert.equal(row.last_message, '', 'clear 后 preview 必须为空');
  assert.equal(
    row.last_time,
    null,
    'clear 后 last_time 必须为 NULL：排序时间不允许继续引用已删除的旧消息',
  );
  assert.equal(row.is_pinned, 1, 'clear history 不得改动置顶状态');
  assert.equal(row.pinned_at, T1, 'clear history 不得改动 pinned_at');
}

// ============================================================================
// G：迁移89 —— legacy 库补齐 pinned_at、幂等、迁移后可用
// ============================================================================
{
  const db = createDatabase({ withPinnedAt: false });
  createEnv(db);
  insertSession(db, {
    id: 'session_legacy', aiId: 'ai_legacy', isPinned: 1, lastMessage: 'hi', lastTime: T1,
  });
  insertGroup(db, { id: 'group_legacy', isPinned: 1, lastMessage: 'hi', lastTime: T1 });

  assert.ok(!columnNames(db, 'sessions').includes('pinned_at'), 'fixture：legacy 库没有 pinned_at');
  assert.ok(!columnNames(db, 'group_chats').includes('pinned_at'), 'fixture：legacy 群聊没有 pinned_at');

  await migrateConversationPinTimestamps(globalThis.__PIN_ENV__.executor);

  assert.ok(columnNames(db, 'sessions').includes('pinned_at'), '迁移后 sessions 必须有 pinned_at');
  assert.ok(columnNames(db, 'group_chats').includes('pinned_at'), '迁移后 group_chats 必须有 pinned_at');
  assert.equal(
    readSession(db, 'session_legacy').pinned_at,
    null,
    '既有置顶行不得被回填一个伪造的置顶时刻',
  );
  assert.equal(readSession(db, 'session_legacy').is_pinned, 1, '迁移不得改动既有置顶状态');
  assert.equal(readGroup(db, 'group_legacy').is_pinned, 1, '迁移不得改动既有群聊置顶状态');

  const columnCountAfterFirstRun = columnNames(db, 'sessions').length;
  await migrateConversationPinTimestamps(globalThis.__PIN_ENV__.executor);
  assert.equal(
    columnNames(db, 'sessions').filter((name) => name === 'pinned_at').length,
    1,
    '重复迁移不得出现重复列',
  );
  assert.equal(
    columnNames(db, 'sessions').length,
    columnCountAfterFirstRun,
    '重复迁移不得再改结构（churn）',
  );

  const repository = new sessionRepositoryModule.SessionRepository();
  const pinned = await repository.setConversationPinned('session_legacy', true);
  assert.equal(pinned.isPinned, true, '迁移后必须能正常置顶');
  assert.ok(pinned.pinnedAt, '迁移后置顶必须能写入 pinned_at');
  const unpinned = await repository.setConversationPinned('session_legacy', false);
  assert.equal(unpinned.pinnedAt, null, '迁移后取消置顶必须能清空 pinned_at');
}

// ============================================================================
// H：AIProfile canonical conversation projection 在所有查询入口一致
// ============================================================================
{
  const db = createDatabase();
  createEnv(db);
  // 同一个 AI 同时承担 host + ledger，四种入口都必须返回同一份完整投影。
  insertAssistant(db, { id: 'ai_projection', isHost: true, isLedger: true });
  insertAssistant(db, { id: 'ai_other' });
  insertSession(db, {
    id: 'session_projection',
    aiId: 'ai_projection',
    isPinned: 1,
    pinnedAt: T1,
    lastMessage: 'hello',
    lastTime: T2,
  });

  const repository = new assistantRepositoryModule.AIAssistantRepository();
  const fromGetAll = (await repository.getAll()).find((ai) => ai.id === 'ai_projection');
  const fromGetById = await repository.getById('ai_projection');
  const fromGetHost = await repository.getHostAI();
  const fromGetLedger = await repository.getLedgerAI();

  const projectionOf = (ai) => ({
    canonicalConversationId: ai.canonicalConversationId,
    isPinned: ai.isPinned,
    pinnedAt: ai.pinnedAt,
    lastMessage: ai.lastMessage,
    lastTime: ai.lastTime,
  });
  const expected = {
    canonicalConversationId: 'session_projection',
    isPinned: true,
    pinnedAt: T1,
    lastMessage: 'hello',
    lastTime: T2,
  };

  assert.deepEqual(projectionOf(fromGetAll), expected, 'getAll 必须投影 canonical conversation 事实');
  assert.deepEqual(projectionOf(fromGetById), expected, 'getById 必须投影 canonical conversation 事实');
  assert.deepEqual(projectionOf(fromGetHost), expected, 'getHostAI 必须投影 canonical conversation 事实');
  assert.deepEqual(projectionOf(fromGetLedger), expected, 'getLedgerAI 必须投影 canonical conversation 事实');

  // 没有 canonical 会话的 AI：各入口同样是「一致的未置顶空投影」。
  const other = (await repository.getAll()).find((ai) => ai.id === 'ai_other');
  const otherById = await repository.getById('ai_other');
  assert.deepEqual(projectionOf(other), projectionOf(otherById), '同一 AI 的入口投影必须一致');
  assert.equal(other.isPinned, false);
  assert.equal(other.pinnedAt, null);
  assert.equal(other.canonicalConversationId, null);
  assert.equal(other.lastTime, '', '没有 canonical 会话时 lastTime 为空串');
}

console.log('verify-conversation-pin: all assertions passed');
