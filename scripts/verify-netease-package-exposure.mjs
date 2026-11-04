import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
/** PHONE-8B2B2B：网易云工具包的 Catalog、Registry 与 lazy exposure 契约。 */

import assert from 'node:assert/strict';
import { loadTypeScriptModule } from './helpers/load-typescript-module.mjs';

const expectedNames = [
  'netease_search_songs',
  'netease_search_public_playlists',
  'netease_get_public_playlist',
  'netease_get_song_lyrics',
  'netease_resolve_share_link',
  'netease_play_song',
  'netease_get_playback_state',
  'netease_control_playback',
];
const readNames = expectedNames.slice(0, 5);
const catalog = loadTypeScriptModule(
  'src/features/phoneTools/toolPackages/ToolPackageCatalog.ts',
);
const neteasePackage = catalog.getPhoneToolPackageById('neteaseMusic');
assert.equal(neteasePackage.implementationStatus, 'available');
assert.equal(neteasePackage.tools.length, 8);
assert.ok(neteasePackage.tools.every(({ implementationStatus }) => implementationStatus === 'available'));
assert.deepEqual(neteasePackage.tools.map(({ toolName }) => toolName), expectedNames);

const childCalls = [];
let playbackStateFailureReason = null;
const defaultInputSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};
const getPlaybackStateSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};
const controlPlaybackSchema = {
  type: 'object',
  properties: { command: { type: 'string', enum: ['pause', 'resume', 'next', 'previous'] } },
  required: ['command'],
  additionalProperties: false,
};
const createProductionTool = (name, parameters = defaultInputSchema) => ({
  name,
  definition: {
    name,
    description: `${name} production description`,
    parameters,
  },
  execute: async (input, context) => {
    childCalls.push({ name, input, context });
    if (name === 'netease_get_playback_state' && playbackStateFailureReason !== null) {
      return {
        success: false,
        error: `${playbackStateFailureReason}: playback state failure`,
        errorCode: playbackStateFailureReason,
      };
    }
    const data = name === 'netease_get_playback_state'
      ? {
          status: 'playback_snapshot_available',
          snapshot: { playback: {}, metadata: {}, actions: {} },
        }
      : name === 'netease_control_playback'
        ? { status: 'playback_command_dispatched', command: input.command }
        : { name, ...input };
    return {
      success: true,
      data,
      message: `${name} child result`,
    };
  },
});
const createFactory = (name, parameters) => () => createProductionTool(name, parameters);
const composition = loadTypeScriptModule(
  'src/features/phoneTools/neteaseComposition.ts',
  {
    './aiTools/NetEaseSearchSongsTool': {
      createNetEaseSearchSongsTool: createFactory('netease_search_songs'),
    },
    './aiTools/NetEaseSearchPublicPlaylistsTool': {
      createNetEaseSearchPublicPlaylistsTool: createFactory('netease_search_public_playlists'),
    },
    './aiTools/NetEaseGetPublicPlaylistTool': {
      createNetEaseGetPublicPlaylistTool: createFactory('netease_get_public_playlist'),
    },
    './aiTools/NetEaseGetSongLyricsTool': {
      createNetEaseGetSongLyricsTool: createFactory('netease_get_song_lyrics'),
    },
    './aiTools/NetEaseResolveShareLinkTool': {
      createNetEaseResolveShareLinkTool: createFactory('netease_resolve_share_link'),
    },
    './aiTools/NetEasePlaySongTool': {
      createNetEasePlaySongTool: createFactory('netease_play_song'),
    },
    './aiTools/NetEaseGetPlaybackStateTool': {
      createNetEaseGetPlaybackStateTool: createFactory(
        'netease_get_playback_state',
        getPlaybackStateSchema,
      ),
    },
    './aiTools/NetEaseControlPlaybackTool': {
      createNetEaseControlPlaybackTool: createFactory(
        'netease_control_playback',
        controlPlaybackSchema,
      ),
    },
    './application/PlayNetEaseSongById': { playNetEaseSongById: async () => undefined },
    './application/NetEasePlayback': {
      getNetEasePlaybackSnapshot: async () => undefined,
      controlNetEasePlayback: async () => undefined,
    },
    './infrastructure/NativeNetEasePublicDataBackend': { nativeNetEasePublicDataBackend: {} },
    './infrastructure/NativeNetEaseShareLinkResolver': { nativeNetEaseShareLinkResolver: {} },
  },
);
const { productionNetEaseChildTools } = composition;
assert.deepEqual(productionNetEaseChildTools.map(({ name }) => name), expectedNames);

