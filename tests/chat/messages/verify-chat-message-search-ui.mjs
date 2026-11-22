/** 验证用户检索、行内收藏星号、迟到查询隔离、分页、上下文及路由输入边界。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const require = createRequire(import.meta.url);
function load(relative, dependencies) {
  const filename = path.join(root, relative), module = new Module(filename);
  module.filename = filename;
  module.require = id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id);
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename);
  return module.exports;
}
const theme = {
  colors: {
    background: { screen: 'white' }, surface: { default: 'white' }, icon: { secondary: 'gray' },
    text: { primary: 'black', secondary: 'gray' }, brand: { primary: 'blue' }, border: { light: 'gray' }, feedback: { error: 'red' },
  },
  spacing: { md: 16, sm: 8 }, radius: { lg: 16 },
};
const FlatList = React.forwardRef(function List({ data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }, ref) {
  React.useImperativeHandle(ref, () => ({ scrollToOffset() {} }));
  return React.createElement('List', null, ListHeaderComponent,
    data.length ? data.map(item => React.createElement(React.Fragment, { key: item.messageId ?? item.entryId }, renderItem({ item }))) : ListEmptyComponent,
    ListFooterComponent);
});
const shared = {
  react: React,
  'react-native': { FlatList, ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View', Keyboard: { dismiss() {} }, StyleSheet: { create: value => value } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': { useTheme: () => theme, useThemedStyles: factory => factory(theme) },
  '@shared/ui': { AppTextInput: 'AppTextInput', KeyboardAvoidingContainer: 'KeyboardAvoidingContainer', NavigationHeader: 'NavigationHeader' },
  'lucide-react-native': { Search: 'Search', Star: 'Star', X: 'X' },
};
const record = (id, text = '蓝鲸计划', extra = {}) => ({ messageId: id, conversationId: 'direct', author: { role: 'assistant', name: '助手', assistantId: 'ai' }, text, createdAt: '2026-10-01T00:00:00Z', canFavorite: true, ...extra });
const saved = new Map(), favoriteWrites = [], dialogs = [], refReads = [];
const createDefault = async input => {
  favoriteWrites.push(input);
  const favorite = { id: `favorite-${input.messageId}` };
  saved.set(input.messageId, favorite);
  return favorite;
};
let createFavorite = createDefault;
const { useSearchResultFavorites } = load('src/features/chat/presentation/messages/components/useSearchResultFavorites.ts', {
  'react-native': { ToastAndroid: { show() {}, SHORT: 0 } },
  '@shared/ui': { showAppDialog: value => dialogs.push(value) },
  '../../../favorites/application/ChatFavorites': {
    listChatFavoriteRefs: async messageIds => {
      refReads.push([...messageIds]);
      return [...saved].filter(([messageId]) => messageIds.includes(messageId))
        .map(([messageId, favorite]) => ({ id: favorite.id, sourceMessageId: messageId }));
    },
    createChatFavorite: input => createFavorite(input),
    removeChatFavorite: async id => { for (const [messageId, favorite] of saved) if (favorite.id === id) saved.delete(messageId); },
  },
});
const calls = [], opened = [];
let execute = async () => ({ entries: [record(2)], nextOffset: 20 });
const SearchScreen = load('src/features/chat/presentation/messages/ChatMessageSearchScreen.tsx', {
  ...shared,
  '../../messages/application/SearchChatMessages': {
    searchConversationMessages: input => { calls.push(input); return execute(input); },
  },
  './components/useSearchResultFavorites': { useSearchResultFavorites },
}).default;
let view;
const textOf = node => node.children.map(child => typeof child === 'string' ? child : textOf(child)).join('');
const button = text => view.root.findAllByType('TouchableOpacity').find(node => textOf(node) === text);
const stars = label => view.root.findAllByProps({ accessibilityLabel: label });
const change = async text => act(async () => { view.root.findByType('AppTextInput').props.onChangeText(text); });
const submit = async () => act(async () => { view.root.findByType('AppTextInput').props.onSubmitEditing(); });
await act(async () => { view = create(React.createElement(SearchScreen, { conversationId: 'direct', sourceName: '助手', assistantId: 'ai', onBack() {}, onOpenMessage: id => opened.push(id) })); });
await change('   ');
await submit();
assert.equal(calls.length, 0);
await change(' 蓝鲸 ');
await submit();
assert.deepEqual(calls.at(-1), { conversationId: 'direct', keywords: ['蓝鲸'], offset: 0 });
assert.deepEqual(refReads.at(-1), [2], '结果行出现后批量读取收藏身份，不逐行查询');
await act(async () => { view.root.findByProps({ accessibilityLabel: '查看助手的消息上下文' }).props.onPress(); });
assert.deepEqual(opened, [2]);
execute = async () => ({ entries: [record(1)], nextOffset: null });
await act(async () => { button('加载更多').props.onPress(); });
assert.equal(calls.at(-1).offset, 20);
assert.equal(view.root.findAllByProps({ accessibilityLabel: '查看助手的消息上下文' }).length, 2);
assert.deepEqual(refReads.at(-1), [1], '分页只读取新出现的行');

// 星号在消息行内直接收藏，不再经过长按菜单。
assert.equal(stars('取消收藏助手的这条消息').length, 0);
await act(async () => { stars('收藏助手的这条消息')[0].props.onPress(); });
assert.deepEqual(favoriteWrites.at(-1), { messageId: 2, sourceName: '助手', assistantId: 'ai' }, '收藏使用原消息身份，不保存搜索片段');
assert.equal(stars('收藏助手的这条消息').length, 1);
assert.equal(stars('取消收藏助手的这条消息').length, 1);
assert.equal(stars('取消收藏助手的这条消息')[0].props.accessibilityState.selected, true);
await act(async () => { stars('取消收藏助手的这条消息')[0].props.onPress(); });
assert.equal(saved.has(2), false);
assert.equal(stars('取消收藏助手的这条消息').length, 0);

// 写入期间同一行拒绝重复提交。
let finishCreate;
createFavorite = input => {
  favoriteWrites.push(input);
  return new Promise(resolve => { finishCreate = () => { const favorite = { id: `favorite-${input.messageId}` }; saved.set(input.messageId, favorite); resolve(favorite); }; });
};
const writesBefore = favoriteWrites.length;
await act(async () => { stars('收藏助手的这条消息')[0].props.onPress(); });
await act(async () => { stars('收藏助手的这条消息')[0].props.onPress(); });
assert.equal(favoriteWrites.length, writesBefore + 1, '状态未回填时不能重复收藏');
await act(async () => { finishCreate(); });
assert.equal(saved.has(2), true);

createFavorite = async () => { throw new Error('这条消息不能收藏'); };
await act(async () => { stars('收藏助手的这条消息')[0].props.onPress(); });
assert.equal(dialogs.at(-1).title, '收藏失败');
assert.ok(dialogs.at(-1).message.includes('这条消息不能收藏'));
createFavorite = createDefault;

execute = async () => ({ entries: [record(6, '不可收藏的消息', { canFavorite: false })], nextOffset: null });
await change('不可收藏');
await submit();
assert.equal(view.root.findAllByProps({ accessibilityLabel: '查看助手的消息上下文' }).length, 1);
assert.equal(stars('收藏助手的这条消息').length, 0, '不可收藏的消息不展示星号');

let resolveOld;
execute = () => new Promise(resolve => { resolveOld = resolve; });
await change('旧查询');
await submit();
await change('新查询');
execute = async () => ({ entries: [record(3, '新查询命中')], nextOffset: null });
await submit();
await act(async () => { resolveOld({ entries: [record(9, '旧查询不应出现')], nextOffset: null }); });
assert.ok(textOf(view.root).includes('新查询命中'));
assert.ok(!textOf(view.root).includes('旧查询不应出现'));

execute = async () => { throw new Error('数据库读取失败'); };
await change('失败');
await submit();
assert.ok(textOf(view.root).includes('数据库读取失败'));
assert.ok(!textOf(view.root).includes('没有找到相关聊天记录'));
execute = async () => ({ entries: [], nextOffset: null });
await act(async () => { button('重试').props.onPress(); });
assert.ok(textOf(view.root).includes('没有找到相关聊天记录'));
await act(async () => { view.root.findByProps({ accessibilityLabel: '清空关键词' }).props.onPress(); });
assert.equal(view.root.findByType('AppTextInput').props.value, '');
await act(async () => { view.unmount(); });

await act(async () => { view = create(React.createElement(SearchScreen, { conversationId: 'group', sourceName: '测试群', onBack() {}, onOpenMessage() {} })); });
const groupDialogs = dialogs.length;
execute = async () => ({ entries: [record(8)], nextOffset: null });
await change('蓝鲸');
await submit();
await act(async () => { stars('收藏助手的这条消息')[0].props.onPress(); });
assert.deepEqual(favoriteWrites.at(-1), { messageId: 8, sourceName: '测试群', assistantId: undefined }, '群聊收藏归属群聊，不冒用发言 AI 的单聊身份');
assert.equal(dialogs.length, groupDialogs);
await act(async () => { view.unmount(); });

const openedCalls = [];
await act(async () => { view = create(React.createElement(SearchScreen, {
  conversationId: 'direct', sourceName: '助手', assistantId: 'ai', onBack() {}, onOpenMessage() {},
  onOpenCall: id => openedCalls.push(id),
})); });
execute = async () => ({ entries: [{
  source: 'call', callId: 'history-call', entryId: 'history-entry', conversationId: 'direct',
  author: { role: 'user', name: '用户', assistantId: null }, text: '蓝鲸计划', createdAt: '2026-10-01T00:00:00Z',
}], nextOffset: null });
await change('蓝鲸');
await submit();
assert.ok(textOf(view.root).includes('通话内容'));
await act(async () => { view.root.findByProps({ accessibilityLabel: '查看通话记录' }).props.onPress(); });
assert.deepEqual(openedCalls, ['history-call']);
await act(async () => { view.unmount(); });

const contextCalls = [];
const sampleFile = { id: 'test-file', type: 'file', fileName: '记录.txt', mediaAssetId: 'file-asset' };
const ContextScreen = load('src/features/chat/presentation/messages/ChatMessageContextScreen.tsx', {
  ...shared,
  './MessageBubble/AttachmentCard': { __esModule: true, default: 'AttachmentCard' },
  './FilePreview': { __esModule: true, default: 'FilePreview' },
  '../../messages/application/ReadChatMessageContext': { readConversationMessageContext: async (id, input) => {
    contextCalls.push([id, input]);
    return { entries: [record(input.messageId - 1), record(input.messageId, '', { userAttachments: [sampleFile] }), record(input.messageId + 1)], hasMoreBefore: true, hasMoreAfter: true };
  } },
}).default;
await act(async () => { view = create(React.createElement(ContextScreen, { conversationId: 'group', messageId: 10, onBack() {} })); });
assert.deepEqual(contextCalls[0], ['group', { messageId: 10, before: 10, after: 10 }]);
assert.ok(textOf(view.root).includes('搜索结果'));
assert.equal(view.root.findByType('AttachmentCard').props.attachment, sampleFile);
await act(async () => { view.root.findByType('AttachmentCard').props.onPreview({ fileUri: 'file://sample', fileName: sampleFile.fileName }); });
assert.equal(view.root.findByType('FilePreview').props.fileName, sampleFile.fileName);
await act(async () => { view.root.findByType('FilePreview').props.onBack(); });
await act(async () => { button('查看更早的消息').props.onPress(); });
assert.deepEqual(contextCalls.at(-1), ['group', { messageId: 9, before: 20, after: 0 }]);
await act(async () => { button('回到搜索结果').props.onPress(); });
assert.equal(contextCalls.at(-1)[1].messageId, 10);
await act(async () => { button('查看更晚的消息').props.onPress(); });
assert.deepEqual(contextCalls.at(-1), ['group', { messageId: 11, before: 0, after: 20 }]);
await act(async () => { view.unmount(); });

let groupSearchOpened = false;
const GroupOptions = load('src/features/chat/presentation/group/GroupOptions.tsx', {
  ...shared,
  'react-native': { ...shared['react-native'], ScrollView: 'ScrollView', TextInput: 'TextInput' },
  '@shared/ui': { GroupAvatar: 'GroupAvatar', KeyboardAvoidingContainer: 'KeyboardAvoidingContainer', showAppDialog() {} },
  '@shared/ui/NavigationHeader': { __esModule: true, default: 'NavigationHeader' },
  'lucide-react-native': { Camera: 'Camera', ChevronRight: 'ChevronRight', Pencil: 'Pencil' },
  '@platform/device/DeviceMediaService': { PERSISTENT_IMAGE_CATEGORY: { groupAvatar: 'group' }, usePersistentAvatarDraft: () => ({ avatarUri: null }) },
  '../messages/components/ChatWallpaperSettings': { __esModule: true, default: 'ChatWallpaperSettings' },
  '../messages/components/LongPasteToggle': { LongPasteToggle: 'LongPasteToggle' },
  './GroupMembersSection': { __esModule: true, default: 'GroupMembersSection' },
}).default;
await act(async () => { view = create(React.createElement(GroupOptions, {
  groupId: 'group', groupDetails: { group: { name: '测试群' }, members: [] }, chatBackgroundKey: 'group:group',
  onSummary() {}, onSearchMessages() { groupSearchOpened = true; },
})); });
await act(async () => { button('搜索聊天记录').props.onPress(); });
assert.equal(groupSearchOpened, true, '群信息中的入口应发出搜索意图');
await act(async () => { view.unmount(); });

for (const kind of ['direct', 'group']) {
  const isGroup = kind === 'group', idKey = isGroup ? 'groupId' : 'aiId';
  const base = isGroup ? 'src/app/chat/groups/[groupId]' : 'src/app/chat/[aiId]';
  const Screen = isGroup ? 'GroupSearchRouteScreen' : 'ChatSearchRouteScreen';
  let params = { [idKey]: [kind] };
  const pushed = [];
  const dependencies = {
    '@features/chat': { [Screen]: Screen },
    'expo-router': { useLocalSearchParams: () => params, useRouter: () => ({ push: value => pushed.push(value) }), Redirect: 'Redirect' },
  };
  const Route = load(`${base}/search.tsx`, dependencies).default;
  await act(async () => { view = create(React.createElement(Route)); });
  await act(async () => { view.root.findByType(Screen).props.onOpenMessage(42); });
  assert.deepEqual(pushed[0].params, { [idKey]: kind, messageId: 42 });
  assert.ok(pushed[0].pathname.endsWith('/message-context'));
  if (!isGroup) {
    await act(async () => { view.root.findByType(Screen).props.onOpenCall('history-call'); });
    assert.deepEqual(pushed[1].params, { aiId: kind, callId: 'history-call' });
  }
  await act(async () => { view.unmount(); });
  const ContextRoute = load(`${base}/message-context.tsx`, dependencies).default;
  for (const messageId of ['0', '-1', 'abc', '1.5', undefined]) {
    params = { [idKey]: kind, messageId };
    await act(async () => { view = create(React.createElement(ContextRoute)); });
    assert.equal(view.root.findByType('Redirect').props.href, '/conversations');
    await act(async () => { view.unmount(); });
  }
  params = { [idKey]: kind, messageId: ['42'] };
  await act(async () => { view = create(React.createElement(ContextRoute)); });
  assert.equal(view.root.findByType(Screen).props.messageId, 42);
  await act(async () => { view.unmount(); });
}
console.log('用户聊天检索界面通过：输入、行内星号收藏、分页、过期结果隔离、失败重试、上下文翻页与单聊／群聊路由边界。');
