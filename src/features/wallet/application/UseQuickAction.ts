/** 使用已保存的快捷记账；手动使用可安排回复，AI 工具使用不再触发另一轮回复。 */
import type { ILedgerRepository } from '../domain/LedgerRepository';
import {
  submitWalletRecord,
  type WalletAIReplyCallbacks,
  type WalletAIReplyQueue,
  type WalletRecordSubmissionResult,
} from './WalletRecordSubmission';

export type { WalletAIReplyCallbacks as WalletQuickActionCallbacks } from './WalletRecordSubmission';

export interface UseQuickActionParams {
  quickActionId: string;
  recordDate?: string;
}

interface UseQuickActionDeps {
  repository: ILedgerRepository;
  queueAIReply?: WalletAIReplyQueue;
}

export async function applyQuickActionAndReply(
  params: UseQuickActionParams,
  callbacks: WalletAIReplyCallbacks = {},
  deps: UseQuickActionDeps
): Promise<WalletRecordSubmissionResult> {
  return submitWalletRecord(
    'applyQuickActionAndReply',
    () => deps.repository.useQuickAction(params.quickActionId, params.recordDate),
    callbacks,
    deps.queueAIReply
  );
}
