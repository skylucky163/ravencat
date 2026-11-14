import { useEffect, useRef } from 'react';
import { ToastAndroid } from 'react-native';
import { showAppDialog } from '@shared/ui';
import type { ChatMessage } from '../../../messages/domain/ChatMessage';
import { getMessageAttachments } from '../../../messages/domain/chatMessageMetadata';
import { saveChatImagesToGallery } from '../../../messages/application/SaveChatImagesToGallery';

export function useChatSaveImagesAction(message: ChatMessage | null, isActive: boolean): (() => void) | undefined {
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!isActive) request.current?.abort();
    return () => request.current?.abort();
  }, [isActive]);
  const images = getMessageAttachments(message).filter(attachment => attachment.type === 'image');
  if (images.length === 0) return undefined;
  return () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    void saveChatImagesToGallery(images, controller.signal).then(() => {
      ToastAndroid.show('已保存到相册', ToastAndroid.SHORT);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) showAppDialog({ title: '保存图片失败', message: error instanceof Error ? error.message : String(error), tone: 'error' });
    }).finally(() => { request.current = null; });
  };
}
