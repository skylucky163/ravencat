/** 使用真实 SQLite 验证工具可见性、队列竞态、退出历史冻结和模型记忆转换。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';
import { createCoordinatedSqliteFixture, databaseErrors } from './helpers/coordinated-sqlite-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
const raw = createSqliteExecutor(db);
await bootstrapSqlite(raw);
const { databaseCoordinator: coordinator } = createCoordinatedSqliteFixture(raw);
const modules = new Map();
let modelCalls = [], modelResponse = { success: true, text: 'Model memory', finishReason: 'stop' }, beforeModelReturns;
let currentRun = true;
const nativeRequire = createRequire(import.meta.url);
function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} }; modules.set(filename, module);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const requireLocal = specifier => {
    if (filename.endsWith('createAgentToolRegistry.ts')) {
      if (specifier === '@features/memory') return load('src/features/memory/aiTools/MemoryAgentTools.ts');
      if (specifier === '@features/phoneTools/neteaseComposition') return { productionNetEaseChildTools: [] };
      if (specifier === '@features/phoneTools') return new Proxy(load('src/features/phoneTools/toolPackages/ToolPackageCatalog.ts'), {
        get: (target, key) => {
          if (Object.hasOwn(target, key)) return target[key];
          const name = ({ XiaohongshuPrepareTextNoteTool: 'xiaohongshu_prepare_text_note',
            XiaohongshuPublishPreparedNoteTool: 'xiaohongshu_publish_prepared_note' })[key] ?? String(key);
          return { name, definition: { name, parameters: { type: 'object' } } };
        },
      });
      if (specifier === './ShareMomentTool') return { ShareMomentTool: { name: 'share_moment', definition: { name: 'share_moment', description: '', parameters: { type: 'object' } } } };
      if (specifier === './ApplicationSettingsTools') return { applicationSettingsTools: [] };
      if (specifier === '@platform/agentRuntime') return load('src/platform/agentRuntime/AgentToolRegistry.ts');
      if (specifier.startsWith('@features/')) return new Proxy({}, { get: (_target, key) => ({
        name: String(key), definition: { name: String(key), description: String(key), parameters: { type: 'object' } },
        execute: async () => { throw new Error('Unrelated capability'); },
      }) });
    }
    if (specifier === '@platform/persistence') return { databaseCoordinator: coordinator, CoordinatedDatabaseError };
    if (specifier === '@platform/agentRuntime') return load('src/platform/agentRuntime/AgentRunState.ts');
    if (specifier === 'expo-crypto') return { randomUUID };
    if (specifier === '@features/media') return { resolveMediaAssetReferenceUri: async value => value.legacyUri,
      collectChatSessionMediaAssetCandidatesInTransaction: async () => [] };
    if (specifier === '@features/profile') return { removeConversationWallpaperInTransaction: async () => {} };
    if (specifier === '@platform/ai') return { createAIClient: () => ({ async chat(messages, options) {
      modelCalls.push({ messages, options });
      if (beforeModelReturns) await beforeModelReturns();
      return modelResponse;
    } }) };
    if (specifier === '@features/chat/composition') return { groupMembershipRepository: membership };
    if (specifier === '@features/memory/composition') return { ...memoryCommands, memoryEntryRepository,
      ...load('src/features/memory/application/MemoryRuntimeDependencies.ts'),
      ...load('src/features/memory/domain/Memory.ts'), ...load('src/features/memory/application/MemorySignals.ts') };
    if (specifier === '@features/assistants') return {
      aiAssistantRepository: { getById: async id => ({ id, agentId: `agent-${id}`, name: id, apiBaseUrl: 'https://model.test', apiKey: 'test', model: 'test' }) },
      getAssistantDisplayName: ai => ai.name, listAIAssistantSummaries: async () => db.prepare('SELECT id, agent_id AS agentId FROM ai_assistants').all() };
    if (specifier === '@features/chat') return { ...membershipCommands, GroupMembershipError,
      isGroupSpeechTaskRunCurrentInTransaction: (tx, id) => groups.isSpeechTaskRunCurrentInTransaction(tx, id),
      isChatReplyRunCurrentInTransaction: async () => currentRun };
    let location;
    if (specifier.startsWith('.')) location = path.resolve(path.dirname(filename), specifier);
    else if (specifier.startsWith('@shared/')) location = path.join(root, 'src/shared', specifier.slice(8));
    else return nativeRequire(specifier);
    for (const suffix of ['.ts', '.tsx', '/index.ts']) if (fs.existsSync(location + suffix)) return load(location + suffix);
    throw new Error(`无法加载 ${specifier}`);
  };
  new Function('require', 'module', 'exports', compiled)(requireLocal, module, module.exports);
  return module.exports;
}
const { CoordinatedDatabaseError } = databaseErrors;
const { groupMembershipRepository: membership } = load('src/features/chat/group/infrastructure/SQLiteGroupMembershipRepository.ts');
const { groupChatRepository: groups } = load('src/features/chat/group/infrastructure/SQLiteGroupChatRepository.ts');
const { SQLiteChatSummaryRepository } = load('src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts');
const summaries = new SQLiteChatSummaryRepository(async () => []);
const { GroupMembershipError } = load('src/features/chat/group/domain/GroupMembership.ts');
const membershipCommands = load('src/features/chat/group/application/GroupMembership.ts');
const { changeGroupMembers, renameGroupChat, listHistoricalGroups, setHistoricalGroupInjection, listGroupInviteCandidates } = membershipCommands;
const { memoryEntryRepository } = load('src/features/memory/infrastructure/SQLiteMemoryEntryRepository.ts');
const memoryCommands = load('src/features/memory/application/MemoryCommands.ts');
const stamp = '2026-10-22T08:00:00.000Z';
for (const [id, host] of [['host', 1], ['member', 0], ['new', 0], ['outside', 0]]) {
  db.prepare('INSERT INTO ai_assistants(id,agent_id,name,model,is_host_ai,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, `agent-${id}`, id, 'test', host, stamp, stamp);
}
db.prepare("INSERT INTO chat_conversations VALUES ('g','group')").run();
db.prepare('INSERT INTO group_chats(id,name,created_at,updated_at) VALUES (?,?,?,?)').run('g', '原群名', stamp, stamp);
const userId = db.prepare('SELECT id FROM user_profile').get().id;
db.prepare('INSERT INTO memory_pools(id,user_profile_id,ai_assistant_id,created_at,updated_at) VALUES (?,?,?,?,?)').run('pool-member', userId, 'member', stamp, stamp);
load('src/features/memory/application/MemoryRuntimeDependencies.ts').configureMemoryRuntimeDependencies({
  repository: memoryEntryRepository, resolveMemorySpace: async () => ({ poolId: 'pool-member' }),
});
const messages = {
  async commitMessageInTransaction(tx, { message: value }) {
    const row = await tx.runAsync(`INSERT INTO messages(session_id,text,is_me,is_read,sender_type,status,metadata_json,time,created_at,updated_at,turn_run_id,turn_item_index)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [value.sessionId, value.text, value.isMe ? 1 : 0, 1, value.senderType, value.status, value.metadataJson ?? null, value.time ?? '', value.createdAt, value.updatedAt, value.turnRunId ?? null, value.turnItemIndex ?? null]);
    return { ...value, id: row.lastInsertRowId };
  },
};
load('src/features/chat/messages/application/ChatMessageRuntime.ts').configureChatMessageRuntime({ messages });
load('src/features/chat/group/application/ChatGroupRuntime.ts').configureChatGroupRuntime({
  groups, membership, assistantDirectory: { list: async () => db.prepare('SELECT id, name FROM ai_assistants').all(), getById: async () => null },
  captureHistory: (tx, groupId, groupName) => summaries.captureGroupHistoryInTransaction(tx, groupId, groupName),
});
load('src/features/chat/summary/application/ChatSummaryRuntime.ts').configureChatSummaryRuntime({
  repository: summaries, generateAddition: () => { throw new Error('成员变更不得调用总结模型'); },
});
const user = { kind: 'user' }, host = { kind: 'assistant', assistantId: 'host' }, member = { kind: 'assistant', assistantId: 'member' };
await changeGroupMembers('g', 'add', ['host', 'member'], user);
assert.deepEqual((await listGroupInviteCandidates('g')).map(ai => ai.id).sort(), ['new', 'outside']);
const { groupManagementTools } = load('src/host/composition/agent/GroupManagementTools.ts');
const { matchesAgentToolInputSchema } = load('src/shared/aiTools/AgentToolInputSchema.ts');
const registration = load('src/host/composition/agent/createAgentToolRegistry.ts');
const toolNames = groupManagementTools.map(({ tool }) => tool.name);
const conversionName = 'convert_exited_group_history_to_memory';
const policy = { enableTools: true, memoryParticipation: 'read_write', allowedToolNames: [...toolNames, conversionName] };
const generalGroupNames = ['search_groups', 'join_group', 'add_group_member', 'leave_group', 'rename_group'];
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI(policy), [...generalGroupNames, conversionName]);
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({ ...policy, isHostAI: true }), [...toolNames, conversionName]);
for (const triggerSource of ['chat', 'group_chat', 'call']) {
  assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI({ ...policy, triggerSource, memoryParticipation: 'none' }), generalGroupNames,
    '普通 AI 在单聊、群聊和通话中均可使用群聊工具，且不依赖记忆参与开关');
}
const registry = registration.createAgentToolRegistry({ createLegacyContext: () => ({}) });
const exposure = load('src/host/composition/agent/ToolPackageExposure.ts').registerToolPackagesForHostRun({
  registry, allowedToolNames: registration.getRuntimeAllowedToolNamesForAI(policy),
  bindings: registration.getToolPackageRuntimeBindings(registry), openPackageIds: [],
});
assert.ok(exposure.instructions().catalog.includes(conversionName));
assert.ok(!exposure.visibleToolNames().includes(conversionName));
assert.ok(!exposure.visibleToolNames().includes('search_groups'));
await registry.get('open_tool_package').execute({ package_id: 'groupChat' });
assert.deepEqual(exposure.visibleToolNames(), generalGroupNames, '群工具常驻群聊包，拆开后普通 AI 可以看到搜索、入群和邀请');
assert.equal(registry.get('search_groups').descriptor.risk, 'private_read');
await registry.get('open_tool_package').execute({ package_id: 'memory' });
assert.ok(exposure.visibleToolNames().includes(conversionName));
const tools = Object.fromEntries(groupManagementTools.map(entry => [entry.tool.name, entry.tool]));
const toolContext = id => ({ task: { assistantId: id, type: 'chat_reply', source: 'chat' }, runId: 'direct-run', abortSignal: new AbortController().signal });

// 搜索只返回真实名称与 ID，允许发现尚未加入的群；% 和 _ 均按字面匹配。
for (const [id, name] of [['discover-a', '周末观影'], ['discover-b', '周末观影·备选'], ['discover-literal', '周末_100%观影'], ['discover-en', 'Film CLUB']]) {
  db.prepare('INSERT INTO chat_conversations VALUES (?,?)').run(id, 'group');
  db.prepare('INSERT INTO group_chats(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, name, stamp, stamp);
}
const search = async keyword => {
  const result = await tools.search_groups.execute({ keyword }, toolContext('outside'));
  if (result.status === 'success') result.data = JSON.parse(result.modelContent);
  return result;
};
assert.deepEqual((await search('  周末观影  ')).data.groups, [
  { groupId: 'discover-a', name: '周末观影' }, { groupId: 'discover-b', name: '周末观影·备选' },
]);
assert.deepEqual((await search('club')).data.groups, [{ groupId: 'discover-en', name: 'Film CLUB' }]);
assert.deepEqual((await search('%')).data.groups, [{ groupId: 'discover-literal', name: '周末_100%观影' }]);
assert.deepEqual((await search('_')).data.groups, [{ groupId: 'discover-literal', name: '周末_100%观影' }]);
assert.deepEqual((await search('不存在的群名')).data.groups, []);
assert.equal((await search('   ')).status, 'error');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM group_chat_members WHERE ai_assistant_id='outside'").get().n, 0, '搜索本身不加入群');

const join = (groupId, id = 'outside') => tools.join_group.execute({ group_id: groupId }, toolContext(id));
const invite = (groupId, agentId) => tools.add_group_member.execute({ group_id: groupId, agent_id: agentId }, toolContext('outside'));
const discoverPlan = await groups.tryClaimGroupSpeechPlan('discover-a');
const joinedTogether = await Promise.all([join('discover-a'), join('discover-a')]);
assert.equal(joinedTogether.filter(result => result.data.message === '你已在该群聊').length, 1);
assert.ok(joinedTogether.every(result => result.status === 'success'));
const joinedRow = db.prepare("SELECT * FROM group_chat_members WHERE group_id='discover-a' AND ai_assistant_id='outside'").get();
assert.equal(joinedRow.enabled, 1);
assert.equal(joinedRow.joined_during_plan_id, discoverPlan.plan.id);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='discover-a'").get().n, 1, '并发申请只加入一次、只发一条加入提示');
db.prepare("UPDATE group_chat_members SET muted=1 WHERE group_id='discover-a' AND ai_assistant_id='outside'").run();
assert.equal((await join('discover-a')).data.message, '你已在该群聊');
assert.equal(db.prepare("SELECT muted FROM group_chat_members WHERE group_id='discover-a' AND ai_assistant_id='outside'").get().muted, 1, '重复申请不能解除禁言');
assert.equal((await join('missing-group')).status, 'error');
assert.equal(matchesAgentToolInputSchema({ group_id: 'discover-a', agent_id: 'agent-new' }, tools.join_group.definition.parameters), false, '入群只能使用调用 AI 的可信身份');

const invitedTogether = await Promise.all([invite('discover-b', 'agent-new'), invite('discover-b', 'agent-new')]);
assert.equal(invitedTogether.filter(result => result.status === 'success').length, 1);
assert.equal(db.prepare("SELECT enabled FROM group_chat_members WHERE group_id='discover-b' AND ai_assistant_id='new'").get().enabled, 1, '普通 AI 可从私聊邀请 Agent ID 对应 AI 加入指定群');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='discover-b'").get().n, 1);
assert.equal((await invite('discover-b', 'missing-agent')).status, 'error');
await renameGroupChat('discover-b', '最新的真实群名', user);
assert.deepEqual((await search('最新的真实')).data.groups, [{ groupId: 'discover-b', name: '最新的真实群名' }], '搜索读取现有群名，不返回旧快照名称');
await changeGroupMembers('discover-a', 'leave', ['outside'], { kind: 'assistant', assistantId: 'outside' });
assert.equal((await listHistoricalGroups('outside')).length, 1);
assert.equal((await join('discover-a')).status, 'success');
assert.deepEqual(await listHistoricalGroups('outside'), [], '直接加入也沿用重新入群的历史切换');

db.prepare('INSERT INTO ai_blacklist(id,ai_id,blocked_by,blocked_until,created_at) VALUES (?,?,?,?,?)')
  .run('group-tool-block', 'outside', 'host', '9999-12-31T00:00:00.000Z', stamp);
assert.equal((await join('discover-en')).status, 'error');
assert.equal((await invite('discover-en', 'agent-outside')).status, 'error', '加入和邀请继续遵循现有黑名单规则');
db.prepare("DELETE FROM ai_blacklist WHERE id='group-tool-block'").run();

currentRun = false;
await assert.rejects(join('discover-en'), error => error.cause.code === 'SUPERSEDED');
await assert.rejects(invite('discover-en', 'agent-new'), error => error.cause.code === 'SUPERSEDED');
currentRun = true;
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM group_chat_members WHERE group_id='discover-en'").get().n, 0, '失效回合不写入成员事实');
assert.equal((await tools.rename_group.execute({ group_id: 'g', name: '普通成员可改名' }, toolContext('member'))).status, 'success');
assert.equal(db.prepare('SELECT turn_run_id FROM messages ORDER BY id DESC LIMIT 1').get().turn_run_id, null, '私聊中修改群名不会把群提示绑定到私聊回合');
assert.equal((await tools.leave_group.execute({}, toolContext('member'))).code, 'GROUP_REQUIRED');
assert.equal(matchesAgentToolInputSchema({ group_id: 'g', agent_id: 'agent-host' }, tools.leave_group.definition.parameters), false);
await assert.rejects(changeGroupMembers('g', 'mute', ['member'], host, async () => { throw new DOMException('旧回合', 'AbortError'); }), /旧回合/);
assert.equal(db.prepare("SELECT muted FROM group_chat_members WHERE ai_assistant_id='member'").get().muted, 0);
await renameGroupChat('g', '新群名', member);
assert.equal(db.prepare('SELECT name FROM group_chats').get().name, '新群名');

// 规划进行中新增成员从下一轮参与；晚到的规划不会给禁言或退出者建立新任务。
const plan = await groups.tryClaimGroupSpeechPlan('g');
await groups.beginSpeechPlanPreparation(plan.plan.id);
await changeGroupMembers('g', 'add', ['new'], host);
await changeGroupMembers('g', 'mute', ['member'], host);
assert.equal(db.prepare("SELECT enabled FROM group_chat_members WHERE ai_assistant_id='member'").get().enabled, 1);
const makeTask = (ai, id = `task-${ai}`) => ({ id, groupId: 'g', aiAssistantId: ai, agentId: `agent-${ai}`, source: 'admin' });
await groups.activateSpeechPlanWithTasks(plan.plan.id, { tasks: ['host', 'member', 'new'].map(ai => makeTask(ai)), mentionAssistantIds: [] });
assert.deepEqual((await groups.listSpeechPlanTasks(plan.plan.id)).map(task => task.aiAssistantId), ['host']);
await changeGroupMembers('g', 'unmute', ['member'], host);
const hostTask = await groups.claimNextQueuedSpeechTask(plan.plan.id);
// 群内操作产生的提示归入发起回合，过程临时展示和持久化后的顺序必须相同。
await tools.rename_group.execute({ name: '新群名' }, { task: { type: 'group_chat_reply', source: 'group_chat', assistantId: 'host', sessionId: 'g' },
  runId: hostTask.id, abortSignal: new AbortController().signal });
const noticeRow = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 1').get();
assert.equal(noticeRow.turn_run_id, hostTask.id);
assert.equal(noticeRow.turn_item_index, null);
const notice = { ...noticeRow, createdAt: noticeRow.created_at, turnRunId: noticeRow.turn_run_id, turnItemIndex: null };
const time = delta => new Date(Date.parse(notice.createdAt) + delta).toISOString();
const canonical = ['Reasoning', 'Action', 'Follow-up', 'Reply'].map((text, index) => ({
  id: -index - 1, text, turnRunId: hostTask.id, turnItemIndex: index + 1,
  createdAt: time([-2000, -1000, 1000, 2000][index]),
}));
const { sortChatTimelineMessages } = load('src/features/chat/messages/domain/ChatTimelineOrdering.ts');
const expectedOrder = ['Reasoning', 'Action', notice.text, 'Follow-up', 'Reply'];
assert.deepEqual(sortChatTimelineMessages([...canonical].reverse().concat(notice)).map(item => item.text), expectedOrder);
const persisted = [];
for (const item of canonical) {
  persisted.push(await coordinator.transaction({ name: 'test.persist-timeline', feature: 'chat', priority: 'interactive' }, tx => messages.commitMessageInTransaction(tx, { message: {
    ...item, sessionId: 'g', senderType: 'assistant', status: 'sent', updatedAt: item.createdAt,
  } })));
}
assert.deepEqual(sortChatTimelineMessages([notice, ...persisted]).map(item => item.text), expectedOrder);
const { timelineOrderedMessagesCte, timelineProjectionOrderBy } = load('src/features/chat/messages/infrastructure/ChatTimelineSql.ts');
const sqlOrder = db.prepare(`${timelineOrderedMessagesCte('m.session_id = ? AND m.turn_run_id = ?')} SELECT text FROM ordered_messages ORDER BY ${timelineProjectionOrderBy('ASC')}`)
  .all('g', hostTask.id).map(item => item.text);
assert.deepEqual(sqlOrder, expectedOrder);
await coordinator.transaction({ name: 'test.materialize-mentions', feature: 'chat', priority: 'interactive' }, tx => groups.materializeAIMentionSpeechTasksInTransaction(tx, plan.plan.id, hostTask, [makeTask('member'), makeTask('new')]));
assert.deepEqual((await groups.listSpeechPlanTasks(plan.plan.id)).map(task => task.aiAssistantId), ['host', 'member']);
await groups.updateSpeechTaskStatus(hostTask.id, 'completed');
const running = await groups.claimNextQueuedSpeechTask(plan.plan.id);
assert.equal(running.aiAssistantId, 'member');
const { registerGroupSpeechAbort } = load('src/features/chat/group/application/GroupSpeechExecutionAbort.ts');
const hostController = new AbortController(), memberController = new AbortController();
const unregisterHost = registerGroupSpeechAbort(plan.plan.id, hostController, hostTask.id);
const unregisterMember = registerGroupSpeechAbort(plan.plan.id, memberController, running.id);

await summaries.create('g', 'summary-old', '退出前的既有摘要', stamp, 'Asia/Shanghai');
await coordinator.transaction({ name: 'test.group-message', feature: 'chat', priority: 'interactive' }, tx => messages.commitMessageInTransaction(tx, { message: {
  sessionId: 'g', text: '退出前原文', isMe: true, senderType: 'user', status: 'sent', createdAt: stamp, updatedAt: stamp,
} }));
for (const [senderType, text] of [['user', 'Long history '.repeat(2000)], ['tool', 'TOOL_INTERNAL_TRACE']]) {
  await coordinator.transaction({ name: 'test.group-message', feature: 'chat', priority: 'interactive' }, tx => messages.commitMessageInTransaction(tx, { message: {
    sessionId: 'g', text, isMe: senderType === 'user', senderType, status: 'sent', createdAt: stamp, updatedAt: stamp,
  } }));
}
const beforeFailedChange = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
await assert.rejects(changeGroupMembers('g', 'remove', ['member', 'outside'], host), /已不在/);
assert.equal(db.prepare("SELECT enabled FROM group_chat_members WHERE ai_assistant_id='member'").get().enabled, 1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, beforeFailedChange);
const leaveResult = await tools.leave_group.execute({}, { task: { type: 'group_chat_reply', source: 'group_chat', assistantId: 'member', sessionId: 'g' },
  runId: running.id, abortSignal: memberController.signal });
assert.equal(leaveResult.status, 'success');
assert.equal(memberController.signal.aborted, true);
assert.equal(hostController.signal.aborted, false, '成员退出不能中止其他成员的请求');
unregisterHost(); unregisterMember();
assert.equal(await groups.isSpeechTaskCommitEligible(plan.plan.id, running.id), false);
const [history] = await listHistoricalGroups('member');
assert.equal(history.groupName, '新群名');
assert.ok(history.context.timeline.some(item => item.content.includes('退出前原文')));
assert.ok(history.context.contextSegments.some(item => item.content === '退出前的既有摘要'));
await assert.rejects(summaries.readSecondaryForAssistant('member', 'g'), /无权/);
await renameGroupChat('g', '后来改的群名', host);
await summaries.create('g', 'summary-new', '退出后新摘要', new Date().toISOString(), 'Asia/Shanghai');
await summaries.edit('g', 'summary-old', '被其他人修改的摘要', new Date().toISOString());
const readBackground = () => summaries.readBackgroundContexts('member', 'direct-member', { privateLimit: 0, groupLimit: 3 });
let contexts = await readBackground();
assert.equal(contexts[0].name, '新群名');
assert.equal(contexts[0].membership.status, 'left');
assert.equal(contexts[0].membership.reason, undefined, '模型背景不重复提供移除原因');
assert.ok(!JSON.stringify(contexts).includes('退出后新摘要'));
assert.ok(!JSON.stringify(contexts).includes('被其他人修改的摘要'));
await setHistoricalGroupInjection('member', history.id, false);
assert.deepEqual(await readBackground(), []);
await setHistoricalGroupInjection('member', history.id, true);
assert.deepEqual(await summaries.readBackgroundContexts('member', 'direct-member', { privateLimit: 0, groupLimit: 0 }), []);
const { convertExitedGroupHistoryToMemory } = load('src/host/application/ConvertExitedGroupHistoryToMemory.ts');
const { ConvertExitedGroupHistoryTool } = load('src/features/memory/aiTools/MemoryAgentTools.ts');
load('src/features/memory/application/MemoryRuntimeDependencies.ts').configureMemoryRuntimeDependencies({
  repository: memoryEntryRepository, resolveMemorySpace: async () => ({ poolId: 'pool-member' }),
  convertExitedGroupHistory: convertExitedGroupHistoryToMemory,
});
const convert = (id = 'member', context = toolContext(id)) => ConvertExitedGroupHistoryTool.execute({ group_id: 'g' }, context);
const converted = await convert();
assert.equal(converted.status, 'success');
assert.equal(converted.data.summary, '【群聊·新群名】');
const modelSource = JSON.parse(modelCalls[0].messages[1].content);
assert.ok(modelSource.messages.some(item => item.content.length >= 20000));
assert.ok(!JSON.stringify(modelSource).includes('TOOL_INTERNAL_TRACE'));
assert.ok(modelSource.summaries.length > 0);
assert.equal((await listHistoricalGroups('member'))[0].injectEnabled, true);
await memoryCommands.editMemory('member', converted.data.id, 'Edited memory');
assert.equal((await convert()).data.content, 'Edited memory');
assert.equal(modelCalls.length, 1);
assert.equal((await convert('outside')).status, 'error');

await changeGroupMembers('g', 'add', ['member'], host);
assert.deepEqual(await listHistoricalGroups('member'), []);
assert.match((await convert()).modelContent, /无法在未退出的群使用/);
contexts = await readBackground();
assert.equal(contexts.length, 1);
assert.equal(contexts[0].membership, undefined);
assert.ok(JSON.stringify(contexts).includes('退出后新摘要'));
await changeGroupMembers('g', 'remove', ['member'], host);
assert.equal((await listHistoricalGroups('member')).length, 1);
const countMemories = () => db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n;
const initialCount = countMemories();
modelResponse = { success: true, text: 'x'.repeat(501), finishReason: 'stop' };
assert.match((await convert()).modelContent, /500/);
assert.equal(countMemories(), initialCount);
modelResponse = { success: false, text: '', error: 'HTTP 429: quota exceeded for model test' };
const failedConversion = await convert();
assert.equal(failedConversion.status, 'error');
assert.ok(failedConversion.modelContent.includes(modelResponse.error), '转换失败保留客户端已脱敏的接口原因');
assert.equal(countMemories(), initialCount);
assert.equal((await listHistoricalGroups('member')).length, 1, '失败保留退出历史');
modelResponse = { success: true, text: 'Incomplete', finishReason: 'length' };
assert.equal((await convert()).status, 'error');
modelResponse = { success: true, text: 'New memory', finishReason: 'stop' };
beforeModelReturns = () => changeGroupMembers('g', 'add', ['member'], host);
assert.match((await convert()).modelContent, /无法在未退出的群使用/);
assert.equal(countMemories(), initialCount);
await changeGroupMembers('g', 'remove', ['member'], host);
beforeModelReturns = async () => {
  await changeGroupMembers('g', 'add', ['member'], host);
  await changeGroupMembers('g', 'remove', ['member'], host);
};
assert.match((await convert()).modelContent, /退出历史已经更新/);
assert.equal(countMemories(), initialCount);
beforeModelReturns = undefined;
currentRun = false;
await assert.rejects(convert(), error => error.cause.code === 'SUPERSEDED');
currentRun = true;
const controller = new AbortController();
beforeModelReturns = () => controller.abort();
await assert.rejects(convert('member', { ...toolContext('member'), abortSignal: controller.signal }), { name: 'AbortError' });
assert.equal(countMemories(), initialCount);
beforeModelReturns = undefined;
const convertedTogether = await Promise.all([convert(), convert()]);
assert.equal(convertedTogether[0].data.id, convertedTogether[1].data.id);
assert.equal(countMemories(), initialCount + 1);
await memoryCommands.forgetMemory('member', convertedTogether[0].data.id);
assert.equal((await convert()).status, 'error');
const competing = await Promise.allSettled([changeGroupMembers('g', 'add', ['member'], host), changeGroupMembers('g', 'add', ['member'], host)]);
assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
await changeGroupMembers('g', 'remove', ['member'], host);
await summaries.updateSettings('g', { injectEnabled: false });
await changeGroupMembers('g', 'add', ['member'], host);
await changeGroupMembers('g', 'remove', ['member'], host);
const retained = (await listHistoricalGroups('member'))[0];
assert.ok(retained.context.contextSegments.length > 0, '关闭摘要自动注入仍保留可供用户转存的摘要正文');
assert.equal((await readBackground())[0].contextSegments.length, 0);
await summaries.updateSettings('g', { injectEnabled: true });
assert.equal((await readBackground())[0].contextSegments.length, 0, '原群设置后续变化不能更新退出快照');
const frozen = JSON.stringify((await listHistoricalGroups('member'))[0].context);
db.prepare("DELETE FROM group_chats WHERE id='g'").run();
assert.equal(JSON.stringify((await listHistoricalGroups('member'))[0].context), frozen);
assert.equal((await readBackground()).length, 1, '原群删除后退出历史仍可按设置读取');
await setHistoricalGroupInjection('member', retained.id, false);
assert.deepEqual(await readBackground(), []);
assert.equal((await convert()).status, 'success', '关闭注入、删除原群后仍可转换自己的冻结历史');
assert.equal((await listHistoricalGroups('member'))[0].injectEnabled, false);
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
// 生产协调器会包装事务异常；已达到目标禁言状态应成功返回，且不写入任何变更。
const originalTransaction = coordinator.transaction.bind(coordinator);
let rolledBack = 0;
coordinator.transaction = async (meta, operation) => {
  try { return await originalTransaction(meta, operation); }
  catch (error) { rolledBack++; throw error; }
};
const muteGroup = 'mute-result';
db.prepare('INSERT INTO chat_conversations VALUES (?,?)').run(muteGroup, 'group');
db.prepare('INSERT INTO group_chats(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(muteGroup, '禁言结果验证', stamp, stamp);
await changeGroupMembers(muteGroup, 'add', ['host', 'member', 'new'], user);
const muteOperation = action => tools[`${action}_group_member`].execute({ group_id: muteGroup, agent_id: 'agent-member' }, toolContext('host'));
const muteNoticeCount = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(muteGroup).n;
const memberMuted = () => db.prepare('SELECT muted FROM group_chat_members WHERE group_id=? AND ai_assistant_id=?').get(muteGroup, 'member').muted;
const prohibitNoopWrites = () => db.exec(`CREATE TRIGGER reject_noop_member_update BEFORE UPDATE ON group_chat_members
  WHEN NEW.group_id = 'mute-result' BEGIN SELECT RAISE(ABORT, 'no-op-wrote-member'); END;`);
let noticeCount = muteNoticeCount();
prohibitNoopWrites();
let muteResult = await muteOperation('unmute');
assert.equal(muteResult.status, 'success');
assert.ok(muteResult.data.message.includes('member 未被禁言'));
assert.equal(memberMuted(), 0);
assert.equal(muteNoticeCount(), noticeCount, '未被禁言无需再解除，不生成虚假的群提示');
assert.equal(rolledBack, 0, '正常状态结果不触发事务回滚');
db.exec('DROP TRIGGER reject_noop_member_update');
assert.equal((await muteOperation('mute')).status, 'success');
noticeCount++;
prohibitNoopWrites();
muteResult = await muteOperation('mute');
assert.equal(muteResult.status, 'success');
assert.ok(muteResult.data.message.includes('member 已被禁言'));
assert.equal(memberMuted(), 1);
assert.equal(muteNoticeCount(), noticeCount);
db.exec('DROP TRIGGER reject_noop_member_update');
const unmutedTogether = await Promise.all([muteOperation('unmute'), muteOperation('unmute')]);
assert.ok(unmutedTogether.every(result => result.status === 'success'));
assert.equal(memberMuted(), 0);
assert.equal(muteNoticeCount(), ++noticeCount, '并发解除禁言只发送一次真实变更提示');
assert.equal(rolledBack, 0);

// 批量解除可混合已解除和仍禁言成员，不能提前返回而漏掉其他目标。
for (const ids of [['member', 'new'], ['new', 'member']]) {
  await changeGroupMembers(muteGroup, 'mute', ['new'], host);
  const result = await changeGroupMembers(muteGroup, 'unmute', ids, host);
  assert.equal(result.message, 'host 解除了 new 的禁言');
  assert.equal(db.prepare('SELECT muted FROM group_chat_members WHERE group_id=? AND ai_assistant_id=?').get(muteGroup, 'new').muted, 0);
}
const denied = await tools.unmute_group_member.execute({ group_id: muteGroup, agent_id: 'agent-outside' }, toolContext('host'));
assert.equal(denied.status, 'error', '不在群的成员仍返回明确的业务拒绝');
assert.equal(denied.code, 'GROUP_OPERATION_DENIED', '事务包装不能让已知业务拒绝变成工具执行异常');

noticeCount = muteNoticeCount();
db.exec(`CREATE TRIGGER reject_real_member_update BEFORE UPDATE ON group_chat_members
  WHEN NEW.group_id = 'mute-result' BEGIN SELECT RAISE(ABORT, 'simulated-storage-failure'); END;`);
await assert.rejects(muteOperation('mute'), error => error instanceof CoordinatedDatabaseError
  && error.cause.message.includes('simulated-storage-failure'), '真正的持久化失败仍应暴露');
assert.equal(memberMuted(), 0);
assert.equal(muteNoticeCount(), noticeCount);
db.exec('DROP TRIGGER reject_real_member_update');
db.close();
console.log('群工具跨场景拆包、关键词搜索、直接入群与邀请、并发及队列裁决、提示排序、退出快照与记忆转换验证通过。');
