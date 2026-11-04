package expo.modules.ravencatfloatinglayer.companion

import android.content.Context
import expo.modules.ravencatfloatinglayer.RavenCatCompanionWakeEvent
import expo.modules.ravencatfloatinglayer.RavenCatCompanionWakeStore
import expo.modules.ravencatfloatinglayer.service.RavenCatOverlayService
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Companion 后台执行宿主的执行所有权验证。
 *
 * 保护的真实行为：一次 wake 的执行生命周期必须比它启动的 Headless JS 更长，
 * 且不依赖 Floating Interaction / Overlay FGS 的存活状态。
 */
@RunWith(RobolectricTestRunner::class)
class RavenCatCompanionExecutionHostTest {
  @Suppress("DEPRECATION")
  private val context: Context = RuntimeEnvironment.getApplication()

  @Before
  fun setUp() {
    RavenCatCompanionWakeStore.clearAllForFactoryReset(context)
  }

  @After
  fun tearDown() {
    RavenCatCompanionWakeStore.clearAllForFactoryReset(context)
  }

  @Test
  fun `execution host does not complete while runner terminal receipt is pending`() {
    val port = FakeExecutionPort()
    val outcome = AtomicReference<RavenCatCompanionExecutionOutcome?>(null)
    val executed = Thread {
      outcome.set(
        RavenCatCompanionExecutionHost.execute(
          context,
          dispatch(deliveryEventId = "wake-1"),
          timeoutMs = 5_000L,
          port = port,
        ),
      )
    }

    executed.start()
    assertTrue(port.headlessStarted.await(5, TimeUnit.SECONDS))
    // runner 尚未回执终态时，宿主不得宣告成功、也不得释放唯一执行保障。
    assertNull(outcome.get())

    RavenCatCompanionExecutionHost.signalRunnerCompletion("wake-1")
    executed.join(5_000)

    assertEquals(RavenCatCompanionExecutionOutcome.COMPLETED, outcome.get())
    // 收口诊断记录的是「收口时」前台执行的真实状态，而不是请求投递状态。
    assertTrue(RavenCatCompanionWakeStore.status(context).lastExecutionForegroundRunning)
  }

  @Test
  fun `execution host reports timeout and still releases execution`() {
    val port = FakeExecutionPort()
    val outcome = RavenCatCompanionExecutionHost.execute(
      context,
      dispatch(deliveryEventId = "wake-timeout"),
      timeoutMs = 100L,
      port = port,
      cancellationGraceMs = 100L,
    )

    // 超时后必须先显式请求 runner 取消，再收口；不得留下无 owner 的 autonomous 执行。
    assertEquals(RavenCatCompanionExecutionOutcome.TIMED_OUT, outcome)
    assertEquals(1, port.cancelRequests.get())
    assertEquals(1, port.headlessStarts.get())
    val status = RavenCatCompanionWakeStore.status(context)
    assertEquals("TIMED_OUT", status.lastExecutionOutcome)
    // 应用总开关仍开启；日程终态不能停止应用服务。
    assertTrue(status.lastExecutionForegroundRunning)
  }

  @Test
  fun `timeout honours cancellation receipt instead of abandoning the headless run`() {
    val port = FakeExecutionPort(cancelLeadsToRunnerReceipt = true)
    val outcome = RavenCatCompanionExecutionHost.execute(
      context,
      dispatch(deliveryEventId = "wake-cancelled"),
      timeoutMs = 100L,
      port = port,
    )

    // 取消请求让 runner 走 cancellation → terminal → 回执，宿主在宽限期内等到终态。
    assertEquals(RavenCatCompanionExecutionOutcome.COMPLETED, outcome)
    assertEquals(1, port.cancelRequests.get())
  }

  @Test
  fun `execution host reports start rejection without waiting for timeout`() {
    val port = FakeExecutionPort(headlessStartAccepted = false)
    val outcome = RavenCatCompanionExecutionHost.execute(
      context,
      dispatch(deliveryEventId = "wake-rejected"),
      timeoutMs = 30_000L,
      port = port,
    )

    assertEquals(RavenCatCompanionExecutionOutcome.START_REJECTED, outcome)
  }

  @Test
  fun `disabled application background does not block worker execution`() {
    val port = FakeExecutionPort(backgroundRunning = false)
    val executed = Thread {
      RavenCatCompanionExecutionHost.execute(
        context,
        dispatch(deliveryEventId = "wake-no-foreground"),
        timeoutMs = 5_000L,
        port = port,
      )
    }

    executed.start()
    assertTrue(port.headlessStarted.await(5, TimeUnit.SECONDS))
    RavenCatCompanionExecutionHost.signalRunnerCompletion("wake-no-foreground")
    executed.join(5_000)

    assertEquals(1, port.headlessStarts.get())
  }

