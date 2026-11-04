/** 单聊菜单路由。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ChatMenuRouteScreen } from '@features/chat';

export default function ChatMenuRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  return aiId ? <ChatMenuRouteScreen aiId={aiId}
    onOpenModelSettings={() => router.push(`/assistants/${encodeURIComponent(aiId)}/model-settings` as Href)}
    onOpenConversationSettings={() => router.push(`/assistants/${encodeURIComponent(aiId)}/chat-settings` as Href)}
    onOpenSummary={() => router.push(`/chat/${encodeURIComponent(aiId)}/summary` as Href)} />
    : <Redirect href={'/conversations' as Href} />;
}
