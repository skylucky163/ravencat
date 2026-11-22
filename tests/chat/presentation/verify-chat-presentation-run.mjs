import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { repoRoot } from '../../helpers/repo-root.mjs';

/**
 * Run-level presentation 验证：
 * - A：连续的 reasoning / tool status 按 run 投影为稳定 ActionGroup；
 * - E：isAssistantOutputTail（用户可见输出尾部）与 isRunTail（run 展示尾部）
 *      是两个概念，assistant inline actions 只挂前者；
 * - D：VoiceMessageCard 前景必须使用 chat.userText / chat.aiText 语义 token，
 *      Paper Note 的 userText 不得退化为 brand.onPrimary（气泡背景）。
 */

const projectRoot = repoRoot;

function loadModule(relativePath, requireModule = () => ({})) {
  const sourcePath = path.join(projectRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: requireModule,
    console,
    Map,
    Set,
    Array,
    Object,
    String,
    Boolean,
    JSON,
    Error,
  });
  return module.exports;
}

const metadata = loadModule('src/features/chat/messages/domain/chatMessageMetadata.ts');

const presentationRun = loadModule(
  'src/features/chat/presentation/messages/components/chatPresentationRun.ts',
  (specifier) => {
    if (specifier === '@features/chat/messages/domain') {
      return metadata;
    }
    throw new Error(`未预期的 presentationRun 运行时依赖：${specifier}`);
  },
);

const actionGrouping = loadModule(
  'src/features/chat/presentation/messages/components/chatActionGrouping.ts',
  (specifier) => {
    if (specifier === './chatPresentationRun') {
      return presentationRun;
    }
    if (specifier === '@features/chat/messages/domain') {
      return metadata;
    }
    if (specifier === '@features/chat/messages/application/AgentTransientTimeline') {
      return { getAgentTimelineRenderKey: (message) => `db:${message.id}` };
    }
    throw new Error(`未预期的 actionGrouping 运行时依赖：${specifier}`);
  },
);

// 生命周期只提供状态，过程卡片不重复显示开始和结束说明。
{
  const activity = (id, senderType, phase) => ({ id, senderType, isMe: false, status: 'sent',
    turnRunId: 'wake-run', text: phase, metadataJson: JSON.stringify({
      type: 'agentActivity', source: 'chatAgentRun', phase, replyRunId: 'wake-run', triggerReason: 'self_wake',
      ...(phase === 'terminal' ? { terminalCode: 'COMPLETED' } : {}),
    }) });
  const records = [activity(1, 'system', 'started'), activity(2, 'reasoning', 'reasoning'),
    activity(3, 'system', 'assistant'), activity(4, 'system', 'terminal')];
  assert.equal(actionGrouping.filterActionStepsForPresentation(records, false).length, 0);
  const visible = actionGrouping.filterActionStepsForPresentation(records, true);
  assert.equal(visible.length, 4);
  const grouped = actionGrouping.segmentContiguousAgentActions(visible);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, 'action-group');
  assert.equal(grouped[0].children.length, 2);
  assert.equal(grouped[0].isRunning, false);
  assert.equal(actionGrouping.renderedItemContainsMessageId({ msg: grouped[0].children[0], actionGroup: grouped[0] }, 1, records[0]), true,
    '隐藏触发来源仍定位到同一 run 的真实过程');
  const voice = { id: 5, senderType: 'assistant', status: 'sent', isMe: false,
    turnRunId: 'wake-run', text: '真实语音消息' };
  const beforeTerminal = actionGrouping.segmentContiguousAgentActions([
    ...records.slice(0, 3), activity(6, 'system', 'responded'), voice,
  ]);
  const withVoice = actionGrouping.segmentContiguousAgentActions([...records.slice(0, 3), voice, records[3]]);
  assert.equal(withVoice.length, 2, '真实发言保留为独立气泡，结束说明不再制造第二张卡片');
  assert.equal(beforeTerminal[0].isRunning, true);
  assert.equal(withVoice[0].isRunning, false, '跨气泡的终态必须结束前一过程组的处理中状态');
  assert.equal(withVoice[0].activityLifecycle.terminalCode, 'COMPLETED');
  assert.equal(withVoice[0].activityLifecycle.responded, true, '状态仍读取真实响应证据');
  assert.equal(actionGrouping.areActionGroupsEquivalent(beforeTerminal[0], withVoice[0], (a, b) => a === b), false,
    '组外终态变化也必须触发前组重新渲染');
  const sharedSilent = actionGrouping.segmentContiguousAgentActions([records[0], activity(7, 'system', 'assistant')]);
  assert.equal(sharedSilent[0].isRunning, false, '已完成的静默选择不能永远显示正在处理');
  assert.equal(sharedSilent[0].activityLifecycle, null, '共享回合不制造独立的日程生命周期标题');
  const sharedBody = actionGrouping.segmentContiguousAgentActions([records[0], voice]);
  assert.equal(sharedBody.length, 1, '只有正文的日程不生成空过程卡片');
  assert.equal(actionGrouping.renderedItemContainsMessageId({ msg: voice, actionGroup: null }, 1, records[0]), true);
}

