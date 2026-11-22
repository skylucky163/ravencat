/** 单聊搜索路由拥有打开消息上下文的具体地址。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ChatSearchRouteScreen } from '@features/chat';

export default function ChatSearchRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  if (!aiId) return <Redirect href={'/conversations' as Href} />;
  return <ChatSearchRouteScreen aiId={aiId} onOpenMessage={messageId => router.push({
    pathname: '/chat/[aiId]/message-context', params: { aiId, messageId },
  } as Href)} onOpenCall={callId => router.push({
    pathname: '/chat/[aiId]/call-history/[callId]', params: { aiId, callId },
  })} />;
}
