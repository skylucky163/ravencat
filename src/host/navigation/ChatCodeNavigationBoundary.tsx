/** 宿主将代码预览意图映射到 Expo Router 页面。 */
import React, { useCallback, type ReactNode } from 'react';
import { type Href, useRouter } from 'expo-router';
import { ChatCodeNavigationProvider } from '@features/chat';

export default function ChatCodeNavigationBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const openPreview = useCallback((previewId: string) => {
    router.push(`/chat/code/${encodeURIComponent(previewId)}` as Href);
  }, [router]);
  return <ChatCodeNavigationProvider openPreview={openPreview}>{children}</ChatCodeNavigationProvider>;
}
