import assert from 'node:assert/strict';
import { loadTypeScriptModule } from '../helpers/load-typescript-module.mjs';

const { resolveAIReplyPolicy } = loadTypeScriptModule(
  'src/features/chat/reply/application/ReplyPolicy.ts',
);

const replyPolicyModule = { resolveAIReplyPolicy };

const baseConfig = {
  id: 'assistant-1',
  agentId: 'agent-1',
  name: 'Kimi',
  model: 'test-model',
  apiKey: 'test-key',
  apiBaseUrl: 'https://example.test',
};

function resolvePolicy(config, runtime = {}) {
  return resolveAIReplyPolicy(
    { ...baseConfig, ...config },
    { allowedToolNames: ['mcp_server_lookup'], ...runtime },
  );
}

assert.equal(
  resolvePolicy({ enableTools: false }).enableTools,
  false,
  'aiConfig.enableTools=false 必须关闭 MCP-only 工具策略',
);
assert.equal(
  resolvePolicy({ enableTools: true }, { groupChat: { groupId: 'group-1' } }).enableTools,
  true,
  '群聊使用已授权工具，不另行关闭 MCP 工具策略',
);
assert.equal(
  resolvePolicy(
    { enableTools: true },
    {
      batchModelInput: [{
        type: 'image_url',
        image_url: { url: 'file:///tmp/current-turn.png' },
      }],
    },
  ).enableTools,
  true,
  '图片上下文保留已授权的 MCP 工具策略',
);
assert.equal(
  resolvePolicy({ enableTools: true }).enableTools,
  true,
  '只有 MCP、没有 Built-in 时仍必须开启工具策略',
);

class TestMcpConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpConfigError';
  }
}

let resolveFrozen;
let serversRead;
let registeredFrozen;
let exposedServers = [{ id: 'server-1', name: '测试服务', description: '测试服务简介' }];

const { registerMcpToolsForHostRun, resolveMcpExposure } = loadTypeScriptModule(
  'src/host/composition/agent/registerMcpToolsForHostRun.ts',
  {
    '@features/mcpTools/composition': { resolveMcpBearerToken: async () => undefined },
    '@shared/aiTools': {
      applyHostModelRunToolExposure: (allowed, preparation) => [
        ...allowed.filter((name) => !preparation.managedToolNames.includes(name)),
        ...preparation.dynamicAllowedToolNames,
      ],
    },
    '@features/mcpTools': {
      getMcpToolsRuntimeDependencies: () => ({
        toolGrantRepository: { listByServer: async () => frozenTools.map((tool) => ({
          remoteToolName: tool.remoteToolName, enabled: true, schemaFingerprint: tool.schemaFingerprint,
        })) },
      }),
      listMcpServers: async () => {
        serversRead += 1;
        return exposedServers;
      },
    },
    '@platform/mcp': {
      NegotiatingMcpClient: class {},
    },
    './McpAgentTool': {
      MCP_META_TOOL_NAMES: ['mcp_list_tools', 'mcp_call_tool'],
      createMcpMetaTools: ({ frozen }) => {
        registeredFrozen = frozen;
        return [
          { descriptor: { name: 'mcp_list_tools' } },
          { descriptor: { name: 'mcp_call_tool' } },
        ];
      },
    },
    './McpRunClientPool': {
      McpRunClientPool: class {
        dispose() {
          return Promise.resolve();
        }
      },
    },
    './registerMcpAgentTools': {
      resolveMcpFrozenToolDefinitions: (input) => resolveFrozen(input),
    },
  },
);

const frozenTools = [
  {
    serverId: 'server-1',
    serverName: '测试服务',
    serverDescription: '测试服务简介',
    serverUrl: 'https://mcp.example/mcp',
    protocolEra: 'legacy',
    protocolVersion: '2025-11-25',
    localToolName: 'mcp.server-1.lookup',
    remoteToolName: 'lookup',
    description: '查询',
    inputSchema: { type: 'object' },
    schemaFingerprint: `sha256:${'0'.repeat(64)}`,
  },
  {
    serverId: 'server-1',
    serverName: '测试服务',
    serverDescription: '测试服务简介',
    serverUrl: 'https://mcp.example/mcp',
    protocolEra: 'legacy',
    protocolVersion: '2025-11-25',
    localToolName: 'mcp.server-1.write',
    remoteToolName: 'write',
    description: '写入',
    inputSchema: { type: 'object' },
    schemaFingerprint: `sha256:${'1'.repeat(64)}`,
  },
];

