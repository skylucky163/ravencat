package expo.modules.backgroundruntime

import android.content.Context
import android.content.Intent
import android.app.Service
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.UUID

/** 开关是 Android 执行配置，业务任务不能改写它；所有生命周期变更在主线程串行。 */
object BackgroundRuntime {
  private data class Start(val id: String, val completion: CompletableDeferred<Unit>)
  private var pending: Start? = null
  @Volatile private var service: RavenCatBackgroundService? = null

  fun isEnabled(context: Context): Boolean = preferences(context).getBoolean("enabled", false)
  val isRunning: Boolean get() = service != null
  fun state(context: Context): Map<String, Boolean> = mapOf("enabled" to isEnabled(context), "running" to isRunning)

  suspend fun setEnabled(context: Context, enabled: Boolean): Map<String, Boolean> = withContext(Dispatchers.Main.immediate) {
    check(preferences(context).edit().putBoolean("enabled", enabled).commit()) { "无法保存持续后台运行开关" }
    if (enabled) start(context) else stop(context)
    state(context)
  }

  suspend fun reconcile(context: Context): Map<String, Boolean> = withContext(Dispatchers.Main.immediate) {
    if (isEnabled(context)) start(context)
    state(context)
  }

  private suspend fun start(context: Context) {
    if (isRunning) return
    val request = pending ?: Start(UUID.randomUUID().toString(), CompletableDeferred()).also {
      pending = it
      try {
        ContextCompat.startForegroundService(context, Intent(context, RavenCatBackgroundService::class.java)
          .putExtra("startRequestId", it.id))
      } catch (failure: RuntimeException) {
        pending = null
        it.completion.completeExceptionally(failure)
      }
    }
    try { withTimeout(5_000L) { request.completion.await() } }
    finally { if (pending === request) pending = null }
  }

  internal fun accepts(context: Context, requestId: String?): Boolean =
    isEnabled(context) && (requestId == null || pending?.id == requestId)

  internal fun started(instance: RavenCatBackgroundService, requestId: String?) {
    service = instance
    ApplicationExecutionHost.ensureRuntime(instance)
    if (pending?.id == requestId) pending?.completion?.complete(Unit)
  }

  internal fun rejected(requestId: String?, failure: RuntimeException) {
    if (pending?.id == requestId) pending?.completion?.completeExceptionally(failure)
  }

  internal fun destroyed(instance: RavenCatBackgroundService) {
    if (service === instance) {
      service = null
      ApplicationExecutionHost.updatePresence()
    }
  }

  internal fun stopFromNotification(context: Context) {
    check(preferences(context).edit().putBoolean("enabled", false).commit()) { "无法关闭持续后台运行" }
    stop(context)
  }

  private fun stop(context: Context) {
    pending?.completion?.completeExceptionally(IllegalStateException("持续后台运行已关闭"))
    pending = null
    service?.stopForeground(Service.STOP_FOREGROUND_REMOVE)
    context.stopService(Intent(context, RavenCatBackgroundService::class.java))
    // 只撤销通用保障；不会取消聊天、通话、日程或它们的执行锁。
    service = null
    ApplicationExecutionHost.updatePresence()
  }

  private fun preferences(context: Context) = context.getSharedPreferences("ravencat_background_runtime", Context.MODE_PRIVATE)
}
