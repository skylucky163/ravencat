/** 模型资产、系统明确选择、旧配置迁移与图片处理真实行为验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { DatabaseSync, backup } from 'node:sqlite';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadCommonJS(relativePath, mocks = {}, cache = new Map()) {
  const absolute = path.resolve(ROOT, relativePath);
  if (cache.has(absolute)) return cache.get(absolute);
  const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  cache.set(absolute, module.exports);
  const localRequire = (specifier) => {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    if (specifier.startsWith('.')) return loadCommonJS(path.resolve(path.dirname(absolute), `${specifier}.ts`), mocks, cache);
    if (specifier.startsWith('@shared/')) return loadCommonJS(`src/shared/${specifier.slice(8)}.ts`, mocks, cache);
    throw new Error(`未声明的运行时依赖：${specifier}`);
  };
  new Function('exports', 'require', 'module', output)(module.exports, localRequire, module);
  cache.set(absolute, module.exports);
  return module.exports;
}
const { SCHEMAS } = loadCommonJS('src/platform/persistence/sqlite/schema.ts');
const { runMigrations } = loadCommonJS('src/platform/persistence/sqlite/migrations.ts');
function executor(db) {
  const raw = {
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    runAsync: async (sql, params = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    execAsync: async (sql) => db.exec(sql),
  };
  return raw;
}
async function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  await runMigrations(executor(db));
  return db;
}
function seedAssistants(db) {
  const insert = db.prepare(`INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES (?, ?, ?, 'chat', '2026-10-05', '2026-10-05')`);
  for (const id of ['explicit', 'disabled', 'inherited', 'broken']) insert.run(id, `actor-${id}`, id);
}
function selectionIds(db) {
  return [
    db.prepare('SELECT embedding_model_config_id AS id FROM memory_model_settings').get().id,
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_image_settings'").get()
      ? db.prepare('SELECT recognition_model_config_id AS id FROM chat_image_settings').get().id
      : db.prepare("SELECT recognition_model_config_id AS id FROM chat_assistant_image_settings WHERE assistant_id = 'explicit'").get()?.id ?? null,
    db.prepare('SELECT model_config_id AS id FROM speech_recognition_settings').get().id,
  ];
}
function voices(db) {
  return db.prepare('SELECT assistant_id, model_config_id FROM assistant_voice_settings ORDER BY assistant_id').all()
    .map((row) => [row.assistant_id, row.model_config_id]);
}
function retiredTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE name IN ('capability_bindings', 'assistant_capability_bindings')").all();
}

/** 使用真实 owner SQL 与 Host 装配，验证初始化而不是模拟第二套选择流程。 */
function configureInitialSelections(persistence) {
  const mocks = {
    '@platform/persistence': persistence,
    '@features/speech': loadCommonJS('src/features/speech/application/SpeechProviderCatalog.ts'),
    '@features/integrations': loadCommonJS('src/features/integrations/domain/TranslationModel.ts'),
  };
  const initialization = loadCommonJS('src/features/assistants/application/AuxiliaryModelInitialization.ts');
  mocks['../application/AuxiliaryModelInitialization'] = initialization;
  const owner = (file) => loadCommonJS(file, mocks);
  const { SQLiteChatSummaryRepository } = loadCommonJS('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts', {
    ...mocks, '@shared/prompt': { estimateTextTokens: (text) => text.length },
  });
  const summaryRepository = new SQLiteChatSummaryRepository(async () => []);
  const { SQLiteStickerRepository } = owner('src/features/stickers/infrastructure/SQLiteStickerRepository.ts');
  const notifications = [];
  loadCommonJS('src/host/composition/configureAuxiliaryModelInitialization.ts', {
    '@features/assistants/composition': { ...initialization, ...owner('src/features/assistants/infrastructure/SQLiteAssistantVoiceSettingsRepository.ts') },
    '@features/chat/composition': { ...owner('src/features/chat/reply/infrastructure/SQLiteChatImageSettingsRepository.ts'),
      invalidateChatSummaryModelReferencesInTransaction: (transaction, id) => summaryRepository.invalidateModelReferencesInTransaction(transaction, id) },
    '@features/speech/composition': owner('src/features/speech/infrastructure/SQLiteSpeechSettingsRepository.ts'),
    '@features/integrations/composition': owner('src/features/integrations/infrastructure/SQLiteTranslationSettingsRepository.ts'),
    '@features/moments/composition': owner('src/features/moments/infrastructure/SQLiteMomentRepository.ts'),
    '@features/memory/composition': owner('src/features/memory/infrastructure/SQLiteMemoryEntryRepository.ts'),
    '@features/stickers/composition': { stickerRepository: new SQLiteStickerRepository(),
      emitStickerAnnotationPending: () => notifications.push('ocr'), emitStickerEmbeddingPending: () => notifications.push('embedding') },
  }).configureAuxiliaryModelInitializationRuntime();
  return { mocks, notifications, summaryRepository };
}

