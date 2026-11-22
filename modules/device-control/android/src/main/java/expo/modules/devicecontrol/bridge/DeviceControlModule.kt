package expo.modules.devicecontrol.bridge

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.session.MediaSessionManager
import android.provider.Settings
import expo.modules.devicecontrol.controller.AppLauncher
import expo.modules.devicecontrol.controller.AndroidMediaSessionControllerSource
import expo.modules.devicecontrol.controller.BrowsableUriDispatcher
import expo.modules.devicecontrol.controller.MediaSessionControllerSource
import expo.modules.devicecontrol.controller.MediaSessionSnapshotReader
import expo.modules.devicecontrol.controller.MediaSessionTransportController
import expo.modules.devicecontrol.controller.NotificationListenerAccessReader
import expo.modules.devicecontrol.controller.SystemCalendarController
import expo.modules.devicecontrol.controller.SystemAlarmController
import expo.modules.devicecontrol.controller.XiaohongshuNoteAutomation
import expo.modules.devicecontrol.model.SoftLockCommand
import expo.modules.devicecontrol.model.SoftLockCommandParseResult
import expo.modules.devicecontrol.model.SoftLockReconcileResult
import expo.modules.devicecontrol.runtime.ProcessDeviceControlRuntimeHost
import expo.modules.devicecontrol.service.RavenCatMediaNotificationListenerService
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * RavenCat Device Control 原生模块：通用 Android 执行/观察 bridge。
 *
 * DC2-E contract：
 * - reconcileSoftLocks(activeLocks)：application 业务真值的权威投影同步，
 *   空数组代表当前没有 active lock，native 清空全部投影；
 * - getRuntimeState()：runtime、observer 与实际 blocking window 事实快照。
 *
 * 边界：不暴露 View/Service 对象；不接受业务历史字段；bridge 创建/销毁
 * 不拥有 runtime 生命周期，持续生命周期只由独立 DeviceControlService 接管。
 * MediaSession observation 与该 runtime 独立，只查询系统当前事实。
 */
class DeviceControlModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RavenCatDeviceControl")

    AsyncFunction("showSystemAlarms") {
      SystemAlarmController.showAlarms(appContext.currentActivity)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("dismissSystemAlarm") { mode: String, hour: Int?, minute: Int?, label: String? ->
      SystemAlarmController.dismissAlarm(appContext.currentActivity, mode, hour, minute, label)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("snoozeSystemAlarm") { minutes: Int? ->
      SystemAlarmController.snoozeAlarm(appContext.currentActivity, minutes)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("getNextSystemAlarm") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      SystemAlarmController.getNextAlarm(context)
    }

    AsyncFunction("setSystemAlarm") { hour: Int, minute: Int, label: String?, daysOfWeek: List<Int> ->
      SystemAlarmController.setAlarm(appContext.currentActivity, hour, minute, label, daysOfWeek)
    }.runOnQueue(Queues.MAIN)

    Function("beginXiaohongshuNote") { XiaohongshuNoteAutomation.begin() }
    Function("cancelXiaohongshuNote") { id: String -> XiaohongshuNoteAutomation.cancel(id) }
    AsyncFunction("executeXiaohongshuNote") Coroutine { id: String, actor: String, command: Map<String, Any?> ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      XiaohongshuNoteAutomation.execute(context, id, actor, command)
    }

    AsyncFunction("prepareSystemCalendar") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      SystemCalendarController(context).prepare()
    }
    AsyncFunction("upsertSystemCalendarEvent") { key: String, title: String, description: String, startAtEpochMs: Long ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      SystemCalendarController(context).upsert(
        key, title, description, startAtEpochMs,
      )
    }
    AsyncFunction("removeSystemCalendarEvent") { key: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      SystemCalendarController(context).remove(key)
    }
    AsyncFunction("listSystemCalendarEventKeys") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      SystemCalendarController(context).listKeys()
    }

    AsyncFunction("startRuntime") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      ProcessDeviceControlRuntimeHost.startRuntime(context).toMap()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("reconcileSoftLocks") { payload: List<Any?> ->
      when (val parsed = SoftLockCommand.fromBridgePayload(payload)) {
        is SoftLockCommandParseResult.Parsed ->
          ProcessDeviceControlRuntimeHost.reconcile(parsed.command).toMap()
        is SoftLockCommandParseResult.Invalid ->
          SoftLockReconcileResult.invalidProjection(parsed.reason).toMap()
      }
    }

    AsyncFunction("getRuntimeState") {
      ProcessDeviceControlRuntimeHost.runtimeState().toMap()
    }

    AsyncFunction("stopRuntimeIfIdle") {
      ProcessDeviceControlRuntimeHost.stopRuntimeIfIdle().toMap()
    }.runOnQueue(Queues.MAIN)

    // 独立 Device Control action primitive：与 Soft Lock runtime 生命周期无关。
    // 只处理 exact package 的 front-door launch；不做 Protected Apps / 搜索 / 前台读取。
    AsyncFunction("openApp") { packageName: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AppLauncher(context).openApp(packageName).toMap()
    }

    // 独立 Device Control action primitive：exact package + 单个 browsable URI → ACTION_VIEW。
    // 与 Soft Lock runtime 生命周期无关；不做 Protected Apps、具体 App 逻辑、授权、
    // retry 或前台验证。
    AsyncFunction("dispatchBrowsableUri") { packageName: String, uri: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      BrowsableUriDispatcher(context).dispatch(packageName, uri).toMap()
    }

    // 与 Soft Lock runtime 独立的 MediaSession observation primitives。
    AsyncFunction("getNotificationListenerAccessState") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      notificationListenerAccessReader(context).getState()
    }

    AsyncFunction("openNotificationListenerSettings") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      try {
        context.startActivity(
          Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        mapOf("status" to "settings_open_dispatched", "reason" to null)
      } catch (error: Exception) {
        mapOf(
          "status" to "settings_open_failed",
          "reason" to (error.message ?: error.javaClass.simpleName),
        )
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getMediaSessionSnapshot") { packageName: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      MediaSessionSnapshotReader(
        loadControllers = mediaSessionControllerLoader(context),
        accessReader = notificationListenerAccessReader(context),
      ).read(packageName).toMap()
    }

    // 与 observation 共用 exact-package resolution 的 transport command primitive。
    // command_dispatched 不代表 playback state 已经改变，最终事实必须由一次新的
    // getMediaSessionSnapshot 独立观察。
    AsyncFunction("dispatchMediaSessionCommand") { packageName: String, command: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      MediaSessionTransportController(
        loadControllers = mediaSessionControllerLoader(context),
        accessReader = notificationListenerAccessReader(context),
      ).dispatch(packageName, command).toMap()
    }
  }

  /** observation 与 command 共用同一份 controller discovery，不形成第二套 selection truth。 */
  private fun mediaSessionControllerLoader(
    context: Context,
  ): () -> List<MediaSessionControllerSource> {
    val listenerComponent = notificationListenerComponent(context)
    val manager = context.getSystemService(MediaSessionManager::class.java)
    return {
      manager.getActiveSessions(listenerComponent).map { AndroidMediaSessionControllerSource(it, context) }
    }
  }

  private fun notificationListenerComponent(context: Context): ComponentName =
    ComponentName(context, RavenCatMediaNotificationListenerService::class.java)

  private fun notificationListenerAccessReader(context: Context): NotificationListenerAccessReader {
    val manager = context.getSystemService(NotificationManager::class.java)
    val component = notificationListenerComponent(context)
    return NotificationListenerAccessReader {
      manager.isNotificationListenerAccessGranted(component)
    }
  }
}
