import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from '../../helpers/load-typescript-module.mjs';
import { bootstrapSqlite, createSqliteExecutor } from '../../helpers/sqlite-bootstrap-fixture.mjs';
import { createCoordinatedSqliteFixture } from '../../helpers/coordinated-sqlite-fixture.mjs';
import { chatCodeDependencies, chatMessageMutations, chatReplyVersionSql } from '../../helpers/chat-timeline-fixture.mjs';
import { chatSharingDependencies } from '../../helpers/chat-sharing-fixture.mjs';

const db = new DatabaseSync(':memory:');
const raw = createSqliteExecutor(db);
await bootstrapSqlite(raw);
const { CoordinatedDatabaseError, databaseCoordinator } = createCoordinatedSqliteFixture(raw);
const persistence = { CoordinatedDatabaseError, databaseCoordinator };
const domain = 'src/features/chat/messages/domain/';
const assistantDir = 'src/features/assistants/';
const hostDomain = load(`${assistantDir}domain/HostRepository.ts`);
const assistantRepository = load(`${assistantDir}infrastructure/SQLiteAssistantRepository.ts`, {
  '@platform/persistence': persistence, '@features/media': {}, '@features/profile': {}, './SQLiteModelServiceRepository': {},
  '../domain/AIProfile': {}, '../domain/ModelService': {}, '../domain/HostRepository': hostDomain,
});
const hostRepository = load(`${assistantDir}infrastructure/SQLiteHostRepository.ts`, {
  '@platform/persistence': persistence, '../domain/HostRepository': hostDomain,
});
const { aiAssistantRepository } = assistantRepository;
const { aiHostRepository } = hostRepository;
const assistantManagement = load(`${assistantDir}AIAssistantManagement.ts`, {
  '@platform/persistence': persistence, '@features/media': {}, '@shared/errors/SettingChangeConflictError': {},
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
  './domain/ApplicationSettingsAccess': {}, './domain/HostRepository': hostDomain,
  './application/HostAuthorityCoordinator': load(`${assistantDir}application/HostAuthorityCoordinator.ts`),
  './infrastructure/SQLiteAssistantRepository': assistantRepository,
  './infrastructure/SQLiteHostRepository': hostRepository, './infrastructure/SQLiteAssistantRecycleBinRepository': {},
});
const metadata = load(`${domain}chatMessageMetadata.ts`, {
  './ChatSticker': load(`${domain}ChatSticker.ts`), ...chatSharingDependencies,
});
const cardDomain = load(`${domain}RoleApplicationCard.ts`, { './chatMessageMetadata': metadata });
const { messageRepository: messages } = load('src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts', {
  '@platform/persistence': persistence, '../domain/chatMessageMetadata': metadata,
  './ChatMessageMutationSql': chatMessageMutations, '../../reply/infrastructure/ChatReplyVersionSql': chatReplyVersionSql,
  './ChatTimelineSql': load('src/features/chat/messages/infrastructure/ChatTimelineSql.ts'),
  '../domain/MessageTimeSeparator': load(`${domain}MessageTimeSeparator.ts`),
  '../domain/ChatMessageActions': {}, ...chatCodeDependencies,
});
const patched = [];
const delivered = [];
const cards = load('src/features/chat/messages/application/RoleApplicationCards.ts', {
  '@platform/persistence': persistence, '../domain/RoleApplicationCard': cardDomain,
  '../../reply/application/ChatReplyUtils': { formatMessageTime: () => '12:00' },
  '../../reply/delivery/AIMessageEvents': { emitAIMessageReceived: async payload => delivered.push(payload) },
  '../events/ChatEvents': { emitChatMessagesUpdated() {}, emitChatMessagesPatched: payload => patched.push(payload) },
  './ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => ({ messages }) },
});
const appointments = [];
assistantManagement.configureAssistantRuntime({
  onHostRelationshipChanged: async (id, change) => {
    assert.equal(await aiHostRepository.getCurrentHostAIId(), id, '任命后回应只能读取已提交的身份');
    appointments.push({ id, change });
  },
});
cards.configureRoleApplicationCards({
  assignLedger: (tx, id) => aiAssistantRepository.setLedgerAIInTransaction(tx, id),
  async appointHost(tx, id) {
    try { return await assistantManagement.appointHostAIAssistantInTransaction(tx, id); }
    catch (error) {
      if (error instanceof hostDomain.HostRelationshipError) return null;
      throw error;
    }
  },
  runHostApproval: assistantManagement.runHostAuthorityMutation,
});

