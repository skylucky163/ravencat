/** 向界面暴露本地伴随设置与启停事实，隐藏具体仓储实现。 */

import type { AIAssistantSummary } from '@features/assistants';
import {
  extractUserProtectedPackages,
} from '@features/phoneTools';
import type {
  CompanionSettings,
  UpdateCompanionSettingsInput,
} from '../domain/CompanionSettings';
import type { CompanionState } from '../domain/CompanionState';
import type { CompanionErrorCode } from './CompanionError';
import { getCompanionRuntimeDependencies } from './CompanionRuntimeDependencies';
import {
  activateCompanionScheduling,
  disableCompanionScheduling,
  reconcileAIScheduleProjections,
} from './AIScheduleProjectionOwner';

export interface CompanionProductState {
  settings: CompanionSettings;
  state: CompanionState;
  hostAI: AIAssistantSummary | null;
}

export async function loadCompanionProductState(): Promise<CompanionProductState> {
  const dependencies = getCompanionRuntimeDependencies();
  const repositories = dependencies.repositories;
  const [settings, persistedState, hostAI] = await Promise.all([
    repositories.companionSettings.ensureDefault(),
    repositories.companionState.ensureDefault(),
    repositories.assistants.getHostSummary(),
  ]);
  let state = persistedState;
  if (persistedState.activationStatus === 'disabling') {
    const outcome = await disableCompanionScheduling({
      clearHostAI: persistedState.hostAIId === null,
      failureCode: persistedState.lastFailureCode,
    });
    state = outcome;
  }
  if (state.hostAIId && hostAI?.id !== state.hostAIId) {
    state = await disableCompanionProductState({
      failureCode: 'host_ai_missing',
      clearHostAI: true,
      expectedHostAIId: state.hostAIId,
    });
  }
  return { settings, state, hostAI };
}

export async function updateCompanionProductSettings(
  updates: UpdateCompanionSettingsInput,
): Promise<CompanionSettings> {
  const settings = await getCompanionRuntimeDependencies().repositories.companionSettings.update(
    updates.userScreenCaptureBlacklist === undefined
      ? updates
      : {
          ...updates,
          userScreenCaptureBlacklist: extractUserProtectedPackages(
            updates.userScreenCaptureBlacklist,
          ),
        },
  );
  if (updates.followUpEnabled !== undefined || updates.followUpIntervalMinutes !== undefined) {
    await reconcileAIScheduleProjections();
  }
  return settings;
}

export async function loadCompanionUserScreenCaptureBlacklist(): Promise<string[]> {
  const settings = await getCompanionRuntimeDependencies()
    .repositories.companionSettings.ensureDefault();
  return extractUserProtectedPackages(
    settings.userScreenCaptureBlacklist,
  );
}

export async function updateCompanionUserScreenCaptureBlacklist(
  packageNames: string[],
): Promise<string[]> {
  const settings = await updateCompanionProductSettings({
    userScreenCaptureBlacklist: packageNames,
  });
  return settings.userScreenCaptureBlacklist.slice();
}

/** 开启只提交用户意图。 */
export async function activateCompanionProductState(
  hostAIId: string,
): Promise<CompanionState> {
  return activateCompanionScheduling(hostAIId);
}

export interface DisableCompanionInput {
  failureCode?: CompanionErrorCode | null;
  clearHostAI?: boolean;
  expectedHostAIId?: string;
}

/** 关闭时暂停日程投影，保留计划和历史；开启后不补跑错过的机会。 */
export async function disableCompanionProductState(
  input: DisableCompanionInput = {},
): Promise<CompanionState> {
  const outcome = await disableCompanionScheduling({
    expectedOwnerAIId: input.expectedHostAIId,
    clearHostAI: input.clearHostAI ?? false,
    failureCode: input.failureCode ?? null,
  });
  return outcome;
}
