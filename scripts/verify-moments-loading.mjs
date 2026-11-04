/** 真实 React 生命周期验证：图片暂存态、刷新复用、封面更新与旧请求隔离。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(import.meta.dirname, '..');
function load(relative, mocks) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(mocks, name), `缺少依赖：${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const pending = new Map();
const reads = [];
const MediaImage = load('src/features/media/presentation/MediaAssetImage.tsx', {
  react: React,
  'react-native': {
    ActivityIndicator: 'Spinner', Image: 'Image', Text: 'Text', View: 'View',
    StyleSheet: { create: (styles) => styles, absoluteFillObject: {} },
  },
  '@shared/theme': { useTheme: () => ({ colors: { brand: { primary: '#123' }, text: { secondary: '#456' } } }) },
  '../application/MediaAssetRuntime': { resolveMediaAsset: (id) => {
    reads.push(id);
    const request = deferred();
    pending.set(id, request);
    return request.promise;
  } },
}).default;
const renderImage = (id) => React.createElement(MediaImage, { mediaAssetId: id, style: {}, resizeMode: 'cover' });
let renderer;
await act(async () => { renderer = create(renderImage('first')); });
assert.equal(renderer.root.findAllByType('Spinner').length, 1, '文件解析期间有占位');
await act(async () => { pending.get('first').resolve({ localUri: 'file:///first.jpg' }); });
assert.equal(renderer.root.findByType('Image').props.source.uri, 'file:///first.jpg');
assert.equal(renderer.root.findAllByType('Spinner').length, 1, '文件解析完成仍等待原生图片解码');
await act(async () => { renderer.root.findByType('Image').props.onLoad(); });
assert.equal(renderer.root.findAllByType('Spinner').length, 0);
await act(async () => { renderer.update(renderImage('first')); });
assert.deepEqual(reads, ['first'], '刷新其他事实不能重新解析同一图片');

await act(async () => { renderer.update(renderImage('old')); });
await act(async () => { renderer.update(renderImage('new')); });
await act(async () => { pending.get('old').resolve({ localUri: 'file:///old.jpg' }); });
assert.equal(renderer.root.findAllByType('Image').length, 0, '旧请求返回不能覆盖新资产');
assert.equal(renderer.root.findAllByType('Spinner').length, 1);
await act(async () => { pending.get('new').resolve({ localUri: 'file:///new.jpg' }); });
await act(async () => { renderer.root.findByType('Image').props.onError(); });
assert.equal(renderer.root.findAllByType('Spinner').length, 0, '原生解码失败结束暂存态');
assert.equal(renderer.root.findByType('Text').children.join(''), '图片不可用');
assert.equal(renderer.root.findAllByType('Image').length, 0);
await act(async () => { renderer.unmount(); });

// 资源缺失在展示边界终结，不能让加载指示器永久转动。
await act(async () => { renderer = create(renderImage('missing')); });
const warn = console.warn;
try {
  console.warn = () => {};
  await act(async () => { pending.get('missing').reject(new Error('backing missing')); });
} finally { console.warn = warn; }
assert.equal(renderer.root.findAllByType('Spinner').length, 0);
assert.equal(renderer.root.findByType('Text').children.join(''), '图片不可用');
await act(async () => { renderer.unmount(); });

// 首次读取之前已经处于加载态，焦点刷新保留旧列表。
let pageRequest = deferred();
const pageOptions = [];
const interactionCalls = [];
const useMoments = load('src/features/moments/presentation/useMoments.ts', {
  react: React,
  '@features/profile': { SELF_USER_PROFILE_ID: 'self' },
  '../presentationFacade': {
    getCurrentMomentUserProfile: async () => ({ id: 'self', name: '用户' }),
    listMomentRecords: (_profile, options) => { pageOptions.push(options); return pageRequest.promise; },
    createUserMomentLike: async momentId => { interactionCalls.push(momentId); },
  },
  '../application/MomentMediaAnalysis': { subscribeMomentMediaAnalysisUpdated: () => () => {} },
}).default;
let state;
function Probe({ agentId }) { state = useMoments(agentId); return null; }
await act(async () => { renderer = create(React.createElement(Probe)); });
assert.equal(state.initialLoading, true, '首次渲染不闪出空列表');
let loading;
await act(async () => { loading = state.loadMoments(); });
const firstPage = [{ id: 'moment-1', createdAt: '2026-10-07', media: [] }];
await act(async () => { pageRequest.resolve(firstPage); await loading; });
assert.equal(state.initialLoading, false);
assert.deepEqual(state.moments, firstPage);
pageRequest = deferred();
await act(async () => { loading = state.reloadLoadedMoments(); });
assert.equal(state.refreshing, true);
assert.equal(state.initialLoading, false);
assert.deepEqual(state.moments, firstPage, '刷新等待期间保留已有内容');
await act(async () => { pageRequest.resolve(firstPage); await loading; });
await act(async () => { renderer.unmount(); });

// 指定作者的首次读取、续页和互动后刷新始终使用同一个稳定 actor key。
pageRequest = deferred();
await act(async () => { renderer = create(React.createElement(Probe, { agentId: 'stable-agent' })); });
await act(async () => { loading = state.loadMoments(); });
const authoredPage = Array.from({ length: 6 }, (_, index) => ({ id: `ai-${index}`, createdAt: '2026-10-07', media: [] }));
await act(async () => { pageRequest.resolve(authoredPage); await loading; });
assert.deepEqual(pageOptions.at(-1).author, { actorType: 'ai', actorId: 'stable-agent' });
pageRequest = deferred();
await act(async () => { loading = state.loadMoreMoments(); });
assert.deepEqual(pageOptions.at(-1).cursor, { createdAt: '2026-10-07', id: 'ai-4' });
assert.deepEqual(pageOptions.at(-1).author, { actorType: 'ai', actorId: 'stable-agent' });
await act(async () => { pageRequest.resolve([]); await loading; });
pageRequest = deferred();
await act(async () => { loading = state.addLike('ai-0'); });
await act(async () => { pageRequest.resolve(authoredPage); await loading; });
assert.deepEqual(interactionCalls, ['ai-0'], 'AI 朋友圈的互动仍调用用户点赞命令');
assert.deepEqual(pageOptions.at(-1).author, { actorType: 'ai', actorId: 'stable-agent' });
await act(async () => { renderer.unmount(); });

// 保活页面刷新动态或导航回调时，已显示的封面不能退回默认图或重新读取。
const profileListeners = new Set();
const initialCoverRead = deferred();
let profileReads = 0;
const coverController = load('src/features/moments/presentation/useMomentsCover.ts', {
  react: React,
  '@shared/ui': {},
  'react-native': {},
  'expo-image-picker': {},
  '@platform/device/DeviceMediaService': {},
  '../../../../assets/ravenphone_bg.png': 'default-cover',
  '@features/profile': {
    DEFAULT_USER_PROFILE: { name: '用户', avatar: null, momentsCover: null, momentsCoverMediaAssetId: null },
    getCurrentUserProfile: () => { profileReads++; return initialCoverRead.promise; },
    subscribeUserProfileUpdated: listener => {
      profileListeners.add(listener);
      return () => { profileListeners.delete(listener); };
    },
  },
});
const theme = {
  colors: {
    background: { app: '#fff', screen: '#fff' }, surface: { default: '#fff' },
    text: { secondary: '#666', tertiary: '#999' }, brand: { primary: '#123', onPrimary: '#fff' },
    icon: { primary: '#123' },
  },
  effects: { glass: { enabled: false } }, spacing: { sm: 4, lg: 16, xl: 24 },
  radius: { sm: 4 }, shadow: { md: {} },
};
const nativeUI = {
  ActivityIndicator: 'Spinner', ImageBackground: 'CoverImage', Text: 'Text',
  TouchableOpacity: 'Button', View: 'View', StyleSheet: { create: styles => styles },
};
const { default: SpaceCover } = load('src/features/assistants/presentation/profile/AssistantSpaceCover.tsx', {
  react: React, 'react-native': { ...nativeUI, Image: 'SpaceDefaultImage' },
  '@features/media': { MediaAssetImage: 'SpaceMediaImage' }, '../../../../../assets/stars.jpg': 'default-stars',
});
const Header = load('src/features/moments/presentation/MomentsHeader.tsx', {
  react: React, 'react-native': nativeUI,
  '@expo/vector-icons': { Ionicons: 'Icon' }, '@shared/ui': { UserAvatar: 'Avatar', AIAvatar: 'AIAvatar' },
  '@shared/ui/NavigationHeader': 'NavigationHeader',
  '@shared/theme': { useTheme: () => theme },
  './MomentsCoverPreviewModal': 'CoverPreview',
  './useMomentsCover': coverController,
  '@features/assistants': { AssistantSpaceCover: SpaceCover },
}).default;
// 复用 FlatList 的公开契约：元素直接渲染，组件类型通过 React 创建实例。
function FlatList({ ListHeaderComponent, ListEmptyComponent, data }) {
  const header = React.isValidElement(ListHeaderComponent)
    ? ListHeaderComponent
    : React.createElement(ListHeaderComponent);
  return React.createElement(React.Fragment, null, header, data.length === 0 ? ListEmptyComponent : null);
}
const noop = () => {};
let timelineReloads = 0;
const timeline = {
  moments: [{ id: 'moment-1' }], initialLoading: false, refreshing: false,
  loadingMore: false, hasMoreMoments: false, currentUserId: 'self',
  loadMoments: noop, loadMoreMoments: noop, reloadLoadedMoments: () => { timelineReloads++; },
};
const Tab = load('src/features/moments/presentation/MomentsTab.tsx', {
  react: React, 'react-native': { ...nativeUI, FlatList },
  '@shared/ui': {}, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  '@shared/theme': { useTheme: () => theme }, './useMoments': () => timeline,
  './MomentItem': 'MomentItem', './MomentsHeader': Header,
  './momentActionFeedback': {},
}).default;
const renderTab = revision => React.createElement(Tab, {
  refreshRevision: revision, onPublishPress: () => {}, onSettingsPress: () => {},
});
await act(async () => { renderer = create(renderTab(0)); });
assert.equal(renderer.root.findByType('CoverImage').props.source, 'default-cover');
await act(async () => {
  initialCoverRead.resolve({ name: '用户', avatar: null, momentsCover: 'file:///cover.jpg', momentsCoverMediaAssetId: 'cover' });
});
const loadedCoverSource = renderer.root.findByType('CoverImage').props.source;
assert.deepEqual(loadedCoverSource, { uri: 'file:///cover.jpg' });
await act(async () => { renderer.update(renderTab(1)); });
await act(async () => { renderer.update(renderTab(2)); });
assert.equal(timelineReloads, 2, '切回页面仍刷新动态');
assert.equal(profileReads, 1, '切回页面不能重新读取封面资料');
assert.deepEqual(renderer.root.findByType('CoverImage').props.source, loadedCoverSource, '切回页面保留已显示的图片来源');
await act(async () => { renderer.update(renderTab(2)); });
assert.equal(profileReads, 1, '导航回调变化不能重挂载封面');
await act(async () => {
  for (const listener of profileListeners) listener({ name: '新名称', avatar: null, momentsCover: 'file:///new-cover.jpg', momentsCoverMediaAssetId: 'new-cover' });
});
assert.deepEqual(renderer.root.findByType('CoverImage').props.source, { uri: 'file:///new-cover.jpg' }, '已提交的新封面即时显示');
assert.equal(renderer.root.findByType('Avatar').props.name, '新名称');
await act(async () => {
  for (const listener of profileListeners) listener({ name: '新名称', avatar: null, momentsCover: null, momentsCoverMediaAssetId: null });
});
assert.equal(renderer.root.findByType('CoverImage').props.source, 'default-cover', '恢复默认封面即时同步');
await act(async () => { renderer.unmount(); });
assert.equal(profileListeners.size, 0, '封面卸载后解除资料订阅');
// AI 页面复用列表和封面布局，不读取用户封面，也不提供代替 AI 发布的入口。
const readsBeforeAI = profileReads;
await act(async () => { renderer = create(React.createElement(Tab, {
  refreshRevision: 0, onBack: noop,
  assistant: { agentId: 'agent-ai', name: 'AI 名称', avatar: 'file:///ai.jpg', profileCoverMediaAssetId: null },
})); });
assert.equal(profileReads, readsBeforeAI, 'AI 封面不挂载用户资料控制器');
assert.equal(profileListeners.size, 0);
assert.equal(renderer.root.findByType('SpaceDefaultImage').props.source, 'default-stars', 'AI 默认空间封面与用户封面独立');
assert.equal(renderer.root.findByType('AIAvatar').props.avatarUrl, 'file:///ai.jpg');
assert.equal(renderer.root.findAllByType('Avatar').length, 0);
assert.equal(renderer.root.findByType('NavigationHeader').props.title, '朋友圈');
assert.equal(renderer.root.findByType('NavigationHeader').props.onGoBack, noop);
assert.equal(renderer.root.findAllByType('CoverPreview').length, 0, 'AI 空间封面没有用户封面编辑入口');
assert.equal(renderer.root.findAllByType('Button').length, 0, 'AI 朋友圈不提供发布和设置按钮');
timeline.moments = [];
await act(async () => { renderer.update(React.createElement(Tab, {
  refreshRevision: 0, onBack: noop,
  assistant: { agentId: 'agent-ai', name: 'AI 名称', avatar: 'file:///ai.jpg', profileCoverMediaAssetId: 'ai-space-cover' },
})); });
assert.ok(renderer.root.findAllByType('Text').some(node => node.children.join('') === 'TA 还没有发布朋友圈'));
assert.equal(typeof renderer.root.findByType(FlatList).props.onRefresh, 'function', '空列表仍可下拉刷新');
assert.equal(renderer.root.findAllByType('Button').length, 0, '空列表不提供替 AI 发布的按钮');
assert.equal(renderer.root.findByType('SpaceMediaImage').props.mediaAssetId, 'ai-space-cover', '朋友圈显示助手资料中的空间封面');
assert.equal(renderer.root.findAllByType('SpaceDefaultImage').length, 0);
assert.equal(profileReads, readsBeforeAI, 'AI 封面变更仍不读取用户封面');
await act(async () => { renderer.unmount(); });

// 列表与详情共用的帖子条目按作者身份显示默认头像，不按姓名或当前用户猜身份。
const avatarTheme = load('src/shared/theme/themes/defaultLight.ts', {}).defaultLightTheme;
const avatarThemeApi = { useTheme: () => avatarTheme, useThemedStyles: factory => factory(avatarTheme), ThemedSurface: 'Surface' };
const avatarNative = { ...nativeUI, Image: 'Image' };
const avatarConstants = load('src/shared/avatar/avatarConstants.ts', {});
const avatarSources = load('src/shared/avatar/resolveAvatarSource.ts', {
  '@shared': { DEFAULT_SELF_NAME: '用户' },
  './avatarRegistry': { getDefaultAIAvatarAsset: () => 101, getDefaultUserAvatarAsset: () => 102, getDefaultGroupAvatarAsset: () => 103 },
});
const AvatarImage = load('src/shared/ui/AvatarImage.tsx', {
  react: React, 'react-native': avatarNative, '@shared/theme': avatarThemeApi,
  '@shared/avatar/avatarConstants': avatarConstants,
}).default;
const avatarDependencies = { react: React, '@shared/avatar/avatarConstants': avatarConstants,
  '@shared/avatar/resolveAvatarSource': avatarSources, './AvatarImage': AvatarImage };
const avatars = {
  AIAvatar: load('src/shared/ui/AIAvatar.tsx', avatarDependencies).default,
  UserAvatar: load('src/shared/ui/UserAvatar.tsx', avatarDependencies).default,
};
const icons = load('src/features/moments/presentation/momentItem/icons.tsx', {
  react: React, '@expo/vector-icons': { Ionicons: 'Icon' }, '@shared/ui': avatars, '@shared/theme': avatarThemeApi,
});
const openedProfiles = [];
const MomentItem = load('src/features/moments/presentation/MomentItem.tsx', {
  react: React, 'react-native': avatarNative, '@shared/theme': avatarThemeApi,
  '@shared/ui': { showAppDialog: noop }, '@features/profile': { SELF_USER_PROFILE_ID: 'self' },
  '@features/media': { MediaAssetImage: 'AssetImage' }, 'lucide-react-native': { MapPin: 'Icon', Share2: 'Icon' },
  './MomentNavigation': { useMomentNavigation: () => ({ openAssistantProfile: id => openedProfiles.push(id) }) },
  './momentItem/icons': icons,
  './momentItem/formatters': load('src/features/moments/presentation/momentItem/formatters.ts', {}),
  './momentItem/permissions': load('src/features/moments/presentation/momentItem/permissions.ts', {}),
  './momentItem/styles': { createMomentItemStyles: () => ({}) },
  './momentItem/modals': { AIManagerModal: () => null, CommentInputModal: () => null, MoreMenuModal: () => null },
  './momentActionFeedback': {}, './MomentAudienceDraft': { describeMomentVisibility: () => null },
  './MomentMediaViewerModal': () => null,
}).default;
for (const detail of [false, true]) {
  const item = { id: 'post', actorType: 'ai', actorId: 'agent-ai', assistantId: 'assistant-ai', userName: '同名作者',
    avatar: null, content: '正文', createdAt: '', media: [], likes: [], comments: [], locationLabel: null, audienceMode: 'all' };
  const renderItem = value => React.createElement(MomentItem, { item: value, detail });
  await act(async () => { renderer = create(renderItem(item)); });
  assert.equal(renderer.root.findByType('Image').props.source, 101, `${detail ? '详情' : '列表'}中的 AI 使用 AI 默认头像`);
  await act(async () => renderer.root.findAllByType('Button').find(node => node.props.accessibilityLabel === '打开同名作者的个人主页').props.onPress());
  assert.equal(openedProfiles.at(-1), 'assistant-ai', '头像仍打开原作者主页');
  await act(async () => renderer.update(renderItem({ ...item, assistantId: null })));
  assert.equal(renderer.root.findByType('Image').props.source, 101, '已删除 AI 仍按原作者身份使用默认头像');
  assert.equal(renderer.root.findAllByType('Button').filter(node => node.props.accessibilityLabel === '打开同名作者的个人主页').length, 0);
  for (const actorType of ['user', 'ai']) {
    const author = { ...item, actorType, actorId: actorType === 'user' ? 'self' : 'agent-ai', assistantId: null };
    const expectedDefault = actorType === 'ai' ? 101 : 102;
    await act(async () => renderer.update(renderItem(author)));
    assert.equal(renderer.root.findByType('Image').props.source, expectedDefault, '作者身份改变时切换对应默认头像');
    await act(async () => renderer.update(renderItem({ ...author, avatar: 'file:///custom.jpg' })));
    assert.deepEqual(renderer.root.findByType('Image').props.source, { uri: 'file:///custom.jpg' }, '自定义头像优先');
    await act(async () => renderer.root.findByType('Image').props.onError());
    assert.equal(renderer.root.findByType('Image').props.source, expectedDefault, '自定义头像加载失败也使用对应身份的默认图');
  }
  await act(async () => renderer.unmount());
}
console.log('Moments 图片加载状态 / 首屏暂存态 / 保活封面复用与更新 / 帖子作者头像验证通过。');
