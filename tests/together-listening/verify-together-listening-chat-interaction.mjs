/** LISTEN-4 Chat entry 与 Host 用户操作重校验回归。 */

import { repoRoot } from '../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'together-listening-chat-interaction-'));

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

const availableNetEase = {
  available: true,
  playbackState: 'playing',
  mediaId: 'song-1',
  title: '夜曲',
  artist: '周杰伦',
  album: '十一月的萧邦',
};
let snapshot = {
  capturedAtEpochMs: 1,
  currentHostAiId: 'host-1',
  netease: availableNetEase,
  activity: null,
};
let createCount = 0;
let canonicalCommitCount = 0;
let projectionCount = 0;
let modelRunsAdded = 0;
let followUpCount = 0;
const leaveCalls = [];
const projectedActivities = [];

function transition(phase, endReason = null) {
  snapshot.activity = {
    ...snapshot.activity,
    phase,
    endReason,
    updatedAtEpochMs: Number(snapshot.activity?.updatedAtEpochMs || 1) + 1,
  };
  projectionCount += 1;
  return {
    status: 'transitioned',
    activity: snapshot.activity,
    projectionStatus: 'projected',
  };
}

globalThis.__listenInteraction = {
  chat: {
    async commit(activity) {
      canonicalCommitCount += 1;
      modelRunsAdded += 1;
      return { userMessage: { id: 1, activity }, success: true, error: null };
    },
    async upsert(activity) {
      projectedActivities.push(activity);
      projectionCount += 1;
      return { message: { id: 1 }, inserted: projectionCount === 1 };
    },
  },
  together: {
    captureTogetherListeningRuntimeSnapshot: async () => ({
      ...snapshot,
      activity: snapshot.activity ? { ...snapshot.activity } : null,
    }),
    createUserTogetherListeningInvitation: async ({ hostAiId, chatSessionId }) => {
      createCount += 1;
      snapshot.activity = {
        id: `activity-${createCount}`,
        hostAiId,
        chatSessionId,
        initiator: 'user',
        phase: 'pending_ai_response',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        activatedAtEpochMs: null,
        endedAtEpochMs: null,
        endReason: null,
      };
      return { status: 'created', activity: snapshot.activity, projectionStatus: 'deferred' };
    },
    acceptTogetherListeningInvitationByUser: async () => transition('active'),
    declineTogetherListeningInvitationByUser: async () => transition('declined_by_user'),
    leaveTogetherListeningByUser: async (input) => {
      leaveCalls.push(input);
      const activity = snapshot.activity;
      if (!activity || activity.id !== input.activityId) {
        return { status: 'activity_not_current', activity };
      }
      if (activity.hostAiId !== snapshot.currentHostAiId) {
        const result = transition('ended', 'host_authority_lost');
        return { status: 'host_authority_lost', activity: result.activity, transition: result };
      }
      if (activity.phase !== 'active') {
        return { status: 'invalid_phase', activity };
      }
      if (!snapshot.netease.available && [
        'no_active_session',
        'playback_stopped',
        'playback_none',
        'playback_error',
      ].includes(snapshot.netease.reason)) {
        const result = transition('ended', 'media_unavailable');
        return { status: 'media_unavailable', activity: result.activity, transition: result };
      }
      const result = transition('ended', 'user_left');
      return { status: 'left', activity: result.activity, transition: result };
    },
    endTogetherListeningActivity: async ({ reason }) => transition('ended', reason),
    isExplicitTogetherListeningMediaLoss: (netease) => !netease.available
      && ['no_active_session', 'playback_stopped', 'playback_none', 'playback_error']
        .includes(netease.reason),
    runPostUserDeclineFollowUp: async () => {
      followUpCount += 1;
    },
  },
};

write('node_modules/@features/chat/composition.js', `
exports.commitTogetherListeningUserInvitation = (...args) => globalThis.__listenInteraction.chat.commit(...args);
exports.upsertTogetherListeningTimelineEntry = (...args) => globalThis.__listenInteraction.chat.upsert(...args);
`);
write('node_modules/@features/togetherListening/index.js', `
module.exports = globalThis.__listenInteraction.together;
`);
write('src/features/assistants/infrastructure/SQLiteAssistantRepository.js', 'exports.aiAssistantRepository = {};');
compile('src/features/assistants/AssistantNickname.ts');
write('node_modules/@features/assistants/index.js', `
exports.aiAssistantRepository = { getById: async () => ({ name: '原名', nickname: '小羽' }) };
exports.getAssistantDisplayName = require(${JSON.stringify(path.join(tempRoot, 'src/features/assistants/AssistantNickname.js'))}).getAssistantDisplayName;
`);

