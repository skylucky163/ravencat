/** 请求活动由执行用例持有；UI 收到通知后重读持久事实。 */
import type { StickerEmbeddingActivity } from '../domain/StickerProcessing';
import { subscribeStickerAnnotationChanged } from './StickerAnnotationChangedSignal';

const listeners = new Set<() => void>();
let embeddingActivity: StickerEmbeddingActivity | null = null;

export function getStickerEmbeddingActivity(): StickerEmbeddingActivity | null {
  return embeddingActivity;
}

export function setStickerEmbeddingActivity(activity: StickerEmbeddingActivity | null): void {
  embeddingActivity = activity;
  emitStickerProcessingChanged();
}

export function emitStickerProcessingChanged(): void {
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.warn('[Sticker] 处理进度订阅失败：', error); }
  }
}

export function subscribeStickerProcessingChanged(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = subscribeStickerAnnotationChanged(listener);
  return () => { listeners.delete(listener); unsubscribe(); };
}
