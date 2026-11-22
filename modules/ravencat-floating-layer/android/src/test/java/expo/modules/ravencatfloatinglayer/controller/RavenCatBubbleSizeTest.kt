package expo.modules.ravencatfloatinglayer.controller

import android.content.Context
import android.app.KeyguardManager
import android.os.PowerManager
import android.content.ContextWrapper
import android.os.Looper
import android.graphics.Rect
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.WindowMetrics
import android.view.WindowInsets
import expo.modules.androidoverlayruntime.OverlayBoundsResolver
import expo.modules.ravencatfloatinglayer.BubbleSkinStore
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlaySnapshot
import java.time.Duration
import kotlin.math.roundToInt
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** 验证尺寸同时驱动真实 Window 参数、拖动约束和贴边几何。 */
@Config(sdk = [35])
@RunWith(RobolectricTestRunner::class)
class RavenCatBubbleSizeTest {
  @Test fun `locked or sleeping screen cannot consume message notifications`() {
    val base: Context = RuntimeEnvironment.getApplication()
    val recording = RecordingWindowManager(base.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
    val context = object : ContextWrapper(base) {
      override fun getSystemService(name: String): Any? = if (name == Context.WINDOW_SERVICE) recording else super.getSystemService(name)
    }
    val controller = RavenCatOverlayController(context) {}
    val power = shadowOf(base.getSystemService(PowerManager::class.java))
    val keyguard = shadowOf(base.getSystemService(KeyguardManager::class.java))
    power.setIsInteractive(true)
    keyguard.setKeyguardLocked(false)
    controller.setAppForeground(false)
    controller.expand()
    assertTrue(controller.isReplyPreviewVisible())
    power.setIsInteractive(false)
    assertFalse(controller.isReplyPreviewVisible())
    power.setIsInteractive(true)
    keyguard.setKeyguardLocked(true)
    assertFalse(controller.isReplyPreviewVisible())
    controller.removeAllViews()
  }

  @Test
  fun `resizing updates same bubble window and dragging uses new size at both edges`() {
    val base: Context = RuntimeEnvironment.getApplication()
    val recording = RecordingWindowManager(base.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
    val context = object : ContextWrapper(base) {
      override fun getSystemService(name: String): Any? = if (name == Context.WINDOW_SERVICE) recording else super.getSystemService(name)
    }
    val controller = RavenCatOverlayController(context) {}
    val builtin = BubbleSkinStore(base).list().first()
    val snapshot = RavenCatOverlaySnapshot(bubbleSkin = builtin, bubbleFallbackSkin = builtin, bubbleSizeDp = 32)
    controller.render(snapshot)
    controller.setAppForeground(false)
    val view = recording.views.keys.single()
    val density = base.resources.displayMetrics.density
    assertEquals((32 * density).toInt(), recording.views.getValue(view).width)
    controller.render(snapshot.copy(bubbleSizeDp = 96))
    assertSame(view, recording.views.keys.single())
    val size = (96 * density).toInt()
    assertEquals(size, recording.views.getValue(view).width)
    assertEquals(size, recording.views.getValue(view).height)
    assertTrue(recording.views.getValue(view).flags and WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED != 0)
    val bounds = OverlayBoundsResolver(context).resolveAvailableBounds()

    drag(view, 10000f)
    assertEquals(bounds.right - size, recording.views.getValue(view).x)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
    val visibleSize = (size * 0.6f).roundToInt()
    assertEquals(bounds.right - visibleSize, recording.views.getValue(view).x)

    // 保持贴右状态放大/缩小时仍按新窗口大小贴边，不漂移或移除窗口。
    controller.render(snapshot.copy(bubbleSizeDp = 64))
    val mediumSize = (64 * density).toInt()
    assertEquals(bounds.right - (mediumSize * 0.6f).roundToInt(), recording.views.getValue(view).x)
    drag(view, -10000f)
    assertEquals(bounds.left, recording.views.getValue(view).x)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
    assertEquals(bounds.left + (mediumSize * 0.6f).roundToInt() - mediumSize, recording.views.getValue(view).x)
    controller.removeAllViews()
    assertTrue(recording.views.isEmpty())
  }

  private fun drag(view: View, deltaX: Float) {
    listOf(MotionEvent.ACTION_DOWN to 0f, MotionEvent.ACTION_MOVE to deltaX, MotionEvent.ACTION_UP to deltaX).forEach { (action, x) ->
      val event = MotionEvent.obtain(0, 0, action, x, 0f, 0)
      view.dispatchTouchEvent(event)
      event.recycle()
    }
  }

  private class RecordingWindowManager(delegate: WindowManager) : WindowManager by delegate {
    // 测试明确提供系统边界；Robolectric 的 WindowManager 默认接口没有窗口指标。
    override fun getCurrentWindowMetrics() = WindowMetrics(Rect(0, 0, 1080, 2400), WindowInsets.Builder().build())
    val views = linkedMapOf<View, WindowManager.LayoutParams>()
    override fun addView(view: View, params: ViewGroup.LayoutParams) { record(view, params) }
    override fun updateViewLayout(view: View, params: ViewGroup.LayoutParams) { record(view, params) }
    override fun removeView(view: View) { views.remove(view) }
    private fun record(view: View, params: ViewGroup.LayoutParams) {
      views[view] = WindowManager.LayoutParams().apply { copyFrom(params as WindowManager.LayoutParams) }
    }
  }
}
