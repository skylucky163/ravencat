/** DeepSeek 单对话导入表单路由。 */
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';
import { DeepSeekImportRouteScreen } from '@features/chat';

export default function DeepSeekImportRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  return aiId ? <DeepSeekImportRouteScreen aiId={aiId} /> : <Redirect href={'/conversations' as Href} />;
}
