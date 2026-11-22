/** 仅供 Host 组装 Companion 的具体仓储与 Android 适配器。 */

export { configureCompanionRuntimeDependencies } from './application/CompanionRuntimeDependencies';
export { executeFloatingMessage } from './application/ExecuteFloatingMessage';
export { companionSettingsRepository } from './infrastructure/SQLiteCompanionSettingsRepository';
export { companionStateRepository } from './infrastructure/SQLiteCompanionStateRepository';
export { aiScheduleRepository } from './infrastructure/SQLiteAIScheduleRepository';
export { acknowledgeScheduleReplyInTransaction } from './infrastructure/SQLiteAIScheduleRepository';
export { proactiveLifeReadRepository } from './infrastructure/SQLiteProactiveLifeReadRepository';
export { companionNativeAdapter } from './infrastructure/CompanionNativeAdapter';
export { purgeAssistantSchedulesInTransaction } from './infrastructure/AssistantScheduleLifecycle';
