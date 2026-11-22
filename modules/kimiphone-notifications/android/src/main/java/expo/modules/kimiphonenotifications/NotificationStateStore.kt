package expo.modules.kimiphonenotifications

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** 单条子通知记录：childId 即 eventId，用于独立通知 ID、计数与淘汰。 */
internal data class ConversationChildNotification(
  val childId: String,
  val text: String,
  val senderName: String?,
  val postedAtEpochMs: Long,
  val sessionId: String? = null,
  val committedMessageId: Long? = null,
)

/**
 * 会话通知聚合状态。主键是 conversationKey（direct = `ai:<aiId>`，group = `group:<groupId>`），
 * aiId 仅作为 direct 会话的辅助字段保留，群聊不伪造 aiId。
 * children 是该会话当前展示中的子通知清单（每段消息一条独立子通知）。
 */
internal data class ConversationNotificationState(
  val conversationKey: String,
  val conversationTitle: String,
  val conversationKind: String?,
  val groupId: String?,
  val aiId: String?,
  val senderName: String?,
  val senderAvatar: String?,
  val sessionId: String?,
  val deliveryKind: String,
  val triggerSource: String?,
  val relatedEntityId: String?,
  val children: List<ConversationChildNotification>,
  val lastMessageAt: Long,
)

/** upsert 结果：evictedChildIds 需要调用方同步 cancel 对应子通知。 */
internal data class ConversationUpsertResult(
  val state: ConversationNotificationState,
  val evictedChildIds: List<String>,
)

internal object NotificationStateStore {
  private const val PREFS_NAME = "kimiphone_native_notifications"
  private const val KEY_CONVERSATIONS = "conversation_states"
  private const val KEY_PENDING_RESPONSES = "pending_responses"
  private const val KEY_CONVERSATION_KEY_MIGRATED = "conversation_key_migrated"
  private const val KEY_LEGACY_MERGED_CLEARED = "legacy_merged_notifications_cleared"
  private const val KEY_TOGETHER_DISMISSED_ACTIVITY_ID = "together_dismissed_activity_id"
  private const val KEY_TOGETHER_DIAGNOSTICS = "together_diagnostics"
  private const val KEY_TOGETHER_CURRENT_ACTIVITY_ID = "together_current_activity_id"
  private const val MAX_CHILDREN = 8
  private const val MAX_PENDING_RESPONSES = 30

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  /**
   * 按 childId 幂等 upsert 一条子通知；超过上限淘汰最旧并返回被淘汰的 childId，
   * 由调用方 cancel 对应系统通知。
   */
  fun upsertConversation(
    context: Context,
    conversationKey: String,
    conversationTitle: String,
    conversationKind: String?,
    groupId: String?,
    aiId: String?,
    senderName: String?,
    senderAvatar: String?,
    sessionId: String?,
    deliveryKind: String,
    triggerSource: String?,
    relatedEntityId: String?,
    childId: String,
    message: String,
    lastMessageAt: Long,
    committedMessageId: Long? = null,
  ): ConversationUpsertResult {
    val states = readConversations(context).associateBy { it.conversationKey }.toMutableMap()
    val previous = states[conversationKey]
    val previousChildren = previous?.children ?: emptyList()
    val nextChildren = if (previousChildren.any { it.childId == childId }) {
      // 同 eventId 重发：原位更新文本，不重复计数。
      previousChildren.map { child ->
        if (child.childId == childId) {
          child.copy(text = message, senderName = senderName, postedAtEpochMs = lastMessageAt,
            sessionId = sessionId, committedMessageId = committedMessageId)
        } else {
          child
        }
      }
    } else {
      previousChildren + ConversationChildNotification(
        childId = childId,
        text = message,
        senderName = senderName,
        postedAtEpochMs = lastMessageAt,
        sessionId = sessionId,
        committedMessageId = committedMessageId,
      )
    }
    val evicted = nextChildren.dropLast(MAX_CHILDREN).map { it.childId }
    val next = ConversationNotificationState(
      conversationKey = conversationKey,
      conversationTitle = conversationTitle,
      conversationKind = conversationKind ?: previous?.conversationKind,
      groupId = groupId ?: previous?.groupId,
      aiId = aiId ?: previous?.aiId,
      senderName = senderName ?: previous?.senderName,
      senderAvatar = senderAvatar ?: previous?.senderAvatar,
      sessionId = sessionId ?: previous?.sessionId,
      deliveryKind = deliveryKind,
      triggerSource = triggerSource ?: previous?.triggerSource,
      relatedEntityId = relatedEntityId,
      children = nextChildren.takeLast(MAX_CHILDREN),
      lastMessageAt = lastMessageAt,
    )
    states[conversationKey] = next
    writeConversations(context, states.values.toList())
    return ConversationUpsertResult(state = next, evictedChildIds = evicted)
  }

