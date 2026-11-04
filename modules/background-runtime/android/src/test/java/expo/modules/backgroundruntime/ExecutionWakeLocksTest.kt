package expo.modules.backgroundruntime

import android.os.Looper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/** 保护共享 CPU 锁的业务隔离与单调截止释放，不检查源码形状。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35], shadows = [ExecutionWakeLockShadow::class])
class ExecutionWakeLocksTest {
  private val context = RuntimeEnvironment.getApplication()

  @Test
  fun `one execution ending cannot release another execution`() {
    val chat = ExecutionWakeLocks.acquire(context, 600_000L)
    val call = ExecutionWakeLocks.acquire(context, null)
    val lock = checkNotNull(ExecutionWakeLockShadow.latest)
    ExecutionWakeLocks.release(chat)
    assertTrue(lock.isHeld)
    ExecutionWakeLocks.release(call)
    assertFalse(lock.isHeld)
  }

  @Test
  fun `expiry releases only its own execution and late completion is harmless`() {
    val short = ExecutionWakeLocks.acquire(context, 100L)
    val long = ExecutionWakeLocks.acquire(context, 1_000L)
    val lock = checkNotNull(ExecutionWakeLockShadow.latest)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
    assertTrue(lock.isHeld)
    ExecutionWakeLocks.release(short)
    assertTrue(lock.isHeld)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(900))
    assertFalse(lock.isHeld)
    ExecutionWakeLocks.release(long)
  }

}
