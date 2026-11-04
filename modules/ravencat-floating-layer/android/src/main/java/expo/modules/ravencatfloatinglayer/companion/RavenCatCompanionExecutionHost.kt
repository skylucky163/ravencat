package expo.modules.ravencatfloatinglayer.companion

import android.content.Context
import android.util.Log
import expo.modules.backgroundruntime.BackgroundRuntime
import expo.modules.ravencatfloatinglayer.RavenCatCompanionWakeEvent
import expo.modules.backgroundruntime.ApplicationExecutionHost
import expo.modules.ravencatfloatinglayer.RavenCatCompanionWakeStore
import expo.modules.ravencatfloatinglayer.AIScheduleDiagnosticStage
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Proactive Companion 的后台执行宿主。
 *
 * 所有权：
 * - 本次 wake delivery 的执行生命周期（从「取得 native dispatch 权」到「autonomous run 到达终态」）；
 * - 等待与取消本次执行；持续前台保障由应用总开关独立拥有；
 * - 向共享应用宿主提交执行请求；
 * - 业务完成回执的等待与超时收口。
 *
 * 不拥有：SQLite 业务真相、claim / consume、AI Agent Runtime。
 *
 * 取消所有权：取消事实属于「拥有 execution identity 的 native 层」
 * （`RavenCatCompanionWakeStore` 按 `deliveryEventId` 持有）。本宿主只**写入**
 * 取消请求，从不删除它——删除等于让一个已被取消的 delivery 复活。
 *
 * 关键不变量：Worker 等到 runner 回报终态才能宣告成功；超时必须记录取消与实际结果。
 * 本层不启停应用总服务；总开关关闭时，只能尽力使用 Worker 的系统执行窗口。
 */
internal enum class RavenCatCompanionExecutionOutcome {
  /** JS runner 已回执终态（成功或失败都算终态）。 */
  COMPLETED,

  /** 应用宿主未接受 wake；保留既有 pending 恢复路径。 */
  START_REJECTED,

  /** 有界等待耗尽，runner 未回执终态。 */
  TIMED_OUT,

  /**
   * Worker 已被 WorkManager 停止（JobScheduler 单次执行上限 / REPLACE / cancel），
   * 且 runner 在取消宽限内仍未回执终态。
   *
   * 与 [TIMED_OUT] 的区别不是「谁等得更久」，而是**系统已经撤回本次执行的执行权**：
   * WorkManager 在中断那一刻就 resolve 了这次 work，不再接受它的 Result。
   * 这个结果必须如实暴露，不能报成 [TIMED_OUT]，否则真机诊断分不清
   * 「自己等超时」与「被系统停止」。
   */
  WORKER_STOPPED,
}

/** execution host 与 Android 平台之间的窄端口；测试可替换为纯内存实现。 */
internal interface RavenCatCompanionExecutionPort {
  /** 只读应用级保障；日程无权启动、停止或改写总开关。 */
  fun isApplicationBackgroundRunning(context: Context): Boolean

  /** 提交应用宿主请求；返回 false 表示原生信箱未接受这次 wake。 */
  fun dispatchExecution(context: Context, event: RavenCatCompanionWakeEvent): Boolean

  /** 请求 runner 取消当前 delivery 的 autonomous 执行；超时收口路径使用。 */
  fun cancelExecution(context: Context, deliveryEventId: String)
}

internal object RavenCatCompanionAndroidExecutionPort : RavenCatCompanionExecutionPort {
  override fun isApplicationBackgroundRunning(context: Context): Boolean = BackgroundRuntime.isRunning

