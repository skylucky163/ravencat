import { getAIAssistantById } from '@features/assistants';
import { aiAssistantRepository, aiHostRepository } from '@features/assistants/composition';
import { isChatReplyRunCurrentInTransaction, isGroupSpeechTaskRunCurrentInTransaction, resolveCanonicalConversation } from '@features/chat';
import { createRoleApplicationCardInTransaction, deliverRoleApplicationCard, type AssistantRoleApplication } from '@features/chat/composition';
import { postApplicationExecution } from '@platform/device';
import { databaseCoordinator } from '@platform/persistence';
import type { AgentToolExecutionContext, AgentToolExecutionResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

function roleTool(role: AssistantRoleApplication, name: string, description: string) {
  return {
    name,
    definition: { name, description, parameters: { type: 'object', properties: {}, additionalProperties: false } },
    async execute(_input: unknown, context: AgentToolExecutionContext): Promise<AgentToolExecutionResult<unknown>> {
      const { assistantId, sessionId, type } = context.task;
      const isGroup = type === 'group_chat_reply';
      const applicant = await getAIAssistantById(assistantId);
      if (!sessionId || !applicant) return failure('ROLE_APPLICATION_UNAVAILABLE', '当前没有可用于发送申请的聊天会话。');
      const cardSessionId = isGroup ? (await resolveCanonicalConversation({ aiId: assistantId })).id : sessionId;
      const submitted = await databaseCoordinator.transaction({ name: 'chat.submit-role-application', feature: 'chat', priority: 'interactive' }, async (tx) => {
        throwIfAbortSignalAborted(context.abortSignal);
        const isCurrent = isGroup ? isGroupSpeechTaskRunCurrentInTransaction : isChatReplyRunCurrentInTransaction;
        if (!await isCurrent(tx, context.runId)) return { status: 'unavailable' } as const;
        const incumbent = await aiAssistantRepository.readRoleHolderInTransaction(tx, role);
        if (incumbent?.id === assistantId) return { status: 'already_assigned' } as const;
        const cooldown = role === 'host' && !incumbent ? await aiHostRepository.readHostCooldown(tx) : null;
        const card = await createRoleApplicationCardInTransaction(tx, {
          role, applicantId: assistantId, agentId: applicant.agentId, sessionId: cardSessionId,
          incumbentId: incumbent?.id ?? null, incumbentName: incumbent?.name ?? null, cooldownEndAt: cooldown?.endAt ?? null,
          requestKey: `${context.runId}:${role}`, timelineRunId: isGroup ? null : context.runId,
        });
        return { status: 'submitted', card, hostToNotify: role === 'host' ? incumbent?.id : undefined } as const;
      });
      if (submitted.status === 'unavailable') return failure('ROLE_APPLICATION_UNAVAILABLE', '本轮聊天已结束，申请未发送。');
      if (submitted.status === 'already_assigned') return failure('ROLE_ALREADY_ASSIGNED', `你已经是${role === 'host' ? '主理 AI' : '记账 AI'}。`);

      const { card, hostToNotify } = submitted;
      if (card.inserted) {
        await Promise.all([
          deliverRoleApplicationCard(card.message, applicant),
          hostToNotify ? notifyCurrentHost(hostToNotify, card.message.id) : undefined,
        ]);
      }
      return {
        status: 'success', data: { messageId: card.message.id },
        modelContent: role === 'ledger'
          ? '申请卡已发到你与用户的单聊。用户同意后，你才会接任记账 AI。'
          : '申请卡已发到你与用户的单聊。只有主理空缺且当前没有任命冷静期时，用户才能同意。',
        metadata: { fulfillsUserVisibleOutput: !isGroup },
      };
    },
  };
}

function failure(code: string, modelContent: string): AgentToolExecutionResult<never> {
  return { status: 'error', code, modelContent, retryable: false };
}

async function notifyCurrentHost(aiId: string, messageId: number): Promise<void> {
  try {
    if (!await postApplicationExecution('relationship', { change: 'application', aiId, messageId }, 540_000)) {
      console.warn('[RoleApplication] 应用宿主未接受主理申请通知', { messageId });
    }
  } catch (error) {
    console.warn('[RoleApplication] 主理申请通知投递失败', { messageId, error });
  }
}

export const roleApplicationTools = [
  roleTool('ledger', 'apply_for_ledger_ai', '自主向用户申请成为记账 AI，发送一张关系申请卡。用户同意后，你会接替当前记账 AI。'),
  roleTool('host', 'apply_for_host_ai', '自主向用户申请成为主理 AI，发送一张关系申请卡。有其他主理 AI 在任时，对方会收到申请通知。只有主理空缺且没有任命冷静期，用户才能在卡片上同意。'),
];
