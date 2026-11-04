/** 单聊与群聊共用消息表情的用户收藏操作，菜单状态始终来自用户库。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ToastAndroid } from 'react-native';
import { addStickerFromMessage, isStickerInUserLibrary } from '@features/stickers';
import { showAppDialog } from '@shared/ui';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import { getMessageSticker } from '../../../messages/domain/chatMessageMetadata';

export interface ChatStickerAction {
  isAdded: boolean;
  add?: () => void;
}

export function useChatStickerAction(message: ChatMessage | null): ChatStickerAction | null {
  const sticker = useMemo(() => getMessageSticker(message), [message]);
  const mediaAssetId = sticker?.mediaAssetId;
  const saving = useRef(false);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ mediaAssetId: string; isAdded: boolean } | null>(null);

  useEffect(() => {
    setLoaded(null);
    if (!mediaAssetId || saving.current) return;
    let active = true;
    void isStickerInUserLibrary(mediaAssetId).then(isAdded => {
      if (active) setLoaded({ mediaAssetId, isAdded });
    }).catch((error: unknown) => {
      if (active) showAppDialog({ title: '表情包状态加载失败', message: error instanceof Error ? error.message : '无法读取表情包状态', tone: 'error' });
    });
    return () => { active = false; };
  }, [mediaAssetId, revision]);

  const add = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    setLoaded(null);
    try {
      const result = await addStickerFromMessage(sticker!);
      ToastAndroid.show(result.reused ? '已添加' : '已添加到表情包', ToastAndroid.SHORT);
    } catch (error) {
      showAppDialog({ title: '添加表情包失败', message: error instanceof Error ? error.message : '无法添加表情包', tone: 'error' });
    } finally {
      saving.current = false;
      // 菜单关闭或切换后只重新查询当前选择，不把旧表情的结果回填到新菜单。
      setRevision(value => value + 1);
    }
  }, [sticker]);

  if (!sticker) return null;
  const ready = loaded !== null && loaded.mediaAssetId === mediaAssetId;
  const isAdded = ready && loaded.isAdded;
  return { isAdded, add: ready && !isAdded ? add : undefined };
}
