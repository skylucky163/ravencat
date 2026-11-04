import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { arrival } from './chat-message-arrival-fixture.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const frames = new Map();
let nextFrame = 0;

function loadModule(relativePath, requireModule = () => ({})) {
  const sourcePath = path.join(projectRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
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
    Number,
    Date,
    Math,
    JSON,
    Error,
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  return module.exports;
}

const metadata = loadModule('src/features/chat/messages/domain/chatMessageMetadata.ts');
const state = loadModule(
  'src/features/chat/presentation/messages/components/chatMessageListState.ts',
  (specifier) => {
    if (specifier === '@features/chat/messages/domain') {
      return metadata;
    }
    throw new Error(`未预期的运行时依赖：${specifier}`);
  },
);
const presentation = loadModule(
  'src/features/chat/presentation/messages/components/chatMessagePresentation.ts',
  (specifier) => {
    if (specifier === '@features/chat/messages/domain') {
      return metadata;
    }
    throw new Error(`未预期的 chatMessagePresentation 运行时依赖：${specifier}`);
  },
);
const themes = loadModule('src/shared/theme/themeVariants.ts');
const agentIdentity = loadModule('src/features/chat/messages/domain/AgentTimelineIdentity.ts');
const timelineOrdering = loadModule('src/features/chat/messages/domain/ChatTimelineOrdering.ts');
const transientStore = loadModule(
  'src/features/chat/messages/application/AgentTransientTimeline.ts',
  (specifier) => {
    if (specifier === '../domain/AgentTimelineIdentity') {
      return agentIdentity;
    }
    throw new Error(`未预期的 AgentTransientTimeline 运行时依赖：${specifier}`);
  },
);
const transientTimeline = loadModule(
  'src/features/chat/presentation/messages/components/useAgentTransientTimeline.ts',
  (specifier) => {
    if (specifier === 'react') {
      return React;
    }
    if (specifier === '../../../reply/delivery/AssistantMessageArrival') return arrival;
    if (specifier === '@features/chat/messages/domain/ChatTimelineOrdering') {
      return timelineOrdering;
    }
    if (specifier === '@features/chat/messages/application/AgentTransientTimeline') {
      return transientStore;
    }
    throw new Error(`未预期的 useAgentTransientTimeline 运行时依赖：${specifier}`);
  },
);
const presentationRun = loadModule(
  'src/features/chat/presentation/messages/components/chatPresentationRun.ts',
  (specifier) => {
    if (specifier === '@features/chat/messages/domain') {
      return metadata;
    }
    throw new Error(`未预期的 presentation run 运行时依赖：${specifier}`);
  },
);
const actionGrouping = loadModule(
  'src/features/chat/presentation/messages/components/chatActionGrouping.ts',
  (specifier) => {
    if (specifier === '@features/chat/messages/domain') {
      return metadata;
    }
    if (specifier === '@features/chat/messages/application/AgentTransientTimeline') {
      return transientStore;
    }
    if (specifier === './chatPresentationRun') {
      return presentationRun;
    }
    throw new Error(`未预期的 action grouping 运行时依赖：${specifier}`);
  },
);
const renderUtils = loadModule(
  'src/features/chat/presentation/messages/components/chatMessageRenderUtils.ts',
  (specifier) => {
    if (specifier === './chatActionGrouping') return actionGrouping;
    throw new Error(`未预期的 render utils 运行时依赖：${specifier}`);
  },
);

for (const direction of ['incoming', 'outgoing']) {
  const sender = metadata.getCallStatusMessageSender({ direction, callStatus: 'callSystemError' });
  const rendered = renderUtils.buildMessageBubbleRenderState({
    ...sender, text: '【系统错误：系统通知发送失败】', attachments: [], isToolStatusMessage: false,
  });
  assert.equal(rendered.variant, 'system', '通话系统故障应走灰色系统提示，不能进入用户或 AI 气泡');
  assert.equal(rendered.isSystem, true);
}

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

function classify(previousKeys, messages, keys) {
  return state.classifyTailMutation({ previous: { keys: previousKeys }, messages, keys });
}

// 记录中的媒体属于记录条目，不能让整张记录卡变成无气泡的独立附件。
{
  for (const type of ['image', 'file']) {
    const params = {
      text: '', isMe: true, senderType: 'user',
      attachments: [{ id: 'attachment-a', type }], isToolStatusMessage: false,
    };
    assert.equal(renderUtils.buildMessageBubbleRenderState(params).isStandaloneAttachmentMessage, true);
    const shared = renderUtils.buildMessageBubbleRenderState({ ...params, isSharedRecord: true });
    assert.equal(shared.isStandaloneAttachmentMessage, false, '单个媒体的分享记录保留完整气泡');
    assert.equal(shared.variant, 'me');
  }
  assert.equal(renderUtils.buildMessageBubbleRenderState({
    text: '**附言**', isMe: true, senderType: 'user', attachments: [],
    isToolStatusMessage: false, isSharedRecord: true,
  }).shouldUseMarkdown, false, '旧记录的附言不改变记录卡布局');
}

// 回收资格由视图类别决定，不能随消息身份增长，也不能混用文本与媒体、行动步骤的容器。
{
  function item(overrides = {}) {
    const msg = overrides.msg ?? message();
    const attachments = overrides.attachments ?? [];
    return {
      msg, attachments, sticker: null, voice: null, actionGroup: null,
      processCard: null, togetherListeningCard: null, showTimeSeparator: false,
      bubbleRenderState: renderUtils.buildMessageBubbleRenderState({
        text: msg.text, isMe: msg.isMe, senderType: msg.senderType,
        attachments, isToolStatusMessage: false,
      }),
      ...overrides,
    };
  }
  const type = renderUtils.getMessageListItemType;
  const textItem = item();
  assert.equal(type(textItem), type(item({ msg: message({ id: 999, text: '另一条消息' }) })), '同类消息可复用');
  const mediaItems = [
    item({ attachments: [{ id: 'image-a', type: 'image' }] }),
    item({ sticker: { mediaAssetId: 'sticker-a' } }),
    item({ voice: { mediaAssetId: 'voice-a' } }),
    item({ msg: message({ text: '**Markdown**' }) }),
  ];
  assert.equal(new Set([textItem, ...mediaItems].map(type)).size, 5, '不同正文结构独立回收');
  assert.notEqual(type(textItem), type(item({ msg: userMessage() })), '两侧气泡不混用');
  assert.notEqual(type(textItem), type(item({ showTimeSeparator: true })), '日期行保留独立结构');
  assert.notEqual(
    type(item({ actionGroup: { key: 'group-a' } })),
    type(item({ processCard: { title: '思考' } })),
    '行动步骤与独立思考卡不混用',
  );
  const historyTypes = Array.from({ length: 500 }, (_, index) => type(item({ msg: message({ id: index }) })));
  assert.equal(new Set(historyTypes).size, 1, '长历史不为每条消息创建回收类别');
}

assert.equal(classify([], [message()], ['a']).type, 'initial');
assert.equal(classify(['a'], [message()], ['a']).type, 'unchanged');
assert.equal(classify(['a'], [message({ id: 2 })], ['b']).type, 'replacement-or-reorder');
assert.equal(classify(['a', 'b'], [message(), message(), message()], ['x', 'a', 'b']).type, 'replacement-or-reorder');

const appended = [message({ id: 1 }), message({ id: 2 }), message({ id: 3 })];
const appendMutation = classify(['a'], appended, ['a', 'b', 'c']);
assert.equal(appendMutation.type, 'append');
assert.deepEqual(Array.from(appendMutation.appendedMessages, (item) => item.id), [2, 3]);

// ActionGroup child 增长保留同一个列表 key：不是新独立消息，也不触发“新消息”提示。
const expandedActionGroupMutation = classify(
  ['presentation_action_group:run:run-1:db:1'],
  [message({ id: 1, senderType: 'reasoning' })],
  ['presentation_action_group:run:run-1:db:1'],
);
assert.equal(expandedActionGroupMutation.type, 'unchanged');
assert.equal(expandedActionGroupMutation.appendedMessages.length, 0);

assert.equal(state.isNewMessagePromptEligible(message()), true, '普通 assistant 应提示');
assert.equal(state.isNewMessagePromptEligible(message({ isMe: true, senderType: 'user' })), false);
assert.equal(state.isNewMessagePromptEligible(message({ senderType: 'reasoning' })), false);
assert.equal(state.isNewMessagePromptEligible(message({ senderType: 'tool' })), false);

function callMetadata(overrides = {}) {
  return JSON.stringify({
    type: 'callStatus',
    callId: 'call-1',
    callStatus: 'callEnded',
    direction: 'incoming',
    initiator: 'ai',
    ownerRole: 'assistant',
    actor: 'ai',
    endReason: 'aiEnded',
    displayText: '通话结束',
    aiContextText: '通话结束',
    source: 'callRuntime',
    ...overrides,
  });
}

assert.equal(state.isNewMessagePromptEligible(message({ metadataJson: callMetadata() })), false);
assert.equal(state.isNewMessagePromptEligible(message({
  metadataJson: callMetadata({ callStatus: 'callRejectedByUser', endReason: 'userRejected' }),
})), false, '用户主动拒接不提示');
assert.equal(state.isNewMessagePromptEligible(message({
  metadataJson: callMetadata({ callStatus: 'callMissed', endReason: 'missedByUser' }),
})), true, 'AI 主动来电且用户未接应提示');
assert.equal(state.isNewMessagePromptEligible(message({
  metadataJson: JSON.stringify({ triggerSource: 'call' }),
})), false, '通话中产生的普通文本不提示');

assert.equal(state.resolveBottomFollowState({
  followingBottom: true,
  isUserInteracting: false,
  isNearBottom: false,
}), true, '内容增长不能取消贴底意图');
assert.equal(state.resolveBottomFollowState({
  followingBottom: true,
  isUserInteracting: true,
  isNearBottom: false,
}), false, '用户主动滚离才取消贴底');
assert.equal(state.resolveBottomFollowState({
  followingBottom: false,
  isUserInteracting: true,
  isNearBottom: true,
}), true, '用户回到底部应恢复跟随');
assert.equal(state.resolveBottomFollowState({
  followingBottom: true,
  isUserInteracting: false,
  isNearBottom: false,
}), true, '展开中的 ActionGroup 高度增长时，既有贴底意图应继续保留');
assert.equal(state.resolveBottomFollowState({
  followingBottom: false,
  isUserInteracting: false,
  isNearBottom: false,
}), false, '用户已主动滚离后，ActionGroup 高度增长不得恢复贴底');

// 分段到达回归：重进和历史共享当前进度，旧异步快照不能回退。
function userMessage(id = 20) {
  return message({ id, isMe: true, senderType: 'user' });
}
{
  const messages = [userMessage(20), ...[30, 31, 32].map((id) => message({ id }))];
  const visible = () => Array.from(arrival.projectArrivedAssistantMessages(
    messages, arrival.getAssistantMessageArrivalSnapshot().pendingMessageIds,
  ), (item) => item.id);
  let notifications = 0;
  const unsubscribe = arrival.subscribeAssistantMessageArrival(() => { notifications += 1; });
  arrival.applyAssistantMessageArrivalSnapshot({ revision: 1, pendingMessageIds: [30, 31, 32], pendingSessionIds: ['s1'] });
  assert.deepEqual(visible(), [20]);
  arrival.applyAssistantMessageArrivalSnapshot({ revision: 2, pendingMessageIds: [31, 32], pendingSessionIds: ['s1'] });
  assert.deepEqual(visible(), [20, 30]);
  arrival.applyAssistantMessageArrivalSnapshot({ revision: 1, pendingMessageIds: [30, 31, 32], pendingSessionIds: ['s1'] });
  assert.deepEqual(visible(), [20, 30], '旧快照不能隐藏已到达消息');
  arrival.applyAssistantMessageArrivalSnapshot({ revision: 3, pendingMessageIds: [32], pendingSessionIds: ['s1'] });
  assert.deepEqual(visible(), [20, 30, 31]);
  arrival.applyAssistantMessageArrivalSnapshot({ revision: 4, pendingMessageIds: [], pendingSessionIds: [] });
  assert.deepEqual(visible(), [20, 30, 31, 32]);
  assert.deepEqual(visible(), [20, 30, 31, 32], '重进页面和历史不补播');
  assert.equal(notifications, 4);
  unsubscribe();
  const independent = [
    message({ id: 40, turnRunId: 'pending-run' }),
    message({ id: 41, turnRunId: 'pending-run', senderType: 'reasoning' }),
    message({ id: 42, turnRunId: 'other-run' }),
    userMessage(43),
  ];
  assert.deepEqual(Array.from(arrival.projectArrivedAssistantMessages(independent, [40]), (item) => item.id), [41, 42, 43]);
}

// 已确认 canonical 第二气泡与尚在运行的工具共存，连续 itemIndex 不得抢占 source sequence。
{
  const runId = 'mixed-segments';
  const base = { ...message({ id: 1001, text: '第一气泡', turnRunId: runId, turnItemIndex: 2 }),
    clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, 2, 0) };
  const second = { ...base, id: 1002, text: '第二气泡', turnItemIndex: 3,
    clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, 2, 1) };
  const tool = { ...base, id: -200, senderType: 'system', text: '下一步工具', turnItemIndex: 3,
    clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, 3, 0) };
  const rendered = transientTimeline.mergeTimelineRenderMessages({ persistedMessages: [base, second], transientMessages: [tool] });
  assert.deepEqual(Array.from(rendered, message => message.text), ['第一气泡', '第二气泡', '下一步工具']);
  assert.equal(rendered[1], second, '展示排序不得改写持久消息的游标字段');
  assert.equal(second.turnItemIndex, 3);
}

