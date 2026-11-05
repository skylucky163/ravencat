/** 提示词详情使用真实 Stack 页面；Feature 只传业务页面和标识。 */
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { listPromptAssistantOptions, PromptCenterScreen, type PromptAssistantOption, type PromptCenterPage } from '@features/prompting';
import useRetainedRouteRefreshRevision from './useRetainedRouteRefreshRevision';

export default function PromptCenterRouteContent({ page }: { page: PromptCenterPage }) {
  const router = useRouter();
  const { assistantId } = useLocalSearchParams<{ assistantId?: string }>();
  const refreshRevision = useRetainedRouteRefreshRevision();
  const [assistants, setAssistants] = useState<PromptAssistantOption[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (page.kind !== 'overview') return;
    let active = true;
    void listPromptAssistantOptions().then((options) => {
      if (active) { setAssistants(options); setLoadError(false); }
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [page.kind, refreshRevision]);
  const defaultAssistant = assistants?.find((option) => option.isHostAI) ?? assistants?.[0];
  useEffect(() => {
    if (page.kind === 'overview' && !assistantId && defaultAssistant) router.setParams({ assistantId: defaultAssistant.id });
  }, [assistantId, defaultAssistant, page.kind, router]);
  const params = assistantId ? { assistantId } : {};
  const openPage = (target: PromptCenterPage) => {
    switch (target.kind) {
      case 'overview': router.push({ pathname: '/prompt-center', params }); break;
      case 'conditional': router.push({ pathname: '/prompt-center/conditional', params }); break;
      case 'otherRules': router.push({ pathname: '/prompt-center/other-rules', params }); break;
      case 'other': router.push({ pathname: '/prompt-center/other', params }); break;
      case 'registry': router.push('/prompt-center/registry' as Href); break;
      case 'editor': router.push({ pathname: '/prompt-center/rules/[definitionId]', params: { ...params, definitionId: target.definitionId } }); break;
      case 'persona': router.push({ pathname: '/prompt-center/persona', params }); break;
      case 'custom': router.push({ pathname: '/prompt-center/custom', params }); break;
      case 'userEditor':
        if (target.promptId) router.push({ pathname: '/prompt-center/custom/[promptId]', params: { ...params, promptId: target.promptId } });
        else router.push({ pathname: '/prompt-center/custom/new', params });
        break;
      case 'tools': router.push({ pathname: '/prompt-center/tools', params }); break;
      case 'package': router.push({ pathname: '/prompt-center/tools/[packageId]', params: { ...params, packageId: target.id } }); break;
    }
  };

  if (page.kind === 'persona' && !assistantId) return <Redirect href="/prompt-center" />;
  if (page.kind === 'overview' && !loadError && (!assistants || (!assistantId && defaultAssistant))) return <ActivityIndicator />;

  const pageId = page.kind === 'editor' ? page.definitionId : page.kind === 'userEditor' ? page.promptId : page.kind === 'package' ? page.id : page.kind;
  return <PromptCenterScreen key={`${assistantId ?? 'default'}:${page.kind}:${pageId ?? 'new'}`}
    page={page} assistantId={assistantId} refreshRevision={refreshRevision} onOpenPage={openPage}
    assistants={assistants ?? []} assistantListError={loadError} onSelectAssistant={(id) => router.setParams({ assistantId: id })}
    onOpenGlobalPrompts={() => router.push('/prompt-center/custom')}
    onBack={() => router.back()}
    onOpenMcp={() => router.push('/mcp-tools')}
    onOpenWebSearch={() => router.push('/web-search' as Href)}
    onOpenUserProfile={() => router.push('/profile')}
    onOpenProtocols={(aiId) => router.push({ pathname: '/chat/[aiId]/protocol', params: { aiId } })} />;
}
