/** 前台空闲期的 Sticker 结构化标注队列；同一进程内始终只有一个模型任务。 */

import { InteractionManager } from 'react-native';
import {
  claimStickerAnnotation,
  completeStickerAnnotation,
  failStickerAnnotation,
  recoverInterruptedStickerAnnotations,
  releaseStickerAnnotation,
  subscribeStickerAnnotationPending,
  subscribeStickerAutomaticRecognitionChanged,
  StickerAnnotationClaimLostError,
} from '@features/stickers';
import { createStickerAnnotationExecutor } from '../composition/StickerAnnotationModelGateway';

type ScheduledInteraction = ReturnType<typeof InteractionManager.runAfterInteractions>;

let configured = false;
let initialized = false;
let initialization: Promise<void> | null = null;
let foregroundActive = false;
let scheduled: ScheduledInteraction | null = null;
let running: Promise<void> | null = null;
let activeAbortController: AbortController | null = null;
let activeManual = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知识别错误');
}

function settleRunning(task: Promise<boolean>): void {
  running = task.then(
    (shouldContinue) => {
      running = null;
      if (shouldContinue) requestStickerAnnotationRun();
    },
    (error) => {
      running = null;
      if (error instanceof StickerAnnotationClaimLostError) { requestStickerAnnotationRun(); return; }
      console.warn('[Sticker] 前台标注任务异常退出：', error);
    },
  );
}

async function runOneStickerAnnotation(): Promise<boolean> {
  if (!foregroundActive || !initialized) return false;

  // 先确认模型可用再 claim，避免没有模型时把持久任务留在 processing。
  const execute = await createStickerAnnotationExecutor();
  if (!execute || !foregroundActive) return false;

  const claim = await claimStickerAnnotation();
  if (!claim || !foregroundActive) {
    if (claim) {
      await releaseStickerAnnotation({ stickerId: claim.sticker.id, claimId: claim.claimId });
    }
    return false;
  }

  const abortController = new AbortController();
  activeAbortController = abortController;
  activeManual = claim.manual;
  try {
    const metadata = await execute(claim.sticker, abortController.signal);
    if (abortController.signal.aborted || !foregroundActive) {
      await releaseStickerAnnotation({ stickerId: claim.sticker.id, claimId: claim.claimId });
      return false;
    }
    await completeStickerAnnotation({
      stickerId: claim.sticker.id,
      claimId: claim.claimId,
      metadata,
    });
    return true;
  } catch (error) {
    if (error instanceof StickerAnnotationClaimLostError) throw error;
    if (abortController.signal.aborted || !foregroundActive) {
      await releaseStickerAnnotation({ stickerId: claim.sticker.id, claimId: claim.claimId });
      return false;
    }
    await failStickerAnnotation({
      stickerId: claim.sticker.id,
      claimId: claim.claimId,
      error: errorMessage(error),
    });
    return true;
  } finally {
    if (activeAbortController === abortController) activeAbortController = null;
  }
}

export function configureStickerAnnotationQueue(): void {
  if (configured) return;
  configured = true;
  subscribeStickerAnnotationPending(requestStickerAnnotationRun);
  subscribeStickerAutomaticRecognitionChanged(enabled => {
    if (!enabled && !activeManual) activeAbortController?.abort();
    requestStickerAnnotationRun();
  });
}

/** DB 初始化完成后回收上个 JS 进程遗留的 processing，再异步进入空闲调度。 */
export function initializeStickerAnnotationQueue(): Promise<void> {
  if (initialized) {
    requestStickerAnnotationRun();
    return Promise.resolve();
  }
  if (initialization) return initialization;

  initialization = recoverInterruptedStickerAnnotations().then(
    () => {
      initialized = true;
      initialization = null;
      requestStickerAnnotationRun();
    },
    (error) => {
      initialization = null;
      throw error;
    },
  );
  return initialization;
}

export function setStickerAnnotationForegroundActive(active: boolean): void {
  foregroundActive = active;
  if (!active) {
    scheduled?.cancel();
    scheduled = null;
    activeAbortController?.abort();
    return;
  }
  requestStickerAnnotationRun();
}

export function requestStickerAnnotationRun(): void {
  if (!configured || !initialized || !foregroundActive || scheduled || running) return;
  scheduled = InteractionManager.runAfterInteractions(() => {
    scheduled = null;
    if (!foregroundActive) return;
    settleRunning(runOneStickerAnnotation());
  });
}

/** 恢复出厂前终止模型调用并等待 claim 回到 pending，避免清库期间仍有写入。 */
export async function stopStickerAnnotationQueueForReset(): Promise<void> {
  setStickerAnnotationForegroundActive(false);
  if (initialization) await initialization;
  if (running) await running;
}
