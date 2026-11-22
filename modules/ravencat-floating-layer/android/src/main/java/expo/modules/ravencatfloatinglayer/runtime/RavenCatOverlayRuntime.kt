package expo.modules.ravencatfloatinglayer.runtime

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import expo.modules.androidoverlayruntime.OverlayInteractionExclusion
import expo.modules.ravencatfloatinglayer.BubbleSkinStore
import expo.modules.ravencatfloatinglayer.RavenCatTogetherListeningPresentationStore
import expo.modules.ravencatfloatinglayer.controller.RavenCatAppForegroundActivityTracker
import expo.modules.ravencatfloatinglayer.controller.RavenCatAppForegroundObserver
import expo.modules.ravencatfloatinglayer.controller.RavenCatHandlerDelayScheduler
import expo.modules.ravencatfloatinglayer.controller.RavenCatOverlayController
import expo.modules.ravencatfloatinglayer.controller.RavenCatOverlaySuppressionReason
import expo.modules.ravencatfloatinglayer.controller.RavenCatOverlayWindowState
import expo.modules.ravencatfloatinglayer.controller.RavenCatScreenshotVisibilityCoordinator
import expo.modules.ravencatfloatinglayer.controller.RavenCatScreenshotVisibilityResult
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayIntent
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayMessage
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayMessageRole
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlaySnapshot
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayTargetPreview
import expo.modules.ravencatfloatinglayer.model.RavenCatScreenshotState
import expo.modules.ravencatfloatinglayer.model.RavenCatStagedScreenshot
import expo.modules.ravencatfloatinglayer.model.RavenCatTogetherListeningPresentation

/** 持有原生 UI snapshot，并把有限 intent 路由到窗口或独立后台任务 owner。 */
internal object RavenCatOverlayRuntime {
  private var runtimeContext: Context? = null
  private var controller: RavenCatOverlayController? = null
  private var messageDispatcher: RavenCatFloatingMessageDispatcher? = null
  private var screenshotCoordinator: RavenCatScreenshotVisibilityCoordinator? = null
  private var snapshot = RavenCatOverlaySnapshot()
  private var hasRecoveredProcessStaleRequests = false
  /** Host 尚未上报 AppState 时保持 null，native presentation 必须 fail-closed。 */
  private var appForeground: Boolean? = null
  /** native Activity lifecycle fail-safe 的最新事实；与 Host bridge 的 reason 互相独立。 */
  private var nativeAppForeground = false
  private var appForegroundObserver: RavenCatAppForegroundObserver? = null
  private var unsubscribeInteractionExclusion: (() -> Unit)? = null

  /** 可见消息身份由原生 View 回报，Host 统一提交 Chat 已读。 */
  var conversationDisplayedListener: ((String, List<Long>, List<String>) -> Unit)? = null
  var conversationRefreshListener: (() -> Unit)? = null

  /**
   * 进程级 native fail-safe：由 Application.ActivityLifecycleCallbacks 驱动，
   * 即使 JS 线程崩溃、Host AppState bridge 未执行，RavenCat Activity resume
   * 也会立即抑制 overlay。只控制窗口可见性，不启动或停止 Service。
   * 幂等：重复 install 不会重复计数。
   */
  fun installAppForegroundFailSafe(application: Application) {
    if (appForegroundObserver != null) return
    val tracker = RavenCatAppForegroundActivityTracker(
      scheduler = RavenCatHandlerDelayScheduler(Handler(Looper.getMainLooper())),
      onForegroundChanged = ::handleNativeAppForegroundChanged,
    )
    val observer = RavenCatAppForegroundObserver(tracker)
    appForegroundObserver = observer
    application.registerActivityLifecycleCallbacks(observer)
  }

  fun uninstallAppForegroundFailSafe(application: Application) {
    val observer = appForegroundObserver ?: return
    application.unregisterActivityLifecycleCallbacks(observer)
    appForegroundObserver = null
  }

  private fun handleNativeAppForegroundChanged(active: Boolean) {
    nativeAppForeground = active
    val windowController = controller ?: return
    if (active) {
      windowController.acquireSuppression(
        RavenCatOverlaySuppressionReason.APP_FOREGROUND_NATIVE_ACTIVITY,
      )
    } else {
      windowController.releaseSuppression(
        RavenCatOverlaySuppressionReason.APP_FOREGROUND_NATIVE_ACTIVITY,
      )
    }
  }

