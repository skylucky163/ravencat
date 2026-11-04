/** 表情包系统路由；内部视图与返回层级由 Feature 的稳定页面外壳拥有。 */
import { useRouter } from 'expo-router';
import { StickerSystemScreen } from '@features/stickers';

export default function StickerSystemRoute() {
  const router = useRouter();
  return <StickerSystemScreen onBack={() => router.back()} onOpenProgress={() => router.push('/sticker-progress')} />;
}
