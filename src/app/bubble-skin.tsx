/** 气泡编辑器使用真实 Stack；统一拦截顶部返回、Android 返回与系统返回手势。 */
import { useRef, useState } from 'react';
import { Redirect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { ChatBubbleSkinEditorScreen, type BubbleEditorNavigationState } from '@features/chat';

export default function BubbleSkinEditorRoute() {
  const params = useLocalSearchParams<{ role?: string; presetId?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const [state, setState] = useState<BubbleEditorNavigationState | null>(null);
  const leaving = useRef(false);
  usePreventRemove(state?.dirty ?? false, ({ data }) => {
    if (leaving.current) return;
    leaving.current = true;
    void state!.requestLeave().then(allowed => { if (allowed) navigation.dispatch(data.action); })
      .finally(() => { leaving.current = false; });
  });
  return params.role === 'user' || params.role === 'ai'
    ? <ChatBubbleSkinEditorScreen key={`${params.role}:${params.presetId ?? 'new'}`} role={params.role}
      presetId={params.presetId ?? null} onBack={() => router.back()} onNavigationStateChange={setState} />
    : <Redirect href="/appearance" />;
}
