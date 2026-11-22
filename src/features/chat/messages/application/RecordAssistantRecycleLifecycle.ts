/** 回收和恢复是应用事实，与生命周期同事务保存；不冒充用户输入或触发模型。 */
import type { AssistantRecycleLifecycleChange } from '@features/assistants';
import { getCurrentUserNameInTransaction } from '@features/profile';
import type { DatabaseTransactionExecutor } from '@platform/persistence';
import { getChatConversationRuntimeDependencies } from '../../conversation/application/ChatConversationRuntime';
import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';
import { emitChatMessagesUpdated } from '../events/ChatEvents';
import { buildAssistantRecycleLifecycleText, type ParsedChatMessageMetadata } from '../domain/chatMessageMetadata';

export async function recordAssistantRecycleLifecycleInTransaction(
  transaction: DatabaseTransactionExecutor, change: AssistantRecycleLifecycleChange,
): Promise<() => void> {
  const occurred = new Date(change.occurredAt);
  const session = await getChatConversationRuntimeDependencies().sessions.resolveCanonicalConversationInTransaction(transaction, change.assistantId, occurred);
  const metadata: ParsedChatMessageMetadata = {
    type: 'assistantRecycleLifecycle', source: 'assistants', lifecycleChange: change.change, deletedAt: change.deletedAt,
    actorName: await getCurrentUserNameInTransaction(transaction), assistantDisplayName: change.assistantDisplayName,
    removedRoles: change.change === 'recycled'
      ? [...(change.wasHost ? ['host' as const] : []), ...(change.wasLedger ? ['ledger' as const] : [])] : [],
  };
  const text = buildAssistantRecycleLifecycleText(metadata, { audience: 'user', assistantName: change.assistantDisplayName });
  const { inserted } = await getChatMessageRuntimeDependencies().messages.upsertStatefulTimelineEntryInTransaction(transaction, {
    message: { sessionId: session.id, text, senderType: 'system', isMe: false,
      clientMessageId: `assistant-recycle:${change.assistantId}:${change.change}:${change.deletedAt}:${change.occurredAt}`,
      createdAt: change.occurredAt, updatedAt: change.occurredAt,
      time: `${String(occurred.getHours()).padStart(2, '0')}:${String(occurred.getMinutes()).padStart(2, '0')}`,
      status: 'sent', deliveryStatus: 'delivered', isRead: true,
      metadataJson: JSON.stringify(metadata),
    }, previewText: null,
  });
  return () => { if (inserted) emitChatMessagesUpdated(session.id); };
}
