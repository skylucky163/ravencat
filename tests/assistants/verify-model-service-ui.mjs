/** 多 Key 的真实 React 表单、分组选择与迟到模型列表回归，不冻结源码形状。 */
import { repoRoot as root } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url), React = require('react'), renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(file, dependencies = {}, cache = new Map()) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} }; cache.set(absolute, module.exports);
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    const target = name.startsWith('.') ? path.resolve(path.dirname(absolute), name)
      : name.startsWith('@shared/') ? path.join(root, 'src/shared', name.slice(8)) : null;
    const source = target && ['.ts','.tsx'].map(suffix => target + suffix).find(candidate => fs.existsSync(candidate));
    if (source) return load(source, dependencies, cache);
    throw new Error(`${file} 缺少依赖 ${name}`);
  }, module, module.exports);
  cache.set(absolute, module.exports); return module.exports;
}
const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'Spinner', Pressable: 'Pressable',
  StyleSheet: { create: styles => styles, hairlineWidth: 1 },
  AppState: { addEventListener: () => ({ remove() {} }) }, BackHandler: { addEventListener: () => ({ remove() {} }) } };
const pickerNative = { ...native, FlatList: ({ data, renderItem, ListEmptyComponent }) => React.createElement('Connections', null,
  data.length ? data.map(item => React.createElement('ConnectionGroup', { key: item.id }, renderItem({ item }))) : ListEmptyComponent) };