const { AgentToolRegistry } = loadTypeScriptModule(
  'src/platform/agentRuntime/AgentToolRegistry.ts',
);
const legacyAdapter = loadTypeScriptModule(
  'src/host/composition/agent/LegacyAgentToolAdapter.ts',
  { '@shared/aiTools': {} },
);
const placeholderTool = (name) => ({
  name,
  definition: { name, description: name, parameters: { type: 'object' } },
  execute: async () => ({ success: true, message: 'ok' }),
});
const featureProxy = new Proxy({}, {
  get: (_target, property) => placeholderTool(String(property)),
});
let defaultToolPermissions = {};
let toolPermissionOverrides = [];
const permissionWrites = [];
const assistantToolPermissionRepository = {
  list: async () => toolPermissionOverrides,
  set: async (permission) => {
    permissionWrites.push(permission);
    toolPermissionOverrides = [...toolPermissionOverrides.filter(({ toolName }) => toolName !== permission.toolName), permission];
  },
};
const aiAssistantRepository = {
  getById: async id => ({ id, apiBaseUrl: 'https://third-party.test/v1' }),
  listSummaries: async () => [{ id: 'host-ai', name: '主理', isHostAI: true }, { id: 'ordinary-ai', name: '普通', isHostAI: false }],
};
const registration = loadTypeScriptModule(
  'src/host/composition/agent/createAgentToolRegistry.ts',
  {
    '@platform/ai': loadTypeScriptModule('src/platform/ai/moonshotEndpoint.ts', {}),
    '@features/prompting': { readPromptDefaults: async () => ({ toolPermissions: defaultToolPermissions }) },
    '@features/webTools': featureProxy,
    '@features/media': featureProxy,
    './ApplicationSettingsTools': { applicationSettingsTools: [] },
    './GroupManagementTools': { groupManagementTools: [] },
    './ShareMomentTool': { ShareMomentTool: { name: 'share_moment', definition: { name: 'share_moment', description: '', parameters: { type: 'object' } }, execute: async () => ({ status: 'success', modelContent: 'prepared' }) } },
    '@shared/aiTools': {},
    '@features/assistants': new Proxy({
      assistantToolPermissionRepository,
      aiAssistantRepository,
    }, {
      get: (target, property) => target[property] ?? placeholderTool(String(property)),
    }),
    '@features/protocol': featureProxy,
    '@features/moments': featureProxy,
    '@features/moments/composition': {},
    '@features/wallet': featureProxy,
    '@features/calls': featureProxy,
    '@features/memory': featureProxy,
    '@features/deviceControl': featureProxy,
    '@features/companion': featureProxy,
    '@features/phoneTools': new Proxy({
      getPhoneToolPackageById: catalog.getPhoneToolPackageById,
      XiaohongshuPrepareTextNoteTool: placeholderTool('xiaohongshu_prepare_text_note'),
      XiaohongshuPublishPreparedNoteTool: placeholderTool('xiaohongshu_publish_prepared_note'),
    }, {
      get: (target, property) => target[property] ?? placeholderTool(String(property)),
    }),
    '@features/phoneTools/neteaseComposition': { productionNetEaseChildTools },
    '@features/screenCapture': featureProxy,
    '@features/chat': featureProxy,
    '@features/stickers': featureProxy,
    '@features/togetherListening': featureProxy,
    '@platform/agentRuntime': { AgentToolRegistry },
    './LegacyAgentToolAdapter': legacyAdapter,
  },
);

