/** 仅持久化 RavenCat 运行诊断；正式开启意图与调度只允许读取 SQLite。 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CompanionExecutionOutcome } from './CompanionNativePort';

export type ProactiveAgentRunStatus =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'message_sent'
  | 'failed';

export interface ProactiveAgentRunState {
  status: ProactiveAgentRunStatus;
  lastRunAt: string | null;
  lastCheckAt: string | null;
  lastWakeReason: string | null;
  lastDecisionReason: string | null;
  lastError: string | null;
  lastAIId: string | null;
  lastSessionId: string | null;
  lastMessageSentAt: string | null;
  serviceRunning: boolean;
  /** Overlay FGS：属于 Floating Interaction，不代表 Companion 运行状态。 */
  overlayForegroundServiceRunning: boolean;
  /** 应用总开关的持续后台保障，独立于日程是否正在执行。 */
  applicationBackgroundRunning: boolean;
  visibleLivenessIndicatorRunning: boolean;
  companionWakeScheduled: boolean;
  companionSchedulerActive: boolean;
  companionWakeTimerActive: boolean;
  bridgeConnected: boolean;
  lastNativeWakeAt: string | null;
  lastHeadlessStartAt: string | null;
  lastRunnerCompletionAt: string | null;
  lastRunnerCompletionSucceeded: boolean;
  lastRunnerCompletionError: string | null;
  lastCompanionExecutionAt: string | null;
  lastCompanionExecutionOutcome: CompanionExecutionOutcome | null;
  lastCompanionExecutionForegroundRunning: boolean;
  lastNativeNotificationAt: string | null;
  lastNativeNotificationShown: boolean;
  lastNativeNotificationAIId: string | null;
  lastNativeNotificationSessionId: string | null;
  lastNativeNotificationError: string | null;
  updatedAt: string;
}

export interface ProactiveNativeRuntimeSnapshot {
  floatingServiceRunning: boolean;
  overlayForegroundServiceRunning: boolean;
  applicationBackgroundRunning: boolean;
  visibleLivenessIndicatorRunning: boolean;
  companionWakeScheduled: boolean;
  companionSchedulerActive: boolean;
  companionWakeTimerActive: boolean;
  bridgeConnected: boolean;
  lastNativeWakeAtEpochMs: number;
  lastHeadlessTaskStartAtEpochMs: number;
  pendingNativeWakeCount: number;
  lastHeadlessTaskStartError?: string | null;
  lastRunnerCompletionAtEpochMs: number;
  lastRunnerCompletionSucceeded: boolean;
  lastRunnerCompletionError?: string | null;
  lastCompanionExecutionAtEpochMs: number;
  lastCompanionExecutionOutcome?: CompanionExecutionOutcome | null;
  lastCompanionExecutionForegroundRunning: boolean;
}

export interface ProactiveNativeNotificationSnapshot {
  lastNotificationAttemptAtEpochMs: number;
  lastNotificationShown: boolean;
  lastNotificationAIId?: string | null;
  lastNotificationSessionId?: string | null;
  lastNotificationError?: string | null;
}

const STORAGE_KEY = 'ravencat.proactiveAgent.runState.v1';

export async function getProactiveAgentRunState(): Promise<ProactiveAgentRunState> {
  const state = await readRunState();
  await persistRunState(state);
  return state;
}

export async function recordProactiveAgentRunState(
  updates: Partial<Omit<ProactiveAgentRunState, 'updatedAt'>>
): Promise<ProactiveAgentRunState> {
  const current = await readRunState();
  const now = new Date().toISOString();
  const nextState: ProactiveAgentRunState = {
    ...current,
    ...updates,
    lastRunAt: updates.lastRunAt === undefined ? current.lastRunAt : updates.lastRunAt,
    lastCheckAt: updates.lastCheckAt === undefined
      ? (updates.lastRunAt ? updates.lastRunAt : current.lastCheckAt)
      : updates.lastCheckAt,
    updatedAt: now,
  };
  await persistRunState(nextState);
  return nextState;
}

