/** 公共滑杆的快速松手、中断、小数步长及悬浮球与模型字段接入回归。 */
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

function load(file, dependencies) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`缺少测试依赖 ${name}`);
  }, module, module.exports);
  return module.exports;
}

const theme = {
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 }, radius: { sm: 4, md: 8, lg: 12 },
  colors: { text: { primary: '#111', secondary: '#444', tertiary: '#777' }, surface: { default: '#fff', muted: '#eee' }, background: { app: '#fff' }, border: { light: '#ddd', default: '#ccc' }, brand: { primary: '#66f' }, feedback: { error: '#f00' } },
};
const alerts = [];
const native = {
  ...Object.fromEntries(['View', 'Text', 'TextInput', 'Image', 'TouchableOpacity', 'ActivityIndicator'].map((name) => [name, name])),
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 }, PixelRatio: { get: () => 2.625 },
};
const themed = { useTheme: () => theme, useThemedStyles: (factory) => factory(theme), ThemedSurface: 'Surface' };
// 模拟原生 Pan 的公开事件契约：只有激活后才有 onEnd，中断时 success=false。
function pan() {
  const gesture = { config: {}, handlers: {} };
  for (const name of ['enabled', 'minDistance', 'runOnJS', 'activeOffsetX', 'failOffsetY', 'maxDistance']) {
    gesture[name] = (value) => { gesture.config[name] = value; return gesture; };
  }
  for (const name of ['onStart', 'onUpdate', 'onEnd']) {
    gesture[name] = (callback) => { gesture.handlers[name] = callback; return gesture; };
  }
  return gesture;
}
let skins = [
  { id: 'builtin-minimal', name: '鸦鸦', source: 'builtin', mimeType: 'image/png', selected: true, sizeDp: 56 },
  { id: 'user-b', name: '装扮 B', source: 'user', mimeType: 'image/png', uri: 'file:///b.png', selected: false, sizeDp: 80 },
];
const saved = [];
let finishSave;
const application = {
  listBubbleSkins: async () => structuredClone(skins),
  selectBubbleSkin: async (id) => { skins = skins.map((skin) => ({ ...skin, selected: skin.id === id })); },
  setBubbleSize: async (id, sizeDp) => {
    saved.push({ id, sizeDp });
    await new Promise((resolve) => { finishSave = resolve; });
    skins = skins.map((skin) => skin.id === id ? { ...skin, sizeDp } : skin);
    return { ...skins.find((skin) => skin.id === id) };
  },
};
const styles = load('src/features/floatingLayer/presentation/BubbleSkinSettings.styles.ts', { 'react-native': native });
const { default: Slider } = load('src/shared/ui/Slider.tsx', {
  '@shared/theme': themed, 'react-native': native,
  'react-native-gesture-handler': { Gesture: { Pan: pan, Tap: pan, Race: (drag, tap) => ({ drag, tap }) }, GestureDetector: 'GestureDetector' },
});
const { BubbleSkinSettings } = load('src/features/floatingLayer/presentation/BubbleSkinSettings.tsx', {
  '@shared/theme': themed, '@shared/ui': { Button: 'Button', MimeAwareImage: 'MimeAwareImage', ModalSheet: 'ModalSheet', Slider, showAppDialog: (dialog) => alerts.push(dialog) },
  'react-native': native,
  'expo-document-picker': {}, 'react-native-svg': { SvgUri: 'SvgUri' },
  'lucide-react-native': Object.fromEntries(['Check', 'Minus', 'Pencil', 'Plus', 'Trash2', 'Upload'].map((name) => [name, name])),
  '../application': application, './BubbleSkinSettings.styles': styles, '../../../../assets/yaya.png': 'yaya',
});
let renderer;
await act(async () => { renderer = create(React.createElement(BubbleSkinSettings)); });
const sliderView = (label) => renderer.root.findAllByType('View').find((node) => node.props.accessibilityRole === 'adjustable' && node.props.accessibilityLabel === label);
const slider = () => sliderView('当前皮肤大小');
const gesture = () => renderer.root.findByType('GestureDetector').props.gesture.drag;
const tapGesture = () => renderer.root.findByType('GestureDetector').props.gesture.tap;
const size = () => slider().props.accessibilityValue.now;
const finish = async () => { await act(async () => { finishSave(); }); };
const select = async (name) => {
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: `选择装扮${name}` }).props.onPress(); });
  await act(async () => { slider().props.onLayout({ nativeEvent: { layout: { width: 200 } } }); });
};
await select('鸦鸦');

