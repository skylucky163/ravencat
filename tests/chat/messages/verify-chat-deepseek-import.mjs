import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from '../../helpers/load-typescript-module.mjs';
import { bootstrapSqlite, createSqliteExecutor } from '../../helpers/sqlite-bootstrap-fixture.mjs';
import { createChatMessageMutationFixture } from '../../helpers/chat-message-mutation-fixture.mjs';
import { chatSharingDependencies } from '../../helpers/chat-sharing-fixture.mjs';

const chat = 'src/features/chat/';
const messagesPath = chat + 'messages/';
const repliesPath = chat + 'reply/';
const protocol = load(messagesPath + 'infrastructure/DeepSeekExportProtocol.ts');
const { readDeepSeekExportLink, parseDeepSeekExportIndex, parseDeepSeekExportConversation } = protocol;
const provenance = load(messagesPath + 'domain/DeepSeekImport.ts');
const exportId = 'a0000000-b000-c000-d000-e00000000000';
const filesPrefix = `chat_sessions/${exportId}_files/`;

const text = (type, content) => ({ type, content });
const file = (file_name, is_image, export_path) => ({ file_name, is_image, file_size: 30, export_path });
const history = [];
for (let round = 0; round < 1053; round += 1) {
  const firstId = round * 2 + 1;
  const date = 1_770_000_000_000 + round * 1000;
  history.push(
    { id: firstId, parent_id: round === 0 ? 98765 : firstId - 1,
      role: 'USER', inserted_at: new Date(date).toISOString(), fragments: round === 1
        ? [{ type: 'FILE', files: [file('missing.jpg', true), file('example.html', false, filesPrefix + 'example.html')] }]
        : [text('REQUEST', `问题 ${round}`)] },
    { id: firstId + 1, parent_id: firstId, role: 'ASSISTANT', inserted_at: new Date(date - 10).toISOString(),
      fragments: [...(round === 0 ? [] : [text('THINK', `思考 ${round}`)]), text('RESPONSE', `回答 ${round}`)] },
  );
}
const conversation = parseDeepSeekExportConversation(exportId,
  { id: exportId, current_message_id: history.at(-1).id, messages: history });
assert.equal(conversation.hasHistoryGap, true);
assert.equal(conversation.messages[0].thinking, '');
assert.equal(conversation.messages[1].thinking, '');
assert.equal(conversation.messages[2].text, '');
assert.equal(conversation.messages[3].thinking, '思考 1');

const exportHost = 'deepseek-chat-history-exports-prod.obs.cn-east-3.myhuaweicloud.com';
const exportUrl = `https://${exportHost}/${exportId}.zip?Signature=a%2Bb%3D&Expires=123`;
assert.equal(readDeepSeekExportLink(` ${exportUrl} `), exportUrl);
assert.throws(() => readDeepSeekExportLink(exportUrl.replace(exportHost, `${exportHost}.example`)), /官方 ZIP/);
assert.throws(() => readDeepSeekExportLink(`https://${exportHost}/${exportId}.zip`), /官方 ZIP/);
const { openDeepSeekArchive } = load(messagesPath + 'infrastructure/DeepSeekExportClient.ts', {
  'expo/fetch': { fetch: () => assert.fail('分享链接不应发出网络请求') },
  'expo-file-system': {},
  '@platform/device': { getCachedZipReader: () => assert.fail('分享链接不应打开 ZIP 模块') },
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
  './DeepSeekExportProtocol': protocol,
  './DeepSeekImportAttachments': {},
});
await assert.rejects(openDeepSeekArchive('https://chat.deepseek.com/share/a123', new AbortController().signal), /官方 ZIP/);
assert.deepEqual(parseDeepSeekExportIndex([{ id: exportId, title: '导出对话', message_count: 4 }]),
  [{ id: exportId, title: '导出对话', messageCount: 4 }]);