const registry = registration.createAgentToolRegistry({
  createLegacyContext: (context) => ({ actorAIId: context.getAIId?.() }),
});
const bindings = registration.getToolPackageRuntimeBindings(registry).filter(({ packageId }) => packageId === 'neteaseMusic');
const registryNames = bindings.map(({ tool }) => tool.descriptor.name);
assert.deepEqual(registryNames, expectedNames);
assert.ok(bindings.every(({ packageId }) => packageId === 'neteaseMusic'));
assert.deepEqual(new Set(neteasePackage.tools.map(({ toolName }) => toolName)), new Set(registryNames));
assert.deepEqual(new Set(registryNames), new Set(productionNetEaseChildTools.map(({ name }) => name)));

const descriptors = registryNames.map((name) => registry.get(name).descriptor);
for (const name of readNames) {
  const descriptor = descriptors.find((candidate) => candidate.name === name);
  assert.equal(descriptor.owner, 'phoneTools');
  assert.equal(descriptor.risk, 'safe_read');
  assert.equal(descriptor.idempotency, 'idempotent');
}
const playDescriptor = descriptors.find(({ name }) => name === 'netease_play_song');
assert.equal(playDescriptor.owner, 'phoneTools');
assert.equal(playDescriptor.risk, 'reversible_write');
assert.equal(playDescriptor.idempotency, 'not_idempotent');
const stateDescriptor = descriptors.find(({ name }) => name === 'netease_get_playback_state');
assert.equal(stateDescriptor.owner, 'phoneTools');
assert.equal(stateDescriptor.risk, 'private_read');
assert.equal(stateDescriptor.idempotency, 'idempotent');
const controlDescriptor = descriptors.find(({ name }) => name === 'netease_control_playback');
assert.equal(controlDescriptor.owner, 'phoneTools');
assert.equal(controlDescriptor.risk, 'reversible_write');
assert.equal(controlDescriptor.idempotency, 'not_idempotent');

const hostConfig = {
  enableTools: true,
  isHostAI: true,
  allowedToolNames: expectedNames,
};
assert.deepEqual(registration.getRuntimeAllowedToolNamesForAI(hostConfig), expectedNames);
assert.deepEqual(registration.getAuthorizedToolDefinitionsForAI(hostConfig).map(({ function: definition }) => definition.name), expectedNames);
assert.deepEqual(
  registration.getRuntimeAllowedToolNamesForAI({ ...hostConfig, isHostAI: false }),
  [],
  '非主理 AI 不得仅凭 caller-supplied allowlist 获得 package child',
);
assert.ok(
  expectedNames.every((name) => registration.getToolPermissionDescriptors().some((tool) => tool.name === name && tool.hostOnly)),
  '手机 child 必须进入带主理属性的权限目录，普通 AI 仍由 policy 隔离',
);
const resolvedHostNames = await registration.resolveAllowedToolNames('host-ai');
assert.ok(expectedNames.every((name) => resolvedHostNames.includes(name)));

// 手机工具共用持久权限；AI 覆盖优先于全局默认，身份与拆包不能复活关闭项。
const phoneNames = registration.getToolPermissionDescriptors()
  .filter((tool) => ['deviceControl', 'phoneTools', 'screenCapture'].includes(tool.owner)).map((tool) => tool.name);
defaultToolPermissions = Object.fromEntries(phoneNames.map((name) => [name, false]));
const disabledNames = await registration.resolveAllowedToolNames('host-ai');
assert.ok(phoneNames.every((name) => !disabledNames.includes(name)), '全局关闭必须覆盖全部手机工具和网易云 child');
toolPermissionOverrides = [{ toolName: 'netease_search_songs', enabled: true }];
const overrideNames = await registration.resolveAllowedToolNames('host-ai');
assert.ok(overrideNames.includes('netease_search_songs'));
assert.ok(phoneNames.filter((name) => name !== 'netease_search_songs').every((name) => !overrideNames.includes(name)));
defaultToolPermissions = {};
toolPermissionOverrides = phoneNames.map((toolName) => ({ toolName, enabled: false }));
const closedConfig = { ...hostConfig, allowedToolNames: await registration.resolveAllowedToolNames('host-ai') };
assert.equal(registration.getRuntimeAllowedToolNamesForAI(closedConfig).some((name) => phoneNames.includes(name)), false);
assert.equal(registration.getAuthorizedToolDefinitionsForAI(closedConfig).some(({ function: tool }) => phoneNames.includes(tool.name)), false);
toolPermissionOverrides = [];

