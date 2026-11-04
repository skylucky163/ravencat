package expo.modules.kimiphonenotifications
import expo.modules.backgroundruntime.ApplicationExecutionHost

import android.content.Context
import android.content.Intent

/**
 * 通知 response 记录的唯一入口：构造 response、先落 durable pending 队列、再尝试内存交付。
 * 由 NotificationActionReceiver（广播路径）与 IncomingCallActivity（直接 Activity 路径）共用，
 * 避免来电壳复制第二份 response 构造/入队逻辑。
 *
 * 核心原则：native action 不得只依赖一次内存事件交付；前台 observer 在线时交付成功才出队，
 * 否则 pending 队列保留到 Host 下次启动/恢复消费。
 */
internal object NotificationResponseDispatcher {
  /** 从携带通知 payload 的 Intent 构造 response；缺少 type/notificationId 时返回 null。 */
  fun buildResponse(intent: Intent, notificationActionOverride: String? = null): Map<String, Any?>? {
    val type = intent.getStringExtra("type")?.trim().orEmpty()
    val notificationId = intent.getStringExtra("notificationId")?.trim().orEmpty()
    if (type.isEmpty() || notificationId.isEmpty()) return null
    // 渲染来电壳的 intent action 是 open；壳内按钮必须显式覆盖为自己的 action，
    // 否则 Host 会把接听/拒绝误当作 open（不执行 acceptCall/rejectCall）。
    val notificationAction = notificationActionOverride
      ?: intent.getStringExtra("notificationAction") ?: "open"

    val response = mutableMapOf<String, Any?>(
      "type" to type,
      "notificationId" to notificationId,
      "notificationAction" to notificationAction,
    )
    listOf(
      "aiId",
      "aiName",
      "sessionId",
      "callId",
      "deliveryKind",
      "triggerSource",
      "relatedEntityId",
      "latestAiId",
      "conversationKey",
      "conversationKind",
      "groupId",
      "activityId",
      "hostAiId",
      "chatSessionId",
    ).forEach { key ->
      intent.getStringExtra(key)?.let { response[key] = it }
    }
    if (intent.hasExtra("lastMessageAt")) {
      response["lastMessageAt"] = intent.getLongExtra("lastMessageAt", 0L)
    }
    return response
  }

  /**
   * open/accept：先落 pending 队列保证冷启动可消费，JS observer 已在线则同步交付并出队。
   * 是否把用户带回 App 由调用方决定（Receiver 的 trampoline 已由直接 Activity PendingIntent 取代）。
   */
  fun recordForApp(context: Context, response: Map<String, Any?>) {
    val responseId = NotificationStateStore.enqueueResponse(context, response)
    if (NotificationResponseEvents.emit(response)) {
      NotificationStateStore.removePendingResponse(context, responseId)
    }
  }

  /**
   * reject：先持久化 response —— native action 不得只依赖一次内存事件交付。
   * 前台 notification observer 在线：交 Host 处理（rejectCall + 聊天时间线对账）并出队；
   * 前台不在线：交共享应用宿主执行 rejectCall()，但保留 pending response，
   * Host 下次启动/恢复消费时 rejectCall() 幂等 no-op，并刷新聊天时间线完成跨 runtime 对账。
   */
  fun recordCallAction(context: Context, response: Map<String, Any?>) {
    val responseId = NotificationStateStore.enqueueResponse(context, response)
    if (NotificationResponseEvents.emit(response)) {
      NotificationStateStore.removePendingResponse(context, responseId)
      return
    }
    ApplicationExecutionHost.post(context, "call_action", response, 30_000L)
  }

  /**
   * together-listening leave：与来电 reject 同级的 durable 语义。先落 pending 队列，
   * 保证运行环境未能建立或请求未执行时用户动作不丢失；
   * 前台 observer 在线则交付 Host 执行 canonical leave 并出队，否则交共享应用宿主。
   * 执行成功后 pending response 保留，Host 下次恢复消费时 canonical leave 幂等 no-op。
   */
  fun recordTogetherListeningAction(context: Context, response: Map<String, Any?>) {
    val responseId = NotificationStateStore.enqueueResponse(context, response)
    if (NotificationResponseEvents.emit(response)) {
      NotificationStateStore.removePendingResponse(context, responseId)
      return
    }
    ApplicationExecutionHost.post(context, "together_action", response, 30_000L)
  }
}