  fun readConversation(context: Context, conversationKey: String): ConversationNotificationState? {
    return readConversations(context).firstOrNull { it.conversationKey == conversationKey }
  }

  fun removeChild(context: Context, conversationKey: String, childId: String) {
    val states = readConversations(context)
    val target = states.firstOrNull { it.conversationKey == conversationKey } ?: return
    val remaining = target.children.filterNot { it.childId == childId }
    val next = if (remaining.isEmpty()) {
      states.filterNot { it.conversationKey == conversationKey }
    } else {
      states.map { state ->
        if (state.conversationKey == conversationKey) state.copy(children = remaining,
          sessionId = remaining.last().sessionId, lastMessageAt = remaining.last().postedAtEpochMs) else state
      }
    }
    writeConversations(context, next)
  }

  fun readConversations(context: Context): List<ConversationNotificationState> {
    migrateConversationKeysIfNeeded(context)
    val raw = prefs(context).getString(KEY_CONVERSATIONS, null) ?: return emptyList()
    return try {
      val array = JSONArray(raw)
      buildList {
        for (index in 0 until array.length()) {
          val item = array.optJSONObject(index) ?: continue
          // 旧格式只有 aiId/aiName；迁移后写入 conversationKey/conversationTitle。
          val aiId = item.optNullableString("aiId")
          val conversationKey = item.optNullableString("conversationKey")
            ?: aiId?.let { "ai:$it" }
            ?: continue
          val conversationTitle = item.optNullableString("conversationTitle")
            ?: item.optString("aiName").trim()
          if (conversationTitle.isEmpty()) continue
          // 旧格式的 segments 明细（纯文本数组合并通知）不再兼容，丢弃明细只保留会话元信息。
          val childArray = item.optJSONArray("children") ?: JSONArray()
          val children = buildList {
            for (childIndex in 0 until childArray.length()) {
              val child = childArray.optJSONObject(childIndex) ?: continue
              val childId = child.optString("childId").trim()
              val text = child.optString("text").trim()
              if (childId.isEmpty() || text.isEmpty()) continue
              add(
                ConversationChildNotification(
                  childId = childId,
                  text = text,
                  senderName = child.optNullableString("senderName"),
                  postedAtEpochMs = child.optLong("postedAtEpochMs", 0L),
                  sessionId = child.optNullableString("sessionId"),
                  committedMessageId = (child.opt("committedMessageId") as? Number)?.toLong(),
                ),
              )
            }
          }
          add(
            ConversationNotificationState(
              conversationKey = conversationKey,
              conversationTitle = conversationTitle,
              conversationKind = item.optNullableString("conversationKind"),
              groupId = item.optNullableString("groupId"),
              aiId = aiId,
              senderName = item.optNullableString("senderName"),
              senderAvatar = item.optNullableString("senderAvatar"),
              sessionId = item.optNullableString("sessionId"),
              deliveryKind = item.optString("deliveryKind", "passive"),
              triggerSource = item.optNullableString("triggerSource"),
              relatedEntityId = item.optNullableString("relatedEntityId"),
              children = children,
              lastMessageAt = item.optLong("lastMessageAt", 0L),
            ),
          )
        }
      }.sortedByDescending { it.lastMessageAt }
    } catch (_: RuntimeException) {
      emptyList()
    }
  }

  fun removeConversation(context: Context, conversationKey: String) {
    writeConversations(
      context,
      readConversations(context).filterNot { it.conversationKey == conversationKey },
    )
  }

  fun clearConversations(context: Context) {
    prefs(context).edit().remove(KEY_CONVERSATIONS).apply()
  }

  fun recordTogetherListeningDismissal(context: Context, activityId: String) {
    prefs(context).edit().putString(KEY_TOGETHER_DISMISSED_ACTIVITY_ID, activityId).apply()
  }

  fun isTogetherListeningDismissed(context: Context, activityId: String): Boolean =
    prefs(context).getString(KEY_TOGETHER_DISMISSED_ACTIVITY_ID, null) == activityId

  fun setTogetherListeningCurrentActivity(context: Context, activityId: String) {
    prefs(context).edit().putString(KEY_TOGETHER_CURRENT_ACTIVITY_ID, activityId).apply()
  }

  fun readTogetherListeningCurrentActivity(context: Context): String? =
    prefs(context).getString(KEY_TOGETHER_CURRENT_ACTIVITY_ID, null)

  fun clearTogetherListeningCurrentActivity(context: Context) {
    prefs(context).edit().remove(KEY_TOGETHER_CURRENT_ACTIVITY_ID).apply()
  }

  fun recordTogetherListeningDiagnostics(context: Context, diagnostics: Map<String, Any?>) {
    val value = JSONObject().apply {
      diagnostics.forEach { (key, item) -> putNullable(key, item) }
    }
    check(prefs(context).edit().putString(KEY_TOGETHER_DIAGNOSTICS, value.toString()).commit()) {
      "无法保存 Together Listening 通知诊断"
    }
  }

