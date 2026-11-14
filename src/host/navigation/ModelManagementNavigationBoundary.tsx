/** 宿主统一映射模型用途；已处于对应管理页时只关闭选择弹窗。 */
import React, { useCallback, type ReactNode } from 'react';
import { usePathname, useRouter, type Href } from 'expo-router';
import { ModelManagementNavigationProvider, type ModelManagementTarget } from '@shared/ui';

export default function ModelManagementNavigationBoundary({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const manageModels = useCallback((target: ModelManagementTarget) => {
    const destination = `/auxiliary-models/capabilities/${target}`;
    if (pathname !== destination) router.push(destination as Href);
  }, [pathname, router]);
  return <ModelManagementNavigationProvider onManageModels={manageModels}>{children}</ModelManagementNavigationProvider>;
}
