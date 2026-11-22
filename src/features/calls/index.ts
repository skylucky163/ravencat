/** Calls 功能公共 API；外部调用方只应从此入口访问通话能力。 */

export * from './application';
export * from './presentation';
export { LookAtUserTool } from './aiTools/LookAtUserTool';
export { RequestVideoCallTool } from './aiTools/RequestVideoCallTool';
export { ReadCallHistoryTool } from './aiTools/ReadCallHistoryTool';
export type {
  CallDirection,
  CallEndReason,
  CallMediaMode,
  CallSession,
  CallSource,
  CallState,
} from './domain/CallSession';
export type {
  CallAttachment,
  CallAttachmentKind,
  CallEvent,
  CallEventActorType,
  CallEventKind,
} from './domain/CallEvent';
export type {
  CallParticipant,
  CallParticipantRole,
} from './domain/CallParticipant';
export type {
  CallSnapshotWriteResult,
  CreateCallSnapshotAttachmentInput,
  CreateCallEventInput,
  CreateCallParticipantInput,
  CreateCallSessionInput,
  CreateCallSnapshotInput,
  ICallRepository,
  UpdateCallEventInput,
  UpdateCallSessionInput,
} from './domain/CallRepository';
export type { CallAIConfig } from './domain/CallAIConfig';
export type { CallContextInfo, CallSummaryTranscript, CallSummarySource } from './domain/CallSummary';
export type {
  CallRuntimeDependencies,
} from './application/runtime/CallRuntimeDependencies';
export { CALL_PROMPT_DEFINITIONS } from './application/CallPromptDefinitions';
