/**
 * @fileoverview ConversationTurnCoordinator —— 普通回复、重写与 AI 日程的会话执行权协调。
 *
 * 裁决"这个会话现在谁可以发起一轮回复"：
 * - activeHandles 只持有 run 句柄与 AbortController，不是事实来源；
 *   提交资格由持久化 fence（revision + active_run_id + 固定输入区间）在事务内判定；
 * - per-session single-flight 串行化同会话启动尝试；
 * - identity-safe cleanup：finally 只在 map 中 runId 仍等于自己时删除句柄；
 * - 两种 claim 模式：claimIfIdle（execution host / 就地执行，不抢 active run）、
 *   takeOverOrphan（仅 execution host 确认本进程无句柄且无终态覆盖后）；
 * - 启动恢复（recoverConversationTurns）只发现待恢复会话并启动 execution host，
 *   不在页面 runtime claim 或执行 run；多个恢复会话在 Headless 任务内串行完成；
 * - 纯内存仲裁：不建第二份待回复消息队列，不直接读写 SQL（只经 chat 的回合仓储端口）。
 *
 * 执行宿主契约（execution host）：
 * - 页面 React runtime 不得在后台继续持有的 fire-and-forget Promise 中独占执行生命周期；
 *   delegate_to_android_host 的 onCommitted（页面发送）只 abort 被 supersede 的旧句柄，
 *   然后提交共享应用 execution host，由执行用例
 *   executeTurnFromHost 完成 claim 并等待 run 到达 terminal；
 * - inline_current_host 只允许本身会等待回复终态的受控 execution host 使用
 *   （如 RavenCat 悬浮消息执行用例），允许就地 claim + 执行；
 * - replyCallbacks 只描述投影/交付观察，绝不参与 execution ownership 判定；
 * - 同一进程只有一个 JS runtime，activeHandles + single-flight 保证不双 claim；
 *   跨进程正确性由持久化 fence 兜底。
 */
import {
  executeUserReplyTurn,
  emitChatRegenerationChanged,
  emitChatTypingStatusChanged,
  emitChatMessagesReloadRequested,
  emitChatTurnExecutionChanged,
  interruptChatRunPresentation,
  recoverTurnPresentationDisplays,
  isChatReplyRunCancellationError,
  type CanonicalUserMessageCommittedPayload,
  type ConversationTurnRun,
  type ExecuteUserReplyTurnParams,
  type IConversationTurnRepository,
  type UserReplyTurnOutcome,
} from '@features/chat/composition';
import {
  conversationTurnRepository,
  sessionRepository,
} from '@features/chat/composition';
import { aiAssistantRepository } from '@features/assistants';
import { startConversationTurnExecutionHost } from '@platform/device';
import { logTurnTimeline } from '@shared/diagnostics/TurnTimelineLog';
import { loadStoredThemeId } from '@shared/theme/themeStorage';
import { getThemeById } from '@shared/theme/themeRegistry';
import { getChatInteractionProfile } from '@shared/theme/themeVariants';

/** 启动来源：发送流程 / 崩溃恢复 / 显式重试。 */
export type ConversationTurnLaunchOrigin = 'send_flow' | 'recovery' | 'explicit_retry';

/** claim 模式：不抢 active run / 事务内 supersede 崩溃孤儿。 */
export type ConversationTurnClaimMode = 'claimIfIdle' | 'takeOverOrphan';

type AIConfig = CanonicalUserMessageCommittedPayload['aiConfig'];
type ReplyCallbacks = CanonicalUserMessageCommittedPayload['replyCallbacks'];
type DeliveryTiming = CanonicalUserMessageCommittedPayload['deliveryTiming'];

/** 一轮 run 的执行上下文（由触发方透传给 run 执行）。 */
export interface ConversationTurnRunContext {
  signal?: AbortSignal;
  executionDeadlineAt?: number;
  aiConfig?: AIConfig;
  replyCallbacks?: ReplyCallbacks;
  deliveryTiming?: DeliveryTiming;
  correlationId?: string;
}

/**
 * execution host 触发端口：把「启动具备 Android 后台生命周期的执行宿主」
 * 抽象为依赖，便于脚本测试以内存 fake 验证页面侧不直接 claim。
 * 多个会话在同一个 Headless 任务内串行执行（recovery 批量场景并发有界为 1）。
 */
