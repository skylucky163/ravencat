/** 自动保存的输入、确认、错误与页面生命周期行为验证，不断言源码形状。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(relative, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `${relative} 未提供依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const directory = 'src/features/assistants/presentation/';
const core = load('src/shared/ui/AutoSaveDraftEditor.ts');
const numbers = load('src/shared/ui/draftValidation.ts');
const prompt = {
  DEFAULT_GROUP_CONTEXT_PRIMARY_LIMIT: 40, DEFAULT_GROUP_CONTEXT_SECONDARY_LIMIT: 5,
  DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT: 30, DEFAULT_PRIVATE_CONTEXT_SECONDARY_LIMIT: 10,
};
const models = load(`${directory}management/AIModelSettings/modelSettingsHelpers.ts`, {
  '@shared/ui/draftValidation': numbers, '@shared/prompt': prompt,
});
const auxiliary = load(`${directory}auxiliaryModels/auxiliaryModelDraft.ts`, {
  '@shared/ui/draftValidation': numbers, '@shared/prompt': prompt,
});
const speechCatalog = load('src/features/speech/application/SpeechProviderCatalog.ts');
const speechDraft = load(`${directory}auxiliaryModels/speechModelDraft.ts`, { '@features/speech': speechCatalog });
const profile = {
  apiBaseUrl: 'https://example.invalid/v1', apiKey: 'old', model: 'chat', temperature: 0.7, topP: 1, maxTokens: 2000,
  privateContextPrimaryLimit: 30, privateContextSecondaryLimit: 10, groupContextPrimaryLimit: 40, groupContextSecondaryLimit: 5,
  enableTools: false, allowMultipleBubbles: true, disableThinking: false,
};
const initial = models.getModelSettingsDraft(profile);
// 页面连接测试和重置复用留空语义，不能把空字符串通过 Number 转成 0。
let resetDraft;
const modelForm = load(`${directory}management/AIModelSettings/useModelSettingsForm.ts`, {
  react: { useCallback: (callback) => callback, useMemo: (factory) => factory() },
  '../../../AIAssistantManagement': {},
  '@shared/ui/useAutoSaveDraft': { useAutoSaveDraft: ({ initial }) => ({ draft: initial, change: (patch) => { resetDraft = patch; } }) },
  '@shared/ui/draftValidation': numbers,
  './modelSettingsHelpers': models,
}).default;
for (const sampling of [{ temperature: null, topP: null }, { temperature: 0, topP: 0 }, { temperature: 1, topP: 0.95 }]) {
  const form = modelForm({ aiAssistant: { ...profile, ...sampling } });
  assert.deepEqual(form.getConnectionParams(), { ...sampling, maxTokens: 2000, disableThinking: false });
  assert.equal(form.temperature, sampling.temperature);
  assert.equal(form.topP, sampling.topP);
  form.handleReset();
  assert.deepEqual(resetDraft, { tempInput: '', topPInput: '', maxTokens: '2000' }, '模型重置只提交模型参数，不修改对话的上下文或气泡设置');
}
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function editor(save, draft = initial, parse = models.parseModelSettingsDraft) {
  return new core.AutoSaveDraftEditor(draft, parse, save);
}
mock.timers.enable({ apis: ['setTimeout'] });
try {
  // 清空采样参数是有效增量，重新打开继续留空；显式 0 不能被当成默认值。
  {
    const writes = [];
    const form = editor(async (patch) => { writes.push(patch); });
    form.change({ tempInput: '', topPInput: '  ' });
    assert.equal(await form.flush(), true);
    assert.deepEqual(writes, [{ temperature: null, topP: null }]);
    const reopened = models.getModelSettingsDraft({ ...profile, ...writes[0] });
    assert.equal(reopened.tempInput, '');
    assert.equal(reopened.topPInput, '');
    form.change({ tempInput: '0', topPInput: '0' });
    assert.equal(await form.flush(), true);
    assert.deepEqual(writes.at(-1), { temperature: 0, topP: 0 });
    assert.deepEqual(form.getSnapshot().errors, {});
  }
  // 开关立即增量保存，重新打开沿用已确认选择，不覆盖其他模型参数。
  {
    const writes = [];
    const form = editor(async (patch) => { writes.push(patch); });
    form.change({ disableThinking: true }, true); await tick();
    assert.deepEqual(writes, [{ disableThinking: true }]);
    assert.equal(models.getModelSettingsDraft({ ...profile, ...writes[0] }).disableThinking, true);
    form.change({ disableThinking: false }, true); await form.flush();
    assert.deepEqual(writes, [{ disableThinking: true }, { disableThinking: false }]);
  }
  // 停输不保存；失焦提交当时的最新草稿，没有周期性空写入。
  {
    const writes = [];
    const form = editor(async (patch) => { writes.push(patch); });
    form.change({ apiKey: 'a' });
    mock.timers.tick(900); await tick();
    form.change({ apiKey: 'ab' });
    mock.timers.tick(999); await tick();
    assert.deepEqual(writes, []);
    mock.timers.tick(10000); await tick();
    assert.deepEqual(writes, [], '输入框仍有焦点时，停输多久都不提交');
    await form.commit();
    assert.deepEqual(writes, [{ apiKey: 'ab' }]);
    mock.timers.tick(10000); await tick();
    assert.equal(writes.length, 1);
  }
  // 迟到确认不能覆盖后续输入；后续提交也不能被正在保存的标记丢弃。
  {
    const pending = [];
    const writes = [];
    const form = editor((patch) => { const work = deferred(); pending.push(work); writes.push(patch); return work.promise; });
    form.change({ apiKey: 'A' }, true); await tick();
    form.change({ apiKey: 'B', selectedModel: 'new-model' });
    pending[0].resolve(); await tick();
    assert.equal(form.getSnapshot().draft.apiKey, 'B');
    assert.deepEqual(writes, [{ apiKey: 'A' }], '写入期间继续输入仍等待失焦');
    mock.timers.tick(10000); await tick();
    assert.equal(writes.length, 1);
    const committing = form.commit(); await tick();
    assert.deepEqual(writes, [{ apiKey: 'A' }, { apiKey: 'B', model: 'new-model' }]);
    pending[1].resolve(); await committing;
    assert.equal(form.getSnapshot().draft.selectedModel, 'new-model');
    assert.equal(form.getSnapshot().dirty, false);
  }
  // 失焦只确认当时的版本，不把保存期间的新输入一起写入。
  {
    const work = deferred(); const writes = [];
    const form = editor(async (patch) => { writes.push(patch); if (writes.length === 1) await work.promise; });
    form.change({ apiKey: 'A' }, true); await tick();
    form.change({ apiKey: 'B' }); const committing = form.commit(); await tick();
    form.change({ apiKey: 'C' }); work.resolve(); await tick();
    await committing;
    assert.deepEqual(writes, [{ apiKey: 'A' }, { apiKey: 'B' }]);
    mock.timers.tick(1000); await tick();
    assert.equal(writes.length, 2);
    await form.commit();
    assert.deepEqual(writes, [{ apiKey: 'A' }, { apiKey: 'B' }, { apiKey: 'C' }]);
  }
  // 开关只提交自己的字段，不带走尚未失焦的独立文字输入。
  {
    const writes = []; const form = editor(async (patch) => { writes.push(patch); });
    form.change({ apiKey: 'pending' });
    form.change({ disableThinking: true }, true); await tick();
    assert.deepEqual(writes, [{ disableThinking: true }]);
    assert.equal(form.getSnapshot().dirty, true);
    await form.commit();
    assert.deepEqual(writes.at(-1), { apiKey: 'pending' });
  }
  // 多次立即修改串行确认，不把中途的新文字输入混入排队的字段。
  {
    const work = deferred(); const writes = [];
    const form = editor(async (patch) => { writes.push(patch); if (writes.length === 1) await work.promise; });
    form.change({ apiKey: 'A' }); const first = form.commit(); await tick();
    form.change({ apiKey: 'B' });
    form.change({ enableTools: true }, true);
    form.change({ disableThinking: true }, true);
    work.resolve(); await first;
    assert.deepEqual(writes, [{ apiKey: 'A' }, { enableTools: true, disableThinking: true }]);
    assert.equal(form.getSnapshot().draft.apiKey, 'B');
    await form.commit();
    assert.deepEqual(writes.at(-1), { apiKey: 'B' });
  }
  // 保存期间改回原值也必须补交，不能把旧的 saved 快照误当成数据库当前值。
  {
    const work = deferred(); const writes = [];
    const form = editor(async (patch) => { writes.push(patch); if (writes.length === 1) await work.promise; });
    form.change({ apiKey: 'A' }, true); await tick();
    form.change({ apiKey: 'old' });
    work.resolve(); await form.flush();
    assert.deepEqual(writes, [{ apiKey: 'A' }, { apiKey: 'old' }]);
  }
  // 无效数字原样保留，合法字段仍可提交；失败的退出检查不能标成已保存。
  {
    const writes = []; const form = editor(async (patch) => { writes.push(patch); });
    form.change({ tempInput: '3', apiKey: 'new' });
    assert.equal(await form.flush(), false);
    assert.deepEqual(writes, [{ apiKey: 'new' }]);
    assert.equal(form.getSnapshot().draft.tempInput, '3');
    assert.match(form.getSnapshot().errors.tempInput, /尚未保存/);
    form.change({ disableThinking: true }, true); await tick();
    assert.deepEqual(writes.at(-1), { disableThinking: true });
    assert.match(form.getSnapshot().errors.tempInput, /尚未保存/, '独立开关保存不能清除尚未修正的字段错误');
    form.change({ tempInput: '1.3' });
    assert.equal(await form.flush(), true);
    assert.deepEqual(form.getSnapshot().errors, {});
    form.change({ maxTokens: '' });
    assert.equal(await form.flush(), false, '角色 Max Tokens 删空不能静默变成无限制');
    await form.restore();
    assert.equal(form.getSnapshot().draft.maxTokens, '2000');
    assert.equal(form.getSnapshot().draft.apiKey, 'new', '恢复保留已经成功提交的合法修改');
  }
  // 写入失败保留草稿，不循环重试；明确重试使用最新输入。
  {
    let failing = true; const writes = [];
    const form = editor(async (patch) => { writes.push(patch); if (failing) throw new Error('磁盘写入失败'); });
    form.change({ apiKey: 'new' }, true); await tick();
    assert.equal(form.getSnapshot().draft.apiKey, 'new');
    assert.match(form.getSnapshot().saveError, /输入已保留/);
    mock.timers.tick(10000); await tick();
    assert.equal(writes.length, 1);
    failing = false;
    assert.equal(await form.flush(), true);
    assert.equal(form.getSnapshot().saveError, null);
  }
  // 恢复等待已提交的写入结束，但不把尚未提交的新草稿顺带写入。
  {
    const work = deferred(); const writes = [];
    const form = editor(async (patch) => { writes.push(patch); await work.promise; });
    form.change({ apiKey: 'A' }, true); await tick();
    form.change({ apiKey: 'B' });
    const restored = form.restore(); work.resolve(); await restored;
    assert.deepEqual(writes, [{ apiKey: 'A' }]);
    assert.equal(form.getSnapshot().draft.apiKey, 'A');
  }
  // 等待恢复时继续输入的新内容也不能被较早的恢复动作覆盖。
  {
    const work = deferred(); const writes = [];
    const form = editor(async (patch) => { writes.push(patch); await work.promise; });
    form.change({ apiKey: 'A' }, true); await tick();
    form.change({ apiKey: 'B' });
    const restored = form.restore();
    form.change({ apiKey: 'C' }); work.resolve(); await restored;
    assert.equal(form.getSnapshot().draft.apiKey, 'C');
    assert.deepEqual(writes, [{ apiKey: 'A' }]);
    mock.timers.tick(1000); await tick();
    assert.deepEqual(writes, [{ apiKey: 'A' }], '恢复期间的新输入继续等待失焦');
    await form.commit();
    assert.deepEqual(writes, [{ apiKey: 'A' }, { apiKey: 'C' }]);
  }
  // 返回后外部刷新只同步未编辑字段，初始化本身不写数据库。
  {
    const writes = []; const form = editor(async (patch) => { writes.push(patch); });
    form.change({ apiKey: 'local' });
    form.rebase({ ...initial, selectedModel: 'external', apiKey: 'external' });
    assert.equal(form.getSnapshot().draft.apiKey, 'local');
    assert.equal(form.getSnapshot().draft.selectedModel, 'external');
    await form.flush();
    assert.deepEqual(writes, [{ apiKey: 'local' }]);
    const switched = models.parseModelSettingsDraft({ ...initial, selectedModel: 'text-only' }, ['selectedModel']);
    assert.deepEqual(switched.patch, { model: 'text-only' }, '换主模型不隐式改写图片策略');
  }
  // 辅助模型 Key 显式清空，关联 metadata 失败不能阻止名称与启停保存。
  {
    const draft = speechDraft.getSpeechModelDraft('tts', { name: 'voice', baseUrl: 'https://example.invalid', apiKey: 'old', model: 'speech',
      enabled: true, metadataJson: JSON.stringify({ provider: 'minimaxT2aV2', voiceId: 'voice', speed: 1 }) });
    const writes = [];
    const form = editor(async (patch) => { writes.push(patch); }, draft, (data, keys) => speechDraft.parseSpeechModelDraft('tts', data, keys));
    form.change({ apiKey: '', name: 'new-name', speed: '3' });
    assert.equal(await form.flush(), false);
    assert.deepEqual(writes, [{ name: 'new-name', apiKey: null }]);
    assert.equal(form.getSnapshot().draft.speed, '3');
    form.change({ speed: '1.2' });
    assert.equal(await form.flush(), true);
    const metadata = JSON.parse(writes[1].metadataJson);
    assert.equal(metadata.provider, 'minimaxT2aV2'); assert.equal(metadata.voiceId, 'voice'); assert.equal(metadata.speed, 1.2);
    form.change({ sampleRate: '16000.4' });
    assert.equal(await form.flush(), false, '整数配置不能截断小数后保存');
    await form.restore();
    form.change({ sampleRate: '无限制' });
    assert.equal(await form.flush(), false, '无限制仅属于 Max Tokens，不能清空采样率');
    await form.restore();
    form.change({ pitch: '1.5' });
    assert.equal(await form.flush(), false, '音调不能在运行时静默截断小数');
    await form.restore();
  }
  {
    const draft = auxiliary.getAuxiliaryModelDraft({ name: 'ocr', baseUrl: 'https://example.invalid', apiKey: 'key', model: 'vision',
      enabled: true, metadataJson: '{"providerOption":true,"taskPromptOverride":"旧说明"}' });
    const result = auxiliary.parseAuxiliaryModelDraft('ocr', { ...draft, model: 'vision-2' }, ['model']);
    assert.equal(result.patch.model, 'vision-2');
    assert.equal(Object.hasOwn(result.patch, 'metadataJson'), false, '任务说明已归提示词中心，模型配置不再改写 metadata');
    const fresh = editor(async () => { assert.fail('创建前不应持久化'); }, auxiliary.getAuxiliaryModelDraft(null),
      (data, keys) => auxiliary.parseAuxiliaryModelDraft('embedding', data, keys));
    assert.equal(fresh.validateAll(), null); assert.ok(fresh.getSnapshot().errors.name);
  }
  // 语音模型的手输入口等待失焦，下拉选择仍然立即保存。
  {
    const react = {
      default: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
      useCallback: (callback) => callback, useMemo: (factory) => factory(), useRef: (value) => ({ current: value }),
      useState: (value) => [value, () => {}], useEffect() {},
    };
    const writes = [];
    const { default: SpeechPage } = load(`${directory}auxiliaryModels/SpeechModelEditScreen.tsx`, {
      react, 'react-native': { ScrollView: 'ScrollView', Text: 'Text', TouchableOpacity: 'Button', View: 'View',
        Keyboard: { dismiss() {} } },
      'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
      '@features/speech': { ...speechCatalog, SpeechConfigurationTest: 'SpeechTest' },
      '@shared/ui': { KeyboardAvoidingContainer: 'KeyboardContainer', Button: 'Button', DropdownField: 'Dropdown', InputField: 'Input', ToggleField: 'Toggle', ModelPickerModal: 'ModelPicker', ListItem: 'ListItem' },
      '@shared/ui/NavigationHeader': { default: 'Header' },
      '@shared/theme': { useTheme: () => ({ colors: { background: { app: '#fff' }, feedback: { error: '#e00' }, text: { secondary: '#555' } }, spacing: { md: 12, lg: 16, xl: 24 } }) },
      '@shared/ui/useAutoSaveDraft': {
        useAutoSaveDraft: ({ initial: draft, parse, save }) => {
          const form = new core.AutoSaveDraftEditor(draft, parse, save);
          return { ...form.getSnapshot(), change: form.change, commit: form.commit, flush: form.flush };
        },
        useAutoSaveNavigation: () => ({}),
      },
      '@shared/ui/useAutoSaveFeedback': { useAutoSaveFeedback: () => ({ fieldLayout: () => () => {} }) },
      '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'Errors' }, './speechModelDraft': speechDraft, './ServiceConnectionPicker': { default: 'ServicePicker' },
    });
    const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flat(Infinity).flatMap(nodes)] : [];
    const render = (provider, model) => nodes(SpeechPage({ kind: 'tts', modelId: 'voice',
      initialData: { name: 'voice', enabled: true, baseUrl: 'https://example.invalid/v1', apiKey: 'key', model,
        metadataJson: JSON.stringify({ provider, voiceId: 'voice' }) },
      saving: false, onSave: async (patch) => { writes.push(patch); }, onCreate() {}, onBack() {},
    }));
    const manual = render('openaiCompatible', 'custom-model').find((node) => node.type === 'Input' && node.props.label === '模型');
    manual.props.onChangeText('custom-model-v2'); mock.timers.tick(10000); await tick();
    assert.deepEqual(writes, [], '手输模型名不能逐字保存');
    manual.props.onBlur(); await tick();
    assert.equal(writes.at(-1).model, 'custom-model-v2');
    const picker = render('openai', 'tts-1').find((node) => node.type === 'ModelPicker');
    picker.props.onSelect('tts-1-hd'); await tick();
    assert.equal(writes.at(-1).model, 'tts-1-hd');
  }
  // 页面接线行为：后台提交、系统返回拦截、成功后返回、新建不自动保存。
  {
    let appStateListener; let backListener; const cleanups = []; let focusedCleanup;
    const react = {
      useCallback: (callback) => callback, useRef: (value) => ({ current: value }),
      useState: (initialValue) => [typeof initialValue === 'function' ? initialValue() : initialValue, () => {}],
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      useEffect: (effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    };
    const hooks = load('src/shared/ui/useAutoSaveDraft.ts', {
      react, './AutoSaveDraftEditor': core,
      'react-native': {
        AppState: { addEventListener: (_event, callback) => { appStateListener = callback; return { remove() {} }; } },
        BackHandler: { addEventListener: (_event, callback) => { backListener = callback; return { remove() {} }; } },
      },
      'expo-router': { useFocusEffect: (effect) => { focusedCleanup = effect(); } },
    });
    const writes = []; let returned = 0; let revealed = 0;
    const form = hooks.useAutoSaveDraft({ initial, parse: models.parseModelSettingsDraft, save: async (patch) => { writes.push(patch); } });
    hooks.useAutoSaveNavigation(form.flush, () => { returned++; }, () => { revealed++; });
    form.change({ apiKey: 'background', tempInput: '3' });
    appStateListener('background'); await tick();
    assert.deepEqual(writes, [{ apiKey: 'background' }]);
    assert.equal(backListener(), true); await tick();
    assert.equal(returned, 0); assert.equal(revealed, 1);
    await form.restore();
    assert.equal(backListener(), true); await tick();
    assert.equal(returned, 1);
    const fresh = hooks.useAutoSaveDraft({ initial, parse: models.parseModelSettingsDraft, save: async () => { assert.fail('新建不能自动保存'); }, enabled: false });
    fresh.change({ apiKey: 'draft' }, true); mock.timers.tick(2000); await tick();
    for (const cleanup of cleanups) cleanup(); focusedCleanup();
  }
  // 保存回调只确认本次模型字段，独立的主理关系回调不携带旧模型投影。
  {
    let save; const updates = [];
    const { default: renderForm } = load(`${directory}management/AIModelSettings/useModelSettingsForm.ts`, {
      react: { useMemo: (factory) => factory(), useCallback: (callback) => callback },
      './modelSettingsHelpers': models, '@shared/ui/draftValidation': numbers,
      '@shared/ui/useAutoSaveDraft': { useAutoSaveDraft: (options) => {
        save = options.save; return { draft: options.initial, change() {} };
      } },
      '../../../AIAssistantManagement': { updateAIModelSettings: async () => ({ ...profile, apiKey: 'new', updatedAt: 'committed', name: '无关旧名称' }) },
    });
    renderForm({ aiAssistant: { ...profile, id: 'ai' }, onUpdated: (patch) => updates.push(patch) });
    await save({ apiKey: 'new' });
    assert.deepEqual(updates, [{ apiKey: 'new', updatedAt: 'committed' }]);
    let stateIndex = 0; let confirmation; let appointmentCalls = 0; let appointmentNotice;
    const { default: renderHostSettings } = load(`${directory}management/AIModelSettings/useHostAISetting.ts`, {
      '../../HostAIAppointmentDialog': load(`${directory}HostAIAppointmentDialog.ts`),
      '../../../AssistantNickname': load('src/features/assistants/AssistantNickname.ts', {
        './infrastructure/SQLiteAssistantRepository': { aiAssistantRepository: {} },
      }),
      react: { useCallback: (callback) => callback, useEffect() {},
        useState: (value) => [stateIndex++ === 1 ? false : value, () => {}] },
      '@shared/ui': { showAppDialog() {} },
      '../../../AIAssistantManagement': {
        getHostAIAssistant: async () => null,
        getHostAICooldownStatus: async () => ({ appointment: { isInCooldown: false, remainingDays: 0 } }),
        appointHostAIAssistant: async () => { appointmentCalls++; },
      },
    });
    const host = renderHostSettings({ aiAssistant: { ...profile, id: 'ai', name: '角色', nickname: '昵称' }, onUpdated: (patch) => updates.push(patch),
      onShowAlert: (title, message, buttons) => {
        if (buttons) {
          appointmentNotice = { title, message };
          confirmation = buttons.find((button) => button.style !== 'cancel').onPress;
        }
      } });
    await host.handleHostAIToggle(true);
    assert.equal(appointmentCalls, 0, '任命必须等待用户确认');
    assert.ok(appointmentNotice.title.includes('「昵称」'), '任命提醒沿用用户的昵称备注');
    assert.ok(appointmentNotice.message.includes('7 天'), '任命前必须告知撤销后的七天冷静期');
    assert.ok(appointmentNotice.message.includes('不会自动授予 Android 系统权限'), '任命提醒必须区分主理关系与系统授权');
    assert.ok(appointmentNotice.message.includes('保留历史记录'), '任命提醒必须区分未来日程废弃与历史保留');
    await confirmation();
    assert.equal(appointmentCalls, 1);
    assert.deepEqual(updates[1], { id: 'ai', isHostAI: true });
  }
  // 错误在输入框下方展示，边框变红且用户原输入保留；正常状态没有常驻反馈。
  {
    const theme = { spacing: { lg: 16, md: 8, sm: 4, xs: 2 }, radius: { md: 8 },
      colors: { surface: { input: '#fff' }, feedback: { error: '#e00' }, text: { primary: '#111', secondary: '#555', tertiary: '#888' } } };
    const react = { default: { createElement: (type, props, ...children) => typeof type === 'function'
      ? type({ ...props, children }) : { type, props: props ?? {}, children } },
      forwardRef: (render) => (props) => render(props, null) };
    const themeModule = { useTheme: () => theme, useThemedStyles: (factory) => factory(theme) };
    const native = { View: 'View', Text: 'Text', TextInput: 'TextInput', StyleSheet: { create: (styles) => styles } };
    const { default: InputField } = load('src/shared/ui/InputField.tsx', {
      react, '@shared/theme': themeModule,
      'react-native': native,
      './AppTextInput': load('src/shared/ui/AppTextInput.tsx', { react, '@shared/theme': themeModule, 'react-native': native }),
    });
    let blurred = false;
    const field = InputField({ value: '3', onChangeText() {}, onBlur: () => { blurred = true; }, error: '输入无效，尚未保存' });
    const input = field.children.find((child) => child?.type === 'TextInput');
    const message = field.children.find((child) => child?.type === 'Text');
    assert.equal(input.props.value, '3');
    assert.ok(input.props.style.flat(Infinity).some((style) => style?.borderColor === '#e00'));
    assert.deepEqual(message.children, ['输入无效，尚未保存']);
    assert.equal(message.props.accessibilityRole, 'alert');
    input.props.onBlur(); assert.equal(blurred, true);
    const { AutoSaveErrors } = load('src/shared/ui/AutoSaveErrors.tsx', {
      react, '@shared/theme': themeModule, './Button': { default: 'Button' }, 'react-native': { View: 'View', Text: 'Text' },
    });
    assert.equal(AutoSaveErrors({ error: null, blocked: false, retry() {}, restore() {} }), null);
  }
} finally { mock.timers.reset(); }
console.log('模型自动保存：失焦确认、立即字段隔离、增量、迟到确认、内联校验、失败重试、恢复与页面生命周期验证通过。');

// 网络边界验证真实请求正文：四种传输入口与连接测试使用相同关闭参数。
const baseURLModule = load('src/platform/ai/baseUrl.ts');
const baseClientModule = load('src/platform/ai/BaseAIClient.ts', {
  './HttpExchangeCapture': { beginAIHttpCapture: async () => null },
  './baseUrl': baseURLModule,
  './errorMapping': load('src/platform/ai/errorMapping.ts'),
});
const factory = load('src/platform/ai/OpenAIClient.ts', {
  './moonshotEndpoint': load('src/platform/ai/moonshotEndpoint.ts'),
  './BaseAIClient': baseClientModule,
  './KimiClient': { KimiClient: class extends baseClientModule.BaseAIClient {} },
  './modelDiscovery': {}, './errorMapping': {},
});
const connection = load('src/platform/ai/connectionTest.ts', { './OpenAIClient': factory });
let persistedAssistant = {
  ...profile, id: 'assistant-moonshot', agentId: 'actor-moonshot', name: 'Kimi',
  model: 'kimi-k2.5', apiBaseUrl: 'https://api.moonshot.cn/v1',
};
const hostStarts = [];
let hostRunSequence = 0;
let hostExecutions = 0;
let selectedChatTheme = 'daylight';
let hostReplyPolicy;
const chatThemeVariants = load('src/shared/theme/themeVariants.ts');
const chatReplyPolicy = load('src/features/chat/reply/application/ReplyPolicy.ts');
const hostCoordinatorModule = load('src/host/runtime/ConversationTurnCoordinator.ts', {
  '@shared/theme/themeStorage': { loadStoredThemeId: async () => selectedChatTheme },
  '@shared/theme/themeRegistry': { getThemeById: id => ({ id }) },
  '@shared/theme/themeVariants': chatThemeVariants,
  '@features/chat/composition': {
    conversationTurnRepository: {
      claimIfIdle: async (sessionId) => ({ runId: `settings-run-${++hostRunSequence}`, sessionId }),
      revoke: async () => { throw new Error('模型设置回归场景不应撤销回合'); },
      beginExecutionHostRequests: async () => [],
      finishExecutionHostRequests: async () => {},
    },
    sessionRepository: { getSession: async () => ({ aiAssistantId: persistedAssistant.id }) },
    executeUserReplyTurn: async ({ aiConfig }) => {
      hostExecutions++;
      hostReplyPolicy = chatReplyPolicy.resolveAIReplyPolicy(aiConfig, { triggerSource: 'chat' });
      const response = await factory.createAIClient({
        baseURL: aiConfig.apiBaseUrl, apiKey: aiConfig.apiKey, model: aiConfig.model,
        disableThinking: aiConfig.disableThinking,
      })[hostReplyPolicy.modelTransport === 'stream' ? 'chatStream' : 'chat']([{ role: 'user', content: '你好' }]);
      assert.equal(response.success, true);
      return 'committed';
    },
    isChatReplyRunCancellationError: () => false,
    emitChatTurnExecutionChanged() {},
    emitChatMessagesReloadRequested() {},
    emitChatTypingStatusChanged() {},
  },
  '@features/assistants': { aiAssistantRepository: { getById: async () => persistedAssistant } },
  '@platform/device': { startConversationTurnExecutionHost: async (sessionIds) => { hostStarts.push(sessionIds); return true; } },
  '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline() {} },
});
const originalFetch = global.fetch;
const requests = [];
global.fetch = async (_url, options) => {
  const body = JSON.parse(options.body); requests.push(body);
  const answer = { id: 'answer', choices: [{ message: { content: '完成', reasoning_content: '思考过程' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } };
  return body.stream
    ? new Response(`data: ${JSON.stringify({ id: 'answer', choices: [{ delta: { reasoning_content: '思考过程', content: '完成' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
    : Response.json(answer);
};
try {
  // 一次按钮操作只验证连接，不额外请求工具探测，也不改变用户授予的权限。
  const modelService = load('src/features/assistants/application/AIModelService.ts', { '@platform/ai': {
    ...factory, ...connection,
    detectParamError: () => ({ isParamError: false }),
    getErrorDisplayInfo: (error) => ({ message: String(error) }),
  } });
  const useConnectionTest = load(`${directory}management/AIModelSettings/useConnectionTest.ts`, {
    react: { useState: (initial) => [initial, () => {}], useCallback: (callback) => callback },
    '../../../application/AIModelService': modelService,
    '../sharedModelConfig': load(`${directory}management/sharedModelConfig.ts`, { '../../application/AIModelService': modelService }),
  }).default;
  for (const enabled of [false, true]) {
    let permission = enabled;
    const alerts = [];
    const before = requests.length;
    await useConnectionTest({
      apiBaseUrl: profile.apiBaseUrl, apiKey: profile.apiKey, selectedModel: profile.model,
      getConnectionParams: () => ({ maxTokens: 300 }),
      enableTools: enabled, setEnableTools: value => { permission = value; },
      onShowAlert: (...args) => alerts.push(args),
    }).handleTestConnection();
    assert.equal(requests.length, before + 1, '测试连接按钮只能发出一次生成请求');
    assert.equal(permission, enabled, '连接测试不能替用户改变工具权限');
    assert.equal(requests.at(-1).tools, undefined);
    assert.equal(requests.at(-1).max_tokens, 300);
    assert.equal(alerts[0][0], '连接成功');
  }
  // 连通性测试已经取得合法响应，思考截断不能成为第二次付费生成的理由。
  const normalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: '', reasoning_content: '未完成的思考' }, finish_reason: 'length' }] });
  };
  try {
    const before = requests.length;
    const result = await connection.testAPIConnection(profile.apiBaseUrl, profile.apiKey, profile.model, { maxTokens: 300 });
    assert.equal(result.success, true);
    assert.equal(requests.length, before + 1, '连通性测试不能为思考截断而重发');
    assert.equal(requests.at(-1).max_tokens, 300, '连接测试不能擅自扩大用户设定的输出额度');
  } finally { global.fetch = normalFetch; }
  // 留空与未配置均使用服务商默认；各传输入口与连接测试不得补值或发送 null。
  for (const sampling of [
    { temperature: null, topP: null }, {},
    { temperature: 0, topP: 0 }, { temperature: 0.6, topP: 0.95 },
    { temperature: null, topP: 0.95 }, { temperature: 1, topP: null },
  ]) {
    const baseURL = 'https://api.moonshot.cn/v1';
    const model = 'kimi-k2.6';
    for (const disableThinking of [false, true]) {
      const options = { ...sampling, disableThinking };
      const client = factory.createAIClient({ baseURL, apiKey: 'test-key', model, ...options });
      const messages = [{ role: 'user', content: '你好' }];
      for (const invoke of [
        () => client.chat(messages), () => client.chatWithTools(messages, []),
        () => client.chatStream(messages), () => client.chatStreamWithTools(messages, []),
        () => connection.testAPIConnection(baseURL, 'test-key', model, options),
      ]) {
        const result = await invoke();
        assert.equal(typeof result === 'boolean' ? result : result.success, true);
        const body = requests.at(-1);
        for (const [setting, field] of [['temperature', 'temperature'], ['topP', 'top_p']]) {
          if (sampling[setting] == null) {
            assert.equal(Object.hasOwn(body, field), false, '服务商默认参数必须从请求正文中省略');
          } else {
            assert.equal(body[field], sampling[setting], '显式数值包括 0 必须原样发送');
          }
        }
      }
    }
  }
  for (const [baseURL, model, parameter] of [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', { enable_thinking: false }],
    ['https://relay.example/v1', 'Qwen/Qwen3-32B', { enable_thinking: false }],
    ['https://api.deepseek.com/v1', 'deepseek-reasoner', { thinking: { type: 'disabled' } }],
    ['https://api.moonshot.cn/v1', 'kimi-k2.5', { thinking: { type: 'disabled' } }],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-4.7', { thinking: { type: 'disabled' } }],
    ['https://openrouter.ai/api/v1', 'qwen/qwen3-32b', { reasoning: { enabled: false } }],
  ]) {
    const client = factory.createAIClient({ baseURL, apiKey: 'test-key', model, disableThinking: true });
    const messages = [{ role: 'user', content: '你好' }];
    for (const invoke of [
      () => client.chat(messages), () => client.chatWithTools(messages, []),
      () => client.chatStream(messages), () => client.chatStreamWithTools(messages, []),
      () => connection.testAPIConnection(baseURL, 'test-key', model, { disableThinking: true }),
    ]) {
      const result = await invoke(); assert.equal(result.success, true);
      const body = requests.at(-1);
      const actual = Object.fromEntries(['enable_thinking', 'thinking', 'reasoning'].filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
      assert.deepEqual(actual, parameter, `${model} 必须向服务商请求关闭思考`);
    }
  }
  for (const [baseURL, model, parameter] of [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'kimi-k2.6', { enable_thinking: true }],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'glm-4.7', { enable_thinking: true }],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'deepseek-v4.1-flash', { enable_thinking: true }],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', { enable_thinking: true }],
    ['https://relay.example/v1', 'Qwen/Qwen3-32B', { enable_thinking: true }],
    ['https://api.moonshot.cn/v1', 'kimi-k2.5', { thinking: { type: 'enabled' } }],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-4.7', { thinking: { type: 'enabled' } }],
    ['https://openrouter.ai/api/v1', 'qwen/qwen3-32b', { reasoning: { enabled: true } }],
  ]) {
    const client = factory.createAIClient({ baseURL, apiKey: 'test-key', model, disableThinking: false });
    const messages = [{ role: 'user', content: '你好' }];
    for (const invoke of [
      () => client.chat(messages), () => client.chatWithTools(messages, []),
      () => client.chatStream(messages), () => client.chatStreamWithTools(messages, []),
      () => connection.testAPIConnection(baseURL, 'test-key', model, { disableThinking: false }),
    ]) {
      const result = await invoke(); assert.equal(result.success, true);
      const body = requests.at(-1);
      const actual = Object.fromEntries(['enable_thinking', 'thinking', 'reasoning'].filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
      assert.deepEqual(actual, parameter, `${model} 关闭开关必须明确开启思考，不能依赖服务商默认值`);
      if ('reasoningText' in result) assert.equal(result.reasoningText, '思考过程', '返回的思维链必须保留给下游展示');
    }
  }
  for (const [baseURL, model, disableThinking] of [
    ['https://example.com/v1', 'non-thinking', false],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen2.5-72b-instruct', false],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-32b-instruct', false],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'Moonshot-Kimi-K2-Instruct', false],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'glm-4-flash', false],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'kimi-k2.6', undefined],
    ['https://api.moonshot.cn/v1', 'kimi-k2.5', undefined],
  ]) {
    const client = factory.createAIClient({ baseURL, apiKey: 'test-key', model, disableThinking });
    await client.chat([{ role: 'user', content: '你好' }]);
    for (const key of ['enable_thinking', 'thinking', 'reasoning']) assert.equal(Object.hasOwn(requests.at(-1), key), false, '未选择关闭时非思考模型及已有配置的请求不变');
  }
  // 普通聊天委派后不携带页面模型配置，生产单例必须从持久角色重新读取关闭选择。
  const hostCoordinator = hostCoordinatorModule.getConversationTurnCoordinator();
  for (const themeId of ['paper-note', 'moon-kimi', 'daylight']) {
    selectedChatTheme = themeId;
    persistedAssistant = { ...persistedAssistant, allowMultipleBubbles: true };
    await hostCoordinator.onCanonicalUserMessageCommitted({
      sessionId: 'theme-session', executionMode: 'delegate_to_android_host', aiConfig: persistedAssistant,
    });
    assert.equal(await hostCoordinator.executeTurnFromHost('theme-session'), 'executed');
    const streaming = themeId !== 'daylight';
    assert.equal(hostReplyPolicy.modelTransport, streaming ? 'stream' : 'complete', `${themeId} 宿主传输策略`);
    assert.equal(hostReplyPolicy.bubbleDeliveryMode, streaming ? 'single-bubble' : 'multi-bubble', `${themeId} 宿主分段策略`);
    assert.equal(Boolean(requests.at(-1).stream), streaming, '实际网络请求必须使用主题选择的传输');
  }
  for (const disableThinking of [true, false]) {
    persistedAssistant = { ...persistedAssistant, disableThinking };
    const beforeExecution = hostExecutions;
    const beforeRequest = requests.length;
    await hostCoordinator.onCanonicalUserMessageCommitted({
      sessionId: 'moonshot-session', executionMode: 'delegate_to_android_host',
      aiConfig: { ...persistedAssistant, disableThinking: !disableThinking },
    });
    assert.equal(hostExecutions, beforeExecution, '页面提交只启动宿主，不执行模型');
    assert.deepEqual(hostStarts.at(-1), ['moonshot-session']);
    assert.equal(await hostCoordinator.executeTurnFromHost('moonshot-session'), 'executed');
    assert.equal(hostExecutions, beforeExecution + 1);
    assert.equal(requests.length, beforeRequest + 1);
    if (disableThinking) {
      assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' }, '宿主重读角色后必须把关闭选择传到 Moonshot 请求');
    } else {
      assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' }, '重新开启后宿主必须明确请求思考');
    }
  }
  // 自动摘要与角色聊天共用持久参数，关闭思考后也不能重新发送本地默认温度。
  let summaryAssistant = { ...profile, id: 'assistant-summary', name: 'Kimi', apiBaseUrl: 'https://api.moonshot.cn/v1' };
  let summaryRuntime;
  const summaryComposition = load('src/host/composition/configureChatSummaryRuntime.ts', {
    '@features/assistants': { aiAssistantRepository: { getById: async () => summaryAssistant } },
    './chatSummaryRepository': { chatSummaryRepository: {} },
    '@features/prompting': { resolveChatSummaryPromptOverride: async () => undefined },
    '@features/profile': { userProfileRepository: {} },
    '@features/protocol': { protocolRepository: {} },
    '@features/chat': { getChatSummarySettings: async () => ({ modelConfigId: null }) },
    '@shared/aiTools': { ToolContext: class {} },
    '@features/calls/composition': { callRepository: {} },
    '@features/chat/composition': {
      configureChatSummaryRuntime: (runtime) => { summaryRuntime = runtime; },
      SQLiteChatSummaryRepository: class {},
      sessionRepository: { getSession: async () => ({ aiAssistantId: summaryAssistant.id }) },
      groupChatRepository: { getById: async () => null },
      createChatSummaryPromptBlock: () => ({}), buildChatSummaryModelInput: () => '摘要输入',
    },
    '@host/prompt': { assembleResolvedSummaryPromptPack: async () => ({ systemPrompt: '摘要规则', modelMessages: [{ role: 'user', content: '摘要输入' }] }) },
    './agent/createAgentToolRegistry': {
      resolveAllowedToolNames: async () => [], getRuntimeAllowedToolNamesForAI: () => [],
      createAgentToolRegistry: () => ({}), getToolPackageRuntimeBindings: () => ({}),
      readDirectToolNamesForHostRun: async () => [], buildToolsDescription: () => '',
    },
    './agent/ToolPackageExposure': { registerToolPackagesForHostRun: () => ({ instructions: () => ({ catalog: '' }) }) },
    './agent/registerMcpToolsForHostRun': { resolveMcpExposure: async () => ({ allowedToolNames: [] }) },
    '@platform/ai': factory,
    '../runtime/ChatSummaryQueueCoordinator': { configureChatSummaryQueue() {} },
    '../prompt/PromptPackBlockFactory': { promptPackBlockFactory: { createPersonaBlock: () => ({}) } },
  });
  summaryComposition.configureChatSummary();
  for (const disableThinking of [true, false]) {
    summaryAssistant = { ...summaryAssistant, model: 'kimi-k2.6', temperature: null, topP: null, disableThinking };
    assert.equal(await summaryRuntime.generateAddition({ conversationId: 'summary-session' }, new AbortController().signal,
      async () => {}, { requestTimeoutSeconds: 300, maxOutputTokens: null, modelConfigId: null }), '完成');
    assert.equal(requests.at(-1).model, 'kimi-k2.6');
    assert.equal(Object.hasOwn(requests.at(-1), 'temperature'), false);
    assert.equal(Object.hasOwn(requests.at(-1), 'top_p'), false);
    if (disableThinking) assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });
    else assert.deepEqual(requests.at(-1).thinking, { type: 'enabled' });
  }
} finally { global.fetch = originalFetch; }
console.log('思考开关：显式开启与关闭、流式、非流式、工具请求、连接测试、普通聊天宿主和非思考模型验证通过。');
