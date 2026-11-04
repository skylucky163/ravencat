/** App 持有进度页路由和返回，Feature 只展示处理事实。 */
import { useRouter } from 'expo-router';
import { StickerProcessingScreen } from '@features/stickers';

export default function StickerProgressRoute() {
  const router = useRouter();
  return <StickerProcessingScreen onBack={() => router.back()} />;
}
