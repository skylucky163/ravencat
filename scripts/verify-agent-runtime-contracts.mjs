import { agentToolSchemaDependencies } from './helpers/agent-tool-schema-dependencies.mjs';
import assert from 'node:assert/strict';
import { loadTypeScriptModule, readRepoFile as read } from './helpers/load-typescript-module.mjs';

const abortSignalRuntime = loadTypeScriptModule(
  'src/shared/runtime/abortSignal.ts',
);

const { AgentToolRegistry } = loadTypeScriptModule(
  'src/platform/agentRuntime/AgentToolRegistry.ts'
);
const {
  LegacyAgentToolAdapter,
  convertLegacyToolResult,
} = loadTypeScriptModule(
  'src/host/composition/agent/LegacyAgentToolAdapter.ts'
);

const runtimePublicIndex = read('src/platform/agentRuntime/index.ts');
const runtimePublicSymbols = runtimePublicIndex.replace(/from\s+'[^']+';/gu, '');
for (const internalSymbol of [
  'AgentRunLoop',
  'AgentBudgetGuard',
  'AgentOperationGuard',
  'AGENT_RUNTIME_HARD_LIMITS',
  'validateAgentTaskBudget',
  'AgentToolExecutor',
  'matchesAgentToolInputSchema',
  'markRunTerminal',
  'AgentRuntimeDependencies',
  'AgentRunLoopContext',
  'AgentRunLoopDependencies',
  'AgentClock',
  'AgentBudgetSnapshot',
  'AgentRemainingDeadline',
  'AgentRunState',
  'AgentRunStatus',
  'AgentStepRecord',
]) {
  assert.doesNotMatch(
    runtimePublicSymbols,
    new RegExp(`\\b${internalSymbol}\\b`, 'u'),
    `${internalSymbol} 仅供 Agent Runtime 内部使用，不得从 platform 公共出口暴露`,
  );
}

function createAgentTool(name) {
  return {
    descriptor: {
      name,
      description: `${name} 测试工具`,
      inputSchema: { type: 'object' },
      owner: 'test',
      source: 'local',
      risk: 'safe_read',
      idempotency: 'idempotent',
    },
    execute: async () => ({ status: 'success', data: null, modelContent: 'ok' }),
  };
}

const registry = new AgentToolRegistry();
const firstTool = createAgentTool('first');
const secondTool = createAgentTool('second');
registry.register(firstTool);
registry.register(secondTool);
assert.throws(
  () => registry.register(firstTool),
  /already registered/,
  '同名 Agent 工具必须立即失败'
);
assert.deepEqual(
  registry.list().map((descriptor) => descriptor.name),
  ['first', 'second'],
  'Registry 必须保持注册顺序'
);
assert.deepEqual(
  registry.listAllowed(['second']).map((descriptor) => descriptor.name),
  ['second'],
  '允许列表不得泄漏其他工具'
);
assert.throws(
  () => registry.listAllowed(['missing']),
  /Unknown allowed Agent tool/,
  '未知 allowed tool name 必须立即失败'
);

const abortController = new AbortController();
const executionContext = {
  runId: 'run-1',
  task: {},
  toolCallId: 'call-1',
  abortSignal: abortController.signal,
};
const legacyContext = { marker: 'legacy-context' };
let receivedInput;
let receivedContext;
const receivedExecutionContexts = [];
const legacyTool = {
  name: 'legacy_test',
  definition: {
    name: 'legacy_test',
    description: '旧工具测试定义',
    parameters: { type: 'object', properties: {} },
  },
  execute: async (input, context) => {
    receivedInput = input;
    receivedContext = context;
    return { success: true, message: '旧工具完成', data: { value: 1 } };
  },
};
const adapter = new LegacyAgentToolAdapter(
  legacyTool,
  {
    owner: 'test',
    risk: 'safe_read',
    idempotency: 'idempotent',
  },
  (context) => {
    receivedExecutionContexts.push(context);
    return { ...legacyContext, abortSignal: context.abortSignal };
  },
);
const adaptedResult = await adapter.execute({ value: 1 }, executionContext);
assert.equal(
  receivedExecutionContexts[0],
  executionContext,
  'adapter 必须把完整 Agent 上下文交给 context factory',
);
assert.deepEqual(receivedInput, { value: 1 });
assert.equal(receivedContext.marker, legacyContext.marker);
assert.equal(
  receivedContext.abortSignal,
  executionContext.abortSignal,
  'Legacy ToolContext 必须收到当前 execution 的 abortSignal',
);
assert.deepEqual(adaptedResult, {
  status: 'success',
  data: { value: 1 },
  modelContent: '旧工具完成',
});
const nextAbortController = new AbortController();
const nextExecutionContext = {
  ...executionContext,
  toolCallId: 'call-2',
  abortSignal: nextAbortController.signal,
};
await adapter.execute({ value: 2 }, nextExecutionContext);
assert.equal(receivedExecutionContexts[1], nextExecutionContext);
assert.equal(
  receivedContext.abortSignal,
  nextAbortController.signal,
  'Legacy context factory 每次都必须消费当前 execution context，不得固定旧 signal',
);
assert.deepEqual(
  convertLegacyToolResult({ success: false, error: '旧工具失败' }),
  {
    status: 'error',
    code: 'LEGACY_TOOL_EXECUTION_FAILED',
    retryable: false,
    modelContent: '旧工具失败',
  },
  '旧工具失败必须转换为稳定结构化错误'
);
assert.throws(
  () => convertLegacyToolResult({ success: true }),
  /missing model content/,
  '旧工具不得用空文本静默表示成功'
);
assert.throws(
  () => convertLegacyToolResult({ success: false }),
  /missing model content/,
  '旧工具不得用默认文案掩盖无诊断信息的失败'
);
const throwingAdapter = new LegacyAgentToolAdapter(
  {
    ...legacyTool,
    execute: async () => {
      throw new Error('legacy invariant failed');
    },
  },
  {
    owner: 'test',
    risk: 'safe_read',
    idempotency: 'idempotent',
  },
  () => legacyContext,
);
await assert.rejects(
  () => throwingAdapter.execute({}, executionContext),
  /legacy invariant failed/,
  'adapter 不得吞掉旧工具抛出的异常'
);

const SAFE_READ = {
  risk: 'safe_read',
  idempotency: 'idempotent',
};
const PRIVATE_READ = {
  risk: 'private_read',
  idempotency: 'idempotent',
};
const REVERSIBLE_WRITE = {
  risk: 'reversible_write',
  idempotency: 'key_required',
};
const REVERSIBLE_ACTION = {
  risk: 'reversible_write',
  idempotency: 'not_idempotent',
};
const EXTERNAL_SIDE_EFFECT = {
  risk: 'external_side_effect',
  idempotency: 'not_idempotent',
};
const SENSITIVE_ACTION = {
  risk: 'sensitive_action',
  idempotency: 'not_idempotent',
};

