package expo.modules.devicecontrol.controller

import android.app.Activity
import android.app.AlarmManager
import android.content.Context
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import java.util.Calendar

/** 使用可见 Activity 派发一次请求，避免后台启动被系统静默拦截后误报成功。 */
internal object SystemAlarmController {
  fun setAlarm(activity: Activity?, hour: Int, minute: Int, label: String?, daysOfWeek: List<Int>): Map<String, String> {
    // 参数合法性由工具 Runtime 的 schema 边界负责；这里仅转换 Android 星期编号。
    val intent = Intent(AlarmClock.ACTION_SET_ALARM)
      .putExtra(AlarmClock.EXTRA_HOUR, hour)
      .putExtra(AlarmClock.EXTRA_MINUTES, minute)
      .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
    if (label != null) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label)
    if (daysOfWeek.isNotEmpty()) {
      intent.putIntegerArrayListExtra(
        AlarmClock.EXTRA_DAYS,
        ArrayList(daysOfWeek.map { if (it == 7) Calendar.SUNDAY else it + 1 }),
      )
    }
    return dispatch(activity, intent)
  }

  fun showAlarms(activity: Activity?) = dispatch(activity, Intent(AlarmClock.ACTION_SHOW_ALARMS))

  fun dismissAlarm(activity: Activity?, mode: String, hour: Int?, minute: Int?, label: String?): Map<String, String> {
    val intent = Intent(AlarmClock.ACTION_DISMISS_ALARM)
    val searchMode = when (mode) {
      "next" -> AlarmClock.ALARM_SEARCH_MODE_NEXT
      "all" -> AlarmClock.ALARM_SEARCH_MODE_ALL
      "label" -> AlarmClock.ALARM_SEARCH_MODE_LABEL
      "time" -> AlarmClock.ALARM_SEARCH_MODE_TIME
      else -> error("未知闹钟搜索模式：$mode")
    }
    intent.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, searchMode)
    if (mode == "time") {
      val localHour = checkNotNull(hour)
      intent.putExtra(AlarmClock.EXTRA_HOUR, localHour % 12)
      intent.putExtra(AlarmClock.EXTRA_MINUTES, checkNotNull(minute))
      intent.putExtra(AlarmClock.EXTRA_IS_PM, localHour >= 12)
    }
    if (mode == "label") intent.putExtra(AlarmClock.EXTRA_MESSAGE, checkNotNull(label))
    return dispatch(activity, intent)
  }

  fun snoozeAlarm(activity: Activity?, minutes: Int?): Map<String, String> {
    val intent = Intent(AlarmClock.ACTION_SNOOZE_ALARM)
    if (minutes != null) intent.putExtra(AlarmClock.EXTRA_ALARM_SNOOZE_DURATION, minutes)
    return dispatch(activity, intent)
  }

  fun getNextAlarm(context: Context): Map<String, Any> {
    val next = context.getSystemService(AlarmManager::class.java).nextAlarmClock
      ?: return mapOf("status" to "not_scheduled")
    return mapOf("status" to "available", "triggerAtEpochMs" to next.triggerTime)
  }

  private fun dispatch(activity: Activity?, intent: Intent): Map<String, String> {
    if (activity == null || !activity.hasWindowFocus()) return mapOf("status" to "app_not_focused")
    return try {
      activity.startActivity(intent)
      // 普通 Activity Intent 没有闹钟保存回执，不能返回 created 或伪造闹钟 ID。
      mapOf("status" to "alarm_request_dispatched")
    } catch (_: ActivityNotFoundException) {
      mapOf("status" to "clock_app_unavailable")
    } catch (_: SecurityException) {
      mapOf("status" to "alarm_request_rejected")
    }
  }
}
