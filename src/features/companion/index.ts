/** Companion 功能公共 API；只暴露当前跨 Feature 与路由入口所需能力。 */
export { loadAIScheduleContext } from './application/AIScheduleContext';

export {
  clearCompanionNativeDataForFactoryReset,
  getNativeHealth,
} from './application/CompanionNativeFacade';
export { getCompanionNotificationDiagnostics } from './application/CompanionNotificationFacade';
export { runCompanionWake } from './application/ExecuteCompanionWake';
export { cancelCompanionWakeExecution } from './application/ExecuteCompanionWake';
export {
  addCompanionExecutionCancelListener,
  addCompanionWakeListener,
} from './application/CompanionNativeFacade';
export {
  drainAndCancelAIScheduleProjectionRepair,
  invalidateAISchedulesForRevokedOwner,
  reconcileAIScheduleProjections,
} from './application/AIScheduleProjectionOwner';
export { recoverAIScheduleClaims } from './application/AIScheduleRecovery';
export {
  reconcileProactiveNativeRuntimeState,
  recordProactiveAgentRunState,
} from './application/ProactiveAgentRunState';
export { disableCompanionProductState } from './application/CompanionSettingsFacade';
export { COMPANION_PROMPT_DEFINITIONS } from './application/CompanionPromptDefinitions';
export {
  CancelAIScheduleTool,
  CreateAIScheduleTool,
  GetAIScheduleTool,
  ListAISchedulesTool,
  UpdateAIScheduleTool,
} from './aiTools/AIScheduleTools';

export { default as CompanionSettingsScreen } from './presentation/CompanionSettingsScreen';
export { default as CompanionSystemAccessScreen } from './presentation/CompanionSystemAccessScreen';
export { default as CompanionBlacklistScreen } from './presentation/CompanionBlacklistScreen';
export { default as ProactiveLifeScreen } from './presentation/ProactiveLifeScreen';
export { useCompanionFloatingBridge } from './presentation/useCompanionFloatingBridge';
