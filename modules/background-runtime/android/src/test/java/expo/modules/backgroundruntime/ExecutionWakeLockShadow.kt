package expo.modules.backgroundruntime

import android.os.PowerManager
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadows.ShadowPowerManager

/** 观测实际 acquire 的锁；Robolectric 每例清空 newWakeLock 历史，应用 owner 会复用已释放对象。 */
@Implements(PowerManager.WakeLock::class)
class ExecutionWakeLockShadow : ShadowPowerManager.ShadowWakeLock() {
  @RealObject private lateinit var actual: PowerManager.WakeLock
  @Implementation override fun acquire() { latest = actual; super.acquire() }
  @Implementation override fun acquire(timeout: Long) { latest = actual; super.acquire(timeout) }
  companion object { var latest: PowerManager.WakeLock? = null }
}
