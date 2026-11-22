import type { ChatMessage } from './ChatMessage';
import { parseMessageMetadata } from './chatMessageMetadata';

export type AssistantRoleApplication = 'ledger' | 'host';
export type RoleApplicationStatus = 'pending' | 'accepted' | 'declined';

export interface RoleApplicationCardMetadata {
  type: 'roleApplication';
  role: AssistantRoleApplication;
  applicantId: string;
  incumbentId: string | null;
  incumbentName: string | null;
  cooldownEndAt: string | null;
  decision: RoleApplicationStatus;
}

export function roleApplicationTitle(role: AssistantRoleApplication) {
  return role === 'ledger' ? '申请成为记账 AI' : '申请成为主理 AI';
}

export function readRoleApplicationCard(message: ChatMessage): RoleApplicationCardMetadata | null {
  if (message.senderType !== 'assistant' || !message.clientMessageId?.startsWith('role-application:')) return null;
  const metadata = parseMessageMetadata(message) as Partial<RoleApplicationCardMetadata> | null;
  if (metadata?.type !== 'roleApplication' || (metadata.role !== 'ledger' && metadata.role !== 'host')
    || typeof metadata.applicantId !== 'string'
    || (metadata.incumbentId !== null && typeof metadata.incumbentId !== 'string')
    || (metadata.incumbentName !== null && typeof metadata.incumbentName !== 'string')
    || (metadata.cooldownEndAt !== null && (typeof metadata.cooldownEndAt !== 'string' || !Number.isFinite(Date.parse(metadata.cooldownEndAt))))
    || (metadata.decision !== 'pending' && metadata.decision !== 'accepted' && metadata.decision !== 'declined')) return null;
  return metadata as RoleApplicationCardMetadata;
}
