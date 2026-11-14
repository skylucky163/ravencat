/** 选择控件只表达模型用途，具体页面地址与导航栈操作由宿主提供。 */
import React, { createContext, useContext, type ReactNode } from 'react';

export type ModelManagementTarget = 'summary' | 'embedding' | 'ocr' | 'image_generation' | 'stt' | 'tts' | 'translation';
const NavigationContext = createContext<((target: ModelManagementTarget) => void) | null>(null);

export function ModelManagementNavigationProvider({ onManageModels, children }: {
  onManageModels(target: ModelManagementTarget): void;
  children: ReactNode;
}) {
  return <NavigationContext.Provider value={onManageModels}>{children}</NavigationContext.Provider>;
}

export function useModelManagementNavigation() {
  const navigate = useContext(NavigationContext);
  if (!navigate) throw new Error('模型管理导航必须由宿主提供');
  return navigate;
}
