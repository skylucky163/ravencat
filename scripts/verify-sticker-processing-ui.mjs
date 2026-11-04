/** 处理进度的可见状态与用户恢复操作，使用真实 React 生命周期验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    assert.ok(Object.hasOwn(dependencies, name), `缺少测试依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const native = Object.fromEntries(['View', 'Text', 'TouchableOpacity', 'Image', 'ActivityIndicator', 'ScrollView'].map(name => [name, name]));
native.FlatList = function TestFlatList({ data, renderItem, ListHeaderComponent, ListEmptyComponent }) {
  return React.createElement('List', {},
    ListHeaderComponent, ...data.map(item => React.createElement(React.Fragment, { key: item.sticker ? item.sticker.id : item.id }, renderItem({ item }))),
    data.length === 0 ? ListEmptyComponent : null);
};
const calls = [];
const dialogs = [];
const row = (id, status, vectorStatus, error = null) => ({
  sticker: { id, mediaAssetId: id, name: id, annotationStatus: status, annotationError: status === 'failed' ? '识别服务报错' : null,
    description: null, tags: [], emotion: null, isAnimated: status === 'manual_required' },
  annotationStartedAt: null, manuallyRequested: false, vectorStatus, hasEmbedding: vectorStatus === 'ready', embeddingError: error,
});
const progress = { items: [row('排队猫', 'pending', 'waiting_annotation'), row('失败猫', 'failed', 'waiting_annotation'),
  row('可用猫', 'ready', 'failed', '向量服务报错'), row('动态猫', 'manual_required', 'waiting_annotation'), row('成功猫', 'ready', 'ready')],
  recognitionModel: { status: 'active' }, embeddingModel: { status: 'active' }, automaticRecognitionEnabled: true,
  embeddingPublished: true, embeddingCanBackfill: true, embeddingActivity: null };
const ui = {
  NavigationHeader: 'Header', InputField: 'Input',
  ModalSheet: ({ visible, children }) => visible ? React.createElement('Sheet', {}, children) : null,
  showAppDialog: value => dialogs.push(value),
};
const commands = {
  retryStickerAnnotation: async id => { calls.push(['recognize', id]); },
  completeStickerAnnotationManually: async (id, metadata) => { calls.push(['manual', id, metadata]); },
};
const annotationStatusModule = load('src/features/stickers/presentation/stickerSystem/StickerAnnotationStatus.tsx', { 'react-native': native });
let rebuildSignal;
let rejectRebuild;
const Screen = load('src/features/stickers/presentation/stickerSystem/StickerProcessingScreen.tsx', {
  'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  'expo-router': { useFocusEffect: callback => React.useEffect(callback, [callback]) },
  '@shared/theme': { ThemedSurface: 'Surface' }, '@shared/ui': ui,
  '../../application/StickerCommands': commands,
  '../../application/StickerQueries': { resolveStickerMedia: async id => ({ localUri: `file:///${id}.png` }) },
  '../../application/StickerEmbeddings': {
    backfillMissingStickerEmbeddings: async id => { calls.push(['embed', id]); },
    rebuildStickerEmbeddingIndex: signal => new Promise((resolve, reject) => { rebuildSignal = signal; rejectRebuild = reject; }),
  },
  './useStickerProcessingProgress': { useStickerProcessingProgress: () => ({ progress, error: null }) },
  './processingStyles': { useStickerProcessingStyles: () => ({}) },
  './StickerAnnotationStatus': annotationStatusModule,
  './StickerThumbnail': { StickerThumbnail: 'Thumbnail' },
}).default;
let renderer;
await act(async () => { renderer = create(React.createElement(Screen, { onBack() {} })); });
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : node ? text(node.children) : '';
const visible = () => text(renderer.toJSON());
const press = async label => {
  const target = renderer.root.findAllByType('TouchableOpacity').find(node => text(node.toJSON ? node.toJSON() : node.children) === label);
  assert.ok(target, `应展示操作：${label}`);
  assert.notEqual(target.props.disabled, true);
  await act(async () => { await target.props.onPress(); });
};
const open = async name => {
  const target = renderer.root.findAllByType('TouchableOpacity').find(node => text(node.children).startsWith(name));
  assert.ok(target, `应展示表情：${name}`);
  await act(async () => { target.props.onPress(); });
};
assert.match(visible(), /排队中/);
assert.ok(!visible().includes('成功猫'), '进度列表不展示已成功的表情');
assert.match(visible(), /向量化失败 · 不影响发送/);
await open('失败猫');
assert.match(visible(), /识别服务报错/);
await press('重新识别');
assert.deepEqual(calls.pop(), ['recognize', '失败猫']);
await press('手动填写含义');
const description = renderer.root.findAllByType('Input').find(node => node.props.label.startsWith('含义与使用语境'));
const manualName = renderer.root.findAllByType('Input').find(node => node.props.label.startsWith('名称'));
const beforeMissingFields = calls.length;
await press('保存含义');
assert.equal(calls.length, beforeMissingFields, '缺少必填含义时不调用保存命令');
assert.match(description.props.error, /请填写/);
await act(async () => { manualName.props.onChangeText('   '); description.props.onChangeText('猫猫表达安慰'); });
await press('保存含义');
assert.equal(calls.length, beforeMissingFields, '只有空白的名称不能提交');
assert.match(manualName.props.error, /请填写/);
await act(async () => { manualName.props.onChangeText('失败猫'); });
await act(async () => { description.props.onChangeText('猫猫表达安慰'); });
await press('保存含义');
assert.equal(calls.at(-1)[2].description, '猫猫表达安慰');
await open('可用猫');
assert.match(visible(), /向量服务报错/);
await press('补齐此张向量');
assert.deepEqual(calls.pop(), ['embed', '可用猫']);
await open('动态猫');
assert.equal(renderer.root.findAllByType('Sheet')[0].findAllByType('TouchableOpacity').some(node => text(node.children) === '重新识别'), false,
  '动态图只提供手动标注，不进入静态识别队列');
await press('重建全部索引');
await act(async () => { dialogs.at(-1).buttons.find(button => button.text === '重建').onPress(); });
assert.equal(rebuildSignal.aborted, false);
await act(async () => { renderer.unmount(); });
assert.equal(rebuildSignal.aborted, true, '页面失焦释放本页发起的重建请求');
await act(async () => { rejectRebuild(new Error('已取消')); });
progress.automaticRecognitionEnabled = false;
await act(async () => { renderer = create(React.createElement(Screen, { onBack() {} })); });
assert.match(visible(), /自动识别已关闭/);
assert.doesNotMatch(visible(), /排队中|剩余 \d+|排队 \d+/, '详情页关闭时也不展示自动队列');
await act(async () => { renderer.unmount(); });
progress.automaticRecognitionEnabled = true;

const originalItems = progress.items;
progress.items = [row('待重建猫', 'ready', 'pending_rebuild')];
progress.embeddingCanBackfill = false;
await act(async () => { renderer = create(React.createElement(Screen, { onBack() {} })); });
assert.match(visible(), /有效 0 \/ 1 张 · 待建立 1 张/);
assert.match(visible(), /待重建猫/);
assert.doesNotMatch(visible(), /当前没有待处理项/, '待手动重建的表情也应出现在处理明细中');
await act(async () => { renderer.unmount(); });
progress.items = originalItems;
progress.embeddingCanBackfill = true;

let navigated = 0;
const { StickerProcessingSummary } = load('src/features/stickers/presentation/stickerSystem/StickerProcessingSummary.tsx', {
  'react-native': native, 'lucide-react-native': { ChevronRight: 'Chevron' },
  '@shared/theme': { ThemedSurface: 'Surface', useTheme: () => ({ colors: { brand: { primary: 'blue' }, text: { secondary: 'gray' } } }) },
  './processingStyles': { useStickerProcessingStyles: () => ({}) },
});
await act(async () => { renderer = create(React.createElement(StickerProcessingSummary, { progress, error: null,
  compact: true, onPress: () => navigated++ })); });
assert.match(visible(), /等待识别 · 剩余 1 张/);
await act(async () => { renderer.root.findByType('TouchableOpacity').props.onPress(); });
assert.equal(navigated, 1, '轻量摘要触发宿主提供的共用详情导航');
const disabledProgress = { ...progress, automaticRecognitionEnabled: false };
for (const compact of [true, false]) {
  await act(async () => { renderer.update(React.createElement(StickerProcessingSummary, {
    progress: disabledProgress, error: null, compact, onPress() {},
  })); });
  assert.match(visible(), /自动识别已关闭/);
  assert.doesNotMatch(visible(), /剩余|排队|已完成/, '关闭状态不显示自动队列数量');
}
await act(async () => { renderer.update(React.createElement(StickerProcessingSummary, {
  progress: { ...disabledProgress, items: disabledProgress.items.map(item => item.sticker.annotationStatus === 'pending'
    ? { ...item, manuallyRequested: true } : item) }, error: null, onPress() {},
})); });
assert.match(visible(), /自动识别已关闭/);
assert.match(visible(), /手动单张待处理 1 张/, '关闭时仍区分显式单张任务');
const allRecognized = { ...progress, items: Array.from({ length: 40 }, (_, index) =>
  row(`已识别猫${index}`, 'ready', index === 39 ? 'pending' : 'ready')) };
for (const compact of [true, false]) {
  const renderSummary = async nextProgress => {
    await act(async () => { renderer.update(React.createElement(StickerProcessingSummary, {
      progress: nextProgress, error: null, compact, onPress() {},
    })); });
  };
  await renderSummary(allRecognized);
  assert.match(visible(), /识别：识别完成.*40 \/ 40/);
  assert.match(visible(), /语义索引：有效 39 \/ 40 张 · 待建立 1 张/,
    '首页与聊天摘要同时显示识别完成和缺失索引，不能用识别完成代表全部处理完成');
  await renderSummary({ ...allRecognized, embeddingActivity: {
    kind: 'automatic', stickerIds: ['已识别猫39'], startedAt: '2026-11-02T00:00:00Z', completed: 0, total: 1,
  } });
  assert.match(visible(), /语义索引：有效 39 \/ 40 张 · 向量化中 · 当前 1 张/);
  await renderSummary({ ...allRecognized, embeddingCanBackfill: false,
    items: allRecognized.items.map(item => ({ ...item, hasEmbedding: false, vectorStatus: 'pending_rebuild' })) });
  assert.match(visible(), /语义索引：有效 0 \/ 40 张 · 待手动重建/);
  await renderSummary({ ...allRecognized, items: allRecognized.items.map((item, index) => index === 39
    ? { ...item, vectorStatus: 'failed', embeddingError: '向量服务报错' } : item) });
  assert.match(visible(), /1 张向量化失败，需手动补齐或重建/);
  await renderSummary({ ...allRecognized, embeddingModel: { status: 'unconfigured' },
    items: allRecognized.items.map(item => ({ ...item, hasEmbedding: false, vectorStatus: 'unconfigured' })) });
  assert.match(visible(), /语义索引：有效 0 \/ 40 张 · 未启用，使用关键词搜索/);
  await renderSummary({ ...allRecognized, embeddingModel: { status: 'incomplete' },
    items: allRecognized.items.map(item => ({ ...item, hasEmbedding: false, vectorStatus: 'unavailable' })) });
  assert.match(visible(), /语义索引：有效 0 \/ 40 张 · 向量模型不可用/);
  const fullyIndexed = { ...allRecognized, items: allRecognized.items.map(item =>
    ({ ...item, hasEmbedding: true, vectorStatus: 'ready' })) };
  await renderSummary(fullyIndexed);
  assert.match(visible(), /语义索引：有效 40 \/ 40 张 · 已齐全/);
  await renderSummary({ ...fullyIndexed, embeddingActivity: {
    kind: 'rebuild', stickerIds: [], startedAt: '2026-11-02T00:00:00Z', completed: 10, total: 40,
  } });
  assert.match(visible(), /语义索引：有效 40 \/ 40 张 · 重建中 10 \/ 40/,
    '旧索引仍然有效时也应显示正在进行的重建');
  await renderSummary({ ...allRecognized, automaticRecognitionEnabled: false });
  assert.match(visible(), /自动识别已关闭/);
  assert.match(visible(), /语义索引：有效 39 \/ 40 张 · 待建立 1 张/,
    '自动识别开关不隐藏独立的向量化进度');
}
await act(async () => { renderer.unmount(); });
const homeConfig = { automaticRecognitionEnabled: false, recognitionModelConfigId: 'vision', embeddingModelConfigId: 'embedding' };
let homeProgressReads = 0;
let homeLoadError = null;
let homeSaveError = null;
let homeProcessingListener = null;
let homeAppStateListener = null;
let homeProgressGate = null;
const getHomeProgress = async () => {
  homeProgressReads += 1;
  if (homeLoadError) throw homeLoadError;
  if (homeProgressGate) await homeProgressGate;
  return {
    ...progress,
    automaticRecognitionEnabled: homeConfig.automaticRecognitionEnabled,
    recognitionModel: homeConfig.recognitionModelConfigId ? {
      status: 'active', modelConfigId: homeConfig.recognitionModelConfigId,
      name: homeConfig.recognitionModelConfigId === 'vision-next' ? '新视觉模型' : '视觉模型', model: 'vision-model',
    } : { status: 'unconfigured', modelConfigId: null, name: null, model: null },
    embeddingModel: { ...progress.embeddingModel, modelConfigId: homeConfig.embeddingModelConfigId, name: '向量模型' },
  };
};
const notifyHomeProgress = () => homeProcessingListener?.();
const homeProgressHook = load('src/features/stickers/presentation/stickerSystem/useStickerProcessingProgress.ts', {
  'react-native': { AppState: { addEventListener: (_event, listener) => {
    homeAppStateListener = listener;
    return { remove: () => { homeAppStateListener = null; } };
  } } },
  'expo-router': { useFocusEffect: callback => React.useEffect(callback, [callback]) },
  '../../application/StickerProcessing': { getStickerProcessingProgress: getHomeProgress },
  '../../application/StickerProcessingSignal': { subscribeStickerProcessingChanged: listener => {
    homeProcessingListener = listener;
    return () => { homeProcessingListener = null; };
  } },
});
const Home = load('src/features/stickers/presentation/stickerSystem/StickerSystemScreen.tsx', {
  'react-native': { ...native, ScrollView: 'Scroll' }, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  'expo-router': { useFocusEffect: callback => React.useEffect(callback, [callback]) },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shared/ui': { ...ui, ListItem: 'ListItem', ModelPickerModal: 'ModelPicker', ToggleField: 'ToggleField' },
  '@shared/theme': { ThemedSurface: 'Surface', useTheme: () => ({ spacing: { lg: 16 }, colors: { text: { secondary: 'gray' } } }) },
  '../../application/StickerSystemModels': {
    listStickerModelCandidates: async () => [],
    setStickerAutomaticRecognitionEnabled: async enabled => {
      calls.push(['automatic', enabled]);
      if (homeSaveError) throw homeSaveError;
      homeConfig.automaticRecognitionEnabled = enabled;
      notifyHomeProgress();
    },
    setStickerRecognitionModel: async id => {
      if (homeSaveError) throw homeSaveError;
      homeConfig.recognitionModelConfigId = id;
      notifyHomeProgress();
    },
    setStickerEmbeddingModel: async id => {
      if (homeSaveError) throw homeSaveError;
      homeConfig.embeddingModelConfigId = id;
      notifyHomeProgress();
    },
  },
  './styles': { useStickerSystemStyles: () => ({}) }, './StickerSystemGroupsScreen': { default: 'Groups' },
  './StickerSystemLibraryScreen': { default: 'Library' }, './StickerProcessingSummary': { StickerProcessingSummary },
  './useStickerProcessingProgress': homeProgressHook,
}).default;
const homeToggle = () => renderer.root.findByType('ToggleField');
const homeModelItem = title => renderer.root.findAllByType('ListItem').find(item => item.props.title === title);
await act(async () => { renderer = create(React.createElement(Home, { onBack() {}, onOpenProgress() {} })); });
assert.equal(homeProgressReads, 1, '首页初次加载只读取进度快照，不再单独查询配置与模型选择');
assert.equal(homeToggle().props.value, false);
let releaseHomeProgress;
const beforeCoalescedReads = homeProgressReads;
homeProgressGate = new Promise(resolve => { releaseHomeProgress = resolve; });
homeConfig.automaticRecognitionEnabled = true;
homeProcessingListener();
homeConfig.automaticRecognitionEnabled = false;
homeProcessingListener();
homeProgressGate = null;
await act(async () => { releaseHomeProgress(); });
assert.equal(homeProgressReads, beforeCoalescedReads + 2, '读取期间的变更只补一次尾随读取');
assert.equal(homeToggle().props.value, false, '迟到的旧快照不能覆盖较新的事实');
homeConfig.automaticRecognitionEnabled = false;
await act(async () => { homeAppStateListener('active'); });
assert.equal(homeToggle().props.value, false, '回前台刷新首页配置和处理进度');
const beforeSaveReads = homeProgressReads;
await act(async () => { homeToggle().props.onValueChange(true); });
assert.equal(homeToggle().props.value, true);
assert.equal(homeProgressReads, beforeSaveReads + 1, '保存通知与显式等待共享同一次刷新');
assert.deepEqual(calls.pop(), ['automatic', true], '首页开关通过业务命令保存');

homeSaveError = new Error('模拟保存失败');
await act(async () => { homeToggle().props.onValueChange(false); });
assert.equal(homeToggle().props.value, true, '保存失败保留最后成功的配置快照');
assert.equal(dialogs.at(-1).title, '保存失败');
homeSaveError = null;

await act(async () => { homeModelItem('视觉识别模型').props.onPress(); });
assert.equal(renderer.root.findByType('ModelPicker').props.selectedModel, 'vision');
await act(async () => { renderer.root.findByType('ModelPicker').props.onSelect('vision-next'); });
assert.equal(homeConfig.recognitionModelConfigId, 'vision-next');
assert.equal(homeModelItem('视觉识别模型').props.subtitle, '新视觉模型', '模型保存后由同一进度快照更新名称');

homeLoadError = new Error('模拟刷新失败');
const beforeRefreshFailureDialogs = dialogs.length;
await act(async () => { homeToggle().props.onValueChange(false); });
assert.equal(homeToggle().props.value, true, '刷新失败不能把已展示的旧快照改成未保存的新值');
assert.match(visible(), /模拟刷新失败/, '保存成功但刷新失败时显示真实读取错误');
assert.equal(dialogs.length, beforeRefreshFailureDialogs, '刷新失败不再误报为保存失败');
homeLoadError = null;
await act(async () => { homeAppStateListener('active'); });
assert.equal(homeToggle().props.value, false);
assert.doesNotMatch(visible(), /模拟刷新失败/);
await act(async () => { renderer.unmount(); });
assert.equal(homeProcessingListener, null);
assert.equal(homeAppStateListener, null);

homeLoadError = new Error('模拟首页加载失败');
await act(async () => { renderer = create(React.createElement(Home, { onBack() {}, onOpenProgress() {} })); });
assert.equal(dialogs.at(-1).title, '加载失败');
assert.match(dialogs.at(-1).message, /模拟首页加载失败/);
assert.equal(homeToggle().props.disabled, true, '读取失败不能显示成可操作的默认关闭状态');
assert.equal(homeModelItem('视觉识别模型').props.subtitle, '状态读取失败');
homeLoadError = null;
await act(async () => { homeAppStateListener('active'); });
assert.equal(homeToggle().props.value, false, '首页加载失败后可由回前台操作恢复');
await act(async () => { renderer.unmount(); });
// 面板格子与管理弹窗共用处理快照；总览的真实 consumer 是管理弹窗，不再直接铺在格子下方。
let panelProgress = disabledProgress;
const panelTheme = { colors: { text: { secondary: 'gray' }, icon: { primary: 'black', secondary: 'gray' },
  feedback: { error: 'red' }, brand: { onPrimary: 'white' } } };
const Panel = load('src/features/chat/presentation/messages/components/ChatEmojiPanel.tsx', {
  'react-native': { ...native, ScrollView: 'Scroll' }, 'expo-image-picker': {}, 'expo-file-system/legacy': {},
  '@expo/vector-icons': { Ionicons: 'Icon' }, '@shared/ui': ui, '@platform/device': {},
  '@shared/theme': { useTheme: () => panelTheme, useThemedStyles: () => ({}) },
  '@features/stickers': {
    StickerProcessingSummary, StickerAnnotationStatus: annotationStatusModule.StickerAnnotationStatus,
    useStickerProcessingProgress: () => ({ progress: panelProgress, error: null }),
    useStickerProgressNavigation: () => () => {},
    listStickerGroups: async () => [], listStickers: async () => panelProgress.items.map(item => item.sticker),
    subscribeStickerAnnotationChanged: () => () => {},
    resolveStickerMedia: async id => ({ localUri: `file:///${id}.png` }),
  },
  './chatEmojiPanelStyles': { createChatEmojiPanelStyles: () => ({}), STICKER_GRID_COLUMNS: 5 },
  './StickerManagementModals': { __esModule: true, default: function ManagementModals({ managementVisible, progress, progressError, onProgressPress }) {
    return managementVisible ? React.createElement(StickerProcessingSummary, { progress, error: progressError, onPress: onProgressPress }) : null;
  } },
}).default;
await act(async () => { renderer = create(React.createElement(Panel, { height: 280 })); });
const manage = renderer.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === '管理表情包');
assert.ok(manage, '应提供管理表情包入口');
await act(async () => { manage.props.onPress(); });
assert.match(visible(), /自动识别已关闭/);
assert.doesNotMatch(visible(), /排队中|剩余/, '关闭时单张格子不把未识别图片画成排队中');
panelProgress = progress;
await act(async () => { renderer.update(React.createElement(Panel, { height: 280 })); });
assert.match(visible(), /剩余 1 张/);
assert.match(visible(), /排队中/);
panelProgress = { ...progress, items: progress.items.map(item => item.sticker.annotationStatus === 'pending'
  ? { ...item, sticker: { ...item.sticker, annotationStatus: 'processing' } } : item) };
await act(async () => { renderer.update(React.createElement(Panel, { height: 280 })); });
assert.match(visible(), /识别中/, '格子消费实时处理快照显示当前任务');
await act(async () => { renderer.unmount(); });
// 聊天编辑按实际保存用途提示必填项，普通编辑与部分保存不增加新的必填规则。
const formNative = { ...native, ScrollView: 'Scroll', Pressable: 'Pressable', TextInput: 'TextInput',
  StyleSheet: { absoluteFill: {} }, Modal: function VisibleModal({ visible, children }) {
    return visible ? React.createElement('Modal', {}, children) : null;
  } };
const formTheme = { ...panelTheme, colors: { ...panelTheme.colors, surface: { default: 'white' } } };
const Modals = load('src/features/chat/presentation/messages/components/StickerManagementModals.tsx', {
  'react-native': formNative, '@expo/vector-icons': { Ionicons: 'Icon' },
  '@features/stickers': { StickerProcessingSummary },
  '@shared/ui': { ...ui, KeyboardAvoidingContainer: 'KeyboardContainer' },
  '@shared/theme': { ThemedSurface: 'Surface', useTheme: () => formTheme, useThemedStyles: () => ({}) },
  './stickerManagementModalStyles': { STICKER_MODAL_CARD_RADIUS: 14, createStickerManagementModalStyles: () => ({}) },
}).default;
let formClosed = 0;
const formProps = { groups: [], stickerVisible: true, groupVisible: false,
  onStickerClose: () => formClosed++, onStickerSave: async input => calls.push(['modal-save', input]),
  onStickerDelete: async () => {}, onToggleFavorite: async () => {}, onGroupClose() {},
  onGroupCreate: async () => {}, onGroupRename: async () => {}, onGroupDelete: async () => {},
};
const formSticker = { ...row('待手填', 'failed', 'waiting_annotation').sticker, name: '', description: '', groupId: null, isFavorite: false };
await act(async () => { renderer = create(React.createElement(Modals, { ...formProps, sticker: formSticker })); });
let formName = renderer.root.findAllByType('Input').find(node => node.props.label.startsWith('名称'));
let formMeaning = renderer.root.findAllByType('Input').find(node => node.props.label.startsWith('含义/描述'));
assert.match(formName.props.label, /必填/);
assert.match(formMeaning.props.label, /必填/);
const beforeInvalidModal = calls.length;
await press('保存');
assert.equal(calls.length, beforeInvalidModal);
assert.equal(formClosed, 0, '未填写必填项时保留表单');
assert.match(formName.props.error, /请填写/);
assert.match(formMeaning.props.error, /请填写/);
await act(async () => { formName.props.onChangeText('安慰猫'); });
await press('保存');
assert.equal(calls.length, beforeInvalidModal, '只填名称仍不能完成手动识别');
await act(async () => { formMeaning.props.onChangeText('表达安慰和陪伴'); });
await press('保存');
assert.equal(calls.at(-1)[1].description, '表达安慰和陪伴');
assert.equal(formClosed, 1);
for (const status of ['ready', 'pending']) {
  await act(async () => { renderer.update(React.createElement(Modals, { ...formProps,
    sticker: { ...formSticker, annotationStatus: status, name: '普通编辑', description: '' } })); });
  formMeaning = renderer.root.findAllByType('Input').find(node => node.props.label.startsWith('含义/描述'));
  assert.match(formMeaning.props.label, /选填/);
  if (status === 'pending') assert.match(formMeaning.props.hint, /待手动填写/);
  await press('保存');
  assert.equal(calls.at(-1)[1].description, '', '普通编辑仍允许按原有规则保存部分信息');
}
await act(async () => { renderer.unmount(); });
// 图库编辑同样在提交前提示空名称，不把选填描述改成必填。
const Library = load('src/features/stickers/presentation/stickerSystem/StickerSystemLibraryScreen.tsx', {
  'react-native': native, '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shared/ui': { ...ui, EmptyState: 'EmptyState' },
  '@shared/theme': { ThemedSurface: 'Surface', useTheme: () => ({ ...formTheme, spacing: { lg: 16 } }) },
  '../../application/StickerCommands': { editStickerMetadata: async (id, input) => calls.push(['library-save', id, input]) },
  '../../application/StickerQueries': { listStickerGroups: async () => [],
    listStickers: async () => [{ ...formSticker, id: 'library-cat', annotationStatus: 'ready', name: '图库猫' }] },
  './styles': { useStickerSystemStyles: () => ({}) }, './StickerAnnotationStatus': annotationStatusModule,
  './StickerThumbnail': { StickerThumbnail: 'Thumbnail' },
  './useStickerProcessingProgress': { useStickerProcessingProgress: () => ({ progress }) },
}).default;
await act(async () => { renderer = create(React.createElement(Library)); });
await act(async () => { renderer.root.findByProps({ accessibilityLabel: '编辑「图库猫」' }).props.onPress(); });
formName = renderer.root.findAllByType('Input').find(node => node.props.label.startsWith('名称'));
await act(async () => { formName.props.onChangeText('   '); });
const beforeInvalidLibrary = calls.length;
await press('保存');
assert.equal(calls.length, beforeInvalidLibrary);
assert.match(formName.props.error, /请填写/);
await act(async () => { formName.props.onChangeText('图库猫'); });
await press('保存');
assert.equal(calls.at(-1)[0], 'library-save');
assert.equal(calls.at(-1)[2].description, '');
await act(async () => { renderer.unmount(); });
console.log('表情处理界面验证通过：排队与失败提示、逐张重试、手填含义、向量补齐、重建取消与摘要入口。');
