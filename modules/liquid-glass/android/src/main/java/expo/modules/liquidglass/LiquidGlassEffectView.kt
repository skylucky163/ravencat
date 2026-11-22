package expo.modules.liquidglass

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.util.Log
import android.view.View
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.ceil

/** 共享场景背景录制，只为当前表面运行裁剪、折射、色散与模糊。 */
class LiquidGlassEffectView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private var sceneId = DEFAULT_SCENE_ID
  private var boundCapture: LiquidGlassSceneCapture? = null
  private val contentNode = RenderNode("KimiPhoneLiquidGlassEffect")
  private val liquidShader = RuntimeShader(loadShaderSource())
  private var cachedBlurEffect: RenderEffect? = null
  private var cachedBlurRadius = Float.NaN
  private var retryGeneration = 0
  private var retryAttempt = 0
  private var isAggregatedVisible = true
  private var lastDiagnostic: String? = null
  private val sampleBounds = Rect()
  private val recordedBounds = Rect()
  private var lastContentOffsetX = Int.MIN_VALUE
  private var lastContentOffsetY = Int.MIN_VALUE
  private var lastCaptureRevision = Long.MIN_VALUE
  private val sourcePosition = IntArray(2)
  private val effectPosition = IntArray(2)

  private var blurRadius = DEFAULT_BLUR_RADIUS
  private var cornerRadius = DEFAULT_CORNER_RADIUS
  private var refractionHeight = DEFAULT_REFRACTION_HEIGHT
  private var refractionOffset = DEFAULT_REFRACTION_OFFSET
  private var dispersion = DEFAULT_DISPERSION
  private var tintColor = DEFAULT_TINT_COLOR
  private var tintAlpha = DEFAULT_TINT_ALPHA
  private var fluidShape: FloatArray? = null

  init {
    orientation = VERTICAL
    setWillNotDraw(false)
    isClickable = false
    isFocusable = false
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun setSceneId(value: String) {
    val nextSceneId = value.trim().ifEmpty {
      diagnose("收到空 sceneId，效果层回退到默认 app 场景。")
      DEFAULT_SCENE_ID
    }
    if (nextSceneId == sceneId) {
      return
    }

    if (isAttachedToWindow) {
      LiquidGlassSceneRegistry.unregisterEffect(sceneId, this)
    }
    releaseCapture()
    sceneId = nextSceneId
    if (isAttachedToWindow) {
      LiquidGlassSceneRegistry.registerEffect(sceneId, this)
    }
  }

  fun setBlurRadius(value: Float) {
    blurRadius = value.coerceIn(0.01f, MAX_BLUR_RADIUS)
    applyRenderEffect()
  }

  fun setCornerRadius(value: Float) {
    cornerRadius = value.coerceAtLeast(0f)
    applyRenderEffect()
  }

  fun setRefractionHeight(value: Float) {
    refractionHeight = value.coerceIn(MIN_REFRACTION_HEIGHT, MAX_REFRACTION_HEIGHT)
    applyRenderEffect()
  }

  fun setRefractionOffset(value: Float) {
    refractionOffset = value
      .coerceIn(MIN_REFRACTION_OFFSET, MAX_REFRACTION_OFFSET)
    applyRenderEffect()
  }

  fun setDispersion(value: Float) {
    dispersion = value.coerceIn(0f, 1f)
    applyRenderEffect()
  }

  fun setTintColor(value: String) {
    val parsedColor = try {
      Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
      diagnose("场景 $sceneId 收到无效 tintColor：$value；保留上一个颜色。")
      return
    }
    tintColor = parsedColor
    applyRenderEffect()
  }

  fun setTintAlpha(value: Float) {
    tintAlpha = value.coerceIn(0f, 1f)
    applyRenderEffect()
  }

  fun setFluidShape(value: List<Double>?) {
    // 这是原生参数边界；内部绘制只消费已建立的六元组契约。
    require(value == null || (value.size == 6 && value.all { it.isFinite() } &&
      value[0] >= 0 && value[3] > 0 && value[4] > 0 && value[5] > 0)) {
      "fluidShape 必须包含栏顶、球心、正球半径与正融合半径，共六个有限数值。"
    }
    fluidShape = value?.map { dp(it.toFloat()) }?.toFloatArray()
    applyRenderEffect()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    isAggregatedVisible = isShown
    LiquidGlassSceneRegistry.registerEffect(sceneId, this)
  }

  override fun onDetachedFromWindow() {
    cancelRetry()
    LiquidGlassSceneRegistry.unregisterEffect(sceneId, this)
    releaseCapture()
    super.onDetachedFromWindow()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    isAggregatedVisible = isVisible
    if (isVisible) {
      scheduleBinding()
    } else {
      cancelRetry()
      // 原生 Stack 的退出动画会先把页面标记为不可见，再移除 View。
      // 保留最后一帧显示列表，避免动画期间露出 React Native 普通表面底色。
      pauseCapture()
    }
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    resetContentGeometry()
    boundCapture?.let(::onSharedSceneFrame)
    if (boundCapture == null && width > 0 && height > 0 && isAttachedToWindow && isAggregatedVisible) {
      // 尺寸就绪后立即尝试绑定，把 attach 后首帧空窗从 16ms 重试周期压到当帧。
      scheduleBinding()
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (boundCapture == null || !contentNode.hasDisplayList()) {
      return
    }
    if (!canvas.isHardwareAccelerated) {
      reportRenderingFailure("场景 $sceneId 的液态玻璃只能在硬件加速 Canvas 上绘制。")
      return
    }
    canvas.drawRenderNode(contentNode)
  }

  internal fun onSceneSourceChanged() {
    releaseCapture()
    if (isAttachedToWindow && isAggregatedVisible) {
      scheduleBinding()
    }
  }

  internal fun onSharedSceneFrame(capture: LiquidGlassSceneCapture) {
    if (capture !== boundCapture || !isAttachedToWindow || !isAggregatedVisible) {
      return
    }
    val geometryChanged = recordSharedContent(capture)
    val sourceChanged = lastCaptureRevision != capture.revision
    lastCaptureRevision = capture.revision
    // preDraw 本身不是新帧来源；只有背景或采样位置变化才请求绘制，避免空闲自刷新。
    if (geometryChanged || sourceChanged) invalidate()
  }

  fun dispose() {
    cancelRetry()
    if (isAttachedToWindow) {
      // RN 在返回手势开始时就 drop 视图实例，但退出动画期间 View 仍 attached 且继续
      // onDraw；此时释放绑定会让动画全程露出 RN 兜底色。清理推迟到 onDetachedFromWindow。
      return
    }
    LiquidGlassSceneRegistry.unregisterEffect(sceneId, this)
    releaseCapture()
  }

  private fun scheduleBinding() {
    retryGeneration += 1
    retryAttempt = 0
    attemptBinding(retryGeneration)
  }

  private fun postBindingAttempt(generation: Int) {
    postDelayed(
      { attemptBinding(generation) },
      RETRY_DELAY_MS
    )
  }

  private fun attemptBinding(generation: Int) {
    if (
      generation != retryGeneration ||
      !isAttachedToWindow ||
      !isAggregatedVisible
    ) {
      return
    }

    val source = LiquidGlassSceneRegistry.backdropFor(sceneId)
    when {
      source == null || !source.isAttachedToWindow -> retry(generation)
      width <= 0 || height <= 0 || source.width <= 0 || source.height <= 0 ->
        retry(generation)
      sourceContainsEffect(source) -> {
        reportRenderingFailure(
          "场景 $sceneId 的背景源包含效果 View，已拒绝递归采样；" +
            "请让 LiquidGlassBackdrop 与 LiquidGlassEffect 成为兄弟节点。" +
            " ${bindingState(source)}"
        )
      }
      else -> {
        val capture = LiquidGlassSceneRegistry.captureFor(sceneId)
          ?: return retry(generation)
        bind(capture)
      }
    }
  }

  private fun retry(generation: Int) {
    retryAttempt += 1
    if (retryAttempt < MAX_RETRY_ATTEMPTS) {
      postBindingAttempt(generation)
      return
    }

    val source = LiquidGlassSceneRegistry.backdropFor(sceneId)
    reportRenderingFailure(
      "场景 $sceneId 在 ${MAX_RETRY_ATTEMPTS * RETRY_DELAY_MS}ms 内没有可用背景源；" +
        "已停止原生渲染，并保留 React Native 主题表面。" +
        " ${bindingState(source)}"
    )
  }

  private fun bind(capture: LiquidGlassSceneCapture) {
    if (boundCapture === capture) {
      capture.attach(this)
      lastDiagnostic = null
      onSharedSceneFrame(capture)
      return
    }

    releaseCapture()
    boundCapture = capture
    capture.attach(this)
    lastDiagnostic = null
  }

  private fun pauseCapture() {
    boundCapture?.detach(this)
  }

  private fun releaseCapture() {
    boundCapture?.detach(this)
    boundCapture = null
    contentNode.discardDisplayList()
    contentNode.setRenderEffect(null)
    resetContentGeometry()
    invalidate()
  }

  private fun recordSharedContent(capture: LiquidGlassSceneCapture): Boolean {
    val source = capture.source ?: return false
    if (!capture.renderNode.hasDisplayList() || !resolveSampleBounds()) {
      return false
    }

    // 背景与 Modal 不在同一窗口，采样偏移必须使用共同的屏幕坐标系。
    source.getLocationOnScreen(sourcePosition)
    getLocationOnScreen(effectPosition)
    val offsetX = sourcePosition[0] - effectPosition[0] - sampleBounds.left
    val offsetY = sourcePosition[1] - effectPosition[1] - sampleBounds.top
    if (
      sampleBounds == recordedBounds &&
      offsetX == lastContentOffsetX &&
      offsetY == lastContentOffsetY &&
      contentNode.hasDisplayList()
    ) {
      return false
    }

    contentNode.setPosition(sampleBounds)
    val canvas = contentNode.beginRecording()
    canvas.translate(offsetX.toFloat(), offsetY.toFloat())
    canvas.drawRenderNode(capture.renderNode)
    contentNode.endRecording()

    recordedBounds.set(sampleBounds)
    lastContentOffsetX = offsetX
    lastContentOffsetY = offsetY
    applyRenderEffect()
    return true
  }

  private fun resolveSampleBounds(): Boolean {
    if (width <= 0 || height <= 0) return false
    val window = rootView
    if (width <= window.width && height <= window.height) {
      sampleBounds.set(0, 0, width, height)
      return true
    }

    // 玻璃的离屏纹理随可见区域滚动，避免展开长消息时申请整条气泡大小的 GPU 图层。
    if (!getLocalVisibleRect(sampleBounds)) return false
    // 为折射、色散与模糊留出邻域，避免采样被滚动裁切线截断。
    val padding = ceil(dp(refractionOffset) * (1f + dispersion) + 3f * blurRadius).toInt()
    sampleBounds.inset(-padding, -padding)
    return sampleBounds.intersect(0, 0, width, height)
  }

  private fun applyRenderEffect() {
    if (recordedBounds.isEmpty) {
      return
    }

    liquidShader.setFloatUniform(
      "size",
      floatArrayOf(width.toFloat(), height.toFloat())
    )
    liquidShader.setFloatUniform("surfaceOffset", recordedBounds.left.toFloat(), recordedBounds.top.toFloat())
    val shape = fluidShape
    liquidShader.setFloatUniform("fluidEnabled", if (shape == null) 0f else 1f)
    liquidShader.setFloatUniform("fluidBar", floatArrayOf(shape?.get(0) ?: 0f, shape?.get(5) ?: 1f))
    liquidShader.setFloatUniform("fluidBall", floatArrayOf(
      shape?.get(1) ?: 0f, shape?.get(2) ?: 0f,
      shape?.get(3) ?: 1f, shape?.get(4) ?: 1f
    ))
    val resolvedCornerRadius = dp(cornerRadius).coerceAtMost(height / 2f)
    liquidShader.setFloatUniform(
      "cornerRadii",
      floatArrayOf(
        resolvedCornerRadius,
        resolvedCornerRadius,
        resolvedCornerRadius,
        resolvedCornerRadius
      )
    )
    liquidShader.setFloatUniform("refractionHeight", dp(refractionHeight))
    liquidShader.setFloatUniform("refractionAmount", -dp(refractionOffset))
    liquidShader.setFloatUniform("depthEffect", DEFAULT_DEPTH_EFFECT)
    liquidShader.setFloatUniform("chromaticAberration", dispersion)
    liquidShader.setFloatUniform("contrast", 0f)
    liquidShader.setFloatUniform("whitePoint", 0f)
    liquidShader.setFloatUniform("chromaMultiplier", 1f)
    liquidShader.setFloatUniform(
      "tintColor",
      floatArrayOf(
        Color.red(tintColor) / 255f,
        Color.green(tintColor) / 255f,
        Color.blue(tintColor) / 255f
      )
    )
    liquidShader.setFloatUniform("tintAlpha", tintAlpha)

    val blurEffect = if (blurRadius > 0.01f) {
      if (cachedBlurEffect == null || cachedBlurRadius != blurRadius) {
        cachedBlurEffect = RenderEffect.createBlurEffect(
          blurRadius,
          blurRadius,
          Shader.TileMode.CLAMP
        )
        cachedBlurRadius = blurRadius
      }
      cachedBlurEffect
    } else {
      null
    }
    val shaderEffect = RenderEffect.createRuntimeShaderEffect(liquidShader, "content")
    val finalEffect = blurEffect?.let {
      RenderEffect.createChainEffect(shaderEffect, it)
    } ?: shaderEffect
    contentNode.setRenderEffect(finalEffect)
    invalidate()
  }

  private fun sourceContainsEffect(source: ViewGroup): Boolean {
    var ancestor = parent
    while (ancestor is View) {
      if (ancestor === source) {
        return true
      }
      ancestor = ancestor.parent
    }
    return source === this
  }

  private fun bindingState(source: ViewGroup?): String =
    "效果层(attached=$isAttachedToWindow, shown=$isShown, " +
      "aggregatedVisible=$isAggregatedVisible, size=${width}x$height)；" +
      if (source == null) {
        "Registry 中不存在该场景的背景源。"
      } else {
        "背景源(attached=${source.isAttachedToWindow}, shown=${source.isShown}, " +
          "size=${source.width}x${source.height})。"
      }

  private fun resetContentGeometry() {
    lastCaptureRevision = Long.MIN_VALUE
    recordedBounds.setEmpty()
  }

  private fun cancelRetry() {
    retryGeneration += 1
    retryAttempt = 0
  }

  private fun diagnose(message: String) {
    if (!isDebuggable || lastDiagnostic == message) {
      return
    }
    lastDiagnostic = message
    Log.w(TAG, message)
  }

  private fun reportRenderingFailure(message: String) {
    cancelRetry()
    releaseCapture()
    if (isDebuggable) {
      throw IllegalStateException(message)
    }
    Log.e(TAG, message)
  }

  private fun loadShaderSource(): String =
    resources
      .openRawResource(R.raw.ravencat_liquidglass_effect)
      .bufferedReader()
      .use { it.readText() }

  private fun dp(value: Float): Float = value * resources.displayMetrics.density

  private val isDebuggable: Boolean
    get() =
      context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

  private companion object {
    const val DEFAULT_SCENE_ID = "app"
    const val DEFAULT_BLUR_RADIUS = 12f
    const val DEFAULT_CORNER_RADIUS = 32f
    const val DEFAULT_REFRACTION_HEIGHT = 22f
    const val DEFAULT_REFRACTION_OFFSET = 68f
    const val DEFAULT_DISPERSION = 0.55f
    const val DEFAULT_TINT_COLOR = Color.WHITE
    const val DEFAULT_TINT_ALPHA = 0.16f
    const val DEFAULT_DEPTH_EFFECT = 0.3f
    const val MIN_REFRACTION_HEIGHT = 12f
    const val MAX_REFRACTION_HEIGHT = 50f
    const val MIN_REFRACTION_OFFSET = 20f
    const val MAX_REFRACTION_OFFSET = 120f
    const val MAX_BLUR_RADIUS = 50f
    const val RETRY_DELAY_MS = 16L
    const val MAX_RETRY_ATTEMPTS = 60
    const val TAG = "LiquidGlassEffect"
  }
}
