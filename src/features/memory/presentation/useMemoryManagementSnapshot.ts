/** 各管理路由订阅同一份业务事实；指定空间失效时不能落到另一个空间。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMemoryManagementSnapshot, type MemoryManagementSnapshot } from '../application/MemoryQueries';
import { subscribeMemoryChanged } from '../application/MemorySignals';

export default function useMemoryManagementSnapshot(assistantId?: string) {
  const [loaded, setLoaded] = useState<{
    assistantId?: string; snapshot: MemoryManagementSnapshot;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef({ revision: 0 });
  const load = useCallback(async () => {
    const revision = ++request.current.revision;
    try {
      const next = await getMemoryManagementSnapshot(assistantId);
      if (assistantId && next.selectedSpace?.assistantId !== assistantId) throw new Error('这个记忆空间已不存在');
      if (revision === request.current.revision) { setLoaded({ assistantId, snapshot: next }); setError(null); }
    } catch (failure) {
      if (revision === request.current.revision) { setLoaded(null); setError(failure instanceof Error ? failure.message : '读取记忆失败'); }
    } finally { if (revision === request.current.revision) setRefreshing(false); }
  }, [assistantId]);
  useEffect(() => {
    void load();
    const revisions = request.current;
    const unsubscribe = subscribeMemoryChanged(() => { void load(); });
    return () => { unsubscribe(); revisions.revision++; };
  }, [load]);
  const refresh = () => { setRefreshing(true); void load(); };
  // 切换空间时保留星空，但不能把上一空间的详情交给新面板。
  const snapshot = loaded && loaded.assistantId === assistantId ? loaded.snapshot : null;
  return { snapshot, spaces: loaded?.snapshot.spaces, error, refreshing, refresh };
}
