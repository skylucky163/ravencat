/** 作品工具验证真实 SQLite 隔离、分页、收纳和名称／封面的原子编辑。 */
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { createChatMessageMutationFixture, load } from './helpers/chat-message-mutation-fixture.mjs';

const fixture = createChatMessageMutationFixture();
const { db, codePreviews, codeWorkDomain } = fixture;
const block = load('src/features/chat/messages/domain/ChatCodeBlock.ts');
const abort = load('src/shared/runtime/abortSignal.ts');
const copies = [], deleted = [], temporaryDeleted = [], viewed = [];
let copyNumber = 0, copyFails = false, viewMode = 'image', afterCrop = null, guardFails = false;
class ImageReadError extends Error {}
class CoordinatedDatabaseError extends Error {}
const application = load('src/features/chat/messages/application/ChatCodePreview.ts', {
  '@platform/persistence': fixture.persistence,
  '@platform/device': { getPersistentMediaRootUri: () => 'file:///media/' },
  '@platform/device/DeviceMediaService': {
    PERSISTENT_IMAGE_CATEGORY: { chatCodeCover: 'cover' }, getPersistentImageCategoryPrefix: () => 'covers/chat-code/',
    copyPickedImageToAppStorage: async ({ sourceUri, entityId }) => {
      if (copyFails) throw new ImageReadError('封面文件写入失败');
      const uri = `file:///media/covers/chat-code/${entityId}_${++copyNumber}.jpg`;
      copies.push({ sourceUri, uri }); return uri;
    },
    deleteManagedPersistentImageIfExists: async uri => { deleted.push(uri); },
  },
  '@shared/runtime/RuntimeSlot': load('src/shared/runtime/RuntimeSlot.ts'),
  '../domain/ChatCodeBlock': block, '../domain/ChatCodePreview': codeWorkDomain,
});
application.configureChatCodePreview(codePreviews);
const tools = load('src/host/composition/agent/ChatCodeWorkTools.ts', {
  'expo-file-system': { File: class { constructor(uri) { this.uri = uri; } delete() { temporaryDeleted.push(this.uri); } } },
  '@features/chat': { ...application, ...codeWorkDomain },
  '@features/media': {
    resolveMediaAsset: async id => { if (id === 'broken') throw new ImageReadError('找不到图片文件'); return { localUri: `file:///asset/${id}` }; },
    mediaImageFailure: error => error instanceof ImageReadError ? { status: 'error', code: 'IMAGE_UNREADABLE', retryable: false, modelContent: error.message } : null,
    viewImageSource: async (target, context) => {
      viewed.push(target.imageUri);
      if (viewMode === 'missing') throw new ImageReadError('保存的封面文件已丢失');
      if (viewMode === 'vision_error') return { status: 'error', code: 'IMAGE_VISION_UNAVAILABLE', retryable: false, modelContent: '所选视觉模型不可用' };
      return { status: 'success', data: {}, modelContent: '真实图片观察', modelImages: [{ url: 'data:image/jpeg;base64,REAL' }] };
    },
  },
  '@platform/device': { cropImageToAspect: async ({ sourceUri, aspect }) => {
    assert.deepEqual(aspect, [4, 3]);
    if (afterCrop) await afterCrop();
    return { uri: `file:///crop/${sourceUri.split('/').at(-1)}`, width: 1200, sourceWasAnimated: false };
  } },
  '@platform/persistence': { CoordinatedDatabaseError }, '@shared/runtime/abortSignal': abort,
  './assertImageToolRunCurrent': { assertImageToolRunCurrent: async (_tx, context) => {
    abort.throwIfAbortSignalAborted(context.abortSignal);
    if (guardFails) throw new Error('SUPERSEDED');
  } },
});
const context = (assistantId = 'self') => ({ task: { assistantId }, abortSignal: new AbortController().signal });
const run = (name, input, actor = 'self') => tools[name].execute(input, context(actor));
const success = result => { assert.equal(result.status, 'success', result.modelContent); return result.data; };
const failure = (result, text) => { assert.equal(result.status, 'error'); assert.match(result.modelContent, text); };

