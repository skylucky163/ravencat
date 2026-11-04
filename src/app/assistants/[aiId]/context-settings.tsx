/** 上下文正式入口；选择固定起点前由表单完成保存，再进入目标聊天。 */
import { Redirect, type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { AssistantContextSettingsScreen } from '@features/chat';

export default function AssistantContextSettingsRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  const router = useRouter();
  return aiId ? <AssistantContextSettingsScreen key={aiId} aiId={aiId} onBack={() => router.back()}
    onChooseFixedStart={() => router.dismissTo(`/chat/${encodeURIComponent(aiId)}` as Href)} />
    : <Redirect href={'/conversations' as Href} />;
}
