import assert from 'node:assert/strict';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';

// MCP 服务状态是独立于选中 AI 的全局端口，UI 操作不得落到 per-AI 工具权限。
const mcpServiceDependencies = {
  mcpServices: {
    list: async () => [{
      id: 'server-1',
      name: '记忆库',
      description: '',
      enabled: true,
      connectionStatus: 'available',
      enabledToolCount: 2,
    }],
    setEnabled: async (id, enabled) => ({
      id,
      name: '记忆库',
      description: '',
      enabled,
      connectionStatus: 'available',
      enabledToolCount: 2,
    }),
  },
};
const { getPromptCenterMcpServices, setPromptCenterMcpServiceEnabled } = loadTypeScriptModule(
  'src/features/prompting/application/ManageMcpServices.ts',
  {
    './PromptingRuntimeDependencies': {
      getPromptingRuntimeDependencies: () => mcpServiceDependencies,
    },
  },
);
assert.deepEqual(await getPromptCenterMcpServices(), await mcpServiceDependencies.mcpServices.list());
assert.deepEqual(
  await setPromptCenterMcpServiceEnabled('server-1', false),
  {
    id: 'server-1',
    name: '记忆库',
    description: '',
    enabled: false,
    connectionStatus: 'available',
    enabledToolCount: 2,
  },
  'MCP 服务开关必须直接返回全局 server.enabled 状态',
);

let configuredPromptingDependencies;
let editorAPIBaseURL = 'https://third-party.test/v1';
const editorPermissionWrites = [];
const builtInToolDescriptors = [{
  name: 'search_protocols',
  description: '读取协议',
  defaultEnabled: true,
  mutating: false,
  callOnly: false,
}];
let server = {
  id: 'server-1',
  name: '记忆库',
  description: '',
  enabled: true,
  connectionStatus: 'available',
  enabledToolCount: 2,
};
const configuredPrompting = loadTypeScriptModule(
  'src/host/composition/configurePromptingRuntime.ts',
  {
    '@platform/ai': loadTypeScriptModule('src/platform/ai/moonshotEndpoint.ts'),
    '@features/prompting/composition': {
      configurePromptingRuntimeDependencies: (dependencies) => {
        configuredPromptingDependencies = dependencies;
      },
      sqlitePromptingRepository: { setDirectToolExposure: async (...args) => editorPermissionWrites.push(args) },
    },
    '@features/assistants': {
      aiAssistantRepository: { getById: async () => ({ apiBaseUrl: editorAPIBaseURL }) },
      assistantToolPermissionRepository: { set: async permission => editorPermissionWrites.push(permission) },
    },
    '@features/chat': { getAssistantChatSummaryGenerationState: async () => ({ primaryEnabled: true, secondaryEnabled: false }) },
    '@features/mcpTools': {
      listMcpServersWithEnabledToolCounts: async () => [server],
      setMcpServerEnabled: async (id, enabled) => {
        assert.equal(id, server.id);
        server = { ...server, enabled };
        return server;
      },
    },
    '../prompt': {
      getSystemPromptPreset: () => ({}),
      promptCatalog: {},
      validateBuiltInPromptArchitecture: () => {},
    },
    './agent': { getToolPermissionDescriptors: () => builtInToolDescriptors },
  },
);
configuredPrompting.configurePromptingRuntime();
assert.deepEqual(await configuredPromptingDependencies.summary.getGenerationState('ai-1'), { primaryEnabled: true, secondaryEnabled: false });
assert.deepEqual(
  await configuredPromptingDependencies.tools.list(),
  builtInToolDescriptors,
  '提示词中心工具目录只能返回 Built-in 工具，不能返回 MCP 具体工具',
);
builtInToolDescriptors.push({ name: 'kimi_web_search', owner: 'webTools', moonshotOnly: true, defaultEnabled: false });
const editorManagement = loadTypeScriptModule('src/features/prompting/application/ManageAssistantPrompts.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => configuredPromptingDependencies },
});
assert.match((await configuredPromptingDependencies.tools.list('ai-1')).find(tool => tool.name === 'kimi_web_search').unavailableReason, /当前接口不支持/u);
await assert.rejects(editorManagement.setAssistantToolPermission('ai-1', 'kimi_web_search', true), /当前接口不支持/u);
await assert.rejects(editorManagement.setAssistantDirectToolExposure('ai-1', 'kimi_web_search', true), /当前接口不支持/u);
assert.equal(editorPermissionWrites.length, 0, '不支持的接口不能修改工具权限或星标');
editorAPIBaseURL = 'https://api.moonshot.cn/v1';
assert.equal((await configuredPromptingDependencies.tools.list('ai-1')).find(tool => tool.name === 'kimi_web_search').unavailableReason, undefined);
await editorManagement.setAssistantToolPermission('ai-1', 'kimi_web_search', true);
await editorManagement.setAssistantDirectToolExposure('ai-1', 'kimi_web_search', true);
assert.equal(editorPermissionWrites.length, 2);
assert.deepEqual(
  await configuredPromptingDependencies.mcpServices.list(),
  [server],
  'MCP 服务列表必须由全局服务配置提供',
);
assert.deepEqual(
  await configuredPromptingDependencies.mcpServices.setEnabled('server-1', false),
  { ...server, enabled: false },
  'MCP 服务开关必须直写 server.enabled，不得经过 assistant_tool_permissions',
);