const builtInTools = [
  ...[
    ['search_groups', false, true], ['join_group', false, false], ['add_group_member', false, false],
    ['remove_group_member', true, false], ['mute_group_member', true, false],
    ['unmute_group_member', true, false], ['leave_group', false, false], ['rename_group', false, false],
  ].map(([name, hostOnly, readOnly]) => ({ module: './GroupManagementTools', symbol: name, name, owner: 'chat', hostOnly, readOnly,
    ...(readOnly ? PRIVATE_READ : REVERSIBLE_ACTION) })),
  { module: '@features/webTools', symbol: 'KimiWebSearchTool', name: 'kimi_web_search', owner: 'webTools', ...SAFE_READ },
  { module: '@features/webTools', symbol: 'KimiWebFetchTool', name: 'kimi_web_fetch', owner: 'webTools', ...SAFE_READ },
  { module: '@features/webTools', symbol: 'KimiMewTool', name: 'kimi_mew', owner: 'webTools', risk: 'safe_read', idempotency: 'not_idempotent' },
  { module: '@features/webTools', symbol: 'WebSearchTool', name: 'web_search', owner: 'webTools', ...SAFE_READ },
  { module: '@features/webTools', symbol: 'WebFetchTool', name: 'web_fetch', owner: 'webTools', ...SAFE_READ },
  { module: '@features/webTools', symbol: 'DownloadFileTool', name: 'download_file', owner: 'webTools', ...REVERSIBLE_ACTION },
  { module: '@features/media', symbol: 'DownloadImageTool', name: 'download_image', owner: 'media', ...REVERSIBLE_ACTION },
  { module: '@features/media', symbol: 'QueryDownloadedImagesTool', name: 'query_downloaded_images', owner: 'media', ...PRIVATE_READ },
  { module: '@features/media', symbol: 'ViewImageTool', name: 'view_image', owner: 'media', ...PRIVATE_READ },
  ...[
    ['get_user_avatar', 'profile', false, false], ['get_ai_avatar', 'assistants', false, false],
    ['get_group_avatar', 'chat', false, false],
    ['get_own_space_cover', 'assistants', false, false],
    ['get_chat_background', 'profile', false, false], ['get_call_background', 'calls', false, false],
    ['get_global_background', 'profile', true, false], ['get_moments_cover', 'profile', false, false],
    ['set_ai_avatar', 'assistants', false, true], ['set_chat_background', 'profile', false, true],
    ['set_own_space_cover', 'assistants', false, true],
    ['set_call_background', 'calls', false, true], ['set_user_avatar', 'profile', true, true],
    ['set_moments_cover', 'profile', true, true], ['set_global_background', 'profile', true, true],
    ['set_ai_name', 'assistants', false, true],
  ].map(([name, owner, hostOnly, mutating]) => ({ module: './ApplicationSettingsTools', symbol: name, name, owner, hostOnly, mutating,
    ...(mutating ? REVERSIBLE_ACTION : PRIVATE_READ) })),
  { module: '@features/stickers', symbol: 'AddOwnStickerTool', name: 'add_own_sticker', owner: 'stickers', ...REVERSIBLE_ACTION },
  { module: '@features/stickers', symbol: 'MaintainOwnStickerTool', name: 'maintain_own_sticker', owner: 'stickers', ...REVERSIBLE_ACTION },
  { module: '@features/protocol', symbol: 'GetProtocolsTool', name: 'getProtocols', owner: 'protocol', ...SAFE_READ },
  { module: '@features/protocol', symbol: 'SearchProtocolsTool', name: 'searchProtocols', owner: 'protocol', ...SAFE_READ },
  { module: '@features/protocol', symbol: 'AddProtocolTool', name: 'addProtocol', owner: 'protocol', ...REVERSIBLE_WRITE },
  { module: '@features/protocol', symbol: 'UpdateProtocolTool', name: 'updateProtocol', owner: 'protocol', ...REVERSIBLE_WRITE },
  { module: '@features/protocol', symbol: 'DeleteProtocolTool', name: 'deleteProtocol', owner: 'protocol', ...REVERSIBLE_WRITE },
  { module: '@features/moments', symbol: 'SearchMomentsTool', name: 'searchMoments', owner: 'moments', ...SAFE_READ },
  { module: '@features/moments', symbol: 'GetMomentDetailTool', name: 'getMomentDetail', owner: 'moments', ...SAFE_READ },
  { module: '@features/moments', symbol: 'ReadSocialInboxTool', name: 'readSocialInbox', owner: 'moments', ...SAFE_READ },
  { module: '@features/moments', symbol: 'AILikeMomentTool', name: 'aiLikeMoment', owner: 'moments', ...REVERSIBLE_WRITE },
  { module: '@features/moments', symbol: 'AICommentMomentTool', name: 'aiCommentMoment', owner: 'moments', ...REVERSIBLE_WRITE },
  { module: '@features/moments', symbol: 'AICreateMomentTool', name: 'aiCreateMoment', owner: 'moments', ...REVERSIBLE_WRITE },
  { module: '@features/moments', symbol: 'AIReplyMomentCommentTool', name: 'aiReplyMomentComment', owner: 'moments', ...REVERSIBLE_WRITE },
  { module: '@features/moments', symbol: 'AIUnlikeMomentTool', name: 'aiUnlikeMoment', owner: 'moments', ...REVERSIBLE_WRITE },
  { module: '@features/moments', symbol: 'AIDeleteOwnMomentTool', name: 'aiDeleteOwnMoment', owner: 'moments', ...REVERSIBLE_WRITE },
  { module: '@features/moments', symbol: 'AIDeleteOwnMomentCommentTool', name: 'aiDeleteOwnMomentComment', owner: 'moments', ...REVERSIBLE_WRITE },
  { module: '@features/wallet', symbol: 'GetLedgerContextTool', name: 'getLedgerContext', owner: 'wallet', ...PRIVATE_READ },
  { module: '@features/wallet', symbol: 'AddLedgerRecordTool', name: 'addLedgerRecord', owner: 'wallet', ...REVERSIBLE_ACTION },
  { module: '@features/wallet', symbol: 'UpdateLedgerRecordTool', name: 'updateLedgerRecord', owner: 'wallet', ...REVERSIBLE_ACTION },
  { module: '@features/wallet', symbol: 'DeleteLedgerRecordTool', name: 'deleteLedgerRecord', owner: 'wallet', ...REVERSIBLE_ACTION },
  { module: '@features/wallet', symbol: 'CreateLedgerQuickActionTool', name: 'createLedgerQuickAction', owner: 'wallet', ...REVERSIBLE_ACTION },
  { module: '@features/wallet', symbol: 'UpdateLedgerQuickActionTool', name: 'updateLedgerQuickAction', owner: 'wallet', ...REVERSIBLE_ACTION },
  { module: '@features/wallet', symbol: 'DeleteLedgerQuickActionTool', name: 'deleteLedgerQuickAction', owner: 'wallet', ...REVERSIBLE_ACTION },
  { module: '@features/wallet', symbol: 'UseLedgerQuickActionTool', name: 'useLedgerQuickAction', owner: 'wallet', ...REVERSIBLE_ACTION },
  { module: '@features/calls', symbol: 'RequestVideoCallTool', name: 'requestVideoCall', owner: 'calls', ...EXTERNAL_SIDE_EFFECT },
  { module: '@features/calls', symbol: 'LookAtUserTool', name: 'lookAtUser', owner: 'calls', ...SENSITIVE_ACTION },
  { module: '@features/memory', symbol: 'RememberMemoryTool', name: 'remember_memory', owner: 'memory', ...REVERSIBLE_WRITE },
  { module: '@features/memory', symbol: 'ConvertExitedGroupHistoryTool', name: 'convert_exited_group_history_to_memory', owner: 'memory', ...REVERSIBLE_WRITE },
  { module: '@features/memory', symbol: 'RecallMemoryTool', name: 'recall_memory', owner: 'memory', ...PRIVATE_READ },
  { module: '@features/memory', symbol: 'UpdateMemoryTool', name: 'update_memory', owner: 'memory', ...REVERSIBLE_WRITE },
  { module: '@features/memory', symbol: 'ForgetMemoryTool', name: 'forget_memory', owner: 'memory', ...REVERSIBLE_WRITE },
  { module: '@features/assistants', symbol: 'BlockAIAssistantTool', name: 'blockAIAssistant', owner: 'assistants', ...SENSITIVE_ACTION },
  { module: '@features/assistants', symbol: 'UnblockAIAssistantTool', name: 'unblockAIAssistant', owner: 'assistants', ...SENSITIVE_ACTION },
  { module: '@features/assistants', symbol: 'ReleaseHostCooldownTool', name: 'release_host_cooldown', owner: 'assistants', ...SENSITIVE_ACTION },
  { module: '@features/deviceControl', symbol: 'SoftLockAppTool', name: 'soft_lock_app', owner: 'deviceControl', ...SENSITIVE_ACTION },
  { module: '@features/deviceControl', symbol: 'ReleaseSoftLockTool', name: 'release_soft_lock', owner: 'deviceControl', ...SENSITIVE_ACTION },
  { module: '@features/deviceControl', symbol: 'SearchInstalledAppsTool', name: 'search_installed_apps', owner: 'deviceControl', ...PRIVATE_READ },
  { module: '@features/deviceControl', symbol: 'OpenAppTool', name: 'open_app', owner: 'deviceControl', ...REVERSIBLE_ACTION },
  { module: '@features/phoneTools', symbol: 'GetForegroundAppTool', name: 'get_foreground_app', owner: 'phoneTools', ...PRIVATE_READ },
  { module: '@features/phoneTools', symbol: 'GetAppUsageTool', name: 'get_app_usage', owner: 'phoneTools', ...PRIVATE_READ },
  { module: '@features/phoneTools', symbol: 'GetCurrentLocationTool', name: 'get_current_location', owner: 'phoneTools', ...PRIVATE_READ },
  { module: '@features/phoneTools', symbol: 'ReadClipboardTool', name: 'read_clipboard', owner: 'phoneTools', ...PRIVATE_READ },
  { module: '@features/phoneTools', symbol: 'XiaohongshuGetPageTool', name: 'xiaohongshu_get_page', owner: 'phoneTools', ...PRIVATE_READ },
  ...[
    ['XiaohongshuEnterPublishingTool', 'xiaohongshu_enter_publishing'], ['XiaohongshuOpenTextEntryTool', 'xiaohongshu_open_text_entry'],
    ['XiaohongshuStartTextNoteTool', 'xiaohongshu_start_text_note'], ['XiaohongshuSetCardTextTool', 'xiaohongshu_set_card_text'],
    ['XiaohongshuSetTitleTool', 'xiaohongshu_set_title'], ['XiaohongshuSetBodyTool', 'xiaohongshu_set_body'],
    ['XiaohongshuAddTopicTool', 'xiaohongshu_add_topic'], ['XiaohongshuSelectStyleTool', 'xiaohongshu_select_style'],
    ['XiaohongshuSetVisibilityTool', 'xiaohongshu_set_visibility'], ['XiaohongshuNextTool', 'xiaohongshu_next'],
    ['XiaohongshuGoBackTool', 'xiaohongshu_go_back'], ['XiaohongshuPreparePublishTool', 'xiaohongshu_prepare_publish'],
  ].map(([symbol, name]) => ({ module: '@features/phoneTools', symbol, name, owner: 'phoneTools', ...REVERSIBLE_ACTION })),
  { module: '@features/phoneTools', symbol: 'XiaohongshuPublishPreparedNoteTool', name: 'xiaohongshu_publish_prepared_note', owner: 'phoneTools', ...EXTERNAL_SIDE_EFFECT },
  { module: '@features/screenCapture', symbol: 'ReadScreenAccessibilityTool', name: 'read_screen_accessibility', owner: 'screenCapture', ...PRIVATE_READ },
  { module: '@features/screenCapture', symbol: 'ReadScreenOcrTool', name: 'read_screen_ocr', owner: 'screenCapture', ...PRIVATE_READ },
  { module: '@features/companion', symbol: 'CreateAIScheduleTool', name: 'create_ai_schedule', owner: 'companion', ...REVERSIBLE_ACTION },
  { module: '@features/companion', symbol: 'ListAISchedulesTool', name: 'list_ai_schedules', owner: 'companion', ...PRIVATE_READ },
  { module: '@features/companion', symbol: 'GetAIScheduleTool', name: 'get_ai_schedule', owner: 'companion', ...PRIVATE_READ },
  { module: '@features/companion', symbol: 'UpdateAIScheduleTool', name: 'update_ai_schedule', owner: 'companion', ...REVERSIBLE_WRITE },
  { module: '@features/companion', symbol: 'CancelAIScheduleTool', name: 'cancel_ai_schedule', owner: 'companion', ...SENSITIVE_ACTION },
  { module: '@features/chat', symbol: 'SearchChatSummariesTool', name: 'search_chat_summaries', owner: 'chat', ...PRIVATE_READ },
  { module: '@features/chat', symbol: 'SearchChatMessagesTool', name: 'search_chat_messages', owner: 'chat', ...PRIVATE_READ },
  { module: '@features/chat', symbol: 'ReadChatMessageContextTool', name: 'read_chat_message_context', owner: 'chat', ...PRIVATE_READ },
  { module: '@features/chat', symbol: 'GetSecondarySummaryTool', name: 'get_secondary_summary', owner: 'chat', ...PRIVATE_READ },
  { module: '@features/chat', symbol: 'EditSecondarySummaryTool', name: 'edit_secondary_summary', owner: 'chat', ...REVERSIBLE_WRITE },
  { module: '@features/chat', symbol: 'EditPrimarySummaryTool', name: 'edit_primary_summary', owner: 'chat', ...REVERSIBLE_WRITE },
  { module: '@features/chat', symbol: 'DeletePrimarySummaryTool', name: 'delete_primary_summary', owner: 'chat', ...REVERSIBLE_WRITE },
  { module: '@features/chat', symbol: 'SendVoiceMessageTool', name: 'send_voice_message', owner: 'chat', ...EXTERNAL_SIDE_EFFECT },
  { module: './ShareMomentTool', symbol: 'ShareMomentTool', name: 'share_moment', owner: 'moments', ...EXTERNAL_SIDE_EFFECT },
  { module: '@features/chat', symbol: 'SendImageTool', name: 'send_image', owner: 'chat', ...EXTERNAL_SIDE_EFFECT },
  { module: '@features/stickers', symbol: 'SearchStickersTool', name: 'search_stickers', owner: 'stickers', ...SAFE_READ },
  { module: '@features/stickers', symbol: 'ListStickerGroupsTool', name: 'list_sticker_groups', owner: 'stickers', ...SAFE_READ },
  { module: '@features/stickers', symbol: 'ListStickersInGroupTool', name: 'list_stickers_in_group', owner: 'stickers', ...SAFE_READ },
  { module: '@features/stickers', symbol: 'SelectStickerTool', name: 'select_sticker', owner: 'stickers', ...EXTERNAL_SIDE_EFFECT },
  { module: '@features/togetherListening', symbol: 'InviteListeningTogetherTool', name: 'invite_listening_together', owner: 'togetherListening', ...REVERSIBLE_ACTION },
  { module: '@features/togetherListening', symbol: 'RespondToListeningInvitationTool', name: 'respond_to_listening_invitation', owner: 'togetherListening', ...REVERSIBLE_ACTION },
  { module: '@features/togetherListening', symbol: 'LeaveListeningTogetherTool', name: 'leave_listening_together', owner: 'togetherListening', ...REVERSIBLE_ACTION },
];

