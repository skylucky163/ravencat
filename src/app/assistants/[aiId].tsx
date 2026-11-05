/** 主页导航由 App 映射，资料页不持有具体路径。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { AssistantProfileScreen } from '@features/assistants';

export default function AssistantProfileRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  const router = useRouter();
  return aiId ? <AssistantProfileScreen key={aiId} aiId={aiId} onBack={() => router.back()}
    onEdit={() => router.push(`/assistants/${encodeURIComponent(aiId)}/edit` as Href)}
    onSendMessage={() => router.dismissTo(`/chat/${encodeURIComponent(aiId)}` as Href)}
    onOpenMoments={() => router.push(`/assistants/${encodeURIComponent(aiId)}/moments` as Href)}
    onOpenModelSettings={() => router.push(`/assistants/${encodeURIComponent(aiId)}/model-settings` as Href)}
    onOpenContextSettings={() => router.push(`/assistants/${encodeURIComponent(aiId)}/context-settings` as Href)}
    onOpenSummary={() => router.push(`/chat/${encodeURIComponent(aiId)}/summary` as Href)}
  /> : <Redirect href={'/conversations' as Href} />;
}
