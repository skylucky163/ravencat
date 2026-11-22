/** 持久化通话未接通或来电链路失败，并生成对应聊天状态消息。 */

import type { ChatMessage } from '@features/chat';
import type { CallAIConfig } from '../../domain/CallAIConfig';
import type { ICallRepository } from '../../domain/CallRepository';
import type { CallEndReason, CallSession } from '../../domain/CallSession';
import { saveCallStatusMessage } from '../events/CreateCallStatusMessage';
import type { IncomingCallRequest } from './CallRuntimeTypes';
import { createCallId } from './CallRuntimeHelpers';
import type { CallChatWritePort } from './CallRuntimeDependencies';

interface CallFailureResult {
  call: CallSession;
  errorMessage: string;
  visibleMessages: ChatMessage[];
}

export class CallFailureRecorder {
  constructor(
    private readonly getCallRepository: () => ICallRepository,
    private readonly getChat: () => CallChatWritePort,
  ) {}

  private get callRepository(): ICallRepository {
    return this.getCallRepository();
  }

  async createMissedOutgoingCall(params: {
    chatSessionId: string;
    aiConfig: CallAIConfig;
    requestedMode: 'voice' | 'video';
    errorMessage: string;
    reason: CallEndReason;
  }): Promise<CallFailureResult> {
    const now = new Date().toISOString();
    const call = await this.callRepository.createSession({
      id: createCallId(),
      chatSessionId: params.chatSessionId,
      aiAssistantId: params.aiConfig.id,
      agentId: params.aiConfig.agentId,
      direction: 'outgoing',
      state: 'missed',
      requestedMode: params.requestedMode,
      activeMode: params.requestedMode,
      source: 'user',
      startedAt: now,
      endedAt: now,
      endReason: 'missedByAI',
      reason: params.reason,
    });
    await this.callRepository.appendEvent({
      callId: call.id,
      chatSessionId: params.chatSessionId,
      kind: 'error',
      actorType: 'system',
      text: params.errorMessage,
      includeInAIContext: true,
      payloadJson: JSON.stringify({ reason: params.reason, endReason: 'missedByAI' }),
    });
    const visibleMessages = [await saveCallStatusMessage(this.getChat(), {
      sessionId: params.chatSessionId,
      callId: call.id,
      direction: 'outgoing',
      callStatus: 'callMissed',
      actor: 'system',
      endReason: 'missedByAI',
      agentId: params.aiConfig.agentId,
      aiContextText: `用户发起的视频电话没有接通，聊天界面显示为【对方未接听】；底层原因是通话链路预检失败：${params.errorMessage}`,
      // 用户主动拨出并在通话页看到未接通结果，直接已读。
      isRead: true,
    })];
    return { call, errorMessage: params.errorMessage, visibleMessages };
  }

  async createFailedIncomingCall(params: {
    chatSessionId: string;
    aiConfig: CallAIConfig;
    payload: IncomingCallRequest;
    requestedMode: 'voice' | 'video';
    errorMessage: string;
    endReason: CallEndReason;
  }): Promise<CallFailureResult> {
    const now = new Date().toISOString();
    const call = await this.callRepository.createSession({
      id: createCallId(),
      chatSessionId: params.chatSessionId,
      aiAssistantId: params.aiConfig.id,
      agentId: params.aiConfig.agentId,
      direction: 'incoming',
      state: 'failed',
      requestedMode: params.requestedMode,
      activeMode: params.requestedMode,
      source: params.payload.source || 'aiTool',
      sourceToolCallId: params.payload.sourceToolCallId || null,
      openingLine: params.payload.openingLine,
      startedAt: now,
      endedAt: now,
      endReason: params.endReason,
    });
    await this.callRepository.appendEvent({
      callId: call.id,
      chatSessionId: params.chatSessionId,
      kind: 'error',
      actorType: 'system',
      text: params.errorMessage,
      includeInAIContext: true,
      payloadJson: JSON.stringify({ endReason: params.endReason, direction: 'incoming' }),
    });
    const visibleMessages = await this.createIncomingFailureMessage(call, params.errorMessage, params.endReason);
    return { call, errorMessage: params.errorMessage, visibleMessages };
  }

  async failExistingIncomingCall(params: {
    call: CallSession;
    errorMessage: string;
    endReason: CallEndReason;
  }): Promise<CallFailureResult> {
    const failedCall = await this.callRepository.updateSession(params.call.id, {
      state: 'failed',
      endedAt: new Date().toISOString(),
      endReason: params.endReason,
    });
    await this.callRepository.appendEvent({
      callId: params.call.id,
      chatSessionId: params.call.chatSessionId,
      kind: 'error',
      actorType: 'system',
      text: params.errorMessage,
      includeInAIContext: true,
      payloadJson: JSON.stringify({ endReason: params.endReason, direction: 'incoming' }),
    });
    const visibleMessages = await this.createIncomingFailureMessage(
      params.call,
      params.errorMessage,
      params.endReason
    );
    return { call: failedCall, errorMessage: params.errorMessage, visibleMessages };
  }

  private async createIncomingFailureMessage(
    call: CallSession,
    errorMessage: string,
    endReason: CallEndReason
  ): Promise<ChatMessage[]> {
    return [await saveCallStatusMessage(this.getChat(), {
      sessionId: call.chatSessionId,
      callId: call.id,
      direction: 'incoming',
      callStatus: 'callSystemError',
      actor: 'system',
      endReason,
      displayText: `【系统错误：${errorMessage}】`,
      agentId: call.agentId,
      // 来电链路失败，用户未看到/未响应这次来电；按未接处理，保留未读提醒。
      isRead: false,
    })];
  }
}
