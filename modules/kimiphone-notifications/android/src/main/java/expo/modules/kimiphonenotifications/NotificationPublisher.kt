package expo.modules.kimiphonenotifications

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.absoluteValue
import expo.modules.callringtone.CallRingtonePlayback

internal object NotificationPublisher {
  // 子通知/摘要 displayId 前缀：与 TS 侧 Notification.ts 的拼接规则保持一致，撤销时按同规则还原。
  private const val CHILD_DISPLAY_ID_PREFIX = "kimiphone-msg-"
  private const val SUMMARY_DISPLAY_ID_PREFIX = "kimiphone-sum-"
  /** 来电发布诊断的固定 scope：getNotificationDiagnostics('incoming-call') 读取。 */
  private const val INCOMING_CALL_DIAGNOSTICS_SCOPE = "incoming-call"
  const val TOGETHER_LISTENING_DISPLAY_ID = "together-listening-live"
  private const val MAX_BODY_LENGTH = 120
  private val conversationPostMutexes = ConcurrentHashMap<String, Mutex>()
  private val conversationOperationLocks = ConcurrentHashMap<String, Any>()
  private val conversationOperationGate = ReentrantReadWriteLock(true)
  private val conversationStateLock = Any()

  fun permissionStatus(context: Context): Map<String, Any?> {
    // 诊断只读系统事实；创建 channel 由发布准入负责，不能在每次前台对账时修改系统通知。
    return mapOf(
      "postNotificationsGranted" to hasPostNotificationsPermission(context),
      "notificationsEnabled" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
      "messageChannelImportance" to NotificationChannelRegistry.importance(
        context,
        NotificationChannelRegistry.MESSAGE_CHANNEL_ID,
      ),
      "incomingCallChannelImportance" to NotificationChannelRegistry.importance(
        context,
        NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID,
      ),
      // 实际 Channel 的锁屏可见性：OEM 可能在系统页单独关闭锁屏/悬浮通知，排障必须能看到真实值。
      "incomingCallChannelLockscreenVisibility" to NotificationChannelRegistry.lockscreenVisibility(
        context,
        NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID,
      ),
      // Android 14+ 用户可关闭 full-screen intent；false 是正常 fallback，不算通知失败。
      "fullScreenIntentAllowed" to NotificationManagerCompat.from(context).canUseFullScreenIntent(),
    )
  }

