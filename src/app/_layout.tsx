/** Expo Router 根布局；由稳定宿主托管全局生命周期，并用原生 Stack 保留页面实例。 */
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import KimiPhoneHost from '@host/KimiPhoneHost';
import StickerProgressNavigationBoundary from '@host/navigation/StickerProgressNavigationBoundary';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KimiPhoneHost>
        <StickerProgressNavigationBoundary>
        <Stack
          screenOptions={{
            animation: 'slide_from_right',
            contentStyle: { backgroundColor: 'transparent' },
            freezeOnBlur: true,
            headerShown: false,
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
          {/* 会话身份决定页面唯一性，连续点击不能创建多个相同聊天页。 */}
          <Stack.Screen name="chat/[aiId]/index" dangerouslySingular />
          <Stack.Screen name="chat/groups/[groupId]" dangerouslySingular />
          <Stack.Screen name="wallet/index" />
          <Stack.Screen name="auxiliary-models/index" />
          <Stack.Screen name="auxiliary-models/services/index" />
          <Stack.Screen name="auxiliary-models/services/[serviceId]" />
          <Stack.Screen name="auxiliary-models/capabilities/[kind]" />
          <Stack.Screen name="auxiliary-models/models/[modelId]" />
          <Stack.Screen name="ai-request-diagnostics/index" />
          <Stack.Screen name="mcp-tools/index" />
          <Stack.Screen name="web-search/index" />
          <Stack.Screen name="mcp-tools/new" />
          <Stack.Screen name="mcp-tools/[serverId]" />
          <Stack.Screen name="memory/index" />
          <Stack.Screen name="memory/settings" />
          <Stack.Screen name="memory/edit" />
          <Stack.Screen name="memory/trigger" />
          <Stack.Screen name="prompt-center/index" />
          <Stack.Screen name="backup/index" />
          <Stack.Screen name="profile" />
          <Stack.Screen name="assistants/[aiId]" dangerouslySingular />
          <Stack.Screen name="assistants/[aiId]/edit" dangerouslySingular />
          <Stack.Screen name="assistants/[aiId]/moments" dangerouslySingular />
          <Stack.Screen name="assistants/[aiId]/model-settings" dangerouslySingular />
          <Stack.Screen name="assistants/[aiId]/chat-settings" dangerouslySingular />
          <Stack.Screen name="assistants/[aiId]/context-settings" dangerouslySingular />
          <Stack.Screen name="favorites" />
          <Stack.Screen name="profile/[field]" />
          <Stack.Screen name="moments/publish" />
          <Stack.Screen name="moments/settings" />
          <Stack.Screen name="moments/[momentId]" dangerouslySingular />
          <Stack.Screen name="raven-cat/index" />
          <Stack.Screen name="raven-cat/floating-interaction" />
          <Stack.Screen name="raven-cat/system-access" />
          <Stack.Screen name="appearance" />
          <Stack.Screen name="bubble-skins" />
          <Stack.Screen name="bubble-skin" />
          <Stack.Screen name="add-ai" />
          <Stack.Screen name="navigation-error" options={{ animation: 'fade' }} />
          <Stack.Screen
            name="calls/[callId]"
            options={{ animation: 'none', presentation: 'card' }}
          />
        </Stack>
        </StickerProgressNavigationBoundary>
      </KimiPhoneHost>
    </GestureHandlerRootView>
  );
}
