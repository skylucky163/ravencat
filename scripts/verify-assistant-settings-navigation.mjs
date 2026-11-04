/** 设置迁移的真实页面与 Shell 行为：目标隔离、只读会话、正式地址与提交事实消费。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(name => {
    if (name === 'react') return { ...React, default: React };
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(dependencies, name), `${file} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const listeners = new Set();
const profiles = new Map([
  ['a', { id: 'a', agentId: 'agent-a', name: 'A', model: 'model-a', showTokenUsage: true }],
  ['b', { id: 'b', agentId: 'agent-b', name: 'B', model: 'model-b', showTokenUsage: true,
    lastMessage: '已到达的预览', lastTime: '2026-11-01', isPinned: true, pinnedAt: '2026-10-31' }],
]);
const assistantFacts = {
  subscribeAIAssistantUpdated: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  getAIAssistantById: async id => profiles.get(id) ?? null,
  getAssistantDisplayName: profile => profile.name,
};
const query = load('src/features/assistants/presentation/profile/useAIAssistantProfile.ts', {
  '../../AIAssistantManagement': assistantFacts,
});
const native = { ActivityIndicator: 'Spinner', Text: 'Text', View: 'View', ScrollView: 'ScrollView', StyleSheet: { create: value => value },
  Keyboard: { dismiss() {} } };
const reads = [];
let read = deferred();
const { default: ConversationPage } = load('src/features/chat/presentation/conversation/AssistantConversationPage.tsx', {
  'react-native': native,
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@features/assistants': query,
  '@shared/theme': { useThemedStyles: () => ({}) },
  '@shared/ui': { Button: 'Button', EmptyState: 'EmptyState' },
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader' },
  '../../conversation/application/ChatPresentation': { getCanonicalChatConversation: id => {
    reads.push(id); return read.promise;
  } },

});
const { default: SettingsScreen } = load('src/features/chat/presentation/conversation/AssistantContextSettingsScreen.tsx', {
  './AssistantConversationPage': { default: ConversationPage }, './ContextSettings': { default: 'ContextSettings' },
});
const { default: ReplySettingsScreen } = load('src/features/chat/presentation/conversation/AssistantChatSettingsScreen.tsx', {
  './AssistantConversationPage': { default: ConversationPage }, './ChatSettings': { default: 'ReplySettings' },
});
let renderer;
let backCount = 0;
let fixedCount = 0;
const settingsProps = { aiId: 'a', onBack: () => backCount++, onChooseFixedStart: () => fixedCount++ };
try {
  await act(async () => { renderer = create(React.createElement(SettingsScreen, settingsProps)); });
  assert.deepEqual(reads, ['a'], '按目标 AI 读取既有会话，不准备当前聊天');
  assert.equal(renderer.root.findAllByType('ContextSettings').length, 0);
  await act(async () => { renderer.root.findByType('NavigationHeader').props.onGoBack(); });
  assert.equal(backCount, 1, '加载时也可普通返回');
  await act(async () => { read.resolve({ id: 'canonical-a' }); });
  let form = renderer.root.findByType('ContextSettings');
  assert.equal(form.props.aiAssistant.id, 'a');
  assert.equal(form.props.conversationId, 'canonical-a');
  assert.equal(fixedCount, 0, '单纯打开设置没有固定起点导航副作用');
  await act(async () => { form.props.onChooseFixedStart(); });
  assert.equal(fixedCount, 1);
  await act(async () => {
    for (const listener of listeners) listener({ ...profiles.get('a'), showTokenUsage: false });
  });
  form = renderer.root.findByType('ContextSettings');
  assert.equal(form.props.aiAssistant.showTokenUsage, false);
  assert.deepEqual(reads, ['a'], '配置事实不重新准备或创建会话');
  await act(async () => { renderer.unmount(); });
  assert.equal(listeners.size, 0);

  read = deferred();
  await act(async () => { renderer = create(React.createElement(SettingsScreen, settingsProps)); });
  await act(async () => { read.reject(new Error('SQLite read failed')); });
  assert.equal(renderer.root.findByType('Button').props.title, '重试');
  assert.equal(renderer.root.findAllByType('ContextSettings').length, 0);
  read = deferred();
  await act(async () => { renderer.root.findByType('Button').props.onPress(); });
  await act(async () => { read.resolve(null); });
  assert.equal(renderer.root.findByType('EmptyState').props.title, '找不到这个 AI 的会话');
  assert.equal(renderer.root.findAllByType('ContextSettings').length, 0, '没有会话时不制造替代身份');
  read = deferred();
  await act(async () => { renderer.root.findByType('EmptyState').props.onAction(); });
  await act(async () => { read.resolve({ id: 'canonical-a' }); });
  assert.equal(renderer.root.findByType('ContextSettings').props.conversationId, 'canonical-a');
  await act(async () => { renderer.unmount(); });

  await act(async () => { renderer = create(React.createElement(SettingsScreen, { ...settingsProps, aiId: 'missing' })); });
  assert.equal(renderer.root.findByType('EmptyState').props.title, '找不到这个 AI');
  assert.equal(renderer.root.findAllByType('ContextSettings').length, 0);
} finally { await act(async () => { renderer?.unmount(); }); }

// App / Host 只装配目标与导航；旧链接替换到同一正式地址。
let params = { aiId: 'a/b' };
const navigations = [];
const router = { push: target => navigations.push(target), back: () => navigations.push('back'), dismissTo: target => navigations.push(target) };
const expo = { useLocalSearchParams: () => params, useRouter: () => router, Redirect: 'Redirect' };
const { default: ModelRoute } = load('src/app/assistants/[aiId]/model-settings.tsx', {
  'expo-router': expo, '@host': { AssistantModelSettingsRouteContent: 'ModelHost' },
});
const { default: ChatRoute } = load('src/app/assistants/[aiId]/chat-settings.tsx', {
  'expo-router': expo, '@features/chat': { AssistantChatSettingsScreen: 'ChatSettingsScreen' },
});
const { default: ModelHost } = load('src/host/navigation/AssistantModelSettingsRouteContent.tsx', {
  'expo-router': expo, '@features/assistants': { AssistantModelSettingsScreen: 'ModelScreen' },
  '@features/chat': { ChatImageModelPicker: 'ImageModelPicker' },
});
await act(async () => { renderer = create(React.createElement(ModelRoute)); });
assert.equal(renderer.root.findByType('ModelHost').props.aiId, 'a/b');
assert.deepEqual(navigations, []);
await act(async () => { renderer.update(React.createElement(ChatRoute)); });
const chatPage = renderer.root.findByType('ChatSettingsScreen');
chatPage.props.onOpenContextSettings();
assert.equal(navigations.pop(), '/assistants/a%2Fb/context-settings', '对话设置打开与主页相同的上下文地址');
chatPage.props.onBack();
assert.equal(navigations.pop(), 'back', '普通返回保留来源，不固定去旧菜单');
await act(async () => { renderer.update(React.createElement(ModelHost, { aiId: 'a' })); });
const modelPage = renderer.root.findByType('ModelScreen');
assert.equal(modelPage.props.aiId, 'a');
assert.equal(modelPage.props.auxiliaryModelSettings.props.assistantId, 'a');
modelPage.props.onBack();
assert.equal(navigations.pop(), 'back');
for (const kind of ['model-settings', 'chat-settings']) {
  const { default: LegacyRoute } = load(`src/app/chat/[aiId]/${kind}.tsx`, { 'expo-router': expo });
  await act(async () => { renderer.update(React.createElement(LegacyRoute)); });
  assert.equal(renderer.root.findByType('Redirect').props.href, `/assistants/a%2Fb/${kind}`);
}
params = {};
for (const Route of [ModelRoute, ChatRoute]) {
  await act(async () => { renderer.update(React.createElement(Route)); });
  assert.equal(renderer.root.findByType('Redirect').props.href, '/conversations');
}
await act(async () => { renderer.unmount(); });

// 上下文、摘要列表与全部摘要子页使用同一个只读目标解析。
const { default: ContextRoute } = load('src/app/assistants/[aiId]/context-settings.tsx', {
  'expo-router': expo, '@features/chat': { AssistantContextSettingsScreen: 'ContextPage' },
});
params = { aiId: 'a/b' };
await act(async () => { renderer = create(React.createElement(ContextRoute)); });
renderer.root.findByType('ContextPage').props.onChooseFixedStart();
assert.equal(navigations.pop(), '/chat/a%2Fb');
await act(async () => { renderer.unmount(); });

const summaryScreens = load('src/features/chat/summary/presentation/AssistantSummaryRouteScreens.tsx', {
  '../../presentation/conversation/AssistantConversationPage': { default: ConversationPage },
  './ChatSummaryScreen': { default: 'SummaryList' }, './ChatSummaryEditorScreen': { default: 'SummaryEditor' },
  './ChatSecondarySummaryScreen': { default: 'SecondarySummary' }, './ChatSummaryTaskScreen': { default: 'SummaryTask' },
  './ChatSummarySettingsScreen': { default: 'SummarySettings' },
});
read = deferred(); read.resolve({ id: 'canonical-a' });
const summaryProps = { aiId: 'a', onBack: () => navigations.push('back'), onSettings() {},
  onCreateSummary() {}, onEditSummary() {}, onEditSecondary() {}, onTask() {}, onEditSource() {} };
for (const [Screen, extra, type] of [
  [summaryScreens.ChatSummaryRouteScreen, {}, 'SummaryList'],
  [summaryScreens.ChatSummaryEditorRouteScreen, { segmentId: 'segment-a' }, 'SummaryEditor'],
  [summaryScreens.ChatSummaryEditorRouteScreen, { secondary: true }, 'SecondarySummary'],
  [summaryScreens.ChatSummaryEditorRouteScreen, { taskId: 'task-a' }, 'SummaryTask'],
  [summaryScreens.ChatSummarySettingsRouteScreen, {}, 'SummarySettings'],
]) {
  await act(async () => { renderer = create(React.createElement(Screen, { ...summaryProps, ...extra })); });
  const child = renderer.root.findByType(type);
  assert.equal(child.props.conversationId, 'canonical-a', '摘要所有子页仍属于目标 AI');
  child.props.onBack();
  assert.equal(navigations.pop(), 'back');
  await act(async () => { renderer.unmount(); });
}
const { default: SummaryAppRoute } = load('src/app/chat/[aiId]/summary/index.tsx', {
  'expo-router': expo, '@features/chat': { ChatSummaryRouteScreen: 'SummaryRouteScreen' },
});
params = { aiId: 'a' };
await act(async () => { renderer = create(React.createElement(SummaryAppRoute)); });
renderer.root.findByType('SummaryRouteScreen').props.onSettings();
assert.equal(navigations.pop(), '/chat/a/summary/settings');
await act(async () => { renderer.unmount(); });
assert.equal(listeners.size, 0);

read = deferred(); read.resolve({ id: 'canonical-a' });
let contextOpens = 0;
await act(async () => { renderer = create(React.createElement(ReplySettingsScreen, {
  aiId: 'a', onBack() {}, onOpenContextSettings: () => contextOpens++,
})); });
assert.equal(renderer.root.findByType('ReplySettings').props.chatBackgroundKey, 'single:canonical-a');
renderer.root.findByType('ReplySettings').props.onOpenContextSettings();
assert.equal(contextOpens, 1);
await act(async () => { renderer.unmount(); });

// 真实上下文表单保留四项条数，固定起点仅禁用当前单聊，取消后原值仍在。
const contextTheme = { useTheme: () => ({ colors: { feedback: { error: '#f00' } } }), useThemedStyles: () => ({}), ThemedSurface: 'Surface' };
const windowSection = load('src/features/chat/presentation/conversation/ContextWindowSection.tsx', {
  'react-native': native, '@shared/theme': contextTheme, '@shared/ui': { AppTextInput: 'ContextInput' },
  './chatSettingsStyles': {},
});
const contextValues = { privatePrimary: '30', privateSecondary: '10', groupPrimary: '40', groupSecondary: '5' };
const { default: ContextForm } = load('src/features/chat/presentation/conversation/ContextSettings.tsx', {
  'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  '@features/assistants': { ContextLimitsApply: 'ContextLimitsApply' }, '@shared/theme': contextTheme,
  '@shared/ui': { KeyboardAvoidingContainer: 'KeyboardAvoidingContainer' },
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader' }, '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'AutoSaveErrors' },
  '@shared/ui/commonStyles': { createCommonStyles: () => ({}) },
  './ContextWindowSection': windowSection, './FixedChatContextSection': { default: 'FixedContext' },
  './HistoricalGroupsSection': { default: 'HistoricalGroups' }, './chatSettingsStyles': {},
  './useContextSettings': { default: () => ({ contextLimits: contextValues, settingsErrors: {},
    handleContextLimitChange() {}, commit: async () => {}, flush: async () => true,
    back() {}, leave: async action => action(), restoreInfo: async () => {}, blocked: false, infoSaveError: null,
  }) },
});
await act(async () => { renderer = create(React.createElement(ContextForm, {
  aiAssistant: profiles.get('a'), conversationId: 'canonical-a', onBack() {}, onChooseFixedStart() {},
})); });
assert.equal(renderer.root.findAllByType('ContextInput').length, 4);
const primaryInput = () => renderer.root.findAllByType('ContextInput').find(node => node.props.accessibilityLabel === '当前单聊消息注入');
await act(async () => { renderer.root.findByType('FixedContext').props.onFixedChange(true); });
assert.equal(primaryInput().props.editable, false);
assert.ok(renderer.root.findAllByType('ContextInput').filter(node => node !== primaryInput()).every(node => node.props.editable));
await act(async () => { renderer.root.findByType('FixedContext').props.onFixedChange(false); });
assert.equal(primaryInput().props.editable, true);
assert.equal(primaryInput().props.value, '30');
assert.equal(renderer.root.findByType('HistoricalGroups').props.assistantId, 'a');
await act(async () => { renderer.unmount(); });

// 真实 Shell 以提交事实同步配置，保留当前会话、菜单、到达预览与置顶投影。
let aiList = [...profiles.values()];
let listReads = 0;
let viewed = 0;
const loadAIAssistants = async () => { listReads++; return aiList; };
const entry = load('src/features/chat/presentation/shell/useChatConversationEntry.ts', {
  '@features/assistants': assistantFacts, '@shared/ui': { showAppDialog() { assert.fail('不应进入警告流程'); } },
});
const navigation = load('src/features/chat/presentation/shell/useChatNavigation.ts', { 'react-native': native });
const { default: useChatScreen } = load('src/features/chat/presentation/shell/useChatScreen.ts', {
  '@features/assistants': assistantFacts,
  './useAIAssistants': { default: () => ({ aiList, aiListReady: true, loadAIAssistants, removeAIAssistant: async () => {} }) },
  './useChatConversationEntry': entry, './useChatNavigation': navigation,
  './useChatEntryPreload': { useChatEntryPreload: () => ({
    resolveConversation: async () => { assert.fail('设置更新不应解析会话'); },
    preloadConversationTimelines: async () => { assert.fail('设置更新不应预加载消息'); },
    refreshCurrentSession: async () => { assert.fail('设置更新不应切换会话'); },
  }) },
  '@shared/runtime/ConversationListReadySignal': {},
});
let shell;
function Probe() { shell = useChatScreen({ onConversationViewed: () => viewed++ }); return null; }
await act(async () => { renderer = create(React.createElement(Probe)); });
const sessionB = { id: 'canonical-b' };
await act(async () => {
  await shell.handleSelectAI(profiles.get('b'), { preparedSession: sessionB });
  shell.setCurrentSubScreen('menu');
});
const initialB = shell.currentAI;
await act(async () => { for (const listener of listeners) listener({ ...profiles.get('a'), model: 'new-a' }); });
assert.equal(shell.currentAI, initialB, 'A 设置变更不合并进 B');
await act(async () => { for (const listener of listeners) listener({ ...profiles.get('b'),
  model: 'new-b', showTokenUsage: false, showActionSteps: false, privateContextPrimaryLimit: 77,
  lastMessage: '旧快照预览', lastTime: '过期时间', isPinned: false, pinnedAt: null,
}); });
assert.equal(shell.currentAI.model, 'new-b');
assert.equal(shell.currentAI.showTokenUsage, false);
assert.equal(shell.currentAI.showActionSteps, false);
assert.equal(shell.currentAI.privateContextPrimaryLimit, 77);
assert.equal(shell.currentAI.lastMessage, '已到达的预览');
assert.equal(shell.currentAI.lastTime, '2026-11-01');
assert.equal(shell.currentAI.isPinned, true);
assert.equal(shell.currentSession, sessionB);
assert.equal(shell.currentSubScreen, 'menu');
aiList = [...profiles.values()];
await act(async () => { renderer.update(React.createElement(Probe)); });
assert.equal(shell.currentAI.model, 'new-b', '列表旧快照不能覆盖已提交的新配置');
assert.equal(viewed, 1, '只有显式进入聊天推进已读');
assert.equal(listReads, 0, '设置事实消费本身不重复读取列表');
await act(async () => { renderer.unmount(); });
assert.equal(listeners.size, 0);
console.log('设置入口迁移：目标隔离、只读 canonical 会话、正式/旧地址、Host 插槽、固定起点意图与聊天提交事实消费验证通过。');
