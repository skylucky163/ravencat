import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatRoot = path.join(repoRoot, 'src', 'features', 'chat');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(entryPath) : [entryPath];
  });
}

function findExportedFunctionParameterCount(relativePath, functionName) {
  const sourcePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const scriptKind = relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  let parameterCount = null;
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === functionName
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      parameterCount = node.parameters.length;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.notEqual(parameterCount, null, `${relativePath} 未找到导出的 ${functionName}`);
  return parameterCount;
}

function collectNamedExports(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const sourceFile = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set();
  function visit(node) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        names.add(element.name.text);
      }
    }
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

for (const oldPath of [
  'src/application/useCases/chat',
  'src/application/useCases/groupChat',
  'src/presentation/modules/chat',
  'src/presentation/components/chat',
]) {
  const absolutePath = path.join(repoRoot, oldPath);
  assert.ok(!fs.existsSync(absolutePath) || collect(absolutePath).length === 0, `${oldPath} 仍有遗留文件`);
}

const publicApiSource = read('src/features/chat/index.ts');
assert.equal(
  findExportedFunctionParameterCount(
    'src/features/chat/messages/application/SendUserMessage.ts',
    'sendUserMessage',
  ),
  2,
  '公开 sendUserMessage 必须严格只有 params 与 aiConfig 两个参数',
);
assert.equal(
  findExportedFunctionParameterCount(
    'src/features/chat/messages/application/ReceiveExternalAIMessage.ts',
    'receiveExternalAIMessage',
  ),
  1,
  '公开 receiveExternalAIMessage 必须严格只有一个业务参数对象',
);
const publicApiExports = collectNamedExports('src/features/chat/index.ts');
assert.equal(publicApiExports.has('sendUserMessageInternal'), false,
  '普通 Chat facade 不得导出依赖注入版 sendUserMessageInternal');
assert.equal(publicApiExports.has('receiveExternalAIMessageInternal'), false,
  '普通 Chat facade 不得导出依赖注入版 receiveExternalAIMessageInternal');
assert.equal(publicApiExports.has('SendUserMessageDeps'), false,
  '普通 Chat facade 不得导出 SendUserMessageDeps 结构类型');
assert.equal(publicApiExports.has('ReceiveExternalAIMessageDeps'), false,
  '普通 Chat facade 不得导出 ReceiveExternalAIMessageDeps 结构类型');
const compositionExports = collectNamedExports('src/features/chat/composition.ts');
assert.equal(compositionExports.has('sendUserMessageInternal'), true,
  'Chat composition 必须提供 Host 依赖注入版 sendUserMessageInternal');
assert.equal(compositionExports.has('receiveExternalAIMessageInternal'), true,
  'Chat composition 必须提供内部 receiveExternalAIMessageInternal');
