/** AI 主页到朋友圈的路由适配；按助手 ID 查询，不切换聊天会话。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { AssistantMomentsScreen } from '@features/moments';
import { useRetainedRouteRefreshRevision } from '@host';

export default function AssistantMomentsRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  const router = useRouter();
  const refreshRevision = useRetainedRouteRefreshRevision();
  return aiId ? <AssistantMomentsScreen key={aiId} aiId={aiId} refreshRevision={refreshRevision}
    onBack={() => router.back()} /> : <Redirect href={'/conversations' as Href} />;
}