function createLegacyTool(name) {
  return {
    name,
    definition: {
      name,
      description: `${name} definition`,
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => ({ success: true, message: `${name} completed` }),
  };
}

let nativeBuiltInReceivedContext;
function createAgentNativeBuiltInTool(name) {
  return {
    name,
    definition: {
      name,
      description: `${name} definition`,
      parameters: { type: 'object', properties: {} },
    },
    execute: async (_input, context) => {
      nativeBuiltInReceivedContext = context;
      return { status: 'success', data: null, modelContent: `${name} completed` };
    },
  };
}

const featureMocks = Object.fromEntries(
  [...new Set(builtInTools.map((tool) => tool.module))].map((module) => [module, {}])
);
featureMocks['@platform/ai'] = loadTypeScriptModule('src/platform/ai/moonshotEndpoint.ts', {});
featureMocks['@shared/aiTools'] = loadTypeScriptModule('src/shared/aiTools/ToolCompletionIntent.ts');
for (const tool of builtInTools) {
  featureMocks[tool.module][tool.symbol] = (
    tool.module === '@features/companion'
    || tool.module === '@features/webTools'
    || tool.module === '@features/media'
    || tool.module === '@features/stickers'
    || tool.module === '@features/memory'
    || tool.module === './ApplicationSettingsTools'
    || tool.module === './GroupManagementTools'
    || tool.module === './ShareMomentTool'
    || tool.symbol === 'SendVoiceMessageTool'
    || tool.symbol === 'SendImageTool'
    || tool.symbol === 'SearchChatSummariesTool'
    || tool.symbol === 'SearchChatMessagesTool'
    || tool.symbol === 'ReadChatMessageContextTool'
    || tool.symbol === 'GetSecondarySummaryTool'
    || tool.symbol === 'EditSecondarySummaryTool'
    || tool.symbol === 'EditPrimarySummaryTool'
    || tool.symbol === 'DeletePrimarySummaryTool'
  )
    ? createAgentNativeBuiltInTool(tool.name)
    : createLegacyTool(tool.name);
}
featureMocks['@features/memory'].releaseMemoryRecallRun = () => {};
featureMocks['@features/phoneTools'].getPhoneToolPackageById = loadTypeScriptModule(
  'src/features/phoneTools/toolPackages/ToolPackageCatalog.ts',
).getPhoneToolPackageById;
let momentPreparationCount = 0;
const momentSnapshotTool = {
  ...featureMocks['@features/moments'].AICreateMomentTool,
  definition: { ...featureMocks['@features/moments'].AICreateMomentTool.definition,
    parameters: { type: 'object', properties: { audience: { type: 'object', description: '本次候选 agent-candidate' } } } },
};
featureMocks['@features/moments/composition'] = { createMomentToolForRun: async () => { momentPreparationCount++; return momentSnapshotTool; } };
featureMocks['./ApplicationSettingsTools'] = { applicationSettingsTools: builtInTools.filter(tool => tool.module === './ApplicationSettingsTools')
  .map(entry => ({ tool: createAgentNativeBuiltInTool(entry.name), owner: entry.owner, hostOnly: entry.hostOnly, mutating: entry.mutating })) };
featureMocks['./GroupManagementTools'] = { groupManagementTools: builtInTools.filter(tool => tool.module === './GroupManagementTools')
  .map(entry => ({ tool: createAgentNativeBuiltInTool(entry.name), hostOnly: entry.hostOnly, readOnly: entry.readOnly })) };
const defaultToolPermissions = {};
const appToolPackages = {};
featureMocks['@features/prompting'] = { readPromptDefaults: async () => ({ toolPermissions: defaultToolPermissions, appToolPackages }) };
assert.ok(featureMocks['@features/stickers'].SearchStickersTool, 'Sticker 搜索工具 mock 必须存在');
assert.ok(featureMocks['@features/stickers'].SelectStickerTool, 'Sticker 选择工具 mock 必须存在');

const { createAgentToolRegistry, prepareAgentToolRegistry, getToolPackageRuntimeBindings } = loadTypeScriptModule(
  'src/host/composition/agent/createAgentToolRegistry.ts',
  {
    '@platform/agentRuntime': { AgentToolRegistry },
    './LegacyAgentToolAdapter': { LegacyAgentToolAdapter },
    ...featureMocks,
    '@features/assistants': {
      ...featureMocks['@features/assistants'],
      assistantToolPermissionRepository: { list: async () => [] },
    },
    '@features/stickers': featureMocks['@features/stickers'],
    '@features/phoneTools/neteaseComposition': { productionNetEaseChildTools: [] },
  }
);
const preparedMomentRegistry = await prepareAgentToolRegistry(() => legacyContext, {
  assistantId: 'assistant-1', allowedToolNames: ['aiCreateMoment'],
});
assert.deepEqual(preparedMomentRegistry.get('aiCreateMoment').descriptor.inputSchema, momentSnapshotTool.definition.parameters,
  '生产 Registry 必须使用本次运行的时刻候选参数快照');
assert.equal(momentPreparationCount, 1);
await prepareAgentToolRegistry(() => legacyContext, { assistantId: 'assistant-1', allowedToolNames: [] });
assert.equal(momentPreparationCount, 1, '未授权发布工具时不读取候选名单');
let productionLegacyContextCalls = 0;
const productionRegistry = createAgentToolRegistry({
  createLegacyContext: () => {
    productionLegacyContextCalls += 1;
    return legacyContext;
  },
});
const productionDescriptors = productionRegistry.list();
for (const name of ['search_chat_messages', 'read_chat_message_context', 'search_chat_summaries', 'get_secondary_summary', 'edit_secondary_summary', 'edit_primary_summary', 'delete_primary_summary']) {
  assert.equal(getToolPackageRuntimeBindings(productionRegistry).find(binding => binding.tool.descriptor.name === name).packageId, 'memory');
}
assert.deepEqual(
  productionDescriptors.map((descriptor) => descriptor.name).sort(),
  builtInTools.map((tool) => tool.name).sort(),
  '生产 Registry 必须注册完整且唯一的 Built-in Tool 集合'
);
assert.deepEqual(
  productionDescriptors.map((descriptor) => ({
    name: descriptor.name,
    owner: descriptor.owner,
    risk: descriptor.risk,
    idempotency: descriptor.idempotency,
  })).sort((left, right) => left.name.localeCompare(right.name)),
  builtInTools.map(({ name, owner, risk, idempotency }) => ({
    name,
    owner,
    risk,
    idempotency,
  })).sort((left, right) => left.name.localeCompare(right.name)),
  '生产工具必须保留显式且准确的 owner/risk/idempotency'
);
const nativeBuiltInResult = await productionRegistry.get('create_ai_schedule').execute(
  {},
  executionContext,
);
assert.equal(nativeBuiltInResult.status, 'success');
assert.equal(
  nativeBuiltInReceivedContext,
  executionContext,
  'Agent-native Built-in Tool 必须直接收到完整 AgentToolExecutionContext',
);
assert.equal(
  productionLegacyContextCalls,
  0,
  'Agent-native Built-in Tool 不得创建 Legacy ToolContext',
);
const {
  getAuthorizedToolDefinitionsForAI,
  getToolPermissionDescriptors,
  resolveAllowedToolNames,
} = loadTypeScriptModule(
  'src/host/composition/agent/createAgentToolRegistry.ts',
  {
    '@platform/agentRuntime': { AgentToolRegistry },
    './LegacyAgentToolAdapter': { LegacyAgentToolAdapter },
    ...featureMocks,
    '@features/assistants': {
      ...featureMocks['@features/assistants'],
      assistantToolPermissionRepository: { list: async () => [] },
    },
    '@features/phoneTools/neteaseComposition': { productionNetEaseChildTools: [] },
  },
);
const allToolNames = builtInTools.map((tool) => tool.name);

// 总开关、单项偏好与拆包/星标经过生产授权链验证，不能靠 UI 隐藏工具。
const appPackageRegistry = loadTypeScriptModule('src/host/composition/agent/createAgentToolRegistry.ts', {
  '@platform/agentRuntime': { AgentToolRegistry },
  './LegacyAgentToolAdapter': { LegacyAgentToolAdapter },
  ...featureMocks,
  '@features/assistants': { ...featureMocks['@features/assistants'], assistantToolPermissionRepository: { list: async () => [] } },
  '@features/phoneTools/neteaseComposition': { productionNetEaseChildTools:
    featureMocks['@features/phoneTools'].getPhoneToolPackageById('neteaseMusic').tools.map(({ toolName }) => createLegacyTool(toolName)) },
});
const { registerToolPackagesForHostRun: exposeAppPackages } = loadTypeScriptModule('src/host/composition/agent/ToolPackageExposure.ts');
const appPackages = ['xiaohongshu', 'neteaseMusic'].map(id => featureMocks['@features/phoneTools'].getPhoneToolPackageById(id));
const allAppNames = appPackages.flatMap(entry => entry.tools.map(tool => tool.toolName));
async function appPackageExposure(directToolNames = allAppNames) {
  const registry = appPackageRegistry.createAgentToolRegistry({ createLegacyContext: () => legacyContext });
  const allowedToolNames = appPackageRegistry.getRuntimeAllowedToolNamesForAI({
    enableTools: true, isHostAI: true, triggerSource: 'chat',
    allowedToolNames: await appPackageRegistry.resolveAllowedToolNames('host'),
  });
  const exposure = exposeAppPackages({ registry, allowedToolNames,
    bindings: appPackageRegistry.getToolPackageRuntimeBindings(registry),
    openPackageIds: appPackages.map(entry => entry.id), directToolNames,
  });
  return { registry, exposure, allowedToolNames };
}
let appState = await appPackageExposure();
assert.ok(allAppNames.every(name => !appState.allowedToolNames.includes(name)), '默认关闭时特批和已展开包都不得提供应用工具');
assert.doesNotMatch(appState.exposure.instructions().catalog, /xiaohongshu|netease_|小红书|网易云音乐包/u);
assert.ok(allAppNames.every(name => !appState.exposure.visibleToolNames().includes(name)));
assert.ok(!appState.registry.get('open_tool_package').descriptor.inputSchema.properties.package_id.enum.includes('xiaohongshu'));
appState = await appPackageExposure([]);
assert.doesNotMatch(appState.exposure.instructions().catalog, /xiaohongshu|netease_|小红书|网易云音乐包/u);
appToolPackages.xiaohongshu = true;
appState = await appPackageExposure();
assert.ok(appPackages[0].tools.every(({ toolName }) => appState.exposure.visibleToolNames().includes(toolName)), '开启后沿用单项授权与星标');
assert.ok(appPackages[1].tools.every(({ toolName }) => !appState.allowedToolNames.includes(toolName)), '各应用包开关互不影响');
appToolPackages.neteaseMusic = true;
appState = await appPackageExposure();
assert.ok(allAppNames.every(name => appState.exposure.visibleToolNames().includes(name)));
const nonHostNames = appPackageRegistry.getRuntimeAllowedToolNamesForAI({ enableTools: true, isHostAI: false,
  triggerSource: 'chat', allowedToolNames: appState.allowedToolNames });
assert.ok(allAppNames.every(name => !nonHostNames.includes(name)), '全局总开关开启仍只供主理 AI 使用');
defaultToolPermissions.xiaohongshu_add_topic = false;
appState = await appPackageExposure();
assert.ok(!appState.allowedToolNames.includes('xiaohongshu_add_topic'), '总开关开启不能越过单项关闭');
delete defaultToolPermissions.xiaohongshu_add_topic;
appToolPackages.xiaohongshu = false;
appState = await appPackageExposure();
assert.ok(appPackages[0].tools.every(({ toolName }) => !appState.exposure.visibleToolNames().includes(toolName)), '关闭后已展开与特批偏好不能恢复 schema');
assert.doesNotMatch(appState.exposure.instructions().catalog, /xiaohongshu|小红书/u);
appState = await appPackageExposure([]);
assert.doesNotMatch(appState.exposure.instructions().catalog, /xiaohongshu|小红书/u);
assert.match(appState.exposure.instructions().catalog, /netease_search_songs/u);
delete appToolPackages.xiaohongshu;
delete appToolPackages.neteaseMusic;

const availableNames = (config) => getAuthorizedToolDefinitionsForAI({
  enableTools: true,
  allowedToolNames: allToolNames,
  ...config,
}).map((definition) => definition.function.name);

const regularChatNames = availableNames({ triggerSource: 'chat' });
const callNames = availableNames({ triggerSource: 'call', memoryParticipation: 'read_write' });
for (const name of ['lookAtUser', 'web_search', 'recall_memory', 'searchProtocols']) {
  assert.ok(callNames.includes(name), `通话保留已授权的业务工具：${name}`);
}
assert.ok(!callNames.includes('requestVideoCall'), '通话中不能再次发起通话');
assert.deepEqual(availableNames({ triggerSource: 'call', allowedToolNames: [] }), [], '通话沿用原有授权边界');
const settingsNames = builtInTools.filter(entry => entry.module === './ApplicationSettingsTools').map(entry => entry.name);
for (const name of settingsNames) {
  const entry = builtInTools.find(entry => entry.name === name);
  assert.equal(regularChatNames.includes(name), !entry.hostOnly, `设置工具遵守当前主理身份：${name}`);
}
for (const triggerSource of ['call', 'ledger', 'internal_feature', 'raven_cat_wake']) {
  assert.ok(availableNames({ triggerSource }).includes('set_ai_name'), '设置独立提交，不依赖 Chat 消息 intent');
  assert.ok(!availableNames({ triggerSource }).includes('set_user_avatar'), '其他宿主同样遵守主理边界');
}
const settingsRegistry = createAgentToolRegistry({ createLegacyContext: () => legacyContext });
const settingsBindings = getToolPackageRuntimeBindings(settingsRegistry).filter(binding => binding.packageId === 'applicationSettings');
assert.deepEqual(settingsBindings.map(binding => binding.tool.descriptor.name).sort(), [...settingsNames].sort(), '不同 owner 的设置工具归入同一产品工具包');
const { registerToolPackagesForHostRun } = loadTypeScriptModule('src/host/composition/agent/ToolPackageExposure.ts', {});
const imageRegistry = createAgentToolRegistry({ createLegacyContext: () => legacyContext });
const imageExposure = registerToolPackagesForHostRun({ registry: imageRegistry,
  allowedToolNames: ['download_image', 'query_downloaded_images', 'view_image', 'send_image'],
  bindings: getToolPackageRuntimeBindings(imageRegistry), openPackageIds: [],
});
assert.deepEqual(imageExposure.visibleToolNames(), []);
await imageRegistry.get('open_tool_package').execute({ package_id: 'media' }, executionContext);
assert.deepEqual(new Set(imageExposure.visibleToolNames()), new Set(['download_image', 'query_downloaded_images', 'view_image', 'send_image']),
  '展开图片包后可直接下载、找回、查看与发送图片');
const cooldownRegistry = createAgentToolRegistry({ createLegacyContext: () => legacyContext });
const cooldownExposure = registerToolPackagesForHostRun({ registry: cooldownRegistry,
  allowedToolNames: ['release_host_cooldown'], bindings: getToolPackageRuntimeBindings(cooldownRegistry),
  openPackageIds: [], directToolNames: [],
});
assert.equal(cooldownExposure.visibleToolNames().length, 0, '冷静期工具沿用正常拆包');
assert.match(cooldownExposure.instructions().catalog, /release_host_cooldown/);
await cooldownRegistry.get('open_tool_package').execute({ package_id: 'assistants' }, executionContext);
assert.deepEqual(cooldownExposure.visibleToolNames(), ['release_host_cooldown'], '展开 AI 管理不能恢复其他主理工具');
assert.ok(!availableNames({ triggerSource: 'chat', isHostAI: true }).includes('release_host_cooldown'), '正常主理任期不暴露解除工具');
assert.ok(!regularChatNames.includes('release_host_cooldown'), '普通 AI 不暴露解除工具');
const settingsExposure = registerToolPackagesForHostRun({ registry: settingsRegistry,
  allowedToolNames: regularChatNames.filter(name => settingsNames.includes(name)), bindings: settingsBindings,
  openPackageIds: [], directToolNames: ['set_ai_name'],
});
assert.ok(settingsExposure.visibleToolNames().includes('set_ai_name'), '设置工具支持既有星标特批');
assert.ok(!settingsExposure.visibleToolNames().includes('set_user_avatar'), '拆包与特批不能扩大普通 AI 权限');
await settingsRegistry.get('open_tool_package').execute({ package_id: 'applicationSettings' }, executionContext);
assert.ok(settingsExposure.visibleToolNames().includes('set_chat_background'));
assert.ok(!settingsExposure.visibleToolNames().includes('set_user_avatar'));
assert.ok(!regularChatNames.includes('get_current_location'), '普通 AI 不得获得定位工具');
assert.ok(!regularChatNames.includes('read_clipboard'), '普通 AI 不得获得剪贴板工具');
for (const { toolName: name } of featureMocks['@features/phoneTools'].getPhoneToolPackageById('xiaohongshu').tools) {
  assert.ok(!regularChatNames.includes(name), '普通 AI 不得操作小红书');
  assert.ok(availableNames({ triggerSource: 'chat', isHostAI: true }).includes(name));
  assert.ok(!availableNames({ triggerSource: 'chat', isHostAI: true, allowedToolNames: [] }).includes(name), '主理身份不得绕过单项授权');
}
assert.ok(availableNames({ triggerSource: 'chat', isHostAI: true }).includes('read_clipboard'), '已授权主理 AI 可以读取剪贴板');
assert.ok(!availableNames({ triggerSource: 'chat', isHostAI: true, allowedToolNames: [] }).includes('read_clipboard'), '主理身份不能绕过剪贴板单项授权');
assert.ok(availableNames({ triggerSource: 'chat', isHostAI: true }).includes('get_current_location'), '已授权主理 AI 必须获得定位 schema');
assert.ok(!availableNames({ triggerSource: 'chat', isHostAI: true, allowedToolNames: [] }).includes('get_current_location'), '主理身份不能绕过定位调用授权');
assert.ok(regularChatNames.includes('search_stickers'), '普通单聊必须暴露 Sticker 搜索工具');
assert.ok(regularChatNames.includes('select_sticker'), '普通单聊必须暴露 Sticker 选择工具');
assert.ok(regularChatNames.includes('send_voice_message'), '普通单聊必须暴露语音消息工具');
assert.ok(regularChatNames.includes('send_image'), '普通单聊必须暴露图片消息工具');
const autonomousNames = availableNames({ triggerSource: 'raven_cat_wake', capabilities: ['raven_cat.autonomous'] });
assert.ok(autonomousNames.includes('send_voice_message'), '自主执行已接入同事务媒体存档，必须使用正常授权的语音工具');
assert.ok(autonomousNames.includes('select_sticker'), '自主执行必须使用正常授权的贴纸工具');
assert.ok(autonomousNames.includes('send_image'), '自主执行必须使用正常授权的图片消息工具');
const groupNames=availableNames({triggerSource:'group_chat',memoryParticipation:'read_write'});
assert.ok(groupNames.includes('send_image'), '群聊必须提供已授权的图片消息工具');
assert.ok(!availableNames({ triggerSource: 'chat', allowedToolNames: [] }).includes('send_image'), '图片发送不能绕过工具授权');
for(const name of ['search_stickers','select_sticker','send_voice_message','search_chat_messages','read_chat_message_context','search_chat_summaries','get_secondary_summary','edit_secondary_summary','edit_primary_summary','delete_primary_summary','download_image','view_image','set_ai_avatar','add_own_sticker','maintain_own_sticker','recall_memory','update_memory','forget_memory']) {
  assert.ok(groupNames.includes(name),`群聊应提供已授权工具：${name}`);
}
assert.ok(!groupNames.includes('requestVideoCall'),'群聊不能发起视频通话');
assert.ok(!groupNames.includes('get_current_location'),'群聊不绕过主理身份');
assert.ok(availableNames({triggerSource:'group_chat',isHostAI:true,memoryParticipation:'read_write'}).includes('get_current_location'));
assert.deepEqual(availableNames({triggerSource:'group_chat',allowedToolNames:[]}),[],'群聊不绕过原授权');
for (const triggerSource of ['call', 'ledger', 'internal_feature', 'raven_cat_wake']) {
  const names = availableNames({ triggerSource });
  assert.ok(!names.includes('search_stickers'), `${triggerSource} 不得暴露 Sticker 搜索工具`);
  assert.ok(!names.includes('select_sticker'), `${triggerSource} 不得暴露 Sticker 选择工具`);
  assert.ok(!names.includes('send_voice_message'), `${triggerSource} 不得暴露语音消息工具`);
  assert.ok(!names.includes('send_image'), `${triggerSource} 不得暴露图片消息工具`);
}
for (const forbiddenName of [
  'blockAIAssistant',
  'unblockAIAssistant',
  'soft_lock_app',
  'release_soft_lock',
  'search_installed_apps',
  'open_app',
  'get_foreground_app',
  'read_screen_accessibility',
  'read_screen_ocr',
  'create_ai_schedule',
  'lookAtUser',
  'recall_memory',
  'update_memory',
  'forget_memory',
]) {
  assert.ok(!regularChatNames.includes(forbiddenName), `普通 Chat 泄漏受限工具：${forbiddenName}`);
}
assert.deepEqual(
  availableNames({ triggerSource: 'call', capabilities: ['call.reply'] })
    .filter((name) => name === 'lookAtUser'),
  ['lookAtUser'],
  'Call 场景必须保留 lookAtUser'
);
assert.deepEqual(
  availableNames({ triggerSource: 'chat', capabilities: ['call.reply'] })
    .filter((name) => name === 'lookAtUser'),
  ['lookAtUser'],
  'Call capability 在非 call triggerSource 下也必须暴露 lookAtUser',
);
assert.deepEqual(
  availableNames({
    triggerSource: 'chat',
    memoryParticipation: 'read_write',
  }).filter((name) => name === 'recall_memory' || name === 'update_memory' || name === 'forget_memory'),
  ['recall_memory', 'update_memory', 'forget_memory'],
  'Memory 工具只能在 read_write 时暴露'
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'chat',
    allowedToolNames: ['blockAIAssistant'],
  }).map((definition) => definition.function.name),
  ['blockAIAssistant'],
  'Host-only 工具必须仅向 Host 暴露且遵守 allowlist'
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    triggerSource: 'chat',
    allowedToolNames: ['blockAIAssistant'],
  }),
  [],
  '普通 AI 不得获得 Host-only 工具'
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'chat',
    allowedToolNames: ['soft_lock_app'],
  }).map((definition) => definition.function.name),
  ['soft_lock_app'],
  '当前主理 AI 必须能看到 soft_lock_app schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    triggerSource: 'chat',
    allowedToolNames: ['soft_lock_app'],
  }),
  [],
  '普通 AI 即使 allowlist 包含 soft_lock_app 也不得看到 schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'chat',
    allowedToolNames: ['open_app'],
  }).map((definition) => definition.function.name),
  ['open_app'],
  '当前主理 AI 必须能看到 open_app schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    triggerSource: 'chat',
    allowedToolNames: ['open_app'],
  }),
  [],
  '普通 AI 即使 allowlist 包含 open_app 也不得看到 schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'chat',
    allowedToolNames: ['get_foreground_app'],
  }).map((definition) => definition.function.name),
  ['get_foreground_app'],
  '当前主理 AI 必须能看到 get_foreground_app schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    triggerSource: 'chat',
    allowedToolNames: ['get_foreground_app'],
  }),
  [],
  '普通 AI 即使 allowlist 包含 get_foreground_app 也不得看到 schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'chat',
    allowedToolNames: ['read_screen_accessibility'],
  }).map((definition) => definition.function.name),
  ['read_screen_accessibility'],
  '当前主理 AI 必须能看到 read_screen_accessibility schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    triggerSource: 'chat',
    allowedToolNames: ['read_screen_accessibility'],
  }),
  [],
  '普通 AI 即使 allowlist 包含 read_screen_accessibility 也不得看到 schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'chat',
    allowedToolNames: ['read_screen_ocr'],
  }).map((definition) => definition.function.name),
  ['read_screen_ocr'],
  '当前主理 AI 必须能看到 read_screen_ocr schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    triggerSource: 'chat',
    allowedToolNames: ['read_screen_ocr'],
  }),
  [],
  '普通 AI 即使 allowlist 包含 read_screen_ocr 也不得看到 schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'chat',
    allowedToolNames: ['create_ai_schedule'],
  }).map((definition) => definition.function.name),
  ['create_ai_schedule'],
  '当前主理 AI 的普通聊天任务必须能看到 create_ai_schedule schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    triggerSource: 'chat',
    allowedToolNames: ['create_ai_schedule'],
  }),
  [],
  '普通 AI 即使 allowlist 包含 create_ai_schedule 也不得看到 schema',
);
assert.deepEqual(
  getAuthorizedToolDefinitionsForAI({
    enableTools: true,
    isHostAI: true,
    triggerSource: 'raven_cat_wake',
    allowedToolNames: ['getProtocols'],
  }).map((definition) => definition.function.name),
  ['getProtocols'],
  'autonomous Self Wake 必须能通过普通 Registry 与 allowlist 获得正常 Host Tool schema',
);
const descriptors = getToolPermissionDescriptors();
assert.deepEqual(
  descriptors.map(({ name, owner, defaultEnabled, callOnly, memoryParticipation }) => ({
    name,
    owner,
    defaultEnabled,
    callOnly,
    memoryParticipation,
  })).sort((left, right) => left.name.localeCompare(right.name)),
  builtInTools
    .map(({ name, owner }) => ({
    name,
    owner,
    defaultEnabled: !['kimi_web_search', 'kimi_web_fetch', 'kimi_mew'].includes(name),
    callOnly: name === 'lookAtUser',
    memoryParticipation: ['remember_memory', 'recall_memory', 'update_memory', 'forget_memory', 'convert_exited_group_history_to_memory'].includes(name)
      ? 'read_write'
      : 'none',
    })).sort((left, right) => left.name.localeCompare(right.name)),
  '提示词中心目录包含全部内置工具，主理属性由元数据标识',
);
assert.deepEqual(
  (await resolveAllowedToolNames('assistant-1'))
    .filter((name) => (
      name === 'blockAIAssistant'
      || name === 'unblockAIAssistant'
      || name === 'soft_lock_app'
      || name === 'release_soft_lock'
      || name === 'search_installed_apps'
      || name === 'open_app'
      || name === 'get_foreground_app'
      || name === 'read_screen_accessibility'
      || name === 'read_screen_ocr'
      || name === 'create_ai_schedule'
    )).sort(),
  [
    'blockAIAssistant',
    'create_ai_schedule',
    'get_foreground_app',
    'open_app',
    'read_screen_accessibility',
    'read_screen_ocr',
    'release_soft_lock',
    'search_installed_apps',
    'soft_lock_app',
    'unblockAIAssistant',
  ],
  'Host-only 工具必须作为主理身份内建能力进入运行时 allowlist',
);