assert.equal(parseDeepSeekExportIndex([{ id: exportId, title: null, message_count: 1 }])[0].title, '未命名对话');
assert.throws(() => parseDeepSeekExportIndex([{ id: '../manifest', title: '无效', message_count: 0 }]));
const archivePath = `chat_sessions/${exportId}_files/photo.png`;
const exportRow = (id, parent_id, role, ...fragments) => ({
  id, parent_id, role, fragments, inserted_at: '2026-11-20T01:02:03.456Z',
});
const exportSession = { id: exportId, current_message_id: 3, messages: [
  exportRow(1, null, 'USER', text('REQUEST', '问题')),
  exportRow(2, 1, 'ASSISTANT', text('RESPONSE', '旧分支')),
  exportRow(3, 1, 'ASSISTANT', text('THINK', '思考'), text('RESPONSE', '```html\n<p>新分支</p>\n```')),
  exportRow(4, 3, 'USER', { type: 'FILE', files: [
    { file_name: 'photo.png', is_image: true, export_path: archivePath },
    { file_name: 'missing.html', is_image: false, export_path: 'chat_sessions/other_files/missing.html' },
  ] }),
] };
const archivePreview = parseDeepSeekExportConversation(exportId, exportSession);
assert.deepEqual(archivePreview.messages.map(row => row.id), [1, 3]);
assert.equal(archivePreview.messages[1].thinking, '思考');
assert.equal(archivePreview.messages[1].text, '```html\n<p>新分支</p>\n```');
assert.equal(archivePreview.messages[1].timestamp, Date.parse('2026-11-20T01:02:03.456Z'));
const archiveWithAttachments = parseDeepSeekExportConversation(exportId, { ...exportSession, current_message_id: 4 });
assert.equal(archiveWithAttachments.messages[2].files[0].archivePath, archivePath);
assert.equal(archiveWithAttachments.messages[2].files[1].archivePath, undefined);
assert.throws(() => parseDeepSeekExportConversation(exportId, {
  ...exportSession, messages: [exportRow(3, 3, 'ASSISTANT', text('RESPONSE', '无效'))],
}), /消息顺序/);

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
await bootstrapSqlite(createSqliteExecutor(db));
const { messages, metadata, persistence } = createChatMessageMutationFixture(db);
Object.assign(persistence, load('src/platform/persistence/runtime/DatabaseErrors.ts'));
const dependencies = { '@platform/persistence': persistence };
const { sessionRepository: sessions } = load(chat + 'conversation/infrastructure/SQLiteSessionRepository.ts', dependencies);
const turnDomain = load(repliesPath + 'domain/ConversationTurn.ts');
const { conversationTurnRepository: turns } = load(repliesPath + 'infrastructure/SQLiteConversationTurnRepository.ts', {
  ...dependencies, '../../messages/infrastructure/ChatMessageMutationSql': {}, './ChatTurnPresentationSql': {},
  '../../messages/infrastructure/SQLiteMessageRepository': { messageRepository: messages },
  '../domain/ConversationTurn': turnDomain, '../../messages/domain': metadata, './ChatReplyVersionSql': {},
});
const date = '2026-10-12T00:00:00.000Z';
db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('a','agent-a','测试','model',?,?)").run(date, date);

const mediaRepo = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts', {
  '@platform/persistence': persistence,
});
const mediaRepository = new mediaRepo.SQLiteMediaAssetRepository();
let finalized = 0;
let rolledBack = 0;
const media = {
  MEDIA_ASSET_STORAGE_BACKEND: { persistentMedia: 'persistent-media' },
  prepareMediaAssetBatch: async (sources) => {
    assert.equal(sources.length, 1);
    assert.equal(sources[0].fileName, 'example.html');
    const asset = { id: 'asset-for-html', storageBackend: 'persistent-media', storageKey: 'catalog/media/example.html',
      hashAlgorithm: 'sha256', contentHash: 'a'.repeat(64), mimeType: 'text/html', byteSize: 30, width: null,
      height: null, durationMs: null, status: 'ready', createdAt: date, updatedAt: date };
    return {
      async commitInTransaction(tx) {
        if (!await tx.getFirstAsync('SELECT id FROM media_assets WHERE id = ?', [asset.id])) await mediaRepository.createInTransaction(tx, asset);
        return { assets: [asset] };
      },
      async finalizeAfterCommit() { finalized += 1; },
      async discardAfterRollback() { rolledBack += 1; },
    };
  },
};
const prepare = load(messagesPath + 'application/PrepareChatAttachments.ts', {
  '@features/media': media,
  './ChatAttachmentMime': load(messagesPath + 'application/ChatAttachmentMime.ts'),
});
const [photo, html] = conversation.messages[2].files;
const signal = new AbortController().signal;
let disposed = 0;
const notifications = [];
const { importDeepSeekConversation, describeDeepSeekConversation } = load(messagesPath + 'application/ImportDeepSeekConversation.ts', {
  ...dependencies,
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
  '../../conversation/application/ChatConversationRuntime': { getChatConversationRuntimeDependencies: () => ({ sessions }) },
  '../../reply/application/ChatReplyUtils': load(repliesPath + 'application/ChatReplyUtils.ts', { '@shared/prompt': {} }),
  '../domain/DeepSeekImport': provenance,
  '../domain/chatMessageMetadata': metadata,
  '../events/ChatEvents': { emitChatMessagesReloadRequested: (...args) => notifications.push(args) },
  './PrepareChatAttachments': prepare,
  './ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => ({ messages, turns }) },
});
const archive = {
  extractAttachments: async (selected) => {
    assert.equal(selected, conversation);
    return {
      files: new Map([
        [photo, { id: 'local-photo-id', type: 'image', source: 'document', fileName: 'missing.jpg', unavailable: true }],
        [html, { id: 'local-html-id', type: 'file', source: 'document', fileName: 'example.html', localUri: 'file:///cache/example.html', mimeType: 'text/html' }],
      ]),
      dispose: () => { disposed += 1; },
    };
  },
};

