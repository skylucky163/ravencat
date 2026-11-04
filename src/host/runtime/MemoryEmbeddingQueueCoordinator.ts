/** 前台单任务调度器；数据库保存尝试次数，重启与前后台切换不会重置失败预算。 */
import { showAppDialog } from '@shared/ui/appDialogStore';
import { InteractionManager } from 'react-native';
import { subscribeMemoryChanged } from '@features/memory';
import { emitMemoryChanged, processNextMemoryEmbedding } from '@features/memory/composition';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';

let configured = false;
let active = false;
let running: Promise<void> | null = null;
let controller: AbortController | null = null;
let scheduled: ReturnType<typeof InteractionManager.runAfterInteractions> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let requested = false;
let modelRefresh: Promise<void> = Promise.resolve();
let refreshingModel = 0;
const maintenanceControllers = new Set<AbortController>();
let failureReported = false;
let failureDialogPending = false;

function reportEmbeddingFailure(): void {
  // 同一轮连续任务只提醒一次；已有提示未关闭时，后续轮次也不追加相同弹窗。
  if (failureReported) return;
  failureReported = true;
  if (failureDialogPending) return;
  failureDialogPending = true;
  const dismiss = () => { failureDialogPending = false; };
  showAppDialog({
    title: '记忆向量更新失败',
    message: '部分记忆向量生成失败，已停止自动尝试。记忆正文已经保存，可在记忆页查看原因并手动重试；如模型配置有误，可先关闭记忆向量化或更换向量模型。',
    tone: 'error',
    onDismiss: dismiss,
    buttons: [{ text: '知道了', onPress: dismiss }],
  });
}

/** 选择、清除和显式重建共享维护边界；取消并等待旧请求后才开始新操作。 */
export function updateMemoryEmbeddingModel<T>(update: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  refreshingModel++;
  controller?.abort();
  maintenanceControllers.forEach(value => value.abort());
  scheduled?.cancel(); scheduled = null;
  const taskController = new AbortController();
  maintenanceControllers.add(taskController);
  const abort = () => taskController.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const result = modelRefresh.then(async () => {
    if (running) await running;
    throwIfAbortSignalAborted(taskController.signal);
    const value = await update(taskController.signal);
    failureReported = false;
    emitMemoryChanged();
    return value;
  });
  modelRefresh = result.then(() => {}, () => {});
  return result.finally(() => { maintenanceControllers.delete(taskController); signal?.removeEventListener('abort', abort); refreshingModel--; requestMemoryEmbeddingRun(); });
}

export function refreshMemoryEmbeddingModel(): void {
  void updateMemoryEmbeddingModel(async () => {}).catch((error: unknown) => {
    console.error('[Memory] 模型配置刷新失败', error);
  });
}

export function configureMemoryEmbeddingQueue(): void {
  if (configured) return;
  configured = true;
  subscribeMemoryChanged(requestMemoryEmbeddingRun);
}
export function requestMemoryEmbeddingRun(): void {
  if (!configured || !active) return;
  requested = true;
  if (running || scheduled || refreshingModel) return;
  if (timer) { clearTimeout(timer); timer = null; }
  scheduled = InteractionManager.runAfterInteractions(() => {
    scheduled = null;
    requested = false;
    controller = new AbortController();
    const signal = controller.signal;
    running = processNextMemoryEmbedding(signal).then((result) => {
      if (!signal.aborted) {
        if (!result.processed) failureReported = false;
        if (result.failedMemoryId && active) reportEmbeddingFailure();
      }
      if (result.processed) requested = true;
      if (result.nextWakeAt && active) timer = setTimeout(requestMemoryEmbeddingRun, Math.max(0, Date.parse(result.nextWakeAt) - Date.now()));
    }).catch((error: unknown) => {
      if (!signal.aborted) console.error('[Memory] 向量任务执行失败', error);
    }).finally(() => {
      running = null; controller = null;
      if (requested && active) requestMemoryEmbeddingRun();
    });
  });
}
export function setMemoryEmbeddingForegroundActive(value: boolean): void {
  active = value;
  if (active) requestMemoryEmbeddingRun();
  else {
    scheduled?.cancel(); scheduled = null;
    if (timer) clearTimeout(timer);
    timer = null; requested = false; controller?.abort(); maintenanceControllers.forEach(value => value.abort());
  }
}
export async function stopMemoryEmbeddingQueueForReset(): Promise<void> {
  setMemoryEmbeddingForegroundActive(false);
  if (running) await running;
  await modelRefresh;
  failureReported = false;
  failureDialogPending = false;
}
