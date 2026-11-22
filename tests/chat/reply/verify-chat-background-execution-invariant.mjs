/**
 * Chat 后台回复 Protected Contract 的可执行回归验证。
 *
 * 这里不是只扫描源码：SendUserMessage 与 ConversationTurnCoordinator 都从
 * 当前源码动态编译。数据库提交、通知事件和 Android 模块用边界 fake 替代，
 * 但真实的「sendUserMessage → canonical onCommitted → coordinator」调用链保持不变。
 *
 * 覆盖：
 * A. 普通页面默认委派，即使 SendUserMessage 实际构造 notifyUI；
 * B. 非空 replyCallbacks 仍不改变默认委派；
 * C. 受控 Headless 调用方显式 inline_current_host，就地 claim 且不二次启动 host；
 * D. execution host 返回 false 时 T1 持久化事实保留，页面不 fallback 执行。
 */

import { repoRoot as ROOT } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function transpileToModuleUrl(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 真实 ConversationTurnCoordinator（只桩掉跨 Feature / platform / shared IO）
// ---------------------------------------------------------------------------
const chatReplyAbortModuleUrl = transpileToModuleUrl(
  read('src/features/chat/reply/application/ChatReplyAbort.ts'),
);
const coordinatorSource = read('src/host/runtime/ConversationTurnCoordinator.ts');
const chatCompositionImportPattern =
  /import\s*\{[^;]*?\}\s*from\s*['"]@features\/chat\/composition['"];?/;
const stubbedCoordinatorSource = coordinatorSource
  .replace(/import\s*\{[^}]*\}\s*from\s*'@shared\/theme\/[^']+';/g, '')
  .replace(
    chatCompositionImportPattern,
    `import { isChatReplyRunCancellationError } from '${chatReplyAbortModuleUrl}';
const executeUserReplyTurn = null;
const emitChatMessagesReloadRequested = () => {};
const emitChatTurnExecutionChanged = () => {};
const interruptChatRunPresentation = async () => {};
const emitChatTypingStatusChanged = () => {};
const emitChatRegenerationChanged = () => {};`,
  )
  .replace(
    chatCompositionImportPattern,
    'const conversationTurnRepository = null; const sessionRepository = null;',
  )
  .replace(
    /import\s*\{\s*aiAssistantRepository\s*\}\s*from\s*['"]@features\/assistants['"];?/,
    'const aiAssistantRepository = null;',
  )
  .replace(
    /import\s*\{\s*startConversationTurnExecutionHost\s*\}\s*from\s*['"]@platform\/device['"];?/,
    'const startConversationTurnExecutionHost = async () => false;',
  )
  .replace(
    /import\s*\{\s*logTurnTimeline\s*\}\s*from\s*['"]@shared\/diagnostics\/TurnTimelineLog['"];?/,
    'const logTurnTimeline = () => {};',
  );
assert.ok(
  !stubbedCoordinatorSource.includes("'@features/chat'")
    && !stubbedCoordinatorSource.includes("'@features/chat/composition'")
    && !stubbedCoordinatorSource.includes("'@features/assistants'")
    && !stubbedCoordinatorSource.includes("'@platform/device'")
    && !stubbedCoordinatorSource.includes("'@shared/diagnostics/TurnTimelineLog'"),
  '协调器测试桩不得遗留跨 Feature / platform / shared 值导入',
);
const coordinatorModuleUrl = transpileToModuleUrl(stubbedCoordinatorSource);
const { createConversationTurnCoordinator } = await import(coordinatorModuleUrl);

// ---------------------------------------------------------------------------
// 真实 SendUserMessage（仅替换数据库 / UI 事件 / repository 等边界）
// ---------------------------------------------------------------------------
const sendUserMessageSource = read('src/features/chat/messages/application/SendUserMessage.ts');
const transpiledSendUserMessageSource = ts.transpileModule(sendUserMessageSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const mediaUrl = transpileToModuleUrl(`
  export const MEDIA_ASSET_STORAGE_BACKEND = { persistentMedia: 'persistent-media' };
  export async function prepareMediaAssetBatch() { throw new Error('此后台契约场景没有媒体准备'); }
`);
const mimeUrl = transpileToModuleUrl(read('src/features/chat/messages/application/ChatAttachmentMime.ts'));
const prepareUrl = transpileToModuleUrl(read('src/features/chat/messages/application/PrepareChatAttachments.ts')
  .replace(/from ['"]@features\/media['"]/g, `from '${mediaUrl}'`)
  .replace(/from ['"]\.\/ChatAttachmentMime['"]/g, `from '${mimeUrl}'`));
const stubbedSendUserMessageSource = transpiledSendUserMessageSource
  .replace(/from ['"]\.\/PrepareChatAttachments['"]/g, `from '${prepareUrl}'`)
  .replace(/from ['"]\.\/UserMessageSubmission['"]/g,
    `from '${transpileToModuleUrl(read('src/features/chat/messages/application/UserMessageSubmission.ts'))}'`)
  .replace(
    /import\s*\{[\s\S]*?\}\s*from\s*['"]@features\/chat\/messages\/domain['"];?/,
    `const buildAttachmentMessageMetadata = ({ attachments }) => attachments.length > 0
  ? { attachmentCount: attachments.length }
  : null;
const buildUserMessagePreviewText = ({ text }) => text;
const getReplyQuoteAttachments = (quote) => {
  if (quote) throw new Error('后台执行场景未提供引用');
  return [];
};`,
  )
  .replace(
    /import\s*\{\s*getChatMessageRuntimeDependencies,?\s*\}\s*from\s*['"]\.\/ChatMessageRuntime['"];?/,
    'const getChatMessageRuntimeDependencies = () => globalThis.__chatBackgroundIntegration.runtime;',
  )
  .replace(
    /import\s*\{\s*commitAndDispatchCanonicalUserMessage\s*\}\s*from\s*['"]\.\/CommitAndDispatchCanonicalUserMessage['"];?/,
    `const commitAndDispatchCanonicalUserMessage = async (params) => {
  const integration = globalThis.__chatBackgroundIntegration;
  integration.commitCalls.push(params);
  const message = {
    ...params.message,
    id: integration.commitCalls.length,
  };
  integration.pendingFacts.set(params.message.sessionId, {
    userMessageCommitted: true,
    pendingReply: true,
  });
  try {
    // 与真实实现一致：canonical commit 的 notifyUI 在先，Host 的 commit 后执行在后；
    // replyCallbacks.notifyUI 一律由真实 UI 信号覆盖，不信任调用方注入。
    integration.uiEvents.push(params.message.sessionId);
    await integration.runtime.canonicalUserMessage?.onCommitted({
      sessionId: params.message.sessionId,
      message,
      supersededRunId: null,
      aiConfig: params.aiConfig,
      executionMode: params.executionMode ?? 'delegate_to_android_host',
      replyCallbacks: {
        ...params.replyCallbacks,
        notifyUI: (sessionId) => { integration.uiEvents.push(sessionId); },
      },
      deliveryTiming: params.deliveryTiming,
      correlationId: params.correlationId,
    });
    return { userMessage: message, userMessages: [message], success: true, error: null };
  } catch (error) {
    return {
      userMessage: message,
      userMessages: [message],
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};`,
  )
  .replace(
    /import\s*\{\s*logTurnTimeline\s*\}\s*from\s*['"]@shared\/diagnostics\/TurnTimelineLog['"];?/,
    'const logTurnTimeline = () => {};',
  );
assert.ok(
  !stubbedSendUserMessageSource.includes("'@features/chat/messages/domain'")
    && !stubbedSendUserMessageSource.includes("'./ChatMessageRuntime'")
    && !stubbedSendUserMessageSource.includes("'@features/assistants'")
    && !stubbedSendUserMessageSource.includes("'../events/ChatEvents'")
    && !stubbedSendUserMessageSource.includes("'./CommitAndDispatchCanonicalUserMessage'")
    && !stubbedSendUserMessageSource.includes("'@shared/diagnostics/TurnTimelineLog'"),
  'SendUserMessage 测试桩不得遗留不可解析的运行时导入',
);
const sendUserMessageModuleUrl = transpileToModuleUrl(stubbedSendUserMessageSource);
const { sendUserMessage, sendUserMessageInternal } = await import(sendUserMessageModuleUrl);

const aiConfig = {
  id: 'ai-1',
  agentId: 'agent-1',
  name: 'Test AI',
};

function createCoordinatorFakes({ hostAccepted = true } = {}) {
  let runSeq = 0;
  const calls = {
    executionHostStart: [],
    claimIfIdle: [],
    takeOverOrphan: [],
    executeTurn: [],
  };
  const turns = {
    claimIfIdle: async (sessionId, kind) => {
      const run = {
        runId: `run-${++runSeq}`,
        sessionId,
        kind,
        replyCursorAtClaim: 0,
        inputHighWatermark: 1,
        revisionAtClaim: 1,
        status: 'active',
        terminalReason: null,
        createdAt: '2026-08-08T00:00:00.000Z',
        terminalAt: null,
      };
      calls.claimIfIdle.push({ sessionId, kind, run });
      return run;
    },
    takeOverOrphan: async (sessionId, kind) => {
      calls.takeOverOrphan.push({ sessionId, kind });
      return null;
    },
    revoke: async () => {},
    findTerminalRunCovering: async () => null,
    getSessionTurnSnapshot: async () => null,
    listSessionsWithUnrepliedInput: async () => [],
  };
  const executeTurn = async (params) => {
    calls.executeTurn.push(params);
    return 'committed';
  };
  const executionHost = {
    start: async (sessionIds, options) => {
      calls.executionHostStart.push({ sessionIds, options, accepted: hostAccepted });
      return hostAccepted;
    },
  };
  return { calls, turns, executeTurn, executionHost };
}

function createIntegrationScenario(options = {}) {
  const fakes = createCoordinatorFakes(options);
  const coordinator = createConversationTurnCoordinator({
    turns: fakes.turns,
    executeTurn: fakes.executeTurn,
    resolveAIConfig: async () => aiConfig,
    executionHost: fakes.executionHost,
  });
  const state = {
    commitCalls: [],
    uiEvents: [],
    pendingFacts: new Map(),
    onCommittedPayloads: [],
    runtime: {
      assistantDirectory: {
        getBlockState: async () => ({ isBlocked: false }),
      },
      canonicalUserMessage: {
        onCommitted: async (payload) => {
          state.onCommittedPayloads.push(payload);
          if (options.failAfterCommit) {
            throw new Error('post-commit callback failed');
          }
          await coordinator.onCanonicalUserMessageCommitted(payload);
        },
      },
    },
    ...fakes,
  };
  globalThis.__chatBackgroundIntegration = state;
  return { state, coordinator };
}

// Case E：commit 后副作用失败时必须保留已落库消息，下游才不会误删其附件。
{
  const { state } = createIntegrationScenario({ failAfterCommit: true });
  const result = await sendThroughRealApplication('s-post-commit-failure');
  assert.equal(result.success, false, 'commit 后副作用失败应暴露失败');
  assert.equal(state.commitCalls.length, 1, '消息已完成 canonical commit');
  assert.equal(result.userMessage?.sessionId, 's-post-commit-failure', '返回值必须保留 commit 事实');
}

async function sendThroughRealApplication(sessionId, options) {
  const params = { sessionId, text: 'hello from verifier' };
  const result = options === undefined
    ? await sendUserMessage(params, aiConfig)
    : await sendUserMessageInternal(params, aiConfig, {
        correlationId: options.correlationId ?? `corr-${sessionId}`,
        deliveryTiming: options.deliveryTiming ?? 'paced',
        executionMode: options.executionMode,
        replyCallbacks: options.replyCallbacks,
      });
  // inline execution uses a fire-and-forget executeRun; let its terminal cleanup run.
  await flush();
  await flush();
  return result;
}

// Case A：真实 SendUserMessage 默认值 + 其内部 notifyUI 必须委派 host。
{
  const { state } = createIntegrationScenario();
  const result = await sendThroughRealApplication('s-default');
  assert.equal(result.success, true, '普通页面发送必须成功提交 T1');
  assert.equal(state.commitCalls.length, 1, '必须经过真实 SendUserMessage 的 canonical commit 调用');
  assert.equal(state.uiEvents.length, 1, 'canonical commit 后必须触发真实 notifyUI 投影');
  assert.equal(state.onCommittedPayloads.length, 1, 'T1 commit 后必须调用 canonical onCommitted');
  const payload = state.onCommittedPayloads[0];
  assert.equal(
    payload.executionMode,
    'delegate_to_android_host',
    '普通调用方省略 executionMode 时必须采用安全委派默认值',
  );
  assert.equal(typeof payload.replyCallbacks?.notifyUI, 'function', 'SendUserMessage 必须保留 notifyUI callback');
  assert.equal(state.calls.executionHostStart.length, 1, '默认页面路径必须启动 Android execution host');
  assert.deepEqual(state.calls.executionHostStart[0].sessionIds, ['s-default']);
  assert.equal(state.calls.claimIfIdle.length, 0, '默认页面路径不得在页面 runtime claim');
  assert.equal(state.calls.executeTurn.length, 0, '默认页面路径不得在页面 runtime execute');
}

// Case B：普通 page-style send 带非空 callbacks 仍必须委派，callback 不能成为 ownership 信号。
{
  const { state } = createIntegrationScenario();
  const pageCallbacks = { onReplySegment: () => {} };
  const result = await sendThroughRealApplication('s-callback', {
    replyCallbacks: pageCallbacks,
    correlationId: 'corr-callback',
  });
  assert.equal(result.success, true, '带 presentation callback 的普通发送仍必须成功');
  const payload = state.onCommittedPayloads[0];
  assert.equal(payload.executionMode, 'delegate_to_android_host');
  assert.equal(payload.replyCallbacks?.onReplySegment, pageCallbacks.onReplySegment, '业务 callback 必须原样保留');
  assert.equal(typeof payload.replyCallbacks?.notifyUI, 'function');
  assert.equal(state.calls.executionHostStart.length, 1, '非空 callbacks 仍必须启动 execution host');
  assert.equal(state.calls.claimIfIdle.length, 0, '非空 callbacks 不得在页面 runtime claim');
  assert.equal(state.calls.executeTurn.length, 0, '非空 callbacks 不得在页面 runtime execute');
}

// Case C：真正受控的 Headless 调用方显式 opt-in inline_current_host，不能再启动第二个 host。
{
  const { state } = createIntegrationScenario();
  const result = await sendThroughRealApplication('s-inline', {
    executionMode: 'inline_current_host',
    deliveryTiming: 'immediate',
    correlationId: 'corr-inline',
    replyCallbacks: { onReplyCommitted: () => {} },
  });
  assert.equal(result.success, true, 'inline Headless 发送必须成功');
  const payload = state.onCommittedPayloads[0];
  assert.equal(payload.executionMode, 'inline_current_host');
  assert.equal(state.calls.claimIfIdle.length, 1, 'inline host 必须在当前受控 host claim');
  assert.equal(state.calls.executeTurn.length, 1, 'inline host 必须在当前受控 host 执行');
  assert.equal(state.calls.executionHostStart.length, 0, 'inline host 不得再次启动 Android execution host');
}

// Case D：host 启动被拒绝时，T1 pending 事实必须保留，且页面不得 fallback claim / execute。
{
  const { state } = createIntegrationScenario({ hostAccepted: false });
  const result = await sendThroughRealApplication('s-host-rejected', {
    replyCallbacks: { notifyUI: () => {} },
    correlationId: 'corr-rejected',
  });
  assert.equal(result.success, true, 'host 启动被拒绝不应回滚已提交的 T1');
  assert.deepEqual(
    state.pendingFacts.get('s-host-rejected'),
    { userMessageCommitted: true, pendingReply: true },
    'host 启动失败后必须保留持久化 pending reply 事实',
  );
  assert.equal(state.calls.executionHostStart.length, 1, '必须记录一次失败的 host 启动尝试');
  assert.equal(state.calls.executionHostStart[0].accepted, false);
  assert.equal(state.calls.claimIfIdle.length, 0, 'host 启动失败后禁止页面 fallback claim');
  assert.equal(state.calls.executeTurn.length, 0, 'host 启动失败后禁止页面 fallback execute');
}

// 保护性源码断言：ownership 只能由显式 mode 决定，不能回到 callback truthiness。
assert.match(
  sendUserMessageSource,
  /executionMode:\s*deps\.executionMode\s*\?\?\s*['"]delegate_to_android_host['"]/
    ,
  'SendUserMessage 必须显式安全默认 delegate_to_android_host',
);
assert.match(
  coordinatorSource,
  /payload\.executionMode\s*===\s*['"]inline_current_host['"]/
  ,
  'Coordinator 必须按显式 executionMode 判定 inline ownership',
);
assert.doesNotMatch(
  coordinatorSource,
  /if\s*\([^)]*payload\.replyCallbacks|Boolean\s*\(\s*payload\.replyCallbacks/,
  'Coordinator 不得以 replyCallbacks truthiness 判定 execution ownership',
);
const floatingMessageExecutorSource = read('src/features/companion/application/ExecuteFloatingMessage.ts');
assert.match(
  floatingMessageExecutorSource,
  /sendUserMessageFromExecutionHost/,
  'RavenCat 悬浮消息执行用例必须通过窄 execution-host port 发送消息',
);
assert.match(
  floatingMessageExecutorSource,
  /await\s+replyCompletion/,
  'RavenCat 悬浮消息执行用例必须等待 replyCompletion 后结束任务',
);
const ravenCatHostCompositionSource = read('src/host/composition/configureCompanionRuntime.ts');
assert.match(
  ravenCatHostCompositionSource,
  /sendUserMessageFromExecutionHost[\s\S]*?sendUserMessageInternal\([\s\S]*?executionMode:\s*['"]inline_current_host['"][\s\S]*?deliveryTiming:\s*['"]immediate['"]/,
  'RavenCat Host adapter 必须经窄端口调用 sendUserMessageInternal，并固定 inline_current_host 与 immediate',
);

delete globalThis.__chatBackgroundIntegration;
console.log('Chat background execution invariant verifier 通过：真实 SendUserMessage → canonical onCommitted → Coordinator 的 A/B/C/D/E 场景均符合 Protected Contract。');
console.log('Android Headless 生命周期与真机后台网络消费仍需真机验收。');
