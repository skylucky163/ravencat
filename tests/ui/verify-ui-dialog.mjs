/** 验证公共提示的展示、确认和生命周期，不绑定组件内部写法。 */
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

function load(file, dependencies = {}) {
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

const { defaultLightTheme } = load('src/shared/theme/themes/defaultLight.ts');
const { defaultDarkTheme } = load('src/shared/theme/themes/defaultDark.ts');
let theme = defaultLightTheme;
const store = load('src/shared/ui/appDialogStore.ts');
const { showAppDialog } = store;
const { default: AppDialogHost } = load('src/shared/ui/AppDialogHost.tsx', {
  './appDialogStore': store,
  'react-native': {
    ...Object.fromEntries(['Modal', 'Pressable', 'ScrollView', 'Text', 'View'].map((name) => [name, name])),
    StyleSheet: { create: (styles) => styles, hairlineWidth: 1, absoluteFill: {} },
  },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) },
  'lucide-react-native': Object.fromEntries(['Check', 'CircleAlert', 'Info', 'TriangleAlert'].map((name) => [name, name])),
  '@shared/theme': { ThemedSurface: 'View', useTheme: () => theme, useThemedStyles: (factory) => factory(theme) },
});
let renderer;
const mount = async () => { await act(async () => { renderer = create(React.createElement(AppDialogHost)); }); };
const modal = () => renderer.root.findByType('Modal');
const button = (label) => renderer.root.findByProps({ accessibilityLabel: label });
const press = async (label) => { await act(async () => { button(label).props.onPress(); }); };
const titles = () => renderer.root.findAllByType('Text').map((node) => node.children.join(''));
await mount();
assert.equal(renderer.toJSON(), null);

// 连续提示不能覆盖已有确认；业务回调产生的新报错接在已经等待的提示之后。
let deletes = 0;
await act(async () => {
  showAppDialog({ title: '删除记录', message: '此操作不可撤销。', buttons: [
    { text: '取消', style: 'cancel' },
    { text: '删除', style: 'destructive', onPress: () => {
      deletes++;
      showAppDialog({ title: '删除失败', message: '数据库写入失败', tone: 'error' });
    } },
  ] });
  showAppDialog({ title: '保存成功', tone: 'success' });
});
assert.ok(titles().includes('删除记录'));
assert.equal(deletes, 0);
const staleDelete = button('删除').props.onPress;
await act(async () => { staleDelete(); staleDelete(); });
assert.equal(deletes, 1, '连续触摸只能提交一次删除');
assert.ok(titles().includes('保存成功'));
await press('知道了');
assert.ok(titles().includes('删除失败'));
assert.equal(renderer.root.findByType('CircleAlert').props.color, theme.colors.feedback.error);
assert.equal(renderer.root.findByProps({ children: '数据库写入失败' }).props.selectable, true);
assert.equal(renderer.root.findAllByType('ScrollView').length, 1);
await press('知道了');
assert.equal(renderer.toJSON(), null);

// 系统返回和遮罩不会触发取消或危险按钮，显式取消只调用自己的回调。
let dismissed = 0;
let cancelled = 0;
const confirmation = {
  title: '清空数据', onDismiss: () => { dismissed++; },
  buttons: [
    { text: '取消', style: 'cancel', onPress: () => { cancelled++; } },
    { text: '清空', style: 'destructive', onPress: () => { deletes++; } },
  ],
};
await act(async () => { showAppDialog(confirmation); });
await act(async () => { modal().props.onRequestClose(); });
assert.deepEqual([dismissed, cancelled, deletes], [1, 0, 1]);
await act(async () => { showAppDialog(confirmation); });
await press('关闭提示');
assert.deepEqual([dismissed, cancelled, deletes], [2, 0, 1]);
await act(async () => { showAppDialog(confirmation); });
const staleCancel = button('取消').props.onPress;
await press('取消');
assert.deepEqual([dismissed, cancelled, deletes], [2, 1, 1]);
await act(async () => { showAppDialog({ ...confirmation, dismissible: false }); });
await act(async () => { modal().props.onRequestClose(); });
await press('关闭提示');
assert.ok(titles().includes('清空数据'));
assert.equal(dismissed, 2);
await press('取消');

await act(async () => { showAppDialog(confirmation); staleCancel(); });
assert.ok(titles().includes('清空数据'), '复用提示配置时旧按钮回调不能关闭新提示');
await act(async () => { modal().props.onRequestClose(); });
assert.deepEqual([dismissed, cancelled, deletes], [3, 2, 1]);

// 当前提示即时响应主题切换；长报错正文完整保留。
const longMessage = '模型接口返回错误详情\n'.repeat(100);
await act(async () => { showAppDialog({ title: '连接失败', message: longMessage, tone: 'error' }); });
theme = defaultDarkTheme;
await act(async () => { renderer.update(React.createElement(AppDialogHost)); });
const card = renderer.root.findByProps({ accessibilityViewIsModal: true });
assert.equal(card.props.style.backgroundColor, defaultDarkTheme.colors.surface.raised);
assert.ok(titles().includes(longMessage));
assert.equal(renderer.root.findByType('CircleAlert').props.color, defaultDarkTheme.colors.feedback.error);

// 卸载展示宿主不能执行等待中的业务回调，也不能把旧页面提示带到新宿主。
await act(async () => { showAppDialog(confirmation); renderer.unmount(); });
assert.deepEqual([dismissed, cancelled, deletes], [3, 2, 1]);
await mount();
assert.equal(renderer.toJSON(), null);
await act(async () => { showAppDialog({ title: '连接失败', message: longMessage, tone: 'error' }); });
assert.ok(titles().includes('连接失败'), '再次发生相同错误仍可展示');
await press('知道了');
await act(async () => { renderer.unmount(); });
console.log('公共提示弹窗：确认、关闭、队列、主题和卸载行为验证通过。');
