package expo.modules.ravencatfloatinglayer.controller

import android.content.Context
import android.app.KeyguardManager
import android.content.pm.ApplicationInfo
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import expo.modules.androidoverlayruntime.DraggableOverlayBehavior
import expo.modules.androidoverlayruntime.OverlayBoundsResolver
import expo.modules.androidoverlayruntime.OverlayDragRelease
import expo.modules.androidoverlayruntime.OverlayEdgeSnapConfig
import expo.modules.androidoverlayruntime.OverlayGeometry
import expo.modules.androidoverlayruntime.OverlayHorizontalEdge
import expo.modules.androidoverlayruntime.OverlayPosition
import expo.modules.androidoverlayruntime.OverlayPositionStore
import expo.modules.androidoverlayruntime.OverlaySize
import expo.modules.androidoverlayruntime.OverlayWindowConfig
import expo.modules.androidoverlayruntime.OverlayWindowHost
import expo.modules.ravencatfloatinglayer.model.RavenCatBubbleDockSide
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayIntent
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlaySnapshot
import expo.modules.ravencatfloatinglayer.model.RavenCatPanelPage
import expo.modules.ravencatfloatinglayer.model.RavenCatPanelPagerPolicy
import expo.modules.ravencatfloatinglayer.view.RavenCatBubbleView
import expo.modules.ravencatfloatinglayer.view.RavenCatOverlayRenderer
import expo.modules.ravencatfloatinglayer.view.RavenCatPanelView
import expo.modules.ravencatfloatinglayer.BubbleSkinStore
import kotlin.math.max
import kotlin.math.roundToInt

