import { CHAT_PROMPT_READING_FLOW } from './helpers/prompt-reading-flow.mjs';
/** 协议空间的旧库迁移、常驻注入与用户 / AI 共同编辑行为。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadTypeScriptModule as load } from './helpers/load-typescript-module.mjs';

const { PROTOCOL_SCHEMA, migrateProtocolPermanentInjection } = load('src/platform/persistence/sqlite/protocolSchema.ts');
const { PROMPTING_SCHEMA } = load('src/platform/persistence/sqlite/promptingSchema.ts');
function createDatabase(legacy) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE ai_assistants (id TEXT PRIMARY KEY);
    CREATE TABLE group_chats (id TEXT PRIMARY KEY);
    INSERT INTO ai_assistants VALUES ('a'), ('b');
    PRAGMA user_version = 101;`);
  db.exec(PROMPTING_SCHEMA);
  db.exec(legacy ? `CREATE TABLE protocols (
    id TEXT PRIMARY KEY, ai_assistant_id TEXT NOT NULL, content TEXT NOT NULL, summary TEXT,
    priority INTEGER DEFAULT 5, effective_date TEXT, expiry_date TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (ai_assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE);
    CREATE INDEX idx_protocols_priority ON protocols(ai_assistant_id, priority DESC);` : PROTOCOL_SCHEMA);
  return db;
}
function executor(db) {
  const result = {
    execAsync: async (sql) => db.exec(sql),
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
    withExclusiveTransactionAsync: async (action) => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await action(result); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return result;
}
const db = createDatabase(true);
db.exec(`INSERT INTO protocols VALUES
  ('low', 'a', '请叫我枫渡', '称呼', 1, NULL, NULL, '1', '1'),
  ('expired', 'a', '每天用中文回应', '语言', 5, NULL, '2020-01-01', '2', '2'),
  ('future', 'a', '记录我们的纪念日', '纪念日', 10, '2099-01-01', NULL, '3', '3'),
  ('other', 'b', '另一位 AI 的设定', NULL, 10, NULL, NULL, '4', '4');
  INSERT INTO prompt_presets (id, name, scenario_id, created_at, updated_at)
    VALUES ('old', '旧预设', 'chat.private_reply', '1', '1');
  INSERT INTO prompt_preset_items (id, preset_id, definition_id, slot, sort_order, enabled, created_at, updated_at)
    VALUES ('old-item', 'old', 'context.high_priority_protocols', 'user_rules', 60, 0, '1', '1');
  INSERT INTO assistant_prompt_definition_states (assistant_id, definition_id, enabled, updated_at)
    VALUES ('a', 'context.high_priority_protocols', 0, '1'), ('a', 'context.time_awareness', 0, '1');
  INSERT INTO assistant_prompt_definition_overrides (assistant_id, definition_id, locale, content, updated_at)
    VALUES ('a', 'context.high_priority_protocols', 'zh-CN', '旧 Provider 覆盖', '1'), ('a', 'foundation.default_core', 'zh-CN', '用户基础规则', '1');
  INSERT INTO prompt_default_overrides (definition_id, content)
    VALUES ('context.high_priority_protocols', '旧全局 Provider 覆盖'), ('foundation.default_core', '全局基础规则');`);
const retainedColumns = 'id, ai_assistant_id, content, summary, created_at, updated_at';
const original = db.prepare(`SELECT ${retainedColumns} FROM protocols ORDER BY id`).all();
const sql = executor(db);
// 注入真实 SQL 故障，验证列变更、正文与版本标记整体回滚。
await assert.rejects(migrateProtocolPermanentInjection({ ...sql, execAsync: async (statement) => {
  if (statement.includes('PRAGMA user_version = 102')) db.exec('SELECT * FROM missing_migration_table');
  return sql.execAsync(statement);
} }), /missing_migration_table/);
assert.equal(db.prepare('PRAGMA user_version').get().user_version, 101);
assert.equal(db.prepare("SELECT enabled FROM prompt_preset_items WHERE id = 'old-item'").get().enabled, 0);
assert.ok(db.prepare("PRAGMA table_info('protocols')").all().some((column) => column.name === 'priority'));
assert.deepEqual(db.prepare(`SELECT ${retainedColumns} FROM protocols ORDER BY id`).all(), original);
await migrateProtocolPermanentInjection(sql);
assert.deepEqual(db.prepare(`SELECT ${retainedColumns} FROM protocols ORDER BY id`).all(), original);
assert.equal(db.prepare('PRAGMA user_version').get().user_version, 102);
assert.deepEqual({ ...db.prepare("SELECT definition_id, enabled FROM prompt_preset_items WHERE id = 'old-item'").get() },
  { definition_id: 'context.protocol_space', enabled: 1 });
assert.deepEqual(db.prepare('SELECT definition_id FROM assistant_prompt_definition_states').all().map((row) => row.definition_id), ['context.time_awareness']);
assert.deepEqual(db.prepare('SELECT content FROM assistant_prompt_definition_overrides').all().map((row) => row.content), ['用户基础规则']);
assert.deepEqual(db.prepare('SELECT content FROM prompt_default_overrides').all().map((row) => row.content), ['全局基础规则']);
await migrateProtocolPermanentInjection(sql);
assert.deepEqual(db.prepare(`SELECT ${retainedColumns} FROM protocols ORDER BY id`).all(), original);
const fresh = createDatabase(false);
await migrateProtocolPermanentInjection(executor(fresh));
assert.equal(fresh.prepare('PRAGMA user_version').get().user_version, 102);
fresh.close();

const { protocolRepository: repository } = load('src/features/protocol/infrastructure/SQLiteProtocolRepository.ts', {
  'expo-crypto': { randomUUID }, '@platform/persistence': { databaseCoordinator: { openTaskExecutor: () => sql } },
});
const findProtocol = async (id) => (await repository.getByAI('a')).find((protocol) => protocol.id === id) ?? null;
assert.equal(await repository.getPromptText('a'), '- 请叫我枫渡\n- 每天用中文回应\n- 记录我们的纪念日');
assert.equal(await repository.getPromptText('missing'), '');
assert.deepEqual((await repository.search('a', '中文')).map((item) => item.id), ['expired']);
const abortBoundary = load('src/shared/runtime/abortSignal.ts');
const tools = Object.fromEntries(['Add', 'Update', 'Delete', 'Get', 'Search'].map((name) => [name,
  load(`src/features/protocol/aiTools/${name}Protocol${['Get', 'Search'].includes(name) ? 's' : ''}Tool.ts`, { '@shared/runtime/abortSignal': abortBoundary })]));
const context = { getAIId: () => 'a', repositories: { protocol: repository } };
const added = await tools.Add.execute({ content: '使用固定称呼', summary: '表达' }, context);
assert.equal(added.success, true);
assert.ok((await repository.getPromptText('a')).includes('使用固定称呼'));
assert.equal((await tools.Add.execute({ content: '使用固定称呼', summary: '表达' }, context)).data.id, added.data.id);
await tools.Update.execute({ protocolId: added.data.id, content: '使用新的固定称呼' }, context);
assert.ok((await repository.getPromptText('a')).includes('使用新的固定称呼'));
await repository.update('a', 'low', { content: '用户修改称呼' });
assert.ok((await repository.getPromptText('a')).startsWith('- 用户修改称呼\n'));
assert.equal((await tools.Get.execute({}, context)).data.length, 4);
assert.equal((await tools.Search.execute({ keyword: '新的' }, context)).data[0].id, added.data.id);
await tools.Delete.execute({ protocolId: added.data.id }, context);
assert.ok(!(await repository.getPromptText('a')).includes('使用新的固定称呼'));
assert.equal(await repository.getPromptText('b'), '- 另一位 AI 的设定');

// 通过生产适配器检查模型实际收到的 observation，不能只断言未回灌的 data。
const { LegacyAgentToolAdapter } = load('src/host/composition/agent/LegacyAgentToolAdapter.ts');
const modelTools = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name,
  new LegacyAgentToolAdapter(tool[`${name}Protocol${['Get', 'Search'].includes(name) ? 's' : ''}Tool`],
    { owner: 'protocol', risk: 'safe_read', idempotency: 'idempotent' }, () => context)]));
const executeForModel = (name, args) => modelTools[name].execute(args, {});
const originalContent = '这是用于精确区分相似条目的完整协议正文，长度超过原列表的三十字截断限制。称呼保持原样。';
const created = await executeForModel('Add', { content: originalContent, summary: '精确管理' });
assert.equal(created.status, 'success');
const targetId = created.data.id;
assert.ok(created.modelContent.includes(targetId));
assert.ok(created.modelContent.includes(originalContent));
const duplicate = await executeForModel('Add', { content: originalContent, summary: '精确管理' });
assert.equal(duplicate.data.id, targetId);
assert.ok(duplicate.modelContent.includes(targetId));
const similar = await repository.insert({ aiAssistantId: 'a', content: `${originalContent}保留这条。`, summary: '相似条目' });
for (const result of [await executeForModel('Get', {}), await executeForModel('Search', { keyword: '精确管理' })]) {
  assert.equal(result.status, 'success');
  assert.ok(result.modelContent.includes(targetId), '模型必须能拿到真实 ID');
  assert.ok(result.modelContent.includes(originalContent), '模型必须能看到完整正文以区分条目');
  assert.ok(result.modelContent.includes('精确管理'));
  assert.ok(!result.modelContent.includes('另一位 AI 的设定'));
}
const updated = await executeForModel('Update', { protocolId: targetId, content: '  修改后的实际正文  ' });
assert.equal(updated.status, 'success');
assert.equal(updated.data.content, '修改后的实际正文');
assert.equal(updated.data.summary, '精确管理');
assert.deepEqual(updated.data, await findProtocol(targetId), '返回 commit 对应的完整条目');
assert.ok(updated.modelContent.includes(targetId));
assert.ok(updated.modelContent.includes('修改后的实际正文'));
assert.ok((await executeForModel('Search', { keyword: '修改后的实际正文' })).modelContent.includes(targetId));
const summaryUpdated = await executeForModel('Update', { protocolId: targetId, summary: '新摘要' });
assert.equal(summaryUpdated.status, 'success');
assert.equal(summaryUpdated.data.content, updated.data.content);
assert.equal(summaryUpdated.data.summary, '新摘要');
assert.equal((await executeForModel('Update', { protocolId: targetId, content: updated.data.content })).status, 'success',
  '重复写入相同正文仍是命中已有条目的成功操作');

const beforeInvalidWrites = await repository.getByAI('a');
assert.equal(await repository.update('a', '__probe_invalid_id__', { content: '无效更新' }), null);
assert.equal(await repository.delete('a', '__probe_invalid_id__'), false);
for (const protocolId of ['__probe_invalid_id__', 'other']) {
  for (const [name, args] of [['Update', { protocolId, content: '不得写入' }], ['Delete', { protocolId }]]) {
    const result = await executeForModel(name, args);
    assert.equal(result.status, 'error', '不存在或属于其他 AI 的条目不得报告成功');
    assert.ok(result.modelContent.includes('不存在或不属于当前 AI'));
  }
}
assert.deepEqual(await repository.getByAI('a'), beforeInvalidWrites);
assert.equal(await repository.getPromptText('b'), '- 另一位 AI 的设定');
for (const name of ['Update', 'Delete']) {
  const result = await tools[name].execute({ protocolId: targetId, content: '不得写入' },
    { ...context, getAIId: () => null });
  assert.equal(result.success, false);
}

// 真实 SQLite 写入失败仍须进入模型可见的失败结果，并保留原内容。
db.exec(`CREATE TRIGGER reject_protocol_update BEFORE UPDATE ON protocols BEGIN SELECT RAISE(ABORT, '拒绝更新'); END;
  CREATE TRIGGER reject_protocol_delete BEFORE DELETE ON protocols BEGIN SELECT RAISE(ABORT, '拒绝删除'); END;`);
assert.equal((await executeForModel('Update', { protocolId: targetId, content: '不能提交' })).status, 'error');
assert.equal((await executeForModel('Delete', { protocolId: targetId })).status, 'error');
assert.deepEqual(await repository.getByAI('a'), beforeInvalidWrites);
db.exec('DROP TRIGGER reject_protocol_update; DROP TRIGGER reject_protocol_delete;');
const deleted = await executeForModel('Delete', { protocolId: targetId });
assert.equal(deleted.status, 'success');
assert.ok(deleted.modelContent.includes(targetId));
assert.equal(await findProtocol(targetId), null);
assert.ok(!(await executeForModel('Get', {})).modelContent.includes(targetId));
assert.ok(!(await repository.getPromptText('a')).includes(updated.data.content));
assert.ok(await findProtocol(similar.id), '按 ID 删除必须保留相似条目');
assert.equal((await executeForModel('Delete', { protocolId: targetId })).status, 'error', '重复删除不得假报成功');
await repository.delete('a', similar.id);

const commands = load('src/features/protocol/composition.ts', { './infrastructure/SQLiteProtocolRepository': { protocolRepository: repository } });
await assert.rejects(commands.saveProtocol({ aiAssistantId: 'a', protocolId: targetId, content: '已删除条目' }), /协议不存在/);
await assert.rejects(commands.deleteProtocol('a', targetId), /协议不存在/);
await assert.rejects(commands.saveProtocol({ aiAssistantId: 'a', protocolId: 'other', content: '跨 AI 修改' }), /不属于当前 AI/);
await assert.rejects(commands.deleteProtocol('a', 'other'), /不属于当前 AI/);

const { PromptPackBlockFactory } = load('src/host/prompt/PromptPackBlockFactory.ts', {
  '@shared': {}, '@features/memory': {}, '@features/assistants': {}, '@features/moments': {},
  './PromptBuiltInContent': load('src/host/prompt/PromptBuiltInContent.ts'),
});
const factory = new PromptPackBlockFactory();
const block = await factory.createProtocolPromptBlock('a', context);
assert.doesNotMatch(block.content, /工具|schema/, '协议正文常驻，包装文字不介绍未授权工具');
assert.ok(block.content.includes('用户修改称呼'));
assert.ok(block.content.includes('每天用中文回应'));
assert.ok(block.content.includes('记录我们的纪念日'));
assert.equal(block.truncatable, false);
await assert.rejects(factory.createProtocolPromptBlock('a', { repositories: { protocol: {
  getPromptText: async () => { throw new Error('SQLite 读取失败'); },
} } }, {}), /SQLite 读取失败/);
assert.equal((await factory.createProtocolPromptBlock('missing', context, {})).status, 'omitted');

const { getSystemPromptPreset } = load('src/host/prompt/compiler/systemPromptPresets.ts');
const { PromptPackCompiler } = load('src/host/prompt/compiler/PromptPackCompiler.ts', {
    '@shared/prompt': { CHAT_PROMPT_READING_FLOW, ...load('src/shared/prompt/messageTimestamp.ts') },
  '../tokenBudget': load('src/host/prompt/tokenBudget.ts', { '@shared/prompt': { ...load('src/shared/prompt/estimateTextTokens.ts'), ...load('src/shared/prompt/messageTimestamp.ts') } }),
  './promptBlockMetadata': load('src/host/prompt/compiler/promptBlockMetadata.ts'),
});
const compiler = new PromptPackCompiler();
const draft = (key) => ({ key, title: key, content: key, required: false, status: 'ready', scenario: 'shared', placement: 'system' });
const factoryBoundary = {
  resolveUserIdentity: async () => ({ displayName: '枫渡', source: 'test' }),
  createFoundationBlock: () => draft('foundation_default_core'), createPersonaBlock: () => draft('persona'),
  createProtocolPromptBlock: (...args) => factory.createProtocolPromptBlock(...args),
  createAgentRegistrySummaryBlock: async () => draft('agent_registry_summary'),
  createMomentSocialInboxBlock: async () => draft('moments_social_inbox'),
  createUserIdentityBlock: () => draft('user_identity_summary'), createTimeAwarenessBlock: () => draft('time_awareness'),
  createInteractionEnvironmentBlock: () => draft('interaction_environment'),
  createRecentChatWindowBlock: () => draft('recent_chat_window'), createScenarioContextBlock: () => null,
  createAutonomousRecentChatContextBlock: () => draft('recent_chat_window'),
  createAutonomousExecutionTimeBlock: () => draft('time_awareness'),
  createGroupMemberReplyConfidentialityBlock: () => ({ ...draft('group_chat_context'), definitionId: 'output.group_member_reply_confidentiality', slot: 'output_contract', protection: 'locked' }),
};
const providerKeys = { 'context.agent_registry': 'agent_registry_summary', 'context.moments_social_inbox': 'moments_social_inbox',
  'context.passive_memory': 'passive_memory', 'context.group_chat': 'group_chat_context', 'context.assistant_nickname': 'assistant_nickname',
  'context.host_cooldown': 'host_cooldown' };
const { promptPackAssembler: assembler } = load('src/host/prompt/PromptPackAssembler.ts', {
  '@features/companion': { loadAIScheduleContext: async () => '' },
  './PromptPackBlockFactory': { promptPackBlockFactory: factoryBoundary },
  './PromptHistoryBuilder': { promptHistoryBuilder: { loadPrivateSummaryContext: async () => ({ messages: [] }),
    loadGroupSummaryContext: async () => ({ messages: [] }), loadBackgroundContext: async () => '', loadRecentMessages: async () => [] } },
  './compiler/promptBlockMetadata': load('src/host/prompt/compiler/promptBlockMetadata.ts'),
  './compiler/PromptPackCompiler': { promptPackCompiler: compiler }, './compiler/systemPromptPresets': { getSystemPromptPreset },
  './providers': { renderHostPromptProviderBlock: (id, { params }) => id === 'context.protocol_space'
    ? factory.createProtocolPromptBlock(params.aiConfig.id, params.toolContext) : draft(providerKeys[id]) },
});
for (const scenario of ['chat.private_reply', 'chat.group_member_reply', 'ledger.reply', 'call.live_reply', 'call.outgoing_decision']) {
  for (const disabled of [true, false]) {
    const preset = getSystemPromptPreset(scenario);
    const oldPreset = { ...preset, tokenBudget: 1, items: disabled
      ? preset.items.map((item) => item.definitionId === 'context.protocol_space' ? { ...item, enabled: false } : item)
      : preset.items.filter((item) => item.definitionId !== 'context.protocol_space') };
    const params = { aiConfig: { id: 'a', enableTools: false }, toolContext: context,
      currentInput: '你好', recentMessages: [], preset: oldPreset, scenarioId: scenario,
      additionalBlocks: preset.items.filter((item) => item.required && !['foundation.default_core', 'input.current', 'output.group_member_reply_confidentiality'].includes(item.definitionId))
        .map((item) => ({ ...draft('persona'), definitionId: item.definitionId, slot: item.slot, protection: item.protection })),
      runtimeContext: scenario === 'chat.group_member_reply' ? { groupChat: {}, userDisplayName: '枫渡' }
        : { triggerSource: scenario === 'call.live_reply' ? 'call' : scenario === 'call.outgoing_decision' ? 'call_outgoing_decision' : 'chat' } };
    const pack = scenario === 'ledger.reply' ? await assembler.assembleLedgerPromptPack(params) : await assembler.assembleChatPromptPack(params);
    assert.ok(pack.systemPrompt.includes('用户修改称呼'), `${scenario} 必须常驻注入`);
    assert.ok(pack.systemPrompt.includes('每天用中文回应'));
    assert.ok(pack.systemPrompt.includes('记录我们的纪念日'));
    assert.equal(pack.blocks.filter((item) => item.key === 'protocol_space').length, 1);
    assert.ok(pack.truncationLog.length > 0);
  }
}
db.exec("DELETE FROM ai_assistants WHERE id = 'a'");
assert.equal(await repository.getPromptText('a'), '');
assert.equal(await repository.getPromptText('b'), '- 另一位 AI 的设定');
db.close();
console.log('协议空间验证通过：旧内容完整迁移、事务回滚、模型可见 ID 与完整内容、精确更新删除、无效 ID 失败、按 AI 隔离及七类场景常驻注入。');
