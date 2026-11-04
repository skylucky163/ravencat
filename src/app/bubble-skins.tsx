/** 气泡组合管理的路由适配；Feature 只表达编辑意图。 */
import { useRouter } from 'expo-router';
import { ChatBubbleSkinSettings } from '@features/chat';

export default function BubbleSkinSettingsRoute() {
  const router = useRouter();
  return <ChatBubbleSkinSettings onBack={() => router.back()} onEdit={(role, presetId) =>
    router.push({ pathname: '/bubble-skin', params: { role, ...(presetId === null ? {} : { presetId }) } })} />;
}
