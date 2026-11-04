package expo.modules.messagebubble

import android.app.Activity
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.mock
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BubbleTouchTest {
  @Test fun backgroundLetsClicksAndLongPressReachMessage() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val parent = FrameLayout(activity)
    var clicks = 0
    var longPresses = 0
    val content = View(activity).apply {
      setOnClickListener { clicks++ }
      setOnLongClickListener { longPresses++; true }
    }
    val background = MessageBubbleView(activity, mock(AppContext::class.java))
    parent.addView(content, FrameLayout.LayoutParams(240, 80))
    // 故意放到最上层：即使命中背景，也必须让已有消息继续收到事件。
    parent.addView(background, FrameLayout.LayoutParams(240, 80))
    activity.setContentView(parent)
    parent.measure(View.MeasureSpec.makeMeasureSpec(240, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(80, View.MeasureSpec.EXACTLY))
    parent.layout(0, 0, 240, 80)
    fun touch(action: Int) {
      val time = SystemClock.uptimeMillis()
      val event = MotionEvent.obtain(time, time, action, 20f, 20f, 0)
      parent.dispatchTouchEvent(event)
      event.recycle()
    }
    touch(MotionEvent.ACTION_DOWN)
    touch(MotionEvent.ACTION_UP)
    ShadowLooper.idleMainLooper()
    assertEquals(1, clicks)
    touch(MotionEvent.ACTION_DOWN)
    ShadowLooper.idleMainLooper(700, TimeUnit.MILLISECONDS)
    touch(MotionEvent.ACTION_UP)
    assertEquals(1, longPresses)
    assertFalse(background.isClickable)
    assertFalse(background.isFocusable)
  }
}
