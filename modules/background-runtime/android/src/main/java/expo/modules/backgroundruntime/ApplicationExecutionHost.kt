package expo.modules.backgroundruntime

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.UUID

/** 一份应用执行宿主。信箱只跨越桥接初始化，不持久化业务，也不重放已经取走的请求。 */
object ApplicationExecutionHost {
  private data class Request(val id: String, val kind: String, val data: Map<String, Any?>, val deadline: Long?)
  private val handler = Handler(Looper.getMainLooper())
  private val pending = linkedMapOf<String, Request>()
  private val executing = mutableSetOf<String>()
  private val media = linkedMapOf<String, String>()
  private var reactContext: ReactContext? = null
  private var notify: (() -> Unit)? = null
  private var runtimeTask: Int? = null

  @Synchronized
  fun post(context: Context, kind: String, data: Map<String, Any?>, timeoutMs: Long): Boolean {
    return try {
      val id = if (timeoutMs > 0) ExecutionWakeLocks.acquire(context, timeoutMs) else UUID.randomUUID().toString()
      pending[id] = Request(id, kind, data, if (timeoutMs > 0) SystemClock.elapsedRealtime() + timeoutMs else null)
      handler.post { ensureRuntime(context.applicationContext); notify?.invoke() }
      true
    } catch (failure: RuntimeException) {
      Log.e("RavenCatExecutionHost", "Android 未接受应用执行请求", failure)
      false
    }
  }

  fun ensureRuntime(context: Context) {
    if (reactContext != null) { updatePresence(); return }
    // ReactHost 自己保证单次初始化；不开 Activity，不为请求创建 Service 或 Headless 任务。
    try { checkNotNull((context.applicationContext as ReactApplication).reactHost).start() }
    catch (failure: RuntimeException) { Log.e("RavenCatExecutionHost", "无法初始化应用执行环境", failure) }
  }

  fun connect(context: ReactContext, listener: () -> Unit) {
    reactContext?.takeIf { it !== context }?.let(::disconnect)
    reactContext = context
    notify = listener
    updatePresence()
  }

  /** 总服务或实际通话媒体持有运行资格；多条消息共用同一个 RN 身份，空闲不获取 CPU 锁。 */
  fun updatePresence() {
    val connected = reactContext ?: return
    val tasks = HeadlessJsTaskContext.getInstance(connected)
    if (BackgroundRuntime.isRunning || media.isNotEmpty()) {
      if (runtimeTask == null) runtimeTask = tasks.startTask(
        HeadlessJsTaskConfig("RavenCatApplicationExecution", Arguments.createMap(), 0L, true))
    } else {
      runtimeTask?.let(tasks::finishTask)
      runtimeTask = null
    }
  }

  @Synchronized
  fun takePending(): List<Map<String, Any?>> {
    val now = SystemClock.elapsedRealtime()
    val requests = pending.values.map {
      executing.add(it.id)
      mapOf("id" to it.id, "kind" to it.kind, "data" to it.data,
        "remainingMs" to it.deadline?.let { deadline -> (deadline - now).coerceAtLeast(0L).toDouble() })
    }
    pending.clear()
    return requests
  }

  @Synchronized
  fun complete(id: String) {
    executing.remove(id)
    ExecutionWakeLocks.release(id)
  }

  fun attachMedia(context: Context, id: String) {
    check(!media.containsKey(id))
    media[id] = ExecutionWakeLocks.acquire(context, null)
    updatePresence()
  }

  fun detachMedia(id: String) {
    media.remove(id)?.let(ExecutionWakeLocks::release)
    updatePresence()
  }

  @Synchronized
  fun disconnect(context: ReactContext) {
    if (reactContext !== context) return
    runtimeTask?.let(HeadlessJsTaskContext.getInstance(context)::finishTask)
    runtimeTask = null
    reactContext = null
    notify = null
    executing.forEach(ExecutionWakeLocks::release)
    executing.clear()
  }
}
