/** 分享卡片只表达打开原帖的业务导航意图，由 Host 映射到具体路由。 */
import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
interface Navigation { openMoment(momentId: string): void }
const Context = createContext<Navigation | null>(null);
export function ChatShareNavigationProvider({ children, openMoment }: Navigation & { children: ReactNode }) {
  const navigation = useMemo(() => ({ openMoment }), [openMoment]);
  return <Context.Provider value={navigation}>{children}</Context.Provider>;
}
export function useChatShareNavigation() {
  const navigation = useContext(Context);
  if (!navigation) throw new Error('ChatShareNavigationProvider 未装配');
  return navigation;
}
