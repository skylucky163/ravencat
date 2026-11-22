package expo.modules.kimiphonenotifications

import expo.modules.androidoverlayruntime.CallPresentationReturn
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

class KimiPhoneNotificationsModule : Module() {
  private var responseObserver: ((Map<String, Any?>) -> Unit)? = null
  private var arrivalObserver: ((Map<String, Any?>) -> Unit)? = null
  private val ownedArrivalIds = mutableSetOf<Long>()
  private val ownedTurnDisplays = mutableSetOf<String>()

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val permissionsManager: Permissions
    get() = appContext.permissions ?: throw Exceptions.PermissionsModuleNotFound()

  override fun definition() = ModuleDefinition {
    Name("KimiPhoneNotifications")

    Events("onNotificationResponse", "onMessageArrivalChanged")

    OnStartObserving("onMessageArrivalChanged") {
      val weakModule = WeakReference(this@KimiPhoneNotificationsModule)
      val observer: (Map<String, Any?>) -> Unit = { event ->
        weakModule.get()?.sendEvent("onMessageArrivalChanged", event)
      }
      synchronized(MessageArrivalProgress.observers) {
        MessageArrivalProgress.observers.add(observer)
      }
      arrivalObserver = observer
    }

    OnStopObserving("onMessageArrivalChanged") {
      removeArrivalObserver()
    }

    OnStartObserving("onNotificationResponse") {
      val weakModule = WeakReference(this@KimiPhoneNotificationsModule)
      val observer: (Map<String, Any?>) -> Unit = { response ->
        weakModule.get()?.sendEvent("onNotificationResponse", response)
      }
      synchronized(NotificationResponseEvents.observers) {
        NotificationResponseEvents.observers.add(observer)
      }
      responseObserver = observer
    }

    OnStopObserving("onNotificationResponse") {
      removeResponseObserver()
    }

    OnDestroy {
      removeResponseObserver()
      removeArrivalObserver()
      // runtime 已销毁时，不能把它已提交的消息留在进程内的隐藏投影里。
      val messageIds = synchronized(ownedArrivalIds) {
        ownedArrivalIds.toList().also { ownedArrivalIds.clear() }
      }
      MessageArrivalProgress.finish(messageIds)
      synchronized(ownedTurnDisplays) {
        ownedTurnDisplays.forEach { MessageArrivalProgress.setTurnDisplayActive(it, false) }
        ownedTurnDisplays.clear()
      }
    }

    AsyncFunction("getMessageArrivalSnapshot") { MessageArrivalProgress.snapshot() }

    AsyncFunction("awaitTurnDisplayArrival") Coroutine { runId: String, conversationKey: String ->
      MessageArrivalProgress.awaitTurnDisplay(runId, conversationKey)
    }
    AsyncFunction("setTurnDisplayOpen") { runIds: List<String>, open: Boolean ->
      MessageArrivalProgress.setTurnDisplayOpen(runIds, open)
    }
    AsyncFunction("setTurnDisplayActive") { runId: String, active: Boolean ->
      synchronized(ownedTurnDisplays) {
        if (active) ownedTurnDisplays.add(runId) else ownedTurnDisplays.remove(runId)
        MessageArrivalProgress.setTurnDisplayActive(runId, active)
      }
    }

    AsyncFunction("beginMessageArrival") { observer: Map<String, Any?>, messageIds: List<Long> ->
      require(observer["sessionId"] is String && messageIds.isNotEmpty() && messageIds.all { it > 0L })
      synchronized(ownedArrivalIds) { ownedArrivalIds.addAll(messageIds) }
      MessageArrivalProgress.begin(observer, messageIds)
    }

    AsyncFunction("awaitMessageArrival") Coroutine { conversationKey: String, messageId: Long ->
      require(conversationKey.isNotEmpty() && messageId > 0L)
      MessageArrivalProgress.awaitArrival(conversationKey, messageId)
    }

    AsyncFunction("finishMessageArrival") { messageIds: List<Long> ->
      synchronized(ownedArrivalIds) { ownedArrivalIds.removeAll(messageIds.toSet()) }
      MessageArrivalProgress.finish(messageIds)
    }

    AsyncFunction("requestNotificationPermission") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        permissionsManager,
        promise,
        Manifest.permission.POST_NOTIFICATIONS,
      )
    }

    AsyncFunction("getNotificationPermissionStatus") {
      NotificationPublisher.permissionStatus(context)
    }

    AsyncFunction("postConversationNotification") Coroutine { payload: Map<String, Any?> ->
      NotificationPublisher.postConversation(context, payload)
    }

    AsyncFunction("postIncomingCallNotification") { payload: Map<String, Any?> ->
      val reactContext = (appContext.reactContext ?: throw Exceptions.ReactContextLost()) as ReactContext
      val activity = if (reactContext.lifecycleState == LifecycleState.RESUMED) appContext.currentActivity else null
      NotificationPublisher.postIncomingCall(reactContext, payload, activity)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

    AsyncFunction("upsertTogetherListeningPresentation") { payload: Map<String, Any?> ->
      NotificationPublisher.permissionStatus(context) +
        NotificationPublisher.upsertTogetherListening(context, payload)
    }

    AsyncFunction("cancelTogetherListeningPresentation") { activityId: String? ->
      NotificationPublisher.dismissTogetherListening(context, activityId)
      null
    }

    AsyncFunction("getTogetherListeningPresentationDiagnostics") {
      NotificationPublisher.permissionStatus(context) +
        NotificationPublisher.togetherListeningDiagnostics(context)
    }

    /** 按会话聚合 key 撤销：direct = `ai:<aiId>`，group = `group:<groupId>`；null 撤销全部。 */
    AsyncFunction("cancelConversationNotifications") { conversationKey: String? ->
      NotificationPublisher.dismissConversation(context, conversationKey)
      null
    }

    AsyncFunction("cancelIncomingCallNotification") { callId: String ->
      NotificationPublisher.dismissIncomingCall(context, callId)
      null
    }

    AsyncFunction("cancelReadMessageNotifications") { sessionId: String, messageIds: List<String>, clientMessageIds: List<String> ->
      NotificationPublisher.dismissReadMessages(context, sessionId, messageIds, clientMessageIds)
      null
    }

    AsyncFunction("leaveCallScreen") { callId: String ->
      CallPresentationReturn.leave(callId, appContext.currentActivity)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

    AsyncFunction("consumePendingNotificationResponses") {
      NotificationStateStore.consumePendingResponses(context)
    }

    AsyncFunction("getNotificationDiagnostics") { scopeKey: String? ->
      val status = NotificationPublisher.permissionStatus(context)
      val diagnostics = NotificationStateStore.readDiagnostics(context, scopeKey)
      status + diagnostics + mapOf(
        "channelId" to NotificationChannelRegistry.MESSAGE_CHANNEL_ID,
      )
    }

    /**
     * 显式用户操作：Android 14+ 打开本应用的 full-screen intent 系统授权页。
     * 不得在启动或授权关闭时自动调用；API < 34 无此系统页面，返回 false。
     */
    AsyncFunction("openFullScreenIntentSettings") {
      if (Build.VERSION.SDK_INT < 34) {
        return@AsyncFunction false
      }
      val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      true
    }

    /**
     * 显式用户操作：打开来电 Channel 的系统通知设置页，便于检查 OEM 的锁屏/悬浮通知开关。
     * 不得自动调用；不更换 Channel ID，不绕过或重置用户已有配置。
     */
    AsyncFunction("openIncomingCallNotificationSettings") {
      NotificationChannelRegistry.ensureChannels(context)
      val intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
        putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        putExtra(Settings.EXTRA_CHANNEL_ID, NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      true
    }

    /**
     * 恢复出厂：取消全部已展示通知并清空原生通知状态。
     * 不删除 Notification Channel，也不修改权限。
     */
    AsyncFunction("clearNativeNotificationDataForFactoryReset") {
      MessageArrivalProgress.clear()
      NotificationManagerCompat.from(context).cancelAll()
      NotificationStateStore.clearAllForFactoryReset(context)
      null
    }
  }

  private fun removeArrivalObserver() {
    val observer = arrivalObserver ?: return
    synchronized(MessageArrivalProgress.observers) {
      MessageArrivalProgress.observers.remove(observer)
    }
    arrivalObserver = null
  }

  private fun removeResponseObserver() {
    val observer = responseObserver ?: return
    synchronized(NotificationResponseEvents.observers) {
      NotificationResponseEvents.observers.remove(observer)
    }
    responseObserver = null
  }
}
