/** 验证主题切换保留导航选择、四个入口与未读状态；动画替身只模拟最终状态。 */
import { repoRoot as root } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const native = {
  View: 'View', Text: 'Text', Pressable: 'Pressable',
  StyleSheet: { create: value => value, hairlineWidth: 0.5, absoluteFill: {}, absoluteFillObject: {} },
};
const reanimated = {
  default: { View: 'AnimatedView', createAnimatedComponent: component => component },
  useSharedValue: value => React.useState(() => ({ value }))[0],
  useDerivedValue: compute => ({ get value() { return compute(); } }),
  useAnimatedStyle: compute => compute(),
  useAnimatedProps: compute => compute(),
  withSpring: value => value,
  withTiming: value => value,
  cancelAnimation: () => {},
  Easing: { bezier: () => value => value },
};
let theme;
const themed = { useTheme: () => theme, GlassSurface: 'GlassSurface' };
const mocks = {
  'react-native': native,
  'react-native-reanimated': { __esModule: true, ...reanimated },
  'react-native-svg': { __esModule: true, default: 'Svg', Path: 'Path' },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 24, top: 0, left: 0, right: 0 }) },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shared/theme': themed,
  '@shared/ui': { FLOATING_TAB_BAR_HEIGHT: 64, FLOATING_TAB_BAR_EDGE_GAP: 8 },
};
const cache = new Map();
function load(relativeFile) {
  const file = path.resolve(root, relativeFile);
  if (cache.has(file)) return cache.get(file);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) {
      const resolved = [name, `${name}.tsx`, `${name}.ts`]
        .map(candidate => path.resolve(path.dirname(file), candidate)).find(candidate => fs.existsSync(candidate));
      return load(resolved);
    }
    throw new Error(`缺少测试依赖 ${name}`);
  }, module, module.exports);
  cache.set(file, module.exports);
  return module.exports;
}

const themes = ['defaultLight', 'defaultDark', 'liquidGlass', 'paperNote'].map(name =>
  Object.values(load(`src/shared/theme/themes/${name}.ts`))[0]);
const BottomTabBar = load('src/features/chat/presentation/messages/components/BottomTabBar.tsx').default;
const changes = [];
let renderer;
const render = (activeTab, unreadCount) => React.createElement(BottomTabBar, {
  activeTab, unreadCount, onTabChange: value => changes.push(value),
});
const controls = () => renderer.root.findAllByProps({ accessibilityRole: 'tab' });
const selected = () => controls().map(item => item.props.accessibilityState.selected);

theme = themes[0];
await act(async () => { renderer = create(render('apps', 120)); });
for (theme of [...themes, themes[0]]) {
  await act(async () => { renderer.update(render('apps', 120)); });
  // 模拟原生布局；宽度来自容器，不依赖全屏尺寸或固定四等分像素。
  const layout = renderer.root.findAllByType('View').find(node => node.props.onLayout);
  if (layout) await act(async () => { layout.props.onLayout({ nativeEvent: { layout: { width: 320 } } }); });
  assert.equal(controls().length, 4);
  assert.deepEqual(selected(), [false, false, true, false]);
  assert.match(controls()[0].props.accessibilityLabel, /120/);
  assert.ok(renderer.root.findAllByType('Text').some(node => node.props.children === '99+'));
  if (theme.id === 'paper-note') {
    assert.deepEqual(renderer.root.findAllByType('Icon').map(node => node.props.name),
      ['chatbubble-outline', 'albums-outline', 'grid-outline', 'person-outline']);
    assert.equal(controls()[2].findByType('Icon').props.color, theme.components.tabBar.activeColor);
  }
  await act(async () => { for (const item of controls()) item.props.onPress(); });
  assert.deepEqual(changes.splice(0), ['ai', 'moments', 'apps', 'settings']);
  assert.deepEqual(selected(), [false, false, true, false], '视觉层等待导航所有者更新受控选择');
  for (const tab of ['settings', 'ai', 'moments', 'apps', 'ai']) {
    await act(async () => { renderer.update(render(tab, 3)); });
    assert.equal(selected().filter(Boolean).length, 1);
    assert.equal(selected()[['ai', 'moments', 'apps', 'settings'].indexOf(tab)], true);
  }
  await act(async () => { renderer.update(render('ai', 0)); });
  assert.ok(!renderer.root.findAllByType('Text').some(node => /99\+|3/.test(String(node.props.children))));
}
await act(async () => { renderer.unmount(); });
console.log('底栏验证通过：四主题来回切换、受控导航、四个入口顺序、纸张图标和未读角标。');
