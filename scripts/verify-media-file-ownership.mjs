import { chatReplyVersionSql, chatMessageMutations } from './chat-timeline-fixture.mjs';
/** 媒体文件所有权：备份持有、草稿退出、提交失败与 legacy 恢复重定位的行为回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
function load(relative, mocks = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((specifier) => {
    if (specifier === '@shared/errors/SettingChangeConflictError') return load('src/shared/errors/SettingChangeConflictError.ts');
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    if (specifier.startsWith('.')) return load(path.relative(root, path.resolve(root, path.dirname(relative), `${specifier}.ts`)), mocks);
    throw new Error(`未声明的依赖：${specifier}`);
  }, module, module.exports);
  return module.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

// 真实 Store 删除必须等到备份读取完成；备份失败也会释放持有。
const lifetime = load('src/platform/device/MediaFileLifetime.ts');
const files = new Set(['file:///documents/persistent-media/catalog/media/live.png']);
const deviceMocks = {
  './MediaFileLifetime': lifetime,
  'expo-file-system/legacy': {
    documentDirectory: 'file:///documents/',
    getInfoAsync: async (uri) => ({ exists: files.has(uri) || [...files].some((file) => file.startsWith(uri)), isDirectory: uri.endsWith('/'), uri }),
    readDirectoryAsync: async (uri) => [...files].filter((file) => file.startsWith(uri)).map((file) => file.slice(uri.length)),
    deleteAsync: async (uri) => { files.delete(uri); },
  },
};
const mediaStore = load('src/platform/device/PersistentMediaStore.ts', deviceMocks);
const imageStore = load('src/platform/device/PersistentImageStore.ts', deviceMocks);
const gate = deferred();
const liveUri = [...files][0];
const backup = lifetime.withMediaFileLifetime(async () => { await gate.promise; assert.ok(files.has(liveUri)); });
await tick();
const deletion = mediaStore.persistentMediaStore.deleteAssetStorageKey('catalog/media/live.png');
await tick();
assert.ok(files.has(liveUri), '备份读取期间已提交媒体不得被物理删除');
gate.resolve(); await backup; await deletion;
assert.equal(files.has(liveUri), false);
await assert.rejects(lifetime.withMediaFileLifetime(async () => { throw new Error('archive failed'); }), /archive failed/);
await lifetime.withMediaFileLifetime(async () => {});

// 快照清理只能触碰 Calls 的平面目录，SQLite 中的错误地址不能扩大删除范围。
const snapshotUri = 'file:///documents/persistent-media/calls/snapshots/frame.jpg';
files.add(snapshotUri);
await mediaStore.persistentMediaStore.deleteCategoryFileIfExists(snapshotUri, 'callSnapshot');
assert.equal(files.has(snapshotUri), false);
for (const uri of [liveUri, 'file:///documents/persistent-media/calls/snapshots/../../outside.jpg', 'file:///documents/persistent-media/calls/snapshots/%2e%2e.jpg']) {
  await assert.rejects(mediaStore.persistentMediaStore.deleteCategoryFileIfExists(uri, 'callSnapshot'));
}

const currentSnapshotUri = 'file:///documents/persistent-media/calls/snapshots/current-frame.jpg';
files.add(snapshotUri); files.add(currentSnapshotUri); files.add(liveUri);
await mediaStore.persistentMediaStore.deleteCategoryFilesExceptPrefix('callSnapshot', 'current-');
assert.equal(files.has(snapshotUri), false, '回收没有 SQLite 记录的快照');
assert.ok(files.has(currentSnapshotUri), '保留当前运行实例的帧');
assert.ok(files.has(liveUri), '目录清理不影响长期资产');
files.delete(currentSnapshotUri); files.delete(liveUri);

// 最小 Hook 宿主只模拟 React 状态与 effect 生命周期，调用的是产品 Hook 的真实行为。
function hookHost() {
  const slots = []; let cursor = 0; let pending = [];
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      const slot = slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) {
        const previous = slots[index]; const slot = { deps }; slots[index] = slot;
        pending.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
      }
    },
  };
  return {
    react,
    render(hook) { cursor = 0; pending = []; const result = hook(); pending.forEach((effect) => effect()); return result; },
    unmount() { slots.forEach((slot) => slot.cleanup?.()); },
  };
}
{
  const host = hookHost(); const drafts = new Set(); let sequence = 0; let pendingCopy = null;
  const draftFiles = load('src/features/chat/presentation/messages/ChatDetail/ChatAttachmentDraftFiles.ts', {
    '@platform/device/DeviceMediaService': { deletePersistentMediaIfExists: async (uri) => { drafts.delete(uri); } },
  });
  const picked = { uri: 'content://picked', fileName: 'picked.png', mimeType: 'image/png', source: 'gallery' };
  let pickedImages = [picked];
  let failCopy = null;
  const { useAttachmentDraft } = load('src/features/chat/presentation/messages/ChatDetail/useAttachmentDraft.ts', {
    react: host.react,
    './ChatAttachmentDraftFiles': draftFiles,
    '../../../messages/application/AttachmentParser': { attachmentParser: {}, assertChatAttachmentFileSupported() {} },
    '@features/chat/messages/domain': load('src/features/chat/messages/domain/ChatAttachment.ts'),
    '@platform/device/DeviceMediaService': {
      PERSISTENT_MEDIA_CATEGORY: mediaStore.PERSISTENT_MEDIA_CATEGORY,
      pickChatImagesFromDevice: async (limit) => { assert.equal(limit, 9); return pickedImages; },
      deletePersistentMediaIfExists: async (uri) => { drafts.delete(uri); },
      persistDeviceMedia: async ({ sourceUri }) => {
        if (sourceUri === failCopy) throw new Error('图片复制失败');
        const uri = `file:///draft-${++sequence}.png`; drafts.add(uri);
        if (pendingCopy) await pendingCopy.promise;
        return uri;
      },
    },
  });
  const render = () => host.render(useAttachmentDraft);
  let draft = render(); await draft.selectImageAttachment(); draft = render();
  const uri = draft.readyAttachments[0].localUri;
  const first = deferred(); const second = deferred();
  const sendingFirst = draft.withAttachmentSubmission(async (_attachments, consumeDraft) => { await first.promise; consumeDraft(); });
  const sendingSecond = draft.withAttachmentSubmission(async (_attachments, consumeDraft) => { await second.promise; consumeDraft(); });
  draft.clearAttachment(); await tick();
  assert.ok(drafts.has(uri), '移除正在发送的草稿只撤销展示，不抢删源文件');
  first.resolve(); await sendingFirst;
  assert.ok(drafts.has(uri), '同一草稿还有一个发送者持有源文件');
  second.resolve(); await sendingSecond; await tick();
  assert.equal(drafts.has(uri), false);
  await draft.selectImageAttachment(); draft = render();
  await assert.rejects(draft.withAttachmentSubmission(async () => { throw new Error('send failed'); }), /send failed/);
  assert.ok(drafts.has(draft.readyAttachments[0].localUri), '提交失败后保留当前草稿供重试');
  await draft.selectImageAttachment(); draft = render();
  assert.equal(drafts.size, 1, '替换草稿回收旧副本');
  const oldUri = draft.readyAttachments[0].localUri;
  const sendGate = deferred();
  const oldSend = draft.withAttachmentSubmission(async (_attachments, consumeDraft) => { await sendGate.promise; consumeDraft(); });
  await draft.selectImageAttachment(); draft = render();
  const newUri = draft.readyAttachments[0].localUri;
  sendGate.resolve(); await oldSend; await tick();
  assert.equal(drafts.has(oldUri), false);
  assert.ok(drafts.has(newUri), '旧发送完成不能清空用户后来选择的新附件');
  assert.equal(render().readyAttachments[0].localUri, newUri);

  // 多图共享一次提交，移除和取消只影响对应草稿。
  pickedImages = Array.from({ length: 9 }, (_, index) => ({ ...picked, uri: `content://picked-${index}`, fileName: `${index}.png` }));
  await draft.selectImageAttachment(); draft = render();
  assert.equal(draft.readyAttachments.length, 9);
  assert.deepEqual(draft.readyAttachments.map(item => item.fileName), pickedImages.map(item => item.fileName));
  const removed = draft.readyAttachments[4];
  draft.removeAttachment(removed.id); draft = render(); await tick();
  assert.equal(draft.readyAttachments.length, 8);
  assert.equal(drafts.has(removed.localUri), false, '逐张移除只释放对应文件');
  assert.equal(drafts.size, 8);
  pickedImages = null;
  assert.equal(await draft.selectImageAttachment(), false);
  assert.equal(render().readyAttachments.length, 8, '取消重选保留整批已有草稿');
  let submissions = 0;
  await draft.withAttachmentSubmission(async (attachments, consumeDraft) => {
    submissions++;
    assert.equal(attachments.length, 8, '剩余图片通过一次提交交接');
    consumeDraft();
    return true;
  });
  assert.equal(submissions, 1);
  assert.equal(render().draftAttachments.length, 0);
  assert.equal(drafts.size, 0);

  pickedImages = [picked, { ...picked, uri: 'content://bad', fileName: 'bad.png' }];
  failCopy = 'content://bad';
  await assert.rejects(draft.selectImageAttachment(), /图片复制失败/); draft = render();
  assert.equal(draft.readyAttachments.length, 1, '单张处理失败不丢弃其他图片');
  assert.equal(draft.hasFailedAttachment, true);
  draft.removeAttachment(draft.draftAttachments.find(item => item.status === 'failed').id);
  assert.equal(render().hasFailedAttachment, false);
  failCopy = null;

  pickedImages = [picked, { ...picked, uri: 'content://second', fileName: 'second.png' }];
  await draft.selectImageAttachment(); draft = render();
  const batchSendGate = deferred();
  const sendingBatch = draft.withAttachmentSubmission(async (attachments, consumeDraft) => {
    assert.equal(attachments.length, 2);
    await batchSendGate.promise;
    assert.ok(attachments.every(item => drafts.has(item.localUri)), '整批发送完成前每张源文件都仍可读取');
    consumeDraft();
    return true;
  });
  draft.removeAttachment(draft.draftAttachments[0].id);
  batchSendGate.resolve(); await sendingBatch; await tick(); draft = render();
  assert.equal(draft.draftAttachments.length, 0, '提交期间单张移除不能让其余已发送草稿留在输入区');
  assert.equal(drafts.size, 0);

  pendingCopy = deferred();
  const pendingBatch = draft.selectImageAttachment(); await tick(); draft = render();
  const pendingRemoved = draft.draftAttachments[0];
  draft.removeAttachment(pendingRemoved.id);
  pendingCopy.resolve(); await pendingBatch; await tick(); draft = render();
  assert.equal(draft.readyAttachments.length, 1, '准备途中移除一张不取消其余图片');
  assert.equal(drafts.size, 1, '迟到的已移除图片副本被释放');
  pendingCopy = deferred(); const selecting = draft.selectImageAttachment(); await tick();
  host.unmount(); pendingCopy.resolve(); await selecting; await tick();
  assert.equal(drafts.size, 0, '退出页面后迟到的复制结果也必须释放');
}

// 失败气泡接管源文件并可独立重试；关闭页面也不抢删重试正在读取的文件。
{
  const host = hookHost(); const files = new Set(['file:///failed-draft.png']);
  const draftFiles = load('src/features/chat/presentation/messages/ChatDetail/ChatAttachmentDraftFiles.ts', {
    '@platform/device/DeviceMediaService': { deletePersistentMediaIfExists: async (uri) => { files.delete(uri); } },
  });
  const attachment = { id: 'image', type: 'image', source: 'gallery', localUri: [...files][0], fileName: 'image.png' };
  const releaseInput = draftFiles.ownChatAttachmentDraftFile(attachment.localUri);
  let messages = []; let retryGate = null;
  const { useChatSendFlow } = load('src/features/chat/presentation/messages/ChatDetail/useChatSendFlow.ts', {
    react: host.react, './ChatAttachmentDraftFiles': draftFiles,
    '@shared/ui': { showAppDialog() {} },
    '../../../messages/application/MessageTimeline': { messageTimeline: {
      createOptimisticUserMessages: ({ attachments }) => [{ id: -1, isMe: true, status: 'pending', text: '', metadataJson: JSON.stringify({ attachments }) }],
      mergeMessages: (_previous, next) => ({ messages: next, changed: true, lastMessageId: next.at(-1).id }),
    } },
    '../../../messages/application/SendUserMessage': { sendUserMessage: async () => {
      if (!retryGate) return { userMessage: null, userMessages: [], success: false, error: 'commit failed' };
      await retryGate.promise;
      assert.ok(files.has(attachment.localUri), '重试结束前源文件仍可读取');
      const message = { id: 1, isMe: true, text: '', metadataJson: JSON.stringify({ attachments: [{ mediaAssetId: 'canonical' }] }) };
      return { userMessage: message, userMessages: [message], success: true };
    } },
    '../../../conversation/application/ChatCallGateway': { getActiveChatCall: () => null, isChatSendBlockedByCall: () => false },
    '../../../conversation/application/ChatTogetherListeningGateway': {},
    '../../../messages/application/UserVoiceMessageRecording': {},
  });
  const render = () => host.render(() => useChatSendFlow({
    sessionId: 'chat', aiAssistant: { id: 'ai' }, aiRequestConfig: { id: 'ai' }, messages,
    setMessages: (next) => { messages = typeof next === 'function' ? next(messages) : next; },
    setError() {}, setIsTyping() {}, lastMessageIdRef: { current: null },
  }));
  let flow = render(); await flow.sendMessage('', null, [attachment]);
  releaseInput(); await tick();
  assert.ok(files.has(attachment.localUri), '输入草稿清除后失败气泡仍持有可重试源');
  flow = render(); retryGate = deferred();
  const retry = flow.retrySend(-1); await tick(); host.unmount(); await tick();
  assert.ok(files.has(attachment.localUri));
  retryGate.resolve(); await retry; await tick();
  assert.equal(files.size, 0, '重试完成后没有草稿或失败气泡时释放源');
}
{
  const host = hookHost(); const drafts = new Set(); let sequence = 0;
  const { usePersistentAvatarDraft } = load('src/platform/device/usePersistentAvatarDraft.ts', {
    react: host.react,
    'react-native': { Dimensions: { get: () => ({ width: 360, height: 800, scale: 3 }) } },
    'expo-image-picker': {
      requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'content://avatar', fileName: 'avatar.png', mimeType: 'image/png' }] }),
    },
    './PersistentImageStore': {
      persistentImageStore: {
        copyPickedImageToAppStorage: async () => { const uri = `file:///avatar-draft-${++sequence}.png`; drafts.add(uri); return uri; },
        deleteManagedIfExists: async (uri) => { drafts.delete(uri); },
      },
    },
  });
  const render = () => host.render(() => usePersistentAvatarDraft({ category: 'userAvatar', entityId: 'self', committedUri: null }));
  let avatar = render(); await avatar.pickAvatar(); avatar = render();
  await avatar.commitAvatar(async () => ({ avatar: 'file:///canonical/avatar.png' }), (result) => result.avatar);
  assert.equal(drafts.size, 0, 'canonical 接管后回收 picker 的持久草稿副本');
  assert.equal(render().avatarUri, 'file:///canonical/avatar.png');
  await avatar.pickAvatar(); avatar = render();
  await assert.rejects(avatar.commitAvatar(async () => { throw new Error('CAS failed'); }), /CAS failed/);
  assert.equal(drafts.size, 1, '头像提交失败保留草稿');
  const committing = deferred();
  const commit = avatar.commitAvatar(async () => { await committing.promise; return { avatar: 'file:///canonical/new.png' }; }, (result) => result.avatar);
  host.unmount(); assert.equal(drafts.size, 1, '卸载不抢删提交中的头像源');
  committing.resolve(); await commit;
  assert.equal(drafts.size, 0);
}

// Host 的真实恢复装配 + owner 的真实 SQLite 更新：跨根、幂等、旧包与失败回滚。
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE user_profile (id TEXT PRIMARY KEY, avatar TEXT, avatar_media_asset_id TEXT);
  CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, avatar TEXT, avatar_media_asset_id TEXT);
  CREATE TABLE group_chats (id TEXT PRIMARY KEY, avatar TEXT, avatar_media_asset_id TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY, metadata_json TEXT);
`);
const executor = {
  getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
  runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
};
const persistence = { databaseCoordinator: {
  async transaction(_metadata, work) {
    db.exec('BEGIN');
    try { const result = await work(executor); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
} };
const ownerMocks = {
  './ChatMessageMutationSql': chatMessageMutations,
      '../../reply/infrastructure/ChatReplyVersionSql': chatReplyVersionSql,
  './SQLiteAuxiliaryModelDefaults': {}, './SQLiteAuxiliaryModelRepository': {},
  '@platform/persistence': persistence, '@features/media': {}, '@features/profile': {},
  '@features/assistants': { bindModelServiceInTransaction: async () => {}, readModelServiceConnection: async () => null, getModelServiceConnection: async () => null },
  '@shared': { SELF_USER_ID: 'self', DEFAULT_SELF_NAME: 'user' },
  '@shared/runtime/RuntimeSlot': load('src/shared/runtime/RuntimeSlot.ts'),
  '../domain/AIProfile': {},
};
const profile = load('src/features/profile/infrastructure/SQLiteUserProfileRepository.ts', ownerMocks);
const ai = load('src/features/assistants/infrastructure/SQLiteAssistantRepository.ts', ownerMocks);
const group = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts', ownerMocks);
const message = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts', ownerMocks);
const settings = load('src/features/backup/infrastructure/stableSettingsBackupState.ts');
const rebase = load('src/host/media/RebaseRestoredLegacyMedia.ts', {
  '@features/backup/composition': settings,
  '@features/profile/composition': profile,
  '@features/assistants/composition': ai,
  '@features/chat/composition': { ...group, ...message },
  '@platform/persistence': persistence,
  '@platform/device': { ...imageStore, ...mediaStore, ...load('src/platform/device/RebaseLegacyMediaReference.ts') },
});
const sourceRoot = 'file:///old-install/files/persistent-media/';
const targetRoot = 'file:///documents/persistent-media/';
const imagePath = (category) => imageStore.getPersistentImageCategoryPrefix(category) + 'photo.png';
const mediaPath = (category) => mediaStore.getPersistentMediaCategoryPrefix(category) + 'attachment.png';
db.prepare('INSERT INTO user_profile VALUES (?, ?, ?)').run('self', sourceRoot + imagePath('userAvatar'), null);
db.prepare('INSERT INTO ai_assistants VALUES (?, ?, NULL)').run('ai', sourceRoot + imagePath('aiAvatar'));
db.prepare('INSERT INTO group_chats VALUES (?, ?, NULL)').run('group', sourceRoot + imagePath('groupAvatar'));
const legacy = { localUri: sourceRoot + mediaPath('chatImage'), thumbnailUri: sourceRoot + mediaPath('chatImage'), fileName: 'x.png', parsedText: '正文保持' };
const canonical = { mediaAssetId: 'stable-id', fileName: 'stable.png' };
const external = { localUri: 'https://example.test/photo.png' };
db.prepare('INSERT INTO messages VALUES (?, ?)').run(1, JSON.stringify({ attachments: [legacy, canonical, external], custom: '保持' }));
db.prepare('INSERT INTO messages VALUES (?, ?)').run(2, 'null');
const backupSettings = {
  schemaVersion: 5, legacyMediaRootUri: sourceRoot, theme: {},
  wallpaper: { appWallpaper: { mode: 'default', storageKey: null }, chatWallpaper: { mode: 'default', storageKey: null }, chatWallpaperOverrides: {} },
  call: { backgroundStorageKey: null }, bubbleSkins: {},
};
const oldPackage = { ...backupSettings }; delete oldPackage.legacyMediaRootUri;
await assert.rejects(rebase.rebaseRestoredLegacyMedia(JSON.stringify(oldPackage)), /来源长期媒体根无效/);
await rebase.rebaseRestoredLegacyMedia(JSON.stringify(backupSettings));
for (const table of ['user_profile', 'ai_assistants', 'group_chats']) assert.ok(db.prepare(`SELECT avatar FROM ${table}`).get().avatar.startsWith(targetRoot));
const restored = JSON.parse(db.prepare('SELECT metadata_json FROM messages WHERE id = 1').get().metadata_json);
assert.equal(restored.attachments[0].localUri, targetRoot + mediaPath('chatImage'));
assert.equal(restored.attachments[0].thumbnailUri, targetRoot + mediaPath('chatImage'));
assert.equal(restored.attachments[0].parsedText, '正文保持');
assert.deepEqual(restored.attachments[1], canonical); assert.deepEqual(restored.attachments[2], external);
await rebase.rebaseRestoredLegacyMedia(JSON.stringify(backupSettings));
db.prepare('UPDATE user_profile SET avatar = ?').run(sourceRoot + imagePath('userAvatar'));
db.prepare('UPDATE group_chats SET avatar = ?').run(sourceRoot + '../outside.png');
await assert.rejects(rebase.rebaseRestoredLegacyMedia(JSON.stringify(backupSettings)));
assert.ok(db.prepare('SELECT avatar FROM user_profile').get().avatar.startsWith(sourceRoot), '非法 owner 路径让整次重定位事务回滚');
assert.throws(() => settings.parseStableSettingsBackupJson(JSON.stringify({ ...backupSettings, legacyMediaRootUri: 'file:///old/../persistent-media/' })));
db.close();
console.log('媒体备份持有、聊天/头像草稿释放与跨安装根恢复重定位验证通过。');
