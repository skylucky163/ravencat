import { repoRoot } from '../helpers/repo-root.mjs';
import { CHAT_PROMPT_READING_FLOW } from '../helpers/prompt-reading-flow.mjs';
/** LISTEN-2 eligibility、reconciliation、Prompt 注入与单轮 snapshot 一致性验证。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-awareness-'));

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(errors.length, 0, `TypeScript 转译失败：${relativePath}`);
  const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
}

function write(relativePath, source) {
  const outputPath = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, source, 'utf8');
}

function load(relativePath) {
  return require(path.join(tempRoot, relativePath.replace(/\.ts$/, '.js')));
}

write('node_modules/@shared/runtime/RuntimeSlot.js', `
exports.createRuntimeSlot = () => {
  let value;
  return { configure(next) { value = next; }, get() { return value; } };
};
`);

for (const relativePath of [
  'src/features/togetherListening/domain/TogetherListeningActivity.ts',
  'src/features/togetherListening/domain/TogetherListeningRepository.ts',
  'src/features/togetherListening/application/TogetherListeningRuntime.ts',
  'src/features/togetherListening/application/TogetherListeningChangedSignal.ts',
  'src/features/togetherListening/application/TogetherListeningSystemPresentation.ts',
  'src/features/togetherListening/application/TogetherListeningLifecycle.ts',
  'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts',
  'src/features/togetherListening/application/LeaveTogetherListeningByUser.ts',
]) compile(relativePath);

const runtime = load('src/features/togetherListening/application/TogetherListeningRuntime.ts');
const awareness = load('src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts');

const baseObservation = {
  status: 'snapshot_available',
  mediaId: 'song-1',
  title: '夜曲',
  artist: '周杰伦',
  album: '十一月的萧邦',
  audioOutput: null,
};
for (const state of ['playing', 'paused', 'buffering', 'connecting']) {
  const availability = awareness.resolveTogetherListeningNetEaseAvailability({
    ...baseObservation,
    playbackState: state,
  });
  assert.equal(availability.available, true, `${state} 应 available`);
}
const unavailableStates = new Map([
  ['stopped', 'playback_stopped'],
  ['none', 'playback_none'],
  ['error', 'playback_error'],
  ['fast_forwarding', 'unsupported_playback_state'],
  ['rewinding', 'unsupported_playback_state'],
  ['skipping_to_previous', 'unsupported_playback_state'],
  ['skipping_to_next', 'unsupported_playback_state'],
  ['skipping_to_queue_item', 'unsupported_playback_state'],
  ['unknown', 'unsupported_playback_state'],
]);
for (const [state, reason] of unavailableStates) {
  assert.deepEqual(
    awareness.resolveTogetherListeningNetEaseAvailability({
      ...baseObservation,
      playbackState: state,
    }).reason,
    reason,
    `${state} 必须显式、保守地 unavailable`,
  );
}
const missingTitle = awareness.resolveTogetherListeningNetEaseAvailability({
  ...baseObservation,
  playbackState: 'playing',
  title: '   ',
});
assert.equal(missingTitle.available, false);
assert.equal(missingTitle.reason, 'missing_title');

function activity(phase = 'active', hostAiId = 'host-a') {
  return {
    id: 'activity-1', hostAiId, chatSessionId: 'chat-1', initiator: 'user', phase,
    createdAtEpochMs: 1, updatedAtEpochMs: 1, activatedAtEpochMs: 1,
    endedAtEpochMs: null, endReason: null,
  };
}
const available = awareness.resolveTogetherListeningNetEaseAvailability({
  ...baseObservation,
  playbackState: 'playing',
});
const statusItems = awareness.buildUserRuntimeStatusItems({
  capturedAtEpochMs: 10,
  netease: available,
  activity: null,
});
assert.deepEqual(statusItems, [{
  key: 'netease_playback',
  text: '正在听歌：网易云音乐《夜曲》 — 周杰伦',
  source: 'system',
  writePolicy: 'system_only',
  updatedAtEpochMs: 10,
}]);
// 同一歌曲的系统输出变化必须出现在下一轮快照中，不改变 Activity。
for (const deviceName of ['手机扬声器', '有线耳机', '用户的蓝牙设备']) {
  const items = awareness.buildUserRuntimeStatusItems({
    capturedAtEpochMs: 10,
    netease: { ...available, audioOutput: { playbackType: 'local', deviceNames: [deviceName] } },
    activity: activity(),
  });
  assert.equal(items.length, 2);
  assert.equal(items[1].key, 'media_audio_output');
  assert.ok(items[1].text.includes(deviceName));
}
const remoteOutputItems = awareness.buildUserRuntimeStatusItems({
  capturedAtEpochMs: 10,
  netease: { ...available, audioOutput: { playbackType: 'remote', deviceNames: [] } },
  activity: activity(),
});
assert.match(remoteOutputItems[1].text, /远程播放/);
assert.doesNotMatch(remoteOutputItems[1].text, /手机扬声器/);
for (const status of ['no_active_session', 'permission_not_granted', 'observation_failed']) {
  const netease = awareness.resolveTogetherListeningNetEaseAvailability({ status });
  assert.deepEqual(awareness.buildUserRuntimeStatusItems({
    capturedAtEpochMs: 10,
    netease,
    activity: null,
  }), []);
}

let observation = { status: 'no_active_session' };
let currentActivity = activity('pending_ai_response');
let observationReads = 0;
let transitions = 0;
let currentHostAIId = 'host-a';
const repository = {
  async getCurrent() {
    return currentActivity && ['pending_user_response', 'pending_ai_response', 'active'].includes(currentActivity.phase)
      ? currentActivity : null;
  },
  async getById() { return currentActivity; },
  async createIfNoCurrent() { throw new Error('not used'); },
  async transitionActivityIfPhase(id, expectedPhases, patch) {
    transitions += 1;
    if (id !== currentActivity.id || !expectedPhases.includes(currentActivity.phase)) return null;
    currentActivity = { ...currentActivity, ...patch };
    return currentActivity;
  },
};
runtime.configureTogetherListeningRuntimeDependencies({
  repository,
  chat: { projectActivityToChat: async () => {} },
  systemPresentation: {
    upsertActivePresentation: async () => {},
    cancelPresentation: async () => {},
  },
  declineFollowUp: {},
  generateId: () => 'unused',
  nowEpochMs: () => 20,
  observeNetEasePlayback: async () => {
    observationReads += 1;
    return observation;
  },
  getCurrentHostAIId: async () => currentHostAIId,
  resolveSystemPresentationAIIdentity: async () => ({ name: 'Host', avatar: null }),
});
const captured = await awareness.captureTogetherListeningRuntimeSnapshot();
assert.equal(observationReads, 1, '一次 capture 只能观察一次网易云');
const reconciled = await awareness.reconcileTogetherListeningRuntime(captured);
assert.equal(transitions, 1);
assert.equal(currentActivity.phase, 'ended');
assert.equal(currentActivity.endReason, 'media_unavailable');
assert.equal(reconciled.activity, null);

currentActivity = activity('active');
observation = { status: 'observation_failed' };
const transient = await awareness.reconcileTogetherListeningRuntime(
  await awareness.captureTogetherListeningRuntimeSnapshot(),
);
assert.equal(transient.activity.phase, 'active');
assert.equal(transitions, 1, '临时观察失败不得结束 Activity');

currentActivity = activity('active', 'host-a');
observation = { ...baseObservation, playbackState: 'playing' };
currentHostAIId = 'host-b';
const authorityReconciled = await awareness.reconcileTogetherListeningRuntime(
  await awareness.captureTogetherListeningRuntimeSnapshot(),
);
assert.equal(currentActivity.phase, 'ended');
assert.equal(currentActivity.endReason, 'host_authority_lost');
assert.equal(authorityReconciled.activity, null, 'Host 切换后旧 Activity 不得转移给新 Host');

// 冷启动 system presentation 恢复：先 canonical reconciliation，再按最终 Activity 投影。
const coldStartUpserts = [];
const coldStartCancels = [];
runtime.configureTogetherListeningRuntimeDependencies({
  repository,
  chat: { projectActivityToChat: async () => {} },
  systemPresentation: {
    upsertActivePresentation: async (state) => { coldStartUpserts.push(state); },
    cancelPresentation: async (activityId) => { coldStartCancels.push(activityId ?? null); },
  },
  declineFollowUp: {},
  generateId: () => 'unused',
  nowEpochMs: () => 20,
  observeNetEasePlayback: async () => observation,
  getCurrentHostAIId: async () => currentHostAIId,
  resolveSystemPresentationAIIdentity: async () => ({ name: 'Host', avatar: null }),
});

currentActivity = activity('active', 'host-a');
currentHostAIId = 'host-a';
observation = { ...baseObservation, playbackState: 'playing' };
await awareness.reconcileTogetherListeningSystemPresentation();
assert.equal(coldStartUpserts.at(-1).activityId, currentActivity.id, '运行时健康的 active 必须恢复投影');

currentActivity = activity('active', 'host-a');
currentHostAIId = 'host-b';
let upsertCountBefore = coldStartUpserts.length;
await awareness.reconcileTogetherListeningSystemPresentation();
assert.equal(currentActivity.phase, 'ended', 'Host authority 丢失的残留 active 必须先收口');
assert.equal(currentActivity.endReason, 'host_authority_lost');
assert.equal(coldStartUpserts.length, upsertCountBefore, '残留 active 不得重新发布 system surface');
assert.equal(coldStartCancels.at(-1), null, '收口后必须清理 system surface');

currentActivity = activity('active', 'host-a');
currentHostAIId = 'host-a';
observation = { status: 'no_active_session' };
upsertCountBefore = coldStartUpserts.length;
await awareness.reconcileTogetherListeningSystemPresentation();
assert.equal(currentActivity.endReason, 'media_unavailable', '网易云明确终态必须先收口');
assert.equal(coldStartUpserts.length, upsertCountBefore);

currentActivity = activity('active', 'host-a');
observation = { status: 'observation_failed' };
await awareness.reconcileTogetherListeningSystemPresentation();
assert.equal(currentActivity.phase, 'active', 'transient 观察失败不得误杀 Activity');
assert.equal(coldStartUpserts.at(-1).activityId, currentActivity.id, 'transient 失败仍按 active 投影');

currentActivity = null;
await awareness.reconcileTogetherListeningSystemPresentation();
assert.equal(coldStartCancels.at(-1), null, 'idle 启动必须清理 stale presentation');

write('node_modules/@features/togetherListening/index.js', `
exports.captureTogetherListeningRuntimeSnapshot = (...args) => globalThis.__listenCapture(...args);
exports.reconcileTogetherListeningRuntime = (...args) => globalThis.__listenReconcile(...args);
exports.buildUserRuntimeStatusItems = (...args) => globalThis.__listenBuildStatus(...args);
exports.readTogetherListeningCurrentLyric = (...args) => globalThis.__listenReadLyric(...args);
`);
compile('src/host/prompt/TogetherListeningPromptBlock.ts');
const promptBlock = load('src/host/prompt/TogetherListeningPromptBlock.ts');
globalThis.__listenBuildStatus = awareness.buildUserRuntimeStatusItems;
let lyricReads = 0;
globalThis.__listenReadLyric = async () => { lyricReads += 1; return { text: '这一句是当前歌词', startTimeMs: 10_000, positionMs: 12_000 }; };

compile('src/host/runtime/TogetherListeningRunPreparation.ts');
const runPreparation = load('src/host/runtime/TogetherListeningRunPreparation.ts');

function snapshot(song, phase = 'active', hostAiId = 'host-a') {
  return {
    capturedAtEpochMs: 30,
    currentHostAiId: 'host-a',
    netease: {
      available: true,
      playbackState: 'playing',
      mediaId: song,
      title: song,
      artist: `歌手-${song}`,
      album: null,
      audioOutput: null,
    },
    activity: activity(phase, hostAiId),
    currentLyric: null,
  };
}
const activeBlock = promptBlock.createTogetherListeningRuntimePromptBlock({
  snapshot: snapshot('Song A'), scenario: 'chat.private_reply',
});
assert.match(activeBlock.content, /【当前用户状态】[\s\S]*Song A/);
assert.match(activeBlock.content, /【当前共同活动】[\s\S]*你与用户正在一起听/);
assert.equal(activeBlock.required, true);
assert.equal(activeBlock.truncatable, false);
const currentLineBlock = promptBlock.createTogetherListeningRuntimePromptBlock({
  snapshot: { ...snapshot('Song A'), currentLyric: { text: '只传当前这一句', startTimeMs: 60_000, positionMs: 63_000 } },
  scenario: 'chat.private_reply',
});
assert.match(currentLineBlock.content, /1:03[\s\S]*只传当前这一句/);
// 用户退出 canonical Activity 后，即使网易云继续播放，下一轮也不再注入音乐资料。
currentActivity = activity();
currentHostAIId = 'host-a';
observation = { ...baseObservation, playbackState: 'playing',
  audioOutput: { playbackType: 'local', deviceNames: ['有线耳机'] } };
const userLeave = load('src/features/togetherListening/application/LeaveTogetherListeningByUser.ts');
const left = await userLeave.leaveTogetherListeningByUser({ activityId: currentActivity.id, source: 'in_app_indicator' });
assert.equal(left.status, 'left');
assert.equal(left.activity.endReason, 'user_left');
globalThis.__listenCapture = awareness.captureTogetherListeningRuntimeSnapshot;
globalThis.__listenReconcile = awareness.reconcileTogetherListeningRuntime;
const beforeLeaveLyricReads = lyricReads;
const afterLeavePreparation = await runPreparation.prepareTogetherListeningHostModelRun({
  scenario: 'chat.private_reply', currentAiId: 'host-a', isHostAI: true,
  persistentAllowedToolNames: [],
});
assert.deepEqual(afterLeavePreparation.additionalPromptBlocks, []);
assert.equal(lyricReads, beforeLeaveLyricReads, '退出后不读取歌词');
const unavailableActiveBlock = promptBlock.createTogetherListeningRuntimePromptBlock({
  snapshot: { ...snapshot('Song A'), netease: { available: false, reason: 'observation_failed', artist: null } },
  scenario: 'chat.private_reply',
});
assert.match(unavailableActiveBlock.content, /你与用户正在一起听/);
assert.match(unavailableActiveBlock.content, /暂不可用/);

write('node_modules/@shared/prompt/index.js', `
exports.CHAT_PROMPT_READING_FLOW = ${JSON.stringify(CHAT_PROMPT_READING_FLOW)};
exports.estimateTextTokens = (text) => Math.ceil(text.length / 4);
exports.renderPromptMessageWithTimestamp = require('../../../src/shared/prompt/messageTimestamp').renderPromptMessageWithTimestamp;
`);
write('node_modules/@features/prompting/index.js', `
exports.listPromptCustomBlocks = async () => [];
exports.resolveLegacyPromptPreset = async ({ scenarioId }) => ({ preset: globalThis.__listenGetPreset(scenarioId) });
exports.resolveAssistantPromptConfiguration = async () => ({
  overrides: {}, disabledDefinitionIds: [], userPrompts: [], timeEnabled: true, batteryEnabled: false, userStateEnabled: true, socialEnabled: true,
});
`);
write('src/host/prompt/DeviceBatteryPromptBlock.js', `exports.createDeviceBatteryPromptBlocks = async () => [];`);
write('src/host/prompt/PromptPackBlockFactory.js', `
const block = (key, definitionId, content = definitionId, extra = {}) => ({
  key, definitionId, slot: extra.slot || 'dynamic_context', protection: extra.protection || 'locked',
  title: definitionId, content, required: false, status: content ? 'ready' : 'omitted',
  truncatable: false, scenario: 'shared', placement: extra.placement || 'system',
});
exports.promptPackBlockFactory = {
  resolveUserIdentity: async () => ({ displayName: '用户', source: 'test' }),
  createFoundationBlock: () => block('foundation_default_core', 'foundation.default_core', 'foundation', { slot: 'foundation' }),
  createPersonaBlock: () => block('persona', 'persona.assistant', 'persona', { slot: 'persona', protection: 'editable' }),
  createProtocolPromptBlock: async () => block('protocol_space', 'context.protocol_space', 'protocol', { slot: 'user_rules' }),
  createUserIdentityBlock: () => block('user_identity_summary', 'context.user_identity', 'identity', { protection: 'overridable' }),
  createMomentSocialInboxBlock: async () => block('moments_social_inbox', 'context.moments_social_inbox', ''),
  createInteractionEnvironmentBlock: () => block('interaction_environment', 'context.interaction_environment', 'environment'),
  createRecentChatWindowBlock: () => block('recent_chat_window', 'history.recent_chat', '', { slot: 'history', placement: 'history' }),
  createTimeAwarenessBlock: () => block('time_awareness', 'context.time_awareness', 'time'),
  createScenarioContextBlock: () => null,
  createToolContextBlock: () => block('tool_context_explanation', 'context.tool_explanation', 'tools', { slot: 'capabilities' }),
  createAgentRegistrySummaryBlock: async () => block('agent_registry_summary', 'context.agent_registry', 'agents', { protection: 'overridable' }),
  createToolsDescriptionBlock: () => block('tools_description', 'context.tools_description', 'tools', { slot: 'capabilities' }),
  createGroupChatContextBlock: () => block('group_chat_context', 'context.group_chat', 'group', { slot: 'scenario' }),
  createGroupMemberReplyConfidentialityBlock: () => block('persona', 'output.group_member_reply_confidentiality', 'private', { slot: 'output_contract' }),
};
`);
write('src/host/prompt/PromptHistoryBuilder.js', `exports.promptHistoryBuilder = { loadPrivateSummaryContext: async () => ({ messages: [], summaryContent: "" }), loadGroupSummaryContext: async () => ({ messages: [], summaryContent: "" }), loadBackgroundContext: async () => "", loadRecentMessages: async () => [] };`);
write('node_modules/@features/profile/index.js', `exports.getCurrentUserProfile = async () => ({ name: 'User' });`);
write('node_modules/@features/companion/index.js', `exports.loadAIScheduleContext = async () => null;`);
write('src/host/prompt/providers/index.js', `
const block = (key, definitionId, content, slot, protection = 'locked') => ({
  key, definitionId, slot, protection, title: definitionId, content,
  required: false, status: content ? 'ready' : 'omitted', truncatable: false,
  scenario: 'shared', placement: 'system',
});
exports.renderHostPromptProviderBlock = async (id) => ({
  'context.protocol_space': block('protocol_space', id, 'protocol', 'user_rules'),
  'context.agent_registry': block('agent_registry_summary', id, 'agents', 'user_rules', 'overridable'),
  'context.group_chat': block('group_chat_context', id, 'group', 'scenario'),
  'context.moments_social_inbox': block('moments_social_inbox', id, '', 'dynamic_context'),
  'context.passive_memory': block('passive_memory', id, '', 'dynamic_context'),
  'context.assistant_nickname': block('assistant_nickname', id, '', 'persona'),
  'context.host_cooldown': block('host_cooldown', id, '', 'dynamic_context'),
}[id]);
`);
for (const relativePath of [
  'src/shared/prompt/messageTimestamp.ts',
  'src/host/prompt/compiler/promptBlockMetadata.ts',
  'src/host/prompt/tokenBudget.ts',
  'src/host/prompt/compiler/PromptPackCompiler.ts',
  'src/host/prompt/compiler/systemPromptPresets.ts',
  'src/host/prompt/PromptPackAssembler.ts',
]) compile(relativePath);
write('src/host/prompt/compiler/index.js', `
exports.promptPackCompiler = require('./PromptPackCompiler').promptPackCompiler;
`);
compile('src/host/prompt/PromptBuiltInContent.ts');
compile('src/host/prompt/ResolvedPromptPackAssembler.ts');

const resolvedAssembler = load('src/host/prompt/ResolvedPromptPackAssembler.ts');
globalThis.__listenGetPreset = load(
  'src/host/prompt/compiler/systemPromptPresets.ts',
).getSystemPromptPreset;
let runReads = 0;
globalThis.__listenCapture = async () => {
  runReads += 1;
  return runReads === 1 ? snapshot('Song A') : snapshot('Song B');
};
globalThis.__listenReconcile = async (value) => value;
const aiConfig = { id: 'host-a', name: 'Host', isHostAI: true };
const toolContext = { sessionId: 'chat-1' };
const allTogetherTools = [...runPreparation.TOGETHER_LISTENING_AI_TOOL_NAMES];
const preparedChat = await runPreparation.prepareTogetherListeningHostModelRun({
  scenario: 'chat.private_reply', currentAiId: 'host-a', isHostAI: true,
  persistentAllowedToolNames: allTogetherTools,
});
const chatPack = await resolvedAssembler.assembleResolvedChatPromptPack({
  sessionId: 'chat-1', currentInput: '你好', aiConfig, toolContext,
  additionalBlocks: preparedChat.additionalPromptBlocks,
});
assert.equal(runReads, 1, '同一个普通 Chat run 只能 capture 一次');
assert.deepEqual(preparedChat.dynamicAllowedToolNames, allTogetherTools);
assert.match(chatPack.dynamicSystemPrompt, /【当前用户状态】[\s\S]*Song A/);
assert.match(chatPack.dynamicSystemPrompt, /【当前共同活动】[\s\S]*你与用户正在一起听/);
assert.match(chatPack.dynamicSystemPrompt, /这一句是当前歌词/);
assert.equal(lyricReads, 1, '一轮模型准备只定位一次歌词');
assert.doesNotMatch(chatPack.dynamicSystemPrompt, /Song B/);

runReads = 0;
const preparedAutonomous = await runPreparation.prepareTogetherListeningHostModelRun({
  scenario: 'raven_cat.ai_schedule_trigger', currentAiId: 'host-a', isHostAI: true,
  persistentAllowedToolNames: allTogetherTools,
});
const autonomousPack = await resolvedAssembler.assembleResolvedChatPromptPack({
  sessionId: 'chat-1', currentInput: 'System wake', aiConfig, toolContext,
  additionalBlocks: [...preparedAutonomous.additionalPromptBlocks,
    { key: 'persona', definitionId: 'scenario.raven_cat_ai_schedule', content: 'schedule rules', title: 'rules', slot: 'output_contract', protection: 'locked', required: true, status: 'ready', placement: 'system' },
    { key: 'persona', definitionId: 'context.raven_cat_ai_schedule', content: 'schedule facts', title: 'facts', slot: 'dynamic_context', protection: 'locked', required: true, status: 'ready', placement: 'system' },
  ],
  runtimeContext: { capabilities: ['raven_cat.autonomous'], triggerSource: 'raven_cat_ai_schedule' },
});
assert.equal(runReads, 1, '同一个 autonomous run 只能 capture 一次');
assert.deepEqual(preparedAutonomous.dynamicAllowedToolNames, allTogetherTools);
assert.match(autonomousPack.dynamicSystemPrompt, /【当前用户状态】[\s\S]*Song A/);
assert.match(autonomousPack.dynamicSystemPrompt, /【当前共同活动】[\s\S]*你与用户正在一起听/);
assert.doesNotMatch(autonomousPack.dynamicSystemPrompt, /Song B/);

runReads = 0;
const nonHostPreparation = await runPreparation.prepareTogetherListeningHostModelRun({
  scenario: 'chat.private_reply', currentAiId: 'member', isHostAI: false,
  persistentAllowedToolNames: allTogetherTools,
});
assert.deepEqual(nonHostPreparation.dynamicAllowedToolNames, []);
assert.deepEqual(nonHostPreparation.additionalPromptBlocks, []);
assert.equal(lyricReads, 2, '非主理不能触发额外歌词读取');
assert.equal(runReads, 0, '非 Host AI 不得读取或获得 Together Listening runtime');

const groupPreparation = await runPreparation.prepareTogetherListeningHostModelRun({
  scenario: 'chat.group_member_reply', currentAiId: 'host-a', isHostAI: true,
  persistentAllowedToolNames: allTogetherTools,
});
assert.deepEqual(groupPreparation.dynamicAllowedToolNames, allTogetherTools);
assert.equal(groupPreparation.additionalPromptBlocks.length, 1);
assert.equal(runReads, 1, '群聊中的主理沿用同一轮冻结快照与权限');
runReads = 0;
for (const scenario of [
  'call.live_reply',
  'call.outgoing_decision',
  'ledger.reply',
]) {
  const preparation = await runPreparation.prepareTogetherListeningHostModelRun({
    scenario, currentAiId: 'host-a', isHostAI: true,
    persistentAllowedToolNames: allTogetherTools,
  });
  assert.deepEqual(preparation.dynamicAllowedToolNames, [], `${scenario} 不得暴露 Together Listening Tool`);
  assert.deepEqual(preparation.additionalPromptBlocks, [], `${scenario} 不得读取 Together Listening runtime`);
}
assert.equal(runReads, 0, '非目标场景不得触发 Together Listening observation');

for (const scenario of ['chat.private_reply', 'chat.group_member_reply', 'raven_cat.ai_schedule_trigger']) {
  for (const phase of [null, 'pending_ai_response', 'pending_user_response', 'active', 'declined_by_user', 'declined_by_ai', 'ended']) {
    const beforeLyricReads = lyricReads;
    globalThis.__listenCapture = async () => ({
      ...snapshot('Matrix', phase ?? 'active'),
      netease: { ...snapshot('Matrix').netease, playbackState: 'paused',
        audioOutput: { playbackType: 'local', deviceNames: ['旧播放设备'] } },
      activity: phase === null ? null : activity(phase, 'host-a'),
      currentLyric: { text: '旧歌词不能绕过活动状态', startTimeMs: 0, positionMs: 0 },
    });
    const prepared = await runPreparation.prepareTogetherListeningHostModelRun({
      scenario, currentAiId: 'host-a', isHostAI: true,
      persistentAllowedToolNames: allTogetherTools,
    });
    assert.deepEqual(
      prepared.dynamicAllowedToolNames,
      allTogetherTools,
      `${phase ?? 'idle'} 时 Host AI 都应看到三只 Together Listening Tool`,
    );
    assert.equal(lyricReads - beforeLyricReads, phase === 'active' ? 1 : 0);
    if (phase === 'active') {
      assert.equal(prepared.additionalPromptBlocks.length, 1);
      assert.match(prepared.additionalPromptBlocks[0].content, /Matrix[\s\S]*这一句是当前歌词/);
    } else {
      assert.deepEqual(prepared.additionalPromptBlocks, [], `${scenario} 的 ${phase ?? 'idle'} 不注入音乐或活动资料`);
      const pack = await resolvedAssembler.assembleResolvedChatPromptPack({
        sessionId: 'chat-1', currentInput: '你好', aiConfig, toolContext,
        additionalBlocks: prepared.additionalPromptBlocks,
      });
      assert.doesNotMatch(pack.dynamicSystemPrompt, /Matrix|旧播放设备|当前用户状态|当前共同活动|当前歌词|旧歌词不能绕过活动状态/);
    }
  }
}

for (const playbackState of ['playing', 'paused', 'buffering', 'connecting']) {
  globalThis.__listenCapture = async () => ({
    ...snapshot('暂停也仍在一起听'),
    netease: { ...snapshot('暂停也仍在一起听').netease, playbackState,
      audioOutput: { playbackType: 'local', deviceNames: ['有线耳机'] } },
  });
  const prepared = await runPreparation.prepareTogetherListeningHostModelRun({
    scenario: 'chat.private_reply', currentAiId: 'host-a', isHostAI: true,
    persistentAllowedToolNames: allTogetherTools,
  });
  assert.match(prepared.additionalPromptBlocks[0].content, /暂停也仍在一起听[\s\S]*有线耳机/);
  if (playbackState === 'paused') assert.match(prepared.additionalPromptBlocks[0].content, /已暂停/);
}

for (const capturedSnapshot of [
  snapshot('其他参与 AI', 'active', 'host-b'),
  { ...snapshot('旧主理'), currentHostAiId: 'host-b' },
]) {
  globalThis.__listenCapture = async () => capturedSnapshot;
  const beforeLyricReads = lyricReads;
  const prepared = await runPreparation.prepareTogetherListeningHostModelRun({
    scenario: 'chat.private_reply', currentAiId: 'host-a', isHostAI: true,
    persistentAllowedToolNames: allTogetherTools,
  });
  assert.deepEqual(prepared.additionalPromptBlocks, []);
  assert.equal(lyricReads, beforeLyricReads, '非活动参与 AI 不读取歌词');
}

for (const reason of ['no_active_session', 'permission_not_granted']) {
  globalThis.__listenCapture = async () => ({
    capturedAtEpochMs: 30,
    currentHostAiId: 'host-a',
    netease: { available: false, reason, playbackState: null, mediaId: null, title: null, artist: null, album: null },
    activity: null,
  });
  const prepared = await runPreparation.prepareTogetherListeningHostModelRun({
    scenario: 'chat.private_reply', currentAiId: 'host-a', isHostAI: true,
    persistentAllowedToolNames: allTogetherTools,
  });
  assert.deepEqual(prepared.dynamicAllowedToolNames, allTogetherTools, `${reason} 时三只 Together Listening Tool 仍应可见`);
}
globalThis.__listenCapture = async () => ({ ...snapshot('Permission'), activity: null });
const permissionFiltered = await runPreparation.prepareTogetherListeningHostModelRun({
  scenario: 'chat.private_reply', currentAiId: 'host-a', isHostAI: true,
  persistentAllowedToolNames: allTogetherTools.filter((name) => name !== 'invite_listening_together'),
});
assert.deepEqual(
  permissionFiltered.dynamicAllowedToolNames,
  allTogetherTools.filter((name) => name !== 'invite_listening_together'),
  '动态 exposure 不得重新加入持久权限已关闭的工具',
);

const featureSource = fs.readFileSync(
  path.join(repoRoot, 'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts'),
  'utf8',
);
assert.doesNotMatch(featureSource, /@features\/phoneTools|@features\/deviceControl/);
const awarenessSources = [
  'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts',
  'src/host/composition/configureTogetherListeningRuntime.ts',
  'src/host/prompt/TogetherListeningPromptBlock.ts',
  'src/host/runtime/TogetherListeningRunPreparation.ts',
].map((relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')).join('\n');
for (const forbidden of ['requestProactiveChatReply', 'scheduleSelfWake', 'runAgent', 'sendMessage']) {
  assert.equal(awarenessSources.includes(forbidden), false, `runtime awareness 不得调用 ${forbidden}`);
}

delete globalThis.__listenCapture;
delete globalThis.__listenReconcile;
delete globalThis.__listenBuildStatus;
delete globalThis.__listenGetPreset;
delete globalThis.__listenReadLyric;
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('LISTEN-2 runtime awareness、reconciliation、Prompt 注入与单轮一致性检查通过。');
