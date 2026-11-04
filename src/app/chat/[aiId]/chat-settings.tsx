/** 旧设置地址在过渡期只做替换跳转，实际页面由 AI 个人主页承载。 */
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';

export default function LegacyAssistantSettingsRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  return <Redirect href={(aiId ? `/assistants/${encodeURIComponent(aiId)}/chat-settings` : '/conversations') as Href} />;
}
