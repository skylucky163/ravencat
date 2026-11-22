/** 路由适配只负责回收站的进出导航。 */
import { useRouter } from 'expo-router';
import { AIRecycleBinScreen } from '@features/assistants';

export default function AIRecycleBinRoute() {
  const router = useRouter();
  return <AIRecycleBinScreen onBack={() => router.back()} />;
}