compile('src/host/composition/createChatTogetherListeningGateway.ts');
compile('src/features/chat/conversation/application/ChatTogetherListeningGateway.ts');
compile('src/features/chat/presentation/messages/components/chatToolPanelCapability.ts');
const { createChatTogetherListeningGateway } = require(path.join(
  tempRoot,
  'src/host/composition/createChatTogetherListeningGateway.js',
));
const entryPolicy = require(path.join(
  tempRoot,
  'src/features/chat/conversation/application/ChatTogetherListeningGateway.js',
));
const panelCapability = require(path.join(
  tempRoot,
  'src/features/chat/presentation/messages/components/chatToolPanelCapability.js',
));
const gateway = createChatTogetherListeningGateway();
const hostContext = { chatSessionId: 'chat-1', aiConfig: { id: 'host-1', isHostAI: true } };

assert.equal(entryPolicy.shouldShowTogetherListeningChatEntry({ isHostAI: true }), true);
assert.equal(entryPolicy.shouldShowTogetherListeningChatEntry({ isHostAI: false }), false);
assert.equal(entryPolicy.shouldShowTogetherListeningChatEntry(null), false);

const wrappedPanelHandler = () => {};
assert.equal(
  panelCapability.resolveTogetherListeningToolPanelHandler(undefined, wrappedPanelHandler),
  undefined,
  'ChatInputArea 不得把缺失的 Together Listening capability 包装成 truthy callback',
);
assert.equal(
  panelCapability.resolveTogetherListeningToolPanelHandler(() => {}, wrappedPanelHandler),
  wrappedPanelHandler,
  'Host capability 存在时应把输入区 wrapper 交给 ChatToolPanel',
);

// ChatDetail/InputArea callback propagation → ChatToolPanel visibility 的完整纯链路：
// 非 Host（callback 为 undefined）经 wrapper 解析后仍无入口，Host 才有「一起听」。
const togetherTool = { id: 'togetherListening' };
const defaultTools = [{ id: 'image' }];
const videoCallTool = { id: 'videoCall' };
assert.deepEqual(
  panelCapability.resolveChatToolPanelTools({
    defaultTools,
    videoCallTool,
    videoCallHandler: undefined,
    togetherListeningTool: togetherTool,
    togetherListeningHandler: undefined,
  }),
  defaultTools,
  '群聊未接入通话能力时只展示附件入口',
);
assert.deepEqual(
  panelCapability.resolveChatToolPanelTools({
    defaultTools,
    videoCallTool,
    videoCallHandler: () => {},
    togetherListeningTool: togetherTool,
    togetherListeningHandler: undefined,
  }),
  [...defaultTools, videoCallTool],
  '单聊已接入通话能力时保留视频电话入口',
);
for (const aiAssistant of [{ isHostAI: false }, null]) {
  const capability = entryPolicy.shouldShowTogetherListeningChatEntry(aiAssistant)
    ? () => {}
    : undefined;
  const panelHandler = panelCapability.resolveTogetherListeningToolPanelHandler(
    capability,
    wrappedPanelHandler,
  );
  const tools = panelCapability.resolveChatToolPanelTools({
    defaultTools,
    videoCallTool,
    videoCallHandler: () => {},
    togetherListeningTool: togetherTool,
    togetherListeningHandler: panelHandler,
  });
  assert.equal(
    tools.some((tool) => tool.id === 'togetherListening'),
    false,
    '非 Host 私聊的 + 面板不得出现「一起听」入口',
  );
}
{
  const capability = entryPolicy.shouldShowTogetherListeningChatEntry({ isHostAI: true })
    ? () => {}
    : undefined;
  const panelHandler = panelCapability.resolveTogetherListeningToolPanelHandler(
    capability,
    wrappedPanelHandler,
  );
  const tools = panelCapability.resolveChatToolPanelTools({
    defaultTools,
    videoCallTool,
    videoCallHandler: () => {},
    togetherListeningTool: togetherTool,
    togetherListeningHandler: panelHandler,
  });
  assert.equal(
    tools.some((tool) => tool.id === 'togetherListening'),
    true,
    'Host 私聊的 + 面板必须保留「一起听」入口',
  );
}

