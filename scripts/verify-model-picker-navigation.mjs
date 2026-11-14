/** 验证模型选择的真实用途映射、关窗后跳转与管理后的刷新，不调用远端模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return { ...React, default: React };
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(dependencies, name), `${file} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const themed = { useTheme: () => theme, useThemedStyles: factory => factory(theme), ThemedSurface: 'Surface' };
const safeArea = { SafeAreaView: 'SafeArea', useSafeAreaInsets: () => ({ bottom: 24 }) };
const navigation = load('src/shared/ui/ModelManagementNavigation.tsx');
const pushed = [];
let pathname = '/memory/settings';
let closing;
let onNavigate = () => {};
const router = { push(destination) { onNavigate(); pushed.push(destination); } };
const Boundary = load('src/host/navigation/ModelManagementNavigationBoundary.tsx', {
  '@shared/ui': navigation, 'expo-router': { useRouter: () => router, usePathname: () => pathname },
}).default;
const native = {
  ...Object.fromEntries(['View', 'Text', 'Pressable', 'Modal', 'TouchableOpacity', 'TouchableWithoutFeedback', 'ActivityIndicator', 'ScrollView'].map(name => [name, name])),
  StyleSheet: { create: value => value, hairlineWidth: 0.5, absoluteFill: {} },
  Keyboard: { dismiss() {} }, Dimensions: { get: () => ({ height: 800 }) },
  Animated: {
    Value: class {}, View: 'AnimatedView', timing: (_value, config) => config,
    parallel: configs => ({ start(callback) {
      if (configs.some(config => config.toValue === 800)) closing = callback;
      else callback({ finished: true });
    }, stop() {} }),
  },
  FlatList: ({ data, renderItem, ListEmptyComponent }) => React.createElement('List', null,
    data.length ? data.map(item => React.createElement('Row', { key: item.id }, renderItem({ item }))) : ListEmptyComponent),
};
const Sheet = load('src/shared/ui/ModalSheet.tsx', {
  'react-native': native, '@shared/theme': themed, 'react-native-safe-area-context': safeArea,
  '../../../modules/modal-window': { ModalWindow: 'ModalWindow' },
});
const Picker = load('src/shared/ui/ModelPickerModal.tsx', {
  'react-native': native, '@shared/theme': themed, 'react-native-safe-area-context': safeArea,
  'lucide-react-native': { Check: 'Check', RefreshCw: 'Refresh' }, './ModalSheet': Sheet,
  './NavigationHeaderHelp': { default: 'Help' }, './InputField': { default: 'Input' },
}).default;
let screen;
let selected = 'current';
let pickerState;
function Popup() {
  const manage = navigation.useModelManagementNavigation();
  const [target, setTarget] = React.useState('ocr');
  const [settings, setSettings] = React.useState({});
  pickerState = { setTarget, setSettings };
  return React.createElement(Picker, {
    visible: target !== null, models: [{ id: 'current', name: '当前模型' }], selectedModel: selected,
    onSelect: id => { selected = id; }, onClear: () => { selected = null; }, onClose: () => setTarget(null),
    onManageModels: () => manage(target), ...settings,
  });
}
await act(async () => { screen = create(React.createElement(Boundary, null, React.createElement(Popup))); });
await act(async () => screen.root.findByType('Modal').props.onShow());
const button = label => screen.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label
  || node.findAllByType('Text').some(text => text.props.children === label));
assert.equal(screen.root.findByType('List').findAllByType('Pressable').length, 1, '操作区不占据模型列表');
assert.ok(button('取消选择') && button('管理模型'));
await act(async () => button('取消选择').props.onPress());
assert.equal(selected, null);
selected = 'current';
await act(async () => pickerState.setSettings({ error: '读取失败' }));
assert.ok(button('管理模型'), '读取失败仍可进入管理');
assert.equal(button('取消选择'), undefined);
await act(async () => pickerState.setSettings({ models: [], disabled: true }));
assert.equal(button('管理模型').props.disabled, true);
await act(async () => pickerState.setSettings({ models: [] }));
assert.ok(button('管理模型'), '没有配置也能进入管理并新增');
onNavigate = () => assert.equal(screen.root.findAllByType('Modal').length, 0, '导航时原生弹窗已移除');
await act(async () => button('管理模型').props.onPress());
assert.deepEqual(pushed, [], '退出动画期间不提前导航');
assert.equal(selected, 'current', '管理不修改业务选择');
await act(async () => closing({ finished: true }));
assert.equal(pushed.at(-1), '/auxiliary-models/capabilities/ocr', '父组件清空弹窗类型后仍保留点击时的用途');
await act(async () => screen.unmount());
onNavigate = () => {};

let manage;
function Probe() { manage = navigation.useModelManagementNavigation(); return null; }
await act(async () => { screen = create(React.createElement(Boundary, null, React.createElement(Probe))); });
for (const kind of ['summary', 'embedding', 'ocr', 'image_generation', 'stt', 'tts', 'translation']) {
  manage(kind);
  assert.equal(pushed.at(-1), `/auxiliary-models/capabilities/${kind}`);
}
for (const kind of ['stt', 'translation']) {
  pathname = `/auxiliary-models/capabilities/${kind}`;
  await act(async () => screen.update(React.createElement(Boundary, null, React.createElement(Probe))));
  const count = pushed.length;
  manage(kind);
  assert.equal(pushed.length, count, '已经位于对应管理页时不重复压栈');
}
await act(async () => screen.unmount());
pathname = '/memory/settings';

const shared = { ...navigation, ConfiguredModelPicker: 'ConfiguredPicker', showAppDialog() {} };
for (const [file, exportName, dependency, kind, props] of [
  ['src/features/chat/presentation/conversation/ChatImageModelPicker.tsx', 'ChatImageModelPicker', '../../reply/application/ChatImageModels', 'ocr', { assistantId: 'assistant' }],
  ['src/features/assistants/presentation/management/AssistantVoiceModelPicker.tsx', 'AssistantVoiceModelPicker', '../../application/AssistantVoiceModels', 'tts', { assistantId: 'assistant' }],
  ['src/features/speech/presentation/SpeechRecognitionModelPicker.tsx', 'SpeechRecognitionModelPicker', '../application/SpeechRecognitionModels', 'stt', {}],
  ['src/features/integrations/presentation/TranslationModelPicker.tsx', 'default', '../application/TranslationModels', 'translation', {}],
  ['src/features/memory/presentation/MemoryEmbeddingModelPicker.tsx', 'default', '../application/MemoryEmbeddingModels', 'embedding', {}],
]) {
  const Component = load(file, { '@shared/ui': shared, [dependency]: {}, '../application/MemorySignals': {} })[exportName];
  await act(async () => { screen = create(React.createElement(Boundary, null, React.createElement(Component, props))); });
  screen.root.findByType('ConfiguredPicker').props.onManageModels();
  assert.equal(pushed.at(-1), `/auxiliary-models/capabilities/${kind}`, file);
  await act(async () => screen.unmount());
}

const snapshot = { settings: { primaryLimit: 10 }, segments: [] };
const Summary = load('src/features/chat/summary/presentation/ChatSummarySettingsScreen.tsx', {
  'react-native': native, 'react-native-safe-area-context': safeArea, '@shared/theme': themed,
  '@shared/ui': { ...shared, KeyboardAvoidingContainer: 'Keyboard', NavigationHeader: 'Header' },
  '@features/assistants': {}, '@shared/prompt': {}, '../application/ChatSummary': {}, '../application/ChatSummaryRuntime': {},
  '@shared/ui/useAutoSaveDraft': { useAutoSaveNavigation: () => ({ back() {} }) },
  './ChatSummarySettingsPanel': { default: 'Panel' }, './useChatSummarySnapshot': { useChatSummarySnapshot: () => ({ snapshot }) },
  './chatSummaryStyles': { createChatSummaryStyles: () => ({}) },
}).default;
for (const group of [false, true]) {
  await act(async () => { screen = create(React.createElement(Boundary, null, React.createElement(Summary, { conversationId: 'chat', group, onBack() {} }))); });
  screen.root.findByType('ConfiguredPicker').props.onManageModels();
  assert.equal(pushed.at(-1), '/auxiliary-models/capabilities/summary');
  await act(async () => screen.unmount());
}

let focus;
let currentMomentModel = { status: 'active', name: '旧模型', modelConfigId: 'ocr-current' };
const Moments = load('src/features/moments/presentation/MomentsSettingsView.tsx', {
  'react-native': native, 'react-native-safe-area-context': safeArea, '@shared/theme': themed,
  '@react-navigation/native': { useFocusEffect: callback => { focus = callback; React.useEffect(callback, [callback]); } },
  '@shared/ui/NavigationHeader': { default: 'Header' },
  '@shared/ui': { ...shared, BackgroundPickerCard: 'Cover', ImageViewerModal: 'Viewer', ModelPickerModal: 'MomentPicker' },
  '../application/MomentSettings': {
    getMomentImageAnalysisModelSelection: async () => currentMomentModel,
    listMomentImageAnalysisModelCandidates: async () => [],
  },
  './useMomentsCover': { useMomentsCover: () => ({}) },
}).default;
await act(async () => { screen = create(React.createElement(Boundary, null, React.createElement(Moments, { onClose() {} }))); });
screen.root.findByType('MomentPicker').props.onManageModels();
assert.equal(pushed.at(-1), '/auxiliary-models/capabilities/ocr');
currentMomentModel = { ...currentMomentModel, name: '修改后的模型' };
await act(async () => focus());
assert.ok(screen.root.findAllByType('Text').some(node => node.props.children === '修改后的模型'), '时刻设置返回时刷新当前模型名称');
await act(async () => screen.unmount());

const Sticker = load('src/features/stickers/presentation/stickerSystem/StickerSystemScreen.tsx', {
  'react-native': native, 'react-native-safe-area-context': safeArea, '@shared/theme': themed,
  'expo-router': { useFocusEffect: callback => React.useEffect(callback, [callback]) },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shared/ui': { ...shared, ListItem: 'ListItem', ModelPickerModal: Picker, NavigationHeader: 'Header', ToggleField: 'Toggle' },
  '../../application/StickerSystemModels': { listStickerModelCandidates: async () => [] },
  './styles': { useStickerSystemStyles: () => ({}) }, './StickerSystemGroupsScreen': { default: 'Groups' },
  './StickerSystemLibraryScreen': { default: 'Library' }, './StickerProcessingSummary': { StickerProcessingSummary: 'Summary' },
  './useStickerProcessingProgress': { useStickerProcessingProgress: () => ({
    progress: { recognitionModel: { modelConfigId: 'ocr-current', status: 'active', name: '视觉' },
      embeddingModel: { modelConfigId: 'embedding-current', status: 'active', name: '向量' } },
  }) },
}).default;
await act(async () => { screen = create(React.createElement(Boundary, null, React.createElement(Sticker, { onBack() {}, onOpenProgress() {} }))); });
for (const [title, kind] of [['视觉识别模型', 'ocr'], ['向量化模型', 'embedding']]) {
  await act(async () => screen.root.findAllByType('ListItem').find(node => node.props.title === title).props.onPress());
  await act(async () => screen.root.findByType('Modal').props.onShow());
  await act(async () => button('管理模型').props.onPress());
  await act(async () => closing({ finished: true }));
  assert.equal(pushed.at(-1), `/auxiliary-models/capabilities/${kind}`, `表情包${title}关窗后跳转`);
}
await act(async () => screen.unmount());

let dialog;
const ImageRoute = load('src/app/image-generation.tsx', {
  'expo-router': { useRouter: () => router },
  '@react-navigation/native': { useIsFocused: () => true, useNavigation: () => ({}), usePreventRemove() {} },
  '@features/media': { ImageGenerationScreen: 'ImageScreen' }, '@shared/ui': { showAppDialog: value => { dialog = value; } },
}).default;
await act(async () => { screen = create(React.createElement(ImageRoute)); });
screen.root.findByType('ImageScreen').props.onManageModels();
assert.equal(pushed.at(-1), '/auxiliary-models/capabilities/image_generation');
await act(async () => screen.root.findByType('ImageScreen').props.onUnsavedImageChange(true));
const beforeConfirmation = pushed.length;
screen.root.findByType('ImageScreen').props.onManageModels();
assert.equal(pushed.length, beforeConfirmation, '生图未保存时等待既有丢弃确认');
dialog.buttons.find(item => item.text === '丢弃并继续').onPress();
assert.equal(pushed.at(-1), '/auxiliary-models/capabilities/image_generation');
await act(async () => screen.unmount());

let settings = { status: 'active', models: [{ id: 'current', name: '旧名称' }], selectedModelId: 'current', selectedModelName: '旧名称' };
let changed;
const Configured = load('src/shared/ui/ConfiguredModelPicker.tsx', {
  'react-native': native, '@shared/theme': themed, 'lucide-react-native': { ChevronRight: 'Arrow' },
  './ModelPickerModal': { default: 'ConfiguredModal' }, './appDialogStore': { showAppDialog() {} },
}).default;
await act(async () => { screen = create(React.createElement(Configured, {
  title: '模型', getSettings: async () => settings, onSelect: async () => { throw new Error('管理不应提交选择'); },
  subscribeChanged: callback => { changed = callback; return () => {}; }, onManageModels() {},
})); });
settings = { ...settings, selectedModelName: '已修改名称' };
await act(async () => changed());
assert.ok(screen.root.findAllByType('Text').some(node => node.props.children === '已修改名称 · 配置可用'));
assert.equal(screen.root.findByType('ConfiguredModal').props.selectedModel, 'current');
await act(async () => screen.unmount());
console.log('模型管理导航验证通过：七种用途、各业务选择入口、同页去重、关闭完成后跳转、空列表与错误入口、保留选择及返回刷新。');
