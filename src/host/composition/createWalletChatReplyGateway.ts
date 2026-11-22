/** 将 Chat 回复流程适配为 Wallet 所需的窄网关。 */
import type { WalletChatReplyGateway } from '@features/wallet';
import {
  resolveCanonicalConversation,
  requestProactiveChatReply,
} from '@features/chat';

export function createWalletChatReplyGateway(): WalletChatReplyGateway {
  return {
    async generateReply({ aiProfile, triggerData, newRecords }) {
      // 解析 canonical conversation 也必须在 try 内：网关契约是返回结构化错误，
      // 不是把数据库/解析失败抛给 Wallet。
      let sessionId: string | null = null;
      try {
        const conversation = await resolveCanonicalConversation({ aiId: aiProfile.id });
        sessionId = conversation.id;
        const result = await requestProactiveChatReply({
          sessionId: conversation.id,
          currentInput: triggerData,
          aiConfig: {
            id: aiProfile.id,
            agentId: aiProfile.agentId,
            name: aiProfile.name,
            avatar: aiProfile.avatar ?? null,
            model: aiProfile.model,
            apiKey: aiProfile.apiKey,
            apiBaseUrl: aiProfile.apiBaseUrl ?? '',
            systemPrompt: aiProfile.systemPrompt || undefined,
            temperature: aiProfile.temperature,
            topP: aiProfile.topP,
            disableThinking: aiProfile.disableThinking,
            reasoningEffort: aiProfile.reasoningEffort,
            maxTokens: aiProfile.maxTokens,
            privateContextPrimaryLimit: aiProfile.privateContextPrimaryLimit,
            privateContextSecondaryLimit: aiProfile.privateContextSecondaryLimit,
            groupContextPrimaryLimit: aiProfile.groupContextPrimaryLimit,
            groupContextSecondaryLimit: aiProfile.groupContextSecondaryLimit,
            enableTools: aiProfile.enableTools,
            allowMultipleBubbles: aiProfile.allowMultipleBubbles,
            isHostAI: aiProfile.isHostAI,
          },
          triggerSource: 'ledger',
          triggerReason: 'new_records_batch',
          relatedEntityType: 'ledger_record_batch',
          relatedEntityId: newRecords.map((record) => record.id).join(','),
          capabilities: ['chat.reply', 'ledger.read', 'ledger.auto_reply'],
        });

        return { sessionId, text: result.message, error: null };
      } catch (error) {
        return {
          sessionId,
          text: '',
          error: error instanceof Error ? error.message : '记账 AI 回复失败',
        };
      }
    },
  };
}
