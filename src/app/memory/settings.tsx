/** 记忆设置路由；模型资产继续交给辅助模型中心管理。 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MemorySettingsScreen } from '@features/memory';
export default function MemorySettingsRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ assistantId?: string | string[] }>();
  const assistantId = Array.isArray(params.assistantId) ? params.assistantId[0] : params.assistantId;
  return <MemorySettingsScreen key={assistantId} assistantId={assistantId}
    onBack={() => router.back()}
  />;
}