export interface ConversationTurnExecutionHostLauncher {
  start(
    sessionIds: string[],
    options: { correlationId?: string; deliveryTiming?: DeliveryTiming },
  ): Promise<boolean>;
}

/** execution host 任务侧执行结果。 */
export type ConversationTurnHostExecutionResult =
  /** 本 host 完成 claim 并等待 run 到达 terminal（含失败 revoke）。 */
  | 'executed'
  /** 本进程已有活句柄持有该会话的 run（重复投递/另一 host），本轮不重复执行。 */
  | 'already_active'
  /** 无待回复输入，或区间已被 failed/cancelled 终态覆盖（防隐式 retry）。 */
  | 'skipped';

/** 协调器依赖注入（便于脚本测试以内存 fake 验证内存协议）。 */
export interface ConversationTurnCoordinatorDeps {
  turns: IConversationTurnRepository;
  executeTurn: (params: ExecuteUserReplyTurnParams) => Promise<UserReplyTurnOutcome>;
  /** recovery / execution host 路径没有发送流程的配置负载，按会话解析助手配置；解析失败返回 null。 */
  resolveAIConfig: (sessionId: string) => Promise<AIConfig | null>;
  /** 页面发送后的 execution host 触发口；未注入时页面路径只记录错误，不在页面 runtime 兜底执行。 */
  executionHost?: ConversationTurnExecutionHostLauncher;
  /** 批间让出执行权；默认让出到宏任务队列尾部。 */
  yieldControl?: () => Promise<void>;
  /** recovery 扫描的 keyset 分页大小。 */
  recoveryBatchSize?: number;
}

