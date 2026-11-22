/** Chat external assistant command 最小真实行为测试。 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { arrivalModuleUrl, arrival } from '../../helpers/chat-message-arrival-fixture.mjs';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

const trace = [];
const deliveries = [];
const observerNotifications = [];
let arrivalRevision = 0;
arrival.configureAssistantMessageArrivalRuntime({
  async begin({ observer, messageIds }) {
    return { revision: ++arrivalRevision, pendingMessageIds: messageIds, pendingSessionIds: [observer.sessionId] };
  },
  async finish() {
    return { revision: ++arrivalRevision, pendingMessageIds: [], pendingSessionIds: [] };
  },
});

const committedRows = [
  {
    id: 41,
    sessionId: 'session-external',
    text: '第一段',
    isMe: false,
    isRead: false,
    senderType: 'assistant',
    agentId: 'agent-external',
    time: '12:00',
    createdAt: '2026-08-11T04:00:00.000Z',
    updatedAt: '2026-08-11T04:00:00.000Z',
    showTimeSeparatorBefore: true,
    status: 'sent',
    deliveryStatus: 'delivered',
    segmentIndex: 0,
    segmentTotal: 2,
    logicalMessageId: null,
    metadataJson: JSON.stringify({
      actorAIId: 'ai-external',
      actorAgentId: 'agent-external',
      kind: 'external_assistant_test',
      triggerSource: 'internal_feature',
      relatedEntityType: 'internal_task',
      relatedEntityId: 'task-1',
      segmentIndex: 0,
      segmentTotal: 2,
    }),
  },
  {
    id: 42,
    sessionId: 'session-external',
    text: '第二段',
    isMe: false,
    isRead: false,
    senderType: 'assistant',
    agentId: 'agent-external',
    time: '12:00',
    createdAt: '2026-08-11T04:00:01.000Z',
    updatedAt: '2026-08-11T04:00:01.000Z',
    showTimeSeparatorBefore: false,
    status: 'sent',
    deliveryStatus: 'delivered',
    segmentIndex: 1,
    segmentTotal: 2,
    logicalMessageId: null,
    metadataJson: JSON.stringify({
      actorAIId: 'ai-external',
      actorAgentId: 'agent-external',
      kind: 'external_assistant_test',
      triggerSource: 'internal_feature',
      relatedEntityType: 'internal_task',
      relatedEntityId: 'task-1',
      segmentIndex: 1,
      segmentTotal: 2,
    }),
  },
];

const fakeRepository = {
  async commitMessages(input) {
    trace.push({ kind: 'commit', input });
    assert.equal(input.previewText, '第二段');
    assert.deepEqual(input.messages.map(({ text }) => text), ['第一段', '第二段']);
    assert.deepEqual(
      input.messages.map(({ segmentIndex, segmentTotal }) => [segmentIndex, segmentTotal]),
      [[0, 2], [1, 2]],
    );
    assert.equal(input.messages[0].tokensUsed, 0, '非末段不得重复写入 token usage');
    assert.equal(input.messages[1].tokensUsed, 9, 'token usage 只落在末段');
    assert.equal(input.messages[0].metadataJson.includes('external_assistant_test'), true);
    assert.equal(input.messages[0].metadataJson.includes('task-1'), true);
    return committedRows;
  },
};

const runtimeModuleUrl = transpileToModuleUrl(`
export function getChatMessageRuntimeDependencies() {
  return { messages: globalThis.__externalCommandRepository };
}
`);
const aiEventsModuleUrl = transpileToModuleUrl(`
export function resolveAIMessageDeliveryKind() { return 'proactive'; }
export async function emitAIMessageReceived(payload) {
  globalThis.__externalCommandDeliveries.push(payload);
  globalThis.__externalCommandTrace.push({ kind: 'delivery', payload });
  return { status: 'shown', errorCategory: null };
}
export function notifyAIMessageObservers(payload) {
  globalThis.__externalCommandObserverNotifications.push(payload);
  globalThis.__externalCommandTrace.push({ kind: 'observer', payload });
}
`);
const chatEventsModuleUrl = transpileToModuleUrl(`
export function emitChatMessagesUpdated(sessionId) {
  globalThis.__externalCommandTrace.push({ kind: 'ui', sessionId });
}
`);
globalThis.__externalCommandRepository = fakeRepository;
globalThis.__externalCommandDeliveries = deliveries;
globalThis.__externalCommandTrace = trace;
globalThis.__externalCommandObserverNotifications = observerNotifications;

const source = read('src/features/chat/messages/application/AppendExternalAssistantMessages.ts')
  .replace("from '@platform/persistence'", `from '${transpileToModuleUrl(`export const databaseCoordinator = { transaction: (_, work) => work({}) };`)}'`)
  .replace("from '../../group/application/ChatGroupRuntime'", `from '${transpileToModuleUrl(`export function getChatGroupRuntimeDependencies() { return { groups: globalThis.__externalCommandGroups }; }`)}'`)
  .replace("from '../../reply/delivery/AssistantMessageArrival'", `from '${arrivalModuleUrl}'`)
  .replace(
    /from ['"]\.\/ChatMessageRuntime['"]/,
    `from '${runtimeModuleUrl}'`,
  )
  .replace(
    /from ['"]\.\.\/\.\.\/reply\/delivery\/AIMessageEvents['"]/,
    `from '${aiEventsModuleUrl}'`,
  )
  .replace(
    /from ['"]\.\.\/events\/ChatEvents['"]/,
    `from '${chatEventsModuleUrl}'`,
  );

const { appendExternalAssistantMessages } = await import(transpileToModuleUrl(source));
globalThis.__externalCommandGroups = { getById: async () => null };
const result = await appendExternalAssistantMessages({
  sessionId: 'session-external',
  segments: ['第一段', '第二段'],
  aiId: 'ai-external',
  aiName: 'External AI',
  agentId: 'agent-external',
  deliveryKind: 'proactive',
  triggerSource: 'internal_feature',
  relatedEntityType: 'internal_task',
  relatedEntityId: 'task-1',
  metadata: {
    actorAIId: 'ai-external',
    actorAgentId: 'agent-external',
    kind: 'external_assistant_test',
  },
  tokensUsed: 9,
});

assert.deepEqual(result.committedMessageIds, [41, 42]);
assert.equal(result.segmentTotal, 2);
assert.equal(deliveries.length, 2, '每个 committed segment 只能触发一次 delivery');
assert.deepEqual(deliveries.map(({ committedMessageId }) => committedMessageId), [41, 42]);
assert.deepEqual(
  trace.map((entry) => entry.kind),
  ['commit', 'ui', 'delivery', 'delivery'],
  '所有 UI/delivery 必须发生在单次 commit 完成之后',
);
assert.equal(deliveries[0].segmentIndex, 0);
assert.equal(deliveries[1].segmentIndex, 1);
assert.equal(deliveries[0].segmentTotal, 2);
assert.equal(deliveries[1].segmentTotal, 2);

trace.length = 0;
deliveries.length = 0;
globalThis.__externalCommandRepository = {
  async commitMessages() {
    trace.push({ kind: 'commit-failed' });
    throw new Error('injected batch failure');
  },
};
await assert.rejects(
  appendExternalAssistantMessages({
    sessionId: 'session-external',
    segments: ['不会落库'],
    aiId: 'ai-external',
    aiName: 'External AI',
    triggerSource: 'internal_feature',
  }),
  /injected batch failure/,
);
assert.deepEqual(trace.map((entry) => entry.kind), ['commit-failed']);
assert.equal(deliveries.length, 0, 'commit 失败不得触发 delivery');

trace.length = 0;
deliveries.length = 0;
observerNotifications.length = 0;
globalThis.__externalCommandRepository = {
  async commitMessages() {
    trace.push({ kind: 'commit' });
    return [{
      ...committedRows[0],
      id: 51,
      text: '通话挂断后的跟进消息',
      segmentIndex: 0,
      segmentTotal: 1,
      createdAt: '2026-08-11T05:00:00.000Z',
      updatedAt: '2026-08-11T05:00:00.000Z',
    }];
  },
};
const noDeliveryResult = await appendExternalAssistantMessages({
  sessionId: 'session-external',
  segments: ['通话挂断后的跟进消息'],
  aiId: 'ai-external',
  aiName: 'External AI',
  agentId: 'agent-external',
  triggerSource: 'call',
  delivery: 'none',
});
assert.equal(noDeliveryResult.deliveryReceipts.length, 0, '免交付事实不得产生交付回执');
assert.equal(deliveries.length, 0, 'delivery: none 不得调用系统交付处理器');
assert.equal(observerNotifications.length, 1, '免交付事实仍必须通知 UI 观察者刷新列表投影');
assert.equal(observerNotifications[0].sessionId, 'session-external');
assert.equal(observerNotifications[0].aiId, 'ai-external');
assert.equal(observerNotifications[0].committedMessageId, 51);
assert.deepEqual(
  trace.map((entry) => entry.kind),
  ['commit', 'ui', 'observer'],
  '免交付事实的观察者通知必须发生在单次 commit 完成之后',
);

trace.length = 0;
deliveries.length = 0;
globalThis.__externalCommandGroups = {
  getById: async (id) => ({ group: { id, name: '群目标' }, members: [{ aiAssistantId: 'ai-external', name: '公开名字' }] }),
  updatePreviewInTransaction: async (_, id, messageId, preview) => trace.push({ kind: 'group-preview', id, messageId, preview }),
};
globalThis.__externalCommandRepository = {
  commitMessages: async () => { throw new Error('群消息不能走单聊提交'); },
  async commitMessagesInTransaction(_, input) {
    assert.equal(input.previewText, null);
    assert.equal(input.messages[0].sessionId, 'group-external');
    assert.equal(JSON.parse(input.messages[0].metadataJson).actorName, '公开名字');
    trace.push({ kind: 'group-commit' });
    return input.messages.map((message, index) => ({ ...message, id: 61 + index }));
  },
};
const groupResult = await appendExternalAssistantMessages({ sessionId: 'group-external', segments: ['后续消息'],
  aiId: 'ai-external', aiName: '公开名字', agentId: 'agent-external', triggerSource: 'together_listening' });
assert.equal(groupResult.messages[0].sessionId, 'group-external');
assert.equal(trace[1].kind, 'group-preview');
assert.equal(trace[1].id, 'group-external');
assert.equal(deliveries[0].sessionId, 'group-external');

console.log('Chat external assistant command 行为测试通过。');
