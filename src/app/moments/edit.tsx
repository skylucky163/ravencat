/** App 只适配编辑目标和返回意图，表单与保存由 Moments 拥有。 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { EditMomentScreen } from '@features/moments';

export default function MomentEditRoute() {
  const { momentId } = useLocalSearchParams<{ momentId: string }>();
  const router = useRouter();
  return <EditMomentScreen key={momentId} momentId={momentId} onBack={() => router.back()} />;
}
