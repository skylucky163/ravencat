import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, Module } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMAS, bootstrapSqlite, createSqliteExecutor } from './helpers/sqlite-bootstrap-fixture.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calls-runtime-contracts-'));

function compileProductionModule(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.equal(
    errors.length,
    0,
    `TypeScript 转译失败：${relativePath}\n${errors.map(formatDiagnostic).join('\n')}`
  );

  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function writeRuntimeModule(relativePath, source) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, 'utf8');
}

function loadCompiled(relativePath) {
  return require(path.join(tempRoot, relativePath.replace(/\.ts$/, '.js')));
}

writeRuntimeModule('node_modules/@shared/runtime/RuntimeSlot.js', `
exports.createRuntimeSlot = (name) => {
  let value = null;
  return {
    configure(nextValue) { value = nextValue; },
    get() {
      if (value === null) throw new Error(name + ' 运行时依赖尚未完成装配');
      return value;
    },
  };
};
`);

compileProductionModule('src/shared/runtime/abortSignal.ts');
writeRuntimeModule('node_modules/@shared/runtime/abortSignal.js', `
module.exports = require('../../../src/shared/runtime/abortSignal.js');
`);

writeRuntimeModule('node_modules/@shared/aiTools/index.js', `
exports.ToolContext = class ToolContext {
  constructor(params) {
    Object.assign(this, params);
  }
};
`);

writeRuntimeModule('node_modules/@shared/prompt/index.js', `
exports.DEFAULT_PRIVATE_CONTEXT_PRIMARY_LIMIT = 30;
`);

compileProductionModule('src/features/speech/application/SpeechText.ts');
compileProductionModule('src/features/speech/application/SpeechProviderCatalog.ts');
compileProductionModule('src/features/chat/messages/infrastructure/ChatMessageMutationSql.ts');
compileProductionModule('src/features/chat/reply/infrastructure/ChatTurnPresentationSql.ts');
compileProductionModule('src/features/chat/reply/infrastructure/ChatReplyVersionSql.ts');

for (const relativePath of [
  'src/features/calls/application/CallPromptBlocks.ts',
  'src/features/calls/domain/CallHistory.ts',
  'src/features/calls/infrastructure/SQLiteCallHistoryRepository.ts',
  'src/features/calls/application/CallPromptDefinitions.ts',
  'src/features/calls/application/runtime/CallRuntimeDependencies.ts',
  'src/features/calls/application/runtime/CallRuntimeHelpers.ts',
  'src/features/calls/application/runtime/CallReplyRunState.ts',
  'src/features/calls/application/runtime/AICallRuntimeService.ts',
  'src/features/calls/application/runtime/CallMediaSession.ts',
  'src/features/calls/application/runtime/CallMediaRuntimeRegistry.ts',
  'src/features/calls/application/runtime/CallFailureRecorder.ts',
  'src/features/calls/application/runtime/CallMessageWriter.ts',
  'src/features/calls/application/runtime/CallPreflight.ts',
  'src/features/calls/application/runtime/OutgoingCallDecision.ts',
  'src/features/calls/application/runtime/OutgoingCallDecisionParser.ts',
  'src/features/calls/application/runtime/PostUserHangUpFollowUp.ts',
  'src/features/calls/application/runtime/ReconcileInterruptedCall.ts',
  'src/features/calls/application/runtime/CallSpeechDuplexGuard.ts',
  'src/features/calls/application/runtime/CallSpeechSentenceStream.ts',
  'src/features/calls/application/runtime/CallTTSPlaybackQueue.ts',
  'src/features/calls/application/runtime/RunCallTurn.ts',
  'src/features/calls/application/events/AppendCallCameraStateEvent.ts',
  'src/features/calls/application/events/AppendCallSystemEvent.ts',
  'src/features/calls/application/events/AppendCallTranscriptEvent.ts',
  'src/features/calls/application/events/CallTranscriptFacts.ts',
  'src/features/calls/application/events/CreateCallStatusMessage.ts',
  'src/features/calls/application/snapshots/AttachCallSnapshot.ts',
  'src/features/calls/application/snapshots/CallSnapshotLifetime.ts',
  'src/features/calls/application/queries/CallScreenRestore.ts',
  'src/features/calls/domain/CallRepository.ts',
  'src/features/calls/infrastructure/SQLiteCallRepository.ts',
  'src/features/chat/messages/events/ChatEvents.ts',
  'src/features/chat/messages/application/ChatMessageRuntime.ts',
  'src/features/chat/messages/application/UpsertStatefulTimelineEntry.ts',
  'src/features/chat/messages/application/UpsertCallTimelineEntry.ts',
  'src/features/chat/reply/delivery/AIMessageEvents.ts',
  'src/features/chat/messages/application/MessagePersistence.ts',
  'src/features/chat/messages/domain/ChatMessage.ts',
  'src/features/chat/messages/domain/ChatSticker.ts',
  'src/features/chat/messages/domain/SharedMoment.ts',
  'src/features/chat/messages/domain/SharedChatRecord.ts',
  'src/features/chat/messages/domain/MessageRepository.ts',
  'src/features/chat/messages/domain/MessageTimeSeparator.ts',
  'src/features/chat/messages/domain/chatMessageMetadata.ts',
  'src/features/chat/messages/infrastructure/ChatTimelineSql.ts',
  'src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts',
]) {
  compileProductionModule(relativePath);
}

writeRuntimeModule('node_modules/@platform/device/index.js', `
const runtime = () => globalThis.__callsContractFakes;
exports.requestNotificationPermission = (...args) => runtime().requestNotificationPermission(...args);
exports.dismissAIIncomingCallNotification = (...args) => runtime().dismissAIIncomingCallNotification(...args);
exports.sendAIIncomingCallNotification = (...args) => runtime().sendAIIncomingCallNotification(...args);
exports.temporarySpeechAudioStore = {
  deleteIfExists: (...args) => runtime().temporarySpeechAudioStore.deleteIfExists(...args),
};
exports.createRandomUUID = () => 'current-runtime';
exports.getPersistentMediaCategoryPrefix = () => 'calls/snapshots/';
exports.PERSISTENT_MEDIA_CATEGORY = {
  callSnapshot: 'callSnapshot',
};
exports.persistentMediaStore = {
  persistMedia: (...args) => runtime().persistentMediaStore.persistMedia(...args),
  getInfo: (...args) => runtime().persistentMediaStore.getInfo(...args),
  deleteIfExists: (...args) => runtime().persistentMediaStore.deleteIfExists(...args),
  deleteCategoryFileIfExists: (...args) => runtime().persistentMediaStore.deleteIfExists(...args),
  deleteCategoryFilesExceptPrefix: async () => {},
};
`);

// 这些场景只替代媒体 IO；历史持久化与共享音频回收由 verify-call-history 覆盖。
writeRuntimeModule('src/features/calls/application/CallHistory.js', 'exports.saveCallHistoryAudio = async () => {}; exports.saveCallHistorySnapshot = async () => {};');

writeRuntimeModule('node_modules/@platform/persistence/index.js', `
const runtime = () => globalThis.__callsContractFakes;
Object.defineProperty(exports, 'databaseCoordinator', {
  enumerable: true,
  get: () => runtime().databaseCoordinator,
});
`);

writeRuntimeModule('node_modules/@platform/ai/index.js', `
const runtime = () => globalThis.__callsContractFakes;
exports.createAIClient = (...args) => runtime().createAIClient(...args);
exports.getErrorDisplayInfo = (...args) => runtime().getErrorDisplayInfo(...args);
`);

writeRuntimeModule('node_modules/@features/speech/index.js', `
const runtime = () => globalThis.__callsContractFakes;
exports.synthesizeTextToSpeech = (...args) => runtime().synthesizeTextToSpeech(...args);
Object.assign(exports, require('../../../src/features/speech/application/SpeechText.js'));
Object.assign(exports, require('../../../src/features/speech/application/SpeechProviderCatalog.js'));
`);

writeRuntimeModule('node_modules/@features/chat/index.js', `
const metadata = require('../../../src/features/chat/messages/domain/chatMessageMetadata.js');
const persistence = require('../../../src/features/chat/messages/application/MessagePersistence.js');
const runtime = () => globalThis.__callsContractFakes;
module.exports = {
  ...metadata,
  ...persistence,
  messageRepository: {},
  emitChatMessagesPatched: (...args) => runtime().emitChatMessagesPatched(...args),
  emitChatMessagesUpdated: (...args) => runtime().emitChatMessagesUpdated(...args),
  receiveExternalAIMessage: (...args) => runtime().receiveExternalAIMessage(...args),
};
`);

writeRuntimeModule('src/features/calls/application/runtime/ProcessCallAIReply.js', `
exports.processCallAIReply = (...args) => globalThis.__callsContractFakes.processCallAIReply(...args);
`);

writeRuntimeModule('src/features/calls/application/CallRingtoneSettings.js', `
exports.loadCallRingtoneUri = async () => null;
`);

const fakeRuntime = {};
globalThis.__callsContractFakes = fakeRuntime;

const callHelpers = loadCompiled(
  'src/features/calls/application/runtime/CallRuntimeHelpers.ts'
);
const { parseOutgoingCallDecision } = loadCompiled('src/features/calls/application/runtime/OutgoingCallDecisionParser.ts');
const { AICallRuntimeService, aiCallRuntimeService } = loadCompiled(
  'src/features/calls/application/runtime/AICallRuntimeService.ts'
);
const { registerCallMediaOwner, finishCallMediaSession } = loadCompiled(
  'src/features/calls/application/runtime/CallMediaSession.ts'
);
const { registerHostedCallMediaRuntime } = loadCompiled(
  'src/features/calls/application/runtime/CallMediaRuntimeRegistry.ts'
);
const { runCallPreflight } = loadCompiled(
  'src/features/calls/application/runtime/CallPreflight.ts'
);
const { CallTTSPlaybackQueue } = loadCompiled(
  'src/features/calls/application/runtime/CallTTSPlaybackQueue.ts'
);
const { CallSpeechDuplexGuard } = loadCompiled(
  'src/features/calls/application/runtime/CallSpeechDuplexGuard.ts'
);
const { createCallSpeechSentenceStream } = loadCompiled(
  'src/features/calls/application/runtime/CallSpeechSentenceStream.ts'
);
const callReplyRuns = loadCompiled(
  'src/features/calls/application/runtime/CallReplyRunState.ts'
);
const { configureCallRuntimeDependencies } = loadCompiled(
  'src/features/calls/application/runtime/CallRuntimeDependencies.ts'
);
const {
  handleUserEndedCallFollowUp,
  isEligibleForPostUserHangUpFollowUp,
  parsePostUserHangUpDecision,
} = loadCompiled('src/features/calls/application/runtime/PostUserHangUpFollowUp.ts');
const { reconcileInterruptedCallFromPreviousProcess } = loadCompiled(
  'src/features/calls/application/runtime/ReconcileInterruptedCall.ts'
);
const { CallTurnRuntimeService } = loadCompiled(
  'src/features/calls/application/runtime/RunCallTurn.ts'
);
const transcriptEvents = loadCompiled(
  'src/features/calls/application/events/AppendCallTranscriptEvent.ts'
);
const { appendCallCameraStateEvent } = loadCompiled(
  'src/features/calls/application/events/AppendCallCameraStateEvent.ts'
);
const { appendCallErrorEvent } = loadCompiled(
  'src/features/calls/application/events/AppendCallSystemEvent.ts'
);
const { saveCallStatusMessage } = loadCompiled(
  'src/features/calls/application/events/CreateCallStatusMessage.ts'
);
const { attachCallSnapshot } = loadCompiled(
  'src/features/calls/application/snapshots/AttachCallSnapshot.ts'
);
const { shouldRestoreCallScreen } = loadCompiled(
  'src/features/calls/application/queries/CallScreenRestore.ts'
);
const { SQLiteCallRepository } = loadCompiled(
  'src/features/calls/infrastructure/SQLiteCallRepository.ts'
);
const { MessageRepository } = loadCompiled(
  'src/features/chat/messages/infrastructure/SQLiteMessageRepository.ts'
);
const { configureChatMessageRuntime } = loadCompiled(
  'src/features/chat/messages/application/ChatMessageRuntime.ts'
);
const { upsertCallTimelineEntry } = loadCompiled(
  'src/features/chat/messages/application/UpsertCallTimelineEntry.ts'
);
const { subscribeAIMessageReceived } = loadCompiled(
  'src/features/chat/reply/delivery/AIMessageEvents.ts'
);
const { setChatEventBus } = loadCompiled(
  'src/features/chat/messages/events/ChatEvents.ts'
);
const chatMetadata = loadCompiled(
  'src/features/chat/messages/domain/chatMessageMetadata.ts'
);

configureCallRuntimeDependencies({
  chat: {
    upsertCallTimelineEntry: (...args) => fakeRuntime.chat.upsertCallTimelineEntry(...args),
    appendExternalAssistantMessage: (...args) => fakeRuntime.chat.appendExternalAssistantMessage(...args),
  },
  repositories: {
    calls: new Proxy({}, {
      get: (_target, property) => (...args) => fakeRuntime.callRepository[property](...args),
    }),
    promptHistory: new Proxy({}, {
      get: (_target, property) => (...args) => fakeRuntime.messageRepository[property](...args),
    }),
    protocol: null,
    moment: null,
    profile: {},
    ledger: null,
  },
  async assembleChatPromptPack() {
    if (fakeRuntime.assembleChatPromptPack) {
      return fakeRuntime.assembleChatPromptPack(...arguments);
    }
    throw new Error('本契约场景不应组装聊天 Prompt');
  },
  async assembleStandalonePromptPack() {
    if (fakeRuntime.assembleStandalonePromptPack) {
      return fakeRuntime.assembleStandalonePromptPack(...arguments);
    }
    throw new Error('本契约场景不应组装独立 Prompt');
  },
  async resolveAIConfig(aiId) {
    return fakeRuntime.resolveAIConfig ? fakeRuntime.resolveAIConfig(aiId) : null;
  },
  async resolveImageModelInput() {
    throw new Error('本契约场景不应解析图片输入');
  },
  native: {
    audioPlayback: {
      beginSession: (...args) => fakeRuntime.callAudioPlayback.beginSession(...args),
      endSession: (...args) => fakeRuntime.callAudioPlayback.endSession(...args),
      play: (...args) => fakeRuntime.callAudioPlayback.play(...args),
      stop: (...args) => fakeRuntime.callAudioPlayback.stop(...args),
      getRouteState: async () => null,
      subscribeRoute: () => () => {},
      selectRoute: async () => undefined,
    },
    requestCallCameraPermission: (...args) => fakeRuntime.requestCallCameraPermission(...args),
    execution: {
      async start() {},
      async isAlive(callId) { return fakeRuntime.nativeActiveCallId === callId; },
    },
  },
  onCallTerminated(call) {
    fakeRuntime.terminatedCalls.push(call);
    return fakeRuntime.onCallTerminated?.(call);
  },
});

function createCall(overrides = {}) {
  return {
    id: 'call-1',
    chatSessionId: 'session-1',
    aiAssistantId: 'assistant-1',
    agentId: 'agent-1',
    direction: 'outgoing',
    state: 'active',
    requestedMode: 'video',
    activeMode: 'video',
    source: 'user',
    sourceToolCallId: null,
    openingLine: null,
    reason: null,
    aiRejectionReason: null,
    startedAt: '2026-07-14T00:00:05.000Z',
    acceptedAt: '2026-07-14T00:00:10.000Z',
    endedAt: '2026-07-14T00:00:20.000Z',
    endReason: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:20.000Z',
    ...overrides,
  };
}

// P0 双 incoming surface 收口：RN CallScreen 恢复语义由 Calls 层唯一判定。
// incoming requested/ringing 由原生来电 surface（CallStyle / IncomingCallActivity）独占，
for (const direction of ['incoming', 'outgoing']) {
  for (const state of ['ended', 'missed', 'rejected', 'failed']) {
    assert.equal(shouldRestoreCallScreen(createCall({ direction, state })), false,
      `${direction} ${state} 不得恢复已失去媒体 runtime 的通话页`);
  }
}