  suspend fun postConversation(
    context: Context,
    payload: Map<String, Any?>,
  ): Map<String, Any?> {
    val aiId = payload.requiredString("aiId")
    val aiName = payload.requiredString("aiName")
    val message = payload.requiredString("message").truncateBody()
    val displayId = payload.requiredString("displayId")
    val scopeKey = payload.optionalString("scopeKey")
    val sessionId = payload.optionalString("sessionId")
    // 聚合维度：群聊 conversationKey = `group:<groupId>`，单聊缺省 `ai:<aiId>`。
    val conversationKey = payload.optionalString("conversationKey") ?: "ai:$aiId"
    val conversationKind = payload.optionalString("conversationKind")
    val groupId = payload.optionalString("groupId")
    val conversationTitle = payload.optionalString("conversationTitle") ?: aiName
    val senderName = payload.optionalString("senderName") ?: aiName
    val senderAvatar = payload.optionalString("senderAvatar")
    // eventId 逐段唯一（TS 侧 logicalMessageId:segmentIndex），同 eventId 重发幂等更新同一条子通知。
    val eventId = payload.optionalString("eventId") ?: displayId
    val result = preflight(
      context = context,
      channelId = NotificationChannelRegistry.MESSAGE_CHANNEL_ID,
      displayId = displayId,
    )
    if (result != null) {
      NotificationStateStore.recordDiagnostics(
        context,
        scopeKey,
        aiId,
        sessionId,
        false,
        result["status"] as String,
      )
      return result
    }

    val conversationMutex = conversationPostMutexes.computeIfAbsent(conversationKey) { Mutex() }
    return conversationMutex.withLock {
      conversationOperationGate.readLock().lock()
      try {
        return@withLock MessageArrivalProgress.publishTurn(payload.optionalString("turnRunId"),
          postResult("cancelled", false, displayId, "turn_display_interrupted")) {
          synchronized(conversationOperationLock(conversationKey)) {
          val (legacyDisplayIds, upsert) = synchronized(conversationStateLock) {
            // 升级前展示的合并形态通知（全应用汇总 + 每会话合并）一次性清理，避免新旧并存。
            val legacyDisplayIds = NotificationStateStore.consumeLegacyMergedNotificationCleanup(context).orEmpty()
            val now = System.currentTimeMillis()
            val upsert = NotificationStateStore.upsertConversation(
              context = context,
              conversationKey = conversationKey,
              conversationTitle = conversationTitle,
              conversationKind = conversationKind,
              groupId = groupId,
              aiId = aiId,
              senderName = senderName,
              senderAvatar = senderAvatar,
              sessionId = sessionId,
              deliveryKind = payload.optionalString("deliveryKind") ?: "passive",
              triggerSource = payload.optionalString("triggerSource"),
              relatedEntityId = payload.optionalString("relatedEntityId"),
              childId = eventId,
              message = message,
              lastMessageAt = now,
              committedMessageId = (payload["committedMessageId"] as? Number)?.toLong(),
            )
            legacyDisplayIds to upsert
          }
          val state = upsert.state
          val manager = NotificationManagerCompat.from(context)
          // 这些 cancel 不读改写 SharedPreferences，可在全局状态锁外执行。
          legacyDisplayIds.forEach { legacyId ->
            manager.cancel(legacyId.toNotificationId())
          }
          // 超出上限的最旧子通知同步下线。
          upsert.evictedChildIds.forEach { evictedChildId ->
            manager.cancel(childDisplayId(conversationKey, evictedChildId).toNotificationId())
          }

          // 构建通知可能读取头像文件，不把文件 IO 放进全局状态锁。
          val childAvatar = loadBitmap(context, payload.optionalString("aiAvatar") ?: state.senderAvatar)
          val summaryAvatar = loadBitmap(context, state.senderAvatar)
          // 每段消息一条独立子通知：独立 ID、各自响铃；群聊标题用发送者名，单聊用 AI 名。
          val childResponseData = conversationResponseData(
            payload,
            displayId,
            state.lastMessageAt,
            "ai-message",
          ) + mapOf("childId" to eventId)
          val notification = NotificationCompat.Builder(
            context,
            NotificationChannelRegistry.MESSAGE_CHANNEL_ID,
          )
            .setSmallIcon(resolveSmallIcon(context))
            .setContentTitle(if (conversationKind == "group") senderName else state.conversationTitle)
            .setContentText(message)
            .setLargeIcon(childAvatar)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setGroup(conversationKey)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_ALL)
            // 同一 eventId 重投只更新；不同 eventId 是新 child，仍会各自提醒。
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setWhen(state.lastMessageAt)
            .setShowWhen(true)
            .setContentIntent(
              buildOpenActivityIntent(
                context = context,
                displayId = displayId,
                data = childResponseData,
              ),
            )
            .setDeleteIntent(
              buildResponseIntent(
                context = context,
                displayId = displayId,
                action = "dismiss",
                data = childResponseData,
              ),
            )
            .build()

          manager.notify(displayId.toNotificationId(), notification)
          updateConversationSummary(context, conversationKey, state, summaryAvatar)
          NotificationStateStore.recordDiagnostics(context, scopeKey, aiId, sessionId, true, null)
          postResult("posted", true, displayId, null)
          }
        }
      } catch (error: RuntimeException) {
        val errorMessage = error.message ?: error.javaClass.simpleName
        NotificationStateStore.recordDiagnostics(context, scopeKey, aiId, sessionId, false, errorMessage)
        postResult("failed", false, displayId, errorMessage)
      } finally {
        conversationOperationGate.readLock().unlock()
      }
    }
  }

  fun postIncomingCall(context: Context, payload: Map<String, Any?>, foregroundActivity: Activity?): Map<String, Any?> {
    val ringDurationMs = (payload["ringDurationMs"] as? Number)?.toLong()
      ?: throw IllegalArgumentException("来电响铃时长不能为空")
    val displayId = payload.requiredString("displayId")
    val callId = payload.requiredString("callId")
    val aiId = payload.requiredString("aiId")
    val aiName = payload.requiredString("aiName")
    val sessionId = payload.requiredString("sessionId")
    val body = payload.requiredString("body").truncateBody()
    val result = preflight(
      context = context,
      channelId = NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID,
      displayId = displayId,
    )
    // 发布时刻的系统能力快照：来电排障按 incoming-call scope 读取。
    val manager = NotificationManagerCompat.from(context)
    val fullScreenIntentAllowed = manager.canUseFullScreenIntent()
    val callChannelImportance = NotificationChannelRegistry.importance(
      context,
      NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID,
    )
    val callChannelLockscreenVisibility = NotificationChannelRegistry.lockscreenVisibility(
      context,
      NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID,
    )
    val notificationsEnabled = manager.areNotificationsEnabled()
    if (result != null) {
      NotificationStateStore.recordDiagnostics(
        context, INCOMING_CALL_DIAGNOSTICS_SCOPE, aiId, sessionId, false, result["error"] as String?,
        fullScreenIntentAllowed = fullScreenIntentAllowed,
        incomingCallChannelImportance = callChannelImportance,
        incomingCallChannelLockscreenVisibility = callChannelLockscreenVisibility,
        notificationsEnabled = notificationsEnabled,
      )
      return result
    }

    val now = System.currentTimeMillis()
    val data = mapOf(
      "type" to "ai-incoming-call",
      "aiId" to aiId,
      "aiName" to aiName,
      "sessionId" to sessionId,
      "callId" to callId,
      "notificationId" to displayId,
      "lastMessageAt" to now,
    )
    // aiAvatar 只供 IncomingCallActivity 渲染，不进入 response payload。
    val activityData = data + mapOf("aiAvatar" to payload.optionalString("aiAvatar"))

    return try {
      // reject 保持广播 -> Headless 的无 UI 路径；open/accept 直接指向 IncomingCallActivity，
      // 避免 Android 12+ 禁止的 notification -> BroadcastReceiver -> startActivity trampoline。
      val declinePendingIntent = buildResponseIntent(context, displayId, "reject", data)
      val answerPendingIntent = buildCallActivityIntent(context, displayId, "accept", activityData)
      val openPendingIntent = buildCallActivityIntent(context, displayId, "open", activityData)

      val callerBitmap = loadBitmap(context, payload.optionalString("aiAvatar"))
      val caller = Person.Builder()
        .setName(aiName)
        .setImportant(true)
        .apply { callerBitmap?.let { setIcon(IconCompat.createWithBitmap(it)) } }
        .build()

      val builder = NotificationCompat.Builder(
        context,
        NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID,
      )
        .setSmallIcon(resolveSmallIcon(context))
        .setContentTitle("$aiName 来电")
        .setContentText(body)
        .setStyle(
          NotificationCompat.CallStyle.forIncomingCall(
            caller,
            declinePendingIntent,
            answerPendingIntent,
          ),
        )
        .setLargeIcon(callerBitmap)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        // ringing 期间不可滑走：避免通知被划掉但 CallSession 仍 ringing 的“隐形来电”；
        // accept/reject/missed/end 由业务层 dismissIncomingCall() 收口。
        .setAutoCancel(false)
        .setOngoing(true)
        // 声音由同一个原生铃声 owner 循环播放，避免 Channel 提示音与自定义铃声叠加。
        .setSilent(true)
        .setWhen(now)
        .setShowWhen(true)
        .setContentIntent(openPendingIntent)
      // 无 FGS 的 CallStyle 必须请求 FSI；即使前台直接展示，也不能删除这个发布资格。
      // Android 14 在用户禁用全屏展示时自行转为通知，canUseFullScreenIntent 只用于诊断。
      builder.setFullScreenIntent(openPendingIntent, true)
      val channel = context.getSystemService(NotificationManager::class.java)
        .getNotificationChannel(NotificationChannelRegistry.INCOMING_CALL_CHANNEL_ID)
      CallRingtonePlayback.start(context, callId, payload.optionalString("ringtoneUri"), "incoming", durationMs = ringDurationMs,
        // Channel 未指定自定义振动节奏时使用应用定义的默认节奏，仍尊重用户关闭振动。
        vibrationPattern = if (channel.shouldVibrate()) channel.vibrationPattern ?: NotificationChannelRegistry.vibrationPattern else null,
        soundEnabled = channel.importance >= NotificationManager.IMPORTANCE_DEFAULT && channel.sound != null)
      // 先排入铃声请求再让通知可点击；快速接听/拒接的停播不能被晚排入的启动覆盖。
      NotificationManagerCompat.from(context).notify(displayId.toNotificationId(), builder.build())
      var surfaceError: String? = null
      if (foregroundActivity != null) {
        try {
          foregroundActivity.startActivity(callActivityIntent(context, displayId, "open", activityData))
        } catch (failure: RuntimeException) {
          // 通知已发布且接听动作仍有效，展示失败独立留诊断，不能谎报通知发布失败。
          surfaceError = "前台来电界面启动失败：${failure.message ?: failure.javaClass.simpleName}"
          android.util.Log.e("IncomingCallActivity", surfaceError, failure)
        }
      }
      NotificationStateStore.recordDiagnostics(
        context, INCOMING_CALL_DIAGNOSTICS_SCOPE, aiId, sessionId, true, surfaceError,
        fullScreenIntentAllowed = fullScreenIntentAllowed,
        incomingCallChannelImportance = callChannelImportance,
        incomingCallChannelLockscreenVisibility = callChannelLockscreenVisibility,
        notificationsEnabled = notificationsEnabled,
      )
      postResult("posted", true, displayId, surfaceError)
    } catch (error: RuntimeException) {
      CallRingtonePlayback.stop(callId)
      NotificationStateStore.recordDiagnostics(
        context, INCOMING_CALL_DIAGNOSTICS_SCOPE, aiId, sessionId, false,
        error.message ?: error.javaClass.simpleName,
        fullScreenIntentAllowed = fullScreenIntentAllowed,
        incomingCallChannelImportance = callChannelImportance,
        incomingCallChannelLockscreenVisibility = callChannelLockscreenVisibility,
        notificationsEnabled = notificationsEnabled,
      )
      postResult("failed", false, displayId, error.message ?: error.javaClass.simpleName)
    }
  }

  fun upsertTogetherListening(
    context: Context,
    payload: Map<String, Any?>,
  ): Map<String, Any?> {
    val activityId = payload.requiredString("activityId")
    val hostAiId = payload.requiredString("hostAiId")
    val chatSessionId = payload.requiredString("chatSessionId")
    val activatedAtEpochMs = (payload["activatedAtEpochMs"] as? Number)?.toLong()
      ?: throw IllegalArgumentException("通知字段 activatedAtEpochMs 不能为空")
    val aiName = payload.requiredString("aiName")
    val manager = NotificationManagerCompat.from(context)
    NotificationChannelRegistry.ensureChannels(context)
    val channelImportance = NotificationChannelRegistry.importance(
      context,
      NotificationChannelRegistry.TOGETHER_LISTENING_CHANNEL_ID,
    )
    if (NotificationStateStore.isTogetherListeningDismissed(context, activityId)) {
      return togetherListeningResult(
        status = "suppressed",
        posted = false,
        dismissedForCurrentActivity = true,
        channelImportance = channelImportance,
        error = null,
      ).also { NotificationStateStore.recordTogetherListeningDiagnostics(context, it) }
    }

    val preflight = preflight(
      context,
      NotificationChannelRegistry.TOGETHER_LISTENING_CHANNEL_ID,
      TOGETHER_LISTENING_DISPLAY_ID,
    )
    if (preflight != null) {
      val result = togetherListeningResult(
        status = preflight["status"] as String,
        posted = false,
        dismissedForCurrentActivity = false,
        channelImportance = channelImportance,
        error = preflight["error"] as String?,
      )
      NotificationStateStore.recordTogetherListeningDiagnostics(context, result)
      return result
    }

    val responseData = mapOf(
      "type" to "together-listening",
      "activityId" to activityId,
      "hostAiId" to hostAiId,
      "aiId" to hostAiId,
      "chatSessionId" to chatSessionId,
      "sessionId" to chatSessionId,
      "notificationId" to TOGETHER_LISTENING_DISPLAY_ID,
    )
    return try {
      val leaveIntent = buildResponseIntent(
        context,
        TOGETHER_LISTENING_DISPLAY_ID,
        "leave",
        responseData,
      )
      val content = "与 $aiName 一起听网易云音乐"
      val builder = NotificationCompat.Builder(
        context,
        NotificationChannelRegistry.TOGETHER_LISTENING_CHANNEL_ID,
      )
        .setSmallIcon(expo.modules.kimiphonenotifications.R.drawable.ic_together_listening)
        .setContentTitle("正在一起听")
        .setContentText(content)
        .setStyle(NotificationCompat.BigTextStyle().bigText(content))
        .setLargeIcon(loadBitmap(context, payload.optionalString("aiAvatar")))
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setAutoCancel(false)
        .setOngoing(true)
        .setWhen(activatedAtEpochMs)
        .setShowWhen(true)
        .setUsesChronometer(true)
        .setContentIntent(
          buildOpenActivityIntent(
            context,
            TOGETHER_LISTENING_DISPLAY_ID,
            responseData,
          ),
        )
        .setDeleteIntent(
          buildResponseIntent(context, TOGETHER_LISTENING_DISPLAY_ID, "dismiss", responseData),
        )
        .addAction(
          NotificationCompat.Action.Builder(
            expo.modules.kimiphonenotifications.R.drawable.ic_together_listening,
            "退出一起听",
            leaveIntent,
          ).build(),
        )
      val notification = builder.build()
      manager.notify(TOGETHER_LISTENING_DISPLAY_ID.toNotificationId(), notification)
      NotificationStateStore.setTogetherListeningCurrentActivity(context, activityId)
      togetherListeningResult(
        status = "posted",
        posted = true,
        dismissedForCurrentActivity = false,
        channelImportance = channelImportance,
        error = null,
      ).also { NotificationStateStore.recordTogetherListeningDiagnostics(context, it) }
    } catch (error: RuntimeException) {
      togetherListeningResult(
        status = "failed",
        posted = false,
        dismissedForCurrentActivity = false,
        channelImportance = channelImportance,
        error = error.message ?: error.javaClass.simpleName,
      ).also { NotificationStateStore.recordTogetherListeningDiagnostics(context, it) }
    }
  }

  fun dismissTogetherListening(context: Context, activityId: String?) {
    val currentActivityId = NotificationStateStore.readTogetherListeningCurrentActivity(context)
    if (activityId != null && currentActivityId != null && currentActivityId != activityId) {
      return
    }
    NotificationManagerCompat.from(context)
      .cancel(TOGETHER_LISTENING_DISPLAY_ID.toNotificationId())
    NotificationStateStore.clearTogetherListeningCurrentActivity(context)
  }

  fun togetherListeningDiagnostics(context: Context): Map<String, Any?> {
    val stored = NotificationStateStore.readTogetherListeningDiagnostics(context)
    if (stored.isNotEmpty()) return stored
    NotificationChannelRegistry.ensureChannels(context)
    return togetherListeningResult(
      status = "suppressed",
      posted = false,
      dismissedForCurrentActivity = false,
      channelImportance = NotificationChannelRegistry.importance(context, NotificationChannelRegistry.TOGETHER_LISTENING_CHANNEL_ID),
      error = null,
    )
  }

  /** 按会话聚合 key 撤销整组（全部子通知 + 会话摘要）：null 表示撤销全部会话通知。 */
  fun dismissConversation(context: Context, conversationKey: String?) {
    if (conversationKey.isNullOrBlank()) {
      conversationOperationGate.writeLock().lock()
      try {
        val states = synchronized(conversationStateLock) {
          val states = NotificationStateStore.readConversations(context)
          NotificationStateStore.clearConversations(context)
          states
        }
        val manager = NotificationManagerCompat.from(context)
        states.forEach { state ->
          cancelConversationNotifications(manager, state)
        }
      } finally {
        conversationOperationGate.writeLock().unlock()
      }
      return
    }

    withConversationOperationLock(conversationKey) {
      val manager = NotificationManagerCompat.from(context)
      val state = synchronized(conversationStateLock) {
        val current = NotificationStateStore.readConversation(context, conversationKey)
        // 状态缺失也要执行 remove，保持 SharedPreferences 读改写与发布互斥。
        NotificationStateStore.removeConversation(context, conversationKey)
        current
      }
      state?.let {
        cancelConversationNotifications(manager, it)
      }
      // 状态缺失也要兜底 cancel 摘要，避免残留空组。
      manager.cancel(summaryDisplayId(conversationKey).toNotificationId())
    }
  }

  /** 滑掉单条子通知：只移除该子通知并刷新摘要计数，不撤销整组。 */
  fun dismissChild(context: Context, conversationKey: String, childId: String) {
    withConversationOperationLock(conversationKey) {
      val manager = NotificationManagerCompat.from(context)
      manager.cancel(childDisplayId(conversationKey, childId).toNotificationId())
      val state = synchronized(conversationStateLock) {
        NotificationStateStore.removeChild(context, conversationKey, childId)
        NotificationStateStore.readConversation(context, conversationKey)
      }
      if (state == null) {
        manager.cancel(summaryDisplayId(conversationKey).toNotificationId())
      } else {
        updateConversationSummary(context, conversationKey, state)
      }
    }
  }

  fun dismissIncomingCall(context: Context, callId: String) {
    CallRingtonePlayback.stop(callId)
    NotificationManagerCompat.from(context).cancel(callDisplayId(callId).toNotificationId())
    // 业务层结束通话（reject/missed/accept/end）时同步关闭已弹出的原生来电 surface。
    IncomingCallSurfaceRegistry.dismiss(callId)
  }

  /** 阅读回执只撤销实际展示的消息，不能把同一 AI 的其他会话或屏外未读一起清掉。 */
  fun dismissReadMessages(context: Context, sessionId: String, messageIds: List<String>, clientMessageIds: List<String>) {
    val ids = messageIds.toSet()
    val clients = clientMessageIds.toSet()
    conversationOperationGate.writeLock().lock()
    try {
      val states = synchronized(conversationStateLock) { NotificationStateStore.readConversations(context) }
      for (state in states) {
        for (child in state.children) {
          if (child.sessionId == sessionId &&
            (child.committedMessageId?.toString() in ids || child.childId in clients)) {
            dismissChild(context, state.conversationKey, child.childId)
          }
        }
      }
    } finally {
      conversationOperationGate.writeLock().unlock()
    }
  }

  fun callDisplayId(callId: String) = "kimiphone-call-$callId"

  private fun childDisplayId(conversationKey: String, childId: String) =
    "$CHILD_DISPLAY_ID_PREFIX$conversationKey-$childId"

  private fun summaryDisplayId(conversationKey: String) =
    "$SUMMARY_DISPLAY_ID_PREFIX$conversationKey"

  private fun conversationOperationLock(conversationKey: String): Any =
    conversationOperationLocks.computeIfAbsent(conversationKey) { Any() }

  private fun <T> withConversationOperationLock(
    conversationKey: String,
    operation: () -> T,
  ): T {
    conversationOperationGate.readLock().lock()
    return try {
      synchronized(conversationOperationLock(conversationKey)) {
        operation()
      }
    } finally {
      conversationOperationGate.readLock().unlock()
    }
  }

  private fun cancelConversationNotifications(
    manager: NotificationManagerCompat,
    state: ConversationNotificationState,
  ) {
    state.children.forEach { child ->
      manager.cancel(childDisplayId(state.conversationKey, child.childId).toNotificationId())
    }
    manager.cancel(summaryDisplayId(state.conversationKey).toNotificationId())
  }

  /** 每会话一个组摘要：标题会话名、内容 N 条新消息、subText 最新一条预览；静默不抢子通知提醒。 */
  private fun updateConversationSummary(
    context: Context,
    conversationKey: String,
    state: ConversationNotificationState,
    senderAvatarBitmap: Bitmap? = null,
  ) {
    val manager = NotificationManagerCompat.from(context)
    if (state.children.isEmpty()) {
      manager.cancel(summaryDisplayId(conversationKey).toNotificationId())
      return
    }

    val displayId = summaryDisplayId(conversationKey)
    val latest = state.children.last()
    // 群聊摘要预览带发送者名前缀；单聊直接放内容。
    val latestPreview = if (state.conversationKind == "group" && !latest.senderName.isNullOrBlank()) {
      "${latest.senderName}: ${latest.text}"
    } else {
      latest.text
    }
    val responseData = mapOf(
      "type" to "ai-message-summary",
      "aiId" to state.aiId,
      "latestAiId" to state.aiId,
      "aiName" to state.conversationTitle,
      "sessionId" to state.sessionId,
      "conversationKey" to state.conversationKey,
      "conversationKind" to state.conversationKind,
      "groupId" to state.groupId,
      "notificationId" to displayId,
      "lastMessageAt" to state.lastMessageAt,
    )
    val summary = NotificationCompat.Builder(context, NotificationChannelRegistry.MESSAGE_CHANNEL_ID)
      .setSmallIcon(resolveSmallIcon(context))
      .setContentTitle(state.conversationTitle)
      .setContentText("${state.children.size} 条新消息")
      .setSubText(latestPreview)
      .setLargeIcon(senderAvatarBitmap ?: loadBitmap(context, state.senderAvatar))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setGroup(conversationKey)
      .setGroupSummary(true)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setWhen(state.lastMessageAt)
      .setShowWhen(true)
      .setContentIntent(buildOpenActivityIntent(context, displayId, responseData))
      .setDeleteIntent(buildResponseIntent(context, displayId, "dismiss", responseData))
      .build()
    manager.notify(displayId.toNotificationId(), summary)
  }

  private fun preflight(
    context: Context,
    channelId: String,
    displayId: String,
  ): Map<String, Any?>? {
    NotificationChannelRegistry.ensureChannels(context)
    if (!hasPostNotificationsPermission(context)) {
      return postResult("permission_denied", false, displayId, "post_notifications_permission_missing")
    }
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      return postResult("notifications_disabled", false, displayId, "application_notifications_disabled")
    }
    if (NotificationChannelRegistry.importance(context, channelId) == NotificationManager.IMPORTANCE_NONE) {
      return postResult("channel_disabled", false, displayId, "notification_channel_disabled")
    }
    return null
  }

  private fun hasPostNotificationsPermission(context: Context): Boolean {
    return ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
  }

  private fun buildResponseIntent(
    context: Context,
    displayId: String,
    action: String,
    data: Map<String, Any?>,
  ): PendingIntent {
    val intent = Intent(context, NotificationActionReceiver::class.java).apply {
      this.action = "${context.packageName}.NOTIFICATION_RESPONSE.$action.$displayId"
      putExtra("notificationAction", action)
      data.forEach { (key, value) ->
        when (value) {
          is String -> putExtra(key, value)
          is Long -> putExtra(key, value)
          is Int -> putExtra(key, value)
          is Boolean -> putExtra(key, value)
        }
      }
    }
    return PendingIntent.getBroadcast(
      context,
      "$displayId:$action".hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** 来电 open/accept 的直接 Activity PendingIntent：不经过 BroadcastReceiver，规避 trampoline 限制。 */
  private fun buildCallActivityIntent(
    context: Context,
    displayId: String,
    action: String,
    data: Map<String, Any?>,
  ): PendingIntent {
    return PendingIntent.getActivity(
      context,
      "$displayId:$action".hashCode(),
      callActivityIntent(context, displayId, action, data),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** 前台展示与通知点击共享同一个原生来电入口及 payload，不复制接听/拒接流程。 */
  private fun callActivityIntent(
    context: Context,
    displayId: String,
    action: String,
    data: Map<String, Any?>,
  ): Intent = Intent(context, IncomingCallActivity::class.java).apply {
    this.action = "${context.packageName}.INCOMING_CALL.$action.$displayId"
    putExtra("notificationAction", action)
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    data.forEach { (key, value) ->
      when (value) {
        is String -> putExtra(key, value)
        is Long -> putExtra(key, value)
        is Int -> putExtra(key, value)
        is Boolean -> putExtra(key, value)
      }
    }
  }

  /** 用户打开通知直接进入 Activity；广播只承接滑走、拒接和退出等无界面动作。 */
  private fun buildOpenActivityIntent(
    context: Context,
    displayId: String,
    data: Map<String, Any?>,
  ): PendingIntent {
    val intent = Intent(context, NotificationOpenActivity::class.java).apply {
      action = "${context.packageName}.NOTIFICATION.open.$displayId"
      putExtra("notificationAction", "open")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      data.forEach { (key, value) ->
        when (value) {
          is String -> putExtra(key, value)
          is Long -> putExtra(key, value)
          is Int -> putExtra(key, value)
          is Boolean -> putExtra(key, value)
        }
      }
    }
    return PendingIntent.getActivity(
      context,
      "$displayId:open".hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun conversationResponseData(
    payload: Map<String, Any?>,
    displayId: String,
    timestamp: Long,
    type: String,
  ): Map<String, Any?> {
    val aiId = payload.requiredString("aiId")
    return mapOf(
      "type" to type,
      "aiId" to aiId,
      "aiName" to payload.requiredString("aiName"),
      "sessionId" to payload.optionalString("sessionId"),
      "deliveryKind" to (payload.optionalString("deliveryKind") ?: "passive"),
      "triggerSource" to payload.optionalString("triggerSource"),
      "relatedEntityId" to payload.optionalString("relatedEntityId"),
      "conversationKey" to (payload.optionalString("conversationKey") ?: "ai:$aiId"),
      "conversationKind" to payload.optionalString("conversationKind"),
      "groupId" to payload.optionalString("groupId"),
      "notificationId" to displayId,
      "lastMessageAt" to timestamp,
    )
  }

  private fun resolveSmallIcon(context: Context): Int {
    return context.applicationInfo.icon.takeIf { it != 0 }
      ?: android.R.drawable.stat_notify_chat
  }

  /** 解码 content/file/绝对路径头像；同模块的 IncomingCallActivity 也复用。 */
  fun loadBitmap(context: Context, value: String?): Bitmap? {
    val source = value?.trim().orEmpty()
    if (source.isEmpty()) return null
    readAvatarCache(source)?.let { return it }
    val decoded = try {
      when {
        source.startsWith("content://") || source.startsWith("file://") ->
          context.contentResolver.openInputStream(Uri.parse(source))?.use(BitmapFactory::decodeStream)
        source.startsWith("/") -> BitmapFactory.decodeFile(source)
        Regex("^[a-zA-Z]:[\\\\/]").containsMatchIn(source) -> BitmapFactory.decodeFile(File(source).path)
        else -> null
      }
    } catch (_: RuntimeException) {
      null
    }
    if (decoded != null) writeAvatarCache(source, decoded)
    return decoded
  }

  // 头像解码单条目缓存：postIncomingCall 发布通知与 IncomingCallActivity 渲染来电壳
  // 会各自解码同一张头像，缓存后避免两次同步磁盘解码。同一时刻只会有一个来电，
  // 一个条目即可；Bitmap 复用是只读场景（通知图标与 Activity 圆形头像都不改像素），安全。
  private var lastDecodedAvatar: Pair<String, Bitmap>? = null

  @Synchronized
  private fun readAvatarCache(source: String): Bitmap? =
    lastDecodedAvatar?.takeIf { it.first == source }?.second

  @Synchronized
  private fun writeAvatarCache(source: String, bitmap: Bitmap) {
    lastDecodedAvatar = source to bitmap
  }

  private fun postResult(
    status: String,
    posted: Boolean,
    displayId: String,
    error: String?,
  ): Map<String, Any?> = mapOf(
    "status" to status,
    "posted" to posted,
    "displayId" to displayId,
    "error" to error,
  )

  private fun togetherListeningResult(
    status: String,
    posted: Boolean,
    dismissedForCurrentActivity: Boolean,
    channelImportance: Int,
    error: String?,
  ): Map<String, Any?> = mapOf(
    "status" to status,
    "posted" to posted,
    "displayId" to TOGETHER_LISTENING_DISPLAY_ID,
    "dismissedForCurrentActivity" to dismissedForCurrentActivity,
    "channelImportance" to channelImportance,
    "error" to error,
    "lastProjectionError" to error,
  )

  private fun String.toNotificationId(): Int = hashCode().absoluteValue

  private fun String.truncateBody(): String {
    return if (length <= MAX_BODY_LENGTH) this else take(MAX_BODY_LENGTH - 3) + "..."
  }

  private fun Map<String, Any?>.requiredString(key: String): String {
    return (this[key] as? String)?.trim().orEmpty().ifEmpty {
      throw IllegalArgumentException("通知字段 $key 不能为空")
    }
  }

  private fun Map<String, Any?>.optionalString(key: String): String? {
    return (this[key] as? String)?.trim()?.ifEmpty { null }
  }
}
