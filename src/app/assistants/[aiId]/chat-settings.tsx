/** 对话页与主页进入同一个上下文页面，原页面偏好维持现状。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { AssistantChatSettingsScreen } from '@features/chat';

export default function AssistantChatSettingsRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  const router = useRouter();
  return aiId ? <AssistantChatSettingsScreen key={aiId} aiId={aiId} onBack={() => router.back()}
    onOpenContextSettings={() => router.push(`/assistants/${encodeURIComponent(aiId)}/context-settings` as Href)} />
    : <Redirect href={'/conversations' as Href} />;
}
