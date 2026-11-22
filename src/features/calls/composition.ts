/** 仅供 Host 组装 Calls 的具体仓储与 Android 适配器。 */

export { configureCallRuntimeDependencies } from './application/runtime/CallRuntimeDependencies';
export { configureCallBackgroundRuntime, ensureCallBackgroundMigration } from './application/CallBackgroundSettings';
export { callBackgroundRepository } from './infrastructure/SQLiteCallBackgroundRepository';
export { configureCallRingtoneRuntime } from './application/CallRingtoneSettings';
export { callRingtoneRepository } from './infrastructure/SQLiteCallRingtoneRepository';
export { callRepository } from './infrastructure/SQLiteCallRepository';
export { buildCallTranscriptSearch } from './infrastructure/SQLiteCallHistoryRepository';
export { callAudioPlayback } from './infrastructure/NativeCallAudioAdapter';
export { createCallExecutionAdapter } from './infrastructure/NativeCallExecutionAdapter';
export { createCallMediaRuntime } from './application/runtime/CallMediaRuntime';
export { registerHostedCallMediaRuntime } from './application/runtime/CallMediaRuntimeRegistry';
export { requestCallCameraPermission, requestCallMicrophonePermission } from './infrastructure/CallPermissionAdapter';

export { CALL_SNAPSHOT_BACKUP_EXCLUSIONS } from './application/snapshots/CallSnapshotLifetime';