const messageListState = loadModule(
  'src/features/chat/presentation/messages/components/chatMessageListState.ts',
  (specifier) => {
    if (specifier === '@features/chat/messages/domain') {
      return metadata;
    }
    throw new Error(`未预期的 messageListState 运行时依赖：${specifier}`);
  },
);

const themeSources = {
  'default-light': 'src/shared/theme/themes/defaultLight.ts',
  'default-dark': 'src/shared/theme/themes/defaultDark.ts',
  'liquid-glass': 'src/shared/theme/themes/liquidGlass.ts',
  'moon-kimi': 'src/shared/theme/themes/moonKimi.ts',
  'paper-note': 'src/shared/theme/themes/paperNote.ts',
};
const themes = Object.fromEntries(
  Object.entries(themeSources).map(([id, file]) => {
    const exports = loadModule(file);
    // 主题文件均为 `export const xxxTheme = {...}` 单命名导出。
    const theme = exports.default ?? Object.values(exports)[0];
    if (!theme || !theme.colors) {
      throw new Error(`主题文件未导出 theme 对象：${file}`);
    }
    return [id, theme];
  }),
);

function message(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    sessionId: 's1',
    text: '消息',
    isMe: false,
    isRead: true,
    senderType: 'assistant',
    time: '12:00',
    createdAt: '2026-09-09T12:00:00.000Z',
    showTimeSeparatorBefore: false,
    status: 'sent',
    metadataJson: null,
    ...overrides,
  };
}

function reasoning(id, runKeyOverrides = {}, text = `思考 ${id}`) {
  return message({
    id,
    senderType: 'reasoning',
    text,
    turnRunId: 'run-1',
    ...runKeyOverrides,
  });
}

// ---------------------------------------------------------------------------
// run identity 优先级
// ---------------------------------------------------------------------------

// vm 上下文里创建的对象与宿主原型不同，deepEqual 会误判，改为逐字段断言。
function assertIdentity(actual, expectedKey, expectedSource, hint) {
  assert.equal(actual.key, expectedKey, hint);
  assert.equal(actual.source, expectedSource, hint);
}

assertIdentity(
  presentationRun.resolvePresentationRunIdentity(message({ turnRunId: 'run-1' })),
  'run:run-1',
  'transient-turn-run-id',
);
assertIdentity(
  presentationRun.resolvePresentationRunIdentity(message({
    metadataJson: JSON.stringify({ replyRunId: 'rr-1', replyStepId: 'rs-1' }),
    logicalMessageId: 'logical-1',
  })),
  'run:rr-1',
  'metadata-reply-run-id',
  'metadata.replyRunId 优先于 replyStepId / logicalMessageId',
);
assertIdentity(
  presentationRun.resolvePresentationRunIdentity(message({
    metadataJson: JSON.stringify({ replyStepId: 'rs-1' }),
    logicalMessageId: 'logical-1',
  })),
  'step:rs-1',
  'reply-step-id',
);
assertIdentity(
  presentationRun.resolvePresentationRunIdentity(message({ logicalMessageId: 'logical-1' })),
  'logical:logical-1',
  'logical-message-id',
);
assertIdentity(
  presentationRun.resolvePresentationRunIdentity(message()),
  null,
  null,
  '无任何 run identity 时返回 null，不得猜测',
);

