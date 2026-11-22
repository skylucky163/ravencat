/** LISTEN-3 三只 AI Tool 的执行时重校验与 typed result 回归。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-tools-'));

function compile(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.equal((output.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0);
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
write('node_modules/@shared/runtime/abortSignal.js', `
exports.throwIfAbortSignalAborted = (signal) => { if (signal?.aborted) throw signal.reason || new Error('aborted'); };
`);

for (const file of [
  'src/features/togetherListening/domain/TogetherListeningActivity.ts',
  'src/features/togetherListening/domain/TogetherListeningRepository.ts',
  'src/features/togetherListening/application/TogetherListeningRuntime.ts',
  'src/features/togetherListening/application/TogetherListeningChangedSignal.ts',
  'src/features/togetherListening/application/TogetherListeningSystemPresentation.ts',
  'src/features/togetherListening/application/TogetherListeningLifecycle.ts',
  'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts',
  'src/features/togetherListening/aiTools/TogetherListeningToolRuntime.ts',
  'src/features/togetherListening/aiTools/InviteListeningTogetherTool.ts',
  'src/features/togetherListening/aiTools/RespondToListeningInvitationTool.ts',
  'src/features/togetherListening/aiTools/LeaveListeningTogetherTool.ts',
]) compile(file);

const runtime = load('src/features/togetherListening/application/TogetherListeningRuntime.ts');
const inviteTool = load('src/features/togetherListening/aiTools/InviteListeningTogetherTool.ts');
const respondTool = load('src/features/togetherListening/aiTools/RespondToListeningInvitationTool.ts');
const leaveTool = load('src/features/togetherListening/aiTools/LeaveListeningTogetherTool.ts');

const baseObservation = {
  status: 'snapshot_available', playbackState: 'playing', mediaId: 'song-1',
  title: '夜曲', artist: '周杰伦', album: '十一月的萧邦',
};
const context = { aiConfig: { id: 'host-a' }, sessionId: 'chat-1' };

function harness({
  observation = baseObservation,
  currentHostAIId = 'host-a',
  initial = [],
  projectionFails = false,
  currentLyric = null,
} = {}) {
  let rows = [...initial];
  let nextId = 1;
  let currentObservation = observation;
  let hostAIId = currentHostAIId;
  const projections = [];
  let lyricReads = 0;
  const repository = {
    async getCurrent() { return rows.find((row) => ['pending_user_response', 'pending_ai_response', 'active'].includes(row.phase)) ?? null; },
    async getById(id) { return rows.find((row) => row.id === id) ?? null; },
    async createIfNoCurrent(activity) {
      const current = rows.find((row) => ['pending_user_response', 'pending_ai_response', 'active'].includes(row.phase)) ?? null;
      if (current) return { outcome: 'conflict', activity: current };
      rows.push(activity);
      return { outcome: 'created', activity };
    },
    async transitionActivityIfPhase(id, expectedPhases, patch) {
      const index = rows.findIndex((row) => row.id === id && expectedPhases.includes(row.phase));
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...patch };
      return rows[index];
    },
  };
  runtime.configureTogetherListeningRuntimeDependencies({
    repository,
    chat: {
      projectActivityToChat: async (activity, hint) => {
        if (projectionFails) throw new Error('chat unavailable');
        projections.push({ ...activity, hint });
      },
    },
    systemPresentation: {
      upsertActivePresentation: async () => {},
      cancelPresentation: async () => {},
    },
    generateId: () => `activity-${nextId++}`,
    nowEpochMs: () => 100,
    observeNetEasePlayback: async () => currentObservation,
    readCurrentNetEaseLyric: async () => { lyricReads += 1; return currentLyric; },
    getCurrentHostAIId: async () => hostAIId,
    resolveSystemPresentationAIIdentity: async () => ({ name: 'Host', avatar: null }),
  });
  return {
    rows: () => rows,
    projections: () => projections,
    lyricReads: () => lyricReads,
    setObservation: (value) => { currentObservation = value; },
    setHostAIId: (value) => { hostAIId = value; },
  };
}

function activity(phase, endReason = null) {
  return {
    id: 'activity-0', hostAiId: 'host-a', chatSessionId: 'chat-1', initiator: 'user', phase,
    createdAtEpochMs: 1, updatedAtEpochMs: 1,
    activatedAtEpochMs: phase === 'active' ? 1 : null,
    endedAtEpochMs: endReason ? 1 : null, endReason,
  };
}

{
  const state = harness();
  const result = await inviteTool.execute({}, context);
  assert.deepEqual(result.data, {
    status: 'invitation_created',
    activityId: 'activity-1',
    phase: 'pending_user_response',
    projectionStatus: 'projected',
  });
  assert.equal(state.rows().length, 1);
  assert.equal(state.projections().at(-1)?.phase, 'pending_user_response');
}
{
  const currentLyric = { text: '当前歌曲正在播的这一句', startTimeMs: 20_000, positionMs: 21_000 };
  const state = harness({ currentLyric });
  const invitation = await inviteTool.execute({}, context);
  assert.equal(invitation.data.currentLyric, undefined, '邀请待回应时不附带当前歌词');
  assert.equal(state.lyricReads(), 0, '邀请待回应时不读取歌词');
  harness({ currentLyric, initial: [activity('pending_ai_response')] });
  const accepted = await respondTool.execute({ decision: 'accept' }, context);
  assert.deepEqual(accepted.data.currentLyric, currentLyric, '接受邀请当轮的工具续轮立即获得当前一句');
}
{
  const state = harness({ projectionFails: true });
  const originalWarn = console.warn;
  console.warn = () => {};
  const result = await inviteTool.execute({}, context).finally(() => {
    console.warn = originalWarn;
  });
  assert.equal(result.data.status, 'unavailable');
  assert.equal(result.data.reason, 'chat_unavailable');
  assert.equal(state.rows()[0].phase, 'ended');
  assert.equal(state.rows()[0].endReason, 'chat_unavailable');
}
for (const [observation, reason] of [
  [{ status: 'no_active_session' }, 'no_active_netease_playback'],
  [{ status: 'observation_failed' }, 'observation_unavailable'],
]) {
  const state = harness({ observation });
  const result = await inviteTool.execute({}, context);
  assert.equal(result.data.status, 'unavailable');
  assert.equal(result.data.reason, reason);
  assert.equal(state.rows().length, 0);
}
{
  const state = harness({ currentHostAIId: 'host-b' });
  const result = await inviteTool.execute({}, context);
  assert.equal(result.data.reason, 'stale_host_authority');
  assert.equal(state.rows().length, 0);
}
{
  const state = harness();
  const results = await Promise.all([
    inviteTool.execute({}, context),
    inviteTool.execute({}, context),
  ]);
  assert.deepEqual(
    results.map((result) => result.data.status).sort(),
    ['activity_in_progress', 'invitation_created'],
  );
  assert.equal(state.rows().filter((row) => ['pending_user_response', 'pending_ai_response', 'active'].includes(row.phase)).length, 1);
}
{
  const state = harness({ initial: [activity('pending_ai_response')] });
  const result = await respondTool.execute({ decision: 'accept' }, context);
  assert.equal(result.data.status, 'invitation_accepted');
  assert.equal(state.rows()[0].phase, 'active');
  assert.equal(state.projections().at(-1)?.phase, 'active');
}
{
  const state = harness({ initial: [activity('pending_ai_response')], observation: { status: 'observation_failed' } });
  const result = await respondTool.execute({ decision: 'accept' }, context);
  assert.equal(result.data.reason, 'observation_unavailable');
  assert.equal(state.rows()[0].phase, 'pending_ai_response');
}
{
  const state = harness({ initial: [activity('pending_ai_response')], observation: { ...baseObservation, playbackState: 'stopped' } });
  const result = await respondTool.execute({ decision: 'accept' }, context);
  assert.equal(result.data.endReason, 'media_unavailable');
  assert.equal(state.rows()[0].phase, 'ended');
  assert.equal(state.projections().at(-1)?.endReason, 'media_unavailable');
}
{
  const state = harness({ initial: [activity('pending_ai_response')], observation: { status: 'observation_failed' } });
  const result = await respondTool.execute({ decision: 'decline' }, context);
  assert.equal(result.data.status, 'invitation_declined');
  assert.equal(state.rows()[0].phase, 'declined_by_ai');
  assert.equal(state.projections().at(-1)?.phase, 'declined_by_ai');
}
{
  const state = harness({ initial: [activity('pending_user_response')] });
  const result = await respondTool.execute({ decision: 'accept' }, context);
  assert.equal(result.success, true);
  assert.equal(result.data.status, 'unavailable');
  assert.equal(result.data.reason, 'no_pending_user_invitation');
  assert.equal(result.data.activityId, 'activity-0');
  assert.equal(result.data.phase, 'pending_user_response');
  assert.equal(state.rows()[0].phase, 'pending_user_response');
}
{
  const state = harness({ initial: [activity('active')] });
  const result = await leaveTool.execute({}, context);
  assert.equal(result.data.endReason, 'ai_left');
  assert.equal(state.rows()[0].phase, 'ended');
  assert.equal(state.projections().at(-1)?.endReason, 'ai_left');
}
{
  const state = harness({ initial: [activity('active')], observation: { ...baseObservation, playbackState: 'error' } });
  const result = await leaveTool.execute({}, context);
  assert.equal(result.data.endReason, 'media_unavailable');
  assert.equal(state.rows()[0].endReason, 'media_unavailable');
}
{
  const state = harness({ initial: [activity('ended', 'user_left')] });
  const result = await leaveTool.execute({}, context);
  assert.equal(result.success, true);
  assert.equal(result.data.status, 'unavailable');
  assert.equal(result.data.reason, 'no_active_together_listening');
  assert.equal(state.rows()[0].endReason, 'user_left');
}

// LISTEN-4.1：AI 在 Chat Agent run 内发起邀请时，首张卡投影必须携带该 run 的
// 排序身份（sharedState.replyRunId）；lifecycle 后续 patch 不得重复携带。
{
  const state = harness();
  const runContext = {
    aiConfig: { id: 'host-a' },
    sessionId: 'chat-1',
    sharedState: { replyRunId: 'turn_run_test_1' },
  };
  const result = await inviteTool.execute({}, runContext);
  assert.equal(result.data.status, 'invitation_created');
  assert.equal(
    state.projections().at(-1)?.hint?.timelineRunId,
    'turn_run_test_1',
    'AI 邀请首张卡的投影必须携带当前 Chat Agent run 标识',
  );
}
{
  // 非 Chat run（无 sharedState.replyRunId）：hint 为空，卡片退化为普通历史键排序。
  const state = harness();
  const result = await inviteTool.execute({}, context);
  assert.equal(result.data.status, 'invitation_created');
  assert.equal(
    state.projections().at(-1)?.hint?.timelineRunId,
    undefined,
    '没有 replyRunId 的 run 不得伪造排序身份',
  );
}
{
  // lifecycle transition 投影是同一卡片的 patch，不携带 run 排序身份。
  const state = harness({ initial: [activity('pending_ai_response')] });
  const result = await respondTool.execute({ decision: 'accept' }, {
    aiConfig: { id: 'host-a' },
    sessionId: 'chat-1',
    sharedState: { replyRunId: 'turn_run_test_2' },
  });
  assert.equal(result.data.status, 'invitation_accepted');
  assert.equal(
    state.projections().at(-1)?.hint?.timelineRunId,
    undefined,
    'lifecycle patch 不得改写首张卡的排序身份',
  );
}

assert.deepEqual(inviteTool.definition.parameters, { type: 'object', properties: {}, required: [], additionalProperties: false });
assert.deepEqual(leaveTool.definition.parameters, { type: 'object', properties: {}, required: [], additionalProperties: false });
assert.deepEqual(respondTool.definition.parameters.required, ['decision']);
assert.deepEqual(respondTool.definition.parameters.properties.decision.enum, ['accept', 'decline']);

const toolSources = [
  'InviteListeningTogetherTool.ts',
  'RespondToListeningInvitationTool.ts',
  'LeaveListeningTogetherTool.ts',
  'TogetherListeningToolRuntime.ts',
].map((name) => fs.readFileSync(path.join(repoRoot, 'src/features/togetherListening/aiTools', name), 'utf8')).join('\n');
for (const forbidden of [
  'requestProactiveChatReply', 'scheduleSelfWake', 'appendExternalAssistantMessage',
  'sendMessage', 'AIMessageDeliveryCoordinator',
]) assert.equal(toolSources.includes(forbidden), false, `Together Listening AI Tool 不得调用 ${forbidden}`);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('LISTEN-3 AI Tool schema、执行时重校验、typed unavailable/conflict 与无额外交付检查通过。');