export interface ConversationTurnCoordinator {
  /** 聊天优先；自主机会按计划时间取最新，不等待旧任务形成补跑队列。 */
  runAutonomousFromHost<T>(
    sessionId: string,
    runId: string,
    priority: AutonomousPriority,
    execute: (context: { signal: AbortSignal; displacedRunId?: string }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<AutonomousConversationResult<T>>;
  /**
   * 启动一轮回复：claim + 注册句柄 + fire-and-forget 执行。
   * 返回是否成功启动；已有活句柄或无待回复输入时返回 false。
   * 只等待启动，不等待模型/工具/提交完成。
   *
   * 只允许本身就是 execution host 的调用方使用（Headless 任务内就地执行）；
   * 页面 runtime 不得经此路径发起模型 run。
   */
  launchTurn(
    sessionId: string,
    origin: ConversationTurnLaunchOrigin,
    mode: ConversationTurnClaimMode,
    context?: ConversationTurnRunContext,
  ): Promise<boolean>;
  /**
   * canonical 用户消息事务 commit 后的通知：abort 被 supersede 的旧句柄；
   * inline_current_host 就地 claimIfIdle；delegate_to_android_host 启动
   * Android-backed execution host，页面 runtime 不 claim。
   */
  onCanonicalUserMessageCommitted(payload: CanonicalUserMessageCommittedPayload): Promise<void>;
  /**
   * 应用 execution host 入口：claim 并等待 run 到达 terminal 才返回。
   * claimIfIdle 落空时按孤儿语义接管（无终态覆盖才 takeOverOrphan）。
   */
  executeTurnFromHost(
    sessionId: string,
    context?: ConversationTurnRunContext,
  ): Promise<ConversationTurnHostExecutionResult>;
  /** runtime-recovery 阶段入口：只发现待恢复会话并启动 execution host，不在页面 runtime 执行 run。 */
  recoverConversationTurns(): Promise<void>;
  /** 当前进程内存注册表中是否存在该会话的活动 run 句柄（诊断/测试）。 */
  hasActiveHandle(sessionId: string): boolean;
  cancelActiveTurnsForReset(): Promise<void>;
  resumeTurnsAfterReset(): void;
  requestRegenerationFromHost(sessionId: string): Promise<boolean>;
  abortInvalidatedTurn(sessionId: string): Promise<void>;
}

interface AutonomousPriority { plannedAt: string; updatedAt: string; scheduleId: string }
type AutonomousConversationResult<T> = { status: 'ran'; value: T }
  | { status: 'chat_busy' } | { status: 'superseded'; scheduleId: string };

interface ActiveHandle {
  priority?: AutonomousPriority;
  kind: ConversationTurnRun['kind'];
  runId: string;
  abort: AbortController;
  completion: Promise<void>;
}

function defaultYieldControl(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createConversationTurnCoordinator(
  deps: ConversationTurnCoordinatorDeps,
): ConversationTurnCoordinator {
  const activeHandles = new Map<string, ActiveHandle>();
  let acceptingTurns = true;
  const sessionFlights = new Map<string, Promise<unknown>>();
  const autonomousControllers = new Map<string, AbortController>();
  const autonomousAdmissions = new Map<string, Promise<void>>();
  const yieldControl = deps.yieldControl ?? defaultYieldControl;
  const recoveryBatchSize = deps.recoveryBatchSize ?? 50;

  async function executeRun(
    sessionId: string,
    run: ConversationTurnRun,
    abort: AbortController,
    context: ConversationTurnRunContext,
  ): Promise<void> {
    let regenerationError: string | undefined;
    const revokeCancelled = (reason: string) => deps.turns.revoke(run,
      context.signal?.aborted ? 'failed' : 'cancelled', context.signal?.aborted ? String(context.signal.reason) : reason);
    try {
      if (context.signal?.aborted || (context.executionDeadlineAt !== undefined && performance.now() >= context.executionDeadlineAt)) {
        await deps.turns.revoke(run, 'failed', String(context.signal?.reason ?? 'execution_host_timeout'));
        return;
      }
      if (abort.signal.aborted) {
        await revokeCancelled('cancelled_before_execution');
        return;
      }
      const aiConfig = context.aiConfig ?? await deps.resolveAIConfig(sessionId);
      if (abort.signal.aborted) {
        await revokeCancelled('cancelled_during_preparation');
        return;
      }
      if (!aiConfig) {
        if (!abort.signal.aborted) regenerationError = '当前 AI 无法回复';
        await deps.turns.revoke(run, 'failed', 'assistant_unavailable');
        return;
      }
      emitChatTypingStatusChanged(sessionId, true, context.correlationId || run.runId);
      const execution = deps.executeTurn({
        executionDeadlineAt: context.executionDeadlineAt,
        run,
        aiConfig,
        signal: abort.signal,
        callbacks: context.replyCallbacks,
        deliveryTiming: context.deliveryTiming,
        correlationId: context.correlationId,
      });
      const outcome = context.signal ? await new Promise<UserReplyTurnOutcome>((resolve, reject) => {
        const signal = context.signal!;
        const stopped = () => {
          signal.removeEventListener('abort', stopped);
          reject(new Error(String(signal.reason)));
        };
        signal.addEventListener('abort', stopped, { once: true });
        // 迟到的执行仍有完成／拒绝消费者；事实资格由下面的 T4 和原 T3 fence 收口。
        execution.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopped));
        if (signal.aborted) stopped();
      }) : await execution;
      if (outcome === 'committed') {
        logTurnTimeline('assistant_turn_committed', {
          sessionId,
          runId: run.runId,
          correlationId: context.correlationId,
        });
      }
      // run 仍 active 但无任何提交：revoke 收尾，不得留 active 悬挂。
      if (outcome === 'empty_reply') {
        if (!abort.signal.aborted) regenerationError = '未生成新回复，已恢复原消息';
        if (abort.signal.aborted) await revokeCancelled('empty_reply');
        else await deps.turns.revoke(run, 'failed', 'empty_reply');
      }
      // fence_failed：本 run 已失去所有权，安静结束（用户消息事务已触发新一轮 claim）。
    } catch (error) {
      if (context.signal?.aborted || (context.executionDeadlineAt !== undefined && performance.now() >= context.executionDeadlineAt)) {
        const reason = String(context.signal?.reason ?? 'execution_host_timeout');
        try { await interruptChatRunPresentation(run.runId, reason); }
        finally { await deps.turns.revoke(run, 'failed', reason); }
      } else if (!isChatReplyRunCancellationError(error)) {
        if (!abort.signal.aborted) regenerationError = reasonOf(error);
        try {
          await deps.turns.revoke(run, 'failed', reasonOf(error));
        } catch (revokeError) {
          console.warn('[ConversationTurnCoordinator] 失败 run revoke 失败：', {
            sessionId,
            runId: run.runId,
            error: reasonOf(revokeError),
          });
        }
      }
    } finally {
      // T4 的持久终态提交后再刷新展示，不能以执行函数的 finally 代替事务完成。
      emitChatMessagesReloadRequested(sessionId);
      emitChatTypingStatusChanged(sessionId, false, context.correlationId || run.runId);
      if (run.kind === 'regenerate') emitChatRegenerationChanged(sessionId, regenerationError);
      // identity-safe cleanup：禁止旧 run 删除新 run 的句柄。
      const current = activeHandles.get(sessionId);
      if (current?.runId === run.runId) {
        activeHandles.delete(sessionId);
      }
      emitChatTurnExecutionChanged(sessionId);
    }
  }

  function executeClaimedRun(
    sessionId: string,
    run: ConversationTurnRun,
    context: ConversationTurnRunContext,
  ): Promise<void> {
    const abort = new AbortController();
    const onHostStopped = () => abort.abort(context.signal!.reason);
    context.signal?.addEventListener('abort', onHostStopped, { once: true });
    if (context.signal?.aborted) onHostStopped();
    if (!acceptingTurns) abort.abort('CANCELLED_BY_USER');
    const completion = Promise.resolve().then(() => executeRun(sessionId, run, abort, context))
      .finally(() => context.signal?.removeEventListener('abort', onHostStopped));
    activeHandles.set(sessionId, { runId: run.runId, kind: run.kind, abort, completion });
    emitChatTurnExecutionChanged(sessionId);
    logTurnTimeline('turn_claimed', { sessionId, runId: run.runId });
    return completion;
  }

  async function tryLaunch(
    sessionId: string,
    mode: ConversationTurnClaimMode,
    context: ConversationTurnRunContext,
  ): Promise<boolean> {
    if (!acceptingTurns || activeHandles.has(sessionId)) {
      return false;
    }
    const run = mode === 'claimIfIdle'
      ? await deps.turns.claimIfIdle(sessionId, 'user_reply')
      : await deps.turns.takeOverOrphan(sessionId, 'user_reply');
    if (!run) {
      return false;
    }
    // 启动与完成分离：此处不 await，执行由 finally 自清。
    void executeClaimedRun(sessionId, run, context);
    return true;
  }

  /**
   * execution host 任务侧：claim 并等待 terminal。
   * claimIfIdle 落空时区分「无待回复输入」与「持久化 active 孤儿」；
   * 孤儿仅在无 failed/cancelled 终态覆盖时接管，防任务重投造成隐式 retry。
   */
  async function tryExecuteFromHost(
    sessionId: string,
    context: ConversationTurnRunContext,
  ): Promise<ConversationTurnHostExecutionResult> {
    if (!acceptingTurns) return 'skipped';
    if (activeHandles.has(sessionId)) {
      return 'already_active';
    }
    let run = await deps.turns.claimIfIdle(sessionId, 'user_reply');
    if (!run) {
      const snapshot = await deps.turns.getSessionTurnSnapshot(sessionId);
      if (!snapshot || (!snapshot.hasRegeneration && snapshot.highWatermark <= snapshot.replyCursor)) {
        return 'skipped';
      }
      if (!snapshot.hasRegeneration && await deps.turns.findTerminalRunCovering(sessionId, snapshot.highWatermark)) {
        return 'skipped';
      }
      run = await deps.turns.takeOverOrphan(sessionId, 'user_reply');
      if (!run) {
        if (snapshot.hasRegeneration) emitChatRegenerationChanged(sessionId);
        return 'skipped';
      }
    }
    // execution host 必须活到 run terminal：此处等待执行完整结束。
    await executeClaimedRun(sessionId, run, context);
    return 'executed';
  }

  async function launch(
    sessionId: string,
    mode: ConversationTurnClaimMode,
    context: ConversationTurnRunContext,
  ): Promise<boolean> {
    // per-session single-flight：同会话启动尝试串行，防止并发通过 has() 检查后重复 claim。
    const previous = sessionFlights.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => tryLaunch(sessionId, mode, context));
    sessionFlights.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (sessionFlights.get(sessionId) === next) {
        sessionFlights.delete(sessionId);
      }
    }
  }

  return {
    async runAutonomousFromHost<T>(sessionId: string, runId: string, priority: AutonomousPriority,
      execute: (context: { signal: AbortSignal; displacedRunId?: string }) => Promise<T>,
      sourceSignal?: AbortSignal): Promise<AutonomousConversationResult<T>> {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(sourceSignal!.reason);
      sourceSignal?.addEventListener('abort', forwardAbort, { once: true });
      if (sourceSignal?.aborted) forwardAbort();
      autonomousControllers.set(runId, controller);
      const assertActive = () => {
        if (!acceptingTurns || controller.signal.aborted) throw new Error('Autonomous execution aborted');
      };
      try {
        // 这里只串行化短小的 owner 交接，不等待模型、工具或分段交付。
        for (;;) {
          assertActive();
          const pending = autonomousAdmissions.get(sessionId);
          if (!pending) break;
          await pending;
        }
        assertActive();
        const active = activeHandles.get(sessionId);
        if (sessionFlights.has(sessionId) || (active && active.kind !== 'autonomous')) return { status: 'chat_busy' };
        if (active) {
          const previous = active.priority!;
          const byTime = Date.parse(priority.plannedAt) - Date.parse(previous.plannedAt);
          const byVersion = priority.updatedAt.localeCompare(previous.updatedAt);
          if (byTime < 0 || (byTime === 0 && (byVersion < 0 || (byVersion === 0 && priority.scheduleId <= previous.scheduleId)))) {
            return { status: 'superseded', scheduleId: previous.scheduleId };
          }
        }
        const admission = Promise.resolve().then(async () => {
          assertActive();
          let displacedRunId: string | undefined;
          const previous = await deps.turns.getActiveRun(sessionId);
          if (previous?.kind === 'autonomous') {
            // 先撤销持久 fence，再发协作式取消；旧网络返回不能取得新回合提交资格。
            await deps.turns.revoke(previous, 'cancelled', 'newer_schedule');
            const oldHandle = activeHandles.get(sessionId);
            if (oldHandle?.runId === previous.runId) {
              oldHandle.abort.abort('newer_schedule');
              await interruptChatRunPresentation(previous.runId, 'newer_schedule');
              if (activeHandles.get(sessionId) === oldHandle) activeHandles.delete(sessionId);
            }
            displacedRunId = previous.runId;
          }
          if (active?.kind === 'autonomous' && activeHandles.get(sessionId) === active) {
            active.abort.abort('newer_schedule');
            await interruptChatRunPresentation(active.runId, 'newer_schedule');
            if (activeHandles.get(sessionId) === active) activeHandles.delete(sessionId);
            displacedRunId = active.runId;
          }
          await recoverTurnPresentationDisplays([...activeHandles.values()].map(handle => handle.runId));
          assertActive();
          const run = await deps.turns.claimAutonomousIfIdle(sessionId, runId);
          if (!run) return null;
          const completion = Promise.resolve().then(async () => {
            try {
              assertActive();
              const value = await execute({ signal: controller.signal, displacedRunId });
              if (controller.signal.aborted) await deps.turns.revoke(run, 'cancelled', 'autonomous_cancelled');
              else await deps.turns.finishAutonomous(run);
              return value;
            } catch (error) {
              await deps.turns.revoke(run, controller.signal.aborted ? 'cancelled' : 'failed', reasonOf(error));
              throw error;
            } finally {
              if (activeHandles.get(sessionId)?.runId === runId) activeHandles.delete(sessionId);
              emitChatTurnExecutionChanged(sessionId);
            }
          });
          activeHandles.set(sessionId, { runId, kind: 'autonomous', priority, abort: controller,
            completion: completion.then(() => undefined, () => undefined) });
          emitChatTurnExecutionChanged(sessionId);
          return { completion };
        });
        const settledAdmission = admission.then(() => undefined, () => undefined);
        autonomousAdmissions.set(sessionId, settledAdmission);
        sessionFlights.set(sessionId, admission);
        let admitted;
        try { admitted = await admission; }
        finally {
          if (autonomousAdmissions.get(sessionId) === settledAdmission) autonomousAdmissions.delete(sessionId);
          if (sessionFlights.get(sessionId) === admission) sessionFlights.delete(sessionId);
        }
        return admitted ? { status: 'ran', value: await admitted.completion } : { status: 'chat_busy' };
      } finally {
        sourceSignal?.removeEventListener('abort', forwardAbort);
        autonomousControllers.delete(runId);
      }
    },

    launchTurn(sessionId, _origin, mode, context = {}) {
      return launch(sessionId, mode, context);
    },

    async onCanonicalUserMessageCommitted(payload) {
      if (!acceptingTurns) return;
      const { sessionId, supersededRunId } = payload;
      if (supersededRunId) {
        const handle = activeHandles.get(sessionId);
        if (handle?.runId === supersededRunId) {
          // 协作式省 token；正确性由 T1 事务的 supersede 保证。
          handle.abort.abort();
          // 先移除句柄，再允许新 claim。
          activeHandles.delete(sessionId);
        }
      }
      if (payload.executionMode === 'inline_current_host') {
        // 只有显式声明、且会等待回复终态的受控 execution host 才能就地 claim + 执行。
        await launch(sessionId, 'claimIfIdle', {
          signal: payload.signal,
          executionDeadlineAt: payload.executionDeadlineAt,
          aiConfig: payload.aiConfig,
          replyCallbacks: payload.replyCallbacks,
          deliveryTiming: payload.deliveryTiming,
          correlationId: payload.correlationId,
        });
        return;
      }
      // 默认委派：replyCallbacks 即使存在也不能把执行所有权交给页面 runtime。
      if (!deps.executionHost) {
        console.error('[ConversationTurnCoordinator] 缺少 execution host 触发口，无法委派后台执行：', {
          sessionId,
        });
        return;
      }
      const accepted = await deps.executionHost.start([sessionId], {
        correlationId: payload.correlationId,
        deliveryTiming: payload.deliveryTiming,
      });
      if (!accepted) {
        logTurnTimeline('execution_host_start_failed', { sessionId, correlationId: payload.correlationId });
        // 不兜底在页面执行：待回复事实留在游标/高水位中，由启动恢复或后续触发按 orphan 语义接管。
        console.warn('[ConversationTurnCoordinator] execution host 启动被拒绝：', {
          sessionId,
          correlationId: payload.correlationId ?? null,
        });
      }
    },

    async executeTurnFromHost(sessionId, context = {}) {
      // 与 launch 共用 per-session single-flight：host 任务与就地执行串行，杜绝双 claim。
      const previous = sessionFlights.get(sessionId) ?? Promise.resolve();
      const next = previous.then(() => tryExecuteFromHost(sessionId, context));
      sessionFlights.set(sessionId, next);
      try {
        return await next;
      } finally {
        if (sessionFlights.get(sessionId) === next) {
          sessionFlights.delete(sessionId);
        }
      }
    },

    async recoverConversationTurns() {
      if (!acceptingTurns) return;
      const interrupted = await deps.turns.interruptAbandonedAutonomousRuns([...autonomousControllers.keys()]);
      for (const sessionId of interrupted) emitChatTurnExecutionChanged(sessionId);
      // 页面 runtime 只负责发现待恢复会话；claim/执行全部委派 execution host，
      // 多个会话在 Headless 任务内串行完成（模型请求并发有界为 1）。
      if (!deps.executionHost) {
        console.error('[ConversationTurnCoordinator] 缺少 execution host 触发口，无法委派 recovery 执行。');
        return;
      }
      const pendingSessionIds: string[] = [];
      let afterSessionId = '';
      for (;;) {
        const batch = await deps.turns.listSessionsWithUnrepliedInput(afterSessionId, recoveryBatchSize);
        if (batch.length === 0) {
          break;
        }
        for (const session of batch) {
          // 唯一合法跳过判据：本进程内存注册表存在活句柄（持久化 active run 通常是崩溃孤儿）。
          if (activeHandles.has(session.sessionId)) {
            continue;
          }
          if (!session.hasRegeneration && session.highWatermark <= session.replyCursor) {
            continue;
          }
          // 防隐式 retry：failed/cancelled 覆盖的区间不被 recovery 自动重新 claim。
          if (!session.hasRegeneration && await deps.turns.findTerminalRunCovering(session.sessionId, session.highWatermark)) {
            continue;
          }
          pendingSessionIds.push(session.sessionId);
        }
        afterSessionId = batch[batch.length - 1].sessionId;
        await yieldControl();
      }
      if (pendingSessionIds.length === 0) {
        return;
      }
      const accepted = await deps.executionHost.start(pendingSessionIds, {});
      if (!accepted) {
        // 不兜底在页面执行：待回复事实留在游标/高水位中，下次启动恢复自然拾取。
        console.warn('[ConversationTurnCoordinator] recovery execution host 启动被拒绝：', {
          sessionCount: pendingSessionIds.length,
        });
      }
    },

    async requestRegenerationFromHost(sessionId) {
      if (!acceptingTurns) return false;
      if (!deps.executionHost) throw new Error('聊天执行宿主尚未装配');
      return deps.executionHost.start([sessionId], {});
    },

    async abortInvalidatedTurn(sessionId) {
      const handle = activeHandles.get(sessionId);
      if (!handle) return;
      const active = await deps.turns.getActiveRun(sessionId);
      // 取消通知可能晚于新 owner 的 claim；只清理已经失去持久所有权的原句柄。
      if (active?.runId === handle.runId || activeHandles.get(sessionId) !== handle) return;
      handle.abort.abort();
      activeHandles.delete(sessionId);
      emitChatTypingStatusChanged(sessionId, false, handle.runId);
    },

    hasActiveHandle(sessionId) {
      return activeHandles.has(sessionId);
    },

    async cancelActiveTurnsForReset() {
      acceptingTurns = false;
      for (const controller of autonomousControllers.values()) controller.abort('CANCELLED_BY_USER');
      const handles = [...activeHandles.values()];
      for (const handle of handles) handle.abort.abort('CANCELLED_BY_USER');
      // claim 中的 flight 也要排空：它返回后登记的句柄会立即取消，不进入模型准备。
      const results = await Promise.allSettled([...sessionFlights.values(), ...handles.map((handle) => handle.completion)]);
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, '恢复出厂回合关闭失败');
    },

    resumeTurnsAfterReset() {
      acceptingTurns = true;
    },
  };
}

