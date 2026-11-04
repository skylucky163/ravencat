/** 个人主页由 Expo Router 承载；系统返回与按钮返回共享保存边界。 */
import { useRef, useState } from 'react';
import { Redirect, type Href, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { AssistantProfileEditScreen, type AssistantProfileNavigationState } from '@features/assistants';

export default function AssistantProfileEditRoute() {
  const params = useLocalSearchParams<{ aiId?: string | string[] }>();
  const aiId = Array.isArray(params.aiId) ? params.aiId[0] : params.aiId;
  const router = useRouter();
  const navigation = useNavigation();
  const [state, setState] = useState<AssistantProfileNavigationState | null>(null);
  const leaving = useRef(false);
  usePreventRemove(state?.dirty ?? false, ({ data }) => {
    if (leaving.current) return;
    leaving.current = true;
    void state!.flush().then(saved => { if (saved) navigation.dispatch(data.action); })
      .finally(() => { leaving.current = false; });
  });
  return aiId ? <AssistantProfileEditScreen key={aiId} aiId={aiId} onBack={() => router.back()}
    onNavigationStateChange={setState} /> : <Redirect href={'/conversations' as Href} />;
}
