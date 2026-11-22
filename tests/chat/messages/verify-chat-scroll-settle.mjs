/** 验证分页定位期间停下手势后，FlashList 仍消费最后一个原生位置。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const library = path.join(root, 'node_modules/@shopify/flash-list/dist');
const modules = new Map();
const timers = new Map();
let nextTimer = 0;
const timerApi = {
  setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
  clearTimeout: (id) => timers.delete(id),
};
const native = {
  View: 'View', I18nManager: { isRTL: false },
  PixelRatio: { roundToNearestPixel: (n) => n, getPixelSizeForLayoutSize: (n) => n },
  Animated: { Value: class {}, createAnimatedComponent: (component) => component },
};
const data = Array.from({ length: 80 }, (_, id) => ({ id }));
const observed = [];
const props = { data, keyExtractor: (item) => String(item.id), onScroll: (event) => observed.push(event.nativeEvent.contentOffset.y) };
let manager;
let velocity;
const Scroll = React.forwardRef(function Scroll(props, ref) {
  return React.createElement('Scroller', { ...props, ref });
});
const boundaries = {
  './hooks/useRecyclerViewManager': { useRecyclerViewManager: () => ({ recyclerViewManager: manager, velocityTracker: velocity }) },
  './hooks/useRecyclerViewController': { useRecyclerViewController: () => ({ applyOffsetCorrection() {}, computeFirstVisibleIndexForOffsetCorrection() {}, applyInitialScrollIndex() {}, handlerMethods: {} }) },
  './hooks/useLayoutState': { useLayoutState: React.useState },
  './hooks/useOnLoad': { useOnListLoad() {} },
  './hooks/useBoundDetection': { useBoundDetection: () => ({ checkBounds() {} }) },
  './hooks/useSecondaryProps': { useSecondaryProps: () => ({ CompatScrollView: Scroll }) },
  './RecyclerViewContextProvider': { useRecyclerViewContext: () => null, RecyclerViewContextProvider: ({ children }) => children },
  './ViewHolderCollection': { ViewHolderCollection: () => null },
  './components/StickyHeaders': { StickyHeaders: () => null },
  './components/ScrollAnchor': { ScrollAnchor: () => null },
};
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const requireModule = (name) => {
    if (name === 'react') return React;
    if (name === 'react-native') return native;
    if (file.endsWith('/RecyclerView.js') && Object.hasOwn(boundaries, name)) return boundaries[name];
    assert.ok(name.startsWith('.'), `未声明的列表运行时依赖：${name}`);
    return load(path.resolve(path.dirname(file), `${name}.js`).replaceAll('\\', '/'));
  };
  vm.runInNewContext(source, {
    module, exports: module.exports, require: requireModule, console,
    ...timerApi, global: timerApi,
  });
  return module.exports;
}
const file = (name) => path.join(library, name).replaceAll('\\', '/');
const { RecyclerViewManager } = load(file('recyclerview/RecyclerViewManager.js'));
const { VelocityTracker } = load(file('recyclerview/helpers/VelocityTracker.js'));
const { RecyclerView } = load(file('recyclerview/RecyclerView.js'));
manager = new RecyclerViewManager(props);
velocity = new VelocityTracker();
manager.updateLayoutParams({ width: 400, height: 600 }, 0);
manager.modifyChildrenLayout(data.map((_, index) => ({ index, dimensions: { width: 400, height: 100 } })), data.length);
manager.hasRenderedProgressively = true;
manager.isFirstLayoutComplete = true;
const event = (y) => ({ persisted: false, persist() { this.persisted = true; }, nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 400, height: 8000 }, layoutMeasurement: { width: 400, height: 600 } } });
let renderer;
act(() => { renderer = create(React.createElement(RecyclerView, props)); });
const scroll = (y) => {
  const nativeEvent = event(y);
  act(() => renderer.root.findByType('Scroller').props.onScroll(nativeEvent));
  // RN 在事件派发后回收未 persist 的 SyntheticEvent。
  if (!nativeEvent.persisted) nativeEvent.nativeEvent = null;
};
scroll(3500);
manager.ignoreScrollEvents = true;
scroll(1600);
scroll(1137);
assert.equal(manager.getAbsoluteLastScrollOffset(), 3500, '定位修正期间暂停更新渲染窗口');
assert.deepEqual(observed, [3500], '暂停期间不把中间位置传给消费者');
act(() => {
  // 末次原生滚动和惯性结束都落在定位暂停期间，此后用户不再产生滚动事件。
  for (const callback of [...timers.values()]) callback();
  manager.ignoreScrollEvents = false;
});
assert.equal(manager.getAbsoluteLastScrollOffset(), 1137, '恢复时采用最终原生位置，不等待用户再次滑动');
assert.deepEqual(observed, [3500, 1137], '只消费末次位置，中间事件不重放');
const visible = manager.computeVisibleIndices();
assert.equal(visible.startIndex, 11, '渲染窗口覆盖手机实际停住的消息');
act(() => { manager.ignoreScrollEvents = false; });
assert.deepEqual(observed, [3500, 1137], '已消费的位置不重复发送');
manager.ignoreScrollEvents = true;
scroll(0);
act(() => { manager.ignoreScrollEvents = false; });
assert.equal(manager.getAbsoluteLastScrollOffset(), 0, '列表顶部的零位置也必须保留');
manager.ignoreScrollEvents = true;
scroll(400);
act(() => renderer.unmount());
manager.dispose();
manager.ignoreScrollEvents = false;
assert.deepEqual(observed, [3500, 1137, 0], '列表销毁后不再重放它持有的滚动事件');
velocity.cleanUp();

// 快速滚动的预测位置不能把手机此刻可见的消息挤出渲染窗口，也不能无限扩容补洞。
const fastData = Array.from({ length: 1000 }, (_, id) => ({ id }));
for (const horizontal of [false, true]) {
  for (const direction of [-1, 1]) {
    for (const renderTime of [16, 32, 100, 500]) {
      const fast = new RecyclerViewManager({ data: fastData, horizontal, keyExtractor: item => String(item.id) });
      fast.updateLayoutParams(horizontal ? { width: 600, height: 400 } : { width: 400, height: 600 }, 0);
      fast.modifyChildrenLayout(fastData.map((_, index) => ({ index, dimensions: horizontal ? { width: 100, height: 400 } : { width: 400, height: 100 } })), fastData.length);
      fast.updateAverageRenderTime(renderTime);
      for (let index = 0; index < 6; index++) fast.updateScrollOffset(40000, horizontal ? { x: direction * 20, y: 0 } : { x: 0, y: direction * 20 });
      const actual = fast.computeVisibleIndices();
      const rendered = fast.getEngagedIndices();
      assert.ok(rendered.startIndex <= actual.startIndex && rendered.endIndex >= actual.endIndex,
        `快速滚动时必须覆盖实际视口，方向 ${direction}，渲染耗时 ${renderTime}ms`);
      assert.ok(fast.getRenderStack().size <= 14, '慢渲染或快速手势不能扩大挂载数量放大负载');
      fast.dispose();
    }
  }
}

// 已停止滚动后，上方内容的迟到测量仍应保留同一条消息，而非受 100ms 暂停窗口限制。
// 使用 Android 的 ScrollAnchor 相对修正路径，不用其他平台的绝对 scrollTo 替代。
load(file('native/config/PlatformHelper.js')).PlatformConfig.supportsOffsetCorrection = true;
const { useRecyclerViewController } = load(file('recyclerview/hooks/useRecyclerViewController.js'));
const anchorData = Array.from({ length: 80 }, (_, id) => ({ id: `old-${id}`, height: 100 }));
const anchorManager = new RecyclerViewManager({ data: anchorData, keyExtractor: item => item.id });
anchorManager.updateLayoutParams({ width: 400, height: 600 }, 0);
anchorManager.modifyChildrenLayout(anchorData.map((item, index) => ({ index, dimensions: { width: 400, height: item.height } })), anchorData.length);
anchorManager.hasRenderedProgressively = true;
anchorManager.isFirstLayoutComplete = true;
anchorManager.isFirstPaintOnUiComplete = true;
anchorManager.updateScrollOffset(0);
let nativeOffset = 0, controller;
const nativeScrollRef = { current: { scrollTo: ({ y }) => { nativeOffset = y; } } };
const nativeAnchorRef = { current: { scrollBy: delta => { nativeOffset += delta; } } };
function AnchorHarness() {
  controller = useRecyclerViewController(anchorManager, null, nativeScrollRef, nativeAnchorRef);
  return null;
}
let anchorRenderer;
act(() => { anchorRenderer = create(React.createElement(AnchorHarness)); });
controller.computeFirstVisibleIndexForOffsetCorrection();
const older = Array.from({ length: 15 }, (_, id) => ({ id: `older-${id}`, height: 100 }));
const pagedData = [...older, ...anchorData];
anchorManager.updateProps({ data: pagedData, keyExtractor: item => item.id });
anchorManager.processDataUpdate();
act(() => controller.applyOffsetCorrection());
assert.equal(anchorManager.getLayout(15).y - nativeOffset, 0, '补页后原来第一条消息留在同一屏幕位置');
act(() => {
  for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
});
// 模拟在图片等上方内容晚于暂停窗口完成测量，锚点因高度变化暂时落在旧渲染窗口外。
anchorManager.modifyChildrenLayout(older.map((_, index) => ({ index, dimensions: { width: 400, height: 400 } })), pagedData.length);
act(() => controller.applyOffsetCorrection());
assert.equal(anchorManager.getLayout(15).y - nativeOffset, 0, '迟到布局不能换掉阅读锚点或把停住的位置推走');
assert.equal(anchorManager.getDataKey(anchorManager.computeVisibleIndices().startIndex), 'old-0',
  '布局修正后 JS 渲染窗口立即覆盖原阅读位置，不等待用户继续滚动');
act(() => controller.applyOffsetCorrection());
assert.equal(anchorManager.getLayout(15).y - nativeOffset, 0, '重复提交布局不重复补偿同一段位移');
anchorManager.modifyChildrenLayout(older.map((_, index) => ({ index, dimensions: { width: 400, height: 100 } })), pagedData.length);
act(() => controller.applyOffsetCorrection());
assert.equal(anchorManager.getLayout(15).y - nativeOffset, 0, '上方内容收起变短时同样保留阅读锚点');
act(() => anchorRenderer.unmount());
anchorManager.dispose();
console.log('Chat scroll settle verification passed.');