// 停止执行只结束活动样式，不把未知工具结果改成成功，也不抹掉原文。
{
  const stopped = message({ id: 1101, senderType: 'system', text: '正在调用：换头像', status: 'streaming',
    turnRunId: 'stopped-tool', turnItemIndex: 1,
    metadataJson: JSON.stringify({ type: 'toolStatus', source: 'chatToolFlow', status: 'running', toolNames: ['avatar'], displayNames: ['换头像'], displayText: '正在调用：换头像', interrupted: true }) });
  const group = actionGrouping.segmentContiguousAgentActions([stopped])[0];
  assert.equal(group.kind, 'action-group');
  assert.equal(group.isRunning, false);
  assert.equal(group.children[0].text, '正在调用：换头像');
}

// 行动步骤回归：后续过程及时展示并保持真实顺序。
{
  const sessionId = 'action-order';
  const runId = 'action-order-run';
  const otherRunId = 'independent-run';
  const user = userMessage(51);
  const kinds = ['reasoning', 'tool', 'assistant', 'reasoning', 'tool', 'assistant'];
  const texts = ['R1', 'T1', 'A1', 'R2', 'T2', 'A2'];
  const snapshots = kinds.map((kind, index) => ({
    runId,
    sequence: index + 1,
    stepIndex: Math.floor(index / 3),
    kind,
    status: 'sent',
    text: texts[index],
    clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, index + 1),
    createdAt: `2026-09-09T12:00:0${index + 1}.000Z`,
    time: '12:00',
  }));
  function merge(persistedMessages = [user], suppressTransientAssistantText = true) {
    return transientTimeline.mergeTimelineRenderMessages({
      persistedMessages,
      // 顺序由真实 timeline sorter 决定，不能依赖调用方的数组排列。
      transientMessages: transientStore.snapshotAgentTransientTimelineWithReplacements(sessionId).reverse(),
      suppressTransientAssistantText,
    });
  }
  function project(messages) {
    return Array.from(actionGrouping.segmentContiguousAgentActions(messages), (item) => (
      item.kind === 'message'
        ? item.message.text
        : Array.from(item.children, (child) => child.text)
    ));
  }

  transientStore.applyAgentTransientTimelineSnapshots({ sessionId, snapshots: snapshots.slice(0, 2) });
  const firstGroup = actionGrouping.segmentContiguousAgentActions(merge())[1];
  assert.deepEqual(project(merge()), [user.text, ['R1', 'T1']]);
  transientStore.applyAgentTransientTimelineSnapshots({ sessionId, snapshots });
  const beforeCommit = merge();
  assert.deepEqual(
    project(beforeCommit),
    [user.text, ['R1', 'T1'], 'A1', ['R2', 'T2'], 'A2'],
    '正文独立等待交付时，后续过程仍按 source sequence 进入展示流程',
  );
  assert.equal(actionGrouping.segmentContiguousAgentActions(beforeCommit)[1].key, firstGroup.key);
  assert.deepEqual(
    project(merge([user], false)),
    [user.text, ['R1', 'T1'], 'A1', ['R2', 'T2'], 'A2'],
    '正文可直接展示的主题应实时保留全部事件顺序',
  );

  const nextUser = { ...userMessage(52), createdAt: '2026-09-09T12:00:08.000Z' };
  const externalCard = message({
    id: 53,
    senderType: 'system',
    text: '同 run 工具产生的卡片',
    turnRunId: runId,
    turnItemIndex: null,
    createdAt: '2026-09-09T12:00:05.500Z',
  });
  transientStore.applyAgentTransientTimelineSnapshots({
    sessionId,
    snapshots: [{
      ...snapshots[0],
      runId: otherRunId,
      clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(otherRunId, 1),
      text: '独立 run 的思考',
      createdAt: '2026-09-09T12:00:07.000Z',
    }],
  });
  assert.deepEqual(
    project(merge([user, externalCard, nextUser])),
    [user.text, ['R1', 'T1'], 'A1', ['R2', 'T2'], externalCard.text, 'A2', ['独立 run 的思考'], nextUser.text],
    '同 run 的后续卡片不能越过正文，但用户消息与其他 run 不受影响',
  );
  transientStore.clearAgentTransientTimelineRun(otherRunId, sessionId);

  let turnItemIndex = 0;
  function committed(sequence, text, segmentIndex = 0, segmentTotal = 1) {
    const snapshot = snapshots[sequence - 1];
    turnItemIndex += 1;
    return message({
      id: 400 + turnItemIndex,
      senderType: snapshot.kind === 'tool' ? 'system' : snapshot.kind,
      text,
      createdAt: snapshot.createdAt,
      clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, sequence, segmentIndex),
      logicalMessageId: `agent_timeline:${runId}:step:${snapshot.stepIndex}`,
      turnRunId: runId,
      turnItemIndex,
      segmentIndex,
      segmentTotal,
      metadataJson: snapshot.kind === 'tool'
        ? JSON.stringify({
            type: 'toolStatus', status: 'completed', toolNames: [], displayNames: [],
            displayText: text, source: 'chatToolFlow',
          })
        : null,
    });
  }
  const committedMessages = [
    committed(1, 'R1'), committed(2, 'T1'),
    committed(3, 'A1a', 0, 2), committed(3, 'A1b', 1, 2),
    committed(4, 'R2'), committed(5, 'T2'), committed(6, 'A2'),
  ];
  transientStore.reconcileAgentTransientTimelineCommit(sessionId, runId, committedMessages);
  const afterCommit = merge();
  assert.deepEqual(
    project(arrival.projectArrivedAssistantMessages(afterCommit, [404, 407])),
    [user.text, ['R1', 'T1'], 'A1a', ['R2', 'T2']],
    '未到达正文同时阻止同一 run 的后续过程越过它',
  );
  assert.deepEqual(
    project(arrival.projectArrivedAssistantMessages(afterCommit, [])),
    [user.text, ['R1', 'T1'], 'A1a', 'A1b', ['R2', 'T2'], 'A2'],
    '到达后按真实正文边界分开行动步骤',
  );
  assert.equal(actionGrouping.segmentContiguousAgentActions(afterCommit)[1].key, firstGroup.key);
  transientStore.acknowledgeAgentTransientTimelineCommitted(sessionId, committedMessages);
  assert.deepEqual(project(merge([user, ...committedMessages])), project(afterCommit));

  // 没有正文分界时，跨 step 的过程保持连续，不能机械地按 step 拆组。
  transientStore.applyAgentTransientTimelineSnapshots({
    sessionId,
    snapshots: [snapshots[0], snapshots[1], snapshots[3], snapshots[4]],
  });
  assert.deepEqual(project(merge()), [user.text, ['R1', 'T1', 'R2', 'T2']]);
  transientStore.clearAgentTransientTimelineRun(runId, sessionId);
  assert.deepEqual(Array.from(merge()), [user], 'run 清理后不保留展示阻挡状态');
}

