package expo.modules.modalwindow

import android.content.Context
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowInsets
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import kotlin.math.max

/** 独立 Modal 的唯一避让所有者；只使用本窗口的 IME，不读取 Activity 或 JS 的键盘缓存。 */
class ModalWindowView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var windowRoot: View? = null
  private var windowInsets: WindowInsets? = null
  private var committedSize: Pair<Int, Int>? = null
  private val windowLayoutListener = ViewTreeObserver.OnGlobalLayoutListener { updateBoundary() }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val root = rootView
    val attributes = root.layoutParams as WindowManager.LayoutParams
    // 该容器随独立窗口一起挂载与销毁；不能借它改写 Activity 的输入布局策略。
    check(attributes.type == WindowManager.LayoutParams.TYPE_APPLICATION) {
      "ModalWindow 只能放在独立的 React Native Modal 窗口内"
    }
    attributes.softInputMode = (attributes.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or
      WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
    context.getSystemService(WindowManager::class.java).updateViewLayout(root, attributes)
    windowRoot = root
    windowInsets = root.rootWindowInsets
    root.viewTreeObserver.addOnGlobalLayoutListener(windowLayoutListener)
    requestApplyInsets()
    updateBoundary()
  }

  override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
    windowInsets = insets
    updateBoundary()
    // 子组件仍需状态栏、安全区等信息；只拥有布局，不吞掉整个窗口的 insets。
    return insets
  }

  private fun updateBoundary() {
    val root = windowRoot ?: return
    val state = stateWrapper ?: return
    if (root.height == 0) return
    val keyboardBottom = windowInsets?.getInsets(WindowInsets.Type.ime())?.bottom ?: 0
    // 始终从窗口高度计算，不能从自己上次已收缩的高度再次扣除 IME。
    val availableHeight = max(0, root.height - keyboardBottom)
    val size = root.width to availableHeight
    if (committedSize == size) return
    val density = resources.displayMetrics.density.toDouble()
    // Expo Fabric 的原生尺寸状态直接参与 Yoga，React 表单无需再订阅键盘或计算高度。
    state.updateState(Arguments.createMap().apply {
      putDouble("width", root.width / density)
      putDouble("height", availableHeight / density)
    })
    committedSize = size
  }

  override fun onDetachedFromWindow() {
    windowRoot!!.viewTreeObserver.removeOnGlobalLayoutListener(windowLayoutListener)
    windowRoot = null
    windowInsets = null
    committedSize = null
    // 容器不在其他窗口复用；原生窗口的撤销由 RN Modal 拥有，不向 Activity 写回任何状态。
    super.onDetachedFromWindow()
  }
}
