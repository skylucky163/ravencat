/** 小程序 Tab。 */
import { type Href, useRouter } from 'expo-router';
import { MiniProgramsTab, type MiniProgramId } from '@features/miniPrograms';

const MINI_PROGRAM_ROUTES: Record<MiniProgramId, Href> = {
  wallet: '/wallet',
  auxiliaryModels: '/auxiliary-models',
  aiRequestDiagnostics: '/ai-request-diagnostics' as Href,
  mcpTools: '/mcp-tools',
  webSearch: '/web-search' as Href,
  memory: '/memory' as Href,
  promptCenter: '/prompt-center' as Href,
  ravenCatCompanion: '/raven-cat',
  ravenCatFloating: '/raven-cat/floating-interaction' as Href,
  ravenCatSystemAccess: '/raven-cat/system-access' as Href,
  phoneTools: '/phone-tools' as Href,
  stickerSystem: '/sticker-system' as Href,
  themePicker: '/appearance',
};

export default function MiniProgramsRoute() {
  const router = useRouter();
  return (
    <MiniProgramsTab
      onOpenApp={(appId) => router.push(MINI_PROGRAM_ROUTES[appId])}
    />
  );
}
