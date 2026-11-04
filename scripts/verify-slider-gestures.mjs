/** 公共滑杆的手势仲裁回归：纵向让位父滚动、横向连续调整、未激活与中断的完成规则。 */
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
  colors: { text: { primary: '#111', secondary: '#444' }, surface: { default: '#fff' }, background: { app: '#fff' }, border: { light: '#ddd' }, brand: { primary: '#66f' }, feedback: { error: '#f00' } },
};
const native = {
  ...Object.fromEntries(['View', 'Text', 'TextInput'].map((name) => [name, name])),
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
};
const themed = { useTheme: () => theme, useThemedStyles: (factory) => factory(theme) };

// 手势库替身只记录组件声明的配置与回调；是否触发由下面的 simulate 按 RNGH 公开语义决定。
function gestureNode(kind) {
  const node = { kind, config: {}, handlers: {} };
  for (const name of ['enabled', 'runOnJS', 'activeOffsetX', 'activeOffsetY', 'failOffsetX', 'failOffsetY',
    'minDistance', 'maxDistance', 'maxDuration', 'numberOfTaps']) {
    node[name] = (value) => { node.config[name] = value; return node; };
  }
  for (const name of ['onBegin', 'onStart', 'onUpdate', 'onEnd', 'onFinalize']) {
    node[name] = (callback) => { node.handlers[name] = callback; return node; };
  }
  return node;
}
const Gesture = {
  Pan: () => gestureNode('pan'),
  Tap: () => gestureNode('tap'),
  Race: (...children) => ({ children }),
};

const flatten = (node) => (node.children ? node.children.flatMap(flatten) : [node]);
// 标量只约束一侧，数组两端都约束；与 RNGH 的配置写法一致，未约束的一侧不参与判定。
function bounds(config, name) {
  const value = config[name];
  if (value === undefined) return null;
  if (Array.isArray(value)) return [value[0], value[1]];
  return value < 0 ? [value, Infinity] : [-Infinity, value];
}

/**
 * 回放一段手指轨迹，返回每个手势的终态。
 * 断言对象是组件声明的仲裁配置带来的回调行为，而不是某一种内部写法：
 * 纵向越过阈值先失败、横向越过阈值才激活、未激活就不会收到 onEnd。
 */
function simulate(composed, input) {
  const runs = flatten(composed).map((node) => ({ node, state: node.config.enabled === false ? 'disabled' : 'unset' }));
  const event = (x, y) => ({
    x, y, absoluteX: x, absoluteY: y,
    translationX: x - input.from[0], translationY: y - input.from[1], velocityX: 0, velocityY: 0,
  });
  const activate = (run, x, y) => { run.state = 'active'; run.node.handlers.onStart?.(event(x, y)); };
  const fail = (run, x, y) => { run.state = 'failed'; run.node.handlers.onFinalize?.(event(x, y), false); };
  const end = (run, x, y, success) => { run.state = success ? 'ended' : 'cancelled'; run.node.handlers.onEnd?.(event(x, y), success); run.node.handlers.onFinalize?.(event(x, y), success); };

  for (const run of runs) {
    if (run.state === 'disabled') continue;
    run.state = 'began';
    run.node.handlers.onBegin?.(event(input.from[0], input.from[1]));
    // minDistance(0) 的 Pan 在按下瞬间激活，这是滑杆被判定抢滚动的旧语义。
    if (run.node.kind === 'pan' && run.node.config.minDistance === 0) activate(run, input.from[0], input.from[1]);
  }
  const arbitrate = () => {
    if (!runs.some((run) => run.state === 'active' || run.state === 'ended')) return;
    for (const run of runs) if (run.state === 'began') { run.state = 'cancelled'; run.node.handlers.onFinalize?.(event(input.from[0], input.from[1]), false); }
  };

  for (const [x, y] of input.moves ?? []) {
    for (const run of runs) {
      const { dx, dy } = { dx: x - input.from[0], dy: y - input.from[1] };
      if (run.node.kind === 'tap') {
        if (run.state === 'began' && Math.hypot(dx, dy) > (run.node.config.maxDistance ?? 10)) fail(run, x, y);
        continue;
      }
      if (run.state === 'active') { run.node.handlers.onUpdate?.(event(x, y)); continue; }
      if (run.state !== 'began') continue;
      const failX = bounds(run.node.config, 'failOffsetX');
      const failY = bounds(run.node.config, 'failOffsetY');
      const activeX = bounds(run.node.config, 'activeOffsetX');
      const activeY = bounds(run.node.config, 'activeOffsetY');
      if (failY && (dy < failY[0] || dy > failY[1])) { fail(run, x, y); continue; }
      if (failX && (dx < failX[0] || dx > failX[1])) { fail(run, x, y); continue; }
      if (activeX && (dx < activeX[0] || dx > activeX[1])) { activate(run, x, y); continue; }
      if (activeY && (dy < activeY[0] || dy > activeY[1])) { activate(run, x, y); continue; }
      if (Math.hypot(dx, dy) > (run.node.config.minDistance ?? 10)) activate(run, x, y);
    }
    arbitrate();
  }

  const rest = input.up ?? input.from;
  for (const run of runs) {
    if (run.state === 'active') { end(run, rest[0], rest[1], !input.cancel); continue; }
    if (run.state !== 'began') continue;
    if (run.node.kind === 'pan') { fail(run, rest[0], rest[1]); continue; }
    if ((input.holdMs ?? 0) > (run.node.config.maxDuration ?? 500)) { fail(run, rest[0], rest[1]); continue; }
    end(run, rest[0], rest[1], true);
  }
  return Object.fromEntries(runs.map((run) => [run.node.kind, run.state]));
}

