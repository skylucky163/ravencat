package expo.modules.ravencatfloatinglayer

import android.content.Context
import expo.modules.ravencatfloatinglayer.companion.RavenCatCompanionExecutionPort
import expo.modules.ravencatfloatinglayer.companion.RavenCatCompanionExecutionHost
import expo.modules.ravencatfloatinglayer.companion.RavenCatCompanionWakeDispatcher
import java.util.concurrent.atomic.AtomicInteger

internal class TestCompanionExecutionPort : RavenCatCompanionExecutionPort {
  var headlessStartAccepted = true
  val headlessStarts = AtomicInteger(0)
  val cancelRequests = AtomicInteger(0)
  val headlessDeliveryEventIds = mutableListOf<String>()

  override fun isApplicationBackgroundRunning(context: Context): Boolean = false

  override fun dispatchExecution(context: Context, event: RavenCatCompanionWakeEvent): Boolean {
    headlessStarts.incrementAndGet()
    val deliveryEventId = event.deliveryEventId ?: event.eventId
    headlessDeliveryEventIds += deliveryEventId
    RavenCatCompanionWakeDispatcher.notifyBridge(event)
    RavenCatCompanionExecutionHost.signalRunnerCompletion(deliveryEventId)
    return headlessStartAccepted
  }

  override fun cancelExecution(context: Context, deliveryEventId: String) {
    cancelRequests.incrementAndGet()
  }

  fun reset() {
    headlessStartAccepted = true
    headlessStarts.set(0)
    cancelRequests.set(0)
    headlessDeliveryEventIds.clear()
  }
}
