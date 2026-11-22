/** 用户任命／撤销触发的有界回复；通知只作为本轮输入，不写成用户发言或系统提示条。 */
import { getAIAssistantById } from '@features/assistants';
import { AUTONOMOUS_SILENT_REPLY, requestOptionalProactiveChatReply, requestProactiveChatReply, resolveCanonicalConversation } from '@features/chat';
import { readRoleApplicationNotice } from '@features/chat/composition';
import { ensureHostDatabaseReady } from '../composition/ensureHostDatabaseReady';
import type { ApplicationExecutionContext } from './ApplicationExecutionHost';

interface HostRelationshipReplyRequest {
  aiId?: string;
  change?: 'appointed' | 'revoked' | 'application';
  occurredAt?: string;
  messageId?: number;
}

export async function executeHostRelationshipReply(data: HostRelationshipReplyRequest, lifetime: ApplicationExecutionContext): Promise<void> {
  if (data.change === 'application') {
    if (typeof data.aiId !== 'string' || !data.aiId || typeof data.messageId !== 'number' || !Number.isSafeInteger(data.messageId) || data.messageId < 1) {
      throw new Error('主理申请通知参数非法');
    }
    await executeHostApplicationReply(data.aiId, data.messageId, lifetime);
    return;
  }
  // 原生 Intent 是运行时边界，不能把缺失或非法事件解释为真实的用户动作。
  if (!data.aiId || !data.change || !['appointed', 'revoked'].includes(data.change)
    || !data.occurredAt || !Number.isFinite(Date.parse(data.occurredAt))) {
    throw new Error('主理身份变更回复任务参数非法');
  }
  await ensureHostDatabaseReady();
  if (lifetime.signal.aborted || performance.now() >= lifetime.executionDeadlineAt) return;
  const assistant = await getAIAssistantById(data.aiId);
  if (!assistant) return;
  const conversation = await resolveCanonicalConversation({ aiId: assistant.id });
  await requestProactiveChatReply({
    abortSignal: lifetime.signal, executionDeadlineAt: lifetime.executionDeadlineAt,
    sessionId: conversation.id,
    aiConfig: { ...assistant, systemPrompt: assistant.systemPrompt ?? undefined,
      apiBaseUrl: assistant.apiBaseUrl ?? '', apiKey: assistant.apiKey ?? '' },
    currentInput: [
      `操作时间：${data.occurredAt}。`,
      data.change === 'appointed' ? '用户刚刚任命你为主理 AI。' : '用户刚刚撤销了你的主理 AI 身份。',
    ].join('\n'),
    triggerSource: 'chat', triggerReason: `host_ai_${data.change}`,
    relatedEntityType: 'host_relationship', relatedEntityId: assistant.id,
    correlationId: `host_relationship:${assistant.id}:${data.change}:${data.occurredAt}`,
    capabilities: ['chat.reply'],
  });
}

async function executeHostApplicationReply(aiId: string, messageId: number, lifetime: ApplicationExecutionContext): Promise<void> {
  await ensureHostDatabaseReady();
  if (lifetime.signal.aborted || performance.now() >= lifetime.executionDeadlineAt) return;
  const card = await readRoleApplicationNotice(messageId);
  if (card?.incumbentId !== aiId) return;
  const [applicant, host] = await Promise.all([getAIAssistantById(card.applicantId), getAIAssistantById(aiId)]);
  // 通知只属于发卡时的在任者；撤任或回收后不再唤醒，也不转发给继任者。
  if (!applicant || !host?.isHostAI || host.isBlocked) return;
  const conversation = await resolveCanonicalConversation({ aiId });
  await requestOptionalProactiveChatReply({
    abortSignal: lifetime.signal, executionDeadlineAt: lifetime.executionDeadlineAt,
    sessionId: conversation.id,
    aiConfig: { ...host, systemPrompt: host.systemPrompt ?? undefined,
      apiBaseUrl: host.apiBaseUrl ?? '', apiKey: host.apiKey ?? '', enableTools: false },
    currentInput: [
      `申请时间 ${card.occurredAt}。`,
      `AI ${JSON.stringify(applicant.name)} 向用户发出了一张申请成为主理 AI 的卡片。你的主理身份仍然有效。`,
      card.decision === 'declined' ? '用户已拒绝该申请。' : '你在任期间，用户只能拒绝这张卡片。',
      `你可以按自己的性格决定要不要就这件事联系用户。若决定安静处理，请只输出 ${AUTONOMOUS_SILENT_REPLY}，应用会保持静默。`,
    ].join('\n'),
    triggerSource: 'host_role_application', triggerReason: 'host_ai_application',
    relatedEntityType: 'role_application', relatedEntityId: String(messageId),
    correlationId: `host_role_application:${messageId}`,
    capabilities: ['chat.reply'],
  });
}
