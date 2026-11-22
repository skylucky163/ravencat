/** 验证输入焦点、键盘实际可见性与自定义面板的高度所有权。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const listeners = new Map();
const Keyboard = { dismiss() {}, addListener: (event, callback) => {
  listeners.set(event, callback);
  return { remove: () => listeners.delete(event) };
} };
class AnimatedValue {
  constructor(value) { this.value = value; }
  setValue(value) { this.value = value; }
  __getValue() { return this.value; }
}
const animations = [];
const Animated = {
  Value: AnimatedValue,
  timing(value, config) {
    animations.push(config);
    return { start() { value.setValue(config.toValue); } };
  },
};
const Easing = { cubic: value => value ** 3, out: easing => easing };
const module = { exports: {} };
const source = fs.readFileSync(new URL('../../../src/features/chat/presentation/messages/components/useChatComposerSurface.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('require', 'module', 'exports', output)((name) => name === 'react' ? React : { Keyboard, Animated, Easing }, module, module.exports);
let surface;
function Composer() { surface = module.exports.useChatComposerSurface(); return null; }
let renderer;
await act(async () => { renderer = create(React.createElement(Composer)); });
await act(async () => surface.setActiveSurface('keyboard'));
assert.equal(surface.keyboardOffset.__getValue(), 0, '自动转移焦点但没有键盘时不得凭旧高度顶起输入框');
await act(async () => listeners.get('keyboardWillShow')({ duration: 180, endCoordinates: { height: 280 } }));
assert.equal(surface.keyboardOffset.__getValue(), 280, '键盘开始出现时同步启动避让');
assert.equal(animations.at(-1).duration, 180);
await act(async () => listeners.get('keyboardDidShow')({ endCoordinates: { height: 280 } }));
assert.equal(surface.keyboardOffset.__getValue(), 280);
await act(async () => listeners.get('keyboardWillHide')({ duration: 160 }));
assert.equal(surface.keyboardOffset.__getValue(), 0, '键盘收起开始时同步撤回避让');
await act(async () => listeners.get('keyboardDidHide')());
await act(async () => surface.setActiveSurface('keyboard'));
assert.equal(surface.keyboardOffset.__getValue(), 0, '曾经打开键盘也不能借用历史高度');
await act(async () => surface.setActiveSurface('stickers'));
assert.equal(surface.keyboardOffset.__getValue(), 0);
assert.equal(surface.surfaceHeight, 280, '自定义面板保留独立的历史高度');
await act(async () => listeners.get('keyboardDidHide')());
assert.equal(surface.activeSurface, 'stickers', '键盘收起不替代其他面板所有权');
await act(async () => surface.dismiss());
assert.equal(surface.activeSurface, 'none');
await act(async () => renderer.unmount());
assert.equal(listeners.size, 0);
console.log('聊天输入区焦点、键盘与面板高度验证通过。');
