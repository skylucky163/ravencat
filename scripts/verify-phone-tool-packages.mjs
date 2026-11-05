import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadTypeScriptModule, readRepoFile as read } from './helpers/load-typescript-module.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const packageCatalogModule = loadTypeScriptModule(
  'src/features/phoneTools/toolPackages/ToolPackageCatalog.ts',
);
const directCatalogModule = loadTypeScriptModule(
  'src/features/phoneTools/domain/PhoneToolCatalog.ts',
);
const displayModelModule = loadTypeScriptModule(
  'src/features/miniPrograms/presentation/phoneTools/ToolPackageDisplayModel.ts',
);

const {
  getPhoneToolPackageById,
  PHONE_TOOL_PACKAGE_CATALOG,
} = packageCatalogModule;
const { PHONE_TOOL_CATALOG, PHONE_TOOL_CATEGORIES } = directCatalogModule;
const { buildToolPackageDisplayModel, getPhoneToolReadinessLabel } = displayModelModule;

assert.notStrictEqual(
  PHONE_TOOL_PACKAGE_CATALOG,
  PHONE_TOOL_CATALOG,
  'Tool Package Catalog 必须独立于直接 Phone Tool Catalog',
);

const neteaseMusic = getPhoneToolPackageById('neteaseMusic');
assert.ok(neteaseMusic, '必须存在网易云音乐工具包 shell');
assert.equal(neteaseMusic.title, '网易云音乐工具包');
assert.equal(neteaseMusic.implementationStatus, 'available');
assert.deepEqual(
  neteaseMusic.tools.map(({ toolName }) => toolName),
  [
    'netease_search_songs',
    'netease_search_public_playlists',
    'netease_get_public_playlist',
    'netease_get_song_lyrics',
    'netease_resolve_share_link',
    'netease_play_song',
    'netease_get_playback_state',
    'netease_control_playback',
  ],
  'NetEase package 必须展示八个已上线 child Tools',
);
assert.ok(
  neteaseMusic.tools.every(({ implementationStatus }) => implementationStatus === 'available'),
);
assert.equal(getPhoneToolPackageById('unknown'), undefined, '未知 package id 必须安全返回 undefined');

const packageIds = PHONE_TOOL_PACKAGE_CATALOG.map((toolPackage) => toolPackage.id);
assert.equal(new Set(packageIds).size, packageIds.length, 'Tool Package id 不得重复');

const packageToolNames = PHONE_TOOL_PACKAGE_CATALOG.flatMap(
  (toolPackage) => toolPackage.tools.map((tool) => tool.toolName),
);
assert.equal(
  new Set(packageToolNames).size,
  packageToolNames.length,
  'Tool Package child toolName 必须在整个目录中唯一',
);

for (const descriptor of [
  ...PHONE_TOOL_PACKAGE_CATALOG,
  ...PHONE_TOOL_PACKAGE_CATALOG.flatMap((toolPackage) => toolPackage.tools),
]) {
  for (const runtimeField of ['owner', 'risk', 'hostOnly', 'idempotency', 'execution']) {
    assert.equal(
      Object.hasOwn(descriptor, runtimeField),
      false,
      `Tool Package 产品目录不得复制 Runtime metadata：${runtimeField}`,
    );
  }
}

assert.equal(
  PHONE_TOOL_CATEGORIES.some((category) => category.id === 'integration'),
  false,
  'Tool Package 不得重新成为直接 Tool category',
);
assert.equal(
  PHONE_TOOL_CATALOG.some(
    (tool) => tool.toolName === 'play_music' || tool.id === 'musicPlayback',
  ),
  false,
  '旧 generic play_music 产品占位必须退役',
);

const expectedDirectTools = [
  'read_clipboard',
  'get_current_location',
  'search_installed_apps',
  'get_foreground_app',
  'get_app_usage',
  'read_screen_accessibility',
  'read_screen_ocr',
  'open_app',
  'soft_lock_app',
  'release_soft_lock',
];
assert.deepEqual(
  PHONE_TOOL_CATALOG.map((tool) => tool.toolName).sort(),
  expectedDirectTools.sort(),
  '当前手机工具目录必须完整保留直接工具',
);
assert.ok(
  PHONE_TOOL_CATALOG.every((tool) => tool.implementationStatus === 'available'),
  '现有直接 Phone Tools 必须全部 available',
);

