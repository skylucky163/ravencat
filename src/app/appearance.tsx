/** 外观设置路由。 */
import { useRouter } from 'expo-router';
import { ThemePickerView } from '@features/miniPrograms';

export default function AppearanceRoute() {
  const router = useRouter();
  return <ThemePickerView onBack={() => router.back()} onOpenBubbleSkins={() => router.push('/bubble-skins')} />;
}
