package expo.modules.backgroundruntime

import android.app.Application
import android.app.Service
import android.app.Notification
import android.app.ForegroundServiceStartNotAllowedException
import android.content.Intent
import android.content.ComponentName
import android.content.IntentFilter
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.android.controller.ServiceController
import org.robolectric.shadows.ShadowService

/** 开关寿命独立于业务，覆盖单实例、恢复、迟到启动和 Android 拒绝。 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35], application = ExecutionTestApplication::class, shadows = [ExecutionWakeLockShadow::class])
class BackgroundRuntimeTest {
  private val context: Application = RuntimeEnvironment.getApplication()
  private var controller: ServiceController<RavenCatBackgroundService>? = null

  @Before fun before() {
    Dispatchers.setMain(UnconfinedTestDispatcher())
    ExecutionWakeLockShadow.latest = null
    val entry = ComponentName(context.packageName, "TestLaunchActivity")
    val packages = shadowOf(context.packageManager)
    packages.addActivityIfNotPresent(entry).exported = true
    packages.addIntentFilterForActivity(entry, IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) })
  }
  @After fun after() = runBlocking {
    BackgroundRuntime.setEnabled(context, false)
    controller?.destroy()
    Dispatchers.resetMain()
  }

  private suspend fun CoroutineScope.enable(): Map<String, Boolean> {
    val opening = async(start = CoroutineStart.UNDISPATCHED) { BackgroundRuntime.setEnabled(context, true) }
    val intent = checkNotNull(shadowOf(context).nextStartedService)
    controller = Robolectric.buildService(RavenCatBackgroundService::class.java, intent).create().startCommand(0, 1)
    return opening.await()
  }

  @Test fun `enabled service stays running while idle without holding cpu`() = runBlocking {
    assertEquals(mapOf("enabled" to true, "running" to true), enable())
    assertNull(ExecutionWakeLockShadow.latest)
    repeat(3) { BackgroundRuntime.reconcile(context) }
    assertTrue(BackgroundRuntime.isRunning)
    assertNull(shadowOf(context).nextStartedService)
  }

  @Test fun `finishing multiple business executions never stops the shared service`() = runBlocking {
    enable()
    repeat(3) {
      val lock = ExecutionWakeLocks.acquire(context, 30_000L)
      ExecutionWakeLocks.release(lock)
      assertTrue(BackgroundRuntime.isRunning)
    }
    assertFalse(checkNotNull(ExecutionWakeLockShadow.latest).isHeld)
    assertNull(shadowOf(context).nextStartedService)
  }

  @Test fun `manual disable persists and does not cancel active media resources`() = runBlocking {
    enable()
    val call = ExecutionWakeLocks.acquire(context, null)
    BackgroundRuntime.setEnabled(context, false)
    controller!!.destroy(); controller = null
    assertFalse(BackgroundRuntime.isEnabled(context))
    assertFalse(BackgroundRuntime.isRunning)
    assertTrue(checkNotNull(ExecutionWakeLockShadow.latest).isHeld)
    ExecutionWakeLocks.release(call)
    BackgroundRuntime.reconcile(context)
    assertNull(shadowOf(context).nextStartedService)
  }

  @Test fun `process recreation restores only an explicitly enabled service`() = runBlocking {
    enable()
    controller!!.destroy(); controller = null
    assertTrue(BackgroundRuntime.isEnabled(context))
    assertFalse(BackgroundRuntime.isRunning)
    val restoring = async(start = CoroutineStart.UNDISPATCHED) { BackgroundRuntime.reconcile(context) }
    controller = Robolectric.buildService(RavenCatBackgroundService::class.java,
      checkNotNull(shadowOf(context).nextStartedService)).create().startCommand(0, 2)
    assertTrue(restoring.await()["running"]!!)
  }

  @Test fun `startup timeout cannot be revived by a late intent`() = runTest {
    val starting = async(start = CoroutineStart.UNDISPATCHED) {
      runCatching { BackgroundRuntime.setEnabled(context, true) }
    }
    val late = checkNotNull(shadowOf(context).nextStartedService)
    advanceTimeBy(5_001L); runCurrent()
    assertTrue(starting.await().isFailure)
    controller = Robolectric.buildService(RavenCatBackgroundService::class.java, late).create().startCommand(0, 1)
    assertTrue(BackgroundRuntime.isEnabled(context))
    assertFalse(BackgroundRuntime.isRunning)
  }

  @Test fun `manual disable wins over an already queued startup`() = runBlocking {
    val opening = async(start = CoroutineStart.UNDISPATCHED) {
      runCatching { BackgroundRuntime.setEnabled(context, true) }
    }
    val late = checkNotNull(shadowOf(context).nextStartedService)
    BackgroundRuntime.setEnabled(context, false)
    assertTrue(opening.await().isFailure)
    controller = Robolectric.buildService(RavenCatBackgroundService::class.java, late).create().startCommand(0, 1)
    assertFalse(BackgroundRuntime.isEnabled(context))
    assertFalse(BackgroundRuntime.isRunning)
  }

  @Test fun `stale startup cannot stop a subsequently accepted service`() = runTest {
    val opening = async(start = CoroutineStart.UNDISPATCHED) {
      runCatching { BackgroundRuntime.setEnabled(context, true) }
    }
    val late = checkNotNull(shadowOf(context).nextStartedService)
    advanceTimeBy(5_001L); runCurrent()
    assertTrue(opening.await().isFailure)
    enable()
    controller!!.withIntent(late).startCommand(0, 3)
    assertTrue(BackgroundRuntime.isRunning)
    assertFalse(shadowOf(controller!!.get()).isStoppedBySelf)
  }

  @Test fun `notification stop persists the same switch without touching execution locks`() = runBlocking {
    enable()
    val lock = ExecutionWakeLocks.acquire(context, 30_000L)
    val notification = checkNotNull(shadowOf(controller!!.get()).lastForegroundNotification)
    val stop = shadowOf(notification.actions.single().actionIntent).savedIntent
    controller!!.withIntent(stop).startCommand(0, 2)
    assertFalse(BackgroundRuntime.isEnabled(context))
    assertFalse(BackgroundRuntime.isRunning)
    assertTrue(checkNotNull(ExecutionWakeLockShadow.latest).isHeld)
    ExecutionWakeLocks.release(lock)
  }

  @Test
  @Config(shadows = [BackgroundForegroundDeniedShadow::class, ExecutionWakeLockShadow::class])
  fun `platform rejection keeps user intent but never reports running`() = runBlocking {
    val result = async(start = CoroutineStart.UNDISPATCHED) {
      runCatching { BackgroundRuntime.setEnabled(context, true) }
    }
    controller = Robolectric.buildService(RavenCatBackgroundService::class.java,
      checkNotNull(shadowOf(context).nextStartedService)).create().startCommand(0, 1)
    assertTrue(result.await().isFailure)
    assertTrue(BackgroundRuntime.isEnabled(context))
    assertFalse(BackgroundRuntime.isRunning)
  }
}

@Implements(Service::class)
class BackgroundForegroundDeniedShadow : ShadowService() {
  @Implementation override fun startForeground(id: Int, notification: Notification) {
    throw ForegroundServiceStartNotAllowedException("denied")
  }
  @Implementation override fun startForeground(id: Int, notification: Notification, foregroundServiceType: Int) {
    throw ForegroundServiceStartNotAllowedException("denied")
  }
}