const { default: Slider } = load('src/shared/ui/Slider.tsx', {
  '@shared/theme': themed, 'react-native': native,
  'react-native-gesture-handler': { Gesture, GestureDetector: 'GestureDetector' },
});

let renderer;
const view = () => renderer.root.findAllByType('View').find((node) => node.props.accessibilityRole === 'adjustable');
const composed = () => renderer.root.findByType('GestureDetector').props.gesture;
const shown = () => view().props.accessibilityValue.now;

async function mount({ min = 0, max = 1, upperLimit = max, step = 0.1, initial = 0.5, disabled = false, width = 200, silentComplete = false } = {}) {
  const log = { changes: [], completes: [] };
  function Harness() {
    const [current, setCurrent] = React.useState(initial);
    log.setValue = setCurrent;
    return React.createElement(Slider, {
      value: current, min, max, upperLimit, step, disabled, accessibilityLabel: '滑杆',
      onValueChange: (next) => { log.changes.push(next); setCurrent(next); },
      onSlidingComplete: silentComplete ? undefined : (next) => { log.completes.push(next); setCurrent(next); },
    });
  }
  await act(async () => { renderer = create(React.createElement(Harness)); });
  await act(async () => { view().props.onLayout({ nativeEvent: { layout: { width } } }); });
  return log;
}
const play = async (input) => { let states; await act(async () => { states = simulate(composed(), input); }); return states; };

// 纵向滑过滑杆：手势先失败让给父滚动，值不变、也不提交。
let log = await mount();
let states = await play({ from: [100, 20], moves: [[102, 60], [101, 120], [100, 200]], up: [100, 220] });
assert.equal(states.pan, 'failed', '纵向拖动时滑杆必须失败，父 ScrollView 才能接管');
assert.deepEqual(log.changes, [], '纵向滑动不改变数值');
assert.deepEqual(log.completes, [], '未激活的手势不触发完成回调');
assert.equal(shown(), 0.5);

// 先纵向被父容器接管，之后即使手指横向划过轨道，也不能凭结束坐标改值。
log = await mount();
states = await play({ from: [40, 20], moves: [[45, 60], [190, 62]], up: [195, 62] });
assert.equal(states.pan, 'failed');
assert.deepEqual(log.changes, [], '手势失败后不再采样坐标');
assert.deepEqual(log.completes, []);

// 明确横向拖动：激活后连续调整，松手提交最终坐标。
log = await mount();
states = await play({ from: [40, 20], moves: [[60, 21], [100, 21], [140, 22], [180, 21]], up: [200, 21] });
assert.equal(states.pan, 'ended');
assert.deepEqual(log.changes, [0.3, 0.5, 0.7, 0.9, 1], '按下位置不立即改值，激活后连续跟随手指');
assert.deepEqual(log.completes, [1], '松手只提交一次最终值');
assert.equal(shown(), 1);

// 快速甩动没有中间更新：松手事件仍要采样终点。
log = await mount();
await play({ from: [50, 20], moves: [[70, 20]], up: [150, 20] });
assert.deepEqual(log.changes, [0.3, 0.8]);
assert.deepEqual(log.completes, [0.8], '快速松手采样终点坐标');

// 已激活手势被系统中断：提交最后有效值，不回退到调整前，也不采用中断坐标。
log = await mount();
states = await play({ from: [50, 20], moves: [[120, 20]], cancel: true });
assert.equal(states.pan, 'cancelled');
assert.deepEqual(log.completes, [0.6]);
assert.equal(shown(), 0.6);

