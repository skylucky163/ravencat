/** 处理正式 Android Headless AI 日程，并向原生执行宿主回写终态（每次 execution 仅一次）。 */

import {
  buildCompanionExecutionCancellationError,
  createCompanionExecutionCancellationRegistry,
} from './CompanionExecutionCancellation';
import {
  getCompanionRuntimeDependencies,
  type CompanionRuntimeDependencies,
} from './CompanionRuntimeDependencies';
import {
  runHeadlessAISchedule,
  type HeadlessAIScheduleData,
  type HeadlessAIScheduleOutcome,
} from './RunHeadlessAISchedule';

export type CompanionExecutionData = HeadlessAIScheduleData;

type HeadlessOutcome = HeadlessAIScheduleOutcome;

/**
 * 本 JS runtime 中正在执行的 delivery → AbortController。
 *
 * execution host 收口时（超时或 Worker 被停止）必须能显式取消 autonomous run，
 * 否则宿主释放执行保障后 JS 仍可能继续裸跑，重新违反
 * 「执行 owner 不得早于 Headless run 结束」的不变量。
 * 取消事实本身在 native，这里只是本 runtime 里的 controller 注册表。
 */
const activeExecutions = createCompanionExecutionCancellationRegistry();

export async function runCompanionWake(
  data: CompanionExecutionData,
  signal?: AbortSignal,
): Promise<void> {
  const dependencies = getCompanionRuntimeDependencies();
  const eventId = data.eventId?.trim() || buildFallbackEventId();
  // completion/delivery dedupe identity：AI Schedule 携带 `scheduleId@projectionToken`，
  // 避免 stale v1 callback 的 completion 毒死 update 后的 v2 callback。
  const deliveryEventId = data.deliveryEventId?.trim() || eventId;
  // 生命周期诊断只记录身份与阶段，不记录任何正文。
  console.info('[RavenCatCompanionWakeTask] headless_js_started', {
    eventId,
    deliveryEventId,
    source: data.source,
    triggerKind: data.triggerKind ?? null,
  });

  // 顺序即语义：先注册 controller，再消费 native 取消标记。
  //
  // register 之后的取消由 native 事件直接命中 controller；register 之前的取消由
  // native 标记在下面追平。反过来（先 consume 后 register）会漏掉
  // 「consume 返回 false → 取消到达（此时无人注册）→ register」这段夹缝，
  // 让一次已经发生的取消静默丢失。
  const controller = new AbortController();
  activeExecutions.register(deliveryEventId, controller);
  const abort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await catchUpCancellationRequestedBeforeRunnerRegistration(
      dependencies,
      deliveryEventId,
      controller,
    );
    const outcome = await runHeadlessAISchedule(data, controller.signal);
    const prefix = 'ai_schedule';
    const completionError = buildCompletionError(outcome, prefix);
    await dependencies.native.companion.recordRunnerCompletion({
      deliveryEventId,
      succeeded: true,
      error: completionError,
    });
    console.info('[RavenCatCompanionWakeTask] runner_completion_recorded', {
      deliveryEventId,
      succeeded: true,
      completionError,
    });
  } catch (error) {
    await dependencies.native.companion.recordRunnerCompletion({
      deliveryEventId,
      succeeded: false,
      error: error instanceof Error ? error.message : 'Headless JS 执行器发生未知错误。',
    });
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    activeExecutions.release(deliveryEventId);
  }
}

/**
 * 追平「取消发生在 runner 注册之前」：消费 native 取消标记，命中就 abort 本轮的 controller。
 *
 * 注意它是在注册**之后**执行的——那正是这条路径能覆盖夹缝的原因
 * （见 `runCompanionWake` 里的顺序说明）。
 *
 * 读不到标记时（native 调用失败）不得当作「没有被取消」继续跑 autonomous run——
 * 那样正是取消静默丢失。这里直接向上抛，让本次 execution 以失败回执收口，
 * SQLite 侧的 wake / schedule 仍按既有 claim / consume 语义保留。
 */
async function catchUpCancellationRequestedBeforeRunnerRegistration(
  dependencies: CompanionRuntimeDependencies,
  deliveryEventId: string,
  controller: AbortController,
): Promise<void> {
  let cancellationAlreadyRequested: boolean;
  try {
    cancellationAlreadyRequested =
      await dependencies.native.companion.consumeExecutionCancellation(deliveryEventId);
  } catch (error) {
    console.error('[RavenCatCompanionWakeTask] autonomous_agent_cancel_unresolved', {
      deliveryEventId,
      error,
    });
    throw error;
  }
  if (!cancellationAlreadyRequested) return;
  controller.abort(buildCompanionExecutionCancellationError(deliveryEventId));
  console.info('[RavenCatCompanionWakeTask] autonomous_agent_cancel_caught_up', {
    deliveryEventId,
  });
}

/**
 * execution host 收口时的取消入口：abort 当前 autonomous run，
 * 让 Agent Runtime 走既有 cancellation → terminal → consume → 终态回执链路。
 *
 * 返回值只表示「本 runtime 里是否有 runner 收到」；返回 false 不是取消丢失——
 * 取消事实已由 native 标记持有，runner 注册后会在初始化阶段追平。
 */
export function cancelCompanionWakeExecution(deliveryEventId: string): boolean {
  const delivered = activeExecutions.cancel(deliveryEventId);
  console.info('[RavenCatCompanionWakeTask] autonomous_agent_cancel_requested', {
    deliveryEventId,
    delivered,
  });
  return delivered;
}

function buildCompletionError(outcome: HeadlessOutcome, prefix: string): string | null {
  if (outcome.status === 'ignored') {
    return outcome.reason === 'claim_rejected'
      ? `${prefix}_claim:${outcome.claimStatus}`
      : `${prefix}_ignored:${outcome.reason}`;
  }
  return outcome.result.terminalCode === 'COMPLETED'
    ? null
    : `agent_terminal:${outcome.result.terminalCode}`;
}

function buildFallbackEventId(): string {
  return `ravencat_companion_headless_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
