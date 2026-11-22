/** 跟随持久重写状态，正文交接由消息列表在新正文到达时呈现。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ToastAndroid } from 'react-native';
import { getChatRegenerationState, regenerateChatReply } from '../../../reply/application/RegenerateChatReply';
import { subscribeAssistantMessageArrival } from '../../../reply/delivery/AssistantMessageArrival';
import type { ChatRegenerationState } from '../../../reply/domain/ConversationTurn';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import { setChatEventBus } from '../../../messages/events/ChatEvents';

const IDLE: ChatRegenerationState = { versionedRunIds: [], eligibleRunId: null, sourceRunId: null, hiddenMessageIds: [] };

export function useChatRegeneration(sessionId: string | undefined, refresh: () => Promise<void>) {
  const [state, setState] = useState(IDLE);
  const stateRef = useRef(state);
  const requesting = useRef<{ sessionId: string } | null>(null);
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  stateRef.current = state;

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let syncing: Promise<void> | null = null;
    setState(IDLE);
    if (!sessionId) return;
    const sync = (): Promise<void> => {
      revision++;
      if (syncing) return syncing;
      // 同批事件共用一次读取；在途发生的新事实只补读最新状态，不把作废查询堆入数据库队列。
      syncing = Promise.resolve().then(async () => {
        while (!disposed) {
          const expectedRevision = revision;
          try {
            const next = await getChatRegenerationState(sessionId);
            if (disposed) return;
            if (expectedRevision !== revision) continue;
            // 替换成功后的数据库刷新先于解除隐藏，避免旧 cache 在交接空窗闪回。
            const shouldRefresh = Boolean(stateRef.current.sourceRunId && !next.sourceRunId);
            try {
              if (shouldRefresh) await refresh();
            } finally {
              if (!disposed && expectedRevision === revision) setState(next);
            }
          } catch (error) {
            console.error('[useChatRegeneration] 读取重写状态失败', error);
          }
          if (expectedRevision === revision) break;
        }
      }).finally(() => { syncing = null; });
      return syncing;
    };
    const unsubscribe = setChatEventBus({
      emit: async (name, payload) => {
        if (payload.sessionId !== sessionId || name === 'typingStatusChanged' || name === 'groupSpeechPlanChanged') return;
        await sync();
        if (!disposed && payload.regenerationError) ToastAndroid.show(payload.regenerationError, ToastAndroid.LONG);
      },
    });
    void sync();
    // 重写可能在宿主侧 runtime 完成：本地事件总线收不到对端事件，而原生到达端口
    // 是每个 runtime 都能收到的跨进程信号。仅隐藏期间重读，避免逐段到达时反复刷库。
    const unsubscribeArrival = subscribeAssistantMessageArrival(() => {
      if (stateRef.current.sourceRunId) void sync();
    });
    return () => { disposed = true; unsubscribe(); unsubscribeArrival(); };
  }, [sessionId, refresh]);

  const regenerate = useCallback(async (message: ChatMessage, messages: ChatMessage[]) => {
    if (!sessionId || requesting.current?.sessionId === sessionId) return;
    const request = { sessionId };
    requesting.current = request;
    setState({
      versionedRunIds: stateRef.current.versionedRunIds,
      eligibleRunId: null,
      sourceRunId: message.turnRunId!,
      hiddenMessageIds: messages.filter((item) => item.turnRunId === message.turnRunId && item.turnItemIndex != null).map((item) => item.id),
    });
    try {
      await regenerateChatReply(sessionId, message.id);
    } catch (error) {
      if (activeSession.current !== sessionId || requesting.current !== request) return;
      setState(current => ({ ...IDLE, versionedRunIds: current.versionedRunIds }));
      ToastAndroid.show(error instanceof Error ? error.message : '无法启动重写', ToastAndroid.LONG);
    } finally {
      if (requesting.current === request) requesting.current = null;
    }
  }, [sessionId]);

  return { ...state, regenerate };
}
