/** 群聊详情路由。 */
import { useCallback, useState } from 'react';
import { Redirect, type Href, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { GroupConversationRouteScreen } from '@features/chat';

export default function GroupConversationRoute() {
  const router = useRouter();
  const openAssistantProfile = useCallback((assistantId: string) => {
    router.push(`/assistants/${encodeURIComponent(assistantId)}` as Href);
  }, [router]);
  const [routeFocused, setRouteFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setRouteFocused(true);
    return () => setRouteFocused(false);
  }, []));
  const params = useLocalSearchParams<{ groupId?: string | string[] }>();
  const groupId = Array.isArray(params.groupId) ? params.groupId[0] : params.groupId;
  return groupId
    ? <GroupConversationRouteScreen groupId={groupId} routeFocused={routeFocused} onOpenAssistantProfile={openAssistantProfile} />
    : <Redirect href={'/conversations' as Href} />;
}