const { resolveAllowedToolNames: resolveAllowedToolNamesWithOverrides } = loadTypeScriptModule(
  'src/host/composition/agent/createAgentToolRegistry.ts',
  {
    '@platform/agentRuntime': { AgentToolRegistry },
    './LegacyAgentToolAdapter': { LegacyAgentToolAdapter },
    ...featureMocks,
    '@features/assistants': {
      ...featureMocks['@features/assistants'],
      assistantToolPermissionRepository: {
        list: async () => [
          { toolName: 'search_protocols', enabled: false },
          { toolName: 'blockAIAssistant', enabled: false },
          { toolName: 'unblockAIAssistant', enabled: false },
          { toolName: 'soft_lock_app', enabled: false },
          { toolName: 'release_soft_lock', enabled: false },
          { toolName: 'search_installed_apps', enabled: false },
          { toolName: 'open_app', enabled: false },
          { toolName: 'get_foreground_app', enabled: false },
          { toolName: 'get_current_location', enabled: false },
          { toolName: 'read_clipboard', enabled: false },
          { toolName: 'read_screen_accessibility', enabled: false },
          { toolName: 'read_screen_ocr', enabled: false },
          { toolName: 'create_ai_schedule', enabled: false },
          { toolName: 'invite_listening_together', enabled: false },
        ],
      },
    },
    '@features/phoneTools/neteaseComposition': { productionNetEaseChildTools: [] },
  },
);
defaultToolPermissions.recall_memory = false;
defaultToolPermissions.open_app = false;
const defaultAllowedNames = await resolveAllowedToolNames('assistant-1');
assert.ok(!defaultAllowedNames.includes('recall_memory'), '普通工具服从提示词默认权限');
assert.ok(!defaultAllowedNames.includes('open_app'), '手机工具服从共用的提示词默认权限');
delete defaultToolPermissions.recall_memory;
delete defaultToolPermissions.open_app;
const overriddenAllowedNames = await resolveAllowedToolNamesWithOverrides('assistant-1');
assert.ok(!overriddenAllowedNames.includes('get_current_location'), '定位调用开关沿用共用的 AI 单项授权');
assert.ok(!overriddenAllowedNames.includes('read_clipboard'), '剪贴板调用开关沿用共用的 AI 单项授权');
assert.ok(!overriddenAllowedNames.includes('search_protocols'), '普通工具必须继续服从 per-assistant override');
assert.ok(!overriddenAllowedNames.includes('blockAIAssistant'), '单项权限必须可以关闭 blockAIAssistant');
assert.ok(!overriddenAllowedNames.includes('unblockAIAssistant'), '单项权限必须可以关闭 unblockAIAssistant');
for (const name of ['soft_lock_app', 'release_soft_lock', 'search_installed_apps', 'open_app', 'get_foreground_app', 'read_screen_accessibility', 'read_screen_ocr']) {
  assert.ok(!overriddenAllowedNames.includes(name), '手机工具共用 AI 的单项调用权限');
}
assert.ok(!overriddenAllowedNames.includes('create_ai_schedule'), '单项权限必须可以关闭 create_ai_schedule');
assert.ok(
  !overriddenAllowedNames.includes('invite_listening_together'),
  'Together Listening 动态工具必须服从 per-assistant persistent override',
);
assert.deepEqual(
  availableNames({ triggerSource: 'call' }).filter((name) => name === 'lookAtUser'),
  ['lookAtUser'],
  'Call triggerSource 作为既有真实消费者也必须暴露 lookAtUser',
);

