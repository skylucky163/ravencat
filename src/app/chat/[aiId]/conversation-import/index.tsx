/** 单聊对话导入来源页。 */
import { Redirect, type Href, useLocalSearchParams } from 'expo-router';
import { ChatImportRouteScreen } from '@features/chat';

export default function ConversationImportRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  return aiId ? <ChatImportRouteScreen aiId={aiId} /> : <Redirect href={'/conversations' as Href} />;
}