function createRegistry(names = []) {
  const registered = [];
  return {
    list: () => [...names, ...registered].map((name) => ({ name: typeof name === 'string' ? name : name.descriptor.name })),
    register: (tool) => registered.push(tool),
  };
}

serversRead = 0;
registeredFrozen = null;
resolveFrozen = async () => frozenTools;
const exposure = await resolveMcpExposure('assistant-1');
assert.deepEqual(
  exposure.allowedToolNames,
  ['mcp.server-1.lookup', 'mcp.server-1.write'],
  'MCP exposure 必须包含当前 AI 授权服务的冻结工具',
);
assert.deepEqual(
  exposure.services,
  [{ name: '测试服务', description: '测试服务简介' }],
  'MCP exposure 必须返回服务级摘要',
);
serversRead = 0;

const gated = await registerMcpToolsForHostRun({
  assistantId: 'assistant-1',
  registry: createRegistry(),
  allowedToolNames: ['mcp.server-1.lookup', 'mcp.server-1.write'],
});
assert.deepEqual(
  registeredFrozen.map(({ localToolName }) => localToolName),
  ['mcp.server-1.lookup', 'mcp.server-1.write'],
  'run 注册必须使用当前冻结快照中的全部本轮 MCP 工具',
);
assert.deepEqual(gated.allowlistMcpToolNames, ['mcp.server-1.lookup', 'mcp.server-1.write']);
assert.deepEqual(gated.metaToolNames, ['mcp_list_tools', 'mcp_call_tool']);
assert.equal(serversRead, 1, '启用 MCP 的 run 应只读取一次 server 配置');

serversRead = 0;
resolveFrozen = async () => {
  throw new Error('repository unavailable');
};
await assert.rejects(
  () => registerMcpToolsForHostRun({
  assistantId: 'assistant-1',
    registry: createRegistry(),
    allowedToolNames: ['mcp.server-1.lookup'],
  }),
  /repository unavailable/,
  'MCP repository/runtime 源错误必须透传，不能降级为“没有 MCP”',
);

serversRead = 0;
resolveFrozen = async () => frozenTools;
const disabledAtPolicyBoundary = await registerMcpToolsForHostRun({
  assistantId: 'assistant-1',
  registry: createRegistry(),
  allowedToolNames: [],
});
assert.deepEqual(disabledAtPolicyBoundary.allowlistMcpToolNames, []);
assert.deepEqual(disabledAtPolicyBoundary.metaToolNames, []);
assert.equal(serversRead, 0, 'policy 已关闭时 Host 不得重新读取或注册 MCP');

resolveFrozen = async () => [
  frozenTools[0],
];
registeredFrozen = null;
const shrunk = await registerMcpToolsForHostRun({
  assistantId: 'assistant-1',
  registry: createRegistry(),
  allowedToolNames: ['mcp.server-1.lookup', 'mcp.server-1.write'],
});
assert.deepEqual(
  registeredFrozen.map(({ localToolName }) => localToolName),
  ['mcp.server-1.lookup'],
  'run 冻结必须与本轮 allowed MCP 名称取交集',
);
assert.deepEqual(
  shrunk.allowlistMcpToolNames,
  ['mcp.server-1.lookup', 'mcp.server-1.write'],
  'run 必须返回全部请求 MCP 名称供 Host 消费，不能残留失效名称',
);

resolveFrozen = async () => [
  ...frozenTools,
  { ...frozenTools[0], serverId: 'server-2' },
];
await assert.rejects(
  () => registerMcpToolsForHostRun({
  assistantId: 'assistant-1',
    registry: createRegistry(),
    allowedToolNames: ['mcp.server-1.lookup'],
  }),
  /MCP 服务显示名重复且无法区分/,
  '同名 MCP 服务属于内部不变量，不得静默选择其中一个',
);