let currentHostAiId = 'host-ai';
let nowEpochMs = 1_000;
let authorityNowEpochMs = 5_000;
let activationCalls = [];
let activationSignals = [];
let activationResult;
let beforeAuthorityAction = null;
let protectedPackagesForSoftLock = [];
class ProtectedAppsPolicyError extends Error {
  constructor(message) {
    super(message);
    this.reason = 'protected_app';
  }
}
const nativeSynchronized = {
  active: [],
  start: { status: 'started', reason: null },
  reconcile: { status: 'ok', appliedCount: 1 },
  stop: null,
};
const blockingRuntimeState = {
  serviceRunning: true,
  runtimeAttached: true,
  observerConnected: true,
  currentWindow: {
    packageName: 'com.example.app',
    windowId: 7,
    title: 'Example',
    detectionReliable: true,
    checkedAtEpochMs: 5_000,
    source: 'accessibility',
  },
  projectedLocks: [{
    id: 'lock-1',
    targetPackage: 'com.example.app',
    expiresAtEpochMs: 65_000,
  }],
  matchingLockId: 'lock-1',
  targetMatched: true,
  shouldBlock: true,
  attached: true,
  attachedLockId: 'lock-1',
  overlayStatus: 'attached',
  diagnostics: {
    attachedAtEpochMs: 5_000,
    lastReconcileAtEpochMs: 5_000,
    lastWindowEventAtEpochMs: 5_000,
    lastConnectionEventAtEpochMs: 5_000,
    lastFailure: null,
  },
};
const softLockTool = loadTypeScriptModule(
  'src/features/deviceControl/aiTools/SoftLockAppTool.ts',
  {
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '@features/assistants': {
      runAsCurrentHostAuthority: async (actorAiId, action) => {
        if (actorAiId !== currentHostAiId) {
          return { status: 'not_current_host' };
        }
        beforeAuthorityAction?.();
        nowEpochMs = authorityNowEpochMs;
        return { status: 'authorized', value: await action() };
      },
    },
    '@features/phoneTools': {
      loadCurrentProtectedPackages: async () => protectedPackagesForSoftLock,
      assertProtectedAppCapabilityAllowed: (packageName, protectedPackages) => {
        if (protectedPackages.includes(packageName)) {
          throw new ProtectedAppsPolicyError(
            '该应用被用户设置为受保护应用，AI 无权对其执行此操作。',
          );
        }
      },
      ProtectedAppsPolicyError,
    },
    '../application/DeviceControl': {
      activateAiSoftLock: async (input, signal) => {
        activationCalls.push(input);
        activationSignals.push(signal);
        return activationResult;
      },
    },
  },
);
const { matchesAgentToolInputSchema } = loadTypeScriptModule(
  'src/shared/aiTools/AgentToolInputSchema.ts', agentToolSchemaDependencies);

