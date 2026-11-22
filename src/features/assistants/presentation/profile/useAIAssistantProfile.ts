/** 按助手 ID 读取资料；提交事实优先于读取开始时的快照。 */
import { useCallback, useEffect, useState } from 'react';
import { getAIAssistantById, subscribeAIAssistantUpdated, subscribeAssistantLifecycleChanged } from '../../AIAssistantManagement';
import type { AIProfile } from '../../domain/AIProfile';

export function useAIAssistantProfile(aiId: string) {
  const [assistant, setAssistant] = useState<AIProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const reload = useCallback(() => setReloadRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    setLoading(true);
    setError(false);
    const unsubscribe = subscribeAIAssistantUpdated(updated => {
      if (updated.id !== aiId) return;
      receivedUpdate = true;
      setAssistant(updated);
      setError(false);
    });
    const unsubscribeLifecycle = subscribeAssistantLifecycleChanged(event => {
      if (event.assistantId !== aiId) return;
      if (event.change === 'restored') reload();
      else { receivedUpdate = true; setAssistant(null); }
    });
    void getAIAssistantById(aiId).then(value => {
      if (active && !receivedUpdate) setAssistant(value);
    }).catch(() => { if (active && !receivedUpdate) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); unsubscribeLifecycle(); };
  }, [aiId, reload, reloadRevision]);

  return { assistant, loading, error, reload };
}
