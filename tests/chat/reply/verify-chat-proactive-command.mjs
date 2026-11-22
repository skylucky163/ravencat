/** Chat-owned proactive reply 命令的最小真实行为测试。 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
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
const repository = { id: 'chat-message-repository' };
globalThis.__proactiveCommandRepository = repository;
globalThis.__proactiveCommandTrace = trace;

const runtimeModuleUrl = transpileToModuleUrl(`
export function getChatMessageRuntimeDependencies() {
  return { messages: globalThis.__proactiveCommandRepository };
}
`);
const eventsModuleUrl = transpileToModuleUrl(`
export function emitChatMessagesUpdated(sessionId) {
  globalThis.__proactiveCommandTrace.push({ kind: 'ui', sessionId });
}
export function emitChatTypingStatusChanged(sessionId, visible, correlationId) {
  globalThis.__proactiveCommandTrace.push({ kind: 'typing', sessionId, visible, correlationId });
}
`);
const commitModuleUrl = transpileToModuleUrl(`
export function createLegacySegmentedReplyPersistence() {
  globalThis.__proactiveCommandTrace.push({ kind: 'legacy-persistence' });
  return { persistsIntermediates: true };
}
`);
const processModuleUrl = transpileToModuleUrl(`
export async function processAIReply(sessionId, currentInput, aiConfig, userMessageId, repository, callbacks, runtimeContext, persistence) {
  globalThis.__proactiveCommandTrace.push({
    kind: 'process',
    sessionId,
    currentInput,
    aiConfig,
    userMessageId,
    repository,
    runtimeContext,
    persistence,
  });
  callbacks.notifyUI(sessionId);
  callbacks.onReplySegment({
    text: '第二段',
    messageId: 42,
    logicalMessageId: 'logical-1',
    segmentIndex: 1,
    segmentTotal: 2,
  });
  await callbacks.onAIMessageDelivered({
    message: {
      committedMessageId: 42,
      segmentIndex: 1,
      segmentTotal: 2,
      triggerSource: 'task_reminder',
      deliveryKind: 'proactive',
      notificationScope: 'raven-cat',
    },
    receipt: { status: 'handled_by_consumer', errorCategory: null },
  });
  callbacks.onReplySegment({
    text: '第一段',
    messageId: 41,
    logicalMessageId: 'logical-1',
    segmentIndex: 0,
    segmentTotal: 2,
  });
  await callbacks.onAIMessageDelivered({
    message: {
      committedMessageId: 41,
      segmentIndex: 0,
      segmentTotal: 2,
      triggerSource: 'task_reminder',
      deliveryKind: 'proactive',
      notificationScope: 'raven-cat',
    },
    receipt: { status: 'shown', errorCategory: null },
  });
  callbacks.onFinalReply({
    status: 'completed',
    sessionId,
    joinedText: '第一段\\n\\n第二段',
    text: '第一段\\n\\n第二段',
    previewText: '第一段',
    logicalMessageId: 'logical-1',
    firstSegmentMessageId: 41,
    lastSegmentMessageId: 42,
    segmentTotal: 2,
    segments: [
      { messageId: 41, segmentIndex: 0, text: '第一段' },
      { messageId: 42, segmentIndex: 1, text: '第二段' },
    ],
  });
}
`);

let source = read('src/features/chat/reply/application/RequestProactiveChatReply.ts');
source = source
  .replace(/from ['"]\.\.\/\.\.\/messages\/events\/ChatEvents['"]/, `from '${eventsModuleUrl}'`)
  .replace(/from ['"]\.\.\/\.\.\/messages\/application\/ChatMessageRuntime['"]/, `from '${runtimeModuleUrl}'`)
  .replace(/from ['"]\.\/AssistantTurnCommit['"]/, `from '${commitModuleUrl}'`)
  .replace(/from ['"]\.\/ProcessAIReply['"]/, `from '${processModuleUrl}'`);

const { requestProactiveChatReply } = await import(transpileToModuleUrl(source));
const result = await requestProactiveChatReply({
  sessionId: 'session-raven',
  currentInput: '主动联系输入',
  aiConfig: {
    id: 'ai-raven',
    agentId: 'agent-raven',
    name: 'Raven',
    model: 'model',
    apiKey: 'key',
    apiBaseUrl: 'https://example.invalid',
    enableTools: false,
  },
  triggerSource: 'raven_cat_contact',
  triggerReason: 'task_reminder',
  relatedEntityType: 'raven_cat_contact_attempt',
  relatedEntityId: 'attempt-1',
  capabilities: ['chat.reply', 'raven_cat.proactive_contact'],
  batchModelInput: [{ type: 'text', text: '屏幕上下文' }],
  promptBlocks: [{ kind: 'text', text: '主动联系规则' }],
  correlationId: 'raven-cat-proactive:attempt-1',
  notificationScope: 'raven-cat',
});

assert.deepEqual(result.message, '第一段\n\n第二段');
assert.equal(result.messageId, 41);
assert.deepEqual(result.messageIds, [41, 42]);
assert.deepEqual(result.segments.map(({ messageId }) => messageId), [41, 42]);
assert.deepEqual(
  result.deliveryReceipts.map(({ status }) => status),
  ['shown', 'handled_by_consumer'],
);
const processTrace = trace.find((entry) => entry.kind === 'process');
assert.equal(processTrace.repository, repository);
assert.equal(processTrace.userMessageId, 0);
assert.equal(processTrace.runtimeContext.triggerSource, 'raven_cat_contact');
assert.equal(processTrace.runtimeContext.triggerReason, 'task_reminder');
assert.equal(processTrace.runtimeContext.forceAppendUserText, true, '操作输入必须保留历史末条用户消息');
assert.equal(processTrace.runtimeContext.inputSource, 'application', '机器触发资料不能伪装用户新发言');
assert.equal(processTrace.runtimeContext.relatedEntityId, 'attempt-1');
// 窗口条数不再由主动消息命令固定，统一在执行链路按 AI 配置的单聊·主解析。
assert.equal(processTrace.runtimeContext.recentWindowLimit, undefined);
assert.equal(processTrace.runtimeContext.deliveryTiming, 'immediate');
assert.equal(processTrace.runtimeContext.deliveryTriggerSource, 'raven_cat_contact');
assert.equal(processTrace.runtimeContext.notificationScope, 'raven-cat');
assert.equal(processTrace.runtimeContext.deliveryKind, 'proactive');
assert.deepEqual(
  trace.map((entry) => entry.kind),
  ['typing', 'legacy-persistence', 'process', 'ui', 'typing'],
);

const noCommitProcessModuleUrl = transpileToModuleUrl(`
export async function processAIReply() {}
`);
const noCommitSource = source.replace(processModuleUrl, noCommitProcessModuleUrl);
const { requestProactiveChatReply: requestWithoutCommit } = await import(
  transpileToModuleUrl(noCommitSource)
);
const noCommitTraceStart = trace.length;
await assert.rejects(
  requestWithoutCommit({
    sessionId: 'session-raven',
    currentInput: '失败输入',
    aiConfig: {
      id: 'ai-raven',
      agentId: 'agent-raven',
      name: 'Raven',
      model: 'model',
      apiKey: 'key',
      apiBaseUrl: 'https://example.invalid',
    },
    triggerSource: 'raven_cat_contact',
    triggerReason: 'task_reminder',
  }),
  /主动消息已经生成但没有可审计的落库消息 ID/,
);
assert.deepEqual(
  trace.slice(noCommitTraceStart).map(({ kind }) => kind),
  ['typing', 'legacy-persistence', 'typing'],
  '无 committed segment 失败时 typing 必须由 finally 成对关闭',
);
assert.equal(trace[noCommitTraceStart].visible, true);
assert.equal(trace[noCommitTraceStart + 2].visible, false);

const deliveryTrace = [];
const deliveryEventsModuleUrl = transpileToModuleUrl(`
export function resolveAIMessageDeliveryKind() { return 'passive'; }
export async function emitAIMessageReceived(payload) {
  globalThis.__proactiveDeliveryTrace.push({ kind: 'emit', payload });
  return { status: 'shown', errorCategory: null };
}
`);
const deliveryMessageDomainModuleUrl = transpileToModuleUrl(`
export function buildSessionPreviewTextFromMessage(message) { return message.text; }
`);
globalThis.__proactiveDeliveryTrace = deliveryTrace;
const deliverySource = read('src/features/chat/reply/application/CommittedAssistantSegmentDelivery.ts')
  .replace(/from ['"]\.\.\/\.\.\/messages\/domain['"]/g, `from '${deliveryMessageDomainModuleUrl}'`)
  .replace(/from ['"]\.\.\/delivery\/AIMessageEvents['"]/g, `from '${deliveryEventsModuleUrl}'`);
const { deliverCommittedAssistantSegment } = await import(transpileToModuleUrl(deliverySource));
await deliverCommittedAssistantSegment({
  sessionId: 'session-raven',
  text: '主动段落',
  messageId: 88,
  logicalMessageId: 'logical-88',
  segmentIndex: 0,
  segmentTotal: 1,
  aiConfig: {
    id: 'ai-raven',
    agentId: 'agent-raven',
    name: 'Raven',
    model: 'model',
    apiKey: 'key',
    apiBaseUrl: 'https://example.invalid',
  },
  runtimeContext: {
    triggerSource: 'raven_cat_contact',
    triggerReason: 'task_reminder',
    deliveryTriggerSource: 'task_reminder',
    deliveryKind: 'proactive',
    notificationScope: 'raven-cat',
  },
  callbacks: {
    onAIMessageDelivered: ({ message, receipt }) => {
      deliveryTrace.push({ kind: 'receipt', message, receipt });
    },
  },
});
assert.deepEqual(deliveryTrace.map(({ kind }) => kind), ['emit', 'receipt']);
assert.equal(deliveryTrace[0].payload.committedMessageId, 88);
assert.equal(deliveryTrace[0].payload.deliveryKind, 'proactive');
assert.equal(deliveryTrace[0].payload.triggerSource, 'task_reminder');
assert.equal(deliveryTrace[0].payload.notificationScope, 'raven-cat');
assert.equal(deliveryTrace[1].receipt.status, 'shown');

console.log('Chat proactive command 行为测试通过。');
