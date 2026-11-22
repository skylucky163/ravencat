/** 管理员配置行为：非法数值可见、合法字段独立保存、确认不覆盖输入。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import ts from 'typescript';


function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `${file} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const { AutoSaveDraftEditor } = load('src/shared/ui/AutoSaveDraftEditor.ts');
const numbers = load('src/shared/ui/draftValidation.ts');
const draftModule = load('src/features/chat/presentation/group/groupAdminSettingsDraft.ts', { '@shared/ui/draftValidation': numbers });
const config = { apiBaseUrl: 'https://example.invalid/v1', apiKey: 'key', model: 'admin', temperature: 0.7, topP: 1, maxTokens: 2000, contextMessageCount: 20 };
const initial = draftModule.getGroupAdminSettingsDraft(config);
const tick = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

mock.timers.enable({ apis: ['setTimeout'] });
try {
  for (const [key, invalidValues] of Object.entries({
    tempInput: ['abc', 'NaN', '-0.1', '2.1'], topPInput: ['-1', '1.1'],
    maxTokens: ['0', '-1', '1.5', '3abc'], contextMessageCount: ['', '-1', '101', '1.5', 'NaN'],
  })) {
    for (const invalid of invalidValues) {
      const writes = [];
      const editor = new AutoSaveDraftEditor(initial, draftModule.parseGroupAdminSettingsDraft, async (patch) => { writes.push(patch); });
      editor.change({ [key]: invalid, selectedModel: 'other-model' });
      await editor.commit();
      assert.ok(editor.getSnapshot().errors[key], `${key}=${invalid} 必须显示字段错误`);
      assert.equal(editor.getSnapshot().draft[key], invalid, '无效输入不能静默回填默认值');
      assert.deepEqual(writes, [{ model: 'other-model' }], '其他合法字段可以独立保存');
      assert.equal(await editor.flush(), false, '无效草稿应阻止离开');
      await editor.restore(); assert.equal(await editor.flush(), true);
    }
  }
  {
    const writes = [];
    const editor = new AutoSaveDraftEditor(initial, draftModule.parseGroupAdminSettingsDraft, async (patch) => { writes.push(patch); });
    editor.change({ tempInput: '', topPInput: ' ' });
    assert.equal(await editor.flush(), true);
    assert.deepEqual(writes, [{ temperature: null, topP: null }]);
    const reopened = draftModule.getGroupAdminSettingsDraft({ ...config, ...writes[0] });
    assert.equal(reopened.tempInput, '');
    assert.equal(reopened.topPInput, '');
    assert.equal(draftModule.getGroupAdminSettingsDraft().tempInput, '');
    assert.equal(draftModule.getGroupAdminSettingsDraft().topPInput, '');
    editor.change({ tempInput: '0', topPInput: '0' });
    assert.equal(await editor.flush(), true);
    assert.deepEqual(writes.at(-1), { temperature: 0, topP: 0 });
  }
  for (const count of ['0', '100']) {
    const result = draftModule.parseGroupAdminSettingsDraft({ ...initial, contextMessageCount: count }, ['contextMessageCount']);
    assert.deepEqual(result.patch, { contextMessageCount: Number(count) });
    assert.deepEqual(result.errors, {});
  }
  assert.deepEqual(draftModule.parseGroupAdminSettingsDraft({ ...initial, maxTokens: '', apiKey: '' }, ['maxTokens', 'apiKey']).patch,
    { maxTokens: null, apiKey: null });
  assert.equal(draftModule.getGroupAdminSettingsDraft({ ...config, maxTokens: null }).maxTokens, '');
  assert.equal(draftModule.getGroupAdminSettingsDraft().maxTokens, '');
  assert.ok(draftModule.parseGroupAdminSettingsDraft({ ...initial, selectedModel: '' }, ['selectedModel']).errors.selectedModel);
  {
    const first = deferred(); const writes = [];
    const editor = new AutoSaveDraftEditor(initial, draftModule.parseGroupAdminSettingsDraft, async (patch) => {
      writes.push(patch); if (writes.length === 1) await first.promise;
    });
    editor.change({ apiKey: 'A' }, true); await tick();
    editor.change({ apiKey: 'B' });
    first.resolve(); await tick();
    assert.equal(editor.getSnapshot().draft.apiKey, 'B');
    assert.deepEqual(writes, [{ apiKey: 'A' }]);
    mock.timers.tick(10000); await tick(); assert.deepEqual(writes, [{ apiKey: 'A' }]);
    await editor.commit(); assert.deepEqual(writes, [{ apiKey: 'A' }, { apiKey: 'B' }]);
  }
  // 页面 hook 的数值投影不会把非法文本送入滑块，测试连接也先展示字段错误。
  {
    let editor; let save; let stateIndex = 0; const state = []; const writes = []; let revealed; let returned = 0; let tested = 0; let testOptions;
    const react = {
      useCallback: (callback) => callback, useMemo: (factory) => factory(),
      useState: (initialValue) => {
        const index = stateIndex++;
        if (!(index in state)) state[index] = initialValue;
        return [state[index], (value) => { state[index] = value; }];
      },
    };
    const { default: renderHook } = load('src/features/chat/presentation/group/useGroupAdminSettings.ts', {
      react, './groupAdminSettingsDraft': draftModule, '@shared/ui/draftValidation': numbers,
      '@shared/ui/useAutoSaveDraft': {
        useAutoSaveDraft: (options) => {
          save = options.save;
          if (!editor) editor = new AutoSaveDraftEditor(options.initial, options.parse, (patch) => save(patch));
          return { ...editor.getSnapshot(), change: editor.change, commit: editor.commit, flush: editor.flush, restore: editor.restore, getSnapshot: editor.getSnapshot, validateAll: editor.validateAll };
        },
        useAutoSaveNavigation: (flush, back, blocked) => ({ back: async () => { if (await flush()) back(); else blocked(); } }),
      },
      '@shared/ui/useAutoSaveFeedback': { useAutoSaveFeedback: () => ({ setBlocked() {}, revealErrors: (errors) => { revealed = errors; } }) },
      '@features/assistants': {
        runConnectionTestByConfig: async ({ requestOptions }) => { tested++; testOptions = requestOptions; return { success: true, errorInfo: null }; },
        fetchModelsWithConfig: async () => ({ models: [], errorInfo: null }),
      },
    });
    const render = () => {
      stateIndex = 0;
      return renderHook({ adminConfig: config, onUpdate: async (patch) => { writes.push(patch); }, onBack: () => { returned++; } });
    };
    render().handleTempChange('3'); await render().commit();
    assert.ok(render().errors.tempInput); assert.equal(render().temperature, 0.7);
    await render().handleTestConnection(); assert.equal(tested, 0); assert.ok(revealed.tempInput);
    await render().back(); assert.equal(returned, 0);
    render().handleTempChange('1.2', true); await tick();
    assert.deepEqual(writes, [{ temperature: 1.2 }]);
    assert.equal(returned, 0, '正常保存留在当前页面');
    render().handleTempChange('', true); render().handleTopPChange('', true); await tick();
    render().handleMaxTokensChange('');
    assert.equal(render().temperature, null);
    assert.equal(render().topP, null);
    await render().handleTestConnection();
    assert.equal(tested, 1);
    assert.equal(testOptions.temperature, null);
    assert.equal(testOptions.topP, null);
    assert.equal(testOptions.maxTokens, null);
    await render().back(); assert.equal(returned, 1);
  }
  // 数字区域把错误显示在输入下方，保留错误文本且边框变红。
  {
    const react = { default: { createElement: (type, props, ...children) => ({ type, props, children }) } };
    const theme = { spacing: { md: 12, sm: 8 }, colors: { feedback: { error: '#e00' } } };
    const { default: NumberSection } = load('src/features/chat/presentation/group/NumberInputPresetsSection.tsx', {
      react, 'react-native': { View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'Button' },
      '@shared/theme': { useTheme: () => theme, useThemedStyles: (factory) => factory(theme) },
      '@shared/ui': { AppTextInput: 'TextInput' },
      '@features/assistants': { createModelSettingsStyles: () => ({ paramInput: { borderWidth: 1 } }) },
    });
    const section = NumberSection({ label: '上下文', value: '101', error: '需要 0～100 的整数', onChangeText() {}, presets: [] });
    const input = section.children[0].children[1];
    assert.equal(input.props.value, '101');
    assert.ok(input.props.style.some((style) => style?.borderColor === '#e00'));
    assert.deepEqual(section.children[1].children, ['需要 0～100 的整数']);
    assert.equal(section.children[1].props.accessibilityRole, 'alert');
  }
  // 完整管理员页面必须把字段错误传到真实输入区域，不能只在 hook 中计算错误。
  {
    const theme = { spacing: { lg: 16, md: 12, sm: 8 }, radius: { md: 8 }, colors: {
      feedback: { error: '#e00' }, text: { primary: '#111', secondary: '#444' }, border: { light: '#eee', default: '#ddd' },
      background: { app: '#fff' }, brand: { primary: '#66f' },
    } };
    const react = { useState: (initial) => [initial, () => {}], useCallback: (callback) => callback, default: {
      useMemo: (factory) => factory(),
      createElement: (type, props, ...children) => typeof type === 'function'
        ? type({ ...props, children }) : { type, props: props ?? {}, children },
    } };
    const native = { View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'Button', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView', StyleSheet: { create: (styles) => styles } };
    const themed = { useTheme: () => theme, useThemedStyles: (factory) => factory(theme) };
    const styleModule = { createModelSettingsStyles: () => ({ paramInput: { borderWidth: 1 } }) };
    const { default: NumberSection } = load('src/features/chat/presentation/group/NumberInputPresetsSection.tsx', {
      react, 'react-native': native, '@shared/theme': themed, '@features/assistants': styleModule,
      '@shared/ui': { AppTextInput: 'TextInput' },
    });
    const { default: ParameterSection } = load('src/shared/ui/SliderField.tsx', {
      react, 'react-native': native, '@shared/theme': themed, './Slider': { default: 'Slider' },
      './AppTextInput': { default: 'TextInput' },
    });
    const errors = { tempInput: 'Temperature 超出范围', maxTokens: 'Max Tokens 必须为正整数', contextMessageCount: '上下文不能超过100' };
    const { default: Page } = load('src/features/chat/presentation/group/GroupAdminSettings.tsx', {
      react, 'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
      '@shared/theme': themed, '@shared/ui/NavigationHeader': { default: 'Header' },
      '@shared/ui': { ModelPickerModal: 'Picker', Button: 'Button', InputField: 'InputField', SliderField: ParameterSection },
      '@shared/ui/commonStyles': { createCommonStyles: () => ({}) },
      '@shared/ui/AutoSaveErrors': { AutoSaveErrors: () => null },
      '@features/assistants': { ModelSection: 'Models' },
      './NumberInputPresetsSection': { default: NumberSection },
      './useGroupAdminSettings': { default: () => ({
        ...initial, tempInput: '3', maxTokens: '-1', contextMessageCount: '101', temperature: 0.7, topP: 1,
        errors, saveError: null, connectionError: null, availableModels: [],
        feedback: { blocked: false, scrollRef: {}, fieldLayout: () => () => {} },
      }) },
    });
    const nodes = [];
    function visit(value) {
      if (Array.isArray(value)) { for (const child of value) visit(child); }
      else if (value && typeof value === 'object') { nodes.push(value); visit(value.children); }
    }
    visit(Page({ adminConfig: config, onUpdate: async () => {} }));
    for (const text of Object.values(errors)) assert.ok(nodes.some((node) => node.type === 'Text' && node.children.includes(text)));
    for (const value of ['3', '-1', '101']) {
      const input = nodes.find((node) => node.type === 'TextInput' && node.props.value === value);
      assert.ok(input.props.style.some((style) => style?.borderColor === '#e00'));
    }
    assert.ok(nodes.filter((node) => node.type === 'Button').every((node) => node.props.title !== '保存'));
    assert.ok(nodes.some((node) => node.type === 'Text' && node.children.includes('留空使用服务商默认值。')));
    assert.ok(nodes.every((node) => !node.children.includes('2000') && !node.children.includes('服务商默认')));
  }
} finally { mock.timers.reset(); }
console.log('管理员自动保存：无效数值红字与红框、增量提交、迟到确认、测试连接和离开拦截验证通过。');