  fun readTogetherListeningDiagnostics(context: Context): Map<String, Any?> {
    val raw = prefs(context).getString(KEY_TOGETHER_DIAGNOSTICS, null) ?: return emptyMap()
    return try {
      JSONObject(raw).toResponseMap()
    } catch (_: RuntimeException) {
      emptyMap()
    }
  }

  /** 恢复出厂：清空全部原生通知状态，包括 pending response 与 diagnostics。 */
  fun clearAllForFactoryReset(context: Context) {
    check(prefs(context).edit().clear().commit()) {
      "无法清空原生通知状态"
    }
  }

  /**
   * 一次性迁移：旧版本按裸 aiId 聚合、无 conversationKey 字段；
   * 这里补写 `ai:<aiId>` 键并落标记位，保证升级后旧通知仍能按 key 撤销与聚合。
   */
  private fun migrateConversationKeysIfNeeded(context: Context) {
    val preferences = prefs(context)
    if (preferences.getBoolean(KEY_CONVERSATION_KEY_MIGRATED, false)) return
    val raw = preferences.getString(KEY_CONVERSATIONS, null)
    if (raw != null) {
      try {
        val array = JSONArray(raw)
        var changed = false
        for (index in 0 until array.length()) {
          val item = array.optJSONObject(index) ?: continue
          if (item.optNullableString("conversationKey") != null) continue
          val aiId = item.optString("aiId").trim()
          if (aiId.isEmpty()) continue
          item.put("conversationKey", "ai:$aiId")
          changed = true
        }
        if (changed) {
          preferences.edit().putString(KEY_CONVERSATIONS, array.toString()).apply()
        }
      } catch (_: RuntimeException) {
        // 旧数据损坏时按空状态处理，不阻断通知链路。
      }
    }
    preferences.edit().putBoolean(KEY_CONVERSATION_KEY_MIGRATED, true).apply()
  }

  /**
   * 一次性清理升级前已展示的合并形态通知：全应用汇总 `kimiphone-message-summary`、
   * 按会话合并的 `kimiphone-message-<conversationKey>` 与更早的 `kimiphone-message-<aiId>`。
   * 返回待 cancel 的 legacy displayId 清单；已清理过返回 null。
   */
  fun consumeLegacyMergedNotificationCleanup(context: Context): List<String>? {
    val preferences = prefs(context)
    if (preferences.getBoolean(KEY_LEGACY_MERGED_CLEARED, false)) return null
    preferences.edit().putBoolean(KEY_LEGACY_MERGED_CLEARED, true).apply()
    val displayIds = readConversations(context).flatMap { state ->
      listOfNotNull(
        "kimiphone-message-${state.conversationKey}",
        state.aiId?.let { "kimiphone-message-$it" },
      )
    }
    return displayIds + "kimiphone-message-summary"
  }

  private fun writeConversations(context: Context, states: List<ConversationNotificationState>) {
    val array = JSONArray()
    states.forEach { state ->
      array.put(
        JSONObject().apply {
          put("conversationKey", state.conversationKey)
          put("conversationTitle", state.conversationTitle)
          putNullable("conversationKind", state.conversationKind)
          putNullable("groupId", state.groupId)
          putNullable("aiId", state.aiId)
          putNullable("senderName", state.senderName)
          putNullable("senderAvatar", state.senderAvatar)
          putNullable("sessionId", state.sessionId)
          put("deliveryKind", state.deliveryKind)
          putNullable("triggerSource", state.triggerSource)
          putNullable("relatedEntityId", state.relatedEntityId)
          put(
            "children",
            JSONArray().apply {
              state.children.forEach { child ->
                put(
                  JSONObject().apply {
                    put("childId", child.childId)
                    put("text", child.text)
                    putNullable("senderName", child.senderName)
                    put("postedAtEpochMs", child.postedAtEpochMs)
                    putNullable("sessionId", child.sessionId)
                    putNullable("committedMessageId", child.committedMessageId)
                  },
                )
              }
            },
          )
          put("lastMessageAt", state.lastMessageAt)
        },
      )
    }
    prefs(context).edit().putString(KEY_CONVERSATIONS, array.toString()).apply()
  }

