/** 表情进度只暴露导航意图，具体地址由宿主装配。 */
import React, { createContext, useContext, type ReactNode } from 'react';

const Context = createContext<(() => void) | null>(null);
export function StickerProgressNavigationProvider({ children, openProgress }: {
  children: ReactNode; openProgress: () => void;
}) {
  return <Context.Provider value={openProgress}>{children}</Context.Provider>;
}
export function useStickerProgressNavigation(): () => void {
  const open = useContext(Context);
  if (!open) throw new Error('StickerProgressNavigationProvider 未装配');
  return open;
}
