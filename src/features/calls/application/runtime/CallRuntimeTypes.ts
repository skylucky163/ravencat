/** 通话生命周期与运行时对外使用的输入、结果类型。 */

import type { ChatMessage } from '@features/chat';
import type { CallAIConfig } from '../../domain/CallAIConfig';
import type {
  CallEndReason,
  CallSession,
  CallSource,
} from '../../domain/CallSession';

export type AIOutgoingCallDecision =
  | { decision: 'accept'; spokenText: string }
  | { decision: 'reject'; rejectionReason: string };

export interface CallPreflightResult {
  ok: boolean;
  errorMessage: string | null;
  endReason: CallEndReason | null;
}

export interface CallPreflightOptions {
  requiresCamera?: boolean;
  requiresNotification?: boolean;
}

export type StartOutgoingCallResult =
  | { status: 'ended'; call: CallSession; visibleMessages: ChatMessage[] }
  | { status: 'accepted'; call: CallSession; visibleMessages: ChatMessage[] }
  | { status: 'rejected'; call: CallSession; rejectionReason: string; visibleMessages: ChatMessage[] }
  | { status: 'failed'; call: CallSession | null; errorMessage: string; visibleMessages: ChatMessage[] };

export interface StartOutgoingCallParams {
  chatSessionId: string;
  aiConfig: CallAIConfig;
  requestedMode?: 'voice' | 'video';
  onCallCreated?: (call: CallSession) => void;
}

export interface IncomingCallRequest {
  openingLine: string;
  expectedMode: 'voice' | 'video';
  source?: CallSource;
  sourceToolCallId?: string | null;
}

export type RequestIncomingCallResult =
  | { status: 'ringing'; call: CallSession; visibleMessages: ChatMessage[] }
  | { status: 'failed'; call: CallSession | null; errorMessage: string; visibleMessages: ChatMessage[] };

export interface MutateIncomingCallResult {
  call: CallSession;
  visibleMessages: ChatMessage[];
}
