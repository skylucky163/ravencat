/**
 * 前台空闲期的 Sticker 向量索引队列；与标注队列同构，同一进程内始终只有一个
 * 批次任务。建索引失败不触碰 Sticker ready 状态，也不写入半条向量——
 * 单条向量通过事务 upsert 原子落库，网络请求一律在事务之外。
 */

import { InteractionManager } from 'react-native';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { subscribeAuxiliaryModelsChanged } from '@features/assistants';
import { syncStickerEmbeddingModel } from '@features/stickers/composition';
import {
  generateStickerEmbeddingBatch,
  STICKER_EMBEDDING_BATCH_SIZE,
  subscribeStickerEmbeddingPending,
} from '@features/stickers';

type ScheduledInteraction = ReturnType<typeof InteractionManager.runAfterInteractions>;

let configured = false;
let scheduled: ScheduledInteraction | null = null;
let running: Promise<void> | null = null;
let activeAbortController: AbortController | null = null;
const maintenanceControllers = new Set<AbortController>();
let active = false;
let refreshingModel = 0;
let modelRefresh: Promise<void> = Promise.resolve();

/** 模型选择和整批发布共享维护边界；取消自动批次后等待它退出。 */
export function updateStickerEmbeddingModel<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  refreshingModel++;
  activeAbortController?.abort();
  maintenanceControllers.forEach(value => value.abort());
  scheduled?.cancel(); scheduled = null;
  const controller = new AbortController();
  maintenanceControllers.add(controller);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const result = modelRefresh.then(async () => {
    if (running) await running;
    throwIfAbortSignalAborted(controller.signal);
    return operation(controller.signal);
  });
  modelRefresh = result.then(() => {}, () => {});
  return result.finally(() => { maintenanceControllers.delete(controller); signal?.removeEventListener('abort', abort); refreshingModel--; requestStickerEmbeddingRun(); });
}
function settleRunning(task: Promise<number>): void {
  running = task.then(
    (embeddedCount) => {
      running = null;
      // 还有剩余待建向量时继续排队；模型未配置时 generate 返回 0 并自然待机。
      if (embeddedCount > 0) requestStickerEmbeddingRun();
    },
    (error) => {
      running = null;
      console.warn('[Sticker] 向量索引批次异常退出：', error);
    },
  );
}

async function runOneEmbeddingBatch(): Promise<number> {
  if (!configured) return 0;
  const abortController = new AbortController();
  activeAbortController = abortController;
  try {
    const { embeddedCount, failedCount = 0 } = await generateStickerEmbeddingBatch({
      batchSize: STICKER_EMBEDDING_BATCH_SIZE,
      signal: abortController.signal,
    });
    // 已保存的失败项不会再次领取；继续处理队列里的其他表情。
    return embeddedCount + failedCount;
  } finally {
    if (activeAbortController === abortController) activeAbortController = null;
  }
}

export function configureStickerEmbeddingQueue(): void {
  if (configured) return;
  configured = true;
  subscribeStickerEmbeddingPending(requestStickerEmbeddingRun);
  subscribeAuxiliaryModelsChanged(() => {
    void updateStickerEmbeddingModel(syncStickerEmbeddingModel).catch(error => console.error('[Sticker] 向量模型刷新失败', error));
  });
}

export function requestStickerEmbeddingRun(): void {
  if (!configured || !active || refreshingModel || scheduled || running) return;
  scheduled = InteractionManager.runAfterInteractions(() => {
    scheduled = null;
    settleRunning(runOneEmbeddingBatch());
  });
}

/** App 退后台 / 失去前台时中止当前批次；已 upsert 的向量是完整事实，无需回滚。 */
export function setStickerEmbeddingForegroundActive(value: boolean): void {
  active = value;
  if (!value) {
    scheduled?.cancel();
    scheduled = null;
    activeAbortController?.abort();
    maintenanceControllers.forEach(value => value.abort());
  }
}

/** 恢复出厂前终止批次任务，避免清库期间仍写入向量。 */
export async function stopStickerEmbeddingQueueForReset(): Promise<void> {
  setStickerEmbeddingForegroundActive(false);
  if (running) await running;
  await modelRefresh;
}