  override fun dispatchExecution(context: Context, event: RavenCatCompanionWakeEvent): Boolean {
    RavenCatCompanionWakeStore.recordHeadlessTaskStartRequested(context, event)
    val accepted = ApplicationExecutionHost.post(context, "companion", mapOf(
        "wakeReason" to event.wakeReason, "source" to event.source, "eventId" to event.eventId,
        "createdAtEpochMs" to event.createdAtEpochMs.toDouble(), "scheduleRevision" to event.scheduleRevision.toDouble(),
        "hostAIId" to event.hostAIId, "triggerKind" to event.triggerKind,
        "expectedRemindAtEpochMs" to event.expectedRemindAtEpochMs?.toDouble(),
        "projectionToken" to event.projectionToken, "deliveryEventId" to event.deliveryEventId,
      ), 660_000L)
    if (accepted) {
      RavenCatCompanionWakeStore.recordHeadlessTaskStartAccepted(context, event)
    } else {
      RavenCatCompanionWakeStore.recordHeadlessTaskStartFailed(context, event, "应用宿主未接受执行请求")
      RavenCatCompanionWakeStore.recordPending(context, event)
    }
    // 进程内 JS 观察者只是附加观察面；它是否存在不参与执行结果判定。
    RavenCatCompanionWakeDispatcher.notifyBridge(event)
    return accepted
  }

  override fun cancelExecution(context: Context, deliveryEventId: String) =
    RavenCatCompanionWakeDispatcher.notifyExecutionCancel(deliveryEventId)
}

internal object RavenCatCompanionExecutionHost {
  /**
   * 单次 wake 执行的等待上界。
   *
   * 取值覆盖正常 autonomous Agent Run（多轮模型 + 工具调用），同时保证执行宿主不会
   * 无限占用前台执行；超过上界只会把本次 delivery 记为未确认终态，由 runner 自己的
   * claim / consume 语义与诊断收口，不重跑同一个 wake。
   */
  internal const val EXECUTION_TIMEOUT_MS = 10 * 60 * 1000L

  /**
   * 放弃执行保障前，留给 runner 完成取消收口的宽限期。
   *
   * 只表示「再给 cancellation → terminal → consume → 回执一次有界机会」，
   * **不代表宿主仍拥有系统执行保障**：超时与「Worker 被停止」都会走这段宽限。
   * 没有这一步，执行宿主会比它启动的 Headless autonomous run 更早结束。
   */
  internal const val CANCELLATION_GRACE_MS = 60 * 1000L

  /**
   * 平台执行端口。
   *
   * 默认是 Android 实现；测试可以替换为内存实现（与
   * `RavenCatCompanionWakeDispatcher.setListener` 同类的最小接缝），
   * 用来在不需要真实 Headless JS 的前提下表达 runner 终态。
   */
  internal var platformPort: RavenCatCompanionExecutionPort = RavenCatCompanionAndroidExecutionPort

  private val waitingForRunnerCompletion = ConcurrentHashMap<String, CountDownLatch>()

  fun execute(
    context: Context,
    dispatch: RavenCatCompanionWakeDispatch,
    timeoutMs: Long = EXECUTION_TIMEOUT_MS,
    port: RavenCatCompanionExecutionPort = platformPort,
    cancellationGraceMs: Long = CANCELLATION_GRACE_MS,
  ): RavenCatCompanionExecutionOutcome {
    val deliveryEventId = dispatch.deliveryEventId
    // 这里**不**清除该 delivery 的取消标记。
    //
    // `deliveryEventId` 同时是 execution / completion / dedupe / cancellation identity：
    // 同一个 id 就是同一个 delivery，「系统重投递」不等于「全新执行」。
    // 清除取消标记等于让一个已被取消的 delivery 复活。
    // 真正的入口幂等由上游 native gate 保证——
    // AI 日程走 `consumeDueTriggerIfCurrent`，只有 CONSUMED 才 dispatch；
    // 消费成功后撤销投影，重复投递只能是 STALE / ABSENT。
    // 真正的新版本本来就有新的 delivery identity（AI Schedule 是新的 projectionToken）。
    //
    // 先登记等待再启动 JS：runner 可能在本线程返回前就写下终态回执。
    val completion = CountDownLatch(1)
    waitingForRunnerCompletion[deliveryEventId] = completion
    Log.i(TAG, "companion_execution_host_started deliveryEventId=$deliveryEventId")
    RavenCatCompanionWakeStore.recordScheduleDiagnostic(context, deliveryEventId,
      AIScheduleDiagnosticStage.HOST_STARTED, dispatch.event.expectedRemindAtEpochMs)

    // 总开关关闭时仍可使用 Worker 的系统执行窗口；日程不另起一份前台服务。
    var foregroundRunning = false
    val outcome = try {
      if (!port.dispatchExecution(context, dispatch.event)) {
        RavenCatCompanionExecutionOutcome.START_REJECTED
      } else {
        awaitRunnerTerminal(
          context,
          deliveryEventId,
          completion,
          port,
          timeoutMs,
          cancellationGraceMs,
        )
      }
    } finally {
      foregroundRunning = port.isApplicationBackgroundRunning(context)
      waitingForRunnerCompletion.remove(deliveryEventId)
    }

    RavenCatCompanionWakeStore.recordExecutionOutcome(
      context,
      deliveryEventId,
      outcome.name,
      foregroundRunning,
    )
    Log.i(
      TAG,
      "companion_execution_host_stopped deliveryEventId=$deliveryEventId " +
        "outcome=$outcome " +
        "foregroundRunning=$foregroundRunning",
    )
    return outcome
  }

