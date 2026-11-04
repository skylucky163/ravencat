package expo.modules.backgroundruntime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat

/** 独立总开关拥有前台生命周期；消息完成、页面卸载和功能开关均无权停止它。 */
class RavenCatBackgroundService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      BackgroundRuntime.stopFromNotification(this)
      return START_NOT_STICKY
    }
    val requestId = intent?.getStringExtra("startRequestId")
    if (!BackgroundRuntime.accepts(this, requestId)) {
      // 迟到的旧启动不能停止随后已建立的同一应用服务。
      if (!BackgroundRuntime.isRunning) stopSelf(startId)
      return if (BackgroundRuntime.isRunning) START_STICKY else START_NOT_STICKY
    }
    return try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      BackgroundRuntime.started(this, requestId)
      START_STICKY
    } catch (failure: RuntimeException) {
      Log.e("RavenCatBackground", "持续后台运行启动失败", failure)
      BackgroundRuntime.rejected(requestId, failure)
      stopSelf(startId)
      START_NOT_STICKY
    }
  }

  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    BackgroundRuntime.destroyed(this)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun notification(): Notification {
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL, "持续后台运行", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
    val open = checkNotNull(packageManager.getLaunchIntentForPackage(packageName))
    val stop = PendingIntent.getService(this, NOTIFICATION_ID,
      Intent(this, RavenCatBackgroundService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("RavenCat 正在后台运行").setContentText("持续接收 AI 回复与执行已开启的后台功能")
      .setOngoing(true).setShowWhen(false).setOnlyAlertOnce(true)
      .setContentIntent(PendingIntent.getActivity(this, NOTIFICATION_ID, open,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      .addAction(Notification.Action.Builder(null, "停止后台运行", stop).build()).build()
  }

  companion object {
    private const val CHANNEL = "ravencat_background"
    private const val NOTIFICATION_ID = 8609
    private const val ACTION_STOP = "ravencat.background.STOP"
  }
}