// 真实 Host 装配和 Prompting 用例共用权限目录，页面写入必须被下一次授权冻结消费。
let promptingDependencies;
const { configurePromptingRuntime } = loadTypeScriptModule('src/host/composition/configurePromptingRuntime.ts', {
  '@platform/ai': loadTypeScriptModule('src/platform/ai/moonshotEndpoint.ts', {}),
  '@features/prompting/composition': {
    configurePromptingRuntimeDependencies: (dependencies) => { promptingDependencies = dependencies; },
    sqlitePromptingRepository: {},
    sqlitePromptDefaultsRepository: { read: async () => ({ toolPermissions: defaultToolPermissions }) },
  },
  '@features/assistants': {
    assistantToolPermissionRepository,
    aiAssistantRepository,
    getAssistantDisplayName: (assistant) => assistant.nickname || assistant.name,
    getHostAICooldownStatus: async () => ({ appointment: { isInCooldown: false } }),
  },
  '@features/mcpTools': {},
  '../prompt': { validateBuiltInPromptArchitecture: () => {} },
  './agent': registration,
});
configurePromptingRuntime();
const managementTools = await promptingDependencies.tools.list();
assert.ok(phoneNames.every((name) => managementTools.some((tool) => tool.name === name)), '提示词中心不能过滤掉手机工具');
const { getAssistantToolPermissions, setAssistantToolPermission } = loadTypeScriptModule('src/features/prompting/application/ManageAssistantPrompts.ts', {
  './PromptingRuntimeDependencies': { getPromptingRuntimeDependencies: () => promptingDependencies },
});
await setAssistantToolPermission('host-ai', 'netease_search_songs', false);
assert.equal((await getAssistantToolPermissions('host-ai')).find(({ name }) => name === 'netease_search_songs').enabled, false);
assert.equal((await registration.resolveAllowedToolNames('host-ai')).includes('netease_search_songs'), false);
await assert.rejects(() => setAssistantToolPermission('ordinary-ai', 'netease_search_songs', true), /只有主理 AI/);
assert.equal(permissionWrites.length, 1, '非主理设置不能写入');
await setAssistantToolPermission('host-ai', 'netease_search_songs', true);
assert.equal((await registration.resolveAllowedToolNames('host-ai')).includes('netease_search_songs'), true);
toolPermissionOverrides = [];

const prompt = registration.buildToolsDescription(registration.getRuntimeAllowedToolNamesForAI(hostConfig));
assert.match(prompt, /function schema/u);
assert.equal(registration.buildToolsDescription([]), '', '空授权不产生工具说明');
assert.doesNotMatch(registration.buildToolsDescription(['mcp_test']), /open_tool_package|create_ai_schedule|send_voice_message/,
  'MCP-only 复用基础规则，不虚构内置工具和拆包入口');
assert.match(registration.buildToolsDescription(['release_host_cooldown']), /function schema/,
  '动态工具复用同一说明入口，不再被静态权限策略二次过滤');
assert.doesNotMatch(registration.buildToolsDescription(['create_ai_schedule']), /update_ai_schedule/,
  '创建权限不带出修改工具名称');