const stale = await gateway.invite({
  chatSessionId: 'chat-1',
  aiConfig: { id: 'other-ai', isHostAI: false },
});
assert.equal(stale.reason, 'stale_host_authority');
assert.equal(createCount, 0);
assert.equal(canonicalCommitCount, 0);

snapshot.netease = { available: false, reason: 'no_active_session' };
const unavailable = await gateway.invite(hostContext);
assert.equal(unavailable.reason, 'no_active_netease_playback');
assert.match(unavailable.message, /请先在网易云音乐播放一首歌/);
assert.equal(createCount, 0);
assert.equal(canonicalCommitCount, 0);

snapshot.netease = { available: false, reason: 'permission_not_granted' };
const permission = await gateway.invite(hostContext);
assert.match(permission.message, /需要通知使用权/);
assert.equal(createCount, 0);

snapshot.netease = availableNetEase;
const invited = await gateway.invite(hostContext);
assert.equal(invited.status, 'invitation_created');
assert.equal(invited.activity?.phase, 'pending_ai_response');
assert.equal(createCount, 1);
assert.equal(canonicalCommitCount, 1);
assert.equal(modelRunsAdded, 1);

const duplicate = await gateway.invite(hostContext);
assert.equal(duplicate.status, 'activity_in_progress');
assert.equal(createCount, 1);
assert.equal(canonicalCommitCount, 1);

snapshot.activity = {
  ...snapshot.activity,
  id: 'ai-invite-accept',
  initiator: 'ai',
  phase: 'pending_user_response',
};
const accepted = await gateway.accept({ ...hostContext, activityId: 'ai-invite-accept' });
assert.equal(accepted.status, 'invitation_accepted');
assert.equal(accepted.activity?.id, 'ai-invite-accept');
assert.equal(accepted.activity?.phase, 'active');

snapshot.activity = {
  ...snapshot.activity,
  id: 'ai-invite-reject',
  initiator: 'ai',
  phase: 'pending_user_response',
  endReason: null,
};
const runsBeforeReject = modelRunsAdded;
const rejected = await gateway.decline({ ...hostContext, activityId: 'ai-invite-reject' });
assert.equal(rejected.status, 'invitation_declined');
assert.equal(rejected.activity?.phase, 'declined_by_user');
assert.equal(modelRunsAdded, runsBeforeReject, '用户拒绝不得新增普通 Chat Agent run');
assert.equal(followUpCount, 1, 'AI 邀请被用户成功拒绝后必须恰好触发一次 follow-up');

snapshot.activity = {
  ...snapshot.activity,
  id: 'active-media-loss',
  phase: 'active',
  endReason: null,
};
snapshot.netease = { available: false, reason: 'playback_stopped' };
const mediaEnded = await gateway.leave({ ...hostContext, activityId: 'active-media-loss' });
assert.equal(mediaEnded.activity?.phase, 'ended');
assert.equal(mediaEnded.activity?.endReason, 'media_unavailable');

snapshot.activity = {
  ...snapshot.activity,
  id: 'active-transient',
  phase: 'active',
  endReason: null,
};
snapshot.netease = { available: false, reason: 'observation_failed' };
const userLeft = await gateway.leave({ ...hostContext, activityId: 'active-transient' });
assert.equal(userLeft.status, 'left');
assert.equal(userLeft.activity?.endReason, 'user_left');
assert.deepEqual(
  leaveCalls.map((call) => call.source),
  ['chat_card', 'chat_card'],
  'Chat card leave 必须只委托 shared canonical user-leave command',
);
assert.ok(projectionCount >= 4);
await gateway.projectActivityToChat({
  ...snapshot.activity, phase: 'ended', endReason: 'ai_left',
});
assert.equal(projectedActivities.at(-1).hostAiName, '小羽', 'AI 退出时 Host 提供当前显示名字，Chat 不猜身份');

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('LISTEN-4 Host-only 入口、用户 invite/accept/reject/leave 重校验与 LISTEN-5 follow-up 单次触发检查通过。');
