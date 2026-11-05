/** 昵称当前值与操作历史的原子性、窗口、摘要和名称隐私行为验证。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
function load(file, mocks = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(root, path.dirname(file), `${name}.ts`)), mocks);
    throw new Error(`${file} 缺少测试依赖 ${name}`);
  }, module, module.exports);
  return module.exports;
}

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
const executor = createSqliteExecutor(db);
await bootstrapSqlite(executor);
let pendingTransaction = Promise.resolve();
const database = {
  ...executor,
  withExclusiveTransactionAsync(task) {
    const result = pendingTransaction.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await task(executor); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    pendingTransaction = result.catch(() => {});
    return result;
  },
};
const { AIAssistantRepository } = load('src/features/assistants/infrastructure/SQLiteAssistantRepository.ts', {
  '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => database, transaction: (_, task) => database.withExclusiveTransactionAsync(task) } },
  '@features/profile': {}, '@features/media': { resolveMediaAssetReferenceUri: () => null },
  './SQLiteAuxiliaryModelDefaults': {}, './SQLiteAuxiliaryModelRepository': {},
  '../application/AuxiliaryModelInitialization': {},
  '../domain/AIProfile': { createAIProfile: (data) => data },
});
const repository = new AIAssistantRepository();
const nickname = load('src/features/assistants/AssistantNickname.ts', {
  './infrastructure/SQLiteAssistantRepository': { aiAssistantRepository: repository },
});
for (const id of ['self', 'other']) {
  db.prepare('INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `actor-${id}`, `原名-${id}`, 'test', '2026-10-13', '2026-10-13');
}

const coordinator = { openTaskExecutor: () => database, transaction: (_, task) => database.withExclusiveTransactionAsync(task) };
const persistence = { '@platform/persistence': { databaseCoordinator: coordinator } };
const { SessionRepository } = load('src/features/chat/conversation/infrastructure/SQLiteSessionRepository.ts', persistence);
const { MessageRepository } = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts', persistence);
const sessions = new SessionRepository(), messages = new MessageRepository();
let notifications = 0;
const { recordAssistantNicknameChangeInTransaction } = load('src/features/chat/messages/application/RecordAssistantNicknameChange.ts', {
  '../../conversation/application/ChatConversationRuntime': { getChatConversationRuntimeDependencies: () => ({ sessions }) },
  './ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => ({ messages }) },
  '../events/ChatEvents': { emitChatMessagesUpdated: () => { notifications += 1; } },
});
const management = load('src/features/assistants/AIAssistantManagement.ts', {
  ...persistence, '@features/media': {}, '@platform/device/DeviceMediaService': {},
  '@shared/errors/SettingChangeConflictError': { SettingChangeConflictError: Error },
  '@shared/runtime/abortSignal': {}, './domain/ApplicationSettingsAccess': {}, './domain/HostRepository': {},
  './application/HostAuthorityCoordinator': { HostAuthorityCoordinator: class {} },
  './infrastructure/SQLiteAssistantRepository': { aiAssistantRepository: repository },
  './infrastructure/SQLiteHostRepository': { aiHostRepository: {} },
});
management.configureAssistantRuntime({ recordNicknameChangeInTransaction: recordAssistantNicknameChangeInTransaction });
const update = (id, patch) => management.updateAIAssistantSettings(id, patch);
const session = await sessions.resolveCanonicalConversation('self');
const otherSession = await sessions.resolveCanonicalConversation('other');
const say = async (text, isMe = true) => messages.commitMessage({ message: { sessionId: session.id, text, isMe,
  senderType: isMe ? 'user' : 'assistant', status: 'sent', deliveryStatus: 'delivered', createdAt: new Date().toISOString(), time: '12:00' }, previewText: text });
assert.equal((await nickname.getAssistantNicknamePromptContext('self')).content, '');
assert.equal(await update('deleted', { nickname: '不存在' }), false);
await update('other', { nickname: '别人的私密备注' });
await say('我要改你的昵称');
await say('你不能这样对我', false);
await update('self', { nickname: 'daddy' });
const event = db.prepare("SELECT * FROM messages WHERE session_id=? AND sender_type='system'").get(session.id);
assert.match(event.text, /从未设置昵称修改为"daddy"/);
const eventSnapshot = { ...event };
await update('self', { nickname: 'daddy' });
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id=? AND sender_type='system'").get(session.id).n, 1);
await say('换回去！', false);
const current = await nickname.getAssistantNicknamePromptContext('self');
assert.match(current.content, /daddy/);
assert.doesNotMatch(current.content, /别人的私密备注|修改为|变化历史/);
assert.equal(notifications, 2, '两个 AI 的真实改名分别只通知一次');
assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE session_id=?').get(otherSession.id).n, 1);

const { SQLiteChatSummaryRepository } = load('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts', {
  ...persistence, '@shared/prompt': { estimateTextTokens: text => text.length },
});
const summary = new SQLiteChatSummaryRepository(async () => []);
const snapshot = await summary.readContext(session.id, []);
assert.deepEqual(snapshot.timeline.map(item => item.kind), ['dialogue', 'dialogue', 'app_event', 'dialogue']);
assert.match(snapshot.timeline[2].content, /assistant_nickname_changed/);
assert.equal(snapshot.timeline[2].speaker, 'application');
const { PromptHistoryBuilder } = load('src/host/prompt/PromptHistoryBuilder.ts', {
  '@features/chat': { getChatSummaryContext: (id, ids = []) => summary.readContext(id, ids),
    getChatInterruptedTurnContext: async () => [], ...load('src/features/chat/messages/domain/chatMessageMetadata.ts') },
});
// 摘要消费应用事件，但事件不计入对话条数。
await executor.runAsync('INSERT INTO conversation_turn_state(session_id,reply_cursor,revision,updated_at) VALUES (?,?,0,?)',
  [session.id, 999999, new Date().toISOString()]);
const claim = await summary.claim(session.id, 3, 'nickname-summary', '2090-01-01', '2091-01-01', 'Asia/Shanghai', 0);
assert.ok(claim.messages.some(item => item.kind === 'app_event' && item.content.includes('assistant_nickname_changed')));
assert.equal(claim.messages.filter(item => item.kind === 'dialogue').length, 3);
await summary.releaseClaim(claim);
await summary.updateSettings(session.id, { generationEnabled: false });
const historyParams = { sessionId: session.id, aiConfig: { id: 'self' }, currentInput: '',
  runtimeContext: { forceAppendUserText: true, recentWindowLimit: 3 } };
const history = await new PromptHistoryBuilder().loadPrivateSummaryContext(historyParams);
assert.equal(history.messages[2].role, 'user', '用户操作按来源标识后作为历史资料，不使用指令权限');
assert.match(history.messages[2].content, /assistant_nickname_changed/);
await say('再聊一句');
assert.deepEqual({ ...db.prepare('SELECT * FROM messages WHERE id=?').get(event.id) }, eventSnapshot,
  '后续聊天不能改写操作事件或消费历史资格');
assert.ok((await new PromptHistoryBuilder().loadPrivateSummaryContext(historyParams)).messages.some(item => item.content.includes('assistant_nickname_changed')));
historyParams.runtimeContext.recentWindowLimit = 1;
assert.ok(!(await new PromptHistoryBuilder().loadPrivateSummaryContext(historyParams)).messages.some(item => item.content.includes('assistant_nickname_changed')),
  '操作事件跟随对话窗口移出，不永久占据提示词');
await update('self', { name: '新的公开名称' });
assert.equal((await repository.getNicknameContext('self')).nickname, 'daddy');
await Promise.all([update('self', { nickname: '宝宝' }), update('self', { nickname: '亲爱的' })]);
const changes = db.prepare("SELECT metadata_json FROM messages WHERE session_id=? AND sender_type='system' ORDER BY id").all(session.id).map(row => JSON.parse(row.metadata_json));
assert.deepEqual(changes.slice(-2).map(item => [item.previousNickname, item.nickname]), [['daddy', '宝宝'], ['宝宝', '亲爱的']]);
const beforeFailure = { value: await repository.getNicknameContext('self'), count: changes.length, notifications };
db.exec(`CREATE TRIGGER reject_nickname_history BEFORE INSERT ON messages
  WHEN json_extract(NEW.metadata_json,'$.nickname')='保存失败' BEGIN SELECT RAISE(ABORT,'模拟历史写入失败'); END;`);
await assert.rejects(update('self', { nickname: '保存失败' }), /模拟历史写入失败/);
assert.deepEqual(await repository.getNicknameContext('self'), beforeFailure.value, '历史失败回滚昵称当前值');
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id=? AND sender_type='system'").get(session.id).n, beforeFailure.count);
assert.equal(notifications, beforeFailure.notifications, '回滚不发布历史变更');
await update('self', { nickname: null });
assert.equal((await nickname.getAssistantNicknamePromptContext('self')).content, '');
assert.match(db.prepare("SELECT text FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1").get(session.id).text, /修改为未设置昵称/);

const { parseAssistantProfileDraft } = load('src/features/assistants/presentation/profile/assistantProfileDraft.ts');
assert.deepEqual(parseAssistantProfileDraft({ nickname: '  老公  ' }, ['nickname']).patch, { nickname: '老公' });
assert.deepEqual(parseAssistantProfileDraft({ nickname: '   ' }, ['nickname']).patch, { nickname: null });
assert.ok(parseAssistantProfileDraft({ nickname: 'a\nb' }, ['nickname']).errors.nickname);
assert.ok(parseAssistantProfileDraft({ nickname: '长'.repeat(21) }, ['nickname']).errors.nickname);
assert.deepEqual(parseAssistantProfileDraft({ nickname: '🐈'.repeat(20) }, ['nickname']).patch, { nickname: '🐈'.repeat(20) });

const metadata = load('src/features/chat/messages/domain/chatMessageMetadata.ts');
// 原始 UTC 时刻与给模型的本地发生时间同时保留，避免把八点 UTC 说成上午八点。
const previousTZ = process.env.TZ;
try {
  for (const [zone, timestamp, expectedDate, expectedTime, offset] of [
    ['Asia/Shanghai', '2026-10-16T08:30:00.000Z', '2026/10/16', '16:30:00', 'GMT+08:00'],
    ['Asia/Shanghai', '2026-10-16T16:05:00.000Z', '2026/10/17', '00:05:00', 'GMT+08:00'],
    ['America/New_York', '2026-10-16T08:30:00.000Z', '2026/10/16', '04:30:00', 'GMT-04:00'],
  ]) {
    process.env.TZ = zone;
    const content = metadata.buildChatSystemEventModelText({ senderType: 'system', status: 'sent',
      createdAt: timestamp, text: '用户修改昵称', metadataJson: event.metadata_json });
    const projected = JSON.parse(content.slice(content.indexOf('\n') + 1));
    assert.equal(projected.timestamp, timestamp, '历史发生时刻不能因本地展示转换而改变');
    assert.ok(projected.localTime.includes(expectedDate));
    assert.ok(projected.localTime.includes(expectedTime), `${zone} 使用事件时刻，包含跨日和夏令时换算`);
    assert.ok(projected.localTime.includes(offset));
    assert.equal(projected.timeZone, zone);
  }
} finally {
  if (previousTZ === undefined) delete process.env.TZ;
  else process.env.TZ = previousTZ;
}
const { buildGroupMentionModelText } = load('src/features/chat/group/application/GroupMentionModelText.ts', {
  '../../messages/domain/chatMessageMetadata': metadata,
});
const message = { metadataJson: JSON.stringify({ groupChat: { mentions: [{
  actorType: 'user', target: { targetType: 'assistant', assistantId: 'self', displayNameAtSend: '老公' },
}] } }) };
assert.equal(buildGroupMentionModelText('@老公 看看这个，@老公甲不是你。', message,
  [{ aiAssistantId: 'self', name: '公开名' }]), '@公开名 看看这个，@老公甲不是你。');
assert.equal(buildGroupMentionModelText('@老公 看看这个。', message, []), '@已离开的AI 看看这个。');
const duplicateMention = { metadataJson: JSON.stringify({ groupChat: { mentions: [
  { actorType: 'user', target: { targetType: 'assistant', assistantId: 'self', displayNameAtSend: '同名' } },
  { actorType: 'user', target: { targetType: 'assistant', assistantId: 'other', displayNameAtSend: '同名' } },
] } }) };
assert.equal(buildGroupMentionModelText('@同名 看看这个。', duplicateMention,
  [{ aiAssistantId: 'self', name: '公开甲' }, { aiAssistantId: 'other', name: '公开乙' }]), '@公开甲、@公开乙 看看这个。');

const { loadMomentActorDirectory } = load('src/features/moments/application/MomentActorResolver.ts', {
  '@features/assistants': { ...nickname, listAIAssistants: async () => [{ id: 'self', agentId: 'actor-self', name: '公开名', nickname: '私密昵称', avatar: null }] },
  '@features/profile': { SELF_USER_PROFILE_ID: 'user', getCurrentUserProfile: async () => ({ name: '枫渡' }) },
});
assert.equal((await loadMomentActorDirectory()).actors[1].displayName, '公开名');
assert.equal((await loadMomentActorDirectory(undefined, 'user')).actors[1].displayName, '私密昵称');


// 旧库按原时刻交接已确认与未确认的事件，不复活用户清除过的范围。
const legacy = new DatabaseSync(':memory:');
legacy.exec('PRAGMA foreign_keys=ON');
const legacyExecutor = createSqliteExecutor(legacy);
await bootstrapSqlite(legacyExecutor);
// 还原 134 的结构，避免将当前 schema 仅改版本号后重复执行新增列迁移。
for (const table of ['auxiliary_model_configs', 'ai_assistants', 'group_chat_admin_configs']) {
  legacy.exec(`ALTER TABLE ${table} DROP COLUMN service_config_id`);
}
legacy.exec(`DROP TABLE model_service_configs; DROP TABLE model_service_settings;
 ALTER TABLE chat_summary_request_settings DROP COLUMN primary_limit;
 ALTER TABLE ai_assistants DROP COLUMN show_action_steps;
 ALTER TABLE ai_assistants DROP COLUMN streaming_reply;
 ALTER TABLE group_chat_members DROP COLUMN muted;
 ALTER TABLE group_chat_members DROP COLUMN joined_during_plan_id;`);
legacy.exec(`INSERT INTO ai_assistants(id,agent_id,name,model,created_at,updated_at) VALUES ('legacy','legacy-agent','AI','test','2026-01-01','2026-01-01');
 INSERT INTO chat_conversations(id,kind) VALUES ('legacy-chat','direct');
 INSERT INTO sessions(id,ai_assistant_id,name,created_at,updated_at,visible_after_at)
 VALUES ('legacy-chat','legacy','单聊','2026-01-01','2026-01-01','2026-02-01');
 CREATE TABLE assistant_nickname_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,
 assistant_id TEXT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,previous_nickname TEXT,
 nickname TEXT,acknowledged INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 INSERT INTO assistant_nickname_changes VALUES (1,'legacy',NULL,'旧昵称',0,'2026-01-10');
 INSERT INTO assistant_nickname_changes VALUES (2,'legacy','旧昵称','daddy',1,'2026-03-10');
 INSERT INTO assistant_nickname_changes VALUES (3,'legacy','daddy',NULL,0,'2026-03-11');
 ALTER TABLE raven_cat_ai_schedules DROP COLUMN system_calendar;
 PRAGMA user_version=134;`);
await assert.rejects(bootstrapSqlite({ ...legacyExecutor, execAsync: async sql => {
  if (sql.includes('PRAGMA user_version =')) throw new Error('迁移提交失败');
  return legacyExecutor.execAsync(sql);
} }), /迁移提交失败/);
assert.equal(legacy.prepare('SELECT COUNT(*) n FROM assistant_nickname_changes').get().n, 3);
assert.equal(legacy.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 134);
await bootstrapSqlite(legacyExecutor);
const migrated = legacy.prepare('SELECT * FROM messages ORDER BY created_at,id').all();
assert.deepEqual(migrated.map(row => row.created_at), ['2026-03-10', '2026-03-11']);
assert.match(migrated[0].text, /从"旧昵称"修改为"daddy"/);
assert.match(migrated[1].text, /修改为未设置昵称/);
assert.equal(legacy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='assistant_nickname_changes'").get().n, 0);
await bootstrapSqlite(legacyExecutor);
assert.equal(legacy.prepare('SELECT COUNT(*) n FROM messages').get().n, 2);
legacy.close();

db.close();
console.log('昵称：原位历史、窗口与摘要、并发前值、原子回滚、清空及身份隐私验证通过。');