// Host 不得自动打开 RN 通话页；只有 acceptCall() 进入 active 后才恢复。
assert.equal(
  shouldRestoreCallScreen(createCall({ direction: 'incoming', state: 'requested' })),
  false,
  'incoming requested 不得自动恢复 RN CallScreen（原生来电 surface 独占）'
);
assert.equal(
  shouldRestoreCallScreen(createCall({ direction: 'incoming', state: 'ringing' })),
  false,
  'incoming ringing 不得自动恢复 RN CallScreen（原生来电 surface 独占）'
);
assert.equal(
  shouldRestoreCallScreen(createCall({ direction: 'incoming', state: 'active' })),
  true,
  'native accept 使 call 进入 active 后必须恢复 RN active call screen'
);
for (const state of ['requested', 'ringing', 'dialing', 'connecting', 'active']) {
  assert.equal(
    shouldRestoreCallScreen(createCall({ direction: 'outgoing', state })),
    true,
    `outgoing ${state} 的 RN CallScreen 恢复行为不得回归`
  );
}
for (const state of ['dialing', 'connecting']) {
  assert.equal(
    shouldRestoreCallScreen(createCall({ direction: 'incoming', state })),
    true,
    `incoming ${state} 维持原有恢复行为`
  );
}

function createAIConfig(overrides = {}) {
  return {
    id: 'assistant-1',
    agentId: 'agent-1',
    name: 'Kimi',
    model: 'model-1',
    apiKey: 'key-1',
    apiBaseUrl: 'https://example.test',
    ...overrides,
  };
}

function createCallRepository(calls = [createCall()]) {
  const sessions = new Map(calls.map((call) => [call.id, call]));
  const eventInputs = [];
  const snapshotInputs = [];
  const events = [];
  const repository = {
    appendFailuresRemaining: 0,
    appendFailure: new Error('Calls 仓储写入失败'),
    eventInputs,
    snapshotInputs,
    snapshotFailure: null,
    events,
    sessions,
    sessionUpdates: [],
    async createSession(input) {
      const call = createCall({ ...input, acceptedAt: null, endedAt: null, endReason: null });
      sessions.set(call.id, call);
      return call;
    },
    async createSessionIfIdle(input) {
      const activeStates = new Set(['requested', 'ringing', 'dialing', 'connecting', 'active', 'ending']);
      if ([...sessions.values()].some((call) => activeStates.has(call.state))) return null;
      return repository.createSession(input);
    },
    async getSessionById(callId) {
      return sessions.get(callId) || null;
    },
    async getActiveSession() {
      const activeStates = new Set([
        'requested',
        'ringing',
        'dialing',
        'connecting',
        'active',
        'ending',
      ]);
      return [...sessions.values()]
        .filter((call) => activeStates.has(call.state))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
    },
    async listEvents({ callId, limit = 100 }) {
      return events
        .filter((event) => event.callId === callId)
        .slice(-limit);
    },
    async appendEvent(input) {
      eventInputs.push(input);
      if (repository.appendFailuresRemaining > 0) {
        repository.appendFailuresRemaining -= 1;
        throw repository.appendFailure;
      }
      const event = {
        id: input.id || `event-${events.length + 1}`,
        callId: input.callId,
        chatSessionId: input.chatSessionId,
        kind: input.kind,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        text: input.text ?? null,
        attachmentId: input.attachmentId ?? null,
        visibleInChat: input.visibleInChat ?? false,
        includeInAIContext: input.includeInAIContext ?? false,
        payloadJson: input.payloadJson ?? null,
        createdAt: input.createdAt || '2026-07-14T00:00:00.000Z',
      };
      events.push(event);
      return event;
    },
    async appendHistoryEntry() {},
    async appendSnapshot(input) {
      snapshotInputs.push(input);
      if (repository.snapshotFailure) {
        throw repository.snapshotFailure;
      }
      const event = {
        id: input.event.id || `event-${events.length + 1}`,
        callId: input.callId,
        chatSessionId: input.chatSessionId,
        kind: input.event.kind,
        actorType: input.event.actorType,
        actorId: input.event.actorId ?? null,
        text: input.event.text ?? null,
        attachmentId: input.attachment.id || null,
        visibleInChat: input.event.visibleInChat ?? false,
        includeInAIContext: input.event.includeInAIContext ?? false,
        payloadJson: input.event.payloadJson ?? null,
        createdAt: input.event.createdAt || '2026-07-14T00:00:00.000Z',
      };
      const attachment = {
        id: input.attachment.id || `attachment-${events.length + 1}`,
        callId: input.callId,
        eventId: event.id,
        kind: input.attachment.kind,
        localUri: input.attachment.localUri ?? null,
        mimeType: input.attachment.mimeType ?? null,
        width: input.attachment.width ?? null,
        height: input.attachment.height ?? null,
        sizeBytes: input.attachment.sizeBytes ?? null,
        createdAt: input.attachment.createdAt || event.createdAt,
      };
      events.push(event);
      return { event, attachment };
    },
    async updateSession(callId, patch) {
      const current = sessions.get(callId);
      if (!current) {
        throw new Error(`Call ${callId} not found`);
      }
      const updated = {
        ...current,
        ...patch,
        updatedAt: '2026-07-14T00:01:00.000Z',
      };
      repository.sessionUpdates.push({ callId, patch });
      sessions.set(callId, updated);
      return updated;
    },
    async listSnapshotFiles() { return []; },
    async clearSnapshotFile() {},
    async updateSessionIfState(callId, expectedStates, patch) {
      const current = sessions.get(callId);
      if (!current || !expectedStates.includes(current.state)) {
        return null;
      }
      return repository.updateSession(callId, patch);
    },
  };
  return repository;
}

function createStrictSnapshotDatabase() {
  let committedEvents = new Map();
  let committedAttachments = new Map();
  let transactionCount = 0;
  const databaseCoordinator = {
    failAttachmentInsert: null,
    async transaction(meta, task) {
      transactionCount += 1;
      const transactionEvents = new Map(committedEvents);
      const transactionAttachments = new Map(committedAttachments);
      const tx = {
        async runAsync(source, params = []) {
          if (/INSERT INTO call_events/.test(source)) {
            transactionEvents.set(params[0], {
              id: params[0],
              call_id: params[1],
              chat_session_id: params[2],
              kind: params[3],
              actor_type: params[4],
              actor_id: params[5],
              text: params[6],
              attachment_id: params[7],
              visible_in_chat: params[8],
              include_in_ai_context: params[9],
              payload_json: params[10],
              created_at: params[11],
            });
            return { changes: 1, lastInsertRowId: 0 };
          }
          if (/INSERT INTO call_attachments/.test(source)) {
            // 模拟数据库的附件 → 事件外键，而非断言 SQL 调用的文本顺序。
            assert.ok(transactionEvents.has(params[2]), '附件必须关联已存在的事件');
            if (databaseCoordinator.failAttachmentInsert) {
              throw databaseCoordinator.failAttachmentInsert;
            }
            transactionAttachments.set(params[0], {
              id: params[0],
              call_id: params[1],
              event_id: params[2],
              kind: params[3],
              local_uri: params[4],
              mime_type: params[5],
              width: params[6],
              height: params[7],
              size_bytes: params[8],
              created_at: params[9],
            });
            return { changes: 1, lastInsertRowId: 0 };
          }
          throw new Error(`严格事务 fake 遇到未声明 SQL: ${source}`);
        },
        async getFirstAsync(source, params = []) {
          if (/FROM call_sessions/.test(source)) return { state: 'active' };
          if (/FROM call_events/.test(source)) {
            return transactionEvents.get(params[0]) || null;
          }
          if (/FROM call_attachments/.test(source)) {
            return transactionAttachments.get(params[0]) || null;
          }
          throw new Error(`严格事务 fake 遇到未声明查询: ${source}`);
        },
        async getAllAsync() {
          throw new Error('快照事务不应执行无界查询');
        },
        async execAsync(source) {
          throw new Error(`快照事务不应执行 execAsync: ${source}`);
        },
      };
      const result = await task(tx);
      committedEvents = transactionEvents;
      committedAttachments = transactionAttachments;
      return result;
    },
  };
  return {
    databaseCoordinator,
    get transactionCount() {
      return transactionCount;
    },
    get committedEvents() {
      return committedEvents;
    },
    get committedAttachments() {
      return committedAttachments;
    },
  };
}

function createStrictMessageDatabase() {
  let committedMessages = new Map();
  let committedSessions = new Map([
    ['session-1', {
      last_message: null,
      last_time: null,
      updated_at: null,
    }],
  ]);
  let nextId = 1;
  let transactionCount = 0;
  const operations = [];
  const databaseCoordinator = {
    failPreviewUpdate: null,
    openTaskExecutor(meta) {
      operations.push({ kind: 'open', meta });
      return {
        async withExclusiveTransactionAsync(task) {
          transactionCount += 1;
          operations.push({ kind: 'transaction', meta });
          const transactionMessages = new Map(
            Array.from(committedMessages, ([id, row]) => [id, { ...row }]),
          );
          const transactionSessions = new Map(
            Array.from(committedSessions, ([id, row]) => [id, { ...row }]),
          );
          const transaction = {
            async runAsync(source, params = []) {
              operations.push({ kind: 'run', source, params });
              // 本 fixture 没有回复候选；通话状态写入经过候选锁定 SQL 时没有匹配行。
              if (/^UPDATE chat_reply_version_sets/.test(source)) {
                return { changes: 0, lastInsertRowId: 0 };
              }
              if (/^INSERT INTO messages/.test(source)) {
                const id = nextId++;
                transactionMessages.set(id, {
                  id,
                  session_id: params[0],
                  agent_id: params[1],
                  client_message_id: params[2],
                  text: params[3],
                  is_me: params[4],
                  sender_type: params[5],
                  api_message_id: params[6],
                  time: params[7],
                  created_at: params[8],
                  show_time_separator_before: params[9],
                  updated_at: params[10],
                  reply_to_id: params[11],
                  reply_to_text: params[12],
                  logical_message_id: params[13],
                  segment_index: params[14],
                  segment_total: params[15],
                  delivery_status: params[16],
                  status: params[17],
                  tokens_used: params[18],
                  prompt_tokens: params[19],
                  completion_tokens: params[20],
                  metadata_json: params[21],
                  is_read: params[22],
                  turn_run_id: params[23],
                });
                return { changes: 1, lastInsertRowId: id };
              }
              if (/^UPDATE messages/.test(source)) {
                const id = params[params.length - 1];
                const row = transactionMessages.get(id);
                if (!row) {
                  return { changes: 0, lastInsertRowId: 0 };
                }
                row.text = params[0];
                row.metadata_json = params[1];
                row.is_read = params[2];
                row.updated_at = params[3];
                return { changes: 1, lastInsertRowId: 0 };
              }
              if (/^UPDATE sessions/.test(source)) {
                if (databaseCoordinator.failPreviewUpdate) {
                  throw databaseCoordinator.failPreviewUpdate;
                }
                const sessionId = params[3];
                const session = transactionSessions.get(sessionId) || {};
                transactionSessions.set(sessionId, {
                  ...session,
                  last_message: params[0],
                  last_time: params[1],
                  updated_at: params[2],
                });
                return { changes: 1, lastInsertRowId: 0 };
              }
              throw new Error(`严格消息事务 fake 遇到未声明 SQL: ${source}`);
            },
            async getFirstAsync(source, params = []) {
              operations.push({ kind: 'read', source, params });
              if (source.includes('FROM chat_regeneration_requests')) return null;
              if (source.includes('client_message_id')) {
                const row = Array.from(transactionMessages.values()).find((item) => (
                  item.session_id === params[0] && item.client_message_id === params[1]
                ));
                return row ? { ...row } : null;
              }
              if (source.includes('WHERE id = ?')) {
                const row = transactionMessages.get(params[0]);
                return row ? { ...row } : null;
              }
              if (source.includes('SELECT id, created_at FROM messages')) {
                const row = Array.from(transactionMessages.values())
                  .filter((item) => item.session_id === params[0])
                  .sort((left, right) => (
                    right.created_at.localeCompare(left.created_at) || right.id - left.id
                  ))[0];
                return row ? { id: row.id, created_at: row.created_at } : null;
              }
              if (source.includes('FROM messages')) {
                const row = Array.from(transactionMessages.values())
                  .filter((item) => item.session_id === params[0])
                  .sort((left, right) => (
                    right.created_at.localeCompare(left.created_at) || right.id - left.id
                  ))[0];
                return row ? { ...row } : null;
              }
              throw new Error(`严格消息事务 fake 遇到未声明查询: ${source}`);
            },
          };
          try {
            const result = await task(transaction);
            committedMessages = transactionMessages;
            committedSessions = transactionSessions;
            return result;
          } catch (error) {
            throw error;
          }
        },
      };
    },
  };
  return {
    databaseCoordinator,
    operations,
    get transactionCount() {
      return transactionCount;
    },
    get messages() {
      return committedMessages;
    },
    get sessions() {
      return committedSessions;
    },
  };
}

function createMessageRepository(options = {}) {
  const insertedInputs = [];
  const previews = [];
  const messages = [];
  let nextId = 1;
  return {
    insertedInputs,
    messages,
    previews,
    async getMessageById(messageId) {
      return messages.find((message) => message.id === messageId) || null;
    },
    async getMessageByClientMessageId(sessionId, clientMessageId) {
      return messages.find((message) => (
        message.sessionId === sessionId && message.clientMessageId === clientMessageId
      )) || null;
    },
    async getLatestMessage() {
      return messages.at(-1) || null;
    },
    async insertMessage(input) {
      insertedInputs.push(input);
      if (options.insertError) {
        throw options.insertError;
      }
      const message = {
        id: nextId++,
        showTimeSeparatorBefore: input.showTimeSeparatorBefore ?? true,
        isRead: input.isRead ?? false,
        status: input.status || 'sent',
        ...input,
      };
      messages.push(message);
      return message;
    },
    // 与真实仓库的统一提交协议对齐：插入与 preview 在同一“事务”内完成。
    async commitMessage({ message: input, previewText }) {
      insertedInputs.push(input);
      if (options.insertError) {
        throw options.insertError;
      }
      const inserted = {
        id: nextId++,
        showTimeSeparatorBefore: input.showTimeSeparatorBefore ?? true,
        isRead: input.isRead ?? false,
        status: input.status || 'sent',
        ...input,
      };
      messages.push(inserted);
      previews.push({ sessionId: input.sessionId, messageId: inserted.id, text: previewText });
      if (options.previewError) {
        throw options.previewError;
      }
      return inserted;
    },
    async upsertStatefulTimelineEntry({ message: input, previewText }) {
      const existingIndex = messages.findIndex((message) => (
        message.sessionId === input.sessionId
        && message.clientMessageId === input.clientMessageId
      ));
      const snapshotMessages = messages.map((message) => ({ ...message }));
      const snapshotPreviews = previews.slice();
      try {
        if (existingIndex >= 0) {
          const existing = messages[existingIndex];
          messages[existingIndex] = {
            ...existing,
            text: input.text,
            metadataJson: input.metadataJson ?? null,
            isRead: input.isRead ?? false,
            updatedAt: '2026-07-14T08:31:00.000Z',
          };
          if (options.previewError) {
            throw options.previewError;
          }
          previews.push({
            sessionId: input.sessionId,
            messageId: existing.id,
            text: previewText,
          });
          return { message: messages[existingIndex], inserted: false };
        }

        if (options.insertError) {
          throw options.insertError;
        }
        const inserted = {
          id: nextId++,
          showTimeSeparatorBefore: input.showTimeSeparatorBefore ?? true,
          isRead: input.isRead ?? false,
          status: input.status || 'sent',
          ...input,
        };
        messages.push(inserted);
        insertedInputs.push(input);
        if (options.previewError) {
          throw options.previewError;
        }
        previews.push({ sessionId: input.sessionId, messageId: inserted.id, text: previewText });
        return { message: inserted, inserted: true };
      } catch (error) {
        messages.splice(0, messages.length, ...snapshotMessages);
        previews.splice(0, previews.length, ...snapshotPreviews);
        throw error;
      }
    },
    async updateMessage(messageId, updates) {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return false;
      messages[index] = {
        ...messages[index],
        ...updates,
        updatedAt: '2026-07-14T08:31:00.000Z',
      };
      return true;
    },
    async updateSessionPreview(sessionId, text, time) {
      previews.push({ sessionId, text, time });
      if (options.previewError) {
        throw options.previewError;
      }
      return true;
    },
    async updateSessionPreviewForCommittedMessage({ sessionId, messageId, previewText }) {
      previews.push({ sessionId, messageId, text: previewText });
      if (options.previewError) {
        throw options.previewError;
      }
      return true;
    },
    async getMessagesByLogicalMessageId() {
      return [];
    },
  };
}

