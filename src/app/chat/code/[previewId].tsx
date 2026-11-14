import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChatCodePreviewScreen } from '@features/chat';

export default function ChatCodePreviewRoute() {
  const { previewId } = useLocalSearchParams<{ previewId: string }>();
  const router = useRouter();
  return <ChatCodePreviewScreen previewId={previewId} onBack={() => router.back()} />;
}