/** 只管理 RavenCat bubble/panel 的窗口、焦点、位置与显示状态。 */
internal class RavenCatOverlayController(
  private val context: Context,
  private val onIntent: (RavenCatOverlayIntent) -> Unit,
) : RavenCatOverlayVisibilityHost {
  private val windowHost = OverlayWindowHost(context)
  private val boundsResolver = OverlayBoundsResolver(context)
  private val positionStore = OverlayPositionStore(context)
  private val renderer = RavenCatOverlayRenderer()
  private val mainHandler = Handler(Looper.getMainLooper())
  private var bubbleSize = dp(BubbleSkinStore.DEFAULT_SIZE_DP)
  private val bubbleOverlaySize get() = OverlaySize(bubbleSize, bubbleSize)
  private val bubbleEdgeSnapConfig = OverlayEdgeSnapConfig(
    detectionDistance = dp(EDGE_DETECTION_DISTANCE_DP),
    visibleRatio = DOCK_VISIBLE_RATIO,
  )

  private var bubbleView: RavenCatBubbleView? = null
  private var panelView: RavenCatPanelView? = null
  private var state = RavenCatOverlayWindowState.BUBBLE
  private var pendingEdgeSnap: Runnable? = null
  private var restoreBubbleX = 0
  private var restoreBubbleY = 0
  private var isBubbleAdded = false
  private var isPanelAdded = false
  private var isPanelFocusable = false
  private var bubbleDockSide = RavenCatBubbleDockSide.NONE
  private var latestSnapshot = RavenCatOverlaySnapshot()
  private val visibilityPolicy = RavenCatOverlayVisibilityPolicy()
  private var hasRestorableBubblePosition = false
  /** 当前 PANEL page（native presentation state）；非 PANEL 状态下无意义。 */
  private var panelPage = RavenCatPanelPage.CHAT
  var conversationDisplayedListener: ((String, List<Long>, List<String>) -> Unit)? = null
  private val panelGeometryState = RavenCatPanelWindowGeometryState()

  private val bubbleLayoutParams = OverlayWindowConfig(
    width = bubbleSize,
    height = bubbleSize,
    flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
      WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
      WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
  ).toLayoutParams()

  private val panelLayoutParams = OverlayWindowConfig(
    width = 0,
    height = 0,
    flags = panelWindowFlags(isFocusable = false),
    gravity = Gravity.TOP or Gravity.START,
    softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING,
  ).toLayoutParams().apply {
    // 不声明 cutout 模式时，系统会把悬浮窗 frame 压到状态栏之下，
    // 面板顶部就无法延伸到挖孔/状态栏区域。
    @Suppress("DEPRECATION")
    layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
  }

  fun render(snapshot: RavenCatOverlaySnapshot) {
    val togetherModeEnded = RavenCatTogetherPanelTransitionPolicy.shouldCollapse(
      previousTogetherActive = latestSnapshot.togetherListening != null,
      nextTogetherActive = snapshot.togetherListening != null,
      state = state,
      currentPage = panelPage,
    )
    latestSnapshot = snapshot
    updateBubbleSize(snapshot.bubbleSizeDp)
    if (togetherModeEnded) {
      // Together Activity 结束且用户正停在 TOGETHER 页时收起整个面板；
      // 停在 CHAT 页时保持 Chat Panel，只由 renderViews 关闭 TOGETHER page。
      collapse()
      return
    }
    renderViews()
  }

  fun currentState(): RavenCatOverlayWindowState = state

  /** 锁屏或熄屏不能把仍附着的窗口当作消息消费面，避免丢失系统提醒。 */
  fun isReplyPreviewVisible(): Boolean =
    state == RavenCatOverlayWindowState.PANEL && isPanelAdded && panelView != null &&
      panelPage == RavenCatPanelPage.CHAT &&
      context.getSystemService(PowerManager::class.java).isInteractive &&
      !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked

  /** Host 尚未确认前后台时保持 fail-closed；明确事实只影响窗口可见性。 */
  fun setAppForeground(active: Boolean?) {
    visibilityPolicy.setAppForeground(active)
    reconcileVisibility()
  }

  override fun acquireSuppression(reason: RavenCatOverlaySuppressionReason) {
    visibilityPolicy.acquire(reason)
    reconcileVisibility()
  }

  override fun releaseSuppression(reason: RavenCatOverlaySuppressionReason) {
    visibilityPolicy.release(reason)
    reconcileVisibility()
  }

  fun handleWindowIntent(intent: RavenCatOverlayIntent): Boolean {
    return when (intent) {
      RavenCatOverlayIntent.Expand -> {
        if (!revealDockedBubble()) {
          expand()
        }
        true
      }
      RavenCatOverlayIntent.Collapse -> {
        collapse()
        true
      }
      RavenCatOverlayIntent.RequestInputFocus -> {
        requestPanelInputFocus()
        true
      }
      RavenCatOverlayIntent.ReleaseInputFocus -> {
        releasePanelInputFocus()
        true
      }
      else -> false
    }
  }

  /**
   * 横竖屏切换等运行时配置变化时重新约束已显示的窗口位置。
   *
   * 触发来源是 RavenCatOverlayService.onConfigurationChanged；Service 实例不随配置变化
   * 重建，因此配置变化期间已加入窗口的小球/面板会停在旧坐标，越界或贴错边。这里在
   * 配置变化回调里按新 bounds 重新约束：
   * - BUBBLE：按当前贴边状态重新贴边（复用 DOCK_VISIBLE_RATIO，与 scheduleEdgeSnap
   *   公式一致）或 clamp 到新可见区，持久化新位置并更新窗口；
   * - PANEL：按新窗口指标重新计算面板几何；
   * - HIDDEN 或窗口未加入时 no-op。
   *
   * 不处理小窗运行时尺寸变化（独立于 orientation change，见 roadmap 4.3）。
   */
  fun handleConfigurationChanged() {
    if (isBubbleAdded) {
      val bounds = screenBounds()
      repositionBubbleForConfigurationChange(bounds)
      restoreBubbleX = bubbleLayoutParams.x
      restoreBubbleY = bubbleLayoutParams.y
      saveRestorableBubblePosition()
      updateBubbleLayout()
      renderViews()
    } else if (isPanelAdded) {
      applyPanelBounds(
        windowInsets = null,
        updateWindow = true,
        reason = RavenCatPanelGeometryUpdateReason.WINDOW_METRICS,
      )
    }
  }

  private fun repositionBubbleForConfigurationChange(bounds: Rect) {
    val visibleWidth = (bubbleSize * DOCK_VISIBLE_RATIO).roundToInt()
    bubbleLayoutParams.x = when (bubbleDockSide) {
      RavenCatBubbleDockSide.LEFT -> bounds.left + visibleWidth - bubbleSize
      RavenCatBubbleDockSide.RIGHT -> bounds.right - visibleWidth
      RavenCatBubbleDockSide.NONE -> clampBubbleVisibleX(bubbleLayoutParams.x, bounds)
    }
    bubbleLayoutParams.y = clampBubbleVisibleY(bubbleLayoutParams.y, bounds)
  }

  fun showBubble(): Boolean {
    // suppressed/unknown 不是运行时不可用；Service 仍需保持拥有权，等待明确的后台事实。
    if (!visibilityPolicy.shouldShow) return true
    if (state == RavenCatOverlayWindowState.HIDDEN) return restoreOverlay()
    if (isPanelAdded || isBubbleAdded) return true

    return addBubbleFromStoredPosition()
  }

  private fun addBubbleFromStoredPosition(): Boolean {
    val bounds = screenBounds()
    val storedPosition = positionStore.load(BUBBLE_POSITION_KEY)
    return addBubbleAt(
      x = storedPosition?.x ?: defaultX(bounds),
      y = storedPosition?.y ?: defaultY(bounds),
    )
  }

  fun expand() {
    if (
      !visibilityPolicy.shouldShow
      || state == RavenCatOverlayWindowState.PANEL
      || state == RavenCatOverlayWindowState.HIDDEN
    ) return
    cancelPendingEdgeSnap()
    val bounds = screenBounds()
    restoreBubbleX = normalizeBubbleXForRestore(bubbleLayoutParams.x, bounds)
    restoreBubbleY = clampBubbleVisibleY(bubbleLayoutParams.y, bounds)
    saveRestorableBubblePosition()
    removeBubbleView()

    // Together active 时点击 Bubble 默认落在 compact TOGETHER page；CHAT page 仍可通过 swipe 到达。
    panelPage = RavenCatPanelPagerPolicy.initialPage(latestSnapshot.togetherListening != null)
    applyPanelBounds(
      windowInsets = null,
      updateWindow = false,
      reason = RavenCatPanelGeometryUpdateReason.WINDOW_METRICS,
    )
    panelLayoutParams.flags = panelWindowFlags(isFocusable = false)
    isPanelFocusable = false
    val view = RavenCatPanelView(context, onIntent, ::handlePanelPageChanged) { sessionId, messageIds, clientMessageIds ->
      if (isReplyPreviewVisible() && sessionId == latestSnapshot.conversationSessionId) {
        conversationDisplayedListener?.invoke(sessionId, messageIds, clientMessageIds)
      }
    }
    view.setOnApplyWindowInsetsListener { _, insets ->
      applyPanelBounds(
        windowInsets = insets,
        updateWindow = true,
        reason = RavenCatPanelGeometryUpdateReason.VIEW_INSETS,
      )
      insets
    }
    view.setPage(panelPage)
    panelView = view
    try {
      windowHost.add(view, panelLayoutParams)
      isPanelAdded = true
      panelGeometryState.recordApplied(currentPanelGeometry())
      transition(RavenCatOverlayWindowEvent.EXPAND)
      renderViews()
    } catch (error: RuntimeException) {
      panelView = null
      isPanelAdded = false
      panelGeometryState.clear()
      transition(RavenCatOverlayWindowEvent.SHOW_BUBBLE)
      Log.e(TAG, "无法添加 RavenCat 悬浮面板", error)
      addBubbleAt(restoreBubbleX, restoreBubbleY)
    }
  }

  fun collapse() {
    if (state != RavenCatOverlayWindowState.PANEL) return
    hideKeyboard()
    removePanelView()
    if (addBubbleAt(restoreBubbleX, restoreBubbleY)) {
      scheduleEdgeSnapIfNeeded()
    }
  }

  private fun hideOverlay() {
    if (state == RavenCatOverlayWindowState.HIDDEN) return
    cancelPendingEdgeSnap()
    hideKeyboard()
    removePanelView()
    removeBubbleView()
    transition(RavenCatOverlayWindowEvent.HIDE)
  }

  private fun restoreOverlay(): Boolean {
    if (state != RavenCatOverlayWindowState.HIDDEN) return false
    // 任一隐藏原因全部释放后只恢复悬浮球，避免自动恢复面板或抢回键盘焦点。
    transition(RavenCatOverlayWindowEvent.SHOW_BUBBLE)
    return if (hasRestorableBubblePosition) {
      addBubbleAt(restoreBubbleX, restoreBubbleY)
    } else {
      addBubbleFromStoredPosition()
    }
  }

  fun removeAllViews() {
    cancelPendingEdgeSnap()
    hideKeyboard()
    removePanelView()
    removeBubbleView()
    transition(RavenCatOverlayWindowEvent.SHOW_BUBBLE)
  }

  private fun updateBubbleSize(sizeDp: Int) {
    val nextSize = dp(sizeDp)
    if (nextSize == bubbleSize) return
    cancelPendingEdgeSnap()
    bubbleSize = nextSize
    bubbleLayoutParams.width = nextSize
    bubbleLayoutParams.height = nextSize
    // Window、拖动几何和实际触摸范围共享同一个尺寸 owner。
    val view = bubbleView
    if (view != null) {
      bindBubbleDrag(view)
      repositionBubbleForConfigurationChange(screenBounds())
      restoreBubbleX = bubbleLayoutParams.x
      restoreBubbleY = bubbleLayoutParams.y
      saveRestorableBubblePosition()
      updateBubbleLayout()
      if (bubbleDockSide == RavenCatBubbleDockSide.NONE) scheduleEdgeSnapIfNeeded()
    } else if (hasRestorableBubblePosition) {
      val bounds = screenBounds()
      restoreBubbleX = clampBubbleVisibleX(restoreBubbleX, bounds)
      restoreBubbleY = clampBubbleVisibleY(restoreBubbleY, bounds)
      saveRestorableBubblePosition()
    }
  }

  private fun addBubble(): Boolean {
    val view = RavenCatBubbleView(context, onIntent)
    bindBubbleDrag(view)
    bubbleView = view
    return try {
      windowHost.add(view, bubbleLayoutParams)
      isBubbleAdded = true
      transition(RavenCatOverlayWindowEvent.SHOW_BUBBLE)
      renderViews()
      true
    } catch (error: RuntimeException) {
      bubbleView = null
      isBubbleAdded = false
      Log.e(TAG, "无法添加 RavenCat 悬浮球", error)
      false
    }
  }

  private fun bindBubbleDrag(view: RavenCatBubbleView) {
    view.setOnTouchListener(
      DraggableOverlayBehavior(
        context = context,
        overlaySize = bubbleOverlaySize,
        availableBounds = ::screenBounds,
        edgeSnapConfig = bubbleEdgeSnapConfig,
        currentPosition = { OverlayPosition(bubbleLayoutParams.x, bubbleLayoutParams.y) },
        onDragStarted = ::cancelPendingEdgeSnap,
        onPositionChanged = ::updateBubblePositionFromDrag,
        onDragFinished = ::handleBubbleDragFinished,
      ),
    )
  }

  private fun addBubbleAt(x: Int, y: Int): Boolean {
    val bounds = screenBounds()
    bubbleDockSide = RavenCatBubbleDockSide.NONE
    bubbleLayoutParams.x = normalizeBubbleXForRestore(x, bounds)
    bubbleLayoutParams.y = clampBubbleVisibleY(y, bounds)
    restoreBubbleX = bubbleLayoutParams.x
    restoreBubbleY = bubbleLayoutParams.y
    hasRestorableBubblePosition = true
    saveRestorableBubblePosition()
    return addBubble()
  }

  private fun removeBubbleView() {
    val view = bubbleView ?: return
    if (isBubbleAdded) {
      try {
        windowHost.remove(view)
      } catch (error: IllegalArgumentException) {
        Log.w(TAG, "RavenCat 悬浮球已被移除", error)
      }
    }
    bubbleView = null
    isBubbleAdded = false
  }

  private fun removePanelView() {
    val view = panelView ?: return
    if (isPanelAdded) {
      try {
        windowHost.remove(view)
      } catch (error: IllegalArgumentException) {
        Log.w(TAG, "RavenCat 悬浮面板已被移除", error)
      }
    }
    panelView = null
    isPanelAdded = false
    panelGeometryState.clear()
    if (state != RavenCatOverlayWindowState.HIDDEN) {
      transition(RavenCatOverlayWindowEvent.COLLAPSE)
    }
  }

  private fun updateBubblePositionFromDrag(position: OverlayPosition) {
    bubbleDockSide = RavenCatBubbleDockSide.NONE
    bubbleLayoutParams.x = position.x
    bubbleLayoutParams.y = position.y
    restoreBubbleX = position.x
    restoreBubbleY = position.y
    updateBubbleLayout()
    renderViews()
  }

  private fun handleBubbleDragFinished(release: OverlayDragRelease) {
    restoreBubbleX = release.position.x
    restoreBubbleY = release.position.y
    saveRestorableBubblePosition()
    scheduleEdgeSnap(release)
  }

  /**
   * page 切换：同一个 panel window 动态 resize，不 remove/recreate。
   * 切到 TOGETHER 必须释放键盘与 composer 焦点；切回 CHAT 不自动弹键盘，
   * 仍由用户点 composer 走 RequestInputFocus。
   */
  private fun handlePanelPageChanged(page: RavenCatPanelPage) {
    if (panelPage == page || state != RavenCatOverlayWindowState.PANEL) return
    panelPage = page
    if (page == RavenCatPanelPage.TOGETHER) {
      releasePanelInputFocus()
      hideKeyboard()
    }
    applyPanelBounds(
      windowInsets = null,
      updateWindow = true,
      reason = RavenCatPanelGeometryUpdateReason.PAGE_CHANGE,
    )
  }

  private fun requestPanelInputFocus() {
    val view = panelView ?: return
    if (!isPanelAdded) return
    setPanelFocusable(true)
    view.requestInputFocus()
  }

  private fun releasePanelInputFocus() {
    if (!isPanelAdded) return
    panelView?.clearInputFocus()
    setPanelFocusable(false)
  }

  private fun setPanelFocusable(focusable: Boolean) {
    val view = panelView ?: return
    if (isPanelFocusable == focusable) return
    isPanelFocusable = focusable
    panelLayoutParams.flags = panelWindowFlags(focusable)
    windowHost.update(view, panelLayoutParams)
  }

  private fun scheduleEdgeSnapIfNeeded() {
    scheduleEdgeSnap(
      OverlayGeometry.resolveDragRelease(
        position = OverlayPosition(bubbleLayoutParams.x, bubbleLayoutParams.y),
        size = bubbleOverlaySize,
        bounds = screenBounds(),
        edgeSnapConfig = bubbleEdgeSnapConfig,
      ),
    )
  }

  private fun scheduleEdgeSnap(release: OverlayDragRelease) {
    val targetPosition = release.snapPosition ?: return
    val targetSide = when (release.snapEdge) {
      OverlayHorizontalEdge.LEFT -> RavenCatBubbleDockSide.LEFT
      OverlayHorizontalEdge.RIGHT -> RavenCatBubbleDockSide.RIGHT
      null -> return
    }
    cancelPendingEdgeSnap()
    pendingEdgeSnap = Runnable {
      bubbleLayoutParams.x = targetPosition.x
      bubbleLayoutParams.y = targetPosition.y
      bubbleDockSide = targetSide
      updateBubbleLayout()
      renderViews()
      pendingEdgeSnap = null
    }
    mainHandler.postDelayed(pendingEdgeSnap!!, EDGE_SNAP_DELAY_MS)
  }

  private fun revealDockedBubble(): Boolean {
    if (!visibilityPolicy.shouldShow) return false
    val bounds = screenBounds()
    val visibleX = normalizeBubbleXForRestore(bubbleLayoutParams.x, bounds)
    if (visibleX == bubbleLayoutParams.x) return false

    bubbleLayoutParams.x = visibleX
    bubbleLayoutParams.y = clampBubbleVisibleY(bubbleLayoutParams.y, bounds)
    restoreBubbleX = bubbleLayoutParams.x
    restoreBubbleY = bubbleLayoutParams.y
    saveRestorableBubblePosition()
    bubbleDockSide = RavenCatBubbleDockSide.NONE
    updateBubbleLayout()
    renderViews()
    scheduleEdgeSnapIfNeeded()
    return true
  }

  private fun cancelPendingEdgeSnap() {
    val pending = pendingEdgeSnap ?: return
    mainHandler.removeCallbacks(pending)
    pendingEdgeSnap = null
  }

  private fun updateBubbleLayout() {
    val view = bubbleView ?: return
    if (isBubbleAdded) windowHost.update(view, bubbleLayoutParams)
  }

  private fun renderViews() {
    renderer.render(
      latestSnapshot.copy(
        isExpanded = state == RavenCatOverlayWindowState.PANEL,
        bubbleDockSide = bubbleDockSide,
      ),
      bubbleView,
      panelView,
    )
  }

  private fun transition(event: RavenCatOverlayWindowEvent) {
    state = RavenCatOverlayWindowStateReducer.reduce(state, event)
  }

  private fun reconcileVisibility() {
    if (visibilityPolicy.shouldShow) {
      // 统一走 Service/Runtime 的 canonical show 路径：它同时覆盖初次 attach
      // 的 BUBBLE 无窗口状态与 suppression 释放后的 HIDDEN 恢复。
      showBubble()
    } else if (isBubbleAdded || isPanelAdded || state == RavenCatOverlayWindowState.PANEL) {
      // 初次 attach 尚未加入窗口时只保留 fail-closed gate；不要用 (0, 0) 伪造恢复位置。
      hideOverlay()
    }
  }

  private fun clampBubbleVisibleX(value: Int, bounds: Rect) = OverlayGeometry.constrainVisible(
    OverlayPosition(value, bounds.top), bubbleOverlaySize, bounds,
  ).x

  private fun clampBubbleVisibleY(value: Int, bounds: Rect) = OverlayGeometry.constrainVisible(
    OverlayPosition(bounds.left, value), bubbleOverlaySize, bounds,
  ).y

  private fun normalizeBubbleXForRestore(value: Int, bounds: Rect) =
    clampBubbleVisibleX(value, bounds)

  private fun defaultX(bounds: Rect) =
    clampBubbleVisibleX(bounds.right - bubbleSize - dp(EDGE_MARGIN_DP), bounds)

  private fun defaultY(bounds: Rect) =
    clampBubbleVisibleY(bounds.top + dp(INITIAL_TOP_MARGIN_DP), bounds)

  /**
   * 面板窗口几何按 page 分支：
   * - CHAT：窗口顶到屏幕顶端，背景延伸到状态栏/挖孔区域；宽=整屏，
   *   内容区通过 contentTopInset 下移，避开状态栏。
   * - TOGETHER：独立悬浮小胶囊，位于 available bounds（已排除状态栏/挖孔）
   *   顶部留白处，水平居中；不延伸进状态栏，contentTopInset 恒为 0。
   * cutout mode 保持 ALWAYS：胶囊 y 已在安全区内不会覆盖状态栏，
   * 动态切换 cutout flag 只会制造窗口闪烁。
   */
  private fun applyPanelBounds(
    windowInsets: WindowInsets?,
    updateWindow: Boolean,
    reason: RavenCatPanelGeometryUpdateReason,
  ) {
    val screen = boundsResolver.resolveScreenBounds()
    val metricsAvailable = boundsResolver.resolveAvailableBounds()
    // TOGETHER 的小窗口不能消费自身收到的 insets，否则会形成
    // window geometry → window insets → updateViewLayout → window insets 的反馈环。
    val viewInsetsAvailable = if (panelPage == RavenCatPanelPage.CHAT && windowInsets != null) {
      boundsResolver.resolveAvailableBounds(windowInsets)
    } else {
      null
    }
    val layout = RavenCatPanelWindowGeometryPolicy.resolve(
      page = panelPage,
      screen = screen,
      metricsAvailable = metricsAvailable,
      viewInsetsAvailable = viewInsetsAvailable,
      density = context.resources.displayMetrics.density,
    )
    setPanelWindowBounds(layout, updateWindow, reason)
  }

  private fun setPanelWindowBounds(
    layout: RavenCatPanelWindowLayout,
    updateWindow: Boolean,
    reason: RavenCatPanelGeometryUpdateReason,
  ) {
    val geometry = layout.geometry
    panelLayoutParams.width = geometry.width
    panelLayoutParams.height = geometry.height
    panelLayoutParams.x = geometry.x
    panelLayoutParams.y = geometry.y
    val view = panelView
    view?.setContentTopInset(layout.contentTopInset)
    if (updateWindow && isPanelAdded && view != null) {
      panelGeometryState.applyIfChanged(geometry) {
        tracePanelGeometryUpdate(reason, geometry)
        windowHost.update(view, panelLayoutParams)
      }
    }
  }

  private fun currentPanelGeometry() = RavenCatPanelWindowGeometry(
    x = panelLayoutParams.x,
    y = panelLayoutParams.y,
    width = panelLayoutParams.width,
    height = panelLayoutParams.height,
  )

  private fun tracePanelGeometryUpdate(
    reason: RavenCatPanelGeometryUpdateReason,
    geometry: RavenCatPanelWindowGeometry,
  ) {
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
    Log.d(
      TAG,
      "panel update page=$panelPage reason=$reason geometry=" +
        "(${geometry.x},${geometry.y},${geometry.width},${geometry.height})",
    )
  }

  private fun saveRestorableBubblePosition() {
    val bounds = screenBounds()
    positionStore.save(
      BUBBLE_POSITION_KEY,
      OverlayPosition(
        normalizeBubbleXForRestore(restoreBubbleX, bounds),
        clampBubbleVisibleY(restoreBubbleY, bounds),
      ),
    )
  }

  private fun hideKeyboard() {
    val view = panelView ?: return
    val manager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    manager.hideSoftInputFromWindow(view.windowToken, 0)
  }

  private fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
  private fun screenBounds(): Rect = boundsResolver.resolveAvailableBounds()

  private fun panelWindowFlags(isFocusable: Boolean): Int {
    var flags = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
      WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
    if (!isFocusable) flags = flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
    return flags
  }

  companion object {
    private const val TAG = "RavenCatFloating"
    private const val BUBBLE_POSITION_KEY = "ravencat_bubble"
    private const val EDGE_MARGIN_DP = 12
    private const val EDGE_DETECTION_DISTANCE_DP = 28
    private const val DOCK_VISIBLE_RATIO = 0.6f
    private const val INITIAL_TOP_MARGIN_DP = 64
    private const val EDGE_SNAP_DELAY_MS = 1200L
  }
}

