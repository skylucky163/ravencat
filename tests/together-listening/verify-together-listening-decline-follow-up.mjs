/** LISTEN-5 用户拒绝 AI 一起听邀请后的 standalone follow-up 决策验证。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-decline-follow-up-'));

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.equal(
    (output.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error).length,
    0,
    `TypeScript 转译失败：${relativePath}`,
  );
  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function write(relativePath, source) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, 'utf8');
}

const FOLLOW_UP_MODULE = path.join(
  tempRoot,
  'src/features/togetherListening/application/PostUserDeclineFollowUp.js',
);

function resetState() {
  globalThis.__listen5 = {
    snapshot: {
      capturedAtEpochMs: 1,
      currentHostAiId: 'host-1',
      netease: {
        available: true,
        playbackState: 'playing',
        mediaId: 'song-1',
        title: '夜曲',
        artist: '周杰伦',
        album: '十一月的萧邦',
      },
      activity: null,
    },
    currentHostId: 'host-1',
    aiConfigs: {
      'host-1': {
        id: 'host-1',
        agentId: 'agent-1',
        name: '小R',
        avatar: 'avatar://host-1',
        model: 'test-model',
        apiKey: 'key',
        apiBaseUrl: 'https://api.example.com',
        systemPrompt: '你是用户的好朋友小R。',
        temperature: 0.7,
        topP: 1,
        maxTokens: 100,
      },
    },
    modelResponse: null,
    modelError: null,
    onDecision: null,
    appendShouldFail: false,
    declineProjectionFailed: false,
    standaloneCalls: [],
    decisionCalls: [],
    clientConfigs: [],
    appended: [],
    appendAttempts: 0,
    eventOrder: [],
    chat: {
      async commit() {
        return { userMessage: null, success: false, error: null };
      },
      async upsert() {
        return { message: { id: 1 }, inserted: false };
      },
    },
    together: {
      captureTogetherListeningRuntimeSnapshot: async () => ({
        ...globalThis.__listen5.snapshot,
        activity: globalThis.__listen5.snapshot.activity
          ? { ...globalThis.__listen5.snapshot.activity }
          : null,
      }),
      declineTogetherListeningInvitationByUser: async () => {
        const state = globalThis.__listen5;
        const activity = state.snapshot.activity;
        if (activity.phase !== 'pending_user_response') {
          return { status: 'already_terminal', activity };
        }
        state.snapshot.activity = {
          ...activity,
          phase: 'declined_by_user',
          updatedAtEpochMs: 2,
          endedAtEpochMs: 2,
        };
        // 模拟 lifecycle commit 后的卡片终态投影，用于断言 follow-up 发生在投影之后。
        state.eventOrder.push('card_patch');
        return {
          status: 'transitioned',
          activity: state.snapshot.activity,
          projectionStatus: state.declineProjectionFailed ? 'failed' : 'projected',
        };
      },
      endTogetherListeningActivity: async ({ reason }) => {
        const state = globalThis.__listen5;
        state.snapshot.activity = {
          ...state.snapshot.activity,
          phase: 'ended',
          endReason: reason,
          updatedAtEpochMs: 2,
          endedAtEpochMs: 2,
        };
        return {
          status: 'transitioned',
          activity: state.snapshot.activity,
          projectionStatus: 'projected',
        };
      },
      acceptTogetherListeningInvitationByUser: async () => {
        throw new Error('本验证不涉及 accept');
      },
      leaveTogetherListeningActivityByUser: async () => {
        throw new Error('本验证不涉及 leave');
      },
      createUserTogetherListeningInvitation: async () => {
        throw new Error('本验证不涉及用户邀请');
      },
      isExplicitTogetherListeningMediaLoss: (netease) => !netease.available
        && ['no_active_session', 'playback_stopped', 'playback_none', 'playback_error']
          .includes(netease.reason),
    },
    createClient(config) {
      const state = globalThis.__listen5;
      state.clientConfigs.push(config);
      return {
        async chat(messages, options) {
          state.decisionCalls.push({ messages, options });
          state.eventOrder.push('decision');
          if (state.onDecision) state.onDecision();
          if (state.modelError) return { success: false, error: state.modelError };
          return { success: true, text: state.modelResponse };
        },
      };
    },
  };
}

resetState();

write('node_modules/@shared/runtime/RuntimeSlot.js', `
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
write('node_modules/@platform/ai/index.js', `
exports.createAIClient = (config) => globalThis.__listen5.createClient(config);
`);
write('node_modules/@features/assistants/index.js', `
exports.aiAssistantRepository = { getById: async (id) => globalThis.__listen5.aiConfigs[id] ?? null };
exports.getAssistantDisplayName = (assistant) => assistant.nickname ?? assistant.name;
`);
write('node_modules/@features/chat/composition.js', `
exports.commitTogetherListeningUserInvitation = (...args) => globalThis.__listen5.chat.commit(...args);
exports.upsertTogetherListeningTimelineEntry = (...args) => globalThis.__listen5.chat.upsert(...args);
`);
write('node_modules/@features/togetherListening/index.js', `
module.exports = {
  ...require(${JSON.stringify(FOLLOW_UP_MODULE)}),
  ...globalThis.__listen5.together,
};
`);

compile('src/features/togetherListening/application/TogetherListeningRuntime.ts');
compile('src/features/togetherListening/application/TogetherListeningPromptBlocks.ts');
compile('src/features/togetherListening/application/PostUserDeclineFollowUp.ts');
compile('src/host/composition/createChatTogetherListeningGateway.ts');

const runtime = require(path.join(
  tempRoot,
  'src/features/togetherListening/application/TogetherListeningRuntime.js',
));
const {
  parsePostListeningInviteDeclinedDecision,
  runPostUserDeclineFollowUp,
} = require(FOLLOW_UP_MODULE);
const { createChatTogetherListeningGateway } = require(path.join(
  tempRoot,
  'src/host/composition/createChatTogetherListeningGateway.js',
));

runtime.configureTogetherListeningRuntimeDependencies({
  repository: {},
  chat: { async projectActivityToChat() {} },
  systemPresentation: {
    async upsertActivePresentation() {},
    async cancelPresentation() {},
  },
  declineFollowUp: {
    resolveAIConfig: async (aiId) => globalThis.__listen5.aiConfigs[aiId] ?? null,
    assembleStandalonePromptPack: async (params) => {
      globalThis.__listen5.standaloneCalls.push(params);
      return {
        systemPrompt: 'system',
        modelMessages: [{ role: 'user', content: params.currentInput }],
      };
    },
    appendExternalAssistantMessage: async (input) => {
      const state = globalThis.__listen5;
      state.appendAttempts += 1;
      state.eventOrder.push('append');
      if (state.appendShouldFail) {
        throw new Error('chat append failure');
      }
      state.appended.push(input);
      return { committedMessageId: 1 };
    },
  },
  generateId: () => 'generated-id',
  nowEpochMs: () => 1,
  observeNetEasePlayback: async () => ({
    status: 'snapshot_available',
    playbackState: 'playing',
    mediaId: 'song-1',
    title: '夜曲',
    artist: '周杰伦',
    album: '十一月的萧邦',
  }),
  getCurrentHostAIId: async () => globalThis.__listen5.currentHostId,
  resolveSystemPresentationAIIdentity: async () => ({ name: 'Host', avatar: null }),
});

const gateway = createChatTogetherListeningGateway();
const hostContext = { chatSessionId: 'chat-1', aiConfig: { id: 'host-1', isHostAI: true } };

function pendingAiInvitation(id = 'activity-1') {
  globalThis.__listen5.snapshot.activity = {
    id,
    hostAiId: 'host-1',
    chatSessionId: 'chat-1',
    initiator: 'ai',
    phase: 'pending_user_response',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
    activatedAtEpochMs: null,
    endedAtEpochMs: null,
    endReason: null,
  };
}

// --- C：严格 parser -------------------------------------------------------

assert.deepEqual(
  parsePostListeningInviteDeclinedDecision('{"decision":"send_message","message":" 好吧，下次再一起听 "}'),
  { decision: 'send_message', message: '好吧，下次再一起听' },
);
assert.deepEqual(
  parsePostListeningInviteDeclinedDecision('{"decision":"stay_silent","message":null}'),
  { decision: 'stay_silent', message: null },
);
for (const invalid of [
  '{}',
  '{"decision":"send_message","message":"你好","extra":1}',
  '{"decision":"send_message"}',
  '{"decision":"send_message","message":""}',
  '{"decision":"send_message","message":"   "}',
  '{"decision":"send_message","message":null}',
  '{"decision":"stay_silent","message":"你好"}',
  '{"decision":"silent","message":null}',
  '{"decision":"none","message":null}',
  '```json\n{"decision":"stay_silent","message":null}\n```',
  '["send_message"]',
  'null',
  'not json',
]) {
  assert.throws(
    () => parsePostListeningInviteDeclinedDecision(invalid),
    /together_listening\.post_user_decline/,
    `parser 必须拒绝：${invalid}`,
  );
}

// --- A：send_message -------------------------------------------------------

resetState();
pendingAiInvitation();
globalThis.__listen5.modelResponse = '{"decision":"send_message","message":"没关系，想听的时候叫我。"}';
const sendResult = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(sendResult.status, 'invitation_declined');
assert.equal(sendResult.activity?.phase, 'declined_by_user');

const stateA = globalThis.__listen5;
assert.equal(stateA.standaloneCalls.length, 1, '成功拒绝后必须恰好一次 standalone decision');
const standaloneParams = stateA.standaloneCalls[0];
assert.equal(standaloneParams.scenarioId, 'together_listening.post_user_decline');
assert.equal(standaloneParams.assistantId, 'host-1');
assert.deepEqual(
  standaloneParams.blocks.map((block) => block.definitionId),
  [
    'persona.assistant',
    'scenario.together_listening_post_user_decline',
    'output.together_listening_post_user_decline_json',
  ],
);
const declineInput = JSON.parse(standaloneParams.currentInput);
assert.equal(declineInput.task, 'post_user_decline');
assert.deepEqual(declineInput.activity, {
  id: 'activity-1',
  chatSessionId: 'chat-1',
  initiator: 'ai',
  phase: 'declined_by_user',
  hostAiId: 'host-1',
  createdAtEpochMs: 1,
  endedAtEpochMs: 2,
});
assert.equal(stateA.decisionCalls.length, 1);
assert.equal(stateA.decisionCalls[0].options.responseFormat, 'json_object');
assert.equal(stateA.decisionCalls[0].options.allowReasoningLengthRetry, false);
assert.ok(stateA.clientConfigs[0].maxTokens >= 300);
assert.equal(stateA.appended.length, 1, 'send_message 必须追加一条普通 assistant 消息');
assert.equal(stateA.appended[0].text, '没关系，想听的时候叫我。');
assert.equal(stateA.appended[0].sessionId, 'chat-1');
assert.equal(stateA.appended[0].aiId, 'host-1');
assert.equal(stateA.appended[0].deliveryKind, 'passive');
assert.equal(stateA.appended[0].triggerSource, 'together_listening');
assert.equal(stateA.appended[0].relatedEntityType, 'togetherListeningActivity');
assert.equal(stateA.appended[0].relatedEntityId, 'activity-1');
assert.deepEqual(
  stateA.eventOrder,
  ['card_patch', 'decision', 'append'],
  'follow-up 必须发生在卡片终态投影之后',
);

// --- D：重复拒绝 / late decline 不得再次触发 --------------------------------

const duplicate = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(duplicate.status, 'transition_conflict');
assert.equal(duplicate.reason, 'invalid_phase');
assert.equal(globalThis.__listen5.standaloneCalls.length, 1, 'late decline 不得再次触发 decision');
assert.equal(globalThis.__listen5.appended.length, 1, 'late decline 不得再次追加消息');

// --- B：stay_silent ---------------------------------------------------------

resetState();
pendingAiInvitation();
globalThis.__listen5.aiConfigs['host-1'].maxTokens = null;
globalThis.__listen5.modelResponse = '{"decision":"stay_silent","message":null}';
const silentResult = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(silentResult.status, 'invitation_declined');
assert.equal(globalThis.__listen5.decisionCalls.length, 1);
assert.equal(globalThis.__listen5.clientConfigs[0].maxTokens, null);
assert.equal(globalThis.__listen5.appended.length, 0, 'stay_silent 不得追加任何消息');
assert.equal(globalThis.__listen5.appendAttempts, 0);

// --- E：用户邀请被 AI 拒绝不得进入本 follow-up ------------------------------

resetState();
await runPostUserDeclineFollowUp({
  id: 'activity-user',
  hostAiId: 'host-1',
  chatSessionId: 'chat-1',
  initiator: 'user',
  phase: 'declined_by_ai',
  createdAtEpochMs: 1,
  updatedAtEpochMs: 2,
  activatedAtEpochMs: null,
  endedAtEpochMs: 2,
  endReason: null,
});
assert.equal(globalThis.__listen5.standaloneCalls.length, 0, 'declined_by_ai 不得触发 follow-up');

// --- F：media_unavailable 结束不得触发 ---------------------------------------

resetState();
pendingAiInvitation();
globalThis.__listen5.snapshot.netease = { available: false, reason: 'playback_stopped' };
const mediaLoss = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(mediaLoss.status, 'unavailable');
assert.equal(mediaLoss.reason, 'media_unavailable');
assert.equal(mediaLoss.activity?.phase, 'ended');
assert.equal(globalThis.__listen5.standaloneCalls.length, 0, 'media_unavailable 不得触发 follow-up');

// --- G：决策开始前 Host 已易主 -----------------------------------------------

resetState();
globalThis.__listen5.currentHostId = 'host-2';
await runPostUserDeclineFollowUp({
  id: 'activity-1',
  hostAiId: 'host-1',
  chatSessionId: 'chat-1',
  initiator: 'ai',
  phase: 'declined_by_user',
  createdAtEpochMs: 1,
  updatedAtEpochMs: 2,
  activatedAtEpochMs: null,
  endedAtEpochMs: 2,
  endReason: null,
});
assert.equal(globalThis.__listen5.standaloneCalls.length, 0, 'stale Host 不得运行旧 Host 的 decision');
assert.equal(globalThis.__listen5.appended.length, 0);

// --- H：模型决策期间 Host 易主 -------------------------------------------------

resetState();
globalThis.__listen5.modelResponse = '{"decision":"send_message","message":"好吧。"}';
globalThis.__listen5.onDecision = () => {
  globalThis.__listen5.currentHostId = 'host-2';
};
await runPostUserDeclineFollowUp({
  id: 'activity-1',
  hostAiId: 'host-1',
  chatSessionId: 'chat-1',
  initiator: 'ai',
  phase: 'declined_by_user',
  createdAtEpochMs: 1,
  updatedAtEpochMs: 2,
  activatedAtEpochMs: null,
  endedAtEpochMs: 2,
  endReason: null,
});
assert.equal(globalThis.__listen5.decisionCalls.length, 1);
assert.equal(globalThis.__listen5.appendAttempts, 0, 'Host 决策期间易主后不得落库旧 Host 消息');

// --- I：模型失败时拒绝结果保持成功 ---------------------------------------------

resetState();
pendingAiInvitation();
globalThis.__listen5.modelError = 'model api down';
const modelFailed = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(modelFailed.status, 'invitation_declined', 'follow-up 模型失败不得改变拒绝结果');
assert.equal(modelFailed.activity?.phase, 'declined_by_user');
assert.equal(globalThis.__listen5.appended.length, 0);

// --- J：parse 失败时拒绝结果保持成功 -------------------------------------------

resetState();
pendingAiInvitation();
globalThis.__listen5.modelResponse = '```json\n{"decision":"send_message","message":"hi"}\n```';
const parseFailed = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(parseFailed.status, 'invitation_declined', 'follow-up parse 失败不得改变拒绝结果');
assert.equal(parseFailed.activity?.phase, 'declined_by_user');
assert.equal(globalThis.__listen5.appended.length, 0);

// --- K：append 失败时拒绝结果保持成功 ------------------------------------------

resetState();
pendingAiInvitation();
globalThis.__listen5.modelResponse = '{"decision":"send_message","message":"没关系。"}';
globalThis.__listen5.appendShouldFail = true;
const appendFailed = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(appendFailed.status, 'invitation_declined', 'Chat append 失败不得改变拒绝结果');
assert.equal(appendFailed.activity?.phase, 'declined_by_user');
assert.equal(globalThis.__listen5.appendAttempts, 1);
assert.equal(globalThis.__listen5.snapshot.activity.phase, 'declined_by_user', 'append 失败不得改写 Activity');

// --- L：declined 卡片 projection 失败时不得运行 follow-up ---------------------

resetState();
pendingAiInvitation();
globalThis.__listen5.declineProjectionFailed = true;
const projectionFailed = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(projectionFailed.status, 'invitation_declined');
assert.equal(projectionFailed.reason, 'chat_projection_failed');
assert.equal(
  globalThis.__listen5.snapshot.activity.phase,
  'declined_by_user',
  'projection 失败不得回滚或改写 Activity truth',
);
assert.equal(globalThis.__listen5.standaloneCalls.length, 0, 'projection 失败不得运行 standalone decision');
assert.equal(globalThis.__listen5.decisionCalls.length, 0, 'projection 失败不得调用模型决策');
assert.equal(globalThis.__listen5.appendAttempts, 0, 'projection 失败不得尝试 append');
assert.equal(globalThis.__listen5.appended.length, 0, 'projection 失败不得产生可见 assistant 消息');

// projection 失败后的 late decline 仍不得触发 follow-up。
const lateAfterProjectionFailure = await gateway.decline({ ...hostContext, activityId: 'activity-1' });
assert.equal(lateAfterProjectionFailure.status, 'transition_conflict');
assert.equal(lateAfterProjectionFailure.reason, 'invalid_phase');
assert.equal(globalThis.__listen5.standaloneCalls.length, 0, 'late decline 仍不得触发 follow-up');
assert.equal(globalThis.__listen5.appendAttempts, 0);

// --- 静态边界：standalone decision 无 Tool、无 wake、无第二套 Chat writer -------

const followUpSource = fs.readFileSync(
  path.join(repoRoot, 'src/features/togetherListening/application/PostUserDeclineFollowUp.ts'),
  'utf8',
);
const gatewaySource = fs.readFileSync(
  path.join(repoRoot, 'src/host/composition/createChatTogetherListeningGateway.ts'),
  'utf8',
);
for (const forbidden of [
  'createAgentToolRegistry',
  'runHostAgent',
  'allowedToolNames',
  'requestProactiveChatReply',
  'scheduleSelfWake',
  'invite_listening_together',
  'respond_to_listening_invitation',
  'leave_listening_together',
]) {
  assert.equal(
    followUpSource.includes(forbidden),
    false,
    `follow-up 不得引用 ${forbidden}`,
  );
}
for (const forbiddenImport of [
  '@features/chat',
  '@features/calls',
  '@features/assistants',
  '@host/',
]) {
  assert.equal(
    followUpSource.includes(forbiddenImport),
    false,
    `follow-up 不得静态依赖 ${forbiddenImport}`,
  );
}
assert.equal(
  gatewaySource.includes('declined_waiting_followup')
    || gatewaySource.includes('declined_message_sent')
    || gatewaySource.includes('declined_silent'),
  false,
  '不得为 follow-up 新增 Activity phase',
);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('LISTEN-5 用户拒绝 follow-up：触发边界、严格 JSON、Host authority、失败隔离与无 Tool 检查通过。');
