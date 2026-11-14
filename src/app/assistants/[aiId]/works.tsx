/** 主页与聊天更多共用同一路由和同一份收纳关系。 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChatCodeLibraryScreen } from '@features/chat';

export default function AssistantWorksRoute() {
  const { aiId } = useLocalSearchParams<{ aiId: string }>();
  const router = useRouter();
  return <ChatCodeLibraryScreen key={aiId} aiId={aiId} onBack={() => router.back()} />;
}
