package expo.modules.ravencatfloatinglayer.view

import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayMessage
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayMessageRole
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlaySnapshot
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayTargetPreview

internal class RavenCatConversationView(
  context: Context,
  private val onMessagesDisplayed: (String, List<Long>, List<String>) -> Unit,
) : LinearLayout(context) {
  private val targetDotView = View(context)
  private val targetTitleView = TextView(context)
  private val targetStatusView = TextView(context)
  private val messageContainer = LinearLayout(context)
  private val placeholderView = TextView(context)
  private val scrollView = ScrollView(context)
  private var renderedMessages: List<RavenCatOverlayMessage> = emptyList()
  private var sessionId: String? = null
  private var displayedSessionId: String? = null
  private var displayedMessageIds: List<Long> = emptyList()
  private var displayedClientMessageIds: List<String> = emptyList()
  private val visibleRect = Rect()
  private val preDrawListener = ViewTreeObserver.OnPreDrawListener {
    reportVisibleMessages()
    true
  }

  init {
    orientation = VERTICAL
    addView(createTargetRow())
    addView(
      createMessageArea(),
      LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = dp(6) },
    )
  }

  fun render(snapshot: RavenCatOverlaySnapshot) {
    sessionId = snapshot.conversationSessionId
    renderTarget(snapshot.targetPreview)
    renderMessages(snapshot.messages)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnPreDrawListener(preDrawListener)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(preDrawListener)
    displayedSessionId = null
    displayedMessageIds = emptyList()
    displayedClientMessageIds = emptyList()
    super.onDetachedFromWindow()
  }

  /** 布局、滚动及分页完成后，以被 viewport 裁剪后的真实可见行确认阅读。 */
  private fun reportVisibleMessages() {
    val currentSessionId = sessionId ?: return
    val visibleMessages = if (isShown) renderedMessages.filterIndexed { index, message ->
      message.role == RavenCatOverlayMessageRole.ASSISTANT &&
        messageContainer.getChildAt(index).getGlobalVisibleRect(visibleRect)
    } else emptyList()
    val visibleIds = visibleMessages.mapNotNull { it.messageId }
    val visibleClients = visibleMessages.mapNotNull { it.correlationId }
    if (currentSessionId == displayedSessionId && visibleIds == displayedMessageIds && visibleClients == displayedClientMessageIds) return
    displayedSessionId = currentSessionId
    displayedMessageIds = visibleIds
    displayedClientMessageIds = visibleClients
    if (visibleIds.isNotEmpty() || visibleClients.isNotEmpty()) onMessagesDisplayed(currentSessionId, visibleIds, visibleClients)
  }

  /** CHAT 下拉只在手势起点位于消息区且消息已到顶部时交给 page 切换。 */
  fun canStartPageSwipeFrom(
    coordinateView: View,
    x: Float,
    y: Float,
  ): Boolean = !scrollView.containsPointFrom(coordinateView, x, y) ||
    !scrollView.canScrollVertically(-1)

  /** 目标行压缩成单行：状态点 + 目标名 + 状态，不再占用大卡片。 */
  private fun createTargetRow(): View {
    return LinearLayout(context).apply {
      orientation = HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(4), dp(2), dp(4), dp(6))

      addView(
        targetDotView,
        LayoutParams(dp(6), dp(6)).apply { rightMargin = dp(6) },
      )
      targetTitleView.apply {
        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12.5f)
        typeface = Typeface.DEFAULT_BOLD
        includeFontPadding = false
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
      }
      addView(targetTitleView, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      targetStatusView.apply {
        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 11.5f)
        includeFontPadding = false
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        setTextColor(Color.parseColor("#9CA3AF"))
        setPadding(dp(8), 0, 0, 0)
      }
      addView(targetStatusView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    }
  }

  private fun createMessageArea(): View {
    return FrameLayout(context).apply {
      background = GradientDrawable().apply {
        cornerRadius = dp(16).toFloat()
        setColor(Color.parseColor("#F5F6F8"))
      }

      messageContainer.orientation = VERTICAL
      scrollView.apply {
        isFillViewport = false
        overScrollMode = OVER_SCROLL_NEVER
        setPadding(dp(10), dp(10), dp(10), dp(4))
        clipToPadding = false
        addView(
          messageContainer,
          FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
          ),
        )
      }
      placeholderView.apply {
        text = "暂无消息"
        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12.5f)
        setTextColor(Color.parseColor("#9CA3AF"))
        gravity = Gravity.CENTER
        includeFontPadding = false
      }
      addView(scrollView, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      addView(placeholderView, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
  }

  private fun renderTarget(target: RavenCatOverlayTargetPreview?) {
    if (target == null) {
      targetTitleView.text = "未选择目标"
      targetStatusView.text = "由主 App 决定发送目标"
      targetTitleView.setTextColor(Color.parseColor("#6B7280"))
      setTargetDotColor("#D1D5DB")
      return
    }
    targetTitleView.text = target.title
    targetStatusView.text = target.subtitle ?: statusTextForTarget(target.status)
    targetTitleView.setTextColor(targetColorForStatus(target.status))
    setTargetDotColor(dotColorForStatus(target.status))
  }

  private fun renderMessages(messages: List<RavenCatOverlayMessage>) {
    // 草稿、截图和目标状态更新不重建消息，也不把用户正在阅读的位置拉回底部。
    if (messages == renderedMessages) return
    val followLatest = !scrollView.canScrollVertically(1)
    renderedMessages = messages
    messageContainer.removeAllViews()
    placeholderView.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE
    messages.forEach { message ->
      messageContainer.addView(createMessageRow(message))
    }
    if (messages.isNotEmpty() && followLatest) {
      scrollView.post { scrollView.fullScroll(View.FOCUS_DOWN) }
    }
  }

  private fun createMessageRow(message: RavenCatOverlayMessage): View {
    return LinearLayout(context).apply {
      orientation = HORIZONTAL
      gravity = if (message.role == RavenCatOverlayMessageRole.USER) Gravity.END else Gravity.START
      addView(
        TextView(context).apply {
          text = message.text
          setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f)
          maxLines = 4
          ellipsize = TextUtils.TruncateAt.END
          includeFontPadding = false
          setTextColor(textColorForRole(message.role))
          setPadding(dp(12), dp(8), dp(12), dp(8))
          maxWidth = dp(270)
          background = roundedBackground(
            backgroundColorForRole(message.role),
            borderColorForRole(message.role),
          )
        },
        LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT),
      )
    }.also {
      it.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
        bottomMargin = dp(6)
      }
    }
  }

  private fun backgroundColorForRole(role: RavenCatOverlayMessageRole) = when (role) {
    RavenCatOverlayMessageRole.USER -> "#3A9BEF"
    RavenCatOverlayMessageRole.ERROR -> "#FEF2F2"
    RavenCatOverlayMessageRole.PENDING, RavenCatOverlayMessageRole.ASSISTANT -> "#FFFFFF"
  }

  private fun borderColorForRole(role: RavenCatOverlayMessageRole) = when (role) {
    RavenCatOverlayMessageRole.USER -> "#3A9BEF"
    RavenCatOverlayMessageRole.PENDING -> "#E5E7EB"
    RavenCatOverlayMessageRole.ERROR -> "#FECACA"
    RavenCatOverlayMessageRole.ASSISTANT -> "#E8ECF3"
  }

  private fun textColorForRole(role: RavenCatOverlayMessageRole) = when (role) {
    RavenCatOverlayMessageRole.USER -> Color.WHITE
    RavenCatOverlayMessageRole.PENDING -> Color.parseColor("#6B7280")
    RavenCatOverlayMessageRole.ERROR -> Color.parseColor("#B91C1C")
    RavenCatOverlayMessageRole.ASSISTANT -> Color.parseColor("#111827")
  }

  private fun statusTextForTarget(status: String?) = when (status?.lowercase()) {
    "disabled" -> "悬浮发送已停用"
    "error" -> "目标需要处理"
    else -> "可发送"
  }

  private fun targetColorForStatus(status: String?) = when (status?.lowercase()) {
    "disabled" -> Color.parseColor("#6B7280")
    "error" -> Color.parseColor("#B91C1C")
    else -> Color.parseColor("#111827")
  }

  private fun dotColorForStatus(status: String?) = when (status?.lowercase()) {
    "disabled" -> "#9CA3AF"
    "error" -> "#EF4444"
    else -> "#22C55E"
  }

  private fun setTargetDotColor(color: String) {
    targetDotView.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.parseColor(color))
    }
  }

  private fun roundedBackground(fill: String, stroke: String) = GradientDrawable().apply {
    cornerRadius = dp(14).toFloat()
    setColor(Color.parseColor(fill))
    setStroke(dp(1), Color.parseColor(stroke))
  }

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

}

/** 判断 coordinateView 坐标系中的点是否落在目标 View 内。 */
internal fun View.containsPointFrom(
  coordinateView: View,
  x: Float,
  y: Float,
): Boolean {
  val targetLocation = IntArray(2)
  val coordinateLocation = IntArray(2)
  getLocationOnScreen(targetLocation)
  coordinateView.getLocationOnScreen(coordinateLocation)
  val screenX = coordinateLocation[0] + x
  val screenY = coordinateLocation[1] + y
  return screenX >= targetLocation[0] &&
    screenX < targetLocation[0] + width &&
    screenY >= targetLocation[1] &&
    screenY < targetLocation[1] + height
}
