/** 角色模型配置按助手 ID 打开，跨 Feature 内容交给 Host 装配。 */
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';
import { AssistantModelSettingsRouteContent } from '@host';

export default function AssistantModelSettingsRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  return aiId ? <AssistantModelSettingsRouteContent key={aiId} aiId={aiId} />
    : <Redirect href={'/conversations' as Href} />;
}