const now = new Date().toISOString();
for (const id of ['applicant', 'incumbent', 'successor']) {
  db.prepare('INSERT INTO ai_assistants(id, agent_id, name, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `agent-${id}`, id, 'test', now, now);
  db.prepare("INSERT INTO chat_conversations VALUES (?, 'direct')").run(`chat-${id}`);
  db.prepare('INSERT INTO sessions(id, ai_assistant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(`chat-${id}`, id, id, now, now);
}
const currentRole = role => db.prepare(`SELECT id FROM ai_assistants WHERE is_${role}_ai = 1 ORDER BY id`).all().map(row => row.id);
const getAI = async id => db.prepare('SELECT id, name, agent_id AS agentId, is_host_ai = 1 AS isHostAI FROM ai_assistants WHERE id = ? AND deleted_at IS NULL').get(id);
const notified = [];
const chat = {
  resolveCanonicalConversation: async ({ aiId }) => ({ id: `chat-${aiId}` }),
  isChatReplyRunCurrentInTransaction: async (_tx, id) => id !== 'cancelled',
  isGroupSpeechTaskRunCurrentInTransaction: async (_tx, id) => id === 'group-task',
};
const { roleApplicationTools } = load('src/host/composition/agent/RoleApplicationTools.ts', {
  '@features/assistants': { getAIAssistantById: getAI },
  '@features/assistants/composition': { aiAssistantRepository, aiHostRepository },
  '@features/chat': chat, '@features/chat/composition': cards, '@platform/persistence': persistence,
  '@platform/device': { postApplicationExecution: async (kind, data) => {
    assert.equal(kind, 'relationship');
    assert.ok(await cards.readRoleApplicationNotice(data.messageId), '派发前卡片已经提交');
    notified.push(data);
    return true;
  } },
  '@shared/runtime/abortSignal': { throwIfAbortSignalAborted: signal => signal.throwIfAborted() },
});
const [ledgerTool, hostTool] = roleApplicationTools;
const apply = (tool, runId, assistantId = 'applicant', group = false) => tool.execute({}, {
  runId, task: { assistantId, sessionId: group ? 'group' : `chat-${assistantId}`, type: group ? 'group_chat_reply' : 'chat_reply' },
  abortSignal: new AbortController().signal,
});
const respond = (id, action, role = 'ledger') => cards.respondToRoleApplicationCard('chat-applicant', id, action, role);
const read = async id => cardDomain.readRoleApplicationCard(await messages.getMessageById(id));

await aiAssistantRepository.setLedgerAI('incumbent');
const ledger = await apply(ledgerTool, 'ledger-first');
assert.deepEqual(currentRole('ledger'), ['incumbent'], '申请本身不授予记账角色');
assert.equal((await read(ledger.data.messageId)).incumbentName, 'incumbent');
assert.deepEqual(await Promise.all([respond(ledger.data.messageId, 'accept'), respond(ledger.data.messageId, 'decline')]), ['answered', 'already_answered']);
assert.deepEqual(currentRole('ledger'), ['applicant']);
assert.equal((await read(ledger.data.messageId)).decision, 'accepted');
assert.equal(patched.length, 1);
await aiAssistantRepository.setLedgerAI('incumbent');
await apply(ledgerTool, 'ledger-first');
assert.equal((await read(ledger.data.messageId)).decision, 'accepted', '重放不会重新打开已处理的卡片');
assert.equal(delivered.length, 1);

const rollback = await apply(ledgerTool, 'ledger-rollback');
db.exec(`CREATE TEMP TRIGGER fail_card_patch BEFORE UPDATE OF metadata_json ON messages
  WHEN OLD.id = ${rollback.data.messageId} BEGIN SELECT RAISE(ABORT, 'card patch failed'); END`);
await assert.rejects(respond(rollback.data.messageId, 'accept'), /card patch failed/);
assert.deepEqual(currentRole('ledger'), ['incumbent']);
assert.equal((await read(rollback.data.messageId)).decision, 'pending');
db.exec('DROP TRIGGER fail_card_patch');

const stale = await apply(ledgerTool, 'ledger-stale');
db.prepare('UPDATE ai_assistants SET deleted_at = ? WHERE id = ?').run(now, 'applicant');
assert.equal(await respond(stale.data.messageId, 'accept'), 'unavailable');
assert.deepEqual(currentRole('ledger'), ['incumbent'], '申请者回收后，原记账 AI 保持任职');
db.prepare('UPDATE ai_assistants SET deleted_at = NULL WHERE id = ?').run('applicant');
assert.equal((await apply(ledgerTool, 'cancelled')).status, 'error');

await aiHostRepository.setHostAI('incumbent');
assert.equal((await apply(hostTool, 'self', 'incumbent')).code, 'ROLE_ALREADY_ASSIGNED');
const host = await apply(hostTool, 'group-task', 'applicant', true);
assert.equal((await messages.getMessageById(host.data.messageId)).sessionId, 'chat-applicant');
assert.deepEqual(notified, [{ aiId: 'incumbent', change: 'application', messageId: host.data.messageId }]);
assert.equal(await respond(host.data.messageId, 'accept', 'host'), 'unavailable');
assert.deepEqual(currentRole('host'), ['incumbent']);
assert.equal(await respond(host.data.messageId, 'decline', 'host'), 'answered');

const replies = [];
const { executeHostRelationshipReply } = load('src/host/runtime/ExecuteHostRelationshipReply.ts', {
  '@features/assistants': { getAIAssistantById: getAI }, '@features/chat/composition': cards,
  '@features/chat': { ...chat, AUTONOMOUS_SILENT_REPLY: '[[NO_MESSAGE]]', requestOptionalProactiveChatReply: async params => replies.push(params) },
  '../composition/ensureHostDatabaseReady': { ensureHostDatabaseReady: async () => {} },
});
const execution = { signal: new AbortController().signal, executionDeadlineAt: Infinity };
await executeHostRelationshipReply(notified[0], execution);
assert.equal(replies[0].sessionId, 'chat-incumbent');
assert.match(replies[0].currentInput, /用户已拒绝/);
assert.equal(replies[0].aiConfig.enableTools, false);

await aiHostRepository.revokeHostAI('incumbent');
const cooling = await apply(hostTool, 'cooldown');
assert.ok((await read(cooling.data.messageId)).cooldownEndAt);
assert.equal((await assistantManagement.getHostAppointmentAvailability()).status, 'cooldown');
await assert.rejects(assistantManagement.appointHostAIAssistant('applicant'), { code: 'host_appointment_cooldown_active' });
assert.equal(await respond(cooling.data.messageId, 'accept', 'host'), 'unavailable');
assert.equal(notified.length, 1);
let stateChanges = 0;
const unsubscribe = assistantManagement.subscribeHostAppointmentChanged(() => { stateChanges++; });
assert.equal(await assistantManagement.releaseHostAICooldown('incumbent'), true);
assert.equal(stateChanges, 1, '提前解除提交后刷新可见申请卡');
assert.equal((await assistantManagement.getHostAppointmentAvailability()).status, 'vacant');
const vacant = await apply(hostTool, 'vacant');
assert.equal((await read(vacant.data.messageId)).cooldownEndAt, null);
const competing = await apply(hostTool, 'vacant-successor', 'successor');
db.exec(`CREATE TEMP TRIGGER fail_host_card_patch BEFORE UPDATE OF metadata_json ON messages
  WHEN OLD.id = ${vacant.data.messageId} BEGIN SELECT RAISE(ABORT, 'host card patch failed'); END`);
await assert.rejects(respond(vacant.data.messageId, 'accept', 'host'), /host card patch failed/);
assert.deepEqual(currentRole('host'), [], '写卡失败时主理任命回滚');
assert.equal(appointments.length, 0);
db.exec('DROP TRIGGER fail_host_card_patch');

db.prepare("UPDATE ai_assistants SET model = '' WHERE id = 'applicant'").run();
assert.equal(await respond(cooling.data.messageId, 'accept', 'host'), 'unavailable', '无可用模型的申请者不能上任');
db.prepare("UPDATE ai_assistants SET model = 'test' WHERE id = 'applicant'").run();
assert.equal(await respond(cooling.data.messageId, 'accept'), 'unavailable', '同意时只能按卡片真实角色办理');

assert.deepEqual(await Promise.all([
  respond(cooling.data.messageId, 'accept', 'host'),
  cards.respondToRoleApplicationCard('chat-successor', competing.data.messageId, 'accept', 'host'),
]), ['answered', 'unavailable'], '解除前发出的待处理申请可以同意，并发任命只有一位赢家');
assert.deepEqual(currentRole('host'), ['applicant']);
assert.equal((await read(cooling.data.messageId)).decision, 'accepted');
assert.equal(await respond(vacant.data.messageId, 'accept', 'host'), 'unavailable', '同一 AI 已通过另一张卡任命时，旧卡不再同意');
assert.equal(stateChanges, 2, '新任命提交后刷新可见申请卡');
assert.deepEqual(appointments, [{ id: 'applicant', change: 'appointed' }]);
unsubscribe();
assert.equal(notified.length, 1);
await executeHostRelationshipReply(notified[0], execution);
await executeHostRelationshipReply({ ...notified[0], aiId: 'successor' }, execution);
assert.equal(replies.length, 1, '失效通知不会唤醒原主理或新主理');
await aiHostRepository.revokeHostAI('applicant');
db.prepare('UPDATE host_ai_relationship_state SET appointment_cooldown_end = ?')
  .run(new Date(Date.now() - 1000).toISOString());
assert.equal((await assistantManagement.getHostAppointmentAvailability()).status, 'vacant');
assert.equal(await cards.respondToRoleApplicationCard('chat-successor', competing.data.messageId, 'accept', 'host'), 'answered',
  '冷静期自然到期后也可同意之前的待处理申请');
assert.deepEqual(currentRole('host'), ['successor']);

db.close();
console.log('关系申请验证通过：持久卡片、原子替换、重复处理、回收、冷静期、群聊来源及通知接收人。');
