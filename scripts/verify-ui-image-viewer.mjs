/** 共享看图弹窗：所有入口的单击退出、关闭按钮、翻页页码与 footer 索引契约。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';

const root = path.resolve(import.meta.dirname, '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `${file} 未装配依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const viewerTheme = {
  colors: { background: { app: '#000' }, text: { primary: '#fff' } },
  effects: { overlay: { dim: 'rgba(0,0,0,0.6)' } },
  radius: { round: 999 },
};
const native = {
  Modal: 'Modal', Pressable: 'Pressable', View: 'View', Text: 'Text',
  FlatList: 'Pages', ActivityIndicator: 'Spinner',
  StyleSheet: { create: styles => styles },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
};
const { default: ImageViewerModal } = load('src/shared/ui/imageViewer/ImageViewerModal.tsx', {
  react: { ...React, default: React },
  'react-native': native,
  'react-native-gesture-handler': { GestureHandlerRootView: 'GestureRoot' },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
  'lucide-react-native': { X: 'CloseIcon' },
  '@shared/theme': { getThemeById: () => viewerTheme },
  './ZoomableImage': { default: 'ZoomableImage', __esModule: true },
});

let closed = 0;
const onClose = () => { closed += 1; };
const element = props => React.createElement(ImageViewerModal, { onClose, ...props });
const single = [{ uri: 'file:///a.jpg' }];
let renderer;
await act(async () => { renderer = create(element({ visible: false, sources: single })); });
assert.equal(renderer.root.findAllByType('ZoomableImage').length, 0, '关闭时不挂载图片与缩放状态');

await act(async () => { renderer.update(element({ visible: true, sources: single })); });
const singleImage = renderer.root.findByType('ZoomableImage');
assert.equal(singleImage.props.source.uri, 'file:///a.jpg');
assert.equal(singleImage.props.onSingleTap, onClose, '单击图片与关闭按钮使用同一个退出入口');
await act(async () => { renderer.root.findByType('Pressable').props.onPress(); });
assert.equal(closed, 1, '右上角关闭按钮退出预览');
await act(async () => { singleImage.props.onSingleTap(); });
assert.equal(closed, 2, '单击图片退出预览');

const sources = [{ uri: 'file:///a.jpg' }, { uri: 'file:///b.jpg' }, { uri: 'file:///c.jpg' }];
const footer = index => React.createElement('Footer', { index });
await act(async () => {
  renderer.update(element({ visible: true, sources, initialIndex: 1, footer }));
});
const pages = renderer.root.findByType('Pages');
assert.equal(pages.props.data.length, 3, '多图按页渲染');
assert.equal(renderer.root.findByType('Footer').props.index, 1, '业务 footer 使用打开时指定的页');
const pager = () => renderer.root.findAllByType('Text').map(node => node.props.children).flat().join('');
assert.equal(pager(), '2 / 3');
await act(async () => {
  renderer.root.findByType('Pages').props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 800 } } });
});
assert.equal(renderer.root.findByType('Footer').props.index, 2, '翻页后 footer 跟随当前图片');
assert.equal(pager(), '3 / 3');
const pageImages = pages.props.data.map((item, index) => {
  const children = pages.props.renderItem({ item, index }).props.children;
  return (Array.isArray(children) ? children : [children]).find(child => child && child.type === 'ZoomableImage');
});
assert.equal(pageImages.filter(Boolean).length, 3, '每一页都渲染可缩放图片');
assert.ok(pageImages.every(node => node.props.onSingleTap === onClose), '多图每一页都能单击退出');

await act(async () => { renderer.update(element({ visible: false, sources })); });
assert.equal(renderer.root.findAllByType('Pages').length, 0, '关闭后销毁翻页状态');
await act(async () => { renderer.update(element({ visible: true, sources, initialIndex: 2, footer })); });
assert.equal(renderer.root.findByType('Footer').props.index, 2, '重新打开从指定页开始，不继承上次的滚动位置');
await act(async () => { renderer.update(element({ visible: true, sources: [null] })); });
assert.equal(renderer.root.findAllByType('Spinner').length, 1, '地址仍在解析的页显示加载态');
await act(async () => { renderer.update(element({ visible: true, sources: ['unavailable'] })); });
assert.ok(renderer.root.findAllByType('Text').some(node => node.props.children === '图片不可用'), '媒体解析失败明确展示不可用');
assert.equal(renderer.root.findAllByType('ZoomableImage').length, 0, '不可用页不进入缩放手势');
await act(async () => { renderer.unmount(); });
console.log('共享图片预览：单击退出、关闭按钮、页码、footer 索引与状态销毁验证通过。');
