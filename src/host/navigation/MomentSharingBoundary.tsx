/** 宿主连接 Moments 内容与 Chat 分享能力，两个 Feature 不相互持有导航或提交。 */
import React, { useCallback, type ReactNode } from 'react';
import { type Href, useRouter } from 'expo-router';
import { ChatContentShareSheet, ChatShareNavigationProvider, useChatContentShare, type ChatShareTarget } from '@features/chat';
import { createUserMomentShare, MomentNavigationProvider } from '@features/moments';

const onShared = () => {};
export default function MomentSharingBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const share = useChatContentShare({ ownerKey: 'host.moments', onShared });
  const openShare = share.open;
  const shareMoment = useCallback((momentId: string, target?: ChatShareTarget) => {
    void openShare(async () => ({ kind: 'moment', moment: await createUserMomentShare(momentId) }), { target });
  }, [openShare]);
  const openMoment = useCallback((momentId: string) => {
    router.push(`/moments/${encodeURIComponent(momentId)}` as Href);
  }, [router]);
  const openAssistantProfile = useCallback((assistantId: string) => {
    router.push(`/assistants/${encodeURIComponent(assistantId)}` as Href);
  }, [router]);
  return <ChatShareNavigationProvider openMoment={openMoment}>
    <MomentNavigationProvider openMoment={openMoment} shareMoment={shareMoment} openAssistantProfile={openAssistantProfile}>
      {children}
      <ChatContentShareSheet share={share} />
    </MomentNavigationProvider>
  </ChatShareNavigationProvider>;
}
