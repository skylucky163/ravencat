package expo.modules.kimiphonenotifications

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import expo.modules.backgroundruntime.ApplicationExecutionHost
import expo.modules.callringtone.CallRingtonePlayback
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
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowNotificationManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 34], shadows = [IncomingCallPresentationTest.CallNotificationManagerShadow::class])
@LooperMode(LooperMode.Mode.PAUSED)
class IncomingCallPresentationTest {
  /** Robolectric 未执行 Android 14 的 CallStyle 发布检查，在系统边界复现真机拒绝条件。 */
  @Implements(NotificationManager::class)
  class CallNotificationManagerShadow : ShadowNotificationManager() {
    var fullScreenAllowed = true

    @Implementation(minSdk = 34)
    protected fun canUseFullScreenIntent(): Boolean = fullScreenAllowed

    @Implementation(minSdk = 34)
    override fun notify(tag: String?, id: Int, notification: Notification) {
      val isCall = notification.extras.getString(Notification.EXTRA_TEMPLATE) == Notification.CallStyle::class.java.name
      val isForegroundService = notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0
      require(!isCall || isForegroundService || notification.fullScreenIntent != null) {
        "CallStyle notification requires a foreground execution host or a fullScreenIntent"
      }
      super.notify(tag, id, notification)
    }
  }

  class ForegroundActivity : Activity()
  class UnavailableActivity : Activity() {
    override fun startActivity(intent: Intent) { throw ActivityNotFoundException("测试展示边界失败") }
  }
  private val context get() = RuntimeEnvironment.getApplication()
  private val manager get() = context.getSystemService(NotificationManager::class.java)
  private val callId = "incoming-presentation"
  private val payload = mapOf(
    "displayId" to NotificationPublisher.callDisplayId(callId), "callId" to callId,
    "aiId" to "ai", "aiName" to "测试 AI", "sessionId" to "session", "body" to "视频来电",
    "ringDurationMs" to 30_000,
  )

  @Before fun setup() {
    shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.VIBRATE,
      Manifest.permission.USE_FULL_SCREEN_INTENT)
  }

  @After fun cleanup() {
    CallRingtonePlayback.stop(callId)
    NotificationPublisher.dismissIncomingCall(context, callId)
  }

  @Test fun `foreground incoming call opens the native answer screen without waiting for system FSI`() {
    val activity = Robolectric.buildActivity(ForegroundActivity::class.java).setup().get()
    val result = NotificationPublisher.postIncomingCall(context, payload, activity)
    assertEquals(true, result["posted"])
    val intent = shadowOf(activity).nextStartedActivity
    assertNotNull(intent)
    assertEquals(IncomingCallActivity::class.java.name, intent.component!!.className)
    assertEquals("open", intent.getStringExtra("notificationAction"))
    assertEquals(callId, intent.getStringExtra("callId"))
    assertEquals("测试 AI", intent.getStringExtra("aiName"))
    assertNotNull(manager.activeNotifications.single().notification.fullScreenIntent)
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  @Test fun `background incoming call leaves automatic presentation to the system notification`() {
    val result = NotificationPublisher.postIncomingCall(context, payload, null)
    assertEquals(true, result["posted"])
    assertNull(shadowOf(context).nextStartedActivity)
    val notification = manager.activeNotifications.single().notification
    assertNotNull(notification.fullScreenIntent)
    val intent = shadowOf(notification.contentIntent).savedIntent
    assertEquals(IncomingCallActivity::class.java.name, intent.component!!.className)
    assertEquals("open", intent.getStringExtra("notificationAction"))
    assertEquals(callId, intent.getStringExtra("callId"))
    val answer = notification.actions.map { shadowOf(it.actionIntent).savedIntent }
      .single { it.getStringExtra("notificationAction") == "accept" }
    assertEquals(IncomingCallActivity::class.java.name, answer.component!!.className)
    assertEquals(callId, answer.getStringExtra("callId"))
  }

  @Test fun `declining a notification queues the call action without opening a screen`() {
    assertEquals(true, NotificationPublisher.postIncomingCall(context, payload, null)["posted"])
    val decline = manager.activeNotifications.single().notification.actions.map { it.actionIntent }
      .single { shadowOf(it).savedIntent.getStringExtra("notificationAction") == "reject" }
    assertTrue(decline.isBroadcast)

    NotificationActionReceiver().onReceive(context, Intent(shadowOf(decline).savedIntent))
    val pending = ApplicationExecutionHost.takePending()
    try {
      assertNull(shadowOf(context).nextStartedActivity)
      assertTrue(manager.activeNotifications.isEmpty())
      val response = NotificationStateStore.consumePendingResponses(context).single()
      assertEquals("reject", response["notificationAction"])
      assertEquals(callId, response["callId"])
      assertEquals("call_action", pending.single()["kind"])
      assertEquals(response, pending.single()["data"])
    } finally {
      pending.forEach { ApplicationExecutionHost.complete(it["id"] as String) }
    }
  }

  @Config(sdk = [34])
  @Test fun `Android 14 rejects unhosted CallStyle without a full screen request`() {
    NotificationPublisher.postIncomingCall(context, payload, null)
    val notification = manager.activeNotifications.single().notification
    notification.fullScreenIntent = null
    assertThrows(IllegalArgumentException::class.java) { manager.notify(900, notification) }
  }

  @Test fun `notification blocked by the user does not create an unowned call screen`() {
    shadowOf(manager).setNotificationsEnabled(false)
    val activity = Robolectric.buildActivity(ForegroundActivity::class.java).setup().get()
    val result = NotificationPublisher.postIncomingCall(context, payload, activity)
    assertEquals(false, result["posted"])
    assertNull(shadowOf(activity).nextStartedActivity)
    assertTrue(manager.activeNotifications.isEmpty())
  }

  @Config(sdk = [34])
  @Test fun `foreground answer screen does not require full screen notification permission`() {
    Shadow.extract<CallNotificationManagerShadow>(manager).fullScreenAllowed = false
    val activity = Robolectric.buildActivity(ForegroundActivity::class.java).setup().get()
    val result = NotificationPublisher.postIncomingCall(context, payload, activity)
    assertEquals(true, result["posted"])
    assertEquals(IncomingCallActivity::class.java.name, shadowOf(activity).nextStartedActivity.component!!.className)
  }

  @Config(sdk = [34])
  @Test fun `background without full screen permission keeps the notification answer entry`() {
    Shadow.extract<CallNotificationManagerShadow>(manager).fullScreenAllowed = false
    val result = NotificationPublisher.postIncomingCall(context, payload, null)
    assertEquals(true, result["posted"])
    assertNull(shadowOf(context).nextStartedActivity)
    val notification = manager.activeNotifications.single().notification
    assertNotNull(notification.fullScreenIntent)
    assertNotNull(notification.contentIntent)
    assertTrue(notification.actions.any { shadowOf(it.actionIntent).savedIntent.getStringExtra("notificationAction") == "accept" })
  }

  @Test fun `foreground launch failure preserves the posted answer action and reports its own error`() {
    val activity = Robolectric.buildActivity(UnavailableActivity::class.java).setup().get()
    val result = NotificationPublisher.postIncomingCall(context, payload, activity)
    assertEquals(true, result["posted"])
    assertTrue((result["error"] as String).contains("前台来电界面启动失败"))
    assertEquals(1, manager.activeNotifications.size)
  }
}
