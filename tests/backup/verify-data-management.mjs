/** 验证数据管理的页内备份、帮助说明、清空确认与操作互斥。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(file, dependencies = {}) {
  const source = ts.transpileModule(fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)((name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    assert.ok(Object.hasOwn(dependencies, name), `缺少测试依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const dialogs = load('src/shared/ui/appDialogStore.ts');
let wallpaperRefreshes = 0;
const nativeComponents = Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'TouchableOpacity', 'View'].map((name) => [name, name]));
const theme = { ThemedSurface: 'Surface', useThemedStyles: () => ({}),
  useTheme: () => ({ colors: { brand: { primary: '#000' }, text: { primary: '#111', secondary: '#666', tertiary: '#999', inverse: '#fff' }, feedback: { error: '#f00' } } }),
  useWallpaper: () => ({ refreshWallpapers: async () => { wallpaperRefreshes++; } }) };
const backup = load('src/features/backup/presentation/BackupPanel.tsx', {
  'react-native': nativeComponents,
  'lucide-react-native': Object.fromEntries(['FolderOpen', 'HardDriveDownload', 'Trash2'].map((name) => [name, 'Icon'])),
  '@shared/ui': { showAppDialog: dialogs.showAppDialog },
  '@shared/theme': theme,
  '@shared/ui/NavigationHeaderHelp': 'Help',
  '../application/BackupTargetCatalog': load('src/features/backup/application/BackupTargetCatalog.ts'),
  './BackupRestoreModal': { BackupRestoreModal: 'RestoreModal' },
  './BackupPanel.styles': { createBackupPanelStyles: () => ({}) },
});
const { DataManagementScreen } = load('src/features/profile/presentation/DataManagementScreen.tsx', {
  'react-native': nativeComponents,
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  'lucide-react-native': Object.fromEntries(['ArchiveRestore', 'ChevronDown', 'ChevronUp', 'History', 'Trash2'].map((name) => [name, 'Icon'])),
  '@features/backup': backup,
  '@shared/theme': theme,
  '@shared/ui': { showAppDialog: dialogs.showAppDialog },
  '@shared/ui/NavigationHeader': 'Header',
  './DataManagementScreen.styles': {},
});

let backups = 0;
let backupLists = 0;
let clears = 0;
let completeClear;
let completeBackup;
let cachedSelectionClears = 0;
let externalPicks = 0;
let recycleBinOpens = 0;
const props = { onBack() {}, onOpenAIRecycleBin() { recycleBinOpens++; }, backupRuntime: {
  async listLocalBackups() { backupLists++; return []; },
  createLocalBackup() { backups++; return new Promise((resolve) => { completeBackup = resolve; }); },
  async clearLegacyCachedImageSelections() { cachedSelectionClears++; return { callBackground: true, wallpapers: 2, momentsCover: false }; },
  async pickExternalBackup() { externalPicks++; return null; },
}, onClearData() {
  clears++;
  return new Promise((resolve) => { completeClear = resolve; });
} };
let mounted;
await renderer.act(async () => { mounted = renderer.create(React.createElement(DataManagementScreen, props)); });
const buttons = () => mounted.root.findAllByType('TouchableOpacity');
const button = (label) => buttons().find((item) => item.props.accessibilityLabel.split('，')[0] === label);
const backupAction = (label) => mounted.root.findAllByType('Pressable').find((item) => item.findAllByType('Text').some((text) => text.children.join('') === label));
assert.ok(button('清空所有数据'), '清空入口直接展示');
assert.equal(button('危险操作'), undefined, '危险操作不再提供折叠交互');
assert.ok(backupAction('创建备份'), '进入页面即可使用备份');
assert.equal(backupLists, 1, '进入页面加载备份列表');
const help = mounted.root.findByType('Help');
assert.equal(help.props.title, '备份与恢复');
assert.match(help.props.sections[0].body, /凭据以明文保存/);
assert.equal(mounted.root.findAllByType('Text').some((item) => item.children.join('').includes('模型 API Key')), false, '长说明仅由帮助气泡展示');
assert.ok(button('AI 回收站'), '数据管理提供真实回收入口');
await renderer.act(async () => { button('AI 回收站').props.onPress(); });
assert.equal(recycleBinOpens, 1, '入口将导航意图交给宿主');
assert.ok(backupAction('创建备份'), '在当前页面展开备份操作');
assert.equal(backupLists, 1);
await renderer.act(async () => { backupAction('创建备份').props.onPress(); });
assert.equal(backups, 1);
assert.equal(button('清空所有数据').props.disabled, true, '备份期间禁用清空');
assert.equal(button('AI 回收站').props.disabled, true, '备份期间不开放会修改同一批数据的回收操作');
await renderer.act(async () => { completeBackup(); });
assert.equal(dialogs.getAppDialogSnapshot().title, '备份完成');
dialogs.finishAppDialog(dialogs.getAppDialogSnapshot());
assert.equal(button('清空所有数据').props.disabled, false);
await renderer.act(async () => { backupAction('选择外部备份包').props.onPress(); });
assert.equal(externalPicks, 1, '页内面板仍支持选择外部备份');
await renderer.act(async () => { backupAction('清除旧缓存图片选择').props.onPress(); });
assert.equal(cachedSelectionClears, 0, '修复入口先确认再执行');
let repairDialog = dialogs.getAppDialogSnapshot();
await renderer.act(async () => { dialogs.finishAppDialog(repairDialog, repairDialog.buttons.find((item) => item.style === 'destructive')); });
assert.equal(cachedSelectionClears, 1);
assert.equal(wallpaperRefreshes, 1, '清除旧图片选择后刷新展示');
assert.match(dialogs.getAppDialogSnapshot().message, /壁纸：清除 2 项/);
dialogs.finishAppDialog(dialogs.getAppDialogSnapshot());
assert.equal(backups, 1, '修复不会自动创建备份');
await renderer.act(async () => { button('清空所有数据').props.onPress(); });
assert.equal(clears, 0, '点击清空入口只展示确认');
let dialog = dialogs.getAppDialogSnapshot();
assert.match(dialog.message, /永久删除.*不可恢复/);
dialogs.finishAppDialog(dialog, dialog.buttons.find((item) => item.style === 'cancel'));
assert.equal(clears, 0, '取消确认不清理数据');
await renderer.act(async () => { button('清空所有数据').props.onPress(); });
dialogs.finishAppDialog(dialogs.getAppDialogSnapshot());
assert.equal(clears, 0, '返回键或遮罩关闭确认不清理数据');
await renderer.act(async () => { button('清空所有数据').props.onPress(); });
dialog = dialogs.getAppDialogSnapshot();
await renderer.act(async () => { dialogs.finishAppDialog(dialog, dialog.buttons.find((item) => item.style === 'destructive')); });
assert.equal(clears, 1);
assert.equal(button('清空所有数据').props.disabled, true, '执行期间禁用清空入口');
assert.equal(backupAction('创建备份').props.disabled, true, '清空期间禁用已展开面板内的备份操作');
dialogs.finishAppDialog(dialog, dialog.buttons.find((item) => item.style === 'destructive'));
assert.equal(clears, 1, '重复触摸已关闭的确认不重复清空');
await renderer.act(async () => { completeClear(); });
assert.equal(backupAction('创建备份').props.disabled, false, '清空结束后恢复备份操作');
await renderer.act(async () => { mounted.unmount(); });
await renderer.act(async () => { mounted = renderer.create(React.createElement(DataManagementScreen, props)); });
assert.ok(button('清空所有数据'), '重新进入页面仍直接展示清空入口');
assert.ok(backupAction('创建备份'), '重新进入页面仍可直接备份');
await renderer.act(async () => { mounted.unmount(); });
console.log('数据管理验证通过：AI 回收站入口、页内备份、Help 说明、清空确认与操作互斥。');
