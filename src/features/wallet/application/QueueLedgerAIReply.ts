import type { AIProfile } from '@features/assistants';
import type { WalletRecord } from '../domain/WalletRecord';
import {
  type TriggerLedgerAIReplyParams,
  type TriggerLedgerAIReplyResult,
} from './TriggerLedgerAIReply';

const LEDGER_AI_BATCH_WINDOW_MS = 5500;

export interface QueueLedgerAIReplyParams {
  record: WalletRecord;
}

export interface QueueLedgerAIReplyCallbacks {
  onError?: (error: Error) => void;
}

export interface QueueLedgerAIReplyResult {
  queued: boolean;
  aiId?: string;
  batchSize: number;
  reason?: string;
}

interface PendingLedgerBatch {
  recordIds: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface QueueLedgerAIReplyDeps {
  getLedgerAI: () => Promise<AIProfile | null>;
  getRecords: (ids: readonly string[]) => Promise<WalletRecord[]>;
  triggerReply: (params: TriggerLedgerAIReplyParams) => Promise<TriggerLedgerAIReplyResult>;
}

const pendingBatches = new Map<string, PendingLedgerBatch>();
const activeBatches = new Set<Promise<void>>();
let stopped = false;
let generation = 0;

/** 先关闭接纳并撤销旧准备阶段，再等待已派发任务；Host 同时负责取消其 Agent。 */
export async function stopLedgerAIReplyQueueForReset(): Promise<void> {
  stopped = true;
  generation += 1;
  for (const batch of pendingBatches.values()) {
    if (batch.timer) clearTimeout(batch.timer);
  }
  pendingBatches.clear();
  await Promise.allSettled([...activeBatches]);
}

export function resumeLedgerAIReplyQueueAfterReset(): void {
  stopped = false;
}

export async function queueLedgerAIReply(
  params: QueueLedgerAIReplyParams,
  callbacks: QueueLedgerAIReplyCallbacks = {},
  deps: QueueLedgerAIReplyDeps
): Promise<QueueLedgerAIReplyResult> {
  const queuedGeneration = generation;
  if (stopped) return { queued: false, batchSize: 0, reason: '记账回复队列已停止' };
  const ledgerAI = await deps.getLedgerAI();
  if (stopped || queuedGeneration !== generation) return { queued: false, batchSize: 0, reason: '记账回复队列已停止' };
  if (!ledgerAI) {
    return {
      queued: false,
      batchSize: 0,
      reason: '未设置记账 AI',
    };
  }

  if (!ledgerAI.apiKey || !ledgerAI.model) {
    return {
      queued: false,
      aiId: ledgerAI.id,
      batchSize: 0,
      reason: '记账 AI 缺少模型或 API Key 配置',
    };
  }

  const existingBatch = pendingBatches.get(ledgerAI.id);
  const batch: PendingLedgerBatch = existingBatch || {
    recordIds: new Set<string>(),
    timer: null,
  };

  batch.recordIds.add(params.record.id);

  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  batch.timer = setTimeout(() => {
    const task = flushLedgerAIReplyBatch(ledgerAI.id, callbacks, deps, queuedGeneration);
    activeBatches.add(task);
    void task.then(() => activeBatches.delete(task), error => {
      activeBatches.delete(task);
      console.warn('[queueLedgerAIReply] 批次失败：', error);
    });
  }, LEDGER_AI_BATCH_WINDOW_MS);

  pendingBatches.set(ledgerAI.id, batch);

  return {
    queued: true,
    aiId: ledgerAI.id,
    batchSize: batch.recordIds.size,
  };
}

async function flushLedgerAIReplyBatch(
  aiId: string,
  callbacks: QueueLedgerAIReplyCallbacks,
  deps: QueueLedgerAIReplyDeps,
  queuedGeneration: number,
): Promise<void> {
  const batch = pendingBatches.get(aiId);
  if (!batch) {
    return;
  }

  pendingBatches.delete(aiId);
  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  const isCurrent = () => !stopped && queuedGeneration === generation;
  let result: TriggerLedgerAIReplyResult;
  try {
    // 延迟窗口内可能更换角色或编辑、删除账目；派发只读取仍有效的当前输入。
    const aiProfile = await deps.getLedgerAI();
    if (!isCurrent() || aiProfile?.id !== aiId) return;
    const newRecords = await deps.getRecords([...batch.recordIds]);
    if (!isCurrent() || newRecords.length === 0) return;
    result = await deps.triggerReply({ aiProfile, newRecords });
  } catch (error) {
    if (isCurrent()) callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  if (!isCurrent()) return;

  if (!result.success && result.error) {
    callbacks.onError?.(new Error(result.error));
  }
}
