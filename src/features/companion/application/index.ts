/** Companion 应用层公共出口。 */

export {
  AIScheduleApplication,
  cancelAIScheduleCommand,
  cancelAIScheduleCommand as cancelAISchedule,
  claimAIScheduleCommand,
  claimAIScheduleCommand as claimAISchedule,
  consumeAIScheduleCommand,
  consumeAIScheduleCommand as consumeAISchedule,
  createAIScheduleCommand,
  createAIScheduleCommand as createAISchedule,
  getAIScheduleQuery,
  getAIScheduleQuery as getAISchedule,
  listAISchedulesQuery,
  listAISchedulesQuery as listAISchedules,
  updateAIScheduleCommand,
  updateAIScheduleCommand as updateAISchedule,
} from './AIScheduleApplication';
export type {
  AIScheduleApplicationDependencies,
  AIScheduleApplicationErrorCode,
  AIScheduleApplicationOutcome,
  CreateAIScheduleInput,
  ListAISchedulesQuery,
  UpdateAIScheduleCommand,
} from './AIScheduleApplication';

export {
  buildCompanionAIRequestConfig,
  resolveCompanionConversationTarget,
} from './CompanionConversationTarget';
export type {
  CompanionConversationTarget,
  CompanionConversationTargetFailureReason,
  CompanionConversationTargetResult,
} from './CompanionConversationTarget';
export {
  addCompanionExecutionCancelListener,
  addCompanionWakeListener,
  clearCompanionNativeDataForFactoryReset,
  consumeCompanionExecutionCancellation,
  getNativeHealth,
} from './CompanionNativeFacade';
export type {
  CompanionExecutionOutcome,
  CompanionNativeHealth,
  CompanionNativePort,
  CompanionNativeSubscription,
  CompanionSchedulerDriver,
  CompanionWakeEvent,
  CompanionWakeReason,
  CompanionWakeSource,
} from './CompanionNativePort';
export {
  buildCompanionExecutionCancellationError,
  createCompanionExecutionCancellationRegistry,
} from './CompanionExecutionCancellation';
export type { CompanionExecutionCancellationRegistry } from './CompanionExecutionCancellation';
export {
  getCompanionNotificationDiagnostics,
  requestCompanionNotificationPermission,
} from './CompanionNotificationFacade';
export type {
  CompanionNotificationDiagnostics,
  CompanionNotificationPort,
} from './CompanionNotificationPort';
export { runCompanionWake, cancelCompanionWakeExecution } from './ExecuteCompanionWake';
export {
  runAIScheduleAutonomousAgent,
  type RunAIScheduleAutonomousAgentInput,
} from './RunAIScheduleAutonomousAgent';
export {
  runHostAutonomousAgent,
  type RunHostAutonomousAgentInput,
} from './RunHostAutonomousAgent';
export {
  runHeadlessAISchedule,
  type HeadlessAIScheduleData,
  type HeadlessAIScheduleOutcome,
} from './RunHeadlessAISchedule';
export {
  AIScheduleProjectionOwner,
  cancelAIScheduleWithProjection,
  claimAIScheduleForHeadless,
  consumeAIScheduleWithProjection,
  createAIScheduleWithProjection,
  drainAndCancelAIScheduleProjectionRepair,
  invalidateAISchedulesForRevokedOwner,
  reconcileAIScheduleProjections,
  updateAIScheduleWithProjection,
} from './AIScheduleProjectionOwner';
export type {
  AIScheduleProjectionOutcome,
  AIScheduleProjectionOwnerDependencies,
  CancelAIScheduleWithProjectionOutcome,
  ConsumeAIScheduleWithProjectionOutcome,
  CreateAIScheduleWithProjectionOutcome,
  UpdateAIScheduleInput,
  UpdateAIScheduleWithProjectionOutcome,
} from './AIScheduleProjectionOwner';
export {
  AIScheduleRecovery,
  recoverAIScheduleClaims,
} from './AIScheduleRecovery';
export type {
  AIScheduleRecoveryDependencies,
  AIScheduleRecoveryMode,
  AIScheduleRecoveryResult,
} from './AIScheduleRecovery';
export {
  getProactiveAgentRunState,
  reconcileProactiveNativeRuntimeState,
  recordProactiveAgentRunState,
} from './ProactiveAgentRunState';
export { loadProactiveLifeCalendar, listProactiveLifeDay } from './ProactiveLifeReadQueries';
export type { ProactiveLifeCalendarItem, ProactiveLifeCalendarCursor, ProactiveLifeDayCount, ProactiveLifeDayRange } from './ProactiveLifeReadQueries';

export {
  classifyCompanionProviderError,
  CompanionError,
  getCompanionErrorMessage,
  normalizeCompanionErrorCode,
  resolveCompanionErrorMessage,
} from './CompanionError';
export type { CompanionErrorCode } from './CompanionError';
export {
  activateCompanionProductState,
  disableCompanionProductState,
  loadCompanionProductState,
  loadCompanionUserScreenCaptureBlacklist,
  updateCompanionProductSettings,
  updateCompanionUserScreenCaptureBlacklist,
} from './CompanionSettingsFacade';
export type {
  DisableCompanionInput,
  CompanionProductState,
} from './CompanionSettingsFacade';
export type {
  ProactiveAgentRunState,
  ProactiveAgentRunStatus,
  ProactiveNativeNotificationSnapshot,
  ProactiveNativeRuntimeSnapshot,
} from './ProactiveAgentRunState';
