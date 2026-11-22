/** 验证真实菜单入口、统计和导入页面与原生 Stack 的返回契约。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { StackActions, StackRouter } from '@react-navigation/routers';

const require = createRequire(import.meta.url);
const ts = require('typescript');

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
  typography: { body: { fontSize: 15 } },
};
const shared = {
  react: React,
  'react-native': { ActivityIndicator: 'ActivityIndicator', Alert: {}, FlatList: 'FlatList', Keyboard: { dismiss: () => {} }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View', StyleSheet: { create: (styles) => styles } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': { ThemedSurface: 'ThemedSurface', useTheme: () => theme, useThemedStyles: (factory) => factory(theme) },
  '@shared/ui': { NavigationHeader: 'NavigationHeader', AIInfoCard: 'AIInfoCard', ListItem: 'ListItem', InputField: 'InputField', KeyboardAvoidingContainer: 'KeyboardAvoidingContainer', Button: 'Button' },
  '@shared/ui/NavigationHeader': { __esModule: true, default: 'NavigationHeader' },
  'lucide-react-native': { HeartHandshake: 'HeartHandshake', BookOpen: 'BookOpen', Download: 'Download', History: 'History', Library: 'Library', Search: 'Search', UserRound: 'UserRound' },
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  '@features/assistants': { getAssistantDisplayName: (assistant) => assistant.nickname || assistant.name },
};
const parts = load('src/features/chat/presentation/conversation/AIOptionsParts.tsx', shared);
const menu = load('src/features/chat/presentation/conversation/AIOptions.tsx', { ...shared, './AIOptionsParts': parts });
const sourcesScreen = load('src/features/chat/presentation/conversation/ConversationImportScreen.tsx', shared);
const sampleConversation = { messages: 2, thoughts: 0, files: 0, first: { role: '用户', text: '提问' },
  last: { role: 'DeepSeek', text: '回答' }, hasHistoryGap: false };
let pendingArchive;
let archiveReads = 0;
let archiveDisposals = 0;
const archive = {
  conversations: [{ id: 'alpha', title: 'Alpha 对话', messageCount: 2 }, { id: 'beta', title: 'Beta 对话', messageCount: 4 }],
  readConversation: async id => { archiveReads++; assert.equal(id, 'alpha'); return sampleConversation; },
  dispose: () => { archiveDisposals++; },
};
const importScreen = load('src/features/chat/presentation/conversation/DeepSeekImportScreen.tsx', {
  ...shared,
  '../../messages/application/ImportDeepSeekConversation': {
    describeDeepSeekConversation: (conversation) => conversation,
    loadDeepSeekImport: (link, signal) => {
      assert.equal(link, 'archive-link');
      return pendingArchive ? pendingArchive(signal) : Promise.resolve(archive);
    },
    importDeepSeekConversation: async (target, source, conversation) => {
      assert.equal(target, 'ai-1');
      assert.equal(source, archive);
      assert.equal(conversation, sampleConversation);
      return { sessionId: 'session-1', missingFiles: 0, messageCount: 2 };
    },
  },
});
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
const stackOptions = { routeNames: ['conversation', 'menu', 'statistics', 'search', 'conversationImport', 'deepSeekImport'], routeParamList: {}, routeGetIdList: {} };
let navigationState = stack.getInitialState(stackOptions);
function dispatch(action) {
  navigationState = stack.getStateForAction(navigationState, action, stackOptions);
  assert.ok(navigationState);
}
dispatch(StackActions.push('menu'));
let currentSubScreen = null;
const invalidatedSessions = [];
const router = {
  state: {
    currentAI: { id: 'ai-1', name: 'AI', model: 'model', createdAt: '2026-10-01T00:00:00.000Z' },
    currentSession: { id: 'session-1' },
    setCurrentSubScreen: (value) => { currentSubScreen = typeof value === 'function' ? value(currentSubScreen) : value; },
    handleCloseMenu: () => { currentSubScreen = null; },
  },
  ensureConversation: async () => 'ready',
  openSubScreen: (name) => { currentSubScreen = name; dispatch(StackActions.push(name)); },
  routeBack: () => dispatch(StackActions.pop()),
  returnToConversation: (aiId) => {
    assert.equal(aiId, 'ai-1');
    dispatch(StackActions.popToTop());
  },
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
  '../../group/application', '../../group/application/GroupMembership', '../../conversation/application/ChatPresentation',
].map((id) => [id, defaults]));
const routes = load('src/features/chat/presentation/shell/ChatRouteScreens.tsx', {
  ...shared, ...routeDependencies,
  '@features/assistants': shared['@features/assistants'],
  '../conversation/AIOptions': menu,
  '../conversation/ConversationImportScreen': sourcesScreen,
  '../conversation/DeepSeekImportScreen': importScreen,
  '../conversation/ChatStatisticsScreen': screen,
  '../messages/components/sessionTimelineCache': { clearSessionTimelineCache: (id) => { invalidatedSessions.push(id); } },
  './ChatRouterContext': { useChatRouter: () => router },
});
let params = { aiId: 'ai-1' };
const appDependencies = {
  '@features/chat': routes,
  'expo-router': { useLocalSearchParams: () => params, Redirect: 'Redirect' },
};
const appRoute = load('src/app/chat/[aiId]/statistics.tsx', appDependencies);
const sourcesRoute = load('src/app/chat/[aiId]/conversation-import/index.tsx', appDependencies);
const importRoute = load('src/app/chat/[aiId]/conversation-import/deepseek.tsx', appDependencies);
let menuRenderer;
let statisticsRenderer;
let sourcesRenderer;
let importRenderer;
let profileOpens = 0;
try {
  await act(async () => { menuRenderer = create(React.createElement(routes.ChatMenuRouteScreen, {
    aiId: 'ai-1', onOpenAssistantProfile: () => profileOpens++,
  })); });
  assert.equal(currentSubScreen, 'menu');
  assert.equal(queryCount, 0, '更多页面只展示入口，不读取统计或内嵌统计正文');
  const menuTitles = menuRenderer.root.findAllByType('TouchableOpacity').map((item) =>
    item.findAllByType('Text').map((text) => text.children.join('')).join(''));
  // 对话导入位于主区靠前的四字选项中，其余入口可自由调整顺序。
  assert.ok(menuTitles.indexOf('作品库') < menuTitles.indexOf('对话导入'));
  assert.ok(menuTitles.indexOf('对话导入') < menuTitles.indexOf('搜索聊天记录'));
  assert.deepEqual(menuTitles.sort(), ['模型设置', '协议空间', '聊天摘要', '搜索聊天记录', '对话设置', '通话记录', '相遇痕迹', '作品库', '对话导入', '清除聊天记录', '删除当前 AI'].sort());
  const importEntry = menuRenderer.root.findAllByType('TouchableOpacity').find(item =>
    item.findAllByType('Text').some(label => label.children.join('') === '对话导入'));
  await act(async () => { importEntry.props.onPress(); });
  assert.equal(navigationState.routes.at(-1).name, 'conversationImport');
  await act(async () => { sourcesRenderer = create(React.createElement(sourcesRoute.default)); });
  assert.equal(sourcesRenderer.root.findByType('NavigationHeader').props.title, '对话导入');
  assert.equal(sourcesRenderer.root.findByType('ListItem').props.title, 'DeepSeek');
  const openForm = async () => {
    await act(async () => { sourcesRenderer.root.findByType('ListItem').props.onPress(); });
    assert.equal(navigationState.routes.at(-1).name, 'deepSeekImport');
    await act(async () => { importRenderer = create(React.createElement(importRoute.default)); });
    assert.equal(importRenderer.root.findByType('NavigationHeader').props.title, '导入 DeepSeek 对话');
    const field = importRenderer.root.findByType('InputField');
    assert.equal(field.props.label, 'DeepSeek ZIP 导出链接');
    await act(async () => { field.props.onChangeText('archive-link'); });
  };
  await openForm();
  let archiveSignal;
  let resolveArchive;
  pendingArchive = (signal) => {
    archiveSignal = signal;
    return new Promise(resolve => { resolveArchive = resolve; });
  };
  await act(async () => { importRenderer.root.findByType('Button').props.onPress(); });
  dispatch(StackActions.pop());
  await act(async () => { importRenderer.unmount(); });
  assert.equal(archiveSignal.aborted, true);
  assert.equal(currentSubScreen, 'conversationImport');
  assert.equal(navigationState.routes.at(-1).name, 'conversationImport');
  await act(async () => { resolveArchive(archive); });
  assert.equal(archiveDisposals, 1, '离开页面后回来的 ZIP 会被清理');
  pendingArchive = undefined;
  await act(async () => { sourcesRenderer.root.findByType('NavigationHeader').props.onGoBack(); sourcesRenderer.unmount(); });
  assert.equal(currentSubScreen, 'menu');
  assert.equal(navigationState.routes.at(-1).name, 'menu');
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
  params = { aiId: ['ai-1'] };
  await act(async () => { importEntry.props.onPress(); sourcesRenderer = create(React.createElement(sourcesRoute.default)); });
  await openForm();
  const findButton = title => importRenderer.root.findAllByType('Button').find(button => button.props.title === title);
  await act(async () => { findButton('读取对话列表').props.onPress(); });
  const getList = () => importRenderer.root.findByType('FlatList').props;
  assert.equal(archiveReads, 0, '目录加载后只展示列表');
  assert.equal(getList().data.length, 2);
  await act(async () => { importRenderer.root.findByType('InputField').props.onChangeText(' ALPHA '); });
  assert.deepEqual(getList().data.map(item => item.id), ['alpha']);
  const choose = async () => {
    const list = getList();
    await act(async () => { list.renderItem({ item: list.data[0] }).props.onPress(); });
  };
  await choose();
  assert.equal(archiveReads, 1);
  assert.ok(findButton('导入到当前 AI'));
  await act(async () => { findButton('重新选择对话').props.onPress(); });
  assert.equal(importRenderer.root.findByType('InputField').props.value, ' ALPHA ');
  assert.equal(archiveDisposals, 1, '重新选择对话时复用已下载的 ZIP');
  await choose();
  await act(async () => { findButton('导入到当前 AI').props.onPress(); });
  assert.deepEqual(invalidatedSessions, ['session-1']);
  assert.equal(archiveDisposals, 2);
  await act(async () => { findButton('查看聊天').props.onPress(); });
  assert.deepEqual(navigationState.routes.map(({ name }) => name), ['conversation']);
  console.log('统计与导入导航验证通过：独立页面、ZIP 搜索与预览、取消和返回。');
} finally {
  await act(async () => { importRenderer?.unmount(); sourcesRenderer?.unmount(); statisticsRenderer?.unmount(); menuRenderer?.unmount(); });
}
