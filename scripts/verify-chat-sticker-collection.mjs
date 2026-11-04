/** 消息表情收藏：真实 SQLite 与调度器验证归属、幂等、容量及 React 菜单状态。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';
import { load as loadReact } from './helpers/chat-message-mutation-fixture.mjs';
import { bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';
import { createCoordinatedSqliteFixture } from './helpers/coordinated-sqlite-fixture.mjs';

const require = createRequire(import.meta.url);
const db = new DatabaseSync(':memory:');
const raw = createSqliteExecutor(db);
await bootstrapSqlite(raw);
db.exec('PRAGMA foreign_keys = ON');
const persistence = createCoordinatedSqliteFixture(raw);
const domain = load('src/features/stickers/domain/Sticker.ts');
const { SQLiteStickerRepository } = load('src/features/stickers/infrastructure/SQLiteStickerRepository.ts', {
  '@platform/persistence': persistence,
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
  '../domain/Sticker': domain,
});
const repository = new SQLiteStickerRepository(persistence.executor);
const changed = load('src/features/stickers/application/StickerAnnotationChangedSignal.ts');
const pending = load('src/features/stickers/application/StickerEmbeddingPendingSignal.ts');
let sequence = 0;
const time = '2026-10-31T00:00:00.000Z';
const runtime = { getStickersRuntimeDependencies: () => ({ repository, generateId: () => `saved-${++sequence}`, now: () => time }) };
const commands = load('src/features/stickers/application/StickerCommands.ts', {
  '@features/media': { MEDIA_ASSET_STORAGE_BACKEND: {} },
  '../domain/Sticker': domain,
  './StickerRuntime': runtime,
  './StickerAnnotationPendingSignal': {},
  './StickerAnnotationChangedSignal': changed,
  './StickerEmbeddingPendingSignal': pending,
});
const queries = load('src/features/stickers/application/StickerQueries.ts', {
  '../domain/Sticker': domain,
  './StickerRuntime': runtime,
});
function snapshot(id, extra = {}) {
  db.prepare(`INSERT INTO media_assets
    (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,status,created_at,updated_at)
    VALUES (?,'persistent-image',?,'sha256',?,'image/png',100,'ready',?,?)`).run(id, id, '0'.repeat(64), time, time);
  return { stickerId: `source-${id}`, mediaAssetId: id, name: '开心猫猫', description: '一只开心的猫猫',
    tags: ['开心', '猫'], emotion: '开心', mimeType: 'image/png', width: 128, height: 128, isAnimated: false, ...extra };
}
const sent = snapshot('shared');
const source = { ...sent, id: sent.stickerId, ownerAssistantId: 'ai', groupId: null,
  sourceFileName: null, isFavorite: true, useCount: 8, lastUsedAt: time,
  annotationStatus: 'ready', annotationError: null, semanticRevision: 4, createdAt: time, updatedAt: time };
db.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('ai', 'agent-ai', '测试', 'test', time, time);
await repository.createStickerIfAbsent(source);
assert.equal(await queries.isStickerInUserLibrary(sent.mediaAssetId), false, 'AI 已收藏不代表用户已添加');
let notifications = 0;
let embeddings = 0;
changed.subscribeStickerAnnotationChanged(() => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stickers WHERE owner_assistant_id IS NULL').get().n > 0, true, '通知发生于提交之后');
  notifications++;
});
pending.subscribeStickerEmbeddingPending(() => embeddings++);
const results = await Promise.all([commands.addStickerFromMessage(sent), commands.addStickerFromMessage(sent)]);
assert.deepEqual(results.map(result => result.reused), [false, true], '并发添加只产生一个用户收藏');
const saved = results[0].sticker;
assert.notEqual(saved.id, sent.stickerId);
assert.equal(saved.ownerAssistantId, null);
assert.equal(saved.annotationStatus, 'ready');
assert.equal(saved.useCount, 0);
assert.equal(saved.isFavorite, false);
assert.equal(saved.semanticRevision, 1);
assert.deepEqual(saved.tags, sent.tags);
assert.equal(saved.description, sent.description);
assert.equal(saved.sourceFileName, null, '历史快照允许没有来源文件名');
assert.equal(notifications, 1);
assert.equal(embeddings, 1);
assert.equal(await queries.isStickerInUserLibrary(sent.mediaAssetId), true);
assert.equal((await repository.getStickerById(source.id, 'ai')).useCount, 8, '用户添加不改写 AI 收藏');
await repository.updateStickerMetadata(saved.id, { name: '用户改过的名字' }, time);
const duplicate = await commands.addStickerFromMessage({ ...sent, stickerId: 'other-ai-copy', name: '另一份名字' });
assert.equal(duplicate.reused, true);
assert.equal(duplicate.sticker.name, '用户改过的名字', '同图不同收藏 ID 复用用户记录且不覆盖语义');
await repository.deleteSticker(saved.id);
await repository.deleteSticker(source.id, 'ai');
assert.equal(await queries.isStickerInUserLibrary(sent.mediaAssetId), false);
assert.equal((await commands.addStickerFromMessage(sent)).reused, false, '原收藏删除后仍可从消息快照重新添加');
const animated = snapshot('animated', { isAnimated: true, mimeType: 'image/gif', sourceFileName: '猫猫.gif' });
assert.equal((await commands.addStickerFromMessage(animated)).sticker.annotationStatus, 'ready', '已具备语义的动态表情也能直接收藏发送');
const beforeFailure = notifications;
await assert.rejects(commands.addStickerFromMessage({ ...sent, mediaAssetId: 'missing' }));
assert.equal(notifications, beforeFailure, '失败不发布已提交通知');

// 499 张时两个不同素材并发添加，只有一个能占据最后的容量。
for (let index = 0; index < 497; index++) {
  await commands.addStickerFromMessage(snapshot(`fill-${index}`));
}
const last = snapshot('last');
const overflow = snapshot('overflow');
const capacity = await Promise.allSettled([commands.addStickerFromMessage(last), commands.addStickerFromMessage(overflow)]);
assert.equal(capacity.filter(result => result.status === 'fulfilled').length, 1);
assert.ok(capacity.find(result => result.status === 'rejected').reason instanceof domain.StickerLibraryFullError);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stickers WHERE owner_assistant_id IS NULL').get().n, 500);
assert.equal((await commands.addStickerFromMessage(sent)).reused, true, '满额时仍可复用已有收藏');

const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const toasts = [];
const dialogs = [];
let checkLibrary = queries.isStickerInUserLibrary;
let saveSticker = commands.addStickerFromMessage;
const { useChatStickerAction } = loadReact('src/features/chat/presentation/messages/components/useChatStickerAction.ts', {
  'react-native': { ToastAndroid: { SHORT: 0, show: message => toasts.push(message) } },
  '@features/stickers': { isStickerInUserLibrary: id => checkLibrary(id), addStickerFromMessage: value => saveSticker(value) },
  '@shared/ui': { showAppDialog: dialog => dialogs.push(dialog) },
  '../../../messages/domain/chatMessageMetadata': { getMessageSticker: message => message?.sticker ?? null },
});
let message = { id: 1, sticker: sent };
let action;
function Harness() { action = useChatStickerAction(message); return null; }
let rendered;
await renderer.act(async () => { rendered = renderer.create(React.createElement(Harness)); });
assert.equal(action.isAdded, true);
assert.equal(action.add, undefined, '已添加不可重复点击');
await repository.deleteSticker((await repository.getStickerByMediaAssetId(sent.mediaAssetId)).id);
await renderer.act(async () => { message = null; rendered.update(React.createElement(Harness)); });
assert.equal(action, null, '普通消息不显示添加表情操作');
await renderer.act(async () => { message = { id: 1, sticker: sent }; rendered.update(React.createElement(Harness)); });
assert.equal(action.isAdded, false);
assert.equal(typeof action.add, 'function', '重新打开读取当前收藏事实');
await renderer.act(async () => { await action.add(); });
assert.equal(toasts.at(-1), '已添加到表情包');
assert.equal(action.isAdded, true);

let finishOldRead;
checkLibrary = id => id === 'delayed' ? new Promise(resolve => { finishOldRead = resolve; }) : Promise.resolve(true);
await renderer.act(async () => { message = { id: 2, sticker: { ...sent, mediaAssetId: 'delayed' } }; rendered.update(React.createElement(Harness)); });
assert.equal(action.add, undefined, '状态未加载完成时禁止添加');
await renderer.act(async () => { message = { id: 3, sticker: animated }; rendered.update(React.createElement(Harness)); });
await renderer.act(async () => { finishOldRead(false); });
assert.equal(action.isAdded, true, '迟到查询不能污染新菜单');
let finishSave;
let saveCalls = 0;
checkLibrary = async id => id === animated.mediaAssetId;
saveSticker = () => { saveCalls++; return new Promise(resolve => { finishSave = resolve; }); };
await renderer.act(async () => { message = { id: 4, sticker: sent }; rendered.update(React.createElement(Harness)); });
const add = action.add;
let saving;
await renderer.act(async () => { saving = add(); await add(); });
assert.equal(saveCalls, 1, '重复点击只提交一次');
await renderer.act(async () => { message = { id: 5, sticker: animated }; rendered.update(React.createElement(Harness)); });
await renderer.act(async () => { finishSave({ reused: false }); await saving; });
assert.equal(action.isAdded, true, '旧菜单保存完成后重新查询当前表情');
checkLibrary = async () => false;
saveSticker = async () => { throw new Error('保存失败'); };
await renderer.act(async () => { message = { id: 6, sticker: sent }; rendered.update(React.createElement(Harness)); });
await renderer.act(async () => { await action.add(); });
assert.equal(dialogs.at(-1).title, '添加表情包失败');
assert.equal(action.isAdded, false);
assert.equal(typeof action.add, 'function', '失败后可由用户再次添加');
checkLibrary = async () => { throw new Error('查询失败'); };
await renderer.act(async () => { message = { id: 7, sticker: animated }; rendered.update(React.createElement(Harness)); });
assert.equal(dialogs.at(-1).title, '表情包状态加载失败');
assert.equal(action.add, undefined, '查询失败不猜测收藏状态');
await renderer.act(async () => rendered.unmount());

const { default: Menu } = loadReact('src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx', {
  'react-native': { Modal: 'Modal', View: 'View', Text: 'Text', TouchableOpacity: 'Button', TouchableWithoutFeedback: 'Backdrop',
    StyleSheet: { create: value => value }, useWindowDimensions: () => ({ width: 400, height: 800 }) },
  '@expo/vector-icons': { Ionicons: 'Icon' },
  'lucide-react-native': Object.fromEntries(['Check', 'History', 'Pin', 'PinOff', 'Star', 'Sticker', 'TextSelect'].map(name => [name, name])),
  '@shared/theme': { useTheme: () => ({ mode: 'light', colors: { brand: { onPrimary: 'white' }, text: { primary: 'black' }, border: { strong: 'gray' } } }) },
});
let adds = 0;
let closes = 0;
for (const isAdded of [false, true]) {
  await renderer.act(async () => { rendered = renderer.create(React.createElement(Menu, { visible: true, onClose: () => closes++, onDelete: () => {},
    stickerAction: { isAdded, add: isAdded ? undefined : () => adds++ } })); });
  const button = rendered.root.findAllByType('Button').find(node => node.props.accessibilityLabel === (isAdded ? '已添加' : '添加表情包'));
  assert.ok(button);
  assert.equal(button.props.disabled, isAdded);
  if (!isAdded) {
    await renderer.act(async () => button.props.onPress());
    assert.equal(adds, 1);
    assert.equal(closes, 1);
  }
  await renderer.act(async () => rendered.unmount());
}
db.close();
console.log('verify-chat-sticker-collection: all assertions passed');
