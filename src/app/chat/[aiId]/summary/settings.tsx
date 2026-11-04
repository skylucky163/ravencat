/** 摘要设置独立路由，业务设置按当前 AI 的单聊保存。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ChatSummarySettingsRouteScreen } from '@features/chat';

export default function SummarySettingsRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  return aiId ? <ChatSummarySettingsRouteScreen key={aiId} aiId={aiId} onBack={() => router.back()} /> : <Redirect href={'/conversations' as Href} />;
}
