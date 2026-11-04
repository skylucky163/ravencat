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
function database(legacy = false) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  for (const schema of Object.values(SCHEMAS)) db.exec(legacy ? schema.replaceAll('service_config_id TEXT REFERENCES model_service_configs(id),', '') : schema);
  if (legacy) db.exec('ALTER TABLE auxiliary_model_configs ADD COLUMN enabled INTEGER DEFAULT 1;');
  db.exec(`PRAGMA user_version=${legacy ? 156 : DATABASE_SCHEMA_VERSION}`);
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
  const dependencies = { '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => executor } },
    '@shared/prompt': { estimateTextTokens: text => text.length },
    '@features/speech': { validateSpeechConfiguration: () => ({}) },
    '@features/integrations': { validateTranslationModelConfig: () => ({}) },
    '@features/profile': {}, '@features/media': { resolveMediaAssetReferenceUri: async ({ legacyUri }) => legacyUri } };
  const { SQLiteChatSummaryRepository } = load('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts', dependencies);
  const summary = new SQLiteChatSummaryRepository(async () => []);
  dependencies['../application/AuxiliaryModelInitialization'] = { getAuxiliaryModelInitialization: () => ({
    initializeModelSelections: async () => {}, initializeAssistantSelections: async () => {}, modelSelectionsInitialized() {},
    invalidateModelReferencesInTransaction: (tx, id) => summary.invalidateModelReferencesInTransaction(tx, id),
    invalidateServiceReferencesInTransaction: (tx, id) => summary.invalidateServiceReferencesInTransaction(tx, id),
  }) };
  const services = load('src/features/assistants/infrastructure/SQLiteModelServiceRepository.ts', dependencies);
  const connection = load('src/features/assistants/domain/ModelService.ts');
  const assets = load('src/features/assistants/infrastructure/SQLiteAuxiliaryModelRepository.ts', dependencies).auxiliaryModelRepository;
  const assistants = load('src/features/assistants/infrastructure/SQLiteAssistantRepository.ts', { ...dependencies,
    './SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: assets } }).aiAssistantRepository;
  const groups = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts', { ...dependencies,
    '@features/assistants': { bindModelServiceInTransaction: services.bindModelService, readModelServiceConnection: services.readModelService, getModelServiceConnection: connection.getModelServiceConnection } }).groupChatRepository;
  return { services, connection, assets, assistants, groups, executor, summary };
}
const input = { capabilityKind: 'summary', name: '摘要', baseUrl: 'https://models.invalid/v1', apiKey: 'original', model: 'text-model', temperature: 0, topP: null, maxTokens: null };
{
  const db = database(); const app = runtime(db);
  const [summary, vision] = await Promise.all([app.assets.insertModelConfig(input), app.assets.insertModelConfig({ ...input, capabilityKind: 'ocr', name: '视觉', model: 'vision' })]);
  assert.equal(summary.serviceConfigId, vision.serviceConfigId, '相同连接的并发保存只有一份服务');
  assert.equal((await app.services.listModelServices()).length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auxiliary_model_initial_defaults').get().n, 1, '摘要不参与首次默认初始化');
  assert.equal(db.prepare('SELECT api_key FROM auxiliary_model_configs WHERE id=?').get(summary.id).api_key, null, '引用用途不再保存凭据副本');
  const service = await app.services.getModelService(summary.serviceConfigId);
  await assert.rejects(app.services.saveModelService(service.id, { authType: 'tencentCloud' }), /更换认证方式/);
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
  await assert.rejects(app.services.deleteModelService(service.id), /FOREIGN KEY/);
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
  const services = db.prepare('SELECT id, auth_type FROM model_service_configs').all();
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
  db.exec("PRAGMA user_version=157; CREATE TRIGGER reject_detach BEFORE UPDATE OF service_config_id ON auxiliary_model_configs WHEN NEW.service_config_id IS NULL BEGIN SELECT RAISE(ABORT,'模拟解除引用失败'); END");
  await assert.rejects(runMigrations(raw(db)), /解除引用失败/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 157);
  for (const { config } of snapshots) assert.deepEqual(await app.assets.getModelConfigById(config.id), config, '迁移失败不改变任何连接或参数');
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
  db.exec(`PRAGMA user_version=${previousVersion};
    CREATE TABLE delete_probe (count INTEGER NOT NULL); INSERT INTO delete_probe VALUES(0);
    CREATE TRIGGER reject_second_service_delete BEFORE DELETE ON model_service_configs BEGIN
      UPDATE delete_probe SET count=count+1;
      SELECT CASE WHEN (SELECT count FROM delete_probe)=2 THEN RAISE(ABORT,'模拟第二条服务清理失败') END;
    END;`);
  await assert.rejects(runMigrations(raw(db)), /服务清理失败/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, previousVersion);
  assert.equal(db.prepare('SELECT count FROM delete_probe').get().count, 0);
  for (const id of [...removed, ...kept]) assert.ok(await app.services.getModelService(id), '失败保留所有服务');
  for (const config of configurations) assert.deepEqual(await app.assets.getModelConfigById(config.id), config);
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
