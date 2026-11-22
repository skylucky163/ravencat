/** 通过真实 React 生命周期验证已提交设置刷新，以及旧读取和页面卸载的隔离。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    assert.ok(Object.hasOwn(mocks, id), `${file}: 缺少依赖 ${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const defaultSelection = { mode: 'default', uri: null };
const initialWallpapers = { appWallpaper: defaultSelection, chatWallpaper: defaultSelection, chatWallpaperOverrides: {} };
const facts = load('src/features/profile/application/WallpaperChanged.ts');
const { WallpaperProvider, WallpaperContext } = load('src/shared/theme/wallpaper/WallpaperProvider.tsx', {
  './wallpaperStorage': { DEFAULT_WALLPAPER_SELECTION: defaultSelection },
});
let wallpaperSnapshot, renderer;
const firstWallpaperRead = deferred();
let currentWallpapers = initialWallpapers, wallpaperReads = 0, wallpaperSubscriptions = 0;
const wallpaperPersistence = {
  load: () => ++wallpaperReads === 1 ? firstWallpaperRead.promise : Promise.resolve(currentWallpapers),
  async setGlobal(_slot, uri) {
    currentWallpapers = { ...currentWallpapers, appWallpaper: { mode: 'custom', uri } };
    facts.publishWallpaperChanged();
  },
  async setConversation(key, uri) {
    currentWallpapers = { ...currentWallpapers, chatWallpaperOverrides: { [key]: { mode: 'custom', uri } } };
    facts.publishWallpaperChanged();
  },
  subscribe(listener) {
    wallpaperSubscriptions++;
    const unsubscribe = facts.subscribeWallpaperChanged(listener);
    return () => { wallpaperSubscriptions--; unsubscribe(); };
  },
};
function WallpaperProbe() { wallpaperSnapshot = React.useContext(WallpaperContext); return null; }
await act(async () => { renderer = create(React.createElement(WallpaperProvider, { persistence: wallpaperPersistence }, React.createElement(WallpaperProbe))); });
await act(async () => {
  currentWallpapers = { ...initialWallpapers, appWallpaper: { mode: 'custom', uri: 'file:///ai-background.png' } };
  facts.publishWallpaperChanged();
});
assert.equal(wallpaperSnapshot.appWallpaper.uri, 'file:///ai-background.png');
await act(async () => { firstWallpaperRead.resolve(initialWallpapers); });
assert.equal(wallpaperSnapshot.appWallpaper.uri, 'file:///ai-background.png', '晚到初始化不能覆盖 AI 刚保存的图');
await act(async () => { await wallpaperSnapshot.setCustomChatWallpaperOverride('single:a', 'file:///chat.png'); });
assert.deepEqual(wallpaperSnapshot.getChatWallpaperSource('single:a'), { uri: 'file:///chat.png' });
await act(async () => { renderer.unmount(); });
assert.equal(wallpaperSubscriptions, 0);
const readsAfterUnmount = wallpaperReads;
facts.publishWallpaperChanged();
assert.equal(wallpaperReads, readsAfterUnmount, '卸载后的 Provider 不再读取');

const assistantListeners = new Set();
const lifecycleListeners = new Set();
const initialAIRead = deferred();
let aiReads = 0, assistantsSnapshot;
let arrival = { revision: 0 };
let previewReads = 0;
let previewGate = null;
let previewText = '已有消息预览';
let nextAIError = null;
let profiles = [{ id: 'a', name: '原名', avatar: 'file:///old.png', canonicalConversationId: 'chat' }];
const { default: useAIAssistants } = load('src/features/chat/presentation/shell/useAIAssistants.ts', {
  '@features/assistants': {
    listAIAssistants: () => {
      aiReads++;
      if (nextAIError) { const error = nextAIError; nextAIError = null; return Promise.reject(error); }
      return aiReads === 1 ? initialAIRead.promise : Promise.resolve(profiles);
    },
    subscribeAIAssistantUpdated: listener => { assistantListeners.add(listener); return () => { assistantListeners.delete(listener); }; },
    subscribeAssistantLifecycleChanged: listener => { lifecycleListeners.add(listener); return () => { lifecycleListeners.delete(listener); }; },
  },
  './arrivedConversationPreview': { withArrivedConversationPreview: async profile => {
    previewReads++;
    const text = previewText;
    if (previewGate) await previewGate.promise;
    return { ...profile, lastMessage: text };
  } },
  '../../reply/delivery/AssistantMessageArrival': { getAssistantMessageArrivalSnapshot: () => arrival },
});
function AssistantsProbe() { assistantsSnapshot = useAIAssistants(); return null; }
await act(async () => { renderer = create(React.createElement(AssistantsProbe)); });
let oldRead;
await act(async () => { oldRead = assistantsSnapshot.loadAIAssistants(); });
const arrivalLoads = [];
await act(async () => {
  for (let revision = 1; revision <= 3; revision++) {
    arrival = { revision };
    arrivalLoads.push(assistantsSnapshot.loadAIAssistants());
  }
});
assert.equal(aiReads, 1, '到达快照变化不并行重读包含头像的助手列表');
await act(async () => {
  profiles = [{ ...profiles[0], name: '自主新名称', avatar: 'file:///ai-new.png' }];
  for (const listener of assistantListeners) listener(profiles[0]);
});
assert.equal(aiReads, 1, '资料变更合并到在途读取后处理');
await act(async () => { initialAIRead.resolve([{ id: 'a', name: '旧快照' }]); await Promise.all([oldRead, ...arrivalLoads]); });
assert.equal(assistantsSnapshot.aiList[0].name, '自主新名称');
assert.equal(assistantsSnapshot.aiList[0].avatar, 'file:///ai-new.png');
assert.equal(assistantsSnapshot.aiList[0].lastMessage, '已有消息预览');
assert.equal(aiReads, 2, '真实资料变更仍需补读，不能把旧助手资料当缓存');
assert.equal(assistantsSnapshot.aiList[0].name, '自主新名称', '旧列表读取不能覆盖提交后的资料');
previewGate = deferred();
let pendingPreview;
await act(async () => { pendingPreview = assistantsSnapshot.loadAIAssistants(); });
const readsBeforePreviewChange = aiReads;
await act(async () => {
  arrival = { revision: 4 };
  previewText = '刚到达的新消息';
  assistantsSnapshot.loadAIAssistants();
});
await act(async () => { previewGate.resolve(); await pendingPreview; });
assert.equal(aiReads, readsBeforePreviewChange, '预览期间的新到达只补读预览，不重新解析全部头像');
assert.equal(assistantsSnapshot.aiList[0].lastMessage, '刚到达的新消息');
assert.equal(previewReads, 3);
previewGate = deferred();
await act(async () => { pendingPreview = assistantsSnapshot.loadAIAssistants(); });
const readsBeforeDisplay = aiReads;
await act(async () => {
  // Agent 正文在 T3 前交付，不改变正式消息的原生到达快照。
  previewText = '工具执行前已经说出的正文';
  assistantsSnapshot.loadAIAssistants();
});
await act(async () => { previewGate.resolve(); await pendingPreview; });
assert.equal(assistantsSnapshot.aiList[0].lastMessage, '工具执行前已经说出的正文', '在途读取不能丢失无原生到达版本变化的正文交付');
assert.equal(aiReads, readsBeforeDisplay, '只重读失效的预览，不重复解析头像或重新加载资料');
previewGate = null;
nextAIError = new Error('模拟列表读取失败');
await act(async () => { await assert.rejects(assistantsSnapshot.loadAIAssistants(), /模拟列表读取失败/u); });
await act(async () => { await assistantsSnapshot.loadAIAssistants(); });
assert.equal(assistantsSnapshot.aiList[0].name, '自主新名称', '失败后新的刷新不能卡在已拒绝的在途状态');
await act(async () => { renderer.unmount(); });
assert.equal(assistantListeners.size, 0);
assert.equal(lifecycleListeners.size, 0);

const profileListeners = new Set();
const initialProfileRead = deferred();
let coverSnapshot;
const { useMomentsCover } = load('src/features/moments/presentation/useMomentsCover.ts', {
  '@shared/ui': {}, 'react-native': {}, 'expo-image-picker': {}, '@platform/device/DeviceMediaService': {},
  '../../../../assets/ravenphone_bg.png': 'default-cover',
  '@features/profile': {
    DEFAULT_USER_PROFILE: { momentsCover: null }, getCurrentUserProfile: () => initialProfileRead.promise,
    subscribeUserProfileUpdated: listener => { profileListeners.add(listener); return () => { profileListeners.delete(listener); }; },
  },
});
function CoverProbe() { coverSnapshot = useMomentsCover(); return null; }
await act(async () => { renderer = create(React.createElement(CoverProbe)); });
await act(async () => { for (const listener of profileListeners) listener({ momentsCover: 'file:///new-cover.png', momentsCoverMediaAssetId: 'new' }); });
assert.deepEqual(coverSnapshot.coverSource, { uri: 'file:///new-cover.png' });
await act(async () => { initialProfileRead.resolve({ momentsCover: 'file:///old-cover.png' }); });
assert.deepEqual(coverSnapshot.coverSource, { uri: 'file:///new-cover.png' }, '旧 Profile 查询不能覆盖新封面');
await act(async () => { renderer.unmount(); });
assert.equal(profileListeners.size, 0);
console.log('应用设置展示验证通过：壁纸、助手名称与头像、朋友圈封面即时刷新，旧读取隔离及卸载清理。');
