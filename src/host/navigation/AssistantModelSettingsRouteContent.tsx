/** 跨 Feature 的视觉模型选择由 Host 装入角色模型页，不依赖当前聊天。 */
import { useRouter } from 'expo-router';
import { AssistantModelSettingsScreen } from '@features/assistants';
import { ChatImageModelPicker } from '@features/chat';

export default function AssistantModelSettingsRouteContent({ aiId }: { aiId: string }) {
  const router = useRouter();
  return <AssistantModelSettingsScreen key={aiId} aiId={aiId} onBack={() => router.back()}
    auxiliaryModelSettings={<ChatImageModelPicker assistantId={aiId} />} />;
}