// ---------------------------------------------------------------------------
// A：连续 Agent 行动步骤分段
// ---------------------------------------------------------------------------

/** 真实工具状态以带完整 metadata 的 system 消息进入 canonical timeline。 */
function toolStatus(id, runKeyOverrides = {}, text = '正在执行工具', toolStatusState = 'completed') {
  return message({
    id,
    senderType: 'system',
    text,
    turnRunId: 'run-1',
    metadataJson: JSON.stringify({
      type: 'toolStatus',
      status: toolStatusState,
      toolNames: ['search'],
      displayNames: ['搜索'],
      displayText: text,
      source: 'chatToolFlow',
    }),
    ...runKeyOverrides,
  });
}

function ordinarySystem(id, runKeyOverrides = {}, text = '普通系统消息') {
  return message({ id, senderType: 'system', text, turnRunId: 'run-1', ...runKeyOverrides });
}

function project(messages) {
  return actionGrouping.segmentContiguousAgentActions(messages);
}

function projectWithVisibility(messages, showActionSteps) {
  const visibleMessages = actionGrouping.filterActionStepsForPresentation(
    messages,
    showActionSteps,
  );
  return project(visibleMessages);
}

function actionGroups(items) {
  return items.filter((item) => item.kind === 'action-group');
}

function assertGroup(item, expectedIds, hint) {
  assert.equal(item.kind, 'action-group', hint);
  assert.deepEqual(Array.from(item.children, (child) => child.id), expectedIds, hint);
}

// Case A：R1 T1 R2 A1 → ActionGroup[R1,T1,R2], A1。
const caseA = project([
  reasoning(1, {}, 'R1'),
  toolStatus(2, {}, 'T1'),
  reasoning(3, {}, 'R2'),
  message({ id: 4, senderType: 'assistant', turnRunId: 'run-1', text: 'A1' }),
]);
assert.equal(caseA.length, 2);
assertGroup(caseA[0], [1, 2, 3], 'reasoning 与 tool status 应保持时间线顺序进入同一组');
assert.equal(caseA[1].kind, 'message');
assert.equal(caseA[1].message.id, 4);

// grouping 是可见 timeline 的结构语义，不随视觉 surface 改变。
for (const themeId of ['default-light', 'moon-kimi', 'paper-note']) {
  const projected = projectWithVisibility([
    reasoning(1, {}, 'R1'),
    toolStatus(2, {}, 'T1'),
    reasoning(3, {}, 'R2'),
    message({ id: 4, senderType: 'assistant', turnRunId: 'run-1', text: 'A1' }),
  ], true);
  assert.equal(projected.length, 2, `${themeId} 应得到相同的 ActionGroup 分段`);
  assertGroup(projected[0], [1, 2, 3], `${themeId} 的视觉 surface 不得改变 grouping`);
  assert.equal(projected[1].message.id, 4);
}

// 关闭行动步骤同时隐藏思考与工具状态，保留相同文字的正文及业务系统消息。
const hiddenActionProjection = projectWithVisibility([
  reasoning(1, {}, 'R1'),
  toolStatus(2, {}, 'T1'),
  message({ id: 3, senderType: 'assistant', turnRunId: 'run-1', text: 'R1' }),
  ordinarySystem(4),
], false);
assert.deepEqual(Array.from(hiddenActionProjection, item => item.message.id), [3, 4]);