// 目录定义依赖真实内置正文，必须整体加载真实模块而不是占位正文。
const promptBuiltInContent = loadTypeScriptModule('src/host/prompt/PromptBuiltInContent.ts', {});
const promptDefinitions = loadTypeScriptModule(
  'src/host/prompt/catalog/hostPromptDefinitions.ts',
  { '../PromptBuiltInContent': promptBuiltInContent },
);
const toolsDescriptionDefinition = promptDefinitions.HOST_PROMPT_DEFINITIONS.find(
  (definition) => definition.id === 'context.tools_description',
);
assert.equal(
  toolsDescriptionDefinition?.protection,
  'locked',
  'tools_description 必须是受保护的运行时说明',
);

const { resolvePromptBlockMetadata } = loadTypeScriptModule(
  'src/host/prompt/compiler/promptBlockMetadata.ts',
);
assert.equal(
  resolvePromptBlockMetadata({ key: 'tools_description' }, 'chat.private_reply').protection,
  'locked',
  '旧 Block key 的元数据也必须保持 tools_description 的运行时保护语义',
);

// 回归：conditionMatches 对运行时遗留 condition 一律 false，不再末尾兜底 tools_enabled。
const { resolveAssistantPromptConfiguration } = loadTypeScriptModule(
  'src/features/prompting/application/ManageAssistantPrompts.ts',
  {
    './PromptingRuntimeDependencies': {
      getPromptingRuntimeDependencies: () => ({
        defaults: { read: async () => ({ overrides: {}, userPrompts: [], toolPermissions: {}, timeEnabled: true }) },
        assistantPrompts: {
          getAssistantSettings: async () => ({ assistantId: 'a1', languageMode: 'zh-CN', createdAt: '', updatedAt: '' }),
          listDefinitionStates: async () => [],
          listDefinitionOverrides: async () => [],
          listAssistantUserPrompts: async () => [
            { id: 'p-always', assistantId: 'a1', name: '常驻', content: 'x', condition: 'always', enabled: true, sortOrder: 1, createdAt: '', updatedAt: '' },
            { id: 'p-legacy', assistantId: 'a1', name: '遗留', content: 'x', condition: 'raven_cat_proactive', enabled: true, sortOrder: 2, createdAt: '', updatedAt: '' },
            { id: 'p-moments', assistantId: 'a1', name: '退役时刻', content: 'x', condition: 'moments', enabled: true, sortOrder: 3, createdAt: '', updatedAt: '' },
            { id: 'p-tools', assistantId: 'a1', name: '工具', content: 'x', condition: 'tools_enabled', enabled: true, sortOrder: 4, createdAt: '', updatedAt: '' },
          ],
        },
      }),
    },
  },
);
const resolvedWithTools = await resolveAssistantPromptConfiguration({
  assistantId: 'a1', scenarioId: 'chat.private_reply', toolsEnabled: true,
});
assert.deepEqual(
  resolvedWithTools.userPrompts.map((prompt) => prompt.condition).sort(),
  ['always', 'tools_enabled'],
  '遗留 raven_cat_proactive 与 moments 即使 toolsEnabled=true 也不得匹配任何现存 scenario',
);
const resolvedWithoutTools = await resolveAssistantPromptConfiguration({
  assistantId: 'a1', scenarioId: 'chat.private_reply', toolsEnabled: false,
});
assert.deepEqual(
  resolvedWithoutTools.userPrompts.map((prompt) => prompt.condition).sort(),
  ['always'],
  'tools_enabled=false 时不得兜底匹配，遗留 condition 同样不匹配',
);
// 视觉识别正文与两级摘要共用同一优先级：AI 覆盖 → 全局默认 → 内置正文。
let visionOverrides = [];
let visionDefaults = {};
const { resolveVisionOCRPrompt } = loadTypeScriptModule(
  'src/features/prompting/application/ManageAssistantPrompts.ts',
  {
    './PromptingRuntimeDependencies': {
      getPromptingRuntimeDependencies: () => ({
        catalog: { getById: (id) => (id === 'internal.vision_ocr' ? { id, defaultContent: '内置图片识别正文' } : null) },
        defaults: {
          read: async () => ({
            overrides: visionDefaults, userPrompts: [], toolPermissions: {},
            appToolPackages: {}, agentRegistryExcludedAssistantIds: [],
          }),
        },
        assistantPrompts: {
          listDefinitionStates: async () => [],
          listDefinitionOverrides: async () => visionOverrides,
          listAssistantUserPrompts: async () => [],
        },
      }),
    },
  },
);
assert.equal(await resolveVisionOCRPrompt('ai-1'), '内置图片识别正文', '没有覆盖时必须回落到内置正文');
visionDefaults = { 'internal.vision_ocr': '全局图片识别正文' };
assert.equal(await resolveVisionOCRPrompt('ai-1'), '全局图片识别正文', '全局默认正文优先于内置正文');
visionOverrides = [{ assistantId: 'ai-1', definitionId: 'internal.vision_ocr', locale: 'zh-CN', content: '这位 AI 的图片识别正文' }];
assert.equal(await resolveVisionOCRPrompt('ai-1'), '这位 AI 的图片识别正文', 'AI 覆盖优先于全局默认');
visionOverrides = [{ assistantId: 'ai-1', definitionId: 'internal.vision_ocr', locale: 'en-US', content: 'legacy english' }];
assert.equal(await resolveVisionOCRPrompt('ai-1'), '全局图片识别正文', '历史英文覆盖不参与注入');

