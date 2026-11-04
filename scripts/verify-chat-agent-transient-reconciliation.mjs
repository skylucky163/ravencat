/**
 * Agent transient timeline 的行为验证：
 * - execution sink 写入后，即使没有 presentation subscriber，active snapshot 仍存在；
 * - T3 committed rows 通过 exact clientMessageId 替换，不按正文猜测；
 * - 单个 transient assistant 替换为多个 committed segments 时不重复、不闪烁；
 * - supersede 清理后不会留下幽灵条目。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

const projectRoot = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(
  projectRoot,
  'src/features/chat/messages/application/AgentTransientTimeline.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const identitySourcePath = path.join(
  projectRoot,
  'src/features/chat/messages/domain/AgentTimelineIdentity.ts',
);
const identityTranspiled = ts.transpileModule(fs.readFileSync(identitySourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const identityModule = { exports: {} };
vm.runInNewContext(identityTranspiled, {
  module: identityModule,
  exports: identityModule.exports,
  encodeURIComponent,
  decodeURIComponent,
  Number,
});
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(transpiled, {
  module,
  exports: module.exports,
  require: (specifier) => specifier === '../domain/AgentTimelineIdentity'
    ? identityModule.exports
    : require(specifier),
  console,
  Map,
  Set,
  Array,
  Number,
  String,
  JSON,
  Math,
  encodeURIComponent,
  decodeURIComponent,
  Object,
  Error,
  TypeError,
  Reflect,
});
const timeline = module.exports;
const pendingUser = { id: 1793441468716, isMe: true, clientMessageId: 'user-submission:stable' };
assert.equal(timeline.getAgentTimelineRenderKey(pendingUser),
  timeline.getAgentTimelineRenderKey({ ...pendingUser, id: 10349 }), '用户消息落库前后复用同一列表身份');
assert.notEqual(timeline.getAgentTimelineRenderKey(pendingUser),
  timeline.getAgentTimelineRenderKey({ ...pendingUser, clientMessageId: 'user-submission:next' }), '同文新消息不能复用上一条身份');

const sessionId = 'session_case_5';
const runId = 'run_case_5';
const clientId = (sequence, segment = 0) => (
  `agent-timeline:${encodeURIComponent(runId)}:${sequence}:${segment}`
);

function message(sequence, kind, text, segment = 0) {
  return {
    id: 0,
    sessionId,
    text,
    isMe: false,
    isRead: true,
    senderType: kind === 'tool' ? 'system' : kind,
    clientMessageId: clientId(sequence, segment),
    time: '12:00',
    createdAt: `2026-08-24T12:00:0${sequence}.000Z`,
    showTimeSeparatorBefore: false,
    updatedAt: `2026-08-24T12:00:0${sequence}.000Z`,
    status: 'streaming',
    tokensUsed: 0,
    promptTokens: 0,
    completionTokens: 0,
    metadataJson: null,
  };
}

const sink = timeline.createAgentTransientTimelineSink({ sessionId, agentId: 'agent-1' });
sink.onChanged({
  runId,
  items: [
    {
      runId, stepIndex: 1, sequence: 1, kind: 'reasoning', status: 'streaming',
      text: 'same text', clientMessageId: clientId(1),
      createdAt: '2026-08-24T12:00:01.000Z', time: '12:00',
    },
    {
      runId, stepIndex: 1, sequence: 2, kind: 'assistant', status: 'streaming',
      text: 'same text', clientMessageId: clientId(2),
      createdAt: '2026-08-24T12:00:02.000Z', time: '12:00',
    },
  ],
});

// 没有任何 UI subscriber 时，execution sink 写入的 active snapshot 仍可读取。
const transient = timeline.snapshotAgentTransientTimelineWithReplacements(sessionId);
assert.equal(transient.length, 2);
assert.equal(
  timeline.isAgentTransientTimelineMessage(transient[1]),
  true,
  'streaming assistant 必须保留 transient 标记，供持久 ID 操作门控',
);
const transientKeys = transient.map(timeline.getAgentTimelineRenderKey);

const committed = [
  {
    ...message(1, 'reasoning', 'same text'),
    id: 101,
    turnRunId: runId,
    turnItemIndex: 1,
    status: 'sent',
  },
  {
    ...message(2, 'assistant', 'same text', 0),
    id: 102,
    turnRunId: runId,
    turnItemIndex: 2,
    status: 'sent',
  },
  {
    ...message(2, 'assistant', 'same text', 1),
    id: 103,
    turnRunId: runId,
    turnItemIndex: 3,
    status: 'sent',
  },
];

timeline.reconcileAgentTransientTimelineCommit(sessionId, runId, committed);
const replaced = timeline.snapshotAgentTransientTimelineWithReplacements(sessionId);
assert.deepEqual(replaced.map((item) => item.id), [101, 102, 103]);
assert.deepEqual(replaced.map((item) => item.text), ['same text', 'same text', 'same text']);
assert.deepEqual(
  replaced.slice(0, 2).map(timeline.getAgentTimelineRenderKey),
  transientKeys,
  'transient → committed replacement 的既有 UI key 与视觉位置必须保持不变',
);

timeline.acknowledgeAgentTransientTimelineCommitted(sessionId, committed);
assert.deepEqual(timeline.snapshotAgentTransientTimelineWithReplacements(sessionId), []);

// 竞态反序：DB reload 先 acknowledge，T3 返回后才安装 replacement；
// store revision 驱动的下一轮 acknowledge 必须仍能把迟到 overlay 收净。
const reverseSessionId = 'session_reverse_ack';
const reverseRunId = 'run_reverse_ack';
const reverseClientId = `agent-timeline:${reverseRunId}:1:0`;
const reverseSink = timeline.createAgentTransientTimelineSink({
  sessionId: reverseSessionId,
  agentId: 'agent-1',
});
reverseSink.onChanged({
  runId: reverseRunId,
  items: [{
    runId: reverseRunId,
    stepIndex: 1,
    sequence: 1,
    kind: 'assistant',
    status: 'streaming',
    text: 'race reply',
    clientMessageId: reverseClientId,
    createdAt: '2026-08-24T12:01:00.000Z',
    time: '12:01',
  }],
});
const reverseCommitted = [{
  ...message(1, 'assistant', 'race reply'),
  id: 201,
  sessionId: reverseSessionId,
  clientMessageId: reverseClientId,
  turnRunId: reverseRunId,
  turnItemIndex: 1,
  status: 'sent',
}];
timeline.acknowledgeAgentTransientTimelineCommitted(reverseSessionId, reverseCommitted);
assert.deepEqual(timeline.snapshotAgentTransientTimelineWithReplacements(reverseSessionId), []);
timeline.reconcileAgentTransientTimelineCommit(reverseSessionId, reverseRunId, reverseCommitted);
assert.equal(
  timeline.snapshotAgentTransientTimelineWithReplacements(reverseSessionId).length,
  1,
  '迟到 replacement 会产生新的 store revision',
);
timeline.acknowledgeAgentTransientTimelineCommitted(reverseSessionId, reverseCommitted);
assert.deepEqual(
  timeline.snapshotAgentTransientTimelineWithReplacements(reverseSessionId),
  [],
  '反序竞态下 revision 驱动的重复 acknowledge 必须清除迟到 replacement',
);

// supersede 清理覆盖 execution sink 的真实接缝，之后不会再读出幽灵 item。
const supersededSink = timeline.createAgentTransientTimelineSink({ sessionId, agentId: 'agent-1' });
supersededSink.onChanged({
  runId: 'old_run',
  items: [{
    runId: 'old_run',
    stepIndex: 1,
    sequence: 1,
    kind: 'reasoning',
    status: 'streaming',
    text: 'old text',
    clientMessageId: 'agent-timeline:old_run:1:0',
    createdAt: '2026-08-24T12:00:01.000Z',
    time: '12:00',
  }],
});
supersededSink.onCleared({ runId: 'old_run', reason: 'superseded' });
assert.equal(
  timeline.snapshotAgentTransientTimelineWithReplacements(sessionId)
    .some((item) => item.text === 'old text'),
  false,
);

console.log('chat agent transient reconciliation verification passed');