resolveFrozen = async () => {
  throw new TestMcpConfigError('损坏快照');
};
await assert.rejects(
  () => registerMcpToolsForHostRun({
  assistantId: 'assistant-1',
    registry: createRegistry(),
    allowedToolNames: ['mcp.server-1.lookup'],
  }),
  /损坏快照/,
  '损坏的持久化快照属于内部不变量，不得被降级吞掉',
);

// 使用真实冻结解析器验证：生效对象同时约束 Prompt 摘要、候选工具和执行冻结。
const { resolveMcpFrozenToolDefinitions: resolveScopedFrozen } = loadTypeScriptModule(
  'src/host/composition/agent/registerMcpAgentTools.ts', {
    '@features/mcpTools': { parseMcpDiscoverySnapshot: JSON.parse },
  },
);
const scopedServer = {
  id: 'server-1', name: '测试服务', description: '测试服务简介', url: 'https://mcp.example/mcp',
  credentialRef: null, enabled: true, connectionStatus: 'available', assistantIds: ['assistant-1'],
  toolSnapshotJson: JSON.stringify({ protocolEra: 'legacy', protocolVersion: '2025-11-25',
    tools: frozenTools.map((tool) => ({ remoteName: tool.remoteToolName, localName: tool.localToolName,
      description: tool.description, inputSchema: tool.inputSchema, schemaFingerprint: tool.schemaFingerprint })) }),
};
exposedServers = [scopedServer];
resolveFrozen = resolveScopedFrozen;
assert.deepEqual((await resolveMcpExposure('assistant-1')).services, [{ name: '测试服务', description: '测试服务简介' }]);
assert.deepEqual(await resolveMcpExposure('assistant-2'), { services: [], allowedToolNames: [] }, '未勾选的 AI 不得看到摘要或工具');
assert.deepEqual(await resolveMcpExposure('new-assistant'), { services: [], allowedToolNames: [] }, '后来添加的 AI 不继承 MCP 权限');
scopedServer.assistantIds = ['assistant-1', 'assistant-2'];
assert.equal((await resolveMcpExposure('assistant-2')).allowedToolNames.length, 2, '多选允许另一位 AI 使用');
const previouslyAllowed = (await resolveMcpExposure('assistant-1')).allowedToolNames;
scopedServer.assistantIds = ['assistant-2'];
const revokedRegistry = createRegistry();
const revoked = await registerMcpToolsForHostRun({ assistantId: 'assistant-1', registry: revokedRegistry,
  allowedToolNames: previouslyAllowed });
assert.deepEqual(revoked.metaToolNames, [], 'Prompt 准备后撤销对象，执行冻结必须阻止旧授权');
assert.deepEqual(revokedRegistry.list(), []);
assert.deepEqual(revoked.allowlistMcpToolNames, previouslyAllowed);
scopedServer.assistantIds = [];
assert.deepEqual(await resolveMcpExposure('assistant-2'), { services: [], allowedToolNames: [] }, '清空对象后服务不再注入任何 AI');
await resolveScopedFrozen({ assistantId: 'assistant-1', servers: [scopedServer],
  loadGrants: async () => { throw new Error('未授权的服务不应读取工具快照与授权'); } });

