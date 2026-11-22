/** 搜索结果按行直接收藏：收藏身份按消息批量读取，每行只读一次，写入期间拒绝重复提交。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ToastAndroid } from 'react-native';
import { showAppDialog } from '@shared/ui';
import { createChatFavorite, listChatFavoriteRefs, removeChatFavorite } from '../../../favorites/application/ChatFavorites';
import type { ChatMessageRecord, ChatSearchRecord } from '../../../messages/domain/ChatMessageSearch';

export function useSearchResultFavorites(
  records: readonly ChatSearchRecord[] | null,
  sourceName: string,
  assistantId?: string,
) {
  const [favorites, setFavorites] = useState<ReadonlyMap<number, string>>(() => new Map());
  const pending = useRef(new Set<number>());
  const requested = useRef(new Set<number>());
  const messageIds = useMemo(() => (records ?? []).flatMap(record => 'messageId' in record ? [record.messageId] : []), [records]);

  useEffect(() => {
    // 分页只追加新行；已展示的行保持本地写入结果，不被迟到的读取覆盖。
    const fresh = messageIds.filter(messageId => !requested.current.has(messageId));
    if (fresh.length === 0) return;
    for (const messageId of fresh) requested.current.add(messageId);
    let active = true;
    void listChatFavoriteRefs(fresh).then(refs => {
      if (!active) return;
      setFavorites(previous => {
        const next = new Map(previous);
        for (const ref of refs) next.set(ref.sourceMessageId, ref.id);
        return next;
      });
    }).catch((error: unknown) => {
      if (active) showAppDialog({ title: '收藏状态加载失败', message: error instanceof Error ? error.message : '无法读取收藏状态', tone: 'error' });
    });
    return () => { active = false; };
  }, [messageIds]);

  const toggle = useCallback(async (record: ChatMessageRecord) => {
    if (pending.current.has(record.messageId)) return;
    pending.current.add(record.messageId);
    const favoriteId = favorites.get(record.messageId);
    try {
      if (favoriteId) {
        await removeChatFavorite(favoriteId);
        setFavorites(previous => {
          const next = new Map(previous);
          next.delete(record.messageId);
          return next;
        });
        ToastAndroid.show('已取消收藏', ToastAndroid.SHORT);
      } else {
        const favorite = await createChatFavorite({ messageId: record.messageId, sourceName, assistantId });
        setFavorites(previous => new Map(previous).set(record.messageId, favorite.id));
        ToastAndroid.show('已收藏', ToastAndroid.SHORT);
      }
    } catch (error) {
      showAppDialog({
        title: favoriteId ? '取消收藏失败' : '收藏失败',
        message: error instanceof Error ? error.message : '无法更新收藏状态', tone: 'error',
      });
    } finally {
      pending.current.delete(record.messageId);
    }
  }, [favorites, sourceName, assistantId]);

  return { favorites, toggle };
}