assert.equal(softLockTool.definition.name, 'soft_lock_app');
assert.deepEqual(
  softLockTool.definition.parameters.required,
  ['target_package', 'duration_seconds'],
  'package 与 duration 必须同时出现在正式 schema required 中',
);
assert.equal(softLockTool.definition.parameters.properties.target_package.type, 'string');
assert.equal(softLockTool.definition.parameters.properties.duration_seconds.type, 'integer');
assert.equal(softLockTool.definition.parameters.properties.duration_seconds.minimum, 1);
assert.equal(
  Object.hasOwn(softLockTool.definition.parameters.properties.duration_seconds, 'maximum'),
  false,
  '当前产品不能给 duration_seconds 设置最大 TTL',
);
assert.equal(softLockTool.definition.parameters.additionalProperties, false);
assert.equal(matchesAgentToolInputSchema({
  target_package: 'com.example.app',
  duration_seconds: 60,
  reason: '专注工作',
}, softLockTool.definition.parameters), true);
for (const schemaInvalidArgs of [
  { duration_seconds: 60 },
  { target_package: 'com.example.app' },
  { target_package: 'com.example.app', duration_seconds: 0 },
  { target_package: 'com.example.app', duration_seconds: 1.5 },
  {
    target_package: 'com.example.app',
    duration_seconds: 60,
    sourceAiId: 'model-controlled-ai',
  },
]) {
  assert.equal(
    matchesAgentToolInputSchema(schemaInvalidArgs, softLockTool.definition.parameters),
    false,
    `Agent Runtime schema 必须拒绝非法 soft_lock_app 参数：${JSON.stringify(schemaInvalidArgs)}`,
  );
}

const hostAbortController = new AbortController();
const hostContext = {
  getAIId: () => 'host-ai',
  abortSignal: hostAbortController.signal,
};
for (const invalidArgs of [
  { duration_seconds: 60 },
  { target_package: '', duration_seconds: 60 },
  { target_package: 'com.example app', duration_seconds: 60 },
  { target_package: 'com.example.app' },
  { target_package: 'com.example.app', duration_seconds: 0 },
  { target_package: 'com.example.app', duration_seconds: 1.5 },
  { target_package: 'com.example.app', duration_seconds: Number.POSITIVE_INFINITY },
]) {
  assert.equal(
    (await softLockTool.execute(invalidArgs, hostContext)).success,
    false,
    `明显非法的模型参数必须在 Tool 边界拒绝：${JSON.stringify(invalidArgs)}`,
  );
}
assert.equal(
  (await softLockTool.execute(
    { target_package: 'com.example.app', duration_seconds: 60 },
    { getAIId: () => undefined },
  )).success,
  false,
  '缺失可信 actor 时不得进入 authority action',
);

protectedPackagesForSoftLock = ['com.example.protected'];
activationCalls = [];
const protectedTarget = await softLockTool.execute({
  target_package: 'com.example.protected',
  duration_seconds: 60,
}, hostContext);
assert.equal(protectedTarget.success, false);
assert.equal(protectedTarget.errorCode, 'protected_app');
assert.match(protectedTarget.error, /^protected_app:/u);
assert.deepEqual(
  activationCalls,
  [],
  '受保护目标不得创建业务锁或进入 commit 后 native side effect 链路',
);
protectedPackagesForSoftLock = [];

