/** 代码卡只表达打开预览的意图，具体页面路径由宿主拥有。 */
import React, { createContext, useContext, type ReactNode } from 'react';

const Context = createContext<((id: string) => void) | null>(null);
export function ChatCodeNavigationProvider({ children, openPreview }: { children: ReactNode; openPreview: (id: string) => void }) {
  return <Context.Provider value={openPreview}>{children}</Context.Provider>;
}
export function useOpenChatCodePreview() {
  const open = useContext(Context);
  if (!open) throw new Error('ChatCodeNavigationProvider 未装配');
  return open;
}