assert.equal(describeDeepSeekConversation(conversation).messages, 2106);
const { sessionId, missingFiles } = await importDeepSeekConversation('a', archive, conversation, signal);
assert.equal(missingFiles, 1);
const all = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(sessionId);
assert.equal(all.length, 3158);
assert.ok(all.every(row => row.is_read && row.status === 'sent'));
assert.ok(all.every(row => JSON.parse(row.metadata_json).importSource === 'deepseek_share'));
assert.deepEqual(all.slice(0, 5).map(row => row.sender_type), ['user', 'assistant', 'user', 'reasoning', 'assistant']);
assert.deepEqual(all.slice(0, 5).map(row => row.text), ['问题 0', '回答 0', '', '思考 1', '回答 1']);
assert.equal(all[0].created_at, all[1].created_at);
const attachments = JSON.parse(all[2].metadata_json).attachments;
assert.deepEqual(attachments.map(a => a.id), ['local-photo-id', 'local-html-id']);
assert.equal(attachments[0].unavailable, true);
assert.equal(attachments[1].mediaAssetId, 'asset-for-html');
const resolver = load(messagesPath + 'application/ResolveChatAttachmentMedia.ts', {
  '@features/media': { resolveMediaAsset: async id => ({ localUri: `file:///store/${id}` }) },
  '@platform/device/DeviceMediaService': {},
});
assert.equal(await resolver.resolveChatImageAttachmentUris(attachments[0]), null);
assert.equal(await resolver.resolveChatAttachmentPrimaryUri(attachments[1]), 'file:///store/asset-for-html');
assert.equal((await sessions.getCanonicalConversation('a')).lastMessage, '回答 1052');
assert.equal(await turns.getSessionTurnSnapshot(sessionId), null);
assert.deepEqual(notifications, [[sessionId, true]]);
assert.equal(finalized, 1);

await assert.rejects(importDeepSeekConversation('a', archive, conversation, signal), /已有聊天记录/);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, all.length);
assert.equal(rolledBack, 1);
assert.equal(disposed, 2);
assert.equal(notifications.length, 1);

const summaryPath = chat + 'summary/';
const context = load(summaryPath + 'domain/ChatContext.ts', {
  '../../messages/domain/chatMessageMetadata': metadata,
  '../../messages/domain/ChatAttachment': load(messagesPath + 'domain/ChatAttachment.ts'),
  '../../messages/domain/ChatCodeBlock': load(messagesPath + 'domain/ChatCodeBlock.ts'),
  '../../messages/domain/ChatSticker': load(messagesPath + 'domain/ChatSticker.ts'),
  '../../messages/domain/SharedChatRecord': chatSharingDependencies['./SharedChatRecord'],
  '../../messages/domain/SharedMoment': chatSharingDependencies['./SharedMoment'],
});
const { SQLiteChatSummaryRepository } = load(summaryPath + 'infrastructure/SQLiteChatSummaryRepository.ts', {
  ...dependencies, '@shared/prompt': {},
  '../../messages/domain/DeepSeekImport': provenance,
  '../../group/application/GroupMentionModelText': {},
  '../../messages/infrastructure/ChatTimelineSql': load(messagesPath + 'infrastructure/ChatTimelineSql.ts'),
  '../domain/ChatContext': context,
  '../domain/ChatSummaryRepository': load(summaryPath + 'domain/ChatSummaryRepository.ts'),
  '../domain/ChatSummaryTimeline': load(summaryPath + 'domain/ChatSummaryTimeline.ts'),
});
const summary = new SQLiteChatSummaryRepository(async () => []);
const claim = () => summary.claim(sessionId, 2, 'summary-claim', date, '2026-10-13T00:00:00Z', 'UTC', 0);
assert.equal(await claim(), null, '导入历史不能进入摘要');
const snapshot = await summary.readContext(sessionId, [], { importedHistoryLimit: 4 });
assert.equal(snapshot.timeline.length, 4);
assert.equal(snapshot.timeline[0].content, '问题 1051');
assert.equal(snapshot.timeline.at(-1).content, '回答 1052');

const current = '2026-11-20T00:00:00.000Z';
const add = (type, text) => messages.commitMessages({ messages: [{
  sessionId, time: '00:00', createdAt: current, isMe: type === 'user', senderType: type, text,
}], previewText: text });
const [next] = await add('user', '导入后新提问');
assert.equal(await claim(), null, '发送新提问也不能释放导入摘要积压');
await add('assistant', '导入后新回答');
db.prepare('UPDATE conversation_turn_state SET reply_cursor=? WHERE session_id=?').run(next.id, sessionId);
const newClaim = await claim();
assert.deepEqual(newClaim.messages.map(message => message.content), ['导入后新提问', '导入后新回答']);
db.close();
console.log('DeepSeek ZIP 导入、附件身份与摘要边界验证通过');
