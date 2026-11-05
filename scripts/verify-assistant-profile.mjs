/** 个人主页真实展示、编辑、资料事件与路由离开行为。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(dependencies, name), `${file} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const editor = load('src/shared/ui/AutoSaveDraftEditor.ts');
const react = { ...React, default: React };
const native = { ActivityIndicator: 'ActivityIndicator', Image: 'Image', ImageBackground: 'ImageBackground', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
  TouchableOpacity: 'TouchableOpacity', StyleSheet: { create: styles => styles, absoluteFillObject: {} },
  Keyboard: { dismiss() {} }, AppState: { addEventListener: () => ({ remove() {} }) } };
const autoSave = load('src/shared/ui/useAutoSaveDraft.ts', {
  react, 'react-native': native, 'expo-router': {}, './AutoSaveDraftEditor': editor,
});
const draft = load('src/features/assistants/presentation/profile/assistantProfileDraft.ts');
assert.deepEqual(draft.parseAssistantProfileDraft({ nickname: '  老公  ' }, ['nickname']).patch, { nickname: '老公' });
assert.deepEqual(draft.parseAssistantProfileDraft({ nickname: '   ' }, ['nickname']).patch, { nickname: null });
assert.ok(draft.parseAssistantProfileDraft({ nickname: 'a\nb' }, ['nickname']).errors.nickname);
assert.ok(draft.parseAssistantProfileDraft({ nickname: '长'.repeat(21) }, ['nickname']).errors.nickname);
assert.deepEqual(draft.parseAssistantProfileDraft({ nickname: '🐈'.repeat(20) }, ['nickname']).patch, { nickname: '🐈'.repeat(20) });
const listeners = new Set();
let profile = { id: 'ai', agentId: 'agent-ai', name: '公开名称', nickname: '我的昵称', avatar: null, profileCoverMediaAssetId: null, systemPrompt: '原始人设\n保留排版' };
const writes = [];
let failSave = false;
let failRead = false;
let resolveRead;
const commands = {
  getAIAssistantById: async () => {
    if (failRead) throw new Error('读取失败');
    return resolveRead ? new Promise(resolve => { resolveRead = resolve; }) : profile;
  },
  subscribeAIAssistantUpdated: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  updateAIAssistantSettings: async (id, patch) => {
    assert.equal(id, 'ai');
    if (failSave) throw new Error('写入失败');
    writes.push(patch);
    profile = { ...profile, ...patch };
    for (const listener of listeners) listener(profile);
    return true;
  },
};
const { default: useProfile } = load('src/features/assistants/presentation/profile/useAssistantProfile.ts', {
  react, '@shared/ui': {}, '@shared/ui/useAutoSaveDraft': autoSave, './assistantProfileDraft': draft,
  '../../AIAssistantManagement': commands,
  '@platform/device/DeviceMediaService': { PERSISTENT_IMAGE_CATEGORY: { aiAvatar: 'avatar' },
    usePersistentAvatarDraft: ({ committedUri }) => ({ avatarUri: committedUri, isPickingAvatar: false, isCommittingAvatar: false }) },
});
const { useAIAssistantProfile } = load('src/features/assistants/presentation/profile/useAIAssistantProfile.ts', {
  react, '../../AIAssistantManagement': commands,
});
const sharedUI = Object.fromEntries(['AIAvatar', 'AIInfoCard', 'Button', 'EmptyState', 'InputField', 'KeyboardAvoidingContainer'].map(name => [name, name]));
const theme = { colors: { brand: { primary: '#123', onPrimary: '#fff' }, text: { secondary: '#666', tertiary: '#999' },
  icon: { primary: '#123', secondary: '#999' }, background: { app: '#fff', screen: '#fff' }, surface: { default: '#fff' } },
  effects: { glass: { enabled: false } }, spacing: { sm: 4, lg: 16 }, radius: { sm: 4 }, shadow: { md: {} } };
const commonDependencies = {
  react, 'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': { ThemedSurface: 'ThemedSurface', useThemedStyles: () => ({}), useTheme: () => theme },
  '@shared/avatar/avatarConstants': { AVATAR_SHAPE: { circle: 'circle' } },
  '@features/media': { MediaAssetImage: 'MediaAssetImage' },
  '../../../../../assets/stars.jpg': 7,
  '@shared/ui': sharedUI,
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader' },
  './AssistantProfile.styles': { createAssistantProfileStyles: () => ({}) },
};
const { default: Page } = load('src/features/assistants/presentation/profile/AssistantProfilePage.tsx', {
  ...commonDependencies, './useAIAssistantProfile': { useAIAssistantProfile },
});
const { default: SpaceCover } = load('src/features/assistants/presentation/profile/AssistantSpaceCover.tsx', commonDependencies);
const { default: Screen } = load('src/features/assistants/presentation/profile/AssistantProfileScreen.tsx', {
  ...commonDependencies, './AssistantProfilePage': { default: Page },
  './AssistantSettingsEntries': { default: 'AssistantSettingsEntries' },
  './AssistantSpaceCover': { default: SpaceCover },
  'lucide-react-native': { ChevronRight: 'ChevronRight', Images: 'Images', SquarePen: 'SquarePen' },
});
const { default: EditScreen } = load('src/features/assistants/presentation/profile/AssistantProfileEditScreen.tsx', {
  ...commonDependencies, './AssistantProfilePage': { default: Page },
  '@shared/ui/AutoSaveErrors': { AutoSaveErrors: 'AutoSaveErrors' },
  './useAssistantProfile': { default: useProfile },
});

let params = { aiId: 'ai' };
let removal;
const dispatched = [];
const pushed = [];
const dismissed = [];
let backCount = 0;
const router = { back: () => backCount++, push: target => pushed.push(target), dismissTo: target => dismissed.push(target) };
const expo = { useLocalSearchParams: () => params, useNavigation: () => ({ dispatch: action => dispatched.push(action) }),
  useRouter: () => router, Redirect: 'Redirect', useFocusEffect() {} };
const { default: Route } = load('src/app/assistants/[aiId].tsx', {
  react, 'expo-router': expo, '@features/assistants': { AssistantProfileScreen: Screen },
  '@react-navigation/native': { usePreventRemove: (enabled, callback) => { removal = { enabled, callback }; } },
});
const { default: EditRoute } = load('src/app/assistants/[aiId]/edit.tsx', {
  react, 'expo-router': expo, '@features/assistants': { AssistantProfileEditScreen: EditScreen },
  '@react-navigation/native': { usePreventRemove: (enabled, callback) => { removal = { enabled, callback }; } },
});

let renderer;
const fields = () => renderer.root.findAllByType('InputField');
const field = label => fields().find(item => item.props.label === label);
const rerender = async () => { await act(async () => { renderer.update(React.createElement(Route)); }); };
const enterEdit = async () => {
  await act(async () => { renderer.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === '编辑资料').props.onPress(); });
  assert.equal(pushed.at(-1), '/assistants/ai/edit', '编辑跳转独立页面');
  await act(async () => { renderer.update(React.createElement(EditRoute)); });
};
const readText = node => typeof node === 'string' ? node : node.children?.map(readText).join('') ?? '';
try {
  await act(async () => { renderer = create(React.createElement(Route)); });
  assert.equal(fields().length, 0, '默认主页只读，不挂载编辑输入');
  assert.equal(renderer.root.findByType('AIAvatar').props.onPress, undefined);
  assert.equal(writes.length, 0, '只读访问不写入资料');
  assert.equal(renderer.root.findByType('Image').props.source, 7, '未设置封面时显示打包的星空图片');
  await act(async () => { profile = { ...profile, profileCoverMediaAssetId: 'own-cover' }; for (const listener of listeners) listener(profile); });
  assert.equal(renderer.root.findByType('MediaAssetImage').props.mediaAssetId, 'own-cover', '工具提交事实刷新已挂载的主页封面');
  assert.equal(renderer.root.findAllByType('Image').length, 0);
  assert.ok(renderer.root.findAllByType('Text').some(node => readText(node) === '公开名称（我的昵称）'));
  await act(async () => { renderer.root.findAllByType('Button').find(node => node.props.title === '发消息').props.onPress(); });
  assert.equal(dismissed.at(-1), '/chat/ai', '发消息回到当前 AI 的聊天页');
  await act(async () => { renderer.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === '查看 AI 的朋友圈').props.onPress(); });
  assert.equal(pushed.at(-1), '/assistants/ai/moments', '朋友圈打开当前 AI');
  await act(async () => { renderer.root.findByType('AssistantSettingsEntries').props.onOpenModelSettings(); });
  assert.equal(pushed.at(-1), '/assistants/ai/model-settings');
  await act(async () => { renderer.root.findByType('AssistantSettingsEntries').props.onOpenContextSettings(); });
  assert.equal(pushed.at(-1), '/assistants/ai/context-settings');
  await act(async () => { renderer.root.findByType('AssistantSettingsEntries').props.onOpenSummary(); });
  assert.equal(pushed.at(-1), '/chat/ai/summary');
  assert.equal(renderer.root.findByType('NavigationHeader').props.title, '公开名称的主页');
  assert.equal(renderer.root.findByType('NavigationHeader').props.rightButton, undefined);
  const originalPrompt = profile.systemPrompt;
  await act(async () => { profile = { ...profile, systemPrompt: '🐈'.repeat(301) }; for (const listener of listeners) listener(profile); });
  const personaPreview = renderer.root.findAllByType('Text').find(node => readText(node) === '🐈'.repeat(301));
  assert.equal(personaPreview?.props.numberOfLines, 2, '人设保留完整 Unicode 内容，并由两行布局省略');
  await act(async () => { profile = { ...profile, systemPrompt: originalPrompt }; for (const listener of listeners) listener(profile); });
  await enterEdit();
  assert.deepEqual(fields().map(item => item.props.label), ['AI 名称', '专属昵称', 'AI 人设']);
  assert.equal(typeof renderer.root.findByType('AIInfoCard').props.onAvatarPress, 'function');
  await act(async () => { field('AI 人设').props.onChangeText('新的人设\n排版不变'); });
  assert.equal(writes.length, 0, '输入等待失焦或返回');
  assert.equal(removal.enabled, true, '编辑草稿使系统返回进入保存边界');
  assert.equal(renderer.root.findByType('NavigationHeader').props.rightButton, undefined, '编辑页只保留返回，不提供完成按钮');
  await act(async () => { field('AI 人设').props.onBlur(); });
  assert.deepEqual(writes, [{ systemPrompt: '新的人设\n排版不变' }]);
  await act(async () => { renderer.root.findByType('NavigationHeader').props.onGoBack(); });
  assert.equal(backCount, 1, '返回箭头离开编辑页');
  await act(async () => { removal.callback({ data: { action: { type: 'POP' } } }); });
  assert.deepEqual(dispatched, [{ type: 'POP' }], '返回边界保存后重放导航动作');
  await rerender();
  assert.equal(fields().length, 0);
  assert.ok(renderer.root.findAllByType('Text').some(item => readText(item) === profile.systemPrompt));

  await enterEdit();
  await act(async () => { field('AI 名称').props.onChangeText(''); });
  await act(async () => { removal.callback({ data: { action: { type: 'POP' } } }); });
  assert.equal(dispatched.length, 1, '无效名称阻止退出编辑并保留草稿');
  assert.ok(field('AI 名称').props.error);
  await act(async () => { field('AI 名称').props.onChangeText('新名称'); });
  failSave = true;
  await act(async () => { removal.callback({ data: { action: { type: 'POP' } } }); });
  assert.equal(dispatched.length, 1, '系统返回保存失败时留在原页');
  assert.equal(field('AI 名称').props.value, '新名称');
  assert.ok(renderer.root.findAllByType('AutoSaveErrors').some(item => item.props.error));
  failSave = false;
  await act(async () => { removal.callback({ data: { action: { type: 'POP' } } }); });
  assert.deepEqual(dispatched.at(-1), { type: 'POP' }, '保存后重放原生导航动作');
  assert.equal(profile.name, '新名称');
  await act(async () => { renderer.unmount(); });
  assert.equal(listeners.size, 0);

  // 读取开始后的资料事件胜过较早的查询快照。
  resolveRead = true;
  await act(async () => { renderer = create(React.createElement(Route)); });
  const old = { ...profile, name: '旧快照' };
  await act(async () => {
    profile = { ...profile, name: '事件中的新名称' };
    for (const listener of listeners) listener(profile);
    resolveRead(old);
  });
  assert.ok(renderer.root.findAllByType('Text').some(item => readText(item) === '事件中的新名称（我的昵称）'));
  await act(async () => { renderer.unmount(); });
  resolveRead = null;
  failRead = true;
  await act(async () => { renderer = create(React.createElement(Route)); });
  assert.equal(renderer.root.findByType('Button').props.title, '重试');
  failRead = false;
  await act(async () => { renderer.root.findByType('Button').props.onPress(); });
  assert.equal(fields().length, 0);
  params = { aiId: ['ai'] }; await rerender();
  assert.equal(renderer.root.findByType('NavigationHeader').props.title, `${profile.name}的主页`);
  params = {}; await rerender();
  assert.equal(renderer.root.findByType('Redirect').props.href, '/conversations');
  profile = null;
  params = { aiId: 'deleted' }; await rerender();
  assert.equal(renderer.root.findByType('EmptyState').props.title, '找不到这个 AI');
  assert.equal(fields().length, 0, '无效助手不能进入资料编辑');
} finally { if (renderer) await act(async () => { renderer.unmount(); }); }

const { default: MomentsHeader } = load('src/features/moments/presentation/MomentsHeader.tsx', {
  ...commonDependencies, '@features/assistants': { AssistantSpaceCover: SpaceCover },
  '@expo/vector-icons': { Ionicons: 'Icon' }, './MomentsCoverPreviewModal': { default: 'CoverPreview' },
  './useMomentsCover': { useMomentsCover: () => { throw new Error('AI 朋友圈不能读取用户封面'); } },
});
const { default: MomentsScreen } = load('src/features/moments/presentation/AssistantMomentsScreen.tsx', {
  ...commonDependencies, './MomentsTab': { default: props => React.createElement('MomentsTab', props,
    React.createElement(MomentsHeader, { assistant: props.assistant, onBack: props.onBack })) },
  '@features/assistants': { useAIAssistantProfile, getAssistantDisplayName: value => value.nickname || value.name },
});
const { default: MomentsRoute } = load('src/app/assistants/[aiId]/moments.tsx', {
  react, 'expo-router': expo, '@features/moments': { AssistantMomentsScreen: MomentsScreen },
  '@host': { useRetainedRouteRefreshRevision: () => 2 },
});
profile = { id: 'ai', agentId: 'stable-agent', name: '名称', nickname: '昵称', avatar: 'file:///ai.jpg', profileCoverMediaAssetId: null };
params = { aiId: 'ai' };
await act(async () => { renderer = create(React.createElement(MomentsRoute)); });
assert.deepEqual(renderer.root.findByType('MomentsTab').props.assistant, {
  agentId: 'stable-agent', name: '昵称', avatar: 'file:///ai.jpg', profileCoverMediaAssetId: null,
}, 'AI 朋友圈按稳定 actor 身份查询，头像使用该 AI 的资料');
assert.equal(renderer.root.findByType('MomentsTab').props.refreshRevision, 2);
await act(async () => {
  profile = { ...profile, avatar: 'file:///new-ai.jpg' };
  for (const listener of listeners) listener(profile);
});
assert.equal(renderer.root.findByType('MomentsTab').props.assistant.avatar, 'file:///new-ai.jpg');
// 两处页面挂载后，同一资料提交事实同时切换它们的封面，默认资源也保持一致。
await act(async () => { renderer.update(React.createElement(React.Fragment, null,
  React.createElement(Route), React.createElement(MomentsRoute))); });
assert.deepEqual(renderer.root.findAllByType('Image').map(node => node.props.source), [7, 7]);
await act(async () => {
  profile = { ...profile, profileCoverMediaAssetId: 'shared-space-cover' };
  for (const listener of listeners) listener(profile);
});
assert.deepEqual(renderer.root.findAllByType('MediaAssetImage').map(node => node.props.mediaAssetId), ['shared-space-cover', 'shared-space-cover']);
assert.equal(renderer.root.findAllByType('Image').length, 0);
assert.equal(renderer.root.findAllByType('CoverPreview').length, 0);
await act(async () => { renderer.unmount(); });
assert.equal(listeners.size, 0);

const { default: ConversationRoute } = load('src/app/chat/[aiId]/index.tsx', {
  react, 'expo-router': expo, '@features/chat': { ChatConversationRouteScreen: 'ChatConversationRouteScreen' },
});
params = { aiId: 'primary' };
await act(async () => { renderer = create(React.createElement(ConversationRoute)); });
renderer.root.findByType('ChatConversationRouteScreen').props.onOpenAssistantProfile('helper/ai');
assert.equal(pushed.at(-1), '/assistants/helper%2Fai', '消息传来的实际 AI 身份由 App 转成路由');
await act(async () => { renderer.unmount(); });

const { default: MenuRoute } = load('src/app/chat/[aiId]/menu.tsx', {
  'expo-router': expo, '@features/chat': { ChatMenuRouteScreen: 'ChatMenuRouteScreen' },
});
await act(async () => { renderer = create(React.createElement(MenuRoute)); });
renderer.root.findByType('ChatMenuRouteScreen').props.onOpenAssistantProfile();
assert.equal(pushed.at(-1), '/assistants/primary', '更多提供当前 AI 的主页入口');
renderer.root.findByType('ChatMenuRouteScreen').props.onOpenModelSettings();
assert.equal(pushed.at(-1), '/assistants/primary/model-settings', '旧快捷入口直接进入正式设置地址');
renderer.root.findByType('ChatMenuRouteScreen').props.onOpenConversationSettings();
assert.equal(pushed.at(-1), '/assistants/primary/chat-settings');
renderer.root.findByType('ChatMenuRouteScreen').props.onOpenSummary();
assert.equal(pushed.at(-1), '/chat/primary/summary', '更多与主页使用相同摘要地址');
await act(async () => { renderer.unmount(); });

const { Avatar } = load('src/features/chat/presentation/messages/MessageBubble/Avatar.tsx', {
  react, 'react-native': native, '@shared/ui/AvatarImage': { default: 'AvatarImage' },
  '@shared/avatar/avatarConstants': { AVATAR_SHAPE: { square: 'square' } },
  '@shared/avatar/resolveAvatarSource': { resolveAIAvatarSource: () => ({}), resolveUserAvatarSource: () => ({}) },
  '@shared/theme': { useThemedStyles: () => ({}) }, './styles': { createMessageBubbleStyles: () => ({}) },
});
let avatarClicks = 0;
await act(async () => { renderer = create(React.createElement(Avatar, { isUser: false, aiName: 'AI', onPress: () => avatarClicks++ })); });
renderer.root.findByType('Pressable').props.onPress();
assert.equal(avatarClicks, 1);
await act(async () => { renderer.update(React.createElement(Avatar, { isUser: true, userName: '用户' })); });
assert.equal(renderer.root.findAllByType('Pressable').length, 0, '用户头像保持纯展示');
await act(async () => { renderer.unmount(); });

const { default: GroupRoute } = load('src/app/chat/groups/[groupId].tsx', {
  react, 'expo-router': expo, '@features/chat': { GroupConversationRouteScreen: 'GroupConversationRouteScreen' },
});
params = { groupId: 'group-a' };
await act(async () => { renderer = create(React.createElement(GroupRoute)); });
for (const assistantId of ['member-a', 'member/b']) {
  renderer.root.findByType('GroupConversationRouteScreen').props.onOpenAssistantProfile(assistantId);
  assert.equal(pushed.at(-1), `/assistants/${encodeURIComponent(assistantId)}`, '群聊按所点成员进入主页');
}
await act(async () => { renderer.unmount(); });

const navigation = load('src/features/moments/presentation/MomentNavigation.tsx', { react });
const { default: MomentBoundary } = load('src/host/navigation/MomentSharingBoundary.tsx', {
  react, 'expo-router': expo,
  '@features/moments': navigation,
  '@features/chat': {
    ChatShareNavigationProvider: ({ children }) => children,
    ChatContentShareSheet: () => null,
    useChatContentShare: () => ({ open: async () => {} }),
  },
});
const { default: MomentItem } = load('src/features/moments/presentation/MomentItem.tsx', {
  ...commonDependencies,
  'react-native': { ...native, TouchableOpacity: 'TouchableOpacity' },
  'lucide-react-native': { MapPin: 'MapPin', Share2: 'Share2' },
  './MomentNavigation': navigation,
  '@features/profile': { SELF_USER_PROFILE_ID: 'self' },
  '@features/media': { MediaAssetImage: 'MediaAssetImage' },
  './momentItem/formatters': { formatTime: value => value, getLikesText: () => '' },
  './momentItem/icons': { Avatar: 'Avatar', CommentIcon: 'CommentIcon', HeartIcon: 'HeartIcon', MoreIcon: 'MoreIcon' },
  './momentItem/modals': { AIManagerModal: () => null, CommentInputModal: () => null, MoreMenuModal: () => null },
  './momentItem/styles': { createMomentItemStyles: () => ({}) },
  './momentItem/permissions': load('src/features/moments/presentation/momentItem/permissions.ts'),
  './momentActionFeedback': {}, './MomentAudienceDraft': { describeMomentVisibility: () => null },
  './MomentMediaViewerModal': { default: () => null },
});
const moment = { id: 'moment-a', actorType: 'ai', actorId: 'agent-a', assistantId: 'ai/a',
  userName: '同名 AI', avatar: null, content: '时刻正文', createdAt: null, audienceMode: 'all', media: [], comments: [], likes: [] };
const renderMoment = item => React.createElement(MomentBoundary, null, React.createElement(MomentItem, { item }));
await act(async () => { renderer = create(renderMoment(moment)); });
const avatarButton = () => renderer.root.findByType('Avatar').parent;
assert.equal(avatarButton().type, 'TouchableOpacity');
avatarButton().props.onPress();
assert.equal(pushed.at(-1), '/assistants/ai%2Fa', '朋友圈头像通过 Host 进入对应主页');
const authorName = renderer.root.findAllByType('Text').find(node => readText(node) === '同名 AI');
assert.equal(authorName.props.onPress, undefined);
assert.equal(authorName.parent.type, 'View', '名称不在头像点击区域中');
renderer.root.findAllByType('Text').find(node => readText(node) === '时刻正文').parent.props.onPress();
assert.equal(pushed.at(-1), '/moments/moment-a', '正文仍打开原帖');
await act(async () => { renderer.update(renderMoment({ ...moment, actorId: 'agent-b', assistantId: 'ai-b' })); });
avatarButton().props.onPress();
assert.equal(pushed.at(-1), '/assistants/ai-b', '同名 AI 按身份分别打开主页');
for (const item of [{ ...moment, assistantId: null }, { ...moment, actorType: 'user', actorId: 'self', assistantId: null }]) {
  await act(async () => { renderer.update(renderMoment(item)); });
  assert.equal(avatarButton().type, 'View', '已删除 AI 与用户头像没有主页入口');
}
await act(async () => { renderer.unmount(); });
console.log('AI 个人主页：展示、编辑、资料同步、系统返回、单聊／群聊及朋友圈头像路由验证通过。');