// Case B：assistant 切断同一 run，后续过程必须新开组。
const caseB = project([
  reasoning(1, {}, 'R1'),
  toolStatus(2, {}, 'T1'),
  message({ id: 3, senderType: 'assistant', turnRunId: 'run-1', text: 'A1' }),
  reasoning(4, {}, 'R2'),
  toolStatus(5, {}, 'T2'),
  message({ id: 6, senderType: 'assistant', turnRunId: 'run-1', text: 'A2' }),
]);
assert.equal(caseB.length, 4);
assertGroup(caseB[0], [1, 2]);
assert.equal(caseB[1].message.id, 3);
assertGroup(caseB[2], [4, 5]);
assert.equal(caseB[3].message.id, 6);

// Case C：children 保留原始事件边界与顺序，不拼接文本。
const caseC = project([
  reasoning(1, {}, 'R1'),
  toolStatus(2, {}, 'T1'),
  reasoning(3, {}, 'R2'),
]);
assert.equal(caseC.length, 1);
assertGroup(caseC[0], [1, 2, 3]);
assert.equal(caseC[0].children[0].text, 'R1');
assert.equal(caseC[0].children[1].text, 'T1');
assert.equal(caseC[0].children[2].text, 'R2');

// Case D：普通 system 不是过程项，必须切断。
const caseD = project([
  reasoning(1, {}, 'R1'),
  ordinarySystem(2),
  reasoning(3, {}, 'R2'),
]);
assert.equal(caseD.length, 3);
assertGroup(caseD[0], [1]);
assert.equal(caseD[1].kind, 'message');
assert.equal(caseD[1].message.id, 2);
assertGroup(caseD[2], [3]);

// Case E：不同 run 即使紧邻，也必须产生两个组。
const caseE = project([
  reasoning(1, { turnRunId: 'run-1' }, 'R1'),
  reasoning(2, { turnRunId: 'run-2' }, 'R2'),
]);
assert.equal(caseE.length, 2);
assertGroup(caseE[0], [1]);
assertGroup(caseE[1], [2]);

// Case F：同 run 被 assistant 分成两段时，两个组的 key 不同。
const caseF = project([
  reasoning(1, {}, 'R1'),
  message({ id: 2, senderType: 'assistant', turnRunId: 'run-1', text: 'A1' }),
  reasoning(3, {}, 'R2'),
]);
const caseFGroups = actionGroups(caseF);
assert.equal(caseFGroups.length, 2);
assert.notEqual(caseFGroups[0].key, caseFGroups[1].key);

// Case G：同一连续组 streaming 追加 child 时，以首 child 为锚的 key 始终稳定。
const streamingR = project([reasoning(1, { status: 'streaming' }, 'R1')]);
const streamingRT = project([
  reasoning(1, { status: 'streaming' }, 'R1'),
  toolStatus(2, {}, 'T1', 'running'),
]);
const streamingRTR = project([
  reasoning(1, { status: 'streaming' }, 'R1'),
  toolStatus(2, {}, 'T1', 'running'),
  reasoning(3, { status: 'streaming' }, 'R2'),
]);
assert.equal(streamingR[0].key, streamingRT[0].key);
assert.equal(streamingRT[0].key, streamingRTR[0].key);
assert.equal(streamingRTR[0].key, 'presentation_action_group:run:run-1:db:1');
assert.equal(streamingRTR[0].isRunning, true);

// ActionGroup 任意 child 都应命中承载它的 rendered item。
const renderedStreamingGroup = {
  msg: streamingRTR[0].children[0],
  actionGroup: streamingRTR[0],
};
assert.equal(actionGrouping.renderedItemContainsMessageId(renderedStreamingGroup, 2), true);
assert.equal(actionGrouping.renderedItemContainsMessageId(renderedStreamingGroup, 3), true);
assert.equal(actionGrouping.renderedItemContainsMessageId(renderedStreamingGroup, 99), false);

