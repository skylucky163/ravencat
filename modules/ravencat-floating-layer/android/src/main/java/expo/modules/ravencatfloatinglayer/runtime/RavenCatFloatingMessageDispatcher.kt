package expo.modules.ravencatfloatinglayer.runtime

import android.content.Context
import android.util.Log
import expo.modules.backgroundruntime.ApplicationExecutionHost
import expo.modules.ravencatfloatinglayer.RavenCatFloatingMessageTaskRequest
import expo.modules.ravencatfloatinglayer.RavenCatFloatingMessageTaskStore

/** 悬浮请求交给应用常驻宿主；进程恢复只清理不确定请求，不重放发送。 */
internal class RavenCatFloatingMessageDispatcher(
  private val context: Context,
) {
  fun dispatch(
    action: String,
    text: String,
    correlationId: String,
    screenshotCorrelationId: String? = null,
  ): Boolean {
    val request = RavenCatFloatingMessageTaskRequest(
        action = action,
        text = text,
        correlationId = correlationId,
        createdAtEpochMs = System.currentTimeMillis(),
        screenshotCorrelationId = screenshotCorrelationId,
    )
    val accepted = try {
      RavenCatFloatingMessageTaskStore.recordPending(context, request)
      ApplicationExecutionHost.post(context, "floating", mapOf(
        "action" to request.action, "text" to request.text, "correlationId" to request.correlationId,
        "createdAtEpochMs" to request.createdAtEpochMs.toDouble(), "screenshotCorrelationId" to request.screenshotCorrelationId,
      ), 600_000L).also {
        if (it) RavenCatFloatingMessageTaskStore.recordStartAccepted(context)
        else RavenCatFloatingMessageTaskStore.recordStartFailed(context, correlationId, "应用宿主未接受执行请求")
      }
    } catch (failure: RuntimeException) {
      RavenCatFloatingMessageTaskStore.recordStartFailed(context, correlationId, failure.message ?: failure.javaClass.simpleName)
      false
    }
    Log.i(TAG, "悬浮任务 correlationId=$correlationId action=$action accepted=$accepted")
    return accepted
  }

  fun recoverStaleRequests(onRecovered: (RavenCatFloatingMessageTaskRequest, String) -> Unit) {
    RavenCatFloatingMessageTaskStore.readPendingTasks(context).forEach { pending ->
      val error = "进程重启后不能安全重放未完成的悬浮请求"
      RavenCatFloatingMessageTaskStore.recordCompletion(
        context = context,
        correlationId = pending.correlationId,
        succeeded = false,
        error = error,
      )
      onRecovered(pending, error)
    }
  }

  companion object {
    private const val TAG = "RavenCatFloatingTask"
  }
}
