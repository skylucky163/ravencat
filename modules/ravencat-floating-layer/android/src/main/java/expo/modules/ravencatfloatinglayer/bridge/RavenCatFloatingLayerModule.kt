package expo.modules.ravencatfloatinglayer.bridge

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.androidoverlayruntime.OverlayPermissionGateway
import expo.modules.androidoverlayruntime.OverlayPositionStore
import expo.modules.ravencatfloatinglayer.BubbleSkinStore
import expo.modules.ravencatfloatinglayer.retireLegacySelfWakeProjection
import expo.modules.ravencatfloatinglayer.RavenCatCompanionWakeStore
import expo.modules.ravencatfloatinglayer.RavenCatAIScheduleProjection
import expo.modules.ravencatfloatinglayer.RavenCatAIScheduleScheduler
import expo.modules.ravencatfloatinglayer.RavenCatAIScheduleStore
import expo.modules.ravencatfloatinglayer.RavenCatFloatingMessageTaskStore
import expo.modules.ravencatfloatinglayer.RavenCatTogetherListeningPresentationStore
import expo.modules.ravencatfloatinglayer.companion.RavenCatCompanionExecutionHost
import expo.modules.backgroundruntime.BackgroundRuntime
import expo.modules.ravencatfloatinglayer.companion.RavenCatCompanionWakeDispatcher
import expo.modules.ravencatfloatinglayer.model.RavenCatTogetherListeningPresentation
import expo.modules.ravencatfloatinglayer.runtime.RavenCatOverlayRuntime
import expo.modules.ravencatfloatinglayer.service.RavenCatOverlayService
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private class OpenOverlaySettingsException(cause: Exception) :
  CodedException("Unable to open RavenCat overlay permission settings", cause)

private class OverlayPermissionMissingException :
  CodedException("RavenCat overlay permission is not granted. Open overlay permission settings before starting the floating layer.")

private class FloatingLayerUnavailableException :
  CodedException("RavenCat floating service is running but the floating bubble is unavailable.")

private class OpenBatteryOptimizationSettingsException(cause: Exception) :
  CodedException("Unable to open battery optimization settings", cause)

class RavenCatFloatingLayerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RavenCatFloatingLayer")
    Events(
      "onSendMessage",
      "onCaptureScreenRequest",
      "onExpand",
      "onCollapse",
      "onCompanionWake",
      "onCompanionExecutionCancel",
      "onConversationDisplayed",
      "onConversationRefresh",
    )

    OnCreate {
      val context = appContext.reactContext
      // native foreground fail-safe 在模块加载时安装（进程级、幂等）：
      // JS 线程之后即使崩溃，Activity resume 仍能抑制 overlay。
      (context?.applicationContext as? Application)?.let {
        RavenCatOverlayRuntime.installAppForegroundFailSafe(it)
      }
      RavenCatCompanionWakeDispatcher.setListener(context) { event ->
        sendEvent(
          "onCompanionWake",
          mapOf(
            "wakeReason" to event.wakeReason,
            "source" to event.source,
            "eventId" to event.eventId,
            "createdAtEpochMs" to event.createdAtEpochMs,
            "scheduleRevision" to event.scheduleRevision,
            "hostAIId" to event.hostAIId,
            "triggerKind" to event.triggerKind,
            "expectedRemindAtEpochMs" to event.expectedRemindAtEpochMs,
            "projectionToken" to event.projectionToken,
            "deliveryEventId" to event.deliveryEventId,
          ),
        )
      }
      // execution host 超时收口 → runner 取消请求：native → JS 的唯一取消通道。
      RavenCatCompanionWakeDispatcher.setExecutionCancelListener { deliveryEventId ->
        sendEvent(
          "onCompanionExecutionCancel",
          mapOf("deliveryEventId" to deliveryEventId),
        )
      }
      RavenCatOverlayRuntime.conversationDisplayedListener = { sessionId, messageIds ->
        sendEvent("onConversationDisplayed", mapOf(
          "sessionId" to sessionId,
          "messageIds" to messageIds.map { it.toString() },
        ))
      }
      RavenCatOverlayRuntime.conversationRefreshListener = {
        sendEvent("onConversationRefresh", emptyMap<String, Any>())
      }
    }

    OnDestroy {
      (appContext.reactContext?.applicationContext as? Application)?.let {
        RavenCatOverlayRuntime.uninstallAppForegroundFailSafe(it)
      }
      RavenCatCompanionWakeDispatcher.setListener(null, null)
      RavenCatCompanionWakeDispatcher.setExecutionCancelListener(null)
      RavenCatOverlayRuntime.conversationDisplayedListener = null
      RavenCatOverlayRuntime.conversationRefreshListener = null
    }

    AsyncFunction("ping") {
      "pong from RavenCatFloatingLayer"
    }

    AsyncFunction("isOverlayPermissionGranted") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

      OverlayPermissionGateway.isGranted(context)
    }

    AsyncFunction("openOverlayPermissionSettings") {
      val activity = appContext.throwingActivity
      try {
        OverlayPermissionGateway.openSettings(activity)
      } catch (error: Exception) {
        throw OpenOverlaySettingsException(error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getBatteryOptimizationState") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager

      mapOf(
        "ignoringBatteryOptimizations" to powerManager.isIgnoringBatteryOptimizations(
          context.packageName,
        ),
      )
    }

    AsyncFunction("openBatteryOptimizationSettings") {
      val activity = appContext.throwingActivity
      try {
        activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
      } catch (error: Exception) {
        throw OpenBatteryOptimizationSettingsException(error)
      }
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      val activity = appContext.throwingActivity
      val powerManager = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
      if (powerManager.isIgnoringBatteryOptimizations(activity.packageName)) {
        return@AsyncFunction null
      }

      val intent = Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:${activity.packageName}"),
      )
      try {
        activity.startActivity(intent)
      } catch (error: Exception) {
        throw OpenBatteryOptimizationSettingsException(error)
      }
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("startFloatingLayer") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

      if (!OverlayPermissionGateway.isGranted(context)) {
        throw OverlayPermissionMissingException()
      }

      if (RavenCatOverlayService.isRunning) {
        if (!RavenCatOverlayRuntime.showBubble()) {
          throw FloatingLayerUnavailableException()
        }
        return@AsyncFunction null
      }

      val intent = Intent(context, RavenCatOverlayService::class.java)
      context.startForegroundService(intent)
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopFloatingLayer") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(context, RavenCatOverlayService::class.java)
      context.stopService(intent)
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("isFloatingLayerRunning") {
      RavenCatOverlayService.isRunning
    }

    /** Host 的 AppState 真值只改变 overlay visibility，不改变 Service ownership。 */
    AsyncFunction("setAppForeground") { active: Boolean ->
      RavenCatOverlayRuntime.setAppForeground(active)
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getNativeHealth") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val scheduled = RavenCatAIScheduleScheduler.list(context)
      val wakeStatus = RavenCatCompanionWakeStore.status(context)
      val schedulerActive = scheduled.isNotEmpty()
      mapOf(
        "floatingServiceRunning" to RavenCatOverlayService.isRunning,
        // Overlay FGS 属于 Floating Interaction：字段名必须显式表达 owner，
        // 不得再被读成「本地伴随前台服务」。
        "overlayForegroundServiceRunning" to RavenCatOverlayService.isForegroundRunning,
        "visibleLivenessIndicatorRunning" to RavenCatOverlayService.isRunning,
        "applicationBackgroundRunning" to BackgroundRuntime.isRunning,
        "companionRuntimeRunning" to schedulerActive,
        "companionSchedulerActive" to schedulerActive,
        "companionSchedulerDriver" to if (schedulerActive) "alarm_manager+one_time_work" else "none",
        // 保留旧字段供已持久化的诊断状态平滑迁移；真实含义已是系统调度器状态。
        "companionWakeTimerActive" to schedulerActive,
        "bridgeConnected" to RavenCatCompanionWakeDispatcher.isBridgeConnected,
        "eventListenerConnected" to RavenCatCompanionWakeDispatcher.isBridgeConnected,
        "companionWakeScheduled" to schedulerActive,
        "nextCompanionWakeAtEpochMs" to (scheduled.minOfOrNull { it.expectedRemindAtEpochMs } ?: 0L),
        "lastNativeWakeAtEpochMs" to wakeStatus.lastNativeWakeAtEpochMs,
        "lastNativeWakeReason" to wakeStatus.lastNativeWakeReason,
        "lastNativeWakeSource" to wakeStatus.lastNativeWakeSource,
        "lastNativeWakeBridgeConnected" to wakeStatus.lastNativeWakeBridgeConnected,
        "lastHeadlessTaskStartAtEpochMs" to wakeStatus.lastHeadlessTaskStartAtEpochMs,
        "lastHeadlessTaskStartAccepted" to wakeStatus.lastHeadlessTaskStartAccepted,
        "lastHeadlessTaskStartError" to wakeStatus.lastHeadlessTaskStartError,
        "lastRunnerCompletionAtEpochMs" to wakeStatus.lastRunnerCompletionAtEpochMs,
        // runner 终态回执的 identity 是 delivery identity，不是 resolved eventId。
        "lastRunnerCompletionDeliveryEventId" to
          wakeStatus.lastRunnerCompletionDeliveryEventId,
        "lastRunnerCompletionSucceeded" to wakeStatus.lastRunnerCompletionSucceeded,
        "lastRunnerCompletionError" to wakeStatus.lastRunnerCompletionError,
        "lastCompanionExecutionAtEpochMs" to wakeStatus.lastExecutionAtEpochMs,
        "lastCompanionExecutionOutcome" to wakeStatus.lastExecutionOutcome,
        "lastCompanionExecutionDeliveryEventId" to wakeStatus.lastExecutionDeliveryEventId,
        "lastCompanionExecutionForegroundRunning" to wakeStatus.lastExecutionForegroundRunning,
        "pendingNativeWakeCount" to wakeStatus.pendingNativeWakeCount,
        "lastPendingWakeAtEpochMs" to wakeStatus.lastPendingWakeAtEpochMs,
      )
    }

    AsyncFunction("getAIScheduleDiagnostics") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      val packageInfo = context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0L))
      mapOf(
        "device" to mapOf(
          "manufacturer" to Build.MANUFACTURER,
          "model" to Build.MODEL,
          "apiLevel" to Build.VERSION.SDK_INT,
          "packageName" to context.packageName,
          "versionName" to packageInfo.versionName,
          "versionCode" to packageInfo.longVersionCode,
          "deviceIdleMode" to power.isDeviceIdleMode,
          "powerSaveMode" to power.isPowerSaveMode,
          "batteryOptimizationExempt" to power.isIgnoringBatteryOptimizations(context.packageName),
        ),
        "companionSchedulingEnabled" to RavenCatAIScheduleStore.isEnabled(context),
        "events" to RavenCatCompanionWakeStore.scheduleDiagnostics(context),
      )
    }

    AsyncFunction("setCompanionSchedulingEnabled") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      RavenCatAIScheduleScheduler.setEnabled(context, enabled)
      null
    }

    AsyncFunction("scheduleAIScheduleTrigger") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val projection = RavenCatAIScheduleScheduler.schedule(
        context = context,
        projection = RavenCatAIScheduleProjection(
          scheduleId = payload["scheduleId"] as String,
          ownerAIId = payload["ownerAIId"] as String,
          expectedRemindAtEpochMs = (payload["remindAtEpochMs"] as Number).toLong(),
          projectionToken = payload["projectionToken"] as String,
        ),
      )
      mapOf(
        "scheduleId" to projection.scheduleId,
        "ownerAIId" to projection.ownerAIId,
        "expectedRemindAtEpochMs" to projection.expectedRemindAtEpochMs,
        "projectionToken" to projection.projectionToken,
      )
    }

    AsyncFunction("cancelAIScheduleTrigger") { scheduleId: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      RavenCatAIScheduleScheduler.cancel(context, scheduleId)
      null
    }

    AsyncFunction("listAIScheduleTriggerProjections") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      RavenCatAIScheduleScheduler.list(context).map { projection ->
        mapOf(
          "scheduleId" to projection.scheduleId,
          "ownerAIId" to projection.ownerAIId,
          "expectedRemindAtEpochMs" to projection.expectedRemindAtEpochMs,
          "projectionToken" to projection.projectionToken,
        )
      }
    }

    AsyncFunction("recordCompanionRunnerCompletion") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      // 回执 key 是 delivery identity（AI Schedule 为 `eventId@projectionToken`），不是
      // resolved eventId：两者混淆会让 completion 去重与 execution host 完成信号同时失配。
      val deliveryEventId = payload["deliveryEventId"] as String
      RavenCatCompanionWakeStore.recordRunnerCompletion(
        context = context,
        deliveryEventId = deliveryEventId,
        succeeded = payload["succeeded"] as Boolean,
        error = payload["error"] as? String,
      )
      // runner 终态回执是 execution host 唯一的完成信号：落盘后必须立即释放执行生命周期。
      RavenCatCompanionExecutionHost.signalRunnerCompletion(deliveryEventId)
      null
    }

    /**
     * Headless runner 启动后主动消费本次 delivery 的取消标记（一次性）。
     *
     * 取消事实由 native 拥有：runner 可能晚于取消请求才注册自己的 `AbortController`
     * （JS 冷启动 / runtime 重建 / 任务尚未派发），此时 `onCompanionExecutionCancel`
     * 事件叫不到任何 controller，只能靠这里追平。
     */
    AsyncFunction("consumeCompanionExecutionCancellation") { deliveryEventId: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      RavenCatCompanionWakeStore.consumeExecutionCancellation(context, deliveryEventId)
    }

    AsyncFunction("recordFloatingMessageTaskCompletion") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      RavenCatFloatingMessageTaskStore.recordCompletion(
        context = context,
        correlationId = payload["correlationId"] as String,
        succeeded = payload["succeeded"] as Boolean,
        error = payload["error"] as? String,
      )
      null
    }

    AsyncFunction("getBubbleSkins") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val store = BubbleSkinStore(context)
      val selectedId = store.selectedId()
      store.list().map { it.toMap(selectedId) }
    }

    AsyncFunction("getBubbleSkinBackupSource") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val store = BubbleSkinStore(context)
      mapOf("rootUri" to store.backupRootUri(), "settingsJson" to store.exportBackupStrict())
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("restoreBubbleSkinBackupSettings") { settingsJson: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      BubbleSkinStore(context).restoreBackup(settingsJson)
      RavenCatOverlayRuntime.refreshBubbleSkin()
      null
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("validateBubbleSkinBackupSettings") { settingsJson: String, rootUri: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      BubbleSkinStore(context).validateBackup(settingsJson, rootUri)
      null
    }.runOnQueue(Queues.DEFAULT)

    AsyncFunction("importBubbleSkin") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val store = BubbleSkinStore(context)
      val skin = store.import(
        uriText = payload["uri"] as String,
        fileName = payload["fileName"] as String,
        mimeType = payload["mimeType"] as? String,
        displayName = payload["name"] as String,
      )
      RavenCatOverlayRuntime.refreshBubbleSkin()
      skin.toMap(store.selectedId())
    }

    AsyncFunction("renameBubbleSkin") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val store = BubbleSkinStore(context)
      store.rename(payload["id"] as String, payload["name"] as String)
        .toMap(store.selectedId())
    }

    AsyncFunction("updateBubbleSkinImage") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val store = BubbleSkinStore(context)
      val skin = store.updateImage(
        id = payload["id"] as String,
        form = payload["form"] as String,
        uriText = payload["uri"] as String,
        fileName = payload["fileName"] as String,
        mimeType = payload["mimeType"] as? String,
      )
      RavenCatOverlayRuntime.refreshBubbleSkin()
      skin.toMap(store.selectedId())
    }

    AsyncFunction("setBubbleSize") { id: String, sizeDp: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val store = BubbleSkinStore(context)
      val skin = store.setSizeDp(id, sizeDp)
      RavenCatOverlayRuntime.refreshBubbleSkin()
      skin.toMap(store.selectedId())
    }

    AsyncFunction("deleteBubbleSkin") { id: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      BubbleSkinStore(context).delete(id)
      RavenCatOverlayRuntime.refreshBubbleSkin()
      null
    }

    AsyncFunction("selectBubbleSkin") { id: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val store = BubbleSkinStore(context)
      val skin = store.select(id)
      RavenCatOverlayRuntime.refreshBubbleSkin()
      skin.toMap(store.selectedId())
    }

    AsyncFunction("expand") {
      RavenCatOverlayRuntime.expand()
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("collapse") {
      RavenCatOverlayRuntime.collapse()
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("restoreAfterScreenCapture") {
      RavenCatOverlayRuntime.restoreScreenshotWithoutRequestIdentity()
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("completeScreenCaptureVisibility") { payload: Map<String, Any?> ->
      RavenCatOverlayRuntime.completeScreenshot(
        requestId = payload["correlationId"] as String,
        succeeded = payload["succeeded"] as Boolean,
        screenshotUri = payload["screenshotUri"] as? String,
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("updateReplyPreview") { payload: Map<String, Any?> ->
      val text = payload["text"] as? String ?: ""
      val status = payload["status"] as? String
      val correlationId = payload["correlationId"] as? String
      RavenCatOverlayRuntime.updateReplyPreview(
        text, status, correlationId, payload["sessionId"] as? String, (payload["messageId"] as? Number)?.toLong(),
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("updateConversationPreview") { payload: RavenCatConversationPreviewRecord ->
      RavenCatOverlayRuntime.updateConversationPreview(payload.sessionId, payload.messages.map { it.toOverlayMessage() })
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearReplyPreview") {
      RavenCatOverlayRuntime.clearReplyPreview()
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("updateTargetPreview") { payload: Map<String, Any?> ->
      val title = payload["title"] as? String ?: ""
      val subtitle = payload["subtitle"] as? String
      val status = payload["status"] as? String
      RavenCatOverlayRuntime.updateTargetPreview(title, subtitle, status)
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearTargetPreview") {
      RavenCatOverlayRuntime.clearTargetPreview()
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("updateTogetherListeningPresentation") { payload: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      RavenCatOverlayRuntime.updateTogetherListeningPresentation(
        context = context,
        presentation = RavenCatTogetherListeningPresentation(
          activityId = payload["activityId"] as String,
          hostAiId = payload["hostAiId"] as String,
          chatSessionId = payload["chatSessionId"] as String,
          activatedAtEpochMs = (payload["activatedAtEpochMs"] as Number).toLong(),
          aiName = payload["aiName"] as String,
          aiAvatar = payload["aiAvatar"] as? String,
          userName = payload["userName"] as String,
          userAvatar = payload["userAvatar"] as? String,
        ),
      )
      null
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearTogetherListeningPresentation") { activityId: String? ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      RavenCatOverlayRuntime.clearTogetherListeningPresentation(context, activityId)
      null
    }.runOnQueue(Queues.MAIN)

    /**
     * 恢复出厂：清空全部 RavenCat 原生持久化状态（装扮、wake、悬浮任务、调度镜像、悬浮窗位置）。
     * 调用前 JS 已停止悬浮层，并排空日程投影修复；本入口清理原生定时任务与 store。
     */
    AsyncFunction("clearNativeDataForFactoryReset") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

      // JS 已关闭悬浮层；原生日程与旧镜像在本入口统一清理。
      BubbleSkinStore(context).clearAllForFactoryReset()
      RavenCatCompanionWakeStore.clearAllForFactoryReset(context)
      RavenCatFloatingMessageTaskStore.clearAllForFactoryReset(context)
      retireLegacySelfWakeProjection(context)
      RavenCatAIScheduleScheduler.clearStoredStateForFactoryReset(context)
      OverlayPositionStore(context).clearAllForFactoryReset()
      RavenCatTogetherListeningPresentationStore.clearAllForFactoryReset(context)

      null
    }.runOnQueue(Queues.DEFAULT)
  }

}
