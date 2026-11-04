/** 翻译资产共用管理、业务明确选择、保留旧配置的事务迁移与真实请求回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync, backup } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, dependencies = {}, cache = new Map()) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  cache.set(absolute, module.exports);
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    const target = name.startsWith('.') ? path.resolve(path.dirname(absolute), name)
      : name.startsWith('@shared/') ? path.join(root, 'src/shared', name.slice(8)) : null;
    if (target) {
      const source = ['.ts', '.tsx', '/index.ts'].map((suffix) => target + suffix).find((candidate) => fs.existsSync(candidate));
      if (source) return load(source, dependencies, cache);
    }
    throw new Error(`${file} 缺少依赖 ${name}`);
  }, module, module.exports);
  cache.set(absolute, module.exports);
  return module.exports;
}
const contract = load('src/features/integrations/domain/TranslationModel.ts');
const providers = load('src/features/integrations/application/TranslationProviderCatalog.ts');
const { SCHEMAS } = load('src/platform/persistence/sqlite/schema.ts');
const { migrateTranslationModels } = load('src/platform/persistence/sqlite/translationModelSchema.ts');
const { migrateAuxiliaryModelDefaults } = load('src/platform/persistence/sqlite/auxiliaryModelDefaultsSchema.ts');
function createDb() {
  const db = new DatabaseSync(':memory:');
  for (const schema of Object.values(SCHEMAS)) db.exec(schema);
  // 106 的迁移仍按当时包含 enabled 的表结构写入。
  db.exec('ALTER TABLE auxiliary_model_configs ADD COLUMN enabled INTEGER DEFAULT 1;');
  return db;
}
function executor(db) {
  return {
    getFirstAsync: async (sql, values = []) => db.prepare(sql).get(...values) ?? null,
    getAllAsync: async (sql, values = []) => db.prepare(sql).all(...values),
    runAsync: async (sql, values = []) => db.prepare(sql).run(...values),
    execAsync: async (sql) => db.exec(sql),
  };
}
function seedLegacy(db) {
  db.exec(`PRAGMA user_version = 104;
    CREATE TABLE external_service_configs (
      id TEXT PRIMARY KEY, kind TEXT, provider TEXT, name TEXT, credentials_json TEXT, options_json TEXT,
      enabled INTEGER, created_at TEXT, updated_at TEXT
    );`);
  const insert = db.prepare('INSERT INTO external_service_configs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('tencent', 'translate', 'tencentCloudTmt', '原腾讯云', JSON.stringify({ secretId: 'existing-id', secretKey: 'existing-key' }),
    JSON.stringify({ region: 'ap-shanghai', source: 'auto', target: 'en', projectId: '7', endpoint: 'tmt.tencentcloudapi.com' }), 1, '2026-01-01', '2026-10-06');
  insert.run('ai', 'translate', 'aiModel', '原 AI 翻译', JSON.stringify({ apiKey: 'ai-key' }),
    JSON.stringify({ baseURL: 'https://models.example/v1', model: 'any-text-model', source: 'auto', target: 'zh' }), 1, '2026-10-01', '2026-10-07');
  insert.run('disabled', 'translate', 'aiModel', '停用翻译', JSON.stringify({ apiKey: 'disabled-key' }),
    JSON.stringify({ baseURL: 'https://models.example/v1', model: 'disabled-model', target: 'ja' }), 0, '2026-10-01', '2026-10-08');
  insert.run('old-search', 'search', 'old', '历史数据', '{}', '{}', 0, '', '');
  db.exec("INSERT INTO auxiliary_model_configs (id, capability_kind, name, base_url, model, created_at, updated_at) VALUES ('retired', 'translate', '退休占位', '', '', '', '')");
}
const db = createDb(); seedLegacy(db);
await migrateTranslationModels(executor(db));
assert.equal(db.prepare('PRAGMA user_version').get().user_version, 106);
assert.equal(db.prepare('SELECT model_config_id FROM translation_settings').get().model_config_id, 'translation_ai');
assert.equal(db.prepare("SELECT count(*) AS count FROM external_service_configs WHERE kind = 'translate'").get().count, 0);
assert.equal(db.prepare('SELECT count(*) AS count FROM external_service_configs').get().count, 1, '迁移不删除其他历史服务数据');
const migrated = db.prepare("SELECT * FROM auxiliary_model_configs WHERE capability_kind = 'translation' ORDER BY id").all();
assert.equal(migrated.length, 3);
const tencentRow = migrated.find((row) => row.id === 'translation_tencent');
assert.equal(tencentRow.api_key, 'existing-key');
assert.equal(tencentRow.created_at, '2026-01-01');
assert.deepEqual(JSON.parse(tencentRow.metadata_json), { provider: 'tencentCloudTmt', source: 'auto', target: 'en', secretId: 'existing-id', region: 'ap-shanghai', projectId: 7 });
assert.equal(migrated.find((row) => row.id === 'translation_disabled').enabled, 0);
await migrateTranslationModels(executor(db));
assert.equal(db.prepare("SELECT count(*) AS count FROM auxiliary_model_configs WHERE capability_kind = 'translation'").get().count, 3);
{
  const failedDb = createDb(); seedLegacy(failedDb);
  const raw = executor(failedDb);
  let inserts = 0;
  await assert.rejects(() => migrateTranslationModels({ ...raw, runAsync: async (sql, values) => {
    if (sql.includes('INSERT INTO auxiliary_model_configs') && ++inserts === 2) throw new Error('模拟第二条写入失败');
    return raw.runAsync(sql, values);
  } }), /第二条写入失败/);
  assert.equal(failedDb.prepare('PRAGMA user_version').get().user_version, 104);
  assert.equal(failedDb.prepare("SELECT count(*) AS count FROM auxiliary_model_configs WHERE capability_kind = 'translation'").get().count, 0);
  assert.equal(failedDb.prepare("SELECT count(*) AS count FROM external_service_configs WHERE kind = 'translate'").get().count, 3);
  await migrateTranslationModels(raw);
  assert.equal(failedDb.prepare('SELECT model_config_id FROM translation_settings').get().model_config_id, 'translation_ai');
  failedDb.close();
}
{
  const fresh = createDb(); await migrateTranslationModels(executor(fresh));
  assert.equal(fresh.prepare('SELECT model_config_id FROM translation_settings').get().model_config_id, null);
  fresh.close();
}
await migrateAuxiliaryModelDefaults(executor(db));
const raw = executor(db);
const persistence = { databaseCoordinator: { openTaskExecutor: () => ({ ...raw, withExclusiveTransactionAsync: async (task) => {
  db.exec('BEGIN');
  try { const result = await task(raw); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
} }) } };
// 仓储写入会经运行时槽撤销引用方在途资格；引用方 owner（chat 摘要、moments 等）不属于翻译专项，
// 由独立专项验证，这里按空实现装配，避免槽未装配抛错掩盖翻译链路断言。
const auxiliaryModelInitialization = { getAuxiliaryModelInitialization: () => ({
  initializeModelSelections: async () => { throw new Error('翻译资产不应重放首次选择初始化'); },
  initializeAssistantSelections: async () => {},
  invalidateModelReferencesInTransaction: async () => {},
  modelSelectionsInitialized() {},
}) };
const { auxiliaryModelRepository: repository } = load('src/features/assistants/infrastructure/SQLiteAuxiliaryModelRepository.ts', {
  '@platform/persistence': persistence, '@features/speech': {}, '@features/integrations': contract,
  '../application/AuxiliaryModelInitialization': auxiliaryModelInitialization,
});
const events = load('src/features/assistants/AuxiliaryModelsChanged.ts');
const assets = load('src/features/assistants/ResolveAuxiliaryModel.ts', {
  './infrastructure/SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: repository }, '@features/speech': {}, '@features/integrations': contract,
});
const commands = load('src/features/assistants/ManageAuxiliaryModelConfigs.ts', {
  './infrastructure/SQLiteAuxiliaryModelRepository': { auxiliaryModelRepository: repository }, './AuxiliaryModelsChanged': events,
});
const { translationSettingsRepository } = load('src/features/integrations/infrastructure/SQLiteTranslationSettingsRepository.ts', { '@platform/persistence': persistence });
const selection = load('src/features/integrations/application/TranslationModels.ts');
selection.configureTranslationModels({ repository: translationSettingsRepository,
  getSelection: (modelConfigId) => assets.getAuxiliaryModelSelection({ capabilityKind: 'translation', modelConfigId }),
  requireModel: (id) => assets.requireAuxiliaryModel(id, 'translation'),
  resolveModel: (modelConfigId) => assets.resolveAuxiliaryModel({ capabilityKind: 'translation', modelConfigId }),
});
events.subscribeAuxiliaryModelsChanged(selection.notifyTranslationModelsChanged);
assert.equal((await repository.listModelConfigs()).some((model) => model.id === 'retired'), false);
assert.equal((await selection.getTranslationModelSettings()).status, 'active');
let signals = 0;
const unsubscribe = selection.subscribeTranslationModelsChanged(() => { signals++; });
const aiMetadata = JSON.stringify({ provider: 'aiModel', source: 'auto', target: 'zh' });
const another = await commands.createAuxiliaryModelConfig({ capabilityKind: 'translation', name: '第二个翻译', baseUrl: 'https://models.example/v1', apiKey: 'second-key', model: 'second-model', metadataJson: aiMetadata });
assert.equal(await translationSettingsRepository.getModelId(), 'translation_ai', '创建资产不自动改选');
await commands.updateAuxiliaryModelConfig({ id: another.id, settings: { name: '重命名' } });
assert.equal(await translationSettingsRepository.getModelId(), 'translation_ai');
await selection.selectTranslationModel(another.id);
assert.equal((await selection.resolveTranslationModel()).model, 'second-model');
await commands.updateAuxiliaryModelConfig({ id: another.id, settings: { apiKey: null } });
assert.equal((await selection.getTranslationModelSettings()).unavailableReason, '请填写 API Key');
await assert.rejects(() => selection.resolveTranslationModel(), /不可用/);
await commands.deleteAuxiliaryModelConfig({ id: another.id });
assert.equal((await selection.getTranslationModelSettings()).unavailableReason, '模型已删除');
assert.equal(await translationSettingsRepository.getModelId(), another.id, '删除保留失效引用');
await selection.selectTranslationModel(null);
assert.equal((await selection.getTranslationModelSettings()).status, 'unconfigured');
  await assert.rejects(() => selection.resolveTranslationModel(), /翻译模型列表/);
await selection.selectTranslationModel('translation_disabled');
assert.equal((await selection.getTranslationModelSettings()).status, 'active', '旧停用字段不再影响可用性');
await selection.selectTranslationModel('translation_ai');
assert.ok(signals > 0); unsubscribe();
const snapshotFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-models-'));
const snapshotPath = path.join(snapshotFolder, 'snapshot.db');
try {
  await backup(db, snapshotPath);
  const restored = new DatabaseSync(snapshotPath);
  try {
    await migrateTranslationModels(executor(restored));
    assert.equal(restored.prepare('SELECT model_config_id FROM translation_settings').get().model_config_id, 'translation_ai');
    assert.equal(restored.prepare("SELECT count(*) AS count FROM auxiliary_model_configs WHERE capability_kind = 'translation'").get().count, 3);
  } finally { restored.close(); }
} finally { fs.unlinkSync(snapshotPath); fs.rmdirSync(snapshotFolder); }

const errorMapping = load('src/platform/ai/errorMapping.ts');
const baseUrl = load('src/platform/ai/baseUrl.ts');
const baseClient = load('src/platform/ai/BaseAIClient.ts', { './HttpExchangeCapture': { beginAIHttpCapture: async () => null }, './errorMapping': errorMapping, './baseUrl': baseUrl });
const kimiClient = load('src/platform/ai/KimiClient.ts', { './BaseAIClient': baseClient });
const discovery = load('src/platform/ai/modelDiscovery.ts', { './errorMapping': errorMapping, './baseUrl': baseUrl });
const aiPlatform = { ...load('src/platform/ai/OpenAIClient.ts', { './BaseAIClient': baseClient, './KimiClient': kimiClient, './modelDiscovery': discovery, './errorMapping': errorMapping }), ...discovery };
const tencentCalls = [];
const translation = load('src/features/integrations/TranslateMessageText.ts', {
  '@platform/ai': aiPlatform, './application/TranslationModels': selection,
  './infrastructure/translation': { TencentCloudTmtClient: class {
    constructor(credentials, options) { tencentCalls.push({ credentials, options }); }
    async translateText(params) { tencentCalls.at(-1).params = params; return { translatedText: 'hello' }; }
  } },
});
const requests = [];
const originalFetch = globalThis.fetch;
let networkError = false;
let modelResponse = { choices: [{ message: { content: '你好！\n世界。', reasoning_content: '思考译法' }, finish_reason: 'stop' }], id: 'translation-response' };
globalThis.fetch = async (url, options) => {
  requests.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
  if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'any-text-model' }] }) };
  if (networkError) return Response.json({ error: { message: '翻译密钥无效' } }, { status: 401 });
  return Response.json(modelResponse);
};
try {
  const result = await translation.translateMessageText({ text: 'Hello!\nWorld.' });
  assert.equal(result.translatedText, '你好！\n世界。');
  assert.equal(result.configId, 'translation_ai');
  assert.equal(result.sourceLabel, 'Translated by any-text-model');
  assert.equal(requests.at(-1).url, 'https://models.example/v1/chat/completions');
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer ai-key');
  assert.equal(requests.at(-1).body.messages.length, 2, '只发送翻译指令和原文');
  assert.equal(requests.at(-1).body.messages[1].content, 'Hello!\nWorld.');
  assert.equal(requests.at(-1).body.temperature, undefined);
  assert.equal(requests.at(-1).body.max_tokens, undefined);
  assert.ok(requests.at(-1).body.messages[0].content.includes('源语言：自动识别；目标语言：zh'));
  networkError = true;
  await assert.rejects(() => translation.translateMessageText({ text: 'Hello' }), /翻译密钥无效/);
  assert.equal(tencentCalls.length, 0);
  networkError = false;
  for (const [message, finish, error] of [[{ content: '' }, 'stop', /返回为空/], [{ content: '不完整' }, 'length', /截断/], [{ reasoning_content: '只有思考' }, 'stop', /返回为空/]]) {
    modelResponse = { choices: [{ message, finish_reason: finish }] };
    await assert.rejects(() => translation.translateMessageText({ text: 'Hello' }), error);
  }
  await selection.selectTranslationModel('translation_tencent');
  await translation.translateMessageText({ text: '你好' });
  assert.equal(tencentCalls[0].credentials.secretId, 'existing-id');
  assert.equal(tencentCalls[0].credentials.secretKey, 'existing-key');
  assert.equal(tencentCalls[0].options.region, 'ap-shanghai');
  assert.equal(tencentCalls[0].options.projectId, 7);
  assert.equal(tencentCalls[0].params.target, 'en');
  await selection.selectTranslationModel('translation_ai');
  modelResponse = { choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] };
  const beforeTest = db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all();
  await translation.testTranslationModelConnection(await selection.resolveTranslationModel());
  assert.deepEqual(db.prepare('SELECT * FROM auxiliary_model_configs ORDER BY id').all(), beforeTest);
  assert.equal(await translationSettingsRepository.getModelId(), 'translation_ai');

  const draftModule = load('src/features/assistants/presentation/auxiliaryModels/translationModelDraft.ts', { '@features/integrations': contract });
  const { AutoSaveDraftEditor } = load('src/shared/ui/AutoSaveDraftEditor.ts');
  const model = await repository.getModelConfigById('translation_ai');
  const editor = new AutoSaveDraftEditor(draftModule.getTranslationModelDraft(model), draftModule.parseTranslationModelDraft,
    async (patch) => { await commands.updateAuxiliaryModelConfig({ id: model.id, settings: patch }); });
  editor.change({ apiKey: '', name: '新名字' });
  assert.equal(await editor.flush(), false);
  assert.equal((await repository.getModelConfigById(model.id)).name, '新名字');
  assert.equal((await repository.getModelConfigById(model.id)).apiKey, 'ai-key');
  assert.ok(editor.getSnapshot().errors.apiKey);
  await editor.restore();
  editor.change({ apiKey: 'new-key', baseUrl: 'https://another.example/v1', model: 'custom-text-model' });
  assert.equal(await editor.flush(), true);
  assert.equal((await repository.getModelConfigById(model.id)).model, 'custom-text-model');
  assert.equal(await translationSettingsRepository.getModelId(), model.id);
  editor.change(draftModule.switchTranslationProvider('tencentCloudTmt'));
  assert.equal(await editor.flush(), false, '提供方切换未填凭据不能提交混合配置');
  assert.equal(JSON.parse((await repository.getModelConfigById(model.id)).metadataJson).provider, 'aiModel');
  await editor.restore();

  const theme = {
    colors: {
      text: { tertiary: '#666' },
      brand: { primary: '#345' },
      background: { app: '#fff', screen: '#eee' },
      feedback: { error: '#f00' },
      surface: { default: '#fff', raised: '#fff' },
    },
    spacing: { lg: 16, xl: 24, md: 12 },
    radius: { lg: 12 },
    effects: { glass: { enabled: false } },
  };
  const native = Object.fromEntries(['ActivityIndicator', 'View', 'Text', 'ScrollView', 'KeyboardAvoidingView', 'TouchableOpacity', 'Pressable'].map((name) => [name, name]));
  native.StyleSheet = { create: (styles) => styles };
  native.Alert = { alert() {} };
  native.AppState = native.BackHandler = { addEventListener: () => ({ remove() {} }) };
  const shared = Object.fromEntries(['Button', 'InputField', 'DropdownField', 'ToggleField', 'ModelPickerModal', 'NavigationHeader', 'EmptyState', 'ListItem', 'KeyboardAvoidingContainer'].map((name) => [name, name]));
  shared.NavigationHeader = function NavigationHeader({ rightButton, ...props }) { return React.createElement('Header', props, rightButton); };
  shared.showAppDialog = () => {};
  const uiTheme = { ThemedSurface: 'Surface', useTheme: () => theme, useThemedStyles: () => ({}) };
  shared.ConfiguredModelPicker = load('src/shared/ui/ConfiguredModelPicker.tsx', {
    'react-native': native, '@shared/theme': uiTheme, 'lucide-react-native': { Check: 'Check', ChevronRight: 'ChevronRight' },
    './ModelPickerModal': { __esModule: true, default: 'ModelPickerModal' },
    './ModalSheet': { __esModule: true, default: function ModalSheet({ visible, children }) { return visible ? React.createElement('ModalSheet', null, children) : null; } },
  }).default;
  const TranslationPicker = load('src/features/integrations/presentation/TranslationModelPicker.tsx', {
    '@shared/ui': shared, '../application/TranslationModels': selection,
  }).default;
  const hooks = load('src/shared/ui/useAutoSaveDraft.ts', { 'react-native': native, 'expo-router': { useFocusEffect: React.useEffect } });
  let screen;
  const Form = load('src/features/assistants/presentation/auxiliaryModels/TranslationModelEditScreen.tsx', {
    'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, '@shared/ui': shared,
    '@shared/theme': { useTheme: () => theme }, '@platform/ai': aiPlatform,
    '@features/integrations': { ...contract, ...providers, ...translation },
    '@shared/ui/useAutoSaveDraft': hooks,
    '@shared/ui/useAutoSaveFeedback': { useAutoSaveFeedback: () => ({ scrollRef: null, fieldLayout: () => () => {}, revealErrors() {}, blocked: false, setBlocked() {} }) },
    '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'AutoSaveErrors' },
    './translationModelDraft': draftModule, './ServiceConnectionPicker': { __esModule: true, default: 'ServicePicker' },
  }).default;
  const created = [];
  await renderer.act(async () => { screen = renderer.create(React.createElement(Form, { initialData: null, saving: false, onSave() {}, onCreate: async (data) => { created.push(data); }, onBack() {} })); });
  const fields = () => screen.root.findAllByType('InputField');
  const input = (label) => fields().find((node) => node.props.label === label);
  const button = (title) => screen.root.findAllByType('Button').find((node) => node.props.title === title);
  assert.ok(fields().indexOf(input('API 地址')) < fields().indexOf(input('API Key')), '地址在密钥之前');
  assert.notEqual(input('API Key').props.secureTextEntry, true);
  assert.equal(screen.root.findAllByType('ServicePicker').length, 1, 'AI 翻译允许选择通用服务');
  const providerField = () => screen.root.findAllByType('DropdownField').find(node => node.props.label === '翻译方式');
  await renderer.act(async () => providerField().props.onChange('tencentCloudTmt'));
  assert.equal(screen.root.findAllByType('ServicePicker').length, 0, '腾讯云机器翻译不接入通用服务');
  await renderer.act(async () => providerField().props.onChange('aiModel'));
  for (const [label, value] of [['配置名称', '测试资产'], ['API 地址', 'https://models.example/v1'], ['API Key', 'test-key'], ['模型名称', 'manual-model']]) {
    await renderer.act(async () => input(label).props.onChangeText(value));
  }
  await renderer.act(async () => button('获取模型列表').props.onPress());
  const picker = screen.root.findByType('ModelPickerModal');
  assert.equal(picker.props.visible, true);
  await renderer.act(async () => picker.props.onSelect('any-text-model'));
  await renderer.act(async () => button('创建').props.onPress());
  assert.equal(created.length, 1);
  assert.equal(created[0].model, 'any-text-model');
  assert.equal(created[0].baseUrl, 'https://models.example/v1');
  await renderer.act(async () => screen.unmount());

  const pickerNative = { ...native, Modal: 'Modal', TouchableWithoutFeedback: 'Backdrop',
    Dimensions: { get: () => ({ height: 800, width: 400 }) },
    Animated: { Value: class { constructor(value) { this.value = value; } }, View: 'AnimatedView' },
    FlatList: function FlatList({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }) {
      return React.createElement('RenderedList', null, ListHeaderComponent,
        data.length ? data.map(item => React.createElement('Row', { key: item.id }, renderItem({ item }))) : ListEmptyComponent,
        ListFooterComponent);
    },
  };
  const pickerTheme = { ...uiTheme, useTheme: () => ({ ...theme, components: { modalSheet: { backgroundColor: '#fff' } } }) };
  const Sheet = load('src/shared/ui/ModalSheet.tsx', {
    'react-native': pickerNative, '@shared/theme': pickerTheme,
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    './KeyboardAvoidingContainer': { __esModule: true, default: 'KeyboardContainer' },
  });
  const Picker = load('src/shared/ui/ModelPickerModal.tsx', {
    'react-native': pickerNative, '@shared/theme': pickerTheme, 'lucide-react-native': { Check: 'Check' },
    './ModalSheet': Sheet, './NavigationHeaderHelp': { __esModule: true, default: 'Help' },
  }).default;
  const picked = [];
  await renderer.act(async () => { screen = renderer.create(React.createElement(Picker, {
    visible: true, title: '选择服务配置', description: '说明', onClose() {},
    models: [{ id: 'a', name: '服务 A' }, { id: 'b', name: '服务 B' }],
    onSelect: id => picked.push(id), onClear: () => picked.push(null),
  })); });
  const title = screen.root.findAllByType('Text').find(node => node.props.children === '选择服务配置');
  assert.equal(title.parent.findAllByType('Help').length, 1, '问号在弹窗标题旁');
  const list = screen.root.findByType('RenderedList');
  assert.equal(list.findAllByType('Help').length, 0, '列表正文没有游离的问号');
  assert.deepEqual(list.findAllByType('Text').map(node => node.props.children), ['服务 A', '服务 B', '取消选择']);
  await renderer.act(async () => list.findAllByType('Pressable')[1].props.onPress());
  await renderer.act(async () => list.findAllByType('Pressable').at(-1).props.onPress());
  assert.deepEqual(picked, ['b', null]);
  await renderer.act(async () => screen.unmount());

  const capability = load('src/features/assistants/domain/AuxiliaryModel.ts');
  const Pool = load('src/features/assistants/presentation/auxiliaryModels/AuxiliaryModelPoolScreen.tsx', {
    'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'lucide-react-native': { Plus: 'Plus' }, '@shared/theme': uiTheme, '@shared/ui': shared, './styles': { createStyles() {} },
  }).default;
  const navigator = load('src/features/assistants/presentation/auxiliaryModels/AuxiliaryModelNavigator.tsx', {
    'react-native': native, '@shared/ui': shared,
    '@features/integrations': { TranslationModelPicker: TranslationPicker },
    '@features/speech': { SpeechRecognitionModelPicker: 'SpeechRecognitionModelPicker' },
    './ModelServiceListScreen': { __esModule: true, default: 'Services' }, './ModelServiceEditScreen': { __esModule: true, default: 'ServiceEdit' },
    './AuxiliaryModelCenterScreen': { __esModule: true, default: 'Center' }, './AuxiliaryModelPoolScreen': { __esModule: true, default: Pool },
    './AuxiliaryModelEditScreen': { __esModule: true, default: 'Edit' }, './SpeechModelEditScreen': { __esModule: true, default: 'SpeechEdit' },
    './TranslationModelEditScreen': { __esModule: true, default: 'TranslationEdit' },
    '../../ManageAuxiliaryModelConfigs': commands, '../../TestAuxiliaryModelConnection': {},
  }).default;
  const navigated = [];
  const navigationProps = { onBack() {}, onNavigate: (route) => navigated.push(route) };
  await renderer.act(async () => { screen = renderer.create(React.createElement(navigator, { ...navigationProps, route: { screen: 'center' } })); });
  const center = screen.root.findByType('Center');
  assert.ok(center.props.capabilityItems.some((item) => item.kind === 'translation'));
  center.props.onOpenCapabilityPool('translation');
  assert.deepEqual(navigated.at(-1), { screen: 'pool', kind: 'translation' });
  await renderer.act(async () => screen.update(React.createElement(navigator, { ...navigationProps, route: navigated.at(-1) })));
  const pool = screen.root.findByType(Pool);
  assert.ok(pool.props.models.every((entry) => entry.capabilityKind === 'translation'));
  const tencentAsset = pool.props.models.find((entry) => entry.id === 'translation_tencent');
  assert.ok(tencentAsset, '腾讯云配置与 AI 配置出现在同一模型列表');
  assert.ok(screen.root.findAllByType('ListItem').some((node) => node.props.title === tencentAsset.name));
  const openSelection = () => screen.root.findAllByType('Pressable').find((node) => node.props.accessibilityLabel === '选择聊天翻译模型');
  const choose = (text) => screen.root.findAllByType('Pressable').find((node) => node.findAllByType('Text').some((label) => label.props.children === text));
  const navigationCount = navigated.length;
  await renderer.act(async () => openSelection().props.onPress());
  assert.equal(choose('管理模型配置'), undefined, '列表中的选择不再提供多余管理跳转');
  await renderer.act(async () => screen.root.findByType('ModelPickerModal').props.onSelect(tencentAsset.id));
  assert.equal(await translationSettingsRepository.getModelId(), tencentAsset.id);
  assert.equal(navigated.length, navigationCount, '切换翻译配置无需页面跳转');
  await translation.translateMessageText({ text: '你好' });
  assert.equal(tencentCalls.at(-1).credentials.secretKey, 'existing-key', '列表选择立即用于真实翻译调用');
  await renderer.act(async () => openSelection().props.onPress());
  await renderer.act(async () => screen.root.findByType('ModelPickerModal').props.onClear());
  assert.equal((await selection.getTranslationModelSettings()).status, 'unconfigured');
  await renderer.act(async () => openSelection().props.onPress());
  await renderer.act(async () => screen.root.findByType('ModelPickerModal').props.onSelect('translation_ai'));
  assert.equal(await translationSettingsRepository.getModelId(), 'translation_ai');
  pool.props.onAddModel();
  await renderer.act(async () => screen.update(React.createElement(navigator, { ...navigationProps, route: navigated.at(-1) })));
  screen.root.findByType('TranslationEdit').props.onBack();
  assert.deepEqual(navigated.at(-1), { screen: 'pool', kind: 'translation' });
  await renderer.act(async () => screen.unmount());
  const pushed = [];
  const expo = { useRouter: () => ({ push: (target) => pushed.push(target), back() {} }) };
  const HostRoute = load('src/host/navigation/AuxiliaryModelsRouteContent.tsx', { 'expo-router': expo,
    '@features/assistants': { ...capability, AuxiliaryModelNavigator: 'Navigator' }, './useRetainedRouteRefreshRevision': { __esModule: true, default: () => 0 } }).default;
  await renderer.act(async () => { screen = renderer.create(React.createElement(HostRoute, { route: { screen: 'center' } })); });
  screen.root.findByType('Navigator').props.onNavigate({ screen: 'pool', kind: 'translation' });
  assert.equal(pushed.at(-1), '/auxiliary-models/capabilities/translation');
  await renderer.act(async () => screen.unmount());
} finally { globalThis.fetch = originalFetch; db.close(); }
console.log('翻译模型：共用资产列表与自动保存、明确选择、失效引用、旧配置迁移/回滚/快照恢复、草稿测试和真实客户端请求通过。');
