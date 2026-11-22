/** 真实 SQLite 验证回收、恢复、到期竞争及跨空间历史保留。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from '../helpers/load-typescript-module.mjs';
import { bootstrapSqlite, createSqliteExecutor, DATABASE_SCHEMA_VERSION } from '../helpers/sqlite-bootstrap-fixture.mjs';
import { createCoordinatedSqliteFixture } from '../helpers/coordinated-sqlite-fixture.mjs';

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const raw = createSqliteExecutor(db);
await bootstrapSqlite(raw);
const { databaseCoordinator, executor } = createCoordinatedSqliteFixture(raw);
const persistence = { databaseCoordinator };
const hostDomain = load('src/features/assistants/domain/HostRepository.ts');
const hostRepository = load('src/features/assistants/infrastructure/SQLiteHostRepository.ts', {
  '@platform/persistence': persistence, '../domain/HostRepository': hostDomain,
});
const recycleDomain = load('src/features/assistants/domain/AssistantRecycleBin.ts');
const { SQLiteAssistantRecycleBinRepository } = load('src/features/assistants/infrastructure/SQLiteAssistantRecycleBinRepository.ts', {
  '@platform/persistence': persistence, '@features/media': { resolveMediaAssetReferenceUri: async input => input.legacyUri },
  '../domain/AssistantRecycleBin': recycleDomain, '../domain/HostRepository': hostDomain,
  './SQLiteHostRepository': hostRepository,
});
const recycle = new SQLiteAssistantRecycleBinRepository();
const lifecycleChanges = [];
const restore = async (id, now) => (await recycle.restore(id, now, async (_tx, change) => { lifecycleChanges.push(change); return () => {}; })) !== null;
const presentationSql = load('src/features/chat/reply/infrastructure/ChatTurnPresentationSql.ts', {
  './ChatReplyVersionSql': {},
  '../../messages/infrastructure/SQLiteMessageRepository': { messageRepository: {} },
  '../../messages/domain/chatMessageMetadata': {},
});
const turnDomain = load('src/features/chat/reply/domain/ConversationTurn.ts');
const { ConversationTurnRepository } = load('src/features/chat/reply/infrastructure/SQLiteConversationTurnRepository.ts', {
  '@platform/persistence': persistence, './ChatTurnPresentationSql': presentationSql,
  '../../messages/infrastructure/ChatMessageMutationSql': {}, '../../messages/infrastructure/SQLiteMessageRepository': { messageRepository: {} },
  '../domain/ConversationTurn': turnDomain, '../../messages/domain': {}, './ChatReplyVersionSql': {},
});
const turns = new ConversationTurnRepository();
const chatLifecycle = load('src/features/chat/conversation/infrastructure/AssistantChatLifecycle.ts', {
  '../../reply/infrastructure/SQLiteConversationTurnRepository': { conversationTurnRepository: turns },
});
const momentLifecycle = load('src/features/moments/infrastructure/AssistantMomentLifecycle.ts');
const scheduleLifecycle = load('src/features/companion/infrastructure/AssistantScheduleLifecycle.ts');
const momentErrors = load('src/features/moments/domain/MomentErrors.ts');
const { SQLiteMomentRepository } = load('src/features/moments/infrastructure/SQLiteMomentRepository.ts', {
  '@platform/persistence': persistence, '../domain/MomentErrors': momentErrors,
});
const moments = new SQLiteMomentRepository();
const { SQLiteMediaAssetRepository } = load('src/features/media/infrastructure/SQLiteMediaAssetRepository.ts');
const media = new SQLiteMediaAssetRepository(executor);
const { AIAssistantRepository } = load('src/features/assistants/infrastructure/SQLiteAssistantRepository.ts', {
  '@platform/persistence': persistence, './SQLiteModelServiceRepository': {}, '../domain/ModelService': {},
  '@features/profile': { removeConversationWallpaperInTransaction: async () => null },
  '@features/media': { resolveMediaAssetReferenceUri: async input => input.legacyUri,
    collectAssistantMediaAssetCandidatesInTransaction: (tx, id) => media.listAssistantMediaAssetIds(id, tx),
    collectChatSessionMediaAssetCandidatesInTransaction: (tx, ids) => media.listChatSessionMediaAssetIds(ids, tx) },
  '../domain/AIProfile': { createAIProfile: value => value }, '../domain/HostRepository': hostDomain,
});
const assistants = new AIAssistantRepository();
const { GroupChatRepository } = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts', {
  '@platform/persistence': persistence, '@features/assistants': {}, '@features/profile': {},
  '@features/media': { resolveMediaAssetReferenceUri: async input => input.legacyUri },
});
const groups = new GroupChatRepository();
const now = new Date().toISOString();
const addAssistant = id => db.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run(id, `agent-${id}`, id, 'model', now, now);
addAssistant('one'); addAssistant('two');
for (const id of ['avatar-one', 'moment-shared', 'private-file']) db.prepare(`INSERT INTO media_assets
  (id,storage_backend,storage_key,hash_algorithm,content_hash,mime_type,byte_size,status,created_at,updated_at)
  VALUES(?,'persistent-image',?,'sha256',?,'image/png',10,'ready',?,?)`).run(id, id, 'a'.repeat(64), now, now);
db.prepare('UPDATE ai_assistants SET avatar_media_asset_id=?,is_host_ai=1,is_ledger_ai=1 WHERE id=?').run('avatar-one', 'one');
db.exec(`INSERT INTO chat_conversations VALUES ('direct-one','direct'), ('group','group');
  INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES('direct-one','one','chat','${now}','${now}');
  INSERT INTO group_chats(id,name,created_at,updated_at) VALUES('group','group','${now}','${now}');
  INSERT INTO group_chat_members(id,group_id,ai_assistant_id,agent_id,created_at,updated_at) VALUES('member','group','one','agent-one','${now}','${now}');
  INSERT INTO messages(session_id,agent_id,text,is_me,sender_type,time,created_at,status)
    VALUES('direct-one','agent-one','private',0,'assistant','12:00','${now}','sent'),
    ('group','agent-one','group history',0,'assistant','12:01','${now}','sent');
  INSERT INTO conversation_turn_runs(run_id,session_id,kind,reply_cursor_at_claim,input_high_watermark,revision_at_claim,status,created_at)
    VALUES('old-run','direct-one','user_reply',0,1,1,'active','${now}');
  INSERT INTO conversation_turn_state(session_id,reply_cursor,revision,active_run_id,active_run_kind,updated_at)
    VALUES('direct-one',0,1,'old-run','user_reply','${now}');`);
db.prepare("UPDATE messages SET metadata_json=? WHERE text='private'").run(JSON.stringify({ attachments: [{ mediaAssetId: 'private-file' }] }));
db.prepare("INSERT INTO group_speech_plans(id,group_id,status,created_at,updated_at) VALUES('plan','group','running',?,?)").run(now, now);
const addGroupTask = (id, status) => db.prepare(`INSERT INTO group_speech_tasks
  (id,plan_id,group_id,ai_assistant_id,agent_id,sequence_order,source,status,created_at,updated_at)
  VALUES(?,'plan','group','one','agent-one',0,'test',?,?,?)`).run(id, status, now, now);
addGroupTask('running-task', 'running');
assert.equal((await groups.getMembers('group')).length, 1);
for (const [id, authorType, authorId] of [['own', 'ai', 'agent-one'], ['other', 'ai', 'agent-two'], ['user', 'user', 'self']]) {
  await moments.createMoment({ id, authorType, authorId, authorNameSnapshot: authorId, content: id,
    locationLabel: null, audience: { mode: 'all' }, deliveryRecipientAgentIds: ['agent-two'],
    media: id === 'own' ? [{ id: 'own-media', mediaAssetId: 'moment-shared', sortOrder: 0 }] : [] });
}
await moments.insertComments([{ id: 'trace', momentId: 'other', authorType: 'ai', authorId: 'agent-one',
  authorNameSnapshot: 'one', parentCommentId: null, content: 'external comment' }]);
await moments.insertLike({ momentId: 'user', actorType: 'ai', actorId: 'agent-one', actorNameSnapshot: 'one' });

// 分享快照独立于来源；源动态隐藏或清除不改写已经发送的消息。
const snapshot = JSON.stringify({ messageShare: { messages: [{ text: 'private snapshot' }] }, momentShare: { content: 'own snapshot', media: [{ mediaAssetId: 'moment-shared' }] } });
db.prepare(`INSERT INTO messages(session_id,text,is_me,sender_type,time,created_at,status,metadata_json)
  VALUES('group','shared',1,'user','12:02',?,'sent',?)`).run(now, snapshot);
const suspend = tx => chatLifecycle.suspendAssistantChatInTransaction(tx, 'one');
const moved = await recycle.recycle('one', async (tx, change) => { lifecycleChanges.push(change); return suspend(tx); });
assert.ok(moved);
assert.equal(moved.wasHost, true);
assert.equal((await groups.getMembers('group')).length, 0, '回收成员退出当前参与者目录');
assert.equal(await groups.isSpeechTaskCommitEligible('plan', 'running-task'), false, '在途群聊发言已失去提交资格');
addGroupTask('late-queued-task', 'queued');
assert.equal(await groups.claimNextQueuedSpeechTask('plan'), null, '回收后迟到的排队请求也不得领取');
const deletedAt = (await recycle.getDeletion('one')).deletedAt;
assert.deepEqual(lifecycleChanges[0], { assistantId: 'one', assistantDisplayName: 'one', change: 'recycled', occurredAt: deletedAt, deletedAt, wasHost: true, wasLedger: true });
assert.deepEqual(await assistants.listIds(), ['two']);
assert.equal(await assistants.getById('one'), null);
assert.equal((await recycle.list())[0].id, 'one');
assert.equal(db.prepare('SELECT last_revoked_ai_id FROM host_ai_relationship_state').get().last_revoked_ai_id, 'one');
assert.deepEqual(await executor.withExclusiveTransactionAsync(tx => media.releaseUnreferencedAssetsInTransaction(tx, ['avatar-one', 'moment-shared', 'private-file'])), [], '回收期内媒体引用仍然有效');
assert.equal(db.prepare("SELECT text FROM messages WHERE session_id='direct-one'").get().text, 'private');
assert.equal(db.prepare("SELECT status FROM conversation_turn_runs WHERE run_id='old-run'").get().status, 'cancelled');
assert.equal(db.prepare("SELECT active_run_id FROM conversation_turn_state WHERE session_id='direct-one'").get().active_run_id, null);
assert.equal(await moments.getMomentForUser('own'), null);
assert.equal(await moments.getVisibleMomentForAgent('agent-two', 'own'), null);
assert.equal((await moments.listMomentTimelineForUser()).length, 2);
assert.equal((await moments.queryVisibleMomentsForAgent('agent-two', { limit: 10 })).length, 2);
assert.equal((await moments.listComments('other'))[0].content, 'external comment');
assert.equal((await moments.listLikes('user'))[0].actorId, 'agent-one');
assert.equal((await moments.listUnreadSocialDeliveries('agent-two')).some(item => item.sourceMomentId === 'own'), false);
assert.equal(db.prepare("SELECT metadata_json FROM messages WHERE text='shared'").get().metadata_json, snapshot);
assert.equal(await recycle.recycle('one', suspend), null, '重复删除不延长保留期');
assert.equal((await recycle.getDeletion('one')).deletedAt, deletedAt);

// 恢复保留原身份、原会话和正文，不恢复旧 run 的提交资格。
const cooldownBeforeRestore = await hostRepository.aiHostRepository.checkHostCooldown();
assert.equal(await hostRepository.aiHostRepository.releaseAppointmentCooldown('one'), false, '回收中的原主理不能解除冷静期');
db.prepare("UPDATE ai_assistants SET is_ledger_ai=1 WHERE id='two'").run();
await assert.rejects(recycle.restore('one', new Date(), async () => { throw new Error('恢复事件写入失败'); }), /恢复事件写入失败/);
assert.ok(await recycle.getDeletion('one'), '恢复知情记录失败时恢复本身也回滚');
assert.equal(await restore('one', new Date()), true);
assert.equal(lifecycleChanges.at(-1).deletedAt, deletedAt);
assert.equal(lifecycleChanges.at(-1).change, 'restored');
assert.equal((await assistants.getLedgerAI()).id, 'two', '恢复不覆盖用户另行指派的记账 AI');
assert.deepEqual(await hostRepository.aiHostRepository.checkHostCooldown(), cooldownBeforeRestore, '恢复不重置或延长冷静期');
await recycle.recycle('one', suspend);
assert.deepEqual(await hostRepository.aiHostRepository.checkHostCooldown(), cooldownBeforeRestore, '冷静期内再次回收普通 AI 不重新开启计时');
await restore('one', new Date());
assert.deepEqual(await hostRepository.aiHostRepository.checkHostCooldown(), cooldownBeforeRestore);
const { prepareHostModelRun } = load('src/host/runtime/HostModelRunPreparation.ts', {
  '@features/assistants': { getHostAICooldownStatus: async () => ({ appointment: await hostRepository.aiHostRepository.checkHostCooldown() }),
    ReleaseHostCooldownTool: { name: 'release_host_cooldown' } },
  './TogetherListeningRunPreparation': { prepareTogetherListeningHostModelRun: async () => ({ managedToolNames: [], dynamicAllowedToolNames: [] }) },
});
const exposure = await prepareHostModelRun({ currentAiId: 'one', persistentAllowedToolNames: ['release_host_cooldown'] });
assert.ok(exposure.dynamicAllowedToolNames.includes('release_host_cooldown'), '恢复后的原主理保留已授权的解除工具');
assert.equal(await hostRepository.aiHostRepository.releaseAppointmentCooldown('one'), true);
assert.equal((await assistants.getById('one')).isHostAI, false, '解除冷静期不会自动任命');
assert.equal((await assistants.getById('one')).agentId, 'agent-one');
assert.equal((await assistants.getById('one')).isHostAI, false);
assert.equal((await assistants.getById('one')).isLedgerAI, false);
assert.equal((await groups.getMembers('group')).length, 1, '恢复沿用原成员关系');
assert.equal(await groups.claimNextQueuedSpeechTask('plan'), null, '恢复不重跑旧群聊机会');
addGroupTask('new-group-task', 'queued');
assert.equal((await groups.claimNextQueuedSpeechTask('plan')).id, 'new-group-task', '恢复后新的群聊机会正常领取');
assert.ok(await moments.getMomentForUser('own'));
assert.equal(db.prepare("SELECT status FROM conversation_turn_runs WHERE run_id='old-run'").get().status, 'cancelled');
const beforeDelete = async (tx, agentId) => {
  await scheduleLifecycle.purgeAssistantSchedulesInTransaction(tx, 'one');
  return [...await chatLifecycle.purgeAssistantChatInTransaction(tx, 'one'), ...await momentLifecycle.purgeAssistantMomentsInTransaction(tx, agentId)];
};
assert.equal((await assistants.delete('one', { deletedAt, beforeDelete })).deleted, false, '迟到的清理不得删除已经恢复的 AI');

// 事务失败必须同时回滚隐藏状态及执行所有权变更。
await assert.rejects(recycle.recycle('one', async tx => { await suspend(tx); throw new Error('rollback'); }), /rollback/);
assert.notEqual(await assistants.getById('one'), null);
assert.equal(await recycle.getDeletion('one'), null);

// 七天边界恰好到期后不可恢复，旧清理批次不能误删重新进入回收站的身份。
await recycle.recycle('one', suspend);
const expiry = new Date(Date.now() + recycleDomain.ASSISTANT_RECYCLE_RETENTION_MS);
assert.equal(await restore('one', expiry), false);
const expired = (await recycle.listExpired(expiry)).find(item => item.id === 'one');
assert.ok(expired);
assert.equal(await restore('one', new Date(Date.parse(expired.deletedAt) + recycleDomain.ASSISTANT_RECYCLE_RETENTION_MS - 1)), true);
await recycle.recycle('one', suspend);
const currentDeletion = await recycle.getDeletion('one');
if (currentDeletion.deletedAt === expired.deletedAt) {
  db.prepare('UPDATE ai_assistants SET deleted_at=? WHERE id=?').run(new Date(Date.parse(expired.deletedAt) + 1).toISOString(), 'one');
}
assert.equal((await assistants.delete('one', { deletedAt: expired.deletedAt, beforeDelete })).deleted, false);
const deletion = await recycle.getDeletion('one');
const purged = await assistants.delete('one', { deletedAt: deletion.deletedAt, beforeDelete });
assert.equal(purged.deleted, true);
const released = await executor.withExclusiveTransactionAsync(tx => media.releaseUnreferencedAssetsInTransaction(tx, purged.mediaAssetCandidates));
assert.deepEqual(released.map(item => item.id).sort(), ['avatar-one', 'private-file']);
assert.ok(await media.getById('moment-shared'), '分享快照引用的媒体不能随原 AI 或动态清理');
assert.equal(db.prepare("SELECT 1 FROM sessions WHERE id='direct-one'").get(), undefined);
assert.equal(db.prepare("SELECT 1 FROM messages WHERE text='private'").get(), undefined);
assert.equal(db.prepare("SELECT 1 FROM moments WHERE id='own'").get(), undefined);
assert.equal(db.prepare("SELECT text FROM messages WHERE text='group history'").get().text, 'group history');
assert.equal(db.prepare("SELECT metadata_json FROM messages WHERE text='shared'").get().metadata_json, snapshot);
assert.equal((await moments.listComments('other'))[0].authorId, 'agent-one');
assert.equal((await moments.listLikes('user'))[0].actorId, 'agent-one');
assert.equal(await restore('one', new Date()), false);
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

// 用户输入尚未取得 run 时也必须被取消；恢复只接受后来的新输入。
addAssistant('pending');
db.prepare("INSERT INTO chat_conversations VALUES('pending-direct','direct')").run();
db.prepare("INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at) VALUES('pending-direct','pending','pending',?,?)").run(now, now);
const addInput = text => db.prepare("INSERT INTO messages(session_id,text,is_me,sender_type,time,created_at,status) VALUES('pending-direct',?,1,'user','12:00',?,'sent')").run(text, now);
addInput('old queued input');
await recycle.recycle('pending', tx => chatLifecycle.suspendAssistantChatInTransaction(tx, 'pending'));
assert.equal(await turns.claimIfIdle('pending-direct', 'user_reply'), null);
assert.equal(await turns.claimAutonomousIfIdle('pending-direct', 'autonomous'), null);
await restore('pending', new Date());
assert.equal(await turns.claimIfIdle('pending-direct', 'user_reply'), null, '恢复不能领取回收前排队的输入');
addInput('new input after restore');
assert.ok(await turns.claimIfIdle('pending-direct', 'user_reply'), '恢复后新的真实消息仍可正常回复');

// 已发布旧库升级只增加回收字段，不丢失原数据；重复初始化不复写删除时间。
db.exec('ALTER TABLE ai_assistants DROP COLUMN deleted_at; PRAGMA user_version=176;');
await bootstrapSqlite(raw);
assert.equal(db.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
assert.equal((await assistants.getById('two')).name, 'two');
await recycle.recycle('two', async () => {});
const persisted = await recycle.getDeletion('two');
await bootstrapSqlite(raw);
assert.deepEqual(await recycle.getDeletion('two'), persisted);
assert.ok(await recycle.getNextExpiry());
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
db.close();

// 用受控时钟验证真实维护入口，不等待七天，也不额外创建后台执行流程。
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realNow = Date.now;
try {
  let clock = 10_000;
  let deadline = clock + 1_000;
  let runs = 0;
  let lifecycle;
  let foreground;
  let lastTask;
  const timers = new Map();
  let nextTimer = 0;
  Date.now = () => clock;
  globalThis.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const maintenance = load('src/host/runtime/AssistantRecycleBinMaintenance.ts', {
    'react-native': { AppState: { addEventListener: (_event, callback) => { foreground = callback; return { remove() { foreground = null; } }; } } },
    '@features/assistants': { purgeExpiredAIAssistants: async () => { runs++; },
      subscribeAssistantLifecycleChanged: callback => { lifecycle = callback; return () => { lifecycle = null; }; } },
    '@features/assistants/composition': { getNextAIRecycleBinExpiry: async () => deadline },
  });
  const stop = maintenance.startAssistantRecycleBinMaintenance(task => { lastTask = task; return task; });
  const settle = async () => { await lastTask; await Promise.resolve(); await Promise.resolve(); };
  await settle();
  assert.equal(runs, 1, '启动主动清理已到期项');
  assert.equal([...timers.values()][0].delay, 1_000);
  assert.equal(timers.size, 1);
  lifecycle(); foreground('active');
  await settle();
  assert.equal(runs, 3, '运行期间的新请求在当前快照结束后合并处理');
  assert.equal(timers.size, 1, '多个生命周期事件只保留一个到期时钟');
  clock = deadline; deadline = null;
  const [timerId, timed] = [...timers.entries()][0];
  timers.delete(timerId); timed.callback();
  await settle();
  assert.equal(runs, 4, '到期自动调用唯一清理命令');
  assert.equal(timers.size, 0, '空回收站不轮询');
  stop();
  assert.equal(lifecycle, null);
  assert.equal(foreground, null);
} finally {
  globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; Date.now = realNow;
}
console.log('AI 回收站验证通过：隐藏、恢复、七天边界、事务回滚、清理竞争、跨空间历史及旧库升级。');