export async function reconcileProactiveNativeRuntimeState(params: {
  nativeHealth: ProactiveNativeRuntimeSnapshot;
  notification: ProactiveNativeNotificationSnapshot;
}): Promise<ProactiveAgentRunState> {
  return recordProactiveAgentRunState({
    serviceRunning: params.nativeHealth.floatingServiceRunning,
    overlayForegroundServiceRunning: params.nativeHealth.overlayForegroundServiceRunning,
    applicationBackgroundRunning:
      params.nativeHealth.applicationBackgroundRunning,
    visibleLivenessIndicatorRunning: params.nativeHealth.visibleLivenessIndicatorRunning,
    companionWakeScheduled: params.nativeHealth.companionWakeScheduled,
    companionSchedulerActive: params.nativeHealth.companionSchedulerActive,
    companionWakeTimerActive: params.nativeHealth.companionWakeTimerActive,
    bridgeConnected: params.nativeHealth.bridgeConnected,
    lastNativeWakeAt: formatEpochMsAsIso(params.nativeHealth.lastNativeWakeAtEpochMs),
    lastHeadlessStartAt: formatEpochMsAsIso(
      params.nativeHealth.lastHeadlessTaskStartAtEpochMs
    ),
    lastRunnerCompletionAt: formatEpochMsAsIso(
      params.nativeHealth.lastRunnerCompletionAtEpochMs
    ),
    lastRunnerCompletionSucceeded:
      params.nativeHealth.lastRunnerCompletionSucceeded,
    lastRunnerCompletionError: params.nativeHealth.lastRunnerCompletionError || null,
    lastCompanionExecutionAt: formatEpochMsAsIso(
      params.nativeHealth.lastCompanionExecutionAtEpochMs
    ),
    lastCompanionExecutionOutcome: params.nativeHealth.lastCompanionExecutionOutcome ?? null,
    lastCompanionExecutionForegroundRunning:
      params.nativeHealth.lastCompanionExecutionForegroundRunning === true,
    lastNativeNotificationAt: formatEpochMsAsIso(
      params.notification.lastNotificationAttemptAtEpochMs
    ),
    lastNativeNotificationShown: params.notification.lastNotificationShown,
    lastNativeNotificationAIId: params.notification.lastNotificationAIId || null,
    lastNativeNotificationSessionId:
      params.notification.lastNotificationSessionId || null,
    lastNativeNotificationError: params.notification.lastNotificationError || null,
  });
}

async function readRunState(): Promise<ProactiveAgentRunState> {
  const storedValue = await AsyncStorage.getItem(STORAGE_KEY);
  const storedState = parseStoredState(storedValue);
  const now = new Date().toISOString();

  return {
    status: normalizeStoredRunStatus(storedState?.status),
    lastRunAt: storedState?.lastRunAt || null,
    lastCheckAt: storedState?.lastCheckAt || storedState?.lastRunAt || null,
    lastWakeReason: storedState?.lastWakeReason || null,
    lastDecisionReason: storedState?.lastDecisionReason || null,
    lastError: storedState?.lastError || null,
    lastAIId: storedState?.lastAIId || null,
    lastSessionId: storedState?.lastSessionId || null,
    lastMessageSentAt: storedState?.lastMessageSentAt || null,
    serviceRunning: storedState?.serviceRunning === true,
    overlayForegroundServiceRunning:
      storedState?.overlayForegroundServiceRunning === true,
    applicationBackgroundRunning:
      storedState?.applicationBackgroundRunning === true,
    visibleLivenessIndicatorRunning:
      storedState?.visibleLivenessIndicatorRunning === true,
    companionWakeScheduled: storedState?.companionWakeScheduled === true,
    companionSchedulerActive: storedState?.companionSchedulerActive === true,
    companionWakeTimerActive: storedState?.companionWakeTimerActive === true,
    bridgeConnected: storedState?.bridgeConnected === true,
    lastNativeWakeAt: storedState?.lastNativeWakeAt || null,
    lastHeadlessStartAt: storedState?.lastHeadlessStartAt || null,
    lastRunnerCompletionAt: storedState?.lastRunnerCompletionAt || null,
    lastRunnerCompletionSucceeded: storedState?.lastRunnerCompletionSucceeded === true,
    lastRunnerCompletionError: storedState?.lastRunnerCompletionError || null,
    lastCompanionExecutionAt: storedState?.lastCompanionExecutionAt || null,
    lastCompanionExecutionOutcome: storedState?.lastCompanionExecutionOutcome ?? null,
    lastCompanionExecutionForegroundRunning:
      storedState?.lastCompanionExecutionForegroundRunning === true,
    lastNativeNotificationAt: storedState?.lastNativeNotificationAt || null,
    lastNativeNotificationShown: storedState?.lastNativeNotificationShown === true,
    lastNativeNotificationAIId: storedState?.lastNativeNotificationAIId || null,
    lastNativeNotificationSessionId: storedState?.lastNativeNotificationSessionId || null,
    lastNativeNotificationError: storedState?.lastNativeNotificationError || null,
    updatedAt: storedState?.updatedAt || now,
  };
}

function formatEpochMsAsIso(value: number): string | null {
  return value > 0 ? new Date(value).toISOString() : null;
}

function normalizeStoredRunStatus(status: string | undefined): ProactiveAgentRunStatus {
  if (status === 'contacted') {
    return 'message_sent';
  }
  const validStatuses = new Set<ProactiveAgentRunStatus>([
    'idle',
    'running',
    'blocked',
    'message_sent',
    'failed',
  ]);
  return status && validStatuses.has(status as ProactiveAgentRunStatus)
    ? status as ProactiveAgentRunStatus
    : 'idle';
}

function parseStoredState(value: string | null): Partial<ProactiveAgentRunState> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ProactiveAgentRunState>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function persistRunState(state: ProactiveAgentRunState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