let processRuntimeDependencies;
let mcpResolveCalls;
let capturedProcessFlow;
let processFlowError = null;
let capturedPersistedErrorMessage = null;
const savedErrorMessages = [];
const chatReplyErrors = loadTypeScriptModule('src/features/chat/reply/application/ChatReplyErrors.ts', {
  '../../messages/application/MessagePersistence': {
    persistChatMessage: async ({ message }) => {
      const saved = { ...message, id: savedErrorMessages.length + 1 };
      savedErrorMessages.push(JSON.parse(JSON.stringify(saved)));
      return saved;
    },
  },
  './ChatReplyUtils': { formatMessageTime: () => '12:00' },
});
class ChatAgentModelRequestError extends Error {}
class ChatAgentRunFailedError extends Error {
  constructor(diagnosticText) {
    super('Chat Agent run failed');
    this.diagnosticText = diagnosticText;
  }
}
let processPreparationCalls = 0;
let processPreparation = {
  additionalPromptBlocks: [],
  managedToolNames: [],
  dynamicAllowedToolNames: [],
};
const { processAIReply } = loadTypeScriptModule(
  'src/features/chat/reply/application/ProcessAIReply.ts',
  {
    '@shared/aiTools': {
      applyHostModelRunToolExposure: (allowed, preparation) => [
        ...allowed.filter((name) => !preparation.managedToolNames.includes(name)),
        ...preparation.dynamicAllowedToolNames,
      ],
    },
    '@platform/ai': {
      createAIClient: () => ({}),
      ...loadTypeScriptModule('src/platform/ai/errorMapping.ts'),
    },
    './ChatReplyRuntimeDependencies': {
      getChatReplyRuntimeDependencies: () => processRuntimeDependencies,
    },
    './ChatReplyErrors': {
      notifyReplyFailed() {},
      saveErrorMessage: async (...args) => {
        const [, errorMessage] = args;
        capturedPersistedErrorMessage = errorMessage;
        return chatReplyErrors.saveErrorMessage(...args);
      },
    },
    './ChatReplyRuntime': {
      assemblePromptPackForRuntimeContext: async () => ({
        systemPrompt: '',
        modelMessages: [],
      }),
      buildRuntimeAIToolsConfig: (_aiConfig, runtimeContext) => ({
        allowedToolNames: runtimeContext.allowedToolNames,
      }),
      createRuntimeToolContext: () => ({}),
    },
    './ChatReplyUtils': {
      applyRuntimeModelInput: (messages) => messages,
    },
    './ChatReplyAbort': {
      assertChatReplyNotAborted() {},
      isChatReplyRunCancellationError: () => false,
      shouldSuppressReplyErrorPersistenceAsync: async () => false,
    },
    './ReplyPolicy': replyPolicyModule,
    './MemoryParticipationPolicy': {
      resolveMemoryParticipationMode: () => 'off',
    },
    '../agent/ChatAgentReplyFlow': {
      runChatAgentReplyFlow: async (params) => {
        capturedProcessFlow = params;
        if (processFlowError) {
          throw processFlowError;
        }
        return { completed: true };
      },
    },
    '../agent/ChatAgentModelGateway': {
      ChatAgentModelRequestError,
    },
    '../agent/ChatAgentRunProjector': { ChatAgentRunFailedError },
  },
);

const processBaseDependencies = {
  runPreparation: {
    prepare: async () => {
      processPreparationCalls += 1;
      return processPreparation;
    },
  },
  assistantDirectory: {
    getBlockState: async () => ({ isBlocked: false }),
  },
  tools: {
    resolveRuntimeContext: async () => ({}),
    resolveAllowedNames: async () => [],
    resolveMcpExposure: async (assistantId) => {
      assert.equal(assistantId, 'assistant-1', 'Chat 必须用 Assistant 实体 ID 解析 MCP 暴露面');
      mcpResolveCalls += 1;
      return {
        allowedToolNames: ['mcp_only'],
        services: [{ name: '测试服务', description: '测试服务简介' }],
      };
    },
    getRuntimeAllowedNames: () => [],
  },
};

async function runProcessExposureCase({
  enableTools,
  runtimeContext = {},
  toolOverrides = {},
  preparation = {
    additionalPromptBlocks: [],
    managedToolNames: [],
    dynamicAllowedToolNames: [],
  },
}) {
  processRuntimeDependencies = {
    ...processBaseDependencies,
    tools: { ...processBaseDependencies.tools, ...toolOverrides },
  };
  capturedProcessFlow = null;
  capturedPersistedErrorMessage = null;
  mcpResolveCalls = 0;
  processPreparationCalls = 0;
  processPreparation = preparation;
  await processAIReply(
    'session-1',
    '测试请求',
    { ...baseConfig, enableTools },
    1,
    {},
    {},
    runtimeContext,
    {},
  );
  assert.ok(capturedProcessFlow, 'processAIReply 必须把请求交给真实 Chat Agent Flow');
  assert.equal(processPreparationCalls, 1, '一次 Chat run 只能执行一次 Host run preparation');
  return capturedProcessFlow;
}