// 群摘要只读自己的全局正文：不读取任何 AI 覆盖，单聊定义也不参与。
let summaryOverrides = [];
const summaryOverrideReads = [];
let summaryDefaults = {};
const { resolveChatSummaryPromptOverride } = loadTypeScriptModule(
  'src/features/prompting/application/ManageAssistantPrompts.ts',
  {
    './PromptingRuntimeDependencies': {
      getPromptingRuntimeDependencies: () => ({
        defaults: {
          read: async () => ({
            overrides: summaryDefaults, userPrompts: [], toolPermissions: {},
            appToolPackages: {}, agentRegistryExcludedAssistantIds: [],
          }),
        },
        assistantPrompts: {
          listDefinitionOverrides: async (assistantId) => { summaryOverrideReads.push(assistantId); return summaryOverrides; },
          listDefinitionStates: async () => [],
          listAssistantUserPrompts: async () => [],
        },
      }),
    },
  },
);
assert.equal(await resolveChatSummaryPromptOverride('ai-1', 'primary', 'group'), undefined);
assert.equal(await resolveChatSummaryPromptOverride('ai-1', 'secondary', 'group'), undefined);
summaryDefaults = { 'internal.chat_summary': '全局一级正文', 'internal.group_chat_secondary_summary': '全局群二级正文' };
assert.equal(await resolveChatSummaryPromptOverride(null, 'primary', 'group'), undefined, '群一级不读单聊的全局正文');
assert.equal(await resolveChatSummaryPromptOverride(null, 'secondary', 'group'), '全局群二级正文');
summaryOverrides = [
  { assistantId: 'ai-1', definitionId: 'internal.chat_summary', locale: 'zh-CN', content: '专属一级正文' },
  { assistantId: 'ai-1', definitionId: 'internal.group_chat_summary', locale: 'zh-CN', content: '不该生效的群正文' },
];
assert.equal(await resolveChatSummaryPromptOverride('ai-1', 'primary'), '专属一级正文');
const readsBeforeGroup = summaryOverrideReads.length;
assert.equal(await resolveChatSummaryPromptOverride('ai-1', 'primary', 'group'), undefined, '群摘要不得借用某个 AI 的覆盖');
assert.equal(summaryOverrideReads.length, readsBeforeGroup, '群摘要不读取任何 AI 覆盖');

// 默认页与 AI 详情复用同一份 defaults；未传快照的独立调用仍自行读取。
let defaultsReads = 0;
const sharedDefaults = {
  overrides: {}, userPrompts: [], toolPermissions: { search_protocols: true },
  appToolPackages: {}, agentRegistryExcludedAssistantIds: [],
};
const snapshotRuntime = {
  defaults: { read: async () => { defaultsReads += 1; return sharedDefaults; } },
  tools: {
    list: async () => [{ name: 'search_protocols', description: '读取协议', defaultEnabled: false, mutating: false, callOnly: false }],
    listOverrides: async () => [{ toolName: 'search_protocols', enabled: false }],
  },
  assistantPrompts: {
    getAssistantSettings: async () => null,
    listDefinitionStates: async () => [],
    listDefinitionOverrides: async () => [],
    listAssistantUserPrompts: async () => [],
    listDirectToolNames: async () => [],
  },
};
const snapshotMocks = { './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => snapshotRuntime } };
const { getDefaultPromptEditor } = loadTypeScriptModule('src/features/prompting/application/ManagePromptDefaults.ts', snapshotMocks);
const { getAssistantPromptEditorDetails, getAssistantToolPermissions } = loadTypeScriptModule(
  'src/features/prompting/application/ManageAssistantPrompts.ts', snapshotMocks,
);
const next = await getDefaultPromptEditor();
const details = await getAssistantPromptEditorDetails('assistant-1', next);
assert.equal(defaultsReads, 1, '默认页与 AI 详情必须复用同一份 defaults 快照');
assert.equal(next.tools[0].enabled, true, '全局默认权限保持不变');
assert.equal(details.tools[0].enabled, false, 'AI 覆盖仍优先于全局默认');
await getAssistantToolPermissions('assistant-2');
assert.equal(defaultsReads, 2, '未传快照的独立调用仍按原契约读取配置');

console.log('提示词中心 MCP 服务端口、工具权限、条件匹配与受保护定义检查通过。');
