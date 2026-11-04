/** LISTEN-4 Chat timeline metadata、稳定 identity 与纯展示模型回归。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-chat-cards-'));

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(errors.length, 0, `TypeScript 转译失败：${relativePath}`);
  const outputPath = path.join(tempRoot, relativePath.replace(/\.tsx?$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function write(relativePath, source) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, 'utf8');
}

write('src/features/chat/messages/application/CommitAndDispatchCanonicalUserMessage.js', `
exports.commitAndDispatchCanonicalUserMessage = (...args) => globalThis.__listenCardFakes.commit(...args);
`);
write('src/features/chat/messages/application/UpsertStatefulTimelineEntry.js', `
exports.upsertStatefulTimelineEntry = (...args) => globalThis.__listenCardFakes.upsert(...args);
`);
write('src/features/chat/messages/application/ChatMessageRuntime.js', `
exports.getChatMessageRuntimeDependencies = () => ({ messages: {
  upsertStatefulTimelineEntryInTransaction: (_, input) => globalThis.__listenCardFakes.upsert(input),
} });
`);
write('src/features/chat/messages/events/ChatEvents.js', `
exports.emitChatMessagesUpdated = () => {};
exports.emitChatMessagesPatched = () => {};
`);
write('src/features/chat/group/application/ChatGroupRuntime.js', `
exports.getChatGroupRuntimeDependencies = () => ({ groups: {
  getById: async () => globalThis.__listenCardGroup ?? null,
  isSpeechTaskRunCurrentInTransaction: async () => globalThis.__listenCardGroupCurrent,
  updatePreviewInTransaction: async (_, ...args) => { globalThis.__listenCardGroupPreview = args; },
} });
`);
write('src/features/chat/reply/application/ChatReplyAbort.js', `
exports.ChatReplyRunCancelledError = class extends Error {};
`);
write('node_modules/@platform/persistence/index.js', `
exports.databaseCoordinator = { transaction: (_, work) => work({}), openTaskExecutor: () => ({ withExclusiveTransactionAsync: (work) => work({}) }) };
`);

for (const file of [
  'src/features/chat/messages/domain/chatMessageMetadata.ts',
  'src/features/chat/summary/domain/ChatContext.ts',
  'src/features/chat/messages/domain/ChatSticker.ts',
  'src/features/chat/messages/domain/SharedMoment.ts',
  'src/features/chat/messages/domain/SharedChatRecord.ts',
  'src/features/chat/messages/application/UpsertTogetherListeningTimelineEntry.ts',
  'src/features/chat/presentation/messages/components/togetherListeningCardViewModel.ts',
]) compile(file);

const metadataModule = require(path.join(
  tempRoot,
  'src/features/chat/messages/domain/chatMessageMetadata.js',
));
globalThis.__listenMetadataModule = metadataModule;
write('node_modules/@features/chat/messages/domain/chatMessageMetadata.js', `
module.exports = globalThis.__listenMetadataModule;
`);

// view-model 在 alias stub 建立后重新加载，确保消费 Chat domain contract。
const viewModelPath = path.join(
  tempRoot,
  'src/features/chat/presentation/messages/components/togetherListeningCardViewModel.js',
);
delete require.cache[viewModelPath];
const viewModel = require(viewModelPath);
const timeline = require(path.join(
  tempRoot,
  'src/features/chat/messages/application/UpsertTogetherListeningTimelineEntry.js',
));

let nextId = 1;
let latestMessageId = null;
let sessionPreview = '';
const rows = new Map();
const canonicalCommits = [];
globalThis.__listenCardFakes = {
  async upsert({ message, previewText }) {
    const existing = rows.get(message.clientMessageId);
    if (existing) {
      const patched = {
        ...existing,
        text: message.text,
        metadataJson: message.metadataJson,
        updatedAt: message.updatedAt,
      };
      rows.set(message.clientMessageId, patched);
      if (latestMessageId === patched.id && previewText !== null) sessionPreview = previewText;
      return { message: patched, inserted: false };
    }
    const committed = { ...message, id: nextId++ };
    rows.set(message.clientMessageId, committed);
    latestMessageId = committed.id;
    if (previewText !== null) sessionPreview = previewText;
    return { message: committed, inserted: true };
  },
  async commit(params) {
    canonicalCommits.push(params);
    return { userMessage: { ...params.message, id: 99 }, success: true, error: null };
  },
};

function activity(
  id,
  initiator,
  phase,
  endReason = null,
  updatedAtEpochMs = 2,
  activatedAtEpochMs = null,
  endedAtEpochMs = null,
) {
  return {
    id,
    chatSessionId: 'chat-1',
    hostAiId: 'host-1',
    initiator,
    phase,
    createdAtEpochMs: 1,
    updatedAtEpochMs,
    endReason,
    activatedAtEpochMs,
    endedAtEpochMs,
  };
}

const first = await timeline.upsertTogetherListeningTimelineEntry(
  activity('activity-a', 'ai', 'pending_user_response'),
);
assert.equal(first.inserted, true);
assert.equal(first.message.clientMessageId, 'together-listening:activity-a');
assert.equal(first.message.senderType, 'assistant');
assert.equal(first.message.isMe, false);
assert.equal(sessionPreview, '[一起听邀请]');

const active = await timeline.upsertTogetherListeningTimelineEntry(
  activity('activity-a', 'ai', 'active', null, 3, 1_000, null),
);
assert.equal(active.inserted, false);
assert.equal(active.message.id, first.message.id);
assert.equal(active.message.senderType, 'assistant');
assert.equal(sessionPreview, '[正在一起听]');

// 旧卡后面已有普通消息时，patch 不得让 session preview 倒退。
latestMessageId = 500;
sessionPreview = '后来的一条普通消息';
const ended = await timeline.upsertTogetherListeningTimelineEntry(
  activity('activity-a', 'ai', 'ended', 'user_left', 4, 1_000, 757_000),
);
assert.equal(ended.message.id, first.message.id);
assert.equal(sessionPreview, '后来的一条普通消息');

const independent = await timeline.upsertTogetherListeningTimelineEntry(
  activity('activity-b', 'ai', 'pending_user_response', null, 5, null, null),
);
assert.notEqual(independent.message.id, first.message.id);

const persistedMetadata = JSON.parse(ended.message.metadataJson);
const { projectChatContextMessage } = require(path.join(tempRoot, 'src/features/chat/summary/domain/ChatContext.js'));
// 结束事件在结束时追加；即使旧卡已被摘要游标越过，新事件仍进入下一段原文。
assert.equal(projectChatContextMessage(ended.message, ['time', 1, 0, 1]), null);
const endedMessage = rows.get('together-listening-ended:activity-a');
assert.equal(endedMessage.senderType, 'system');
assert.equal(endedMessage.createdAt, new Date(4).toISOString());
assert.equal(endedMessage.turnRunId, null);
assert.equal(endedMessage.text, '你已退出一起听，本次一起听已结束。');
const endedContext = projectChatContextMessage(endedMessage, ['time', 1, 0, 1]);
assert.equal(endedContext.kind, 'app_event');
assert.equal(endedContext.role, 'user');
assert.equal(endedContext.logicalMessageId, null);
const endedEvent = JSON.parse(endedContext.content.split('\n')[1]);
assert.equal(endedEvent.phase, 'ended');
assert.equal(endedEvent.endReason, 'user_left');
assert.equal(endedEvent.endedAtEpochMs, 757_000);
assert.equal(endedEvent.text, '用户已退出一起听，本次一起听已结束。');
const rowsBeforeRepeat = rows.size;
await timeline.upsertTogetherListeningTimelineEntry(activity('activity-a', 'ai', 'ended', 'user_left', 4, 1_000, 757_000));
assert.equal(rows.size, rowsBeforeRepeat, '重复终态投影不得追加第二条事件');
await timeline.upsertTogetherListeningTimelineEntry({
  ...activity('activity-ai-exit', 'ai', 'ended', 'ai_left', 8, 1_000, 757_000), hostAiName: '小羽',
});
const aiExitMessage = rows.get('together-listening-ended:activity-ai-exit');
assert.equal(aiExitMessage.text, '小羽已退出一起听，本次一起听已结束。');
assert.equal(JSON.parse(projectChatContextMessage(aiExitMessage, ['time', 1, 0, 1]).content.split('\n')[1]).endReason, 'ai_left');
for (const initiator of ['user', 'ai']) {
  for (const phase of ['active', 'declined_by_user', 'declined_by_ai']) {
    const message = { ...ended.message, isMe: initiator === 'user', senderType: initiator === 'user' ? 'user' : 'assistant',
      metadataJson: JSON.stringify({ ...persistedMetadata, initiator, phase }) };
    const context = projectChatContextMessage(message, ['time', 1, 0, 1]);
    assert.equal(context.kind, 'app_event');
    assert.equal(JSON.parse(context.content.split('\n')[1]).phase, phase);
  }
}
assert.deepEqual(Object.keys(persistedMetadata).sort(), [
  'activatedAtEpochMs',
  'activityId',
  'endReason',
  'endedAtEpochMs',
  'initiator',
  'phase',
  'source',
  'type',
]);
assert.equal(persistedMetadata.activatedAtEpochMs, 1_000);
assert.equal(persistedMetadata.endedAtEpochMs, 757_000);
for (const forbidden of [
  'title',
  'artist',
  'album',
  'position',
  'duration',
  'durationMs',
  'playback',
]) {
  assert.equal(forbidden in persistedMetadata, false);
}

await timeline.commitTogetherListeningUserInvitation(
  activity('activity-user', 'user', 'pending_ai_response'),
  { id: 'host-1' },
);
assert.equal(canonicalCommits.length, 1);
assert.equal(canonicalCommits[0].message.clientMessageId, 'together-listening:activity-user');
assert.equal(canonicalCommits[0].message.text, '用户邀请你一起听网易云音乐。');
assert.equal(canonicalCommits[0].message.senderType, 'user');

function metadata(phase, endReason = null) {
  return {
    type: 'togetherListening',
    activityId: 'activity-view',
    initiator: phase === 'pending_ai_response' ? 'user' : 'ai',
    phase,
    endReason,
    source: 'togetherListening',
  };
}

assert.deepEqual(
  viewModel.buildTogetherListeningActivityCardViewModel(metadata('pending_user_response')).actions,
  ['decline', 'accept'],
);
assert.deepEqual(
  viewModel.buildTogetherListeningActivityCardViewModel(metadata('pending_ai_response')).actions,
  [],
);
assert.deepEqual(
  viewModel.buildTogetherListeningActivityCardViewModel(metadata('active')).actions,
  ['leave'],
);
assert.deepEqual(
  viewModel.buildTogetherListeningActivityCardViewModel(metadata('declined_by_ai')).actions,
  [],
);
assert.match(
  viewModel.buildTogetherListeningActivityCardViewModel(metadata('ended', 'media_unavailable')).body,
  /网易云音乐播放已结束/,
);

const presentationIdentities = {
  user: { avatar: 'user-avatar', name: '用户身份' },
  ai: { avatar: 'ai-avatar', name: 'AI 身份' },
};
for (const phase of ['pending_ai_response', 'active', 'ended']) {
  const card = viewModel.buildTogetherListeningActivityCardViewModel({
    ...metadata(phase),
    initiator: 'user',
  });
  assert.equal(card.isMe, true);
  assert.deepEqual(
    viewModel.resolveTogetherListeningCardPresentationIdentity(
      card.initiator,
      presentationIdentities,
    ),
    {
      role: 'user',
      isMe: true,
      avatarContent: 'user-avatar',
      name: '用户身份',
    },
    `用户发起卡在 ${phase} 阶段必须保持用户侧身份`,
  );
}
for (const phase of ['pending_user_response', 'active', 'ended']) {
  const card = viewModel.buildTogetherListeningActivityCardViewModel({
    ...metadata(phase),
    initiator: 'ai',
  });
  assert.equal(card.isMe, false);
  assert.deepEqual(
    viewModel.resolveTogetherListeningCardPresentationIdentity(
      card.initiator,
      presentationIdentities,
    ),
    {
      role: 'ai',
      isMe: false,
      avatarContent: 'ai-avatar',
      name: 'AI 身份',
    },
    `AI 发起卡在 ${phase} 阶段必须保持 AI 侧身份`,
  );
}

// ========================================================================
// V1 Closeout — Historical Activity Summary
// ========================================================================
function durationMetadata(phase, activatedAtEpochMs, endedAtEpochMs, endReason = 'user_left') {
  return {
    type: 'togetherListening',
    activityId: 'activity-duration',
    initiator: 'ai',
    phase,
    endReason,
    source: 'togetherListening',
    activatedAtEpochMs,
    endedAtEpochMs,
  };
}

const { formatTogetherListeningHistoricalDuration } = viewModel;
assert.equal(formatTogetherListeningHistoricalDuration(1_000, 757_000), '12:36');
assert.equal(formatTogetherListeningHistoricalDuration(0, 3_723_000), '1:02:03');
assert.equal(formatTogetherListeningHistoricalDuration(0, 8_000), '00:08');
assert.equal(formatTogetherListeningHistoricalDuration(0, 3_599_000), '59:59');
assert.equal(
  formatTogetherListeningHistoricalDuration(5_000, 1_000),
  null,
  'ended 早于 activated 不得伪造历史时长',
);
for (const [activated, ended] of [
  [null, 1_000],
  [1_000, null],
  [undefined, undefined],
  [Number.NaN, 1_000],
  [1_000, Number.POSITIVE_INFINITY],
]) {
  assert.equal(formatTogetherListeningHistoricalDuration(activated, ended), null);
}

assert.equal(
  viewModel.buildTogetherListeningActivityCardViewModel(
    durationMetadata('ended', 1_000, 757_000),
  ).durationText,
  '12:36',
);
assert.equal(
  viewModel.buildTogetherListeningActivityCardViewModel(
    durationMetadata('ended', 0, 3_723_000),
  ).durationText,
  '1:02:03',
);
assert.equal(
  viewModel.buildTogetherListeningActivityCardViewModel(
    durationMetadata('ended', 5_000, 1_000),
  ).durationText,
  null,
);
const activeCard = viewModel.buildTogetherListeningActivityCardViewModel(
  durationMetadata('active', 1_000, null),
);
assert.equal(activeCard.durationText, null, 'active 卡不做 live duration');
assert.equal(activeCard.body, '正在一起听');
assert.deepEqual(activeCard.actions, ['leave']);
assert.equal(
  viewModel.buildTogetherListeningActivityCardViewModel(
    durationMetadata('declined_by_user', null, 9_000, 'unknown'),
  ).durationText,
  null,
  'declined 没有真正的 Activity，不显示 Together duration',
);
for (const phase of ['pending_user_response', 'pending_ai_response']) {
  assert.equal(
    viewModel.buildTogetherListeningActivityCardViewModel(
      durationMetadata(phase, null, null),
    ).durationText,
    null,
  );
}

// 旧 Together metadata 没有 lifecycle timestamp：仍必须正常解析、正常展示、无 duration 行。
const legacyEndedMetadata = {
  type: 'togetherListening',
  activityId: 'activity-legacy',
  initiator: 'user',
  phase: 'ended',
  endReason: 'user_left',
  source: 'togetherListening',
};
assert.equal(
  metadataModule.isTogetherListeningMessageMetadata(legacyEndedMetadata),
  true,
  '缺少 lifecycle timestamp 的旧卡不得因为升级消失',
);
const legacyCard = viewModel.buildTogetherListeningActivityCardViewModel(legacyEndedMetadata);
assert.equal(legacyCard.durationText, null);
assert.equal(legacyCard.title, '🎧 一起听已结束');
assert.equal(legacyCard.body, '你已退出一起听');
assert.equal(
  metadataModule.isTogetherListeningMessageMetadata({
    ...legacyEndedMetadata,
    activatedAtEpochMs: '1000',
  }),
  false,
);
assert.equal(
  metadataModule.isTogetherListeningMessageMetadata({
    ...legacyEndedMetadata,
    endedAtEpochMs: Number.NaN,
  }),
  false,
);

// 群邀请沿用卡片投影；当前群归属与终止资格由群任务 owner 保证。
globalThis.__listenCardGroup = { group: { id: 'group-target', name: '群' }, members: [{ aiAssistantId: 'host-ai', agentId: 'host-agent', name: '公开名字' }] };
globalThis.__listenCardGroupCurrent = true;
const groupActivity = { id: 'group-invite', chatSessionId: 'group-target', hostAiId: 'host-ai', initiator: 'ai',
  phase: 'pending_user_response', createdAtEpochMs: 1_000, updatedAtEpochMs: 1_000, endReason: null, activatedAtEpochMs: null, endedAtEpochMs: null };
const groupCard = await timeline.upsertTogetherListeningTimelineEntry(groupActivity, { groupSpeechTaskId: 'group-task', timelineRunId: 'group-task' });
assert.equal(groupCard.message.sessionId, 'group-target');
assert.equal(groupCard.message.agentId, 'host-agent');
assert.equal(JSON.parse(groupCard.message.metadataJson).actorName, '公开名字');
assert.equal(globalThis.__listenCardGroupPreview[0], 'group-target');
globalThis.__listenCardGroupCurrent = false;
await assert.rejects(timeline.upsertTogetherListeningTimelineEntry({ ...groupActivity, id: 'canceled-invite' }, { groupSpeechTaskId: 'group-task' }));
assert.equal(rows.has('together-listening:canceled-invite'), false);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('LISTEN-4 Chat 卡片 metadata、稳定 timeline identity、preview 与展示矩阵检查通过。');
