/** 验证玻璃模糊设置、跨组件应用、重启恢复及稳定设置备份边界。 */
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
const memory = new Map();
const writes = [];
let readFailure = false;
const storage = {
  getItem: async key => {
    if (readFailure) throw new Error('存储不可读');
    return memory.get(key) ?? null;
  },
  setItem: async (key, value) => { memory.set(key, value); writes.push(key); },
  multiGet: async keys => {
    if (readFailure) throw new Error('存储不可读');
    return keys.map(key => [key, memory.get(key) ?? null]);
  },
  multiSet: async entries => { for (const [key, value] of entries) memory.set(key, value); },
};
const themed = {};
const native = {
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: value => value, hairlineWidth: 0.5, absoluteFill: {} },
};
const mocks = {
  'react-native': native,
  '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
  '@shared/theme': themed,
  '@shared/ui': { Slider: 'Slider' },
  'react-native-reanimated': { __esModule: true, default: { createAnimatedComponent: value => value } },
  '../../../../modules/liquid-glass': { LiquidGlassEffect: 'NativeGlassEffect' },
  './GlassScene': { useGlassSceneId: () => 'app' },
};
const cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
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
      const resolved = [`${name}.tsx`, `${name}.ts`].map(candidate => path.resolve(path.dirname(file), candidate))
        .find(candidate => fs.existsSync(candidate));
      return load(resolved);
    }
    throw new Error(`缺少测试依赖 ${name}`);
  }, module, module.exports);
  cache.set(file, module.exports);
  return module.exports;
}

const settings = load('src/shared/theme/themeStorage.ts');
const registry = load('src/shared/theme/themeRegistry.ts');
const { GLASS_BLUR_RANGE } = load('src/shared/theme/glassBlur.ts');
const { ThemeProvider, ThemeContext } = load('src/shared/theme/ThemeProvider.tsx');
Object.assign(themed, {
  GLASS_BLUR_RANGE, getThemeById: registry.getThemeById, ThemedSurface: 'ThemedSurface',
  useThemeContext: () => React.useContext(ThemeContext),
  useTheme: () => React.useContext(ThemeContext).theme,
  useThemedStyles: factory => factory(React.useContext(ThemeContext).theme),
});
const Editor = load('src/features/miniPrograms/presentation/GlassBlurSettings.tsx').default;
const { GlassSurface } = load('src/shared/theme/components/GlassSurface.tsx');
let context;
function Probe() {
  context = React.useContext(ThemeContext);
  return context.theme.effects.glass.enabled && React.createElement(React.Fragment, null,
    React.createElement(Editor), React.createElement(GlassSurface),
    React.createElement(GlassSurface, { material: { cornerRadius: 12 } }));
}
let renderer;
const mount = async () => act(async () => {
  renderer = create(React.createElement(ThemeProvider, null, React.createElement(Probe)));
});
const slider = () => renderer.root.findByType('Slider');
const blurValues = () => renderer.root.findAllByType('NativeGlassEffect').map(node => node.props.material.blurRadius);
const complete = async value => act(async () => { slider().props.onSlidingComplete(value); });

await settings.saveThemeId('liquid-glass');
await mount();
assert.equal(context.theme.effects.glass.blurRadius, 6, '首次使用默认更清透');
await act(async () => { slider().props.onValueChange(3); });
assert.equal(slider().props.value, 3);
assert.deepEqual(blurValues(), [6, 6], '拖动仅更新草稿，不逐帧重建全局主题');
assert.equal(await settings.loadGlassBlurRadius(), undefined);
await complete(3);
assert.deepEqual(blurValues(), [3, 3], '松手同时更新全部玻璃材质');
assert.equal(await settings.loadGlassBlurRadius(), 3);
await complete(0);
assert.deepEqual(blurValues(), [0, 0], '零模糊不能被默认值覆盖');
await complete(9);
const blurKey = writes.at(-1);
await act(async () => { await context.setChatColorOverride('aiText', '#123456'); });
assert.deepEqual(blurValues(), [9, 9], '更换文字颜色保留模糊偏好');
assert.equal(context.theme.colors.chat.aiText, '#123456');
for (const theme of ['default-dark', 'default-light']) {
  await act(async () => { await context.setThemeId(theme); });
  assert.equal(context.theme.effects.glass.blurRadius, 0, '普通主题材质不受玻璃偏好影响');
}
await act(async () => { await context.setThemeId('liquid-glass'); });
assert.deepEqual(blurValues(), [9, 9]);
await act(async () => { renderer.unmount(); });
await mount();
assert.deepEqual(blurValues(), [9, 9], '重启恢复用户设置');
await act(async () => {
  renderer.root.findByProps({ accessibilityLabel: '恢复默认玻璃模糊度' }).props.onPress();
});
assert.deepEqual(blurValues(), [6, 6]);
assert.equal(await settings.loadGlassBlurRadius(), 6);
await complete(9);
const backup = await settings.loadStoredThemeBackupState();
assert.equal(backup.glassBlurRadius, 9);
await complete(20);
await settings.restoreStoredThemeBackupState(backup);
assert.equal(await settings.loadGlassBlurRadius(), 9, '备份恢复保留模糊偏好');
const { glassBlurRadius: _radius, ...oldBackup } = backup;
await settings.restoreStoredThemeBackupState(oldBackup);
assert.equal(await settings.loadGlassBlurRadius(), undefined, '不含偏好的旧备份恢复主题默认值');
for (const invalid of [-1, 31, 1.5, '8', null, NaN, Infinity]) {
  assert.throws(() => settings.parseStoredThemeBackupState({ ...backup, glassBlurRadius: invalid }), /玻璃模糊度/);
}
memory.set(blurKey, '-2');
assert.equal(await settings.loadGlassBlurRadius(), undefined, '运行时对损坏存储使用主题默认值');
await assert.rejects(settings.loadStoredThemeBackupState(), /玻璃模糊度/, '严格备份拒绝损坏设置');
readFailure = true;
assert.equal(await settings.loadGlassBlurRadius(), undefined);
await assert.rejects(settings.loadStoredThemeBackupState(), /存储不可读/);
await act(async () => { renderer.unmount(); });
console.log('玻璃模糊验证通过：滑杆草稿、全局应用、零值、主题切换、重启恢复、重置及备份边界。');
