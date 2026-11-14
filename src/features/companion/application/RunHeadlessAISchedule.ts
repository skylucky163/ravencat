/** 正式 Headless AI Schedule：以 SQLite due-time CAS claim 为幂等边界执行一次 autonomous run。 */

import type { AgentRunResult } from '@platform/agentRuntime';
import { runAsCurrentHostAuthority } from '@features/assistants';
import type {
  AISchedule,
  AIScheduleCompletionDisposition,
} from '../domain/AISchedule';
import type { AIScheduleApplicationErrorCode } from './AIScheduleApplication';
import {
  claimAIScheduleForHeadless,
  consumeAIScheduleWithProjection,
  reconcileAIScheduleProjections,
} from './AIScheduleProjectionOwner';
import { summarizeAutonomousAgentRun } from './AutonomousRunDiagnostic';
import {
  claimAndTrackAIScheduleRun,
  completeTrackedAIScheduleRun,
} from './AIScheduleRecovery';
import { getCompanionRuntimeDependencies } from './CompanionRuntimeDependencies';
import { runAIScheduleAutonomousAgent } from './RunAIScheduleAutonomousAgent';

export interface HeadlessAIScheduleData {
  triggerKind?: string | null;
  source?: string;
  eventId?: string;
  hostAIId?: string | null;
  expectedRemindAtEpochMs?: number | null;
  projectionToken?: string | null;
  createdAtEpochMs?: number;
  deliveryEventId?: string | null;
}

export type HeadlessAIScheduleOutcome =
  | { status: 'ran'; result: AgentRunResult }
  | { status: 'ignored'; reason: 'not_current_host' }
  | { status: 'ignored'; reason: 'expired_or_merged' | 'merged_chat' | 'merged_schedule' }
  | {
      status: 'ignored';
      reason: 'claim_rejected';
      claimStatus: AIScheduleApplicationErrorCode;
    };

export async function runHeadlessAISchedule(
  data: HeadlessAIScheduleData,
  signal?: AbortSignal,
): Promise<HeadlessAIScheduleOutcome> {
  const dependencies = getCompanionRuntimeDependencies();
  const callback = parseFormalAIScheduleCallback(data);
  await dependencies.initializeDatabase();
  const authority = await runAsCurrentHostAuthority(callback.hostAIId, async () => {
    const selected = await dependencies.repositories.aiSchedules.prepareDispatch({
      scheduleId: callback.scheduleId, ownerAIId: callback.hostAIId, expectedRemindAt: callback.expectedRemindAt,
      projectionToken: callback.projectionToken, occurredAt: new Date().toISOString(),
    });
    if (!selected) return null;
    const session = await dependencies.chat.resolveCanonicalConversation({ aiId: callback.hostAIId });
    return { selected, sessionId: session.id };
  });

  if (authority.status !== 'not_current_host') await reconcileAIScheduleProjections();
  if (authority.status === 'not_current_host') {
    console.info('[RavenCatAIScheduleTask] AI Schedule callback 已过期', {
      scheduleId: callback.scheduleId,
      reason: authority.status,
    });
    return { status: 'ignored', reason: authority.status };
  }

  if (!authority.value) return { status: 'ignored', reason: 'expired_or_merged' };
  const { sessionId, selected } = authority.value;
  const runId = dependencies.generateAutonomousRunId();
  const admission = await dependencies.chat.runInConversation<HeadlessAIScheduleOutcome>(sessionId, runId,
    { plannedAt: selected.remindAt, updatedAt: selected.updatedAt, scheduleId: selected.scheduleId,
      triggerKind: selected.triggerKind }, async execution => {
    if (execution.displacedRunId) {
      const [evidence] = await dependencies.chat.listAgentActivityEvidence([execution.displacedRunId]);
      await dependencies.repositories.aiSchedules.mergeClaimedRun(
        execution.displacedRunId, selected.scheduleId, new Date().toISOString(), evidence?.firstVisibleAt ?? null);
    }
    // owner 交接期间主理身份或开关可能改变；真正开始时才 claim。
    const currentAuthority = await runAsCurrentHostAuthority(callback.hostAIId, () =>
      claimAndTrackAIScheduleRun(runId, () => claimAIScheduleForHeadless({
        scheduleId: selected.scheduleId, ownerAIId: callback.hostAIId, runId,
        claimedAt: new Date().toISOString(), expectedRemindAt: selected.remindAt,
        conversationId: sessionId,
        projectionToken: selected.updatedAt,
      })));
    if (currentAuthority.status === 'not_current_host') return { status: 'ignored', reason: 'not_current_host' };
    const claim = currentAuthority.value;
    if (claim.status !== 'claimed') {
      console.info('[RavenCatAIScheduleTask] AI Schedule callback 未取得执行权', {
        scheduleId: callback.scheduleId, claimStatus: claim.code,
      });
      return { status: 'ignored', reason: 'claim_rejected', claimStatus: claim.code };
    }
    const result = await runClaimedAISchedule({
      runId, sessionId,
      claimedSchedule: claim.schedule, triggeredAt: callback.triggeredAt, signal: execution.signal,
    });
    return { status: 'ran', result };
  }, signal).catch(async error => {
    await dependencies.repositories.aiSchedules.mergeScheduled(selected.scheduleId, null, new Date().toISOString(),
      signal?.aborted ? 'execution_interrupted' : 'dispatch_failed');
    await reconcileAIScheduleProjections();
    throw error;
  });
  if (admission.status !== 'ran') {
    await dependencies.repositories.aiSchedules.mergeScheduled(selected.scheduleId,
      admission.status === 'superseded' ? admission.scheduleId : null, new Date().toISOString());
    await reconcileAIScheduleProjections();
    return { status: 'ignored', reason: admission.status === 'superseded' ? 'merged_schedule' : 'merged_chat' };
  }
  return admission.value;
}

