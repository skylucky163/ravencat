/** 单帖路由只将稳定 ID 与返回意图交给 Moments。 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MomentDetailScreen } from '@features/moments';
export default function MomentDetailRoute() {
  const { momentId } = useLocalSearchParams<{ momentId: string }>();
  const router = useRouter();
  return <MomentDetailScreen key={momentId} momentId={momentId} onBack={() => router.back()} />;
}
