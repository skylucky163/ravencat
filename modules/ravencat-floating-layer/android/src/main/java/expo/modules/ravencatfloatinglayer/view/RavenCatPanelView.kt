package expo.modules.ravencatfloatinglayer.view

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ImageView
import android.widget.TextView
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayIntent
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlaySnapshot
import expo.modules.ravencatfloatinglayer.model.RavenCatPanelPage
import expo.modules.ravencatfloatinglayer.model.RavenCatPanelPagerPolicy

/**
 * PANEL 窗口内容：共享 header 始终存在（两个 page 的收起入口位置与语义一致），
 * header 下方是 CHAT / TOGETHER 双页 pager。page 切换只改变内容、窗口几何与
 * 背景形态（CHAT 贴顶大面板 / TOGETHER 悬浮胶囊），不创建新窗口。
 */
internal class RavenCatPanelView(
  context: Context,
  onIntent: (RavenCatOverlayIntent) -> Unit,
  onPageChanged: (RavenCatPanelPage) -> Unit,
  onMessagesDisplayed: (String, List<Long>, List<String>) -> Unit,
) : FrameLayout(context) {
  private val conversationView = RavenCatConversationView(context, onMessagesDisplayed)
  private val composerView = RavenCatComposerView(context, onIntent)
  private val togetherContentView = RavenCatTogetherListeningPanelContentView(context)
  private val headerView = RavenCatPanelHeaderView(context, onIntent)
  private val chatContentLayout = LinearLayout(context)
  private val chatActionsLayout = LinearLayout(context)
  private val screenshotTray = LinearLayout(context)
  private val screenshotPreview = ImageView(context)
  private var renderedScreenshotUri: String? = null
  private val pagerView: RavenCatPanelPagerView
  private val contentLayout: LinearLayout
  private var contentTopInset = 0
  private var currentPage = RavenCatPanelPage.CHAT

  // CHAT：窗口顶到屏幕顶端，顶部直角延伸进状态栏区域，只保留底部圆角。
  private val chatBackground = GradientDrawable().apply {
    val corner = dp(CHAT_BOTTOM_CORNER_RADIUS_DP).toFloat()
    cornerRadii = floatArrayOf(0f, 0f, 0f, 0f, corner, corner, corner, corner)
    setColor(PANEL_BACKGROUND_COLOR)
  }

  // TOGETHER：悬浮胶囊，四角全圆角；窗口不贴屏幕边缘，无需直角延伸。
  private val capsuleBackground = GradientDrawable().apply {
    cornerRadius = dp(RavenCatPanelPagerPolicy.TOGETHER_CAPSULE_CORNER_RADIUS_DP).toFloat()
    // Chronometer 每秒只重绘 View；胶囊 Surface 保持不透明，避免 OEM 合成器整块闪动。
    setColor(CAPSULE_BACKGROUND_COLOR)
  }

  init {
    background = chatBackground
    elevation = dp(12).toFloat()
    isClickable = true

    chatContentLayout.apply {
      orientation = LinearLayout.VERTICAL
      addView(
        conversationView,
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f),
      )
      screenshotTray.apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        visibility = View.GONE
        screenshotPreview.apply {
          scaleType = ImageView.ScaleType.CENTER_CROP
          contentDescription = "待发送的截图"
        }
        addView(screenshotPreview, LinearLayout.LayoutParams(dp(56), dp(56)))
        addView(TextView(context).apply {
          text = "截图已暂存\n可补充消息后发送"
          setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12f)
          setTextColor(Color.parseColor("#374151"))
          setPadding(dp(10), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        addView(TextView(context).apply {
          text = "×"
          setTextSize(TypedValue.COMPLEX_UNIT_DIP, 24f)
          gravity = Gravity.CENTER
          contentDescription = "移除待发送截图"
          setOnClickListener { onIntent(RavenCatOverlayIntent.RemoveScreenshot) }
        }, LinearLayout.LayoutParams(dp(40), dp(40)))
      }
      addView(screenshotTray, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
      ).apply { topMargin = dp(8) })
      chatActionsLayout.apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(
          RavenCatShotActionView(context, onIntent),
          LinearLayout.LayoutParams(dp(40), dp(40)).apply { rightMargin = dp(8) },
        )
        addView(
          composerView,
          LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
      }
      addView(
        chatActionsLayout,
        LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT,
          LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(8) },
      )
    }

    pagerView = RavenCatPanelPagerView(
      context = context,
      chatPage = chatContentLayout,
      togetherPage = togetherContentView,
      canStartChatPageSwipe = ::canStartChatPageSwipe,
      onPageChanged = { page ->
        // 先让 Controller 一次性应用目标窗口几何，再只对 View content 做入场动画。
        onPageChanged(page)
        applyPagePresentation(page, animate = true)
      },
    )

    contentLayout = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      addView(headerView)
      addView(
        pagerView,
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f),
      )
    }
    addView(
      contentLayout,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
    applyContentPadding()
  }

  /** CHAT 页的状态栏/挖孔高度：内容整体下移，背景仍延伸到屏幕顶端；TOGETHER 胶囊恒为 0。 */
  fun setContentTopInset(topInset: Int) {
    if (contentTopInset == topInset) return
    contentTopInset = topInset
    applyContentPadding()
  }

  /** 打开面板时的初始 page（Together active → TOGETHER 胶囊页），不触发回调。 */
  fun setPage(page: RavenCatPanelPage) {
    pagerView.showPage(page, notify = false)
    applyPagePresentation(page, animate = false)
  }

  fun render(snapshot: RavenCatOverlaySnapshot) {
    pagerView.setTogetherPageAvailable(snapshot.togetherListening != null)
    togetherContentView.render(snapshot.togetherListening)
    conversationView.render(snapshot)
    composerView.render(snapshot)
    val screenshotUri = snapshot.stagedScreenshot?.uri
    screenshotTray.visibility = if (screenshotUri == null) View.GONE else View.VISIBLE
    if (screenshotUri != renderedScreenshotUri) {
      renderedScreenshotUri = screenshotUri
      if (screenshotUri == null) screenshotPreview.setImageDrawable(null)
      else screenshotPreview.setImageURI(Uri.parse(screenshotUri))
    }
  }

  fun requestInputFocus() = composerView.requestInputFocus()

  fun clearInputFocus() = composerView.clearInputFocus()

  /** page 决定背景形态、header 样式与外层 padding；初始页与 swipe 切页共用此入口。 */
  private fun applyPagePresentation(page: RavenCatPanelPage, animate: Boolean) {
    currentPage = page
    background = if (page == RavenCatPanelPage.TOGETHER) capsuleBackground else chatBackground
    headerView.setPage(page)
    applyContentPadding()
    if (animate) {
      animatePageEntry(page)
    } else {
      resetPageTransform()
    }
  }

  /**
   * Q 弹只作用于窗口内的内容；WindowManager geometry 仍由 Controller 单次提交。
   * 不旋转、不逐帧 resize，避免把 presentation 动画重新接回 insets/geometry 链路。
   */
  private fun animatePageEntry(page: RavenCatPanelPage) {
    contentLayout.animate().cancel()
    contentLayout.alpha = PAGE_ENTRY_START_ALPHA
    contentLayout.translationY = dp(
      if (page == RavenCatPanelPage.CHAT) -PAGE_ENTRY_OFFSET_DP else PAGE_ENTRY_OFFSET_DP,
    ).toFloat()
    contentLayout.scaleX = PAGE_ENTRY_START_SCALE_X
    contentLayout.scaleY = PAGE_ENTRY_START_SCALE_Y
    contentLayout.animate()
      .alpha(1f)
      .translationY(0f)
      .scaleX(1f)
      .scaleY(1f)
      .setDuration(PAGE_ENTRY_DURATION_MS)
      .setInterpolator(OvershootInterpolator(PAGE_ENTRY_OVERSHOOT_TENSION))
      .withEndAction(::resetPageTransform)
      .start()
  }

  private fun resetPageTransform() {
    contentLayout.alpha = 1f
    contentLayout.translationY = 0f
    contentLayout.scaleX = 1f
    contentLayout.scaleY = 1f
  }

  private fun applyContentPadding() {
    if (currentPage == RavenCatPanelPage.TOGETHER) {
      // 胶囊总高只有 84dp：外层 padding 收紧，内容间距由 Together 内容区自己控制。
      contentLayout.setPadding(
        dp(CAPSULE_HORIZONTAL_PADDING_DP),
        dp(CAPSULE_VERTICAL_PADDING_DP),
        dp(CAPSULE_HORIZONTAL_PADDING_DP),
        dp(CAPSULE_VERTICAL_PADDING_DP),
      )
    } else {
      contentLayout.setPadding(
        dp(CHAT_HORIZONTAL_PADDING_DP),
        contentTopInset + dp(CHAT_TOP_PADDING_DP),
        dp(CHAT_HORIZONTAL_PADDING_DP),
        dp(CHAT_BOTTOM_PADDING_DP),
      )
    }
  }

  private fun canStartChatPageSwipe(x: Float, y: Float): Boolean {
    // composer / Shot 是明确交互区，不参与分页；其余非消息区可直接下拉。
    if (chatActionsLayout.containsPointFrom(pagerView, x, y)) return false
    if (screenshotTray.visibility == View.VISIBLE && screenshotTray.containsPointFrom(pagerView, x, y)) return false
    return conversationView.canStartPageSwipeFrom(pagerView, x, y)
  }

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

  private companion object {
    const val CHAT_BOTTOM_CORNER_RADIUS_DP = 20
    const val CHAT_HORIZONTAL_PADDING_DP = 14
    const val CHAT_TOP_PADDING_DP = 4
    const val CHAT_BOTTOM_PADDING_DP = 12
    const val CAPSULE_HORIZONTAL_PADDING_DP = 12
    const val CAPSULE_VERTICAL_PADDING_DP = 6
    const val PAGE_ENTRY_OFFSET_DP = 10
    const val PAGE_ENTRY_DURATION_MS = 220L
    const val PAGE_ENTRY_START_ALPHA = 0.72f
    const val PAGE_ENTRY_START_SCALE_X = 0.97f
    const val PAGE_ENTRY_START_SCALE_Y = 0.94f
    const val PAGE_ENTRY_OVERSHOOT_TENSION = 0.8f
    val PANEL_BACKGROUND_COLOR: Int = Color.parseColor("#FCFFFFFF")
    val CAPSULE_BACKGROUND_COLOR: Int = Color.WHITE
  }
}
