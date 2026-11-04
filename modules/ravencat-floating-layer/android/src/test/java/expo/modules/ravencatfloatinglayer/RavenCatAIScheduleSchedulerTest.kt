package expo.modules.ravencatfloatinglayer

import android.content.Context
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import androidx.work.Configuration
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import expo.modules.ravencatfloatinglayer.companion.RavenCatCompanionAndroidExecutionPort
import expo.modules.ravencatfloatinglayer.companion.RavenCatCompanionExecutionHost
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/**
 * AI Schedule delivery 的 native gate。
 *
 * 保护的真实行为：一个 `scheduleId@projectionToken` delivery 只有当前投影的 winner
 * 才能进入 execution host；WorkManager 重复投递 / 进程重建后的重新执行只能是
 * ABSENT 或 STALE，不得再执行一次（也正因如此，取消事实可以安全地留在
 * `deliveryEventId` 上而不需要任何「新执行复位取消」的特例）。
 */
@RunWith(RobolectricTestRunner::class)
class RavenCatAIScheduleSchedulerTest {
  @Suppress("DEPRECATION")
  private val context: Context = RuntimeEnvironment.getApplication()
  private val executionPort = TestCompanionExecutionPort()

  private val scheduleId = "scheduler-token-test"
  private val remindAtEpochMs = 2_000L

  @Before
  fun setUp() {
    WorkManagerTestInitHelper.initializeTestWorkManager(
      context,
      Configuration.Builder().setExecutor(SynchronousExecutor()).build(),
    )
    RavenCatAIScheduleStore.setEnabled(context, true)
    RavenCatCompanionWakeStore.clearAllForFactoryReset(context)
    RavenCatAIScheduleStore.remove(context, scheduleId)
    // 本测试只验证 native gate；执行生命周期本身由 RavenCatCompanionExecutionHostTest 覆盖，
    // 这里的端口让 runner 立即回执终态，不引入真实 Headless JS。
    RavenCatCompanionExecutionHost.platformPort = executionPort
  }

  @After
  fun tearDown() {
    RavenCatCompanionExecutionHost.platformPort = RavenCatCompanionAndroidExecutionPort
    RavenCatAIScheduleScheduler.clearStoredStateForFactoryReset(context)
    RavenCatCompanionWakeStore.clearAllForFactoryReset(context)
    executionPort.reset()
  }

  @Test
  fun `disabled worker cannot start AI execution`() {
    RavenCatAIScheduleStore.put(context, projection("v1"))
    RavenCatAIScheduleScheduler.setEnabled(context, false)
    assertEquals(ListenableWorker.Result.success(), worker("v1").doWork())
    assertEquals(0, executionPort.headlessStarts.get())
    assertNull(RavenCatAIScheduleStore.get(context, scheduleId))
  }

  @Test
  fun `upgrade removes the legacy single wake alarm before using unified schedules`() {
    val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val legacy = PendingIntent.getBroadcast(
      context, 41021,
      Intent().setComponent(ComponentName(context.packageName, "expo.modules.ravencatfloatinglayer.RavenCatCompanionAlarmReceiver"))
        .setAction("expo.modules.ravencatfloatinglayer.action.SELF_WAKE_ALARM"),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 60_000L, legacy)
    val legacyPrefs = context.getSharedPreferences("ravencat_companion_wake_scheduler", Context.MODE_PRIVATE)
    legacyPrefs.edit().putBoolean("scheduled", true).commit()
    RavenCatAIScheduleScheduler.setEnabled(context, true)
    assertEquals(0, shadowOf(manager).scheduledAlarms.size)
    assertEquals(0, legacyPrefs.all.size)
  }