const disabledProcess = await runProcessExposureCase({ enableTools: false });
assert.deepEqual(
  disabledProcess.runtimeContext.allowedToolNames,
  [],
  'processAIReply 在总开关关闭时必须把空工具名单交给 Agent Flow',
);
assert.equal(
  mcpResolveCalls,
  0,
  'processAIReply 在总开关关闭时不得查询 MCP allowlist',
);

const togetherPreparedProcess = await runProcessExposureCase({
  enableTools: true,
  toolOverrides: {
    resolveAllowedNames: async () => [
      'invite_listening_together',
      'respond_to_listening_invitation',
      'leave_listening_together',
    ],
    getRuntimeAllowedNames: () => [],
  },
  preparation: {
    additionalPromptBlocks: [{ key: 'together_listening_runtime', content: 'Song A' }],
    managedToolNames: [
      'invite_listening_together',
      'respond_to_listening_invitation',
      'leave_listening_together',
    ],
    dynamicAllowedToolNames: ['respond_to_listening_invitation'],
  },
});
assert.deepEqual(
  togetherPreparedProcess.runtimeContext.allowedToolNames,
  ['mcp_only', 'respond_to_listening_invitation'],
  'Chat task 必须使用同一次 preparation 产生的 Together Listening schema exposure',
);
assert.deepEqual(
  togetherPreparedProcess.runtimeContext.promptBlocks,
  [{ key: 'together_listening_runtime', content: 'Song A' }],
  'Chat Prompt 必须消费同一次 preparation 产生的 Together Listening block',
);
const mcpOnlyProcess = await runProcessExposureCase({ enableTools: true });
assert.equal(
  mcpOnlyProcess.policy.enableTools,
  true,
  '真实 processAIReply 在 MCP-only 时必须开启工具 policy',
);
assert.deepEqual(
  mcpOnlyProcess.runtimeContext.allowedToolNames,
  ['mcp_only'],
  '真实 processAIReply 在 MCP-only 时必须把 MCP 名称交给 Agent Flow',
);

const packageAndMcpProcess = await runProcessExposureCase({
  enableTools: true,
  toolOverrides: {
    resolveAllowedNames: async () => ['package_child'],
    getRuntimeAllowedNames: (config) => [...config.allowedToolNames]
      .filter((name) => name === 'package_child'),
  },
});
assert.deepEqual(
  packageAndMcpProcess.runtimeContext.allowedToolNames,
  ['package_child', 'mcp_only'],
  'Chat 必须使用 runtime-authorized names 保留 package child concrete authorization',
);

const groupProcess = await runProcessExposureCase({
  enableTools: true,
  runtimeContext: { groupChat: { groupId: 'group-1' } },
});
assert.equal(groupProcess.policy.enableTools, true);
assert.deepEqual(
  groupProcess.runtimeContext.allowedToolNames,
  ['mcp_only'],
  '真实 processAIReply 在群聊中仍消费已授权的 MCP 工具名单',
);

const imageProcess = await runProcessExposureCase({
  enableTools: true,
  toolOverrides: {
    resolveAllowedNames: async () => ['package_child'],
    getRuntimeAllowedNames: (config) => config.allowedToolNames.filter((name) => name === 'package_child'),
  },
  runtimeContext: {
    batchModelInput: [{
      type: 'image_url',
      image_url: { url: 'file:///tmp/current-turn.png' },
    }],
  },
});
assert.equal(imageProcess.policy.enableTools, true);
assert.deepEqual(
  imageProcess.runtimeContext.allowedToolNames,
  ['package_child', 'mcp_only'],
  '真实 processAIReply 的图片输入仍须向 Agent Flow 传递已授权的内置与 MCP 工具',
);

