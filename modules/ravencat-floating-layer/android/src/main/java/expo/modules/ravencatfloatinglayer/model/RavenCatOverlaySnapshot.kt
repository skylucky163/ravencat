package expo.modules.ravencatfloatinglayer.model

import expo.modules.ravencatfloatinglayer.BubbleSkin
import expo.modules.ravencatfloatinglayer.BubbleSkinStore

/** RavenCat 原生 UI 的唯一、不可变渲染输入。 */
internal data class RavenCatOverlaySnapshot(
  val messages: List<RavenCatOverlayMessage> = emptyList(),
  val conversationSessionId: String? = null,
  val previewMessageWatermark: Long = 0,
  val targetPreview: RavenCatOverlayTargetPreview? = null,
  val isExpanded: Boolean = false,
  val isSending: Boolean = false,
  val draft: String = "",
  val screenshotState: RavenCatScreenshotState = RavenCatScreenshotState.IDLE,
  val stagedScreenshot: RavenCatStagedScreenshot? = null,
  val bubbleDockSide: RavenCatBubbleDockSide = RavenCatBubbleDockSide.NONE,
  val bubbleSkin: BubbleSkin? = null,
  val bubbleSizeDp: Int = BubbleSkinStore.DEFAULT_SIZE_DP,
  val bubbleFallbackSkin: BubbleSkin? = null,
  val togetherListening: RavenCatTogetherListeningPresentation? = null,
) {
  fun withMessages(nextMessages: List<RavenCatOverlayMessage>): RavenCatOverlaySnapshot {
    val immutableMessages = nextMessages.takeLast(MAX_PREVIEW_ITEMS)
    return copy(
      messages = immutableMessages,
      isSending = immutableMessages.any { it.role == RavenCatOverlayMessageRole.PENDING },
    )
  }

  /** 持久消息替换有限窗口；同一会话的未提交发送状态继续由原生输入区持有。 */
  fun withConversationPreview(sessionId: String?, committed: List<RavenCatOverlayMessage>): RavenCatOverlaySnapshot {
    val transient = if (sessionId == conversationSessionId) messages.filter { message ->
      message.messageId == null && !(message.role in listOf(RavenCatOverlayMessageRole.USER, RavenCatOverlayMessageRole.ASSISTANT) &&
        message.correlationId != null && committed.any { it.correlationId == message.correlationId })
    } else emptyList()
    val watermark = maxOf(
      if (sessionId == conversationSessionId) previewMessageWatermark else 0,
      committed.maxOfOrNull { checkNotNull(it.messageId) } ?: 0,
    )
    return copy(conversationSessionId = sessionId, previewMessageWatermark = watermark).withMessages(committed + transient)
  }

  /** 回复回调与会话投影可能交错，按持久身份合并并移除该回复的 pending。 */
  fun withReplyPreview(next: RavenCatOverlayMessage, requestCorrelationId: String? = null): RavenCatOverlaySnapshot {
    // 同步窗口已越过或删除该消息后，迟到的回复回调不能把旧消息重新追加回来。
    if (next.messageId != null && next.messageId <= previewMessageWatermark &&
      messages.none { it.messageId == next.messageId }) {
      return withMessages(messages.filterNot {
        it.role == RavenCatOverlayMessageRole.PENDING && it.correlationId == next.correlationId
      })
    }
    val retained = messages.filterNot {
      (it.role == RavenCatOverlayMessageRole.PENDING && requestCorrelationId != null && it.correlationId == requestCorrelationId) ||
        (it.role != RavenCatOverlayMessageRole.USER && next.correlationId != null &&
          it.correlationId == next.correlationId && it.messageId != next.messageId)
    }.toMutableList()
    val index = retained.indexOfLast {
      if (next.messageId != null) it.messageId == next.messageId
      else if (next.correlationId != null) it.correlationId == next.correlationId && it.role != RavenCatOverlayMessageRole.USER
      else next.role != RavenCatOverlayMessageRole.PENDING && it.role == RavenCatOverlayMessageRole.PENDING
    }
    if (index >= 0) retained[index] = next else retained.add(next)
    return copy(previewMessageWatermark = maxOf(previewMessageWatermark, next.messageId ?: 0)).withMessages(retained)
  }

  companion object {
    const val MAX_PREVIEW_ITEMS = 6
  }
}

internal data class RavenCatStagedScreenshot(
  val correlationId: String,
  val uri: String,
)

internal data class RavenCatOverlayMessage(
  val role: RavenCatOverlayMessageRole,
  val text: String,
  val correlationId: String? = null,
  val messageId: Long? = null,
)

internal enum class RavenCatOverlayMessageRole {
  USER,
  ASSISTANT,
  PENDING,
  ERROR,
}

internal data class RavenCatOverlayTargetPreview(
  val title: String,
  val subtitle: String? = null,
  val status: String? = null,
)

internal enum class RavenCatScreenshotState {
  IDLE,
  HIDING,
  CAPTURING,
  FAILED,
  TIMED_OUT,
}

internal enum class RavenCatBubbleDockSide {
  NONE,
  LEFT,
  RIGHT,
}
