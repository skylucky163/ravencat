/** 单聊详情路由。 */
import { useCallback, useState } from 'react';
import { Redirect, type Href, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ChatConversationRouteScreen } from '@features/chat';

export default function ChatConversationRoute() {
  const router = useRouter();
  const openAssistantProfile = useCallback((assistantId: string) => {
    router.push(`/assistants/${encodeURIComponent(assistantId)}` as Href);
  }, [router]);
  const [routeFocused, setRouteFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setRouteFocused(true);
    return () => setRouteFocused(false);
  }, []));
  const params = useLocalSearchParams<{
    aiId?: string | string[];
    sessionId?: string | string[];
    anchorMessageId?: string | string[];
  }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  const sessionId = Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId;
  const anchorMessageIdParam = Array.isArray(params.anchorMessageId)
    ? params.anchorMessageId[0]
    : params.anchorMessageId;
  const anchorMessageId = anchorMessageIdParam && Number.isFinite(Number(anchorMessageIdParam))
    ? Number(anchorMessageIdParam)
    : null;
  if (!aiId?.trim()) {
    return <Redirect href={'/conversations' as Href} />;
  }
  return (
    <ChatConversationRouteScreen
      aiId={aiId}
      sessionId={sessionId?.trim() || null}
      anchorMessageId={anchorMessageId}
      routeFocused={routeFocused}
      onOpenAssistantProfile={openAssistantProfile}
    />
  );
}
