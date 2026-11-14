import assert from 'node:assert/strict';
import { loadTypeScriptModule as loadModule, readRepoFile as read } from './helpers/load-typescript-module.mjs';

// ---------------------------------------------------------------------------
// 公共 Host autonomous bootstrap：assistant / session / transcript / tool
// exposure / runPreparation / gateway / 行动记录 / runVisibleAgent。
// ---------------------------------------------------------------------------
const bootstrapPath = 'src/features/companion/application/RunHostAutonomousAgent.ts';
let runtimeDependencies;
let gatewayParams;
class TestModelGateway {
  constructor(params) {
    gatewayParams = params;
  }
}
const bootstrapModule = loadModule(bootstrapPath, {
  '@shared/aiTools': {
    applyHostModelRunToolExposure: (allowed, preparation) => [
      ...allowed.filter((name) => !preparation.managedToolNames.includes(name)),
      ...preparation.dynamicAllowedToolNames,
    ],
  },
  '@platform/ai': { createAIClient: (config) => ({ config }) },
  '@platform/agentRuntime': { BaseAIClientAgentModelGateway: TestModelGateway },
  './CompanionRuntimeDependencies': {
    getCompanionRuntimeDependencies: () => runtimeDependencies,
  },
});
const { runHostAutonomousAgent } = bootstrapModule;

const assistant = {
  id: 'host-ai', agentId: 'host-agent', name: 'Raven', model: 'test-model',
  apiKey: 'key', apiBaseUrl: 'https://example.test', systemPrompt: 'persona',
  temperature: 0.7, topP: 1, maxTokens: 2000, enableTools: true,
  allowMultipleBubbles: true, isHostAI: true, isBlocked: false,
};
let activeSession = { id: 'real-session', aiAssistantId: 'host-ai', name: '真实会话' };
let transcriptVersion = 1;
let capturedRunRequest;
let capturedPromptParams;
let preparationReads = 0;
const createdToolContexts = [];

runtimeDependencies = {
  runPreparation: {
    prepare: async (input) => {
      preparationReads += 1;
      return {
        additionalPromptBlocks: [{ togetherListeningSnapshot: 'Song A' }],
        managedToolNames: [
          'invite_listening_together',
          'respond_to_listening_invitation',
          'leave_listening_together',
        ],
        dynamicAllowedToolNames: input.persistentAllowedToolNames.length > 0 ? ['invite_listening_together'] : [],
      };
    },
  },
  repositories: {
    assistants: { getById: async () => assistant },
  },
  chat: {
    // 每个 AI 只有一个 canonical conversation：缺失时 resolve 会创建，
    // 语义等价于旧的 ensure（不再存在 active/alternate session 选择）。
    resolveCanonicalConversation: async () => activeSession ?? {
      id: 'ensured-session', aiAssistantId: 'host-ai', name: '自动创建会话',
    },
    listRecentTranscript: async () => [
      { role: 'user', text: `latest-user-${transcriptVersion}`, createdAt: '2026-08-30T07:00:00Z' },
      { role: 'assistant', text: `latest-assistant-${transcriptVersion}`, createdAt: '2026-08-30T07:01:00Z' },
      { role: 'system', text: 'timeline-only-system', createdAt: '2026-08-30T07:02:00Z' },
    ],
    runVisibleAgent: async (request) => {
      const prepared = await request.prepare(new AbortController().signal);
      capturedRunRequest = { ...request, ...prepared };
      return {
        runId: request.runId,
        taskId: capturedRunRequest.request.task.id,
        status: 'completed', terminalCode: 'COMPLETED', finalText: 'internal only',
        history: [], steps: [], stepCount: 1, toolCallCount: 0,
      };
    },
  },
  tools: {
    resolveMcpExposure: async (assistantId) => {
      assert.equal(assistantId, 'host-ai', '主动任务必须按实际 owner AI 解析 MCP 暴露面');
      return {
        allowedToolNames: ['mcp.service.lookup'],
        services: [{ name: 'service', description: 'test service' }],
      };
    },
    resolveAllowedNames: async () => ['normal_host_tool', 'create_ai_schedule'],
    getRuntimeAllowedNames: (config) => [...config.allowedToolNames],
    buildDescription: (names) => names.length > 0 ? `tools:${names.join(',')}` : '',
    createContext: (params) => {
      createdToolContexts.push(params);
      return { ...params, sessionId: params.sessionId };
    },
  },
  prompt: {
    assembleChatPromptPack: async (params) => {
      capturedPromptParams = params;
      return { systemPrompt: 'same-chat-system', modelMessages: [{ role: 'user', content: params.currentInput }] };
    },
  },
};