const pickerIcons = { Check: 'Check', ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight', Plus: 'Plus' };
const theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const dialogs = [];
const shared = Object.fromEntries(['Button','DropdownField','InputField','KeyboardAvoidingContainer','NavigationHeader'].map(name => [name,name]));
shared.showAppDialog = options => dialogs.push(options);
shared.NavigationHeader = function NavigationHeader({ rightButton, ...props }) { return React.createElement('NavigationHeader', props, rightButton); };
const dependencies = {
  'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, '@shared/ui': shared,
  '@shared/theme': { ThemedSurface: 'Surface', useTheme: () => theme }, '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'AutoSaveErrors' },
  '@shared/ui/useAutoSaveFeedback': { useAutoSaveFeedback: () => ({ scrollRef: null, blocked: false, setBlocked() {}, revealErrors() {} }) },
  '../../ModelServiceErrors': { modelServiceFailureMessage: () => '本次操作失败，输入已保留。' },
};
dependencies['@shared/ui/useAutoSaveDraft'] = load('src/shared/ui/useAutoSaveDraft.ts', { 'react-native': native, 'expo-router': { useFocusEffect: React.useEffect } });
const formPath = 'src/features/assistants/presentation/auxiliaryModels/ModelServiceEditScreen.tsx';
const act = renderer.act;
const fields = screen => screen.root.findAllByType('InputField');
const button = (screen, title) => screen.root.findAllByType('Button').find(node => node.props.title === title);
for (const themeFile of ['defaultLight', 'defaultDark', 'liquidGlass', 'moonKimi', 'paperNote']) {
  const formTheme = Object.values(load(`src/shared/theme/themes/${themeFile}.ts`))[0];
  const { ThemedSurface } = load('src/shared/theme/components/ThemedSurface.tsx', {
    'react-native': native,
    '../useTheme': { useTheme: () => formTheme },
    './GlassSurface': { GlassSurface: 'GlassMaterial' },
  });
  const Form = load(formPath, { ...dependencies,
    '@shared/theme': { useTheme: () => formTheme, ThemedSurface },
    '../../ModelServices': { createModelServiceGroupConfig: async () => ({ refreshWarning: null }) },
  }).default;
  let screen;
  await act(async () => { screen = renderer.create(React.createElement(Form, { onBack() {} })); });
  assert.notEqual(formTheme.colors.surface.input, formTheme.colors.surface.default, `${themeFile} 的输入与内容面使用不同底色`);
  assert.equal(screen.root.findAllByType('GlassMaterial').length, formTheme.effects.glass.enabled ? 1 : 0);
  await act(async () => button(screen, '＋ 添加 API Key').props.onPress());
  assert.equal(screen.root.findAllByType('GlassMaterial').length, formTheme.effects.glass.enabled ? 1 : 0, '增加 Key 仍由整张表单拥有唯一玻璃材质');
  await act(async () => screen.unmount());
}
{
  const created = []; let screen;
  const Form = load(formPath, { ...dependencies, '../../ModelServices': { createModelServiceGroupConfig: async input => { created.push(input); return { refreshWarning: null }; } } }).default;
  await act(async () => { screen = renderer.create(React.createElement(Form, { onBack() {} })); });
  assert.deepEqual(fields(screen).map(field => field.props.label), ['配置名称','Base URL','Key 名称（选填）','API Key']);
  await act(async () => button(screen, '创建').props.onPress()); assert.equal(created.length, 0);
  await act(async () => button(screen, '＋ 添加 API Key').props.onPress());
  await act(async () => button(screen, '＋ 添加 API Key').props.onPress());
  assert.deepEqual(fields(screen).filter(field => field.props.label === 'Key 名称（选填）').map(field => field.props.placeholder), ['1','2','3']);
  await act(async () => screen.root.findAllByType('Button').filter(node => node.props.title === '移除此 Key')[1].props.onPress());
  assert.deepEqual(fields(screen).filter(field => field.props.label === 'Key 名称（选填）').map(field => field.props.placeholder), ['1','3']);
  for (const [label,value] of [['配置名称','中转站'],['Base URL','https://relay.invalid/v1']]) {
    await act(async () => fields(screen).find(field => field.props.label === label).props.onChangeText(value));
  }
  await act(async () => fields(screen).filter(field => field.props.label === 'API Key')[0].props.onChangeText(' key-a '));
  await act(async () => fields(screen).filter(field => field.props.label === 'API Key')[1].props.onChangeText('key-c'));
  await act(async () => button(screen, '创建').props.onPress());
  assert.equal(created.length, 1); assert.deepEqual(created[0].keys.map(key => [key.name,key.ordinal,key.apiKey]), [['',1,'key-a'],['',3,'key-c']]);
  await act(async () => screen.unmount());
}
const keyA = { id: 'key-a', groupId: 'group', name: '中转站', keyName: '语音', ordinal: 1, baseUrl: 'https://relay.invalid/v1', apiKey: 'private-a', authType: 'apiKey', credentialsJson: '{}' };
const keyB = { ...keyA, id: 'key-b', keyName: '识图', ordinal: 2, apiKey: 'private-b' };
const group = { id: 'group', name: '中转站', baseUrl: keyA.baseUrl, authType: 'apiKey', keys: [keyA,keyB], nextKeyOrdinal: 3 };
{
  const writes = [], deleted = []; let screen, releaseCreate;
  const commands = {
    getModelServiceGroupConfig: async () => group,
    updateModelServiceGroupConfig: async () => ({ group, refreshWarning: null }),
    saveModelServiceKeyConfig: async (groupId, id, patch) => {
      writes.push({ groupId,id,patch });
      if (!id) await new Promise(resolve => { releaseCreate = resolve; });
      return { config: { ...(id === keyB.id ? keyB : keyA), id: id ?? 'new-key', ...patch }, refreshWarning: null };
    },
    deleteModelServiceKeyConfig: async id => { deleted.push(id); return { refreshWarning: null }; },
  };
  const Form = load(formPath, { ...dependencies, '../../ModelServices': commands }).default;
  await act(async () => { screen = renderer.create(React.createElement(Form, { serviceId: group.id, onBack() {} })); });
  await act(async () => fields(screen).filter(field => field.props.label === 'Key 名称（选填）')[0].props.onChangeText('聊天'));
  await act(async () => fields(screen).filter(field => field.props.label === 'Key 名称（选填）')[0].props.onBlur());
  assert.deepEqual(writes, [{ groupId: group.id, id: keyA.id, patch: { name: '聊天' } }]);
  assert.equal(fields(screen).filter(field => field.props.label === 'API Key')[1].props.value, 'private-b');
  await act(async () => button(screen, '＋ 添加 API Key').props.onPress());
  await act(async () => fields(screen).filter(field => field.props.label === 'API Key')[2].props.onChangeText('new-private-key'));
  await act(async () => { fields(screen).filter(field => field.props.label === 'API Key')[2].props.onBlur(); });
  assert.ok(releaseCreate);
  let removing;
  await act(async () => { removing = screen.root.findAllByType('Button').filter(node => node.props.title === '移除此 Key')[2].props.onPress(); });
  assert.deepEqual(deleted, [], '删除新槽位必须等待已提交的创建结果');
  await act(async () => { releaseCreate(); await removing; });
  assert.deepEqual(deleted, ['new-key'], '移除正在创建的 Key 不能留下隐形连接');
  assert.equal(fields(screen).filter(field => field.props.label === 'API Key').length, 2);
  await act(async () => button(screen, '移除此 Key').props.onPress());
  await act(async () => dialogs.at(-1).buttons.find(item => item.style === 'destructive').onPress());
  assert.deepEqual(deleted, ['new-key',keyA.id]);
  assert.equal(fields(screen).find(field => field.props.label === 'API Key').props.value, keyB.apiKey);
  await act(async () => screen.unmount());
}
{
  const picked = [];
  const backup = { ...group, id: 'backup', name: '备用连接', baseUrl: 'https://backup.invalid/v1', keys: [{ ...keyA, id: 'backup-key', name: '备用连接' }] };
  const Picker = load('src/features/assistants/presentation/auxiliaryModels/ServiceConnectionPicker.tsx', {
    ...dependencies, 'lucide-react-native': pickerIcons,
    '../../AuxiliaryModelsChanged': { subscribeAuxiliaryModelsChanged: () => () => {} },
    '@shared/ui': { ...shared, ModalSheet: ({ visible, title, children }) => visible ? React.createElement('Sheet', { title }, children) : null },
    'react-native': pickerNative,
    '../../ModelServices': { listModelServiceGroupConfigs: async () => [group,backup], getModelServiceConfig: async id => ({ ...(id === keyA.id ? keyA : keyB), apiKey: 'fresh-private-key' }) },
  }).default;
  function Host() {
    const [selected, select] = React.useState(keyA.id);
    return React.createElement(Picker, { baseUrl: keyA.baseUrl, apiKey: keyA.apiKey, serviceConfigId: selected,
      onFill: key => { picked.push(key); select(key.id); } });
  }
  let screen; await act(async () => { screen = renderer.create(React.createElement(Host)); });
  await act(async () => button(screen, '中转站 · 语音').props.onPress());
  assert.equal(screen.root.findByType('Sheet').props.title, '选择模型连接');
  const groupButtons = () => screen.root.findAllByType('Pressable').filter(node => node.props.accessibilityState?.expanded !== undefined);
  const keyRows = () => screen.root.findAllByType('Pressable').filter(node => node.props.accessibilityRole === 'radio');
  assert.deepEqual(groupButtons().map(node => node.props.accessibilityState.expanded), [false,false], '已有连接入口统一默认收起所有分组');
  assert.equal(keyRows().length, 0);
  await act(async () => groupButtons()[0].props.onPress());
  const text = screen.root.findAllByType('Text').map(node => node.props.children).join(' ');
  assert.ok(text.includes('中转站') && text.includes(keyA.baseUrl) && text.includes('识图'));
  assert.ok(text.includes(keyA.apiKey) && text.includes(keyB.apiKey), '展开后显示 Key 名称和完整凭据');
  await act(async () => groupButtons()[1].props.onPress());
  assert.equal(keyRows().length, 3); assert.equal(picked.length, 0, '展开分组不选择连接');
  await act(async () => groupButtons()[1].props.onPress());
  assert.equal(keyRows().length, 2, '收起分组隐藏它的 Key');
  const options = keyRows();
  assert.equal(options[0].props.accessibilityState.checked, true);
  await act(async () => options[1].props.onPress());
  assert.equal(picked[0].id, keyB.id); assert.equal(picked[0].apiKey, 'fresh-private-key', '选择时读取该 Key 的当前连接');
  assert.ok(button(screen, '中转站 · 识图'));
  await act(async () => screen.unmount());
}
{
  const keyC = { ...keyA, id: 'key-c', groupId: 'second', name: '另一组配置', keyName: '备用', apiKey: 'private-c', baseUrl: ` ${keyA.baseUrl}/// ` };
  const second = { ...group, id: keyC.groupId, name: keyC.name, baseUrl: keyC.baseUrl, keys: [keyC] };
  const otherGroups = [
    { ...group, id: 'other-host', baseUrl: 'https://other.invalid/v1' },
    { ...group, id: 'other-path', baseUrl: 'https://relay.invalid/v2' },
    { ...group, id: 'other-protocol', baseUrl: 'http://relay.invalid/v1' },
    { ...group, id: 'signed', authType: 'tencentCloud' },
    { ...group, id: 'empty', keys: [] },
  ];
  const picked = []; let screen, addressChanged = false, reads = 0;
  const Picker = load('src/features/assistants/presentation/auxiliaryModels/ServiceConnectionPicker.tsx', {
    ...dependencies, 'lucide-react-native': pickerIcons,
    '../../AuxiliaryModelsChanged': { subscribeAuxiliaryModelsChanged: () => () => {} },
    '@shared/ui': { ...shared, ModalSheet: ({ visible, title, children }) => visible ? React.createElement('Sheet', { title }, children) : null },
    'react-native': pickerNative,
    '../../ModelServices': {
      listModelServiceGroupConfigs: async () => { reads++; return [group, second, ...otherGroups]; },
      getModelServiceConfig: async id => ({ ...[keyA,keyB,keyC].find(key => key.id === id), ...(addressChanged ? { baseUrl: 'https://other.invalid/v1' } : {}) }),
    },
  }).default;
  const InputField = load('src/shared/ui/InputField.tsx', {
    'react-native': { ...native, TextInput: 'TextInput', StyleSheet: { create: styles => styles } },
    '@shared/theme': { useTheme: () => theme, useThemedStyles: create => create(theme) },
  }).default;
  function Host({ baseUrl = keyA.baseUrl }) {
    const [apiKey, setApiKey] = React.useState(keyB.apiKey);
    return React.createElement(InputField, { label: 'API Key', value: apiKey, autoGrow: true, onChangeText: setApiKey,
      rightAccessory: React.createElement(Picker, { mode: 'key', baseUrl, apiKey,
        onFill: key => { picked.push(key); setApiKey(key.apiKey); } }) });
  }
  const plus = () => screen.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === '从相同地址填入 Key');
  const groupButtons = () => screen.root.findAllByType('Pressable').filter(node => node.props.accessibilityState?.expanded !== undefined);
  const rows = () => screen.root.findAllByType('Pressable').filter(node => node.props.accessibilityRole === 'radio');
  await act(async () => { screen = renderer.create(React.createElement(Host)); });
  assert.ok(screen.root.findByType('TextInput')); assert.ok(screen.root.findByType('Plus'));
  await act(async () => plus().props.onPress());
  assert.equal(screen.root.findByType('Sheet').props.title, '选择模型连接');
  assert.equal(screen.root.findAllByType('ConnectionGroup').length, 2, '同地址不同名称的配置都可选择');
  assert.equal(rows().length, 0, '快捷填 Key 入口统一默认收起所有分组');
  await act(async () => groupButtons()[0].props.onPress());
  await act(async () => groupButtons()[1].props.onPress());
  assert.equal(rows().length, 3, '列出匹配分组的全部 Key，过滤不同地址、认证方式和空分组');
  assert.deepEqual(rows().map(row => row.props.accessibilityState.checked), [false,true,false]);
  const visibleText = screen.root.findAllByType('Text').map(node => node.props.children).join(' ');
  assert.ok(visibleText.includes('另一组配置') && visibleText.includes(keyC.apiKey));
  await act(async () => rows()[2].props.onPress());
  assert.equal(picked[0].id, keyC.id); assert.equal(screen.root.findByType('TextInput').props.value, keyC.apiKey);
  assert.equal(screen.root.findAllByType('Sheet').length, 0);
  await act(async () => plus().props.onPress());
  assert.deepEqual(groupButtons().map(node => node.props.accessibilityState.expanded), [false,false], '再次打开仍然统一收起，不沿用上次的展开状态');
  await act(async () => groupButtons()[1].props.onPress());
  addressChanged = true;
  await act(async () => rows()[0].props.onPress());
  assert.equal(picked.length, 1, '列表打开后源地址改变，不能将凭据填入旧地址');
  assert.ok(button(screen, '重新读取'));
  await act(async () => button(screen, '重新读取').props.onPress());
  assert.equal(reads, 3);
  await act(async () => { screen.update(React.createElement(Host, { baseUrl: 'https://no-match.invalid/v1' })); });
  await act(async () => plus().props.onPress());
  assert.equal(rows().length, 0);
  assert.ok(screen.root.findAllByType('Text').some(node => String(node.props.children).includes('没有相同地址')));
  await act(async () => { screen.update(React.createElement(Host, { baseUrl: '' })); });
  assert.equal(plus().props.disabled, true, '未确定地址时不能填充 Key');
  await act(async () => screen.unmount());
}
{
  const speech = {
    ...load('src/features/speech/application/SpeechProviderCatalog.ts'),
    listSpeechProviderOptions: async () => ({ models: [], voices: [] }),
    SpeechConfigurationTest: 'SpeechConfigurationTest',
  };
  const Form = load('src/features/assistants/presentation/auxiliaryModels/SpeechModelEditScreen.tsx', {
    ...dependencies, '@features/speech': speech, './ServiceConnectionPicker': 'ServiceConnectionPicker',
    'react-native': { ...native, TouchableOpacity: 'TouchableOpacity', Keyboard: { dismiss() {} } },
    '@shared/ui': { ...shared, ToggleField: 'ToggleField', ModelPickerField: 'ModelPickerField', ModelPickerModal: 'ModelPickerModal' },
    '@shared/ui/NavigationHeader': shared.NavigationHeader,
    '@shared/ui/useAutoSaveFeedback': { useAutoSaveFeedback: () => ({ scrollRef: null, blocked: false, setBlocked() {}, revealErrors() {}, fieldLayout: () => () => {} }) },
  }).default;
  const props = { initialData: null, saving: false, async onSave() {}, async onCreate() {}, onBack() {} };
  let screen;
  const input = label => fields(screen).find(node => node.props.label === label);
  const dropdown = label => screen.root.findAllByType('DropdownField').find(node => node.props.label === label);
  await act(async () => { screen = renderer.create(React.createElement(Form, { ...props, kind: 'tts' })); });
  assert.equal(input('API 地址').props.editable, false, '官方地址展示为只读字段');
  assert.equal(input('API 地址').props.value, 'https://api.minimax.cn/v1');
  await act(async () => dropdown('服务站点').props.onChange('international'));
  assert.equal(input('API 地址').props.value, 'https://api.minimax.io/v1', '地址随站点切换更新');
  assert.equal(input('API Key').props.rightAccessory.props.baseUrl, input('API 地址').props.value, 'TTS 展示地址与快捷填 Key 使用同一连接');
  await act(async () => dropdown('提供方').props.onChange('openaiCompatible'));
  assert.equal(input('API 地址').props.editable, true, '自定义兼容服务仍允许编辑地址');
  await act(async () => input('API 地址').props.onChangeText('https://custom.invalid/v1'));
  assert.equal(input('API 地址').props.value, 'https://custom.invalid/v1');
  assert.equal(screen.root.findAllByType('ServiceConnectionPicker').length, 1, '自定义兼容 TTS 保留已有服务入口');
  await act(async () => screen.unmount());
  await act(async () => { screen = renderer.create(React.createElement(Form, { ...props, kind: 'stt' })); });
  assert.equal(input('API 地址').props.editable, false);
  assert.equal(input('API 地址').props.value, '', '业务空间未填时不展示不完整的地址');
  assert.equal(input('API Key').props.rightAccessory, undefined, 'ASR 不提供通用 Key 快捷填充');
  await act(async () => input('业务空间 ID').props.onChangeText('workspace-a'));
  assert.equal(input('API 地址').props.value, 'wss://workspace-a.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference');
  await act(async () => dropdown('地域').props.onChange('singapore'));
  assert.equal(input('API 地址').props.value, 'wss://workspace-a.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference');
  await act(async () => dropdown('提供方').props.onChange('volcengineRealtimeAsr'));
  assert.equal(input('API 地址').props.value, 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async');
  assert.equal(input('语音服务 API Key').props.placeholder, '填写语音控制台的 API Key');
  assert.equal(input('语音服务 API Key').props.rightAccessory, undefined);
  await act(async () => screen.unmount());
}
{
  let selection, resolveA, resolveB;
  const requests = [];
  const useSelection = load('src/features/assistants/presentation/management/AIModelSettings/useModelSelection.ts', {
    '../sharedModelConfig': { fetchModelsWithConfig: input => {
      requests.push(input);
      return new Promise(resolve => { if (input.apiKey === 'a') resolveA = resolve; else resolveB = resolve; });
    } },
  }).default;
  function Host({ apiKey }) { selection = useSelection({ apiBaseUrl: keyA.baseUrl, apiKey, selectedModel: '', setSelectedModel() {}, resetKey: 'same-role' }); return null; }
  let screen, pendingA, pendingB;
  await act(async () => { screen = renderer.create(React.createElement(Host, { apiKey: 'a' })); });
  await act(async () => { pendingA = selection.handleFetchModels(); });
  await act(async () => { screen.update(React.createElement(Host, { apiKey: 'b' })); });
  await act(async () => { pendingB = selection.handleFetchModels(); });
  await act(async () => { resolveB({ models: [{ id: 'b-model' }], errorInfo: null }); await pendingB; });
  await act(async () => { resolveA({ models: [{ id: 'a-model' }], errorInfo: null }); await pendingA; });
  assert.deepEqual(selection.availableModels, [{ id: 'b-model' }]); assert.deepEqual(requests.map(request => request.apiKey), ['a','b']);
  await act(async () => screen.unmount());
}
console.log('模型连接 UI：多 Key、连接分组、地址筛选、官方只读地址、站点与业务空间联动、自定义地址编辑及 ASR 凭据入口验证通过');