internal data class RavenCatPanelWindowGeometry(
  val x: Int,
  val y: Int,
  val width: Int,
  val height: Int,
)

internal data class RavenCatPanelWindowLayout(
  val geometry: RavenCatPanelWindowGeometry,
  val contentTopInset: Int,
)

internal enum class RavenCatPanelGeometryUpdateReason {
  PAGE_CHANGE,
  VIEW_INSETS,
  WINDOW_METRICS,
}

/** 只在 WindowManager 成功应用后推进缓存，失败时保留旧事实供下次重试。 */
internal class RavenCatPanelWindowGeometryState {
  var lastApplied: RavenCatPanelWindowGeometry? = null
    private set
  private var applying: RavenCatPanelWindowGeometry? = null

  fun applyIfChanged(geometry: RavenCatPanelWindowGeometry, apply: () -> Unit): Boolean {
    if (geometry == lastApplied || geometry == applying) return false
    applying = geometry
    return try {
      apply()
      lastApplied = geometry
      true
    } finally {
      applying = null
    }
  }

  fun recordApplied(geometry: RavenCatPanelWindowGeometry) {
    lastApplied = geometry
  }

  fun clear() {
    lastApplied = null
    applying = null
  }
}

/** page 决定 inset authority；Controller 只负责读取边界并执行窗口副作用。 */
internal object RavenCatPanelWindowGeometryPolicy {
  fun resolve(
    page: RavenCatPanelPage,
    screen: Rect,
    metricsAvailable: Rect,
    viewInsetsAvailable: Rect?,
    density: Float,
  ): RavenCatPanelWindowLayout = when (page) {
    RavenCatPanelPage.CHAT -> {
      val available = viewInsetsAvailable ?: metricsAvailable
      val topInset = max(available.top - screen.top, 0)
      val height = topInset + RavenCatPanelPagerPolicy.chatContentHeightPx(
        availableHeightPx = available.height(),
        density = density,
      )
      RavenCatPanelWindowLayout(
        geometry = RavenCatPanelWindowGeometry(
          x = screen.left,
          y = screen.top,
          width = screen.width(),
          height = height,
        ),
        contentTopInset = topInset,
      )
    }
    RavenCatPanelPage.TOGETHER -> {
      val capsule = RavenCatPanelPagerPolicy.togetherCapsuleBoundsPx(
        availableLeft = metricsAvailable.left,
        availableTop = metricsAvailable.top,
        availableWidthPx = metricsAvailable.width(),
        availableHeightPx = metricsAvailable.height(),
        density = density,
      )
      RavenCatPanelWindowLayout(
        geometry = RavenCatPanelWindowGeometry(
          x = capsule.x,
          y = capsule.y,
          width = capsule.width,
          height = capsule.height,
        ),
        contentTopInset = 0,
      )
    }
  }
}

/**
 * Together 只影响现有 PANEL 的 page 可用性；projection 变化本身不得创建新的窗口状态。
 * 结束时是否收起到 Bubble 由当前 page 决定（见 RavenCatPanelPagerPolicy）。
 */
internal object RavenCatTogetherPanelTransitionPolicy {
  fun shouldCollapse(
    previousTogetherActive: Boolean,
    nextTogetherActive: Boolean,
    state: RavenCatOverlayWindowState,
    currentPage: RavenCatPanelPage,
  ): Boolean = previousTogetherActive &&
    !nextTogetherActive &&
    RavenCatPanelPagerPolicy.shouldCollapseOnTogetherEnd(state, currentPage)
}