for (const removedPublicSymbol of [
  'CreateMessageInput',
  'UpdateMessageInput',
  'CreateSessionInput',
  'CreateGroupChatRecordInput',
  'CreateGroupSpeechPlanInput',
  'CreateGroupSpeechTaskInput',
  'getChatDatabaseInfo',
]) {
  assert.equal(
    publicApiExports.has(removedPublicSymbol),
    false,
    `普通 Chat facade 不得暴露仓储 DTO 或数据库诊断入口：${removedPublicSymbol}`,
  );
}
const chatApplicationRoot = path.join(repoRoot, 'src', 'features', 'chat', 'application');
assert.ok(
  !fs.existsSync(chatApplicationRoot)
    || collect(chatApplicationRoot).length === 0,
  'Chat 顶层 application 目录不得保留业务文件；运行时端口必须归属具体子域',
);
const externalAssistantCommandSource = read(
  'src/features/chat/messages/application/AppendExternalAssistantMessages.ts',
);
assert.equal(
  fs.existsSync(path.join(repoRoot, 'src', 'features', 'chat', 'application', 'index.ts')),
  false,
  'Chat application forwarding layer 不应恢复',
);
assert.doesNotMatch(publicApiSource, /export \*/);
assert.doesNotMatch(publicApiSource, /infrastructure/);
assert.doesNotMatch(
  publicApiSource,
  /\b(?:configureChatRuntimeDependencies|messageRepository|sessionRepository|groupChatRepository|conversationTurnRepository|publishPublicChat|configureAIMessageDeliveryHandler|configureChatCallGateway|executeUserReplyTurn|ConversationTurn(?:Run|Execution)|CHAT_TASK_PROMPT_DEFINITIONS|clearSessionTimelineCache|setChatForegroundContext|syncChatSessionPreview|persistChatImageAttachment|deletePersistedChatAttachment|processAIReply|createLegacySegmentedReplyPersistence|persistChatMessage|persistChatMessages|emitChatMessages(?:Updated|Patched|ReloadRequested)|emitChatTypingStatusChanged|emitAIMessageReceived|resolveAIMessageDeliveryKind|resolveChatImageModelInput)\b/,
);
assert.doesNotMatch(
  publicApiSource,
  /\b(?:Chat(?:Conversation|Message|Group|Reply)RuntimeDependencies|configureChat(?:Conversation|Message|Group|Reply)Runtime|getChat(?:Conversation|Message|Group|Reply)RuntimeDependencies)\b/,
  '普通 Chat facade 不得暴露 Host runtime slot 或其 accessor',
);
assert.match(publicApiSource, /ChatRouterProvider/);
assert.match(publicApiSource, /ChatConversationRouteScreen/);
assert.match(publicApiSource, /appendExternalAssistantMessages/);
for (const groupPublicSymbol of [
  'getActiveGroupSpeechPlan',
  'invokeGroupChat',
  'markGroupConversationAsRead',
  'sendGroupUserMessage',
]) {
  assert.match(
    publicApiSource,
    new RegExp(`\\b${groupPublicSymbol}\\b`),
    `${groupPublicSymbol} 必须继续保留在 Chat 普通公共出口`,
  );
}
assert.match(externalAssistantCommandSource, /repository\.commitMessages\(/);
assert.doesNotMatch(
  externalAssistantCommandSource,
  /persistChatMessages|deliverAssistantMessage\(/,
  '外部 assistant command 不得重新组合旧 persistence/delivery 流程',
);

const chatCompositionSource = read('src/features/chat/composition.ts');
assert.match(chatCompositionSource, /configureChatRuntimeDependencies/);
assert.match(chatCompositionSource, /messageRepository/);
assert.match(chatCompositionSource, /sessionRepository/);
assert.match(chatCompositionSource, /groupChatRepository/);
assert.match(chatCompositionSource, /conversationTurnRepository/);
for (const hostOnlySymbol of [
  'configureChatCallGateway',
  'configureAIMessageDeliveryHandler',
  'executeUserReplyTurn',
  'isChatReplyRunCancellationError',
  'CHAT_TASK_PROMPT_DEFINITIONS',
  'clearSessionTimelineCache',
  'setChatForegroundContext',
  'persistChatImageAttachment',
  'deletePersistedChatAttachment',
  'emitChatMessagesUpdated',
  'emitChatMessagesPatched',
  'emitChatMessagesReloadRequested',
  'emitChatTypingStatusChanged',
]) {
  assert.match(chatCompositionSource, new RegExp(`\\b${hostOnlySymbol}\\b`), `${hostOnlySymbol} 未进入 Chat composition`);
}

const promptTypesSource = read('src/shared/prompt/types.ts');
const promptPackAssemblerApiSource = read('src/host/prompt/PromptPackAssembler.ts');
const promptHistorySource = read('src/host/prompt/PromptHistoryBuilder.ts');
const resolvedPromptAssemblerSource = read('src/host/prompt/ResolvedPromptPackAssembler.ts');
const hostPromptProviderSource = read('src/host/prompt/providers/HostPromptProviderRegistry.ts');
assert.doesNotMatch(promptTypesSource, /AssemblePromptPackParams<|repository\??:/,
  'Prompt Pack 参数不得注入 Chat repository 泛型或字段');
for (const [relativePath, source] of [
  ['src/host/prompt/PromptPackAssembler.ts', promptPackAssemblerApiSource],
  ['src/host/prompt/PromptHistoryBuilder.ts', promptHistorySource],
  ['src/host/prompt/ResolvedPromptPackAssembler.ts', resolvedPromptAssemblerSource],
  ['src/host/prompt/providers/HostPromptProviderRegistry.ts', hostPromptProviderSource],
]) {
  assert.doesNotMatch(source, /AssemblePromptPackParams</, `${relativePath} 不得保留 Prompt Pack repository 泛型`);
  assert.doesNotMatch(source, /params\.repository|repository:\s*messageRepository|repository:\s*promptHistoryRepository/, `${relativePath} 不得注入 Prompt Pack history repository`);
}
assert.match(promptHistorySource, /openConversationTimeline\(\s*\{/, 'PromptHistoryBuilder 必须经 Chat public timeline query 自持历史依赖');
const hostPublicApiSource = read('src/host/index.ts');
assert.doesNotMatch(hostPublicApiSource, /ChatScreen/);

assert.ok(
  !fs.existsSync(path.join(repoRoot, 'src', 'host', 'navigation', `AppContent${'Router'}.tsx`)),
  '旧宿主页分发器仍然存在'
);

const hostSource = read('src/host/KimiPhoneHost.tsx');
assert.match(hostSource, /<ChatRouterProvider/);
assert.match(hostSource, /\/chat\/\$\{encodeURIComponent\(aiId\)\}/);
assert.match(
  hostSource,
  /const markActiveConversationAsRead = useCallback[\s\S]*markGroupConversationAsRead\(context\.groupId\)[\s\S]*markConversationAsRead\(context\.sessionId, context\.aiId\)/,
  '当前单聊与群聊必须共用同一个前台已读入口'
);
assert.match(
  hostSource,
  /if \(state === 'active'\)[\s\S]*const activeContext = activeChatContextRef\.current;[\s\S]*markActiveConversationAsRead\(activeContext\)/,
  '回到前台且当前会话仍真实展示时必须重新标记已读'
);
assert.match(
  hostSource,
  /notificationAction === 'accept'[\s\S]*await acceptCall\(payload\.callId\)[\s\S]*pathname !== `\/calls\/\$\{payload\.callId\}`/,
  '通知接听动作必须先完成接听，再进入通话路由'
);
assert.match(
  hostSource,
  /!notificationResponsesReady[\s\S]*pendingNotificationNavigationRef\.current[\s\S]*processingExternalNavigationRef\.current/,
  '恢复活动通话前必须先消费通知动作，避免闪现待接听中间态'
);

const appLayoutSource = read('src/app/_layout.tsx');
assert.match(
  appLayoutSource,
  /name=["']calls\/\[callId\]["'][\s\S]*options=\{\{ animation: 'none', presentation: 'card' \}\}/,
  '通话页不得使用会露出透明底层的淡入淡出 Modal'
);

const nativeNotificationReceiverSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationActionReceiver.kt'
);
assert.match(
  nativeNotificationReceiverSource,
  /notificationAction == "reject"[\s\S]*NotificationResponseDispatcher\.recordCallAction\(appContext, response\)[\s\S]*return[\s\S]*appContext\.startActivity\(launchIntent\)/,
  '系统通知拒绝动作必须在启动界面之前转入后台任务并返回'
);

const nativeIncomingCallActivitySource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/IncomingCallActivity.kt'
);
// 渲染来电壳的 intent action 是 open（FSI/通知本体点开）；壳内接听/拒绝按钮必须显式
// 覆盖为自己的 action，否则 Host 会把接听/拒绝误当 open——不执行 acceptCall/rejectCall，
// RN 侧 incoming ringing 被 route guard 退出，表现为“接听后直接退出、拒接不生效”。
assert.match(
  nativeIncomingCallActivitySource,
  /handleAccept[\s\S]*buildResponse\(intent, "accept"\)/,
  '来电壳接听按钮必须显式记录 accept action，不得复用 open intent 的 action'
);
assert.match(
  nativeIncomingCallActivitySource,
  /handleReject[\s\S]*buildResponse\(intent, "reject"\)/,
  '来电壳拒绝按钮必须显式记录 reject action，不得复用 open intent 的 action'
);
// vivo 等 OEM 的自定义锁屏会盖在 showWhenLocked Activity 之上（表现为“屏被唤亮但看不到来电 UI”）。
// requestDismissKeyguard 在非安全锁屏下直接解除 keyguard，是来电/闹钟类应用的标准用法；
// 安全锁（PIN/指纹）不受影响，仍由系统决定。
assert.match(
  nativeIncomingCallActivitySource,
  /KeyguardManager[\s\S]*requestDismissKeyguard/,
  '来电壳必须通过 KeyguardManager.requestDismissKeyguard 解除非安全锁屏，避免被 OEM 自定义锁屏盖住'
);
// reject 的 durable native→Host inbox：先持久化 response；
// 前台 observer 在线则交付 Host 并出队；前台不在线则 Headless 立即执行 rejectCall()，
// 但保留 pending response 供 Host 下次启动/恢复消费对账（native action 不得只依赖一次内存事件交付）。


const nativeIncomingCallPublisherSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationPublisher.kt'
);
assert.match(
  nativeIncomingCallPublisherSource,
  /NotificationCompat\.CallStyle\.forIncomingCall/,
  '来电通知必须使用 Android CallStyle'
);
assert.match(
  nativeIncomingCallPublisherSource,
  /IncomingCallActivity::class\.java[\s\S]*PendingIntent\.getActivity\(/,
  '来电 open/accept 必须直连 IncomingCallActivity，不得经 BroadcastReceiver trampoline'
);
// 全屏权限关闭时的 CallStyle 发布行为由 IncomingCallPresentationTest 验证，
// 不以源码写法要求移除 Android 14 发布所需的 fullScreenIntent。
assert.match(
  nativeIncomingCallPublisherSource,
  /recordDiagnostics\(\s*context, INCOMING_CALL_DIAGNOSTICS_SCOPE[\s\S]*fullScreenIntentAllowed = fullScreenIntentAllowed/,
  '来电发布必须记录 FSI/渠道/通知开关的发布时刻快照'
);

const nativeNotificationModuleSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/KimiPhoneNotificationsModule.kt'
);
assert.match(
  nativeNotificationModuleSource,
  /openFullScreenIntentSettings[\s\S]*ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT/,
  '必须提供显式用户触发的 FSI 系统授权页入口'
);
assert.match(
  nativeNotificationModuleSource,
  /SDK_INT < 34[\s\S]*return@AsyncFunction false/,
  'API < 34 没有 FSI 系统授权页，入口必须显式返回 false'
);
// P1 锁屏来电排障：必须提供显式用户触发的来电 Channel 系统设置入口，
// 直达 INCOMING_CALL_CHANNEL_ID 页面，不得更换 Channel ID 强制重置用户配置。
assert.match(
  nativeNotificationModuleSource,
  /openIncomingCallNotificationSettings[\s\S]*ACTION_CHANNEL_NOTIFICATION_SETTINGS[\s\S]*EXTRA_APP_PACKAGE[\s\S]*EXTRA_CHANNEL_ID[\s\S]*INCOMING_CALL_CHANNEL_ID/,
  '必须提供显式用户触发的来电 Channel 系统通知设置入口'
);
// P1 锁屏来电排障：来电发布必须记录实际 Channel 锁屏可见性的发布时刻快照，
// 与 importance / FSI / 通知开关联排，用于区分 FSI 失败与 OEM 锁屏通知被关闭。
assert.match(
  nativeIncomingCallPublisherSource,
  /lockscreenVisibility\([\s\S]*INCOMING_CALL_CHANNEL_ID[\s\S]*incomingCallChannelLockscreenVisibility = callChannelLockscreenVisibility/,
  '来电发布必须记录实际 Channel 锁屏可见性的发布时刻快照'
);
const nativeNotificationStateStoreSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationStateStore.kt'
);
assert.match(
  nativeNotificationStateStoreSource,
  /callChannelLockscreenVisibility[\s\S]*lastNotificationIncomingCallChannelLockscreenVisibility/,
  '来电诊断必须可读回实际 Channel 锁屏可见性快照'
);
const nativeNotificationTsSource = read(
  'modules/kimiphone-notifications/src/KimiPhoneNotificationsModule.ts'
);
assert.match(
  nativeNotificationTsSource,
  /incomingCallChannelLockscreenVisibility/,
  'TS 通知类型必须暴露来电 Channel 锁屏可见性'
);
assert.match(
  nativeNotificationTsSource,
  /openIncomingCallNotificationSettings/,
  'TS 通知模块必须暴露来电 Channel 系统设置入口'
);
// 来电 Channel 创建时必须显式声明锁屏可见性 PUBLIC（只影响新创建；
// 已有用户的 Channel 由系统设置页决定，诊断读实际值）。
const nativeChannelRegistrySource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationChannelRegistry.kt'
);
assert.match(
  nativeChannelRegistrySource,
  /INCOMING_CALL_CHANNEL_ID,[\s\S]*?setLockscreenVisibility\(Notification\.VISIBILITY_PUBLIC\)/,
  '来电 Channel 必须显式声明锁屏可见性 VISIBILITY_PUBLIC'
);
// 来电排障诊断由 Calls 固定读取 incoming-call scope；Companion 不重复持有来电通知能力。
const callNotificationFacadeSource = read(
  'src/features/calls/application/CallNotificationFacade.ts'
);
assert.match(
  callNotificationFacadeSource,
  /INCOMING_CALL_NOTIFICATION_SCOPE = 'incoming-call'[\s\S]*getNotificationDiagnostics\(INCOMING_CALL_NOTIFICATION_SCOPE\)/,
  'Calls 必须固定读取 incoming-call scope 的来电诊断'
);

const nativeIncomingCallManifestSource = read(
  'modules/kimiphone-notifications/android/src/main/AndroidManifest.xml'
);
assert.match(
  nativeIncomingCallManifestSource,
  /USE_FULL_SCREEN_INTENT/,
  'Manifest 缺少 full-screen intent 权限声明'
);
assert.match(
  nativeIncomingCallManifestSource,
  /IncomingCallActivity[\s\S]*showWhenLocked="true"[\s\S]*turnScreenOn="true"/,
  'IncomingCallActivity 必须声明锁屏展示与亮屏能力'
);
const tabsLayoutSource = read('src/app/(tabs)/_layout.tsx');
assert.match(
  tabsLayoutSource,
  /initialRouteName=["']conversations["']/,
  '底部 Tabs 未把会话页声明为 Android 返回目标'
);
assert.match(
  tabsLayoutSource,
  /backBehavior=["']initialRoute["']/,
  '底部 Tabs 未限制 Android 返回只经过一次会话页'
);
assert.doesNotMatch(
  tabsLayoutSource,
  /backBehavior=["'](?:history|fullHistory)["']/,
  '底部 Tabs 仍会按访问历史反复回退'
);

for (const routePath of [
  'src/app/(tabs)/conversations.tsx',
  'src/app/chat/[aiId]/index.tsx',
  'src/app/chat/[aiId]/file-preview.tsx',
]) {
  assert.match(read(routePath), /from '@features\/chat'/, `${routePath} 未通过 Chat 公共出口接入`);
}

for (const [routePath, featurePath] of [
  ['src/app/(tabs)/mini-programs.tsx', '@features/miniPrograms'],
  ['src/app/appearance.tsx', '@features/miniPrograms'],
  ['src/app/calls/[callId].tsx', '@features/calls'],
]) {
  assert.match(read(routePath), new RegExp(`from ['"]${featurePath}`), `${routePath} 仍依赖旧页面适配器`);
}

const hostCompositionSource = read('src/host/composition/configureChatRuntime.ts');
assert.match(hostCompositionSource, /from '@features\/chat\/composition'/);
assert.match(hostCompositionSource, /configureChatRuntimeDependencies/);
assert.match(hostCompositionSource, /messages: messageRepository/);
assert.match(hostCompositionSource, /sessions: sessionRepository/);
assert.match(hostCompositionSource, /groups: groupChatRepository/);
assert.match(hostCompositionSource, /readVisionImage/);
assert.match(hostCompositionSource, /resolveOCRModel/);
assert.match(hostCompositionSource, /capabilityKind: 'ocr'/);
assert.match(hostCompositionSource, /buildToolsDescription/);

const forbiddenFeatureRouteImport = new RegExp(`from ['"](?:@host|@${'app'}|expo-router)`);
for (const filePath of collect(chatRoot).filter((file) => /\.(?:ts|tsx)$/.test(file))) {
  const source = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(source, /Platform\.OS\s*(?:===|!==)\s*['"]ios['"]/, `${filePath} 仍包含 iOS 分支`);
  assert.doesNotMatch(source, forbiddenFeatureRouteImport, `${filePath} 反向依赖宿主路由`);
}

const storageIndexSource = read('src/platform/persistence/index.ts');
assert.doesNotMatch(storageIndexSource, /MessageRepository|SessionRepository|GroupChatRepository/);

const executeUserReplyTurnSource = read(
  'src/features/chat/reply/application/ExecuteUserReplyTurn.ts'
);
const assistantPersistenceSource = read(
  'src/features/chat/reply/application/AssistantReplyPersistence.ts'
);
const assistantDeliverySource = read(
  'src/features/chat/reply/application/AssistantMessageDelivery.ts'
);
assert.match(
  executeUserReplyTurnSource,
  /deliveryTiming: params\.deliveryTiming/,
  'run 执行入口必须把 deliveryTiming 透传到回复运行时上下文'
);
assert.match(assistantPersistenceSource, /deliveryTiming: runtimeContext\.deliveryTiming/);
assert.match(
  assistantPersistenceSource,
  /segments: segmentAssistantReplyText\(normalizedText, policy\.bubbleDeliveryMode\)/,
  '聊天回复必须经 segmentAssistantReplyText 代码分段，不再校验任何 XML 信封'
);
assert.match(
  assistantPersistenceSource,
  /deliverAssistantMessage\(\{[\s\S]*segments: normalizedResponse\.segments/,
  '分段结果必须按段投递'
);
assert.doesNotMatch(
  assistantPersistenceSource,
  /parseAssistantTurnEnvelope|AssistantReplyFormatError/,
  '回复持久化不得再依赖 assistant_turn XML 解析'
);
assert.match(
  assistantDeliverySource,
  /params\.deliveryTiming === 'immediate'[\s\S]*void deliverSegment\(\)[\s\S]*setTimeout/,
  '后台即时回复必须绕过会被冻结的 JavaScript 分段定时器'
);

const messagePresentationSource = read(
  'src/features/chat/presentation/messages/components/chatMessagePresentation.ts'
);
assert.doesNotMatch(messagePresentationSource, /normalizeSegmentedMessageText|<reply\b/);
for (const removedLegacySegmenterPath of [
  'src/features/chat/messages/domain/ChatMessageSegmenter.ts',
  'src/features/chat/messages/domain/messageConstants.ts',
]) {
  assert.equal(
    fs.existsSync(path.join(repoRoot, removedLegacySegmenterPath)),
    false,
    `旧消息分段文件不应恢复：${removedLegacySegmenterPath}`
  );
}

const batchInputSource = read(
  'src/features/chat/reply/application/BuildChatBatchAIInput.ts'
);
const groupMessagingSource = read(
  'src/features/chat/group/application/GroupChatMessaging.ts'
);
const groupSources = [
  read('src/features/chat/group/application/GroupMessageCommit.ts'),
  read('src/features/chat/group/application/GroupSpeakerPlanning.ts'),
  read('src/features/chat/group/application/GroupSpeechTaskExecution.ts'),
  groupMessagingSource,
].join('\n');
// 图片路线与失败行为由 verify-auxiliary-model-runtime 的实际输入输出验证。
assert.match(batchInputSource, /assistantId: string/);
assert.match(
  executeUserReplyTurnSource,
  /assistantId: aiConfig\.id/,
  '回合输入组装必须按目标助手分别选择 OCR 或直接视觉路线'
);
assert.doesNotMatch(
  groupMessagingSource,
  /\b(?:commitMessage|createAIClient|buildChatBatchAIInput|processAIReply|createLegacySegmentedReplyPersistence)\b/,
  'GroupChatMessaging 必须保持为 plan 生命周期薄编排器，不得重新吸收提交、规划或回复执行职责',
);
assert.doesNotMatch(
  groupSources,
  /\buser_reply\b|\bexecuteUserReplyTurn\b/,
  '群聊拆分不得接入 canonical user_reply 或普通 Chat execution host',
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-concurrency-'));
async function importStandaloneTypeScript(relativePath) {
  const sourcePath = path.join(repoRoot, relativePath);
  const outputPath = path.join(tmpDir, `${path.basename(relativePath, '.ts')}.mjs`);
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  });
  fs.writeFileSync(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const chatEvents = await importStandaloneTypeScript(
  'src/features/chat/messages/events/ChatEvents.ts'
);
const typingEvents = [];
const groupSpeechPlanEvents = [];
const unsubscribeTyping = chatEvents.setChatEventBus({
  emit: (eventName, payload) => {
    if (eventName === 'typingStatusChanged') typingEvents.push(payload);
    if (eventName === 'groupSpeechPlanChanged') groupSpeechPlanEvents.push(payload);
  },
});
chatEvents.emitChatTypingStatusChanged('session-1', true, 'normal-reply');
chatEvents.emitChatTypingStatusChanged('session-1', true, 'proactive-reply');
chatEvents.emitChatTypingStatusChanged('session-1', false, 'normal-reply');
assert.equal(chatEvents.getActiveChatTypingCount('session-1'), 1);
assert.equal(typingEvents.at(-1).isTyping, true, '一个请求结束时不得隐藏另一个 typing');
chatEvents.emitChatTypingStatusChanged('session-1', false, 'proactive-reply');
assert.equal(typingEvents.at(-1).isTyping, false);
chatEvents.emitChatGroupSpeechPlanChanged('group-1');
assert.deepEqual(
  groupSpeechPlanEvents,
  [{ sessionId: 'group-1' }],
  '群发言 plan 变化事件只携带 groupId，consumer 必须重读持久 query',
);
unsubscribeTyping();

const ordering = await importStandaloneTypeScript(
  'src/features/chat/messages/domain/ChatTimelineOrdering.ts'
);
assert.deepEqual(
  ordering.sortChatTimelineMessages([
    { id: 7, createdAt: '2026-07-28T10:00:01.000Z' },
    { id: 9, createdAt: '2026-07-28T10:00:00.000Z' },
    { id: 8, createdAt: '2026-07-28T10:00:00.000Z' },
  ]).map((message) => message.id),
  [8, 9, 7],
);

assert.equal(
  fs.existsSync(path.join(repoRoot, 'src/app/chat/[aiId]/sessions.tsx')),
  false,
  '单聊历史 session route 必须退役',
);

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
const insert = db.prepare(
  'INSERT INTO messages (session_id, text, created_at) VALUES (?, ?, ?)'
);
// 请求先后顺序与提交顺序相反：上下文只认真实提交时间。
insert.run('session-1', '主动回复', '2026-07-28T10:00:00.000Z');
insert.run('session-1', '正常回复', '2026-07-28T10:00:01.000Z');
insert.run('session-1', '同毫秒第二条', '2026-07-28T10:00:01.000Z');
const replay = db.prepare(
  'SELECT text FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC'
).all('session-1');
assert.deepEqual(replay.map((row) => row.text), ['主动回复', '正常回复', '同毫秒第二条']);
db.close();

const timelineSyncSource = read(
  'src/features/chat/presentation/messages/components/useChatTimelineSync.ts'
);
const foregroundContextSource = read(
  'src/features/chat/reply/delivery/ChatForegroundContext.ts'
);
assert.doesNotMatch(timelineSyncSource, /TYPING_INDICATOR_VISIBLE_MS|scheduleStopTyping/);
assert.match(timelineSyncSource, /setIsTyping\(payload\.isTyping === true\)/);
assert.match(foregroundContextSource, /foregroundContext\.sessionId === sessionId/);

console.log('Chat 运行时契约检查通过。');
