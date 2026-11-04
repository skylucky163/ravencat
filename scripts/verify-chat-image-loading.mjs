/** 历史图片加载、回收状态隔离及媒体读取成本回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(relativePath, mocks) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'console', output)(
    module, module.exports,
    (name) => {
      assert.ok(Object.hasOwn(mocks, name), `未声明的依赖：${name}`);
      return mocks[name];
    },
    { ...console, error() {} },
  );
  return module.exports;
}

const reads = [];
const stats = [];
const assets = new Map([['primary', 'file:///primary'], ['thumb', 'file:///thumb']]);
const resolver = load('src/features/chat/messages/application/ResolveChatAttachmentMedia.ts', {
  '@features/media': {
    async resolveMediaAsset(id) {
      reads.push(id);
      if (!assets.has(id)) throw new Error('媒体缺失');
      return { localUri: assets.get(id) };
    },
  },
  '@platform/device/DeviceMediaService': {
    async getPersistentMediaInfo(uri) {
      stats.push(uri);
      return { exists: uri !== 'file:///missing' };
    },
  },
});
const resolveImage = resolver.resolveChatImageAttachmentUris;
assert.deepEqual(await resolveImage({ mediaAssetId: 'primary' }), {
  previewUri: 'file:///primary', fullSizeUri: 'file:///primary',
});
assert.deepEqual(reads, ['primary'], '没有独立缩略图时只解析一份媒体');
assert.equal(stats.length, 0, '已验证的 MediaAsset 不重复查询文件');
reads.length = 0;
await resolveImage({ mediaAssetId: 'primary', thumbnailMediaAssetId: 'primary' });
assert.deepEqual(reads, ['primary']);
assert.deepEqual(await resolveImage({ mediaAssetId: 'primary', thumbnailMediaAssetId: 'thumb' }), {
  previewUri: 'file:///thumb', fullSizeUri: 'file:///primary',
});
assert.deepEqual(await resolveImage({ mediaAssetId: 'missing', thumbnailMediaAssetId: 'thumb' }), {
  previewUri: 'file:///thumb', fullSizeUri: 'file:///thumb',
});
assert.deepEqual(await resolveImage({ mediaAssetId: 'primary', thumbnailMediaAssetId: 'missing' }), {
  previewUri: 'file:///primary', fullSizeUri: 'file:///primary',
});
assert.equal(await resolveImage({ mediaAssetId: 'missing' }), null);
assert.deepEqual(await resolveImage({ localUri: 'https://example.test/image' }), {
  previewUri: 'https://example.test/image', fullSizeUri: 'https://example.test/image',
});
assert.equal(stats.length, 0, '远程图片交给原生 Image 加载');
assert.deepEqual(await resolveImage({ localUri: 'file:///legacy' }), {
  previewUri: 'file:///legacy', fullSizeUri: 'file:///legacy',
});
assert.deepEqual(stats, ['file:///legacy'], '历史裸 URI 在文件边界检查一次');
assert.equal(await resolveImage({ localUri: 'file:///missing' }), null);

const store = load('src/platform/device/PersistentMediaStore.ts', {
  './MediaFileLifetime': load('src/platform/device/MediaFileLifetime.ts', {}),
  'expo-file-system/legacy': {
    documentDirectory: 'file:///documents/',
    async getInfoAsync(uri, options) {
      assert.notEqual(options?.md5, true, '展示存在性检查不能读取整份文件计算 MD5');
      return { exists: true, isDirectory: false, uri };
    },
  },
});
assert.equal((await store.persistentMediaStore.getInfo('file:///legacy')).exists, true);

// 只模拟 Hook 的生命周期契约，断言真实组件产出的用户界面与异步状态。
const slots = [];
let cursor = 0;
let effects = [];
const sameDeps = (left, right) => left && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index]));
const initial = (value) => typeof value === 'function' ? value() : value;
function useState(value) {
  const index = cursor++;
  if (!slots[index]) {
    const slot = { value: initial(value) };
    slot.set = (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; };
    slots[index] = slot;
  }
  return [slots[index].value, slots[index].set];
}
function useRecyclingState(value, deps) {
  const index = cursor;
  const state = useState(value);
  if (!sameDeps(slots[index].deps, deps)) {
    slots[index].deps = deps;
    slots[index].value = initial(value);
  }
  return [slots[index].value, state[1]];
}
const react = {
  Fragment: 'Fragment',
  createContext: (value) => ({ value }),
  useContext: (context) => context.value,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState,
  useMemo(factory, deps) {
    const index = cursor++;
    if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() };
    return slots[index].value;
  },
  useEffect(effect, deps) {
    const index = cursor++;
    if (!sameDeps(slots[index]?.deps, deps)) {
      const previous = slots[index];
      const next = { deps };
      slots[index] = next;
      effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
    }
  },
};
const mediaCacheModule = load('src/features/chat/presentation/messages/components/chatMediaResolutionCache.ts', { react });
const { ChatMediaResolutionCacheContext, createChatMediaResolutionCache } = mediaCacheModule;
ChatMediaResolutionCacheContext.value = createChatMediaResolutionCache();
const pending = new Map();
let requests = 0;
const theme = {
  colors: { icon: { secondary: '#888' }, border: { light: '#ddd' }, text: { secondary: '#888' } },
  radius: { sm: 4 },
};
const Card = load('src/features/chat/presentation/messages/MessageBubble/ImageAttachmentCard.tsx', {
  react,
  'react-native': {
    ActivityIndicator: 'ActivityIndicator', Image: 'Image', Pressable: 'Pressable', Text: 'Text', View: 'View',
    StyleSheet: { create: (value) => value, absoluteFill: { position: 'absolute' } },
  },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shopify/flash-list': { useRecyclingState },
  '@shared/theme': { useTheme: () => theme, useThemedStyles: (factory) => factory(theme) },
  './ImagePreviewModal': { default: 'Preview', __esModule: true },
  '../components/chatMediaResolutionCache': mediaCacheModule,
  '../../../messages/application/ResolveChatAttachmentMedia': {
    resolveChatImageAttachmentUris(reference) {
      requests += 1;
      return new Promise((resolve) => pending.set(reference.mediaAssetId, resolve));
    },
  },
}).default;
const props = (id) => ({
  attachment: { id, mediaAssetId: id, type: 'image', width: 220, height: 260 }, isMe: true,
});
function render(value, Component = Card) {
  cursor = 0;
  effects = [];
  const tree = Component(value);
  effects.forEach((effect) => effect());
  return tree;
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const find = (tree, type) => nodes(tree).find((node) => node.type === type);
const unavailable = (tree) => nodes(tree).some((node) => node.type === 'Text'
  && node.props.children.includes('图片不可用'));
async function finish(id, uris = { previewUri: id, fullSizeUri: id }) {
  pending.get(id)(uris);
  await Promise.resolve();
}
let tree = render(props('a'));
assert.ok(find(tree, 'ActivityIndicator'));
assert.equal(unavailable(tree), false, '解析期间不能假报图片不可用');
assert.equal(find(tree, 'Image').props.style.height, 260, '占位沿用图片真实尺寸');
await finish('a');
tree = render(props('a'));
assert.equal(find(tree, 'Image').props.source.uri, 'a');
assert.equal(find(tree, 'ActivityIndicator'), undefined);
render({ ...props('a'), attachment: { ...props('a').attachment, parsedText: '识别结果换代' } });
assert.equal(requests, 1, 'metadata 换代不能清空已显示图片或重新解析');
find(tree, 'Pressable').props.onPress();
assert.equal(find(render(props('a')), 'Preview').props.visible, true);
tree = render(props('b'));
assert.equal(find(tree, 'Preview').props.visible, false, '回收后不能继承上一条消息的预览');
assert.equal(find(tree, 'Image').props.source, undefined, '回收后不能显示上一张图');
await finish('b');
assert.equal(find(render(props('b')), 'Image').props.source.uri, 'b');
const requestsBeforeRevisit = requests;
tree = render(props('a'));
assert.equal(find(tree, 'Image').props.source.uri, 'a', '回收卡片翻回已解析图片时直接显示');
assert.equal(find(tree, 'ActivityIndicator'), undefined, '滚回旧图片不能重新显示解析圈');
assert.equal(find(tree, 'Preview').props.visible, false, '复用地址不复用打开大图的交互状态');
assert.equal(requests, requestsBeforeRevisit, '列表复用成功地址，不重复查询数据库和文件');
slots.forEach((slot) => slot.cleanup?.());
slots.length = 0;
tree = render(props('b'));
assert.equal(find(tree, 'Image').props.source.uri, 'b', '更换卡片实例仍复用当前列表的媒体地址');
assert.equal(find(tree, 'ActivityIndicator'), undefined);
assert.equal(requests, requestsBeforeRevisit);
render(props('c'));
render(props('d'));
await finish('c');
assert.ok(find(render(props('d')), 'ActivityIndicator'), '上一张图的迟到结果不能覆盖当前图');
await finish('d');
assert.equal(find(render(props('d')), 'Image').props.source.uri, 'd');
render(props('missing'));
await finish('missing', null);
tree = render(props('missing'));
assert.equal(unavailable(tree), true, '只有确认无可用媒体后显示不可用');
assert.equal(find(tree, 'Image').props.style.height, 260, '失败状态也不能改变布局高度');
render(props('a'));
tree = render(props('missing'));
assert.ok(find(tree, 'ActivityIndicator'), '解析失败不进入成功缓存，重新展示时仍可恢复');
await finish('missing', { previewUri: 'recovered', fullSizeUri: 'recovered' });
assert.equal(find(render(props('missing')), 'Image').props.source.uri, 'recovered');
const thumbnailProps = { ...props('a'), attachment: { ...props('a').attachment, thumbnailMediaAssetId: 'new-thumbnail' } };
tree = render(thumbnailProps);
assert.ok(find(tree, 'ActivityIndicator'), '独立缩略图变化不能误用旧媒体组合的缓存');
await finish('a', { previewUri: 'new-thumbnail', fullSizeUri: 'a' });
assert.equal(find(render(thumbnailProps), 'Image').props.source.uri, 'new-thumbnail');
assert.equal(find(render(props('a')), 'Image').props.source.uri, 'a', '不同缩略图组合分别缓存');

// 表情包消息与引用使用同一卡片，加载期间不能提前宣告媒体失效。
slots.forEach((slot) => slot.cleanup?.());
slots.length = 0;
const stickerRequests = new Map();
let stickerRequestCount = 0;
const StickerCard = load('src/features/chat/presentation/messages/MessageBubble/StickerMessageCard.tsx', {
  react,
  'react-native': {
    ActivityIndicator: 'ActivityIndicator', Image: 'Image', Text: 'Text', View: 'View',
    StyleSheet: { create: (value) => value },
  },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shopify/flash-list': { useRecyclingState },
  '@shared/theme': { useTheme: () => theme, useThemedStyles: (factory) => factory(theme) },
  '../components/chatMediaResolutionCache': mediaCacheModule,
  '@features/media': {
    resolveMediaAsset(id) {
      stickerRequestCount += 1;
      return new Promise((resolve, reject) => stickerRequests.set(id, { resolve, reject }));
    },
  },
}).default;
const stickerProps = (id) => ({ sticker: { mediaAssetId: id, width: 100, height: 100 } });
const renderSticker = (id) => render(stickerProps(id), StickerCard);
const stickerUnavailable = (tree) => nodes(tree).some((node) => node.type === 'Text'
  && node.props.children.includes('表情包不可用'));
const placeholderHeight = (tree) => nodes(tree).find((node) => Array.isArray(node.props?.style))
  .props.style[0].height;
async function finishSticker(id, failed = false) {
  const request = stickerRequests.get(id);
  if (failed) request.reject(new Error('媒体缺失'));
  else request.resolve({ localUri: `file:///${id}` });
  await Promise.resolve();
  await Promise.resolve();
}
tree = renderSticker('sticker-a');
assert.ok(find(tree, 'ActivityIndicator'), '表情包解析期间显示加载提示');
assert.equal(stickerUnavailable(tree), false, '解析期间不能假报表情包不可用');
assert.equal(placeholderHeight(tree), 130, '占位沿用表情包尺寸');
await finishSticker('sticker-a');
tree = renderSticker('sticker-a');
assert.equal(find(tree, 'Image').props.source.uri, 'file:///sticker-a');
assert.equal(find(tree, 'Image').props.style.height, 130);
assert.equal(find(tree, 'ActivityIndicator'), undefined);
tree = renderSticker('sticker-b');
assert.equal(find(tree, 'Image'), undefined, '回收卡片不能显示上一张表情包');
assert.ok(find(tree, 'ActivityIndicator'));
await finishSticker('sticker-b', true);
tree = renderSticker('sticker-b');
assert.equal(stickerUnavailable(tree), true, '解析失败后才显示表情包不可用');
assert.equal(placeholderHeight(tree), 130, '失败状态不改变卡片高度');
renderSticker('sticker-c');
tree = renderSticker('sticker-d');
assert.equal(stickerUnavailable(tree), false, '更换媒体后清除之前的失败状态');
await finishSticker('sticker-c', true);
tree = renderSticker('sticker-d');
assert.ok(find(tree, 'ActivityIndicator'), '旧媒体的迟到失败不能覆盖当前加载状态');
assert.equal(stickerUnavailable(tree), false);
await finishSticker('sticker-d');
assert.equal(find(renderSticker('sticker-d'), 'Image').props.source.uri, 'file:///sticker-d');
renderSticker('sticker-e');
renderSticker('sticker-f');
await finishSticker('sticker-e');
assert.ok(find(renderSticker('sticker-f'), 'ActivityIndicator'), '旧媒体的迟到成功不能覆盖当前加载状态');
await finishSticker('sticker-f');
assert.equal(find(renderSticker('sticker-f'), 'Image').props.source.uri, 'file:///sticker-f');
const stickerRequestsBeforeRevisit = stickerRequestCount;
tree = renderSticker('sticker-a');
assert.equal(find(tree, 'Image').props.source.uri, 'file:///sticker-a', '翻回旧表情包直接复用已解析地址');
assert.equal(find(tree, 'ActivityIndicator'), undefined);
assert.equal(stickerRequestCount, stickerRequestsBeforeRevisit);
slots.forEach((slot) => slot.cleanup?.());
slots.length = 0;
tree = renderSticker('sticker-a');
assert.equal(find(tree, 'ActivityIndicator'), undefined, '表情包重新挂载也不重复转圈');
assert.equal(stickerRequestCount, stickerRequestsBeforeRevisit);
ChatMediaResolutionCacheContext.value = createChatMediaResolutionCache();
tree = renderSticker('sticker-a');
assert.ok(find(tree, 'ActivityIndicator'), '不同会话列表不共享媒体地址缓存');
await finishSticker('sticker-a');
assert.equal(find(renderSticker('sticker-a'), 'Image').props.source.uri, 'file:///sticker-a');
ChatMediaResolutionCacheContext.value = null;
tree = renderSticker('sticker-a');
assert.ok(find(tree, 'ActivityIndicator'), '列表外的卡片独立解析，不依赖列表 Provider');
await finishSticker('sticker-a');
assert.equal(find(renderSticker('sticker-a'), 'Image').props.source.uri, 'file:///sticker-a');
slots.forEach((slot) => slot.cleanup?.());

// 长历史只保留最近使用的地址，不持有无限增长的媒体目录或位图。
const boundedCache = createChatMediaResolutionCache();
for (const bucket of [boundedCache.stickers, boundedCache.assets]) {
  bucket.set('oldest', 'file:///oldest');
  bucket.set('revisited', 'file:///revisited');
  for (let index = 0; index < 1000; index += 1) {
    bucket.get('revisited');
    bucket.set(`item-${index}`, `file:///item-${index}`);
  }
  assert.equal(bucket.get('oldest'), undefined, '长历史会淘汰早已离开的缓存');
  assert.equal(bucket.get('revisited'), 'file:///revisited', '仍在访问的媒体保留缓存');
}
console.log('聊天图片、表情包加载与媒体读取回归通过');