const syntheticModel = buildToolPackageDisplayModel({
  id: 'synthetic',
  title: '测试工具包',
  description: '只用于验证通用 display model。',
  implementationStatus: 'available',
  tools: [
    {
      id: 'availableTool',
      toolName: 'synthetic_available_tool',
      title: '可用工具',
      description: '可用状态测试。',
      implementationStatus: 'available',
    },
    {
      id: 'plannedTool',
      toolName: 'synthetic_planned_tool',
      title: '规划工具',
      description: '规划状态测试。',
      implementationStatus: 'planned',
    },
  ],
});
assert.deepEqual(
  syntheticModel.tools.map((tool) => tool.statusLabel),
  ['已接入', '开发中'],
  '通用详情 display model 必须支持未来非空 tools 的两种状态',
);

const readyAccess = {
  observer: { accessibilityEnabled: true, accessibilityConnected: true, canRetrieveWindowContent: true, canTakeScreenshot: true },
  usageAccessGranted: true,
  overlayGranted: true,
  notificationListenerGranted: true,
  location: { permission: 'precise', servicesEnabled: true },
};
for (const tool of [...PHONE_TOOL_CATALOG, ...PHONE_TOOL_PACKAGE_CATALOG.flatMap(item => item.tools)]) {
  assert.equal(getPhoneToolReadinessLabel(tool.toolName, true, readyAccess), '权限就绪');
  assert.equal(getPhoneToolReadinessLabel(tool.toolName, false, readyAccess), '已关闭');
}
assert.equal(getPhoneToolReadinessLabel('get_app_usage', true, { ...readyAccess, usageAccessGranted: false }), '待授权使用情况');
assert.equal(getPhoneToolReadinessLabel('get_current_location', true, { ...readyAccess, location: { permission: 'not_granted', servicesEnabled: true } }), '待授权定位');
assert.equal(getPhoneToolReadinessLabel('get_current_location', true, { ...readyAccess, location: { permission: 'precise', servicesEnabled: false } }), '系统定位已关闭');
assert.equal(getPhoneToolReadinessLabel('get_current_location', true, { ...readyAccess, location: { permission: 'approximate', servicesEnabled: true } }), '权限就绪');
for (const name of ['get_foreground_app', 'read_screen_accessibility', 'read_screen_ocr', 'soft_lock_app', ...getPhoneToolPackageById('xiaohongshu').tools.map(tool => tool.toolName)]) {
  assert.equal(getPhoneToolReadinessLabel(name, true, { ...readyAccess, observer: { ...readyAccess.observer, accessibilityEnabled: false } }), '待授权无障碍');
  assert.equal(getPhoneToolReadinessLabel(name, true, { ...readyAccess, observer: { ...readyAccess.observer, accessibilityConnected: false } }), '无障碍未连接');
}
assert.equal(getPhoneToolReadinessLabel('read_screen_accessibility', true, { ...readyAccess, observer: { ...readyAccess.observer, canRetrieveWindowContent: false } }), '无法读取页面');
assert.equal(getPhoneToolReadinessLabel('read_screen_ocr', true, { ...readyAccess, observer: { ...readyAccess.observer, canTakeScreenshot: false } }), '无法截图');
assert.equal(getPhoneToolReadinessLabel('soft_lock_app', true, { ...readyAccess, overlayGranted: false }), '待授权悬浮显示');
for (const name of ['netease_get_playback_state', 'netease_control_playback']) {
  assert.equal(getPhoneToolReadinessLabel(name, true, { ...readyAccess, notificationListenerGranted: false }), '待授权通知使用权');
}
const noAccess = { observer: { accessibilityEnabled: false, accessibilityConnected: false, canRetrieveWindowContent: false, canTakeScreenshot: false }, usageAccessGranted: false, overlayGranted: false, notificationListenerGranted: false };
for (const name of ['search_installed_apps', 'open_app', 'release_soft_lock', 'netease_search_songs', 'netease_play_song']) {
  assert.equal(getPhoneToolReadinessLabel(name, true, noAccess), '权限就绪', '无关权限不能制造总门禁');
}