// 下一项的时间分隔必须从前一个 ActionGroup 的最后一条真实消息开始计算。
const timedGroup = project([
  reasoning(11, { createdAt: '2026-09-09T10:00:00.000Z' }, 'R1'),
  toolStatus(12, { createdAt: '2026-09-09T10:12:00.000Z' }, 'T1'),
])[0];
const followingAssistant = message({
  id: 13,
  createdAt: '2026-09-09T10:13:00.000Z',
  senderType: 'assistant',
  turnRunId: 'run-1',
  text: 'A1',
});
const previousTimelineMessage = actionGrouping.getLastPresentationTimelineMessage(timedGroup);
assert.equal(previousTimelineMessage.id, 12);
assert.equal(
  messageListState.shouldShowTimeSeparator(followingAssistant, previousTimelineMessage),
  false,
  '10:12 → 10:13 不应产生时间分隔',
);
assert.equal(
  messageListState.shouldShowTimeSeparator(followingAssistant, timedGroup.children[0]),
  true,
  '若误用 10:00 的首 child 会错误产生时间分隔',
);

// Case H：assistant 插入后，后续 reasoning 使用自己的锚点创建新 key。
const beforeAssistant = project([reasoning(1, {}, 'R1'), toolStatus(2, {}, 'T1')]);
const afterAssistant = project([
  reasoning(1, {}, 'R1'),
  toolStatus(2, {}, 'T1'),
  message({ id: 3, senderType: 'assistant', turnRunId: 'run-1', text: 'A1' }),
  reasoning(4, {}, 'R2'),
]);
assert.equal(beforeAssistant[0].key, afterAssistant[0].key);
assert.notEqual(afterAssistant[0].key, afterAssistant[2].key);

// Case I：只有通过真实 tool metadata 判定的 system 才是过程项。
assert.equal(actionGrouping.isActionProcessMessage(toolStatus(1)), true);
assert.equal(actionGrouping.isActionProcessMessage(ordinarySystem(2)), false);

// persisted replyRunId 路径沿用同一规则。
const persisted = project([
  reasoning(1, {
    turnRunId: null,
    metadataJson: JSON.stringify({ replyRunId: 'rr-9', replyStepId: 's1' }),
  }, 'R1'),
  toolStatus(2, {
    turnRunId: null,
    metadataJson: JSON.stringify({
      type: 'toolStatus',
      status: 'completed',
      toolNames: ['search'],
      displayNames: ['搜索'],
      displayText: 'T1',
      source: 'chatToolFlow',
      replyRunId: 'rr-9',
    }),
  }, 'T1'),
  reasoning(3, {
    turnRunId: null,
    metadataJson: JSON.stringify({ replyRunId: 'rr-9', replyStepId: 's2' }),
  }, 'R2'),
]);
assert.equal(persisted.length, 1);
assertGroup(persisted[0], [1, 2, 3]);
assert.equal(persisted[0].runKey, 'run:rr-9');

// 无可靠 run identity 的 legacy 过程消息保持原样，不按邻接猜测。
const legacy = project([
  reasoning(1, { turnRunId: null, logicalMessageId: null }),
  reasoning(2, { turnRunId: null, logicalMessageId: null }),
]);
assert.equal(legacy.length, 2);
assert.equal(legacy[0].kind, 'message');
assert.equal(legacy[1].kind, 'message');

// 缺少运行编号的真实工具记录也由行动步骤承载，但不能猜测并入两侧或互相合并。
for (const status of ['running', 'completed', 'failed']) {
  const isolatedTools = project([
    reasoning(1),
    toolStatus(2, { turnRunId: null }, '发送表情包', status),
    toolStatus(3, { turnRunId: null }, '其他工具', status),
    reasoning(4),
  ]);
  assert.equal(isolatedTools.length, 4);
  assertGroup(isolatedTools[1], [2]);
  assertGroup(isolatedTools[2], [3]);
  assert.equal(isolatedTools[1].runKey, null, '独立过程卡不伪造运行归属');
  assert.equal(isolatedTools[1].isRunning, status === 'running');
  assert.notEqual(isolatedTools[1].key, isolatedTools[2].key);
}