  /**
   * 等待 runner 终态回执；退出路径只有两条：等到回执，或放弃执行保障。
   *
   * WorkManager 停止 contract（2.8.0，`WorkerWrapper.interrupt()` 已在字节码层确认）：
   *
   * ```text
   * mInterrupted = true
   * → tryCheckForInterruptionAndResolve()   // 立刻 resolve 本次 work
   * → mWorkerResultFuture.cancel(true)      // 中断等待线程
   * → worker.stop()
   * ```
   *
   * 也就是说 [InterruptedException] 到达时，**WorkManager 已经把这次 work 判终**，
   * `doWork()` 之后返回的 Result 会被丢弃。线程还能继续跑 ≠ WorkManager 仍拥有本次执行，
   * 因此这里不得吞掉中断继续假装持有执行保障：只做一次「取消 runner」的尽力请求，
   * 再给一个有界宽限让 cancellation → terminal → consume → 回执有机会落地，
   * 然后以 [RavenCatCompanionExecutionOutcome.WORKER_STOPPED] 如实收口。
   *
   * 中断标记由 `CountDownLatch.await` 抛出时清除，且**不再恢复**：这条线程属于
   * WorkManager 的 executor pool，恢复标记会把中断泄漏给下一次 work。
   * 「已不再被 WorkManager 拥有」由返回值表达，不靠中断状态表达。
   *
   * 时间边界全部由 `CountDownLatch.await` 的真实时钟表达，不做本地时钟运算
   * （Robolectric 的 SystemClock 是被 shadow 的冻结假时钟，不能用于预算计算）。
   */
  private fun awaitRunnerTerminal(
    context: Context,
    deliveryEventId: String,
    completion: CountDownLatch,
    port: RavenCatCompanionExecutionPort,
    timeoutMs: Long,
    cancellationGraceMs: Long,
  ): RavenCatCompanionExecutionOutcome {
    val workerStopped = try {
      if (completion.await(timeoutMs, TimeUnit.MILLISECONDS)) {
        return RavenCatCompanionExecutionOutcome.COMPLETED
      }
      false
    } catch (_: InterruptedException) {
      true
    }
    // 取消事实先落到 native（拥有 execution identity 的层），再发事件：
    // 事件只能叫醒已经在跑的 runner，迟到注册的 runner 靠 consume 追平。
    RavenCatCompanionWakeStore.markExecutionCancellationRequested(context, deliveryEventId)
    Log.w(
      TAG,
      "companion_execution_cancel_requested deliveryEventId=$deliveryEventId " +
        "workerStopped=$workerStopped",
    )
    port.cancelExecution(context, deliveryEventId)
    val completedDuringGrace = try {
      completion.await(cancellationGraceMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      false
    }
    if (completedDuringGrace) return RavenCatCompanionExecutionOutcome.COMPLETED
    return if (workerStopped) {
      RavenCatCompanionExecutionOutcome.WORKER_STOPPED
    } else {
      RavenCatCompanionExecutionOutcome.TIMED_OUT
    }
  }

  /** JS runner 回执落盘后唤醒对应 delivery 的执行宿主；没有等待者时是普通 no-op。 */
  fun signalRunnerCompletion(deliveryEventId: String) {
    waitingForRunnerCompletion[deliveryEventId]?.countDown()
  }

  private const val TAG = "RavenCatCompanionWake"
}
