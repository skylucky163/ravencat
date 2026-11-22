import { databaseCoordinator, type DatabaseTransactionExecutor } from '@platform/persistence';
import { formatMessageTime } from '../../reply/application/ChatReplyUtils';
import { emitAIMessageReceived } from '../../reply/delivery/AIMessageEvents';
import type { ChatMessage } from '../domain/ChatMessage';
import { readRoleApplicationCard, roleApplicationTitle, type AssistantRoleApplication, type RoleApplicationCardMetadata } from '../domain/RoleApplicationCard';
import { emitChatMessagesPatched, emitChatMessagesUpdated } from '../events/ChatEvents';
import { getChatMessageRuntimeDependencies } from './ChatMessageRuntime';

interface RoleApplicationAssignments {
  assignLedger(tx: DatabaseTransactionExecutor, assistantId: string): Promise<boolean>;
  appointHost(tx: DatabaseTransactionExecutor, assistantId: string): Promise<(() => Promise<void>) | null>;
  runHostApproval<T>(commit: () => Promise<T>): Promise<T>;
}

let assignments: RoleApplicationAssignments;

export function configureRoleApplicationCards(gateway: RoleApplicationAssignments): void {
  assignments = gateway;
}

interface CreateRoleApplicationCardInput extends Omit<RoleApplicationCardMetadata, 'type' | 'decision'> {
  sessionId: string;
  agentId: string;
  requestKey: string;
  timelineRunId: string | null;
}

export function createRoleApplicationCardInTransaction(tx: DatabaseTransactionExecutor, input: CreateRoleApplicationCardInput) {
  const { sessionId, requestKey, timelineRunId, agentId, ...card } = input;
  const now = new Date();
  const metadata: RoleApplicationCardMetadata = { ...card, type: 'roleApplication', decision: 'pending' };
  const text = roleApplicationTitle(card.role);
  return getChatMessageRuntimeDependencies().messages.upsertStatefulTimelineEntryInTransaction(tx, {
    insertOnly: true, previewText: text, message: {
      sessionId, agentId, text, isMe: false, senderType: 'assistant', status: 'sent', deliveryStatus: 'delivered',
      clientMessageId: `role-application:${requestKey}`, createdAt: now.toISOString(), time: formatMessageTime(now),
      turnRunId: timelineRunId, turnItemIndex: null, metadataJson: JSON.stringify(metadata),
    },
  });
}

export async function deliverRoleApplicationCard(message: ChatMessage, applicant: { id: string; name: string; avatar: string | null }) {
  emitChatMessagesUpdated(message.sessionId);
  await emitAIMessageReceived({
    aiId: applicant.id, aiName: applicant.name, aiAvatar: applicant.avatar, agentId: message.agentId,
    sessionId: message.sessionId, message: message.text, committedMessageId: message.id,
    deliveryKind: 'passive', triggerSource: 'role_application',
  });
}

export async function readRoleApplicationNotice(messageId: number) {
  const message = await getChatMessageRuntimeDependencies().messages.getMessageById(messageId);
  const card = message && readRoleApplicationCard(message);
  return card?.role === 'host' && message ? { ...card, occurredAt: message.createdAt } : null;
}

export async function respondToRoleApplicationCard(
  sessionId: string, messageId: number, action: 'accept' | 'decline', role: AssistantRoleApplication,
) {
  const { messages } = getChatMessageRuntimeDependencies();
  const commit = async () => {
    const result = await databaseCoordinator.transaction({ name: 'chat.respond-role-application', feature: 'chat', priority: 'interactive' }, async (tx) => {
      const message = await messages.getMessageByIdInTransaction(tx, messageId);
      if (!message || message.sessionId !== sessionId) return 'unavailable';
      const card = readRoleApplicationCard(message);
      if (card?.role !== role) return 'unavailable';
      if (card.decision !== 'pending') return 'already_answered';

      let afterCommit: (() => Promise<void>) | null = null;
      if (action === 'accept') {
        if (card.role === 'host') {
          afterCommit = await assignments.appointHost(tx, card.applicantId);
          if (!afterCommit) return 'unavailable';
        } else if (!await assignments.assignLedger(tx, card.applicantId)) {
          return 'unavailable';
        }
      }

      const decision = action === 'accept' ? 'accepted' : 'declined';
      const text = `${roleApplicationTitle(card.role)}（${decision === 'accepted' ? '已同意' : '已拒绝'}）`;
      await messages.upsertStatefulTimelineEntryInTransaction(tx, {
        previewText: text,
        message: { ...message, text, metadataJson: JSON.stringify({ ...card, decision }) },
      });
      return { afterCommit };
    });
    if (typeof result === 'string') return result;
    emitChatMessagesPatched({ sessionId, updatedMessageIds: [messageId] });
    await result.afterCommit?.();
    return 'answered';
  };
  return action === 'accept' && role === 'host' ? assignments.runHostApproval(commit) : commit();
}