try {
  db.exec("CREATE TABLE ai_assistants (id TEXT PRIMARY KEY, agent_id TEXT UNIQUE); INSERT INTO ai_assistants VALUES ('self','agent-self'),('other','agent-other');");
  const source = '<title>原名</title>' + '甲'.repeat(4980) + '🙂'.repeat(5003) + '\r\n结尾  ';
  const save = (id, agentId = 'agent-self', text = source) => fixture.persistence.databaseCoordinator.transaction({}, tx => codePreviews.saveInTransaction(tx,
    { id, agentId, source: text, title: '原名', language: 'html', canRender: true, createdAt: '2026-11-12T00:00:00.000Z' }, null));
  await save('own'); await save('foreign', 'agent-other');
  const list = success(await run('ListCodeWorksTool', { scope: 'unsaved' }));
  assert.deepEqual(list.entries.map(item => item.id), ['own']);
  assert.equal('source' in list.entries[0], false, '列表不加载源码');
  assert.deepEqual(success(await run('ListCodeWorksTool', {})).entries, []);
  failure(await run('GetCodeWorkTool', { work_id: 'foreign' }), /未找到属于自己/);
  failure(await run('SetCodeWorkInLibraryTool', { work_id: 'foreign', included: true }), /未找到属于自己/);
  failure(await run('EditCodeWorkTool', { work_id: 'foreign', title: '篡改' }), /未找到属于自己/);
  failure(await run('EditCodeWorkTool', { work_id: 'foreign', media_asset_id: 'upload' }), /未找到属于自己/);
  assert.equal(deleted.at(-1), copies.at(-1).uri, '越权编辑不留下无引用封面');

  let reconstructed = '', page = 1;
  do {
    const data = success(await run('GetCodeWorkTool', { work_id: 'own', page }));
    assert.ok(Array.from(data.source).length <= 5000);
    assert.equal(data.cover.status, page === 1 ? 'missing' : 'not_requested');
    reconstructed += data.source; page = data.nextPage;
  } while (page !== null);
  assert.equal(reconstructed, source, '翻页保留中文、表情、CRLF 和尾部空白');
  failure(await run('GetCodeWorkTool', { work_id: 'own', page: 100 }), /页码/);
  assert.equal(viewed.length, 0, '缺失封面不另取替代图片');

  const saved = success(await run('SetCodeWorkInLibraryTool', { work_id: 'own', included: true }));
  assert.equal(saved.hasCover, false); assert.match(saved.message, /未执行截图/);
  const originalAddedAt = (await codePreviews.listLibrary('self'))[0].addedAt;
  success(await run('EditCodeWorkTool', { work_id: 'own', title: ' 新作品名 ', media_asset_id: 'upload' }));
  let work = await codePreviews.get('own');
  assert.equal(work.title, '新作品名'); assert.equal(work.source, source);
  const uploadedCover = work.coverFile;
  assert.equal(success(await run('SetCodeWorkInLibraryTool', { work_id: 'own', included: true })).hasCover, true);
  assert.equal((await codePreviews.get('own')).coverFile, uploadedCover, '重复加入不能清除上传封面');
  assert.equal((await codePreviews.listLibrary('self'))[0].addedAt, originalAddedAt);
  const observation = await run('GetCodeWorkTool', { work_id: 'own' });
  assert.equal(success(observation).cover.status, 'available');
  assert.equal(observation.modelImages[0].url, 'data:image/jpeg;base64,REAL');
  assert.equal(viewed.at(-1), application.chatCodeCoverUri(uploadedCover));
  const beforeRead = viewed.length;
  success(await run('GetCodeWorkTool', { work_id: 'own', include_cover: false }));
  assert.equal(viewed.length, beforeRead);
  viewMode = 'missing';
  const missing = await run('GetCodeWorkTool', { work_id: 'own' });
  assert.equal(success(missing).cover.status, 'unavailable'); assert.match(missing.modelContent, /已丢失/);
  assert.equal(missing.modelImages, undefined);
  viewMode = 'vision_error';
  const visionError = await run('GetCodeWorkTool', { work_id: 'own' });
  assert.equal(success(visionError).cover.status, 'unavailable'); assert.match(visionError.modelContent, /视觉模型不可用/);
  viewMode = 'image';

  failure(await run('EditCodeWorkTool', { work_id: 'own', title: '不应保存', media_asset_id: 'broken' }), /找不到图片/);
  assert.equal((await codePreviews.get('own')).title, '新作品名');
  copyFails = true;
  failure(await run('EditCodeWorkTool', { work_id: 'own', title: '仍不保存', media_asset_id: 'upload' }), /写入失败/);
  assert.equal((await codePreviews.get('own')).title, '新作品名');
  assert.equal((await codePreviews.get('own')).coverFile, uploadedCover);
  copyFails = false;
  guardFails = true;
  await assert.rejects(run('EditCodeWorkTool', { work_id: 'own', title: '被取消', media_asset_id: 'late' }), /SUPERSEDED/);
  assert.equal(deleted.at(-1), copies.at(-1).uri, '事务拒绝清理刚落盘的封面');
  assert.equal((await codePreviews.get('own')).title, '新作品名');
  guardFails = false;

  afterCrop = () => application.setOwnChatCodeInLibrary('own', false, { assistantId: 'self', assertCurrent: async () => {} });
  failure(await run('EditCodeWorkTool', { work_id: 'own', title: '竞态不提交', media_asset_id: 'racing' }), /先加入作品库/);
  assert.equal((await codePreviews.get('own')).title, '新作品名');
  assert.equal((await codePreviews.get('own')).source, source);
  assert.equal(deleted.at(-1), copies.at(-1).uri);
  assert.equal(temporaryDeleted.at(-1), 'file:///crop/racing');
  afterCrop = null;
  success(await run('EditCodeWorkTool', { work_id: 'own', title: '未入库也可改名' }));
  assert.equal((await codePreviews.get('own')).title, '未入库也可改名');
  assert.deepEqual(success(await run('ListCodeWorksTool', { scope: 'unsaved' })).entries.map(item => item.id), ['own']);
  success(await run('SetCodeWorkInLibraryTool', { work_id: 'own', included: true }));
  assert.equal((await codePreviews.get('own')).id, 'own');

  for (let index = 0; index < 24; index++) await save(`page-${String(index).padStart(2, '0')}`);
  const first = success(await run('ListCodeWorksTool', { scope: 'all' }));
  const second = success(await run('ListCodeWorksTool', { scope: 'all', offset: first.nextOffset }));
  assert.equal(first.entries.length, 20); assert.equal(second.entries.length, 5);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(item => item.id)).size, 25);
  const validate = new Ajv({ strict: false }).compile(tools.EditCodeWorkTool.definition.parameters);
  assert.equal(validate({ work_id: 'own' }), false);
  assert.equal(validate({ work_id: 'own', title: '   ' }), false);
  assert.equal(validate({ work_id: 'own', title: '名字' }), true);
  assert.equal(validate({ work_id: 'own', media_asset_id: 'upload' }), true);
  assert.equal(validate({ work_id: 'own', title: '名字', media_asset_id: 'upload' }), true);

  const message = { id: 7, clientMessageId: 'own', text: '```html\n' + source + '\n```', senderType: 'assistant', status: 'sent' };
  const reference = block.buildChatCodeWorkReference(message);
  assert.match(reference, /"id":"own"/); assert.match(reference, /get_code_work/);
  assert.equal(reference.includes('甲甲甲'), false);
  assert.equal(block.buildChatCodeWorkReference({ ...message, senderType: 'user' }), null);
  assert.equal(block.buildChatCodeWorkReference({ ...message, status: 'streaming' }), null);
  assert.equal(block.buildChatCodeWorkReference({ ...message, text: '```html\n未闭合' }), null);
  const summary = load('src/features/chat/summary/domain/ChatContext.ts', {
    '../../messages/domain/ChatCodeBlock': block, '../../messages/domain/chatMessageMetadata': fixture.metadata,
    '../../messages/domain/ChatSticker': load('src/features/chat/messages/domain/ChatSticker.ts'),
    '../../messages/domain/SharedChatRecord': {}, '../../messages/domain/SharedMoment': {},
  });
  const projected = summary.projectChatContextMessage({ ...message, createdAt: '2026-11-12', isMe: false }, ['2026-11-12', 7, 0, 7]);
  assert.equal(projected.content, reference, '摘要及跨会话上下文使用同一作品引用');
  const history = load('src/host/prompt/PromptHistoryBuilder.ts', { '@features/chat': {
    ...fixture.metadata, buildChatCodeWorkReference: block.buildChatCodeWorkReference,
  } });
  const modelText = await new history.PromptHistoryBuilder().buildRuntimeMessageContent(message, false, {}, 'self', 'agent-self');
  assert.equal(modelText, reference, '原文窗口不再携带整份网页源码');
  console.log('作品工具验证通过：作者隔离、列表／源码分页、真实封面观察、明确缺失、原子编辑、事务取消、并发移出、稳定 ID 与上下文引用。');
} finally { db.close(); }
