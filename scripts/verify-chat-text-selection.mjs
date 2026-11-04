/** 验证局部选字与整条复制的菜单入口，以及可跨段落复制的原文。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    if (name === 'react') return React;
    assert.ok(Object.hasOwn(dependencies, name), `未声明依赖：${name}`);
    return dependencies[name];
  });
  return module.exports;
}

let theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const native = {
  Modal: 'Modal', View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
  TouchableWithoutFeedback: 'TouchableWithoutFeedback', StyleSheet: { create: value => value },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
};
const themeApi = { useTheme: () => theme, useThemedStyles: factory => factory(theme) };
const Menu = load('src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx', {
  'react-native': native, '@shared/theme': themeApi,
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  'lucide-react-native': { History: 'History', Pin: 'Pin', PinOff: 'PinOff', Star: 'Star', TextSelect: 'TextSelect' },
}).default;
const Sheet = load('src/features/chat/presentation/messages/components/ChatMessageTextSelectionSheet.tsx', {
  'react-native': native, '@shared/theme': themeApi, '@shared/ui': { ModalSheet: 'ModalSheet' },
  '@platform/device': { TextSelectionScrollView: 'TextSelectionScrollView' },
}).default;
const calls = [];
let menu;
const menuProps = {
  visible: true, position: { x: 200, y: 500 }, onClose: () => calls.push('close-menu'),
  onCopy: () => calls.push('copy-whole-message'), onSelectText: () => calls.push('open-selection'),
};
await act(async () => { menu = create(React.createElement(Menu, menuProps)); });
const buttons = menu.root.findAllByType('TouchableOpacity');
assert.deepEqual(buttons.map(button => button.props.accessibilityLabel), [
  '复制', '选择文字', '改写', '重写', '历史版本', '删除', '多选', '固定', '转文字', '引用', '翻译', '分享', '收藏',
], '选择文字紧邻复制，其余操作保持相对顺序');
assert.equal(menu.root.findByType('Modal').props.visible, true);
await act(async () => buttons.find(button => button.props.accessibilityLabel === '选择文字').props.onPress());
assert.deepEqual(calls, ['open-selection', 'close-menu'], '选字入口交给独立窗口，然后关闭原菜单');
calls.length = 0;
await act(async () => buttons[0].props.onPress());
assert.deepEqual(calls, ['copy-whole-message', 'close-menu'], '原复制按钮继续复制整条消息');
await act(async () => menu.update(React.createElement(Menu, { ...menuProps, onSelectText: undefined })));
assert.equal(menu.root.findAllByType('TouchableOpacity').find(button => button.props.accessibilityLabel === '选择文字').props.disabled, true, '没有可选正文时由入口禁用能力');
await act(async () => menu.unmount());

const original = '  第一段原文\n\n**第二段**\n最后一行  ';
let sheet;
const close = () => calls.push('close-selection');
await act(async () => { sheet = create(React.createElement(Sheet, { text: original, onClose: close })); });
const selectable = sheet.root.findAllByType('Text').filter(node => node.props.selectable);
assert.equal(selectable.length, 1, '整条消息在同一个原生选区内，支持跨段落拖动');
assert.equal(selectable[0].props.children, original, '保留原文空格、换行和 Markdown 标记，与整条复制的内容一致');
assert.equal(sheet.root.findAllByType('TextSelectionScrollView').length, 1);
assert.equal(sheet.root.findAllByType('TextInput').length, 0, '选字是只读操作，不创建编辑输入');
assert.equal(sheet.root.findByType('ModalSheet').props.avoidKeyboard, undefined, '选择窗口不请求键盘');
assert.equal(selectable[0].props.style.color, theme.colors.text.primary);
theme = load('src/shared/theme/themes/defaultDark.ts').defaultDarkTheme;
await act(async () => sheet.update(React.createElement(Sheet, { text: original, onClose: close })));
assert.equal(sheet.root.findAllByType('Text').find(node => node.props.selectable).props.style.color, theme.colors.text.primary);
await act(async () => sheet.root.findByType('ModalSheet').props.onClose());
assert.equal(calls.at(-1), 'close-selection');
await act(async () => sheet.unmount());

console.log('Chat text selection sheet verification passed.');
