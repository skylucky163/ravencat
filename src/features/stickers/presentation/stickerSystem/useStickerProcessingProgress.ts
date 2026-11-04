/** 可见页面通过事实通知刷新；计时显示不轮询数据库，也不驱动任务执行。 */
import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getStickerProcessingProgress } from '../../application/StickerProcessing';
import { subscribeStickerProcessingChanged } from '../../application/StickerProcessingSignal';
import type { StickerProcessingProgress } from '../../domain/StickerProcessing';

export function useStickerProcessingProgress() {
  const [progress, setProgress] = useState<StickerProcessingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const revision = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  // 等待者复用在途读取；通知先推进版本，迟到结果不能覆盖新事实，必要时尾随再读。
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const current = revision.current;
    const request = getStickerProcessingProgress()
      .then(next => {
        if (active.current && current === revision.current) {
          setProgress(next);
          setError(null);
        }
      })
      .catch(cause => {
        if (active.current && current === revision.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (inFlight.current === request) inFlight.current = null;
        if (active.current && current !== revision.current) void refresh();
      });
    inFlight.current = request;
    return request;
  }, []);

  useFocusEffect(useCallback(() => {
    active.current = true;
    const invalidate = () => {
      revision.current += 1;
      void refresh();
    };
    const unsubscribe = subscribeStickerProcessingChanged(invalidate);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') invalidate(); });
    invalidate();
    return () => {
      active.current = false;
      revision.current += 1;
      unsubscribe();
      subscription.remove();
    };
  }, [refresh]));
  return { progress, error, refresh };
}
