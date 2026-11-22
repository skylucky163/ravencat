package expo.modules.ravencatfloatinglayer.view

import android.app.Activity
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ScrollView
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayMessage
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlayMessageRole
import expo.modules.ravencatfloatinglayer.model.RavenCatOverlaySnapshot
import expo.modules.ravencatfloatinglayer.model.RavenCatPanelPage
import expo.modules.ravencatfloatinglayer.model.RavenCatTogetherListeningPresentation
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** 通过真实 View attach、布局、裁剪和滚动验证已读来源，不把缓存当作阅读。 */
@Config(sdk = [35])
@RunWith(RobolectricTestRunner::class)
class RavenCatConversationReadReceiptTest {
  private val activityController = Robolectric.buildActivity(Activity::class.java).setup().visible()
  private val activity = activityController.get()
  private val root = FrameLayout(activity)
  private val receipts = mutableListOf<Pair<String, List<Long>>>()
  private val clientReceipts = mutableListOf<List<String>>()
  private val report: (String, List<Long>, List<String>) -> Unit = { session, ids, clients ->
    receipts.add(session to ids)
    clientReceipts.add(clients)
  }

  @After fun destroyActivity() { activityController.pause().stop().destroy() }

  private fun snapshot(session: String = "a") = RavenCatOverlaySnapshot(
    conversationSessionId = session,
    messages = (1L..6L).map { RavenCatOverlayMessage(
      RavenCatOverlayMessageRole.ASSISTANT, "消息 $it\n第二行\n第三行\n第四行", messageId = it,
    ) },
  )

  private fun attach(view: View) {
    root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    activity.setContentView(root)
  }

  private fun frame() {
    val width = View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY)
    val height = View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY)
    root.measure(width, height)
    root.layout(0, 0, 480, 200)
    shadowOf(Looper.getMainLooper()).idle()
    root.measure(width, height)
    root.layout(0, 0, 480, 200)
    root.viewTreeObserver.dispatchOnPreDraw()
  }

  @Test fun cachedMessagesRequireAttachedVisibleViewportAndScrollingRevealsOlderMessages() {
    val view = RavenCatConversationView(activity, report)
    view.render(snapshot())
    assertTrue(receipts.isEmpty())
    attach(view)
    frame()
    val scroll = findScrollView(view)
    scroll.scrollTo(0, scroll.getChildAt(0).height)
    root.viewTreeObserver.dispatchOnPreDraw()
    assertEquals("a", receipts.last().first)
    assertTrue(receipts.last().second.contains(6L))
    assertFalse(receipts.last().second.contains(1L))
    assertTrue(receipts.last().second.size < 6)
    val count = receipts.size
    frame()
    assertEquals(count, receipts.size)
    scroll.scrollTo(0, 0)
    root.viewTreeObserver.dispatchOnPreDraw()
    assertTrue(receipts.last().second.contains(1L))
    assertFalse(receipts.last().second.contains(6L))
  }

  @Test fun hiddenAndDetachedViewsDoNotReportRead() {
    val view = RavenCatConversationView(activity, report)
    view.render(snapshot())
    view.visibility = View.GONE
    attach(view)
    frame()
    assertTrue(receipts.isEmpty())
    view.visibility = View.VISIBLE
    frame()
    assertTrue(receipts.isNotEmpty())
    val count = receipts.size
    root.removeView(view)
    view.render(snapshot("b"))
    frame()
    assertEquals(count, receipts.size)
  }

  @Test fun togetherPageDoesNotReadChatUntilUserSwitchesToChat() {
    val view = RavenCatPanelView(activity, {}, {}, report)
    view.render(snapshot().copy(togetherListening = RavenCatTogetherListeningPresentation(
      "activity", "ai", "a", 1L, "AI", null, "用户", null,
    )))
    view.setPage(RavenCatPanelPage.TOGETHER)
    attach(view)
    frame()
    assertTrue(receipts.isEmpty())
    view.setPage(RavenCatPanelPage.CHAT)
    frame()
    assertTrue(receipts.isNotEmpty())
  }

  @Test fun userPendingAndErrorRowsAreNotReadReceipts() {
    val view = RavenCatConversationView(activity, report)
    view.render(RavenCatOverlaySnapshot(conversationSessionId = "a", messages = listOf(
      RavenCatOverlayMessage(RavenCatOverlayMessageRole.USER, "用户消息", messageId = 1),
      RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "等待回复", "request"),
      RavenCatOverlayMessage(RavenCatOverlayMessageRole.ERROR, "失败", messageId = 2),
    )))
    attach(view)
    frame()
    assertTrue(receipts.isEmpty())
  }

  @Test fun runtimeBodyReportsStableIdentityBeforeCanonicalMessageExists() {
    val view = RavenCatConversationView(activity, report)
    view.render(RavenCatOverlaySnapshot(conversationSessionId = "a", messages = listOf(
      RavenCatOverlayMessage(RavenCatOverlayMessageRole.ASSISTANT, "已交付正文", "client-reply"),
    )))
    attach(view)
    frame()
    assertTrue(receipts.last().second.isEmpty())
    assertEquals(listOf("client-reply"), clientReceipts.last())
    view.render(RavenCatOverlaySnapshot(conversationSessionId = "a", messages = listOf(
      RavenCatOverlayMessage(RavenCatOverlayMessageRole.ASSISTANT, "已交付正文", "client-reply", 10),
    )))
    frame()
    assertEquals(listOf(10L), receipts.last().second)
    assertEquals(listOf("client-reply"), clientReceipts.last())
  }

  private fun findScrollView(view: View): ScrollView {
    fun descendants(current: View): Sequence<View> = sequence {
      yield(current)
      if (current is ViewGroup) {
        for (index in 0 until current.childCount) yieldAll(descendants(current.getChildAt(index)))
      }
    }
    return descendants(view).filterIsInstance<ScrollView>().first()
  }
}
