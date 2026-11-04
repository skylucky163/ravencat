package expo.modules.messagebubble

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.MotionEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class MessageBubbleView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val renderer = NineSliceRenderer()
  private var source: BubbleSource? = null
  private var bitmap: Bitmap? = null
  private var generation = 0
  private val onLoadError by EventDispatcher()

  init {
    setWillNotDraw(false)
    isClickable = false
    isLongClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun setSource(next: BubbleSource) {
    val previousUri = source?.uri
    source = next
    if (previousUri == next.uri && bitmap != null) { invalidate(); return }
    bitmap = null
    val request = ++generation
    BubbleBitmapCache.load(next.uri).whenComplete { loaded, error ->
      post {
        // FlashList 会复用 View；旧请求不能覆写新素材或已销毁实例。
        if (request != generation) return@post
        if (error != null) {
          onLoadError(mapOf("uri" to next.uri, "message" to "气泡图片无法读取，请重新导入"))
        } else {
          bitmap = loaded
          invalidate()
        }
      }
    }
    invalidate()
  }

  fun dispose() { generation++; bitmap = null; source = null }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val image = bitmap ?: return
    val config = source ?: return
    renderer.draw(canvas, image, width, height, config.left, config.top, config.right, config.bottom,
      resources.displayMetrics.density * config.scale)
  }

  // 背景没有业务 children；所有命中都交给原有消息/附件 responder。
  override fun onInterceptTouchEvent(event: MotionEvent) = false
  override fun onTouchEvent(event: MotionEvent) = false
}
