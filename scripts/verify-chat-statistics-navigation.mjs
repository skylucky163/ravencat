/** 验证真实菜单入口、路由适配、统计页面与原生 Stack 的返回契约。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { StackActions, StackRouter } from '@react-navigation/routers';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module.require = (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id);
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
  return module.exports;
}

const theme = {
  colors: { background: { screen: 'white', app: 'white' }, surface: { default: 'white', muted: 'gray' }, text: { primary: 'black', secondary: 'gray' }, brand: { primary: 'blue' }, border: { light: 'gray' }, feedback: { error: 'red' } },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24 },
  radius: { lg: 16 },
};
const shared = {
  react: React,
  'react-native': { ActivityIndicator: 'ActivityIndicator', Alert: {}, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View', StyleSheet: { create: (styles) => styles } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': { ThemedSurface: 'ThemedSurface', useTheme: () => theme, useThemedStyles: (factory) => factory(theme) },
  '@shared/ui': { NavigationHeader: 'NavigationHeader', AIInfoCard: 'AIInfoCard' },
  '@shared/ui/NavigationHeader': { __esModule: true, default: 'NavigationHeader' },
  'lucide-react-native': { HeartHandshake: 'HeartHandshake', BookOpen: 'BookOpen', History: 'History', Search: 'Search', UserRound: 'UserRound' },
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  '@features/assistants': { getAssistantDisplayName: (assistant) => assistant.nickname || assistant.name },
};
const parts = load('src/features/chat/presentation/conversation/AIOptionsParts.tsx', shared);
const menu = load('src/features/chat/presentation/conversation/AIOptions.tsx', { ...shared, './AIOptionsParts': parts });
let queryCount = 0;
const screen = load('src/features/chat/presentation/conversation/ChatStatisticsScreen.tsx', {
  ...shared,
  '@react-navigation/native': { useFocusEffect: (effect) => React.useEffect(effect, [effect]) },
  '../../messages/application/ChatStatistics': { getChatStatistics: async (conversationId, createdAt) => {
    queryCount++;
    assert.equal(conversationId, 'session-1');
    assert.equal(createdAt, '2026-10-01T00:00:00.000Z');
    return { encounterStartedAt: createdAt, userMessageCount: 2, assistantMessageCount: 1, userCharacterCount: 3, assistantCharacterCount: 4, totalTokens: 10, promptTokens: 8, completionTokens: 2, assistantRepliesWithoutUsage: 0 };
  } },
  '../../messages/domain/ChatRecordStatistics': { getEncounterDays: () => 7 },
  '../../messages/events/ChatEvents': { setChatEventBus: () => () => {} },
});
const stack = StackRouter({ initialRouteName: 'conversation' });
const stackOptions = { routeNames: ['conversation', 'menu', 'statistics', 'search'], routeParamList: {}, routeGetIdList: {} };
let navigationState = stack.getInitialState(stackOptions);
function dispatch(action) {
  navigationState = stack.getStateForAction(navigationState, action, stackOptions);
  assert.ok(navigationState);
}
dispatch(StackActions.push('menu'));
let currentSubScreen = null;
const router = {
  state: {
    currentAI: { id: 'ai-1', name: 'AI', model: 'model', createdAt: '2026-10-01T00:00:00.000Z' },
    currentSession: { id: 'session-1' },
    setCurrentSubScreen: (value) => { currentSubScreen = typeof value === 'function' ? value(currentSubScreen) : value; },
  },
  ensureConversation: async () => 'ready',
  openSubScreen: (name) => dispatch(StackActions.push(name)),
  routeBack: () => dispatch(StackActions.pop()),
};
const defaults = { __esModule: true, default: () => null };
const routeDependencies = Object.fromEntries([
  '@features/assistants', '@features/speech', '@features/protocol',
  '../conversation/ChatImageModelPicker', '../group/CreateGroup', '../group/GroupAdminSettings',
  '../group/GroupChatDetail', '../group/GroupOptions', '../conversation/ChatSettings',
  '../../summary/presentation/ChatSummaryScreen', '../../summary/presentation/ChatSummaryEditorScreen',
  '../../summary/presentation/ChatSummarySettingsScreen', '../../summary/presentation/ChatSummaryTaskScreen', '../../summary/presentation/ChatSecondarySummaryScreen',
  '../messages/ChatDetail', '../messages/FilePreview', '../messages/components/ChatBackground',
  '../messages/ChatMessageSearchScreen', '../messages/ChatMessageContextScreen',
  '../../group/application', '../../group/application/GroupMembership', '../../conversation/application/ChatPresentation', '../messages/components/sessionTimelineCache',
].map((id) => [id, defaults]));
const routes = load('src/features/chat/presentation/shell/ChatRouteScreens.tsx', {
  ...shared, ...routeDependencies,
  '../conversation/AIOptions': menu,
  '../conversation/ChatStatisticsScreen': screen,
  './ChatRouterContext': { useChatRouter: () => router },
});
let params = { aiId: 'ai-1' };
const appRoute = load('src/app/chat/[aiId]/statistics.tsx', {
  '@features/chat': routes,
  'expo-router': { useLocalSearchParams: () => params, Redirect: 'Redirect' },
});
let menuRenderer;
let statisticsRenderer;
let profileOpens = 0;
try {
  await act(async () => { menuRenderer = create(React.createElement(routes.ChatMenuRouteScreen, {
    aiId: 'ai-1', onOpenAssistantProfile: () => profileOpens++,
  })); });
  assert.equal(currentSubScreen, 'menu');
  assert.equal(queryCount, 0, '更多页面只展示入口，不读取统计或内嵌统计正文');
  const menuTitles = menuRenderer.root.findAllByType('TouchableOpacity').map((item) =>
    item.findAllByType('Text').map((text) => text.children.join('')).join(''));
  // 菜单顺序可随页面调整；导航契约要求入口完整，不冻结当前排列。
  assert.deepEqual(menuTitles.sort(), ['模型设置', '协议空间', '聊天摘要', '搜索聊天记录', '对话设置', '通话记录', '相遇痕迹', '清除聊天记录', '删除当前 AI'].sort());
  const profileCard = menuRenderer.root.findByType('AIInfoCard').parent;
  assert.equal(profileCard.props.accessibilityRole, 'button', '整张名片可点击进入主页');
  await act(async () => { profileCard.props.onPress(); });
  assert.equal(profileOpens, 1, '名片点击交付当前 AI 的主页导航意图');
  const searchEntry = menuRenderer.root.findAllByType('TouchableOpacity').find(item =>
    item.findAllByType('Text').some(text => text.children.join('') === '搜索聊天记录'));
  await act(async () => { searchEntry.props.onPress(); });
  assert.equal(navigationState.routes.at(-1).name, 'search');
  dispatch(StackActions.pop());
  const entry = menuRenderer.root.findAllByType('TouchableOpacity').find((item) =>
    item.findAllByType('Text').some((text) => text.children.join('') === '相遇痕迹'));
  assert.ok(entry, '更多中应有与其他功能相同的可点击菜单入口');
  await act(async () => { entry.props.onPress(); });
  assert.deepEqual(navigationState.routes.map(({ name }) => name), ['conversation', 'menu', 'statistics']);
  await act(async () => { statisticsRenderer = create(React.createElement(appRoute.default)); });
  assert.equal(currentSubScreen, 'statistics');
  assert.equal(queryCount, 1);
  const header = statisticsRenderer.root.findByType('NavigationHeader');
  assert.equal(header.props.title, '相遇痕迹');
  await act(async () => { header.props.onGoBack(); statisticsRenderer.unmount(); });
  assert.equal(navigationState.routes.at(-1).name, 'menu');
  assert.equal(currentSubScreen, 'menu');
  // 系统返回交给原生 Stack；这里只验证 POP 后的页面卸载和菜单恢复，不代替设备手势验证。
  dispatch(StackActions.push('statistics'));
  await act(async () => { statisticsRenderer = create(React.createElement(appRoute.default)); });
  dispatch(StackActions.pop());
  await act(async () => { statisticsRenderer.unmount(); });
  assert.equal(navigationState.routes.at(-1).name, 'menu');
  assert.equal(currentSubScreen, 'menu');
  params = { aiId: ['ai-1'] };
  await act(async () => { statisticsRenderer = create(React.createElement(appRoute.default)); });
  assert.equal(statisticsRenderer.root.findByType('NavigationHeader').props.title, '相遇痕迹');
  await act(async () => { statisticsRenderer.unmount(); });
  params = {};
  await act(async () => { statisticsRenderer = create(React.createElement(appRoute.default)); });
  assert.equal(statisticsRenderer.root.findByType('Redirect').props.href, '/conversations');
  console.log('相遇痕迹导航验证通过：独立菜单入口、路由参数、页面返回及 Stack POP 后恢复更多页面。');
} finally {
  await act(async () => { statisticsRenderer?.unmount(); menuRenderer?.unmount(); });
}