/** 宿主独立装配配置；普通页面委派后，不能依赖页面内的主题参数覆盖。 */
async function resolveSessionAIConfig(sessionId: string): Promise<AIConfig | null> {
  const session = await sessionRepository.getSession(sessionId);
  if (!session) {
    return null;
  }
  const assistant = await aiAssistantRepository.getById(session.aiAssistantId);
  if (!assistant) {
    return null;
  }
  const interactionProfile = getChatInteractionProfile(getThemeById(await loadStoredThemeId()));
  return {
    id: assistant.id,
    agentId: assistant.agentId,
    name: assistant.name,
    avatar: assistant.avatar,
    model: assistant.model,
    apiKey: assistant.apiKey || '',
    apiBaseUrl: assistant.apiBaseUrl || '',
    systemPrompt: assistant.systemPrompt || undefined,
    temperature: assistant.temperature,
    topP: assistant.topP,
    disableThinking: assistant.disableThinking,
    maxTokens: assistant.maxTokens,
    privateContextPrimaryLimit: assistant.privateContextPrimaryLimit,
    privateContextSecondaryLimit: assistant.privateContextSecondaryLimit,
    groupContextPrimaryLimit: assistant.groupContextPrimaryLimit,
    groupContextSecondaryLimit: assistant.groupContextSecondaryLimit,
    enableTools: assistant.enableTools,
    allowMultipleBubbles: interactionProfile.enableAssistantMessageSegmentation
      ? assistant.allowMultipleBubbles : false,
    enableStreamingReply: assistant.streamingReply ?? interactionProfile.preferStreamingReply,
    isHostAI: assistant.isHostAI,
    isBlocked: assistant.isBlocked,
  };
}

let sharedCoordinator: ConversationTurnCoordinator | null = null;

/** Host 装配共享实例（configureChatRuntime、execution host 任务与启动恢复共用同一份内存注册表）。 */
export function getConversationTurnCoordinator(): ConversationTurnCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = createConversationTurnCoordinator({
      turns: conversationTurnRepository,
      executeTurn: (params) => executeUserReplyTurn(params),
      resolveAIConfig: resolveSessionAIConfig,
      executionHost: {
        async start(sessionIds, options) {
          const attempts = await conversationTurnRepository.beginExecutionHostRequests(sessionIds);
          for (const sessionId of sessionIds) emitChatTurnExecutionChanged(sessionId);
          let accepted = false;
          try {
            accepted = await startConversationTurnExecutionHost(sessionIds, options);
            return accepted;
          } finally {
            await conversationTurnRepository.finishExecutionHostRequests(attempts, accepted);
            for (const sessionId of sessionIds) emitChatTurnExecutionChanged(sessionId);
          }
        },
      },
    });
  }
  return sharedCoordinator;
}
