/** 管理 Chat shell 使用的 AI 助手列表状态。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AIProfile } from '@features/assistants';
import {
  deleteAIAssistant,
  listAIAssistants,
  subscribeAIAssistantUpdated,
  subscribeAssistantLifecycleChanged,
} from '@features/assistants';
import { withArrivedConversationPreview } from './arrivedConversationPreview';
import { getAssistantMessageArrivalSnapshot } from '../../reply/delivery/AssistantMessageArrival';

export default function useAIAssistants() {
  const [aiList, setAiList] = useState<AIProfile[]>([]);
  const [aiListReady, setAiListReady] = useState(false);
  const loadFlightRef = useRef<Promise<AIProfile[]> | null>(null);
  const profilesRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);

  const loadAIAssistants = useCallback(() => {
    previewRevisionRef.current++;
    if (loadFlightRef.current) return loadFlightRef.current;

    const loadFlight = (async () => {
      let profilesRevision = profilesRevisionRef.current;
      let profiles = await listAIAssistants();
      while (true) {
        // 到达进度只影响预览；只有已提交的助手资料变化才作废包含头像解析的完整列表读取。
        if (profilesRevision !== profilesRevisionRef.current) {
          profilesRevision = profilesRevisionRef.current;
          profiles = await listAIAssistants();
          continue;
        }
        const arrival = getAssistantMessageArrivalSnapshot();
        const previewRevision = previewRevisionRef.current;
        const list = await Promise.all(profiles.map((profile) => withArrivedConversationPreview(profile, profile.canonicalConversationId)));
        // 正文交付不推进原生 canonical 到达版本；读取期间的新交付同样必须使旧结果失效。
        if (previewRevision !== previewRevisionRef.current || profilesRevision !== profilesRevisionRef.current || arrival !== getAssistantMessageArrivalSnapshot()) continue;
        setAiList(list);
        setAiListReady(true);
        return list;
      }
    })();
    loadFlightRef.current = loadFlight;
    const clearFlight = () => {
      if (loadFlightRef.current === loadFlight) {
        loadFlightRef.current = null;
      }
    };
    void loadFlight.then(clearFlight, clearFlight);
    return loadFlight;
  }, []);

  useEffect(() => {
    const refresh = () => {
      // 已提交的资料让旧列表读取失效，新读取继续复用消息到达快照的既有投影。
      profilesRevisionRef.current++;
      void loadAIAssistants().catch(error => console.error('[Chat] 助手资料更新后列表刷新失败：', error));
    };
    const unsubscribeUpdated = subscribeAIAssistantUpdated(refresh);
    const unsubscribeLifecycle = subscribeAssistantLifecycleChanged(refresh);
    return () => { unsubscribeUpdated(); unsubscribeLifecycle(); };
  }, [loadAIAssistants]);

  const removeAIAssistant = useCallback(async (aiId: string) => {
    await deleteAIAssistant(aiId);
    await loadAIAssistants();
  }, [loadAIAssistants]);

  return {
    aiList,
    aiListReady,
    loadAIAssistants,
    removeAIAssistant,
    setAiList,
  };
}