// 未激活就结束（长按后松手）：既不激活也不提交。
log = await mount();
states = await play({ from: [50, 20], moves: [[52, 22]], up: [52, 22], holdMs: 800 });
assert.equal(states.pan, 'failed');
assert.deepEqual(log.changes, [], '未激活的手势不产生数值变化');
assert.deepEqual(log.completes, []);

// 轻点轨道仍跳到该位置：拖动未激活，但点击是完整手势，只在松手时生效一次。
log = await mount();
await play({ from: [50, 20], up: [50, 20] });
assert.deepEqual(log.changes, [0.3], '轻点只在松手时改值');
assert.deepEqual(log.completes, [0.3]);
assert.equal(shown(), 0.3);

// 量化、小数步长与越界夹取都不退化。
log = await mount({ max: 2, initial: 1 });
await play({ from: [40, 20], moves: [[29, 20]], up: [29, 20] });
assert.equal(shown(), 0.3, '小数步长去掉浮点尾数');
log = await mount({ max: 2, initial: 1 });
await play({ from: [100, 20], moves: [[-20, 20]], up: [-20, 20] });
assert.equal(shown(), 0);
log = await mount({ max: 2, initial: 1 });
await play({ from: [100, 20], moves: [[260, 20]], up: [260, 20] });
assert.equal(shown(), 2);
log = await mount({ max: 2, initial: 1 });
await play({ from: [100, 20], moves: [[260, 20]], up: [100, 20] });
assert.equal(shown(), 1, '滑到边缘后反向拖动仍可继续调整');

// 固定刻度与实际可达到的上限分离，切线约束不能重新缩放整根轨道。
log = await mount({ max: 100, upperLimit: 70, step: 1, initial: 30 });
await play({ from: [60, 20], moves: [[200, 20]], up: [200, 20] });
assert.equal(shown(), 70, '固定刻度内的约束上限阻止切线越界');
assert.equal(log.completes.at(-1), 70);
await play({ from: [140, 20], moves: [[100, 20]], up: [100, 20] });
assert.equal(shown(), 50, '限位不会把整根轨道重新映射为较小量程');
await act(async () => { view().props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }); });
assert.equal(shown(), 49);

// 可空调用方（尚未设置）依然能用手势赋值，且不会在按下瞬间凭空产生数值。
log = await mount({ initial: null, max: 2 });
assert.deepEqual(view().props.accessibilityValue, { min: 0, max: 2, text: '未设置' });
assert.deepEqual(log.changes, []);
await play({ from: [100, 20], moves: [[160, 20]], up: [160, 20] });
assert.deepEqual(log.changes, [1.6, 1.6], '激活与松手各自采样同一坐标');
assert.deepEqual(log.completes, [1.6]);
assert.equal(shown(), 1.6);

// 禁用：两个手势都不参与，点击、拖动与读屏调整都不产生写入。
log = await mount({ disabled: true, initial: 0.5 });
assert.equal(composed().children.every((node) => node.config.enabled === false), true, '禁用时不接受手势');
await play({ from: [40, 20], moves: [[180, 21]], up: [200, 21] });
await play({ from: [50, 20], up: [50, 20] });
assert.deepEqual(log.changes, []);
assert.deepEqual(log.completes, []);
await act(async () => { view().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); });
assert.deepEqual(log.completes, [], '禁用时读屏调整无效');
assert.equal(shown(), 0.5);

// 读屏增减沿用调用方步长，并立即提交；未提供 onSlidingComplete 时拖动也不报错。
log = await mount({ initial: 0.3 });
await act(async () => { view().props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }); });
assert.equal(shown(), 0.4);
assert.deepEqual(log.completes, [0.4]);
await act(async () => { view().props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }); });
assert.equal(shown(), 0.3);
await act(async () => { view().props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }); });
assert.equal(shown(), 0.2);
// 没有完成回调时，松手坐标同样生效：终点是否采样不取决于调用方是否传入回调。
log = await mount({ initial: 0.5, silentComplete: true });
await play({ from: [40, 20], moves: [[180, 21]], up: [200, 21] });
assert.equal(shown(), 1, '松手终点不依赖完成回调');
await play({ from: [50, 20], up: [50, 20] });
assert.equal(shown(), 0.3, '点击跳转不依赖完成回调');

// 尚未测量宽度的轨道不参与手势，避免用 0 宽度换算。
log = await mount({ initial: 0.5, width: 0 });
assert.equal(composed().children.every((node) => node.config.enabled === false), true);
await play({ from: [40, 20], moves: [[180, 21]], up: [200, 21] });
assert.deepEqual(log.changes, []);
await act(async () => { renderer.unmount(); });

console.log('公共滑杆手势验证通过：纵向让位父滚动、横向连续调整、快速松手、中断提交、轻点跳转、量化夹取、禁用与读屏调整。');
