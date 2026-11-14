package expo.modules.modalwindow

import android.app.Activity
import android.app.Dialog
import android.graphics.Insets
import android.view.WindowInsets
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.ReadableNativeMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.common.mapbuffer.ReadableMapBuffer
import com.facebook.react.uimanager.StateWrapper
import expo.modules.kotlin.AppContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.*
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import kotlin.math.roundToInt

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], qualifiers = "xxhdpi")
class ModalWindowTest {
  /** 替代 JNI/Fabric 提交边界，在 JVM 中把原生提交的 dp 高度应用到实际 View。 */
  private fun withDialog(test: (Dialog, ModalWindowView) -> Unit) {
    mockStatic(Arguments::class.java).use { arguments ->
      arguments.`when`<WritableMap> { Arguments.createMap() }.thenAnswer { JavaOnlyMap() }
      val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
      val dialog = Dialog(activity)
      val view = ModalWindowView(activity, mock(AppContext::class.java))
      view.stateWrapper = object : StateWrapper {
        override val stateData: ReadableNativeMap? = null
        override val stateDataMapBuffer: ReadableMapBuffer? = null
        override fun updateState(map: WritableMap) {
          val height = (map.getDouble("height") * view.resources.displayMetrics.density).roundToInt()
          view.layout(0, 0, 1080, height)
        }
        override fun destroyState() = Unit
      }
      dialog.setContentView(view)
      dialog.window!!.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE or
        WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
      dialog.show()
      ShadowLooper.idleMainLooper()
      dialog.window!!.decorView.layout(0, 0, 1080, 2400)
      dialog.window!!.decorView.viewTreeObserver.dispatchOnGlobalLayout()
      try { test(dialog, view) } finally { dialog.dismiss() }
    }
  }

  private fun ime(bottom: Int) = WindowInsets.Builder()
    .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, bottom))
    .setVisible(WindowInsets.Type.ime(), bottom > 0)
    .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, 54))
    .build()

  @Test fun dialogOwnsAdjustmentWithoutChangingActivity() = withDialog { dialog, view ->
    val activity = view.context as Activity
    // RN 在 show 后还会更新焦点 flags；后续窗口属性提交不能把输入模式改回去。
    dialog.window!!.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
    dialog.window!!.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
    assertEquals(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING,
      (view.rootView.layoutParams as WindowManager.LayoutParams).softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST)
    assertNotEquals(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING,
      activity.window.attributes.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST)
    assertSame(dialog.window!!.decorView, view.rootView)
    assertEquals(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE,
      (view.rootView.layoutParams as WindowManager.LayoutParams).softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_STATE)
  }

  @Test fun boundaryFollowsKeyboardHeightAndNeverSubtractsTwice() = withDialog { _, view ->
    repeat(3) {
      view.dispatchApplyWindowInsets(ime(906))
      assertEquals(1494, view.height)
      view.dispatchApplyWindowInsets(ime(906))
      assertEquals(1494, view.height)
      view.dispatchApplyWindowInsets(ime(1100))
      assertEquals(1300, view.height)
      view.dispatchApplyWindowInsets(ime(700))
      assertEquals(1700, view.height)
      view.dispatchApplyWindowInsets(ime(0))
      assertEquals(2400, view.height)
    }
  }

  @Test fun nativeWindowResizeUsesNewBoundsAndPreservesOtherInsets() = withDialog { dialog, view ->
    val insets = ime(400)
    assertSame(insets, view.dispatchApplyWindowInsets(insets))
    dialog.window!!.decorView.layout(0, 0, 1080, 1800)
    dialog.window!!.decorView.viewTreeObserver.dispatchOnGlobalLayout()
    assertEquals(1400, view.height)
    assertEquals(54, insets.getInsets(WindowInsets.Type.navigationBars()).bottom)
  }

  @Test fun dismissedWindowIgnoresLateInsets() = withDialog { dialog, view ->
    view.dispatchApplyWindowInsets(ime(906))
    dialog.dismiss()
    val height = view.height
    view.dispatchApplyWindowInsets(ime(0))
    assertEquals(height, view.height)
  }

  @Test fun reopenedDialogUsesItsOwnKeyboardBoundary() {
    withDialog { _, view ->
      view.dispatchApplyWindowInsets(ime(906))
      assertEquals(1494, view.height)
    }
    withDialog { _, view ->
      view.dispatchApplyWindowInsets(ime(0))
      assertEquals(2400, view.height)
    }
  }
}