// 群工具的成功提示立即可见，但不把同一段行动过程拆成多张卡。
{
  const sessionId = 'group-operation-display';
  const runId = 'group-operation-run';
  const user = userMessage(901);
  const kinds = ['reasoning', 'tool', 'reasoning', 'tool', 'reasoning', 'assistant'];
  const texts = ['思考改名', '修改群名', '思考移除', '移除成员', '确认结果', '处理好了'];
  const snapshots = kinds.map((kind, index) => ({
    runId, sequence: index + 1, stepIndex: Math.floor(index / 2), kind, status: 'sent', text: texts[index],
    clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, index + 1),
    createdAt: `2026-09-09T12:00:0${index + 1}.000Z`, time: '12:00',
  }));
  const notices = [2, 4].map((second, index) => message({
    id: 910 + index, senderType: 'system', turnRunId: runId, turnItemIndex: null,
    text: index === 0 ? '主理修改了群名' : '主理将成员移出了群聊',
    createdAt: `2026-09-09T12:00:0${second}.500Z`,
    metadataJson: JSON.stringify({ type: 'groupMembershipChanged' }),
  }));
  const merge = (persistedMessages) => transientTimeline.mergeTimelineRenderMessages({
    persistedMessages, transientMessages: transientStore.snapshotAgentTransientTimelineWithReplacements(sessionId),
  });
  const project = messages => Array.from(actionGrouping.segmentContiguousAgentActions(messages), item => (
    item.kind === 'message' ? item.message.text : Array.from(item.children, child => child.text)
  ));

  assert.deepEqual(project(merge([user, notices[0]])), [user.text, notices[0].text],
    '先收到业务提示时立即显示，不能等待整轮回复完成');
  transientStore.applyAgentTransientTimelineSnapshots({ sessionId, snapshots: snapshots.slice(0, 2) });
  let rendered = merge([user, notices[0]]);
  assert.deepEqual(project(rendered), [user.text, texts.slice(0, 2), notices[0].text]);
  const initialCardKey = actionGrouping.segmentContiguousAgentActions(rendered)[1].key;

  transientStore.applyAgentTransientTimelineSnapshots({ sessionId, snapshots: snapshots.slice(2, 4) });
  rendered = merge([user, ...notices]);
  assert.deepEqual(project(rendered), [user.text, texts.slice(0, 4), ...notices.map(item => item.text)],
    '第二次操作追加到原行动卡，已经成功的两条系统提示保持独立且有序');
  assert.equal(actionGrouping.segmentContiguousAgentActions(rendered)[1].key, initialCardKey);

  transientStore.applyAgentTransientTimelineSnapshots({ sessionId, snapshots: snapshots.slice(4) });
  const expected = [user.text, texts.slice(0, 5), ...notices.map(item => item.text), texts[5]];
  assert.deepEqual(project(merge([user, ...notices])), expected);
  const committed = snapshots.map((snapshot, index) => message({
    id: 920 + index, senderType: snapshot.kind === 'tool' ? 'system' : snapshot.kind,
    text: snapshot.text, clientMessageId: snapshot.clientMessageId, createdAt: snapshot.createdAt,
    turnRunId: runId, turnItemIndex: index + 1,
    metadataJson: snapshot.kind === 'tool' ? JSON.stringify({ type: 'toolStatus', status: 'completed',
      toolNames: [], displayNames: [], displayText: snapshot.text, source: 'chatToolFlow' }) : null,
  }));
  transientStore.reconcileAgentTransientTimelineCommit(sessionId, runId, committed);
  assert.deepEqual(project(merge([user, ...notices])), expected, '落库交接不拆卡、不隐藏成功提示');
  transientStore.acknowledgeAgentTransientTimelineCommitted(sessionId, committed);
  const persisted = timelineOrdering.sortChatTimelineMessages([user, ...notices, ...committed]);
  assert.deepEqual(project(merge(persisted)), expected, '历史重读与实时展示采用相同的分组');
  assert.equal(actionGrouping.segmentContiguousAgentActions(persisted)[1].key, initialCardKey);
  assert.deepEqual(project(actionGrouping.filterActionStepsForPresentation(persisted, false)),
    [user.text, ...notices.map(item => item.text), texts[5]], '关闭行动步骤仍然显示群操作结果');
  assert.deepEqual(project([committed[0], notices[0]]), [[texts[0]], notices[0].text],
    '中断后即使没有最终回复，已发生的操作结果仍保留');

  const otherNotice = { ...notices[0], turnRunId: 'another-run', text: '另一个 AI 修改了群名' };
  const manualNotice = { ...notices[0], turnRunId: null, text: '用户修改了群名' };
  const realReply = { ...committed[5], text: '先说一句话' };
  for (const boundary of [user, otherNotice, manualNotice, realReply]) {
    assert.deepEqual(project([committed[0], notices[0], boundary, committed[2]]),
      [[texts[0]], notices[0].text, boundary.text, [texts[2]]], '用户、其他运行和真实发言仍切开行动过程');
  }
  transientStore.clearAgentTransientTimelineRun(runId, sessionId);
}

