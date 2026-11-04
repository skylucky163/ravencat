import { useEffect, useSyncExternalStore } from 'react';
import { getBubbleSkinSnapshot, loadChatBubbleSkins, subscribeBubbleSkins } from '../application/ChatBubbleSkinRuntime';

const noSubscribe = () => () => {};
export function useChatBubbleSkins(enabled = true) {
  const state = useSyncExternalStore(enabled ? subscribeBubbleSkins : noSubscribe, getBubbleSkinSnapshot);
  useEffect(() => { if (enabled) void loadChatBubbleSkins(); }, [enabled]);
  return state;
}