const triggeredAt = '2026-08-30T08:00:05.000Z';
const wakeBlock = { content: JSON.stringify({ wakeContext: {
  wakeId: 'wake-claimed',
  wakeAt: '2026-08-30T08:00:00.000Z',
  note: '看看最近的对话',
  triggeredAt,
  companionState: 'desiredEnabled=true, activationStatus=enabled, scheduleRevision=7, hostAIId=host-ai',
} }) };

const firstResult = await runHostAutonomousAgent({
  sessionId: 'real-session',
  runId: 'run-autonomous',
  ownerAIId: 'host-ai',
  triggeredAt,
  correlationId: 'wake-claimed',
  scenarioId: 'raven_cat.ai_schedule_trigger',
  triggerSource: 'raven_cat_ai_schedule',
  triggerReason: 'ai_schedule',
  relatedEntityType: 'raven_cat_ai_schedule',
  relatedEntityId: 'wake-claimed',
  taskGoal: '当前主理 AI 因 Self Wake 获得一次自主行动机会。',
  taskSource: 'raven_cat_ai_schedule',
  additionalPromptBlocks: [wakeBlock],
});
assert.equal(firstResult.finalText, 'internal only');
assert.equal(capturedRunRequest.runId, 'run-autonomous');
assert.equal(capturedRunRequest.request.task.source, 'raven_cat_ai_schedule');
assert.equal(capturedRunRequest.request.task.assistantId, 'host-ai');
assert.equal(capturedRunRequest.request.task.sessionId, 'real-session');
assert.deepEqual(capturedRunRequest.request.task.allowedToolNames, [
  'normal_host_tool', 'create_ai_schedule', 'mcp.service.lookup', 'invite_listening_together',
]);
assert.equal(capturedRunRequest.finalAssistantPolicy, 'autonomous_reply');
assert.deepEqual(
  {
    triggerSource: capturedRunRequest.runtimeContext.triggerSource,
    triggerReason: capturedRunRequest.runtimeContext.triggerReason,
    relatedEntityType: capturedRunRequest.runtimeContext.relatedEntityType,
    relatedEntityId: capturedRunRequest.runtimeContext.relatedEntityId,
    replyRunId: capturedRunRequest.runtimeContext.replyRunId,
  },
  {
    triggerSource: 'raven_cat_ai_schedule',
    triggerReason: 'ai_schedule',
    relatedEntityType: 'raven_cat_ai_schedule',
    relatedEntityId: 'wake-claimed',
    replyRunId: 'run-autonomous',
  },
);
assert.equal(preparationReads, 1, '一次 autonomous run 只能准备一份 Together Listening snapshot');
assert.equal(capturedRunRequest.request.beforeComplete, undefined);
assert.deepEqual(gatewayParams.initialMessages, [{ role: 'user', content: capturedPromptParams.currentInput }]);
assert.equal(capturedPromptParams.sessionId, 'real-session');
assert.equal(capturedPromptParams.currentInput, '');
assert.equal(capturedPromptParams.runtimeContext.inputSource, 'application');
assert.deepEqual(capturedPromptParams.additionalBlocks, [wakeBlock, { togetherListeningSnapshot: 'Song A' }]);

activeSession = null;
transcriptVersion = 2;
await runHostAutonomousAgent({
  sessionId: 'ensured-session',
  runId: 'run-without-session', ownerAIId: 'host-ai', triggeredAt,
  correlationId: 'wake-claimed', scenarioId: 'raven_cat.ai_schedule_trigger',
  triggerSource: 'raven_cat_ai_schedule', triggerReason: 'ai_schedule',
  relatedEntityType: 'raven_cat_ai_schedule', relatedEntityId: 'wake-claimed',
  taskGoal: 'goal', taskSource: 'raven_cat_ai_schedule', additionalPromptBlocks: [wakeBlock],
});
assert.equal(capturedRunRequest.request.task.sessionId, 'ensured-session');
assert.equal(createdToolContexts.at(-1).sessionId, 'ensured-session');
assert.deepEqual(gatewayParams.initialMessages, [{ role: 'user', content: capturedPromptParams.currentInput }]);

activeSession = { id: 'real-session', aiAssistantId: 'host-ai', name: '真实会话' };
await runHostAutonomousAgent({
  sessionId: 'real-session',
  runId: 'run-latest-context', ownerAIId: 'host-ai', triggeredAt,
  correlationId: 'wake-claimed', scenarioId: 'raven_cat.ai_schedule_trigger',
  triggerSource: 'raven_cat_ai_schedule', triggerReason: 'ai_schedule',
  relatedEntityType: 'raven_cat_ai_schedule', relatedEntityId: 'wake-claimed',
  taskGoal: 'goal', taskSource: 'raven_cat_ai_schedule', additionalPromptBlocks: [wakeBlock],
});
assert.deepEqual(gatewayParams.initialMessages, [{ role: 'user', content: capturedPromptParams.currentInput }]);
assert.equal(capturedPromptParams.sessionId, 'real-session');