// 原生列表只模拟布局完成、尺寸变化和滚动命令；跟随决策使用真实组件。
{
  let scrolls = 0;
  const anchorTargets = [];
  let offset = 600;
  let nativeViewportHeight = 600;
  let nativeContentHeight = 1200;
  let scrollContainerMounts = 0;
  let scrollContainerUnmounts = 0;
  const ScrollView = React.forwardRef(function ScrollView(props, ref) {
    React.useEffect(() => {
      scrollContainerMounts++;
      return () => { scrollContainerUnmounts++; };
    }, []);
    return React.createElement('NativeScroller', { ...props, ref });
  });
  const native = {
    View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView,
    requireNativeComponent: name => name,
    Animated: {
      createAnimatedComponent: (Component) => React.forwardRef(function AnimatedComponent(props, ref) {
        return React.createElement(Component, { ...props, ref });
      }),
    },
  };
  const selection = loadModule('src/platform/device/TextSelection.tsx', (name) => {
    if (name === 'react') return React;
    if (name === 'react-native') return native;
    if (name === 'expo-modules-core') return { requireNativeModule: () => ({ releaseFocus: async () => {} }) };
    throw new Error(`未预期的文字选择适配依赖：${name}`);
  });
  // 使用 FlashList 真正的滚动组件装配，覆盖动画包装层造成容器重建的回归。
  const { useSecondaryProps } = loadModule(
    'node_modules/@shopify/flash-list/src/recyclerview/hooks/useSecondaryProps.tsx',
    (name) => {
      if (name === 'react') return React;
      if (name === 'react-native') return native;
      if (name === '../utils/componentUtils') {
        return loadModule('node_modules/@shopify/flash-list/src/recyclerview/utils/componentUtils.ts', () => React);
      }
      if (name === '../components/CompatView') return { CompatView: 'View' };
      if (name === '../components/CompatScroller') return { CompatAnimatedScroller: ScrollView };
      if (name === '../utils/getInvertedTransformStyle') return {};
      throw new Error(`未预期的 FlashList 滚动装配依赖：${name}`);
    },
  );
  const FlashList = React.forwardRef(function FlashList(props, ref) {
    const { CompatScrollView } = useSecondaryProps(props);
    React.useImperativeHandle(ref, () => ({
      scrollToEnd: () => { scrolls++; offset = 1000; },
      scrollToOffset: ({ offset: target }) => {
        scrolls++;
        offset = Math.min(target, Math.max(0, nativeContentHeight - nativeViewportHeight));
      },
      getChildContainerDimensions: () => ({ width: 400, height: measuredContentHeight - 32 }),
      getFirstItemOffset: () => 16,
      getWindowSize: () => ({ width: 400, height: nativeViewportHeight }),
      getAbsoluteLastScrollOffset: () => offset,
      scrollToIndex: ({ index }) => { anchorTargets.push(props.data[index].msg.id); },
    }), [props.data]);
    const observedProps = { ...props, onContentSizeChange: (width, height) => {
      nativeContentHeight = height;
      props.onContentSizeChange(width, height);
    }, onLayout: (event) => {
      nativeViewportHeight = event.nativeEvent.layout.height;
      props.onLayout(event);
    } };
    return React.createElement('FlashList', observedProps, React.createElement(CompatScrollView, props,
      props.data.map((item, index) => React.createElement(React.Fragment, { key: props.keyExtractor(item) },
        props.renderItem({ item, index, target: 'Cell' })))));
  });
  const toolStatus = loadModule(
    'src/features/chat/presentation/messages/components/chatToolStatusPresentation.ts',
    () => metadata,
  );
  const togetherListening = loadModule(
    'src/features/chat/presentation/messages/components/togetherListeningCardViewModel.ts',
    () => metadata,
  );
  let theme = loadModule('src/shared/theme/themes/moonKimi.ts').moonKimiTheme;
  const mediaResolution = loadModule(
    'src/features/chat/presentation/messages/components/chatMediaResolutionCache.ts',
    () => React,
  );
  const historyReads = [];
  const chatEvents = loadModule('src/features/chat/messages/events/ChatEvents.ts');
  const boundaries = {
    '../../../reply/application/ChatTurnPresentationRuntime': {
      reloadTurnDisplayHistory: async (sessionId, messages) => { historyReads.push({ sessionId, messages }); },
      retainTurnDisplayHistory: () => () => {},
    },
    '../../../messages/events/ChatEvents': chatEvents,
    '@platform/device': selection,
    react: React,
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable' },
    '@expo/vector-icons': { Ionicons: 'Icon' },
    '@features/assistants': { getAssistantDisplayName: (assistant) => assistant.nickname || assistant.name },
    '@shopify/flash-list': { FlashList },
    '@features/chat/messages/domain': { ...metadata, buildSessionPreviewTextFromMessage: (msg) => msg.text },
    '@shared/utils/timeFormat': { formatMessageTime: () => '12:00' },
    './ChatMessageListParts': { MessageListItem: (props) => React.createElement('MessageListItem', {
      ...props, mediaCache: React.useContext(mediaResolution.ChatMediaResolutionCacheContext),
    }) },
    './reasoningExpansionState': { ReasoningExpansionContext: React.createContext(null) },
    './chatMediaResolutionCache': mediaResolution,
    '../../../messages/domain/ChatMessageSelection': { getChatSelectionKey: (msg) => String(msg.id) },
    './chatMessageRenderUtils': renderUtils,
    '../MessageBubble/layoutProbe': { createLayoutProbeCellRenderer: () => undefined },
    './togetherListeningCardViewModel': togetherListening,
    './chatMessagePresentation': presentation,
    './chatToolStatusPresentation': toolStatus,
    './chatActionGrouping': actionGrouping,
    './chatPresentationRun': presentationRun,
    './chatStyles': { createMessageListStyles: () => ({ contentContainer: { paddingVertical: 16 } }) },
    './useAgentTransientTimeline': transientTimeline,
    '@features/chat/messages/application/AgentTransientTimeline': transientStore,
    '@shared/theme': { ...themes, useTheme: () => theme },
    './chatMessageListState': state,
    './PaperNoteChatFooter': { __esModule: true, default: 'PaperNoteFooter' },
    './useChatBottomFollow': loadModule(
      'src/features/chat/presentation/messages/components/useChatBottomFollow.ts',
      (name) => {
        if (name === 'react') return React;
        if (name === 'react-native') return { PixelRatio: { getPixelSizeForLayoutSize: value => Math.round(value * 3) } };
        if (name === './chatMessageListState') return state;
        throw new Error(`未预期的贴底运行时依赖：${name}`);
      },
    ),
    './chatHistoryPagination': loadModule('src/features/chat/presentation/messages/components/chatHistoryPagination.ts'),
  };
  const List = loadModule(
    'src/features/chat/presentation/messages/components/ChatMessageList.tsx',
    (name) => {
      assert.ok(Object.hasOwn(boundaries, name), `未声明的列表依赖：${name}`);
      return boundaries[name];
    },
  ).default;
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback()));
  };
  let messages = [message({ id: 601, senderType: 'reasoning' }), message({ id: 602 })];
  let dismisses = 0;
  let props = { sessionId: 's1', messages, hasMore: false, isLoadingMore: false, onPreviewFile: () => {}, onDismissInputSurface: () => { dismisses++; } };
  let renderer;
  act(() => { renderer = create(React.createElement(List, props)); });
  const initialHistoryReads = historyReads.length;
  act(() => {
    chatEvents.emitChatMessagesUpdated('s1');
    chatEvents.emitChatMessagesReloadRequested('s1');
    chatEvents.emitChatMessagesPatched({ sessionId: 's1', updatedMessageIds: [602] });
    chatEvents.emitChatMessagesDeleted('s1', [602]);
    chatEvents.emitChatRegenerationChanged('s1');
    chatEvents.emitChatGroupSpeechPlanChanged('s1');
    chatEvents.emitChatTypingStatusChanged('s1', true);
    chatEvents.emitChatTurnExecutionChanged('s1');
  });
  assert.equal(historyReads.length, initialHistoryReads, '聊天事件先由时间线消费，列表不能提前重复查询展示历史');
  const nativeScroller = renderer.root.findByType('NativeScroller');
  assert.equal(nativeScroller.props.nativeScrollViewComponent, 'ScrollView', '聊天滚动必须使用 Fabric ScrollView 的坐标契约');
  assert.equal(nativeScroller.props.textSelectionEnabled, true, '文字选择策略只由专用滚动适配显式启用');
  const list = () => renderer.root.findByType('FlashList');
  const messageData = () => Array.from(list().props.data).filter(item => 'msg' in item);
  const mediaCache = () => renderer.root.findAllByType('MessageListItem')[0].props.mediaCache;
  mediaCache().stickers.set('seen-sticker', 'file:///seen-sticker');
  let measuredContentHeight = 1200;
  const commit = (height, afterLayout = () => {}) => {
    act(() => {
      measuredContentHeight = height;
      // 模拟 FlashList 自带贴底配置的行为，覆盖第二条滚动入口。
      if (list().props.maintainVisibleContentPosition.autoscrollToBottomThreshold != null) {
        scrolls++; offset = 1000;
      }
      list().props.onContentSizeChange(400, height);
      list().props.onCommitLayoutEffect();
      afterLayout();
    });
    flushFrames();
  };
  const update = (changes) => {
    props = { ...props, ...changes };
    act(() => renderer.update(React.createElement(List, props)));
  };
  const usageMessage = message({ id: 602, tokensUsed: 120, promptTokens: 100, completionTokens: 20,
    metadataJson: '{"cachedTokens":80}' });
  update({ messages: [messages[0], usageMessage], aiAssistant: { id: 'ai', showTokenUsage: true } });
  assert.equal(scrollContainerMounts, 1, '消息或设置更新不能重建滚动容器');
  assert.equal(scrollContainerUnmounts, 0, '消息或设置更新保留正在使用的原生滚动视图');
  assert.equal(mediaCache().stickers.get('seen-sticker'), 'file:///seen-sticker', '消息和设置更新保留已解析媒体地址');
  assert.equal(messageData().at(-1).displayTokensUsed, 120, '开启选择后实际列表提供用量提示');
  update({ aiAssistant: { id: 'ai', showTokenUsage: false } });
  assert.equal(messageData().at(-1).displayTokensUsed, 0, '关闭选择后实际列表隐藏所有用量提示');
  assert.equal(usageMessage.tokensUsed, 120, '关闭展示不会修改消息用量事实');
  assert.equal(JSON.parse(usageMessage.metadataJson).cachedTokens, 80);
  update({ aiAssistant: { id: 'ai', showTokenUsage: true } });
  assert.equal(messageData().at(-1).displayTokensUsed, 120, '重新开启立即显示已有消息用量');
  update({ messages, aiAssistant: undefined });
  commit(1200);
  scrolls = 0; offset = 600;
  commit(1500);
  commit(1200);
  assert.equal(scrolls, 0, '展开和收起思维链只改变高度，不能滚到底部');
  assert.equal(offset, 600, '展开后阅读位置保留');
  update({ translations: { 602: { text: '译文', sourceLabel: '测试' } } });
  commit(1350);
  assert.equal(scrolls, 0, '展示变化不能冒充新消息');
  messages = [...messages, message({ id: 603, text: '流式正文' })];
  const beforeNewMessageReads = historyReads.length;
  update({ messages }); commit(1450);
  assert.ok(historyReads.length > beforeNewMessageReads, '新消息读回后仍会更新展示历史窗口');
  assert.deepEqual(historyReads.at(-1), { sessionId: 's1', messages });
  assert.equal(scrolls, 1, '尾部新消息在布局完成后跟随');
  messages = [...messages.slice(0, -1), message({ id: 603, text: '流式正文继续增长' })];
  update({ messages }); commit(1550);
  assert.equal(scrolls, 2, '相同消息身份的流式更新仍应跟随');
  commit(1800);
  assert.equal(scrolls, 2, '消息更新完成后，另一次局部展开不能沿用跟随请求');
  messages = [message({ id: 600 }), ...messages];
  update({ messages }); commit(2000);
  assert.equal(scrolls, 2, '历史 prepend 不触发贴底');
  const away = { nativeEvent: { contentOffset: { y: 100 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 600 } } };
  act(() => {
    list().props.onScrollBeginDrag(away);
    list().props.onScroll(away);
    list().props.onScrollEndDrag(away);
  });
  messages = [...messages, message({ id: 604 })];
  update({ messages }); commit(2100);
  assert.equal(scrolls, 2, '用户滚离底部时，新消息不得拉回');
  assert.equal(renderer.root.findAllByProps({ accessibilityLabel: '查看新消息' }).length > 0, true);
  const keptIds = messages.filter((message) => message.id !== 602).map((message) => message.id);
  messages = messages.filter((message) => message.id !== 602);
  update({ messages }); commit(1900);
  assert.equal(scrolls, 2, '阅读历史时删除消息不能跳到底部');
  assert.deepEqual(messageData().map((item) => item.msg.id), keptIds, '删除只移除目标，保留其余历史');
  act(() => list().props.onScrollEndDrag({ nativeEvent: { ...away.nativeEvent, contentOffset: { y: 1500 }, contentSize: { height: 2100 } } }));
  update({ pauseAutoScroll: true, messages: [...messages, message({ id: 605 })] });
  commit(2200);
  assert.equal(scrolls, 2, '分享预览暂停期间不得自动跟随');

  const layout = (height) => {
    act(() => list().props.onLayout({ nativeEvent: { layout: { height } } }));
    flushFrames();
  };
  update({ pauseAutoScroll: false });
  layout(600);
  assert.equal(scrolls, 2, '首次测量视口由列表初始定位负责');
  // 键盘打开时，原生滚动事件可能先于布局事件报告缩小后的视口。
  act(() => list().props.onScroll({ nativeEvent: {
    contentOffset: { y: 1600 }, contentSize: { height: 2200 }, layoutMeasurement: { height: 300 },
  } }));
  layout(300);
  assert.equal(scrolls, 3, '原本贴底时，键盘缩小视口仍应让最新消息出现在键盘上方');
  layout(300);
  commit(2400);
  assert.equal(scrolls, 3, '键盘打开后，同高度布局或思维链展开仍不能强制贴底');
  layout(600);
  assert.equal(scrolls, 4, '键盘收起后，贴底状态随视口恢复');
  act(() => list().props.onScrollEndDrag(away));
  layout(300);
  layout(600);
  assert.equal(scrolls, 4, '阅读历史时，键盘开关不得拉回最新消息');
  act(() => list().props.onScrollEndDrag({ nativeEvent: {
    contentOffset: { y: 1800 }, contentSize: { height: 2400 }, layoutMeasurement: { height: 600 },
  } }));
  update({ pauseAutoScroll: true });
  layout(300);
  assert.equal(scrolls, 4, '分享预览暂停期间，视口变化也不得自动跟随');
  update({ pauseAutoScroll: false });
  // 用户在等待下一帧布局跟随时滚离底部，应取消此次自动跟随。
  act(() => {
    list().props.onLayout({ nativeEvent: { layout: { height: 600 } } });
    list().props.onScrollEndDrag(away);
  });
  flushFrames();
  assert.equal(scrolls, 4, '视口跟随执行前仍应尊重用户新产生的上翻意图');

  const touchSurface = () => renderer.root.findByType('View');
  const dismissesBeforeTouch = dismisses;
  const bottom = { nativeEvent: {
    contentOffset: { y: 1800 }, contentSize: { height: 2400 }, layoutMeasurement: { height: 600 },
  } };
  act(() => list().props.onScrollEndDrag(bottom));
  act(() => {
    list().props.onLayout({ nativeEvent: { layout: { height: 500 } } });
    touchSurface().props.onTouchStart();
  });
  flushFrames();
  assert.equal(dismisses, dismissesBeforeTouch, '按下消息时不能收起输入面板并移动正在触摸的目标');
  assert.equal(scrolls, 4, '已安排的自动贴底也不能打断随后开始的按压');
  act(() => touchSurface().props.onTouchEnd());
  flushFrames();
  assert.equal(dismisses, dismissesBeforeTouch + 1, '抬手后收起输入面板');
  assert.equal(scrolls, 5, '触摸结束后补上等待中的跟随');

  act(() => touchSurface().props.onTouchStart());
  for (const text of ['按压期间增长', '按压期间继续增长']) {
    messages = [...messages.slice(0, -1), { ...messages.at(-1), text }];
    update({ messages }); commit(2500);
  }
  assert.equal(scrolls, 5, '长按等待期间，连续流式更新不能取消按压');
  act(() => touchSurface().props.onTouchEnd());
  flushFrames();
  assert.equal(scrolls, 6, '多次流式更新在抬手后合并为一次跟随');
  act(() => {
    touchSurface().props.onTouchStart();
    touchSurface().props.onTouchEnd();
  });
  flushFrames();
  assert.equal(scrolls, 6, '没有消息或视口变化时，普通点击不能制造自动贴底');

  act(() => touchSurface().props.onTouchStart());
  messages = [...messages, message({ id: 606 })];
  update({ messages }); commit(2600);
  const dismissesBeforeDrag = dismisses;
  act(() => {
    list().props.onScrollBeginDrag(away);
  });
  assert.equal(dismisses, dismissesBeforeDrag + 1, '确认原生拖动后仍应收起输入面板');
  act(() => {
    touchSurface().props.onTouchCancel();
  });
  flushFrames();
  assert.equal(scrolls, 6, '原生滚动接管触摸时不能立即执行等待中的贴底');
  assert.equal(dismisses, dismissesBeforeDrag + 1, '取消的触摸不再当作点击重复收起面板');
  act(() => {
    list().props.onScroll(away);
    list().props.onScrollEndDrag(away);
  });
  flushFrames();
  assert.equal(scrolls, 6, '长按转为上翻历史后，应放弃等待中的贴底');

  act(() => list().props.onScrollEndDrag(bottom));
  act(() => list().props.onLayout({ nativeEvent: { layout: { height: 400 } } }));
  messages = [...messages, message({ id: 607 })];
  update({ messages });
  commit(2700);
  assert.equal(scrolls, 7, '同一帧的视口变化与尾部追加合并为一次贴底');

  assert.equal(scrollContainerMounts, 1, '流式增长、历史分页、滚动提示与键盘变化共用同一个滚动容器');
  assert.equal(scrollContainerUnmounts, 0, '列表更新不能卸载滚动视图和已测量的消息');
  act(() => list().props.onLayout({ nativeEvent: { layout: { height: 500 } } }));
  update({ sessionId: 's2' });
  assert.equal(mediaCache().stickers.get('seen-sticker'), undefined, '新会话不继承旧会话媒体地址缓存');
  commit(2700);
  assert.equal(scrolls, 7, '旧会话待执行的贴底不能滚动新会话');
  assert.equal(scrollContainerMounts, 2, '切换会话才重新建立列表滚动容器');
  assert.equal(scrollContainerUnmounts, 1, '切换会话释放旧列表');
  layout(600);
  act(() => list().props.onLayout({ nativeEvent: { layout: { height: 500 } } }));
  update({ anchorMessageId: 607 });
  flushFrames();
  assert.equal(scrolls, 7, '定位历史消息时取消待执行的贴底');
  assert.deepEqual(anchorTargets, [607], '锚点由原有定位入口执行');
  update({ messages: [...messages, message({ id: 608 })] });
  commit(2800);
  assert.deepEqual(anchorTargets, [607], '消息追加不能重放已经消费的锚点');
  assert.equal(scrolls, 7, '锚点定位后保持阅读位置');
  act(() => list().props.onScrollEndDrag(bottom));
  act(() => list().props.onLayout({ nativeEvent: { layout: { height: 400 } } }));
  act(() => renderer.unmount());
  flushFrames();
  assert.equal(scrolls, 7, '离开页面后不执行遗留的贴底请求');
  assert.equal(scrollContainerUnmounts, 2, '离开页面释放剩余滚动容器');

  // 群聊控制栏已占据布局高度；列表提交先于原生内容扩高时，不能把旧底部当成已贴底。
  props = { ...props, sessionId: 'group-bottom-follow', messages: [message({ id: 7800 })],
    showAssistantName: true, anchorMessageId: null };
  nativeViewportHeight = 600;
  offset = 600;
  act(() => { renderer = create(React.createElement(List, props)); });
  commit(1200);
  update({ messages: [...props.messages, message({ id: 7801, text: '群成员的新回复' })] });
  act(() => {
    measuredContentHeight = 1550;
    list().props.onCommitLayoutEffect();
  });
  flushFrames();
  assert.equal(offset, 600, '原生内容尚未扩高时仍停在旧的可滚动范围内');
  act(() => list().props.onContentSizeChange(400, 1400));
  flushFrames();
  assert.equal(offset, 600, '原生内容只更新了部分高度时，不能提前消费待执行的跟随');
  act(() => list().props.onContentSizeChange(400, 1550));
  flushFrames();
  assert.equal(offset, 950, '原生内容扩高后完成待执行的跟随，完整显示最后一条群消息');
  const scrollsAfterGroupReply = scrolls;
  commit(1800);
  assert.equal(scrolls, scrollsAfterGroupReply, '已完成跟随后，单独展开内容仍保留阅读位置');
  update({ messages: [...props.messages, message({ id: 7802, text: '下一位成员的回复' })] });
  act(() => {
    measuredContentHeight = 2100;
    list().props.onCommitLayoutEffect();
  });
  flushFrames();
  offset = 100;
  act(() => list().props.onScrollEndDrag(away));
  act(() => list().props.onContentSizeChange(400, 2100));
  flushFrames();
  assert.equal(offset, 100, '等待原生扩高时用户已上翻，迟到的尺寸事件不能再拉回底部');
  act(() => renderer.unmount());

  // Android 内容尺寸与 cell 布局独立取整，跨过半个 dp 的像素误差不能永久阻塞跟随。
  props = { ...props, sessionId: 'fractional-bottom-follow', messages: [message({ id: 7850 })] };
  nativeViewportHeight = 600;
  offset = 600;
  act(() => { renderer = create(React.createElement(List, props)); });
  commit(1200);
  layout(600);
  act(() => {
    measuredContentHeight = 1200.5;
    list().props.onContentSizeChange(400, 1200 + 1 / 3);
    list().props.onCommitLayoutEffect();
  });
  layout(300);
  assert.ok(Math.abs(offset - (1200 + 1 / 3 - 300)) < 0.001,
    '已在底部时，键盘抬起仍将末条消息移到输入框上方');
  layout(600);
  offset = 600;
  update({ messages: [...props.messages, userMessage(7851)] });
  act(() => {
    measuredContentHeight = 1550.5;
    list().props.onCommitLayoutEffect();
    list().props.onContentSizeChange(400, 1549);
  });
  flushFrames();
  assert.equal(offset, 600, '原生内容仍差多个物理像素时，继续等待真实扩高');
  act(() => list().props.onContentSizeChange(400, 1550 + 1 / 3));
  flushFrames();
  assert.ok(Math.abs(offset - (1550 + 1 / 3 - 600)) < 0.001,
    '原生尺寸与已提交布局只差一个物理像素时，仍应完成贴底');
  const scrollsAfterFractionalReply = scrolls;
  commit(1800);
  assert.equal(scrolls, scrollsAfterFractionalReply, '像素误差不遗留跟随请求，之后局部展开保持位置');
  act(() => renderer.unmount());

  // 所有主题都按当前 AI 的选择隐藏完整行动步骤；相同文字的正文始终保留。
  const sameTextMessages = [
    message({ id: 7900, senderType: 'reasoning', text: '相同的正文', logicalMessageId: 'same-text' }),
    message({ id: 7901, text: '相同的正文', logicalMessageId: 'same-text', tokensUsed: 120 }),
  ];
  for (const themeId of ['default-light', 'default-dark', 'liquid-glass', 'paper-note', 'moon-kimi']) {
    theme = { ...theme, id: themeId };
    const processMessage = message({ id: 7902, senderType: 'system', text: '工具执行中',
      metadataJson: JSON.stringify({ type: 'toolStatus', status: 'running', toolNames: ['search'],
        displayNames: ['搜索'], displayText: '工具执行中', source: 'chatToolFlow' }) });
    props = { ...props, sessionId: 'same-text-session', messages: [...sameTextMessages, processMessage], anchorMessageId: null,
      aiAssistant: { id: 'ai', showActionSteps: true, showTokenUsage: true } };
    act(() => { renderer = create(React.createElement(List, props)); });
    assert.deepEqual(messageData().map(item => item.msg.id), [7900, 7901, 7902]);
    assert.equal(messageData().find(item => item.msg.id === 7901).displayTokensUsed, 120, `${themeId} 显示 Token`);
    update({ aiAssistant: { id: 'ai', showActionSteps: false, showTokenUsage: true } });
    assert.deepEqual(messageData().map(item => item.msg.id), [7901]);
    assert.equal(messageData()[0].displayTokensUsed, 120, '隐藏行动步骤不隐藏 Token');
    update({ aiAssistant: { id: 'other-ai', showActionSteps: true, showTokenUsage: false } });
    assert.deepEqual(messageData().map(item => item.msg.id), [7900, 7901, 7902], '另一个 AI 使用自己的选择');
    assert.equal(messageData().find(item => item.msg.id === 7901).displayTokensUsed, 0, `${themeId} 隐藏 Token`);
    update({ aiAssistant: { id: 'ai', showActionSteps: false, showTokenUsage: true } });
    assert.deepEqual(messageData().map(item => item.msg.id), [7901], '切回后恢复当前 AI 的选择');
    update({ aiAssistant: { id: 'ai', showActionSteps: true, showTokenUsage: true } });
    assert.deepEqual(messageData().map(item => item.msg.id), [7900, 7901, 7902], '重新开启恢复已有行动步骤');
    act(() => renderer.unmount());
    flushFrames();
  }

  // 底栏身份独立于末条消息：追加、流式和历史 prepend 不能把图标卸载后重新读取。
  theme = { ...theme, id: 'paper-note' };
  nativeViewportHeight = 600;
  measuredContentHeight = 800;
  offset = 200;
  props = { ...props, sessionId: 'footer-continuity', messages: [message({ id: 7950 })], anchorMessageId: null, aiAssistant: undefined };
  act(() => { renderer = create(React.createElement(List, props)); });
  commit(800);
  const footer = renderer.root.findByType('PaperNoteFooter');
  const footerKey = list().props.keyExtractor(list().props.data.at(-1));
  for (const [messages, height] of [
    [[message({ id: 7950 }), message({ id: 7951, text: '开始输出' })], 900],
    [[message({ id: 7950 }), message({ id: 7951, text: '继续流式输出' })], 1000],
  ]) {
    update({ messages });
    commit(height, () => {
      assert.equal(height - offset, nativeViewportHeight, '消息布局提交时底栏已保持视口底部，不能先下跳再等下一帧修正');
    });
    assert.equal(renderer.root.findAllByType('PaperNoteFooter').length, 1, '始终只显示一个底栏');
    assert.equal(renderer.root.findByType('PaperNoteFooter'), footer, '消息更新保留底栏实例');
    assert.equal(list().props.keyExtractor(list().props.data.at(-1)), footerKey, '底栏始终位于列表末尾并保留身份');
    assert.deepEqual(messageData().map(item => item.msg.id), messages.map(item => item.id), '底栏不伪造或吞掉业务消息');
  }
  const beforeSameLine = scrolls;
  update({ messages: [message({ id: 7950 }), message({ id: 7951, text: '同一行继续输出' })] });
  commit(1000);
  assert.equal(scrolls, beforeSameLine, '文字增长未改变高度时不重复下发滚动');
  update({ messages: [message({ id: 7949 }), ...props.messages] });
  commit(1100);
  assert.equal(scrolls, beforeSameLine, '历史 prepend 仍交给列表阅读锚点');
  assert.equal(renderer.root.findByType('PaperNoteFooter'), footer, '历史 prepend 保留底栏实例');
  act(() => renderer.unmount());
  flushFrames();

  // 使用真实到达订阅、运行片段 merge 与确认 effect，覆盖 native 到达通知晚于 SQLite 读回的交接。
  theme = { ...theme, id: 'daylight' };
  const sessionId = 'arrival-handoff';
  const runId = 'arrival-handoff-run';
  const user = message({ id: 8000, sessionId, isMe: true, senderType: 'user' });
  const canonical = message({ id: 8001, sessionId, text: '已经显示的第一段', turnRunId: runId,
    turnItemIndex: 1, clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, 1),
    createdAt: '2026-09-09T12:00:01.000Z' });
  const later = message({ ...canonical, id: 8002, text: '尚未到达的第二段', turnItemIndex: 2,
    clientMessageId: agentIdentity.buildAgentTimelineClientMessageId(runId, 2),
    createdAt: '2026-09-09T12:00:02.000Z' });
  const setPending = (ids) => act(() => arrival.applyAssistantMessageArrivalSnapshot({
    revision: arrival.getAssistantMessageArrivalSnapshot().revision + 1,
    pendingMessageIds: ids, pendingSessionIds: ids.length ? [sessionId] : [],
  }));
  setPending([canonical.id, later.id]);
  props = { ...props, sessionId, messages: [user], anchorMessageId: null };
  act(() => { renderer = create(React.createElement(List, props)); });
  commit(100);
  act(() => transientStore.applyAgentTransientTimelineSnapshots({ sessionId, snapshots: [{
    runId, sequence: 1, stepIndex: 0, kind: 'assistant', status: 'sent', text: canonical.text,
    clientMessageId: canonical.clientMessageId, createdAt: canonical.createdAt, time: canonical.time,
  }] }));
  commit(180);
  const deliveredKey = messageData().at(-1).key;
  assert.equal(messageData().at(-1).msg.text, canonical.text, '持久交付的运行片段立即可见');
  for (let read = 0; read < 3; read++) {
    update({ messages: [user, { ...canonical }, { ...later }] });
    commit(180);
    assert.equal(messageData().length, 2, 'SQLite 先读回时，已显示片段不消失，未到达尾段不泄漏');
    assert.equal(messageData().at(-1).key, deliveredKey, '延迟的到达通知不能改变气泡身份');
  }
  // 到达通知尚未同步时往返切换主题，不能清掉仍在承接显示的运行片段。
  for (const themeId of ['paper-note', 'default-light']) {
    theme = { ...theme, id: themeId };
    update({ messages: [...props.messages] });
  }
  assert.equal(messageData().at(-1).msg.text, canonical.text,
    '纸条切回普通主题后，已显示正文不能消失');
  for (const themeId of ['paper-note', 'moon-kimi', 'default-dark', 'liquid-glass', 'default-light']) {
    theme = { ...theme, id: themeId };
    update({ messages: [...props.messages] });
    commit(180);
    assert.equal(messageData().at(-1).msg.text, canonical.text, `${themeId} 保留已交付正文`);
    assert.equal(messageData().at(-1).key, deliveredKey, '切换主题不改变消息身份');
    assert.equal(messageData().length, 2, `${themeId} 不提前展示未到达尾段`);
  }
  setPending([later.id]);
  commit(180);
  assert.equal(messageData().at(-1).msg.id, canonical.id, '到达资格同步后由 canonical 连续接管');
  assert.equal(messageData().at(-1).key, deliveredKey);
  assert.equal(transientStore.snapshotAgentTransientTimelineWithReplacements(sessionId).length, 0,
    '交接结束清理运行片段，不长期堆积第二份消息');
  act(() => transientStore.reconcileAgentTransientTimelineCommit(sessionId, runId, [canonical, later]));
  commit(180);
  assert.equal(messageData().length, 2, 'committed replacement 同样不能提前展示未到达尾段');
  setPending([]);
  commit(260);
  assert.deepEqual(messageData().map(item => item.msg.id), [user.id, canonical.id, later.id],
    '尾段到达后各显示一次，不重放已经显示的气泡');
  act(() => renderer.unmount());
  flushFrames();

  // 原生可能合并普通 onScroll；首次位移和手势最终位置仍必须产生分页 demand。
  let historyLoads = 0;
  props = { ...props, sessionId: 'history-gesture-boundaries', anchorMessageId: null,
    messages: [message({ id: 9000 }), message({ id: 9001 })], hasMore: true,
    onLoadMore: async () => { historyLoads++; return true; } };
  await act(async () => { renderer = create(React.createElement(List, props)); });
  const historyScroll = (y) => ({ nativeEvent: {
    contentOffset: { y }, contentSize: { height: 6000 }, layoutMeasurement: { height: 800 },
  } });
  await act(async () => {
    list().props.onScrollBeginDrag(historyScroll(3000));
    list().props.onScroll(historyScroll(2200));
  });
  assert.equal(historyLoads, 1, '从原生手势起点比较，在旧的 1.5 屏水位之外就能首次上滑预取');
  await act(async () => list().props.onScrollEndDrag(historyScroll(2200)));
  assert.equal(historyLoads, 1, '结束位置与普通回调相同，不重复请求');
  await act(async () => {
    list().props.onScrollBeginDrag(historyScroll(2200));
    list().props.onScrollEndDrag(historyScroll(600));
  });
  assert.equal(historyLoads, 2, '普通滚动回调被合并时，拖动最终位置仍触发加载');
  await act(async () => {
    list().props.onMomentumScrollBegin();
    list().props.onMomentumScrollEnd(historyScroll(0));
  });
  assert.equal(historyLoads, 3, '惯性停在顶部时消费最终位置，不等待下一次触摸');
  await act(async () => {
    list().props.onScroll(historyScroll(2000));
    list().props.onScroll(historyScroll(0));
    list().props.onContentSizeChange(400, 7000);
  });
  assert.equal(historyLoads, 3, '程序化锚点修正与内容增长不能自行续页');
  await act(async () => renderer.unmount());
  flushFrames();
}
console.log('Chat message list state verification passed.');
