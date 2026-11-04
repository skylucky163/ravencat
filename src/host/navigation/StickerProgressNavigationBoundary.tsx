/** 宿主把聊天面板的查看进度意图映射到表情系统共用页面。 */
import React, { useCallback, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { StickerProgressNavigationProvider } from '@features/stickers';

export default function StickerProgressNavigationBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const openProgress = useCallback(() => router.push('/sticker-progress'), [router]);
  return <StickerProgressNavigationProvider openProgress={openProgress}>{children}</StickerProgressNavigationProvider>;
}