  fun recordDiagnostics(
    context: Context,
    scopeKey: String?,
    aiId: String?,
    sessionId: String?,
    shown: Boolean,
    error: String?,
    fullScreenIntentAllowed: Boolean? = null,
    incomingCallChannelImportance: Int? = null,
    incomingCallChannelLockscreenVisibility: Int? = null,
    notificationsEnabled: Boolean? = null,
  ) {
    val prefix = diagnosticsPrefix(scopeKey)
    val editor = prefs(context).edit()
      .putLong("${prefix}attemptAt", System.currentTimeMillis())
      .putBoolean("${prefix}shown", shown)
      .putString("${prefix}aiId", aiId)
      .putString("${prefix}sessionId", sessionId)
      .putString("${prefix}error", error)
    // 来电发布时刻的系统能力快照：排障时可区分“发布时 FSI 已关闭”与“通知发送失败”。
    fullScreenIntentAllowed?.let { editor.putBoolean("${prefix}fsiAllowed", it) }
    incomingCallChannelImportance?.let { editor.putInt("${prefix}callChannelImportance", it) }
    incomingCallChannelLockscreenVisibility?.let {
      editor.putInt("${prefix}callChannelLockscreenVisibility", it)
    }
    notificationsEnabled?.let { editor.putBoolean("${prefix}notificationsEnabled", it) }
    editor.apply()
  }

  fun readDiagnostics(context: Context, scopeKey: String?): Map<String, Any?> {
    val prefix = diagnosticsPrefix(scopeKey)
    val preferences = prefs(context)
    return mapOf(
      "lastNotificationAttemptAtEpochMs" to preferences.getLong("${prefix}attemptAt", 0L),
      "lastNotificationShown" to preferences.getBoolean("${prefix}shown", false),
      "lastNotificationAIId" to preferences.getString("${prefix}aiId", null),
      "lastNotificationSessionId" to preferences.getString("${prefix}sessionId", null),
      "lastNotificationError" to preferences.getString("${prefix}error", null),
      "lastNotificationFullScreenIntentAllowed" to
        preferences.takeIf { it.contains("${prefix}fsiAllowed") }?.getBoolean("${prefix}fsiAllowed", false),
      "lastNotificationIncomingCallChannelImportance" to
        preferences.takeIf { it.contains("${prefix}callChannelImportance") }?.getInt("${prefix}callChannelImportance", 0),
      "lastNotificationIncomingCallChannelLockscreenVisibility" to
        preferences.takeIf { it.contains("${prefix}callChannelLockscreenVisibility") }
          ?.getInt("${prefix}callChannelLockscreenVisibility", 0),
      "lastNotificationNotificationsEnabled" to
        preferences.takeIf { it.contains("${prefix}notificationsEnabled") }?.getBoolean("${prefix}notificationsEnabled", false),
    )
  }

  private fun diagnosticsPrefix(scopeKey: String?): String {
    val normalized = scopeKey?.trim().orEmpty().ifEmpty { "global" }
      .replace(Regex("[^a-zA-Z0-9_.-]"), "_")
    return "diagnostics_${normalized}_"
  }

  @Synchronized
  fun enqueueResponse(context: Context, response: Map<String, Any?>): String {
    val responseId = "${System.currentTimeMillis()}_${response["notificationId"]}_${response["notificationAction"]}"
    val existing = readPendingResponseObjects(context).toMutableList()
    existing += JSONObject().apply {
      put("responseId", responseId)
      response.forEach { (key, value) -> putNullable(key, value) }
    }
    writePendingResponses(context, existing.takeLast(MAX_PENDING_RESPONSES))
    return responseId
  }

  @Synchronized
  fun removePendingResponse(context: Context, responseId: String) {
    writePendingResponses(
      context,
      readPendingResponseObjects(context).filterNot { it.optString("responseId") == responseId },
    )
  }

  @Synchronized
  fun consumePendingResponses(context: Context): List<Map<String, Any?>> {
    val responses = readPendingResponseObjects(context).map { it.toResponseMap() }
    prefs(context).edit().remove(KEY_PENDING_RESPONSES).apply()
    return responses
  }

  private fun readPendingResponseObjects(context: Context): List<JSONObject> {
    val raw = prefs(context).getString(KEY_PENDING_RESPONSES, null) ?: return emptyList()
    return try {
      val array = JSONArray(raw)
      buildList {
        for (index in 0 until array.length()) {
          array.optJSONObject(index)?.let(::add)
        }
      }
    } catch (_: RuntimeException) {
      emptyList()
    }
  }

  private fun writePendingResponses(context: Context, responses: List<JSONObject>) {
    val array = JSONArray()
    responses.forEach(array::put)
    prefs(context).edit().putString(KEY_PENDING_RESPONSES, array.toString()).apply()
  }

  private fun JSONObject.toResponseMap(): Map<String, Any?> {
    val result = mutableMapOf<String, Any?>()
    keys().forEach { key ->
      if (key != "responseId") {
        result[key] = if (isNull(key)) null else get(key)
      }
    }
    return result
  }

  private fun JSONObject.optNullableString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key).trim().ifEmpty { null }
  }

  private fun JSONObject.putNullable(key: String, value: Any?) {
    put(key, value ?: JSONObject.NULL)
  }
}
