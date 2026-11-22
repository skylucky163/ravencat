package expo.modules.kimiphonenotifications

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** 验证真实通知发布、精确撤销和点击响应，不绑定 Publisher 内部写法。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35])
class MessageNotificationDeliveryTest {
  private val context get() = RuntimeEnvironment.getApplication()
  private val manager get() = context.getSystemService(NotificationManager::class.java)

  @Before fun setup() {
    shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    NotificationStateStore.clearAllForFactoryReset(context)
  }

  @After fun cleanup() {
    NotificationPublisher.dismissConversation(context, null)
    NotificationPublisher.dismissTogetherListening(context, null)
    NotificationStateStore.clearAllForFactoryReset(context)
  }

  private fun post(event: String, session: String, messageId: Long? = null) = runBlocking {
    val result = NotificationPublisher.postConversation(context, mapOf(
      "displayId" to "kimiphone-msg-ai:host-$event", "eventId" to event,
      "aiId" to "host", "aiName" to "主理 AI", "message" to "测试消息",
      "conversationKey" to "ai:host", "sessionId" to session, "committedMessageId" to messageId,
    ))
    assertEquals(true, result["posted"])
  }

  @Test fun readReceiptRemovesOnlyVisibleMessagesAndUpdatesSummary() {
    post("first", "a", 1)
    post("second", "a", 2)
    post("other-session", "b", 3)
    NotificationPublisher.dismissReadMessages(context, "a", listOf("1", "3"), emptyList())
    assertEquals(listOf("second", "other-session"), NotificationStateStore.readConversation(context, "ai:host")!!.children.map { it.childId })
    assertEquals(3, manager.activeNotifications.size)
    NotificationPublisher.dismissReadMessages(context, "a", listOf("1"), emptyList())
    assertEquals(3, manager.activeNotifications.size)
    NotificationPublisher.dismissReadMessages(context, "b", listOf("3"), emptyList())
    assertEquals("a", NotificationStateStore.readConversation(context, "ai:host")!!.sessionId)
    assertTrue(manager.activeNotifications.all {
      shadowOf(it.notification.contentIntent).savedIntent.getStringExtra("sessionId") == "a"
    })
  }

  @Test fun runtimeBodyCanBeDismissedByStableIdentityBeforeCanonicalCommit() {
    post("agent-timeline:run:1:0", "a")
    NotificationPublisher.dismissReadMessages(context, "a", emptyList(), listOf("agent-timeline:run:1:0"))
    assertTrue(manager.activeNotifications.isEmpty())
    assertNull(NotificationStateStore.readConversation(context, "ai:host"))
  }

  @Test fun childAndSummaryClicksUseActivityAndPreserveNavigationResponse() {
    post("first", "a", 1)
    post("second", "a", 2)
    val notifications = manager.activeNotifications
    assertTrue(notifications.all { it.notification.contentIntent.isActivity })
    val open = shadowOf(notifications.first().notification.contentIntent).savedIntent
    assertEquals(NotificationOpenActivity::class.java.name, open.component!!.className)
    val activity = Robolectric.buildActivity(NotificationOpenActivity::class.java, Intent(open)).create()
    val responses = NotificationStateStore.consumePendingResponses(context)
    assertEquals(1, responses.size)
    assertEquals("a", responses.single()["sessionId"])
    assertEquals("ai:host", responses.single()["conversationKey"])
    assertTrue(manager.activeNotifications.isEmpty())
    activity.destroy()
  }

  @Test fun togetherListeningUsesTheSameActivityTransportWithoutDismissingMessages() {
    post("first", "a", 1)
    val result = NotificationPublisher.upsertTogetherListening(context, mapOf(
      "activityId" to "together", "hostAiId" to "host", "chatSessionId" to "a",
      "activatedAtEpochMs" to 1L, "aiName" to "主理 AI",
    ))
    assertEquals(true, result["posted"])
    val notification = manager.activeNotifications.single {
      shadowOf(it.notification.contentIntent).savedIntent.getStringExtra("type") == "together-listening"
    }.notification
    assertTrue(notification.contentIntent.isActivity)
    val activity = Robolectric.buildActivity(NotificationOpenActivity::class.java,
      Intent(shadowOf(notification.contentIntent).savedIntent)).create()
    assertEquals("together-listening", NotificationStateStore.consumePendingResponses(context).single()["type"])
    assertNotNull(NotificationStateStore.readConversation(context, "ai:host"))
    activity.destroy()
  }
}
