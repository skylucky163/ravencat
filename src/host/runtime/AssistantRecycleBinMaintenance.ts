/** 一个到期时钟服务所有回收 AI；启动和前台恢复沿用同一持久清理命令。 */
import { AppState } from 'react-native';
import { purgeExpiredAIAssistants, subscribeAssistantLifecycleChanged } from '@features/assistants';
import { getNextAIRecycleBinExpiry } from '@features/assistants/composition';

export function startAssistantRecycleBinMaintenance(trackTask: (task: Promise<void>) => Promise<void>): () => void {
  let stopped = false;
  let requested = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = () => {
    requested = true;
    if (running || stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    running = trackTask((async () => {
      while (requested && !stopped) {
        requested = false;
        await purgeExpiredAIAssistants();
        const expiresAt = await getNextAIRecycleBinExpiry();
        if (stopped) return;
        if (timer !== null) clearTimeout(timer);
        timer = expiresAt === null ? null : setTimeout(request, Math.max(0, expiresAt - Date.now()));
      }
    })()).catch(error => { console.error('[AI 回收站] 到期清理失败：', error); }).finally(() => { running = null; });
  };
  const unsubscribe = subscribeAssistantLifecycleChanged(request);
  const foreground = AppState.addEventListener('change', state => { if (state === 'active') request(); });
  request();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
    foreground.remove();
  };
}
