package expo.modules.nativetextselection

import android.content.Context
import android.view.ContentInfo
import android.view.View
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs

/** 在 EditText 修改草稿之前处理系统剪贴板粘贴。 */
class OverflowPasteView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var inlineLimit = 0
  var attachmentLimit = 0
  private val onOverflowPaste by EventDispatcher()

  // 输入框的尺寸和位置由 React Native 管理，避免 LinearLayout 按文本宽度重新布局。
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    if (child is EditText) {
      child.interceptOverflowPaste({ inlineLimit }, { attachmentLimit }) { text ->
        onOverflowPaste(if (text == null) emptyMap() else mapOf("text" to text))
      }
    }
  }

  override fun onViewRemoved(child: View) {
    if (child is EditText) child.setOnReceiveContentListener(null, null)
    super.onViewRemoved(child)
  }
}

internal fun EditText.interceptOverflowPaste(
  inlineLimit: () -> Int,
  attachmentLimit: () -> Int,
  onOverflow: (String?) -> Unit
) {
  setOnReceiveContentListener(arrayOf("text/*")) { _, payload ->
    val limit = inlineLimit()
    if (limit <= 0 || payload.source != ContentInfo.SOURCE_CLIPBOARD) {
      return@setOnReceiveContentListener payload
    }
    val clip = payload.clip
    val items = (0 until clip.itemCount).map { clip.getItemAt(it).text ?: return@setOnReceiveContentListener payload }
    val pastedLength = items.sumOf { it.length.toLong() } + (items.size - 1)
    val selectedLength = abs(selectionEnd.coerceAtLeast(0) - selectionStart.coerceAtLeast(0))
    if (pastedLength + length() - selectedLength <= limit) return@setOnReceiveContentListener payload

    // 超限时不把大段剪贴板内容送过桥，也不让输入框接收截断后的前缀。
    onOverflow(if (pastedLength <= attachmentLimit()) items.joinToString("\n") else null)
    null
  }
}