  @Test
  fun `keyed alarms coexist and switch off removes every pending projection`() {
    val future = projection("v1").copy(expectedRemindAtEpochMs = System.currentTimeMillis() + 60_000L)
    RavenCatAIScheduleScheduler.schedule(context, future)
    RavenCatAIScheduleScheduler.schedule(context, future.copy(scheduleId = "another-schedule"))
    val alarms = shadowOf(context.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
    assertEquals(2, alarms.scheduledAlarms.size)
    RavenCatAIScheduleScheduler.setEnabled(context, false)
    assertEquals(0, alarms.scheduledAlarms.size)
    assertEquals(0, RavenCatAIScheduleStore.list(context).size)
    assertFalse(RavenCatAIScheduleStore.isEnabled(context))
  }

  @Test
  fun `boot restores future alarms only and does nothing when paused`() {
    val future = projection("v1").copy(expectedRemindAtEpochMs = System.currentTimeMillis() + 60_000L)
    RavenCatAIScheduleStore.put(context, future)
    RavenCatAIScheduleStore.put(context, future.copy(scheduleId = "missed", expectedRemindAtEpochMs = 1L))
    val alarms = shadowOf(context.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
    RavenCatAIScheduleScheduler.restoreFutureAlarms(context)
    assertEquals(1, alarms.scheduledAlarms.size)
    RavenCatAIScheduleScheduler.setEnabled(context, false)
    RavenCatAIScheduleScheduler.restoreFutureAlarms(context)
    assertEquals(0, alarms.scheduledAlarms.size)
  }

  @Test
  fun `stale worker cannot remove newer projection`() {
    val newer = projection(projectionToken = "v2")
    RavenCatAIScheduleStore.put(context, newer)

    val outcome = RavenCatAIScheduleScheduler.consumeDueTriggerIfCurrent(
      context = context,
      scheduleId = scheduleId,
      expectedRemindAtEpochMs = 1_000L,
      projectionToken = "v1",
    )

    assertEquals(RavenCatAIScheduleConsumeOutcome.STALE, outcome)
    assertEquals(newer, RavenCatAIScheduleStore.get(context, scheduleId))
  }

  @Test
  fun `matching worker removes exactly its projection`() {
    val current = projection(projectionToken = "v2")
    RavenCatAIScheduleStore.put(context, current)

    val outcome = RavenCatAIScheduleScheduler.consumeDueTriggerIfCurrent(
      context = context,
      scheduleId = scheduleId,
      expectedRemindAtEpochMs = current.expectedRemindAtEpochMs,
      projectionToken = current.projectionToken,
    )

    assertEquals(RavenCatAIScheduleConsumeOutcome.CONSUMED, outcome)
    assertNull(RavenCatAIScheduleStore.get(context, scheduleId))
  }

  @Test
  fun `absent projection reports absent instead of consuming nothing`() {
    val outcome = RavenCatAIScheduleScheduler.consumeDueTriggerIfCurrent(
      context = context,
      scheduleId = scheduleId,
      expectedRemindAtEpochMs = remindAtEpochMs,
      projectionToken = "v1",
    )

    assertEquals(RavenCatAIScheduleConsumeOutcome.ABSENT, outcome)
  }

  @Test
  fun `due projection winner reaches execution host exactly once`() {
    RavenCatAIScheduleStore.put(context, projection(projectionToken = "v1"))

    val result = worker(projectionToken = "v1").doWork()

    assertEquals(ListenableWorker.Result.success(), result)
    assertEquals(1, executionPort.headlessStarts.get())
    assertEquals(listOf("$scheduleId@v1"), executionPort.headlessDeliveryEventIds)
    assertNull(RavenCatAIScheduleStore.get(context, scheduleId))
    val stages = RavenCatCompanionWakeStore.scheduleDiagnostics(context)
    assertEquals("WORKER_STARTED", stages.first()["stage"])
    assertEquals("HOST_FINISHED", stages.last()["stage"])
    assertEquals(setOf("$scheduleId@v1"), stages.map { it["deliveryEventId"] }.toSet())
  }

  @Test
  fun `diagnostics retain bounded separate deliveries without request content`() {
    repeat(RavenCatCompanionWakeStore.MAX_SCHEDULE_DIAGNOSTICS + 3) { index ->
      RavenCatCompanionWakeStore.recordScheduleDiagnostic(context, "schedule-$index@v1",
        AIScheduleDiagnosticStage.ALARM_RECEIVED, remindAtEpochMs)
    }
    val history = RavenCatCompanionWakeStore.scheduleDiagnostics(context)
    assertEquals(RavenCatCompanionWakeStore.MAX_SCHEDULE_DIAGNOSTICS, history.size)
    assertEquals("schedule-3@v1", history.first()["deliveryEventId"])
    assertEquals(remindAtEpochMs, history.first()["expectedRemindAtEpochMs"])
    RavenCatCompanionWakeStore.recordRunnerCompletion(context, "failed@v1", false, "private request content")
    assertEquals("FAILED", RavenCatCompanionWakeStore.scheduleDiagnostics(context).last()["outcome"])
    RavenCatCompanionWakeStore.recordRunnerCompletion(context, "model@v1", true, "agent_terminal:MODEL_REQUEST_FAILED")
    assertEquals("agent_terminal:MODEL_REQUEST_FAILED", RavenCatCompanionWakeStore.scheduleDiagnostics(context).last()["outcome"])
    RavenCatCompanionWakeStore.clearAllForFactoryReset(context)
    assertEquals(emptyList<Map<String, Any?>>(), RavenCatCompanionWakeStore.scheduleDiagnostics(context))
  }

  @Test
  fun `diagnostic storage failure cannot prevent schedule execution`() {
    context.getSharedPreferences("ravencat_companion_wake_store", Context.MODE_PRIVATE)
      .edit().putString("aiScheduleDiagnostics", "invalid json").commit()
    RavenCatAIScheduleStore.put(context, projection("v1"))
    assertEquals(ListenableWorker.Result.success(), worker("v1").doWork())
    assertEquals(1, executionPort.headlessStarts.get())
  }

  @Test
  fun `redelivered work for a consumed delivery never reaches execution host again`() {
    RavenCatAIScheduleStore.put(context, projection(projectionToken = "v1"))

    assertEquals(ListenableWorker.Result.success(), worker(projectionToken = "v1").doWork())
    // 系统重投递 / 进程重建后重新执行同一个 `scheduleId@projectionToken`。
    assertEquals(ListenableWorker.Result.success(), worker(projectionToken = "v1").doWork())

    assertEquals(1, executionPort.headlessStarts.get())
  }

  @Test
  fun `worker without projection never reaches execution host`() {
    // 已取消 / 从未调度：没有可执行的 delivery。
    val result = worker(projectionToken = "v1").doWork()

    assertEquals(ListenableWorker.Result.success(), result)
    assertEquals(0, executionPort.headlessStarts.get())
  }

  @Test
  fun `stale worker never reaches execution host and keeps the newer projection`() {
    RavenCatAIScheduleStore.put(context, projection(projectionToken = "v2"))

    val result = worker(projectionToken = "v1").doWork()

    assertEquals(ListenableWorker.Result.success(), result)
    assertEquals(0, executionPort.headlessStarts.get())
    assertEquals("v2", RavenCatAIScheduleStore.get(context, scheduleId)?.projectionToken)
  }

  @Test
  fun `updated schedule runs under its own delivery identity`() {
    RavenCatAIScheduleStore.put(context, projection(projectionToken = "v1"))
    // update 之后的 schedule：同一个 scheduleId，新的 projectionToken。
    RavenCatAIScheduleStore.put(context, projection(projectionToken = "v2"))

    assertEquals(ListenableWorker.Result.success(), worker(projectionToken = "v1").doWork())
    assertEquals(0, executionPort.headlessStarts.get())

    assertEquals(ListenableWorker.Result.success(), worker(projectionToken = "v2").doWork())

    assertEquals(1, executionPort.headlessStarts.get())
    assertEquals(listOf("$scheduleId@v2"), executionPort.headlessDeliveryEventIds)
  }

  private fun projection(projectionToken: String) = RavenCatAIScheduleProjection(
    scheduleId = scheduleId,
    ownerAIId = "host-ai",
    expectedRemindAtEpochMs = remindAtEpochMs,
    projectionToken = projectionToken,
  )

  /**
   * Worker 的 inputData key 是 WorkManager 持久化的工作请求的一部分（升级后仍要能读回），
   * 因此这里是 wire 契约而不是实现细节。
   */
  private fun worker(projectionToken: String) =
    TestWorkerBuilder<RavenCatAIScheduleWorker>(
      context = context,
      executor = SynchronousExecutor(),
      inputData = Data.Builder()
        .putString("eventId", scheduleId)
        .putString("ownerAIId", "host-ai")
        .putLong("expectedRemindAtEpochMs", remindAtEpochMs)
        .putString("projectionToken", projectionToken)
        .build(),
    ).build()
}
