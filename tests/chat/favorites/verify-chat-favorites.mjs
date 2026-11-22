/** 收藏行为：真实 SQLite、收藏与媒体仓储；仅替换文件、播放器和来源消息读端口。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor, loadSqliteModule } from '../../helpers/sqlite-bootstrap-fixture.mjs';


const require = createRequire(import.meta.url);
const db = new DatabaseSync(':memory:');
const executor = createSqliteExecutor(db);
await bootstrapSqlite(executor);
db.exec('PRAGMA foreign_keys=ON');
let writer = Promise.resolve();
const database = {
  transaction(_info, work) {
    const result = writer.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await work(executor); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    writer = result.catch(() => {});
    return result;
  },
  openTaskExecutor: () => executor,
};
const t = '2026-10-12T00:00:00.000Z';
db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('a','agent-a','测试 AI','test',?,?)").run(t, t);
db.prepare("INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('s','a','测试聊天',?,?)").run(t, t);
db.exec("INSERT INTO chat_conversations VALUES ('s','direct')");
function messageById(id) {
  const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  return row ? { id: row.id, sessionId: row.session_id, text: row.text, senderType: row.sender_type,
    status: row.status, deliveryStatus: row.delivery_status, createdAt: row.created_at,
    metadataJson: row.metadata_json, agentId: row.agent_id, replyToText: row.reply_to_text,
    logicalMessageId: row.logical_message_id, segmentIndex: row.segment_index, segmentTotal: row.segment_total } : null;
}
const played = [], cleaned = [], preparedBatches = [];
let prepareGate = null;
let fileText = '';
let mediaRepository;
const currentUser = { name: '枫渡' };
const boundaries = new Map([
  ['expo-crypto', { randomUUID }], ['@platform/persistence', { databaseCoordinator: database }],
  ['@features/assistants', { getAssistantDisplayName: assistant => assistant.nickname ?? assistant.name }],
  ['@platform/device', { persistentMediaStore: { readAsText: async () => fileText }, localAudioPlaybackPort: {
    play: async () => ({ pause: async () => {}, resume: async () => {}, stop: async () => {}, subscribe: () => () => {} }),
  } }],
  ['@shared/runtime/RuntimeSlot', null],
  ['@features/media', {
    MEDIA_ASSET_STORAGE_BACKEND: { persistentMedia: 'persistent-media' },
    resolveMediaAsset: async id => { assert.ok(db.prepare('SELECT id FROM media_assets WHERE id=?').get(id)); return { localUri: `file:///${id}` }; },
    releaseMediaAssetCandidates: async ids => database.transaction({}, async tx => {
      const assets = await mediaRepository.releaseUnreferencedAssetsInTransaction(tx, ids);
      cleaned.push(...assets.map(asset => asset.id));
    }),
    prepareMediaAssetBatch: async inputs => {
      const assets = inputs.map(input => mediaAsset(randomUUID(), input.mimeType));
      const state = { assets, finalized: false, discarded: false };
      preparedBatches.push(state);
      if (prepareGate) await prepareGate;
      return {
        commitInTransaction: async tx => { for (const asset of assets) await mediaRepository.createInTransaction(tx, asset); return { assets }; },
        finalizeAfterCommit: async () => { state.finalized = true; },
        discardAfterRollback: async () => { state.discarded = true; },
      };
    },
  }],
]);
const cache = new Map();
boundaries.set('./LocalAudioPlayback', { localAudioPlaybackPort: boundaries.get('@platform/device').localAudioPlaybackPort });
boundaries.get('@platform/device').localAudioPlaybackCoordinator = load('src/platform/device/LocalAudioPlaybackCoordinator.ts').localAudioPlaybackCoordinator;
function load(relative) {
  const requested = path.resolve(root, relative);
  const filename = requested.endsWith('.ts') && !fs.existsSync(requested) ? `${requested}x` : requested;
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', compiled)(id => {
    if (boundaries.has(id)) return boundaries.get(id);
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (id.endsWith('/ChatMessageRuntime')) return { getChatMessageRuntimeDependencies: () => ({ messages: {
      getMessageById: async key => messageById(key), getMessageByIdInTransaction: async (_tx, key) => messageById(key),
      getMessagesByLogicalMessageId: async (sessionId, logicalMessageId, transaction) => {
        const rows = await transaction.getAllAsync('SELECT id FROM chat_visible_messages WHERE session_id = ? AND logical_message_id = ? ORDER BY segment_index, id', [sessionId, logicalMessageId]);
        return rows.map(row => messageById(row.id));
      },
    } }) };
    if (id.endsWith('/ChatPresentation')) return { getChatDetailAvailableAssistants: async () => db.prepare('SELECT id, agent_id AS agentId, name, nickname FROM ai_assistants').all(), getChatDetailCurrentUser: async () => ({ ...currentUser }) };
    if (id.endsWith('/GroupChatManagement')) return { listGroupChats: async () => db.prepare('SELECT id, name FROM group_chats').all() };
    if (id === './MarkVoiceMessagePlayed') return { markVoiceMessagePlayed: async key => { played.push(key); } };
    if (id.endsWith('.json')) return JSON.parse(fs.readFileSync(path.resolve(path.dirname(filename), id), 'utf8'));
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), `${id}.ts`)));
    throw new Error(`缺少外部边界 ${id}`);
  }, module, module.exports);
  return module.exports;
}
boundaries.set('@shared/runtime/RuntimeSlot', load('src/shared/runtime/RuntimeSlot.ts'));
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
mediaRepository = new SQLiteMediaAssetRepository(executor);
const { SQLiteChatFavoriteRepository } = load('src/features/chat/favorites/infrastructure/SQLiteChatFavoriteRepository.ts');
const repository = new SQLiteChatFavoriteRepository();
load('src/features/chat/favorites/application/ChatFavoriteRuntime.ts').configureChatFavoriteRuntime(repository);
const favorites = load('src/features/chat/favorites/application/ChatFavorites.ts');
const { getChatMessageActions } = load('src/features/chat/messages/domain/ChatMessageActions.ts');
function mediaAsset(id, mimeType = 'image/png') {
  return { id, storageBackend: 'persistent-media', storageKey: `catalog/media/${id}`, hashAlgorithm: 'sha256', contentHash: 'a'.repeat(64),
    mimeType, byteSize: 1, width: null, height: null, durationMs: null, status: 'ready', createdAt: t, updatedAt: t };
}
async function addAsset(id, mimeType) { await mediaRepository.createInTransaction(executor, mediaAsset(id, mimeType)); }
function insert(text, metadata = null, sender = 'user', options = {}) {
  const id = Number(db.prepare('INSERT INTO messages(session_id,text,is_me,sender_type,status,delivery_status,created_at,metadata_json,agent_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('s', text, Number(sender === 'user'), sender, options.status ?? 'sent', 'delivered', t, metadata && JSON.stringify(metadata), sender === 'assistant' ? 'agent-a' : null).lastInsertRowid);
  return id;
}
const image = id => ({ id: `image:${id}`, type: 'image', source: 'gallery', mediaAssetId: id, fileName: `${id}.png` });
const voice = { schemaVersion: 1, mediaAssetId: 'audio', mimeType: 'audio/wav', durationMs: 1000, transcriptSource: 'user_stt' };
const save = messageId => favorites.createChatFavorite({ messageId, sourceName: '收藏时的聊天名', assistantId: 'a' });
await addAsset('picture'); await addAsset('thumb'); await addAsset('audio', 'audio/wav'); await addAsset('file', 'text/plain'); await addAsset('sticker');
const ids = [insert('用户文字'), insert('AI 文字', null, 'assistant'),
  insert('图片配文', { kind: 'mixed', attachments: [{ ...image('picture'), thumbnailMediaAssetId: 'thumb' }] }),
  insert('完整语音转写', { kind: 'voice', voice }),
  insert('文件说明', { kind: 'mixed', attachments: [{ id: 'file', type: 'file', source: 'document', mediaAssetId: 'file', fileName: 'a.md', parsedText: '完整文件正文' }] }),
  insert('[表情]', { kind: 'sticker', sticker: { stickerId: 'sticker-id', mediaAssetId: 'sticker', name: '猫猫', description: null, tags: [], emotion: null, mimeType: 'image/png', width: 120, height: 120, isAnimated: false } }),
];
const saved = await Promise.all(ids.map(save));
assert.deepEqual(saved.map(item => item.category), ['text', 'text', 'image', 'audio', 'file', 'image']);
assert.equal(saved[1].snapshot.authorName, '测试 AI');
assert.equal(saved[0].snapshot.authorName, '枫渡');
assert.equal(saved[5].snapshot.attachments[0].type, 'image', '表情收藏使用普通图片的媒体形态');
const concurrent = await Promise.all([save(ids[0]), save(ids[0])]);
assert.ok(concurrent.every(item => item.id === saved[0].id), '重复收藏与并发点击只保留一个快照');
assert.equal((await favorites.listChatFavorites(null)).items.length, 6);
assert.equal((await favorites.getChatFavoriteByMessage(ids[0])).id, saved[0].id);
assert.equal(await favorites.getChatFavoriteByMessage(-1), null);
for (const [category, count] of [['text', 2], ['audio', 1], ['image', 2], ['file', 1]]) assert.equal((await favorites.listChatFavorites(category)).items.length, count);
db.prepare('UPDATE messages SET text=? WHERE id=?').run('后来修改的正文', ids[0]);
assert.equal((await favorites.listChatFavorites('text')).items.find(item => item.id === saved[0].id).snapshot.text, '用户文字');
db.prepare("INSERT INTO group_chats(id,name,created_at,updated_at) VALUES ('g','测试群聊',?,?)").run(t, t);
db.exec("INSERT INTO chat_conversations VALUES ('g','group')");
const groupUser = insert('群聊用户正文', { groupChat: { actorName: '当时的群用户名称' } });
const groupAI = insert('群聊 AI 正文', { actorName: '当时的群 AI 名称' }, 'assistant');
db.prepare("UPDATE messages SET session_id='g' WHERE id IN (?,?)").run(groupUser, groupAI);
const groupSaved = await Promise.all([groupUser, groupAI].map(messageId => favorites.createChatFavorite({ messageId, sourceName: '测试群聊' })));
assert.deepEqual(groupSaved.map(item => item.snapshot.authorName), ['当时的群用户名称', '测试 AI']);
assert.deepEqual(groupSaved.map(item => item.category), ['text', 'text'], '表情收藏不得污染之后的纯文本消息');
assert.ok(groupSaved.every(item => item.snapshot.sourceName === '测试群聊'));

// 从上一版仅存名称的收藏升级；只凭原消息恢复身份，找不到原消息的快照仍独立保留。
const orphan = { ...saved[0], id: 'orphan', sourceMessageId: 90000 };
await repository.createInTransaction(executor, orphan);
db.exec(`UPDATE chat_favorites SET snapshot_json = json_remove(snapshot_json,
  '$.sourceAssistantId', '$.sourceGroupId', '$.authorAgentId');`);
// 此处验证收藏身份补齐；完整版本升级由数据库基线用例覆盖，不伪标当前库版本。
await loadSqliteModule('chatFavoriteSchema').migrateChatFavoriteIdentities(executor);
assert.equal((await repository.getBySource(ids[1])).snapshot.authorAgentId, 'agent-a');
assert.equal((await repository.getBySource(ids[0])).snapshot.sourceAssistantId, 'a');
assert.equal((await repository.getBySource(groupAI)).snapshot.sourceGroupId, 'g');
assert.equal((await repository.getBySource(90000)).snapshot.sourceAssistantId, null);
// 检索界面批量判断行内星号状态：只返回命中行，重复消息不重复返回，空输入不查库。
assert.deepEqual((await repository.listRefsBySources([ids[0], 90000, 12345])).map(ref => `${ref.sourceMessageId}:${ref.id}`).sort(),
  [`${ids[0]}:${saved[0].id}`, `90000:${orphan.id}`].sort());
assert.equal((await repository.listRefsBySources([ids[0], ids[0]])).length, 1);
assert.deepEqual(await repository.listRefsBySources([]), []);
const snapshotBeforeRename = (await repository.getBySource(ids[1])).snapshot;
db.prepare('DELETE FROM messages WHERE id=?').run(ids[1]);
db.prepare("UPDATE ai_assistants SET name='新的公开名称', nickname='专属昵称' WHERE id='a'").run();
db.prepare("UPDATE group_chats SET name='改名后的群聊' WHERE id='g'").run();
let namedPage = await favorites.listChatFavorites(null);
assert.equal(namedPage.items.find(item => item.id === saved[1].id).authorName, '专属昵称', '原消息删除后仍按保存的角色身份读取当前名称');
assert.equal(namedPage.items.find(item => item.id === saved[0].id).sourceName, '专属昵称');
assert.equal(namedPage.items.find(item => item.id === groupSaved[1].id).sourceName, '改名后的群聊');
assert.equal(namedPage.items.find(item => item.id === groupSaved[1].id).authorName, '专属昵称');
assert.deepEqual((await repository.getBySource(ids[1])).snapshot, snapshotBeforeRename, '展示新名称不应改写历史内容快照');
assert.equal(namedPage.items.find(item => item.id === orphan.id).sourceName, orphan.snapshot.sourceName);
await favorites.removeChatFavorite(orphan.id);
const searchIds = async (query, category = null) => (await favorites.listChatFavorites(category, null, query)).items.map(item => item.id).sort();
assert.deepEqual(await searchIds('专属昵称'), [...saved, groupSaved[1]].map(item => item.id).sort(), '角色昵称也能找到该角色的图片及群聊发言');
assert.deepEqual(await searchIds('新的公开名称', 'image'), [saved[2].id, saved[5].id].sort(), '设置昵称后仍可搜索公开名称');
assert.deepEqual(await searchIds('改名后的群聊'), groupSaved.map(item => item.id).sort());
assert.deepEqual(await searchIds('  文件正文  '), [saved[4].id], '匹配文件内部正文，不要求文件名或配文命中');
assert.deepEqual(await searchIds('a.MD'), [saved[4].id], '文件名搜索忽略英文大小写');
assert.deepEqual(await searchIds('语音转写'), [saved[3].id]);
assert.deepEqual(await searchIds('AI 文字'), [saved[1].id]);
assert.deepEqual(await searchIds('图片配文'), [], '图片不通过内容关键词或文件元数据命中');
assert.deepEqual(await searchIds('picture'), []);
assert.deepEqual(await searchIds('不存在的关键词'), []);
db.prepare("UPDATE ai_assistants SET nickname=NULL WHERE id='a'").run();
namedPage = await favorites.listChatFavorites(null);
assert.equal(namedPage.items.find(item => item.id === saved[1].id).authorName, '新的公开名称');
db.prepare("UPDATE ai_assistants SET name='测试 AI' WHERE id='a'").run();

// 本机用户身份由 authorKind 确定，单聊和群聊历史均展示当前资料名，快照仍保留原名与原文。
const userSnapshots = await Promise.all([ids[0], groupUser].map(id => repository.getBySource(id)));
currentUser.name = '改名后的用户 Maple';
const renamedUserPage = await favorites.listChatFavorites(null);
const userFavorites = [...saved, ...groupSaved].filter(item => item.snapshot.authorKind === 'user');
for (const favorite of userFavorites) {
  assert.equal(renamedUserPage.items.find(item => item.id === favorite.id).authorName, currentUser.name);
}
assert.equal(renamedUserPage.items.find(item => item.id === saved[1].id).authorName, '测试 AI', '用户改名不改变 AI 作者名');
assert.deepEqual(await searchIds('MAPLE'), userFavorites.map(item => item.id).sort(), '按当前用户名匹配用户作品，不连带匹配 AI 作品');
assert.deepEqual(await searchIds('maple', 'image'), [saved[2].id, saved[5].id].sort(), '用户名称搜索覆盖图片，并保留分类筛选');
assert.deepEqual(await searchIds('maple', 'audio'), [saved[3].id]);
assert.deepEqual(await searchIds('maple', 'file'), [saved[4].id]);
assert.deepEqual(await Promise.all([ids[0], groupUser].map(id => repository.getBySource(id))), userSnapshots);
currentUser.name = '枫渡';

// 状态卡、通话来源、临时消息与不支持的旧文件不参与收藏；表情名字不能作为可翻译文本。
const rejected = [insert('通话状态', { type: 'callStatus' }), insert('通话 AI 文字', { triggerSource: 'call' }, 'assistant'),
  insert('临时回复', null, 'assistant', { status: 'streaming' }), insert('工具结果', null, 'tool'),
  insert('历史 CSV', { attachments: [{ id: 'csv', type: 'file', source: 'document', mediaAssetId: 'file', fileName: 'a.csv' }] }),
];
for (const id of rejected) { assert.equal(getChatMessageActions(messageById(id)).favorite, false); await assert.rejects(save(id), /不能收藏/); }
assert.equal(getChatMessageActions(messageById(ids[5])).translate, false);
for (const id of rejected.slice(0, 2)) assert.deepEqual(getChatMessageActions(messageById(id)), { quote: false, translate: false, favorite: false });

// Legacy URI 在事务外准备，与收藏一起提交为资产；原消息不被收藏命令改写。
const legacy = insert('', { attachments: [{ id: 'legacy', type: 'image', source: 'gallery', localUri: 'file:///legacy.png', fileName: 'legacy.png' }] });
const legacyFavorite = await save(legacy);
assert.ok(legacyFavorite.snapshot.attachments[0].mediaAssetId);
assert.equal(legacyFavorite.snapshot.attachments[0].localUri, undefined);
assert.ok(preparedBatches.at(-1).finalized);
assert.ok(JSON.parse(messageById(legacy).metadataJson).attachments[0].localUri);
let releasePreparation;
prepareGate = new Promise(resolve => { releasePreparation = resolve; });
const racingId = insert('', { attachments: [{ id: 'race', type: 'image', source: 'gallery', localUri: 'file:///race.png', fileName: 'race.png' }] });
const racing = save(racingId);
await new Promise(resolve => setImmediate(resolve));
db.prepare('DELETE FROM messages WHERE id=?').run(racingId);
releasePreparation();
await assert.rejects(racing, /已被删除/);
prepareGate = null;
assert.ok(preparedBatches.at(-1).discarded);
for (const asset of preparedBatches.at(-1).assets) assert.equal(db.prepare('SELECT id FROM media_assets WHERE id=?').get(asset.id), undefined);

// 删掉原消息与角色，收藏仍持有全部资产；备份枚举从快照库发现这些长期引用。
db.exec("DELETE FROM messages; DELETE FROM sessions; DELETE FROM ai_assistants; DELETE FROM group_chats; DELETE FROM chat_conversations;");
currentUser.name = '删除来源后改的新用户名';
const sourceDeletedPage = await favorites.listChatFavorites(null);
const sourceDeletedUserItems = sourceDeletedPage.items.filter(item => item.snapshot.authorKind === 'user');
assert.ok(sourceDeletedUserItems.every(item => item.authorName === currentUser.name), '原消息、会话与群聊删除不影响当前用户名称展示');
assert.deepEqual(await searchIds(currentUser.name), sourceDeletedUserItems.map(item => item.id).sort());
assert.equal((await repository.getBySource(ids[0])).snapshot.authorName, '枫渡');
currentUser.name = '枫渡';
const referencedAssets = ['picture', 'thumb', 'audio', 'file', 'sticker', legacyFavorite.snapshot.attachments[0].mediaAssetId];
await boundaries.get('@features/media').releaseMediaAssetCandidates(referencedAssets);
assert.equal(cleaned.length, 0);
assert.equal((await favorites.listChatFavorites(null)).items.length, 9);
assert.deepEqual((await mediaRepository.listBackupAssets(executor)).map(item => item.id).sort(), referencedAssets.sort());
const backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ravencat-favorites-'));
const backupPath = path.join(backupDirectory, 'snapshot.db');
db.prepare('VACUUM INTO ?').run(backupPath);
const restored = new DatabaseSync(backupPath);
assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM chat_favorites').get().n, 9);
assert.deepEqual((await mediaRepository.listBackupAssets(createSqliteExecutor(restored))).map(item => item.id).sort(), referencedAssets);
restored.close(); fs.unlinkSync(backupPath); fs.rmdirSync(backupDirectory);

const playback = load('src/features/chat/messages/application/VoiceMessagePlaybackCoordinator.ts').voiceMessagePlaybackCoordinator;
await playback.toggle({ kind: 'favorite', id: saved[3].id }, 'audio', 1000);
assert.equal(played.length, 0, '收藏语音独立播放，不更新已经删除的原消息');
await playback.stop();
await playback.toggle({ kind: 'message', id: 999, isIncoming: true }, 'audio', 1000);
assert.deepEqual(played, [999], '普通消息播放仍保留原有已播放语义');
await playback.stop();
await repository.createInTransaction(executor, { ...saved[2], id: 'shared-favorite', sourceMessageId: 9999 });
await favorites.removeChatFavorite(saved[2].id);
assert.equal(cleaned.length, 0, '另一个收藏仍引用同一图片时不能释放');
await favorites.removeChatFavorite('shared-favorite');
assert.ok(cleaned.includes('picture') && cleaned.includes('thumb'));
assert.ok(db.prepare("SELECT id FROM media_assets WHERE id='audio'").get());

// 稳定收藏时间游标跨分页不会重复或漏项。
for (let index = 0; index < 85; index++) await repository.createInTransaction(executor, {
  id: `page-${String(index).padStart(3, '0')}`, sourceMessageId: 1000 + index, category: 'text', savedAt: t,
  snapshot: { sourceAssistantId: null, sourceGroupId: null, authorAgentId: null,
    sourceName: '分页', authorName: '用户', authorKind: 'user', messageCreatedAt: t, text: `分页 ${index}`, replyToText: null, attachments: [], voice: null },
});
const seen = []; let cursor = null;
do { const page = await favorites.listChatFavorites(null, cursor); seen.push(...page.items); cursor = page.nextCursor; } while (cursor);
assert.equal(seen.length, 93); assert.equal(new Set(seen.map(item => item.id)).size, 93);
assert.deepEqual(seen, [...seen].sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id)));
const matchingPages = []; cursor = null;
do {
  const page = await favorites.listChatFavorites('text', cursor, '分页');
  matchingPages.push(...page.items); cursor = page.nextCursor;
} while (cursor);
assert.equal(matchingPages.length, 85, '搜索覆盖全部分页，保留稳定游标');
assert.equal(new Set(matchingPages.map(item => item.id)).size, 85);
assert.deepEqual(await searchIds('分页 0'), ['page-000'], '命中第一页之外的历史收藏');
assert.deepEqual(await searchIds('%'), [], '搜索中的 SQL 通配符按字面处理');
currentUser.name = '跨页用户新名';
const userSearchItems = []; cursor = null;
do {
  const page = await favorites.listChatFavorites(null, cursor, currentUser.name);
  userSearchItems.push(...page.items); cursor = page.nextCursor;
} while (cursor);
assert.deepEqual(userSearchItems.map(item => item.id).sort(), seen.filter(item => item.snapshot.authorKind === 'user').map(item => item.id).sort(), '按新用户名搜索在全量收藏中分页，不漏掉旧名作者的收藏');
currentUser.name = '枫渡';

const parser = load('src/features/chat/messages/application/AttachmentParser.ts');
for (const extension of ['csv', 'json', 'pdf', 'docx', 'xlsx']) assert.equal(parser.isChatAttachmentFileSupported({ fileName: `a.${extension}` }), false);
for (const extension of ['csv', 'json', 'txt', 'md']) assert.equal(parser.isChatAttachmentFilePreviewable({ fileName: `a.${extension}` }), true);
fileText = '完整正文\n'.repeat(300);
const parsed = await parser.attachmentParser.parseFile({ localUri: 'file:///a.md', fileName: 'a.md' });
assert.equal(parsed.parseStatus, 'success'); assert.equal(parsed.parsedText, fileText.trim());
fileText = '😀'.repeat(25_000);
assert.equal((await parser.attachmentParser.parseFile({ localUri: 'file:///a.txt', fileName: 'a.txt' })).parsedText, fileText);
fileText = '字'.repeat(50_001);
const tooLong = await parser.attachmentParser.parseFile({ localUri: 'file:///a.txt', fileName: 'a.txt' });
assert.equal(tooLong.parseStatus, 'failed'); assert.equal(tooLong.parsedText, null); assert.match(tooLong.parseError, /50,000/);
fileText = '正文\u0000不可读取的内容';
assert.equal((await parser.attachmentParser.parseFile({ localUri: 'file:///a.txt', fileName: 'a.txt' })).parseStatus, 'failed');

// 页面和菜单行为通过真实 React 渲染验证，不用源码字符串锁定调用点。
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__DEV__ = false;
const theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
let dialog;
const native = {
  ActivityIndicator: 'Loading', FlatList: ({ data, renderItem, ListEmptyComponent }) => React.createElement('List', null,
    data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item, index }))) : ListEmptyComponent),
  ScrollView: 'Scroll', Pressable: 'Pressable', Text: 'Text', TouchableOpacity: 'Button', TouchableWithoutFeedback: 'Touchable', View: 'View',
  StyleSheet: { create: styles => styles, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 360, height: 780 }),
  Modal: ({ visible, children }) => visible ? React.createElement('Modal', null, children) : null,
  ToastAndroid: { SHORT: 0, show() {} }, Keyboard: { dismiss() {} },
};
boundaries.set('react-native', native);
boundaries.set('@shared/theme', { useTheme: () => theme, useThemedStyles: create => create(theme), ThemedSurface: 'Surface' });
boundaries.set('@shared/ui', { UserAvatar: 'Avatar', AppTextInput: 'Input', KeyboardAvoidingContainer: 'KeyboardAvoiding', showAppDialog: options => { dialog = options; } });
boundaries.set('@shared/ui/NavigationHeader', { __esModule: true, default: props => React.createElement('Header', props, props.rightButton) });
boundaries.set('react-native-safe-area-context', { SafeAreaView: 'SafeArea' });
let focused = true;
boundaries.set('@react-navigation/native', { useFocusEffect: callback => {
  const isFocused = focused;
  React.useEffect(() => isFocused ? callback() : undefined, [callback, isFocused]);
} });
boundaries.set('lucide-react-native', { ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp', Database: 'Database', Search: 'Search', X: 'X', StarOff: 'StarOff', Star: 'Star', Pin: 'Pin', PinOff: 'PinOff', History: 'History', TextSelect: 'TextSelect', UserRound: 'UserRound', ArchiveRestore: 'ArchiveRestore', RefreshCw: 'RefreshCw', Trash2: 'Trash2' });
boundaries.set('@expo/vector-icons', { Ionicons: 'Icon' });
for (const [id, name] of [['../messages/MessageBubble/ImageAttachmentCard', 'ImagePreview'], ['../messages/MessageBubble/AttachmentCard', 'AttachmentPreview'],
  ['../messages/MessageBubble/VoiceMessageCard', 'AudioPlayer'], ['../messages/FilePreview', 'FilePreview']]) boundaries.set(id, { __esModule: true, default: name });
const Screen = load('src/features/chat/presentation/favorites/ChatFavoritesScreen.tsx').default;
let rendered;
await renderer.act(async () => { rendered = renderer.create(React.createElement(Screen, { onBack() {} })); });
assert.equal(rendered.root.findAllByProps({ accessibilityRole: 'tab' }).length, 5);
const searchInput = () => rendered.root.findByType('Input');
assert.equal(searchInput().props.value, '', '进入收藏页即可使用顶部搜索框');
assert.notEqual(searchInput().props.autoFocus, true, '进入收藏页不自动弹出键盘');
await renderer.act(async () => searchInput().props.onChangeText('文件正文'));
assert.equal(rendered.root.findAllByProps({ accessibilityLabel: '查看收藏内容' }).length, 1);
await renderer.act(async () => rendered.root.findAllByProps({ accessibilityRole: 'tab' })[1].props.onPress());
assert.equal(searchInput().props.value, '文件正文', '切换分类保留搜索词');
assert.ok(rendered.root.findAllByType('Text').some(node => node.props.children === '没有找到匹配的收藏'));
await renderer.act(async () => rendered.root.findAllByProps({ accessibilityRole: 'tab' })[0].props.onPress());
const listFavorites = repository.list.bind(repository);
let finishSlowSearch;
repository.list = async (category, cursor, search) => search?.text === '慢请求'
  ? new Promise(resolve => { finishSlowSearch = resolve; }) : listFavorites(category, cursor, search);
await renderer.act(async () => searchInput().props.onChangeText('慢请求'));
await renderer.act(async () => searchInput().props.onChangeText('文件正文'));
await renderer.act(async () => finishSlowSearch({ items: [], nextCursor: null }));
assert.equal(rendered.root.findAllByProps({ accessibilityLabel: '查看收藏内容' }).length, 1, '迟到的旧搜索不能覆盖新结果');
repository.list = listFavorites;
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '清空收藏搜索' }).props.onPress());
assert.equal(searchInput().props.value, '');
assert.equal(rendered.root.findAllByType('Input').length, 1, '清空搜索后搜索框仍固定显示');
assert.equal(rendered.root.findAllByProps({ accessibilityLabel: '查看收藏内容' }).length, 40, '清空搜索后恢复列表');
currentUser.name = '收藏展示新名';
await renderer.act(async () => rendered.root.findAllByProps({ accessibilityRole: 'tab' })[3].props.onPress());
assert.equal(rendered.root.findAllByType('ImagePreview').length, 2);
assert.equal(rendered.root.findAllByType('Text').filter(node => Array.isArray(node.props.children) && node.props.children.includes(currentUser.name)).length, 2, '列表中的用户作者展示当前用户名');
await renderer.act(async () => rendered.root.findAllByProps({ accessibilityLabel: '查看收藏内容' })[0].props.onPress());
assert.ok(rendered.root.findAllByType('Header').some(node => node.props.title === '收藏详情'));
assert.ok(rendered.root.findByType('Modal').findAllByType('Text').some(node => Array.isArray(node.props.children) && node.props.children.includes(currentUser.name)), '详情中的用户作者展示当前用户名');
// 详情页沿用列表同款星号（加斜线）图标取消收藏，不再提供文字按钮。
const detailsModal = rendered.root.findByType('Modal');
assert.ok(!detailsModal.findAllByType('Text').some(node => [].concat(node.props.children).join('') === '取消收藏'), '详情不应出现取消收藏文字');
assert.equal(detailsModal.findAllByProps({ accessibilityLabel: '取消收藏' }).length, 1, '详情用星号图标取消收藏');
await renderer.act(async () => detailsModal.findAllByProps({ accessibilityLabel: '取消收藏' })[0].props.onPress());
assert.equal(dialog.title, '取消收藏');
currentUser.name = '枫渡';
await renderer.act(async () => rendered.root.findAllByType('Header').find(node => node.props.title === '收藏详情').props.onGoBack());
assert.equal(rendered.root.findAllByType('Modal').length, 0);
await renderer.act(async () => rendered.root.findAllByProps({ accessibilityLabel: '取消收藏' })[0].props.onPress());
assert.equal(dialog.title, '取消收藏');
await renderer.act(async () => rendered.root.findAllByProps({ accessibilityLabel: '查看收藏内容' })[0].props.onPress());
focused = false;
await renderer.act(async () => rendered.update(React.createElement(Screen, { onBack() {} })));
assert.ok(!rendered.root.findAllByType('Header').some(node => node.props.title === '收藏详情'), '失焦后详情预览不能遮住其他页面');
await renderer.act(async () => rendered.unmount());

boundaries.set('@platform/device/DeviceStatus', { getInstalledApplicationInfo: () => ({ name: 'RavenCat', version: 'test', buildNumber: 1 }) });
const { ProfileContent } = load('src/features/profile/presentation/ProfileContent.tsx');
let opened = 0;
await renderer.act(async () => { rendered = renderer.create(React.createElement(ProfileContent, {
  profile: { name: '枫渡', avatar: null }, hasLoadedProfile: true, onOpenProfile() {}, onOpenFavorites: () => { opened++; },
  onOpenDataManagement() {}, checkingUpdates: false, availableUpdateVersion: null, updateProgress: null, updateDownloaded: false, onCheckUpdates() {},
})); });
assert.deepEqual(rendered.root.findAllByProps({ accessibilityRole: 'button' }).slice(0, 2).map(node => node.props.accessibilityLabel), ['个人', '收藏']);
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.onPress());
assert.equal(opened, 1);
await renderer.act(async () => rendered.unmount());

boundaries.set('@features/chat/messages/domain', { formatFileSize: () => '1 B' });
boundaries.set('../../../messages/application/ResolveChatAttachmentMedia', { resolveChatAttachmentPrimaryUri: async () => 'file:///favorite.md' });
boundaries.set('./ImageAttachmentCard', { __esModule: true, default: 'ImagePreview' });
const AttachmentCard = load('src/features/chat/presentation/messages/MessageBubble/AttachmentCard.tsx').default;
let position;
await renderer.act(async () => { rendered = renderer.create(React.createElement(AttachmentCard, {
  attachment: saved[4].snapshot.attachments[0], isMe: false, onPreview() {}, onAttachmentLongPress: value => { position = value; },
})); });
await renderer.act(async () => rendered.root.findByType('Pressable').props.onLongPress({ nativeEvent: { pageX: 12, pageY: 34 } }));
assert.deepEqual(position, { x: 12, y: 34 }, '文件卡自己的触控入口必须能打开长按菜单');
await renderer.act(async () => rendered.unmount());

const Menu = load('src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx').default;
await renderer.act(async () => { rendered = renderer.create(React.createElement(Menu, { visible: true, onClose() {}, onFavorite() {},
  onCopy() {}, onRewrite() {}, onRegenerate() {}, onDelete() {}, onMultiSelect() {}, onFixedStart() {}, onToggleVoiceTranscript() {}, onQuote() {}, onTranslate() {}, onForward() {},
})); });
assert.ok(rendered.root.findByProps({ accessibilityLabel: '收藏' }));
const menu = rendered.root.findAllByType('View').find(node => Array.isArray(node.props.style) && node.props.style[1]?.width);
assert.ok(menu.props.style[1].width <= 336, '新增操作后菜单仍需留在手机屏幕内');
await renderer.act(async () => rendered.unmount());
// 菜单读取真实收藏事实，支持添加、再次取消、重新打开以及独立收藏页取消后的刷新。
db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('a','agent-a','测试 AI','test',?,?)").run(t, t);
db.prepare("INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('s','a','测试聊天',?,?)").run(t, t);
db.exec("INSERT INTO chat_conversations VALUES ('s','direct')");
const actionMessage = messageById(insert('菜单收藏切换'));
const otherActionMessage = messageById(insert('另一条消息'));
const { useChatFavoriteAction } = load('src/features/chat/presentation/messages/components/useChatFavoriteAction.ts');
function FavoriteMenu({ message }) {
  const action = useChatFavoriteAction(message, '测试聊天', 'a');
  return React.createElement(Menu, { visible: Boolean(message), onClose() {}, onCopy() {}, onFavorite: action.toggle, isFavorited: action.isFavorited });
}
const openFavoriteMenu = async message => {
  await renderer.act(async () => rendered.update(React.createElement(FavoriteMenu, { message: null })));
  await renderer.act(async () => rendered.update(React.createElement(FavoriteMenu, { message })));
};
await renderer.act(async () => { rendered = renderer.create(React.createElement(FavoriteMenu, { message: actionMessage })); });
assert.equal(rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.disabled, false);
await renderer.act(async () => {
  const press = rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.onPress;
  press(); press();
});
assert.equal(rendered.root.findByProps({ accessibilityLabel: '已收藏' }).props.accessibilityState.selected, true);
assert.equal(rendered.root.findByType('Star').props.fill, theme.colors.brand.onPrimary);
const menuFavorite = await favorites.getChatFavoriteByMessage(actionMessage.id);
assert.ok(menuFavorite);
await openFavoriteMenu(actionMessage);
assert.ok(rendered.root.findByProps({ accessibilityLabel: '已收藏' }));
const removeInTransaction = repository.removeInTransaction.bind(repository);
let finishRemoval;
let removalStarted;
const startedRemoval = new Promise(resolve => { removalStarted = resolve; });
repository.removeInTransaction = async (...args) => {
  await new Promise(resolve => { finishRemoval = resolve; removalStarted(); });
  return removeInTransaction(...args);
};
await renderer.act(async () => {
  rendered.root.findByProps({ accessibilityLabel: '已收藏' }).props.onPress();
  await startedRemoval;
});
await openFavoriteMenu(actionMessage);
assert.equal(rendered.root.findByType('Star').props.fill, 'none');
assert.equal(rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.disabled, true, '写入未完成时重新打开菜单不能重复操作');
await renderer.act(async () => finishRemoval());
repository.removeInTransaction = removeInTransaction;
assert.equal(await favorites.getChatFavoriteByMessage(actionMessage.id), null);
assert.equal(rendered.root.findByType('Star').props.fill, 'none');
assert.ok(rendered.root.findByProps({ accessibilityLabel: '收藏' }));
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.onPress());
await favorites.removeChatFavorite((await favorites.getChatFavoriteByMessage(actionMessage.id)).id);
await openFavoriteMenu(actionMessage);
assert.ok(rendered.root.findByProps({ accessibilityLabel: '收藏' }), '收藏页取消后重新打开菜单必须读取最新状态');

// 旧消息的慢查询不能覆盖新选择；状态未知期间不能把已收藏误当成未收藏。
const getBySource = repository.getBySource.bind(repository);
let finishStatusRead;
repository.getBySource = async id => id === actionMessage.id
  ? new Promise(resolve => { finishStatusRead = resolve; }) : getBySource(id);
await openFavoriteMenu(actionMessage);
assert.equal(rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.disabled, true);
await renderer.act(async () => rendered.update(React.createElement(FavoriteMenu, { message: otherActionMessage })));
await renderer.act(async () => finishStatusRead(menuFavorite));
assert.equal(rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.disabled, false);
assert.equal(rendered.root.findByType('Star').props.fill, 'none');
repository.getBySource = async () => { throw new Error('读取失败'); };
await openFavoriteMenu(actionMessage);
assert.equal(dialog.title, '收藏状态加载失败');
assert.equal(rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.disabled, true);
repository.getBySource = getBySource;
await openFavoriteMenu(actionMessage);
db.prepare('DELETE FROM messages WHERE id=?').run(actionMessage.id);
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '收藏' }).props.onPress());
assert.equal(dialog.title, '收藏失败');
assert.ok(rendered.root.findByProps({ accessibilityLabel: '收藏' }), '写入失败不能显示已收藏');
await renderer.act(async () => rendered.unmount());
db.exec("DELETE FROM messages; DELETE FROM sessions; DELETE FROM ai_assistants; DELETE FROM chat_conversations;");
// 二级气泡只附同一逻辑消息的思考，不把整轮的其他模型步骤或其他会话拼进来。
db.prepare("INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('a','agent-a','测试 AI','test',?,?)").run(t, t);
db.prepare("INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES ('s','a','测试聊天',?,?)").run(t, t);
db.exec("INSERT INTO chat_conversations VALUES ('s','direct')");
db.prepare("INSERT INTO group_chats(id,name,created_at,updated_at) VALUES ('g','思维链测试群',?,?)").run(t, t);
db.exec("INSERT INTO chat_conversations VALUES ('g','group')");
const firstThought = insert('第一步思考：先查资料', { replyRunId: 'favorite-run', stepIndex: 1 }, 'reasoning');
const firstReply = insert('步骤一正文', { replyRunId: 'favorite-run', stepIndex: 1 }, 'assistant');
const secondThought = insert('第二步思考：独有检索词', { replyRunId: 'favorite-run', stepIndex: 2 }, 'reasoning');
const secondReplies = ['收藏二级正文A', '收藏二级正文B'].map(text => insert(text, { replyRunId: 'favorite-run', stepIndex: 2 }, 'assistant'));
const mediaReplies = [
  insert('图片配文', { attachments: [image('sticker')] }, 'assistant'),
  insert('语音转写', { kind: 'voice', voice }, 'assistant'),
  insert('文件配文', { attachments: saved[4].snapshot.attachments }, 'assistant'),
];
const userWithLogicalId = insert('用户也有逻辑分段');
const streamingThought = insert('仍在生成的思考', null, 'reasoning', { status: 'streaming' });
const cancelledThought = insert('被取消的思考', null, 'reasoning');
db.prepare("UPDATE messages SET delivery_status='cancelled' WHERE id=?").run(cancelledThought);
for (const id of [firstThought, firstReply]) db.prepare('UPDATE messages SET logical_message_id=? WHERE id=?').run('favorite-run:step:1', id);
for (const id of [secondThought, ...secondReplies, ...mediaReplies, userWithLogicalId, streamingThought, cancelledThought]) {
  db.prepare('UPDATE messages SET logical_message_id=? WHERE id=?').run('favorite-run:step:2', id);
}
for (const [index, id] of secondReplies.entries()) db.prepare('UPDATE messages SET segment_index=?, segment_total=2 WHERE id=?').run(index, id);
const groupThought = insert('群里单独的思考', null, 'reasoning');
const groupReply = insert('群聊收藏二级正文', null, 'assistant');
db.prepare("UPDATE messages SET session_id='g', logical_message_id='favorite-run:step:2' WHERE id IN (?,?)").run(groupThought, groupReply);
const firstFavorite = await save(firstReply);
const secondFavorites = await Promise.all(secondReplies.map(save));
assert.equal(firstFavorite.snapshot.reasoningText, '第一步思考：先查资料');
assert.ok(secondFavorites.every(item => item.snapshot.reasoningText === '第二步思考：独有检索词'));
assert.deepEqual(secondFavorites.map(item => item.snapshot.text), ['收藏二级正文A', '收藏二级正文B'], '收藏仍只保留选中的单个二级气泡正文');
const groupFavorite = await favorites.createChatFavorite({ messageId: groupReply, sourceName: '思维链测试群' });
assert.equal(groupFavorite.snapshot.reasoningText, '群里单独的思考');
for (const id of [...mediaReplies, userWithLogicalId, insert('附近有思考但没有归属的文字', null, 'assistant')]) {
  assert.equal((await save(id)).snapshot.reasoningText, undefined, '媒体、用户消息和没有关联身份的正文不附加思维链');
}
const toolsOnlyReply = insert('只有工具步骤的正文', { replyRunId: 'favorite-run', stepIndex: 3 }, 'assistant');
const toolSteps = [insert('正在搜索', { type: 'toolStatus' }, 'system'), insert('工具返回结果', null, 'tool')];
for (const id of [toolsOnlyReply, ...toolSteps]) db.prepare('UPDATE messages SET logical_message_id=? WHERE id=?').run('favorite-run:step:3', id);
assert.equal((await save(toolsOnlyReply)).snapshot.reasoningText, undefined, '同轮其他步骤有思考，但当前回复只有工具步骤时不附思维链');
assert.deepEqual(await searchIds('独有检索词'), secondFavorites.map(item => item.id).sort(), '搜索包含收藏的思维链正文');
db.prepare('UPDATE messages SET text=? WHERE id=?').run('后来被修改的思考', secondThought);
assert.equal((await save(secondReplies[1])).snapshot.reasoningText, '第二步思考：独有检索词', '重复收藏不改写原快照');
db.prepare("DELETE FROM messages WHERE logical_message_id IN ('favorite-run:step:1', 'favorite-run:step:2')").run();
assert.equal((await favorites.getChatFavoriteByMessage(secondReplies[1])).snapshot.reasoningText, '第二步思考：独有检索词', '原文和思维链删除后收藏仍独立保留');

focused = true;
await renderer.act(async () => { rendered = renderer.create(React.createElement(Screen, { onBack() {} })); });
await renderer.act(async () => searchInput().props.onChangeText('收藏二级正文B'));
assert.ok(rendered.root.findAllByType('Text').some(node => node.props.children === '含思维链'));
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '查看收藏内容' }).props.onPress());
const thoughtIsVisible = () => rendered.root.findAllByType('Text').some(node => node.props.children === '第二步思考：独有检索词' && node.props.selectable);
assert.equal(thoughtIsVisible(), false, '收藏详情默认折叠思维链');
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '展开思维链' }).props.onPress());
assert.equal(thoughtIsVisible(), true, '思维链可展开并选择复制');
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '收起思维链' }).props.onPress());
assert.equal(thoughtIsVisible(), false);
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '展开思维链' }).props.onPress());
await renderer.act(async () => rendered.root.findAllByType('Header').find(node => node.props.title === '收藏详情').props.onGoBack());
await renderer.act(async () => rendered.root.findByProps({ accessibilityLabel: '查看收藏内容' }).props.onPress());
assert.equal(thoughtIsVisible(), false, '重新打开详情从折叠状态开始');
await renderer.act(async () => rendered.unmount());
db.prepare("UPDATE chat_favorites SET snapshot_json=json_set(snapshot_json, '$.reasoningText', 123) WHERE id=?").run(secondFavorites[0].id);
await assert.rejects(favorites.getChatFavoriteByMessage(secondReplies[0]), /收藏记录损坏/);
db.prepare('UPDATE chat_favorites SET snapshot_json=? WHERE id=?').run(JSON.stringify(secondFavorites[0].snapshot), secondFavorites[0].id);
const countBeforeDamage = db.prepare('SELECT COUNT(*) n FROM chat_favorites').get().n;
db.prepare('UPDATE chat_favorites SET snapshot_json=? WHERE id=?').run('{"text":123}', saved[0].id);
await assert.rejects(favorites.listChatFavorites('text'), /收藏记录损坏/);
assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_favorites').get().n, countBeforeDamage, '损坏快照明确报告，不静默删除收藏');
db.close();
console.log('verify-chat-favorites: 归属身份升级、名称与昵称更新、正文/语音/角色搜索及分页、搜索交互与异步竞态、快照、分类、幂等、菜单、删除竞态、媒体、备份恢复和文件策略通过。');