  fun attach(context: Context) {
    if (controller != null) return
    val applicationContext = context.applicationContext
    runtimeContext = applicationContext
    val nextController = RavenCatOverlayController(applicationContext, ::handleIntent)
    nextController.conversationDisplayedListener = { sessionId, messageIds, clientMessageIds ->
      conversationDisplayedListener?.invoke(sessionId, messageIds, clientMessageIds)
    }
    val nextDispatcher = RavenCatFloatingMessageDispatcher(applicationContext)
    controller = nextController
    unsubscribeInteractionExclusion = OverlayInteractionExclusion.subscribe { excluded ->
      if (excluded) nextController.acquireSuppression(RavenCatOverlaySuppressionReason.EXCLUSIVE_INTERACTION)
      else nextController.releaseSuppression(RavenCatOverlaySuppressionReason.EXCLUSIVE_INTERACTION)
    }
    messageDispatcher = nextDispatcher
    screenshotCoordinator = RavenCatScreenshotVisibilityCoordinator(
      visibilityHost = nextController,
      scheduler = RavenCatHandlerDelayScheduler(Handler(Looper.getMainLooper())),
      onCaptureReady = ::dispatchPreparedShot,
      onVisibilityResult = ::handleScreenshotResult,
    )
    nextController.setAppForeground(appForeground)
    if (nativeAppForeground) {
      // Service 在 App 前台期间 attach：补齐 fail-safe suppression，避免闪出悬浮层。
      nextController.acquireSuppression(
        RavenCatOverlaySuppressionReason.APP_FOREGROUND_NATIVE_ACTIVITY,
      )
    }
    snapshot = snapshotWithSelectedBubbleSkin(applicationContext)
      .copy(togetherListening = RavenCatTogetherListeningPresentationStore.load(applicationContext))
    nextController.render(snapshot)
    conversationRefreshListener?.invoke()
    if (!hasRecoveredProcessStaleRequests) {
      hasRecoveredProcessStaleRequests = true
      nextDispatcher.recoverStaleRequests { request, _ ->
        // 进程重启后草稿已失效，清理任务不是用户消息，不能展示成发送失败。
        if (request.action == "discard_screen") return@recoverStaleRequests
        updateReplyPreview(
          text = if (request.action == "screen") {
            "RavenCat 重启后已取消过期截图，请重新点击 Shot。"
          } else {
            "RavenCat 重启前的消息状态不确定，为避免重复发送，请确认聊天记录后重试。"
          },
          status = "error",
          correlationId = request.correlationId,
        )
      }
    }
  }

  fun detach() {
    unsubscribeInteractionExclusion?.invoke()
    unsubscribeInteractionExclusion = null
    discardStagedScreenshot()
    screenshotCoordinator?.cancelAll()
    screenshotCoordinator = null
    controller?.removeAllViews()
    controller = null
    messageDispatcher = null
    runtimeContext = null
    snapshot = RavenCatOverlaySnapshot(
      conversationSessionId = snapshot.conversationSessionId,
      previewMessageWatermark = snapshot.previewMessageWatermark,
      messages = snapshot.messages.filter { it.messageId != null },
    )
  }

  fun showBubble(): Boolean = controller?.showBubble() == true

  /** 由 Host 下发唯一的前后台事实；不启动或停止 Service。 */
  fun setAppForeground(active: Boolean) {
    appForeground = active
    controller?.setAppForeground(active)
  }

  /**
   * 配置变化（横竖屏切换等）由 Service.onConfigurationChanged 转发到这里。
   * Service 实例不随配置变化重建，因此常驻窗口需要主动按新 bounds 重新约束位置/几何。
   */
  fun handleConfigurationChanged() {
    controller?.handleConfigurationChanged()
  }

  fun expand() {
    handleIntent(RavenCatOverlayIntent.Expand)
  }

  fun collapse() {
    handleIntent(RavenCatOverlayIntent.Collapse)
  }

  /** 旧 API 保留可调用，但无请求身份时不能安全恢复当前窗口；活跃请求由超时兜底。 */
  fun restoreScreenshotWithoutRequestIdentity() = Unit

  fun completeScreenshot(requestId: String, succeeded: Boolean, screenshotUri: String?): Boolean {
    val accepted = screenshotCoordinator?.complete(requestId, succeeded) == true
    if (accepted && succeeded) {
      val next = RavenCatStagedScreenshot(requestId, checkNotNull(screenshotUri))
      discardStagedScreenshot()
      updateSnapshot(snapshot.copy(stagedScreenshot = next))
    }
    return accepted
  }

