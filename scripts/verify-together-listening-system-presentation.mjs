/** Together standard ongoing notification lifecycle 与 Headless contract 验证。 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const lifecycleSource = read('src/features/togetherListening/application/TogetherListeningLifecycle.ts');
const projectionSource = read('src/features/togetherListening/application/TogetherListeningSystemPresentation.ts');
const runtimeSource = read('src/features/togetherListening/application/TogetherListeningRuntime.ts');
const hostCompositionSource = read('src/host/composition/configureTogetherListeningRuntime.ts');
const headlessSource = read('src/host/notifications/TogetherListeningNotificationAction.ts');
const publisherSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationPublisher.kt',
);
const receiverSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationActionReceiver.kt',
);
const dispatcherSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationResponseDispatcher.kt',
);
const moduleSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/KimiPhoneNotificationsModule.kt',
);
const externalNavigationSource = read('src/host/navigation/externalNavigation.ts');
const hostSource = read('src/host/KimiPhoneHost.tsx');
const awarenessSource = read(
  'src/features/togetherListening/application/TogetherListeningRuntimeAwareness.ts',
);
const stateStoreSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationStateStore.kt',
);
const channelSource = read(
  'modules/kimiphone-notifications/android/src/main/java/expo/modules/kimiphonenotifications/NotificationChannelRegistry.kt',
);
const manifestSource = read('modules/kimiphone-notifications/android/src/main/AndroidManifest.xml');
const buildSource = read('modules/kimiphone-notifications/android/build.gradle');

assert.match(runtimeSource, /TogetherListeningSystemPresentationPort/);
assert.match(projectionSource, /activity\.phase !== 'active'/, '非 active 必须 cancel');
assert.match(projectionSource, /activatedAtEpochMs/, 'system chronometer 必须来自 canonical 激活时间');
assert.match(lifecycleSource, /projectActivityToSystemPresentation\(updated\)/, 'canonical transition 后必须投影');
assert.match(lifecycleSource, /Android 系统 presentation 投影失败/, '投影失败必须独立记录');
assert.doesNotMatch(lifecycleSource, /projectionStatus.*system/s, 'Chat projectionStatus 不得混入 system 状态');
assert.match(hostCompositionSource, /upsertTogetherListeningSystemPresentation/);
assert.match(hostCompositionSource, /cancelTogetherListeningSystemPresentation/);

assert.doesNotMatch(
  manifestSource,
  /android\.permission\.POST_PROMOTED_NOTIFICATIONS/,
  'V1 已删除 promoted notification permission',
);
assert.match(manifestSource, /TogetherListeningNotificationActivity/);
assert.match(buildSource, /androidx\.core:core-ktx:1\.13\.1/);
assert.doesNotMatch(
  buildSource,
  /androidx\.core:core-ktx:1\.17\.0/,
  'promoted API 删除后通知模块不得继续为该分支直接锁定 core-ktx 1.17.0',
);
assert.match(channelSource, /together_listening_live_v1/);
assert.match(channelSource, /IMPORTANCE_LOW/);
assert.doesNotMatch(channelSource, /TOGETHER_LISTENING[\s\S]{0,300}IMPORTANCE_MIN/);
assert.match(channelSource, /enableVibration\(false\)/);
assert.match(channelSource, /setShowBadge\(false\)/);

for (const characteristic of [
  /setOngoing\(true\)/,
  /setContentTitle\("正在一起听"\)/,
  /setOnlyAlertOnce\(true\)/,
  /setWhen\(activatedAtEpochMs\)/,
  /setUsesChronometer\(true\)/,
  /setDeleteIntent/,
]) {
  assert.match(publisherSource, characteristic);
}
assert.match(publisherSource, /TOGETHER_LISTENING_DISPLAY_ID = "together-listening-live"/);
assert.match(publisherSource, /buildTogetherListeningActivityIntent/, '点击必须使用直接 Activity PendingIntent');
assert.doesNotMatch(publisherSource, /RemoteViews|setCustomContentView|setCustomBigContentView/);
assert.doesNotMatch(publisherSource, /setGroupSummary\(true\)[\s\S]{0,500}TogetherListening/);
for (const removedPromotedContract of [
  /setRequestPromotedOngoing/,
  /canPostPromotedNotifications/,
  /hasPromotableCharacteristics/,
  /FLAG_PROMOTED_ONGOING/,
  /POST_PROMOTED_NOTIFICATIONS/,
  /ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS/,
]) {
  assert.doesNotMatch(
    publisherSource,
    removedPromotedContract,
    `standard notification 不得包含已删除 promoted contract：${removedPromotedContract}`,
  );
}

assert.match(receiverSource, /recordTogetherListeningDismissal/);
assert.match(stateStoreSource, /KEY_TOGETHER_DISMISSED_ACTIVITY_ID/);
assert.match(stateStoreSource, /isTogetherListeningDismissed/);
assert.match(publisherSource, /isTogetherListeningDismissed/);
assert.match(publisherSource, /status = "suppressed"/);
assert.match(publisherSource, /currentActivityId != activityId/, '旧 Activity cancel 不得撤销新 presentation');

assert.match(headlessSource, /getTogetherListeningActivityById\(activityId\)/);
assert.match(headlessSource, /activity\.hostAiId !== hostAiId/);
assert.match(headlessSource, /activity\.chatSessionId !== chatSessionId/);
assert.match(headlessSource, /source: 'system_capsule'/);

// system leave 必须先 durable enqueue，再交付运行宿主。
assert.match(receiverSource, /recordTogetherListeningAction/, 'receiver 不得绕过 durable dispatcher 直启 Headless');
assert.doesNotMatch(receiverSource, /TogetherListeningNotificationActionHeadlessTaskService\.start/);
assert.match(dispatcherSource, /fun recordTogetherListeningAction/);

// BLOCKER 1：Together open 使用专用可重复 target，不伪装成 ai-message 一次性事件。
assert.match(externalNavigationSource, /type: 'together-listening'/);
assert.match(externalNavigationSource, /createTogetherListeningNavigationTarget/);
assert.match(externalNavigationSource, /isOneShotExternalNavigationTarget/);
assert.match(
  externalNavigationSource,
  /isOneShotExternalNavigationTarget[\s\S]{0,300}target\.type === 'together-listening'[\s\S]{0,100}return false/,
  'Together ongoing surface 不得进入一次性 dedupe',
);
assert.match(hostSource, /createTogetherListeningNavigationTarget/);
assert.match(hostSource, /isOneShotExternalNavigationTarget/);
assert.doesNotMatch(
  hostSource,
  /type === 'together-listening'\) \{\s*queueExternalNavigation\(createMessageNavigationTarget/,
  'Together open 不得再伪装成 ai-message event',
);

// Host 必须区分 open / leave：leave 走 canonical leave 并校验 Activity 身份，不导航。
assert.match(hostSource, /handleTogetherListeningNotification/);
assert.match(hostSource, /activity\.hostAiId !== target\.aiId/);
assert.match(hostSource, /activity\.chatSessionId !== target\.sessionId/);
{
  const handlerStart = hostSource.indexOf('handleTogetherListeningNotification');
  const handlerBody = hostSource.slice(handlerStart, handlerStart + 2000);
  assert.match(handlerBody, /target\.notificationAction === 'leave'/);
  assert.match(handlerBody, /leaveTogetherListeningByUser\(\{[\s\S]{0,200}source: 'system_capsule'/);
  assert.match(handlerBody, /router\.navigate\(\s*`\/chat\//, 'open 仍导航到 /chat/<aiId>?sessionId=');
}

assert.doesNotMatch(moduleSource, /openPromotedNotificationSettings/);
assert.doesNotMatch(moduleSource, /ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS/);
assert.doesNotMatch(moduleSource, /POST_PROMOTED_NOTIFICATIONS/);

// 冷启动恢复必须先走 canonical runtime reconciliation，再投影最终 Activity。
assert.match(awarenessSource, /export async function reconcileTogetherListeningSystemPresentation/);
{
  const reconcileStart = awarenessSource.indexOf('reconcileTogetherListeningSystemPresentation');
  const reconcileBody = awarenessSource.slice(reconcileStart, reconcileStart + 1200);
  const captureAt = reconcileBody.indexOf('captureTogetherListeningRuntimeSnapshot');
  const reconcileAt = reconcileBody.indexOf('reconcileTogetherListeningRuntime(snapshot)');
  const projectAt = reconcileBody.indexOf('projectTogetherListeningSystemPresentation');
  assert.ok(captureAt > 0 && reconcileAt > captureAt && projectAt > reconcileAt,
    '冷启动必须先 capture snapshot、canonical reconcile，再投影');
}
assert.doesNotMatch(
  projectionSource,
  /reconcileTogetherListeningSystemPresentation/,
  'projection 层不得绕过 canonical reconciliation 直接恢复 surface',
);

const combinedNewSources = [projectionSource, headlessSource, publisherSource].join('\n');
for (const forbidden of [
  'MediaSessionManager',
  'getActiveSessions',
  'RavenCatOverlayService',
  'SYSTEM_ALERT_WINDOW',
  'ProcessAIReply',
  'runHostAgent',
  'requestProactiveChatReply',
  'scheduleSelfWake',
  'appendExternalAssistantMessage',
]) {
  assert.equal(combinedNewSources.includes(forbidden), false, `LISTEN-7 禁止依赖 ${forbidden}`);
}
assert.doesNotMatch(publisherSource, /title.*artist|artist.*title/i, '无可靠后台事件源时不得展示 volatile 歌曲');

console.log('Together standard ongoing notification、dismissal 与 Headless contract 检查通过。');