// 快速手势可能没有派发终点 move；松手事件必须决定最终值，保存期间也不能回退。
const fast = gesture();
await act(async () => {
  fast.handlers.onStart({ x: 75 });
  fast.handlers.onUpdate({ x: 137.5 });
  fast.handlers.onEnd({ x: 175 }, true);
});
assert.equal(size(), 88);
assert.equal(gesture().config.enabled, false, '保存期间暂停新手势');
assert.deepEqual(saved[0], { id: 'builtin-minimal', sizeDp: 88 });
await finish();
assert.equal(size(), 88);

// 系统中断的坐标不能覆盖最后有效 move，更不能恢复旧的 88。
const interrupted = gesture();
await act(async () => {
  interrupted.handlers.onStart({ x: 175 });
  interrupted.handlers.onUpdate({ x: 50 });
  interrupted.handlers.onEnd({ x: 0 }, false);
});
assert.equal(size(), 48);
assert.deepEqual(saved[1], { id: 'builtin-minimal', sizeDp: 48 });
await finish();
assert.equal(size(), 48);

// 手指越过轨道时夹在边界；滑到边缘再反向移动仍可继续调节。
const reversed = gesture();
await act(async () => {
  reversed.handlers.onStart({ x: -20 });
  reversed.handlers.onUpdate({ x: 260 });
});
assert.equal(size(), 96);
await act(async () => { reversed.handlers.onUpdate({ x: 100 }); });
assert.equal(size(), 64);
assert.equal(saved.length, 2, '拖动期间不提交');
await act(async () => { reversed.handlers.onEnd({ x: 100 }, true); });
await finish();

await select('装扮 B');
assert.equal(size(), 80);
const tap = tapGesture();
await act(async () => { tap.handlers.onEnd({ x: 0 }, true); });
assert.equal(size(), 32);
assert.deepEqual(saved[3], { id: 'user-b', sizeDp: 32 });
await finish();
await select('鸦鸦');
assert.equal(size(), 64, '切换后恢复该皮肤自己的大小');
assert.deepEqual(alerts, []);
await act(async () => { renderer.unmount(); });
console.log('悬浮球大小手势回归通过：快速松手、系统中断、越界反向拖动、点击与各皮肤独立保存。');

const { default: SliderField } = load('src/shared/ui/SliderField.tsx', {
  '@shared/theme': themed, 'react-native': native, './Slider': { __esModule: true, default: Slider },
});
const modelWrites = [];
const manualInputs = [];
let blurs = 0;
function ModelField({ min = 0, max = 2, step = 0.1, initialValue = 0.7, initialInput = '0.7', disabled = false, error }) {
  const [value, setValue] = React.useState(initialValue);
  const [input, setInput] = React.useState(initialInput);
  return React.createElement(SliderField, {
    label: '模型参数', value, inputValue: input, min, max, step, disabled, error,
    onInputChange: (next) => { manualInputs.push(next); setInput(next); },
    onSetValue: (next) => { modelWrites.push(next); setValue(next); setInput(String(next)); },
    onBlur: () => { blurs++; },
  });
}
const modelInput = () => renderer.root.findByType('TextInput');
const modelSize = () => sliderView('模型参数').props.accessibilityValue.now;
const layout = async () => {
  await act(async () => { sliderView('模型参数').props.onLayout({ nativeEvent: { layout: { width: 200 } } }); });
};
await act(async () => { renderer = create(React.createElement(ModelField)); });
await layout();
const temperature = gesture();
await act(async () => { temperature.handlers.onStart({ x: 70 }); temperature.handlers.onUpdate({ x: 29 }); });
assert.equal(modelSize(), 0.3, '小数步长去掉浮点尾数');
assert.equal(modelInput().props.value, '0.3', '数值框实时展示拖动预览');
assert.deepEqual(modelWrites, [], '拖动过程不写入模型配置');
assert.deepEqual(manualInputs, [], '滑杆预览不冒充手动输入');
await act(async () => { temperature.handlers.onEnd({ x: 134 }, true); });
assert.deepEqual(modelWrites, [1.3]);
assert.equal(modelInput().props.value, '1.3');

