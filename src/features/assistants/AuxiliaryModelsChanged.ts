/** 模型事实提交后通知 Host 重读配置，事件不携带凭据或另一份配置。 */
const listeners = new Set<() => void>();
export function subscribeAuxiliaryModelsChanged(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function emitAuxiliaryModelsChanged(): boolean {
  let refreshed = true;
  for (const listener of listeners) {
    try { listener(); }
    catch {
      // 事实已经提交；一个投影异常不能阻断其他消费者，也不输出可能含凭据的异常。
      refreshed = false;
      console.warn('[辅助模型] 提交后的变更监听器执行失败');
    }
  }
  return refreshed;
}
