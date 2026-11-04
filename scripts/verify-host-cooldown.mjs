/** 验证撤销关系、冷静期自主解除及用户操作唤醒的真实行为。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(file, mocks = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output.outputText)((name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) return load(path.join(path.dirname(file), `${name}.ts`), mocks);
    throw new Error(`未声明依赖：${name}`);
  }, module, module.exports);
  return module.exports;
}

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE ai_assistants (
  id TEXT PRIMARY KEY, is_host_ai INTEGER NOT NULL DEFAULT 0,
  host_cooldown_start TEXT, host_cooldown_end TEXT,
  host_revoke_cooldown_start TEXT, host_revoke_cooldown_end TEXT, updated_at TEXT
);
CREATE TABLE host_ai_relationship_state (
  id TEXT PRIMARY KEY, last_revoked_ai_id TEXT, appointment_cooldown_start TEXT,
  appointment_cooldown_end TEXT, created_at TEXT, updated_at TEXT
);
INSERT INTO ai_assistants(id) VALUES ('a'), ('b');`);
let failProfileUpdate = false;
const executor = {
  async getFirstAsync(sql, args = []) { return db.prepare(sql).get(...args) ?? null; },
  async runAsync(sql, args = []) {
    if (failProfileUpdate && sql.includes('UPDATE ai_assistants')) throw new Error('模拟写入失败');
    return db.prepare(sql).run(...args);
  },
  async withExclusiveTransactionAsync(action) {
    db.exec('BEGIN');
    try { const value = await action(executor); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const domain = load('src/features/assistants/domain/HostRepository.ts');
const { AIHostRepository } = load('src/features/assistants/infrastructure/SQLiteHostRepository.ts', {
  '@platform/persistence': { databaseCoordinator: {
    openTaskExecutor: () => executor,
    transaction: (_meta, action) => executor.withExclusiveTransactionAsync(action),
  } },
  '../domain/HostRepository': domain,
});
const repository = new AIHostRepository();
await repository.setHostAI('a');
assert.equal((await repository.checkHostCooldown()).isInCooldown, false);
assert.equal(await repository.releaseAppointmentCooldown('a'), false, '正常任期没有解除工具权限');
await repository.revokeHostAI('a');
const status = await repository.checkHostCooldown();
assert.equal(status.isInCooldown, true);
assert.equal(status.revokedAIId, 'a');
assert.equal(status.remainingDays, 7);
assert.equal(db.prepare('SELECT is_host_ai FROM ai_assistants WHERE id = ?').get('a').is_host_ai, 0);
await assert.rejects(repository.setHostAI('b'), { code: 'host_appointment_cooldown_active' });
assert.equal(await repository.releaseAppointmentCooldown('b'), false, '其他 AI 不得代为解除');
failProfileUpdate = true;
await assert.rejects(repository.releaseAppointmentCooldown('a'), /模拟写入失败/);
failProfileUpdate = false;
assert.equal((await repository.checkHostCooldown()).isInCooldown, true, '解除的两个事实必须一起回滚');

const assistantModule = {
  getHostAICooldownStatus: async () => ({ appointment: await repository.checkHostCooldown() }),
  releaseHostAICooldown: (actor) => repository.releaseAppointmentCooldown(actor),
};
const { ReleaseHostCooldownTool } = load('src/features/assistants/aiTools/ReleaseHostCooldownTool.ts', {
  '../AIAssistantManagement': assistantModule,
  '@shared/runtime/abortSignal': load('src/shared/runtime/abortSignal.ts'),
});
const { prepareHostModelRun } = load('src/host/runtime/HostModelRunPreparation.ts', {
  '@features/assistants': { ...assistantModule, ReleaseHostCooldownTool },
  './TogetherListeningRunPreparation': { prepareTogetherListeningHostModelRun: async () => ({
    managedToolNames: ['listening'], dynamicAllowedToolNames: [], additionalPromptBlocks: [],
  }) },
});
const input = { scenario: 'chat.private_reply', currentAiId: 'a', isHostAI: false,
  persistentAllowedToolNames: [ReleaseHostCooldownTool.name] };
assert.deepEqual((await prepareHostModelRun(input)).dynamicAllowedToolNames, [ReleaseHostCooldownTool.name]);
assert.deepEqual((await prepareHostModelRun({ ...input, currentAiId: 'b' })).dynamicAllowedToolNames, []);
assert.deepEqual((await prepareHostModelRun({ ...input, persistentAllowedToolNames: [] })).dynamicAllowedToolNames, [], '单项权限仍然生效');

const { AgentRegistryService } = load('src/features/assistants/AgentRegistryService.ts', {
  './infrastructure/SQLiteAssistantRepository': { aiAssistantRepository: { getAll: async () => [
    { id: 'a', agentId: 'agent-a', name: 'A', isHostAI: false },
    { id: 'b', agentId: 'agent-b', name: 'B', isHostAI: false },
  ] } },
  './infrastructure/SQLiteHostRepository': { aiHostRepository: { ...repository,
    checkHostCooldown: () => repository.checkHostCooldown(), cleanupExpiredBlocks: async () => true,
  } },
});
const registry = new AgentRegistryService();
for (const currentAgentId of ['agent-a', 'agent-b']) {
  const summary = (await registry.getSummary({ currentAgentId })).text;
  assert.match(summary, /已被移除主理ai身份，当前处于冷静期/);
  assert.doesNotMatch(summary, /剩余|结束时间/, '身份池不向其他 AI 泄漏剩余时间');
}
const signal = new AbortController().signal;
assert.equal((await ReleaseHostCooldownTool.execute({}, { aiConfig: { id: 'b' }, abortSignal: signal })).success, false);
assert.equal((await ReleaseHostCooldownTool.execute({}, { aiConfig: { id: 'a' }, abortSignal: signal })).success, true);
assert.equal((await repository.checkHostCooldown()).isInCooldown, false);
assert.equal(db.prepare('SELECT host_revoke_cooldown_end FROM ai_assistants WHERE id = ?').get('a').host_revoke_cooldown_end, null);
assert.equal(await repository.getCurrentHostAIId(), null, '解除不会自动恢复主理身份');
assert.deepEqual((await prepareHostModelRun(input)).dynamicAllowedToolNames, [], '解除后旧工具从后续轮次消失');
assert.equal(await repository.releaseAppointmentCooldown('a'), false, '同一冷静期只能解除一次');
assert.doesNotMatch((await registry.getSummary()).text, /当前处于冷静期/);
await repository.setHostAI('a');
assert.equal(await repository.getCurrentHostAIId(), 'a', '解除后可以重新任命同一个 AI');
await repository.revokeHostAI('a');
assert.equal((await repository.checkHostCooldown()).remainingDays, 7, '再次撤销产生新的七天冷静期');
await repository.releaseAppointmentCooldown('a');
await repository.setHostAI('b');
await repository.revokeHostAI('b');
db.prepare('UPDATE host_ai_relationship_state SET appointment_cooldown_end = ?').run(new Date(Date.now() - 1).toISOString());
assert.equal((await repository.checkHostCooldown()).isInCooldown, false);
assert.doesNotMatch((await registry.getSummary()).text, /被移除|冷静期/, '自然到期后目录不保留旧主理身份');
assert.equal(await repository.releaseAppointmentCooldown('b'), false, '自然到期不再允许解除');
await repository.setHostAI('a');

const requests = [];
const execution = { requestId: 'host-relationship', signal: new AbortController().signal, executionDeadlineAt: performance.now() + 60_000 };
let databaseReady = false;
let currentAssistant = { id: 'a', agentId: 'agent-a', enableTools: false, isHostAI: false, model: 'test' };
const { executeHostRelationshipReply } = load('src/host/runtime/ExecuteHostRelationshipReply.ts', {
  '@features/assistants': { getAIAssistantById: async () => {
    assert.equal(databaseReady, true, '读取身份前必须经过启动门');
    return currentAssistant;
  } },
  '@features/chat': {
    resolveCanonicalConversation: async ({ aiId }) => ({ id: `session-${aiId}` }),
    requestProactiveChatReply: async (request) => requests.push(request),
  },
  '../composition/ensureHostDatabaseReady': { ensureHostDatabaseReady: async () => { databaseReady = true; } },
});
for (const change of ['appointed', 'revoked']) {
  await executeHostRelationshipReply({ aiId: 'a', change, occurredAt: new Date().toISOString() }, execution);
  const request = requests.at(-1);
  assert.equal(request.triggerReason, `host_ai_${change}`);
  assert.equal(request.sessionId, 'session-a');
  assert.match(request.currentInput, change === 'appointed' ? /用户刚刚任命你/ : /用户刚刚撤销了你/);
  assert.equal(request.aiConfig.enableTools, false, '身份通知不擅自开启工具调用');
  assert.equal(request.aiConfig.isHostAI, false, '执行读取当前身份，不从任命事件恢复旧权限');
}
currentAssistant = null;
await executeHostRelationshipReply({ aiId: 'a', change: 'revoked', occurredAt: new Date().toISOString() }, execution);
assert.equal(requests.length, 2, '已经删除的 AI 不再发言');
await assert.rejects(executeHostRelationshipReply({ aiId: 'a', change: 'unknown', occurredAt: 'invalid' }, execution), /参数非法/);
db.close();
console.log('主理 AI 冷静期验证通过：身份隔离、事务回滚、动态暴露、自主解除、自然到期与操作唤醒。');
