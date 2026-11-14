/** 生图页面的取消、保存重试与图片菜单可见性行为。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import { mock } from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadTypeScriptModule as loadModule } from './helpers/load-typescript-module.mjs';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies) {
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
const theme = { mode: 'light', colors: { background: { screen: 'white' }, surface: { input: '#eee' }, text: { primary: 'black', secondary: 'gray' },
  brand: { onPrimary: 'white', primary: '#8256d9' }, feedback: { error: 'red' }, border: { strong: 'gray', light: '#ddd' } }, spacing: { lg: 20, md: 12, sm: 8 }, radius: { lg: 12, md: 8 } };
let appStateListener;
let generateCalls = 0;
let saveCalls = 0;
let cleanups = 0;
let unsaved;
let lastSignal;
let complete;
let generateOptions;
let pickComplete;
let releasedReferences = 0;
const native = { Image: 'Image', ScrollView: 'Scroll', Text: 'Text', View: 'View', Modal: 'Modal', TouchableOpacity: 'Action', TouchableWithoutFeedback: 'Backdrop',
  Keyboard: { dismiss() {} }, ActivityIndicator: 'Spinner', Pressable: 'Pressable',
  StyleSheet: { create: value => value }, useWindowDimensions: () => ({ width: 400, height: 800 }),
  AppState: { addEventListener: (_event, callback) => { appStateListener = callback; return { remove() {} }; } } };
const themed = { ThemedSurface: 'Surface', useTheme: () => theme, useThemedStyles: factory => factory(theme) };
let drawingInstance = 0;
function PixelEffect(props) {
  const [instance] = React.useState(() => ++drawingInstance);
  return React.createElement('PixelEffect', { ...props, instance });
}
const canvas = load('src/features/media/presentation/ImageGenerationCanvas.tsx', {
  'react-native': native, '@shared/theme': themed,
  'expo-linear-gradient': { LinearGradient: 'Gradient' },
  'lucide-react-native': { Image: 'ImageIcon', Expand: 'Expand' },
  'react-native-reanimated': { useReducedMotion: () => true },
  './ImageGenerationPixelEffect': { default: PixelEffect },
});
const parameterForm = load('src/features/media/presentation/ImageGenerationParametersForm.tsx', {
  'react-native': native, '@shared/theme': themed, '@shared/ui': { Button: 'Button', DropdownField: 'Dropdown' },
});
const capabilities = { aspectRatios: ['1:1','16:9'], resolutions: ['2K'], references: true, preview: true, promptMaxLength: 2000 };
const configuration = loadModule('src/platform/ai/imageGenerationConfig.ts');
let currentModelSettings = { status: 'active', selectedModelId: 'model', capabilities };
let modelSettingsChanged;
const { default: Screen } = load('src/features/media/presentation/ImageGenerationScreen.tsx', {
  'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  '@shared/theme': { useTheme: () => theme, useThemedStyles: factory => factory(theme) },
  '@shared/ui': { Button: 'Button', ConfiguredModelPicker: 'Picker', InputField: 'Input', KeyboardAvoidingContainer: 'Keyboard', NavigationHeader: 'Header', ImageViewerModal: 'Viewer' },
  '../application/GenerateImageForUser': {
    generateImageForUser: async (_prompt, signal, options) => { generateCalls++; lastSignal = signal; generateOptions = options; return new Promise(resolve => { complete = resolve; }); },
    saveUserGeneratedImage: async () => { saveCalls++; return { status: 'saved', uri: 'content://gallery/1', width: 1600, height: 900, byteSize: 100 }; },
  },
  '../application/ImageGenerationModels': { getImageGenerationModelSettings: async () => currentModelSettings, subscribeImageGenerationModelsChanged: listener => { modelSettingsChanged = listener; return () => {}; } },
  '../application/ImageGenerationReference': { pickImageGenerationReference: async () => new Promise(resolve => { pickComplete = resolve; }), releaseImageGenerationReference: () => { releasedReferences++; } },
  './ImageGenerationCanvas': canvas, './ImageGenerationParametersForm': parameterForm,
});
let rendered;
let managed = 0;
const props = { isActive: true, onBack() {}, onManageModels() { managed++; }, onUnsavedImageChange: value => { unsaved = value; } };
await act(async () => { rendered = create(React.createElement(Screen, props)); });
assert.equal(rendered.root.findAllByType('Button').some(button => button.props.title === '管理模型'), false, '页面不再单独占一行管理按钮');
rendered.root.findByType('Picker').props.onManageModels();
assert.equal(managed, 1, '生图弹窗沿用路由适配的未保存图片确认入口');
await act(async () => rendered.root.findByType('Input').props.onChangeText('画一只猫'));
await act(async () => rendered.root.findByProps({ label: '图片比例' }).props.onChange('16:9'));
assert.equal(rendered.root.findByType(canvas.default).props.ratio, 16 / 9, '生成前按选定比例预留画布');
await act(async () => {
  const start = rendered.root.findAllByType('Button').find(button => button.props.title === '生成');
  start.props.onPress(); start.props.onPress();
});
assert.equal(generateCalls, 1, '连续点按只有一个请求');
assert.ok(rendered.root.findAllByType('Button').some(button => button.props.title === '取消'));
assert.equal(generateOptions.parameters.aspectRatio, '16:9');
await act(async () => generateOptions.onProgress({ stage: 'generating', preview: { base64: 'AAA', mimeType: 'image/png', index: 0 } }));
assert.equal(rendered.root.findByType('Image').props.source.uri, 'data:image/png;base64,AAA', '只展示真实收到的预览');
await act(async () => complete({ status: 'save_failed', error: '存储空间不足', image: { uri: 'file:///cache/image', cleanup: () => { cleanups++; } } }));
assert.equal(unsaved, true);
assert.ok(rendered.root.findAllByType('Text').some(text => JSON.stringify(text.props.children).includes('离开页面')));
await act(async () => rendered.root.findAllByType('Button').find(button => button.props.title === '重试保存').props.onPress());
assert.equal(saveCalls, 1);
assert.equal(generateCalls, 1);
assert.equal(unsaved, false);
assert.equal(rendered.root.findByType('Image').props.source.uri, 'content://gallery/1');
assert.equal(rendered.root.findByType('PixelEffect').props.reveal, false, '真实原图加载前不提前溶解遮罩');
await act(async () => rendered.root.findByType('Image').props.onLoad());
assert.equal(rendered.root.findByType('PixelEffect').props.reveal, true);
await act(async () => rendered.root.findByType('PixelEffect').props.onFinished());
assert.equal(rendered.root.findAllByType('PixelEffect').length, 0, '成图显现后释放 WebView');
await act(async () => rendered.root.findAllByType('Button').find(button => button.props.title === '生成').props.onPress());
await act(async () => appStateListener('background'));
assert.equal(lastSignal.aborted, true, '后台中止在途生成');
await act(async () => complete({ status: 'save_failed', error: '已取消', image: { uri: 'file:///cache/late', cleanup: () => { cleanups++; } } }));
assert.equal(rendered.root.findAllByType('Image').length, 0, '取消后迟到的图片不能显示或补存');
assert.equal(cleanups, 1);
await act(async () => rendered.root.findAllByType('Button').find(button => button.props.title === '生成').props.onPress());
await act(async () => complete({ status: 'save_failed', error: '目录不可写', image: { uri: 'file:///cache/failed', cleanup: () => { cleanups++; } } }));
await act(async () => rendered.update(React.createElement(Screen, { ...props, isActive: false })));
assert.equal(cleanups, 2, '失焦清理未保存图片');
assert.equal(unsaved, false);
await act(async () => rendered.update(React.createElement(Screen, props)));
await act(async () => rendered.root.findAllByType('Button').find(button => button.props.title === '添加参考人像').props.onPress());
await act(async () => appStateListener('background'));
await act(async () => pickComplete({ uri: 'file:///reference.png', mimeType: 'image/png', width: 100, height: 100 }));
assert.equal(rendered.root.findByType(parameterForm.default).props.reference.uri, 'file:///reference.png', '相册 Activity 不导致正常选择被丢弃');
await act(async () => rendered.update(React.createElement(Screen, { ...props, isActive: false })));
assert.equal(releasedReferences, 1, '离开清理参考图副本');
await act(async () => rendered.unmount());

currentModelSettings = { status: 'active', selectedModelId: 'edit-model', capabilities: configuration.getImageGenerationCapabilities({ provider: 'siliconflow' }, 'Qwen/Qwen-Image-Edit-2509') };
await act(async () => { rendered = create(React.createElement(Screen, props)); });
await act(async () => rendered.root.findByType('Input').props.onChangeText('把照片改成水彩'));
assert.equal(rendered.root.findAllByType('Button').find(button => button.props.title === '生成').props.disabled, true, '编辑模型先选图才能生成');
assert.equal(rendered.root.findAllByProps({ label: '图片比例' }).length, 0);
await act(async () => rendered.root.findAllByType('Button').find(button => button.props.title === '添加参考图（必需）').props.onPress());
await act(async () => pickComplete({ uri: 'file:///edit-reference.png', mimeType: 'image/png', width: 600, height: 800 }));
assert.equal(rendered.root.findAllByType('Button').find(button => button.props.title === '生成').props.disabled, false);
assert.equal(rendered.root.findByType(canvas.default).props.ratio, 3 / 4);
await act(async () => rendered.root.findAllByType('Button').find(button => button.props.title === '生成').props.onPress());
assert.equal(generateOptions.reference.uri, 'file:///edit-reference.png');
assert.deepEqual(generateOptions.parameters, {});
const beforeReferenceRelease = releasedReferences;
currentModelSettings = { status: 'active', selectedModelId: 'z-image', capabilities: configuration.getImageGenerationCapabilities({ provider: 'siliconflow' }, 'Tongyi-MAI/Z-Image') };
await act(async () => modelSettingsChanged());
assert.equal(releasedReferences, beforeReferenceRelease, '切模型不删除在途请求仍需读取的参考图');
await act(async () => complete({ status: 'saved', uri: 'content://gallery/edit', width: 600, height: 800, byteSize: 100 }));
assert.equal(releasedReferences, beforeReferenceRelease + 1);
assert.equal(rendered.root.findByType(parameterForm.default).props.reference, null, '切到文生图后清理不适用的参考图');
await act(async () => rendered.root.findByProps({ label: '图片比例' }).props.onChange('16:9'));
currentModelSettings = { status: 'active', selectedModelId: 'qwen-image', capabilities: configuration.getImageGenerationCapabilities({ provider: 'siliconflow' }, 'Qwen/Qwen-Image') };
await act(async () => modelSettingsChanged());
assert.equal(rendered.root.findByProps({ label: '图片比例' }).props.value, '', '换模型清空上一个模型的请求参数');
await act(async () => rendered.root.findByProps({ label: '图片比例' }).props.onChange('3:4'));
assert.ok(rendered.root.findByProps({ label: '图片比例' }).props.options.some(option => option.value === '3:4' && option.label.includes('1140 × 1472')));
currentModelSettings = { status: 'active', selectedModelId: 'edit-model', capabilities: configuration.getImageGenerationCapabilities({ provider: 'siliconflow' }, 'Qwen/Qwen-Image-Edit') };
await act(async () => modelSettingsChanged());
await act(async () => rendered.root.findAllByType('Button').find(button => button.props.title === '添加参考图（必需）').props.onPress());
currentModelSettings = { status: 'active', selectedModelId: 'z-image', capabilities: configuration.getImageGenerationCapabilities({ provider: 'siliconflow' }, 'Tongyi-MAI/Z-Image') };
await act(async () => modelSettingsChanged());
await act(async () => pickComplete({ uri: 'file:///late-reference.png', mimeType: 'image/png', width: 600, height: 800 }));
assert.equal(rendered.root.findByType(parameterForm.default).props.reference, null, '切模型后迟到的选图不能进入文生图参数');
assert.equal(releasedReferences, beforeReferenceRelease + 2);
await act(async () => rendered.unmount());

const { default: Menu } = load('src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx', {
  'react-native': native, '@expo/vector-icons': { Ionicons: 'Icon' },
  'lucide-react-native': Object.fromEntries(['Check', 'Download', 'History', 'Pin', 'PinOff', 'Star', 'Sticker', 'TextSelect'].map(name => [name, 'Icon'])),
  '@shared/theme': { useTheme: () => theme },
});
let saves = 0;
await act(async () => { rendered = create(React.createElement(Menu, { visible: true, onClose() {}, onCopy() {} })); });
assert.equal(rendered.root.findAllByProps({ accessibilityLabel: '保存图片' }).length, 0, '无图片时隐藏菜单项');
await act(async () => rendered.update(React.createElement(Menu, { visible: true, onClose() {}, onSaveImages: () => { saves++; } })));
await act(async () => rendered.root.findByProps({ accessibilityLabel: '保存图片' }).props.onPress());
assert.equal(saves, 1);
await act(async () => rendered.unmount());

// 资产表单使用真实草稿转换和编辑器：供应商只在新建时选择，已有资产只改模型和凭据。
const validation = loadModule('src/shared/ui/draftValidation.ts');
const draftModule = loadModule('src/features/assistants/presentation/auxiliaryModels/auxiliaryModelDraft.ts', {
  '@platform/ai/imageGenerationConfig': configuration, '@shared/ui/draftValidation': validation,
});
const { AutoSaveDraftEditor } = loadModule('src/shared/ui/AutoSaveDraftEditor.ts');
const changes = [];
let discoveries = 0;
const { default: AssetForm } = load('src/features/assistants/presentation/auxiliaryModels/AuxiliaryModelEditScreen.tsx', {
  './ServiceConnectionPicker': { default: 'ServicePicker' }, 'react-native': native,
  'react-native-safe-area-context': { SafeAreaView: 'SafeArea' }, '@shared/theme': themed,
  '@shared/ui/NavigationHeader': { default: 'Header' },
  '@shared/ui': { KeyboardAvoidingContainer: 'Keyboard', Button: 'Button', DropdownField: 'Dropdown', InputField: 'Input', ModelPickerField: 'ModelField', ModelPickerModal: 'ModelPicker', SliderField: 'Slider', showAppDialog() {} },
  '@shared/ui/commonStyles': { createCommonStyles: () => ({ screenContainer: {} }) },
  '@platform/ai/imageGenerationConfig': configuration,
  '../management/AIModelSettings/MaxTokensSection': { default: 'MaxTokens' },
  '../management/AIModelSettings/styles': { createModelSettingsStyles: () => ({ section: {}, contentContainer: {} }) },
  '../management/sharedModelConfig': { fetchModelsWithConfig: async () => { discoveries++; return { models: [] }; } },
  '@shared/ui/useAutoSaveDraft': {
    useAutoSaveDraft: ({ initial, parse, save, enabled }) => {
      const [editor] = React.useState(() => new AutoSaveDraftEditor(initial, parse, save));
      const state = React.useSyncExternalStore(editor.subscribe, editor.getSnapshot);
      return { ...state, change: (patch, immediate) => editor.change(patch, enabled && immediate), commit: editor.commit, flush: editor.flush, restore: editor.restore, validateAll: editor.validateAll, getSnapshot: editor.getSnapshot };
    },
    useAutoSaveNavigation: (_flush, back) => ({ back }),
  },
  '@shared/ui/useAutoSaveFeedback': { useAutoSaveFeedback: () => ({ scrollRef: React.useRef(null), revealErrors() {}, fieldLayout: () => () => {} }) },
  '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'Errors' }, '@shared/ui/draftValidation': validation,
  './auxiliaryModelDraft': draftModule,
  './ModelFormSection': { default: 'FormSection' },
});
await act(async () => { rendered = create(React.createElement(AssetForm, { capabilityKind: 'image_generation', capabilityLabel: '生图模型', modelId: 'old',
  initialData: { capabilityKind: 'image_generation', name: '已有资产', serviceConfigId: 'old-service', baseUrl: 'https://old.invalid/v1', apiKey: 'old-key', model: 'old-model', metadataJson: null },
  onBack() {}, onSave: async patch => { changes.push(patch); }, onCreate() {}, onTest() {},
})); });
const imageProviderField = () => rendered.root.findAllByType('Dropdown').find(node => node.props.options.some(option => option.value === 'siliconflow'));
const providerDropdown = imageProviderField();
assert.ok(!providerDropdown.props.options.some(item => item.value === 'openaiCompatible'), '不再提供自定义 OpenAI 生图入口');
assert.equal(providerDropdown.props.disabled, true, '旧配置也不能通过换供应商修复');
assert.equal(rendered.root.findAllByProps({ label: '兼容协议能力' }).length, 0);
assert.equal(rendered.root.findByProps({ label: 'API Key' }).props.value, 'old-key');
assert.deepEqual(changes, [], '打开旧配置不清理或改写已有数据');
await act(async () => rendered.unmount());
const created = [];
await act(async () => { rendered = create(React.createElement(AssetForm, { capabilityKind: 'image_generation', capabilityLabel: '生图模型',
  initialData: null, onBack() {}, onSave() { throw new Error('新建不能自动保存'); }, onCreate: async value => { created.push(value); }, onTest() {},
})); });
assert.equal(imageProviderField().props.disabled, false);
await act(async () => imageProviderField().props.onChange('minimax'));
assert.equal(rendered.root.findByProps({ label: 'API 地址' }).props.value, 'https://api.minimax.cn/v1');
assert.equal(rendered.root.findByProps({ label: 'API 地址' }).props.editable, false);
assert.equal(rendered.root.findByProps({ label: 'API Key' }).props.value, '');
await act(async () => rendered.root.findByProps({ label: '模型名称' }).props.onPress());
assert.equal(rendered.root.findByType('ModelPicker').props.visible, true);
assert.deepEqual(rendered.root.findByType('ModelPicker').props.models.map(model => model.id), ['image-01', 'image-01-live']);
await act(async () => rendered.root.findByType('ModelPicker').props.onClose());
await act(async () => rendered.root.findByProps({ label: 'API Key' }).props.onChangeText('minimax-key'));
await act(async () => imageProviderField().props.onChange('siliconflow'));
assert.equal(rendered.root.findByProps({ label: 'API Key' }).props.value, '', '新建阶段换供应商清空前一家的 Key');
assert.equal(rendered.root.findByProps({ label: '模型名称' }).props.value, 'Tongyi-MAI/Z-Image');
assert.equal(rendered.root.findByProps({ label: 'API 地址' }).props.value, 'https://api.siliconflow.cn/v1');
await act(async () => rendered.root.findByProps({ label: '模型名称' }).props.onPress());
assert.ok(rendered.root.findByType('ModelPicker').props.models.some(model => model.id === 'Qwen/Qwen-Image-Edit-2509'));
await act(async () => rendered.root.findByType('ModelPicker').props.onSelect('Qwen/Qwen-Image-Edit-2509'));
await act(async () => rendered.root.findByProps({ label: 'API Key' }).props.onChangeText('siliconflow-key'));
await act(async () => rendered.root.findByType('Header').props.rightButton.props.onPress());
assert.equal(created[0].model, 'Qwen/Qwen-Image-Edit-2509');
assert.equal(JSON.parse(created[0].metadataJson).provider, 'siliconflow');
assert.equal(discoveries, 0, '预设模型列表不发接口探测');
await act(async () => rendered.unmount());
await act(async () => { rendered = create(React.createElement(AssetForm, { capabilityKind: 'image_generation', capabilityLabel: '生图模型', modelId: 'saved',
  initialData: { ...created[0], capabilityKind: 'image_generation' }, onBack() {}, onSave: async patch => { changes.push(patch); }, onCreate() {}, onTest() {},
})); });
assert.equal(imageProviderField().props.disabled, true);
await act(async () => rendered.root.findByProps({ label: '模型名称' }).props.onPress());
await act(async () => rendered.root.findByType('ModelPicker').props.onSelect('Tongyi-MAI/Z-Image'));
assert.deepEqual(changes.at(-1), { model: 'Tongyi-MAI/Z-Image' }, '编辑同提供方模型不携带供应商或连接恢复字段');
await act(async () => rendered.unmount());
await act(async () => { rendered = create(React.createElement(parameterForm.default, {
  capabilities: configuration.getImageGenerationCapabilities({ provider: 'siliconflow' }, 'Tongyi-MAI/Z-Image'), value: { aspectRatio: '3:4' }, disabled: false,
  reference: null, picking: false, onChange() {}, onPickReference() {}, onRemoveReference() {},
})); });
assert.ok(rendered.root.findByProps({ label: '图片比例' }).props.options.some(option => option.value === '3:4'));
assert.equal(rendered.root.findAllByType('Button').length, 0, 'Z-Image 不显示参考图入口');
assert.equal(rendered.root.findAllByProps({ label: '清晰度' }).length, 0, 'Z-Image 不显示未经适配的自定义清晰度');
await act(async () => rendered.unmount());

// 文档只随主题或动效偏好重建；计时、预览和显现指令不会重载本地绘制页。
const shader = loadModule('src/features/media/presentation/imageGenerationPixelShader.ts');
const pixelDocument = loadModule('src/features/media/presentation/imageGenerationPixelDocument.ts', { './imageGenerationPixelShader': shader });
const injected = [];
const WebCanvas = React.forwardRef(function WebCanvas(props, ref) {
  React.useImperativeHandle(ref, () => ({ injectJavaScript: script => injected.push(script) }), []);
  return React.createElement('WebCanvas', props);
});
const { default: ActualPixelEffect } = load('src/features/media/presentation/ImageGenerationPixelEffect.tsx', {
  'react-native': { ...native, processColor: () => 0xffeeeeee }, '@shared/theme': themed,
  'react-native-webview': { WebView: WebCanvas }, './imageGenerationPixelDocument': pixelDocument,
});
let effectFinished = 0;
const effectProps = { reveal: false, reducedMotion: false, hasPreview: false, onFinished: () => { effectFinished++; } };
await act(async () => { rendered = create(React.createElement(ActualPixelEffect, effectProps)); });
const localDocument = rendered.root.findByType('WebCanvas').props.source;
await act(async () => rendered.update(React.createElement(ActualPixelEffect, { ...effectProps, hasPreview: true, reveal: true })));
assert.equal(rendered.root.findByType('WebCanvas').props.source, localDocument);
assert.equal(injected.length, 0, '本地文档准备好之前不丢失原图显现指令');
await act(async () => rendered.root.findByType('WebCanvas').props.onMessage({ nativeEvent: { data: 'ready' } }));
let revealCalls = 0;
runInNewContext(injected.at(-1), { window: { revealImage: () => { revealCalls++; } } });
assert.equal(revealCalls, 1);
const canNavigate = rendered.root.findByType('WebCanvas').props.onShouldStartLoadWithRequest;
assert.equal(canNavigate({ url: 'about:blank' }), true);
assert.equal(canNavigate({ url: 'https://example.com' }), false);
assert.equal(canNavigate({ url: 'file:///private-image.png' }), false);
await act(async () => rendered.root.findByType('WebCanvas').props.onMessage({ nativeEvent: { data: 'unknown' } }));
assert.equal(effectFinished, 0, '未知 WebView 消息不改变画布状态');
await act(async () => rendered.root.findByType('WebCanvas').props.onMessage({ nativeEvent: { data: 'revealed' } }));
assert.equal(effectFinished, 1);
await act(async () => rendered.unmount());

// 动效生命周期不能重置等待时长，也不能让上一张图的溶解占用下一次请求。
mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
try {
  const canvasProps = { busy: true, ratio: 1, ratioLabel: '1:1', progress: { stage: 'preparing' }, imageUri: null, onOpenImage() {} };
  await act(async () => { rendered = create(React.createElement(canvas.default, canvasProps)); });
  await act(async () => mock.timers.tick(65000));
  const timer = () => rendered.root.findAllByType('Text').find(text => Array.isArray(text.props.children) && typeof text.props.children[0] === 'number');
  assert.equal(timer().props.children[0], 65);
  await act(async () => rendered.update(React.createElement(canvas.default, { ...canvasProps, progress: { stage: 'saving' } })));
  assert.equal(timer().props.children[0], 65, '阶段变化不重置计时');
  const previousInstance = rendered.root.findByType('PixelEffect').props.instance;
  await act(async () => rendered.update(React.createElement(canvas.default, { ...canvasProps, busy: false, imageUri: 'file:///completed.png' })));
  assert.equal(rendered.root.findByType('PixelEffect').props.instance, previousInstance);
  await act(async () => rendered.update(React.createElement(canvas.default, canvasProps)));
  assert.notEqual(rendered.root.findByType('PixelEffect').props.instance, previousInstance, '新请求释放上一张图未完成的溶解实例');
  assert.equal(timer().props.children[0], 0);
  await act(async () => rendered.update(React.createElement(canvas.default, { ...canvasProps, busy: false })));
  assert.equal(rendered.root.findAllByType('PixelEffect').length, 0, '取消后立即释放绘制实例');
  await act(async () => rendered.unmount());
} finally { mock.timers.reset(); }
console.log('生图页面验证通过：比例画布、服务预览、后台取消、参考图、保存重试、像素场隔离、加载后显现、计时与新请求生命周期。');