// ---------------------------------------------------------------------------
// Self Wake wrapper 与 AI Schedule wrapper 只提供各自 trigger context，并委托
// 公共 bootstrap，不复制整条 autonomous run 链。
// ---------------------------------------------------------------------------
const autonomousReplyContract = loadModule('src/features/chat/reply/application/AutonomousReplyContract.ts', {});
const promptBlocks = loadModule('src/features/companion/application/CompanionPromptBlocks.ts', {
  '@features/chat': autonomousReplyContract,
});
assistant.enableTools = false;
await runHostAutonomousAgent({
  sessionId: 'real-session',
  runId: 'run-without-tools', ownerAIId: 'host-ai', triggeredAt,
  correlationId: 'wake-no-tools', scenarioId: 'raven_cat.ai_schedule_trigger',
  triggerSource: 'raven_cat_ai_schedule', triggerReason: 'ai_schedule',
  relatedEntityType: 'raven_cat_ai_schedule', relatedEntityId: 'wake-no-tools',
  taskGoal: 'goal', taskSource: 'raven_cat_ai_schedule',
  additionalPromptBlocks: [{ content: promptBlocks.COMPANION_AI_SCHEDULE_TRIGGER_RULES }],
});
assert.deepEqual(capturedRunRequest.request.task.allowedToolNames, []);
assert.equal(capturedPromptParams.toolsDescription, '');
assert.deepEqual(capturedPromptParams.mcpServices, []);
assert.doesNotMatch(capturedPromptParams.currentInput, /update_ai_schedule|调用.*工具|Registry/);
assistant.enableTools = true;
let capturedScheduleInput;
const scheduleWrapper = loadModule('src/features/companion/application/RunAIScheduleAutonomousAgent.ts', {
  './CompanionRuntimeDependencies': { getCompanionRuntimeDependencies: () => ({ repositories: {
    aiSchedules: { listUnanswered: async () => [] },
    companionSettings: { ensureDefault: async () => ({ followUpEnabled: false, followUpIntervalMinutes: 10 }) },
  } }) },
  './CompanionPromptBlocks': promptBlocks,
  './RunHostAutonomousAgent': {
    runHostAutonomousAgent: async (input) => { capturedScheduleInput = input; return { terminalCode: 'COMPLETED' }; },
  },
});
await scheduleWrapper.runAIScheduleAutonomousAgent({
  sessionId: 'real-session',
  runId: 'run-s', claimedSchedule: {
    scheduleId: 'schedule-x', ownerAIId: 'host-ai', remindAt: '2026-09-13T09:00:00.000Z', triggerKind:'scheduled', recurrence:null,
    summary: '考试', details: '数据库考试', sourceExcerpt: '用户说上午有考试',
  }, triggeredAt,
});
assert.equal(capturedScheduleInput.scenarioId, 'raven_cat.ai_schedule_trigger');
assert.equal(capturedScheduleInput.triggerSource, 'raven_cat_ai_schedule');
assert.equal(capturedScheduleInput.triggerReason, 'ai_schedule');
assert.equal(capturedScheduleInput.relatedEntityType, 'raven_cat_ai_schedule');
assert.equal(capturedScheduleInput.relatedEntityId, 'schedule-x');
assert.equal(capturedScheduleInput.taskSource, 'raven_cat_ai_schedule');
const scheduleContext = capturedScheduleInput.additionalPromptBlocks.find(
  (block) => block.definitionId === 'context.raven_cat_ai_schedule',
);
for (const fact of ['schedule-x', '2026-09-13T09:00:00.000Z', '考试', '数据库考试', '用户说上午有考试', triggeredAt]) {
  assert.ok(scheduleContext.content.includes(fact), `AI Schedule 机器上下文缺少触发事实：${fact}`);
}

const configureSource = read('src/host/composition/configureCompanionRuntime.ts');
assert.match(configureSource, /runVisibleAgent:\s*runChatVisibleAgent/);
assert.match(configureSource, /assembleChatPromptPack:\s*assembleResolvedChatPromptPack/);
assert.doesNotMatch(configureSource, /new AgentRuntime/);

console.log('WAKE-5C / AI Schedule autonomous bootstrap、最新上下文、真实 session、Host 复用与自然 completion 已验证。');