  @Test
  fun `runner completion belongs to its own delivery identity`() {
    val port = FakeExecutionPort()
    val outcome = AtomicReference<RavenCatCompanionExecutionOutcome?>(null)
    val executed = Thread {
      outcome.set(
        RavenCatCompanionExecutionHost.execute(
          context,
          dispatch(deliveryEventId = "wake-a"),
          timeoutMs = 200L,
          port = port,
          cancellationGraceMs = 100L,
        ),
      )
    }

    executed.start()
    assertTrue(port.headlessStarted.await(5, TimeUnit.SECONDS))
    // 其它 delivery 的回执不得冒充本次 wake 的终态。
    RavenCatCompanionExecutionHost.signalRunnerCompletion("wake-b")
    executed.join(5_000)

    assertEquals(RavenCatCompanionExecutionOutcome.TIMED_OUT, outcome.get())
    assertEquals(1, port.cancelRequests.get())
  }

  @Test
  fun `worker stop still lets a cancelled runner reach its own terminal`() {
    val port = FakeExecutionPort(cancelLeadsToRunnerReceipt = true)
    val outcome = AtomicReference<RavenCatCompanionExecutionOutcome?>(null)
    val executed = Thread {
      outcome.set(
        RavenCatCompanionExecutionHost.execute(
          context,
          dispatch(deliveryEventId = "wake-interrupted"),
          timeoutMs = 30_000L,
          port = port,
          cancellationGraceMs = 5_000L,
        ),
      )
    }

    executed.start()
    assertTrue(port.headlessStarted.await(5, TimeUnit.SECONDS))
    // 模拟 WorkManager 停止 Worker（JobScheduler 执行上限 / REPLACE）时对等待线程的 interrupt。
    executed.interrupt()
    executed.join(5_000)

    // 取消请求在宽限内让 runner 走完 cancellation → terminal → 回执，就如实记为 COMPLETED。
    assertEquals(RavenCatCompanionExecutionOutcome.COMPLETED, outcome.get())
    assertEquals(1, port.cancelRequests.get())
  }

  @Test
  fun `worker stop does not pretend to still own the execution`() {
    val port = FakeExecutionPort()
    val outcome = AtomicReference<RavenCatCompanionExecutionOutcome?>(null)
    val executed = Thread {
      outcome.set(
        RavenCatCompanionExecutionHost.execute(
          context,
          dispatch(deliveryEventId = "wake-stopped"),
          timeoutMs = 30_000L,
          port = port,
          cancellationGraceMs = 100L,
        ),
      )
    }

    executed.start()
    assertTrue(port.headlessStarted.await(5, TimeUnit.SECONDS))
    executed.interrupt()
    executed.join(5_000)

    // WorkManager 中断时已经 resolve 掉本次 work：宿主不得继续假装拥有执行，
    // 也不得把这次结果报成 TIMED_OUT——两者在系统语义上是不同的事实。
    assertEquals(RavenCatCompanionExecutionOutcome.WORKER_STOPPED, outcome.get())
    assertEquals(1, port.cancelRequests.get())
    val status = RavenCatCompanionWakeStore.status(context)
    assertEquals("WORKER_STOPPED", status.lastExecutionOutcome)
  }

  @Test
  fun `cancellation survives host termination until a late runner consumes it`() {
    val port = FakeExecutionPort()
    RavenCatCompanionExecutionHost.execute(
      context,
      dispatch(deliveryEventId = "wake-late-runner"),
      timeoutMs = 100L,
      port = port,
      cancellationGraceMs = 100L,
    )

    // 收口之后标记仍必须在：runner 可能晚于宿主才注册，只能靠 consume 追平。
    assertTrue(
      "迟到注册的 runner 必须能追平这次取消",
      RavenCatCompanionWakeStore.consumeExecutionCancellation(context, "wake-late-runner"),
    )
    // 一次性：消费后不得再被消费第二次。
    assertFalse(RavenCatCompanionWakeStore.consumeExecutionCancellation(context, "wake-late-runner"))
  }

  @Test
  fun `execution start does not erase a previously requested cancellation`() {
    RavenCatCompanionWakeStore.markExecutionCancellationRequested(context, "wake-cancelled")
    val port = FakeExecutionPort(runnerCompletesImmediately = true)

    val outcome = RavenCatCompanionExecutionHost.execute(
      context,
      dispatch(deliveryEventId = "wake-cancelled"),
      timeoutMs = 5_000L,
      port = port,
    )

    assertEquals(RavenCatCompanionExecutionOutcome.COMPLETED, outcome)
    // `deliveryEventId` 就是 delivery identity：同一个 id 的再次执行是同一个 delivery，
    // 不是一个「全新执行」。执行宿主若在开工时抹掉取消事实，等于让已被取消的 delivery
    // 复活成一次正常执行；取消标记必须活到 runner 消费为止。
    assertTrue(
      "执行宿主不得清除自己没消费过的取消标记",
      RavenCatCompanionWakeStore.consumeExecutionCancellation(context, "wake-cancelled"),
    )
  }

