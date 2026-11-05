/** 验证记忆面板采样当前页面、场景隔离、交互可达性与普通主题表现。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (Object.hasOwn(dependencies, name)) {
      const dependency = dependencies[name];
      return Object.hasOwn(dependency, 'default') ? { __esModule: true, ...dependency } : dependency;
    }
    throw new Error(`缺少测试依赖 ${name}`);
  }, module, module.exports);
  return module.exports;
}

class AnimatedValue {
  constructor(value) { this.value = value; }
  stopAnimation() {}
}
const native = {
  View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal', TouchableOpacity: 'TouchableOpacity', TouchableWithoutFeedback: 'TouchableWithoutFeedback', FlatList: 'FlatList',
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  StyleSheet: { create: styles => styles, absoluteFill: { position: 'absolute', inset: 0 }, absoluteFillObject: { position: 'absolute', inset: 0 }, hairlineWidth: 0.5 },
  Animated: {
    Value: AnimatedValue, View: 'AnimatedView',
    timing: (value, { toValue }) => ({ start: () => { value.value = toValue; } }),
    parallel: animations => ({ start: callback => { animations.forEach(animation => animation.start()); callback?.({ finished: true }); }, stop() {} }),
  },
};
const glass = { LiquidGlassBackdrop: 'NativeBackdrop', LiquidGlassEffect: 'NativeGlass' };
const scene = load('src/shared/theme/components/GlassScene.tsx', { '../../../../modules/liquid-glass': glass });
const themes = Object.fromEntries(['defaultLight', 'defaultDark', 'liquidGlass'].map(name => {
  const theme = Object.values(load(`src/shared/theme/themes/${name}.ts`))[0];
  return [theme.id, theme];
}));
let theme = themes['liquid-glass'];
const themed = { ...scene, useTheme: () => theme, useThemedStyles: factory => factory(theme), getThemeById: id => themes[id] };
const surface = load('src/shared/theme/components/GlassSurface.tsx', {
  'react-native-reanimated': { default: { createAnimatedComponent: component => component } },
  'react-native': native, '../../../../modules/liquid-glass': glass, '../useTheme': themed, './GlassScene': scene,
});
Object.assign(themed, load('src/shared/theme/components/ThemedSurface.tsx', {
  'react-native': native, '../useTheme': themed, './GlassSurface': surface,
}));
const safeArea = { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ bottom: 0 }) };
native.Modal = function Modal(props) {
  React.useEffect(() => { props.onShow?.(); }, []);
  return props.visible ? React.createElement('Modal', props, props.children) : null;
};
const ModalSheet = load('src/shared/ui/ModalSheet.tsx', {
  'react-native': native, '@shared/theme': themed, 'react-native-safe-area-context': safeArea,
  './KeyboardAvoidingContainer': { default: 'KeyboardAvoidingContainer' },
}).default;
const styles = load('src/features/memory/presentation/memoryGalaxyStyles.ts', { 'react-native': native, '@shared/theme': themed });
const icons = Object.fromEntries(['Check', 'ChevronRight', 'Plus', 'Search', 'X', 'ChevronLeft', 'Settings2'].map(name => [name, name]));
const commands = { selectMemorySpace: async () => {}, addMemoryTrigger: async () => {} };
const vectorRequests = [];
commands.retryMemoryEmbedding = async (...args) => { vectorRequests.push(args); };
const ToggleField = load('src/shared/ui/ToggleField.tsx', {
  'react-native': native, '@shared/theme': themed, './Toggle': { default: 'Toggle' },
}).default;
const ui = { ModalSheet, ToggleField, AppTextInput: 'AppTextInput', HeaderAddButton: 'HeaderAddButton', showAppDialog: () => {} };
const Panel = load('src/features/memory/presentation/MemorySpacePanel.tsx', {
  'react-native': native, 'lucide-react-native': icons, '@shared/ui': ui, '@shared/theme': themed,
  '../domain/Memory': { normalizeMemoryText: text => text.trim(), memorySearchText: entry => entry.content },
  '../application/MemoryCommands': commands, './memoryGalaxyStyles': styles,
}).default;
const snapshot = {
  spaces: [{ assistantId: 'assistant-1', assistantName: '测试星球', poolId: 'pool-1' }],
  selectedSpace: { assistantId: 'assistant-1', assistantName: '测试星球', poolId: 'pool-1' },
  entries: [], triggers: [],
};
let readSnapshot = () => ({ snapshot, spaces: snapshot.spaces, error: null, refreshing: false, refresh() {} });
let reducedMotion = true;
const Screen = load('src/features/memory/presentation/MemoryScreen.tsx', {
  'react-native': native, 'react-native-safe-area-context': safeArea, 'lucide-react-native': icons,
  'expo-router': { useFocusEffect: callback => React.useEffect(callback, [callback]) },
  'react-native-reanimated': { useReducedMotion: () => reducedMotion }, '@shared/ui': ui, '@shared/theme': themed,
  '../application/MemoryCommands': commands, './memoryGalaxyStyles': styles,
  '@shared/ui/space': { GalaxyBackground: 'GalaxyBackground', ShootingStars: 'ShootingStars' }, './MemoryGalaxy': { default: 'MemoryGalaxy' },
  './MemorySpacePanel': { default: Panel }, './SplashOverlay': { default: 'SplashOverlay' },
  './useMemoryManagementSnapshot': { default: (...args) => readSnapshot(...args) },
}).default;
const props = { onBack() {}, onOpenSettings() {}, onCreateMemory() {}, onEditMemory() {}, onOpenTrigger() {} };
const flatten = style => Object.assign({}, ...[style].flat().filter(Boolean));

let renderer;
await act(async () => { renderer = create(React.createElement(scene.GlassBackdrop, { sceneId: 'decorative' }, '背景')); });
assert.equal(renderer.root.findByType('NativeBackdrop').props.pointerEvents, 'none', '装饰背景保持触摸穿透');
assert.equal(renderer.root.findByType('NativeBackdrop').props.importantForAccessibility, 'no-hide-descendants');
await act(async () => { renderer.unmount(); });

for (theme of Object.values(themes)) {
  await act(async () => { renderer = create(React.createElement(Screen, props)); });
  const layout = renderer.root.findAllByType('View').find(node => node.props.onLayout);
  await act(async () => { layout.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } }); });
  const source = renderer.root.findAllByType('NativeBackdrop')[0];
  if (theme.effects.glass.enabled) {
    assert.notEqual(source.props.sceneId, 'app', '记忆页独立于全局壁纸');
    assert.equal(source.props.pointerEvents, 'auto');
    assert.equal(source.props.accessibilityElementsHidden, false);
    assert.equal(source.props.importantForAccessibility, 'auto');
    source.findByType('GalaxyBackground');
    source.findByType('MemoryGalaxy');
  } else {
    assert.equal(source, undefined, '普通主题不注册玻璃背景源');
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await act(async () => { renderer.root.findByType('MemoryGalaxy').props.onSelect('assistant-1'); });
    assert.equal(renderer.root.findByType('MemoryGalaxy').props.paused, true);
    if (source) {
      const effect = renderer.root.findByType('NativeGlass');
      assert.equal(effect.props.sceneId, source.props.sceneId, '每次打开均采样当前记忆页');
      for (let ancestor = effect.parent; ancestor; ancestor = ancestor.parent) {
        assert.notEqual(ancestor, source, '弹窗不得进入自身的采样源');
      }
      assert.equal(flatten(renderer.root.findAllByType('Text').find(node => node.props.children === '测试星球').props.style).color, themes['default-dark'].colors.text.primary);
      assert.equal(renderer.root.findByType('AppTextInput').props.placeholderTextColor, themes['default-dark'].colors.text.secondary);
    } else {
      assert.equal(renderer.root.findAllByType('NativeGlass').length, 0);
      assert.equal(flatten(renderer.root.findAllByType('Text').find(node => node.props.children === '测试星球').props.style).color, theme.colors.text.primary);
    }
    await act(async () => { renderer.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === '收起记忆面板').props.onPress(); });
    assert.equal(renderer.root.findAllByType('Modal').length, 0);
  }
  if (source) {
    let second;
    await act(async () => { second = create(React.createElement(Screen, props)); });
    assert.notEqual(second.root.findByType('NativeBackdrop').props.sceneId, source.props.sceneId, '多个页面实例不能串场景');
    await act(async () => { second.unmount(); });
  }
  await act(async () => { renderer.unmount(); });
}
// 每条记忆的请求按钮只提交自己的 ID，等待中的任务不提供重复请求入口。
{
  const entry = { id: 'single-vector', content: '逐条向量化', summary: null, rememberedAt: '2026-11-01T00:00:00Z', embeddingStatus: 'not_requested' };
  let panel, row;
  const panelProps = { visible: true, snapshot: { ...snapshot, embeddingEnabled: true, entries: [entry] },
    onClose() {}, onCreateMemory() {}, onEditMemory() {}, onOpenTrigger() {}, refresh() {}, run: operation => operation() };
  await act(async () => { panel = create(React.createElement(Panel, panelProps)); });
  const renderItem = panel.root.findByType('FlatList').props.renderItem;
  for (const status of ['not_requested', 'ready', 'failed', 'pending', 'retry_wait']) {
    await act(async () => { row = create(renderItem({ item: { ...entry, embeddingStatus: status } })); });
    const button = row.root.findByProps({ accessibilityLabel: '请求这条记忆的向量化：逐条向量化' });
    assert.equal(button.props.disabled, status === 'pending' || status === 'retry_wait');
    if (status === 'not_requested') await act(async () => { await button.props.onPress(); });
    await act(async () => { row.unmount(); });
  }
  assert.deepEqual(vectorRequests, [['assistant-1', 'single-vector']]);
  await act(async () => { panel.update(React.createElement(Panel, { ...panelProps, snapshot: { ...panelProps.snapshot, embeddingEnabled: false } })); });
  await act(async () => { row = create(panel.root.findByType('FlatList').props.renderItem({ item: entry })); });
  assert.equal(row.root.findByProps({ accessibilityLabel: '请求这条记忆的向量化：逐条向量化' }).props.disabled, true);
  await act(async () => { row.unmount(); panel.unmount(); });

  // 详情请求只处理已保存条目，不提交当前草稿，也不强制返回列表。
  const editorNative = { ...native, TextInput: 'TextInput', ScrollView: 'ScrollView' };
  const editorStyles = load('src/features/memory/presentation/memoryScreenStyles.ts', { 'react-native': editorNative });
  const Editor = load('src/features/memory/presentation/MemoryEditorScreen.tsx', {
    'react-native': editorNative, 'react-native-safe-area-context': safeArea, '@shared/theme': themed,
    '@shared/ui': { ...ui, NavigationHeader: 'NavigationHeader', KeyboardAvoidingContainer: 'KeyboardAvoidingContainer', useBusyBackHandler() {} },
    '../application/MemoryCommands': commands, './memoryScreenStyles': editorStyles,
    './useMemoryManagementSnapshot': { default: () => ({ snapshot: panelProps.snapshot, error: null }) },
  }).default;
  let backCount = 0;
  await act(async () => { row = create(React.createElement(Editor, { assistantId: 'assistant-1', memoryId: entry.id, onBack: () => { backCount++; } })); });
  await act(async () => { row.root.findByProps({ placeholder: '写下值得记住的内容…' }).props.onChangeText('尚未保存的草稿'); });
  await act(async () => { row.root.findByProps({ accessibilityLabel: '向量化这条记忆' }).props.onPress(); });
  assert.deepEqual(vectorRequests, [['assistant-1', 'single-vector'], ['assistant-1', 'single-vector']]);
  assert.equal(row.root.findByProps({ placeholder: '写下值得记住的内容…' }).props.value, '尚未保存的草稿');
  assert.equal(backCount, 0);
  await act(async () => { row.unmount(); });
}

// 切换空间时保留星空，过期请求不得覆盖当前空间。
const pending = [];
const subscribers = new Set();
const useSnapshot = load('src/features/memory/presentation/useMemoryManagementSnapshot.ts', {
  '../application/MemoryQueries': {
    getMemoryManagementSnapshot: assistantId => new Promise(resolve => pending.push({ assistantId, resolve })),
  },
  '../application/MemorySignals': { subscribeMemoryChanged: listener => { subscribers.add(listener); return () => subscribers.delete(listener); } },
}).default;
let current;
function SnapshotConsumer({ assistantId }) {
  current = useSnapshot(assistantId);
  return null;
}
const details = { ...snapshot, entries: [{ id: 'memory-1', content: '测试正文' }] };
await act(async () => { renderer = create(React.createElement(SnapshotConsumer, {})); });
await act(async () => { pending.shift().resolve(details); });
assert.equal(current.snapshot.entries[0].content, '测试正文');
await act(async () => { renderer.update(React.createElement(SnapshotConsumer, { assistantId: 'assistant-1' })); });
assert.equal(current.snapshot, null, '切换请求身份时不展示旧详情');
assert.equal(current.spaces, details.spaces);
const previousRequest = pending.shift();
await act(async () => { renderer.update(React.createElement(SnapshotConsumer, { assistantId: 'assistant-2' })); });
await act(async () => { previousRequest.resolve(details); });
assert.equal(current.snapshot, null, '过期请求不能覆盖当前空间');
await act(async () => { pending.shift().resolve({ ...details, selectedSpace: { ...details.selectedSpace, assistantId: 'assistant-2' } }); });
assert.equal(current.snapshot.selectedSpace.assistantId, 'assistant-2');
await act(async () => { renderer.unmount(); });
assert.equal(subscribers.size, 0);

// 默认空间在开屏期间准备；开关已加载的面板不应重新排队读取。
readSnapshot = useSnapshot;
await act(async () => { renderer = create(React.createElement(Screen, props)); });
await act(async () => { pending.shift().resolve(details); });
for (let attempt = 0; attempt < 2; attempt++) {
  await act(async () => { renderer.root.findByType('MemoryGalaxy').props.onSelect('assistant-1'); });
  assert.equal(pending.length, 0, '打开已准备的默认空间无需重新加载');
  assert.equal(renderer.root.findByType(Panel).props.snapshot.entries[0].content, '测试正文');
  await act(async () => { renderer.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === '收起记忆面板').props.onPress(); });
  assert.equal(pending.length, 0, '关闭面板保留已经读取的详情');
}
await act(async () => { renderer.unmount(); });
assert.equal(subscribers.size, 0);

// 开场与重视图挂载错开，准备完成前不能揭开遮罩。
reducedMotion = false;
await act(async () => { renderer = create(React.createElement(Screen, props)); });
assert.equal(renderer.root.findAllByType('MemoryGalaxy').length, 0);
await act(async () => { pending.shift().resolve(details); });
assert.equal(renderer.root.findAllByType('MemoryGalaxy').length, 0, '数据先返回也不能打断固定开场');
await act(async () => { renderer.root.findByType('SplashOverlay').props.onPrepare(); });
renderer.root.findByType('MemoryGalaxy');
assert.equal(renderer.root.findByType('SplashOverlay').props.ready, false, '视图尚未布局时保持遮罩');
await act(async () => { renderer.root.findAllByType('View').findLast(node => node.props.onLayout).props.onLayout(); });
assert.equal(renderer.root.findByType('SplashOverlay').props.ready, true);
await act(async () => { renderer.root.findByType('SplashOverlay').props.onFinish(); });
assert.equal(renderer.root.findAllByType('SplashOverlay').length, 0);
assert.equal(renderer.root.findByType('MemoryGalaxy').props.paused, false);
await act(async () => { renderer.unmount(); });
// 数据慢于开场时也只等待事实完成，不以超时猜测就绪。
await act(async () => { renderer = create(React.createElement(Screen, props)); });
await act(async () => { renderer.root.findByType('SplashOverlay').props.onPrepare(); });
assert.equal(renderer.root.findAllByType('MemoryGalaxy').length, 0);
assert.equal(renderer.root.findByType('SplashOverlay').props.ready, false);
await act(async () => { pending.shift().resolve(details); });
await act(async () => { renderer.root.findAllByType('View').findLast(node => node.props.onLayout).props.onLayout(); });
assert.equal(renderer.root.findByType('SplashOverlay').props.ready, true);
await act(async () => { renderer.unmount(); });
reducedMotion = true;

// 驱动真实开屏组件的动画完成回调，确保固定开场不会按时钟自行揭开页面。
const animationValues = [];
const Splash = load('src/features/memory/presentation/SplashOverlay.tsx', {
  'react-native': native, '@shared/theme': themed,
  'react-native-reanimated': {
    default: { View: 'AnimatedView', Text: 'AnimatedText' },
    useReducedMotion: () => false,
    useSharedValue: initial => {
      const ref = React.useRef(null);
      if (ref.current === null) { ref.current = { value: initial }; animationValues.push(ref.current); }
      return ref.current;
    },
    useAnimatedStyle: () => ({}), cancelAnimation() {}, runOnJS: callback => callback,
    withTiming: (value, options, completed) => ({ value, options, completed }),
    withSequence: (...steps) => ({ steps }), withDelay: (_duration, animation) => animation,
    Easing: { cubic: 'cubic', out: easing => easing, in: easing => easing },
  },
}).default;
let prepared = 0;
let finished = 0;
const splashProps = { active: true, ready: false, onPrepare: () => { prepared++; }, onFinish: () => { finished++; } };
await act(async () => { renderer = create(React.createElement(Splash, splashProps)); });
assert.equal(finished, 0);
await act(async () => { animationValues[1].value.steps.at(-1).completed(true); });
assert.equal(prepared, 1);
assert.equal(finished, 0, '开场完成后等页面准备，不自行淡出');
await act(async () => { renderer.update(React.createElement(Splash, { ...splashProps, ready: true })); });
assert.equal(finished, 0, '页面准备好后仍等待淡出完成');
await act(async () => { animationValues[4].value.completed(true); });
assert.equal(finished, 1);
await act(async () => { renderer.unmount(); });

// 物理像素预算不随高密度屏幕放大，前景远星仍按完整视口绘制。
let density = 1;
const background = load('src/shared/ui/space/GalaxyBackground.tsx', {
  'react-native': { ...native, PixelRatio: { get: () => density } },
  'react-native-reanimated': {
    default: { View: 'AnimatedView' }, useSharedValue: value => React.useRef({ value }).current,
    useAnimatedStyle: callback => callback(), cancelAnimation() {},
  },
  'react-native-svg': { default: 'Svg', ...Object.fromEntries(['Defs', 'Ellipse', 'FeColorMatrix', 'Filter', 'Image', 'Path', 'RadialGradient', 'Rect', 'Stop'].map(name => [name, name])) },
  '@shared/theme': themed,
  './starField': load('src/shared/ui/space/starField.ts'),
  './assets/orion-nebula.jpg': 1,
}).default;
for (const viewport of [{ width: 400, height: 800, density: 1 }, { width: 400, height: 900, density: 3.5 }, { width: 900, height: 400, density: 3 }]) {
  density = viewport.density;
  await act(async () => { renderer = create(React.createElement(background, { width: viewport.width, height: viewport.height, paused: true })); });
  const nebula = renderer.root.findAllByType('Svg').find(node => node.findAllByType('Filter').length > 0);
  assert.ok(Math.max(nebula.props.width, nebula.props.height) * density <= 512.001, '星云滤镜必须遵守物理像素预算');
  assert.ok(Math.abs(nebula.props.width / nebula.props.height - viewport.width / viewport.height) < 0.001, '星云保持视口比例');
  const stars = renderer.root.findAllByType('Svg').find(node => node !== nebula);
  assert.equal(stars.props.width, viewport.width);
  assert.equal(stars.props.height, viewport.height);
  await act(async () => { renderer.unmount(); });
}
console.log('记忆呈现验证通过：玻璃场景、开屏准备与布局就绪、面板复用及请求隔离、星云物理像素预算。');
