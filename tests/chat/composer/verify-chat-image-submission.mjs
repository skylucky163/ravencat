/** 图文一次发送的持久事实、回合触发、乐观替换与预览几何回归。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import { loadTypeScriptModule } from '../../helpers/load-typescript-module.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';


const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE messages (id INTEGER PRIMARY KEY, client_id TEXT, payload TEXT NOT NULL);
  CREATE TABLE turn_state (revision INTEGER NOT NULL, active_run TEXT);
  INSERT INTO turn_state VALUES (0, 'old-run');
`);
const rows = () => db.prepare('SELECT id, payload FROM messages ORDER BY id').all()
  .map((row) => ({ ...JSON.parse(row.payload), id: row.id }));
const state = { transactions: 0, writes: 0, failAt: null, dispatches: 0, failHost: false, previews: [], scheduled: [], rotations: 0 };
const runtime = {
  turnPresentation: { freeze: async () => async () => {}, interrupt: async () => {} },
  assistantDirectory: { getBlockState: async () => ({ isBlocked: false }) },
  messages: {
    async commitMessageInTransaction(_transaction, { message, previewText }) {
      state.writes += 1;
      if (state.writes === state.failAt) throw new Error('write failed');
      const result = db.prepare('INSERT INTO messages (client_id, payload) VALUES (?, ?)')
        .run(message.clientMessageId, JSON.stringify(message));
      state.previews.push(previewText);
      return { ...message, id: Number(result.lastInsertRowid) };
    },
  },
  turns: {
    async setReplyRequestedInTransaction() {},
    async ensureTurnStateRowInTransaction() {},
    async supersedeActiveRunInTransaction() {
      const previous = db.prepare('SELECT active_run FROM turn_state').get().active_run;
      db.exec('UPDATE turn_state SET revision = revision + 1, active_run = NULL');
      return previous;
    },
  },
  canonicalUserMessage: {
    async onCommitted({ message }) {
      state.dispatches += 1;
      assert.equal(rows().at(-1).id, message.id, '宿主触发时必须已看见整批尾消息');
      if (state.failHost) throw new Error('host unavailable');
    },
  },
};
const groupRuntime = {
  currentUserDirectory: { getCurrent: async () => ({ name: '枫渡' }) },
  groups: {
    async rotateSpeechPlanForUserMessageInTransaction(_transaction, { userMessageId }) {
      state.rotations += 1;
      assert.equal(rows().at(-1).id, userMessageId, '群计划换代使用完整批次的尾消息');
      return { kind: 'no_active_plan' };
    },
    async updatePreviewInTransaction() {},
  },
};
const boundaries = {
  '@features/media': {
    mediaImageFailure: () => null,
    MEDIA_ASSET_STORAGE_BACKEND: { persistentMedia: 'persistent-media' },
    async prepareMediaAssetBatch(inputs) {
      const assets = inputs.map((input) => ({ id: `media-${input.fileName}` }));
      return {
        commitInTransaction: async () => ({ assets }),
        finalizeAfterCommit: async () => { state.finalized = (state.finalized ?? 0) + 1; },
        discardAfterRollback: async () => { state.discarded = (state.discarded ?? 0) + 1; },
      };
    },
  },
  'expo-crypto': { randomUUID },
  '@platform/persistence': {
    databaseCoordinator: {
      async transaction(_meta, task) {
        state.transactions += 1;
        db.exec('BEGIN');
        try {
          const value = await task({});
          db.exec('COMMIT');
          return value;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  },
  '@features/stickers': { recordUserStickerUse: async () => {} },
  '@shared/diagnostics/TurnTimelineLog': { logTurnTimeline() {} },
};
const cached = new Map();
function load(relativePath) {
  const filename = path.resolve(root, relativePath);
  if (cached.has(filename)) return cached.get(filename);
  const module = { exports: {} };
  cached.set(filename, module.exports);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const requireModule = (specifier) => {
    if (boundaries[specifier]) return boundaries[specifier];
    if (specifier === '@shared/prompt') return load('src/shared/prompt/messageTimestamp.ts');
    if (specifier === './ChatTurnPresentationRuntime') return { getChatInterruptedTurnContext: async () => [] };
    if (specifier === './ChatReplyRuntimeDependencies') return { getChatReplyRuntimeDependencies: () => ({ prompt: { readImageGroundingReminder: async () => null } }) };
    if (specifier === '@features/chat/messages/domain') return {
      ...load('src/features/chat/messages/domain/chatMessageMetadata.ts'),
      ...load('src/features/chat/messages/domain/ChatSticker.ts'),
    };
    if (specifier.endsWith('/ChatMessageRuntime') || specifier === './ChatMessageRuntime') {
      return { getChatMessageRuntimeDependencies: () => runtime };
    }
    if (specifier.endsWith('/AgentTransientTimeline')) return { clearAgentTransientTimelineRun() {} };
    if (specifier.endsWith('/ChatEvents')) return { emitChatMessagesUpdated() {}, emitChatTurnExecutionChanged() {}, emitChatGroupSpeechPlanChanged() {}, setChatEventBus() {} };
    if (specifier === './ChatGroupRuntime') return { getChatGroupRuntimeDependencies: () => groupRuntime };
    if (specifier === './GroupAutoInvocationScheduler') return { scheduleGroupAutoInvocation: (input) => state.scheduled.push(input) };
    if (specifier === './GroupChatMessaging') return { invokeGroupChat() {} };
    if (specifier === './GroupSpeechExecutionAbort') return { abortGroupSpeechPlanExecution() {} };
    if (specifier === './ResolveChatImageModelInput') return {
      resolveChatImageModelInput: async ({ imageUri }) => ({ parts: [{ type: 'image_url', image_url: { url: imageUri } }] }),
    };
    if (specifier.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), `${specifier}.ts`)));
    throw new Error(`未预期的边界：${specifier}`);
  };
  vm.runInThisContext(`(function(require, module, exports) { ${code}\n})`, { filename })(requireModule, module, module.exports);
  return module.exports;
}

const { sendUserMessage } = load('src/features/chat/messages/application/SendUserMessage.ts');
const { sendGroupUserMessage } = load('src/features/chat/group/application/GroupUserMessaging.ts');
const timeline = load('src/features/chat/messages/application/MessageTimeline.ts');
const { splitUserMessageSubmission } = load('src/features/chat/messages/application/UserMessageSubmission.ts');
const { buildChatTurnAIInput } = load('src/features/chat/reply/application/BuildChatTurnAIInput.ts');
const metadata = load('src/features/chat/messages/domain/chatMessageMetadata.ts');
const { buildChatUserMessageModelInput } = load('src/features/chat/reply/application/BuildChatBatchAIInput.ts');
const { projectChatContextMessage } = load('src/features/chat/summary/domain/ChatContext.ts');
const { fitPreviewImage, clampPreviewOffset } = load('src/shared/ui/imageViewer/imagePreviewGeometry.ts');
const image = { id: 'image-1', type: 'image', source: 'gallery', localUri: 'file:///cat.png', fileName: 'cat.png' };
const anotherImage = { ...image, id: 'image-2' };
const file = { ...image, id: 'file-1', type: 'file', fileName: 'notes.txt' };
const params = { sessionId: 's1', text: '看看这两张', attachments: [image, anotherImage], clientMessageId: 'send-1', replyToId: 7, replyToText: '上一条' };
const optimistic = timeline.createOptimisticUserTimelineMessages({ ...params, tempId: 10000, showTimeSeparatorBefore: true });
const result = await sendUserMessage(params, { id: 'ai-1' });
assert.equal(result.success, true);
assert.equal(state.transactions, 1);
assert.equal(state.dispatches, 1);
assert.equal(db.prepare('SELECT revision FROM turn_state').get().revision, 1, '同次发送只换代一次');
assert.deepEqual(result.userMessages.map((message) => message.text), ['', '', params.text]);
assert.ok(result.userMessage.logicalMessageId);
assert.equal(new Set(result.userMessages.map((message) => message.logicalMessageId)).size, 1, '同次图文发送共享逻辑消息身份');
const canonical = ({ localUri, thumbnailUri, ...attachment }) => ({ ...attachment, mediaAssetId: `media-${attachment.fileName}` });
assert.deepEqual(result.userMessages.slice(0, 2).map((message) => JSON.parse(message.metadataJson).attachments), [[canonical(image)], [canonical(anotherImage)]]);
assert.equal(JSON.parse(result.userMessage.metadataJson).attachments, undefined, '文字消息不再包含图片');
assert.deepEqual(result.userMessages.map((message) => message.replyToId), [null, null, 7]);
assert.deepEqual(optimistic.map((message) => message.clientMessageId), result.userMessages.map((message) => message.clientMessageId));
assert.deepEqual(optimistic.map((message) => message.showTimeSeparatorBefore), [true, false, false]);
const merged = timeline.mergeTimelineMessages(optimistic, result.userMessages);
assert.equal(merged.messages.length, 3, '所有乐观消息都应被替换，不残留重复气泡');
assert.ok(merged.messages.every((message) => message.status === 'sent'));
const modelInput = await buildChatTurnAIInput({
  repository: { listUserMessagesInRange: async () => result.userMessages },
  sessionId: 's1', replyCursorAtClaim: 0, inputHighWatermark: result.userMessage.id, assistantId: 'ai-1',
});
assert.equal(modelInput.turnInputMessages.length, 3, '同一回合模型输入同时包含图片和文字');
for (const [index, message] of modelInput.turnInputMessages.entries()) {
  assert.equal(message.createdAt, modelInput.userMessages[index].createdAt, '本轮输入将原时间与正文分开传递');
}
assert.ok(modelInput.turnInputMessages.slice(0, 2).every((message) => message.content.some((part) => part.type === 'image_url')));
assert.match(modelInput.turnInputMessages[2].content, /看看这两张/);

const countBeforeRetry = rows().length;
const retry = await sendUserMessage({ sessionId: 's1', text: '', attachments: [image], clientMessageId: 'failed-send:image:image-1' }, { id: 'ai-1' });
assert.equal(rows().length, countBeforeRetry + 1, '独立重发只提交选中的图片');
assert.equal(retry.userMessage.clientMessageId, 'failed-send:image:image-1', '重发沿用失败乐观消息的身份');
assert.equal(retry.userMessage.logicalMessageId, null, '独立重发的单张图片是一条独立消息');
assert.equal(splitUserMessageSubmission({ text: '文件说明', attachments: [file] }).length, 1, '文件图文语义不拆分');

const beforeFailure = rows();
const revisionBeforeFailure = db.prepare('SELECT revision FROM turn_state').get().revision;
const dispatchesBeforeFailure = state.dispatches;
state.failAt = state.writes + 2;
const failed = await sendUserMessage({ ...params, clientMessageId: 'send-failed' }, { id: 'ai-1' });
assert.equal(failed.success, false);
assert.deepEqual(failed.userMessages, []);
assert.deepEqual(rows(), beforeFailure, '中途写入失败必须回滚整组图文');
assert.equal(db.prepare('SELECT revision FROM turn_state').get().revision, revisionBeforeFailure);
assert.equal(state.dispatches, dispatchesBeforeFailure, '回滚后不得触发 AI');
assert.equal(state.discarded, 1, '事务失败必须回收未提交的媒体 batch');
state.failAt = null;
state.failHost = true;
const hostFailed = await sendUserMessage({ ...params, clientMessageId: 'send-host-failed' }, { id: 'ai-1' });
assert.equal(hostFailed.success, false);
assert.equal(hostFailed.userMessages.length, 3, '宿主失败仍返回全部已提交事实');
assert.equal(rows().length, beforeFailure.length + 3);
assert.equal(state.finalized, 3, '提交后宿主失败仍须将 backing 交给消息事实');
state.failHost = false;

const groupStart = rows().length;
const transactionsBeforeGroup = state.transactions;
const groupTail = await sendGroupUserMessage({ groupId: 'g1', text: '一起看', attachments: [image], clientMessageId: 'group-send' });
const groupRows = rows().slice(groupStart);
assert.equal(groupRows.length, 2);
assert.deepEqual(groupRows.map((message) => message.text), ['', '一起看']);
assert.equal(state.transactions, transactionsBeforeGroup + 1);
assert.equal(state.rotations, 1);
assert.equal(state.scheduled.length, 0);
assert.equal(groupTail.id, groupRows.at(-1).id);

assert.deepEqual(fitPreviewImage(1600, 900, 400, 800), { width: 400, height: 225 });
assert.deepEqual(fitPreviewImage(400, 3200, 400, 800), { width: 100, height: 800 });
assert.equal(clampPreviewOffset(500, 400, 400, 1), 0);
assert.equal(clampPreviewOffset(500, 400, 400, 3), 400);
assert.equal(clampPreviewOffset(-500, 400, 400, 3), -400);
assert.equal(clampPreviewOffset(500, 100, 400, 3), 0, '图片尚未填满轴向时保持居中');
// 引用必须保存媒体本身；原文后来改写、列表卸载或重发不能退化为摘要标签。
const sticker = { stickerId: 'sticker-1', mediaAssetId: 'sticker-media', name: '猫猫', description: '开心的猫',
  tags: ['开心'], emotion: '开心', mimeType: 'image/png', width: 100, height: 100, isAnimated: false };
for (const content of [{ text: '', attachments: [] }, { text: '一起发送', attachments: [image] }]) {
  const dispatchesBefore = state.dispatches;
  const submission = { ...content, sticker, sessionId: 's1', clientMessageId: `sticker-draft-${state.dispatches}` };
  const preview = timeline.createOptimisticUserTimelineMessages(submission);
  const sent = await sendUserMessage(submission, { id: 'ai-1' });
  assert.equal(sent.success, true);
  assert.equal(state.dispatches, dispatchesBefore + 1, '待发送表情包与图文只触发一次回复');
  assert.equal(sent.userMessages.length, content.text ? 3 : 1);
  assert.deepEqual(metadata.getMessageSticker(sent.userMessages[0]), sticker, '待发送表情包保留独立消息语义');
  assert.deepEqual(sent.userMessages.map(message => message.clientMessageId), preview.map(message => message.clientMessageId));
  assert.deepEqual(sent.userMessages.map(message => metadata.getMessageSticker(message)), preview.map(message => metadata.getMessageSticker(message)));
  assert.ok(sent.userMessages.slice(1).every(message => !metadata.getMessageSticker(message)), '其他气泡不携带表情包 metadata');
}
const voice = { schemaVersion: 1, mediaAssetId: 'voice-media', mimeType: 'audio/mp4', durationMs: 1200, transcriptSource: 'assistant_source_text' };
const sources = [
  { kind: 'image', attachments: [image] },
  { kind: 'file', attachments: [{ ...file, parsedText: '文件完整正文' }] },
  { kind: 'mixed', attachments: [image, { ...file, parsedText: '混合文件正文' }] },
  { kind: 'sticker', sticker },
  { kind: 'voice', voice },
];
for (const source of sources) {
  const original = { id: 700, text: source.kind === 'image' || source.kind === 'sticker' ? '' : '引用时的正文', metadataJson: JSON.stringify(source) };
  const target = metadata.createChatReplyTarget(original, []);
  assert.ok(target.text, '纯媒体引用草稿必须有可见摘要');
  original.text = '后来改写的正文';
  const send = { sessionId: 's1', text: '看看这个', replyToId: target.id, replyToText: target.text, replyQuote: target.quote,
    attachments: [anotherImage], clientMessageId: `quote-${source.kind}` };
  const preview = timeline.createOptimisticUserTimelineMessages(send);
  assert.equal(metadata.getMessageReplyQuote(preview[0]), null, '图片拆分后引用只属于尾消息');
  assert.deepEqual(metadata.getMessageReplyQuote(preview.at(-1)), target.quote);
  const sent = await sendUserMessage(send, { id: 'ai-1' });
  assert.equal(sent.success, true);
  const snapshot = metadata.getMessageReplyQuote(sent.userMessage);
  assert.equal(snapshot.text, target.quote.text, '已发送引用保留引用时的正文');
  assert.deepEqual(snapshot.attachments, target.quote.attachments.map(canonical), '历史 URI 引用随发送事务物化为稳定资产');
  assert.deepEqual(snapshot.sticker, target.quote.sticker);
  assert.deepEqual(snapshot.voice, target.quote.voice);
  const model = (await buildChatUserMessageModelInput(sent.userMessage, 'ai-1')).modelInput;
  const modelText = typeof model === 'string' ? model : model.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(modelText, /引用消息/);
  assert.match(modelText, /看看这个/);
  assert.equal(typeof model, 'string', '引用媒体只传身份，不重复读取媒体内容');
  const history = projectChatContextMessage(sent.userMessage, [sent.userMessage.createdAt, 0, sent.userMessage.id, 0]);
  assert.ok(history.content.includes(metadata.buildReplyQuoteModelText(sent.userMessage)), '历史上下文保留相同引用身份');
  for (const attachment of snapshot.attachments) assert.ok(modelText.includes(`mediaAssetId=${attachment.mediaAssetId}`));
  if (source.kind === 'file') assert.doesNotMatch(modelText, /文件完整正文/);
  if (source.kind === 'voice') assert.match(modelText, /mediaAssetId=voice-media/);
  if (source.kind === 'sticker') assert.match(modelText, /mediaAssetId=sticker-media/);
  const group = await sendGroupUserMessage({ groupId: 'g1', text: '群聊引用', replyToId: target.id, replyToText: target.text, replyQuote: snapshot });
  assert.deepEqual(metadata.getMessageReplyQuote(group), snapshot, '群聊保存同样的媒体引用快照');
}
assert.equal(metadata.buildReplyQuoteModelText({ replyToText: '旧引用', metadataJson: null }), '[引用：旧引用]');

// 输入区交接使用真实 React hook；落库故意挂起，验证受理与提交完成的职责边界。
global.IS_REACT_ACT_ENVIRONMENT = true;
const pendingSubmissions = [];
const callDialogs = [];
let outgoingCallAction;
let activeCall = null;
function loadComposerModule(name, mocks, extension = 'ts') {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, `src/features/chat/presentation/messages/ChatDetail/${name}.${extension}`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  new Function('require', 'module', 'exports', code)(id => {
    assert.ok(Object.hasOwn(mocks, id), id);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}
const sourceFiles = new Set();
const writtenText = new Map();
let sourceSequence = 0;
const deviceMedia = {
  PERSISTENT_MEDIA_CATEGORY: { chatImage: 'chatImage' },
  pickChatImagesFromDevice: async () => [image, anotherImage].map(item => ({ ...item, uri: item.localUri })),
  pickChatDocumentFromDevice: async () => ({ type: 'image', source: 'document', uri: 'file:///document-photo.png',
    fileName: 'document-photo.png', mimeType: 'image/png', fileSize: 20 * 1024 * 1024 }),
  persistDeviceMedia: async () => {
    const uri = `file:///draft-${++sourceSequence}.png`;
    sourceFiles.add(uri);
    return uri;
  },
  writeChatTextDraft: async (id, text) => {
    const uri = `file:///${id}.txt`;
    writtenText.set(uri, text);
    sourceFiles.add(uri);
    return uri;
  },
  deletePersistentMediaIfExists: async uri => { sourceFiles.delete(uri); },
};
const draftFiles = loadComposerModule('ChatAttachmentDraftFiles', { '@platform/device/DeviceMediaService': deviceMedia });
const attachmentDomain = load('src/features/chat/messages/domain/ChatAttachment.ts');
const attachmentParser = loadTypeScriptModule('src/features/chat/messages/application/AttachmentParser.ts', {
  '@platform/device': { persistentMediaStore: { readAsText: async (uri) => writtenText.get(uri) } },
  '../domain/ChatAttachment': attachmentDomain,
});
const { useAttachmentDraft } = loadComposerModule('useAttachmentDraft', {
  react: React,
  './ChatAttachmentDraftFiles': draftFiles,
  '../../../messages/application/AttachmentParser': attachmentParser,
  '@features/chat/messages/domain': attachmentDomain,
  '@platform/device/DeviceMediaService': deviceMedia,
});
const hookMocks = {
  react: React,
  '@shared/ui': { showAppDialog: dialog => callDialogs.push(dialog) },
  './ChatAttachmentDraftFiles': draftFiles,
  '../../../messages/application/MessageTimeline': timeline,
  '../../../messages/application/SendUserMessage': { sendUserMessage: params => new Promise((resolve, reject) => pendingSubmissions.push({ params, resolve, reject })) },
  '../../../conversation/application/ChatCallGateway': {
    getActiveChatCall: () => activeCall,
    startOutgoingChatCall: () => outgoingCallAction(),
    isChatSendBlockedByCall: load('src/features/chat/conversation/application/ChatCallGateway.ts').isChatSendBlockedByCall,
  },
  '../../../messages/domain/chatMessageMetadata': metadata,
  '../../../conversation/application/ChatTogetherListeningGateway': {},
  '../../../messages/application/UserVoiceMessageRecording': {},
};
const { useChatSendFlow } = loadComposerModule('useChatSendFlow', hookMocks);
let composer;
function Composer() {
  const [text, setText] = React.useState('第一条');
  const [messages, setMessages] = React.useState([]);
  const [error, setError] = React.useState(null);
  const lastMessageIdRef = React.useRef(null);
  const attachments = useAttachmentDraft();
  const flow = useChatSendFlow({
    sessionId: 's1', aiAssistant: { id: 'ai-1' }, aiRequestConfig: { id: 'ai-1' },
    messages, setMessages, setError, setIsTyping() {}, lastMessageIdRef,
  });
  const sendDraft = () => attachments.withAttachmentSubmission((items, consumeDraft) => flow.sendMessage(text, null, items, {
    onQueued: () => { consumeDraft(); setText(''); },
  }));
  composer = { ...flow, ...attachments, sendDraft, text, setText, messages, error };
  return null;
}
let composerSurface;
try {
  await act(async () => { composerSurface = create(React.createElement(Composer)); });
  let sending;
  let finished = false;
  let accepted = 0;
  await act(async () => {
    sending = composer.sendMessage(composer.text, null, [], { onQueued: () => {
      accepted++;
      composer.setText('');
    } });
    sending.then(() => { finished = true; });
  });
  assert.equal(composer.text, '', '落库仍挂起时输入区就应清空');
  assert.equal(composer.messages.length, 1, '清空时消息已由乐观气泡接管');
  assert.equal(finished, false, '附件提交生命周期仍等待持久化结束');
  await act(async () => composer.setText('第二条还没发'));
  const first = pendingSubmissions.shift();
  assert.equal(first.params.text, '第一条');
  await act(async () => {
    const canonicalMessage = { ...composer.messages[0], id: 9001, status: 'sent' };
    first.resolve({ success: true, userMessage: canonicalMessage, userMessages: [canonicalMessage] });
    assert.equal(await sending, true);
  });
  assert.equal(accepted, 1);
  assert.equal(composer.text, '第二条还没发', '旧提交完成不得清空后来输入的文字');
  assert.equal(composer.messages.length, 1, '落库后仍正常替换乐观气泡');

  await act(async () => {
    sending = composer.sendMessage(composer.text, null, [image], { onQueued: () => composer.setText('') });
  });
  assert.equal(composer.text, '');
  const failedSubmission = pendingSubmissions.shift();
  assert.equal(failedSubmission.params.attachments[0], image);
  await act(async () => {
    failedSubmission.reject(new Error('发送失败用例'));
    assert.equal(await sending, true);
  });
  assert.ok(composer.messages.slice(1).every(message => message.status === 'failed'), '受理后失败由气泡承载');
  assert.equal(composer.error, '发送失败用例');

  await act(async () => { await composer.selectImageAttachment(); });
  const submittedAttachments = composer.readyAttachments;
  const beforeImages = composer.messages.length;
  let imagesFinished = false;
  await act(async () => {
    sending = composer.sendDraft();
    sending.then(() => { imagesFinished = true; });
  });
  assert.equal(composer.draftAttachments.length, 0, '图片气泡接管时立即移除全部预览');
  assert.equal(composer.messages.length, beforeImages + 2, '两张图片已由时间线接管');
  assert.equal(imagesFinished, false, '清空预览不必等待持久化完成');
  assert.ok(submittedAttachments.every(item => sourceFiles.has(item.localUri)), '预览消失不能删除发送所需源文件');
  const imageSubmission = pendingSubmissions.shift();
  await act(async () => { await composer.selectImageAttachment(); });
  const nextAttachments = composer.readyAttachments;
  await act(async () => {
    imageSubmission.reject(new Error('图片落库失败'));
    assert.equal(await sending, true);
  });
  assert.deepEqual(composer.readyAttachments, nextAttachments, '旧发送结束保留新选的下一批图片');
  assert.ok(composer.messages.slice(beforeImages).every(item => item.status === 'failed'));
  assert.ok(submittedAttachments.every(item => sourceFiles.has(item.localUri)), '失败气泡继续持有源文件供重发');
  for (const failedImage of composer.messages.slice(beforeImages)) {
    let retrying;
    await act(async () => { retrying = composer.retrySend(failedImage.id); });
    const retrySubmission = pendingSubmissions.shift();
    const retryAttachment = retrySubmission.params.attachments[0];
    assert.ok(sourceFiles.has(retryAttachment.localUri), '重试仍能读取已清空预览的图片');
    await act(async () => {
      const canonicalMessage = { ...failedImage, id: 10000 + failedImage.id, status: 'sent' };
      retrySubmission.resolve({ success: true, userMessage: canonicalMessage, userMessages: [canonicalMessage] });
      await retrying;
    });
    assert.equal(sourceFiles.has(retryAttachment.localUri), false, '重试提交后释放源文件');
  }

  activeCall = { state: 'active', chatSessionId: 's1', aiAssistantId: 'ai-1' };
  await act(async () => composer.setText('被通话拦截的草稿'));
  const beforeBlocked = composer.messages;
  await act(async () => {
    assert.equal(await composer.sendDraft(), false);
  });
  assert.equal(composer.text, '被通话拦截的草稿', '发送检查拒绝时必须保留输入');
  assert.equal(composer.messages, beforeBlocked);
  assert.deepEqual(composer.readyAttachments, nextAttachments, '发送被拒绝时保留待发送图片预览');
  assert.equal(pendingSubmissions.length, 0);

  const pastedText = '原文🙂\r\n'.repeat(3_000);
  await act(async () => {
    composer.setText('保留的说明');
    await composer.attachPastedText(pastedText);
  });
  assert.equal(composer.text, '保留的说明');
  assert.deepEqual(composer.readyAttachments.slice(0, -1), nextAttachments, '粘贴追加附件并保留已有图片');
  const txt = composer.readyAttachments.at(-1);
  assert.equal(txt.fileName, '粘贴文本.txt');
  assert.equal(txt.source, 'clipboard');
  assert.equal(txt.mimeType, 'text/plain');
  assert.equal(txt.parsedText, pastedText.replaceAll('\r\n', '\n').trim(), '粘贴与上传共用正文解析');
  assert.equal(writtenText.get(txt.localUri), pastedText, 'TXT 原文件保留换行及 emoji');
  const pasteInput = await buildChatUserMessageModelInput({ id: 25, text: '查看附件',
    metadataJson: JSON.stringify({ kind: 'file', attachments: [txt] }) }, 'ai-1');
  assert.match(pasteInput.modelInput, new RegExp(`messageId=25；attachmentId=${txt.id}`));
  assert.match(pasteInput.modelInput, /read_chat_file.*开启文件读取/);
  assert.match(pasteInput.modelInput, /查看附件/);
  assert.doesNotMatch(pasteInput.modelInput, /原文🙂/);
  let consumeSentAttachments;
  await act(async () => {
    await composer.withAttachmentSubmission(async (items, consume) => {
      assert.deepEqual(items, [...nextAttachments, txt]);
      consumeSentAttachments = consume;
    });
    await composer.attachPastedText(pastedText);
    consumeSentAttachments();
  });
  assert.equal(composer.readyAttachments.length, 1, '旧提交不能消费之后粘贴的附件');
  assert.notEqual(composer.readyAttachments[0].id, txt.id);
  assert.equal(sourceFiles.has(txt.localUri), false);

  // 已有聊天消息时，拨号动作失败也必须显示独立详情，而非写入不可见的加载错误。
  const refusal = '接听决策失败（测试模型）：HTTP 401: API Key invalid';
  outgoingCallAction = async () => ({ status: 'failed', call: { id: 'failed-call', state: 'missed' },
    errorMessage: refusal, visibleMessages: [] });
  await act(async () => { await composer.startVideoCall(); });
  assert.equal(callDialogs.length, 1);
  assert.equal(callDialogs[0].message, refusal);
  assert.equal(callDialogs[0].tone, 'error');
  assert.ok(composer.messages.length > 0, '错误不需要清空既有聊天才能被用户看到');
  assert.equal(composer.error, null, '拨号错误不污染历史加载状态');
  outgoingCallAction = async () => { throw new Error('拨号运行时初始化失败'); };
  await act(async () => { await composer.startVideoCall(); });
  assert.equal(callDialogs.length, 2);
  assert.equal(callDialogs[1].message, '拨号运行时初始化失败');
  for (const status of ['ended', 'accepted', 'rejected']) {
    outgoingCallAction = async () => ({ status, call: { id: 'call' }, visibleMessages: [] });
    await act(async () => { await composer.startVideoCall(); });
  }
  assert.equal(callDialogs.length, 2, '用户挂断、成功与 AI 明确拒接不显示系统故障');

  await act(async () => { await composer.selectDocumentAttachment(); });
  assert.equal(composer.readyAttachments.length, 1);
  assert.equal(composer.readyAttachments[0].type, 'image', '文件入口选图直接进入图片草稿，不走文本文件解析');
  assert.equal(composer.readyAttachments[0].source, 'document');
  assert.equal(composer.readyAttachments[0].fileSize, 20 * 1024 * 1024, '文件选图允许超过原先 15MB 的文件限额');
} finally {
  if (composerSurface) await act(async () => composerSurface.unmount());
}
assert.equal(sourceFiles.size, 0, '退出后释放未发送的下一批图片');

// 共用输入组件的召唤、停止与发送行为，以及玻璃主题的独立表面布局。
const defaultTheme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const glassTheme = load('src/shared/theme/themes/liquidGlass.ts').liquidGlassTheme;
let theme = defaultTheme;
let moonKimi = false;
const pasteDialogs = [];
const chatInputLimits = loadTypeScriptModule('src/features/chat/presentation/messages/components/chatInputLimits.ts', {
  '../../../messages/domain/ChatAttachment': attachmentDomain,
});
const storedPreferences = new Map();
const longPastePreference = loadTypeScriptModule('src/features/chat/presentation/messages/components/longPastePreference.ts', {
  react: React,
  './chatInputLimits': chatInputLimits,
  '@react-native-async-storage/async-storage': { default: {
    getItem: async (key) => storedPreferences.get(key) ?? null,
    setItem: async (key, value) => { storedPreferences.set(key, value); },
  } },
});
const { LongPasteToggle } = loadComposerModule('../components/LongPasteToggle', {
  react: { ...React, default: React },
  'react-native': { View: 'View' },
  '@shared/ui': { SliderField: 'SliderField', ToggleField: 'ToggleField',
    showAppDialog: (dialog) => pasteDialogs.push(dialog) },
  '../../../messages/domain/ChatAttachment': attachmentDomain,
  './chatInputLimits': chatInputLimits,
  './longPastePreference': longPastePreference,
}, 'tsx');
const composerInput = loadComposerModule('../components/ChatComposerTextInput', {
  react: { ...React, default: React },
  'react-native': { StyleSheet: { flatten: (style) => style } },
  '@platform/device/OverflowPasteView': { OverflowPasteView: 'OverflowPasteView' },
  '@shared/ui': { AppTextInput: 'AppTextInput' },
  '../../../messages/domain/ChatAttachment': attachmentDomain,
  './longPastePreference': longPastePreference,
}, 'tsx');
const SendButton = loadComposerModule('../components/ChatSendButton', {
  react: { ...React, default: React },
  'react-native': { TouchableOpacity: 'TouchableOpacity', View: 'View' },
  'lucide-react-native': { ArrowUp: 'ArrowUp', LoaderCircle: 'LoaderCircle' },
}, 'tsx');
const InputArea = loadComposerModule('../components/ChatInputArea', {
  react: { ...React, default: React },
  'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', Keyboard: { dismiss() {} } },
  '@shared/ui': { showAppDialog: (dialog) => pasteDialogs.push(dialog) },
  '@expo/vector-icons': { Ionicons: 'Ionicons' }, 'lucide-react-native': { BrainCircuit: 'BrainCircuit', CirclePlay: 'CirclePlay', Keyboard: 'Keyboard' },
  './ChatSendButton': SendButton,
  './ChatEmojiPanel': { default: 'ChatEmojiPanel' }, './ChatToolPanel': { default: 'ChatToolPanel' },
  './ChatAttachmentComposerTray': { default: 'Tray' }, './ChatVoiceReviewPanel': { ChatVoiceReviewPanel: 'Review' },
  './ChatVoiceRecordingFeedback': { ChatVoiceRecordingFeedback: 'Feedback' }, './chatInputStyles': { createInputAreaStyles: () => ({}) },
  '@shared/theme': { useTheme: () => theme, isMoonKimiTheme: () => moonKimi, ThemedSurface: 'ThemedSurface' },
  './MoonKimiComposer': { MoonKimiComposer: 'MoonKimiComposer' },
  './chatToolPanelCapability': { resolveTogetherListeningToolPanelHandler: () => undefined },
  '../../../messages/domain/ChatAttachment': attachmentDomain,
  './ChatComposerTextInput': composerInput,
}, 'tsx').default;
for (const { isMoon, isGlass } of [
  { isMoon: false, isGlass: false },
  { isMoon: true, isGlass: false },
  { isMoon: false, isGlass: true },
]) {
  moonKimi = isMoon;
  theme = isGlass ? glassTheme : defaultTheme;
  let invoked = 0, finishSending;
  const props = { value: '', onChangeText() {}, onSend: () => new Promise(resolve => { finishSending = resolve; }),
    onInvoke: async () => { invoked++; }, activeSurface: 'none', onActiveSurfaceChange() {}, surfaceHeight: 200 };
  let renderer;
  await act(async () => { renderer = create(React.createElement(InputArea, props)); });
  const invoke = () => isMoon ? renderer.root.findByType('MoonKimiComposer').props.replyStopButton
    : renderer.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === '召唤回复');
  const glassSurfaces = () => renderer.root.findAllByType('ThemedSurface');
  const glassControls = () => glassSurfaces().map(surface => {
    if (surface.findAllByType('AppTextInput').length) return 'AppTextInput';
    return surface.findByType('TouchableOpacity').props.accessibilityLabel;
  });
  const glassInputButtons = () => glassSurfaces()
    .find(surface => surface.findAllByType('AppTextInput').length)
    .findAllByType('TouchableOpacity').map(button => button.props.accessibilityLabel);
  if (isGlass) {
    assert.deepEqual(glassControls(), ['切换到语音', 'AppTextInput', '表情包', '功能面板']);
    assert.deepEqual(glassInputButtons(), ['召唤回复'], '召唤按钮与文字共用一个玻璃表面');
  }
  await act(async () => invoke().props.onPress());
  assert.equal(invoked, 1, '没有输入也能点击召唤');
  await act(async () => renderer.update(React.createElement(InputArea, { ...props, onInvoke: undefined })));
  assert.equal(invoke() ?? null, null, '关闭手动召唤时不显示按钮');
  if (isGlass) {
    assert.deepEqual(glassControls(), ['切换到语音', 'AppTextInput', '表情包', '功能面板']);
    assert.deepEqual(glassInputButtons(), [], '关闭手动召唤时清空输入框右侧的按钮');
    await act(async () => renderer.update(React.createElement(InputArea, { ...props, value: '自动回复', onInvoke: undefined })));
    assert.deepEqual(glassControls(), ['切换到语音', 'AppTextInput', '发送']);
    const sendButton = renderer.root.findByProps({ accessibilityLabel: '发送' });
    assert.equal(sendButton.findByType('View').props.style.backgroundColor, defaultTheme.colors.text.primary);
    assert.equal(sendButton.findByType('ArrowUp').props.color, defaultTheme.colors.icon.inverse);
    await act(async () => renderer.update(React.createElement(InputArea, { ...props, onInvoke: undefined, onStopReply() {} })));
    assert.deepEqual(glassControls(), ['切换到语音', 'AppTextInput', '表情包', '功能面板']);
    assert.deepEqual(glassInputButtons(), ['终止回复']);
  }
  await act(async () => renderer.update(React.createElement(InputArea, { ...props, value: '尚未落库的消息' })));
  if (isGlass) {
    assert.deepEqual(glassControls(), ['切换到语音', 'AppTextInput', '发送']);
    assert.deepEqual(glassInputButtons(), ['召唤回复']);
  }
  await act(async () => {
    if (isMoon) renderer.root.findByType('MoonKimiComposer').props.onSend();
    else renderer.root.findByProps({ accessibilityLabel: '发送' }).props.onPress();
  });
  assert.equal(invoke().props.disabled, true, '发送还未完成时不能提前召唤漏掉本条消息');
  await act(async () => finishSending());
  assert.equal(invoke().props.disabled, false);
  await act(async () => renderer.update(React.createElement(InputArea, { ...props, onStopReply() {} })));
  if (isMoon) assert.equal(renderer.root.findByType('MoonKimiComposer').props.replyStopButton.props.accessibilityLabel, '终止回复');
  else assert.equal(invoke(), undefined, '生成时原位置切换为停止按钮');
  await act(async () => renderer.unmount());
}

theme = defaultTheme;
moonKimi = false;
const receivedPastes = [];
const acceptedTextChanges = [];
const pasteProps = {
  value: '长文本'.repeat(4_000), onChangeText: (text) => acceptedTextChanges.push(text),
  onSend() {}, activeSurface: 'none', onActiveSurfaceChange() {}, surfaceHeight: 200,
  onAttachPastedText: async (value) => { receivedPastes.push(value); },
};
let pasteRenderer, settingsRenderer;
await act(async () => {
  pasteRenderer = create(React.createElement(InputArea, pasteProps));
  settingsRenderer = create(React.createElement(LongPasteToggle));
});
assert.equal(pasteRenderer.root.findAllByType('OverflowPasteView').length, 0, '关闭开关时使用系统粘贴');
assert.equal(settingsRenderer.root.findAllByType('SliderField').length, 0);
const plainInput = pasteRenderer.root.findByType('AppTextInput');
assert.equal(plainInput.props.maxLength, undefined, '开关关闭时正文不被输入控件截断');
assert.equal(plainInput.props.value, pasteProps.value);
const keyboardPaste = '开头' + '字'.repeat(29_000) + '\n第二行🙂';
await act(async () => plainInput.props.onChangeText(keyboardPaste));
assert.deepEqual(acceptedTextChanges.splice(0), [keyboardPaste], '关闭时键盘剪贴板保留原文');
assert.deepEqual(receivedPastes, []);
await act(async () => settingsRenderer.root.findByType('ToggleField').props.onValueChange(true));
const pasteView = pasteRenderer.root.findByType('OverflowPasteView');
assert.equal(pasteView.props.inlineLimit, 5_000, '超过 5,000 字符的粘贴转为附件');
const thresholdField = () => settingsRenderer.root.findByType('SliderField');
assert.equal(thresholdField().props.inputValue, '5000');
assert.equal(thresholdField().props.min, 1);
assert.equal(thresholdField().props.max, 50_000);
await act(async () => thresholdField().props.onInputChange('500001'));
await act(async () => thresholdField().props.onBlur());
assert.ok(thresholdField().props.error);
assert.equal(pasteView.props.inlineLimit, 5_000, '非法阈值不能改写输入框生效值');
await act(async () => thresholdField().props.onInputChange('1234'));
await act(async () => thresholdField().props.onBlur());
assert.equal(pasteView.props.inlineLimit, 1_234, '手动输入结束后应用精确阈值');
await act(async () => thresholdField().props.onSetValue(3456));
assert.equal(pasteView.props.inlineLimit, 3_456, '保存后，同步给已打开的聊天输入框');
const fullPaste = '字'.repeat(5_001);
await act(async () => pasteView.props.onOverflowPaste({ nativeEvent: { text: fullPaste } }));
assert.deepEqual(receivedPastes, [fullPaste]);
await act(async () => pasteView.props.onOverflowPaste({ nativeEvent: {} }));
assert.deepEqual(receivedPastes, [fullPaste], '超限附件不发送截断的文本');
assert.equal(pasteDialogs.at(-1).title, '粘贴文本过长');

const keyboardInput = () => pasteRenderer.root.findByType('AppTextInput');
const existingDraft = '说明：开头，尾注';
await act(async () => pasteRenderer.update(React.createElement(InputArea, { ...pasteProps, value: existingDraft })));
await act(async () => keyboardInput().props.onSelectionChange({ nativeEvent: { selection: { start: 3, end: 5 } } }));
await act(async () => keyboardInput().props.onChangeText(`说明：${keyboardPaste}，尾注`));
assert.deepEqual(receivedPastes, [fullPaste, keyboardPaste], '键盘一次插入 29,000 多字时完整转为附件');
assert.equal(keyboardInput().props.value, existingDraft);
assert.deepEqual(acceptedTextChanges, [], '大段插入不覆盖原草稿或选中文字');

const replacement = '🚀' + '字'.repeat(29_000);
await act(async () => pasteRenderer.update(React.createElement(InputArea, { ...pasteProps, value: '前🙂后' })));
await act(async () => keyboardInput().props.onChangeText(`前${replacement}后`));
assert.deepEqual(receivedPastes, [fullPaste, keyboardPaste, replacement], '选区事件未到达时也保留完整 emoji 与正文');
const dialogsBeforeOversize = pasteDialogs.length;
await act(async () => keyboardInput().props.onChangeText('字'.repeat(50_001)));
assert.equal(pasteDialogs.length, dialogsBeforeOversize + 1);
assert.equal(pasteDialogs.at(-1).title, '粘贴文本过长');
assert.deepEqual(acceptedTextChanges, []);

await act(async () => pasteRenderer.update(React.createElement(InputArea, { ...pasteProps, value: existingDraft })));
await act(async () => thresholdField().props.onSetValue(1));
await act(async () => keyboardInput().props.onChangeText('说明：继续输入，尾注'));
assert.deepEqual(acceptedTextChanges.splice(0), ['说明：继续输入，尾注'], '低阈值下候选词仍按普通输入处理');
assert.deepEqual(receivedPastes, [fullPaste, keyboardPaste, replacement]);
await act(async () => thresholdField().props.onSetValue(3456));

await act(async () => settingsRenderer.root.findByType('ToggleField').props.onValueChange(false));
assert.equal(pasteRenderer.root.findAllByType('OverflowPasteView').length, 0);
await act(async () => settingsRenderer.root.findByType('ToggleField').props.onValueChange(true));
assert.equal(thresholdField().props.inputValue, '3456', '重新打开开关后保留自定义阈值');
await act(async () => {
  settingsRenderer.unmount();
  pasteRenderer.unmount();
});
await act(async () => { pasteRenderer = create(React.createElement(InputArea, pasteProps)); });
assert.equal(pasteRenderer.root.findByType('OverflowPasteView').props.inlineLimit, 3_456, '重新打开输入区后从本地读取阈值');
await act(async () => pasteRenderer.unmount());
storedPreferences.set('chat.longPasteAsAttachment', 'true');
await act(async () => { pasteRenderer = create(React.createElement(InputArea, pasteProps)); });
assert.equal(pasteRenderer.root.findByType('OverflowPasteView').props.inlineLimit, 5_000, '旧版开关状态沿用新默认阈值');
await act(async () => pasteRenderer.unmount());

db.close();
console.log('图文原子发送、单次回复、独立重发、乐观替换、群聊整批提交与图片预览几何验证通过。');