  @Test
  fun `cancellation belongs to its own delivery identity`() {
    RavenCatCompanionWakeStore.markExecutionCancellationRequested(context, "wake-a")

    assertFalse(
      "其它 delivery 的取消标记不得被误消费",
      RavenCatCompanionWakeStore.consumeExecutionCancellation(context, "wake-b"),
    )
    assertTrue(RavenCatCompanionWakeStore.consumeExecutionCancellation(context, "wake-a"))
  }

  @Test
  fun `orphan cancellation markers are pruned instead of accumulating`() {
    val expiredDeliveryEventId = "wake-orphan-expired"
    // 直接写入一个超过 TTL 的孤儿标记：runner 始终没有出现（例如进程被回收）。
    check(
      context.getSharedPreferences("ravencat_companion_wake_store", Context.MODE_PRIVATE)
        .edit()
        .putLong(
          "executionCancellation:$expiredDeliveryEventId",
          System.currentTimeMillis() - 25 * 60 * 60 * 1000L,
        )
        .commit(),
    )

    RavenCatCompanionWakeStore.markExecutionCancellationRequested(context, "wake-fresh")

    assertFalse(
      "过期孤儿标记必须被剪掉，否则 SharedPreferences 会随 wake 次数无限增长",
      RavenCatCompanionWakeStore.consumeExecutionCancellation(context, expiredDeliveryEventId),
    )
    assertTrue(RavenCatCompanionWakeStore.consumeExecutionCancellation(context, "wake-fresh"))
  }

  @Test
  fun `execution host records its own outcome without touching wake business state`() {
    val port = FakeExecutionPort(backgroundRunning = false, headlessStartAccepted = false)
    RavenCatCompanionExecutionHost.execute(
      context,
      dispatch(deliveryEventId = "wake-diagnostics"),
      timeoutMs = 100L,
      port = port,
      cancellationGraceMs = 100L,
    )

    val status = RavenCatCompanionWakeStore.status(context)
    assertEquals("START_REJECTED", status.lastExecutionOutcome)
    assertEquals("wake-diagnostics", status.lastExecutionDeliveryEventId)
    assertTrue(status.lastExecutionAtEpochMs > 0L)
    // 应用持续后台运行关闭：收口真值必须如实记录为「未建立」。
    assertFalse(status.lastExecutionForegroundRunning)
    // 执行宿主只写自己的诊断，不得写入 runner 完成回执。
    assertFalse(RavenCatCompanionWakeStore.hasRecentRunnerCompletion(context, "wake-diagnostics"))
  }

  @Test
  fun `companion execution never starts or stops the overlay service`() {
    assertFalse(RavenCatOverlayService.isRunning)
    val port = FakeExecutionPort()

    RavenCatCompanionExecutionHost.execute(
      context,
      dispatch(deliveryEventId = "wake-independence"),
      timeoutMs = 100L,
      port = port,
      cancellationGraceMs = 100L,
    )

    assertFalse(
      "Companion 执行不得把 Overlay Service 当成自己的 keep-alive",
      RavenCatOverlayService.isRunning,
    )
    assertFalse(RavenCatOverlayService.isForegroundRunning)
  }

  private fun dispatch(deliveryEventId: String) = RavenCatCompanionWakeDispatch(
    event = RavenCatCompanionWakeEvent(
      wakeReason = "system_timer",
      source = "work-manager",
      eventId = deliveryEventId,
      createdAtEpochMs = System.currentTimeMillis(),
      scheduleRevision = 1L,
      hostAIId = "host-ai",
      deliveryEventId = deliveryEventId,
    ),
    deliveryEventId = deliveryEventId,
  )

  private class FakeExecutionPort(
    private val backgroundRunning: Boolean = true,
    private val headlessStartAccepted: Boolean = true,
    private val cancelLeadsToRunnerReceipt: Boolean = false,
    /** 模拟「runner 立刻回执终态」：不经过取消路径也能收口。 */
    private val runnerCompletesImmediately: Boolean = false,
  ) : RavenCatCompanionExecutionPort {
    val headlessStarts = AtomicInteger(0)
    val cancelRequests = AtomicInteger(0)
    val headlessStarted = CountDownLatch(1)

    override fun isApplicationBackgroundRunning(context: Context): Boolean = backgroundRunning

    override fun dispatchExecution(context: Context, event: RavenCatCompanionWakeEvent): Boolean {
      headlessStarts.incrementAndGet()
      headlessStarted.countDown()
      if (runnerCompletesImmediately) {
        RavenCatCompanionExecutionHost.signalRunnerCompletion(
          event.deliveryEventId ?: event.eventId,
        )
      }
      return headlessStartAccepted
    }

    override fun cancelExecution(context: Context, deliveryEventId: String) {
      cancelRequests.incrementAndGet()
      // 模拟「runner 收到取消 → cancellation → terminal → 回执」的最短路径。
      if (cancelLeadsToRunnerReceipt) {
        RavenCatCompanionExecutionHost.signalRunnerCompletion(deliveryEventId)
      }
    }
  }
}
