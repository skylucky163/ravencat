package expo.modules.devicecontrol.controller

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.Calendar

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], manifest = Config.NONE)
class SystemAlarmControllerTest {
  @Test fun showAlarmsOnlyOpensAlarmPage() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    assertEquals("alarm_request_dispatched", SystemAlarmController.showAlarms(activity)["status"])
    assertEquals(AlarmClock.ACTION_SHOW_ALARMS, shadowOf(activity).nextStartedActivity.action)
    assertEquals(1, activity.attempts)
  }

  @Test fun dismissSupportsAllPublicSearchModesAndUnambiguousAmPm() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    for ((mode, expected) in listOf("next" to AlarmClock.ALARM_SEARCH_MODE_NEXT, "all" to AlarmClock.ALARM_SEARCH_MODE_ALL,
      "label" to AlarmClock.ALARM_SEARCH_MODE_LABEL, "time" to AlarmClock.ALARM_SEARCH_MODE_TIME)) {
      SystemAlarmController.dismissAlarm(activity, mode, 23, 45, "起床")
      val intent = shadowOf(activity).nextStartedActivity
      assertEquals(AlarmClock.ACTION_DISMISS_ALARM, intent.action)
      assertEquals(expected, intent.getStringExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE))
      assertEquals(mode == "label", intent.hasExtra(AlarmClock.EXTRA_MESSAGE))
      assertEquals(mode == "time", intent.hasExtra(AlarmClock.EXTRA_HOUR))
      if (mode == "time") {
        assertEquals(11, intent.getIntExtra(AlarmClock.EXTRA_HOUR, -1))
        assertEquals(45, intent.getIntExtra(AlarmClock.EXTRA_MINUTES, -1))
        assertTrue(intent.getBooleanExtra(AlarmClock.EXTRA_IS_PM, false))
      }
    }
    for (hour in listOf(0, 12)) {
      SystemAlarmController.dismissAlarm(activity, "time", hour, 0, null)
      val intent = shadowOf(activity).nextStartedActivity
      assertEquals(0, intent.getIntExtra(AlarmClock.EXTRA_HOUR, -1))
      assertEquals(hour == 12, intent.getBooleanExtra(AlarmClock.EXTRA_IS_PM, false))
    }
  }

  @Test fun snoozeUsesOptionalOneTimeDuration() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    SystemAlarmController.snoozeAlarm(activity, null)
    val defaultIntent = shadowOf(activity).nextStartedActivity
    assertEquals(AlarmClock.ACTION_SNOOZE_ALARM, defaultIntent.action)
    assertFalse(defaultIntent.hasExtra(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION))
    SystemAlarmController.snoozeAlarm(activity, 5)
    assertEquals(5, shadowOf(activity).nextStartedActivity.getIntExtra(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION, -1))
  }

  @Test fun queriesOnlyNextRegisteredAlarmWithoutActivity() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    assertEquals("not_scheduled", SystemAlarmController.getNextAlarm(activity)["status"])
    val operation = PendingIntent.getBroadcast(activity, 1, Intent("test.alarm"), PendingIntent.FLAG_IMMUTABLE)
    val trigger = System.currentTimeMillis() + 60_000
    activity.getSystemService(AlarmManager::class.java).setAlarmClock(AlarmManager.AlarmClockInfo(trigger, operation), operation)
    assertEquals(mapOf("status" to "available", "triggerAtEpochMs" to trigger), SystemAlarmController.getNextAlarm(activity))
    assertEquals(0, activity.attempts)
  }

  @Test fun allActionsShareFocusAndFailureSemantics() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    val actions = listOf<() -> Map<String, String>>(
      { SystemAlarmController.showAlarms(activity) },
      { SystemAlarmController.dismissAlarm(activity, "next", null, null, null) },
      { SystemAlarmController.snoozeAlarm(activity, null) },
    )
    activity.focused = false
    actions.forEach { assertEquals("app_not_focused", it()["status"]) }
    assertEquals(0, activity.attempts)
    activity.focused = true
    activity.failure = ActivityNotFoundException()
    actions.forEach { assertEquals("clock_app_unavailable", it()["status"]) }
    activity.failure = SecurityException()
    actions.forEach { assertEquals("alarm_request_rejected", it()["status"]) }
    assertEquals(6, activity.attempts)
  }
  @Test fun oneShotUsesSystemClockAndPreservesLocalTimeAndLabel() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    val result = SystemAlarmController.setAlarm(activity, 7, 30, "起床", emptyList())
    assertEquals("alarm_request_dispatched", result["status"])
    assertEquals(1, activity.attempts)
    val intent = shadowOf(activity).nextStartedActivity
    assertEquals(AlarmClock.ACTION_SET_ALARM, intent.action)
    assertEquals(7, intent.getIntExtra(AlarmClock.EXTRA_HOUR, -1))
    assertEquals(30, intent.getIntExtra(AlarmClock.EXTRA_MINUTES, -1))
    assertEquals("起床", intent.getStringExtra(AlarmClock.EXTRA_MESSAGE))
    assertTrue(intent.getBooleanExtra(AlarmClock.EXTRA_SKIP_UI, false))
    assertFalse(intent.hasExtra(AlarmClock.EXTRA_DAYS))
    assertFalse(intent.hasExtra(AlarmClock.EXTRA_RINGTONE))
  }

  @Test fun repeatingDaysConvertIsoMondayThroughSundayToAndroidWeekdays() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    SystemAlarmController.setAlarm(activity, 0, 0, null, (1..7).toList())
    val intent = shadowOf(activity).nextStartedActivity
    assertEquals(
      arrayListOf(Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY,
        Calendar.FRIDAY, Calendar.SATURDAY, Calendar.SUNDAY),
      intent.getIntegerArrayListExtra(AlarmClock.EXTRA_DAYS),
    )
    assertFalse(intent.hasExtra(AlarmClock.EXTRA_MESSAGE))
  }

  @Test fun missingOrUnfocusedActivityDoesNotDispatch() {
    assertEquals("app_not_focused", SystemAlarmController.setAlarm(null, 7, 0, null, emptyList())["status"])
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    activity.focused = false
    assertEquals("app_not_focused", SystemAlarmController.setAlarm(activity, 7, 0, null, emptyList())["status"])
    assertEquals(0, activity.attempts)
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  @Test fun unavailableClockAndSystemRejectionDoNotRetry() {
    val activity = Robolectric.buildActivity(AlarmTestActivity::class.java).setup().get()
    activity.failure = ActivityNotFoundException()
    assertEquals("clock_app_unavailable", SystemAlarmController.setAlarm(activity, 7, 0, null, emptyList())["status"])
    assertEquals(1, activity.attempts)
    activity.failure = SecurityException()
    assertEquals("alarm_request_rejected", SystemAlarmController.setAlarm(activity, 7, 0, null, emptyList())["status"])
    assertEquals(2, activity.attempts)
    assertNull(shadowOf(activity).nextStartedActivity)
  }
}

class AlarmTestActivity : Activity() {
  var focused = true
  var attempts = 0
  var failure: RuntimeException? = null

  override fun hasWindowFocus() = focused

  override fun startActivity(intent: Intent) {
    attempts += 1
    failure?.let { throw it }
    super.startActivity(intent)
  }
}