// 用真实 Hook 验证页面开关持久写入、返回刷新与无主理状态，避免只验证静态标签。
const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let onAppStateChange;
let hostPresent = true;
let usageGranted = false;
let locationPermission = 'not_granted';
const permissions = new Map([...PHONE_TOOL_CATALOG, ...neteaseMusic.tools].map(({ toolName }) => [toolName, true]));
const writes = [];
const packageWrites = [];
const appToolPackages = { neteaseMusic: true };
const dialogs = [];
let failRead = false;
let failWrite = false;
const { usePhoneToolSettings } = loadTypeScriptModule('src/features/miniPrograms/presentation/phoneTools/usePhoneToolSettings.ts', {
  react: React,
  'react-native': { AppState: { addEventListener: (_event, listener) => {
    onAppStateChange = listener;
    return { remove: () => { onAppStateChange = undefined; } };
  } } },
  '@react-navigation/native': { useFocusEffect: (callback) => React.useEffect(callback, [callback]) },
  '@features/prompting': {
    getAppToolPackageSettings: async () => ({ ...appToolPackages }),
    setAppToolPackageEnabled: async (packageId, enabled) => {
      if (failWrite) throw new Error('保存失败');
      packageWrites.push({ packageId, enabled });
      appToolPackages[packageId] = enabled;
    },
    listPromptAssistantOptions: async () => hostPresent ? [{ id: 'host-ai', name: '主理', isHostAI: true }] : [],
    getAssistantToolPermissions: async () => {
      if (failRead) throw new Error('读取失败');
      return [...permissions].map(([name, enabled]) => ({ name, enabled }));
    },
    setAssistantToolPermission: async (assistantId, toolName, enabled) => {
      if (failWrite) throw new Error('保存失败');
      writes.push({ assistantId, toolName, enabled });
      permissions.set(toolName, enabled);
    },
  },
  '@features/deviceControl': {
    getDeviceObserverConnectionState: async () => readyAccess.observer,
    getNotificationListenerAccessState: async () => ({ status: 'not_granted' }),
  },
  '@features/floatingLayer': { isOverlayPermissionGranted: async () => true },
  '@platform/device': {
    isUsageAccessGranted: async () => usageGranted,
    getDeviceLocationAccessState: async () => ({ permission: locationPermission, servicesEnabled: true }),
  },
  '@shared/ui': { showAppDialog: (dialog) => dialogs.push(dialog) },
  '@features/phoneTools': packageCatalogModule,
  './ToolPackageDisplayModel': displayModelModule,
});
let settings;
function Harness() { settings = usePhoneToolSettings(); return null; }
let renderer;
await act(async () => { renderer = create(React.createElement(Harness)); });
assert.equal(settings.disabled, false);
assert.equal(settings.statusLabel('get_app_usage'), '待授权使用情况');
assert.equal(settings.statusLabel('get_current_location'), '待授权定位');
assert.equal(settings.statusLabel('netease_control_playback'), '待授权通知使用权');
assert.equal(settings.isPackageEnabled('xiaohongshu'), false, '未配置的应用包默认关闭');
assert.equal(settings.isPackageEnabled('neteaseMusic'), true);
await act(async () => { await settings.togglePackage('neteaseMusic', false); });
assert.equal(settings.statusLabel('netease_search_songs'), '工具包已关闭');
assert.equal(settings.isEnabled('netease_search_songs'), true, '总开关不改写单项偏好');
failWrite = true;
await act(async () => { await settings.togglePackage('neteaseMusic', true); });
assert.equal(settings.isPackageEnabled('neteaseMusic'), false, '总开关保存失败不伪造状态');
failWrite = false;
await act(async () => { await settings.togglePackage('neteaseMusic', true); });
assert.equal(settings.statusLabel('netease_search_songs'), '权限就绪');
assert.deepEqual(packageWrites, [{ packageId: 'neteaseMusic', enabled: false }, { packageId: 'neteaseMusic', enabled: true }]);
await act(async () => { await settings.toggleTool('netease_search_songs', false); });
assert.deepEqual(writes, [{ assistantId: 'host-ai', toolName: 'netease_search_songs', enabled: false }]);
assert.equal(settings.isEnabled('netease_search_songs'), false);
assert.equal(settings.statusLabel('netease_search_songs'), '已关闭');
permissions.set('netease_search_songs', true);
usageGranted = true;
locationPermission = 'approximate';
await act(async () => { onAppStateChange('active'); });
assert.equal(settings.isEnabled('netease_search_songs'), true, '返回页面读取提示词中心保存的同一份权限');
assert.equal(settings.statusLabel('get_app_usage'), '权限就绪', '返回系统设置后刷新授权状态');
assert.equal(settings.statusLabel('get_current_location'), '权限就绪', '返回系统设置后刷新大致位置授权');
failWrite = true;
await act(async () => { await settings.toggleTool('netease_search_songs', false); });
assert.equal(settings.isEnabled('netease_search_songs'), true, '保存失败不伪造关闭状态');
assert.equal(dialogs.at(-1).title, '保存失败');
failWrite = false;
failRead = true;
await act(async () => { onAppStateChange('active'); });
assert.equal(settings.disabled, true);
assert.equal(settings.statusLabel('get_app_usage'), '状态读取失败');
failRead = false;
hostPresent = false;
await act(async () => { onAppStateChange('active'); });
assert.equal(settings.disabled, true);
assert.equal(settings.statusLabel('get_app_usage'), '未设置主理 AI');
await act(async () => { await settings.toggleTool('get_app_usage', true); });
assert.equal(writes.length, 1, '未设置主理 AI 时不得借用其他 AI 的权限');
assert.equal(settings.packageDisabled, false, '全局总开关不借用某位 AI 的身份');
await act(async () => { await settings.togglePackage('xiaohongshu', true); });
assert.equal(settings.isPackageEnabled('xiaohongshu'), true);
await act(async () => { renderer.unmount(); });