const originalDateNow = Date.now;
try {
  Date.now = () => nowEpochMs;
  activationResult = {
    status: 'activated',
    lock: {
      id: 'lock-1',
      targetPackage: 'com.example.app',
      expiresAtEpochMs: 65_000,
    },
    native: nativeSynchronized,
    runtimeState: blockingRuntimeState,
    execution: { state: 'blocking_now' },
  };
  activationCalls = [];
  activationSignals = [];
  const activated = await softLockTool.execute({
    target_package: 'com.example.app',
    duration_seconds: 60,
    reason: '  专注工作  ',
    sourceAiId: 'model-controlled-ai',
  }, hostContext);
  assert.equal(activated.success, true);
  assert.deepEqual(activationCalls, [{
    targetPackage: 'com.example.app',
    sourceAiId: 'host-ai',
    reason: '专注工作',
    expiresAtEpochMs: 65_000,
  }], 'sourceAiId 必须来自 context，expiry 必须在 authority callback 内按秒转换');
  assert.deepEqual(activationSignals, [hostAbortController.signal]);
  assert.deepEqual(activated.data, {
    businessStatus: 'activated',
    executionState: 'blocking_now',
    lockId: 'lock-1',
    targetPackage: 'com.example.app',
    expiresAtEpochMs: 65_000,
    native: {
      synchronization: nativeSynchronized,
      runtimeState: blockingRuntimeState,
    },
  });
  assert.match(activated.message, /businessStatus: activated/u);
  assert.match(activated.message, /executionState: blocking_now/u);
  assert.match(activated.message, /阻断层已生效/u);

  currentHostAiId = 'new-host-ai';
  activationCalls = [];
  const staleHost = await softLockTool.execute({
    target_package: 'com.example.app',
    duration_seconds: 60,
  }, hostContext);
  assert.equal(staleHost.success, false);
  assert.match(staleHost.error, /^not_current_host:/u);
  assert.equal(activationCalls.length, 0, 'stale old-host 不得调用 application command');

  currentHostAiId = 'host-ai';
  const abortedSoftLockController = new AbortController();
  beforeAuthorityAction = () => abortedSoftLockController.abort(new Error('soft lock superseded'));
  activationCalls = [];
  await assert.rejects(
    () => softLockTool.execute({
      target_package: 'com.example.app',
      duration_seconds: 60,
    }, {
      ...hostContext,
      abortSignal: abortedSoftLockController.signal,
    }),
    /soft lock superseded/u,
    '主理 authority 排队期间 abort 后不得进入 Soft Lock application command',
  );
  assert.deepEqual(activationCalls, []);
  beforeAuthorityAction = null;
  activationResult = {
    status: 'already_active',
    lock: {
      id: 'lock-existing',
      targetPackage: 'com.example.app',
      expiresAtEpochMs: 120_000,
    },
    native: nativeSynchronized,
    runtimeState: {
      ...blockingRuntimeState,
      projectedLocks: [{
        id: 'lock-existing',
        targetPackage: 'com.example.app',
        expiresAtEpochMs: 120_000,
      }],
      matchingLockId: 'lock-existing',
      attachedLockId: 'lock-existing',
    },
    execution: { state: 'blocking_now' },
  };
  const alreadyActive = await softLockTool.execute({
    target_package: 'com.example.app',
    duration_seconds: 60,
  }, hostContext);
  assert.equal(alreadyActive.success, true);
  assert.equal(alreadyActive.data.businessStatus, 'already_active');
  assert.equal(alreadyActive.data.executionState, 'blocking_now');
  assert.equal(alreadyActive.data.lockId, 'lock-existing');

  activationResult = {
    status: 'already_active',
    lock: {
      id: 'lock-existing',
      targetPackage: 'com.example.app',
      expiresAtEpochMs: 120_000,
    },
    native: nativeSynchronized,
    runtimeState: {
      ...blockingRuntimeState,
      currentWindow: {
        ...blockingRuntimeState.currentWindow,
        packageName: 'com.example.other',
      },
      matchingLockId: null,
      targetMatched: false,
      shouldBlock: false,
      attached: false,
      attachedLockId: null,
      overlayStatus: 'detached',
    },
    execution: { state: 'waiting_for_target' },
  };
  const waiting = await softLockTool.execute({
    target_package: 'com.example.app',
    duration_seconds: 60,
  }, hostContext);
  assert.equal(waiting.success, true);
  assert.equal(waiting.data.businessStatus, 'already_active');
  assert.equal(waiting.data.executionState, 'waiting_for_target');
  assert.equal(Object.hasOwn(waiting.data, 'executionIssue'), false);
  assert.match(waiting.message, /executionState: waiting_for_target/u);
  assert.match(waiting.message, /目标 App 当前不在前台/u);
  assert.doesNotMatch(waiting.message, /阻断层已生效/u);

  const backgroundRestricted = {
    active: [{ id: 'lock-2' }],
    start: { status: 'background_start_restricted', reason: 'Android policy' },
    reconcile: null,
    stop: null,
  };
  activationResult = {
    status: 'activated',
    lock: {
      id: 'lock-2',
      targetPackage: 'com.example.other',
      expiresAtEpochMs: 125_000,
    },
    native: backgroundRestricted,
    runtimeState: {
      ...blockingRuntimeState,
      serviceRunning: false,
      runtimeAttached: false,
      observerConnected: false,
      currentWindow: null,
      projectedLocks: [],
      matchingLockId: null,
      targetMatched: false,
      shouldBlock: false,
      attached: false,
      attachedLockId: null,
      overlayStatus: 'detached',
    },
    execution: {
      state: 'activated_but_not_executing',
      issue: 'background_start_restricted',
    },
  };
  const degraded = await softLockTool.execute({
    target_package: 'com.example.other',
    duration_seconds: 120,
  }, hostContext);
  assert.equal(degraded.success, true, 'native 启动受限不能回滚已提交的 business success');
  assert.equal(degraded.data.businessStatus, 'activated');
  assert.equal(degraded.data.executionState, 'activated_but_not_executing');
  assert.equal(degraded.data.executionIssue, 'background_start_restricted');
  assert.equal(
    degraded.data.native.synchronization.start.status,
    'background_start_restricted',
  );
  assert.match(
    degraded.message,
    /Android 不允许从当前后台状态首次启动 Device Control runtime/u,
    '模型可见的 Tool message 必须优先表达稳定 execution truth',
  );
  assert.match(degraded.message, /executionIssue: background_start_restricted/u);
  assert.doesNotMatch(degraded.message, /阻断层已生效/u);

  activationResult = { status: 'rejected', reason: 'invalid_expiry' };
  const rejected = await softLockTool.execute({
    target_package: 'com.example.app',
    duration_seconds: Number.MAX_VALUE,
  }, hostContext);
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /^rejected:/u);
} finally {
  Date.now = originalDateNow;
}

let releaseCalls = [];
let releaseSignals = [];
let releaseResult = {
  status: 'released',
  lock: { id: 'lock-release', targetPackage: 'com.example.app' },
  native: nativeSynchronized,
};
const releaseTool = loadTypeScriptModule(
  'src/features/deviceControl/aiTools/ReleaseSoftLockTool.ts',
  {
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '@features/assistants': {
      runAsCurrentHostAuthority: async (actorAiId, action) => {
        if (actorAiId !== currentHostAiId) {
          return { status: 'not_current_host' };
        }
        beforeAuthorityAction?.();
        return { status: 'authorized', value: await action() };
      },
    },
    '../application/DeviceControl': {
      releaseAiSoftLock: async (input, signal) => {
        releaseCalls.push(input);
        releaseSignals.push(signal);
        return releaseResult;
      },
    },
  },
);
assert.equal(releaseTool.definition.name, 'release_soft_lock');
assert.deepEqual(releaseTool.definition.parameters.required, ['target_package']);
assert.equal(releaseTool.definition.parameters.additionalProperties, false);
assert.equal(matchesAgentToolInputSchema(
  { target_package: 'com.example.app' },
  releaseTool.definition.parameters,
), true);
assert.equal(matchesAgentToolInputSchema(
  { target_package: 'com.example app' },
  releaseTool.definition.parameters,
), false);

currentHostAiId = 'host-ai';
releaseCalls = [];
releaseSignals = [];
const releasedByHost = await releaseTool.execute(
  { target_package: 'com.example.app' },
  hostContext,
);
assert.equal(releasedByHost.success, true);
assert.deepEqual(releaseCalls, [{
  targetPackage: 'com.example.app',
  sourceAiId: 'host-ai',
}], 'release actor 必须来自可信 context，模型只能指定 exact target package');
assert.deepEqual(releaseSignals, [hostAbortController.signal]);
assert.equal(releasedByHost.data.businessStatus, 'released');
assert.equal(releasedByHost.data.lockId, 'lock-release');

currentHostAiId = 'new-host-ai';
releaseCalls = [];
const staleReleaseHost = await releaseTool.execute(
  { target_package: 'com.example.app' },
  hostContext,
);
assert.equal(staleReleaseHost.success, false);
assert.match(staleReleaseHost.error, /^not_current_host:/u);
assert.deepEqual(releaseCalls, [], '旧主理 run 不得进入 release application command');

currentHostAiId = 'host-ai';
const abortedReleaseController = new AbortController();
beforeAuthorityAction = () => abortedReleaseController.abort(new Error('release cancelled'));
releaseCalls = [];
await assert.rejects(
  () => releaseTool.execute(
    { target_package: 'com.example.app' },
    { ...hostContext, abortSignal: abortedReleaseController.signal },
  ),
  /release cancelled/u,
);
assert.deepEqual(releaseCalls, [], 'abort 后不得进入 release application command');
beforeAuthorityAction = null;
releaseResult = { status: 'not_found', native: nativeSynchronized };
const missingOwnedLock = await releaseTool.execute(
  { target_package: 'com.example.app' },
  hostContext,
);
assert.equal(missingOwnedLock.success, true);
assert.equal(missingOwnedLock.data.businessStatus, 'not_found');