const packageExposure = loadTypeScriptModule('src/host/composition/agent/ToolPackageExposure.ts', {});
const runExposure = packageExposure.registerToolPackagesForHostRun({
  registry, allowedToolNames: expectedNames, bindings, openPackageIds: [],
});
assert.deepEqual(runExposure.packageToolNames, expectedNames);
assert.deepEqual(runExposure.metaToolNames, ['open_tool_package', 'close_tool_package']);
assert.deepEqual(runExposure.visibleToolNames(), []);
assert.match(runExposure.instructions().catalog, /网易云音乐/u);
assert.doesNotMatch(runExposure.instructions().catalog, /"properties"|"required"/u);
const inputSchemaModule = loadTypeScriptModule('src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);
const { AgentToolExecutor } = loadTypeScriptModule('src/platform/agentRuntime/AgentToolExecutor.ts', {
  '@shared/aiTools': inputSchemaModule,
  './AgentRunState': loadTypeScriptModule('src/platform/agentRuntime/AgentRunState.ts'),
});
const executor = new AgentToolExecutor(registry);
const context = {
  runId: 'netease-package-run', task: { allowedToolNames: [...expectedNames, 'open_tool_package'] },
  toolCallId: 'call-1', abortSignal: new AbortController().signal, getAIId: () => 'host-ai',
};
const opened = await registry.get('open_tool_package').execute({ package_id: 'neteaseMusic' }, context);
assert.deepEqual(opened.metadata.toolPackageChange, { packageId: 'neteaseMusic', action: 'open' });
assert.deepEqual(runExposure.visibleToolNames(), expectedNames);
const callTool = { async execute(input, executionContext) {
  const prepared = executor.prepare({ id: executionContext.toolCallId, name: input.tool_name,
    arguments: JSON.stringify(input.arguments) }, context.task);
  return prepared.status === 'rejected' ? prepared.outcome : executor.execute(prepared, executionContext);
} };
const invalid = await callTool.execute({
  package_id: 'neteaseMusic',
  tool_name: 'netease_search_songs',
  arguments: {},
}, context);
assert.equal(invalid.code, 'TOOL_INPUT_INVALID');
assert.equal(childCalls.length, 0);
for (const toolName of ['netease_search_songs', 'netease_play_song']) {
  const result = await callTool.execute({
    package_id: 'neteaseMusic',
    tool_name: toolName,
    arguments: { value: 'accepted' },
  }, context);
  assert.equal(result.status, 'success');
  assert.equal(result.data.name, toolName);
  assert.equal(result.modelContent, `${toolName} child result`);
}
const stateResult = await callTool.execute({
  package_id: 'neteaseMusic',
  tool_name: 'netease_get_playback_state',
  arguments: {},
}, context);
assert.equal(stateResult.status, 'success');
assert.equal(stateResult.data.status, 'playback_snapshot_available');
assert.deepEqual(Object.keys(stateResult.data.snapshot), ['playback', 'metadata', 'actions']);

playbackStateFailureReason = 'no_active_session';
const stateFailure = await callTool.execute({
  package_id: 'neteaseMusic',
  tool_name: 'netease_get_playback_state',
  arguments: {},
}, context);
assert.equal(stateFailure.status, 'error');
assert.equal(stateFailure.code, 'no_active_session');
playbackStateFailureReason = null;

for (const command of ['pause', 'resume', 'next', 'previous']) {
  const result = await callTool.execute({
    package_id: 'neteaseMusic',
    tool_name: 'netease_control_playback',
    arguments: { command },
  }, context);
  assert.equal(result.status, 'success');
  assert.equal(result.data.status, 'playback_command_dispatched');
  assert.equal(result.data.command, command);
}
const callsBeforeInvalidCommands = childCalls.length;
for (const command of ['play', 'stop', 'seek', 'PAUSE', '']) {
  const result = await callTool.execute({
    package_id: 'neteaseMusic',
    tool_name: 'netease_control_playback',
    arguments: { command },
  }, context);
  assert.equal(result.code, 'TOOL_INPUT_INVALID');
}
assert.equal(childCalls.length, callsBeforeInvalidCommands);
assert.deepEqual(childCalls.map(({ name }) => name), [
  'netease_search_songs',
  'netease_play_song',
  'netease_get_playback_state',
  'netease_get_playback_state',
  'netease_control_playback',
  'netease_control_playback',
  'netease_control_playback',
  'netease_control_playback',
]);

console.log('NetEase 唯一 Registry、拆包暴露与原始工具执行边界验证通过。');
