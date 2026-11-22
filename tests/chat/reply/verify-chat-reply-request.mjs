/** 显式召唤沿原宿主执行；空输入表达陪伴意图，不伪造用户消息。 */
import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../../helpers/load-typescript-module.mjs';

const intent = loadTypeScriptModule('src/features/chat/reply/domain/UserSummonIntent.ts');
const notices = [], requests = [], modelCalls = [];
let requested = false, accepted = true;
const runtime = {
  turns: { requestUserReply: async () => { if (requested) return false; requested = true; return true; } },
  userReplyRequest: { onRequested: async id => { requests.push(id); return accepted; } },
  messages: {},
};
const { requestUserReply } = loadTypeScriptModule('src/features/chat/reply/application/RequestUserReply.ts', {
  '../../messages/application/ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => runtime },
  '../../messages/events/ChatEvents': { emitChatTurnExecutionChanged: id => notices.push(id) },
});
assert.equal(await requestUserReply('chat'), true);
assert.equal(await requestUserReply('chat'), false);
assert.deepEqual(requests, ['chat']);
assert.deepEqual(notices, ['chat']);
requested = false; accepted = false;
await assert.rejects(requestUserReply('chat'), /执行宿主/);
assert.equal(requested, true, '宿主未接收也不能抹掉已经持久化的用户意图');

let userMessages = [];
const { executeUserReplyTurn } = loadTypeScriptModule('src/features/chat/reply/application/ExecuteUserReplyTurn.ts', {
  '../../messages/application/ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => runtime },
  './BuildChatTurnAIInput': { buildChatTurnAIInput: async () => ({ userMessages, displayText: '合并输入',
    turnInputMessages: userMessages.map(message => ({ role: 'user', content: message.text })) }) },
  './ProcessAIReply': { processAIReply: async (...args) => modelCalls.push(args) },
  './SingleTransactionTurnCommit': { createSingleTransactionTurnCommit: () => ({ turnCommitOutcome: () => 'committed' }) },
  './ChatTurnPresentationRuntime': { ChatTurnPresentation: class { sink = {}; async start() {} async finish() {} } },
  '../domain/UserSummonIntent': intent,
});
const params = { run: { runId: 'summon', sessionId: 'chat', kind: 'summon', replyCursorAtClaim: 0, inputHighWatermark: 0 },
  aiConfig: { id: 'ai', agentId: 'actor' } };
assert.equal(await executeUserReplyTurn(params), 'committed');
assert.equal(modelCalls.at(-1)[1], intent.USER_SUMMON_INTENT);
assert.equal(modelCalls.at(-1)[6].forceAppendUserText, true);
assert.equal(modelCalls.at(-1)[6].triggerReason, 'user_summon');
assert.equal(modelCalls.at(-1)[6].relatedEntityType, 'conversation');
assert.deepEqual(modelCalls.at(-1)[6].batchedUserMessageIds, []);

userMessages = [{ id: 11, text: '第一句' }, { id: 15, text: '第二句' }];
assert.equal(await executeUserReplyTurn({ ...params, run: { ...params.run, inputHighWatermark: 15 } }), 'committed');
assert.deepEqual(modelCalls.at(-1)[6].batchedUserMessageIds, [11, 15], '一次召唤将全部累积消息交给原回复流程');
assert.equal(modelCalls.at(-1)[6].forceAppendUserText, undefined);
assert.equal(modelCalls.length, 2);
const member = { id: 'ai', agentId: 'actor', name: 'AI' };
const details = { group: { id: 'group' }, members: [{ aiAssistantId: 'ai', agentId: 'actor', muted: false }] };
let taskClaimed = false, taskStatus;
const { executeGroupSpeechTasks } = loadTypeScriptModule('src/features/chat/group/application/GroupSpeechTaskExecution.ts', {
  '../../reply/domain/UserSummonIntent': intent,
  '../../messages/domain/chatMessageMetadata': { getMessageAttachments: () => [] },
  '../../messages/application/ChatMessageRuntime': { getChatMessageRuntimeDependencies: () => runtime },
  './ChatGroupRuntime': { getChatGroupRuntimeDependencies: () => ({ groups: {
    claimNextQueuedSpeechTask: async () => taskClaimed ? null : (taskClaimed = true, { id: 'task', aiAssistantId: 'ai', source: 'admin' }),
    getById: async () => details, isSpeechTaskCommitEligible: async () => true,
    updateSpeechTaskStatus: async (_id, status) => { taskStatus = status; },
  } }) },
  '../../messages/events/ChatEvents': { emitChatMessagesUpdated() {} },
  '../../reply/application/ProcessAIReply': { processAIReply: async (...args) => { modelCalls.push(args); args[5].onFinalReply(); } },
  './GroupAssistantTurnCommit': { createGroupSegmentedReplyPersistence: () => ({ getReplyOutput: () => ({ visibleReplyCommitted: true }) }) },
  './GroupSpeechExecutionAbort': { registerGroupSpeechAbort: () => () => {} },
  './GroupParticipantDirectory': { getGroupParticipantDirectory: async () => ({
    assistants: [{ assistantId: 'ai', displayName: 'AI' }], currentUser: { displayName: '用户' },
  }) },
});
await executeGroupSpeechTasks({ planId: 'plan', details, currentUserMessages: [], inputUpperBoundMessageId: 0,
  memberProfiles: new Map([['ai', member]]) });
assert.equal(modelCalls.at(-1)[1], intent.USER_SUMMON_INTENT, '没有新消息的群成员同样知道用户想要陪伴');
assert.equal(modelCalls.at(-1)[6].forceAppendUserText, true);
assert.equal(taskStatus, 'completed');

const { buildGroupAdminInput } = loadTypeScriptModule('src/features/chat/group/application/GroupAdminReplyParser.ts', {
  '../../reply/domain/UserSummonIntent': intent,
  '../../messages/domain/chatMessageMetadata': {}, '../../messages/domain/SharedChatRecord': {},
  '../../messages/domain/SharedMoment': {}, './GroupMentionModelText': {},
});
assert.ok(buildGroupAdminInput({ groupName: '群', memberAliases: [], candidateAliases: [], userMessages: [], recentMessages: [] })
  .includes(intent.USER_SUMMON_INTENT), '没有新消息的管理员也接收同一用户意图');
console.log('显式召唤、陪伴意图、累积输入和唯一宿主交接验证通过。');
