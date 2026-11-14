/** 服务复用、连接修改所有权、摘要迁移与快照恢复的行为回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, dependencies = {}, cache = new Map()) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute);
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} }; cache.set(absolute, module.exports);
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    const candidate = name.startsWith('.') ? path.resolve(path.dirname(absolute), name)
      : name.startsWith('@shared/') ? path.join(root, 'src/shared', name.slice(8)) : null;
    if (candidate) return load(`${candidate}.ts`, dependencies, cache);
    throw new Error(`${file} 缺少依赖 ${name}`);
  }, module, module.exports);
  cache.set(absolute, module.exports); return module.exports;
}
function raw(db) {
  return { getFirstAsync: async (sql, values = []) => db.prepare(sql).get(...values) ?? null,
    getAllAsync: async (sql, values = []) => db.prepare(sql).all(...values),
    runAsync: async (sql, values = []) => db.prepare(sql).run(...values), execAsync: async sql => db.exec(sql) };
}
const { SCHEMAS } = load('src/platform/persistence/sqlite/schema.ts');
const { runMigrations, DATABASE_SCHEMA_VERSION } = load('src/platform/persistence/sqlite/migrations.ts');
const { LEGACY_MODEL_SERVICE_SCHEMA } = load('src/platform/persistence/sqlite/modelServiceSchema.ts');
const databaseErrors = load('src/platform/persistence/runtime/DatabaseErrors.ts');
const serviceErrors = load('src/features/assistants/ModelServiceErrors.ts', { '@platform/persistence': databaseErrors });
function restoreLegacyServices(db) {
  db.exec(`ALTER TABLE model_service_configs ADD COLUMN base_url TEXT;
    ALTER TABLE model_service_configs ADD COLUMN auth_type TEXT;
    UPDATE model_service_configs SET name = (SELECT name FROM model_service_groups WHERE id = group_id),
      base_url = (SELECT base_url FROM model_service_groups WHERE id = group_id),
      auth_type = (SELECT auth_type FROM model_service_groups WHERE id = group_id);
    DROP INDEX idx_model_service_key; DROP INDEX idx_model_service_key_ordinal;
    ALTER TABLE model_service_configs DROP COLUMN ordinal;
    ALTER TABLE model_service_configs DROP COLUMN group_id;
    DROP TABLE model_service_groups;
    CREATE UNIQUE INDEX idx_model_service_connection ON model_service_configs(base_url,api_key,auth_type,credentials_json);`);
}
function markHistoricalVersion(db, version) {
  // 历史夹具不能携带后来才新增的列，否则重复加列会掩盖服务生命周期回归。
  db.exec('ALTER TABLE moments DROP COLUMN edited_at; ALTER TABLE moments DROP COLUMN edit_revision;');
  for (const column of ['recurrence_json','series_id','trigger_kind','conversation_id','reply_revision','next_follow_up_minutes']) {
    db.exec(`ALTER TABLE raven_cat_ai_schedules DROP COLUMN ${column}`);
  }
  db.exec('ALTER TABLE raven_cat_contact_settings DROP COLUMN follow_up_enabled; ALTER TABLE raven_cat_contact_settings DROP COLUMN follow_up_interval_minutes;');
  if (db.prepare('PRAGMA table_info(model_service_configs)').all().some(column => column.name === 'group_id')) restoreLegacyServices(db);
  db.exec(`PRAGMA user_version=${version}`);
}
function database(legacy = false) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for (const [name, schema] of Object.entries(SCHEMAS)) db.exec(legacy
    ? (name === 'modelServices' ? LEGACY_MODEL_SERVICE_SCHEMA : schema.replaceAll('service_config_id TEXT REFERENCES model_service_configs(id),', '')) : schema);
  if (legacy) db.exec('ALTER TABLE auxiliary_model_configs ADD COLUMN enabled INTEGER DEFAULT 1;');
  if (legacy) markHistoricalVersion(db, 156);
  else db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}`);
  return db;
}
function runtime(db) {
  const io = raw(db); let writer = Promise.resolve();
  const executor = { ...io, withExclusiveTransactionAsync(task) {
    const result = writer.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await task(io); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }); writer = result.catch(() => {}); return result;
  } };
  const dependencies = { '@platform/persistence': { ...databaseErrors, databaseCoordinator: { openTaskExecutor: () => executor } },
    '../ModelServiceErrors': serviceErrors,
    '@shared/prompt': { estimateTextTokens: text => text.length },
    '@features/speech': { validateSpeechConfiguration: () => ({}), readSpeechMetadata: load('src/features/speech/application/SpeechProviderCatalog.ts').readSpeechMetadata },
    '@features/integrations': { validateTranslationModelConfig: () => ({}), readTranslationMetadata: load('src/features/integrations/domain/TranslationModel.ts').readTranslationMetadata },
    '@platform/ai/imageGenerationConfig': load('src/platform/ai/imageGenerationConfig.ts'),
    '@features/profile': {}, '@features/media': { resolveMediaAssetReferenceUri: async ({ legacyUri }) => legacyUri } };
  const { SQLiteChatSummaryRepository } = load('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts', dependencies);
  const summary = new SQLiteChatSummaryRepository(async () => []);
  let initialization;
  dependencies['../application/AuxiliaryModelInitialization'] = { getAuxiliaryModelInitialization: () => initialization };
  const services = load('src/features/assistants/infrastructure/SQLiteModelServiceRepository.ts', dependencies);
  services.listModelServices = async () => (await services.listModelServiceGroups()).flatMap(group => group.keys);
  // 历史用例的单连接 fixture 使用当前分组／Key 命令准备数据，产品不保留旧单连接写入 API。
  services.saveModelService = async (id, input) => {
    if (!id) return (await services.createModelServiceGroup({ name: input.name, baseUrl: input.baseUrl, authType: input.authType,
      keys: [{ name: '', apiKey: input.apiKey, credentialsJson: input.credentialsJson }] })).keys[0];
    const current = await services.getModelService(id);
    const groupPatch = Object.fromEntries(['name','baseUrl'].filter(key => input[key] !== undefined && input[key] !== current[key]).map(key => [key,input[key]]));
    if (Object.keys(groupPatch).length) await services.updateModelServiceGroup(current.groupId, groupPatch);
    const keyPatch = Object.fromEntries(['apiKey','credentialsJson'].filter(key => input[key] !== undefined).map(key => [key,input[key]]));
    return services.saveModelServiceKey(current.groupId, id, keyPatch);
  };
  const connection = load('src/features/assistants/domain/ModelService.ts');
  const assets = load('src/features/assistants/infrastructure/SQLiteAuxiliaryModelRepository.ts', dependencies).auxiliaryModelRepository;
  const assistants = load('src/features/assistants/infrastructure/SQLiteAssistantRepository.ts', { ...dependencies,
    './SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: assets } }).aiAssistantRepository;
  const groups = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts', { ...dependencies,
    '@features/assistants': { bindModelServiceInTransaction: services.bindModelService, readModelServiceConnection: services.readModelService, getModelServiceConnection: connection.getModelServiceConnection } }).groupChatRepository;
  const { memoryEntryRepository } = load('src/features/memory/infrastructure/SQLiteMemoryEntryRepository.ts', dependencies);
  const { SQLiteStickerRepository } = load('src/features/stickers/infrastructure/SQLiteStickerRepository.ts', dependencies);
  load('src/host/composition/configureAuxiliaryModelInitialization.ts', {
    '@features/assistants/composition': { aiAssistantRepository: assistants, configureAuxiliaryModelInitialization: value => { initialization = value; } },
    '@features/chat/composition': { groupChatRepository: groups,
      invalidateChatSummaryModelReferencesInTransaction: (tx, id) => summary.invalidateModelReferencesInTransaction(tx, id),
      invalidateChatSummaryServiceReferencesInTransaction: (tx, id) => summary.invalidateServiceReferencesInTransaction(tx, id) },
    '@features/memory/composition': { memoryEntryRepository },
    '@features/stickers/composition': { stickerRepository: new SQLiteStickerRepository(), emitStickerAnnotationPending() {}, emitStickerEmbeddingPending() {} },
    '@features/moments/composition': { momentRepository: { initializeImageAnalysisModelInTransaction: async () => {} } },
    '@features/speech/composition': { initializeSpeechRecognitionModelInTransaction: async () => {} },
    '@features/integrations/composition': { initializeTranslationModelInTransaction: async () => {} },
  }).configureAuxiliaryModelInitializationRuntime();
  return { services, connection, assets, assistants, groups, executor, summary };
}
const input = { capabilityKind: 'summary', name: '摘要', baseUrl: 'https://models.invalid/v1', apiKey: 'original', model: 'text-model', temperature: 0, topP: null, maxTokens: null };
{
  const db = database();
  await runMigrations(raw(db));
  const app = runtime(db);
  const image = await app.assets.insertModelConfig({ ...input, capabilityKind: 'image_generation', name: '生图', model: 'image' });
  assert.equal((await app.assets.listModelConfigs({ capabilityKind: 'image_generation' }))[0].id, image.id);
  assert.equal(image.temperature, 0, '仓储信任草稿层的字段契约，不自行重写采样参数');
  assert.equal(db.prepare('SELECT count(*) n FROM auxiliary_model_initial_defaults').get().n, 0, '生图不参与首次资产初始化');
  assert.equal(db.prepare('SELECT model_config_id FROM media_image_generation_settings').get().model_config_id, null);
  await app.assets.updateModelConfig(image.id, { name: '新的生图配置', temperature: null, topP: null, maxTokens: null });
  assert.equal((await app.assets.getModelConfigById(image.id)).name, '新的生图配置');
  await app.assets.deleteModelConfig(image.id);
  assert.equal(await app.assets.getModelConfigById(image.id), null);
  db.close();
}
{
  const db = database(); const app = runtime(db);
  const [summary, vision] = await Promise.all([app.assets.insertModelConfig(input), app.assets.insertModelConfig({ ...input, capabilityKind: 'ocr', name: '视觉', model: 'vision' })]);
  assert.equal(summary.serviceConfigId, vision.serviceConfigId, '相同连接的并发保存只有一份服务');
  assert.equal((await app.services.listModelServices()).length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auxiliary_model_initial_defaults').get().n, 1, '摘要不参与首次默认初始化');
  assert.equal(db.prepare('SELECT api_key FROM auxiliary_model_configs WHERE id=?').get(summary.id).api_key, null, '引用用途不再保存凭据副本');
  const service = await app.services.getModelService(summary.serviceConfigId);
  await app.services.saveModelService(service.id, { ...service, apiKey: 'rotated' });
  assert.equal((await app.assets.getModelConfigById(summary.id)).apiKey, 'rotated');
  assert.equal((await app.assets.getModelConfigById(vision.id)).apiKey, 'rotated');
  await app.services.saveModelService(service.id, { name: '重命名服务' });
  assert.equal((await app.assets.getModelConfigById(vision.id)).apiKey, 'rotated', '名称增量不覆盖最新凭据');
  assert.equal((await app.assets.getModelConfigById(summary.id)).temperature, 0);
  await app.assets.updateModelConfig(summary.id, { apiKey: 'private' });
  assert.notEqual((await app.assets.getModelConfigById(summary.id)).serviceConfigId, service.id, '用途改凭据只重新绑定自身');
  assert.equal((await app.assets.getModelConfigById(vision.id)).apiKey, 'rotated');
  await app.services.setAutoSaveModelServices(false);
  const detached = await app.assets.insertModelConfig({ ...input, apiKey: 'not-collected' });
  assert.equal(detached.serviceConfigId, null);
  assert.equal((await app.services.listModelServices()).length, 2);
  const reused = await app.assets.insertModelConfig({ ...input, apiKey: 'rotated' });
  assert.equal(reused.serviceConfigId, service.id, '关闭自动保存仍可引用已有连接');
  const selected = await app.assets.updateModelConfig(detached.id, { serviceConfigId: service.id });
  assert.equal(selected.apiKey, 'rotated', '显式选择按服务 ID 绑定，不依赖旧字段是否变化');
  assert.equal(selected.serviceConfigId, service.id);
  const explicit = await app.assets.insertModelConfig({ ...input, serviceConfigId: service.id, apiKey: 'stale-preview' });
  assert.equal(explicit.apiKey, 'rotated', '新建用途按明确引用读取当前服务');
  const { createAIProfile } = load('src/features/assistants/domain/AIProfile.ts', { '@shared/prompt': load('src/shared/prompt/contextWindowLimits.ts') });
  const roleCreated = await app.assistants.insert(createAIProfile({ id: 'new-role', agentId: 'actor-new-role', name: '新角色', model: 'chat', serviceConfigId: service.id, apiBaseUrl: input.baseUrl, apiKey: 'stale-preview' }));
  assert.equal(roleCreated.apiKey, 'rotated', '角色创建返回实际提交的服务快照');


  await app.assets.updateModelConfig(reused.id, { apiKey: null });
  assert.equal((await app.assets.getModelConfigById(reused.id)).apiKey, null, '清空凭据解除引用，不继承旧 Key');
  assert.equal((await app.assets.getModelConfigById(vision.id)).apiKey, 'rotated');
  const invalid = await app.assets.insertModelConfig({ ...input, baseUrl: 'unfinished' });
  assert.equal(invalid.serviceConfigId, null, '自动收录不改变原配置可保存的边界');
  await app.services.setAutoSaveModelServices(true);
  db.exec("CREATE TRIGGER reject_model BEFORE INSERT ON auxiliary_model_configs WHEN NEW.name='reject' BEGIN SELECT RAISE(ABORT,'模拟用途写入失败'); END");
  const before = (await app.services.listModelServices()).length;
  await assert.rejects(app.assets.insertModelConfig({ ...input, name: 'reject', apiKey: 'rollback' }), /用途写入失败/);
  assert.equal((await app.services.listModelServices()).length, before, '用途失败不能残留自动创建的服务');
  const countBeforeDedicated = (await app.services.listModelServices()).length;
  const dedicated = [
    ['stt', 'tencentRealtimeAsr'], ['stt', 'dashscopeRealtimeAsr'],
    ['stt', 'volcengineRealtimeAsr'], ['stt', 'stepfunRealtimeAsr'],
    ...['openai', 'openrouter', 'minimaxT2aV2', 'elevenlabs', 'fishAudio'].map(provider => ['tts', provider]),
    ['translation', 'tencentCloudTmt'],
  ];
  for (const [capabilityKind, provider] of dedicated) {
    const config = await app.assets.insertModelConfig({ ...input, capabilityKind, apiKey: `dedicated-${provider}`,
      metadataJson: JSON.stringify({ provider, secretId: 'account', voiceId: 'voice' }), serviceConfigId: service.id });
    assert.equal(config.serviceConfigId, null, `${provider} 不能引用其他服务，即使传入服务 ID`);
    assert.equal(config.apiKey, `dedicated-${provider}`);
    const edited = await app.assets.updateModelConfig(config.id, { apiKey: `edited-${provider}`, serviceConfigId: service.id });
    assert.equal(edited.serviceConfigId, null);
    assert.equal(edited.apiKey, `edited-${provider}`);
    assert.equal(JSON.parse(edited.metadataJson).secretId, 'account');
  }
  assert.equal((await app.services.listModelServices()).length, countBeforeDedicated, '专用提供方的创建和编辑都不自动收录服务');
  const customVoice = await app.assets.insertModelConfig({ ...input, capabilityKind: 'tts', serviceConfigId: service.id,
    metadataJson: '{"provider":"openaiCompatible","voiceId":"custom-voice"}' });
  assert.equal(customVoice.serviceConfigId, service.id, '只有自定义兼容 TTS 参与共享连接');
  // 角色和管理员继续拥有自己的模型参数，只共享连接。
  db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,api_base_url,api_key,created_at,updated_at) VALUES ('role','actor-role','角色','chat',?,?,'old','old')").run(input.baseUrl, 'rotated');
  await app.assistants.updateModelSettings('role', { apiKey: 'rotated' });
  assert.equal(db.prepare("SELECT service_config_id FROM ai_assistants WHERE id='role'").get().service_config_id, service.id);
  assert.equal((await app.assistants.getById('role')).apiKey, 'rotated');
  db.exec("INSERT INTO chat_conversations(id,kind) VALUES('group','group'); INSERT INTO group_chats(id,name,created_at,updated_at) VALUES('group','群','old','old'); INSERT INTO group_chat_admin_configs(group_id,name,model,created_at,updated_at) VALUES('group','管理员','admin','old','old');");
  await app.groups.updateAdminConfig('group', { apiBaseUrl: input.baseUrl, apiKey: 'rotated' });
  assert.equal(db.prepare("SELECT service_config_id FROM group_chat_admin_configs WHERE group_id='group'").get().service_config_id, service.id);
  db.exec("INSERT INTO chat_conversations(id,kind) VALUES('role-conversation','direct'); INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES('role-conversation','role','会话','old','old'); INSERT INTO chat_summary_state(conversation_id,processed_cursor,generation,revision,claim_id) VALUES('role-conversation','kept',2,0,'role-claim'),('group','kept-group',3,0,'group-claim');");
  await app.services.saveModelService(service.id, { ...service, apiKey: 'shared-next' });
  for (const [id, generation] of [['role-conversation', 3], ['group', 4]]) {
    const state = db.prepare('SELECT * FROM chat_summary_state WHERE conversation_id=?').get(id);
    assert.equal(state.generation, generation, '跟随角色或管理员的摘要也撤销旧请求资格');
    assert.equal(state.claim_id, null); assert.ok(state.processed_cursor.startsWith('kept'));
  }
  db.exec("CREATE TRIGGER reject_service_invalidation BEFORE INSERT ON chat_summary_work_queue WHEN NEW.conversation_id='role-conversation' BEGIN SELECT RAISE(ABORT,'模拟撤销资格失败'); END");
  await assert.rejects(app.services.saveModelService(service.id, { apiKey: 'cannot-commit' }), /撤销资格失败/);
  assert.equal((await app.services.getModelService(service.id)).apiKey, 'shared-next', '资格撤销失败时服务更新也必须回滚');
  db.exec('DROP TRIGGER reject_service_invalidation');
  assert.equal((await app.assistants.getById('role')).apiKey, 'shared-next');
  assert.equal((await app.groups.getAdminConfig('group')).apiKey, 'shared-next');
  await app.groups.updateAdminConfig('group', { apiKey: 'admin-own' });
  assert.equal((await app.assistants.getById('role')).apiKey, 'shared-next');
  assert.equal((await app.groups.getAdminConfig('group')).model, 'admin');
  await app.assistants.updateModelSettings('role', { apiKey: null });
  assert.equal((await app.assistants.getById('role')).apiKey, null);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
}
// 删除共享服务保留资产与选择，清空三类 owner 的连接，并且任何一步失败都原子回滚。
{
  const db = database(); await runMigrations(raw(db)); const app = runtime(db);
  const service = await app.services.saveModelService(null, { name: '共享连接', ...app.connection.getModelServiceConnection(input.baseUrl, 'delete-key') });
  const other = await app.services.saveModelService(null, { name: '保留连接', ...app.connection.getModelServiceConnection(input.baseUrl, 'other-key') });
  await assert.rejects(app.services.saveModelService(null, { ...service }), error => error.kind === 'duplicate');
  await assert.rejects(app.services.saveModelService(other.id, { apiKey: service.apiKey }), error => error.kind === 'duplicate');
  assert.equal((await app.services.getModelService(other.id)).apiKey, 'other-key');
  const assets = [];
  for (const capabilityKind of ['summary', 'embedding', 'ocr', 'image_generation', 'tts', 'translation']) {
    assets.push(await app.assets.insertModelConfig({ ...input, capabilityKind, serviceConfigId: service.id,
      metadataJson: capabilityKind === 'translation' ? '{"provider":"aiModel"}' : null }));
  }
  db.prepare('UPDATE memory_model_settings SET embedding_model_config_id = ? WHERE id = 1').run(assets[1].id);
  db.prepare('UPDATE sticker_system_config SET embedding_model_config_id = ?').run(assets[1].id);
  await app.services.setAutoSaveModelServices(false);
  const manual = await app.assets.insertModelConfig({ ...input, apiKey: 'manual-key' });
  db.prepare(`INSERT INTO ai_assistants(id,agent_id,name,model,service_config_id,created_at,updated_at)
    VALUES('delete-role','delete-actor','保留角色','role-model',?,'old','old')`).run(service.id);
  db.exec(`INSERT INTO chat_conversations(id,kind) VALUES('delete-direct','direct'),('delete-group','group'),('delete-summary','direct');
    INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES('delete-direct','delete-role','保留会话','old','old');
    INSERT INTO group_chats(id,name,created_at,updated_at) VALUES('delete-group','保留群','old','old');`);
  db.prepare(`INSERT INTO group_chat_admin_configs(group_id,name,model,system_prompt,service_config_id,created_at,updated_at)
    VALUES('delete-group','保留管理员','admin-model','保留提示词',?,'old','old')`).run(service.id);
  db.prepare('INSERT INTO chat_summary_request_settings(conversation_id,model_config_id) VALUES(?,?)').run('delete-summary', assets[0].id);
  db.exec(`INSERT INTO chat_summary_state(conversation_id,processed_cursor,generation,revision,claim_id)
    VALUES('delete-direct','kept-direct',1,2,'direct-claim'),('delete-group','kept-group',3,4,'group-claim'),('delete-summary','kept-summary',5,6,'summary-claim');`);
  await app.services.saveModelService(service.id, { baseUrl: 'https://new.invalid/v1', apiKey: 'new-key' });
  for (const asset of assets) {
    const current = await app.assets.getModelConfigById(asset.id);
    assert.equal(current.serviceConfigId, service.id); assert.equal(current.apiKey, 'new-key'); assert.equal(current.baseUrl, 'https://new.invalid/v1');
  }
  assert.equal((await app.assistants.getById('delete-role')).serviceConfigId, service.id);
  assert.equal((await app.groups.getAdminConfig('delete-group')).serviceConfigId, service.id);
  const snapshotTables = ['model_service_configs','auxiliary_model_configs','ai_assistants','group_chat_admin_configs',
    'chat_conversations','sessions','group_chats','chat_summary_state','chat_summary_request_settings','chat_summary_work_queue','chat_summary_tasks',
    'memory_embedding_index_control','sticker_embedding_index_control','memory_model_settings','sticker_system_config'];
  const snapshot = () => snapshotTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  for (const trigger of [
    `CREATE TRIGGER reject_delete BEFORE INSERT ON chat_summary_work_queue BEGIN SELECT RAISE(ABORT,'模拟资格失败'); END`,
    `CREATE TRIGGER reject_delete BEFORE UPDATE ON memory_embedding_index_control BEGIN SELECT RAISE(ABORT,'模拟向量资格失败'); END`,
    `CREATE TRIGGER reject_delete BEFORE UPDATE OF service_config_id ON group_chat_admin_configs WHEN OLD.service_config_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'模拟解绑失败'); END`,
    `CREATE TRIGGER reject_delete BEFORE DELETE ON model_service_configs BEGIN SELECT RAISE(ABORT,'模拟删除失败'); END`,
  ]) {
    const before = snapshot(); db.exec(trigger);
    await assert.rejects(app.services.deleteModelServiceKey(service.id), /模拟/);
    assert.deepEqual(snapshot(), before, '资格、解绑或删除任一步失败都不能留下部分修改');
    db.exec('DROP TRIGGER reject_delete');
  }
  const beforeAssets = await Promise.all(assets.map(asset => app.assets.getModelConfigById(asset.id)));
  const beforeStates = db.prepare('SELECT * FROM chat_summary_state ORDER BY conversation_id').all();
  const embeddingRevision = db.prepare('SELECT revision FROM memory_embedding_index_control').get().revision;
  const stickerRevision = db.prepare('SELECT revision FROM sticker_embedding_index_control').get().revision;
  const selections = db.prepare('SELECT * FROM chat_summary_request_settings').all();
  const counts = snapshotTables.slice(1).map(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  assert.deepEqual(await app.services.deleteModelServiceKey(service.id), ['delete-role']);
  assert.equal(db.prepare('SELECT revision FROM memory_embedding_index_control').get().revision, embeddingRevision + 1);
  assert.equal(db.prepare('SELECT revision FROM sticker_embedding_index_control').get().revision, stickerRevision + 1);
  assert.equal(db.prepare('SELECT embedding_model_config_id FROM memory_model_settings').get().embedding_model_config_id, assets[1].id);
  const resolver = load('src/features/assistants/ResolveAuxiliaryModel.ts', {
    './infrastructure/SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: app.assets },
    '@features/speech': load('src/features/speech/application/SpeechProviderCatalog.ts'),
    '@features/integrations': load('src/features/integrations/domain/TranslationModel.ts'),
  });
  for (const asset of assets) {
    assert.equal(await resolver.resolveAuxiliaryModel({ modelConfigId: asset.id, capabilityKind: asset.capabilityKind }), null, '删除后新任务不能解析旧连接');
    const selection = await resolver.getAuxiliaryModelSelection({ modelConfigId: asset.id, capabilityKind: asset.capabilityKind });
    assert.equal(selection.status, 'unavailable'); assert.equal(selection.selectedModelId, asset.id);
  }
  for (const asset of beforeAssets) {
    const current = await app.assets.getModelConfigById(asset.id);
    assert.equal(current.serviceConfigId, null); assert.equal(current.baseUrl, ''); assert.equal(current.apiKey, null);
    const { serviceConfigId, baseUrl, apiKey, updatedAt, ...kept } = current;
    const { serviceConfigId: _s, baseUrl: _u, apiKey: _k, updatedAt: _t, ...before } = asset;
    assert.deepEqual(kept, before, '模型身份、参数和 metadata 保留');
  }
  const role = await app.assistants.getById('delete-role'), admin = await app.groups.getAdminConfig('delete-group');
  for (const owner of [role, admin]) {
    assert.equal(owner.serviceConfigId, null); assert.equal(owner.apiBaseUrl, null); assert.equal(owner.apiKey, null);
  }
  assert.equal(role.model, 'role-model'); assert.equal(admin.model, 'admin-model'); assert.equal(admin.systemPrompt, '保留提示词');
  for (const state of beforeStates) {
    const current = db.prepare('SELECT * FROM chat_summary_state WHERE conversation_id=?').get(state.conversation_id);
    assert.equal(current.generation, state.generation + 1); assert.equal(current.claim_id, null); assert.equal(current.processed_cursor, state.processed_cursor);
  }
  assert.deepEqual(db.prepare('SELECT * FROM chat_summary_request_settings').all(), selections, '不清空摘要资产选择');
  assert.deepEqual(snapshotTables.slice(1).map(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n), counts, '不删除任何引用方或聊天数据');
  assert.deepEqual(await app.assets.getModelConfigById(manual.id), manual, '手工连接不受影响');
  assert.deepEqual(await app.services.getModelService(other.id), other);
  await app.services.deleteModelServiceKey(service.id); // 重复删除是幂等的。
  for (const enabled of [false, true]) {
    await app.services.setAutoSaveModelServices(enabled);
    for (const asset of assets) await app.assets.updateModelConfig(asset.id, { name: '新名称', model: 'new-model', temperature: 0.5 });
    await app.assistants.updateModelSettings(role.id, { model: 'next-model' });
    await app.groups.updateAdminConfig('delete-group', { model: 'next-admin' });
    await runMigrations(raw(db));
    assert.equal((await app.services.listModelServices()).length, 1, '参数修改、偏好切换和重启不能复活旧服务');
  }
  const recreated = await app.services.saveModelService(null, { ...service });
  assert.notEqual(recreated.id, service.id);
  for (const asset of assets) assert.equal((await app.assets.getModelConfigById(asset.id)).serviceConfigId, null, '相同连接的新服务不能恢复旧绑定');
  await app.assets.updateModelConfig(assets[0].id, { serviceConfigId: other.id });
  assert.equal((await app.assets.getModelConfigById(assets[0].id)).apiKey, other.apiKey, '用户主动重绑才能恢复连接');
  const references = db.prepare(`SELECT m.name, f."from" AS column_name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
    WHERE m.type='table' AND f."table"='model_service_configs' ORDER BY m.name`).all();
  assert.deepEqual(references.map(row => row.name), ['ai_assistants','auxiliary_model_configs','group_chat_admin_configs'], '新增引用 owner 时必须纳入服务生命周期');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
}

// 已提交的保存与删除不得因投影失败被重新报告为写入失败；错误提示和日志不能包含凭据。
{
  const db = database(); const app = runtime(db);
  const errors = serviceErrors;
  const events = load('src/features/assistants/AuxiliaryModelsChanged.ts');
  const notifications = []; let failProjection = false;
  const commands = load('src/features/assistants/ModelServices.ts', {
    './infrastructure/SQLiteModelServiceRepository': app.services, './AuxiliaryModelsChanged': events, './ModelServiceErrors': errors,
    './AIAssistantManagement': { notifyAssistantServiceConnectionsChanged: async (id, detachedIds) => {
      notifications.push({ id, detachedIds }); if (failProjection) throw new Error('projection private-key'); return true;
    } },
  });
  const logs = []; const warn = console.warn;
  console.warn = (...args) => logs.push(args);
  try {
    let refreshed = 0;
    events.subscribeAuxiliaryModelsChanged(() => { throw new Error('listener private-key'); });
    events.subscribeAuxiliaryModelsChanged(() => { refreshed++; });
    const createInput = { name: '服务', baseUrl: input.baseUrl, authType: 'apiKey', keys: [{ name: '', apiKey: 'private-key', credentialsJson: '{}' }] };
    const { group, refreshWarning } = await commands.createModelServiceGroupConfig(createInput);
    const config = group.keys[0];
    assert.ok(refreshWarning); assert.equal((await app.services.getModelService(config.id)).apiKey, 'private-key'); assert.equal(refreshed, 1);
    await assert.rejects(commands.createModelServiceGroupConfig(createInput), error => error.kind === 'duplicate' && !error.message.includes('private-key'));
    failProjection = true;
    assert.ok((await commands.saveModelServiceKeyConfig(config.groupId, config.id, { apiKey: 'next-key' })).refreshWarning);
    assert.equal((await app.services.getModelService(config.id)).apiKey, 'next-key');
    const { AutoSaveDraftEditor } = load('src/shared/ui/AutoSaveDraftEditor.ts');
    const editor = new AutoSaveDraftEditor({ name: config.name }, (draft, changed) => ({ patch: { name: draft.name }, accepted: changed, errors: {} }),
      async patch => { assert.ok((await commands.updateModelServiceGroupConfig(config.groupId, patch)).refreshWarning); });
    editor.change({ name: '已确认名称' }); assert.equal(await editor.flush(), true);
    assert.equal(editor.getSnapshot().saveError, null); assert.equal(editor.getSnapshot().dirty, false);
    assert.ok((await commands.deleteModelServiceKeyConfig(config.id)).refreshWarning);
    assert.deepEqual(notifications.at(-1), { id: config.id, detachedIds: [] });
    assert.equal((await app.services.listModelServices()).length, 0);
    for (const [message, kind] of [
      ['FOREIGN KEY constraint failed', 'foreign_key'], ['SQLITE_BUSY private-key', 'busy'], ['database is locked', 'locked'],
      ['no such table: model_service_configs', 'schema'], ['database is closed', 'connection'], ['CHECK constraint failed', 'constraint'], ['private-key', 'unknown'],
    ]) {
      const wrapped = new databaseErrors.CoordinatedDatabaseError('unknown', { feature: 'assistants', name: 'test' }, new Error(message));
      assert.equal(errors.describeModelServiceFailure(wrapped).kind, kind);
      assert.equal(errors.describeModelServiceFailure(wrapped).message.includes('private-key'), false);
    }
    assert.equal(JSON.stringify(logs).includes('private-key'), false);
  } finally { console.warn = warn; db.close(); }
}
// 一个配置共享地址，多 Key 的绑定、改名、删除、编号和回滚互相隔离。
{
  const db = database(); await runMigrations(raw(db)); const app = runtime(db);
  let group = await app.services.createModelServiceGroup({ name: '中转站', baseUrl: input.baseUrl, authType: 'apiKey', keys: [
    { name: '', apiKey: 'key-a', credentialsJson: '{}' }, { name: '识图', apiKey: 'key-b', credentialsJson: '{}' },
    { name: '语音', apiKey: 'key-c', credentialsJson: '{}' },
  ] });
  assert.deepEqual(group.keys.map(key => key.keyName), ['1', '识图', '语音']);
  const [a, b, c] = group.keys;
  const summary = await app.assets.insertModelConfig({ ...input, serviceConfigId: a.id });
  const embedding = await app.assets.insertModelConfig({ ...input, capabilityKind: 'embedding', serviceConfigId: b.id });
  const voice = await app.assets.insertModelConfig({ ...input, capabilityKind: 'tts', serviceConfigId: c.id, metadataJson: '{"provider":"openaiCompatible"}' });
  db.prepare('UPDATE memory_model_settings SET embedding_model_config_id = ? WHERE id = 1').run(embedding.id);
  db.prepare(`INSERT INTO ai_assistants(id,agent_id,name,model,service_config_id,created_at,updated_at)
    VALUES('multi-role','multi-actor','角色','role-model',?,'old','old')`).run(b.id);
  db.exec(`INSERT INTO chat_conversations(id,kind) VALUES('multi-group','group');
    INSERT INTO group_chats(id,name,created_at,updated_at) VALUES('multi-group','群','old','old');`);
  db.prepare(`INSERT INTO group_chat_admin_configs(group_id,name,model,service_config_id,created_at,updated_at)
    VALUES('multi-group','管理员','admin-model',?,'old','old')`).run(c.id);
  await app.services.saveModelServiceKey(group.id, a.id, { apiKey: 'rotated-a' });
  assert.equal((await app.assets.getModelConfigById(summary.id)).apiKey, 'rotated-a');
  assert.equal((await app.assets.getModelConfigById(embedding.id)).apiKey, 'key-b');
  assert.equal((await app.groups.getAdminConfig('multi-group')).apiKey, 'key-c');
  await app.services.saveModelServiceKey(group.id, b.id, { name: '视觉' });
  assert.equal((await app.services.getModelService(b.id)).keyName, '视觉');
  assert.equal((await app.assistants.getById('multi-role')).serviceConfigId, b.id);
  group = await app.services.updateModelServiceGroup(group.id, { name: '共享中转', baseUrl: 'https://multi.invalid/v2' });
  for (const [asset, key] of [[summary,a],[embedding,b],[voice,c]]) {
    const current = await app.assets.getModelConfigById(asset.id);
    assert.equal(current.serviceConfigId, key.id); assert.equal(current.baseUrl, group.baseUrl);
    assert.equal(current.model, asset.model); assert.equal(current.temperature, asset.temperature);
  }
  assert.equal((await app.assistants.getById('multi-role')).apiBaseUrl, group.baseUrl);
  assert.equal((await app.groups.getAdminConfig('multi-group')).apiBaseUrl, group.baseUrl);
  const count = (await app.services.listModelServiceGroups()).length;
  const reused = await app.assets.insertModelConfig({ ...input, baseUrl: group.baseUrl, apiKey: 'key-b' });
  assert.equal(reused.serviceConfigId, b.id); assert.equal((await app.services.listModelServiceGroups()).length, count, '自动收录复用具体 Key');
  const snapshot = () => ['model_service_groups','model_service_configs','auxiliary_model_configs','ai_assistants',
    'group_chat_admin_configs','memory_embedding_index_control','chat_summary_state','chat_summary_work_queue'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const beforeDuplicate = snapshot();
  await assert.rejects(app.services.createModelServiceGroup({ name: '重复', baseUrl: group.baseUrl, authType: 'apiKey', keys: [
    { name: '', apiKey: 'unique-but-rolled-back', credentialsJson: '{}' }, { name: '', apiKey: 'key-b', credentialsJson: '{}' },
  ] }), error => error.kind === 'duplicate');
  assert.deepEqual(snapshot(), beforeDuplicate, '多个 Key 创建失败不能留下分组或部分 Key');
  const duplicate = await Promise.allSettled([1,2].map(() => app.services.saveModelServiceKey(group.id, null, { name: '', apiKey: 'concurrent-key', credentialsJson: '{}' })));
  assert.equal(duplicate.filter(result => result.status === 'fulfilled').length, 1, '并发新增相同 Key 只有一个 winner');
  await app.services.deleteModelServiceKey(a.id);
  assert.equal((await app.assets.getModelConfigById(summary.id)).serviceConfigId, null);
  assert.equal((await app.assets.getModelConfigById(embedding.id)).serviceConfigId, b.id);
  assert.equal((await app.assets.getModelConfigById(voice.id)).serviceConfigId, c.id);
  assert.equal((await app.groups.getAdminConfig('multi-group')).apiKey, 'key-c');
  const added = await app.services.saveModelServiceKey(group.id, null, { name: '', apiKey: 'key-next', credentialsJson: '{}' });
  assert.equal(added.ordinal, 5); assert.equal(added.keyName, '5');
  assert.equal((await app.services.getModelService(b.id)).keyName, '视觉');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-service-keys-'));
  try {
    const file = path.join(directory, 'snapshot.db'); await backup(db, file);
    const restored = new DatabaseSync(file);
    try {
      await runMigrations(raw(restored));
      assert.deepEqual(await runtime(restored).services.getModelServiceGroup(group.id), await app.services.getModelServiceGroup(group.id));
      assert.equal((await runtime(restored).assistants.getById('multi-role')).serviceConfigId, b.id);
    } finally { restored.close(); }
    fs.unlinkSync(file);
  } finally { fs.rmdirSync(directory); }
  const beforeDelete = snapshot();
  db.prepare(`CREATE TRIGGER reject_group_delete BEFORE DELETE ON model_service_configs WHEN OLD.id = '${added.id}' BEGIN SELECT RAISE(ABORT,'模拟整组删除失败'); END`).run();
  await assert.rejects(app.services.deleteModelServiceGroup(group.id), /整组删除失败/);
  assert.deepEqual(snapshot(), beforeDelete, '整组删除中后面的 Key 失败时，前面的解绑也必须回滚');
  db.exec('DROP TRIGGER reject_group_delete');
  await app.services.deleteModelServiceGroup(group.id);
  assert.equal((await app.assistants.getById('multi-role')).apiKey, null);
  assert.equal((await app.groups.getAdminConfig('multi-group')).apiKey, null);
  assert.equal((await app.assets.getModelConfigById(embedding.id)).serviceConfigId, null);
  assert.equal((await app.services.listModelServiceGroups()).length, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.close();
}
// 175 升级保留具体连接 ID 与引用，不按同地址合并分组；迁移失败包含 DDL 一起回滚。
{
  const db = database(); const app = runtime(db);
  const a = await app.services.saveModelService(null, { name: '旧服务甲', ...app.connection.getModelServiceConnection(input.baseUrl, 'old-a') });
  const b = await app.services.saveModelService(null, { name: '旧服务乙', ...app.connection.getModelServiceConnection(input.baseUrl, 'old-b') });
  const asset = await app.assets.insertModelConfig({ ...input, serviceConfigId: a.id });
  restoreLegacyServices(db); db.exec('PRAGMA user_version = 175');
  const before = db.prepare('SELECT * FROM model_service_configs ORDER BY id').all();
  db.exec("CREATE TRIGGER reject_group_migration BEFORE UPDATE OF name ON model_service_configs BEGIN SELECT RAISE(ABORT,'模拟分组迁移失败'); END");
  await assert.rejects(runMigrations(raw(db)), /分组迁移失败/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 175);
  assert.deepEqual(db.prepare('SELECT * FROM model_service_configs ORDER BY id').all(), before);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'model_service_groups'").get(), undefined);
  db.exec('DROP TRIGGER reject_group_migration');
  await runMigrations(raw(db));
  assert.equal((await app.services.listModelServiceGroups()).length, 2);
  for (const key of [a,b]) {
    const current = await app.services.getModelService(key.id);
    assert.equal(current.groupId, key.id); assert.equal(current.keyName, '1');
    assert.equal(current.apiKey, key.apiKey); assert.equal(current.name, key.name); assert.equal(current.createdAt, key.createdAt); assert.equal(current.updatedAt, key.updatedAt);
  }
  assert.equal((await app.assets.getModelConfigById(asset.id)).serviceConfigId, a.id);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const groups = await app.services.listModelServiceGroups(); await runMigrations(raw(db));
  assert.deepEqual(await app.services.listModelServiceGroups(), groups); db.close();
}
// 表单只转换自己修改的字段；新 Key 必须完整，名称留空合法。
{
  const { parseServiceGroupDraft, parseServiceKeyDraft } = load('src/features/assistants/presentation/auxiliaryModels/modelServiceDraft.ts');
  assert.deepEqual(parseServiceGroupDraft({ name: ' 新名称 ', baseUrl: 'invalid' }, ['name']).patch, { name: '新名称' });
  assert.ok(parseServiceGroupDraft({ name: '', baseUrl: 'invalid' }, ['name','baseUrl']).errors.baseUrl);
  const key = { name: '', apiKey: ' key ', secretId: '', appId: '' };
  assert.deepEqual(parseServiceKeyDraft(key, [], 'apiKey', true).patch, { name: '', apiKey: 'key', credentialsJson: '{}' });
  assert.deepEqual(parseServiceKeyDraft({ ...key, apiKey: '' }, ['name'], 'apiKey', true).accepted, []);
  assert.deepEqual(parseServiceKeyDraft({ ...key, apiKey: '' }, ['name'], 'apiKey').patch, { name: '' });
}
function legacy() {
  const db = database(true);
  db.exec("INSERT INTO ai_assistants(id,agent_id,name,model,api_base_url,api_key,created_at,updated_at) VALUES('role','actor-role','角色','chat','https://models.invalid/v1','original','old','old'); INSERT INTO chat_conversations(id,kind) VALUES('conversation','direct'); INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES('conversation','role','会话','old','old');");
  db.prepare(`INSERT INTO auxiliary_model_configs(id,capability_kind,name,base_url,api_key,model,temperature,top_p,max_tokens,enabled,metadata_json,created_at,updated_at)
    VALUES('existing','general','原摘要',?,?,?,0,NULL,NULL,0,NULL,'created','updated')`).run(input.baseUrl, input.apiKey, input.model);
  db.exec("INSERT INTO chat_summary_request_settings(conversation_id,model_config_id) VALUES('conversation','existing'); INSERT INTO chat_summary_state(conversation_id,processed_cursor,generation,revision) VALUES('conversation',9,2,3);");
  return db;
}
{
  const db = legacy();
  const before = { ...db.prepare("SELECT * FROM chat_summary_state WHERE conversation_id='conversation'").get() };
  await runMigrations(raw(db));
  const app = runtime(db); const config = await app.assets.getModelConfigById('existing');
  assert.equal(config.capabilityKind, 'summary'); assert.equal(config.id, 'existing');
  assert.equal(config.apiKey, 'original'); assert.equal(config.model, input.model); assert.equal(config.temperature, 0); assert.equal(config.maxTokens, null);
  assert.equal(config.createdAt, 'created'); assert.equal(config.updatedAt, 'updated');
  assert.equal(db.prepare("SELECT model_config_id FROM chat_summary_request_settings WHERE conversation_id='conversation'").get().model_config_id, 'existing');
  assert.deepEqual({ ...db.prepare("SELECT * FROM chat_summary_state WHERE conversation_id='conversation'").get() }, before, '迁移保留摘要进度与资格');
  assert.equal((await app.assistants.getById('role')).apiKey, 'original');
  const service = await app.services.getModelService(config.serviceConfigId);
  const claim = { ...db.prepare("SELECT generation,revision FROM chat_summary_state WHERE conversation_id='conversation'").get() };
  await app.services.saveModelService(service.id, { ...service, apiKey: 'updated' });
  const after = db.prepare("SELECT generation,revision,processed_cursor FROM chat_summary_state WHERE conversation_id='conversation'").get();
  assert.equal(after.generation, claim.generation + 1); assert.equal(after.processed_cursor, before.processed_cursor, '更新服务只撤销旧资格，不清空摘要进度');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-services-'));
  try {
    const file = path.join(directory, 'snapshot.db'); await backup(db, file);
    const restored = new DatabaseSync(file);
    try { await runMigrations(raw(restored)); assert.equal((await runtime(restored).assets.getModelConfigById('existing')).apiKey, 'updated');
      assert.equal((await runtime(restored).services.listModelServices()).length, 1); } finally { restored.close(); }
    fs.unlinkSync(file);
  } finally { fs.rmdirSync(directory); }
  await app.services.setAutoSaveModelServices(false); await runMigrations(raw(db));
  assert.equal(await app.services.getAutoSaveModelServices(), false, '普通启动不覆盖自动保存偏好');
  db.close();
}
{
  const db = legacy(); const io = raw(db);
  await assert.rejects(runMigrations({ ...io, runAsync: async (sql, values) => {
    if (sql.startsWith('UPDATE auxiliary_model_configs SET service_config_id')) throw new Error('模拟迁移失败');
    return io.runAsync(sql, values);
  } }), /迁移失败/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 156);
  assert.equal(db.prepare("SELECT capability_kind FROM auxiliary_model_configs WHERE id='existing'").get().capability_kind, 'general');
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_service_configs').get().n, 0);
  await runMigrations(io); assert.equal((await runtime(db).assets.getModelConfigById('existing')).apiKey, 'original'); db.close();
}
// 157 只收录兼容连接；专用 STT 与腾讯翻译不进入通用服务，普通 AI 翻译正常建立引用。
{
  const db = database(true);
  const insert = db.prepare(`INSERT INTO auxiliary_model_configs(
    id,capability_kind,name,base_url,api_key,model,metadata_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run('stt', 'stt', 'STT', 'wss://example.invalid', 'key', 'stt-model',
    JSON.stringify({ provider: 'tencentRealtimeAsr', secretId: 'secret', appId: '123' }), 'old', 'old');
  insert.run('tencent', 'translation', '腾讯翻译', 'https://example.invalid', 'key', 'tencent-model',
    JSON.stringify({ provider: 'tencentCloudTmt', secretId: 'secret' }), 'old', 'old');
  insert.run('ai', 'translation', 'AI翻译', 'https://example.invalid/v1', 'key', 'ai-model',
    JSON.stringify({ provider: 'aiModel' }), 'old', 'old');
  await runMigrations(raw(db));
  const services = db.prepare('SELECT k.id, g.auth_type FROM model_service_configs k JOIN model_service_groups g ON g.id = k.group_id').all();
  assert.equal(services.length, 1);
  assert.equal(services[0].auth_type, 'apiKey');
  assert.equal(db.prepare('SELECT name FROM pragma_table_info(?)').all('auxiliary_model_configs')
    .some(column => column.name === 'enabled'), false, '167 移除已退出运行契约的 enabled 列');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_auxiliary_model_configs_enabled'").get().n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const models = Object.fromEntries(db.prepare('SELECT id, service_config_id, base_url, api_key FROM auxiliary_model_configs').all()
    .map(row => [row.id, row]));
  assert.equal(models.stt.service_config_id, null);
  assert.equal(models.stt.api_key, 'key');
  assert.equal(models.tencent.service_config_id, null);
  assert.equal(models.tencent.api_key, 'key');
  assert.equal(models.ai.service_config_id, 'service_auxiliary_model_configs_ai');
  assert.equal(models.ai.base_url, '');
  assert.equal(models.ai.api_key, null);
  const upgradedModels = db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all();
  await runMigrations(raw(db));
  assert.deepEqual(db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all(), upgradedModels, '重启不重复改写迁移结果');
  db.close();
}
// 已试用157的专用模型解除共享引用，保留当前有效连接、模型身份和参数。
{
  const db = database(); const app = runtime(db);
  const service = await app.services.saveModelService(null, { name: '旧连接', ...app.connection.getModelServiceConnection(input.baseUrl, 'shared') });
  const signed = await app.services.saveModelService(null, { name: '旧签名连接', baseUrl: 'https://signed.invalid', apiKey: 'secret-key', authType: 'tencentCloud', credentialsJson: '{"secretId":"account","appId":"123"}' });
  await app.services.setAutoSaveModelServices(false);
  const cases = [
    ['stt', 'tencentRealtimeAsr', signed, false], ['stt', 'dashscopeRealtimeAsr', service, false],
    ['stt', 'volcengineRealtimeAsr', service, false], ['stt', 'stepfunRealtimeAsr', service, false],
    ['tts', 'elevenlabs', service, false], ['tts', 'openaiCompatible', service, true],
    ['translation', 'tencentCloudTmt', signed, false], ['translation', 'aiModel', service, true],
    ['summary', undefined, service, true],
  ];
  const snapshots = [];
  for (const [kind, provider, connection, remainsShared] of cases) {
    const config = await app.assets.insertModelConfig({ ...input, capabilityKind: kind,
      metadataJson: provider ? JSON.stringify({ provider, voiceId: 'kept-voice', target: 'zh' }) : null });
    // 还原157曾经允许的共享状态，包括已经移入服务的腾讯云签名字段。
    db.prepare("UPDATE auxiliary_model_configs SET service_config_id=?,base_url='',api_key=NULL WHERE id=?").run(connection.id, config.id);
    snapshots.push({ config: await app.assets.getModelConfigById(config.id), remainsShared });
  }
  markHistoricalVersion(db, 157);
  const legacyAssetsBeforeFailure = db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all();
  db.exec("CREATE TRIGGER reject_detach BEFORE UPDATE OF service_config_id ON auxiliary_model_configs WHEN NEW.service_config_id IS NULL BEGIN SELECT RAISE(ABORT,'模拟解除引用失败'); END");
  await assert.rejects(runMigrations(raw(db)), /解除引用失败/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 157);
  assert.deepEqual(db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all(), legacyAssetsBeforeFailure, '迁移失败不改变任何连接或参数');
  db.exec('DROP TRIGGER reject_detach');
  await runMigrations(raw(db));
  for (const { config, remainsShared } of snapshots) {
    const current = await app.assets.getModelConfigById(config.id);
    assert.equal(current.serviceConfigId, remainsShared ? config.serviceConfigId : null);
    const { serviceConfigId: _old, ...before } = config;
    const { serviceConfigId: _new, ...after } = current;
    assert.deepEqual(after, before, '解除引用保留模型 ID、当前地址、凭据、metadata 和时间');
  }
  await app.services.saveModelService(service.id, { apiKey: 'updated-shared' });
  for (const { config, remainsShared } of snapshots) {
    const current = await app.assets.getModelConfigById(config.id);
    assert.equal(current.apiKey, remainsShared ? 'updated-shared' : config.apiKey, '更新服务不能再影响专用提供方');
  }
  assert.equal((await app.services.listModelServices()).length, 2, '不删除用户已经保存的服务');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
}
// 158 已解除引用，159 还必须从真实服务列表清掉可确认来源的自动副本。
for (const previousVersion of [157, 158]) {
  const db = database(); const app = runtime(db);
  await app.services.setAutoSaveModelServices(false);
  const removed = [], kept = [], configurations = [];
  async function historicalCopy(kind, provider, mode = 'remove') {
    const key = `${provider}-${mode}-${configurations.length}`;
    const metadata = { provider, ...(provider === 'tencentCloudTmt' ? { secretId: 'secret-id' } : {}), voiceId: 'kept' };
    const model = await app.assets.insertModelConfig({ ...input, capabilityKind: kind, apiKey: key, metadataJson: JSON.stringify(metadata) });
    const tencent = (kind === 'translation' && provider === 'tencentCloudTmt')
      || (kind === 'stt' && provider === 'tencentRealtimeAsr');
    const credentials = tencent && metadata.secretId ? { secretId: metadata.secretId } : {};
    const connection = {
      ...app.connection.getModelServiceConnection(model.baseUrl, model.apiKey),
      authType: tencent ? 'tencentCloud' : 'apiKey',
      credentialsJson: JSON.stringify(credentials),
    };
    const created = await app.services.saveModelService(null, { name: '历史服务', ...connection });
    const id = mode === 'manual' ? created.id : `service_auxiliary_model_configs_${model.id}`;
    if (mode !== 'manual') db.prepare('UPDATE model_service_configs SET id=? WHERE id=?').run(id, created.id);
    if (mode === 'edited') await app.services.saveModelService(id, { apiKey: 'repurposed-service-key' });
    if (mode === 'role') db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,service_config_id,created_at,updated_at) VALUES(?,?,'角色','chat',?,'old','old')").run(key, `actor-${key}`, id);
    if (mode === 'summary') await app.assets.insertModelConfig({ ...input, serviceConfigId: id });
    if (mode === 'group') {
      db.prepare("INSERT INTO chat_conversations(id,kind) VALUES(?,'group')").run(key);
      db.prepare("INSERT INTO group_chats(id,name,created_at,updated_at) VALUES(?,'群','old','old')").run(key);
      db.prepare("INSERT INTO group_chat_admin_configs(group_id,name,model,service_config_id,created_at,updated_at) VALUES(?,'管理员','chat',?,'old','old')").run(key, id);
    }
    if (previousVersion === 157 && mode === 'remove') {
      db.prepare("UPDATE auxiliary_model_configs SET service_config_id=?,base_url='',api_key=NULL,metadata_json=? WHERE id=?").run(id, JSON.stringify({ provider, voiceId: 'kept' }), model.id);
    }
    configurations.push(await app.assets.getModelConfigById(model.id));
    (mode === 'remove' ? removed : kept).push(id);
  }
  await historicalCopy('tts', 'elevenlabs');
  await historicalCopy('stt', 'dashscopeRealtimeAsr');
  await historicalCopy('translation', 'tencentCloudTmt');
  for (const mode of ['manual', 'edited', 'role', 'summary', 'group']) await historicalCopy('tts', 'elevenlabs', mode);
  await historicalCopy('tts', 'openaiCompatible', 'supported');
  await historicalCopy('translation', 'aiModel', 'supported');
  markHistoricalVersion(db, previousVersion);
  const legacyServicesBeforeFailure = db.prepare('SELECT * FROM model_service_configs ORDER BY id').all();
  const legacyAssetsBeforeFailure = db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all();
  db.exec(`
    CREATE TABLE delete_probe (count INTEGER NOT NULL); INSERT INTO delete_probe VALUES(0);
    CREATE TRIGGER reject_second_service_delete BEFORE DELETE ON model_service_configs BEGIN
      UPDATE delete_probe SET count=count+1;
      SELECT CASE WHEN (SELECT count FROM delete_probe)=2 THEN RAISE(ABORT,'模拟第二条服务清理失败') END;
    END;`);
  await assert.rejects(runMigrations(raw(db)), /服务清理失败/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, previousVersion);
  assert.equal(db.prepare('SELECT count FROM delete_probe').get().count, 0);
  assert.deepEqual(db.prepare('SELECT * FROM model_service_configs ORDER BY id').all(), legacyServicesBeforeFailure, '失败保留所有服务');
  assert.deepEqual(db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all(), legacyAssetsBeforeFailure);
  db.exec('DROP TRIGGER reject_second_service_delete');
  await runMigrations(raw(db));
  const listed = (await app.services.listModelServices()).map(service => service.id);
  for (const id of removed) assert.equal(listed.includes(id), false, '旧自动副本必须实际退出服务列表');
  for (const id of kept) assert.equal(listed.includes(id), true, '手动保存、已修改、仍被使用和兼容服务保留');
  for (const config of configurations) assert.deepEqual(await app.assets.getModelConfigById(config.id), { ...config, serviceConfigId: null });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
  await runMigrations(raw(db));
  assert.deepEqual((await app.services.listModelServices()).map(service => service.id), listed, '重启不重复清理');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
}
// 选择只保存连接与引用，不携带模型参数或尚未确认的其他草稿。
{
  const { AutoSaveDraftEditor } = load('src/shared/ui/AutoSaveDraftEditor.ts');
  const react = { useMemo: factory => factory(), useCallback: value => value, useState: value => [value, () => {}] };
  const service = { id: 'chosen-service', baseUrl: 'https://models.invalid/v1', apiKey: 'same-key' };
  const profile = { id: 'role', apiBaseUrl: service.baseUrl, apiKey: service.apiKey, model: 'own-model',
    serviceConfigId: null, temperature: 0.7, topP: null, maxTokens: 2000, enableTools: false, disableThinking: false };
  let editor; const writes = [];
  const hooks = { useAutoSaveDraft: options => {
    editor ??= new AutoSaveDraftEditor(options.initial, options.parse, options.save);
    return { ...editor.getSnapshot(), change: editor.change, getSnapshot: editor.getSnapshot };
  } };
  const role = load('src/features/assistants/presentation/management/AIModelSettings/useModelSettingsForm.ts', {
    react, '@shared/ui/useAutoSaveDraft': hooks,
    '../../../AIAssistantManagement': { updateAIModelSettings: async (_id, patch) => { writes.push(patch); return { ...profile, ...patch }; } },
  }).default;
  role({ aiAssistant: profile }); editor.change({ tempInput: 'invalid', enableTools: true });
  role({ aiAssistant: profile }).fillServiceConnection(service);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.deepEqual(writes, [{ serviceConfigId: service.id }], '地址和 Key 一样时仍明确绑定服务');
  assert.equal(editor.getSnapshot().draft.selectedModel, 'own-model');
  assert.equal(editor.getSnapshot().draft.tempInput, 'invalid');
  assert.equal(editor.getSnapshot().draft.enableTools, true);
  await editor.restore();
  assert.equal(editor.getSnapshot().draft.serviceConfigId, service.id);

  editor = undefined; writes.length = 0;
  const admin = load('src/features/chat/presentation/group/useGroupAdminSettings.ts', {
    react, '@shared/ui/useAutoSaveDraft': { ...hooks, useAutoSaveNavigation: () => ({}) },
    '@shared/ui/useAutoSaveFeedback': { useAutoSaveFeedback: () => ({}) }, '@features/assistants': {},
  }).default;
  const adminConfig = { ...profile, contextMessageCount: 20, systemPrompt: 'existing' };
  admin({ adminConfig, onUpdate: async patch => { writes.push(patch); } }); editor.change({ systemPrompt: 'unsaved', contextMessageCount: 'invalid' });
  admin({ adminConfig, onUpdate: async patch => { writes.push(patch); } }).fillServiceConnection(service);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.deepEqual(writes, [{ serviceConfigId: service.id }]);
  assert.equal(editor.getSnapshot().draft.systemPrompt, 'unsaved');
  assert.equal(editor.getSnapshot().draft.contextMessageCount, 'invalid');
}
console.log('model service configs verified: shared connections, opt-out, ownership, rollback, summary migration and backup');
