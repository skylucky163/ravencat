package expo.modules.kimiphonenotifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

internal object NotificationResponseEvents {
  val observers = mutableSetOf<(Map<String, Any?>) -> Unit>()

  fun emit(response: Map<String, Any?>): Boolean {
    val currentObservers = synchronized(observers) { observers.toList() }
    currentObservers.forEach { it(response) }
    return currentObservers.isNotEmpty()
  }
}

/**
 * 通知动作广播入口。来电 open/accept 已改为直连 IncomingCallActivity 的
 * Activity PendingIntent，不再经过本 Receiver 启动界面（Android 12+ notification
 * trampoline 禁令）；本 Receiver 继续服务消息通知与来电 reject 的无 UI 路径。
 */
class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val appContext = context.applicationContext
    val type = intent.getStringExtra("type")?.trim().orEmpty()
    val notificationId = intent.getStringExtra("notificationId")?.trim().orEmpty()
    if (type.isEmpty() || notificationId.isEmpty()) return
    val notificationAction = intent.getStringExtra("notificationAction") ?: "open"

    // 聚合 key：新版通知直接携带 conversationKey；升级前展示的旧通知只有 aiId，回退为 `ai:<aiId>`。
    val conversationKey = intent.getStringExtra("conversationKey")?.trim()?.ifEmpty { null }
      ?: intent.getStringExtra("aiId")?.trim()?.ifEmpty { null }?.let { "ai:$it" }
    // 子通知滑走只移除该条；会话摘要滑走或旧合并通知撤销整组。
    val childId = intent.getStringExtra("childId")?.trim()?.ifEmpty { null }

    if (notificationAction == "dismiss") {
      if (type == "together-listening") {
        intent.getStringExtra("activityId")?.trim()?.ifEmpty { null }?.let {
          NotificationStateStore.recordTogetherListeningDismissal(appContext, it)
        }
        return
      }
      if (type == "ai-message" && conversationKey != null) {
        if (childId != null) {
          NotificationPublisher.dismissChild(appContext, conversationKey, childId)
        } else {
          NotificationPublisher.dismissConversation(appContext, conversationKey)
        }
      }
      return
    }

    if (type == "together-listening" && notificationAction == "leave") {
      val response = NotificationResponseDispatcher.buildResponse(intent) ?: return
      // durable 先行：Headless 启动失败时动作也不得丢失，交由 Host 恢复时幂等重放。
      NotificationResponseDispatcher.recordTogetherListeningAction(appContext, response)
      return
    }

    when (type) {
      "ai-message", "ai-message-summary" -> {
        NotificationPublisher.dismissConversation(appContext, conversationKey)
      }
      "ai-incoming-call" -> {
        intent.getStringExtra("callId")?.let {
          NotificationPublisher.dismissIncomingCall(appContext, it)
        }
      }
      "together-listening" -> Unit
    }

    val response = NotificationResponseDispatcher.buildResponse(intent) ?: return

    if (type == "ai-incoming-call") {
      if (notificationAction == "reject") {
        // 拒接保持无 UI Headless 路径，不启动界面。
        NotificationResponseDispatcher.recordCallAction(appContext, response)
      } else {
        // 新版来电通知的 open/accept 已直连 IncomingCallActivity；这里只兜底升级前
        // 遗留通知的广播，仅记录 response 等 Host 消费，不再 startActivity。
        NotificationResponseDispatcher.recordForApp(appContext, response)
      }
      return
    }

    NotificationResponseDispatcher.recordForApp(appContext, response)

    appContext.packageManager.getLaunchIntentForPackage(appContext.packageName)?.let { launchIntent ->
      launchIntent.addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_SINGLE_TOP,
      )
      appContext.startActivity(launchIntent)
    }
  }
}