  fun refreshBubbleSkin() {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      Handler(Looper.getMainLooper()).post { refreshBubbleSkin() }
      return
    }
    val windowController = controller ?: return
    snapshot = snapshotWithSelectedBubbleSkin(windowControllerContext())
    windowController.render(snapshot)
  }

  fun updateConversationPreview(sessionId: String?, messages: List<RavenCatOverlayMessage>) {
    updateSnapshot(snapshot.withConversationPreview(sessionId, messages))
  }

  fun updateReplyPreview(text: String, status: String?, correlationId: String?, sessionId: String? = null, messageId: Long? = null, requestCorrelationId: String? = null): Boolean {
    if (sessionId != null && sessionId != snapshot.conversationSessionId) return false
    val next = RavenCatOverlayMessage(
      role = previewRoleForStatus(status),
      text = normalizedPreviewText(text, status),
      correlationId = correlationId?.takeIf { it.isNotBlank() },
      messageId = messageId,
    )
    updateSnapshot(snapshot.withReplyPreview(next, requestCorrelationId))

    // 回复投影只返回交付结果；已读由 View 的实际可见消息回执统一承担。
    val displayed =
      status?.lowercase() == "reply"
      && !correlationId.isNullOrBlank()
      && controller?.isReplyPreviewVisible() == true
      && (messageId == null || snapshot.messages.any { it.messageId == messageId })
    return displayed
  }

  fun clearReplyPreview() {
    updateSnapshot(snapshot.withMessages(emptyList()))
  }

  fun updateTargetPreview(title: String, subtitle: String?, status: String?) {
    val normalizedTitle = title.trim()
    updateSnapshot(
      snapshot.copy(
        targetPreview = if (normalizedTitle.isEmpty()) {
          null
        } else {
          RavenCatOverlayTargetPreview(
            title = normalizedTitle,
            subtitle = subtitle?.trim()?.takeIf { it.isNotEmpty() },
            status = status?.trim()?.takeIf { it.isNotEmpty() },
          )
        },
      ),
    )
  }

  fun clearTargetPreview() {
    updateSnapshot(snapshot.copy(targetPreview = null))
  }

  /**
   * 接收 Host 已提交的只读 Together projection；即使 Service 尚未 attach，也先保存
   * projection-only cache，待下次 attach 恢复。这里不启动 Service、不改变窗口状态。
   */
  fun updateTogetherListeningPresentation(
    context: Context,
    presentation: RavenCatTogetherListeningPresentation,
  ) {
    val applicationContext = context.applicationContext
    RavenCatTogetherListeningPresentationStore.save(applicationContext, presentation)
    updateSnapshot(snapshot.copy(togetherListening = presentation))
  }

  /**
   * 按 Activity identity 清理 Together projection。迟到的旧 Activity clear 不能清掉
   * 当前 projection；activityId 为空时才允许清理任意 stale cache。
   */
  fun clearTogetherListeningPresentation(context: Context, activityId: String?) {
    val applicationContext = context.applicationContext
    val persisted = RavenCatTogetherListeningPresentationStore.load(applicationContext)
    val inMemory = snapshot.togetherListening
    val current = persisted ?: inMemory
    if (!RavenCatTogetherListeningPresentationStore.matchesActivity(current, activityId)) {
      return
    }
    if (persisted != null) {
      RavenCatTogetherListeningPresentationStore.clear(applicationContext, activityId)
    }
    if (inMemory != null && (activityId == null || inMemory.activityId == activityId)) {
      updateSnapshot(snapshot.copy(togetherListening = null))
    }
  }

  private fun handleIntent(intent: RavenCatOverlayIntent) {
    val windowController = controller ?: return
    if (windowController.handleWindowIntent(intent)) {
      updateSnapshot(
        snapshot.copy(isExpanded = windowController.currentState() == RavenCatOverlayWindowState.PANEL),
      )
      if (intent == RavenCatOverlayIntent.Expand) conversationRefreshListener?.invoke()
      return
    }

    when (intent) {
      is RavenCatOverlayIntent.DraftChanged -> updateSnapshot(snapshot.copy(draft = intent.text))
      is RavenCatOverlayIntent.Send -> sendMessage(intent)
      is RavenCatOverlayIntent.Shot -> beginShot(intent.correlationId)
      RavenCatOverlayIntent.RemoveScreenshot -> discardStagedScreenshot()
      RavenCatOverlayIntent.Cancel -> {
        discardStagedScreenshot()
        updateSnapshot(snapshot.copy(draft = ""))
      }
      RavenCatOverlayIntent.OpenApp,
      RavenCatOverlayIntent.Expand,
      RavenCatOverlayIntent.Collapse,
      RavenCatOverlayIntent.RequestInputFocus,
      RavenCatOverlayIntent.ReleaseInputFocus -> Unit
    }
  }

  private fun sendMessage(intent: RavenCatOverlayIntent.Send) {
    val screenshot = snapshot.stagedScreenshot
    if (messageDispatcher?.dispatch(
        "message", intent.text, intent.correlationId, screenshot?.correlationId,
      ) != true) {
      updateReplyPreview(
        "无法启动 RavenCat 后台消息任务，请重新打开应用后再试。",
        "error",
        intent.correlationId,
      )
      return
    }
    appendUserMessage(
      if (screenshot == null) intent.text else "📷 ${intent.text}".trim(),
      intent.correlationId,
    )
    updateSnapshot(snapshot.copy(draft = "", stagedScreenshot = null))
    updateReplyPreview("正在启动后台回复...", "pending", intent.correlationId)
  }

  private fun beginShot(correlationId: String) {
    updateSnapshot(
      snapshot.copy(
        screenshotState = RavenCatScreenshotState.HIDING,
      ),
    )
    screenshotCoordinator?.begin(correlationId)
  }

  private fun dispatchPreparedShot(correlationId: String) {
    updateSnapshot(snapshot.copy(screenshotState = RavenCatScreenshotState.CAPTURING))
    if (messageDispatcher?.dispatch("screen", "", correlationId) != true) {
      updateReplyPreview(
        "无法启动 RavenCat 后台消息任务，请重新打开应用后再试。",
        "error",
        correlationId,
      )
      screenshotCoordinator?.complete(correlationId, succeeded = false)
    }
  }

  private fun handleScreenshotResult(
    requestId: String,
    result: RavenCatScreenshotVisibilityResult,
  ) {
    updateSnapshot(
      snapshot.copy(
        screenshotState = when (result) {
          RavenCatScreenshotVisibilityResult.SUCCEEDED -> RavenCatScreenshotState.IDLE
          RavenCatScreenshotVisibilityResult.FAILED -> RavenCatScreenshotState.FAILED
          RavenCatScreenshotVisibilityResult.TIMED_OUT -> RavenCatScreenshotState.TIMED_OUT
        },
      ),
    )
  }

  private fun discardStagedScreenshot() {
    val screenshot = snapshot.stagedScreenshot ?: return
    messageDispatcher?.dispatch(
      "discard_screen", "", "${screenshot.correlationId}:discard", screenshot.correlationId,
    )
    updateSnapshot(snapshot.copy(stagedScreenshot = null))
  }

  private fun appendUserMessage(text: String, correlationId: String) {
    val messages = snapshot.messages + RavenCatOverlayMessage(
      role = RavenCatOverlayMessageRole.USER,
      text = text,
      correlationId = correlationId,
    )
    updateSnapshot(snapshot.withMessages(messages))
  }

  private fun updateSnapshot(nextSnapshot: RavenCatOverlaySnapshot) {
    snapshot = nextSnapshot
    controller?.render(snapshot)
  }

  private fun previewRoleForStatus(status: String?) = when (status?.lowercase()) {
    "pending" -> RavenCatOverlayMessageRole.PENDING
    "error" -> RavenCatOverlayMessageRole.ERROR
    else -> RavenCatOverlayMessageRole.ASSISTANT
  }

  private fun normalizedPreviewText(text: String, status: String?): String {
    val trimmed = text.trim()
    if (trimmed.isNotEmpty()) return trimmed
    return when (status?.lowercase()) {
      "pending" -> "Waiting for reply..."
      "error" -> "Unable to send message."
      else -> "Reply preview is empty."
    }
  }

  private fun snapshotWithSelectedBubbleSkin(context: Context): RavenCatOverlaySnapshot {
    val store = BubbleSkinStore(context)
    val skins = store.list()
    val fallback = skins.first { it.id == BubbleSkinStore.DEFAULT_SKIN_ID }
    val selected = skins.firstOrNull { it.id == store.selectedId() } ?: fallback
    return snapshot.copy(bubbleSkin = selected, bubbleFallbackSkin = fallback, bubbleSizeDp = selected.sizeDp)
  }

  private fun windowControllerContext(): Context {
    return checkNotNull(runtimeContext) { "RavenCat Overlay runtime 尚未连接" }
  }

}
