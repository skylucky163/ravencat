/** Assistant 创建、不可变身份与群成员快照迁移的真实行为验证。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

let schemas;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTypeScriptModuleWithMocks(relativePath, mocks = {}) {
  const sourcePath = path.join(ROOT, relativePath);
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
  const requireMock = (specifier) => {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    if (specifier.startsWith('.')) {
      return loadTypeScriptModuleWithMocks(
        path.relative(ROOT, path.resolve(path.dirname(sourcePath), `${specifier}.ts`)), mocks,
      );
    }
    assert.fail(`${relativePath} 存在未声明的外部运行时依赖：${specifier}`);
  };
  const executeModule = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  executeModule(module.exports, requireMock, module, sourcePath, path.dirname(sourcePath));
  return module.exports;
}

function createExecutor(db) {
  return {
    execAsync: async (sql) => db.exec(sql),
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      };
    },
  };
}

function createCoordinator(db) {
  const executor = createExecutor(db);
  return {
    openTaskExecutor() {
      return {
        ...executor,
        async withExclusiveTransactionAsync(task) {
          db.exec('BEGIN;');
          try {
            const value = await task(executor);
            db.exec('COMMIT;');
            return value;
          } catch (error) {
            db.exec('ROLLBACK;');
            throw error;
          }
        },
      };
    },
  };
}

const migrationModule = loadTypeScriptModuleWithMocks(
  'src/platform/persistence/sqlite/assistantIdentityMigration.ts',
);
const { migrateAssistantIdentityContract } = migrationModule;

// 实体工厂不得为缺失的 actor key 生成猜测身份。
{
  const { createAIProfile } = loadTypeScriptModuleWithMocks(
    'src/features/assistants/domain/AIProfile.ts',
    {
      '@shared/prompt': {
        DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT: 30,
        DEFAULT_PRIVATE_CONTEXT_SECONDARY_LIMIT: 10,
        DEFAULT_GROUP_CONTEXT_PRIMARY_LIMIT: 40,
        DEFAULT_GROUP_CONTEXT_SECONDARY_LIMIT: 5,
      },
    },
  );
  assert.throws(
    () => createAIProfile({ id: 'assistant-missing-agent' }),
    /缺少不可变 agentId/,
    '缺失 agentId 时必须暴露身份契约错误，不能生成 fallback',
  );
  assert.equal(
    createAIProfile({ id: 'assistant-valid', agentId: 'actor-valid' }).agentId,
    'actor-valid',
  );
}

// 迁移只校正当前成员关系；消息与所有 task 快照均保持历史原值。
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ai_assistants (
      id TEXT PRIMARY KEY,
      agent_id TEXT UNIQUE
    );
    CREATE TABLE group_chat_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      display_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      agent_id TEXT
    );
    CREATE TABLE group_speech_tasks (
      id TEXT PRIMARY KEY,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL
    );

    INSERT INTO ai_assistants VALUES
      ('assistant-a', 'actor-a'),
      ('assistant-b', 'actor-b');
    INSERT INTO group_chat_members VALUES
      ('member-a', 'group-1', 'assistant-a', 'stale-actor-a', 0, 'old-time'),
      ('member-b', 'group-1', 'assistant-b', 'actor-b', 1, 'old-time');
    INSERT INTO messages VALUES (1, 'stale-actor-a');
    INSERT INTO group_speech_tasks VALUES
      ('task-completed', 'assistant-a', 'stale-actor-a', 'completed'),
      ('task-running', 'assistant-a', 'stale-actor-a', 'running');
  `);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await migrateAssistantIdentityContract(createExecutor(db));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(
    db.prepare(
      'SELECT id, agent_id, updated_at FROM group_chat_members ORDER BY display_order',
    ).all().map((row) => ({ ...row })),
    [
      { id: 'member-a', agent_id: 'actor-a', updated_at: db.prepare(
        "SELECT updated_at FROM group_chat_members WHERE id = 'member-a'",
      ).get().updated_at },
      { id: 'member-b', agent_id: 'actor-b', updated_at: 'old-time' },
    ],
    '迁移必须只修正不一致的当前成员快照',
  );
  assert.notEqual(
    db.prepare("SELECT updated_at FROM group_chat_members WHERE id = 'member-a'").get().updated_at,
    'old-time',
    '被修正的成员关系必须记录更新时间',
  );
  assert.equal(
    db.prepare('SELECT agent_id FROM messages WHERE id = 1').get().agent_id,
    'stale-actor-a',
    '历史消息 actor key 不得回写',
  );
  assert.deepEqual(
    db.prepare('SELECT id, agent_id, status FROM group_speech_tasks ORDER BY id').all()
      .map((row) => ({ ...row })),
    [
      { id: 'task-completed', agent_id: 'stale-actor-a', status: 'completed' },
      { id: 'task-running', agent_id: 'stale-actor-a', status: 'running' },
    ],
    '发言任务保存计划创建时的历史身份快照，迁移不得回写',
  );
  assert.equal(warnings.length, 1, '发现 stale 快照时必须产生一次迁移审计诊断');

  const firstUpdatedAt = db.prepare(
    "SELECT updated_at FROM group_chat_members WHERE id = 'member-a'",
  ).get().updated_at;
  await migrateAssistantIdentityContract(createExecutor(db));
  assert.equal(
    db.prepare("SELECT updated_at FROM group_chat_members WHERE id = 'member-a'").get().updated_at,
    firstUpdatedAt,
    '重复迁移不得再次改写已一致的成员关系',
  );
  db.close();
}

// Assistant owner 缺失稳定 actor key 时必须失败，不生成猜测值。
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, agent_id TEXT);
    CREATE TABLE group_chat_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      ai_assistant_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      display_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO ai_assistants VALUES ('assistant-invalid', NULL);
    INSERT INTO group_chat_members VALUES
      ('member-invalid', 'group-1', 'assistant-invalid', 'old-actor', 0, 'old-time');
  `);
  await assert.rejects(
    migrateAssistantIdentityContract(createExecutor(db)),
    /缺少不可变 agentId/,
  );
  assert.equal(
    db.prepare("SELECT agent_id FROM group_chat_members WHERE id = 'member-invalid'").get().agent_id,
    'old-actor',
    '身份 owner 无有效 key 时迁移必须回滚，不能静默生成 fallback',
  );
  db.close();
}

// Fresh schema 必须要求每个 Assistant 都有 actor key。
{
  const schemaModule = loadTypeScriptModuleWithMocks('src/platform/persistence/sqlite/schema.ts');
  schemas = schemaModule.SCHEMAS;
  const db = new DatabaseSync(':memory:');
  db.exec(schemas.aiAssistants);
  const agentIdColumn = db.prepare("PRAGMA table_info('ai_assistants')").all()
    .find((column) => column.name === 'agent_id');
  assert.equal(agentIdColumn.notnull, 1, 'fresh schema 的 agent_id 必须为 NOT NULL');
  db.close();
}

// Repository 使用真实 schema；模型增量只能写入其拥有的字段。
{
  const db = new DatabaseSync(':memory:');
  for (const sql of Object.values(schemas)) db.exec(sql);
  // 当前 schema 的版本也必须匹配；重复初始化不能覆盖已经保存的选择。
  db.exec(`INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at)
    VALUES ('existing-role', 'existing-actor', '旧角色', 'model-a', 'created', 'old-time')`);
  const { runMigrations, DATABASE_SCHEMA_VERSION } = loadTypeScriptModuleWithMocks('src/platform/persistence/sqlite/migrations.ts');
  db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
  await runMigrations(createExecutor(db));
  assert.equal(db.prepare("SELECT disable_thinking FROM ai_assistants WHERE id = 'existing-role'").get().disable_thinking, 0);
  db.exec("UPDATE ai_assistants SET disable_thinking = 1 WHERE id = 'existing-role'");
  await runMigrations(createExecutor(db));
  assert.equal(db.prepare("SELECT name, disable_thinking FROM ai_assistants WHERE id = 'existing-role'").get().disable_thinking, 1);
  db.exec(`INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at)
    VALUES ('assistant-a', 'actor-a', '旧名称', 'model-a', 'created', 'old-time')`);

  let avatarResolutionCount = 0;
  const assistantRepositoryModule = loadTypeScriptModuleWithMocks(
    'src/features/assistants/infrastructure/SQLiteAssistantRepository.ts',
    {
      '@features/profile': { removeConversationWallpaperInTransaction: async () => [] },
      '@features/media': {
        collectAssistantMediaAssetCandidatesInTransaction: async () => [],
        resolveMediaAssetReferenceUri: async ({ mediaAssetId, legacyUri }) => {
          avatarResolutionCount += 1;
          return mediaAssetId ? `asset://${mediaAssetId}` : legacyUri;
        },
      },
      '@platform/persistence': { databaseCoordinator: createCoordinator(db) },
      '../application/AuxiliaryModelInitialization': {},
      './SQLiteAuxiliaryModelDefaults': { initializeAssistantAuxiliaryModelsInTransaction: async (transaction, assistantId) => {
        assert.equal((await transaction.getFirstAsync('SELECT id FROM ai_assistants WHERE id = ?', [assistantId])).id, assistantId);
      } },
      './SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: {} },
      '../domain/AIProfile': { createAIProfile: (value) => aiProfileModule.createAIProfile(value) },
      '../domain/HostRepository': {
        createHostAIAppointmentCooldown: () => ({}),
        HOST_AI_RELATIONSHIP_STATE_ID: 'host_ai_relationship_state',
      },
    },
  );
  const repository = new assistantRepositoryModule.AIAssistantRepository();
  const updateSettings = (id, settings) => createCoordinator(db).openTaskExecutor().withExclusiveTransactionAsync(
    transaction => repository.updateSettingsInTransaction(transaction, id, settings),
  );

  assert.deepEqual(await repository.listIds(), ['existing-role', 'assistant-a'],
    '身份遍历返回全量助手 ID，不要求头像或模型资料可用');
  assert.equal(avatarResolutionCount, 0, '身份遍历不访问无关的头像文件');

  // 表单创建入口必须先形成完整领域实体，再交给 Repository 落库。
  // 这样 AIProfile 扩展必填字段时，由领域工厂和 TypeScript 契约共同暴露遗漏。
  const aiProfileModule = loadTypeScriptModuleWithMocks(
    'src/features/assistants/domain/AIProfile.ts',
    {
      '@shared/prompt': {
        DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT: 30,
        DEFAULT_PRIVATE_CONTEXT_SECONDARY_LIMIT: 10,
        DEFAULT_GROUP_CONTEXT_PRIMARY_LIMIT: 40,
        DEFAULT_GROUP_CONTEXT_SECONDARY_LIMIT: 5,
      },
    },
  );
  const addAIFormHelpers = loadTypeScriptModuleWithMocks(
    'src/features/assistants/presentation/management/addAIFormHelpers.ts',
    { '../../domain/AIProfile': aiProfileModule },
  );
  const newProfile = addAIFormHelpers.buildNewAI({
    name: ' 新 AI ',
    selectedModel: 'model-new',
    apiKey: ' key-new ',
    apiBaseUrl: ' https://example.com/v1 ',
    systemPrompt: '',
  });
  await repository.insert(newProfile);
  assert.equal((await repository.getById(newProfile.id)).showTokenUsage, true, '新增角色默认保存为显示 Token');
  assert.equal((await repository.getById(newProfile.id)).showActionSteps, true, '新增角色默认显示行动步骤');
  assert.equal((await repository.getById(newProfile.id)).streamingReply, null, '新增角色默认跟随主题');
  for (const streamingReply of [true, false, null]) {
    await updateSettings('assistant-a', { streamingReply });
    assert.equal((await new assistantRepositoryModule.AIAssistantRepository().getById('assistant-a')).streamingReply,
      streamingReply, '回复方式经真实 SQLite 保存和重读后保留');
    assert.equal((await repository.getById(newProfile.id)).streamingReply, null, '回复方式不影响其他 AI');
  }
  assert.deepEqual(
    {
      ...db.prepare(`
        SELECT name, private_context_primary_limit, private_context_secondary_limit,
               group_context_primary_limit, group_context_secondary_limit,
               image_processing_mode, temperature, top_p
        FROM ai_assistants
        WHERE id = ?
      `).get(newProfile.id),
    },
    {
      name: '新 AI',
      private_context_primary_limit: 30,
      private_context_secondary_limit: 10,
      group_context_primary_limit: 40,
      group_context_secondary_limit: 5,
      image_processing_mode: 'direct',
      temperature: null,
      top_p: null,
    },
    '新增 AI 必须带齐领域默认值并成功落库',
  );

  // 已有数字不自动改写；明确清空必须在真实 SQLite 与领域读取后仍保持 null。
  const existing = await repository.getById('assistant-a');
  assert.equal(existing.showTokenUsage, true, '旧角色迁移后的展示默认值保持开启');
  await updateSettings('assistant-a', { showTokenUsage: false });
  assert.equal((await new assistantRepositoryModule.AIAssistantRepository().getById('assistant-a')).showTokenUsage, false,
    '关闭 Token 展示经过真实 SQLite 写入与重读后保留');
  assert.equal((await repository.getById(newProfile.id)).showTokenUsage, true, '展示开关不影响其他角色');
  assert.equal(existing.showActionSteps, true);
  await updateSettings('assistant-a', { showActionSteps: false });
  assert.equal((await new assistantRepositoryModule.AIAssistantRepository().getById('assistant-a')).showActionSteps, false,
    '行动步骤选择经过 SQLite 保存与重读后保留');
  assert.equal((await repository.getById(newProfile.id)).showActionSteps, true, '行动步骤开关不影响其他 AI');
  assert.equal((await repository.getById('assistant-a')).showTokenUsage, false, '行动步骤开关不覆盖 Token 选择');
  assert.equal(existing.temperature, 0.7);
  assert.equal(existing.topP, 1);
  await repository.updateModelSettings('assistant-a', { temperature: 0, topP: 0 });
  assert.equal((await repository.getById('assistant-a')).temperature, 0);
  assert.equal((await repository.getById('assistant-a')).topP, 0);
  const cleared = await repository.updateModelSettings('assistant-a', { temperature: null, topP: null });
  assert.equal(cleared.temperature, null);
  assert.equal(cleared.topP, null);
  const reopened = await new assistantRepositoryModule.AIAssistantRepository().getById('assistant-a');
  assert.equal(reopened.temperature, null);
  assert.equal(reopened.topP, null);
  assert.deepEqual(
    { ...db.prepare("SELECT temperature, top_p FROM ai_assistants WHERE id = 'assistant-a'").get() },
    { temperature: null, top_p: null },
  );

  await updateSettings('assistant-a', { name: '新名称', systemPrompt: '新的人设' });
  await updateSettings('assistant-a', {
    privateContextPrimaryLimit: 48, privateContextSecondaryLimit: 12,
    groupContextPrimaryLimit: 60, groupContextSecondaryLimit: 8, allowMultipleBubbles: false,
  });
  const conversationSettings = await repository.getById('assistant-a');
  assert.deepEqual({
    privatePrimary: conversationSettings.privateContextPrimaryLimit,
    privateSecondary: conversationSettings.privateContextSecondaryLimit,
    groupPrimary: conversationSettings.groupContextPrimaryLimit,
    groupSecondary: conversationSettings.groupContextSecondaryLimit,
    allowMultipleBubbles: conversationSettings.allowMultipleBubbles,
  }, { privatePrimary: 48, privateSecondary: 12, groupPrimary: 60, groupSecondary: 8, allowMultipleBubbles: false }, '对话设置命令持久保存四项上下文与气泡选择');
  await updateSettings('assistant-a', { streamingReply: false });
  await repository.updateModelSettings('assistant-a', { model: 'model-b', temperature: 1.2, disableThinking: true });
  assert.equal((await repository.getById('assistant-a')).streamingReply, false, '模型设置更新不覆盖手动非流式选择');
  assert.equal((await repository.getById('assistant-a')).disableThinking, true, '关闭思考选择必须经过 SQLite 增量写入并在重新读取后保留');
  assert.equal((await repository.getById('assistant-a')).privateContextPrimaryLimit, 48, '模型更新保留对话上下文设置');
  assert.equal((await repository.getById('assistant-a')).allowMultipleBubbles, false, '模型更新保留对话气泡设置');
  assert.equal((await repository.getById('assistant-a')).showTokenUsage, false, '模型更新保留 Token 展示选择');
  assert.equal((await repository.getById(newProfile.id)).disableThinking, false, '新增角色保留服务商默认思考行为');
  assert.deepEqual(
    { ...db.prepare("SELECT agent_id, name, system_prompt, model, temperature FROM ai_assistants WHERE id = 'assistant-a'").get() },
    { agent_id: 'actor-a', name: '新名称', system_prompt: '新的人设', model: 'model-b', temperature: 1.2 },
    '模型增量更新不得覆盖其他入口拥有的名称、人设和身份',
  );
  await assert.rejects(repository.updateModelSettings('missing', { model: 'model' }), /AI 助手不存在/);

  db.prepare(`
    UPDATE ai_assistants
    SET avatar = NULL, avatar_media_asset_id = 'asset-current'
    WHERE id = 'assistant-a'
  `).run();
  await updateSettings('assistant-a', { name: '只改名称' });
  assert.deepEqual(
    { ...db.prepare("SELECT avatar, avatar_media_asset_id FROM ai_assistants WHERE id = 'assistant-a'").get() },
    { avatar: null, avatar_media_asset_id: 'asset-current' },
    '对话设置未修改头像时必须保留 canonical asset 引用',
  );

  const persisted = await repository.updateModelSettings('assistant-a', { apiKey: 'new-key' });
  assert.equal(persisted.name, '只改名称');
  assert.equal(persisted.systemPrompt, '新的人设');
  assert.equal(persisted.apiKey, 'new-key');
  assert.deepEqual(
    { ...db.prepare("SELECT avatar, avatar_media_asset_id FROM ai_assistants WHERE id = 'assistant-a'").get() },
    { avatar: null, avatar_media_asset_id: 'asset-current' },
    '模型更新不拥有头像，也不得覆盖 canonical asset 引用',
  );

  await updateSettings('assistant-a', {
    avatar: 'file:///persistent-media/avatars/ai/new.jpg',
    avatarMediaAssetId: null,
  });
  assert.deepEqual(
    { ...db.prepare("SELECT avatar, avatar_media_asset_id FROM ai_assistants WHERE id = 'assistant-a'").get() },
    {
      avatar: 'file:///persistent-media/avatars/ai/new.jpg',
      avatar_media_asset_id: null,
    },
    '主动更换 legacy 头像时必须显式清除旧 canonical asset 引用',
  );
  await repository.commitAvatarMediaAssetReferenceInTransaction(createExecutor(db), {
    ownerId: 'assistant-a',
    expectedAvatar: 'file:///persistent-media/avatars/ai/new.jpg',
    expectedAvatarMediaAssetId: null,
    mediaAssetId: 'new-avatar-asset',
  });
  assert.deepEqual(
    { ...db.prepare("SELECT name, model, api_key, avatar_media_asset_id FROM ai_assistants WHERE id = 'assistant-a'").get() },
    { name: '只改名称', model: 'model-b', api_key: 'new-key', avatar_media_asset_id: 'new-avatar-asset' },
    '头像提交只能更换头像，不得写回名称或模型配置',
  );
  db.close();
}

console.log('Assistant 创建、不可变身份与群成员快照迁移验证通过。');
