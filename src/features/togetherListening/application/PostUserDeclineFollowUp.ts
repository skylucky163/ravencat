/**
 * 用户拒绝 AI 发起的一起听邀请后的严格 AI 跟进决策。
 *
 * 这是一次 post-commit 可选沟通：用户拒绝与卡片终态投影已经由 lifecycle
 * 提交，这里任何失败都只记录日志，绝不可改写 Activity 真值或让用户动作失败。
 */

import { createAIClient } from '@platform/ai';
import type { TogetherListeningActivity } from '../domain/TogetherListeningActivity';
import { buildPostUserDeclinePromptBlocks } from './TogetherListeningPromptBlocks';
import { getTogetherListeningRuntimeDependencies } from './TogetherListeningRuntime';

export type PostListeningInviteDeclinedDecision =
  | { decision: 'send_message'; message: string }
  | { decision: 'stay_silent'; message: null };

/** 解析 post_user_decline 的严格 JSON，不接受额外字段或隐式修复。 */
export function parsePostListeningInviteDeclinedDecision(
  text: string,
): PostListeningInviteDeclinedDecision {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('together_listening.post_user_decline 不是严格 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('together_listening.post_user_decline 必须是 JSON 对象');
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.join(',') !== 'decision,message') {
    throw new Error('together_listening.post_user_decline 包含非契约字段');
  }
  if (object.decision === 'stay_silent') {
    if (object.message !== null) {
      throw new Error('together_listening.post_user_decline stay_silent 的 message 必须为 null');
    }
    return { decision: 'stay_silent', message: null };
  }
  if (object.decision !== 'send_message') {
    throw new Error('together_listening.post_user_decline decision 非法');
  }
  if (typeof object.message !== 'string' || !object.message.trim()) {
    throw new Error('together_listening.post_user_decline send_message 的 message 必须为非空字符串');
  }
  return {
    decision: 'send_message',
    message: object.message.trim(),
  };
}

/** 只有 AI 发起且被用户拒绝这一次状态转换才允许进入跟进决策。 */
export function isEligibleForPostUserDeclineFollowUp(
  activity: TogetherListeningActivity,
): boolean {
  return activity.initiator === 'ai' && activity.phase === 'declined_by_user';
}

export async function runPostUserDeclineFollowUp(
  activity: TogetherListeningActivity,
): Promise<void> {
  if (!isEligibleForPostUserDeclineFollowUp(activity)) {
    return;
  }
  try {
    const runtime = getTogetherListeningRuntimeDependencies();
    // 邀请属于发出时的 Host；standalone 决策开始前先确认 authority 未易主。
    if ((await runtime.getCurrentHostAIId()) !== activity.hostAiId) {
      return;
    }
    const aiConfig = await runtime.declineFollowUp.resolveAIConfig(activity.hostAiId);
    if (!aiConfig) {
      return;
    }

    const promptPack = await runtime.declineFollowUp.assembleStandalonePromptPack({
      scenarioId: 'together_listening.post_user_decline',
      assistantId: aiConfig.id,
      blocks: buildPostUserDeclinePromptBlocks(aiConfig),
      currentInput: JSON.stringify({
        task: 'post_user_decline',
        activity: {
          id: activity.id,
          chatSessionId: activity.chatSessionId,
          initiator: activity.initiator,
          phase: activity.phase,
          hostAiId: activity.hostAiId,
          createdAtEpochMs: activity.createdAtEpochMs,
          endedAtEpochMs: activity.endedAtEpochMs,
        },
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
      throw new Error(response.error || '一起听邀请被拒后的跟进决策失败');
    }

    const decision = parsePostListeningInviteDeclinedDecision(response.text);
    if (decision.decision !== 'send_message') {
      return;
    }
    // 模型思考期间 Host 可能已切换；落库前二次确认，避免旧 Host 冒充新 Host 发言。
    if ((await runtime.getCurrentHostAIId()) !== activity.hostAiId) {
      return;
    }
    await runtime.declineFollowUp.appendExternalAssistantMessage({
      sessionId: activity.chatSessionId,
      text: decision.message,
      aiId: aiConfig.id,
      aiName: aiConfig.name,
      aiAvatar: aiConfig.avatar,
      agentId: aiConfig.agentId,
      // 这是用户刚刚在聊天内拒绝邀请后的直接自然回应，不是主动联系。
      deliveryKind: 'passive',
      triggerSource: 'together_listening',
      relatedEntityType: 'togetherListeningActivity',
      relatedEntityId: activity.id,
    });
  } catch (error) {
    // 用户拒绝已经成立；跟进是 best-effort 的次级结果，失败只记录诊断。
    console.warn('[TogetherListening] 用户拒绝邀请后的跟进决策未完成（拒绝已生效）：', error);
  }
}