// 真实公共开关与目录页一起渲染，保护开关/详情互不触发以及各主题的 token 使用。
const ts = require('typescript');
function loadComponent(relative, mocks) {
  const compiled = ts.transpileModule(read(relative), { fileName: relative, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputText)((id) => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    assert.ok(Object.hasOwn(mocks, id), `${relative} 未提供依赖 ${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}
const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TouchableOpacity', 'Pressable'].map(name => [name, name]));
native.StyleSheet = { create: styles => styles, hairlineWidth: 1, absoluteFillObject: {} };
native.Animated = { View: 'AnimatedView', Value: class { interpolate() { return 0; } }, timing: () => ({ start() {}, stop() {} }) };
let currentTheme;
const themeMock = { useTheme: () => currentTheme, useThemedStyles: factory => factory(currentTheme), ThemedSurface: 'ThemedSurface' };
const Toggle = loadComponent('src/shared/ui/Toggle.tsx', { 'react-native': native, '@shared/theme': themeMock }).default;
const ToggleField = loadComponent('src/shared/ui/ToggleField.tsx', { 'react-native': native, '@shared/theme': themeMock, './Toggle': { default: Toggle, __esModule: true } }).default;
const ToggleDetailRow = loadComponent('src/shared/ui/ToggleDetailRow.tsx', {
  'react-native': native, '@shared/theme': themeMock, '@expo/vector-icons': { Ionicons: 'Ionicons' },
  './ToggleField': { default: ToggleField, __esModule: true },
}).default;
const uiActions = [];
const screenSettings = { isEnabled: () => false, statusLabel: () => '已关闭', toggleTool: async () => {},
  isPackageEnabled: () => false, togglePackage: async (...args) => { uiActions.push(['toggle', ...args]); },
  disabled: false, packageDisabled: false, hostName: '主理', notice: null };
const Screen = loadComponent('src/features/miniPrograms/presentation/phoneTools/PhoneToolsScreen.tsx', {
  'react-native': native, '@shared/theme': themeMock, '@shared/ui': { ToggleField, ToggleDetailRow },
  'lucide-react-native': Object.fromEntries(['ClipboardPaste', 'MapPin', 'Music2', 'NotebookPen'].map(name => [name, name])),
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  '@features/phoneTools': { ...packageCatalogModule, ...directCatalogModule },
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader', __esModule: true },
  './PhoneToolsDirectoryModel': loadTypeScriptModule('src/features/miniPrograms/presentation/phoneTools/PhoneToolsDirectoryModel.ts'),
  './usePhoneToolSettings': { usePhoneToolSettings: () => screenSettings },
}).default;
for (const themeName of ['defaultLight', 'defaultDark', 'liquidGlass']) {
  currentTheme = loadTypeScriptModule(`src/shared/theme/themes/${themeName}.ts`)[`${themeName}Theme`];
  await act(async () => { renderer = create(React.createElement(Screen, {
    onBack() {}, onOpenToolPackage: id => uiActions.push(['details', id]),
  })); });
  for (const toolPackage of PHONE_TOOL_PACKAGE_CATALOG) {
    const toggle = renderer.root.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === `启用${toolPackage.title}`);
    assert.equal(toggle.props.accessibilityState.checked, false);
    const before = uiActions.length;
    await act(async () => { toggle.props.onPress(); });
    assert.deepEqual(uiActions.slice(before), [['toggle', toolPackage.id, true]], '总开关不能触发详情导航');
    const details = renderer.root.find(node => node.type === 'TouchableOpacity' && node.props.accessibilityLabel === `查看${toolPackage.title}详情`);
    details.props.onPress();
    assert.deepEqual(uiActions.at(-1), ['details', toolPackage.id]);
    assert.equal(uiActions.length, before + 2, '查看详情不能翻转总开关');
  }
  assert.ok(renderer.root.findAllByType('ThemedSurface').every(node => node.props.nativeGlass && node.props.variant === 'card'));
  await act(async () => { renderer.unmount(); });
}

const directoryModel = read(
  'src/features/miniPrograms/presentation/phoneTools/PhoneToolsDirectoryModel.ts',
);
assert.match(directoryModel, /PHONE_TOOL_CATALOG|catalog/, '直接 Tool directory 必须继续消费直接 Catalog');
assert.doesNotMatch(directoryModel, /PHONE_TOOL_PACKAGE_CATALOG/, 'Tool Packages 不得污染直接 Tool directory');

const detailScreen = read(
  'src/features/miniPrograms/presentation/phoneTools/ToolPackageScreen.tsx',
);
assert.match(detailScreen, /getPhoneToolPackageById/, '通用详情页必须按 package id resolve');
assert.match(detailScreen, /工具包不存在/, '通用详情页必须安全显示 unknown package');
assert.match(detailScreen, /tools\.length === 0/, '通用详情页必须处理 empty tools');
assert.match(detailScreen, /当前暂无可用工具/, '通用详情页必须显示 empty state');
assert.doesNotMatch(detailScreen, /neteaseMusic|网易云/, '通用详情页不得包含 App-specific branch 或文案');

const dynamicRoute = 'src/app/phone-tools/packages/[packageId].tsx';
assert.equal(fs.existsSync(path.join(repoRoot, dynamicRoute)), true, '必须存在通用动态 package route');
assert.match(read(dynamicRoute), /ToolPackageScreen/, '动态 route 必须只适配通用详情页');
assert.equal(
  fs.existsSync(path.join(repoRoot, 'src/app/phone-tools/netease-music.tsx')),
  false,
  '不得建立网易云硬编码 route',
);

const scopedSources = [
  'src/features/phoneTools/toolPackages/ToolPackageCatalog.ts',
  'src/features/miniPrograms/presentation/phoneTools/PhoneToolsScreen.tsx',
  'src/features/miniPrograms/presentation/phoneTools/ToolPackageScreen.tsx',
].map(read).join('\n');
for (const forbidden of [
  'get_tool_package_tools',
  'discover_tool_package',
  'activate_tool_package',
  'SkillRegistry',
  'SkillLoader',
  'SkillPlanner',
]) {
  assert.equal(scopedSources.includes(forbidden), false, `PHONE-7A 禁止新增 ${forbidden}`);
}
assert.doesNotMatch(scopedSources, /Netease\w*Tool/, 'PHONE-7A 禁止新增网易云真实 Tool');

console.log('Phone Tool Package catalog and UI contracts verified.');
