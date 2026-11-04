/**
 * 标注队列的轻量唤醒信号。
 *
 * 它只通知“可能存在 pending 任务”，不承载任务数据，也不负责并发执行；Host
 * 收到信号后仍必须通过 claim 事务选出唯一 winner，并由自己的前台生命周期控制器
 * 决定是否启动单任务。
 */

export type StickerAnnotationPendingListener = () => void;

const listeners = new Set<StickerAnnotationPendingListener>();
const policyListeners = new Set<(enabled: boolean) => void>();

export function subscribeStickerAutomaticRecognitionChanged(listener: (enabled: boolean) => void): () => void {
  policyListeners.add(listener);
  return () => { policyListeners.delete(listener); };
}

export function emitStickerAutomaticRecognitionChanged(enabled: boolean): void {
  for (const listener of policyListeners) listener(enabled);
}

export function subscribeStickerAnnotationPending(
  listener: StickerAnnotationPendingListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitStickerAnnotationPending(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // 唤醒信号发生在业务 commit 后，consumer 异常不能改写已经提交的事实。
      console.warn('[Sticker] 标注队列唤醒订阅方执行失败：', error);
    }
  }
}
