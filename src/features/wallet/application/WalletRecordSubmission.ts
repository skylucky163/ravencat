/** 账单写入后的公共收尾：只有写入失败才返回失败，排队失败不撤销已写入账单。 */
import type { WalletRecord } from '../domain/WalletRecord';
import {
  queueLedgerAIReply,
  type QueueLedgerAIReplyCallbacks,
} from './QueueLedgerAIReply';

export type WalletAIReplyCallbacks = QueueLedgerAIReplyCallbacks;

export interface WalletRecordSubmissionResult {
  success: boolean;
  record: WalletRecord | null;
  queuedAIReply: boolean;
  error: string | null;
}

/** 手动记账由 composition 注入排队依赖；AI 工具写入不安排额外回复。 */
export type WalletAIReplyQueue = (
  params: Parameters<typeof queueLedgerAIReply>[0],
  callbacks: Parameters<typeof queueLedgerAIReply>[1]
) => ReturnType<typeof queueLedgerAIReply>;

export async function submitWalletRecord(
  label: string,
  writeRecord: () => Promise<WalletRecord>,
  callbacks: WalletAIReplyCallbacks,
  queueAIReply?: WalletAIReplyQueue
): Promise<WalletRecordSubmissionResult> {
  try {
    const record = await writeRecord();

    let queuedAIReply = false;
    try {
      if (queueAIReply) {
        queuedAIReply = (await queueAIReply({ record }, callbacks)).queued;
      }
    } catch (queueError) {
      console.warn(`[${label}] Failed to queue ledger AI reply:`, queueError);
      if (queueError instanceof Error) {
        callbacks.onError?.(queueError);
      }
    }

    return { success: true, record, queuedAIReply, error: null };
  } catch (error) {
    console.error(`[${label}] Failed:`, error);
    return {
      success: false,
      record: null,
      queuedAIReply: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
