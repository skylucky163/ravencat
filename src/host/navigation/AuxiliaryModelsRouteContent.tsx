/** 把辅助模型 Feature 的受控页面状态适配为 Expo Router 子路由。 */
import { type Href, useRouter } from 'expo-router';
import {
  AuxiliaryModelNavigator,
  CAPABILITY_KINDS,
  type AuxiliaryModelRoute,
  type CapabilityKind,
} from '@features/assistants';
import useRetainedRouteRefreshRevision from './useRetainedRouteRefreshRevision';

export function parseCapabilityKind(value: string | undefined): CapabilityKind | null {
  return CAPABILITY_KINDS.find((kind) => kind === value) || null;
}

export default function AuxiliaryModelsRouteContent({ route }: { route: AuxiliaryModelRoute }) {
  const router = useRouter();
  const refreshRevision = useRetainedRouteRefreshRevision();

  const navigate = (target: AuxiliaryModelRoute) => {
    const targetsParent =
      target.screen === 'center'
      || (route.screen === 'service-edit' && target.screen === 'services')
      || (
        route.screen === 'edit'
        && target.screen === 'pool'
        && target.kind === route.capabilityKind
      );
    if (targetsParent) {
      router.back();
      return;
    }

    if (target.screen === 'services') { router.push('/auxiliary-models/services' as Href); return; }
    if (target.screen === 'service-edit') { router.push(`/auxiliary-models/services/${target.serviceId ?? 'new'}` as Href); return; }

    if (target.screen === 'pool') {
      router.push(`/auxiliary-models/capabilities/${target.kind}` as Href);
      return;
    }

    if (target.screen === 'edit') {
      const modelId = target.modelId || 'new';
      router.push(`/auxiliary-models/models/${modelId}?kind=${target.capabilityKind}` as Href);
    }
  };

  return (
    <AuxiliaryModelNavigator
      route={route}
      refreshRevision={refreshRevision}
      onBack={() => router.back()}
      onNavigate={navigate}
    />
  );
}