// 通用滑杆不解析非法文本，也不把可空参数的空字符串改成默认值。
await act(async () => { modelInput().props.onChangeText('3.9'); modelInput().props.onBlur(); });
assert.deepEqual(manualInputs, ['3.9']);
assert.equal(blurs, 1);
await act(async () => { renderer.update(React.createElement(ModelField, { error: '超出范围' })); });
assert.equal(modelInput().props.value, '3.9');
assert.equal(modelSize(), 1.3, '合法的数值投影由调用方持有');
assert.ok(renderer.root.findAllByType('Text').some((node) => node.props.accessibilityRole === 'alert' && node.props.children === '超出范围'));
await act(async () => { modelInput().props.onChangeText(''); });
assert.equal(modelInput().props.value, '');
assert.deepEqual(modelWrites, [1.3]);

// 同一组件支持不同业务范围与精度，禁用及读屏调整也遵守调用方契约。
await act(async () => { renderer.update(React.createElement(ModelField, { key: 'top-p', max: 1, step: 0.01, initialValue: 0, initialInput: '' })); });
await layout();
assert.equal(modelInput().props.value, '');
const topP = gesture();
await act(async () => { topP.handlers.onStart({ x: 0 }); topP.handlers.onUpdate({ x: 66 }); topP.handlers.onEnd({ x: 199 }, true); });
assert.equal(modelSize(), 1);
assert.deepEqual(modelWrites, [1.3, 1]);
await act(async () => { sliderView('模型参数').props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }); });
assert.equal(modelSize(), 0.99);
assert.equal(modelWrites.at(-1), 0.99);
await act(async () => { renderer.update(React.createElement(ModelField, { key: 'top-p', max: 1, step: 0.01, disabled: true })); });
assert.equal(gesture().config.enabled, false);
assert.equal(modelInput().props.editable, false);
const writesBeforeDisabledAction = modelWrites.length;
await act(async () => { sliderView('模型参数').props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); });
assert.equal(modelWrites.length, writesBeforeDisabledAction);
// 留空保留可交互的空轨道；输入框没有占位文案，也不绘制数值填充和滑块。
await act(async () => { renderer.update(React.createElement(ModelField, { key: 'provider-default', initialValue: null, initialInput: '' })); });
assert.equal(modelInput().props.value, '');
assert.equal(modelInput().props.placeholder, undefined);
assert.equal(modelInput().props.editable, true);
assert.equal(renderer.root.findAllByType(Slider).length, 1);
assert.deepEqual(sliderView('模型参数').props.accessibilityValue, { min: 0, max: 2, text: '未设置' });
const blueParts = () => sliderView('模型参数').findAllByType('View').filter((node) =>
  [node.props.style].flat().some((style) => style?.backgroundColor === theme.colors.brand.primary));
assert.equal(blueParts().length, 0);
await layout();
const emptyTrack = gesture();
const writesBeforeEmptyDrag = modelWrites.length;
await act(async () => { emptyTrack.handlers.onStart({ x: 60 }); });
assert.equal(modelInput().props.value, '0.6');
assert.equal(blueParts().length, 2);
assert.equal(modelWrites.length, writesBeforeEmptyDrag, '空轨道横向激活后只预览，不提前保存');
await act(async () => { emptyTrack.handlers.onEnd({ x: 80 }, true); });
assert.equal(modelWrites.at(-1), 0.8);
assert.equal(modelInput().props.value, '0.8');
await act(async () => { modelInput().props.onChangeText('0.6'); });
assert.equal(modelInput().props.value, '0.6');
await act(async () => { renderer.update(React.createElement(ModelField, { key: 'explicit-zero', initialValue: 0, initialInput: '0' })); });
assert.equal(modelInput().props.value, '0');
assert.equal(renderer.root.findAllByType(Slider).length, 1);
await act(async () => { renderer.unmount(); });
console.log('公共滑杆及模型字段验证通过：小数步长、实时预览、松手提交、非法/空文本保留、范围与禁用及读屏操作。');
