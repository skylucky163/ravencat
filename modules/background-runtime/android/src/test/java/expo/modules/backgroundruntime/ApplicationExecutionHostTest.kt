package expo.modules.backgroundruntime

import android.content.Intent
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import org.junit.After
import org.junit.Before
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.time.Duration

/** 验证常驻身份不随消息增减、桥接启动不丢请求、预算与跨 React 实例所有权。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35], application = ExecutionTestApplication::class,
  shadows = [ExecutionArgumentsShadow::class, ExecutionWakeLockShadow::class])
class ApplicationExecutionHostTest {
  private val app = RuntimeEnvironment.getApplication()
  private val context = BridgeReactContext(app)
  private val tasks = HeadlessJsTaskContext.getInstance(context)
  private var starts = 0
  private var finishes = 0
  private lateinit var service: ServiceController<RavenCatBackgroundService>
  private val listener = object : HeadlessJsTaskEventListener {
    override fun onHeadlessJsTaskStart(id: Int) { starts++ }
    override fun onHeadlessJsTaskFinish(id: Int) { finishes++ }
  }

  @Before fun before() {
    app.getSharedPreferences("ravencat_background_runtime", 0).edit().putBoolean("enabled", true).commit()
    val entry = android.content.ComponentName(app.packageName, "TestLaunchActivity")
    val packages = shadowOf(app.packageManager)
    packages.addActivityIfNotPresent(entry).exported = true
    packages.addIntentFilterForActivity(entry, android.content.IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) })
    tasks.addTaskEventListener(listener)
    service = Robolectric.buildService(RavenCatBackgroundService::class.java).create().startCommand(0, 1)
  }

  @After fun after() {
    ApplicationExecutionHost.takePending().forEach { ApplicationExecutionHost.complete(it["id"] as String) }
    ApplicationExecutionHost.disconnect(context)
    service.destroy()
  }

  @Test fun `many requests share one runtime identity and no request starts a service`() {
    ApplicationExecutionHost.connect(context) {}
    assertEquals(1, starts)
    repeat(5) { ApplicationExecutionHost.post(app, "conversation", mapOf("sessionIds" to listOf("chat-$it")), 60_000L) }
    shadowOf(Looper.getMainLooper()).idle()
    val requests = ApplicationExecutionHost.takePending()
    assertEquals(5, requests.size)
    requests.forEach { ApplicationExecutionHost.complete(it["id"] as String) }
    assertTrue(tasks.hasActiveTasks())
    assertEquals(1, starts)
    assertEquals(0, finishes)
    assertNull(shadowOf(app).nextStartedService)
    assertFalse(checkNotNull(ExecutionWakeLockShadow.latest).isHeld)
  }

  @Test fun `requests posted before bridge connection are delivered once`() {
    ApplicationExecutionHost.post(app, "call_action", mapOf("callId" to "call"), 30_000L)
    shadowOf(Looper.getMainLooper()).idle()
    ApplicationExecutionHost.connect(context) {}
    val requests = ApplicationExecutionHost.takePending()
    assertEquals("call", (requests.single()["data"] as Map<*, *>)["callId"])
    assertEquals(emptyList<Map<String, Any?>>(), ApplicationExecutionHost.takePending())
    ApplicationExecutionHost.complete(requests.single()["id"] as String)
  }

  @Test fun `waiting for the bridge consumes the request budget`() {
    ApplicationExecutionHost.post(app, "conversation", emptyMap(), 100L)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
    val request = ApplicationExecutionHost.takePending().single()
    assertEquals(0.0, request["remainingMs"])
    ApplicationExecutionHost.complete(request["id"] as String)
    assertFalse(checkNotNull(ExecutionWakeLockShadow.latest).isHeld)
  }

  @Test fun `media extends the same runtime after the background service stops`() {
    ApplicationExecutionHost.connect(context) {}
    ApplicationExecutionHost.attachMedia(app, "call")
    service.destroy()
    assertTrue(tasks.hasActiveTasks())
    assertEquals(1, starts)
    ApplicationExecutionHost.detachMedia("call")
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(tasks.hasActiveTasks())
    assertEquals(1, finishes)
  }

  @Test fun `old bridge destruction cannot terminate the replacement runtime`() {
    ApplicationExecutionHost.connect(context) {}
    val next = BridgeReactContext(app)
    ApplicationExecutionHost.connect(next) {}
    ApplicationExecutionHost.disconnect(context)
    assertTrue(HeadlessJsTaskContext.getInstance(next).hasActiveTasks())
    assertFalse(tasks.hasActiveTasks())
    ApplicationExecutionHost.disconnect(next)
  }
}

/** 空启动数据的序列化边界，不在 JVM 单元测试启动 JNI 引擎。 */
@Implements(Arguments::class)
class ExecutionArgumentsShadow {
  companion object {
    @JvmStatic @Implementation fun createMap(): WritableMap = JavaOnlyMap()
  }
}