let installedAppsQueryError = null;
const installedApps = [
  { label: 'Tavo', packageName: 'com.tavo.app', iconDataUri: null, isSystemApp: false },
  { label: '微信', packageName: 'com.tencent.mm', iconDataUri: 'data:image/png;base64,large', isSystemApp: false },
  { label: '微信读书', packageName: 'com.tencent.weread', iconDataUri: null, isSystemApp: false },
  { label: '企业微信', packageName: 'com.tencent.wework', iconDataUri: null, isSystemApp: false },
  { label: 'App Center', packageName: 'com.example.center', iconDataUri: null, isSystemApp: false },
  { label: 'Example', packageName: 'com.example.app', iconDataUri: null, isSystemApp: false },
  { label: 'Example Beta', packageName: 'com.example.beta', iconDataUri: null, isSystemApp: false },
  { label: 'Package Match', packageName: 'org.sample.com.example.tail', iconDataUri: null, isSystemApp: true },
];
let installedAppsResult = installedApps;
let installedAppsQueryCount = 0;
class DeviceObserverInstalledAppsQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeviceObserverInstalledAppsQueryError';
  }
}
const installedAppsTool = loadTypeScriptModule(
  'src/features/deviceControl/aiTools/SearchInstalledAppsTool.ts',
  {
    '@shared/runtime/abortSignal': abortSignalRuntime,
    '@features/assistants': {
      runAsCurrentHostAuthority: async (actorAiId, action) => (
        actorAiId === currentHostAiId
          ? { status: 'authorized', value: await action() }
          : { status: 'not_current_host' }
      ),
    },
    '../application/DeviceObserverFacade': {
      getInstalledLaunchableApps: async () => {
        installedAppsQueryCount += 1;
        if (installedAppsQueryError) throw installedAppsQueryError;
        return installedAppsResult;
      },
    },
    '../application/DeviceObserverPort': { DeviceObserverInstalledAppsQueryError },
  },
);
assert.equal(installedAppsTool.definition.name, 'search_installed_apps');
assert.deepEqual(installedAppsTool.definition.parameters.required, ['query']);
assert.equal(installedAppsTool.definition.parameters.additionalProperties, false);
assert.equal(matchesAgentToolInputSchema(
  { query: '微信' },
  installedAppsTool.definition.parameters,
), true);
assert.equal(matchesAgentToolInputSchema(
  { query: '   ' },
  installedAppsTool.definition.parameters,
), false);

const labelMatches = installedAppsTool.searchInstalledApps(installedApps, '微信');
assert.deepEqual(
  labelMatches.map(({ label }) => label),
  ['微信', '微信读书', '企业微信'],
  '本地搜索必须按 exact → prefix → contains 返回最相关候选',
);
const packageMatches = installedAppsTool.searchInstalledApps(installedApps, 'com.example');
assert.equal(packageMatches.length, 4);
assert.deepEqual(
  packageMatches.map(({ packageName }) => packageName),
  ['com.example.app', 'com.example.beta', 'com.example.center', 'org.sample.com.example.tail'],
  'package prefix 必须排在 contains 前且排序稳定',
);
assert.ok(
  packageMatches.every((candidate) => !Object.hasOwn(candidate, 'iconDataUri')),
  '工具候选不得把图标 base64 送入模型',
);
assert.equal(
  installedAppsTool.searchInstalledApps(installedApps, 'com').length,
  5,
  '本地搜索只返回少量最相关候选',
);

const installedSearch = await installedAppsTool.execute({ query: '  微信  ' }, hostContext);
assert.equal(installedSearch.success, true);
assert.equal(installedSearch.data.query, '微信');
assert.equal(installedSearch.data.candidates.length, 3);
assert.equal(installedAppsQueryCount, 1, '当前主理 AI 应正常读取 Device Observer');

currentHostAiId = 'new-host-ai';
installedAppsQueryCount = 0;
const staleInstalledAppsSearch = await installedAppsTool.execute({ query: '微信' }, hostContext);
assert.equal(staleInstalledAppsSearch.success, false);
assert.match(staleInstalledAppsSearch.error, /^not_current_host:/u);
assert.equal(
  installedAppsQueryCount,
  0,
  'old host 的 stale run 不得触发 Device Observer installed-app query',
);
currentHostAiId = 'host-ai';

const installedAppsAdapter = new LegacyAgentToolAdapter(
  installedAppsTool.SearchInstalledAppsTool,
  { owner: 'deviceControl', risk: 'private_read', idempotency: 'idempotent' },
  (context) => ({ ...hostContext, abortSignal: context.abortSignal }),
);
const installedObservation = await installedAppsAdapter.execute(
  { query: 'tavo' },
  executionContext,
);
assert.equal(installedObservation.status, 'success');
assert.match(
  installedObservation.modelContent,
  /1\. Tavo — com\.tavo\.app/u,
  'Agent Runtime observation 必须把大小写不敏感命中的 label 与 exact packageName 交给模型',
);
assert.doesNotMatch(
  installedObservation.modelContent,
  /iconDataUri|base64/u,
  '模型 observation 不得携带图标数据',
);
installedAppsQueryError = new DeviceObserverInstalledAppsQueryError('native unavailable');
const installedSearchFailed = await installedAppsTool.execute({ query: '微信' }, hostContext);
assert.equal(installedSearchFailed.success, false);
assert.match(installedSearchFailed.error, /^installed_apps_query_failed:/u);

installedAppsQueryError = null;
installedAppsResult = [{
  get label() {
    throw new Error('invalid installed app label');
  },
  packageName: 'com.example.invalid',
  iconDataUri: null,
  isSystemApp: false,
}];
await assert.rejects(
  () => installedAppsTool.execute({ query: 'example' }, hostContext),
  /invalid installed app label/u,
  '搜索/排序/结果构造中的编程错误不得被吞成 installed_apps_query_failed',
);
installedAppsResult = installedApps;

class InstalledAppsQueryError extends Error {}
let adapterInstalledAppsError = new InstalledAppsQueryError('native unavailable');
const installedAppsAdapterModule = loadTypeScriptModule(
  'src/features/deviceControl/infrastructure/DeviceObserverAdapter.ts',
  {
    '@platform/device': {
      InstalledAppsQueryError,
      deviceObserver: {
        getInstalledLaunchableApps: async () => {
          throw adapterInstalledAppsError;
        },
      },
    },
    '../application/DeviceObserverPort': { DeviceObserverInstalledAppsQueryError },
  },
);
await assert.rejects(
  () => installedAppsAdapterModule.deviceObserverAdapter.getInstalledLaunchableApps(),
  (error) => error instanceof DeviceObserverInstalledAppsQueryError,
  'Device Observer adapter 必须把 platform installed-app query failure 映射为 application error',
);
adapterInstalledAppsError = new Error('adapter programming error');
await assert.rejects(
  () => installedAppsAdapterModule.deviceObserverAdapter.getInstalledLaunchableApps(),
  /adapter programming error/u,
  'Device Observer adapter 不得把非预期错误伪装成 installed-app query failure',
);

// 外部工具合法参数不能因组合 schema 而抛异常，也不能忽略约束后放行非法参数。
for (const [schema, valid, invalid] of [
  [{ type: ['string', 'null'] }, null, 1],
  [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, 'coffee', false],
  [{ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1.5, 1],
  [{ allOf: [{ type: 'integer' }, { minimum: 1 }] }, 2, 0],
  [{ type: 'object', $defs: { qty: { type: 'integer', minimum: 1 } },
    properties: { qty: { $ref: '#/$defs/qty' } }, required: ['qty'] }, { qty: 2 }, { qty: '2' }],
  [{ type: 'object', additionalProperties: { type: 'integer' } }, { qty: 2 }, { qty: '2' }],
  [{ type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }, [1, null], ['1']],
  [{ type: 'object', properties: { mode: { enum: ['pickup', 'delivery'] }, address: { type: 'string' } },
    required: ['mode'], if: { properties: { mode: { const: 'delivery' } } }, then: { required: ['address'] } },
  { mode: 'delivery', address: '示例地址' }, { mode: 'delivery' }],
  [{ type: 'object', properties: { name: { type: 'string' } }, unevaluatedProperties: false }, { name: '门店' }, { other: '门店' }],
  [{ type: 'string', format: 'date' }, '2026-10-07', '2026-99-99'],
  [{ type: 'string', maxLength: 1 }, '😀', '😀😀'],
]) {
  const original = structuredClone(valid);
  assert.equal(matchesAgentToolInputSchema(valid, schema), true, JSON.stringify(schema));
  assert.equal(matchesAgentToolInputSchema(invalid, schema), false, JSON.stringify(schema));
  assert.deepEqual(valid, original, '校验不得修改模型参数');
}
const recursiveSchema = { type: 'object', properties: { next: { anyOf: [{ $ref: '#' }, { type: 'null' }] } }, additionalProperties: false };
assert.equal(matchesAgentToolInputSchema({ next: { next: null } }, recursiveSchema), true);
assert.equal(matchesAgentToolInputSchema({ next: { unknown: true } }, recursiveSchema), false);
for (const dialect of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema']) {
  assert.equal(matchesAgentToolInputSchema('ok', { $schema: dialect, type: 'string' }), true);
}
assert.throws(() => matchesAgentToolInputSchema({}, { type: 'object', properties: { x: { $ref: 'https://example.com/external-schema' } } }));
assert.throws(() => matchesAgentToolInputSchema('invalid', { $async: true, type: 'integer' }), /不支持异步/);
console.log('Agent Runtime contract 验证通过：公共出口、Registry、完整组合 Schema、Built-in Tool 元数据与暴露策略符合契约。');