function createChatWritePort(repository) {
  return {
    async upsertCallTimelineEntry(params) {
      const createdDate = params.createdAt ? new Date(params.createdAt) : new Date();
      const metadata = chatMetadata.buildCallStatusMessageMetadata({
        callId: params.callId,
        callStatus: params.callStatus,
        direction: params.direction,
        actor: params.actor,
        endReason: params.endReason,
        durationSeconds: params.durationSeconds,
        displayText: params.displayText,
        aiContextText: params.aiContextText,
      });
      const sender = chatMetadata.getCallStatusMessageSender({ direction: params.direction, callStatus: params.callStatus });
      const result = await repository.upsertStatefulTimelineEntry({
        message: {
          sessionId: params.sessionId,
          text: metadata.displayText,
          isMe: sender.isMe,
          senderType: sender.senderType,
          agentId: sender.senderType === 'assistant' ? params.agentId || null : null,
          apiMessageId: null,
          clientMessageId: `call-status:${params.callId}`,
          time: `${String(createdDate.getHours()).padStart(2, '0')}:${String(createdDate.getMinutes()).padStart(2, '0')}`,
          createdAt: createdDate.toISOString(),
          updatedAt: createdDate.toISOString(),
          replyToId: null,
          replyToText: null,
          status: 'sent',
          deliveryStatus: 'delivered',
          tokensUsed: 0,
          promptTokens: 0,
          completionTokens: 0,
          metadataJson: JSON.stringify(metadata),
          isRead: params.isRead,
        },
        previewText: metadata.displayText,
      });
      if (result.inserted) {
        fakeRuntime.emitChatMessagesUpdated?.(params.sessionId);
      } else {
        fakeRuntime.emitChatMessagesPatched?.({
          sessionId: params.sessionId,
          updatedMessageIds: [result.message.id],
        });
      }
      return result;
    },
    async appendExternalAssistantMessage(params) {
      const now = new Date().toISOString();
      const message = await repository.commitMessage({
        message: {
          sessionId: params.sessionId,
          text: params.text,
          isMe: false,
          senderType: 'assistant',
          agentId: params.agentId || null,
          apiMessageId: params.apiMessageId || null,
          clientMessageId: params.clientMessageId || null,
          time: '08:30',
          createdAt: now,
          updatedAt: now,
          replyToId: null,
          replyToText: null,
          status: 'sent',
          tokensUsed: 0,
          promptTokens: 0,
          completionTokens: 0,
          metadataJson: JSON.stringify(params.metadata || null),
        },
        previewText: params.text,
      });
      if (params.delivery !== 'none') {
        fakeRuntime.aiMessageReceived.push({
          aiId: params.aiId,
          agentId: params.agentId,
          aiName: params.aiName,
          sessionId: params.sessionId,
          message: params.text,
          committedMessageId: message.id,
          deliveryKind: params.deliveryKind,
          triggerSource: params.triggerSource,
        });
      }
      return { message, committedMessageId: message.id, deliveryReceipt: null };
    },
  };
}

function resetRuntime(callRepository = createCallRepository()) {
  const deletedAudioUris = [];
  const persistedMediaUris = [];
  const deletedMediaUris = [];
  const patchedNotifications = [];
  const playedAudioUris = [];
  const startedAudioCalls = [];
  const endedAudioCalls = [];
  const uiNotifications = [];
  const terminatedCalls = [];
  const aiMessageReceived = [];
  fakeRuntime.callRepository = callRepository;
  fakeRuntime.nativeActiveCallId = null;
  fakeRuntime.messageRepository = createMessageRepository();
  fakeRuntime.chat = createChatWritePort(fakeRuntime.messageRepository);
  fakeRuntime.terminatedCalls = terminatedCalls;
  fakeRuntime.onCallTerminated = null;
  fakeRuntime.notificationGranted = true;
  fakeRuntime.cameraPermission = { granted: true, canAskAgain: true, status: 'granted' };
  fakeRuntime.requestNotificationPermission = async () => fakeRuntime.notificationGranted;
  fakeRuntime.requestCallCameraPermission = async () => fakeRuntime.cameraPermission;
  fakeRuntime.dismissAIIncomingCallNotification = async () => undefined;
  fakeRuntime.sendAIIncomingCallNotification = async () => true;
  fakeRuntime.createAIClient = () => ({
    async chat() {
      throw new Error('本契约场景不应访问真实 AI');
    },
  });
  fakeRuntime.resolveAIConfig = async () => null;
  fakeRuntime.assembleStandalonePromptPack = null;
  fakeRuntime.assembleChatPromptPack = null;
  fakeRuntime.aiMessageReceived = aiMessageReceived;
  fakeRuntime.receiveExternalAIMessage = async (params, deps = {}) => {
    const repository = deps.repository || fakeRuntime.messageRepository;
    const now = new Date().toISOString();
    const insertedMessage = await repository.commitMessage({
      message: {
        sessionId: params.sessionId,
        text: params.text,
        isMe: false,
        senderType: 'assistant',
        agentId: params.agentId || null,
        apiMessageId: params.apiMessageId || null,
        clientMessageId: params.clientMessageId || null,
        time: '08:30',
        createdAt: now,
        updatedAt: now,
        replyToId: null,
        replyToText: null,
        status: 'sent',
        tokensUsed: params.tokensUsed || 0,
        promptTokens: params.promptTokens || 0,
        completionTokens: params.completionTokens || 0,
        metadataJson: null,
      },
      previewText: params.text,
    });
    aiMessageReceived.push({
      aiId: params.aiId,
      agentId: params.agentId,
      aiName: params.aiName,
      sessionId: params.sessionId,
      message: params.text,
      committedMessageId: insertedMessage.id,
      deliveryKind: params.deliveryKind,
      triggerSource: params.triggerSource,
    });
    return { success: true, message: insertedMessage, error: null };
  };
  fakeRuntime.getErrorDisplayInfo = (error) => ({ message: error.message });
  fakeRuntime.synthesizeTextToSpeech = async ({ text }) => ({
    success: true,
    audioUri: `file:///${text}.mp3`,
    mimeType: 'audio/mpeg',
    modelConfigId: 'tts-1',
    modelConfigName: 'TTS',
    model: 'tts-model',
  });
  fakeRuntime.callAudioPlayback = {
    async beginSession(callId) { startedAudioCalls.push(callId); },
    async endSession(callId) { endedAudioCalls.push(callId); },
    async play(uri) {
      playedAudioUris.push(uri);
      return {
        playbackId: `playback-${playedAudioUris.length}`,
        uri,
        finished: Promise.resolve(),
        async stop() {},
      };
    },
    async stop() {},
  };
  fakeRuntime.temporarySpeechAudioStore = {
    async deleteIfExists(uri) {
      if (uri) {
        deletedAudioUris.push(uri);
      }
    },
  };
  fakeRuntime.persistentMediaStore = {
    async persistMedia({ entityId }) {
      const uri = `file:///persisted/${entityId}.jpg`;
      persistedMediaUris.push(uri);
      return uri;
    },
    async getInfo(uri) {
      return {
        normalizedUri: uri,
        exists: true,
        isDirectory: false,
        uri,
        size: 123,
        modificationTime: null,
        md5: null,
      };
    },
    async deleteIfExists(uri) {
      deletedMediaUris.push(uri);
      if (fakeRuntime.persistentMediaStore.deleteFailure) {
        throw fakeRuntime.persistentMediaStore.deleteFailure;
      }
      return true;
    },
  };
  fakeRuntime.persistentMediaStore.deleteFailure = null;
  fakeRuntime.emitChatMessagesUpdated = (sessionId) => {
    uiNotifications.push(sessionId);
  };
  fakeRuntime.emitChatMessagesPatched = (payload) => {
    patchedNotifications.push(payload);
  };
  return {
    callRepository,
    deletedAudioUris,
    deletedMediaUris,
    persistedMediaUris,
    patchedNotifications,
    playedAudioUris,
    startedAudioCalls,
    endedAudioCalls,
    terminatedCalls,
    uiNotifications,
    aiMessageReceived,
  };
}