async function runClaimedAISchedule(input: {
  runId: string;
  sessionId: string;
  claimedSchedule: AISchedule;
  triggeredAt: string;
  signal?: AbortSignal;
}): Promise<AgentRunResult> {
  let primaryError: unknown;
  let result: AgentRunResult | undefined;
  let completionDisposition: AIScheduleCompletionDisposition = 'interrupted';
  try {
    if (input.claimedSchedule.claimedByRunId !== input.runId) {
      throw new Error('AI Schedule claim 返回的 claimedByRunId 与 autonomous runId 不一致');
    }
    result = await runAIScheduleAutonomousAgent(input);
    completionDisposition = 'agent_terminal';
    logAutonomousRunTerminal({
      scheduleId: input.claimedSchedule.scheduleId,
      runId: input.runId,
      result,
    });
  } catch (error) {
    primaryError = error;
  }

  try {
    await completeTrackedAIScheduleRun(
      input.runId,
      completionDisposition,
      async () => {
        const [evidence] = await getCompanionRuntimeDependencies().chat.listAgentActivityEvidence([input.runId]);
        const outcome = await consumeAIScheduleWithProjection({
          scheduleId: input.claimedSchedule.scheduleId,
          runId: input.runId,
          consumedAt: new Date().toISOString(),
          completionDisposition,
          firstVisibleAt: evidence?.firstVisibleAt ?? null,
          failureCode: result && result.terminalCode !== 'COMPLETED' ? result.terminalCode
            : result?.steps.some(step => step.toolCalls.some(call => call.outcome.status === 'error')) ? 'tool_failed' : undefined,
        });
        if (outcome.status !== 'consumed' && outcome.code !== 'already_terminal') {
          throw new Error(
            `Claimed AI Schedule ${input.claimedSchedule.scheduleId} consume 失败：${outcome.code}`,
          );
        }
        return outcome;
      },
    );
  } catch (consumeError) {
    if (primaryError) {
      console.error('[RavenCatAIScheduleTask] autonomous run 与 consume 均失败', {
        scheduleId: input.claimedSchedule.scheduleId,
        runId: input.runId,
        consumeError,
      });
      throw primaryError;
    }
    throw consumeError;
  }

  if (primaryError) throw primaryError;
  return result!;
}

/** 诊断日志是纯 observer；摘要失败只降级为 error log，不改变 terminal result。 */
function logAutonomousRunTerminal(input: {
  scheduleId: string;
  runId: string;
  result: AgentRunResult;
}): void {
  try {
    console.info('[RavenCatAIScheduleTask] autonomous Agent run 已到达终态', {
      scheduleId: input.scheduleId,
      runId: input.runId,
      ...summarizeAutonomousAgentRun(input.result),
    });
  } catch (error) {
    console.error('[RavenCatAIScheduleTask] autonomous Agent run 诊断摘要不可用', {
      scheduleId: input.scheduleId,
      runId: input.runId,
      error,
    });
  }
}

function parseFormalAIScheduleCallback(data: HeadlessAIScheduleData): {
  scheduleId: string;
  hostAIId: string;
  expectedRemindAt: string;
  projectionToken: string;
  triggeredAt: string;
} {
  if (data.triggerKind !== 'ai_schedule' || data.source !== 'work-manager') {
    throw new Error(`正式 AI Schedule callback 类型非法：${data.triggerKind}/${data.source}`);
  }
  const scheduleId = data.eventId?.trim();
  if (!scheduleId) throw new Error('正式 AI Schedule callback 缺少 scheduleId');
  const hostAIId = data.hostAIId?.trim();
  if (!hostAIId) throw new Error('正式 AI Schedule callback 缺少 hostAIId');
  if (!Number.isFinite(data.expectedRemindAtEpochMs) || data.expectedRemindAtEpochMs! <= 0) {
    throw new Error('正式 AI Schedule callback 缺少有效 expectedRemindAtEpochMs');
  }
  const projectionToken = data.projectionToken?.trim();
  if (!projectionToken) throw new Error('正式 AI Schedule callback 缺少 projectionToken');
  if (!Number.isFinite(data.createdAtEpochMs) || data.createdAtEpochMs! <= 0) {
    throw new Error('正式 AI Schedule callback 缺少有效 triggeredAt');
  }
  return {
    scheduleId,
    hostAIId,
    expectedRemindAt: new Date(data.expectedRemindAtEpochMs!).toISOString(),
    projectionToken,
    triggeredAt: new Date(data.createdAtEpochMs!).toISOString(),
  };
}
