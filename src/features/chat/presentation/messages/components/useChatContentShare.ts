/** 分享窗口持有本次内容和提交身份；取消及迟到结果不触碰来源页面草稿。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ToastAndroid } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { listChatShareTargets, shareChatContent, type ChatShareTarget } from '../../../messages/application/ShareChatMessages';
import type { SharedContent } from '../../../messages/domain/SharedContent';

export function useChatContentShare({ ownerKey, isActive = true, onShared }: {
  ownerKey: string | undefined; isActive?: boolean; onShared(): void;
}) {
  const [visible, setVisible] = useState(false);
  const [content, setContent] = useState<SharedContent | null>(null);
  const [targets, setTargets] = useState<ChatShareTarget[]>([]);
  const [target, setTarget] = useState<ChatShareTarget | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [fixedTarget, setFixedTarget] = useState(false);
  const request = useRef<object | null>(null);
  const sendingRef = useRef(false);
  const clientMessageId = useRef('');
  const close = useCallback(() => {
    if (sendingRef.current) return;
    request.current = null;
    setVisible(false);
  }, []);
  useEffect(() => {
    request.current = null;
    sendingRef.current = false;
    setVisible(false);
    setSending(false);
    return () => { request.current = null; };
  }, [ownerKey, isActive]);

  const open = useCallback(async (prepare: () => Promise<SharedContent>, options?: { excludeTarget?: { kind: 'direct' | 'group'; id: string }; target?: ChatShareTarget }) => {
    const token = {};
    request.current = token;
    setVisible(true); setContent(null); setTarget(options?.target ?? null); setComment(''); setError(null); setLoading(true);
    setFixedTarget(options?.target !== undefined);
    clientMessageId.current = randomUUID();
    try {
      const [snapshot, destinations] = await Promise.all([prepare(), options?.target ? Promise.resolve([]) : listChatShareTargets()]);
      if (request.current !== token) return;
      setContent(snapshot);
      setTargets(destinations.filter(destination => destination.kind !== options?.excludeTarget?.kind || destination.id !== options.excludeTarget.id));
    } catch (failure) {
      if (request.current === token) setError(failure instanceof Error ? failure.message : '加载分享内容失败');
    } finally {
      if (request.current === token) setLoading(false);
    }
  }, []);
  const choose = useCallback((destination: ChatShareTarget | null) => {
    setTarget(destination); setError(null); clientMessageId.current = randomUUID();
  }, []);
  const send = useCallback(async () => {
    if (sendingRef.current) return;
    const token = request.current;
    sendingRef.current = true; setSending(true); setError(null);
    try {
      const result = await shareChatContent({ target: target!, content: content!, comment, clientMessageId: clientMessageId.current });
      if (request.current !== token) return;
      sendingRef.current = false; setSending(false);
      setVisible(false); request.current = null; onShared();
      ToastAndroid.show(result.warning ?? `已分享给${target!.name}`, result.warning ? ToastAndroid.LONG : ToastAndroid.SHORT);
    } catch (failure) {
      if (request.current === token) setError(failure instanceof Error ? failure.message : '分享失败');
    } finally {
      if (request.current === token) { sendingRef.current = false; setSending(false); }
    }
  }, [target, content, comment, onShared]);
  return { visible, content, targets, target, comment, error, loading, sending, fixedTarget, open, close, choose, setComment, send };
}
