/** 公共输入契约：受控草稿、原生焦点、显式密码模式和窗口键盘监听生命周期。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(import.meta.dirname, '..');
function load(file, dependencies) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((id) => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    throw new Error(`未装配的输入验证依赖 ${id}`);
  }, module, module.exports);
  return module.exports;
}
const listeners = new Map();
let keyboard;
let frame = { y: 0, height: 800 };
let deferMeasurements = false;
const measurements = [];
const windowNative = { measureInWindow(callback) {
  const measured = { ...frame };
  const complete = () => callback(0, measured.y, 400, measured.height);
  if (deferMeasurements) measurements.push(complete); else complete();
} };
const native = {
  TextInput: 'Input', Text: 'Text', View: 'View',
  StyleSheet: { create: (styles) => styles, compose: (a, b) => [a, b] },
  Keyboard: {
    metrics() { assert.equal(this, native.Keyboard); return keyboard; },
    addListener(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      const subscriptions = listeners.get(event);
      subscriptions.add(callback);
      return { remove() { subscriptions.delete(callback); if (!subscriptions.size) listeners.delete(event); } };
    },
  },
};
const theme = { colors: { text: { primary: '#111', secondary: '#444', tertiary: '#777' }, surface: { input: '#eee' }, feedback: { error: '#f00' } },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 }, radius: { md: 8 } };
const dependencies = { 'react-native': native, '@shared/theme': { useTheme: () => theme, useThemedStyles: (factory) => factory(theme) } };
const inputModule = load('src/shared/ui/AppTextInput.tsx', dependencies);
const Input = inputModule.default;
const Field = load('src/shared/ui/InputField.tsx', { ...dependencies, './AppTextInput': inputModule }).default;
const Container = load('src/shared/ui/KeyboardAvoidingContainer.tsx', dependencies).default;
let rendered;

// 页面仍拥有草稿；输入控件转发编辑和原生焦点，不因父组件更新重建原生输入。
const ref = React.createRef();
const inputNative = { focused: false, focus() { this.focused = true; }, blur() { this.focused = false; } };
const changes = [];
function Editor({ enabled = true }) {
  const [value, setValue] = React.useState('第一行');
  return React.createElement(Container, { enabled, testID: 'window' }, React.createElement(Input, {
    ref, value, autoGrow: true, onChangeText: (text) => { changes.push(text); setValue(text); },
  }));
}
await act(async () => { rendered = create(React.createElement(Editor), { createNodeMock: (element) => element.type === 'Input' ? inputNative : windowNative }); });
const windowView = () => rendered.root.findAllByType('View').find(node => node.props.testID === 'window');
const keyboardHeight = () => Object.assign({}, ...windowView().props.style).height;
const emit = async (event, coordinates) => {
  keyboard = event === 'keyboardDidShow' ? coordinates : undefined;
  await act(async () => { for (const listener of listeners.get(event)) listener({ endCoordinates: coordinates }); });
};
const showKeyboard = () => emit('keyboardDidShow', { screenY: 500, screenX: 0, width: 400, height: 300 });
const layout = async (nextFrame) => {
  frame = nextFrame;
  await act(async () => windowView().props.onLayout({ nativeEvent: { layout: { y: 0, height: frame.height } } }));
};
ref.current.focus();
await act(async () => rendered.root.findByType('Input').props.onChangeText('第一行\n第二行'));
assert.deepEqual(changes, ['第一行\n第二行']);
assert.equal(rendered.root.findByType('Input').props.value, '第一行\n第二行');
assert.equal(rendered.root.findByType('Input').props.multiline, true);
assert.equal(ref.current, inputNative);
assert.equal(ref.current.focused, true);
for (let cycle = 0; cycle < 3; cycle++) {
  await showKeyboard();
  assert.equal(keyboardHeight(), 500, '容器底边直接与键盘顶边对齐');
  await emit('keyboardDidHide', { screenY: 400, height: 0 });
  assert.equal(keyboardHeight(), undefined, '隐藏事件即使携带旧坐标也恢复原始布局');
  assert.equal(rendered.root.findByType('Input').props.value, '第一行\n第二行');
}
await act(async () => rendered.update(React.createElement(Editor, { enabled: false })));
assert.equal(listeners.size, 0, '窗口关闭后释放键盘监听');
keyboard = { screenY: 500, screenX: 0, width: 400, height: 300 };
await act(async () => rendered.update(React.createElement(Editor)));
assert.equal(keyboardHeight(), 500, '接入已打开键盘的改写窗口时读取当前键盘位置');
await layout({ y: 0, height: 500 });
assert.equal(keyboardHeight(), 500, '原生窗口已缩到键盘上方时保持相同底边');
await layout({ y: 120, height: 500 });
assert.equal(keyboardHeight(), 380, '局部 onLayout 的 y 为零时仍使用窗口实际起点');
await layout({ y: 0, height: 800 });
assert.equal(keyboardHeight(), 500, '窗口恢复全屏时底边仍不重复扣除键盘高度');
deferMeasurements = true;
await showKeyboard();
await emit('keyboardDidHide', { screenY: 500, height: 0 });
await act(async () => measurements.splice(0).forEach(complete => complete()));
assert.equal(keyboardHeight(), undefined, '隐藏后晚到的测量不能恢复受限高度');
await showKeyboard();
await layout({ y: 0, height: 500 });
await act(async () => measurements.splice(0).reverse().forEach(complete => complete()));
assert.equal(keyboardHeight(), 500, '窗口缩放后旧测量逆序返回也不能移动键盘边界');
await showKeyboard();
await act(async () => rendered.update(React.createElement(Editor, { enabled: false })));
await act(async () => measurements.splice(0).forEach(complete => complete()));
assert.equal(keyboardHeight(), undefined, '退出窗口后不再接受旧测量');
deferMeasurements = false;
await act(async () => rendered.unmount());
assert.equal(listeners.size, 0, '窗口卸载后释放键盘监听');
assert.equal(ref.current, null);

// 原生窗口可先于 React 组件退场；其余窗口的键盘事件不能测量已脱离的 View。
let nativeViewAttached = false;
const DetachableView = React.forwardRef(function DetachableView(props, nativeRef) {
  const attached = nativeViewAttached;
  React.useImperativeHandle(nativeRef, () => attached ? windowNative : null, [attached]);
  return React.createElement('DetachedWindow', props);
});
const DetachableContainer = load('src/shared/ui/KeyboardAvoidingContainer.tsx', {
  ...dependencies, 'react-native': { ...native, View: DetachableView },
}).default;
keyboard = undefined;
frame = { y: 0, height: 800 };
await act(async () => { rendered = create(React.createElement(DetachableContainer)); });
await showKeyboard();
const detachedWindow = () => rendered.root.findByType('DetachedWindow');
const detachedHeight = () => Object.assign({}, ...detachedWindow().props.style).height;
assert.equal(detachedHeight(), undefined, '没有原生 View 的保留页面忽略其他窗口的键盘事件');
nativeViewAttached = true;
await act(async () => { rendered.update(React.createElement(DetachableContainer)); });
await act(async () => { detachedWindow().props.onLayout({ nativeEvent: { layout: { y: 0, height: 800 } } }); });
assert.equal(detachedHeight(), 500, '原生 View 重新接入后按实际键盘位置避让');
deferMeasurements = true;
frame = { y: 0, height: 700 };
await showKeyboard();
nativeViewAttached = false;
await act(async () => { rendered.update(React.createElement(DetachableContainer)); });
await act(async () => { measurements.splice(0).forEach(complete => complete()); });
assert.equal(detachedHeight(), 500, '原生 View 退场立即作废在途测量，不等待 effect 清理');
await showKeyboard();
deferMeasurements = false;
await act(async () => { rendered.unmount(); });
assert.equal(listeners.size, 0);

// 底部弹窗铺满独立原生窗口，直接使用屏幕键盘顶边，不受原生平移和缩放坐标影响。
const modalTheme = load('src/shared/theme/themes/defaultLight.ts', {}).defaultLightTheme;
const modalNative = {
  ...native, TouchableOpacity: 'Button', TouchableWithoutFeedback: 'Backdrop',
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  Modal: function Modal({ onShow, children }) {
    React.useEffect(() => { onShow(); }, [onShow]);
    return React.createElement('Modal', {}, children);
  },
  Animated: {
    Value: class { constructor(value) { this.value = value; } }, View: 'AnimatedView',
    timing: (value, { toValue }) => ({ start() { value.value = toValue; } }),
    parallel: animations => ({ start(callback) { animations.forEach(animation => animation.start()); callback({ finished: true }); }, stop() {} }),
  },
};
const ModalSheet = load('src/shared/ui/ModalSheet.tsx', {
  'react-native': modalNative,
  '@shared/theme': { useTheme: () => modalTheme, useThemedStyles: factory => factory(modalTheme), ThemedSurface: 'Surface' },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
  './KeyboardAvoidingContainer': { __esModule: true, default: props => React.createElement(Container, { ...props, testID: 'window' }) },
}).default;
const MessageEditor = load('src/features/chat/presentation/messages/components/ChatMessageEditor.tsx', {
  ...dependencies,
  '@shared/ui': { ModalSheet, InputField: Field, Button: 'Button' },
  '../../../messages/application/EditChatMessage': { editChatMessage: async () => { throw new Error('布局回归不应提交消息'); } },
}).default;
for (let cycle = 0; cycle < 3; cycle++) {
  frame = { y: 0, height: 800 };
  keyboard = { screenY: 500, screenX: 0, width: 400, height: 300 };
  await act(async () => { rendered = create(React.createElement(MessageEditor, {
    message: { id: 1, text: '待改写的 AI 正文' }, onClose() {}, onSaved() {},
  }), { createNodeMock: () => windowNative }); });
  await layout({ y: 160, height: 640 });
  assert.equal(keyboardHeight(), 500, '系统平移窗口时弹窗底边仍保持在键盘顶边');
  const editorInput = rendered.root.findByType('Input');
  await act(async () => editorInput.props.onChangeText('修改后的 AI 正文'));
  await showKeyboard();
  assert.equal(keyboardHeight(), 500, '编辑和重复键盘事件不会引入额外空白');
  assert.equal(editorInput.props.value, '修改后的 AI 正文');
  assert.equal(rendered.root.findAllByType('Input').length, 1, '改写只有一个原生输入');
  await act(async () => rendered.unmount());
  assert.equal(listeners.size, 0);
}

// 字段名称不是密码语义；只有调用方明确声明的敏感输入才遮蔽。
await act(async () => { rendered = create(React.createElement(Field, { label: 'API Key', value: 'key', autoGrow: true, onChangeText() {} })); });
assert.notEqual(rendered.root.findByType('Input').props.secureTextEntry, true);
await act(async () => rendered.update(React.createElement(Field, { label: 'API Key', value: 'key', editable: false, onChangeText() {} })));
assert.equal(rendered.root.findByType('Input').props.editable, false);
await act(async () => rendered.update(React.createElement(Input, { value: 'token', secureTextEntry: true, autoCapitalize: 'none', autoCorrect: false, onChangeText() {} })));
assert.equal(rendered.root.findByType('Input').props.secureTextEntry, true);
assert.equal(rendered.root.findByType('Input').props.multiline, false);
await act(async () => rendered.update(React.createElement(Input, { value: '13', keyboardType: 'number-pad', submitBehavior: 'submit', onChangeText() {} })));
assert.equal(rendered.root.findByType('Input').props.keyboardType, 'number-pad');
assert.equal(rendered.root.findByType('Input').props.submitBehavior, 'submit');
await act(async () => rendered.unmount());
console.log('verify-ui-input: 草稿、原生 ref、键盘实际重叠、窗口缩放、逆序测量与监听生命周期通过。');
