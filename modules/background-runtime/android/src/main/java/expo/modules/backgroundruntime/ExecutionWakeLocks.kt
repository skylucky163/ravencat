package expo.modules.backgroundruntime

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import java.util.UUID

/** 项目只维护一把执行 CPU 锁；任务结束或到期只释放自己的登记，不停止应用后台服务。 */
object ExecutionWakeLocks {
  private data class Execution(val deadline: Long?, val expiry: Runnable?)
  private val handler = Handler(Looper.getMainLooper())
  private val executions = linkedMapOf<String, Execution>()
  private var lock: PowerManager.WakeLock? = null

  @Synchronized
  fun acquire(context: Context, timeoutMs: Long?): String {
    val id = UUID.randomUUID().toString()
    val expiry = timeoutMs?.let { Runnable { release(id) } }
    executions[id] = Execution(timeoutMs?.let { SystemClock.elapsedRealtime() + it }, expiry)
    if (lock == null) {
      lock = context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RavenCat:Execution")
        .apply { setReferenceCounted(false) }
    }
    if (expiry != null) handler.postDelayed(expiry, checkNotNull(timeoutMs))
    updateLock()
    return id
  }

  @Synchronized
  fun release(id: String) {
    val execution = executions.remove(id) ?: return // 原生超时后，业务终态仍可正常归还同一登记。
    execution.expiry?.let(handler::removeCallbacks)
    updateLock()
  }

  private fun updateLock() {
    val cpu = checkNotNull(lock)
    if (executions.isEmpty()) {
      if (cpu.isHeld) cpu.release()
    } else if (executions.values.any { it.deadline == null }) {
      // 通话按媒体终态释放，不给正在进行的电话设置任意总时长。
      cpu.acquire()
    } else {
      val remaining = executions.values.maxOf { checkNotNull(it.deadline) } - SystemClock.elapsedRealtime()
      cpu.acquire(remaining.coerceAtLeast(1L))
    }
  }
}