const failedThenReasoning = project([
  toolStatus(1, {}, '调用失败：发送表情包', 'failed'),
  reasoning(2),
]);
assert.equal(failedThenReasoning.length, 1);
assertGroup(failedThenReasoning[0], [1, 2], '有运行身份的失败工具与后续思考仍按时间线归入同一组');


// ---------------------------------------------------------------------------
// E：run tail 归属
// ---------------------------------------------------------------------------

const {
  computePresentationRunTailFlags,
  computeRunTailFlagsForTimeline,
} = presentationRun;

assert.equal(computePresentationRunTailFlags([]).size, 0);

function assertTailFlags(actual, expectedOutputTail, expectedRunTail, hint) {
  assert.equal(actual.isAssistantOutputTail, expectedOutputTail, hint);
  assert.equal(actual.isRunTail, expectedRunTail, hint);
}

// 同 run：reasoning → text → voice，只有 voice 是用户可见输出尾部。
const runWithVoice = [
  reasoning(1),
  message({ id: 2, senderType: 'assistant', text: '回答', turnRunId: 'run-1' }),
  message({ id: 3, senderType: 'assistant', text: '', turnRunId: 'run-1', metadataJson: JSON.stringify({ type: 'voice' }) }),
];
const voiceFlags = computePresentationRunTailFlags(runWithVoice);
assertTailFlags(voiceFlags.get(runWithVoice[0]), false, false);
assertTailFlags(voiceFlags.get(runWithVoice[1]), false, false);
assertTailFlags(
  voiceFlags.get(runWithVoice[2]),
  true,
  true,
  '最后一个用户可见 assistant 输出（含 voice）必须同时是 run tail',
);

// 工具状态尾随不抢 footer：assistant 仍是 output tail，但不是 run tail。
const runWithToolTail = [
  reasoning(1),
  message({ id: 2, senderType: 'assistant', text: '回答', turnRunId: 'run-1' }),
  message({ id: 3, senderType: 'system', text: '工具运行中', turnRunId: 'run-1' }),
];
const toolFlags = computePresentationRunTailFlags(runWithToolTail);
assertTailFlags(
  toolFlags.get(runWithToolTail[1]),
  true,
  false,
  '尾随工具状态不得抢走 assistant output tail 归属',
);
assertTailFlags(toolFlags.get(runWithToolTail[2]), false, true);

// run 内只有 reasoning/tool（无可见输出）→ 没有任何 output tail。
const noOutputFlags = computePresentationRunTailFlags(runWithToolTail.slice(0, 1).concat([runWithToolTail[2]]));
assert.equal(noOutputFlags.get(runWithToolTail[0]).isAssistantOutputTail, false);
assert.equal(noOutputFlags.get(runWithToolTail[2]).isAssistantOutputTail, false);
assert.equal(noOutputFlags.get(runWithToolTail[2]).isRunTail, true);

// 相邻 run 各自拥有自己的 tail。
const adjacentRuns = [
  message({ id: 0, isMe: true, senderType: 'user' }),
  message({ id: 1, senderType: 'assistant', turnRunId: 'run-1', text: '回答一' }),
  message({ id: 2, isMe: true, senderType: 'user' }),
  message({ id: 3, senderType: 'assistant', turnRunId: 'run-2', text: '回答二' }),
];
const adjacentFlags = computeRunTailFlagsForTimeline(adjacentRuns);
assertTailFlags(adjacentFlags.get(adjacentRuns[1]), true, true);
assertTailFlags(adjacentFlags.get(adjacentRuns[3]), true, true);

// 同 runKey 被用户消息打断 → 连续段各自计算 tail。
const splitRun = [
  message({ id: 1, senderType: 'assistant', turnRunId: 'run-1', text: '第一段' }),
  message({ id: 2, isMe: true, senderType: 'user' }),
  message({ id: 3, senderType: 'assistant', turnRunId: 'run-1', text: '第二段' }),
];
const splitFlags = computeRunTailFlagsForTimeline(splitRun);
assertTailFlags(splitFlags.get(splitRun[0]), true, true);
assertTailFlags(splitFlags.get(splitRun[2]), true, true);

