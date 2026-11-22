/** 处理用户主动挂断已接通普通通话后的严格 AI 跟进决策。 */

import { createAIClient } from '@platform/ai';
import type { CallEvent } from '../../domain/CallEvent';
import type { CallSession } from '../../domain/CallSession';
import { buildPostUserHangUpPromptBlocks } from '../CallPromptBlocks';
import { getCallRuntimeDependencies } from './CallRuntimeDependencies';

export type PostUserHangUpDecision =
  | { decision: 'send_message'; message: string }
  | { decision: 'stay_silent'; message: null };

/** 解析 post_user_hangup 的严格 JSON，不接受额外字段或隐式修复。 */
export function parsePostUserHangUpDecision(text: string): PostUserHangUpDecision {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('call.post_user_hangup 不是严格 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('call.post_user_hangup 必须是 JSON 对象');
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.join(',') !== 'decision,message') {
    throw new Error('call.post_user_hangup 包含非契约字段');
  }
  if (object.decision === 'stay_silent') {
    if (object.message !== null) {
      throw new Error('call.post_user_hangup stay_silent 的 message 必须为 null');
    }
    return { decision: 'stay_silent', message: null };
  }
  if (object.decision !== 'send_message') {
    throw new Error('call.post_user_hangup decision 非法');
  }
  if (typeof object.message !== 'string' || !object.message.trim()) {
    throw new Error('call.post_user_hangup send_message 的 message 必须为非空字符串');
  }
  return {
    decision: 'send_message',
    message: object.message.trim(),
  };
}

/** 仅允许普通、已接通且由用户主动结束的非后台唤醒通话进入跟进决策。 */
export function isEligibleForPostUserHangUpFollowUp(call: CallSession): boolean {
  return call.source !== 'backgroundWake'
    && Boolean(call.acceptedAt)
    && call.endReason === 'userEnded';
}

export async function handleUserEndedCallFollowUp(call: CallSession): Promise<void> {
  if (!isEligibleForPostUserHangUpFollowUp(call)) {
    return;
  }

  const runtime = getCallRuntimeDependencies();
  const aiConfig = await runtime.resolveAIConfig(call.aiAssistantId);
  if (!aiConfig) {
    return;
  }

  const events = await runtime.repositories.calls.listEvents({
    callId: call.id,
    limit: 100,
  });
  const promptPack = await runtime.assembleStandalonePromptPack({
    scenarioId: 'call.post_user_hangup',
    assistantId: aiConfig.id,
    blocks: buildPostUserHangUpPromptBlocks(aiConfig),
    currentInput: JSON.stringify({
      task: 'post_user_hangup',
      call: {
        id: call.id,
        chatSessionId: call.chatSessionId,
        direction: call.direction,
        source: call.source,
        acceptedAt: call.acceptedAt,
        endedAt: call.endedAt,
        endReason: call.endReason,
      },
      callEvents: events
        .filter((event) => event.includeInAIContext)
        .map(toPromptEvent),
    }),
  });
  const client = createAIClient({
    baseURL: aiConfig.apiBaseUrl,
    apiKey: aiConfig.apiKey,
    model: aiConfig.model,
    temperature: aiConfig.temperature,
    topP: aiConfig.topP,
    disableThinking: aiConfig.disableThinking,
    reasoningEffort: aiConfig.reasoningEffort,
    maxTokens: aiConfig.maxTokens == null ? aiConfig.maxTokens : Math.max(aiConfig.maxTokens, 300),
    systemPrompt: promptPack.systemPrompt,
  });
  const response = await client.chat(promptPack.modelMessages, {
    includeSystemPrompt: true,
    responseFormat: 'json_object',
    allowReasoningLengthRetry: false,
  });
  if (!response.success) {
    throw new Error(response.error || '用户主动挂断后的跟进决策失败');
  }

  const decision = parsePostUserHangUpDecision(response.text);
  if (decision.decision === 'send_message') {
    await runtime.chat.appendExternalAssistantMessage({
      sessionId: call.chatSessionId,
      text: decision.message,
      aiId: aiConfig.id,
      aiName: aiConfig.name,
      aiAvatar: aiConfig.avatar || null,
      agentId: aiConfig.agentId,
      deliveryKind: 'proactive',
      triggerSource: 'call',
      relatedEntityType: 'call',
      relatedEntityId: call.id,
    });
  }

  await runtime.repositories.calls.appendEvent({
    callId: call.id,
    chatSessionId: call.chatSessionId,
    kind: 'systemNotice',
    actorType: 'system',
    text: decision.decision === 'send_message'
      ? '用户主动挂断后，AI 决定发送一条普通聊天消息。'
      : '用户主动挂断后，AI 决定暂时保持安静。',
    visibleInChat: false,
    includeInAIContext: false,
    payloadJson: JSON.stringify({
      type: 'postUserHangUpDecision',
      decision: decision.decision,
    }),
  });
}

function toPromptEvent(event: CallEvent): {
  kind: CallEvent['kind'];
  actorType: CallEvent['actorType'];
  text: string | null;
  createdAt: string;
} {
  return {
    kind: event.kind,
    actorType: event.actorType,
    text: event.text,
    createdAt: event.createdAt,
  };
}
