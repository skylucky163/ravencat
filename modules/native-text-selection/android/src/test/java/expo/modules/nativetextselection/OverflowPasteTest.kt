package expo.modules.nativetextselection

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.text.InputFilter
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OverflowPasteTest {
  @Test fun `system paste keeps the selected draft when text would overflow`() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().visible().get()
    val input = EditText(activity).apply {
      filters = arrayOf(InputFilter.LengthFilter(6))
      setText("草稿🙂")
    }
    activity.setContentView(input)
    input.requestFocus()
    input.setSelection(0, 2)
    val clipboard = activity.getSystemService(ClipboardManager::class.java)
    val attachments = mutableListOf<String?>()
    var inlineLimit = 6
    input.interceptOverflowPaste({ inlineLimit }, { 12 }) { attachments.add(it) }

    fun paste(text: String) {
      clipboard.setPrimaryClip(ClipData.newPlainText("测试", text))
      input.onTextContextMenuItem(android.R.id.pasteAsPlainText)
    }

    paste("一二三四")
    assertEquals("一二三四🙂", input.text.toString())
    assertEquals(emptyList<String>(), attachments)

    input.setSelection(0, 1)
    val overflow = "未\n截🙂断"
    paste(overflow)
    assertEquals("一二三四🙂", input.text.toString())
    assertEquals(listOf(overflow), attachments)

    paste("字".repeat(13))
    assertEquals(listOf(overflow, null), attachments)
    assertEquals("一二三四🙂", input.text.toString())

    inlineLimit = 0
    input.selectAll()
    paste("一二三四五六七")
    assertEquals("一二三四五六", input.text.toString())
    assertEquals(listOf(overflow, null), attachments)
  }

  @Test fun `hardware keyboard and accessibility use the same clipboard route`() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().visible().get()
    val input = EditText(activity).apply { setText("草稿") }
    activity.setContentView(input)
    input.requestFocus()
    input.setSelection(input.length())
    val clipboard = activity.getSystemService(ClipboardManager::class.java)
    val text = "硬件和无障碍粘贴"
    clipboard.setPrimaryClip(ClipData.newPlainText("测试", text))
    val attachments = mutableListOf<String?>()
    input.interceptOverflowPaste({ 6 }, { 12 }) { attachments.add(it) }

    val ctrlV = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_V, 0, KeyEvent.META_CTRL_ON)
    assertTrue(input.onKeyShortcut(KeyEvent.KEYCODE_V, ctrlV))
    assertTrue(input.performAccessibilityAction(AccessibilityNodeInfo.ACTION_PASTE, null))
    assertEquals(listOf(text, text), attachments)
    assertEquals("草稿", input.text.toString())
  }
}