// 用户消息永远不是 assistant output。
const userOnlyFlags = computeRunTailFlagsForTimeline([message({ isMe: true, senderType: 'user' })]);
assert.equal(userOnlyFlags.size, 0, '无 run key 的消息不参与 run tail 计算');

// 群聊：同 run 内 assistant 输出后的 reasoning 不得抢 output tail。
const groupRun = [
  message({ id: 1, senderType: 'assistant', turnRunId: 'run-1', text: 'A 的回答' }),
  reasoning(2),
];
const groupFlags = computeRunTailFlagsForTimeline(groupRun);
assert.equal(groupFlags.get(groupRun[0]).isAssistantOutputTail, true);
assert.equal(groupFlags.get(groupRun[1]).isAssistantOutputTail, false);

// 时间线级：ActionGroup 只包装展示，tail 始终在 canonical presentation timeline 上计算。
const timeline = [
  message({ id: 0, isMe: true, senderType: 'user' }),
  reasoning(1),
  reasoning(2),
  message({ id: 3, senderType: 'assistant', turnRunId: 'run-1', text: '回答' }),
  message({ id: 4, senderType: 'assistant', turnRunId: 'run-1', text: '', metadataJson: JSON.stringify({ type: 'sticker' }) }),
];
const timelineProjection = project(timeline);
assert.equal(timelineProjection.length, 4, '相邻 reasoning 只在展示投影中包装为一个 ActionGroup');
const timelineFlags = computeRunTailFlagsForTimeline(timeline);
assert.equal(timelineFlags.get(timeline[3]).isAssistantOutputTail, false);
assert.equal(timelineFlags.get(timeline[4]).isAssistantOutputTail, true, 'sticker 输出也是用户可见 assistant 输出');

// ---------------------------------------------------------------------------
// D：VoiceMessageCard 前景语义 token
// ---------------------------------------------------------------------------

for (const [themeId, theme] of Object.entries(themes)) {
  assert.equal(typeof theme.colors.chat.userText, 'string', `${themeId} 必须提供 chat.userText`);
  assert.ok(theme.colors.chat.userText.length > 0);
  assert.equal(typeof theme.colors.chat.aiText, 'string', `${themeId} 必须提供 chat.aiText`);
  assert.ok(theme.colors.chat.aiText.length > 0);
}

// Paper Note：user 气泡前景不得与气泡背景同色（brand.onPrimary 语义前提不成立）。
const paperNote = themes['paper-note'];
assert.notEqual(
  paperNote.colors.chat.userText,
  paperNote.colors.background.app,
  'Paper Note 的 chat.userText 不得退化为背景同色',
);
assert.notEqual(
  paperNote.colors.chat.userText,
  paperNote.colors.brand?.primary,
  'Paper Note 的 chat.userText 不得等于 brand.primary（user 气泡并非品牌色填充）',
);

const voiceCardSource = fs.readFileSync(
  path.join(projectRoot, 'src/features/chat/presentation/messages/MessageBubble/VoiceMessageCard.tsx'),
  'utf8',
);
const codeOnly = voiceCardSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');
assert.ok(
  codeOnly.includes('theme.colors.chat.userText'),
  'VoiceMessageCard 用户侧前景必须来自 chat.userText 语义 token',
);
assert.ok(
  codeOnly.includes('theme.colors.chat.aiText'),
  'VoiceMessageCard AI 侧前景必须来自 chat.aiText 语义 token',
);
assert.ok(
  !codeOnly.includes('onPrimary'),
  'VoiceMessageCard 不得再把 brand.onPrimary 当作气泡内前景色',
);

await import('./verify-chat-paper-note.mjs');
console.log('Chat presentation run verification passed.');