let processConsoleErrorCount = 0;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
console.warn = () => {};
console.error = () => {
  processConsoleErrorCount += 1;
};
try {
  // 真实错误映射与持久化必须保留厂商原因，不能只留下分类后的通用提示。
  for (const reason of [
    'HTTP 400: {"message":"unsupported multipart type for this model, only support text and audio","code":"invalid_request_error"}',
    'HTTP 400: unsupported image input',
    'HTTP 400: temperature must be 1',
    'HTTP 401: invalid API key [REDACTED]',
    'HTTP 402: insufficient balance',
    'HTTP 429: code=1302, too many requests',
  ]) {
    processFlowError = new ChatAgentModelRequestError(reason);
    processConsoleErrorCount = 0;
    await runProcessExposureCase({ enableTools: false });
    assert.ok(capturedPersistedErrorMessage.includes(reason), '聊天错误气泡必须保留接口具体原因');
    assert.ok(savedErrorMessages.at(-1).text.includes(reason), '具体原因必须随错误消息持久化');
    assert.doesNotMatch(savedErrorMessages.at(-1).text, /模型服务暂时无法完成回复/u);
    assert.equal(savedErrorMessages.at(-1).senderType, 'system');
    assert.equal(JSON.parse(savedErrorMessages.at(-1).metadataJson).kind, 'error');
    assert.equal(processConsoleErrorCount, 0, '模型拒绝仍走正常失败收尾');
  }
  processFlowError = new Error('unexpected failure');
  processConsoleErrorCount = 0;
  await runProcessExposureCase({ enableTools: true });
  assert.equal(
    capturedPersistedErrorMessage,
    '处理 AI 回复时发生错误',
    '未分类 Agent 错误必须保留通用用户可见错误消息',
  );
  assert.equal(processConsoleErrorCount, 1, '未分类 Agent 错误必须继续记录 console.error');
  processFlowError = new ChatAgentRunFailedError('错误码：MODEL_PROTOCOL_ERROR\n回复编号：failed-run\n工具记录：getMomentDetail：未执行');
  await runProcessExposureCase({ enableTools: true });
  assert.match(capturedPersistedErrorMessage, /处理 AI 回复时发生错误/u);
  assert.match(capturedPersistedErrorMessage, /MODEL_PROTOCOL_ERROR/u);
  assert.match(capturedPersistedErrorMessage, /failed-run/u);
  assert.match(capturedPersistedErrorMessage, /getMomentDetail.*未执行/u,
    'Agent 失败诊断必须交给错误消息持久化，不能只存在控制台或临时工具卡片中');
  assert.match(savedErrorMessages.at(-1).text, /MODEL_PROTOCOL_ERROR/u);
  assert.match(savedErrorMessages.at(-1).text, /getMomentDetail.*未执行/u);
  assert.equal(savedErrorMessages.at(-1).senderType, 'system');
  assert.equal(JSON.parse(savedErrorMessages.at(-1).metadataJson).kind, 'error',
    '诊断沿用系统错误消息语义，不写成 AI 回复或另建日志状态');
} finally {
  processFlowError = null;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
}

const promptBuiltInContent = loadTypeScriptModule(
  'src/host/prompt/PromptBuiltInContent.ts',
);
const { PromptPackBlockFactory } = loadTypeScriptModule(
  'src/host/prompt/PromptPackBlockFactory.ts',
  {
    '@shared': { DEFAULT_SELF_NAME: '用户' },
    '@features/memory': {
      recallPassiveMemory: async () => [],
    },
    '@features/assistants': {
      agentRegistryService: { getSummary: async () => ({ entries: [], text: '' }) },
    },
    '@features/moments': {
      loadMomentActorDirectory: async () => ({
        resolve: (ref) => ({ ...ref, displayName: ref.nameSnapshot, avatar: null, exists: true }),
      }),
    },
    './PromptBuiltInContent': promptBuiltInContent,
    '@shared/prompt': {},
  },
);
const mcpPromptBlock = new PromptPackBlockFactory().createMcpServicesBlock(
  [
    { name: '无简介服务', description: '' },
    { name: '有简介服务', description: '服务简介' },
  ],
);
assert.match(
  mcpPromptBlock.content,
  /\{"name":"无简介服务"\}/,
  'MCP 服务没有简介时仍必须把服务名注入 Prompt',
);
assert.doesNotMatch(
  mcpPromptBlock.content,
  /\{"name":"无简介服务","description"/,
  'MCP 服务没有简介时不得注入空 description 字段',
);
assert.match(
  mcpPromptBlock.content,
  /\{"name":"有简介服务","description":"服务简介"\}/,
  'MCP 服务有简介时必须注入 description 字段',
);

console.log('MCP Chat exposure 行为验证通过：生效 AI 隔离、撤销后执行冻结、总开关、群聊/图片、MCP-only 与内部不变量符合契约。');