function createPreflightRepository(activeCall = null) {
  return {
    async getActiveSession() {
      return activeCall;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

const scenarios = [];

function scenario(name, execute) {
  scenarios.push({ name, execute });
}

scenario('用户主动挂断后的严格 JSON 决策契约', async () => {
  assert.deepEqual(
    parsePostUserHangUpDecision('{"decision":"send_message","message":"我还在。"}'),
    { decision: 'send_message', message: '我还在。' }
  );
  assert.deepEqual(
    parsePostUserHangUpDecision('{"decision":"stay_silent","message":null}'),
    { decision: 'stay_silent', message: null }
  );
  assert.throws(
    () => parsePostUserHangUpDecision('{"decision":"send_message","message":"  "}'),
    /message 必须为非空字符串/
  );
  assert.throws(
    () => parsePostUserHangUpDecision('{"decision":"stay_silent","message":""}'),
    /message 必须为 null/
  );
  assert.throws(
    () => parsePostUserHangUpDecision('{"decision":"send_message","message":"好","extra":1}'),
    /包含非契约字段/
  );
});

scenario('页面重新初始化保留仍由原生宿主持有的通话与快照', async () => {
  const call = createCall({ endedAt: null });
  const repository = createCallRepository([call]);
  const runtime = resetRuntime(repository);
  fakeRuntime.nativeActiveCallId = call.id;
  let snapshotReads = 0;
  repository.listSnapshotFiles = async () => { snapshotReads += 1; return []; };
  const started = await saveCallStatusMessage(fakeRuntime.chat, {
    sessionId: call.chatSessionId, callId: call.id, direction: call.direction,
    callStatus: 'callStarted', actor: 'user', agentId: call.agentId, isRead: true,
  });
  for (let remount = 0; remount < 2; remount += 1) {
    assert.equal(await reconcileInterruptedCallFromPreviousProcess(), null);
    assert.equal(aiCallRuntimeService.getActiveCallSnapshot().id, call.id, '恢复存活通话时补齐接通标记');
  }
  assert.equal((await repository.getSessionById(call.id)).state, 'active');
  assert.equal(snapshotReads, 0, '存活执行期不能当作上一进程删除摄像头快照');
  assert.deepEqual(repository.eventInputs, []);
  assert.deepEqual(runtime.terminatedCalls, []);
  assert.deepEqual(fakeRuntime.messageRepository.messages, [started], '不把通话中气泡改成故障');
});

scenario('冷启动只收口遗留通话并更新原状态气泡', async () => {
  const call = createCall({ state: 'active', source: 'user', endReason: null, endedAt: null });
  const callRepository = createCallRepository([call]);
  const runtime = resetRuntime(callRepository);
  fakeRuntime.nativeActiveCallId = 'another-call';
  const started = await saveCallStatusMessage(fakeRuntime.chat, {
    sessionId: call.chatSessionId,
    callId: call.id,
    direction: call.direction,
    callStatus: 'callStarted',
    actor: 'user',
    agentId: call.agentId,
    isRead: true,
  });

  const reconciled = await reconcileInterruptedCallFromPreviousProcess();
  assert.equal(reconciled.state, 'failed');
  assert.equal(aiCallRuntimeService.getActiveCallSnapshot(), null, '故障终态提交后释放接通标记');
  assert.equal(reconciled.endReason, 'runtimeError');
  assert.ok(reconciled.endedAt);
  assert.deepEqual(callRepository.eventInputs, [{
    callId: call.id,
    chatSessionId: call.chatSessionId,
    kind: 'stateChanged',
    actorType: 'system',
    text: '通话因系统故障中断。',
    visibleInChat: false,
    includeInAIContext: true,
    payloadJson: JSON.stringify({
      from: 'active',
      to: 'failed',
      endReason: 'runtimeError',
      recovery: 'previous_process_termination',
    }),
  }]);
  assert.equal(fakeRuntime.messageRepository.messages.length, 1);
  assert.equal(fakeRuntime.messageRepository.messages[0].id, started.id);
  assert.equal(fakeRuntime.messageRepository.messages[0].text, '【通话因系统故障中断】');
  assert.equal(
    JSON.parse(fakeRuntime.messageRepository.messages[0].metadataJson).callStatus,
    'callSystemError'
  );
  assert.deepEqual(runtime.terminatedCalls, [], '冷启动收口不得触发终态跟进监听');
});

scenario('冷启动保护响铃窗口内的 incoming ringing，pending accept 正常接通', async () => {
  // 原生 IncomingCallActivity 冷启动 accept：response 先持久化，MainActivity 启动后
  // reconcile 先跑、pending response 后消费；合法 ringing 不得在 accept 前被判 runtimeError。
  const ringingCall = createCall({
    direction: 'incoming',
    state: 'ringing',
    source: 'aiTool',
    acceptedAt: null,
    endedAt: null,
    endReason: null,
    startedAt: new Date().toISOString(),
  });
  const callRepository = createCallRepository([ringingCall]);
  resetRuntime(callRepository);
  const messageRepository = createMessageRepository();
  fakeRuntime.chat = createChatWritePort(messageRepository);

  const reconciled = await reconcileInterruptedCallFromPreviousProcess();
  assert.equal(reconciled, null, '响铃窗口内的 incoming ringing 不得按进程故障收口');
  assert.equal(callRepository.sessions.get(ringingCall.id).state, 'ringing');
  assert.equal(callRepository.eventInputs.length, 0, '恢复 ringing 不得写入 runtimeError 事件');

  const accepted = await aiCallRuntimeService.acceptCall(ringingCall.id);
  assert.equal(accepted.call.state, 'active', 'pending accept 必须进入现有 acceptCall() 并置 active');
  assert.ok(accepted.call.acceptedAt);
  assert.equal(accepted.visibleMessages.length, 1);
  assert.equal(messageRepository.insertedInputs.length, 1);
});

scenario('冷启动将过期 incoming ringing 按 missedByUser 收口，迟到 accept 不得复活', async () => {
  const expiredRingingCall = createCall({
    direction: 'incoming',
    state: 'ringing',
    source: 'aiTool',
    acceptedAt: null,
    endedAt: null,
    endReason: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const callRepository = createCallRepository([expiredRingingCall]);
  const runtime = resetRuntime(callRepository);
  const messageRepository = createMessageRepository();
  fakeRuntime.chat = createChatWritePort(messageRepository);

  const reconciled = await reconcileInterruptedCallFromPreviousProcess();
  assert.equal(reconciled, null, '过期未接不是系统故障中断，无需 Host 导航纠偏');
  const closed = callRepository.sessions.get(expiredRingingCall.id);
  assert.equal(closed.state, 'missed');
  assert.equal(closed.endReason, 'missedByUser');
  assert.ok(closed.endedAt);
  const missedEvent = callRepository.events.find((event) => event.kind === 'stateChanged');
  assert.ok(missedEvent, '过期收口必须写入 missed 状态事件');
  assert.equal(JSON.parse(missedEvent.payloadJson).endReason, 'missedByUser');
  assert.equal(messageRepository.messages.length, 1);
  assert.equal(
    JSON.parse(messageRepository.messages[0].metadataJson).callStatus,
    'callMissed',
    '过期收口必须复用正常未接的状态消息'
  );
  assert.equal(runtime.terminatedCalls.length, 1, '过期收口必须与计时器未接走同一条终态通知');

  const lateAccept = await aiCallRuntimeService.acceptCall(expiredRingingCall.id);
  assert.equal(lateAccept.call.state, 'missed', '迟到 accept 不得把 missed 通话复活');
  assert.deepEqual(lateAccept.visibleMessages, []);
  assert.equal(messageRepository.messages.length, 1, '迟到 accept 不得重复写状态消息');
});

scenario('用户挂断跟进严格限制资格并执行发送或静默', async () => {
  const connectedUserEnded = createCall({ state: 'ended', source: 'user', endReason: 'userEnded' });
  assert.equal(isEligibleForPostUserHangUpFollowUp(connectedUserEnded), true);
  assert.equal(
    isEligibleForPostUserHangUpFollowUp({
      ...connectedUserEnded,
      source: 'backgroundWake',
    }),
    false
  );
  assert.equal(
    isEligibleForPostUserHangUpFollowUp({
      ...connectedUserEnded,
      acceptedAt: null,
    }),
    false
  );
  assert.equal(
    isEligibleForPostUserHangUpFollowUp({
      ...connectedUserEnded,
      endReason: 'aiEnded',
    }),
    false
  );

  const callRepository = createCallRepository([connectedUserEnded]);
  resetRuntime(callRepository);
  await callRepository.appendEvent({
    callId: connectedUserEnded.id,
    chatSessionId: connectedUserEnded.chatSessionId,
    kind: 'userSpeechText',
    actorType: 'user',
    text: '刚才那件事让我很开心。',
    includeInAIContext: true,
  });
  const aiConfig = createAIConfig();
  fakeRuntime.resolveAIConfig = async () => aiConfig;
  fakeRuntime.assembleStandalonePromptPack = async (params) => {
    fakeRuntime.lastStandalonePromptParams = params;
    return {
      scenario: params.scenarioId,
      blocks: params.blocks,
      systemPrompt: 'follow-up-system',
      stableSystemPrompt: 'follow-up-system',
      dynamicSystemPrompt: '',
      outputRequirement: '',
      recentMessages: [],
      currentInput: { role: 'user', content: params.currentInput },
      modelMessages: [{ role: 'user', content: params.currentInput }],
      estimatedTokenCount: 1,
    };
  };
  fakeRuntime.createAIClient = () => ({
    async chat() {
      return {
        success: true,
        text: '{"decision":"send_message","message":"我还在，想继续聊时随时找我。"}',
      };
    },
  });

  await handleUserEndedCallFollowUp(connectedUserEnded);
  assert.equal(fakeRuntime.lastStandalonePromptParams.scenarioId, 'call.post_user_hangup');
  assert.match(fakeRuntime.lastStandalonePromptParams.currentInput, /刚才那件事让我很开心/);
  assert.equal(fakeRuntime.messageRepository.messages.length, 1);
  assert.equal(fakeRuntime.messageRepository.messages[0].text, '我还在，想继续聊时随时找我。');
  assert.deepEqual(fakeRuntime.aiMessageReceived, [{
    aiId: aiConfig.id,
    agentId: aiConfig.agentId,
    aiName: aiConfig.name,
    sessionId: connectedUserEnded.chatSessionId,
    message: '我还在，想继续聊时随时找我。',
    committedMessageId: fakeRuntime.messageRepository.messages[0].id,
    deliveryKind: 'proactive',
    triggerSource: 'call',
  }]);
  assert.equal(callRepository.events.at(-1).kind, 'systemNotice');
  assert.deepEqual(JSON.parse(callRepository.events.at(-1).payloadJson), {
    type: 'postUserHangUpDecision',
    decision: 'send_message',
  });

  const silentCall = createCall({
    id: 'call-silent',
    state: 'ended',
    source: 'user',
    endReason: 'userEnded',
  });
  const silentRepository = createCallRepository([silentCall]);
  resetRuntime(silentRepository);
  fakeRuntime.resolveAIConfig = async () => aiConfig;
  fakeRuntime.assembleStandalonePromptPack = async (params) => ({
    scenario: params.scenarioId,
    blocks: params.blocks,
    systemPrompt: 'follow-up-system',
    stableSystemPrompt: 'follow-up-system',
    dynamicSystemPrompt: '',
    outputRequirement: '',
    recentMessages: [],
    currentInput: { role: 'user', content: params.currentInput },
    modelMessages: [{ role: 'user', content: params.currentInput }],
    estimatedTokenCount: 1,
  });
  fakeRuntime.createAIClient = () => ({
    async chat() {
      return {
        success: true,
        text: '{"decision":"stay_silent","message":null}',
      };
    },
  });
  await handleUserEndedCallFollowUp(silentCall);
  assert.equal(fakeRuntime.messageRepository.messages.length, 0);
  assert.equal(silentRepository.events.at(-1).kind, 'systemNotice');
  assert.deepEqual(JSON.parse(silentRepository.events.at(-1).payloadJson), {
    type: 'postUserHangUpDecision',
    decision: 'stay_silent',
  });
});

scenario('挂断后的 AI 跟进等待与非法 JSON 不阻塞通话结束', async () => {
  const activeCall = createCall({ state: 'active', endedAt: null, endReason: null });
  const repository = createCallRepository([activeCall]);
  resetRuntime(repository);
  const response = deferred();
  const warnings = [];
  const originalWarn = console.warn;
  fakeRuntime.resolveAIConfig = async () => createAIConfig();
  fakeRuntime.assembleStandalonePromptPack = async (params) => ({
    systemPrompt: 'follow-up-system',
    modelMessages: [{ role: 'user', content: params.currentInput }],
  });
  fakeRuntime.createAIClient = () => ({ chat: () => response.promise });
  fakeRuntime.onCallTerminated = handleUserEndedCallFollowUp;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = await aiCallRuntimeService.endCall(activeCall.id, 'userEnded');
    assert.equal(result.call.state, 'ended', 'AI 尚未返回时挂断已完成');
    assert.equal(result.visibleMessages.length, 1);
    response.resolve({ success: true, text: '这是一段非 JSON 的回复' });
    await waitFor(() => warnings.some(([tag]) => tag === '[AICallRuntimeService] terminal call listener failed'), '非法跟进结果应报告失败');
    assert.equal(warnings.at(-1)[1].error, 'call.post_user_hangup 不是严格 JSON');
    assert.equal((await repository.getSessionById(activeCall.id)).state, 'ended');
    assert.equal(fakeRuntime.messageRepository.messages.length, 1, '非法输出不得提交为聊天消息');
  } finally {
    console.warn = originalWarn;
    fakeRuntime.onCallTerminated = null;
  }
});

scenario('快照事件与附件使用单一可回滚事务', async () => {
  const strictDatabase = createStrictSnapshotDatabase();
  fakeRuntime.databaseCoordinator = strictDatabase.databaseCoordinator;
  const repository = new SQLiteCallRepository();
  const first = await repository.appendSnapshot({
    callId: 'call-atomic-1',
    chatSessionId: 'session-atomic-1',
    event: {
      id: 'event-atomic-1',
      kind: 'snapshotAttached',
      actorType: 'system',
      text: '截图',
      visibleInChat: false,
      includeInAIContext: true,
    },
    attachment: {
      id: 'attachment-atomic-1',
      kind: 'snapshot',
      localUri: 'file:///snapshot-1.jpg',
      mimeType: 'image/jpeg',
      width: 320,
      height: 240,
      sizeBytes: 123,
    },
  });

  assert.equal(strictDatabase.transactionCount, 1);
  assert.equal(strictDatabase.committedEvents.size, 1);
  assert.equal(strictDatabase.committedAttachments.size, 1);
  assert.equal(first.event.attachmentId, 'attachment-atomic-1');
  assert.equal(first.attachment.eventId, 'event-atomic-1');

  const databaseFailure = new Error('附件事实写入失败');
  strictDatabase.databaseCoordinator.failAttachmentInsert = databaseFailure;
  await assert.rejects(
    () => repository.appendSnapshot({
      callId: 'call-atomic-2',
      chatSessionId: 'session-atomic-2',
      event: {
        id: 'event-atomic-2',
        kind: 'snapshotAttached',
        actorType: 'system',
      },
      attachment: {
        id: 'attachment-atomic-2',
        kind: 'snapshot',
        localUri: 'file:///snapshot-2.jpg',
      },
    }),
    (error) => error === databaseFailure
  );
  assert.equal(strictDatabase.transactionCount, 2);
  assert.equal(strictDatabase.committedEvents.has('event-atomic-2'), false);
  assert.equal(strictDatabase.committedAttachments.has('attachment-atomic-2'), false);
});

scenario('AttachCallSnapshot 只调用原子端口并补偿文件', async () => {
  const callRepository = createCallRepository();
  const { deletedMediaUris, persistedMediaUris } = resetRuntime(callRepository);
  const result = await attachCallSnapshot({
    callId: 'call-1',
    sourceUri: 'content://camera/frame',
    mimeType: 'image/jpeg',
    width: 640,
    height: 480,
    cameraFacing: 'back',
    reason: 'look_at_user',
  });

  assert.equal(callRepository.eventInputs.length, 0, '快照不得再走独立 appendEvent');
  assert.equal(callRepository.snapshotInputs.length, 1);
  const snapshotInput = callRepository.snapshotInputs[0];
  assert.equal(snapshotInput.callId, 'call-1');
  assert.equal(snapshotInput.chatSessionId, 'session-1');
  assert.equal(snapshotInput.event.kind, 'snapshotAttached');
  assert.equal(snapshotInput.attachment.eventId, undefined);
  assert.equal(result.event.attachmentId, snapshotInput.attachment.id);
  assert.equal(result.attachment.eventId, result.event.id);

  const databaseFailure = new Error('快照数据库写入失败');
  callRepository.snapshotFailure = databaseFailure;
  await assert.rejects(
    () => attachCallSnapshot({
      callId: 'call-1',
      sourceUri: 'content://camera/frame-2',
      reason: 'look_at_user',
    }),
    (error) => error === databaseFailure
  );
  assert.equal(persistedMediaUris.length, 2);
  assert.ok(deletedMediaUris.includes(persistedMediaUris[1]), '数据库失败必须删除本次新文件');

  const cleanupFailure = new Error('快照文件补偿删除失败');
  fakeRuntime.persistentMediaStore.deleteFailure = cleanupFailure;
  await assert.rejects(
    () => attachCallSnapshot({
      callId: 'call-1',
      sourceUri: 'content://camera/frame-3',
      reason: 'look_at_user',
    }),
    (error) => error === databaseFailure
  );
  assert.equal(persistedMediaUris.length, 3);
  assert.ok(
    deletedMediaUris.includes(persistedMediaUris[2]),
    '删除失败前也必须尝试补偿本次新文件'
  );

  const inactiveRepository = createCallRepository([createCall({ state: 'ending' })]);
  const inactiveMedia = resetRuntime(inactiveRepository);
  await assert.rejects(
    () => attachCallSnapshot({
      callId: 'call-1',
      sourceUri: 'content://camera/inactive',
      reason: 'look_at_user',
    }),
    { message: '当前通话不在接通状态，无法截取画面' }
  );
  assert.equal(inactiveMedia.persistedMediaUris.length, 0, '非 active 通话不得创建文件');
});

scenario('通话状态、挂断原因与计时', async () => {
  assert.equal(
    callHelpers.resolveUserHangUpReason(createCall({ direction: 'incoming', state: 'ringing' })),
    'userRejected'
  );
  assert.equal(
    callHelpers.resolveUserHangUpReason(createCall({ direction: 'incoming', state: 'active' })),
    'userEnded'
  );
  assert.equal(
    callHelpers.resolveUserHangUpReason(createCall({ direction: 'outgoing', state: 'ringing' })),
    'userEnded'
  );

  for (const state of ['requested', 'ringing', 'dialing', 'connecting', 'active', 'ending']) {
    assert.equal(callHelpers.shouldPollCall(createCall({ state })), true, `${state} 应继续轮询`);
  }
  for (const state of ['ended', 'missed', 'rejected', 'failed']) {
    assert.equal(callHelpers.shouldPollCall(createCall({ state })), false, `${state} 不应继续轮询`);
    assert.equal(callHelpers.isCallTerminalState(state), true, `${state} 应被识别为终态`);
  }
  assert.equal(callHelpers.shouldPollCall(null), false);

  assert.equal(callHelpers.computeCallDurationSeconds(createCall()), 10, 'acceptedAt 应优先');
  assert.equal(
    callHelpers.computeCallDurationSeconds(createCall({ acceptedAt: null })),
    15,
    'startedAt 应作为第二优先级'
  );
  assert.equal(
    callHelpers.computeCallDurationSeconds(createCall({ acceptedAt: null, startedAt: null })),
    20,
    'createdAt 应作为最终起点'
  );
  const endedCall = createCall({ endedAt: '2026-07-14T00:00:42.000Z' });
  assert.equal(callHelpers.computeCallDurationSeconds(endedCall), 32);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(callHelpers.computeCallDurationSeconds(endedCall), 32, 'endedAt 存在时结果应稳定');
  assert.equal(callHelpers.computeCallDurationSeconds(null), 0);
  assert.equal(
    callHelpers.computeCallDurationSeconds(createCall({ acceptedAt: 'invalid-date' })),
    0
  );
});

scenario('挂断会同步失效进行中的通话回复', async () => {
  const first = callReplyRuns.beginCallReplyRun('call-cancel');
  assert.equal(first.signal.aborted, false);
  assert.equal(callReplyRuns.cancelCallReplyRun('call-cancel'), true);
  assert.equal(first.signal.aborted, true);
  assert.throws(
    () => callReplyRuns.assertCallReplyRunActive('call-cancel', first.runId),
    { name: 'CallReplyRunCancelledError' }
  );

  const stale = callReplyRuns.beginCallReplyRun('call-replaced');
  const current = callReplyRuns.beginCallReplyRun('call-replaced');
  assert.equal(stale.signal.aborted, true, '新回合必须取消同一通话的旧回合');
  callReplyRuns.assertCallReplyRunActive('call-replaced', current.runId);
  callReplyRuns.finishCallReplyRun('call-replaced', current.runId);
});

scenario('AI 结束意图必须在最后一句播放后提交终态', async () => {
  const playbackFinished = deferred();
  const lifecycle = [];
  const service = new CallTurnRuntimeService({
    async processReply(params) {
      lifecycle.push('reply');
      // Phase 11 流式契约：净化整句经 onSpeechSentence 逐句进入 TTS 队列。
      params.onSpeechSentence?.('最后一句。', { synthesisText: '最后一句。', modelSnapshot: null });
      return {
        status: 'completed',
        userEvent: null,
        aiEvent: { id: 'event-ai' },
        text: '最后一句。',
        callEnded: true,
      };
    },
    async enqueueSpeech() {
      lifecycle.push('tts:start');
      await playbackFinished.promise;
      lifecycle.push('tts:end');
    },
    async interruptForUserSpeech() {
      return false;
    },
    async endCall() {
      lifecycle.push('end');
      return createCall({ state: 'ended', endReason: 'aiEnded' });
    },
    aiEndGraceMs: 0,
  });

  const running = service.run({
    callId: 'call-ai-end',
    userText: '再见',
    aiConfig: createAIConfig(),
  });
  await waitFor(() => lifecycle.includes('tts:start'), '最后一句未进入播放阶段');
  assert.deepEqual(lifecycle, ['reply', 'tts:start']);
  playbackFinished.resolve();
  const result = await running;
  assert.deepEqual(lifecycle, ['reply', 'tts:start', 'tts:end', 'end']);
  assert.equal(result.endedCall.endReason, 'aiEnded');
});

scenario('用户在最后一句播放期间挂断会阻止 AI 再次提交终态', async () => {
  const playbackFinished = deferred();
  let endCount = 0;
  const service = new CallTurnRuntimeService({
    async processReply(params) {
      params.onSpeechSentence?.('最后一句。', { synthesisText: '最后一句。', modelSnapshot: null });
      return {
        status: 'completed',
        userEvent: null,
        aiEvent: { id: 'event-ai' },
        text: '最后一句。',
        callEnded: true,
      };
    },
    async enqueueSpeech() {
      await playbackFinished.promise;
    },
    async interruptForUserSpeech() {
      return false;
    },
    async endCall() {
      endCount += 1;
      return createCall({ state: 'ended', endReason: 'aiEnded' });
    },
    aiEndGraceMs: 0,
  });

  const running = service.run({
    callId: 'call-user-end',
    userText: '再见',
    aiConfig: createAIConfig(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.cancel('call-user-end'), true);
  playbackFinished.resolve();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(endCount, 0);
});

scenario('统一输入入口按相位打断在途播放并广播回合相位', async () => {
  const firstSentenceRelease = deferred();
  const lifecycle = [];
  const phases = [];
  const callId = 'call-unified-input';
  const unsubscribe = callReplyRuns.subscribeCallReplyRunPhase(callId, (phase) => {
    phases.push(phase);
  });
  let replyCount = 0;
  const service = new CallTurnRuntimeService({
    async processReply(params) {
      replyCount += 1;
      if (replyCount === 1) {
        // 第一回合首句已进入 TTS 队列，处于 speaking 相位。
        params.onSpeechSentence?.('第一回合的句子。', { synthesisText: '第一回合的句子。', modelSnapshot: null });
      }
      return {
        status: 'completed',
        userEvent: null,
        aiEvent: { id: `event-ai-${replyCount}` },
        text: `第${replyCount}回合`,
        callEnded: false,
      };
    },
    async enqueueSpeech() {
      lifecycle.push('enqueue');
      await firstSentenceRelease.promise;
      lifecycle.push('settle');
    },
    async interruptForUserSpeech() {
      lifecycle.push('interrupt');
      return true;
    },
    async endCall() {
      throw new Error('本场景不应触发 AI 主动结束');
    },
    aiEndGraceMs: 0,
  });

  const firstRun = service.run({
    callId,
    userText: '你好',
    aiConfig: createAIConfig(),
  });
  await waitFor(() => lifecycle.includes('enqueue'), '第一回合句子未进入 TTS 队列');
  assert.equal(callReplyRuns.getCallReplyRunPhase(callId), 'speaking');

  // 统一输入入口：speaking 相位必须先走 TTS 打断边界，再开启新回合。
  const secondRun = service.submitUserInput({
    callId,
    userText: '等等',
    aiConfig: createAIConfig(),
  });
  await waitFor(() => lifecycle.includes('interrupt'), '统一输入必须先走 TTS 打断边界');
  firstSentenceRelease.resolve();

  assert.equal((await firstRun).status, 'cancelled', '被打断的旧回合必须按取消收口');
  assert.equal((await secondRun).status, 'completed', '新回合应正常完成');
  assert.equal(callReplyRuns.getCallReplyRunPhase(callId), 'idle');
  assert.deepEqual(
    phases,
    ['generating', 'speaking', 'generating', 'idle'],
    '相位序列必须为 generating -> speaking -> generating(新回合) -> idle'
  );
  unsubscribe();
});

scenario('工具与语音重叠时优先展示工具，插话后旧工具不得覆盖新回合', async () => {
  const callId = 'call-tool-phase';
  const playback = deferred();
  const toolFinished = deferred();
  const finalReply = deferred();
  let firstCallbacks;
  let count = 0;
  const service = new CallTurnRuntimeService({
    async processReply(params) {
      count++;
      if (count === 1) {
        firstCallbacks = params;
        params.onSpeechSentence('先查一下。', { synthesisText: '先查一下。', modelSnapshot: null });
        params.onToolExecutionChanged(true);
        await toolFinished.promise;
        params.onToolExecutionChanged(false);
        await finalReply.promise;
      }
      return { status: 'completed', userEvent: null, aiEvent: { id: 'ai' }, text: '结果', callEnded: false };
    },
    enqueueSpeech: () => playback.promise,
    interruptForUserSpeech: async () => true,
    endCall: async () => { throw new Error('不应挂断'); },
    aiEndGraceMs: 0,
  });
  const first = service.run({ callId, userText: '查询', aiConfig: createAIConfig() });
  await waitFor(() => Boolean(firstCallbacks), '回复未启动');
  assert.equal(callReplyRuns.getCallReplyRunPhase(callId), 'using_tool');
  toolFinished.resolve();
  await waitFor(() => callReplyRuns.getCallReplyRunPhase(callId) === 'speaking', '工具结束后仍有语音，应回到说话');
  playback.resolve();
  await waitFor(() => callReplyRuns.getCallReplyRunPhase(callId) === 'generating', '语音播完但模型未结束，应回到思考');
  const second = await service.submitUserInput({ callId, userText: '等等', aiConfig: createAIConfig() });
  assert.equal(second.status, 'completed');
  firstCallbacks.onToolExecutionChanged(true);
  assert.equal(callReplyRuns.getCallReplyRunPhase(callId), 'idle', '旧工具事件不得恢复已结束的回合');
  finalReply.resolve();
  assert.equal((await first).status, 'cancelled');
});

scenario('流式句子切分只在句末标点处切分且跳过换行', async () => {
  const sentences = [];
  const stream = createCallSpeechSentenceStream((sentence) => sentences.push(sentence), null);
  // 逗号、冒号、分号是句中停顿，不得切分；换行符直接跳过且不进入朗读文本。
  stream.push('今天天气不错，');
  stream.push('我的建议是：我们出去走走吧。真的吗？太好了！');
  stream.push('那就这么定了\n');
  stream.push('马上出发…');
  stream.flush();
  assert.deepEqual(sentences, [
    '今天天气不错，我的建议是：我们出去走走吧。',
    '真的吗？',
    '太好了！',
    '那就这么定了马上出发…',
  ]);
  assert.equal(stream.shouldEndCall(), false);
});

scenario('流式 [[END_CALL]] 标记跨 delta 判定且不被朗读', async () => {
  const sentences = [];
  const stream = createCallSpeechSentenceStream((sentence) => sentences.push(sentence), null);
  stream.push('[[END');
  stream.push('_CALL]]再见啦，');
  stream.push('下次再聊。');
  stream.flush();
  assert.deepEqual(sentences, ['再见啦，下次再聊。']);
  assert.equal(stream.shouldEndCall(), true);
});

scenario('去电预检结果与错误契约', async () => {
  resetRuntime();
  const config = createAIConfig();
  assert.deepEqual(
    await runCallPreflight(createPreflightRepository(), config, 'outgoing', {}),
    { ok: true, errorMessage: null, endReason: null }
  );
  assert.deepEqual(
    await runCallPreflight(
      createPreflightRepository(createCall()),
      config,
      'outgoing',
      {}
    ),
    { ok: false, errorMessage: '当前已有通话正在进行', endReason: 'busy' }
  );
  assert.deepEqual(
    await runCallPreflight(
      createPreflightRepository(),
      createAIConfig({ apiKey: '' }),
      'outgoing',
      {}
    ),
    { ok: false, errorMessage: '对方暂时无法接通', endReason: 'preflightFailed' }
  );
  assert.deepEqual(
    await runCallPreflight(
      createPreflightRepository(),
      createAIConfig({ model: '' }),
      'incoming',
      {}
    ),
    { ok: false, errorMessage: '来电链路未配置完整', endReason: 'preflightFailed' }
  );

  fakeRuntime.notificationGranted = false;
  assert.deepEqual(
    await runCallPreflight(createPreflightRepository(), config, 'incoming', {
      requiresNotification: true,
    }),
    {
      ok: false,
      errorMessage: '通知权限未开启，无法显示 AI 来电提示',
      endReason: 'permissionDenied',
    }
  );
  fakeRuntime.notificationGranted = true;
  fakeRuntime.cameraPermission = { granted: false, canAskAgain: false, status: 'denied' };
  assert.deepEqual(
    await runCallPreflight(createPreflightRepository(), config, 'outgoing', {
      requiresCamera: true,
    }),
    {
      ok: false,
      errorMessage: '相机权限未开启，无法启用视频画面',
      endReason: 'permissionDenied',
    }
  );
  fakeRuntime.cameraPermission = { granted: true, canAskAgain: true, status: 'granted' };
  assert.deepEqual(
    await runCallPreflight(createPreflightRepository(), config, 'outgoing', {
      requiresCamera: true,
      requiresNotification: true,
    }),
    { ok: true, errorMessage: null, endReason: null }
  );

  const repositoryError = new Error('活动通话查询失败');
  await assert.rejects(
    () => runCallPreflight({
      async getActiveSession() {
        throw repositoryError;
      },
    }, config, 'outgoing', {}),
    (error) => error === repositoryError
  );
});

scenario('通话状态消息执行真实 Chat 持久化流程', async () => {
  const { patchedNotifications, uiNotifications } = resetRuntime();
  const repository = createMessageRepository();
  const message = await saveCallStatusMessage(createChatWritePort(repository), {
    sessionId: 'session-1',
    callId: 'call-1',
    direction: 'outgoing',
    callStatus: 'callStarted',
    actor: 'user',
    agentId: 'agent-1',
    createdAt: '2026-07-14T08:30:00.000Z',
    isRead: true,
  });

  assert.equal(repository.insertedInputs.length, 1, '一次状态写入只能插入一条消息');
  assert.equal(repository.previews.length, 1, '状态消息应同步一次会话预览');
  assert.deepEqual(uiNotifications, ['session-1']);
  assert.equal(message.senderType, 'user');
  assert.equal(message.isMe, true);
  assert.equal(message.clientMessageId, 'call-status:call-1');
  assert.deepEqual(JSON.parse(message.metadataJson), {
    type: 'callStatus',
    callId: 'call-1',
    callStatus: 'callStarted',
    direction: 'outgoing',
    initiator: 'user',
    ownerRole: 'user',
    actor: 'user',
    endReason: null,
    durationSeconds: null,
    displayText: '【通话中】',
    aiContextText: '用户发起的视频电话已接通，聊天界面显示为【通话中】。',
    source: 'callRuntime',
  });

  const endedMessage = await saveCallStatusMessage(createChatWritePort(repository), {
    sessionId: 'session-1',
    callId: 'call-1',
    direction: 'outgoing',
    callStatus: 'callDuration',
    actor: 'system',
    endReason: 'userEnded',
    durationSeconds: 83,
    agentId: 'agent-1',
    createdAt: '2026-07-14T08:31:23.000Z',
    isRead: true,
  });

  assert.equal(repository.insertedInputs.length, 1, '通话结束不得插入第二条状态消息');
  assert.equal(repository.messages.length, 1, '同一通电话只能保留一条主状态消息');
  assert.equal(endedMessage.id, message.id, '结束状态必须沿用接通状态的消息 ID');
  assert.equal(endedMessage.text, '【通话时间：01:23】');
  assert.equal(JSON.parse(endedMessage.metadataJson).callStatus, 'callDuration');
  assert.deepEqual(patchedNotifications, [{
    sessionId: 'session-1',
    updatedMessageIds: [message.id],
  }]);

  const insertError = new Error('Chat 消息写入失败');
  await assert.rejects(
    () => saveCallStatusMessage(createChatWritePort(createMessageRepository({ insertError })), {
      sessionId: 'session-1',
      callId: 'call-2',
      direction: 'incoming',
      callStatus: 'callIncoming',
      isRead: false,
    }),
    (error) => error === insertError
  );

  const previewError = new Error('Chat 会话预览更新失败');
  const previewFailureRepository = createMessageRepository({ previewError });
  await assert.rejects(
    () => saveCallStatusMessage(createChatWritePort(previewFailureRepository), {
      sessionId: 'session-1',
      callId: 'call-3',
      direction: 'outgoing',
      callStatus: 'callEnded',
      endReason: 'userEnded',
      isRead: true,
    }),
    (error) => error === previewError
  );
  assert.equal(previewFailureRepository.insertedInputs.length, 1);
});

scenario('Chat 通话状态 upsert 使用真实 SQLite adapter 原子提交', async () => {
  const strict = createStrictMessageDatabase();
  fakeRuntime.databaseCoordinator = strict.databaseCoordinator;
  const repository = new MessageRepository();
  configureChatMessageRuntime({ messages: repository });

  const uiEvents = [];
  const patchedEvents = [];
  const observerNotifications = [];
  const unsubscribeObservers = subscribeAIMessageReceived((payload) => {
    observerNotifications.push(payload);
  });
  const removeBus = setChatEventBus({
    emit(eventName, payload) {
      if (eventName === 'messagesUpdated') {
        uiEvents.push(payload);
      }
      if (eventName === 'messagesPatched') {
        patchedEvents.push(payload);
      }
    },
  });
  const first = await upsertCallTimelineEntry({
    sessionId: 'session-1',
    callId: 'call-real-1',
    direction: 'incoming',
    callStatus: 'callIncoming',
    agentId: 'agent-1',
    isRead: false,
    createdAt: '2026-08-11T08:00:00.000Z',
  });
  const second = await upsertCallTimelineEntry({
    sessionId: 'session-1',
    callId: 'call-real-1',
    direction: 'incoming',
    callStatus: 'callMissed',
    endReason: 'missedByUser',
    agentId: 'agent-1',
    isRead: true,
    createdAt: '2026-08-11T08:01:00.000Z',
  });

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(strict.messages.size, 1, '稳定 call-status key 重入不得插入第二行');
  assert.equal(strict.sessions.get('session-1').last_message, '【未应答】');
  assert.equal(JSON.parse(second.message.metadataJson).callStatus, 'callMissed');
  assert.equal(second.message.isRead, true);
  assert.deepEqual(uiEvents, [{ sessionId: 'session-1' }]);
  assert.deepEqual(patchedEvents, [{
    sessionId: 'session-1',
    updatedMessageIds: [first.message.id],
  }]);
  // 通话状态条目免系统交付，但必须通知 UI 观察者刷新 AI 会话列表（无 AI 身份，仅 session 事实）。
  assert.equal(observerNotifications.length, 2, 'insert 与 update 都必须通知 UI 观察者');
  assert.ok(observerNotifications.every((payload) => payload.sessionId === 'session-1'));
  assert.ok(observerNotifications.every((payload) => payload.triggerSource === 'call'));
  assert.ok(observerNotifications.every((payload) => !payload.aiId));
  assert.deepEqual(
    observerNotifications.map((payload) => payload.committedMessageId),
    [first.message.id, second.message.id],
  );
  assert.equal(strict.transactionCount, 2);
  const transactionOperations = strict.operations.filter((item) => item.kind === 'transaction');
  assert.equal(transactionOperations.length, 2);

  const previewFailure = new Error('injected call preview failure');
  strict.databaseCoordinator.failPreviewUpdate = previewFailure;
  await assert.rejects(
    () => upsertCallTimelineEntry({
      sessionId: 'session-1',
      callId: 'call-real-1',
      direction: 'incoming',
      callStatus: 'callSystemError',
      endReason: 'runtimeError',
      agentId: 'agent-1',
      isRead: false,
    }),
    (error) => error === previewFailure,
  );
  assert.equal(strict.messages.size, 1, 'preview 失败必须整体回滚消息更新');
  assert.equal(
    JSON.parse([...strict.messages.values()][0].metadata_json).callStatus,
    'callMissed',
  );
  assert.equal(uiEvents.length, 1, 'commit 失败不得通知 UI');
  assert.equal(patchedEvents.length, 1, 'commit 失败不得发 patched');
  assert.equal(observerNotifications.length, 2, 'commit 失败不得发观察者通知');

  unsubscribeObservers();
  removeBus();
});

scenario('通话系统故障原子更新为系统消息并清除 AI 气泡身份', async () => {
  const db = new DatabaseSync(':memory:');
  const executor = createSqliteExecutor(db);
  await bootstrapSqlite(executor);
  db.prepare(`INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at)
    VALUES ('ai-1', 'agent-1', 'AI', 'test', '2026-10-27', '2026-10-27')`).run();
  db.prepare(`INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at)
    VALUES ('session-1', 'ai-1', 'chat', '2026-10-27', '2026-10-27')`).run();
  db.prepare("INSERT INTO chat_conversations (id, kind) VALUES ('session-1', 'direct')").run();
  fakeRuntime.databaseCoordinator = {
    openTaskExecutor: () => ({
      async withExclusiveTransactionAsync(task) {
        db.exec('BEGIN IMMEDIATE');
        try { const result = await task(executor); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    }),
  };
  configureChatMessageRuntime({ messages: new MessageRepository() });

  try {
    for (const direction of ['incoming', 'outgoing']) {
      const params = {
        sessionId: 'session-1', callId: `call-error-${direction}`, direction,
        agentId: 'agent-1', isRead: true,
      };
      const first = await upsertCallTimelineEntry({ ...params, callStatus: 'callIncoming' });
      assert.equal(first.message.senderType, direction === 'incoming' ? 'assistant' : 'user');
      const failureInput = {
        ...params, callStatus: 'callSystemError', actor: 'system', endReason: 'runtimeError',
        displayText: '【系统错误：系统通知发送失败，无法显示 AI 来电提示】',
      };
      const failed = await upsertCallTimelineEntry(failureInput);
      assert.equal(failed.message.id, first.message.id);
      assert.equal(failed.inserted, false);
      const inserted = await upsertCallTimelineEntry({ ...failureInput, callId: `new-error-${direction}` });
      assert.equal(inserted.inserted, true);
      for (const { message } of [failed, inserted]) {
        assert.equal(message.senderType, 'system');
        assert.equal(message.isMe, false);
        assert.equal(message.agentId, null);
        const metadata = JSON.parse(message.metadataJson);
        assert.equal(metadata.actor, 'system');
        assert.equal(metadata.initiator, direction === 'incoming' ? 'ai' : 'user');
        const stored = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id);
        assert.equal(stored.sender_type, 'system');
        assert.equal(stored.is_me, 0);
        assert.equal(stored.agent_id, null);
      }
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 4,
      '每通电话只有一条状态消息，故障更新不创建第二条');
  } finally { db.close(); }
});

scenario('Headless 已提交的拒接被 Host 重复消费时不产生第二条状态消息', async () => {
  // durable inbox 语义：前台不在线时 Headless 立即执行 rejectCall() 并保留 pending response；
  // Host 下次启动消费同一 reject response 时 rejectCall() 必须幂等 no-op，
  // 不得重复写 CallSession 事件、状态消息或重复回传终态。
  const ringingCall = createCall({
    direction: 'incoming',
    state: 'ringing',
    acceptedAt: null,
    endedAt: null,
    source: 'aiTool',
  });
  const callRepository = createCallRepository([ringingCall]);
  const runtime = resetRuntime(callRepository);
  const messageRepository = createMessageRepository();
  fakeRuntime.chat = createChatWritePort(messageRepository);
  const service = new AICallRuntimeService({
    callRepo: callRepository,
    chat: fakeRuntime.chat,
  });

  const headlessResult = await service.rejectCall(ringingCall.id, 'userRejected');
  const hostReplayResult = await service.rejectCall(ringingCall.id, 'userRejected');

  assert.equal(headlessResult.call.state, 'rejected');
  assert.equal(headlessResult.visibleMessages.length, 1);
  assert.equal(hostReplayResult.call.state, 'rejected');
  assert.deepEqual(
    hostReplayResult.visibleMessages,
    [],
    'Host 重复消费已提交的拒接不得产生第二条状态消息',
  );
  assert.equal(messageRepository.insertedInputs.length, 1);
  assert.equal(
    callRepository.events.filter((event) => event.kind === 'stateChanged').length,
    1,
    '终态转换只能写入一次状态事件',
  );
  assert.equal(runtime.terminatedCalls.length, 1, '同一通话终态只能回传 Host 一次');
});

scenario('重复接听不会重复写入通话状态消息', async () => {
  const ringingCall = createCall({
    direction: 'incoming',
    state: 'ringing',
    acceptedAt: null,
    endedAt: null,
    source: 'aiTool',
  });
  const callRepository = createCallRepository([ringingCall]);
  const audioRuntime = resetRuntime(callRepository);
  const messageRepository = createMessageRepository();
  fakeRuntime.chat = createChatWritePort(messageRepository);
  const service = new AICallRuntimeService({
    callRepo: callRepository,
    chat: fakeRuntime.chat,
  });

  const snapshots = [];
  const unsubscribe = service.subscribeActiveCall(() => snapshots.push(service.getActiveCallSnapshot()));
  assert.equal(service.getActiveCallSnapshot(), null, '响铃不设置接通标记');

  const first = await service.acceptCall(ringingCall.id);
  const second = await service.acceptCall(ringingCall.id);
  assert.equal(service.getActiveCallSnapshot(), first.call);
  assert.deepEqual(snapshots, [first.call], '重复接听不重复发布接通标记');
  unsubscribe();

  assert.equal(first.call.state, 'active');
  assert.equal(first.visibleMessages.length, 1);
  assert.equal(second.call.state, 'active');
  assert.deepEqual(second.visibleMessages, []);
  assert.equal(messageRepository.insertedInputs.length, 1);
  assert.deepEqual(audioRuntime.startedAudioCalls, [ringingCall.id], '重复接听不重置当前通话音频会话');
  assert.equal(
    callRepository.events.filter((event) => event.kind === 'stateChanged').length,
    1
  );
});

scenario('接通标记跟随提交与终态，读取标记不访问数据库', async () => {
  const call = createCall({ direction: 'incoming', state: 'ringing', acceptedAt: null, endedAt: null });
  const repository = createCallRepository([call]);
  resetRuntime(repository);
  const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
  const commit = deferred();
  const updating = deferred();
  const update = repository.updateSessionIfState;
  repository.updateSessionIfState = async (...args) => {
    updating.resolve();
    await commit.promise;
    return update(...args);
  };
  const snapshots = [];
  const unsubscribe = service.subscribeActiveCall(() => snapshots.push(service.getActiveCallSnapshot()));
  const accepting = service.acceptCall(call.id);
  await updating.promise;
  assert.equal(service.getActiveCallSnapshot(), null, '接通事务尚未提交时不阻断聊天');
  commit.resolve();
  const accepted = await accepting;
  assert.equal(service.getActiveCallSnapshot(), accepted.call);
  repository.getActiveSession = () => { throw new Error('输入判定不应查询数据库'); };
  assert.equal(service.getActiveCallSnapshot(), accepted.call);

  const cleanup = deferred();
  const cleaning = deferred();
  fakeRuntime.callAudioPlayback.endSession = async () => { cleaning.resolve(); await cleanup.promise; };
  const ending = service.endCall(call.id);
  await cleaning.promise;
  assert.equal(service.getActiveCallSnapshot(), null, '终态已提交时不等待媒体清理就释放标记');
  assert.deepEqual(snapshots, [accepted.call, null]);
  cleanup.resolve();
  await ending;
  unsubscribe();
  await service.endCall(call.id);
  assert.deepEqual(snapshots, [accepted.call, null], '重复挂断不重复通知');
});

scenario('冷启动查询晚到不能覆盖接听或挂断后的标记', async () => {
  const call = createCall({ direction: 'incoming', state: 'ringing', acceptedAt: null, endedAt: null });
  const repository = createCallRepository([call]);
  resetRuntime(repository);
  const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
  const staleRinging = deferred();
  repository.getActiveSession = () => staleRinging.promise;
  const firstRestore = service.restoreActiveCallSnapshot();
  const accepted = await service.acceptCall(call.id);
  staleRinging.resolve(call);
  await firstRestore;
  assert.equal(service.getActiveCallSnapshot(), accepted.call, '旧响铃查询不得抹掉新接通标记');

  const staleActive = deferred();
  repository.getActiveSession = () => staleActive.promise;
  const secondRestore = service.restoreActiveCallSnapshot();
  await service.endCall(call.id);
  staleActive.resolve(accepted.call);
  await secondRestore;
  assert.equal(service.getActiveCallSnapshot(), null, '旧 active 查询不得复活已挂断标记');
});

scenario('旧通话的迟到挂断不能清除下一通电话的标记', async () => {
  const oldCall = createCall({ id: 'old-call', state: 'ended' });
  const newCall = createCall({ id: 'new-call', direction: 'incoming', state: 'ringing', acceptedAt: null, endedAt: null });
  const repository = createCallRepository([oldCall, newCall]);
  resetRuntime(repository);
  const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
  const accepted = await service.acceptCall(newCall.id);
  await service.endCall(oldCall.id);
  assert.equal(service.getActiveCallSnapshot(), accepted.call);
  await service.endCall(newCall.id);
});

scenario('已有通话时再次拨号只返回占线，不挂断或替换通话', async () => {
  for (const chatSessionId of ['session-1', 'other-session']) {
    const call = createCall({ state: 'active', endedAt: null });
    const repository = createCallRepository([call]);
    const runtime = resetRuntime(repository);
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    const result = await service.startOutgoingCall({
      chatSessionId,
      aiConfig: createAIConfig(),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorMessage, '当前已有通话正在进行');
    assert.equal(result.call, null);
    assert.deepEqual(result.visibleMessages, []);
    assert.deepEqual([...repository.sessions.values()], [call], '原通话状态与身份保持不变');
    assert.deepEqual(fakeRuntime.messageRepository.messages, []);
    assert.deepEqual(runtime.endedAudioCalls, [], '重复拨号不释放当前通话媒体');
  }
});

scenario('去电决策晚到不能复活已挂断会话', async () => {
  for (const decision of ['accept', 'reject']) {
    const repository = createCallRepository([]);
    const runtime = resetRuntime(repository);
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    const response = deferred();
    let signal;
    let callId;
    fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
    fakeRuntime.createAIClient = () => ({ async chat(messages, options) { signal = options.signal; return response.promise; } });
    const starting = service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig(), onCallCreated(call) { callId = call.id; } });
    await waitFor(() => signal, '去电决策未启动');
    await service.endCall(callId);
    assert.equal(signal.aborted, true, '挂断取消去电网络请求');
    response.resolve({ success: true, text: decision === 'accept' ? '[[接听]]接通' : '[[拒绝接听]]拒接' });
    const result = await starting;
    assert.equal(result.status, 'ended');
    assert.equal(result.call.state, 'ended');
    assert.equal((await repository.getSessionById(callId)).state, 'ended');
    assert.deepEqual(runtime.startedAudioCalls, [], '晚到决策不能启动 Telecom');
  }
});

scenario('去电只在 AI 接听后设置接通标记，拒接不设置', async () => {
  for (const decision of ['accept', 'reject']) {
    const repository = createCallRepository([]);
    resetRuntime(repository);
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    const response = deferred();
    const deciding = deferred();
    const snapshots = [];
    const unsubscribe = service.subscribeActiveCall(() => snapshots.push(service.getActiveCallSnapshot()));
    fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
    fakeRuntime.createAIClient = () => ({ async chat() { deciding.resolve(); return response.promise; } });
    const starting = service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
    await deciding.promise;
    assert.equal(service.getActiveCallSnapshot(), null, '拨号等待决策时尚未接通');
    response.resolve({ success: true, text: decision === 'accept' ? '[[接听]]接通' : '[[拒绝接听]]稍后再聊' });
    const result = await starting;
    if (decision === 'accept') {
      assert.equal(service.getActiveCallSnapshot(), result.call);
      await service.endCall(result.call.id);
      assert.deepEqual(snapshots, [result.call, null]);
    } else {
      assert.equal(service.getActiveCallSnapshot(), null);
      assert.deepEqual(snapshots, []);
    }
    unsubscribe();
  }
});

scenario('接听与拒接标记支持任意位置、重复出现及带引号换行的正文', async () => {
  for (const [marker, decision, field] of [
    ['[[接听]]', 'accept', 'spokenText'],
    ['[[拒绝接听]]', 'reject', 'rejectionReason'],
  ]) {
    for (const [raw, text] of [
      [`${marker}你好。`, '你好。'],
      [`你好。${marker}`, '你好。'],
      [`哦，${marker}你好。`, '哦，你好。'],
      [`${marker}哦，${marker}你好。${marker}`, '哦，你好。'],
      [`${marker}他说“明天见”，我说"好"。\n这回接上了。`, '他说“明天见”，我说"好"。\n这回接上了。'],
      [`  ${marker}  `, ''],
    ]) {
      assert.deepEqual(parseOutgoingCallDecision(raw), { decision, [field]: text });
    }
  }
});

scenario('去电首句抽离接听标记后才交付字幕和朗读', async () => {
  const repository = createCallRepository([]);
  const runtime = resetRuntime(repository);
  const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
  const spokenText = '接了。上一通挂到一半自己断了，不知道你那边有没有听见我说话？';
  const synthesized = [];
  const synthesize = fakeRuntime.synthesizeTextToSpeech;
  fakeRuntime.synthesizeTextToSpeech = async (params) => {
    synthesized.push(params.text);
    return synthesize(params);
  };
  fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
  fakeRuntime.createAIClient = () => ({ async chat(messages, options) {
    assert.equal(options.responseFormat, undefined, '控制标记使用口语回复，不强制模型输出 JSON');
    return { success: true, text: `接了。[[接听]]${spokenText.slice(3)}` };
  } });
  const result = await service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(repository.events.filter(event => event.kind === 'aiSpeechText').map(event => event.text), [spokenText]);
  await waitFor(() => synthesized.length > 0, '接听后的口语首句未进入合成');
  assert.deepEqual(synthesized, [spokenText], '朗读只使用抽离控制标记后的口语正文');
  assert.deepEqual(runtime.startedAudioCalls, [result.call.id]);
  await service.endCall(result.call.id);
});

scenario('拒接正文抽离标记后作为普通消息交付，不接通或朗读', async () => {
  const repository = createCallRepository([]);
  const runtime = resetRuntime(repository);
  const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
  fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
  fakeRuntime.createAIClient = () => ({ async chat() {
    return { success: true, text: '现在不方便，[[拒绝接听]]我们晚点聊。' };
  } });
  const result = await service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
  assert.equal(result.status, 'rejected');
  assert.equal(result.rejectionReason, '现在不方便，我们晚点聊。');
  assert.equal(result.call.aiRejectionReason, result.rejectionReason);
  assert.equal(result.visibleMessages.at(-1).text, result.rejectionReason);
  assert.deepEqual(repository.events.filter(event => event.kind === 'aiSpeechText'), []);
  assert.deepEqual(runtime.startedAudioCalls, []);
});

scenario('只有控制标记也能接听或拒接，不制造空字幕、空消息或默认台词', async () => {
  for (const [marker, status] of [['[[接听]]', 'accepted'], ['[[拒绝接听]]', 'rejected']]) {
    const repository = createCallRepository([]);
    const runtime = resetRuntime(repository);
    const synthesized = [];
    fakeRuntime.synthesizeTextToSpeech = async (params) => { synthesized.push(params.text); };
    fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
    fakeRuntime.createAIClient = () => ({ async chat() { return { success: true, text: marker }; } });
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    const result = await service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
    assert.equal(result.status, status);
    assert.equal(result.visibleMessages.length, 1, '没有正文时只提交通话状态记录');
    assert.deepEqual(repository.events.filter(event => event.kind === 'aiSpeechText'), []);
    assert.deepEqual(synthesized, []);
    if (status === 'accepted') {
      assert.deepEqual(runtime.startedAudioCalls, [result.call.id]);
      await service.endCall(result.call.id);
    } else {
      assert.deepEqual(runtime.startedAudioCalls, []);
      assert.equal(result.call.aiRejectionReason, null);
    }
  }
});

scenario('缺少或冲突的标记不猜测接听，普通用户只看到未接通', async () => {
  for (const raw of [
    '',
    '[[ 接听 ]]你好。',
    '[[接听]]你好。[[拒绝接听]]',
    '[[拒绝接听]]晚点聊。[[接听]]',
    JSON.stringify({ decision: 'accept', spokenText: '接了。' }),
    '{"decision":"accept","spokenText":"接了。\n上一通断了，你听见了吗？"}',
    '好的，我在。',
  ]) {
    const repository = createCallRepository([]);
    const runtime = resetRuntime(repository);
    const synthesized = [];
    fakeRuntime.synthesizeTextToSpeech = async (params) => { synthesized.push(params.text); };
    fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
    fakeRuntime.createAIClient = () => ({ async chat() { return { success: true, text: raw }; } });
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    const result = await service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorMessage, '这次电话没有接通，请稍后再试。');
    assert.deepEqual(repository.events.filter(event => event.kind === 'aiSpeechText'), []);
    assert.deepEqual(runtime.startedAudioCalls, []);
    assert.deepEqual(synthesized, []);
  }
});

scenario('接听与拒接同时到达只允许一个状态提交', async () => {
  const call = createCall({ direction: 'incoming', state: 'ringing', acceptedAt: null });
  const repository = createCallRepository([call]);
  const runtime = resetRuntime(repository);
  const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
  await Promise.all([service.acceptCall(call.id), service.rejectCall(call.id)]);
  assert.equal((await repository.getSessionById(call.id)).state, 'active');
  assert.deepEqual(runtime.startedAudioCalls, [call.id]);
  assert.equal(repository.events.filter(event => event.kind === 'stateChanged').length, 1);
});

scenario('已接通电话结束时原地更新主状态消息', async () => {
  const activeCall = createCall({
    state: 'active',
    endedAt: null,
    endReason: null,
  });
  const callRepository = createCallRepository([activeCall]);
  const runtime = resetRuntime(callRepository);
  const messageRepository = createMessageRepository();
  fakeRuntime.chat = createChatWritePort(messageRepository);
  const service = new AICallRuntimeService({
    callRepo: callRepository,
    chat: fakeRuntime.chat,
  });

  const startedMessage = await saveCallStatusMessage(fakeRuntime.chat, {
    sessionId: activeCall.chatSessionId,
    callId: activeCall.id,
    direction: activeCall.direction,
    callStatus: 'callStarted',
    actor: 'user',
    agentId: activeCall.agentId,
    createdAt: activeCall.acceptedAt,
    isRead: true,
  });
  const result = await service.endCall(activeCall.id, 'userEnded');
  const repeated = await service.endCall(activeCall.id, 'aiEnded');

  assert.equal(messageRepository.messages.length, 1);
  assert.equal(result.visibleMessages.length, 1);
  assert.equal(result.visibleMessages[0].id, startedMessage.id);
  assert.equal(JSON.parse(result.visibleMessages[0].metadataJson).callStatus, 'callDuration');
  assert.equal(repeated.visibleMessages.length, 0, '迟到的结束请求不得重复写状态消息');
  assert.equal(repeated.call.endReason, 'userEnded', '第一次成功提交的挂断原因必须保持稳定');
  assert.equal(
    callRepository.events.filter((event) => event.kind === 'stateChanged').length,
    1,
    '终态转换只能写入一次状态事件'
  );
  assert.equal(runtime.terminatedCalls.length, 1, '同一通话终态只能回传 Host 一次');
  assert.equal(runtime.terminatedCalls[0].endReason, 'userEnded');
  assert.deepEqual(runtime.endedAudioCalls, [activeCall.id, activeCall.id], '重复挂断仍按身份释放资源，不重复提交业务终态');
});

scenario('已故障通话仍能挂断残留媒体并结束 Headless 等待', async () => {
  const failedCall = createCall({ id: 'failed-hosted-call', state: 'failed', endReason: 'runtimeError' });
  const repository = createCallRepository([failedCall]);
  const runtime = resetRuntime(repository);
  const stopped = deferred();
  const terminal = deferred();
  let stopRequested = false;
  let completed = false;
  registerHostedCallMediaRuntime(failedCall.id, {
    subscribe: () => () => {},
    complete() { completed = true; terminal.resolve(); },
  });
  const unregister = registerCallMediaOwner(failedCall.id, async (call) => {
    assert.equal(call.state, 'failed');
    stopRequested = true;
    await stopped.promise;
  });
  try {
    const ending = aiCallRuntimeService.endCall(failedCall.id, 'userEnded');
    await waitFor(() => stopRequested, '已故障通话的挂断未释放残留采集');
    assert.equal(completed, false, '释放媒体后才交还执行任务');
    stopped.resolve();
    const result = await ending;
    assert.equal(completed, true, '终态已存在也必须唤醒 Headless 的 terminal 等待');
    await terminal.promise;
    assert.equal(result.call.endReason, 'runtimeError');
    assert.equal(result.call.endedAt, failedCall.endedAt);
    assert.deepEqual(result.visibleMessages, []);
    assert.deepEqual(repository.eventInputs, []);
    assert.deepEqual(runtime.terminatedCalls, [], '不补发用户挂断跟进或覆盖故障事实');
    assert.deepEqual(runtime.endedAudioCalls, [failedCall.id]);
  } finally {
    stopped.resolve();
    unregister();
  }
});

scenario('悬浮窗挂断已经被错误收口的通话，真实结束入口驱动宿主退出', async () => {
  const activeCall = createCall({ id: 'interrupted-overlay-call', endedAt: null });
  const repository = createCallRepository([activeCall]);
  const runtime = resetRuntime(repository);
  const terminal = deferred();
  const released = [];
  const acknowledgements = [];
  let commandListener;
  let ready = false;
  let alive = true;
  let removeMediaOwner;
  // 复用真实结束入口与 runtime registry；仅替换物理媒体、原生桥和 bootstrap 边界。
  const mediaRuntime = {
    terminal: terminal.promise,
    subscribe: () => () => {},
    complete: () => terminal.resolve(),
    async initialize() {
      removeMediaOwner = registerCallMediaOwner(activeCall.id, async (call) => {
        assert.equal(call.state, 'failed');
        released.push('media');
      });
    },
    async stopMedia() {},
    async drain() {},
  };
  const boundaries = {
    '@features/calls': {
      getCallSession: id => repository.getSessionById(id),
      endCall: (...args) => aiCallRuntimeService.endCall(...args),
    },
    '@features/calls/composition': {
      createCallMediaRuntime: () => mediaRuntime,
      registerHostedCallMediaRuntime,
    },
    '../composition/ensureHostDatabaseReady': { async ensureHostDatabaseReady() {} },
    '../../../modules/call-runtime': {
      nativeCallRuntime: {
        async isAlive() { return alive; },
        async ready() { ready = true; },
        async acknowledge(id, error) { acknowledgements.push([id, error]); },
        async finish(id) { assert.equal(id, activeCall.id); alive = false; released.push('native'); },
      },
      async pendingNativeCallCommands() { return []; },
      subscribeNativeCallCommand(listener) { commandListener = listener; return { remove() { commandListener = null; } }; },
      subscribeNativeCallCancellation() { return { remove() {} }; },
    },
  };
  const filename = path.join(repoRoot, 'src/host/runtime/ExecuteCall.ts');
  const hostModule = new Module(filename);
  hostModule.require = id => {
    assert.ok(Object.hasOwn(boundaries, id), `未替换的宿主边界：${id}`);
    return boundaries[id];
  };
  hostModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  const task = hostModule.exports.executeCall({ callId: activeCall.id });
  try {
    await waitFor(() => ready, '执行宿主没有就绪');
    // 重现已安装旧版本的分裂状态：数据库 failed，原生宿主仍在执行。
    await repository.updateSession(activeCall.id, { state: 'failed', endReason: 'runtimeError' });
    commandListener({ callId: activeCall.id, requestId: 'overlay-hangup', action: 'hangup', muted: false });
    await waitFor(() => !alive, '小窗挂断后原生释放未发生，仍卡在结束中');
    await task;
    assert.deepEqual(released, ['media', 'native']);
    assert.deepEqual(acknowledgements, [['overlay-hangup', null]]);
    assert.deepEqual(runtime.endedAudioCalls, [activeCall.id]);
    assert.equal((await repository.getSessionById(activeCall.id)).endReason, 'runtimeError');
    assert.deepEqual(runtime.terminatedCalls, []);
  } finally {
    removeMediaOwner?.();
    terminal.resolve();
    await task;
  }
});

scenario('已故障通话清理失败仍结束执行等待，旧电话不能结束新宿主', async () => {
  const oldCall = createCall({ id: 'old-failed-call', state: 'failed', endReason: 'runtimeError' });
  const failedCall = createCall({ id: 'failed-cleanup-call', state: 'failed', endReason: 'runtimeError' });
  const repository = createCallRepository([oldCall, failedCall]);
  const runtime = resetRuntime(repository);
  let completed = false;
  registerHostedCallMediaRuntime(failedCall.id, {
    subscribe: () => () => {},
    complete() { completed = true; },
  });
  await aiCallRuntimeService.endCall(oldCall.id);
  assert.equal(completed, false, '旧电话的重复挂断不能完成新电话');
  const unregister = registerCallMediaOwner(failedCall.id, async () => { throw new Error('摄像头释放失败'); });
  try {
    await assert.rejects(aiCallRuntimeService.endCall(failedCall.id), /摄像头释放失败/);
    assert.equal(completed, true, '媒体清理异常不得留下永久等待的执行任务');
    assert.deepEqual(runtime.endedAudioCalls, [oldCall.id, failedCall.id]);
  } finally {
    unregister();
  }
});

scenario('媒体停止完成前不得释放通信音频，清理异常仍释放音频', async () => {
  const activeCall = createCall({ endedAt: null });
  const repository = createCallRepository([activeCall]);
  const runtime = resetRuntime(repository);
  const stopped = deferred();
  let stopRequested = false;
  const unregister = registerCallMediaOwner(activeCall.id, async (terminalCall) => {
    assert.equal(terminalCall.state, 'ended');
    stopRequested = true;
    await stopped.promise;
  });
  try {
    const ending = aiCallRuntimeService.endCall(activeCall.id, 'aiEnded');
    await waitFor(() => stopRequested, '挂断没有停止媒体会话');
    assert.deepEqual(runtime.endedAudioCalls, []);
    stopped.resolve();
    await ending;
    assert.deepEqual(runtime.endedAudioCalls, [activeCall.id]);
  } finally {
    stopped.resolve();
    unregister();
  }

  const removeFailedOwner = registerCallMediaOwner('failed-media', async () => { throw new Error('采集停止失败'); });
  try {
    await assert.rejects(finishCallMediaSession(createCall({ id: 'failed-media', state: 'ended' })), /采集停止失败/);
    assert.deepEqual(runtime.endedAudioCalls, [activeCall.id, 'failed-media']);
  } finally {
    removeFailedOwner();
  }
});

scenario('音频就绪之前保持 connecting，接通时间和开场白只在成功后提交', async () => {
  for (const direction of ['incoming', 'outgoing']) {
    const ringing = createCall({ direction, state: 'ringing', acceptedAt: null, endedAt: null });
    const repository = createCallRepository(direction === 'incoming' ? [ringing] : []);
    resetRuntime(repository);
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
    fakeRuntime.createAIClient = () => ({ async chat() { return { success: true, text: '[[接听]]你好' }; } });
    const activating = deferred();
    const ready = deferred();
    fakeRuntime.callAudioPlayback.beginSession = async () => { activating.resolve(); await ready.promise; };
    const accepting = direction === 'incoming'
      ? service.acceptCall(ringing.id)
      : service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
    await activating.promise;
    const pending = await repository.getActiveSession();
    assert.equal(pending.state, 'connecting');
    assert.equal(pending.acceptedAt, null, '系统音频等待时间不算通话时长');
    assert.equal(service.getActiveCallSnapshot(), null);
    assert.equal(fakeRuntime.messageRepository.messages.length, 0, '等待音频时不发布通话中消息');
    assert.equal(repository.events.some(event => event.kind === 'aiSpeechText'), false);
    if (direction === 'incoming') {
      const duplicate = await service.acceptCall(ringing.id);
      assert.equal(duplicate.call.state, 'connecting');
      assert.deepEqual(duplicate.visibleMessages, []);
    }
    const readyAt = Date.now();
    ready.resolve();
    const accepted = await accepting;
    assert.equal(accepted.call.state, 'active');
    assert.ok(Date.parse(accepted.call.acceptedAt) >= readyAt);
    assert.equal(service.getActiveCallSnapshot(), accepted.call);
    await service.endCall(accepted.call.id);
  }
});

scenario('音频建立期间挂断，迟到的成功回执不能发布接通或开场白', async () => {
  for (const direction of ['incoming', 'outgoing']) {
    const ringing = createCall({ direction, state: 'ringing', acceptedAt: null, endedAt: null });
    const repository = createCallRepository(direction === 'incoming' ? [ringing] : []);
    resetRuntime(repository);
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
    fakeRuntime.createAIClient = () => ({ async chat() { return { success: true, text: '[[接听]]你好' }; } });
    const activating = deferred();
    const ready = deferred();
    fakeRuntime.callAudioPlayback.beginSession = async () => { activating.resolve(); await ready.promise; };
    const accepting = direction === 'incoming'
      ? service.acceptCall(ringing.id)
      : service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
    await activating.promise;
    const pending = await repository.getActiveSession();
    await service.endCall(pending.id, 'userEnded');
    ready.resolve();
    const result = await accepting;
    assert.equal(result.call.state, 'ended');
    assert.equal(result.call.acceptedAt, null);
    assert.equal(result.call.endReason, 'userEnded');
    assert.equal(service.getActiveCallSnapshot(), null);
    assert.equal(repository.events.some(event => event.kind === 'aiSpeechText'), false);
    assert.deepEqual(result.visibleMessages, []);
  }
});

scenario('原生音频建立超时不记录虚假通话时长或用户主动挂断', async () => {
  for (const direction of ['incoming', 'outgoing']) {
    const ringing = createCall({ direction, state: 'ringing', acceptedAt: null, endedAt: null });
    const repository = createCallRepository(direction === 'incoming' ? [ringing] : []);
    const runtime = resetRuntime(repository);
    const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
    fakeRuntime.assembleChatPromptPack = async () => ({ systemPrompt: 'call', modelMessages: [] });
    fakeRuntime.createAIClient = () => ({ async chat() { return { success: true, text: '[[接听]]你好' }; } });
    let callId;
    fakeRuntime.callAudioPlayback.beginSession = async id => {
      callId = id;
      throw new Error('系统通话音频建立超时');
    };
    const accepting = direction === 'incoming'
      ? service.acceptCall(ringing.id)
      : service.startOutgoingCall({ chatSessionId: 'session-1', aiConfig: createAIConfig() });
    await assert.rejects(accepting, /系统通话音频建立超时/);
    const terminal = await repository.getSessionById(callId);
    assert.equal(terminal.state, 'ended');
    assert.equal(terminal.endReason, 'runtimeError');
    assert.equal(terminal.acceptedAt, null);
    assert.equal(service.getActiveCallSnapshot(), null);
    assert.deepEqual(runtime.endedAudioCalls, [callId]);
    const error = repository.eventInputs.find(event => event.kind === 'error');
    assert.match(error.text, /系统通话音频建立超时/);
    assert.equal(JSON.parse(error.payloadJson).type, 'nativeAudioSessionFailure');
    const ended = repository.eventInputs.find(event => event.kind === 'stateChanged'
      && JSON.parse(event.payloadJson).to === 'ended');
    assert.equal(ended.actorType, 'system');
    assert.match(ended.text, /自动结束/);
    assert.equal(repository.events.some(event => event.kind === 'aiSpeechText'), false);
    const messages = fakeRuntime.messageRepository.messages;
    assert.equal(messages.length, 1);
    const metadata = JSON.parse(messages[0].metadataJson);
    assert.equal(metadata.callStatus, 'callSystemError');
    assert.equal(metadata.actor, 'system');
    assert.equal(metadata.durationSeconds, null);
    assert.equal(metadata.displayText, '【通话未接通】');
  }
});

scenario('用户挂断导致的原生激活取消不保存为故障', async () => {
  const ringing = createCall({ direction: 'incoming', state: 'ringing', acceptedAt: null, endedAt: null });
  const repository = createCallRepository([ringing]);
  resetRuntime(repository);
  fakeRuntime.callAudioPlayback.beginSession = async () => {
    await aiCallRuntimeService.endCall(ringing.id, 'userEnded');
    throw new Error('通话已经结束');
  };
  await assert.rejects(aiCallRuntimeService.acceptCall(ringing.id), /通话已经结束/);
  assert.equal((await repository.getSessionById(ringing.id)).endReason, 'userEnded');
  assert.equal(repository.eventInputs.filter(event => event.kind === 'error').length, 0);
});

scenario('transcript、camera state 与 error event payload', async () => {
  const callRepository = createCallRepository();
  resetRuntime(callRepository);

  await transcriptEvents.appendUserSpeechText({ callId: 'call-1', text: '你好' });
  await transcriptEvents.appendAISpeechText({ callId: 'call-1', text: '我在' });
  await appendCallCameraStateEvent({
    callId: 'call-1',
    enabled: true,
    facing: 'back',
    reason: 'facingChanged',
  });
  await appendCallErrorEvent({
    callId: 'call-1',
    text: '语音链路失败',
    payload: { type: 'realtimeSpeechError', source: 'audioSource' },
  });

  assert.deepEqual(callRepository.eventInputs[0], {
    callId: 'call-1',
    chatSessionId: 'session-1',
    kind: 'userSpeechText',
    actorType: 'user',
    text: '你好',
    visibleInChat: false,
    includeInAIContext: true,
    payloadJson: '{"inputKind":"text"}',
  });
  assert.deepEqual(callRepository.eventInputs[1], {
    callId: 'call-1',
    chatSessionId: 'session-1',
    kind: 'aiSpeechText',
    actorType: 'ai',
    actorId: 'agent-1',
    text: '我在',
    visibleInChat: false,
    includeInAIContext: true,
  });
  assert.equal(callRepository.eventInputs[2].kind, 'systemNotice');
  assert.equal(callRepository.eventInputs[2].actorType, 'system');
  assert.equal(
    callRepository.eventInputs[2].text,
    '用户已切换到后置摄像头，此前看到的画面已过时，需要时可以重新请求查看当前画面。'
  );
  assert.deepEqual(JSON.parse(callRepository.eventInputs[2].payloadJson), {
    type: 'cameraState',
    enabled: true,
    facing: 'back',
    reason: 'facingChanged',
  });
  assert.equal(callRepository.eventInputs[3].kind, 'error');
  assert.equal(callRepository.eventInputs[3].actorType, 'system');
  assert.deepEqual(JSON.parse(callRepository.eventInputs[3].payloadJson), {
    type: 'realtimeSpeechError',
    source: 'audioSource',
  });

  callRepository.appendFailuresRemaining = 1;
  await assert.rejects(
    () => transcriptEvents.appendUserSpeechText({ callId: 'call-1', text: '失败文本' }),
    (error) => error === callRepository.appendFailure
  );
  await assert.rejects(
    () => appendCallErrorEvent({ callId: 'missing-call', text: '错误' }),
    { message: 'Call missing-call not found' }
  );
});

scenario('通话 TTS 保留合成标记和模型快照，播放事实只保存转写', async () => {
  resetRuntime();
  const synthesize = fakeRuntime.synthesizeTextToSpeech;
  const synthesized = [];
  const playbackEvents = [];
  const modelSnapshot = { model: 'eleven_v4', modelConfigId: 'tts-frozen', metadataJson: '{"provider":"elevenlabs","voiceId":"voice"}' };
  const queue = new CallTTSPlaybackQueue();
  fakeRuntime.synthesizeTextToSpeech = async (params) => {
    synthesized.push(params);
    return synthesize(params);
  };
  const unsubscribe = loadCompiled('src/features/calls/application/runtime/CallTTSPlaybackQueue.ts').subscribeCallSentencePlayback((event) => playbackEvents.push(event));
  try {
    await queue.enqueueAISpeech({
      callId: 'call-1', assistantId: 'assistant-1', text: '嗯，我在。 你说吧。',
      speech: { synthesisText: '[whispers] 嗯，我在。[short pause] 你说吧。', modelSnapshot },
    });
    assert.equal(synthesized[0].text, '[whispers] 嗯，我在。[short pause] 你说吧。');
    assert.equal(synthesized[0].modelSnapshot, modelSnapshot);
    assert.deepEqual(playbackEvents.map((event) => event.text), ['嗯，我在。 你说吧。', '嗯，我在。 你说吧。']);
    const events = await fakeRuntime.callRepository.listEvents({ callId: 'call-1' });
    assert.deepEqual(events.filter((event) => ['ttsStarted', 'ttsEnded'].includes(event.kind)).map((event) => event.text), ['嗯，我在。 你说吧。', '嗯，我在。 你说吧。']);
  } finally {
    unsubscribe();
  }
});

scenario('TTS 按入队顺序串行播放', async () => {
  const { playedAudioUris } = resetRuntime();
  const synthesizedTexts = [];
  const playbackLifecycle = [];
  const firstFinished = deferred();
  fakeRuntime.synthesizeTextToSpeech = async ({ text }) => {
    synthesizedTexts.push(text);
    return {
      success: true,
      audioUri: `file:///${text}.mp3`,
      mimeType: 'audio/mpeg',
      modelConfigId: 'tts-1',
      modelConfigName: 'TTS',
      model: 'tts-model',
    };
  };
  fakeRuntime.callAudioPlayback.play = async (uri) => {
    playedAudioUris.push(uri);
    return {
      playbackId: `playback-${playedAudioUris.length}`,
      uri,
      finished: playedAudioUris.length === 1 ? firstFinished.promise : Promise.resolve(),
      async stop() {
        firstFinished.resolve();
      },
    };
  };

  const queue = new CallTTSPlaybackQueue();
  const first = queue.enqueueAISpeech({
    callId: 'call-1',
    assistantId: 'assistant-1',
    text: '第一句',
    onPlaybackStarted: () => playbackLifecycle.push('第一句:start'),
    onPlaybackEnded: () => playbackLifecycle.push('第一句:end'),
  });
  const second = queue.enqueueAISpeech({
    callId: 'call-1',
    assistantId: 'assistant-1',
    text: '第二句',
    onPlaybackStarted: () => playbackLifecycle.push('第二句:start'),
    onPlaybackEnded: () => playbackLifecycle.push('第二句:end'),
  });
  await waitFor(() => playedAudioUris.length === 1, '第一条 TTS 未开始播放');
  assert.deepEqual(synthesizedTexts, ['第一句']);
  firstFinished.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(synthesizedTexts, ['第一句', '第二句']);
  assert.deepEqual(playedAudioUris, ['file:///第一句.mp3', 'file:///第二句.mp3']);
  assert.deepEqual(playbackLifecycle, [
    '第一句:start',
    '第一句:end',
    '第二句:start',
    '第二句:end',
  ]);
});

scenario('AI 播放期间隔离麦克风回灌和延迟识别结果', async () => {
  const guard = new CallSpeechDuplexGuard(800);
  const microphoneChunk = new Uint8Array([1, 2, 3, 4]).buffer;

  assert.equal(guard.audioChunkForASR(microphoneChunk, 1_000), microphoneChunk);
  assert.equal(guard.shouldIgnoreTranscriptSegment(1, false, 1_000), false);

  guard.beginAIOutput();
  const guardedChunk = guard.audioChunkForASR(microphoneChunk, 1_100);
  assert.notEqual(guardedChunk, microphoneChunk);
  assert.deepEqual([...new Uint8Array(guardedChunk)], [0, 0, 0, 0]);
  assert.equal(guard.shouldIgnoreTranscriptSegment(2, false, 1_100), true);

  guard.beginAIOutput();
  guard.endAIOutput(1_200);
  assert.equal(guard.isMicrophoneSuppressed(1_999), true);
  guard.endAIOutput(1_200);
  assert.equal(guard.isMicrophoneSuppressed(1_999), true);
  assert.equal(guard.isMicrophoneSuppressed(2_000), false);

  assert.equal(guard.shouldIgnoreTranscriptSegment(2, true, 2_100), true);
  assert.equal(guard.shouldIgnoreTranscriptSegment(3, true, 2_100), false);
});

scenario('AEC 可用时声学候选放行识别结果，重新采集后需要新候选', async () => {
  const guard = new CallSpeechDuplexGuard(800);
  const microphoneChunk = new Uint8Array([1, 2, 3, 4]).buffer;

  guard.setEchoCancellationEnabled(true);
  guard.beginAIOutput();

  assert.equal(guard.isMicrophoneSuppressed(1_000), false);
  assert.equal(guard.audioChunkForASR(microphoneChunk, 1_000), microphoneChunk);
  assert.equal(guard.shouldIgnoreTranscriptSegment(4, false, 1_000), true);
  guard.observeSpeechActivityDuringAIOutput();
  assert.equal(guard.shouldIgnoreTranscriptSegment(4, true, 1_100), false);

  guard.setEchoCancellationEnabled(false);
  guard.setEchoCancellationEnabled(true);
  assert.equal(guard.shouldIgnoreTranscriptSegment(5, false, 1_100), true);
  guard.observeSpeechActivityDuringAIOutput();
  assert.equal(guard.shouldIgnoreTranscriptSegment(5, true, 1_100), false);

  guard.endAIOutput(1_200);
  assert.equal(guard.isMicrophoneSuppressed(1_300), false);
  guard.reset();
  guard.observeSpeechActivityDuringAIOutput();
  assert.equal(guard.isMicrophoneSuppressed(1_300), false);
});

scenario('TTS 同一通话取消会清理当前任务和待播任务', async () => {
  const { deletedAudioUris, playedAudioUris } = resetRuntime();
  const synthesis = deferred();
  const synthesizedTexts = [];
  let globalStopCount = 0;
  fakeRuntime.synthesizeTextToSpeech = async ({ text }) => {
    synthesizedTexts.push(text);
    return synthesis.promise;
  };
  fakeRuntime.callAudioPlayback.stop = async () => {
    globalStopCount += 1;
  };

  const queue = new CallTTSPlaybackQueue();
  const first = queue.enqueueAISpeech({ callId: 'call-1', assistantId: null, text: '当前任务' });
  const second = queue.enqueueAISpeech({ callId: 'call-1', assistantId: null, text: '待播任务' });
  await waitFor(() => synthesizedTexts.length === 1, 'TTS 合成任务未启动');
  await queue.stopCallPlayback('call-1');
  synthesis.resolve({
    success: true,
    audioUri: 'file:///cancelled.mp3',
    mimeType: 'audio/mpeg',
    modelConfigId: 'tts-1',
    modelConfigName: 'TTS',
    model: 'tts-model',
  });
  await Promise.all([first, second]);

  assert.equal(globalStopCount, 1);
  assert.deepEqual(synthesizedTexts, ['当前任务']);
  assert.deepEqual(playedAudioUris, []);
  assert.deepEqual(deletedAudioUris, ['file:///cancelled.mp3']);
});

scenario('用户开始说话会中断 AI 播放', async () => {
  const { callRepository, deletedAudioUris, playedAudioUris } = resetRuntime();
  const playbackFinished = deferred();
  let sessionStopCount = 0;
  fakeRuntime.callAudioPlayback.play = async (uri) => {
    playedAudioUris.push(uri);
    return {
      playbackId: 'playback-active',
      uri,
      finished: playbackFinished.promise,
      async stop() {
        sessionStopCount += 1;
        playbackFinished.resolve();
      },
    };
  };

  const queue = new CallTTSPlaybackQueue();
  const playing = queue.enqueueAISpeech({
    callId: 'call-1',
    assistantId: 'assistant-1',
    text: '正在播放',
  });
  await waitFor(() => playedAudioUris.length === 1, 'AI 语音未进入播放阶段');
  assert.equal(await queue.interruptForUserSpeech('call-1'), true);
  await playing;

  assert.equal(sessionStopCount, 1);
  assert.ok(deletedAudioUris.includes('file:///正在播放.mp3'));
  assert.ok(callRepository.events.some((event) => event.kind === 'ttsInterrupted'));
  assert.ok(!callRepository.events.some((event) => event.kind === 'ttsEnded'));
  const interrupted = callRepository.events.find((event) => event.kind === 'ttsInterrupted');
  assert.deepEqual(JSON.parse(interrupted.payloadJson), {
    reason: 'userSpeech',
    phase: 'playing',
    interruptedText: '正在播放',
  });
});

scenario('TTS 单个任务失败后队列继续处理后续任务', async () => {
  const callRepository = createCallRepository();
  const { playedAudioUris } = resetRuntime(callRepository);
  const synthesizedTexts = [];
  fakeRuntime.synthesizeTextToSpeech = async ({ text }) => {
    synthesizedTexts.push(text);
    if (text === '失败任务') {
      throw new Error('TTS 合成异常');
    }
    return {
      success: true,
      audioUri: 'file:///recovered.mp3',
      mimeType: 'audio/mpeg',
      modelConfigId: 'tts-1',
      modelConfigName: 'TTS',
      model: 'tts-model',
    };
  };
  callRepository.appendFailuresRemaining = 1;

  const queue = new CallTTSPlaybackQueue();
  const first = queue.enqueueAISpeech({ callId: 'call-1', assistantId: null, text: '失败任务' });
  const second = queue.enqueueAISpeech({ callId: 'call-1', assistantId: null, text: '恢复任务' });
  const results = await Promise.allSettled([first, second]);

  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(synthesizedTexts, ['失败任务', '恢复任务']);
  assert.deepEqual(playedAudioUris, ['file:///recovered.mp3']);
  assert.ok(callRepository.events.some((event) => event.kind === 'ttsEnded'));
});

scenario('两次来电预检均读到空闲时，失败方不创建第二通也不发通知', async () => {
  const repository = createCallRepository([]);
  resetRuntime(repository);
  const permissions = deferred();
  let checked = 0;
  let posted = 0;
  fakeRuntime.requestNotificationPermission = async () => {
    checked += 1;
    if (checked === 2) permissions.resolve();
    await permissions.promise;
    return true;
  };
  fakeRuntime.sendAIIncomingCallNotification = async () => { posted += 1; return true; };
  const service = new AICallRuntimeService({ callRepo: repository, chat: fakeRuntime.chat });
  const results = await Promise.all(['a', 'b'].map(id => service.requestIncomingCall({
    chatSessionId: `chat-${id}`, aiConfig: createAIConfig({ id }),
    payload: { reason: '聊聊', urgency: 'normal', openingLine: '你好', expectedMode: 'video' },
  })));
  assert.equal(results.filter(result => result.status === 'ringing').length, 1);
  assert.equal(results.find(result => result.status === 'failed').call, null);
  assert.equal(repository.sessions.size, 1);
  assert.equal(posted, 1);
  await service.markIncomingCallMissed(results.find(result => result.status === 'ringing').call.id);
});

scenario('真实仓储并发创建来电与去电只有一个占用，终态后可再次创建', async () => {
  resetRuntime(createCallRepository());
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMAS.modelServices);
  db.exec(SCHEMAS.aiAssistants);
  db.exec(SCHEMAS.sessions);
  db.exec(SCHEMAS.callSessions);
  db.exec(SCHEMAS.mediaAssets);
  db.exec(SCHEMAS.callHistory);
  db.prepare(`INSERT INTO ai_assistants (id, agent_id, name, model, created_at, updated_at)
    VALUES ('ai', 'agent', 'AI', 'model', '2026-10-12', '2026-10-12')`).run();
  db.prepare(`INSERT INTO sessions (id, ai_assistant_id, name, created_at, updated_at)
    VALUES ('chat', 'ai', 'chat', '2026-10-12', '2026-10-12')`).run();
  const executor = createSqliteExecutor(db);
  let tail = Promise.resolve();
  fakeRuntime.databaseCoordinator = {
    transaction(_meta, operation) {
      const next = tail.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try { const result = await operation(executor); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const repository = new SQLiteCallRepository();
  const input = { chatSessionId: 'chat', aiAssistantId: 'ai', agentId: 'agent', requestedMode: 'video', source: 'aiTool' };
  try {
    for (const directions of [['incoming', 'incoming'], ['incoming', 'outgoing']]) {
      db.exec('DELETE FROM call_sessions');
      const calls = await Promise.all(directions.map((direction, index) => repository.createSessionIfIdle({
        ...input, id: `parallel-${index}`, direction, state: direction === 'incoming' ? 'ringing' : 'dialing',
      })));
      assert.equal(calls.filter(Boolean).length, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM call_sessions').get().count, 1);
      db.prepare("UPDATE call_sessions SET state = 'ended'").run();
      assert.ok(await repository.createSessionIfIdle({ ...input, id: 'next', direction: 'incoming', state: 'ringing' }));
    }
  } finally { db.close(); }
});

let activeScenario = '初始化';
try {
  for (const item of scenarios) {
    activeScenario = item.name;
    await item.execute();
  }
  console.log(`Calls 运行时契约检查通过（${scenarios.length} 个场景）。`);
} catch (error) {
  console.error(`Calls 运行时契约检查失败：${activeScenario}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  delete globalThis.__callsContractFakes;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