function initialModelRuntime(db) {
  const raw = executor(db);
  let writer = Promise.resolve();
  const persistence = { databaseCoordinator: { openTaskExecutor: () => ({ ...raw,
    withExclusiveTransactionAsync(task) {
      const result = writer.then(async () => {
        db.exec('BEGIN');
        try { const value = await task(raw); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      writer = result.then(() => {}, () => {});
      return result;
    },
  }) } };
  const initial = configureInitialSelections(persistence);
  const repositoryModule = loadCommonJS('src/features/assistants/infrastructure/SQLiteAuxiliaryModelRepository.ts', initial.mocks);
  const repository = repositoryModule.auxiliaryModelRepository;
  const commands = loadCommonJS('src/features/assistants/ManageAuxiliaryModelConfigs.ts', { './infrastructure/SQLiteAuxiliaryModelRepository': repositoryModule });
  const assistants = loadCommonJS('src/features/assistants/infrastructure/SQLiteAssistantRepository.ts', {
    ...initial.mocks,
    './SQLiteAuxiliaryModelRepository': repositoryModule,
    '../domain/AIProfile': { createAIProfile: (profile) => profile },
    '@features/profile': {},
    '@features/media': { resolveMediaAssetReferenceUri: async ({ legacyUri }) => legacyUri },
  }).aiAssistantRepository;
  const create = (kind, extra = {}) => commands.createAuxiliaryModelConfig({ capabilityKind: kind, name: kind,
    baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: kind,
    metadataJson: kind === 'translation' ? JSON.stringify({ provider: 'aiModel', source: 'auto', target: 'zh' })
      : kind === 'stt' ? JSON.stringify({ provider: 'tencentRealtimeAsr', appId: '123', secretId: 'test' }) : null, ...extra });
  const createAssistant = (id) => assistants.insert({ id, agentId: `actor-${id}`, name: id, nickname: null, model: 'chat',
    temperature: null, topP: null,
    privateContextPrimaryLimit: 30, privateContextSecondaryLimit: 10, groupContextPrimaryLimit: 40, groupContextSecondaryLimit: 5 });
  return { ...initial, persistence, commands, repository, assistants, create, createAssistant };
}

// 配置资产与摘要资格在同一事务交接；修改、清空凭据、删除保留引用和已提交进度。
{
  const db = await createDatabase();
  const runtime = initialModelRuntime(db);
  await runtime.createAssistant('summary-owner');
  const model = await runtime.create('summary');
  const summary = runtime.summaryRepository;
  const now = '2026-10-13T01:00:00.000Z';
  db.exec(`INSERT INTO chat_conversations VALUES ('model-ref','direct');
    INSERT INTO sessions (id,ai_assistant_id,name,created_at,updated_at) VALUES ('model-ref','summary-owner','A','${now}','${now}');
    INSERT INTO conversation_turn_state (session_id,reply_cursor,revision,updated_at) VALUES ('model-ref',2,0,'${now}');
    INSERT INTO messages (id,session_id,text,is_me,sender_type,time,created_at,updated_at,status,delivery_status)
      VALUES (1,'model-ref','first',1,'user','09:00','${now}','${now}','sent','delivered'),
      (2,'model-ref','second',0,'assistant','09:00','${now}','${now}','sent','delivered');`);
  await summary.updateSettings('model-ref', { modelConfigId: model.id });
  const claim = (id) => summary.claim('model-ref', 1, id, now, '2099-01-01T00:00:00.000Z', 'Asia/Shanghai', 0);
  const append = (task, id) => summary.appendClaim(task, [{ id, content: 'summary', messages: task.messages }], now);
  const first = await claim('first');
  await runtime.commands.updateAuxiliaryModelConfig({ id: model.id, settings: { name: 'new label' } });
  assert.equal(await append(first, 'committed'), true, '仅名称修改不撤销请求');
  const cursor = db.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='model-ref'").get().processed_cursor;
  const second = await claim('second');
  await runtime.commands.updateAuxiliaryModelConfig({ id: model.id, settings: { model: 'next-model' } });
  assert.equal(await append(second, 'stale'), false, '调用配置改变后旧任务不得提交');
  assert.equal((await summary.readSettings('model-ref')).modelConfigId, model.id);
  assert.equal(db.prepare("SELECT processed_cursor FROM chat_summary_state WHERE conversation_id='model-ref'").get().processed_cursor, cursor);
  assert.equal((await summary.readContext('model-ref', [])).segments.length, 1);
  const third = await claim('third');
  db.exec("CREATE TRIGGER deny_summary_invalidation BEFORE UPDATE ON chat_summary_state BEGIN SELECT RAISE(ABORT,'invalidation rejected'); END;");
  await assert.rejects(runtime.commands.updateAuxiliaryModelConfig({ id: model.id, settings: { model: 'rolled-back' } }), /invalidation rejected/);
  assert.equal((await runtime.repository.getModelConfigById(model.id)).model, 'next-model', '资格失效失败时配置编辑回滚');
  db.exec('DROP TRIGGER deny_summary_invalidation');
  await runtime.commands.updateAuxiliaryModelConfig({ id: model.id, settings: { apiKey: null } });
  assert.equal(await append(third, 'disabled'), false);
  await runtime.commands.deleteAuxiliaryModelConfig({ id: model.id });
  assert.equal((await summary.readSettings('model-ref')).modelConfigId, model.id, '删除资产不替换持续引用');
  assert.equal((await summary.readContext('model-ref', [])).segments.length, 1);
  assert.equal(db.prepare("SELECT status FROM chat_summary_tasks WHERE conversation_id='model-ref' AND status<>'completed'").get().status, 'waiting');
  db.close();
}

// 角色先于模型、模型先于角色，两种入口都固化选择；取消与手动改选不被其他资产覆盖。
{
  const db = await createDatabase(); await runMigrations(executor(db));
  const runtime = initialModelRuntime(db);
  await runtime.createAssistant('before');
  assert.deepEqual(voices(db), []);
  const vision = await runtime.create('ocr');
  const voice = await runtime.create('tts');
  await runtime.createAssistant('after');
  const limits={privateContextPrimaryLimit:20,privateContextSecondaryLimit:0,groupContextPrimaryLimit:30,groupContextSecondaryLimit:100};
  await runtime.assistants.applyContextLimits(['before','after'],limits);
  for(const id of ['before','after']) {
    const profile=await runtime.assistants.getById(id);
    for(const [key,value] of Object.entries(limits)) assert.equal(profile[key],value);
    assert.equal(profile.name,id,'快捷应用不复制角色资料');
  }
  await runtime.persistence.databaseCoordinator.openTaskExecutor().withExclusiveTransactionAsync(
    tx => runtime.assistants.updateSettingsInTransaction(tx, 'before', { groupContextSecondaryLimit: 99 }),
  );
  assert.equal((await runtime.assistants.getById('after')).groupContextSecondaryLimit,100,'应用后独立编辑');
  const beforeMissing=db.prepare("SELECT * FROM ai_assistants WHERE id='before'").get();
  await assert.rejects(runtime.assistants.applyContextLimits(['before','missing'],{...limits,privateContextPrimaryLimit:77}),/已删除/);
  assert.deepEqual(db.prepare("SELECT * FROM ai_assistants WHERE id='before'").get(),beforeMissing,'所选AI消失时整批回滚');
  for (const id of ['before', 'after']) {
    assert.equal(db.prepare('SELECT recognition_model_config_id AS id FROM chat_assistant_image_settings WHERE assistant_id = ?').get(id).id, vision.id);
    assert.equal(db.prepare('SELECT model_config_id AS id FROM assistant_voice_settings WHERE assistant_id = ?').get(id).id, voice.id);
  }
  db.prepare("UPDATE chat_assistant_image_settings SET recognition_model_config_id = NULL WHERE assistant_id = 'before'").run();
  db.prepare("UPDATE assistant_voice_settings SET model_config_id = NULL WHERE assistant_id = 'before'").run();
  const secondVision = await runtime.create('ocr');
  const secondVoice = await runtime.create('tts');
  db.prepare("UPDATE assistant_voice_settings SET model_config_id = ? WHERE assistant_id = 'after'").run(secondVoice.id);
  await runtime.commands.updateAuxiliaryModelConfig({ id: vision.id, settings: { name: '编辑首次模型' } });
  await runtime.commands.updateAuxiliaryModelConfig({ id: voice.id, settings: { apiKey: null } });
  await runtime.commands.updateAuxiliaryModelConfig({ id: voice.id, settings: { apiKey: 'test' } });
  assert.equal(db.prepare("SELECT recognition_model_config_id AS id FROM chat_assistant_image_settings WHERE assistant_id = 'before'").get().id, null);
  assert.equal(db.prepare("SELECT model_config_id AS id FROM assistant_voice_settings WHERE assistant_id = 'before'").get().id, null);
  assert.equal(db.prepare("SELECT model_config_id AS id FROM assistant_voice_settings WHERE assistant_id = 'after'").get().id, secondVoice.id);
  await runtime.createAssistant('new-default');
  assert.equal(db.prepare("SELECT recognition_model_config_id AS id FROM chat_assistant_image_settings WHERE assistant_id = 'new-default'").get().id, vision.id);
  assert.equal(db.prepare("SELECT model_config_id AS id FROM assistant_voice_settings WHERE assistant_id = 'new-default'").get().id, voice.id);
  await runtime.commands.updateAuxiliaryModelConfig({ id: vision.id, settings: { apiKey: null } });
  await runtime.commands.deleteAuxiliaryModelConfig({ id: voice.id });
  await runtime.createAssistant('unavailable-default');
  assert.equal(db.prepare("SELECT recognition_model_config_id FROM chat_assistant_image_settings WHERE assistant_id = 'unavailable-default'").get(), undefined);
  assert.equal(db.prepare("SELECT model_config_id FROM assistant_voice_settings WHERE assistant_id = 'unavailable-default'").get(), undefined);
  await runtime.create('tts');
  assert.equal(db.prepare("SELECT model_config_id FROM assistant_voice_settings WHERE assistant_id = 'unavailable-default'").get(), undefined, '删除默认后新增资产不能替代它');
  assert.equal(db.prepare("SELECT recognition_model_config_id AS id FROM chat_assistant_image_settings WHERE assistant_id = 'after'").get().id, vision.id, '清空凭据保留已有失效引用');
  assert.notEqual(secondVision.id, vision.id);
  db.close();
}

// 首次资产未填完整时先保存；修正后只初始化一次，不能被第二个模型抢占。
{
  const db = await createDatabase(); await runMigrations(executor(db));
  const runtime = initialModelRuntime(db);
  await runtime.createAssistant('waiting');
  const vision = await runtime.create('ocr', { apiKey: null });
  await runtime.create('ocr');
  assert.equal(db.prepare('SELECT count(*) AS count FROM chat_assistant_image_settings').get().count, 0);
  await runtime.commands.updateAuxiliaryModelConfig({ id: vision.id, settings: { apiKey: 'complete' } });
  assert.equal(db.prepare("SELECT recognition_model_config_id AS id FROM chat_assistant_image_settings WHERE assistant_id = 'waiting'").get().id, vision.id);
  assert.deepEqual(runtime.notifications, ['ocr']);
  for (const kind of ['embedding', 'translation', 'stt']) {
    const model = await runtime.create(kind, kind === 'translation' ? {
      metadataJson: JSON.stringify({ provider: 'tencentCloudTmt', secretId: 'test-id', region: 'ap-guangzhou', projectId: 0, source: 'auto', target: 'zh' }),
    } : {});
    const table = kind === 'embedding' ? 'memory_model_settings' : kind === 'stt' ? 'speech_recognition_settings' : 'translation_settings';
    const column = kind === 'embedding' ? 'embedding_model_config_id' : 'model_config_id';
    assert.equal(db.prepare(`SELECT ${column} AS id FROM ${table}`).get().id, kind === 'embedding' ? null : model.id);
    db.prepare(`UPDATE ${table} SET ${column} = NULL`).run();
    await runtime.create(kind);
    await runtime.commands.updateAuxiliaryModelConfig({ id: model.id, settings: { name: '更名' } });
    assert.equal(db.prepare(`SELECT ${column} AS id FROM ${table}`).get().id, null, '全局取消不能被创建或编辑复活');
  }
  db.close();
}

// 创建失败回滚资产、默认 marker 与所有 owner；创建角色失败也不能留下半套选择。
{
  const db = await createDatabase(); await runMigrations(executor(db));
  const runtime = initialModelRuntime(db);
  await runtime.createAssistant('existing');
  db.exec("CREATE TRIGGER reject_initial_moment BEFORE INSERT ON moment_settings BEGIN SELECT RAISE(ABORT, '模拟 owner 初始化失败'); END");
  await assert.rejects(runtime.create('ocr'), /owner 初始化失败/);
  assert.equal(db.prepare('SELECT count(*) AS count FROM auxiliary_model_configs').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM auxiliary_model_initial_defaults').get().count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM chat_assistant_image_settings').get().count, 0);
  assert.deepEqual(runtime.notifications, [], '回滚不发布 commit 后信号');
  db.exec('DROP TRIGGER reject_initial_moment');
  const [first, second] = await Promise.all([runtime.create('ocr'), runtime.create('ocr')]);
  assert.equal(db.prepare("SELECT model_config_id AS id FROM auxiliary_model_initial_defaults WHERE capability_kind = 'ocr'").get().id, first.id);
  assert.equal(db.prepare("SELECT recognition_model_config_id AS id FROM chat_assistant_image_settings WHERE assistant_id = 'existing'").get().id, first.id);
  assert.notEqual(first.id, second.id);
  const voice = await runtime.create('tts');
  db.exec("CREATE TRIGGER reject_initial_voice BEFORE INSERT ON assistant_voice_settings WHEN NEW.assistant_id = 'failed' BEGIN SELECT RAISE(ABORT, '模拟角色初始化失败'); END");
  await assert.rejects(runtime.createAssistant('failed'), /角色初始化失败/);
  assert.equal(db.prepare("SELECT id FROM ai_assistants WHERE id = 'failed'").get(), undefined);
  assert.equal(db.prepare("SELECT assistant_id FROM chat_assistant_image_settings WHERE assistant_id = 'failed'").get(), undefined);
  assert.equal(db.prepare("SELECT model_config_id AS id FROM assistant_voice_settings WHERE assistant_id = 'existing'").get().id, voice.id);
  db.close();
}

// 当前选择保留、失效引用不复活、显式停用不继承；重启和备份恢复原样保留。
{
  const db = await createDatabase();
  seedAssistants(db);
  await runMigrations(executor(db));
  db.exec(`UPDATE memory_model_settings SET embedding_model_config_id='embedding';
    UPDATE speech_recognition_settings SET model_config_id='stt';
    INSERT INTO chat_assistant_image_settings VALUES ('explicit','vision'),('inherited','vision');
    INSERT INTO assistant_voice_settings VALUES ('broken','deleted'),('disabled',NULL),('explicit','voice-own'),('inherited','voice-default');`);
  await runMigrations(executor(db));
  assert.deepEqual(selectionIds(db), ['embedding', 'vision', 'stt']);
  assert.deepEqual(voices(db), [['broken', 'deleted'], ['disabled', null], ['explicit', 'voice-own'], ['inherited', 'voice-default']]);
  assert.deepEqual(retiredTables(db), []);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'external_service_configs'").get(), undefined);
  // 完整启动会继续执行后续迁移；这里只要求模型选择迁移已完成，不锁死全库终态版本。
  const completedVersion = db.prepare('PRAGMA user_version').get().user_version;
  assert.ok(completedVersion >= 96, '当前建库入口保留有效版本标记');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_image_settings'").get(), undefined);
  assert.deepEqual(
    db.prepare('SELECT assistant_id, recognition_model_config_id FROM chat_assistant_image_settings ORDER BY assistant_id').all().map((row) => [row.assistant_id, row.recognition_model_config_id]),
    [['explicit', 'vision'], ['inherited', 'vision']],
    '只迁移原来实际开启预处理的角色，不改变直接传图角色的行为',
  );
  db.exec("UPDATE memory_model_settings SET embedding_model_config_id = 'user-choice'; UPDATE assistant_voice_settings SET model_config_id = NULL WHERE assistant_id = 'inherited'; UPDATE translation_settings SET model_config_id = 'user-translation-choice'");
  for (const sql of Object.values(SCHEMAS)) db.exec(sql);
  await runMigrations(executor(db));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, completedVersion, '重复启动不能倒退或改写版本标记');
  assert.deepEqual(selectionIds(db), ['user-choice', 'vision', 'stt']);
  assert.equal(db.prepare('SELECT model_config_id FROM translation_settings').get().model_config_id, 'user-translation-choice');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'external_service_configs'").get(), undefined, '新版启动不重建旧翻译配置表');
  assert.equal(voices(db).find(([id]) => id === 'inherited')[1], null);
  assert.deepEqual(retiredTables(db), []);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // 数据库快照保留版本标记及业务选择，不重新读取旧默认。
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-selection-backup-'));
  const snapshot = path.join(directory, 'snapshot.db');
  try {
    await backup(db, snapshot);
    const restored = new DatabaseSync(snapshot);
    try {
      for (const sql of Object.values(SCHEMAS)) restored.exec(sql);
      await runMigrations(executor(restored));
      assert.equal(restored.prepare('PRAGMA user_version').get().user_version, completedVersion, '快照恢复保留完成的迁移版本');
      assert.deepEqual(selectionIds(restored), ['user-choice', 'vision', 'stt']);
      assert.equal(voices(restored).find(([id]) => id === 'inherited')[1], null);
      assert.deepEqual(retiredTables(restored), []);
    } finally { restored.close(); }
  } finally { if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot); fs.rmdirSync(directory); }
  db.close();
}
// 新安装没有任何自动选择。
{
  const db = await createDatabase();
  await runMigrations(executor(db));
  assert.deepEqual(selectionIds(db), [null, null, null]);
  assert.deepEqual(retiredTables(db), []);
  db.close();
}
// 真实仓储、公开命令与 Host：首次资产生效，后续选择仍归各业务 owner。
{
  const db = await createDatabase(); await runMigrations(executor(db)); seedAssistants(db);
  const raw = executor(db);
  const persistence = { databaseCoordinator: { openTaskExecutor: () => ({
    ...raw,
    withExclusiveTransactionAsync: async (task) => {
      db.exec('BEGIN');
      try { const result = await task(raw); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  }) } };
  const initial = configureInitialSelections(persistence);
  const { auxiliaryModelRepository: repository } = loadCommonJS('src/features/assistants/infrastructure/SQLiteAuxiliaryModelRepository.ts', initial.mocks);
  const events = loadCommonJS('src/features/assistants/AuxiliaryModelsChanged.ts');
  const assets = loadCommonJS('src/features/assistants/ResolveAuxiliaryModel.ts', { './infrastructure/SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: repository }, '@features/speech': loadCommonJS('src/features/speech/application/SpeechProviderCatalog.ts'), '@features/integrations': loadCommonJS('src/features/integrations/domain/TranslationModel.ts') });
  const commands = loadCommonJS('src/features/assistants/ManageAuxiliaryModelConfigs.ts', {
    './infrastructure/SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: repository }, './AuxiliaryModelsChanged': events,
  });
  const create = (kind, name) => commands.createAuxiliaryModelConfig({ capabilityKind: kind, name, baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: name, metadataJson: kind === 'stt' ? JSON.stringify({ provider: 'tencentRealtimeAsr', appId: '123', secretId: 'test' }) : null });
  const embedding = await create('embedding', 'embedding');
  const vision = await create('ocr', 'vision');
  const stt = await create('stt', 'stt');
  const voice = await create('tts', 'voice');
  assert.deepEqual(selectionIds(db), [null, vision.id, stt.id], '创建向量模型不自动开启记忆向量化');
  assert.deepEqual(voices(db), ['broken', 'disabled', 'explicit', 'inherited'].map((id) => [id, voice.id]));
  assert.equal(db.prepare("SELECT image_analysis_model_config_id AS id FROM moment_settings WHERE id = 'global'").get().id, vision.id);
  const stickerModels = db.prepare("SELECT recognition_model_config_id, embedding_model_config_id FROM sticker_system_config WHERE id = 'global'").get();
  assert.equal(stickerModels.recognition_model_config_id, vision.id);
  assert.equal(stickerModels.embedding_model_config_id, embedding.id);
  assert.deepEqual(initial.notifications, ['embedding', 'ocr']);
  const { chatImageSettingsRepository } = loadCommonJS('src/features/chat/reply/infrastructure/SQLiteChatImageSettingsRepository.ts', { '@platform/persistence': persistence });
  const { speechSettingsRepository } = loadCommonJS('src/features/speech/infrastructure/SQLiteSpeechSettingsRepository.ts', { '@platform/persistence': persistence });
  const { assistantVoiceSettingsRepository } = loadCommonJS('src/features/assistants/infrastructure/SQLiteAssistantVoiceSettingsRepository.ts', { '@platform/persistence': persistence });
  const chat = loadCommonJS('src/features/chat/reply/application/ChatImageModels.ts');
  const speech = loadCommonJS('src/features/speech/application/SpeechRecognitionModels.ts');
  const assistantVoice = loadCommonJS('src/features/assistants/application/AssistantVoiceModels.ts');
  const deps = (kind, port) => ({ repository: port,
    getSelection: (modelConfigId) => assets.getAuxiliaryModelSelection({ capabilityKind: kind, modelConfigId }),
    resolveModel: (modelConfigId) => assets.resolveAuxiliaryModel({ capabilityKind: kind, modelConfigId }),
    requireModel: async (modelConfigId) => { if (!await assets.resolveAuxiliaryModel({ capabilityKind: kind, modelConfigId })) throw new Error('不可用的模型'); },
  });
  chat.configureChatImageModels(deps('ocr', chatImageSettingsRepository));
  speech.configureSpeechRecognitionModels(deps('stt', speechSettingsRepository));
  assistantVoice.configureAssistantVoiceModels(deps('tts', assistantVoiceSettingsRepository));
  const speechResolver = loadCommonJS('src/features/speech/application/ResolveSpeechModel.ts');
  const translation = loadCommonJS('src/features/integrations/application/TranslationModels.ts');
  const { translationSettingsRepository } = loadCommonJS('src/features/integrations/infrastructure/SQLiteTranslationSettingsRepository.ts', { '@platform/persistence': persistence });
  const host = loadCommonJS('src/host/composition/configureAIRuntime.ts', {
    '@shared/aiTools': {},
    '../runtime/HostModelRunPreparation': {},
    './agent': {},
    '@platform/device': {},
    '@features/assistants': { ...assets, ...events, aiAssistantRepository: {}, configureAssistantRuntime() {} },
    '@features/speech/composition': { ...speechResolver, ...speech, speechSettingsRepository },
    '@features/assistants/composition': { ...assistantVoice, assistantVoiceSettingsRepository },
    '@features/integrations/composition': { ...translation, translationSettingsRepository },
    '@features/moments': {}, '@features/protocol': {}, '@features/profile': {}, '@features/wallet': {},
    '@features/chat': {}, '@features/chat/composition': {}, '@features/calls': {},
    '@features/calls/composition': { configureCallRuntimeDependencies() {}, configureCallBackgroundRuntime() {},
      configureCallRingtoneRuntime() {}, createCallExecutionAdapter: () => ({}) },
    '@features/companion': {}, '@host/prompt': {},
  });
  host.configureAIRuntime();
  assert.equal((await translation.getTranslationModelSettings()).status, 'unconfigured');
  const translationModel = await commands.createAuxiliaryModelConfig({ capabilityKind: 'translation', name: '翻译模型',
    baseUrl: 'https://example.invalid/v1', apiKey: 'translation-key', model: 'translation-model',
    metadataJson: JSON.stringify({ provider: 'aiModel', source: 'auto', target: 'zh' }),
  });
  assert.equal((await translation.getTranslationModelSettings()).selectedModelId, translationModel.id);
  await assert.rejects(() => translation.selectTranslationModel(vision.id), /匹配/);
  await translation.selectTranslationModel(translationModel.id);
  assert.equal((await translation.resolveTranslationModel()).modelConfigId, translationModel.id);
  let translationRefreshes = 0;
  const unsubscribeTranslation = translation.subscribeTranslationModelsChanged(() => { translationRefreshes++; });
  await commands.updateAuxiliaryModelConfig({ id: translationModel.id, settings: { apiKey: null } });
  assert.ok(translationRefreshes > 0, 'Host 转发资产提交后的刷新信号');
  assert.equal((await translation.getTranslationModelSettings()).status, 'unavailable');
  await assert.rejects(() => translation.resolveTranslationModel(), /不可用/);
  unsubscribeTranslation();
  await chat.selectChatImageModel('explicit', vision.id);
  await chat.selectChatImageModel('inherited', null);
  assert.equal((await chat.getChatImageModelSettings('inherited')).status, 'unconfigured');
  assert.deepEqual(await chat.resolveChatRecognitionModel('inherited'), { status: 'unconfigured' }, '角色不继承其他 AI 的视觉模型');
  const otherVision = await create('ocr', 'other-vision');
  await chat.selectChatImageModel('inherited', otherVision.id);
  assert.equal((await chat.resolveChatRecognitionModel('explicit')).model.modelConfigId, vision.id);
  assert.equal((await chat.resolveChatRecognitionModel('inherited')).model.modelConfigId, otherVision.id);
  const imageRuntime = loadImageRuntime({
    media: { readVisionImage: async () => ({ base64: 'AQID', mimeType: 'image/jpeg' }) },
    vision: { resolveOCRModel: chat.resolveChatRecognitionModel },
    prompt: { assembleStandalone: async () => ({ systemPrompt: 'vision-system' }), resolveVisionOCRPrompt: async () => '图片任务说明' },
  });
  for (const [assistantId, input, expectedModel] of [
    ['explicit', { mediaAssetId: 'chat-image' }, vision.model],
    ['inherited', { imageUri: 'file:///call-snapshot.jpg' }, otherVision.model],
  ]) {
    const result = await imageRuntime.module.resolveChatImageModelInput({ assistantId, ...input, contextText: '本轮图片' });
    assert.equal(result.route, 'ocr');
    assert.equal(imageRuntime.createdClients.at(-1).config.model, expectedModel, '图片输入必须使用目标角色实际选择的模型');
    assert.ok(result.parts.every((part) => part.type === 'text'));
  }
  await speech.selectSpeechRecognitionModel(stt.id);
  await assistantVoice.selectAssistantVoiceModel('explicit', voice.id);
  await assistantVoice.selectAssistantVoiceModel('inherited', null);
  assert.equal((await chat.resolveChatRecognitionModel('explicit')).model.modelConfigId, vision.id);
  assert.equal(await speech.getSpeechRecognitionModelId(), stt.id);
  assert.equal(await assistantVoice.getAssistantVoiceModelId('explicit'), voice.id);
  assert.equal(await assistantVoice.getAssistantVoiceModelId('inherited'), null);
  for (const consumer of ['call', 'chatVoiceMessage']) {
    assert.equal((await speechResolver.resolveSpeechToTextModel({ assistantId: 'explicit', consumer })).modelConfigId, stt.id);
    assert.equal((await speechResolver.resolveSpeechToTextModel({ assistantId: 'inherited', consumer })).modelConfigId, stt.id);
    assert.equal((await speechResolver.resolveTextToSpeechModel({ assistantId: 'explicit', consumer })).modelConfigId, voice.id);
    assert.equal(await speechResolver.resolveTextToSpeechModel({ assistantId: 'inherited', consumer }), null);
  }
  await speech.selectSpeechRecognitionModel(null);
  assert.equal(await speechResolver.resolveSpeechToTextModel({ consumer: 'call' }), null, '空选择不解析任何模型');
  await speech.selectSpeechRecognitionModel(stt.id);
  await commands.updateAuxiliaryModelConfig({ id: stt.id, settings: { metadataJson: '{}' } });
  assert.equal((await speech.getSpeechRecognitionModelSettings()).status, 'unavailable');
  await assert.rejects(speechResolver.resolveSpeechToTextModel({ consumer: 'call' }), /STT 模型配置不可用/);
  await commands.updateAuxiliaryModelConfig({ id: stt.id, settings: { metadataJson: stt.metadataJson } });
  await create('tts', 'another-voice');
  assert.equal(await assistantVoice.getAssistantVoiceModelId('inherited'), null);
  assert.equal(await assistantVoice.getAssistantVoiceModelId('explicit'), voice.id);
  await assert.rejects(chat.selectChatImageModel('explicit', embedding.id), /不可用/);
  assert.equal((await chat.getChatImageModelSettings('explicit')).status, 'active');
  await commands.updateAuxiliaryModelConfig({ id: vision.id, settings: { apiKey: null } });
  assert.equal((await chat.getChatImageModelSettings('explicit')).unavailableReason, '连接配置不完整');
  assert.deepEqual(await chat.resolveChatRecognitionModel('explicit'), { status: 'unavailable' });
  assert.equal(await chatImageSettingsRepository.getRecognitionModelId('explicit'), vision.id);
  await commands.deleteAuxiliaryModelConfig({ id: vision.id });
  assert.equal((await chat.getChatImageModelSettings('explicit')).unavailableReason, '模型已删除');
  assert.deepEqual(await chat.resolveChatRecognitionModel('explicit'), { status: 'unavailable' });
  assert.equal(await chatImageSettingsRepository.getRecognitionModelId('explicit'), vision.id);
  await chat.selectChatImageModel('explicit', null);
  assert.equal((await chat.getChatImageModelSettings('explicit')).status, 'unconfigured');
  assert.deepEqual(await chat.resolveChatRecognitionModel('explicit'), { status: 'unconfigured' });
  const clientsBeforeClear = imageRuntime.createdClients.length;
  for (const input of [{ mediaAssetId: 'chat-image' }, { imageUri: 'file:///call-snapshot.jpg' }]) {
    const result = await imageRuntime.module.resolveChatImageModelInput({ assistantId: 'explicit', ...input, contextText: '取消选择后的图片' });
    assert.equal(result.route, 'direct_vision', '取消选择后聊天图片和通话帧下一次输入都直接传图');
    assert.ok(result.parts.some((part) => part.type === 'image_url'));
  }
  assert.equal(imageRuntime.createdClients.length, clientsBeforeClear, '取消选择后不再发起视觉识别请求');
  assert.equal((await chat.resolveChatRecognitionModel('inherited')).model.modelConfigId, otherVision.id, '取消当前 AI 的选择不影响其他角色');
  db.prepare("DELETE FROM ai_assistants WHERE id = 'inherited'").run();
  assert.equal(await chatImageSettingsRepository.getRecognitionModelId('inherited'), null, '删除角色时其视觉选择随身份级联删除');
  await assistantVoice.selectAssistantVoiceModel('explicit', null);
  assert.equal(await assistantVoice.getAssistantVoiceModelId('explicit'), null);
  assert.equal(await speechResolver.resolveTextToSpeechModel({ assistantId: 'explicit', consumer: 'call' }), null);
  assert.equal(await speech.getSpeechRecognitionModelId(), stt.id);
  assert.deepEqual(retiredTables(db), []);
  db.close();
}

function loadImageRuntime(dependencies, aiClientOverrides = {}) {
  const createdClients = [];
  const module = loadCommonJS(
    'src/features/chat/reply/application/ResolveChatImageModelInput.ts',
    {
      '@shared/runtime/abortSignal': loadCommonJS('src/shared/runtime/abortSignal.ts', {}),
      '@platform/ai': {
        createAIClient: (config) => {
          const client = {
            chat: async () => ({ success: true, text: '图中有一只黑猫坐在窗台上。' }),
            ...aiClientOverrides,
          };
          createdClients.push({ config, client });
          return client;
        },
      },
      '@shared/prompt': {},
      './ChatReplyRuntimeDependencies': { getChatReplyRuntimeDependencies: () => dependencies },
      './ReplyTaskPromptBlocks': { buildVisionOCRPromptBlocks: () => [] },
    },
  );
  return { module, createdClients };
}

const baseDeps = (vision) => ({
  assistantDirectory: { getBlockState: async () => ({ isBlocked: false }) },
  media: { readVisionImage: async () => ({ base64: 'AQID', mimeType: 'image/jpeg' }) },
  vision,
  agent: {},
  runPreparation: { prepare: async () => { throw new Error('不应执行'); } },
  tools: {},
  prompt: { assembleStandalone: async () => ({ systemPrompt: 'vision-system' }), resolveVisionOCRPrompt: async () => '图片任务说明' },
});

{
  // 未选择视觉模型时直接传图，不创建识别 client。
  const { module, createdClients } = loadImageRuntime(baseDeps({
    resolveOCRModel: async () => ({ status: 'unconfigured' }),
  }));
  const result = await module.resolveChatImageModelInput({
    assistantId: 'ai-1',
    mediaAssetId: 'media-1',
    mimeType: 'image/png',
    contextText: 'context',
  });
  assert.equal(result.route, 'direct_vision', 'direct 策略必须原图直传');
  assert.ok(result.parts.some((part) => part.type === 'image_url'), 'direct 路径必须携带原图');
  assert.deepEqual(createdClients, [], 'direct 路径不得创建 OCR client');
}

for (const temperature of [null, 0]) {
  // 选择视觉模型后只将 OCR 转述交给主模型，采样留空与显式 0 均保持配置语义。
  const { module, createdClients } = loadImageRuntime(baseDeps({
    resolveOCRModel: async () => ({ status: 'active', model: { modelConfigId: 'ocr-a', baseURL: 'https://x', apiKey: 'k', model: 'm', temperature, topP: null, maxTokens: null, metadataJson: null, modelConfigName: 'ocr' } }),
  }));
  const result = await module.resolveChatImageModelInput({
    assistantId: 'ai-1',
    imageUri: 'file:///legacy.png',
    mimeType: 'image/png',
    contextText: 'context',
  });
  assert.equal(result.route, 'ocr');
  assert.equal(result.ocrSucceeded, true);
  assert.deepEqual(
    result.parts.filter((part) => part.type === 'image_url'),
    [],
    'preprocess 路径不得把原图同时给主模型',
  );
  assert.ok(
    result.parts.some((part) => part.type === 'text' && part.text.includes('图中有一只黑猫')),
    'preprocess 路径必须把 OCR 转述交给主模型',
  );
  assert.equal(createdClients.length, 1, 'preprocess 路径必须调用视觉模型');
  assert.equal(createdClients[0].config.temperature, temperature);
  assert.equal(createdClients[0].config.topP, null);
}

{
  // 未选择模型时，canonical 聊天图片直接交给主模型。
  const { module, createdClients } = loadImageRuntime(baseDeps({
    resolveOCRModel: async () => ({ status: 'unconfigured' }),
  }));
  const result = await module.resolveChatImageModelInput({
    assistantId: 'ai-1',
    mediaAssetId: 'media-1',
    mimeType: 'image/png',
    contextText: 'context',
  });
  assert.equal(result.route, 'direct_vision', '未选择视觉模型必须直接传图');
  assert.equal(result.ocrSucceeded, null);
  assert.deepEqual(result.parts.find((part) => part.type === 'image_url'), {
    type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' },
  }, '视觉输入类型以媒体读取契约返回的实际编码为准');
  assert.deepEqual(createdClients, []);
}

{
  // 已选择但失效与未选择不同，不能擅自改变用户明确的预处理路线。
  const { module, createdClients } = loadImageRuntime(baseDeps({
    resolveOCRModel: async () => ({ status: 'unavailable' }),
  }));
  const result = await module.resolveChatImageModelInput({
    assistantId: 'ai-1', imageUri: 'file:///call-snapshot.jpg', contextText: '通话当前画面',
  });
  assert.equal(result.route, 'vision_unavailable');
  assert.deepEqual(
    result.parts.filter((part) => part.type === 'image_url'),
    [],
    '不可用路径不得把原图直传给主模型',
  );
  assert.ok(
    result.parts.some((part) => part.type === 'text' && part.text.includes('已选择的视觉识别模型不可用')),
    '不可用路径必须让聊天模型知道本轮没有获得图片内容',
  );
  assert.deepEqual(createdClients, []);
}

// 网络失败、空转述与异常都不能把预处理失败改成向主模型传图。
for (const chat of [
  async () => ({ success: false, text: '', error: '识别服务不可用' }),
  async () => ({ success: true, text: '   ' }),
  async () => { throw new Error('识别请求中断'); },
]) {
  const { module } = loadImageRuntime(baseDeps({
    resolveOCRModel: async () => ({ status: 'active', model: { modelConfigId: 'ocr-a', baseURL: 'https://x', apiKey: 'k', model: 'm', temperature: 0, topP: null, maxTokens: null, metadataJson: null, modelConfigName: 'ocr' } }),
  }), { chat });
  const result = await module.resolveChatImageModelInput({
    assistantId: 'ai-1', imageUri: 'file:///call-snapshot.jpg', contextText: '通话当前画面',
  });
  assert.equal(result.route, 'ocr');
  assert.equal(result.ocrSucceeded, false);
  assert.ok(result.parts.every((part) => part.type === 'text'));
  assert.ok(result.parts.some((part) => part.text.includes('OCR 失败，未向主模型提供原图')));
}

// 模型资产与两个向量消费者的发布资格共享一次提交，不依赖事件是否已送达。
{
  const db = await createDatabase();
  const runtime = initialModelRuntime(db);
  const model = await runtime.create('embedding');
  db.prepare('UPDATE memory_model_settings SET embedding_model_config_id = ? WHERE id = 1').run(model.id);
  db.exec("UPDATE memory_embedding_index_control SET revision = 4, build_id = 'memory-old'; UPDATE sticker_embedding_index_control SET revision = 6, build_id = 'sticker-old';");
  await runtime.commands.updateAuxiliaryModelConfig({ id: model.id, settings: { model: 'new-embedding' } });
  assert.deepEqual({ ...db.prepare('SELECT revision, build_id FROM memory_embedding_index_control').get() }, { revision: 5, build_id: null });
  assert.deepEqual({ ...db.prepare('SELECT revision, build_id FROM sticker_embedding_index_control').get() }, { revision: 7, build_id: null });
  db.exec("CREATE TRIGGER reject_vector_fence BEFORE UPDATE ON sticker_embedding_index_control BEGIN SELECT RAISE(ABORT, 'vector fence rejected'); END;");
  await assert.rejects(runtime.commands.updateAuxiliaryModelConfig({ id: model.id, settings: { model: 'rejected-embedding' } }), /vector fence rejected/);
  assert.equal(db.prepare('SELECT model FROM auxiliary_model_configs WHERE id = ?').get(model.id).model, 'new-embedding');
  assert.equal(db.prepare('SELECT revision FROM memory_embedding_index_control').get().revision, 5, '后一个消费者撤销失败时，前一个消费者和模型资产一起回滚');
  db.close();
}
console.log('辅助模型：首次配置、新角色初始化、手动选择保留、并发、回滚与升级恢复验证通过');
