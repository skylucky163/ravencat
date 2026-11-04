/** 生效来源复用通用选择器，代理使用通用开关；配置列表、异步操作与玻璃表面遵守同一产品流程。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';

const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(relative, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    assert.ok(Object.hasOwn(dependencies, id), `未装配依赖：${id}`);
    return dependencies[id];
  }, module, module.exports);
  return module.exports;
}
const domain = load('src/features/webTools/domain/SearchSettings.ts');
let configuration = { defaultEngine: 'bing', allowAdvanced: false, connectionMode: 'direct', customConfigured: false,
  sources: domain.SEARCH_SOURCES.map(source => ({ engine: source.engine, enabled: !source.needsKey, configured: !source.needsKey, apiKey: '' })) };
const changes = [];
const listeners = new Set();
const notify = () => { for (const listener of listeners) listener(); };
let releaseTest;
let testSignal;
const theme = {
  colors: { brand: { primary: '#123' }, text: { primary: '#111', secondary: '#333', tertiary: '#666' },
    background: { screen: '#eee', app: '#fff' }, surface: { default: '#fff', overlay: '#0008' },
    border: { light: '#ddd' }, feedback: { error: '#f00' } },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 }, radius: { lg: 12 },
  effects: { glass: { enabled: false, backgroundColor: '#ffffff20', cornerRadius: 12 } },
};
const native = Object.fromEntries(['ActivityIndicator', 'ScrollView', 'Text', 'View', 'Pressable'].map(name => [name, name]));
native.StyleSheet = { create: value => value, hairlineWidth: 0.5 };
const themed = { useTheme: () => theme, useThemedStyles: factory => factory(theme) };
themed.ThemedSurface = load('src/shared/theme/components/ThemedSurface.tsx', {
  'react-native': native, '../useTheme': themed, './GlassSurface': { GlassSurface: 'GlassSurface' },
}).ThemedSurface;
const icons = { ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight', Check: 'Check' };
const ToggleField = load('src/shared/ui/ToggleField.tsx', {
  'react-native': native, '@shared/theme': themed, './Toggle': { default: 'Toggle', __esModule: true },
}).default;
const ConfiguredModelPicker = load('src/shared/ui/ConfiguredModelPicker.tsx', {
  'react-native': native, '@shared/theme': themed, 'lucide-react-native': icons,
  './appDialogStore': { showAppDialog() {} },
  // 选择器把弹窗内容交给 ModelPickerModal；替身只保留“列出模型 / 取消选择”这一层。
  './ModelPickerModal': { __esModule: true, default: ({ visible, models = [], onSelect, onClear, clearSelectionLabel, onClose }) => visible
    ? React.createElement('Sheet', null, [
      ...models.map(model => React.createElement('Pressable', {
        key: model.id, onPress: () => { onSelect(model.id); onClose(); },
      }, React.createElement('Text', null, model.name))),
      onClear ? React.createElement('Pressable', {
        key: 'clear', onPress: () => { onClear(); onClose(); },
      }, React.createElement('Text', null, clearSelectionLabel)) : null,
    ])
    : null },
}).default;
let selectionReads = 0;
const configurationApi = {
  readSearchConfiguration: async () => structuredClone(configuration),
  readSearchSelection: async () => {
    selectionReads += 1;
    return {
      models: domain.SEARCH_SOURCES.filter(source => configuration.sources.find(item => item.engine === source.engine).configured)
        .map(source => ({ id: source.engine, name: source.name, model: source.needsKey ? '已配置' : '内置来源' })),
      selectedModelId: configuration.defaultEngine,
      selectedModelName: domain.SEARCH_SOURCES.find(source => source.engine === configuration.defaultEngine)?.name ?? null,
      status: configuration.defaultEngine === null ? 'unconfigured'
        : configuration.sources.find(source => source.engine === configuration.defaultEngine).configured ? 'active' : 'unavailable',
      unavailableReason: '请重新配置 API Key',
    };
  },
  subscribeSearchConfigurationChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  selectSearchSource: async engine => { configuration.defaultEngine = engine; changes.push({ kind: 'default', engine }); notify(); },
  updateSearchConfiguration: async change => {
    changes.push(change);
    if (change.kind === 'advanced') configuration.allowAdvanced = change.allowed;
    if (change.kind === 'connection') configuration.connectionMode = change.mode;
    notify();
  },
  testAndSaveSearchKey: async (engine, key, signal) => {
    testSignal = signal;
    changes.push({ engine, key });
    await new Promise(resolve => { releaseTest = resolve; });
    signal.throwIfAborted();
    Object.assign(configuration.sources.find(source => source.engine === engine), { configured: true, enabled: true, apiKey: key });
    if (!configuration.customConfigured) { configuration.defaultEngine = engine; configuration.customConfigured = true; }
    notify();
  },
};
const Screen = load('src/features/webTools/presentation/WebSearchSettingsScreen.tsx', {
  'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' }, 'lucide-react-native': icons,
  '@shared/theme': themed,
  '@shared/ui': { Button: 'Button', ConfiguredModelPicker, InputField: 'InputField', KeyboardAvoidingContainer: 'Avoiding', ListItem: 'ListItem', ToggleField, showAppDialog() {} },
  '@shared/ui/NavigationHeader': { default: 'Header', __esModule: true }, '../domain/SearchSettings': domain,
  './searchSettingsStyles': load('src/features/webTools/presentation/searchSettingsStyles.ts', { 'react-native': native }),
  '../application/SearchConfiguration': configurationApi,
}).default;
let rendered;
const screenProps = { onBack() {} };
await act(async () => { rendered = create(React.createElement(Screen, screenProps)); });
const field = label => rendered.root.findAllByType('InputField').find(node => node.props.label === label);
const toggle = label => rendered.root.findAllByType('Toggle').find(node => node.props.accessibilityLabel === label);
const source = title => rendered.root.findAllByType('ListItem').find(node => node.props.title === title);
const button = title => rendered.root.findAllByType('Button').find(node => node.props.title === title);
const picker = () => rendered.root.findByProps({ accessibilityLabel: '选择搜索来源' });
async function select(name) {
  await act(async () => picker().props.onPress());
  const option = rendered.root.findByType('Sheet').findAllByType('Pressable')
    .find(node => node.findAllByType('Text').some(text => text.props.children === name));
  assert.ok(option, `选择器提供 ${name}`);
  const before = selectionReads;
  await act(async () => option.props.onPress());
  return selectionReads - before;
}
assert.equal(rendered.root.findByType('Header').props.title, '联网搜索');
assert.equal(rendered.root.findAllByType('Avoiding').length, 1);
assert.deepEqual(rendered.root.findAllByType('ListItem').map(node => node.props.title), ['Bing', 'DuckDuckGo', 'Tavily', 'Brave Search']);
assert.equal(source('Bing').props.onPress, undefined);
assert.equal(source('DuckDuckGo').props.onPress, undefined);
assert.equal(rendered.root.findAllByType('InputField').length, 0, '密钥配置初始折叠');
assert.deepEqual(rendered.root.findAllByType('Toggle').map(node => node.props.accessibilityLabel), ['系统代理']);
assert.equal(rendered.root.findAllByType('Text').filter(node => ['联网搜索', '联网服务'].includes(node.props.children)).length, 0);
assert.equal(await select('DuckDuckGo'), 1, '自身选择只刷新一次，不重复读取通知与显式刷新');
assert.deepEqual(changes.at(-1), { kind: 'default', engine: 'duckduckgo' });
assert.equal(configuration.defaultEngine, 'duckduckgo');
const beforeExternalRead = selectionReads;
await act(async () => toggle('系统代理').props.onValueChange(true));
assert.equal(selectionReads, beforeExternalRead + 1, '外部配置变更仍刷新选择器');
assert.deepEqual(changes.at(-1), { kind: 'connection', mode: 'system' });
assert.equal(toggle('系统代理').props.value, true);
await act(async () => toggle('系统代理').props.onValueChange(false));
assert.equal(toggle('系统代理').props.value, false);
const beforeExpand = changes.length;
await act(async () => source('Tavily').props.onPress());
assert.equal(changes.length, beforeExpand, '展开配置不切换生效来源');
assert.notEqual(field('Tavily API Key').props.secureTextEntry, true);
await act(async () => field('Tavily API Key').props.onChangeText('user-key'));
await act(async () => source('Brave Search').props.onPress());
assert.equal(field('Tavily API Key'), undefined);
assert.notEqual(field('Brave Search API Key').props.secureTextEntry, true);
await act(async () => source('Tavily').props.onPress());
assert.equal(field('Tavily API Key').props.value, 'user-key', '切换卡片保留未保存输入');
await act(async () => button('测试并保存').props.onPress());
assert.equal(picker().props.disabled, true);
assert.equal(toggle('系统代理').props.disabled, true);
assert.equal(field('Tavily API Key').props.editable, false);
await act(async () => { releaseTest(); });
assert.equal(field('Tavily API Key').props.value, 'user-key');
assert.equal(source('Tavily').props.subtitle, '已配置');
await select('Tavily');
assert.equal(configuration.defaultEngine, 'tavily');
await act(async () => toggle('允许 Tavily 深度搜索').props.onValueChange(true));
assert.equal(toggle('允许 Tavily 深度搜索').props.value, true);

// 同一选择器、开关与配置列表在玻璃主题下使用真实主题表面，输入状态不会丢失。
theme.effects.glass.enabled = true;
await act(async () => rendered.update(React.createElement(Screen, { ...screenProps, refreshRevision: 1 })));
assert.ok(rendered.root.findAllByType('GlassSurface').length > 0);
assert.equal(field('Tavily API Key').props.value, 'user-key');
assert.equal(toggle('系统代理').props.value, false);
await act(async () => rendered.unmount());
assert.equal(listeners.size, 0);
await act(async () => { rendered = create(React.createElement(Screen, screenProps)); });
await act(async () => source('Tavily').props.onPress());
assert.equal(field('Tavily API Key').props.value, 'user-key', '重新进入回填已保存密钥');
await act(async () => source('Brave Search').props.onPress());
await act(async () => field('Brave Search API Key').props.onChangeText('another-key'));
await act(async () => button('测试并保存').props.onPress());
await act(async () => rendered.unmount());
assert.equal(testSignal.aborted, true);
await act(async () => { releaseTest(); });
assert.equal(configuration.sources.find(source => source.engine === 'brave').configured, false, '离页取消未完成测试');
assert.equal(listeners.size, 0);

Object.assign(configuration.sources.find(source => source.engine === 'tavily'), { configured: false, apiKey: '' });
await act(async () => { rendered = create(React.createElement(Screen, screenProps)); });
assert.ok(rendered.root.findAllByType('Text').some(node => String(node.props.children).includes('请重新配置 API Key')));
await act(async () => source('Tavily').props.onPress());
assert.equal(field('Tavily API Key').props.value, '');
await select('Bing');
assert.equal(configuration.defaultEngine, 'bing', '凭据缺失时可直接改选内置来源');
await select('取消选择');
assert.equal(configuration.defaultEngine, null);
assert.ok(rendered.root.findAllByType('Text').some(node => node.props.children === '未选择搜索来源'));
await act(async () => rendered.unmount());
console.log('联网搜索页面：通用生效选择器、二元系统代理、四来源列表、折叠配置、输入保留、离页取消与玻璃主题通过。');
