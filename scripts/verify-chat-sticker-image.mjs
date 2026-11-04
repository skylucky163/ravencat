/** 使用真实 React 生命周期验证表情图片失败占位、诊断与列表复用隔离。 */
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { load } from './helpers/chat-message-mutation-fixture.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const cache = new Map();
const Context = React.createContext({ stickers: cache });
const requests = [];
const diagnostics = [];
const theme = { colors: { icon: {}, text: {}, border: {} }, radius: {} };
const { default: StickerMessageCard } = load('src/features/chat/presentation/messages/MessageBubble/StickerMessageCard.tsx', {
  'react-native': { ActivityIndicator: 'ActivityIndicator', Image: 'Image', Text: 'Text', View: 'View',
    StyleSheet: { create: value => value } },
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  '@features/media': { resolveMediaAsset: id => new Promise((resolve, reject) => requests.push({ id, resolve, reject })) },
  '@shared/theme': { useTheme: () => theme, useThemedStyles: factory => factory(theme) },
  '../components/chatMediaResolutionCache': { ChatMediaResolutionCacheContext: Context },
});
const snapshot = id => ({ stickerId: `sticker-${id}`, mediaAssetId: id, name: id,
  mimeType: 'image/png', width: 128, height: 128 });
const card = id => React.createElement(StickerMessageCard, { sticker: snapshot(id) });
const unavailable = tree => tree.root.findAllByType('Text').some(text => text.props.children === '表情包不可用');
const warn = console.warn;
console.warn = (...args) => diagnostics.push(args);
let tree;
try {
  await act(async () => { tree = create(card('first')); });
  assert.equal(tree.root.findAllByType('ActivityIndicator').length, 1);
  await act(async () => { requests[0].resolve({ localUri: 'file:///first.png' }); });
  const oldError = tree.root.findByType('Image').props.onError;
  await act(async () => { oldError({ nativeEvent: { error: 'decode failed' } }); });
  assert.equal(unavailable(tree), true, 'URI 解析成功后的原生解码失败必须显示不可用占位');
  assert.equal(tree.root.findAllByType('Image').length, 0);
  assert.equal(requests.length, 1, '失败不自动重试解析或删除历史媒体引用');
  assert.deepEqual(diagnostics.at(-1)[1], { stickerId: 'sticker-first', mediaAssetId: 'first',
    mimeType: 'image/png', localUri: 'file:///first.png', stage: 'image', error: 'decode failed' });

  cache.set('cached', 'file:///cached.png');
  await act(async () => { tree.update(card('cached')); });
  assert.equal(tree.root.findByType('Image').props.source.uri, 'file:///cached.png', '换素材重置旧错误并复用 URI 缓存');
  await act(async () => { oldError({ nativeEvent: { error: 'late first error' } }); });
  assert.equal(unavailable(tree), false, '旧 Image 的迟到回调不能污染当前卡片');
  const cachedError = tree.root.findByType('Image').props.onError;
  await act(async () => { cachedError({ nativeEvent: { error: 'cached backing missing' } }); });
  assert.equal(unavailable(tree), true, '缓存命中也必须处理真实加载失败');
  assert.equal(requests.length, 1);

  await act(async () => { tree.update(card('slow')); });
  const slow = requests.at(-1);
  await act(async () => { tree.update(card('new')); });
  await act(async () => { requests.at(-1).resolve({ localUri: 'file:///new.png' }); });
  await act(async () => { slow.resolve({ localUri: 'file:///slow.png' }); });
  assert.equal(tree.root.findByType('Image').props.source.uri, 'file:///new.png', '旧解析成功不能覆盖新素材');

  await act(async () => { tree.update(card('slow-failure')); });
  const slowFailure = requests.at(-1);
  await act(async () => { tree.update(card('cached')); });
  await act(async () => { slowFailure.reject(new Error('old missing')); });
  assert.equal(unavailable(tree), false, '旧解析失败不能覆盖新素材');
  await act(async () => { tree.update(card('missing')); });
  await act(async () => { requests.at(-1).reject(new Error('backing missing')); });
  assert.equal(unavailable(tree), true);
  assert.equal(diagnostics.at(-1)[1].stage, 'resolve');
  assert.equal(diagnostics.at(-1)[1].mediaAssetId, 'missing');
  await act(async () => { tree.unmount(); });
  tree = null;
} finally {
  if (tree) await act(async () => { tree.unmount(); });
  console.warn = warn;
}
console.log('表情图片验证通过：解析与加载失败占位、素材诊断、缓存命中和旧回调隔离，无自动重试。');
